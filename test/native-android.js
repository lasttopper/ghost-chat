/* jsdom UI test for the native-Android -> web screenshot glue.
 * The WebView APK calls window.__ghostOnScreenshot() when the OS detects a
 * REAL screenshot (power+volume). This drives that exact entry point and checks
 * it posts the same in-chat "took a screenshot" notice as the desktop path —
 * and that rapid repeat calls are debounced (no spam).
 * (The native ContentObserver + notification bridge need a real device; this
 * covers the JS side the APK drives.)
 * Usage: node test/native-android.js [url]
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const url = process.argv[2] || 'http://127.0.0.1:3000/';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function shim(w) {
  if (!w.matchMedia) w.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
}

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = await JSDOM.fromURL(url, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc, beforeParse: shim });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const click = (s) => $(s).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await wait(2500);
  click('#guest-btn');
  await wait(400);
  $('#username-input').value = 'nat_' + Math.random().toString(36).slice(2, 8);
  click('#username-submit');

  // wait until the app shell is up
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await wait(300);
    if (!$('#app').classList.contains('hidden') && $('#messages')) { ready = true; break; }
  }
  ok(ready, 'app shell is up');
  await wait(800); // let init settle so S.active is set

  // 1) the native hook is exposed for the WebView app to call
  ok(typeof window.__ghostOnScreenshot === 'function', 'window.__ghostOnScreenshot is exposed for the native app');

  const shotCount = () => [...window.document.querySelectorAll('#messages .msg.system')]
    .map((n) => n.textContent).filter((t) => /screenshot/i.test(t));

  const before = shotCount().length;

  // 2) calling the native hook posts the in-chat notice
  window.__ghostOnScreenshot();
  await wait(1500);
  const afterFirst = shotCount();
  ok(afterFirst.length > before, 'calling __ghostOnScreenshot posts a "took a screenshot" notice');
  ok(/took a screenshot/i.test(afterFirst[afterFirst.length - 1] || ''), 'notice text is correct: ' + (afterFirst[afterFirst.length - 1] || '(none)'));

  // 3) rapid repeat calls are debounced (no notice spam)
  for (let i = 0; i < 12; i++) { window.__ghostOnScreenshot(); await wait(20); }
  await wait(600);
  ok(shotCount().length === afterFirst.length, 'rapid repeat calls are debounced (no spam): ' + shotCount().length + ' vs ' + afterFirst.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
