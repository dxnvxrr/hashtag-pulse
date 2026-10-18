using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using Cysharp.Threading.Tasks;
using OneMoreTap.Analytics;
using OneMoreTap.Monetization;
using OneMoreTap.Security;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.UIElements;
using VContainer.Unity;
using Debug = UnityEngine.Debug;

namespace OneMoreTap.Core
{
    [Serializable]
    public sealed class BootConfig
    {
        [Tooltip("Hard budget for the online phase. Past it, the game starts offline and keeps connecting in the background.")]
        public int OnlineBudgetMs = 2200;
        public int TargetFrameRate = 60;
        [Tooltip("Optional 120 Hz on capable devices (GDD: flagship).")]
        public bool AllowHighRefresh = false;
        [Tooltip("Addressables label for audio, loaded after the first tap.")]
        public string AudioLabel = "audio";
        public float SplashFadeSeconds = 0.25f;
        [Tooltip("UXML element names in the UIDocument.")]
        public string SplashElement = "splash";
        public string HintElement = "hint";
    }

    /// <summary>
    /// Sub-3-second cold start (GDD Pillar 3: tap-to-first-ring under 3 s on a 5-year-old mid-range Android).
    ///
    /// Critical path, as short as possible:
    ///   1. Frame-rate / sleep settings (sync, ~0 ms).
    ///   2. In parallel: SecureStorage key derivation (thread pool), Addressables catalog init, and the online chain
    ///      clock sync → auth. The online chain has a hard budget; past it the game starts offline (the GDD allows
    ///      offline play; runs are quarantined until they can be validated) and keeps connecting in the background.
    ///   3. Fade the splash, show the FTUE hint. The ring is procedural, so nothing else has to load.
    /// Deferred until the first tap: audio (Addressables), IAP, ad SDK, silent account linking — none of it may delay
    /// the first ring.
    /// </summary>
    public sealed class Bootstrapper : IAsyncStartable, IDisposable
    {
        private readonly BootConfig _config;
        private readonly SecureStorage _storage;
        private readonly NetworkManager _network;
        private readonly AuthManager _auth;
        private readonly TelemetryClient _telemetry;
        private readonly IAPManager _iap;
        private readonly AdManager _ads;
        private readonly InputController _input;
        private readonly UIDocument _ui;

        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly List<AudioClip> _audioClips = new List<AudioClip>(16);
        private AsyncOperationHandle<IList<AudioClip>> _audioHandle;
        private bool _deferredStarted;

        public bool IsOnline { get; private set; }
        public bool IsReady { get; private set; }
        public IReadOnlyList<AudioClip> AudioClips => _audioClips;
        public event Action Ready;

        public Bootstrapper(
            BootConfig config,
            SecureStorage storage,
            NetworkManager network,
            AuthManager auth,
            TelemetryClient telemetry,
            IAPManager iap,
            AdManager ads,
            InputController input,
            UIDocument ui)
        {
            _config = config;
            _storage = storage;
            _network = network;
            _auth = auth;
            _telemetry = telemetry;
            _iap = iap;
            _ads = ads;
            _input = input;
            _ui = ui;
        }

        public async UniTask StartAsync(CancellationToken cancellation)
        {
            using (CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, _lifetime.Token))
            {
                CancellationToken ct = linked.Token;
                var sw = Stopwatch.StartNew();

                ApplyPlatformSettings();
                SetSplashVisible(true);
                _input.FirstTap += OnFirstTap;
                Application.focusChanged += OnFocusChanged;

                // ---- Phase 1: storage (needed by auth) in parallel with Addressables catalog init.
                UniTask storageTask = _storage.LoadAsync(ct);
                UniTask addressablesTask = InitializeAddressablesAsync(ct);
                await storageTask;
                long storageMs = sw.ElapsedMilliseconds;

                // ---- Phase 2: online chain under a hard budget.
                int budget = Math.Max(300, _config.OnlineBudgetMs - (int)storageMs);
                IsOnline = await ConnectWithBudgetAsync(budget, ct);
                await addressablesTask;

                if (IsOnline) _telemetry.StartFlushLoop(_lifetime.Token);
                else ReconnectInBackgroundAsync(_lifetime.Token).Forget();

                // ---- Phase 3: reveal.
                await FadeOutSplashAsync(ct);
                IsReady = true;
                Ready?.Invoke();

                long bootMs = sw.ElapsedMilliseconds;
                _telemetry.Track(new TelemetryEvent
                {
                    Category = TelemetryCategory.Ftue,
                    Name = "boot_complete",
                    NumKey1 = "boot_ms", NumVal1 = bootMs,
                    NumKey2 = "storage_ms", NumVal2 = storageMs,
                    NumKey3 = "online", NumVal3 = IsOnline ? 1 : 0,
                });
                Debug.Log($"[Boot] ready in {bootMs} ms (online={IsOnline})");
            }
        }

        private void ApplyPlatformSettings()
        {
            QualitySettings.vSyncCount = 0;
            int fps = _config.TargetFrameRate;
            if (_config.AllowHighRefresh)
            {
                int refresh = (int)Math.Round(Screen.currentResolution.refreshRateRatio.value);
                if (refresh >= 120) fps = 120;
            }
            Application.targetFrameRate = fps;
            _telemetry.SetTargetFrameRate(fps);
            Screen.sleepTimeout = SleepTimeout.NeverSleep;
            // Gameplay timing uses unscaled realtime; guarantee a stable fixed step anyway for any physics-driven juice.
            Time.fixedDeltaTime = 1f / fps;
        }

        private static async UniTask InitializeAddressablesAsync(CancellationToken ct)
        {
            AsyncOperationHandle handle = Addressables.InitializeAsync(false);
            await UniTask.WaitUntil(() => handle.IsDone, cancellationToken: ct);
            if (handle.Status != AsyncOperationStatus.Succeeded) Debug.LogWarning($"[Boot] Addressables init: {handle.OperationException?.Message}");
            Addressables.Release(handle);
        }

        private async UniTask<bool> ConnectWithBudgetAsync(int budgetMs, CancellationToken ct)
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                timeout.CancelAfterSlim(TimeSpan.FromMilliseconds(budgetMs), DelayType.Realtime);
                try
                {
                    await ConnectAsync(timeout.Token);
                    return true;
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    Debug.LogWarning($"[Boot] online phase exceeded {budgetMs} ms budget; starting offline");
                    return false;
                }
                catch (ApiException e)
                {
                    Debug.LogWarning($"[Boot] online phase failed ({e.Code}); starting offline");
                    return false;
                }
            }
        }

        private async UniTask ConnectAsync(CancellationToken ct)
        {
            // Clock first: signatures and run scheduling are expressed in server time.
            await _network.SyncClockAsync(ct, samples: 2);
            await _auth.EnsureSessionAsync(ct);
        }

        private async UniTaskVoid ReconnectInBackgroundAsync(CancellationToken ct)
        {
            int delayMs = 2000;
            while (!ct.IsCancellationRequested && !IsOnline)
            {
                await UniTask.Delay(delayMs, DelayType.Realtime, cancellationToken: ct).SuppressCancellationThrow();
                if (ct.IsCancellationRequested) return;
                try
                {
                    await ConnectAsync(ct);
                    IsOnline = true;
                    _telemetry.StartFlushLoop(ct);
                    if (_deferredStarted) InitializeOnlineServicesAsync(ct).Forget();
                    Debug.Log("[Boot] reconnected");
                }
                catch (Exception e) when (!(e is OperationCanceledException))
                {
                    delayMs = Math.Min(delayMs * 2, 60_000);
                }
            }
        }

        // ------------------------------------------------------------------ Deferred (after first tap)

        private void OnFirstTap()
        {
            _input.FirstTap -= OnFirstTap;
            _telemetry.Track(TelemetryCategory.Ftue, "first_tap", "since_start_ms", Time.realtimeSinceStartupAsDouble * 1000.0);
            SetHintVisible(false);
            _deferredStarted = true;
            LoadAudioAsync(_lifetime.Token).Forget();
            if (IsOnline) InitializeOnlineServicesAsync(_lifetime.Token).Forget();
        }

        private async UniTaskVoid LoadAudioAsync(CancellationToken ct)
        {
            // Yield a frame so the first tap's verdict + juice render before any loading work starts.
            await UniTask.Yield(PlayerLoopTiming.Update, ct);
            _audioHandle = Addressables.LoadAssetsAsync<AudioClip>(_config.AudioLabel, clip => _audioClips.Add(clip));
            await UniTask.WaitUntil(() => _audioHandle.IsDone, cancellationToken: ct);
            if (_audioHandle.Status != AsyncOperationStatus.Succeeded) Debug.LogWarning("[Boot] audio load failed; continuing silent");
        }

        private async UniTaskVoid InitializeOnlineServicesAsync(CancellationToken ct)
        {
            // Spread SDK start-up across frames to avoid a hitch during the first rings.
            await UniTask.DelayFrame(30, cancellationToken: ct);
            _ads.Initialize(_auth.UserId);
            await UniTask.DelayFrame(15, cancellationToken: ct);
            bool iapReady = await _iap.InitializeAsync(ct);
            _telemetry.Track(TelemetryCategory.Transaction, "iap_init", "ok", iapReady ? 1 : 0);
            await _auth.TryLinkSilentlyAsync(ct);
        }

        // ------------------------------------------------------------------ UI transition

        private void SetSplashVisible(bool visible)
        {
            VisualElement splash = _ui != null ? _ui.rootVisualElement?.Q(_config.SplashElement) : null;
            if (splash == null) return;
            splash.style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;
            splash.style.opacity = visible ? 1f : 0f;
        }

        private void SetHintVisible(bool visible)
        {
            VisualElement hint = _ui != null ? _ui.rootVisualElement?.Q(_config.HintElement) : null;
            if (hint != null) hint.style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;
        }

        private async UniTask FadeOutSplashAsync(CancellationToken ct)
        {
            SetHintVisible(true); // "TAP WHEN THE RING CLOSES"
            VisualElement splash = _ui != null ? _ui.rootVisualElement?.Q(_config.SplashElement) : null;
            if (splash == null) return;

            float duration = Mathf.Max(0.01f, _config.SplashFadeSeconds);
            float t = 0f;
            while (t < duration)
            {
                t += Time.unscaledDeltaTime;
                splash.style.opacity = 1f - Mathf.Clamp01(t / duration);
                await UniTask.Yield(PlayerLoopTiming.Update, ct);
            }
            splash.style.display = DisplayStyle.None;
        }

        // ------------------------------------------------------------------ Lifecycle

        private void OnFocusChanged(bool hasFocus)
        {
            if (hasFocus) return;
            // Backgrounding is the last reliable moment on mobile: persist secrets and push buffered telemetry.
            _storage.SaveImmediate();
            _telemetry.FlushOnBackground();
        }

        public void Dispose()
        {
            Application.focusChanged -= OnFocusChanged;
            if (_input != null) _input.FirstTap -= OnFirstTap;
            _lifetime.Cancel();
            _lifetime.Dispose();
            if (_audioHandle.IsValid()) Addressables.Release(_audioHandle);
            _storage.SaveImmediate();
        }
    }
}
