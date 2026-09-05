/* E2E for the VERCEL function (api/ws.js):
 *  1. runs the shared protocol suite against a local harness that routes
 *     HTTP + upgrade events into the real handler (in-memory mode)
 *  2. runs the handler against a FAKE Upstash REST server to verify the
 *     persistence contract: state saved on write, reloaded on cold start.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const runSuite = require('./protocol-suite');

const HARNESS_PORT = 3211;
const FAKE_UPSTASH_PORT = 3212;
const HARNESS = require('path').join(__dirname, 'vercel-harness.js');

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.error('  FAIL  ' + label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForPort = async (port, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const up = await new Promise((r) => {
      const sock = require('net').connect(port, '127.0.0.1', () => { sock.destroy(); r(true); });
      sock.on('error', () => r(false));
    });
    if (up) return true;
    await wait(100);
  }
  return false;
};

function spawnHarness(env = {}) {
  const p = spawn(process.execPath, [HARNESS], {
    env: { ...process.env, PORT: String(HARNESS_PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('[harness] ' + d));
  return p;
}

const kill = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });

/* minimal fake of the Upstash Redis REST API surface we use (GET/SET) */
function startFakeUpstash() {
  const store = {};
  const srv = http.createServer((req, res) => {
    const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer test-token') { res.statusCode = 401; res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && parts[0] === 'get') {
      res.end(JSON.stringify({ result: parts[1] in store ? store[parts[1]] : null }));
    } else if (req.method === 'POST' && parts[0] === 'set') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { store[parts[1]] = JSON.parse(body); res.end(JSON.stringify({ result: 'OK' })); });
    } else { res.statusCode = 404; res.end('{}'); }
  });
  return new Promise((r) => srv.listen(FAKE_UPSTASH_PORT, '127.0.0.1', () => r({ srv, store })));
}

/* small ws client for the persistence checks */
const WebSocket = require('ws');
function client() {
  const c = { events: [] };
  c.ws = new WebSocket(`ws://127.0.0.1:${HARNESS_PORT}/ws`);
  c.ws.on('message', (raw) => c.events.push(JSON.parse(raw)));
  c.ready = new Promise((r, j) => { c.ws.on('open', r); c.ws.on('error', j); });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.close = () => c.ws.close();
  return c;
}

(async () => {
  /* ---- 1. protocol suite, in-memory mode ---- */
  console.log('— vercel handler (api/ws.js), in-memory —');
  let h = spawnHarness();
  if (!(await waitForPort(HARNESS_PORT))) { console.error('harness did not start'); process.exit(1); }
  try {
    const r = await runSuite(HARNESS_PORT);
    passed += r.passed; failed += r.failed;
  } catch (e) { console.error('SUITE ERROR:', e.message); failed++; }
  await kill(h);

  /* ---- 2. persistence via fake Upstash ---- */
  console.log('— vercel handler, Upstash persistence —');
  const { srv, store } = await startFakeUpstash();
  const env = {
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${FAKE_UPSTASH_PORT}`,
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
  };

  h = spawnHarness(env);
  if (!(await waitForPort(HARNESS_PORT))) { console.error('harness did not start'); process.exit(1); }
  const c1 = client(); await c1.ready;
  c1.send({ type: 'join', username: 'carol', color: '#f59e0b' });
  await wait(300);
  c1.send({ type: 'message', channel: 'general', text: 'persist me' });
  await wait(900); // debounce is 300ms
  ok(!!store['pulse:state'], 'state written to Upstash REST after a message');
  ok(
    store['pulse:state'] && JSON.parse(store['pulse:state']).channels
      .find((c) => c.id === 'general').messages.some((m) => m.text === 'persist me'),
    'saved state contains the message'
  );
  c1.close();
  await kill(h); // simulate scale-to-zero / cold start

  h = spawnHarness(env);
  if (!(await waitForPort(HARNESS_PORT))) { console.error('harness restart failed'); process.exit(1); }
  const c2 = client(); await c2.ready;
  c2.send({ type: 'join', username: 'carol', color: '#f59e0b' });
  await wait(600);
  const init = c2.events.find((e) => e.type === 'init');
  ok(
    !!init && init.channels.find((c) => c.id === 'general').messages.some((m) => m.text === 'persist me'),
    'cold start reloads state from Upstash (message survives restart)'
  );
  c2.close();
  await kill(h);
  srv.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nTEST ERROR:', e); process.exit(1); });
