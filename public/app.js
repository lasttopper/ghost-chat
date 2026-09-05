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
  if (!notifEnabled || !notifSupported()) return;
  // Desktop (Notification constructor present) needs explicit permission.
  // Android/TWA has no constructor and relies on SW notifications delegated
  // to the OS, so only block when the constructor exists AND isn't granted.
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;
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
  S.ws = new WebSocket(wsUrl());
  S.ws.onopen = () => {
    S.reconnectDelay = 1000;
    $('#reconnect-banner').classList.add('hidden');
    send({
      type: 'join', username: S.me.username, authId: S.me.authId,
      email: S.me.email, displayName: S.me.displayName, color: S.me.color,
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
    case 'presence': onPresence(msg.online); break;
    case 'typing': onTyping(msg, false); break;
    case 'typing_stop': onTyping(msg, true); break;
    case 'channel_created': {
      S.channels.push(msg.channel);
      S.typing[msg.channel.id] = new Map();
      lastRead[msg.channel.id] = S.serverNow; saveLastRead();
      renderSidebar();
      if (msg.channel.private) {
        switchConv(msg.channel.id);
        showInviteModal(inviteLink(msg.channel.inviteCode));
      } else {
        toast(`New group #${msg.channel.name}`);
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
    case 'need_username': showUsernameSetup(''); break;
    case 'username_taken': showUsernameSetup(`@${msg.username} belongs to another account. Pick a different one.`); break;
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
  if (S.prevOnline) {
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
  const allNames = Object.keys(S.users).filter((u) => u !== 'GhostBot');
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
}

function renderHeader() {
  const conv = getConv(S.active);
  const icon = $('#ch-kind-icon');
  const name = $('#ch-name');
  const topic = $('#ch-topic');
  const invite = $('#invite-btn');
  if (!conv) { icon.textContent = '#'; name.textContent = ''; topic.textContent = ''; invite.classList.add('hidden'); return; }
  if (conv.type === 'dm') {
    const partner = dmPartner(conv);
    icon.textContent = '@';
    name.textContent = partner;
    topic.textContent = S.online.has(partner) ? '🟢 online' : 'offline';
    invite.classList.add('hidden');
  } else {
    icon.textContent = conv.private ? '🔒' : '#';
    name.textContent = conv.name;
    topic.textContent = conv.private
      ? `Private group · ${conv.members.length} member${conv.members.length === 1 ? '' : 's'}`
      : (conv.topic || '');
    invite.classList.toggle('hidden', !conv.private);
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
    head.append(author, time);
    body.appendChild(head);
  }
  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = m.text;
  body.appendChild(text);
  body.appendChild(buildReactions(m));

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

function showInviteModal(link) {
  $('#invite-link').value = link;
  $('#invite-modal-backdrop').classList.remove('hidden');
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
    ['#modal-backdrop', '#dm-modal-backdrop', '#report-modal-backdrop', '#invite-modal-backdrop']
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
      .filter((u) => u !== S.me.username && u !== 'GhostBot')
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
  if (saved) {
    S.me.username = saved;
    S.me.color = ls.get('ghost.colorFor.' + S.me.authId) || pickedColor;
    enterApp();
  } else {
    // No local memory of the name (fresh device or after logout): let the
    // server resolve the username bound to this authId. If it has never
    // seen this identity it answers 'need_username' and we show the setup.
    S.me.username = null;
    enterApp();
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
  $('#invite-copy').onclick = async () => {
    const ok = await copyText($('#invite-link').value);
    $('#invite-copy').textContent = ok ? 'Copied!' : 'Select all + copy';
    setTimeout(() => { $('#invite-copy').textContent = 'Copy'; }, 1500);
  };

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

  /* Show the login screen IMMEDIATELY (guest mode) — never block first paint
   * on a CDN import. When the Firebase SDK arrives, the sign-in form appears;
   * if it never arrives (blocked/slow network), guest mode keeps working.
   * Returning guests skip the login screen entirely — invite links then drop
   * them straight into the group. */
  const savedGuestId = ls.get('ghost.guestId');
  const savedGuestName = savedGuestId && ls.get('ghost.usernameFor.' + savedGuestId);
  if (parseJoinCode()) $('#invite-banner').classList.remove('hidden');
  if (savedGuestName) {
    S.me = {
      authId: savedGuestId, email: '', displayName: '', mode: 'guest', username: null,
      color: ls.get('ghost.colorFor.' + savedGuestId) || pickedColor,
    };
    afterAuth();
  } else {
    showLogin();
  }
  loadFirebase().then((fb) => {
    if (!fb || S.me) return;
    S.fb = fb;
    wireFirebaseUi();
    const fbSection = $('#auth-firebase');
    const guestNote = $('#auth-guest-note');
    fbSection.classList.remove('hidden');
    if (fb.emulator) {
      guestNote.innerHTML = '';
      guestNote.append(document.createTextNode('🧪 Connected to the local Firebase Auth emulator (demo-ghost-chat). Accounts are temporary.'));
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
