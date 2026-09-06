/* Unit test for the zero-dep FCM HTTP v1 client (push.js) against a local
 * mock server: JWT is correctly formed + RS256-verified, the access token is
 * cached, payloads are data-only strings, 401 re-auths once, 404 -> 'invalid'.
 * Usage: node test/push-client.js
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { createPush } = require('../push');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \u2713', m); };
const bad = (m, e) => { fail++; console.log('  \u2717', m, '::', (e && e.message) || e); };

(async () => {
  console.log('push-client (FCM v1) test');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  let tokenHits = 0;
  let lastAssertion = null;
  let sendStatus = 200;
  let lastSend = null;
  let forceOne401 = false;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        tokenHits++;
        lastAssertion = new URLSearchParams(body).get('assertion');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'AT-' + tokenHits, expires_in: 3600 }));
      } else if (req.url === '/send') {
        lastSend = { auth: req.headers.authorization, body: JSON.parse(body) };
        if (forceOne401) { forceOne401 = false; res.writeHead(401); res.end('{}'); return; }
        res.writeHead(sendStatus, { 'Content-Type': 'application/json' });
        res.end(sendStatus === 200 ? '{"name":"projects/p/messages/1"}' : '{"error":{"message":"nope"}}');
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const push = createPush({
    serviceAccount: { client_email: 'sender@ghost-7ed67.iam.gserviceaccount.com', private_key: privateKey, project_id: 'ghost-7ed67' },
    tokenUrl: base + '/token',
    sendUrl: base + '/send',
  });

  try {
    assert.strictEqual(push.enabled, true);
    ok('enabled with a valid service account');

    const r1 = await push.sendTo('device-token-1', { title: '#general — @bob', body: 'hi there', data: { conv: 'general' } });
    assert.strictEqual(r1, 'ok', 'send should return ok, got ' + r1);
    ok('send returns ok on HTTP 200');

    // JWT structure + signature
    const parts = String(lastAssertion).split('.');
    assert.strictEqual(parts.length, 3, 'JWT has 3 parts');
    const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const header = JSON.parse(b64d(parts[0]));
    const claims = JSON.parse(b64d(parts[1]));
    assert.strictEqual(header.alg, 'RS256');
    assert.strictEqual(claims.iss, 'sender@ghost-7ed67.iam.gserviceaccount.com');
    assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.strictEqual(claims.aud, base + '/token');
    const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const verified = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(publicKey, sig);
    assert(verified, 'JWT signature verifies with the service-account public key');
    ok('JWT claims correct and RS256 signature verifies');

    // payload shape: data-only, all strings, bearer token
    const msg = lastSend.body.message;
    assert.strictEqual(msg.token, 'device-token-1');
    assert.strictEqual(msg.notification, undefined, 'must be data-only');
    assert.strictEqual(msg.data.title, '#general — @bob');
    assert.strictEqual(msg.data.body, 'hi there');
    assert.strictEqual(msg.data.conv, 'general');
    for (const v of Object.values(msg.data)) assert.strictEqual(typeof v, 'string');
    assert.strictEqual(lastSend.auth, 'Bearer AT-1');
    ok('payload is data-only with string values + bearer auth');

    // token caching
    await push.sendTo('device-token-1', { title: 't', body: 'b' });
    assert.strictEqual(tokenHits, 1, 'access token should be cached, token endpoint hits: ' + tokenHits);
    ok('access token is cached across sends');

    // 401 -> re-auth once and retry
    forceOne401 = true;
    const r2 = await push.sendTo('device-token-1', { title: 't', body: 'b' });
    assert.strictEqual(r2, 'ok', 'should recover after a 401, got ' + r2);
    assert.strictEqual(tokenHits, 2, 'a 401 forces one token refresh');
    assert.strictEqual(lastSend.auth, 'Bearer AT-2');
    ok('401 triggers one re-auth + retry');

    // 404 -> invalid (caller prunes the token)
    sendStatus = 404;
    const r3 = await push.sendTo('dead-token', { title: 't', body: 'b' });
    assert.strictEqual(r3, 'invalid');
    ok("404 (UNREGISTERED device) returns 'invalid' so the core can prune it");

    // no service account -> disabled, safe no-op
    const off = createPush({});
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(await off.sendTo('x', {}), 'disabled');
    ok('without a service account the sender is disabled and inert');
  } catch (e) { bad('push client', e); }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
