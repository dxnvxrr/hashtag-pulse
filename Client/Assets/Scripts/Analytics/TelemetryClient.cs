using System;
using System.Globalization;
using System.Text;
using System.Threading;
using Cysharp.Threading.Tasks;
using OneMoreTap.Security;
using UnityEngine;
using VContainer.Unity;

namespace OneMoreTap.Analytics
{
    public enum TelemetryCategory : byte
    {
        Ftue,
        Difficulty,
        Performance,
        Transaction,
        Ad,
        Viral,
        Session,
    }

    /// <summary>
    /// Fixed-size event record. Value type with up to three numeric and one string property so
    /// <see cref="TelemetryClient.Track"/> never allocates during gameplay — pass string literals/constants for names and keys.
    /// </summary>
    public struct TelemetryEvent
    {
        public TelemetryCategory Category;
        public string Name;
        public long TimestampMs;
        public string NumKey1; public double NumVal1;
        public string NumKey2; public double NumVal2;
        public string NumKey3; public double NumVal3;
        public string StrKey; public string StrVal;
    }

    /// <summary>
    /// Batched analytics client for /v1/telemetry (FTUE funnel, difficulty telemetry, frame drops, transactions).
    /// Events go into a preallocated ring buffer; JSON is built only at flush time (every 10 s, at 50 events,
    /// or when the app is backgrounded). Frame-drop detection runs in Tick() and is aggregated, not per-frame.
    /// </summary>
    public sealed class TelemetryClient : ITickable, IDisposable
    {
        private const int Capacity = 512;
        private const int FlushThreshold = 50;
        private const int MaxBatch = 200;
        private const float FlushIntervalSec = 10f;

        private readonly NetworkManager _network;
        private readonly TelemetryEvent[] _buffer = new TelemetryEvent[Capacity];
        private readonly StringBuilder _json = new StringBuilder(16 * 1024);
        private readonly string _sessionId = Guid.NewGuid().ToString("N");
        private int _head;
        private int _count;
        private int _dropped;
        private bool _flushing;
        // Events evicted from the head while a flush was in flight (they were part of the batch being sent).
        private int _evictedDuringFlush;
        private CancellationTokenSource _loopCts;

        // Frame-drop aggregation.
        private float _targetFrameTime = 1f / 60f;
        private int _framesObserved;
        private int _framesDropped;
        private float _worstFrameMs;

        public string SessionId => _sessionId;
        public bool Enabled { get; set; } = true;

        public TelemetryClient(NetworkManager network)
        {
            _network = network;
        }

        public void SetTargetFrameRate(int fps) => _targetFrameTime = 1f / Mathf.Max(1, fps);

        // ------------------------------------------------------------------ Recording (allocation-free)

        public void Track(TelemetryCategory category, string name) =>
            Track(new TelemetryEvent { Category = category, Name = name });

        public void Track(TelemetryCategory category, string name, string key, double value) =>
            Track(new TelemetryEvent { Category = category, Name = name, NumKey1 = key, NumVal1 = value });

        public void Track(TelemetryEvent e)
        {
            if (!Enabled) return;
            if (e.TimestampMs == 0) e.TimestampMs = _network.ServerNowMs;
            if (_count == Capacity)
            {
                // Overwrite the oldest event; count what we lost so the backend can see sampling loss.
                _head = (_head + 1) % Capacity;
                _count--;
                if (_flushing) _evictedDuringFlush++;
                else _dropped++;
            }
            _buffer[(_head + _count) % Capacity] = e;
            _count++;
            if (_count >= FlushThreshold && !_flushing && _network.HasSession) FlushAsync(CancellationToken.None).Forget();
        }

        public void Tick()
        {
            float dt = Time.unscaledDeltaTime;
            _framesObserved++;
            // A frame is "dropped" when it took more than 1.5x the target frame time (i.e. at least one vsync missed).
            if (dt > _targetFrameTime * 1.5f)
            {
                _framesDropped++;
                float ms = dt * 1000f;
                if (ms > _worstFrameMs) _worstFrameMs = ms;
            }
        }

        // ------------------------------------------------------------------ Flushing

        public void StartFlushLoop(CancellationToken appLifetime)
        {
            _loopCts?.Cancel();
            _loopCts = CancellationTokenSource.CreateLinkedTokenSource(appLifetime);
            FlushLoopAsync(_loopCts.Token).Forget();
        }

        private async UniTaskVoid FlushLoopAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                await UniTask.Delay(TimeSpan.FromSeconds(FlushIntervalSec), DelayType.Realtime, cancellationToken: ct).SuppressCancellationThrow();
                if (ct.IsCancellationRequested) break;
                EmitFrameStats();
                await FlushAsync(ct);
            }
        }

        public async UniTask FlushAsync(CancellationToken ct)
        {
            if (_flushing || _count == 0 || !_network.HasSession) return;
            _flushing = true;
            _evictedDuringFlush = 0;
            int take = Math.Min(_count, MaxBatch);
            try
            {
                string payload = BuildPayload(take);
                await _network.PostRawJsonAsync("/v1/telemetry", payload, AuthMode.Bearer, ct);
                ConsumeSent(take);
            }
            catch (ApiException e) when (e.IsClientError && e.StatusCode != 429)
            {
                // Malformed batch: drop it rather than retrying forever.
                Debug.LogWarning($"[Telemetry] batch rejected ({e.Code}); dropping {take} events");
                ConsumeSent(take);
            }
            catch (Exception e) when (!(e is OperationCanceledException))
            {
                // Network failure: keep events buffered for the next flush.
                Debug.Log($"[Telemetry] flush deferred: {e.Message}");
            }
            finally
            {
                _flushing = false;
            }
        }

        private void ConsumeSent(int take)
        {
            // Anything evicted mid-flight was already in this batch, so it has left the buffer already.
            int remove = Math.Max(0, Math.Min(_count, take - _evictedDuringFlush));
            _head = (_head + remove) % Capacity;
            _count -= remove;
        }

        /// <summary>Call from OnApplicationPause(true): the OS may kill the process right after.</summary>
        public void FlushOnBackground()
        {
            EmitFrameStats();
            FlushAsync(CancellationToken.None).Forget();
        }

        private void EmitFrameStats()
        {
            if (_framesObserved == 0) return;
            Track(new TelemetryEvent
            {
                Category = TelemetryCategory.Performance,
                Name = "frame_stats",
                NumKey1 = "frames", NumVal1 = _framesObserved,
                NumKey2 = "dropped", NumVal2 = _framesDropped,
                NumKey3 = "worst_ms", NumVal3 = Math.Round(_worstFrameMs, 1),
            });
            if (_dropped > 0)
            {
                Track(TelemetryCategory.Performance, "telemetry_overflow", "lost", _dropped);
                _dropped = 0;
            }
            _framesObserved = 0;
            _framesDropped = 0;
            _worstFrameMs = 0;
        }

        private string BuildPayload(int take)
        {
            StringBuilder sb = _json;
            sb.Clear();
            sb.Append("{\"appVersion\":");
            AppendString(sb, Application.version);
            sb.Append(",\"platform\":\"").Append(PlatformName()).Append("\",\"events\":[");
            for (int i = 0; i < take; i++)
            {
                ref TelemetryEvent e = ref _buffer[(_head + i) % Capacity];
                if (i > 0) sb.Append(',');
                sb.Append("{\"category\":\"").Append(CategoryName(e.Category)).Append("\",\"name\":");
                AppendString(sb, e.Name);
                sb.Append(",\"ts\":").Append(e.TimestampMs.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"sessionId\":\"").Append(_sessionId).Append("\",\"props\":{");
                bool first = true;
                AppendNum(sb, ref first, e.NumKey1, e.NumVal1);
                AppendNum(sb, ref first, e.NumKey2, e.NumVal2);
                AppendNum(sb, ref first, e.NumKey3, e.NumVal3);
                if (e.StrKey != null)
                {
                    if (!first) sb.Append(',');
                    AppendString(sb, e.StrKey);
                    sb.Append(':');
                    AppendString(sb, e.StrVal ?? string.Empty);
                }
                sb.Append("}}");
            }
            sb.Append("]}");
            return sb.ToString();
        }

        private static void AppendNum(StringBuilder sb, ref bool first, string key, double value)
        {
            if (key == null) return;
            if (!first) sb.Append(',');
            first = false;
            AppendString(sb, key);
            sb.Append(':');
            sb.Append(double.IsNaN(value) || double.IsInfinity(value) ? "0" : value.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void AppendString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s ?? string.Empty)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        private static string CategoryName(TelemetryCategory c)
        {
            switch (c)
            {
                case TelemetryCategory.Ftue: return "ftue";
                case TelemetryCategory.Difficulty: return "difficulty";
                case TelemetryCategory.Performance: return "performance";
                case TelemetryCategory.Transaction: return "transaction";
                case TelemetryCategory.Ad: return "ad";
                case TelemetryCategory.Viral: return "viral";
                default: return "session";
            }
        }

        private static string PlatformName()
        {
#if UNITY_EDITOR
            return "EDITOR";
#elif UNITY_IOS
            return "IOS";
#elif UNITY_ANDROID
            return "ANDROID";
#else
            return "EDITOR";
#endif
        }

        public void Dispose()
        {
            _loopCts?.Cancel();
            _loopCts?.Dispose();
        }
    }
}
