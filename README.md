# 👻 Ghost Chat — real-time messaging

Public groups, private invite-only groups, direct messages, presence, typing
indicators, emoji reactions, unread badges, message reporting with a daily
midnight Telegram digest — over WebSockets.

## Run

```bash
npm install
node server.js          # http://localhost:3000
```

Open it in two browser tabs, join with two different usernames, and watch
everything sync live.

## Auth

Ghost Chat uses **Firebase Authentication** (email/password + Google) when
configured, and falls back to **Guest mode** (per-browser identity) so local
development works with zero setup.

1. Create a Firebase project → Authentication → enable **Email/Password** and **Google**.
2. Register a Web App and copy its config into `public/firebase-config.js`.
3. Add your hosting domain(s) under Authentication → Settings → Authorized domains.

After signing in, each user picks a unique `@username` (3–20 chars,
`[a-z0-9_]`). The server ties usernames to Firebase UIDs, so a username
belongs to one account.

> Note: the server currently trusts the identity the client sends. For
> production, verify the Firebase ID token server-side (firebase-admin) —
> see the note in `core.js`.

## Groups & DMs

- **🌍 Public group** — everyone sees it and can join.
- **🔒 Private group** — hidden from non-members; joinable **only via invite
  link** (`?join=<code>`). The creator gets the link (🔗 Invite in the header).
- **Direct messages** — 1-on-1 chats from the sidebar ＋ button. Only the two
  participants ever receive the messages.

## Report system + midnight digest

Hover any message → 🚩 → give a reason. Reports are stored server-side.

Every day at **midnight** (`REPORT_TZ`, default `Asia/Kolkata`) the server
compiles the day's **full chat logs (public + private + DMs), user details and
pending reports** into a text file (`reports/ghost-chat-report-YYYY-MM-DD.txt`)
and sends it to **Telegram** as a document.

Configure via environment variables:

| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat/group the report is sent to |
| `REPORT_TZ` | Digest timezone (default `Asia/Kolkata`) |
| `REPORT_DIR` | Where report files are written (default `./reports`) |

Without the Telegram vars the file is still written locally and the send is
skipped. Create a bot with @BotFather, add it to a group, and get the chat id
(e.g. via the bot's `getUpdates`).

⚠️ The digest contains private conversations — send it only to an
admin-only chat.

## Test

```bash
npm test    # standalone + Vercel handler + digest e2e (90 assertions)
```

## Deploy

- **Standalone / VM / Fly / Railway:** `node server.js` — works as-is.
- **Render:** one-click blueprint (`render.yaml`) with optional persistent
  disk. See [DEPLOY-RENDER.md](DEPLOY-RENDER.md).
- **Vercel:** WebSocket beta + Fluid compute; entry point `api/ws.js`,
  optional Upstash Redis. Note: the midnight digest scheduler runs on the
  standalone/Render server, not the Vercel function. See
  [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).
- **DNSExit:** KVM VPS only (shared hosting won't run Node). See
  [DEPLOY-DNSEXIT.md](DEPLOY-DNSEXIT.md).

## Architecture

```
core.js            shared protocol core (conversations, membership, reports)
digest.js          timezone-aware midnight digest + Telegram Bot API sender
server.js          standalone: static + ws server, JSON-file persistence, digest scheduler
api/ws.js          Vercel Function entry (optional Upstash REST persistence)
vercel.json        Vercel routing
render.yaml        Render blueprint
public/            index.html, style.css, app.js, firebase-config.js
test/              protocol suite (shared) + standalone/vercel/digest e2e
data.json          standalone persistence (gitignored)
```

### WS protocol (JSON)

Client → server: `join`, `message`, `react`, `typing`, `typing_stop`,
`create_channel` (public/private), `join_channel` (by invite code),
`dm_start`, `report`

Server → client: `init`, `message`, `reactions`, `presence`, `typing`,
`typing_stop`, `channel_created`, `channel_joined`, `member_joined`,
`dm_ready`, `report_ack`, `need_username`, `username_taken`, `error`

### Design notes

- Private groups and DMs are **member-filtered at the server**: non-members
  never receive their messages, reactions, typing events, or existence.
- Unread counts are client-side (per-conversation last-read timestamps).
- Presence has a 4 s grace window so refreshes/reconnects don't flap.
- All user content is rendered via `textContent` — no HTML injection.
