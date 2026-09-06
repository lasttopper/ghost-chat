/* jsdom UI test for the invite QR code + "join with an invite link" feature.
 *   - creating a private group opens the invite modal with a rendered QR <svg>
 *   - the invite link input holds a ?join= URL
 *   - the "Join with a link" button opens the join modal
 *   - an invalid paste shows an error; a valid link/code is accepted (closes)
 * Usage: node test/invite-qr-ui.js [url]
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
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const click = (s) => $(s).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await wait(2500);
  ok(typeof window.qrcode === 'function', 'qrcode.js loaded (window.qrcode available)');

  click('#guest-btn');
  await wait(400);
  $('#username-input').value = 'qr_' + Math.random().toString(36).slice(2, 8);
  click('#username-submit');
  await wait(3000);
  ok(vis('#app'), 'app shell visible after login');

  // Create a PRIVATE group -> invite modal with QR
  const gname = 'qrgrp' + Math.random().toString(36).slice(2, 7);
  click('#add-channel');
  await wait(200);
  $('#new-channel-name').value = gname;
  const priv = window.document.querySelector('input[name="group-privacy"][value="private"]');
  priv.checked = true;
  click('#modal-create');
  await wait(2500);

  ok(vis('#invite-modal-backdrop'), 'invite modal opened after creating a private group');
  const qrSvgEl = $('#invite-qr svg');
  ok(!!qrSvgEl, 'a QR code <svg> is rendered in the invite modal');
  ok(qrSvgEl && qrSvgEl.querySelectorAll('rect').length > 50, 'QR svg has many modules (looks like a real QR)');
  const link = $('#invite-link').value;
  ok(/\?join=[\w-]+/.test(link), 'invite link holds a ?join= URL: ' + link.slice(0, 48) + '…');

  click('#invite-close');
  await wait(200);

  // Join-with-link modal
  click('#join-group');
  await wait(200);
  ok(vis('#join-modal-backdrop'), 'the "join with a link" modal opens');

  // invalid paste -> error shown, modal stays
  $('#join-code-input').value = 'not a link !!!';
  click('#join-submit');
  await wait(300);
  ok(vis('#join-error'), 'an invalid invite paste shows an error');
  ok(vis('#join-modal-backdrop'), 'modal stays open on invalid input');

  // valid full link -> accepted (modal closes)
  $('#join-code-input').value = link;
  click('#join-submit');
  await wait(800);
  ok(!vis('#join-modal-backdrop'), 'a valid invite link is accepted (modal closes, join sent)');

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
