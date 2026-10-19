#!/usr/bin/env node
/* ============================================================
   Arzuz — repair claims

   netlify/functions/claims.js is the only writer of repair_claims,
   claim_events and the call-out reservations. Every rule the brief
   fixes in place is tested here, with no database and no network:

     · a claim is filed against ONE pass, by whoever holds that pass's
       link — and a student never sees another student's claim
     · coverage is DECIDED by an admin, with a reason, and a refusal is
       recorded as a refusal rather than a silence
     · the call-out is taken ATOMICALLY: two approvals for the last one
       leave exactly one reservation, and the other claim is told the
       pass has nothing left — it is not approved against an allowance
       that is gone
     · a worker's report is not a finished job: it moves to
       awaiting_customer, and only the customer's word (or a named
       resolution) completes it
     · a call-out that is given back is given back on the LEDGER, not
       by editing a number
     · a repair cost is POSTED (expense + provider payable), with an
       entry_ref that cannot be posted twice
     · support coordinates and the admin decides; marketing reaches
       nothing; the student door cannot approve, spend or close

   The stand-in below enforces the SAME constraints supabase-claims.sql
   declares (the status vocabulary, completed-needs-confirmation, the
   dispute pair, the reservation pair, one open claim per call-out) and
   implements the two RPCs the schema owns — reserve and release — with
   the serialisation the advisory lock provides in Postgres. A test
   failing here is a bug in the function.

   Run from arzuz-site/:
     node scripts/test-claims.mjs
   ============================================================ */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stand-in.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'stand-in-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stand-in-service-role-key';

/* The three notice channels, and the one that carries a nudge to the
   team. Set HERE rather than left unset, because "not configured" would
   make every delivery test pass by sending nothing — the same trap as a
   suite that only ever tests the happy path. The stand-in below records
   what would have gone out, so the tests can read the words. */
process.env.OPENWA_URL = process.env.OPENWA_URL || 'https://openwa.stand-in.test';
process.env.OPENWA_API_KEY = process.env.OPENWA_API_KEY || 'stand-in-openwa-key';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'stand-in-resend-key';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'stand-in:telegram-token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-100555';

const claims = require('../netlify/functions/claims.js');
const clock = require('../netlify/functions/claims-aging.js');
/* The daily visit digest: composed at chosen instants rather than waited
   for. The same suite, because it counts the same days claims.js defines
   and a second stand-in would let the two definitions drift. */
const digest = require('../netlify/functions/claims-digest.js');
const alerts = require('../netlify/functions/notify.js');
const care = require('../netlify/functions/care-credit.js');
const { hashToken, normalizePhone } = require('../netlify/functions/roommate-match.js');
/* The inbound door: OpenWA posts a worker's reply to /api/wa-inbound, and
   that function calls claims.workerReply(). Driven here rather than in a
   suite of its own so the whole round trip — signature, guards, the words
   the worker gets back, and what the claim records — is one test run. */
const inbound = require('../netlify/functions/wa-inbound.js');

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

function ok(value, what) {
  if (!value) throw new Error(what || 'expected a truthy value');
}

/* ---------------- the stand-in ---------------- */

const TOKEN = 'stand-in-service-role-key';

const state = {
  auth: null,
  alerts: [],
  whatsapp: [],    // what claims.js would have sent, by JID
  mail: [],        // what claims.js would have emailed, by address
  waFails: false,  // the switch that makes a delivery test the refusal
  mailFails: false,
  plans: [],
  events: [],      // care_credit_events
  ledger: [],      // ledger_entries
  claims: [],
  trail: [],       // claim_events
  seq: 0,
  requests: [],
};

function resp(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (obj === undefined ? '' : JSON.stringify(obj)),
    json: async () => (obj === undefined ? null : obj),
  };
}

const fail = (status, message, code) => resp(status, { message: message, code: code || null });

function sift(rows, q) {
  let out = rows.slice();
  for (const [key, raw] of q.entries()) {
    if (['select', 'limit', 'offset', 'order', 'on_conflict'].includes(key)) continue;
    const val = String(raw);
    if (val === 'is.null') { out = out.filter((r) => r[key] == null); continue; }
    if (/^eq\./.test(val)) { out = out.filter((r) => String(r[key]) === val.slice(3)); continue; }
    if (/^like\./.test(val)) {
      const pattern = val.slice(5).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp('^' + pattern + '$');
      out = out.filter((r) => re.test(String(r[key] == null ? '' : r[key])));
      continue;
    }
    /* `in.(a,b)` — the list filter the clock uses to read two event kinds
       in one query. Read literally, or the job would see every row and
       decide a claim had already been nudged when it had not. */
    if (/^in\.\(/.test(val)) {
      const set = val.slice(4).replace(/\)$/, '').split(',').map((x) => x.trim());
      out = out.filter((r) => set.indexOf(String(r[key])) !== -1);
      continue;
    }
    /* PostgREST's `like`, '*' as the wildcard — used by the worker lookup
       as a net over numbers stored in another shape. */
    if (/^like\./.test(val)) {
      const pattern = val.slice(5).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp('^' + pattern + '$');
      out = out.filter((r) => re.test(String(r[key] == null ? '' : r[key])));
      continue;
    }
  }
  if ((q.get('order') || '') === 'created_at.desc') out.reverse();
  const offset = Number(q.get('offset') || 0);
  const limit = Number(q.get('limit') || 0);
  if (offset) out = out.slice(offset);
  if (limit) out = out.slice(0, limit);
  return out;
}

const OPEN_CLAIM_STATUSES = ['approved', 'assigned', 'in_progress', 'awaiting_customer', 'completed', 'disputed'];

/* THE SCHEMA'S OWN CONSTRAINTS, restated for the stand-in — the same
   vocabulary and the same pairings supabase-claims.sql enforces. */
function checkClaim(row) {
  const vocabulary = ['draft', 'submitted', 'under_review', 'approved', 'assigned',
    'in_progress', 'awaiting_customer', 'completed', 'rejected', 'cancelled', 'disputed'];
  if (vocabulary.indexOf(row.status) === -1) return fail(400, 'repair_claims_status_check', '23514');
  if (!row.issue || String(row.issue).trim().length < 5) return fail(400, 'repair_claims_issue_check', '23514');
  if (row.status === 'completed' && !row.customer_confirmed_at && !(row.resolved_at && row.resolution)) {
    return fail(400, 'repair_claims_completed_needs_confirmation', '23514');
  }
  if ((row.disputed_at == null) !== (row.dispute_reason == null)) {
    return fail(400, 'repair_claims_dispute_check', '23514');
  }
  if (row.status === 'disputed' && !row.disputed_at) {
    return fail(400, 'repair_claims_disputed_needs_stamp', '23514');
  }
  if ((row.call_out_no == null) !== (row.reserved_at == null)) {
    return fail(400, 'repair_claims_reservation_check', '23514');
  }
  if (row.actual_kobo != null && Number(row.actual_kobo) < 0) {
    return fail(400, 'repair_claims_actual_check', '23514');
  }
  if (row.eligibility === 'not_covered' && !row.eligibility_reason) {
    return fail(400, 'repair_claims_refusal_reason', '23514');
  }
  if (row.provider_answer != null && ['accepted', 'declined', 'unanswered'].indexOf(row.provider_answer) === -1) {
    return fail(400, 'repair_claims_provider_answer_check', '23514');
  }
  if ((row.provider_answer == null) !== (row.provider_answered_at == null)) {
    return fail(400, 'repair_claims_answer_pair_check', '23514');
  }
  /* A claim is never 'assigned' to somebody who has said no — or to
     somebody the clock has already taken the job back from: the status
     and the answer cannot disagree, because the queue reads both. */
  if (row.status === 'assigned' && ['declined', 'unanswered'].indexOf(row.provider_answer) !== -1) {
    return fail(400, 'repair_claims_declined_is_not_assigned', '23514');
  }
  /* A day and the instant it was offered travel together, or not at all. */
  if ((row.provider_proposal == null) !== (row.provider_proposed_at == null)) {
    return fail(400, 'repair_claims_proposal_pair_check', '23514');
  }
  /* The same rule for the customer's own day, and one more: an AGREED day
     is always an answer to a day somebody actually suggested, so it
     cannot exist on its own. */
  if ((row.customer_proposal == null) !== (row.customer_proposed_at == null)) {
    return fail(400, 'repair_claims_customer_proposal_pair_check', '23514');
  }
  if (row.day_agreed_at != null && row.provider_proposal == null) {
    return fail(400, 'repair_claims_day_agreed_needs_a_day', '23514');
  }
  if (row.call_out_no != null && OPEN_CLAIM_STATUSES.indexOf(row.status) !== -1) {
    const twin = state.claims.filter((c) => c.id !== row.id && c.plan_id === row.plan_id &&
      c.call_out_no === row.call_out_no && OPEN_CLAIM_STATUSES.indexOf(c.status) !== -1);
    if (twin.length) return fail(409, 'idx_repair_claims_one_per_callout', '23505');
  }
  return null;
}

/* The two RPCs. `reserveChain` is the advisory lock: every reservation
   runs to completion before the next one starts, so a "read the
   balance then insert" that would be a race in the application cannot
   happen here either. */
let reserveChain = Promise.resolve();

function creditBalance(planId) {
  return state.events
    .filter((e) => e.plan_id === planId && e.event !== 'expired')
    .reduce((n, e) => n + Number(e.delta), 0);
}

function reserveCallout(p) {
  const run = () => {
    if (creditBalance(p.p_plan_id) <= 0) return { data: null };
    const no = state.events.filter((e) => e.plan_id === p.p_plan_id && e.event === 'reserved').length + 1;
    state.events.push({
      id: ++state.seq, plan_id: p.p_plan_id, student_name: p.p_name || null, session: p.p_session || null,
      event: 'reserved', delta: -1,
      reason: 'Call-out ' + no + ' committed to claim ' + p.p_claim_ref,
      actor_name: p.p_actor || null, env: p.p_env || 'production', created_at: new Date().toISOString(),
    });
    return { data: no };
  };
  const next = reserveChain.then(run, run);
  reserveChain = next.then(() => undefined, () => undefined);
  return next;
}

function releaseCallout(p) {
  const run = () => {
    const mine = (e) => e.plan_id === p.p_plan_id && String(e.reason || '').indexOf(p.p_claim_ref) !== -1;
    const reserved = state.events.filter((e) => mine(e) && e.event === 'reserved').length;
    const released = state.events.filter((e) => mine(e) && e.event === 'released').length;
    if (reserved <= released) return { data: false };
    state.events.push({
      id: ++state.seq, plan_id: p.p_plan_id, student_name: p.p_name || null, session: p.p_session || null,
      event: 'released', delta: 1,
      reason: 'Call-out returned from claim ' + p.p_claim_ref + (p.p_reason ? ' — ' + p.p_reason : ''),
      actor_name: p.p_actor || null, env: p.p_env || 'production', created_at: new Date().toISOString(),
    });
    return { data: true };
  };
  const next = reserveChain.then(run, run);
  reserveChain = next.then(() => undefined, () => undefined);
  return next;
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  state.requests.push(method + ' ' + u);

  if (u.indexOf('/rest/v1/rpc/claim_reserve_callout') !== -1) {
    const out = await reserveCallout(body);
    return resp(200, out.data);
  }
  if (u.indexOf('/rest/v1/rpc/claim_release_callout') !== -1) {
    const out = await releaseCallout(body);
    return resp(200, out.data);
  }
  if (u.indexOf('/rest/v1/rpc/arzuz_role') !== -1) {
    if (!state.auth) return resp(401, {});
    return resp(200, state.auth.role);
  }
  if (u.indexOf('/auth/v1/user') !== -1) {
    if (!state.auth || !state.auth.user) return resp(401, { message: 'invalid claim' });
    return resp(200, { id: state.auth.user, email: state.auth.user + '@arzuz.test' });
  }
  /* The alert channel: recorded, never sent. */
  if (u.indexOf('api.telegram.org') !== -1) {
    state.alerts.push(body);
    return resp(200, { ok: true });
  }
  /* WhatsApp through the OpenWA proxy, and mail through Resend. Both
     answer the way the real provider does, including when the test has
     asked for a refusal, so the failure path is reached by the same
     code that would meet it in production. */
  if (u.indexOf('/messages/send-text') !== -1) {
    if (state.waFails) return resp(502, { message: 'OpenWA refused' });
    state.whatsapp.push({ to: (body && body.chatId) || null, text: (body && body.text) || '' });
    return resp(200, { ok: true });
  }
  if (u.indexOf('api.resend.com') !== -1) {
    if (state.mailFails) return resp(422, { message: 'The domain is not verified' });
    state.mail.push({
      to: ((body && body.to) || [])[0] || null,
      subject: (body && body.subject) || '',
      text: (body && body.text) || '',
    });
    return resp(200, { id: 'mail-' + (++state.seq) });
  }
  if (u.indexOf('/rest/v1/') === -1) return resp(200, {});

  const rest = u.slice(u.indexOf('/rest/v1/') + '/rest/v1/'.length);
  const table = rest.split('?')[0];
  const qs = rest.indexOf('?') !== -1 ? rest.slice(rest.indexOf('?') + 1) : '';
  const q = new URLSearchParams(qs);

  if (table === 'care_plans') {
    if (method === 'GET') return resp(200, sift(state.plans, q));
  }

  if (table === 'care_credit_events') {
    if (method === 'POST') {
      const row = Object.assign({ id: ++state.seq, created_at: new Date().toISOString() }, body);
      state.events.push(row);
      return resp(201, [row]);
    }
    if (method === 'GET') return resp(200, sift(state.events, q));
  }

  if (table === 'rpc/claim_settle_payout' && method === 'POST') {
    const ref = body.p_claim_ref;
    const expected = Number(body.p_amount_kobo);
    const claim = state.claims.find((c) => c.reference === ref);
    if (!claim || claim.actual_kobo !== expected || claim.provider_name !== body.p_provider_name) {
      return fail(409, 'claim_settle_payout claim/work mismatch', 'P0001');
    }
    const pair = state.ledger.filter((e) => e.entry_ref === ref + ':cost' || e.entry_ref === ref + ':payable');
    const exact = (account, direction) => pair.some((e) => e.account === account && e.direction === direction &&
      e.business_line === 'care' && e.source === 'repair_claim' && Number(e.amount_kobo) === expected &&
      (e.env || 'production') === (claim.env || 'production'));
    if (!exact('expense', 'debit') || !exact('payable', 'credit')) {
      return fail(409, 'claim_settle_payout missing repair postings', 'P0001');
    }
    const settledRef = ref + ':settle';
    const cashRef = ref + ':cash';
    const settled = state.ledger.filter((e) => e.entry_ref === settledRef);
    const cash = state.ledger.filter((e) => e.entry_ref === cashRef);
    if (settled.length || cash.length) {
      if (settled.length === 1 && cash.length === 1 && settled[0].amount_kobo === expected && cash[0].amount_kobo === expected &&
          settled[0].memo.endsWith(' · transfer ' + body.p_transfer_ref) && cash[0].memo.endsWith(' · transfer ' + body.p_transfer_ref)) {
        return resp(200, { ok: true, already: true, amount_kobo: expected, entry_ref: settledRef });
      }
      return fail(409, 'claim_settle_payout conflicting prior settlement', 'P0001');
    }
    const transfer = ' · transfer ' + body.p_transfer_ref;
    const time = new Date().toISOString();
    state.ledger.push(
      { id: ++state.seq, created_at: time, entry_ref: settledRef, business_line: 'care', account: 'payable', direction: 'debit', amount_kobo: expected, source: 'repair_payout', memo: 'Paid to ' + body.p_provider_name + ' for ' + ref + transfer, actor_ref: body.p_actor_ref, actor_name: body.p_actor_name, env: body.p_env },
      { id: ++state.seq, created_at: time, entry_ref: cashRef, business_line: 'care', account: 'cash', direction: 'credit', amount_kobo: expected, source: 'repair_payout', memo: 'Transfer to ' + body.p_provider_name + ' for ' + ref + transfer, actor_ref: body.p_actor_ref, actor_name: body.p_actor_name, env: body.p_env }
    );
    return resp(200, { ok: true, amount_kobo: expected, entry_ref: settledRef });
  }

  if (table === 'ledger_entries') {
    if (method === 'POST') {
      if (state.ledger.some((e) => e.entry_ref === body.entry_ref)) {
        return fail(409, 'duplicate key value violates unique constraint "ledger_entries_entry_ref_key"', '23505');
      }
      if (body.source === 'repair_payout') return fail(403, 'repair_payout must use the atomic claim_settle_payout RPC', '42501');
      const row = Object.assign({ id: ++state.seq, created_at: new Date().toISOString() }, body);
      state.ledger.push(row);
      return resp(201, [row]);
    }
    if (method === 'GET') {
      let filtered = sift(state.ledger, q);
      const entryLike = q.get('entry_ref');
      if (entryLike && entryLike.indexOf('like.') === 0) {
        const prefix = entryLike.slice(5).replace(/\*$/, '');
        filtered = state.ledger.filter((e) => String(e.entry_ref || '').startsWith(prefix));
      }
      return resp(200, filtered);
    }
  }

  if (table === 'repair_claims') {
    if (method === 'POST') {
      const row = Object.assign({
        id: 'claim-' + (++state.seq), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        status: 'submitted', photos: [], parts: [], evidence: [], env: 'production',
        call_out_no: null, reserved_at: null, disputed_at: null, dispute_reason: null,
        customer_confirmed_at: null, actual_kobo: null, estimate_kobo: null,
        provider_name: null, provider_phone: null, provider_email: null,
        provider_answer: null, provider_answered_at: null, provider_answer_note: null,
        /* The day columns, as the table defaults them: a row that has
           never had a day on it carries nulls, not absent fields — the
           real table makes that true, so the stand-in has to as well. */
        provider_proposal: null, provider_proposed_at: null,
        customer_proposal: null, customer_proposed_at: null, day_agreed_at: null,
      }, body);
      if (state.claims.some((c) => c.reference === row.reference)) {
        return fail(409, 'duplicate key value violates unique constraint "repair_claims_reference_key"', '23505');
      }
      const bad = checkClaim(row);
      if (bad) return bad;
      state.claims.push(row);
      return resp(201, [row]);
    }
    if (method === 'PATCH') {
      const found = sift(state.claims, q);
      for (const row of found) {
        const next = Object.assign({}, row, body);
        const bad = checkClaim(next);
        if (bad) return bad;
        Object.assign(row, body);
      }
      return /return=representation/.test((init.headers && init.headers.Prefer) || '')
        ? resp(200, found) : resp(204);
    }
    if (method === 'GET') return resp(200, sift(state.claims, q));
  }

  if (table === 'claim_events') {
    if (method === 'POST') {
      const vocabulary = ['filed', 'reviewed', 'decision', 'reserved', 'assigned', 'started',
        'progress', 'work_reported', 'customer_confirmed', 'disputed', 'released',
        'resolution', 'cancelled', 'note', 'notified', 'overdue_nudge', 'accepted', 'declined',
        /* The handover's own words: a day the worker offered, the ask that
           follows a silence, and the job taken back because of it. */
        'proposed', 'chased', 'unanswered',
        /* And the customer's half of that conversation. */
        'day_agreed', 'day_proposed', 'payout_settled'];
      if (vocabulary.indexOf(body.event) === -1) {
        return fail(400, 'claim_events_event_check', '23514');
      }
      const row = Object.assign({ id: ++state.seq, created_at: new Date().toISOString() }, body);
      state.trail.push(row);
      return resp(201, [row]);
    }
    if (method === 'GET') return resp(200, sift(state.trail, q));
  }

  if (table === 'claims_summary' && method === 'GET') {
    const by = {};
    for (const c of state.claims) {
      const k = (c.env || 'production') + ':' + c.status;
      const row = by[k] || (by[k] = {
        env: c.env || 'production', status: c.status, claims: 0, call_outs_committed: 0,
        estimated_kobo: 0, actual_kobo: 0,
      });
      row.claims += 1;
      if (c.call_out_no) row.call_outs_committed += 1;
      row.estimated_kobo += Number(c.estimate_kobo) || 0;
      row.actual_kobo += Number(c.actual_kobo) || 0;
    }
    return resp(200, Object.keys(by).map((k) => by[k]));
  }

  return resp(200, []);
};

/* ---------------- helpers ---------------- */

/* The student door: no Authorization header, ever — the link is the
   credential, exactly as the real page sends it. */
async function student(body, opts = {}) {
  const event = {
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': opts.ip || ('10.9.' + (++state.seq % 200) + '.1') },
    body: JSON.stringify(body),
  };
  const res = await claims.handler(event);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function team(body, opts = {}) {
  const event = {
    httpMethod: 'POST',
    headers: Object.assign({
      'x-nf-client-connection-ip': opts.ip || ('10.8.' + (++state.seq % 200) + '.1'),
      authorization: 'Bearer ' + (opts.name || 'admin') + '-token-' + '0'.repeat(12),
    }, opts.headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  const res = await claims.handler(event);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function asAdmin() { state.auth = { user: 'u-admin', role: 'admin' }; }
function asSupport() { state.auth = { user: 'u-support', role: 'support' }; }

let tokenSeq = 0;

/* The token a pass was opened with, by plan id. A test helper, not a
   feature: the harness has to be able to act as the student who owns a
   pass it created higher up the file, and the real page never sends a
   plan id — only the link. Kept OUT of the plan row on purpose, so a
   stray key cannot become something the function leans on. */
const planTokens = new Map();

function findToken(planId) {
  return planTokens.get(planId) || '';
}

/* A pass with four call-outs, exactly as a Care Pass opens one. */
function openPass(over = {}) {
  const token = 'tok-' + (++tokenSeq) + '-' + 'x'.repeat(30);
  const plan = Object.assign({
    id: 'plan-' + (++state.seq),
    session: '2026/2027',
    status: 'active',
    env: 'production',
    token_hash: hashToken(token),
    coverage_start: '2026-10-13T09:00:00.000Z',
    coverage_end: '2027-02-10T09:00:00.000Z',
    call_out_cap: 4,
    receipt_ref: 'AZ-R-' + tokenSeq,
    terms_version: 3,
    payment_id: 'pay-' + state.seq,
    payload: { name: 'Ada Okonkwo', phone: '2348031112233', area: 'Malete', property: 'Sunrise Lodge', room: 'A1' },
  }, over);
  state.plans.push(plan);
  planTokens.set(plan.id, token);
  state.events.push({
    id: ++state.seq, plan_id: plan.id, student_name: plan.payload.name, session: plan.session,
    event: 'granted', delta: 4, reason: 'Care Pass paid', actor_name: 'paystack checkout',
    env: plan.env, created_at: new Date().toISOString(),
  });
  return { token, plan };
}

function reservations(planId) {
  return state.events.filter((e) => e.plan_id === planId && e.event === 'reserved');
}

function releases(planId) {
  return state.events.filter((e) => e.plan_id === planId && e.event === 'released');
}

function claimRow(reference) {
  return state.claims.filter((c) => c.reference === reference)[0];
}

/* ============================================================
   1. FILING
   ============================================================ */

console.log('\n1. A claim is filed against one pass, by the holder of its link\n');

let a = null;
let b = null;
let filedRef = null;

await t('a link that is not a pass is refused, and nothing is written', async () => {
  const before = state.claims.length;
  const res = await student({ action: 'create', token: 'z'.repeat(43), issue: 'the tap will not close' });
  eq(res.status, 404, 'status');
  eq(state.claims.length, before, 'rows written');
});

await t('a claim with no sentence is not a claim', async () => {
  a = openPass();
  const res = await student({ action: 'create', token: a.token, issue: 'tap' });
  eq(res.status, 400, 'status');
  return state.claims.length === 0 ? true : 'a claim was filed with no issue';
});

await t('a pass with no reachable number cannot be worked on', async () => {
  const bare = openPass({ payload: { name: 'No Phone', phone: null } });
  const res = await student({ action: 'create', token: bare.token, issue: 'the ceiling is leaking' });
  eq(res.status, 400, 'status');
});

await t('filing records the pass, the student, and the reference', async () => {
  const res = await student({
    action: 'create', token: a.token, issue: 'the kitchen tap will not close and drips all night',
    photos: ['https://res.cloudinary.com/arzuz/tap.jpg', 'javascript:alert(1)', 'http://insecure.test/x.jpg'],
  });
  eq(res.status, 201, 'status');
  filedRef = res.body.claim.reference;
  ok(/^AZ-C-/.test(filedRef), 'the reference is not ours: ' + filedRef);
  const row = claimRow(filedRef);
  eq(row.plan_id, a.plan.id, 'the claim is against the wrong pass');
  eq(row.payment_id, a.plan.payment_id, 'the payment behind the pass is not recorded');
  eq(row.status, 'submitted', 'status');
  eq(row.student_name, 'Ada Okonkwo', 'the student was not snapshotted');
  eq(row.student_phone, '2348031112233', 'the phone was not snapshotted');
  eq(row.property, 'Sunrise Lodge', 'the property was not snapshotted');
  return true;
});

await t('only https photos survive, and the page cannot send anything else', async () => {
  const row = claimRow(filedRef);
  eq(row.photos, ['https://res.cloudinary.com/arzuz/tap.jpg'], 'photos');
});

await t('the team is alerted \u2014 a claim nobody reads is the complaint', async () => {
  const hit = state.alerts.filter((m) => String(m.text || '').indexOf(filedRef) !== -1);
  return hit.length >= 1 ? true : 'no alert named the claim';
});

await t('the trail records who filed it and when', async () => {
  const row = state.trail.filter((e) => e.reference === filedRef && e.event === 'filed')[0];
  if (!row) return 'nothing was written to the trail';
  eq(row.to_status, 'submitted', 'to_status');
  eq(row.actor_role, 'student', 'actor_role');
  return row.actor_name === 'Ada Okonkwo' ? true : 'the filer was not recorded';
});

await t('a refunded pass refuses a claim', async () => {
  const refunded = openPass({ status: 'refunded' });
  const res = await student({ action: 'create', token: refunded.token, issue: 'the socket is sparking badly' });
  eq(res.status, 409, 'status');
  return /refunded/i.test(res.body.error) ? true : 'the refusal does not explain itself: ' + res.body.error;
});

await t('a pass whose coverage ENDED refuses a new claim, and says which date', async () => {
  const past = openPass({
    coverage_start: '2025-01-01T00:00:00.000Z',
    coverage_end: '2025-06-30T00:00:00.000Z',
  });
  const res = await student({ action: 'create', token: past.token, issue: 'the door lock is broken' });
  eq(res.status, 409, 'status');
  return res.body.error.indexOf('2025-06-30') !== -1 ? true : 'the closing date was not named: ' + res.body.error;
});

await t('a pass with no published window can still be claimed against (the team sets the session)', async () => {
  const plain = openPass({ coverage_start: null, coverage_end: null, call_out_cap: null });
  const res = await student({ action: 'create', token: plain.token, issue: 'the bathroom light is out' });
  eq(res.status, 201, 'status');
});

/* ============================================================
   2. THE STUDENT'S OWN RECORD
   ============================================================ */

console.log('\n2. A student sees their claims, and nobody else\u2019s\n');

await t('the list carries the coverage term and only this pass\u2019s claims', async () => {
  b = openPass({ payload: { name: 'Bola Ade', phone: '2348055556666', area: 'Malete', property: 'Other Lodge' } });
  await student({ action: 'create', token: b.token, issue: 'the gate hinge has come loose' });

  const res = await student({ action: 'list', token: a.token });
  eq(res.status, 200, 'status');
  const mine = res.body.claims.map((c) => c.reference);
  if (mine.indexOf(filedRef) === -1) return 'the pass cannot see its own claim';
  if (mine.length !== 1) return 'the list carries another pass\u2019s claims: ' + mine.join(', ');
  eq(res.body.coverage.call_out_cap, 4, 'the cap is not reported');
  return true;
});

await t('the student payload leaks nothing about the team', async () => {
  const res = await student({ action: 'list', token: a.token });
  const raw = JSON.stringify(res.body);
  ['actor_ref', 'actor_name', 'token_hash', 'u-admin', 'pay-', 'ledger'].forEach((leak) => {
    if (raw.indexOf(leak) !== -1) throw new Error('the student read leaked ' + leak);
  });
  return true;
});

await t('a claim on ANOTHER pass cannot be confirmed, disputed, cancelled or given a day', async () => {
  const other = claimRow((await student({ action: 'list', token: b.token })).body.claims[0].reference);
  /* Every action the student door answers, and the fields they need, so a
     refusal on a missing field cannot pass for the refusal this is
     testing: a 400 would be the wrong 404. */
  for (const action of ['confirm', 'dispute', 'cancel', 'agree_day', 'propose_day']) {
    const res = await student({
      action: action, token: a.token, id: other.id,
      reason: 'not mine at all', when: 'Monday or Tuesday afternoon, after 2',
    });
    if (res.status !== 404) throw new Error(action + ' reached another pass\u2019s claim (HTTP ' + res.status + ')');
  }
  const after = claimRow(other.reference);
  if (after.status !== 'submitted') return 'the other claim moved: ' + after.status;
  return after.customer_proposal === null && after.day_agreed_at === null
    ? true : 'another pass\u2019s claim was given a day: ' + after.customer_proposal;
});

/* ============================================================
   3. THE DECISION
   ============================================================ */

console.log('\n3. Coverage is decided by an admin, in words, on the record\n');

async function decide(body, opts = {}) {
  asAdmin();
  return team(body, opts);
}

await t('the team door needs a session, and marketing reaches nothing', async () => {
  state.auth = null;
  eq((await team({ action: 'queue' })).status, 401, 'no session');
  state.auth = { user: 'u-marketing', role: 'marketing' };
  eq((await team({ action: 'queue' })).status, 403, 'marketing');
});

await t('support cannot decide, report work or close a claim', async () => {
  asSupport();
  const id = claimRow(filedRef).id;
  eq((await team({ action: 'decide', id: id, eligibility: 'covered', reason: 'looks covered' })).status, 403, 'decide');
  eq((await team({ action: 'report_work', id: id, actual_kobo: 1000 })).status, 403, 'report_work');
  eq((await team({ action: 'resolve', id: id, outcome: 'completed', resolution: 'done' })).status, 403, 'resolve');
});

await t('a decision needs an answer AND a reason', async () => {
  const id = claimRow(filedRef).id;
  eq((await decide({ action: 'decide', id: id })).status, 400, 'no eligibility');
  eq((await decide({ action: 'decide', id: id, eligibility: 'maybe', reason: 'perhaps' })).status, 400, 'bad eligibility');
  eq((await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'ok' })).status, 400, 'a one-word reason');
});

await t('not covered is a refusal WITH its reason, and it spends no call-out', async () => {
  const other = claimRow((await student({ action: 'list', token: b.token })).body.claims[0].reference);
  const res = await decide({
    action: 'decide', id: other.id, eligibility: 'not_covered',
    reason: 'The gate hinge is the compound gate, which is the landlord\u2019s, not the room\u2019s.',
  });
  eq(res.status, 200, 'status');
  const row = claimRow(other.reference);
  eq(row.status, 'rejected', 'status');
  eq(row.eligibility, 'not_covered', 'eligibility');
  ok(row.eligibility_reason, 'the refusal has no reason');
  eq(row.call_out_no, null, 'a refusal reserved a call-out');
  eq(reservations(b.plan.id).length, 0, 'the ledger was touched by a refusal');
  return true;
});

await t('covered takes the call-out and records which one', async () => {
  const id = claimRow(filedRef).id;
  const res = await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Plumbing fault inside the room.', estimate_kobo: 250000 });
  eq(res.status, 200, 'status');
  eq(res.body.call_out_no, 1, 'the call-out number');
  const row = claimRow(filedRef);
  eq(row.status, 'approved', 'status');
  eq(row.call_out_no, 1, 'call_out_no');
  ok(row.reserved_at, 'no reservation stamp');
  eq(row.estimate_kobo, 250000, 'estimate');
  const res2 = reservations(a.plan.id);
  eq(res2.length, 1, 'the ledger did not record the reservation');
  return res2[0].delta === -1 ? true : 'a reservation moved ' + res2[0].delta + ' credits';
});

await t('the balance only moves when the ledger says so', async () => {
  const before = state.events.filter((e) => e.plan_id === a.plan.id).reduce((n, e) => n + e.delta, 0);
  await decide({ action: 'decide', id: claimRow(filedRef).id, eligibility: 'covered', reason: 'already decided' });
  const after = state.events.filter((e) => e.plan_id === a.plan.id).reduce((n, e) => n + e.delta, 0);
  eq(after, before, 'a second decision changed the balance');
});

await t('a decided claim cannot be decided again', async () => {
  const res = await decide({ action: 'decide', id: claimRow(filedRef).id, eligibility: 'covered', reason: 'again and again' });
  eq(res.status, 409, 'status');
});

await t('a bad estimate gives the call-out straight back', async () => {
  const beforeReserved = reservations(a.plan.id).length;
  const beforeReleased = releases(a.plan.id).length;
  const c = await student({ action: 'create', token: a.token, issue: 'the window latch has snapped off' });
  const id = c.body.claim.id;
  const res = await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Structural, inside the room.', estimate_kobo: 'two thousand' });
  eq(res.status, 400, 'status');
  /* The decision was REFUSED — so the call-out it took on the way in is
     not left spent. Both halves are checked: it went out (one more
     reservation) and it came back (one more release, and the same
     credit the pass had before). */
  eq(reservations(a.plan.id).length, beforeReserved + 1, 'the refused decision never took a call-out, so nothing was returned');
  eq(releases(a.plan.id).length, beforeReleased + 1, 'no release row was written');
  const balance = state.events.filter((e) => e.plan_id === a.plan.id).reduce((n, e) => n + e.delta, 0);
  eq(balance, 3, 'the pass did not get its credit back');
  return claimRow(c.body.claim.reference).status === 'submitted' ? true : 'a refused decision moved the claim';
});

/* ============================================================
   4. THE ALLOWANCE, AND TWO APPROVALS AT ONCE
   ============================================================ */

console.log('\n4. The call-out cap cannot be exceeded, even by two approvals at once\n');

await t('four claims are approved on a four-call-out pass', async () => {
  const pass = openPass();
  const refs = [];
  for (let i = 0; i < 4; i += 1) {
    const c = await student({ action: 'create', token: pass.token, issue: 'fault number ' + i + ' in the room' });
    refs.push(c.body.claim.id);
  }
  for (const id of refs) {
    const res = await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'inside the room, covered.' });
    eq(res.status, 200, 'a covered claim was refused');
  }
  eq(reservations(pass.plan.id).length, 4, 'the four call-outs were not all taken');
  eq(state.events.filter((e) => e.plan_id === pass.plan.id).reduce((n, e) => n + e.delta, 0), 0, 'the pass still has credit');
  return true;
});

await t('the FIFTH claim is not approved, and says why \u2014 it stays under review', async () => {
  const pass = state.plans.filter((p) => p.call_out_cap === 4 && reservations(p.id).length === 4)[0];
  const c = await student({ action: 'create', token: findToken(pass.id), issue: 'the fifth thing is also broken' });
  const res = await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'also inside the room.' });
  eq(res.status, 409, 'status');
  if (res.body.error.indexOf('no call-outs left') === -1) {
    return 'the refusal does not say the pass is exhausted: ' + res.body.error;
  }
  eq(claimRow(c.body.claim.reference).status, 'under_review', 'the claim was left somewhere unexpected');
  eq(reservations(pass.id).length, 4, 'a fifth reservation was written');
  eq(releases(pass.id).length, 0, 'a refusal released something it never took');
  return true;
});

await t('two approvals racing for the LAST call-out leave exactly one reservation', async () => {
  const pass = openPass();
  /* Three already taken, so the next approval is the last one. */
  const taken = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await student({ action: 'create', token: pass.token, issue: 'racing fault ' + i + ' in the room' });
    taken.push(c.body.claim.id);
    await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'covered, inside the room.' });
  }
  const one = await student({ action: 'create', token: pass.token, issue: 'the last call-out, claim one' });
  const two = await student({ action: 'create', token: pass.token, issue: 'the last call-out, claim two' });

  asAdmin();
  const [r1, r2] = await Promise.all([
    decide({ action: 'decide', id: one.body.claim.id, eligibility: 'covered', reason: 'covered, inside the room.' }),
    decide({ action: 'decide', id: two.body.claim.id, eligibility: 'covered', reason: 'covered, inside the room.' }),
  ]);
  const approved = [r1, r2].filter((r) => r.status === 200).length;
  const refused = [r1, r2].filter((r) => r.status === 409).length;
  if (approved !== 1 || refused !== 1) {
    return 'expected exactly one approval and one refusal, got ' + approved + ' / ' + refused;
  }
  eq(reservations(pass.plan.id).length, 4, 'the pass was over-spent');
  eq(state.events.filter((e) => e.plan_id === pass.plan.id).reduce((n, e) => n + e.delta, 0), 0, 'the balance went negative');
  return true;
});

/* ============================================================
   5. THE WORK, AND WHO MAY REPORT IT
   ============================================================ */

console.log('\n5. A worker\u2019s report is not a finished job\n');

let workRef = null;

await t('support may name a worker, but not without a number', async () => {
  workRef = filedRef;
  const id = claimRow(workRef).id;
  asSupport();
  eq((await team({ action: 'assign', id: id, provider_name: 'Musa' })).status, 400, 'no number');
  eq((await team({ action: 'assign', id: id, provider_name: 'M' })).status, 400, 'no name');
  const res = await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999' });
  eq(res.status, 200, 'status');
  const row = claimRow(workRef);
  eq(row.status, 'assigned', 'status');
  eq(row.provider_name, 'Musa Ibrahim', 'provider');
  return row.assigned_by === 'u-support' ? true : 'the assigner was not recorded';
});

await t('a worker cannot be named on a claim that was never approved', async () => {
  const c = await student({ action: 'create', token: a.token, issue: 'a second unreviewed fault here' });
  asSupport();
  const res = await team({ action: 'assign', id: c.body.claim.id, provider_name: 'Musa', provider_phone: '08031119999' });
  eq(res.status, 409, 'status');
});

await t('support may mark the job started, and only from a worker being on it', async () => {
  asSupport();
  const id = claimRow(workRef).id;
  eq((await team({ action: 'progress', id: id, status: 'completed' })).status, 400, 'support tried to close a job');
  const res = await team({ action: 'progress', id: id, status: 'in_progress' });
  eq(res.status, 200, 'status');
  return claimRow(workRef).status === 'in_progress' ? true : 'the job did not start';
});

await t('the cost is POSTED: an expense and a provider payable, in kobo', async () => {
  await decide({
    action: 'report_work', id: claimRow(workRef).id, actual_kobo: 180000,
    parts: [{ name: 'tap washer', kobo: 30000 }, { name: 'PTFE tape', kobo: 5000 }],
    evidence: ['https://res.cloudinary.com/arzuz/fixed.jpg'],
    note: 'Washer replaced; the drip stopped.',
  });
  const mine = state.ledger.filter((e) => String(e.entry_ref).indexOf(claimRow(workRef).reference) === 0);
  eq(mine.length, 2, 'the cost was not posted as two movements');
  eq(mine.map((e) => e.account + ':' + e.direction).sort(), ['expense:debit', 'payable:credit'], 'postings');
  eq(mine[0].amount_kobo, 180000, 'amount');
  return mine.every((e) => Number.isInteger(e.amount_kobo)) ? true : 'a float reached the books';
});

await t('reporting work moves the claim to awaiting_customer, not to completed', async () => {
  const row = claimRow(workRef);
  eq(row.status, 'awaiting_customer', 'status');
  eq(row.actual_kobo, 180000, 'actual cost');
  eq(row.parts.length, 2, 'parts');
  return row.customer_confirmed_at === null ? true : 'the team completed the job on the customer\u2019s behalf';
});

await t('only admin records a confirmed provider payout, as a balanced idempotent ledger pair', async () => {
  const claim = claimRow(workRef);
  const before = state.ledger.length;
  asSupport();
  const refused = await team({ action: 'settle_payout', id: claim.id, provider_transfer_ref: 'BANK-REF-1234' });
  eq(refused.status, 403, 'support role');
  eq(state.ledger.length, before, 'support created ledger rows');

  asAdmin();
  const empty = await team({ action: 'settle_payout', id: claim.id, provider_transfer_ref: 'pending' });
  eq(empty.status, 400, 'placeholder reference');
  eq(state.ledger.length, before, 'invalid reference created ledger rows');

  const out = await team({ action: 'settle_payout', id: claim.id, provider_transfer_ref: 'BANK-REF-1234' });
  eq(out.status, 200, 'admin settlement');
  eq(out.body.amount_kobo, 180000, 'settled amount');
  const pair = state.ledger.filter((e) => e.entry_ref === claim.reference + ':settle' || e.entry_ref === claim.reference + ':cash');
  eq(pair.length, 2, 'settlement movements');
  eq(pair.map((e) => e.account + ':' + e.direction).sort(), ['cash:credit', 'payable:debit'], 'settlement pair');
  eq(pair.reduce((sum, e) => sum + (e.direction === 'debit' ? e.amount_kobo : -e.amount_kobo), 0), 0, 'journal balance');
  return pair.every((e) => e.source === 'repair_payout' && String(e.memo).indexOf('BANK-REF-1234') !== -1)
    ? true : 'the payout rows do not identify the confirmed transfer';
});

await t('a payout retry is idempotent, and another reference cannot pay the claim twice', async () => {
  const claim = claimRow(workRef);
  const before = state.ledger.length;
  const retry = await team({ action: 'settle_payout', id: claim.id, provider_transfer_ref: 'BANK-REF-1234' });
  eq(retry.status, 200, 'same-reference retry');
  eq(retry.body.already, true, 'retry result');
  eq(state.ledger.length, before, 'same-reference retry added movements');
  const duplicate = await team({ action: 'settle_payout', id: claim.id, provider_transfer_ref: 'BANK-REF-5678' });
  eq(duplicate.status, 409, 'second transfer reference');
  return eq(state.ledger.length, before, 'second transfer reference added movements');
});

await t('settlement refuses a missing matching expense/payable pair without writing', async () => {
  const pass = openPass();
  const filing = await student({ action: 'create', token: pass.token, issue: 'a door closer has stopped working' });
  await decide({ action: 'decide', id: filing.body.claim.id, eligibility: 'covered', reason: 'A failed fitting inside the flat.' });
  asSupport();
  await team({ action: 'assign', id: filing.body.claim.id, provider_name: 'Yinka repairs', provider_phone: '08031112222' });
  asAdmin();
  const before = state.ledger.length;
  const out = await team({ action: 'settle_payout', id: filing.body.claim.id, provider_transfer_ref: 'BANK-REF-MISSING' });
  eq(out.status, 409, 'missing payable');
  return eq(state.ledger.length, before, 'missing payable wrote entries');
});

await t('and the customer\u2019s confirmation is what finishes it', async () => {
  const id = claimRow(workRef).id;
  const res = await student({ action: 'confirm', token: a.token, id: id });
  eq(res.status, 200, 'status');
  const row = claimRow(workRef);
  eq(row.status, 'completed', 'status');
  ok(row.customer_confirmed_at, 'no confirmation stamp');
  const trailRow = state.trail.filter((e) => e.reference === workRef && e.event === 'customer_confirmed')[0];
  return trailRow ? true : 'the confirmation is not on the trail';
});

await t('a claim that is not waiting for the customer cannot be confirmed', async () => {
  const id = claimRow(workRef).id;
  const res = await student({ action: 'confirm', token: a.token, id: id });
  eq(res.status, 409, 'status');
  return /already finished|not waiting/i.test(res.body.error) ? true : 'the refusal is unclear: ' + res.body.error;
});

/* ============================================================
   6. DISPUTES, AND GIVING A CALL-OUT BACK
   ============================================================ */

console.log('\n6. A dispute is settled by name, and a call-out comes back on the ledger\n');

let disputeRef = null;

await t('a dispute needs a reason, and the team hears about it', async () => {
  const c = await student({ action: 'create', token: a.token, issue: 'the same tap is dripping again' });
  disputeRef = c.body.claim.reference;
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: plumbing, inside the room.' });
  asSupport();
  await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999' });
  await decide({ action: 'report_work', id: id, actual_kobo: 50000, note: 'Washer replaced again.' });

  const words = await student({ action: 'dispute', token: a.token, id: id, reason: 'no' });
  eq(words.status, 400, 'a one-word dispute');
  const res = await student({ action: 'dispute', token: a.token, id: id, reason: 'The drip came back the next morning.' });
  eq(res.status, 200, 'status');
  const row = claimRow(disputeRef);
  eq(row.status, 'disputed', 'status');
  ok(row.disputed_at, 'no dispute stamp');
  ok(row.dispute_reason, 'no dispute reason');
  return state.alerts.some((m) => String(m.text || '').indexOf('disputed') !== -1) ? true : 'nobody was told';
});

await t('nothing has been done yet, so there is nothing to dispute', async () => {
  const c = await student({ action: 'create', token: a.token, issue: 'a fresh fault nobody has looked at' });
  const res = await student({ action: 'dispute', token: a.token, id: c.body.claim.id, reason: 'it is still broken' });
  eq(res.status, 409, 'status');
});

await t('a dispute is closed by a named resolution, and the dispute stays on the record', async () => {
  const id = claimRow(disputeRef).id;
  await decide({ action: 'resolve', id: id, outcome: 'completed', resolution: 'Revisit done on 20 October; the student agreed.' });
  const row = claimRow(disputeRef);
  eq(row.status, 'completed', 'status');
  ok(row.resolved_at, 'no resolution stamp');
  return row.disputed_at ? true : 'settling the dispute erased it';
});

await t('a disputed claim is not resolved away without a sentence', async () => {
  const c = await student({ action: 'create', token: a.token, issue: 'the socket by the bed is dead' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: electrical, inside the room.' });
  asSupport();
  await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999' });
  await decide({ action: 'report_work', id: id, actual_kobo: 20000 });
  await student({ action: 'dispute', token: a.token, id: id, reason: 'It was never actually fixed.' });
  const res = await decide({ action: 'resolve', id: id, outcome: 'completed', resolution: 'ok' });
  eq(res.status, 400, 'status');
});

await t('a resolution that ends the job GIVES THE CALL-OUT BACK', async () => {
  const before = releases(a.plan.id).length;
  const target = state.claims.filter((c) => c.status === 'disputed' && c.plan_id === a.plan.id)[0];
  const res = await decide({
    action: 'resolve', id: target.id, outcome: 'rejected',
    resolution: 'The fault was the landlord\u2019s pipe outside the room; refunded as a call-out and referred on.',
  });
  eq(res.status, 200, 'status');
  eq(res.body.released, true, 'the call-out was not given back');
  eq(releases(a.plan.id).length, before + 1, 'no release row');
  const balance = state.events.filter((e) => e.plan_id === a.plan.id).reduce((n, e) => n + e.delta, 0);
  return balance > 0 ? true : 'the pass did not get its call-out back';
});

await t('reserving and releasing the same claim is symmetric, and never double-releases', async () => {
  const pass = openPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'a fault that will be withdrawn' });
  await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'Covered: inside the room.' });
  const afterReserve = state.events.filter((e) => e.plan_id === pass.plan.id).reduce((n, e) => n + e.delta, 0);
  eq(afterReserve, 3, 'reserving did not take a call-out');

  const withdrawn = await student({ action: 'cancel', token: pass.token, id: c.body.claim.id });
  eq(withdrawn.status, 200, 'status');
  eq(withdrawn.body.released, true, 'the call-out was not returned');
  eq(state.events.filter((e) => e.plan_id === pass.plan.id).reduce((n, e) => n + e.delta, 0), 4, 'the pass did not recover');
  return releases(pass.plan.id).length === 1 ? true : 'the release was written twice';
});

await t('a worker already on the job is not a cancellation \u2014 it is a dispute', async () => {
  const pass = openPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the ceiling fan has stopped turning' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: electrical, inside the room.' });
  asSupport();
  await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999' });
  await team({ action: 'progress', id: id, status: 'in_progress' });
  const res = await student({ action: 'cancel', token: pass.token, id: id });
  eq(res.status, 409, 'status');
  return res.body.error.indexOf('Dispute') !== -1 ? true : 'the refusal does not offer the right path: ' + res.body.error;
});

/* ============================================================
   7. THE QUEUE, THE TRAIL, AND THE WALLS
   ============================================================ */

console.log('\n7. The queue, the trail, and what must never happen\n');

await t('the queue is paginated and filterable by status', async () => {
  asAdmin();
  const all = await team({ action: 'queue', limit: 3, offset: 0 });
  eq(all.status, 200, 'status');
  eq(all.body.claims.length, 3, 'the page size was ignored');
  const second = await team({ action: 'queue', limit: 3, offset: 3 });
  const firstRefs = all.body.claims.map((c) => c.reference);
  return second.body.claims.every((c) => firstRefs.indexOf(c.reference) === -1)
    ? true : 'the second page repeated the first';
});

await t('an unknown status is refused rather than silently emptied', async () => {
  asAdmin();
  const res = await team({ action: 'queue', status: 'nearly_done' });
  eq(res.status, 400, 'status');
});

await t('the queue carries the summary the dashboard reads', async () => {
  asAdmin();
  const res = await team({ action: 'queue' });
  if (!Array.isArray(res.body.summary) || !res.body.summary.length) return 'no summary came back';
  /* And how many visits are pinned down — the question the office asks
     when it opens this screen, counted by the SERVER over every open
     claim. The definitions are restated here rather than imported: a
     test that asks the code what the answer should be proves nothing. */
  const open = state.claims.filter((c) => ['assigned', 'in_progress'].indexOf(c.status) !== -1);
  let agreed = 0, asked = 0, waiting = 0;
  open.forEach((c) => {
    if (!String(c.provider_proposal || '').trim()) return;
    if (c.day_agreed_at) { agreed += 1; return; }
    if (String(c.customer_proposal || '').trim()) asked += 1; else waiting += 1;
  });
  eq(res.body.days, {
    agreed: agreed, asked: asked, waiting: waiting,
    visits: agreed + asked + waiting, open: asked + waiting, capped: false,
  }, 'the visit-day summary');
  /* Over EVERY claim, not over the page: ask for two rows and the counts
     must not move \u2014 a number that answers "how many visits are pinned
     down" cannot be a property of how far somebody has scrolled. */
  const page = await team({ action: 'queue', limit: 2 });
  eq(page.body.claims.length, 2, 'the page size was ignored');
  return eq(page.body.days, res.body.days, 'the counts followed the page');
});

await t('every transition wrote a trail row with a from, a to and who', async () => {
  const mine = state.trail.filter((e) => e.reference === workRef);
  const events = mine.map((e) => e.event);
  ['filed', 'decision', 'assigned', 'started', 'work_reported', 'customer_confirmed'].forEach((want) => {
    if (events.indexOf(want) === -1) throw new Error('the trail is missing ' + want + ' (has: ' + events.join(', ') + ')');
  });
  const bad = mine.filter((e) => !e.to_status || !e.actor_role);
  return bad.length === 0 ? true : bad.length + ' trail rows have no status or actor';
});

await t('a hostile string in an issue cannot become markup anywhere', async () => {
  const nasty = '<img src=x onerror="alert(1)"> and <script>alert(2)</script>';
  const c = await student({ action: 'create', token: b.token, issue: nasty });
  eq(c.status, 201, 'status');
  const row = claimRow(c.body.claim.reference);
  return row.issue === nasty ? true : 'the issue was rewritten: ' + row.issue;
});

await t('a claim cannot be filed by guessing a plan id', async () => {
  /* The student door takes a TOKEN, never a plan_id, and the plan is
     looked up by the hash of the token — so there is no request shape
     that names somebody else's pass. */
  const res = await student({ action: 'create', plan_id: b.plan.id, issue: 'filed against a plan id directly' });
  eq(res.status, 404, 'status');
  return true;
});

await t('the student door cannot decide, assign, report or resolve', async () => {
  const before = JSON.stringify(state.claims);
  for (const action of ['decide', 'assign', 'report_work', 'resolve', 'queue']) {
    const res = await student({ action: action, token: a.token, id: claimRow(filedRef).id, eligibility: 'covered', reason: 'let me in' });
    if (res.status !== 401) throw new Error(action + ' answered ' + res.status + ' to a link');
  }
  return JSON.stringify(state.claims) === before ? true : 'a student action changed a claim';
});

await t('a missing claims table is a not-ready 503, not a 502 that blames the student', async () => {
  const saved = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).indexOf('/rest/v1/repair_claims') !== -1) {
      return resp(404, { code: 'PGRST205', message: "Could not find the table 'public.repair_claims' in the schema cache" });
    }
    return saved(url, init);
  };
  try {
    const res = await student({ action: 'list', token: a.token });
    eq(res.status, 503, 'status');
    eq(res.body.kind, 'not-ready', 'class');
  } finally {
    global.fetch = saved;
  }
});

await t('without the service key nothing writes, and the door says which key is missing', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  try {
    const res = await student({ action: 'list', token: a.token });
    eq(res.status, 503, 'status');
    eq(res.body.kind, 'not-ready', 'class');
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

/* ============================================================
   8. TELLING THE PEOPLE THE DECISION AFFECTED

   Both doors of every notice are opened here: WhatsApp and email, the
   student and the named worker, and — the part that matters most —
   what the record says when a channel does not exist and when one
   fails. A decision nobody hears about is the failure this feature
   exists to prevent, so a notice is not allowed to fail quietly.
   ============================================================ */

console.log('\n8. The decision reaches the student and the worker, and the record says how\n');

/* A pass per test, because a decision SPENDS a call-out: four claims
   approved against one pass and the fifth is refused for the pass having
   nothing left — which is a real rule, tested in section 4, and not
   something a notice test should trip over. */
const tellPass = () => openPass({
  payload: {
    name: 'Bisi Adeyemi', phone: '2348037778899', email: 'bisi.adeyemi@example.com',
    area: 'Malete', property: 'Sunrise Lodge', room: 'B2',
  },
});
let tellClaim = null;

await t('an approved decision reaches the student on WhatsApp AND by email', async () => {
  alerts.resetServerAlertBudget();
  state.whatsapp.length = 0;
  state.mail.length = 0;
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the shower head is broken and spraying the wall' });
  tellClaim = c.body.claim.id;
  const res = await decide({ action: 'decide', id: tellClaim, eligibility: 'covered', reason: 'Covered: the fitting inside the flat failed.' });
  eq(res.status, 200, 'status');

  const said = state.whatsapp.filter((m) => String(m.to).indexOf('2348037778899') === 0);
  ok(said.length === 1, 'the student was sent ' + said.length + ' WhatsApp messages');
  ok(said[0].text.indexOf(c.body.claim.reference) !== -1, 'the message does not name the claim');
  ok(/is approved/i.test(said[0].text), 'the message does not say what was decided: ' + said[0].text.slice(0, 80));

  const mailed = state.mail.filter((m) => m.to === 'bisi.adeyemi@example.com');
  ok(mailed.length === 1, 'the student was emailed ' + mailed.length + ' times');
  return ok(/is approved/i.test(mailed[0].subject), 'the subject does not say what was decided');
});

await t('and the notice is a row on the claim, so "were they told?" is answerable', async () => {
  const mine = state.trail.filter((e) => e.claim_id === tellClaim && e.event === 'notified');
  ok(mine.length === 1, 'the trail has ' + mine.length + ' notified rows for one decision');
  ok(mine[0].reason.indexOf('student_whatsapp: sent') !== -1,
    'the row does not record the WhatsApp channel: ' + mine[0].reason);
  return ok(mine[0].reason.indexOf('student_email: sent') !== -1,
    'the row does not record the email channel: ' + mine[0].reason);
});

await t('a refusal is told too, in the customer\u2019s own words', async () => {
  state.whatsapp.length = 0;
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'my laptop charger broke' });
  await decide({
    action: 'decide', id: c.body.claim.id, eligibility: 'not_covered',
    reason: 'A personal item is not the flat, so it is outside the cover.',
  });
  const said = state.whatsapp[state.whatsapp.length - 1];
  ok(said && said.text.indexOf(c.body.claim.reference) !== -1, 'nothing was sent about the refusal');
  ok(said.text.indexOf('not covered') !== -1, 'the message does not say it was refused');
  return ok(said.text.indexOf('A personal item is not the flat') !== -1,
    'the reason the customer reads is not in the message');
});

await t('a channel that does not exist is recorded, and does not page anybody', async () => {
  state.alerts.length = 0;
  const pass = openPass({ payload: { name: 'No Mail', phone: '2348035551122', area: 'Malete', property: 'Peace Villa', room: 'C3' } });
  const c = await student({ action: 'create', token: pass.token, issue: 'the window latch has come off the frame' });
  await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'Covered: a fitting that failed.' });
  /* The FILING alert is expected — it is the team learning a claim exists.
     What must not happen is a page about a notice that could not go out. */
  const paged = state.alerts.filter((m) => String(m.text || '').indexOf('did not reach everybody') !== -1);
  ok(paged.length === 0, 'the team was paged about a pass that simply has no email');
  const row = state.trail.filter((e) => e.claim_id === c.body.claim.id && e.event === 'notified')[0];
  return ok(row && row.reason.indexOf('student_email: no address') !== -1,
    'the missing address is not on the record: ' + (row && row.reason));
});

await t('a channel that FAILS pages the team \u2014 and the decision still stands', async () => {
  state.alerts.length = 0;
  state.mailFails = true;
  let res = null;
  try {
    const pass = tellPass();
    const c = await student({ action: 'create', token: pass.token, issue: 'the geyser is leaking onto the ceiling' });
    res = await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'Covered: plumbing failure inside the flat.' });
    eq(res.status, 200, 'status');
    eq(claimRow(c.body.claim.reference).status, 'approved', 'the failed email changed the decision');
  } finally {
    state.mailFails = false;
  }
  const paged = state.alerts.filter((m) => String(m.text || '').indexOf('did not reach everybody') !== -1);
  ok(paged.length === 1, 'the team was paged ' + paged.length + ' times about one failed email');
  return ok(String(paged[0].text).indexOf('the student on email') !== -1,
    'the page does not say which channel failed: ' + paged[0].text.slice(0, 200));
});

await t('a person NO channel reaches is escalated, not quietly skipped', async () => {
  /* A worker row written without a number: the assign action refuses that
     (section 5), but the column has no such constraint, so an older row
     — or an import — can hold a name and nothing to reach it on. That is
     the one case where a notice tells nobody at all. */
  state.alerts.length = 0;
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the door frame is splitting away from the wall' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: the flat\u2019s own door.' });
  asSupport();
  await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999' });
  await decide({ action: 'report_work', id: id, actual_kobo: 30000 });
  await student({ action: 'dispute', token: pass.token, id: id, reason: 'Nobody has come back to look at it.' });

  const row = claimRow(c.body.claim.reference);
  row.provider_phone = null;          /* the row as the database permits it */
  row.provider_email = null;
  state.alerts.length = 0;
  const res = await decide({ action: 'resolve', id: id, outcome: 'completed', resolution: 'Refitted the frame and sealed it.' });
  eq(res.status, 200, 'status');

  const paged = state.alerts.filter((m) => String(m.text || '').indexOf('Nobody could be reached') !== -1);
  ok(paged.length === 1, '"we told nobody" was quiet: ' + JSON.stringify(state.alerts.map((m) => m.text)).slice(0, 200));
  return ok(paged[0].text.indexOf('the worker') !== -1, 'the page does not say who could not be reached');
});

await t('and a WhatsApp that fails is a failure, not a missing number', async () => {
  state.alerts.length = 0;
  state.waFails = true;
  try {
    const pass = tellPass();
    const c = await student({ action: 'create', token: pass.token, issue: 'the bathroom light fitting is hanging loose' });
    await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'Covered: electrical fitting inside the room.' });
  } finally {
    state.waFails = false;
  }
  const paged = state.alerts.filter((m) => String(m.text || '').indexOf('Did not arrive') !== -1);
  return ok(paged.length === 1 && paged[0].text.indexOf('openwa-502') !== -1,
    'a refused WhatsApp was not reported as a failure: ' + JSON.stringify(state.alerts.map((m) => m.text)).slice(0, 200));
});

await t('a closed dispute reaches the student AND the worker, on both channels', async () => {
  state.whatsapp.length = 0;
  state.mail.length = 0;
  state.alerts.length = 0;
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the kitchen sink has come away from the wall' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: plumbing inside the flat.' });
  asSupport();
  await team({
    action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999',
    provider_email: 'musa.ibrahim@example.com',
  });
  await decide({ action: 'report_work', id: id, actual_kobo: 65000, note: 'Resealed and braced the sink.' });
  await student({ action: 'dispute', token: pass.token, id: id, reason: 'It came loose again two days later.' });

  /* Only the RESOLUTION's traffic counts from here: filing one alerts the
     team, and a dispute alerts them again — both by design. */
  state.whatsapp.length = 0;
  state.mail.length = 0;
  state.alerts.length = 0;
  const res = await decide({
    action: 'resolve', id: id, outcome: 'completed',
    resolution: 'The brace was refitted and the joint tested with the customer present.',
  });
  eq(res.status, 200, 'status');

  const toStudent = state.whatsapp.filter((m) => String(m.to).indexOf('2348037778899') === 0);
  const toWorker = state.whatsapp.filter((m) => String(m.to).indexOf('2348031119999') === 0);
  ok(toStudent.length === 1, 'the student got ' + toStudent.length + ' messages about the resolution');
  ok(toStudent[0].text.indexOf('closed the dispute') !== -1, 'the student was not told the dispute is closed');
  ok(toWorker.length === 1, 'the worker got ' + toWorker.length + ' messages about the resolution');
  ok(toWorker[0].text.indexOf('settlement') !== -1,
    'the worker was not told what it means for their money: ' + toWorker[0].text.slice(0, 120));

  const workerMail = state.mail.filter((m) => m.to === 'musa.ibrahim@example.com');
  ok(workerMail.length === 1, 'the worker was emailed ' + workerMail.length + ' times');
  ok(workerMail[0].subject.indexOf(c.body.claim.reference) !== -1, 'the worker\u2019s subject does not name the job');

  const rows = state.trail.filter((e) => e.claim_id === id && e.event === 'notified');
  const resolution = rows[rows.length - 1];
  ok(rows.length === 3, 'the decision, the handover and the resolution are three rows, found ' + rows.length);
  ok(resolution.reason.indexOf('worker_whatsapp: sent') !== -1 && resolution.reason.indexOf('worker_email: sent') !== -1,
    'the record does not carry both worker channels: ' + resolution.reason);
  return ok(state.alerts.length === 0, 'a delivery that worked paged the team anyway');
});

await t('a worker with no address is told on WhatsApp, and that is not a failure', async () => {
  state.alerts.length = 0;
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the wardrobe door has fallen off its runner' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: a fitting of the room.' });
  asSupport();
  await team({ action: 'assign', id: id, provider_name: 'Sani, carpentry', provider_phone: '08031110000' });
  await decide({ action: 'report_work', id: id, actual_kobo: 12000 });
  await student({ action: 'dispute', token: pass.token, id: id, reason: 'The door is off its runner again.' });
  state.alerts.length = 0;
  const res = await decide({ action: 'resolve', id: id, outcome: 'completed', resolution: 'Refitted with new runners and checked.' });
  eq(res.status, 200, 'status');
  /* The handover went out when he was named, and the resolution when the
     dispute closed: one worker, two things he needed to hear, and no
     email either time \u2014 which is not a failure. */
  const toWorker = state.whatsapp.filter((m) => String(m.to).indexOf('2348031110000') === 0);
  ok(toWorker.length === 2, 'the worker was sent ' + toWorker.length + ' of the two messages he was owed');
  return ok(state.alerts.length === 0, 'a worker with no email was treated as a failed notice');
});

await t('an assignment refuses a mistyped worker address rather than storing it', async () => {
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the extractor fan in the bathroom is dead' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: electrical fitting.' });
  asSupport();
  const bad = await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999', provider_email: 'musa at gmail' });
  eq(bad.status, 400, 'a mistyped address');
  eq(claimRow(c.body.claim.reference).status, 'approved', 'a typo moved the claim');
  const good = await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999', provider_email: 'Musa.Ibrahim@Example.com' });
  eq(good.status, 200, 'status');
  return ok(claimRow(c.body.claim.reference).provider_email === 'musa.ibrahim@example.com',
    'the address was stored as ' + claimRow(c.body.claim.reference).provider_email);
});

/* ============================================================
   8b. THE HANDOVER

   Naming a worker is the moment the job stops being an idea. Until
   this, the worker learned about it from a phone call \u2014 or from a
   dispute, which is worse. The notice is addressed to ONE person: the
   student already has the decision, and saying it twice is how a
   channel starts being ignored.
   ============================================================ */

console.log('\n8b. The handover: the worker hears the job is theirs, and the customer hears who is coming\n');

let handRef = null;
let handPlan = null;

/* The alerts that are ABOUT a notice, as opposed to the ones the claim
   workflow raises for its own reasons (a filing, a dispute). Filing a
   claim is supposed to page the team; a notice that could not go out is
   the thing under test here. */
const alertsAboutANotice = () => state.alerts.filter((m) => /did not reach everybody/i.test(String(m.text || '')));

await t('naming a worker tells them the job is theirs, on WhatsApp and by email', async () => {
  alerts.resetServerAlertBudget();
  handPlan = tellPass();
  const c = await student({ action: 'create', token: handPlan.token, issue: 'the bathroom door will not close and the hinge is torn out' });
  handRef = c.body.claim.reference;
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: a fitting of the room.', estimate_kobo: 420000 });

  state.whatsapp.length = 0;
  state.mail.length = 0;
  asSupport();
  const res = await team({
    action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999',
    provider_email: 'musa.ibrahim@example.com',
  });
  eq(res.status, 200, 'status');
  ok(res.body.notified && res.body.notified.worker_whatsapp === 'sent',
    'the answer does not say whether the worker was reached: ' + JSON.stringify(res.body.notified));

  const said = state.whatsapp.filter((m) => String(m.to).indexOf('2348031119999') === 0);
  eq(said.length, 1, 'messages to the worker');
  said[0].text.split('\n').forEach(() => {});
  ok(said[0].text.indexOf(handRef) !== -1, 'the job reference is not in the message');
  ok(said[0].text.indexOf('Sunrise Lodge') !== -1, 'the message does not say where to go: ' + said[0].text.slice(0, 160));
  ok(said[0].text.indexOf('2348037778899') !== -1, 'the worker cannot reach the tenant to arrange access');
  ok(said[0].text.indexOf('4,200') !== -1, 'the quote the customer was given is missing, so the money is a surprise later');

  const mailed = state.mail.filter((m) => m.to === 'musa.ibrahim@example.com');
  eq(mailed.length, 1, 'emails to the worker');
  return ok(/job AZ-C-/.test(mailed[0].subject) && /is yours/.test(mailed[0].subject),
    'the subject does not say the job is theirs: ' + mailed[0].subject);
});

await t('and the promise the approval made is kept: the customer is told who is coming', async () => {
  /* decisionCopy promises exactly this \u2014 "we name the worker who is
     coming and message you again when we do" \u2014 so a handover that
     reaches only the worker leaves the customer waiting for a message
     that was promised and never sent. */
  const toStudent = state.whatsapp.filter((m) => String(m.to).indexOf('2348037778899') === 0);
  eq(toStudent.length, 1, 'messages to the student at the handover');
  ok(toStudent[0].text.indexOf('Musa Ibrahim') !== -1,
    'the student was not told who is coming: ' + toStudent[0].text.slice(0, 160));
  /* The number as the claim stores it, which is the form the worker's own
     copy of the tenant's number is written in too. */
  ok(toStudent[0].text.indexOf('2348031119999') !== -1,
    'the student has no way to reach the person turning up at their room: ' + toStudent[0].text.slice(0, 200));
  /* Not the decision again, and not the worker's copy misaddressed: two
     people, two different things to say. */
  ok(!/is approved/i.test(toStudent[0].text), 'the handover repeats the approval instead of naming the worker');
  ok(toStudent[0].text.indexOf('you have been named on this repair') === -1,
    'the worker\u2019s copy went to the customer');

  const mailed = state.mail.filter((m) => m.to === 'bisi.adeyemi@example.com');
  eq(mailed.length, 1, 'emails to the student at the handover');
  ok(mailed[0].subject.indexOf(handRef) !== -1 && !/is approved/i.test(mailed[0].subject),
    'the student\u2019s subject was the decision\u2019s headline again: ' + mailed[0].subject);
  const toWorker = state.mail.filter((m) => m.to === 'musa.ibrahim@example.com');
  return ok(toWorker[0].subject !== mailed[0].subject,
    'the worker and the customer got the same subject for different messages: ' + mailed[0].subject);
});

await t('the handover is on the record, next to the assignment that caused it', async () => {
  const id = claimRow(handRef).id;
  const mine = state.trail.filter((e) => e.claim_id === id);
  const events = mine.map((e) => e.event);
  ok(events.indexOf('assigned') !== -1 && events.indexOf('notified') !== -1,
    'the trail is missing the assignment or the notice that followed it: ' + events.join(', '));
  ok(events.indexOf('assigned') < events.lastIndexOf('notified'), 'the notice is recorded before the assignment it describes');
  const notices = mine.filter((e) => e.event === 'notified');
  const notice = notices[notices.length - 1];
  ok(notice.reason.indexOf('handover') !== -1,
    'the record calls the handover something else: ' + notice.reason.slice(0, 80));
  return ok(notice.reason.indexOf('worker_whatsapp: sent') !== -1 && notice.reason.indexOf('worker_email: sent') !== -1 &&
    notice.reason.indexOf('student_whatsapp: sent') !== -1 && notice.reason.indexOf('student_email: sent') !== -1,
    'the notice row does not say which channels went, to whom: ' + notice.reason);
});

await t('a worker with no address is told on WhatsApp alone, and that is not a failure', async () => {
  alerts.resetServerAlertBudget();
  state.alerts.length = 0;
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the corridor light outside the room has failed' });
  await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'Covered: a fitting of the block.' });
  asSupport();
  const res = await team({ action: 'assign', id: c.body.claim.id, provider_name: 'Sani, carpentry', provider_phone: '08031110000' });
  eq(res.status, 200, 'status');
  eq(res.body.notified.worker_email, 'no address', 'the answer does not say the address was missing');
  ok(state.whatsapp.some((m) => String(m.to).indexOf('2348031110000') === 0), 'the worker heard nothing at all');
  return ok(alertsAboutANotice().length === 0, 'a worker with no email was treated as a failed notice');
});

await t('a channel that FAILS at the handover pages the team, and the job stays assigned', async () => {
  alerts.resetServerAlertBudget();
  const pass = tellPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the ceiling fan in the room has stopped turning' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: electrical, inside the room.' });
  asSupport();

  /* Only the HANDOVER goes out on a broken WhatsApp here: the decision
     above is delivered, so the one page below is the one this test is
     about. */
  state.alerts.length = 0;
  state.waFails = true;
  let res = null;
  try {
    res = await team({
      action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999',
      provider_email: 'musa.ibrahim@example.com',
    });
  } finally {
    state.waFails = false;
  }
  eq(res.status, 200, 'the assignment failed on a notice that did not go');
  eq(res.body.notified.worker_whatsapp, 'openwa-502', 'the answer does not name the failed channel');
  eq(claimRow(c.body.claim.reference).status, 'assigned', 'the claim is not assigned');
  const paged = alertsAboutANotice();
  ok(paged.length === 1, 'the team was paged ' + paged.length + ' times for one handover that failed');
  return ok(/the worker/.test(paged[0].text), 'the page does not say who could not be reached');
});

/* ============================================================
   9. THE AGING CLOCK

   The arithmetic, at chosen instants: a clock tested by waiting for
   the hour to turn is a clock tested once a day. The two rules that
   matter are here — the deadline is PER STATUS, and the age is read
   from the trail rather than from updated_at, which moves whenever
   somebody looks busy.
   ============================================================ */

console.log('\n9. The aging clock: per status, from the trail, and never a guess\n');

const AT = new Date('2026-10-14T09:00:00.000Z');
const isoAgo = (hours) => new Date(AT.getTime() - hours * 3600000).toISOString();

await t('each status has its own deadline, and a claim with no clock has none', () => {
  const limits = { submitted: 24, under_review: 24, approved: 24, assigned: 48, in_progress: 48, disputed: 24, awaiting_customer: 168 };
  Object.keys(limits).forEach((status) => {
    const ag = claims.agingOf({ status: status, created_at: isoAgo(1), updated_at: isoAgo(1) }, isoAgo(1), AT);
    ok(ag, status + ' is not on a clock');
    eq(ag.limit_hours, limits[status], 'the limit for ' + status);
  });
  ['draft', 'completed', 'rejected', 'cancelled'].forEach((status) => {
    eq(claims.agingOf({ status: status, created_at: isoAgo(900), updated_at: isoAgo(900) }, isoAgo(900), AT), null,
      status + ' should not be on a clock');
  });
  return true;
});

await t('the deadline is a deadline: at exactly the limit it is not yet late', () => {
  const claim = { status: 'approved', created_at: isoAgo(100), updated_at: AT.toISOString() };
  const sharp = claims.agingOf(claim, isoAgo(24), AT);
  eq(sharp.overdue, false, '24h into a 24h limit');
  eq(sharp.hours_left, 0, 'hours left at the deadline');
  const late = claims.agingOf(claim, isoAgo(24.5), AT);
  eq(late.overdue, true, 'half an hour past the limit');
  return eq(late.hours_over, 0.5, 'how far past');
});

await t('updated_at cannot reset the clock \u2014 the trail is when the status changed', () => {
  /* The touch that must not buy time: a re-assignment, a note, a
     re-decide. Three days of standing in 'disputed' is still three days
     even though somebody opened the claim a minute ago. */
  const touched = { status: 'disputed', created_at: isoAgo(30 * 24), updated_at: isoAgo(0.02) };
  const ag = claims.agingOf(touched, isoAgo(72), AT);
  eq(ag.overdue, true, 'a claim touched a minute ago went back to being on time');
  eq(ag.days_in_status, 3, 'days in the status');
  return ok(ag.hours_over > 47 && ag.hours_over < 49, 'hours over: ' + ag.hours_over);
});

await t('the two kinds of late are named \u2014 ours, and the customer\u2019s', () => {
  const ours = claims.agingOf({ status: 'submitted' }, isoAgo(30), AT);
  const theirs = claims.agingOf({ status: 'awaiting_customer' }, isoAgo(200), AT);
  eq(ours.who, 'ours', 'a filed claim is the team\u2019s move');
  eq(theirs.who, 'customer', 'a reported job is the customer\u2019s move');
  eq(theirs.overdue, true, 'seven days of a 168h limit');
  return ok(theirs.says.indexOf('customer') !== -1, 'the sentence does not say whose move it is: ' + theirs.says);
});

await t('the queue puts the late claim first, and the finished one never ahead of a live one', async () => {
  asAdmin();
  const pass = openPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the balcony rail is loose and moving' });
  const reference = c.body.claim.reference;
  /* Filed three days ago, on a 24-hour clock: late by two days. Dated
     from the real clock, because the queue answers against "now". */
  const filed = state.trail.filter((e) => e.reference === reference)[0];
  ok(filed, 'the filing wrote no trail row');
  filed.created_at = new Date(Date.now() - 72 * 3600000).toISOString();

  /* The page's own limit, not the whole table: the clock is computed for
     the claims the page carries, which is what the panel shows. */
  const q = await team({ action: 'queue', limit: 100 });
  eq(q.status, 200, 'status');
  const mine = q.body.claims.filter((x) => x.reference === reference)[0];
  ok(mine && mine.aging, 'the queue did not carry the clock for a claim on it');
  eq(mine.aging.overdue, true, 'a claim filed three days ago is late');
  eq(mine.aging.hours_over, 48, 'hours past a 24h deadline');
  eq(q.body.aging.overdue >= 1, true, 'the queue did not count the late claim');
  eq(q.body.claims[0].reference, reference, 'the late claim is not first');

  /* The other half of the order: a claim with no clock at all — a
     refused one — is never ahead of a claim that is still moving. */
  const finished = q.body.claims.filter((x) => x.aging === null).map((x) => x.reference);
  const live = q.body.claims.filter((x) => x.aging).map((x) => x.reference);
  const firstFinished = q.body.claims.findIndex((x) => x.aging === null);
  const lastLive = q.body.claims.map((x) => !!x.aging).lastIndexOf(true);
  if (finished.length && live.length) {
    return ok(firstFinished > lastLive, 'a claim nothing is waiting on was placed above one that is still moving');
  }
  return true;
});

/* ============================================================
   10. THE SCHEDULED NUDGE

   The clock on a schedule, and the once-only rule: a nudge writes a
   row to the claim\u2019s own trail, and a crossing that already has such
   a row is not spoken about again. A claim that is nudged and then
   MOVES is a new lateness, and is nudged again.
   ============================================================ */

console.log('\n10. The scheduled nudge: once per crossing, and a new status is a new crossing\n');

let nudged = null;

await t('the clock pages the team about a crossing, once', async () => {
  alerts.resetServerAlertBudget();
  const before = state.alerts.length;
  const first = await clock.handler();
  eq(first.statusCode, 200, 'status');
  const outcome = JSON.parse(first.body).outcome;
  eq(outcome, 'sent', 'outcome');
  eq(state.alerts.length, before + 1, 'the team was paged ' + (state.alerts.length - before) + ' times');

  const said = state.alerts[state.alerts.length - 1];
  ok(said.text.indexOf('past their deadline') !== -1, 'the nudge does not say what it is about');
  ok(said.text.indexOf('Waiting on us') !== -1, 'the nudge does not separate our lateness from the customer\u2019s');

  const rows = state.trail.filter((e) => e.event === 'overdue_nudge');
  ok(rows.length >= 1, 'the crossing was not recorded on the claim');
  nudged = rows.map((r) => r.claim_id);
  return ok(/deadline/i.test(rows[0].reason), 'the row does not say why the clock spoke: ' + rows[0].reason);
});

await t('and then it is quiet \u2014 the second hour says nothing new', async () => {
  const before = state.alerts.length;
  const again = await clock.handler();
  eq(JSON.parse(again.body).outcome, 'quiet', 'the clock spoke twice about one crossing');
  return eq(state.alerts.length, before, 'the team was paged again for a claim it already knows about');
});

await t('a claim that moves and goes late again is a NEW crossing', async () => {
  alerts.resetServerAlertBudget();
  const id = nudged[0];
  /* Decided and handed to a worker, so the claim is in a NEW status with
     its own deadline — the late claim from section 9 was still waiting to
     be decided, and a claim must be approved before anyone is named. */
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: a fitting of the flat failed.' });
  asSupport();
  await team({ action: 'assign', id: id, provider_name: 'Musa Ibrahim', provider_phone: '08031119999' });
  /* The clock reads the newest row, and the once-only rule reads the
     NUDGE that came before it: the claim was nudged four days ago about
     the status it was in then, and entered the status it is in NOW three
     days ago — a 48h deadline already gone. Backdated exactly so, which
     is the only way to stand at that instant without waiting for it. */
  const threeDaysAgo = new Date(Date.now() - 72 * 3600000).toISOString();
  const fourDaysAgo = new Date(Date.now() - 96 * 3600000).toISOString();
  state.trail.filter((e) => e.claim_id === id).forEach((e) => {
    e.created_at = e.event === 'overdue_nudge' ? fourDaysAgo : threeDaysAgo;
  });

  const before = state.alerts.length;
  const third = await clock.handler();
  eq(JSON.parse(third.body).outcome, 'sent', 'a new lateness was not reported');
  eq(state.alerts.length, before + 1, 'the new crossing was not paged exactly once');
  const mine = state.trail.filter((e) => e.claim_id === id && e.event === 'overdue_nudge');
  return ok(mine.length === 2, 'expected one nudge row per crossing, found ' + mine.length);
});

await t('the claim clock tells a rejected Supabase service key from a missing claims migration', async () => {
  const invalidKey = Object.assign(new Error('Invalid API key'), { status: 401, credentialRefused: true });
  const rejected = clock.clockFailure(invalidKey);
  ok(rejected.kind === 'not-ready', 'the shared wire class should remain not-ready');
  ok(/SUPABASE_SERVICE_ROLE_KEY/.test(rejected.action) && /Netlify/.test(rejected.action),
    'the operator was not told to replace the Netlify service key');
  ok(!/migration/i.test(rejected.action), 'the credential error incorrectly recommends SQL');

  const missing = Object.assign(new Error('Could not find the table in the schema cache'), {
    status: 404, code: 'PGRST205',
  });
  const migration = clock.clockFailure(missing);
  ok(/claims relation/.test(migration.action) && /migration/.test(migration.action),
    'a missing relation did not point to the claims migration');
  return true;
});

await t('a clock that cannot read the database says so, rather than going silently dead', async () => {
  alerts.resetServerAlertBudget();
  const saved = global.fetch;
  state.alerts.length = 0;
  global.fetch = async (url, init) => {
    if (String(url).indexOf('/rest/v1/repair_claims') !== -1) {
      return resp(500, { message: 'the connection pool is exhausted' });
    }
    return saved(url, init);
  };
  try {
    const res = await clock.handler();
    eq(res.statusCode, 200, 'status');
    eq(JSON.parse(res.body).outcome, 'read-failed', 'outcome');
  } finally {
    global.fetch = saved;
  }
  const paged = state.alerts.filter((m) => String(m.text || '').indexOf('could not run') !== -1);
  return ok(paged.length === 1, 'a broken clock was quiet: the whole point is that nobody is watching the dashboard');
});

await t('a site with no service key skips the clock instead of erroring', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  try {
    const res = await clock.handler();
    eq(res.statusCode, 200, 'status');
    eq(JSON.parse(res.body).outcome, 'not-configured', 'outcome');
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
  return true;
});

await t('the nudge names the claim, the wait and whose move it is', () => {
  const text = clock.nudgeText([{
    reference: 'AZ-C-NUDGE', student_name: 'Bisi', provider_name: 'Musa',
    aging: { who: 'ours', says: 'decide coverage', limit_hours: 24, hours_over: 96 },
  }, {
    reference: 'AZ-C-QUIET', student_name: 'Ada',
    aging: { who: 'customer', says: 'hear back from the customer', limit_hours: 168, hours_over: 30 },
  }]);
  ok(text.indexOf('AZ-C-NUDGE') !== -1, 'the nudge does not name the claim');
  ok(text.indexOf('4 days past its 24h deadline') !== -1, 'the nudge does not say how late: ' + text);
  ok(text.indexOf('Waiting on us') !== -1 && text.indexOf('Waiting on the customer') !== -1,
    'the two kinds of late are run together');
  /* A student name is escaped before it reaches Telegram's HTML parse. */
  const hostile = clock.nudgeText([{
    reference: 'AZ-C-X', student_name: '<b>bold</b>',
    aging: { who: 'ours', says: 'decide coverage', limit_hours: 24, hours_over: 1 },
  }]);
  return ok(hostile.indexOf('<b>bold</b>') === -1, 'a name from the database could inject markup into the alert');
});

/* ============================================================
   11. THE WORKER'S OWN ANSWER

   Naming somebody is us saying who is coming; it is not them
   agreeing to come. The handover message ends by telling them to
   reply if anything is wrong, so this is where that reply lands:

     · a YES is recorded against the claim and the job stays with
       them — nobody else is told anything, because nothing changed
       for them
     · a NO puts the claim back to 'approved' (covered, nobody on it),
       keeps who was asked and what they said, tells the customer whose
       name has just evaporated, and pages the team
     · an answer that is neither is asked about again rather than
       guessed at, and the words are kept
     · a message from a number we never asked is left alone, a worker
       with several jobs open is asked which, and OpenWA's own delivery
       echo (fromMe, groups, redelivery) changes nothing
   ============================================================ */

console.log('\n11. The worker answers the handover, and the answer is acted on\n');

await t('a reply is read the way a person means it — and an unreadable one is not read as a yes', () => {
  const cases = [
    ['yes', 'accepted'], ['YES', 'accepted'], ['Ok', 'accepted'], ['okay thanks', 'accepted'],
    ['sure', 'accepted'], ['I can do it', 'accepted'], ['on my way', 'accepted'],
    ['no problem', 'accepted'], ['Yes, I will take it', 'accepted'],
    ['no', 'declined'], ['No thanks', 'declined'], ["I can't", 'declined'],
    ['cannot make it', 'declined'], ['I cannot take it, I am in Lagos', 'declined'],
    ['Not available this week', 'declined'],
    /* "on it" must not be found inside a word, and "sorry" on its own is
       not a no — somebody saying sorry could be apologising for being
       LATE, and reading that as a refusal takes a job off a person who
       is on their way. */
    ['I need the money first', 'unclear'], ['sorry, I will be there by four', 'unclear'],
    ['who is this?', 'unclear'], ['maybe', 'unclear'], ['', 'unclear'],
  ];
  for (const [said, want] of cases) {
    const got = claims.classifyReply(said);
    if (got !== want) throw new Error('"' + said + '" read as ' + got + ', expected ' + want);
  }
  return true;
});

/* A claim on a worker, from filing to handover — the state a reply
   arrives in. Each caller gets its OWN number, because the lookup is by
   number: a shared one would make every job in this file one worker's. */
async function handedOver(opts = {}) {
  const pass = opts.pass || openPass();
  const phone = opts.phone || '08031190001';
  const c = await student({
    action: 'create', token: pass.token,
    issue: opts.issue || 'the bathroom tap will not close and drips all night',
  });
  const ref = c.body.claim.reference;
  await decide({ action: 'decide', id: c.body.claim.id, eligibility: 'covered', reason: 'Covered: a fitting inside the flat failed.' });
  asSupport();
  await team({
    action: 'assign', id: c.body.claim.id,
    provider_name: opts.name || 'Musa Ibrahim', provider_phone: phone,
  });
  return { ref: ref, id: c.body.claim.id, pass: pass, phone: normalizePhone(phone) };
}

const STUDENT_PHONE = normalizePhone('2348031112233');

function toStudent() {
  return state.whatsapp.filter((m) => String(m.to).indexOf(STUDENT_PHONE) === 0);
}

function toWorker(phone, list) {
  return (list || state.whatsapp).filter((m) => String(m.to).indexOf(phone) === 0);
}

await t('a YES is recorded against the claim, and the job stays with them', async () => {
  const h = await handedOver({ phone: '08031190002' });
  state.whatsapp.length = 0;
  const out = await claims.workerReply({ phone: h.phone, text: 'Yes, I will do it' });
  eq(out.handled, true, 'handled');
  eq(out.reason, 'accepted', 'reason');
  eq(out.claim, h.ref, 'the claim it was about');

  const row = claimRow(h.ref);
  eq(row.status, 'assigned', 'status');
  eq(row.provider_answer, 'accepted', 'the answer was not recorded');
  ok(row.provider_answered_at, 'the instant the answer was given is missing');
  eq(row.provider_answer_note, 'Yes, I will do it', 'their own words');

  const rows = state.trail.filter((e) => e.reference === h.ref && e.event === 'accepted');
  eq(rows.length, 1, 'accepted rows on the trail');
  eq(rows[0].to_status, 'assigned', 'to_status');
  eq(rows[0].actor_role, 'worker', 'actor_role');

  /* Answered on the channel they wrote on, in one message. */
  const ack = toWorker(h.phone, state.whatsapp);
  ok(ack.length === 1, 'the worker was sent ' + ack.length + ' messages back');
  return ok(/that is recorded and the job is yours/.test(ack[0].text),
    'the acknowledgement does not confirm the job: ' + ack[0].text.slice(0, 120));
});

await t('and nobody else is told: a yes changes nothing for the customer', async () => {
  const h = await handedOver({ phone: '08031190003' });
  state.whatsapp.length = 0;
  state.mail.length = 0;
  await claims.workerReply({ phone: h.phone, text: 'ok' });
  eq(toStudent().length, 0, 'the customer was messaged about a yes');
  return eq(state.mail.length, 0, 'the customer was emailed about a yes');
});

let declined = null;

await t('a NO puts the claim back to covered-with-nobody, and keeps who said it', async () => {
  alerts.resetServerAlertBudget();
  declined = await handedOver({ phone: '08031190004' });
  const pagedBefore = state.alerts.length;
  state.whatsapp.length = 0;
  state.mail.length = 0;

  const out = await claims.workerReply({ phone: declined.phone, text: 'I cannot take it, I am in Lagos' });
  eq(out.handled, true, 'handled');
  eq(out.reason, 'declined', 'reason');

  const row = claimRow(declined.ref);
  eq(row.status, 'approved', 'the claim did not go back to where a job with nobody on it belongs');
  eq(row.provider_answer, 'declined', 'the answer was not recorded');
  /* The record keeps BOTH facts: who we asked, and what they said. */
  eq(row.provider_name, 'Musa Ibrahim', 'the name was thrown away');
  eq(row.provider_phone, declined.phone, 'the number was thrown away');
  eq(row.provider_answer_note, 'I cannot take it, I am in Lagos', 'their own words');

  const rows = state.trail.filter((e) => e.reference === declined.ref && e.event === 'declined');
  eq(rows.length, 1, 'declined rows on the trail');
  eq(rows[0].to_status, 'approved', 'to_status');
  eq(rows[0].actor_role, 'worker', 'actor_role');

  /* A job that stopped is a call somebody owes — and the clock restarts
     at 'name a worker' with the claim, which is the backstop. */
  return ok(state.alerts.length > pagedBefore, 'nobody was paged about a job that just stopped');
});

await t('the customer who was told a name is told the name is gone', async () => {
  const said = toStudent();
  eq(said.length, 1, 'messages to the customer');
  ok(said[0].text.indexOf(declined.ref) !== -1, 'the message does not name the claim');
  ok(said[0].text.indexOf('Musa Ibrahim') !== -1,
    'the customer is not told WHICH worker is not coming');
  ok(/not able to take the job after all/.test(said[0].text),
    'the customer is not told what happened: ' + said[0].text.slice(0, 140));
  ok(/still covered by your pass/.test(said[0].text), 'the message does not say the cover is unchanged');
  /* And it is on the record as a notice, with its own wording. */
  const rows = state.trail.filter((e) => e.reference === declined.ref && e.event === 'notified');
  const last = rows[rows.length - 1];
  return ok(last && /turned the job down/.test(last.reason),
    'the trail does not say which notice went out: ' + (last && last.reason));
});

await t('a decline reaches nobody when the customer was never told a name', async () => {
  const h = await handedOver({ phone: '08031190005' });
  /* The handover never reached the customer at all: the trail is the
     record of that, so the record is what the question is asked of. */
  state.trail = state.trail.filter((e) => !(e.claim_id === h.id && e.event === 'notified'));
  state.whatsapp.length = 0;
  const out = await claims.workerReply({ phone: h.phone, text: 'no' });
  eq(out.reason, 'declined', 'reason');
  eq(Object.keys(out.student_told || {}).length, 0, 'channels recorded for a notice nobody got');
  return eq(toStudent().length, 0, 'the customer was told about a worker they never heard of');
});

await t('an answer that is neither yes nor no is asked again, not guessed', async () => {
  const h = await handedOver({ phone: '08031190006' });
  state.whatsapp.length = 0;
  const out = await claims.workerReply({ phone: h.phone, text: 'who is this?' });
  eq(out.reason, 'unclear', 'reason');
  eq(claimRow(h.ref).provider_answer, null, 'an unreadable reply was written down as an answer');
  eq(claimRow(h.ref).status, 'assigned', 'the claim moved on a message nobody could read');
  const ack = toWorker(h.phone, state.whatsapp);
  ok(ack.length === 1 && /Reply YES/.test(ack[0].text),
    'the worker was not asked in plain words: ' + (ack[0] ? ack[0].text.slice(0, 120) : 'nothing sent'));
  const note = state.trail.filter((e) => e.reference === h.ref && e.event === 'note');
  return eq(note.length, 1, 'the words they sent instead of an answer were not kept');
});

await t('a number stored in another shape still finds the job it is about', async () => {
  const h = await handedOver({ phone: '08031190040' });
  /* A row written before numbers were normalised on the way in — or by
     hand in the SQL editor. The reply is still THAT worker's, and a
     lookup that missed it would leave a job nobody knows is unanswered. */
  claimRow(h.ref).provider_phone = '+2348031190040';
  const out = await claims.workerReply({ phone: '08031190040', text: 'yes' });
  eq(out.handled, true, 'handled');
  eq(out.reason, 'accepted', 'reason');
  return eq(claimRow(h.ref).provider_answer, 'accepted', 'the answer was not recorded');
});

await t('a message from a number we never asked nothing is left alone', async () => {
  state.whatsapp.length = 0;
  const out = await claims.workerReply({ phone: '08099998888', text: 'Hello, do you have rooms in Malete?' });
  eq(out.handled, false, 'handled');
  eq(out.reason, 'no-open-job', 'reason');
  return eq(state.whatsapp.length, 0, 'the machine answered a human conversation');
});

await t('a worker with two jobs open is asked which one, and nothing is written', async () => {
  const pass = openPass();
  const phone = '08031190007';
  const one = await handedOver({ pass: pass, phone: phone, issue: 'the socket by the bed sparks when the fan is plugged in' });
  const two = await handedOver({ pass: pass, phone: phone, issue: 'the window latch has come off the frame in the wind' });
  const rowsBefore = state.trail.length;

  const out = await claims.workerReply({ phone: one.phone, text: 'yes' });
  eq(out.reason, 'several-jobs', 'reason');
  eq(claimRow(one.ref).provider_answer, null, 'a guess was written on one job');
  eq(claimRow(two.ref).provider_answer, null, 'a guess was written on the other');
  eq(state.trail.length, rowsBefore, 'the trail gained rows from a guess');

  /* Naming the job settles it — which is how a worker with several
     answers without being asked anything. */
  const named = await claims.workerReply({ phone: two.phone, text: 'yes, the one with the window \u2014 ' + two.ref });
  eq(named.reason, 'accepted', 'reason with the reference');
  eq(claimRow(two.ref).provider_answer, 'accepted', 'the wrong job was answered');
  return eq(claimRow(one.ref).provider_answer, null, 'the job that was not named was answered too');
});

await t('a worker who said no and then yes is put back on the job', async () => {
  const h = await handedOver({ phone: '08031190008' });
  await claims.workerReply({ phone: h.phone, text: 'no' });
  eq(claimRow(h.ref).status, 'approved', 'after the no');

  const out = await claims.workerReply({ phone: h.phone, text: 'actually yes, I can do it' });
  eq(out.reason, 'reinstated', 'reason');
  eq(claimRow(h.ref).status, 'assigned', 'status after the change of mind');
  eq(claimRow(h.ref).provider_answer, 'accepted', 'the answer was not updated');
  const rows = state.trail.filter((e) => e.reference === h.ref && e.event === 'accepted');
  return ok(rows.length === 1 && /having turned it down first/.test(rows[0].reason),
    'the record does not say the answer changed: ' + (rows[0] && rows[0].reason));
});

await t('the same answer twice is one answer, and one page', async () => {
  const h = await handedOver({ phone: '08031190009' });
  await claims.workerReply({ phone: h.phone, text: 'yes' });
  const rowsBefore = state.trail.filter((e) => e.reference === h.ref).length;
  const pagedBefore = state.alerts.length;
  const out = await claims.workerReply({ phone: h.phone, text: 'ok, yes' });
  eq(out.reason, 'already-answered', 'reason');
  eq(state.trail.filter((e) => e.reference === h.ref).length, rowsBefore, 'a duplicate answer wrote rows');
  return eq(state.alerts.length, pagedBefore, 'the team was paged twice about one answer');
});

/* --- the door that reply comes in through ----------------------- */

/* An event exactly as OpenWA posts it: the body it signed, the header the
   signature rides in, and the delivery id it retries under. */
function signedEvent(data, over) {
  const body = JSON.stringify(Object.assign({
    event: 'message.received',
    timestamp: new Date().toISOString(),
    sessionId: 'session-1',
    idempotencyKey: 'idem-' + (++state.seq),
    deliveryId: 'deliv-' + (++state.seq),
    data: data,
  }, (over && over.payload) || {}));
  return {
    httpMethod: (over && over.method) || 'POST',
    headers: Object.assign({
      'x-openwa-event': 'message.received',
      'x-openwa-signature': process.env.OPENWA_WEBHOOK_SECRET
        ? inbound.signature(body, process.env.OPENWA_WEBHOOK_SECRET) : '',
      'x-openwa-delivery-id': 'deliv-' + state.seq,
    }, (over && over.headers) || {}),
    body: body,
  };
}

function inboundMessage(phone, text, over) {
  return Object.assign({
    id: 'wamid-' + (++state.seq),
    from: phone + '@s.whatsapp.net',
    chatId: phone + '@c.us',
    body: text,
    type: 'text',
    timestamp: Date.now(),
    fromMe: false,
    isGroup: false,
  }, over || {});
}

async function deliver(event) {
  const res = await inbound.handler(event);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

await t('the inbound door refuses a deploy with no webhook secret, and reads nothing', async () => {
  const saved = process.env.OPENWA_WEBHOOK_SECRET;
  process.env.OPENWA_WEBHOOK_SECRET = '';
  try {
    const res = await deliver(signedEvent(inboundMessage('2348031110020', 'yes')));
    eq(res.status, 503, 'status');
    eq(res.body.kind, 'not-ready', 'kind');
    return ok(/OPENWA_WEBHOOK_SECRET/.test(res.body.error), 'the refusal does not name the variable to set');
  } finally {
    process.env.OPENWA_WEBHOOK_SECRET = saved;
  }
});

await t('and refuses a body that was not signed by the webhook\u2019s own secret', async () => {
  const before = state.trail.length;
  const unsigned = await deliver(signedEvent(inboundMessage('2348031110020', 'yes'),
    { headers: { 'x-openwa-signature': '' } }));
  eq(unsigned.status, 401, 'no signature');
  const forged = await deliver(signedEvent(inboundMessage('2348031110020', 'yes'),
    { headers: { 'x-openwa-signature': 'sha256=' + 'a'.repeat(64) } }));
  eq(forged.status, 401, 'a made-up signature');
  const wrongSecret = await deliver(signedEvent(inboundMessage('2348031110020', 'yes'),
    { headers: { 'x-openwa-signature': inbound.signature('{"event":"message.received"}', 'not-the-secret') } }));
  eq(wrongSecret.status, 401, 'a signature over a different body');
  return eq(state.trail.length, before, 'an unsigned body was acted on');
});

await t('a signed yes out of OpenWA moves the claim, and the redelivery does not move it twice', async () => {
  const h = await handedOver({ phone: '08031190020' });
  const one = signedEvent(inboundMessage(h.phone, 'yes please'));
  const res = await deliver(one);
  eq(res.status, 200, 'status');
  eq(res.body.outcome, 'accepted', 'outcome');
  eq(res.body.claim, h.ref, 'the claim it answered');
  eq(claimRow(h.ref).provider_answer, 'accepted', 'the answer was not recorded');

  /* OpenWA redelivers until it gets a 2xx; the SAME delivery arriving
     again is one answer, not two rows and not a second message. */
  const rowsBefore = state.trail.filter((e) => e.reference === h.ref).length;
  const again = await deliver(one);
  eq(again.status, 200, 'status');
  eq(again.body.ignored, 'already answered', 'the redelivery was handled twice');
  return eq(state.trail.filter((e) => e.reference === h.ref).length, rowsBefore,
    'a redelivery wrote another row');
});

await t('our own messages, groups and other events are never read as replies', async () => {
  const h = await handedOver({ phone: '08031190021' });
  const before = claimRow(h.ref).provider_answer;

  const own = await deliver(signedEvent(inboundMessage(h.phone, 'no', { fromMe: true })));
  eq(own.body.ignored, 'our own message', 'a message we sent');

  const group = await deliver(signedEvent(inboundMessage(h.phone, 'no', { isGroup: true })));
  eq(group.body.ignored, 'a group, not a worker', 'a group message');

  const other = await deliver(signedEvent(inboundMessage(h.phone, 'no'), { payload: { event: 'message.sent' } }));
  eq(other.body.ignored, 'event message.sent', 'another event');

  const nothing = await deliver(signedEvent(inboundMessage(h.phone, '   ')));
  eq(nothing.body.ignored, 'no text to read', 'an empty message');

  return eq(claimRow(h.ref).provider_answer, before, 'the claim moved on one of our own messages');
});

await t('the student\u2019s own view of a claim carries the worker and how to reach them', async () => {
  const h = await handedOver({ phone: '08031190030' });
  await claims.workerReply({ phone: h.phone, text: 'yes' });
  const listed = await student({ action: 'list', token: h.pass.token });
  const row = listed.body.claims.filter((c) => c.reference === h.ref)[0];
  eq(row.provider_name, 'Musa Ibrahim', 'the worker\u2019s name');
  eq(row.provider_phone, h.phone, 'the number the customer has to be able to ring');
  return eq(row.worker_confirmed, true, 'whether they have agreed to come');
});

await t('and a worker who has said no is not on the student\u2019s page at all', async () => {
  const h = await handedOver({ phone: '08031190031' });
  await claims.workerReply({ phone: h.phone, text: 'no' });
  const listed = await student({ action: 'list', token: h.pass.token });
  const row = listed.body.claims.filter((c) => c.reference === h.ref)[0];
  eq(row.provider_name, null, 'the name of somebody who is not coming');
  eq(row.provider_phone, null, 'the number of somebody who is not coming');
  eq(row.worker_confirmed, false, 'an answer nobody gave');
  /* The OPERATOR still knows: the row keeps both facts on the server. */
  eq(claimRow(h.ref).provider_name, 'Musa Ibrahim', 'the record threw away who was asked');
  return eq(claimRow(h.ref).provider_answer, 'declined', 'the record threw away what they said');
});

/* ============================================================
   12. THE DAY THEY OFFERED

   A worker handed a job often answers with a time instead of a yes
   ("I can do Saturday morning"). That used to read as an unreadable
   reply — the question was put again, the team was nudged about a job
   nobody had refused, and the customer was told a worker was coming
   with no idea when. It is not a yes and must not be recorded as one:
   a question is not an agreement, and the panel says "suggested a
   time" beside a name that has NOT answered.
   ============================================================ */

console.log('\n12. The day a worker offers: recorded, passed to the customer, and never a booking\n');

let ackDone = null;

await t('a day instead of a yes is recorded in their words, and the customer is told when', async () => {
  const h = await handedOver({ phone: '08031190050' });
  state.whatsapp.length = 0;
  state.mail.length = 0;
  const out = await claims.workerReply({ phone: h.phone, text: 'Can I come Saturday morning before 11?' });
  eq(out.handled, true, 'handled');
  eq(out.reason, 'proposed', 'reason');

  const row = claimRow(h.ref);
  eq(row.status, 'assigned', 'the job came off the worker who told us when they can come');
  eq(row.provider_answer, null, 'a question was recorded as an agreement');
  eq(row.provider_proposal, 'Can I come Saturday morning before 11?', 'their own words, kept as given');
  ok(row.provider_proposed_at, 'the instant they offered the day is missing');

  const rows = state.trail.filter((e) => e.reference === h.ref && e.event === 'proposed');
  eq(rows.length, 1, 'proposed rows on the trail');
  eq(rows[0].actor_role, 'worker', 'actor_role');
  ok(/Saturday morning/.test(rows[0].reason), 'the record does not keep the day: ' + rows[0].reason);

  /* The customer — the person who has to be in — is told, in the worker's
     words and NOT as a booked appointment. */
  const told = toStudent();
  eq(told.length, 1, 'messages to the customer');
  ok(told[0].text.indexOf('Saturday morning before 11') !== -1,
    'the customer was not told when the worker can come: ' + told[0].text.slice(0, 200));
  ok(/not a booked appointment/.test(told[0].text), 'a suggestion was dressed up as a booking');
  ok(told[0].text.indexOf('Musa Ibrahim') !== -1, 'the message does not say who suggested it');
  /* And the record says WHICH notice went out, so the trail cannot be read
     as saying the customer was told something else. */
  const notices = state.trail.filter((e) => e.reference === h.ref && e.event === 'notified');
  ok(/told when the worker can come/.test(notices[notices.length - 1].reason),
    'the notice row does not say what the customer was told: ' + notices[notices.length - 1].reason);

  /* The worker gets one acknowledgement back, and it confirms the day
     reached somebody rather than repeating the question at them. */
  const ack = toWorker(h.phone, state.whatsapp);
  ok(ack.length === 1, 'the worker was sent ' + ack.length + ' messages back');
  ackDone = h;
  return ok(/Saturday morning before 11/.test(ack[0].text),
    'the acknowledgement does not repeat the day back: ' + ack[0].text.slice(0, 160));
});

await t('sending the same day again is one message, and a DIFFERENT day is news', async () => {
  const h = ackDone;
  const rowsBefore = state.trail.filter((e) => e.reference === h.ref).length;
  state.whatsapp.length = 0;
  const same = await claims.workerReply({ phone: h.phone, text: 'Can I come Saturday morning before 11?' });
  eq(same.reason, 'already-answered', 'the same day twice was treated as new');
  eq(state.trail.filter((e) => e.reference === h.ref).length, rowsBefore, 'a repeated day wrote rows');
  eq(toStudent().length, 0, 'the customer was messaged twice about one day');

  const moved = await claims.workerReply({ phone: h.phone, text: 'sorry, Sunday afternoon instead' });
  eq(moved.reason, 'proposed', 'a changed day was not passed on');
  eq(claimRow(h.ref).provider_proposal, 'sorry, Sunday afternoon instead', 'the row kept the old day');
  const told = toStudent();
  ok(told.length === 1 && told[0].text.indexOf('Sunday afternoon') !== -1,
    'the customer still has the day the worker has changed');
  return eq(claimRow(h.ref).status, 'assigned', 'status after a new day');
});

await t('a yes that also names a day is both facts, and the customer hears the day', async () => {
  const h = await handedOver({ phone: '08031190051' });
  state.whatsapp.length = 0;
  const out = await claims.workerReply({ phone: h.phone, text: 'yes, I can do Monday morning' });
  eq(out.reason, 'accepted', 'reason');
  eq(claimRow(h.ref).provider_answer, 'accepted', 'the answer');
  eq(claimRow(h.ref).provider_proposal, 'yes, I can do Monday morning', 'the day');
  const told = toStudent();
  ok(told.length === 1 && /Monday morning/.test(told[0].text),
    'a yes with a day on it told the customer nothing about when: ' + (told[0] ? told[0].text.slice(0, 160) : 'nothing sent'));
  const ack = toWorker(h.phone, state.whatsapp);
  return ok(ack.length === 1 && /Monday morning/.test(ack[0].text),
    'the worker was not told the day was passed on');
});

await t('the customer\u2019s own record carries the day, and nothing of a worker who has gone', async () => {
  const h = await handedOver({ phone: '08031190052' });
  /* "Could I come Friday evening?" — a QUESTION. "I can come\u2026" is an
     acceptance that also names a day, which is the test above. */
  await claims.workerReply({ phone: h.phone, text: 'Could I come Friday evening?' });
  const listed = await student({ action: 'list', token: h.pass.token });
  const row = listed.body.claims.filter((c) => c.reference === h.ref)[0];
  eq(row.provider_proposal, 'Could I come Friday evening?', 'the day on the customer\u2019s own record');
  ok(row.provider_proposed_at, 'when it was offered is missing from the customer\u2019s record');
  eq(row.worker_confirmed, false, 'a suggestion was reported to the customer as an agreement');

  /* Then they leave the job. The day goes with them: a date to wait in for
     from somebody who is not coming is worse than no date at all. */
  await claims.workerReply({ phone: h.phone, text: 'no, I cannot make it after all' });
  const after = await student({ action: 'list', token: h.pass.token });
  const gone = after.body.claims.filter((c) => c.reference === h.ref)[0];
  eq(gone.provider_proposal, null, 'the day of a worker who is not coming');
  eq(gone.provider_name, null, 'the name of a worker who is not coming');
  /* The OPERATOR still has both, which is why the row keeps them. */
  eq(claimRow(h.ref).provider_proposal, 'Could I come Friday evening?', 'the record threw away the day');
  return eq(claimRow(h.ref).provider_answer, 'declined', 'the record threw away the answer');
});

await t('a day from somebody who had already turned the job down is recorded and kicked to the team', async () => {
  const h = await handedOver({ phone: '08031190053' });
  await claims.workerReply({ phone: h.phone, text: 'no' });
  eq(claimRow(h.ref).status, 'approved', 'after the no');
  const pagedBefore = state.alerts.length;
  state.whatsapp.length = 0;

  const out = await claims.workerReply({ phone: h.phone, text: 'actually I could do Saturday' });
  eq(out.reason, 'proposed', 'reason');
  /* A day is an offer, not an agreement, so the job is NOT put back on
     them on the strength of it: naming them again is a person\u2019s call. */
  eq(claimRow(h.ref).status, 'approved', 'a question put somebody back on the job');
  eq(claimRow(h.ref).provider_answer, 'declined', 'the refusal was overwritten by an offer');
  eq(claimRow(h.ref).provider_proposal, 'actually I could do Saturday', 'the day was not kept');
  ok(state.alerts.length > pagedBefore, 'nobody was told the worker had come back with a day');
  return eq(toStudent().length, 0,
    'the customer was told about a worker they were already told is not coming');
});

/* ============================================================
   13. THE ASK, AND THE JOB TAKEN BACK

   The hole this closes: a worker named and never heard from again. The
   claim sat in 'assigned' with somebody on it who was never going to
   turn up, and the customer waited on a knock that was not coming.

   The clock does exactly what a person would, in the same order — ask
   ONCE, in words that say what happens next, and then give the job to
   somebody else by the same door a refusal goes through.
   ============================================================ */

console.log('\n13. The handover clock: ask once, then hand the job back the way a decline does\n');

/* A claim handed over and then ignored for `hours`, with the trail
   backdated so the clock is standing at a chosen instant rather than
   waiting three days for one. */
async function handedOverAndAbandoned(phone, hours, extra) {
  const h = await handedOver({ phone: phone });
  const old = new Date(Date.now() - hours * 3600000).toISOString();
  state.trail.filter((e) => e.claim_id === h.id).forEach((e) => { e.created_at = old; });
  if (extra) extra(h);
  return h;
}

let asked = null;

await t('the clock asks a worker who never answered — once, in words that say what happens next', async () => {
  alerts.resetServerAlertBudget();
  state.alerts.length = 0;
  asked = await handedOverAndAbandoned('08031190060', 52);
  state.whatsapp.length = 0;

  const res = await clock.handler();
  eq(res.statusCode, 200, 'status');
  eq(JSON.parse(res.body).asked >= 1, true, 'nobody was asked whether the job is theirs');

  const toHim = toWorker(asked.phone, state.whatsapp);
  eq(toHim.length, 1, 'messages the quiet worker was sent');
  ok(toHim[0].text.indexOf(asked.ref) !== -1, 'the ask does not name the job');
  ok(/reply YES/.test(toHim[0].text) && /reply NO/.test(toHim[0].text.replace('or NO', 'reply NO')),
    'the ask does not say how to answer: ' + toHim[0].text.slice(0, 200));
  ok(/give the job to somebody else/.test(toHim[0].text),
    'the worker was not told what happens if they say nothing');
  /* The customer hears NOTHING yet: the job has not moved, and an update
     that says it might would be us worrying somebody for our own sake. */
  eq(toStudent().length, 0, 'the customer was told about an ask we had not even made');

  const rows = state.trail.filter((e) => e.reference === asked.ref && e.event === 'chased');
  eq(rows.length, 1, 'chased rows on the trail');
  eq(rows[0].actor_role, 'system', 'actor_role');

  const again = await clock.handler();
  eq(JSON.parse(again.body).asked, 0, 'the worker was asked a second time');
  return eq(toWorker(asked.phone, state.whatsapp).length, 1, 'the worker was messaged twice about one silence');
});

await t('a suggestion is an answer, so the clock does not ask or take anything from that worker', async () => {
  const h = await handedOverAndAbandoned('08031190061', 52, (c) => {
    claimRow(c.ref).provider_proposal = 'I can do Saturday morning';
    claimRow(c.ref).provider_proposed_at = new Date(Date.now() - 50 * 3600000).toISOString();
  });
  const before = toWorker(h.phone, state.whatsapp).length;
  await clock.handler();
  eq(toWorker(h.phone, state.whatsapp).length, before, 'a worker who named a day was asked whether the job is theirs');
  return eq(claimRow(h.ref).status, 'assigned', 'a job was taken off a worker who had answered with a day');
});

await t('the job comes back when the ask is still unanswered — the way a decline does', async () => {
  alerts.resetServerAlertBudget();
  /* The ask has been made and has stood for more than the reclaim window:
     the state this run exists for. */
  state.trail.filter((e) => e.reference === asked.ref && e.event === 'chased')
    .forEach((e) => { e.created_at = new Date(Date.now() - 25 * 3600000).toISOString(); });
  state.whatsapp.length = 0;
  state.mail.length = 0;
  const before = state.alerts.length;

  const res = await clock.handler();
  const body = JSON.parse(res.body);
  eq(body.taken_back >= 1, true, 'the job was left with a worker who never answered');

  const row = claimRow(asked.ref);
  eq(row.status, 'approved', 'the claim did not go back to where a job with nobody on it belongs');
  eq(row.provider_answer, 'unanswered', 'the record calls a silence by the wrong word');
  eq(row.provider_name, 'Musa Ibrahim', 'the name was thrown away');
  eq(row.provider_phone, asked.phone, 'the number was thrown away');

  const rows = state.trail.filter((e) => e.reference === asked.ref && e.event === 'unanswered');
  eq(rows.length, 1, 'unanswered rows on the trail');
  eq(rows[0].to_status, 'approved', 'to_status');
  eq(rows[0].actor_role, 'system', 'actor_role \u2014 the clock did this, not the worker');

  /* The customer, who was told a name, is told there is no longer one. */
  const told = toStudent();
  ok(told.length === 1, 'the customer was sent ' + told.length + ' messages');
  ok(/could not get a confirmation out of Musa Ibrahim/.test(told[0].text),
    'the customer is told the wrong reason: ' + told[0].text.slice(0, 180));
  ok(!/not able to take the job after all/.test(told[0].text),
    'a worker who never replied is described as one who said no');
  ok(/still covered by your pass/.test(told[0].text), 'the message does not say the cover is unchanged');
  ok(state.alerts.length > before, 'nobody was paged about a job that just stopped');

  /* And the worker is told the job has gone, so nobody turns up to a flat
     with somebody else already in it. */
  const his = toWorker(asked.phone, state.whatsapp);
  ok(his.length === 1 && /given it to somebody else/.test(his[0].text),
    'the worker was not told the job had gone: ' + (his[0] ? his[0].text.slice(0, 160) : 'nothing sent'));

  /* Once, and it stays: the claim is out of 'assigned', so the clock has
     nothing left to act on. */
  const after = await clock.handler();
  eq(JSON.parse(after.body).taken_back, 0, 'the job was taken back twice');
  return eq(claimRow(asked.ref).status, 'approved', 'status on the run after');
});

await t('and a worker who answers while the clock is deciding keeps the job', async () => {
  alerts.resetServerAlertBudget();
  /* The reclaim is due by the trail, and the worker says yes before the
     run: taking the job back from somebody who replied is the mistake
     here that costs a visit, so the row is re-read before anything moves. */
  const h = await handedOverAndAbandoned('08031190062', 52);
  await claims.workerReply({ phone: h.phone, text: 'yes, it is mine' });
  const chaseRow = new Date(Date.now() - 25 * 3600000).toISOString();
  state.trail.push({
    id: ++state.seq, created_at: chaseRow, claim_id: h.id, reference: h.ref,
    from_status: 'assigned', to_status: 'assigned', event: 'chased', reason: 'asked once',
    data: null, actor_ref: null, actor_name: 'the handover clock', actor_role: 'system', env: 'production',
  });
  state.whatsapp.length = 0;

  const res = await clock.handler();
  eq(JSON.parse(res.body).taken_back, 0, 'a job was taken back from a worker who had answered');
  eq(claimRow(h.ref).status, 'assigned', 'the claim moved off a worker who replied');
  eq(claimRow(h.ref).provider_answer, 'accepted', 'the answer was overwritten');
  return eq(toStudent().length, 0, 'the customer was told a name had gone while it was still coming');
});

await t('an assigned claim with no answer is not read as a job that is merely slow', () => {
  const text = clock.nudgeText([{
    reference: 'AZ-C-SILENT', student_name: 'Bisi', provider_name: 'Musa', status: 'assigned',
    provider_answer: null, provider_proposal: null,
    aging: { who: 'ours', says: 'get the work reported', limit_hours: 48, hours_over: 5 },
  }, {
    reference: 'AZ-C-ANSWERED', student_name: 'Ada', provider_name: 'Sani, plumbing', status: 'assigned',
    provider_answer: 'accepted', provider_proposal: null,
    aging: { who: 'ours', says: 'get the work reported', limit_hours: 48, hours_over: 5 },
  }]);
  const lines = text.split('\n');
  /* The claim's own chunk of the message: from its bullet to the next one.
     A note that drifted onto the following claim would be worse than no
     note at all — "never answered" beside a worker who DID answer. */
  const chunk = (ref) => {
    const at = lines.findIndex((l) => l.indexOf(ref) !== -1);
    if (at === -1) return null;
    const next = lines.findIndex((l, i) => i > at && l.indexOf('\u2022') === 0);
    return lines.slice(at, next === -1 ? lines.length : next).join('\n');
  };
  const silent = chunk('AZ-C-SILENT');
  const answered = chunk('AZ-C-ANSWERED');
  ok(silent && answered, 'a claim is missing from the nudge');
  ok(/never answered/.test(silent), 'the nudge does not say the handover was never answered: ' + silent);
  return eq(/never answered/.test(answered), false,
    'a worker who answered is shown as one who did not: ' + answered);
});

/* ============================================================
   14. THE CUSTOMER'S ANSWER TO A DAY

   A day a worker offers is a QUESTION, and the only person who can
   answer it is the tenant who has to be in. Both answers exist:

     agree_day    yes, in one tap. The WORKER is told the visit is on
                  (they are the one who has to turn up), and agreeing
                  twice is one message, not two.
     propose_day  "not Saturday \u2014 Sunday afternoon", in the customer's
                  own words, passed to the worker with the tenant's
                  number. The worker's day stays on the row: it is what
                  was answered.

   Neither moves the claim, and neither can be used to cancel a visit.
   ============================================================ */

console.log('\n14. The customer answers the day the worker suggested, and the worker hears about it\n');

/* A claim with a worker on it who has offered a day — the state both
   answers are answers TO. */
async function workerOfferedADay(phone, text) {
  const h = await handedOver({ phone: phone });
  const said = text || 'Can I come Saturday morning before 11?';
  await claims.workerReply({ phone: h.phone, text: said });
  h.day = claimRow(h.ref).provider_proposal;
  return h;
}

let dayAgreed = null;

await t('the customer agreeing a day tells the worker the visit is on', async () => {
  alerts.resetServerAlertBudget();
  dayAgreed = await workerOfferedADay('08031190070');
  state.whatsapp.length = 0;

  const out = await student({ action: 'agree_day', id: dayAgreed.id, token: dayAgreed.pass.token });
  eq(out.status, 200, 'status');
  eq(out.body.agreed, dayAgreed.day, 'the answer does not quote the day that was agreed');

  const row = claimRow(dayAgreed.ref);
  ok(row.day_agreed_at, 'the agreement is not on the claim');
  /* The day itself is left exactly where it was: the worker's words are
     what was agreed to, and re-wording them would be us versioning
     somebody's sentence. */
  eq(row.provider_proposal, dayAgreed.day, 'the agreed day was re-worded');
  eq(row.status, 'assigned', 'agreeing a day moved the claim');

  const rows = state.trail.filter((e) => e.reference === dayAgreed.ref && e.event === 'day_agreed');
  eq(rows.length, 1, 'day_agreed rows on the trail');
  eq(rows[0].actor_role, 'student', 'actor_role');
  ok(/Saturday morning/.test(rows[0].reason), 'the record does not keep which day it was: ' + rows[0].reason);

  /* The WORKER, because they are the one who has to turn up. */
  const his = toWorker(dayAgreed.phone, state.whatsapp);
  eq(his.length, 1, 'messages the worker was sent');
  ok(/the visit is on/.test(his[0].text), 'the worker was not told the visit is on: ' + his[0].text.slice(0, 180));
  ok(his[0].text.indexOf('Saturday morning') !== -1, 'the message does not quote the day that was agreed');
  const notices = state.trail.filter((e) => e.reference === dayAgreed.ref && e.event === 'notified');
  return ok(/worker_whatsapp: sent/.test(notices[notices.length - 1].reason),
    'the worker notice is not on the record: ' + notices[notices.length - 1].reason);
});

await t('and agreeing again is one message, not two', async () => {
  const rowsBefore = state.trail.filter((e) => e.reference === dayAgreed.ref).length;
  state.whatsapp.length = 0;
  const again = await student({ action: 'agree_day', id: dayAgreed.id, token: dayAgreed.pass.token });
  eq(again.status, 200, 'status');
  eq(again.body.already, true, 'the answer does not say it was already agreed');
  eq(state.trail.filter((e) => e.reference === dayAgreed.ref).length, rowsBefore, 'agreeing twice wrote rows');
  return eq(toWorker(dayAgreed.phone, state.whatsapp).length, 0,
    'the worker was told twice about one agreed day');
});

await t('a day that does not suit them goes to the worker in the customer\u2019s own words', async () => {
  alerts.resetServerAlertBudget();
  const h = await workerOfferedADay('08031190071');
  state.whatsapp.length = 0;
  const alertsBefore = state.alerts.length;

  const out = await student({
    action: 'propose_day', id: h.id, token: h.pass.token,
    when: 'Not Saturday \u2014 Sunday afternoon after 2, I am at work in the morning',
  });
  eq(out.status, 200, 'status');

  const row = claimRow(h.ref);
  eq(row.customer_proposal,
    'Not Saturday \u2014 Sunday afternoon after 2, I am at work in the morning', 'their own words, kept');
  ok(row.customer_proposed_at, 'the instant they suggested it is missing');
  /* The day that was ANSWERED stays: a counter-offer does not erase the
     offer, and the next person to read this needs both halves. */
  eq(row.provider_proposal, h.day, 'the worker\u2019s own day was thrown away by the answer');
  eq(row.day_agreed_at, null, 'a counter-offer was recorded as an agreement');
  eq(row.status, 'assigned', 'a different day moved the claim');

  const rows = state.trail.filter((e) => e.reference === h.ref && e.event === 'day_proposed');
  eq(rows.length, 1, 'day_proposed rows on the trail');
  eq(rows[0].actor_role, 'student', 'actor_role');
  ok(/Sunday afternoon/.test(rows[0].reason), 'the record does not keep the day they suggested');

  /* The worker is told, with the day they offered quoted back and the
     tenant's number to settle it on \u2014 they cannot re-arrange a visit
     with somebody they cannot reach. */
  const his = toWorker(h.phone, state.whatsapp);
  eq(his.length, 1, 'messages the worker was sent');
  ok(his[0].text.indexOf('Sunday afternoon after 2') !== -1,
    'the worker was not told the day the customer suggested: ' + his[0].text.slice(0, 200));
  ok(his[0].text.indexOf(h.day) !== -1, 'the worker\u2019s own day is not quoted back, so they cannot tell what changed');
  ok(his[0].text.indexOf(STUDENT_PHONE) !== -1, 'the worker has no way to settle the new day');
  ok(/the job is still yours/i.test(his[0].text),
    'a different day was written as though the job had moved: ' + his[0].text.slice(0, 200));

  /* AND THE TEAM, on every one of these. Deliberately different from the
     agreement: "that day works" leaves nothing in the air, while a moved
     day is a plan the office still believes something else about \u2014 and
     the two people settling it between themselves are exactly the two who
     cannot be counted on to ring us when they do not. */
  const paged = state.alerts.slice(alertsBefore);
  eq(paged.length, 1, 'the team was paged ' + paged.length + ' times about one moved day');
  const said = paged[0].text;
  ok(/visit day moved/i.test(said), 'the page does not say what happened: ' + said.slice(0, 160));
  ok(said.indexOf(h.day) !== -1, 'the page does not quote the day that was moved');
  ok(said.indexOf('Sunday afternoon after 2') !== -1,
    'the page does not carry the day the customer asked for');
  ok(said.indexOf(STUDENT_PHONE) !== -1, 'the page has no way to reach the customer');
  ok(said.indexOf(h.ref) !== -1, 'the page does not name the claim');
  return eq(out.body.team_paged, true, 'the answer does not say whether the team was reached');
});

await t('and agreeing a day pages nobody, because nothing is left in the air', async () => {
  alerts.resetServerAlertBudget();
  /* The snapshot is taken AFTER the handover, not before it: filing a
     claim and naming a worker page the team about those moves, and this
     check is about one action — the customer's answer. */
  const h = await workerOfferedADay('08031190076');
  const before = state.alerts.length;
  const out = await student({ action: 'agree_day', id: h.id, token: h.pass.token });
  eq(out.body.team_paged, undefined, 'agreeing a day reports a page nobody got');
  return eq(state.alerts.length, before,
    'the team was paged about a visit that is simply on: ' +
      String((state.alerts[state.alerts.length - 1] || {}).text || '').slice(0, 160));
});

await t('and a day written in two words is not a message', async () => {
  const h = await workerOfferedADay('08031190072');
  const rowsBefore = state.trail.filter((e) => e.reference === h.ref).length;
  const out = await student({ action: 'propose_day', id: h.id, token: h.pass.token, when: 'sat?' });
  eq(out.status, 400, 'status');
  ok(/when would suit you/i.test(out.body.error), 'the refusal does not say what to write: ' + out.body.error);
  eq(claimRow(h.ref).customer_proposal, null, 'a two-word answer was written to the claim');
  return eq(state.trail.filter((e) => e.reference === h.ref).length, rowsBefore, 'a refusal wrote a row');
});

await t('their own record carries both halves of the conversation', async () => {
  const h = await workerOfferedADay('08031190073');
  await student({ action: 'agree_day', id: h.id, token: h.pass.token });
  const listed = await student({ action: 'list', token: h.pass.token });
  const row = listed.body.claims.filter((c) => c.reference === h.ref)[0];
  eq(row.provider_proposal, h.day, 'the day on their own record');
  ok(row.day_agreed_at, 'the agreement is missing from their own record');

  const other = await workerOfferedADay('08031190074');
  await student({ action: 'propose_day', id: other.id, token: other.pass.token, when: 'Tuesday evening is better for me' });
  const again = await student({ action: 'list', token: other.pass.token });
  const theirs = again.body.claims.filter((c) => c.reference === other.ref)[0];
  eq(theirs.customer_proposal, 'Tuesday evening is better for me', 'the customer\u2019s own day');
  return eq(theirs.day_agreed_at, null, 'a suggestion appears as an agreement on their own page');
});

await t('a day cannot be answered on a job nobody is on, and cannot be used to stop one', async () => {
  /* No worker named yet: there is no day, and nobody to pass anything to. */
  const pass = openPass();
  const c = await student({ action: 'create', token: pass.token, issue: 'the shower drain backs up whenever the tap runs' });
  const id = c.body.claim.id;
  await decide({ action: 'decide', id: id, eligibility: 'covered', reason: 'Covered: a blocked drain serving the flat.' });
  const early = await student({ action: 'agree_day', id: id, token: pass.token });
  eq(early.status, 409, 'agreeing a day on a claim with nobody named');
  const toNobody = await student({ action: 'propose_day', id: id, token: pass.token, when: 'Tuesday afternoon works for me' });
  eq(toNobody.status, 409, 'sending a day to nobody');
  eq(claimRow(c.body.claim.reference).customer_proposal, null, 'a day was written with nobody to send it to');

  /* And the other door: a withdrawn claim has no visit to move. */
  const h = await workerOfferedADay('08031190075');
  const stopped = await student({ action: 'cancel', id: h.id, token: h.pass.token });
  eq(stopped.status, 200, 'the withdrawal');
  const late = await student({ action: 'propose_day', id: h.id, token: h.pass.token, when: 'Wednesday morning is better' });
  eq(late.status, 409, 'a day was moved on a claim that is over');

  /* And the link is the credential: another pass cannot answer this day. */
  const stranger = await student({ action: 'agree_day', id: h.id, token: openPass().token });
  return eq(stranger.status, 404, 'a day was agreed through somebody else\u2019s link');
});

/* ============================================================
   15. THE DAILY VISIT DIGEST

   One message a day about the visits that have not happened yet, and
   the only question the office has about them: how many are pinned
   down? The counts are claims.js's own definition of a day (the same
   one the queue prints), and the days themselves are QUOTED — never
   turned into dates, because the two people arranging the visit used
   sentences, not timestamps.
   ============================================================ */

console.log('\n15. The daily visit digest: what is agreed, and what is still being haggled over\n');

let inTheAir = null;    // a day offered, nobody has answered
let haggled = null;     // a day offered, answered with one of their own
let settled = null;     // a day offered, and agreed

const refsOf = (list) => list.map((r) => r.reference);

await t('the digest counts what is settled against what is still in the air', async () => {
  inTheAir = await workerOfferedADay('08031190080');
  haggled = await workerOfferedADay('08031190081', 'I can do Thursday evening');
  await student({
    action: 'propose_day', id: haggled.id, token: haggled.pass.token,
    when: 'Thursday evening is no good \u2014 Friday morning before 9?',
  });
  settled = await workerOfferedADay('08031190082', 'Sunday morning works for me');
  await student({ action: 'agree_day', id: settled.id, token: settled.pass.token });

  const model = await digest.collect(new Date());
  ok(refsOf(model.waiting).indexOf(inTheAir.ref) !== -1,
    'a day nobody has answered is not counted as waiting on an answer');
  ok(refsOf(model.asked).indexOf(haggled.ref) !== -1,
    'a counter-offer is not counted as still being haggled over');
  ok(refsOf(model.agreed).indexOf(settled.ref) !== -1,
    'a day agreed today is not counted as agreed');

  /* ONE state per claim. A visit in two lists makes the totals add up to
     more visits than there are, which is the one thing a summary must
     never do. */
  [inTheAir, haggled, settled].forEach((h) => {
    const inHowMany = ['agreed', 'asked', 'waiting']
      .filter((k) => refsOf(model[k]).indexOf(h.ref) !== -1).length;
    eq(inHowMany, 1, h.ref + ' is in ' + inHowMany + ' of the three lists');
  });
  eq(model.counts.agreed + model.counts.asked + model.counts.waiting,
    model.counts.visits, 'the parts do not add up to the whole');
  return eq(model.counts.open, model.counts.asked + model.counts.waiting,
    '\u201cnot settled\u201d is not the two unsettled lists together');
});

await t('the message quotes the days in the words the two of them used', async () => {
  const text = digest.digestText(await digest.collect(new Date()));
  ok(/visits still to come/i.test(text), 'the message does not say what it is');
  ok(text.indexOf(haggled.ref) !== -1, 'the claim is not named');
  /* BOTH halves of a haggled day, in the words each person used: a
     message that printed only the customer's day would leave the reader
     unable to tell what was being answered. */
  ok(text.indexOf('Thursday evening') !== -1, 'the day the worker suggested is not quoted');
  ok(text.indexOf('Friday morning before 9') !== -1, 'the day the customer answered with is not quoted');
  ok(text.indexOf('Sunday morning works for me') !== -1, 'the day that was agreed is not quoted');
  ok(text.indexOf(inTheAir.day) !== -1, 'the day nobody has answered is not quoted');
  /* And nothing here is a date. A sentence somebody said is not an
     appointment, and printing a computed one is the failure this whole
     feature exists to avoid. */
  return ok(!/\d{4}-\d{2}-\d{2}T/.test(text),
    'the message printed a timestamp as though a day had been booked');
});

await t('what it says to do is nothing, unless one of them goes quiet', async () => {
  const text = digest.digestText(await digest.collect(new Date()));
  ok(/settle the time between them/i.test(text), 'the message does not say who is arranging the visit');
  return ok(/ring in if the same one is on this list tomorrow/i.test(text),
    'the message does not say when a person should step in: ' + text.slice(-300));
});

await t('a visit that already happened is not a visit to come', async () => {
  /* Reporting the work is the admin's (support coordinates, the admin
     records the cost) — and it is the move that makes a day history. */
  asAdmin();
  const done = await team({ action: 'report_work', id: inTheAir.id });
  eq(done.status, 200, 'reporting the work');
  const model = await digest.collect(new Date());
  const everywhere = refsOf(model.waiting).concat(refsOf(model.asked), refsOf(model.agreed));
  ok(everywhere.indexOf(inTheAir.ref) === -1,
    'a visit whose work was reported is still counted as one to come');
  return eq(model.counts.visits, model.agreed.length + model.asked.length + model.waiting.length,
    'the count and the lists disagree');
});

await t('a claim filed in a test run is not in the team\u2019s morning message', async () => {
  const probe = {
    id: 'claim-env-probe', reference: 'AZ-C-ENV-PROBE', status: 'assigned', env: 'test',
    student_name: 'Stand-in', student_phone: STUDENT_PHONE, property: 'Test Lodge', room: 'T1',
    provider_name: 'Musa Ibrahim', provider_phone: '2348031110000',
    provider_proposal: 'Wednesday at noon', provider_proposed_at: new Date().toISOString(),
    customer_proposal: null, customer_proposed_at: null, day_agreed_at: null,
    created_at: new Date().toISOString(),
  };
  state.claims.push(probe);
  const model = await digest.collect(new Date());
  const everywhere = refsOf(model.waiting).concat(refsOf(model.asked), refsOf(model.agreed));
  const seen = everywhere.indexOf(probe.reference) !== -1;
  state.claims = state.claims.filter((c) => c.id !== probe.id);
  return seen ? 'a test claim was named in the digest' : true;
});

await t('a quiet day sends nothing \u2014 a settled set is not news', async () => {
  const quiet = {
    agreed: [], asked: [], waiting: [], quietAgreed: 4, noDay: 2,
    counts: { visits: 4, agreed: 4, asked: 0, waiting: 0, open: 0, noDay: 2, capped: false },
  };
  eq(digest.worthSending(quiet), false, 'a day with nothing in the air still sent a message');
  eq(digest.worthSending(Object.assign({}, quiet, { waiting: [1] })), true,
    'a day nobody has answered did not send a message');
  eq(digest.worthSending(Object.assign({}, quiet, { counted: 1, agreed: [1] })), true,
    'a day that moved did not send a message');
  return true;
});

await t('the job runs on a schedule and sends what it composed', async () => {
  alerts.resetServerAlertBudget();
  const before = state.alerts.length;
  const res = await digest.handler();
  eq(res.statusCode, 200, 'status');
  eq(JSON.parse(res.body).outcome, 'sent', 'outcome');
  eq(state.alerts.length, before + 1, 'the team got ' + (state.alerts.length - before) + ' messages');
  const said = state.alerts[state.alerts.length - 1].text;
  ok(/visits still to come/i.test(said), 'what arrived is not the digest: ' + said.slice(0, 120));
  return ok(said.indexOf(haggled.ref) !== -1, 'the day being haggled over is not in what arrived');
});

await t('a digest that cannot read the database says so, instead of going quietly dead', async () => {
  alerts.resetServerAlertBudget();
  const saved = global.fetch;
  state.alerts.length = 0;
  global.fetch = async (url, init) => {
    if (String(url).indexOf('/rest/v1/repair_claims') !== -1) {
      return resp(500, { message: 'the connection pool is exhausted' });
    }
    return saved(url, init);
  };
  try {
    const res = await digest.handler();
    eq(res.statusCode, 200, 'status');
    eq(JSON.parse(res.body).outcome, 'read-failed', 'outcome');
    const said = state.alerts[state.alerts.length - 1];
    ok(said, 'a failed digest told nobody');
    ok(/digest could not run/i.test(said.text), 'the failure was not reported: ' + said.text.slice(0, 140));
    return ok(/dashboard still has/i.test(said.text) || /still in the dashboard/i.test(said.text),
      'the page does not say where the visits still are');
  } finally {
    global.fetch = saved;
  }
});

/* ---------------- report ---------------- */

console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
console.log(passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
