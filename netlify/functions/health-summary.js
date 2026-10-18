/* ============================================================
   Arzuz — Netlify Function: the hourly check, as one line
   POST /api/health-summary

   WHY THIS EXISTS

     netlify/functions/database-health.js runs hourly and writes down
     when each credential last passed, so it can announce a recovery.
     That memory had one reader — the probe — which means the only way
     a person could find out whether Paystack still accepts our key
     was to wait for the alert that says it does not.

     The dashboard asks this endpoint instead and prints one line: the
     last accepted hour for each of the three checks, with a stale or
     refused one named as such. The explanation of why each state
     matters is in lib/health-summary.js, which is where the sentence
     is composed — the page prints, it does not decide.

   SCHEDULED FUNCTIONS CANNOT BE ASKED. THIS ONE HAS NO SCHEDULE.

     A Netlify function with a `schedule` answers 403 to every external
     request before its code runs (learned on upload-health, written up
     in database-health.js). So the reads live here, in a plain HTTP
     function, and the probe keeps its own schedule. Neither imports
     the other's handler.

   WHAT IT READS, AND WHAT IT NEVER SAYS

     One row: `finance_config` key `ops_database_health`, through
     lib/health-state.js — the same reader the probe writes with, so
     there is one definition of the marker's shape (including the old
     `last_ok_at` one).

     The row holds timestamps and nothing else: no key, no token, no
     chat id. Nothing is echoed from the environment, and the answer is
     built entirely from dates, so there is nothing here that could
     leak a credential — including when Supabase refuses the read,
     where only the status is reported.

     It also never turns "I could not read the marker" into "all
     clear": that case comes back as a warning with the reason in the
     line. The dashboard has to be able to show a state it cannot
     confirm without pretending the state is good.

   WHO MAY ASK

     Any signed-in member of staff, checked the way the other functions
     check it (care-credit.js liveUser + roleOf) rather than by a
     second implementation of token validation. The line carries no
     student or landlord data, so every role that can hold a dashboard
     login may read it; this is an operator's view, not a privileged
     one.
   ============================================================ */

const { readState } = require('./lib/health-state.js');
const { summarise } = require('./lib/health-summary.js');
const { liveUser, roleOf } = require('./care-credit.js');
const ApiErrors = require('../../assets/api-errors.js');

const SUPABASE_URL_FALLBACK = 'https://nihdbhjecdkpvzvjifrm.supabase.co';

/* The role vocabulary supabase-team-roles.sql issues. An unrecognised
   token role is a refusal here rather than being treated as the main
   admin — this endpoint reads an operator's marker, and a login the
   team cannot name is not one of the team. */
const STAFF = ['admin', 'support', 'finance', 'verification', 'marketing'];

function cfg() {
  const project = (process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || SUPABASE_URL_FALLBACK)
    .replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { project: project, key: key, ready: !!key };
}

function json(status, body, kind) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(ApiErrors.wireBody(status, body, kind)),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'This endpoint only answers a signed-in dashboard.' });
  }

  const headers = event.headers || {};
  const token = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  /* The dashboard holds a session, so a 401 is the one read a person
     can act on: sign in again. A 403 stays a deployment fact. */
  if (!token) return json(401, { error: 'Sign in to the dashboard to read the hourly check.' }, 'expired');

  let user;
  try {
    user = await liveUser(token);
  } catch (err) {
    return json(502, { error: 'Could not verify your session: ' + ((err && err.message) || 'no answer') });
  }
  if (!user) return json(401, { error: 'Your session has expired. Sign in again to read the hourly check.' }, 'expired');

  const role = await roleOf(token);
  if (STAFF.indexOf(role) === -1) {
    console.log('[health-summary] refused role:', role || '(unknown)');
    return json(403, { error: 'This login may not read the hourly check.' });
  }

  const c = cfg();
  if (!c.ready) {
    return json(503, {
      error: 'The hourly check cannot be read on this deploy: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify ' +
        '(Site configuration → Environment variables). The probe is unaffected; only this line is.',
    }, 'not-ready');
  }

  /* readState never throws: a missing table, a refused read and a
     timeout all come back as known:false with a reason. That is the
     whole point — the line must be able to say "cannot be confirmed"
     without the endpoint itself failing. */
  const state = await readState({ project: c.project, key: c.key });
  const summary = summarise(state, new Date());

  if (!state.known) console.log('[health-summary] no marker to read:', state.reason);

  return json(200, {
    ok: true,
    level: summary.level,
    line: summary.line,
    checks: summary.checks,
    graceMinutes: summary.graceMinutes,
    generatedAt: new Date().toISOString(),
  });
};

/* For the suite: the sentence is asserted on its own, and the role
   list is asserted to be the one the team SQL issues. */
exports.STAFF = STAFF;
exports.summarise = summarise;
