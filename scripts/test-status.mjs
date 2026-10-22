#!/usr/bin/env node
/* ============================================================
   Arzuz — the public status page

   netlify/functions/status.js is the only thing that turns a typed
   reference and a phone number into somebody's stage, so every claim
   its header makes is driven here as the caller who would try to
   break it:

     · the ONE ANSWER — a malformed reference, a reference nobody
       minted, a phone number that is not the one on the file, and a
       code that really is on its way are BYTE-FOR-BYTE the same
       response. That is the property that makes the lookup useless
       for enumerating references, and it is the one a later "helpful"
       error message would destroy.
     · the count happens BEFORE the reference is looked at, so a
       broken throttle cannot become an oracle: the assertion is that
       the registry was never queried.
     · the answer that differs (429) depends only on the caller.
     · a code is never asked for, stored, or logged in the clear: the
       hash sent to the database is 64 hex characters and the digits
       appear in NO request body — only in the WhatsApp message.
     · the whole happy path, through the interface a student uses: read
       the code out of the message that was sent, type it back, and get
       the stage.
     · the reveal carries the stage and nothing personal — asserted on
       the serialised answer, so a column added later is caught.

   The stand-ins are three: a small PostgREST for the four paths this
   function uses, an OpenWA that records the message instead of sending
   it, and a Resend that records the email instead of sending it.
   Neither reads the network, and every environment the suite tests is
   one it builds itself.

   Run from arzuz-site/:
     node scripts/test-status.mjs
   ============================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Runs a page script in a bare context, so a VALUE it defines can be read
   instead of a phrase searched for in its source. assets/status.js touches
   nothing at load — every DOM call is inside a function — so this is the
   file as a browser would read it, minus the browser. */
function pageValue() {
  const vm = require('node:vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(SITE, 'assets/status.js'), 'utf8'), ctx);
  return ctx.ArzuzStatus;
}

/* Line and block comments out, so a rule can be asserted on the code
   without the paragraph explaining the rule failing it. */
function withoutComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

const OPENWA = 'https://openwa.stand-in';
process.env.SUPABASE_URL = 'https://stand-in.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stand-in-service-role-key';
process.env.OPENWA_URL = OPENWA;
process.env.OPENWA_API_KEY = 'openwa-stand-in-key';
process.env.OPENWA_SESSION = 'ARZUZ';
process.env.RESEND_API_KEY = 'resend-stand-in-key';

const status = require('../netlify/functions/status.js');

/* ---------------- the stand-ins ---------------- */

function resp(statusCode, body) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

/* The address on the file is stored the way the student TYPED it, mixed
   case and all — the door stores what was typed (see the email note in
   netlify/functions/waitlist.js), so the matching has to be
   case-insensitive or a student is locked out of their own record by
   their own capital letters. */
const STUDENT_MAIL = 'Amaka.Student@Example.com';
const STUDENT_MAIL_LOWER = 'amaka.student@example.com';

const STUDENT = {
  ref: 'ARZ-S-4F7A-2C9B-1D3E',
  payload: {
    first: 'Amaka', phone: '08031234567', email: STUDENT_MAIL, age: '18 to 20',
    consent: 'yes', roommate: 'no',
  },
  status: 'open',
  follow_up_status: 'new',
};

/* A number this site cannot address: jidFor() only speaks for a
   Nigerian mobile in international form, and a student who typed a
   foreign line gets a row whose phone is fine and unroutable. The
   email fallback is what makes that recoverable instead of silent. */
const FOREIGN = {
  ref: 'ARZ-S-5A6B-7C8D-9E0F',
  payload: { first: 'Tunde', phone: '+233201234567', email: 'tunde@example.com' },
  status: 'open',
  follow_up_status: 'new',
};

const LANDLORD = {
  ref: 'ARZ-L-1A2B-3C4D-5E6F',
  payload: { nm: 'Blessing Lodge', ph: '08039998888', prop_name: 'Blessing Lodge' },
  status: 'pending',
  follow_up_status: 'new',
  tier: 0,
};

const state = {
  throttle: { allow: true },
  throttleFails: false,
  kind: 'demand_records',
  row: STUDENT,
  signedOut: false,          // the registry knows nothing (an unknown reference)
  open: { ok: true, code_id: 11, expires_at: '2026-10-15T22:10:00Z', issued_this_hour: 1 },
  storedHash: null,          // what status_open "wrote"
  verifyFails: false,
  verifyReason: null,        // force one of the three refusals status_verify can give
  noRowBehindIt: false,      // the code was right and the row is gone
  messages: [],              // what OpenWA was asked to send
  mails: [],                 // what Resend was asked to send
  mailFails: 0,              // make the stand-in Resend refuse with this status
  openCalls: [],
  verifyCalls: [],
  throttleCalls: [],
  deliveries: [],            // what the delivery trail was told, in order
  deliveryFails: 0,          // make the stand-in trail refuse with this status
  deliveryRefuses: false,    // …or answer {ok:false} with a 200
  requests: [],
};

function reset(over) {
  state.throttle = { allow: true };
  state.throttleFails = false;
  state.kind = 'demand_records';
  state.row = STUDENT;
  state.signedOut = false;
  state.open = { ok: true, code_id: 11, expires_at: '2026-10-15T22:10:00Z', issued_this_hour: 1 };
  state.storedHash = null;
  state.verifyFails = false;
  state.verifyReason = null;
  state.noRowBehindIt = false;
  state.messages = [];
  state.mails = [];
  state.mailFails = 0;
  state.openCalls = [];
  state.verifyCalls = [];
  state.throttleCalls = [];
  state.deliveries = [];
  state.deliveryFails = 0;
  state.deliveryRefuses = false;
  state.requests = [];
  Object.assign(state, over || {});
}

/* The reveal the real function builds in SQL, built here from the row
   so that the shape the page prints is exercised rather than invented. */
function revealFor() {
  const r = state.row;
  return {
    ref: r.ref,
    kind: state.kind === 'listings' ? 'landlord' : 'student',
    state: r.status,
    stage: r.follow_up_status,
    received_at: '2026-10-14T09:00:00Z',
    verified_at: null,
    tier: state.kind === 'listings' ? (r.tier === undefined ? 0 : r.tier) : null,
    roommate: ((r.payload || {}).roommate || '') === 'yes',
  };
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  state.requests.push(method + ' ' + u);

  if (u.indexOf('/api/sessions/') !== -1 && u.indexOf('/messages/send-text') !== -1) {
    state.messages.push(body);
    return resp(200, { ok: true });
  }

  /* The second channel's provider. notify.js owns the request shape;
     this only records it, so the suite can read the code out of the
     mail the way it reads it out of the WhatsApp message. */
  if (u.indexOf('api.resend.com/emails') !== -1) {
    state.mails.push(body);
    if (state.mailFails) return resp(state.mailFails, { message: 'the stand-in mailer refused' });
    return resp(200, { id: 'stand-in-mail' });
  }

  if (u.indexOf('/rest/v1/rpc/status_throttle') !== -1) {
    state.throttleCalls.push(body);
    if (state.throttleFails) return resp(500, { message: 'the stand-in is unwell' });
    return resp(200, state.throttle);
  }

  if (u.indexOf('/rest/v1/rpc/status_open') !== -1) {
    state.openCalls.push(body);
    if (state.open.ok) state.storedHash = body.p_code_hash;
    return resp(200, state.open);
  }

  /* The desk's record — supabase-status-history.sql's writer. Only the
     CALLS are recorded here; what makes them legitimate is the schema's
     own CHECK, which dev/sql-proof.mjs section 13h drives. */
  if (u.indexOf('/rest/v1/rpc/status_code_delivery') !== -1) {
    state.deliveries.push(body);
    if (state.deliveryFails) return resp(state.deliveryFails, { message: 'the stand-in is unwell' });
    if (state.deliveryRefuses) return resp(200, { ok: false, reason: 'no-code' });
    return resp(200, { ok: true, id: state.deliveries.length, at: '2026-10-16T09:00:00Z' });
  }

  if (u.indexOf('/rest/v1/rpc/status_verify') !== -1) {
    state.verifyCalls.push(body);
    if (state.verifyFails) return resp(500, { message: 'the stand-in is unwell' });
    if (state.verifyReason) return resp(200, { ok: false, reason: state.verifyReason });
    if (state.noRowBehindIt) return resp(200, { ok: false, reason: 'gone' });
    if (!state.storedHash) return resp(200, { ok: false, reason: 'no-code' });
    if (body.p_code_hash !== state.storedHash) return resp(200, { ok: false, reason: 'wrong' });
    state.storedHash = null;
    return resp(200, { ok: true, reason: 'matched', reveal: revealFor() });
  }

  if (u.indexOf('/rest/v1/waitlist_ref_registry') !== -1) {
    return resp(200, state.signedOut ? [] : [{ kind: state.kind }]);
  }

  if (/\/rest\/v1\/(demand_records|listings)\?/.test(u) && method === 'GET') {
    return resp(200, state.row ? [{ ref: state.row.ref, payload: state.row.payload }] : []);
  }

  return resp(404, { message: 'the stand-in does not know ' + u });
};

/* ---------------- driving the handler ---------------- */

function event(payload, headers) {
  return {
    httpMethod: 'POST',
    headers: Object.assign({ 'x-nf-client-connection-ip': '203.0.113.10' }, headers || {}),
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function parsed(res) { return JSON.parse(res.body); }

const GOOD_REF = STUDENT.ref;
const GOOD_PHONE = '08031234567';

async function send(over, headers) {
  return status.handler(event(Object.assign({ step: 'send', ref: GOOD_REF, phone: GOOD_PHONE }, over || {}), headers));
}
async function verify(over) {
  return status.handler(event(Object.assign({ step: 'verify', ref: GOOD_REF, code: '000000' }, over || {})));
}

/* ---------------- tiny test runner ---------------- */

let passed = 0;
const failures = [];

async function t(name, body) {
  try {
    await body();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message));
  }
}

console.log('Arzuz status page \u2014 the lookup, driven as an enumerator\n');

/* ============================================================
   1 · THE SHAPE OF THE DOOR
   ============================================================ */

await t('a GET is refused: a lookup is a POST', async () => {
  const res = await status.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 405);
});

await t('without a service key it answers 503 not-ready, and does NOT say "no such reference"', async () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await send();
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  assert.equal(res.statusCode, 503);
  assert.equal(parsed(res).kind, 'not-ready',
    'the page branch on the class, not the digit — a bare 503 reads as "we are unwell"');
});

await t('an unknown step is refused, and nothing is looked up', async () => {
  reset();
  const res = await status.handler(event({ step: 'delete', ref: GOOD_REF, phone: GOOD_PHONE }));
  assert.equal(res.statusCode, 400);
  assert.equal(state.requests.length, 0, 'the request reached the database');
});

await t('an unreadable body is a refusal with a sentence', async () => {
  const res = await status.handler(event('{not json'));
  assert.equal(res.statusCode, 400);
  assert.ok(parsed(res).error);
});

await t('the honeypot costs no database call at all', async () => {
  reset();
  const res = await send({ hp: 'gotcha' });
  assert.equal(res.statusCode, 400);
  assert.equal(state.requests.length, 0, 'a bot got as far as the throttle: ' + state.requests.join(', '));
});

/* ============================================================
   2 · THE ONE ANSWER — the property the whole endpoint rests on
   ============================================================ */

await t('a reference it has never seen, a malformed reference, a wrong number and a REAL one all answer the same', async () => {
  reset();
  const bodies = [];

  /* a reference nobody minted */
  reset({ signedOut: true });
  const unknown = await send();
  bodies.push(['unknown reference', unknown]);

  /* something that is not a reference at all */
  reset();
  const malformed = await send({ ref: 'hello' });
  bodies.push(['malformed', malformed]);

  /* the reference is real and the number is not the one on the file */
  reset();
  const wrongPhone = await send({ phone: '08030000000' });
  bodies.push(['wrong phone', wrongPhone]);

  /* no phone at all */
  reset();
  bodies.push(['no phone', await send({ phone: '' })]);

  /* AND THE REAL PAIR — the code really does go out */
  reset();
  const real = await send();
  bodies.push(['the real pair', real]);

  assert.equal(state.messages.length, 1, 'the real pair did not send a code');

  const first = bodies[0][1];
  assert.equal(first.statusCode, 200);
  for (const [label, res] of bodies) {
    assert.equal(res.statusCode, first.statusCode,
      label + ' answered ' + res.statusCode + ' where an unknown reference answered ' + first.statusCode);
    assert.equal(res.body, first.body,
      label + ' answered differently from an unknown reference — that difference IS an oracle:\n      ' +
      res.body + '\n      vs\n      ' + first.body);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

await t('  …and none of those five answers carried the phone number, the name or the payload', async () => {
  reset();
  const res = await send();
  const text = res.body;
  for (const leak of ['08031234567', 'Amaka', 'self-contain', '18 to 20', STUDENT_MAIL]) {
    assert.equal(text.indexOf(leak), -1, 'the answer carries ' + leak);
  }
});

await t('and the sentence it carries is the one assets/status.js prints, to the letter', () => {
  /* The VALUE, read out of the page by running it — not a text search of
     its source, which cannot see through a two-literal concatenation and
     would pass a page whose sentence had been reworded. */
  const page = pageValue();
  assert.equal(page.SENT_ANYWAY, status.SENT_ANYWAY,
    'the page and the function disagree about what a held answer says — one of them is the version ' +
    'a student reads, and it must be the same sentence');
});

/* ============================================================
   3 · THE COUNT, AND WHY IT HAPPENS FIRST
   ============================================================ */

await t('the throttle is asked about the STEP, with the step\u2019s own count', async () => {
  reset();
  await send();
  assert.equal(state.throttleCalls.length, 1, 'the send step did not call the throttle exactly once');
  assert.equal(state.throttleCalls[0].p_scope, 'send');

  reset();
  await verify();
  assert.equal(state.throttleCalls.length, 1, 'the verify step did not call the throttle exactly once');
  assert.equal(state.throttleCalls[0].p_scope, 'verify',
    'both steps share one counter, so a student typing a code would be waiting out the search that sent it');
});

await t('the ceilings are the deploy\u2019s, clamped, and not a literal inside the function', async () => {
  reset();
  await send();
  assert.equal(state.throttleCalls[0].p_max_per_hour, status.cfg().maxPerHour);
  assert.equal(state.throttleCalls[0].p_global_per_hour, status.cfg().globalPerHour);
  const before = process.env.STATUS_MAX_PER_HOUR;
  process.env.STATUS_MAX_PER_HOUR = '3';
  assert.equal(status.cfg().maxPerHour, 3, 'the environment variable does not reach the ceiling');
  process.env.STATUS_MAX_PER_HOUR = '99999';
  assert.equal(status.cfg().maxPerHour, 500, 'the ceiling is not clamped, so a typo could open the door');
  if (before === undefined) delete process.env.STATUS_MAX_PER_HOUR; else process.env.STATUS_MAX_PER_HOUR = before;
});

await t('the caller\u2019s address reaches the database as a hash, never as an address', async () => {
  reset();
  await send({}, { 'x-nf-client-connection-ip': '203.0.113.10' });
  const ip = state.throttleCalls[0].p_ip_hash;
  assert.match(ip, /^[0-9a-f]{40}$/);
  assert.equal(ip.indexOf('203.0.113.10'), -1, 'the address itself is in the throttle call');
});

await t('a refused lookup is 429 busy, and it says nothing about the reference', async () => {
  reset({ throttle: { allow: false, reason: 'hour', used: 10, limit: 10 } });
  const res = await send({ ref: 'ARZ-S-0000-0000-0000' });
  assert.equal(res.statusCode, 429);
  assert.equal(parsed(res).kind, 'busy');
  assert.equal(state.requests.filter((r) => r.indexOf('waitlist_ref_registry') !== -1).length, 0,
    'a throttled lookup still touched the registry — the ceiling is meant to come first');
  assert.equal(state.messages.length, 0, 'a throttled lookup sent a message');
});

await t('\u2026and a refused lookup of a REAL reference and a FAKE one answer identically', async () => {
  reset({ throttle: { allow: false, reason: 'hour' } });
  const fake = await send({ ref: 'ARZ-S-0000-0000-0000' });
  reset({ throttle: { allow: false, reason: 'hour' } });
  const real = await send();
  assert.equal(fake.body, real.body, 'the throttle answer differs by reference, so it is an oracle');
});

await t('a throttle that cannot answer is a 502 — and the reference is STILL never looked at', async () => {
  reset({ throttleFails: true });
  const res = await send();
  assert.equal(res.statusCode, 502);
  assert.equal(state.requests.filter((r) => r.indexOf('waitlist_ref_registry') !== -1).length, 0,
    'the failure path read the registry, so "the database is unwell" would differ by reference');
  assert.equal(state.messages.length, 0);
});

await t('an unwell database cannot be turned into a phone oracle either', async () => {
  /* The same 502 for a reference that does and does not exist: the
     answer depends on the database, never on the reference. */
  reset({ throttleFails: true });
  const known = await send();
  reset({ throttleFails: true });
  const unknown = await send({ phone: '08030000000' });
  assert.equal(known.body, unknown.body);
});

/* ============================================================
   4 · THE CODE — issued, hidden, and never in the clear
   ============================================================ */

await t('the real pair puts a six-digit code on the number of record', async () => {
  reset();
  await send();
  assert.equal(state.messages.length, 1);
  const msg = state.messages[0];
  assert.equal(msg.chatId, '2348031234567@c.us', 'the code went somewhere other than the number on the file');
  const digits = (String(msg.text).match(/\d{6}/) || [])[0];
  assert.ok(digits, 'no code in the message: ' + msg.text);
});

await t('the code is NOT in the message as a reference, and the reference is NOT in the message', async () => {
  reset();
  await send();
  const msg = state.messages[0];
  assert.equal(String(msg.text).indexOf(GOOD_REF), -1,
    'the message carries the reference — a lock-screen preview would then hand over the handle');
  assert.ok(/Arzuz/i.test(msg.text), 'the message does not say who it is from');
  assert.ok(/expires/i.test(msg.text), 'the message does not say how long it lives');
});

await t('what reaches the database is a 64-character hash, never the code', async () => {
  reset();
  await send();
  const code = (String(state.messages[0].text).match(/\d{6}/) || [])[0];
  assert.equal(state.openCalls.length, 1, 'status_open was not called exactly once');
  const call = state.openCalls[0];
  assert.equal(call.p_ref, GOOD_REF);
  assert.match(call.p_code_hash, /^[0-9a-f]{64}$/, 'the stored value is not a sha256 digest');
  assert.equal(call.p_code_hash.indexOf(code), -1, 'the code is inside the hash column in the clear');
  for (const req of state.requests) {
    assert.equal(req.indexOf(code), -1, 'the code appears in a request line: ' + req);
  }
});

await t('two codes for the same reference hash differently — the ref and the salt are both in it', async () => {
  reset();
  await send();
  const first = state.openCalls[0].p_code_hash;
  reset();
  state.storedHash = null;
  await send();
  assert.notEqual(state.openCalls[0].p_code_hash, first);
});

await t('the salt is the service key: the same code under a different deploy hashes differently', async () => {
  reset();
  await send();
  const before = state.openCalls[0].p_code_hash;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'another-deploy-key';
  reset();
  await send();
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  assert.notEqual(state.openCalls[0].p_code_hash, before,
    'the hash does not depend on the service key, so a copied database row would be a usable code ' +
    'on any deploy that could see it');
});

/* ============================================================
   5 · PROVING THE PHONE, AND THE ONE REFUSAL THAT MAY SPEAK
   ============================================================ */
/* (the email channel's half of the same story is section 6) */

await t('the per-reference ceiling is 429 — and only ever AFTER the pair is proved', async () => {
  /* A real pair, refused by the per-reference ceiling: honest and safe,
     because the caller already had to know the reference AND the number. */
  reset({ open: { ok: false, reason: 'ref_limited', used: 5, limit: 5 } });
  const res = await send();
  assert.equal(res.statusCode, 429);
  assert.equal(parsed(res).kind, 'busy');
  assert.ok(/that reference/i.test(parsed(res).error), 'the refusal does not say which ceiling it is: ' + res.body);

  /* The SAME state, reached with a phone number that is not on the file:
     the generic answer, always, because the pair was never proved. */
  reset({ open: { ok: false, reason: 'ref_limited', used: 5, limit: 5 } });
  const stranger = await send({ phone: '08030000000' });
  assert.equal(stranger.statusCode, 200);
  assert.equal(state.openCalls.length, 0, 'a reference ceiling was consulted for a pair that did not match');
});

await t('a sender that is down still answers the generic sentence — a matched pair must not be visible from outside', async () => {
  /* This is the case the naive design gets wrong: with OpenWA down, a
     real pair would answer "we could not send it" and a wrong phone
     number would answer the generic sentence, so the failure of a
     third party would turn this endpoint into a phone oracle. The
     answer must be the same one a wrong number gets, byte for byte. */
  reset();
  const cfgUrl = process.env.OPENWA_URL;
  const cfgKey = process.env.OPENWA_API_KEY;
  delete process.env.OPENWA_URL;
  delete process.env.OPENWA_API_KEY;
  const realPair = await send();
  process.env.OPENWA_URL = cfgUrl;
  process.env.OPENWA_API_KEY = cfgKey;

  reset();
  const wrongNumber = await send({ phone: '08030000000' });

  assert.equal(realPair.statusCode, 200,
    'a failed send answered ' + realPair.statusCode + ' — that difference is the oracle');
  assert.equal(realPair.body, wrongNumber.body,
    'a send that failed answers differently from a number that does not match');
  assert.equal(state.messages.length, 0, 'a message went out with no OpenWA configured');
});

await t('  …and the failure is loud in the log, because a silent one is a student waiting for nothing', async () => {
  /* The function's own answer cannot say it, so the log has to. Captured
     rather than guessed. THREE facts have to be in there now, and the
     middle one is the whole point of the fallback's logging: WhatsApp
     refused, the code still reached the student by email, and a code
     that reached NOBODY says so. A fallback that quietly saves every
     delivery is how a WhatsApp sender stays broken for a month. */
  const logs = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  const cfg = process.env.OPENWA_URL;
  delete process.env.OPENWA_URL;
  try {
    reset();
    await send();                                  // a record WITH an address — falls back
    reset({ kind: 'listings', row: LANDLORD });     // a record with none — reaches nobody
    await send({ ref: LANDLORD.ref, phone: '08039998888' });
  } finally {
    process.env.OPENWA_URL = cfg;
    console.error = realErr;
    console.log = realLog;
  }

  assert.ok(logs.some((e) => /refused the code for/.test(e)),
    'a WhatsApp send that failed was not logged: ' + JSON.stringify(logs));
  assert.ok(logs.some((e) => /went out for .*email/.test(e)),
    'the fallback delivered a code to a student and said nothing about it: ' + JSON.stringify(logs));
  assert.ok(logs.some((e) => /was issued but NOT sent/.test(e)),
    'a code that reached nobody at all was logged as nothing: ' + JSON.stringify(logs));
});

/* ============================================================
   6 · THE SECOND CHANNEL — the email, and the fallback that
       makes "WhatsApp is down" survivable
   ============================================================ */

async function sendMail(over, headers) {
  return status.handler(event(Object.assign({ step: 'send', ref: GOOD_REF, channel: 'email',
    email: STUDENT_MAIL }, over || {}), headers));
}

await t('the address on the file is read off whichever key it is on, and ONLY if we could send to it', () => {
  assert.equal(status.emailOnRecord({ payload: { email: STUDENT_MAIL } }), STUDENT_MAIL_LOWER);
  assert.equal(status.emailOnRecord({ payload: { mail: 'a@b.co' } }), 'a@b.co');
  assert.equal(status.emailOnRecord({ payload: { owner_email: 'c@d.co' } }), 'c@d.co');
  assert.equal(status.emailOnRecord({ payload: { phone: '08031234567' } }), '');
  assert.equal(status.emailOnRecord({ payload: { email: 'not an address' } }), '',
    'prose was taken as an address');
  assert.equal(status.emailOnRecord({ payload: { email: '08031234567@receipts.arzuz.com' } }), '',
    'a billing placeholder is a mailbox that nobody reads — a code sent there is a student waiting for ' +
    'nothing, silently');
  assert.equal(status.emailOnRecord(null), '');
});

await t('an address typed with spaces or capitals is the one on the file, and prose is not an address', () => {
  assert.equal(status.normaliseEmail('  ' + STUDENT_MAIL + ' '), STUDENT_MAIL_LOWER);
  assert.equal(status.normaliseEmail(STUDENT_MAIL_LOWER), STUDENT_MAIL_LOWER);
  for (const bad of ['', '   ', 'amaka', 'amaka@', '@example.com', 'amaka@example', 'a b@example.com',
    'amaka@example.com; drop table demand_records']) {
    assert.equal(status.normaliseEmail(bad), '', JSON.stringify(bad) + ' was taken as an address');
  }
});

await t('asking by email puts the code in the inbox — and NOT on WhatsApp', async () => {
  reset();
  const res = await sendMail();
  assert.equal(res.statusCode, 200);
  assert.equal(state.mails.length, 1, 'the email channel sent nothing at all');
  assert.equal(state.messages.length, 0, 'the email channel also sent a WhatsApp message');
  const mail = state.mails[0];
  assert.deepEqual(mail.to, [STUDENT_MAIL_LOWER], 'the code went to an address that is not the one on the file');
  assert.ok(/\d{6}/.test(mail.text), 'no code in the email: ' + mail.text);
  assert.equal(String(mail.text).indexOf(GOOD_REF), -1,
    'the email carries the reference — a forwarded mail would hand over the handle');
  assert.equal(res.body.indexOf(STUDENT_MAIL_LOWER), -1, 'the answer echoes the address back');
});

await t('the whole flow, as a student with a changed number does it: email, read the code, type it back', async () => {
  reset();
  await sendMail();
  const code = (String(state.mails[0].text).match(/\d{6}/) || [])[0];
  const out = parsed(await verify({ code: code }));
  assert.equal(out.ok, true);
  assert.equal(out.ref, GOOD_REF);
  assert.ok(out.headline && out.headline.length > 10, 'the reveal has no sentence: ' + JSON.stringify(out));
});

await t('an unknown reference, a wrong address, an address we do not hold, a record with no address and a REAL one all answer the same', async () => {
  const bodies = [];

  reset({ signedOut: true });
  bodies.push(['an unknown reference', await sendMail()]);

  reset();
  bodies.push(['an address that is not an address', await sendMail({ email: 'hello' })]);

  reset();
  bodies.push(['no address at all', await sendMail({ email: '' })]);

  reset();
  bodies.push(['an address that is not the one on the file', await sendMail({ email: 'someone@else.com' })]);

  reset({ kind: 'listings', row: LANDLORD });   // a record that has no address on it
  bodies.push(['a record with no address on file', await sendMail()]);

  reset();
  bodies.push(['the real pair', await sendMail()]);

  assert.equal(state.mails.length, 1, 'the real pair did not send an email');

  const first = bodies[0][1];
  for (const [label, res] of bodies) {
    assert.equal(res.statusCode, 200,
      label + ' answered ' + res.statusCode + ' where an unknown reference answered 200');
    assert.equal(res.body, first.body,
      label + ' answered differently from an unknown reference — that difference IS an oracle:\n      ' +
      res.body + '\n      vs\n      ' + first.body);
  }

  /* …AND THE SAME BYTES THE PHONE CHANNEL GETS. If the two channels
     differed, the answer would say which contacts a record has. */
  reset();
  const byPhone = await send();
  assert.equal(byPhone.body, first.body,
    'the email channel and the phone channel answer differently, so which contacts a record has is ' +
    'readable from outside');
});

await t('a record with no address on it gets nothing sent anywhere, and no code issued', async () => {
  reset({ kind: 'listings', row: LANDLORD });
  const res = await sendMail();
  assert.equal(res.statusCode, 200);
  assert.equal(state.mails.length, 0, 'an email went out for a record with no address on it');
  assert.equal(state.messages.length, 0);
  assert.equal(state.openCalls.length, 0, 'a code was ISSUED for a pair that was never proved');
});

await t('the per-reference ceiling is 429 on the email channel too — and only after the address is proved', async () => {
  reset({ open: { ok: false, reason: 'ref_limited', used: 5, limit: 5 } });
  const res = await sendMail();
  assert.equal(res.statusCode, 429);
  assert.equal(parsed(res).kind, 'busy');

  reset({ open: { ok: false, reason: 'ref_limited', used: 5, limit: 5 } });
  const stranger = await sendMail({ email: 'someone@else.com' });
  assert.equal(stranger.statusCode, 200, 'a ceiling was disclosed to a caller who had not proved the address');
  assert.equal(state.openCalls.length, 0, 'the ceiling was consulted for an address that did not match');
});

await t('both channels share ONE send counter, so switching channel cannot buy a second allowance', async () => {
  reset();
  await sendMail();
  assert.equal(state.throttleCalls.length, 1);
  assert.equal(state.throttleCalls[0].p_scope, 'send',
    'the email channel was given its own scope, so a caller doubles their ceiling by changing one field');
});

await t('WhatsApp down: the SAME code goes to the inbox on the same file, and the answer does not change', async () => {
  reset();
  const cfgUrl = process.env.OPENWA_URL;
  delete process.env.OPENWA_URL;
  const real = await send();
  process.env.OPENWA_URL = cfgUrl;

  assert.equal(state.messages.length, 0, 'a message went out with no OpenWA configured');
  assert.equal(state.mails.length, 1,
    'the code was issued and then lost: the fallback is what makes a WhatsApp outage survivable');
  const inMail = (String(state.mails[0].text).match(/\d{6}/) || [])[0];
  assert.ok(inMail, 'no code in the fallback email: ' + state.mails[0].text);

  /* and it is a REAL code: the one that arrived by email opens the file */
  assert.equal(parsed(await verify({ code: inMail })).ok, true);

  const realBody = real.body;
  reset();
  const wrongNumber = await send({ phone: '08030000000' });
  assert.equal(realBody, wrongNumber.body,
    'the fallback changed the reply, so "we delivered it by email instead" is readable from outside');
});

await t('a number this site cannot address at all falls back the same way, and the log says where it went', async () => {
  reset({ row: FOREIGN });
  const logs = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await send({ ref: FOREIGN.ref, phone: '+233201234567' });
  } finally {
    console.log = realLog;
    console.error = realErr;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(state.messages.length, 0, 'a WhatsApp message went to a number we cannot address');
  assert.equal(state.mails.length, 1, 'the fallback did not fire for a number we cannot address');
  assert.ok(logs.some((l) => /not one we can message/.test(l)),
    'an unroutable number was not logged: ' + JSON.stringify(logs));
  assert.ok(logs.some((l) => /went out/.test(l)),
    'the log does not say the code went out at all: ' + JSON.stringify(logs));
});

await t('a deploy with no mail provider issues NOTHING for an email request, and still answers the one sentence', async () => {
  reset();
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  let res;
  try {
    res = await sendMail();
  } finally {
    process.env.RESEND_API_KEY = key;
  }
  assert.equal(res.statusCode, 200);
  assert.equal(state.mails.length, 0);
  assert.equal(state.openCalls.length, 0,
    'a code was issued for a channel this deploy cannot deliver on, spending the ceiling that protects ' +
    'the person rather than this server');
  const body = parsed(res);
  assert.equal(body.held, true, 'a deploy with no mail provider left the page on a step it cannot use');
  assert.equal(body.note, status.SENT_ANYWAY, 'the answer is not the one sentence every other outcome gets');
});

await t('an email provider that refuses answers the one sentence, and never the provider\u2019s words', async () => {
  reset({ mailFails: 500 });
  const res = await sendMail();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.indexOf('stand-in mailer'), -1, 'the provider\u2019s own error reached the answer');
  assert.equal(state.messages.length, 0, 'the refusal on one channel silently changed to the other');
  assert.equal(parsed(res).held, true);
});

await t('the address never reaches the log — not on the happy path, not on a refusal', async () => {
  const logs = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    reset();
    await sendMail();
    reset({ mailFails: 500 });
    await sendMail();
    reset();
    const cfgUrl = process.env.OPENWA_URL;
    delete process.env.OPENWA_URL;
    await send();
    process.env.OPENWA_URL = cfgUrl;
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  const text = logs.join('\n').toLowerCase();
  assert.equal(text.indexOf('example.com'), -1,
    'an address reached the log, and a build-and-runtime log outlives the deploy:\n' + logs.join('\n'));
  assert.ok(logs.length > 0, 'nothing was logged at all, so this check proved nothing');
});

await t('the page offers the second channel, and its own copy names the channel it asks for', () => {
  const page = pageValue();
  assert.equal(page.CHANNELS.whatsapp.key, 'phone');
  assert.equal(page.CHANNELS.email.key, 'email');
  assert.match(page.CHANNELS.email.where, /email address you gave us/,
    'the line under the code box does not say where an emailed code goes');
  assert.equal(page.contactLooksUsable('email', 'amaka@example.com'), true);
  assert.equal(page.contactLooksUsable('email', '08031234567'), false,
    'a phone number was accepted as an email address, so the student spends an attempt on a 200 they ' +
    'cannot act on');
  assert.equal(page.contactLooksUsable('whatsapp', 'amaka@example.com'), false,
    'an email address was accepted as a phone number');
  assert.equal(page.contactLooksUsable('whatsapp', '0803 123 4567'), true);

  const html = readFileSync(join(SITE, 'status.html'), 'utf8');
  for (const id of ['stChWa', 'stChMail', 'stPhone', 'stEmail', 'stPhoneFld', 'stEmailFld', 'stWhere']) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1,
      'status.html has no #' + id + ' — the page paints or reads a node that is not in the document');
  }
});

/* ============================================================
   6b · THE DESK'S RECORD — where the office reads it in the morning

   supabase-status-history.sql keeps one row per attempt to deliver a
   code, and the Support Desk reads them from a screen instead of a
   build log. What is driven here is this file's half of that: which
   channel, which outcome, which word, and in what ORDER — and the two
   properties that make the record safe to keep at all:

     · it is written AFTER the student is answered, so a trail that
       cannot be written changes nothing they are told;
     · it carries no code, no number and no address — and the note is
       one of the SEVEN words the schema names, which is a guarantee
       about content that a "no @ and no seven digits" rule could not
       make (a name in a log passes that rule happily).
   ============================================================ */

const TRAIL_NOTES = ['openwa-refused', 'openwa-unreachable', 'openwa-unconfigured',
  'no-mail-on-file', 'mail-refused', 'mail-unconfigured', 'unrecorded'];
const TRAIL_OUTCOMES = ['sent', 'refused', 'unreachable'];

function assertTrailIsLegal(where) {
  state.deliveries.forEach((d, i) => {
    assert.ok(TRAIL_OUTCOMES.indexOf(d.p_outcome) !== -1,
      where + ': attempt ' + i + ' has outcome "' + d.p_outcome + '", which the schema does not allow');
    assert.ok(d.p_note === null || TRAIL_NOTES.indexOf(d.p_note) !== -1,
      where + ': attempt ' + i + ' has note "' + d.p_note + '", which the schema does not allow — it would ' +
      'be stored as unrecorded, losing the one word that says what to fix');
    assert.equal(d.p_channel === 'whatsapp' || d.p_channel === 'email', true,
      where + ': attempt ' + i + ' names channel "' + d.p_channel + '"');
  });
}

await t('a delivered code is recorded against its own row, on the channel it went out on', async () => {
  reset();
  await send();
  assert.equal(state.deliveries.length, 1,
    'nothing was recorded for a code that was sent: ' + JSON.stringify(state.deliveries));
  const row = state.deliveries[0];
  assert.equal(row.p_channel, 'whatsapp');
  assert.equal(row.p_outcome, 'sent');
  assert.equal(row.p_note, null, 'a successful send carried a reason for not succeeding');
  assert.equal(row.p_code_id, state.open.code_id,
    'the record is not against the code it is about, so the desk cannot tie it to a message');
  assertTrailIsLegal('a sent code');
});

await t('a number we cannot address is recorded as unreachable, and the fallback as a SECOND attempt', async () => {
  /* The story the desk could never read before: the phone was tried and
     could not be used, and the same code went to the mailbox instead.
     Two rows, in order — flattened into one "delivered on" column this
     would read "email", and nobody could tell the student why the
     message they were watching for never arrived. */
  reset({ row: FOREIGN });
  await send({ ref: FOREIGN.ref, phone: '+233201234567' });
  assert.equal(state.deliveries.length, 2,
    'the fallback was recorded as ' + state.deliveries.length + ' attempt(s) instead of two');
  assert.equal(state.deliveries[0].p_channel, 'whatsapp');
  assert.equal(state.deliveries[0].p_outcome, 'unreachable');
  assert.equal(state.deliveries[0].p_note, 'openwa-unreachable');
  assert.equal(state.deliveries[1].p_channel, 'email');
  assert.equal(state.deliveries[1].p_outcome, 'sent');
  assertTrailIsLegal('the fallback');
});

await t('a record with no address records that the fallback could not fire \u2014 rather than silence', async () => {
  /* The difference between "the message went somewhere they do not read"
     and "there was nowhere to send it" is the whole question the desk is
     trying to answer, so the second one is a row too. */
  reset({ kind: 'listings', row: LANDLORD });
  const cfg = process.env.OPENWA_URL;
  delete process.env.OPENWA_URL;
  try {
    await send({ ref: LANDLORD.ref, phone: '08039998888' });
  } finally {
    process.env.OPENWA_URL = cfg;
  }
  assert.equal(state.deliveries.length, 2,
    'a code that reached nobody left ' + state.deliveries.length + ' row(s)');
  assert.equal(state.deliveries[0].p_outcome, 'unreachable');
  assert.equal(state.deliveries[0].p_note, 'openwa-unconfigured',
    'a sender that is not set up was not recorded as the setup problem it is');
  assert.equal(state.deliveries[1].p_channel, 'email');
  assert.equal(state.deliveries[1].p_outcome, 'unreachable');
  assert.equal(state.deliveries[1].p_note, 'no-mail-on-file',
    'the record does not say the fallback had nowhere to go \u2014 which is the answer the desk needs');
  assertTrailIsLegal('a code that reached nobody');
});

await t('a mail provider that refuses is recorded as refused, and never in the provider\u2019s own words', async () => {
  reset({ mailFails: 500 });
  await sendMail();
  assert.equal(state.deliveries.length, 1);
  assert.equal(state.deliveries[0].p_channel, 'email');
  assert.equal(state.deliveries[0].p_outcome, 'refused');
  assert.equal(state.deliveries[0].p_note, 'mail-refused');
  assertTrailIsLegal('a refused mail');
});

await t('the trail carries no code, no number and no address \u2014 asserted on the bytes that were sent', async () => {
  reset();
  await send();
  /* Read the code out of the message BEFORE the next reset clears the
     stand-ins: it is the sharpest of the things that must not travel,
     because the record is ABOUT this code and still must not contain it. */
  const code = (String(state.messages[0] ? state.messages[0].text : '').match(/\d{6}/) || [])[0];
  assert.ok(code, 'this check could not read the code it is asserting about');

  reset({ row: FOREIGN });
  await send({ ref: FOREIGN.ref, phone: '+233201234567' });
  assert.ok(state.deliveries.length >= 2, 'the trail was not driven at all');

  const bytes = JSON.stringify(state.deliveries);
  for (const leak of [code, '08031234567', '+233201234567', STUDENT_MAIL, 'tunde@example.com', '@']) {
    assert.equal(bytes.indexOf(leak), -1,
      'the delivery trail was told ' + leak + ', which is a fact about a person rather than about a message');
  }
});

await t('a trail that cannot be written does not change what the student is told', async () => {
  /* It is recorded AFTER the request has been answered, so this is the
     property that matters most: a broken log line must never turn a
     delivered code into an error, and must never change the one
     sentence — which is also the answer that must not vary. */
  const logs = [];
  const realErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    reset();
    const good = await send();
    reset({ deliveryFails: 500 });
    const broken = await send();
    reset({ deliveryRefuses: true });
    const refused = await send();
    assert.equal(broken.statusCode, 200, 'a trail failure became a student-visible error: ' + broken.body);
    assert.equal(broken.body, good.body, 'a trail failure changed the answer, which is the oracle');
    assert.equal(refused.body, good.body, 'a trail refusal changed the answer, which is the oracle');
  } finally {
    console.error = realErr;
  }
  assert.ok(logs.some((l) => /delivery trail/.test(l)),
    'a trail that could not be written was logged as nothing: ' + JSON.stringify(logs));
});

/* ============================================================
   7 · THE CODE COMES BACK — and every failure looks the same
   ============================================================ */

await t('the whole flow, as a student does it: read the code out of the message and type it back', async () => {
  reset();
  const sent = await send();
  assert.equal(sent.statusCode, 200);
  const code = (String(state.messages[0].text).match(/\d{6}/) || [])[0];

  const res = await verify({ code: code });
  assert.equal(res.statusCode, 200, res.body);
  const out = parsed(res);
  assert.equal(out.ok, true);
  assert.equal(out.ref, GOOD_REF);
  assert.equal(out.kind, 'student');
  assert.equal(out.stage, 'new');
  assert.ok(out.headline && out.headline.length > 10, 'the reveal has no sentence: ' + res.body);
  assert.ok(Array.isArray(out.facts));
  assert.ok(out.facts.some((f) => /received it on/.test(f)), 'the reveal does not say when it arrived');
});

await t('the headline is the stage\u2019s own sentence, for every stage the vocabulary has', () => {
  for (const kind of ['student', 'landlord']) {
    for (const stage of ['new', 'contacted', 'interested', 'matched', 'closed']) {
      const words = status.HEADLINES[kind][stage];
      assert.ok(words && words.length > 10,
        'no sentence for ' + kind + '/' + stage + ' — a student whose file moved would be shown a bare word');
    }
  }
});

await t('a landlord\u2019s reference reads as a listing, tier and all', async () => {
  reset({ kind: 'listings', row: LANDLORD });
  await send({ ref: LANDLORD.ref, phone: '08039998888' });
  const msg = state.messages[0];
  assert.equal(msg.chatId, '2348039998888@c.us');
  const code = (String(msg.text).match(/\d{6}/) || [])[0];
  const res = await verify({ ref: LANDLORD.ref, code: code });
  const out = parsed(res);
  assert.equal(out.kind, 'landlord');
  assert.equal(out.tier, 0);
  assert.ok(out.facts.some((f) => /not been checked/i.test(f)),
    'a tier-0 listing did not say it is unchecked: ' + JSON.stringify(out.facts));
});

await t('a wrong code, an expired code and one with no attempts left answer the SAME thing', async () => {
  /* The three reasons supabase-status-codes.sql can give, and ONE answer
     for all of them. A caller holding a leaked reference could
     otherwise learn from the difference whether a code had ever been
     issued for it — a fact about a real person, not about the caller. */
  const answers = [];
  for (const reason of ['wrong', 'no-code', 'too-many']) {
    reset({ verifyReason: reason });
    answers.push([reason, await verify({ code: '123456' })]);
  }
  assert.equal(answers.length, 3, 'this test is not covering all three refusals');
  const first = answers[0][1];
  assert.equal(first.statusCode, 400);
  for (const [reason, res] of answers) {
    assert.equal(res.body, first.body,
      '"' + reason + '" answered differently from "' + answers[0][0] + '":\n      ' + res.body +
      '\n      vs\n      ' + first.body);
  }
  assert.match(parsed(first).error, /not right, or it has expired/);
});

await t('  \u2026and a row that vanished behind a correct code says so, without inventing a stage', async () => {
  reset({ noRowBehindIt: true });
  await send();
  const code = (String(state.messages[0].text).match(/\d{6}/) || [])[0];
  const res = await verify({ code: code });
  assert.equal(res.statusCode, 400);
  assert.equal(parsed(res).ok, undefined);
});

await t('a six-digit code is required before anything is asked', async () => {
  reset();
  const res = await verify({ code: '12' });
  assert.equal(res.statusCode, 400);
  assert.equal(state.verifyCalls.length, 0, 'a two-digit code was sent to the database');
});


await t('the attempts ceiling is the CODE\u2019S, so no ceiling travels from this file at all', async () => {
  /* It used to be STATUS_MAX_ATTEMPTS, read here and sent with every
     verify. That gave one number two homes — what this path enforced and
     what the desk's screen could report — and it let a code issued before
     a settings change be judged after it. supabase-status-history.sql §1
     records the ceiling on the code and makes the row authoritative, so
     the assertion is the ABSENCE, whatever the environment happens to
     say. A future change that reads the variable again fails here. */
  reset();
  const before = process.env.STATUS_MAX_ATTEMPTS;
  process.env.STATUS_MAX_ATTEMPTS = '3';
  await verify({ code: '123456' });
  assert.equal(state.verifyCalls.length, 1, 'the verify was not driven at all');
  assert.equal('p_max_attempts' in state.verifyCalls[0], false,
    'this file still sends an attempts ceiling, so a deploy variable can disagree with the code\u2019s own');
  assert.equal('maxAttempts' in status.cfg(), false,
    'cfg() still reads an attempts ceiling, which is no longer where it comes from');
  if (before === undefined) delete process.env.STATUS_MAX_ATTEMPTS; else process.env.STATUS_MAX_ATTEMPTS = before;
});

await t('a verify that cannot answer is a 502, not a wrong code', async () => {
  reset({ verifyFails: true });
  const res = await verify();
  assert.equal(res.statusCode, 502, 'a database failure was reported as a wrong code: ' + res.body);
});

await t('the reveal carries the stage and NOTHING personal', async () => {
  reset();
  await send();
  const code = (String(state.messages[0].text).match(/\d{6}/) || [])[0];
  const res = await verify({ code: code });
  const text = res.body;
  for (const leak of ['08031234567', 'Amaka', '18 to 20', 'consent', STUDENT_MAIL]) {
    assert.equal(text.indexOf(leak), -1, 'the reveal carries ' + leak);
  }
  for (const key of ['phone', 'ph', 'payload', 'first', 'age', 'email']) {
    assert.equal(new RegExp('"' + key + '"').test(text), false, 'the reveal has a ' + key + ' key');
  }
});

/* ============================================================
   8 · THE REFERENCE, AS PEOPLE TYPE IT
   ============================================================ */

await t('a reference typed without dashes, or in lower case, is the same reference', () => {
  assert.equal(status.normaliseRef('arz-s-4f7a-2c9b-1d3e'), GOOD_REF);
  assert.equal(status.normaliseRef('ARZS4F7A2C9B1D3E'), GOOD_REF);
  assert.equal(status.normaliseRef('  arz s 4f7a 2c9b 1d3e '), GOOD_REF);
});

await t('anything that is not a reference normalises to empty, so it never reaches a lookup', () => {
  for (const bad of ['', '   ', 'ARZ-S-1234', 'ARZ-S-4F7A-2C9B-1D3', 'hello', 'ARZ-X-4F7A-2C9B-1D3E',
    'ARZ-S-4F7A-2C9B-1D3E; drop table demand_records']) {
    assert.equal(status.normaliseRef(bad), '', JSON.stringify(bad) + ' was taken as a reference');
  }
});

await t('a number is turned into the form OpenWA addresses, or refused', () => {
  assert.equal(status.jidFor('08031234567'), '2348031234567@c.us');
  assert.equal(status.jidFor('+2348031234567'), '2348031234567@c.us');
  assert.equal(status.jidFor('2348031234567'), '2348031234567@c.us');
  assert.equal(status.jidFor('8031234567'), '2348031234567@c.us');
  assert.equal(status.jidFor('12345'), null);
  assert.equal(status.jidFor('07044369875'), '2347044369875@c.us');
});

await t('two spellings of one number compare equal, which is what decides who may see the file', () => {
  assert.equal(status.phoneTail('0803 123 4567'), status.phoneTail('+2348031234567'));
  assert.equal(status.phoneTail('0803 123 4567'), status.phoneTail('234-803-123-4567'));
  assert.notEqual(status.phoneTail('08031234567'), status.phoneTail('08031234568'));
});

/* ============================================================
   9 · THE PAGE AND THE ROUTES
   ============================================================ */

await t('netlify.toml serves /status from status.html, and 301s the .html copy', () => {
  const toml = readFileSync(join(SITE, 'netlify.toml'), 'utf8');
  assert.match(toml, /from\s*=\s*"\/status"\s*\n\s*to\s*=\s*"\/status\.html"\s*\n\s*status\s*=\s*200/,
    '/status is not routed to the page');
  assert.match(toml, /from\s*=\s*"\/status\.html"\s*\n\s*to\s*=\s*"\/status"\s*\n\s*status\s*=\s*301/,
    '/status.html is not redirected to its canonical URL, so the page has two addresses');
});

await t('and it is noindexed with a header a crawler is guaranteed to read', () => {
  const toml = readFileSync(join(SITE, 'netlify.toml'), 'utf8');
  const block = toml.split('[[headers]]').find((b) => /for\s*=\s*"\/status\.html"/.test(b)) || '';
  assert.match(block, /X-Robots-Tag\s*=\s*"[^"]*noindex/,
    'the noindex header is missing — the meta tag alone is the copy that gets scraped away');
});

await t('the new SQL file has a hard 404 like every other one', () => {
  const toml = readFileSync(join(SITE, 'netlify.toml'), 'utf8');
  assert.match(toml, /from\s*=\s*"\/supabase\/\*"\s*\n\s*to\s*=\s*"\/404\.html"\s*\n\s*status\s*=\s*404\s*\n\s*force\s*=\s*true/,
    'the /supabase/* hard 404 is missing — supabase-status-codes.sql would be served to anyone who asks for it');
});

await t('the page loads the shared failure vocabulary and never stores the reference', () => {
  const html = readFileSync(join(SITE, 'status.html'), 'utf8');
  const code = withoutComments(readFileSync(join(SITE, 'assets/status.js'), 'utf8'));
  assert.match(html, /assets\/api-errors\.js/);
  assert.match(html, /assets\/status\.js/);
  assert.match(html, /ArzuzStatus\.mount\(\)/, 'nothing mounts the page');
  assert.match(html, /name="robots"[^>]*noindex/i, 'the page is indexable in the document itself');
  /* The CODE, not the prose: the file's own header says it stores
     nothing, and a check that fails on the sentence explaining the rule
     is a check that gets deleted instead of fixed. */
  for (const store of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB']) {
    assert.equal(code.indexOf(store), -1,
      'the page keeps something in ' + store + ' — a shared phone is the normal case, and a cached ' +
      'reference is a handle someone else can pick up');
  }
});

await t('the page moves to the code step for EVERY held answer, because that is where the oracle would be', () => {
  const page = readFileSync(join(SITE, 'assets/status.js'), 'utf8');
  assert.match(page, /state\.step = 'code'/,
    'the page no longer advances on a held answer — check that it is not branching on the reply');
  assert.equal(/data\.held\s*===/.test(page), false,
    'the page branches on the reply, which is the one thing that would turn it back into an oracle');
});

await t('the confirmation screen links here, with the reference already in the URL', () => {
  const app = readFileSync(join(SITE, 'assets/app.js'), 'utf8');
  assert.match(app, /href="\/status\?ref='\+encodeURIComponent\(res\.ref\)/,
    'nothing links the status page from the moment the reference is handed over — the page would ' +
    'exist and nobody would find it');
});

/* ---------------- report ---------------- */

if (failures.length) {
  console.log('\nFAIL: ' + failures.length);
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
console.log('status page \u2014 PASS ' + passed + ' \u00b7 FAIL ' + failures.length);
process.exit(failures.length ? 1 : 0);
