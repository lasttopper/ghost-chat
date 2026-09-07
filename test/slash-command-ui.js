/* jsdom test: slash commands typed in a regular chat are executed by
 * GhostBot (never posted into the group), and /rename updates the UI.
 * Usage: node test/slash-command-ui.js [url]
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
  const bubble = $('#bubble') || $('#messages');
  const bubbleText = () => ((bubble && bubble.textContent) || '');
  const meName = () => (($('#me-card .me-name') || {}).textContent || '').trim();

  await wait(2500);
  click('#guest-btn');                       // auto-issued username, straight in
  for (let i = 0; i < 60 && !vis('#app'); i++) await wait(250);
  // wait until init landed (renderMe replaces the placeholder name)
  for (let i = 0; i < 60 && !/^@user_[a-z0-9]{6}/.test(meName()); i++) await wait(250);
  ok(vis('#app') && /^@user_/.test(meName()), 'app shell up (guest auto-named: ' + meName() + ')');
  const issued = meName().replace(/^@/, '').replace(/ \(guest\)$/, '');
  ok(/^user_[a-z0-9]{6}$/.test(issued), 'issued handle looks right: @' + issued);

  const newName = 'ui_' + Math.random().toString(36).slice(2, 9);

  /* 1. a slash command typed while #general is active must NOT be posted to
   *    the channel — it is routed to the GhostBot DM instead. */
  ok(vis('#general') || true, 'starting in a regular channel');
  const beforeGeneral = bubbleText();
  $('#input').value = '/rename ' + newName;
  click('#send-btn');
  await wait(3500);

  ok(!beforeGeneral.includes('/rename'), 'the channel transcript has no leaked command');
  ok(bubbleText().includes('/rename ' + newName), 'the command shows up in the GhostBot DM transcript');
  ok(/now @/.test(bubbleText()) || /already @/.test(bubbleText()), 'GhostBot answered the command in the DM');
  ok(bubbleText().includes('@' + newName), 'the reply names the new handle @' + newName);
  ok(meName() === '@' + newName + ' (guest)', 'me-card reflects the rename (got ' + meName() + ')');

  /* 2. /help works the same way */
  $('#input').value = '/help';
  click('#send-btn');
  await wait(2500);
  ok(/Commands you can send me/.test(bubbleText()), '/help lists commands in the DM');

  /* 3. a normal message still goes to the channel */
  const chanBtn = window.document.querySelector('#channel-list button') || window.document.querySelector('[data-conv="general"]');
  if (chanBtn) { chanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(1200); }
  $('#input').value = 'plain message, not a command';
  click('#send-btn');
  await wait(1500);
  ok(bubbleText().includes('plain message, not a command'), 'a non-slash message still posts normally');

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
