/* Ghost Chat — standalone server: HTTP static + WebSocket, state persisted to a JSON file.
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
const DATA_FILE = process.env.GHOST_DATA || process.env.PULSE_DATA || path.join(__dirname, 'data.json');
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

/* FCM push for offline Android users. Enabled only when the Firebase
 * service-account JSON is provided (Render env FIREBASE_SERVICE_ACCOUNT).
 * Without it the server runs exactly as before — no push, no errors. */
const { createPush } = require('./push');
const push = createPush({
  serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  projectId: process.env.FIREBASE_PROJECT_ID || undefined,
});
if (push.enabled) console.log('FCM push enabled for project', push.projectId);
else console.log('FCM push disabled (set FIREBASE_SERVICE_ACCOUNT to enable)');

const core = createCore(persistence, { push });

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
  if (req.method === 'POST' && pathname === '/api/upload-image') { handleImageUpload(req, res); return; }
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

/* ------------------------------ image upload ------------------------------
 * Chat image sharing is hosted on ImgBB. The client downscales its picture
 * and POSTs it here; we forward it to ImgBB so the API key never reaches the
 * browser. Responds { ok:true, url } with the permanent direct image link. */

const IMGBB = {
  key: process.env.IMGBB_API_KEY || '',
  apiUrl: process.env.IMGBB_API_URL || 'https://api.imgbb.com/1/upload', // test hook
  maxBytes: 12 * 1024 * 1024, // data-URL body cap (~9 MB of actual image)
};

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

function handleImageUpload(req, res) {
  const done = (status, obj) => {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify(obj));
  };
  if (!IMGBB.key) return done(503, { ok: false, error: 'Image uploads are not configured on this server.' });

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > IMGBB.maxBytes) { done(413, { ok: false, error: 'That image is too large (max ~9 MB).' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (size > IMGBB.maxBytes) return;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return done(400, { ok: false, error: 'Expected JSON with an "image" data URL.' }); }

    const dataUrl = String((payload && payload.image) || '');
    const match = DATA_URL_RE.exec(dataUrl);
    if (!match) return done(400, { ok: false, error: 'Send a PNG, JPEG, WEBP or GIF image.' });
    const b64 = match[2];
    if (b64.length < 64) return done(400, { ok: false, error: 'That image is empty.' });

    const form = new URLSearchParams({ key: IMGBB.key, image: b64 });
    if (payload.name) form.set('name', String(payload.name).replace(/[^\w .-]/g, '').slice(0, 60) || 'photo');
    try {
      const r = await fetch(IMGBB.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const json = await r.json().catch(() => null);
      const url = json && json.data && json.data.url;
      if (!r.ok || !json || json.success !== true || !/^https:\/\/i\.ibb\.co\//.test(String(url || ''))) {
        const msg = json && json.error && json.error.message ? String(json.error.message) : `HTTP ${r.status}`;
        console.error('ImgBB upload failed:', msg);
        return done(502, { ok: false, error: 'The image host rejected the upload. Please try again.' });
      }
      done(200, { ok: true, url: String(url) });
    } catch (e) {
      console.error('ImgBB upload error:', e.message);
      done(502, { ok: false, error: 'Could not reach the image host. Please try again.' });
    }
  });
  req.on('error', () => { try { res.destroy(); } catch {} });
}

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
