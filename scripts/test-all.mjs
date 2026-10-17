#!/usr/bin/env node
/* ============================================================
   Arzuz — every suite, one command, one exit code

   There are fifteen test files in this repo and no single place
   that knew it. `npm test` runs the five Node suites that
   package.json owns and none of the browser ones, so "I ran the
   tests" could mean anything. This runs all of them, each in its
   own process with its own exit code, and fails if any failed.

   WHERE THE LIST COMES FROM — it does not hold one for the Node
   suites. Every `test:*` and `sql:*` script in package.json is read
   and run here, so a suite added to package.json is picked up with
   no edit to this file, and a suite deleted there stops being run.
   The list below covers only what package.json cannot own: the
   suites that need a real browser, the static deploy guard, and the
   Node suites that were never wired into npm.

   And a test file that neither list covers is REPORTED, not
   ignored — `dev/my-care-test.js` is the live example: it exists,
   it passes, and nothing runs it. That is how a green suite comes
   to mean nothing. With --strict it fails the run.

   It is also what the pre-push gate runs (.githooks/pre-push), which
   is the point: a change to a shared file — motion.js, arzuz.css, the
   nav, netlify.toml — has to survive every page and every feature that
   depends on it, not just the one that was open.

   Run from arzuz-site/:
     node scripts/test-all.mjs                 full output
     node scripts/test-all.mjs --quiet         failing suites only
     node scripts/test-all.mjs --list          what would run
     node scripts/test-all.mjs --only=listing  one suite (substring)
     node scripts/test-all.mjs --live          add the live-domain probes
     node scripts/test-all.mjs --strict        a suite that cannot run is a failure
     node scripts/test-all.mjs --skip-npm      the npm-owned suites already ran
     node scripts/test-all.mjs --serial        one suite at a time, in listed order
     node scripts/test-all.mjs --workers=3     override the Node lane width
     node scripts/test-all.mjs --self-test     prove the lane plan drops no suite
     node scripts/test-all.mjs --timing=strict a suite slower than its own baseline fails the run
     node scripts/test-all.mjs --reset-baseline  forget the learned timings and start again
     node scripts/test-all.mjs --accept-slow-gate  the machine really did change: clear the slowdown streak
     node scripts/test-all.mjs --gate-ref=<id>  which ref this run is, so a streak can say where it was seen (CI passes its own)
     node scripts/test-all.mjs --timing-report=timings.json  write this run out for the run after it
     node scripts/test-all.mjs --timing-compare=timings.json  say what moved since that report

   --strict exists for the gate: a checkout with no node_modules cannot
   run the SQL proof, and "the suite that proves the schema executes did
   not run" is not something to wave through silently.

   AND IT WATCHES THE CLOCK. Every other check in this repo is a boolean:
   a page either revealed or it did not. A suite that quietly got three
   times slower is not a failure anywhere — it just eats the gate until
   someone gives up on running it, which is how a gate dies. So each run
   records every suite's own wall time in .test-timings.json (local,
   gitignored, machine-specific) and compares the next run against what
   that suite normally costs HERE: the median of its last five runs once
   there are three of them. Below three it judges nothing — the built-in
   estimate is printed as a learning line, because a guess that exists to
   order lanes cannot prove a regression. Slower than 1.5× the median AND
   at least 5s slower is a regression; it warns by
   default because wall time moves with the machine (a loaded box has made
   the SQL mutation run read 378s against its own 212s), and --timing=strict
   turns the warning into a failure for anyone who wants that. Re-measure
   one suite alone with --only=<id> before believing a number: a full run
   spreads every suite across the same machine. A sample is recorded by any
   run of more than one suite — a full one, or a --skip-npm one (the shape
   CI runs) — tagged with the shape it came from, so the two are compared
   separately and a run that left half the Node lane empty never makes every
   full run look slow. An --only run records nothing: one suite alone is
   faster than the same suite beside the rest.

   The whole RUN is watched the same way one level up — 1.3× and 45s,
   because a run is a coarser thing than a suite — and there the warning
   escalates. The same regression three runs in a row FAILS the run: that is
   the gate getting slower rather than the machine being busy, and a warning
   nobody acts on is how "three times slower" becomes permanent. See
   gateStreakStep for why the reference is frozen and what counts as the
   same regression, recoverEvidence for how a run that fixed the blamed
   suite drops the streak, and --accept-slow-gate for the one-command way
   to say the machine really did change.

   A streak is deliberately SHARED, not counted per branch. The baseline is
   one file — in CI, one cache entry restored by every ref — and the slowdown
   this check exists to catch is a RUNNER that got slower, which shows up on
   whichever branch happens to run third. Counting it per branch would make
   exactly that invisible: a branch with no history of its own starts the
   count at one, so one slow runner reads as its own first slow run on every
   branch, for ever, and the one regression that slows every run is the one
   nobody ever sees escalate. So a streak carries on across refs, and every
   run that counts records which ref it came from (--gate-ref; CI passes its
   own). One branch slow three times and three branches slow once are
   different findings, and the line that reports a streak says which it is.

   --skip-npm exists for CI, where `npm test` has just run every
   npm-owned suite: .github/workflows/ci.yml runs `npm test` and then
   this with --skip-npm, so the browser suites are added without running
   the Node ones twice.
   ============================================================ */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = 'scripts/test-all.mjs';

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const quiet = args.includes('--quiet');
const listOnly = args.includes('--list');
const serial = args.includes('--serial');
const selfTestMode = args.includes('--self-test');

/* How wide the Node lane may be. Two suites are separate processes with
   separate memory, which is what the browser lane has room for beside it.
   Measured on a four-thread i3: two at a time 331s, one at a time 376s,
   everything in one lane 379s — so two is the default even on a small box,
   and --workers=1 is there for one that is already busy with something
   else. */
const workers = serial ? 1 : Math.max(1, Number(argVal('workers') || 2) || 2);
const live = args.includes('--live');
const strict = args.includes('--strict');
const skipNpm = args.includes('--skip-npm');
const only = argVal('only');
const timingMode = String(argVal('timing') || 'warn').toLowerCase();
const resetBaseline = args.includes('--reset-baseline');
const acceptSlowGate = args.includes('--accept-slow-gate');
/* Which ref this run is. NOT a partition — see gateStreakStep — it is what a
   streak is labelled with, because "the same regression three runs in a row"
   means one thing on one branch and another thing across three of them. Empty
   on a laptop, where there is only one branch to be. */
const gateRef = String(argVal('gate-ref') || '');
const baselinePath = argVal('baseline') || join(SITE, '.test-timings.json');
const timingReportPath = argVal('timing-report');
const timingComparePath = argVal('timing-compare');

if (!['off', 'warn', 'strict'].includes(timingMode)) {
  console.error('--timing must be off, warn or strict (got "' + argVal('timing') + '")');
  process.exit(2);
}

/* A full run and a --skip-npm run are different shapes of the same machine:
   the second leaves the Node lane half empty, so its suites come back
   faster, and averaging the two together would make every full run look
   slow. So a sample is tagged with the shape it came from and is only ever
   compared against that shape. A --skip-npm run is worth judging (that is
   the shape CI runs in); an --only run is not—one suite alone is a third
   shape nobody would keep — so it records nothing and is judged against the
   full-run record, which is the slower and therefore the harder reference. */
const RECORD_SHAPE = only ? null : (skipNpm ? 'skip-npm' : 'full');
const JUDGE_SHAPE = RECORD_SHAPE || 'full';
const recordable = RECORD_SHAPE !== null;

/* ---------------- what this runner owns ----------------
   Browser and static first: a broken page is worth knowing about
   before a slow PGlite boot. */

/* `est` is a rough duration in seconds, and it is only ever a fallback:
   it decides what starts first inside a lane — never whether a suite runs,
   never a timeout — and once the runner has three recorded runs for a
   suite here, that suite's measured median decides instead (see planLanes).
   A number someone typed rots as the suites grow; a measurement does not. */
const OWNED = [
  { id: 'runner', label: "the runner's own lane plan (--self-test)", file: 'scripts/test-all.mjs', args: ['--self-test'], est: 1 },
  { id: 'guards', label: 'deploy guards (public files, sitemap, noindex)', file: 'scripts/test-deploy-guards.mjs', est: 2 },
  { id: 'site-audit', label: 'every page × 1440/390 (reveals, assets, links)', file: 'scripts/test-site-audit.mjs', needsChrome: true, est: 170 },
  { id: 'home-motion', label: 'landing motion, placement, write boundary', file: 'scripts/test-home-motion.mjs', needsChrome: true, est: 25 },
  { id: 'hero-geometry', label: "the hero object's derived geometry at 1440/390", file: 'scripts/test-hero-geometry.mjs', needsChrome: true, est: 26 },
  { id: 'hero-visual', label: "the hero object's paint, against its recorded image", file: 'scripts/test-hero-visual.mjs', needsChrome: true, est: 12 },
  { id: 'home-motion-fault', label: 'landing motion with one boot script request lost on purpose', file: 'scripts/test-home-motion.mjs', args: ['--fault-inject', '--width=desktop'], needsChrome: true, est: 40 },
  { id: 'listing-render', label: 'listing page render (9 generated cases × 1440/390/320px)', file: 'scripts/test-listing-render.mjs', needsChrome: true, est: 40 },
  { id: 'listing-fault', label: 'listing render with one script request lost on purpose', file: 'scripts/test-listing-render.mjs', args: ['--fault-inject', '--case=worst,huge'], needsChrome: true, est: 35 },
  { id: 'listing-fault-compound', label: 'listing render with two script requests lost at once', file: 'scripts/test-listing-render.mjs', args: ['--fault-inject', '--fault-victims=2', '--case=worst'], needsChrome: true, est: 12 },
  { id: 'listing-fault-preflight', label: 'listing render with the harness preflight fetch refused', file: 'scripts/test-listing-render.mjs', args: ['--fault-inject', '--fault-victims=0', '--fault-preflight=1', '--case=worst'], needsChrome: true, est: 10 },
  { id: 'listing-fault-css', label: 'listing render with its stylesheet lost (the guard must notice)', file: 'scripts/test-listing-render.mjs', args: ['--fault-inject', '--fault-victims=0', '--fault-css=1', '--case=worst'], needsChrome: true, est: 10 },
  { id: 'invite-render', label: 'landlord invite form render (7 seeds × 1440/390/320px)', file: 'scripts/test-invite-render.mjs', needsChrome: true, est: 40 },
  { id: 'invite-fault', label: 'landlord invite form with one script request lost on purpose', file: 'scripts/test-invite-render.mjs', args: ['--fault-inject', '--width=desktop', '--seed=worst'], needsChrome: true, est: 12 },
  { id: 'invite-fail-bodies', label: 'the invite form against each recorded platform failure (?fail=…)', file: 'scripts/test-invite-render.mjs', args: ['--fail-bodies'], needsChrome: true, est: 16 },
  { id: 'confirm-render', label: 'submission confirmation vs the door (9 answers, 3 held for a retry)', file: 'scripts/test-confirm-render.mjs', needsChrome: true, est: 60 },
  { id: 'admin-worst', label: 'admin dashboard worst case (verdicts, reasons, overflow)', file: 'scripts/test-admin-worst.mjs', needsChrome: true, est: 7 },
  { id: 'admin-fault', label: 'admin dashboard with one boot script request lost on purpose', file: 'scripts/test-admin-worst.mjs', args: ['--fault-inject', '--case=worst', '--width=desktop'], needsChrome: true, est: 30 },
  { id: 'fixture-plans', label: 'the generated fixtures, checked as fixtures', file: 'scripts/test-fixture-plans.mjs', est: 1 },
  { id: 'attribution', label: 'channel attribution + share links', file: 'scripts/test-attribution.mjs', est: 2 },
  { id: 'youtube-url', label: 'video URL parsing', file: 'scripts/test-youtube-url.mjs', est: 1 },
  { id: 'listing-og', label: 'link-preview cards (listing-og function)', file: 'scripts/test-listing-og.mjs', est: 2 },
  { id: 'strategy-docs', label: 'private strategy API (auth gate)', file: 'scripts/test-strategy-docs.mjs', est: 1 },
  { id: 'strategy-render', label: 'strategy markdown rendering', file: 'scripts/test-strategy-render.mjs', est: 1 }
];

/* Opt-in: these talk to the live domain and the live database, so a
   laptop on a bad connection must never be able to block a push. */
const LIVE_SUITES = [
  { id: 'live-cards', label: 'live link-preview cards (production)', file: 'scripts/verify-cards.mjs', est: 10 },
  { id: 'live-hardening', label: 'live RLS hardening probe (production)', file: 'scripts/hardening-probe.sh', bash: true, est: 60 }
];

/* Durations for the npm-owned suites, by id, from a real run. Anything not
   listed starts after them; a wrong estimate costs a few seconds of idle
   overlap, never a check. */
const EST = {
  'sql-mutate': 212,
  'sql-guards': 25,
  'test-admin': 13,
  'sql-proof': 12,
  'test-postgrest': 4,
  'test-my-care': 3,
  'test-roommate': 3,
  'test-care': 3
};

/* ---------------- what package.json owns ----------------
   "node dev/sql-proof.mjs" → dev/sql-proof.mjs. A script that is not a
   plain node invocation is not silently skipped: it is listed as not
   runnable here, so someone wires it properly instead of believing it
   ran. */

const pkgPath = join(SITE, 'package.json');
let npmSuites = [];
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  npmSuites = Object.entries(pkg.scripts || {})
    .filter(([name]) => /^(test|sql):/.test(name))
    .map(([name, cmd]) => {
      const text = String(cmd);
      const m = text.match(/((?:scripts|dev)\/[\w.-]+\.(?:mjs|cjs|js))/);
      /* The command's own arguments matter. test:care-live is
         "node dev/care-live-check.mjs --self-test", and running the file
         without --self-test runs the LIVE probe instead of the offline
         verdicts the gate wants — which is a red gate for a suite that
         passes. Keep everything after the file path. */
      const rest = m ? text.slice(m.index + m[1].length).trim() : '';
      return {
        id: name.replace(':', '-'),
        label: 'npm run ' + name,
        npm: name,
        file: m ? m[1] : null,
        args: rest ? rest.split(/\s+/) : [],
        cmd: text
      };
    });
} else {
  npmSuites = [{ id: 'package-json', label: 'package.json (the suite list lives there)', file: null, why: 'package.json is missing or unreadable' }];
}

/* ---- a test file nothing runs ----
   The whole reason this file exists is that "the tests pass" was true
   about a set nobody could name. A suite nobody invokes is a comment.
   (RUNNER is named up top, so the scratch check can exempt it.) */
const testLike = name => /^test[-.]/i.test(name) || /[-.]test\.(mjs|cjs|js)$/i.test(name);
const discover = dir => {
  try {
    return readdirSync(join(SITE, dir))
      .filter(f => /\.(mjs|cjs|js)$/.test(f) && testLike(f))
      .map(f => dir + '/' + f);
  } catch { return []; }
};
const knownFiles = new Set([...OWNED, ...LIVE_SUITES, ...npmSuites].map(s => s.file).filter(Boolean));
const unwired = [...discover('scripts'), ...discover('dev')]
  .filter(f => f !== RUNNER && !knownFiles.has(f))
  .sort();

/* ---------------- who may run beside whom --------------

   A suite that writes a fixed scratch path INSIDE the repo is not
   parallel-safe. test-listing-og.mjs and test-strategy-docs.mjs both build
   a `netlify/functions/__sandbox` tree to drive the real function handlers
   and then delete it — the file on disk IS the fixture. Run two of those at
   once and one unlinks the other's directory mid-run: EBUSY on a strategy
   .md, a 500 from a handler whose document just vanished. That is a harness
   collision wearing a page bug's clothes, which is the one thing the lanes
   exist to prevent, so a suite whose own source names such a path gets its
   own lane, one at a time. Read from the source rather than kept in a list
   here, so the next suite like it cannot be forgotten. */
const SCRATCH = /__sandbox|__nope|__fixture/;

/* A suite's own source, as text. Read from disk by default, but injectable
   so the routing rules can be exercised in the self-test without a real
   file for every case. */
const suiteSource = suite => {
  if (!suite.file) return '';
  try { return readFileSync(join(SITE, suite.file), 'utf8'); } catch { return ''; }
};

/* The runner's own source names these paths — in this regex and in the
   comment above it — so without an exemption it would route itself into the
   exclusive lane for a fixture it never writes. It is the runner, not a
   suite with a fixture, so it is exempt by name. */
const usesRepoScratch = (suite, read = suiteSource) =>
  suite.file !== RUNNER && SCRATCH.test(read(suite));

const laneOf = (suite, read = suiteSource) =>
  suite.needsChrome ? 'browser' : usesRepoScratch(suite, read) ? 'exclusive' : 'node';
const LANE_OF = suite => laneOf(suite);
const argText = s => (s.args && s.args.length) ? ' ' + s.args.join(' ') : '';

/* The plan, as a pure function of the suite list. No clock, and the only
   disk read is a suite's own source for the scratch check. `est` orders a
   lane — it never decides whether a suite runs. That this is a function
   with no hidden state is what lets the self-test prove, before any suite
   is spawned, that the mapping covers every input exactly once. */
function planLanes(run, { serial, workers, read = suiteSource, weight = () => null }) {
  /* What a suite costs, for ordering: the median of its own recorded runs
     here when there are enough, else the estimate. `weight` is injected so
     this stays a pure function the self-test can hand fake measurements
     to, the same way `read` lets it hand fake sources. */
  const cost = s => {
    const measured = weight(s);
    return measured != null ? measured : (s.est || 8) * 1000;
  };
  const byCost = (a, b) => cost(b) - cost(a);
  if (serial) return [{ name: 'all', width: 1, suites: run.slice() }];
  return [
    { name: 'browser', width: 1 },
    { name: 'node', width: workers },
    { name: 'exclusive', width: 1 }
  ]
    .map(l => ({ ...l, suites: run.filter(s => laneOf(s, read) === l.name).sort(byCost) }))
    .filter(l => l.suites.length);
}

/* ---------------- is this suite slower than it used to be? --------------

   A suite's own wall time is the one thing in this repo no assertion
   watched. It is also the thing that quietly kills a gate: nobody notices a
   suite going from 20s to 90s until the push gate is too slow to run, and
   then the gate is turned off — which is worse than any single failure it
   could have reported.

   So each run records what every suite cost here and compares the next run
   against it. Four decisions worth naming:

     · the reference is the MEDIAN of the suite's last five runs here, once
       there are three of them, and nothing is judged before that: the
       built-in `est` is a guess about lane ordering, and a run compared
       against a guess is a warning people learn to ignore. A median ignores
       both one lucky run and one run on a busy machine;
     · slow means slower than 1.5× the reference AND at least 5s slower. The
       floor is what keeps a 1s suite's normal jitter from being reported as
       news, because 5s is the scale on which this gate is actually felt;
     · only a suite that PASSED is judged. A suite that died after two
       seconds is fast, not healthy, and one that never ran has no time;
     · samples come from runs of the same shape — see RECORD_SHAPE above,
       and ONE OF THE WHOLE GATE below: a suite and the gate that holds it
       are watched separately, because 24 suites can each be steady while
       the run they share gets longer.

   The file is local and gitignored: it describes this machine, not the
   project, and deleting it just starts the learning again. */
const TIMING = { ratio: 1.5, floorMs: 5000, minSamples: 3, maxSamples: 5 };
/* The whole gate is a coarser thing than a suite, so its numbers are
   coarser: a third slower and 45s longer is a run somebody notices. And a
   run is a warning only the first time — escalateAt runs in a row of the
   same regression fail the run (see gateStreakStep). */
const GATE = { ratio: 1.3, floorMs: 45000, minRuns: 3, maxRuns: 8, escalateAt: 3, maxRefs: 5 };
/* Naming who made the run longer is a smaller decision than judging it:
   at most three suites, each at least 2s past its OWN recorded median (the
   per-suite floor of 5s is the bar for calling a suite a regression, not for
   mentioning it next to a run that is already 200s long), and only when they
   together explain half the overage. */
const BLAME = { max: 3, floorMs: 2000, share: 0.5 };

const median = xs => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const keepMs = n => Number.isFinite(n) && n > 0;

/* A record keeps one list of samples per run shape. A record written before
   shapes existed is a flat array, and that was a full run. */
function samplesFor(record, shape) {
  if (!record) return [];
  if (record.shapes && Array.isArray(record.shapes[shape])) return record.shapes[shape].filter(keepMs);
  if (shape === 'full' && Array.isArray(record.samples)) return record.samples.filter(keepMs);
  return [];
}

/* what this suite normally costs, in this shape: its own recent runs, else
   the estimate (which is shown, never judged against) */
function timingReference(suite, record, shape = 'full') {
  const samples = samplesFor(record, shape);
  if (samples.length >= TIMING.minSamples) {
    return {
      ms: median(samples),
      runs: samples.length,
      shape,
      source: samples.length + (shape === 'full' ? '' : ' ' + shape) + ' runs here'
    };
  }
  if (suite.est) return { ms: suite.est * 1000, runs: samples.length, shape, source: 'built-in estimate' };
  return null;
}

function timingVerdict(suite, record, ms, ratio = TIMING.ratio, shape = 'full') {
  const ref = timingReference(suite, record, shape);
  if (!ref) return { state: 'unknown', ref: null, ms, judged: false };
  const limit = Math.round(ref.ms * ratio);
  const over = ms - ref.ms;
  /* Only a suite's OWN recorded runs can call a regression. The built-in
     estimate is a guess that exists to order lanes, and comparing a
     measurement against a guess is how a warning section teaches people to
     ignore it — the first gate run after this shipped flagged the SQL proof
     at 2.73× an estimate of 12s that the suite has never once met. Below
     minSamples the ratio is shown as a learning line and nothing is judged:
     those runs are the measurement, not the verdict. */
  const judged = ref.runs >= TIMING.minSamples;
  const slow = judged && ms > limit && over >= TIMING.floorMs;
  return { state: slow ? 'slow' : judged ? 'ok' : 'learning', ref, limit, ms, judged, ratio: ms / ref.ms, over };
}

/* judge a finished run. Skipped and failed suites are carried through with
   a null verdict so the table can say why they are not in the comparison. */
function judgeTimings(results, baseline, ratio = TIMING.ratio, shape = 'full') {
  return results.map(r => ({
    id: r.suite.id,
    suite: r.suite,
    lane: r.lane,
    state: r.state,
    ms: r.ms,
    verdict: r.state === 'PASS' ? timingVerdict(r.suite, baseline.suites[r.suite.id], r.ms, ratio, shape) : null
  }));
}

/* the baseline after this run: one new sample per passing suite, in this
   run's shape, capped so the reference stays recent-ish without forgetting
   what the suite costs when healthy */
function mergeTimings(baseline, results, shape) {
  const suites = { ...baseline.suites };
  if (!shape) return { ...baseline, suites };
  for (const r of results) {
    if (r.state !== 'PASS' || !r.ms) continue;
    const old = { ...(suites[r.suite.id] || {}) };
    const shapes = { ...(old.shapes || {}) };
    if (!shapes.full && Array.isArray(old.samples)) shapes.full = old.samples.filter(keepMs);
    shapes[shape] = (shapes[shape] || []).filter(keepMs).concat(r.ms).slice(-TIMING.maxSamples);
    delete old.samples;
    suites[r.suite.id] = { ...old, shapes, updatedAt: new Date().toISOString() };
  }
  return { ...baseline, suites };
}

/* ---------------- one of the whole gate ----------------

   A suite can be watched perfectly and the gate still rot: a fifth suite
   added, a lane that used to overlap and no longer does, a suite that got
   slower without any single one passing the per-suite bar. This is the same
   idea one level up — the run's wall clock against its own recent history
   in the same shape. It is deliberately coarser than the per-suite check
   (1.3× and 45s) because a whole run is a coarser thing, and a run with
   MORE suites in it is a bigger gate rather than a slower one, which is
   reported as such instead of as a regression. */
function gateVerdict(history, wallMs, suiteCount, shape, opts = GATE) {
  const hist = (history || [])
    .filter(r => r && r.shape === shape && keepMs(r.wall))
    .slice(-opts.maxRuns);
  if (hist.length < opts.minRuns) return { state: 'learning', runs: hist.length, shape, wall: wallMs, suites: suiteCount };
  const ref = {
    wall: median(hist.map(r => r.wall)),
    suites: median(hist.map(r => r.suites || 0)),
    count: hist.length
  };
  const over = wallMs - ref.wall;
  const slower = wallMs > ref.wall * opts.ratio && over >= opts.floorMs;
  if (slower && suiteCount > ref.suites) return { state: 'grew', ref, over, wall: wallMs, suites: suiteCount, shape };
  return { state: slower ? 'slow' : 'ok', ref, over, wall: wallMs, suites: suiteCount, shape };
}

/* Where the escape hatch is read decides how it is phrased: this line lands in
   a CI log as often as in a terminal now, and "run this on your laptop" is not
   an instruction anyone can follow there. */
const gateEscapeHint = ci => ci
  ? 're-run this workflow with accept_slow_gate checked, or set the ARZUZ_ACCEPT_SLOW_GATE repository variable'
  : 'node scripts/test-all.mjs --accept-slow-gate';
const IN_CI = process.env.GITHUB_ACTIONS === 'true';

/* keep a little more history than is ever judged, so both shapes keep theirs */
function mergeGate(history, run) {
  return (history || []).filter(Boolean).concat(run).slice(-GATE.maxRuns * 2);
}

/* ---------------- who made it longer --------------

   "The gate got slower" is a fact about a run; "these two suites got
   slower" is the thing somebody can act on. Pointing at the timing table
   instead is how the one number worth reading gets read by nobody.

   The excess is measured against each suite's OWN recorded runs, not
   against its share of the wall clock: the suite that is always the slowest
   one here has not changed, and naming it for being slow would be a lie
   told with true numbers. So the suites are ranked by how far past their own
   baseline they are, and only the ones that clear the floor are named — a
   run that got 300s longer with no suite 2s past its own baseline is a
   different problem (the lanes, the machine, or the gate itself), and the
   honest answer is to say so rather than to name a suite for +2s.

   The share is what the named suites account for of the overage, capped at
   100%: a suite that came back faster is subtracted from the picture, and
   "120% of it" is arithmetic nobody believes. */
function blameSuites(timing, overMs, opts = BLAME) {
  const judged = timing.filter(t => t.verdict && t.verdict.judged).length;
  const learning = timing.filter(t => t.verdict && !t.verdict.judged).length;
  if (!keepMs(overMs)) return null;
  const past = timing
    .filter(t => t.verdict && t.verdict.judged && keepMs(t.verdict.over))
    .map(t => ({ id: t.id, ms: t.ms, over: t.verdict.over, ratio: t.verdict.ratio, ref: t.verdict.ref }))
    .filter(r => r.over >= opts.floorMs)
    .sort((a, b) => b.over - a.over);
  const named = past.slice(0, opts.max);
  const explainedMs = named.reduce((sum, r) => sum + r.over, 0);
  /* Under the share bar, naming the largest one would still be reading tea
     leaves — it is reported as "no suite" with the reason why. */
  if (!named.length || explainedMs < overMs * opts.share) {
    return { named: [], others: past.length, explainedMs, share: explainedMs / overMs, judged, learning };
  }
  return { named, others: past.length - named.length, explainedMs, share: explainedMs / overMs, judged, learning };
}

/* one line, and never a lecture: what the numbers are, and — when they are
   not the answer — that they are not the answer */
function blameLines(blame, opts = BLAME) {
  if (!blame) return [];
  if (!blame.named.length) {
    if (!blame.judged) {
      return ['  · no suite has ' + TIMING.minSamples +
        ' runs recorded here yet, so none of it can be pinned on one'];
    }
    /* Two different answers wearing one sentence is how a line stops being
       read: "nothing is past the floor" and "they are, but they do not
       explain it" are opposite findings, so each says itself. */
    const rest = ': this is the lanes, the machine, or the gate itself rather than one suite';
    if (!blame.others) {
      return ['  · no suite is more than ' + (opts.floorMs / 1000).toFixed(1) + 's past its own baseline' + rest];
    }
    const one = blame.others === 1;
    return ['  · ' + blame.others + ' suite' + (one ? ' is ' : 's are ') + 'more than ' +
      (opts.floorMs / 1000).toFixed(1) + 's past ' + (one ? 'its' : 'their') + ' own baseline, but ' +
      (one ? 'it explains' : 'together they explain') + ' under ' +
      Math.round(opts.share * 100) + '% of it' + rest];
  }
  const named = blame.named
    .map(r => r.id + ' +' + (r.over / 1000).toFixed(1) + 's (' + r.ratio.toFixed(2) + '×)')
    .join(', ');
  const one = blame.named.length === 1;
  return ['  · ' + blame.named.length + ' suite' + (one ? '' : 's') +
    (one ? ' accounts for ' : ' account for ') +
    Math.min(100, Math.round(blame.share * 100)) + '% of it: ' + named +
    (blame.learning ? '  ·  ' + blame.learning + ' still learning here' : '')];
}

/* ---------------- and what the blame looked like next time ----------------

   A streak says "the same regression, run after run", and that is only true
   while the suite it blamed is still the thing making the run long. So every
   run that counts writes down WHICH suites it blamed (see streakClaim), and
   the next run measures them first. When every one of them is back inside
   its own baseline, the regression the streak was counting is gone, and a
   slow run for some other reason must not be counted as more of it.

   Without this, the only way out of a red gate would be --accept-slow-gate,
   which says the MACHINE changed, when the truth is that somebody fixed the
   thing the gate named. The evidence is per suite and comes from the same
   verdicts the blame was computed from: a suite is back when it passed and
   is no longer SLOW by this runner's own suite bar — 1.5× its recorded runs
   and 5s past them. That bar and not the 2s mention floor, because a few
   percent on a busy box is the same noise the per-suite check refuses to
   report, and a recovery that noise can block is a recovery that is not
   there when it is needed. A suite that failed, was skipped, is still
   learning or did not run this time is not evidence of anything, and "every
   blamed suite is fine" must never be vacuously true — so at least one of
   them has to have been measured. Returns null when there is nothing to
   check or no evidence either way. */
function recoverEvidence(prev, timing) {
  const blamed = ((prev && prev.blamed) || []).filter(Boolean);
  if (!blamed.length) return null;
  const by = new Map(timing.map(t => [t.id, t]));
  const measured = blamed.filter(id => by.has(id));
  if (!measured.length) return null;
  const stillSlow = measured.filter(id => {
    const v = by.get(id).verdict;
    return !v || v.state !== 'ok';
  });
  if (stillSlow.length) return null;
  return { blamed: measured, unmeasured: blamed.length - measured.length };
}

/* ---------------- the same regression, run after run ----------------

   One run at 1.3× is a warning, because wall time moves with the machine.
   The same run past the same reference, escalateAt runs in a row, is not a
   busy machine — it is the gate itself getting slower, and a warning nobody
   acts on is how that becomes permanent. So the warning escalates: at
   escalateAt runs in a row the run FAILS, and the pre-push gate stops being
   something that only ever prints.

   Two details are what make the streak mean what it says.

   The reference is FROZEN at the run that started the streak. Counting
   "slow" runs would not work: the reference is the median of the last five
   runs, so three slow runs are enough to become the reference, after which
   the very same run reads 1.00× and `ok` — the evidence absorbs itself. The
   anchor is the median the machine held BEFORE the streak, and it does not
   move while the streak lives. A run that comes back inside it is the
   machine returning to itself, and that ends the streak.

   A run of a different SIZE is not the same regression. Adding a suite makes
   a run longer for a reason that has nothing to do with rot, so the anchor
   cannot judge it: that run is reported as a bigger gate, and the streak
   neither counts it nor is cleared by it. That is also what stops a gate
   that grew once from failing forever.

   And a streak ends on evidence, not only on an acceptance. The suites it
   blamed travel with it (see streakClaim), and a run where every one of
   them is back inside its own baseline ends the count instead of adding to
   it — see recoverEvidence. Fixing the thing the gate named is the way out
   that does not have to claim the machine changed.

   Escaping is deliberate and one command wide. If the machine really did
   change — a slower laptop, a busier box — --accept-slow-gate says so once:
   the streak is cleared, the run passes, and this run's cost becomes part of
   the history the next one is measured against. --timing=off is the other
   way out, and it turns the whole clock check off. */
function gateStreakStep(prev, verdict, opts = GATE) {
  const shape = verdict.shape;
  const ref = String(opts.ref || '');
  /* A streak belongs to the SHAPE that recorded it — a --skip-npm run is a
     different machine history and cannot continue a full run's streak — and
     deliberately not to a branch. The baseline is one file, restored by every
     ref in CI, and the thing this check exists to catch is a slower RUNNER,
     which surfaces on whichever branch happens to run third. Partitioned per
     ref, that could never escalate: every fresh branch would start the count
     at one, and the regression that slows every run would always look like its
     own first slow run. The ref is still recorded on every run that counts,
     because "three runs in a row" is a different finding depending on whether
     they were one branch or three — the line that reports it says which. */
  const live = (prev && prev.shape === shape && prev.anchor && keepMs(prev.anchor.wall)) ? prev : null;
  const was = live ? (Number(live.count) || 0) : 0;
  const seen = (live && Array.isArray(live.refs) ? live.refs : []).filter(Boolean);
  const withRef = () => (ref && !seen.includes(ref) ? seen.concat(ref).slice(-opts.maxRefs) : seen);
  /* below minRuns there is nothing to judge, and nothing worth carrying */
  if (verdict.state === 'learning') return { state: 'learning', count: 0, shape, was, refs: [] };
  const anchor = live ? live.anchor : (verdict.ref ? { wall: verdict.ref.wall, suites: verdict.ref.suites } : null);
  if (!anchor || !keepMs(anchor.wall)) return { state: 'none', count: 0, shape, was, refs: [] };
  if ((verdict.suites || 0) !== (anchor.suites || 0)) {
    return { state: 'bigger', count: was, shape, anchor, suites: verdict.suites, was, refs: seen };
  }
  const over = verdict.wall - anchor.wall;
  const slow = verdict.wall > anchor.wall * opts.ratio && over >= opts.floorMs;
  /* An anchor nobody accepted is only kept while a streak is live: a run
     back inside it ends the streak. An ACCEPTED one is kept until another
     one replaces it, because accepting is a statement about the machine —
     "this is what the gate costs here now" — and a statement that evaporated
     on the next run would mean accepting the same slowdown over and over.
     It is a statement about the machine, so with one shared baseline it holds
     for every ref reading it, not only the one that made it. */
  if (!slow) {
    const keep = live && (live.accepted || !was);
    return {
      state: keep ? 'based' : (was ? 'cleared' : 'none'),
      count: 0,
      anchor,
      shape,
      over,
      was,
      refs: keep ? seen : [],
      accepted: live && live.accepted ? true : undefined
    };
  }
  /* ...unless the regression it blamed has gone. Every run that counts
     writes its blame into the file (streakClaim), and this run has already
     measured those suites: when they are all back inside their own
     baselines, this is not more of the same regression, however slow the
     machine still is. The streak ends where it started — count zero — and
     the run does not fail, which is what makes fixing the blamed suite a
     way out of a red gate. */
  if (was && opts.recovery) {
    return { state: 'cleared', count: 0, anchor, shape, over, was, refs: [], recovered: opts.recovery };
  }
  const count = was + 1;
  return {
    state: count >= opts.escalateAt ? 'escalated' : 'counting',
    count,
    shape,
    anchor,
    over,
    was,
    refs: withRef(),
    accepted: live && live.accepted ? true : undefined
  };
}

/* WHICH suites the streak blamed, kept in the file beside it: the next run
   measures them first (recoverEvidence), and without the names there would
   be nothing to check. A run that counts records its own blame — against
   the frozen anchor when it escalated, against the rolling median when it
   only counted. A bigger gate keeps the claim waiting rather than
   re-recording it, because the size it could not judge also cannot
   re-judge the blame. */
function streakClaim(streak, blame, streakBlame, prev) {
  if (!streak) return [];
  if (streak.state === 'escalated') return ((streakBlame && streakBlame.named) || []).map(n => n.id);
  if (streak.state === 'counting') return ((blame && blame.named) || []).map(n => n.id);
  if (streak.state === 'bigger') return ((prev && prev.blamed) || []).filter(Boolean).slice();
  return [];
}

/* Where a streak was seen, in the shortest form that still identifies it: the
   branch name for a branch, `pull/7` for a pull request's merge ref. It is one
   line and never a paragraph, because it sits inside a sentence that already
   says the number of runs — its whole job there is to answer "all of them
   here, or this whole box?". */
function shortRef(r) {
  return String(r || '').replace(/^refs\/heads\//, '').replace(/^refs\/pull\/(\d+).*$/, 'pull/$1');
}

function gateRefLine(streak) {
  const refs = ((streak && streak.refs) || []).filter(Boolean);
  if (!refs.length) return '';
  if (refs.length === 1) return 'on ' + shortRef(refs[0]);
  return 'across ' + refs.length + ' refs (' + refs.map(shortRef).join(', ') + ')';
}

/* ---------------- and against the run before this one ----------------

   The learned baseline above lives on one machine; a CI runner starts from
   an empty checkout every time. So the same run can also be written out as
   a small JSON report (--timing-report), and the next run can be handed the
   previous one (--timing-compare) to print what moved between them. That is
   one sample rather than a median, which is why it is a separate, softer
   comparison: its job is to make a slowdown VISIBLE across commits. */
function deltaVerdict(previous, ms, ratio = TIMING.ratio) {
  if (!keepMs(previous)) return { state: 'unknown', previous: null, ms };
  const over = ms - previous;
  const slow = ms > previous * ratio && over >= TIMING.floorMs;
  return { state: slow ? 'slow' : 'ok', previous, ms, ratio: ms / previous, over };
}

/* The explanation, for the artifact rather than the log. CI uploads this run's
   report, and the run whose report is worth reading is the one that went red:
   "the gate got slower" with no idea which suite did it is a mystery in a JSON
   file, and whoever picks it up cannot scroll a log they were not watching. So
   the blamed suites travel with the numbers, next to the sentence the log
   printed, and `null` means nothing was judged — an empty object would read as
   "no suite was to blame" when the truth is that no verdict exists yet. */
/* one blamed suite, in the numbers a reader can check: what it cost, what it
   normally costs here, and how far past that it is */
const suiteBlame = r => ({
  id: r.id,
  ms: r.ms,
  over: r.over,
  ratio: Math.round(r.ratio * 100) / 100,
  baseline: r.ref && keepMs(r.ref.ms) ? r.ref.ms : null
});

function gateExplanation(gate, blame, streak, streakBlame) {
  if (!gate) return null;
  return {
    state: gate.state,
    wall: gate.wall,
    suites: gate.suites,
    reference: gate.ref ? { wall: gate.ref.wall, suites: gate.ref.suites, runs: gate.ref.count || null } : null,
    over: keepMs(gate.over) ? gate.over : null,
    blamed: ((blame && blame.named) || []).map(suiteBlame),
    pastFloor: blame ? blame.named.length + blame.others : null,
    learning: blame ? blame.learning : null,
    /* capped the way the sentence beside it is: a suite that came back faster
       is subtracted from the picture, and "they account for 139% of it" is
       arithmetic nobody believes */
    share: blame && keepMs(blame.share) ? Math.min(1, Math.round(blame.share * 100) / 100) : null,
    streak: streak
      ? {
        state: streak.state,
        count: streak.count,
        of: GATE.escalateAt,
        refs: (streak.refs || []).slice(),
        over: keepMs(streak.over) ? streak.over : null,
        /* Only the escalation has a blame list of its own, because only the
           escalation is measured against the frozen anchor rather than the
           rolling median — so it is `null`, not `[]`, where there is none */
        blamed: streakBlame ? ((streakBlame.named) || []).map(suiteBlame) : null,
        /* a streak a rerun ended on evidence names the suites that came
           back; state 'cleared' without it means the gate itself returned
           to the reference it held before the streak */
        recovered: streak.recovered ? streak.recovered.blamed.slice() : null,
        summary: streakBlame ? blameLines(streakBlame).map(l => l.trim()).join(' ') : null
      }
      : null,
    summary: blameLines(blame).map(l => l.trim()).join(' ') || null
  };
}

function timingReport(shown, { wall, work, shape, ref, gate, blame, streak, streakBlame } = {}) {
  return {
    at: new Date().toISOString(),
    ref: ref || null,
    shape,
    wall,
    work,
    suites: shown.length,
    results: shown.map(r => ({ id: r.suite.id, ms: r.ms, state: r.state })),
    gate: gateExplanation(gate, blame, streak, streakBlame)
  };
}

function loadBaseline() {
  const empty = { version: 3, suites: {}, runs: [], gate: null };
  if (timingMode === 'off' || resetBaseline) return empty;
  try {
    const raw = JSON.parse(readFileSync(baselinePath, 'utf8'));
    return {
      version: 3,
      suites: (raw && typeof raw.suites === 'object' && raw.suites) ? raw.suites : {},
      runs: (raw && Array.isArray(raw.runs)) ? raw.runs : [],
      gate: (raw && raw.gate && typeof raw.gate === 'object' && raw.gate.anchor) ? raw.gate : null
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.log('timing  could not read ' + baselinePath + ' (' + e.message + ') — starting a fresh baseline');
    }
    return empty;
  }
}

/* ---------------- the runner's own self-test ----------------

   Run by the gate as the `runner` suite (node scripts/test-all.mjs
   --self-test). It spawns nothing: every case is a fake suite list handed
   to planLanes. That is the only way to know the lane mapping cannot drop
   a suite without waiting for a real run to be wrong — the failure mode
   this whole file exists to catch, applied to this file. */
function selfTest() {
  let passed = 0;
  const failures = [];
  const is = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed += 1; console.log('  \u2713 ' + name); return; }
    failures.push(name + ' \u2014 expected ' + e + ', got ' + a);
    console.log('  \u2717 ' + name + '\n      expected ' + e + ', got ' + a);
  };

  const src = {
    'scripts/audit.mjs': 'sweeps every page and asserts on the reveals',
    'scripts/motion.mjs': 'asserts the landing motion',
    'scripts/og.mjs': 'builds netlify/functions/__sandbox then unlinks it',
    'scripts/docs.mjs': 'another suite that writes __sandbox',
    'scripts/plain.mjs': 'reads only, writes nothing inside the repo'
  };
  const read = s => src[s.file] || '';
  const fake = [
    { id: 'audit', file: 'scripts/audit.mjs', needsChrome: true, est: 100 },
    { id: 'motion', file: 'scripts/motion.mjs', needsChrome: true, est: 20 },
    { id: 'og', file: 'scripts/og.mjs', est: 2 },
    { id: 'docs', file: 'scripts/docs.mjs', est: 1 },
    { id: 'plain', file: 'scripts/plain.mjs', est: 5 }
  ];

  console.log('Runner lane plan \u2014 offline; no suite is spawned\n');

  console.log('1. Every suite lands in exactly one lane');
  const plan = planLanes(fake, { serial: false, workers: 2, read });
  const flat = plan.flatMap(l => l.suites.map(s => s.id));
  is('nothing is dropped', flat.slice().sort(), fake.map(s => s.id).sort());
  is('nothing is listed twice', flat.length, new Set(flat).size);
  is('all three lanes appear', plan.map(l => l.name).sort(), ['browser', 'exclusive', 'node']);

  console.log('\n2. Routing');
  is('a browser suite goes to the browser lane', laneOf(fake[0], read), 'browser');
  is('a suite that writes a scratch path gets its own lane', laneOf(fake[2], read), 'exclusive');
  is('and a second one does too, whatever it is called', laneOf(fake[3], read), 'exclusive');
  is('a read-only Node suite stays in the node lane', laneOf(fake[4], read), 'node');
  is('the runner is exempt from its own scratch rule', laneOf({ file: RUNNER }), 'node');
  is('the three scratch patterns, and one that is not', [SCRATCH.test('__sandbox'), SCRATCH.test('__nope'),
    SCRATCH.test('__fixture'), SCRATCH.test('functions')], [true, true, true, false]);

  console.log('\n3. Ordering \u2014 the slowest starts first inside its lane');
  is('a one-suite node lane is just that suite',
    plan.find(l => l.name === 'node').suites.map(s => s.id), ['plain']);
  is('the exclusive lane is longest-first too',
    plan.find(l => l.name === 'exclusive').suites.map(s => s.id), ['og', 'docs']);
  is('and the browser lane', plan.find(l => l.name === 'browser').suites.map(s => s.id), ['audit', 'motion']);

  console.log('\n4. Widths');
  is('browser, one at a time \u2014 two Chromes would race', plan.find(l => l.name === 'browser').width, 1);
  is('exclusive, one at a time \u2014 the fixture is on disk', plan.find(l => l.name === 'exclusive').width, 1);
  is('node honours --workers', plan.find(l => l.name === 'node').width, 2);
  is('--serial is one lane holding everything',
    planLanes(fake, { serial: true, workers: 2, read }).map(l => [l.name, l.suites.length]), [['all', 5]]);

  console.log('\n5. An empty lane is not printed');
  is('one node suite, one lane', planLanes([fake[4]], { serial: false, workers: 2, read }).map(l => l.name), ['node']);

  /* The timing check is the one part of this runner that judges a number
     rather than a boolean, so it is the part most able to cry wolf. Every
     rule it follows is a case here, against fake timings and a fake
     baseline file. */
  console.log('\n6. The timing baseline only calls a real slowdown a slowdown');
  const big = { id: 'sql-mutate', est: 212 };
  const quick = { id: 'guards', est: 1 };
  const runs = (...xs) => ({ samples: xs });

  is('with no runs recorded here nothing is judged — the estimate is shown, not compared',
    [timingVerdict(big, null, 220000).state, timingVerdict(big, null, 400000).state], ['learning', 'learning']);
  is('and a first run far past the estimate is not a regression',
    timingVerdict(big, null, 400000).judged, false);
  is('two runs here are still too few to judge against',
    [timingVerdict(big, runs(210000, 214000), 900000).state, timingReference(big, runs(210000, 214000)).source],
    ['learning', 'built-in estimate']);
  is('three runs here become the reference', timingReference(big, runs(210000, 200000, 205000)).source, '3 runs here');
  is('the reference is their median, not their mean', timingReference(big, runs(100000, 200000, 300000)).ms, 200000);

  is('within 1.5x of its own median is not a regression',
    timingVerdict(big, runs(200000, 205000, 198000), 290000).state, 'ok');
  is('past 1.5x and 5s slower is',
    timingVerdict(big, runs(200000, 205000, 198000), 320000).state, 'slow');
  is('past 1.5x but not 5s slower is not — a 1s suite is allowed to jitter',
    timingVerdict(quick, runs(1000, 1000, 1000), 2200).state, 'ok');
  is('the ratio and the seconds-over are both reported',
    [Math.round(timingVerdict(big, runs(200000, 205000, 198000), 320000).ratio * 100) / 100,
      timingVerdict(big, runs(200000, 205000, 198000), 320000).over], [1.6, 120000]);
  is('a suite with no estimate and no runs has nothing to compare against',
    timingVerdict({ id: 'mystery' }, null, 5000).state, 'unknown');

  console.log('\n7. What gets judged, and what gets recorded');
  const judged = judgeTimings([
    { suite: big, state: 'PASS', ms: 320000 },
    { suite: big, state: 'FAIL', ms: 900 },
    { suite: big, state: 'SKIP', ms: 0 }
  ], { suites: { 'sql-mutate': runs(200000, 205000, 198000) } });
  is('a passing suite is judged', judged[0].verdict.state, 'slow');
  is('a suite that failed is not — its time is short, not healthy', judged[1].verdict, null);
  is('a suite that never ran is not', judged[2].verdict, null);

  is('a full run adds one sample per passing suite',
    mergeTimings({ suites: {} }, [{ suite: { id: 'x' }, state: 'PASS', ms: 5000 }], 'full').suites.x.shapes, { full: [5000] });
  is('failed and skipped suites add nothing',
    Object.keys(mergeTimings({ suites: {} }, [
      { suite: { id: 'x' }, state: 'PASS', ms: 5000 },
      { suite: { id: 'y' }, state: 'FAIL', ms: 100 },
      { suite: { id: 'z' }, state: 'SKIP', ms: 0 }
    ], 'full').suites), ['x']);
  is('samples are capped, oldest first',
    mergeTimings({ suites: { x: { shapes: { full: [1, 2, 3, 4, 5] } } } },
      [{ suite: { id: 'x' }, state: 'PASS', ms: 6 }], 'full').suites.x.shapes.full, [2, 3, 4, 5, 6]);
  is('and one sample does not decide the reference',
    timingReference(big, mergeTimings({ suites: {} },
      [{ suite: big, state: 'PASS', ms: 400000 }], 'full').suites['sql-mutate']).source, 'built-in estimate');

  console.log('\n8. A sample belongs to a run shape, not to the suite in general');
  const shapedFull = { shapes: { full: [200000, 205000, 198000] } };
  is('a --skip-npm sample lands in its own shape',
    mergeTimings({ suites: {} }, [{ suite: { id: 'x' }, state: 'PASS', ms: 5000 }], 'skip-npm').suites.x.shapes,
    { 'skip-npm': [5000] });
  is('a skip-npm run is not judged against the full-run record',
    timingReference(big, shapedFull, 'skip-npm').source, 'built-in estimate');
  is('and the full-run record is still there for full runs', timingReference(big, shapedFull, 'full').runs, 3);
  is('a record written before shapes existed is read as a full-run record',
    timingReference(big, { samples: [200000, 205000, 198000] }, 'full').runs, 3);
  is('...and is not another shape\u2019s record, because it was a full run',
    timingReference(big, { samples: [200000, 205000, 198000] }, 'skip-npm').runs, 0);
  is('two shapes of one suite are kept apart',
    Object.keys(mergeTimings({ suites: { x: { shapes: { full: [10] } } } },
      [{ suite: { id: 'x' }, state: 'PASS', ms: 20 }], 'skip-npm').suites.x.shapes).sort(), ['full', 'skip-npm']);

  console.log('\n9. A lane starts its slowest suite first \u2014 by measurement when there is one');
  const two = [
    { id: 'typed-slow', est: 100, file: 'scripts/a.mjs', needsChrome: true },
    { id: 'measured-slow', est: 5, file: 'scripts/b.mjs', needsChrome: true }
  ];
  const laneOrder = weight => planLanes(two, { serial: false, workers: 2, read, weight })
    .find(l => l.name === 'browser').suites.map(s => s.id);
  is('the estimate decides when nothing has been measured', laneOrder(() => null), ['typed-slow', 'measured-slow']);
  is('a measured time overrides it', laneOrder(s => (s.id === 'measured-slow' ? 300000 : null)),
    ['measured-slow', 'typed-slow']);
  is('and a suite with no measurement still falls back to its estimate',
    laneOrder(s => (s.id === 'typed-slow' ? 50000 : null)), ['typed-slow', 'measured-slow']);

  console.log('\n10. The whole gate against its own history');
  const hist = (shape, ...walls) => walls.map(w => ({ shape, wall: w, suites: 23 }));
  is('fewer than three runs is nothing to judge',
    gateVerdict(hist('full', 200000, 210000), 400000, 23, 'full').state, 'learning');
  is('within 1.3x of the median is not a regression',
    gateVerdict(hist('full', 200000, 210000, 220000), 240000, 23, 'full').state, 'ok');
  is('past 1.3x and 45s longer is',
    gateVerdict(hist('full', 200000, 210000, 220000), 300000, 23, 'full').state, 'slow');
  is('...unless the run simply has more suites in it, which is a bigger gate',
    gateVerdict(hist('full', 200000, 210000, 220000), 300000, 26, 'full').state, 'grew');
  is('and another shape is its own history',
    gateVerdict(hist('skip-npm', 100000, 110000, 120000), 300000, 23, 'full').state, 'learning');
  is('the median is what one lucky run cannot move',
    gateVerdict(hist('full', 100000, 200000, 300000), 210000, 23, 'full').ref.wall, 200000);
  is('the history keeps both shapes', mergeGate([{ shape: 'full', wall: 1 }], { shape: 'skip-npm', wall: 2 }).length, 2);

  /* the escalation: a warning the first time, evidence from then on */
  const held = 200000;
  const runOf = (wall, extra) => ({ shape: 'full', wall, suites: 23, ref: { wall: held, suites: 23 }, ...extra });
  const firstSlow = gateStreakStep(null, runOf(300000, { state: 'slow' }));
  is('one slow run starts a streak, anchored at what the gate held before it',
    [firstSlow.state, firstSlow.count, firstSlow.anchor.wall, firstSlow.was], ['counting', 1, held, 0]);
  const secondSlow = gateStreakStep(firstSlow, runOf(310000, { state: 'slow' }));
  is('the next one counts while it is still past that same anchor',
    [secondSlow.state, secondSlow.count], ['counting', 2]);
  is('and the third in a row is where the warning becomes a failure',
    gateStreakStep(secondSlow, runOf(320000, { state: 'slow' })).state, 'escalated');
  is('the anchor is frozen at the run that started the streak',
    gateStreakStep(secondSlow, runOf(320000, { state: 'slow' })).anchor.wall, held);
  is('so a regression the rolling median has absorbed is still counted',
    gateStreakStep(secondSlow, runOf(320000, { state: 'ok', ref: { wall: 320000, suites: 23 } })).state, 'escalated');
  is('a run back inside the anchor is the machine returning to itself, which ends the streak',
    gateStreakStep(secondSlow, runOf(210000, { state: 'ok' })).state, 'cleared');
  is('and clearing it means the next slow run is the first of three again',
    gateStreakStep(gateStreakStep(secondSlow, runOf(210000, { state: 'ok' })), runOf(300000, { state: 'slow' })).count, 1);
  is('a run of a different size cannot be judged by the anchor: the streak waits',
    [gateStreakStep(secondSlow, runOf(320000, { state: 'grew', suites: 26 })).state,
      gateStreakStep(secondSlow, runOf(320000, { state: 'grew', suites: 26 })).count], ['bigger', 2]);
  is('another shape is another machine history',
    gateStreakStep(secondSlow, { shape: 'skip-npm', state: 'slow', wall: 300000, suites: 23, ref: { wall: held, suites: 23 } }).state,
    'counting');
  is('below three recorded runs there is nothing to judge and nothing to carry',
    gateStreakStep(secondSlow, { shape: 'full', state: 'learning', wall: 300000, suites: 23 }).state, 'learning');
  is('a slow run with no reference at all starts nothing',
    gateStreakStep(null, { shape: 'full', state: 'slow', wall: 300000, suites: 23 }).state, 'none');
  is('a live streak keeps its own anchor even when this run has no rolling reference',
    [gateStreakStep(secondSlow, { shape: 'full', state: 'slow', wall: 300000, suites: 23 }).state,
      gateStreakStep(secondSlow, { shape: 'full', state: 'slow', wall: 300000, suites: 23 }).anchor.wall],
    ['escalated', held]);
  is('the bar is what decides, not the state name',
    gateStreakStep(firstSlow, runOf(300000, { state: 'slow' }), { ...GATE, escalateAt: 2 }).state, 'escalated');
  /* A streak also ends on evidence: every run that counts writes down the
     suites it blamed, and a rerun where they are all back inside their own
     baselines is the regression being fixed — a way out of a red gate that
     does not have to claim the machine changed. */
  const blamedRun = { ...secondSlow, blamed: ['site-audit'] };
  const fast = id => ({ id, verdict: { judged: true, state: 'ok', over: -5000, ratio: .95 } });
  const stillSlow = id => ({ id, verdict: { judged: true, state: 'slow', over: 62000, ratio: 65.63 } });
  const clearedBy = (prev, timing) => gateStreakStep(prev, runOf(320000, { state: 'slow' }),
    { ...GATE, recovery: recoverEvidence(prev, timing) });
  is('the suite a streak blamed, back inside its own baseline, drops the streak',
    clearedBy(blamedRun, [fast('site-audit')]).state, 'cleared');
  is('...and the run says which suite came back',
    clearedBy(blamedRun, [fast('site-audit')]).recovered.blamed, ['site-audit']);
  is('...and the count starts again rather than carrying on',
    clearedBy(blamedRun, [fast('site-audit')]).count, 0);
  is('a blamed suite still past its own baseline is the same regression, and counts',
    clearedBy(blamedRun, [stillSlow('site-audit')]).state, 'escalated');
  is('an escalation can end this way too — that is what a red gate clearing itself means',
    clearedBy({ ...secondSlow, state: 'escalated', count: 3, blamed: ['home-motion'] }, [fast('home-motion')]).state,
    'cleared');
  is('nothing blamed means nothing to check',
    recoverEvidence({ count: 2 }, [fast('site-audit')]), null);
  is('a suite that did not run this time is not evidence of anything',
    recoverEvidence({ blamed: ['site-audit'] }, []), null);
  is('nor is one that failed or was skipped',
    recoverEvidence({ blamed: ['site-audit'] }, [{ id: 'site-audit', verdict: null }]), null);
  is('nor one still learning its own baseline',
    recoverEvidence({ blamed: ['site-audit'] }, [{ id: 'site-audit', verdict: { judged: false, state: 'learning', over: 0 } }]), null);
  /* the bar is the suite check's own, not the mention floor: a suite a few
     percent over its baseline on a busy box is the noise that check exists
     to ignore, and it must not be able to hold a red gate open */
  is('a suite a few percent over its own baseline but inside the slow bar is back',
    recoverEvidence({ blamed: ['home-motion-fault'] },
      [{ id: 'home-motion-fault', verdict: { judged: true, state: 'ok', over: 3261, ratio: 1.07 } }]).blamed,
    ['home-motion-fault']);
  is('every blamed suite has to be back — one still slow keeps the streak alive',
    recoverEvidence({ blamed: ['site-audit', 'home-motion'] }, [fast('site-audit'), stillSlow('home-motion')]), null);
  is('all of them back is evidence',
    recoverEvidence({ blamed: ['site-audit', 'home-motion'] }, [fast('site-audit'), fast('home-motion')]),
    { blamed: ['site-audit', 'home-motion'], unmeasured: 0 });
  is('a blamed suite that no longer runs cannot be claimed as recovered by name',
    recoverEvidence({ blamed: ['site-audit', 'renamed'] }, [fast('site-audit')]),
    { blamed: ['site-audit'], unmeasured: 1 });
  is('what a run writes down for the next one: its own blame while it counts',
    streakClaim({ state: 'counting' }, { named: [{ id: 'site-audit' }] }, null, null), ['site-audit']);
  is('against the anchor when it escalated, which is the list it printed',
    streakClaim({ state: 'escalated' }, null, { named: [{ id: 'site-audit' }] }, null), ['site-audit']);
  is('a bigger gate keeps the claim it could not judge',
    streakClaim({ state: 'bigger' }, null, null, { blamed: ['site-audit'] }), ['site-audit']);
  is('and an ended streak writes nothing down',
    streakClaim({ state: 'cleared' }, { named: [{ id: 'site-audit' }] }, null, { blamed: ['site-audit'] }), []);
  /* an accepted reference (--accept-slow-gate) is a statement about the
     machine, so unlike a streak it has to survive the next run */
  const acceptedBase = { shape: 'full', count: 0, anchor: { wall: 400000, suites: 23 }, accepted: true };
  is('an accepted reference is carried rather than counted',
    [gateStreakStep(acceptedBase, runOf(410000, { state: 'ok' })).state,
      gateStreakStep(acceptedBase, runOf(410000, { state: 'ok' })).count], ['based', 0]);
  is('and a regression against it still has to repeat like any other',
    gateStreakStep(acceptedBase, runOf(700000, { state: 'slow' })).state, 'counting');
  is('it is not counted against a gate that has grown either',
    gateStreakStep(acceptedBase, runOf(410000, { state: 'grew', suites: 26 })).state, 'bigger');
  /* The streak is SHARED across refs, and that is the point of it: a CI cache
     is one file restored by every branch, and a runner that got slower shows up
     on whichever branch happens to run third. Partitioned per ref it could
     never escalate — every fresh branch would start the count at one, so the
     regression that slows every run would always look like its own first slow
     run — so the count carries on and the ref each run came from is recorded
     instead. */
  const onMain = gateStreakStep(null, runOf(300000, { state: 'slow' }), { ...GATE, ref: 'refs/heads/main' });
  const onPr = gateStreakStep(onMain, runOf(310000, { state: 'slow' }), { ...GATE, ref: 'refs/pull/7/merge' });
  is('a slowdown counted on one ref carries on to the next', [onPr.state, onPr.count], ['counting', 2]);
  is('...so the third run escalates on whichever branch it lands on',
    gateStreakStep(onPr, runOf(320000, { state: 'slow' }), { ...GATE, ref: 'refs/pull/9/merge' }).state, 'escalated');
  is('and the refs it counted travel with it, because three runs on one branch and three branches once are different findings',
    onPr.refs, ['refs/heads/main', 'refs/pull/7/merge']);
  is('a ref already counted is not listed twice',
    gateStreakStep(onPr, runOf(320000, { state: 'slow' }), { ...GATE, ref: 'refs/heads/main' }).refs.length, 2);
  is('the run that starts a streak carries its own ref', onMain.refs, ['refs/heads/main']);
  is('and a laptop, which has no ref to name, still counts',
    gateStreakStep(null, runOf(300000, { state: 'slow' })).refs, []);
  is('only the last few refs are kept',
    gateStreakStep({ ...onPr, count: 5, refs: ['a', 'b', 'c', 'd', 'e'] }, runOf(320000, { state: 'slow' }),
      { ...GATE, ref: 'f' }).refs, ['b', 'c', 'd', 'e', 'f']);
  is('the line says which branch when it was one', gateRefLine({ refs: ['refs/heads/main'] }), 'on main');
  is('and names them when it was the whole fleet',
    gateRefLine({ refs: ['refs/heads/main', 'refs/pull/7/merge'] }), 'across 2 refs (main, pull/7)');
  is('with nothing recorded it says nothing', gateRefLine({ refs: [] }), '');
  /* accepting is a statement about the MACHINE, and there is one machine: with
     the baseline shared, one accept holds for every ref that reads it */
  is('an accepted reference is the reference for every ref, not only the one that accepted it',
    gateStreakStep({ ...acceptedBase, refs: ['refs/heads/main'] }, runOf(410000, { state: 'ok' }),
      { ...GATE, ref: 'refs/pull/9/merge' }).state, 'based');
  is('the escape hatch is phrased for the place it is read',
    [/repository variable/.test(gateEscapeHint(true)), /--accept-slow-gate/.test(gateEscapeHint(false))],
    [true, true]);

  console.log('\n11. And against the run before this one');
  is('a suite that came back about the same is not news', deltaVerdict(120000, 122000).state, 'ok');
  is('one far slower is', deltaVerdict(120000, 200000).state, 'slow');
  is('and a second on a 1s suite is not', deltaVerdict(1000, 2000).state, 'ok');
  is('a report with no time for a suite compares nothing', deltaVerdict(null, 5000).state, 'unknown');
  is('the report carries what the next run needs to compare',
    Object.keys(timingReport([{ suite: { id: 'x' }, ms: 5000, state: 'PASS' }],
      { wall: 9000, work: 5000, shape: 'full' })).sort(),
    ['at', 'gate', 'ref', 'results', 'shape', 'suites', 'wall', 'work']);
  is('a run that judged nothing carries no explanation rather than an empty one',
    timingReport([], { wall: 1, work: 1, shape: 'full' }).gate, null);

  console.log('\n12. And who made the run longer');
  /* a timing row the way judgeTimings builds one: whether a suite is blamed
     is read off its own verdict, so these are the verdicts, not raw times */
  const row = (id, ms, refMs, runs = 5) => ({
    id,
    ms,
    verdict: { state: 'slow', over: ms - refMs, ratio: ms / refMs, judged: runs >= TIMING.minSamples, ref: { ms: refMs, runs } }
  });
  const long = blameSuites([row('site-audit', 200000, 110000), row('guards', 3000, 2500)], 100000);
  is('the suite that grew most is named first', long.named.map(n => n.id), ['site-audit']);
  is('and what it accounts for is said plainly', blameLines(long)[0],
    '  · 1 suite accounts for 90% of it: site-audit +90.0s (1.82×)');
  /* The uploaded report is read by whoever has to act on a red gate, and they
     cannot scroll a log they were not watching: the explanation travels with
     the numbers rather than only sitting in the log. */
  const slowGate = { state: 'slow', wall: 300000, suites: 23, ref: { wall: 200000, suites: 23, count: 3 }, over: 100000 };
  const explained = timingReport([{ suite: { id: 'site-audit' }, ms: 200000, state: 'PASS' }], {
    wall: 300000,
    work: 200000,
    shape: 'skip-npm',
    ref: 'refs/pull/7/merge',
    gate: slowGate,
    blame: long,
    streak: { state: 'escalated', count: 3, over: 100000, refs: ['refs/heads/main', 'refs/pull/7/merge'] }
  });
  is('the report names the suites it blames, not only the totals',
    [explained.gate.blamed.map(b => b.id), explained.gate.blamed[0].over, explained.gate.blamed[0].ratio,
      explained.gate.blamed[0].baseline], [['site-audit'], 90000, 1.82, 110000]);
  is('and carries the sentence the log printed, word for word',
    explained.gate.summary, blameLines(long)[0].trim());
  is('and where the streak was seen, so one branch is told apart from the fleet',
    [explained.gate.streak.count, explained.gate.streak.of, explained.gate.streak.refs],
    [3, 3, ['refs/heads/main', 'refs/pull/7/merge']]);
  is('and which ref this run itself was', explained.ref, 'refs/pull/7/merge');
  is('and the share it accounts for is capped the way its own sentence is',
    timingReport([], {
      wall: 1, work: 1, shape: 'full', gate: slowGate, streak: null,
      blame: blameSuites([row('a', 400000, 1000), row('b', 300000, 1000)], 100000)
    }).gate.share, 1);
  is('a run judged ok carries the verdict and no names',
    timingReport([], { wall: 1, work: 1, shape: 'full', gate: { state: 'ok', wall: 1, suites: 1, over: -1 } }).gate.blamed, []);
  is('the second suite past its own baseline comes next',
    blameSuites([row('guards', 3000, 2500), row('site-audit', 200000, 110000)], 100000).named.map(n => n.id),
    ['site-audit']);
  /* the whole point: the suite that is always the slowest one has NOT
     changed, and being big is not the same as being the reason */
  is('the slowest suite here is not blamed for not having changed',
    blameSuites([row('sql-mutate', 212000, 212000), row('site-audit', 200000, 110000)], 100000).named.map(n => n.id),
    ['site-audit']);
  is('two suites that explain it are both named',
    blameSuites([row('site-audit', 200000, 110000), row('listing-render', 90000, 50000)], 100000).named
      .map(n => n.id + ' ' + n.over), ['site-audit 90000', 'listing-render 40000']);
  is('naming stops at three',
    blameSuites([row('a', 40000, 1000), row('b', 30000, 1000), row('c', 20000, 1000), row('d', 10000, 1000)], 100000)
      .named.map(n => n.id), ['a', 'b', 'c']);
  is('a suite still learning here is never blamed',
    blameSuites([row('site-audit', 200000, 110000, 2), row('guards', 3000, 2500)], 100000).named.length, 0);
  is('and the count of them is carried, not hidden',
    blameSuites([row('site-audit', 200000, 110000), row('guards', 3000, 2500, 2)], 100000).learning, 1);
  is('with no suite past the floor it says so instead of naming one',
    blameLines(blameSuites([row('site-audit', 111000, 110000), row('guards', 3000, 2500)], 100000))[0],
    '  · no suite is more than 2.0s past its own baseline: this is the lanes, the machine, or the gate itself rather than one suite');
  /* two suites are past the floor and still do not add up to the overage:
     naming the larger one would be a smaller lie than saying nothing, so it
     says nothing — with the reason, and the count */
  is('past the floor but under the share bar leaves no names, and says why',
    blameLines(blameSuites([row('site-audit', 113000, 110000), row('guards', 6000, 2500)], 100000))[0],
    '  · 2 suites are more than 2.0s past their own baseline, but together they explain under 50% of it: ' +
    'this is the lanes, the machine, or the gate itself rather than one suite');
  is('one such suite is said in the singular',
    blameLines(blameSuites([row('site-audit', 113000, 110000), row('guards', 2000, 2500)], 100000))[0],
    '  · 1 suite is more than 2.0s past its own baseline, but it explains under 50% of it: ' +
    'this is the lanes, the machine, or the gate itself rather than one suite');
  is('an escalated streak carries its own blame, measured against its own anchor',
    timingReport([], {
      wall: 1,
      work: 1,
      shape: 'full',
      gate: slowGate,
      blame: long,
      streak: { state: 'escalated', count: 3, over: 100000, refs: ['refs/heads/main'] },
      streakBlame: blameSuites([row('guards', 9000, 2500)], 10000)
    }).gate.streak.blamed.map(b => b.id), ['guards']);
  is('and a streak that counted without escalating blames nobody',
    timingReport([], {
      wall: 1, work: 1, shape: 'full', gate: slowGate, blame: long,
      streak: { state: 'counting', count: 2, over: 5000, refs: [] }
    }).gate.streak.blamed, null);
  is('a streak cleared on evidence says which suite came back',
    timingReport([], {
      wall: 1, work: 1, shape: 'full', gate: slowGate, blame: long,
      streak: { state: 'cleared', count: 0, over: 5000, refs: [], recovered: { blamed: ['site-audit'], unmeasured: 0 } }
    }).gate.streak.recovered, ['site-audit']);
  is('and an ordinary clearing, which has no evidence, leaves that empty',
    timingReport([], {
      wall: 1, work: 1, shape: 'full', gate: slowGate, blame: long,
      streak: { state: 'cleared', count: 0, over: 0, refs: [] }
    }).gate.streak.recovered, null);
  is('and an overage nobody explains leaves no names at all',
    blameSuites([row('site-audit', 120000, 110000), row('guards', 3000, 2500)], 100000).named.length, 0);
  is('a run with nothing judged yet cannot pin it on anyone',
    blameLines(blameSuites([row('site-audit', 200000, 110000, 1)], 100000))[0],
    '  · no suite has ' + TIMING.minSamples + ' runs recorded here yet, so none of it can be pinned on one');
  is('a run that is not over anything prints nothing',
    [blameSuites([row('site-audit', 200000, 110000)], 0), blameLines(null).length], [null, 0]);

  console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  \u2717 ' + f));
  }
  process.exit(failures.length ? 1 : 0);
}

if (selfTestMode) selfTest();

/* ---------------- assemble the run ---------------- */

const npmRun = npmSuites
  .filter(s => s.file && !OWNED.some(o => o.file === s.file))
  .map(s => ({ ...s, needsPglite: /pglite/i.test(s.cmd), est: EST[s.id] || 8 }));

const SELECTED = OWNED.filter(s => !only || s.id.includes(only));
const SELECTED_NPM = (skipNpm ? [] : npmRun).filter(s => !only || s.id.includes(only));
const SELECTED_LIVE = LIVE_SUITES.filter(s => live && (!only || s.id.includes(only)));
const RUN = SELECTED.concat(SELECTED_NPM, SELECTED_LIVE);

if (only && !RUN.length) {
  console.error('No suite matches --only=' + only + '. See --list.');
  process.exit(2);
}

if (listOnly) {
  console.log('Suites this runner owns (' + OWNED.length + '):\n');
  for (const s of OWNED) console.log('  ' + s.id.padEnd(24) + s.label + '  (' + s.file + argText(s) + ')  [' + LANE_OF(s) + ' lane]');
  console.log('\nFrom package.json (' + npmSuites.length + '):\n');
  for (const s of npmSuites) console.log('  ' + s.id.padEnd(24) + s.label + '  (' + (s.file ? s.file + argText(s) : 'not a plain node script') + ')  [' + LANE_OF(s) + ' lane]');
  console.log('\nLive, opt-in via --live:\n');
  for (const s of LIVE_SUITES) console.log('  ' + s.id.padEnd(18) + s.label + '  (' + s.file + ')  [live]');
  console.log('\nTest-like files nothing runs (' + unwired.length + '):\n');
  console.log(unwired.length ? unwired.map(f => '  ' + f).join('\n') : '  none');
  console.log('\nRun one:  node scripts/test-all.mjs --only=<id>');
  process.exit(0);
}

/* The suite-id column is sized for the longest id this run knows, so a long
   id (listing-fault-compound) cannot push the lane, the verdict and the time
   into each other in the table, the verdict lines or the timing rows. */
const ID = Math.max(18, ...RUN.map(s => s.id.length));

/* ---------------- can this suite even run here? ---------------- */

function prerequisite(suite) {
  if (!suite.file) return suite.why || ('package.json runs "' + suite.cmd + '", which is not a plain node script this runner can invoke');
  if (!existsSync(join(SITE, suite.file))) return 'the file ' + suite.file + ' does not exist';
  if (suite.needsPglite && !existsSync(join(SITE, 'node_modules', '@electric-sql', 'pglite'))) {
    return 'node_modules is missing — run `npm ci` (this suite needs @electric-sql/pglite)';
  }
  return null;
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/c/Program Files/Google/Chrome/Application/chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

const chromeBin = () => CHROME_PATHS.find(existsSync) || null;

/* ---------------- run ----------------

   Two lanes, running at the same time:

     browser  one suite at a time. Each of these drives its own headless
              Chrome and asserts on the page's own behaviour — reveals,
              motion, layout. Two Chromes at once would have them failing
              on timing rather than on a page, so they never overlap.
     node     two at a time (--workers=N to override). Separate processes
              with separate memory. The slowest suite — the SQL mutation
              run, ~2 minutes — starts first in its lane so nothing queues
              behind it.
     exclusive  the suites that write a fixed scratch path inside the
              repo, one at a time: they are fixtures on disk, and two at
              once is one deleting the other's (see LANE_OF).

   Every suite still runs the way it did before: same process, same
   checks, same exit-code verdict. Only when it is allowed to start has
   changed. Output is printed as a block when a suite finishes so two
   suites' logs never interleave, and the summary reports wall-clock time
   next to the sum of the suites' own times, which is the size of the win.

   --serial puts everything back in one lane, in listed order. */

const baseline = loadBaseline();
const results = [];
const startedAll = Date.now();

/* The learned timings are read BEFORE the lanes are built, because they now
   decide the order: a suite that has become the slowest thing in its lane
   starts first even if the hand-written estimate still calls it quick. */
const measuredMs = id => {
  const record = baseline.suites[id];
  if (!record) return null;
  const all = (record.shapes
    ? Object.values(record.shapes).flat()
    : (Array.isArray(record.samples) ? record.samples : [])).filter(keepMs);
  /* ordering only needs a magnitude, so every shape of run counts here */
  return all.length >= TIMING.minSamples ? median(all) : null;
};
const lanePlan = planLanes(RUN, { serial, workers, weight: s => measuredMs(s.id) });
const measuredCount = RUN.filter(s => measuredMs(s.id) != null).length;

console.log('Arzuz — every suite');
console.log('suite runner  ' + process.version + '   cwd ' + SITE);
console.log('browser       ' + (chromeBin() || 'NOT FOUND (the browser suites will fail)'));
console.log('lanes         ' + lanePlan.map(l =>
  l.name + ' · ' + l.suites.length + ' suite' + (l.suites.length === 1 ? '' : 's') + ' · ' + l.width + ' at a time').join('   |   '));
console.log('suites        ' + RUN.length +
  (skipNpm ? ' (npm-owned suites skipped — npm test already ran them)' : '') +
  (live ? ' (including the live probes)' : ' (live probes skipped — --live to include them)'));
if (measuredCount) {
  console.log('order         ' + measuredCount + ' of ' + RUN.length + ' suites start by their measured time here (' +
    TIMING.minSamples + '+ runs recorded); the rest by the built-in estimate');
}
if (unwired.length) {
  console.log('unwired       ' + unwired.length + ' test file' + (unwired.length === 1 ? '' : 's') + ' no runner invokes: ' + unwired.join(', '));
}
console.log('');

/* One block per finished suite, so parallel logs stay readable. In --quiet
   only a failing suite's output is printed — but every suite still gets its
   one-line verdict, which is what makes a quiet run worth watching. */
function printBlock(suite, lane, ok, out) {
  const rule = '————————————————————————————————————————————';
  if (quiet) {
    if (ok) return;
    console.log('\n' + rule);
    console.log('FAILED — ' + suite.id + ' (' + suite.label + ')   [' + lane + ' lane]');
    console.log(rule);
    console.log(String(out).trim() || '(no output)');
    return;
  }
  console.log('\n' + rule);
  console.log('· ' + suite.id + ' — ' + suite.label + '   [' + lane + ' lane]');
  console.log(rule);
  const text = String(out);
  if (text.trim()) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function runSuite(suite, lane) {
  return new Promise(resolve => {
    const blocked = prerequisite(suite);
    if (blocked) {
      results.push({ suite, lane, state: 'SKIP', why: blocked, ms: 0 });
      console.log('· ' + suite.id.padEnd(ID + 2) + 'SKIPPED — ' + blocked);
      return resolve();
    }

    const started = Date.now();

    /* spawn, not spawnSync: a synchronous run would block the lane's other
       worker and the whole point of two lanes would be lost. */
    const child = spawn(suite.bash ? 'bash' : process.execPath, [suite.file, ...(suite.args || [])], { cwd: SITE });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    /* a suite that cannot even start is a failure with a reason, not a
       missing line in the table */
    child.on('error', err => { out += '[runner] could not start this suite: ' + err.message + '\n'; });

    child.on('close', status => {
      const ms = Date.now() - started;
      const ok = status === 0;
      results.push({
        suite, lane,
        state: ok ? 'PASS' : 'FAIL',
        why: ok ? '' : 'exit code ' + (status === null ? 'null (killed by a signal)' : status),
        ms
      });
      printBlock(suite, lane, ok, out);
      console.log((ok ? '✓ ' : '✗ ') + suite.id.padEnd(ID + 2) + (ok ? 'passed' : 'FAILED') + '  (' + (ms / 1000).toFixed(1) + 's)');
      resolve();
    });
  });
}

async function runLane(lane) {
  let next = 0;
  const worker = async () => {
    while (next < lane.suites.length) await runSuite(lane.suites[next++], lane.name);
  };
  await Promise.all(Array.from({ length: Math.min(lane.width, lane.suites.length) }, worker));
}

await Promise.all(lanePlan.map(runLane));

/* ---------------- summary ---------------- */

const passed = results.filter(r => r.state === 'PASS');
const failed = results.filter(r => r.state === 'FAIL');
const skipped = results.filter(r => r.state === 'SKIP');
const totalMs = Date.now() - startedAll;
const workMs = results.reduce((a, r) => a + r.ms, 0);

/* listed order, not completion order — the table is the manifest */
const order = new Map(RUN.map((s, i) => [s.id, i]));
const shown = results.slice().sort((a, b) => order.get(a.suite.id) - order.get(b.suite.id));

console.log('\n———————————————————————————————————————————————');
console.log('SUITE'.padEnd(ID + 4) + 'LANE'.padEnd(10) + 'RESULT'.padEnd(9) + 'TIME');
for (const r of shown) {
  console.log('  ' + r.suite.id.padEnd(ID + 2) + r.lane.padEnd(10) + r.state.padEnd(9) + (r.ms / 1000).toFixed(1) + 's' + (r.why ? '   ' + r.why : ''));
}
console.log('———————————————————————————————————————————————');
console.log(RUN.length + ' suites · ' + passed.length + ' passed · ' + failed.length + ' failed · ' + skipped.length + ' skipped' +
  '   (' + (totalMs / 1000).toFixed(1) + 's wall, ' + (workMs / 1000).toFixed(1) + 's of suite time)');

/* ---------------- the clock: slower than its own baseline? ----------------

   Judged before the baseline is updated, so this run is measured against
   what the suite cost before it — comparing a run against itself would
   make every suite exactly 1.00× and the whole check pointless. */
const timing = judgeTimings(shown, baseline, TIMING.ratio, JUDGE_SHAPE).filter(t => t.verdict);
const slow = timing.filter(t => t.verdict.state === 'slow');
const learning = timing.filter(t => t.verdict.state === 'learning');

const timingRow = t => {
  const v = t.verdict;
  const head = '  ' + t.id.padEnd(ID + 2) + (t.ms / 1000).toFixed(1).padStart(7) + 's  ';
  const ref = 'its ' + (v.ref.ms / 1000).toFixed(1) + 's (' + v.ref.source + ')';
  if (v.state === 'slow') return head + '⚠ ' + v.ratio.toFixed(2) + '× ' + ref + ' — ' + (v.over / 1000).toFixed(1) + 's slower';
  if (v.state === 'learning') {
    return head + '· ' + v.ratio.toFixed(2) + '× the built-in ' + (v.ref.ms / 1000).toFixed(1) +
      's estimate — learning (' + v.ref.runs + ' of ' + TIMING.minSamples + ' runs here, nothing judged yet)';
  }
  return head + '  ' + v.ratio.toFixed(2) + '× ' + ref;
};

if (timingMode !== 'off' && (!quiet || slow.length)) {
  console.log('\nTIMING — this run against what each suite normally costs here');
  if (!timing.length) {
    console.log('  · no suite had a time to compare');
  } else {
    for (const t of (quiet ? slow : timing)) console.log(timingRow(t));
    if (!slow.length) {
      console.log('  · nothing slower than its own baseline' +
        (learning.length ? ' (' + learning.length + ' suite' + (learning.length === 1 ? '' : 's') + ' still learning)' : ''));
    }
  }
  if (slow.length) {
    console.log('  ' + slow.length + ' suite' + (slow.length === 1 ? '' : 's') + ' slower than baseline: wall time moves with the machine, so this ' +
      (timingMode === 'strict' ? 'fails the run' : 'only warns') + '.');
    console.log('  Before believing it, re-measure alone:  node scripts/test-all.mjs --only=' + slow[0].id);
  }
  if (!quiet) {
    console.log('  baseline  ' + baselinePath.replace(SITE + (process.platform === 'win32' ? '\\' : '/'), '') +
      (resetBaseline ? '  (reset this run)' : '') +
      (learning.length ? '  ·  ' + learning.length + ' suite(s) still learning, judged against nothing' : ''));
  }
}

/* ---------------- and the whole run against its own history ----------------

   Judged, then escalated: a streak is only ever carried by a run that could
   record one (a --only run measures a quieter machine than the gate it would
   be compared against, and a run with the clock off is not watching at all).
   --accept-slow-gate is what clears the streak: it replaces it with a
   reference taken from this run, which is a different kind of fact. */
const gate = { ...gateVerdict(baseline.runs, totalMs, RUN.length, JUDGE_SHAPE), at: new Date().toISOString() };
/* --accept-slow-gate seeds the reference with THIS run: the streak is gone,
   and "the gate costs this here now" is carried in the file until another
   acceptance replaces it, so the next run is judged against what was
   accepted instead of against the history that made it look slow. */
const acceptedBase = acceptSlowGate
  ? (recordable ? { shape: JUDGE_SHAPE, count: 0, anchor: { wall: totalMs, suites: RUN.length }, accepted: true, refs: gateRef ? [gateRef] : [] } : null)
  : baseline.gate;
/* The evidence a streak can end on is measured from the same per-suite
   verdicts the blame is: which suites the last counted run blamed, and
   whether they are back inside their own baselines now. */
const streak = (timingMode === 'off' || !recordable)
  ? null
  : gateStreakStep(acceptedBase, gate, { ...GATE, ref: gateRef, recovery: recoverEvidence(acceptedBase, timing) });
const escalated = !!(streak && streak.state === 'escalated');
/* Who made it longer, computed ONCE: the log prints it and the uploaded report
   carries it, and two computations could disagree about a number somebody has
   to act on. The escalation is blamed against the frozen anchor rather than the
   rolling median the warning above it has already gone quiet about. */
const blame = timingMode === 'off' || gate.state !== 'slow' ? null : blameSuites(timing, gate.over);
/* the escalation is a different overage — the frozen anchor, not the rolling
   median — so it is a different blame list, with its own share of its own
   number. Printing one list under both sentences would put a percentage under
   a figure it was not computed from. */
const streakBlame = timingMode === 'off' || !escalated ? null : blameSuites(timing, streak.over);
/* an absorbed regression is exactly the case quiet mode must not hide: this
   fires even when the rolling verdict has gone quiet about it */
if (timingMode !== 'off' && (!quiet || gate.state === 'slow' || escalated)) {
  console.log('\nGATE — this run against its own recent history (' + JUDGE_SHAPE + ' runs)');
  console.log('  this run   ' + (totalMs / 1000).toFixed(1) + 's wall   (' + (workMs / 1000).toFixed(1) +
    's of suite time, ' + RUN.length + ' suite' + (RUN.length === 1 ? '' : 's') + ')');
  if (gate.state === 'learning') {
    console.log('  · ' + gate.runs + ' of ' + GATE.minRuns + ' ' + JUDGE_SHAPE +
      ' run' + (gate.runs === 1 ? '' : 's') + ' recorded here — nothing judged yet');
  } else {
    const ref = 'the last ' + gate.ref.count + ' (' + (gate.ref.wall / 1000).toFixed(1) + 's, ' + gate.ref.suites + ' suites)';
    const ratio = (totalMs / gate.ref.wall).toFixed(2) + '×';
    if (gate.state === 'slow') {
      console.log('  ⚠ ' + ratio + ' ' + ref + ' — ' + (gate.over / 1000).toFixed(1) + 's longer');
      blameLines(blame).forEach(l => console.log(l));
    } else if (gate.state === 'grew') {
      console.log('  · ' + ratio + ' ' + ref + ' — but ' + (RUN.length - gate.ref.suites) +
        ' more suite' + (RUN.length - gate.ref.suites === 1 ? '' : 's') + ' than that, so this is a bigger gate rather than a slower one');
    } else {
      console.log('  · ' + ratio + ' ' + ref);
    }
  }
  if (streak && (streak.state === 'counting' || streak.state === 'escalated')) {
    const against = (streak.anchor.wall / 1000).toFixed(1) + 's this gate held before them';
    const where = gateRefLine(streak);
    const row = 'the same regression ' + streak.count + ' of ' + GATE.escalateAt + ' run' +
      (streak.count === 1 ? '' : 's') + ' in a row' + (where ? ' ' + where : '') +
      ', each past ' + GATE.ratio + '× the ' + against;
    if (streak.state === 'counting') {
      console.log('  · ' + row + ' — ' + GATE.escalateAt + ' in a row fails the run');
    } else {
      console.log('  ⚠ ' + row + ' (' + (streak.over / 1000).toFixed(1) + 's over).');
      /* the escalation is the moment somebody has to act, so it says WHO:
         measured against the frozen anchor, not the rolling median that the
         warning above it went quiet about */
      blameLines(streakBlame).forEach(l => console.log(l));
      console.log('  ⚠ That is this gate getting slower, not the machine being busy: this run FAILS.');
      /* one branch three times is somebody's regression; three refs once each is
         the runner, and the sentence has to say which of the two it just read */
      if (streak.refs && streak.refs.length > 1) {
        console.log('  · ' + streak.refs.length + ' different refs in a row is what a slower runner looks like,' +
          ' not one branch pushing a regression');
      }
      console.log('    If the machine really did change, say so once:  ' + gateEscapeHint(IN_CI));
    }
  } else if (streak && streak.state === 'bigger') {
    console.log('  · ' + streak.count + ' run' + (streak.count === 1 ? '' : 's') + ' of the same regression '
      + 'already counted against ' + streak.anchor.suites + ' suites — this run has ' + streak.suites +
      ', so it is a different-sized gate and the streak waits for the next one');
  } else if (streak && streak.state === 'cleared' && streak.recovered) {
    /* the one line that says a red gate has gone green by itself, so it is
       printed even in quiet mode */
    const who = streak.recovered.blamed;
    console.log('  · the regression the streak was counting ended: ' + who.join(' and ') + ' ' +
      (who.length === 1 ? 'is' : 'are') + ' back inside ' + (who.length === 1 ? 'its' : 'their') +
      ' own baseline, so this slow run is not more of the same — the count starts again');
  } else if (streak && streak.state === 'cleared' && !quiet) {
    console.log('  · the same regression ended: this run is back inside the ' +
      (streak.anchor.wall / 1000).toFixed(1) + 's the gate held before it');
  } else if (streak && streak.state === 'based' && !quiet) {
    console.log('  · nothing counted: the reference is the ' + (streak.anchor.wall / 1000).toFixed(1) +
      's accepted here (--accept-slow-gate)');
  }
  if (acceptSlowGate) {
    console.log('  · accepted (--accept-slow-gate): the streak is cleared and the ' + (totalMs / 1000).toFixed(1) +
      's this run took is the reference from now on');
  }
}

/* ---------------- and against the run before this one ---------------- */
let deltas = [];
if (timingMode !== 'off' && timingComparePath) {
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(timingComparePath, 'utf8'));
  } catch (e) {
    if (!quiet) {
      console.log('\nAGAINST THE PREVIOUS RUN — no report at ' + timingComparePath +
        (e.code === 'ENOENT' ? ' (first run of this shape?)' : ' (' + e.message + ')'));
    }
  }
  if (previous) {
    const before = new Map((previous.results || []).map(r => [r.id, r.ms]));
    deltas = shown.filter(r => keepMs(r.ms) && before.has(r.suite.id))
      .map(r => ({ id: r.suite.id, ms: r.ms, verdict: deltaVerdict(before.get(r.suite.id), r.ms) }));
    const moved = deltas.filter(d => d.verdict.state === 'slow');
    if (!quiet || moved.length) {
      console.log('\nAGAINST THE PREVIOUS RUN — ' + timingComparePath + (previous.at ? '   (taken ' + previous.at + ')' : ''));
      if (!deltas.length) console.log('  · no suite appears in both runs');
      for (const d of (quiet ? moved : deltas)) {
        const v = d.verdict;
        const head = '  ' + d.id.padEnd(ID + 2) + (d.ms / 1000).toFixed(1).padStart(7) + 's  vs ' +
          (v.previous / 1000).toFixed(1) + 's  ';
        console.log(v.state === 'slow'
          ? head + '⚠ ' + v.ratio.toFixed(2) + '× — ' + (v.over / 1000).toFixed(1) + 's slower'
          : head + v.ratio.toFixed(2) + '×');
      }
      if (keepMs(previous.wall)) {
        const d = deltaVerdict(previous.wall, totalMs);
        console.log('  the gate   ' + (totalMs / 1000).toFixed(1) + 's  vs ' + (previous.wall / 1000).toFixed(1) + 's  ' +
          (d.state === 'slow' ? '⚠ ' + d.ratio.toFixed(2) + '× — ' + (d.over / 1000).toFixed(1) + 's longer' : d.ratio.toFixed(2) + '×'));
      }
    }
  }
}

if (timingMode !== 'off') {
  if (recordable) {
    try {
      const next = mergeTimings(baseline, shown, RECORD_SHAPE);
      next.runs = mergeGate(baseline.runs, {
        at: new Date().toISOString(), shape: RECORD_SHAPE, wall: totalMs, work: workMs, suites: RUN.length
      });
      /* the streak is carried in the file, because "the same regression again"
         is a fact about runs, and a fact about runs cannot live in one of them.
         A bigger gate keeps the streak waiting; anything else ends it. */
      const carried = streak && ['counting', 'escalated', 'bigger', 'based'].includes(streak.state);
      /* and WHICH suites it blamed travels with it, because the next run
         measures them first (recoverEvidence) — the count alone cannot say
         whether the thing it counted is still there */
      const claim = streakClaim(streak, blame, streakBlame, acceptedBase);
      next.gate = carried
        ? {
          shape: streak.shape,
          count: streak.count,
          anchor: streak.anchor,
          refs: (streak.refs || []).slice(),
          ...(streak.accepted ? { accepted: true } : {}),
          ...(claim.length ? { blamed: claim } : {}),
          at: new Date().toISOString()
        }
        : null;
      writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
    } catch (e) {
      /* a baseline that cannot be written must never fail a run that passed */
      console.log('timing  could not write ' + baselinePath + ' (' + e.message + ') — the next run compares against the old one');
    }
  } else if (!quiet) {
    console.log('timing  baseline not updated (--only measures a quieter, single-suite run than the one it would be compared against)');
  }
}

if (timingReportPath) {
  try {
    writeFileSync(timingReportPath, JSON.stringify(timingReport(shown, {
      wall: totalMs, work: workMs, shape: JUDGE_SHAPE, ref: gateRef, gate, blame, streak, streakBlame
    }), null, 2) + '\n');
    if (!quiet) console.log('report   ' + timingReportPath + ' — hand it to the next run as --timing-compare=<path>');
  } catch (e) {
    console.log('timing  could not write the report ' + timingReportPath + ' (' + e.message + ')');
  }
}

if (!live) console.log('Live probes (production domain + database) did not run — --live to include them.');

if (failed.length || escalated) {
  console.log('\nFAILED:');
  failed.forEach(r => console.log('  ✗ ' + r.suite.id + ' — ' + r.suite.label + '  ' + r.why));
  if (escalated) {
    /* The hint is the same phrase in two places, and the CI wording is a
       clause rather than a command, so it is never made the subject of a
       verb here — it is introduced and then stands on its own. */
    console.log('  ✗ the gate itself — the same regression ' + streak.count + ' runs in a row; to accept it once: ' +
      gateEscapeHint(IN_CI) + ' — or --timing=off to stop watching');
  }
}

if (skipped.length) {
  console.log('\nSKIPPED (could not run here):');
  skipped.forEach(r => console.log('  · ' + r.suite.id + ' — ' + r.why));
  if (strict) console.log('\n--strict is on: a suite that could not run counts as a failure.');
}

if (unwired.length) {
  console.log('\nTEST FILES NO RUNNER INVOKES:');
  unwired.forEach(f => console.log('  · ' + f));
  console.log('  (wire it into package.json as test:<name>, or add it to scripts/test-all.mjs)');
  /* Deliberately NOT a --strict failure: a file someone is still writing
     must not block other people's pushes, and claiming a suite for the
     manifest is its author's call. It is reported every run until then. */
}

/* Leave on purpose: the verdict is final and a stray child process must
   never hold the gate open after it. See the same note at the end of
   scripts/test-site-audit.mjs for why a browser suite can do that. */
const slowDeltas = deltas.filter(d => d.verdict.state === 'slow').length;
/* the escalation is not a --timing=strict option: it is what the default
   warning mode does when the same regression keeps coming back, which is the
   only case where a number that moves with the machine is evidence. */
const failing = failed.length + (strict ? skipped.length : 0) +
  (timingMode === 'strict' ? slow.length + (gate.state === 'slow' ? 1 : 0) + slowDeltas : 0) +
  (escalated ? 1 : 0);
setTimeout(() => process.exit(failing ? 1 : 0), 250);
