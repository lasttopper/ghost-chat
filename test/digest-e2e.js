/* E2E for the daily midnight digest (digest.js):
 *  - timezone math (Asia/Kolkata midnight boundary)
 *  - dueDigest scheduler logic
 *  - digest content: user details, group + DM chat logs, reports
 *  - delivery to a FAKE Telegram Bot API (sendDocument multipart)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const digest = require('../digest');

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.error('  FAIL  ' + label); }
};

(async () => {
  const TZ = 'Asia/Kolkata';

  /* ---- 1. timezone helpers ---- */
  // 2026-09-04T18:30Z == 2026-09-05T00:00 IST (UTC+5:30)
  const midnightIst = Date.parse('2026-09-04T18:30:00Z');
  ok(digest.tzDateStr(midnightIst, TZ) === '2026-09-05', 'tzDateStr: 18:30 UTC == Sep 5 in IST');
  ok(digest.tzDateStr(midnightIst - 60000, TZ) === '2026-09-04', 'tzDateStr: one minute earlier is still Sep 4');
  ok(digest.tzDayStart('2026-09-04', TZ) === Date.parse('2026-09-03T18:30:00Z'),
    'tzDayStart: Sep 4 IST begins 18:30 UTC on Sep 3');

  /* ---- 2. scheduler logic ---- */
  ok(digest.dueDigest('2026-09-04', midnightIst + 30000, TZ) === '2026-09-04',
    'just past midnight IST: yesterday (Sep 4) is due');
  ok(digest.dueDigest('2026-09-05', midnightIst + 30000, TZ) === null,
    'already reported today: nothing due');
  ok(digest.dueDigest(null, midnightIst, TZ) === null, 'first boot: nothing due (initializes only)');

  /* ---- 3. digest content + telegram delivery ---- */
  const dayStart = digest.tzDayStart('2026-09-04', TZ);
  const state = {
    nextMessageId: 50,
    users: {
      alice: { authId: 'fb|1', email: 'alice@example.com', displayName: 'Alice A', color: '#f43f5e' },
      bob: { authId: 'fb|2', email: 'bob@example.com', displayName: 'Bob B', color: '#10b981' },
    },
    channels: [
      { id: 'general', name: 'general', type: 'channel', private: false, members: [], messages: [
        { id: 'm1', channel: 'general', username: 'alice', text: 'hello digest', ts: dayStart + 3600e3, system: false, reactions: {} },
        { id: 'm2', channel: 'general', username: 'bob', text: 'hi alice', ts: dayStart + 3660e3, system: false, reactions: {} },
        { id: 'm3', channel: 'general', username: 'eve', text: 'day before, should NOT appear', ts: dayStart - 1000, system: false, reactions: {} },
      ] },
      { id: 'vault', name: 'vault', type: 'channel', private: true, members: ['alice'], messages: [
        { id: 'm4', channel: 'vault', username: 'alice', text: 'private note', ts: dayStart + 7200e3, system: false, reactions: {} },
      ] },
    ],
    dms: [
      { id: 'dm:alice:bob', type: 'dm', members: ['alice', 'bob'], messages: [
        { id: 'm5', channel: 'dm:alice:bob', username: 'bob', text: 'dm me maybe', ts: dayStart + 9000e3, system: false, reactions: {} },
      ] },
    ],
    reports: [
      { id: 'r1', ts: dayStart + 9500e3, reporter: 'alice', targetUser: 'bob',
        convId: 'dm:alice:bob', convKind: 'dm', messageId: 'm5', messageText: 'dm me maybe', reason: 'spam test' },
    ],
  };

  // fake Telegram Bot API
  let captured = null;
  const fake = http.createServer((req, res) => {
    let body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      captured = { url: req.url, method: req.method, body: Buffer.concat(body).toString('utf8') };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  const fakePort = 3213;
  await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-digest-'));
  const res = await digest.runDigest(state, {
    dateStr: '2026-09-04', tz: TZ, outDir,
    telegram: { token: 'TESTTOKEN', chatId: '12345', apiUrl: `http://127.0.0.1:${fakePort}` },
    log: () => {},
  });

  ok(res.sent === true, 'runDigest reports telegram delivery success');
  ok(!!captured && captured.url === '/botTESTTOKEN/sendDocument' && captured.method === 'POST',
    'POSTed to /bot<token>/sendDocument');
  ok(!!captured && captured.body.includes('12345'), 'chat_id included in multipart body');
  ok(fs.existsSync(res.filePath) && res.filePath.endsWith('ghost-chat-report-2026-09-04.txt'),
    'report file written with dated name');

  const text = res.text;
  ok(text.includes('GHOST CHAT — DAILY REPORT') && text.includes('2026-09-04'), 'report header + date');
  ok(text.includes('@alice | id: fb|1 | email: alice@example.com'), 'user details section');
  ok(text.includes('hello digest') && text.includes('hi alice'), 'public group chat log included');
  ok(!text.includes('should NOT appear'), 'messages outside the day window excluded');
  ok(text.includes('PRIVATE GROUP: #vault') && text.includes('private note'), 'private group chat included');
  ok(text.includes('DIRECT CHAT: @alice <-> @bob') && text.includes('dm me maybe'), 'DM chat included');
  ok(text.includes('reporter @alice -> target @bob') && text.includes('reason: spam test'), 'report details included');
  ok(captured && captured.body.includes('hello digest') && captured.body.includes('spam test'),
    'telegram document contains chats + reports');

  /* ---- 4. graceful skip without telegram env ---- */
  const res2 = await digest.runDigest(state, { dateStr: '2026-09-04', tz: TZ, outDir, telegram: {}, log: () => {} });
  ok(res2.sent === false && !!res2.skipped && fs.existsSync(res2.filePath),
    'without telegram config: file still written, send skipped');

  fake.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nTEST ERROR:', e); process.exit(1); });
