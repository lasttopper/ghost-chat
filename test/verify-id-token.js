/* Unit test for the Firebase ID-token verifier (verify-id-token.js).
 *
 * Generates a real RSA key + self-signed X.509 certificate with openssl, mints
 * RS256 JWTs the way Firebase does, and checks that verifyTokenWithCerts():
 *   - accepts a well-formed token and returns the verified uid/email
 *   - rejects a tampered payload, wrong audience/issuer, expired token,
 *     future iat, and an unknown kid
 * Also confirms the live production path works: fetch Google's real securetoken
 * certificates and verify each parses as a public key.
 *
 * Usage: node test/verify-id-token.js
 */
'use strict';
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { verifyTokenWithCerts } = require('../verify-id-token');

const PROJECT = 'test-project';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const throws = (fn, re, m) => { try { fn(); ok(false, m + ' (did not throw)'); } catch (e) { ok(re.test(e.message), m + ' -> ' + e.message); } };

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// --- generate a real RSA key + self-signed cert with openssl ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idtok-'));
execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${dir}/key.pem -out ${dir}/cert.pem -days 2 -nodes -subj "/CN=securetoken-test" 2>/dev/null`);
const keyPem = fs.readFileSync(dir + '/key.pem', 'utf8');
const certPem = fs.readFileSync(dir + '/cert.pem', 'utf8');
const CERTS = { testkid: certPem };

function mint(payload, kid = 'testkid') {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(keyPem);
  return data + '.' + b64url(sig);
}
const now = Math.floor(Date.now() / 1000);
const baseClaims = {
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
  sub: 'uid_owner_123', email: 'rajkatrina90@gmail.com', email_verified: true,
  name: 'Owner', iat: now - 10, exp: now + 3600,
};

(async () => {
  console.log('verify-id-token unit test');

  const good = mint(baseClaims);
  const v = verifyTokenWithCerts(good, CERTS, PROJECT);
  ok(v.uid === 'uid_owner_123', 'accepts a valid token (uid extracted)');
  ok(v.email === 'rajkatrina90@gmail.com', 'returns the verified email');
  ok(v.email_verified === true, 'returns email_verified');

  // tampered payload (flip a char in the payload segment) -> signature must fail
  const [h, p, s] = good.split('.');
  const tamperedPayload = b64url(JSON.stringify({ ...baseClaims, email: 'attacker@evil.com' }));
  throws(() => verifyTokenWithCerts(h + '.' + tamperedPayload + '.' + s, CERTS, PROJECT), /invalid signature/i, 'rejects a tampered payload (re-signed email)');

  // wrong audience / issuer
  throws(() => verifyTokenWithCerts(mint({ ...baseClaims, aud: 'some-other-project' }), CERTS, PROJECT), /audience/i, 'rejects wrong audience');
  throws(() => verifyTokenWithCerts(mint({ ...baseClaims, iss: 'https://securetoken.google.com/other' }), CERTS, PROJECT), /issuer/i, 'rejects wrong issuer');

  // expired / future
  throws(() => verifyTokenWithCerts(mint({ ...baseClaims, exp: now - 3600 }), CERTS, PROJECT), /expired/i, 'rejects an expired token');
  throws(() => verifyTokenWithCerts(mint({ ...baseClaims, iat: now + 3600 }), CERTS, PROJECT), /future/i, 'rejects a token issued in the future');

  // unknown kid
  throws(() => verifyTokenWithCerts(mint(baseClaims, 'unknownkid'), CERTS, PROJECT), /unknown kid/i, 'rejects an unknown kid');

  // missing sub
  throws(() => verifyTokenWithCerts(mint({ ...baseClaims, sub: undefined }), CERTS, PROJECT), /missing sub/i, 'rejects a token without sub');

  // --- live production path: Google's real certs must parse as public keys ---
  await new Promise((resolve) => {
    https.get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try {
          const certs = JSON.parse(body);
          const kids = Object.keys(certs);
          let allParse = kids.length > 0;
          for (const k of kids) { try { crypto.createPublicKey(certs[k]); } catch { allParse = false; } }
          ok(allParse, `live Google securetoken certs parse as public keys (${kids.length} kid(s))`);
        } catch (e) { ok(false, 'live Google cert fetch/parse: ' + e.message); }
        resolve();
      });
    }).on('error', (e) => { console.log('  (skipped live cert check:', e.message + ')'); resolve(); });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
