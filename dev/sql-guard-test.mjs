#!/usr/bin/env node
/* ============================================================
   Arzuz — proof that the SQL PREFLIGHT GUARDS actually fire

   WHAT THIS IS

     Seven of the supabase-*.sql files each open with a preflight
     that raises when a file it depends on was never run:

         supabase-team-roles.sql  4 raises  (the schema, booking,
                                             support and the columns)
         supabase-roommate.sql    1 raise   (needs arzuz_role())
         supabase-care.sql        1 raise   (needs arzuz_role())
         supabase-finance.sql     2 raises  (arzuz_role(), care)
         supabase-claims.sql      3 raises  (arzuz_role(), care, the books)
                                   plus 2 argument guards inside its two
                                   call-out functions
         supabase-waitlist-launch.sql
                                  2 raises  (the schema's demand_records
                                             and listings, then arzuz_role())
         supabase-close-public-inserts.sql
                                  2 raises  (the five public submission
                                             tables, then the validated
                                             door's own waitlist_throttle())

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

     1. the SCOPE: every root supabase-*.sql is scanned for
        `raise exception`. A file that raises and is not listed here
        fails the build by name — so a new migration's guard cannot
        arrive untested, and the list below cannot shrink to hide a
        file that dropped its guard.
     2. the pairing: every `raise exception` in those files is
        claimed by a test here, and every test here still has its
        guard in the file. A NEW guard — or a deleted one — fails
        the build until this harness is brought back in step. This
        is what caught supabase-close-public-inserts.sql: adding a
        migration with a preflight and no rung is a build failure,
        not a silent gap.
     3. each guard fires, with the message that names the missing
        file, at the right rung of the ladder: an empty database,
        then +4 tables, then +booking_requests, then +support_tickets,
        then a listings table without the generated columns, then the
        money core and the claims that spend against it, the
        launch waitlist's two prerequisites (the schema's tables, and
        the role model its audit trail records), and the two the door
        closer guards on (the five tables, and the door itself).
     4. the guard is the FIRST thing the file does — after each
        raise, nothing the file would have created exists.
     5. the other direction: with the real prerequisite files
        applied, every guard stays silent and the files run to
        completion.
     6. the two argument guards inside the claims file's call-out
        functions fire too — a null plan raises instead of quietly
        reserving against the wrong pass.

   HISTORY THIS EXISTS TO KEEP

     Section 0 of supabase-team-roles.sql was added after the live
     run died on `support_tickets`. Every branch below was verified
     once, by hand, in a throwaway directory — which is exactly the
     kind of verification that is gone the next morning.

   Run it:  npm run sql:guards     (or: node dev/sql-guard-test.mjs)
   ============================================================ */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
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

const GUARDED = [
  'supabase-team-roles.sql',
  'supabase-roommate.sql',
  'supabase-care.sql',
  'supabase-finance.sql',
  'supabase-claims.sql',
  'supabase-waitlist-launch.sql',
  'supabase-verification-rpc.sql',
  'supabase-verification-queue.sql',
  'supabase-status-codes.sql',
  'supabase-status-history.sql',
  'supabase-close-public-inserts.sql',
];
const ROLE_MODEL = 'supabase-team-roles.sql';

/* Every root migration, whether it raises or not. Read at run time
   rather than listed, so the SCOPE check below sees a new file the
   moment it lands — that is the whole point of it. */
const ALL_SQL = readdirSync(ROOT).filter((f) => /^supabase-.*\.sql$/.test(f)).sort();

const EXPECTED = [
  {
    key: 'team.schema',
    file: 'supabase-team-roles.sql',
    fragment: 'Run supabase-schema.sql first',
    missing: 'demand_records / listings / scout_submissions / amenities',
  },
  {
    key: 'team.booking',
    file: 'supabase-team-roles.sql',
    fragment: 'Run supabase-media-booking.sql before',
    missing: 'booking_requests',
  },
  {
    key: 'team.support',
    file: 'supabase-team-roles.sql',
    fragment: 'Run supabase-drafts-support.sql before',
    missing: 'support_tickets',
  },
  {
    key: 'team.columns',
    file: 'supabase-team-roles.sql',
    fragment: 'listings is missing columns',
    missing: 'the generated pricing/label columns',
  },
  {
    key: 'roommate.role',
    file: 'supabase-roommate.sql',
    fragment: 'the roommate policies are scoped',
    missing: 'public.arzuz_role()',
  },
  {
    key: 'care.role',
    file: 'supabase-care.sql',
    fragment: 'the Care policies are scoped',
    missing: 'public.arzuz_role()',
  },

  /* The money core. Its two guards are ordered: the role model first,
     because everything below is scoped by it, then the Care tables it
     extends with the coverage columns. */
  {
    key: 'finance.role',
    file: 'supabase-finance.sql',
    fragment: 'the finance policies are scoped',
    missing: 'public.arzuz_role()',
  },
  {
    key: 'finance.care',
    file: 'supabase-finance.sql',
    fragment: 'the coverage columns below extend care_plans',
    missing: 'care_plans / care_credit_events',
  },

  /* Claims, which sit on top of both. Its three preflight guards follow
     the same order, and the last one is the reason the order is
     asserted: a claim whose cost was posted to a ledger that does not
     exist is the failure this names. */
  {
    key: 'claims.role',
    file: 'supabase-claims.sql',
    fragment: 'the claim policies are scoped',
    missing: 'public.arzuz_role()',
  },
  {
    key: 'claims.care',
    file: 'supabase-claims.sql',
    fragment: 'a claim is filed against a pass and spends its call-outs',
    missing: 'care_plans / care_credit_events',
  },
  {
    key: 'claims.ledger',
    file: 'supabase-claims.sql',
    fragment: 'the cost of a completed repair is a posting',
    missing: 'ledger_entries (supabase-finance.sql)',
  },

  /* Not a preflight: these two live INSIDE the call-out functions, and
     they guard the same thing the advisory lock does — that a call-out
     is only ever spent against a real pass. A null plan has to raise
     rather than reserve against nothing, so they are driven directly
     in section 3b rather than through a rung. */
  {
    key: 'claims.reserve',
    file: 'supabase-claims.sql',
    fragment: 'claim_reserve_callout: a plan is required',
    missing: 'a null plan_id',
    kind: 'argument',
  },
  {
    key: 'claims.release',
    file: 'supabase-claims.sql',
    fragment: 'claim_release_callout: a plan is required',
    missing: 'a null plan_id',
    kind: 'argument',
  },

  /* The launch waitlist, which is last in the chain and guards on two
     things in order: the tables it extends, then the role model its
     policies and its audit trail are scoped by. The order matters for
     the same reason it matters in its own file — the second guard can
     only be reached once the first is satisfied.

     Every entry names itself below (`key`), and every rung asks for
     its guard BY NAME rather than by position — so this list is safe
     to insert into, which it was not while the rungs counted with
     EXPECTED[0]… */
  {
    key: 'waitlist.schema',
    file: 'supabase-waitlist-launch.sql',
    fragment: 'A waitlist table is missing. Run supabase-schema.sql first',
    missing: 'demand_records / listings',
  },
  {
    key: 'waitlist.role',
    file: 'supabase-waitlist-launch.sql',
    fragment: 'public.arzuz_role() is missing. Run supabase-team-roles.sql',
    missing: 'public.arzuz_role()',
  },

  /* The last file in the chain, which closes the direct path anon has
     held since supabase-schema.sql. Its two guards are ordered the way
     the mistake would be made: first the privileges it revokes have to
     exist to be revoked FROM, then — the load-bearing one — the
     validated door has to be there. Closing the direct door on a
     database that has no validated one leaves the site with no door at
     all, which is a worse failure than the one this file fixes. */
  {
    key: 'close.tables',
    file: 'supabase-close-public-inserts.sql',
    fragment: 'The public submission tables are missing. Run supabase-schema.sql',
    missing: 'the five public submission tables',
  },
  {
    key: 'close.door',
    file: 'supabase-close-public-inserts.sql',
    fragment: 'The waitlist door is missing. Run supabase-waitlist-launch.sql',
    missing: 'public.waitlist_throttle()',
  },

  /* The column-scoped verification RPC, which narrows what a verification
     token may write on a listing to four columns and withdraws the
     row-wide policy that let it write the rest (LAUNCH-READINESS.md risk
     2). Its three preflights are ordered the way the three mistakes are
     made: no listings at all, then the tables without the role model its
     own authorization reads, then — the one that would otherwise be
     SILENT, because plpgsql does not resolve a column until the function
     is first called — an install that skipped supabase-waitlist-launch.sql
     and therefore has no verified_at to write. */
  {
    key: 'verification.schema',
    file: 'supabase-verification-rpc.sql',
    fragment: 'public.listings is missing. Run supabase-schema.sql first',
    missing: 'public.listings',
  },
  {
    key: 'verification.role',
    file: 'supabase-verification-rpc.sql',
    fragment: 'public.arzuz_role() is missing. Run supabase-team-roles.sql',
    missing: 'public.arzuz_role()',
  },
  {
    key: 'verification.columns',
    file: 'supabase-verification-rpc.sql',
    fragment: 'Run supabase-waitlist-launch.sql before this file',
    missing: 'listings.verified_at / verified_by / tier',
  },

  /* And the four raises INSIDE the function, which are the refusals the
     narrowing actually rests on: who may call it, that the row exists,
     and that the two values it moves are in their vocabularies. They are
     driven in section 4c against the real chain, because a stub database
     has no such function to call — the same treatment, and for the same
     reason, as the two call-out guards in section 4b. */
  {
    key: 'verification.who',
    file: 'supabase-verification-rpc.sql',
    fragment: 'may not verify a listing',
    missing: 'a verification or admin claim',
    kind: 'argument',
  },
  {
    key: 'verification.exists',
    file: 'supabase-verification-rpc.sql',
    fragment: 'listing_verify: no listing with id',
    missing: 'a listing that exists',
    kind: 'argument',
  },
  {
    key: 'verification.status',
    file: 'supabase-verification-rpc.sql',
    fragment: 'is not a listing status',
    missing: 'a status in the listing vocabulary',
    kind: 'argument',
  },
  {
    key: 'verification.tier',
    file: 'supabase-verification-rpc.sql',
    fragment: 'is out of range',
    missing: 'a tier between 0 and 2',
    kind: 'argument',
  },

  /* STAGE 2, supabase-verification-queue.sql: the shift that gets somebody
     to the door to make that decision. Its three preflights are the same
     three mistakes in the same order as the file above, because the two
     files read the same prerequisites — with one difference worth having
     tested: this file's read function and its trail are meaningless
     without the columns the DECISION writes, so the third guard checks
     the launch columns too. */
  /* The desk's half of the status page. Its one prerequisite is the code
     table it re-states a function from and adds a column to — so the
     mistake this guard catches is an install that ran this file and not
     supabase-status-codes.sql, which would otherwise fail later on a
     missing column, at the first student who checked their status. */
  {
    key: 'desk.codes',
    file: 'supabase-status-history.sql',
    fragment: 'Run supabase-status-codes.sql before this file',
    missing: 'public.status_codes',
  },

  /* And the second raise in that file: the reader refuses a login outside
     the desk. It is not a preflight — it guards the QUESTION rather than
     the install — so it is driven against the real chain in section 4e
     below, the same treatment the shift's refusals get. */
  {
    key: 'desk.who',
    file: 'supabase-status-history.sql',
    fragment: 'may not read a reference',
    missing: 'a support or admin claim',
    kind: 'argument',
  },

  {
    key: 'shift.schema',
    file: 'supabase-verification-queue.sql',
    fragment: 'public.listings is missing. Run supabase-schema.sql first',
    missing: 'public.listings',
  },
  {
    key: 'shift.role',
    file: 'supabase-verification-queue.sql',
    fragment: 'public.arzuz_role() is missing. Run supabase-team-roles.sql',
    missing: 'public.arzuz_role()',
  },
  {
    key: 'shift.launch',
    file: 'supabase-verification-queue.sql',
    fragment: 'Run supabase-waitlist-launch.sql before this file',
    missing: 'listings.assigned_to / verified_at / verified_by',
  },

  /* And the eleven refusals inside its four functions, which are the whole
     reason a claim can be trusted: who may read the shift at all, who may
     take a listing, that the row is real, that it has not been decided,
     and that somebody else's claim is not yours to touch. Driven in
     section 4d against the real chain, the same treatment as the four
     above. */
  {
    key: 'shift.queue.who',
    file: 'supabase-verification-queue.sql',
    fragment: 'may not read the verification queue',
    missing: 'a verification or admin claim',
    kind: 'argument',
  },
  {
    key: 'shift.take.who',
    file: 'supabase-verification-queue.sql',
    fragment: 'may not take a listing for verification',
    missing: 'a verification or admin claim',
    kind: 'argument',
  },
  {
    key: 'shift.take.exists',
    file: 'supabase-verification-queue.sql',
    fragment: 'listing_take: no listing with id',
    missing: 'a listing that exists',
    kind: 'argument',
  },
  {
    key: 'shift.take.decided',
    file: 'supabase-verification-queue.sql',
    fragment: 'already been decided',
    missing: 'a listing nobody has ruled on',
    kind: 'argument',
  },
  {
    key: 'shift.take.held',
    file: 'supabase-verification-queue.sql',
    fragment: 'already has that listing',
    missing: 'a listing nobody else holds',
    kind: 'argument',
  },
  {
    key: 'shift.release.who',
    file: 'supabase-verification-queue.sql',
    fragment: 'may not release a listing',
    missing: 'a verification, admin or service claim',
    kind: 'argument',
  },
  {
    key: 'shift.release.exists',
    file: 'supabase-verification-queue.sql',
    fragment: 'listing_release: no listing with id',
    missing: 'a listing that exists',
    kind: 'argument',
  },
  {
    key: 'shift.release.empty',
    file: 'supabase-verification-queue.sql',
    fragment: 'is not held by anybody',
    missing: 'a listing somebody actually holds',
    kind: 'argument',
  },
  {
    key: 'shift.release.stolen',
    file: 'supabase-verification-queue.sql',
    fragment: 'holds that listing, not you',
    missing: 'the officer named on the listing',
    kind: 'argument',
  },
  {
    key: 'shift.nudge.who',
    file: 'supabase-verification-queue.sql',
    fragment: 'may not write to the verification trail',
    missing: 'the service role the clock runs as',
    kind: 'argument',
  },
  {
    key: 'shift.nudge.exists',
    file: 'supabase-verification-queue.sql',
    fragment: 'verification_nudge: no listing with id',
    missing: 'a listing that exists',
    kind: 'argument',
  },

  /* The status page, which has ONE prerequisite and therefore one guard.
     It is the registry rather than the two waitlist tables, and the
     difference matters: a database that has demand_records and listings
     but never ran the launch file has no `ref` column on either of them,
     so the guard would let through an install whose every function fails
     on the first student who used the page — and plpgsql would not have
     said a word while the file was being run. */
  {
    key: 'status.launch',
    file: 'supabase-status-codes.sql',
    fragment: 'Run supabase-waitlist-launch.sql before this file',
    missing: 'public.waitlist_ref_registry',
  },
];

/* ------------------------------------------------------------
   THE NAMES — why a rung asks for its guard, never for a position

   EXPECTED is a list, and a rung written as EXPECTED[7] is a rung that
   points somewhere else the instant an entry is inserted above it. The
   array is still long enough, so nothing fails — the rung goes on
   passing, and it is now proving the wrong sentence. Every rung below
   asks for its guard by `key` instead. A key that is missing, or that
   two entries share, is reported as its own check; and a rung that
   names a key nobody defined FAILS that rung by name rather than
   crashing the harness, so the totals still print and the typo is read
   in the failure line.
   ------------------------------------------------------------ */

const BY_KEY = {};
const KEY_PROBLEMS = [];
EXPECTED.forEach((e) => {
  if (!e.key) KEY_PROBLEMS.push('an entry has no key: "' + String(e.fragment).slice(0, 60) + '"');
  else if (BY_KEY[e.key]) KEY_PROBLEMS.push('two entries share the key "' + e.key + '"');
  else BY_KEY[e.key] = e;
});

/* A miss returns an object whose fragment nothing can match, so the
   rung that asked for it fails and prints the key it could not find. */
const guard = (key) => BY_KEY[key] || {
  file: '(none)', fragment: '\u0000no guard is named "' + key + '"',
  missing: 'a guard named "' + key + '" in EXPECTED',
};

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
  'supabase-finance.sql': {
    label: 'the finance_config table',
    sql: `select (to_regclass('public.finance_config') is not null)::int`,
    want: 0,
  },
  'supabase-claims.sql': {
    label: 'the repair_claims table',
    sql: `select (to_regclass('public.repair_claims') is not null)::int`,
    want: 0,
  },
  'supabase-waitlist-launch.sql': {
    /* created after the guard, so finding it gone is the rollback and not
       merely an untaken branch — the same shape as team-roles' sentinel */
    label: 'the waitlist_ref_registry table',
    sql: `select (to_regclass('public.waitlist_ref_registry') is not null)::int`,
    want: 0,
  },
  'supabase-close-public-inserts.sql': {
    /* This file creates no object, so there is no table to look for gone.
       What it changes is a GRANT, and the property to assert is the
       inverse: anon still HOLDS insert on demand_records. The revoke sits
       below the preflight, so a raise means it never ran. On the
       empty-database rung there is no table to ask about, and the right
       answer there is "nothing was revoked" rather than a missing-table
       error — hence the case expression. */
    label: 'the surviving anon insert grant',
    sql: `select (case when to_regclass('public.demand_records') is null then 0
                      else (not has_table_privilege('anon', 'demand_records', 'insert'))::int end)`,
    want: 0,
  },
  'supabase-verification-rpc.sql': {
    /* The function is created AFTER the guard, so finding it gone on every
       rung is the rollback and not merely an untaken branch — the same
       shape as the waitlist file's sentinel. */
    label: 'public.listing_verify()',
    sql: `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'listing_verify'`,
    want: 0,
  },
  'supabase-verification-queue.sql': {
    /* Everything this file builds sits below its preflight, so on any rung
       where the guard fires, the trail table and all five functions must be
       absent. Asked as one count: a table created without the functions
       that write it — or the reverse — would be half a shift, and a rung
       that let half of it through is a rung that proves nothing. */
    label: 'the shift (verification_events + its five functions)',
    sql: `select ((to_regclass('public.verification_events') is not null)::int
               + (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('arzuz_actor', 'verification_queue', 'listing_take',
                                       'listing_release', 'verification_nudge')))`,
    want: 0,
  },
  'supabase-status-codes.sql': {
    /* Both tables are created after the guard, so finding either one gone
       is the rollback rather than merely an untaken branch. Asked as a
       count of the two together: one of them existing without the other
       would be a guard that let half its work through. */
    label: 'the status_codes / status_guard tables',
    sql: `select ((to_regclass('public.status_codes') is not null)::int
               + (to_regclass('public.status_guard') is not null)::int)`,
    want: 0,
  },
  'supabase-status-history.sql': {
    /* Everything this file builds is built AFTER the guard, so any of it
       present on a rung where the guard fired means the file did work
       before it decided it could not. Asked as one count, the same shape
       as the shift's: a trail without the function that reads it — or the
       reverse — would be half a screen.

       status_phone_tail is in the count for the same reason and not
       because it is interesting on its own: it is the rule the desk's
       search and the student's own proof both go through, so a database
       holding it but not the search that calls it is half of exactly the
       failure this guard exists to catch. */
    label: 'the delivery trail, the phone rule and the two desk functions',
    sql: `select ((to_regclass('public.status_code_deliveries') is not null)::int
               + (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('status_code_delivery', 'status_history', 'status_phone_tail')))`,
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

/* ------------------------------------------------------------
   1 · THE SCOPE — no root migration guards an install untested

   The lists below are only as good as the day they were written. This
   reads the ROOT for every supabase-*.sql and requires each one that
   raises to be here. A new migration's preflight — the very thing
   this file exists to protect — cannot land without a rung, and a
   listed file whose guard was deleted is not quietly skipped either:
   both directions fail by name.
   ------------------------------------------------------------ */

section('1. The scope \u2014 no root migration raises without a test here');

const messagesByFile = {};
for (const file of ALL_SQL) messagesByFile[file] = guardMessages(read(file));

const raisingRootFiles = ALL_SQL.filter((f) => messagesByFile[f].length > 0);

await check(
  'every root supabase-*.sql that raises a preflight is in this harness (' +
    raisingRootFiles.length + ' of ' + ALL_SQL.length + ' migrations raise)',
  () => {
    const untested = raisingRootFiles.filter((f) => !GUARDED.includes(f));
    if (untested.length) {
      return 'these raise to protect an install and NOTHING here tests them:\n      ' +
        untested.map((f) => f + ' (' + messagesByFile[f].length + ' raise(s))').join('\n      ');
    }
    return true;
  }
);

await check('and every file this harness drives still raises something', () => {
  const quiet = GUARDED.filter((f) => !messagesByFile[f] || messagesByFile[f].length === 0);
  return quiet.length === 0 ? true
    : 'listed as guarded here, but no longer raises anything: ' + quiet.join(', ');
});

/* ------------------------------------------------------------
   2 · THE PAIRING — the harness and the files cannot drift
   ------------------------------------------------------------ */

section('2. The pairing \u2014 every raise is tested, every test still has its raise');

/* The names the rungs address. A key that is missing, or that two
   entries share, is a rung that could be pointed at the wrong guard
   without the array being the wrong length — which is the whole reason
   the rungs ask for a name. Reported here so it is a check that fails
   in the totals, not only a throw. */
await check('every expected guard answers to its own name', () =>
  KEY_PROBLEMS.length ? KEY_PROBLEMS.join('; ') : true);

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
   3 · THE LADDER — one prerequisite removed at a time

   The guards inspect EXISTENCE, so the rungs are cheap: plain
   tables, no policies, no JWT. That is the point of a preflight —
   it decides before any of the real work happens — and building
   the rungs this way means this harness tests the guard and not
   the 300 lines below it.

   The order of the rungs is the order of the errors a real install
   walks through: an empty editor, then the schema, then each file
   in turn.
   ------------------------------------------------------------ */

section('3. Each guard fires, and names the file to run');

/* The roles, and Supabase's default privileges over them. Not needed by
   any GUARD — every one of them reads existence — but needed by one
   SENTINEL: supabase-close-public-inserts.sql creates no object, so the
   only way to see that its raise left nothing behind is to ask who holds
   INSERT afterwards, and a privilege cannot be asked about a role that
   does not exist. Without this the sentinel would answer 0 on a database
   where it cannot see the grant at all, which is a tick that proves
   nothing. The tables the rungs create inherit these privileges, so the
   grant this file removes is genuinely present to be removed. */
await db.exec(`
  create role anon noinherit nologin;
  create role authenticated noinherit nologin;
  create role service_role noinherit nologin bypassrls;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);

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
  null, ROLE_MODEL, guard('team.schema')
);

/* rung 1b — the waitlist file on the same empty database. It guards on
   the two tables it extends, so on a database with nothing in it the
   FIRST of its two guards is the one that has to fire, and it has to
   name the file that creates them. */
await rung(
  'waitlist-launch on an empty database \u2192 "Run supabase-schema.sql first"',
  null, 'supabase-waitlist-launch.sql', guard('waitlist.schema')
);

/* rung 1c — the file that closes the direct path, on the same empty
   database. Its FIRST guard is the one for the privileges it revokes,
   and it has to name the file that creates the tables. */
await rung(
  'close-public-inserts on an empty database \u2192 "Run supabase-schema.sql first"',
  null, 'supabase-close-public-inserts.sql', guard('close.tables')
);

/* rung 1d — the verification RPC on the same empty database. Its first
   guard is the listings table itself, and it has to name the file that
   creates it rather than the two files that add to it. */
await rung(
  'verification-rpc on an empty database → "Run supabase-schema.sql first"',
  null, 'supabase-verification-rpc.sql', guard('verification.schema')
);

/* rung 1e — the status page on the same empty database. Its one guard
   names the launch migration, which is the file that creates the
   registry every function in it resolves a reference through. The stub
   fixtures below never create that registry — they satisfy the guards
   that inspect tables — so this guard fires on the ladder wherever it is
   asked, which is why its rung sits with the other empty-database
   rungs rather than at a particular depth. */
await rung(
  'status-codes on a database without the launch migration \u2192 names supabase-waitlist-launch.sql',
  null, 'supabase-status-codes.sql', guard('status.launch')
);

/* rung 1e-2 — the desk's half of the same page, on the same empty
   database. Its one prerequisite is the code table itself, and it has to
   name the file that makes it rather than the launch migration that file
   depends on: the two errors are different installs, and the fix for
   this one is a different file. */
await rung(
  'status-history on a database without the code table \u2192 names supabase-status-codes.sql',
  null, 'supabase-status-history.sql', guard('desk.codes')
);

/* rung 1f - the SHIFT on the same empty database. Stage 2 of the
   verification layer, and its first guard is the table the whole shift is
   about, so it has to name the file that creates it. */
await rung(
  'verification-queue on an empty database → "Run supabase-schema.sql first"',
  null, 'supabase-verification-queue.sql', guard('shift.schema')
);

/* rung 2 — the four base tables exist, the booking table does not */
await rung(
  'team-roles with the schema tables but no booking_requests \u2192 names supabase-media-booking.sql',
  `create table demand_records    (id serial primary key);
   create table listings          (id serial primary key);
   create table scout_submissions (id serial primary key);
   create table amenities         (id serial primary key);`,
  ROLE_MODEL, guard('team.booking')
);

/* rung 2b — the RPC's SECOND guard. The four tables exist, so the table
   guard above is satisfied; the role model does not, and the function's
   own authorization reads it. Placed here, on rung 2's fixture, because
   that is the database this state belongs to: everything table-shaped,
   nothing role-shaped. */
await rung(
  'verification-rpc with the tables but no arzuz_role() → names supabase-team-roles.sql',
  null, 'supabase-verification-rpc.sql', guard('verification.role')
);

/* rung 2c - the SHIFT's second guard on the same state: everything
   table-shaped, nothing role-shaped. Every function in it authorizes with
   public.arzuz_role(), so a database without that function would create
   them and refuse (or worse, admit) the wrong caller on first use. */
await rung(
  'verification-queue with the tables but no arzuz_role() → names supabase-team-roles.sql',
  null, 'supabase-verification-queue.sql', guard('shift.role')
);

/* rung 3 — bookings exist, support_tickets does not: the exact state
   the live database was in when this whole guard was written */
await rung(
  'team-roles with booking_requests but no support_tickets \u2192 names supabase-drafts-support.sql',
  `create table booking_requests (id serial primary key);`,
  ROLE_MODEL, guard('team.support')
);

/* rung 4 — every table present, but this listings table predates the
   generated columns (a table carried over from an older install) */
await rung(
  'team-roles with a listings table missing the generated columns \u2192 names supabase-hardening.sql',
  `create table support_tickets (id serial primary key);`,
  ROLE_MODEL, guard('team.columns')
);

/* rung 4b — the tables now exist and the role model still does not, so
   the waitlist file's SECOND guard is the one that has to fire. It is
   the same rung as the finance/claims role-model rungs below, placed
   here because the fixture that satisfies its first guard is rung 2's. */
await rung(
  'waitlist-launch with the tables but no arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-waitlist-launch.sql', guard('waitlist.role')
);

/* rung 4c — every table this file touches now exists and the validated
   door still does not, so its SECOND guard is the one that has to fire
   and it has to name supabase-waitlist-launch.sql. This is the rung that
   protects the site from being taken offline by its own hardening: a
   revoked grant with nothing behind it is a form that cannot be
   submitted at all. */
await rung(
  'close-public-inserts with the five tables but no waitlist_throttle() \u2192 names supabase-waitlist-launch.sql',
  null, 'supabase-close-public-inserts.sql', guard('close.door')
);

/* rung 5 and 6 — the other two files guard on a single thing: the role
   model. The stub database has no public.arzuz_role(), which is
   precisely the state supabase-drafts-support.sql left behind for
   them. Their tables are created BEFORE the guard, so the sentinel
   below also proves the rollback took them back out. */
await rung(
  'roommate without arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-roommate.sql', guard('roommate.role')
);
await rung(
  'care without arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-care.sql', guard('care.role')
);

/* rung 7 and 8 — the files added with the money core and the claim
   workflow. Both guard on the role model FIRST, so on a database that
   has no arzuz_role() they must name it the way roommate and care do. */
await rung(
  'finance without arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-finance.sql', guard('finance.role')
);
await rung(
  'claims without arzuz_role() \u2192 names supabase-team-roles.sql',
  null, 'supabase-claims.sql', guard('claims.role')
);

/* ... and then the role model arrives. A stub, not the real thing:
   every guard here reads EXISTENCE, which is what makes the rungs
   cheap and what keeps this harness testing the guard rather than the
   four hundred lines under it. */
await db.exec(`
  create or replace function public.arzuz_role()
  returns text language sql stable as $$ select 'admin'::text $$;
`);

/* rung 9 and 10 — the Care tables are still missing, so the SECOND
   guard in each file is the one that has to fire, and each has to
   name supabase-care.sql rather than repeating the role model it
   already found. */
await rung(
  'finance with the role model but no Care tables \u2192 names supabase-care.sql',
  null, 'supabase-finance.sql', guard('finance.care')
);
await rung(
  'claims with the role model but no Care tables \u2192 names supabase-care.sql',
  null, 'supabase-claims.sql', guard('claims.care')
);

/* rung 11 — a pass and its ledger exist, the BOOKS do not. The claim
   file's own header names this case: a repair's cost has nowhere to
   post, so a claim that could not be paid for must not be built. */
await rung(
  'claims with Care in place but no ledger_entries \u2192 names supabase-finance.sql',
  `create table care_plans         (id uuid primary key);
   create table care_credit_events (id serial primary key);`,   'supabase-claims.sql', guard('claims.ledger')
);

/* rung 11b — the RPC's THIRD guard, and the reason it exists rather than
   being left to the column's own name: plpgsql does not resolve a column
   until the function is first CALLED, so on an install that ran this file
   before the launch migration the function would be created happily and
   then fail on the first officer who approved anything. The role model is
   stubbed by now and listings exists (rung 2's fixture, which has an id
   and nothing else), so the missing verified_at is the one thing left to
   fire on — and the message has to name the file that adds it. */
await rung(
  'verification-rpc with the role model but a listings table that predates the launch columns → names supabase-waitlist-launch.sql',
  null, 'supabase-verification-rpc.sql', guard('verification.columns')
);

/* rung 11c - the SHIFT's third guard, on the same database: the role model
   is stubbed by now and listings exists (rung 2's fixture, an id and
   nothing else), so the three launch columns this file moves or reports are
   the one thing left to fire on — and the message has to name the file that
   adds them, because that is the file the operator has to run. */
await rung(
  'verification-queue with the role model but a listings table that predates the launch columns → names supabase-waitlist-launch.sql',
  null, 'supabase-verification-queue.sql', guard('shift.launch')
);

/* rung 12 — the other direction. Every prerequisite the guard checks is
   now present, so it must NOT fire. The run goes on to fail on the
   stub's shape (these are four-column tables, not the real ones) and
   that is fine: what is asserted is that it got PAST the preflight,
   which is what sql-proof.mjs's full chain relies on. */
section('3b. With the prerequisites in place the preflight stays silent');

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

/* The waitlist file's two prerequisites are the stub listings AND
   demand_records above plus the arzuz_role() stub, so its preflight is
   silent here too. The run then fails on the stub's shape — these
   tables have a status column on listings but no payload — and that is
   the point: what is asserted is that it got PAST both guards, which is
   what dev/sql-proof.mjs's full chain depends on. */
await silent('waitlist-launch with the tables and the role model \u2192 the preflight does not fire',
  'supabase-waitlist-launch.sql');

/* finance and claims can be proved silent here too, and for the same
   reason: their preconditions are the role model — stubbed above — and
   the Care tables, which rung 11 already left in place. The books are
   the one thing still missing, so stub them and demand three quiet
   preflights. The files then fail on the stub's shape, which is the
   whole point: this asserts they got PAST the guard. */
await db.exec(`
  create table if not exists care_plans         (id uuid primary key);
  create table if not exists care_credit_events (id serial primary key);
  create table if not exists ledger_entries     (id serial primary key);
`);
await silent('finance with the role model and Care present \u2192 the preflight does not fire',
  'supabase-finance.sql');
await silent('claims with the role model, Care and the books present \u2192 the preflight does not fire',
  'supabase-claims.sql');

/* The last file in the chain guards on the five tables — all present by
   rung 4 — and on the validated door's own function, which is the one
   thing no stub above has created. Stub it by its exact signature, since
   that is what the guard asks for, and demand a quiet preflight. The
   revoke below it is then free to run, which is the point: this file has
   no work to do in the happy path except the one statement it exists
   for. */
await db.exec(`
  create or replace function public.waitlist_throttle(
    text, text, integer, integer, integer
  ) returns jsonb language sql stable as $$ select '{"allow":true}'::jsonb $$;
`);
await silent('close-public-inserts with the five tables and the door present \u2192 the preflight does not fire',
  'supabase-close-public-inserts.sql');

/* The desk file's one prerequisite is the code table, and the stub below
   is only that: a table with the columns the ALTER and the re-stated
   function name. The file then runs for real on it — status_verify's
   body is not resolved until it is called, which is exactly the trap its
   own prerequisite chain has. What is asserted is that it got PAST the
   guard, which is all this harness can say about a file whose
   prerequisites are the whole status layer. */
await db.exec(`
  create table if not exists status_codes (
    id          bigserial primary key,
    ref         text        not null,
    code_hash   text        not null,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null,
    attempts    integer     not null default 0,
    consumed_at timestamptz
  );
`);
await silent('status-history with the code table present \u2192 the preflight does not fire',
  'supabase-status-history.sql');

/* roommate and care cannot be proved silent HERE \u2014 their precondition
   is arzuz_role(), which this stub database deliberately does not have.
   Section 3 is where they get the real thing. */

/* ------------------------------------------------------------
   4 · THE REAL THING

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

section('4. The real files, with the real prerequisites, run through their guards');

try {
  await db2.exec(`
    create role anon noinherit nologin;
    create role authenticated noinherit nologin;
    create role service_role noinherit nologin bypassrls;
    create schema if not exists auth;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
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
  /* the two that came last, in the only order that works: the money
     core before the claims that post to it */
  'supabase-finance.sql',
  'supabase-claims.sql',
  /* and now the launch waitlist, which is last for the same reason it
     is last in dev/sql-proof.mjs's list: it is the only file that
     writes to the reference registry and the only one whose policies
     need the role model's normalized names. */
  'supabase-waitlist-launch.sql',
  /* and then the file that narrows what a verification token may write on
     a listing to four columns. It follows the launch file because it
     writes the two columns that file adds — verified_at and verified_by —
     and it precedes the closer, which must stay last: every file above
     that one is written knowing anon can still POST. */
  'supabase-verification-rpc.sql',
  /* STAGE 2 of that layer, right after it: the shift that gets somebody to
     the door to make the decision the file above made correct. It reads
     arzuz_role() for every authorization and the three launch columns for
     its own preflight, and it sits above the closer for the same reason
     everything else here does. */
  'supabase-verification-queue.sql',
  /* and then the public status page, which resolves a reference through
     the registry the launch file creates — the one thing its preflight
     asks for. It sits above the closer for the same reason it does in
     dev/sql-proof.mjs: it has no opinion about anon's grants on the five
     public tables, so it may be built while anon can still POST. */
  'supabase-status-codes.sql',
  /* and then the desk's half of the same page, which adds a column to
     status_codes and RE-STATES status_verify, so it must follow the file
     that defines both. It sits above the closer for the same reason: it
     says nothing about anon's grants on the five public tables. */
  'supabase-status-history.sql',
  /* and then the file that closes the door behind it. It is the only
     migration in the chain that DEPENDS on another one having succeeded
     rather than merely applied — its second guard asks for
     waitlist_throttle() by signature — which is why it is here and not
     folded into the file above it. */
  'supabase-close-public-inserts.sql',
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

await check('and the role model every other file guards on is really there', async () => {
  const n = await val2(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = 'arzuz_role'`);
  return n === 1 ? true : 'arzuz_role() was not created: the preflight that guards it is not the reason';
});

/* One policy from each of the four files whose preflight asks the
   question — the proof that "it got past the guard" was followed by
   the work the guard was protecting, not merely by the guard. */
await check('the four files that guard on it built their policies', async () => {
  const wanted = ['admin can read roommate profiles', 'admin can read care plans',
    'admin reads finance config', 'admin reads claims'];
  const r = await sql2(`select policyname from pg_policies
                         where schemaname = 'public' and policyname = any($1)`,
    [wanted]);
  const names = r.rows.map((x) => x.policyname);
  const missing = wanted.filter((w) => !names.includes(w));
  return missing.length === 0 ? true : 'never built: ' + missing.join(', ');
});

/* ------------------------------------------------------------
   4b · THE ARGUMENT GUARDS

   Two of the fifteen raises are not preflights. They sit inside
   claim_reserve_callout() and claim_release_callout(), in front of
   the advisory lock, and they guard the same rule from the other
   side: a call-out is only ever spent against a real pass. If they
   were dead, a null plan would go looking for a ledger row it cannot
   have and the caller would get a confusing error instead of a
   sentence naming the argument.

   Driven against the real chain, because a stub database has no such
   function to call, and asserted the way every other guard is: the
   raise has to CARRY the sentence, not merely happen.
   ------------------------------------------------------------ */

section('4b. A call-out cannot be spent against no pass at all');

async function argumentGuard(key, call) {
  const want = guard(key);
  let raised = '';
  try {
    await sql2(call);
  } catch (err) {
    raised = why(err);
  }
  if (!raised) {
    return 'it ran with a NULL plan — ' + want.missing + ' was accepted, so the guard protects nothing';
  }
  return raised.includes(want.fragment) ? true : 'it raised something else:\n      ' + raised;
}

await check('claim_reserve_callout(NULL, ...) raises instead of reserving', () =>
  argumentGuard('claims.reserve',
    `select claim_reserve_callout(null, 'AZ-C-NULL', '2026/2027', 'x', 'y', 'production')`));

await check('claim_release_callout(NULL, ...) raises instead of giving one back', () =>
  argumentGuard('claims.release',
    `select claim_release_callout(null, 'AZ-C-NULL', '2026/2027', 'x', 'y', 'z', 'production')`));

/* and the refusal was total: neither attempt appended anything, which
   is the property these functions promise — a raise writes no row. */
await check('  …and neither attempt left a call-out on the ledger', async () => {
  const n = await val2(`select count(*)::int from care_credit_events
                         where reason like '%AZ-C-NULL%'`);
  return n === 0 ? true : 'a refused call raised AND moved the ledger: ' + n + ' row(s)';
});

/* ------------------------------------------------------------ */

/* ------------------------------------------------------------
   4c · THE VERIFICATION RPC'S OWN REFUSALS

   Four raises live inside public.listing_verify(), and they are the
   narrowness itself: who may call it, that the row exists, and that the
   two values it moves are in their vocabularies. They are driven against
   the REAL chain rather than a stub, because a stub database has no such
   function to call — the same treatment as section 4b.

   The last check is the one that keeps the first four honest: a function
   that refused EVERYTHING would satisfy them all, so the happy path is
   driven too, and the row is read back to prove it landed.
   ------------------------------------------------------------ */

section('4c. The verification RPC refuses what it must, and does the rest');

async function one2(text, params) {
  const r = await sql2(text, params);
  return r.rows[0] || null;
}

/* A session that looks exactly like a signed-in request: the claims GoTrue
   signs into the token, then the role PostgREST sets from them. */
async function asClaim(role, meta, fn) {
  const claims = { role: role, sub: '00000000-0000-4000-8000-000000000002' };
  if (meta) claims.app_metadata = meta;
  await sql2(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await sql2(`select set_config('request.jwt.claim.role', $1, false)`, [role]);
  await sql2('set role ' + role);
  try {
    return await fn();
  } finally {
    await sql2('reset role');
  }
}

async function attempt2(role, meta, call) {
  try {
    await asClaim(role, meta, () => sql2(call));
    return '';
  } catch (err) {
    return why(err);
  }
}

async function rpcGuard(key, role, meta, call) {
  const want = guard(key);
  const raised = await attempt2(role, meta, call);
  if (!raised) return 'it ran — ' + want.missing + ' was accepted, so the refusal protects nothing';
  return raised.includes(want.fragment) ? true : 'it raised something else:\n      ' + raised;
}

await db2.exec(`
  insert into listings (payload, status, tier)
  values ('{"nm":"Guard Owner","ph":"08030000009","rent":"120000","ar":"Malete","ty":"Self-contain","rm":"1","hp":""}'::jsonb,
          'pending', 0);
`);
const guardListing = await val2(`select id from listings where owner_phone = '08030000009'`);

await check('the RPC refuses a marketing token — and a support one, and reads neither as an officer', () =>
  rpcGuard('verification.who', 'authenticated', { role: 'marketing' },
    `select public.listing_verify('${guardListing}'::uuid, 'active', 1)`));

await check('  \u2026a support token as well', () =>
  rpcGuard('verification.who', 'authenticated', { role: 'support' },
    `select public.listing_verify('${guardListing}'::uuid, 'active', 1)`));

await check('the RPC refuses an id that is not a listing, rather than answering as if it were', () =>
  rpcGuard('verification.exists', 'authenticated', { role: 'verification' },
    `select public.listing_verify('00000000-0000-4000-8000-00000000dead'::uuid, 'active', 1)`));

await check('the RPC refuses a status outside the listing vocabulary', () =>
  rpcGuard('verification.status', 'authenticated', { role: 'verification' },
    `select public.listing_verify('${guardListing}'::uuid, 'featured', 1)`));

/* ============================================================
   4d. The SHIFT refuses what it must, and does the rest

   The ten refusals inside supabase-verification-queue.sql's three
   functions, driven the same way as the four above and for the same
   reason: a claim is the one write here that TWO people can make about
   the same row at the same time, so the refusals are not politeness —
   they are what stops two officers from each believing a listing is
   theirs, and one of them driving across town for nothing.

   The listing below is live at tier 0, which is exactly the state the
   shift exists for: on the board, and owed a visit.
   ============================================================ */

section('4d. The verification shift: who may take a listing, and from whom');

await db2.exec(`
  insert into listings (payload, status, tier)
  values ('{"nm":"Shift Owner","ph":"08030000010","rent":"130000","ar":"Malete","ty":"Self-contain","rm":"1","hp":""}'::jsonb,
          'active', 0);
`);
const shiftListingRow = await val2(`select id from listings where owner_phone = '08030000010'`);

/* The read comes first because everything else in the shift depends on
   it: an officer who cannot see the queue has nothing to take, and a
   role that is not on this shift should not be able to ask what is in
   it at all — the queue names owners, phones and addresses. */
await check('reading the queue refuses a marketing token, and a support one', async () => {
  const marketing = await rpcGuard('shift.queue.who', 'authenticated', { role: 'marketing' },
    `select * from public.verification_queue()`);
  if (marketing !== true) return marketing;
  return rpcGuard('shift.queue.who', 'authenticated', { role: 'support' },
    `select * from public.verification_queue()`);
});

await check('taking refuses a marketing token, and a support one', async () => {
  const marketing = await rpcGuard('shift.take.who', 'authenticated', { role: 'marketing' },
    `select public.listing_take('${shiftListingRow}'::uuid)`);
  if (marketing !== true) return marketing;
  return rpcGuard('shift.take.who', 'authenticated', { role: 'support' },
    `select public.listing_take('${shiftListingRow}'::uuid)`);
});

await check('taking refuses an id that is not a listing, rather than answering as if it were', () =>
  rpcGuard('shift.take.exists', 'authenticated', { role: 'verification' },
    `select public.listing_take('00000000-0000-4000-8000-00000000beef'::uuid)`));

await check('taking refuses a listing that has already been decided', async () => {
  await db2.exec(`update listings set tier = 2, verified_at = now(), verified_by = 'someone@arzuz.com'
                   where owner_phone = '08030000010'`);
  const out = await rpcGuard('shift.take.decided', 'authenticated', { role: 'verification' },
    `select public.listing_take('${shiftListingRow}'::uuid)`);
  await db2.exec(`update listings set tier = 0, verified_at = null, verified_by = null
                   where owner_phone = '08030000010'`);
  return out;
});

await check('taking refuses a listing another officer already holds — and names them', async () => {
  await db2.exec(`update listings set assigned_to = 'grace@arzuz.com', taken_at = now()
                   where id = '${shiftListingRow}'::uuid`);
  const out = await attempt2('authenticated', { role: 'verification' },
    `select public.listing_take('${shiftListingRow}'::uuid)`);
  if (!out) return 'a second officer took a listing somebody else holds';
  if (!out.includes(guard('shift.take.held').fragment)) return 'it raised something else:\n      ' + out;
  /* The holder is named, so the second officer knows who to ask rather
     than guessing — which is the difference between a refusal and a
     shrug. */
  return out.includes('grace@arzuz.com') ? true : 'the refusal does not say who has it:\n      ' + out;
});

await check('releasing refuses a login outside the shift', async () => {
  const marketing = await rpcGuard('shift.release.who', 'authenticated', { role: 'marketing' },
    `select public.listing_release('${shiftListingRow}'::uuid, 'mine now')`);
  if (marketing !== true) return marketing;
  return rpcGuard('shift.release.who', 'authenticated', { role: 'support' },
    `select public.listing_release('${shiftListingRow}'::uuid, 'mine now')`);
});

await check('releasing refuses an id that is not a listing', () =>
  rpcGuard('shift.release.exists', 'authenticated', { role: 'verification' },
    `select public.listing_release('00000000-0000-4000-8000-00000000cafe'::uuid, 'x')`));

await check('releasing refuses an officer who is not the one holding it', () =>
  rpcGuard('shift.release.stolen', 'authenticated', { role: 'verification' },
    `select public.listing_release('${shiftListingRow}'::uuid, 'not mine to give back')`));

await check('  \u2026but the chaser may: there is no signed-in officer at 6am', async () => {
  const freed = await asClaim('service_role', null, async () =>
    val2(`select (public.listing_release('${shiftListingRow}'::uuid, 'the clock took it back') ->> 'stage')`));
  if (freed !== 'queue') return 'the service role could not reclaim a job: ' + freed;
  const row = await one2(`select assigned_to, taken_at from listings where id = '${shiftListingRow}'::uuid`);
  return (!row.assigned_to && !row.taken_at) ? true : 'the claim survived the reclaim: ' + JSON.stringify(row);
});

await check('releasing something nobody holds is refused, not silently done', () =>
  rpcGuard('shift.release.empty', 'authenticated', { role: 'verification' },
    `select public.listing_release('${shiftListingRow}'::uuid, 'again')`));

/* The trail writer has TWO gates, and the suite drives both, because
   they answer different questions. The outer one is the grant: the
   function is not executable by a browser key at all, so an officer's
   `authenticated` token never gets as far as the function's own body —
   and the sentence that refusal uses is Postgres's, not ours, which is
   why it is asserted here rather than claimed in EXPECTED. The inner
   one is the function's own check, reached only by a caller that HOLDS
   the grant — the service role — and it is what stops a service-role
   token whose CLAIM still names a signed-in officer, which is exactly
   the token shape a mis-minted JWT would have. */
await check('no browser key can reach the trail writer at all: the grant stops it first', async () => {
  const wanted = 'permission denied for function verification_nudge';
  const attempts = [['authenticated', { role: 'verification' }, 'an officer'],
                    ['authenticated', { role: 'admin' }, 'an admin'],
                    ['anon', null, 'a signed-out visitor']];
  for (const [role, meta, who] of attempts) {
    const raised = await attempt2(role, meta,
      `select public.verification_nudge('${shiftListingRow}'::uuid, 'mine')`);
    if (!raised) return who + ' ran the trail writer';
    if (!raised.includes(wanted)) return who + ' was refused by something else:\n      ' + raised;
  }
  return true;
});

await check('\u2026and the trail refuses a service key whose claim names a browser role', () =>
  rpcGuard('shift.nudge.who', 'service_role', { role: 'verification' },
    `select public.verification_nudge('${shiftListingRow}'::uuid, 'mine too')`));

await check('the clock cannot nudge a listing that does not exist', () =>
  rpcGuard('shift.nudge.exists', 'service_role', null,
    `select public.verification_nudge('00000000-0000-4000-8000-00000000feed'::uuid, 'ghost')`));

await check('the RPC refuses a tier outside 0–2', () =>
  rpcGuard('verification.tier', 'authenticated', { role: 'verification' },
    `select public.listing_verify('${guardListing}'::uuid, 'active', 9)`));

/* The control. Every refusal above is satisfied by a function that refuses
   everything, so the decision itself has to land — and the row has to
   show it, because a JSON answer is a claim about a row. */
await check('and an officer\u2019s real call is accepted, and lands on the row', async () => {
  const raised = await attempt2('authenticated', { role: 'verification' },
    `select public.listing_verify('${guardListing}'::uuid, 'active', 1)`);
  if (raised) return 'the happy path was refused: ' + raised;
  const after = await one2(`select status, tier, verified_at, verified_by from listings where id = $1`,
    [guardListing]);
  if (after.status !== 'active' || Number(after.tier) !== 1)
    return 'the call was accepted and the row says status=' + after.status + ' tier=' + after.tier;
  if (!after.verified_at || !after.verified_by)
    return 'the call was accepted and nothing recorded who verified it';
  return true;
});

/* ------------------------------------------------------------
   4e · THE DESK'S OWN REFUSAL

   One raise lives inside public.status_history(), and it is the whole
   authorization of the feature: the trail holds where a code was sent,
   and the answer names a reference — so the logins allowed to ask are
   the desk and the admin, and nobody else. Driven against the REAL
   chain rather than a stub, because a stub database has no such
   function to call, and with a reference that does not exist: the
   refusal has to come BEFORE the lookup, or the shape of the error
   would tell a marketing token whether a reference was real.

   THE REFERENCE IS WELL-FORMED AND UNMINTED, and that is deliberate.
   The fixture here used to be 'ARZ-S-XXXX-XXXX-XXXX' — the
   documentation's placeholder, with X's where hex belongs — which
   the function now reads as nothing at all (`lookup: 'none'`). The
   refusal check did not care, because the role check comes first, but
   the SECOND check below asserts `known_reference === false`, and a
   query the function cannot read satisfies that for the wrong reason:
   it was proving "a thing I cannot parse is not known" while claiming
   "a reference nobody minted is not known". Moving to a real-shaped
   reference is what makes the second claim actually tested.
   ------------------------------------------------------------ */

section('4e. A reference\u2019s code history is the desk\u2019s question, and only the desk\u2019s');

/* Valid shape, never minted: 'XXXX' is not hex, so the old fixture could
   not have been produced by arzuz_ref_token() and would never have been
   typed by a student either. */
const UNMINTED = 'ARZ-S-0000-0000-0002';

await check('the history refuses a marketing token, and a verification one', async () => {
  const marketing = await rpcGuard('desk.who', 'authenticated', { role: 'marketing' },
    `select public.status_history('${UNMINTED}')`);
  if (marketing !== true) return marketing;
  return rpcGuard('desk.who', 'authenticated', { role: 'verification' },
    `select public.status_history('${UNMINTED}')`);
});

await check('and it answers the two logins it is for', async () => {
  const support = await asClaim('authenticated', { role: 'support' },
    () => one2(`select public.status_history('${UNMINTED}') as h`));
  if (!support || !support.h || support.h.ok !== true) {
    return 'the support login was refused the desk\u2019s own question: ' + JSON.stringify(support);
  }
  /* ASSERTED WITH known_reference, not instead of it. `known_reference`
     is false for an unreadable query as well as for an unminted one, so
     on its own it would pass against a fixture with no shape at all —
     which is what the placeholder used to be. Requiring `lookup: 'ref'`
     makes the claim specific: the input was READ as a reference, and the
     registry has no row for it. */
  if (support.h.lookup !== 'ref') {
    return 'the fixture was read as ' + support.h.lookup + ', so "not known" is being proved about something the function could not parse';
  }
  if (support.h.known_reference !== false) return 'a reference nobody minted reads as known';
  return Array.isArray(support.h.codes) ? true : 'the answer has no codes array: ' + JSON.stringify(support.h);
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
