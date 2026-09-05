# Ghost Chat APK (Android) + Notifications

The APK is a **Trusted Web Activity (TWA)** built with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) — a thin
Android wrapper that runs your GitHub Pages frontend inside real Chrome.
That's what makes **notifications work natively in the APK**: the Web
Notifications API runs in Chrome, and `enableNotifications: true` in
`twa/twa-manifest.json` turns on notification delegation.

```
GitHub Pages (frontend)  ──wss──▶  Render (backend)
        ▲
        │ wrapped by
   TWA APK (Bubblewrap, built by .github/workflows/apk.yml)
```

## Notifications — what works when

| Situation | Notifications |
|---|---|
| App open, you're in another conversation or tab is in background | ✅ system notification (`🔔` button in the bottom-left card must be on) |
| App open, looking at that conversation | silenced (by design) |
| App fully closed / phone asleep | ❌ not yet — needs Web Push (server-side VAPID wiring). The service worker's `push` handler is already in place; say the word and I'll wire the server side |

## Build the APK

1. Frontend must be live on Pages (see `DEPLOY-GITHUB.md`) — the TWA loads
   it at runtime.
2. Actions tab → **Build Android APK** → Run workflow (or push a `v*` tag).
3. Download `ghost-chat-apk` from the run's artifacts →
   `app-release-signed.apk` → sideload (`Allow install from unknown sources`).

The runner (ubuntu-latest) has JDK + Android SDK preinstalled; the workflow
points Bubblewrap at them, generates/uses a keystore, and runs
`bubblewrap update && bubblewrap build` with `BUBBLEWRAP_KEYSTORE_PASSWORD`
/ `BUBBLEWRAP_KEY_PASSWORD` (Bubblewrap's documented CI mode).

### Stable signing (recommended before sharing the APK)

The default build generates a throwaway keystore per run — fine for testing,
but a new key means users must uninstall before installing a newer build.
For stable updates:

```bash
keytool -genkeypair -v -keystore android.keystore -alias android \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Ghost Chat"
base64 -w0 android.keystore   # → GitHub secret TWA_KEYSTORE_BASE64
```

Also add secrets `TWA_KEYSTORE_PASSWORD` / `TWA_KEY_PASSWORD`. **Back the
keystore up** — losing it means no updates for installed users.

### Fullscreen (no browser bar) — Digital Asset Links

Until the site verifies your APK's key, the TWA shows a small address bar.
To remove it:

1. With your stable keystore: `bubblewrap fingerprint generateAssetLinks`
   (inside `twa/`) → produces `assetlinks.json`.
2. Commit it to `public/.well-known/assetlinks.json` and redeploy Pages.
3. Rebuild the APK. Chrome verifies the key ↔ domain link → fullscreen.

## Why TWA and not a WebView wrapper (Capacitor etc.)

- Real Chrome engine → Web Notifications, storage, and future Web Push work
  exactly like the website; no per-feature native plugins.
- The APK stays ~1–2 MB and auto-follows your Pages deploys — update the
  site, the "app" is updated. (Rebuilding the APK is only needed for icon/
  name/version changes.)
- Requires the frontend to be online — which it is (Pages + Render).

## Honest status

- The workflow follows Bubblewrap's documented CI flags and the
  twa-manifest schema from its README, and every input file here is
  syntax-validated — but the first real `bubblewrap build` happens on
  GitHub's runner, so treat run #1 as the smoke test.
- The sandbox where this was built has no Android SDK, so the APK itself
  was not compiled here.
