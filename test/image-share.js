/* Image sharing tests:
 *  Part A - core: image messages flow through the socket + push correctly and
 *           only ImgBB URLs are accepted as attachments.
 *  Part B - POST /api/upload-image: forwards to ImgBB (mocked via
 *           IMGBB_API_URL), validates payloads, and fails safe without a key.
 * Usage: node test/image-share.js
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { createCore } = require('../core');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD_IMG = 'https://i.ibb.co/abc123DEF/photo.jpg';

class C {
  constructor() { this.inbox = []; this.ws = null; }
  connect(url) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => res());
      this.ws.on('message', (d) => { try { this.inbox.push(JSON.parse(d)); } catch {} });
      this.ws.on('error', rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  join(username) { this.send({ type: 'join', username, authId: 'guest-' + username, color: '#4f8cff' }); return this.waitFor((e) => e.type === 'init'); }
  waitFor(pred, timeout = 4000) {
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find(pred);
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > timeout) { clearInterval(iv); res(null); }
      }, 15);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function postJson(port, pathname, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

(async () => {
  console.log('image sharing test');

  /* ---------------- Part A: core message flow ---------------- */
  const pushes = [];
  const push = { enabled: true, sendTo: async (token, msg) => { pushes.push({ token, ...msg }); return 'ok'; } };
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const core = createCore(null, { push });
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';
  const sfx = Math.random().toString(36).slice(2, 6);

  const a = new C(), b = new C();
  await a.connect(url); await b.connect(url);
  await a.join('img_a' + sfx);
  await b.join('img_b' + sfx);
  // register b for push, then take it offline
  b.send({ type: 'push_register', token: 'TOK_IMG_' + sfx + '_aaaaaaaaaaaaaaaaaaaa' });
  await wait(120);
  b.close();
  await wait(400); // let the server process the socket close

  // 1. image-only message
  a.send({ type: 'message', channel: 'general', image: GOOD_IMG });
  const m1 = await a.waitFor((e) => e.type === 'message' && e.message.image === GOOD_IMG);
  ok(!!m1 && m1.message.text === '' && m1.message.username === 'img_a' + sfx, 'image-only message broadcast with empty text');

  // 2. image + caption
  a.send({ type: 'message', channel: 'general', text: 'look at this', image: GOOD_IMG });
  const m2 = await a.waitFor((e) => e.type === 'message' && e.message.text === 'look at this' && e.message.image === GOOD_IMG);
  ok(!!m2, 'image + caption both carried');

  // 3. non-ImgBB URL with text -> text survives, image stripped
  a.send({ type: 'message', channel: 'general', text: 'evil img', image: 'https://evil.example.com/x.jpg' });
  const m3 = await a.waitFor((e) => e.type === 'message' && e.message.text === 'evil img');
  ok(!!m3 && !m3.message.image, 'foreign image host stripped, text kept');

  // 4. non-ImgBB URL without text -> whole message dropped
  const before = a.inbox.length;
  a.send({ type: 'message', channel: 'general', image: 'javascript:alert(1)' });
  await wait(300);
  const gotJunk = a.inbox.slice(before).some((e) => e.type === 'message' && e.message.username === 'img_a' + sfx);
  ok(!gotJunk, 'image-only message with invalid host dropped entirely');

  // 5. push for image-only message: body fallback + data.image
  await wait(300);
  const p = pushes.find((x) => x.data && x.data.image === GOOD_IMG);
  ok(!!p && p.body === '\u{1F4F7} Photo' && p.title.includes('@img_a' + sfx), "push for photo: body 'Photo', data.image set");

  a.close();
  server.close();
  wss.close();

  /* ---------------- Part B: upload endpoint ---------------- */

  // Mock ImgBB: /1/upload succeeds; /1/broken fails like ImgBB does.
  const imgbb = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/1/broken')) {
        res.writeHead(400).end(JSON.stringify({ status_code: 400, error: { message: 'forbidden', code: 103 }, success: false }));
      } else {
        const hasKey = /key=/.test(body) && /image=/.test(body);
        if (!hasKey) { res.writeHead(400).end(JSON.stringify({ success: false, error: { message: 'missing fields' } })); return; }
        res.writeHead(200).end(JSON.stringify({ success: true, data: { url: 'https://i.ibb.co/z9z9z9/up.png', display_url: 'x' } }));
      }
    });
  });
  await new Promise((r) => imgbb.listen(0, '127.0.0.1', r));
  const imgbbPort = imgbb.address().port;

  const DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-img-')), 'data.json');
  const boot = (env, port) => new Promise((resolve) => {
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port), PULSE_DATA: DATA, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tryConnect = (tries) => {
      const sock = require('net').connect(port, '127.0.0.1', () => { sock.destroy(); resolve(srv); });
      sock.on('error', () => { sock.destroy(); if (tries > 0) setTimeout(() => tryConnect(tries - 1), 150); else resolve(srv); });
    };
    tryConnect(40);
  });

  const P1 = 3971, P2 = 3972;
  const srvNoKey = await boot({}, P1);
  const srvKeyed = await boot({
    IMGBB_API_KEY: 'test-key',
    IMGBB_API_URL: `http://127.0.0.1:${imgbbPort}/1/upload`,
  }, P2);

  // 6. no key configured -> 503
  const r503 = await postJson(P1, '/api/upload-image', { image: 'data:image/png;base64,' + PNG_1PX });
  ok(r503.status === 503 && r503.json && r503.json.ok === false, 'uploads disabled without IMGBB_API_KEY (503)');

  // 7. bad payloads -> 400
  const rBad1 = await postJson(P2, '/api/upload-image', 'not json at all');
  const rBad2 = await postJson(P2, '/api/upload-image', { image: 'data:text/html;base64,PHNjcmlwdD4=' });
  ok(rBad1.status === 400 && rBad2.status === 400, 'malformed / non-image payloads rejected (400)');

  // 8. happy path -> url from the host
  const rOk = await postJson(P2, '/api/upload-image', { image: 'data:image/png;base64,' + PNG_1PX });
  ok(rOk.status === 200 && rOk.json && rOk.json.ok === true && /^https:\/\/i\.ibb\.co\//.test(rOk.json.url || ''), 'upload proxied to ImgBB, direct url returned');

  // 9. ImgBB rejection -> 502 (key present but host says no)
  const srvBroken = await boot({
    IMGBB_API_KEY: 'test-key',
    IMGBB_API_URL: `http://127.0.0.1:${imgbbPort}/1/broken`,
  }, 3973);
  const rBad = await postJson(3973, '/api/upload-image', { image: 'data:image/png;base64,' + PNG_1PX });
  ok(rBad.status === 502 && rBad.json && rBad.json.ok === false, 'image host rejection surfaced as 502');

  srvNoKey.kill(); srvKeyed.kill(); srvBroken.kill(); imgbb.close();
  await wait(150);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(1); });
