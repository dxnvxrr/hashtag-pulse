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
in the corner arms a ticket for the next ring.

**Modes (web):**
- **Ranked:** 5 lives. Each hit in a row fills the golden circle around the target; a full circle raises your
  Prestige by one level (1–100) and unlocks and equips that level's animated background. A miss empties the circle.
  Circles take 10 hits in a row up to level 25, then 15, 20, and 25 for levels 76–100. Losing the 5th life opens one
  short ad popup per run; after it closes the player can take +1 life or end the run.
- **Zen:** no lives, no stakes, no Prestige.

**Unlocks & Sound** (title screen): a scrollable menu of all 100 backgrounds plus the default. Tap an unlocked one to
equip it. The menu also holds the volume slider and the haptics toggle. Level 100, ZERO, stays hidden until earned.

**Slow-Mo** rings run at 0.4x and are scored in game time, so every verdict window is 2.5x wider in real time.
Slow-Mo rings never count toward your best tap or Precision rating, because tickets can be bought.

**Ads on the web:** set `WEB_AD_CLIENT=ca-pub-…` (an approved Google AdSense account with H5 Games Ads) and the
server adds the ad tag and the CSP hosts it needs. Without it the popup is a house ad and earns nothing. Web ads send
no server callback, so extra lives are claimed by client attestation (`WEB_ADS_CLIENT_ATTESTED=true`), still limited
by the server's cool-down and daily cap. In development the dev simulator is used instead.

## Tests

```bash
cd Backend && npm test
```

- Ring-schedule golden vectors (TypeScript ≡ C# ≡ web).
- Verdict windows, bot and reaction-floor flags, slow-mo in game time, rewarded-ad resumes.
- Prestige circles and rating: web client ≡ server.
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
- **Unity client:** still has the earlier Pulse/Gauntlet/Zen modes and no Prestige or backgrounds. The web build is
  the lead client for now. The server keeps the older modes so the Unity build still works.

## Background jobs (run inside the API, single-flight via a Redis lock)

- Unsubmitted runs expire after 1 hour.
- Accounts pending deletion are hard-deleted after 30 days. Audit rows are anonymised: user id and IP are cleared.
- A consumer group drains the telemetry streams into `telemetry_events`.
