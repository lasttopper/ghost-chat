/* jsdom regression for the "stuck on connecting" bug.
 *
 * Before the fix, submitting a username the server rejects (invalid or now
 * reserved) made the server send a generic `error`; the client only fired a
 * toast, so the app shell sat on "connecting…" forever with no way to pick a
 * new name. After the fix the server sends `need_username`, and the client
 * routes it to showUsernameSetup() — bouncing the user back to the username
 * screen with the reason instead of hanging.
 *
 * Usage: node test/stuck-connecting-ui.js [url]
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const url = process.argv[2] || 'http://127.0.0.1:3000/';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function shimMatchMedia(w) {
  if (!w.matchMedia) w.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
}

(async () => {
  // Simulate a legacy account whose locally cached handle is now RESERVED:
  // the session marker resumes it and the client re-joins with "admin",
  // which the server rejects with need_username (the one remaining path
  // that surfaces the setup screen, since first-timers are auto-named).
  const staleAuthId = 'stale-' + Math.random().toString(36).slice(2, 10);
  const seed = (window) => {
    shimMatchMedia(window);
    window.localStorage.setItem('ghost.session', JSON.stringify({ authId: staleAuthId, mode: 'guest', email: '', displayName: '' }));
    window.localStorage.setItem('ghost.usernameFor.' + staleAuthId, 'admin');
  };
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = await JSDOM.fromURL(url, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc, beforeParse: seed });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const click = (s) => $(s).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await wait(4000);               // resume -> join 'admin' -> need_username

  ok(vis('#username-setup'), 'reserved name -> bounced back to the setup screen (NOT stuck)');
  ok(!vis('#app'), 'app shell is not left hanging on "connecting…"');
  ok(/reserved/i.test($('#username-error').textContent || ''), 'setup screen explains why (reserved reason shown)');

  // Recovering with a valid name still works from that screen.
  $('#username-input').value = 'recover_' + Math.random().toString(36).slice(2, 8);
  click('#username-submit');
  await wait(3000);
  ok(vis('#app'), 'a valid name from the setup screen proceeds into the app');

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
