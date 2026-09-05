/* Ghost Chat — shared protocol core.
 * Used by the standalone server (server.js) and the Vercel function (api/ws.js).
 *
 * Conversations: public channels, private channels (invite-link only,
 * member-filtered) and DMs (2 members). Reports are stored for the daily
 * midnight digest (see digest.js).
 */
'use strict';

const crypto = require('crypto');

const MAX_MESSAGES_PER_CHANNEL = 500;
const MAX_REPORTS = 500;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,20}$/;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(['system', 'ghostbot', 'admin', 'root', 'everyone', 'all', 'here']);
const OFFLINE_GRACE_MS = 4000;
const SAVE_DEBOUNCE_MS = 300;

/* ------------------------------ helpers ------------------------------ */

function seedState() {
  const now = Date.now();
  return {
    nextMessageId: 1,
    lastDigestDate: null,
    users: { 'GhostBot': { color: '#8b5cf6', authId: 'system:ghostbot', createdAt: now } },
    channels: [
      {
        id: 'general', name: 'general', type: 'channel', private: false, inviteCode: null,
        members: [], createdBy: 'GhostBot',
        topic: 'Everyone is here. Say hi 👻',
        createdAt: now,
        messages: [
          { id: 'm-seed-1', channel: 'general', username: 'system', color: '', ts: now - 1000, system: true,
            text: 'Welcome to Ghost Chat! This is the beginning of #general.', reactions: {} },
          { id: 'm-seed-2', channel: 'general', username: 'GhostBot', color: '#8b5cf6', ts: now, system: false,
            text: "Hey! Create a private group (🔒) and share its invite link, or slide into someone's DMs from the sidebar. Hover any message to react 😀 or report 🚩.", reactions: {} },
        ],
      },
      {
        id: 'random', name: 'random', type: 'channel', private: false, inviteCode: null,
        members: [], createdBy: 'GhostBot',
        topic: 'Non-work banter and water cooler conversation',
        createdAt: now, messages: [],
      },
    ],
    dms: [],
    reports: [],
  };
}

function normalizeState(s) {
  s.users = s.users || {};
  s.channels = s.channels || [];
  s.dms = s.dms || [];
  s.reports = s.reports || [];
  s.nextMessageId = s.nextMessageId || 1;
  if (!('lastDigestDate' in s)) s.lastDigestDate = null;
  for (const c of s.channels) {
    if (!('type' in c)) c.type = 'channel';
    if (!('private' in c)) c.private = false;
    if (!('members' in c)) c.members = [];
    if (!('inviteCode' in c)) c.inviteCode = null;
  }
  return s;
}

const sanitizeText = (t) =>
  String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);

const sanitizeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c)) ? String(c) : '#8b5cf6');

const validUsername = (u) => USERNAME_RE.test(String(u || '').toLowerCase());

const newInviteCode = () => crypto.randomBytes(6).toString('base64url'); // ~8 chars

/* ------------------------------- core ------------------------------- */

function createCore(persistence) {
  let state = seedState();
  let nextMessageId = 1;

  const clients = new Map();       // ws -> { username, color }
  const declared = new Set();
  const offlineTimers = new Map();
  let saveTimer = null;

  const ready = (async () => {
    if (persistence) {
      try {
        const s = await persistence.load();
        if (s && Array.isArray(s.channels)) { state = normalizeState(s); nextMessageId = s.nextMessageId || 1; }
      } catch (e) { console.error('state load failed:', e.message); }
    }
  })();

  async function reload() {
    if (!persistence) return;
    try {
      const s = await persistence.load();
      if (s && Array.isArray(s.channels)) {
        state = normalizeState(s);
        nextMessageId = Math.max(nextMessageId, s.nextMessageId || 1);
      }
    } catch (e) { console.error('state reload failed:', e.message); }
  }

  // write immediately (used before reloads so in-flight debounce isn't clobbered)
  function saveNow() {
    if (!persistence) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = null;
    state.nextMessageId = nextMessageId;
    return persistence.save(state).catch((e) => console.error('save failed:', e.message));
  }

  function save() {
    if (!persistence) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
  }

  function flush() {
    if (persistence && persistence.saveSync) {
      clearTimeout(saveTimer);
      state.nextMessageId = nextMessageId;
      try { persistence.saveSync(state); } catch (e) { console.error('flush failed:', e.message); }
    }
  }

  /* --------------------------- messaging utils --------------------------- */

  const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const broadcast = (obj, except) => {
    const data = JSON.stringify(obj);
    for (const ws of clients.keys()) {
      if (ws !== except && ws.readyState === 1) { try { ws.send(data); } catch {} }
    }
  };

  const getChannel = (id) => state.channels.find((c) => c.id === String(id));
  const getDm = (id) => state.dms.find((d) => d.id === String(id));
  const findConv = (id) => getChannel(id) || getDm(id);

  // null = everyone (public channel); array = only these usernames
  const convMembers = (conv) => (!conv ? null : (conv.type === 'dm' || conv.private) ? conv.members : null);
  const inConv = (conv, username) => { const m = convMembers(conv); return !m || m.includes(username); };

  const broadcastConv = (conv, obj, except) => {
    const data = JSON.stringify(obj);
    for (const [ws, c] of clients) {
      if (ws === except || ws.readyState !== 1 || !c.username) continue;
      if (inConv(conv, c.username)) { try { ws.send(data); } catch {} }
    }
  };

  const onlineNames = () => {
    const s = new Set(declared);
    for (const c of clients.values()) s.add(c.username);
    return [...s];
  };
  const broadcastPresence = () => broadcast({ type: 'presence', online: onlineNames() });
  const hasSocket = (username) => {
    for (const c of clients.values()) if (c.username === username) return true;
    return false;
  };

  const newId = () => 'm' + nextMessageId++;
  const sysMessage = (convId, text) => ({
    id: newId(), channel: convId, username: 'system', color: '',
    ts: Date.now(), system: true, text, reactions: {},
  });

  const dmIdFor = (a, b) => 'dm:' + [a, b].sort().join(':');

  const visibleChannels = (username) => state.channels.filter((c) => inConv(c, username));
  const myDms = (username) => state.dms.filter((d) => d.members.includes(username));

  /* ------------------------------ protocol ------------------------------ */

  function completeJoin(ws, username, authId, email, displayName, color) {
    const me = { username, color };
    clients.set(ws, me);

    const u = state.users[username] || {};
    state.users[username] = {
      color,
      authId,
      email: email || u.email || '',
      displayName: displayName || u.displayName || '',
      createdAt: u.createdAt || Date.now(),
    };
    save();

    const t = offlineTimers.get(username);
    if (t) { clearTimeout(t); offlineTimers.delete(username); }
    const isNewlyOnline = !declared.has(username);
    declared.add(username);

    send(ws, {
      type: 'init',
      username,
      channels: visibleChannels(username),
      dms: myDms(username),
      users: state.users,
      online: onlineNames(),
      now: Date.now(),
    });
    if (isNewlyOnline) broadcastPresence();
  }

  // returns null if the join may proceed, else sends the rejection itself
  function admitUsername(ws, msg) {
    const username = String(msg.username || '').toLowerCase().trim();
    if (!validUsername(username)) {
      send(ws, { type: 'error', message: 'Username: 3–20 chars, lowercase letters, numbers, underscore.' });
      return null;
    }
    if (RESERVED.has(username)) {
      send(ws, { type: 'error', message: 'That username is reserved.' });
      return null;
    }
    // authId: Firebase uid or per-browser guest id. Legacy/test clients without
    // one get a name-scoped id (no cross-claim protection).
    const authId = String(msg.authId || '') || ('local:' + username);
    const existing = state.users[username];
    if (existing && existing.authId && existing.authId !== authId) {
      send(ws, { type: 'username_taken', username });
      return null;
    }
    return { username, authId };
  }

  async function handle(ws, msg) {
    const me = clients.get(ws);

    switch (msg.type) {
      case 'join': {
        const color = sanitizeColor(msg.color);
        const rawName = String(msg.username || '').toLowerCase().trim();
        if (!rawName) { send(ws, { type: 'need_username' }); return; }
        const ok = admitUsername(ws, msg);
        if (!ok) return;
        await ready;
        if (saveTimer) await saveNow(); // flush pending writes before clobbering state via reload
        await reload();
        completeJoin(ws, ok.username, ok.authId, msg.email, msg.displayName, color);
        break;
      }

      case 'message': {
        if (!me) return;
        const conv = findConv(msg.channel);
        const text = sanitizeText(msg.text);
        if (!conv || !text || !inConv(conv, me.username)) return;
        const m = {
          id: newId(), channel: conv.id, username: me.username, color: me.color,
          ts: Date.now(), system: false, text, reactions: {},
        };
        conv.messages.push(m);
        if (conv.messages.length > MAX_MESSAGES_PER_CHANNEL) {
          conv.messages.splice(0, conv.messages.length - MAX_MESSAGES_PER_CHANNEL);
        }
        save();
        broadcastConv(conv, { type: 'message', message: m });
        break;
      }

      case 'react': {
        if (!me) return;
        const conv = findConv(msg.channelId);
        if (!conv || !inConv(conv, me.username)) return;
        const m = conv.messages.find((x) => x.id === String(msg.messageId));
        if (!m) return;
        const emoji = String(msg.emoji || '').slice(0, 16);
        if (!emoji) return;
        m.reactions = m.reactions || {};
        const list = m.reactions[emoji] || [];
        const i = list.indexOf(me.username);
        if (i >= 0) list.splice(i, 1); else list.push(me.username);
        if (list.length === 0) delete m.reactions[emoji]; else m.reactions[emoji] = list;
        save();
        broadcastConv(conv, { type: 'reactions', channelId: conv.id, messageId: m.id, reactions: m.reactions });
        break;
      }

      case 'typing':
      case 'typing_stop': {
        if (!me) return;
        const conv = findConv(msg.channel);
        if (!conv || !inConv(conv, me.username)) return;
        broadcastConv(conv, { type: msg.type, channel: conv.id, username: me.username }, ws);
        break;
      }

      case 'create_channel': {
        if (!me) return;
        const name = String(msg.name || '').toLowerCase().trim();
        const isPrivate = !!msg.private;
        if (!CHANNEL_NAME_RE.test(name)) {
          send(ws, { type: 'error', message: 'Group names: lowercase letters, numbers, hyphens (max 21 chars).' });
          return;
        }
        if (getChannel(name)) {
          send(ws, { type: 'error', message: `#${name} already exists.` });
          return;
        }
        const channel = {
          id: name, name, type: 'channel', private: isPrivate,
          inviteCode: isPrivate ? newInviteCode() : null,
          members: isPrivate ? [me.username] : [],
          createdBy: me.username, topic: isPrivate ? 'Private group — invite link only' : '',
          createdAt: Date.now(),
          messages: [sysMessage(name, isPrivate
            ? `${me.username} created this private group`
            : `${me.username} created #${name}`)],
        };
        state.channels.push(channel);
        save();
        broadcastConv(channel, { type: 'channel_created', channel }); // private: creator only
        break;
      }

      case 'join_channel': {
        if (!me) return;
        const code = String(msg.code || '');
        const channel = state.channels.find((c) => c.private && c.inviteCode === code);
        if (!channel) { send(ws, { type: 'error', message: 'That invite link is not valid.' }); return; }
        if (!channel.members.includes(me.username)) {
          channel.members.push(me.username);
          const sys = sysMessage(channel.id, `${me.username} joined via invite link`);
          channel.messages.push(sys);
          save();
          broadcastConv(channel, { type: 'member_joined', channelId: channel.id, username: me.username }, ws);
          broadcastConv(channel, { type: 'message', message: sys }, ws);
        }
        send(ws, { type: 'channel_joined', channel });
        break;
      }

      case 'dm_start': {
        if (!me) return;
        const to = String(msg.to || '').toLowerCase();
        if (to === me.username) { send(ws, { type: 'error', message: "That's you!" }); return; }
        if (!state.users[to]) { send(ws, { type: 'error', message: `No user @${to}.` }); return; }
        const id = dmIdFor(me.username, to);
        let dm = getDm(id);
        let isNew = false;
        if (!dm) {
          dm = { id, type: 'dm', members: [me.username, to], createdAt: Date.now(), messages: [] };
          state.dms.push(dm);
          isNew = true;
          save();
        }
        send(ws, { type: 'dm_ready', conv: dm, isNew });
        if (isNew) {
          for (const [otherWs, c] of clients) {
            if (c.username === to && otherWs !== ws) send(otherWs, { type: 'dm_ready', conv: dm, isNew: true });
          }
        }
        break;
      }

      case 'report': {
        if (!me) return;
        const conv = findConv(msg.convId);
        if (!conv || !inConv(conv, me.username)) return;
        const reason = sanitizeText(msg.reason);
        if (!reason) { send(ws, { type: 'error', message: 'A report needs a reason.' }); return; }
        const m = msg.messageId ? conv.messages.find((x) => x.id === String(msg.messageId)) : null;
        const report = {
          id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
          ts: Date.now(),
          reporter: me.username,
          targetUser: m ? m.username : String(msg.targetUser || ''),
          convId: conv.id,
          convKind: conv.type === 'dm' ? 'dm' : (conv.private ? 'private' : 'public'),
          messageId: m ? m.id : null,
          messageText: m ? m.text : '',
          reason,
        };
        state.reports.push(report);
        if (state.reports.length > MAX_REPORTS) state.reports.splice(0, state.reports.length - MAX_REPORTS);
        save();
        send(ws, { type: 'report_ack', id: report.id });
        break;
      }
    }
  }

  /* ---------------------------- connection lifecycle ---------------------------- */

  function onConnection(ws) {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handle(ws, msg).catch((e) => console.error('handler error:', e));
    });
    ws.on('close', () => {
      const me = clients.get(ws);
      clients.delete(ws);
      if (!me) return;
      const username = me.username;
      if (hasSocket(username) || offlineTimers.has(username) || !declared.has(username)) return;
      offlineTimers.set(username, setTimeout(() => {
        offlineTimers.delete(username);
        if (!hasSocket(username)) { declared.delete(username); broadcastPresence(); }
      }, OFFLINE_GRACE_MS));
    });
  }

  /* accessors for the digest scheduler */
  const getState = () => state;
  function setLastDigestDate(d) { state.lastDigestDate = d; save(); }

  return { ready, onConnection, flush, getState, setLastDigestDate };
}

/* ping/pong heartbeat */
function attachHeartbeat(wss) {
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  if (iv.unref) iv.unref();
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
}

module.exports = { createCore, attachHeartbeat };
