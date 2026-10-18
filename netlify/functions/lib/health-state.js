/* ============================================================
   Arzuz — the one thing the hourly probe has to REMEMBER

   WHY THIS EXISTS

     A healthy hour sends nothing, by design: a daily "all good" is how
     a team learns to ignore the channel. But that means after an outage
     the first healthy hour also says nothing — the outage ends in
     silence, and the last thing the team heard was "broken". They find
     out the site is back the way they found out it went down: by hand.

     So every healthy hour writes ONE fact down — when each check last
     passed — and the next healthy run can tell "nothing happened" from
     "nothing happened for three hours, and now it is answering". That
     difference is the all-clear.

   NOW THREE CHECKS, NOT ONE

     The probe watches the database key, the Paystack key and the
     Telegram token, so the memory is a timestamp PER CHECK. The rule is
     the same for all three: a failing hour does not touch that check's
     timestamp, so the gap measures that check's outage; the first hour
     it passes again sends one notice and writes the new time.

     A check that is not configured (no Paystack key on this deploy) has
     no timestamp at all: it is not healthy, so it is never declared
     recovered, and it is never written. Absence is the build gate's
     business, not the pager's.

     THERE IS ONE MORE CASE, AND IT IS THE FIRST DAY

     A credential that is already broken when this probe first ships has
     never passed, so it has no timestamp to measure a gap from — the
     team would get an alert every hour and then, when it was fixed,
     silence. So a failing check also records WHEN IT STARTED failing
     (once per outage, never moved), and a check with no healthy hour
     can still be announced as recovered from that refusal. The success
     that follows clears it.

   WHY finance_config, AND WHY THAT IS NOT LAZY

     It is the one key/value table this deploy's service key can write
     without a migration, and a new table created in supabase-health.sql
     would be a feature that does nothing until somebody remembers to
     run the migration — the same silent nothing this project keeps
     trying to end. The key name (`ops_database_health`) is historical:
     it started as one timestamp and now holds one row with three. It is
     namespaced, no admin action reads it, and `readConfig()` collects
     unknown keys into an object nobody iterates.

     The old shape — `{ last_ok_at }` — is still READ as the database's
     timestamp, so a deploy that rolls over mid-outage neither invents a
     recovery nor loses the gap it was in the middle of measuring. Every
     write is the new shape, with `last_ok_at` kept as the database's
     copy for a previous deploy still running beside this one.

   WHAT IT NEVER DOES

     It never writes a FAILING check's healthy timestamp. A failed hour
     leaves the old one in place, which is exactly what makes the gap,
     and the all-clear, visible on the other side. The only thing a
     failure writes is the time it STARTED (`failing`), once per outage,
     so an outage that began before this probe existed can still be
     closed with a notice.

     It never turns a state problem into an outage: a missing table, a
     refused read, a timeout all come back as `known: false` with a
     reason the caller logs. The probes' verdicts stand on their own.
     And a lost read can only SUPPRESS a notice, never invent one.
   ============================================================ */

/* Ninety minutes, because the schedule is hourly: a gap longer than this
   means a whole healthy run was missed, while a run that is merely late
   (up to half an hour) must not fire an all-clear for an outage that
   never was.

   Two hours was the first number, and it was wrong by one run. The
   shortest real outage looks like this: healthy at 10:00, refused at
   11:00 (the alert lands), fixed, green at 12:00 — a two-hour gap from
   the last healthy hour, so `> 2h` stayed silent and the team heard
   "broken" and then nothing. That is the exact case this notice exists
   for, so the threshold sits between one interval and two. */
const GRACE_MS = 90 * 60 * 1000;

const ROW_KEY = 'ops_database_health';
const TABLE = 'finance_config';

/* The order the all-clear lists them in. */
const CHECKS = ['database', 'paystack', 'telegram'];

function trim(url) {
  return String(url || '').replace(/\/+$/, '');
}

function when(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

async function send(url, key, init) {
  const res = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({
      apikey: key,
      Authorization: 'Bearer ' + key,
    }, (init && init.headers) || {}),
    signal: AbortSignal.timeout(8000),
  }));
  const text = await res.text().catch(() => '');
  return { status: res.status, text: text };
}

/**
 * When each check last passed.
 *
 * @returns {Promise<{known: boolean, at: object, reason?: string}>}
 *          known:false means "this deploy cannot remember" — which is
 *          reported, never read as "nothing happened".
 */
async function readState(opts) {
  const o = opts || {};
  const project = trim(o.project);
  const key = String(o.key || '');
  if (!project || !key) return { known: false, at: {}, reason: 'no project or no key to read the marker with' };

  let out;
  try {
    out = await send(project + '/rest/v1/' + TABLE + '?select=value&key=eq.' + ROW_KEY, key, { method: 'GET' });
  } catch (err) {
    return { known: false, at: {}, reason: 'the marker could not be read: ' + (err && err.message) };
  }

  /* PostgREST answers 404 with code 42P01 for a relation that does not
     exist, and 401 when the key was just refused — the caller has
     already proved what it could, so a 401 here is a race, not a
     verdict. Either way: no memory, said out loud. */
  if (out.status === 404) {
    return { known: false, at: {}, reason: 'there is no ' + TABLE + ' table to keep the marker in on this project' };
  }
  if (out.status < 200 || out.status >= 300) {
    return { known: false, at: {}, reason: 'the marker read answered ' + out.status };
  }

  let rows = null;
  try { rows = JSON.parse(out.text); } catch (_) { rows = null; }
  if (!Array.isArray(rows)) return { known: false, at: {}, reason: 'the marker read was not a list' };

  const value = rows[0] && rows[0].value;
  if (!value || typeof value !== 'object') {
    return { known: false, at: {}, reason: 'there is no marker recorded yet' };
  }

  const at = {};
  const stored = value.checks && typeof value.checks === 'object' ? value.checks : null;
  if (stored) {
    for (const name of CHECKS) {
      const d = when(stored[name]);
      if (d) at[name] = d;
    }
  } else {
    /* The shape before this probe watched three credentials: one
       timestamp, and it was the database's. */
    const d = when(value.last_ok_at);
    if (d) at.database = d;
  }

  const failing = {};
  if (value.failing && typeof value.failing === 'object') {
    for (const name of CHECKS) {
      const d = when(value.failing[name]);
      if (d) failing[name] = d;
    }
  }
  return { known: true, at: at, failing: failing };
}

/**
 * Record that these checks passed this hour. One row, one upsert.
 *
 * @param {object} opts
 * @param {string[]} [opts.checks]  which checks passed
 * @param {object} [opts.previous]  the state read earlier this run, so
 *                                  the other checks' timestamps survive
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function markHealthy(opts) {
  const o = opts || {};
  const project = trim(o.project);
  const key = String(o.key || '');
  const at = o.at ? new Date(o.at) : new Date();
  const names = Array.isArray(o.checks) ? o.checks : CHECKS;
  if (!project || !key) return { ok: false, reason: 'no project or no key to write the marker with' };

  const checks = {};
  const failing = {};
  const previous = o.previous;
  if (previous && previous.known && previous.at) {
    for (const name of CHECKS) {
      if (previous.at[name]) checks[name] = new Date(previous.at[name]).toISOString();
    }
  }
  if (previous && previous.failing) {
    for (const name of CHECKS) {
      if (previous.failing[name]) failing[name] = new Date(previous.failing[name]).toISOString();
    }
  }
  for (const name of names) {
    if (CHECKS.indexOf(name) !== -1) {
      checks[name] = at.toISOString();
      delete failing[name];
    }
  }
  /* The FIRST failure of an outage is the point its recovery is measured
     from — moved, it would shorten every notice. */
  for (const name of (Array.isArray(o.failing) ? o.failing : [])) {
    if (CHECKS.indexOf(name) !== -1 && !failing[name]) failing[name] = at.toISOString();
  }

  const value = { checks: checks, failing: failing };
  if (checks.database) value.last_ok_at = checks.database;

  try {
    const out = await send(project + '/rest/v1/' + TABLE + '?on_conflict=key', key, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{
        key: ROW_KEY,
        value: value,
        updated_by: 'database-health',
      }]),
    });
    if (out.status < 200 || out.status >= 300) {
      return { ok: false, reason: 'the marker write answered ' + out.status };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'the marker could not be written: ' + (err && err.message) };
  }
}

/**
 * One check's memory, in the shape recoveryFrom() takes.
 *
 * @returns {{known: boolean, lastOkAt: Date|null, reason?: string}}
 */
function stateFor(state, name) {
  const since = state && state.failing && state.failing[name] ? state.failing[name] : null;
  if (!state || !state.known) {
    return { known: false, lastOkAt: null, failingSince: since, reason: (state && state.reason) || 'no marker' };
  }
  const at = state.at && state.at[name];
  if (!at) {
    return { known: false, lastOkAt: null, failingSince: since, reason: 'no healthy hour recorded for ' + name + ' yet' };
  }
  return { known: true, lastOkAt: at, failingSince: since };
}

/**
 * The recovery decision for one check, including the case where it has
 * never passed: an outage that began before this probe existed is still
 * an outage, and its end is still worth saying.
 *
 * @returns {{send: boolean, gapMs: number, lastOkAt: Date|null, since: string, reason?: string}}
 *          since: healthy (a passing hour was recorded) | failing (only
 *          the first refusal was) — the notice says which it is.
 */
function recoveryForState(state, name, now) {
  const st = stateFor(state, name);
  if (st.known) return Object.assign(recoveryFrom(st, now), { since: 'healthy' });
  if (st.failingSince) {
    const at = now ? new Date(now) : new Date();
    const gapMs = at.getTime() - st.failingSince.getTime();
    return { send: gapMs > GRACE_MS, gapMs: gapMs, lastOkAt: st.failingSince, since: 'failing' };
  }
  return { send: false, gapMs: 0, lastOkAt: null, since: 'unknown', reason: st.reason };
}

/**
 * The decision, kept apart from the sending so the suite can assert it
 * without a Telegram stub in the way.
 *
 * @returns {{ send: boolean, gapMs: number, lastOkAt: Date|null, reason?: string }}
 */
function recoveryFrom(previous, now) {
  const at = now ? new Date(now) : new Date();
  if (!previous || !previous.known) {
    return { send: false, gapMs: 0, lastOkAt: null, reason: (previous && previous.reason) || 'no marker' };
  }
  if (!previous.lastOkAt) return { send: false, gapMs: 0, lastOkAt: null, reason: 'no marker recorded yet' };

  const gapMs = at.getTime() - new Date(previous.lastOkAt).getTime();
  return { send: gapMs > GRACE_MS, gapMs: gapMs, lastOkAt: previous.lastOkAt };
}

module.exports = { readState, markHealthy, stateFor, recoveryFrom, recoveryForState, GRACE_MS, ROW_KEY, TABLE, CHECKS };
