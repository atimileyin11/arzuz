/* ============================================================
   Arzuz — Netlify Function: the inbound WhatsApp webhook

   THE DOOR THE WORKER'S REPLY COMES IN THROUGH.

   Naming somebody on a job is us saying who is coming. It is not them
   agreeing to come — and until this function existed, a worker who
   could not take the job had no way to say so except ringing the
   office, while the claim sat in 'assigned' with somebody on it who was
   never going to turn up. The handover message ends by telling them to
   reply if anything is wrong, so this is where that reply lands.

   WHAT ARRIVES
     OpenWA (the WhatsApp gateway the site sends through) posts a JSON
     event to /api/wa-inbound for every message it receives:

       POST /api/wa-inbound
       X-OpenWA-Event:            message.received
       X-OpenWA-Signature:        sha256=<hex>
       X-OpenWA-Idempotency-Key:  …
       X-OpenWA-Delivery-Id:      …
       X-OpenWA-Retry-Count:      n
       { "event": "message.received", "timestamp": …, "sessionId": …,
         "idempotencyKey": …, "deliveryId": …,
         "data": { "from": "2348031119999@s.whatsapp.net", "body": "yes",
                   "fromMe": false, "isGroup": false, "type": "text",
                   "id": "…", "senderPhone": null, … } }

   THE SIGNATURE IS THE ONLY THING THAT MAKES THIS SAFE TO EXPOSE.
   The body decides who is expected at a student's flat, so an endpoint
   that accepted an unsigned POST would let anybody who found the URL
   hand a stranger a job, or turn a real worker off one. OpenWA signs
   the exact bytes it sends with the webhook's own secret
   (HMAC-SHA256, hex, in X-OpenWA-Signature) — the same construction
   paystack-webhook.js verifies for money — and without
   OPENWA_WEBHOOK_SECRET set, this function refuses EVERY request
   rather than trusting one.

   WHAT IT REFUSES TO DO
     · Never reads a message it did not sign, and never one of our own:
       `fromMe` is checked first, because every message the site SENDS
       also comes back through this webhook as message.sent — treating
       those as replies would make the machine answer itself.
     · Never answers a group. The office is in WhatsApp groups; a
       message in one is not a worker replying to a handover.
     · Never guesses. Whether a reply is a yes, a no, or neither is
       decided in claims.js (classifyReply) and an unclear answer gets
       a plain question back rather than an interpretation.
     · Never retries itself into a second answer: OpenWA redelivers
       until it gets a 2xx, so a delivery that has already been handled
       is acknowledged and dropped.

   Environment variables (Netlify dashboard):
     OPENWA_WEBHOOK_SECRET  – the secret on the OpenWA webhook pointed
                              at this URL. Required; nothing is processed
                              without it.
   ============================================================ */

const crypto = require('node:crypto');

const ApiErrors = require('../../assets/api-errors.js');
const claims = require('./claims.js');

// Simple in-memory dedupe (per function instance), the same shape and the
// same limits as whatsapp-send.js's rate-limit cache: one message is one
// answer, and a lambda that has just seen a delivery says so.
const seen = new Map();
const SEEN_MS = 10 * 60_000;

function json(status, obj, kind) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(ApiErrors.wireBody(status, obj, kind)),
  };
}

/* Constant-time, length-checked — the same pattern paystack-webhook.js and
   listing-live.js use: timingSafeEqual throws on a length mismatch, so the
   throw is the "invalid" answer rather than a crash. A missing secret is
   NOT a match, and neither is an empty one: `if (!a || !secret)` comes
   first for exactly that reason. */
function signatureMatches(given, expected, secret) {
  const a = String(given || '').replace(/^sha256=/i, '').trim();
  const b = String(expected || '');
  if (!a || !secret) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a.toLowerCase()), Buffer.from(b.toLowerCase()));
  } catch (e) {
    return false;
  }
}

function readBody(event) {
  return event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : String(event.body || '');
}

function headerOf(headers, name) {
  const lower = name.toLowerCase();
  const found = Object.keys(headers || {}).filter((k) => k.toLowerCase() === lower)[0];
  return found ? String(headers[found] || '') : '';
}

/* The phone a reply came FROM. The JID is the sender identity — for a
   privacy-id (@lid) sender it is not a number at all, so OpenWA's own
   resolution (senderPhone, populated only when the operator switched it
   on) is used when it is there, and the message is dropped when it is
   not. A wrong number would put an answer on somebody else's job. */
function senderPhone(data) {
  const raw = String((data && (data.senderPhone || '')) || '');
  const jid = String((data && data.from) || '');
  const digits = raw ? raw : jid.split('@')[0];
  return String(digits || '').replace(/[^\d]/g, '');
}

exports.handler = async function (event) {
  if (String(event.httpMethod || 'GET').toUpperCase() !== 'POST') {
    return json(405, { error: 'POST only.' });
  }

  const secret = String(process.env.OPENWA_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return json(503, {
      error: 'This deploy has no OPENWA_WEBHOOK_SECRET, so it cannot tell a message OpenWA sent ' +
        'from a stranger posting one.',
    }, 'not-ready');
  }

  const headers = event.headers || {};
  const raw = readBody(event);
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');

  if (!signatureMatches(headerOf(headers, 'x-openwa-signature'), expected, secret)) {
    console.warn('[wa-inbound] refused a body that was not signed with the webhook secret');
    return json(401, { error: 'That body was not signed with the webhook secret, so nothing was read.' }, 'rejected');
  }

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (e) {
    return json(400, { error: 'The webhook body is not valid JSON.' });
  }
  if (!payload || typeof payload !== 'object') {
    return json(400, { error: 'The webhook sent no event to read.' });
  }

  /* Answered 2xx for everything below, whatever we do with it: a webhook
     that hears a failure RETRIES, and retrying a decision that will never
     change ("this is not a worker's reply") is how a gateway ends up
     redelivering the same message five times. */
  const bodyEvent = String(payload.event || '');
  if (bodyEvent && bodyEvent !== 'message.received') {
    return json(200, { ok: true, ignored: 'event ' + bodyEvent });
  }

  const data = (payload.data && typeof payload.data === 'object') ? payload.data : {};

  /* OUR OWN MESSAGES COME BACK THROUGH THIS HOOK. Every handover, every
     decision notice and every acknowledgement is a message.sent /
     message.received echo of something we wrote; reading one as a reply
     would have the machine answering itself. */
  if (data.fromMe) return json(200, { ok: true, ignored: 'our own message' });
  if (data.isGroup) return json(200, { ok: true, ignored: 'a group, not a worker' });
  if (data.isStatusBroadcast) return json(200, { ok: true, ignored: 'a status post' });

  const text = String(data.body === undefined || data.body === null ? '' : data.body).trim();
  if (!text) return json(200, { ok: true, ignored: 'no text to read' });

  const phone = senderPhone(data);
  if (!/^234\d{10}$/.test(phone)) {
    return json(200, { ok: true, ignored: 'no usable sender number' });
  }

  /* DEDUPE, keyed on delivery first and message id second. OpenWA
     re-delivers on anything that is not a 2xx, and the same message can
     also arrive twice when a session reconnects. The map is only written
     AFTER the answer was recorded, so a real failure still gets its
     retry. */
  const stamp = Date.now();
  for (const [k, t] of seen) if (stamp - t > SEEN_MS) seen.delete(k);
  const keys = [String(headerOf(headers, 'x-openwa-delivery-id') || ''), String(data.id || '')]
    .filter(Boolean).map((k) => phone + ':' + k);
  if (keys.some((k) => seen.has(k))) {
    return json(200, { ok: true, ignored: 'already answered' });
  }

  let out = null;
  try {
    out = await claims.workerReply({ phone: phone, text: text });
  } catch (err) {
    /* A failure here is the database, not the message. 502 asks OpenWA to
       deliver it again, which is what makes a transient outage recover
       instead of silently losing a worker's "I cannot take it". */
    console.error('[wa-inbound] the reply could not be recorded:', err && err.message);
    return json(502, { error: 'The reply could not be recorded, so it was not acknowledged.' });
  }

  keys.forEach((k) => seen.set(k, Date.now()));
  console.log('[wa-inbound] ' + phone + ' \u2192 ' + (out.reason || 'handled') +
    (out.claim ? ' ' + out.claim : ''));
  return json(200, { ok: true, handled: !!out.handled, outcome: out.reason, claim: out.claim || null });
};

/* Exported for the claims suite, which drives this door without a network:
   scripts/test-claims.mjs. */
exports.signature = function (body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(String(body)).digest('hex');
};
exports.senderPhone = senderPhone;
