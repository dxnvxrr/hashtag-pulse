using System;
using System.Globalization;
using System.Threading;
using Cysharp.Threading.Tasks;
using OneMoreTap.Analytics;
using OneMoreTap.Monetization;
using OneMoreTap.Security;
using UnityEngine;
using UnityEngine.UIElements;
using VContainer;

namespace OneMoreTap.Core
{
    public enum GameMode
    {
        Pulse,
        Gauntlet,
        Zen,
    }

    public sealed class RunSummary
    {
        public GameMode Mode;
        public int Rings;
        public int Perfects;
        public int Cleans;
        public int Closes;
        public int Misses;
        public long BestAbsDeltaUs;
        public bool Online;
        /// <summary>VALIDATED / QUARANTINED / REJECTED from the server, or OFFLINE / SUBMIT_FAILED.</summary>
        public string ServerStatus;
        public int TicksAwarded;
        public int PrecisionRating;
        public bool PersonalBest;
    }

    /// <summary>
    /// The core loop (GDD Pillar 1): procedural neon ring shrinking onto a target circle, single tap anywhere,
    /// millisecond verdict, juice, next ring. Drives <see cref="RunSession"/> (the same timeline rules the server
    /// re-simulates) and submits tap times for server-authoritative scoring.
    ///
    /// Rendering is two LineRenderers built once as unit circles and scaled per frame: no per-frame allocation.
    /// The camera must be orthographic and centred on this object.
    /// </summary>
    public sealed class GameplayController : MonoBehaviour
    {
        private const int CircleSegments = 96;
        private const float TargetRadius = 1f;
        private const float StartRadius = 3.6f;
        private const float DriftAmplitude = 1.4f;

        [SerializeField] private LineRenderer _ring;
        [SerializeField] private LineRenderer _target;
        [SerializeField] private ParticleSystem _burstPrefab;
        [SerializeField] private int _burstPoolSize = 8;
        [SerializeField] private Color _ringColor = new Color(0.85f, 0.9f, 1f);
        [SerializeField] private Color _slowMoColor = new Color(0.69f, 0.55f, 1f);
        [SerializeField] private Color _perfectColor = new Color(1f, 0.78f, 0.34f);

        private NetworkManager _network;
        private InputController _input;
        private TelemetryClient _telemetry;
        private AdManager _ads;
        private Bootstrapper _boot;
        private UIDocument _ui;

        private RunSession _session;
        private GameMode _mode;
        private string _runId;
        private bool _online;
        private uint _seed;
        private double _ring0Realtime;
        private bool _continueOffered;
        private bool _finished;
        private ObjectPooler<ParticleSystem> _bursts;
        private CancellationTokenSource _runCts;

        private Label _verdictWord;
        private Label _verdictDelta;
        private Label _hudRing;
        private Label _hudLives;

        public bool IsPlaying => _session != null && !_session.IsOver;
        public RunSession Session => _session;
        public event Action ContinueOffered;
        public event Action<RunSummary> RunFinished;

        [Inject]
        public void Construct(NetworkManager network, InputController input, TelemetryClient telemetry, AdManager ads, Bootstrapper boot, UIDocument ui)
        {
            _network = network;
            _input = input;
            _telemetry = telemetry;
            _ads = ads;
            _boot = boot;
            _ui = ui;
        }

        private void Awake()
        {
            BuildUnitCircle(_ring);
            BuildUnitCircle(_target);
            SetRingVisible(false);
            if (_burstPrefab != null)
            {
                _bursts = new ObjectPooler<ParticleSystem>(_burstPrefab, _burstPoolSize, transform);
                _bursts.Prewarm();
            }
        }

        private void Start()
        {
            VisualElement root = _ui != null ? _ui.rootVisualElement : null;
            _verdictWord = root?.Q<Label>("verdict-word");
            _verdictDelta = root?.Q<Label>("verdict-delta");
            _hudRing = root?.Q<Label>("hud-ring");
            _hudLives = root?.Q<Label>("hud-lives");
            _input.Tapped += OnTapped;
            _input.SlowMoPressed += OnSlowMoPressed;
        }

        private void OnDestroy()
        {
            if (_input != null)
            {
                _input.Tapped -= OnTapped;
                _input.SlowMoPressed -= OnSlowMoPressed;
            }
            _runCts?.Cancel();
            _runCts?.Dispose();
        }

        // ------------------------------------------------------------------ Run lifecycle

        public async UniTask StartRunAsync(GameMode mode, int slowMoTickets, int localRating, bool localFtue, CancellationToken ct)
        {
            _runCts?.Cancel();
            _runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _mode = mode;
            _continueOffered = false;
            _finished = false;
            _online = false;

            int baseMs;
            bool ftue;
            int maxRings;
            int maxMisses;
            if (_boot.IsOnline)
            {
                try
                {
                    RunStartResponse res = await _network.PostAsync<RunStartRequest, RunStartResponse>(
                        "/v1/runs/start", new RunStartRequest { mode = mode.ToString().ToUpperInvariant() }, AuthMode.Signed, _runCts.Token);
                    _online = true;
                    _runId = res.runId;
                    _seed = (uint)res.seed;
                    baseMs = res.baseDurationMs;
                    ftue = res.ftue;
                    maxRings = res.maxRings;
                    maxMisses = res.maxMisses;
                    _ring0Realtime = Math.Max(Time.realtimeSinceStartupAsDouble + 0.3, _network.ServerMsToRealtime(res.ring0ServerTimeMs));
                }
                catch (ApiException e)
                {
                    Debug.LogWarning($"[Gameplay] run start failed ({e.Code}); playing offline");
                    baseMs = maxRings = maxMisses = 0;
                    ftue = false;
                }
            }
            else
            {
                baseMs = maxRings = maxMisses = 0;
                ftue = false;
            }

            if (!_online)
            {
                // Offline practice run: scored locally, never rewarded (the GDD's anti-duplication rule).
                _runId = null;
                _seed = (uint)Guid.NewGuid().GetHashCode();
                ftue = localFtue && mode == GameMode.Pulse;
                baseMs = ftue ? 2500 : mode == GameMode.Gauntlet ? 1900 : RingSchedule.BaseDurationForRating(localRating);
                maxRings = mode == GameMode.Gauntlet ? 25 : 500;
                maxMisses = mode == GameMode.Zen ? 500 : 3;
                _ring0Realtime = Time.realtimeSinceStartupAsDouble + 0.9;
            }

            _session = new RunSession(_seed, baseMs, ftue, maxRings, maxMisses, slowMoTickets);
            _telemetry.Track(TelemetryCategory.Session, "run_start", "online", _online ? 1 : 0);
            UpdateHud();
        }

        /// <summary>Rewarded "replay this ring" continue. Returns true when the server verified the reward.</summary>
        public async UniTask<bool> AcceptContinueAsync(CancellationToken ct)
        {
            if (_session == null || !_session.AwaitingContinue) return false;
            AdRewardOutcome outcome = await _ads.ShowRewardedAsync(AdManager.PlacementReplayRing, _runId, ct);
            if (outcome != AdRewardOutcome.Granted)
            {
                await EndRunAsync(ct);
                return false;
            }
            _session.Continue(NowUs() + 900_000);
            UpdateHud();
            return true;
        }

        public UniTask DeclineContinueAsync(CancellationToken ct) => EndRunAsync(ct);

        public async UniTask EndRunAsync(CancellationToken ct)
        {
            if (_session == null || _finished) return;
            _finished = true;
            RunSession session = _session;
            session.End();
            SetRingVisible(false);

            var summary = new RunSummary
            {
                Mode = _mode,
                Rings = session.RingsResolved,
                BestAbsDeltaUs = session.BestAbsDeltaUs,
                Online = _online,
                ServerStatus = _online ? "SUBMIT_FAILED" : "OFFLINE",
            };
            for (int i = 0; i < session.RingsResolved; i++)
            {
                switch (session.VerdictAt(i))
                {
                    case Verdict.Perfect: summary.Perfects++; break;
                    case Verdict.Clean: summary.Cleans++; break;
                    case Verdict.Close: summary.Closes++; break;
                    default: summary.Misses++; break;
                }
            }

            if (_online && session.RingsResolved > 0)
            {
                try
                {
                    var req = new RunSubmitRequest
                    {
                        runId = _runId,
                        tapsUs = session.CopyTaps(),
                        slowMoRings = session.CopySlowMoRings(),
                        resumes = session.CopyResumes(),
                    };
                    RunSubmitResponse res = await _network.PostAsync<RunSubmitRequest, RunSubmitResponse>("/v1/runs/submit", req, AuthMode.Signed, ct);
                    summary.ServerStatus = res.status;
                    summary.TicksAwarded = res.ticksAwarded;
                    summary.PrecisionRating = res.precisionRating;
                    summary.PersonalBest = res.personalBest;
                }
                catch (ApiException e)
                {
                    Debug.LogWarning($"[Gameplay] submit failed: {e.Code}");
                }
            }

            _telemetry.Track(new TelemetryEvent
            {
                Category = TelemetryCategory.Session,
                Name = "run_end",
                NumKey1 = "rings", NumVal1 = summary.Rings,
                NumKey2 = "best_us", NumVal2 = summary.BestAbsDeltaUs,
                StrKey = "status", StrVal = summary.ServerStatus,
            });
            RunFinished?.Invoke(summary);
        }

        // ------------------------------------------------------------------ Frame loop

        private void Update()
        {
            RunSession s = _session;
            if (s == null || s.IsOver) return;

            long now = NowUs();
            if (s.Advance(now, out RingResult missed)) OnResolved(missed);
            if (s.IsOver)
            {
                EndRunAsync(_runCts.Token).Forget();
                return;
            }
            if (!s.HasCurrent) return;

            RingState ring = s.Current;
            if (now < ring.SpawnUs)
            {
                SetRingVisible(false);
                return;
            }

            float p = (float)(now - ring.SpawnUs) / (ring.CloseUs - ring.SpawnUs);
            float radius = Mathf.Max(0.02f, StartRadius - (StartRadius - TargetRadius) * p);
            float x = ring.Archetype == RingArchetype.Drifter ? ring.Drift * DriftAmplitude * (Mathf.Min(p, 1.2f) - 0.5f) * 2f : 0f;

            SetRingVisible(true);
            _ring.transform.localPosition = new Vector3(x, 0f, 0f);
            _ring.transform.localScale = new Vector3(radius, radius, 1f);
            _target.transform.localPosition = new Vector3(x, 0f, 0f);
            Color c = ring.SlowMo ? _slowMoColor : _ringColor;
            c.a = Mathf.Clamp01(p * 7f); // fade in over the first ~14% (the "inhale")
            _ring.startColor = c;
            _ring.endColor = c;
        }

        private void OnTapped(PointerSample sample)
        {
            RunSession s = _session;
            if (s == null || s.IsOver) return;
            long tapUs = (long)Math.Round((sample.EventTime - _ring0Realtime) * 1_000_000.0);
            if (s.Tap(tapUs, out RingResult result)) OnResolved(result);
            if (s.IsOver) EndRunAsync(_runCts.Token).Forget();
        }

        private void OnSlowMoPressed(PointerSample sample)
        {
            if (_session == null || _mode == GameMode.Gauntlet) return;
            _session.ToggleSlowMo(NowUs());
        }

        private void OnResolved(RingResult r)
        {
            SetRingVisible(false);
            HapticPattern haptic;
            switch (r.Verdict)
            {
                case Verdict.Perfect: haptic = HapticPattern.Perfect; Burst(_perfectColor); break;
                case Verdict.Clean: haptic = HapticPattern.Clean; Burst(_ringColor); break;
                case Verdict.Close: haptic = HapticPattern.Close; break;
                default: haptic = HapticPattern.Miss; break;
            }
            _input.PlayHaptic(r.StreakMilestone ? HapticPattern.StreakMilestone : haptic);

            if (_verdictWord != null) _verdictWord.text = r.Verdict == Verdict.Close ? "SO CLOSE" : VerdictName(r.Verdict);
            if (_verdictDelta != null) _verdictDelta.text = r.Tapped ? FormatDelta(r.DeltaUs) : "NO TAP";

            // Difficulty telemetry (GDD analytics #2): per-ring delta distribution feeds the personalisation model.
            _telemetry.Track(new TelemetryEvent
            {
                Category = TelemetryCategory.Difficulty,
                Name = "ring",
                NumKey1 = "index", NumVal1 = r.Index,
                NumKey2 = "delta_us", NumVal2 = r.Tapped ? r.DeltaUs : double.NaN,
                NumKey3 = "verdict", NumVal3 = (int)r.Verdict,
            });

            if (_session.AwaitingContinue)
            {
                bool canOffer = _mode == GameMode.Pulse && !_continueOffered && _session.RingsResolved >= 5 && _ads.CanOffer(AdManager.PlacementReplayRing);
                if (canOffer)
                {
                    _continueOffered = true;
                    ContinueOffered?.Invoke();
                }
                else
                {
                    EndRunAsync(_runCts.Token).Forget();
                }
            }
            UpdateHud();
        }

        // ------------------------------------------------------------------ Helpers

        private long NowUs() => (long)Math.Round((Time.realtimeSinceStartupAsDouble - _ring0Realtime) * 1_000_000.0);

        private void UpdateHud()
        {
            if (_session == null) return;
            if (_hudRing != null) _hudRing.text = (_session.RingsResolved + 1).ToString(CultureInfo.InvariantCulture);
            if (_hudLives != null) _hudLives.text = _mode == GameMode.Zen ? "∞" : Math.Max(0, _session.MaxMisses - _session.Misses).ToString(CultureInfo.InvariantCulture);
        }

        private void Burst(Color color)
        {
            if (_bursts == null || !_bursts.TrySpawn(_target.transform.position, Quaternion.identity, out ParticleSystem ps)) return;
            ParticleSystem.MainModule main = ps.main;
            main.startColor = color;
            ps.Play();
            ReturnBurstAsync(ps).Forget();
        }

        private async UniTaskVoid ReturnBurstAsync(ParticleSystem ps)
        {
            await UniTask.Delay(TimeSpan.FromSeconds(ps.main.duration + ps.main.startLifetime.constantMax), cancellationToken: this.GetCancellationTokenOnDestroy());
            _bursts.Despawn(ps);
        }

        private void SetRingVisible(bool visible)
        {
            if (_ring != null && _ring.enabled != visible) _ring.enabled = visible;
        }

        private static void BuildUnitCircle(LineRenderer lr)
        {
            if (lr == null) return;
            lr.useWorldSpace = false;
            lr.loop = true;
            lr.positionCount = CircleSegments;
            for (int i = 0; i < CircleSegments; i++)
            {
                float a = i * Mathf.PI * 2f / CircleSegments;
                lr.SetPosition(i, new Vector3(Mathf.Cos(a), Mathf.Sin(a), 0f));
            }
        }

        private static string VerdictName(Verdict v)
        {
            switch (v)
            {
                case Verdict.Perfect: return "PERFECT";
                case Verdict.Clean: return "CLEAN";
                case Verdict.Close: return "CLOSE";
                default: return "MISS";
            }
        }

        private static string FormatDelta(long deltaUs)
        {
            long abs = deltaUs < 0 ? -deltaUs : deltaUs;
            string s = (abs / 1_000_000.0).ToString("0.000", CultureInfo.InvariantCulture) + "s";
            if (abs < 500) return s;
            return (deltaUs > 0 ? "+" : "−") + s;
        }
    }
}
