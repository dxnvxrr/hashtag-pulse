# One More Tap — production baseline

Fastify + Prisma + Redis backend (`Backend/`), the web client (`Web/`), and the iOS/Android app (`App/`): the
web client in a Capacitor shell. **To ship to the App Store and Google Play, follow `STORE_LAUNCH.md`.** The Unity
client (`Client/`) is legacy: it predates Prestige, leaderboards, streaks and challenges and is not the shipping app.

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

**Lifetime stats** (title screen and Ranked results): total PERFECT, CLEAN and CLOSE verdicts from Ranked runs.
Online they come from the server and count only server-verified runs. Offline they count on the device only
(labelled THIS DEVICE) and never merge into the server totals. Slow-Mo rings never count, because tickets can be
bought.

**Daily streak** (Ranked runs): play every day to grow it. Every 7th day in a row earns an Anchor (max 2). An
Anchor covers one missed day. Online, the server keeps the streak from verified Ranked runs and counts days in the
player's time zone. Offline it lives on the device. The title screen shows the last 7 days.

**Challenge links:** after a run, CHALLENGE A FRIEND shares a link (`#c-seed-base-block-hits-avgUs[-runId]`). The
link replays your exact rings: same seed, speed and ring types, 5 lives, no Slow-Mo, no ad refill. More hits wins;
equal hits go to the lower average. Online, the link carries the verified run id: the server checks the replay
matches and supplies the challenger's real score (the numbers in a link can be edited), and the challenger sees
the result on their title screen. Links without a run id (offline runs) still play as plain challenges. For an
offline single-file build, `node Web/build-artifact.mjs <out.html> <public page URL>` puts that URL in shared links.

**Leaderboards** (title screen → LEADERBOARDS): Season (this calendar month, UTC), Lifetime, Prestige and Precision,
each for Global or one region: North America, South America, Europe, Africa, Middle East, Asia, Oceania. Points are
PERFECT 2, CLEAN 1.5, SO CLOSE 1 from verified Ranked runs; Slow-Mo rings never count; tied scores share a rank.
- Names are generated ("Swift Comet 4821") and rerolled, never typed, so boards need no moderation and show no
  personal data.
- The region is guessed from the device time zone (nothing is looked up) and can be corrected once straight away;
  after that it can change once a week, so nobody hops to a quieter board.
- Boards are Redis sorted sets rebuilt from Postgres when Redis has none and every 6 hours
  (`npm run season -- boards-rebuild` forces it).
- In the published single-file build (claude.ai artifact) there is no server: the page uses the artifact's shared
  storage as a test board. Each tester's device reports its own scores, so the page labels them unverified.

**Age gate:** after the first run, online players are asked their birth year once (neutral, no hints). Under-13s
are minors (COPPA): no personalised ads, minimal telemetry. 18+ is recorded for prize eligibility (verified again
with ID before any payout). Until answered, ads are requested non-personalised.

**Slow-Mo** rings run at 0.4x and are scored in game time, so every verdict window is 2.5x wider in real time.
Slow-Mo rings never count toward your best tap or Precision rating, because tickets can be bought.

**Ads:** one rewarded ad, offered when the 5th life is lost, once per run. Always opt-in: the player taps WATCH AD
or END RUN (ad networks only allow rewards for ads the player chooses to watch). In the app it's AdMob; Google calls
`/v1/ads/ssv/admob` (signature-verified) and only then does the server grant the refill. On the web, set
`WEB_AD_CLIENT=ca-pub-…` (approved AdSense with H5 Games Ads) for rewarded placements; web rewards are client-attested
(`WEB_ADS_CLIENT_ATTESTED=true`), still limited by the server's cool-down and daily cap. Ads are non-personalised until
the age gate says 13+.

**The app (`App/`):** `build-www.mjs` copies `Web/` and writes the API URL, share URL, privacy URL and AdMob units
(from `app.config.json`) into the page; `configure-native.mjs` writes the store settings into the iOS/Android
projects. In the app, `Web/native.js` adds native haptics, the share sheet, streak reminders (local notifications
at the player's usual hour), challenge links that open the app, the Android back button, and a native copy of saved
data (iOS can clear web storage, and the refresh token there is the player's account). In a browser it does nothing.

**Privacy & deletion:** `/privacy` serves the policy (publisher and contact from `PUBLISHER_NAME` and
`CONTACT_EMAIL`, required in production). Unlocks & Sound → Delete my data deletes the account (off the leaderboards
at once, erased within 30 days) and everything stored on the device.

## Load time

`Web/` is plain ES modules with no framework or build step: `core`, `store`, `native`, `api`, `progress`, `backgrounds`,
`music`, `social`, `board`, `game`. They're modulepreloaded and gzipped by the server (about 40 KB of JS over the
wire). Fonts load after the first frame and never block play. Measured cold, with no cache, on a throttled phone
profile (1.6 Mbps, 150 ms RTT, 4x CPU slowdown): title interactive in about 0.9 s, first ring on screen about 2.2 s
after tapping play.
The budget is 8 s.

## Tests

```bash
cd Backend && npm test
```

- Ring-schedule golden vectors (TypeScript ≡ C# ≡ web).
- Verdict windows, bot and reaction-floor flags, slow-mo in game time, rewarded-ad resumes.
- Prestige circles and rating: web client ≡ server.
- Daily streak and Anchors (web ≡ server, including time-zone changes), challenge codes, ring types, music intensity.
- Prize pool split: proportional, cap, minimum, ties, rounding to the cent.
- Regions from time zones, generated names (web ≡ server), age-gate flags, challenge scoring.
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
- **Unity client:** still has the earlier Pulse/Gauntlet/Zen modes. It has no Prestige, backgrounds, ring types,
  streaks, challenges, leaderboards or prizes. Its age gate still sends minor/adult only, so Unity players are never
  marked 18+ (no prize eligibility) until it asks for a birth year. The web build is
  the lead client for now. The server keeps the older modes so the Unity build still works.

## Monthly skill-prize seasons (Option B: cash prizes, no token)

Off by default (`PRIZES_ENABLED=false`). Each calendar month is a season. After it ends, the operator puts a share of
that month's ad revenue into a pool and splits it by season points:
- **Proportional, with a cap and a minimum.** Each winner gets pool × their points / winners' points. Nobody gets
  more than the cap (default 5% of the pool); shares under the minimum payout (default $5) aren't paid, and that
  money goes to the other winners. Tied players are always treated alike. Unit-tested in `test/prizes.test.ts`.
- **Eligible:** 18+ (self-declared at the age gate, then verified with ID), not a minor, account active, at least
  10 verified Ranked runs in the month, and no quarantined or rejected Ranked run that month (manual review).
- **Paid only after verification:** identity, age and country (`PRIZE_COUNTRIES`), one payout per real person per
  season. Unverified prizes expire after 90 days. Forfeited, expired and unallocated money rolls into the next pool.
- **Fixed once awarded:** database triggers refuse changes to a season, or to who won, their rank or amount.

```bash
cd Backend && npm run build
npm run season -- preview 2026-10 50000          # $500 pool: DRAFT snapshot + the split, for review
npm run season -- review  2026-10                # top earners: devices, account age, PERFECT share, avg delta
npm run season -- award   2026-10 50000          # freeze and write the payouts (same terms as the preview)
npm run season -- verify  <payoutId> <identityRef> <country> <age> pass|fail   # from the identity provider
npm run season -- export  2026-10 > payouts.csv  # VERIFIED payouts for the payout provider's batch upload
npm run season -- paid    <batchId> <payoutId>...
npm run season -- rollover 2026-10               # cents to add to the next pool
```

Before switching it on: official rules reviewed by a lawyer (`PRIZE_RULES_URL`), an identity-verification provider
wired to `verifyPayout()` (`PRIZE_VERIFY_URL` is its hosted flow), and a payout provider account.

## Airdrop snapshot rails (future; nothing is distributed today)

`player_stats` holds the lifetime totals shown to players. Snapshots never read it: they recompute from the `runs`
ledger, so a run quarantined later loses its credit.

```bash
cd Backend && npm run build
npm run airdrop -- snapshot genesis 2027-01-01T00:00:00Z 10        # label, cutoff, min verified Ranked runs
npm run airdrop -- show genesis                                     # totals and exclusion counts
npm run airdrop -- finalize genesis                                 # freezes it and records the SHA-256 digest
npm run airdrop -- export genesis > genesis.csv                     # user_id,points (digest = sha256 of the rows)
```

- **Points:** PERFECT 4, CLEAN 3, CLOSE 2 by default (the Prestige ratio). They're configurable per snapshot.
- **Excluded, with the reason recorded:** minors, players not 18+ at the age gate (or who never answered), pending
  deletion, non-active accounts, any quarantined or rejected Ranked run before the cutoff (manual review), and fewer
  than the minimum verified runs.
- **Frozen:** database triggers refuse any change to a FINAL snapshot and any update to an entry. Account erasure
  still cascades, so GDPR/CCPA deletion keeps working.
- **No HTTP endpoint, no wallet addresses, no token logic.** Those need legal sign-off first (see the PR/notes).

## Background jobs (run inside the API, single-flight via a Redis lock)

- Unsubmitted runs expire after 1 hour.
- Accounts pending deletion are hard-deleted after 30 days. Audit rows are anonymised: user id and IP are cleared.
- A consumer group drains the telemetry streams into `telemetry_events`.
