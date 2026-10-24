# One More Tap: from this repo to the App Store and Google Play

The app is the web game (`Web/`) inside a native shell (Capacitor, `App/`), talking to the backend (`Backend/`).
The Unity project in `Client/` is not part of this launch: it lacks most features (see ONE_MORE_TAP.md).

Do the steps in order. Anything in `code` is typed in a terminal from the repo folder.

## 0. Accounts and money you need

| What | Cost | Notes |
|---|---|---|
| Apple Developer Program | $99/year | Enrol as an organisation (needs a D-U-N-S number) if you want a company name on the store; an individual account shows your personal name. Approval can take days. |
| Google Play Console | $25 once | New personal accounts must run a closed test with at least 12 testers for 14 days before they can publish. Organisation accounts are exempt. |
| A Mac with Xcode | – | Required to build and upload the iOS app. |
| A domain (e.g. onemoretap.game) | ~$10–60/year | Hosts the API, the web game, the privacy policy and challenge links. |
| Hosting (Render blueprint in `render.yaml`) | roughly $20–30/month to start | Web service + Postgres + Redis. Check current prices. |
| Google AdMob account | free | Ads in the app. Payouts need tax and bank details. |

## 1. Decide the two names you can never change

- **Bundle / package ID**, e.g. `com.yourcompany.onemoretap`. Permanent once published.
- **Domain**, e.g. `onemoretap.game`.

Put both into `App/app.config.json` (`appId`, `apiUrl`, `shareUrl`, `privacyUrl`, `linkDomain`) and `appId` into
`App/capacitor.config.json`.

## 2. Put the backend online

1. Push this repo to GitHub (it is already there).
2. Render → New → Blueprint → select the repo. It reads `render.yaml` and creates the server, Postgres and Redis.
3. Fill in when asked: `PUBLISHER_NAME` (you or your company), `CONTACT_EMAIL` (privacy requests), and after steps
   4–5: `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID`, `GOOGLE_PLAY_PACKAGE_NAME`, `ANDROID_CERT_SHA256`.
4. Add your domain to the web service (Render → Settings → Custom Domains) and point your DNS at it.
5. Check: `https://<domain>/v1/time` returns a time, `https://<domain>/play/` runs the game,
   `https://<domain>/privacy` shows your name and email.

Migrations run automatically on each deploy. Prizes stay off (`PRIZES_ENABLED=false`).

## 3. AdMob

1. Create two apps in AdMob (iOS and Android), each with one **Rewarded** ad unit.
2. For each rewarded unit: Server-side verification → callback URL `https://<domain>/v1/ads/ssv/admob`. AdMob sends
   a test call; the server answers it.
3. Put the app IDs and ad unit IDs into `App/app.config.json`. Keep `"testing": true` for TestFlight and internal
   testing; set it to `false` only for the store build. (Clicking your own live ads can get the account banned.)
4. Fill AdMob's privacy & messaging: a GDPR consent message (the app shows it automatically in the EEA/UK) and,
   for iOS, an IDFA explainer.

## 4. Build the apps

On your Mac (Node 22+, Xcode 16+), in `App/`:

```bash
npm ci
npm run sync          # copies Web/ into the app with your settings, updates iOS and Android
npm run configure     # writes AdMob ids, tracking text, universal links and portrait lock into both projects
npm run ios           # opens Xcode
```

In Xcode: select the App target → Signing & Capabilities → choose your team (Xcode registers the bundle ID).
**Associated Domains** is already in the entitlements file; enable it if Xcode asks. Then Product → Archive →
Distribute → App Store Connect. Your Team ID (Membership page) goes into `APPLE_TEAM_ID` on Render.

Android: `npm run android` opens Android Studio → Build → Generate Signed Bundle (AAB). Use Play App Signing; copy
the **app signing key** SHA-256 from Play Console (Setup → App signing) into `ANDROID_CERT_SHA256` on Render.

Icons and the launch screen are already generated from `App/assets/` (re-run
`npx @capacitor/assets generate` after changing them).

## 5. Store listings: what to answer

**App Store Connect → App Privacy** (matches what the code collects; see `/privacy`):
- Identifiers: Device ID (for app functionality, and for third-party advertising through AdMob), not linked to
  identity, used for tracking only if the player allows it.
- Usage data: Product interaction (gameplay); Advertising data (AdMob).
- Diagnostics: Performance data.
- Other: gameplay content (scores, leaderboard name).
- No contact info, location, contacts, photos or financial data while prizes are off.

**Age rating:** no violence, no gambling, no user-generated content (names are generated). Expect 4+ (Apple) and
Everyone (Google). If you later switch on prizes, answer "Contests: Yes" and update the rating.

**Google Play → Data safety:** same data as above; "data is encrypted in transit: yes"; "users can request
deletion: yes" (in-app Delete my data, and the email on `/privacy`). Ads: yes. Target audience: 13+ is simplest
(avoids the Families policy); the game already handles under-13s safely if you choose "all ages" later.

**Review notes (Apple):** "Guest accounts are created automatically; no login needed. Rewarded ads appear only
when the player taps 'Watch ad' after losing all 5 lives. Account deletion: Unlocks & Sound → Delete my data."

**Screenshots:** 6.9" iPhone and 13" iPad (portrait), Android phone. Take them from the simulator or device.

## 6. Before you press publish

- [ ] `App/app.config.json`: real IDs, `"testing": false`.
- [ ] `https://<domain>/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` return JSON.
- [ ] A challenge link opened on a phone with the app installed opens the app (not the browser).
- [ ] Watch one real rewarded ad on TestFlight with **test** ads: lives refill (proves the SSV callback works).
- [ ] Delete my data works and the leaderboard entry disappears.
- [ ] `PRIZES_ENABLED` is still `false` unless a lawyer has approved the rules (then see ONE_MORE_TAP.md).

## What this build does not do yet

- **Push from the server.** Streak reminders are local notifications scheduled by the app (no push service
  needed). Server push (rivals, challenges) needs APNs/FCM setup.
- **In-app purchases.** None in this build (ads are the one revenue channel). Selling anything digital in the app
  requires Apple/Google billing.
- **Sign in with Apple / Google.** Progress is tied to the device; a player who deletes the app and has no backup
  loses it. Linking exists on the server (`/v1/auth/link`) but not in the web client yet.
- **Device attestation** (App Attest / Play Integrity) for anti-cheat. Server-side re-simulation still checks every run.
