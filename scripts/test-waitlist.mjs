#!/usr/bin/env node
/* ============================================================
   Arzuz — the public waitlist door

   netlify/functions/waitlist.js is the only thing between an
   unauthenticated POST and a row in the waitlist, so every rule in
   spec §2 and §3 that is enforced there is driven here as the caller
   that would try to evade it:

     - the answer is never the row: no phone number, no name, no
       answers, and never the service key
     - the client cannot choose the state it lands in, no matter what
       it puts in `answers`
     - the honeypot costs no database write at all
     - a missing phone, a missing consent and an unreadable body are
       refusals WITH a sentence, because a person typed them
     - a 429 is the page's 'busy' class — the same vocabulary
       assets/submit.js reads, not a second guess at the number
     - a duplicate is a SUCCESS with the old reference, and it writes
       no second row and no second WhatsApp message
     - a throttle that cannot answer must NOT refuse a real student

   The stand-in below is a small PostgREST for the four paths this
   function uses. `assets/app.js` shows the applicant one sentence and
   the database records another — that drift is asserted against,
   because a consent record that does not say what the person agreed
   to is worse than none.

   Run from arzuz-site/:
     node scripts/test-waitlist.mjs
   ============================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.SUPABASE_URL = 'https://stand-in.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stand-in-service-role-key';

const waitlist = require('../netlify/functions/waitlist.js');

/* ---------------- the stand-in ---------------- */

function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const state = {
  throttle: { allow: true },
  throttleFails: false,
  rows: [],
  existing: null,
  existingAfter: null,
  /* The phone_tail fast path answers from its own fixture, so a test
     about the fifty-row scan is not accidentally proved by the index —
     and the race test below still races instead of being settled early
     by a tail hit it never meant to seed. */
  tailExisting: null,
  tailFails: false,
  lookups: 0,
  insertStatus: 201,
  ref: 'ARZ-S-1111-2222-3333',
  requests: [],
};

function reset(over) {
  state.throttle = { allow: true };
  state.throttleFails = false;
  state.rows = [];
  state.existing = null;
  state.existingAfter = null;
  state.tailExisting = null;
  state.tailFails = false;
  state.lookups = 0;
  state.insertStatus = 201;
  state.ref = 'ARZ-S-1111-2222-3333';
  state.requests = [];
  Object.assign(state, over || {});
}

const TABLE = '(demand_records|listings|scout_submissions|booking_requests|support_tickets)';

global.fetch = async function (url, init = {}) {
  const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push(method + ' ' + u);


  if (u.indexOf('/rest/v1/rpc/waitlist_throttle') !== -1) {
    if (state.throttleFails) return resp(500, { message: 'the stand-in is unwell' });
    return resp(200, state.throttle);
  }

  const insert = new RegExp('/rest/v1/' + TABLE + '$').exec(u);
  if (insert && method === 'POST') {
    state.rows.push({ table: insert[1], row: body, prefer: (init.headers || {}).Prefer || '' });
    if (state.insertStatus >= 400) return resp(state.insertStatus, { message: 'the stand-in refused', code: '23505' });
    return resp(201, [{ ref: state.ref, follow_up_status: 'new' }]);
  }

  /* The indexed tail lookup answers first and from its own fixture. A
     database that predates supabase-phone-tail.sql has no such column
     and refuses — tailFails models exactly that, so the fallback scan
     below is what gets exercised. */
  if (new RegExp('/rest/v1/' + TABLE + '\\?').test(u) && method === 'GET' && u.indexOf('phone_tail=eq.') !== -1) {
    if (state.tailFails) return resp(400, { message: 'column "phone_tail" does not exist', code: '42703' });
    return resp(200, state.tailExisting || []);
  }

  if (new RegExp('/rest/v1/' + TABLE + '\\?').test(u) && method === 'GET') {
    state.lookups += 1;
    return resp(200, state.lookups === 1 ? (state.existing || []) : (state.existingAfter || []));
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

function parsed(res) {
  return JSON.parse(res.body);
}

const STUDENT = {
  first: 'Amaka', phone: '08031234567', age: '18 to 20', type: 'Self-contain',
  budget: '₦150,000 – ₦200,000', dist: 'Near — under 10 min walk',
  when: 'This session', consent: 'yes', hp: '',
};

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

/* ============================================================
   1 · THE SHAPE OF THE DOOR
   ============================================================ */

console.log('Arzuz waitlist door \u2014 the public submission, driven as the caller\n');

await t('a GET is refused: a form submission is a POST', async () => {
  const res = await waitlist.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 405);
});

await t('without a service key it answers 503 not-ready, which is what makes the page HOLD the submission', async () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
    assert.equal(res.statusCode, 503);
    assert.equal(parsed(res).kind, 'not-ready');
    assert.equal(state.rows.length, 0, 'a not-ready door wrote a row');
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }
});

await t('an unknown form name is refused, so a caller cannot name a table it likes', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'pg_catalog', answers: STUDENT }));
  assert.equal(res.statusCode, 400);
  assert.equal(parsed(res).kind, 'rejected');
  assert.equal(state.rows.length, 0);
});

await t('a body that is not JSON is refused with a sentence, not with a status', async () => {
  reset();
  const res = await waitlist.handler(event('{not json'));
  assert.equal(res.statusCode, 400);
  assert.ok(parsed(res).error.length > 10);
});

/* ============================================================
   2 · THE HONEYPOT AND THE CONSENT
   ============================================================ */

await t('a filled honeypot is refused, and costs no database write at all', async () => {
  reset();
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { hp: 'http://spam.example' }),
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(state.rows.length, 0, 'a bot got as far as the insert');
  assert.ok(!state.requests.some((r) => r.indexOf('/rest/v1/rpc') !== -1), 'a bot was even offered a throttle slot');
});

await t('an empty honeypot is what every honest submission looks like', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.equal(res.statusCode, 200);
  assert.equal(state.rows.length, 1);
});

await t('no consent means no row — and the refusal names it', async () => {
  reset();
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { consent: '' }),
  }));
  assert.equal(res.statusCode, 400);
  assert.match(parsed(res).error, /agreement to be contacted/);
  assert.equal(state.rows.length, 0);
});

await t('an unreadable phone number is refused rather than stored', async () => {
  reset();
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { phone: 'call me sometime' }),
  }));
  assert.equal(res.statusCode, 400);
  assert.match(parsed(res).error, /ten digits/);
  assert.equal(state.rows.length, 0);
});

await t('a demand with no age band is refused, because that is what protects a minor', async () => {
  reset();
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { age: '' }),
  }));
  assert.equal(res.statusCode, 400);
  assert.match(parsed(res).error, /age/);
  assert.equal(state.rows.length, 0);
});

await t('an answer that is not text becomes empty rather than JSON in the database', async () => {
  reset();
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { pain: { nested: 'object' } }),
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(state.rows[0].row.payload.pain, '', 'a nested object reached jsonb');
});

/* ============================================================
   2b · THE ROOMMATE QUESTIONNAIRE — a sixth form, not a rename

   roommates.html asks for a name and a phone and never asks for an age
   band, and the student form is not allowed to give that up: the age band
   is what sets is_minor. So this is a form with its own question list
   landing in the same table, which is why the door has one entry whose
   NAME and TABLE differ.

   The failure it replaces was silent, which is why it is driven here: the
   page used to hand this questionnaire to the direct path AS a student
   registration, and the door — which requires an age band for that form —
   refused it. A student would have been told their answers were not
   accepted, and nothing would have been stored.
   ============================================================ */

const ROOMMATE = {
  name: 'Grace', phone: '08037654321', area: 'Malete',
  sleep: 'Early', clean: 'Very tidy', budget: '90000',
  consent: 'yes', hp: '',
};

await t('the roommate questionnaire is accepted with a name and a phone, and no age band', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'roommate_profiles', answers: ROOMMATE }));
  assert.equal(res.statusCode, 200);
  assert.equal(parsed(res).ref, state.ref);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].table, 'demand_records', 'it did not land in the waitlist table');
});

await t('and the name it collected is STORED as the key the dashboard reads', async () => {
  reset();
  await waitlist.handler(event({ form: 'roommate_profiles', answers: ROOMMATE }));
  const payload = state.rows[0].row.payload;
  /* payload->>'first' is the generated first_name column, so a row that
     kept the questionnaire's own `name` would arrive in the demands table
     with no name at all. */
  assert.equal(payload.first, 'Grace');
  assert.equal(payload.name, undefined, 'the questionnaire key was stored beside the mapped one');
  assert.equal(payload.roommate, 'yes', 'nothing marks the row as a roommate lead');
});

await t('it still refuses no consent, and still refuses a phone it cannot read', async () => {
  reset();
  const noConsent = await waitlist.handler(event({
    form: 'roommate_profiles', answers: Object.assign({}, ROOMMATE, { consent: '' }) }));
  assert.equal(noConsent.statusCode, 400);
  assert.equal(state.rows.length, 0);

  const noPhone = await waitlist.handler(event({
    form: 'roommate_profiles', answers: Object.assign({}, ROOMMATE, { phone: 'ask around' }) }));
  assert.equal(noPhone.statusCode, 400);
  assert.equal(state.rows.length, 0);
});

await t('and the client cannot choose the state it lands in, nor un-mark what it is', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'roommate_profiles',
    answers: Object.assign({}, ROOMMATE, { roommate: 'no', status: 'matched', env: 'test' }) }));
  assert.equal(res.statusCode, 200);
  const row = state.rows[0].row;
  assert.equal(row.status, 'open', 'the client chose the status');
  assert.equal(row.payload.roommate, 'yes', 'the client un-marked the row as a roommate lead');
  assert.equal(row.env, 'production', 'the client chose the environment');
});

/* ============================================================
   2c · THE OPTIONAL EMAIL — the second channel's supply

   Every public form now asks for an email address and none of them
   requires one. It is there because the phone is the contact a student
   is most likely to have changed, and the status page can send its
   code to an inbox instead (netlify/functions/status.js). So the door
   owes exactly two things: a blank is fine, and a value that is stored
   is one the second channel can actually be opened with.
   ============================================================ */

/* The same reader the status page uses, required here rather than
   re-implemented: the point of this section is the SEAM between the two
   files, and a copy of the rule would agree with a wrong door. */
const status = require('../netlify/functions/status.js');

await t('a form with no email at all is accepted, and the row carries none', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.rows.length, 1, 'an optional field became a required one');
  assert.equal(state.rows[0].row.payload.email, undefined, 'an address nobody typed reached the row');
});

await t('a good address is stored, exactly as the student typed it', async () => {
  reset();
  const typed = 'Amaka.Student@Example.com';
  const res = await waitlist.handler(event({ form: 'demand_records',
    answers: Object.assign({}, STUDENT, { email: typed }) }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.rows[0].row.payload.email, typed,
    'the door rewrote a contact — reformatting one is how a message stops arriving');
});

await t('and what the door stored is an address the SECOND CHANNEL can open the record with', async () => {
  /* The seam, asserted rather than assumed: the value that reached the
     row is fed to the status page's own reader, which is the only
     thing that decides whether a code can be emailed at all. */
  const row = state.rows[0].row;
  assert.equal(status.emailOnRecord(row), 'amaka.student@example.com',
    'the door accepted an address the status page would not use, so the second channel would be ' +
    'offered to a student and then silently do nothing');
});

await t('an address that is not one is refused, with a sentence that says what to do', async () => {
  for (const bad of ['amaka', 'amaka@', '@example.com', 'amaka at example.com', 'amaka@example']) {
    reset();
    const res = await waitlist.handler(event({ form: 'demand_records',
      answers: Object.assign({}, STUDENT, { email: bad }) }));
    assert.equal(res.statusCode, 400, JSON.stringify(bad) + ' was stored: ' + res.body);
    assert.match(parsed(res).error, /email address does not look complete/,
      'the refusal does not say what is wrong: ' + res.body);
    assert.equal(state.rows.length, 0, JSON.stringify(bad) + ' reached the table');
  }
});

await t('and the addresses this site INVENTS are refused, because no code sent there is ever read', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'demand_records',
    answers: Object.assign({}, STUDENT, { email: '08031234567@receipts.arzuz.com' }) }));
  assert.equal(res.statusCode, 400);
  assert.equal(state.rows.length, 0);
});

await t('every form that asks for an email marks it OPTIONAL, because the engine requires a field with no fourth element', async () => {
  /* This one is not about the door at all — it is about the form engine
     the door's three pages use. `isFieldRequired()` in assets/app.js
     returns true for any field with no `{opt:true}`, so an email spec
     written the obvious way makes an address the door never asks for a
     WALL in front of a student who does not have one. That is how this
     was first written, and the only reason it was caught is that the
     form was driven in a browser; this is the check that keeps it from
     coming back. */
  const offenders = [];
  for (const page of ['register.html', 'owner-list.html', 'assets/roommate.js']) {
    const src = readFileSync(join(SITE, page), 'utf8');
    const m = src.match(/\[\s*['"]email['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]email['"]([^\]]*)\]/);
    if (!m) { offenders.push(page + ' (no email field found)'); continue; }
    if (!/\{\s*opt\s*:\s*true\s*\}/.test(m[1])) {
      offenders.push(page + ' — ' + m[0].replace(/\s+/g, ' '));
    }
  }
  assert.equal(offenders.length, 0,
    'an optional field the door does not require would block a student who has no address: ' +
    offenders.join(' | '));
});

await t('the roommate questionnaire and the landlord listing take one too — it is the FORMS\u2019 field, not the student\u2019s', async () => {
  reset();
  const rm = await waitlist.handler(event({ form: 'roommate_profiles',
    answers: Object.assign({}, ROOMMATE, { email: 'tunde@example.com' }) }));
  assert.equal(rm.statusCode, 200, rm.body);
  assert.equal(status.emailOnRecord(state.rows[0].row), 'tunde@example.com');

  reset();
  const ll = await waitlist.handler(event({ form: 'listings',
    answers: { nm: 'Owner', ph: '08031234567', rent: '150000', ar: 'Malete', ty: 'Self-contain',
      rm: '1', consent: 'yes', hp: '', email: 'owner@example.com' } }));
  assert.equal(ll.statusCode, 200, ll.body);
  assert.equal(status.emailOnRecord(state.rows[0].row), 'owner@example.com');
});

/* ============================================================
   3 · WHAT THE CLIENT CANNOT DECIDE
   ============================================================ */

await t('a student cannot post itself as already matched', async () => {
  reset();
  await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { status: 'matched', env: 'test' }),
  }));
  const row = state.rows[0].row;
  assert.equal(row.status, 'open', 'the client chose the approval state');
  assert.equal(row.env, 'production', 'the client could hide its own row from every production view');
  assert.equal(row.payload.hp, '');
});

await t('and a landlord cannot post itself straight onto the browse feed', async () => {
  reset();
  await waitlist.handler(event({
    form: 'listings',
    answers: { nm: 'Owner', ph: '08031234567', rent: '150000', ar: 'Malete', ty: 'Self-contain', rm: '1', consent: 'yes', hp: '', status: 'active', tier: 2 },
  }));
  const row = state.rows[0].row;
  assert.equal(row.status, 'pending');
  assert.equal(row.tier, 0);
});

await t('a reference the client sends is not the reference it gets', async () => {
  reset({ ref: 'ARZ-S-9999-8888-7777' });
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: Object.assign({}, STUDENT, { ref: 'ARZ-S-0000-0000-0001' }),
  }));
  assert.equal(parsed(res).ref, 'ARZ-S-9999-8888-7777', 'the caller chose its own handle');
  assert.equal(state.rows[0].row.ref, undefined, 'a ref was sent in the row');
});

await t('the answer is never the row: no phone number, no name, no service key', async () => {
  reset();
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.ok(res.body.indexOf('08031234567') === -1, 'the response echoed a phone number');
  assert.ok(res.body.indexOf('Amaka') === -1, 'the response echoed a name');
  assert.ok(res.body.indexOf('service-role') === -1, 'the response leaked the key');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow');
});

await t('the consent the database records is the sentence the function owns, not the page\u2019s', async () => {
  reset();
  await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  const row = state.rows[0].row;
  assert.equal(row.consent_text, waitlist.CONSENT_TEXT);
  assert.ok(row.consent_at, 'consent was agreed to and not timestamped');
  assert.equal(row.payload.consent, 'yes');
});

await t('and assets/app.js shows the applicant that same sentence, word for word', async () => {
  const app = readFileSync(join(SITE, 'assets', 'app.js'), 'utf8');
  assert.ok(
    app.indexOf(waitlist.CONSENT_TEXT) !== -1,
    'the page shows one version of what someone agreed to and the database stores another'
  );
});

/* ============================================================
   4 · THE DUPLICATE, WHICH IS THE ONE THAT ACTUALLY HAPPENS
   ============================================================ */

await t('a retry of the same attempt returns the reference it already has', async () => {
  reset({ existing: [{ ref: 'ARZ-S-AAAA-BBBB-CCCC', follow_up_status: 'contacted' }] });
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: STUDENT,
    client_ref: '11111111-2222-4333-8444-555555555555',
  }));
  const body = parsed(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, true);
  assert.equal(body.ref, 'ARZ-S-AAAA-BBBB-CCCC');
  assert.equal(body.follow_up_status, 'contacted');
  assert.equal(state.rows.length, 0, 'a retry wrote a second row');
});

await t('the same person filling it in again is told where they already are, not refused', async () => {
  reset({ tailExisting: [{ ref: 'ARZ-S-DDDD-EEEE-FFFF', follow_up_status: 'new' }] });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  const body = parsed(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.duplicate, true);
  assert.equal(body.ref, 'ARZ-S-DDDD-EEEE-FFFF');
  assert.match(body.note, /already on the list/);
  assert.equal(state.rows.length, 0);
  assert.equal(state.lookups, 0, 'the indexed tail answered — the fifty-row scan never ran');
});

await t('and the same number written another way is still the same person', async () => {
  reset({ tailExisting: [{ ref: 'ARZ-S-DDDD-EEEE-FFFF' }] });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.equal(parsed(res).duplicate, true, '+234 and a leading zero are the same subscriber');
});

await t('a database without the tail column still dedupes by scanning', async () => {
  reset({
    tailFails: true,
    existing: [{ ref: 'ARZ-S-DDDD-EEEE-FFFF', follow_up_status: 'new', payload: { phone: '08031234567' } }],
  });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  const body = parsed(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.duplicate, true);
  assert.equal(body.ref, 'ARZ-S-DDDD-EEEE-FFFF');
  assert.equal(state.rows.length, 0);
  assert.equal(state.lookups, 1, 'the refused tail fell back to exactly one scan');
});

/* The row that won the race. A REAL-SHAPED reference, not an
   "ARZ-S-RACE-WINN-ER00" mnemonic: 'R', 'W', 'I' and 'N' are not hex, so
   no trigger on this site could ever have minted it. The assertion below
   echoes this value back, which means the test was pinning the door to a
   string the database cannot produce — the property under test (a lost
   race returns the row that won, rather than erroring) holds either way,
   but it was being proved with an impossible reference in the middle. */
const RACE_WINNER = 'ARZ-S-2222-3333-4444';

await t('a race that beats the lookup is settled by the client_ref index, not by an error', async () => {
  reset({
    existing: [],
    existingAfter: [{ ref: RACE_WINNER }],
    insertStatus: 409,
  });
  const res = await waitlist.handler(event({
    form: 'demand_records',
    answers: STUDENT,
    client_ref: '11111111-2222-4333-8444-555555555555',
  }));
  const body = parsed(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.duplicate, true);
  assert.equal(body.ref, RACE_WINNER);
});

/* ============================================================
   5 · THE THROTTLE, AND WHAT HAPPENS WHEN IT BREAKS
   ============================================================ */

await t('a throttled submission is a 429 in the page\u2019s own vocabulary', async () => {
  reset({ throttle: { allow: false, reason: 'hour', used: 60, limit: 60 } });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.equal(res.statusCode, 429);
  assert.equal(parsed(res).kind, 'busy');
  assert.match(parsed(res).error, /nothing you have typed has been lost/i);
  assert.equal(state.rows.length, 0);
});

await t('the throttle is asked with the ceilings the deployment sets', async () => {
  reset();
  await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  const call = state.requests.find((r) => r.indexOf('waitlist_throttle') !== -1);
  assert.ok(call, 'the throttle was never called — the limit is per-instance memory again');
});

await t('a throttle that cannot answer does NOT refuse a real student', async () => {
  reset({ throttleFails: true });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.equal(res.statusCode, 200, 'our own counter broke and the student paid for it');
  assert.equal(state.rows.length, 1);
});

await t('and a failed duplicate lookup does not become a failed submission either', async () => {
  reset();
  const good = global.fetch;
  global.fetch = async function (url, init) {
    if (String(url).indexOf('select=ref') !== -1) return resp(500, { message: 'lookup broken' });
    return good(url, init);
  };
  try {
    const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
    assert.equal(res.statusCode, 200);
    assert.equal(state.rows.length, 1);
  } finally {
    global.fetch = good;
  }
});

/* ============================================================
   6 · WHEN THE DATABASE OR THE MIGRATION IS NOT WHAT IT SHOULD BE
   ============================================================ */

await t('a PostgreSQL connection string is rejected without making a request or logging its password', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const secretUrl = 'postgresql://private-user:TOPSECRET@db.example.supabase.co:5432/postgres';
  process.env.SUPABASE_URL = secretUrl;
  const before = state.requests.length;
  let log = '';
  const oldError = console.error;
  console.error = (...args) => { log += args.join(' ') + '\n'; };
  try {
    const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
    assert.equal(res.statusCode, 503);
    assert.equal(parsed(res).kind, 'not-ready');
    assert.match(parsed(res).error, /SUPABASE_URL.*HTTPS origin.*PostgreSQL/);
    assert.equal(state.requests.length, before, 'the malformed URL reached fetch');
    assert.ok(!log.includes('TOPSECRET') && !log.includes(secretUrl));
    assert.ok(!res.body.includes('TOPSECRET') && !res.body.includes(secretUrl));
  } finally {
    console.error = oldError;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
  }
});

await t('an insert the database refuses is a 502 in our words, and never the platform\u2019s', async () => {
  reset({ insertStatus: 500 });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  assert.equal(res.statusCode, 502);
  assert.match(parsed(res).error, /our side, not yours/);
});

await t('a row saved without a reference says so rather than pretending it has one', async () => {
  reset({ ref: null });
  const res = await waitlist.handler(event({ form: 'demand_records', answers: STUDENT }));
  const body = parsed(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ref, '');
  assert.match(body.note, /launch migration/);
});

await t('every form the door serves is written with its own state forced', async () => {
  const want = {
    demand_records: { status: 'open' },
    listings: { status: 'pending', tier: 0 },
    scout_submissions: { status: 'pending' },
    booking_requests: { status: 'pending' },
    support_tickets: { status: 'open' },
  };
  for (const [name, expected] of Object.entries(want)) {
    const form = waitlist.FORMS[name];
    assert.ok(form, name + ' is not a form this door serves');
    assert.deepEqual(form.state, expected, name + ' is born in the wrong state');
  }
});

/* ------------------------------------------------------------ */

console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
process.exit(failures.length ? 1 : 0);
