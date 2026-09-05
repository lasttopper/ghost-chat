/* Pulse — shared protocol core.
 * Used by both the standalone server (server.js) and the Vercel function
 * (api/ws.js) so the exact same, e2e-tested protocol runs on either host.
 *
 * createCore(persistence) where persistence is:
 *   { load(): Promise<state|null>, save(state): Promise<void>, saveSync?(state) } | null
 */
'use strict';

const MAX_MESSAGES_PER_CHANNEL = 500;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,20}$/;
const OFFLINE_GRACE_MS = 4000; // tolerate quick reconnects (tab refresh, host-enforced WS caps)
const SAVE_DEBOUNCE_MS = 300;

/* ------------------------------ helpers ------------------------------ */

function seedState() {
  const now = Date.now();
  return {
    nextMessageId: 1,
    users: { 'PulseBot': { color: '#8b5cf6' } },
    channels: [
      {
        id: 'general', name: 'general',
        topic: 'Company-wide announcements and work-based matters',
        createdAt: now,
        messages: [
          { id: 'm-seed-1', channel: 'general', username: 'system', color: '', ts: now - 1000, system: true,
            text: 'Welcome to Pulse! 👋 This is the very beginning of #general.', reactions: {} },
          { id: 'm-seed-2', channel: 'general', username: 'PulseBot', color: '#8b5cf6', ts: now, system: false,
            text: "Hey! Open this page in a second tab and join with a different name — you'll see messages, typing indicators and presence update live. Hover any message and hit 😀 to react.", reactions: {} },
        ],
      },
      {
        id: 'random', name: 'random',
        topic: 'Non-work banter and water cooler conversation',
        createdAt: now, messages: [],
      },
    ],
  };
}

const sanitizeText = (t) =>
  String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);

const sanitizeName = (n) => {
  const s = String(n == null ? '' : n).replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 20);
  return s || 'Guest';
};

const sanitizeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c)) ? String(c) : '#6366f1');

/* ------------------------------- core ------------------------------- */

function createCore(persistence) {
  let state = seedState();
  let nextMessageId = 1;

  const clients = new Map();       // ws -> { username, color }
  const declared = new Set();      // usernames currently announced as online
  const offlineTimers = new Map(); // username -> timeout (grace window)
  let saveTimer = null;

  /* initial load (async so a REST-backed store like Upstash works) */
  const ready = (async () => {
    if (persistence) {
      try {
        const s = await persistence.load();
        if (s && Array.isArray(s.channels)) {
          state = s;
          nextMessageId = s.nextMessageId || 1;
        }
      } catch (e) { console.error('state load failed:', e.message); }
    }
  })();

  async function reload() {
    if (!persistence) return;
    try {
      const s = await persistence.load();
      if (s && Array.isArray(s.channels)) {
        state = s;
        nextMessageId = Math.max(nextMessageId, s.nextMessageId || 1);
      }
    } catch (e) { console.error('state reload failed:', e.message); }
  }

  function save() {
    if (!persistence) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.nextMessageId = nextMessageId;
      persistence.save(state).catch((e) => console.error('save failed:', e.message));
    }, SAVE_DEBOUNCE_MS);
  }

  function flush() {
    if (persistence && persistence.saveSync) {
      clearTimeout(saveTimer);
      state.nextMessageId = nextMessageId;
      try { persistence.saveSync(state); } catch (e) { console.error('flush failed:', e.message); }
    }
  }

  /* --------------------------- pub helpers --------------------------- */

  const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const broadcast = (obj, except) => {
    const data = JSON.stringify(obj);
    for (const ws of clients.keys()) {
      if (ws !== except && ws.readyState === 1) { try { ws.send(data); } catch {} }
    }
  };

  // online = has a live socket OR is inside the offline grace window
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

  const getChannel = (id) => state.channels.find((c) => c.id === String(id));
  const newId = () => 'm' + nextMessageId++;
  const sysMessage = (channelId, text) => ({
    id: newId(), channel: channelId, username: 'system', color: '',
    ts: Date.now(), system: true, text, reactions: {},
  });

  /* ------------------------------ protocol ------------------------------ */

  async function handle(ws, msg) {
    const me = clients.get(ws);

    switch (msg.type) {
      case 'join': {
        const username = sanitizeName(msg.username);
        const color = sanitizeColor(msg.color);
        clients.set(ws, { username, color });
        if (!state.users[username]) state.users[username] = { color };
        else state.users[username].color = color;
        save();

        // cancel a pending offline announcement (quick reconnect)
        const t = offlineTimers.get(username);
        if (t) { clearTimeout(t); offlineTimers.delete(username); }
        const isNewlyOnline = !declared.has(username);
        declared.add(username);

        await ready;
        await reload(); // pick up writes from other instances (serverless)

        send(ws, { type: 'init', channels: state.channels, users: state.users, online: onlineNames(), now: Date.now() });
        if (isNewlyOnline) broadcastPresence();
        break;
      }

      case 'message': {
        if (!me) return;
        const channel = getChannel(msg.channel);
        const text = sanitizeText(msg.text);
        if (!channel || !text) return;
        const m = {
          id: newId(), channel: channel.id, username: me.username, color: me.color,
          ts: Date.now(), system: false, text, reactions: {},
        };
        channel.messages.push(m);
        if (channel.messages.length > MAX_MESSAGES_PER_CHANNEL) {
          channel.messages.splice(0, channel.messages.length - MAX_MESSAGES_PER_CHANNEL);
        }
        save();
        broadcast({ type: 'message', message: m });
        break;
      }

      case 'react': {
        if (!me) return;
        const channel = getChannel(msg.channelId);
        if (!channel) return;
        const m = channel.messages.find((x) => x.id === String(msg.messageId));
        if (!m) return;
        const emoji = String(msg.emoji || '').slice(0, 16);
        if (!emoji) return;
        m.reactions = m.reactions || {};
        const list = m.reactions[emoji] || [];
        const i = list.indexOf(me.username);
        if (i >= 0) list.splice(i, 1); else list.push(me.username);
        if (list.length === 0) delete m.reactions[emoji]; else m.reactions[emoji] = list;
        save();
        broadcast({ type: 'reactions', channelId: channel.id, messageId: m.id, reactions: m.reactions });
        break;
      }

      case 'typing':
      case 'typing_stop': {
        if (!me || !getChannel(msg.channel)) return;
        broadcast({ type: msg.type, channel: String(msg.channel), username: me.username }, ws);
        break;
      }

      case 'create_channel': {
        if (!me) return;
        const name = String(msg.name || '').toLowerCase().trim();
        if (!CHANNEL_NAME_RE.test(name)) {
          send(ws, { type: 'error', message: 'Channel names: lowercase letters, numbers, hyphens (max 21 chars).' });
          return;
        }
        if (getChannel(name)) {
          send(ws, { type: 'error', message: `#${name} already exists.` });
          return;
        }
        const channel = {
          id: name, name, topic: '', createdAt: Date.now(),
          messages: [sysMessage(name, `${me.username} created #${name}`)],
        };
        state.channels.push(channel);
        save();
        broadcast({ type: 'channel_created', channel });
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
      // grace window: a refresh or host-enforced reconnect shouldn't flap presence
      offlineTimers.set(username, setTimeout(() => {
        offlineTimers.delete(username);
        if (!hasSocket(username)) {
          declared.delete(username);
          broadcastPresence();
        }
      }, OFFLINE_GRACE_MS));
    });
  }

  return { ready, onConnection, flush };
}

/* ping/pong heartbeat: drop dead sockets so presence stays honest behind proxies */
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
