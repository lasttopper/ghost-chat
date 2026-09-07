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
  await wait(300);

  /* ---------------- Part C: RTDB-stripped state heals ---------------- */
  // This is EXACTLY what RTDB does to saved state: empty arrays/objects and
  // nulls vanish. #random loses `messages`, the message loses `reactions`,
  // and `dms`/`reports` disappear entirely. A client receiving this raw
  // crashes while rendering -> "stuck on connecting".
  for (const k of Object.keys(store)) delete store[k];
  store['/ghost-state'] = {
    users: { ghostbot: { color: '#8b5cf6', authId: 'system:ghostbot', bot: true, displayName: 'GhostBot', createdAt: 1 } },
    channels: [
      { id: 'general', name: 'general', type: 'channel', private: false, inviteCode: null, members: [], createdBy: 'system', topic: 't', createdAt: 1,
        messages: [{ id: 'm1', channel: 'general', username: 'system', color: '', ts: 1, system: true, text: 'hi' }] },
      { id: 'random', name: 'random', type: 'channel', private: false, inviteCode: null, createdBy: 'system', topic: 't', createdAt: 1 }, // messages stripped!
    ],
    nextMessageId: 9,
  };
  const P3 = 3983;
  const srv3 = await boot(P3, 'c');
  const init3 = await wsJoinMsg(P3, 'heal_qa', 'auth-heal-1', null);
  const initC = init3.find((e) => e.type === 'init');
  ok(!!initC, 'server boots and serves init from RTDB-stripped state');
  const chans = (initC && initC.channels) || [];
  ok(chans.length === 2 && chans.every((c) => Array.isArray(c.messages)),
    'every conversation in init has a messages array (stripped ones healed)');
  ok(Array.isArray(initC && initC.dms) && Array.isArray(initC && initC.reports === undefined ? [] : initC.dms),
    'init dms array present');
  // post into the channel that lost its messages array (server-side push)
  const healEcho = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + P3 + '/ws');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', username: '', authId: 'auth-heal-1', color: '#f43f5e' })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'init') ws.send(JSON.stringify({ type: 'message', channel: 'random', text: 'into-the-healed-channel' }));
      if (m.type === 'message' && m.message.text === 'into-the-healed-channel') { ws.close(); resolve(m); }
    });
    setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 8000);
  });
  ok(!!healEcho && !!healEcho.message.reactions, 'message posts into the healed channel and carries reactions');
  srv3.kill('SIGTERM');
  await wait(300);

  /* ---------------- Part D: a HANGING RTDB must never block boot/join ---- */
  const hang = http.createServer(() => { /* accepts, never responds */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const hangBase = 'http://127.0.0.1:' + hang.address().port;
  const P4 = 3984;
  const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'rtdb-hang-'));
  const t0 = Date.now();
  const srv4 = await new Promise((resolve) => {
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env, PORT: String(P4), GHOST_DATA: path.join(dirD, 'data.json'),
        FIREBASE_SERVICE_ACCOUNT: SA,
        FIREBASE_RTDB_URL: hangBase, FIREBASE_OAUTH_URL: hangBase + '/token',
        FIREBASE_RTDB_TIMEOUT_MS: '700',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tryIt = (tries) => {
      const sock = require('net').connect(P4, '127.0.0.1', () => { sock.destroy(); resolve(srv); });
      sock.on('error', () => { sock.destroy(); tries > 0 ? setTimeout(() => tryIt(tries - 1), 200) : resolve(srv); });
    };
    tryIt(120);
  });
  const bootMs = Date.now() - t0;
  ok(bootMs < 20000, `server still boots while RTDB hangs (${(bootMs / 1000).toFixed(1)}s, timeouts+retries bounded)`);
  // Let the bounded startup retries finish (3 x 700ms timeout + 1.5s + 3s
  // backoff). The FIRST join may wait on that one-time load; every join after
  // ready must be network-free.
  await wait(7000);
  const tJoin = Date.now();
  const initD = await wsJoinMsg(P4, 'hang_qa', 'auth-hang-1', 'works-during-outage');
  const joinMs = Date.now() - tJoin;
  const initM = initD.find((e) => e.type === 'init');
  const echoed = initD.some((e) => e.type === 'message' && e.message.text === 'works-during-outage');
  ok(!!initM && joinMs < 5000, `join completes fast while RTDB hangs (${joinMs}ms - no network in join path)`);
  ok(echoed, 'chat fully works during an RTDB outage (file-only fallback)');
  srv4.kill('SIGTERM');
  hang.close();
  mock.close();
  await wait(150);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
