/* screenshot-notice test (in-process core, guest client).
 *   - reporting a screenshot posts a "took a screenshot" system notice in the conv
 *   - it is broadcast to other members
 *   - it is rate-limited (a second report within 10s does not spam)
 * Usage: node test/screenshot.js
 */
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { createCore } = require('../core');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };

class C {
  constructor(tag) { this.tag = tag; this.inbox = []; this.ws = null; }
  connect(url) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => res());
      this.ws.on('message', (d) => { try { this.inbox.push(JSON.parse(d)); } catch {} });
      this.ws.on('error', rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  join(username) { this.send({ type: 'join', username, authId: 'guest-' + username, guest: true, color: '#4f8cff' }); return this.waitFor('init'); }
  countShotNotices() { return this.inbox.filter((x) => x.type === 'message' && x.message.system && /took a screenshot/i.test(x.message.text)).length; }
  waitFor(type, pred, timeout = 5000) {
    if (typeof pred === 'number') { timeout = pred; pred = null; }
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find((x) => x.type === type && (!pred || pred(x)));
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > timeout) { clearInterval(iv); res(null); }
      }, 15);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('screenshot-notice test');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const core = createCore(null);
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';
  const sfx = Math.random().toString(36).slice(2, 6);
  const A = 'ss_a_' + sfx, B = 'ss_b_' + sfx, gid = 'ssgrp' + sfx;

  const a = new C('a'), b = new C('b');
  await a.connect(url); await b.connect(url);
  await a.join(A); await b.join(B);

  a.send({ type: 'create_channel', name: gid, private: true });
  await a.waitFor('channel_created', (m) => m.channel && m.channel.id === gid);
  a.send({ type: 'add_member', channelId: gid, username: B });
  await b.waitFor('channel_joined', (m) => m.channel && m.channel.id === gid);

  // A reports a screenshot in the group
  a.send({ type: 'screenshot', channel: gid });
  const notice = await a.waitFor('message', (m) => m.message.system && /took a screenshot/i.test(m.message.text));
  ok(!!notice, 'reporting a screenshot posts a "took a screenshot" notice');
  ok(notice && notice.message.text.includes(A), 'the notice names the user who screenshotted');

  // B (the other member) also sees it
  const seenByB = await b.waitFor('message', (m) => m.message.system && /took a screenshot/i.test(m.message.text));
  ok(!!seenByB, 'the screenshot notice is broadcast to other members');

  // Rate limit: an immediate second report should NOT create another notice
  const before = a.countShotNotices();
  a.send({ type: 'screenshot', channel: gid });
  await new Promise((r) => setTimeout(r, 600));
  ok(a.countShotNotices() === before, 'a second report within 10s is rate-limited (no spam)');

  a.close(); b.close(); wss.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
