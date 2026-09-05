/* Pulse — frontend */
(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'];
const EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '✅', '🙌', '😍', '🤔', '👏', '💯', '🚀', '😮', '😢', '🥳', '💪', '🙏', '👌', '😅', '🤝', '⭐', '☕', '🍕'];
const TYPING_EXPIRE_MS = 4500;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/* localStorage can throw inside sandboxed iframes (opaque origin) — fall back to memory */
const mem = {};
const ls = {
  get(k) { try { const v = localStorage.getItem(k); return v === null ? (mem[k] ?? null) : v; } catch { return mem[k] ?? null; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch {} },
  del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch {} },
};

const S = {
  ws: null,
  me: null,                     // { username, color }
  channels: [],                 // server state
  users: {},                    // username -> { color }
  online: new Set(),
  prevOnline: null,             // for presence toasts
  active: null,                 // active channel id
  typing: {},                   // channelId -> Map(username -> ts)
  serverNow: Date.now(),
  reconnectDelay: 1000,
  typingThrottle: 0,
  typingStopTimer: null,
  picker: { mode: null },       // 'composer' | { channelId, messageId }
};

let lastRead = {};
try { lastRead = JSON.parse(ls.get('pulse.lastRead') || '{}'); } catch {}
const saveLastRead = () => ls.set('pulse.lastRead', JSON.stringify(lastRead));

/* ------------------------------ helpers ------------------------------ */

const esc = (s) => String(s); // all user content is set via textContent
const getChannel = (id) => S.channels.find((c) => c.id === id);
const userColor = (u) => (S.users[u] && S.users[u].color) || '#6366f1';
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

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

/* ------------------------------ websocket ------------------------------ */

function wsUrl() {
  // On Vercel the function is mounted at /api/ws; standalone serves /ws.
  const path = /\.vercel\.app$/i.test(location.hostname) ? '/api/ws' : '/ws';
  return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + path;
}

function connect() {
  S.ws = new WebSocket(wsUrl());
  S.ws.onopen = () => {
    S.reconnectDelay = 1000;
    $('#reconnect-banner').classList.add('hidden');
    send({ type: 'join', username: S.me.username, color: S.me.color });
  };
  S.ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    route(msg);
  };
  S.ws.onclose = () => {
    $('#reconnect-banner').classList.remove('hidden');
    $('#me-status').textContent = 'reconnecting…';
    $('#me-status').classList.add('offline');
    setTimeout(connect, S.reconnectDelay);
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 10000);
  };
}

const send = (obj) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); };

function route(msg) {
  switch (msg.type) {
    case 'init': {
      S.channels = msg.channels;
      S.users = msg.users;
      S.online = new Set(msg.online);
      S.serverNow = msg.now;
      for (const c of S.channels) {
        if (!(c.id in lastRead)) lastRead[c.id] = S.serverNow;
        if (!S.typing[c.id]) S.typing[c.id] = new Map();
      }
      saveLastRead();
      if (!S.active || !getChannel(S.active)) S.active = (getChannel('general') || S.channels[0] || {}).id || null;
      if (!S.prevOnline) S.prevOnline = new Set(S.online); // no toasts on first connect
      renderAll();
      $('#me-status').textContent = 'online';
      $('#me-status').classList.remove('offline');
      scrollBottom(true);
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
      toast(`New channel #${msg.channel.name}`);
      break;
    }
    case 'error': toast(msg.message); break;
  }
}

function onMessage(m) {
  const ch = getChannel(m.channel);
  if (!ch) return;
  ch.messages.push(m);
  if (m.channel === S.active) {
    lastRead[m.channel] = m.ts; saveLastRead();
    renderMessages();
    if (m.username === S.me.username) scrollBottom(true);
    else scrollBottom(false); // only follows if already near bottom
    renderTyping();
  }
  renderSidebar(); // unread badges may change
}

function onReactions({ channelId, messageId, reactions }) {
  const ch = getChannel(channelId);
  const m = ch && ch.messages.find((x) => x.id === messageId);
  if (!m) return;
  m.reactions = reactions;
  if (channelId === S.active) {
    const el = document.querySelector(`[data-msg-id="${messageId}"] .reactions`);
    if (el) { el.replaceWith(buildReactions(m)); }
  }
}

function onPresence(online) {
  S.online = new Set(online);
  if (S.prevOnline) {
    for (const u of S.online) if (!S.prevOnline.has(u) && u !== S.me.username) toast(`${u} came online`);
    for (const u of S.prevOnline) if (!S.online.has(u) && u !== S.me.username) toast(`${u} went offline`, 'leave');
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
  $('#input').placeholder = S.active ? `Message #${S.active}` : 'Message…';
}

function unreadCount(ch) {
  const since = lastRead[ch.id] || 0;
  return ch.messages.filter((m) => !m.system && m.ts > since).length;
}

function renderSidebar() {
  $('#online-count').textContent = `${S.online.size} member${S.online.size === 1 ? '' : 's'} online`;

  const list = $('#channel-list');
  list.innerHTML = '';
  for (const ch of S.channels) {
    const n = unreadCount(ch);
    const btn = document.createElement('button');
    btn.className = 'ch-item' + (ch.id === S.active ? ' active' : '') + (n > 0 && ch.id !== S.active ? ' unread' : '');
    const hash = document.createElement('span'); hash.className = 'hash'; hash.textContent = '#';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = ch.name;
    btn.append(hash, name);
    if (n > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = n > 99 ? '99+' : String(n);
      btn.appendChild(badge);
    }
    btn.onclick = () => switchChannel(ch.id);
    list.appendChild(btn);
  }

  const team = $('#team-list');
  team.innerHTML = '';
  const names = Object.keys(S.users).sort((a, b) => {
    const ao = S.online.has(a) ? 0 : 1, bo = S.online.has(b) ? 0 : 1;
    return ao - bo || a.localeCompare(b);
  });
  for (const name of names) {
    const on = S.online.has(name);
    const row = document.createElement('div');
    row.className = 'team-item' + (on ? '' : ' offline-name');
    const dot = document.createElement('span'); dot.className = 'dot' + (on ? '' : ' offline');
    const label = document.createElement('span'); label.textContent = name;
    row.append(dot, label);
    if (S.me && name === S.me.username) {
      const you = document.createElement('span'); you.className = 'you'; you.textContent = '(you)';
      row.appendChild(you);
    }
    team.appendChild(row);
  }
}

function renderHeader() {
  const ch = getChannel(S.active);
  $('#ch-name').textContent = ch ? ch.name : '';
  $('#ch-topic').textContent = ch ? ch.topic : '';
}

function renderMessages() {
  const box = $('#messages');
  const ch = getChannel(S.active);
  box.innerHTML = '';
  if (!ch) return;
  let prev = null, prevDay = null;
  for (const m of ch.messages) {
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
    author.textContent = m.username;
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
  rxBtn.onclick = (e) => openPicker(e.currentTarget, { mode: 'react', channelId: m.channel, messageId: m.id });
  actions.appendChild(rxBtn);

  row.append(avCol, body, actions);
  return row;
}

function buildReactions(m) {
  const wrap = document.createElement('div');
  wrap.className = 'reactions';
  for (const [emoji, users] of Object.entries(m.reactions || {})) {
    const pill = document.createElement('button');
    pill.className = 'rx' + (users.includes(S.me.username) ? ' mine' : '');
    pill.title = users.join(', ');
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
  add.onclick = (e) => openPicker(e.currentTarget, { mode: 'react', channelId: m.channel, messageId: m.id });
  wrap.appendChild(add);
  return wrap;
}

function scrollBottom(force) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

/* ------------------------------ channels ------------------------------ */

function switchChannel(id) {
  if (S.active === id) return;
  S.active = id;
  const ch = getChannel(id);
  if (ch && ch.messages.length) lastRead[id] = ch.messages[ch.messages.length - 1].ts;
  else lastRead[id] = S.serverNow;
  saveLastRead();
  renderAll();
  scrollBottom(true);
  $('#input').focus();
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
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : 'Several people are typing…';
  bar.append(dots, label);
}
setInterval(renderTyping, 1000); // expire stale indicators

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
    : (e) => send({ type: 'react', channelId: mode.channelId, messageId: mode.messageId, emoji: e }));
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); closeModal(); } });

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

/* ------------------------------ modal ------------------------------ */

function openModal() {
  $('#modal-backdrop').classList.remove('hidden');
  $('#new-channel-name').value = '';
  $('#new-channel-name').focus();
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); }
function createChannel() {
  const name = $('#new-channel-name').value.trim().toLowerCase();
  if (!name) return;
  send({ type: 'create_channel', name });
  closeModal();
}

/* ------------------------------ login / boot ------------------------------ */

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
  const name = document.createElement('div'); name.className = 'me-name'; name.textContent = S.me.username;
  const status = document.createElement('div'); status.className = 'me-status offline'; status.id = 'me-status'; status.textContent = 'connecting…';
  info.append(name, status);
  const out = document.createElement('button');
  out.className = 'icon-btn';
  out.title = 'Sign out';
  out.textContent = '⏻';
  out.onclick = () => { ls.del('pulse.identity'); location.reload(); };
  card.append(av, info, out);
}

function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderMe();
  connect();
}

function showLogin() {
  $('#login').classList.remove('hidden');
  const wrap = $('#login-colors');
  wrap.innerHTML = '';
  let selected = COLORS[Math.floor(Math.random() * COLORS.length)];
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === selected ? ' selected' : '');
    b.style.background = c;
    b.onclick = () => {
      selected = c;
      wrap.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('selected', s === b));
    };
    wrap.appendChild(b);
  }
  const submit = () => {
    const name = $('#login-name').value.trim();
    if (!name) { $('#login-name').focus(); return; }
    S.me = { username: name, color: selected };
    ls.set('pulse.identity', JSON.stringify(S.me));
    enterApp();
  };
  $('#login-btn').onclick = submit;
  $('#login-name').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  setTimeout(() => $('#login-name').focus(), 50);
}

function boot() {
  // wiring that doesn't depend on identity
  $('#send-btn').onclick = sendMessage;
  $('#emoji-btn').onclick = (e) => openPicker(e.currentTarget, { mode: 'composer' });
  $('#add-channel').onclick = openModal;
  $('#modal-cancel').onclick = closeModal;
  $('#modal-create').onclick = createChannel;
  $('#new-channel-name').onkeydown = (e) => { if (e.key === 'Enter') createChannel(); };
  $('#modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) closeModal(); };

  const input = $('#input');
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    if (input.value.trim() && S.active) noteTyping();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  let identity = null;
  try { identity = JSON.parse(ls.get('pulse.identity') || 'null'); } catch {}
  if (identity && identity.username) { S.me = identity; enterApp(); }
  else showLogin();
}

document.addEventListener('DOMContentLoaded', boot);
})();
