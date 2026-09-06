/* Server-side secure-auth integration test.
 *
 * Runs the real core.js in-process with a MOCK ID-token verifier, so we can
 * prove the security properties without real Firebase credentials:
 *   - identity (uid + email) comes ONLY from the verified token
 *   - owner status requires a verified token whose email is the owner's
 *   - client-supplied email/authId are ignored (cannot be spoofed)
 *   - an invalid token, or a uid-style authId with no token, is refused
 *
 * Usage: node test/secure-auth.js
 */
'use strict';
process.env.OWNER_EMAIL = 'rajkatrina90@gmail.com'; // before requiring core
const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { createCore } = require('../core');

// Mock verifier: maps a fake "token" to the identity Firebase would attest to.
const TOKENS = {
  'tok-owner': { uid: 'uid_owner_real', email: 'rajkatrina90@gmail.com', email_verified: true },
  'tok-alice': { uid: 'uid_alice', email: 'alice@example.com', email_verified: true },
};
const mockVerify = async (token) => {
  if (TOKENS[token]) return TOKENS[token];
  throw new Error('invalid id token');
};

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };

class Client {
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
  join(fields) { this.send({ type: 'join', guest: true, color: '#4f8cff', ...fields }); return this.waitForAny(['init', 'need_username', 'auth_failed', 'username_taken']); }
  waitForAny(types, pred, timeout = 5000) {
    if (typeof pred === 'number') { timeout = pred; pred = null; }
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find((x) => types.includes(x.type) && (!pred || pred(x)));
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > timeout) { clearInterval(iv); res(null); }
      }, 15);
    });
  }
  waitFor(type, pred, timeout) { return this.waitForAny([type], pred, timeout); }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('secure-auth integration test (mock verifier)');

  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const core = createCore(null, { verifyIdToken: mockVerify });
  wss.on('connection', (ws) => core.onConnection(ws));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';

  // 1. Verified owner may take the reserved name "owner" and is flagged owner.
  const owner = new Client(); await owner.connect(url);
  const mo = await owner.join({ idToken: 'tok-owner', username: 'owner', authId: 'ignored-client-value' });
  ok(mo && mo.type === 'init', 'verified owner can claim the reserved name "owner"');
  ok(mo && mo.isOwner === true, 'verified owner init carries isOwner:true');
  ok(mo && mo.users['owner'] && mo.users['owner'].owner === true, 'owner flagged owner:true in the directory');
  ok(mo && mo.users['owner'] && mo.users['owner'].authId === 'uid_owner_real', 'server uses the VERIFIED uid, not the client-supplied authId');

  // 2. A verified NON-owner cannot take "owner" and is not the owner.
  const alice = new Client(); await alice.connect(url);
  const ma = await alice.join({ idToken: 'tok-alice', username: 'owner' });
  ok(ma && ma.type === 'need_username', 'verified non-owner is blocked from the reserved name "owner"');
  const alice2 = new Client(); await alice2.connect(url);
  const ma2 = await alice2.join({ idToken: 'tok-alice', username: 'alice' });
  ok(ma2 && ma2.type === 'init' && ma2.isOwner === false, 'verified non-owner joins normally with isOwner:false');

  // 3. SPOOF: client claims the owner email with NO token -> treated as guest,
  //    email ignored, cannot take "owner", never the owner.
  const spoof = new Client(); await spoof.connect(url);
  const ms = await spoof.join({ authId: 'guest-spoof', email: 'rajkatrina90@gmail.com', username: 'owner' });
  ok(ms && ms.type === 'need_username', 'email spoof (no token) cannot claim the reserved name "owner"');
  const spoof2 = new Client(); await spoof2.connect(url);
  const ms2 = await spoof2.join({ authId: 'guest-spoof2', email: 'rajkatrina90@gmail.com', username: 'hacker' });
  ok(ms2 && ms2.type === 'init' && ms2.isOwner === false, 'email spoof (no token) joins as a plain guest, isOwner:false');
  ok(ms2 && ms2.users['hacker'] && !ms2.users['hacker'].owner, 'spoofed account is NOT flagged owner');
  ok(ms2 && ms2.users['hacker'] && ms2.users['hacker'].email === '', 'server does not store the spoofed email for an unverified guest');

  // 4. Invalid token -> refused.
  const bad = new Client(); await bad.connect(url);
  const mb = await bad.join({ idToken: 'garbage-token', username: 'someone' });
  ok(mb && mb.type === 'auth_failed', 'an invalid id token is refused (auth_failed)');

  // 5. Claiming the owner's uid + email with NO token grants no privilege.
  const imp = new Client(); await imp.connect(url);
  const mi = await imp.join({ authId: 'uid_owner_real', email: 'rajkatrina90@gmail.com', username: 'impersonator' });
  ok(mi && mi.type === 'init' && mi.isOwner === false, 'claiming the owner uid+email with no token does NOT grant owner');
  const imp2 = new Client(); await imp2.connect(url);
  const mi2 = await imp2.join({ authId: 'uid_owner_real', email: 'rajkatrina90@gmail.com', username: 'owner' });
  ok(mi2 && mi2.type === 'need_username', 'an unverified claim still cannot take the reserved name "owner"');

  // 7. The verified owner is a super-admin of a group they did NOT create, and
  //    cannot be removed. (Group management moved here from the old owner test.)
  const creator = new Client(); await creator.connect(url);
  await creator.join({ authId: 'guest-creator', username: 'creator_x' });
  const victim = new Client(); await victim.connect(url);
  await victim.join({ authId: 'guest-victim', username: 'victim_x' });
  creator.send({ type: 'create_channel', name: 'secgrp', private: true });
  await creator.waitFor('channel_created', (m) => m.channel && m.channel.id === 'secgrp');
  creator.send({ type: 'add_member', channelId: 'secgrp', username: 'owner' });
  await owner.waitFor('channel_joined', (m) => m.channel && m.channel.id === 'secgrp');
  creator.send({ type: 'add_member', channelId: 'secgrp', username: 'victim_x' });
  await victim.waitFor('channel_joined', (m) => m.channel && m.channel.id === 'secgrp');
  owner.send({ type: 'remove_member', channelId: 'secgrp', username: 'victim_x' });
  const removed = await victim.waitFor('removed_from_channel', (m) => m.channelId === 'secgrp');
  ok(!!removed, 'verified OWNER is super-admin: removed a member from a group they did not create');
  creator.send({ type: 'remove_member', channelId: 'secgrp', username: 'owner' });
  const oerr = await creator.waitFor('error', (m) => /owner cannot be removed/i.test(m.message || ''));
  ok(!!oerr, 'the owner cannot be removed');

  // 6. Guests still work with a guest- authId.
  const guest = new Client(); await guest.connect(url);
  const mg = await guest.join({ authId: 'guest-abc123', username: 'plain_guest' });
  ok(mg && mg.type === 'init' && mg.isOwner === false, 'a normal guest (guest- authId, no token) still joins');

  [owner, alice, alice2, spoof, spoof2, bad, imp, imp2, creator, victim, guest].forEach((c) => c.close());
  wss.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
