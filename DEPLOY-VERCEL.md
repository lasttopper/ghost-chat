# Deploying Pulse on Vercel

**Short answer: yes.** Vercel added native WebSocket support (public beta, all
plans) for Functions running on Fluid compute, and `ws` works with no extra
configuration. This repo is set up for it — same frontend, same protocol,
entry point at `api/ws.js`.

## Requirements

- A Vercel account. New projects have Fluid compute on by default (required
  for WebSockets).
- Node.js 20+ runtime (repo default).
- Optional: a free Upstash Redis database for persistence (recommended).

## Deploy

**Via GitHub (easiest):**
1. Push this folder to a GitHub repo.
2. vercel.com → Add New → Project → import the repo.
3. Framework preset: **Other**. No build command needed. Deploy.

**Via CLI:**
```bash
npm i -g vercel
cd messaging-app
vercel --prod
```

The client auto-detects `*.vercel.app` hosts and connects to `/api/ws`
(standalone deploys keep using `/ws`).

## Add persistence (recommended)

Without it, state is in-memory: channels/messages reset when the function
cold-starts (after idle scale-down or a redeploy).

1. Create a free database at upstash.com → Redis → copy the **REST** URL and token.
2. In Vercel: Project → Settings → Environment Variables, add:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Redeploy. State now survives cold starts, and each joining client triggers
   a fresh read so multi-instance setups converge on reconnect.

## Caveats (read these)

- **Connection duration cap**: WebSocket connections follow function limits —
  ~5 min on Hobby (30 min max on Pro/Enterprise, beta). The client
  auto-reconnects and re-syncs automatically, and the server suppresses
  presence flapping with a 4s grace window, so users just see a brief
  "reconnecting…" banner every few minutes on Hobby.
- **No cross-instance fan-out**: each connection is pinned to one function
  instance. At low traffic Fluid compute keeps one warm instance, so everyone
  shares it and real-time works normally. Under heavy concurrent load, Vercel
  may scale out and users on different instances won't see each other's
  messages live (they converge on reconnect). For production scale, use a
  dedicated WebSocket host (Render/Railway/Fly) or a provider like
  Ably/Pusher.
- **Beta**: Vercel's WebSocket support is in public beta — expect occasional
  changes.
- The deploy itself has not been run from this workspace (no Vercel account
  here); the function handler logic is verified locally by
  `node test/vercel-e2e.js`.
