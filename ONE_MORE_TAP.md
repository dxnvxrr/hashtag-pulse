# One More Tap — production baseline

Unity 6 client (`Client/`), Fastify + Prisma + Redis backend (`Backend/`), and a playable web client (`Web/`)
that uses the same rules and the same server API.

## Play it

**Server-verified (full stack):**

```bash
cd Backend
cp .env.example .env          # set JWT_ACCESS_SECRET and DEVICE_FINGERPRINT_PEPPER
docker compose up --build     # API + Postgres + Redis; migrations run on start
open http://localhost:8080/play/
```

Without Docker: run Postgres and Redis locally, then `npm ci && npx prisma migrate deploy && npm run dev`
from `Backend/` and open `http://localhost:8080/play/`.

**Offline (no server):** `node Web/build-artifact.mjs` writes one self-contained HTML body to `Web/dist/`.
Opened anywhere without the backend, the game scores runs on the device and says so.

Controls: tap or click anywhere (or press Space) when the moving ring meets the inner circle. The SLOW-MO button
in the corner arms a ticket for the next ring. In Pulse, after your third miss you're offered one simulated
rewarded ad for an extra life. In development mode the server verifies it through `/v1/ads/dev-complete`.

## Tests

```bash
cd Backend && npm test
```

- Ring-schedule golden vectors (TypeScript ≡ C# ≡ web).
- Verdict windows, bot and reaction-floor flags, slow-mo, rewarded-ad resumes.
- Web client verdicts versus server re-simulation.
- Unity `RunSession` versus server re-simulation. Needs `mcs` and `mono`; the test is skipped when they're absent.

## Unity client

1. Open `Client/` with Unity 6. UniTask and VContainer resolve from git.
2. Set up the boot scene:
   - a `UIDocument` with elements named `splash`, `hint`, `verdict-word`, `verdict-delta`, `hud-ring` and `hud-lives`;
   - an `InputController`;
   - a `GameplayController` with two LineRenderers (`ring` and `target`), plus an optional burst ParticleSystem;
   - a `GameLifetimeScope` referencing all of them;
   - an orthographic camera centred on the gameplay object.
3. Addressables: label audio clips `audio`.

Optional SDKs compile only when their scripting define is set:

| Define | Requires | Enables |
|---|---|---|
| `ONEMORETAP_APPLE_AUTH` | `com.lupidan.apple-signin-unity` | Sign in with Apple linking (iOS) |
| `ONEMORETAP_GPGS` | Google Play Games plugin v11+ | Play Games linking (Android) |
| `ONEMORETAP_LEVELPLAY` | Unity LevelPlay | Real rewarded ads (otherwise a simulated provider + dev callback) |

## Protocol notes

- **Signing:** every game endpoint needs `Authorization: Bearer`, `X-Device-Fingerprint`, `X-Timestamp`
  (server-time ms), `X-Nonce` and
  `X-Signature = base64(HMAC-SHA256(sessionKey, METHOD\nPATH\nTIMESTAMP\nNONCE\nhex(SHA256(body))))`.
- **Runs are server-authoritative:** `/v1/runs/start` returns a seed. The client submits only tap times
  (µs after ring 0), the Slow-Mo ring indices, and any ad `resumes`. The server re-simulates the timeline, scores
  every ring, and quarantines runs that fail the bot, reaction-floor or clock-drift checks.
- **Timeline rule:** ring *i+1* spawns `gap` ms after ring *i* resolves (on a tap, or when its window expires). After
  a server-verified rewarded ad, it spawns at `max(normal spawn, resumeAt)`.
- **Slow-Mo** is a dedicated button, not the GDD's long-press. Taps fire on press-down, so every long-press would
  also have been a tap.
- **Offline runs** are practice only. They're never rewarded, because the server must issue the run seed.

## Background jobs (run inside the API, single-flight via a Redis lock)

- Unsubmitted runs expire after 1 hour.
- Accounts pending deletion are hard-deleted after 30 days. Audit rows are anonymised: user id and IP are cleared.
- A consumer group drains the telemetry streams into `telemetry_events`.
