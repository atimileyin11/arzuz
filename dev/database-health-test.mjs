#!/usr/bin/env node
/* ============================================================
   Arzuz — can the database probe tell a dead key from a live one?

   netlify/functions/database-health.js decides "the site can still
   reach its database?" from one reading: what Supabase answers when it
   is handed the key this deployment was built with. If that reading is
   wrong the hourly check is theatre — a green run every hour while
   every form on the site answers not-ready to people who cannot fix
   it, which is exactly the afternoon this was written after.

   So this file stands up a project that answers the way the real one
   does and makes the probe judge it:

     key accepted, tampered copy refused, both doors answering
                                        → green, and nothing is written
     key REFUSED (401)                  → "key", with the host named
     project that accepts anything      → "probe", because its own
                                          tamper request was not
                                          refused, so its green would
                                          be a lie
     project that does not answer       → "unreachable", never "key"
     a door answering 502               → "door"
     the Care Pass simply not on sale   → still GREEN: a product state
                                          is not a fault, and a probe
                                          that pages for it gets muted

   And it drives the HANDLER, so the alert is proved rather than
   assumed: a refused key sends exactly one message, that message names
   the stage and the repair, and the key itself never appears in it.

   No network, no Supabase, no credentials: every request lands on a
   stub, and the key being tried is a test string.

   Run:  node dev/database-health-test.mjs
   ============================================================ */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { probeDatabase } = require('../netlify/functions/lib/database-probe.js');
const { recoveryFrom, GRACE_MS } = require('../netlify/functions/lib/health-state.js');
const health = require('../netlify/functions/database-health.js');

const PROJECT = 'https://standin.supabase.co';
const SITE = 'https://arzuz.test';
const TRUE_KEY = 'sb_secret_TESTONLY_the_one_project_knows_4d1a';
const OTHER_KEY = 'sb_secret_TESTONLY_a_stale_one_9f2b';

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

/* ---------------- the stand-in world ---------------- */

const world = {
  /* what the project does with a key it does not know */
  keyMode: 'refuses',      // refuses | blind
  finance: { status: 503, body: { error: 'The Care Pass is not on sale yet', kind: 'not-ready' } },
  care: { status: 404, body: { error: 'We do not recognise that Care link. Open it exactly as it arrived.', kind: 'rejected' } },
  projectDown: false,
  siteDown: false,
  requests: [],
  telegram: [],
  /* the marker the healthy hour keeps: null = no row yet */
  marker: null,
  stateMissing: false,
  writes: [],
  events: [],
};

function resp(status, obj, type) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: () => type || 'application/json' },
    text: async () => (obj === undefined ? '' : (typeof obj === 'string' ? obj : JSON.stringify(obj))),
    json: async () => (obj === undefined ? null : obj),
  };
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  world.requests.push(u + ' ' + String((init.headers && (init.headers.apikey || '')) || '').slice(0, 12));

  if (u.indexOf('api.telegram.org') !== -1) {
    world.telegram.push(init.body ? String(init.body) : '');
    world.events.push('alert');
    return resp(200, { ok: true });
  }

  if (u.indexOf(PROJECT + '/rest/v1/') !== -1) {
    if (world.projectDown) throw new Error('ENOTFOUND standin.supabase.co');
    const key = String((init.headers && init.headers.apikey) || '');
    const known = world.keyMode === 'blind' || key === TRUE_KEY;
    if (!known) return resp(401, { message: 'Invalid API key', hint: 'Double check your Supabase service_role API key.' });

    /* the health marker, read and rewritten in place */
    const isMarkerRead = u.indexOf('finance_config?select=value&key=eq.ops_database_health') !== -1;
    const isMarkerWrite = String(init.method || 'GET').toUpperCase() === 'POST' &&
      u.indexOf('finance_config?on_conflict=key') !== -1;
    if ((isMarkerRead || isMarkerWrite) && world.stateMissing) {
      return resp(404, { code: '42P01', message: 'relation "public.finance_config" does not exist' });
    }
    if (isMarkerWrite) {
      world.writes.push(String(init.body || ''));
      world.events.push('mark');
      try {
        const row = JSON.parse(String(init.body || '[]'))[0];
        world.marker = (row && row.value && row.value.last_ok_at) || null;
      } catch (_) { /* leave the marker alone */ }
      return resp(201, '');
    }
    if (isMarkerRead) {
      return resp(200, world.marker === null ? [] :
        [{ key: 'ops_database_health', value: { last_ok_at: world.marker } }]);
    }

    return resp(200, [{ key: 'care_pass_price_kobo' }]);
  }

  if (u.indexOf('/api/finance') !== -1) {
    if (world.siteDown) throw new Error('the site did not answer');
    return resp(world.finance.status, world.finance.body);
  }
  if (u.indexOf('/api/care-credit') !== -1) {
    if (world.siteDown) throw new Error('the site did not answer');
    return resp(world.care.status, world.care.body);
  }

  return resp(404, { message: 'unexpected request in this suite: ' + u });
};

function reset(over) {
  world.keyMode = 'refuses';
  world.projectDown = false;
  world.siteDown = false;
  world.requests = [];
  world.telegram = [];
  world.marker = null;
  world.stateMissing = false;
  world.writes = [];
  world.events = [];
  world.finance = { status: 503, body: { error: 'The Care Pass is not on sale yet', kind: 'not-ready' } };
  world.care = { status: 404, body: { error: 'We do not recognise that Care link. Open it exactly as it arrived.', kind: 'rejected' } };
  Object.assign(world, over || {});
}

const call = (extra) => probeDatabase(Object.assign({ project: PROJECT, base: SITE, key: TRUE_KEY }, extra || {}));

/* ------------------------------------------------------------ */

console.log('\ndatabase-health \u2014 the credential this deploy holds\n');

await check('a key the project accepts, with both doors answering, is GREEN', async () => {
  reset();
  const out = await call();
  if (out.ok !== true || out.stage !== 'accepts') return JSON.stringify(out);
  if (!/accepts/.test(out.message) || !/tampered copy/.test(out.message)) return 'the green does not say what it proved: ' + out.message;
  if (world.requests.length !== 4) return 'expected two key reads and two door calls, saw ' + world.requests.length;
});

await check('and it WRITES nothing: no POST to a table, no message, in the whole run', async () => {
  reset();
  world.care = { status: 404, body: { error: 'We do not recognise that Care link.', kind: 'rejected' } };
  await call();
  const writes = world.requests.filter((r) => /rest\/v1\/(?!finance_config)/.test(r));
  return writes.length === 0 ? true : 'the probe wrote to ' + writes.join(', ');
});

await check('a key the project REFUSES is stage "key", and the report names the project', async () => {
  reset();
  const out = await call({ key: OTHER_KEY });
  if (out.ok !== false || out.stage !== 'key') return JSON.stringify(out);
  if (out.status !== 401) return 'status ' + out.status + ' is not 401';
  return /standin\.supabase\.co REFUSED/.test(out.message) ? true : 'the report does not say who refused it: ' + out.message;
});

await check('the refused value itself is never in the report', async () => {
  reset();
  const out = await call({ key: OTHER_KEY });
  return (out.message + JSON.stringify(out)).indexOf(OTHER_KEY) === -1 ? true : 'the key reached the message';
});

await check('a project that accepts a TAMPERED key is stage "probe" \u2014 its green would be a lie', async () => {
  reset({ keyMode: 'blind' });
  const out = await call();
  if (out.ok !== false || out.stage !== 'probe') return JSON.stringify(out);
  return /readable without a credential/.test(out.message) ? true : 'the report does not name the leak: ' + out.message;
});

await check('a project that does not answer is "unreachable", never a verdict about the key', async () => {
  reset({ projectDown: true });
  const out = await call();
  if (out.ok !== false || out.stage !== 'unreachable') return JSON.stringify(out);
  return /did not answer/.test(out.message) ? true : 'the report does not say what happened: ' + out.message;
});

await check('a project having its own bad minute (5xx) is unreachable-class, not a key verdict', async () => {
  reset();
  const saved = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).indexOf('/rest/v1/') !== -1) return resp(503, { message: 'Service Unavailable' });
    return saved(url, init);
  };
  try {
    const out = await call();
    return out.ok === false && out.stage === 'unreachable' ? true : JSON.stringify(out);
  } finally {
    global.fetch = saved;
  }
});

await check('the Care Pass simply being off sale is NOT a fault \u2014 the money door may say not-ready', async () => {
  reset();
  const out = await call();
  return out.ok === true ? true : 'a product state was reported as a fault: ' + JSON.stringify(out);
});

await check('the money door answering 502 IS a fault \u2014 the key can be right and the deploy wrong', async () => {
  reset({ finance: { status: 502, body: { error: 'We could not complete that just now.', kind: 'error' } } });
  const out = await call();
  if (out.ok !== false || out.stage !== 'door') return JSON.stringify(out);
  return /cannot reach its database/.test(out.message) ? true : 'the report does not name the door: ' + out.message;
});

await check('the Care door saying "not switched on" while this key works is a fault too', async () => {
  reset({ care: { status: 503, body: { error: 'Care is not switched on for this site yet.', kind: 'not-ready' } } });
  const out = await call();
  if (out.ok !== false || out.stage !== 'door') return JSON.stringify(out);
  return /key works/.test(out.message) ? true : 'the report does not separate the two facts: ' + out.message;
});

await check('the Care door\u2019s own unknown-link 404 is the strongest green there is', async () => {
  reset();
  const probe = await call({ doors: false });
  if (probe.ok !== true) return JSON.stringify(probe);
  const withDoors = await call();
  return withDoors.ok === true ? true : JSON.stringify(withDoors);
});

await check('with no key at all there is no request, and the stage says so', async () => {
  reset();
  const out = await call({ key: '' });
  if (out.ok !== false || out.stage !== 'key') return JSON.stringify(out);
  if (world.requests.length) return 'it asked the network with no key: ' + world.requests.join(', ');
  return /not set/.test(out.message) ? true : out.message;
});

/* ---------------- the handler: the alert is the product ---------------- */

console.log('\ndatabase-health \u2014 what a person is told\n');

const TELEGRAM = { TELEGRAM_BOT_TOKEN: 'stand-in-token', TELEGRAM_CHAT_ID: 'stand-in-chat' };

async function runHandler(env) {
  const saved = {};
  Object.keys(TELEGRAM).forEach((k) => { saved[k] = process.env[k]; process.env[k] = TELEGRAM[k]; });
  try {
    const res = await health.handler();
    return { res: res, threw: null };
  } catch (err) {
    return { res: null, threw: err };
  } finally {
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
}

await check('a refused key makes the run FAIL, and pages the team exactly once', async () => {
  reset();
  process.env.SUPABASE_SERVICE_ROLE_KEY = OTHER_KEY;
  process.env.SUPABASE_URL = PROJECT;
  process.env.URL = SITE;
  try {
    const out = await runHandler();
    if (!out.threw) return 'the run reported success while every door was down';
    if (world.telegram.length !== 1) return 'sent ' + world.telegram.length + ' alerts, not 1';
    return /database health: key/.test(out.threw.message) ? true : 'the thrown error does not name the stage: ' + out.threw.message;
  } finally {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.URL;
  }
});

await check('the alert names the stage, says the variable is SET, and names the repair', async () => {
  reset();
  process.env.SUPABASE_SERVICE_ROLE_KEY = OTHER_KEY;
  process.env.SUPABASE_URL = PROJECT;
  process.env.URL = SITE;
  try {
    await runHandler();
    const text = world.telegram[0] || '';
    if (!/Stage: <b>key<\/b>/.test(text)) return 'no stage: ' + text.slice(0, 160);
    if (!/is SET/.test(text) || !/ROTATED/.test(text)) return 'it does not tell them what to fix: ' + text.slice(0, 300);
    if (!/REDEPLOY/.test(text)) return 'it does not say the fix needs a redeploy';
    return text.indexOf(OTHER_KEY) === -1 ? true : 'THE KEY IS IN THE ALERT';
  } finally {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.URL;
  }
});

await check('the alert tells the operator which command reproduces it', async () => {
  reset();
  process.env.SUPABASE_SERVICE_ROLE_KEY = OTHER_KEY;
  process.env.SUPABASE_URL = PROJECT;
  process.env.URL = SITE;
  try {
    await runHandler();
    return /require-service-key\.mjs --require/.test(world.telegram[0] || '') ? true : 'no way to reproduce from a shell';
  } finally {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.URL;
  }
});

await check('every stage has a sentence a person can act on, and none of them blames the visitor', async () => {
  const stages = ['key', 'probe', 'unreachable', 'door'];
  const missing = stages.filter((s) => !health.HELP[s] || health.HELP[s].length < 40);
  return missing.length ? 'no help for: ' + missing.join(', ') : true;
});

await check('a healthy hour returns 200 and sends NOTHING', async () => {
  reset();
  process.env.SUPABASE_SERVICE_ROLE_KEY = TRUE_KEY;
  process.env.SUPABASE_URL = PROJECT;
  process.env.URL = SITE;
  try {
    const out = await runHandler();
    if (out.threw) return 'a healthy run threw: ' + out.threw.message;
    if (world.telegram.length) return 'it sent ' + world.telegram.length + ' messages on a healthy hour';
    return out.res && out.res.statusCode === 200 && /"ok":true/.test(out.res.body) ? true : JSON.stringify(out.res);
  } finally {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.URL;
  }
});

/* ---------------- the way back: one all-clear, never a false one ---------------- */

console.log('\ndatabase-health \u2014 the way back\n');

async function withProject(key, fn) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  process.env.SUPABASE_URL = PROJECT;
  process.env.URL = SITE;
  try {
    return await fn();
  } finally {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.URL;
  }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

await check('the boundary is TWO missed hours: exactly two says nothing, two hours and a second does', async () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const at = (ms) => new Date(now.getTime() - ms);
  const edge = recoveryFrom({ known: true, lastOkAt: at(GRACE_MS) }, now);
  const over = recoveryFrom({ known: true, lastOkAt: at(GRACE_MS + 1000) }, now);
  const blind = recoveryFrom({ known: false, reason: 'no table' }, now);
  if (edge.send !== false) return 'a two-hour gap fired an all-clear';
  if (over.send !== true) return 'a real gap did not fire';
  if (blind.send !== false || !blind.reason) return 'an unknown state invented a recovery: ' + JSON.stringify(blind);
  return true;
});

await check('a healthy hour with no marker writes one and still says NOTHING', async () => {
  reset();
  const out = await withProject(TRUE_KEY, () => runHandler());
  if (out.threw) return 'a healthy run threw: ' + out.threw.message;
  if (world.telegram.length) return 'it spoke on a healthy hour: ' + world.telegram[0].slice(0, 120);
  if (world.writes.length !== 1) return 'wrote ' + world.writes.length + ' markers, not 1';
  return world.writes[0].indexOf('ops_database_health') !== -1 && /last_ok_at/.test(world.writes[0]) ? true :
    'the marker is not the row this probe reads back: ' + world.writes[0];
});

await check('the next hour, thirty minutes later, is silent too \u2014 a healthy hour is not a recovery', async () => {
  reset({ marker: hoursAgo(0.5) });
  const out = await withProject(TRUE_KEY, () => runHandler());
  if (out.threw) return out.threw.message;
  if (world.telegram.length) return 'an all-clear fired half an hour after the last healthy hour';
  return world.writes.length === 1 ? true : 'it did not keep the marker fresh (writes: ' + world.writes.length + ')';
});

await check('the first healthy hour after a THREE-HOUR gap sends exactly one all-clear', async () => {
  reset({ marker: hoursAgo(3) });
  const before = world.marker;
  const out = await withProject(TRUE_KEY, () => runHandler());
  if (out.threw) return 'the recovery run threw: ' + out.threw.message;
  if (world.telegram.length !== 1) return 'sent ' + world.telegram.length + ' messages, not 1';
  const text = world.telegram[0];
  if (!/reach its database again/.test(text)) return 'the notice does not say what changed: ' + text.slice(0, 200);
  if (!/3 hours/.test(text)) return 'the notice does not say how long the silence was: ' + text.slice(0, 240);
  if (text.indexOf(before.slice(0, 16).replace('T', ' ')) === -1) return 'the notice does not name the last healthy time';
  if (text.indexOf(TRUE_KEY) !== -1) return 'THE KEY IS IN THE ALL-CLEAR';
  if (!/recovered/.test(String(out.res && out.res.body))) return 'the run does not report the recovery: ' + String(out.res && out.res.body);
  return true;
});

await check('and the marker is written AFTER the notice, so the next hour cannot repeat it', async () => {
  if (world.events.join(',') !== 'alert,mark') return 'the order was ' + world.events.join(',') + ' — a crash after mark would lose the notice';
  const second = await withProject(TRUE_KEY, () => runHandler());
  if (second.threw) return second.threw.message;
  if (world.telegram.length !== 1) return 'the NEXT healthy hour sent another all-clear';
  /* Two healthy runs, two marker writes — the second run kept the
     marker fresh without speaking. Compared by COUNT, not by value:
     both runs finish inside the same millisecond on a fast machine and
     the ISO string would be identical. */
  return world.writes.length === 2 ? true : 'the marker was not refreshed (' + world.writes.length + ' writes)';
});

await check('a FAILING hour writes no marker at all \u2014 the gap is how the recovery is known', async () => {
  reset({ marker: hoursAgo(5) });
  const before = world.marker;
  const out = await withProject(OTHER_KEY, () => runHandler());
  if (!out.threw) return 'the failed run reported success';
  if (world.telegram.length !== 1) return 'sent ' + world.telegram.length + ' messages, not the one failure alert';
  if (world.writes.length) return 'a failing hour wrote ' + world.writes.length + ' marker(s)';
  return world.marker === before ? true : 'the marker moved during a failure';
});

await check('a project with no marker table is still a green hour, and invents no recovery', async () => {
  reset({ stateMissing: true });
  const out = await withProject(TRUE_KEY, () => runHandler());
  if (out.threw) return 'a healthy run threw because bookkeeping was unavailable: ' + out.threw.message;
  if (world.telegram.length) return 'it sent an all-clear it could not justify';
  return /"recovered":false/.test(String(out.res && out.res.body)) ? true : String(out.res && out.res.body);
});

await check('the marker read and write never carry the key in their URL, and the all-clear never quotes it', async () => {
  const stateRequests = world.requests.filter((r) => r.indexOf('ops_database_health') !== -1 || /finance_config\?on_conflict/.test(r));
  if (stateRequests.some((r) => r.indexOf('TESTONLY') !== -1)) return 'a key reached a request line: ' + stateRequests.join(' | ');
  return world.telegram.every((t) => t.indexOf('TESTONLY') === -1) ? true : 'a key reached a message';
});

/* ------------------------------------------------------------ */

console.log('\ndeploy-key/db-health probe \u2014 ' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
process.exitCode = failures.length ? 1 : 0;
