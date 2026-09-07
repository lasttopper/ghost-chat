/* Username recovery across logout/login:
 * 1. connect as a guest authId, join with a username, disconnect
 * 2. reconnect with the SAME authId but an EMPTY username (post-logout state)
 *    -> server must resolve the original username and send init (no need_username)
 * 3. connect with an UNKNOWN authId + empty username -> need_username
 * Usage: node test/username-recovery.js [wsUrl]
 */
const WebSocket = require('ws');

const BASE = process.argv[2] || 'ws://127.0.0.1:3000/ws';
const authId = 'test-recover-' + Date.now();
const NAME = 'recoverer_' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

function open(name, msg, expect, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ got: null }); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type !== expect) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ got: m, ws });
    });
    ws.on('error', () => { clearTimeout(timer); resolve({ got: null }); });
  });
}

(async () => {
  console.log('username-recovery test against', BASE);

  // step 1: first login with a username
  const r1 = await open('first-login', { type: 'join', username: NAME, authId, color: '#ff0000', guest: true }, 'init');
  ok(r1.got && r1.got.username === NAME, 'first login joins as ' + NAME + ' (init username=' + (r1.got && r1.got.username) + ')');

  // brief pause so presence/disconnect settles
  await new Promise((r) => setTimeout(r, 400));

  // step 2: same authId, empty username (logout -> localStorage wiped -> login)
  const r2 = await open('re-login', { type: 'join', username: '', authId, color: null, guest: true }, 'init');
  ok(r2.got && r2.got.username === NAME, 'same authId + empty username -> init username=' + (r2.got && r2.got.username) + ' (recovered)');

  // step 3: unknown authId + empty username -> the server ISSUES a unique
  // one-time username (nobody is ever asked to pick one).
  const r3 = await open('unknown', { type: 'join', username: '', authId: 'never-seen-' + Date.now(), color: null, guest: true }, 'init');
  ok(r3.got && /^user_[a-z0-9]{6}$/.test(String(r3.got.username || '')), 'unknown authId + empty username -> init with issued name (got ' + (r3.got && r3.got.username) + ')');

  // step 3b: a SECOND unknown identity must get a DIFFERENT issued name
  const r3b = await open('unknown-2', { type: 'join', username: '', authId: 'never-seen-2-' + Date.now(), color: null, guest: true }, 'init');
  ok(r3b.got && /^user_[a-z0-9]{6}$/.test(String(r3b.got.username || '')) && r3b.got.username !== (r3.got && r3.got.username),
    'second unknown identity gets a distinct issued name (got ' + (r3b.got && r3b.got.username) + ')');

  // step 3c: re-joining with the SAME new authId must recover the issued name
  const rejoinId = 'never-seen-' + Date.now();
  const r3c = await open('issue', { type: 'join', username: '', authId: rejoinId, color: null, guest: true }, 'init');
  await new Promise((r) => setTimeout(r, 300));
  const r3d = await open('rejoin', { type: 'join', username: '', authId: rejoinId, color: null, guest: true }, 'init');
  ok(r3d.got && r3c.got && r3d.got.username === r3c.got.username, 'the issued name is granted exactly once and recovered on re-login (got ' + (r3d.got && r3d.got.username) + ')');

  // step 4: recovered session should keep the original color (server-stored)
  const r4 = await open('re-login-color', { type: 'join', username: '', authId, color: null, guest: true }, 'init');
  const recColor = r4.got && (r4.got.color || (r4.got.me && r4.got.me.color));
  ok(r4.got && r4.got.username === NAME, 'third login still recovers ' + NAME);
  console.log('  (recovered color field:', JSON.stringify(recColor) + ')');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
