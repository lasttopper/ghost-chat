/* jsdom UI test: the mobile drawer hides itself as soon as the user picks
 * anything from the sidebar (channel, person, or the create/join buttons),
 * and stays open when tapping non-navigation chrome.
 * Usage: node test/sidebar-nav.js [url]
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
  const clickEl = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const click = (s) => clickEl($(s));
  const navOpen = () => window.document.body.classList.contains('nav-open');

  await wait(2500);
  click('#guest-btn');
  await wait(400);
  // (no username step: the server auto-issues a unique handle on join)

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await wait(300);
    if (!$('#app').classList.contains('hidden') && $('#channel-list') && $('#channel-list').children.length) { ready = true; break; }
  }
  ok(ready, 'app shell is up with channels listed');
  await wait(500);

  // 1. open drawer, tap a channel -> drawer hides
  click('#menu-btn');
  ok(navOpen(), 'menu button opens the drawer');
  clickEl($('#channel-list').children[0]);
  await wait(150);
  ok(!navOpen(), 'tapping a group in the sidebar hides the drawer');

  // 2. open drawer, tap the create-group button -> drawer hides (modal shows)
  click('#menu-btn');
  click('#add-channel');
  await wait(150);
  ok(!navOpen(), 'tapping the create-group button hides the drawer');
  ok(!$('#modal-backdrop').classList.contains('hidden'), '...and the create-group dialog is shown');
  click('#modal-cancel');

  // 3. open drawer, tap a person (opens DM) -> drawer hides
  const person = $('#team-list').children[0];
  click('#menu-btn');
  if (person) {
    clickEl(person);
    await wait(250);
    ok(!navOpen(), 'tapping a person in the sidebar hides the drawer');
  } else {
    ok(true, 'tapping a person in the sidebar hides the drawer (no people listed - skipped)');
  }

  // 4. non-navigation chrome keeps the drawer open
  click('#menu-btn');
  clickEl($('.ws-header'));
  await wait(150);
  ok(navOpen(), 'tapping the workspace header does NOT close the drawer');

  // 5. backdrop still closes (regression)
  click('#nav-backdrop');
  ok(!navOpen(), 'backdrop tap still closes the drawer');

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
