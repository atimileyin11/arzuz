/* ============================================================
   Arzuz — Netlify Function: preview tomorrow morning's digest

   roommate-digest.js sends one message a day at 06:00 UTC. Nobody can
   watch that happen, and "what will it say?" is not a question you can
   answer from the dashboard, so this function composes the SAME
   message — through the same collect()/digestText() the scheduled job
   uses, not a copy — and hands it back to a signed-in team member.

   It never sends anything. Nothing here touches Telegram: there is no
   sendAlert import at all, which is the strongest form of that promise
   — a future edit cannot make a preview fire a channel message without
   also adding the import.

   WHO MAY READ IT

     The digest names students and their areas. That is the same data
     supabase-roommate.sql already lets admin and support read, and the
     same data marketing is deliberately kept out of, so the check here
     is that same rule, enforced server-side:

       1. /auth/v1/user proves the JWT is a live Supabase session
          (the anon key is public, so "the token decodes" proves
          nothing — the same reasoning as strategy-docs.js).
       2. POST /rest/v1/rpc/arzuz_role with the caller's OWN token
          returns the role Postgres itself computes from that JWT.
          The dashboard cannot lie about it and cannot pick it.

     Role order matters: the check is done on the server, before any
     read of the roommate tables, so a marketing login never causes a
     single pool row to leave Supabase.

   Rate limited per signed-in user. Each call costs three Supabase
   reads, and a dashboard button is easy to lean on.

   Environment variables: the same three as roommate-digest.js.
   ============================================================ */

const { collect, digestText, worthSending, WINDOW_HOURS, FOLLOW_UP_DAYS } = require('./roommate-digest.js');
const { cfg } = require('./roommate-match.js');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* The two roles supabase-roommate.sql lets read the pool. Marketing is
   absent for the same reason it is absent from every policy there: a
   roommate profile is a phone number plus the answers used to judge a
   person, and the digest is a list of them. */
const ALLOWED = ['admin', 'support'];

const PREVIEW_MAX = 12;
const PREVIEW_WINDOW_MS = 60_000;

/* The shared failure vocabulary — the SAME file the page loads, so the
   class in this body is the class assets/admin.js reads, not a second
   guess at the same status code. */
const ApiErrors = require('../../assets/api-errors.js');

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

/* Per-instance and best-effort, exactly like the ceilings in notify.js:
   a fresh instance starts with an empty window, which is the right
   failure direction for a preview a human is watching. */
const recent = [];
function limited(key) {
  const now = Date.now();
  while (recent.length && now - recent[0].t > PREVIEW_WINDOW_MS) recent.shift();
  const mine = recent.filter((r) => r.key === key);
  if (mine.length >= PREVIEW_MAX) return true;
  recent.push({ key: key, t: now });
  return false;
}

async function liveUser(token) {
  if (!token || token.length < 20) return null;
  try {
    const res = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (err) {
    console.warn('[roommate-digest-preview] token check failed:', err && err.message);
    return null;
  }
}

/* The role Postgres computes for THIS token. Not a claim the browser
   makes, and not something this function decides: public.arzuz_role()
   reads auth.jwt() inside the database, and supabase-team-roles.sql
   grants authenticated EXECUTE on it for exactly this purpose. */
async function roleOf(token) {
  try {
    const res = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/arzuz_role', {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const role = await res.json();
    return typeof role === 'string' ? role.trim().replace(/^"|"$/g, '') : null;
  } catch (err) {
    console.warn('[roommate-digest-preview] role check failed:', err && err.message);
    return null;
  }
}

exports.handler = async function (event) {
  const headers = event.headers || {};
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') {
    return json(405, { error: 'POST the preview request — the session token goes in the header, never in a URL.' });
  }

  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  const user = await liveUser(token);
  if (!user) {
    /* The dashboard holds a session, so a 401 here is a token that went
       stale — the one reading a person can do something about. */
    return json(401, { error: 'Sign in to the Arzuz dashboard to preview the digest.' }, 'expired');
  }

  /* Checked BEFORE any roommate read, so a refused caller cannot make
     this function touch a student row at all. */
  const role = await roleOf(token);
  if (ALLOWED.indexOf(role) === -1) {
    console.log('[roommate-digest-preview] refused role:', role || '(unknown)');
    return json(403, { error: 'Only the admin and support logins may read the roommate digest.' });
  }

  if (limited(user.id)) {
    return json(429, { error: 'That is a lot of previews in a minute — try again shortly.' });
  }

  if (!cfg().ready) {
    /* A 503 that is a DEPLOYMENT FACT, and the same class the roommate
       function itself answers — one condition, one class, both doors. */
    return json(503, {
      error: 'Roommate matching is not switched on yet: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify.',
    }, 'not-ready');
  }

  let model;
  try {
    model = await collect(new Date());
  } catch (err) {
    console.error('[roommate-digest-preview] read failed:', err.message);
    /* A preview reports the failure to the person who asked. It does NOT
       use the scheduled job's Telegram alert: the whole point of the two
       paths being separate is that a human poking a button cannot page
       the team. */
    return json(502, { error: 'Could not read the roommate tables: ' + err.message });
  }

  return json(200, {
    ok: true,
    role: role,
    /* What the 06:00 job would do RIGHT NOW, so "nothing needs
       attention" is visible instead of inferred from an empty list. */
    would_send: worthSending(model),
    quiet_pairs: model.quiet.length,
    half_quiet_pairs: model.half_quiet.length,
    counts: model.counts,
    pool: model.pool,
    window_hours: WINDOW_HOURS,
    stale_days: FOLLOW_UP_DAYS,
    /* The message as Telegram will receive it, HTML tags and entities
       included. The dashboard shows this verbatim; see the note in
       admin.js for why it is not rendered as markup. */
    text: digestText(model),
  });
};

exports.ALLOWED = ALLOWED;
exports.PREVIEW_MAX = PREVIEW_MAX;
exports.roleOf = roleOf;
