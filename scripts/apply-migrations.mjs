#!/usr/bin/env node
/* ============================================================
   Arzuz — apply the migrations production is missing

   scripts/verify-migrations.mjs says WHAT is missing; this runs the
   files that fix it, in the order the runbook gives, and then asks
   verify-migrations again so the claim is the database's, not ours.

   WHY THIS EXISTS
     Care Pass checkout is dead in production for two reasons, and one
     is that `public_terms`, `finance_config` and `payments` were never
     created: /api/finance answers 502 for every action. Eight files
     create thirty relations the code already reads.

   THE CREDENTIAL IS NEVER IN THIS REPO
     Pass the connection string one of two ways:

       SUPABASE_DB_URL=postgres://... node scripts/apply-migrations.mjs
       node scripts/apply-migrations.mjs --url-file ../supabase-db-url.txt

     The file form is for a shell that should not keep it in history.
     Use the Supabase **pooler** host (…pooler.supabase.com:6543) with
     the database password: the direct host is IPv6-only on most
     projects and this machine may not reach it.

   HOW IT RUNS THEM
     Each file as ONE multi-statement query, in order, and it stops at
     the first failure — a half-applied schema that keeps going is
     worse than one that stops. Every file is idempotent by design
     (`create table if not exists`, `create or replace`), so a re-run
     after a failure is safe.

   THE LOCKDOWN IS OPT-IN
     supabase-close-public-inserts.sql revokes anon's INSERT on the
     five public tables. It is the last step of the runbook and it
     depends on SUPABASE_SERVICE_ROLE_KEY being set in Netlify, so it
     is NOT applied unless asked for with --include-lockdown.
   ============================================================ */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The order is LAUNCH-READINESS §3a's, narrowed to the files this
   project is actually missing. Each line names what it creates, so a
   failure is readable without opening the SQL. */
const PLAN = [
  ['supabase-waitlist-launch.sql', 'waitlist_ref_registry, submission_guard, staff_audit_log'],
  ['supabase-status-codes.sql', 'status_codes, status_guard — the /status page reads these'],
  ['supabase-status-history.sql', 'status_code_deliveries'],
  ['supabase-care.sql', 'care_plans, care_credit_events, care_credit_balance, care_plans_live'],
  ['supabase-claims.sql', 'repair_claims, claim_events, claims_summary'],
  ['supabase-finance.sql', 'finance_config, product_terms, payments, ledger_entries, referrals, …'],
  ['supabase-roommate.sql', 'roommate_profiles, roommate_interests, roommate_events, …'],
  ['supabase-verification-queue.sql', 'verification_events'],
];

const LOCKDOWN = ['supabase-close-public-inserts.sql', 'revokes anon INSERT on the five public tables'];

const argFile = (() => {
  const hit = process.argv.find((a) => a.startsWith('--url-file='));
  return hit ? hit.slice('--url-file='.length) : null;
})();

let url = process.env.SUPABASE_DB_URL || '';
if (!url && argFile) {
  const abs = join(ROOT, argFile);
  if (!existsSync(abs)) {
    console.error('  ✗ no file at ' + abs);
    process.exit(2);
  }
  url = readFileSync(abs, 'utf8').trim();
}
const includeLockdown = process.argv.includes('--include-lockdown');

if (!url) {
  console.error('\n  No connection string.\n');
  console.error('  Get it from Supabase → Project Settings → Database → Connection string');
  console.error('  (URI, session pooler), then either:');
  console.error('');
  console.error('    SUPABASE_DB_URL="postgres://…" node scripts/apply-migrations.mjs');
  console.error('    node scripts/apply-migrations.mjs --url-file ../supabase-db-url.txt');
  console.error('');
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error('  ✗ that is not a postgres:// connection string');
  process.exit(2);
}

let Client;
try {
  ({ Client } = await import('pg'));
} catch (_) {
  console.error('\n  ✗ the `pg` driver is not installed.\n');
  console.error('  npm install --no-save pg');
  console.error('  (--no-save keeps package.json, which another agent may be editing, untouched)\n');
  process.exit(2);
}

const plan = includeLockdown ? [...PLAN, LOCKDOWN] : PLAN;
for (const [file] of plan) {
  if (!existsSync(join(ROOT, file))) {
    console.error('  ✗ missing file: ' + file);
    process.exit(2);
  }
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
console.log('\nApplying ' + plan.length + ' migration(s) to ' + url.replace(/:\/\/[^@]*@/, '://…@'));

try {
  await client.connect();
} catch (err) {
  console.error('  ✗ could not connect: ' + err.message);
  console.error('  Use the pooler host (…pooler.supabase.com:6543) if the direct host times out.');
  process.exit(2);
}

let applied = 0;
try {
  for (const [file, creates] of plan) {
    const sql = readFileSync(join(ROOT, file), 'utf8');
    process.stdout.write('  · ' + file.padEnd(38));
    try {
      await client.query(sql);
      applied++;
      console.log('applied   (' + creates + ')');
    } catch (err) {
      console.log('FAILED');
      console.error('\n  ✗ ' + file + ': ' + err.message);
      if (err.position) console.error('    at character ' + err.position + ' of the statement');
      console.error('\n  Stopped here on purpose. Every file is idempotent, so fix the cause and re-run.');
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}

if (process.exitCode) process.exit(process.exitCode);

/* Ask the database, not ourselves. */
console.log('\nVerifying with scripts/verify-migrations.mjs …\n');
const check = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-migrations.mjs')], {
  cwd: ROOT, encoding: 'utf8',
});
const tail = String(check.stdout || '').split('\n').filter((l) => /TOTAL|missing|NOT APPLIED|✓/.test(l));
for (const line of tail.slice(-12)) console.log('  ' + line.trim());
console.log('\n  ' + applied + ' file(s) applied. Exit ' + check.status + ' from the verifier.\n');
process.exit(check.status === 0 ? 0 : 1);
