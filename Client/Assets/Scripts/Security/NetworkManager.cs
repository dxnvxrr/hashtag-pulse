using System;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;
using Debug = UnityEngine.Debug;
using Random = UnityEngine.Random;

namespace OneMoreTap.Security
{
    [Serializable]
    public sealed class ApiConfig
    {
        [Tooltip("e.g. https://api.onemoretap.game (no trailing slash)")]
        public string BaseUrl = "http://localhost:8080";
        public int TimeoutSeconds = 8;
        public int MaxRetries = 3;
        public int BaseBackoffMs = 250;
        public int MaxBackoffMs = 4000;
    }

    public sealed class ApiException : Exception
    {
        public long StatusCode { get; }
        public string Code { get; }
        public bool IsNetworkError => StatusCode == 0;
        public bool IsClientError => StatusCode >= 400 && StatusCode < 500;

        public ApiException(long status, string code, string message) : base($"[{status}] {code}: {message}")
        {
            StatusCode = status;
            Code = code;
        }
    }

    public enum AuthMode
    {
        /// <summary>No credentials (time sync, guest login, refresh).</summary>
        None,
        /// <summary>Bearer token + device fingerprint.</summary>
        Bearer,
        /// <summary>Bearer + HMAC-SHA256 signature + nonce/timestamp replay protection (default for game endpoints).</summary>
        Signed,
    }

    /// <summary>
    /// UniTask HTTP client. Responsibilities:
    ///  * NTP-style clock offset against the server, so signatures and run timing use server time even on
    ///    devices with a wrong (or deliberately changed) wall clock.
    ///  * HMAC-SHA256 signing of METHOD/PATH/TIMESTAMP/NONCE/SHA256(body) with the per-session key from login.
    ///  * Authorization header management and one transparent token refresh on 401.
    ///  * Exponential backoff with full jitter on network errors, 5xx and 429 (honouring Retry-After).
    ///    4xx responses are never retried. Each attempt is re-signed with a fresh nonce.
    /// </summary>
    public sealed class NetworkManager
    {
        private readonly ApiConfig _config;
        private readonly Stopwatch _monotonic = Stopwatch.StartNew();
        private readonly long _monotonicEpochMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        private string _accessToken;
        private string _sessionId;
        private byte[] _sessionKey;
        private string _deviceFingerprint;
        private long _serverOffsetMs;
        private Func<CancellationToken, UniTask<bool>> _refreshHandler;
        private UniTask<bool>? _refreshInFlight;

        public bool HasSession => _accessToken != null && _sessionKey != null;
        public bool IsClockSynced { get; private set; }

        public NetworkManager(ApiConfig config)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
        }

        // ------------------------------------------------------------------ Session / clock

        public void SetDeviceFingerprint(string fingerprintHex) => _deviceFingerprint = fingerprintHex;

        public void SetSession(string accessToken, string sessionId, string sessionKeyBase64Url)
        {
            _accessToken = accessToken;
            _sessionId = sessionId;
            _sessionKey = string.IsNullOrEmpty(sessionKeyBase64Url) ? null : Base64UrlDecode(sessionKeyBase64Url);
        }

        public void ClearSession()
        {
            _accessToken = null;
            _sessionId = null;
            if (_sessionKey != null) Array.Clear(_sessionKey, 0, _sessionKey.Length);
            _sessionKey = null;
        }

        /// <summary>AuthManager installs this so a 401 can transparently refresh and retry once.</summary>
        public void SetRefreshHandler(Func<CancellationToken, UniTask<bool>> handler) => _refreshHandler = handler;

        /// <summary>Monotonic local epoch ms: immune to the user changing the device clock mid-session.</summary>
        public long LocalNowMs => _monotonicEpochMs + _monotonic.ElapsedMilliseconds;

        /// <summary>Best estimate of the server's epoch ms right now.</summary>
        public long ServerNowMs => LocalNowMs + _serverOffsetMs;

        /// <summary>Converts a server epoch ms into the Time.realtimeSinceStartupAsDouble timeline used by input events.</summary>
        public double ServerMsToRealtime(long serverMs) => Time.realtimeSinceStartupAsDouble + (serverMs - ServerNowMs) / 1000.0;

        public void SeedClockOffset(long serverTimeMs)
        {
            if (!IsClockSynced) _serverOffsetMs = serverTimeMs - LocalNowMs;
        }

        /// <summary>Takes several samples and keeps the one with the lowest round-trip (least asymmetric-delay error).</summary>
        public async UniTask SyncClockAsync(CancellationToken ct, int samples = 3)
        {
            long bestRtt = long.MaxValue;
            long bestOffset = 0;
            for (int i = 0; i < samples; i++)
            {
                long t0 = LocalNowMs;
                ServerTimeResponse res = await SendAsync<EmptyBody, ServerTimeResponse>("GET", "/v1/time", null, AuthMode.None, ct, maxRetries: 1);
                long t1 = LocalNowMs;
                long rtt = t1 - t0;
                if (rtt < bestRtt)
                {
                    bestRtt = rtt;
                    bestOffset = res.serverTimeMs - (t0 + rtt / 2);
                }
            }
            _serverOffsetMs = bestOffset;
            IsClockSynced = true;
            Debug.Log($"[Network] clock offset {_serverOffsetMs} ms (rtt {bestRtt} ms)");
        }

        // ------------------------------------------------------------------ Public verbs

        public UniTask<TRes> GetAsync<TRes>(string path, AuthMode auth, CancellationToken ct) where TRes : class
            => SendAsync<EmptyBody, TRes>("GET", path, null, auth, ct);

        public UniTask<TRes> PostAsync<TReq, TRes>(string path, TReq body, AuthMode auth, CancellationToken ct)
            where TReq : class where TRes : class
            => SendAsync<TReq, TRes>("POST", path, body, auth, ct);

        /// <summary>Posts pre-serialised JSON (telemetry builds its own JSON to avoid JsonUtility's dictionary limits).</summary>
        public async UniTask PostRawJsonAsync(string path, string json, AuthMode auth, CancellationToken ct)
        {
            await SendCoreAsync("POST", path, json, auth, ct, _config.MaxRetries);
        }

        public async UniTask<TRes> SendAsync<TReq, TRes>(string method, string path, TReq body, AuthMode auth, CancellationToken ct, int? maxRetries = null)
            where TReq : class where TRes : class
        {
            string json = body == null ? (method == "GET" ? string.Empty : "{}") : JsonUtility.ToJson(body);
            string text = await SendCoreAsync(method, path, json, auth, ct, maxRetries ?? _config.MaxRetries);
            if (typeof(TRes) == typeof(EmptyBody) || string.IsNullOrEmpty(text)) return null;
            return JsonUtility.FromJson<TRes>(text);
        }

        // ------------------------------------------------------------------ Core

        private async UniTask<string> SendCoreAsync(string method, string path, string json, AuthMode auth, CancellationToken ct, int maxRetries)
        {
            byte[] bodyBytes = string.IsNullOrEmpty(json) ? Array.Empty<byte>() : Encoding.UTF8.GetBytes(json);
            bool refreshed = false;
            int attempt = 0;

            while (true)
            {
                ct.ThrowIfCancellationRequested();
                using (UnityWebRequest req = BuildRequest(method, path, bodyBytes, auth))
                {
                    long status;
                    string responseText;
                    string retryAfter;
                    try
                    {
                        await req.SendWebRequest().WithCancellation(ct);
                        return req.downloadHandler?.text;
                    }
                    catch (UnityWebRequestException e)
                    {
                        status = e.ResponseCode;
                        responseText = e.Text;
                        retryAfter = e.ResponseHeaders != null && e.ResponseHeaders.TryGetValue("Retry-After", out string ra) ? ra : null;
                        if (e.Result == UnityWebRequest.Result.ConnectionError) status = 0;
                    }

                    ApiException error = ToApiException(status, responseText);

                    // One transparent refresh for an expired access token / signing session.
                    if (status == 401 && auth != AuthMode.None && !refreshed && _refreshHandler != null && IsRefreshable(error.Code))
                    {
                        refreshed = true;
                        if (await RefreshOnceAsync(ct)) continue;
                        throw error;
                    }

                    bool retryable = status == 0 || status == 429 || status >= 500;
                    if (!retryable || attempt >= maxRetries) throw error;

                    int delayMs = BackoffDelayMs(attempt, retryAfter);
                    attempt++;
                    Debug.LogWarning($"[Network] {method} {path} failed ({status} {error.Code}); retry {attempt}/{maxRetries} in {delayMs} ms");
                    await UniTask.Delay(delayMs, DelayType.Realtime, cancellationToken: ct);
                }
            }
        }

        private UnityWebRequest BuildRequest(string method, string path, byte[] body, AuthMode auth)
        {
            var req = new UnityWebRequest(_config.BaseUrl + path, method)
            {
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = _config.TimeoutSeconds,
            };
            if (body.Length > 0)
            {
                req.uploadHandler = new UploadHandlerRaw(body) { contentType = "application/json" };
                req.SetRequestHeader("Content-Type", "application/json");
            }
            req.SetRequestHeader("Accept", "application/json");

            if (auth == AuthMode.None) return req;

            if (_accessToken == null || _deviceFingerprint == null)
            {
                req.Dispose();
                throw new ApiException(401, "no_session", "No active session");
            }
            req.SetRequestHeader("Authorization", "Bearer " + _accessToken);
            req.SetRequestHeader("X-Device-Fingerprint", _deviceFingerprint);

            if (auth == AuthMode.Signed)
            {
                if (_sessionKey == null)
                {
                    req.Dispose();
                    throw new ApiException(401, "no_session", "No signing key");
                }
                string timestamp = ServerNowMs.ToString(CultureInfo.InvariantCulture);
                string nonce = NewNonce();
                string canonical = method.ToUpperInvariant() + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + Sha256Hex(body);
                req.SetRequestHeader("X-Timestamp", timestamp);
                req.SetRequestHeader("X-Nonce", nonce);
                req.SetRequestHeader("X-Signature", HmacBase64(_sessionKey, canonical));
            }
            return req;
        }

        private async UniTask<bool> RefreshOnceAsync(CancellationToken ct)
        {
            // Coalesce concurrent 401s into a single refresh call.
            if (_refreshInFlight == null) _refreshInFlight = _refreshHandler(ct).Preserve();
            try
            {
                return await _refreshInFlight.Value;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Network] token refresh failed: {e.Message}");
                return false;
            }
            finally
            {
                _refreshInFlight = null;
            }
        }

        private static bool IsRefreshable(string code)
        {
            switch (code)
            {
                case "invalid_access_token":
                case "session_expired":
                case "no_session":
                    return true;
                default:
                    return false;
            }
        }

        private int BackoffDelayMs(int attempt, string retryAfter)
        {
            if (!string.IsNullOrEmpty(retryAfter) && int.TryParse(retryAfter, NumberStyles.Integer, CultureInfo.InvariantCulture, out int seconds))
            {
                return Mathf.Clamp(seconds * 1000, _config.BaseBackoffMs, _config.MaxBackoffMs * 4);
            }
            // Full jitter (AWS architecture blog): uniform in [0, min(cap, base * 2^attempt)].
            int ceiling = Mathf.Min(_config.MaxBackoffMs, _config.BaseBackoffMs << Mathf.Min(attempt, 10));
            return _config.BaseBackoffMs / 2 + Random.Range(0, ceiling);
        }

        private static ApiException ToApiException(long status, string text)
        {
            if (status == 0) return new ApiException(0, "network_error", "Network unreachable");
            if (!string.IsNullOrEmpty(text))
            {
                try
                {
                    ApiErrorBody body = JsonUtility.FromJson<ApiErrorBody>(text);
                    if (body != null && !string.IsNullOrEmpty(body.error)) return new ApiException(status, body.error, body.message ?? body.error);
                }
                catch (ArgumentException)
                {
                    // Non-JSON error page from a proxy; fall through.
                }
            }
            return new ApiException(status, "http_" + status, "HTTP " + status);
        }

        // ------------------------------------------------------------------ Crypto helpers

        private static string Sha256Hex(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(data);
                var sb = new StringBuilder(64);
                for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        private static string HmacBase64(byte[] key, string message)
        {
            using (var hmac = new HMACSHA256(key))
            {
                return Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(message)));
            }
        }

        private static string NewNonce()
        {
            byte[] bytes = new byte[18];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        public static byte[] Base64UrlDecode(string s)
        {
            string b64 = s.Replace('-', '+').Replace('_', '/');
            switch (b64.Length % 4)
            {
                case 2: b64 += "=="; break;
                case 3: b64 += "="; break;
            }
            return Convert.FromBase64String(b64);
        }
    }
}
