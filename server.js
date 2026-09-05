/* Pulse — standalone server: HTTP static + WebSocket, state persisted to a JSON file.
 * (The Vercel entry point lives in api/ws.js; both share core.js.)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createCore, attachHeartbeat } = require('./core');
const digest = require('./digest');

/* lightweight .env loader (no dependency) — for local runs.
 * On Render/Railway, set the same vars in the dashboard instead. */
(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch {}
})();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.PULSE_DATA || path.join(__dirname, 'data.json');
const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Kolkata';
const REPORT_DIR = process.env.REPORT_DIR || path.join(__dirname, 'reports');

/* ------------------------------ persistence ------------------------------ */

const persistence = {
  async load() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
  },
  async save(state) { await fs.promises.writeFile(DATA_FILE, JSON.stringify(state)); },
  saveSync(state) { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); },
};

const core = createCore(persistence);

/* --------------------------- http static server --------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(404).end('Not found'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(data);
  });
});

/* ------------------------------ websockets ------------------------------ */

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => core.onConnection(ws));
attachHeartbeat(wss);

process.on('SIGTERM', () => { core.flush(); process.exit(0); });
process.on('SIGINT',  () => { core.flush(); process.exit(0); });

/* --------------------------- midnight digest --------------------------- */

const TELEGRAM = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  apiUrl: process.env.TELEGRAM_API_URL, // test hook; defaults to api.telegram.org
};

function maybeRunDigest() {
  const state = core.getState();
  const now = Date.now();
  if (!state.lastDigestDate) {
    // first boot: start the clock — the first report goes out at the next midnight
    core.setLastDigestDate(digest.tzDateStr(now, REPORT_TZ));
    return;
  }
  const due = digest.dueDigest(state.lastDigestDate, now, REPORT_TZ);
  if (!due) return;
  core.setLastDigestDate(digest.tzDateStr(now, REPORT_TZ)); // mark before awaiting to avoid double-send
  digest.runDigest(state, {
    dateStr: due, tz: REPORT_TZ, outDir: REPORT_DIR, telegram: TELEGRAM,
  }).catch((e) => console.error('[digest] failed:', e.message));
}

core.ready.then(() => {
  maybeRunDigest();
  setInterval(maybeRunDigest, 30000).unref();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ghost Chat listening on http://0.0.0.0:${PORT} (reports at midnight ${REPORT_TZ})`);
});
