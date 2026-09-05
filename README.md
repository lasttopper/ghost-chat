# Pulse — real-time team messaging

A Slack-style messaging app: channels, presence, typing indicators, emoji
reactions and unread counts, over WebSockets.

## Run

```bash
npm install
node server.js          # http://localhost:3000
```

Open it in two browser tabs, join with two different names, and watch
messages, typing indicators and presence sync live.

## Test

```bash
npm test                # standalone e2e + Vercel handler e2e (34 assertions)
```

## Deploy

- **Standalone / VM / Fly / Railway:** `node server.js` — works as-is.
- **Render:** one-click blueprint (`render.yaml`) with optional persistent
  disk; free tier works with caveats. See [DEPLOY-RENDER.md](DEPLOY-RENDER.md).
- **Vercel:** supported via the WebSocket beta + Fluid compute; entry point
  `api/ws.js`, optional Upstash Redis for persistence. See
  [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).
- **DNSExit:** shared hosting won't work (no Node/long-running processes), but
  their KVM VPS runs Pulse unchanged — full setup in
  [DEPLOY-DNSEXIT.md](DEPLOY-DNSEXIT.md).

## Architecture

```
core.js            shared protocol core (state, presence, reactions, persistence hooks)
server.js          standalone: HTTP static + ws server, JSON-file persistence
api/ws.js          Vercel Function: WebSocket upgrade + optional Upstash REST persistence
vercel.json        Vercel routing (static rewrites + maxDuration)
public/index.html  app shell + login screen
public/style.css   dark theme
public/app.js      client: WS protocol, rendering, unread tracking
test/protocol-suite.js  shared assertions (runs against any host)
test/e2e.js        standalone e2e
test/vercel-e2e.js Vercel handler e2e (incl. fake-Upstash persistence roundtrip)
data.json          standalone persistence (created on first message)
```

### WS protocol (JSON)

Client → server: `join`, `message`, `react`, `typing`, `typing_stop`, `create_channel`
Server → client: `init`, `message`, `reactions`, `presence`, `typing`, `typing_stop`, `channel_created`, `error`

### Design notes

- **Unread counts are client-side**: each browser stores a last-read
  timestamp per channel (localStorage, with an in-memory fallback for
  sandboxed iframes). Badges recompute from server-stored messages, so
  they survive reloads.
- **Presence is connection-based**: a user is "online" while ≥1 socket is
  joined under their name; a 30s ping/pong heartbeat drops dead sockets
  so presence stays honest behind proxies.
- **Persistence** is a single JSON file, debounced 300ms after each
  change and flushed on SIGTERM. Message history is capped at 500 per
  channel.
- All user-supplied content is rendered via `textContent` (no innerHTML
  with user data), so messages can't inject HTML.
