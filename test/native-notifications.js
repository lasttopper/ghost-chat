/* WebView APK notification bridge (web side), end-to-end against the real
 * core over WS with a mock window.AndroidBridge:
 *   1. notifications are ON BY DEFAULT inside the APK (regression: they used
 *      to default OFF because a WebView has no Notification constructor),
 *   2. an incoming message while backgrounded reaches AndroidBridge.showNotification,
 *   3. the 🔕 toggle mutes, and re-enabling resumes.
 * Usage: node test/native-notifications.js
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
const WS = require('ws');
const { createCore } = require('../core');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \u2713', m); };
const bad = (m, e) => { fail++; console.log('  \u2717', m, '::', (e && e.message) || e); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (cond, timeout = 6000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => { let v = false; try { v = cond(); } catch {} if (v) return resolve(); if (Date.now() - t0 > timeout) return reject(new Error('timeout')); setTimeout(tick, 20); };
  tick();
});

(async () => {
  const core = createCore(null);
  const wss = new WS.Server({ port: 0 });
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;

  const calls = [];
  let hidden = false;

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(e.message)) console.log('  JSDOM ERROR:', e.message); });
  const dom = new JSDOM(HTML, { url: `http://localhost:${port}/`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const sockets = [];
  window.WebSocket = class extends WS { constructor(u, p) { super(u, p); sockets.push(this); } };
  window.AndroidBridge = {
    isNative: () => true,
    showNotification: (t, b, tag) => { calls.push({ t, b, tag }); },
    hasNotificationPermission: () => true,
    requestNotificationPermission: () => {},
  };
  window.eval(APP);
  const $ = (s) => window.document.querySelector(s);

  try {
    // log in as a guest
    await waitFor(() => $('#guest-btn') && !$('#login').classList.contains('hidden'));
    $('#guest-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => !$('#username-setup').classList.contains('hidden'));
    $('#username-input').value = 'notifme';
    $('#username-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => $('#me-status') && $('#me-status').textContent === 'online');
    ok('app is online as @notifme');

    // simulate the app being backgrounded (page hidden)
    Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
    hidden = true;

    // a second user sends a message into #general
    const b = new WS(`ws://localhost:${port}/ws`);
    await new Promise((r) => b.once('open', r));
    const bSend = (o) => b.send(JSON.stringify(o));
    const bWait = (type) => new Promise((res) => {
      const h = (d) => { const m = JSON.parse(d); if (m.type === type) { b.off('message', h); res(m); } };
      b.on('message', h);
    });
    bSend({ type: 'join', username: 'sender', authId: 'guest-sender', guest: true, color: '#0f0' });
    await bWait('init');

    bSend({ type: 'message', channel: 'general', text: 'hello from sender' });
    await waitFor(() => calls.length >= 1);
    ok('notification reaches native BY DEFAULT (no toggle needed)');
    assert(/sender/.test(calls[0].t), 'title names the sender: ' + calls[0].t);
    assert.strictEqual(calls[0].b, 'hello from sender');
    ok('title/body carry the sender and the message text');

    // mute via the header toggle
    $('#notif-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(150);
    const n1 = calls.length;
    bSend({ type: 'message', channel: 'general', text: 'second message' });
    await wait(1200);
    assert.strictEqual(calls.length, n1, 'muted but a notification fired anyway');
    ok('the 🔕 toggle mutes native notifications');

    // re-enable
    $('#notif-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(150);
    bSend({ type: 'message', channel: 'general', text: 'third message' });
    await waitFor(() => calls.length > n1);
    ok('re-enabling resumes native notifications');

    try { b.close(); } catch {}
  } catch (e) { bad('notification bridge flow', e); }

  for (const s of sockets) { try { s.onclose = null; s.onmessage = null; s.close(); } catch {} }
  try { dom.window.close(); } catch {}
  wss.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
