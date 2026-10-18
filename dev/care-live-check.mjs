#!/usr/bin/env node
/* ============================================================
   Arzuz — is Care actually switched on, out there? (DEV ONLY)

     npm run care:live                        ask the live site + database
     npm run care:live -- --capture           re-record once it is green
     npm run test:care-live                   the verdicts, offline (gate)

   WHY THIS EXISTS

     "Care works" is three separate claims, each of which fails on its
     own layer, in its own way, with its own message:

       1. the migration landed   supabase-care.sql was run against the
                                 live database, so care_plans and its
                                 three siblings exist and anon is DENIED
                                 on all four
       2. the door is deployed   netlify/functions/care-credit.js is on
                                 the site and holds a service key, so a
                                 student link is answered by the Care
                                 code rather than by the 404 page
       3. the page is deployed   my-care.html is served

     All three of those can be true of a laptop and false in
     production at the same time — which is exactly what happened
     here: the tables have never been created and care-credit has
     never been deployed, while every local suite passes. A local
     suite cannot see the difference, and neither can a person
     reading a diff. So this asks the live surfaces and names the
     layer that is missing, instead of reporting one flat failure.

   WHAT IT TOUCHES

     Reads, plus one read-shaped request: `view` only. `view` cannot
     move a credit and cannot create a ticket — 'view' and 'request'
     are the student's two actions and only 'request' writes — so
     nothing here calls it. The anon key it probes with is the one in
     assets/config.js, public by design; the token is 43 characters of
     'A', long enough to pass the length gate and impossible to
     collide with a real one. That is the honest way to ask "does the
     door answer at all?"

   WHAT A PASS MEANS, AND WHAT IT DOES NOT

     404 + LINK_UNKNOWN is a PASS and it is not a login: it says the
     function ran, reached the database, found no such plan and told
     the student so. It cannot prove a REAL link works — only a real
     grant can, and a grant needs the service key and a signed-in
     team member. What it does prove is the whole chain underneath:
     deployed, configured, migrated, answering.

   WHY THE VERDICTS ARE SPLIT OUT OF THE FETCHING

     The live site is currently red on all three gates, so the live
     run never exercises the branch that matters most — the one that
     says "yes". `--self-test` feeds the classifiers recorded answers
     and synthesised ones, including the pass, so the day it goes
     green it is a verdict that has been run before rather than one
     written this morning. It needs no network, so it runs in the
     gate; the live run needs the internet, so it does not.
   ============================================================ */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const SELF_TEST = args.indexOf('--self-test') !== -1;
const CAPTURE = args.indexOf('--capture') !== -1;
const baseArg = (args.find((a) => a.startsWith('--base=')) || '').slice(7);
const BASE = (baseArg || process.env.ARZUZ_BASE_URL || 'https://arzuz.com').replace(/\/+$/, '');
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);

/* ============================================================
   1. The verdicts — pure, so they can be run without a network
   ============================================================ */

/* The four relations supabase-care.sql creates: two tables and two
   views. If any one is absent the migration did not finish — a
   half-applied file is its own failure, reported as one. */
const CARE_RELATIONS = ['care_plans', 'care_credit_events', 'care_credit_balance', 'care_plans_live'];

/* The Care page's own element. A soft 404 that answers 200 does not
   contain it, and a 404 page never does. */
const PAGE_MARKER = /id="careAccount"/;

/*
  What the public key should get from a Care relation.

    exists-denied   401/403 + 42501. The CORRECT state: the relation
                    exists and the public key has no grant on it,
                    which is the whole design — this is where the
                    ledger with a student's phone number in it lives.
    missing         404 + PGRST205: PostgREST has no such relation in
                    its schema cache, so the migration has not run.
    PUBLICLY READABLE  200 to the anon key. Not a missing migration —
                    a data leak, and the loudest thing this file can
                    print.
    unexpected      anything else. A 404 WITHOUT PGRST205 is not a
                    missing table, it is a request that never reached
                    PostgREST; a 5xx is the database being unwell.
                    Lumping those in with "missing" would send
                    somebody to the SQL Editor for nothing.
*/
function classifyRelation(status, code) {
  if (status === 404 && code === 'PGRST205') return 'missing';
  if ((status === 401 || status === 403)) return 'exists-denied';
  if (status === 200) return 'PUBLICLY READABLE';
  return 'unexpected ' + status + (code ? ' ' + code : '');
}
const relationIsGood = (state) => state === 'exists-denied';

/*
  What the deployed student door answers. Order matters, and it is the
  order of the failure: a page instead of JSON means the function is
  not on this deploy at all, which is a different repair from a
  function that is on the site but has no key.

  Every branch below was OBSERVED against this project — the 404 page
  at /api/care-credit, the two 503s' sentences and PGRST205 — except
  'answering', which is the branch that cannot be observed while the
  tables are missing. That one is synthesised in the self-test and
  labelled there.
*/
function classifyDoor(status, type, message) {
  if (/text\/html/i.test(type)) {
    return {
      state: 'not-deployed',
      ok: false,
      why: 'the site answered with a page, not the function — /api/care-credit is not on this deploy'
    };
  }
  const msg = String(message || '');
  if (status === 503 && /SERVICE_ROLE_KEY/i.test(msg)) {
    return {
      state: 'no-service-key',
      ok: false,
      why: 'deployed, but SUPABASE_SERVICE_ROLE_KEY is not set in Netlify — the function cannot reach the database at all'
    };
  }
  if (status === 503 && /not switched on/i.test(msg)) {
    /* TWO causes answer this sentence, and the door cannot say which
       one it is: the Care tables are missing (gate 1 above settles
       that), or the key this deploy was BUILT with is being refused by
       Supabase \u2014 a rotated key, an anon key in the service slot, or
       a variable added without a redeploy. The state name is kept for
       the self-test's sake; the why must not pick one. */
    return {
      state: 'no-tables',
      ok: false,
      why: 'deployed, but the door says it is not switched on \u2014 the Care tables are missing, '
        + 'or the service key this deploy holds is absent or refused (gate 1 above says which)'
    };
  }
  if (status === 404 && /do not recognise that Care link/i.test(msg)) {
    return {
      state: 'answering',
      ok: true,
      why: 'the door ran, reached the database, and said it does not know this token'
    };
  }
  if (status === 429) {
    return { state: 'metered', ok: false, why: 'rate-limited — this probe has been run too often in the last minute' };
  }
  if (status === 401 || status === 403) {
    return {
      state: 'behind-the-gate',
      ok: false,
      why: 'the student door answered ' + status + ' — a student has no session, so view/request must run BEFORE the role gate'
    };
  }
  return { state: 'unexpected ' + status, ok: false, why: msg.slice(0, 200) || 'no body' };
}

function classifyPage(status, text) {
  if (status !== 200) return { state: String(status), ok: false, why: 'my-care.html is not being served' };
  return PAGE_MARKER.test(text)
    ? { state: 'served', ok: true, why: 'the student page is live' }
    : { state: 'wrong-content', ok: false, why: 'something answered 200 at /my-care.html but it is not the Care page' };
}

/* ============================================================
   2. --self-test — every verdict, including the one that says yes
   ============================================================ */

function selfTest() {
  let passed = 0;
  const failures = [];

  const is = (name, actual, expected) => {
    if (actual === expected) {
      passed += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
      console.log('  \u2717 ' + name + '\n      expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  };

  console.log('Care-live verdicts \u2014 offline, no network\n');
  console.log('1. A Care relation, as the public key sees it  (recorded live 2026-10-10)\n');

  is('404 + PGRST205 is a missing relation, not a denial', classifyRelation(404, 'PGRST205'), 'missing');
  is('401 + 42501 is the relation existing with no grant — the CORRECT state',
    classifyRelation(401, '42501'), 'exists-denied');
  is('403 + 42501 reads the same, because the platform uses both classes',
    classifyRelation(403, '42501'), 'exists-denied');
  is('200 to the public key is a leak, never a success', classifyRelation(200, null), 'PUBLICLY READABLE');
  is('a 404 WITHOUT PGRST205 is not a missing table (the request never reached PostgREST)',
    classifyRelation(404, null), 'unexpected 404');
  is('a 5xx is not a missing table either', classifyRelation(500, null), 'unexpected 500');
  is('only exists-denied counts as good for a relation', [relationIsGood('exists-denied'),
    relationIsGood('missing'), relationIsGood('PUBLICLY READABLE'), relationIsGood('unexpected 500')].join(','),
  'true,false,false,false');

  console.log('\n2. The student door\u2019s answer  (the 404 page and both 503 sentences recorded live)\n');

  const linkUnknown = 'We do not recognise that Care link. Open it exactly as it arrived — if you think it is wrong, ' +
    'message us on WhatsApp and we will find your plan.';

  is('the 404 page is "not deployed", not a verdict about the link',
    classifyDoor(404, 'text/html; charset=utf-8', '<!DOCTYPE html>').state, 'not-deployed');
  is('a 503 about SERVICE_ROLE_KEY is "no key", not "no tables"',
    classifyDoor(503, 'application/json', 'Care credits need SUPABASE_SERVICE_ROLE_KEY in Netlify before they can write anything.').state,
    'no-service-key');
  is('a 503 about the tables points back at gate 1 and at the key',
    classifyDoor(503, 'application/json', 'Care is not switched on for this site yet. Nothing is wrong with your link — message us on WhatsApp and we will sort it out.').state,
    'no-tables');
  is('404 + the function\u2019s own sentence is the PASS — the door answered',
    classifyDoor(404, 'application/json', linkUnknown).state, 'answering');
  is('and a pass is a pass', classifyDoor(404, 'application/json', linkUnknown).ok, true);
  is('HTML wins over the status, because the status is the 404 page\u2019s',
    classifyDoor(404, 'text/html', linkUnknown).state, 'not-deployed');
  is('429 is metering, not a broken link', classifyDoor(429, 'application/json', 'a lot of Care requests in a minute').state, 'metered');
  is('a student action answered 401+ places it behind the gate — it must not be',
    classifyDoor(401, 'application/json', 'Sign in to the Arzuz dashboard.').state, 'behind-the-gate');
  /* It used to be described here as "key and tables are fine" \u2014 it is
     not. A refused credential answers the not-ready 503 now, so a 502
     is a failure this check has no verdict for, and saying it cleared
     the key is how a stale key in Netlify was read as a stale deploy. */
  is('a 502 is an unknown failure, not a verdict that the key is fine',
    classifyDoor(502, 'application/json', 'Care could not open your Care account just now.').state, 'unexpected 502');
  is('nothing but answering is a pass',
    [classifyDoor(404, 'text/html', '').ok, classifyDoor(503, 'application/json', 'SERVICE_ROLE_KEY').ok,
      classifyDoor(503, 'application/json', 'not switched on').ok, classifyDoor(404, 'application/json', linkUnknown).ok].join(','),
    'false,false,false,true');

  console.log('\n3. The student page\n');

  is('the page\u2019s own element at 200 is served', classifyPage(200, '<div id="careAccount" style="display:none">').state, 'served');
  is('a 200 that is not the page is not served', classifyPage(200, '<h1>Nothing here</h1>').state, 'wrong-content');
  is('a 404 is a 404', classifyPage(404, '').state, '404');

  console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  \u2717 ' + f));
  }
  process.exit(failures.length ? 1 : 0);
}

if (SELF_TEST) selfTest();

/* ============================================================
   3. The live run
   ============================================================ */

const configText = readFileSync(join(ROOT, 'assets/config.js'), 'utf8');
const supaUrl = (/SUPABASE_URL:\s*'([^']+)'/.exec(configText) || [])[1];
const anonKey = (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(configText) || [])[1];
if (!supaUrl || !anonKey) {
  console.error('assets/config.js has no SUPABASE_URL / SUPABASE_ANON_KEY to probe with.');
  process.exit(1);
}
const SUPA = supaUrl.replace(/\/+$/, '');

/* Not a real token, and not shaped like one: 43 'A's is inside the
   20..200 length gate, so the function looks it up, and no hash of it
   can be in the table. */
const BOGUS_TOKEN = 'A'.repeat(43);

async function ask(url, init) {
  try {
    const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(20000) }, init));
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
    return { status: res.status, type: res.headers.get('content-type') || '', text, parsed, err: null };
  } catch (err) {
    return { status: 0, type: '', text: '', parsed: null, err: (err && err.message) || String(err) };
  }
}

async function checkMigration() {
  const rows = [];
  for (const rel of CARE_RELATIONS) {
    const res = await ask(SUPA + '/rest/v1/' + rel + '?select=*&limit=1', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey }
    });
    const code = res.parsed && res.parsed.code ? res.parsed.code : null;
    rows.push({
      rel,
      status: res.status,
      code,
      err: res.err,
      state: res.err ? 'unreachable' : classifyRelation(res.status, code)
    });
  }
  return {
    rows,
    missing: rows.filter((r) => r.state === 'missing'),
    leaky: rows.filter((r) => r.state === 'PUBLICLY READABLE'),
    odd: rows.filter((r) => !relationIsGood(r.state) && r.state !== 'missing' && r.state !== 'PUBLICLY READABLE'),
    ok: rows.every((r) => relationIsGood(r.state))
  };
}

async function checkDoor() {
  const res = await ask(BASE + '/api/care-credit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'view', token: BOGUS_TOKEN })
  });
  if (res.err) return { state: 'unreachable', ok: false, why: res.err };
  return classifyDoor(res.status, res.type, (res.parsed && res.parsed.error) || res.text);
}

async function checkPage() {
  const res = await ask(BASE + '/my-care.html');
  if (res.err) return { state: 'unreachable', ok: false, why: res.err };
  return classifyPage(res.status, res.text);
}

console.log('Arzuz — is Care switched on out there?');
console.log('  site     : ' + BASE + (LOCAL ? '  (local — not the deployed site)' : ''));
console.log('  database : ' + SUPA);
console.log('');

const migration = await checkMigration();
const door = await checkDoor();
const page = await checkPage();

console.log('1. The migration — supabase-care.sql has run on the live database');
for (const r of migration.rows) {
  const mark = relationIsGood(r.state) ? '\u2713' : '\u2717';
  console.log('   [' + mark + '] ' + r.rel.padEnd(20) + ' ' +
    String(r.status).padStart(3) + ' ' + (r.code || '\u2014').padEnd(9) + r.state);
}
console.log('       anon must be DENIED on all four: that ledger holds a student\u2019s phone number.');
if (migration.leaky.length) {
  console.log('       !! ' + migration.leaky.map((r) => r.rel).join(', ') +
    ' answered 200 to the public key — a data leak, not a missing migration.');
}
if (migration.odd.length) {
  console.log('       ?? ' + migration.odd.map((r) => r.rel + '=' + r.state).join(', ') +
    ' — not the missing-table class; check the network and the project before running any SQL.');
}

console.log('\n2. The student\u2019s door — /api/care-credit answers a link');
console.log('   [' + (door.ok ? '\u2713' : '\u2717') + '] ' + door.state + ' — ' + door.why);

console.log('\n3. The student\u2019s page — /my-care.html is served');
console.log('   [' + (page.ok ? '\u2713' : '\u2717') + '] ' + page.state + ' — ' + page.why);

const green = migration.ok && door.ok && page.ok;

console.log('\n' + '='.repeat(66));
console.log(green ? 'CARE IS LIVE: all three layers answer.' : 'CARE IS NOT LIVE YET.');
console.log('='.repeat(66));

if (!green) {
  console.log('\n  What is missing, in the order it has to happen:\n');
  if (!migration.ok) {
    console.log('  1. Run supabase-care.sql against the live database.');
    console.log('     Supabase \u2192 SQL Editor \u2192 New query \u2192 paste the whole file \u2192 Run.');
    console.log('     (A service key cannot do this: PostgREST does not expose DDL. The SQL');
    console.log('      Editor, a direct connection, or the Management API are the only doors.)');
    console.log('     Then re-run this check — gate 2\u2019s message changes when it lands.');
  }
  if (migration.ok && !door.ok && (door.state === 'no-service-key' || door.state === 'no-tables')) {
    /* Gate 1 has just proved every relation exists, so "not switched on"
       here is the deploy's OWN CREDENTIAL: absent, refused, or added
       without a deploy (functions only see a variable that existed when
       they were built). The repair is the variable and a redeploy \u2014
       deploying the same function again with the same key changes
       nothing, which is the loop this tool used to send people into. */
    console.log('  2. Fix the Supabase credential this deploy holds:');
    console.log('     Netlify \u2192 Environment variables \u2192 SUPABASE_SERVICE_ROLE_KEY (and check');
    console.log('     SUPABASE_URL), then REDEPLOY \u2014 a variable added without a deploy is');
    console.log('     not in the running function.');
  } else if (migration.ok && !door.ok) {
    console.log('  2. Deploy netlify/functions/care-credit.js to the site.');
  }
  if (migration.ok && door.ok && !page.ok) {
    console.log('  3. Deploy my-care.html — the door answers but the page is not served.');
  }
  console.log('\n  No local suite can see any of this: they all pass while every layer above is absent.');
} else {
  console.log('\n  The chain under the token is proved: deployed, configured, migrated, answering.');
  console.log('  A REAL link is still unproved — that needs a real grant, and a grant needs');
  console.log('  the service key and a signed-in team member.');
  if (CAPTURE) {
    console.log('\n  Re-recording the PostgREST fixture against this world \u2026');
    for (const [label, script] of [['capture', 'dev/postgrest-capture.mjs'], ['replay', 'dev/postgrest-test.js']]) {
      const out = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
      console.log('  ' + label + ' exited ' + out.status);
      if (out.status !== 0) process.exit(1);
    }
    console.log('\n  Fixture re-recorded; the replay above is the authority on what it now says.');
  } else {
    console.log('\n  Next: npm run postgrest:capture  — re-record what this world answers,');
    console.log('        then npm test. The replay reads the recording, so it follows along.');
    console.log('        (or: npm run care:live -- --capture)');
  }
}

process.exit(green ? 0 : 1);
