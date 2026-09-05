# Deploying Ghost Chat on Railway

Railway runs persistent services (like Render, unlike Vercel's functions),
so WebSockets work natively with no connection caps and no code changes.
The repo ships a `railway.json` (start command, `/healthz` health check,
restart policy) — Nixpacks auto-detects Node from `package.json`.

## Deploy

1. Push the folder to GitHub.
2. railway.com → **New Project → Deploy from GitHub repo** → pick it.
3. It builds and starts automatically; you get a public HTTPS domain
   (`…up.railway.app`) with WSS working out of the box.

`PORT` is provided by Railway and already read by `server.js`. Nothing else
to configure.

## Persistence (recommended)

Railway's filesystem is ephemeral by default. To keep chat history:

1. Service → right-click / settings → **Attach a volume**, mount path `/data`.
2. Add variable: `PULSE_DATA=/data/data.json`.
3. Redeploy. (`REPORT_DIR=/data/reports` also works if you want the midnight
   digest files preserved.)

## Telegram digest

Add the env vars and the midnight scheduler runs on Railway just like
anywhere else:

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (see README)
- optional: `REPORT_TZ` (default `Asia/Kolkata`)

## Cost

Railway is usage-based (per-second billing): a **30-day trial with $5
credit** (no card), then a Free plan at $1/mo with $1 usage credit, or
**Hobby $5/mo with $5 usage included** — this tiny Node service typically
fits inside the $5. Volumes are $0.15/GB-month. Unlike Render's free tier,
there's no 15-minute spin-down, but the free-tier credit only stretches so
far for an always-on process.

## Railway vs Render for this app

Both are persistent-process hosts and both work unchanged. Render: free
tier exists (with spin-down) + one-click blueprint with disk. Railway:
no spin-down on any plan, volume + usage billing, `railway.json` included
here. Pick by budget, not by capability.
