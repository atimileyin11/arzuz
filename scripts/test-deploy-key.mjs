#!/usr/bin/env node
/* ============================================================
   Arzuz — proof that the deploy gate is a gate

   scripts/require-service-key.mjs exists to stop a deploy that could
   not keep the site's promises from reaching anybody: forms that take
   nothing, a status code that is issued and never delivered, notices
   that are recorded as unsent. Four ways that intention can fail
   without anyone noticing:

     · the check is wrong        — it passes on an empty value, or
                                   fails on a value of only whitespace,
                                   or mistakes an ADVISED variable for
                                   a required one
     · an override is too wide   — `=0` reads as "allow", or naming one
                                   variable excuses the rest
     · it is not wired           — a perfect check that no BUILD runs
                                   is a comment, not a gate
     · it leaks                  — a build log is read by more people
                                   than the Netlify dashboard is, and
                                   it outlives the deploy

   So this drives all four: the decision itself for every shape of
   every variable, the real CLI exit codes, both overrides including
   the legacy one, and netlify.toml's build command parsed from the
   file. The last one is the pairing — the same trick
   dev/run-tests.mjs and dev/sql-guard-test.mjs use on their lists, and
   for the same reason: the wiring and the check cannot drift apart.

   It does NOT read the network, the real Netlify environment, or any
   secret. Every environment it tests is one it builds itself.

   Run from arzuz-site/:
     node scripts/test-deploy-key.mjs
   ============================================================ */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkEnv, readEnv, allowedMissing, overrideSet,
  REQUIRED, ADVISED, KEY_NAME, OVERRIDE_NAME, LEGACY_OVERRIDE_NAME }
  from './require-service-key.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASS = [];
const FAIL = [];
const check = (name, ok, note) => (ok ? PASS : FAIL).push(name + (ok || !note ? '' : '  ::  ' + note));

/* Key-shaped strings nobody could mistake for real ones, so "did it
   print the value?" is answerable by looking for them. */
const FAKE_KEY = 'sb_secret_TESTONLY_do_not_log_6f2b';
const FAKE_WA = { OPENWA_URL: 'https://openwa.testonly.invalid', OPENWA_API_KEY: 'owa_TESTONLY_9c41df' };

/* Every REQUIRED variable set: the "this deploy is fine" environment. */
function full(extra) {
  const env = Object.assign({}, FAKE_WA, { [KEY_NAME]: FAKE_KEY });
  return Object.assign(env, extra || {});
}

/* Everything stripped: the environment this file's own variable list is
   about. Inherited env alone would make the result depend on the
   machine the suite runs on. */
function empty() {
  const env = Object.assign({}, process.env);
  REQUIRED.concat(ADVISED).forEach((v) => { delete env[v.name]; });
  delete env[OVERRIDE_NAME];
  delete env[LEGACY_OVERRIDE_NAME];
  return env;
}

/* ---------------- 1. the decision ---------------- */

check('the variable the door reads is on the list under the name the door reads',
  REQUIRED.some((v) => v.name === KEY_NAME) && readEnv({ [KEY_NAME]: FAKE_KEY }, KEY_NAME).present === true &&
  readEnv({ [KEY_NAME]: ' ' }, KEY_NAME).present === false);

check('a value of nothing, "", or "   " is the MISSING case — a half-finished dashboard edit is not a key',
  readEnv({ X: undefined }, 'X').present === false && readEnv({ X: '' }, 'X').present === false &&
  readEnv({ X: '   \t ' }, 'X').present === false);

check('a value that is there is the present case, and its LENGTH is all that is reported',
  (() => {
    const r = readEnv({ X: FAKE_KEY }, 'X');
    return r.present === true && r.length === FAKE_KEY.length;
  })());

check('the required list is more than the service key, and the WhatsApp sender is on it',
  REQUIRED.length >= 3 && REQUIRED.some((v) => v.name === 'OPENWA_URL') &&
  REQUIRED.some((v) => v.name === 'OPENWA_API_KEY'),
  'required list is: ' + REQUIRED.map((v) => v.name).join(', '));

check('every required variable carries a reason a person can ACT on, not just a name',
  REQUIRED.every((v) => typeof v.why === 'string' && v.why.length > 60),
  'a bare name in a build failure is a puzzle, which is how a gate gets overridden instead of fixed');

check('a full environment passes, in --require mode', checkEnv(full(), { require: true }).exit === 0);

check('in --require mode, a missing service key is a build FAILURE',
  checkEnv(empty(), { require: true }).exit === 1);

check('and so is a missing WhatsApp credential — the status code cannot be delivered without it',
  checkEnv(full({ OPENWA_URL: '' }), { require: true }).exit === 1 &&
  checkEnv(full({ OPENWA_API_KEY: '   ' }), { require: true }).exit === 1);

check('the failure names EVERY variable that is missing, not just the first',
  (() => {
    const out = checkEnv(empty(), { require: true });
    return out.blocking.length === REQUIRED.length &&
      REQUIRED.every((v) => out.message.indexOf(v.name) !== -1);
  })());

check('and it says what each one BREAKS, because that is the part a person acts on',
  (() => {
    const out = checkEnv(empty(), { require: true });
    return /never delivered/.test(out.message) && /not-ready/.test(out.message);
  })());

check('the failure names both causes, because the build cannot tell them apart',
  (() => {
    const msg = checkEnv(empty(), { require: true }).message;
    return /not been set/.test(msg) && /scoped to "Functions" only/.test(msg);
  })());

check('the failure names the file that closed the fallback, so the reason is not folklore',
  /supabase-close-public-inserts\.sql/.test(checkEnv(empty(), { require: true }).message));

check('in report mode a missing variable is NOT a red gate, so a local run is not a failure',
  checkEnv(empty(), { require: false }).exit === 0);

check('an ADVISED variable never fails the build — a gate that fails on a preference gets overridden',
  (() => {
    const out = checkEnv(full(), { require: true });
    return out.exit === 0 && out.advised.indexOf('RESEND_API_KEY') !== -1 && out.ok === true;
  })());

check('…but it IS printed, with the sentence that says what is quieter without it',
  (() => {
    const msg = checkEnv(full(), { require: true }).message;
    return /WARNING: RESEND_API_KEY is not set/.test(msg) && /SECOND channel/.test(msg);
  })());

check('an advised variable that IS set is not warned about',
  (() => {
    const out = checkEnv(full({ RESEND_API_KEY: 're_test_only', OPENWA_SESSION: 'ARZUZ' }), { require: true });
    return out.advised.length === 0 && /WARNING/.test(out.message) === false;
  })());

/* ---------------- 2. the overrides, and how narrow they are ---------------- */

check('the override is only 1 or true — "0", "no" and "false" do not count',
  overrideSet({ [OVERRIDE_NAME]: '1' }) === true &&
  overrideSet({ [OVERRIDE_NAME]: 'TRUE' }) === true &&
  overrideSet({ [OVERRIDE_NAME]: '0' }) === false &&
  overrideSet({ [OVERRIDE_NAME]: 'no' }) === false &&
  overrideSet({}) === false);

check('naming ONE variable excuses exactly that one, and nothing else',
  (() => {
    const out = checkEnv(empty(), { require: true, });
    const named = checkEnv(Object.assign(empty(), { [OVERRIDE_NAME]: 'OPENWA_URL' }), { require: true });
    return out.exit === 1 && named.exit === 1 &&
      named.excused.indexOf('OPENWA_URL') !== -1 &&
      named.blocking.indexOf('OPENWA_API_KEY') !== -1 &&
      named.blocking.indexOf(KEY_NAME) !== -1;
  })());

check('a name that is not on the required list excuses nothing, so a typo cannot open the gate',
  (() => {
    const a = allowedMissing({ [OVERRIDE_NAME]: 'OPENWA_URLL' });
    const out = checkEnv(Object.assign(empty(), { [OVERRIDE_NAME]: 'OPENWA_URLL' }), { require: true });
    return a.names.size === 0 && a.all === false && out.exit === 1;
  })());

check('=1 allows the whole list, and the build passes — LOUDLY',
  (() => {
    const out = checkEnv(Object.assign(empty(), { [OVERRIDE_NAME]: '1' }), { require: true });
    return out.exit === 0 && out.override === true && /WARNING/.test(out.message) &&
      /proceeding anyway/.test(out.message);
  })());

check('…and the warning says what the visitor will experience, not just which variable is absent',
  (() => {
    const msg = checkEnv(Object.assign(empty(), { [OVERRIDE_NAME]: '1' }), { require: true }).message;
    return /fail SILENTLY/.test(msg);
  })());

check('the LEGACY override still works, and still means only the service key',
  (() => {
    const key = { [LEGACY_OVERRIDE_NAME]: '1' };
    const out = checkEnv(Object.assign(empty(), key), { require: true });
    return out.excused.length === 1 && out.excused[0] === KEY_NAME && out.exit === 1 &&
      out.blocking.indexOf('OPENWA_URL') !== -1;
  })());

check('the legacy override is not a way to excuse a WhatsApp credential',
  checkEnv(Object.assign(full({ OPENWA_URL: '' }), { [LEGACY_OVERRIDE_NAME]: '1' }), { require: true }).exit === 1);

/* ---------------- 3. the CLI, with real exit codes ---------------- */

const SCRIPT = join(SITE, 'scripts', 'require-service-key.mjs');

/* A controlled environment: everything the parent has, minus every
   variable this file is about, plus whatever the case adds. */
function run(args, extra) {
  const env = empty();
  Object.assign(env, extra || {});
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8', env });
}

const noKey = run(['--require'], {});
check('the CLI exits 1 on a deploy with nothing set', noKey.status === 1,
  'exit was ' + noKey.status + ': ' + noKey.stdout + noKey.stderr);
check('and says it on stderr, where the build log puts the red line',
  noKey.stderr.indexOf('[deploy-key]') !== -1 && noKey.stdout.trim() === '',
  'stdout: ' + JSON.stringify(noKey.stdout) + ' stderr: ' + JSON.stringify(noKey.stderr.slice(0, 80)));

const withKey = run(['--require'], full());
check('the CLI exits 0 when the required set is there', withKey.status === 0,
  'exit was ' + withKey.status + ': ' + withKey.stdout + withKey.stderr);

check('AND IT NEVER PRINTS A VALUE — a build log outlives the deploy',
  withKey.stdout.indexOf(FAKE_KEY) === -1 && withKey.stderr.indexOf(FAKE_KEY) === -1 &&
  withKey.stdout.indexOf(FAKE_WA.OPENWA_API_KEY) === -1 && withKey.stderr.indexOf(FAKE_WA.OPENWA_API_KEY) === -1,
  'a value appeared in its output');

check('nor does it print one length-sliced, on any path',
  [noKey, withKey,
    run([], full()),
    run(['--require'], Object.assign(full(), { [OVERRIDE_NAME]: '1' })),
    run(['--require'], full({ OPENWA_URL: '' }))]
    .every((r) => (r.stdout + r.stderr).indexOf(FAKE_KEY.slice(0, 12)) === -1 &&
      (r.stdout + r.stderr).indexOf(FAKE_WA.OPENWA_API_KEY.slice(0, 12)) === -1),
  'a prefix of a value reached the output');

check('the report says whether each required variable is set and how long it is',
  withKey.stdout.indexOf(KEY_NAME) !== -1 && withKey.stdout.indexOf(String(FAKE_KEY.length)) !== -1,
  'the log does not confirm what it found: ' + withKey.stdout.slice(0, 200));

check('a WhatsApp credential missing is a red build on its own',
  run(['--require'], full({ OPENWA_API_KEY: '' })).status === 1);

check('the override exits 0 and warns, rather than passing quietly',
  (() => {
    const r = run(['--require'], { [OVERRIDE_NAME]: '1' });
    return r.status === 0 && /WARNING/.test(r.stdout);
  })());

check('report mode (no --require) never fails a local run',
  run([], {}).status === 0);

/* ---------------- 4. the wiring — a check no deploy runs is a comment ---------------- */

const toml = readFileSync(join(SITE, 'netlify.toml'), 'utf8');
const buildBlock = (toml.split('[build]')[1] || '').split('\n[')[0];
const command = (buildBlock.match(/^\s*command\s*=\s*"([^"]+)"/m) || [])[1];

check('netlify.toml has a [build] command at all', !!command,
  'with no command, this check runs nowhere and the gate is decorative');

check('and the command RUNS this checker, in --require mode',
  !!command && command.indexOf('require-service-key.mjs') !== -1 && command.indexOf('--require') !== -1,
  'the build command is: ' + command);

check('the build still publishes the repo root — the gate must not change what ships',
  /publish\s*=\s*"\./.test(buildBlock),
  'a missing publish would send Netlify looking for a build output directory');

check('no override is baked into the build command itself',
  !!command && command.indexOf(OVERRIDE_NAME) === -1 &&
  command.indexOf(LEGACY_OVERRIDE_NAME) === -1 && command.indexOf('ALLOW_MISSING') === -1,
  'the build command ships with the escape hatch already open');

check('and the build comment explains the whole set, not just the key it used to check',
  /OPENWA/.test(buildBlock) && /RESEND/.test(buildBlock),
  'the config a person reads when the build goes red does not mention the variables that are on the list');

/* ---------------- report ---------------- */

if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
}
console.log('deploy-key gate \u2014 PASS ' + PASS.length + ' \u00b7 FAIL ' + FAIL.length);
process.exit(FAIL.length ? 1 : 0);
