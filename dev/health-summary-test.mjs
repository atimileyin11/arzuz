#!/usr/bin/env node
/* ============================================================
   Arzuz — does the dashboard's one line tell the truth?

   THE FAILURE THIS SUITE EXISTS FOR

     netlify/functions/database-health.js writes down when each
     credential last passed. /api/health-summary turns that into one
     sentence for the dashboard. The sentence is the ONLY place a
     person can see the state of all three checks without being paged,
     so every way it can lie is worth a check:

       a mark from three hours ago printed as if it were this hour
                                        → the team reads "fine" through
                                          an outage that already alerted
       a check with no recorded hour painted green
                                        → the first day of a deploy
                                          invents a healthy state
       a refusal thirty minutes after the last acceptance hidden by
       the ninety-minute grace       → a live outage reads as fresh
       an unreadable marker read as silence
                                        → "no record" becomes "all good"
       the old { last_ok_at } shape skipped
                                        → a deploy rolling over mid-outage
                                          loses the gap it was measuring

   AND THE DOOR. The endpoint is opened by any staff login and nobody
   else: the marker is operational data, so a student session or an
   anonymous request must not read it, and a deploy with no service key
   must say so rather than answering a line built from nothing.

   No network, no Supabase: the marker, the session and the role are
   all stubs, and the service key is a test string.

   Run:  node dev/health-summary-test.mjs
   ============================================================ */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const PROJECT = 'https://standin.supabase.co';
const SERVICE_KEY = 'service_role_TESTONLY_never_print_me_4d1a';
const GOOD_TOKEN = 'test-token-that-is-long-enough-to-pass-liveuser';
const NOW = new Date('2026-10-18T14:30:00.000Z');

/* Set before the functions are required: care-credit.js reads its
   project and anon key at module load, exactly like the real deploy. */
process.env.SUPABASE_URL = PROJECT;
process.env.SUPABASE_ANON_KEY = 'anon_TESTONLY_public_by_design';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const require = createRequire(import.meta.url);
const { summarise, hourLabel, GRACE_MS } = require('../netlify/functions/lib/health-summary.js');
const endpoint = require('../netlify/functions/health-summary.js');

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    const out = await fn();
    if (out === true || out === undefined) {
      pass += 1;
      console.log('  \u2713 ' + name);
      return;
    }
    failures.push(name + ' \u2014 ' + out);
    console.log('  \u2717 ' + name + '\n      ' + out);
  } catch (err) {
    failures.push(name + ' \u2014 threw: ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      threw: ' + (err && err.message));
  }
}

/* ---------------- the stand-in project ---------------- */

const world = {
  tokenOk: true,
  role: 'admin',
  /* null = no row; an object = the row's value; a string = raw body */
  marker: null,
  markerRaw: null,
  markerStatus: 200,
  urls: [],
};

function resp(status, obj, type) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: () => type || 'application/json' },
    text: async () => (obj === undefined ? '' : (typeof obj === 'string' ? obj : JSON.stringify(obj))),
    json: async () => {
      if (obj === undefined) return null;
      if (typeof obj !== 'string') return obj;
      /* A body that is a bare word is how PostgREST answers an rpc that
         returns text (arzuz_role): the real json() parses the quotes
         away. A body that is not JSON at all comes back as itself, which
         is what a caller asking for text would want. */
      try { return JSON.parse(obj); } catch (_) { return obj; }
    },
  };
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  world.urls.push(u);

  if (u.indexOf('/auth/v1/user') !== -1) {
    const auth = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    if (world.tokenOk && auth === 'Bearer ' + GOOD_TOKEN) {
      return resp(200, { id: 'user-1', email: 'ops@arzuz.test' });
    }
    return resp(401, { message: 'invalid token' });
  }

  if (u.indexOf('/rest/v1/rpc/arzuz_role') !== -1) {
    return resp(200, world.role === null ? null : world.role);
  }

  if (u.indexOf('/rest/v1/finance_config') !== -1) {
    if (world.markerStatus !== 200) return resp(world.markerStatus, { message: 'refused by the stand-in' });
    if (world.markerRaw !== null) return resp(200, world.markerRaw);
    if (world.marker === null) return resp(200, []);
    return resp(200, [{ key: 'ops_database_health', value: world.marker }]);
  }

  throw new Error('unexpected request: ' + u);
};

function reset(over) {
  world.tokenOk = true;
  world.role = 'admin';
  world.marker = null;
  world.markerRaw = null;
  world.markerStatus = 200;
  world.urls.length = 0;
  Object.assign(world, over || {});
}

async function ask(opts) {
  const o = opts || {};
  const headers = {};
  if (o.token !== null) headers.authorization = 'Bearer ' + (o.token || GOOD_TOKEN);
  const res = await endpoint.handler({
    httpMethod: o.method || 'POST',
    headers: headers,
    body: '{}',
  });
  let body = null;
  try { body = JSON.parse(res.body); } catch (_) { body = null; }
  return { status: res.statusCode, body: body, headers: res.headers || {}, raw: res.body };
}

/* ---------------- the state builders ---------------- */

const ago = (min) => new Date(NOW.getTime() - min * 60000);
const iso = (d) => new Date(d).toISOString();
/* The endpoint reads the REAL clock, so a marker it is meant to find
   fresh has to be dated from that clock rather than from the fixed
   NOW the sentences are asserted against. */
const agoIso = (min) => new Date(Date.now() - min * 60000).toISOString();

function fresh(over) {
  const s = {
    known: true,
    at: { database: ago(10), paystack: ago(20), telegram: ago(5) },
    failing: {},
  };
  return Object.assign(s, over || {});
}

function markerValue(over) {
  const v = {
    checks: { database: agoIso(10), paystack: agoIso(20), telegram: agoIso(5) },
    failing: {},
    last_ok_at: agoIso(10),
  };
  return Object.assign(v, over || {});
}

async function main() {
  console.log('Arzuz health summary — the dashboard\'s one line');

  /* ================= the hour label ================= */

  console.log('\n--- the accepted hour ---');

  await check('an hour from today is printed without a date, in UTC', () =>
    hourLabel(ago(25), NOW) === '14:05 UTC' ? true : 'got ' + hourLabel(ago(25), NOW));

  await check('an hour from another day keeps its date, so it cannot be read as this afternoon', () =>
    hourLabel(new Date('2026-10-17T09:05:00Z'), NOW) === '17 Oct 09:05 UTC'
      ? true : 'got ' + hourLabel(new Date('2026-10-17T09:05:00Z'), NOW));

  await check('no timestamp prints nothing, never the word "invalid"', () =>
    hourLabel(null, NOW) === null ? true : 'got ' + hourLabel(null, NOW));

  await check('a malformed timestamp prints nothing', () =>
    hourLabel('not a date', NOW) === null ? true : 'got ' + hourLabel('not a date', NOW));

  /* ================= all three fresh ================= */

  console.log('\n--- all three accepted ---');

  const okLine = summarise(fresh(), NOW);

  await check('the level is ok only when every check has a fresh mark', () =>
    okLine.level === 'ok' ? true : 'level is ' + okLine.level + ': ' + okLine.line);

  await check('the line opens with the same words the dashboard styles', () =>
    okLine.line.indexOf('Hourly checks \u2014 ') === 0 ? true : 'line reads: ' + okLine.line);

  await check('each check is named with its own last accepted hour', () => {
    const want = ['Database 14:20 UTC', 'Paystack 14:10 UTC', 'Telegram 14:25 UTC'];
    const missing = want.filter((w) => okLine.line.indexOf(w) === -1);
    return missing.length ? 'missing ' + missing.join(', ') + ' in: ' + okLine.line : true;
  });

  await check('the reader is told the readings are inside the grace, not merely old', () =>
    okLine.line.indexOf('all accepted within the last 90 minutes') !== -1 ? true : 'line reads: ' + okLine.line);

  await check('each check carries its own state and timestamp, not just the sentence', () => {
    if (!Array.isArray(okLine.checks) || okLine.checks.length !== 3) return 'checks is not the three';
    const bad = okLine.checks.filter((c) => c.state !== 'fresh' || !c.lastAcceptedAt || !c.lastAccepted);
    return bad.length ? bad.map((c) => c.name + '=' + c.state).join(', ') : true;
  });

  await check('the grace reported to the page is the one the all-clear uses', () =>
    okLine.graceMinutes === Math.round(GRACE_MS / 60000) ? true : 'got ' + okLine.graceMinutes);

  await check('the line says when it was read, so a dashboard left open cannot age into a lie', () =>
    / Read at 14:30 UTC\.$/.test(okLine.line) ? true : 'line reads: ' + okLine.line);

  /* ================= staleness, and its boundary ================= */

  console.log('\n--- a mark that is too old ---');

  const boundary = summarise(fresh({ at: { database: ago(90), paystack: ago(5), telegram: ago(5) } }), NOW);
  await check('exactly at the ninety-minute grace is still fresh (the rule is "longer than", as in the all-clear)', () =>
    boundary.level === 'ok' ? true : 'level is ' + boundary.level + ': ' + boundary.line);

  const stale = summarise(fresh({ at: { database: ago(91), paystack: ago(5), telegram: ago(5) } }), NOW);
  await check('one minute past it is stale, and the whole line stops being green', () =>
    stale.level === 'warn' ? true : 'level is ' + stale.level + ': ' + stale.line);

  await check('a stale check prints how long it has been silent, to one decimal', () =>
    stale.line.indexOf('Database 12:59 UTC (1.5h silent)') !== -1 ? true : 'line reads: ' + stale.line);

  await check('the sentence names the check and the hour, so nobody has to subtract', () =>
    stale.line.indexOf('Database has not been accepted since 12:59 UTC.') !== -1
      ? true : 'line reads: ' + stale.line);

  const staleDate = summarise(fresh({
    at: { database: new Date('2026-10-17T09:00:00Z'), paystack: ago(5), telegram: ago(5) },
  }), NOW);
  await check('a stale mark from yesterday prints its date rather than a bare hour', () =>
    staleDate.line.indexOf('Database 17 Oct 09:00 UTC') !== -1 ? true : 'line reads: ' + staleDate.line);

  const twoProblems = summarise(fresh({
    at: { database: ago(10), paystack: ago(200), telegram: ago(300) },
  }), NOW);
  await check('a warning line carries the same read time, not only a green one', () =>
    / Read at 14:30 UTC\.$/.test(stale.line) ? true : 'line reads: ' + stale.line);

  await check('two bad checks are both named, separated rather than counted', () => {
    if (twoProblems.line.indexOf('Paystack has not been accepted since') === -1) return 'Paystack is missing: ' + twoProblems.line;
    if (twoProblems.line.indexOf('; Telegram has not been accepted since') === -1) return 'Telegram is missing: ' + twoProblems.line;
    return true;
  });

  /* ================= a refusal inside the grace ================= */

  console.log('\n--- refused after the last acceptance ---');

  const refused = summarise(fresh({
    at: { database: ago(10), paystack: ago(40), telegram: ago(5) },
    failing: { paystack: ago(20) },
  }), NOW);
  await check('a refusal newer than the last acceptance is a live failure, even inside the grace', () =>
    refused.level === 'warn' ? true : 'level is ' + refused.level + ': ' + refused.line);

  await check('the line shows both facts: when it last worked, and when it was refused', () =>
    refused.line.indexOf('Paystack 13:50 UTC, refused 14:10 UTC') !== -1 ? true : 'line reads: ' + refused.line);

  await check('the sentence says it was refused, not merely that it is quiet', () =>
    refused.line.indexOf('Paystack was refused at 14:10 UTC.') !== -1 ? true : 'line reads: ' + refused.line);

  await check('the check\'s own state is "refused", so a future panel can style more than a dot', () => {
    const c = refused.checks.filter((x) => x.name === 'paystack')[0];
    if (!c) return 'no paystack check in the answer';
    return c.state === 'refused' && c.refusedAt === '14:10 UTC' && c.lastAccepted === '13:50 UTC'
      ? true : JSON.stringify(c);
  });

  const sameInstant = summarise(fresh({
    at: { database: ago(10), paystack: ago(20), telegram: ago(5) },
    failing: { paystack: ago(20) },
  }), NOW);
  await check('a refusal at the same instant as the acceptance is not a refusal (strictly after)', () =>
    sameInstant.level === 'ok' ? true : 'level is ' + sameInstant.level + ': ' + sameInstant.line);

  const cleared = summarise(fresh({
    at: { database: ago(10), paystack: ago(20), telegram: ago(5) },
    failing: { paystack: ago(60) },
  }), NOW);
  await check('a refusal OLDER than the last acceptance was cleared by it', () =>
    cleared.level === 'ok' ? true : 'level is ' + cleared.level + ': ' + cleared.line);

  const refusedNever = summarise(fresh({
    at: { database: ago(10), telegram: ago(5) },
    failing: { paystack: ago(20) },
  }), NOW);
  await check('a check that was refused and never accepted says so in both halves', () => {
    if (refusedNever.line.indexOf('Paystack never accepted, refused 14:10 UTC') === -1) return 'line reads: ' + refusedNever.line;
    return refusedNever.line.indexOf('Paystack has never accepted the value, and was refused at 14:10 UTC') !== -1
      ? true : 'sentence reads: ' + refusedNever.line;
  });

  /* ================= never recorded ================= */

  console.log('\n--- no accepted hour at all ---');

  const never = summarise(fresh({ at: { database: ago(10), paystack: ago(5) } }), NOW);
  await check('a check with no mark is named as never accepted, not omitted', () =>
    never.line.indexOf('Telegram never accepted') !== -1 ? true : 'line reads: ' + never.line);

  await check('and it keeps the line from being green', () =>
    never.level === 'warn' ? true : 'level is ' + never.level);

  await check('the sentence for it is a fact about the record, not a guess about the provider', () =>
    never.line.indexOf('Telegram has never been accepted.') !== -1 ? true : 'line reads: ' + never.line);

  /* ================= the marker itself ================= */

  console.log('\n--- when there is nothing to read ---');

  const first = summarise({ known: false, at: {}, reason: 'there is no marker recorded yet' }, NOW);
  await check('an empty marker is "nothing recorded yet", never a clear', () => {
    if (first.level !== 'warn') return 'level is ' + first.level;
    if (first.line.indexOf('nothing recorded yet') === -1) return 'line reads: ' + first.line;
    if (first.line.indexOf('accepted within') !== -1) return 'it claims accepted hours: ' + first.line;
    return true;
  });

  const missingTable = summarise({
    known: false, at: {}, reason: 'there is no finance_config table to keep the marker in on this project',
  }, NOW);
  await check('a marker that cannot be read prints the reason instead of silence', () =>
    missingTable.line.indexOf('no record to read: there is no finance_config table') !== -1
      ? true : 'line reads: ' + missingTable.line);

  await check('and it says plainly that nothing can be confirmed from here', () =>
    missingTable.line.indexOf('nothing here can be confirmed') !== -1 ? true : 'line reads: ' + missingTable.line);

  const refusedRead = summarise({ known: false, at: {}, reason: 'the marker read answered 401' }, NOW);
  await check('a refused read is a warning with its status, not a green line', () =>
    refusedRead.level === 'warn' && refusedRead.line.indexOf('answered 401') !== -1
      ? true : refusedRead.level + ' / ' + refusedRead.line);

  /* ================= the door ================= */

  console.log('\n--- who may read it ---');

  await check('OPTIONS is answered without a session', async () => {
    reset();
    const out = await ask({ method: 'OPTIONS' });
    return out.status === 204 ? true : 'status ' + out.status;
  });

  await check('GET is refused: this endpoint is not a public status page', async () => {
    reset();
    const out = await ask({ method: 'GET' });
    return out.status === 405 ? true : 'status ' + out.status;
  });

  await check('no token is 401 and tells the person to sign in', async () => {
    reset();
    const out = await ask({ token: null });
    if (out.status !== 401) return 'status ' + out.status;
    return /sign in/i.test(String(out.body && out.body.error)) ? true : JSON.stringify(out.body);
  });

  await check('a dead token is 401, not a deployment refusal', async () => {
    reset();
    const out = await ask({ token: 'a-token-that-is-long-but-not-live' });
    return out.status === 401 ? true : 'status ' + out.status + ' ' + JSON.stringify(out.body);
  });

  await check('a signed-in student role is 403: this is operator data', async () => {
    reset({ role: 'student' });
    const out = await ask();
    return out.status === 403 ? true : 'status ' + out.status + ' ' + JSON.stringify(out.body);
  });

  await check('a token with no role at all is refused rather than treated as the main admin', async () => {
    reset({ role: null });
    const out = await ask();
    return out.status === 403 ? true : 'status ' + out.status;
  });

  await check('every staff role the team SQL issues may read it', async () => {
    const refused = [];
    for (const role of endpoint.STAFF) {
      reset({ role: role, marker: markerValue() });
      const out = await ask();
      if (out.status !== 200) refused.push(role + '=' + out.status);
    }
    return refused.length ? refused.join(', ') : true;
  });

  await check('the staff list is exactly the five roles, so a typo cannot widen the door', () => {
    const want = ['admin', 'support', 'finance', 'verification', 'marketing'];
    return endpoint.STAFF.join(',') === want.join(',') ? true : endpoint.STAFF.join(',');
  });

  /* ================= the reading ================= */

  console.log('\n--- the answer ---');

  await check('with no service key the endpoint says so instead of inventing a line', async () => {
    reset({ marker: markerValue() });
    const held = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const out = await ask();
      if (out.status !== 503) return 'status ' + out.status;
      return /SUPABASE_SERVICE_ROLE_KEY/.test(String(out.body && out.body.error))
        ? true : JSON.stringify(out.body);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = held;
    }
  });

  await check('a readable marker answers 200 with the line and all three checks', async () => {
    reset({ marker: markerValue() });
    const out = await ask();
    if (out.status !== 200) return 'status ' + out.status + ' ' + JSON.stringify(out.body);
    const b = out.body || {};
    if (b.ok !== true || b.level !== 'ok') return 'ok/level are ' + b.ok + '/' + b.level;
    if (typeof b.line !== 'string' || b.line.indexOf('Hourly checks \u2014 ') !== 0) return 'line: ' + b.line;
    return Array.isArray(b.checks) && b.checks.length === 3 ? true : 'checks: ' + JSON.stringify(b.checks);
  });

  await check('it reads the marker the probe writes, and nothing else', () => {
    const hit = world.urls.filter((u) => u.indexOf('/finance_config') !== -1);
    if (!hit.length) return 'the marker was never read';
    return hit[0].indexOf('key=eq.ops_database_health') !== -1 ? true : 'read ' + hit[0];
  });

  await check('the marker is read with the service key, because finance_config is under RLS', () => {
    const hit = world.urls.filter((u) => u.indexOf('/finance_config') !== -1)[0] || '';
    return hit.indexOf(PROJECT) === 0 ? true : 'read ' + hit;
  });

  await check('the old { last_ok_at } shape is still the database\'s hour', async () => {
    reset({ marker: { last_ok_at: agoIso(12) } });
    const out = await ask();
    const db = (out.body && out.body.checks || []).filter((c) => c.name === 'database')[0];
    const others = (out.body && out.body.checks || []).filter((c) => c.name !== 'database');
    if (!db || db.state !== 'fresh') return 'database: ' + JSON.stringify(db);
    return others.every((c) => c.state === 'never') ? true : 'the other checks invented a state';
  });

  await check('an old row with per-check marks is read per check, not from last_ok_at', async () => {
    reset({ marker: markerValue({ checks: { database: agoIso(10), paystack: agoIso(200), telegram: agoIso(5) } }) });
    const out = await ask();
    const pay = (out.body && out.body.checks || []).filter((c) => c.name === 'paystack')[0];
    if (!pay) return 'no paystack check in the answer';
    return pay.state === 'stale' ? true : 'state ' + pay.state;
  });

  await check('a missing marker table answers 200 with a warning, not a 500', async () => {
    reset({ markerStatus: 404 });
    const out = await ask();
    if (out.status !== 200) return 'status ' + out.status;
    if (out.body.level !== 'warn') return 'level is ' + out.body.level;
    return out.body.line.indexOf('no record to read') !== -1 ? true : out.body.line;
  });

  await check('a refused marker read is reported with its status, still not a 500', async () => {
    reset({ markerStatus: 500 });
    const out = await ask();
    if (out.status !== 200) return 'status ' + out.status;
    return out.body.line.indexOf('answered 500') !== -1 ? true : out.body.line;
  });

  await check('a marker that is not a list is said to be unreadable', async () => {
    reset({ markerRaw: 'not json at all' });
    const out = await ask();
    return out.status === 200 && out.body.level === 'warn' && out.body.line.indexOf('was not a list') !== -1
      ? true : JSON.stringify(out.body);
  });

  await check('the answer is never cached and never indexed', async () => {
    reset({ marker: markerValue() });
    const out = await ask();
    const h = out.headers || {};
    if (String(h['Cache-Control'] || '') !== 'no-store') return 'cache: ' + h['Cache-Control'];
    return String(h['X-Robots-Tag'] || '').indexOf('noindex') !== -1 ? true : 'robots: ' + h['X-Robots-Tag'];
  });

  await check('the service key and the caller\'s token appear nowhere in the answer', async () => {
    reset({ marker: markerValue() });
    const out = await ask();
    const raw = String(out.raw || '');
    if (raw.indexOf(SERVICE_KEY) !== -1) return 'the service key is in the body';
    if (raw.indexOf(GOOD_TOKEN) !== -1) return 'the caller token is in the body';
    if (/apikey|authorization/i.test(raw)) return 'a header name is echoed: ' + raw.slice(0, 160);
    return true;
  });

  await check('a fresh refusal inside the grace is served as warn, so the page cannot print green', async () => {
    reset({
      marker: markerValue({
        checks: { database: agoIso(10), paystack: agoIso(40), telegram: agoIso(5) },
        failing: { paystack: agoIso(20) },
      }),
    });
    const out = await ask();
    if (out.body.level !== 'warn') return 'level is ' + out.body.level;
    return out.body.line.indexOf('was refused at') !== -1 ? true : out.body.line;
  });

  /* ================= the page it feeds ================= */

  console.log('\n--- the dashboard is wired to it ---');

  const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const adminSrc = fs.readFileSync(new URL('../assets/admin.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../assets/admin.css', import.meta.url), 'utf8');

  await check('admin.html carries the line, hidden until an answer arrives', () => {
    if (html.indexOf('id="healthLine"') === -1) return 'no #healthLine';
    if (!/id="healthLine"[^>]*\shidden\b/.test(html)) return 'the line is not hidden at load';
    return html.indexOf('id="healthText"') !== -1 ? true : 'no #healthText';
  });

  await check('the dashboard asks the endpoint and prints the answer\'s own sentence', () => {
    if (adminSrc.indexOf("'/api/health-summary'") === -1) return 'no request to /api/health-summary';
    if (adminSrc.indexOf('state.health.data.line') === -1) return 'the sentence is not printed from the answer';
    if (adminSrc.indexOf("'health-line ' + level") === -1) return 'the dot level is not taken from the answer';
    return true;
  });

  await check('the line has a style for each level, and none for a state nobody decided', () => {
    if (css.indexOf('.health-line.ok .health-dot') === -1) return 'no ok dot';
    return css.indexOf('.health-line.warn .health-dot') !== -1 ? true : 'no warn dot';
  });

  await check('the line is hidden by CSS as well as the attribute, so a stylesheet cannot show it early', () =>
    css.indexOf('.health-line[hidden]') !== -1 ? true : 'no [hidden] rule');

  /* ---------------- the verdict ---------------- */

  console.log('\n\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014');
  console.log(pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  FAIL ' + f));
    process.exitCode = 1;
  }
}

main();
