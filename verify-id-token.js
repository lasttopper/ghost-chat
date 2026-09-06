/* Server-side Firebase ID-token verification (zero external dependencies).
 *
 * A Firebase ID token is an RS256 JWT signed by Google. We verify it against
 * Google's published securetoken certificates and check the standard claims,
 * then trust ONLY the `sub` (uid) and `email` inside the verified token — never
 * the client-supplied values. This is what makes owner status / account binding
 * unspoofable: a client cannot forge a token for an account it cannot sign into.
 *
 * Reference: https://firebase.google.com/docs/auth/admin/verify-id-tokens
 *
 * Exposed for injection so tests can supply a fake verifier; the real server
 * uses the default export.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');

const PROJECT_ID = String(process.env.FIREBASE_PROJECT_ID || 'ghost-7ed67');
const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_S = 60;

let cache = { certs: null, expiresAt: 0 };

function fetchCerts() {
  return new Promise((resolve, reject) => {
    const req = https.get(CERT_URL, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('cert fetch HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const certs = JSON.parse(body);
          const m = /max-age=(\d+)/i.exec(res.headers['cache-control'] || '');
          const ttl = Math.min(m ? parseInt(m[1], 10) : 3600, 86400);
          cache = { certs, expiresAt: Date.now() + ttl * 1000 };
          resolve(certs);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('cert fetch timeout')); });
    req.on('error', reject);
  });
}

async function getCerts(force) {
  if (!force && cache.certs && Date.now() < cache.expiresAt) return cache.certs;
  return fetchCerts();
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/* Verify signature + claims against a supplied kid->certificate map. Exposed so
 * tests can exercise the crypto/claim logic with a self-signed cert (no
 * network). `certs` is { [kid]: "-----BEGIN CERTIFICATE-----..." }. */
function verifyTokenWithCerts(idToken, certs, projectId = PROJECT_ID) {
  if (typeof idToken !== 'string') throw new Error('token must be a string');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h64, p64, s64] = parts;

  let header;
  try { header = JSON.parse(b64urlToBuf(h64).toString('utf8')); }
  catch { throw new Error('bad header'); }
  if (header.alg !== 'RS256') throw new Error('unexpected alg ' + header.alg);

  const cert = header.kid && certs && certs[header.kid];
  if (!cert) throw new Error('unknown kid');

  let pub;
  try { pub = crypto.createPublicKey(cert); } catch { throw new Error('bad certificate'); }
  const sigOk = crypto.createVerify('RSA-SHA256').update(h64 + '.' + p64).verify(pub, b64urlToBuf(s64));
  if (!sigOk) throw new Error('invalid signature');

  let payload;
  try { payload = JSON.parse(b64urlToBuf(p64).toString('utf8')); }
  catch { throw new Error('bad payload'); }

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('bad audience');
  const iss = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== iss && payload.iss !== iss + '/') throw new Error('bad issuer');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('missing sub');
  if (typeof payload.exp === 'number' && payload.exp + CLOCK_SKEW_S < now) throw new Error('token expired');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > now) throw new Error('token issued in the future');

  return {
    uid: payload.sub,
    email: payload.email || '',
    email_verified: payload.email_verified === true,
    name: payload.name || '',
  };
}

/* Verify an ID token string against Google's live certificates; resolves to
 * { uid, email, email_verified, name } or rejects if not valid for this project. */
async function verifyIdToken(idToken, projectId = PROJECT_ID) {
  const parts = String(idToken || '').split('.');
  let kid;
  try { kid = JSON.parse(b64urlToBuf(parts[0]).toString('utf8')).kid; } catch { throw new Error('bad header'); }
  let certs = await getCerts(false);
  if (!(kid && certs[kid])) certs = await getCerts(true); // kid may have rotated
  return verifyTokenWithCerts(idToken, certs, projectId);
}

module.exports = { verifyIdToken, verifyTokenWithCerts, PROJECT_ID, _resetCertCache: () => { cache = { certs: null, expiresAt: 0 }; } };
