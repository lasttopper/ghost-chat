/* jsdom: the APK update banner.
 *   - newer release + old bridge version -> banner appears
 *   - "Update now" hands the APK url to AndroidBridge.downloadAndInstallApk
 *   - "Later" dismisses it and remembers the skipped version
 *   - already up to date -> no banner
 * Usage: node test/update-ui.js [url]
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
const url = process.argv[2] || 'http://127.0.0.1:3000/';
const APK = 'https://example.com/ghost-chat.apk';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function shim(w, bridgeVersion, latest) {
  if (!w.matchMedia) w.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  w.__installed = null;
  w.AndroidBridge = {
    isNative: () => true,
    getAppVersion: () => bridgeVersion,
    downloadAndInstallApk: (u) => { w.__installed = u; },
    hasNotificationPermission: () => true,
    requestNotificationPermission: () => {},
  };
  const realFetch = w.fetch && w.fetch.bind(w);
  w.fetch = (input, init) => {
    const u = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (u.includes('/api/update-check')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, latest, url: APK, notes: 'n' }) });
    }
    return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
  };
}

async function boot(bridgeVersion, latest) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse: (w) => shim(w, bridgeVersion, latest),
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const click = (s) => $(s).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(2500);
  click('#guest-btn');
  for (let i = 0; i < 40 && !vis('#app'); i++) await wait(250);
  return { dom, window, $, vis, click };
}

(async () => {
  /* 1. update available */
  {
    const { dom, window, $, vis } = await boot('2.6.0', '2.7.0');
    let shown = false;
    for (let i = 0; i < 40; i++) { if ($('#update-banner')) { shown = true; break; } await wait(250); }
    ok(shown, 'update banner appears when a newer release exists');
    ok(/2\.7\.0/.test(($('#update-banner') || {}).textContent || ''), 'banner names the new version');
    ok(/2\.6\.0/.test(($('#update-banner') || {}).textContent || ''), 'banner names the installed version');

    $('#update-now').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(400);
    ok(window.__installed === APK, '"Update now" hands the APK url to the native downloader');
    ok(/Download/.test($('#update-now').textContent), 'button switches to a downloading state');
    dom.window.close();
  }

  /* 2. Later dismisses + remembers */
  {
    const { dom, window, $ } = await boot('2.6.0', '2.7.0');
    for (let i = 0; i < 40 && !$('#update-banner'); i++) await wait(250);
    $('#update-later').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(300);
    ok(!$('#update-banner'), '"Later" dismisses the banner');
    ok(window.localStorage.getItem('ghost.skipUpdate') === '2.7.0', 'the skipped version is remembered');
    dom.window.close();
  }

  /* 3. already current -> silent */
  {
    const { dom, $ } = await boot('2.7.0', '2.7.0');
    await wait(2500);
    ok(!$('#update-banner'), 'no banner when the installed version is current');
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
