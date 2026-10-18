using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;
#if ONEMORETAP_APPLE_AUTH && UNITY_IOS && !UNITY_EDITOR
using AppleAuth;
using AppleAuth.Enums;
using AppleAuth.Interfaces;
using AppleAuth.Native;
#endif
#if ONEMORETAP_GPGS && UNITY_ANDROID && !UNITY_EDITOR
using GooglePlayGames;
using GooglePlayGames.BasicApi;
#endif

namespace OneMoreTap.Security
{
    public enum AuthState
    {
        SignedOut,
        Guest,
        Linked,
    }

    /// <summary>Credential from a platform identity provider, ready to send to /v1/auth/link.</summary>
    public sealed class ExternalCredential
    {
        public string Provider;      // "APPLE" | "GOOGLE_PLAY_GAMES"
        public string Token;         // Apple identity token (JWT) or GPGS server auth code
        public string ProviderUserId;
    }

    /// <summary>Abstraction over Sign in with Apple / Google Play Games so the flow is testable and plugin-optional.</summary>
    public interface IExternalIdentityProvider
    {
        string ProviderName { get; }
        bool IsSupported { get; }
        /// <summary>No UI. Returns null when the player has not previously authorised this app.</summary>
        UniTask<ExternalCredential> TrySilentAsync(CancellationToken ct);
        /// <summary>Shows the platform sheet. Only call from an explicit player action (profile tab button).</summary>
        UniTask<ExternalCredential> SignInInteractiveAsync(CancellationToken ct);
    }

    /// <summary>The identity providers compiled into this build (wrapper keeps DI registration unambiguous).</summary>
    public sealed class IdentityProviders
    {
        public readonly IExternalIdentityProvider[] All;

        public IdentityProviders(IExternalIdentityProvider[] all)
        {
            All = all ?? Array.Empty<IExternalIdentityProvider>();
        }
    }

    /// <summary>
    /// Guest-first authentication (GDD Pillar 2): a silent device-bound account on first launch with zero taps, then a
    /// background attempt to link Apple / Google Play Games without UI. If the platform identity already owns an
    /// account (reinstall, new phone), the server merges guest progress into it and returns that account's session.
    /// </summary>
    public sealed class AuthManager
    {
        private const string KeyRefreshToken = "auth.refresh";
        private const string KeyUserId = "auth.userId";
        private const string KeyInstallId = "auth.installId";
        private const string KeyLinkedProvider = "auth.linkedProvider";
        public const string KeyMinor = "coppa.isMinor";
        public const string KeyAgeGateAnswered = "coppa.answered";

        private readonly NetworkManager _network;
        private readonly SecureStorage _storage;
        private readonly IExternalIdentityProvider[] _providers;
        private string _fingerprint;

        public AuthState State { get; private set; } = AuthState.SignedOut;
        public string UserId { get; private set; }
        public event Action<AuthState> StateChanged;
        /// <summary>Raised after a background merge switched this device to another (linked) account.</summary>
        public event Action AccountSwitched;

        public AuthManager(NetworkManager network, SecureStorage storage, IdentityProviders providers)
        {
            _network = network;
            _storage = storage;
            _providers = providers?.All ?? Array.Empty<IExternalIdentityProvider>();
            _network.SetRefreshHandler(RecoverSessionAsync);
        }

        /// <summary>Restores the session with the stored refresh token, or creates/recovers a guest account.</summary>
        public async UniTask EnsureSessionAsync(CancellationToken ct)
        {
            _fingerprint = ComputeFingerprint();
            _network.SetDeviceFingerprint(_fingerprint);

            if (_storage.HasKey(KeyRefreshToken) && await RefreshAsync(ct)) return;
            await GuestLoginAsync(ct);
        }

        private async UniTask GuestLoginAsync(CancellationToken ct)
        {
            var req = new GuestLoginRequest
            {
                deviceFingerprint = _fingerprint,
                platform = PlatformName(),
                model = SystemInfo.deviceModel,
                // Privacy-safe default: treat an unanswered age gate as a minor until the player answers it.
                isMinor = !_storage.GetBool(KeyAgeGateAnswered) || _storage.GetBool(KeyMinor, true),
            };
            GuestLoginResponse res = await _network.PostAsync<GuestLoginRequest, GuestLoginResponse>("/v1/auth/guest", req, AuthMode.None, ct);
            ApplySession(res);
            SetState(_storage.HasKey(KeyLinkedProvider) ? AuthState.Linked : AuthState.Guest);
            await _storage.SaveAsync(ct);
        }

        /// <summary>Installed as NetworkManager's 401 handler: refresh, else re-login as the device's guest account.</summary>
        private async UniTask<bool> RecoverSessionAsync(CancellationToken ct)
        {
            if (await RefreshAsync(ct)) return true;
            if (_fingerprint == null) return false;
            try
            {
                await GuestLoginAsync(ct);
                return true;
            }
            catch (ApiException e)
            {
                Debug.LogWarning($"[Auth] session recovery failed: {e.Code}");
                return false;
            }
        }

        /// <summary>Rotates the refresh token. Returns false (and clears local credentials) if the server rejects it.</summary>
        public async UniTask<bool> RefreshAsync(CancellationToken ct)
        {
            string refresh = _storage.GetString(KeyRefreshToken);
            if (string.IsNullOrEmpty(refresh) || _fingerprint == null) return false;
            try
            {
                var req = new RefreshRequest { refreshToken = refresh, deviceFingerprint = _fingerprint };
                SessionResponse res = await _network.PostAsync<RefreshRequest, SessionResponse>("/v1/auth/refresh", req, AuthMode.None, ct);
                ApplySession(res);
                if (State == AuthState.SignedOut) SetState(_storage.HasKey(KeyLinkedProvider) ? AuthState.Linked : AuthState.Guest);
                await _storage.SaveAsync(ct);
                return true;
            }
            catch (ApiException e) when (e.IsClientError)
            {
                // Revoked/expired/reused: drop it and fall back to guest login (same device → same account).
                Debug.LogWarning($"[Auth] refresh rejected ({e.Code}); falling back to guest login");
                _storage.Delete(KeyRefreshToken);
                _network.ClearSession();
                return false;
            }
        }

        /// <summary>
        /// Background, UI-free linking. Safe to fire-and-forget after the first ring: failures are logged and ignored,
        /// the player keeps playing as a guest.
        /// </summary>
        public async UniTask TryLinkSilentlyAsync(CancellationToken ct)
        {
            if (State != AuthState.Guest) return;
            foreach (IExternalIdentityProvider provider in _providers)
            {
                if (!provider.IsSupported) continue;
                try
                {
                    ExternalCredential cred = await provider.TrySilentAsync(ct);
                    if (cred == null) continue;
                    await LinkAsync(cred, ct);
                    return;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[Auth] silent {provider.ProviderName} link failed: {e.Message}");
                }
            }
        }

        /// <summary>Profile-tab "Sign in with Apple / Google" button.</summary>
        public async UniTask<bool> LinkInteractiveAsync(string providerName, CancellationToken ct)
        {
            foreach (IExternalIdentityProvider provider in _providers)
            {
                if (provider.ProviderName != providerName || !provider.IsSupported) continue;
                ExternalCredential cred = await provider.SignInInteractiveAsync(ct);
                if (cred == null) return false;
                await LinkAsync(cred, ct);
                return true;
            }
            return false;
        }

        /// <summary>Records the COPPA age-gate answer, tells the server, and refreshes so new tokens carry the flag.</summary>
        public async UniTask SubmitAgeGateAsync(bool isMinor, CancellationToken ct)
        {
            _storage.SetBool(KeyMinor, isMinor);
            _storage.SetBool(KeyAgeGateAnswered, true);
            await _storage.SaveAsync(ct);
            if (!_network.HasSession) return;
            await _network.PostAsync<AgeGateRequest, EmptyBody>("/v1/account/age-gate", new AgeGateRequest { isMinor = isMinor }, AuthMode.Signed, ct);
            await RefreshAsync(ct);
        }

        /// <summary>One-tap data deletion (GDPR/CCPA). Server revokes everything; local state is wiped.</summary>
        public async UniTask DeleteAccountAsync(CancellationToken ct)
        {
            await _network.PostAsync<EmptyBody, EmptyBody>("/v1/account/delete", new EmptyBody(), AuthMode.Signed, ct);
            _network.ClearSession();
            _storage.Clear();
            await _storage.SaveAsync(ct);
            UserId = null;
            SetState(AuthState.SignedOut);
        }

        private async UniTask LinkAsync(ExternalCredential cred, CancellationToken ct)
        {
            LinkResponse res;
            if (cred.Provider == "APPLE")
            {
                res = await _network.PostAsync<LinkAppleRequest, LinkResponse>("/v1/auth/link", new LinkAppleRequest { identityToken = cred.Token }, AuthMode.Signed, ct);
            }
            else
            {
                res = await _network.PostAsync<LinkGooglePlayRequest, LinkResponse>("/v1/auth/link", new LinkGooglePlayRequest { serverAuthCode = cred.Token }, AuthMode.Signed, ct);
            }

            _storage.SetString(KeyLinkedProvider, cred.Provider);
            if (!string.IsNullOrEmpty(cred.ProviderUserId)) _storage.SetString("auth.providerUser." + cred.Provider, cred.ProviderUserId);

            if (res.merged && res.tokens != null && !string.IsNullOrEmpty(res.tokens.accessToken))
            {
                ApplySession(res.tokens);
                AccountSwitched?.Invoke();
            }
            SetState(AuthState.Linked);
            await _storage.SaveAsync(ct);
            Debug.Log($"[Auth] linked {cred.Provider} (merged={res.merged})");
        }

        private void ApplySession(SessionResponse res)
        {
            _network.SetSession(res.accessToken, res.sessionId, res.sessionKey);
            _network.SeedClockOffset(res.serverTimeMs);
            _storage.SetString(KeyRefreshToken, res.refreshToken);
            _storage.SetString(KeyUserId, res.userId);
            UserId = res.userId;
        }

        private void SetState(AuthState state)
        {
            if (State == state) return;
            State = state;
            StateChanged?.Invoke(state);
        }

        /// <summary>
        /// Stable per-device fingerprint: SHA-256(device id | model | platform). Deliberately excludes the install id when
        /// the OS provides a device id, so a reinstall on the same phone recovers the same guest account.
        /// The server peppers and hashes it again; it is a binding, not a secret.
        /// </summary>
        private string ComputeFingerprint()
        {
            string deviceId = SystemInfo.deviceUniqueIdentifier;
            if (string.IsNullOrEmpty(deviceId) || deviceId == SystemInfo.unsupportedIdentifier)
            {
                deviceId = _storage.GetString(KeyInstallId);
                if (string.IsNullOrEmpty(deviceId))
                {
                    deviceId = Guid.NewGuid().ToString("N");
                    _storage.SetString(KeyInstallId, deviceId);
                }
            }
            string material = deviceId + "|" + SystemInfo.deviceModel + "|" + PlatformName();
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(material));
                var sb = new StringBuilder(64);
                foreach (byte b in hash) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
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

        /// <summary>Providers available on this build. Plugin-backed providers compile only when their define is set.</summary>
        public static IdentityProviders CreatePlatformProviders(SecureStorage storage)
        {
#if ONEMORETAP_APPLE_AUTH && UNITY_IOS && !UNITY_EDITOR
            return new IdentityProviders(new IExternalIdentityProvider[] { new AppleIdentityProvider(storage) });
#elif ONEMORETAP_GPGS && UNITY_ANDROID && !UNITY_EDITOR
            return new IdentityProviders(new IExternalIdentityProvider[] { new PlayGamesIdentityProvider() });
#else
            return new IdentityProviders(Array.Empty<IExternalIdentityProvider>());
#endif
        }
    }

#if ONEMORETAP_APPLE_AUTH && UNITY_IOS && !UNITY_EDITOR
    /// <summary>
    /// Sign in with Apple via the apple-signin-unity plugin (com.lupidan.apple-signin-unity).
    /// Silent path: only when an Apple user id was stored by a previous interactive sign-in and Apple still reports it
    /// as Authorized — Apple offers no fully silent first-time flow.
    /// </summary>
    public sealed class AppleIdentityProvider : IExternalIdentityProvider
    {
        private const string KeyAppleUser = "auth.providerUser.APPLE";
        private readonly SecureStorage _storage;
        private readonly AppleAuthManager _manager;

        public string ProviderName => "APPLE";
        public bool IsSupported => AppleAuthManager.IsCurrentPlatformSupported;

        public AppleIdentityProvider(SecureStorage storage)
        {
            _storage = storage;
            _manager = new AppleAuthManager(new PayloadDeserializer());
            PumpCallbacksAsync().Forget();
        }

        private async UniTaskVoid PumpCallbacksAsync()
        {
            // The plugin delivers callbacks only when Update() is pumped.
            while (true)
            {
                _manager.Update();
                await UniTask.Yield(PlayerLoopTiming.Update);
            }
        }

        public async UniTask<ExternalCredential> TrySilentAsync(CancellationToken ct)
        {
            string appleUser = _storage.GetString(KeyAppleUser);
            if (string.IsNullOrEmpty(appleUser)) return null;

            var stateTcs = new UniTaskCompletionSource<CredentialState>();
            _manager.GetCredentialState(appleUser, s => stateTcs.TrySetResult(s), _ => stateTcs.TrySetResult(CredentialState.NotFound));
            if (await stateTcs.Task.AttachExternalCancellation(ct) != CredentialState.Authorized) return null;

            var tcs = new UniTaskCompletionSource<ExternalCredential>();
            _manager.QuickLogin(new AppleAuthQuickLoginArgs(), c => tcs.TrySetResult(ToCredential(c)), _ => tcs.TrySetResult(null));
            return await tcs.Task.AttachExternalCancellation(ct);
        }

        public async UniTask<ExternalCredential> SignInInteractiveAsync(CancellationToken ct)
        {
            var tcs = new UniTaskCompletionSource<ExternalCredential>();
            _manager.LoginWithAppleId(new AppleAuthLoginArgs(LoginOptions.None), c => tcs.TrySetResult(ToCredential(c)), _ => tcs.TrySetResult(null));
            return await tcs.Task.AttachExternalCancellation(ct);
        }

        private static ExternalCredential ToCredential(ICredential credential)
        {
            if (!(credential is IAppleIDCredential apple) || apple.IdentityToken == null) return null;
            return new ExternalCredential
            {
                Provider = "APPLE",
                Token = Encoding.UTF8.GetString(apple.IdentityToken),
                ProviderUserId = apple.User,
            };
        }
    }
#endif

#if ONEMORETAP_GPGS && UNITY_ANDROID && !UNITY_EDITOR
    /// <summary>
    /// Google Play Games Services v2 (play-games-plugin-for-unity v11+). PGS v2 signs players in automatically at launch,
    /// so Authenticate() is genuinely silent; the server auth code is exchanged and verified on the backend.
    /// </summary>
    public sealed class PlayGamesIdentityProvider : IExternalIdentityProvider
    {
        public string ProviderName => "GOOGLE_PLAY_GAMES";
        public bool IsSupported => true;

        public PlayGamesIdentityProvider()
        {
            PlayGamesPlatform.Activate();
        }

        public UniTask<ExternalCredential> TrySilentAsync(CancellationToken ct) => AuthenticateAsync(false, ct);

        public UniTask<ExternalCredential> SignInInteractiveAsync(CancellationToken ct) => AuthenticateAsync(true, ct);

        private static async UniTask<ExternalCredential> AuthenticateAsync(bool interactive, CancellationToken ct)
        {
            var statusTcs = new UniTaskCompletionSource<SignInStatus>();
            if (interactive) PlayGamesPlatform.Instance.ManuallyAuthenticate(s => statusTcs.TrySetResult(s));
            else PlayGamesPlatform.Instance.Authenticate(s => statusTcs.TrySetResult(s));
            if (await statusTcs.Task.AttachExternalCancellation(ct) != SignInStatus.Success) return null;

            var codeTcs = new UniTaskCompletionSource<string>();
            PlayGamesPlatform.Instance.RequestServerSideAccess(false, code => codeTcs.TrySetResult(code));
            string authCode = await codeTcs.Task.AttachExternalCancellation(ct);
            if (string.IsNullOrEmpty(authCode)) return null;

            return new ExternalCredential
            {
                Provider = "GOOGLE_PLAY_GAMES",
                Token = authCode,
                ProviderUserId = PlayGamesPlatform.Instance.GetUserId(),
            };
        }
    }
#endif
}
