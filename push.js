/* Zero-dependency Firebase Cloud Messaging sender (HTTP v1 API).
 *
 * Auth: an RS256 JWT signed with the Firebase service-account private key is
 * exchanged for an OAuth access token (cached ~1h). Sends DATA-ONLY messages
 * so the Android app's own service renders the notification — that works even
 * when Android has frozen or killed the app process.
 *
 * Injectable endpoints (tokenUrl/sendUrl) exist purely so tests can point the
 * client at a local mock server.
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const b64url = (input) => Buffer.from(input)
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function request(url, { method = 'POST', headers = {}, body = null, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function createPush(options = {}) {
  let sa = options.serviceAccount || null;
  if (!sa && options.serviceAccountJson) {
    try { sa = JSON.parse(options.serviceAccountJson); } catch { sa = null; }
  }
  if (!sa || !sa.client_email || !sa.private_key) {
    return { enabled: false, sendTo: async () => 'disabled' };
  }
  const projectId = options.projectId || sa.project_id;
  const tokenUrl = options.tokenUrl || 'https://oauth2.googleapis.com/token';
  const sendUrl = options.sendUrl
    || `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

  let cached = null; // { token, expiresAt }

  async function accessToken() {
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    };
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key);
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${body}.${b64url(sig)}`,
    }).toString();
    const res = await request(tokenUrl, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (res.status !== 200) throw new Error('FCM token exchange failed: ' + res.status + ' ' + res.body.slice(0, 200));
    const j = JSON.parse(res.body);
    if (!j.access_token) throw new Error('FCM token exchange: no access_token');
    cached = { token: j.access_token, expiresAt: Date.now() + ((j.expires_in || 3600) * 1000) };
    return cached.token;
  }

  async function post(token, payload) {
    return request(sendUrl, {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
  }

  /** Returns 'ok' | 'invalid' (drop the token) | 'error' (transient) | 'disabled'. */
  async function sendTo(regToken, { title, body, data } = {}) {
    if (!regToken) return 'invalid';
    const payload = {
      message: {
        token: regToken,
        // data-only on purpose: our PushService renders the notification even
        // when the app process is dead (a `notification` payload would be shown
        // by the OS and never reach onMessageReceived while backgrounded).
        data: {
          title: String(title || 'Ghost Chat'),
          body: String(body || ''),
          ...Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
        },
      },
    };
    try {
      let res = await post(await accessToken(), payload);
      if (res.status === 401 || res.status === 403) {
        cached = null; // stale token — refresh once and retry
        res = await post(await accessToken(), payload);
      }
      if (res.status === 200) return 'ok';
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(res.body)) return 'invalid';
      return 'error';
    } catch {
      return 'error';
    }
  }

  return { enabled: true, sendTo, projectId };
}

module.exports = { createPush };
