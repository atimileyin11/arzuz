/* ============================================================
   Arzuz — the one thing the hourly probe has to REMEMBER

   WHY THIS EXISTS

     An hour that is green sends nothing, by design: a daily "all
     good" is how a team learns to ignore the channel. But that means
     after an outage the first healthy hour also says nothing — the
     outage ends in silence, and the last thing the team heard was
     "broken". They find out the site is back the way they found out
     it went down: by hand.

     So the healthy hour writes ONE fact down — when it last was
     healthy — and the next healthy run can tell "nothing happened"
     from "nothing happened for three hours, and now it is answering".
     That difference is the all-clear.

   WHY finance_config, AND WHY THAT IS NOT LAZY

     It is the one key/value table this deploy's service key can write
     without a migration, and a new table created in supabase-health.sql
     would be a feature that does nothing until somebody remembers to
     run the migration — the same silent nothing this project keeps
     trying to end. The key is namespaced (`ops_database_health`), no
     admin action reads it, and `readConfig()` collects unknown keys
     into an object nobody iterates.

     One row, rewritten once an hour. Nothing is appended, no student
     data is involved, and the value is a timestamp.

   WHAT IT NEVER DOES

     It never writes during a FAILING hour: the database is the thing
     that is broken, so the write would fail anyway, and a half-written
     state is worse than none. A failed hour therefore leaves the old
     timestamp in place — which is exactly what makes the gap, and the
     all-clear, visible on the other side.

     It never turns a state problem into an outage: a missing table, a
     refused read, a timeout all come back as `known: false` with a
     reason the caller logs. The probe's verdict stands on its own.
   ============================================================ */

/* Two hours, because the schedule is hourly: a gap longer than this
   means at least one whole healthy run was missed. A slightly late run
   (minutes) must not fire an all-clear for an outage that never was. */
const GRACE_MS = 2 * 60 * 60 * 1000;

const ROW_KEY = 'ops_database_health';
const TABLE = 'finance_config';

function trim(url) {
  return String(url || '').replace(/\/+$/, '');
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
 * The last hour this deploy proved itself healthy.
 *
 * @returns {Promise<{known: boolean, lastOkAt: Date|null, reason?: string}>}
 *          known:false means "this deploy cannot remember" — which is
 *          reported, never read as "nothing happened".
 */
async function readLastOk(opts) {
  const o = opts || {};
  const project = trim(o.project);
  const key = String(o.key || '');
  if (!project || !key) return { known: false, lastOkAt: null, reason: 'no project or no key to read the marker with' };

  let out;
  try {
    out = await send(project + '/rest/v1/' + TABLE + '?select=value&key=eq.' + ROW_KEY, key, { method: 'GET' });
  } catch (err) {
    return { known: false, lastOkAt: null, reason: 'the marker could not be read: ' + (err && err.message) };
  }

  /* PostgREST answers 404 with code 42P01 for a relation that does not
     exist, and 401 when the key was just refused — the caller has
     already proved the key on this run, so a 401 here is a race, not a
     verdict. Either way: no memory, said out loud. */
  if (out.status === 404) {
    return { known: false, lastOkAt: null, reason: 'there is no ' + TABLE + ' table to keep the marker in on this project' };
  }
  if (out.status < 200 || out.status >= 300) {
    return { known: false, lastOkAt: null, reason: 'the marker read answered ' + out.status };
  }

  let rows = null;
  try { rows = JSON.parse(out.text); } catch (_) { rows = null; }
  if (!Array.isArray(rows)) return { known: false, lastOkAt: null, reason: 'the marker read was not a list' };

  const value = rows[0] && rows[0].value;
  const at = value && (value.last_ok_at || value.lastOkAt);
  const when = at ? new Date(at) : null;
  if (when && isNaN(when.getTime())) {
    return { known: false, lastOkAt: null, reason: 'the marker holds a timestamp this code cannot read' };
  }
  return { known: true, lastOkAt: when };
}

/**
 * Record that this hour was healthy. One row, one upsert.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function markHealthy(opts) {
  const o = opts || {};
  const project = trim(o.project);
  const key = String(o.key || '');
  const at = o.at ? new Date(o.at) : new Date();
  if (!project || !key) return { ok: false, reason: 'no project or no key to write the marker with' };

  try {
    const out = await send(project + '/rest/v1/' + TABLE + '?on_conflict=key', key, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{
        key: ROW_KEY,
        value: { last_ok_at: at.toISOString() },
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

  const gapMs = at.getTime() - previous.lastOkAt.getTime();
  return { send: gapMs > GRACE_MS, gapMs: gapMs, lastOkAt: previous.lastOkAt };
}

module.exports = { readLastOk, markHealthy, recoveryFrom, GRACE_MS, ROW_KEY, TABLE };
