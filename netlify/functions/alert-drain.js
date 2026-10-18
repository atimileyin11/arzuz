/* ============================================================
   Arzuz — Netlify Function: the alert outbox drain

   Every quarter hour it sends what the waitlist door queued in
   alert_outbox (supabase-alert-outbox.sql) and marks each row sent.
   A row past eight attempts stops being retried but stays in the
   table — an announcement that never went out is a fact the team
   can still read, not a row to delete.

   WHY A DRAIN INSTEAD OF SENDING INLINE
   The browser used to tell /api/notify only after the save, so a
   closed page, a dropped network or a Telegram blink at exactly
   that second left a row in the database with nobody told — and
   nothing ever retried it. The door now queues the announcement
   beside the submission (best-effort, never failing the save) and
   this schedule delivers it with retries and a shared ceiling, so
   thirty submissions in one minute send at most the ceiling however
   many instances served them.

   It never throws and never fails the schedule: an unsent alert is
   still pending, and the next run tries again.

   Schedule (netlify.toml): every fifteen minutes — that is the
   oldest an announcement waits, and Telegram's own per-minute
   ceiling is what paces the burst, not this clock.
   ============================================================ */

'use strict';

const notify = require('./notify.js');
const AlertThrottle = require('./lib/alert-throttle.js');

const BATCH = 20;        // rows per run — a run is a cron tick, not a worker
const MAX_ATTEMPTS = 8;  // then it rests as failed, still auditable
const THROTTLE_KEY = 'telegram';
const THROTTLE_WINDOW_SECONDS = 60;
const THROTTLE_MAX = 25; // under Telegram's own ceiling, with room for live sends

function cfg() {
  const url = String(
    process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || ''
  ).trim().replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return { url, serviceKey, ready: !!(url && serviceKey) };
}

async function sb(c, path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({
    apikey: c.serviceKey,
    Authorization: 'Bearer ' + c.serviceKey,
    'Content-Type': 'application/json',
  }, opts.headers || {});
  opts.signal = AbortSignal.timeout(9000);
  const res = await fetch(c.url + '/rest/v1/' + path, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  if (!res.ok) {
    const err = new Error('Supabase answered ' + res.status);
    err.status = res.status;
    throw err;
  }
  return body;
}

/* One pending row, sent or counted. Returns 'sent', 'kept' (still
   pending — attempts left) or 'rested' (attempts spent, marked
   failed but kept for the audit). Never throws: the row, not the
   run, carries the failure. */
async function deliverRow(c, row) {
  let text;
  try {
    text = notify.formatMessage(row.table_name, row.payload || {});
  } catch (err) {
    text = 'New form submission (' + String(row.ref || 'no reference') + ')';
  }
  const ok = await notify.sendAlert(text);
  const attempts = (row.attempts || 0) + 1;
  if (ok) {
    await sb(c, 'alert_outbox?id=eq.' + encodeURIComponent(row.id), {
      method: 'PATCH',
      body: JSON.stringify({ status: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null }),
    });
    return 'sent';
  }
  const rested = attempts >= MAX_ATTEMPTS;
  await sb(c, 'alert_outbox?id=eq.' + encodeURIComponent(row.id), {
    method: 'PATCH',
    body: JSON.stringify(
      rested
        ? { status: 'failed', attempts, last_error: 'telegram-unanswered' }
        : { attempts, last_error: 'telegram-unanswered' }
    ),
  });
  return rested ? 'rested' : 'kept';
}

async function drain(c) {
  const rows = await sb(c,
    'alert_outbox?select=id,table_name,ref,payload,attempts' +
    '&status=eq.pending&attempts=lt.' + MAX_ATTEMPTS +
    '&order=created_at.asc&limit=' + BATCH);
  const counts = { sent: 0, kept: 0, rested: 0 };
  for (const row of rows || []) {
    /* The shared ceiling paces the burst: when it is spent, the rest
       wait for the next tick rather than tripping Telegram's own. */
    if (!(await AlertThrottle.allowSend({
      key: THROTTLE_KEY,
      windowSeconds: THROTTLE_WINDOW_SECONDS,
      max: THROTTLE_MAX,
    }))) {
      break;
    }
    try {
      counts[await deliverRow(c, row)] += 1;
    } catch (err) {
      /* The PATCH failed, not the send — the row will be retried and
         the worst case is a duplicate message, which the team can see
         is a duplicate. A throw here would abandon the whole batch. */
      console.error('[alert-drain] row', row && row.id, 'unmarked:', err && err.message);
      counts.kept += 1;
    }
  }
  return counts;
}

exports.handler = async function () {
  const c = cfg();
  if (!c.ready) {
    /* Not configured is a deployment fact, logged where the schedule
       can be seen — and answered 200, because a cron that errors is a
       retry storm nobody asked for. */
    console.error('[alert-drain] SUPABASE_SERVICE_ROLE_KEY is not set — outbox waits');
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not-configured' }) };
  }
  try {
    const counts = await drain(c);
    console.log('[alert-drain] tick', JSON.stringify(counts));
    return { statusCode: 200, body: JSON.stringify({ ok: true, counts }) };
  } catch (err) {
    console.error('[alert-drain] tick failed:', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'degraded' }) };
  }
};

/* Exported for scripts/test-alert-outbox.mjs. */
exports.drain = drain;
exports.deliverRow = deliverRow;
exports.BATCH = BATCH;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
