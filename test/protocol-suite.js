/* Shared protocol assertions — run against ANY server exposing the Ghost Chat
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

  /* 8. usernames: uniqueness + validation */
  const Z = new Client(); // zoe, authId auth-1
  await Z.connect(URL);
  Z.send({ type: 'join', username: 'zoe', authId: 'auth-1', color: '#8b5cf6' });
  const initZ = await Z.waitFor((e) => e.type === 'init' && e.username === 'zoe', 'zoe init');
  ok(initZ.username === 'zoe', 'join with unique username succeeds');
  const X = new Client();
  await X.connect(URL);
  X.send({ type: 'join', username: 'zoe', authId: 'auth-2', color: '#f43f5e' });
  const taken = await X.waitFor((e) => e.type === 'username_taken', 'zoe claimed by another authId');
  ok(taken.username === 'zoe', 'username uniqueness enforced across authIds');
  X.send({ type: 'join', username: 'x!', authId: 'auth-2' });
  const badName = await X.waitFor((e) => e.type === 'error' && /Username/.test(e.message), 'invalid username rejected');
  ok(!!badName, 'username rules enforced (3-20, [a-z0-9_])');
  X.send({ type: 'join', username: 'max', authId: 'auth-2', color: '#10b981' });
  await X.waitFor((e) => e.type === 'init' && e.username === 'max', 'max init');

  /* 9. private groups: invite-link only */
  Z.send({ type: 'create_channel', name: 'vault', private: true });
  const ccZ = await Z.waitFor((e) => e.type === 'channel_created' && e.channel.id === 'vault', 'creator gets private channel');
  ok(typeof ccZ.channel.inviteCode === 'string' && ccZ.channel.inviteCode.length >= 6, 'private channel has invite code');
  ok(!B.events.some((e) => e.type === 'channel_created' && e.channel.id === 'vault'), 'private channel_created not broadcast to non-members');
  const initX2 = await (async () => {
    const N = new Client();
    await N.connect(URL);
    N.send({ type: 'join', username: 'ann', authId: 'auth-3' });
    const i = await N.waitFor((e) => e.type === 'init', 'ann init');
    N._client = N;
    return { i, N };
  })();
  ok(!initX2.i.channels.some((c) => c.id === 'vault'), 'non-member does not see private channel in init');
  // non-member message into vault is dropped
  const zEventsBefore = Z.events.length;
  initX2.N.send({ type: 'message', channel: 'vault', text: 'sneaky' });
  await wait(400);
  ok(!Z.events.slice(zEventsBefore).some((e) => e.type === 'message' && e.message.text === 'sneaky'),
    'non-member message into private channel is dropped');
  // join by code
  X.send({ type: 'join_channel', code: ccZ.channel.inviteCode });
  const joinedX = await X.waitFor((e) => e.type === 'channel_joined' && e.channel.id === 'vault', 'max joins vault by code');
  ok(joinedX.channel.members.includes('max'), 'member list updated after invite join');
  const mjZ = await Z.waitFor((e) => e.type === 'member_joined' && e.username === 'max', 'creator notified of member');
  ok(mjZ.channelId === 'vault', 'member_joined routed to members');
  // bad code
  X.send({ type: 'join_channel', code: 'nope-nope' });
  const badCode = await X.waitFor((e) => e.type === 'error' && /invite link/i.test(e.message), 'bad invite code rejected');
  ok(!!badCode, 'invalid invite code rejected');
  // member message flows
  X.send({ type: 'message', channel: 'vault', text: 'inside the vault' });
  const vaultMsg = await Z.waitFor((e) => e.type === 'message' && e.message.text === 'inside the vault', 'member message reaches creator');
  ok(vaultMsg.message.channel === 'vault', 'private message routed to members only');

  /* 10. direct messages */
  Z.send({ type: 'dm_start', to: 'max' });
  const dmZ = await Z.waitFor((e) => e.type === 'dm_ready' && e.isNew, 'zoe gets dm_ready');
  const dmX = await X.waitFor((e) => e.type === 'dm_ready' && e.isNew, 'max gets dm_ready');
  ok(dmZ.conv.id === dmX.conv.id && dmZ.conv.members.length === 2, 'dm conversation created for both');
  const dmId = dmZ.conv.id;
  Z.send({ type: 'message', channel: dmId, text: 'psst max' });
  const dmMsgX = await X.waitFor((e) => e.type === 'message' && e.message.text === 'psst max', 'dm message reaches partner');
  ok(dmMsgX.message.channel === dmId, 'dm message carries conv id');
  ok(!initX2.N.events.some((e) => e.type === 'message' && e.message.text === 'psst max'), 'dm not visible to third user');
  const dmSelfErr = await (async () => {
    Z.send({ type: 'dm_start', to: 'zoe' });
    return Z.waitFor((e) => e.type === 'error' && /you/i.test(e.message), 'self dm rejected');
  })();
  ok(!!dmSelfErr, 'dm with self rejected');
  // ann's init has no dms
  const N2 = new Client();
  await N2.connect(URL);
  N2.send({ type: 'join', username: 'ann2', authId: 'auth-4' });
  const initN2 = await N2.waitFor((e) => e.type === 'init', 'ann2 init');
  ok(Array.isArray(initN2.dms) && initN2.dms.length === 0, "unrelated user's init has empty dms");

  /* 11. reports */
  const repMsgId = dmMsgX.message.id;
  Z.send({ type: 'report', convId: dmId, messageId: repMsgId, reason: 'spam test' });
  const ack = await Z.waitFor((e) => e.type === 'report_ack', 'report acknowledged');
  ok(typeof ack.id === 'string' && ack.id.length > 0, 'report stored and acked');
  Z.send({ type: 'report', convId: dmId, messageId: repMsgId, reason: '   ' });
  const repErr = await Z.waitFor((e) => e.type === 'error' && /reason/i.test(e.message), 'empty report rejected');
  ok(!!repErr, 'report requires a reason');

  for (const c of [A2, B, Z, X, initX2.N, N2]) { try { c.close(); } catch {} }
  return { passed, failed };
};
