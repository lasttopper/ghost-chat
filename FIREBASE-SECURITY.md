# Firebase security for Ghost Chat

Ghost Chat uses **Firebase Authentication only** — email/password and "Continue
with Google" produce an identity (a Firebase `uid`). **All chat data lives on
your own backend** (the Render server), not in Firebase. That means:

- There is **no Firestore / Realtime Database / Storage** in this app, so there
  is no live database to protect. The included `firestore.rules` and
  `storage.rules` are **default-deny** guards: if you ever enable those
  services, they start locked (nothing readable/writable) until you write rules
  on purpose.
- The real security surface is **Firebase Auth configuration** + how the backend
  proves who a user is. The backend now verifies a Firebase **ID token** on every
  signed-in connection (see §0 below), so the `uid` / `email` it acts on are
  cryptographically proven — not merely client-claimed. The checklist below is
  what actually matters.

Project: **ghost-7ed67** (web app id `1:67898464798:web:83b0dbe6d6f847c5ee6c0f`).

---

## 0. Server-side ID-token verification (implemented)

Ownership and account binding are **unspoofable** because the server verifies a
Firebase ID token instead of trusting client-supplied values.

- When a signed-in client connects, it attaches its Firebase **ID token**
  (`getIdToken(user)`) to the `join` message.
- The server (`verify-id-token.js`) verifies it with **zero external
  dependencies**: it fetches Google's securetoken X.509 certificates, checks the
  RS256 signature, and validates `aud` / `iss` / `exp` / `iat` against the
  project. Only then does it trust the token's `sub` (uid) and `email`.
- The **owner** account (`OWNER_EMAIL`, default `rajkatrina90@gmail.com`) is
  granted **only** when a *verified* token carries that email. A client that
  merely *claims* the owner email with no valid token is treated as an
  unverified guest: it never becomes owner, cannot take a reserved name, and its
  claimed email is discarded.
- Connections **without** a token (guests, or a signed-in user whose token could
  not be fetched) are **unverified**: they keep their username for continuity but
  can never be owner or gain any verified privilege.
- Verified identity is re-derived on **every** join (never persisted as a trust
  flag), so a wiped or renamed account cannot keep stale privileges.

Config: `FIREBASE_PROJECT_ID` (defaults to `ghost-7ed67`) must match the client's
Firebase project, or token `aud`/`iss` checks fail. The outbound call to
`googleapis.com` for certificates is cached per Google's `Cache-Control`.

Tests: `test/verify-id-token.js` (signature/claim accept+reject against a real
openssl-generated cert, plus a live Google-cert parse check) and
`test/secure-auth.js` (owner via verified token, email-spoof blocked, invalid
token refused, no privilege escalation).

---

## 1. Authorized domains (required for Google sign-in)

Firebase Console → **Authentication → Settings → Authorized domains**. Add every
origin the app is served from, or Google sign-in fails with
`auth/unauthorized-domain`:

- `ghost-chat-5gxc.onrender.com`  ← the live app (primary)
- `lasttopper.github.io`          ← the Pages redirector
- `localhost` (already present by default, for local dev)

Email/password sign-in does **not** need this, but Google does.

## 2. Sign-in providers

Firebase Console → **Authentication → Sign-in method**. Enable:

- **Email/Password**
- **Google** — set your support email when prompted.

Disable any provider you don't use (e.g. Anonymous) to shrink the attack surface.

## 3. Usernames are enforced server-side (not in Firebase)

A user's `@username` is chosen **in the app**, not during Firebase signup, so it
cannot be validated by a Firebase Auth rule. It is enforced by the backend in
`core.js`:

- `USERNAME_RE = /^[a-z0-9_]{3,20}$/`
- `RESERVED` — privileged / impersonation names nobody can claim:
  `admin, administrator, owner, root, mod, moderator, system, ghostbot, bot,
  assistant, support, help, staff, team, official, everyone, all, here, …`

The chosen handle is also copied to the Firebase profile `displayName` so it can
be recovered on a new device, but the authoritative check is the server's.

## 4. Recommended hardening

- **Firebase App Check** (Console → App Check → register your web app with
  reCAPTCHA v3). This blocks scripted abuse of your Auth endpoints. After
  enabling, enforce App Check on Auth.
- **Email verification** — Console → Authentication → Settings → turn on
  "Require email verification" for new email/password accounts (optional).
- **Quotas / alerts** — Console → Authentication → Usage: set up billing/alerts
  so a spike in sign-in attempts is visible.

## 5. Deploying the (defensive) rules — only if you enable Firestore/Storage

```bash
npm i -g firebase-tools
firebase login
firebase use ghost-7ed67
firebase deploy --only firestore:rules,storage:rules
```

If you never enable Firestore or Storage, you don't need to deploy these — they
exist so the project is safe by default if those services are ever turned on.

---

### Why there is no "chat data" rule to write

Messages, channels, members and admins are stored and served by the Render
backend over a WebSocket. Access control (private-group membership, admin-only
add/remove/promote, reserved usernames) is enforced **there**, in `core.js`.
Firebase only answers "who is this user?" — it never sees the chat data.
