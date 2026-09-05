/* jsdom UI exercise: boots the deployed app, logs in as guest, and
 * verifies the new mobile-UX wiring (nav drawer, FAB, message list). */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const url = process.argv[2] || 'http://127.0.0.1:3000/';
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };

  await wait(2500);
  if (!vis('#login')) fail('login not visible'); else console.log('login visible ✓');

  // guest login -> username setup
  $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(400);
  if (!vis('#username-setup')) fail('username-setup not shown after guest click');
  else console.log('username-setup shown ✓');

  $('#username-input').value = 'uitest_' + Math.random().toString(36).slice(2, 8);
  $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(3000);

  if (!vis('#app')) fail('app shell not visible after username submit');
  else console.log('app shell visible ✓');

  // new mobile UX elements
  for (const sel of ['#menu-btn', '#nav-backdrop', '#scroll-bottom']) {
    if (!$(sel)) fail(sel + ' missing'); else console.log(sel + ' present ✓');
  }
  if (vis('#scroll-bottom')) fail('FAB should start hidden');

  // drawer open/close
  $('#menu-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(50);
  if (!window.document.body.classList.contains('nav-open')) fail('menu-btn did not open nav');
  else console.log('drawer opens on menu click ✓');

  $('#nav-backdrop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(50);
  if (window.document.body.classList.contains('nav-open')) fail('backdrop did not close nav');
  else console.log('backdrop closes drawer ✓');

  // channel switch should also close the drawer
  $('#menu-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const chBtn = window.document.querySelector('#channel-list .ch-item');
  if (chBtn) {
    chBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(200);
    if (window.document.body.classList.contains('nav-open')) fail('channel click did not close nav');
    else console.log('channel tap closes drawer ✓');
  }

  // messages rendered?
  const msgs = window.document.querySelectorAll('#messages .msg').length;
  console.log('messages rendered:', msgs);

  if (errors.length) { console.log('PAGE ERRORS:'); errors.forEach((e) => console.log(' -', e)); process.exitCode = 1; }
  else console.log('no page errors ✓');
  console.log(process.exitCode ? 'UI TEST FAILED' : 'UI TEST PASSED');
  window.close();
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
