/* jsdom UI check for the GhostBot assistant:
 *   - after login, the assistant DM appears in the DM list with a 🤖 badge
 *   - the assistant is NOT listed in the People list (it's a bot, not a person)
 *   - opening the assistant DM shows its guide message
 * Usage: node test/assistant-ui.js [url]
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
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = await JSDOM.fromURL(url, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc, beforeParse: shimMatchMedia });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };
  const click = (s) => $(s).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await wait(2500);
  click('#guest-btn');
  await wait(400);
  $('#username-input').value = 'uiasst_' + Math.random().toString(36).slice(2, 8);
  click('#username-submit');
  await wait(3000);
  ok(vis('#app'), 'app shell visible after login');

  // assistant DM present in the DM list, with a bot badge
  const dmItems = [...window.document.querySelectorAll('#dm-list .dm-item')];
  const botDm = dmItems.find((el) => /ghostbot/i.test(el.textContent));
  ok(!!botDm, 'assistant DM appears in the DM list');
  ok(!!(botDm && botDm.querySelector('.bot-badge')), 'assistant DM carries the 🤖 badge');

  // assistant is NOT in the People list
  const people = [...window.document.querySelectorAll('#team-list .team-item')].map((el) => el.textContent);
  ok(!people.some((t) => /ghostbot/i.test(t)), 'assistant is not listed as a person in the People list');

  // open the assistant DM -> its guide message is rendered
  if (botDm) botDm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);
  const msgs = [...window.document.querySelectorAll('#messages .msg-text')].map((n) => n.textContent).join('\n');
  ok(/GhostBot|guide|Groups/i.test(msgs), 'assistant guide message is rendered in the DM');

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
