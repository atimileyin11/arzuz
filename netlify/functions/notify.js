/* ============================================================
   Arzuz — Netlify Function: Telegram alerts

   The browser posts { action, table, payload } and this function
   does the rest. It owns TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
   (Site configuration → Environment variables), which is the only
   reason the token is safe: nothing that reaches a phone can read
   it.

   Actions
     status → { token: bool, chatId: bool }   never the values
     detect → { chatId }                      from getUpdates, for setup
     test   → sends a fixed test message
     send   → { table, payload }              formatted here, not client-side

   The message is built here from a whitelist of tables and fields,
   so this endpoint cannot be used to push arbitrary text at your
   Telegram. Values from the form are HTML-escaped and length-capped.
   ============================================================ */

const RATE_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 30;
const recentSends = [];   // best-effort, per function instance

const KNOWN_TABLES = ['demand_records', 'listings', 'scout_submissions'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  };
}

function rateLimited() {
  const now = Date.now();
  while (recentSends.length && now - recentSends[0] > RATE_WINDOW_MS) recentSends.shift();
  if (recentSends.length >= MAX_SENDS_PER_WINDOW) return true;
  recentSends.push(now);
  return false;
}

/* Telegram messages go as HTML so student-typed text can never
   break out of the formatting. Escape everything, then truncate. */
function esc(value, max = 200) {
  if (value === null || value === undefined) return '';
  return String(value)
    .slice(0, max)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

/* Ported from the old client-side formatter — same fields, same order. */
function formatMessage(table, p) {
  const lines = [];
  let title;

  if (table === 'demand_records') {
    title = '🚀 <b>New Student Housing Request</b>';
    lines.push(`• <b>First Name:</b> ${esc(p.first || p.first_name) || 'N/A'}`);
    lines.push(`• <b>Room Type:</b> ${esc(p.type || p.room_type) || 'N/A'}`);
    lines.push(`• <b>Budget:</b> ${esc(p.budget || p.budget_band) || 'N/A'}`);
    lines.push(`• <b>Distance:</b> ${esc(p.dist || p.distance) || 'N/A'}`);
    lines.push(`• <b>Timing:</b> ${esc(p.when || p.timing) || 'N/A'}`);
    lines.push(`• <b>Age Band:</b> ${esc(p.age || p.age_band) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.phone) || 'N/A'}`);
    if (p.g_phone) lines.push(`• <b>Guardian Phone:</b> ${esc(p.g_phone)} (${esc(p.g_name || 'Guardian')})`);
    if (p.pain) lines.push(`• <b>Current Issue:</b> ${esc(p.pain)}`);
  } else if (table === 'listings') {
    title = '🏠 <b>New Landlord Property Listing</b>';
    if (p.prop_name) lines.push(`• <b>Property Name:</b> ${esc(p.prop_name)}`);
    lines.push(`• <b>Owner Name:</b> ${esc(p.nm || p.owner_name) || 'N/A'}`);
    lines.push(`• <b>Property Type:</b> ${esc(p.ty || p.property_type) || 'N/A'}`);
    lines.push(`• <b>Area/Street:</b> ${esc(p.ar || p.area) || 'N/A'}`);
    lines.push(`• <b>Rooms Free:</b> ${esc(p.rm || p.rooms) || 'N/A'}`);
    lines.push(`• <b>Rent per Session:</b> ₦${num(p.rent || p.listed_price_ngn).toLocaleString()}`);
    lines.push(`• <b>Negotiable:</b> ${esc(p.neg) || 'N/A'}`);
    lines.push(`• <b>Run By:</b> ${esc(p.who) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.ph || p.owner_phone) || 'N/A'}`);
    if (p.photo) lines.push(`• <b>Photo:</b> <a href="${esc(p.photo, 300)}">view</a>`);
  } else if (table === 'scout_submissions') {
    title = '🔍 <b>New Building Scout Report</b>';
    lines.push(`• <b>First Name:</b> ${esc(p.first || p.first_name) || 'N/A'}`);
    lines.push(`• <b>Area/Street:</b> ${esc(p.area) || 'N/A'}`);
    lines.push(`• <b>Rooms in Building:</b> ${esc(p.rooms) || 'N/A'}`);
    lines.push(`• <b>Rent Paid:</b> ₦${num(p.amt || p.rent_reported).toLocaleString()}`);
    lines.push(`• <b>Rent Collector:</b> ${esc(p.who) || 'N/A'}`);
    lines.push(`• <b>Vacancy Signal:</b> ${esc(p.vac) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.phone) || 'N/A'}`);
    if (p.photo) lines.push(`• <b>Photo:</b> <a href="${esc(p.photo, 300)}">view</a>`);
  } else {
    title = `📝 <b>New Form Submission</b>`;
    lines.push(`• Table: ${esc(table, 60)}`);
  }

  lines.push('');
  lines.push(`📅 <b>Session:</b> ${esc(process.env.ARZUZ_SESSION || '2026/2027')}`);
  lines.push(`📍 <b>Environment:</b> ${esc(process.env.ARZUZ_ENV || 'production')}`);
  return `${title}\n\n${lines.join('\n')}`;
}

async function telegram(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`Telegram ${method} failed (HTTP ${res.status})`);
  }
  return body;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const action = body.action || 'send';

  /* --- status: used by the admin dashboard, returns no secrets --- */
  if (action === 'status') {
    return json(200, { token: !!token, chatId: !!chatId });
  }

  if (!token) {
    return json(503, {
      error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN in Netlify → Environment variables.',
    });
  }

  /* --- detect: find the chat id of whoever last talked to the bot --- */
  if (action === 'detect') {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
      const data = await res.json().catch(() => ({}));
      let found = null;
      const results = (data && data.result) || [];
      for (let i = results.length - 1; i >= 0 && !found; i--) {
        const item = results[i];
        const msg = item.message || item.channel_post || item.edited_message;
        if (msg && msg.chat && msg.chat.id) found = String(msg.chat.id);
      }
      return json(200, { chatId: found });
    } catch (err) {
      return json(502, { error: 'Could not reach Telegram: ' + err.message });
    }
  }

  if (!chatId) {
    return json(503, {
      error: 'No TELEGRAM_CHAT_ID set in Netlify → Environment variables.',
    });
  }

  if (rateLimited()) {
    return json(429, { error: 'Too many alerts in the last minute — try again shortly.' });
  }

  /* --- test: one fixed message, no client text --- */
  if (action === 'test') {
    const text =
      '🔔 <b>Test alert from Arzuz Admin</b>\n\nYour Telegram notifications are wired up correctly.';
    try {
      await telegram(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
      return json(200, { ok: true });
    } catch (err) {
      return json(502, { error: err.message });
    }
  }

  /* --- send: a real submission --- */
  const table = body.table;
  if (!KNOWN_TABLES.includes(table)) {
    return json(400, { error: 'Unknown table.' });
  }
  const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

  try {
    await telegram(token, 'sendMessage', {
      chat_id: chatId,
      text: formatMessage(table, payload),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error('[notify]', err.message);
    return json(502, { error: 'Could not send the Telegram alert.' });
  }
};
