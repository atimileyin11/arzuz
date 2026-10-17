#!/usr/bin/env node
/* ============================================================
   Arzuz — capture the REAL PostgREST answers (DEV ONLY, network)

     node dev/postgrest-capture.mjs          (npm run postgrest:capture)

   WHY THIS EXISTS

     scripts/hardening-probe.sh already proves the security model
     against the live API, and dev/sql-proof.mjs already runs every
     supabase-*.sql file against real PostgreSQL. Neither of them
     answers the question the dashboard's error handling rests on:

       when this dashboard's session dies — or loses a grant, or asks
       for a table that has not been created yet — what does the
       platform actually SAY?

     Until now that was reasoned from a comment. admin.js signs the
     user out on 401 or 403 and keeps them signed in on anything else,
     and supabase-care.sql's own check-list claims a denied read comes
     back 401/403 while a missing table comes back 404. Those are facts
     about PostgREST and GoTrue on this project, and this file measures
     them instead of asserting them.

   WHAT IT DOES

     Reads the public URL and anon key out of assets/config.js — the
     same two values every page ships — and asks the live API the same
     URLs the dashboard asks at boot. Then it writes exactly what came
     back to dev/postgrest-fixture.json, which dev/postgrest-test.js
     replays through the REAL admin.js inside a VM.

     The anon key is "a signed-in session that has no grants", which is
     the honest way to reproduce a dead dashboard session from outside
     the platform: PostgREST cannot tell the difference between a token
     whose role has no privileges and a token that has stopped being
     accepted, and for the purposes of this test that is the point.

   WHAT IT WRITES TO THE DATABASE: nothing.

     Every request is either a read, or a write aimed at an id that
     cannot exist (id=eq.<nil uuid>, id=eq.-1), so even a write the
     platform wrongly allowed would change no row. The one request that
     COULD create a row — a forged ledger insert — is skipped while the
     Care tables exist, and the reason is recorded in the fixture. That
     claim (no client role may insert into the ledger) is asserted
     against real Postgres by npm run sql:proof instead.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- the public config ---------------- */

const configText = readFileSync(join(ROOT, 'assets/config.js'), 'utf8');
const url = (/SUPABASE_URL:\s*'([^']+)'/.exec(configText) || [])[1];
const anon = (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(configText) || [])[1];
if (!url || !anon) {
  console.error('assets/config.js has no SUPABASE_URL / SUPABASE_ANON_KEY to probe with.');
  process.exit(1);
}
const BASE = url.replace(/\/+$/, '');
const NIL = '00000000-0000-0000-0000-000000000000';

/* ---------------- what the dashboard asks ---------------- */

/*
  `fatal` is not a property of the response, it is a property of the
  request: these are the reads admin.js treats as a dead session when
  they come back 401/403 (fetchData throws { auth: true } and the gate
  is shown). The ones marked non-fatal are the reads whose failure is
  swallowed into an empty list — the Roommate pool, the Care plans,
  the metrics. The fixture records both so the replay can assert that
  the dashboard really does treat them differently.
*/
const READS = [
  { label: 'demand_records (a table the dashboard treats as fatal)', path: 'demand_records?select=*&order=created_at.desc', fatal: true },
  { label: 'listings', path: 'listings?select=*&order=created_at.desc', fatal: true },
  { label: 'scout_submissions', path: 'scout_submissions?select=*&order=created_at.desc', fatal: true },
  { label: 'booking_requests', path: 'booking_requests?select=*&order=created_at.desc', fatal: true },
  { label: 'support_tickets', path: 'support_tickets?select=*&order=created_at.desc', fatal: false },
  { label: 'minors_needing_guardian (the safeguarding view)', path: 'minors_needing_guardian?select=*', fatal: false },
  { label: 'roommate_match_summary (admin metric)', path: 'roommate_match_summary?select=*', fatal: false },
  { label: 'growth_roommate_summary (its non-admin twin)', path: 'growth_roommate_summary?select=*', fatal: false },
  { label: 'care_plans_live (what the Care panel reads)', path: 'care_plans_live?select=*&env=eq.production&order=created_at.desc&limit=200', fatal: false },
  /* The other two relations supabase-care.sql creates, recorded here
     because the recording is also what §3 of dev/postgrest-test.js
     reads to decide WHICH WORLD it was taken in — and a world decided
     from one relation out of four cannot tell a half-applied
     migration from a finished one. Neither is a dashboard-boot read:
     care_plans is the row behind a link and care_credit_balance is
     what a student's balance is read from (care-credit.js), both with
     the service key. `fatal: false` on purpose — the capture makes no
     class claim about these two, it records them, and the replay is
     where their class is asserted (present world: 401 + 42501;
     absent: 404 + PGRST205). */
  { label: 'care_plans (the row behind a Care link)', path: 'care_plans?select=id&limit=1', fatal: false },
  { label: 'care_credit_events (the ledger itself)', path: 'care_credit_events?select=id&limit=1', fatal: false },
  { label: 'care_credit_balance (what a balance is read from)', path: 'care_credit_balance?select=balance,granted,call_outs&limit=1', fatal: false },
  { label: 'roommate_profiles (the questionnaire pool)', path: 'roommate_profiles?select=*', fatal: false },
  { label: 'roommate_interests', path: 'roommate_interests?select=*', fatal: false },
  { label: 'roommate_events (the consent trail)', path: 'roommate_events?select=*', fatal: false },
  { label: 'roommate_engine_summary (the pool metric)', path: 'roommate_engine_summary?select=*', fatal: false },
  { label: 'roommate_mutual_pairs', path: 'roommate_mutual_pairs?select=*&order=matched_at.desc', fatal: false },
  { label: 'public_listings (the ONE public read surface)', path: 'public_listings?select=*&limit=5', fatal: null },
  { label: 'amenities', path: 'amenities?select=*&limit=3', fatal: null }
];

/* Writes that cannot change a row, whatever the answer: both aim at an
   id that does not exist. They exist because "can a stolen dashboard
   session erase the Care ledger?" is answered by the status code. */
const WRITES = [
  { label: 'DELETE care_credit_events (an id that cannot exist)', method: 'DELETE', path: 'care_credit_events?id=eq.-1' },
  { label: 'PATCH care_plans → refunded (a plan that cannot exist)', method: 'PATCH', path: 'care_plans?id=eq.' + NIL, body: JSON.stringify({ status: 'refunded' }) }
];

/* ---------------- one request ---------------- */

async function ask(req, extraHeaders) {
  const init = {
    method: req.method || 'GET',
    headers: Object.assign({
      apikey: anon,
      Authorization: 'Bearer ' + anon,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    }, extraHeaders || {}),
    signal: AbortSignal.timeout(15000)
  };
  if (req.body) init.body = req.body;

  const out = {
    label: req.label,
    method: init.method,
    path: req.path,
    fatal: req.fatal === undefined ? null : req.fatal,
    status: null,
    code: null,
    message: null,
    bodyKind: 'none',
    bodyText: '',
    server: null,
    note: req.note || null
  };

  /* One retry on a transport failure only. A network that drops one
     request must not turn into a permanent hole in the recording — and
     a retry here is safe in a way it is not for a write, because every
     request in this file is a read or is aimed at an id that cannot
     exist. */
  let attempt = 0;
  try {
    let res;
    for (;;) {
      attempt += 1;
      try {
        res = await fetch(BASE + '/rest/v1/' + req.path, init);
        break;
      } catch (netErr) {
        if (attempt >= 3) throw netErr;
        await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
    out.status = res.status;
    if (attempt > 1) out.attempts = attempt;
    out.server = res.headers.get('server') || null;
    const text = await res.text();
    out.bodyText = text.slice(0, 4000);
    if (text) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      if (Array.isArray(parsed)) out.bodyKind = 'array';
      else if (parsed && typeof parsed === 'object') out.bodyKind = 'object';
      else out.bodyKind = typeof parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.code = parsed.code || null;
        out.message = String(parsed.message || '').slice(0, 300) || null;
      }
    } else {
      out.bodyKind = 'empty';
    }
  } catch (err) {
    out.status = 0;
    out.message = 'the request itself failed: ' + (err && err.message);
  }
  return out;
}

/* ---------------- run ---------------- */

console.log('Arzuz — capturing the live PostgREST answers');
console.log(BASE);
console.log('\nReads (as the anon key: an accepted JWT with no grants)\n');

const responses = [];
for (const req of READS) {
  const r = await ask(req);
  responses.push(r);
  console.log('  ' + String(r.status).padStart(3) + '  ' + (r.code || '—').padEnd(8) +
    ' ' + r.label + (r.message ? '\n         ' + r.message.slice(0, 110) : ''));
}

console.log('\nWrites that cannot change a row\n');
for (const req of WRITES) {
  const r = await ask(req);
  responses.push(r);
  console.log('  ' + String(r.status).padStart(3) + '  ' + (r.code || '—').padEnd(8) + ' ' + r.label);
}

/* The forged ledger insert is the one request that would create data if
   the platform were broken in the direction this test is looking for,
   so it is only sent when the table does not exist. */
const careEventsExists = responses.some((r) => r.path.indexOf('care_credit_events') === 0 && r.status !== 404);
if (careEventsExists) {
  responses.push({
    label: 'POST care_credit_events (a forged ledger row)',
    method: 'POST',
    path: 'care_credit_events',
    fatal: null,
    status: null,
    code: 'skipped',
    message: 'not sent',
    bodyKind: 'none',
    bodyText: '',
    server: null,
    note: 'Skipped on purpose: the table exists, so a forged insert that the platform ' +
      'wrongly allowed would be a real row in the Care ledger. The claim it would test ' +
      '(no client role may insert) is asserted against real PostgreSQL by npm run sql:proof, ' +
      'which revokes the privilege and proves the refusal with 42501.'
  });
  console.log('\n  —   skipped  POST care_credit_events (a forged ledger row)');
  console.log('         the table exists, so this would be a production write if the platform were wrong.');
} else {
  const forged = await ask({
    label: 'POST care_credit_events (a forged ledger row)',
    method: 'POST',
    path: 'care_credit_events',
    body: JSON.stringify({ plan_id: NIL, event: 'granted', delta: 4 })
  });
  responses.push(forged);
  console.log('  ' + String(forged.status).padStart(3) + '  ' + (forged.code || '—').padEnd(8) +
    ' ' + forged.label);
}

const fixture = {
  captured_at: new Date().toISOString(),
  target: BASE,
  probed_as: 'anon — the public key, which the platform accepts as a JWT with no grants',
  note: 'Recorded answers, byte for byte, for dev/postgrest-test.js to replay through the real ' +
    'admin.js. Re-capture with: npm run postgrest:capture',
  responses: responses
};

const out = join(ROOT, 'dev/postgrest-fixture.json');
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');

/* ---------------- what the capture concluded ---------------- */

const denied = responses.filter((r) => r.status === 401 || r.status === 403);
const withSqlstate = denied.filter((r) => r.code === '42501');
const missing = responses.filter((r) => r.code === 'PGRST205');
const publicReads = responses.filter((r) => r.fatal === null && r.method === 'GET');

console.log('\n' + '='.repeat(66));
console.log('WHAT THE PLATFORM ACTUALLY SAYS');
console.log('='.repeat(66));
console.log('  denied reads/writes      : ' + denied.length +
  (denied.length ? ' — all ' + (withSqlstate.length === denied.length ? 'carrying' : 'MOSTLY carrying') +
    ' the Postgres code 42501 (insufficient_privilege)' : ''));
console.log('  relations that are absent: ' + missing.length +
  (missing.length ? ' — HTTP ' + [...new Set(missing.map((r) => r.status))].join('/') + ' + PGRST205' : ''));
console.log('  the public read surface  : ' +
  publicReads.map((r) => r.label.split(' ')[0] + '=' + r.status).join(', '));
console.log('  writes that cannot change a row: ' +
  responses.filter((r) => r.method !== 'GET')
    .map((r) => r.method + '=' + r.status + (r.code ? ' ' + r.code : '')).join(', '));
console.log('\n  written to dev/postgrest-fixture.json');

const wrong = responses.filter((r) => {
  if (r.fatal === true) return !(r.status === 401 || r.status === 403 || r.status === 404);
  if (r.fatal === null && r.method === 'GET') return r.status !== 200;
  if (r.method !== 'GET') return !(r.status === 401 || r.status === 403 || r.status === 404);
  return false;
});
if (wrong.length) {
  console.log('\n  These came back in a class this project does not expect:');
  wrong.forEach((r) => console.log('   - ' + r.label + ' → HTTP ' + r.status + ' ' + (r.code || '')));
  process.exit(1);
}
console.log('  every answer is in an expected class \u2713');
