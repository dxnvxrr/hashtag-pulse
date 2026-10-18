using System;

// DTOs for JsonUtility: public fields, [Serializable], no properties/dictionaries.
// Field names mirror the backend's JSON exactly.
namespace OneMoreTap.Security
{
    [Serializable]
    public sealed class ApiErrorBody
    {
        public string error;
        public string message;
    }

    [Serializable]
    public sealed class EmptyBody
    {
    }

    [Serializable]
    public sealed class ServerTimeResponse
    {
        public long serverTimeMs;
    }

    [Serializable]
    public sealed class GuestLoginRequest
    {
        public string deviceFingerprint;
        public string platform;
        public string model;
        public bool isMinor;
    }

    [Serializable]
    public sealed class RefreshRequest
    {
        public string refreshToken;
        public string deviceFingerprint;
    }

    [Serializable]
    public class SessionResponse
    {
        public string userId;
        public string accessToken;
        public string refreshToken;
        public int expiresInSec;
        public string sessionId;
        public string sessionKey;
        public long serverTimeMs;
    }

    [Serializable]
    public sealed class GuestLoginResponse : SessionResponse
    {
        public bool created;
    }

    [Serializable]
    public sealed class LinkAppleRequest
    {
        public string provider = "APPLE";
        public string identityToken;
    }

    [Serializable]
    public sealed class LinkGooglePlayRequest
    {
        public string provider = "GOOGLE_PLAY_GAMES";
        public string serverAuthCode;
    }

    [Serializable]
    public sealed class LinkResponse
    {
        public bool merged;
        // JsonUtility leaves this non-null with empty fields when the server sends null; check accessToken.
        public SessionResponse tokens;
    }

    [Serializable]
    public sealed class WalletView
    {
        public string ticks;
        public string cores;
        public int slowMoTickets;
        public int anchors;
        public int version;
    }

    [Serializable]
    public sealed class IapValidateRequest
    {
        public string productId;
        public string receipt;
    }

    [Serializable]
    public sealed class IapValidateResponse
    {
        public bool granted;
        public bool alreadyProcessed;
        public string productId;
        public WalletView wallet;
    }

    [Serializable]
    public sealed class AdIntentRequest
    {
        public string placement;
        public string runId;
    }

    [Serializable]
    public sealed class AdIntentResponse
    {
        public string grantId;
        public string expiresAt;
    }

    [Serializable]
    public sealed class AdGrantStatusResponse
    {
        public string grantId;
        public string status;
        public string placement;
    }

    [Serializable]
    public sealed class RunStartRequest
    {
        public string mode;
    }

    [Serializable]
    public sealed class VerdictWindows
    {
        public int perfect;
        public int clean;
        public int close;
        public int ftueClose;
    }

    [Serializable]
    public sealed class RunStartResponse
    {
        public string runId;
        public long seed;
        public string mode;
        public int baseDurationMs;
        public bool ftue;
        public int maxRings;
        public int maxMisses;
        public long ring0ServerTimeMs;
        public long serverTimeMs;
        public VerdictWindows verdictWindowsMs;
    }

    [Serializable]
    public sealed class RunSubmitRequest
    {
        public string runId;
        public long[] tapsUs;
        public int[] slowMoRings;
    }

    [Serializable]
    public sealed class RunSubmitResponse
    {
        public string runId;
        public string status;
        public string[] verdicts;
        public long[] deltasUs;
        public int ticksAwarded;
        public long newBestDeltaUs;
        public bool personalBest;
        public int precisionRating;
        public WalletView wallet;
        public string reason;
    }

    [Serializable]
    public sealed class AgeGateRequest
    {
        public bool isMinor;
    }
}
