/* Production security smoke test — run against the live wss URL.
 * Verifies the token-gated security paths that need NO real Firebase token:
 *   - reserved name with no token -> need_username
 *   - spoofed owner email with no token -> cannot take "owner", never owner
 *   - forged/invalid id token -> auth_failed
 *   - a normal guest still joins
 * Usage: node test/prod-security-check.js [wssUrl]
 */
'use strict';
const WebSocket = require('ws');
const URL = process.argv[2] || 'wss://ghost-chat-5gxc.onrender.com/ws';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };

class C {
  constructor() { this.inbox = []; this.ws = null; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => res());
      this.ws.on('message', (d) => { try { this.inbox.push(JSON.parse(d)); } catch {} });
      this.ws.on('error', rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  join(f) { this.send({ type: 'join', guest: true, color: '#4f8cff', ...f }); return this.wait(['init', 'need_username', 'auth_failed', 'username_taken']); }
  wait(types, ms = 6000) {
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find((x) => types.includes(x.type));
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > ms) { clearInterval(iv); res(null); }
      }, 20);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('prod security check against', URL);
  const sfx = Math.random().toString(36).slice(2, 7);

  let c = new C(); await c.connect();
  let m = await c.join({ authId: 'guest-a', username: 'owner' });
  ok(m && m.type === 'need_username', 'reserved "owner" with no token -> need_username');
  c.close();

  c = new C(); await c.connect();
  m = await c.join({ authId: 'guest-b', email: 'rajkatrina90@gmail.com', username: 'owner' });
  ok(m && m.type === 'need_username', 'SPOOF owner email (no token) cannot take "owner"');
  c.close();

  c = new C(); await c.connect();
  m = await c.join({ authId: 'guest-c', email: 'rajkatrina90@gmail.com', username: 'hack' + sfx });
  ok(m && m.type === 'init' && m.isOwner === false, 'SPOOF owner email (no token) joins as plain guest, isOwner:false');
  c.close();

  c = new C(); await c.connect();
  m = await c.join({ idToken: 'forged.token.here', username: 'x' + sfx });
  ok(m && m.type === 'auth_failed', 'forged/invalid id token -> auth_failed');
  c.close();

  c = new C(); await c.connect();
  m = await c.join({ authId: 'guest-d', username: 'ok' + sfx });
  ok(m && m.type === 'init' && m.isOwner === false, 'normal guest still joins fine');
  c.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
