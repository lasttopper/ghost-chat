# Publishing Ghost Chat on Google Play

The Play-Store-ready bundle is **`ghost-chat.aab`** — always download the latest from
the [GitHub Release](https://github.com/lasttopper/ghost-chat/releases/latest)
(asset `ghost-chat.aab`). Every CI build re-publishes it automatically.

> Play Console accepts **AAB only** for new apps. The APK is for direct sideloading
> (the "Get the Android app" button on the website serves it).

## Build facts (already compliant)

| Requirement | Status |
|---|---|
| Format | AAB ✓ |
| Target API | 36 (Android 16) — Play requires ≥35 ✓ |
| Min SDK | 21+ (TWA default) ✓ |
| Stable signing | ✔ one upload key for every build (`TWA_KEYSTORE_BASE64` secret) |
| Unique versionCode | ✔ CI auto-bumps from the workflow run number |
| 64-bit / native code | none (web app in TWA) ✓ |
| Permissions | notifications only (declared by TWA for message alerts) |

## Console setup (first time)

1. [Play Console](https://console.play.google.com) → **Create app**
   - Name: `Ghost Chat` · Default language: English · App · Free
2. **Testing → Create a track** (Internal testing is fastest) → upload `ghost-chat.aab`
   - First upload asks about **Play App Signing**: accept (recommended). Our keystore
     becomes the *upload key*; Google holds the signing key.
3. Complete the required forms (left sidebar checklist):
   - **Privacy policy URL** — required. A one-page policy is enough; you can host it
     at `ghost-chat-5gxc.onrender.com/privacy.html` (add the file to `public/`).
   - **App access** — choose "No account required": the app supports **guest mode**,
     reviewers can chat instantly without credentials.
   - **Ads** → No · **Content rating** → questionnaire (chat app: likely Teen)
   - **Data safety** — declare: usernames/messages (in-app, not sold, encrypted in
     transit), auth via Firebase (email if user chooses).
   - **Target audience** → 13+
4. **Store listing**:
   - Short description (≤80 chars): e.g. "Real-time group chat — public groups,
     private groups and DMs."
   - Icon 512×512 → reuse `public/icons/icon-512.png`
   - Feature graphic 1024×500 → `play-assets/feature-graphic.png`
   - ≥2 phone screenshots 16:9 or 9:16 (take from the running app)
5. Submit for review (internal track: no review needed to install via opt-in link).

## Updating the app later

1. Bump `appVersion` in `twa/twa-manifest.json` if you like (versionCode auto-bumps).
2. Actions → **Build Android APK** → the release assets update automatically.
3. Download the new `ghost-chat.aab` and upload to a new track release.

## Deep links (already wired)

Invite links on `https://ghost-chat-5gxc.onrender.com/?join=CODE` open the installed
app directly (verified App Links via `/.well-known/assetlinks.json`, fingerprint
matches the release signing key). Without the app installed they fall back to the
web app. Nothing extra to configure in Play Console.

## Offline behavior

The app shell + the last ~60 messages per conversation are cached locally, so the
app opens and shows saved conversations with no network (banner: "Offline —
showing saved messages"). Live data replaces the cache as soon as it reconnects.
