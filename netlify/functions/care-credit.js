/* ============================================================
   Arzuz — Netlify Function: Care credits

   The only writer of care_plans and care_credit_events.

   WHY THIS IS A FUNCTION AND NOT A DASHBOARD WRITE

     Credits are money. supabase-care.sql gives no client role an
     INSERT, UPDATE or DELETE on either table, so the browser cannot
     award itself four call-outs, and a dashboard bug cannot erase a
     line of the ledger. Everything arrives here, where the service
     key lives and where the rules can be enforced in one place:

       grant    open a session: +4 credits, ₦20,000 by default. It is
                also the one action that mints the student's private
                link, which is the only thing that can open the
                student's door below
       spend    one call-out completed: -1 credit, with the worker
                and the parts cost, and it refuses when the balance
                is already zero
       refund   the published pre-session refund: void the balance
       expire   the session ended: void whatever is left
       adjust   a correction, always with a reason — an appended row,
                never an edit, because the ledger has no edit

     A spend is wrapped in a balance check and the write, so the
     common case of "support taps the button twice" cannot take a
     student into negative credits.

   WHO MAY DO IT — TWO DOORS, ONE LEDGER

     The team's door is a Supabase session, checked in two steps for
     the same reason the digest preview checks it: auth.uid() and
     auth.jwt() are things a browser cannot forge, but only Supabase
     can prove a token is live.

       1. /auth/v1/user proves the JWT is a live Supabase session
       2. POST /rest/v1/rpc/arzuz_role returns the role POSTGRES
          computes from that token, so the dashboard cannot claim one

     admin and support may act. Marketing may not: it has no policy
     on a table holding a phone number, and this is one.

     The STUDENT's door is the private link, exactly like a roommate
     profile: the raw token is returned once by a grant and only its
     SHA-256 hash is stored. A student has no Supabase session and
     never will, so 'view' and 'request' are routed BEFORE the role
     gate and are the only actions that answer without one. They are
     strictly weaker than the team's actions on purpose:

       view     read this plan, its balance and its ledger. No write.
       request  file a Support Desk ticket asking for a worker. It
                still cannot move a credit — the ledger is written by
                a grant, a spend, a void or a correction, and every
                one of those belongs to a signed-in team member.

     A token that matches nothing, a token that is too short to be
     one, and a Care table that does not exist yet are three
     different answers, and the student is told which one they got.

   Environment variables: the same as roommate-match.js, which owns
   the Supabase plumbing this file reuses.
     SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
   ============================================================ */

const { sb, cfg, newToken, hashToken, normalizePhone } = require('./roommate-match.js');
const { sendAlert } = require('./notify.js');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

const ALLOWED = ['admin', 'support'];

/* The student's two actions. 'view' reads one plan by its private
   link; 'request' files a Support Desk ticket for one. Neither can
   move a credit — see the header. */
const STUDENT_ACTIONS = ['view', 'request'];

/* What care.html publishes. These are the defaults of the promise,
   not a price list: a plan row stores what was actually paid. */
const SESSION_FEE_NGN = 20000;
const CALL_OUTS_INCLUDED = 4;
const PARTS_INCLUDED_NGN = 3000;

const MAX_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/* The student's door is unauthenticated, so it is metered twice: per
   link, and per connection. Both are per instance and best-effort,
   like every other ceiling in this repo — a fresh instance starts
   empty, which is the right direction for a page a person is looking
   at. 20 a minute per link is a reload loop, not a student. */
const LINK_MAX_PER_MINUTE = 20;
const LINK_MAX_PER_IP = 20;

/* How many open requests one student may hold for one plan. Two is
   already a mistake worth catching: the second tap of a submit
   button must not become a second job for a worker. */
const OPEN_REQUESTS_PER_PLAN = 1;

/* The shared failure vocabulary — the SAME file the pages load, so the
   class in this body is the class assets/my-care.js and assets/admin.js
   will read, not a second guess at the same status code. `kind` is
   passed only where the number alone would be read wrong (see the
   callers below). */
const ApiErrors = require('../../assets/api-errors.js');

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

/* Per-instance and best-effort, exactly like the ceilings in
   notify.js and roommate-digest-preview.js. A fresh instance starts
   empty, which is the right failure direction for a human at a
   dashboard. */
const recent = [];
function limited(key, max, windowMs) {
  const now = Date.now();
  const win = windowMs || WINDOW_MS;
  while (recent.length && now - recent[0].t > win) recent.shift();
  const mine = recent.filter((r) => r.key === key);
  if (mine.length >= (max || MAX_PER_MINUTE)) return true;
  recent.push({ key: key, t: now });
  return false;
}

async function liveUser(token) {
  if (!token || token.length < 20) return null;
  try {
    const res = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (err) {
    console.warn('[care-credit] token check failed:', err && err.message);
    return null;
  }
}

async function roleOf(token) {
  try {
    const res = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/arzuz_role', {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const role = await res.json();
    return typeof role === 'string' ? role.trim().replace(/^"|"$/g, '') : null;
  } catch (err) {
    console.warn('[care-credit] role check failed:', err && err.message);
    return null;
  }
}

/* ------------------------------------------------------------
   The ledger
   ------------------------------------------------------------ */

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function balanceOf(planId) {
  const rows = await sb(
    'care_credit_balance?select=balance,granted,call_outs&plan_id=eq.' + encodeURIComponent(planId),
    { method: 'GET' }
  );
  if (!rows || !rows.length) return { balance: 0, granted: 0, call_outs: 0, known: false };
  return { balance: Number(rows[0].balance) || 0, granted: Number(rows[0].granted) || 0, call_outs: Number(rows[0].call_outs) || 0, known: true };
}

async function append(row) {
  const out = await sb('care_credit_events', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  return Array.isArray(out) ? out[0] : out;
}

/* One plan, by id, for the guard rails below. */
async function planById(id) {
  const rows = await sb('care_plans?select=*&id=eq.' + encodeURIComponent(id) + '&limit=1', { method: 'GET' });
  return (rows && rows[0]) || null;
}

async function setStatus(id, status) {
  await sb('care_plans?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: status, updated_at: new Date().toISOString() }),
  });
}

/* ------------------------------------------------------------
   Actions. Each returns { status, body }.
   ------------------------------------------------------------ */

async function actionGrant(actor, body) {
  const session = String(body.session || process.env.ARZUZ_SESSION || '2026/2027').trim();
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
  if (!payload || !payload.name || !payload.phone) {
    return { status: 400, body: { error: 'A plan needs a student: send payload.name and payload.phone.' } };
  }

  /* The phone number is NORMALISED before it is stored, and that is
     not cosmetic. supabase-care.sql keeps one active plan per student
     per session with a partial unique index on (session, phone) over
     a generated column — so two different spellings of one number
     ('08031112233' and '+234 803 111 2233') are two rows, and the
     index that exists to stop a double sale would not stop one. One
     shape in, one shape stored, one index that holds. */
  const phone = normalizePhone(payload.phone);
  if (!phone) {
    return {
      status: 400,
      body: { error: 'payload.phone must be a Nigerian mobile number — 08031112233 or +2348031112233.' },
    };
  }

  const name = String(payload.name).trim().slice(0, 80);
  if (name.length < 2) {
    return { status: 400, body: { error: 'payload.name needs to be a student\u2019s name.' } };
  }

  const credits = Number.isFinite(Number(body.credits)) && Number(body.credits) > 0
    ? Math.round(Number(body.credits))
    : CALL_OUTS_INCLUDED;
  const amount = money(body.amount_ngn ?? SESSION_FEE_NGN);
  if (amount === null) {
    return { status: 400, body: { error: 'amount_ngn must be a whole number of naira.' } };
  }

  const clean = Object.assign({}, payload, {
    name: name,
    phone: phone,
    area: payload.area ? String(payload.area).trim().slice(0, 80) : undefined,
    property: payload.property ? String(payload.property).trim().slice(0, 120) : undefined,
    room: payload.room ? String(payload.room).trim().slice(0, 60) : undefined,
  });

  const token = newToken();
  let plan;
  try {
    const out = await sb('care_plans', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        token_hash: hashToken(token),
        session: session,
        env: body.env === 'test' ? 'test' : 'production',
        amount_ngn: amount,
        payload: clean,
        source: body.source || null,
        referrer: body.referrer || null,
        notes: body.notes || null,
        status: 'active',
      }),
    });
    plan = Array.isArray(out) ? out[0] : out;
  } catch (err) {
    /* 23505 here is the partial unique index doing its job: this
       student already holds an active plan for this session. Selling
       the same session twice would silently double the call-outs. */
    if (String(err.message || '').includes('duplicate key') || err.status === 409) {
      return {
        status: 409,
        body: {
          error: name + ' already has an active Care plan for ' + session +
            '. Refund or end that one first — a second plan would double the call-outs.',
        },
      };
    }
    throw err;
  }

  await append({
    plan_id: plan.id,
    student_name: name,
    session: session,
    event: 'granted',
    delta: credits,
    reason: body.reason
      ? String(body.reason).slice(0, 400)
      : ('Care for ' + session + ' — ' + credits + ' call-outs, ' + amount + ' naira paid'),
    actor_ref: actor.id,
    actor_name: actor.name,
    env: plan.env,
  });

  return {
    status: 201,
    body: {
      ok: true,
      plan_id: plan.id,
      /* The raw token, once. Only its hash is stored — the same model
         as the roommate profile link. */
      token: token,
      credits: credits,
      balance: credits,
      session: session,
      amount_ngn: amount,
      student_name: name,
      phone: phone,
      /* The team's confirmation needs to say which student and which
         link, and the dashboard is the only place that knows the
         site's own origin — so the origin stays out of here. */
      link_path: '/my-care?t=' + token,
    },
  };
}

async function actionSpend(actor, body) {
  const planId = String(body.plan_id || '').trim();
  if (!planId) return { status: 400, body: { error: 'Send the plan_id the call-out belongs to.' } };

  const plan = await planById(planId);
  /* A plan id that is not there. NOT 'not-ready': retrying this
     identically will 404 identically forever, and the class is what
     stops the page offering to try again. */
  if (!plan) return { status: 404, body: { error: 'No such Care plan.' }, kind: 'rejected' };
  if (plan.status === 'refunded') {
    return { status: 409, body: { error: 'That session was refunded — there is nothing to spend.' } };
  }

  /* Shape before state: a payload that cannot be a call-out is a 400
     whether or not this plan has credits left, so the caller is told
     about the field they got wrong rather than about a balance that
     may not even be the reason they are retrying. Order is: 404 (no
     such plan) → 400 (unusable payload) → 409 (state refuses it).

     No parts is the common case, not a missing field: a bulb, a tap
     washer, a blocked sink. Absent or empty means zero. A value that
     IS sent but is not a number is still refused — that is someone
     typing "about 900", not someone who has nothing to report. */
  const sentParts = body.parts_ngn !== undefined && body.parts_ngn !== null && body.parts_ngn !== '';
  const parts = sentParts ? money(body.parts_ngn) : 0;
  if (parts === null) {
    return { status: 400, body: { error: 'parts_ngn must be a whole number of naira (0 or absent is fine).' } };
  }

  const b = await balanceOf(planId);
  if (b.balance <= 0) {
    return {
      status: 409,
      body: {
        error: 'No call-outs left on this plan (' + b.call_outs + ' of ' + b.granted + ' used). ' +
          'Care covers 4 per session — agree anything further with the student before sending a worker.',
        balance: 0,
        call_outs: b.call_outs,
      },
    };
  }

  await append({
    plan_id: planId,
    student_name: plan.first_name || (plan.payload && plan.payload.name) || null,
    session: plan.session,
    event: 'spent',
    delta: -1,
    worker: body.worker ? String(body.worker).slice(0, 120) : null,
    parts_ngn: parts,
    reason: body.reason ? String(body.reason).slice(0, 400) : null,
    note: parts > PARTS_INCLUDED_NGN
      ? 'Parts over the included ' + PARTS_INCLUDED_NGN + ' naira ceiling — quote the student before the work.'
      : null,
    actor_ref: actor.id,
    actor_name: actor.name,
    env: plan.env,
  });

  const after = await balanceOf(planId);
  return {
    status: 200,
    body: {
      ok: true,
      plan_id: planId,
      balance: after.balance,
      call_outs: after.call_outs,
      granted: after.granted,
      parts_over_ceiling: parts > PARTS_INCLUDED_NGN,
    },
  };
}

/* Refund and expire are the same write with a different story, so
   they share the body and differ only in the event and the status. */
async function voidPlan(actor, body, event, status, defaultReason) {
  const planId = String(body.plan_id || '').trim();
  if (!planId) return { status: 400, body: { error: 'Send the plan_id.' } };

  const plan = await planById(planId);
  /* A plan id that is not there. NOT 'not-ready': retrying this
     identically will 404 identically forever, and the class is what
     stops the page offering to try again. */
  if (!plan) return { status: 404, body: { error: 'No such Care plan.' }, kind: 'rejected' };

  const b = await balanceOf(planId);

  if (event === 'refunded') {
    /* The published promise is "cancel before the session starts for
       a full refund". Once a worker has been sent, the session is no
       longer unstarted — so the rule this enforces is the one the
       page actually supports: a plan that has spent a call-out is
       not refundable in full, and anything else about it is a
       conversation, not a button. */
    if (b.call_outs > 0) {
      return {
        status: 409,
        body: {
          error: 'This plan has already used ' + b.call_outs + ' call-out(s), so it is past the ' +
            'full-refund window on care.html. Raise it with whoever is handling the refund.',
        },
      };
    }
    if (plan.status === 'refunded') {
      return { status: 409, body: { error: 'That plan is already refunded.' } };
    }
  }

  if (b.balance === 0) {
    /* Nothing left to void. Still a status change for 'expired' or
       'refunded' — but no row, because a zero-delta row is not a
       ledger row, it is a comment. */
    if (plan.status !== status) await setStatus(planId, status);
    return { status: 200, body: { ok: true, plan_id: planId, balance: 0, voided: 0, already_empty: true } };
  }

  await append({
    plan_id: planId,
    student_name: plan.first_name || (plan.payload && plan.payload.name) || null,
    session: plan.session,
    event: event,
    delta: -Math.abs(b.balance),
    reason: body.reason ? String(body.reason).slice(0, 400) : defaultReason(b.balance, plan.session),
    actor_ref: actor.id,
    actor_name: actor.name,
    env: plan.env,
  });
  await setStatus(planId, status);

  return {
    status: 200,
    body: { ok: true, plan_id: planId, balance: 0, voided: Math.abs(b.balance) },
  };
}

async function actionAdjust(actor, body) {
  const planId = String(body.plan_id || '').trim();
  const delta = Number(body.delta);
  const reason = body.reason ? String(body.reason).slice(0, 400) : '';
  if (!planId) return { status: 400, body: { error: 'Send the plan_id.' } };
  if (!Number.isInteger(delta) || delta === 0) {
    return { status: 400, body: { error: 'delta must be a non-zero whole number of credits.' } };
  }
  if (!reason) {
    return { status: 400, body: { error: 'A correction needs a reason — it is the only part of the row a human will read.' } };
  }

  const plan = await planById(planId);
  /* A plan id that is not there. NOT 'not-ready': retrying this
     identically will 404 identically forever, and the class is what
     stops the page offering to try again. */
  if (!plan) return { status: 404, body: { error: 'No such Care plan.' }, kind: 'rejected' };

  const b = await balanceOf(planId);
  if (b.balance + delta < 0) {
    return {
      status: 409,
      body: { error: 'That would take the balance below zero (' + b.balance + ' left). A shorter correction can still be made.' },
    };
  }

  await append({
    plan_id: planId,
    student_name: plan.first_name || (plan.payload && plan.payload.name) || null,
    session: plan.session,
    event: 'adjusted',
    delta: delta,
    reason: reason,
    actor_ref: actor.id,
    actor_name: actor.name,
    env: plan.env,
  });

  const after = await balanceOf(planId);
  return { status: 200, body: { ok: true, plan_id: planId, balance: after.balance } };
}

/* ------------------------------------------------------------
   The student's door

   Two actions, and both are weaker than anything the team can do.
   ------------------------------------------------------------ */

/* What a student may see of their own ledger. `actor_ref` is a team
   member's uuid and `actor_name` is their login — internal, and the
   reason this list exists rather than a `select=*`: the row is the
   student's, the person who filed it is not the student's business.
   The projection below is applied to whatever the database returned,
   so a future widening of the SELECT cannot leak a field either. */
const STUDENT_LEDGER_FIELDS = ['event', 'delta', 'created_at', 'worker', 'parts_ngn', 'note', 'reason'];

const LINK_UNKNOWN =
  'We do not recognise that Care link. Open it exactly as it arrived — if you think it is wrong, ' +
  'message us on WhatsApp and we will find your plan.';

async function planByToken(token) {
  const t = String(token || '').trim();
  /* Shorter than the token this file mints (32 random bytes, base64url)
     means it cannot be one, so it is never sent to the database. */
  if (t.length < 20 || t.length > 200) return null;
  const rows = await sb(
    'care_plans?token_hash=eq.' + encodeURIComponent(hashToken(t)) + '&select=*&limit=1',
    { method: 'GET' }
  );
  return (rows && rows[0]) || null;
}

async function ledgerFor(planId) {
  const rows = await sb(
    'care_credit_events?plan_id=eq.' + encodeURIComponent(planId) +
      '&select=' + STUDENT_LEDGER_FIELDS.join(',') + '&order=created_at.asc',
    { method: 'GET' }
  );
  return (Array.isArray(rows) ? rows : []).map(function (row) {
    var out = {};
    STUDENT_LEDGER_FIELDS.forEach(function (k) { if (row[k] !== undefined) out[k] = row[k]; });
    return out;
  });
}

/* A Care table that does not exist is not a 502 and it is not "no
   such link": it is the site being deployed before supabase-care.sql
   was run, which is a temporary state a student should be told about
   honestly. PostgREST answers PGRST205/404 for a table missing from
   its schema cache. */
function isMissingTable(err) {
  const m = String((err && err.message) || '');
  return err && err.status === 404 && /schema cache|does not exist/i.test(m);
}

/* THE TERM, WHEN THE PASS WAS BOUGHT ONLINE.

   A plan opened by the dashboard has no coverage window (the team sets
   the session by hand), so this is null for those and the page keeps
   the wording it always had. A plan opened by a Care Pass purchase
   carries the dates, the cap and the receipt the customer paid for —
   and they are read from the ROW, never computed here: a page that
   added 120 days itself would print a date nobody agreed to. */
function coverageOf(plan) {
  if (!plan || !plan.coverage_start || !plan.coverage_end) return null;
  return {
    start: plan.coverage_start,
    end: plan.coverage_end,
    call_out_cap: plan.call_out_cap != null ? Number(plan.call_out_cap) : null,
    receipt_ref: plan.receipt_ref || null,
    terms_version: plan.terms_version || null
  };
}

function studentPayload(plan, b) {
  const p = plan.payload || {};
  return {
    /* The pass as a term: coverage start and end, the cap it was bought
       with and the receipt. Null when this plan was not bought online. */
    coverage: coverageOf(plan),
    ok: true,
    /* The student's own details, which the request form pre-fills —
       the same trust the roommate link extends to the same person. */
    student: {
      name: p.name || plan.first_name || null,
      phone: p.phone || plan.phone || null,
      area: p.area || null,
      property: p.property || null,
      room: p.room || null,
    },
    plan: {
      id: plan.id,
      session: plan.session,
      status: plan.status,
      amount_ngn: plan.amount_ngn,
      created_at: plan.created_at,
      starts_at: plan.starts_at,
      ends_at: plan.ends_at,
    },
    balance: b.balance,
    granted: b.granted,
    call_outs: b.call_outs,
    /* The published promise, quoted from the server so the page cannot
       drift from care.html the way two hard-coded copies would. */
    published: {
      session_fee_ngn: SESSION_FEE_NGN,
      call_outs_included: CALL_OUTS_INCLUDED,
      parts_included_ngn: PARTS_INCLUDED_NGN,
    },
    /* Whether the request form may be used, decided here rather than
       in the page: a page that hides a button is not a rule. */
    can_request: plan.status === 'active' && b.balance > 0,
  };
}

async function actionView(body) {
  const plan = await planByToken(body.token);
  if (!plan) return { status: 404, body: { error: LINK_UNKNOWN }, kind: 'rejected' };
  const b = await balanceOf(plan.id);
  return {
    status: 200,
    body: Object.assign(studentPayload(plan, b), { events: await ledgerFor(plan.id) }),
  };
}

/* An open request for this plan, if there is one. PostgREST filters
   jsonb with `->>`, so the plan id travels inside the ticket payload
   and this is how a second tap of a submit button is caught. */
async function openRequestsFor(planId) {
  const rows = await sb(
    'support_tickets?select=id,status,created_at&payload->>plan_id=eq.' +
      encodeURIComponent(planId) + '&status=in.(open,in_progress)&limit=2',
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows : [];
}

async function actionRequest(body) {
  const plan = await planByToken(body.token);
  if (!plan) return { status: 404, body: { error: LINK_UNKNOWN }, kind: 'rejected' };

  const b = await balanceOf(plan.id);
  const p = plan.payload || {};

  /* Shape first, then state — the same order the team's spend uses, so
     someone who typed nothing is told about the field, not about a
     balance that may not be the reason. */
  const issue = String(body.issue || '').trim().slice(0, 400);
  if (issue.length < 5) {
    return { status: 400, body: { error: 'Tell us what is broken — a sentence is enough.' } };
  }
  const phone = normalizePhone(body.phone || p.phone);
  if (!phone) {
    return { status: 400, body: { error: 'We need a phone number a worker can reach you on.' } };
  }
  const room = String(body.room || p.room || '').trim().slice(0, 60);

  if (plan.status !== 'active') {
    return {
      status: 409,
      body: {
        error: plan.status === 'refunded'
          ? 'This session was refunded, so there is no Care credit to send a worker on. Message us if that is wrong.'
          : 'This session has ended, so its call-outs are closed. Care for a new session can be bought from care.html.',
      },
    };
  }

  if (b.balance <= 0) {
    return {
      status: 409,
      body: {
        error: 'All ' + b.granted + ' call-outs on this session have been used. Care covers ' +
          CALL_OUTS_INCLUDED + ' per session — tell us anyway and we will quote you before any work.',
        balance: 0,
        call_outs: b.call_outs,
      },
    };
  }

  const open = await openRequestsFor(plan.id);
  if (open.length >= OPEN_REQUESTS_PER_PLAN) {
    return {
      status: 409,
      body: {
        error: 'You already have a request with us for this session — we are on it. Send another only if this is a different problem.',
        ticket_id: open[0].id,
        opened_at: open[0].created_at,
      },
    };
  }

  const ticket = await sb('support_tickets', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    /* `plan_id` inside the payload is what makes this ticket findable
       from the plan; the generated columns beside it (contact_phone,
       category) are what make it findable from the Support Desk. */
    body: JSON.stringify({
      payload: {
        category: 'care',
        plan_id: plan.id,
        name: p.name || plan.first_name || null,
        phone: phone,
        issue: issue,
        room: room || null,
      },
      session: plan.session,
      env: plan.env,
      source: 'my-care.html',
      status: 'open',
      notes: 'Care call-out — plan ' + plan.id + ', ' + b.balance + ' of ' + b.granted +
        ' call-outs left' + (room ? ', room ' + room : '') + '.',
    }),
  });
  const row = Array.isArray(ticket) ? ticket[0] : ticket;

  return {
    status: 201,
    body: {
      ok: true,
      ticket_id: row && row.id,
      balance: b.balance,
      message: 'Logged. A verified worker should reach you within 48 hours on ' + phone +
        ' — one of the ' + CALL_OUTS_INCLUDED + ' call-outs this session covers.',
    },
  };
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

exports.handler = async function (event) {
  const headers = event.headers || {};
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') {
    return json(405, { error: 'POST — the session token goes in the header, never in a URL.' });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return json(400, { error: 'The request body is not valid JSON.' });
  }

  const action = String(body.action || '').toLowerCase();

  if (!cfg().ready) {
    /* A 503 that is a DEPLOYMENT FACT, not a bad minute. The class is
       the whole reason the server speaks: both readings are 503, and
       only this function knows which one a caller is looking at. */
    return json(503, {
      error: 'Care credits need SUPABASE_SERVICE_ROLE_KEY in Netlify before they can write anything.',
    }, 'not-ready');
  }

  /* THE STUDENT'S DOOR. No session, no role — the link is the
     credential, so this branch runs before the gate below and never
     reads the Authorization header at all. Both actions are metered
     twice: per link and per connection, because an unauthenticated
     door is the one that gets hammered. */
  if (STUDENT_ACTIONS.indexOf(action) !== -1) {
    const link = String(body.token || '').trim();
    if (link.length < 20 || link.length > 200) {
      return json(404, { error: LINK_UNKNOWN }, 'rejected');
    }
    const ip = (headers['x-nf-client-connection-ip'] ||
      headers['x-forwarded-for'] ||
      'unknown').split(',')[0].trim();
    const key = hashToken(link);
    if (limited('care-link:' + key, LINK_MAX_PER_MINUTE) || limited('care-link-ip:' + ip, LINK_MAX_PER_IP)) {
      return json(429, { error: 'That is a lot of Care requests in a minute — try again shortly.' });
    }
    try {
      const out = action === 'view' ? await actionView(body) : await actionRequest(body);
      return json(out.status, out.body, out.kind);
    } catch (err) {
      if (isMissingTable(err)) {
        console.error('[care-credit] ' + action + ': Care tables are missing');
        return json(503, {
          error: 'Care is not switched on for this site yet. Nothing is wrong with your link — ' +
            'message us on WhatsApp and we will sort it out.',
        }, 'not-ready');
      }
      /* The key is PRESENT and Supabase refuses it — see the flag in
         sb(). A different fact from the missing table above and the
         same answer, deliberately: what a student needs to hear is
         identical (their link is fine, the site is not switched on,
         there is nothing to retry), and which of the two it is is the
         operator's business, not theirs. So the distinction goes to
         the log and the alert, where someone can act on it. */
      if (err && err.credentialRefused) {
        console.error('[care-credit] Supabase refused the credential this deploy holds (' + err.status + ') on ' + action);
        if (!limited('care-credential-refused', 1)) {
          await sendAlert('\u26a0\ufe0f Care cannot reach Supabase: the service key this deploy holds was refused on ' +
            action + '. Check SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL in Netlify, then redeploy — a variable added ' +
            'without a deploy is not in the running function.');
        }
        return json(503, {
          error: 'Care is not switched on for this site yet. Nothing is wrong with your link — ' +
            'message us on WhatsApp and we will sort it out.',
        }, 'not-ready');
      }
      console.error('[care-credit] ' + action + ' failed:', err && err.message);
      return json(502, { error: 'We could not open your Care account just now. Try again in a moment.' });
    }
  }

  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  const user = await liveUser(token);
  if (!user) {
    return json(401, { error: 'Sign in to the Arzuz dashboard to work with Care credits.' }, 'expired');
  }

  const role = await roleOf(token);
  if (ALLOWED.indexOf(role) === -1) {
    console.log('[care-credit] refused role:', role || '(unknown)');
    return json(403, { error: 'Only the admin and support logins may record Care credits.' });
  }

  if (limited(user.id)) {
    return json(429, { error: 'That is a lot of Care changes in a minute — try again shortly.' });
  }

  const actor = {
    id: user.id,
    name: (user.email || '').split('@')[0] || 'a team member',
  };

  try {
    let out;
    if (action === 'grant') {
      out = await actionGrant(actor, body);
    } else if (action === 'spend') {
      out = await actionSpend(actor, body);
    } else if (action === 'refund') {
      out = await voidPlan(actor, body, 'refunded', 'refunded',
        (n) => 'Refunded before the session started — ' + n + ' unused call-outs voided with the fee');
    } else if (action === 'expire') {
      out = await voidPlan(actor, body, 'expired', 'ended',
        (n, s) => 'Session ' + s + ' ended with ' + n + ' call-outs unused');
    } else if (action === 'adjust') {
      out = await actionAdjust(actor, body);
    } else {
      return json(400, {
        error: 'Unknown action. The team\u2019s are: grant, spend, refund, expire, adjust ' +
          '(the student\u2019s two — view and request — take a link, not a session).',
      });
    }
    return json(out.status, out.body, out.kind);
  } catch (err) {
    /* A rejected write is a fact about the request, not a reason to
       page anyone: the dashboard shows it to the person who asked.
       Nothing here touches Telegram at all. */
    console.error('[care-credit] ' + action + ' failed:', err && err.message);
    const status = err && err.status === 409 ? 409 : 502;
    return json(status, { error: 'Care could not record that: ' + ((err && err.message) || 'unknown error') });
  }
};

exports.ALLOWED = ALLOWED;
exports.STUDENT_ACTIONS = STUDENT_ACTIONS;
exports.LINK_MAX_PER_MINUTE = LINK_MAX_PER_MINUTE;
exports.OPEN_REQUESTS_PER_PLAN = OPEN_REQUESTS_PER_PLAN;
exports.LINK_UNKNOWN = LINK_UNKNOWN;
exports.STUDENT_LEDGER_FIELDS = STUDENT_LEDGER_FIELDS;
exports.planByToken = planByToken;
exports.coverageOf = coverageOf;
exports.ledgerFor = ledgerFor;
exports.isMissingTable = isMissingTable;
exports.SESSION_FEE_NGN = SESSION_FEE_NGN;
exports.CALL_OUTS_INCLUDED = CALL_OUTS_INCLUDED;
exports.PARTS_INCLUDED_NGN = PARTS_INCLUDED_NGN;
exports.MAX_PER_MINUTE = MAX_PER_MINUTE;
exports.liveUser = liveUser;
exports.roleOf = roleOf;
exports.balanceOf = balanceOf;
