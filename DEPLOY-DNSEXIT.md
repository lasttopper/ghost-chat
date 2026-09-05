# Deploying Pulse on a DNSExit KVM VPS

DNSExit's **shared web hosting won't work** (PHP/Perl/Python only — no Node.js,
no long-running processes for WebSockets). Their **KVM VPS** works perfectly:
it's a self-managed Linux server with full root, so Pulse runs exactly as the
standalone app — no code changes, no Vercel caveats, no connection duration
caps, and `data.json` persistence just works.

Plans start around $4.99/mo (1 vCPU / 2 GB RAM / 20 GB SSD, Dallas TX) —
plenty for a team chat.

## 1. Provision the VPS

- dnsexit.com → VPS → pick **VPS 1** → choose **Ubuntu 24.04** as the OS.
- Note the IP + root password they email you.

## 2. Install Node and the app

```bash
ssh root@YOUR_VPS_IP

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

# App
git clone https://github.com/YOU/messaging-app.git /opt/pulse
cd /opt/pulse && npm install --omit=dev
node test/e2e.js   # sanity: 16/16 pass on the VPS itself
```

(No git repo? `scp -r messaging-app root@YOUR_VPS_IP:/opt/pulse` instead.)

## 3. Run it as a service (survives reboots/crashes)

`/etc/systemd/system/pulse.service`:

```ini
[Unit]
Description=Pulse chat
After=network.target

[Service]
WorkingDirectory=/opt/pulse
ExecStart=/usr/bin/node /opt/pulse/server.js
Restart=always
RestartSec=2
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now pulse
systemctl status pulse        # should say active (running)
```

## 4. HTTPS + WebSockets with Caddy (auto-TLS, 2-line config)

```bash
apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
chat.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
systemctl reload caddy
```

Caddy proxies WebSockets automatically — no extra config. Point an **A record**
for `chat.yourdomain.com` at the VPS IP (DNSExit's free managed DNS works for
this; TTL 300 is fine). The client already uses `wss://` on https pages.

Open the firewall:

```bash
ufw allow 80,443/tcp && ufw enable
```

Keep port 3000 unexposed — Caddy fronts it.

## 5. Backups (optional but cheap)

State lives in one file:

```bash
crontab -e
# daily at 03:30
30 3 * * * cp /opt/pulse/data.json /root/pulse-backup-$(date +\%F).json
```

## Alternative: self-host at home with DNSExit's free DDNS

DNSExit's bread and butter is **free Dynamic DNS + free domains**. If you'd
rather run Pulse on a machine you own:

1. Claim a free hostname (e.g. `pulse.yourfree.domain`) via their DDNS.
2. Run their update client on your router or the host so the name follows
   your changing IP.
3. Port-forward 443 → your machine, run Pulse + Caddy as above.

Caveats they're upfront about: this breaks if your ISP uses CGNAT or blocks
inbound ports — their paid "Remote Access" tunnel covers that case. For an
always-on public chat, the $5 VPS is less fiddly; the DDNS route shines for a
private household/LAN chat.

## Why VPS over Vercel for this app

| | DNSExit VPS | Vercel |
|---|---|---|
| WebSocket duration | Unlimited | ~5 min (Hobby), auto-reconnect |
| State | On-disk `data.json`, persistent | Ephemeral; needs Upstash add-on |
| Scaling model | One process = everyone in sync | Per-instance pinning; no cross-instance fan-out |
| Maturity | Plain Linux — nothing beta | WS support in public beta |
| Ops burden | You patch/maintain the box | Zero |
| Cost | ~$5/mo | Free tier |

**Rule of thumb:** Vercel = zero-ops demo at small scale; VPS = the honest
production home for a stateful WebSocket app like this one.
