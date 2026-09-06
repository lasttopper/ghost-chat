/* jsdom UI test for the group-admin members modal.
 * Logs in as a guest, creates a PRIVATE group through the real UI, then opens
 * the Members modal and checks the admin view (owner badge, add-member panel,
 * no remove control for the owner). Also checks a non-private channel hides
 * the Members button.
 * Usage: node test/group-admin-ui.js [url]
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const url = process.argv[2] || 'http://127.0.0.1:3000/';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function shimMatchMedia(w) {
  if (!w.matchMedia) {
    w.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  }
}

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse: shimMatchMedia,
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const click = (s) => $(s).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await wait(2500);
  ok(vis('#login'), 'login visible');
  click('#guest-btn');
  await wait(400);
  $('#username-input').value = 'uiadm_' + Math.random().toString(36).slice(2, 8);
  click('#username-submit');
  await wait(3000);
  ok(vis('#app'), 'app shell visible after login');

  // Members button hidden on the default public channel
  ok(!vis('#members-btn'), 'Members button hidden on a public channel');

  // create a PRIVATE group via the real modal
  click('#add-channel');
  await wait(200);
  $('#new-channel-name').value = 'uigrp-' + Math.random().toString(36).slice(2, 6);
  const priv = window.document.querySelector('input[name="group-privacy"][value="private"]');
  priv.checked = true;
  click('#modal-create');
  await wait(2500);

  ok(vis('#members-btn'), 'Members button visible on the private group');

  // open the members modal
  click('#members-btn');
  await wait(300);
  ok(vis('#members-modal-backdrop'), 'Members modal opens');
  const rows = window.document.querySelectorAll('#member-list .member-row');
  ok(rows.length === 1, 'member list shows the 1 current member (got ' + rows.length + ')');
  ok(!!window.document.querySelector('#member-list .role-badge.owner'), 'creator row carries the owner badge');
  ok(vis('#add-member-wrap'), 'add-member panel shown to the admin');
  // owner must not have a Remove control
  ok(window.document.querySelectorAll('#member-list .member-row .mini-btn.danger').length === 0, 'owner row has no Remove button');

  // close via Done
  click('#members-close');
  await wait(200);
  ok(!vis('#members-modal-backdrop'), 'Members modal closes');

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
