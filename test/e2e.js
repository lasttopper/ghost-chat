/* E2E for the STANDALONE server: spawns server.js with a temp data file
 * and runs the shared protocol suite against it. */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const runSuite = require('./protocol-suite');

const PORT = 3210;
const DATA = path.join(os.tmpdir(), 'pulse-test-' + Date.now() + '.json');

const waitForPort = async (port, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const up = await new Promise((r) => {
      const sock = require('net').connect(port, '127.0.0.1', () => { sock.destroy(); r(true); });
      sock.on('error', () => r(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

(async () => {
  try { fs.unlinkSync(DATA); } catch {}
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), PULSE_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  if (!(await waitForPort(PORT))) { console.error('server did not start'); process.exit(1); }

  let failed = 1;
  try {
    console.log('— standalone server (server.js) —');
    const r = await runSuite(PORT);

    /* persistence: data file written */
    await new Promise((r2) => setTimeout(r2, 500));
    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const okPersist = data.channels.some((c) => c.id === 'test-room') &&
      data.channels.find((c) => c.id === 'general').messages.some((m) => m.text === 'hello from alice');
    if (okPersist) { r.passed++; console.log('  PASS  data.json persisted channel + message'); }
    else { r.failed++; console.error('  FAIL  data.json persisted channel + message'); }

    /* health check endpoint (used by Render healthCheckPath) */
    const hr = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    const hj = await hr.json();
    if (hr.status === 200 && hj.ok === true) { r.passed++; console.log('  PASS  GET /healthz -> 200 {ok:true}'); }
    else { r.failed++; console.error('  FAIL  GET /healthz -> 200 {ok:true}'); }

    failed = r.failed;
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
  }
  server.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
})();
