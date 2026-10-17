/* ============================================================
   Arzuz — Netlify Function: Paystack webhook

   The provider's own callback, and the SECOND door into activation
   (the first is the server-side verify). Both go through the same
   activate(), so there is one implementation of "a paid order becomes
   coverage" rather than two that can drift.

   WHY THE RAW BODY MATTERS
     Paystack signs the EXACT bytes it sent: HMAC-SHA512, hex, in the
     x-paystack-signature header, keyed with the secret key. Parsing
     the body first and re-stringifying it produces different bytes,
     so this function verifies BEFORE it parses. A body that has been
     through JSON.parse can never be verified afterwards.

   WHAT IT WILL NOT DO
     It does not trust the event's amount on its own word — the
     activate() path re-checks that the provider's amount equals the
     order's, so a replayed or tampered event cannot open a pass for
     less than it cost.

   An unrecognised event is answered 200 and ignored: Paystack retries
   anything it does not hear a 2xx for, and a retry storm over an event
   we deliberately do not handle helps nobody.

   Environment: PAYSTACK_SECRET_KEY (server-side only).
   ============================================================ */

const crypto = require('node:crypto');

const { sb, cfg } = require('./roommate-match.js');
const finance = require('./finance.js');
const ApiErrors = require('../../assets/api-errors.js');

function json(status, obj, kind) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(ApiErrors.wireBody(status, obj, kind)),
  };
}

/* Constant-time, length-checked — the hookdeck skill's own Node
   pattern: timingSafeEqual throws on a length mismatch, so the throw
   is the "invalid" answer rather than a crash. */
function verifySignature(rawBody, signature, secret) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

exports.handler = async function (event) {
  const headers = event.headers || {};
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') return json(405, { error: 'POST only.' });

  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  if (!secret) {
    return json(503, { error: 'The Paystack webhook has no PAYSTACK_SECRET_KEY, so it cannot verify anything.' }, 'not-ready');
  }
  if (!cfg().ready) {
    return json(503, { error: 'The webhook cannot reach its database yet.' }, 'not-ready');
  }

  /* The RAW bytes, before any parsing — see the header. */
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : String(event.body || '');

  const signature = headers['x-paystack-signature'] || headers['X-Paystack-Signature'];
  if (!verifySignature(raw, signature, secret)) {
    /* Not Paystack, or not this project's key. Never processed. */
    console.warn('[paystack-webhook] signature refused');
    return json(401, { error: 'That callback is not signed by Paystack.' }, 'rejected');
  }

  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch (_) {
    return json(400, { error: 'The webhook body is not valid JSON.' });
  }

  const type = String((payload && payload.event) || '');
  const data = (payload && payload.data) || {};

  if (type !== 'charge.success') {
    /* Deliberately ignored, and answered 2xx so it is not retried. */
    return json(200, { ok: true, ignored: type || 'unknown event' });
  }

  const reference = String(data.reference || '').trim();
  if (!reference) return json(200, { ok: true, ignored: 'no reference' });

  const rows = await sb(
    'payments?select=*&reference=eq.' + encodeURIComponent(reference) + '&limit=1',
    { method: 'GET' }
  );
  const payment = (rows && rows[0]) || null;

  /* A callback for an order this project does not have is answered
     2xx: retrying will not create it, and a 404 would only make
     Paystack hammer the endpoint. */
  if (!payment) return json(200, { ok: true, ignored: 'unknown order ' + reference });

  if (payment.activated_at) return json(200, { ok: true, already: true, reference: reference });

  if (!finance.amountMatches(payment, data)) {
    await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'failed',
        activation_error: 'webhook amount mismatch: provider ' + data.amount + ' vs order ' + payment.amount_kobo,
        updated_at: new Date().toISOString(),
      }),
    });
    return json(200, { ok: true, mismatch: true, reference: reference });
  }

  const result = await finance.activate(payment.id, data, String(data.reference || reference));
  return json(200, { ok: true, reference: reference, activated: !!result.ok, already: !!result.already });
};

exports.verifySignature = verifySignature;
