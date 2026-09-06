/* GhostBot assistant + reserved-username test (raw WebSocket vs a real server).
 *   - a new user is greeted by the assistant with a guide DM (bot-flagged)
 *   - messaging the assistant returns a guided auto-reply
 *   - the assistant is present in the directory but flagged as a bot
 *   - privileged usernames (admin/owner/mod/...) are rejected
 * Usage: node test/assistant.js [wsUrl]
 */
'use strict';
const WebSocket = require('ws');

const BASE = process.argv[2] || 'ws://127.0.0.1:3000/ws';
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
  join(username) { this.send({ type: 'join', username, authId: 'auth-' + username, color: '#4f8cff', guest: true }); return this.waitFor('init'); }
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
  console.log('assistant + reserved-username test against', BASE);
  const sfx = Math.random().toString(36).slice(2, 6);

  // --- new user gets the assistant welcome DM ---
  const A = new Client('A');
  await A.connect();
  const me = 'assist' + sfx;
  const init = await A.join(me);
  ok(!!init, 'new user joined as @' + me);
  ok(init && init.users && init.users.ghostbot && init.users.ghostbot.bot === true, 'GhostBot is in the directory and flagged as a bot');

  const botDm = init && (init.dms || []).find((d) => d.members.includes('ghostbot'));
  ok(!!botDm, 'assistant opened a DM with the new user');
  const welcome = botDm && botDm.messages.find((m) => m.username === 'ghostbot' && m.bot);
  ok(!!welcome && /GhostBot|guide|Groups/i.test(welcome.text), 'welcome message is the guide (bot-flagged)');

  // --- messaging the assistant returns a guided auto-reply ---
  A.send({ type: 'message', channel: botDm.id, text: 'how do I create a group?' });
  const reply = await A.waitFor('message', (m) => m.message && m.message.username === 'ghostbot' && m.message.bot);
  ok(!!reply && /group|＋|Private|Public/i.test(reply.message.text), 'assistant auto-replied with group guidance');

  // a second question gets a different, relevant answer
  A.send({ type: 'message', channel: botDm.id, text: 'tell me about admins' });
  const reply2 = await A.waitFor('message', (m) => m.message && m.message.username === 'ghostbot' && /admin|owner|Members/i.test(m.message.text || ''));
  ok(!!reply2, 'assistant answered the admin question');
  A.close();

  // --- reserved usernames are rejected ---
  for (const bad of ['admin', 'owner', 'mod', 'ghostbot']) {
    const C = new Client('bad');
    await C.connect();
    C.send({ type: 'join', username: bad, authId: 'auth-' + bad + sfx, color: '#4f8cff', guest: true });
    const err = await C.waitFor('error', (m) => /reserved/i.test(m.message || ''));
    ok(!!err, `reserved username "${bad}" rejected`);
    C.close();
  }

  // --- a normal username still works ---
  const D = new Client('D');
  await D.connect();
  const goodInit = await D.join('okuser' + sfx);
  ok(!!goodInit, 'a normal username is accepted');
  D.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
