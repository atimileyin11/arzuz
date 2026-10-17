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
  'test:claims',
  /* the verification shift's own suite, beside the other queue work: the
     ordering and the clock are pure policy, so it needs no database —
     the chaser's hooks in netlify/functions/verification-aging.js are
     stubbed, and what it proves is that a lateness is announced once, and
     that a job nobody did comes back */
  'test:verify-queue',
  'test:care-pass',
  'test:my-care',
  'test:admin',
  'test:postgrest',
  'test:care-live',
  'test:draft-errors',
  'test:api-errors',  'test:waitlist',
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
const NOT_A_SUITE = ['sql:mutate'];

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
   go
   ------------------------------------------------------------ */

console.log(line);
console.log('Arzuz test suite \u2014 ' + ORDER.length + ' suites, every one reported');
console.log(line);

if (forgotten.length) {
  console.log('\n\u2717 package.json has suite scripts this runner does not know about:');
  for (const name of forgotten) console.log('    ' + name + '  (npm run ' + name + ')');
  console.log('  Add it to ORDER in dev/run-tests.mjs \u2014 otherwise it will never run.');
}

const results = [];

for (const name of ORDER) {
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
}
console.log(line);

if (forgotten.length) {
  console.log('RESULT: ' + passed + ' of ' + results.length + ' passed \u00b7 ' +
    forgotten.length + ' suite(s) exist in package.json but were NOT run');
} else {
  console.log('RESULT: ' + passed + ' of ' + results.length + ' suites passed' +
    (failed.length ? ' \u00b7 ' + failed.length + ' failed' : ' \u00b7 nothing failed'));
}

if (failed.length) {
  console.log('\nFailed:');
  for (const r of failed) {
    console.log('  \u2717 ' + r.name + ' \u2014 ' + (r.summary || 'see the output above') +
      '  (npm run ' + r.name + ')');
  }
}
console.log(line);

process.exit(failed.length || forgotten.length ? 1 : 0);
