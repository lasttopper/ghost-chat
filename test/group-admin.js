/* Group-admin test (raw WebSocket, multiple concurrent clients vs a real
 * server). Covers the Telegram-style member management:
 *   - owner creates a private group
 *   - a member joins via invite link
 *   - admin ADDS a user directly (no invite link)
 *   - admin PROMOTES a member to admin; that new admin can then add someone
 *   - admin REMOVES a member (kicked client is told)
 *   - non-admins are rejected; the owner cannot be removed
 *   - no fake "GhostBot" user exists
 * Usage: node test/group-admin.js [wsUrl]
 */
'use strict';
const WebSocket = require('ws');

const BASE = process.argv[2] || 'ws://127.0.0.1:3000/ws';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  join(username) {
    this.send({ type: 'join', username, authId: 'auth-' + username, color: '#4f8cff', guest: true });
    return this.waitFor('init');
  }
  waitFor(type, pred, timeout = 6000) {
    return new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = this.inbox.find((x) => x.type === type && (!pred || pred(x)));
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - start > timeout) { clearInterval(iv); res(null); }
      }, 20);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('group-admin test against', BASE);
  const sfx = Math.random().toString(36).slice(2, 6);
  const owner = 'admo' + sfx, membB = 'admb' + sfx, membC = 'admc' + sfx, membD = 'admd' + sfx;
  const chan = 'admgrp-' + sfx;

  const A = new Client('owner'), B = new Client('B'), C = new Client('C'), D = new Client('D');
  await Promise.all([A.connect(), B.connect(), C.connect(), D.connect()]);

  const initA = await A.join(owner);
  ok(initA && initA.username === owner, 'owner joined as @' + owner);
  ok(initA && !('GhostBot' in (initA.users || {})), 'no fake GhostBot user in the directory');

  // owner creates a private group
  A.send({ type: 'create_channel', name: chan, private: true });
  const created = await A.waitFor('channel_created', (m) => m.channel && m.channel.id === chan);
  ok(!!created, 'owner created private group #' + chan);
  const code = created && created.channel.inviteCode;
  ok(created && Array.isArray(created.channel.admins) && created.channel.admins.includes(owner), 'creator is in the admins list');

  // B joins via invite link
  await B.join(membB);
  B.send({ type: 'join_channel', code });
  const bJoined = await B.waitFor('channel_joined', (m) => m.channel && m.channel.id === chan);
  ok(!!bJoined, 'member B joined via invite link');

  // C exists as a user but is NOT in the group yet
  await C.join(membC);

  // non-admin B tries to add C -> rejected
  B.send({ type: 'add_member', channelId: chan, username: membC });
  const bErr = await B.waitFor('error', (m) => /admin/i.test(m.message || ''));
  ok(!!bErr, 'non-admin B cannot add members (rejected)');

  // admin (owner) adds C directly
  A.send({ type: 'add_member', channelId: chan, username: membC });
  const cAdded = await C.waitFor('channel_joined', (m) => m.channel && m.channel.id === chan);
  ok(!!cAdded, 'admin added C directly (C received the group)');
  const aSawAdd = await A.waitFor('member_added', (m) => m.username === membC);
  ok(!!aSawAdd, 'owner client saw member_added for C');

  // owner cannot be removed
  A.send({ type: 'remove_member', channelId: chan, username: owner });
  const ownerErr = await A.waitFor('error', (m) => /owner/i.test(m.message || ''));
  ok(!!ownerErr, 'the group owner cannot be removed');

  // promote C to admin
  A.send({ type: 'promote_admin', channelId: chan, username: membC });
  const promoted = await C.waitFor('admins_updated', (m) => Array.isArray(m.admins) && m.admins.includes(membC));
  ok(!!promoted, 'C promoted to admin (admins_updated lists C)');

  // now C (admin) adds D
  await D.join(membD);
  C.send({ type: 'add_member', channelId: chan, username: membD });
  const dAdded = await D.waitFor('channel_joined', (m) => m.channel && m.channel.id === chan);
  ok(!!dAdded, 'promoted admin C added D directly');

  // owner removes D -> D is told it was removed
  A.send({ type: 'remove_member', channelId: chan, username: membD });
  const dRemoved = await D.waitFor('removed_from_channel', (m) => m.channelId === chan);
  ok(!!dRemoved, 'removed member D was notified (removed_from_channel)');
  const aSawRemove = await A.waitFor('member_removed', (m) => m.username === membD);
  ok(!!aSawRemove, 'owner client saw member_removed for D');

  // demote C back to a normal member
  A.send({ type: 'demote_admin', channelId: chan, username: membC });
  const demoted = await A.waitFor('admins_updated', (m) => Array.isArray(m.admins) && !m.admins.includes(membC));
  ok(!!demoted, 'C demoted back to member (admins_updated no longer lists C)');

  // adding an unknown user is rejected
  A.send({ type: 'add_member', channelId: chan, username: 'no_such_user_zz' });
  const unknownErr = await A.waitFor('error', (m) => /No user/i.test(m.message || ''));
  ok(!!unknownErr, 'adding a non-existent user is rejected');

  [A, B, C, D].forEach((c) => c.close());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
