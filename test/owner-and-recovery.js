/* Owner account + reserved-username recovery.
 *
 * Covers the two fixes shipped this change:
 *   1. STUCK-ON-CONNECTING FIX: a join rejected for an invalid/reserved name now
 *      returns `need_username` (with a reason) instead of a generic `error`, so
 *      the client can bounce the user to the username-setup screen.
 *   2. OWNER ACCOUNT: the configured owner email (OWNER_EMAIL) is exempt from the
 *      reserved-name block, is flagged `owner:true`, receives `isOwner:true` on
 *      init, is a super-admin of every group, and cannot be removed.
 *
 * Usage: node test/owner-and-recovery.js [wsUrl]
 * The server must be started with OWNER_EMAIL set to the owner's email.
 */
'use strict';
const WebSocket = require('ws');

const BASE = process.argv[2] || 'ws://127.0.0.1:3000/ws';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'rajkatrina90@gmail.com';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };

class Client {
  constructor(tag) { this.tag = tag; this.inbox = []; this.ws = null; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', () => res());
      this.ws.on('message', (d) => { try { this.inbox.push(JSON.parse(d)); } catch {} });
      this.ws.on('error', rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  // Join and resolve with whichever of init / need_username / error arrives first.
  join(username, email) {
    this.send({ type: 'join', username, authId: 'auth-' + this.tag, email: email || '', guest: true, color: '#4f8cff' });
    return this.waitForAny(['init', 'need_username', 'error']);
  }
  waitForAny(types, pred, timeout = 6000) {
    if (typeof pred === 'number') { timeout = pred; pred = null; }
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find((x) => types.includes(x.type) && (!pred || pred(x)));
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > timeout) { clearInterval(iv); res(null); }
      }, 20);
    });
  }
  waitFor(type, pred, timeout = 6000) {
    if (typeof pred === 'number') { timeout = pred; pred = null; }
    return this.waitForAny([type], pred, timeout);
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('owner-and-recovery test against', BASE, '(owner email:', OWNER_EMAIL + ')');
  const sfx = Math.random().toString(36).slice(2, 6);

  // --- 1. Reserved/invalid names now return need_username (not a dead-end error) ---
  const r1 = new Client('res1'); await r1.connect();
  const m1 = await r1.join('admin');
  ok(m1 && m1.type === 'need_username', 'reserved name "admin" (non-owner) -> need_username, not stuck');
  ok(m1 && /reserved/i.test(m1.reason || ''), 'need_username carries a reason');

  const r2 = new Client('res2'); await r2.connect();
  const m2 = await r2.join('ab'); // too short -> invalid
  ok(m2 && m2.type === 'need_username', 'invalid name "ab" -> need_username');

  // --- 2. Owner email is EXEMPT from the reserved block ---
  const owner = new Client('owner'); await owner.connect();
  const mo = await owner.join('owner', OWNER_EMAIL);
  ok(mo && mo.type === 'init', 'owner email may use the reserved name "owner" (init received)');
  ok(mo && mo.isOwner === true, 'owner init carries isOwner:true');
  ok(mo && mo.users && mo.users['owner'] && mo.users['owner'].owner === true, 'owner is flagged owner:true in the directory');

  // A non-owner still cannot take "owner"
  const r3 = new Client('res3'); await r3.connect();
  const m3 = await r3.join('owner', 'someone-else@example.com');
  ok(m3 && m3.type === 'need_username', 'non-owner cannot take the reserved name "owner"');

  // --- 3. Owner is a super-admin of a group they did NOT create ---
  const creator = new Client('creator'); await creator.connect();
  await creator.join('creator' + sfx);
  const victim = new Client('victim'); await victim.connect();
  await victim.join('victim' + sfx);

  const gid = 'owngrp' + sfx;
  creator.send({ type: 'create_channel', name: gid, private: true });
  const created = await creator.waitFor('channel_created', (m) => m.channel && m.channel.id === gid);
  ok(!!created, 'creator made a private group');

  creator.send({ type: 'add_member', channelId: gid, username: 'owner' });
  const ownerJoined = await owner.waitFor('channel_joined', (m) => m.channel && m.channel.id === gid);
  ok(!!ownerJoined, 'owner was added to the group');
  creator.send({ type: 'add_member', channelId: gid, username: 'victim' + sfx });
  await victim.waitFor('channel_joined', (m) => m.channel && m.channel.id === gid);

  // The owner (not the creator, not a promoted admin) removes a member -> allowed.
  owner.send({ type: 'remove_member', channelId: gid, username: 'victim' + sfx });
  const removed = await victim.waitFor('removed_from_channel', (m) => m.channelId === gid);
  ok(!!removed, 'OWNER (super-admin) removed a member from a group they did not create');

  // --- 4. The owner cannot be removed ---
  creator.send({ type: 'remove_member', channelId: gid, username: 'owner' });
  const err = await creator.waitFor('error', (m) => /owner cannot be removed/i.test(m.message || ''));
  ok(!!err, 'the owner cannot be removed');

  [r1, r2, r3, owner, creator, victim].forEach((c) => c.close());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
