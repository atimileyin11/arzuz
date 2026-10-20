/* ============================================================
   Arzuz — is the credential this deploy holds one the project accepts?

   THE FAILURE THIS EXISTS FOR

     Every door on the site went down at once and nothing said so. The
     service key in Netlify was present and Supabase refused it — the
     same value, rotated upstream, or an anon key pasted into the
     service slot. What a visitor saw was not an outage: it was a 502
     "try again in a moment" that never came good, and a student
     buying a Care Pass was told nothing true. It was found by hand,
     an afternoon later, from a shell.

     A missing key has a build gate; a REFUSED key has nothing, because
     the value is there and only the project can say it is the wrong
     one. So this probe asks the project, on a schedule.

   WHAT IT ASKS — AND WHY IT ASKS TWICE

     1. One read of a private table with the key this deployment was
        built with: finance_config, a settings table under RLS, so a
        key that is not this project's cannot see it. 401/403 is a
        refusal; anything else below 500 means the credential was read
        and whatever went wrong was the request.
     2. The SAME request with one byte of the key changed. It must be
        refused. A probe that reports green on a project that accepts
        a tampered key has proved nothing — the relation would be
        readable without a credential at all, which is a leak to fix
        rather than a key to rotate. This is the same trick the upload
        probe uses on a flipped signature.

   AND IT EXERCISES THE LIVE DOORS

     The key can be right and the DEPLOY still wrong — a door shipped
     before the credential it now needs, or a deploy whose functions
     never saw the variable. So it also calls the two doors a stranger
     would: /api/finance (terms) and /api/care-credit (an unknown
     link). The Care door answering its own "we do not recognise that
     Care link" is the strongest green available: it means the request
     reached the database and came back with an answer.

   NOTHING IS WRITTEN, WHICH IS WHY IT CAN RUN HOURLY. Every request is
   a read or a denial; no row is created, no message is sent, and no
   alert is raised when everything is fine — a daily "all good" is how
   a team learns to ignore the channel.

   Used by:
     · netlify/functions/database-health.js — hourly, with an alert
     · scripts/require-service-key.mjs    — a build gate, at deploy time
   ============================================================ */

/* The same fallback the functions carry, so the probe checks the project
   the deploy actually talks to. */
const DEFAULT_PROJECT = 'https://nihdbhjecdkpvzvjifrm.supabase.co';
const { projectOrigin } = require('./supabase-url.js');

/* A private table under RLS: a credential that is not this project's
   cannot read it, and the rows are settings rather than anybody's
   details. */
const PROBE_PATH = 'finance_config?select=key&limit=1';

/* 32 bytes of base64url, the shape the real link has — long enough that
   the door looks it up rather than answering from the length alone. */
const LINK_SHAPE = 'probe-unknown-link-00000000000000000000';

function hostOf(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function trim(url) {
  return String(url || '').replace(/\/+$/, '');
}

/* ONE byte, so the tampered request is the same shape as the real one
   rather than an empty header some proxy would refuse before any
   credential is examined. */
function tamper(key) {
  const s = String(key || '');
  if (!s) return 'x';
  return (s.slice(0, 1) === 'a' ? 'b' : 'a') + s.slice(1);
}

async function get(url, key) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text };
  } catch (err) {
    return { status: 0, text: '', failed: (err && err.message) || 'the project did not answer' };
  }
}

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text };
  } catch (err) {
    return { status: 0, text: '', failed: (err && err.message) || 'the site did not answer' };
  }
}

/* What one door's answer means. Two doors, deliberately different:

   The Care door's 404 — its own "we do not recognise that Care link"
   — is the best answer there is: the request reached the database and
   came back with a verdict. Its 503 says the deploy cannot reach the
   database at all (missing tables, or a key it cannot use), which is
   a real failure even when the probe's own key works.

   The money door's 503 is NOT a failure: the Care Pass is legitimately
   off sale until an admin publishes the coverage terms, and a probe
   that paged the team for that would be paging them for the product
   working as designed. */
function classifyFinanceDoor(status, text) {
  if (status === 200) return { ok: true, note: 'finance answered with the published terms' };
  if (status === 503 && /not switched on|not on sale/i.test(text)) {
    return { ok: true, note: 'finance answered not-ready — the Care Pass is not on sale yet, which is a product state, not a fault' };
  }
  if (status === 502 || status >= 500) {
    return { ok: false, note: '/api/finance answered ' + status + ' — the money door cannot reach its database' };
  }
  return { ok: false, note: '/api/finance answered ' + status + ' where 200 or a not-ready 503 was expected' };
}

function classifyCareDoor(status, text) {
  if (status === 404 && /do not recognise that care link/i.test(text)) {
    return { ok: true, note: 'the Care door reached the database and did not know the probe link — it is answering' };
  }
  if (status === 503) {
    return { ok: false, note: 'the Care door says it is not switched on while this deploy\'s key works — the door cannot reach the database' };
  }
  if (status === 502) {
    return { ok: false, note: '/api/care-credit answered 502 — the Care door cannot reach its database' };
  }
  if (status === 0) return { ok: false, note: 'the site did not answer at all' };
  return { ok: false, note: '/api/care-credit answered ' + status + ' where its own unknown-link 404 was expected' };
}

/**
 * @param {object} opts
 * @param {string} [opts.project]  Supabase origin (tests override it)
 * @param {string} [opts.key]      the service value this deploy holds — never returned, never logged
 * @param {string} [opts.base]     site origin for the door calls
 * @param {boolean} [opts.sanity]  require the tampered key to be refused (default true)
 * @param {boolean} [opts.doors]   exercise the live doors too (default true)
 * @returns {Promise<{ok: boolean, stage: string, message: string, status?: number}>}
 *          stage: accepts | key | probe | unreachable | door
 */
async function probeDatabase(opts = {}) {
  const project = projectOrigin(opts.project, DEFAULT_PROJECT);
  const base = trim(opts.base || 'https://arzuz.com');
  const key = String(opts.key || '');
  const host = project ? hostOf(project) : 'configured Supabase project';

  if (!project) {
    return { ok: false, stage: 'configuration', message: 'SUPABASE_URL must be the Supabase project HTTPS origin (https://<project-ref>.supabase.co), not a PostgreSQL connection string' };
  }
  if (!key) {
    return { ok: false, stage: 'key', message: 'SUPABASE_SERVICE_ROLE_KEY is not set on this deploy, so no door can write' };
  }

  /* 1. the credential this deployment was built with */
  const read = await get(project + '/rest/v1/' + PROBE_PATH, key);
  if (read.failed) {
    return { ok: false, stage: 'unreachable', message: 'the project did not answer: ' + read.failed };
  }
  if (read.status === 401 || read.status === 403) {
    return {
      ok: false,
      stage: 'key',
      status: read.status,
      message: host + ' REFUSED the service key this deploy holds: ' + read.text.slice(0, 160) +
        '. Every door on the site is answering not-ready to people who cannot fix it.',
    };
  }
  if (read.status >= 500) {
    return { ok: false, stage: 'unreachable', status: read.status, message: host + ' answered ' + read.status + ' — the project has a problem of its own' };
  }

  /* 2. and the probe must be able to see a REFUSAL, or step 1 means nothing */
  if (opts.sanity !== false) {
    const bad = await get(project + '/rest/v1/' + PROBE_PATH, tamper(key));
    if (bad.status !== 401 && bad.status !== 403) {
      return {
        ok: false,
        stage: 'probe',
        status: bad.status,
        message: 'the project accepted a TAMPERED key (' + bad.status + '), so ' + PROBE_PATH +
          ' is readable without a credential — a leak to fix, and this probe cannot report on the key until it is',
      };
    }
  }

  /* 3. the doors a stranger would use */
  if (opts.doors !== false) {
    const finance = await post(base + '/api/finance', { action: 'terms' });
    const money = classifyFinanceDoor(finance.status, finance.text);
    if (!money.ok) return { ok: false, stage: 'door', status: finance.status, message: money.note };

    const care = await post(base + '/api/care-credit', { action: 'view', token: LINK_SHAPE });
    const careNote = classifyCareDoor(care.status, care.text);
    if (!careNote.ok) return { ok: false, stage: 'door', status: care.status, message: careNote.note };

    return {
      ok: true,
      stage: 'accepts',
      message: 'the key is one ' + host + ' accepts (a tampered copy was refused), and both doors reached the database',
    };
  }

  return { ok: true, stage: 'accepts', message: 'the key is one ' + host + ' accepts and a tampered copy was refused' };
}

module.exports = { probeDatabase, classifyFinanceDoor, classifyCareDoor, LINK_SHAPE, PROBE_PATH, DEFAULT_PROJECT };
