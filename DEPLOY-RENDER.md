# Deploying Ghost Chat on Render

Render runs Ghost Chat as a **persistent Web Service** — no code changes needed,
WebSockets work natively, and there's no connection-duration cap like Vercel's
beta. Two paths: the free tier (demo-grade) or Starter + disk (recommended).

## Path A — Blueprint (recommended: Starter + persistent disk)

The repo ships a `render.yaml` blueprint: Node 20, `npm install` /
`node server.js`, `/healthz` health check, and a **1 GB disk mounted at
`/var/data`** with `GHOST_DATA=/var/data/data.json` so chat history survives
deploys and restarts.

1. Push this folder to a GitHub repo.
2. render.com → **New → Blueprint** → connect the repo → Apply.
3. Done: you get `https://pulse-chat.onrender.com` with HTTPS + WSS.

Cost: ~$7/mo instance + $0.25/GB disk. Note: attaching a disk means deploys
briefly restart the single instance (disks can't be shared across instances —
which matches this app's single-process design anyway).

## Path B — Free tier (demo-grade)

render.com → **New → Web Service** → connect the repo, then:

- Runtime: **Node**
- Build command: `npm install`
- Start command: `node server.js`
- Instance type: **Free**
- (No disk — free instances can't attach one.)

Know the trade-offs before you share the link:

- **Spin-down**: free services sleep after ~15 min idle; the next visitor eats
  a ~30–60 s cold start. Sleeping kills open WebSocket connections — the Ghost Chat
  client auto-reconnects with backoff and the server's presence grace window
  suppresses "went offline" flapping, so recovery is automatic, just slow.
- **Ephemeral history**: without a disk, `data.json` resets whenever the
  instance restarts. Fine for demos; upgrade when it isn't.
- **Quota**: 750 instance-hours/month per workspace, 0.1 CPU / 512 MB RAM.

To switch the blueprint to free: set `plan: free`, delete the `disk:` block
and the `GHOST_DATA` env var.

## Custom domain

Service → Settings → Custom Domains → add `chat.yourdomain.com` → point a
CNAME at `<service>.onrender.com` (any DNS provider works — DNSExit, Cloudflare,
whatever). TLS is automatic. The client already upgrades to `wss://` on https.

## Verify a deploy

```bash
curl https://pulse-chat.onrender.com/healthz     # -> {"ok":true}
npm test                                          # 35 assertions locally
```

## Why Render suits this app

- Persistent process → true WebSockets, no 5-minute caps, no per-instance
  pinning; one process means everyone is always in sync.
- Disk → the existing `GHOST_DATA` file persistence works verbatim (same code
  path the e2e suite tests).
- Single instance with a disk is exactly the topology Ghost Chat is designed for.
