/* Logout → login recovery test (jsdom, multiple fresh page loads vs a real
 * server). Verifies the reported bug is fixed: logging out then back in must
 * NOT force the username-setup screen again.
 *
 * Phase A: guest login + pick username + logout.
 *          localStorage must KEEP ghostId + colorFor + a knownName recovery
 *          copy, and DROP usernameFor + autoAuth (so the login screen still
 *          shows instead of silently auto-resuming).
 * Phase B: brand-new page seeded with the REAL post-logout state
 *          (guestId + colorFor + knownName) → click "Continue as guest" →
 *          the client adopts knownName locally (no server needed), so this
 *          works even if the server's ephemeral memory was wiped.
 * Phase C: brand-new page seeded WITHOUT knownName (guestId + colorFor only)
 *          → falls back to the server resolving the username by authId.
 * Usage: node test/logout-login-recovery.js [url]
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const url = process.argv[2] || 'http://127.0.0.1:3000/';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const meName = (doc) => { const el = doc.querySelector('#me-card .me-name'); return el ? el.textContent : null; };

function shimMatchMedia(w) {
  if (!w.matchMedia) {
    w.matchMedia = (q) => ({
      matches: false, media: q,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    });
  }
}

function makeConsole() {
  const vc = new VirtualConsole();
  // ignore jsdom's "Not implemented: navigation" from location.reload()
  vc.on('jsdomError', (e) => {
    if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message);
  });
  return vc;
}

async function bootPage(seed) {
  const vc = makeConsole();
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse: (w) => {
      shimMatchMedia(w);
      if (seed) for (const [k, v] of Object.entries(seed)) {
        try { w.localStorage.setItem(k, v); } catch {}
      }
    },
  });
  return dom;
}

(async () => {
  const username = 'recover_' + Math.random().toString(36).slice(2, 8);
  let gid = null, color = null;

  /* ---------------- Phase A: login, then logout ---------------- */
  console.log('phase A: fresh login + logout');
  {
    const dom = await bootPage(null);
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };

    await wait(2500);
    ok(vis('#login'), 'login screen shown');

    $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    ok(vis('#username-setup'), 'username-setup shown for brand-new guest');

    $('#username-input').value = username;
    $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(3000);
    ok(vis('#app'), 'app shell visible after username submit');
    ok(meName(window.document) === '@' + username + ' (guest)', '#me-card .me-name shows @' + username + ' (got ' + meName(window.document) + ')');

    gid = window.localStorage.getItem('ghost.guestId');
    color = window.localStorage.getItem('ghost.colorFor.' + gid);
    ok(!!gid, 'guestId stored: ' + gid);
    ok(window.localStorage.getItem('ghost.usernameFor.' + gid) === username, 'usernameFor stored while logged in');

    // logout (location.reload() is "Not implemented" in jsdom and ignored —
    // the localStorage effects happen before it)
    $('#me-card button[title="Sign out"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(600);

    ok(window.localStorage.getItem('ghost.guestId') === gid, 'logout KEEPS guestId');
    ok(window.localStorage.getItem('ghost.colorFor.' + gid) === color, 'logout KEEPS colorFor');
    ok(window.localStorage.getItem('ghost.knownName.' + gid) === username, 'logout KEEPS a knownName recovery copy');
    ok(window.localStorage.getItem('ghost.usernameFor.' + gid) === null, 'logout drops usernameFor');
    ok(window.localStorage.getItem('ghost.autoAuth') === null, 'logout drops autoAuth');
    dom.window.close();
  }

  /* -------- Phase B: re-login with the real post-logout state -------- */
  console.log('phase B: re-login with kept identity + knownName (client-side recovery)');
  {
    const dom = await bootPage({
      'ghost.guestId': gid,
      ['ghost.colorFor.' + gid]: color,
      ['ghost.knownName.' + gid]: username,
    });
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };

    await wait(2500);
    ok(vis('#login'), 'login screen shown (no silent auto-resume after logout)');

    $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(3000);

    ok(vis('#app'), 'app shell visible after re-login');
    ok(!vis('#username-setup'), 'username-setup NOT shown (knownName adopted)');
    ok(meName(window.document) === '@' + username + ' (guest)', '#me-card .me-name recovered @' + username + ' (got ' + meName(window.document) + ')');
    ok(window.localStorage.getItem('ghost.usernameFor.' + gid) === username, 'usernameFor re-cached locally');
    ok($('#me-card .avatar').textContent !== '…', 'avatar no longer placeholder (got ' + $('#me-card .avatar').textContent + ')');
    dom.window.close();
  }

  /* -------- Phase C: no knownName → server resolves by authId -------- */
  console.log('phase C: re-login without knownName (server-side fallback)');
  {
    const dom = await bootPage({ 'ghost.guestId': gid, ['ghost.colorFor.' + gid]: color });
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };

    await wait(2500);
    $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(3000);

    ok(vis('#app'), 'app shell visible after re-login');
    ok(!vis('#username-setup'), 'username-setup NOT shown (server resolved by authId)');
    ok(meName(window.document) === '@' + username + ' (guest)', '#me-card .me-name recovered @' + username + ' via server (got ' + meName(window.document) + ')');
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
