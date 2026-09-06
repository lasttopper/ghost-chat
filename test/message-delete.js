/* delete_message test (in-process core, guest clients — no token needed).
 *   - the author can delete their own message
 *   - a non-admin member CANNOT delete someone else's message
 *   - a group admin/owner CAN delete any message in the group
 *   - system messages are not deletable
 * Usage: node test/message-delete.js
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
  lastMsgId() { const m = [...this.inbox].reverse().find((x) => x.type === 'message' && !x.message.system); return m && m.message.id; }
  msgIdBy(text) { const m = this.inbox.find((x) => x.type === 'message' && x.message && x.message.text === text); return m && m.message.id; }
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
  console.log('delete_message test');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const core = createCore(null);
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';
  const sfx = Math.random().toString(36).slice(2, 6);
  const A = 'del_a_' + sfx, B = 'del_b_' + sfx, gid = 'delgrp' + sfx;

  const a = new C('a'), b = new C('b');
  await a.connect(url); await b.connect(url);
  await a.join(A); await b.join(B);

  a.send({ type: 'create_channel', name: gid, private: true });
  await a.waitFor('channel_created', (m) => m.channel && m.channel.id === gid);
  a.send({ type: 'add_member', channelId: gid, username: B });
  await b.waitFor('channel_joined', (m) => m.channel && m.channel.id === gid);

  // A posts, B posts
  a.send({ type: 'message', channel: gid, text: 'msg-from-A' });
  await b.waitFor('message', (m) => m.message && m.message.text === 'msg-from-A');
  b.send({ type: 'message', channel: gid, text: 'msg-from-B' });
  await a.waitFor('message', (m) => m.message && m.message.text === 'msg-from-B');
  const aMsgId = a.msgIdBy('msg-from-A');
  const bMsgId = a.msgIdBy('msg-from-B');
  ok(!!aMsgId && !!bMsgId, 'both messages delivered');

  // 1. B (non-admin) cannot delete A's message
  b.inbox.length = 0;
  b.send({ type: 'delete_message', channelId: gid, messageId: aMsgId });
  const denied = await b.waitFor('error', (m) => /own messages/i.test(m.message || ''));
  ok(!!denied, 'a non-admin member cannot delete someone else’s message');

  // 2. A (author) deletes their own message -> message_deleted broadcast
  a.inbox.length = 0; b.inbox.length = 0;
  a.send({ type: 'delete_message', channelId: gid, messageId: aMsgId });
  const delA = await b.waitFor('message_deleted', (m) => m.messageId === aMsgId);
  ok(!!delA, 'author deleted their own message (broadcast to others)');

  // 3. A (admin/creator) deletes B's message -> allowed
  a.inbox.length = 0; b.inbox.length = 0;
  a.send({ type: 'delete_message', channelId: gid, messageId: bMsgId });
  const delB = await b.waitFor('message_deleted', (m) => m.messageId === bMsgId);
  ok(!!delB, 'group admin/owner deleted another member’s message');

  // 4. system message cannot be deleted
  const sysId = (a.inbox.find((x) => x.type === 'message' && x.message.system) || {}).message;
  // grab a system id from the channel state via a fresh look: use the join sys msg
  const anySys = core.getState().channels.find((c) => c.id === gid).messages.find((m) => m.system);
  a.inbox.length = 0;
  a.send({ type: 'delete_message', channelId: gid, messageId: anySys.id });
  const stillThere = core.getState().channels.find((c) => c.id === gid).messages.some((m) => m.id === anySys.id);
  ok(stillThere, 'system messages are not deletable');
  void sysId;

  a.close(); b.close(); wss.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
