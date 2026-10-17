/* ============================================================
   Arzuz — what the dashboard does with REAL PostgREST answers
   Run:  node dev/postgrest-test.js      (part of npm test)

   THE HOLE THIS FILLS

     dev/admin-boot-test.js boots the dashboard against dev/admin-mock.js,
     which answers 401 because someone wrote the number 401. That proves
     the panel handles a denial; it does not prove the platform PRODUCES
     one, or in which class, or with which body — and the dashboard's
     whole session story is a judgement about those classes:

       a 401/403 is a dead session  → clear it and show the gate
       anything else               → keep the session, show an empty list

     So the answers are recorded from the live project instead
     (dev/postgrest-capture.mjs → dev/postgrest-fixture.json), and this
     file replays them, byte for byte, through the REAL assets/admin.js
     in the sandbox the boot suite uses. Nothing here invents a status.

   WHAT THE LIVE PROJECT SAYS (recorded 2026-10-10, re-capturable in a
   minute — and this file follows the recording, it does not assume it)

     - a read whose role has no grant comes back HTTP 401 with the
       Postgres code 42501 (insufficient_privilege) in the body
     - a relation that does not exist comes back HTTP 404 with
       PGRST205 (all four Care relations were in this class when the
       recording was taken)
     - the one public surface (public_listings) and amenities come
       back 200

   The one fact worth stating plainly, because the old comments only
   guessed at it: the denial class on this platform is 401, not 403.
   admin.js folds both in, so it behaves correctly either way — but a
   GRANT that is missing looks exactly like a session that has died,
   and the dashboard cannot tell them apart. That is a real limitation
   of the design, and it is now measured rather than assumed.

   WHICH WORLD THIS RECORDING HOLDS — READ, NEVER ASSUMED

     Whether supabase-care.sql has been applied is a fact about the
     live database, not about this repo, and it can change between two
     runs of this gate. So §3 READS the recording, decides which world
     it was taken in, and asserts what that world means for a student
     link: 503 while the tables are absent, 404 (never 503) once they
     exist. A recording showing one Care relation present and another
     missing is a half-applied migration, and fails the suite loudly
     instead of being read as either world.

     The claim that does NOT depend on the world — that care-credit.js
     still recognises PGRST205 and still routes a student link before
     the role gate — is asserted in both, because a migrated database
     does not make the mapping wrong: it makes it the branch that
     catches the next project, and the one that stops a half-deployed
     site from deleting a student's only key. When the question is
     "is it switched on out there?" rather than "does the code handle
     this?", that is npm run care:live, which asks the live site and
     the live database instead of this recording.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, SCRIPTS, makeSandbox, runScripts, tick } = require('./admin-sandbox.js');

/* The recording is a file, and which file can be pointed somewhere
   else on purpose: §3 asserts behaviour in BOTH Care worlds, and only
   one of them can be recorded at a time. So the other one is replayed
   from a transformed copy of the same recording — the transformation
   and its one assumption are written down in dev/admin-test-report.md.
   Unset, this is the live recording and nothing else. */
const FIXTURE_PATH = process.env.ARZUZ_POSTGREST_FIXTURE ||
  path.join(__dirname, 'postgrest-fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/* ---------------- tiny test runner ---------------- */

let passed = 0;
const failures = [];

async function t(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) {
      passed += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 ' + r);
      console.log('  \u2717 ' + name + '\n      ' + r);
    }
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.stack || err));
  }
}

const relationOf = (p) => String(p).split('?')[0];

/* relation → the recorded answer */
const RECORDED = {};
fixture.responses.forEach((r) => { RECORDED[relationOf(r.path)] = r; });

const nameOf = (label) => String(label).split(' ')[0];

/* ---------------- the session the browser holds ---------------- */

/* The token is the browser's own material, so it is the one thing that
   is stood in for — and it is stood in for honestly: a JWT whose
   app_metadata says admin, exactly the shape GoTrue issues and the mock
   seeds. Everything the dashboard then RECEIVES is recorded. */
function fakeJwt(role) {
  const payload = { sub: 'live-replay', email: 'owner@arzuz.test', app_metadata: { role: role } };
  return 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';
}

function seedSession(sb, role) {
  sb.win.sessionStorage.setItem('arzuz_session_v1', JSON.stringify({
    access_token: fakeJwt(role),
    refresh_token: 'replay-refresh',
    expires_at: Date.now() + 3600 * 1000,
    email: 'owner@arzuz.test'
  }));
}

/* ---------------- the replay ---------------- */

/*
  opts.override  relation → { status, body } to change one recorded
                 answer. The statuses in the default run are all
                 recorded; an override is always labelled at the point
                 it is used.
  opts.rows      relations that should answer 200 with an invented row.
                 Used only for the contrast run, where what is being
                 tested is a STATUS decision and not the data — the
                 statuses still come from the recording.
*/
function replay(sb, opts) {
  opts = opts || {};
  const seen = [];
  const beyond = [];

  function fetch(input, init) {
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const restAt = url.indexOf('/rest/v1/');
    if (restAt === -1) {
      beyond.push(method + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
      return Promise.resolve(new Response(method === 'GET' ? '[]' : '{}', { status: 200 }));
    }
    const rel = relationOf(url.slice(restAt + '/rest/v1/'.length));
    seen.push({ rel: rel, method: method });

    const change = (opts.override || {})[rel];
    if (change) {
      return Promise.resolve(new Response(
        change.body === undefined ? '{}' : JSON.stringify(change.body),
        { status: change.status, headers: { 'Content-Type': 'application/json' } }
      ));
    }
    if (opts.rows && Object.prototype.hasOwnProperty.call(opts.rows, rel)) {
      return Promise.resolve(new Response(JSON.stringify(opts.rows[rel]), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    }
    const rec = RECORDED[rel];
    if (!rec) {
      /* Not in the recording: answer empty-but-ok and notice it. The
         "every read is recorded" check fails if this ever happens for a
         relation the dashboard really asks for. */
      beyond.push(method + ' /rest/v1/' + rel);
      return Promise.resolve(new Response('[]', { status: 200 }));
    }
    return Promise.resolve(new Response(rec.bodyText || '', {
      status: rec.status, headers: { 'Content-Type': 'application/json' }
    }));
  }

  return { fetch: fetch, seen: seen, beyond: beyond };
}

async function boot(opts) {
  const sb = makeSandbox('admin', { fetch: null });
  seedSession(sb, opts.role || 'admin');
  const rp = replay(sb, opts);
  sb.win.fetch = rp.fetch;
  runScripts(sb.ctx, SCRIPTS);
  await tick(260);
  sb.replay = rp;
  return sb;
}

const gateMsg = (sb) => {
  const el = sb.document.getElementById('gateErr');
  return el ? String(el.textContent || '') : '';
};
/* showGate() sets display:flex and writes the reason into gateErr — that
   pair is what the operator sees, and unlike a class name it cannot be
   satisfied by an element that was never touched. */
const gateOpen = (sb) => {
  const g = sb.registry.gateModal;
  if (!g) return false;
  const byDisplay = g.style && g.style.display === 'flex';
  return !!(byDisplay || (g._cl && g._cl.contains('open')));
};
const sessionHeld = (sb) => sb.win.sessionStorage.getItem('arzuz_session_v1') !== null;

/* A row the dashboard can render, for the contrast run only. */
const ROW = [{ id: 'r-1', created_at: '2026-10-01T09:00:00.000Z', session: '2026/2027', env: 'production', status: 'open', notes: '', first_name: 'Replay', phone: '08030000000' }];

const OK_ROWS = {
  demand_records: ROW, listings: ROW, scout_submissions: ROW, booking_requests: ROW,
  support_tickets: ROW, minors_needing_guardian: [], roommate_match_summary: []
};

/* ============================================================ */

async function main() {
  console.log('PostgREST replay \u2014 real recorded answers through the real dashboard\n');
  /* A derived copy is announced, every run, before any check: the one
     way a synthesized world becomes a believed one is a suite that
     renders it without saying which it is. */
  console.log('  recording: ' + fixture.captured_at + '  \u2192  ' + fixture.target +
    (process.env.ARZUZ_POSTGREST_FIXTURE ? '  (from ' + FIXTURE_PATH + ')' : ''));
  if (/DERIVED COPY/.test(fixture.note || '')) {
    console.log('  \u26a0 THIS IS A DERIVED COPY, NOT A RECORDING \u2014 the Care world was flipped on ' +
      'purpose (dev/postgrest-other-world.mjs). Nothing here was measured.');
  }

  /* ---------------- 1. the recording ---------------- */

  console.log('\n1. What the platform was recorded saying\n');

  await t('the fixture declares which it is — a recording, or an announced copy — and how to rebuild', () => {
    if (!fixture.target || fixture.target.indexOf('supabase.co') === -1) return 'no live target recorded';
    if (!fixture.captured_at) return 'no capture time';
    if (/postgrest:capture/.test(fixture.note || '')) return true;
    /* A derived copy must not read like a recording, and must say how to
       rebuild itself. Silence about which it is would be the failure. */
    return /DERIVED COPY/.test(fixture.note || '') && /postgrest-other-world/.test(fixture.note || '')
      ? true
      : 'the fixture says neither how to re-capture a recording nor how to rebuild a derived copy';
  });

  await t('it is a recording, not a stub: the bodies are the platform’s own bytes', () => {
    const denied = fixture.responses.filter((r) => r.status === 401 || r.status === 403);
    if (!denied.length) return 'nothing was denied in the recording';
    const withoutBody = denied.filter((r) => !r.bodyText);
    return withoutBody.length ? 'a denial was recorded with no body: ' + withoutBody[0].label : true;
  });

  await t('every denial carries the Postgres code 42501, not just a status', () => {
    const denied = fixture.responses.filter((r) => r.status === 401 || r.status === 403);
    const missingCode = denied.filter((r) => r.code !== '42501');
    if (missingCode.length) {
      return 'denied without 42501: ' + missingCode.map((r) => r.label + '=' + r.code).join(', ');
    }
    return denied.every((r) => /permission denied/i.test(r.message || ''))
      ? true : 'a denial says something other than permission denied';
  });

  await t('the fatal read comes back in the class the dashboard signs out on', () => {
    const rec = RECORDED.demand_records;
    if (!rec) return 'demand_records was never captured';
    return (rec.status === 401 || rec.status === 403)
      ? true : 'demand_records answered ' + rec.status + ', so nothing here would sign a session out';
  });

  await t('the public surface answers 200 — the contrast the session rule depends on', () => {
    const rec = RECORDED.public_listings;
    if (!rec) return 'public_listings was never captured';
    if (rec.status !== 200) return 'public_listings answered ' + rec.status;
    return rec.bodyKind === 'array' ? true : 'the public read is not an array: ' + rec.bodyKind;
  });

  /* The SHAPE of "missing" rather than the fact of it: whether any
     Care relation is missing is a fact about the live database, and §3
     reads it instead of this. What must never vary is that a missing
     relation arrives as 404 + PGRST205 and not as a bare 404 — the
     difference between a table that has not been created and a request
     that never reached PostgREST. */
  await t('every 404 in the recording is a missing relation carrying PGRST205, never a bare 404', () => {
    const fours = fixture.responses.filter((r) => r.status === 404);
    if (!fours.length) return true;   /* nothing was absent in this recording — §3 names the world */
    const bare = fours.filter((r) => r.code !== 'PGRST205');
    return bare.length
      ? 'a 404 came back without PGRST205: ' + bare.map((r) => r.label + '=' + r.code).join(', ')
      : true;
  });

  await t('the no-op writes were refused — a stolen session cannot touch the ledger', () => {
    const writes = fixture.responses.filter((r) => r.method !== 'GET');
    if (!writes.length) return 'no write was probed';
    const allowed = writes.filter((r) => r.status >= 200 && r.status < 300);
    return allowed.length ? 'a write was ALLOWED: ' + allowed[0].label : true;
  });

  await t('the one request that could create a row is refused or explicitly skipped', () => {
    const forged = fixture.responses.filter((r) => r.method === 'POST' && /care_credit_events/.test(r.path))[0];
    if (!forged) return 'the forged ledger insert is not in the recording at all';
    if (forged.code === 'skipped') {
      return /sql:proof/.test(forged.note || '')
        ? true : 'it was skipped without saying where the claim IS proved';
    }
    return (forged.status === 401 || forged.status === 403 || forged.status === 404)
      ? true : 'a forged ledger row was accepted with HTTP ' + forged.status;
  });

  await t('admin.js folds in BOTH classes the platform is documented to use', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/admin.js'), 'utf8');
    const rule = src.split('\n').filter((l) => /r\.status === 401 \|\| r\.status === 403/.test(l));
    return rule.length >= 3
      ? true : 'the 401/403 session rule appears only ' + rule.length + ' time(s) — one path has been left behind';
  });

  /* ---------------- 2. the replay ---------------- */

  console.log('\n2. The dashboard, reading those answers\n');

  const denied = await boot({ role: 'admin' });

  await t('the recording covers every REST read this dashboard asks for at boot', () => {
    const rest = denied.replay.beyond.filter((u) => u.indexOf('/rest/v1/') !== -1);
    return rest.length ? 'not in the recording: ' + rest.join(', ') : true;
  });

  await t('every read it DOES make is in the recording — nothing was answered from a fallback', () => {
    const uncovered = denied.replay.seen.filter((s) => !RECORDED[s.rel]);
    return uncovered.length ? 'answered by fallback: ' + uncovered.map((s) => s.rel).join(', ') : true;
  });

  await t('a 401 on a table read signs the session out, with the sentence the operator sees', () => {
    if (!gateOpen(denied)) return 'the gate never opened on a 401';
    const msg = gateMsg(denied);
    return /expired/i.test(msg) ? true : 'the gate says: ' + JSON.stringify(msg);
  });

  await t('and the dead token is cleared, so it is not retried on the next click', () =>
    sessionHeld(denied) ? 'the session is still in storage after a 401' : true);

  denied.loc.hash = '#/demand_records';
  await tick(80);

  await t('the table shows its own empty state, not a row from a denied read', () => {
    /* The panel renders a placeholder row for "nothing here", which is
       correct and is NOT a loaded record: what must never appear is a
       data row. So the empty-state marker is the evidence, and a
       colSpan placeholder is counted as empty on purpose. */
    const body = String(denied.document.getElementById('tableBody')._innerHTML || '');
    if (/table-empty/.test(body)) return true;
    return body.indexOf('<tr>') === -1 ? true : 'rows were rendered from a denied read: ' + body.slice(0, 160);
  });

  await t('the console is told what happened, rather than the failure vanishing', () => {
    return denied.consoleErrors.some((line) => /session has expired|Not authorised/i.test(line))
      ? true : 'nothing was logged: ' + JSON.stringify(denied.consoleErrors.slice(0, 3));
  });

  /* The control: the SAME code path, the same recording, one status
     changed. If the sign-out were caused by anything but that status,
     this would not flip it. */
  const control = await boot({
    role: 'admin',
    rows: OK_ROWS,
    override: { demand_records: { status: 200, body: ROW } }
  });

  await t('with that one status changed to 200 the session survives — the status is the cause', () => {
    if (gateOpen(control)) return 'the gate still opened, so something other than the status signed it out';
    return sessionHeld(control) ? true : 'the session was cleared without a denial';
  });

  control.loc.hash = '#/demand_records';
  await tick(80);

  await t('and the rows are rendered, so the dashboard really did load', () => {
    const body = String(control.document.getElementById('tableBody')._innerHTML || '');
    return body.indexOf('<tr>') !== -1 ? true : 'no rows rendered from 200s';
  });

  /* The other class, synthesized because the live platform answers 401
     today: the hardening probe accepts 401|403 and admin.js folds both
     in, so 403 must behave identically. */
  const forbidden = await boot({
    role: 'admin',
    rows: OK_ROWS,
    override: { demand_records: { status: 403, body: { code: '42501', message: 'permission denied for table demand_records' } } }
  });

  await t('a 403 — the other class the platform uses — signs out identically', () => {
    if (!gateOpen(forbidden)) return 'a 403 did NOT sign the operator out';
    return /expired/i.test(gateMsg(forbidden)) ? true : 'the gate said ' + JSON.stringify(gateMsg(forbidden));
  });

  /* The Care read, and the pool read, are the non-fatal kind: they are
     swallowed into an empty list. The Care tables do not exist in
     production, so this is not a hypothetical — it is today. */
  const careMissing = await boot({
    role: 'admin',
    rows: OK_ROWS,
    override: { care_plans_live: { status: 404, body: { code: 'PGRST205', message: "Could not find the table 'public.care_plans_live' in the schema cache" } } }
  });

  await t('a missing Care table does NOT sign anyone out', () => {
    if (gateOpen(careMissing)) return 'the Care read signed the operator out of a working session';
    return sessionHeld(careMissing) ? true : 'the session was cleared by a swallowed read';
  });

  careMissing.loc.hash = '#/care';
  await tick(120);

  await t('and the Care panel says nothing is there yet rather than showing an empty table', () => {
    const panel = String(careMissing.document.getElementById('carePanel')._innerHTML || '');
    if (!panel) return 'the Care panel did not render at all';
    if (panel.indexOf('No Care plans yet') === -1) return 'the panel does not explain the empty state: ' + panel.slice(0, 140);
    return /supabase-care\.sql/.test(panel) ? true : 'the panel does not name the file that is missing';
  });

  await t('the Care panel shows no plan and no balance, because nothing was recorded', () => {
    const panel = String(careMissing.document.getElementById('carePanel')._innerHTML || '');
    if (/call-outs left/.test(panel)) return 'a balance was invented for a plan that does not exist';
    return panel.indexOf('data-care="spend-open"') === -1
      ? true : 'a spend control was offered with no plans to spend on';
  });

  await t('the Roommate pool (also absent live) is swallowed the same way', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/admin.js'), 'utf8');
    const pool = /function fetchRoommatePool/.test(src);
    if (!pool) return 'the pool fetch is gone — this check needs rewriting, not deleting';
    return RECORDED.roommate_profiles && RECORDED.roommate_profiles.status !== 200
      ? true : 'the live pool read is not what this check was written against';
  });

  /* ---------------- 3. what this means for Care ---------------- */

  console.log('\n3. Which world this recording was taken in, and what it means for a link\n');

  /* Read the world out of the recording. A suite that hard-codes "the
     migration has not been applied" turns red the hour it is applied,
     which is the hour it has the least right to be wrong — and the
     temptation then is to delete the check rather than teach it the
     other answer. */
  const CARE_RELATIONS = ['care_plans', 'care_credit_events', 'care_credit_balance', 'care_plans_live'];
  /* The READ of each relation — explicitly, not "whichever request came
     last". The recording also holds a DELETE and a PATCH aimed at
     these relations, and once the tables exist the forged POST is
     recorded as `skipped` rather than as an answer. So the last entry
     for care_credit_events is a note about a request that was never
     sent, and a world decided from it reads a FINISHED migration as
     half-applied. That is not hypothetical: it is what this file did
     until the present-world rehearsal in dev/admin-test-report.md §19
     caught it. */
  const careRows = CARE_RELATIONS.map((rel) => {
    const reads = fixture.responses.filter((r) => r.method === 'GET' && relationOf(r.path) === rel);
    return {
      rel,
      reads: reads.length,
      status: reads.length === 1 ? reads[0].status : null,
      code: reads.length === 1 ? reads[0].code : null
    };
  });
  const careAbsent = careRows.filter((r) => r.code === 'PGRST205');
  const carePresent = careRows.filter((r) => r.status === 401 || r.status === 403);
  const world = careAbsent.length === careRows.length ? 'absent'
    : carePresent.length === careRows.length ? 'present' : 'mixed';

  await t('each Care relation has exactly one recorded READ — the world is read, not guessed', () => {
    const wrong = careRows.filter((r) => r.reads !== 1)
      .map((r) => r.rel + ' has ' + r.reads + ' GETs');
    return wrong.length
      ? wrong.join(', ') + ' — re-capture with npm run postgrest:capture'
      : true;
  });

  await t('and all four are in the SAME world — the migration is not half-applied', () =>
    world === 'mixed'
      ? 'a half-applied migration: ' + careRows.map((r) => r.rel + '=' + (r.code || r.status)).join(', ')
      : true);

  console.log('       this recording says: the Care tables are ' + world.toUpperCase() +
    '  (' + careRows.map((r) => r.rel.split('_').pop() + '=' + (r.code || r.status)).join(' ') + ')');

  await t('a missing table is still mapped to "not switched on" — asserted in BOTH worlds', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/care-credit.js'), 'utf8');
    if (!/function isMissingTable/.test(src)) return 'the missing-table mapping is gone from the function';
    if (!/PGRST205|schema cache/i.test(src)) return 'the function does not recognise the code the platform actually returns';
    /* The branch exists to tell a student their LINK is fine while the
       site is not ready. Without that sentence it is just a 503. */
    return /not switched on/i.test(src)
      ? true : 'the 503 no longer tells the student their link is fine — which is the whole point of the branch';
  });

  await t('the student door runs BEFORE the role gate — a student has no session to offer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/care-credit.js'), 'utf8');
    const door = src.indexOf('STUDENT_ACTIONS.indexOf(action)');
    const gate = src.indexOf('Sign in to the Arzuz dashboard to work with Care credits.');
    if (door === -1) return 'the student branch is gone from the handler';
    if (gate === -1) return 'the role gate is gone — this check needs rewriting, not deleting';
    return door < gate ? true : 'the role gate is reached first, so a student link would be answered 401';
  });

  if (world === 'present') {
    await t('with the tables live, anon is still DENIED on every one of them (42501)', () => {
      const notDenied = careRows.filter((r) => r.status !== 401 && r.status !== 403);
      return notDenied.length
        ? 'readable or unrecognised: ' + notDenied.map((r) => r.rel + '=' + r.status).join(', ')
        : true;
    });

    await t('so a student link is answered 404 for an unknown token — the tables exist, the token does not', () =>
      /do not recognise that Care link/i.test(
        fs.readFileSync(path.join(ROOT, 'netlify/functions/care-credit.js'), 'utf8'))
        ? true : 'the unknown-link sentence is gone, so 404 cannot be told from a wrong link');
  } else if (world === 'absent') {
    await t('and with the tables absent, all four answer PGRST205 — the Care panel is empty, not broken', () =>
      careAbsent.length === careRows.length
        ? true : 'only ' + careAbsent.length + ' of ' + careRows.length + ' are missing');
  }

  /* ------------------------------------------------------------ */

  console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  \u2717 ' + f));
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[postgrest-test] ' + (err && err.stack || err));
  process.exit(1);
});
