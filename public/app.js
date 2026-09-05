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
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3600);
  setTimeout(() => el.remove(), 4100);
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

/* ------------------------------ firebase ------------------------------ */

async function loadFirebase() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || /YOUR_/.test(cfg.apiKey)) return null;
  try {
    const [appMod, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
    ]);
    const app = appMod.initializeApp(cfg);
    return { auth: authMod.getAuth(app), authMod };
  } catch (e) {
    console.warn('Firebase unavailable, guest mode only:', e);
    return null;
  }
}

/* ------------------------------ websocket ------------------------------ */

function wsUrl() {
  const path = /\.vercel\.app$/i.test(location.hostname) ? '/api/ws' : '/ws';
  return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + path;
}

function connect() {
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
    $('#reconnect-banner').classList.remove('hidden');
    const st = $('#me-status');
    if (st) { st.textContent = 'reconnecting…'; st.classList.add('offline'); }
    setTimeout(connect, S.reconnectDelay);
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 10000);
  };
}

const send = (obj) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); };

function route(msg) {
  switch (msg.type) {
    case 'init': {
      S.channels = msg.channels || [];
      S.dms = msg.dms || [];
      S.users = msg.users || {};
      S.online = new Set(msg.online || []);
      S.serverNow = msg.now;
      S.me.username = msg.username;
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

  /* People */
  const team = $('#team-list');
  team.innerHTML = '';
  const names = Object.keys(S.users).filter((u) => u !== 'GhostBot').sort((a, b) => {
    const ao = S.online.has(a) ? 0 : 1, bo = S.online.has(b) ? 0 : 1;
    return ao - bo || a.localeCompare(b);
  });
  for (const name of names) {
    const on = S.online.has(name);
    const row = document.createElement('div');
    row.className = 'team-item' + (on ? '' : ' offline-name');
    const dot = document.createElement('span'); dot.className = 'dot' + (on ? '' : ' offline');
    const label = document.createElement('span'); label.textContent = '@' + name;
    row.append(dot, label);
    if (name === S.me.username) {
      const you = document.createElement('span'); you.className = 'you'; you.textContent = '(you)';
      row.appendChild(you);
    }
    team.appendChild(row);
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
    box.appendChild(m.system ? buildSystem(m) : buildMsg(m, grouped));
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

function buildMsg(m, grouped) {
  const row = document.createElement('div');
  row.className = 'msg' + (grouped ? ' grouped' : '');
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
  if (S.active === id) return;
  S.active = id;
  const conv = getConv(id);
  if (conv && conv.messages.length) lastRead[id] = conv.messages[conv.messages.length - 1].ts;
  else lastRead[id] = S.serverNow;
  saveLastRead();
  renderAll();
  scrollBottom(true);
  updatePlaceholder();
  $('#input').focus();
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
  const r = anchor.getBoundingClientRect();
  const w = 250, h = picker.offsetHeight || 140;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  const left = Math.min(Math.max(8, r.left - w + r.width), window.innerWidth - w - 8);
  picker.style.top = top + 'px';
  picker.style.left = left + 'px';
}

function closePicker() {
  $('#emoji-picker').classList.add('hidden');
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
  send({ type: 'message', channel: S.active, text });
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
  list.innerHTML = '';
  const names = Object.keys(S.users).filter((u) => u !== S.me.username && u !== 'GhostBot').sort();
  if (!names.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No other users yet.';
    list.appendChild(p);
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
  $('#dm-modal-backdrop').classList.remove('hidden');
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
    guestNote.classList.add('hidden');
  } else {
    fbSection.classList.add('hidden');
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
  enterApp();
}

function enterApp() {
  hideAllScreens();
  $('#app').classList.remove('hidden');
  renderMe();
  S.pendingJoinCode = parseJoinCode();
  if (S.pendingJoinCode) {
    try { history.replaceState(null, '', location.pathname); } catch {}
  }
  connect();
}

function renderMe() {
  const card = $('#me-card');
  card.innerHTML = '';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.style.background = S.me.color;
  av.style.width = '32px'; av.style.height = '32px'; av.style.fontSize = '13px'; av.style.marginTop = '0';
  av.textContent = initials(S.me.username);
  const info = document.createElement('div');
  info.className = 'me-info';
  const name = document.createElement('div');
  name.className = 'me-name';
  name.textContent = '@' + S.me.username + (S.me.mode === 'guest' ? ' (guest)' : '');
  const status = document.createElement('div');
  status.className = 'me-status offline'; status.id = 'me-status'; status.textContent = 'connecting…';
  info.append(name, status);
  const out = document.createElement('button');
  out.className = 'icon-btn';
  out.title = 'Sign out';
  out.textContent = '⏻';
  out.onclick = async () => {
    if (S.fb) { try { await S.fb.authMod.signOut(S.fb.auth); } catch {} }
    for (const k of Object.keys(mem)) ls.del(k);
    try { Object.keys(localStorage).filter((k) => k.startsWith('ghost.')).forEach((k) => localStorage.removeItem(k)); } catch {}
    location.reload();
  };
  card.append(av, info, out);
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
    el.textContent = (e && e.message) ? e.message.replace('Firebase: ', '') : 'Sign-in failed';
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

/* ------------------------------ boot ------------------------------ */

async function boot() {
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

  /* identity: firebase if configured, else guest */
  S.fb = await loadFirebase();
  if (S.fb) wireFirebaseUi();

  $('#guest-btn').onclick = () => {
    S.me = { authId: guestId(), email: '', displayName: '', mode: 'guest', username: null, color: pickedColor };
    afterAuth();
  };

  /* returning user with an active firebase session? skip login */
  if (S.fb) {
    const cur = S.fb.authMod.currentUser(S.fb.auth);
    if (cur) {
      S.me = {
        authId: cur.uid, email: cur.email || '', displayName: cur.displayName || '',
        mode: 'firebase', username: null, color: pickedColor,
      };
      pickedColor = ls.get('ghost.colorFor.' + S.me.authId) || pickedColor;
      renderSwatches($('#login-colors'), pickedColor, (c) => { pickedColor = c; });
      afterAuth();
      return;
    }
  }
  showLogin();
}

document.addEventListener('DOMContentLoaded', boot);
})();
