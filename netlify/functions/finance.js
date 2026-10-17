/* ============================================================
   Arzuz — Netlify Function: the money core

   WHAT THIS OWNS
     Orders, payments, the append-only ledger and referrals. The
     existing Care ledger (care_credit_events) records call-outs;
     this file records the MONEY that bought them and the coverage
     term it bought. supabase-finance.sql is the schema; this is the
     only writer of it.

   THE RULES THIS FILE IS BUILT TO KEEP

     1. HOUSING IS FREE. There is no code path here that charges a
        landlord or a tenant, takes a percentage of rent, or bundles
        a Care/verification/monitoring charge into a rent payment.
        'housing' is a business line with no revenue post.

     2. A CARE PASS IS COVERAGE, NOT A WALLET. The ₦20,000 buys a
        term: coverage_start/coverage_end and a call-out cap, copied
        from the accepted terms version. It is not credited to a
        balance a customer can withdraw.

     3. THE PRICE IS FROZEN AT PURCHASE. An order stores the terms
        id and version it was created against; publishing a new
        price tomorrow cannot re-price it.

     4. A REDIRECT IS NOT A PAYMENT. Activation happens only after
        the provider's own server-side verification (or a signed
        webhook) says the charge succeeded, and the amount and
        currency must match the order. The frontend success page is
        never trusted.

     5. NOTHING ACTIVATES TWICE. paid_at is claimed with a
        conditional update, the provider reference is UNIQUE, and
        every ledger row's reference is derived from the payment —
        so a replayed webhook, a re-run verify and a day-two retry
        all land on the same already-paid row.

     6. SALES STAY OFF UNTIL THE TERMS ARE APPROVED. care_pass has
        no published terms until an authorized admin publishes them,
        and an order is refused until then.

     7. STORAGE STAYS OFF. finance_config.storage_enabled is false
        and a storage order is refused while it is.

     8. THE PRODUCT IS HANDED OVER, ONCE. Coverage is reported from the
        plan activation opened, and the pass's link is released only
        to the browser that paid — it proves itself with the client_ref
        IT generated, not with the reference that travels in a URL.
        A reference alone buys nobody a link.

   WHO MAY DO WHAT
     The student's door is unauthenticated but metered: `terms`,
     `order`, `verify`, `status`. It can only ever create THEIR order
     for the published price — it cannot name an amount, a discount,
     a payment status or a coverage window.
     The team's door is a Supabase session verified in two steps (a
     live token, then the role POSTGRES computes from it):
       admin    report, publish_terms, set_config, refund, referral_decide
       support  report (read-only — support cannot move money)

   Provider: Paystack (NGN). PAYSTACK_SECRET_KEY only, server-side.
   Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
   ============================================================ */

const crypto = require('node:crypto');

const { sb, cfg, newToken, hashToken, normalizePhone } = require('./roommate-match.js');
const { liveUser, roleOf } = require('./care-credit.js');
const { sendAlert } = require('./notify.js');

const ApiErrors = require('../../assets/api-errors.js');

const PAYSTACK_BASE = 'https://api.paystack.co';

/* ------------------------------------------------------------
   money — integer KOBO, never a float
   ------------------------------------------------------------ */

const NAIRA = 100;
const nairaToKobo = (n) => Math.round(Number(n) * NAIRA);

function kobo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/* ------------------------------------------------------------
   the provider adapter — Paystack
   ------------------------------------------------------------ */

function payCfg() {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  return { key, ready: !!key };
}

async function paystack(path, options = {}) {
  const { key } = payCfg();
  const res = await fetch(PAYSTACK_BASE + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok || (data && data.status === false)) {
    const own = (data && (data.message || data.error)) || ('Paystack answered HTTP ' + res.status);
    const err = new Error(own);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* Where the buyer comes back to. The origin is the DEPLOYMENT's, taken
   from the environment — never from the request — so a caller cannot
   aim the post-payment redirect at a site of their choosing. */
function siteOrigin() {
  const raw = process.env.ARZUZ_SITE_URL || process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://arzuz.com';
  const url = String(raw).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(url) ? url : 'https://arzuz.com';
}

/* Open a transaction. The reference is OURS and unique on the order,
   so the provider echoes back the one we already hold a row for. */
async function payInit({ email, amountKobo, reference, metadata }) {
  const payload = {
    email: email,
    amount: amountKobo,
    currency: 'NGN',
    reference: reference,
    metadata: metadata || {},
    /* The buyer lands back on our own page with the reference in the
       URL — and that page still verifies with the provider before it
       says a word about coverage. */
    callback_url: siteOrigin() + '/care-pass?reference=' + encodeURIComponent(reference),
  };
  const data = await paystack('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return (data && data.data) || null;
}

/* THE SERVER-SIDE VERIFICATION. What a redirect can never be: the
   provider, asked directly, about this reference. */
async function payVerify(reference) {
  const data = await paystack('/transaction/verify/' + encodeURIComponent(reference), { method: 'GET' });
  return (data && data.data) || null;
}

async function payRefund({ reference, amountKobo }) {
  const body = { transaction: reference };
  if (amountKobo) body.amount = amountKobo;
  const data = await paystack('/refund', { method: 'POST', body: JSON.stringify(body) });
  return (data && data.data) || null;
}

/* ------------------------------------------------------------
   wire helpers
   ------------------------------------------------------------ */

function json(status, obj, kind) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(ApiErrors.wireBody(status, obj, kind)),
  };
}

const recent = [];
function limited(key, max, windowMs) {
  const now = Date.now();
  const win = windowMs || 60_000;
  while (recent.length && now - recent[0].t > win) recent.shift();
  const mine = recent.filter((r) => r.key === key);
  if (mine.length >= max) return true;
  recent.push({ key, t: now });
  return false;
}

function reference(prefix) {
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(4).toString('hex').toUpperCase();
  return (prefix || 'AZ') + '-' + t + '-' + r;
}

/* Canonical JSON so the hash of a terms row is reproducible: a hash
   that depends on key order could not prove anything. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function termsHash(terms) {
  return crypto.createHash('sha256').update(canonical(terms)).digest('hex');
}

/* ------------------------------------------------------------
   config + terms
   ------------------------------------------------------------ */

async function readConfig() {
  const rows = await sb('finance_config?select=key,value', { method: 'GET' });
  const out = {};
  for (const row of rows || []) {
    let v = row.value;
    if (typeof v === 'string') {
      /* jsonb scalars come back as JSON; a number arrives already
         numeric, a string arrives quoted. Normalise the digits. */
      const trimmed = v.trim();
      if (/^-?\d+$/.test(trimmed)) v = Number(trimmed);
      else if (trimmed === 'true') v = true;
      else if (trimmed === 'false') v = false;
      else { try { v = JSON.parse(trimmed); } catch (_) { /* keep the string */ } }
    }
    out[row.key] = v;
  }
  return out;
}

async function publishedTerms(product) {
  const rows = await sb(
    'public_terms?select=id,product,version,terms,hash,published_at&product=eq.' +
      encodeURIComponent(product) + '&limit=1',
    { method: 'GET' }
  );
  return (rows && rows[0]) || null;
}

/* ------------------------------------------------------------
   coverage window — a pass always has a defined start and end
   ------------------------------------------------------------ */

function coverageWindow(config, startIso) {
  const start = startIso ? new Date(startIso) : new Date();
  const pinned = config.care_term_end;
  if (pinned && String(pinned).length >= 8) {
    const end = new Date(String(pinned));
    if (!Number.isNaN(end.getTime()) && end > start) return { start, end };
  }
  const days = Number(config.care_term_days) > 0 ? Math.round(Number(config.care_term_days)) : 120;
  return { start, end: new Date(start.getTime() + days * 86400_000) };
}

/* ------------------------------------------------------------
   the ledger — one row per movement, reference-derived
   ------------------------------------------------------------ */

async function post(entry) {
  const row = Object.assign({ currency: 'NGN' }, entry);
  try {
    const out = await sb('ledger_entries', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    return Array.isArray(out) ? out[0] : out;
  } catch (err) {
    /* 23505 on entry_ref is the idempotency doing its job: this exact
       movement is already in the journal. Not an error. */
    if (String(err.message || '').includes('duplicate')) return null;
    throw err;
  }
}

/* ------------------------------------------------------------
   REFERRALS
   ------------------------------------------------------------ */

/* The referred customer's first VERIFIED payment is the qualifying
   event, so this is called only from activation. The two unique
   indexes are the enforcement — a self-referral, a replayed payment
   and a second claim on the same customer all fail the insert rather
   than being filtered by a read that could race. */
async function qualifyReferral(payment) {
  const code = payment.referral_code;
  if (!code) return { ok: false, reason: 'no code' };

  const rows = await sb(
    'referral_codes?select=code,owner_ref,owner_name,active&code=eq.' +
      encodeURIComponent(code) + '&limit=1',
    { method: 'GET' }
  );
  const owner = (rows && rows[0]) || null;
  if (!owner || !owner.active) return { ok: false, reason: 'unknown code' };

  const referred = normalizePhone((payment.subject || {}).phone) || (payment.subject || {}).phone;
  if (!referred) return { ok: false, reason: 'no referred customer' };

  /* NO SELF-REFERRALS. The database asserts this too; catching it here
     means a student who shares their own link gets an answer rather
     than a 23514 in a log. */
  if (owner.owner_ref === referred) {
    return { ok: false, reason: 'self-referral refused' };
  }

  const reward = money(payment.reward_kobo);
  try {
    const out = await sb('referrals', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        code: code,
        referrer_ref: owner.owner_ref,
        referred_ref: referred,
        qualifying_payment_id: payment.id,
        qualifying_payment_ref: payment.reference,
        status: 'pending_qualification',
        reward_kobo: reward || 200000,
        env: payment.env || 'production',
      }),
    });
    return { ok: true, row: Array.isArray(out) ? out[0] : out };
  } catch (err) {
    /* A second claim on this payment, or this customer already
       qualified: the uniqueness did its job. */
    if (String(err.message || '').includes('duplicate')) {
      return { ok: false, reason: 'already claimed' };
    }
    throw err;
  }
}

/* ------------------------------------------------------------
   ACTIVATION — the one place a paid order becomes coverage
   ------------------------------------------------------------ */

/* Claim the order. A conditional update on paid_at is the atomic
   gate: two callbacks arriving at once both try it, Postgres lets
   exactly one through, and the loser reads an empty result and
   returns the state the winner is writing. */
async function claimPaid(payment, providerData, providerRef) {
  const out = await sb(
    'payments?id=eq.' + encodeURIComponent(payment.id) + '&paid_at=is.null',
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status: 'paid',
        paid_at: new Date().toISOString(),
        provider: 'paystack',
        provider_ref: providerRef || payment.provider_ref || payment.reference,
        provider_payload: providerData || null,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  return Array.isArray(out) ? out[0] : null;
}

async function activate(paymentId, providerData, providerRef) {
  const rows = await sb('payments?select=*&id=eq.' + encodeURIComponent(paymentId) + '&limit=1', { method: 'GET' });
  const payment = (rows && rows[0]) || null;
  if (!payment) return { ok: false, status: 404, reason: 'no such payment' };

  /* Already active: nothing to do, and the caller is told the truth
     rather than a second plan being opened. */
  if (payment.activated_at) return { ok: true, already: true, payment: payment };

  const claimed = await claimPaid(payment, providerData, providerRef);
  if (!claimed) {
    /* Another callback won the race. Re-read and report. */
    const after = await sb('payments?select=*&id=eq.' + encodeURIComponent(payment.id) + '&limit=1', { method: 'GET' });
    return { ok: true, already: true, payment: (after && after[0]) || payment };
  }

  const config = await readConfig();
  const terms = payment.terms_version && payment.terms_id
    ? (await sb('product_terms?select=terms,version&id=eq.' + encodeURIComponent(payment.terms_id) + '&limit=1', { method: 'GET' }))[0]
    : null;

  const subject = payment.subject || {};
  const cap = terms && terms.terms && Number(terms.terms.call_outs_included) > 0
    ? Math.round(Number(terms.terms.call_outs_included))
    : (Number(config.care_call_out_cap) > 0 ? Math.round(Number(config.care_call_out_cap)) : 4);

  const window = coverageWindow(config, claimed.paid_at);
  const token = newToken();
  const amountNaira = Math.round(payment.amount_kobo / NAIRA);
  /* The receipt is minted BEFORE the plan so the pass and the order
     carry the SAME reference — a customer quoting their receipt must
     find one row, not two that disagree. */
  const receipt = payment.receipt_ref || reference('AZ-R');

  let plan = null;
  try {
    const out = await sb('care_plans', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        token_hash: hashToken(token),
        session: subject.session || process.env.ARZUZ_SESSION || '2026/2027',
        env: payment.env || 'production',
        status: 'active',
        amount_ngn: amountNaira,
        starts_at: window.start.toISOString(),
        payload: Object.assign({}, subject, { name: subject.name, phone: subject.phone }),
        source: 'care-pass-checkout',
        referrer: payment.referral_code || null,
        notes: 'Paid online — payment ' + payment.reference + ' (' + payment.terms_version + ')',
        terms_id: payment.terms_id,
        terms_version: payment.terms_version,
        coverage_start: window.start.toISOString(),
        coverage_end: window.end.toISOString(),
        call_out_cap: cap,
        payment_id: payment.id,
        receipt_ref: receipt,
      }),
    });
    plan = Array.isArray(out) ? out[0] : out;
  } catch (err) {
    /* THE HARD CASE THE BRIEF NAMES: the money is confirmed but the
       coverage could not be opened. The failure is RECORDED on the
       order and the team is alerted — the customer must never be
       charged again, so this is a repair job, not a retry. */
    const message = String((err && err.message) || err);
    await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ activation_error: message.slice(0, 500), updated_at: new Date().toISOString() }),
    });
    await sendAlert(
      '⚠️ Care Pass paid but NOT activated\n' +
      'payment ' + payment.reference + ' · ' + subject.name + ' · ' + subject.phone + '\n' +
      'Customer: open the pass by hand. Do NOT charge again.\n' + message
    );
    return { ok: false, status: 409, reason: 'activation failed', detail: message, payment: claimed };
  }

  /* The credits, on the SAME append-only ledger the dashboard already
     trusts. One row per call-out in the cap, as a single grant delta. */
  await sb('care_credit_events', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      plan_id: plan.id,
      student_name: subject.name || null,
      session: plan.session,
      event: 'granted',
      delta: cap,
      reason: 'Care Pass ' + payment.reference + ' — ' + cap + ' call-outs, ₦' + amountNaira.toLocaleString('en-NG'),
      actor_name: 'paystack checkout',
      env: plan.env,
    }),
  });

  /* THE BOOKS. Cash up, coverage obligation up. Revenue is recognized
     LATER, by policy — cash received is not revenue. */
  await post({
    entry_ref: payment.reference + ':cash',
    business_line: 'care',
    account: 'cash',
    direction: 'debit',
    amount_kobo: payment.amount_kobo,
    payment_id: payment.id,
    source: 'payment',
    memo: 'Care Pass paid — ' + payment.reference,
    env: payment.env,
  });
  await post({
    entry_ref: payment.reference + ':unearned',
    business_line: 'care',
    account: 'unearned',
    direction: 'credit',
    amount_kobo: payment.amount_kobo,
    payment_id: payment.id,
    source: 'payment',
    memo: 'Coverage owed on ' + payment.reference,
    env: payment.env,
  });

  const referral = await qualifyReferral(Object.assign({}, claimed, {
    reward_kobo: config.referral_reward_kobo,
  }));

  await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      activated_at: new Date().toISOString(),
      receipt_ref: receipt,
      updated_at: new Date().toISOString(),
    }),
  });

  await sendAlert(
    '✅ Care Pass activated\n' +
    payment.reference + ' · ₦' + amountNaira.toLocaleString('en-NG') + '\n' +
    subject.name + ' · ' + subject.phone + '\n' +
    cap + ' call-outs until ' + window.end.toISOString().slice(0, 10) +
    (referral.ok ? '\nreferral ' + payment.referral_code + ' → ₦' + Math.round((config.referral_reward_kobo || 200000) / 100).toLocaleString('en-NG') : '')
  );

  return {
    ok: true,
    already: false,
    plan_id: plan.id,
    token: token,
    coverage_start: window.start.toISOString(),
    coverage_end: window.end.toISOString(),
    call_out_cap: cap,
    receipt_ref: receipt,
    referral: referral.ok,
  };
}

/* ------------------------------------------------------------
   THE PASS LINK — how the buyer gets the key to what they bought

   A Care Pass is opened as a `care_plans` row whose only credential is
   a token this server hashes and does not keep. So the link has to be
   handed over exactly once, to the browser that paid.

   That browser is identified by the `client_ref` IT generated at
   checkout and kept locally — a capability, not a guessable value. A
   caller who can only name the reference (which travels in a URL after
   payment) gets no link and no coverage: it learns what the provider
   confirms, and nothing more.

   Issued once. The marker is written on the order, so a reload of the
   return page cannot re-mint a link behind a link the team may already
   have sent — a lost link goes through support, exactly as the
   existing Care page already says.
   ------------------------------------------------------------ */

const PASS_LINK_MARK = 'pass link issued';

function sameClientRef(payment, given) {
  const g = String(given || '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(g)) return false;
  const mine = String((payment && payment.client_ref) || '');
  return !!mine && mine.toLowerCase() === g.toLowerCase();
}

async function planForPayment(paymentId) {
  const rows = await sb(
    'care_plans?select=*&payment_id=eq.' + encodeURIComponent(paymentId) + '&limit=1',
    { method: 'GET' }
  );
  return (rows && rows[0]) || null;
}

/* What the pass IS, for the customer to see: a term with a start, an
   end, a cap and a receipt. Read from the plan that activation opened,
   so the page cannot show a window the database did not open. */
async function coverageOf(payment) {
  if (!payment || !payment.activated_at) return null;
  const plan = await planForPayment(payment.id);
  if (!plan) return null;
  return {
    plan_status: plan.status || null,
    session: plan.session || null,
    start: plan.coverage_start || plan.starts_at || null,
    end: plan.coverage_end || plan.ends_at || null,
    call_out_cap: plan.call_out_cap != null ? Number(plan.call_out_cap) : null,
    receipt_ref: payment.receipt_ref || plan.receipt_ref || null,
  };
}

async function markLinkIssued(payment) {
  await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      notes: ((payment.notes ? payment.notes + '\n' : '') + PASS_LINK_MARK + ' ' + new Date().toISOString()).slice(-4000),
      updated_at: new Date().toISOString(),
    }),
  });
}

/* Mint a link for a pass that was opened by the webhook — the one path
   where activation did not run in the buyer's own request. The token
   the webhook made was never handed to anybody, so replacing it
   invalidates nothing a customer holds. */
async function claimPassLink(payment) {
  if (String(payment.notes || '').indexOf(PASS_LINK_MARK) !== -1) return null;
  const plan = await planForPayment(payment.id);
  if (!plan) return null;
  const token = newToken();
  try {
    await sb('care_plans?id=eq.' + encodeURIComponent(plan.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ token_hash: hashToken(token) }),
    });
  } catch (err) {
    console.error('[finance] could not issue the pass link:', err && err.message);
    return null;
  }
  await markLinkIssued(payment);
  return { token: token, path: '/my-care?t=' + token };
}

/* What a fresh activation is allowed to be true about: the amount the
   provider took must equal the order, in the same currency. */
function amountMatches(payment, providerData) {
  const paid = money(providerData && providerData.amount);
  const currency = String((providerData && providerData.currency) || '').toUpperCase();
  if (currency && currency !== payment.currency) return false;
  return paid !== null && Number(paid) === Number(payment.amount_kobo);
}

/* ------------------------------------------------------------
   ACTIONS
   ------------------------------------------------------------ */

/* The student's four, and none of them can name a price. */
const PUBLIC_ACTIONS = ['terms', 'order', 'verify', 'status'];

async function actionTerms() {
  const terms = await publishedTerms('care_pass');
  const config = await readConfig();
  if (!terms) {
    /* NOT an error the visitor can fix: sales are off until an admin
       approves the terms. The class stops the page offering a retry. */
    return {
      status: 503,
      kind: 'not-ready',
      body: {
        error: 'The Care Pass is not on sale yet — Arzuz is still approving the coverage terms. ' +
          'Nothing is wrong with you; check back soon or message us on WhatsApp.',
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      product: 'care_pass',
      version: terms.version,
      terms: terms.terms,
      hash: terms.hash,
      published_at: terms.published_at,
      /* Storage is off, and the page is told so rather than drawing a
         control that the server would refuse. */
      storage_enabled: !!config.storage_enabled,
      currency: 'NGN',
    },
  };
}

async function actionOrder(body, headers) {
  const terms = await publishedTerms('care_pass');
  if (!terms) {
    return {
      status: 503,
      kind: 'not-ready',
      body: { error: 'The Care Pass is not on sale yet — the coverage terms are not published.' },
    };
  }

  const clientRef = String(body.client_ref || '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(clientRef)) {
    return { status: 400, body: { error: 'client_ref must be a uuid the page generates once per order.' } };
  }

  /* A double-tapped Pay button replays the same client_ref and gets
     the SAME order back, rather than a second one and a second charge. */
  const existing = await sb(
    'payments?select=reference,amount_kobo,status,terms_version&client_ref=eq.' +
      encodeURIComponent(clientRef) + '&limit=1',
    { method: 'GET' }
  );
  if (existing && existing[0]) {
    return {
      status: 200,
      body: {
        ok: true,
        replay: true,
        reference: existing[0].reference,
        amount_kobo: existing[0].amount_kobo,
        status: existing[0].status,
        terms: terms.terms,
        version: terms.version,
      },
    };
  }

  const name = String(body.name || '').trim().slice(0, 80);
  const phone = normalizePhone(body.phone);
  if (name.length < 2) return { status: 400, body: { error: 'A Care Pass needs the student\u2019s name.' } };
  if (!phone) return { status: 400, body: { error: 'Enter a Nigerian mobile number — 08031112233 or +2348031112233.' } };

  /* The price is the PUBLISHED TERMS's, never the request's. There is
     no field a caller can send to make this cheaper. */
  const priceKobo = money(terms.terms && terms.terms.price_kobo);
  if (priceKobo === null || priceKobo <= 0) {
    return { status: 503, kind: 'not-ready', body: { error: 'The Care Pass price is not configured.' } };
  }

  const email = String(body.email || '').trim() ||
    (phone + '@receipts.arzuz.com');

  const ref = reference('AZ');
  const subject = {
    name: name,
    phone: phone,
    email: email,
    area: body.area ? String(body.area).slice(0, 80) : null,
    property: body.property ? String(body.property).slice(0, 120) : null,
    room: body.room ? String(body.room).slice(0, 60) : null,
    session: body.session ? String(body.session).slice(0, 20) : null,
  };

  let payment;
  try {
    const out = await sb('payments', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        client_ref: clientRef,
        business_line: 'care',
        purpose: 'care_pass',
        terms_id: terms.id,
        terms_version: terms.version,
        amount_kobo: priceKobo,
        status: 'pending',
        reference: ref,
        provider: 'paystack',
        subject: subject,
        referral_code: body.referral_code ? String(body.referral_code).slice(0, 40) : null,
        env: body.env === 'test' ? 'test' : 'production',
      }),
    });
    payment = Array.isArray(out) ? out[0] : out;
  } catch (err) {
    /* A racing double-submit lost the unique client_ref: return theirs. */
    if (String(err.message || '').includes('duplicate')) {
      const again = await sb('payments?select=reference,amount_kobo,status&client_ref=eq.' + encodeURIComponent(clientRef) + '&limit=1', { method: 'GET' });
      return { status: 200, body: { ok: true, replay: true, reference: again[0].reference, amount_kobo: again[0].amount_kobo, status: again[0].status } };
    }
    throw err;
  }

  const { ready } = payCfg();
  if (!ready) {
    /* The order is recorded; the provider is not configured. This is a
       DEPLOYMENT fact, so the class is not-ready and the page must not
       tell the customer to try again. */
    return {
      status: 503,
      kind: 'not-ready',
      body: {
        error: 'Payments are not switched on for this site yet. Your order is saved — ' +
          'message us on WhatsApp and we will finish it with you.',
        reference: ref,
      },
    };
  }

  const init = await payInit({
    email: email,
    amountKobo: priceKobo,
    reference: ref,
    metadata: { name: name, purpose: 'care_pass', terms_version: terms.version },
  });

  await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ provider_ref: ref, updated_at: new Date().toISOString() }),
  });

  return {
    status: 201,
    body: {
      ok: true,
      reference: ref,
      amount_kobo: priceKobo,
      currency: 'NGN',
      authorization_url: init && init.authorization_url,
      access_code: init && init.access_code,
      version: terms.version,
      message: 'Pay ₦' + Math.round(priceKobo / NAIRA).toLocaleString('en-NG') + ' to open your Care Pass.',
    },
  };
}

/* The status page and the post-payment return both come here. It is
   the ONLY place a browser can learn an order was paid, and it learns
   it from the provider, not from a URL parameter. */
async function actionVerify(body) {
  const ref = String(body.reference || '').trim();
  /* The caller's own capability, read ONCE from the request — the
     response object below is called `out` precisely so it can never be
     mistaken for the thing the caller said. */
  const clientRef = String(body.client_ref || '').trim();
  if (!ref) return { status: 400, body: { error: 'Send the order reference.' } };

  const rows = await sb('payments?select=*&reference=eq.' + encodeURIComponent(ref) + '&limit=1', { method: 'GET' });
  const payment = (rows && rows[0]) || null;
  if (!payment) return { status: 404, kind: 'rejected', body: { error: 'No such order.' } };

  /* Already settled: answer without troubling the provider. The pass is
     reported from the plan that was opened, and the link is released
     only to the browser that bought it. */
  if (payment.activated_at) {
    const coverage = await coverageOf(payment);
    const out = {
      ok: true,
      reference: ref,
      status: payment.status,
      activated: true,
      /* What the receipt says: the amount this order was for, and the
         terms version it was created against — both from the stored
         order, so the page cannot print a version nobody accepted. */
      amount_kobo: payment.amount_kobo,
      terms_version: payment.terms_version,
      receipt_ref: payment.receipt_ref || (coverage && coverage.receipt_ref) || null,
      coverage_end: (coverage && coverage.end) || null,
      coverage: coverage,
    };
    if (sameClientRef(payment, clientRef)) {
      const link = await claimPassLink(payment);
      if (link) out.pass_link = link;
    }
    return { status: 200, body: out };
  }

  if (!payCfg().ready) {
    return { status: 503, kind: 'not-ready', body: { error: 'Payments are not switched on yet.', reference: ref, status: payment.status } };
  }

  let verified = null;
  try {
    verified = await payVerify(payment.provider_ref || ref);
  } catch (err) {
    return { status: 502, body: { error: 'We could not reach the payment provider just now. Your order is ' + ref + '.', reference: ref, status: payment.status } };
  }

  const state = String((verified && verified.status) || '').toLowerCase();
  if (state !== 'success') {
    if (state === 'failed' || state === 'abandoned') {
      await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: state === 'abandoned' ? 'abandoned' : 'failed', updated_at: new Date().toISOString() }),
      });
    }
    /* Pending or failed — the coverage does NOT activate. */
    return { status: 200, body: { ok: true, reference: ref, status: state || 'pending', activated: false } };
  }

  /* The provider took the money — but the AMOUNT must be the order's.
     A mismatch is recorded and refused rather than activated. */
  if (!amountMatches(payment, verified)) {
    await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'failed',
        activation_error: 'amount mismatch: provider ' + (verified && verified.amount) + ' vs order ' + payment.amount_kobo,
        updated_at: new Date().toISOString(),
      }),
    });
    await sendAlert('⚠️ Payment amount mismatch — ' + ref + '\nprovider ' + (verified && verified.amount) + ' vs order ' + payment.amount_kobo);
    return { status: 409, kind: 'rejected', body: { error: 'That payment does not match this order. We have flagged it and will sort it out — do not pay again.', reference: ref } };
  }

  const result = await activate(payment.id, verified, (verified && verified.reference) || ref);
  if (!result.ok && result.reason === 'activation failed') {
    return { status: 202, body: { ok: true, reference: ref, status: 'paid', activated: false, message: 'Payment received. Our team is opening your pass by hand — do not pay again.' } };
  }

  const fresh = result.already !== true;
  const coverage = fresh
    ? {
      plan_status: 'active',
      session: (payment.subject || {}).session || null,
      start: result.coverage_start || null,
      end: result.coverage_end || null,
      call_out_cap: result.call_out_cap != null ? Number(result.call_out_cap) : null,
      receipt_ref: result.receipt_ref || null,
    }
    : await coverageOf(result.payment || payment);

  const out = {
    ok: true,
    reference: ref,
    status: 'paid',
    activated: true,
    amount_kobo: (result.payment && result.payment.amount_kobo) || payment.amount_kobo,
    terms_version: payment.terms_version,
    receipt_ref: (coverage && coverage.receipt_ref) || result.receipt_ref || null,
    coverage_start: result.coverage_start || (coverage && coverage.start) || null,
    coverage_end: result.coverage_end || (coverage && coverage.end) || null,
    call_out_cap: result.call_out_cap != null ? result.call_out_cap : (coverage && coverage.call_out_cap) || null,
    coverage: coverage,
  };

  /* The key to the pass, to the browser that paid — and to nobody else. */
  if (sameClientRef(payment, clientRef)) {
    if (fresh && result.token) {
      await markLinkIssued(payment);
      out.pass_link = { token: result.token, path: '/my-care?t=' + result.token };
    } else {
      const link = await claimPassLink(result.payment || payment);
      if (link) out.pass_link = link;
    }
  }
  return { status: 200, body: out };
}

async function actionStatus(body) {
  const ref = String(body.reference || '').trim();
  if (!ref) return { status: 400, body: { error: 'Send the order reference.' } };
  const rows = await sb('payments?select=reference,status,amount_kobo,receipt_ref,activated_at,created_at,business_line&reference=eq.' + encodeURIComponent(ref) + '&limit=1', { method: 'GET' });
  const p = (rows && rows[0]) || null;
  if (!p) return { status: 404, kind: 'rejected', body: { error: 'No such order.' } };
  /* The pass, so a customer can look their own order up by its
     reference and read the receipt and the coverage window. Never the
     LINK: that is released to the buying browser, not to a reference
     anyone could have overheard in a URL. */
  const coverage = p.activated_at ? await coverageOf(p) : null;
  return {
    status: 200,
    body: {
      ok: true,
      reference: p.reference,
      status: p.status,
      amount_kobo: p.amount_kobo,
      receipt_ref: p.receipt_ref || (coverage && coverage.receipt_ref) || null,
      activated: !!p.activated_at,
      created_at: p.created_at,
      coverage: coverage,
    },
  };
}

/* ---- the team's ---- */

async function actionReport() {
  const [lines, referrals, payments] = await Promise.all([
    sb('business_line_summary?select=*', { method: 'GET' }),
    sb('referral_report?select=*', { method: 'GET' }),
    sb('payments?select=business_line,status,amount_kobo', { method: 'GET' }),
  ]);

  const byLine = {};
  for (const l of lines || []) {
    byLine[l.business_line] = {
      cash_in_kobo: Number(l.cash_in_kobo) || 0,
      cash_out_kobo: Number(l.cash_out_kobo) || 0,
      revenue_kobo: Number(l.revenue_kobo) || 0,
      unearned_added_kobo: Number(l.unearned_added_kobo) || 0,
      unearned_released_kobo: Number(l.unearned_released_kobo) || 0,
      unearned_kobo: (Number(l.unearned_added_kobo) || 0) - (Number(l.unearned_released_kobo) || 0),
      refunds_kobo: Number(l.refunds_kobo) || 0,
      costs_kobo: Number(l.costs_kobo) || 0,
      payable_kobo: Number(l.payable_kobo) || 0,
      contribution_margin_kobo: (Number(l.revenue_kobo) || 0) - (Number(l.costs_kobo) || 0),
    };
  }

  const orders = {};
  for (const p of payments || []) {
    const k = p.business_line + ':' + p.status;
    orders[k] = (orders[k] || 0) + 1;
  }

  return {
    status: 200,
    body: {
      ok: true,
      /* Deliberately explicit: housing revenue is zero BY DESIGN, and a
         report that merely omitted the line could be read as missing. */
      housing: {
        listing_fee_kobo: 0,
        rent_commission_bps: 0,
        revenue_kobo: (byLine.housing && byLine.housing.revenue_kobo) || 0,
      },
      /* Naira for display, kobo for arithmetic — both, from the ledger. */
      lines: byLine,
      referrals: referrals || [],
      orders: orders,
      storage_enabled: false,
    },
  };
}

async function actionPublishTerms(actor, body) {
  const product = String(body.product || 'care_pass');
  const terms = body.terms && typeof body.terms === 'object' ? body.terms : null;
  if (!terms) return { status: 400, body: { error: 'Send the terms object to publish.' } };

  const prev = await sb('product_terms?select=version&product=eq.' + encodeURIComponent(product) + '&order=version.desc&limit=1', { method: 'GET' });
  const version = ((prev && prev[0] && Number(prev[0].version)) || 0) + 1;
  const hash = termsHash(terms);

  /* Unpublish first, so the partial unique index never sees two. */
  await sb('product_terms?product=eq.' + encodeURIComponent(product) + '&published=is.true', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ published: false }),
  });

  const out = await sb('product_terms', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      product: product,
      version: version,
      terms: terms,
      hash: hash,
      published: true,
      published_at: new Date().toISOString(),
      published_by: actor.name,
    }),
  });
  const row = Array.isArray(out) ? out[0] : out;
  return { status: 201, body: { ok: true, product: product, version: version, hash: hash, id: row && row.id } };
}

const CONFIG_KEYS = [
  'care_pass_price_kobo', 'care_call_out_cap', 'care_parts_ceiling_kobo',
  'referral_reward_kobo', 'marketplace_fee_bps', 'storage_enabled',
  'care_term_days', 'care_term_end', 'verification_price_kobo', 'monitoring_price_kobo',
];

async function actionSetConfig(actor, body) {
  const patch = body.config && typeof body.config === 'object' ? body.config : null;
  if (!patch) return { status: 400, body: { error: 'Send a config object of the keys to set.' } };
  const unknown = Object.keys(patch).filter((k) => CONFIG_KEYS.indexOf(k) === -1);
  if (unknown.length) return { status: 400, body: { error: 'Unknown config key(s): ' + unknown.join(', ') } };

  const applied = [];
  for (const key of Object.keys(patch)) {
    await sb('finance_config?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: key, value: patch[key], updated_at: new Date().toISOString(), updated_by: actor.name }),
    });
    applied.push(key);
  }
  await sendAlert('⚙️ Finance config changed by ' + actor.name + '\n' + applied.map((k) => k + ' = ' + JSON.stringify(patch[k])).join('\n'));
  return { status: 200, body: { ok: true, applied: applied } };
}

async function actionRefund(actor, body) {
  const ref = String(body.reference || '').trim();
  if (!ref) return { status: 400, body: { error: 'Send the payment reference to refund.' } };
  const rows = await sb('payments?select=*&reference=eq.' + encodeURIComponent(ref) + '&limit=1', { method: 'GET' });
  const payment = (rows && rows[0]) || null;
  if (!payment) return { status: 404, kind: 'rejected', body: { error: 'No such payment.' } };
  if (payment.status !== 'paid') {
    return { status: 409, body: { error: 'Only a paid order can be refunded (this one is ' + payment.status + ').' } };
  }
  if (!payCfg().ready) return { status: 503, kind: 'not-ready', body: { error: 'Payments are not switched on, so nothing can be refunded here.' } };

  const amount = body.amount_kobo ? kobo(body.amount_kobo) : payment.amount_kobo;
  if (amount === null || amount <= 0 || amount > payment.amount_kobo) {
    return { status: 400, body: { error: 'amount_kobo must be between 1 and the order amount.' } };
  }

  const out = await payRefund({ reference: payment.provider_ref || payment.reference, amountKobo: amount });
  const providerRefundRef = (out && (out.id || out.reference || out.transaction_reference)) || null;

  /* Reversal entries, never an edit: cash back out, refund recorded. */
  await post({
    entry_ref: payment.reference + ':refund:cash',
    business_line: payment.business_line,
    account: 'cash',
    direction: 'credit',
    amount_kobo: amount,
    payment_id: payment.id,
    source: 'refund',
    memo: 'Refund ' + payment.reference + ' by ' + actor.name,
    env: payment.env,
  });
  await post({
    entry_ref: payment.reference + ':refund:obligation',
    business_line: payment.business_line,
    account: 'refund',
    direction: 'debit',
    amount_kobo: amount,
    payment_id: payment.id,
    source: 'refund',
    memo: 'Refund ' + payment.reference + ' by ' + actor.name,
    env: payment.env,
  });

  const full = amount === payment.amount_kobo;
  await sb('payments?id=eq.' + encodeURIComponent(payment.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: full ? 'refunded' : payment.status,
      notes: (payment.notes ? payment.notes + '\n' : '') + 'refund ' + amount + ' kobo by ' + actor.name,
      updated_at: new Date().toISOString(),
    }),
  });

  await sendAlert('↩️ Refund ' + amount + ' kobo on ' + payment.reference + ' by ' + actor.name);
  return { status: 200, body: { ok: true, reference: ref, refunded_kobo: amount, provider_refund_ref: providerRefundRef } };
}

const REFERRAL_STATES = ['under_review', 'approved', 'payout_pending', 'paid', 'rejected', 'reversed'];

async function actionReferralDecide(actor, body) {
  const id = String(body.id || '').trim();
  const status = String(body.status || '').trim();
  if (!id) return { status: 400, body: { error: 'Send the referral id.' } };
  if (REFERRAL_STATES.indexOf(status) === -1) {
    return { status: 400, body: { error: 'status must be one of: ' + REFERRAL_STATES.join(', ') } };
  }
  /* A payout is only 'paid' with a provider's own confirmation — the
     brief's rule, enforced rather than documented. */
  if (status === 'paid' && !String(body.payout_provider_ref || '').trim()) {
    return { status: 400, body: { error: 'A referral is only paid with a payout_provider_ref — the provider must confirm it first.' } };
  }
  await sb('referrals?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: status,
      reason: body.reason ? String(body.reason).slice(0, 400) : null,
      decided_by: actor.name,
      decided_at: new Date().toISOString(),
      paid_at: status === 'paid' ? new Date().toISOString() : null,
      payout_provider_ref: body.payout_provider_ref ? String(body.payout_provider_ref).slice(0, 120) : null,
      updated_at: new Date().toISOString(),
    }),
  });
  return { status: 200, body: { ok: true, id: id, status: status } };
}

/* ------------------------------------------------------------
   handler
   ------------------------------------------------------------ */

exports.handler = async function (event) {
  const headers = event.headers || {};
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') return json(405, { error: 'POST only.' });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {
    return json(400, { error: 'The request body is not valid JSON.' });
  }
  const action = String(body.action || '').toLowerCase();

  if (!cfg().ready) {
    return json(503, { error: 'Payments need SUPABASE_SERVICE_ROLE_KEY in Netlify before they can write anything.' }, 'not-ready');
  }

  /* THE STUDENT'S DOOR — no session, metered per connection. */
  if (PUBLIC_ACTIONS.indexOf(action) !== -1) {
    const ip = (headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    if (limited('finance-ip:' + ip, 40)) {
      return json(429, { error: 'That is a lot of checkout attempts in a minute — wait a moment and try again.' });
    }
    try {
      const out = action === 'terms' ? await actionTerms()
        : action === 'order' ? await actionOrder(body, headers)
          : action === 'verify' ? await actionVerify(body)
            : await actionStatus(body);
      return json(out.status, out.body, out.kind);
    } catch (err) {
      if (ApiErrors.isMissingFunction(err) || (err && err.status === 404)) {
        return json(503, { error: 'Payments are not switched on for this site yet. Message us on WhatsApp and we will sort it out.' }, 'not-ready');
      }
      console.error('[finance] ' + action + ' failed:', err && err.message);
      return json(502, { error: 'We could not complete that just now. Try again in a moment.' });
    }
  }

  /* THE TEAM'S DOOR. */
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const user = await liveUser(token);
  if (!user) return json(401, { error: 'Sign in to the Arzuz dashboard to work with payments.' }, 'expired');

  const role = await roleOf(token);
  /* The books are the finance role's, and this is the second half of
     the split made in supabase-finance.sql section 4 — the policies
     decide what a finance token may READ, this decides what it may
     DO. Support is refused here on purpose: the desk answers students
     and landlords, and "the ninth student's refund" is not a question
     a student asks. A support login keeps the Care ledger and the
     repair queue, both read-only, which is where operations actually
     touches money-shaped data. */
  if (role !== 'admin' && role !== 'finance') {
    console.log('[finance] refused role:', role || '(unknown)');
    return json(403, { error: 'Only the admin and finance logins may open the finance books.' });
  }

  const actor = { id: user.id, name: (user.email || '').split('@')[0] || 'a team member' };

  /* Finance reads; it does not move money. A finance login asking to
     refund is refused HERE, not by a hidden button. */
  const ADMIN_ONLY = ['publish_terms', 'set_config', 'refund', 'referral_decide'];
  if (ADMIN_ONLY.indexOf(action) !== -1 && role !== 'admin') {
    return json(403, { error: 'Only the admin login may change prices, terms, refunds and referral payouts.' });
  }


  if (limited(user.id, 60)) {
    return json(429, { error: 'That is a lot of finance changes in a minute — try again shortly.' });
  }

  try {
    const out = action === 'report' ? await actionReport()
      : action === 'publish_terms' ? await actionPublishTerms(actor, body)
        : action === 'set_config' ? await actionSetConfig(actor, body)
          : action === 'refund' ? await actionRefund(actor, body)
            : action === 'referral_decide' ? await actionReferralDecide(actor, body)
              : null;
    if (!out) {
      return json(400, { error: 'Unknown action. Public: ' + PUBLIC_ACTIONS.join(', ') + '. Team: report, publish_terms, set_config, refund, referral_decide.' });
    }
    return json(out.status, out.body, out.kind);
  } catch (err) {
    console.error('[finance] ' + action + ' failed:', err && err.message);
    const status = err && err.status === 409 ? 409 : 502;
    return json(status, { error: 'The finance books could not record that: ' + ((err && err.message) || 'unknown error') });
  }
};

/* Exported for the Paystack webhook, which verifies the signature and
   then calls this — so activation has exactly one implementation. */
exports.activate = activate;
exports.qualifyReferral = qualifyReferral;
exports.amountMatches = amountMatches;
exports.payVerify = payVerify;
exports.payInit = payInit;
exports.PUBLIC_ACTIONS = PUBLIC_ACTIONS;
exports.ADMIN_ONLY = ['publish_terms', 'set_config', 'refund', 'referral_decide'];
exports.CONFIG_KEYS = CONFIG_KEYS;
exports.REFERRAL_STATES = REFERRAL_STATES;
exports.readConfig = readConfig;
exports.coverageWindow = coverageWindow;
/* The ledger's only door, for the one other writer that must post: a
   completed repair is a cost and a provider payable. Reusing post()
   keeps the append-only rules (unique entry_ref, integer kobo, no
   update path) in one place. */
exports.postLedger = post;
exports.siteOrigin = siteOrigin;
exports.sameClientRef = sameClientRef;
exports.coverageOf = coverageOf;
exports.claimPassLink = claimPassLink;
exports.PASS_LINK_MARK = PASS_LINK_MARK;
exports.canonical = canonical;
exports.termsHash = termsHash;
exports.reference = reference;
