/* Ghost Chat — daily report digest.
 * At midnight (REPORT_TZ, default Asia/Kolkata) compiles the day's chats,
 * user details and filed reports into a text file and sends it to Telegram
 * via the Bot API (sendDocument). Without TELEGRAM_BOT_TOKEN/CHAT_ID the
 * file is still written locally under reports/.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------- timezone helpers ------------------------- */

// 'YYYY-MM-DD' for a given instant in a timezone (en-CA gives ISO ordering)
function tzDateStr(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

// minutes such that local = UTC + offset
function tzOffsetMin(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
  return (asUTC - ms) / 60000;
}

// epoch ms at which 'YYYY-MM-DD' begins in tz
function tzDayStart(dateStr, tz) {
  const guess = Date.parse(dateStr + 'T00:00:00Z');
  let start = guess - tzOffsetMin(guess, tz) * 60000;
  start = guess - tzOffsetMin(start, tz) * 60000; // second pass converges
  return start;
}

function nextDateStr(dateStr) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}
function prevDateStr(dateStr) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

/** Which day should be reported now? null = nothing due. */
function dueDigest(lastDigestDate, nowMs, tz) {
  const today = tzDateStr(nowMs, tz);
  if (!lastDigestDate) return null;          // first run: initialize only
  if (lastDigestDate >= today) return null;  // already current
  return prevDateStr(today);
}

/* --------------------------- digest builder --------------------------- */

function fmtTime(ts, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
}

function buildDigestText(state, dateStr, tz) {
  const start = tzDayStart(dateStr, tz);
  const end = tzDayStart(nextDateStr(dateStr), tz);
  const inDay = (ts) => ts >= start && ts < end;
  const L = [];

  L.push('========================================');
  L.push('  GHOST CHAT — DAILY REPORT');
  L.push(`  Day: ${dateStr} (${tz})`);
  L.push(`  Generated: ${new Date().toISOString()}`);
  L.push('========================================');

  // users
  const users = Object.entries(state.users || {});
  L.push('', `USERS (${users.length})`);
  for (const [name, u] of users) {
    L.push(`  @${name} | id: ${u.authId || '-'} | email: ${u.email || '-'} | display: ${u.displayName || '-'} | color: ${u.color}`);
  }

  // conversations: full chat log for the day
  const convs = [
    ...(state.channels || []).map((c) => ({ kind: c.private ? 'PRIVATE GROUP' : 'PUBLIC GROUP', conv: c })),
    ...(state.dms || []).map((d) => ({ kind: 'DIRECT CHAT', conv: d })),
  ];
  L.push('', `CHATS ON ${dateStr}`);
  let total = 0;
  for (const { kind, conv } of convs) {
    const label = conv.type === 'dm' ? conv.members.map((m) => '@' + m).join(' <-> ') : '#' + conv.name;
    const msgs = (conv.messages || []).filter((m) => inDay(m.ts));
    total += msgs.filter((m) => !m.system).length;
    L.push('', `--- ${kind}: ${label} (${msgs.length} messages) ---`);
    if (!msgs.length) { L.push('  (no activity)'); continue; }
    for (const m of msgs) {
      const who = m.system ? '*' : '@' + m.username;
      L.push(`  [${fmtTime(m.ts, tz)}] ${who}: ${m.text}`);
    }
  }
  L.push('', `Total messages on ${dateStr}: ${total}`);

  // reports
  const reports = (state.reports || []).filter((r) => r.ts < end); // pending as of that day
  L.push('', `REPORTS PENDING (${reports.length})`);
  if (!reports.length) L.push('  (none)');
  for (const r of reports) {
    L.push(`  [${new Date(r.ts).toISOString()}] reporter @${r.reporter} -> target @${r.targetUser || '?'} in ${r.convKind} ${r.convId}`);
    if (r.messageText) L.push(`    message: ${r.messageText}`);
    L.push(`    reason: ${r.reason}`);
  }

  L.push('', '======== END OF REPORT ========');
  return L.join('\n');
}

/* --------------------------- telegram sender --------------------------- */

async function sendToTelegram(text, filename, { token, chatId, apiUrl, caption }) {
  if (!token || !chatId) return { sent: false, skipped: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', String(caption || `Ghost Chat daily report — ${filename}`));
  form.append('document', new Blob([text], { type: 'text/plain' }), filename);
  const base = apiUrl || 'https://api.telegram.org';
  const res = await fetch(`${base}/bot${token}/sendDocument`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(`telegram sendDocument failed: ${res.status} ${body.description || ''}`);
  return { sent: true };
}

/* ------------------------------ runner ------------------------------ */

/**
 * Build + deliver the report for dateStr.
 * opts: { tz, outDir, telegram: { token, chatId, apiUrl }, log }
 */
async function runDigest(state, { dateStr, tz = 'Asia/Kolkata', outDir = 'reports', telegram = {}, log = console.log } = {}) {
  const text = buildDigestText(state, dateStr, tz);
  const filename = `ghost-chat-report-${dateStr}.txt`;
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, filename);
  await fs.promises.writeFile(filePath, text);

  let delivery = { sent: false };
  try {
    delivery = await sendToTelegram(text, filename, telegram);
  } catch (e) {
    delivery = { sent: false, error: e.message };
  }
  log(`[digest] ${dateStr}: file=${filePath} telegram=${delivery.sent ? 'sent' : (delivery.error || delivery.skipped || 'not sent')}`);
  return { filePath, text, ...delivery };
}

module.exports = { tzDateStr, tzDayStart, dueDigest, buildDigestText, sendToTelegram, runDigest };
