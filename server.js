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

/* ------------------------------ persistence ------------------------------
 * The local file is a fast cache; Firebase Realtime Database is the durable
 * store (Render's free tier wipes the disk on every deploy, which used to
 * delete all chats/groups). RTDB wins on load when it has data. */

const { createRtdb } = require('./rtdb');
const rtdb = createRtdb({
  serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  projectId: process.env.FIREBASE_PROJECT_ID || undefined,
  baseUrl: process.env.FIREBASE_RTDB_URL || undefined,     // test hook
  tokenUrl: process.env.FIREBASE_OAUTH_URL || undefined,   // test hook
  timeoutMs: process.env.FIREBASE_RTDB_TIMEOUT_MS ? Number(process.env.FIREBASE_RTDB_TIMEOUT_MS) : undefined,
});
if (rtdb.enabled) console.log('RTDB durable storage enabled:', rtdb.url);
else console.log('RTDB disabled (no service account) - state is file-only and will NOT survive redeploys');

let rtdbFailing = false;
/* Single-process server: the in-memory state is authoritative once booted.
 * load() therefore does the RTDB dance ONLY at startup (core calls it again
 * on joins via reload(); answering null there keeps joins fast and offline-
 * proof — a stalled RTDB socket can never block a join again). */
let startupLoadDone = false;
const persistence = {
  async load() {
    if (startupLoadDone) return null; // reload() on join: keep in-memory state
    try {
      if (rtdb.enabled) {
        for (let i = 0; i < 3; i++) {
          try {
            const remote = await rtdb.loadState();
            if (remote && remote.users) return remote;
            break; // RTDB reachable but empty -> fall through to file/seed
          } catch (e) {
            console.error(`RTDB load attempt ${i + 1}/3 failed:`, e.message);
            if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
          }
        }
      }
      try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
    } finally {
      startupLoadDone = true;
    }
  },
  async save(state) {
    try { await fs.promises.writeFile(DATA_FILE, JSON.stringify(state)); } catch {}
    if (!rtdb.enabled) return;
    // Fire-and-forget through a serial chain: never blocks callers (joins!),
    // preserves write order, and surfaces outages once instead of per-save.
    rtdbChain = rtdbChain
      .then(() => rtdb.saveState(state))
      .then(() => {
        if (rtdbFailing) { rtdbFailing = false; console.log('RTDB writes recovered'); }
      })
      .catch((e) => {
        if (!rtdbFailing) { rtdbFailing = true; console.error('RTDB save failed (file copy written):', e.message); }
      });
  },
  saveSync(state) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch {} },
};
let rtdbChain = Promise.resolve();

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
  if (req.method === 'GET' && pathname === '/api/update-check') { handleUpdateCheck(req, res); return; }
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

/* --------------------------- in-app update check ---------------------------
 * The APK asks the server which release is current. We read the latest GitHub
 * release (cached 15 min) and hand back the version + APK download URL, so a
 * full auto-update needs no app-store round trip. On any failure we answer
 * "no update" — a broken check must never nag or block the chat. */

const UPDATE_CHECK_URL = process.env.UPDATE_CHECK_URL
  || `https://api.github.com/repos/${process.env.UPDATE_REPO || 'lasttopper/ghost-chat'}/releases/latest`;
const UPDATE_CACHE_MS = 15 * 60 * 1000;
let updateCache = { at: 0, data: null };

async function handleUpdateCheck(req, res) {
  const send = (obj) => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(obj));
  if (updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) { send(updateCache.data); return; }
  try {
    const r = await fetch(UPDATE_CHECK_URL, {
      headers: { 'User-Agent': 'ghost-chat-app', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('releases API ' + r.status);
    const rel = await r.json();
    const tag = String(rel.tag_name || '').replace(/^v/, '');
    const apk = (Array.isArray(rel.assets) ? rel.assets : []).find((a) => /\.apk$/i.test(String(a && a.name)));
    const data = {
      ok: true,
      latest: tag || null,
      url: (apk && apk.browser_download_url) || null,
      notes: String(rel.body || '').slice(0, 500),
    };
    if (data.latest && data.url) updateCache = { at: Date.now(), data };
    send(data);
  } catch {
    send(updateCache.data || { ok: true, latest: null, url: null }); // stale or "no update"
  }
}

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

/* On shutdown (Render sends SIGTERM before every redeploy): flush the file
 * synchronously, then push the final state to RTDB before exiting so no
 * messages are lost to the redeploy. */
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  core.flush();
  if (rtdb.enabled) {
    try {
      await rtdbChain; // let queued writes land first (order preserved)
      await rtdb.saveState(core.getState());
    } catch (e) { console.error('final RTDB save failed:', e.message); }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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
  // Daily cloud backup of the whole state (kept 14 days in RTDB) so there is
  // always a restorable snapshot even if the live copy is ever corrupted.
  if (rtdb.enabled) {
    rtdb.backupNow(state, due).catch((e) => console.error('[backup] failed:', e.message));
  }
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
