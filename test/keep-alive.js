/* Keep-alive (persistent foreground notification) + image-picker wiring checks.
 * Static verification of the Android sources, manifest, and web glue:
 *   - KeepAliveService: foreground service, ongoing (non-dismissable) notification
 *   - manifest: permissions + specialUse service declaration
 *   - MainActivity: starts the service, exposes start/stopKeepAlive bridge,
 *     implements the WebView file chooser for <input type="file">
 *   - app.js: starts keep-alive on connect, stops it on sign-out
 * Usage: node test/keep-alive.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('keep-alive + image picker test');

const svc = read('android/app/src/main/java/chat/ghost/app/KeepAliveService.java');
ok(/extends Service/.test(svc) && /startForeground\(/.test(svc), 'KeepAliveService is a foreground service');
ok(/setOngoing\(true\)/.test(svc), 'notification is non-dismissable (setOngoing)');
ok(/START_STICKY/.test(svc), 'service restarts if the OS kills it (START_STICKY)');
ok(/FOREGROUND_SERVICE_TYPE_SPECIAL_USE/.test(svc), 'declares specialUse FGS type for Android 14+');
ok(/IMPORTANCE_LOW/.test(svc), 'channel is silent (IMPORTANCE_LOW)');

const man = read('android/app/src/main/AndroidManifest.xml');
ok(/android.permission.FOREGROUND_SERVICE\b/.test(man) && /FOREGROUND_SERVICE_SPECIAL_USE/.test(man),
  'manifest declares foreground-service permissions');
ok(/\.KeepAliveService/.test(man) && /foregroundServiceType="specialUse"/.test(man) && /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/.test(man),
  'manifest registers KeepAliveService with specialUse type + subtype property');

const act = read('android/app/src/main/java/chat/ghost/app/MainActivity.java');
ok(/KeepAliveService\.start\(this\)/.test(act), 'activity starts keep-alive on launch');
ok(/public void startKeepAlive\(\)/.test(act) && /public void stopKeepAlive\(\)/.test(act),
  'bridge exposes startKeepAlive/stopKeepAlive');
ok(/onShowFileChooser/.test(act) && /ACTION_GET_CONTENT/.test(act) && /REQ_PICK_IMAGE/.test(act),
  'WebView file chooser implemented for the image button');
ok(/onActivityResult/.test(act) && /onReceiveValue/.test(act), 'picker result routed back to the page');

const app = read('public/app.js');
ok(/AndroidBridge\.startKeepAlive/.test(app), 'web starts keep-alive once connected');
ok(/AndroidBridge\.stopKeepAlive/.test(app), 'web stops keep-alive on sign-out');
ok(/image-file/.test(app) && /handleImagePick/.test(app) && /\/api\/upload-image/.test(app),
  'composer image button uploads via the server endpoint');
ok(/openLightbox/.test(app) && /m\.image/.test(app), 'image messages render + open fullscreen');
ok(/IMGBB_CONFIG/.test(app) && /uploadImage/.test(app), 'client-side direct upload with server fallback');
const cfg = read('public/imgbb-config.js');
ok(/apiKey:\s*'[0-9a-f]{32}'/.test(cfg) && /api\.imgbb\.com/.test(cfg), 'imgbb config present with key + endpoint');
const html = read('public/index.html');
ok(/imgbb-config\.js/.test(html) && /app\.js\?v=18/.test(html), 'config script loaded before app.js (v18)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
