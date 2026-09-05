# Ghost Chat on GitHub — what's actually possible

**Short answer: you cannot host the whole app on GitHub.** GitHub Pages is a
*static file* host — no Node.js, no long-running processes, no WebSockets.
GitHub Actions `.yml` workflows are ephemeral CI runners: they can run your
tests or deploy your files, but they don't accept incoming connections and
die when the job ends.

What GitHub *is* great for with this app — and what this repo now ships:

```
┌─────────────────────┐         wss://         ┌──────────────────────┐
│  GitHub Pages (.yml) │ ─────────────────────▶ │  Backend (anywhere)  │
│  UI: html/js/css     │   WebSocket, no CORS   │  Render / Railway /  │
│  free, global CDN    │   preflight needed     │  VPS / Termux tunnel │
└─────────────────────┘                        └──────────────────────┘

  GitHub Actions (.yml): full test suite (98 assertions) on every push
```

## 1. CI — `.github/workflows/ci.yml`

Every push/PR: installs deps, starts the Firebase Auth emulator, waits for
port 9099, runs `npm test` (standalone + Vercel handler + digest + Firebase
suites). This is the best use of yml on GitHub for this project.

## 2. Frontend on Pages — `.github/workflows/pages.yml`

Publishes `public/` to GitHub Pages (free, HTTPS, CDN). Because Pages can't
run the server, the UI must point at a backend you host elsewhere:

1. Deploy the backend (e.g. Render blueprint or Railway — see the other
   DEPLOY docs) → note its URL.
2. Repo → Settings → Secrets and variables → Actions → **Variables** →
   add `BACKEND_URL` = `https://your-backend.example`
3. Enable Pages (Settings → Pages → Source: **GitHub Actions**).
4. Push to `main` → the workflow injects `BACKEND_URL` into
   `public/backend-config.js` and deploys. UI lands on
   `https://<user>.github.io/<repo>/`.

### Why the split works without CORS pain

- The client only talks to the backend over **WebSocket**, and browsers do
  not apply CORS preflight to the WS handshake — the connection just works
  cross-origin (the server sends your `Origin` header; we don't restrict it).
- Pages is HTTPS, so the backend must be too (`wss://`). Render/Railway
  domains and cloudflared tunnels all are. **Don't** point an https Pages
  frontend at a plain `http://` LAN address — browsers block mixed content.

### Same-origin alternative

If you skip Pages and deploy the app normally (Render/Railway/VPS/Termux),
the server serves the UI itself and `backend-config.js` stays `''` —
nothing to configure. The split setup is only worth it if you specifically
want the UI on GitHub's CDN or want frontend and backend to version
separately.

## Recap: which yml does what

| File | Purpose | Runs the app? |
|---|---|---|
| `.github/workflows/ci.yml` | Tests on every push | No — verifies it |
| `.github/workflows/pages.yml` | Publishes the UI to Pages | Frontend only |
| `render.yaml` | Render blueprint | ✅ backend + UI |
| `railway.json` | Railway config | ✅ backend + UI |
| `vercel.json` | Vercel routing | ✅ (beta WS) |
| `firebase.json` | Auth emulator (dev) | Auth only |
