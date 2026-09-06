/* Tests the WebView APK's native Google auth glue (web side), end-to-end
 * against the real core over a real WS connection, with a mock
 * window.AndroidBridge standing in for the native shell:
 *   1. Google button -> bridge sign-in -> username setup -> join is sent with
 *      the bridge's Firebase ID token and the server VERIFIES it.
 *   2. A pre-existing native session resumes straight into the app on boot.
 *   3. Sign-out clears the native session.
 * (The native Credential Manager side needs a real device; this covers the JS
 * contract it drives.)
 * Usage: node test/native-google-auth.js
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
const WS = require('ws');
const { createCore } = require('../core');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \u2713', m); };
const bad = (m, e) => { fail++; console.log('  \u2717', m, '::', (e && e.message) || e); };

const VALID_TOKEN = 'BRIDGE_TOKEN_123';
let lastToken = null;
const core = createCore(null, {
  verifyIdToken: async (tok) => {
    lastToken = tok;
    if (tok !== VALID_TOKEN) throw new Error('bad token');
    return { uid: 'g-uid', email: 'g@test.local' };
  },
});

const waitFor = (cond, timeout = 6000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    let v = false;
    try { v = cond(); } catch {}
    if (v) return resolve();
    if (Date.now() - t0 > timeout) return reject(new Error('timeout'));
    setTimeout(tick, 20);
  };
  tick();
});

function makeDom(port, bridgeState, preEval) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = new JSDOM(HTML, {
    url: `http://localhost:${port}/`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // Track the app's sockets so we can close them BEFORE closing the window
  // (otherwise late broadcasts execute against a dead document and crash).
  bridgeState.sockets = [];
  window.WebSocket = class TrackedWS extends WS {
    constructor(url, protocols) { super(url, protocols); bridgeState.sockets.push(this); }
  };
  bridgeState.dom = dom;
  window.AndroidBridge = {
    isNative: () => true,
    getAppVersion: () => '2.2.0-test',
    showNotification: () => {},
    hasFirebaseSession: () => bridgeState.session,
    getFirebaseUser: () => (bridgeState.user ? JSON.stringify(bridgeState.user) : ''),
    requestFirebaseIdToken: () => { setTimeout(() => bridgeState.dom.window.__ghostIdToken(VALID_TOKEN), 5); },
    googleSignIn: () => {
      setTimeout(() => bridgeState.dom.window.__ghostGoogleAuth(
        { ok: true, uid: 'g-uid', email: 'g@test.local', displayName: 'G User' }), 5);
    },
    googleSignOut: () => { bridgeState.session = false; },
  };
  if (preEval) preEval(window);
  window.eval(APP);
  return dom;
}

function closeDom(dom, st) {
  for (const s of (st.sockets || [])) { try { s.onclose = null; s.onmessage = null; s.close(); } catch {} }
  try { dom.window.close(); } catch {}
}

(async () => {
  const wss = new WS.Server({ port: 0 });
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;

  /* ---- 1. Google button -> bridge sign-in -> verified join ---- */
  try {
    const st = { session: false, user: null };
    const dom = makeDom(port, st);
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    await waitFor(() => typeof $('#auth-google').onclick === 'function'); // boot wired
    $('#auth-google').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => !$('#username-setup').classList.contains('hidden'));
    ok('Google button starts the native flow and lands on username setup');

    $('#username-input').value = 'guser';
    $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => $('#me-status') && $('#me-status').textContent === 'online');
    ok('after sign-in the app connects and the server accepts the session');
    assert.strictEqual(lastToken, VALID_TOKEN, 'join must carry the bridge Firebase ID token, got: ' + lastToken);
    ok('the join carried the bridge Firebase ID token (server-verified identity)');
    assert($('#app') && !$('#app').classList.contains('hidden'), 'app shell visible');
    assert(/@guser/.test($('.me-name') ? $('.me-name').textContent : ''), 'signed in as @guser');
    ok('app shell shows the signed-in user');
    closeDom(dom, st);
  } catch (e) { bad('google sign-in flow', e); }

  /* ---- 2. pre-existing native session resumes on boot ---- */
  try {
    const st = { session: true, user: { uid: 'g-uid', email: 'g@test.local', displayName: 'G User' } };
    const dom = makeDom(port, st, (w) => w.localStorage.setItem('ghost.usernameFor.g-uid', 'guser2'));
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    await waitFor(() => $('#me-status') && $('#me-status').textContent === 'online');
    ok('a pre-existing native session resumes straight into the app (no login screen)');
    assert($('#login').classList.contains('hidden'), 'login screen never shown');
    assert(/@guser2/.test($('.me-name').textContent), 'resumed as the remembered username');
    ok('identity + remembered username restored from the native session');

    /* ---- 3. sign-out clears the native session ---- */
    const outBtn = window.document.querySelector('#me-card .icon-btn[title="Sign out"]');
    assert(outBtn, 'sign-out button exists');
    outBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => st.session === false, 2000);
    ok('sign-out calls through to the native side (session cleared)');
    closeDom(dom, st);
  } catch (e) { bad('native session resume/sign-out', e); }

  wss.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
