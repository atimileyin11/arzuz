#!/usr/bin/env node
/* ============================================================
   Arzuz — run EVERY suite, report EVERY suite

   WHY THIS EXISTS

     `npm test` used to be a chain of `&&`:

         npm run test:roommate && npm run test:care && …

     `&&` stops at the first failure. The day this was written,
     test:care was failing and the three suites after it — including
     the brand-new sql:guards — never ran at all. Their results were
     not "passing"; they were UNREPORTED. A gate that hides three of
     five results is worse than a slow one, because the green line
     you remember reading was never about them.

     So: every suite runs, always, whatever the one before it did,
     and the summary at the end names every one of them.

   THE ORDER IS ASSERTED, NOT ASSUMED

     Cheap first; the two SQL suites last, because they boot PGlite's
     wasm. A name below that is no longer in package.json fails the
     run loudly instead of silently skipping, and a `test:*` / `sql:*`
     script that IS in package.json but is not below is reported as
     forgotten — so a new suite cannot be added and quietly not run.
     Same pairing trick the SQL guard harness uses on the preflight
     raises: the list and the files cannot drift apart.

   Output is streamed as it happens (you can watch a suite work) and
   captured, so the summary can quote each suite's own last line.
   Exit code is 0 only when every suite passed.

   Run it:  npm test
   ============================================================ */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotTree, movedDuring } from './tree-watch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const ORDER = [
  /* first because it is the cheapest of all: pure Node, no DOM, no
     network, no wasm — the release policies swept across every integer
     height and hundreds of drawer widths, which the boot suite can only
     reach at the handful of geometries a phone lays out */
  'test:policy',
  /* then the fixtures themselves. Pure Node, no wasm: it requires
     netlify/functions/status.js and parses the migrations, so it costs
     nothing — and it is the check that keeps every OTHER suite honest,
     because a fixture the product would refuse makes a green test a
     claim about a value that cannot exist. It runs early for that
     reason: when it fails, the results below it are worth less than
     they look. */
  'test:fixtures',
  /* and the mocks against the schema they imitate — the same class of
     mistake from the other side: a stand-in that accepts a word
     Postgres would refuse. Also pure Node (it reads the SQL, it does
     not boot it), so it sits beside the fixtures rather than down
     with the two PGlite suites. */
  'test:schema',
  /* then the gesture engine's physics, driven by synthetic events */
  'test:gesture',
  'test:roommate',
  'test:roommate-page',
  'test:care',
  'test:finance',
  /* the self-service referral loop: mint, clicks, the referrer dashboard,
     the two notification pages and the code switch — beside the money
     rules it extends, because a green finance suite must not be quotable
     about doors it never knocked on */
  'test:referrals',
  'test:claims',
  /* the verification shift's own suite, beside the other queue work: the
     ordering and the clock are pure policy, so it needs no database —
     the chaser's hooks in netlify/functions/verification-aging.js are
     stubbed, and what it proves is that a lateness is announced once, and
     that a job nobody did comes back */
  'test:verify-queue',
  /* stage 3's public badge: pure policy, no DOM and no database. The
     module is what a student reads, so its wording is tested beside the
     queue's clocks — a badge that claims more than the evidence says is
     the failure both of them exist to prevent. */
  'test:verify-badge',
  'test:care-pass',
  'test:my-care',
  'test:admin',
  /* the upload signature — pure Node, no browser, no Cloudinary: it
     recomputes the hash the upload endpoint verifies. It sits beside
     the admin suite because that is the page it protects, and because
     a signature that drifted is invisible from every other angle: the
     endpoint keeps answering 200 while every upload 401s. */
  'test:upload-sign',
  /* the probe the smoke test and the scheduled health check both
     trust: it must be able to see a bad signature, or its green means
     nothing. Offline — it stands up its own endpoint. */
  'test:upload-probe',
  /* the same shape of check, one layer down: the credential every door
     on the site writes through is TRIED against the project, and the
     probe must be able to see a refusal or its green means nothing */
  'test:db-health',
  /* the same memory, read the way the dashboard reads it: the one line
     the team sees without being paged. Pure Node — a stand-in marker and
     a stand-in session, so it costs nothing and pins every sentence that
     can turn "cannot confirm" into a green. */
  'test:health-summary',
  /* the runner's own detector, which must be able to fire: a watcher
     that never reports anything looks exactly like a quiet tree */
  'test:tree-watch',
  'test:postgrest',
  'test:care-live',
  'test:draft-errors',
  'test:api-errors',  'test:waitlist',
  /* the outbox drain, which is the other end of the same save the door
     answers — so it runs beside it rather than at the bottom */
  'test:alert-outbox',
  /* the status page, which is the other end of the same reference the
     door hands out — so it runs beside it rather than at the bottom */
  'test:status',
  /* the deploy gate, right after the door it protects: both are about
     the same fact — that there is one way in, and it needs a key */
  'test:deploy-key',
  'test:seo',
  'test:rooms',
  'test:listing-og',
  'test:browse',
  'test:indexnow',
  'sql:proof',
  'sql:guards',
];

const line = '='.repeat(66);

/* `sql:mutate` is a TOOL, not a suite: it runs the guard suite once
   per mutation — eight full runs — so it belongs in the hands of
   whoever is changing the guards, not in the gate on every commit.
   Naming it here is the point: it is a deliberate exemption, not a
   suite somebody forgot to add to ORDER. */
const NOT_A_SUITE = ['sql:mutate', 'mutate'];

/* `care:live` is not a suite either, for the opposite reason: it asks
   the deployed site and the live database, so it needs the internet
   and a Care that has been switched on. `test:care-live` is its
   offline half — the verdicts it would print — and that one IS in the
   gate. */

/* ------------------------------------------------------------
   the pairing — the list and package.json cannot drift
   ------------------------------------------------------------ */

const forgotten = Object.keys(scripts)
  .filter((k) => /^(test|sql):/.test(k) && !ORDER.includes(k) && !NOT_A_SUITE.includes(k))
  .sort();

/* ------------------------------------------------------------
   run one suite: streamed live, captured for the summary
   ------------------------------------------------------------ */

/* Windows resolves npm through npm.cmd, which Node can only spawn
   with a shell; everywhere else the shell would only add a layer of
   quoting to get wrong. */
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useShell = process.platform === 'win32';

function run(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const snapBefore = snapshot();
    let buf = '';
    let child;
    try {
      child = spawn(npm, ['run', name], { cwd: ROOT, shell: useShell });
    } catch (err) {
      return resolve({ name, code: null, ms: 0, summary: 'could not spawn: ' + why(err) });
    }
    const take = (chunk, sink) => {
      buf += chunk;
      sink.write(chunk);
    };
    child.stdout.on('data', (c) => take(String(c), process.stdout));
    child.stderr.on('data', (c) => take(String(c), process.stderr));
    child.on('error', (err) => resolve({ name, code: null, ms: Date.now() - t0, summary: 'spawn failed: ' + why(err) }));
    child.on('close', (code, signal) => resolve({
      name,
      code,
      signal,
      ms: Date.now() - t0,
      summary: headline(buf),
      moved: movedDuring(snapBefore, snapshot()),
    }));
  });
}

function why(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 200);
}

/* Each suite already ends with its own verdict — "72 passed, 0 failed"
   or "TOTAL 80 · PASS 80 · FAIL 0". Quote the LAST one, so a suite
   that prints progress cannot be mistaken for one that finished. */
function headline(text) {
  const patterns = [
    /TOTAL (\d+) · PASS (\d+) · FAIL (\d+)/g,
    /(\d+) passed, (\d+) failed/g,
  ];
  let last = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) last = m[0];
  }
  return last;
}

/* ------------------------------------------------------------
   the tree a suite reads, and whether it moved while it read it

   The watching itself lives in dev/tree-watch.mjs so it can be tested
   by moving files, instead of being a claim about a module nobody
   exercises. Its own suite is in ORDER and runs like any other.

   The exit status is NOT changed when something moves. A concurrent
   edit EXPLAINS a failure; it does not excuse one, and a suite that
   PASSED while the tree moved is not made red — it is made doubtful,
   and the summary says so beside the verdict it belongs to.
   ------------------------------------------------------------ */

const snapshot = () => snapshotTree(ROOT);

/* ------------------------------------------------------------
   go
   ------------------------------------------------------------ */

/* A PARTIAL RUN IS NOT A GATE. It exists for the loops that can cost
   minutes per attempt — chasing one suite while editing it, or driving
   it from dev/mutate.mjs — and it says so twice: in the header and in
   the result line. The full run is still the only one that means the
   tree is green. */
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
const unknown = only ? only.filter((n) => !ORDER.includes(n)) : [];
if (unknown.length) {
  console.log('\u2717 not in ORDER: ' + unknown.join(', '));
  console.log('  A suite that is not in ORDER is not run by the gate either — add it first.');
  process.exit(2);
}
const selected = only ? ORDER.filter((n) => only.includes(n)) : ORDER;

/* ------------------------------------------------------------
   every suite in ORDER has to have a mutant

   A suite is a claim; a mutant is the evidence that the claim CAN
   fail. "14 of 30 suites have a mutant" was a number somebody had to
   remember to read. Now a new suite cannot ship without one: the
   registry in dev/mutants.mjs is compared against THIS list, which
   includes the sixteen that had none.

   Checked only on a FULL run. The partial runs exist to drive ONE
   suite (dev/mutate.mjs runs each mutant through --only=), and a gate
   that went red there would report the state of the registry instead
   of the mutation under test - a mutation harness that always sees a
   red run proves nothing.
   ------------------------------------------------------------ */

let mutantsBySuite = new Map();
let registryError = '';
try {
  const { MUTANTS } = await import('./mutants.mjs');
  for (const m of (MUTANTS || [])) mutantsBySuite.set(m.suite, (mutantsBySuite.get(m.suite) || 0) + 1);
} catch (err) {
  registryError = String((err && err.message) || err).split('\n')[0];
}

const uncovered = only ? [] : ORDER.filter((n) => !mutantsBySuite.has(n));

console.log(line);
console.log('Arzuz test suite \u2014 ' + (only
  ? 'PARTIAL RUN: ' + selected.length + ' of ' + ORDER.length + ' suites (--only)'
  : ORDER.length + ' suites, every one reported'));
console.log(line);

if (forgotten.length) {
  console.log('\n\u2717 package.json has suite scripts this runner does not know about:');
  for (const name of forgotten) console.log('    ' + name + '  (npm run ' + name + ')');
  console.log('  Add it to ORDER in dev/run-tests.mjs \u2014 otherwise it will never run.');
}

if (registryError) {
  console.log('\n\u2717 dev/mutants.mjs could not be read: ' + registryError);
  console.log('  The registry is half of the gate below, so nothing is claimed about it.');
}

if (uncovered.length) {
  console.log('\n\u2717 no mutant for ' + uncovered.length + ' of ' + ORDER.length + ' suites:');
  for (const name of uncovered) console.log('    ' + name + '  (npm run ' + name + ')');
  console.log('  A suite nobody has tried to break is a suite nobody knows can fail.');
  console.log('  Add one to dev/mutants.mjs: find the sentence its output uses, then break');
  console.log('  the line that sentence describes. `npm run mutate -- --coverage` is the');
  console.log('  same comparison, run on its own.');
}

const results = [];

for (const name of selected) {
  console.log('\n' + '\u2500'.repeat(66));
  console.log('\u25b6 ' + name);
  console.log('\u2500'.repeat(66));
  if (!scripts[name]) {
    console.log('  \u2717 there is no "' + name + '" script in package.json \u2014 this runner');
    console.log('    is out of step with the file it is meant to drive.');
    results.push({ name, code: null, ms: 0, summary: 'MISSING from package.json' });
    continue;
  }
  results.push(await run(name));
}

/* the suite output above already ended with a newline of its own; keep
   the summary visually separate from whichever suite ran last */
const failed = results.filter((r) => r.code !== 0);
const passed = results.length - failed.length;
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

console.log('\n' + line);
console.log('SUITE RESULTS');
console.log(line);
for (const r of results) {
  const mark = r.code === 0 ? '\u2713' : '\u2717';
  const verdict = r.code === 0 ? 'passed'
    : r.code === null ? 'DID NOT RUN'
      : 'FAILED (exit ' + r.code + ')';
  console.log('  ' + mark + ' ' + r.name.padEnd(16) + verdict.padEnd(20) + secs(r.ms).padStart(7) +
    (r.summary ? '   ' + r.summary : ''));
  /* Named here rather than buried in the suite's own output: the line
     above is the one people quote, and it is the one that may be about
     a different revision. */
  if (r.moved && r.moved.length) {
    console.log('      \u26a0 the tree moved while this suite ran \u2014 ' + r.moved.length +
      ' file' + (r.moved.length === 1 ? '' : 's') + ':');
    for (const m of r.moved.slice(0, 5)) console.log('        ' + m.kind + '  ' + m.file);
    if (r.moved.length > 5) console.log('        … and ' + (r.moved.length - 5) + ' more');
  }
}
console.log(line);

const raced = results.filter((r) => r.moved && r.moved.length);
if (raced.length) {
  console.log('\nCONCURRENT EDITS DURING THE RUN');
  for (const r of raced) {
    console.log('  ' + r.name + ' \u2014 ' + (r.code === 0 ? 'passed' : 'failed') +
      ' while ' + r.moved.map((m) => m.file).join(', ') + ' moved');
  }
  console.log('  Re-run after the tree settles before believing a verdict that overlaps');
  console.log('  a save. A failed suite here may be a half-written file, not your change;');
  console.log('  a passing one may have proved it against a revision that no longer exists.');
}

if (uncovered.length || forgotten.length || registryError) {
  console.log('\nMUTANT COVERAGE');
  console.log('  ' + (ORDER.length - uncovered.length) + ' of ' + ORDER.length + ' suites in ORDER have a mutant');
  console.log('  ' + [...mutantsBySuite.values()].reduce((a, b) => a + b, 0) + ' mutant(s) across ' + mutantsBySuite.size + ' suite(s)');
  if (registryError) console.log('  \u2717 the registry itself could not be read \u2014 see above');
  for (const name of uncovered) console.log('  \u2717 ' + name + ' has no mutant');
  console.log('  A suite with no mutant is not evidence that the behaviour it names is');
  console.log('  protected \u2014 only that nobody has tried to break it yet.');
  console.log(line);
}

/* "nothing failed" is only true of the suites. A run that passed every one
   of them and still exits 1 — because a suite has no mutant, or one exists
   that this runner never runs — has to say so on the line people quote,
   or the summary contradicts the exit code. */
const uncoveredNote = (uncovered.length ? ' \u00b7 ' + uncovered.length + ' suite(s) have no mutant' : '') +
  (registryError ? ' \u00b7 the mutant registry could not be read' : '');

if (forgotten.length) {
  console.log('RESULT: ' + passed + ' of ' + results.length + ' passed \u00b7 ' +
    forgotten.length + ' suite(s) exist in package.json but were NOT run' + uncoveredNote);
} else if (only) {
  console.log('RESULT (PARTIAL, ' + selected.length + ' of ' + ORDER.length + '): ' +
    passed + ' passed' + (failed.length ? ' \u00b7 ' + failed.length + ' failed' : '') +
    ' \u2014 this is not the gate; run `npm test` before believing the tree is green');
} else {
  console.log('RESULT: ' + passed + ' of ' + results.length + ' suites passed' +
    (failed.length ? ' \u00b7 ' + failed.length + ' failed' : ' \u00b7 nothing failed') +
    uncoveredNote);
}

if (failed.length) {
  console.log('\nFailed:');
  for (const r of failed) {
    console.log('  \u2717 ' + r.name + ' \u2014 ' + (r.summary || 'see the output above') +
      '  (npm run ' + r.name + ')');
  }
}
console.log(line);

process.exit(failed.length || forgotten.length || uncovered.length || registryError ? 1 : 0);
