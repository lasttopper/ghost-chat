/* Pulse — Vercel Function entry point (WebSocket, public beta + Fluid compute).
 *
 * - Serves the WebSocket upgrade at /api/ws using `ws` (noServer + handleUpgrade).
 * - The core instance is a module-level singleton: with Fluid compute the warm
 *   instance persists across invocations and can hold many connections.
 * - Storage: in-memory by default (ephemeral — reseeds on cold start).
 *   Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (free tier at
 *   upstash.com) to persist channels/messages across cold starts and redeploys.
 *
 * Note: Vercel caps connection duration (default ~5 min on Hobby); the client
 * auto-reconnects and re-syncs, and core.js suppresses presence flapping.
 */
'use strict';

const { WebSocketServer } = require('ws');
const { createCore, attachHeartbeat } = require('../core');

/* ---------------------- optional Upstash persistence ---------------------- */

function makePersistence() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // in-memory mode
  const key = 'pulse:state';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    async load() {
      const r = await fetch(`${url}/get/${key}`, { headers });
      if (!r.ok) throw new Error(`upstash GET ${r.status}`);
      const j = await r.json();
      return j && j.result ? JSON.parse(j.result) : null;
    },
    async save(state) {
      // Upstash REST: POST /set/<key> with the value as a JSON-encoded string body
      const r = await fetch(`${url}/set/${key}`, {
        method: 'POST', headers, body: JSON.stringify(JSON.stringify(state)),
      });
      if (!r.ok) throw new Error(`upstash SET ${r.status}`);
    },
  };
}

/* --------------------------- module singleton --------------------------- */

const wss = new WebSocketServer({ noServer: true });
const core = createCore(makePersistence());

wss.on('connection', (ws) => core.onConnection(ws));
attachHeartbeat(wss);

/* ------------------------------- handler ------------------------------- */

module.exports = async function handler(req, res) {
  await core.ready;

  const upgrade = (req.headers.upgrade || '').toLowerCase() === 'websocket';
  if (upgrade && req.socket) {
    try {
      wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      try { req.socket.destroy(); } catch {}
    }
    return;
  }

  if (res && typeof res.writeHead === 'function') {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('This endpoint expects a WebSocket upgrade request (wss://<host>/api/ws).');
  } else {
    try { req.socket.destroy(); } catch {}
  }
};
