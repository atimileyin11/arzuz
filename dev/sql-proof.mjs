#!/usr/bin/env node
/* ============================================================
   Arzuz — proof that the SQL actually runs

   WHAT THIS IS

     Every supabase-*.sql file is written to be pasted into the
     Supabase SQL editor, and until now none of them had ever been
     executed anywhere: there is no psql, no server and no Docker in
     this workspace, so the whole schema — including the append-only
     consent trail and the role model the dashboard's security rests
     on — was desk-checked by reading it.

     This runs them. The engine is PGlite, which is real PostgreSQL
     compiled to WebAssembly — PostgreSQL 18.3 — not a SQL parser and
     not a mock, so `create policy`, `security_invoker` views,
     generated columns, CHECK constraints and RLS itself behave the
     way they behave on Supabase. A statement that this accepts has
     been executed by Postgres.

   WHAT THIS IS NOT

     It is not Supabase. Supabase supplies four things these files
     depend on, and bootstrap() below builds a faithful STAND-IN
     for each, at the same names and with the same contract:

       - the roles anon / authenticated / service_role,
       - the `auth` schema with auth.uid() / auth.jwt() / auth.role(),
       - Supabase's default privileges (ALL on every new public table
         to anon, authenticated AND service_role — which is exactly why
         the files spend so many lines revoking it, and exactly why the
         waitlist door's service-role insert works after they have),
         a JWT, as `request.jwt.claims`, which is how GoTrue hands
         the token to Postgres.

     The stand-in is the harness's, not Supabase's, so a policy that
     passes here has been proved against real RLS and a stand-in JWT.
     Nothing else about Supabase is simulated: no REST layer, no
     PostgREST, no Postgres version differences beyond 18.3.

   WHAT IT CHECKS, IN ORDER

     1. the sixteen files apply, in the order they have to be applied in
     2. they apply AGAIN, changing nothing (the upgrade path)
     3. the objects exist, with RLS on and the right grants
     4. the security claims hold under `set role`:
          anon cannot read the pool, marketing reads zero rows,
          support and admin read rows, and no client role can write
          history into the append-only trail
     5. arzuz_role() answers per JWT — including the branch that
        matters: no JWT at all must not be 'admin'
     6. the behaviour the app relies on: the widened 'viewed' CHECK,
        the guarded budget cast, one row per decision, the metric

   Run it:  npm run sql:proof        (or: node dev/sql-proof.mjs)
   ============================================================ */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The order is not alphabetical, and it is the point.

   supabase-team-roles.sql states its own prerequisites in a preflight
   that raises before touching anything, and supabase-roommate.sql
   refuses to build its policies unless public.arzuz_role() already
   exists — so team-roles must sit between the files that create the
   tables it secures and the file whose policies are scoped by it.
   Getting this order wrong is the single easiest way to end up with
   a half-built database, which is why it is asserted here rather than
   trusted. */
const FILES = [
  'supabase-schema.sql',         // the six shared tables, the base views
  'supabase-hardening.sql',      // generated pricing/label columns on listings,
                                 // amenities, and the four reporting views again
  'supabase-listings-updated-at.sql', // the edit stamp + its trigger; before
                                 // the view below, which now exposes it
  'supabase-location.sql',       // coordinates on listings
  'supabase-public-view.sql',    // the anon-readable public_listings surface
  'supabase-media-booking.sql',  // booking_requests + roommate_match_summary
  'supabase-drafts-support.sql', // draft invite links on listings, and support_tickets
  'supabase-draft-sharing.sql',  // REPLACES the two draft RPCs — its own header says
                                 // it builds on drafts-support, and it reads
                                 // listings.draft_completed_at, which only the file
                                 // above creates. Reversed, this fails outright.
  'supabase-team-roles.sql',     // arzuz_role() + a policy set per role
  'supabase-roommate.sql',       // needs arzuz_role(); the consent trail
  'supabase-care.sql',           // also needs arzuz_role(): the Care credit ledger
  'supabase-finance.sql',        // extends care_plans with the coverage
                                 // columns and needs arzuz_role() for its policies
  'supabase-claims.sql',         // a claim spends a call-out, so it needs the
                                 // credit ledger AND the money core's ledger_entries
  'supabase-waitlist-launch.sql', // last: the launch waitlist. It needs
                                 // arzuz_role() for its policies and for the
                                 // actor column of the audit trail, and it is
                                 // the only file that writes to
                                 // waitlist_ref_registry, so nothing else may
                                 // depend on it being present.
  'supabase-verification-rpc.sql', // the verification decision, narrowed from
                                 // a row-wide update policy to four columns
                                 // (status, tier, verified_at, verified_by).
                                 // It follows the launch file because it writes
                                 // the two columns that file adds, and it
                                 // precedes the closer — which stays last,
                                 // because every file above it is written
                                 // knowing anon can still POST.
  'supabase-verification-queue.sql', // STAGE 2: the shift that gets somebody to
                                 // the door to make that decision — the claim
                                 // columns, the append-only trail, and the three
                                 // column-scoped functions. It follows the RPC
                                 // file that made the decision correct, and it
                                 // reads arzuz_role() for every authorization.
  'supabase-verification-evidence.sql', // STAGE 3: what the visit SAW — one
                                 // row per check, grouped by visit, written
                                 // only by public.listing_attest(), which
                                 // records the evidence and makes the
                                 // decision in ONE transaction. It follows
                                 // the queue file (its trail and its
                                 // listing_verify are both prerequisites)
                                 // and precedes the closer, whose rule it
                                 // respects: it grants its own read surface
                                 // explicitly rather than leaning on the
                                 // default privileges that file removes.
  'supabase-status-codes.sql',   // the public status page: the code a
                                 // student proves their phone with, the
                                 // lookup throttle that keeps references
                                 // from being walked, and the reveal.
                                 // It reads waitlist_ref_registry, so it
                                 // follows the launch file, and it says
                                 // nothing about anon's grants on the
                                 // five public tables — which is why it
                                 // may sit above the closer.
  'supabase-status-history.sql',  // the desk's half of the same page: the
                                 // delivery trail, the code's own attempt
                                 // ceiling, and the one function that reads
                                 // them. It RE-STATES status_verify (section
                                 // 4), so it must follow the file that created
                                 // it, and it adds a column to status_codes,
                                 // which the same file creates.
  'supabase-close-public-inserts.sql', // and last of all, the one that closes
                                 // the direct path. It guards on
                                 // waitlist_throttle() — the validated door's
                                 // own function — because revoking anon's
                                 // insert on a database that has no door would
                                 // leave the site unable to take a submission
                                 // at all. Nothing may follow it: every file
                                 // above is written knowing anon can still
                                 // POST, and this is the file that says so is
                                 // no longer true.
];

/* ------------------------------------------------------------
   reporting
   ------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) {
      pass += 1;
      console.log('  \u2713 ' + name);
    } else {
      fail += 1;
      failures.push([name, String(r)]);
      console.log('  \u2717 ' + name + '\n      ' + r);
    }
  } catch (err) {
    fail += 1;
    failures.push([name, why(err)]);
    console.log('  \u2717 ' + name + '\n      ' + why(err));
  }
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------
   the engine
   ------------------------------------------------------------ */

const db = await PGlite.create();

/* Postgres speaks two protocols here and they are not interchangeable:
   query() is the extended protocol, ONE statement per call (so a
   multi-statement script answers 42601), and exec() takes a whole
   script. The checks want rows, the scripts want to be scripts. */
async function sql(text, params) {
  return db.query(text, params);
}

async function runScript(text) {
  return db.exec(text);
}

/* A Postgres error is a paragraph with a stack attached, and PGlite's
   stack points into a minified WASM bundle (600 lines of it). The only
   part worth reading is the message, so that is the only part kept. */
function why(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 400);
}

async function one(text, params) {
  const r = await sql(text, params);
  return r.rows[0];
}

async function val(text, params) {
  const row = await one(text, params);
  return row ? Object.values(row)[0] : null;
}

/* The JWT, as Postgres sees it. GoTrue sets these two GUCs on every
   request, and it is the ONLY channel a token reaches a policy
   through — so this is the switch every role test throws. */
async function setClaims(role, appMetadata, sub) {
  const claims = { role: role, ...(appMetadata ? { app_metadata: appMetadata } : {}) };
  if (sub) claims.sub = sub;
  await sql(`set request.jwt.claims = '${JSON.stringify(claims)}'`);
  await sql(`set request.jwt.claim.role = '${role}'`);
}

async function clearClaims() {
  await sql("set request.jwt.claims = ''");
  await sql("set request.jwt.claim.role = ''");
}

/* Run a statement as a client role, with the claims that role would
   carry, then put the session back. Table owners bypass RLS, so
   `set role` is what makes a policy test mean anything. */
async function asRole(role, fn, appMetadata) {
  await setClaims(role === 'postgres' ? 'service_role' : role, appMetadata, '00000000-0000-4000-8000-000000000001');
  await sql('set role ' + role);
  try {
    return await fn();
  } finally {
    await sql('reset role');
    await clearClaims();
  }
}

/* An error is only evidence if it is the RIGHT error, so the code is
   asserted rather than "it threw" — 42501 is insufficient_privilege,
   23514 is check_violation, 23505 is unique_violation. */
/* Postgres puts the SQLSTATE in `code`, not in the message text, so
   matching on the message would have reported every one of these
   refusals as a failure — which is exactly what it did on the first
   run of this harness. The code is the evidence; the message is only
   there to make a failure readable. */
async function refuses(fn, code) {
  try {
    await fn();
    return 'the statement SUCCEEDED, which is the bug';
  } catch (err) {
    const m = why(err);
    if (!code) return true;
    if (err && err.code === code) return true;
    if (m.includes(code)) return true;
    return 'refused with ' + ((err && err.code) || 'no code') + ', not ' + code + ': ' + m;
  }
}

/* ------------------------------------------------------------
   bootstrap — the four things Supabase provides
   ------------------------------------------------------------ */

async function bootstrap() {
  /* Supabase's roles. NOLOGIN: they are identities to `set role`
     into, never connections. service_role bypasses RLS by
     attribute, exactly as it does on the real platform. */
  await runScript(`
    create role anon noinherit nologin;
    create role authenticated noinherit nologin;
    create role service_role noinherit nologin bypassrls;

    create schema if not exists auth;

    /* Supabase's default privileges — the ones supabase-roommate.sql
       and supabase-team-roles.sql are written to strip back. Without
       this the revokes below would pass vacuously.

       service_role is in this list on a real project (its initial
       schema names postgres, anon, authenticated and service_role on
       all three statements), and it is load-bearing here: the waitlist
       door inserts with the service role, so a stand-in that granted
       it nothing would make §13c prove the door against a role that
       could not have written the row. It is granted and never revoked
       — every revoke in the chain names anon and authenticated — and
       that asymmetry is the point of
       supabase-close-public-inserts.sql. */
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);

  /* auth.uid() / auth.jwt() / auth.role(), with the real contract:
     jwt() is the claims object (or {} when there is no token),
     role() is the token's role claim and NULL when there is no token
     at all — the branch arzuz_role() guards against, and the reason
     an anonymous visitor must never come back as 'admin'. */
  await runScript(`
    create or replace function auth.jwt()
    returns jsonb language sql stable as $fn$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
    $fn$;

    create or replace function auth.role()
    returns text language sql stable as $fn$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $fn$;

    create or replace function auth.uid()
    returns uuid language sql stable as $fn$
      select nullif(auth.jwt() ->> 'sub', '')::uuid
    $fn$;

    /* Policies evaluate as the invoking role, so it needs USAGE on
       the schema the function lives in. Supabase grants this too. */
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.jwt(), auth.role(), auth.uid() to anon, authenticated, service_role;
  `);
}

/* ------------------------------------------------------------
   apply
   ------------------------------------------------------------ */

const applied = [];
const failuresApplying = [];

async function apply(file, run) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  /* Each file is one transaction, because that is how the Supabase
     SQL editor runs a pasted file — and the files rely on it: they
     raise in a preflight expecting nothing half-built to survive. */
  const t0 = Date.now();
  await db.transaction(async (tx) => {
    await tx.exec(text);
  });
  applied.push({ file, run, ms: Date.now() - t0, lines: text.split('\n').length });
}

/* A fingerprint that changes if anything structural changes, so the
   second run can be proved to be a no-op rather than assumed to be. */
async function fingerprint() {
  const row = await one(`
    select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','v','m','p')) as relations,
      (select count(*) from pg_policies where schemaname = 'public')            as policies,
      (select count(*) from pg_indexes where schemaname = 'public')             as indexes,
      (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public')                                             as constraints,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public')                                             as functions
  `);
  return ['relations', 'policies', 'indexes', 'constraints', 'functions']
    .map((k) => k + '=' + row[k]).join(' ');
}

/* Counts are not enough for the second run: a sweep that deletes a
   policy and recreates it under another name would keep the total
   identical while changing what the database allows. So the names are
   compared too. */
async function policySet() {
  const rows = await sql(`select tablename, policyname, cmd, roles::text as roles
                            from pg_policies where schemaname = 'public'
                           order by tablename, policyname`);
  return rows.rows.map((r) => r.tablename + ':' + r.policyname + ':' + r.cmd + ':' + r.roles).join('\n');
}

async function exists(kind, name) {
  const r = await sql(`select to_regclass($1) is not null as ok`, [kind + ' ' + name]);
  return r.rows[0].ok;
}

/* ============================================================
   1 · BOOTSTRAP
   ============================================================ */

console.log('Arzuz SQL proof \u2014 real PostgreSQL in WebAssembly, no Supabase needed');
console.log('\n' + '='.repeat(66));
const boot = await one('select version() as v');
console.log(boot.v.split(' on ')[0]);
console.log('='.repeat(66));

section('1. Bootstrap (the stand-in for what Supabase provides)');
try {
  await bootstrap();
} catch (err) {
  console.log('  \u2717 the stand-in itself failed to build: ' + why(err));
  process.exit(1);
}
await clearClaims();
await check('the three Supabase roles exist', async () =>
  (await val(`select count(*)::int from pg_roles where rolname in ('anon','authenticated','service_role')`)) === 3);
await check('auth.jwt()/auth.role()/auth.uid() are callable', async () =>
  (await val(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='auth' and p.proname in ('jwt','role','uid')`)) === 3);
await check('with no JWT, auth.role() is null (not a role)', async () =>
  (await val('select auth.role() is null as x')) === true);

/* ============================================================
   2 · APPLY, IN ORDER
   ============================================================ */

section('2. Applying the ' + FILES.length + ' files, in dependency order');

for (const file of FILES) {
  try {
    await apply(file, 1);
    const a = applied[applied.length - 1];
    console.log('  \u2713 ' + file.padEnd(30) + String(a.lines).padStart(4) + ' lines, ' + a.ms + ' ms');
  } catch (err) {
    failuresApplying.push([file, why(err)]);
    console.log('  \u2717 ' + file.padEnd(30) + 'FAILED\n      ' + why(err));
  }
}

await check('every file applied', async () => {
  if (failuresApplying.length) {
    return failuresApplying.map(([f, e]) => f + ': ' + e).join(' | ');
  }
  return true;
});

if (failuresApplying.length) {
  console.log('\nStopping: a file that will not run cannot be asserted about.');
  console.log('The order above is the order the files document for themselves \u2014');
  console.log('if one of them failed, that is a finding, and it is the finding this');
  console.log('harness exists to produce.');
  process.exit(1);
}

/* ============================================================
   3 · RE-RUNNABILITY — the upgrade path
   ============================================================ */

section('3. Running the whole set a second time (the upgrade path)');
const before = await fingerprint();
const policiesBefore = await policySet();

for (const file of FILES) {
  try {
    await apply(file, 2);
  } catch (err) {
    failuresApplying.push([file + ' (2nd run)', why(err)]);
    console.log('  \u2717 ' + file + ' failed on the second run\n      ' + why(err));
  }
}

await check('the second run changes nothing structural', async () => {
  const after = await fingerprint();
  return before === after ? true : 'before: ' + before + '\nafter:  ' + after;
});
await check('the second run replaces the SAME policies, by name and command', async () => {
  const after = await policySet();
  if (after === policiesBefore) return true;
  const a = policiesBefore.split('\n');
  const b = after.split('\n');
  const gone = a.filter((x) => !b.includes(x));
  const added = b.filter((x) => !a.includes(x));
  return 'lost: ' + (gone.join(', ') || 'none') + ' | gained: ' + (added.join(', ') || 'none');
});
await check('a constraint from run 1 was not duplicated by run 2', async () =>
  (await val(`select count(*)::int from pg_constraint
              where conname = 'roommate_events_event_check'`)) === 1);

/* ============================================================
   4 · THE OBJECTS
   ============================================================ */

section('4. The objects, and RLS switched on');

const TABLES = [
  'demand_records', 'listings', 'scout_submissions', 'amenities',
  'booking_requests', 'support_tickets', 'roommate_profiles',
  'roommate_interests', 'roommate_events', 'care_plans', 'care_credit_events',
  'finance_config', 'product_terms', 'payments', 'ledger_entries', 'referrals', 'referral_codes',
  'repair_claims', 'claim_events',
];
for (const t of TABLES) {
  await check('table ' + t, async () => (await exists('public.', t)) || 'missing');
}

await check('RLS is ON for every table holding personal data', async () => {
  const off = await sql(`
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
       and c.relname in ('demand_records','listings','scout_submissions','support_tickets',
                         'roommate_profiles','roommate_interests','roommate_events')
     order by c.relname`);
  return off.rows.length ? 'RLS is OFF on: ' + off.rows.map((r) => r.relname).join(', ') : true;
});

await check('the dashboard indexes the pool query relies on exist', async () => {
  const want = ['idx_roommate_pool', 'idx_roommate_interests_from', 'idx_roommate_interests_to',
    'idx_roommate_events_created', 'idx_roommate_events_actor'];
  const have = (await sql(`select indexname from pg_indexes where schemaname='public'`)).rows.map((r) => r.indexname);
  const missing = want.filter((w) => !have.includes(w));
  return missing.length ? 'missing: ' + missing.join(', ') : true;
});

/* ============================================================
   5 · THE APPEND-ONLY TRAIL
   ============================================================ */

section('5. The consent trail is append-only, by grant and by policy');

await check("'viewed' is accepted by the CHECK (the widened constraint)", async () => {
  await sql(`insert into roommate_events (event, actor_name) values ('viewed', 'harness')`);
  return true;
});

await check('an unknown event is refused with 23514', async () =>
  refuses(() => sql(`insert into roommate_events (event) values ('hidden_admin_edit')`), '23514'));

await check('the CHECK is the restated one, and there is exactly one', async () => {
  const r = await sql(`select conname from pg_constraint
                        where conrelid = 'roommate_events'::regclass and contype = 'c'`);
  if (r.rows.length !== 1) return 'found ' + r.rows.length + ' CHECK constraints';
  return r.rows[0].conname === 'roommate_events_event_check' ? true
    : 'named ' + r.rows[0].conname;
});

await check('anon has no privilege at all on the trail', async () => {
  const r = await val(`select has_table_privilege('anon', 'roommate_events', 'SELECT')
                            or has_table_privilege('anon', 'roommate_events', 'INSERT') as x`);
  return r === false ? true : 'anon still holds a privilege';
});

await check('authenticated can SELECT the trail and INSERT into it is not granted', async () => {
  const r = await one(`select has_table_privilege('authenticated', 'roommate_events', 'SELECT') as s,
                              has_table_privilege('authenticated', 'roommate_events', 'INSERT') as i,
                              has_table_privilege('authenticated', 'roommate_events', 'UPDATE') as u,
                              has_table_privilege('authenticated', 'roommate_events', 'DELETE') as d`);
  if (!r.s) return 'authenticated cannot read the trail — a dispute would be unanswerable';
  if (r.i || r.u || r.d) return 'authenticated holds ' + ['i', 'u', 'd'].filter((k) => r[k]).join('/');
  return true;
});

await check('an ADMIN session still cannot write history (the real test)', async () =>
  refuses(() => asRole('authenticated', () =>
    sql(`insert into roommate_events (event) values ('accept')`), { role: 'admin' }), '42501'));

await check('an ADMIN session cannot erase the trail either', async () =>
  refuses(() => asRole('authenticated', () =>
    sql(`delete from roommate_events`), { role: 'admin' }), '42501'));

await check('an ADMIN session can still READ the trail', async () => {
  const n = await asRole('authenticated', () =>
    val(`select count(*)::int from roommate_events`), { role: 'admin' });
  return n > 0 ? true : 'admin read ' + n + ' rows from a table it is supposed to see';
});

/* ============================================================
   6 · THE ROLE MODEL — the security claim, under set role
   ============================================================ */

section('6. The role model, exercised rather than described');

await sql(`insert into roommate_profiles (token_hash, payload)
          select 'harness-hash-' || g, jsonb_build_object('name', 'Student ' || g, 'phone', '+23480000000' || g,
                 'gender', 'female', 'area', 'Malete', 'budget', '120000')
            from generate_series(1, 3) g`);

await check('anon cannot read the pool at all', async () =>
  refuses(() => asRole('anon', () => sql('select count(*) from roommate_profiles')), '42501'));

await check('anon cannot insert itself into the pool', async () =>
  refuses(() => asRole('anon', () =>
    sql(`insert into roommate_profiles (token_hash, payload) values ('x', '{}')`)), '42501'));

await check('MARKETING reads ZERO rows — not an error, and not the data', async () => {
  const n = await asRole('authenticated', () =>
    val('select count(*)::int from roommate_profiles'), { role: 'marketing' });
  return n === 0 ? true : 'marketing read ' + n + ' student rows';
});

await check('SUPPORT reads the pool it has to answer the phone about', async () => {
  const n = await asRole('authenticated', () =>
    val('select count(*)::int from roommate_profiles'), { role: 'support' });
  return n >= 3 ? true : 'support read ' + n + ' rows';
});

await check('ADMIN reads the pool (no role key at all = the main admin)', async () => {
  const n = await asRole('authenticated', () =>
    val('select count(*)::int from roommate_profiles'), undefined);
  return n >= 3 ? true : 'admin read ' + n + ' rows';
});

await check('marketing cannot reach a phone number through the mutual-pairs view', async () => {
  const n = await asRole('authenticated', () =>
    val('select count(*)::int from roommate_mutual_pairs'), { role: 'marketing' });
  return n === 0 ? true : 'marketing read ' + n + ' pairs, phone numbers included';
});

/* Only the two roommate views are asserted here. public_listings is a
   DEFINER view on purpose — that is how an anonymous visitor reads the
   blessed listing fields without any grant on listings itself — so
   demanding security_invoker of it would be demanding the bug. Its own
   property (anon can read it) is asserted below instead. */
await check('the roommate views carry security_invoker = true', async () => {
  const rows = await sql(`
    select c.relname, coalesce(array_to_string(c.reloptions, ','), '') as opts
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
       and c.relname in ('roommate_mutual_pairs','roommate_engine_summary')
     order by c.relname`);
  if (rows.rows.length !== 2) return 'expected two views, found ' + rows.rows.length;
  const missing = rows.rows.filter((r) => !r.opts.includes('security_invoker=true')).map((r) => r.relname);
  return missing.length ? 'no security_invoker on: ' + missing.join(', ') : true;
});

await check('and an ANON visitor can still read public_listings (the definer view)', async () => {
  const n = await asRole('anon', () => val('select count(*)::int from public_listings'));
  return typeof n === 'number' ? true : 'anon could not read the public listing view: ' + n;
});

await check('marketing CAN read the scrubbed growth feeds (the whole point of them)', async () => {
  const n = await asRole('authenticated', () =>
    val('select count(*)::int from growth_demand_feed'), { role: 'marketing' });
  return typeof n === 'number' ? true : 'growth_demand_feed was not readable: ' + n;
});

/* ============================================================
   7 · arzuz_role() ITSELF
   ============================================================ */

section('7. arzuz_role() \u2014 the truth table, including the dangerous branch');

async function roleFor(role, appMetadata) {
  return asRole(role, () => val('select public.arzuz_role()'), appMetadata);
}

await check('anonymous \u2192 anon', async () => (await roleFor('anon')) === 'anon');
await check('marketing JWT \u2192 marketing', async () =>
  (await roleFor('authenticated', { role: 'marketing' })) === 'marketing');
await check('support JWT \u2192 support', async () =>
  (await roleFor('authenticated', { role: 'support' })) === 'support');
await check('a signed-in JWT with no role key \u2192 admin', async () =>
  (await roleFor('authenticated')) === 'admin');
await check('service_role \u2192 its own name, never admin', async () =>
  (await roleFor('service_role')) === 'service_role');
await check('NO JWT AT ALL \u2192 anon, never admin  (the branch worth guarding)', async () => {
  await clearClaims();
  const r = await val('select public.arzuz_role()');
  return r === 'anon' ? true : 'returned ' + r + ' \u2014 every visitor would be an admin';
});
await check('an unknown role is never promoted to admin', async () => {
  await setClaims('some_future_role', null, null);
  const r = await val('select public.arzuz_role()');
  await clearClaims();
  return r === 'admin' ? 'an unknown role was read as admin' : true;
});
await check('EXECUTE on arzuz_role() was revoked from PUBLIC', async () => {
  const r = await val(`select has_function_privilege('public', 'public.arzuz_role()', 'EXECUTE') as x`);
  return r === false ? true : 'PUBLIC can still execute it';
});

/* ============================================================
   8 · THE BEHAVIOUR THE APP DEPENDS ON
   ============================================================ */

section('8. Behaviour the application relies on');

await check('the guarded budget cast stores a non-numeric answer as null', async () => {
  await sql(`insert into roommate_profiles (token_hash, payload)
             values ('guarded-1', '{"name":"Comma Budget","budget":"180,000"}')`);
  const r = await one(`select budget_ngn from roommate_profiles where token_hash = 'guarded-1'`);
  if (r.budget_ngn !== null) return 'stored ' + JSON.stringify(r.budget_ngn) + ' instead of null';
  const ok = await one(`select budget_ngn from roommate_profiles where token_hash = 'harness-hash-1'`);
  return ok.budget_ngn === 120000 ? true : 'a numeric budget did not cast: ' + ok.budget_ngn;
});

await check('generated columns pull the dashboard fields out of payload', async () => {
  const r = await one(`select first_name, phone, area, gender
                         from roommate_profiles where token_hash = 'harness-hash-2'`);
  return r.first_name === 'Student 2' && String(r.phone).startsWith('+2348') && r.area === 'Malete'
    ? true : 'generated columns returned ' + JSON.stringify(r);
});

await check('a student cannot match with themselves', async () => {
  const id = await val(`select id from roommate_profiles where token_hash = 'harness-hash-1'`);
  return refuses(() => sql(`insert into roommate_interests (from_ref, to_ref, decision)
                            values ($1, $1, 'accept')`, [id]), '23514');
});

await check('one row per pair — a repeat tap cannot create a second decision', async () => {
  const ids = (await sql(`select id from roommate_profiles where token_hash like 'harness-hash-%' order by token_hash`)).rows.map((r) => r.id);
  await sql(`insert into roommate_interests (from_ref, to_ref, decision) values ($1, $2, 'accept')`, [ids[0], ids[1]]);
  const dup = await refuses(() => sql(`insert into roommate_interests (from_ref, to_ref, decision) values ($1, $2, 'accept')`, [ids[0], ids[1]]), '23505');
  if (dup !== true) return 'the unique pair did not hold: ' + dup;
  await sql(`insert into roommate_interests (from_ref, to_ref, decision) values ($1, $2, 'accept')`, [ids[1], ids[0]]);
  return true;
});

await check('the one metric: two accepts = one mutual pair, counted once', async () => {
  const r = await one(`select mutual_pairs, profiles_total from roommate_engine_summary`);
  return Number(r.mutual_pairs) === 1 ? true
    : 'mutual_pairs = ' + r.mutual_pairs + ' (a pair counted twice is the classic bug)';
});

await check('the mutual-pairs view names both sides exactly once', async () => {
  const n = await val('select count(*)::int from roommate_mutual_pairs');
  return n === 1 ? true : 'view returned ' + n + ' rows for one pair';
});

await check('a deleted profile does not take the trail with it (no foreign keys)', async () => {
  const id = await val(`select id from roommate_profiles where token_hash = 'harness-hash-1'`);
  await sql(`insert into roommate_events (event, actor_ref, actor_name) values ('created', $1, 'Student 1')`, [id]);
  await sql(`delete from roommate_profiles where id = $1`, [id]);
  const n = await val(`select count(*)::int from roommate_events where actor_ref = $1`, [id]);
  return n >= 1 ? true : 'the trail vanished with the profile \u2014 a dispute could not be answered';
});

/* The clamp's keys are the SHORT ones the forms actually post
   (prop_name, ar, rm, ph, desc …), which is why a test written with the
   long name passed nothing and checked nothing. */
await check('the draft payload clamp holds the form ceilings', async () => {
  const long = await val(`select length(public.listing_payload_clamp(
      jsonb_build_object('prop_name', repeat('x', 8000))) ->> 'prop_name')::int`);
  if (long > 70) return 'a name of ' + long + ' characters survived a ceiling of 70';
  const short = await val(`select public.listing_payload_clamp(
      jsonb_build_object('prop_name', 'ok')) ->> 'prop_name'`);
  return short === 'ok' ? true : 'it changed a value that was already inside the ceiling';
});

await check('the clamp strips non-digits from money fields', async () => {
  const r = await val(`select public.listing_payload_clamp(
      jsonb_build_object('rent', '180,000 or free')) ->> 'rent'`);
  return /^[0-9]{0,8}$/.test(String(r)) ? true : 'rent came back as ' + JSON.stringify(r);
});

await check('the draft payload clamp is revoked from PUBLIC', async () => {
  const r = await val(`select has_function_privilege('public', 'public.listing_payload_clamp(jsonb)', 'EXECUTE') as x`);
  return r === false ? true : 'PUBLIC can still call it';
});

await check('an ADMIN session can actually ADD an apartment (the Add modal)', async () => {
  await asRole('authenticated', () => sql(`insert into listings (payload, status, tier)
      values ('{"prop_name":"Harness House","rent":"120000"}'::jsonb, 'active', 1)`), undefined);
  return true;
});

await check('an ANON visitor cannot post to listings at all — the grant is gone, not merely the policy', async () => {
  /* This check used to prove the POLICY: an anon insert was refused
     because the row did not satisfy it. It still refuses, and now it
     refuses one layer earlier — supabase-close-public-inserts.sql removed
     anon's INSERT on this table outright, so the policy below it is never
     consulted. The claim is therefore split in two, because they are two
     different facts and only one of them is still behavioural: the GRANT
     is asserted as an ACL and by a real refusal here, and the POLICY's
     predicate is asserted as text in §13e.

     The row posted below is deliberately a legal one — status 'pending',
     tier 0, the only shape the old anon policy would have accepted. If the
     refusal were coming from the row rather than from the grant, this is
     the row that would get through. */
  const priv = await val(`select has_table_privilege('anon', 'listings', 'insert')::int`);
  if (priv !== 0) return 'anon still holds INSERT on listings';
  return refuses(() => asRole('anon', () => sql(`insert into listings (payload, status, tier)
      values ('{"prop_name":"Anon House"}'::jsonb, 'pending', 0)`)), '42501');
});

/* ------------------------------------------------------------
   8b. ARZUZ CARE — the ₦20,000 session as service credits

   The five decisions this encodes: one credit = one call-out and a
   session is four of them; the balance is an append-only ledger, not
   a counter; the team records the visit and the student never spends
   their own credit; the price stays the flat published ₦20,000; and
   credits die with the session.
   ------------------------------------------------------------ */
section('8b. Arzuz Care \u2014 the credit ledger');

const carePlan = await one(`
  insert into care_plans (token_hash, session, payload)
  values ('care-harness-1', '2026/2027',
          '{"name":"Care Student","phone":"+2348000000099","area":"Malete"}'::jsonb)
  returning id`);
const planId = carePlan.id;

await check('a plan starts as active, at the published ₦20,000', async () => {
  const r = await one(`select status, amount_ngn, first_name, phone from care_plans where id = $1`, [planId]);
  if (Number(r.amount_ngn) !== 20000) return 'amount_ngn is ' + r.amount_ngn;
  return r.status === 'active' && r.first_name === 'Care Student' ? true
    : 'status/first_name came back as ' + JSON.stringify(r);
});

await check('the four call-outs are a +4 row, never a running counter', async () => {
  await sql(`insert into care_credit_events (plan_id, student_name, session, event, delta, reason)
             values ($1, 'Care Student', '2026/2027', 'granted', 4, 'Care for 2026/2027')`, [planId]);
  const r = await one(`select balance, granted, call_outs from care_credit_balance where plan_id = $1`, [planId]);
  return Number(r.balance) === 4 && Number(r.granted) === 4 && Number(r.call_outs) === 0 ? true
    : 'balance view returned ' + JSON.stringify(r);
});

await check('one call-out is exactly -1 credit', async () => {
  await sql(`insert into care_credit_events (plan_id, student_name, session, event, delta, worker, parts_ngn)
             values ($1, 'Care Student', '2026/2027', 'spent', -1, 'Compound caretaker', 1200)`, [planId]);
  const r = await one(`select balance, call_outs from care_credit_balance where plan_id = $1`, [planId]);
  return Number(r.balance) === 3 && Number(r.call_outs) === 1 ? true
    : 'after one call-out the ledger reads ' + JSON.stringify(r);
});

await check('a call-out charged as TWO credits is refused (23514)', async () =>
  refuses(() => sql(`insert into care_credit_events (plan_id, event, delta)
                     values ($1, 'spent', -2)`, [planId]), '23514'));

await check('a grant can never be negative', async () =>
  refuses(() => sql(`insert into care_credit_events (plan_id, event, delta)
                     values ($1, 'granted', -4)`, [planId]), '23514'));

await check('an unknown event kind is refused (23514)', async () =>
  refuses(() => sql(`insert into care_credit_events (plan_id, event, delta)
                     values ($1, 'refunded_by_mistake', -1)`, [planId]), '23514'));

await check('expiry voids whatever is left, and the ledger still adds up', async () => {
  await sql(`insert into care_credit_events (plan_id, student_name, session, event, delta, reason)
             values ($1, 'Care Student', '2026/2027', 'expired', -3, 'Session ended with 3 unused')`, [planId]);
  const r = await one(`select balance, call_outs, expired from care_credit_balance where plan_id = $1`, [planId]);
  return Number(r.balance) === 0 && r.expired === true ? true
    : 'after expiry the ledger reads ' + JSON.stringify(r);
});

await check('the balance is readable from the LEDGER ALONE, with no plan row', async () => {
  /* The header promises a balance survives its plan. Proved by
     reading the view for an id that has no care_plans row at all. */
  const orphan = '11111111-2222-4333-8444-555555555555';
  await sql(`insert into care_credit_events (plan_id, student_name, session, event, delta)
             values ($1, 'Gone Student', '2026/2027', 'granted', 4)`, [orphan]);
  const r = await one(`select balance from care_credit_balance where plan_id = $1`, [orphan]);
  return Number(r.balance) === 4 ? true : 'the orphaned plan read ' + JSON.stringify(r);
});

await check('one student cannot hold two ACTIVE plans for one session', async () =>
  refuses(() => sql(`insert into care_plans (token_hash, session, payload)
                     values ('care-harness-dupe', '2026/2027',
                             '{"name":"Care Student","phone":"+2348000000099"}'::jsonb)`), '23505'));

await check('but a refunded plan does not block a legitimate re-purchase', async () => {
  await sql(`update care_plans set status = 'refunded' where id = $1`, [planId]);
  await sql(`insert into care_plans (token_hash, session, payload)
             values ('care-harness-2', '2026/2027',
                     '{"name":"Care Student","phone":"+2348000000099"}'::jsonb)`);
  return true;
});

await check('the ledger is append-only for EVERY client role, admin included', async () => {
  const r = await one(`select has_table_privilege('authenticated', 'care_credit_events', 'INSERT') as i,
                              has_table_privilege('authenticated', 'care_credit_events', 'UPDATE') as u,
                              has_table_privilege('authenticated', 'care_credit_events', 'DELETE') as d,
                              has_table_privilege('anon', 'care_credit_events', 'SELECT') as anon_s`);
  if (r.anon_s) return 'anon can read the Care ledger';
  if (r.i || r.u || r.d) return 'authenticated holds ' + ['i', 'u', 'd'].filter((k) => r[k]).join('/');
  return true;
});

await check('an ADMIN session cannot award itself four call-outs', async () =>
  refuses(() => asRole('authenticated', () => sql(
    `insert into care_credit_events (plan_id, event, delta) values ($1, 'granted', 4)`, [planId]
  ), { role: 'admin' }), '42501'));

await check('an ADMIN session cannot erase a call-out', async () =>
  refuses(() => asRole('authenticated', () => sql('delete from care_credit_events'), { role: 'admin' }), '42501'));

await check('an ADMIN session cannot flip a plan to refunded by hand', async () =>
  refuses(() => asRole('authenticated', () => sql(
    `update care_plans set status = 'refunded' where id = $1`, [planId]
  ), { role: 'admin' }), '42501'));

await check('anon cannot read a plan at all', async () =>
  refuses(() => asRole('anon', () => sql('select count(*) from care_plans')), '42501'));

await check('MARKETING reads zero Care rows \u2014 a plan is a phone number plus a bill', async () => {
  const n = await asRole('authenticated', () => val('select count(*)::int from care_plans_live'), { role: 'marketing' });
  return n === 0 ? true : 'marketing read ' + n + ' Care plans through the view';
});

await check('SUPPORT reads them \u2014 they are the ones recording the visit', async () => {
  const n = await asRole('authenticated', () => val('select count(*)::int from care_plans_live'), { role: 'support' });
  return n >= 1 ? true : 'support read ' + n + ' plans';
});

await check('the Care views carry security_invoker = true', async () => {
  const rows = await sql(`
    select c.relname, coalesce(array_to_string(c.reloptions, ','), '') as opts
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
       and c.relname in ('care_plans_live', 'care_credit_balance')`);
  if (rows.rows.length !== 2) return 'expected two views, found ' + rows.rows.length;
  const missing = rows.rows.filter((r) => !r.opts.includes('security_invoker=true')).map((r) => r.relname);
  return missing.length ? 'no security_invoker on: ' + missing.join(', ') : true;
});

await check('care.html\u2019s published numbers are the ones in the module', async () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/care-credit.js'), 'utf8');
  const fee = /SESSION_FEE_NGN\s*=\s*20000/.test(src);
  const calls = /CALL_OUTS_INCLUDED\s*=\s*4/.test(src);
  const parts = /PARTS_INCLUDED_NGN\s*=\s*3000/.test(src);
  return fee && calls && parts ? true
    : 'the module disagrees with the published page: ' +
      ['fee', 'call-outs', 'parts'].filter((k, i) => ![fee, calls, parts][i]).join(', ');
});

/* ------------------------------------------------------------
   9. The ordering bug this harness found

   supabase-hardening.sql used to create its INSERT policies first
   and then run a sweep that DROPS every policy by name — including
   the three it had just created — so the dashboard's Add modal was
   refused by RLS. It also meant a fresh install that ran
   supabase-schema.sql and then this file died on 42710, taking the
   whole hardening pass (and the columns the later files preflight
   for) down with it.

   The database checks above cannot pin that on their own: by the
   time the last file has run, supabase-team-roles.sql has created
   its own INSERT policies under different names, so the end state
   looks healthy either way. This is the file-shape assertion, the
   same trick the print-sheet contract uses.
   ------------------------------------------------------------ */
section('9. The hardening file sweeps before it creates (the bug this harness found)');

const hardening = readFileSync(join(ROOT, 'supabase-hardening.sql'), 'utf8');
const sweepAt = hardening.indexOf('declare p text;');
const firstCreateAt = hardening.indexOf('create policy "public can submit demand"');
const lastCreateAt = hardening.lastIndexOf('create policy');

await check('the policy sweep appears before the first create policy', async () => {
  if (sweepAt === -1) return 'there is no sweep in the file at all';
  if (firstCreateAt === -1) return 'the first create policy was not found';
  return sweepAt < firstCreateAt ? true
    : 'the sweep runs after the creates, so it deletes what it just made';
});
await check('it is the FIRST thing in the RLS section, not somewhere under it', async () =>
  sweepAt < firstCreateAt && sweepAt > hardening.indexOf('enable row level security')
    ? true : 'the sweep is outside the RLS section');
await check('the sweep names the INSERT policies, so a second run replaces them', async () => {
  const block = hardening.slice(sweepAt, firstCreateAt);
  const want = ['admin can add demand', 'admin can add listings', 'admin can add scout reports',
    'public can submit demand', 'public can submit listings', 'public can submit scout reports'];
  const missing = want.filter((w) => !block.includes("'" + w + "'"));
  return missing.length ? 'not swept, so run 2 would die on 42710: ' + missing.join(', ') : true;
});
await check('the amenity policies are still replaced by their own block', async () => {
  const amenity = hardening.slice(lastCreateAt > 0 ? hardening.indexOf('amenities') : 0);
  return /drop policy if exists "public can read amenities"\s+on amenities/.test(hardening)
    ? true : 'the amenity policies lost their own drop — they are no longer in the sweep';
});

/* ============================================================
   10 · THE PAYLOAD CEILINGS — every one, on real Postgres

   THE SMOKE TEST FOR listing_payload_clamp

     The clamp is the one guard between an API caller and an
     8,000-character lodge name rendered into the dashboard table
     and the OG card. It used to live inside one RPC — and the
     dashboard does not use that RPC. The dashboard POSTs to
     /rest/v1/listings, the landlord form POSTs to the same table
     as anon, and the SQL editor writes as the owner. Three doors
     the clamp never saw.

     So the ceilings are asserted TWICE: as a function (every cap,
     the money rule and the 0-units rule) and as the trigger every
     writer now meets on the way in. Then the browse-board rule is
     asserted on its own, because "I added an apartment and the
     browse page says there are none" is a filter, not a failure:
     public_listings shows status='active' AND tier>=1 AND
     env='production', and nothing in the dashboard ever said so.

     Nothing here needs Supabase: PGlite is PostgreSQL 18 compiled
     to WebAssembly, so these are real casts, real generated
     columns and real triggers, checked with real queries.
   ============================================================ */

section('10. The clamp — every ceiling, checked as a function');

const CLAMP_CAPS = [
  ['prop_name', 70], ['ar', 80], ['ty', 40], ['rm', 60], ['nm', 60], ['last', 60],
  ['ph', 24], ['contact_role', 20], ['who', 20], ['vf', 40],
  ['photo', 300], ['video', 300], ['video_url', 300],
  ['access_notes', 600], ['desc', 2000],
];

for (const [key, cap] of CLAMP_CAPS) {
  await check('clamps ' + key + ' to ' + cap, async () => {
    const long = await val(`select length(public.listing_payload_clamp(
        jsonb_build_object('${key}', repeat('x', 5000))) ->> '${key}')::int`);
    if (long !== cap) return 'a 5,000-character ' + key + ' came back ' + long + ' characters long, not ' + cap;
    const short = await val(`select public.listing_payload_clamp(
        jsonb_build_object('${key}', 'ok')) ->> '${key}'`);
    return short === 'ok' ? true
      : 'it rewrote a value that was already inside the ceiling: ' + JSON.stringify(short);
  });
}

await check('an unlisted key is left completely alone', async () => {
  const r = await val(`select public.listing_payload_clamp(
      jsonb_build_object('passage', jsonb_build_object('landmark', repeat('z', 900))))
      -> 'passage' ->> 'landmark'`);
  return r && r.length === 900 ? true
    : 'the clamp rewrote a key it does not claim to cap (' + (r ? r.length : 'missing') + ' characters)';
});

/* The ceilings are only worth anything if they are the SAME ceilings the
   two forms apply — a clamp that is stricter silently eats what a
   landlord typed; a looser one lets the row past the form's own copy
   about a 70-character name. So the numbers are read back out of the
   HTML files rather than trusted to a comment. */
const FORM_CEILINGS = [
  /* payload key, cap, [file, element id]… */
  ['prop_name', 70, ['complete-listing.html', 'cl_prop_name'], ['admin.html', 'add_prop_name']],
  ['ar', 80, ['complete-listing.html', 'cl_ar'], ['admin.html', 'add_ar']],
  ['nm', 60, ['complete-listing.html', 'cl_nm'], ['admin.html', 'add_nm']],
  ['ph', 24, ['complete-listing.html', 'cl_ph'], ['admin.html', 'add_ph']],
  ['desc', 2000, ['complete-listing.html', 'cl_desc'], ['admin.html', 'add_desc']],
  ['access_notes', 600, ['complete-listing.html', 'cl_access_notes'], ['admin.html', 'add_access_notes']],
  ['video_url', 300, ['complete-listing.html', 'clVideoUrl'], ['admin.html', 'add_video_url_manual']],
  ['rent', 8, ['complete-listing.html', 'cl_rent'], ['admin.html', 'add_rent']],
  ['ask', 8, ['complete-listing.html', 'cl_ask'], ['admin.html', 'add_ask']],
];

await check('the forms cap at the same numbers the database does (HTML \u2194 SQL)', async () => {
  const sources = {};
  for (const [file] of FORM_CEILINGS.map((r) => r[2]).concat(FORM_CEILINGS.map((r) => r[3]))) {
    if (!sources[file]) sources[file] = readFileSync(join(ROOT, file), 'utf8');
  }
  const wrong = [];
  for (const [key, cap, ...fields] of FORM_CEILINGS) {
    for (const [file, id] of fields) {
      const m = new RegExp('id="' + id + '"[^>]*maxlength="(\\d+)"').exec(sources[file]);
      if (!m) { wrong.push(file + ' #' + id + ' (' + key + ') carries no maxlength'); continue; }
      if (Number(m[1]) !== cap) wrong.push(file + ' #' + id + ' caps at ' + m[1] + ', the database caps ' + key + ' at ' + cap);
    }
  }
  return wrong.length ? wrong.join(' | ') : true;
});

/* The Add modal's DEFAULTS are part of the contract: if the selected
   status or tier ever stops being one the board reads, every listing
   added by hand is silently saved invisible. */
await check('the Add composer defaults to the two values that publish (active + tier 2)', async () => {
  const admin = readFileSync(join(ROOT, 'admin.html'), 'utf8');
  const status = /<select id="add_status">[\s\S]*?<option value="([^"]+)" selected>/.exec(admin);
  const tier = /<select id="add_tier">[\s\S]*?<option value="([^"]+)" selected>/.exec(admin);
  if (!status) return 'add_status has no selected default';
  if (!tier) return 'add_tier has no selected default';
  const bad = [];
  if (status[1] !== 'active') bad.push('status defaults to "' + status[1] + '", so every new listing starts off the board');
  if (Number(tier[1]) < 1) bad.push('tier defaults to ' + tier[1] + ', so every new listing starts unverified');
  return bad.length ? bad.join(' | ') : true;
});

/* `maxlength` does nothing on <input type="number"> — the browser ignores
   it. The money ceiling that actually blocks a submit is `max`, so it is
   asserted here as well; otherwise this family of checks would pass on an
   attribute that does not do what its name says. */
await check('money carries the numeric ceiling too (maxlength is ignored on number inputs)', async () => {
  const wrong = [];
  const pairs = [
    ['complete-listing.html', 'cl_rent'], ['complete-listing.html', 'cl_ask'],
    ['admin.html', 'add_rent'], ['admin.html', 'add_ask'],
    ['assets/admin.js', 'edit_rent'], ['assets/admin.js', 'edit_ask'],
  ];
  for (const [file, id] of pairs) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const m = new RegExp('id="' + id + '"[^>]*max="(\\d+)"').exec(src);
    if (!m) { wrong.push(file + ' #' + id + ' carries no max'); continue; }
    if (m[1] !== '99999999') wrong.push(file + ' #' + id + ' caps at ' + m[1] + ', the database caps money at 8 digits');
  }
  return wrong.length ? wrong.join(' | ') : true;
});

await check('money is digits only, at most eight', async () => {
  const r = await one(`select public.listing_payload_clamp(jsonb_build_object(
      'rent', '180,000 or free', 'ask', '\u20a6200000 per session')) as j`);
  const rent = r.j.rent, ask = r.j.ask;
  if (!/^[0-9]{0,8}$/.test(String(rent))) return 'rent came back as ' + JSON.stringify(rent);
  if (String(rent) !== '180000') return 'rent stripped to ' + JSON.stringify(rent) + ' instead of 180000';
  if (String(ask) !== '200000') return 'ask stripped to ' + JSON.stringify(ask) + ' instead of 200000';
  return true;
});

await check('a number larger than the ceiling is truncated, not rounded up', async () => {
  const r = await val(`select public.listing_payload_clamp(
      jsonb_build_object('rent', '123456789')) ->> 'rent'`);
  return r === '12345678' ? true : 'nine digits came back as ' + JSON.stringify(r);
});

/* Zero is the case that shipped wrong once: parseInt('0') failed a >0
   test, so a fully-let lodge was stored as "Units available" and the
   browse card advertised rooms that do not exist. */
await check('0 units \u2192 units null, avail occupied, rm "Fully occupied"', async () => {
  const r = await one(`select public.listing_payload_clamp(jsonb_build_object('units', 0)) as j`);
  const j = r.j;
  if (!Object.prototype.hasOwnProperty.call(j, 'units')) return 'units was dropped from the payload instead of set to null';
  if (j.units !== null) return 'units came back as ' + JSON.stringify(j.units);
  if (j.avail !== 'occupied') return 'avail came back as ' + JSON.stringify(j.avail);
  if (j.rm !== 'Fully occupied') return 'rm came back as ' + JSON.stringify(j.rm);
  return true;
});

await check('0 units sent as a STRING behaves the same way', async () => {
  const r = await one(`select public.listing_payload_clamp(jsonb_build_object('units', '0')) as j`);
  return r.j.units === null && r.j.avail === 'occupied' && r.j.rm === 'Fully occupied' ? true
    : 'a string "0" produced ' + JSON.stringify(r.j);
});

await check('999999999 units \u2192 999', async () => {
  const r = await val(`select public.listing_payload_clamp(jsonb_build_object('units', 999999999)) ->> 'units'`);
  return r === '999' ? true : 'a nine-digit count came back as ' + JSON.stringify(r);
});

await check('a negative count is refused as a count', async () => {
  const r = await val(`select public.listing_payload_clamp(jsonb_build_object('units', -5)) ->> 'units'`);
  return r === null ? true : 'a negative count came back as ' + JSON.stringify(r);
});

await check('a real count survives untouched', async () => {
  const r = await one(`select public.listing_payload_clamp(jsonb_build_object('units', 7, 'rm', '7 rooms available')) as j`);
  return String(r.j.units) === '7' && r.j.rm === '7 rooms available' ? true : 'seven units became ' + JSON.stringify(r.j);
});

await check('no units key at all is not invented', async () => {
  const r = await val(`select jsonb_exists(public.listing_payload_clamp(jsonb_build_object('prop_name', 'ok')), 'units') as x`);
  return r === false ? true : 'the clamp invented a units key on a payload that had none';
});

await check('media over sixty keeps the FIRST sixty, in order', async () => {
  const base = `public.listing_payload_clamp(jsonb_build_object('media',
      (select jsonb_agg(jsonb_build_object('type','image','url','u'||g) order by g)
         from generate_series(1,120) g)))`;
  const n = await val(`select jsonb_array_length((${base}) -> 'media')::int`);
  if (n !== 60) return '120 files came back as ' + n;
  const first = await val(`select ((${base}) -> 'media' -> 0) ->> 'url'`);
  const last = await val(`select ((${base}) -> 'media' -> 59) ->> 'url'`);
  return first === 'u1' && last === 'u60' ? true : 'it kept ' + first + '\u2026' + last + ' instead of u1\u2026u60';
});

await check('exactly sixty files is not a rewrite', async () => {
  const n = await val(`select jsonb_array_length(public.listing_payload_clamp(jsonb_build_object('media',
      (select jsonb_agg(jsonb_build_object('url','u'||g) order by g) from generate_series(1,60) g))) -> 'media')::int`);
  return n === 60 ? true : 'sixty files came back as ' + n;
});

await check('a media value that is not a list is left alone', async () => {
  const r = await val(`select public.listing_payload_clamp(jsonb_build_object('media', 'not-a-list')) ->> 'media'`);
  return r === 'not-a-list' ? true : 'a non-array media was rewritten to ' + JSON.stringify(r);
});

/* lat/lng feed generated columns cast to double precision, so a pin that
   is not a number raises 22P02 for whoever is writing the row. The clamp
   sits in front of every writer now, so it also has to make that safe. */
await check('a pin that is not a number becomes null, so the row still saves', async () => {
  const r = await one(`select public.listing_payload_clamp(jsonb_build_object('lat', 'behind the mosque', 'lng', '8.1391')) as j`);
  if (!Object.prototype.hasOwnProperty.call(r.j, 'lat') || r.j.lat !== null) return 'lat came back as ' + JSON.stringify(r.j.lat);
  return String(r.j.lng) === '8.1391' ? true : 'a valid longitude was changed: ' + JSON.stringify(r.j.lng);
});

await check('real coordinates pass through untouched, negative ones included', async () => {
  const r = await one(`select public.listing_payload_clamp(jsonb_build_object('lat', '8.139135', 'lng', '-4.0192')) as j`);
  return String(r.j.lat) === '8.139135' && String(r.j.lng) === '-4.0192' ? true
    : 'coordinates came back as ' + JSON.stringify(r.j);
});

await check('clamping twice is the same as clamping once (the RPC + the trigger)', async () => {
  const r = await sql(`with once as (select public.listing_payload_clamp(jsonb_build_object(
        'prop_name', repeat('x', 5000), 'rent', '180,000', 'units', 0,
        'lat', 'nope', 'media', (select jsonb_agg(jsonb_build_object('url','u'||g) order by g)
                                   from generate_series(1,120) g))) as j)
      select public.listing_payload_clamp(j)::text as twice, j::text as once from once`);
  return r.rows[0].twice === r.rows[0].once ? true
    : 'a second pass changed the payload:\n      once:  ' + r.rows[0].once.slice(0, 120) +
      '\n      twice: ' + r.rows[0].twice.slice(0, 120);
});

section('10b. The trigger \u2014 the ceilings apply to EVERY writer of listings');

await check('the trigger exists and covers insert AND update of payload', async () => {
  const def = await val(`select pg_get_triggerdef(t.oid)
                           from pg_trigger t join pg_class c on c.oid = t.tgrelid
                          where c.relname = 'listings' and t.tgname = 'listings_guard_payload'`);
  if (!def) return 'there is no listings_guard_payload trigger on listings \u2014 the clamp is back to one door';
  return /before insert or update of payload/i.test(def) ? true
    : 'the trigger is: ' + def;
});

await check('the trigger is not callable by a client role', async () => {
  const r = await val(`select has_function_privilege('public', 'public.listings_guard_payload()', 'EXECUTE') as x`);
  return r === false ? true : 'PUBLIC can still execute the trigger function';
});

await check('a plain INSERT (the dashboard REST path) comes out clamped', async () => {
  await sql(`insert into listings (payload, status, tier, env, source)
             values (jsonb_build_object(
                       'apt_id', 'GUARD-INSERT',
                       'prop_name', repeat('x', 5000),
                       'ph', repeat('9', 400),
                       'desc', repeat('y', 9000),
                       'units', 0,
                       'lat', 'not-a-number',
                       'media', (select jsonb_agg(jsonb_build_object('url','u'||g) order by g)
                                   from generate_series(1,120) g)),
                     'active', 2, 'production', 'trigger-probe')`);
  const r = await one(`select length(payload ->> 'prop_name') as name_len,
                              length(payload ->> 'ph')        as phone_len,
                              length(payload ->> 'desc')      as desc_len,
                              payload ->> 'units'             as units,
                              payload ->> 'avail'             as avail,
                              payload ->> 'rm'                as rooms,
                              payload ->> 'lat'               as lat,
                              jsonb_array_length(payload -> 'media') as media
                         from listings where payload ->> 'apt_id' = 'GUARD-INSERT'`);
  const bad = [];
  if (r.name_len !== 70) bad.push('name ' + r.name_len);
  if (r.phone_len !== 24) bad.push('phone ' + r.phone_len);
  if (r.desc_len !== 2000) bad.push('description ' + r.desc_len);
  if (r.units !== null) bad.push('units ' + JSON.stringify(r.units));
  if (r.avail !== 'occupied') bad.push('avail ' + JSON.stringify(r.avail));
  if (r.rooms !== 'Fully occupied') bad.push('rm ' + JSON.stringify(r.rooms));
  if (r.lat !== null) bad.push('lat ' + JSON.stringify(r.lat));
  if (r.media !== 60) bad.push('media ' + r.media);
  return bad.length ? 'stored UNCLAMPED: ' + bad.join(', ') : true;
});

await check('an UPDATE that sets payload is clamped too', async () => {
  await sql(`insert into listings (payload, status, tier, env)
             values (jsonb_build_object('apt_id','GUARD-UPDATE','prop_name','short'), 'draft', 0, 'production')`);
  await sql(`update listings set payload = payload || jsonb_build_object('prop_name', repeat('x', 5000))
              where payload ->> 'apt_id' = 'GUARD-UPDATE'`);
  const n = await val(`select length(payload ->> 'prop_name')::int from listings where payload ->> 'apt_id' = 'GUARD-UPDATE'`);
  return n === 70 ? true : 'an UPDATE stored a ' + n + '-character name';
});

await check('the PUBLIC form is clamped as well \u2014 and it is the door that writes it now', async () => {
  /* Driven as service_role, because that is who the public form writes
     as since supabase-close-public-inserts.sql revoked anon's INSERT.
     The point of the check is unchanged and is not about the actor: a
     landlord who types 4,000 characters into the property name must get
     70 characters stored, whichever door the row came through — and the
     bypassrls attribute means this path can only be safe if the TRIGGER
     does the clamping, which is exactly what is being proven here. */
  await asRole('service_role', () => sql(`insert into listings (payload, status, tier)
      values (jsonb_build_object('apt_id','GUARD-ANON','prop_name', repeat('x', 4000), 'units', 0), 'pending', 0)`));
  const r = await one(`select length(payload ->> 'prop_name') as n, payload ->> 'rm' as rm
                         from listings where payload ->> 'apt_id' = 'GUARD-ANON'`);
  if (r.n !== 70) return 'the public form stored a ' + r.n + '-character name';
  return r.rm === 'Fully occupied' ? true : 'the public form stored rm as ' + JSON.stringify(r.rm);
});

await check('a status-only change does not have to be clamped to be safe', async () => {
  /* The trigger is scoped to payload, so the dashboard's approve/status
     write does not rewrite what a landlord typed. */
  const before = await val(`select payload::text from listings where payload ->> 'apt_id' = 'GUARD-UPDATE'`);
  await sql(`update listings set status = 'inactive' where payload ->> 'apt_id' = 'GUARD-UPDATE'`);
  const after = await val(`select payload::text from listings where payload ->> 'apt_id' = 'GUARD-UPDATE'`);
  return before === after ? true : 'a status change rewrote the payload';
});

section('10b2. The edit stamp sitemap-listings.xml reports as lastmod');

/* lastmod was created_at — the day a room was registered, not the day its
   price moved. That is the wrong signal on exactly the pages that most
   need re-crawling, and an untrustworthy lastmod is ignored for the WHOLE
   site. This is the stamp that fixes it. */
await check('listings.updated_at exists, is NOT NULL and defaults to now()', async () => {
  const r = await one(`select is_nullable, column_default, data_type
                         from information_schema.columns
                        where table_schema = 'public' and table_name = 'listings'
                          and column_name = 'updated_at'`);
  if (!r) return 'there is no listings.updated_at \u2014 the sitemap can only fall back to created_at';
  const bad = [];
  if (r.is_nullable !== 'NO') bad.push('nullable');
  if (!/now\(\)/.test(r.column_default || '')) bad.push('default ' + JSON.stringify(r.column_default));
  if (r.data_type !== 'timestamp with time zone') bad.push(r.data_type);
  return bad.length ? 'updated_at is ' + bad.join(', ') : true;
});

await check('the backfill reads created_at, never now()', async () => {
  const src = readFileSync(join(ROOT, 'supabase-listings-updated-at.sql'), 'utf8');
  if (!/update\s+listings\s+set\s+updated_at\s*=\s*created_at/i.test(src))
    return 'the backfill is not updated_at = created_at \u2014 every listing on the site would claim to have been edited the day the SQL was run';
  return /where\s+updated_at\s+is\s+null/i.test(src) ? true : 'the backfill is not restricted to rows that have no stamp yet';
});

await check('the trigger exists, is BEFORE UPDATE, and no client role may call it', async () => {
  const def = await val(`select pg_get_triggerdef(t.oid)
                           from pg_trigger t join pg_class c on c.oid = t.tgrelid
                          where c.relname = 'listings' and t.tgname = 'listings_touch_updated_at'`);
  if (!def) return 'no listings_touch_updated_at trigger \u2014 an edited room keeps its old stamp for ever';
  if (!/before update/i.test(def)) return 'the trigger is: ' + def;
  const priv = await val(`select has_function_privilege('public', 'public.listings_touch_updated_at()', 'EXECUTE') as x`);
  return priv === false ? true : 'PUBLIC can execute the stamp function';
});

/* The behaviour, on a row of its own. A fresh row's stamp is its creation —
   the honest answer for a room nobody has touched. */
const stampId = await val(`insert into listings (payload, status, tier, env)
    values (jsonb_build_object('apt_id','STAMP-1','prop_name','Stamp Lodge'), 'active', 2, 'production')
    returning id`);
/* As instants, not as strings: created_at and updated_at need not share a
   column type, and a text comparison would fail on the format alone. */
const stampCreated = await val(`select created_at from listings where id = $1`, [stampId]);
const stampSettled = await val(`select updated_at from listings where id = $1`, [stampId]);

await check('a row nobody has edited reports its creation date', async () =>
  (stampCreated instanceof Date && stampSettled instanceof Date &&
   stampCreated.getTime() === stampSettled.getTime())
    ? true : 'created_at is ' + stampCreated + ' and updated_at is ' + stampSettled);

/* An edit from ANY door — the table editor included, which is where a
   landlord's real price tends to get corrected. */
await sql(`update listings set notes = 'price corrected by hand' where id = $1`, [stampId]);
const stampMoved = await val(`select updated_at from listings where id = $1`, [stampId]);
await check('and an edit moves it', async () =>
  (stampMoved instanceof Date && stampSettled instanceof Date && stampMoved.getTime() > stampSettled.getTime())
    ? true : 'the stamp is still ' + stampMoved + ' after an update — the sitemap would report the registration date for ever');

await check('the public view exposes the stamp, and anon can read it', async () => {
  const col = await val(`select count(*)::int from information_schema.columns
                          where table_schema = 'public' and table_name = 'public_listings'
                            and column_name = 'updated_at'`);
  if (col !== 1) return 'public_listings does not expose updated_at — the sitemap SELECT answers 400 and quietly reports created_at instead';
  const anonStamp = await asRole('anon', () => val('select updated_at::text from public_listings where id = $1', [stampId]));
  return typeof anonStamp === 'string' && anonStamp.length ? true : 'anon cannot read the stamp through the view';
});

await check('public_listings says IF there is a description, without shipping the text', async () => {
  /* The sitemap sizes a room partly on whether it has a description, and it
     cannot read the text off the row without shipping a paragraph per room.
     The view answers the question instead. Both sides of the answer matter:
     a flag that is always true would size every room the same and look like
     it was working. */
  const col = await val(`select count(*)::int from information_schema.columns
                          where table_schema = 'public' and table_name = 'public_listings'
                            and column_name = 'has_description'`);
  if (col !== 1) return 'the view does not expose has_description — the sitemap ladder would drop it and size every room without it';
  await sql(`update listings set payload = payload || '{"desc":"Borehole water and a prepaid meter."}'::jsonb where id = $1`, [stampId]);
  const withText = await asRole('anon', () => val('select has_description from public_listings where id = $1', [stampId]));
  await sql(`update listings set payload = payload - 'desc' - 'description' where id = $1`, [stampId]);
  const without = await asRole('anon', () => val('select has_description from public_listings where id = $1', [stampId]));
  if (withText !== true) return 'a room with a description did not read as having one: ' + withText;
  if (without !== false) return 'a room with no description still read as having one: ' + without;
  return true;
});

section('10c. Why a listing is (not) on the browse board');

/* browse.html reads public_listings, which is
     where status = 'active' and tier >= 1 and env = 'production'.
   Three ANDed conditions, and the dashboard used to show none of them:
   approving a public submission by setting status alone left tier at 0,
   and the listing stayed invisible with nothing on screen to say why. */
const BOARD_CASES = [
  ['active + tier 2 + production (a normal Add Apartment save)', 'active', 2, 'production', true],
  ['active + tier 1 + production', 'active', 1, 'production', true],
  ['pending + tier 2 + production', 'pending', 2, 'production', false],
  ['inactive + tier 2 + production', 'inactive', 2, 'production', false],
  ['active + tier 0 + production \u2014 approved without a tier', 'active', 0, 'production', false],
  ['active + tier 2 + test \u2014 saved while the config said test', 'active', 2, 'test', false],
  ['draft + tier 2 + production \u2014 an invite link no admin has approved', 'draft', 2, 'production', false],
];

for (const [label, status, tier, env, shouldShow] of BOARD_CASES) {
  await check('on the board: ' + label, async () => {
    const id = await val(`insert into listings (payload, status, tier, env)
                          values (jsonb_build_object('apt_id','BOARD','prop_name',$1::text),
                                  $2::text, $3::int, $4::text)
                          returning id`, [label.slice(0, 60), status, tier, env]);
    const n = await val('select count(*)::int from public_listings where id = $1', [id]);
    if (shouldShow) return n === 1 ? true : 'a listing that should be visible is hidden from the browse board';
    return n === 0 ? true : 'a listing that should be private is readable by anon through public_listings';
  });
}

await check('an ANON visitor really can read the visible ones (it is a definer view)', async () => {
  const id = await val(`select id from listings where payload ->> 'apt_id' = 'BOARD' and status = 'active' and tier >= 1 limit 1`);
  const n = await asRole('anon', () => val('select count(*)::int from public_listings where id = $1', [id]));
  return n === 1 ? true : 'anon could not read a listing the dashboard published';
});

await check('the row is never lost \u2014 it is a filter, so the dashboard can find it', async () => {
  const hidden = await val(`select count(*)::int from listings
                             where status = 'active' and tier = 0 and env = 'production'`);
  return hidden >= 1 ? true : 'the hidden tier-0 row is not in the table at all';
});

await check('the ONE write the dashboard needs (status + tier + env) puts it on the board', async () => {
  const id = await val(`select id from listings where payload ->> 'apt_id' = 'BOARD' and tier = 0 limit 1`);
  await sql(`update listings set status = 'active', tier = 1, env = 'production' where id = $1`, [id]);
  const n = await val('select count(*)::int from public_listings where id = $1', [id]);
  return n === 1 ? true : 'after publishing, the row is still hidden \u2014 the browse board has another rule';
});

await check('the exact shape buildAddAptListing posts lands on the board', async () => {
  const id = await val(`insert into listings (session, env, source, status, tier, notes, payload)
      values ('2026/2027', 'production', 'admin_dashboard', 'active', 2, 'Added via Admin Dashboard (APT-900)',
              jsonb_build_object(
                'apt_id','APT-900','custom_id','APT-900','prop_name','Harness Lodge',
                'name_generated', false, 'ty','Self-contained','ar','Behind KWASU Gate, Malete',
                'rent','180000','rm','3 rooms available','avail','vacant','units',3,
                'nm','Alh. Kareem','ph','08012345678','contact_role','Landlord','who','Landlord',
                'desc','Running water, prepaid meter.','photo','https://example.test/cover.jpg',
                'video','','video_url','','media', jsonb_build_array(
                  jsonb_build_object('type','image','url','https://example.test/cover.jpg')),
                'split_ok', false, 'ut', jsonb_build_array('Borehole water'),
                'lat','8.139135','lng','4.0192','vf','Yes, come and check it'))
      returning id`, []);
  const r = await one(`select property_name, area, listed_price_ngn, photo_url, rooms
                         from public_listings where id = $1`, [id]);
  if (!r) return 'a normal Add Apartment save is NOT on the browse board';
  const bad = [];
  if (r.property_name !== 'Harness Lodge') bad.push('name ' + JSON.stringify(r.property_name));
  if (r.area !== 'Behind KWASU Gate, Malete') bad.push('area ' + JSON.stringify(r.area));
  if (Number(r.listed_price_ngn) !== 180000) bad.push('price ' + r.listed_price_ngn);
  if (r.photo_url !== 'https://example.test/cover.jpg') bad.push('cover ' + JSON.stringify(r.photo_url));
  return bad.length ? 'the generated columns came back wrong: ' + bad.join(', ') : true;
});

await check('and the payload it exposes is scrubbed of owner identity', async () => {
  const leaked = await val(`select (payload ? 'nm') or (payload ? 'ph') or (payload ? 'who')
                                    or (payload ? 'last') or (payload ? 'email') as x
                              from public_listings where payload ->> 'apt_id' = 'APT-900'`);
  return leaked === false ? true : 'the public view is exposing a name, phone or runner identity';
});

/* ============================================================
   12 · THE MONEY CORE
   ============================================================ */

section('12. The money core: the books, the constraints, and what stays off');

await check('storage starts switched OFF', async () =>
  (await val(`select (value = 'false'::jsonb)::int from finance_config where key = 'storage_enabled'`)) === 1);

await check('the Care Pass price defaults to 20,000 naira', async () =>
  (await val(`select (value = '2000000'::jsonb)::int from finance_config where key = 'care_pass_price_kobo'`)) === 1);

await check('the referral reward defaults to 2,000 naira', async () =>
  (await val(`select (value = '200000'::jsonb)::int from finance_config where key = 'referral_reward_kobo'`)) === 1);

await check('the marketplace fee defaults to zero', async () =>
  (await val(`select (value = '0'::jsonb)::int from finance_config where key = 'marketplace_fee_bps'`)) === 1);

await check('a payment cannot be \"paid\" with no paid_at', async () =>
  refuses(() => sql(`insert into payments (client_ref, business_line, purpose, terms_id, terms_version,
                                             amount_kobo, status, reference, subject)
                     select gen_random_uuid(), 'care', 'care_pass', id, version,
                            2000000, 'paid', 'AZ-BAD-' || gen_random_uuid(), '{\"name\":\"x\",\"phone\":\"2348000000000\"}'::jsonb
                       from product_terms where product = 'care_pass' and version = 1`), '23514'));

await check('a payment amount must be positive', async () =>
  refuses(() => sql(`insert into payments (client_ref, business_line, purpose, terms_id, terms_version,
                                             amount_kobo, status, reference, subject)
                     select gen_random_uuid(), 'care', 'care_pass', id, version,
                            0, 'pending', 'AZ-ZERO-' || gen_random_uuid(), '{}'::jsonb
                       from product_terms where product = 'care_pass' and version = 1`), '23514'));

await check('the DRAFT terms are not readable through public_terms', async () =>
  (await val(`select count(*)::int from public_terms`)) === 0);

await check('anon may read the published-terms view (it is the public price)', async () => {
  const n = await asRole('anon', () => val(`select count(*)::int from public_terms`));
  return n === 0 ? true : 'a draft leaked through public_terms';
});

await check('anon cannot read payments at all', async () =>
  refuses(() => asRole('anon', () => val(`select count(*)::int from payments`)), '42501'));

await check('anon holds no privilege at all on the ledger', async () =>
  refuses(() => asRole('anon', () => val(`select count(*)::int from ledger_entries`)), '42501'));

await check('an ADMIN cannot INSERT a ledger line (the books are server-written)', async () =>
  refuses(() => asRole('authenticated', () => sql(`insert into ledger_entries
      (entry_ref, business_line, account, direction, amount_kobo)
      values ('harness-' || gen_random_uuid(), 'care', 'cash', 'debit', 100)`), { role: 'admin' }), '42501'));

await check('nor UPDATE one', async () =>
  refuses(() => asRole('authenticated', () => sql(`update ledger_entries set amount_kobo = 1`), { role: 'admin' }), '42501'));

await check('nor DELETE one', async () =>
  refuses(() => asRole('authenticated', () => sql(`delete from ledger_entries`), { role: 'admin' }), '42501'));

await check('an admin session CAN read the books', async () => {
  const n = await asRole('authenticated', () => val(`select count(*)::int from ledger_entries`), { role: 'admin' });
  return n >= 0 ? true : 'admin could not read the ledger';
});

const paymentId = await val(`insert into payments
    (client_ref, business_line, purpose, terms_id, terms_version, amount_kobo, status, reference, subject, paid_at)
  select gen_random_uuid(), 'care', 'care_pass', id, version, 2000000, 'paid',
         'AZ-HARNESS-' || gen_random_uuid(), '{\"name\":\"Harness\",\"phone\":\"2348012345678\"}'::jsonb, now()
    from product_terms where product = 'care_pass' and version = 1
  returning id`);

await check('a referral cannot point at itself', async () =>
  refuses(() => sql(`insert into referrals (code, referrer_ref, referred_ref, status)
                     values ('SELF', '2348011111111', '2348011111111', 'pending_qualification')`), '23514'));

await check('ONE reward per qualifying payment', async () => {
  await sql(`insert into referrals (code, referrer_ref, referred_ref, qualifying_payment_id,
                                    qualifying_payment_ref, status)
            values ('A', '2348011111111', '2348022222222', $1, 'AZ-HARNESS', 'pending_qualification')`, [paymentId]);
  return refuses(() => sql(`insert into referrals (code, referrer_ref, referred_ref, qualifying_payment_id,
                                   qualifying_payment_ref, status)
            values ('B', '2348033333333', '2348044444444', $1, 'AZ-HARNESS', 'pending_qualification')`, [paymentId]), '23505');
});

await check('ONE qualification per referred customer', async () =>
  refuses(() => sql(`insert into referrals (code, referrer_ref, referred_ref, status)
                     values ('C', '2348055555555', '2348022222222', 'pending_qualification')`), '23505'));

await check('ONE published version of a product\u2019s terms', async () => {
  /* The seeded care_pass v1 is a DRAFT (published = false), so the
     first publish is legitimate and the SECOND is the violation —
     which is exactly the promise: an admin publishing new terms
     replaces the live version, it does not add a second one. */
  await sql(`insert into product_terms (product, version, terms, hash, published)
             values ('care_pass', 90, '{}'::jsonb, 'h90', true)`);
  return refuses(() => sql(`insert into product_terms (product, version, terms, hash, published)
                     values ('care_pass', 91, '{}'::jsonb, 'h91', true)`), '23505');
});

await check('care_plans carries terms_id, a window, a cap and its payment', async () => {
  const r = await one(`select
      count(*) filter (where attname in ('terms_id','terms_version','coverage_start','coverage_end','call_out_cap','payment_id','receipt_ref'))::int as n
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relname = 'care_plans' and a.attnum > 0 and not a.attisdropped`);
  return Number(r.n) === 7 ? true : 'only ' + r.n + ' of the 7 coverage columns exist';
});

await check('a coverage window cannot end before it starts', async () =>
  refuses(() => sql(`insert into care_plans (token_hash, session, payload, coverage_start, coverage_end)
                     values ('h-' || gen_random_uuid(), '2026/2027', '{}'::jsonb,
                             now(), now() - interval '1 day')`), '23514'));

await check('the ledger view reconciles to the rows behind it', async () => {
  await sql(`insert into ledger_entries (entry_ref, business_line, account, direction, amount_kobo)
            values ('h-cash-' || gen_random_uuid(), 'care', 'cash', 'debit', 2000000),
                   ('h-un-' || gen_random_uuid(), 'care', 'unearned', 'credit', 2000000),
                   ('h-ref-' || gen_random_uuid(), 'care', 'refund', 'debit', 500000)`);
  const r = await one(`select cash_in_kobo, revenue_kobo, unearned_added_kobo, refunds_kobo
                         from business_line_summary where business_line = 'care'`);
  if (!r) return 'the care line is missing from the summary';
  if (Number(r.cash_in_kobo) !== 2000000) return 'cash in = ' + r.cash_in_kobo;
  if (Number(r.revenue_kobo) !== 0) return 'cash was counted as revenue';
  if (Number(r.unearned_added_kobo) !== 2000000) return 'unearned = ' + r.unearned_added_kobo;
  if (Number(r.refunds_kobo) !== 500000) return 'refunds = ' + r.refunds_kobo;
  return true;
});

await check('housing has no revenue post anywhere in the books', async () =>
  (await val(`select count(*)::int from ledger_entries where business_line = 'housing'`)) === 0);

/* ============================================================
   13. REPAIR CLAIMS — the allowance, and who may write it
   ============================================================ */

section('13. Repair claims: one call-out, checked where it is spent');

/* The pass this section claims against: a plan with the four credits a
   Care Pass opens. */
const claimPlan = await val(`insert into care_plans (token_hash, session, payload, status,
                                              coverage_start, coverage_end, call_out_cap)
     values ('h-claim-' || gen_random_uuid(), '2026/2027', '{"name":"Claim Harness"}'::jsonb,
             'active', now(), now() + interval '120 days', 4)
     returning id`);

await sql(`insert into care_credit_events (plan_id, session, event, delta, reason)
           values ($1, '2026/2027', 'granted', 4, 'harness')`, [claimPlan]);

const claimRef = 'AZ-C-HARNESS-1';

await check('the reservation takes the first call-out and writes it on the ledger', async () => {
  const no = await val(`select claim_reserve_callout($1, $2, '2026/2027', 'Claim Harness', 'harness', 'production')`,
    [claimPlan, claimRef]);
  if (Number(no) !== 1) return 'the first reservation was numbered ' + no;
  const left = await val(`select sum(delta)::int from care_credit_events where plan_id = $1`, [claimPlan]);
  return Number(left) === 3 ? true : 'the balance after reserving is ' + left + ', not 3';
});

await check('a reservation is EXACTLY −1, and marked reserved', async () => {
  const r = await one(`select event, delta, reason from care_credit_events
                        where plan_id = $1 and event = 'reserved'`, [claimPlan]);
  if (!r) return 'no reserved row was written';
  if (Number(r.delta) !== -1) return 'a reservation moved ' + r.delta + ' credits';
  return String(r.reason).indexOf(claimRef) !== -1 ? true
    : 'the reason does not name the claim: ' + r.reason;
});

await check('the second reservation is numbered 2 — the count comes from the ledger', async () =>
  Number(await val(`select claim_reserve_callout($1, 'AZ-C-HARNESS-2', '2026/2027', 'Claim Harness', 'harness', 'production')`,
    [claimPlan])) === 2);

await check('reserving never touches the other events', async () =>
  Number(await val(`select count(*)::int from care_credit_events where plan_id = $1 and event = 'granted'`, [claimPlan])) === 1);

await check('the last two call-outs can be taken, and the fifth is REFUSED', async () => {
  await sql(`select claim_reserve_callout($1, 'AZ-C-HARNESS-3', '2026/2027', 'Claim Harness', 'harness', 'production')`, [claimPlan]);
  await sql(`select claim_reserve_callout($1, 'AZ-C-HARNESS-4', '2026/2027', 'Claim Harness', 'harness', 'production')`, [claimPlan]);
  const left = await val(`select sum(delta)::int from care_credit_events where plan_id = $1`, [claimPlan]);
  if (Number(left) !== 0) return 'the four call-outs did not all go: ' + left + ' left';
  const over = await val(`select claim_reserve_callout($1, 'AZ-C-HARNESS-5', '2026/2027', 'Claim Harness', 'harness', 'production')`,
    [claimPlan]);
  return over === null ? true : 'a FIFTH call-out was reserved on a four-call-out pass';
});

await check('and a refusal wrote nothing at all', async () =>
  Number(await val(`select count(*)::int from care_credit_events where plan_id = $1`, [claimPlan])) === 5);

await check('the balance can never go negative by reserving', async () => {
  const r = await one(`select min(total) as lowest from (
      select sum(delta) over (order by id) as total
        from care_credit_events where plan_id = $1) t`, [claimPlan]);
  return Number(r.lowest) >= 0 ? true : 'the ledger dipped to ' + r.lowest;
});

await check('releasing gives the call-out back, exactly once', async () => {
  const first = await val(`select claim_release_callout($1, $2, '2026/2027', 'Claim Harness',
                                                        'cancelled by the student', 'harness', 'production')`,
    [claimPlan, claimRef]);
  if (first !== true) return 'the release was refused';
  const again = await val(`select claim_release_callout($1, $2, '2026/2027', 'Claim Harness',
                                                        'cancelled again', 'harness', 'production')`,
    [claimPlan, claimRef]);
  if (again !== false) return 'the same call-out was given back twice';
  const left = await val(`select sum(delta)::int from care_credit_events where plan_id = $1`, [claimPlan]);
  return Number(left) === 1 ? true : 'after one release the balance is ' + left + ', not 1';
});

await check('a released call-out can be claimed again', async () => {
  const no = await val(`select claim_reserve_callout($1, 'AZ-C-HARNESS-6', '2026/2027', 'Claim Harness', 'harness', 'production')`,
    [claimPlan]);
  return Number(no) === 5 ? true : 'the fifth reservation was numbered ' + no;
});

await check('neither role may CALL the reservation functions', async () =>
  refuses(() => asRole('authenticated', () => sql(
    `select claim_reserve_callout($1, 'AZ-C-NOPE', '2026/2027', 'x', 'y', 'production')`, [claimPlan]),
  { role: 'admin' }), '42501'));

await check('nor may anon', async () =>
  refuses(() => asRole('anon', () => sql(
    `select claim_reserve_callout($1, 'AZ-C-NOPE', '2026/2027', 'x', 'y', 'production')`, [claimPlan])), '42501'));

/* ---- the claim row itself ---- */

const claimRow = await val(`insert into repair_claims
     (reference, plan_id, status, issue, student_name, student_phone)
     values ('AZ-C-ROW-1', $1, 'submitted', 'the tap will not close', 'Claim Harness', '2348012345678')
     returning id`, [claimPlan]);

await check('an unknown status is refused by the vocabulary CHECK', async () =>
  refuses(() => sql(`insert into repair_claims (reference, plan_id, status, issue)
                     values ('AZ-C-BAD-1', $1, 'nearly_done', 'a broken thing')`, [claimPlan]), '23514'));

await check('a claim with a three-word issue is not a claim', async () =>
  refuses(() => sql(`insert into repair_claims (reference, plan_id, issue)
                     values ('AZ-C-BAD-2', $1, 'tap')`, [claimPlan]), '23514'));

await check('COMPLETED without the customer\u2019s word or a named resolution is refused', async () =>
  refuses(() => sql(`update repair_claims set status = 'completed' where id = $1`, [claimRow]), '23514'));

await check('the customer\u2019s confirmation is what completes it', async () => {
  await sql(`update repair_claims set status = 'awaiting_customer' where id = $1`, [claimRow]);
  await sql(`update repair_claims set status = 'completed', customer_confirmed_at = now() where id = $1`, [claimRow]);
  return (await val(`select status from repair_claims where id = $1`, [claimRow])) === 'completed'
    ? true : 'the row did not complete';
});

await check('OR a resolution, by name \u2014 the authorized path out of a dispute', async () => {
  const other = await val(`insert into repair_claims (reference, plan_id, status, issue)
       values ('AZ-C-ROW-2', $1, 'awaiting_customer', 'the tap still drips after the visit')
       returning id`, [claimPlan]);
  /* A dispute is a status AND its reason, together — the vocabulary
     CHECK will not accept 'disputed' without one. */
  await sql(`update repair_claims set status = 'disputed', disputed_at = now(),
                    dispute_reason = 'the drip came back' where id = $1`, [other]);
  const refused = await refuses(() => sql(`update repair_claims set status = 'completed' where id = $1`, [other]), '23514');
  if (refused !== true) return 'a disputed claim completed with nothing to show';
  await sql(`update repair_claims set status = 'completed', resolved_at = now(),
                    resolution = 'revisit scheduled; the student agreed', closed_by = 'harness'
              where id = $1`, [other]);
  const after = await one(`select status, disputed_at is not null as kept, resolution
                             from repair_claims where id = $1`, [other]);
  if (after.status !== 'completed') return 'the resolution path did not complete the claim';
  /* Settling a dispute does not delete the fact that there was one. */
  if (after.kept !== true) return 'the settlement erased the dispute from the record';
  return after.resolution ? true : 'the resolution was not recorded';
});

await check('a claim that was never disputed carries no dispute stamp', async () =>
  (await val(`select count(*)::int from repair_claims
               where disputed_at is null and dispute_reason is not null`)) === 0);

await check('a dispute must carry its reason', async () =>
  refuses(() => sql(`update repair_claims set status = 'disputed', disputed_at = now(), dispute_reason = null
                      where id = $1`, [claimRow]), '23514'));

await check('a refusal (not_covered) must carry its reason too', async () =>
  refuses(() => sql(`insert into repair_claims (reference, plan_id, status, issue, eligibility)
                     values ('AZ-C-BAD-3', $1, 'rejected', 'the roof is gone', 'not_covered')`, [claimPlan]), '23514'));

await check('a reservation number and its time travel together', async () =>
  refuses(() => sql(`update repair_claims set call_out_no = 3 where id = $1`, [claimRow]), '23514'));

await check('a cost cannot be negative kobo', async () =>
  refuses(() => sql(`update repair_claims set actual_kobo = -1 where id = $1`, [claimRow]), '23514'));

await check('one call-out cannot be open on two claims of the same pass', async () => {
  await sql(`update repair_claims set call_out_no = 2, reserved_at = now(), status = 'assigned'
              where id = $1`, [claimRow]);
  return refuses(() => sql(`insert into repair_claims (reference, plan_id, status, issue, call_out_no, reserved_at)
                     values ('AZ-C-DUP', $1, 'assigned', 'the same tap again', 2, now())`, [claimPlan]), '23505');
});

/* ---- who may write ---- */

await check('an ADMIN session cannot INSERT a claim (the customer files it through the function)', async () =>
  refuses(() => asRole('authenticated', () => sql(
    `insert into repair_claims (reference, plan_id, issue) values ('AZ-C-ADMIN', $1, 'not my claim')`, [claimPlan]),
  { role: 'admin' }), '42501'));

await check('nor UPDATE one — eligibility and money are not a dashboard field', async () =>
  refuses(() => asRole('authenticated', () => sql(
    `update repair_claims set status = 'approved' where id = $1`, [claimRow]), { role: 'admin' }), '42501'));

await check('nor DELETE one', async () =>
  refuses(() => asRole('authenticated', () => sql(`delete from repair_claims`), { role: 'admin' }), '42501'));

await check('an admin session CAN read the claims', async () => {
  const n = await asRole('authenticated', () => val(`select count(*)::int from repair_claims`), { role: 'admin' });
  return n >= 1 ? true : 'an admin read ' + n + ' claims';
});

await check('and so can support \u2014 it answers the customer', async () => {
  const n = await asRole('authenticated', () => val(`select count(*)::int from repair_claims`), { role: 'support' });
  return n >= 1 ? true : 'support read ' + n + ' claims';
});

await check('marketing reads none of it', async () => {
  const n = await asRole('authenticated', () => val(`select count(*)::int from repair_claims`), { role: 'marketing' });
  return n === 0 ? true : 'marketing read ' + n + ' claims';
});

await check('anon holds no privilege at all on a claim', async () =>
  refuses(() => asRole('anon', () => val(`select count(*)::int from repair_claims`)), '42501'));

await check('the audit trail is readable but not writable, even by an admin', async () => {
  await sql(`insert into claim_events (claim_id, reference, to_status, event, actor_name)
             values ($1, 'AZ-C-ROW-1', 'submitted', 'filed', 'student link')`, [claimRow]);
  const read = await asRole('authenticated', () => val(`select count(*)::int from claim_events`), { role: 'admin' });
  if (read < 1) return 'an admin could not read the trail';
  return refuses(() => asRole('authenticated', () => sql(
    `insert into claim_events (claim_id, to_status, event)
     values ($1, 'completed', 'note')`, [claimRow]), { role: 'admin' }), '42501');
});

await check('an unknown trail event is refused with 23514', async () =>
  refuses(() => sql(`insert into claim_events (claim_id, to_status, event)
                     values ($1, 'approved', 'quietly_deleted')`, [claimRow]), '23514'));

/* Every column added after the first released version of a table has to
   be re-stated as an ALTER, because `create table if not exists` does
   nothing on the install that already has it. This is the check that
   the re-statement is really there — and that running the file again
   does not fail on it. */
await check('provider_email exists even on an install that already had the table', async () => {
  const col = await val(`select count(*)::int from information_schema.columns
                          where table_schema = 'public' and table_name = 'repair_claims'
                            and column_name = 'provider_email'`);
  if (col !== 1) {
    return 'no provider_email column \u2014 an existing install would answer 42703 the first time a ' +
      'worker is named with an email';
  }
  await sql(`alter table repair_claims add column if not exists provider_email text`);
  await sql(`update repair_claims set provider_email = 'musa@example.com' where id = $1`, [claimRow]);
  const back = await val(`select provider_email from repair_claims where id = $1`, [claimRow]);
  return back === 'musa@example.com' ? true : 'the column will not hold an address: ' + back;
});

await check('the trail takes the two events the notices and the clock write', async () => {
  await sql(`insert into claim_events (claim_id, reference, to_status, event, reason)
             values ($1, 'AZ-C-ROW-1', 'approved', 'notified', 'whatsapp: sent; email: not configured')`,
  [claimRow]);
  await sql(`insert into claim_events (claim_id, reference, to_status, event, reason)
             values ($1, 'AZ-C-ROW-1', 'approved', 'overdue_nudge', 'past its deadline for this status')`,
  [claimRow]);
  const n = await val(`select count(*)::int from claim_events
                        where event in ('notified', 'overdue_nudge')`);
  return n >= 2 ? true : 'the trail refused an event the function writes (' + n + ' row(s))';
});

await check('the claims summary reports per status, and total money is kobo', async () => {
  await sql(`update repair_claims set actual_kobo = 250000 where id = $1`, [claimRow]);
  const r = await one(`select coalesce(sum(actual_kobo),0)::bigint as total from claims_summary`);
  return Number(r.total) === 250000 ? true : 'the summary totals ' + r.total;
});

await check('a repair cost is a posting, not a column: the books take it', async () => {
  await sql(`insert into ledger_entries (entry_ref, business_line, account, direction, amount_kobo, source, memo)
             values ('AZ-C-ROW-1:cost', 'care', 'expense', 'debit', 250000, 'repair_claim', 'parts and labour'),
                    ('AZ-C-ROW-1:payable', 'care', 'payable', 'credit', 250000, 'repair_claim', 'owed to the worker')`);
  const r = await one(`select costs_kobo, payable_kobo from business_line_summary where business_line = 'care'`);
  if (Number(r.costs_kobo) < 250000) return 'the repair cost is not in the care line: ' + r.costs_kobo;
  return Number(r.payable_kobo) >= 250000 ? true : 'the provider payable is missing: ' + r.payable_kobo;
});

/* ============================================================
   13b. THE CLAIMS FILE ON A DATABASE THAT IS NOT READY FOR IT
   ============================================================ */

section('13b. supabase-claims.sql refuses a half-built database');

{
  /* A database of its own: this is the FIRST thing a person pasting
     the file into an empty project would hit, and it has to say which
     file to run rather than half-creating a claims table. */
  const bare = new PGlite();
  let raised = '';
  try {
    await bare.exec(readFileSync(join(ROOT, 'supabase-claims.sql'), 'utf8'));
  } catch (err) {
    raised = why(err);
  }

  await check('it refuses, and names supabase-team-roles.sql', async () =>
    raised.indexOf('supabase-team-roles.sql') !== -1
      ? true : (raised ? 'raised the wrong thing: ' + raised : 'it ran on an empty database'));

  await check('and leaves no half-built claims table behind', async () => {
    const r = await bare.query(`select (to_regclass('public.repair_claims') is not null)::int as x`);
    return Number(r.rows[0].x) === 0 ? true : 'repair_claims was created by a refused run';
  });

  await bare.close();
}

/* ============================================================
   13c. THE LAUNCH WAITLIST

   Everything above proves the file APPLIES. None of it proves the
   file DOES anything, and the three things this migration exists to
   guarantee are all of the form "a page could have skipped it": a
   reference nobody chose, a trail nobody had to write, and a throttle
   that is not in one process's memory. So each one is driven here as
   the actor that would try to evade it.
   ============================================================ */

section('13c. The launch waitlist \u2014 the reference, the trail, the throttle');

/* A submission exactly as the DOOR makes it — and since
   supabase-close-public-inserts.sql, the door is the only way a public
   form can reach this table. Three things are proven by driving it as the
   service role rather than as anon, which is how every earlier version of
   this section worked:

     · revoking anon's INSERT did not touch the role the function actually
       uses. If it had, the insert below would fail and the site would be
       taking no submissions at all — the failure the new file's own
       preflight exists to make impossible.
     · `Prefer: return=representation` needs SELECT on the columns it
       returns, and the function reads `saved.ref` straight out of that
       answer. anon has never had SELECT here and still does not; the
       service role does, and that asymmetry is the reason a reference can
       be handed back to a page at all. The row IS returned here, because
       that is the door's exact call — the old version of this section had
       to insert, then read as the owner, and never exercised the
       returning path at all.
     · the reference is never passed in. It is minted by the trigger, so a
       page cannot choose its own handle, and the assertion below is about
       a value the caller could not supply.

   No status, no tier, no ref, no consent column in the payload:
   everything interesting is the database's decision or the function's,
   and anything the database will not decide is a thing a page could
   forge. consent_at/consent_text ARE passed, because the function writes
   them — a row through the direct door would have had neither. */
const submittedRow = await asRole('service_role', () => one(
  `insert into demand_records
     (payload, session, env, source, consent_at, consent_text, status)
   values ($1::jsonb, $2, 'production', 'register.html', now(), $3, 'open')
   returning id, ref, follow_up_status, applicant_type`,
  [JSON.stringify({
    first: 'Proof', phone: '08030000001', age: '18 to 20', type: 'Self-contain',
    budget: 'b', dist: 'Near', when: 'This session', hp: '', consent: 'yes',
  }), '2026/2027',
   'By submitting this form I agree that Arzuz may contact me on the phone number ' +
   'or email I have given, about my housing request and about rooms Arzuz matches to it.']));

await check('the anon door cannot read its own row back', () =>
  refuses(() => asRole('anon', () => sql(
    `select ref from demand_records where phone = '08030000001'`)), '42501'));

await check('the reference is minted server-side, and reads like one', async () =>
  /^ARZ-S-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(String(submittedRow.ref))
    ? true : 'the row came back with ref = ' + submittedRow.ref);

await check('and the registry knows it \u2014 one handle, unique across both waitlist sides', async () =>
  (await val(`select count(*)::int from waitlist_ref_registry where ref = $1`, [submittedRow.ref])) === 1
    ? true : 'the reference is not in waitlist_ref_registry, so nothing guarantees it is unique');

await check('a row that arrives with no pipeline stage lands in the pipeline', async () =>
  submittedRow.follow_up_status === 'new' && submittedRow.applicant_type === 'student'
    ? true : 'follow_up_status=' + submittedRow.follow_up_status + ' applicant_type=' + submittedRow.applicant_type);

await check('the submission audited itself as the SERVICE ROLE, without any page asking it to', async () => {
  const r = await one(`select action, actor_role from staff_audit_log
                        where ref = $1 order by id desc limit 1`, [submittedRow.ref]);
  if (!r) return 'nothing was written to the trail for ' + submittedRow.ref;
  /* BOTH halves, because each is a different fact and the older version of
     this check asserted a pair that could no longer happen. 'submitted' is
     the trail's one word for "a member of the public put this here", and
     the public arrives as the service role now that anon cannot insert —
     supabase-waitlist-launch.sql's action branch names it for exactly that
     reason. actor_role still says WHICH actor, and 'service_role' is the
     truth: a runner that recorded 'anon' here would be describing a visitor
     who never touched the database. */
  return (r.action === 'submitted' && r.actor_role === 'service_role')
    ? true : 'the trail says ' + r.action + ' by ' + r.actor_role;
});

await check('  …and the sentence the person agreed to is stored with the moment they agreed', async () => {
  const r = await one(`select consent_at, consent_text from demand_records where id = $1`,
    [submittedRow.id]);
  if (!r.consent_at) return 'consent_at was not recorded';
  if (!r.consent_text || r.consent_text.indexOf('agree that Arzuz may contact me') === -1) {
    return 'consent_text is ' + JSON.stringify(r.consent_text) + ' — a row carrying a time but no sentence ' +
      'cannot say what was agreed to, which is the reason the door writes it and the direct path could not';
  }
  return true;
});

/* ---- AND THE DIRECT DOOR, WHICH NO LONGER EXISTS ----------------

   This is what supabase-close-public-inserts.sql was written for. Every
   earlier version of this section inserted as `anon`, because anon could
   still open that door: a bot posting straight to PostgREST with the key
   the page ships was a submission the function never saw and the throttle
   never counted. The grant is gone, so the claim is asserted from three
   sides — the ACL, a real refusal on each of the five tables, and the
   fact that the role which DOES write still can. */

const PUBLIC_TABLES = ['demand_records', 'listings', 'scout_submissions',
  'booking_requests', 'support_tickets'];

await check('no key that reaches a browser may insert into any of the five public tables', async () => {
  const r = await sql(`select t, has_table_privilege('anon', t, 'insert')::int as c
                         from unnest($1::text[]) as t`, [PUBLIC_TABLES]);
  const bad = r.rows.filter((x) => x.c === 1).map((x) => x.t);
  return bad.length ? 'anon can still insert into: ' + bad.join(', ') : true;
});

await check('  \u2026and the DOOR still can, on all five \u2014 closing one door must not close the site', async () => {
  const r = await sql(`select t, has_table_privilege('service_role', t, 'insert')::int as c
                         from unnest($1::text[]) as t`, [PUBLIC_TABLES]);
  const bad = r.rows.filter((x) => x.c === 0).map((x) => x.t);
  return bad.length ? 'the service role cannot insert into: ' + bad.join(', ') +
    ' \u2014 this is the door broken, and the site taking nothing' : true;
});

await check('a bot holding the page\u2019s own key is refused by the DATABASE, on every one of them', async () => {
  const refused = [];
  for (const t of PUBLIC_TABLES) {
    /* `default values`, on purpose: the row is deliberately one a NOT NULL
       constraint would also reject, and 42501 rather than 23502 is what
       proves the refusal is the missing GRANT rather than the shape of
       what was posted. */
    const r = await refuses(() => asRole('anon', () => sql(`insert into ${t} default values`)), '42501');
    if (r !== true) refused.push(t + ' \u2192 ' + r);
  }
  return refused.length ? refused.join(' | ') : true;
});

const registryBefore = await val(`select count(*)::int from waitlist_ref_registry`);
await check('and a bot with a filled honeypot is refused before any validator is even reached', () =>
  refuses(() => asRole('anon', () => sql(
    `insert into demand_records (payload) values ($1::jsonb)`,
    [JSON.stringify({ first: 'Bot', phone: '08030000002', age: '18 to 20', hp: 'http://spam.example' })])), '42501'));

await check('  \u2026and a refused bot leaves no orphan reference behind', async () =>
  (await val(`select count(*)::int from waitlist_ref_registry`)) === registryBefore
    ? true : 'the refusal still minted a reference \u2014 the registry grows on rejected rows');

/* A staff change, as the dashboard makes it. */
await asRole('authenticated', () => sql(
  `update demand_records set follow_up_status = 'contacted', assigned_to = 'ops@arzuz.com' where id = $1`,
  [submittedRow.id]), { role: 'admin' });

await check('a staff change names the columns that moved, and who moved them', async () => {
  const r = await one(`select action, actor_role, actor_id, changed_columns from staff_audit_log
                        where ref = $1 and action = 'update' order by id desc limit 1`, [submittedRow.ref]);
  if (!r) return 'the update wrote nothing to the trail';
  if (r.action !== 'update' || r.actor_role !== 'admin') return 'the trail says ' + r.action + ' by ' + r.actor_role;
  if (!r.actor_id) return 'the trail cannot say WHO, only what role';
  const moved = (r.changed_columns || []).join(',');
  return moved === 'assigned_to,follow_up_status' ? true : 'changed_columns = ' + moved;
});

const trailBefore = await val(`select count(*)::int from staff_audit_log`);
await check('an update that moves nothing the trail watches writes nothing', async () => {
  await asRole('authenticated', () => sql(
    `update demand_records set payload = payload where id = $1`, [submittedRow.id]), { role: 'admin' });
  const after = await val(`select count(*)::int from staff_audit_log`);
  return after === trailBefore ? true : 'a no-op update buried the real lines under ' + (after - trailBefore) + ' of its own';
});

await check('the trail cannot be written by the admin it records', () =>
  refuses(() => asRole('authenticated', () => sql(
    `insert into staff_audit_log (table_name, action) values ('demand_records', 'forged')`),
  { role: 'admin' }), '42501'));

await check('nor edited, nor erased', async () => {
  const edited = await refuses(() => asRole('authenticated', () => sql(
    `update staff_audit_log set action = 'nothing' where id = (select min(id) from staff_audit_log)`),
  { role: 'admin' }), '42501');
  if (edited !== true) return edited;
  return refuses(() => asRole('authenticated', () => sql(
    `delete from staff_audit_log where id = (select min(id) from staff_audit_log)`),
  { role: 'admin' }), '42501');
});

await check('nor read at all with an anon key', () =>
  refuses(() => asRole('anon', () => sql(`select count(*) from staff_audit_log`)), '42501'));

/* ============================================================
   13d. THE FIVE ROLES, AS POSTGRES COMPUTES THEM

   The spec's vocabulary is reconciled with this file's older names in
   exactly one place, public.arzuz_role(), and this is that mapping
   asserted rather than trusted. The last row is the one that matters
   most: an UNRECOGNISED claim falls through to `authenticated` and is
   read as the main admin, which is why team.js validates the role it
   writes against a closed list.
   ============================================================ */

section('13d. The five roles, and what each one can reach');

const ROLE_MATRIX = [
  ['anon', null, 'anon'],
  /* The seventh value, and the one that only exists because the public
     forms are written by a server now: the service role is not 'anon' and
     not 'authenticated', so it falls to the else branch and answers as
     itself. That is what the audit trail records for a public submission,
     and supabase-waitlist-launch.sql's action branch names it. It matters
     that this is asserted rather than assumed: if arzuz_role() ever
     normalised it to 'anon', the trail would start describing a visitor
     who never touched the database. */
  ['service_role', null, 'service_role'],
  ['authenticated', null, 'admin'],
  ['authenticated', { role: 'admin' }, 'admin'],
  ['authenticated', { role: 'super_admin' }, 'admin'],
  ['authenticated', { role: 'operations' }, 'support'],
  ['authenticated', { role: 'support' }, 'support'],
  ['authenticated', { role: 'verification' }, 'verification'],
  ['authenticated', { role: 'finance' }, 'finance'],
  ['authenticated', { role: 'marketing' }, 'marketing'],
  ['authenticated', { role: 'wizard' }, 'admin'],
];

for (const [claimRole, meta, want] of ROLE_MATRIX) {
  await check('a token claiming ' + (meta ? meta.role : claimRole) + ' is read as ' + want, async () => {
    await setClaims(claimRole, meta);
    const got = await val('select public.arzuz_role()');
    await clearClaims();
    return got === want ? true : 'arzuz_role() answered ' + got;
  });
}

await check('marketing reads no waitlist row at all \u2014 zero, not a hidden column', async () =>
  (await asRole('authenticated', () => val(
    `select count(*)::int from demand_records where id = $1`, [submittedRow.id]), { role: 'marketing' })) === 0
    ? true : 'a marketing login read a demand row');

await check('finance reads no waitlist row either: it has the books, not the people', async () =>
  (await asRole('authenticated', () => val(
    `select count(*)::int from demand_records where id = $1`, [submittedRow.id]), { role: 'finance' })) === 0
    ? true : 'a finance login read a demand row');

/* A real listing to verify: an UPDATE against `where false` proves
   nothing, because the planner never evaluates the policy for a scan
   that returns no rows. The room has to exist for "approving it" to
   mean anything. */
await sql(`insert into listings (payload, status, tier)
           values ($1::jsonb, 'pending', 0)`,
  [JSON.stringify({ nm: 'Proof Owner', ph: '08030000003', rent: '150000',
    ar: 'Malete', ty: 'Self-contain', rm: '1', hp: '' })]);

const proofListing = await one(`select id from listings where owner_phone = '08030000003'`);

/* THE APPROVE IS THE RPC, AND THE RPC IS THE ONLY WRITE. Two facts, and
   they are different facts: that the officer's decision lands, and that
   nothing else about the row moved while it did. The second one used to
   be untrue by construction — the policy this replaced was an UPDATE on
   the ROW, so an approving officer could also change the price
   (LAUNCH-READINESS.md risk 2). */
await check('verification may read a listing, and approve it through the RPC', async () => {
  const read = await asRole('authenticated', () => val(
    `select count(*)::int from listings where owner_phone = '08030000003'`),
  { role: 'verification' });
  if (!read) return 'verification cannot read a listing, so it cannot verify anything';

  const out = await asRole('authenticated', () => one(
    `select public.listing_verify($1::uuid, 'active', 1) as r`, [proofListing.id]),
  { role: 'verification' });

  const after = await one(`select status, tier, verified_at, verified_by from listings where id = $1`,
    [proofListing.id]);
  if (after.status !== 'active' || Number(after.tier) !== 1)
    return 'the approval did not land: status=' + after.status + ' tier=' + after.tier;
  /* The two columns that turn "it is live" into "somebody went and
     looked" — the only record on this site that answers a student
     asking what exactly was checked. */
  if (!after.verified_at) return 'nothing recorded WHEN it was verified';
  if (!after.verified_by) return 'nothing recorded WHO verified it';
  if (!out || !out.r || out.r.verified_by !== after.verified_by)
    return 'the function answered ' + JSON.stringify(out) + ' but the row says ' + after.verified_by;
  return out.r.status === 'active' && Number(out.r.tier) === 1
    ? true : 'the function answered ' + JSON.stringify(out);
});

await check('  the four columns it may move are the only ones that moved', async () => {
  await sql(`update listings set opening_ask_ngn = 150000, env = 'production', notes = 'field note'
              where id = $1`, [proofListing.id]);
  await asRole('authenticated', () => sql(
    `select public.listing_verify($1::uuid, 'rejected', 0)`, [proofListing.id]), { role: 'verification' });

  const after = await one(`select status, tier, opening_ask_ngn, env, notes, payload
                             from listings where id = $1`, [proofListing.id]);
  if (after.status !== 'rejected' || Number(after.tier) !== 0)
    return 'the decision did not land: status=' + after.status + ' tier=' + after.tier;
  if (Number(after.opening_ask_ngn) !== 150000) return 'the price moved with it: ' + after.opening_ask_ngn;
  if (after.env !== 'production') return 'the environment moved with it: ' + after.env;
  if (after.notes !== 'field note') return 'the notes moved with it: ' + after.notes;
  return (after.payload || {}).ph === '08030000003' ? true : 'the payload moved with it';
});

await check('and the trail records the approval, against the officer who made it', async () => {
  const r = await one(`select actor_role, changed_columns, after_row from staff_audit_log
                         where table_name = 'listings' and action = 'update'
                         order by id desc limit 1`);
  if (!r) return 'the change was not recorded at all';
  if (r.actor_role !== 'verification') return 'the trail says ' + r.actor_role + ' made the change';
  const moved = r.changed_columns || [];
  const missing = ['status', 'tier', 'verified_at'].filter((c) => moved.indexOf(c) === -1);
  if (missing.length) return 'the trail does not name ' + missing.join(', ') + ' — it says ' + moved.join(', ');
  return (r.after_row || {}).verified_by
    ? true : 'the trail does not record WHO signed the approval off';
});

/* THE WITHDRAWAL, DRIVEN. With no applicable UPDATE policy a write is not
   refused with an error the way an INSERT is: the row is simply not
   visible to the statement, so it SUCCEEDS and changes nothing. That is
   why this asserts on the ROW and not on a 42501 — asserting the wrong
   mechanism would pass for the wrong reason the day RLS changes. */
await check('a row-wide PATCH by a verification token now changes nothing at all', async () => {
  const before = await one(`select status, tier, opening_ask_ngn, env, notes from listings where id = $1`,
    [proofListing.id]);
  await asRole('authenticated', () => sql(
    `update listings set status = 'active', tier = 2, opening_ask_ngn = 999999,
                         env = 'test', notes = 'written wide'
      where id = $1`, [proofListing.id]), { role: 'verification' });
  const after = await one(`select status, tier, opening_ask_ngn, env, notes from listings where id = $1`,
    [proofListing.id]);
  const moved = ['status', 'tier', 'opening_ask_ngn', 'env', 'notes']
    .filter((c) => String(before[c]) !== String(after[c]));
  return moved.length ? 'a withdrawn policy still let it write ' + moved.join(', ') : true;
});

await check('and no UPDATE policy on listings names verification — the withdrawal is in the catalog', async () => {
  const ups = (await sql(`select policyname, roles::text as roles, coalesce(qual, '') as qual
                            from pg_policies
                           where schemaname = 'public' and tablename = 'listings' and cmd = 'UPDATE'`)).rows;
  const wide = ups.filter((r) => r.roles.indexOf('verification') !== -1 || r.qual.indexOf('verification') !== -1);
  if (wide.length) return 'a verification UPDATE policy survived: ' + wide.map((r) => r.policyname).join(', ');
  return ups.some((r) => r.policyname === 'admin can update listings')
    ? true : 'the admin UPDATE policy is gone too — the narrowing fell on the wrong role';
});

await check('and only the roles it names may call it: marketing, support, finance and anon are refused', async () => {
  for (const meta of [{ role: 'marketing' }, { role: 'support' }, { role: 'finance' }]) {
    const r = await refuses(() => asRole('authenticated', () => sql(
      `select public.listing_verify($1::uuid, 'active', 1)`, [proofListing.id]), meta), '42501');
    if (r !== true) return 'a ' + meta.role + ' token was admitted: ' + r;
  }
  const anon = await refuses(() => asRole('anon', () => sql(
    `select public.listing_verify($1::uuid, 'active', 1)`, [proofListing.id])), '42501');
  return anon === true ? true : 'an anon key reached the function: ' + anon;
});

/* Deleting is the ADMIN's, not the inspector's — and the shape of the
   refusal is the interesting part, because RLS does not refuse a
   DELETE the way it refuses an INSERT. With no applicable policy the
   row is simply not visible, so the statement SUCCEEDS and removes
   NOTHING. Asserting on the 42501 here would have been asserting the
   wrong mechanism; what matters is that the listing is still there. */
await check('and may not remove a listing — the delete takes nothing', async () => {
  const before = await val(`select count(*)::int from listings`);
  await asRole('authenticated', () => sql(`delete from listings`), { role: 'verification' });
  const after = await val(`select count(*)::int from listings`);
  return after < before ? 'a verification login deleted ' + (before - after) + ' listing(s)' : true;
});

/* THE ROW-WIDE HALF IS NO LONGER TRUE, AND THAT IS THE POINT OF
   THIS FILE. Until supabase-verification-rpc.sql landed, the check where
   this comment sits asserted the opposite: that an officer's price change
   was allowed and merely recorded. It is now refused — by the absence of
   any policy, which is asserted two checks above — and the decision
   itself is the RPC. A narrowing nobody drove would be a comment. */

await check('and may not file a demand, a booking or a ticket', async () => {
  const demand = await refuses(() => asRole('authenticated', () => sql(
    `insert into demand_records (payload) values ('{}'::jsonb)`), { role: 'verification' }), '42501');
  if (demand !== true) return 'verification can insert a demand: ' + demand;

  /* A SELECT with no policy is ZERO ROWS, not an error — the same
     silence marketing gets on every table. */
  const bookings = await asRole('authenticated', () => val(`select count(*)::int from booking_requests`),
    { role: 'verification' });
  if (bookings === null) return 'verification could not even run the count';
  return bookings === 0 ? true : 'verification read ' + bookings + ' booking row(s)';
});

await check('the books moved to finance, and support has no policy on them any more', async () => {
  const MONEY = `('finance_config','product_terms','payments','ledger_entries','referrals','referral_codes')`;
  const r = await sql(`select policyname from pg_policies
                        where schemaname = 'public' and tablename in ` + MONEY);
  const names = r.rows.map((x) => x.policyname);
  const stale = names.filter((n) => n.indexOf('support reads') === 0);
  if (stale.length) return 'support still reads the books: ' + stale.join(', ');
  const have = names.filter((n) => n.indexOf('finance reads') === 0);
  return have.length === 6 ? true : 'only ' + have.length + ' of the six finance read policies exist';
});

/* ============================================================
   13e. THE THROTTLE

   In the database on purpose: Netlify runs as many instances as it
   likes, and a counter in one process's memory is a counter per
   process. Driven here as the function drives it, at the exact
   defaults it passes, with the ceilings narrowed to make each refusal
   happen on the second call rather than the sixtieth.
   ============================================================ */

section('13e. The throttle, and the keys that may not run it');

await check('the first attempt is allowed and the immediate second is not', async () => {
  const first = await one(`select public.waitlist_throttle($1, 'demand_records', 60, 4, 4000) as v`, ['proof-ip-one']);
  const second = await one(`select public.waitlist_throttle($1, 'demand_records', 60, 4, 4000) as v`, ['proof-ip-one']);
  if (!first.v || first.v.allow !== true) return 'the first attempt was refused: ' + JSON.stringify(first.v);
  return (second.v && second.v.allow === false && second.v.reason === 'gap')
    ? true : 'the second attempt in the same second was not refused: ' + JSON.stringify(second.v);
});

await check('and the hourly ceiling refuses the attempt after the last allowed one', async () => {
  await sql(`select public.waitlist_throttle($1, 'demand_records', 1, 0, 4000)`, ['proof-ip-two']);
  const second = await one(`select public.waitlist_throttle($1, 'demand_records', 1, 0, 4000) as v`, ['proof-ip-two']);
  return (second.v && second.v.allow === false && second.v.reason === 'hour')
    ? true : 'the attempt past a ceiling of one was not refused: ' + JSON.stringify(second.v);
});

await check('and a global ceiling survives the sum of every address', async () => {
  const r = await one(`select public.waitlist_throttle($1, 'demand_records', 1000, 0, 1) as v`, ['proof-ip-three']);
  return (r.v && r.v.allow === false && r.v.reason === 'global')
    ? true : 'the global ceiling did not fire: ' + JSON.stringify(r.v);
});

await check('a refused attempt is still counted, so a throttled client stays throttled', async () =>
  (await val(`select count(*)::int from submission_guard where ip_hash = $1 and outcome <> 'allowed'`, ['proof-ip-one'])) >= 1
    ? true : 'refused attempts are not recorded, so the next one starts from a clean slate');

await check('no key that reaches a browser may run the throttle', async () => {
  const SIG = 'public.waitlist_throttle(text,text,integer,integer,integer)';
  const r = await one(`select has_function_privilege('anon', $1, 'execute')::int as a,
                              has_function_privilege('authenticated', $1, 'execute')::int as b`, [SIG]);
  return (r.a === 0 && r.b === 0) ? true : 'anon=' + r.a + ' authenticated=' + r.b;
});

await check('the reference registry is not a table any browser can read either', async () => {
  const a = await refuses(() => asRole('anon', () => sql(`select ref from waitlist_ref_registry`)), '42501');
  if (a !== true) return a;
  return refuses(() => asRole('authenticated', () => sql(`select ref from waitlist_ref_registry`),
    { role: 'admin' }), '42501');
});

await check('nor the attempt log — it is a guard, not a report', async () => {
  const a = await refuses(() => asRole('anon', () => sql(`select * from submission_guard`)), '42501');
  if (a !== true) return a;
  return refuses(() => asRole('authenticated', () => sql(`select * from submission_guard`),
    { role: 'admin' }), '42501');
});

await check('the honeypot is still in the anon insert policies \u2014 armed, and no longer reachable by a browser', async () => {
  /* Both halves matter. The policies are now unreachable: anon holds no
     INSERT on any of the five tables, so no anon request gets as far as
     a policy. supabase-close-public-inserts.sql keeps them rather than
     dropping them, because a re-grant should meet the honeypot guard
     rather than have to re-derive it — so this asserts they are STILL
     THERE, with their predicate intact, and the five grants are asserted
     gone in §13c. If a later tidy-up drops these policies, the guard
     that would re-arm is gone with them. */
  const r = await sql(`select tablename, policyname, coalesce(with_check, qual)::text as expression
                         from pg_policies
                        where schemaname = 'public' and cmd = 'INSERT'
                          and roles::text like '%anon%'`);
  const five = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets'];
  const missing = five.filter((t) => !r.rows.some((x) => x.tablename === t));
  if (missing.length) return 'the anon insert policy is gone from: ' + missing.join(', ');
  const unhoneypotted = r.rows.filter((x) => five.includes(x.tablename))
    .filter((x) => String(x.expression || '').indexOf('hp') === -1)
    .map((x) => x.policyname);
  return unhoneypotted.length ? 'these no longer mention the honeypot: ' + unhoneypotted.join(', ') : true;
});

/* ============================================================
   13f. The status page — the code, the throttle of its own, the reveal

   supabase-status-codes.sql is the whole of what a student can ask
   the database by themselves. It is driven here the way the function
   drives it, with the ceilings narrowed so a refusal happens on the
   second call rather than the sixtieth — and with the three claims
   that matter asserted as behaviour rather than as columns:

     · a code is a HASH, and a spent code is not a reusable one
     · the lookup counter cannot reach the waitlist's, in either
       direction — that is why it has a table of its own
     · the reveal is the stage and nothing else: not the phone, not
       the name, not the answers
   ============================================================ */

section('13f. The status page \u2014 the code, its own throttle, and the reveal');

const CODE_ROW = 'the-hash-netlify-functions-status-js-would-compute';

await check('neither table is reachable with a key that ships to a browser', async () => {
  const r = await sql(`select tablename, rowsecurity,
                              (select count(*) from pg_policies p
                                where p.schemaname = 'public' and p.tablename = t.tablename)::int as policies
                         from pg_tables t
                        where schemaname = 'public' and tablename in ('status_codes','status_guard')`);
  if (r.rows.length !== 2) return 'expected two tables, found ' + r.rows.map((x) => x.tablename).join(', ');
  const open = r.rows.filter((x) => !x.rowsecurity || x.policies !== 0);
  if (open.length) {
    return open.map((x) => x.tablename + ' rowsecurity=' + x.rowsecurity + ' policies=' + x.policies).join(', ') +
      ' \u2014 RLS with NO policy is what denies every browser role';
  }
  const a = await refuses(() => asRole('anon', () => sql(`select * from status_codes`)), '42501');
  if (a !== true) return 'anon read status_codes: ' + a;
  return refuses(() => asRole('authenticated', () => sql(`select * from status_guard`), { role: 'admin' }), '42501');
});

await check('no browser role may execute any of the three functions; the service role may', async () => {
  const sigs = ['public.status_throttle(text,text,integer,integer,integer)',
    'public.status_open(text,text,integer,integer)',
    'public.status_verify(text,text,integer)'];
  const bad = [];
  for (const sig of sigs) {
    const r = await one(`select has_function_privilege('anon', $1, 'execute')::int as a,
                                has_function_privilege('authenticated', $1, 'execute')::int as b,
                                has_function_privilege('service_role', $1, 'execute')::int as c`, [sig]);
    if (r.a !== 0 || r.b !== 0) bad.push(sig + ' anon=' + r.a + ' authenticated=' + r.b);
    if (r.c !== 1) bad.push(sig + ' the service role cannot run it');
  }
  return bad.length ? bad.join('; ') : true;
});

await check('the lookup is throttled per address, and per step', async () => {
  const first = await one(`select public.status_throttle($1, 'send', 2, 0, 300) as v`, ['status-ip-one']);
  if (!first.v || first.v.allow !== true) return 'the first lookup was refused: ' + JSON.stringify(first.v);
  const second = await one(`select public.status_throttle($1, 'send', 2, 0, 300) as v`, ['status-ip-one']);
  const third = await one(`select public.status_throttle($1, 'send', 2, 0, 300) as v`, ['status-ip-one']);
  if (!second.v || second.v.allow !== true) return 'the second lookup was refused: ' + JSON.stringify(second.v);
  return (third.v && third.v.allow === false && third.v.reason === 'hour')
    ? true : 'the lookup past a ceiling of two was not refused: ' + JSON.stringify(third.v);
});

await check('  \u2026and asking for a code does not spend the VERIFY step\u2019s budget', async () => {
  /* The two steps are different questions and one counter would make the
     second wait out the first. 'status-ip-one' has just used its whole
     'send' hour; a 'verify' from the same address must still be allowed. */
  const r = await one(`select public.status_throttle($1, 'verify', 1, 0, 300) as v`, ['status-ip-one']);
  return (r.v && r.v.allow === true) ? true
    : 'the verify step was refused by the send step\u2019s count: ' + JSON.stringify(r.v);
});

await check('a lookup cannot throttle the waitlist, or the reverse \u2014 two counters, two tables', async () => {
  const before = await val(`select count(*)::int from submission_guard`);
  const r = await one(`select public.status_throttle($1, 'send', 10, 0, 300) as v`, ['status-ip-two']);
  const after = await val(`select count(*)::int from submission_guard`);
  if (after !== before) return 'a status lookup wrote to submission_guard, so a lookup flood would throttle real submissions';
  if (!r.v || r.v.allow !== true) return 'the lookup was refused: ' + JSON.stringify(r.v);
  const mine = await val(`select count(*)::int from status_guard where ip_hash = $1`, ['status-ip-two']);
  return mine === 1 ? true : 'the lookup was not counted anywhere (' + mine + ' rows)';
});

await check('and the status guard holds no reference \u2014 it is not a log of who asked about whom', async () => {
  const cols = await sql(`select column_name from information_schema.columns
                           where table_schema = 'public' and table_name = 'status_guard'`);
  const names = cols.rows.map((r) => r.column_name);
  return names.indexOf('ref') === -1 && names.indexOf('ip') === -1
    ? true : 'status_guard carries ' + names.join(', ');
});

await check('a code is issued against a real reference, stored as a hash, and given ten minutes', async () => {
  const r = await one(`select public.status_open($1, $2, 600, 5) as v`, [submittedRow.ref, CODE_ROW]);
  if (!r.v || r.v.ok !== true) return 'issuing was refused: ' + JSON.stringify(r.v);
  const row = await one(`select code_hash, expires_at, consumed_at, attempts,
                                round(extract(epoch from (expires_at - created_at)))::int as ttl
                           from status_codes where id = $1`, [r.v.code_id]);
  if (!row) return 'no code row was written';
  if (row.code_hash !== CODE_ROW) return 'the code was stored as something else entirely \u2014 ' + row.code_hash;
  if (row.consumed_at) return 'the code was born consumed';
  if (row.attempts !== 0) return 'it starts with ' + row.attempts + ' attempts spent';
  return row.ttl === 600 ? true : 'the code lives ' + row.ttl + ' seconds, not 600';
});

await check('a second code kills the first \u2014 only the newest one is live', async () => {
  const first = await one(`select public.status_open($1, $2, 600, 5) as v`, [submittedRow.ref, CODE_ROW]);
  const second = await one(`select public.status_open($1, $2, 600, 5) as v`, [submittedRow.ref, CODE_ROW]);
  if (!first.v.ok || !second.v.ok) return 'issuing was refused: ' + JSON.stringify([first.v, second.v]);
  const live = await val(`select count(*)::int from status_codes
                           where ref = $1 and consumed_at is null and expires_at > now()`, [submittedRow.ref]);
  if (live !== 1) return live + ' codes are live at once \u2014 a student who asks twice leaves two ways in';
  const older = await one(`select consumed_at, expires_at <= now() as dead from status_codes where id = $1`, [first.v.code_id]);
  return older && older.dead === true ? true : 'the older code is still live: ' + JSON.stringify(older);
});

await check('  \u2026but a spent code still counts against the reference\u2019s hour', async () => {
  /* The ceiling counts ISSUED codes, spent or not — a count that forgot the
     spent ones is a count an attacker can spend around, which is the whole
     reason rows here are kept rather than deleted on use. */
  await one(`select public.status_open($1, $2, 600, 2) as v`, ['ARZ-S-0000-0000-0000', CODE_ROW]);
  const second = await one(`select public.status_open($1, $2, 600, 2) as v`, ['ARZ-S-0000-0000-0000', CODE_ROW]);
  const third = await one(`select public.status_open($1, $2, 600, 2) as v`, ['ARZ-S-0000-0000-0000', CODE_ROW]);
  if (!second.v.ok) return 'the second code was refused: ' + JSON.stringify(second.v);
  return (third.v.ok === false && third.v.reason === 'ref_limited') ? true
    : 'the third code against a ceiling of two was not refused: ' + JSON.stringify(third.v);
});

await check('a wrong code is wrong, and it costs an attempt every time', async () => {
  /* The ceiling is the CODE's since supabase-status-history.sql §1, and the
     20 below is the point of doing it here: a caller that claims a bigger
     budget than the code was issued with does not get one. The ceiling is
     written onto the row the way that file's ALTER and its column default
     do, because the issue path no longer takes it as a parameter at all. */
  const opened = await one(`select public.status_open($1, $2, 600, 5) as v`, [submittedRow.ref, CODE_ROW]);
  await sql(`update status_codes set max_attempts = 3 where id = $1`, [opened.v.code_id]);
  const r = await one(`select public.status_verify($1, 'not-the-hash', 20) as v`, [submittedRow.ref]);
  if (!r.v || r.v.ok !== false || r.v.reason !== 'wrong') return JSON.stringify(r.v);
  if (r.v.limit !== 3) return 'a claimed ceiling of twenty was honoured over the code\u2019s own three: limit ' + r.v.limit;
  if (r.v.attempts_left !== 2) return 'a ceiling of three reports ' + r.v.attempts_left + ' left after one try';
  const spent = await val(`select max(attempts)::int from status_codes
                            where ref = $1 and consumed_at is null and expires_at > now()`, [submittedRow.ref]);
  return spent === 1 ? true : 'the attempt was not recorded (' + spent + ')';
});

await check('  \u2026and the attempt past the last one is refused rather than compared', async () => {
  await sql(`update status_codes set max_attempts = 1
              where ref = $1 and consumed_at is null and expires_at > now()`, [submittedRow.ref]);
  await one(`select public.status_verify($1, 'not-the-hash', 1) as v`, [submittedRow.ref]);
  const past = await one(`select public.status_verify($1, $2, 1) as v`, [submittedRow.ref, CODE_ROW]);
  return (past.v && past.v.ok === false && past.v.reason === 'too-many') ? true
    : 'the CORRECT code was still accepted after the attempts were spent: ' + JSON.stringify(past.v);
});

await check('a reference nobody has asked about has no code to verify', async () => {
  /* A WELL-FORMED reference that was never minted, not a mnemonic. The
     fixture here used to be 'ARZ-S-NEVER-ASKED-0', which is not a
     reference this site can produce at all — so the test proved that a
     MALFORMED string has no code, which is a different (and weaker) claim
     than the one it reads as: that a real reference nobody has asked about
     is refused. Same answer either way today, different answer the moment
     anything validates the shape.

     AND THE FIXTURE IS ASSERTED, so it cannot rot back into a mnemonic.
     status_verify does not read the shape at all, so it could not tell
     the two apart; status_history does, and it is the one reader on this
     site that knows what a reference is. Reading the fixture through it
     first is what makes the claim below the claim it says. */
  const UNMINTED = 'ARZ-S-0000-0000-0002';
  const read = await asRole('authenticated', () => one(
    `select public.status_history($1) as h`, [UNMINTED]), { role: 'support' });
  const look = read && read.h && read.h.lookup;
  if (look !== 'ref') {
    return 'the fixture is not a reference at all (read as ' + look + '), so this check proves nothing about a reference';
  }
  const r = await one(`select public.status_verify($1, $2, 5) as v`, [UNMINTED, CODE_ROW]);
  return (r.v && r.v.ok === false && r.v.reason === 'no-code') ? true : JSON.stringify(r.v);
});

await check('  \u2026and a code that was right about a row that is gone says so rather than nothing', async () => {
  /* The registry minted 'ARZ-S-0000-0000-0000' above but no table holds it,
     which is the row-was-deleted-by-hand case. A 200 with an empty reveal
     would be the worst answer here: the person proved themselves and got
     a blank page with no way to tell why. */
  await one(`select public.status_open($1, $2, 600, 5) as v`, ['ARZ-S-0000-0000-0000', CODE_ROW]);
  const r = await one(`select public.status_verify($1, $2, 5) as v`, ['ARZ-S-0000-0000-0000', CODE_ROW]);
  return (r.v && r.v.ok === false && r.v.reason === 'gone') ? true : JSON.stringify(r.v);
});

await check('the right code reveals the STAGE \u2014 and reveals nothing about the person', async () => {
  const opened = await one(`select public.status_open($1, $2, 600, 5) as v`, [submittedRow.ref, CODE_ROW]);
  if (!opened.v.ok) return 'issuing was refused: ' + JSON.stringify(opened.v);
  const r = await one(`select public.status_verify($1, $2, 5) as v`, [submittedRow.ref, CODE_ROW]);
  if (!r.v || r.v.ok !== true || r.v.reason !== 'matched') return JSON.stringify(r.v);
  const rev = r.v.reveal || {};
  if (rev.ref !== submittedRow.ref) return 'the reveal is about ' + rev.ref;
  if (rev.kind !== 'student') return 'a demand_records reference revealed as ' + rev.kind;
  /* Compared against the ROW, not against a literal: what the stage IS at
     this point in the harness is this harness's business, and a literal
     here would break the day one of the sections above moves the row. What
     must hold is that the reveal agrees with the table. */
  const row = await one(`select follow_up_status, status from demand_records where ref = $1`,
    [submittedRow.ref]);
  if (rev.stage !== row.follow_up_status || rev.state !== row.status) {
    return 'the reveal says stage=' + rev.stage + ' state=' + rev.state +
      ' while the row says ' + row.follow_up_status + '/' + row.status;
  }
  if (rev.roommate !== false) return 'a plain student registration came back as roommate=' + rev.roommate;
  /* The three things that must NOT be in it, asserted on the serialised
     answer rather than on a key list, so a column added later is caught
     even if nobody updates this check. */
  const text = JSON.stringify(r.v);
  const leaks = ['08030000001', 'Proof'].filter((s) => text.indexOf(s) !== -1);
  if (leaks.length) return 'the reveal carries: ' + leaks.join(', ');
  return /"phone"/.test(text) ? 'the reveal has a phone key' : true;
});

await check('and a used code is not a reusable one', async () => {
  const again = await one(`select public.status_verify($1, $2, 5) as v`, [submittedRow.ref, CODE_ROW]);
  return (again.v && again.v.ok === false && again.v.reason === 'no-code') ? true
    : 'the same code was accepted twice: ' + JSON.stringify(again.v);
});

await check('a landlord\u2019s reference reveals the tier, and says landlord', async () => {
  const listing = await asRole('service_role', () => one(
    `insert into listings (payload, status, tier) values ($1::jsonb, 'pending', 0)
     returning ref`, [JSON.stringify({ nm: 'Proof Landlord', ph: '08030000002', prop_name: 'Proof Lodge' })]));
  await one(`select public.status_open($1, $2, 600, 5) as v`, [listing.ref, CODE_ROW]);
  const r = await one(`select public.status_verify($1, $2, 5) as v`, [listing.ref, CODE_ROW]);
  if (!r.v || r.v.ok !== true) return JSON.stringify(r.v);
  const rev = r.v.reveal || {};
  return (rev.kind === 'landlord' && rev.tier === 0 && rev.state === 'pending') ? true
    : 'a listing reference revealed ' + JSON.stringify(rev);
});

await check('a bare six-digit code cannot be stored \u2014 the column only ever takes a digest', async () => {
  /* The strongest thing this layer can say about plaintext. It cannot tell a
     digest from any other 32-character string, so the guarantee is two-part
     and both parts are asserted: a field of the LENGTH a code is cannot be
     stored at all, and what the page does store is a 64-hex digest. */
  const short = await one(`select public.status_open($1, '123456', 600, 50) as v`, [submittedRow.ref]);
  if (!short.v || short.v.ok !== false || short.v.reason !== 'no-hash') {
    return 'a bare code was accepted: ' + JSON.stringify(short.v);
  }
  const HEX64 = 'abcdef0123456789'.repeat(4);
  const r = await one(`select public.status_open($1, $2, 600, 50) as v`, [submittedRow.ref, HEX64]);
  if (!r.v.ok) return JSON.stringify(r.v);
  const row = await one(`select code_hash from status_codes where id = $1`, [r.v.code_id]);
  if (row.code_hash !== HEX64) return 'the hash stored is not the hash sent';
  return /^[0-9a-f]{64}$/.test(HEX64) ? true : 'this test\u2019s own constant is not a digest shape';
});

/* ============================================================
   13g. THE VERIFICATION SHIFT (stage 2)

   supabase-verification-queue.sql is the half of verification that
   makes sure the decision gets MADE: a listing is owed a visit, an
   officer takes the job, and a job nobody came back on goes back to
   the queue.

   What is proved here is the same thing the RPC section above proves
   about the decision, one layer out — that the WRITES ARE COLUMN
   SCOPED. A claim is the most tempting place to leak a row-wide write
   back in: an officer taking a listing is one column away from being
   able to change what it costs, and "assigned_to and taken_at" has to
   be true by construction rather than by good behaviour.
   ============================================================ */

section('13g. The verification shift \u2014 the claim, the trail, and who may move what');

/* A live listing nobody has visited, and a decided one to refuse. Both
   are real rows because an UPDATE that matches nothing proves nothing
   about a policy or a function. */
await sql(`insert into listings (payload, status, tier, opening_ask_ngn, env)
           values ($1::jsonb, 'active', 0, 170000, 'production')`,
  [JSON.stringify({ nm: 'Shift Owner', ph: '08030000009', rent: '170000',
    ar: 'Malete', ty: 'Self-contain', hp: '' })]);
const shiftListing = await one(`select id from listings where owner_phone = '08030000009'`);

await check('the queue is readable by the shift and by nobody else', async () => {
  const rows = await asRole('authenticated', () => sql(`select * from public.verification_queue()`),
    { role: 'verification' });
  const mine = rows.rows.filter((r) => r.id === shiftListing.id);
  if (mine.length !== 1) return 'the live tier-0 listing is not in the queue of ' + rows.rows.length + ' row(s)';
  if (mine[0].stage !== 'queue' || mine[0].taken_by) return 'an unclaimed listing reads as ' + JSON.stringify(mine[0]);

  /* THE OWNER IS NOT IN THE ANSWER. The officer needs to know WHAT to go
     and look at; a phone number and the words a landlord typed are not
     that, and a view over the row would carry both. */
  const cols = Object.keys(mine[0]);
  if (cols.indexOf('payload') !== -1) return 'the queue read carries the owner payload';

  const admin = await asRole('authenticated', () => val(`select count(*)::int from public.verification_queue()`),
    { role: 'admin' });
  if (admin === null) return 'an admin cannot read the queue at all';

  const support = await refuses(() => asRole('authenticated', () => sql(
    `select * from public.verification_queue()`), { role: 'support' }), '42501');
  if (support !== true) return 'a support login read the verification queue: ' + support;
  return refuses(() => asRole('anon', () => sql(`select * from public.verification_queue()`)), '42501');
});

await check('taking it puts the officer\u2019s account on the row and moves nothing else', async () => {
  const before = await one(`select listed_price_ngn, opening_ask_ngn, env, status, tier, notes
                              from listings where id = $1`, [shiftListing.id]);
  const out = await asRole('authenticated', () => one(
    `select public.listing_take($1::uuid) as r`, [shiftListing.id]), { role: 'verification' });
  if (!out || !out.r || out.r.stage !== 'visit') return 'the take answered ' + JSON.stringify(out);

  const after = await one(`select assigned_to, taken_at, listed_price_ngn, opening_ask_ngn, env,
                                 status, tier, notes, payload
                             from listings where id = $1`, [shiftListing.id]);
  if (!after.assigned_to) return 'nobody\u2019s account is on the listing after a take';
  if (!after.taken_at) return 'the claim has no start time, so the clock has nothing to measure';
  if (!out.r.taken_by || out.r.taken_by !== after.assigned_to)
    return 'the function answered ' + out.r.taken_by + ' while the row says ' + after.assigned_to;
  /* The four things a row-wide write would have taken with it. */
  if (Number(after.listed_price_ngn) !== Number(before.listed_price_ngn))
    return 'the price moved with the claim';
  if (Number(after.opening_ask_ngn) !== Number(before.opening_ask_ngn))
    return 'the opening ask moved with the claim';
  if (after.env !== before.env || after.status !== before.status || Number(after.tier) !== Number(before.tier))
    return 'the board state moved with the claim';
  if ((after.payload || {}).ph !== '08030000009') return 'the owner payload moved with the claim';
  return true;
});

await check('the same officer taking it again is the same claim, not a second one', async () => {
  const first = await one(`select taken_at from listings where id = $1`, [shiftListing.id]);
  await asRole('authenticated', () => one(`select public.listing_take($1::uuid) as r`, [shiftListing.id]),
    { role: 'verification' });
  const row = await one(`select assigned_to, taken_at from listings where id = $1`, [shiftListing.id]);
  if (!row.assigned_to) return 'the claim was lost';
  /* A claim is allowed to refresh its own start time — it is the same
     person on the same job — but it must not be a DIFFERENT person, and
     it must not be refused, which would read to the officer as "somebody
     else has it" on their own listing. */
  return new Date(row.taken_at).getTime() >= new Date(first.taken_at).getTime()
    ? true : 'the second take moved the start time backwards';
});

await check('an officer may not take a listing another officer already holds', async () => {
  await sql(`update listings set assigned_to = 'grace@arzuz.com' where id = $1`, [shiftListing.id]);
  const other = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_take($1::uuid)`, [shiftListing.id]), { role: 'verification' }), '22023');
  if (other !== true) return 'a second officer took a listing somebody else holds: ' + other;
  /* …and the first officer's claim is untouched by the refusal. */
  const row = await one(`select assigned_to from listings where id = $1`, [shiftListing.id]);
  return row.assigned_to === 'grace@arzuz.com' ? true : 'the refusal changed the claim anyway: ' + row.assigned_to;
});

await check('and no listing may be taken once it has been decided', async () => {
  await sql(`update listings set tier = 1, assigned_to = null, taken_at = null where id = $1`,
    [shiftListing.id]);
  const decided = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_take($1::uuid)`, [shiftListing.id]), { role: 'verification' }), '22023');
  if (decided !== true) return 'a decided listing was taken for verification: ' + decided;
  await sql(`update listings set tier = 0 where id = $1`, [shiftListing.id]);
  return true;
});

await check('releasing clears the claim and nothing else, and only its own', async () => {
  await sql(`update listings set assigned_to = 'grace@arzuz.com', taken_at = now() where id = $1`,
    [shiftListing.id]);
  const stolen = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_release($1::uuid, 'not mine')`, [shiftListing.id]), { role: 'verification' }),
    '42501');
  if (stolen !== true) return 'an officer released somebody else\u2019s claim: ' + stolen;

  /* The chaser is not a person: there is no signed-in officer at 6am, so a
     job nobody came back on has to be releasable by the SERVICE role — and
     that is the one place this function admits it. */
  const out = await asRole('service_role', () => one(
    `select public.listing_release($1::uuid, 'the clock took it back') as r`, [shiftListing.id]));
  if (!out || !out.r || out.r.stage !== 'queue') return 'the reclaim answered ' + JSON.stringify(out);
  const row = await one(`select assigned_to, taken_at, listed_price_ngn, tier from listings where id = $1`,
    [shiftListing.id]);
  if (row.assigned_to !== null || row.taken_at !== null)
    return 'the claim survived the release: ' + JSON.stringify(row);
  if (Number(row.listed_price_ngn) !== Number((await one(
    `select listed_price_ngn from listings where id = $1`, [shiftListing.id])).listed_price_ngn))
    return 'the release changed the price';

  const nothing = await refuses(() => asRole('service_role', () => sql(
    `select public.listing_release($1::uuid, 'again')`, [shiftListing.id])), '22023');
  return nothing === true ? true : 'a listing nobody holds was released again: ' + nothing;
});

await check('the trail records the shift, and no browser key may write to it', async () => {
  const events = await sql(`select event, actor_role from verification_events
                             where listing_id = $1 order by at`, [shiftListing.id]);
  const kinds = events.rows.map((r) => r.event);
  if (kinds.indexOf('taken') === -1) return 'no take was recorded: ' + kinds.join(', ');
  if (kinds.indexOf('released') === -1) return 'no release was recorded: ' + kinds.join(', ');

  const write = await refuses(() => asRole('authenticated', () => sql(
    `insert into verification_events (listing_id, event) values ($1::uuid, 'nudged')`,
    [shiftListing.id]), { role: 'admin' }), '42501');
  if (write !== true) return 'an admin login wrote to the trail directly: ' + write;
  return refuses(() => asRole('anon', () => sql(
    `select count(*) from verification_events`)), '42501');
});

await check('the clock\u2019s own line is the service role\u2019s, and nobody else\u2019s', async () => {
  const mine = await refuses(() => asRole('authenticated', () => sql(
    `select public.verification_nudge($1::uuid, 'mine')`, [shiftListing.id]), { role: 'verification' }),
    '42501');
  if (mine !== true) return 'an officer wrote a nudge to the trail: ' + mine;
  const out = await asRole('service_role', () => one(
    `select public.verification_nudge($1::uuid, 'late') as r`, [shiftListing.id]));
  if (!out || !out.r || out.r.event !== 'nudged') return 'the clock could not record its own nudge';
  /* A NUDGE IS A MESSAGE, NOT A STATE CHANGE. If it touched the listing,
     the clock could put a job in or out of the queue as well as talk
     about it — and the next run could not tell the two apart. */
  const row = await one(`select assigned_to, taken_at, tier, status from listings where id = $1`,
    [shiftListing.id]);
  return (row.assigned_to === null && row.taken_at === null && Number(row.tier) === 0)
    ? true : 'recording a nudge changed the listing: ' + JSON.stringify(row);
});

await check('and a nudge on a listing that does not exist is refused, not silently dropped', async () =>
  refuses(() => asRole('service_role', () => sql(
    `select public.verification_nudge('00000000-0000-4000-8000-0000000000ff', 'ghost')`)), 'P0002'));

await check('the hourly clock is the only caller that can run without a login', async () => {
  const SIG = 'public.verification_nudge(uuid,text)';
  const r = await one(`select has_function_privilege('anon', $1, 'execute')::int as a,
                              has_function_privilege('authenticated', $1, 'execute')::int as b,
                              has_function_privilege('service_role', $1, 'execute')::int as c`,
    [SIG]);
  if (r.a !== 0 || r.b !== 0) return 'a browser key may run the clock: anon=' + r.a + ' authenticated=' + r.b;
  return r.c === 1 ? true : 'the scheduled function cannot run the clock at all';
});

/* ============================================================
   13h. THE DESK'S HALF \u2014 the trail, the code's ceiling, who may ask

   supabase-status-history.sql exists so the office can answer "I
   never got the code" from a screen rather than from a Netlify build
   log nobody opens. Four claims are driven here, each as the caller
   who would try to break it:

     · the trail is not reachable with a browser key, and a note
       cannot carry a contact detail even when a caller sends one \u2014
       the promise is a CHECK, not a convention;
     · the ceiling belongs to the CODE. A caller claiming a bigger
       budget than the code was issued with does not get one \u2014 that
       is the hardening the migration bought along with the screen,
       and the reason the ceiling stopped being a deploy variable;
     · the desk may ask and nobody else may, and the answer holds no
       phone, no address, no name and no hash;
     · the writer ANSWERS rather than raising, because it is called
       after the student's request has already been answered \u2014 a
       broken log line must not turn a delivered code into a 500.
   ============================================================ */

section('13h. The desk\u2019s half \u2014 the delivery trail, the code\u2019s ceiling, and who may ask');

/* A reference of its own, through the door's own insert path, so the
   trigger mints it exactly the way it does for a student and the counts
   below are not the ones sections 13f and 13g spent. */
const deskRow = await asRole('service_role', () => one(
  `insert into demand_records
     (payload, session, env, source, consent_at, consent_text, status)
   values ($1::jsonb, '2026/2027', 'production', 'register.html', now(), $2, 'open')
   returning id, ref`,
  [JSON.stringify({
    first: 'Deskproof', phone: '08030000021', email: 'Deskproof.Student@Example.com',
    age: '18 to 20', hp: '', consent: 'yes',
  }),
   'By submitting this form I agree that Arzuz may contact me on the phone number ' +
   'or email I have given, about my housing request.']));

const ASK_DESK = (role, fn) => asRole('authenticated', fn, { role: role });

await check('the trail is unreachable with a key that ships to a browser', async () => {
  const r = await one(`select t.rowsecurity,
                              (select count(*) from pg_policies p
                                where p.schemaname = 'public'
                                  and p.tablename = 'status_code_deliveries')::int as policies
                         from pg_tables t
                        where t.schemaname = 'public' and t.tablename = 'status_code_deliveries'`);
  if (!r) return 'the trail table does not exist';
  if (!r.rowsecurity || r.policies !== 0) {
    return 'rowsecurity=' + r.rowsecurity + ' policies=' + r.policies +
      ' \u2014 RLS with NO policy is what denies every browser role';
  }
  const a = await refuses(() => asRole('anon', () => sql(`select * from status_code_deliveries`)), '42501');
  if (a !== true) return 'anon read the trail: ' + a;
  return refuses(() => asRole('authenticated', () => sql(
    `insert into status_code_deliveries (code_id, channel, outcome) values (1, 'whatsapp', 'sent')`),
    { role: 'admin' }), '42501');
});

await check('a code carries its ceiling from the moment it is issued, and the trail starts empty', async () => {
  const r = await one(`select public.status_open($1, $2, 600, 5) as v`, [deskRow.ref, CODE_ROW]);
  if (!r.v || r.v.ok !== true) return 'issuing was refused: ' + JSON.stringify(r.v);
  const row = await one(`select max_attempts, attempts,
                                (select count(*) from status_code_deliveries d where d.code_id = c.id)::int as deliveries
                           from status_codes c where c.id = $1`, [r.v.code_id]);
  if (Number(row.max_attempts) !== 5) return 'a fresh code was issued with a ceiling of ' + row.max_attempts;
  if (Number(row.attempts) !== 0) return 'it was born with ' + row.attempts + ' attempts spent';
  return Number(row.deliveries) === 0 ? true
    : 'a code was born with ' + row.deliveries + ' delivery row(s) \u2014 nothing has been sent yet';
});

await check('every attempt to deliver is appended, in the order it was tried', async () => {
  const code = await one(`select id from status_codes
                           where ref = $1 order by created_at desc limit 1`, [deskRow.ref]);
  /* The fallback story, as the function writes it: WhatsApp refused, then
     the same code delivered by email. Flattened into one column this
     would read "email" and the desk could not tell the student why the
     message they were watching for never arrived on the phone they were
     holding. */
  const first = await one(`select public.status_code_delivery($1,'whatsapp','refused','openwa-refused') as r`,
    [code.id]);
  const second = await one(`select public.status_code_delivery($1,'email','sent',null) as r`, [code.id]);
  if (!first.r.ok || !second.r.ok) return 'a delivery was refused: ' + JSON.stringify([first.r, second.r]);

  const hist = await ASK_DESK('support', () => one(
    `select public.status_history($1) as h`, [deskRow.ref]));
  const newest = (hist.h.codes || [])[0];
  if (!newest) return 'the history came back with no code at all';
  const tr = newest.deliveries || [];
  if (tr.length !== 2) return 'the trail has ' + tr.length + ' row(s), not the two that were written';
  if (tr[0].channel !== 'whatsapp' || tr[0].outcome !== 'refused') {
    return 'the first attempt reads ' + JSON.stringify(tr[0]);
  }
  if (tr[1].channel !== 'email' || tr[1].outcome !== 'sent') {
    return 'the fallback reads ' + JSON.stringify(tr[1]);
  }
  return tr[0].note === 'openwa-refused' ? true
    : 'the refusal lost its note, so a screen cannot say what went wrong: ' + JSON.stringify(tr[0]);
});

await check('a note is a closed vocabulary \u2014 a descriptive one is stored as unrecorded, and free text is refused outright', async () => {
  const code = await one(`select id from status_codes
                           where ref = $1 order by created_at desc limit 1`, [deskRow.ref]);
  /* The list is a guarantee about CONTENT, not about shape. "No note may
     contain an @ or seven digits" would let 'refused for Deskproof,
     number changed' through \u2014 a name in a log several people read \u2014
     which is the leak a shape rule cannot see. So an unknown word is
     COERCED rather than refused: the row is the record the desk came for,
     and losing it to a vocabulary mismatch would be the worse failure. */
  const r = await one(`select public.status_code_delivery($1, 'whatsapp', 'refused',
                                              'refused for Deskproof.Student@Example.com on 08030000021') as r`,
    [code.id]);
  if (!r.r || r.r.ok !== true) return 'the delivery was dropped instead of coerced: ' + JSON.stringify(r.r);
  const stored = await one(`select note from status_code_deliveries where id = $1`, [r.r.id]);
  if (!stored) return 'the row was answered as written but is not there';
  if (stored.note !== 'unrecorded') return 'an invented note was stored: ' + stored.note;
  const text = JSON.stringify(stored);
  if (text.indexOf('Deskproof') !== -1 || text.indexOf('@') !== -1) {
    return 'the note kept something about a person: ' + text;
  }

  /* And the list is real rather than decorative: a caller that goes round
     the function \u2014 any future one \u2014 is refused by the table. */
  return refuses(() => sql(
    `insert into status_code_deliveries (code_id, channel, outcome, note)
     values ($1, 'email', 'sent', 'refused for Deskproof')`, [code.id]), '23514');
});

await check('the writer answers instead of raising, so a broken log line cannot break a request', async () => {
  const before = await val(`select count(*)::int from status_code_deliveries`);
  /* The id is a real bigint that belongs to no code, not deskRow.id: a
     uuid where a bigint is wanted would be a type error, which is a raise
     rather than an answer, and the point of this check is the answer. */
  const noChannel = await one(`select public.status_code_delivery($1, 'sms', 'sent', null) as r`, [99999999]);
  const noOutcome = await one(`select public.status_code_delivery($1, 'whatsapp', 'maybe', null) as r`, [99999999]);
  const noCode = await one(`select public.status_code_delivery($1, 'whatsapp', 'sent', null) as r`, [99999999]);
  if (noChannel.r.ok !== false || noChannel.r.reason !== 'bad-channel') return JSON.stringify(noChannel.r);
  if (noOutcome.r.ok !== false || noOutcome.r.reason !== 'bad-outcome') return JSON.stringify(noOutcome.r);
  if (noCode.r.ok !== false || noCode.r.reason !== 'no-code') return JSON.stringify(noCode.r);
  const after = await val(`select count(*)::int from status_code_deliveries`);
  return after === before ? true : 'a refused write still wrote ' + (after - before) + ' row(s)';
});

await check('the trail dies with its code, and holds no reference of its own', async () => {
  const cols = await sql(`select column_name from information_schema.columns
                           where table_schema = 'public' and table_name = 'status_code_deliveries'`);
  const names = cols.rows.map((r) => r.column_name);
  const forbidden = ['ref', 'phone', 'email', 'code', 'code_hash'].filter((c) => names.indexOf(c) !== -1);
  if (forbidden.length) return 'the trail carries ' + forbidden.join(', ');

  const issued = await one(`select public.status_open($1, $2, 600, 5) as v`, [deskRow.ref, CODE_ROW]);
  await one(`select public.status_code_delivery($1, 'whatsapp', 'sent', null) as r`, [issued.v.code_id]);
  const mine = await val(`select count(*)::int from status_code_deliveries where code_id = $1`, [issued.v.code_id]);
  if (mine !== 1) return 'the delivery was not written against its code';
  await sql(`delete from status_codes where id = $1`, [issued.v.code_id]);
  const left = await val(`select count(*)::int from status_code_deliveries where code_id = $1`, [issued.v.code_id]);
  return left === 0 ? true
    : left + ' delivery row(s) outlived the code they were about';
});

await check('the desk may ask, and every other login is refused', async () => {
  const support = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  if (!support.h || support.h.ok !== true) return 'the support login was refused: ' + JSON.stringify(support.h);
  const admin = await ASK_DESK('admin', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  if (!admin.h || admin.h.ok !== true) return 'the admin login was refused: ' + JSON.stringify(admin.h);

  const outsiders = ['verification', 'finance', 'marketing'];
  for (const role of outsiders) {
    const out = await refuses(() => ASK_DESK(role, () => sql(
      `select public.status_history($1)`, [deskRow.ref])), '42501');
    if (out !== true) return 'a ' + role + ' login read a reference\u2019s code history: ' + out;
  }
  /* No role claim at all normalises to the main admin (the site's own
     rule), which is why it is not in the list above. A browser key that
     is NOT signed in is. */
  return refuses(() => asRole('anon', () => sql(
    `select public.status_history($1)`, [deskRow.ref])), '42501');
});

await check('the answer is the history, and carries nothing about the person', async () => {
  const hist = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  const h = hist.h;
  if (h.ref !== deskRow.ref) return 'the answer is about ' + h.ref;
  if (h.kind !== 'student' || h.known_reference !== true) return JSON.stringify({ kind: h.kind, known: h.known_reference });
  if (!Array.isArray(h.codes) || !h.codes.length) return 'no codes came back for a reference that has them';
  if (typeof h.asked_last_hour !== 'number') return 'the per-reference budget is not on the answer';

  /* Asserted on the SERIALISED answer, so a column added later is caught
     even if nobody updates this check \u2014 the same shape as the reveal's
     own leak check in 13f. */
  const text = JSON.stringify(h);
  const leaks = ['08030000021', 'Deskproof', 'Deskproof.Student@Example.com', '@', CODE_ROW]
    .filter((s) => text.indexOf(s) !== -1);
  if (leaks.length) return 'the desk\u2019s answer carries: ' + leaks.join(', ');
  /* The hash is the one thing that must never travel: it is what a code
     is checked AGAINST. */
  return /code_hash/.test(text) ? 'the answer has a code_hash key' : true;
});

await check('attempts left is measured against the code\u2019s own ceiling, not against the caller', async () => {
  /* A fresh code, because the cascade check above deleted one and that is
     what killed the one before it \u2014 there is no live code for this
     reference at this point, and that is the table's doing, not a gap. */
  const fresh = await one(`select public.status_open($1, $2, 600, 5) as v`, [deskRow.ref, CODE_ROW]);
  if (!fresh.v.ok) return 'issuing was refused: ' + JSON.stringify(fresh.v);
  const code = await one(`select id, max_attempts from status_codes where id = $1`, [fresh.v.code_id]);
  if (Number(code.max_attempts) !== 5) return 'a fresh code came with a ceiling of ' + code.max_attempts;
  await sql(`update status_codes set max_attempts = 4 where id = $1`, [code.id]);
  const wrong = await one(`select public.status_verify($1, 'not-the-hash', 20) as v`, [deskRow.ref]);
  if (!wrong.v || wrong.v.reason !== 'wrong') return 'a wrong code did not cost an attempt: ' + JSON.stringify(wrong.v);
  if (wrong.v.limit !== 4) return 'the claimed ceiling of twenty was honoured: limit ' + wrong.v.limit;

  const hist = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  const newest = hist.h.codes[0];
  if (Number(newest.max_attempts) !== 4) return 'the screen reports a ceiling of ' + newest.max_attempts;
  if (Number(newest.attempts) !== 1) return 'the screen reports ' + newest.attempts + ' attempts spent';
  if (Number(newest.attempts_left) !== 3) return 'the screen reports ' + newest.attempts_left + ' attempts left';
  return newest.live === true ? true : 'a code inside its ten minutes does not read as live';
});

await check('and a code that was used reads as used, not as live', async () => {
  const done = await one(`select public.status_verify($1, $2, 5) as v`, [deskRow.ref, CODE_ROW]);
  if (!done.v || done.v.ok !== true) return 'the right code was refused: ' + JSON.stringify(done.v);
  const hist = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  const used = hist.h.codes.filter((c) => c.used_at);
  if (!used.length) return 'a code was spent and no code in the history reads as used';
  if (used[0].live === true) return 'a used code still reads as live';
  return used[0].attempts_left === 0 ? true
    : 'a spent code still offers ' + used[0].attempts_left + ' attempts';
});

await check('codes for a reference the registry does not know are still reported, and said to be unknown', async () => {
  /* The row-was-deleted case. The STUDENT's page must never tell it apart
     from a wrong phone number \u2014 that is an oracle \u2014 but the desk is
     looking at a reference a person on the phone just read out, and "no
     such record" and "we sent you two codes" are different answers to
     give them. */
  const ghost = 'ARZ-S-0000-0000-0000';
  await one(`select public.status_open($1, $2, 600, 5) as v`, [ghost, CODE_ROW]);
  const hist = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [ghost]));
  if (hist.h.known_reference !== false) return 'a reference nobody minted reads as known';
  if (!hist.h.codes.length) return 'the codes asked for against it were hidden along with the record';
  return hist.h.kind === null ? true : 'an unknown reference came back with kind = ' + hist.h.kind;
});

await check('what the page is judged against is on the screen too', async () => {
  const direct = await val(`select count(*)::int from status_codes
                             where ref = $1 and created_at > now() - interval '1 hour'`,
    [deskRow.ref]);
  const hist = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  return Number(hist.h.asked_last_hour) === direct ? true
    : 'the screen says ' + hist.h.asked_last_hour + ' asked in the last hour; the table says ' + direct;
});

/* ============================================================
   13i. THE QUERY RATHER THAN THE REFERENCE

   "I cannot find the ARZ number" is how half of these calls open, so
   status_history() reads its argument as a QUERY: the whole reference,
   the end of one, the beginning of one, or a phone number. Five claims,
   each driven as the caller who would break it:

     · a fragment that fits ONE reference answers exactly what the whole
       reference answers — compared row for row, because "nearly the
       same" is how the desk learns to distrust one of the two;
     · a fragment that fits MORE THAN ONE says so and hands over the
       candidates, and the cap holds — this is the one that must not
       guess, because a wrong guess is an officer reading somebody
       else's history down the phone with complete confidence;
     · a fragment too short to mean anything is refused EVEN WHEN a
       reference with those characters exists, which is the difference
       between a lookup and a way to walk the registry;
     · a number is matched by the site's own rule — the last ten digits —
       and the answer carries no number back;
     · all four shapes are still the desk's alone.
   ============================================================ */

section('13i. What the desk typed \u2014 the reference, a fragment of it, or a number');

await check('the whole reference reads as a reference, and nothing else', async () => {
  const hist = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  const h = hist.h;
  if (h.lookup !== 'ref') return 'a whole reference was read as ' + h.lookup;
  if (h.ref !== deskRow.ref) return 'the answer is about ' + h.ref;
  if (h.ambiguous !== false) return 'a whole reference came back ambiguous';
  if ((h.matches || []).length) return 'a whole reference came back with candidates';
  /* A whole reference is echoed as `ref`, not as `query`: there is one
     reading of it and it is already on the answer. Only a FRAGMENT gets
     the query echoed, because only a fragment has two possible readings. */
  return h.query === null ? true : 'a whole reference came back with a query echo: ' + h.query;
});

await check('the last four characters find the SAME history as the whole reference', async () => {
  /* Compared, not eyeballed. The property is that the two questions are
     one question, and asserting "it found something" would leave the
     interesting half — that the facts are identical — untested. */
  const whole = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  const tail = await ASK_DESK('support', () => one(
    `select public.status_history(right($1, 4)) as h`, [deskRow.ref]));
  if (tail.h.lookup !== 'tail') return 'the last four characters were read as ' + tail.h.lookup;
  if (tail.h.ref !== deskRow.ref) return 'they resolved to ' + tail.h.ref;
  if (tail.h.ambiguous !== false) return 'four characters of a reference already in the table came back ambiguous';
  const a = JSON.stringify(whole.h.codes), b = JSON.stringify(tail.h.codes);
  if (a !== b) return 'the fragment answers differently:\n  whole: ' + a.slice(0, 200) + '\n  tail:  ' + b.slice(0, 200);
  return Number(tail.h.asked_last_hour) === Number(whole.h.asked_last_hour) ? true
    : 'the two readings disagree about the hourly budget';
});

await check('and so does the beginning of it \u2014 the same question from the other end', async () => {
  /* Fourteen compact characters: 'ARZ', the letter, and ten of the twelve
     hex. Restrictive enough that a collision with another test reference
     is not a thing to worry about, and it is a person reading the first
     two groups out rather than a wildcard. */
  const head = await ASK_DESK('support', () => one(
    `select public.status_history(left(replace($1, '-', ''), 14)) as h`, [deskRow.ref]));
  if (head.h.lookup !== 'head') return 'the beginning was read as ' + head.h.lookup;
  return head.h.ref === deskRow.ref ? true : 'it resolved to ' + head.h.ref;
});

await check('a bare number is a number only at ten digits \u2014 below that it can only be a reference\u2019s end', async () => {
  /* THE ONE GENUINELY AMBIGUOUS SHAPE, settled by the site's own phone
     rule rather than by a guess. '0803' is not a number netlify's status
     endpoint could ever have proved control with, so the only other thing
     it can be is the end of a reference whose last characters are all
     decimal \u2014 which is about one reference in seven, because a
     reference is twelve hex characters and four of every sixteen are not
     decimal. Reading it as "nothing" would refuse the desk the answer for
     a seventh of the registry. */
  const four = await ASK_DESK('support', () => one(`select public.status_history('0803') as h`));
  if (four.h.lookup !== 'tail') return 'four decimal characters were read as ' + four.h.lookup + ', not as the end of a reference';

  /* Below the fragment floor it is nothing, and above a phone it is
     nothing either: sixteen digits is longer than any number this site
     matches and longer than any reference's tail. */
  const two = await ASK_DESK('support', () => one(`select public.status_history('80') as h`));
  if (two.h.lookup !== 'none') return 'two characters were read as ' + two.h.lookup;
  const long = await ASK_DESK('support', () => one(`select public.status_history('1234567890123456') as h`));
  if (long.h.lookup !== 'none') return 'sixteen digits were read as ' + long.h.lookup;
  if (long.h.ref !== null || (long.h.matches || []).length) return 'an unreadable query resolved to something';
  return long.h.ok === true ? true : 'a short query is an ERROR rather than an answer';
});

await check('the last four characters of an ALL-DECIMAL reference find it', async () => {
  /* Deterministic on purpose. deskRow.ref's own last group is random, so
     the check above exercises this only about a seventh of the time \u2014
     which is exactly how the bug this pins was found (a run where
     right(ref,4) happened to be decimal, and the answer came back 'none').
     A reference of its own with a chosen tail makes it every run. It has
     no demand row behind it: the fragment branch reads the registry, and
     what is under test is the READING. */
  const ALLDEC = 'ARZ-S-1234-5678-9012';
  await asRole('service_role', () => sql(
    `insert into waitlist_ref_registry (ref, kind) values ($1, 'demand_records')
     on conflict (ref) do nothing`, [ALLDEC]));
  const h = (await ASK_DESK('support', () => one(
    `select public.status_history('9012') as h`))).h;
  if (h.lookup !== 'tail') return 'an all-decimal tail was read as ' + h.lookup;
  if (h.ref !== ALLDEC) return 'the all-decimal tail resolved to ' + h.ref;
  /* And the whole of it still answers as a reference, so the two ends of
     the same reference agree. */
  const whole = (await ASK_DESK('support', () => one(
    `select public.status_history($1) as h`, [ALLDEC]))).h;
  if (whole.lookup !== 'ref') return 'a whole all-decimal reference was read as ' + whole.lookup;
  return whole.ref === ALLDEC ? true : 'the whole reference answered as ' + whole.ref;
});

await check('a fragment too short to mean anything is refused EVEN WHEN it matches a real reference', async () => {
  /* The anti-enumeration claim, and the one worth the most here. Two
     characters of a reference under test DOES occur in a reference —
     this one — and if that were enough to answer, 'AR', 'RZ', 'S0' and
     so on would be a way to walk the registry two characters at a time
     and never be refused. The refusal has to be about the QUESTION, not
     about whether something happens to match it. */
  const two = await val(`select right($1, 2)`, [deskRow.ref]);
  const hist = await ASK_DESK('support', () => one(
    `select public.status_history($1) as h`, [two]));
  if (hist.h.lookup !== 'none') return 'two characters were read as ' + hist.h.lookup;
  if ((hist.h.matches || []).length) return 'two characters listed ' + hist.h.matches.length + ' reference(s)';
  if ((hist.h.codes || []).length) return 'two characters returned a code history — the reference was found by them';
  if (hist.h.ref !== null) return 'two characters resolved to ' + hist.h.ref;
  /* And the same for the word every reference starts with. */
  const arz = await ASK_DESK('support', () => one(`select public.status_history('ARZ') as h`));
  return arz.h.lookup === 'none' ? true
    : 'ARZ alone was read as ' + arz.h.lookup + ' and would have listed the registry';
});

await check('the site\u2019s phone rule is one rule, and it is the send path\u2019s', async () => {
  /* netlify/functions/status.js proves control of a number with the last
     ten digits and refuses anything shorter. The desk's search must make
     the same call or a number a student can open their record with is a
     number the desk cannot find it by. */
  const r = await one(`select public.status_phone_tail('0803 000 0021') as a,
                              public.status_phone_tail('+2348030000021') as b,
                              public.status_phone_tail('234-803-000-0021') as c,
                              public.status_phone_tail('080300002') as short,
                              public.status_phone_tail(null) as nil`);
  if (r.a !== '8030000021' || r.b !== '8030000021' || r.c !== '8030000021') {
    return 'the three ways of writing one number do not agree: ' + JSON.stringify([r.a, r.b, r.c]);
  }
  if (r.short !== '') return 'a nine-digit number produced a tail: ' + r.short;
  const ten = await val(`select public.status_phone_tail('0803000002')`);
  if (ten !== '0803000002') return 'a ten-digit number was not accepted as one: ' + ten;
  return r.nil === '' ? true : 'null produced ' + JSON.stringify(r.nil);
});

await check('the number on the record finds the reference, however it is written', async () => {
  const whole = await ASK_DESK('support', () => one(`select public.status_history($1) as h`, [deskRow.ref]));
  for (const written of ['08030000021', '+2348030000021', '0803 000 0021']) {
    const h = (await ASK_DESK('support', () => one(
      `select public.status_history($1) as h`, [written]))).h;
    if (h.lookup !== 'phone') return 'a ten-digit number was read as ' + h.lookup + ' \u2014 "' + written + '"';
    if (h.ref !== deskRow.ref) return '"' + written + '" resolved to ' + h.ref;
    const a = JSON.stringify(whole.h.codes), b = JSON.stringify(h.codes);
    if (a !== b) return '"' + written + '" answers differently from the reference itself';
  }
  return true;
});

await check('and the answer to a search by number carries no number back', async () => {
  /* The claim the feature rests on: matching BY a contact detail must not
     become a way to READ one off the screen. Asserted on the serialised
     answer so a field added later is caught here rather than by review. */
  const h = (await ASK_DESK('support', () => one(
    `select public.status_history('08030000021') as h`))).h;
  const text = JSON.stringify(h);
  const leaks = ['08030000021', '8030000021', '2348030000021', 'Deskproof', '@', 'code_hash']
    .filter((s) => text.indexOf(s) !== -1);
  if (leaks.length) return 'the answer to a search by number carries: ' + leaks.join(', ');
  return h.ref === deskRow.ref ? true : 'the search by number did not resolve at all';
});

await check('a number nobody matched resolves to nothing, and says so rather than failing', async () => {
  const h = (await ASK_DESK('support', () => one(
    `select public.status_history('0803 000 7777') as h`))).h;
  if (h.ok !== true) return 'an unmatched number is an error rather than an answer: ' + JSON.stringify(h);
  if (h.lookup !== 'phone') return 'a ten-digit number was read as ' + h.lookup;
  if (h.ref !== null || (h.matches || []).length) return 'an unmatched number resolved to something';
  return h.known_reference === false ? true : 'an unmatched number reads as a known reference';
});

await check('a fragment that fits more than one reference asks, and hands over nothing else', async () => {
  /* Twelve references sharing a tail, written straight into the registry:
     the only way to build the case on purpose, since refs are minted at
     random by the trigger. They have no demand row behind them, which is
     exactly right for this \u2014 the fragment branch reads the registry,
     and the claim under test is about CANDIDATES, not about those refs
     being usable. */
  const mine = [];
  for (let i = 1; i <= 12; i++) {
    mine.push('ARZ-S-' + String(i).padStart(4, '0') + '-0000-FACE');
  }
  await asRole('service_role', () => sql(
    `insert into waitlist_ref_registry (ref, kind)
     select unnest($1::text[]), 'demand_records'`, [mine]));

  const h = (await ASK_DESK('support', () => one(
    `select public.status_history('FACE') as h`))).h;
  if (h.lookup !== 'tail') return 'a four-character fragment was read as ' + h.lookup;
  if (h.ambiguous !== true) return 'twelve references under one fragment came back not-ambiguous';
  if (h.ref !== null) return 'an ambiguous fragment still picked one: ' + h.ref;
  if ((h.codes || []).length) return 'an ambiguous fragment returned a code history';
  if ((h.matches || []).length !== 10) return 'the cap did not hold at ten: ' + (h.matches || []).length;
  if (h.more !== true) return 'ten of twelve were shown with no sign that there were more';
  /* Every candidate is a reference and a kind \u2014 and nothing that could
     not be shown to the next caller. */
  const bad = h.matches.filter((m) => typeof m.ref !== 'string' || m.ref.indexOf('ARZ-') !== 0);
  if (bad.length) return 'a candidate is not a reference: ' + JSON.stringify(bad[0]);
  const text = JSON.stringify(h);
  return text.indexOf('08030000021') === -1 ? true
    : 'an ambiguous answer carried a phone number into the pick list';
});

await check('all four readings are the desk\u2019s, and every other login is still refused', async () => {
  /* Widening what may be ASKED must not widen who may ask. Driven for each
     shape separately, because a role check that only ran before the
     reference branch would let a finance login search by number. */
  const tail = await val(`select right($1, 4)`, [deskRow.ref]);
  const shapes = [deskRow.ref, tail, 'ARZ', '08030000021'];
  for (const role of ['verification', 'finance', 'marketing']) {
    for (const q of shapes) {
      const out = await refuses(() => ASK_DESK(role, () => sql(
        `select public.status_history($1)`, [q])), '42501');
      if (out !== true) return 'a ' + role + ' login asked with "' + q + '": ' + out;
    }
  }
  /* The helper is asserted by PRIVILEGE rather than by calling it: this
     harness's own connection is the owner, and an owner may always run
     its own function, so "the call failed" would prove nothing here. */
  const priv = await one(`select has_function_privilege('anon',
                                     'public.status_phone_tail(text)', 'execute')::int as a,
                                has_function_privilege('authenticated',
                                     'public.status_phone_tail(text)', 'execute')::int as b,
                                has_function_privilege('service_role',
                                     'public.status_phone_tail(text)', 'execute')::int as c`);
  if (priv.a !== 0 || priv.b !== 0) {
    return 'a browser key may run the phone helper: anon=' + priv.a + ' authenticated=' + priv.b;
  }
  if (priv.c !== 1) return 'even the service role cannot run the helper';

  const anon = await refuses(() => asRole('anon', () => sql(
    `select public.status_history($1)`, [tail])), '42501');
  return anon === true ? true : 'a browser key with no login read a fragment: ' + anon;
});

/* ============================================================
   13j. WHAT THE VISIT SAW (stage 3)

   supabase-verification-evidence.sql is the half of verification that
   makes "Inspected" mean something: one row per check, an append-only
   trail that nobody with a browser key can write, and a public view
   that exposes the checks behind a badge for listings already on the
   board — and nothing else.

   What is proved here is the same shape as 13g, one layer out: that
   the EVIDENCE is not a claim an officer can type and that the
   DECISION cannot be made without it. A refusal that wrote evidence
   anyway would be worse than no evidence at all, so the refusals are
   checked against the rows afterwards.
   ============================================================ */

section('13j. What the visit saw \u2014 the evidence, the decision, and who may read it');

/* A live tier-0 production listing: the one an officer visits. And a
   test-environment listing, which must stay invisible to the public
   view even after it has been inspected — the view's join is the whole
   reason a draft cannot grow a badge. */
await sql(`insert into listings (payload, status, tier, opening_ask_ngn, env)
           values ($1::jsonb, 'active', 0, 180000, 'production'),
                  ($2::jsonb, 'active', 0, 90000, 'test')`,
  [JSON.stringify({ nm: 'Evidence Owner', ph: '08030000011', rent: '180000',
    ar: 'Malete', ty: 'Self-contain', hp: '' }),
  JSON.stringify({ nm: 'Test Owner', ph: '08030000012', rent: '90000',
    ar: 'Malete', ty: 'Room', hp: '' })]);
const visitListing = await one(`select id from listings where owner_phone = '08030000011'`);
const testListing = await one(`select id from listings where owner_phone = '08030000012'`);

await check('the evidence table is unreadable and unwritable by every browser key', async () => {
  const priv = await one(`select has_table_privilege('anon', 'public.listing_evidence', 'select')::int as a_read,
                                 has_table_privilege('anon', 'public.listing_evidence', 'insert')::int as a_write,
                                 has_table_privilege('authenticated', 'public.listing_evidence', 'insert')::int as u_write,
                                 has_table_privilege('authenticated', 'public.listing_evidence', 'update')::int as u_update,
                                 has_table_privilege('authenticated', 'public.listing_evidence', 'delete')::int as u_delete`);
  if (priv.a_read !== 0) return 'anon can read the evidence table itself';
  if (priv.a_write !== 0 || priv.u_write !== 0) return 'a browser key holds INSERT on the evidence';
  if (priv.u_update !== 0 || priv.u_delete !== 0) return 'a browser key holds UPDATE/DELETE on the evidence';

  /* And the path that would matter if a grant were ever widened: RLS with
     no permissive policy refuses the row even to an officer. */
  const written = await refuses(() => asRole('authenticated', () => sql(
    `insert into public.listing_evidence (listing_id, visit_id, kind, detail, checked_at, expires_at, officer)
     values ($1::uuid, gen_random_uuid(), 'water', null, now(), now() + interval '180 days', 'x')`,
    [visitListing.id])), '42501');
  if (written !== true) return 'an officer inserted evidence by hand: ' + written;
  const none = await val(`select count(*)::int from public.listing_evidence`);
  return none === 0 ? true : 'the refused insert left ' + none + ' row(s) behind';
});

await check('recording a visit is refused to everybody off the shift, and to a missing listing', async () => {
  const checks = JSON.stringify([{ kind: 'water' }]);
  const support = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_attest($1::uuid, $2::jsonb)`, [visitListing.id, checks]),
  { role: 'support' }), '42501');
  if (support !== true) return 'a support login recorded a visit: ' + support;

  const marketing = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_attest($1::uuid, $2::jsonb)`, [visitListing.id, checks]),
  { role: 'marketing' }), '42501');
  if (marketing !== true) return 'a marketing login recorded a visit: ' + marketing;

  const anon = await refuses(() => asRole('anon', () => sql(
    `select public.listing_attest($1::uuid, $2::jsonb)`, [visitListing.id, checks])), '42501');
  if (anon !== true) return 'an anonymous visitor recorded a visit: ' + anon;

  const gone = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_attest('00000000-0000-4000-8000-00000000dead'::uuid, $1::jsonb)`, [checks]),
  { role: 'verification' }), 'P0002');
  if (gone !== true) return 'a visit was recorded against a listing that does not exist: ' + gone;

  const rows = await val(`select count(*)::int from public.listing_evidence`);
  return rows === 0 ? true : 'the refusals wrote ' + rows + ' evidence row(s)';
});

await check('a visit with no checks, or with checks nobody can name, is refused and leaves nothing', async () => {
  const empty = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_attest($1::uuid, '[]'::jsonb)`, [visitListing.id]),
  { role: 'verification' }), '22023');
  if (empty !== true) return 'a visit with no checks was accepted: ' + empty;

  const tooMany = await refuses(() => asRole('authenticated', () => sql(
    `select public.listing_attest($1::uuid, $2::jsonb)`,
    [visitListing.id, JSON.stringify(new Array(9).fill({ kind: 'water' }))]),
  { role: 'verification' }), '22023');
  if (tooMany !== true) return 'a visit with nine checks was accepted: ' + tooMany;

  /* The refusal NAMES the word it did not recognise — the officer has to
     be able to fix it, and "check constraint violated" is not fixable. */
  let said = '';
  try {
    await asRole('authenticated', () => sql(
      `select public.listing_attest($1::uuid, $2::jsonb)`,
      [visitListing.id, JSON.stringify([{ kind: 'vibes' }])]), { role: 'verification' });
  } catch (err) { said = why(err); }
  if (!said.includes('is not a check we can publish')) return 'an unknown kind was not refused: ' + (said || 'it was accepted');
  if (!said.includes('vibes')) return 'the refusal did not name the word: ' + said;

  const rows = await val(`select count(*)::int from public.listing_evidence`);
  if (rows !== 0) return 'a refused visit wrote ' + rows + ' row(s)';
  const still = await one(`select tier, status, verified_at from listings where id = $1`, [visitListing.id]);
  return Number(still.tier) === 0 && still.verified_at === null ? true
    : 'a refused visit moved the listing: ' + JSON.stringify(still);
});

await check('recording a real visit writes the checks AND makes the decision', async () => {
  const out = await asRole('authenticated', () => one(
    `select public.listing_attest($1::uuid, $2::jsonb) as r`,
    [visitListing.id, JSON.stringify([
      { kind: 'water', detail: 'strong at the kitchen tap' },
      { kind: 'power', detail: null },
    ])]), { role: 'verification' });

  if (!out || !out.r) return 'the attestation answered nothing';
  if (Number(out.r.tier) !== 2) return 'the visit did not make it inspected: ' + JSON.stringify(out.r);
  if (!out.r.visit_id || Number(out.r.checks) !== 2) return 'the answer is ' + JSON.stringify(out.r);

  const row = await one(`select tier, status, verified_at, verified_by, opening_ask_ngn, listed_price_ngn, env
                           from listings where id = $1`, [visitListing.id]);
  if (Number(row.tier) !== 2 || String(row.status) !== 'active') return 'the listing reads ' + JSON.stringify(row);
  if (!row.verified_at || !row.verified_by) return 'no verification record was stamped';
  /* The columns the visit may NOT move: a price is not an officer's. */
  if (Number(row.opening_ask_ngn) !== 180000 || String(row.env) !== 'production') {
    return 'the visit moved something that is not the decision: ' + JSON.stringify(row);
  }

  const written = await sql(`select kind, detail, checked_at, expires_at, officer
                               from public.listing_evidence where listing_id = $1 order by kind`,
    [visitListing.id]);
  if (written.rows.length !== 2) return 'the visit wrote ' + written.rows.length + ' row(s), not 2';
  const power = written.rows.find((r) => r.kind === 'power');
  const water = written.rows.find((r) => r.kind === 'water');
  if (!water || water.detail !== 'strong at the kitchen tap') return 'the officer\u2019s sentence did not survive: ' + JSON.stringify(water);
  if (!power || power.detail !== null) return 'a check with no sentence stored ' + JSON.stringify(power);

  /* THE WINDOW IS THE DATABASE'S, not the caller's: 180 days from the
     moment it was recorded, and the officer account is on the row. */
  const days = await val(`select extract(day from (expires_at - checked_at))::int
                            from public.listing_evidence where listing_id = $1 limit 1`, [visitListing.id]);
  if (Number(days) !== 180) return 'the record expires in ' + days + ' days';
  /* WHO, read from the token rather than from anything the caller sent:
     the claims carry no email here, so the account falls back to the
     subject — and it must be THAT subject, on every row. A caller who
     could name the officer would be a caller who could blame somebody. */
  const mine = '00000000-0000-4000-8000-000000000001';
  return written.rows.every((r) => String(r.officer) === mine) ? true
    : 'the evidence names ' + JSON.stringify(written.rows.map((r) => r.officer)) +
      ' instead of the account that recorded it';
});

await check('the public view shows the checks of a board listing, and never the officer', async () => {
  const rows = await asRole('anon', () => sql(
    `select * from public.public_listing_checks where listing_id = $1`, [visitListing.id]));
  if (rows.rows.length !== 2) return 'anon sees ' + rows.rows.length + ' check(s)';
  const cols = Object.keys(rows.rows[0]);
  if (cols.indexOf('officer') !== -1 || cols.indexOf('officer_id') !== -1) {
    return 'the public view carries the officer\u2019s account: ' + cols.join(', ');
  }
  const water = rows.rows.find((r) => r.kind === 'water');
  return water && water.detail === 'strong at the kitchen tap' && water.expires_at ? true
    : 'the public row lost what it must carry: ' + JSON.stringify(water);
});

await check('a listing that is not on the board has no public checks at all', async () => {
  /* Inspected, and in the test environment: the view's join is what keeps
     it out, not the tier. */
  await asRole('authenticated', () => sql(
    `select public.listing_attest($1::uuid, $2::jsonb)`,
    [testListing.id, JSON.stringify([{ kind: 'water' }])]), { role: 'verification' });

  const hidden = await asRole('anon', () => val(
    `select count(*)::int from public.public_listing_checks where listing_id = $1`, [testListing.id]));
  if (Number(hidden) !== 0) return 'a test-environment listing published ' + hidden + ' check(s)';

  /* And it IS recorded — the officer's visit is not lost, it is simply
     not public. */
  const kept = await val(`select count(*)::int from public.listing_evidence where listing_id = $1`,
    [testListing.id]);
  if (Number(kept) !== 1) return 'the visit itself was not recorded: ' + kept;

  /* A draft of a REAL listing would be hidden the same way, which is the
     half of this the join has to get right for a tier-0 room too. */
  const drafted = await one(`insert into listings (payload, status, tier, opening_ask_ngn, env)
                              values ($1::jsonb, 'draft', 2, 120000, 'production') returning id`,
    [JSON.stringify({ nm: 'Draft Owner', ph: '08030000013', rent: '120000', ar: 'Malete', ty: 'Room', hp: '' })]);
  await sql(`insert into public.listing_evidence (listing_id, visit_id, kind, detail, checked_at, expires_at, officer)
             values ($1::uuid, gen_random_uuid(), 'price', null, now(), now() + interval '180 days', 'owner@arzuz.com')`,
    [drafted.id]);
  const draftChecks = await asRole('anon', () => val(
    `select count(*)::int from public.public_listing_checks where listing_id = $1`, [drafted.id]));
  return Number(draftChecks) === 0 ? true : 'a DRAFT listing published ' + draftChecks + ' check(s)';
});

await check('a re-visit adds a visit and edits nothing that was said before', async () => {
  const before = await sql(`select id, kind, detail, checked_at from public.listing_evidence
                             where listing_id = $1 order by kind, id`, [visitListing.id]);

  await asRole('authenticated', () => sql(
    `select public.listing_attest($1::uuid, $2::jsonb)`,
    [visitListing.id, JSON.stringify([
      { kind: 'photos', detail: 'new tiling since the last visit' },
      { kind: 'access', detail: null },
    ])]), { role: 'verification' });

  const after = await sql(`select id, kind, detail, checked_at, visit_id from public.listing_evidence
                            where listing_id = $1 order by kind, id`, [visitListing.id]);
  if (after.rows.length !== 4) return 'the second visit left ' + after.rows.length + ' row(s), not 4';

  for (const row of before.rows) {
    const same = after.rows.find((r) => r.id === row.id);
    if (!same) return 'the first visit\u2019s row ' + row.kind + ' was deleted';
    if (same.detail !== row.detail || String(same.checked_at) !== String(row.checked_at)) {
      return 'the first visit\u2019s ' + row.kind + ' row was edited: ' + JSON.stringify(same);
    }
  }
  const visits = await val(`select count(distinct visit_id)::int from public.listing_evidence
                             where listing_id = $1`, [visitListing.id]);
  return Number(visits) === 2 ? true : 'the two visits read as ' + visits + ' group(s)';
});

/* ============================================================
   SUMMARY
   ============================================================ */

console.log('\n' + '='.repeat(66));
console.log('APPLIED (run 1, then run 2 \u2014 the order is the dependency order)');
applied.filter((a) => a.run === 1).forEach((a, i) => {
  console.log('  ' + (i + 1) + '. ' + a.file.padEnd(32) + String(a.lines).padStart(4) + ' lines');
});
console.log('  all ' + FILES.length + ' re-applied unchanged in run 2');
console.log('\n' + '='.repeat(66));
console.log('TOTAL ' + (pass + fail) + ' \u00b7 PASS ' + pass + ' \u00b7 FAIL ' + fail);
if (fail) {
  console.log('\nFailures:');
  failures.forEach(([n, e]) => console.log('  \u2717 ' + n + '\n      ' + e));
}
console.log('='.repeat(66));

await db.close();
process.exit(fail ? 1 : 0);
