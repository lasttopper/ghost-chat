/* RTDB durable-storage tests.
 *  Part A - unit: createRtdb against a mock token + RTDB server (token cache,
 *           401 re-auth retry, load/save, disabled without a key).
 *  Part B - integration: a real server.js instance writes chat state through
 *           to the mock RTDB; a SECOND server instance (fresh data file, like
 *           a Render redeploy with wiped disk) boots and still has the data.
 * Usage: node test/rtdb.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { createRtdb } = require('../rtdb');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- mock token + RTDB server ---------------- */
let tokenCalls = 0;
let failNextWith401 = false;
const store = {}; // path -> JSON value

function mockServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/token') {
      tokenCalls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: 'tok-' + tokenCalls, expires_in: 3600 }));
      return;
    }
    // RTDB-style JSON endpoints
    if (!/^\/[\w-]+(\.json)?$/.test(u.pathname) && !u.pathname.startsWith('/ghost-backups/')) {
      res.writeHead(404).end('{}'); return;
    }
    const auth = req.headers.authorization || '';
    if (auth === 'Bearer expired') { res.writeHead(401).end('{"error":"expired"}'); return; }
    const key = u.pathname.replace(/\.json$/, '');
    if (req.method === 'GET') {
      const shallow = u.searchParams.get('shallow') === 'true';
      res.setHeader('Content-Type', 'application/json');
      let v = store[key];
      if (shallow && v === undefined) {
        // flat mock: synthesize child listing (RTDB shallow=true semantics)
        const prefix = key + '/';
        const kids = Object.keys(store).filter((k) => k.startsWith(prefix));
        if (!kids.length) { res.end('null'); return; }
        res.end(JSON.stringify(Object.fromEntries(
          kids.map((k) => [k.slice(prefix.length).split('/')[0], true]))));
        return;
      }
      if (v === undefined) { res.end('null'); return; }
      res.end(JSON.stringify(shallow && v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).map((k) => [k, true])) : v));
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        if (failNextWith401) { failNextWith401 = false; res.writeHead(401).end('{"error":"expired"}'); return; }
        store[key] = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
      return;
    }
    if (req.method === 'DELETE') { delete store[key]; res.end('null'); return; }
    res.writeHead(405).end('{}');
  });
}

function fakeServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key: privateKey,
    client_email: 'fake@test-project.iam.gserviceaccount.com',
  });
}

const SA = fakeServiceAccount();

(async () => {
  console.log('rtdb durable storage test');
  const mock = mockServer();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + mock.address().port;

  /* ---------------- Part A: unit ---------------- */
  const off = createRtdb({});
  ok(off.enabled === false, 'disabled without a service account');

  const db = createRtdb({ serviceAccountJson: SA, baseUrl: base, tokenUrl: base + '/token' });
  ok(db.enabled === true, 'enabled with a service account');

  const state1 = { users: { alice: { color: '#fff' } }, channels: [], dms: [], reports: [], nextMessageId: 5, lastDigestDate: null };
  await db.saveState(state1);
  ok(JSON.stringify(store['/ghost-state']) === JSON.stringify(state1), 'saveState PUTs the full state');

  tokenCalls = 0;
  await db.saveState(state1);
  await db.loadState();
  ok(tokenCalls === 0, 'oauth token is cached across calls');

  const loaded = await db.loadState();
  ok(loaded && loaded.users.alice && loaded.nextMessageId === 5, 'loadState returns stored state');

  failNextWith401 = true;
  const db2 = createRtdb({ serviceAccountJson: SA, baseUrl: base, tokenUrl: base + '/token' });
  await db2.saveState({ ...state1, nextMessageId: 6 }); // first token 'expired' -> 401 -> re-auth -> ok
  ok(store['/ghost-state'].nextMessageId === 6, '401 triggers re-auth and the write succeeds');

  await db2.backupNow(state1, '2026-09-07');
  ok(!!store['/ghost-backups/2026-09-07'], 'backupNow stores a dated snapshot');
  const list = await db2.listBackups();
  ok(Array.isArray(list) && list.includes('2026-09-07'), 'listBackups finds the snapshot');

  /* ---------------- Part B: restart survival ---------------- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtdb-e2e-'));
  const boot = (port, tag) => new Promise((resolve) => {
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        GHOST_DATA: path.join(dir, 'data-' + tag + '.json'), // fresh file each boot = wiped disk
        FIREBASE_SERVICE_ACCOUNT: SA,
        FIREBASE_RTDB_URL: base,
        FIREBASE_OAUTH_URL: base + '/token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tryIt = (tries) => {
      const sock = require('net').connect(port, '127.0.0.1', () => { sock.destroy(); resolve(srv); });
      sock.on('error', () => { sock.destroy(); tries > 0 ? setTimeout(() => tryIt(tries - 1), 150) : resolve(srv); });
    };
    tryIt(40);
  });

  const wsJoinMsg = (port, username, authId, text) => new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const inbox = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', username, authId, color: '#f43f5e' })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      inbox.push(m);
      if (m.type === 'init') {
        if (text) ws.send(JSON.stringify({ type: 'message', channel: 'general', text }));
        else { ws.close(); resolve(inbox); }
      }
      if (text && m.type === 'message' && m.message.text === text) {
        setTimeout(() => { ws.close(); resolve(inbox); }, 100);
      }
    });
    setTimeout(() => { try { ws.close(); } catch {} resolve(inbox); }, 8000);
  });

  // Part B must start from a CLEAN durable store (Part A left test state in it)
  for (const k of Object.keys(store)) delete store[k];

  const P1 = 3981, P2 = 3982;
  const srv1 = await boot(P1, 'a');
  await wsJoinMsg(P1, 'rtdb_qa', 'auth-rtdb-1', 'survive-the-redeploy');
  await wait(500); // debounce (300ms) -> save -> mock RTDB
  ok(store['/ghost-state'] && JSON.stringify(store['/ghost-state']).includes('survive-the-redeploy'),
    'running server persists messages to RTDB');

  // SIGTERM shutdown: final save must also land (Render redeploys kill with SIGTERM)
  srv1.kill('SIGTERM');
  await wait(600);

  const srv2 = await boot(P2, 'b'); // fresh data file => like a wiped Render disk
  const init2 = await wsJoinMsg(P2, 'rtdb_qa', 'auth-rtdb-1', null);
  const initMsg = init2.find((e) => e.type === 'init');
  const gen = initMsg && initMsg.channels.find((c) => c.id === 'general');
  ok(!!(gen && gen.messages.some((m) => m.text === 'survive-the-redeploy')),
    'a NEW server instance (empty disk) restores the chat from RTDB');

  srv2.kill('SIGTERM');
  mock.close();
  await wait(150);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
