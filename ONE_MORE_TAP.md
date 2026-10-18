# One More Tap — production baseline

Unity 6 client (`Client/`) and Fastify + Prisma + Redis backend (`Backend/`) for the One More Tap GDD.

## Run the backend

```bash
cd Backend
cp .env.example .env          # fill in secrets
docker compose up --build     # API on :8080, Postgres, Redis; migrations run on start
# or locally:
npm ci && npx prisma migrate deploy && npm run dev
npm test                      # anti-cheat + ring-schedule golden vectors
```

## Open the client

1. Open `Client/` with Unity 6. Package Manager resolves `Packages/manifest.json` (UniTask and VContainer come from git).
2. In the boot scene: add a `UIDocument` (with elements named `splash` and `hint`), a GameObject with
   `InputController`, and a GameObject with `GameLifetimeScope`; assign both references and set the API base URL.
3. Addressables: mark audio clips with the label `audio`.

Optional platform SDKs, each compiled only when its scripting define is set (Player Settings → Scripting Define Symbols):

| Define | Requires | Enables |
|---|---|---|
| `ONEMORETAP_APPLE_AUTH` | `com.lupidan.apple-signin-unity` | Sign in with Apple linking (iOS) |
| `ONEMORETAP_GPGS` | Google Play Games plugin v11+ | Play Games linking (Android) |
| `ONEMORETAP_LEVELPLAY` | Unity LevelPlay | Real rewarded ads (otherwise a simulated provider + dev callback) |

## Request signing contract

Every game endpoint requires `Authorization: Bearer`, `X-Device-Fingerprint`, `X-Timestamp` (server-time ms),
`X-Nonce`, and `X-Signature = base64(HMAC-SHA256(sessionKey, METHOD\nPATH\nTIMESTAMP\nNONCE\nhex(SHA256(body))))`.
The session key is issued at login/refresh and rotates with it.

## Server-authoritative runs

`POST /v1/runs/start` returns a seed; client and server generate identical ring schedules
(`Client/Assets/Scripts/Core/RingSchedule.cs` ≡ `Backend/src/services/ringSchedule.ts`, pinned by golden vectors in
`Backend/test/antiCheat.test.ts`). The client submits only tap times; the server re-simulates, computes verdicts,
rewards, and rating, and quarantines runs that fail bot / reaction-floor / clock-drift checks.
