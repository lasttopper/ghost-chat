/* GhostBot slash-command suite (URL test against a running server):
 *   /rename validation + live rename semantics + /help
 * Usage: node test/bot-commands.js [wsUrl]
 */
const WebSocket = require('ws');
const BASE = process.argv[2] || 'ws://127.0.0.1:3000/ws';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class C {
  constructor(name) { this.name = name; this.inbox = []; this.ws = null; }
  connect() {
    return new Promise((res) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', res);
      this.ws.on('message', (d) => { try { this.inbox.push(JSON.parse(d)); } catch {} });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  join(fields) { this.send({ type: 'join', guest: true, color: '#4f8cff', ...fields }); return this.waitFor('init'); }
  waitFor(type, pred = () => true, ms = 5000) {
    const t0 = Date.now();
    return new Promise((res) => {
      const tick = () => {
        const i = this.inbox.findIndex((m) => m.type === type && pred(m));
        if (i >= 0) return res(this.inbox.splice(i, 1)[0]);
        if (Date.now() - t0 > ms) return res(null);
        setTimeout(tick, 25);
      };
      tick();
    });
  }
  botSays(re, ms = 5000) { return this.waitFor('message', (m) => m.message && m.message.username === 'ghostbot' && re.test(m.message.text || ''), ms); }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('bot-commands test against', BASE);
  const authId = 'botcmd-' + Date.now();
  const otherAuthId = 'botcmd-other-' + Date.now();
  const FIRST = 'first_' + Date.now().toString(36).slice(-5);
  const SECOND = 'second_' + Date.now().toString(36).slice(-5);
  const OTHER = 'other_' + Date.now().toString(36).slice(-5);

  const a = new C('a'); await a.connect();
  await a.join({ username: FIRST, authId, email: '' });
  const b = new C('b'); await b.connect();
  await b.join({ username: OTHER, authId: otherAuthId });

  // open the GhostBot DM (auto-created on join; dm_start makes the client aware)
  a.send({ type: 'dm_start', to: 'ghostbot' });
  const dmReady = await a.waitFor('dm_ready', (m) => m.conv.members.includes('ghostbot'));
  ok(!!dmReady, 'GhostBot DM is open');
  const botDm = dmReady.conv.id;

  // /help
  a.send({ type: 'message', channel: botDm, text: '/help' });
  const help = await a.botSays(/\/rename/);
  ok(!!help, '/help lists /rename');

  // /rename with no argument
  a.send({ type: 'message', channel: botDm, text: '/rename' });
  ok(!!(await a.botSays(/Usage: \/rename/)), '/rename with no name -> usage hint');

  // invalid / reserved / taken names
  a.send({ type: 'message', channel: botDm, text: '/rename Bad Name!' });
  ok(!!(await a.botSays(/isn’t valid/)), 'invalid name rejected');
  a.send({ type: 'message', channel: botDm, text: '/rename admin' });
  ok(!!(await a.botSays(/reserved/)), 'reserved name rejected');
  a.send({ type: 'message', channel: botDm, text: '/rename ' + OTHER });
  ok(!!(await a.botSays(/already taken/)), 'taken name rejected');
  a.send({ type: 'message', channel: botDm, text: '/rename ' + FIRST });
  ok(!!(await a.botSays(/already @/)), 'same name is a friendly no-op');

  // send a message in #general first (history must follow the rename)
  a.send({ type: 'message', channel: 'general', text: 'history-follows ' + FIRST });
  ok(!!(await a.waitFor('message', (m) => m.message && m.message.username === FIRST && (m.message.text || '').includes('history-follows ' + FIRST))), 'message posted as ' + FIRST);

  // a DM between a and b exists BEFORE the rename (must survive it)
  a.send({ type: 'dm_start', to: OTHER });
  const abDm = await a.waitFor('dm_ready', (m) => m.conv.members.includes(OTHER));
  ok(!!abDm, 'DM a<->b open before rename');

  // the real rename: b must see user_renamed, a must get a fresh init
  a.send({ type: 'message', channel: botDm, text: '/rename ' + SECOND });
  const ack = await a.botSays(new RegExp('now @' + SECOND));
  ok(!!ack, '/rename ' + SECOND + ' -> bot confirms');
  const init2 = await a.waitFor('init', (m) => m.username === SECOND);
  ok(!!init2, 'renamed user gets a full init as @' + SECOND);
  const rn = await b.waitFor('user_renamed', (m) => m.from === FIRST && m.to === SECOND);
  ok(!!rn, 'other online user receives user_renamed');

  // history moved with the rename
  const gen = (init2.channels || []).find((c) => c.id === 'general');
  const mine = (gen && gen.messages || []).find((m) => (m.text || '').includes('history-follows ' + FIRST));
  ok(!!mine && mine.username === SECOND, 'old message authorship updated to @' + SECOND);

  // DM survived (still exactly one bot DM + one a<->b DM, members updated)
  const botDms = (init2.dms || []).filter((d) => d.members.includes('ghostbot'));
  const abDms = (init2.dms || []).filter((d) => d.members.includes(OTHER));
  ok(botDms.length === 1, 'exactly one GhostBot DM after rename (got ' + botDms.length + ')');
  ok(abDms.length === 1 && abDms[0].members.includes(SECOND), 'a<->b DM kept, member updated');

  // re-login with the same authId recovers the NEW name
  const c2 = new C('c2'); await c2.connect();
  c2.send({ type: 'join', guest: true, color: '#4f8cff', username: '', authId });
  const init3 = await c2.waitFor('init');
  ok(!!init3 && init3.username === SECOND, 'authId binding follows the rename (re-login -> ' + (init3 && init3.username) + ')');

  // b can still DM the renamed user and the bot answers commands there
  b.send({ type: 'dm_start', to: SECOND });
  const bDm = await b.waitFor('dm_ready', (m) => m.conv.members.includes(SECOND));
  ok(!!bDm && bDm.conv.id === (abDms[0] && abDms[0].id), 'dm_start to the new name finds the SAME dm (no duplicate)');

  // unknown command
  a.send({ type: 'message', channel: botDm, text: '/frobnicate' });
  ok(!!(await a.botSays(/Unknown command/)), 'unknown command -> helpful reply');

  a.close(); b.close(); c2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
