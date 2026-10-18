using System;
using System.Globalization;
using System.Threading;
using Cysharp.Threading.Tasks;
using OneMoreTap.Analytics;
using OneMoreTap.Security;
using UnityEngine;
#if ONEMORETAP_LEVELPLAY && !UNITY_EDITOR
using System.Collections.Generic;
using Unity.Services.LevelPlay;
#endif

namespace OneMoreTap.Monetization
{
    public enum AdShowResult
    {
        Completed,
        Skipped,
        NotReady,
        Failed,
    }

    public enum AdRewardOutcome
    {
        Granted,
        CooldownActive,
        DailyCapReached,
        NotReady,
        Skipped,
        /// <summary>Ad finished but the network's server callback didn't arrive in time. It may still land later.</summary>
        VerificationTimeout,
        Failed,
    }

    /// <summary>Ad network adapter. The grant id must be forwarded to the network as server-side custom data.</summary>
    public interface IRewardedAdProvider
    {
        bool IsReady { get; }
        /// <summary>True when no real S2S callback exists (editor/dev) and AdManager must simulate it.</summary>
        bool RequiresSimulatedCallback { get; }
        void Initialize(string userId);
        void Load();
        UniTask<AdShowResult> ShowAsync(string placement, string grantId, CancellationToken ct);
    }

    /// <summary>
    /// Rewarded ads for the two GDD placements ("replay_ring" after a near-miss, "double_ticks" at session start).
    ///
    /// Fraud model:
    ///  1. Local cool-downs/daily caps (persisted in SecureStorage, measured on the server-synced monotonic clock so
    ///     changing the device clock doesn't reset them) stop the UI from even offering an ad too often.
    ///  2. The server enforces the same limits authoritatively when issuing a one-time grant id.
    ///  3. The reward is applied only when the ad network's signed server-to-server callback reaches the backend.
    ///     The client merely polls for the result — a modified client can't mint rewards.
    /// </summary>
    public sealed class AdManager
    {
        public const string PlacementReplayRing = "replay_ring";
        public const string PlacementDoubleTicks = "double_ticks";

        private const int PollAttempts = 12;
        private const int PollIntervalMs = 1000;

        private readonly NetworkManager _network;
        private readonly SecureStorage _storage;
        private readonly TelemetryClient _telemetry;
        private readonly IRewardedAdProvider _provider;
        private bool _showing;

        public AdManager(NetworkManager network, SecureStorage storage, TelemetryClient telemetry, IRewardedAdProvider provider)
        {
            _network = network;
            _storage = storage;
            _telemetry = telemetry;
            _provider = provider;
        }

        public void Initialize(string userId)
        {
            _provider.Initialize(userId);
            _provider.Load();
        }

        /// <summary>For UI: should the "watch an ad" button be shown right now?</summary>
        public bool CanOffer(string placement)
        {
            if (_showing || !_provider.IsReady || !_network.IsClockSynced) return false;
            return LocalCheck(placement) == AdRewardOutcome.Granted;
        }

        public async UniTask<AdRewardOutcome> ShowRewardedAsync(string placement, string runId, CancellationToken ct)
        {
            if (_showing) return AdRewardOutcome.Failed;
            AdRewardOutcome local = LocalCheck(placement);
            if (local != AdRewardOutcome.Granted) return local;
            if (!_provider.IsReady)
            {
                _provider.Load();
                return AdRewardOutcome.NotReady;
            }

            _showing = true;
            try
            {
                Track("ad_requested", placement);

                AdIntentResponse intent;
                try
                {
                    intent = await _network.PostAsync<AdIntentRequest, AdIntentResponse>(
                        "/v1/ads/intent", new AdIntentRequest { placement = placement, runId = runId }, AuthMode.Signed, ct);
                }
                catch (ApiException e) when (e.StatusCode == 429)
                {
                    // Server says cool-down/cap: sync the local timer so the button stops showing.
                    RecordShown(placement);
                    return e.Code == "ad_daily_cap" ? AdRewardOutcome.DailyCapReached : AdRewardOutcome.CooldownActive;
                }

                AdShowResult shown = await _provider.ShowAsync(placement, intent.grantId, ct);
                RecordShown(placement);
                _provider.Load(); // preload the next one

                if (shown == AdShowResult.Skipped)
                {
                    Track("ad_skipped", placement);
                    return AdRewardOutcome.Skipped;
                }
                if (shown != AdShowResult.Completed)
                {
                    Track("ad_failed", placement);
                    return shown == AdShowResult.NotReady ? AdRewardOutcome.NotReady : AdRewardOutcome.Failed;
                }

                if (_provider.RequiresSimulatedCallback)
                {
                    await _network.PostAsync<EmptyBody, EmptyBody>("/v1/ads/dev-complete/" + intent.grantId, new EmptyBody(), AuthMode.Signed, ct);
                }

                AdRewardOutcome outcome = await PollGrantAsync(intent.grantId, ct);
                Track(outcome == AdRewardOutcome.Granted ? "ad_rewarded" : "ad_verify_timeout", placement);
                return outcome;
            }
            catch (ApiException e)
            {
                Debug.LogWarning($"[Ads] {placement} failed: {e.Code}");
                return AdRewardOutcome.Failed;
            }
            finally
            {
                _showing = false;
                await _storage.SaveAsync(CancellationToken.None);
            }
        }

        private async UniTask<AdRewardOutcome> PollGrantAsync(string grantId, CancellationToken ct)
        {
            for (int i = 0; i < PollAttempts; i++)
            {
                AdGrantStatusResponse status = await _network.GetAsync<AdGrantStatusResponse>("/v1/ads/grant/" + grantId, AuthMode.Signed, ct);
                if (status.status == "GRANTED") return AdRewardOutcome.Granted;
                if (status.status == "EXPIRED") return AdRewardOutcome.Failed;
                await UniTask.Delay(PollIntervalMs, DelayType.Realtime, cancellationToken: ct);
            }
            return AdRewardOutcome.VerificationTimeout;
        }

        // ------------------------------------------------------------------ Local anti-fraud guard

        private AdRewardOutcome LocalCheck(string placement)
        {
            GetRules(placement, out int cooldownSec, out int dailyCap);
            long now = _network.ServerNowMs;
            long last = _storage.GetLong("ads.last." + placement);

            // A "last shown" in the future means the clock was rolled back after the ad; keep the cool-down in force.
            if (last > now + 60_000) return AdRewardOutcome.CooldownActive;
            if (now - last < cooldownSec * 1000L) return AdRewardOutcome.CooldownActive;

            string dayKey = "ads.day." + placement + "." + DayStamp(now);
            if (_storage.GetLong(dayKey) >= dailyCap) return AdRewardOutcome.DailyCapReached;
            return AdRewardOutcome.Granted;
        }

        private void RecordShown(string placement)
        {
            long now = _network.ServerNowMs;
            _storage.SetLong("ads.last." + placement, now);
            string dayKey = "ads.day." + placement + "." + DayStamp(now);
            _storage.SetLong(dayKey, _storage.GetLong(dayKey) + 1);
            string yesterday = "ads.day." + placement + "." + DayStamp(now - 86_400_000L);
            _storage.Delete(yesterday);
        }

        /// <summary>Mirrors AdPlacements in Backend/src/services/ads.service.ts.</summary>
        private static void GetRules(string placement, out int cooldownSec, out int dailyCap)
        {
            switch (placement)
            {
                case PlacementReplayRing: cooldownSec = 30; dailyCap = 15; break;
                case PlacementDoubleTicks: cooldownSec = 120; dailyCap = 6; break;
                default: cooldownSec = int.MaxValue / 1000; dailyCap = 0; break;
            }
        }

        private static string DayStamp(long epochMs) =>
            DateTimeOffset.FromUnixTimeMilliseconds(epochMs).UtcDateTime.ToString("yyyyMMdd", CultureInfo.InvariantCulture);

        private void Track(string name, string placement) =>
            _telemetry.Track(new TelemetryEvent { Category = TelemetryCategory.Ad, Name = name, StrKey = "placement", StrVal = placement });
    }

    /// <summary>Editor / development provider: simulates a 1.5 s ad and lets AdManager trigger the dev S2S endpoint.</summary>
    public sealed class SimulatedRewardedAdProvider : IRewardedAdProvider
    {
        public bool IsReady => true;
        public bool RequiresSimulatedCallback => true;
        public void Initialize(string userId) { }
        public void Load() { }

        public async UniTask<AdShowResult> ShowAsync(string placement, string grantId, CancellationToken ct)
        {
            Debug.Log($"[Ads] (simulated) showing {placement} grant={grantId}");
            await UniTask.Delay(1500, DelayType.Realtime, cancellationToken: ct);
            return AdShowResult.Completed;
        }
    }

#if ONEMORETAP_LEVELPLAY && !UNITY_EDITOR
    /// <summary>
    /// Unity LevelPlay (ironSource) rewarded adapter. Server-to-server callbacks must be enabled in the LevelPlay
    /// dashboard pointing at /v1/ads/ssv/levelplay; the grant id travels as a custom server parameter.
    /// </summary>
    public sealed class LevelPlayRewardedAdProvider : IRewardedAdProvider
    {
        private readonly string _appKey;
        private readonly string _adUnitId;
        private LevelPlayRewardedAd _ad;
        private UniTaskCompletionSource<AdShowResult> _showTcs;
        private bool _rewarded;

        public LevelPlayRewardedAdProvider(string appKey, string adUnitId)
        {
            _appKey = appKey;
            _adUnitId = adUnitId;
        }

        public bool IsReady => _ad != null && _ad.IsAdReady();
        public bool RequiresSimulatedCallback => false;

        public void Initialize(string userId)
        {
            LevelPlay.OnInitSuccess += _ => CreateAd();
            LevelPlay.OnInitFailed += e => Debug.LogWarning($"[Ads] LevelPlay init failed: {e}");
            LevelPlay.Init(_appKey, userId);
        }

        private void CreateAd()
        {
            _ad = new LevelPlayRewardedAd(_adUnitId);
            _ad.OnAdRewarded += (_, __) => _rewarded = true;
            _ad.OnAdClosed += _ => _showTcs?.TrySetResult(_rewarded ? AdShowResult.Completed : AdShowResult.Skipped);
            _ad.OnAdDisplayFailed += _ => _showTcs?.TrySetResult(AdShowResult.Failed);
            _ad.LoadAd();
        }

        public void Load()
        {
            if (_ad != null && !_ad.IsAdReady()) _ad.LoadAd();
        }

        public async UniTask<AdShowResult> ShowAsync(string placement, string grantId, CancellationToken ct)
        {
            if (!IsReady) return AdShowResult.NotReady;
            _rewarded = false;
            _showTcs = new UniTaskCompletionSource<AdShowResult>();
            IronSource.Agent.setRewardedVideoServerParams(new Dictionary<string, string> { { "grantId", grantId } });
            _ad.ShowAd(placement);
            try
            {
                return await _showTcs.Task.AttachExternalCancellation(ct);
            }
            finally
            {
                IronSource.Agent.clearRewardedVideoServerParams();
                _showTcs = null;
            }
        }
    }
#endif
}
