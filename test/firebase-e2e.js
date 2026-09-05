/* Firebase Auth e2e: drives the REAL @firebase/auth SDK against the local
 * Auth emulator (npm run emulators), then ties the Firebase UID into the
 * chat server's username system.
 *
 * Skips cleanly (exit 0) when the emulator isn't running, so `npm test`
 * works without it; with the emulator up it fully verifies the auth flow.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const EMULATOR = 'http://127.0.0.1:9099';
const PROJECT = 'demo-ghost-chat';
const CHAT_PORT = 3215;

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.error('  FAIL  ' + label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* emulator up? */
  let up = false;
  try { const r = await fetch(EMULATOR + '/'); up = r.status > 0; } catch {}
  if (!up) {
    console.log('— firebase auth: emulator not running (npm run emulators) — SKIPPED');
    process.exit(0);
  }

  const { initializeApp } = await import('firebase/app');
  const authMod = await import('firebase/auth');
  const {
    getAuth, connectAuthEmulator,
    createUserWithEmailAndPassword, signInWithEmailAndPassword,
  } = authMod;

  /* clean slate */
  await fetch(`${EMULATOR}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

  const app = initializeApp({ apiKey: 'demo-key', authDomain: 'localhost', projectId: PROJECT });
  const auth = getAuth(app);
  connectAuthEmulator(auth, EMULATOR, { disableWarnings: true });

  /* 1. signup */
  const cred = await createUserWithEmailAndPassword(auth, 'alice@example.com', 'password123');
  ok(!!cred.user && typeof cred.user.uid === 'string' && cred.user.uid.length > 0,
    'createUserWithEmailAndPassword returns a uid');
  const uid = cred.user.uid;

  /* 2. signin roundtrip */
  const cred2 = await signInWithEmailAndPassword(auth, 'alice@example.com', 'password123');
  ok(cred2.user.uid === uid, 'signInWithEmailAndPassword returns the same uid');

  /* 3. wrong password rejected */
  let wrongRejected = false;
  try { await signInWithEmailAndPassword(auth, 'alice@example.com', 'WRONG'); }
  catch (e) { wrongRejected = /auth\/(invalid-credential|wrong-password)/.test(e.code); }
  ok(wrongRejected, 'wrong password rejected (auth/invalid-credential)');

  /* 4. duplicate email rejected */
  let dupRejected = false;
  try { await createUserWithEmailAndPassword(auth, 'alice@example.com', 'password123'); }
  catch (e) { dupRejected = e.code === 'auth/email-already-in-use'; }
  ok(dupRejected, 'duplicate email rejected (auth/email-already-in-use)');

  /* 5. weak password rejected */
  let weakRejected = false;
  try { await createUserWithEmailAndPassword(auth, 'bob@example.com', '123'); }
  catch (e) { weakRejected = e.code === 'auth/weak-password'; }
  ok(weakRejected, 'weak password rejected (auth/weak-password)');

  /* 6. tie the real Firebase uid into the chat server */
  const DATA = path.join(os.tmpdir(), 'ghost-fb-' + Date.now() + '.json');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(CHAT_PORT), PULSE_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[chat] ' + d));
  const deadline = Date.now() + 5000;
  let chatUp = false;
  while (Date.now() < deadline && !chatUp) {
    chatUp = await new Promise((r) => {
      const s = require('net').connect(CHAT_PORT, '127.0.0.1', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (!chatUp) await wait(100);
  }

  const client = (msgs) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/ws`);
    const events = [];
    ws.on('open', () => msgs.forEach((m) => ws.send(JSON.stringify(m))));
    ws.on('message', (raw) => events.push(JSON.parse(raw)));
    ws.on('error', reject);
    setTimeout(() => { ws.close(); resolve(events); }, 1500);
  });

  // alice's real uid claims @fb_alice
  const evA = await client([{ type: 'join', username: 'fb_alice', authId: uid, email: 'alice@example.com', color: '#8b5cf6' }]);
  ok(evA.some((e) => e.type === 'init' && e.username === 'fb_alice'), 'real firebase uid claims a username');

  // a different uid cannot steal it
  const evB = await client([{ type: 'join', username: 'fb_alice', authId: 'some-other-uid' }]);
  ok(evB.some((e) => e.type === 'username_taken'), 'username bound to firebase uid (other uid rejected)');

  // same uid can reclaim it
  const evC = await client([{ type: 'join', username: 'fb_alice', authId: uid }]);
  ok(evC.some((e) => e.type === 'init' && e.username === 'fb_alice'), 'same uid reclaims its username');

  server.kill('SIGKILL');
  try { fs.unlinkSync(DATA); } catch {}

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nTEST ERROR:', e && (e.stack || e.message || e)); process.exit(1); });
