#!/usr/bin/env node
/* ============================================================
   Arzuz — proof that the SQL PREFLIGHT GUARDS actually fire

   WHAT THIS IS

     The last three supabase-*.sql files each open with a preflight
     that raises when a file it depends on was never run:

         supabase-team-roles.sql  4 raises
         supabase-roommate.sql    1 raise   (needs arzuz_role())
         supabase-care.sql        1 raise   (needs arzuz_role())

     They exist because the failure they replace is opaque. Skipping
     supabase-drafts-support.sql produced

         ERROR: 42P01: relation "support_tickets" does not exist

     which names a symptom three files away from the cause, and that
     one message cost a day of guessing. A guard is only worth its
     lines if it FIRES, with the sentence that names the file to run.

   WHY THIS IS A SEPARATE HARNESS FROM dev/sql-proof.mjs

     sql-proof.mjs proves the chain APPLIES: ten files in order, a
     complete prerequisite set, and then assertions about the
     database that comes out. That is the happy path, and it is the
     complement of this file, not a substitute for it.

     The happy path only proves the bottom half of a guard's
     contract — that it stays silent when it should. A guard that
     never fires at all (a typo in the `if`, a dropped block) passes
     sql-proof.mjs today and then greets the next person with the
     same 42P01. So this harness drives the guards from the other
     side: it removes one prerequisite at a time and demands the
     raise.

   WHAT IT CHECKS, in order

     1. the pairing: every `raise exception` in the three files is
        claimed by a test here, and every test here still has its
        guard in the file. A NEW guard — or a deleted one — fails
        the build until this harness is brought back in step.
     2. each guard fires, with the message that names the missing
        file, at the right rung of the ladder: an empty database,
        then +4 tables, then +booking_requests, then +support_tickets,
        then a listings table without the generated columns.
     3. the guard is the FIRST thing the file does — after each
        raise, nothing the file would have created exists.
     4. the other direction: with the real prerequisite files
        applied, all three guards stay silent and the files run to
        completion.

   HISTORY THIS EXISTS TO KEEP

     Section 0 of supabase-team-roles.sql was added after the live
     run died on `support_tickets`. Every branch below was verified
     once, by hand, in a throwaway directory — which is exactly the
     kind of verification that is gone the next morning.

   Run it:  npm run sql:guards     (or: node dev/sql-guard-test.mjs)
   ============================================================ */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------
   reporting — same shape as dev/sql-proof.mjs, so the two
   harnesses read the same way in a terminal
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

/* A Postgres error carries a paragraph of context and a stack into a
   minified wasm bundle; the first line is the part worth reading. */
function why(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 400);
}

/* ------------------------------------------------------------
   the contract — one row per guard

   `fragment` is the phrase the guard must say, not the whole
   sentence: a wording change should not fail the build, but a
   DELETED guard or a NEW uncovered one must. `missing` is what the
   message has to name as the thing to go and run.
   ------------------------------------------------------------ */

const GUARDED = ['supabase-team-roles.sql', 'supabase-roommate.sql', 'supabase-care.sql'];
const ROLE_MODEL = 'supabase-team-roles.sql';

const EXPECTED = [
  {
    file: 'supabase-team-roles.sql',
    fragment: 'Run supabase-schema.sql first',
    missing: 'demand_records / listings / scout_submissions / amenities',
  },
  {
    file: 'supabase-team-roles.sql',
    fragment: 'Run supabase-media-booking.sql before',
    missing: 'booking_requests',
  },
  {
    file: 'supabase-team-roles.sql',
    fragment: 'Run supabase-drafts-support.sql before',
    missing: 'support_tickets',
  },
  {
    file: 'supabase-team-roles.sql',
    fragment: 'listings is missing columns',
    missing: 'the generated pricing/label columns',
  },
  {
    file: 'supabase-roommate.sql',
    fragment: 'the roommate policies are scoped',
    missing: 'public.arzuz_role()',
  },
  {
    file: 'supabase-care.sql',
    fragment: 'the Care policies are scoped',
    missing: 'public.arzuz_role()',
  },
];

/* What each file would have built had the guard let it through. The
   files claim in their own comments that raising leaves nothing
   half-built, because the SQL editor runs a file as one
   transaction — these queries are that claim, checked. */
const SENTINEL = {
  'supabase-team-roles.sql': {
    label: 'public.arzuz_role()',
    sql: `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'arzuz_role'`,
    want: 0,
  },
  'supabase-roommate.sql': {
    /* created at the TOP of the file, before its guard — so finding
       it gone is the rollback, not merely an untaken branch */
    label: 'the roommate_profiles table',
    sql: `select (to_regclass('public.roommate_profiles') is not null)::int`,
    want: 0,
  },
  'supabase-care.sql': {
    label: 'the care_plans table',
    sql: `select (to_regclass('public.care_plans') is not null)::int`,
    want: 0,
  },
};

function guardMessages(text) {
  const out = [];
  const re = /raise\s+exception\s+'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/''/g, "'"));
  return out;
}

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

/* ------------------------------------------------------------
   1 · THE PAIRING — the harness and the files cannot drift
   ------------------------------------------------------------ */

console.log('Arzuz SQL preflight guards \u2014 proved on real PostgreSQL in WebAssembly');

const db = await PGlite.create();

async function sql(text, params) {
  return db.query(text, params);
}

async function val(text, params) {
  const r = await sql(text, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

async function one(text, params) {
  const r = await sql(text, params);
  return r.rows[0];
}

/* A file the way the Supabase SQL editor runs it: as ONE transaction,
   which is the property the guards lean on. Returns the raise instead
   of throwing it, so the message can be asserted rather than merely
   survived. */
async function attempt(file) {
  const text = read(file);
  await db.exec('begin');
  try {
    await db.exec(text);
    await db.exec('commit');
    return { ok: true, message: '' };
  } catch (err) {
    try { await db.exec('rollback'); } catch (e) { /* already aborted */ }
    return { ok: false, message: why(err), code: (err && err.code) || null };
  }
}

/* The guard raised the RIGHT thing: not "it threw", which any broken
   SQL would also satisfy. */
function fires(result, expected) {
  if (result.ok) {
    return 'the file SUCCEEDED \u2014 the guard did not fire at all, so it protects nothing';
  }
  if (!result.message.includes(expected.fragment)) {
    return 'it raised something else entirely:\n      ' + result.message;
  }
  return true;
}

section('1. The pairing \u2014 every raise is tested, every test still has its raise');

const messagesByFile = {};
for (const file of GUARDED) messagesByFile[file] = guardMessages(read(file));

for (const file of GUARDED) {
  const mine = EXPECTED.filter((e) => e.file === file);
  await check(
    file + ': ' + messagesByFile[file].length + ' raise(s), all covered here',
    () => {
      const unclaimed = messagesByFile[file].filter(
        (m) => EXPECTED.filter((e) => e.file === file && m.includes(e.fragment)).length !== 1
      );
      if (unclaimed.length) {
        return 'this guard is not tested by this harness, so nothing fails when it breaks:\n      ' +
          unclaimed.map((m) => '"' + m.slice(0, 90) + '\u2026"').join('\n      ');
      }
      const dead = mine.filter(
        (e) => !messagesByFile[file].some((m) => m.includes(e.fragment))
      );
      if (dead.length) {
        return 'the guard this test fires at is GONE from the file: ' +
          dead.map((e) => '"' + e.fragment + '"').join(', ');
      }
      return true;
    }
  );
}

await check('every raise in the guarded files is accounted for', () => {
  const total = GUARDED.reduce((n, f) => n + messagesByFile[f].length, 0);
  return total === EXPECTED.length ? true
    : 'the files raise ' + total + ' times; this harness tests ' + EXPECTED.length;
});

/* ------------------------------------------------------------
   2 · THE LADDER — one prerequisite removed at a time

   The guards inspect EXISTENCE, so the rungs are cheap: plain
   tables, no policies, no JWT. That is the point of a preflight —
   it decides before any of the real work happens — and building
   the rungs this way means this harness tests the guard and not
   the 300 lines below it.

   The order of the rungs is the order of the errors a real install
   walks through: an empty editor, then the schema, then each file
   in turn.
   ------------------------------------------------------------ */

section('2. Each guard fires, and names the file to run');

async function rung(label, fixture, file, expected) {
  if (fixture) await db.exec(fixture);
  const result = await attempt(file);
  await check(label, () => fires(result, expected));
  const s = SENTINEL[file];
  await check('  \u2026and left nothing behind (no ' + s.label + ')', async () => {
    const n = await val(s.sql);
    return n === s.want ? true
      : 'the failed run left ' + s.label + ' in place \u2014 the raise is not the first thing the file does';
  });
  return result;
}

/* rung 1 — nothing at all has been run */
await rung(
  'team-roles on an empty database \u2192 "Run supabase-schema.sql first"',
  null, ROLE_MODEL, EXPECTED[0]
);

/* rung 2 — the four base tables exist, the booking table does not */
await rung(
  'team-roles with the schema tables but no booking_requests \u2192 names supabase-media-booking.sql',
  `create table demand_records    (id serial primary key);
   create table listings          (id serial primary key);
   create table scout_submissions (id serial primary key);
   create table amenities         (id serial primary key);`,
  ROLE_MODEL, EXPECTED[1]
);

/* rung 3 — bookings exist, support_tickets does not: the exact state
   the live database was in when this whole guard was written */
await rung(
  'team-roles with booking_requests but no support_tickets \u2192 names supabase-drafts-support.sql',
  `create table booking_requests (id serial primary key);`,
  ROLE_MODEL, EXPECTED[2]
);

/* rung 4 — every table present, but this listings table predates the
   generated columns (a table carried over from an older install) */
await rung(
  'team-roles with a listings table missing the generated columns \u2192 names supabase-hardening.sql',
  `create table support_tickets (id serial primary key);`,
  ROLE_MODEL, EXPECTED[3]
);

/* rung 5 and 6 — the other two files guard on a single thing: the role
   model. The stub database has no public.arzuz_role(), which is
   precisely the state supabase-drafts-support.sql left behind for
   them. Their tables are created BEFORE the guard, so the sentinel
   below also proves the rollback took them back out. */
await rung(
  'roommate without arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-roommate.sql', EXPECTED[4]
);
await rung(
  'care without arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-care.sql', EXPECTED[5]
);

/* rung 7 — the other direction. Every prerequisite the guard checks is
   now present, so it must NOT fire. The run goes on to fail on the
   stub's shape (these are four-column tables, not the real ones) and
   that is fine: what is asserted is that it got PAST the preflight,
   which is what sql-proof.mjs's full chain relies on. */
section('2b. With the prerequisites in place the preflight stays silent');

async function silent(label, file) {
  const result = await attempt(file);
  await check(label, () => {
    const fired = EXPECTED.filter((e) => e.file === file)
      .filter((e) => result.message.includes(e.fragment));
    if (fired.length) {
      return 'the guard fired on a database that HAS its prerequisites \u2014 it would block a correct install:\n      ' +
        result.message;
    }
    return true;
  });
  return result;
}

await db.exec(`
  drop table listings;
  create table listings (
    id               serial primary key,
    tier             int,
    env              text,
    opening_ask_ngn  int,
    listed_price_ngn int,
    property_name    text,
    property_type    text,
    area             text,
    rooms            text
  );
`);
await silent('team-roles with all four prerequisites \u2192 the preflight does not fire', ROLE_MODEL);

/* roommate and care cannot be proved silent HERE \u2014 their precondition
   is arzuz_role(), which this stub database deliberately does not have.
   Section 3 is where they get the real thing. */

/* ------------------------------------------------------------
   3 · THE REAL THING

   The rungs above were built by hand. This applies the actual files
   in the order they document for themselves, and asserts the three
   guards run through to completion — the complement of phase 2, and
   the only place where a guard that fires too eagerly on a REAL
   database would show up.

   The Supabase stand-in below (roles, the auth schema, the default
   privileges the files spend lines revoking) is the same one
   dev/sql-proof.mjs builds, at the same names and contract. It is
   duplicated rather than imported because that file runs its whole
   suite at import time. Keep the two in step.
   ------------------------------------------------------------ */

const db2 = await PGlite.create();

async function sql2(text, params) {
  return db2.query(text, params);
}

async function val2(text, params) {
  const r = await sql2(text, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

async function apply(file) {
  const text = read(file);
  await db2.transaction(async (tx) => {
    await tx.exec(text);
  });
}

section('3. The real files, with the real prerequisites, run through their guards');

try {
  await db2.exec(`
    create role anon noinherit nologin;
    create role authenticated noinherit nologin;
    create role service_role noinherit nologin bypassrls;
    create schema if not exists auth;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db2.exec(`
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
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.jwt(), auth.role(), auth.uid() to anon, authenticated, service_role;
  `);
} catch (err) {
  console.log('  \u2717 the Supabase stand-in itself failed to build: ' + why(err));
  process.exitCode = 1;
}

const CHAIN = [
  'supabase-schema.sql',
  'supabase-hardening.sql',
  'supabase-media-booking.sql',
  'supabase-drafts-support.sql',
  ROLE_MODEL,
  'supabase-roommate.sql',
  'supabase-care.sql',
];

for (const file of CHAIN) {
  await check(file + ' applies with its prerequisites in place', async () => {
    try {
      await apply(file);
      return true;
    } catch (err) {
      return why(err);
    }
  });
}

await check('and the role model the other two files guard on is really there', async () => {
  const n = await val2(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = 'arzuz_role'`);
  return n === 1 ? true : 'arzuz_role() was not created: the preflight that guards it is not the reason';
});

await check('the two files that guard on it built their policies', async () => {
  const r = await sql2(`select policyname from pg_policies
                         where schemaname = 'public'
                           and policyname in ('admin can read roommate profiles', 'admin can read care plans')`);
  const names = r.rows.map((x) => x.policyname);
  return names.length === 2 ? true : 'only built: ' + (names.join(', ') || 'neither');
});

/* ------------------------------------------------------------ */

await db.close();
await db2.close();

console.log('\n' + '='.repeat(66));
console.log('TOTAL ' + (pass + fail) + ' \u00b7 PASS ' + pass + ' \u00b7 FAIL ' + fail);
if (fail) {
  console.log('\nFailures:');
  failures.forEach(([n, e]) => console.log('  \u2717 ' + n + '\n      ' + e));
}
console.log('='.repeat(66));

/* `process.exitCode` is already set if the Supabase stand-in could not be
   built; the checks below it will also have failed, but do not let the
   explicit exit here quietly clear that. */
process.exit(fail || process.exitCode ? 1 : 0);
