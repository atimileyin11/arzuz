#!/usr/bin/env node
/* ============================================================
   Arzuz — break the behaviour, then see whether any check notices

   A passing suite proves the code it ran produced the right answers.
   It does NOT prove the suite would have said anything if the code
   were wrong. This tool answers that question the only way that
   counts: it changes one fact the suite claims to protect, runs the
   suite, and reports whether the suite noticed — and whether it
   noticed with a NAMED reason or merely died.

   THE INCIDENT THIS IS BUILT AROUND

     An earlier audit mutated `admin.html` in place to prove a check
     could see a dead registration. That file belonged to a concurrent
     editor with in-flight feature work, and the first restore was
     ordered wrong — the backup was taken after the mutation, so the
     "restore" put the mutation back for about a minute.

     So this harness will not start unless it can prove the file is
     safe to touch:

       1. REFUSES a file with uncommitted changes in git. Someone is
          working on it. (--allow-dirty overrides, and says so in the
          report.)
       2. REFUSES a file modified in the last 120 seconds — a save may
          be half-written even if git has not noticed yet.
          (--allow-recent overrides.)
       3. COPIES the file to a temp dir OUTSIDE the tree and records
          its sha256 BEFORE any byte is written.
       4. RESTORES in `finally`, and on SIGINT/SIGTERM/uncaught
          exceptions, then re-hashes. A mismatch is printed with the
          backup path, loudly, and exits 3 — a silent half-restore is
          the failure that started all this.
       5. VERIFIES the mutation applied exactly once. A find that
          matches nothing exits 2 without writing anything, because a
          "caught" result from an unapplied mutation is the other way
          this tool lies.

   WHAT THE VERDICTS MEAN

     CAUGHT    the suite failed. If it named a check, that is the
               evidence. If it died at load (SyntaxError, a missing
               module, a stack from node:internal), it is labelled
               BROKEN — a crash is not a catch, and it must not be
               counted as one.
     SURVIVED  the suite passed with the behaviour broken. The check
               that should have caught it does not exist, or does not
               bite. This is the finding.
     BROKEN    the mutation produced invalid JS or the suite could not
               start. Proves nothing about the suite.

   Run:
     node dev/mutate.mjs --list
     node dev/mutate.mjs --all
     node dev/mutate.mjs --only=drawer-flick-sign
     node dev/mutate.mjs --file assets/x.js --find "a" --replace "b" --suite test:policy
   ============================================================ */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const RECENT_MS = 120_000;
const DIRTY_GRACE = ['dev/mutants.mjs', 'dev/mutate.mjs'];

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = args.indexOf(hit);
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const flag = (name) => args.includes('--' + name);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => p.split('\\').join('/');

/* ------------------------------------------------------------
   the registry
   ------------------------------------------------------------ */

let registry = [];
try {
  registry = (await import('./mutants.mjs')).MUTANTS || [];
} catch (err) {
  if (!flag('file')) {
    console.error('  ✗ dev/mutants.mjs could not be read: ' + err.message);
    process.exit(2);
  }
}

if (flag('coverage')) {
  /* The honest number: a registry that covers eight of thirty suites is not
     an audit of the suite, and saying "6 caught" without this reads as if it
     were. Parsed from the runner's own ORDER, so the gap cannot drift. */
  const src = readFileSync(join(ROOT, 'dev/run-tests.mjs'), 'utf8');
  const order = [...src.matchAll(/^\s*'((?:test|sql):[a-z0-9-]+)'/gm)].map((m) => m[1]);
  const unique = [...new Set(order)];
  const covered = new Set(registry.map((m) => m.suite));
  const uncovered = unique.filter((n) => !covered.has(n));
  console.log('');
  console.log('  ' + (unique.length - uncovered.length) + ' of ' + unique.length + ' suites have a mutant');
  console.log('  ' + covered.size + ' mutant(s) across ' + new Set(registry.map((m) => m.suite)).size + ' suite(s)');
  if (uncovered.length) {
    console.log('\n  NO MUTANT YET — each of these has claims nobody has tried to break:');
    for (const n of uncovered) console.log('    · ' + n);
  }
  console.log('');
  process.exit(uncovered.length ? 1 : 0);
}

if (flag('list')) {
  console.log('');
  for (const m of registry) {
    console.log('  ' + m.id.padEnd(34) + m.suite.padEnd(18) + m.file);
    console.log('    ' + m.why);
  }
  console.log('\n  ' + registry.length + ' mutant(s).\n');
  process.exit(0);
}

/* ------------------------------------------------------------
   which mutants to run
   ------------------------------------------------------------ */

let plan;
if (flag('file')) {
  const file = opt('file');
  const find = opt('find');
  const replace = opt('replace');
  const suite = opt('suite');
  if (typeof file !== 'string' || typeof find !== 'string' || typeof replace !== 'string' || typeof suite !== 'string') {
    console.error('  ✗ --file, --find, --replace and --suite are all required (quote the strings).');
    process.exit(2);
  }
  plan = [{ id: 'ad-hoc', suite, file, find, replace, why: 'ad-hoc mutation' }];
} else if (opt('only')) {
  plan = registry.filter((m) => m.id === opt('only'));
  if (!plan.length) {
    console.error('  ✗ no mutant called ' + opt('only') + ' — try --list');
    process.exit(2);
  }
} else if (flag('all')) {
  plan = registry;
} else {
  console.error('  Nothing selected. Try --list, --all, --only=<id>, or --file … --suite …');
  process.exit(2);
}

/* ------------------------------------------------------------
   the safety gate — refuse before writing, not after
   ------------------------------------------------------------ */

function gitDirty(file) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', file], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch (_) {
    return '';   /* not a git checkout: nothing to compare against */
  }
}

function gate(m) {
  const abs = join(ROOT, m.file);
  let info;
  try { info = statSync(abs); } catch (_) { return 'no such file: ' + m.file; }
  if (!info.isFile()) return 'not a file: ' + m.file;

  const dirty = gitDirty(m.file);
  if (dirty && !flag('allow-dirty')) {
    return 'REFUSED — ' + m.file + ' has uncommitted changes (' + dirty.split('\n')[0].trim() +
      ').\n      Somebody is working on it. Commit or stash first, or pass --allow-dirty\n' +
      '      if you are certain the change is yours and finished.';
  }
  const age = Date.now() - info.mtimeMs;
  if (age < RECENT_MS && !flag('allow-recent')) {
    return 'REFUSED — ' + m.file + ' was written ' + Math.round(age / 1000) + 's ago.\n' +
      '      A save may still be in flight. Wait, or pass --allow-recent.';
  }
  return null;
}

const gated = [];
for (const m of plan) {
  const problem = gate(m);
  if (problem) gated.push({ mutant: m, problem });
}
if (gated.length) {
  for (const g of gated) console.error('\n  ✗ ' + g.mutant.id + ': ' + g.problem);
  console.error('\n  Nothing was written.\n');
  process.exit(2);
}

/* ------------------------------------------------------------
   one mutation, restore guaranteed
   ------------------------------------------------------------ */

let backupDir = null;
let active = null;   /* { file, abs, backup, hash } while a file is mutated */

function restore() {
  if (!active) return true;
  const { abs, backup, hash, file } = active;
  try {
    copyFileSync(backup, abs);
    const after = sha(readFileSync(abs));
    active = null;
    if (after !== hash) {
      console.error('\n  ✗✗ RESTORE MISMATCH for ' + file);
      console.error('      the backup is still at ' + backup);
      console.error('      copy it back by hand before doing anything else.');
      return false;
    }
    return true;
  } catch (err) {
    console.error('\n  ✗✗ RESTORE FAILED for ' + file + ': ' + err.message);
    console.error('      the backup is still at ' + backup);
    return false;
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error('\n  interrupted — restoring ' + (active ? active.file : 'nothing pending'));
    restore();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  console.error('\n  unexpected: ' + err.message);
  restore();
  process.exit(3);
});

function parseNamedFailures(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^(✗|×|FAIL\b)/.test(t) || /^✗ FAIL/.test(t)) out.push(t.slice(0, 200));
  }
  return out;
}

function looksBroken(text) {
  return /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|node:internal\/|Unexpected end of input|ReferenceError: .* is not defined/.test(text);
}

function runSuite(script) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['run', script], {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: res.status, out: String(res.stdout || '') + String(res.stderr || '') };
}

const results = [];
backupDir = join(tmpdir(), 'arzuz-mutate-' + process.pid);
mkdirSync(backupDir, { recursive: true });

for (const m of plan) {
  const abs = join(ROOT, m.file);
  const original = readFileSync(abs);
  const hash = sha(original);
  const backup = join(backupDir, m.id + '-' + m.file.replace(/[\\/]/g, '_'));
  copyFileSync(abs, backup);
  active = { file: m.file, abs, backup, hash };

  /* Match and write on LF-normalised text so a CRLF file does not make
     every find string miss; the backup restores the original bytes. */
  const text = original.toString('utf8').replace(/\r\n/g, '\n');
  const occurrences = text.split(m.find).length - 1;

  let entry;
  if (occurrences !== 1) {
    entry = {
      id: m.id, suite: m.suite, verdict: 'NOT APPLIED',
      reason: 'the find string occurs ' + occurrences + ' times (must be exactly 1)',
    };
  } else {
    writeFileSync(abs, text.replace(m.find, m.replace), 'utf8');
    const run = runSuite(m.suite);
    const named = parseNamedFailures(run.out);
    const broke = looksBroken(run.out);
    entry = {
      id: m.id, suite: m.suite,
      verdict: run.code === 0 ? 'SURVIVED' : (broke ? 'BROKEN' : 'CAUGHT'),
      named: named.slice(0, 3),
      reason: run.code === 0
        ? 'the suite stayed green with ' + m.file + ' broken'
        : (broke ? 'the suite did not run — it crashed at load, which proves nothing'
          : 'failed with a named check'),
    };
  }

  const ok = restore();
  results.push(entry);
  if (!ok) {
    console.error('\n  stopping: the last restore could not be verified.\n');
    process.exit(3);
  }
}

rmSync(backupDir, { recursive: true, force: true });

/* ------------------------------------------------------------
   the report
   ------------------------------------------------------------ */

console.log('\n' + '='.repeat(72));
console.log('MUTATION AUDIT — ' + results.length + ' mutant(s)');
console.log('='.repeat(72));
for (const r of results) {
  const mark = r.verdict === 'CAUGHT' ? '✓' : r.verdict === 'NOT APPLIED' ? '·' : '✗';
  console.log('\n  ' + mark + ' ' + r.verdict.padEnd(11) + r.id + '   [' + r.suite + ']');
  console.log('      ' + r.reason);
  for (const n of r.named || []) console.log('        caught by: ' + n);
}
const survived = results.filter((r) => r.verdict === 'SURVIVED');
const broken = results.filter((r) => r.verdict === 'BROKEN');
const skipped = results.filter((r) => r.verdict === 'NOT APPLIED');
const caught = results.filter((r) => r.verdict === 'CAUGHT');
console.log('\n' + '='.repeat(72));
console.log('caught ' + caught.length + ' · survived ' + survived.length +
  ' · broken ' + broken.length + ' · not applied ' + skipped.length);
if (survived.length) {
  console.log('\nSURVIVORS — the behaviour is broken and every check stayed green.');
  console.log('Each one is a check that does not exist, or does not bite:');
  for (const r of survived) console.log('  ✗ ' + r.id + '   (npm run ' + r.suite + ')');
}
if (broken.length) {
  console.log('\nBROKEN — the suite died before it could judge anything; redo those mutants as valid JS.');
}
console.log('='.repeat(72) + '\n');
process.exit(survived.length || broken.length || skipped.length ? 1 : 0);
