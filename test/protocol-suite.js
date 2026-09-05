/* Shared protocol assertions — run against ANY server exposing the Pulse
 * WebSocket protocol on ws://127.0.0.1:<PORT>/ws (standalone or Vercel
 * handler harness). Returns { passed, failed }. */
'use strict';

const WebSocket = require('ws');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.events = []; this.ws = null; }
  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => this.events.push(JSON.parse(raw)));
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  async waitFor(pred, label, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ev = this.events.find(pred);
      if (ev) return ev;
      await wait(25);
    }
    throw new Error('timeout waiting for: ' + label);
  }
  close() { this.ws.close(); }
}

module.exports = async function runSuite(PORT) {
  const URL = `ws://127.0.0.1:${PORT}/ws`;
  let passed = 0, failed = 0;
  const ok = (cond, label) => {
    if (cond) { passed++; console.log('  PASS  ' + label); }
    else { failed++; console.error('  FAIL  ' + label); }
  };

  const A = new Client(), B = new Client();
  await A.connect(URL); await B.connect(URL);

  /* 1. join -> init with seeded channels */
  A.send({ type: 'join', username: 'alice', color: '#f43f5e' });
  B.send({ type: 'join', username: 'bob', color: '#10b981' });
  const initA = await A.waitFor((e) => e.type === 'init', 'A receives init');
  ok(initA.channels.some((c) => c.id === 'general') && initA.channels.some((c) => c.id === 'random'),
    'init contains seeded channels #general and #random');
  ok(initA.channels.find((c) => c.id === 'general').messages.length >= 2, 'seeded welcome messages present');
  const presB = await B.waitFor((e) => e.type === 'presence' && e.online.includes('alice') && e.online.includes('bob'),
    'presence lists alice and bob');
  ok(!!presB, 'presence includes both users after joins');

  /* 2. message broadcast */
  A.send({ type: 'message', channel: 'general', text: 'hello from alice' });
  const msgB = await B.waitFor((e) => e.type === 'message' && e.message.username === 'alice', 'B receives alice message');
  ok(msgB.message.text === 'hello from alice' && msgB.message.channel === 'general', 'message text + channel correct');
  const msgA = await A.waitFor((e) => e.type === 'message' && e.message.username === 'alice', 'A receives own message');
  ok(!!msgA, 'sender also receives broadcast');
  const msgId = msgB.message.id;

  /* 3. reactions */
  B.send({ type: 'react', channelId: 'general', messageId: msgId, emoji: '👍' });
  const rxA = await A.waitFor((e) => e.type === 'reactions' && e.messageId === msgId, 'A receives reaction update');
  ok(Array.isArray(rxA.reactions['👍']) && rxA.reactions['👍'].includes('bob'), 'bob reaction recorded');
  B.send({ type: 'react', channelId: 'general', messageId: msgId, emoji: '👍' }); // toggle off
  const rx2 = await A.waitFor((e) => e.type === 'reactions' && !e.reactions['👍'], 'reaction toggled off');
  ok(!!rx2, 'reaction toggle removes empty entry');

  /* 4. typing relay (not echoed to sender) */
  B.send({ type: 'typing', channel: 'general' });
  const ty = await A.waitFor((e) => e.type === 'typing' && e.username === 'bob', 'A sees bob typing');
  ok(ty.channel === 'general', 'typing event carries channel');
  ok(!B.events.some((e) => e.type === 'typing'), 'typing not echoed back to sender');
  B.send({ type: 'typing_stop', channel: 'general' });
  const ts = await A.waitFor((e) => e.type === 'typing_stop' && e.username === 'bob', 'A sees bob stop typing');
  ok(!!ts, 'typing_stop relayed');

  /* 5. channel creation + duplicate rejection */
  A.send({ type: 'create_channel', name: 'test-room' });
  const ccB = await B.waitFor((e) => e.type === 'channel_created', 'B notified of new channel');
  ok(ccB.channel.id === 'test-room' && ccB.channel.messages[0].system === true, 'channel created with system message');
  A.send({ type: 'create_channel', name: 'test-room' });
  const dupErr = await A.waitFor((e) => e.type === 'error', 'duplicate channel rejected');
  ok(/already exists/.test(dupErr.message), 'duplicate error message correct');
  A.send({ type: 'create_channel', name: 'BAD NAME!!' });
  const badErr = await A.waitFor((e) => e.type === 'error' && !/already exists/.test(e.message), 'invalid name rejected');
  ok(!!badErr, 'invalid channel name rejected');

  /* 6. presence grace: a quick reconnect must NOT announce alice offline */
  const marksBeforeClose = B.events.length;
  A.close();
  await wait(600); // inside the 4s grace window
  const A2 = new Client();
  await A2.connect(URL);
  A2.send({ type: 'join', username: 'alice', color: '#f43f5e' });
  await A2.waitFor((e) => e.type === 'init', 'alice reconnects within grace');
  await wait(5000); // past the grace window
  const flapped = B.events.slice(marksBeforeClose)
    .some((e) => e.type === 'presence' && !e.online.includes('alice'));
  ok(!flapped, 'quick reconnect does not flap presence (grace window works)');

  /* 7. presence drops a user who stays offline past the grace window */
  A2.close();
  const presB2 = await B.waitFor(
    (e) => e.type === 'presence' && !e.online.includes('alice'),
    'presence drops alice after grace expires', 9000);
  ok(presB2.online.includes('bob'), 'bob still online');

  B.close();
  return { passed, failed };
};
