# Running Ghost Chat on Termux (Android)

Yes — Ghost Chat is plain Node.js with a single pure-JS dependency (`ws`,
no native compilation), so it runs on Termux as-is. Your phone becomes the
chat server.

## Setup

```bash
pkg update && pkg upgrade
pkg install nodejs git
git clone https://github.com/YOU/ghost-chat.git ~/ghost-chat
cd ~/ghost-chat
npm install --omit=dev     # installs only `ws` — no compilers needed
node server.js
```

Open `http://localhost:3000` in the phone's browser. Done — that's a full
Ghost Chat server (channels, private groups, DMs, reports, midnight digest)
running on Android.

## Keep it alive

Android loves killing background processes:

```bash
termux-wake-lock           # hold a wakelock while serving
nohup node server.js > ghost.log 2>&1 &
```

Also: Settings → Apps → Termux → Battery → **Unrestricted**, and exclude
Termux from any "battery saver" cleanup. Without this, the server dies when
the screen is off.

## Who can reach it?

| Access | How |
|---|---|
| Same phone | `http://localhost:3000` |
| Same Wi-Fi/LAN | `http://<phone-ip>:3000` (`ip addr` / router page for the IP) |
| Internet (friends) | Phone carriers usually CGNAT you — no inbound ports. Use a tunnel: **Tailscale** (`pkg install tailscale`, private VPN — best for a friends-only chat) or **cloudflared** (`pkg install cloudflared && cloudflared tunnel --url http://localhost:3000` — public HTTPS/WSS URL) |

HTTPS matters: browsers need `wss://` for WebSockets on https pages — both
tunnels above give you that automatically.

## Notes

- **Persistence** works normally — `data.json` lives in `~/ghost-chat`.
- **Auth:** guest mode works offline. For real Firebase accounts, use a
  *production* Firebase project (the Auth emulator is impractical on
  Termux) — set `emulator: false` in `public/firebase-config.js` and add
  your tunnel hostname to Firebase's Authorized domains.
- **Midnight digest:** runs inside the Node process, so the phone must be
  awake at 00:00 IST (wakelock on). Reports still queue up if it's off —
  the next midnight after wake-up sends them.
- Termux storage is wiped if you uninstall Termux — back up `data.json`
  (and `reports/`) if the history matters.
