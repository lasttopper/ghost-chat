#!/usr/bin/env node
/* Validates the Telegram bot setup:
 *   node scripts/telegram-check.js              → getMe + list recent chats (find your chat id)
 *   node scripts/telegram-check.js --send-test  → also sends a test message to TELEGRAM_CHAT_ID
 *
 * Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from .env or process env.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* tiny .env loader */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';

(async () => {
  if (!TOKEN) {
    console.error('✗ TELEGRAM_BOT_TOKEN not set. Run scripts/configure.js first.');
    process.exit(1);
  }

  /* 1. who am i */
  const me = await (await fetch(`${API}/bot${TOKEN}/getMe`)).json();
  if (!me.ok) { console.error(`✗ Token rejected by Telegram: ${me.description}`); process.exit(1); }
  console.log(`✓ Bot authenticated: @${me.result.username} ("${me.result.first_name}")`);

  /* 2. recent chats — so you can find the right chat_id */
  const upd = await (await fetch(`${API}/bot${TOKEN}/getUpdates`)).json();
  if (upd.ok) {
    const chats = new Map();
    for (const u of upd.result || []) {
      const c = (u.message && u.message.chat) || (u.channel_post && u.channel_post.channel) ||
                (u.my_chat_member && u.my_chat_member.chat);
      if (c) chats.set(String(c.id), `${c.type}: ${c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no title)'} → id ${c.id}`);
    }
    if (chats.size) {
      console.log('\nChats that recently interacted with the bot:');
      for (const line of chats.values()) console.log('  • ' + line);
      console.log('\nGroups/supergroups/channels are the usual choice for reports.');
    } else {
      console.log('\n(no recent chats yet — send any message to the bot or add it to a group and message there, then re-run)');
    }
  }

  /* 3. optional test send */
  if (process.argv.includes('--send-test')) {
    if (!CHAT) { console.error('✗ --send-test needs TELEGRAM_CHAT_ID'); process.exit(1); }
    const res = await (await fetch(`${API}/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: '👻 Ghost Chat: Telegram delivery configured successfully. The midnight report will arrive here as a document.' }),
    })).json();
    if (res.ok) console.log(`\n✓ Test message sent to chat ${CHAT} — check Telegram!`);
    else { console.error(`\n✗ Send failed: ${res.description}`); process.exit(1); }
  } else if (CHAT) {
    console.log(`\nTELEGRAM_CHAT_ID is set to ${CHAT}. Run with --send-test to send a test message.`);
  }
})().catch((e) => { console.error('✗ Error:', e.message); process.exit(1); });
