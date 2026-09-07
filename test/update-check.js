/* /api/update-check endpoint (in-process, mocked GitHub releases API):
 *   - latest release -> { ok, latest, url, notes }
 *   - 15-min cache serves the first good answer
 *   - upstream failure -> graceful "no update"
 * Usage: node test/update-check.js
 */
const http = require('http');
const { spawn } = require('child_process');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let payload = { tag_name: 'v9.9.9', body: 'notes here', assets: [
  { name: 'ghost-chat.aab', browser_download_url: 'https://example.com/x.aab' },
  { name: 'ghost-chat.apk', browser_download_url: 'https://example.com/ghost-chat.apk' },
] };

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const freePort = () => new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // mock "GitHub releases API"
  const mockPort = await freePort();
  const mock = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise((r) => mock.listen(mockPort, r));

  const port = await freePort();
  const env = { ...process.env, PORT: String(port), UPDATE_CHECK_URL: `http://127.0.0.1:${mockPort}/releases/latest`, STATE_FILE: '/tmp/update-check-state.json' };
  const srv = spawn('node', ['server.js'], { env, cwd: __dirname + '/..' });
  await wait(1500);

  const a = await get(`http://127.0.0.1:${port}/api/update-check`);
  ok(a.ok === true && a.latest === '9.9.9', 'latest release reported: ' + a.latest);
  ok(a.url === 'https://example.com/ghost-chat.apk', 'APK asset url picked (not the aab): ' + a.url);
  ok(a.notes === 'notes here', 'release notes passed through');

  // cache: change upstream, immediate second read must serve the cached copy
  payload = { ...payload, tag_name: 'v10.0.0' };
  const b = await get(`http://127.0.0.1:${port}/api/update-check`);
  ok(b.latest === '9.9.9', 'answer cached for 15 min (still 9.9.9 after upstream bump)');

  srv.kill('SIGTERM');
  await wait(400);

  // upstream dead -> graceful "no update"
  const port2 = await freePort();
  const deadPort = await freePort(); // nothing listening there
  const srv2 = spawn('node', ['server.js'], { env: { ...env, PORT: String(port2), UPDATE_CHECK_URL: `http://127.0.0.1:${deadPort}/nope` }, cwd: __dirname + '/..' });
  await wait(1500);
  const c = await get(`http://127.0.0.1:${port2}/api/update-check`);
  ok(c.ok === true && c.latest === null, 'upstream failure -> { ok:true, latest:null } (never nags)');
  srv2.kill('SIGTERM');
  mock.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
