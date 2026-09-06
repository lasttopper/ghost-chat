/* Persistent-login test (jsdom, fresh page loads vs a real server).
 *
 * Requirement under test: "permanently logged in except manual logout" — a
 * page refresh (or browser reopen) must resume straight into the chat from a
 * durable session marker; ONLY the manual Sign-out button clears it and
 * returns the user to the login screen.
 *
 * Phase A: guest login + username  -> ghost.session marker is stamped, and a
 *          REFRESH (fresh page seeded with the exact post-login localStorage)
 *          lands in the app with NO click, NO login screen, NO username setup.
 * Phase B: manual Sign-out         -> ghost.session is cleared, and a fresh
 *          page seeded with the post-logout state shows the login screen.
 * Phase C: firebase-mode session   -> a seeded ghost.session{mode:firebase}
 *          resumes into the app synchronously (no waiting on the Firebase SDK
 *          and no login flash), which is the reported "refresh drops me out".
 * Usage: node test/persistent-login.js [url]
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');

const url = process.argv[2] || 'http://127.0.0.1:3000/';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
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

function dumpLS(window) {
  const out = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    out[k] = window.localStorage.getItem(k);
  }
  return out;
}

(async () => {
  const username = 'persist_' + Math.random().toString(36).slice(2, 8);
  let gid = null;
  let postLogin = null;

  /* ---------------- Phase A: login, then REFRESH ---------------- */
  console.log('phase A: login then refresh (must stay in the app)');
  {
    const dom = await bootPage(null);
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };

    await wait(2500);
    ok(vis('#login'), 'login screen shown to a first-time visitor');

    $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    $('#username-input').value = username;
    $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(3000);
    ok(vis('#app'), 'app shell visible after login');
    ok(meName(window.document) === '@' + username + ' (guest)', 'logged in as @' + username + ' (got ' + meName(window.document) + ')');

    const raw = window.localStorage.getItem('ghost.session');
    ok(!!raw, 'ghost.session marker stamped on entering the app');
    let sess = null; try { sess = JSON.parse(raw); } catch {}
    gid = window.localStorage.getItem('ghost.guestId');
    ok(sess && sess.authId === gid && sess.mode === 'guest', 'ghost.session holds the guest authId+mode (got ' + raw + ')');

    postLogin = dumpLS(window);
    dom.window.close();
  }

  {
    // Simulate a page refresh: brand-new page seeded with the exact
    // post-login localStorage. NO click — the app must resume on its own.
    console.log('phase A2: refresh resumes into the app with no click');
    const dom = await bootPage(postLogin);
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };

    await wait(3000);
    ok(!vis('#login'), 'login screen NOT shown after refresh');
    ok(!vis('#username-setup'), 'username-setup NOT shown after refresh');
    ok(vis('#app'), 'app shell visible after refresh (session resumed)');
    ok(meName(window.document) === '@' + username + ' (guest)', 'refresh resumed as @' + username + ' (got ' + meName(window.document) + ')');
    dom.window.close();
  }

  /* ---------------- Phase B: manual logout clears it ---------------- */
  console.log('phase B: manual Sign-out clears the session');
  {
    const dom = await bootPage(postLogin);
    const { window } = dom;
    const $ = (s) => window.document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.classList.contains('hidden'); };

    await wait(3000);
    ok(vis('#app'), 'resumed into the app before logout');
    $('#me-card button[title="Sign out"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(600);
    ok(window.localStorage.getItem('ghost.session') === null, 'logout CLEARS ghost.session');
    ok(window.localStorage.getItem('ghost.guestId') === gid, 'logout KEEPS guestId (name still recoverable)');

    // Post-logout state -> a fresh page must show the login screen again.
    const postLogout = dumpLS(window);
    dom.window.close();

    const dom2 = await bootPage(postLogout);
    const w2 = dom2.window;
    const vis2 = (s) => { const el = w2.document.querySelector(s); return !!el && !el.classList.contains('hidden'); };
    await wait(2500);
    ok(vis2('#login'), 'login screen shown again after manual logout (no silent resume)');
    ok(!vis2('#app'), 'app NOT visible after manual logout');
    dom2.window.close();
  }

  /* ---------------- Phase C: firebase-mode session resumes ---------------- */
  console.log('phase C: firebase session resumes without the SDK / login flash');
  {
    const fbUser = 'persistfb_' + Math.random().toString(36).slice(2, 8);
    const fbUid = 'fbuid-' + Math.random().toString(36).slice(2, 10);
    const seed = {
      'ghost.session': JSON.stringify({ authId: fbUid, mode: 'firebase', email: 'x@example.com', displayName: fbUser }),
      ['ghost.usernameFor.' + fbUid]: fbUser,
      ['ghost.colorFor.' + fbUid]: '#4f8cff',
    };
    const dom = await bootPage(seed);
    const { window } = dom;
    const vis = (s) => { const el = window.document.querySelector(s); return !!el && !el.classList.contains('hidden'); };

    await wait(2500);
    ok(!vis('#login'), 'firebase user: login screen NOT shown on refresh');
    ok(!vis('#username-setup'), 'firebase user: username-setup NOT shown on refresh');
    ok(vis('#app'), 'firebase user: app visible on refresh (session resumed synchronously)');
    ok(meName(window.document) === '@' + fbUser, 'firebase user resumed as @' + fbUser + ' (got ' + meName(window.document) + ')');
    dom.window.close();
  }

  /* --------- Phase D: firebase session stamped at login, pre-username --------- */
  console.log('phase D: firebase login stamped session before username -> refresh goes to setup, not login');
  {
    const fbUid = 'fbuid2-' + Math.random().toString(36).slice(2, 10);
    // Exactly what success() writes the instant Google sign-in succeeds, before
    // any username is chosen: a session marker but NO usernameFor yet.
    const seed = {
      'ghost.session': JSON.stringify({ authId: fbUid, mode: 'firebase', email: 'y@example.com', displayName: 'Jane Doe' }),
      ['ghost.colorFor.' + fbUid]: '#4f8cff',
    };
    const dom = await bootPage(seed);
    const { window } = dom;
    const vis = (s) => { const el = window.document.querySelector(s); return !!el && !el.classList.contains('hidden'); };

    await wait(2500);
    ok(!vis('#login'), 'pre-username firebase refresh: login screen NOT shown');
    ok(vis('#username-setup'), 'pre-username firebase refresh: username-setup shown (resumed, not bounced to login)');
    ok(!vis('#app'), 'pre-username firebase refresh: app not shown yet (no username)');
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
