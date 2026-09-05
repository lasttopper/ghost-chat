/* Offline preview test.
 * Phase 1 (online): boot the app, guest-login, send a message, verify the
 *   offline cache lands in localStorage.
 * Phase 2 (offline): server killed; cold-boot a fresh page seeded with the
 *   phase-1 localStorage; the app must render the cached conversation and
 *   show the offline banner — with zero network. */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}/`;
const PUB = path.join(__dirname, '..', 'public');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

function vcFor(tag) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`[${tag}] ${e.message}`));
  return vc;
}

/* jsdom has no window.matchMedia — real browsers all do; shim it so the
 * app's device-capability checks behave like production. */
function shimMatchMedia(w) {
  if (!w.matchMedia) {
    w.matchMedia = (q) => ({
      matches: false, media: q,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    });
  }
}

let server;
function startServer() {
  server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), GHOST_DATA: '/tmp/offtest-data.json' },
    stdio: 'ignore',
  });
}
function stopServer() { try { server.kill('SIGKILL'); } catch {} }

(async () => {
  fs.rmSync('/tmp/offtest-data.json', { force: true });
  startServer();
  await wait(1200);

  /* ---------- phase 1: online ---------- */
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    virtualConsole: vcFor('online'),
    beforeParse: shimMatchMedia,
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };

  await wait(2200);
  if (!vis('#login')) fail('phase1: login not visible');
  $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);
  $('#username-input').value = 'offtest_' + Math.random().toString(36).slice(2, 7);
  $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(2500);
  if (!vis('#app')) fail('phase1: app not visible'); else console.log('phase1: online app visible ✓');

  // send a message through the real UI
  const MARK = 'offline-cache-marker-' + Date.now();
  $('#input').value = MARK;
  $('#send-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1800); // 600ms debounce + margin

  const rendered = [...window.document.querySelectorAll('.msg-text')].some((n) => n.textContent === MARK);
  if (!rendered) fail('phase1: sent message not rendered'); else console.log('phase1: message sent+rendered ✓');

  const cacheRaw = window.localStorage.getItem('ghost.offlineCache.v1');
  if (!cacheRaw) fail('phase1: offline cache not written');
  else if (!cacheRaw.includes(MARK)) fail('phase1: cache missing the message');
  else console.log('phase1: offline cache written ✓');

  // snapshot storage + assets for the offline boot
  const seed = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    seed[k] = window.localStorage.getItem(k);
  }
  window.close();
  stopServer();
  await wait(600);

  /* ---------- phase 2: offline cold boot ---------- */
  const inline = (f) => `<script>${fs.readFileSync(path.join(PUB, f), 'utf8')}</script>`;
  let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  html = html
    .replace('<script src="firebase-config.js"></script>', inline('firebase-config.js'))
    .replace('<script src="backend-config.js"></script>', inline('backend-config.js'))
    .replace('<script src="app.js"></script>', inline('app.js'));

  const dom2 = new JSDOM(html, {
    url: BASE, runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: vcFor('offline'),
    beforeParse(w) {
      shimMatchMedia(w);
      for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
    },
  });
  const w2 = dom2.window;
  const $2 = (s) => w2.document.querySelector(s);
  function vis2(s) { const el = $2(s); return !!el && !el.classList.contains('hidden'); }
  // the seeded storage contains a returning guest identity → the app
  // auto-resumes straight into the shell (no login click needed)
  await wait(2500);
  if (!vis2('#app')) {
    // fallback for a fresh/unknown identity: walk the login path
    if (vis2('#login')) $2('#guest-btn').dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
    await wait(2500);
  }
  if (!vis2('#app')) fail('phase2: app shell not shown offline'); else console.log('phase2: offline app shell visible (auto-resumed) ✓');

  const cachedMsg = [...w2.document.querySelectorAll('.msg-text')].some((n) => n.textContent === MARK);
  if (!cachedMsg) fail('phase2: cached message not rendered'); else console.log('phase2: cached conversation rendered ✓');

  const banner = $2('#reconnect-banner');
  const bannerOk = banner && !banner.classList.contains('hidden') && /Offline/i.test(banner.textContent);
  if (!bannerOk) fail('phase2: offline banner missing/wrong: ' + (banner && banner.textContent));
  else console.log('phase2: offline banner correct ✓');

  // sending offline must keep the draft
  $2('#input').value = 'draft me';
  $2('#send-btn').dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  await wait(200);
  if ($2('#input').value !== 'draft me') fail('phase2: offline send lost the draft');
  else console.log('phase2: offline draft preserved ✓');

  if (errors.length) { console.log('PAGE ERRORS:'); errors.forEach((e) => console.log(' -', e)); process.exitCode = 1; }
  console.log(process.exitCode ? 'OFFLINE TEST FAILED' : 'OFFLINE TEST PASSED');
  dom2.window.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); stopServer(); process.exit(1); });
