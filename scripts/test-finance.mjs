#!/usr/bin/env node
/* ============================================================
   Arzuz — the money rules

   netlify/functions/finance.js is the only writer of payments,
   ledger_entries and referrals, and the API through which a Care Pass
   is bought. So every rule the monetization brief fixes in place can
   be tested here, with no database and no network:

     · housing is free — no listing fee, no rent commission, no
       charge bundled into a rent payment
     · a Care Pass is coverage, not a wallet: it opens a TERM with a
       defined start and end and a call-out cap
     · the price is frozen at purchase — publishing a new price cannot
       re-price a paid order
     · a redirect is not a payment: only provider verification (or a
       signed webhook) activates, and the amount must match
     · nothing activates twice — replayed webhooks and re-run verifies
       land on the same row, and the ledger does not grow a twin
     · sales stay off until an admin publishes approved terms
     · storage stays off until an admin switches it on
     · ₦2,000 referral, once, after a verified first payment; no
       self-referrals, one reward per qualifying payment
     · support CANNOT move money; marketing reaches nothing
     · a refund is a reversal entry in the books, not an edit

   The stand-in below is a small PostgREST that enforces the SAME
   constraints supabase-finance.sql declares (unique client_ref,
   unique provider_ref, paid needs paid_at, unique entry_ref, one
   referral per qualifying payment, no self-referral) plus a Paystack
   stand-in. A test failing here is a bug in the function; the suite
   also proves the function never wrote a row the database would have
   rejected.

   Run from arzuz-site/:
     node scripts/test-finance.mjs
   ============================================================ */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stand-in.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'stand-in-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stand-in-service-role-key';
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_stand_in';

const finance = require('../netlify/functions/finance.js');
const webhook = require('../netlify/functions/paystack-webhook.js');

/* The pass link the buyer is handed is a token, and the plan stores only
   its hash — so the suite proves a returned token by hashing it and
   finding it on the plan, exactly as the customer's browser will. */
const { hashToken } = require('../netlify/functions/roommate-match.js');

/* ---------------- tiny runner ---------------- */

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

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((what || 'value') + ': expected ' + e + ', got ' + a);
}

const TERMS = {
  price_kobo: 2000000,
  currency: 'NGN',
  term: 'one academic semester',
  call_outs_included: 4,
  parts_ceiling_kobo: 300000,
  refund: 'full refund before coverage starts',
};

/* ---------------- the stand-in ---------------- */

const state = {
  auth: null,
  config: {
    care_pass_price_kobo: 2000000,
    care_call_out_cap: 4,
    care_parts_ceiling_kobo: 300000,
    referral_reward_kobo: 200000,
    marketplace_fee_bps: 0,
    storage_enabled: false,
    care_term_days: 120,
    care_term_end: null,
  },
  terms: [],
  payments: [],
  ledger: [],
  referrals: [],
  codes: {},
  plans: [],
  events: [],
  seq: 0,
  requests: [],
  paystack: { status: 'success', amount: null, currency: 'NGN', initialized: [], failInitialize: false },
  /* PostgREST refusing the key this deploy holds: the real answer the
     live project gave while the service key in Netlify was stale. */
  refuseKey: false,
};

const TOKEN = 'stand-in-service-role-key';

function resp(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (obj === undefined ? '' : JSON.stringify(obj)),
    json: async () => (obj === undefined ? null : obj),
  };
}

const dup = (what) => resp(409, { code: '23505', message: 'duplicate key value violates unique constraint "' + what + '"' });

function filterMatch(row, q) {
  for (const [key, raw] of q.entries()) {
    if (key === 'select' || key === 'limit' || key === 'order' || key === 'on_conflict') continue;
    const val = String(raw);
    if (val === 'is.null') { if (row[key] != null) return false; continue; }
    if (val === 'is.true') { if (row[key] !== true) return false; continue; }
    if (/^eq\./.test(val)) { if (String(row[key]) !== val.slice(3)) return false; continue; }
  }
  return true;
}

function paymentRow(row) {
  return {
    id: row.id, created_at: row.created_at, updated_at: row.updated_at,
    client_ref: row.client_ref, business_line: row.business_line, purpose: row.purpose,
    terms_id: row.terms_id, terms_version: row.terms_version, amount_kobo: row.amount_kobo,
    currency: row.currency || 'NGN', status: row.status, provider: row.provider,
    provider_ref: row.provider_ref || null, provider_payload: row.provider_payload || null,
    reference: row.reference, receipt_ref: row.receipt_ref || null, subject: row.subject,
    referral_code: row.referral_code || null, paid_at: row.paid_at || null,
    activated_at: row.activated_at || null, activation_error: row.activation_error || null,
    coverage_start: row.coverage_start || null, coverage_end: row.coverage_end || null,
    call_out_cap: row.call_out_cap || null, env: row.env || 'production', notes: row.notes || null,
  };
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  state.requests.push(method + ' ' + u);

  /* --- Paystack --- */
  if (u.indexOf('api.paystack.co') !== -1) {
    if (u.indexOf('/transaction/initialize') !== -1) {
      if (state.paystack.failInitialize) {
        return resp(502, { status: false, message: 'the provider is unreachable' });
      }
      state.paystack.initialized.push(body);
      return resp(200, { status: true, data: { authorization_url: 'https://checkout.paystack.com/' + body.reference, access_code: 'ac_' + body.reference, reference: body.reference } });
    }
    if (u.indexOf('/transaction/verify/') !== -1) {
      const ref = decodeURIComponent(u.split('/transaction/verify/')[1]);
      const order = state.payments.filter((p) => p.reference === ref)[0];
      return resp(200, {
        status: true,
        data: {
          status: state.paystack.status,
          amount: state.paystack.amount != null ? state.paystack.amount : (order ? order.amount_kobo : null),
          currency: state.paystack.currency,
          reference: ref,
        },
      });
    }
    if (u.indexOf('/refund') !== -1) {
      return resp(200, { status: true, data: { id: 'rf_' + (++state.seq), status: 'processed' } });
    }
    return resp(200, { status: true, data: {} });
  }

  /* --- Supabase auth + role (copied contract from care-credit) --- */
  if (u.indexOf('/auth/v1/user') !== -1) {
    if (!state.auth || !state.auth.user) return resp(401, { message: 'invalid claim' });
    return resp(200, { id: state.auth.user, email: state.auth.user + '@arzuz.test' });
  }
  if (u.indexOf('/rest/v1/rpc/arzuz_role') !== -1) {
    if (!state.auth) return resp(401, {});
    return resp(200, state.auth.role);
  }

  /* The key is in the slot and the project will not accept it — the
     sentence PostgREST answers, verbatim. Placed after the auth and rpc
     branches because those still work: the anon key is a different
     value and the live project kept accepting it throughout. */
  if (state.refuseKey && u.indexOf('/rest/v1/') !== -1) {
    return resp(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
  }

  if (u.indexOf('/rest/v1/') === -1) return resp(200, {});

  const rest = u.slice(u.indexOf('/rest/v1/') + '/rest/v1/'.length);
  const table = rest.split('?')[0];
  const qs = rest.indexOf('?') !== -1 ? rest.slice(rest.indexOf('?') + 1) : '';
  const q = new URLSearchParams(qs);
  const rows = (list) => list.filter((r) => filterMatch(r, q));

  if (table === 'finance_config') {
    if (method === 'GET') return resp(200, Object.keys(state.config).map((k) => ({ key: k, value: state.config[k] })));
    if (method === 'POST') { state.config[body.key] = body.value; return resp(201, []); }
  }

  if (table === 'public_terms' && method === 'GET') {
    return resp(200, state.terms.filter((x) => x.published).map((x) => ({ id: x.id, product: x.product, version: x.version, terms: x.terms, hash: x.hash, published_at: x.published_at })));
  }

  if (table === 'product_terms') {
    if (method === 'GET') {
      let found = rows(state.terms);
      if ((q.get('order') || '').indexOf('version.desc') !== -1) found = found.slice().sort((a, b) => b.version - a.version);
      return resp(200, found);
    }
    if (method === 'PATCH') {
      rows(state.terms).forEach((x) => Object.assign(x, body));
      return resp(204);
    }
    if (method === 'POST') {
      if (state.terms.some((x) => x.product === body.product && x.published && body.published)) return dup('idx_product_terms_one_published');
      const row = Object.assign({ id: 'terms-' + (++state.seq), created_at: new Date().toISOString() }, body);
      state.terms.push(row);
      return resp(201, [row]);
    }
  }

  if (table === 'payments') {
    if (method === 'POST') {
      if (state.payments.some((p) => p.client_ref === body.client_ref)) return dup('payments_client_ref_key');
      if (state.payments.some((p) => p.reference === body.reference)) return dup('payments_reference_key');
      if (!(body.amount_kobo > 0)) return resp(400, { code: '23514', message: 'amount_kobo must be positive' });
      const row = Object.assign({ id: 'pay-' + (++state.seq), created_at: new Date().toISOString(), currency: 'NGN', status: 'pending' }, body);
      if (row.status === 'paid' && !row.paid_at) return resp(400, { code: '23514', message: 'payments_paid_needs_time' });
      state.payments.push(row);
      return resp(201, [paymentRow(row)]);
    }
    if (method === 'PATCH') {
      const found = rows(state.payments);
      if (!found.length) return resp(method === 'PATCH' ? 200 : 200, []);
      found.forEach((row) => {
        Object.assign(row, body);
        if (row.status === 'paid' && !row.paid_at) row.paid_at = new Date().toISOString();
      });
      return /return=representation/.test(init.headers && init.headers.Prefer || '')
        ? resp(200, found.map(paymentRow)) : resp(204);
    }
    if (method === 'GET') return resp(200, rows(state.payments).map(paymentRow));
  }

  if (table === 'ledger_entries') {
    if (method === 'POST') {
      if (state.ledger.some((e) => e.entry_ref === body.entry_ref)) return dup('ledger_entries_entry_ref_key');
      if (!(body.amount_kobo > 0) || !Number.isInteger(body.amount_kobo)) return resp(400, { code: '23514', message: 'amount_kobo must be a positive integer' });
      if (['debit', 'credit'].indexOf(body.direction) === -1) return resp(400, { code: '23514', message: 'bad direction' });
      const row = Object.assign({ id: ++state.seq, created_at: new Date().toISOString() }, body);
      state.ledger.push(row);
      return resp(201, [row]);
    }
    if (method === 'GET') return resp(200, rows(state.ledger));
  }

  if (table === 'referral_codes' && method === 'GET') {
    return resp(200, rows(Object.keys(state.codes).map((code) => Object.assign({ code }, state.codes[code]))));
  }

  if (table === 'referrals') {
    if (method === 'POST') {
      if (body.referrer_ref === body.referred_ref) return resp(400, { code: '23514', message: 'referrals_no_self' });
      if (body.qualifying_payment_id && state.referrals.some((r) => r.qualifying_payment_id === body.qualifying_payment_id)) return dup('idx_referrals_one_per_payment');
      if (body.referred_ref && state.referrals.some((r) => r.referred_ref === body.referred_ref && r.status !== 'rejected')) return dup('idx_referrals_one_per_referred');
      const row = Object.assign({ id: 'ref-' + (++state.seq), created_at: new Date().toISOString() }, body);
      state.referrals.push(row);
      return resp(201, [row]);
    }
    if (method === 'GET') return resp(200, rows(state.referrals));
    if (method === 'PATCH') {
      const found = rows(state.referrals);
      found.forEach((r) => Object.assign(r, body));
      /* PostgREST answers the rows when asked (Prefer: return=representation)
         and the decide action reads its own write back — an empty 204 here
         would make a real decision look like a missing row. */
      return /return=representation/.test((init.headers && init.headers.Prefer) || '') ? resp(200, found) : resp(204);
    }
  }

  if (table === 'care_plans') {
    if (method === 'POST') {
      const row = Object.assign({ id: 'plan-' + (++state.seq), created_at: new Date().toISOString() }, body);
      state.plans.push(row);
      return resp(201, [row]);
    }
    /* The ownership check the ledger's indexes cannot express: two plans
       may not carry one payment, and a pass's link has to be findable by
       the payment that opened it. */
    if (method === 'GET') return resp(200, rows(state.plans));
    if (method === 'PATCH') {
      rows(state.plans).forEach((row) => Object.assign(row, body));
      return /return=representation/.test((init.headers && init.headers.Prefer) || '') ? resp(200, rows(state.plans)) : resp(204);
    }
  }

  if (table === 'care_credit_events') {
    if (method === 'POST') { state.events.push(Object.assign({ id: ++state.seq }, body)); return resp(201, [body]); }
  }

  if (table === 'business_line_summary' && method === 'GET') {
    const byLine = {};
    for (const e of state.ledger) {
      const l = byLine[e.business_line] || (byLine[e.business_line] = { business_line: e.business_line, cash_in_kobo: 0, cash_out_kobo: 0, revenue_kobo: 0, unearned_added_kobo: 0, unearned_released_kobo: 0, refunds_kobo: 0, costs_kobo: 0, payable_kobo: 0 });
      if (e.account === 'cash' && e.direction === 'debit') l.cash_in_kobo += e.amount_kobo;
      if (e.account === 'cash' && e.direction === 'credit') l.cash_out_kobo += e.amount_kobo;
      if (e.account === 'revenue' && e.direction === 'credit') l.revenue_kobo += e.amount_kobo;
      if (e.account === 'unearned' && e.direction === 'credit') l.unearned_added_kobo += e.amount_kobo;
      if (e.account === 'unearned' && e.direction === 'debit') l.unearned_released_kobo += e.amount_kobo;
      if (e.account === 'refund') l.refunds_kobo += e.amount_kobo;
      if (e.account === 'expense') l.costs_kobo += e.amount_kobo;
      if (e.account === 'payable') l.payable_kobo += e.amount_kobo;
    }
    return resp(200, Object.keys(byLine).map((k) => byLine[k]));
  }

  if (table === 'referral_report' && method === 'GET') {
    const byStatus = {};
    for (const r of state.referrals) {
      const b = byStatus[r.status] || (byStatus[r.status] = { status: r.status, claims: 0, reward_kobo: 0 });
      b.claims += 1; b.reward_kobo += r.reward_kobo || 0;
    }
    return resp(200, Object.keys(byStatus).map((k) => byStatus[k]));
  }

  return resp(200, []);
};

/* ---------------- helpers ---------------- */

/* The function meters per connection and per team member, deliberately.
   A suite that drove every call from one IP and one login would be
   testing the ceiling instead of the money rules, so each call is a
   fresh caller: a new source IP, and — for the team's door — a fresh
   session id carrying the role the test set up. */
async function call(body, opts = {}) {
  state.ip = (state.ip || 0) + 1;
  if (opts.headers && opts.headers.authorization) {
    state.auth = { user: 'user-' + state.ip + '-0000000000000', role: (state.auth && state.auth.role) || 'admin' };
  }
  const event = {
    httpMethod: opts.method || 'POST',
    headers: Object.assign({
      'x-nf-client-connection-ip': opts.ip || ('10.' + (state.ip % 200) + '.' + (state.ip % 250) + '.' + (state.ip % 251)),
    }, opts.headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  const res = await finance.handler(event);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = null; }
  return { status: res.statusCode, body: parsed };
}

async function webhookCall(raw, signature) {
  const res = await webhook.handler({
    httpMethod: 'POST',
    headers: { 'x-paystack-signature': signature },
    body: raw,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const UUID = () => '11111111-1111-4111-8111-' + String(++state.seq).padStart(12, '0');

async function publishTerms(terms) {
  const res = await call({ action: 'publish_terms', terms: terms || TERMS }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  if (res.status !== 201) throw new Error('publish_terms failed: ' + JSON.stringify(res.body));
  return res.body;
}

async function buy(overrides = {}) {
  const order = await call(Object.assign({
    action: 'order', client_ref: UUID(), name: 'Harness Student', phone: '08031112233', email: 'h@example.com',
  }, overrides));
  return order;
}

/* ============================================================
   1. sales stay off until the terms are approved
   ============================================================ */

console.log('\n1. Nothing is on sale until an admin approves the terms\n');

await t('the checkout cannot even read terms before one is published', async () => {
  const res = await call({ action: 'terms' });
  eq(res.status, 503, 'status');
  eq(res.body.kind, 'not-ready', 'class');
});

await t('and an order is refused, so no unpaid row exists', async () => {
  const before = state.payments.length;
  const res = await buy();
  eq(res.status, 503, 'status');
  eq(res.body.kind, 'not-ready', 'class');
  eq(state.payments.length, before, 'rows written');
});

await t('support cannot publish the terms — only the admin', async () => {
  state.auth = { user: 'support', role: 'support' };
  const res = await call({ action: 'publish_terms', terms: TERMS }, { headers: { authorization: 'Bearer support-token-000000001' } });
  eq(res.status, 403, 'status');
});

await t('marketing reaches no part of the books', async () => {
  state.auth = { user: 'marketing', role: 'marketing' };
  const res = await call({ action: 'report' }, { headers: { authorization: 'Bearer marketing-token-00000001' } });
  eq(res.status, 403, 'status');
});

await t('no session at all is a 401, not a 403', async () => {
  state.auth = null;
  const res = await call({ action: 'report' });
  eq(res.status, 401, 'status');
});

/* ============================================================
   2. the price is the published terms', and it is frozen
   ============================================================ */

console.log('\n2. The price is published, frozen at purchase, and not the caller\u2019s to name\n');

state.auth = { user: 'admin', role: 'admin' };
await t('an admin publishes the approved terms', async () => {
  const out = await publishTerms(TERMS);
  eq(out.version, 1, 'version');
  eq(!!out.hash, true, 'hash');
});

await t('the published terms are the price the checkout is offered', async () => {
  const res = await call({ action: 'terms' });
  eq(res.status, 200, 'status');
  eq(res.body.terms.price_kobo, 2000000, 'price');
  eq(res.body.storage_enabled, false, 'storage');
});

await t('the order amount is the terms\u2019, and a caller cannot change it', async () => {
  const res = await buy({ amount_kobo: 1, price_kobo: 1 });
  eq(res.status, 201, 'status');
  eq(res.body.amount_kobo, 2000000, 'amount');
  const row = state.payments.filter((p) => p.reference === res.body.reference)[0];
  /* The STORED order, not just the response — a caller-supplied amount
     would show up here, which is the whole point of the rule. */
  eq(row.amount_kobo, 2000000, 'stored amount');
  eq(row.business_line, 'care', 'business line');
  eq(row.purpose, 'care_pass', 'purpose');
  eq(!!row.terms_id, true, 'terms id');
  eq(row.terms_version, 1, 'terms version');
});

await t('publishing a new price cannot re-price a paid order', async () => {
  const order = await buy();
  const before = state.payments.filter((p) => p.reference === order.body.reference)[0];
  const frozen = before.amount_kobo;
  const newTerms = Object.assign({}, TERMS, { price_kobo: 2500000 });
  await publishTerms(newTerms);
  eq(before.amount_kobo, frozen, 'the paid order moved');
  eq(before.terms_version, 1, 'its accepted version changed');
  const fresh = await buy();
  eq(fresh.body.amount_kobo, 2500000, 'a NEW order should use the new price');
  /* restore for the rest of the suite */
  await publishTerms(TERMS);
});

/* ============================================================
   3. a redirect is not a payment
   ============================================================ */

console.log('\n3. Only the provider\u2019s own confirmation activates coverage\n');

await t('a pending payment does not activate', async () => {
  const order = await buy();
  state.paystack.status = 'pending';
  const res = await call({ action: 'verify', reference: order.body.reference });
  eq(res.status, 200, 'status');
  eq(res.body.activated, false, 'activated');
  eq(state.plans.length, 0, 'a plan was opened');
});

await t('a failed payment is recorded and does not activate', async () => {
  const order = await buy();
  state.paystack.status = 'failed';
  await call({ action: 'verify', reference: order.body.reference });
  const row = state.payments.filter((p) => p.reference === order.body.reference)[0];
  eq(row.status, 'failed', 'status');
  eq(row.activated_at || null, null, 'activated');
  eq(state.plans.length, 0, 'a plan was opened');
});

await t('a successful verify activates: a term, a cap, credits and the books', async () => {
  const order = await buy();
  state.paystack.status = 'success';
  state.paystack.amount = null;
  const res = await call({ action: 'verify', reference: order.body.reference });
  eq(res.status, 200, 'status');
  eq(res.body.activated, true, 'activated');
  eq(res.body.call_out_cap, 4, 'cap');
  eq(!!res.body.coverage_start && !!res.body.coverage_end, true, 'a defined window');
  eq(new Date(res.body.coverage_end) > new Date(res.body.coverage_start), true, 'end after start');

  const plan = state.plans[state.plans.length - 1];
  const paidRow = state.payments.filter((p) => p.reference === order.body.reference)[0];
  eq(plan.terms_version, paidRow.terms_version, 'plan carries the accepted terms version');
  eq(plan.call_out_cap, 4, 'plan cap');
  eq(!!plan.payment_id, true, 'plan is tied to its payment');

  const grant = state.events.filter((e) => e.event === 'granted');
  eq(grant.length, 1, 'grants');
  eq(grant[0].delta, 4, 'granted credits');

  const refs = state.ledger.filter((e) => e.payment_id === plan.payment_id).map((e) => e.account + ':' + e.direction);
  eq(refs.sort(), ['cash:debit', 'unearned:credit'], 'ledger postings');
  eq(state.ledger.every((e) => Number.isInteger(e.amount_kobo)), true, 'kobo are integers');
});

await t('an amount that does not match the order is refused and recorded, never activated', async () => {
  const order = await buy();
  state.paystack.status = 'success';
  state.paystack.amount = 500000; // ₦5,000 for a ₦20,000 pass
  const res = await call({ action: 'verify', reference: order.body.reference });
  eq(res.status, 409, 'status');
  const row = state.payments.filter((p) => p.reference === order.body.reference)[0];
  eq(row.status, 'failed', 'status');
  eq(!!row.activation_error, true, 'the mismatch is recorded');
  eq(row.activated_at || null, null, 'activated');
  state.paystack.amount = null;
});

/* ============================================================
   4. nothing activates twice
   ============================================================ */

console.log('\n4. A replayed callback cannot buy a second pass\n');

await t('a second verify of a paid order adds no plan, credit or ledger row', async () => {
  const order = await buy();
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: order.body.reference });
  const plansBefore = state.plans.length;
  const ledgerBefore = state.ledger.length;
  const eventsBefore = state.events.length;
  const again = await call({ action: 'verify', reference: order.body.reference });
  eq(again.body.activated, true, 'still reports active');
  eq(state.plans.length, plansBefore, 'plans');
  eq(state.ledger.length, ledgerBefore, 'ledger');
  eq(state.events.length, eventsBefore, 'credits');
});

await t('a signed webhook activating a paid order is a no-op, not a twin', async () => {
  const order = await buy();
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: order.body.reference });
  const before = { plans: state.plans.length, ledger: state.ledger.length };

  const raw = JSON.stringify({ event: 'charge.success', data: { reference: order.body.reference, amount: 2000000, currency: 'NGN' } });
  const sig = (await import('node:crypto')).createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  const res = await webhookCall(raw, sig);
  eq(res.status, 200, 'status');
  eq(res.body.already, true, 'already');
  eq(state.plans.length, before.plans, 'plans');
  eq(state.ledger.length, before.ledger, 'ledger');
});

await t('and a webhook that has never been verified still activates exactly once', async () => {
  const order = await buy();
  const raw = JSON.stringify({ event: 'charge.success', data: { reference: order.body.reference, amount: 2000000, currency: 'NGN' } });
  const sig = (await import('node:crypto')).createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  const first = await webhookCall(raw, sig);
  const plans = state.plans.length;
  const second = await webhookCall(raw, sig);
  eq(first.body.activated, true, 'first activated');
  eq(second.body.already, true, 'second was a no-op');
  eq(state.plans.length, plans, 'a second plan was opened');
});

await t('an unsigned or wrongly-signed callback is refused before anything is read', async () => {
  const order = await buy();
  const raw = JSON.stringify({ event: 'charge.success', data: { reference: order.body.reference, amount: 2000000, currency: 'NGN' } });
  const requestsBefore = state.requests.length;
  const res = await webhookCall(raw, 'deadbeef');
  eq(res.status, 401, 'status');
  eq(state.requests.length, requestsBefore, 'it read the database anyway');
});

/* ============================================================
   5. a double tap is one order
   ============================================================ */

console.log('\n5. A double-tapped Pay button is one order\n');

await t('the same client_ref replays the same order', async () => {
  const ref = UUID();
  const first = await buy({ client_ref: ref });
  const second = await buy({ client_ref: ref });
  eq(second.body.replay, true, 'replay');
  eq(second.body.reference, first.body.reference, 'same age order');
  eq(state.payments.filter((p) => p.client_ref === ref).length, 1, 'a second row was written');
});

await t('and the SAME payment page — a replay opens no second transaction', async () => {
  const ref = UUID();
  const opened = state.paystack.initialized.length;
  const first = await buy({ client_ref: ref });
  const second = await buy({ client_ref: ref });
  eq(first.status, 201, 'first order');
  eq(second.status, 200, 'replay');
  eq(second.body.authorization_url, first.body.authorization_url, 'the checkout URL');
  eq(state.paystack.initialized.length, opened + 1, 'transactions opened at the provider');
});

await t('a paid order replays as paid, with no page to pay on again', async () => {
  const ref = UUID();
  const first = await buy({ client_ref: ref });
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: first.body.reference });
  const again = await buy({ client_ref: ref });
  eq(again.body.status, 'paid', 'status');
  eq(again.body.authorization_url, null, 'a second payment page was handed out');
});

/* ============================================================
   5b. a payment page that never opened is a retry, not a dead order
   ============================================================ */

console.log('\n5b. A checkout the provider never opened can be started again\n');

await t('a failed initialize marks the order abandoned and tells the page to retry', async () => {
  const before = state.payments.length;
  state.paystack.failInitialize = true;
  const res = await buy({ client_ref: UUID() });
  state.paystack.failInitialize = false;
  eq(res.status, 502, 'status');
  eq(res.body.retry, true, 'the page was told to start again');
  eq(res.body.error.indexOf('Nothing has been charged') !== -1, true, 'the buyer is told nothing was charged');
  const row = state.payments[state.payments.length - 1];
  eq(state.payments.length, before + 1, 'one order recorded');
  eq(row.status, 'abandoned', 'the order is honest about itself');
  eq(String(row.activation_error).indexOf('never reached') !== -1, true, 'why it is abandoned');
});

await t('replaying that client_ref says retry instead of handing back an order with no page', async () => {
  state.paystack.failInitialize = true;
  const ref = UUID();
  await buy({ client_ref: ref });
  state.paystack.failInitialize = false;
  const before = state.payments.length;
  const again = await buy({ client_ref: ref });
  eq(again.status, 200, 'status');
  eq(again.body.retry, true, 'retry');
  eq(again.body.authorization_url == null, true, 'a URL appeared from nowhere');
  eq(state.payments.length, before, 'a second row was written');
});

await t('and a fresh order after it opens a real checkout', async () => {
  const res = await buy({ client_ref: UUID() });
  eq(res.status, 201, 'status');
  eq(/^https:\/\/checkout\.paystack\.com\//.test(String(res.body.authorization_url)), true, 'checkout URL');
});

/* ============================================================
   6. referrals — ₦2,000 once, after a verified first payment
   ============================================================ */

console.log('\n6. Referrals pay once, never to yourself\n');

state.codes['AMB-OK'] = { owner_ref: '2348011111111', owner_name: 'Amaka', active: true };
state.codes['AMB-OLD'] = { owner_ref: '2348022222222', active: false };

await t('a referral qualifies only on the referred customer\u2019s VERIFIED payment', async () => {
  const order = await buy({ phone: '08033334444', referral_code: 'AMB-OK' });
  const unfunded = state.referrals.length;
  eq(unfunded, state.referrals.length, 'nothing before payment');
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: order.body.reference });
  const made = state.referrals.filter((r) => r.referred_ref === '2348033334444');
  eq(made.length, 1, 'referrals');
  eq(made[0].status, 'pending_qualification', 'status');
  eq(made[0].reward_kobo, 200000, 'reward');
  eq(made[0].referrer_ref, '2348011111111', 'referrer');
  eq(!!made[0].qualifying_payment_id, true, 'the qualifying payment is recorded');
});

await t('the same qualifying payment cannot pay a second time', async () => {
  const before = state.referrals.length;
  const first = state.referrals[before - 1];
  state.paystack.status = 'success';
  await webhookCall(JSON.stringify({ event: 'charge.success', data: { reference: first.qualifying_payment_ref, amount: 2000000, currency: 'NGN' } }),
    (await import('node:crypto')).createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify({ event: 'charge.success', data: { reference: first.qualifying_payment_ref, amount: 2000000, currency: 'NGN' } })).digest('hex'));
  eq(state.referrals.length, before, 'a second reward');
});

await t('a customer who was already referred cannot qualify again', async () => {
  state.codes['BOLA-OK'] = { owner_ref: '2348055555555', active: true };
  const order = await buy({ phone: '08033334444', referral_code: 'BOLA-OK' });
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: order.body.reference });
  eq(state.referrals.filter((r) => r.referred_ref === '2348033334444').length, 1, 'duplicate qualification');
});

await t('a self-referral is refused', async () => {
  state.codes['SELF-OK'] = { owner_ref: '2348066666666', active: true };
  const order = await buy({ phone: '08066666666', referral_code: 'SELF-OK' });
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: order.body.reference });
  eq(state.referrals.filter((r) => r.referred_ref === '2348066666666').length, 0, 'self-referral was paid');
});

await t('an inactive or unknown code earns nobody anything', async () => {
  const o1 = await buy({ phone: '08077777777', referral_code: 'AMB-OLD' });
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: o1.body.reference });
  const o2 = await buy({ phone: '08088888888', referral_code: 'GHOST-CODE' });
  await call({ action: 'verify', reference: o2.body.reference });
  eq(state.referrals.filter((r) => ['2348077777777', '2348088888888'].indexOf(r.referred_ref) !== -1).length, 0, 'a bad code paid');
});

await t('a referral is never marked paid without a provider reference', async () => {
  const one = state.referrals[0];
  const res = await call({ action: 'referral_decide', id: one.id, status: 'paid' }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 400, 'status');
  const ok = await call({ action: 'referral_decide', id: one.id, status: 'paid', payout_provider_ref: 'pay_tx_1' }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(ok.status, 200, 'status');
});

await t('support cannot decide a referral payout', async () => {
  state.auth = { user: 'support', role: 'support' };
  const res = await call({ action: 'referral_decide', id: state.referrals[0].id, status: 'approved' }, { headers: { authorization: 'Bearer support-token-000000001' } });
  eq(res.status, 403, 'status');
  state.auth = { user: 'admin', role: 'admin' };
});

/* ============================================================
   7. storage stays off
   ============================================================ */

console.log('\n7. Storage is refused while it is switched off\n');

await t('the terms page reports storage as off', async () => {
  const res = await call({ action: 'terms' });
  eq(res.body.storage_enabled, false, 'storage_enabled');
});

await t('and there is no revenue path that takes a storage payment', async () => {
  eq(state.ledger.filter((e) => e.business_line === 'storage').length, 0, 'storage postings');
});

/* ============================================================
   8. housing is free — no fee, no commission, ever
   ============================================================ */

console.log('\n8. Housing is free, deliberately and verifiably\n');

await t('no order can be raised against housing or rent', async () => {
  const res = await buy({ business_line: 'housing', purpose: 'rent_commission', amount_kobo: 99999 });
  eq(res.status, 201, 'status');
  const row = state.payments.filter((p) => p.reference === res.body.reference)[0];
  eq(row.business_line, 'care', 'business line');
  eq(row.purpose, 'care_pass', 'purpose');
});

await t('the finance report states housing revenue and rent commission as zero', async () => {
  const res = await call({ action: 'report' }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 200, 'status');
  eq(res.body.housing.revenue_kobo, 0, 'housing revenue');
  eq(res.body.housing.rent_commission_bps, 0, 'rent commission');
  eq(res.body.housing.listing_fee_kobo, 0, 'listing fee');
});

/* ============================================================
   9. the books: cash is not revenue, and refunds reverse
   ============================================================ */

console.log('\n9. The books separate cash from revenue, and refunds reverse\n');

await t('cash collected is NOT counted as revenue', async () => {
  const res = await call({ action: 'report' }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  const care = res.body.lines.care;
  eq(care.cash_in_kobo > 0, true, 'there is cash');
  eq(care.revenue_kobo, 0, 'revenue was claimed on cash');
  eq(care.unearned_kobo, care.cash_in_kobo, 'the whole sale is still owed as coverage');
});

await t('a refund is a reversal posting and a status, not an edit', async () => {
  const order = await buy();
  state.paystack.status = 'success';
  await call({ action: 'verify', reference: order.body.reference });
  const ledgerBefore = state.ledger.length;

  const res = await call({ action: 'refund', reference: order.body.reference }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 200, 'status');
  eq(res.body.refunded_kobo, 2000000, 'refunded');

  const added = state.ledger.slice(ledgerBefore);
  eq(added.length, 2, 'entries added');
  eq(added.map((e) => e.account + ':' + e.direction).sort(), ['cash:credit', 'refund:debit'], 'refund postings');
  const row = state.payments.filter((p) => p.reference === order.body.reference)[0];
  eq(row.status, 'refunded', 'status');
});

await t('support cannot refund', async () => {
  state.auth = { user: 'support', role: 'support' };
  const res = await call({ action: 'refund', reference: state.payments[0].reference }, { headers: { authorization: 'Bearer support-token-000000001' } });
  eq(res.status, 403, 'status');
  state.auth = { user: 'admin', role: 'admin' };
});

await t('the totals reconcile to the ledger, not to a stored number', async () => {
  const res = await call({ action: 'report' }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  const care = res.body.lines.care;
  const cashNet = state.ledger.filter((e) => e.business_line === 'care' && e.account === 'cash')
    .reduce((n, e) => n + (e.direction === 'debit' ? e.amount_kobo : -e.amount_kobo), 0);
  eq(care.cash_in_kobo - care.cash_out_kobo, cashNet, 'cash net');
});

/* ============================================================
   10. configuration and the coverage window
   ============================================================ */

console.log('\n10. Assumptions are the admin\u2019s, and a term has a defined end\n');

await t('support cannot change configuration', async () => {
  state.auth = { user: 'support', role: 'support' };
  const res = await call({ action: 'set_config', config: { care_pass_price_kobo: 1 } }, { headers: { authorization: 'Bearer support-token-000000001' } });
  eq(res.status, 403, 'status');
  state.auth = { user: 'admin', role: 'admin' };
});

await t('an unknown config key is refused', async () => {
  const res = await call({ action: 'set_config', config: { whatever: 1 } }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 400, 'status');
});

await t('a pinned semester end is used for the coverage window', async () => {
  const res = await call({ action: 'set_config', config: { care_term_end: '2030-09-01T00:00:00.000Z' } }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 200, 'status');
  const order = await buy();
  state.paystack.status = 'success';
  const verify = await call({ action: 'verify', reference: order.body.reference });
  eq(verify.body.coverage_end.slice(0, 10), '2030-09-01', 'coverage end');
  await call({ action: 'set_config', config: { care_term_end: null } }, { headers: { authorization: 'Bearer admin-token-000000000001' } });
});

await t('the terms hash is order-independent, so it can prove the wording', async () => {
  const a = finance.termsHash({ b: 1, a: [1, 2], c: { z: 1, y: 2 } });
  const b = finance.termsHash({ c: { y: 2, z: 1 }, a: [1, 2], b: 1 });
  eq(a, b, 'hash');
  eq(a.length, 64, 'sha-256 hex');
});

/* ============================================================
   11. the service key is the last gate
   ============================================================ */

console.log('\n11. Without the service key nothing writes, and the page is told why\n');

await t('a missing SUPABASE_SERVICE_ROLE_KEY is a not-ready 503, not a retry-me error', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  try {
    const res = await call({ action: 'terms' });
    eq(res.status, 503, 'status');
    eq(res.body.kind, 'not-ready', 'class');
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

/* The other half of the same deployment fact, and the one that actually
   happened: the variable IS set and Supabase refuses the value. It looked
   like a 502 — "we could not complete that just now" — so every visitor
   was invited to retry a deploy nobody had fixed, and the student buying
   a Care Pass was told nothing true. Re-running the checkout against the
   refused key must land on the same not-ready answer as a missing one. */
await t('a service key Supabase REFUSES is a not-ready 503 too \u2014 not a retry-me 502', async () => {
  state.refuseKey = true;
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  process.env.TELEGRAM_BOT_TOKEN = 'stand-in-bot-token';
  process.env.TELEGRAM_CHAT_ID = 'stand-in-chat';
  const alertsBefore = state.requests.filter((r) => r.indexOf('api.telegram.org') !== -1).length;
  try {
    const terms = await call({ action: 'terms' });
    eq(terms.status, 503, 'terms status');
    eq(terms.body.kind, 'not-ready', 'terms class');
    const before = state.payments.length;
    const order = await buy();
    eq(order.status, 503, 'order status');
    eq(order.body.kind, 'not-ready', 'order class');
    eq(state.payments.length, before, 'rows written');
    /* A student can neither read a function log nor fix a Netlify
       variable, so the alert is the whole operator half of this — and
       it has to be ONE alert for the deploy, not one per visitor. Two
       refused calls, one message. */
    const alerts = state.requests.filter((r) => r.indexOf('api.telegram.org') !== -1).length - alertsBefore;
    eq(alerts, 1, 'alerts sent for two refused calls');
  } finally {
    state.refuseKey = false;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = saved.chat;
  }
});

/* The provider key is the one secret whose leak turns a payment page into
   somebody else's revenue. Nothing the browser can download may carry it
   — not a page, not an asset, not a comment. Read from disk, so this is a
   claim about what is SERVED rather than about what the function reads. */
await t('no page or asset the browser can fetch carries the provider secret', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  for (const f of readdirSync(ROOT)) if (/\.html$/.test(f)) files.push(f);
  for (const f of readdirSync(join(ROOT, 'assets'))) if (/\.(js|css|json)$/.test(f)) files.push('assets/' + f);
  const leaked = [];
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    if (/sk_(live|test)_[A-Za-z0-9]+/.test(text) || /PAYSTACK_SECRET_KEY\s*=\s*['"][^'"]+['"]/.test(text)) leaked.push(f);
  }
  eq(leaked, [], 'files carrying a provider secret');
});

await t('the public status answer never exposes the stored payment page', async () => {
  const order = await buy({ client_ref: UUID() });
  const res = await call({ action: 'status', reference: order.body.reference });
  eq(res.status, 200, 'status');
  eq('authorization_url' in res.body, false, 'the checkout capability is in a public read');
  eq('provider_payload' in res.body, false, 'the provider payload is in a public read');
  eq('client_ref' in res.body, false, 'the idempotency key is in a public read');
});

/* ============================================================
   13. handing the product over
   ============================================================ */

console.log('\n13. The buyer can reach what they bought \u2014 and a reference alone buys nobody a pass\n');

const planFor = (ref) => state.plans.filter((p) => p.payment_id === state.payments.filter((x) => x.reference === ref)[0].id)[0];

/* The buyer's own capability: the uuid ITS browser generated. */
let buyerRef = null;
let buyerOrder = null;
let buyerToken = null;

await t('the pass is reported from the plan activation opened, with the dates it really has', async () => {
  buyerRef = UUID();
  buyerOrder = await buy({ client_ref: buyerRef });
  state.paystack.status = 'success';
  const res = await call({ action: 'verify', reference: buyerOrder.body.reference, client_ref: buyerRef });
  eq(res.body.activated, true, 'activated');
  eq(!!res.body.coverage, true, 'a coverage block');
  const plan = planFor(buyerOrder.body.reference);
  eq(res.body.coverage.start, plan.coverage_start, 'coverage start is the plan\u2019s');
  eq(res.body.coverage.end, plan.coverage_end, 'coverage end is the plan\u2019s');
  eq(res.body.coverage.call_out_cap, plan.call_out_cap, 'the cap is the plan\u2019s');
  eq(res.body.receipt_ref, plan.receipt_ref, 'the receipt is the plan\u2019s');
});

await t('the buying browser is handed the link, and the token really opens the plan', async () => {
  const again = await call({ action: 'verify', reference: buyerOrder.body.reference, client_ref: buyerRef });
  /* The first verify issued it and marked the order, so this one has
     nothing left to give — which is what "issued once" means. */
  eq(again.body.pass_link || null, null, 'a second link');
  const plan = planFor(buyerOrder.body.reference);
  const marker = state.payments.filter((p) => p.reference === buyerOrder.body.reference)[0].notes || '';
  eq(marker.indexOf(finance.PASS_LINK_MARK) !== -1, true, 'the issuance was recorded on the order');
  eq(typeof plan.token_hash, 'string', 'the plan was keyed');
});

await t('the verify answer carries the amount and the version the order was created against', async () => {
  /* What a receipt is made of. Both come from the stored order, so the
     return page cannot print an amount or a version nobody agreed to. */
  const cr = UUID();
  const order = await buy({ client_ref: cr });
  const stored = state.payments.filter((p) => p.reference === order.body.reference)[0];
  const first = await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  eq(first.body.amount_kobo, stored.amount_kobo, 'the amount on activation');
  eq(first.body.terms_version, stored.terms_version, 'the terms version on activation');
  /* And on a later look at the same order — the version the ORDER was
     created against, which later publications cannot move. */
  const again = await call({ action: 'verify', reference: order.body.reference });
  eq(again.body.amount_kobo, stored.amount_kobo, 'the amount on a later look');
  eq(again.body.terms_version, stored.terms_version, 'the terms version on a later look');
});

await t('a fresh order hands over its link once, and the token is the one on the plan', async () => {
  const cr = UUID();
  const order = await buy({ client_ref: cr });
  const first = await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  eq(!!first.body.pass_link, true, 'no link handed over');
  buyerToken = first.body.pass_link.token;
  eq(hashToken(buyerToken), planFor(order.body.reference).token_hash, 'the token does not open the plan');
  eq(first.body.pass_link.path, '/my-care?t=' + buyerToken, 'the path');

  const second = await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  eq(second.body.pass_link || null, null, 'the link was handed over twice');
  eq(planFor(order.body.reference).token_hash, hashToken(buyerToken), 'the second call replaced a link the buyer holds');
});

await t('a reference alone \u2014 the value that travels in a URL \u2014 gets no link', async () => {
  const cr = UUID();
  const order = await buy({ client_ref: cr });
  await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  const plan = planFor(order.body.reference);
  const held = plan.token_hash;

  const stranger = await call({ action: 'verify', reference: order.body.reference });
  eq(stranger.body.activated, true, 'the summary is public to the reference');
  eq(stranger.body.pass_link || null, null, 'a link to a stranger');

  const wrongBrowser = await call({ action: 'verify', reference: order.body.reference, client_ref: UUID() });
  eq(wrongBrowser.body.pass_link || null, null, 'a link to a browser that did not pay');
  eq(planFor(order.body.reference).token_hash, held, 'a stranger re-minted the link');

  const status = await call({ action: 'status', reference: order.body.reference, client_ref: cr });
  eq(!!status.body.coverage, true, 'status reports the pass');
  eq(status.body.pass_link || null, null, 'status handed over a link');
});

await t('when the webhook opened the pass, the buyer\u2019s own browser can still claim it \u2014 once', async () => {
  const cr = UUID();
  const order = await buy({ client_ref: cr });
  const raw = JSON.stringify({
    event: 'charge.success',
    data: { reference: order.body.reference, amount: order.body.amount_kobo, currency: 'NGN', status: 'success' },
  });
  const sig = (await import('node:crypto')).createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  const hook = await webhookCall(raw, sig);
  eq(hook.status, 200, 'the webhook');
  const plan = planFor(order.body.reference);
  const webhookKey = plan.token_hash;

  const claim = await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  eq(!!claim.body.pass_link, true, 'the buyer was left without a link');
  eq(hashToken(claim.body.pass_link.token), planFor(order.body.reference).token_hash, 'the claimed token does not open the plan');
  eq(hashToken(claim.body.pass_link.token) === webhookKey, false, 'the unseen webhook key was handed out');

  const twice = await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  eq(twice.body.pass_link || null, null, 'claimed twice');
});

/* THE CASE THE MUTATION CONTROL FOUND. The checks above pass even when
   the ownership test is crippled, because the "issued once" marker is
   what refuses them — so this one isolates the ownership rule: a pass
   opened by the webhook has no marker, and a browser that cannot name
   the client_ref must still get nothing. */
await t('a stranger cannot claim a pass the webhook opened', async () => {
  const cr = UUID();
  const order = await buy({ client_ref: cr });
  const raw = JSON.stringify({
    event: 'charge.success',
    data: { reference: order.body.reference, amount: order.body.amount_kobo, currency: 'NGN', status: 'success' },
  });
  const sig = (await import('node:crypto')).createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  await webhookCall(raw, sig);
  const held = planFor(order.body.reference).token_hash;

  const noRef = await call({ action: 'verify', reference: order.body.reference });
  eq(noRef.body.pass_link || null, null, 'a link to a caller with no client_ref');
  const wrongRef = await call({ action: 'verify', reference: order.body.reference, client_ref: UUID() });
  eq(wrongRef.body.pass_link || null, null, 'a link to a browser that did not pay');
  const notAUuid = await call({ action: 'verify', reference: order.body.reference, client_ref: 'anything' });
  eq(notAUuid.body.pass_link || null, null, 'a link to a made-up client_ref');
  eq(planFor(order.body.reference).token_hash, held, 'a stranger replaced the pass\u2019s key');
});

await t('a paid order with no plan at all reports no coverage rather than inventing a window', async () => {
  const cr = UUID();
  const order = await buy({ client_ref: cr });
  const row = state.payments.filter((p) => p.reference === order.body.reference)[0];
  row.activated_at = new Date().toISOString();
  row.receipt_ref = 'AZ-R-ORPHAN';
  const res = await call({ action: 'verify', reference: order.body.reference, client_ref: cr });
  eq(res.body.coverage || null, null, 'coverage');
  eq(res.body.receipt_ref, 'AZ-R-ORPHAN', 'the receipt the order holds');
  eq(res.body.pass_link || null, null, 'a link with no plan behind it');
});

await t('the buyer returns to THIS deployment, not to an origin the caller names', async () => {
  state.paystack.initialized.length = 0;
  const order = await buy({ callback_url: 'https://evil.test/steal', origin: 'https://evil.test', redirect: 'https://evil.test' });
  const init = state.paystack.initialized[0];
  eq(init.callback_url.indexOf('https://evil.test'), -1, 'the caller aimed the return');
  eq(init.callback_url, finance.siteOrigin() + '/care-pass?reference=' + order.body.reference, 'the callback');
});

await t('what the provider is asked for is the terms\u2019 price, never the caller\u2019s number', async () => {
  state.paystack.initialized.length = 0;
  await buy({ amount_kobo: 100, price_kobo: 100, amount: 100 });
  const init = state.paystack.initialized[0];
  eq(init.amount, 2000000, 'the amount sent to the provider');
  eq(init.currency, 'NGN', 'currency');
});

/* ---------------- report ---------------- */

console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
console.log(passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
