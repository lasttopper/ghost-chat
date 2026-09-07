/* Durable state storage on Firebase Realtime Database (REST, zero deps).
 *
 * Why: Render's free tier wipes the disk on every deploy, so chats/groups
 * stored in the local data.json vanished on each change. RTDB keeps the
 * authoritative copy in the cloud (same Firebase project as auth/push, no
 * new signups); the local file stays as a fast cache and offline fallback.
 *
 * Auth: the same service-account key already used for FCM. RTDB only grants
 * admin access to OAuth tokens carrying an `email` claim, so the JWT is
 * minted with BOTH the userinfo.email and firebase.database scopes.
 *
 * Injectable tokenUrl/baseUrl keep the module testable against mocks. */
'use strict';

const crypto = require('crypto');

const SCOPES = 'https://www.googleapis.com/auth/userinfo.email '
  + 'https://www.googleapis.com/auth/firebase.database';

function createRtdb(options = {}) {
  let sa = options.serviceAccount || null;
  if (!sa && options.serviceAccountJson) {
    try { sa = JSON.parse(options.serviceAccountJson); } catch { sa = null; }
  }
  if (!sa || !sa.client_email || !sa.private_key) return { enabled: false };

  const projectId = options.projectId || sa.project_id;
  const baseUrl = (options.baseUrl || `https://${projectId}-default-rtdb.firebaseio.com`).replace(/\/+$/, '');
  const tokenUrl = options.tokenUrl || 'https://oauth2.googleapis.com/token';
  const STATE_KEY = options.stateKey || 'ghost-state';
  const BACKUP_KEY = options.backupKey || 'ghost-backups';
  const KEEP_BACKUPS_DAYS = options.keepBackupsDays || 14;

  let cached = null; // { token, expiresAt }

  const b64u = (b) => Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function signedJwt() {
    const now = Math.floor(Date.now() / 1000);
    const claim = { iss: sa.client_email, scope: SCOPES, aud: tokenUrl, iat: now, exp: now + 3600 };
    const body = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claim));
    const sig = crypto.sign('sha256', Buffer.from(body), sa.private_key)
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return body + '.' + sig;
  }

  async function accessToken(force) {
    if (!force && cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt(),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error('token exchange failed: ' + (j.error_description || j.error || r.status));
    cached = { token: j.access_token, expiresAt: Date.now() + ((j.expires_in || 3600) * 1000) };
    return cached.token;
  }

  async function rest(method, path, bodyObj) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await accessToken(attempt > 0);
        const headers = { Authorization: 'Bearer ' + token };
        const init = { method, headers };
        if (bodyObj !== undefined) {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(bodyObj);
        }
        const r = await fetch(baseUrl + path, init);
        const text = await r.text();
        if (r.status === 401 && attempt === 0) continue; // token went stale mid-flight
        if (!r.ok) throw new Error(`RTDB ${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 120)}`);
        return text ? JSON.parse(text) : null;
      } catch (e) {
        lastErr = e;
        if (attempt === 0 && /401|token/i.test(e.message)) continue;
      }
    }
    throw lastErr;
  }

  return {
    enabled: true,
    url: baseUrl,
    async loadState() { return rest('GET', `/${STATE_KEY}.json`); },
    async saveState(state) { return rest('PUT', `/${STATE_KEY}.json`, state); },
    /* Daily backup copy + prune. dateStr like 2026-09-07. */
    async backupNow(state, dateStr) {
      await rest('PUT', `/${BACKUP_KEY}/${dateStr}.json`, state);
      try {
        const all = await rest('GET', `/${BACKUP_KEY}.json?shallow=true`);
        if (all && typeof all === 'object') {
          const cutoff = Date.now() - KEEP_BACKUPS_DAYS * 86400000;
          for (const k of Object.keys(all)) {
            const d = Date.parse(k);
            if (Number.isFinite(d) && d < cutoff) {
              await rest('DELETE', `/${BACKUP_KEY}/${k}.json`).catch(() => {});
            }
          }
        }
      } catch { /* pruning is best-effort */ }
    },
    async listBackups() {
      const all = await rest('GET', `/${BACKUP_KEY}.json?shallow=true`);
      return all && typeof all === 'object' ? Object.keys(all).sort() : [];
    },
  };
}

module.exports = { createRtdb };
