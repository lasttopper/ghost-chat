/* Core-level FCM push integration test (in-process core, mock push sender):
 *   - online members get the socket message, NOT a push
 *   - a member whose socket closed receives a push (title/body/conv)
 *   - system messages are never pushed
 *   - push_unregister stops pushes; an 'invalid' send result drops the token
 * Usage: node test/push.js
 */
'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createCore } = require('../core');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  waitFor(type, timeout = 4000) {
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find((x) => x.type === type);
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > timeout) { clearInterval(iv); res(null); }
      }, 15);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('push (FCM) test');
  const pushes = [];
  let nextResult = 'ok';
  const push = {
    enabled: true,
    sendTo: async (token, msg) => { pushes.push({ token, ...msg }); return nextResult; },
  };

  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const core = createCore(null, { push });
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';
  const sfx = Math.random().toString(36).slice(2, 6);

  const a = new C('a'), b = new C('b');
  await a.connect(url); await b.connect(url);
  await a.join('pa_' + sfx); await b.join('pb_' + sfx);
  a.send({ type: 'push_register', token: 'TOK_A_' + sfx + '_aaaaaaaaaaaaaaaaaaaa' });
  await wait(150);

  // 1. both online -> socket delivery, no push
  b.send({ type: 'message', channel: 'general', text: 'while-youre-here' });
  await a.waitFor('message');
  await wait(200);
  ok(pushes.length === 0, 'online members are not pushed (socket delivery only)');

  // 2. A goes offline -> push arrives for A
  a.close();
  await wait(400); // let the server process the socket close
  b.send({ type: 'message', channel: 'general', text: 'offline-hello' });
  await wait(400);
  const p1 = pushes.find((p) => p.title && p.body === 'offline-hello');
  ok(!!p1, 'offline member receives a push for a new message');
  ok(p1 && p1.token === 'TOK_A_' + sfx + '_aaaaaaaaaaaaaaaaaaaa', 'push targets the registered device token');
  ok(p1 && /pb_/.test(p1.title) && /general/.test(p1.title), 'title names the sender + channel: ' + (p1 && p1.title));
  ok(p1 && p1.data && p1.data.conv === 'general', 'payload carries the conversation id');

  // 3. system notices are never pushed
  const before = pushes.length;
  b.send({ type: 'screenshot', channel: 'general' });
  await wait(300);
  ok(pushes.length === before, 'system messages (screenshot notice) are not pushed');

  // 4. sender never gets pushed their own message (B has no token anyway) —
  //    and 'invalid' results prune the dead token
  nextResult = 'invalid';
  b.send({ type: 'message', channel: 'general', text: 'prune-me' });
  await wait(300);
  const beforePrune = pushes.length;
  nextResult = 'ok';
  b.send({ type: 'message', channel: 'general', text: 'after-prune' });
  await wait(300);
  ok(pushes.length === beforePrune, "an 'invalid' send result prunes the dead device token (no further attempts)");

  // 5. explicit unregister
  const a2 = new C('a2');
  await a2.connect(url);
  await a2.join('pa_' + sfx);
  a2.send({ type: 'push_register', token: 'TOK_A2_' + sfx + '_bbbbbbbbbbbbbbbbbbb' });
  await wait(150);
  a2.send({ type: 'push_unregister' });
  await wait(150);
  a2.close();
  await wait(400);
  const beforeUnreg = pushes.length;
  b.send({ type: 'message', channel: 'general', text: 'after-unregister' });
  await wait(300);
  ok(pushes.length === beforeUnreg, 'push_unregister stops pushes for that user');

  a.close(); b.close(); a2.close();
  wss.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
