/* ============================================================
   Arzuz — one send ceiling, every instance

   The per-minute caps used to live in each function instance's
   memory (notify.js → recentSends, whatsapp-send.js → recentSends),
   and Netlify runs as many instances as it likes — so thirty
   submissions in one minute sent one alert per instance, not one
   page of alerts. alert_throttle() in supabase-alert-outbox.sql is
   the same idea as waitlist_throttle() for the sending side: one
   counter in the database instead of one per instance.

   allowSend() asks the database first and the memory second. A
   throttle that cannot answer — no service key on this deploy, a
   migration not yet run, a database hiccup — falls back to the
   in-memory cap rather than refusing to send: a guard that fails
   open, because a duplicate alert is noise while a dropped one
   pages nobody. It never throws, for the same reason sendAlert and
   sendText never throw: by the time a send is attempted, the thing
   it describes is already committed.

   Loads via require() in Netlify functions and in the
   scripts/test-*.mjs harnesses, exactly like the other lib files.
   ============================================================ */

'use strict';

const mem = new Map(); // key -> array of epoch millis, this instance only

function memAllowed(key, windowMs, max) {
  const now = Date.now();
  const seen = (mem.get(key) || []).filter((t) => now - t <= windowMs);
  if (seen.length >= max) {
    mem.set(key, seen);
    return false;
  }
  seen.push(now);
  mem.set(key, seen);
  return true;
}

function dbCfg() {
  const url = String(
    process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || ''
  ).trim().replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return { url, serviceKey, ready: !!(url && serviceKey) };
}

async function dbAllowed(cfg, key, windowSeconds, max) {
  const res = await fetch(cfg.url + '/rest/v1/rpc/alert_throttle', {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: 'Bearer ' + cfg.serviceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_key: key, p_window_seconds: windowSeconds, p_max: max }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error('alert_throttle answered HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return !body || body.allow !== false;
}

/* The one call a sender makes. `key` scopes the ceiling ('telegram'
   for the ops channel, 'wa:<digits>' for one subscriber's
   confirmations); `windowSeconds` and `max` are the ceiling itself.
   Answers true when the send may go out. Never throws. */
async function allowSend(opts) {
  const o = opts || {};
  const key = String(o.key || 'default');
  const windowSeconds = o.windowSeconds > 0 ? o.windowSeconds : 60;
  const max = o.max > 0 ? o.max : 30;
  const cfg = dbCfg();
  if (cfg.ready) {
    try {
      return await dbAllowed(cfg, key, windowSeconds, max);
    } catch (err) {
      /* The shared counter is unreachable — the deploy is older than
         the migration, or the database blinked. The memory cap is
         still better than no cap, and far better than no send. */
    }
  }
  return memAllowed(key, windowSeconds * 1000, max);
}

function clearMem() {
  mem.clear();
}

module.exports = { allowSend, memAllowed, dbCfg, clearMem };
