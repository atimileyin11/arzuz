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

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkEnv, readEnv, allowedMissing, overrideSet, probeServiceKey, classifyAnswer,
  probeSender, probeEmail, probePaystack, probeTelegram,
  classifySenderAnswer, classifyEmailAnswer, classifyPaystackAnswer, classifyTelegramAnswer,
  senderUrl, sessionFound,
  OPENWA_PROBE_PATH, RESEND_PROBE_URL_ENV, PAYSTACK_PROBE_URL_ENV, TELEGRAM_ORIGIN_ENV,
  projectUrl, tamperKey, PROBE_PATH, SUPABASE_URL_FALLBACK,
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
const FAKE_MAIL_KEY = 're_TESTONLY_do_not_log_77c1';
const FAKE_PAYSTACK = 'sk_test_TESTONLY_do_not_log_3e8a';
const FAKE_TG = '900000001:AAF_TESTONLY_do_not_log_5b7c';
const FAKE_CHAT = '-1001234567890';

/* Every REQUIRED variable set: the "this deploy is fine" environment. */
function full(extra) {
  const env = Object.assign({}, FAKE_WA, { [KEY_NAME]: FAKE_KEY });
  return Object.assign(env, extra || {});
}

/* ------------------------------------------------------------
   A POSTGREST THAT ANSWERS THE WAY THE REAL ONE DOES

   The gate now TRIES the value, so this suite needs a project. This
   one knows exactly one key: anything else is 401 "Invalid API key",
   which is the sentence the live project gave while the deploy's key
   was stale. Two modes, because the probe has to be provably able to
   fail: `blind` answers 200 to everything, which is what a publicly
   readable relation looks like from here, and a probe that reports a
   green on that has proved nothing.

   Local, and no credentials: the value being tried is a test string.
   ------------------------------------------------------------ */

/* A SEPARATE PROCESS, not a server in this one: some of these cases run
   the CLI with spawnSync, which blocks this process's event loop — and a
   stand-in living here would go silent exactly while the child is asking
   it. Learned by watching the child time out against a server that was
   up the whole time. */
/* One process answers all three providers the way the real ones do —
   PostgREST, OpenWA and Resend — because every CLI case below drives all
   three probes now. The paths are the real paths (`/api/sessions`,
   `/emails`) so the code under test is not given a friendlier world than
   production. */
const STANDIN_SRC = (mode) => `
const http = require('node:http');
const KNOWN = process.env.STANDIN_KEY;
const KNOWN_WA = process.env.STANDIN_WA_KEY;
const KNOWN_MAIL = process.env.STANDIN_MAIL_KEY;
const KNOWN_PAYSTACK = process.env.STANDIN_PAYSTACK_KEY;
const KNOWN_TG = process.env.STANDIN_TG_TOKEN;
const KNOWN_CHAT = process.env.STANDIN_TG_CHAT;
const BLIND = ${JSON.stringify(mode === 'blind')};
const BLIND_WA = ${JSON.stringify(mode === 'blindWa')};
const BLIND_MAIL = ${JSON.stringify(mode === 'blindMail')};
const BLIND_PAYSTACK = ${JSON.stringify(mode === 'blindPaystack')};
const BLIND_TG = ${JSON.stringify(mode === 'blindTg')};
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const s = http.createServer((req, res) => {
  if (req.url === '/balance') {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\\s+/i, '');
    if (BLIND_PAYSTACK || auth === KNOWN_PAYSTACK) return json(res, 200, { status: true, data: [{ currency: 'NGN', balance: 0 }] });
    return json(res, 401, { status: false, message: 'Invalid key', code: 'invalid_Key' });
  }
  if (req.url.indexOf('/bot') === 0) {
    const rest = req.url.slice(4);
    const slice = rest.indexOf('/');
    const token = slice === -1 ? rest : rest.slice(0, slice);
    const path = slice === -1 ? '' : rest.slice(slice);
    if (BLIND_TG) {
      if (path.indexOf('/getMe') === 0) return json(res, 200, { ok: true, result: { id: 1, username: 'standin_bot' } });
      return json(res, 200, { ok: true, result: { id: KNOWN_CHAT } });
    }
    if (token !== KNOWN_TG) {
      if (token.indexOf(':') === -1) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    if (path.indexOf('/getMe') === 0) return json(res, 200, { ok: true, result: { id: 900000001, username: 'standin_bot' } });
    if (path.indexOf('/getChat') === 0) {
      const m = /[?&]chat_id=([^&]+)/.exec(path);
      const chat = m ? decodeURIComponent(m[1]) : '';
      if (chat === KNOWN_CHAT) return json(res, 200, { ok: true, result: { id: KNOWN_CHAT, type: 'channel' } });
      return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    }
    return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  }
  if (req.url === '/api/sessions') {
    const wa = String(req.headers['x-api-key'] || '');
    if (BLIND_WA || wa === KNOWN_WA) {
      return json(res, 200, [{ id: 'a17024f9-848a-47bc-8808-f0cc359ac2ad', name: 'ARZUZ', status: 'ready' }]);
    }
    return json(res, 401, { message: 'Invalid API key' });
  }
  if (req.url === '/emails') {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\\s+/i, '');
    if (BLIND_MAIL) return json(res, 422, { name: 'validation_error', message: 'Missing from field' });
    if (auth === KNOWN_MAIL) return json(res, 422, { name: 'validation_error', message: 'Missing from field' });
    return json(res, 401, { message: 'API key is invalid' });
  }
  const key = String(req.headers.apikey || '').replace(/^Bearer\\s+/i, '');
  if (BLIND || key === KNOWN) return json(res, 200, [{ key: 'care_pass_price_kobo' }]);
  json(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase anon or service_role API key.' });
});
s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));
`;

function startStandin(mode) {
  const child = spawn(process.execPath, ['-e', STANDIN_SRC(mode)], {
    env: Object.assign({}, process.env, {
      STANDIN_KEY: FAKE_KEY,
      STANDIN_WA_KEY: FAKE_WA.OPENWA_API_KEY,
      STANDIN_MAIL_KEY: FAKE_MAIL_KEY,
      STANDIN_PAYSTACK_KEY: FAKE_PAYSTACK,
      STANDIN_TG_TOKEN: FAKE_TG,
      STANDIN_TG_CHAT: FAKE_CHAT,
    }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const m = /PORT (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', () => reject(new Error('the stand-in exited before it listened')));
  });
  return port.then((p) => ({ child: child, url: 'http://127.0.0.1:' + p }));
}

const standin = await startStandin('real');
const blindStandin = await startStandin('blind');
const blindWa = await startStandin('blindWa');
const blindMail = await startStandin('blindMail');
const blindPaystack = await startStandin('blindPaystack');
const blindTg = await startStandin('blindTg');
/* A port nothing is listening on, for the one case that must not be
   mistaken for a verdict about the value. */
const DEAD = 'http://127.0.0.1:1';

/* Everything stripped: the environment this file's own variable list is
   about. Inherited env alone would make the result depend on the
   machine the suite runs on. */
function empty() {
  const env = Object.assign({}, process.env);
  REQUIRED.concat(ADVISED).forEach((v) => { delete env[v.name]; });
  delete env[OVERRIDE_NAME];
  delete env[LEGACY_OVERRIDE_NAME];
  /* The project the probe talks to. Deleted so a machine that happens to
     export one cannot decide what this suite proves — every case that
     should reach a project gets the stand-in below, explicitly. */
  delete env.SUPABASE_URL;
  delete env.SUPABASE_URL_KEY;
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
    const out = checkEnv(full({
      RESEND_API_KEY: 're_test_only', OPENWA_SESSION: 'ARZUZ',
      PAYSTACK_SECRET_KEY: FAKE_PAYSTACK, TELEGRAM_BOT_TOKEN: FAKE_TG, TELEGRAM_CHAT_ID: FAKE_CHAT,
    }), { require: true });
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
  /* Every CLI case gets the stand-in as its project, so the real one is
     never called from a test — and the value it is handed is still the
     test string, never a credential. */
  env.SUPABASE_URL = standin.url;
  Object.assign(env, extra || {});
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8', env });
}

/* Every provider pointed at the same stand-in: the three-probe CLI path,
   with no real network and no credential. What each case wants to differ
   it passes over the top. */
function runLive(args, extra) {
  return run(args, Object.assign({
    [KEY_NAME]: FAKE_KEY,
    OPENWA_URL: standin.url,
    OPENWA_API_KEY: FAKE_WA.OPENWA_API_KEY,
    OPENWA_SESSION: 'ARZUZ',
    RESEND_API_KEY: FAKE_MAIL_KEY,
    [RESEND_PROBE_URL_ENV]: standin.url + '/emails',
    PAYSTACK_SECRET_KEY: FAKE_PAYSTACK,
    [PAYSTACK_PROBE_URL_ENV]: standin.url + '/balance',
    TELEGRAM_BOT_TOKEN: FAKE_TG,
    TELEGRAM_CHAT_ID: FAKE_CHAT,
    [TELEGRAM_ORIGIN_ENV]: standin.url,
  }, extra || {}));
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

/* ---------------- 5. the VALUE, not just the name ----------------

   A rotated key is SET. The build used to pass, the deploy shipped,
   and every door answered "we are not switched on yet" to people who
   could not fix it. So the gate now tries the value against the
   project — and these are the readings that decide whether the deploy
   publishes, including the one where the probe cannot tell a good key
   from a bad one and must therefore say so instead of going green. */

check('401 and 403 are the project REFUSING the value; below 500 means it read the request',
  classifyAnswer(401) === 'refused' && classifyAnswer(403) === 'refused' &&
  classifyAnswer(200) === 'accepted' && classifyAnswer(404) === 'accepted' &&
  classifyAnswer(400) === 'accepted' && classifyAnswer(500) === 'unknown' &&
  classifyAnswer(503) === 'unknown');

check('the gate tries the project the FUNCTIONS use, fallback and all',
  projectUrl({}) === SUPABASE_URL_FALLBACK &&
  projectUrl({ SUPABASE_URL: 'https://x.supabase.co//' }) === 'https://x.supabase.co' &&
  projectUrl({ SUPABASE_URL_KEY: 'https://y.supabase.co' }) === 'https://y.supabase.co' &&
  projectUrl({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_URL_KEY: 'https://y.supabase.co' }) === 'https://x.supabase.co');

check('the tampered copy is the same LENGTH and shape, so a 401 answers the credential and not an empty header',
  tamperKey(FAKE_KEY) !== FAKE_KEY && tamperKey(FAKE_KEY).length === FAKE_KEY.length &&
  tamperKey('abc')[0] === 'b' && tamperKey('') === 'x');

const liveAccepted = await probeServiceKey({ url: standin.url, key: FAKE_KEY });
check('a value the project accepts is ACCEPTED — and the tampered copy was refused, so the green is not vacuous',
  liveAccepted.state === 'accepted' && liveAccepted.status === 200 &&
  liveAccepted.host === standin.url.replace(/^https?:\/\//, ''),
  JSON.stringify(liveAccepted));

const liveRefusedProbe = await probeServiceKey({ url: standin.url, key: 'sb_secret_TESTONLY_wrong_9f1c' });
check('a value the project refuses is REFUSED, with the status that says so',
  liveRefusedProbe.state === 'refused' && liveRefusedProbe.status === 401, JSON.stringify(liveRefusedProbe));

const liveBlind = await probeServiceKey({ url: blindStandin.url, key: 'sb_secret_TESTONLY_other_2c7d' });
check('a project that accepts a TAMPERED key is BLIND, not green — the probe says it cannot see',
  liveBlind.state === 'blind' && /proved nothing/.test(liveBlind.message), JSON.stringify(liveBlind));

const liveDead = await probeServiceKey({ url: DEAD, key: FAKE_KEY });
check('a project that does not answer is UNREACHABLE, never "refused" — the two need different repairs',
  liveDead.state === 'unreachable', JSON.stringify(liveDead));

check('with no value to try there is no request at all, and no verdict',
  (await probeServiceKey({ url: standin.url, key: '' })).state === 'unchecked');

const outRefused = checkEnv(full(), { require: true, live: liveRefusedProbe });
check('in --require mode a REFUSED key is a build FAILURE, exactly like a missing one',
  outRefused.exit === 1 && outRefused.ok === false && outRefused.live === 'refused' &&
  outRefused.blocking.indexOf(KEY_NAME) !== -1);

check('and the report says the variable is SET, so nobody goes hunting for a variable to add',
  /DOES NOT WORK/.test(outRefused.message) && /It is SET/.test(outRefused.message) && outRefused.missing.indexOf(KEY_NAME) === -1);

check('it names all three causes, in the order they happen',
  /ROTATED in Supabase/.test(outRefused.message) && /anon\/publishable key was pasted/.test(outRefused.message) &&
  /SUPABASE_URL points at another project/.test(outRefused.message));

check('report mode still reports the refusal without failing a local run',
  checkEnv(full(), { require: false, live: liveRefusedProbe }).exit === 0 &&
  checkEnv(full(), { require: false, live: liveRefusedProbe }).ok === false);

check('an excused key is not blocked by a refusal — the one documented hatch still opens, loudly',
  checkEnv(full({ [OVERRIDE_NAME]: KEY_NAME }), { require: true, live: liveRefusedProbe }).exit === 0);

const outAccepted = checkEnv(full(), { require: true, live: liveAccepted });
check('an ACCEPTED value is printed as ok and blocks nothing',
  outAccepted.exit === 0 && outAccepted.live === 'accepted' &&
  /is one 127\.0\.0\.1:\d+ accepts/.test(outAccepted.message));

const outDead = checkEnv(full(), { require: true, live: liveDead });
check('a project that cannot be reached WARNS but does not block — a Supabase blip must not stop a hotfix',
  outDead.exit === 0 && /was not proved/.test(outDead.message));

const outBlind = checkEnv(full(), { require: true, live: liveBlind });
check('a BLIND probe is a loud warning about the relation, and still not a verdict about the key',
  outBlind.exit === 0 && /leak to fix/.test(outBlind.message));

check('no live path prints the value — including the one that was refused',
  [outRefused.message, outAccepted.message, outDead.message, outBlind.message, liveBlind.message]
    .every((m) => m.indexOf(FAKE_KEY) === -1 && m.indexOf('TESTONLY') === -1),
  'a value reached the report');

const cliAccepted = run(['--require'], full());
check('the CLI passes a deploy whose value the project accepts', cliAccepted.status === 0,
  'exit was ' + cliAccepted.status + ': ' + cliAccepted.stderr.slice(0, 300));

check('and says which project tried it, without printing what it tried',
  / accepts \(HTTP 200/.test(cliAccepted.stdout) && cliAccepted.stdout.indexOf(FAKE_KEY) === -1,
  'stdout: ' + cliAccepted.stdout.slice(0, 300));

const ROTATED = 'sb_secret_TESTONLY_refused_by_the_project';
const cliRefused = run(['--require'], full({ [KEY_NAME]: ROTATED }));
check('the CLI FAILS the build when the project refuses the value it was handed', cliRefused.status === 1,
  'exit was ' + cliRefused.status + ': ' + cliRefused.stdout.slice(0, 200));

check('and the failure names the three causes, not just the word "invalid"',
  /ROTATED in Supabase/.test(cliRefused.stderr) && /anon\/publishable key was pasted/.test(cliRefused.stderr) &&
  /SUPABASE_URL points at another project/.test(cliRefused.stderr),
  'stderr: ' + cliRefused.stderr.slice(0, 300));

check('the refused value itself never reaches the build log, on any path',
  (cliRefused.stdout + cliRefused.stderr).indexOf(ROTATED) === -1 &&
  (cliRefused.stdout + cliRefused.stderr).indexOf(ROTATED.slice(0, 12)) === -1);

/* ---------------- 6. the OTHER two credentials, tried the same way ---------------- */

check('401 is a refused sender key; 403 is the key FOUND and the address refused; a 404 is not a verdict',
  classifySenderAnswer(401) === 'refused' && classifySenderAnswer(403) === 'forbidden' &&
  classifySenderAnswer(200) === 'accepted' && classifySenderAnswer(404) === 'accepted' &&
  classifySenderAnswer(503) === 'unknown');

check('for email, 401 is refused, 403 is not a verdict about the value, and a 4xx about the empty body is a READ',
  classifyEmailAnswer(401) === 'refused' && classifyEmailAnswer(403) === 'unknown' &&
  classifyEmailAnswer(422) === 'accepted' && classifyEmailAnswer(400) === 'accepted' &&
  classifyEmailAnswer(500) === 'unknown');

check('the sender is tried at the route the send path goes through, and the env URL is normalised',
  OPENWA_PROBE_PATH === '/api/sessions' &&
  senderUrl({ OPENWA_URL: 'https://wa.example.com//' }) === 'https://wa.example.com' &&
  senderUrl({}) === '');

const waAccepted = await probeSender({ url: standin.url, key: FAKE_WA.OPENWA_API_KEY, session: 'ARZUZ' });
check('a sender that accepts the key is ACCEPTED — tampered copy refused, and the session found by NAME',
  waAccepted.state === 'accepted' && waAccepted.status === 200 && waAccepted.sessionFound === true,
  JSON.stringify(waAccepted));

check('…and by its uuid, because OPENWA_SESSION may hold either',
  (await probeSender({ url: standin.url, key: FAKE_WA.OPENWA_API_KEY,
    session: 'a17024f9-848a-47bc-8808-f0cc359ac2ad' })).sessionFound === true &&
  sessionFound([{ id: 'X', name: 'Arzuz' }], 'arzuz') === true &&
  sessionFound(null, 'ARZUZ') === null);

const waWrongSession = await probeSender({ url: standin.url, key: FAKE_WA.OPENWA_API_KEY, session: 'WAITLIST' });
check('a session the server does not list is found:false — the silent failure a key check cannot see',
  waWrongSession.state === 'accepted' && waWrongSession.sessionFound === false);

const waRefused = await probeSender({ url: standin.url, key: 'owa_TESTONLY_wrong_4d2e' });
check('a sender key the server does not know is REFUSED, with the status that says so',
  waRefused.state === 'refused' && waRefused.status === 401, JSON.stringify(waRefused));

const waBlind = await probeSender({ url: blindWa.url, key: FAKE_WA.OPENWA_API_KEY });
check('a sender that answers a TAMPERED key with 200 is BLIND, not green — the probe says it cannot see',
  waBlind.state === 'blind' && /proved nothing/.test(waBlind.message), JSON.stringify(waBlind));

check('an unreachable sender is UNREACHABLE, never "refused", and no value is asked about',
  (await probeSender({ url: DEAD, key: FAKE_WA.OPENWA_API_KEY })).state === 'unreachable' &&
  (await probeSender({ url: standin.url, key: '' })).state === 'unchecked');

const mailAccepted = await probeEmail({ url: standin.url + '/emails', key: FAKE_MAIL_KEY });
check('an email key Resend READS is accepted — a 422 about the empty body is the proof, and no mail left',
  mailAccepted.state === 'accepted' && mailAccepted.status === 422, JSON.stringify(mailAccepted));

const mailRefused = await probeEmail({ url: standin.url + '/emails', key: 're_TESTONLY_wrong_5a9b' });
check('an email key Resend refuses is REFUSED, with 401',
  mailRefused.state === 'refused' && mailRefused.status === 401, JSON.stringify(mailRefused));

const mailBlind = await probeEmail({ url: blindMail.url + '/emails', key: FAKE_MAIL_KEY });
check('a mail route that answers a TAMPERED key with 422 is BLIND, not green',
  mailBlind.state === 'blind' && /proved nothing/.test(mailBlind.message), JSON.stringify(mailBlind));

check('an unreachable mail provider is UNREACHABLE, and a missing key makes no request at all',
  (await probeEmail({ url: DEAD, key: FAKE_MAIL_KEY })).state === 'unreachable' &&
  (await probeEmail({ key: '' })).state === 'unchecked');

const outWaRefused = checkEnv(full(), { require: true, liveSender: waRefused });
check('in --require mode a REFUSED sender key is a build FAILURE, exactly like a missing one',
  outWaRefused.exit === 1 && outWaRefused.liveSender === 'refused' &&
  outWaRefused.blocking.indexOf('OPENWA_API_KEY') !== -1, JSON.stringify(outWaRefused.blocking));

check('and the report says the variable is SET and what goes quiet, not just "invalid"',
  /DOES NOT KNOW THE KEY/.test(outWaRefused.message) &&
  /It is SET/.test(outWaRefused.message) &&
  /recorded as unsent/.test(outWaRefused.message));

check('it names all three causes of a refused sender key, in the order they happen',
  /ROTATED or revoked on the OpenWA server/.test(outWaRefused.message) &&
  /OPENWA_URL points at a different OpenWA instance/.test(outWaRefused.message) &&
  /restricted to roles or sessions/.test(outWaRefused.message));

check('a sender key EXCUSED by name does not block — the documented hatch still opens, loudly',
  checkEnv(full({ [OVERRIDE_NAME]: 'OPENWA_API_KEY' }), { require: true, liveSender: waRefused }).exit === 0);

const envMail = full({ RESEND_API_KEY: FAKE_MAIL_KEY });
const outMailRefused = checkEnv(envMail, { require: true, liveEmail: mailRefused });
check('a REFUSED email key fails the build too, even though its ABSENCE is only advised',
  outMailRefused.exit === 1 && outMailRefused.liveEmail === 'refused' &&
  outMailRefused.blocking.indexOf('RESEND_API_KEY') !== -1);

check('and it says the KEY is set — a bad value must not send anyone looking for a variable to add',
  /THE EMAIL KEY/.test(outMailRefused.message) && /It is SET/.test(outMailRefused.message) &&
  outMailRefused.missing.indexOf('RESEND_API_KEY') === -1);

check('it names the two causes of a refused email key',
  /ROTATED or revoked in Resend/.test(outMailRefused.message) &&
  /a different Resend team or account/.test(outMailRefused.message));

check('naming RESEND_API_KEY in the override excuses its refusal, so the hatch the report prints is real',
  checkEnv(Object.assign({}, envMail, { [OVERRIDE_NAME]: 'RESEND_API_KEY' }),
    { require: true, liveEmail: mailRefused }).exit === 0);

check('report mode still reports both refusals without failing a local run',
  checkEnv(full({ RESEND_API_KEY: FAKE_MAIL_KEY }),
    { require: false, liveSender: waRefused, liveEmail: mailRefused }).exit === 0);

const outForbidden = checkEnv(full(), {
  require: true,
  liveSender: { state: 'forbidden', status: 403, host: 'wa.example.com',
    message: 'the sender knows this key but refused this ADDRESS (HTTP 403)' },
});
check('a 403 WARNs and does not block: the build and the functions do not share an address',
  outForbidden.exit === 0 && /refused this ADDRESS/.test(outForbidden.message) &&
  /not blocked/.test(outForbidden.message));

const outWaDead = checkEnv(full(), { require: true, liveSender: { state: 'unreachable', message: 'the sender did not answer: ECONNREFUSED' } });
check('an unreachable sender WARNS and does not stop a hotfix',
  outWaDead.exit === 0 && /OPENWA_API_KEY was NOT proved/.test(outWaDead.message));

const outSession = checkEnv(full({ OPENWA_SESSION: 'WAITLIST' }), { require: true, liveSender: waWrongSession });
check('a session name the server does not have WARNS by name — every message would still be refused',
  outSession.exit === 0 && /does not list it/.test(outSession.message) &&
  /OPENWA_SESSION names "WAITLIST"/.test(outSession.message) &&
  /issued and never delivered/.test(outSession.message));

check('a BLIND sender is a loud warning and not a verdict about the key',
  checkEnv(full(), { require: true, liveSender: waBlind }).exit === 0 &&
  /did not check the credential/.test(checkEnv(full(), { require: true, liveSender: waBlind }).message));

check('an unreadable mail answer WARNS rather than blocking',
  checkEnv(envMail, { require: true, liveEmail: { state: 'unknown', status: 403, message: 'Resend read the credential and answered HTTP 403' } })
    .exit === 0);

const cliAll = runLive(['--require'], {});
check('the CLI passes a deploy whose three credentials all work', cliAll.status === 0,
  'exit was ' + cliAll.status + ': ' + cliAll.stderr.slice(0, 300));

check('and names every provider it proved, the chat and the session',
  /OPENWA_API_KEY is one 127\.0\.0\.1:\d+ accepts \(HTTP 200/.test(cliAll.stdout) &&
  /RESEND_API_KEY is one 127\.0\.0\.1:\d+ accepts \(HTTP 422/.test(cliAll.stdout) &&
  /PAYSTACK_SECRET_KEY is one api\.paystack\.co accepts \(HTTP 200/.test(cliAll.stdout) &&
  /TELEGRAM_BOT_TOKEN is one Telegram accepts \(HTTP 200/.test(cliAll.stdout) &&
  /TELEGRAM_CHAT_ID is a chat that bot can see/.test(cliAll.stdout) &&
  /OPENWA_SESSION "ARZUZ" is a session that server lists/.test(cliAll.stdout),
  'stdout: ' + cliAll.stdout.slice(0, 600));

const cliWaBad = runLive(['--require'], { OPENWA_API_KEY: 'owa_TESTONLY_refused_by_sender' });
check('the CLI FAILS the build when the sender refuses the key it was handed', cliWaBad.status === 1,
  'exit was ' + cliWaBad.status + ': ' + cliWaBad.stdout.slice(0, 200));
check('and the failure names the cause a person can act on',
  /THE WHATSAPP SENDER/.test(cliWaBad.stderr) && /ROTATED or revoked/.test(cliWaBad.stderr));

const cliMailBad = runLive(['--require'], { RESEND_API_KEY: 're_TESTONLY_refused_by_provider' });
check('the CLI FAILS the build when Resend refuses the key it was handed', cliMailBad.status === 1,
  'exit was ' + cliMailBad.status + ': ' + cliMailBad.stdout.slice(0, 200));
check('and that failure names its own cause, not the database one',
  /THE EMAIL KEY/.test(cliMailBad.stderr) && /a different Resend team/.test(cliMailBad.stderr));

check('neither refused value reaches the build log, on any path',
  [cliWaBad, cliMailBad].every((r) => {
    const all = r.stdout + r.stderr;
    return all.indexOf('owa_TESTONLY_refused_by_sender') === -1 &&
      all.indexOf('re_TESTONLY_refused_by_provider') === -1 &&
      all.indexOf('TESTONLY') === -1;
  }), 'a value reached the output');

check('the hatch the report prints actually opens both refusals',
  runLive(['--require'], {
    OPENWA_API_KEY: 'owa_TESTONLY_refused_by_sender',
    RESEND_API_KEY: 're_TESTONLY_refused_by_provider',
    [OVERRIDE_NAME]: 'OPENWA_API_KEY,RESEND_API_KEY',
  }).status === 0);

/* ---------------- 7. the money key and the pager ---------------- */

check('Paystack: 401 is a refused key, 403 is not a verdict about the value, and a 4xx is a READ',
  classifyPaystackAnswer(401) === 'refused' && classifyPaystackAnswer(403) === 'unknown' &&
  classifyPaystackAnswer(200) === 'accepted' && classifyPaystackAnswer(400) === 'accepted' &&
  classifyPaystackAnswer(500) === 'unknown');

check('Telegram: only a 2xx proves a token — a 404 is a token of the wrong SHAPE, not a green',
  classifyTelegramAnswer(401) === 'refused' && classifyTelegramAnswer(200) === 'accepted' &&
  classifyTelegramAnswer(404) === 'unknown' && classifyTelegramAnswer(400) === 'unknown');

const psAccepted = await probePaystack({ url: standin.url + '/balance', key: FAKE_PAYSTACK });
check('a Paystack secret key the provider reads is ACCEPTED, tampered copy refused',
  psAccepted.state === 'accepted' && psAccepted.status === 200 && psAccepted.host === 'api.paystack.co',
  JSON.stringify(psAccepted));

const psRefused = await probePaystack({ url: standin.url + '/balance', key: 'sk_test_TESTONLY_wrong_1a2b' });
check('a Paystack key it refuses is REFUSED, with the status that says so',
  psRefused.state === 'refused' && psRefused.status === 401, JSON.stringify(psRefused));

const psBlind = await probePaystack({ url: blindPaystack.url + '/balance', key: FAKE_PAYSTACK });
check('a Paystack endpoint that answers a TAMPERED key with 200 is BLIND, not green',
  psBlind.state === 'blind' && /proved nothing/.test(psBlind.message), JSON.stringify(psBlind));

check('an unreachable Paystack is UNREACHABLE, and no key makes no request at all',
  (await probePaystack({ url: DEAD, key: FAKE_PAYSTACK })).state === 'unreachable' &&
  (await probePaystack({ key: '' })).state === 'unchecked');

const tgAccepted = await probeTelegram({ origin: standin.url, token: FAKE_TG, chatId: FAKE_CHAT });
check('a bot token Telegram knows is ACCEPTED, tampered copy refused, and the chat is found',
  tgAccepted.state === 'accepted' && tgAccepted.status === 200 && tgAccepted.chatFound === true,
  JSON.stringify(tgAccepted));

const tgWrongChat = await probeTelegram({ origin: standin.url, token: FAKE_TG, chatId: '-1009999999999' });
check('a chat the bot cannot see is found:false — the token is good and every alert still goes nowhere',
  tgWrongChat.state === 'accepted' && tgWrongChat.chatFound === false, JSON.stringify(tgWrongChat));

const tgRefused = await probeTelegram({ origin: standin.url, token: '900000002:AAF_TESTONLY_wrong_9f3c' });
check('a revoked token is REFUSED', tgRefused.state === 'refused' && tgRefused.status === 401, JSON.stringify(tgRefused));

const tgShape = await probeTelegram({ origin: standin.url, token: 'not-a-token' });
check('a token of the wrong SHAPE is NOT proved — 404 from Telegram is warned about, never read as green',
  tgShape.state === 'unknown' && tgShape.status === 404, JSON.stringify(tgShape));

const tgBlind = await probeTelegram({ origin: blindTg.url, token: FAKE_TG, chatId: FAKE_CHAT });
check('a Telegram endpoint that answers a TAMPERED token with 200 is BLIND, not green',
  tgBlind.state === 'blind' && /proved nothing/.test(tgBlind.message), JSON.stringify(tgBlind));

check('no token means no request, and an unreachable Telegram is UNREACHABLE',
  (await probeTelegram({ token: '' })).state === 'unchecked' &&
  (await probeTelegram({ origin: DEAD, token: FAKE_TG })).state === 'unreachable');

const outPsRefused = checkEnv(full({ PAYSTACK_SECRET_KEY: FAKE_PAYSTACK }), { require: true, livePaystack: psRefused });
check('a REFUSED Paystack key fails the build even though its ABSENCE is only advised',
  outPsRefused.exit === 1 && outPsRefused.livePaystack === 'refused' &&
  outPsRefused.blocking.indexOf('PAYSTACK_SECRET_KEY') !== -1, JSON.stringify(outPsRefused.blocking));

check('and it names the three causes, including a public key pasted into the secret slot',
  /THE PAYSTACK KEY/.test(outPsRefused.message) && /ROTATED in the Paystack dashboard/.test(outPsRefused.message) &&
  /PUBLIC key \(pk_/.test(outPsRefused.message) && /another Paystack account/.test(outPsRefused.message));

const outTgRefused = checkEnv(full({ TELEGRAM_BOT_TOKEN: FAKE_TG }), { require: true, liveTelegram: tgRefused });
check('a REFUSED bot token fails the build: the pager being silent is not a degradation',
  outTgRefused.exit === 1 && outTgRefused.liveTelegram === 'refused' &&
  outTgRefused.blocking.indexOf('TELEGRAM_BOT_TOKEN') !== -1);

check('and says every alert is dropped, including the one about the outage',
  /THE TELEGRAM TOKEN/.test(outTgRefused.message) && /Every alert this site sends is dropped/.test(outTgRefused.message))
;

check('naming the money key or the token in the override excuses its refusal',
  checkEnv(full({ PAYSTACK_SECRET_KEY: FAKE_PAYSTACK, [OVERRIDE_NAME]: 'PAYSTACK_SECRET_KEY' }),
    { require: true, livePaystack: psRefused }).exit === 0 &&
  checkEnv(full({ TELEGRAM_BOT_TOKEN: FAKE_TG, [OVERRIDE_NAME]: 'TELEGRAM_BOT_TOKEN' }),
    { require: true, liveTelegram: tgRefused }).exit === 0);

check('a chat the bot cannot see WARNS and does not block — the token is not the problem',
  checkEnv(full({ TELEGRAM_BOT_TOKEN: FAKE_TG, TELEGRAM_CHAT_ID: FAKE_CHAT }),
    { require: true, liveTelegram: tgWrongChat }).exit === 0 &&
  /not a chat that bot can see/.test(checkEnv(full({ TELEGRAM_BOT_TOKEN: FAKE_TG, TELEGRAM_CHAT_ID: FAKE_CHAT }),
    { require: true, liveTelegram: tgWrongChat }).message));

check('an unproved token WARNS by name, and a Paystack 5xx does too',
  checkEnv(full({ TELEGRAM_BOT_TOKEN: FAKE_TG }), { require: true, liveTelegram: tgShape }).exit === 0 &&
  /TELEGRAM_BOT_TOKEN was NOT proved/.test(checkEnv(full({ TELEGRAM_BOT_TOKEN: FAKE_TG }),
    { require: true, liveTelegram: tgShape }).message) &&
  /PAYSTACK_SECRET_KEY was NOT proved/.test(checkEnv(full({ PAYSTACK_SECRET_KEY: FAKE_PAYSTACK }),
    { require: true, livePaystack: { state: 'unknown', status: 503, message: 'Paystack answered HTTP 503' } }).message));

const cliPsBad = runLive(['--require'], { PAYSTACK_SECRET_KEY: 'sk_test_TESTONLY_refused_by_ps' });
check('the CLI FAILS the build when Paystack refuses the key it was handed', cliPsBad.status === 1,
  'exit was ' + cliPsBad.status + ': ' + cliPsBad.stdout.slice(0, 200));

const cliTgBad = runLive(['--require'], { TELEGRAM_BOT_TOKEN: '900000002:AAF_TESTONLY_refused_tg' });
check('the CLI FAILS the build when Telegram refuses the token it was handed', cliTgBad.status === 1,
  'exit was ' + cliTgBad.status + ': ' + cliTgBad.stdout.slice(0, 200));

check('and neither refused value reaches the build log, on any path',
  [cliPsBad, cliTgBad].every((r) => {
    const all = r.stdout + r.stderr;
    return all.indexOf('sk_test_TESTONLY_refused_by_ps') === -1 &&
      all.indexOf('AAF_TESTONLY_refused_tg') === -1 && all.indexOf('TESTONLY') === -1;
  }), 'a value reached the output');

check('a chat id the bot cannot see passes the build and warns',
  runLive(['--require'], { TELEGRAM_CHAT_ID: '-1009999999999' }).status === 0);

/* ---------------- report ---------------- */

standin.child.kill();
blindStandin.child.kill();
blindWa.child.kill();
blindMail.child.kill();
blindPaystack.child.kill();
blindTg.child.kill();

if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
}
console.log('deploy-key gate \u2014 PASS ' + PASS.length + ' \u00b7 FAIL ' + FAIL.length);
/* The CODE, not process.exit(): this suite now makes requests, and an
   exit taken while undici still holds its pool aborts the process on
   some platforms instead of returning the status. */
process.exitCode = FAIL.length ? 1 : 0;
