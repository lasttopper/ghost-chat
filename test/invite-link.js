/* Invite-link end-to-end test.
 * Usage: node test/invite-link.js "<invite url>"
 * Walks the real flow: open link → guest login → pick username → the app
 * auto-joins the group via ?join=CODE. Prints the outcome. */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const URL_ = process.argv[2];
if (!URL_) { console.error('usage: node test/invite-link.js <invite-url>'); process.exit(1); }

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function shimMatchMedia(w) {
  if (!w.matchMedia) {
    w.matchMedia = (q) => ({
      matches: false, media: q,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    });
  }
}

(async () => {
  const dom = await JSDOM.fromURL(URL_, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    virtualConsole: vc, beforeParse: shimMatchMedia,
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  let bad = 0;
  const fail = (m) => { console.log('FAIL:', m); bad = 1; };

  await wait(2500);
  if (!vis('#login')) fail('login not visible');
  $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);
  const user = 'linktest_' + Math.random().toString(36).slice(2, 6);
  $('#username-input').value = user;
  $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(4000);

  if (!vis('#app')) fail('app shell not visible');
  const toasts = [...window.document.querySelectorAll('.toast')].map((t) => t.textContent);
  const channels = [...window.document.querySelectorAll('#channel-list .ch-item .name')].map((n) => n.textContent);
  const active = $('#ch-name') ? $('#ch-name').textContent : '(none)';

  console.log('username:', user);
  console.log('active channel:', active);
  console.log('channel list:', JSON.stringify(channels));
  console.log('toasts:', JSON.stringify(toasts));

  const joined = toasts.find((t) => /^Joined/i.test(t));
  if (!joined) fail('no "Joined …" toast — invite code invalid/expired or flow broken');
  else if (active !== joined.replace(/^Joined (private group |group )?#/, '')) {
    console.log('note: active channel does not match the joined group name');
  } else console.log('INVITE JOIN OK:', joined);

  if (errors.length) { console.log('page errors:', errors.slice(0, 3)); bad = 1; }
  console.log(bad ? 'INVITE TEST FAILED' : 'INVITE TEST PASSED');
  process.exit(bad);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
