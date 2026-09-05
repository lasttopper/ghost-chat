# Configuring Firebase + Telegram (one time, ~5 minutes)

Both need *your* accounts — the repo ships tooling that wires and verifies
everything once you have the values.

```
You collect 3 values → node scripts/configure.js → node scripts/telegram-check.js → done
```

---

## 1. Firebase (real accounts instead of the emulator)

1. Go to **console.firebase.google.com** → **Add project** (e.g. `ghost-chat`;
   Analytics optional/off).
2. Left sidebar → **Build → Authentication → Get started** →
   **Sign-in method** tab → enable **Email/Password**.
   (Optional: enable **Google** too — needs your support email.)
3. ⚙️ **Project settings → General → Your apps → Web app (`</>`)** →
   Register app (nickname: Ghost Chat) → copy the `firebaseConfig` object:

```js
{ apiKey: "AIza…", authDomain: "ghost-chat.firebaseapp.com",
  projectId: "ghost-chat", storageBucket: "…", messagingSenderId: "…", appId: "1:…" }
```

4. **Authentication → Settings → Authorized domains**: add every origin that
   will serve the app — `localhost`, your `*.github.io` Pages domain, and
   (if you also open the Render URL directly) the `*.onrender.com` domain.

> 🔓 The Firebase **web API key is not a secret** — every web app ships it
> publicly. Protection comes from your Auth settings, Authorized domains,
> and (later) Security Rules. `public/firebase-config.js` is committed on
> purpose.

## 2. Telegram (the midnight report bot)

1. In Telegram, search **@BotFather** → `/newbot` → name it
   (e.g. "Ghost Chat Reports") → username (e.g. `ghost_chat_reports_bot`).
   BotFather replies with the **token** (`123456789:AAE…`).
2. Create a **private group** (e.g. "Ghost Chat Reports" — admins only!) →
   **Add the bot** to it → send any message in the group.
   ⚠️ The midnight digest contains **all chats including DMs** — keep this
   group private.
3. Find the group's **chat id**: run the checker — it lists every chat that
   messaged the bot, with ids (groups look like `-100…`):

```bash
node scripts/telegram-check.js
```

## 3. Wire the values in

```bash
node scripts/configure.js \
  --firebase '{"apiKey":"AIza…","authDomain":"ghost-chat.firebaseapp.com","projectId":"ghost-chat","appId":"1:…"}' \
  --telegram-token "123456789:AAE…" \
  --telegram-chat "-1001234567890"
```

Writes `public/firebase-config.js` (public, committed) and `.env`
(gitignored — the bot token IS a secret).

## 4. Verify

```bash
node scripts/telegram-check.js --send-test   # ✓ bot auth, chat list, test message
```

Firebase: reload the app — the login card now shows real sign-in (no
"emulator" banner). Create an account and log in.

## 5. Where each setting lives per environment

| | Firebase config | Telegram vars |
|---|---|---|
| Local (`node server.js`) | `public/firebase-config.js` | `.env` (auto-loaded) |
| Render | committed file (served with the UI) | Dashboard → Environment: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Railway | same | Service → Variables |
| GitHub Pages frontend | committed file (deployed by `pages.yml`) | n/a (frontend doesn't send reports) |

Digest timing: `REPORT_TZ` env var, default `Asia/Kolkata` — fires at
midnight in that timezone.
