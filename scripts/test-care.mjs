#!/usr/bin/env node
/* ============================================================
   Arzuz — Arzuz Care credit tests

   netlify/functions/care-credit.js is the ONLY writer of care_plans
   and care_credit_events, which means every rule that matters lives
   in one file and can be tested without a database:

     - one credit = one call-out, and a session is four of them
     - the balance is the sum of the ledger, never a counter
     - a student cannot spend past zero, and a refunded session
       cannot be spent at all
     - the published refund window (care.html: "cancel before the
       session starts for a full refund") is enforced as the rule the
       page actually supports — a plan that has already used a
       call-out is not refundable through this button
     - expiry voids what is left, and appends one row
     - a correction is an appended row with a reason, never an edit
     - the gate is on the server, and marketing never sees a plan

   The stand-in below is a small PostgREST for the four paths this
   function uses, and it enforces the SAME shape rules as
   supabase-care.sql's CHECK constraints. That is deliberate: it
   means a test failing here is a bug in the function, and — the
   other way round — the suite also asserts that nothing this
   function ever wrote would have been rejected by the database.

   Run from arzuz-site/:
     node scripts/test-care.mjs
   ============================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* The module refuses to write without a service key (503), which is
   correct and is asserted near the end of this file — so the key is
   set here first, and cleared on purpose in that one test. */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stand-in.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'stand-in-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stand-in-service-role-key';

const care = require('../netlify/functions/care-credit.js');

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

/* ---------------- the stand-in ---------------- */

const SHAPE = (row) => {
  /* Mirrors supabase-care.sql's CHECKs. A violation throws 23514, so
     this suite can prove the function only ever appends legal rows. */
  if (!row.delta) return 'delta must not be zero';
  if (row.event === 'granted' && !(row.delta > 0)) return 'granted must be positive';
  if (row.event === 'spent' && row.delta !== -1) return 'spent must be exactly -1';
  if ((row.event === 'refunded' || row.event === 'expired') && !(row.delta < 0)) return 'a void must be negative';
  if (row.event === 'adjusted' && !row.delta) return 'adjusted must be non-zero';
  if (['granted', 'spent', 'refunded', 'expired', 'adjusted'].indexOf(row.event) === -1) return 'unknown event ' + row.event;
  if (row.parts_ngn != null && row.parts_ngn < 0) return 'parts cannot be negative';
  return null;
};

const state = {
  auth: null,
  plans: [],
  events: [],
  tickets: [],
  seq: 0,
  wrote: [],
  /* Every URL the module asked for, so a test can assert that a
     refused call cost the database NOTHING. */
  requests: [],
  /* Relations PostgREST answers PGRST205 for: the state the live
     project is actually in before supabase-care.sql is run. */
  missing: [],
};

function resp(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (obj === undefined ? '' : JSON.stringify(obj)),
    json: async () => (obj === undefined ? null : obj),
  };
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  state.requests.push(method + ' ' + u);

  if (u.indexOf('/auth/v1/user') !== -1) {
    if (!state.auth || !state.auth.user) return resp(401, { message: 'invalid claim' });
    return resp(200, { id: state.auth.user, email: state.auth.user + '@arzuz.test' });
  }

  if (u.indexOf('/rest/v1/rpc/arzuz_role') !== -1) {
    if (!state.auth) return resp(401, {});
    /* PostgREST returns a bare JSON scalar for an RPC returning text. */
    return resp(200, state.auth.role);
  }

  if (u.indexOf('/rest/v1/') !== -1) {
    const rest = u.slice(u.indexOf('/rest/v1/') + '/rest/v1/'.length);
    const table = rest.split('?')[0];
    const qs = rest.indexOf('?') !== -1 ? rest.slice(rest.indexOf('?') + 1) : '';
    const q = new URLSearchParams(qs);

    /* What PostgREST does for a table missing from its schema cache:
       HTTP 404 and code PGRST205, which is the real answer the live
       project gives for care_plans_live today. */
    if (state.missing.indexOf(table) !== -1) {
      return resp(404, {
        code: 'PGRST205',
        details: null,
        hint: null,
        message: "Could not find the table 'public." + table + "' in the schema cache",
      });
    }

    if (table === 'care_plans') {
      if (method === 'POST') {
        const row = Object.assign({ id: 'plan-' + (++state.seq), created_at: new Date().toISOString() }, body);
        if (!row.payload || !row.payload.phone) return resp(400, { message: 'payload is required' });
        const clash = state.plans.some((p) => p.session === row.session && p.status === 'active' &&
          p.payload.phone === row.payload.phone);
        if (clash) return resp(409, { message: 'duplicate key value violates unique constraint "idx_care_plans_one_active"' });
        state.plans.push(row);
        state.wrote.push(row);
        return resp(201, [row]);
      }
      if (method === 'PATCH') {
        const id = (q.get('id') || '').replace('eq.', '');
        const plan = state.plans.filter((p) => p.id === id)[0];
        if (!plan) return resp(404, {});
        Object.assign(plan, body);
        return resp(204);
      }
      if (method === 'GET') {
        const id = (q.get('id') || '').replace('eq.', '');
        const hash = (q.get('token_hash') || '').replace('eq.', '');
        let found = id ? state.plans.filter((p) => p.id === id) : state.plans.slice();
        if (hash) found = found.filter((p) => p.token_hash === decodeURIComponent(hash));
        return resp(200, found);
      }
    }

    /* The student's ticket. The dashboard reads support_tickets, and so
       does the open-request guard — the jsonb filter is PostgREST's
       `payload->>plan_id`, which is exactly how the module asks. */
    if (table === 'support_tickets') {
      if (method === 'GET') {
        const planRef = q.get('payload->>plan_id');
        const statuses = (q.get('status') || '').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);
        let rows = state.tickets.slice();
        if (planRef) {
          const want = decodeURIComponent(planRef.replace('eq.', ''));
          rows = rows.filter((t) => String(t.payload && t.payload.plan_id) === want);
        }
        if (statuses.length) rows = rows.filter((t) => statuses.indexOf(t.status) !== -1);
        return resp(200, rows);
      }
      if (method === 'POST') {
        if (!body || !body.payload) return resp(400, { message: 'payload is required' });
        const row = Object.assign({
          id: 'ticket-' + (++state.seq),
          created_at: new Date().toISOString(),
          /* the generated columns supabase-drafts-support.sql declares */
          contact_phone: body.payload.phone || null,
          category: body.payload.category || null,
          listing_ref: body.payload.listing_name || null,
        }, body);
        state.tickets.push(row);
        state.wrote.push(row);
        return resp(201, [row]);
      }
    }

    if (table === 'care_credit_balance' && method === 'GET') {
      const id = (q.get('plan_id') || '').replace('eq.', '');
      const rows = state.events.filter((e) => e.plan_id === id);
      if (!rows.length) return resp(200, []);
      const balance = rows.reduce((n, e) => n + e.delta, 0);
      const granted = rows.filter((e) => e.event === 'granted').reduce((n, e) => n + e.delta, 0);
      return resp(200, [{ plan_id: id, balance: balance, granted: granted, call_outs: rows.filter((e) => e.event === 'spent').length }]);
    }

    if (table === 'care_credit_events') {
      if (method === 'POST') {
        const bad = SHAPE(body);
        if (bad) return resp(400, { message: 'new row violates check constraint: ' + bad, code: '23514' });
        const row = Object.assign({ id: ++state.seq, created_at: new Date().toISOString() }, body);
        state.events.push(row);
        state.wrote.push(row);
        return resp(201, [row]);
      }
      if (method === 'GET') {
        const id = (q.get('plan_id') || '').replace('eq.', '');
        const select = (q.get('select') || '*').split(',');
        const rows = state.events
          .filter((e) => e.plan_id === decodeURIComponent(id))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .map((e) => {
            const out = {};
            if (select.indexOf('*') !== -1) return e;
            select.forEach((k) => { if (e[k] !== undefined) out[k] = e[k]; });
            return out;
          });
        return resp(200, rows);
      }
    }
  }

  return resp(404, { message: 'the stand-in has no route for ' + method + ' ' + u });
};

/* A grant hands its raw link back exactly once, and only its hash is
   stored — so the links are kept here, the way a student keeps their
   own, and the door is tested with real ones rather than invented. */
const TOKENS = {};

function planTokenFor(plan) {
  const id = typeof plan === 'string' ? plan : plan.id;
  const token = TOKENS[id];
  assert.ok(token, 'no recorded Care link for plan ' + id);
  return token;
}

const call = async (opts = {}) => {
  const headers = opts.token === null ? {} : { authorization: 'Bearer ' + (opts.token || 'x'.repeat(40)) };
  if (opts.ip) headers['x-nf-client-connection-ip'] = opts.ip;
  const res = await care.handler({
    httpMethod: opts.method || 'POST',
    headers: headers,
    body: opts.body === undefined ? '{}' : JSON.stringify(opts.body),
  });
  const out = { status: res.statusCode, body: JSON.parse(res.body) };
  if (opts.body && opts.body.action === 'grant' && out.body && out.body.token) {
    TOKENS[out.body.plan_id] = out.body.token;
  }
  return out;
};

const asAdmin = (body) => call({ token: 'a'.repeat(40), body: body, headers: {} });
const balanceOf = (id) => state.events.filter((e) => e.plan_id === id).reduce((n, e) => n + e.delta, 0);

/* ------------------------------------------------------------ */

console.log('care-credit.js \u2014 the gate\n');

await t('with no session token there is no call to answer', async () => {
  state.auth = null;
  const before = state.wrote.length;
  const r = await call({ token: null });
  assert.equal(r.status, 401);
  assert.equal(state.wrote.length, before, 'a refused call must not write');
});

await t('a token Supabase does not recognise is refused \u2014 the anon key decodes nothing', async () => {
  state.auth = { user: null, role: 'admin' };
  const r = await call({ token: 'y'.repeat(40) });
  assert.equal(r.status, 401);
});

await t('a marketing login is refused with 403, before any Care row is read', async () => {
  state.auth = { user: 'u-marketing', role: 'marketing' };
  const before = state.wrote.length;
  const r = await call({ token: 'm'.repeat(40), body: { action: 'grant', payload: { name: 'Ada', phone: '+2348000000001' } } });
  assert.equal(r.status, 403);
  assert.equal(state.wrote.length, before);
  assert.equal(/Ada|\+234/.test(JSON.stringify(r.body)), false,
    'a refused caller was handed student data: ' + JSON.stringify(r.body));
});

await t('GET is refused \u2014 a session token never travels in a URL', async () => {
  state.auth = { user: 'u-admin', role: 'admin' };
  const r = await call({ method: 'GET' });
  assert.equal(r.status, 405);
});

await t('an unknown action is refused', async () => {
  const r = await call({ body: { action: 'void_everything' } });
  assert.equal(r.status, 400);
});

await t('a body that is not JSON is refused, not crashed on', async () => {
  const res = await care.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(40) }, body: '{not json' });
  assert.equal(res.statusCode, 400);
});

console.log('\ncare-credit.js \u2014 granting a session\n');

let planId = null;
let planToken = null;

await t('a grant opens a plan with FOUR credits and the published \u20a620,000', async () => {
  state.auth = { user: 'u-support', role: 'support' };
  const r = await call({ body: { action: 'grant', payload: { name: 'Ada Care', phone: '+2348000000001', area: 'Malete' } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.credits, care.CALL_OUTS_INCLUDED);
  assert.equal(r.body.balance, 4);
  assert.equal(r.body.amount_ngn, care.SESSION_FEE_NGN);
  assert.equal(r.body.amount_ngn, 20000, 'care.html publishes \u20a620,000 \u2014 the code has drifted from the page');
  planId = r.body.plan_id;
  planToken = r.body.token;
  assert.equal(balanceOf(planId), 4, 'granting must append a +4 row, not set a counter');
});

await t('only the HASH of the link token is stored, never the token', async () => {
  const plan = state.plans.filter((p) => p.id === planId)[0];
  assert.ok(planToken && planToken.length > 20, 'no token was returned');
  assert.notEqual(plan.token_hash, planToken);
  assert.match(plan.token_hash, /^[a-f0-9]{64}$/, 'the stored token_hash is not a sha-256 hex digest');
  assert.equal(JSON.stringify(state.plans).indexOf(planToken), -1, 'the raw token reached the database');
});

await t('the person who recorded it is on the row', async () => {
  const grant = state.events.filter((e) => e.plan_id === planId && e.event === 'granted')[0];
  assert.equal(grant.actor_ref, 'u-support');
  assert.equal(grant.actor_name, 'u-support');
  assert.match(grant.reason, /2026\/2027/, 'the grant should say which session it bought');
});

await t('a plan needs a student \u2014 a nameless plan is refused', async () => {
  const r = await call({ body: { action: 'grant', payload: { name: 'No Phone' } } });
  assert.equal(r.status, 400);
});

await t('a second ACTIVE plan for the same student and session is refused with 409', async () => {
  const before = state.plans.length;
  const r = await call({ body: { action: 'grant', payload: { name: 'Ada Care', phone: '+2348000000001' } } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /double the call-outs/);
  assert.equal(state.plans.length, before, 'a refused grant still created a plan');
});

await t('a different session for the same student is a legitimate new plan', async () => {
  const r = await call({ body: { action: 'grant', session: '2027/2028', payload: { name: 'Ada Care', phone: '+2348000000001' } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.session, '2027/2028');
});

await t('a custom credit count and fee are what get recorded', async () => {
  const r = await call({ body: { action: 'grant', session: '2027/2028x', payload: { name: 'Ada Care', phone: '+2348000000001' }, credits: 2, amount_ngn: 12000 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.credits, 2);
  assert.equal(r.body.amount_ngn, 12000);
  assert.equal(balanceOf(r.body.plan_id), 2);
});

console.log('\ncare-credit.js \u2014 spending a call-out\n');

await t('one call-out takes exactly one credit', async () => {
  const r = await call({ body: { action: 'spend', plan_id: planId, worker: 'Compound caretaker', parts_ngn: 1200 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, 3);
  assert.equal(r.body.call_outs, 1);
  assert.equal(r.body.parts_over_ceiling, false);
  const spent = state.events.filter((e) => e.plan_id === planId && e.event === 'spent');
  assert.equal(spent.length, 1);
  assert.equal(spent[0].delta, -1, 'a call-out must be exactly -1 credit');
  assert.equal(spent[0].worker, 'Compound caretaker');
  assert.equal(spent[0].parts_ngn, 1200);
});

await t('parts over the \u20a63,000 ceiling are recorded and flagged, not silently covered', async () => {
  const r = await call({ body: { action: 'spend', plan_id: planId, worker: 'Verified worker', parts_ngn: 4500 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.parts_over_ceiling, true);
  const last = state.events.filter((e) => e.event === 'spent').slice(-1)[0];
  assert.match(last.note, /3,000|3000/, 'the ceiling note is missing');
  assert.equal(r.body.balance, 2);
});

await t('a call-out with no plan is refused', async () => {
  const r = await call({ body: { action: 'spend', plan_id: 'nope' } });
  assert.equal(r.status, 404);
});

await t('spending reaches zero and then STOPS \u2014 four call-outs, no more', async () => {
  await call({ body: { action: 'spend', plan_id: planId } });
  const fourth = await call({ body: { action: 'spend', plan_id: planId } });
  assert.equal(fourth.status, 200);
  assert.equal(fourth.body.balance, 0);
  assert.equal(fourth.body.call_outs, 4);

  const before = state.events.length;
  const fifth = await call({ body: { action: 'spend', plan_id: planId } });
  assert.equal(fifth.status, 409);
  assert.match(fifth.body.error, /No call-outs left/);
  assert.equal(state.events.length, before, 'a refused call-out still wrote a ledger row');
  assert.equal(balanceOf(planId), 0, 'the balance went negative');
});

await t('parts that are not a number are refused', async () => {
  const r = await call({ body: { action: 'spend', plan_id: planId, parts_ngn: 'about 900' } });
  assert.equal(r.status, 400);
});

console.log('\ncare-credit.js \u2014 refunds, expiry and corrections\n');

await t('a plan that has used a call-out is past the published refund window', async () => {
  const before = state.events.length;
  const r = await call({ body: { action: 'refund', plan_id: planId } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /full-refund window/);
  assert.equal(state.events.length, before);
  const plan = state.plans.filter((p) => p.id === planId)[0];
  assert.equal(plan.status, 'active', 'a refused refund changed the plan status anyway');
});

await t('a refund voids the unused credits and marks the plan refunded', async () => {
  const fresh = await call({ body: { action: 'grant', session: '2028/2029', payload: { name: 'Bola Care', phone: '+2348000000002' } } });
  const id = fresh.body.plan_id;
  const r = await call({ body: { action: 'refund', plan_id: id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.voided, 4);
  assert.equal(balanceOf(id), 0, 'the credits were refunded but the balance did not move');
  const plan = state.plans.filter((p) => p.id === id)[0];
  assert.equal(plan.status, 'refunded');
  const row = state.events.filter((e) => e.plan_id === id && e.event === 'refunded')[0];
  assert.equal(row.delta, -4);
  assert.match(row.reason, /Refunded before the session started/);
});

await t('refunding twice does not refund twice', async () => {
  const plan = state.plans.filter((p) => p.status === 'refunded')[0];
  const before = state.events.length;
  const r = await call({ body: { action: 'refund', plan_id: plan.id } });
  assert.equal(r.status, 409);
  assert.equal(state.events.length, before);
});

await t('a refunded session cannot be spent', async () => {
  const plan = state.plans.filter((p) => p.status === 'refunded')[0];
  const r = await call({ body: { action: 'spend', plan_id: plan.id } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /refunded/);
});

await t('expiry voids what is left and ends the plan', async () => {
  const fresh = await call({ body: { action: 'grant', session: '2029/2030', payload: { name: 'Chidi Care', phone: '+2348000000003' } } });
  const id = fresh.body.plan_id;
  await call({ body: { action: 'spend', plan_id: id } });

  const r = await call({ body: { action: 'expire', plan_id: id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.voided, 3, 'expiry must void what is LEFT, not the original grant');
  assert.equal(balanceOf(id), 0);
  const plan = state.plans.filter((p) => p.id === id)[0];
  assert.equal(plan.status, 'ended');
  const row = state.events.filter((e) => e.plan_id === id && e.event === 'expired')[0];
  assert.match(row.reason, /3 call-outs unused/);
});

await t('expiring an empty plan writes NO row \u2014 a zero-delta row is a comment, not a ledger entry', async () => {
  const plan = state.plans.filter((p) => p.status === 'ended')[0];
  const before = state.events.length;
  const r = await call({ body: { action: 'expire', plan_id: plan.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.already_empty, true);
  assert.equal(state.events.length, before);
});

await t('a correction needs a reason \u2014 it is the only part a human reads', async () => {
  const r = await call({ body: { action: 'adjust', plan_id: planId, delta: 2 } });
  assert.equal(r.status, 400);
});

await t('a correction cannot take the balance below zero', async () => {
  const r = await call({ body: { action: 'adjust', plan_id: planId, delta: -1, reason: 'goodwill clawback' } });
  assert.equal(r.status, 409);
});

await t('a correction is an appended row, and it moves the balance', async () => {
  const r = await call({ body: { action: 'adjust', plan_id: planId, delta: 2, reason: 'landlord sent his own plumber' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, 2);
  const row = state.events.filter((e) => e.event === 'adjusted').slice(-1)[0];
  assert.equal(row.reason, 'landlord sent his own plumber');
  assert.equal(row.delta, 2);
  const originals = state.events.filter((e) => e.event === 'spent');
  assert.equal(originals.every((e) => e.delta === -1), true, 'a correction edited history instead of appending');
});

console.log('\ncare-credit.js \u2014 the ledgers rules, and the ceiling\n');

await t('NOTHING this function wrote would have been rejected by supabase-care.sql', async () => {
  for (const row of state.wrote.filter((r) => r.event)) {
    const bad = SHAPE(row);
    assert.equal(bad, null, 'the function wrote a row the database would refuse: ' + JSON.stringify(row));
  }
  assert.ok(state.wrote.length >= 10, 'too few rows to be meaningful');
});

await t('the function never assigns identity or timestamps itself', async () => {
  for (const row of state.events) {
    assert.equal(row.id === undefined || typeof row.id === 'number', true);
    assert.equal(row.created_at === undefined || typeof row.created_at === 'string', true);
  }
});

await t('31 changes in a minute from one login is a lot of Care changes', async () => {
  state.auth = { user: 'u-hammer', role: 'admin' };
  let last = null;
  for (let i = 0; i < care.MAX_PER_MINUTE + 1; i += 1) {
    last = await call({ body: { action: 'spend', plan_id: planId } });
  }
  assert.equal(last.status, 429);
});

await t('with no service key the module refuses rather than half-writing', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    state.auth = { user: 'u-nokey', role: 'admin' };
    const before = state.wrote.length;
    const r = await call({ body: { action: 'grant', payload: { name: 'No Key', phone: '+2348000000099' } } });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.equal(state.wrote.length, before);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

/* ------------------------------------------------------------
   The grant, as the dashboard now opens one
   ------------------------------------------------------------ */

console.log('\ncare-credit.js — opening a plan for the dashboard\n');

/* Every team action below is taken by a FRESH support login, and that
   is not decoration: the rate-limit test further down deliberately
   spends one login's ceiling of 30 calls a minute, and a shared id
   would make an unrelated test the one that fails. Each of these
   opens a plan or records a visit as a different member of the team,
   which is also the honest thing — that is what those calls are. */
let teamSeq = 0;
function asTeam(label) {
  teamSeq += 1;
  const id = 'u-support-' + label + '-' + teamSeq;
  state.auth = { user: id, role: 'support' };
  return id;
}
const asTeamBeforehand = () => asTeam('grant');

await t('a number that is not a Nigerian mobile is refused, and no plan is created', async () => {
  asTeamBeforehand();
  const before = state.plans.length;
  const r = await call({ body: { action: 'grant', payload: { name: 'Bad Phone', phone: 'call me maybe' } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Nigerian mobile/);
  assert.equal(state.plans.length, before);
});

await t('a one-character name is refused', async () => {
  asTeamBeforehand();
  const r = await call({ body: { action: 'grant', payload: { name: 'X', phone: '08031234567' } } });
  assert.equal(r.status, 400);
});

await t('the SAME number in two spellings cannot buy the session twice (the unique index, made to hold)', async () => {
  asTeamBeforehand();
  const first = await call({
    body: { action: 'grant', session: '2030/2031', payload: { name: 'Ngozi Care', phone: '08031234567' } },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.phone, '2348031234567', 'the stored number is not the normalised one');

  const again = await call({
    body: { action: 'grant', session: '2030/2031', payload: { name: 'Ngozi Care', phone: '+234 803 123 4567' } },
  });
  assert.equal(again.status, 409,
    'a differently-spelled copy of the number created a second active plan — the double sale the index exists to stop');
});

await t('the grant hands back what the dashboard needs to confirm it', async () => {
  asTeamBeforehand();
  const r = await call({
    body: { action: 'grant', session: '2031/2032', payload: { name: 'Chika Care', phone: '08031234568', area: 'Malete', room: 'B4' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.student_name, 'Chika Care');
  assert.match(r.body.link_path, /^\/my-care\?t=[A-Za-z0-9_-]{20,}$/,
    'the confirmation has no private link to hand the student: ' + r.body.link_path);
  assert.equal(r.body.link_path.indexOf(r.body.token), '/my-care?t='.length,
    'the link does not carry the token it was minted with');
});

await t('a reason from the team is what lands on the ledger row', async () => {
  const actor = asTeam('reason');
  const r = await call({
    body: { action: 'grant', session: '2032/2033', payload: { name: 'Eze Care', phone: '08031234569' }, reason: 'inspection was wrong — Care is free this session (terms §7)' },
  });
  assert.equal(r.status, 201);
  const row = state.events.filter((e) => e.plan_id === r.body.plan_id && e.event === 'granted')[0];
  assert.match(row.reason, /terms §7/);
  assert.equal(row.actor_name, actor, 'the audited name on the row is not the login that made the grant');
});

/* ------------------------------------------------------------
   The student's door
   ------------------------------------------------------------ */

console.log('\ncare-credit.js — the student\u2019s private link\n');

/* No Authorization header at all — that is the student's door. The
   connection is fresh per call, so the per-IP ceiling is only tripped
   by the test that means to trip it. */
let ipSeq = 0;
const asStudent = (body, ip) => call({ token: null, body: body, ip: ip || ('test-ip-' + (++ipSeq)) });

/* A plan with a ledger small enough to read: one grant and one
   call-out. The read tests assert against arithmetic that was set up
   in front of them rather than against whatever earlier tests left. */
asTeam('read');
const readCase = await call({
  body: {
    action: 'grant', session: '2037/2038',
    payload: { name: 'Ada Care', phone: '08036543210', area: 'Malete', room: 'A1' },
  },
});
const readLink = readCase.body.token;
await call({
  body: { action: 'spend', plan_id: readCase.body.plan_id, worker: 'Compound caretaker', parts_ngn: 1200, reason: 'blocked kitchen sink' },
});

await t('a token that cannot be one is refused WITHOUT a database call', async () => {
  const before = state.requests.length;
  const r = await asStudent({ action: 'view', token: 'short' });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /do not recognise/);
  assert.equal(state.requests.length, before, 'a 5-character token reached Supabase');
});

await t('a well-formed token that matches no plan is a 404, not a crash', async () => {
  const r = await asStudent({ action: 'view', token: 'z'.repeat(43) });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /do not recognise/);
});

let viewBody = null;

await t('the link reads the balance from the LEDGER, and the published numbers from the server', async () => {
  const r = await asStudent({ action: 'view', token: readLink });
  assert.equal(r.status, 200);
  viewBody = r.body;
  assert.equal(r.body.balance, 3, 'a grant of four and one call-out did not read as three left');
  assert.equal(r.body.balance, balanceOf(readCase.body.plan_id),
    'the page was handed a balance the ledger does not add up to');
  assert.equal(r.body.granted, 4);
  assert.equal(r.body.call_outs, 1);
  assert.equal(r.body.plan.session, '2037/2038');
  assert.equal(r.body.plan.status, 'active');
  assert.equal(r.body.published.session_fee_ngn, 20000);
  assert.equal(r.body.published.call_outs_included, 4);
  assert.equal(r.body.published.parts_included_ngn, 3000);
  assert.equal(r.body.can_request, true, 'three credits are left, so the form should be offered');
});

await t('a plan the team opened has no coverage window \u2014 and says so instead of inventing one', async () => {
  assert.equal(viewBody.coverage, null,
    'a dashboard-opened plan was handed a coverage window the team never set');
});

await t('a plan a CARE PASS opened reports the term, the cap and the receipt from the row', async () => {
  /* Exactly what finance.js activate() writes: the coverage term and the
     receipt on the plan it opens. The page prints these; it works
     nothing out. */
  const row = state.plans.filter((p) => p.id === readCase.body.plan_id)[0];
  row.coverage_start = '2026-10-13T09:00:00.000Z';
  row.coverage_end = '2027-02-10T09:00:00.000Z';
  row.call_out_cap = 4;
  row.receipt_ref = 'AZ-R-M4K2P1-9F3A2B1C';
  row.terms_version = 3;

  const r = await asStudent({ action: 'view', token: readLink });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.coverage, {
    start: '2026-10-13T09:00:00.000Z',
    end: '2027-02-10T09:00:00.000Z',
    call_out_cap: 4,
    receipt_ref: 'AZ-R-M4K2P1-9F3A2B1C',
    terms_version: 3,
  }, 'the pass the customer bought is not what the page was handed');
  assert.equal(r.body.balance, 3, 'reporting the term changed the balance');
});

await t('a half-set window (a start with no end) is reported as no window at all', async () => {
  const row = state.plans.filter((p) => p.id === readCase.body.plan_id)[0];
  row.coverage_end = null;
  const r = await asStudent({ action: 'view', token: readLink });
  assert.equal(r.body.coverage, null,
    'a pass with no end date was reported as a term \u2014 a coverage promise with no closing date');
  /* put the row back for the rest of the suite */
  row.coverage_end = '2027-02-10T09:00:00.000Z';
});

await t('the student sees their own name and number, and nobody else\u2019s', async () => {
  assert.equal(viewBody.student.name, 'Ada Care');
  assert.equal(viewBody.student.room, 'A1');
  assert.ok(viewBody.student.phone, 'the request form has nothing to pre-fill');
  const raw = JSON.stringify(viewBody);
  ['actor_ref', 'actor_name', 'token_hash', 'u-support', 'env"'].forEach((leak) => {
    assert.equal(raw.indexOf(leak), -1, 'the student\u2019s read leaked ' + leak);
  });
});

await t('the ledger comes back in order, and only in the fields a student may see', async () => {
  const events = viewBody.events;
  assert.equal(events.length, 2, 'the ledger should be exactly one grant and one call-out');
  assert.equal(events[0].event, 'granted');
  assert.equal(events[0].delta, 4);
  assert.equal(events[1].event, 'spent');
  assert.equal(events[1].delta, -1);
  assert.equal(events[1].worker, 'Compound caretaker', 'the student cannot see who did the work');
  assert.equal(events[1].parts_ngn, 1200);
  const times = events.map((e) => String(e.created_at));
  assert.deepEqual(times.slice().sort(), times, 'the ledger is not in chronological order');
  const allowed = care.STUDENT_LEDGER_FIELDS;
  events.forEach((e) => Object.keys(e).forEach((k) => {
    assert.ok(allowed.indexOf(k) !== -1, 'a ledger row handed the student a field it should not: ' + k);
  }));
});

await t('a read needs no session at all — the link IS the credential', async () => {
  const before = state.requests.length;
  const r = await asStudent({ action: 'view', token: planToken });
  assert.equal(r.status, 200);
  const asked = state.requests.slice(before);
  assert.equal(asked.some((u) => u.indexOf('/auth/v1/user') !== -1), false,
    'the student door asked Supabase to validate a session it never had');
  assert.equal(asked.some((u) => u.indexOf('arzuz_role') !== -1), false, 'the student door read a team role');
});

await t('a role header changes nothing about a link \u2014 marketing or admin, the link decides', async () => {
  state.auth = { user: 'u-marketing', role: 'marketing' };
  try {
  const asMarketingJwt = await call({ token: 'm'.repeat(40), body: { action: 'view', token: planToken } });
  assert.equal(asMarketingJwt.status, 200, 'a marketing session was refused a link read it does not need');
    const refused = await call({ token: 'm'.repeat(40), body: { action: 'spend', plan_id: planId } });
    assert.equal(refused.status, 403, 'a marketing session could spend through the team door');
  } finally {
    asTeam();
  }
});

await t('asking for a worker files a Support Desk ticket, and moves no credit', async () => {
  asTeam();
  const spendable = await call({
    body: { action: 'grant', session: '2033/2034', payload: { name: 'Ngozi Okereke', phone: '08039876543', room: 'C2' } },
  });
  const link = spendable.body.token;
  const id = spendable.body.plan_id;
  const beforeEvents = state.events.filter((e) => e.plan_id === id).length;

  const r = await asStudent({
    action: 'request', token: link, issue: 'The bathroom tap runs when it is off', room: 'C2',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 4, 'a request must not spend a credit — a worker has not been sent yet');
  assert.match(r.body.message, /48 hours/);

  assert.equal(state.events.filter((e) => e.plan_id === id).length, beforeEvents,
    'filing a request wrote to the ledger');
  const ticket = state.tickets.filter((t) => t.payload.plan_id === id)[0];
  assert.ok(ticket, 'no ticket was filed');
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.category, 'care', 'the Support Desk cannot filter it by category');
  assert.equal(ticket.contact_phone, spendable.body.phone, 'the phone on the ticket is not the reachable one');
  assert.equal(ticket.session, '2033/2034');
  assert.equal(ticket.source, 'my-care.html');
  assert.match(ticket.notes, /plan /);
});

await t('the phone left off the form falls back to the number on the plan', async () => {
  asTeam();
  const fresh = await call({ body: { action: 'grant', session: '2034/2035', payload: { name: 'Ada Nwosu', phone: '08039998888' } } });
  const r = await asStudent({ action: 'request', token: fresh.body.token, issue: 'The socket by the door sparks when used' });
  assert.equal(r.status, 201);
  const ticket = state.tickets.filter((t) => t.payload.plan_id === fresh.body.plan_id)[0];
  assert.equal(ticket.payload.phone, '2348039998888');
});

await t('a second tap of the submit button is refused, and the first ticket is named', async () => {
  const plan = state.plans.filter((p) => p.session === '2033/2034')[0];
  const link = planTokenFor(plan);
  const r = await asStudent({ action: 'request', token: link, issue: 'The bathroom tap runs when it is off' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already have a request/);
  assert.ok(r.body.ticket_id, 'the refusal does not name the request that already exists');
  assert.equal(state.tickets.filter((t) => t.payload.plan_id === plan.id).length, 1,
    'a double tap created two jobs');
});

await t('once the first is resolved, a new problem can be reported', async () => {
  const plan = state.plans.filter((p) => p.session === '2033/2034')[0];
  state.tickets.filter((t) => t.payload.plan_id === plan.id).forEach((t) => { t.status = 'resolved'; });
  const r = await asStudent({ action: 'request', token: planTokenFor(plan), issue: 'Now the other tap is dripping' });
  assert.equal(r.status, 201);
});

await t('what is broken must be said in words', async () => {
  const plan = state.plans.filter((p) => p.session === '2034/2035')[0];
  const before = state.tickets.length;
  const r = await asStudent({ action: 'request', token: planTokenFor(plan), issue: '   ' });
  assert.equal(r.status, 400);
  assert.equal(state.tickets.length, before);
});

await t('a number a worker cannot reach is refused before the ticket is written', async () => {
  const plan = state.plans.filter((p) => p.session === '2034/2035')[0];
  const before = state.tickets.length;
  const r = await asStudent({ action: 'request', token: planTokenFor(plan), issue: 'The door lock jams', phone: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(state.tickets.length, before);
});

await t('an exhausted plan cannot ask for a worker, and is told how to proceed instead', async () => {
  asTeam();
  const fresh = await call({ body: { action: 'grant', session: '2036/2037', payload: { name: 'Emeka Uche', phone: '08031110000' } } });
  for (let i = 0; i < 4; i += 1) await call({ body: { action: 'spend', plan_id: fresh.body.plan_id, worker: 'Caretaker' } });

  const seen = await asStudent({ action: 'view', token: fresh.body.token });
  assert.equal(seen.body.balance, 0);
  assert.equal(seen.body.can_request, false, 'a plan with nothing left still offered the request form');

  const before = state.tickets.length;
  const r = await asStudent({ action: 'request', token: fresh.body.token, issue: 'The toilet keeps running all night' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /all 4 call-outs/i);
  assert.equal(state.tickets.length, before, 'a refused request filed a ticket anyway');
});

await t('a refunded session cannot ask for a worker', async () => {
  const refunded = state.plans.filter((p) => p.status === 'refunded')[0];
  const r = await asStudent({ action: 'request', token: planTokenFor(refunded), issue: 'Just checking the plumbing' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /refunded/);
});

await t('an ended session says so, rather than pretending it is broken', async () => {
  const ended = state.plans.filter((p) => p.status === 'ended')[0];
  const r = await asStudent({ action: 'request', token: planTokenFor(ended), issue: 'Something is wrong with the door' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /ended|closed/);
  const read = await asStudent({ action: 'view', token: planTokenFor(ended) });
  assert.equal(read.status, 200, 'an ended session must still be readable \u2014 that is the student\u2019s own history');
  assert.equal(read.body.plan.status, 'ended');
});

await t('one link, many connections: the link\u2019s own ceiling holds', async () => {
  asTeam();
  const fresh = await call({ body: { action: 'grant', session: '2035/2036', payload: { name: 'Hammer Link', phone: '08037770000' } } });
  const link = fresh.body.token;
  let last = null;
  for (let i = 0; i < care.LINK_MAX_PER_MINUTE + 1; i += 1) {
    last = await asStudent({ action: 'view', token: link }, 'link-hammer-' + i);
  }
  assert.equal(last.status, 429);
});

await t('many links, one connection: the connection\u2019s ceiling holds too', async () => {
  asTeam();
  let last = null;
  for (let i = 0; i < care.LINK_MAX_PER_MINUTE + 1; i += 1) {
    const fresh = await call({
      body: { action: 'grant', session: '204' + i + '/204' + (i + 1), payload: { name: 'IP Hammer ' + i, phone: '0803888' + String(1000 + i) } },
    });
    last = await asStudent({ action: 'view', token: fresh.body.token }, 'one-connection');
  }
  assert.equal(last.status, 429, 'a single connection walked every link it could mint');
});

await t('Care tables that do not exist yet say so \u2014 503, not a 502 that blames the student', async () => {
  state.missing = ['care_plans'];
  try {
    const r = await asStudent({ action: 'view', token: planToken });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /not switched on/);
    const req = await asStudent({ action: 'request', token: planToken, issue: 'Something is broken here' });
    assert.equal(req.status, 503, 'a request against a missing table was answered like a bad link');
  } finally {
    state.missing = [];
  }
});

await t('the student door needs the service key too \u2014 and says which one is missing', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await asStudent({ action: 'view', token: planToken });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

await t('the student door refuses a GET like every other action', async () => {
  const r = await call({ token: null, method: 'GET' });
  assert.equal(r.status, 405);
});

await t('nothing the student door wrote would have been rejected by the database', async () => {
  const filed = state.wrote.filter((r) => r.payload && r.payload.category === 'care');
  assert.ok(filed.length >= 3, 'too few tickets to be meaningful: ' + filed.length);
  for (const row of filed) {
    /* Status is asserted where the ticket is created, above — it is a
       later test that resolves one, and this row is that same object. */
    assert.equal(row.source, 'my-care.html');
    assert.ok(row.payload.issue && row.payload.issue.length >= 5);
    assert.match(String(row.payload.phone), /^234\d{10}$/);
    assert.ok(row.session, 'a ticket with no session cannot be filtered by one');
    assert.match(row.notes, /plan /);
  }
});

/* ------------------------------------------------------------ */

console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
process.exit(failures.length ? 1 : 0);
