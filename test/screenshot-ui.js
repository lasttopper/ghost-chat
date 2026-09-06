/* jsdom UI test: the desktop screenshot shortcut posts a notice in the chat.
 * Simulates a PrintScreen keydown and checks a "took a screenshot" system
 * message appears. (Only the desktop keyboard signal is detectable on web.)
 * Usage: node test/screenshot-ui.js [url]
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
  $('#username-input').value = 'ssu_' + Math.random().toString(36).slice(2, 8);
  click('#username-submit');

  // wait until the app shell is up AND a conversation is active
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await wait(300);
    if (!$('#app').classList.contains('hidden') && $('#messages')) { ready = true; break; }
  }
  ok(ready, 'app shell is up');
  await wait(800); // let init settle so S.active is set

  const before = [...window.document.querySelectorAll('#messages .msg.system')]
    .map((n) => n.textContent).filter((t) => /screenshot/i.test(t)).length;

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PrintScreen', bubbles: true }));
  await wait(1500);

  const notices = [...window.document.querySelectorAll('#messages .msg.system')]
    .map((n) => n.textContent).filter((t) => /screenshot/i.test(t));
  ok(notices.length > before, 'PrintScreen posts a "took a screenshot" notice in the chat');
  ok(/took a screenshot/i.test(notices[notices.length - 1] || ''), 'notice text is correct: ' + (notices[notices.length - 1] || '(none)'));

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
