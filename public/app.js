/* Ghost Chat — frontend */
(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const COLORS = ['#8b5cf6', '#6366f1', '#ec4899', '#f43f5e', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'];
const EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '✅', '🙌', '😍', '🤔', '👏', '💯', '🚀', '😮', '😢', '🥳', '💪', '🙏', '👌', '😅', '🤝', '⭐', '☕', '🍕'];
const TYPING_EXPIRE_MS = 4500;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/* localStorage can throw in sandboxed iframes — memory fallback */
const mem = {};
const ls = {
  get(k) { try { const v = localStorage.getItem(k); return v === null ? (mem[k] ?? null) : v; } catch { return mem[k] ?? null; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch {} },
  del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch {} },
};

const S = {
  ws: null,
  me: null,                    // { authId, email, displayName, username, color, mode }
  channels: [], dms: [],       // server conversations
  users: {},
  online: new Set(),
  prevOnline: null,
  active: null,
  typing: {},                  // convId -> Map(username -> ts)
  serverNow: Date.now(),
  reconnectDelay: 1000,
  typingThrottle: 0,
  typingStopTimer: null,
  picker: { mode: null },
  pendingJoinCode: null,
  report: null,                // { convId, messageId, targetUser, preview }
  fb: null,                    // firebase auth bundle or null (guest mode)
  seenMsg: new Set(),          // message ids already rendered (entrance animation)
  showOffline: false,          // People list: offline members collapsed by default
};

let lastRead = {};
try { lastRead = JSON.parse(ls.get('ghost.lastRead') || '{}'); } catch {}
const saveLastRead = () => ls.set('ghost.lastRead', JSON.stringify(lastRead));

/* ------------------------------ helpers ------------------------------ */

const getConv = (id) => S.channels.find((c) => c.id === id) || S.dms.find((d) => d.id === id);
const userColor = (u) => (S.users[u] && S.users[u].color) || '#8b5cf6';
const initials = (name) => name.split(/[\s_]+/).map((w) => w[0]).join('').slice(0, 2) || '?';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dmPartner = (conv) => conv.members.find((m) => m !== (S.me && S.me.username)) || conv.members[0];
const convTitle = (conv) => conv.type === 'dm' ? '@' + dmPartner(conv) : '#' + conv.name;

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/* ------------------------------ notifications ------------------------------ */

let notifEnabled = ls.get('ghost.notif') === '1';

function notifSupported() {
  if (typeof window === 'undefined') return false;
  if ('Notification' in window) return true;
  // Android has no Notification constructor but SW notifications work fine
  const SWR = window.ServiceWorkerRegistration;
  return !!(navigator.serviceWorker && SWR && SWR.prototype && 'showNotification' in SWR.prototype);
}

async function toggleNotifications() {
  if (!notifSupported()) { toast('Notifications are not supported here.'); return; }
  if (notifEnabled) {
    notifEnabled = false;
    ls.set('ghost.notif', '0');
    updateNotifBtn();
    toast('🔕 Notifications muted');
    return;
  }
  if (typeof Notification === 'undefined') {
    // Android/TWA: no Notification constructor, but SW notifications are
    // delegated to the OS by the launcher — no JS permission prompt needed.
    notifEnabled = true;
    ls.set('ghost.notif', '1');
    updateNotifBtn();
    toast('🔔 Notifications on');
    return;
  }
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      notifEnabled = true;
      ls.set('ghost.notif', '1');
      toast('🔔 Notifications on');
    } else {
      toast('Notification permission denied by the browser.');
    }
  } catch { toast('Could not request notification permission.'); }
  updateNotifBtn();
}

function updateNotifBtn() {
  const btn = document.getElementById('notif-btn');
  if (!btn) return;
  btn.textContent = notifEnabled ? '🔔' : '🔕';
  btn.title = notifEnabled ? 'Notifications on — click to mute' : 'Notifications off — click to enable';
}

function notifyMessage(m) {
  if (!notifEnabled) return;
  if (m.system) return;
  if (m.username === S.me.username) return;
  // quiet when you're looking at the conversation that got the message
  if (!document.hidden && m.channel === S.active) return;
  const conv = getConv(m.channel);
  const where = conv
    ? (conv.type === 'dm' ? `@${dmPartner(conv)}` : `${conv.private ? '🔒 ' : '#'}${conv.name}`)
    : 'Ghost Chat';
  const title = `${where} — @${m.username}`;
  const body = m.text.length > 110 ? m.text.slice(0, 110) + '…' : m.text;

  // Native Android app (WebView): a WebView has no Web Notification UI, so the
  // native side shows the system notification. window.AndroidBridge is injected
  // ONLY inside the APK (absent in a normal browser / TWA), so this is safe
  // everywhere else.
  if (window.AndroidBridge && typeof window.AndroidBridge.showNotification === 'function') {
    try { window.AndroidBridge.showNotification(title, body, 'gc-' + m.channel); } catch {}
    return;
  }

  // Web / TWA path
  if (!notifSupported()) return;
  // Desktop (Notification constructor present) needs explicit permission.
  // Android/TWA has no constructor and relies on SW notifications delegated
  // to the OS, so only block when the constructor exists AND isn't granted.
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;
  const opts = {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'gc-' + m.channel, // one notification per conversation, newest wins
    data: { convId: m.channel },
  };
  try {
    // Android (incl. the TWA) has no Notification constructor — always go
    // through the service worker when one exists; desktop falls back to the
    // constructor. `ready` resolves even before the SW controls this page.
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready
        .then((reg) => reg.showNotification(title, opts))
        .catch(() => { try { new Notification(title, opts); } catch {} });
    } else {
      new Notification(title, opts);
    }
  } catch {}
}

/* --------------------- native Android bridge (WebView APK) ---------------------
 * Inside the APK, window.AndroidBridge is injected by the native shell. Google
 * OAuth is blocked in embedded WebViews, so Google sign-in happens NATIVELY
 * (Credential Manager + Firebase Auth) and the bridge serves the page real
 * Firebase ID tokens (the native side handles refresh). Same uid/email as a
 * web Google login => one account across web and app. Email/password + guest
 * flows are untouched (they work fine inside a WebView). */

const isNativeApp = () => {
  try { return !!(window.AndroidBridge && window.AndroidBridge.isNative && window.AndroidBridge.isNative()); } catch { return false; }
};
let nativeAuth = false; // current session is held by the native app

let bridgeTokenResolve = null;
window.__ghostIdToken = (tok) => {
  const r = bridgeTokenResolve; bridgeTokenResolve = null;
  if (r) r(tok || '');
};
function getBridgeIdToken(timeoutMs = 8000) {
  return new Promise((resolve) => {
    bridgeTokenResolve = resolve;
    try { window.AndroidBridge.requestFirebaseIdToken(); }
    catch { bridgeTokenResolve = null; resolve(''); return; }
    setTimeout(() => { if (bridgeTokenResolve === resolve) { bridgeTokenResolve = null; resolve(''); } }, timeoutMs);
  });
}

let googleAuthResolve = null;
window.__ghostGoogleAuth = (res) => {
  const r = googleAuthResolve; googleAuthResolve = null;
  if (r) r(res && typeof res === 'object' ? res : { ok: false, error: 'sign-in failed' });
};
async function nativeGoogleSignIn() {
  const res = await new Promise((resolve) => {
    googleAuthResolve = resolve;
    try { window.AndroidBridge.googleSignIn(); }
    catch { googleAuthResolve = null; resolve({ ok: false, error: 'Google sign-in is unavailable.' }); return; }
    setTimeout(() => { if (googleAuthResolve === resolve) { googleAuthResolve = null; resolve({ ok: false, error: 'Google sign-in timed out.' }); } }, 180000);
  });
  if (res.ok && res.uid) {
    nativeAuth = true;
    S.me = {
      authId: res.uid, email: res.email || '', displayName: res.displayName || '',
      mode: 'firebase', username: null,
      color: ls.get('ghost.colorFor.' + res.uid) || pickedColor,
    };
    ls.set('ghost.session', JSON.stringify({
      authId: res.uid, mode: 'firebase', email: res.email || '', displayName: res.displayName || '',
    }));
    afterAuth();
  } else if (!/cancel|no credential/i.test(String(res.error || ''))) {
    // a cancelled account picker is not an error worth shouting about
    const el = $('#auth-error');
    el.textContent = res.error || 'Google sign-in failed.';
    el.classList.remove('hidden');
  }
}

/* ------------------------------ firebase ------------------------------ */

// On sandbox preview hosts (PORT-sandboxid.domain) point at the emulator's
// own proxied port; locally use the standard emulator address.
function emulatorUrlFor() {
  const m = location.hostname.match(/^(\d+)-(.+)$/);
  if (m && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    return `${location.protocol}//9099-${m[2]}`;
  }
  return 'http://127.0.0.1:9099';
}

async function loadFirebase() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg) return null;
  const hasRealKeys = cfg.apiKey && !/YOUR_/.test(cfg.apiKey) && !/^demo-/.test(cfg.apiKey);
  const hostIsLocalish = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || /\.e2b\.app$/.test(location.hostname);
  const useEmulator = cfg.emulator === true || (cfg.emulator === 'auto' && hostIsLocalish);
  if (!hasRealKeys && !useEmulator) return null; // guest mode
  try {
    const [appMod, authMod] = await Promise.race([
      Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
      ]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('firebase SDK load timeout')), 10000)),
    ]);
    const app = appMod.initializeApp({
      apiKey: cfg.apiKey || 'demo-emulator-key',
      authDomain: cfg.authDomain || 'localhost',
      projectId: cfg.projectId || 'demo-ghost-chat',
      storageBucket: cfg.storageBucket,
      messagingSenderId: cfg.messagingSenderId,
      appId: cfg.appId,
    });
    const auth = authMod.getAuth(app);
    if (useEmulator) {
      authMod.connectAuthEmulator(auth, emulatorUrlFor(), { disableWarnings: true });
    }
    return { auth, authMod, emulator: useEmulator };
  } catch (e) {
    console.warn('Firebase unavailable, guest mode only:', e);
    return null;
  }
}

/* ------------------------------ websocket ------------------------------ */

function wsUrl() {
  // Optional split hosting: frontend on GitHub Pages (or anywhere static),
  // backend on Render/Railway/etc. Otherwise same-origin.
  const backend = String(window.GHOST_BACKEND || '').trim();
  const base = backend ? new URL(backend) : new URL(location.href);
  const isVercel = /\.vercel\.app$/i.test(base.hostname);
  const proto = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${base.host}${isVercel ? '/api/ws' : '/ws'}`;
}

function connect() {
  // retire any previous socket without letting its onclose spawn a duplicate
  if (S.ws) { try { S.ws.onclose = null; S.ws.onmessage = null; S.ws.close(); } catch {} }
  if (S.openTimer) clearTimeout(S.openTimer);
  S.ws = new WebSocket(wsUrl());
  // Safety net: if the socket never opens (hung CONNECTING on a bad network),
  // force it closed so onclose fires and the retry loop keeps trying — the UI
  // must never sit on "connecting…" forever.
  S.openTimer = setTimeout(() => { try { if (S.ws && S.ws.readyState !== 1) S.ws.close(); } catch {} }, 10000);
  S.ws.onopen = async () => {
    clearTimeout(S.openTimer);
    S.reconnectDelay = 1000;
    $('#reconnect-banner').classList.add('hidden');
    // Attach a Firebase ID token when signed in so the server can VERIFY our
    // identity (uid + email) cryptographically instead of trusting client values.
    // Guests have no token and join unverified (never the owner).
    let idToken = '';
    try {
      if (nativeAuth && window.AndroidBridge) {
        idToken = await getBridgeIdToken(); // native app holds the session
      } else if (S.fb && S.fb.authMod) {
        const u = S.fb.authMod.currentUser(S.fb.auth);
        if (u) idToken = await S.fb.authMod.getIdToken(u);
      }
    } catch {}
    if (!S.ws || S.ws.readyState !== 1) return; // socket changed while fetching the token
    send({
      type: 'join', username: S.me.username, authId: S.me.authId,
      email: S.me.email, displayName: S.me.displayName, color: S.me.color,
      idToken,
    });
  };
  S.ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    route(msg);
  };
  S.ws.onclose = () => {
    const banner = $('#reconnect-banner');
    banner.textContent = (S.channels.length || S.dms.length)
      ? 'Offline — showing saved messages. Reconnecting…'
      : 'Connection lost — reconnecting…';
    banner.classList.remove('hidden');
    const st = $('#me-status');
    if (st) { st.textContent = 'reconnecting…'; st.classList.add('offline'); }
    setTimeout(connect, S.reconnectDelay);
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 10000);
  };
}

const send = (obj) => {
  if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; }
  return false;
};

function route(msg) {
  switch (msg.type) {
    case 'init': {
      S.channels = msg.channels || [];
      S.dms = msg.dms || [];
      S.users = msg.users || {};
      S.online = new Set(msg.online || []);
      S.serverNow = msg.now;
      S.me.username = msg.username;
      S.me.owner = !!msg.isOwner; // global owner (super-admin) account
      // remember the account-bound name + color locally (fast next boot)
      ls.set('ghost.usernameFor.' + S.me.authId, msg.username);
      const meRec = S.users[msg.username];
      if (meRec && meRec.color) {
        S.me.color = meRec.color;
        ls.set('ghost.colorFor.' + S.me.authId, meRec.color);
      }
      renderMe();
      for (const conv of [...S.channels, ...S.dms]) {
        if (!(conv.id in lastRead)) lastRead[conv.id] = S.serverNow;
        if (!S.typing[conv.id]) S.typing[conv.id] = new Map();
      }
      saveLastRead();
      if (!S.active || !getConv(S.active)) S.active = (getConv('general') || S.channels[0] || S.dms[0] || {}).id || null;
      if (!S.prevOnline) S.prevOnline = new Set(S.online);
      renderAll();
      const st = $('#me-status');
      if (st) { st.textContent = 'online'; st.classList.remove('offline'); }
      scrollBottom(true);
      if (S.pendingJoinCode) {
        send({ type: 'join_channel', code: S.pendingJoinCode });
        S.pendingJoinCode = null;
      }
      break;
    }
    case 'message': onMessage(msg.message); break;
    case 'reactions': onReactions(msg); break;
    case 'message_deleted': {
      const conv = getConv(msg.channelId);
      if (conv) {
        conv.messages = conv.messages.filter((m) => m.id !== msg.messageId);
        if (msg.channelId === S.active) renderMessages();
        renderSidebar();
      }
      break;
    }
    case 'presence': onPresence(msg.online); break;
    case 'typing': onTyping(msg, false); break;
    case 'typing_stop': onTyping(msg, true); break;
    case 'channel_created': {
      S.channels.push(msg.channel);
      S.typing[msg.channel.id] = new Map();
      lastRead[msg.channel.id] = S.serverNow; saveLastRead();
      renderSidebar();
      switchConv(msg.channel.id); // always open the group you just made
      if (msg.channel.private) {
        showInviteModal(inviteLink(msg.channel.inviteCode));
      } else {
        toast(`Created #${msg.channel.name}`);
      }
      break;
    }
    case 'channel_joined': {
      if (!S.channels.some((c) => c.id === msg.channel.id)) S.channels.push(msg.channel);
      S.typing[msg.channel.id] = S.typing[msg.channel.id] || new Map();
      lastRead[msg.channel.id] = S.serverNow; saveLastRead();
      switchConv(msg.channel.id);
      toast(`Joined ${msg.channel.private ? 'private group ' : ''}#${msg.channel.name}`);
      break;
    }
    case 'member_joined': {
      const conv = getConv(msg.channelId);
      if (conv && !conv.members.includes(msg.username)) conv.members.push(msg.username);
      if (S.active === msg.channelId) renderHeader();
      break;
    }
    case 'member_added': {
      const conv = getConv(msg.channelId);
      if (conv && !conv.members.includes(msg.username)) conv.members.push(msg.username);
      if (S.active === msg.channelId) renderHeader();
      if (msg.username === S.me.username) toast(`You were added to #${conv ? conv.name : msg.channelId}`);
      if (!$('#members-modal-backdrop').classList.contains('hidden')) drawMembers();
      break;
    }
    case 'member_removed': {
      const conv = getConv(msg.channelId);
      if (conv) {
        conv.members = conv.members.filter((m) => m !== msg.username);
        if (Array.isArray(conv.admins)) conv.admins = conv.admins.filter((a) => a !== msg.username);
      }
      if (S.active === msg.channelId) renderHeader();
      if (!$('#members-modal-backdrop').classList.contains('hidden')) drawMembers();
      break;
    }
    case 'admins_updated': {
      const conv = getConv(msg.channelId);
      if (conv) conv.admins = msg.admins;
      if (!$('#members-modal-backdrop').classList.contains('hidden')) drawMembers();
      break;
    }
    case 'removed_from_channel': {
      const i = S.channels.findIndex((c) => c.id === msg.channelId);
      if (i >= 0) S.channels.splice(i, 1);
      $('#members-modal-backdrop').classList.add('hidden');
      toast('You were removed from the group.', 'leave');
      if (S.active === msg.channelId) {
        const next = S.channels[0] || S.dms[0];
        S.active = null;
        if (next) switchConv(next.id); else renderAll();
      }
      renderSidebar();
      break;
    }
    case 'dm_ready': {
      const i = S.dms.findIndex((d) => d.id === msg.conv.id);
      if (i >= 0) S.dms[i] = msg.conv; else S.dms.push(msg.conv);
      S.typing[msg.conv.id] = S.typing[msg.conv.id] || new Map();
      if (!(msg.conv.id in lastRead)) { lastRead[msg.conv.id] = S.serverNow; saveLastRead(); }
      if (msg.isNew && dmPartner(msg.conv) !== S.me.username && msg.conv.members[0] !== S.me.username) {
        toast(`New DM from @${dmPartner(msg.conv)}`);
      }
      renderSidebar();
      if (!getConv(S.active)) switchConv(msg.conv.id);
      break;
    }
    case 'report_ack': toast('🚩 Report filed — sent to admins at midnight.'); break;
    case 'need_username': showUsernameSetup(msg.reason || ''); break;
    case 'username_taken': showUsernameSetup(`@${msg.username} belongs to another account. Pick a different one.`); break;
    case 'auth_failed':
      // The server could not verify this session's identity. Drop the stored
      // session and require a fresh sign-in (never silently trust it again).
      toast(msg.message || 'Please sign in again.');
      ls.del('ghost.session');
      if (S.fb && S.fb.authMod) { try { S.fb.authMod.signOut(S.fb.auth); } catch {} }
      S.me = null;
      showLogin();
      break;
    case 'error': toast(msg.message); break;
  }
  // keep the offline preview mirror fresh (typing events are too noisy)
  if (msg.type !== 'typing' && msg.type !== 'typing_stop') queueCacheSave();
}

function onMessage(m) {
  const conv = getConv(m.channel);
  if (!conv) return;
  conv.messages.push(m);
  if (m.channel === S.active) {
    lastRead[m.channel] = m.ts; saveLastRead();
    renderMessages();
    scrollBottom(m.username === S.me.username);
    renderTyping();
  }
  notifyMessage(m);
  renderSidebar();
}

function onReactions({ channelId, messageId, reactions }) {
  const conv = getConv(channelId);
  const m = conv && conv.messages.find((x) => x.id === messageId);
  if (!m) return;
  m.reactions = reactions;
  if (channelId === S.active) {
    const el = document.querySelector(`[data-msg-id="${messageId}"] .reactions`);
    if (el) el.replaceWith(buildReactions(m));
  }
}

function onPresence(online) {
  S.online = new Set(online);
  // Presence toasts are only pleasant in small groups; stay quiet when busy.
  if (S.prevOnline && S.online.size <= 12 && S.prevOnline.size <= 12) {
    for (const u of S.online) if (!S.prevOnline.has(u) && u !== S.me.username) toast(`@${u} came online`);
    for (const u of S.prevOnline) if (!S.online.has(u) && u !== S.me.username) toast(`@${u} went offline`, 'leave');
  }
  S.prevOnline = new Set(S.online);
  renderSidebar();
}

function onTyping(msg, stop) {
  const map = S.typing[msg.channel] || (S.typing[msg.channel] = new Map());
  if (stop) map.delete(msg.username);
  else map.set(msg.username, Date.now());
  if (msg.channel === S.active) renderTyping();
}

/* ------------------------------ rendering ------------------------------ */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderMessages();
  renderTyping();
  updatePlaceholder();
}

function unreadCount(conv) {
  const since = lastRead[conv.id] || 0;
  return conv.messages.filter((m) => !m.system && m.ts > since).length;
}

function makeBadge(n) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = n > 99 ? '99+' : String(n);
  return badge;
}

/* Show total unread in the browser tab / launcher title. */
function updateTitle() {
  let total = 0;
  for (const conv of [...S.channels, ...S.dms]) {
    if (conv.id !== S.active) total += unreadCount(conv);
  }
  try { document.title = total > 0 ? `(${total > 99 ? '99+' : total}) Ghost Chat` : 'Ghost Chat'; } catch {}
}

function renderSidebar() {
  $('#online-count').textContent = `${S.online.size} online`;

  /* DMs */
  const dmList = $('#dm-list');
  dmList.innerHTML = '';
  for (const dm of S.dms) {
    const partner = dmPartner(dm);
    const n = unreadCount(dm);
    const btn = document.createElement('button');
    btn.className = 'dm-item' + (dm.id === S.active ? ' active' : '') + (n > 0 && dm.id !== S.active ? ' unread' : '');
    const av = document.createElement('span');
    av.className = 'dm-avatar';
    av.style.background = userColor(partner);
    av.textContent = initials(partner);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = '@' + partner;
    if (S.users[partner] && S.users[partner].bot) {
      const bb = document.createElement('span');
      bb.className = 'bot-badge'; bb.textContent = '🤖'; bb.title = 'Assistant';
      name.appendChild(bb);
    }
    btn.append(av, name);
    if (n > 0) btn.appendChild(makeBadge(n));
    btn.onclick = () => switchConv(dm.id);
    dmList.appendChild(btn);
  }
  if (!S.dms.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'font-size:12.5px;padding:4px 8px';
    empty.textContent = 'No DMs yet — hit ＋';
    dmList.appendChild(empty);
  }

  /* Channels */
  const list = $('#channel-list');
  list.innerHTML = '';
  for (const ch of S.channels) {
    const n = unreadCount(ch);
    const btn = document.createElement('button');
    btn.className = 'ch-item' + (ch.id === S.active ? ' active' : '') + (n > 0 && ch.id !== S.active ? ' unread' : '');
    const hash = document.createElement('span');
    hash.className = 'hash';
    hash.textContent = ch.private ? '🔒' : '#';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = ch.name;
    btn.append(hash, name);
    if (n > 0) btn.appendChild(makeBadge(n));
    btn.onclick = () => switchConv(ch.id);
    list.appendChild(btn);
  }

  /* People — online first; offline collapsed behind a toggle */
  const team = $('#team-list');
  team.innerHTML = '';
  const allNames = Object.keys(S.users).filter((u) => !(S.users[u] && S.users[u].bot));
  const peopleOnline = $('#people-online');
  if (peopleOnline) peopleOnline.textContent = `${S.online.size} online`;
  const onlineNamesList = allNames.filter((n) => S.online.has(n)).sort((a, b) => a.localeCompare(b));
  const offlineNamesList = allNames.filter((n) => !S.online.has(n)).sort((a, b) => a.localeCompare(b));

  const makeRow = (name, on) => {
    const row = document.createElement('div');
    row.className = 'team-item' + (on ? '' : ' offline-name');
    const dot = document.createElement('span'); dot.className = 'dot' + (on ? '' : ' offline');
    const label = document.createElement('span'); label.textContent = '@' + name;
    row.append(dot, label);
    if (name === S.me.username) {
      const you = document.createElement('span'); you.className = 'you'; you.textContent = '(you)';
      row.appendChild(you);
    }
    return row;
  };

  for (const name of onlineNamesList) team.appendChild(makeRow(name, true));

  if (offlineNamesList.length) {
    const tgl = document.createElement('button');
    tgl.className = 'offline-toggle';
    tgl.textContent = S.showOffline
      ? `▾ Hide ${offlineNamesList.length} offline`
      : `▸ Show ${offlineNamesList.length} offline`;
    tgl.onclick = () => { S.showOffline = !S.showOffline; renderSidebar(); };
    team.appendChild(tgl);
    if (S.showOffline) {
      for (const name of offlineNamesList) team.appendChild(makeRow(name, false));
    }
  }
  updateTitle();
}

function renderHeader() {
  const conv = getConv(S.active);
  const icon = $('#ch-kind-icon');
  const name = $('#ch-name');
  const topic = $('#ch-topic');
  const invite = $('#invite-btn');
  const members = $('#members-btn');
  if (!conv) { icon.textContent = '#'; name.textContent = ''; topic.textContent = ''; invite.classList.add('hidden'); members.classList.add('hidden'); return; }
  if (conv.type === 'dm') {
    const partner = dmPartner(conv);
    icon.textContent = '@';
    name.textContent = partner;
    topic.textContent = S.online.has(partner) ? '🟢 online' : 'offline';
    invite.classList.add('hidden');
    members.classList.add('hidden');
  } else {
    icon.textContent = conv.private ? '🔒' : '#';
    name.textContent = conv.name;
    topic.textContent = conv.private
      ? `Private group · ${conv.members.length} member${conv.members.length === 1 ? '' : 's'}`
      : (conv.topic || '');
    invite.classList.toggle('hidden', !conv.private);
    members.classList.toggle('hidden', !conv.private);
  }
}

function renderMessages() {
  const box = $('#messages');
  const conv = getConv(S.active);
  box.innerHTML = '';
  if (!conv) return;
  let prev = null, prevDay = null;
  for (const m of conv.messages) {
    const day = new Date(m.ts).toDateString();
    if (day !== prevDay) {
      const div = document.createElement('div');
      div.className = 'day-divider';
      const span = document.createElement('span'); span.textContent = dayLabel(m.ts);
      div.appendChild(span);
      box.appendChild(div);
      prevDay = day; prev = null;
    }
    const grouped = prev && !m.system && !prev.system &&
      prev.username === m.username && (m.ts - prev.ts) < GROUP_WINDOW_MS;
    const fresh = !m.system && !S.seenMsg.has(m.id);
    if (fresh) {
      S.seenMsg.add(m.id);
      if (S.seenMsg.size > 6000) S.seenMsg.clear(); // keep bounded
    }
    box.appendChild(m.system ? buildSystem(m) : buildMsg(m, grouped, fresh));
    prev = m;
  }
}

function buildSystem(m) {
  const row = document.createElement('div');
  row.className = 'msg system';
  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = m.text;
  row.appendChild(text);
  return row;
}

/* Render message text safely as DOM: clickable http(s) links + highlighted
 * @mentions. Never injects HTML from user content (textContent / href only). */
function renderRichText(el, str) {
  const re = /(https?:\/\/[^\s<]+)|(@[a-z0-9_]{3,20})/gi;
  let last = 0, m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
    const tok = m[0];
    if (tok.charAt(0).toLowerCase() === 'h') {
      const a = document.createElement('a');
      a.href = tok; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      a.className = 'msg-link';
      a.textContent = tok;
      el.appendChild(a);
    } else {
      const uname = tok.slice(1).toLowerCase();
      if (S.users[uname]) {
        const span = document.createElement('span');
        span.className = 'mention' + (uname === (S.me.username || '') ? ' mention-me' : '');
        span.textContent = tok;
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(tok)); // not a real user — leave as plain text
      }
    }
    last = re.lastIndex;
  }
  if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
}

function buildMsg(m, grouped, fresh) {
  const row = document.createElement('div');
  row.className = 'msg' + (grouped ? ' grouped' : '') + (fresh ? ' fresh' : '');
  row.dataset.msgId = m.id;

  const avCol = document.createElement('div');
  avCol.className = 'msg-avatar-col';
  if (!grouped) {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = m.color || userColor(m.username);
    av.textContent = initials(m.username);
    avCol.appendChild(av);
  } else {
    const t = document.createElement('div');
    t.className = 'grouped-time';
    t.textContent = fmtTime(m.ts);
    avCol.appendChild(t);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (!grouped) {
    const head = document.createElement('div');
    head.className = 'msg-head';
    const author = document.createElement('span');
    author.className = 'author';
    author.style.color = m.color || userColor(m.username);
    author.textContent = '@' + m.username;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(m.ts);
    if (m.bot) {
      const bb = document.createElement('span');
      bb.className = 'bot-badge'; bb.textContent = '🤖 assistant'; bb.title = 'Built-in assistant';
      head.append(author, bb, time);
    } else {
      head.append(author, time);
    }
    body.appendChild(head);
  }
  const text = document.createElement('div');
  text.className = 'msg-text';
  renderRichText(text, m.text);
  body.appendChild(text);
  body.appendChild(buildReactions(m));

  const conv = getConv(m.channel);
  const canDelete = !m.system && (m.username === S.me.username || (conv && isChannelAdmin(conv)));
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const rxBtn = document.createElement('button');
  rxBtn.textContent = '😀';
  rxBtn.title = 'Add reaction';
  rxBtn.onclick = (e) => openPicker(e.currentTarget, { mode: 'react', convId: m.channel, messageId: m.id });
  const repBtn = document.createElement('button');
  repBtn.textContent = '🚩';
  repBtn.title = 'Report message';
  repBtn.onclick = () => openReportModal(m);
  actions.append(rxBtn, repBtn);
  if (canDelete) {
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete message';
    delBtn.onclick = () => {
      let go = true;
      try { go = confirm('Delete this message?'); } catch {}
      if (go) send({ type: 'delete_message', channelId: m.channel, messageId: m.id });
    };
    actions.appendChild(delBtn);
  }

  row.append(avCol, body, actions);
  return row;
}

function buildReactions(m) {
  const wrap = document.createElement('div');
  wrap.className = 'reactions';
  for (const [emoji, users] of Object.entries(m.reactions || {})) {
    const pill = document.createElement('button');
    pill.className = 'rx' + (users.includes(S.me.username) ? ' mine' : '');
    pill.title = users.map((u) => '@' + u).join(', ');
    const e = document.createElement('span'); e.textContent = emoji;
    const c = document.createElement('span'); c.className = 'count'; c.textContent = String(users.length);
    pill.append(e, c);
    pill.onclick = () => send({ type: 'react', channelId: m.channel, messageId: m.id, emoji });
    wrap.appendChild(pill);
  }
  const add = document.createElement('button');
  add.className = 'rx-add';
  add.textContent = '＋';
  add.title = 'Add reaction';
  add.onclick = (e) => openPicker(e.currentTarget, { mode: 'react', convId: m.channel, messageId: m.id });
  wrap.appendChild(add);
  return wrap;
}

function scrollBottom(force) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

/* ------------------------------ conversations ------------------------------ */

function switchConv(id) {
  closeNav(); // tapping any sidebar item (even the active one) closes the mobile drawer
  if (S.active === id) return;
  S.active = id;
  const conv = getConv(id);
  if (conv) {
    if (conv.messages.length) lastRead[id] = conv.messages[conv.messages.length - 1].ts;
    else lastRead[id] = S.serverNow;
    conv.messages.forEach((m) => S.seenMsg.add(m.id)); // no entrance anim on switch
  }
  saveLastRead();
  renderAll();
  scrollBottom(true);
  updatePlaceholder();
  let hover = false;
  try { hover = window.matchMedia('(hover: hover)').matches; } catch {}
  if (hover) $('#input').focus(); // don't pop the mobile keyboard
}

function updatePlaceholder() {
  const conv = getConv(S.active);
  $('#input').placeholder = conv
    ? (conv.type === 'dm' ? `Message @${dmPartner(conv)}` : `Message ${conv.private ? 'private group ' : ''}#${conv.name}`)
    : 'Message…';
}

/* ------------------------------ invite links ------------------------------ */

function inviteLink(code) {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
}

/* Build a crisp, self-contained QR code SVG for a string (no network needed,
 * so it works in the offline PWA). Dark modules on white = reliably scannable. */
function qrSvg(text, cell = 6, margin = 2) {
  const QR = window.qrcode;
  if (typeof QR !== 'function') return '';
  try {
    const qr = QR(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dim = (n + margin * 2) * cell;
    let rects = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="Invite QR code"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#0b0d10">${rects}</g></svg>`;
  } catch { return ''; }
}

function showInviteModal(link) {
  $('#invite-link').value = link;
  const qrBox = $('#invite-qr');
  if (qrBox) qrBox.innerHTML = qrSvg(link) || '<p class="muted">QR code unavailable on this device.</p>';
  const shareBtn = $('#invite-share');
  if (shareBtn) {
    if (navigator.share) {
      shareBtn.classList.remove('hidden');
      shareBtn.onclick = () => { navigator.share({ title: 'Ghost Chat invite', text: 'Join my Ghost Chat group:', url: link }).catch(() => {}); };
    } else {
      shareBtn.classList.add('hidden');
    }
  }
  $('#invite-modal-backdrop').classList.remove('hidden');
}

/* Accept a full invite URL (?join=CODE / #join=CODE) or a bare code. */
function parseInviteCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/[?&#]join=([\w-]+)/i);
  if (m) return m[1];
  const bare = s.split('/').pop().trim(); // tolerate a pasted URL we don't recognise
  return /^[\w-]{4,32}$/.test(bare) ? bare : '';
}

function openJoinModal() {
  $('#join-code-input').value = '';
  $('#join-error').classList.add('hidden');
  $('#join-modal-backdrop').classList.remove('hidden');
  $('#join-code-input').focus();
}

function submitJoinCode() {
  const code = parseInviteCode($('#join-code-input').value);
  const err = $('#join-error');
  if (!code) {
    err.textContent = "That doesn't look like a valid invite link or code.";
    err.classList.remove('hidden');
    return;
  }
  err.classList.add('hidden');
  $('#join-modal-backdrop').classList.add('hidden');
  if (!send({ type: 'join_channel', code })) toast("You're offline — couldn't join. Try again.");
}

function parseJoinCode() {
  const q = new URLSearchParams(location.search).get('join');
  if (q) return q;
  const h = location.hash.match(/^#join=([\w-]+)/);
  return h ? h[1] : null;
}

/* ------------------------------ typing ------------------------------ */

function noteTyping() {
  const now = Date.now();
  if (now - S.typingThrottle > 2000) {
    S.typingThrottle = now;
    send({ type: 'typing', channel: S.active });
  }
  clearTimeout(S.typingStopTimer);
  S.typingStopTimer = setTimeout(() => send({ type: 'typing_stop', channel: S.active }), 2500);
}

function renderTyping() {
  const bar = $('#typing-bar');
  const map = S.typing[S.active] || new Map();
  const now = Date.now();
  const names = [...map.entries()].filter(([u, ts]) => u !== S.me.username && now - ts < TYPING_EXPIRE_MS).map(([u]) => u);
  bar.innerHTML = '';
  if (!names.length) return;
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  const label = document.createElement('span');
  label.textContent = names.length === 1
    ? `@${names[0]} is typing…`
    : names.length === 2
      ? `@${names[0]} and @${names[1]} are typing…`
      : 'Several people are typing…';
  bar.append(dots, label);
}
setInterval(renderTyping, 1000);

/* --------------------------- screenshot notice --------------------------- */

/* Best-effort screenshot detection.
 *
 * IMPORTANT: browsers do NOT expose an OS screenshot event, so a web page can
 * never truly know when a screenshot is taken (a native iOS/Android app can,
 * but the web cannot). The only usable signal is the DESKTOP screenshot
 * keyboard shortcut, which we report to the server; the server posts a notice
 * in the current chat. This will NOT catch mobile screenshots, mouse-driven
 * snipping tools, or OS shortcuts the browser never receives — it is a
 * deterrent, not a guarantee. */
let lastScreenshotAt = 0;
function reportScreenshot() {
  if (!S.active) return;
  const now = Date.now();
  if (now - lastScreenshotAt < 8000) return; // debounce held keys / spam
  lastScreenshotAt = now;
  if (send({ type: 'screenshot', channel: S.active })) {
    toast('📸 Screenshot detected — the chat was notified.');
  }
}
// Desktop keyboard-shortcut signal (web best-effort — see notes above).
function screenshotSignal(e) {
  const k = e.key || '';
  const isPrtScn = k === 'PrintScreen' || k.toLowerCase() === 'printscreen';
  const isMacShot = e.metaKey && e.shiftKey && ['3', '4', '5'].includes(k); // macOS ⌘⇧3/4/5
  if (isPrtScn || isMacShot) reportScreenshot();
}
// The native Android app (WebView) calls this when the OS detects a REAL
// screenshot (power+volume). It reuses the same in-chat notice as the desktop
// keyboard path. No-op everywhere else (nothing assigns it).
window.__ghostOnScreenshot = reportScreenshot;

/* ------------------------------ emoji picker ------------------------------ */

function buildPickerGrid(onPick) {
  const picker = $('#emoji-picker');
  picker.innerHTML = '';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.textContent = e;
    b.onclick = () => { closePicker(); onPick(e); };
    picker.appendChild(b);
  }
}

function openPicker(anchor, mode) {
  const picker = $('#emoji-picker');
  if (!picker.classList.contains('hidden') && S.picker.mode && S.picker.anchor === anchor) { closePicker(); return; }
  S.picker = { mode, anchor };
  buildPickerGrid(mode.mode === 'composer'
    ? (e) => { const input = $('#input'); input.value += e; input.focus(); }
    : (e) => send({ type: 'react', channelId: mode.convId, messageId: mode.messageId, emoji: e }));
  picker.classList.remove('hidden');
  if (window.innerWidth <= 560) {
    // phones: bottom sheet (CSS positions it), skip anchor math
    picker.classList.add('sheet');
    picker.style.top = '';
    picker.style.left = '';
    return;
  }
  picker.classList.remove('sheet');
  const r = anchor.getBoundingClientRect();
  const w = 250, h = picker.offsetHeight || 140;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  const left = Math.min(Math.max(8, r.left - w + r.width), window.innerWidth - w - 8);
  picker.style.top = top + 'px';
  picker.style.left = left + 'px';
}

function closePicker() {
  const p = $('#emoji-picker');
  p.classList.add('hidden');
  p.classList.remove('sheet');
  S.picker = { mode: null };
}

document.addEventListener('click', (e) => {
  const picker = $('#emoji-picker');
  if (picker.classList.contains('hidden')) return;
  if (picker.contains(e.target) || e.target.closest('.rx-add') || e.target.closest('.msg-actions button') || e.target === $('#emoji-btn')) return;
  closePicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePicker();
    ['#modal-backdrop', '#dm-modal-backdrop', '#report-modal-backdrop', '#invite-modal-backdrop', '#members-modal-backdrop', '#join-modal-backdrop']
      .forEach((sel) => $(sel).classList.add('hidden'));
  }
});

/* ------------------------------ composer ------------------------------ */

function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !S.active) return;
  if (!send({ type: 'message', channel: S.active, text })) {
    toast("You're offline — message not sent. It's still in the box.");
    return; // keep the draft so nothing is lost
  }
  input.value = '';
  input.style.height = 'auto';
  clearTimeout(S.typingStopTimer);
  send({ type: 'typing_stop', channel: S.active });
  input.focus();
}

/* ------------------------------ reports ------------------------------ */

function openReportModal(m) {
  S.report = { convId: m.channel, messageId: m.id, targetUser: m.username, preview: m.text.slice(0, 120) };
  const conv = getConv(m.channel);
  const target = $('#report-target');
  target.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = `@${m.username}`;
  target.append(b, document.createTextNode(` in ${conv ? convTitle(conv) : m.channel} — “${S.report.preview}”`));
  $('#report-reason').value = '';
  $('#report-modal-backdrop').classList.remove('hidden');
  $('#report-reason').focus();
}

/* ------------------------------ modals ------------------------------ */

function openModal() {
  $('#modal-backdrop').classList.remove('hidden');
  $('#new-channel-name').value = '';
  $('#new-channel-name').focus();
}
function createChannel() {
  const name = $('#new-channel-name').value.trim().toLowerCase();
  if (!name) return;
  const isPrivate = document.querySelector('input[name="group-privacy"]:checked').value === 'private';
  send({ type: 'create_channel', name, private: isPrivate });
  $('#modal-backdrop').classList.add('hidden');
}

function openDmModal() {
  const list = $('#dm-user-list');
  const search = $('#dm-search');

  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/^@/, '');
    list.innerHTML = '';
    const names = Object.keys(S.users)
      .filter((u) => u !== S.me.username && !(S.users[u] && S.users[u].bot))
      .filter((u) => !q || u.includes(q))
      .sort((a, b) => (S.online.has(b) - S.online.has(a)) || a.localeCompare(b)); // online first
    if (!names.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = q ? `No users matching "@${q}".` : 'No other users yet.';
      list.appendChild(p);
      return;
    }
    for (const name of names) {
      const btn = document.createElement('button');
      btn.className = 'dm-user';
      const av = document.createElement('span');
      av.className = 'dm-avatar';
      av.style.background = userColor(name);
      av.textContent = initials(name);
      const label = document.createElement('span');
      label.textContent = '@' + name;
      const dot = document.createElement('span');
      dot.className = 'dot status-dot' + (S.online.has(name) ? '' : ' offline');
      btn.append(av, label, dot);
      btn.onclick = () => {
        $('#dm-modal-backdrop').classList.add('hidden');
        const existing = S.dms.find((d) => d.members.includes(name));
        if (existing) switchConv(existing.id);
        else send({ type: 'dm_start', to: name });
      };
      list.appendChild(btn);
    }
  };

  search.value = '';
  search.oninput = draw;
  draw();
  $('#dm-modal-backdrop').classList.remove('hidden');
  search.focus();
}

/* ------------------------ group members / admin ------------------------ */

// Only private groups have admins; the creator is the owner (always an admin).
function isChannelAdmin(conv) {
  if (!conv || !conv.private) return false;
  if (S.me.owner) return true; // the global owner can moderate every group
  return Array.isArray(conv.admins) && conv.admins.includes(S.me.username);
}

function openMembersModal() {
  const conv = getConv(S.active);
  if (!conv || !conv.private) return;
  drawMembers();
  $('#members-modal-backdrop').classList.remove('hidden');
}

function drawMembers() {
  const conv = getConv(S.active);
  if (!conv || !conv.private) return;
  const admin = isChannelAdmin(conv);
  const list = $('#member-list');
  list.innerHTML = '';
  $('#members-subtitle').textContent = admin
    ? 'You are an admin — add or remove members and manage roles.'
    : `${conv.members.length} member${conv.members.length === 1 ? '' : 's'}`;

  const rank = (u) => (u === conv.createdBy ? 0 : (conv.admins && conv.admins.includes(u) ? 1 : 2));
  const names = [...conv.members].sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));

  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'member-row';
    const av = document.createElement('span');
    av.className = 'dm-avatar';
    av.style.background = userColor(name);
    av.textContent = initials(name);
    const label = document.createElement('span');
    label.className = 'member-name';
    label.textContent = '@' + name + (name === S.me.username ? ' (you)' : '');
    row.append(av, label);

    const isOwner = name === conv.createdBy || !!(S.users[name] && S.users[name].owner);
    const isAdmin = !isOwner && conv.admins && conv.admins.includes(name);
    if (isOwner || isAdmin) {
      const badge = document.createElement('span');
      badge.className = 'role-badge' + (isOwner ? ' owner' : '');
      badge.textContent = isOwner ? 'owner' : 'admin';
      row.appendChild(badge);
    }

    // Admin controls for every member except the owner (and except yourself).
    if (admin && !isOwner && name !== S.me.username) {
      const actions = document.createElement('span');
      actions.className = 'member-actions';
      const roleBtn = document.createElement('button');
      roleBtn.className = 'mini-btn';
      roleBtn.textContent = isAdmin ? 'Demote' : 'Make admin';
      roleBtn.onclick = () => send({ type: isAdmin ? 'demote_admin' : 'promote_admin', channelId: conv.id, username: name });
      const rmBtn = document.createElement('button');
      rmBtn.className = 'mini-btn danger';
      rmBtn.textContent = 'Remove';
      rmBtn.onclick = () => send({ type: 'remove_member', channelId: conv.id, username: name });
      actions.append(roleBtn, rmBtn);
      row.appendChild(actions);
    }
    list.appendChild(row);
  }

  // Add-member panel (admins only): pick any existing user not yet in the group.
  const wrap = $('#add-member-wrap');
  wrap.classList.toggle('hidden', !admin);
  if (admin) {
    const search = $('#add-member-search');
    const results = $('#add-member-results');
    const drawResults = () => {
      const q = search.value.trim().toLowerCase().replace(/^@/, '');
      results.innerHTML = '';
      const candidates = Object.keys(S.users)
        .filter((u) => !conv.members.includes(u) && !(S.users[u] && S.users[u].bot))
        .filter((u) => !q || u.includes(q))
        .sort((a, b) => (S.online.has(b) - S.online.has(a)) || a.localeCompare(b))
        .slice(0, 40);
      if (!candidates.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = q ? `No users matching "@${q}".` : 'Everyone you know is already a member.';
        results.appendChild(p);
        return;
      }
      for (const name of candidates) {
        const btn = document.createElement('button');
        btn.className = 'dm-user';
        const av = document.createElement('span');
        av.className = 'dm-avatar';
        av.style.background = userColor(name);
        av.textContent = initials(name);
        const label = document.createElement('span');
        label.textContent = '@' + name;
        const add = document.createElement('span');
        add.className = 'add-tag';
        add.textContent = '＋ Add';
        btn.append(av, label, add);
        btn.onclick = () => send({ type: 'add_member', channelId: conv.id, username: name });
        results.appendChild(btn);
      }
    };
    search.value = '';
    search.oninput = drawResults;
    drawResults();
  }
}

/* ------------------------------ auth screens ------------------------------ */

function renderSwatches(container, initial, onPick) {
  container.innerHTML = '';
  let selected = initial || COLORS[Math.floor(Math.random() * COLORS.length)];
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === selected ? ' selected' : '');
    b.style.background = c;
    b.onclick = () => {
      selected = c;
      container.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('selected', s === b));
      onPick(c);
    };
    container.appendChild(b);
  }
  return () => selected;
}

function hideAllScreens() {
  $('#login').classList.add('hidden');
  $('#username-setup').classList.add('hidden');
  $('#app').classList.add('hidden');
}

let pickedColor = COLORS[0];

function showLogin() {
  hideAllScreens();
  $('#login').classList.remove('hidden');
  const fbSection = $('#auth-firebase');
  const guestNote = $('#auth-guest-note');
  if (S.fb) {
    fbSection.classList.remove('hidden');
    if (S.fb.emulator) {
      guestNote.innerHTML = '';
      guestNote.append(document.createTextNode('🧪 Connected to the local Firebase Auth emulator (demo-ghost-chat). Accounts are temporary.'));
      guestNote.classList.remove('hidden');
    } else {
      guestNote.classList.add('hidden');
    }
  } else {
    fbSection.classList.add('hidden');
    guestNote.textContent = '';
    guestNote.append(
      document.createTextNode("Firebase isn't configured yet (see "),
      Object.assign(document.createElement('code'), { textContent: 'public/firebase-config.js' }),
      document.createTextNode('), so Ghost Chat is running in Guest mode — identities are per-browser.')
    );
    guestNote.classList.remove('hidden');
  }
}

function showUsernameSetup(error) {
  hideAllScreens();
  $('#username-setup').classList.remove('hidden');
  const err = $('#username-error');
  if (error) { err.textContent = error; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
  const ident = $('#username-identity');
  if (S.me.email || S.me.displayName) {
    ident.textContent = `Signed in as ${S.me.displayName || ''} ${S.me.email ? `<${S.me.email}>` : ''}`.trim();
    ident.classList.remove('hidden');
  } else ident.classList.add('hidden');
  $('#username-input').focus();
}

function afterAuth() {
  // identity established (firebase or guest) → username step or straight in
  const saved = ls.get('ghost.usernameFor.' + S.me.authId);
  const savedColor = ls.get('ghost.colorFor.' + S.me.authId);
  if (saved) {
    S.me.username = saved;
    S.me.color = savedColor || pickedColor;
    enterApp();
    return;
  }
  // Firebase-backed recovery: the chosen username was stamped onto the
  // Firebase profile (displayName) when it was picked. That lives in Firebase
  // Auth, so it survives server restarts AND follows the account to any
  // device. Adopt it when it's a valid handle (a raw Google display name like
  // "Jane Doe" won't match, so first-timers still see the setup screen).
  if (S.me.mode === 'firebase' && S.fb && S.fb.authMod) {
    try {
      const cur = S.fb.authMod.currentUser(S.fb.auth);
      const fbName = String((cur && cur.displayName) || '').toLowerCase().trim();
      if (/^[a-z0-9_]{3,20}$/.test(fbName)) {
        S.me.username = fbName;
        S.me.color = savedColor || pickedColor;
        ls.set('ghost.usernameFor.' + S.me.authId, fbName); // cache for next boot
        enterApp();
        return;
      }
    } catch {}
  }
  // Client-side recovery copy (survives logout): lets a returning user — guest
  // included — resume without the setup screen even if the server's ephemeral
  // memory was wiped. Re-cached as usernameFor so the next boot auto-resumes.
  const known = ls.get('ghost.knownName.' + S.me.authId);
  if (known) {
    S.me.username = known;
    S.me.color = savedColor || pickedColor;
    ls.set('ghost.usernameFor.' + S.me.authId, known);
    enterApp();
    return;
  }
  if (savedColor) {
    // Returning on this device (the color survived a logout) but no cached
    // name: enter the app and let the server resolve the username bound to
    // this authId — no username-setup flash. If the server has lost the
    // record it replies need_username and we show the setup from there.
    S.me.username = null;
    S.me.color = savedColor;
    enterApp();
  } else {
    // Brand-new identity (no name AND no color stored): go straight to the
    // username setup. A fresh guest is per-browser and a first-time Firebase
    // signup has nothing for the server to resolve yet, so there is nothing
    // to wait for — and this avoids flashing the empty app shell first.
    S.me.username = null;
    showUsernameSetup('');
  }
}

function submitUsername() {
  const name = $('#username-input').value.trim().toLowerCase();
  if (!name) return;
  S.me.username = name;
  S.me.color = pickedColor;
  ls.set('ghost.usernameFor.' + S.me.authId, name);
  ls.set('ghost.colorFor.' + S.me.authId, pickedColor);
  // also stamp the chosen name onto the Firebase account (displayName), so it
  // survives across devices even if the server's memory was wiped. Best
  // effort — authId binding on the server is the primary mechanism.
  if (S.fb && S.fb.authMod) {
    try {
      const cur = S.fb.authMod.currentUser(S.fb.auth);
      if (cur) S.fb.authMod.updateProfile(cur, { displayName: name }).catch(() => {});
    } catch {}
  }
  enterApp();
}

/* ------------------------------ offline preview ------------------------------
 * The last conversations are mirrored into localStorage so the app can show
 * previously seen content with no connection (Play Store reviewers + planes).
 * Live data always wins: the first `init` after reconnecting replaces it. */

const OFFLINE_KEY = 'ghost.offlineCache.v1';
const OFFLINE_PER_CONV = 60;

function saveOfflineCache() {
  try {
    const convs = {};
    for (const conv of [...S.channels, ...S.dms]) {
      convs[conv.id] = (conv.messages || []).slice(-OFFLINE_PER_CONV);
    }
    ls.set(OFFLINE_KEY, JSON.stringify({
      channels: S.channels, dms: S.dms, users: S.users,
      serverNow: S.serverNow, convs, savedAt: Date.now(),
    }));
  } catch {} // storage full / unavailable — offline preview is best-effort
}

let cacheSaveTimer = null;
function queueCacheSave() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(saveOfflineCache, 600);
}

function loadOfflineCache() {
  let cache = null;
  try { cache = JSON.parse(ls.get(OFFLINE_KEY) || 'null'); } catch {}
  if (!cache || !Array.isArray(cache.channels)) return false;
  if (!cache.channels.length && !(cache.dms || []).length) return false;
  S.channels = cache.channels;
  S.dms = cache.dms || [];
  S.users = cache.users || {};
  S.online = new Set();               // nobody is "online" while offline
  S.serverNow = cache.serverNow || Date.now();
  for (const conv of [...S.channels, ...S.dms]) {
    conv.messages = (cache.convs && cache.convs[conv.id]) || [];
    if (!S.typing[conv.id]) S.typing[conv.id] = new Map();
  }
  if (!S.active || !getConv(S.active)) {
    S.active = (S.channels[0] || S.dms[0] || {}).id || null;
  }
  renderAll();
  scrollBottom(true);
  return true;
}

function enterApp() {
  // Persistent login: stamp a durable session marker every time we enter the
  // app. It is cleared ONLY by the manual Sign-out button, so a page refresh
  // (or browser reopen) resumes straight into the chat instead of the login
  // screen — no flash, no waiting on the Firebase SDK.
  if (S.me && S.me.authId) {
    ls.set('ghost.session', JSON.stringify({
      authId: S.me.authId,
      mode: S.me.mode,
      email: S.me.email || '',
      displayName: S.me.displayName || '',
    }));
  }
  hideAllScreens();
  $('#app').classList.remove('hidden');
  renderMe();
  S.pendingJoinCode = parseJoinCode();
  if (S.pendingJoinCode) {
    try { history.replaceState(null, '', location.pathname); } catch {}
  }
  loadOfflineCache(); // show saved conversations until the socket delivers live data
  connect();
  maybeAskNotifPermission();
}

/* Ask for notification permission once, right after entering the app (the
 * click that got us here counts as the user gesture browsers require).
 * Without this, notifications stay dead until someone finds the 🔔 button. */
function maybeAskNotifPermission() {
  if (!notifSupported() || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') {
    // previously decided — respect it (boot() already synced notifEnabled)
    if (Notification.permission === 'granted' && ls.get('ghost.notif') !== '0') {
      notifEnabled = true;
      updateNotifBtn();
    }
    return;
  }
  if (ls.get('ghost.notifAsked') === '1') return;
  ls.set('ghost.notifAsked', '1');
  try {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') {
        notifEnabled = true;
        ls.set('ghost.notif', '1');
        updateNotifBtn();
        toast('🔔 Notifications enabled');
      }
    }).catch(() => {});
  } catch {}
}

function renderMe() {
  if (!S.me) return;
  const card = $('#me-card');
  card.innerHTML = '';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.style.background = S.me.color;
  av.style.width = '32px'; av.style.height = '32px'; av.style.fontSize = '13px'; av.style.marginTop = '0';
  av.textContent = S.me.username ? initials(S.me.username) : '…';
  const info = document.createElement('div');
  info.className = 'me-info';
  const name = document.createElement('div');
  name.className = 'me-name';
  name.textContent = (S.me.username ? '@' + S.me.username : '…') + (S.me.mode === 'guest' ? ' (guest)' : '');
  const status = document.createElement('div');
  status.className = 'me-status offline'; status.id = 'me-status'; status.textContent = 'connecting…';
  info.append(name, status);
  const notif = document.createElement('button');
  notif.className = 'icon-btn';
  notif.id = 'notif-btn';
  notif.onclick = toggleNotifications;
  const out = document.createElement('button');
  out.className = 'icon-btn';
  out.title = 'Sign out';
  out.textContent = '⏻';
  out.onclick = async () => {
    if (nativeAuth) { try { window.AndroidBridge.googleSignOut(); } catch {} nativeAuth = false; }
    if (S.fb) { try { await S.fb.authMod.signOut(S.fb.auth); } catch {} }
    // keep the per-browser guest identity + colors so the name can be
    // recovered (server resolves the username from the authId); drop the rest
    const keep = /^ghost\.(guestId|colorFor\.)/;
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('ghost.') && !keep.test(k))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
    try { Object.keys(mem).filter((k) => !keep.test(k)).forEach((k) => { delete mem[k]; }); } catch {}
    // Keep a recovery copy of the chosen name so logging back in never re-asks
    // for it — works for guests even when the server's memory was wiped. Set
    // after the wipe so it isn't cleared; afterAuth adopts it on next login.
    if (S.me && S.me.username && S.me.authId) {
      ls.set('ghost.knownName.' + S.me.authId, S.me.username);
    }
    location.reload();
  };
  card.append(av, info, notif, out);
  updateNotifBtn();
}

/* ------------------------------ firebase UI ------------------------------ */

function wireFirebaseUi() {
  let mode = 'signin';
  const submit = $('#auth-submit');
  const setMode = (m) => {
    mode = m;
    $('#tab-signin').classList.toggle('active', m === 'signin');
    $('#tab-signup').classList.toggle('active', m === 'signup');
    submit.textContent = m === 'signin' ? 'Sign in' : 'Create account';
    $('#auth-error').classList.add('hidden');
  };
  $('#tab-signin').onclick = () => setMode('signin');
  $('#tab-signup').onclick = () => setMode('signup');

  const fail = (e) => {
    const el = $('#auth-error');
    if (e && e.code === 'auth/popup-closed-by-user') return;
    const friendly = {
      'auth/unauthorized-domain': 'Google sign-in is not enabled for this site yet. Add "' + location.hostname + '" under Firebase Console → Authentication → Settings → Authorized domains.',
      'auth/popup-blocked': 'Your browser blocked the sign-in popup — allow popups for this site and try again.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/wrong-password': 'Incorrect email or password.',
      'auth/user-not-found': 'No account found for that email — try the Sign up tab.',
      'auth/email-already-in-use': 'That email already has an account — use the Sign in tab.',
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/invalid-email': 'That email address does not look valid.',
      'auth/network-request-failed': 'Network error — check your connection and try again.',
    };
    el.textContent = (e && friendly[e.code])
      || ((e && e.message) ? e.message.replace('Firebase: ', '') : 'Sign-in failed');
    el.classList.remove('hidden');
  };
  const success = (cred) => {
    const u = cred.user;
    S.me = {
      authId: u.uid, email: u.email || '', displayName: u.displayName || '',
      mode: 'firebase', username: null, color: pickedColor,
    };
    // Stamp the persistent session the instant Firebase login succeeds — even
    // before the username is chosen — so a refresh at ANY point after sign-in
    // resumes (to the app, or to username-setup) instead of the login screen.
    ls.set('ghost.session', JSON.stringify({
      authId: u.uid, mode: 'firebase', email: u.email || '', displayName: u.displayName || '',
    }));
    afterAuth();
  };

  submit.onclick = async () => {
    const email = $('#auth-email').value.trim();
    const pass = $('#auth-password').value;
    if (!email || !pass) { fail({ message: 'Enter email and password.' }); return; }
    try {
      const cred = mode === 'signin'
        ? await S.fb.authMod.signInWithEmailAndPassword(S.fb.auth, email, pass)
        : await S.fb.authMod.createUserWithEmailAndPassword(S.fb.auth, email, pass);
      success(cred);
    } catch (e) { fail(e); }
  };
  $('#auth-password').onkeydown = (e) => { if (e.key === 'Enter') submit.onclick(); };

  $('#auth-google').onclick = async () => {
    if (isNativeApp()) { nativeGoogleSignIn(); return; } // APK: native flow
    if (S.fb.emulator) {
      const el = $('#auth-error');
      el.textContent = 'Google sign-in is not available in emulator mode — use email/password.';
      el.classList.remove('hidden');
      return;
    }
    try {
      const provider = new S.fb.authMod.GoogleAuthProvider();
      const cred = await S.fb.authMod.signInWithPopup(S.fb.auth, provider);
      success(cred);
    } catch (e) { fail(e); }
  };
}

function guestId() {
  let id = ls.get('ghost.guestId');
  if (!id) {
    id = 'guest-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    ls.set('ghost.guestId', id);
  }
  return id;
}

/* ------------------------------ mobile UX wiring ------------------------------ */

function openNav() { document.body.classList.add('nav-open'); }
function closeNav() { document.body.classList.remove('nav-open'); }

function wireMobileUx() {
  $('#menu-btn').onclick = openNav;
  $('#nav-backdrop').onclick = closeNav;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  window.addEventListener('resize', () => { if (window.innerWidth > 720) closeNav(); });

  /* jump-to-latest FAB (appears when scrolled up) */
  const box = $('#messages');
  const fab = $('#scroll-bottom');
  box.addEventListener('scroll', () => {
    const away = box.scrollHeight - box.scrollTop - box.clientHeight;
    fab.classList.toggle('hidden', away < 160);
  }, { passive: true });
  fab.onclick = () => {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    fab.classList.add('hidden');
  };

  /* touch devices have no hover: long-press a message for its actions */
  let pressTimer = null;
  box.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.msg');
    if (!row || row.classList.contains('system')) return;
    pressTimer = setTimeout(() => {
      box.querySelectorAll('.actions-open').forEach((n) => n.classList.remove('actions-open'));
      row.classList.add('actions-open');
    }, 420);
  }, { passive: true });
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  box.addEventListener('touchmove', cancelPress, { passive: true });
  box.addEventListener('touchend', (e) => {
    cancelPress();
    if (!e.target.closest('.msg-actions')) {
      box.querySelectorAll('.actions-open').forEach((n) => n.classList.remove('actions-open'));
    }
  }, { passive: true });
}

/* ------------------------------ boot ------------------------------ */

async function boot() {
  wireMobileUx();
  // best-effort screenshot notices (desktop shortcut keys only — see notes above)
  document.addEventListener('keydown', screenshotSignal);

  /* service worker: app-shell cache + notification plumbing (PWA/TWA) */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed:', e));
  }
  if (typeof Notification !== 'undefined') {
    if (Notification.permission !== 'granted') {
      notifEnabled = false; // stale pref without permission
    } else if (ls.get('ghost.notif') !== '0') {
      notifEnabled = true; // permission granted and not explicitly muted
      ls.set('ghost.notif', '1');
    }
  } else if (notifSupported()) {
    // Android/TWA without the Notification constructor: notifications are
    // delegated to the OS by the launcher, so respect the stored pref.
    notifEnabled = ls.get('ghost.notif') === '1';
  }

  /* shared wiring */
  $('#send-btn').onclick = sendMessage;
  $('#emoji-btn').onclick = (e) => openPicker(e.currentTarget, { mode: 'composer' });
  $('#add-channel').onclick = openModal;
  $('#modal-cancel').onclick = () => $('#modal-backdrop').classList.add('hidden');
  $('#modal-create').onclick = createChannel;
  $('#new-channel-name').onkeydown = (e) => { if (e.key === 'Enter') createChannel(); };
  $('#modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); };

  $('#new-dm').onclick = openDmModal;
  $('#dm-modal-cancel').onclick = () => $('#dm-modal-backdrop').classList.add('hidden');

  $('#report-cancel').onclick = () => $('#report-modal-backdrop').classList.add('hidden');
  $('#report-submit').onclick = () => {
    const reason = $('#report-reason').value.trim();
    if (!reason || !S.report) return;
    send({ type: 'report', convId: S.report.convId, messageId: S.report.messageId, reason });
    $('#report-modal-backdrop').classList.add('hidden');
  };

  $('#invite-btn').onclick = () => {
    const conv = getConv(S.active);
    if (conv && conv.inviteCode) showInviteModal(inviteLink(conv.inviteCode));
  };
  $('#invite-close').onclick = () => $('#invite-modal-backdrop').classList.add('hidden');
  $('#members-btn').onclick = openMembersModal;
  $('#members-close').onclick = () => $('#members-modal-backdrop').classList.add('hidden');
  $('#members-modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); };
  $('#invite-copy').onclick = async () => {
    const ok = await copyText($('#invite-link').value);
    $('#invite-copy').textContent = ok ? 'Copied!' : 'Select all + copy';
    setTimeout(() => { $('#invite-copy').textContent = 'Copy'; }, 1500);
  };
  $('#invite-modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); };

  $('#join-group').onclick = openJoinModal;
  $('#join-cancel').onclick = () => $('#join-modal-backdrop').classList.add('hidden');
  $('#join-submit').onclick = submitJoinCode;
  $('#join-code-input').onkeydown = (e) => { if (e.key === 'Enter') submitJoinCode(); };
  $('#join-modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); };

  const input = $('#input');
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    if (input.value.trim() && S.active) noteTyping();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const getSwatch = renderSwatches($('#login-colors'), null, (c) => { pickedColor = c; });
  void getSwatch;
  $('#username-submit').onclick = submitUsername;
  $('#username-input').onkeydown = (e) => { if (e.key === 'Enter') submitUsername(); };

  $('#guest-btn').onclick = () => {
    S.me = { authId: guestId(), email: '', displayName: '', mode: 'guest', username: null, color: pickedColor };
    afterAuth();
  };

  /* Google button (early wiring): inside the APK the native flow handles it
   * even before/without the Firebase JS SDK; wireFirebaseUi re-wires the same
   * native branch plus the browser popup path once the SDK arrives. */
  $('#auth-google').onclick = () => {
    if (isNativeApp()) { nativeGoogleSignIn(); return; }
    const el = $('#auth-error');
    el.textContent = 'Sign-in is still loading — try again in a moment.';
    el.classList.remove('hidden');
  };

  /* Persistent login: a durable session marker is stamped every time the user
   * enters the app and cleared ONLY by the manual Sign-out button. If it is
   * present, resume straight into the chat - a refresh must never bounce the
   * user back to the login screen or make them wait for the Firebase SDK. */
  if (parseJoinCode()) $('#invite-banner').classList.remove('hidden');
  let resumed = false;

  /* APK: a native Firebase session (Google sign-in) is the source of truth —
   * resume straight into it so the server can VERIFY the identity on join
   * (the bridge supplies the ID token in connect()). */
  if (isNativeApp()) {
    let hasNative = false;
    try { hasNative = !!window.AndroidBridge.hasFirebaseSession(); } catch {}
    if (hasNative) {
      let nu = null;
      try { nu = JSON.parse(window.AndroidBridge.getFirebaseUser() || 'null'); } catch {}
      if (nu && nu.uid) {
        nativeAuth = true;
        S.me = {
          authId: nu.uid, email: nu.email || '', displayName: nu.displayName || '',
          mode: 'firebase', username: null,
          color: ls.get('ghost.colorFor.' + nu.uid) || pickedColor,
        };
        ls.set('ghost.session', JSON.stringify({
          authId: nu.uid, mode: 'firebase', email: nu.email || '', displayName: nu.displayName || '',
        }));
        resumed = true;
        afterAuth();
      }
    }
  }

  const sessionRaw = ls.get('ghost.session');
  if (!resumed && sessionRaw) {
    let sess = null;
    try { sess = JSON.parse(sessionRaw); } catch {}
    if (sess && sess.authId) {
      S.me = {
        authId: sess.authId, email: sess.email || '', displayName: sess.displayName || '',
        mode: sess.mode || 'guest', username: null,
        color: ls.get('ghost.colorFor.' + sess.authId) || pickedColor,
      };
      resumed = true;
      afterAuth(); // known username -> enter app immediately; server confirms
    }
  }

  /* Fallback for sessions that predate the marker: resume from the stored
   * guest identity, else show the login screen IMMEDIATELY (guest mode) -
   * never block first paint on a CDN import. When the Firebase SDK arrives,
   * the sign-in form appears; if it never arrives (blocked/slow network),
   * guest mode keeps working. Returning guests skip the login screen
   * entirely - invite links then drop them straight into the group. */
  if (!resumed) {
    const savedGuestId = ls.get('ghost.guestId');
    const savedGuestName = savedGuestId && ls.get('ghost.usernameFor.' + savedGuestId);
    if (savedGuestName) {
      S.me = {
        authId: savedGuestId, email: '', displayName: '', mode: 'guest', username: null,
        color: ls.get('ghost.colorFor.' + savedGuestId) || pickedColor,
      };
      afterAuth();
    } else {
      showLogin();
    }
  }
  loadFirebase().then((fb) => {
    if (!fb) return;
    S.fb = fb; // keep the handle: the Sign-out button uses it
    if (S.me) return; // already resumed from the persistent session - done
    wireFirebaseUi();
    const fbSection = $('#auth-firebase');
    const guestNote = $('#auth-guest-note');
    fbSection.classList.remove('hidden');
    if (fb.emulator) {
      guestNote.innerHTML = '';
      guestNote.append(document.createTextNode('\u{1F512} Connected to the local Firebase Auth emulator (demo-ghost-chat). Accounts are temporary.'));
    } else {
      guestNote.classList.add('hidden');
    }
    const cur = fb.authMod.currentUser(fb.auth);
    if (cur) {
      S.me = {
        authId: cur.uid, email: cur.email || '', displayName: cur.displayName || '',
        mode: 'firebase', username: null, color: pickedColor,
      };
      pickedColor = ls.get('ghost.colorFor.' + S.me.authId) || pickedColor;
      renderSwatches($('#login-colors'), pickedColor, (c) => { pickedColor = c; });
      afterAuth();
    }
  }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
})();
