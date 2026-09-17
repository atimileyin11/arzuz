/* ============================================================
   Arzuz — Netlify Function: WhatsApp message proxy

   Receives { to, text } from the frontend and forwards it to
   the OpenWA server using server-side credentials. The API key
   never touches the browser.

   Environment variables (set in Netlify dashboard):
     OPENWA_URL       – e.g. https://your-openwa.railway.app
     OPENWA_API_KEY   – the key you configured on the OpenWA server
     OPENWA_SESSION   – session name, e.g. "ARZUZ"
   ============================================================ */

// Simple in-memory rate-limit cache (per function instance)
const recentSends = new Map();
const RATE_LIMIT_MS = 60_000; // one message per phone per 60 seconds

exports.handler = async function (event) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { to, text } = body;

  // Validate required fields
  if (!to || !text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing "to" or "text" field' }) };
  }

  // Validate phone format: must be 234XXXXXXXXXX@s.whatsapp.net
  if (!/^234\d{10}@s\.whatsapp\.net$/.test(to)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid WhatsApp JID format. Expected 234XXXXXXXXXX@s.whatsapp.net' }) };
  }

  // Rate limiting — one message per phone per minute
  const phone = to.split('@')[0];
  const now = Date.now();
  if (recentSends.has(phone) && now - recentSends.get(phone) < RATE_LIMIT_MS) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Rate limited — try again in a minute' }) };
  }

  // Read server-side config
  const OPENWA_URL = process.env.OPENWA_URL;
  const OPENWA_API_KEY = process.env.OPENWA_API_KEY;
  const OPENWA_SESSION = process.env.OPENWA_SESSION || 'ARZUZ';

  if (!OPENWA_URL || !OPENWA_API_KEY) {
    console.error('[whatsapp-send] OPENWA_URL or OPENWA_API_KEY not set');
    return { statusCode: 503, body: JSON.stringify({ error: 'WhatsApp service not configured' }) };
  }

  // Forward to OpenWA
  const endpoint = `${OPENWA_URL.replace(/\/+$/, '')}/api/sessions/${OPENWA_SESSION}/messages/send/text`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key': OPENWA_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ to, text })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[whatsapp-send] OpenWA error', response.status, errBody);
      return { statusCode: 502, body: JSON.stringify({ error: 'OpenWA returned ' + response.status }) };
    }

    // Mark rate-limit
    recentSends.set(phone, now);

    console.log('[whatsapp-send] Message sent to', phone);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[whatsapp-send] Network error:', err.message);
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach OpenWA server' }) };
  }
};
