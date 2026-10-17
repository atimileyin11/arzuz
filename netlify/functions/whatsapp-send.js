/* ============================================================
   Arzuz — Netlify Function: WhatsApp message proxy

   TWO DOORS, ONE SENDER.

     THE PAGE'S DOOR   POST /api/whatsapp-send { to, text }
       The browser asks this function to forward a message; the
       OpenWA credentials never leave the server.

     THE SERVER'S DOOR sendText(jid, text)
       claims.js tells a student and a worker what the coverage
       decision was, and it runs INSIDE a function — so it cannot
       call its own endpoint without an HTTP round-trip to itself,
       and it must not hold a second copy of the OpenWA config.
       It requires this file instead, exactly as every server-side
       caller reaches Telegram through notify.js's sendAlert(): a
       credential with one owner, and one implementation of "send a
       message" for both doors.

   Nothing is thrown from either door. A message that will not go is a
   fact the caller records — a claim decision must not fail because a
   phone number was stale.

   Environment variables (set in Netlify dashboard):
     OPENWA_URL       – e.g. https://your-openwa.railway.app
     OPENWA_API_KEY   – the key you configured on the OpenWA server
     OPENWA_SESSION   – session name, e.g. "ARZUZ"
   ============================================================ */

/* The shared failure vocabulary — the SAME file the page loads, so the
   class in this body is the class assets/whatsapp.js reads, not a
   second guess at the same status code. This function has no json()
   helper (it predates them), so each answer is stamped where it is
   written. */
const ApiErrors = require('../../assets/api-errors.js');

// Simple in-memory rate-limit cache (per function instance)
const recentSends = new Map();
const RATE_LIMIT_MS = 60_000; // one message per phone per 60 seconds

/* ------------------------------------------------------------
   the one copy of the OpenWA configuration
   ------------------------------------------------------------ */

function waConfig() {
  const url = String(process.env.OPENWA_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.OPENWA_API_KEY || '').trim();
  // If OPENWA_SESSION is 'waitlist-reply', OpenWA route requires the session ID (UUID)
  let session = process.env.OPENWA_SESSION || 'a17024f9-848a-47bc-8808-f0cc359ac2ad';
  if (session === 'waitlist-reply') {
    session = 'a17024f9-848a-47bc-8808-f0cc359ac2ad';
  }
  return { url: url, key: key, session: session, ready: !!(url && key) };
}

/* OpenWA accepts 234XXXXXXXXXX@s.whatsapp.net, and 234XXXXXXXXXX@c.us on
   its own message route — which of the two a caller has is not their
   business, so both are accepted and normalised here. */
function jidOk(raw) {
  return /^234\d{10}@(s\.whatsapp\.net|c\.us)$/.test(String(raw || ''));
}

function normaliseJid(raw) {
  return String(raw).replace(/@s\.whatsapp\.net$/, '@c.us');
}

/* ------------------------------------------------------------
   THE SERVER'S DOOR
   Returns { ok } or { ok: false, reason } where reason is one word a
   log or a trail row can quote: 'not-configured', 'bad-jid',
   'openwa-<status>', 'unreachable'.
   ------------------------------------------------------------ */

async function sendText(to, text) {
  const body = String(text === undefined || text === null ? '' : text);
  if (!body.trim()) return { ok: false, reason: 'empty-text' };

  const cfg = waConfig();
  if (!cfg.ready) {
    console.error('[whatsapp-send] OPENWA_URL or OPENWA_API_KEY not set');
    return { ok: false, reason: 'not-configured' };
  }
  if (!jidOk(to)) return { ok: false, reason: 'bad-jid' };

  const endpoint = cfg.url + '/api/sessions/' + cfg.session + '/messages/send-text';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key': cfg.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatId: normaliseJid(to), text: body }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[whatsapp-send] OpenWA error', response.status, errBody);
      return { ok: false, reason: 'openwa-' + response.status };
    }

    recentSends.set(String(to).split('@')[0], Date.now());
    console.log('[whatsapp-send] Message sent to', String(to).split('@')[0]);
    return { ok: true, reason: 'sent' };
  } catch (err) {
    console.error('[whatsapp-send] Network error:', err.message);
    return { ok: false, reason: 'unreachable' };
  }
}

/* ------------------------------------------------------------
   THE PAGE'S DOOR
   ------------------------------------------------------------ */

exports.handler = async function (event) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify(ApiErrors.wireBody(405, { error: 'Method not allowed' })) };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify(ApiErrors.wireBody(400, { error: 'Invalid JSON body' })) };
  }

  const { to, text } = body;

  // Validate required fields
  if (!to || !text) {
    return { statusCode: 400, body: JSON.stringify(ApiErrors.wireBody(400, { error: 'Missing "to" or "text" field' })) };
  }

  // Validate phone format: must be 234XXXXXXXXXX@s.whatsapp.net
  if (!jidOk(to)) {
    return { statusCode: 400, body: JSON.stringify(ApiErrors.wireBody(400, { error: 'Invalid WhatsApp JID format. Expected 234XXXXXXXXXX@s.whatsapp.net' })) };
  }

  // Rate limiting — one message per phone per minute
  const phone = String(to).split('@')[0];
  const now = Date.now();
  if (recentSends.has(phone) && now - recentSends.get(phone) < RATE_LIMIT_MS) {
    return { statusCode: 429, body: JSON.stringify(ApiErrors.wireBody(429, { error: 'Rate limited — try again in a minute' })) };
  }

  const cfg = waConfig();
  if (!cfg.ready) {
    /* A 503 that means "not switched on", not "try again in a minute" —
       and the sentence names the two variables to set, because "not
       configured" is a log line, not something to act on. */
    return { statusCode: 503, body: JSON.stringify(ApiErrors.wireBody(503, {
      error: 'WhatsApp sending is not configured on this deploy: OPENWA_URL and ' +
        'OPENWA_API_KEY are not set in Netlify.',
    }, 'not-ready')) };
  }

  const out = await sendText(to, text);

  if (out.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  /* The reason comes back as the same answer this endpoint has always
     given for each case — the refactor added a door, not a new dialect. */
  if (out.reason === 'openwa-401' || out.reason === 'openwa-403') {
    return { statusCode: 502, body: JSON.stringify(ApiErrors.wireBody(502, { error: 'OpenWA refused the API key' })) };
  }
  if (/^openwa-/.test(out.reason)) {
    return { statusCode: 502, body: JSON.stringify(ApiErrors.wireBody(502, { error: 'OpenWA returned ' + out.reason.slice(7) })) };
  }
  if (out.reason === 'unreachable') {
    return { statusCode: 502, body: JSON.stringify(ApiErrors.wireBody(502, { error: 'Could not reach OpenWA server' })) };
  }
  if (out.reason === 'not-configured') {
    return { statusCode: 503, body: JSON.stringify(ApiErrors.wireBody(503, {
      error: 'WhatsApp sending is not configured on this deploy: OPENWA_URL and ' +
        'OPENWA_API_KEY are not set in Netlify.',
    }, 'not-ready')) };
  }
  return { statusCode: 400, body: JSON.stringify(ApiErrors.wireBody(400, { error: 'That message could not be sent.' })) };
};

/* Used by claims.js (the coverage decision and the dispute resolution),
   and exercised through that file by scripts/test-claims.mjs \u2014 the
   notice tests there read what would have gone out, and to whom. */
exports.sendText = sendText;
exports.waConfig = waConfig;
