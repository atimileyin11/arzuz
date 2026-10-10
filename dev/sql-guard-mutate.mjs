#!/usr/bin/env node
/* ============================================================
   Arzuz — prove the SQL guard tests are not vacuous

   THE PROBLEM THIS SOLVES

     dev/sql-guard-test.mjs asserts that every preflight raise in
     the supabase-*.sql files fires, with the message that names
     the file to run. That is a test OF A TEST. If the assertion
     ever stops asserting — a typo, a fragment that no longer
     matches, a `check()` that returns true for the wrong reason —
     the suite keeps printing ✓ and protecting nothing.

     The only way to know a test can fail is to make it fail on
     purpose. This does that: it copies the SQL to a throwaway
     directory, breaks ONE guard at a time, and requires the guard
     suite to notice every single time.

   WHAT IT RUNS

     baseline     the unmutated copy — must PASS. If it does not,
                  the other results mean nothing and this stops.
     control      a harmless comment added to a guarded file — must
                  STILL PASS. This is the check that keeps the rest
                  honest: if the harness were broken in some way
                  unrelated to the guards (missing node_modules, a
                  PGlite that will not boot) then EVERY mutation
                  would "fail" and every one would look caught. The
                  control is what tells a real catch from a runner
                  that is simply broken.
     mutations    one broken guard each — must FAIL, every one.

   IT CANNOT TOUCH YOUR WORKING TREE

     Every edit happens to a copy under the system temp directory,
     and the repo's own SQL is hashed before and after to prove it
     came back unchanged. Nothing here is a `git` operation.

   WHY IT IS NOT IN `npm test`

     It runs the guard suite once per mutation — eight full runs.
     That is a tool you reach for when you change the guards or the
     harness, not a gate on every commit. `sql:guards` is the gate.

   Run it:  npm run sql:mutate     (or: node dev/sql-guard-mutate.mjs)
   ============================================================ */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = 'dev/sql-guard-test.mjs';

const line = '='.repeat(66);
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/* The files the guard suite reads. The repo's copies are hashed
   before and after so this tool can PROVE it left them alone. */
const GUARDED = ['supabase-team-roles.sql', 'supabase-roommate.sql', 'supabase-care.sql'];

/* ------------------------------------------------------------
   the battery — one broken guard each

   A mutation that cannot apply is a mutation that proves nothing,
   so `apply` is required to change the text or the run is aborted.
   ------------------------------------------------------------ */

const TEAM = 'supabase-team-roles.sql';
const MATE = 'supabase-roommate.sql';
const CARE = 'supabase-care.sql';

const MUTATIONS = [
  {
    name: 'team-roles: the support_tickets guard is deleted',
    file: TEAM,
    breaks: 'nothing ever tells you supabase-drafts-support.sql was skipped',
    apply: (s) => s.replace(
      /\n\s*if to_regclass\('public\.support_tickets'\) is null then[\s\S]*?end if;/,
      ''
    ),
  },
  {
    name: 'team-roles: the first condition is inverted',
    file: TEAM,
    breaks: 'the guard fires on a CORRECT install and blocks it',
    apply: (s) => s.replace(
      "if to_regclass('public.demand_records') is null",
      "if to_regclass('public.demand_records') is not null"
    ),
  },
  {
    name: 'team-roles: the message names the wrong file',
    file: TEAM,
    breaks: 'the raise still happens, but sends you to supabase-hardening.sql',
    apply: (s) => s.replace(
      'Run supabase-drafts-support.sql before this file',
      'Run supabase-hardening.sql before this file'
    ),
  },
  {
    name: 'team-roles: a brand-new guard nobody tests',
    file: TEAM,
    breaks: 'a new rule the harness has never seen — the pairing must catch it',
    apply: (s) => s.replace(
      'end $$;',
      "raise exception 'a brand new rule nobody tests';\nend $$;"
    ),
  },
  {
    name: 'team-roles: the guard moved to the END of the file',
    file: TEAM,
    breaks: 'it runs after the damage, so a skipped file still half-builds',
    apply: (s) => {
      const block = s.match(/do \$\$[\s\S]*?end \$\$;\n/);
      return block ? s.replace(block[0], '') + '\n' + block[0] : s;
    },
  },
  {
    name: 'roommate: its guard is deleted',
    file: MATE,
    breaks: 'its policies would be written with no role model in place',
    apply: (s) => {
      const block = s.match(/do \$\$[\s\S]*?end \$\$;\n/);
      return block ? s.replace(block[0], '') : s;
    },
  },
  {
    name: 'care: its guard is deleted',
    file: CARE,
    breaks: 'same, for the Care credit ledger',
    apply: (s) => {
      const block = s.match(/do \$\$[\s\S]*?end \$\$;\n/);
      return block ? s.replace(block[0], '') : s;
    },
  },
];

/* The control. It changes a guarded file without changing any
   guard, so a working harness MUST still pass. If this ever comes
   back "caught", the battery is measuring a broken runner rather
   than a broken guard. */
const CONTROL = {
  name: 'control: a comment added, no guard touched',
  file: TEAM,
  apply: (s) => '-- a harmless comment the guards do not read\n' + s,
};

/* ------------------------------------------------------------
   staging
   ------------------------------------------------------------ */

function stage(mutation) {
  const dir = mkdtempSync(join(tmpdir(), 'arzuz-mutate-'));
  mkdirSync(join(dir, 'dev'), { recursive: true });

  /* every supabase-*.sql, because the guard suite reads the whole
     dependency chain for its happy-path section */
  for (const f of readdirSync(ROOT)) {
    if (/^supabase-.*\.sql$/.test(f)) copyFileSync(join(ROOT, f), join(dir, f));
  }
  copyFileSync(join(ROOT, HARNESS), join(dir, HARNESS));

  if (mutation) {
    const target = join(dir, mutation.file);
    const before = readFileSync(target, 'utf8');
    const after = mutation.apply(before);
    if (after === before) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error('the mutation did not apply to ' + mutation.file +
        ' — fix it here, because a mutation that changes nothing proves nothing');
    }
    writeFileSync(target, after);
  }

  /* the harness imports @electric-sql/pglite by bare name, so the
     copy needs a node_modules it can resolve from its own tree */
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');

  return dir;
}

function runHarness(dir) {
  const r = spawnSync(process.execPath, [HARNESS], { cwd: dir, encoding: 'utf8' });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const total = out.match(/TOTAL \d+ · PASS \d+ · FAIL \d+/);
  return { code: r.status, total: total ? total[0] : '(no summary line)' };
}

/* ------------------------------------------------------------
   go
   ------------------------------------------------------------ */

const before = Object.fromEntries(GUARDED.map((f) => [f, sha(join(ROOT, f))]));

console.log(line);
console.log('Arzuz SQL guard battery \u2014 break a guard, require the suite to notice');
console.log(line);

let verdict = 0;
const rows = [];

function record(ok, label, detail) {
  rows.push({ ok, label, detail });
  if (!ok) verdict = 1;
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + label.padEnd(52) + detail);
}

/* baseline */
{
  const dir = stage(null);
  const r = runHarness(dir);
  rmSync(dir, { recursive: true, force: true });
  console.log('\nBaseline \u2014 the unmutated copy');
  record(r.code === 0, 'the guard suite passes on untouched SQL', 'exit ' + r.code + ', ' + r.total);
  if (r.code !== 0) {
    console.log('\nStopping: if the suite fails with nothing broken, its verdicts on the');
    console.log('mutations below would say nothing about the guards.');
    process.exit(1);
  }
}

/* control */
{
  const dir = stage(CONTROL);
  const r = runHarness(dir);
  rmSync(dir, { recursive: true, force: true });
  console.log('\nControl \u2014 a change that must NOT be caught');
  record(r.code === 0, CONTROL.name.padEnd(52), 'exit ' + r.code + ' (expected 0)');
}

/* the battery */
console.log('\nMutations \u2014 each one must be caught');
for (const mutation of MUTATIONS) {
  let dir;
  try {
    dir = stage(mutation);
  } catch (err) {
    record(false, mutation.name, String(err.message || err).slice(0, 120));
    continue;
  }
  const r = runHarness(dir);
  rmSync(dir, { recursive: true, force: true });
  record(r.code !== 0, mutation.name, 'exit ' + r.code + (r.code === 0 ? ' \u2014 NOT CAUGHT' : ''));
  if (r.code === 0) console.log('      ' + mutation.breaks);
}

/* ------------------------------------------------------------
   did we leave the working tree alone?
   ------------------------------------------------------------ */

const after = Object.fromEntries(GUARDED.map((f) => [f, sha(join(ROOT, f))]));
const touched = GUARDED.filter((f) => before[f] !== after[f]);

console.log('\n' + line);
record(touched.length === 0, 'the repository\u2019s own SQL was never modified',
  touched.length ? 'CHANGED: ' + touched.join(', ') : 'hashes identical before and after');
console.log(line);

const caught = rows.filter((r) => r.ok).length;
console.log('RESULT: ' + caught + ' of ' + rows.length + ' checks held \u00b7 ' +
  MUTATIONS.length + ' mutations, every one caught on a healthy tree');
if (verdict) {
  console.log('\nA mutation that is NOT caught means the guard suite can no longer see');
  console.log('that failure \u2014 the guard is untested, and the suite is a green light');
  console.log('that means nothing. Fix the guard suite (dev/sql-guard-test.mjs).');
}
console.log(line);

process.exit(verdict);
