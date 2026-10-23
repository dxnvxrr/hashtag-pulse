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
- **Ranked:** 5 lives. Hits fill the golden circle around the target: PERFECT +2, CLEAN +1.5, SO CLOSE +1. A full
  circle permanently raises your Prestige by one level (1–100) and unlocks and equips that level's animated
  background; overflow carries into the next circle. Circles hold 10 points up to level 25, then 15, 20, and 25.
  On levels X1–X7 of every block of ten, a miss halves the circle (rounded up to the next half point; under 1 point
  drops to 0). On levels X8–X10 a miss empties it. Losing the 5th life opens one short ad popup per run; after it
  closes the player can refill all 5 lives or end the run.
- **Zen:** no lives, no stakes, no Prestige.

**Unlocks & Sound** (title screen): a scrollable menu of all 100 backgrounds plus the default. Tap an unlocked one to
equip it. The menu also holds separate Music and Sound FX sliders and the haptics toggle. Level 100, ZERO, stays
hidden until earned.

**Music:** procedural chiptune, one theme per block of ten backgrounds (Drift, Prism, … Nova) plus ZERO at 100. It
follows the equipped background, and higher blocks add more layers (hats, arpeggios, kick). During a run the streak
brings in the missing layers: hats at 5 in a row, arpeggio at 10, kick and a doubled lead at 20. A miss drops back to
the base layer straight away. See `Web/music.js`.

**Juice:** the background pulses and speeds up on hits, flashes gold on PERFECT and dims on a miss. Shake, particles,
shockwaves and the PERFECT chime's pitch all grow with the streak, which shows from 3 in a row.

**Ring types** (visual only; timing and scoring are unchanged and match the server): Prestige 10 adds Ghost (fades
out, then back in near the target), 20 adds Stutter (moves in steps), and 30 adds Eclipse (a decoy that touches the
target early, then opens up again). From ring 5, about 1 in 4 rings uses an unlocked type. A toast explains each one
the first time it appears.

**Daily streak** (Ranked runs; stored on the device): play every day to grow it. Every 7th day in a row earns an
Anchor (max 2). An Anchor covers one missed day. The title screen shows the last 7 days and whether today is done.

**Challenge links:** after a run, CHALLENGE A FRIEND shares a link (`#c-seed-base-block-hits-avgUs`). The link replays
your exact rings: same seed, speed and ring types, 5 lives, no Slow-Mo, no ad refill. More hits wins; equal hits go
to the lower average. Online, the challenge is a server-verified DUEL run. For an offline single-file build,
`node Web/build-artifact.mjs <out.html> <public page URL>` puts that URL in shared links.

**Slow-Mo** rings run at 0.4x and are scored in game time, so every verdict window is 2.5x wider in real time.
Slow-Mo rings never count toward your best tap or Precision rating, because tickets can be bought.

**Ads on the web:** set `WEB_AD_CLIENT=ca-pub-…` (an approved Google AdSense account with H5 Games Ads) and the
server adds the ad tag and the CSP hosts it needs. Without it the popup is a house ad and earns nothing. Web ads send
no server callback, so extra lives are claimed by client attestation (`WEB_ADS_CLIENT_ATTESTED=true`), still limited
by the server's cool-down and daily cap. In development the dev simulator is used instead.

## Load time

`Web/` is plain ES modules with no framework or build step: `core`, `store`, `api`, `progress`, `backgrounds`,
`music`, `game`. They're modulepreloaded and gzipped by the server (about 30 KB of JS over the wire). Fonts load
after the first frame and never block play. Measured cold, with no cache, on a throttled phone profile (1.6 Mbps,
150 ms RTT, 4x CPU slowdown): title interactive in about 0.7 s, first ring on screen about 2.1 s after tapping play.
The budget is 8 s.

## Tests

```bash
cd Backend && npm test
```

- Ring-schedule golden vectors (TypeScript ≡ C# ≡ web).
- Verdict windows, bot and reaction-floor flags, slow-mo in game time, rewarded-ad resumes.
- Prestige circles and rating: web client ≡ server.
- Daily streak and Anchors, challenge codes, ring types, music intensity.
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
- **Unity client:** still has the earlier Pulse/Gauntlet/Zen modes. It has no Prestige, backgrounds, ring types, streaks or challenges. The web build is
  the lead client for now. The server keeps the older modes so the Unity build still works.

## Background jobs (run inside the API, single-flight via a Redis lock)

- Unsubmitted runs expire after 1 hour.
- Accounts pending deletion are hard-deleted after 30 days. Audit rows are anonymised: user id and IP are cleared.
- A consumer group drains the telemetry streams into `telemetry_events`.
