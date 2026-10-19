/* ============================================================
   Arzuz — Netlify Function: repair claims

   WHAT THIS OWNS
     One job asked for against one Care Pass: filing it, the coverage
     decision, the call-out it spends, the worker, the money, the
     customer's confirmation and any dispute. supabase-claims.sql is
     the schema; this is the only writer of it.

   THE RULES THIS FILE IS BUILT TO KEEP

     1. COVERAGE IS DECIDED HERE, NOT BY THE PAGE. A student can ask;
        only an admin can answer. The answer is recorded with a reason
        in words, because a refusal without one is the complaint that
        follows.

     2. THE ALLOWANCE IS SPENT ATOMICALLY. Approval calls
        claim_reserve_callout(), which locks the pass and reads the
        credit ledger's own sum. Two claims approved at the same moment
        for the last call-out: one is approved, the other is told the
        pass has nothing left. Nothing here reads a balance and then
        writes one.

     3. A WORKER'S WORD IS NOT A FINISHED JOB. Reporting the work moves
        a claim to 'awaiting_customer'. It is completed by the
        customer's confirmation, or by a named resolution on a dispute
        — the schema refuses any other exit.

     4. A CALL-OUT THAT IS GIVEN BACK IS GIVEN BACK ON THE LEDGER.
        Cancelling, refusing or resolving a reserved claim away appends
        a 'released' row through the same kind of function that took it.

     5. THE MONEY IS POSTED, NOT TYPED. A repair cost is a ledger
        entry (expense + provider payable) whose entry_ref derives from
        the claim — a retry cannot double-post it.

     6. SUPPORT COORDINATES; THE ADMIN MOVES MONEY. Support may read,
        assign a worker and record progress. Deciding eligibility,
        reporting the cost and closing a dispute are the admin's.

   Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
   ============================================================ */

const { sb, cfg, normalizePhone } = require('./roommate-match.js');
const { liveUser, roleOf, planByToken, coverageOf } = require('./care-credit.js');
const { postLedger } = require('./finance.js');
const { sendAlert, sendEmail, mailDeliverable } = require('./notify.js');
const { sendText } = require('./whatsapp-send.js');

const ApiErrors = require('../../assets/api-errors.js');

const NAIRA = 100;

/* The statuses the schema names, and the ones a PROVIDER-side event can
   move to. Kept here so the router and the messages cannot drift from
   the CHECK in supabase-claims.sql. */
const STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'assigned',
  'in_progress', 'awaiting_customer', 'completed', 'rejected', 'cancelled', 'disputed'];

/* Which statuses a student may still withdraw from. A worker already on
   the job is not a cancellation — that is a dispute. */
const CANCELLABLE = ['draft', 'submitted', 'under_review', 'approved', 'assigned'];

/* ------------------------------------------------------------
   THE AGING CLOCK — how long each status is allowed to stand

   A queue ordered oldest-first tells you what arrived first; it does
   not tell you what is late. This is the second question, and the
   answer is per status, because the statuses are not equivalent: a
   dispute is somebody angry and waiting, a customer who has not
   replied is not our fault, and a draft is the student's own
   unfinished form — putting a draft on the clock would page the team
   about a page nobody has sent.

   `who` is the honest part: it says whose move it is, so an overdue
   claim is not silently read as "the team dropped it" when the team is
   in fact waiting on a person. It also decides which clock the
   scheduled nudge shouts about: ours, or the customer's.

   THE BALL IS NOT THE SAME FOR EVERY STATUS:
     ours      the team owes somebody an answer or a push
     customer   we have asked and are waiting; the nudge is a reminder
                to chase, not a failure to act
   ------------------------------------------------------------ */
/* THE HANDOVER'S HIDDEN SECOND HALF, in hours.

   The ASK goes out when a claim crosses its 'assigned' deadline (see
   CLOCK.assigned) with nobody having answered the handover — the same
   moment the team is nudged, because a job nobody has accepted is not a
   job that is moving. The job then comes BACK this many hours later if
   the ask is still unanswered. Two definitions in one place, so the
   clock, the queue and the harness cannot drift. */
const HANDOVER = { reclaim_after_hours: 24 };

const CLOCK = {
  submitted:         { hours: 24,  who: 'ours',     says: 'decide coverage' },
  under_review:      { hours: 24,  who: 'ours',     says: 'decide coverage' },
  approved:          { hours: 24,  who: 'ours',     says: 'name a worker' },
  assigned:          { hours: 48,  who: 'ours',     says: 'get the work reported' },
  in_progress:       { hours: 48,  who: 'ours',     says: 'get the work reported' },
  disputed:          { hours: 24,  who: 'ours',     says: 'close the dispute' },
  awaiting_customer: { hours: 168, who: 'customer', says: 'hear back from the customer' },
};

const HOUR_MS = 60 * 60 * 1000;

/* Actions only the admin login may take: eligibility, money, and
   closing a dispute by name. */
const ADMIN_ONLY = ['decide', 'report_work', 'resolve', 'settle_payout', 'post_cost'];

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

function reference() {
  const crypto = require('node:crypto');
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(3).toString('hex').toUpperCase();
  return 'AZ-C-' + t + '-' + r;
}

function kobo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

function missingTable(err) {
  const m = String((err && err.message) || '');
  return err && (err.status === 404 || /schema cache|does not exist|Could not find the table/i.test(m));
}

/* ------------------------------------------------------------
   reading and writing a claim
   ------------------------------------------------------------ */

async function claimById(id) {
  const rows = await sb('repair_claims?select=*&id=eq.' + encodeURIComponent(id) + '&limit=1', { method: 'GET' });
  return (rows && rows[0]) || null;
}

/* The pass a claim belongs to, for the session and the student's name
   the credit ledger snapshots onto every reservation. Read from the
   plan row rather than trusted to the request: a caller does not get
   to say which pass a claim spends. */
async function planById(id) {
  const rows = await sb('care_plans?select=*&id=eq.' + encodeURIComponent(id) + '&limit=1', { method: 'GET' });
  return (rows && rows[0]) || null;
}

async function claimsForPlan(planId) {
  const rows = await sb(
    'repair_claims?select=*&plan_id=eq.' + encodeURIComponent(planId) + '&order=created_at.desc&limit=50',
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows : [];
}

/* The audit trail is append-only and EVERY transition writes to it, so
   the answer to "who refused this, and why" is a row rather than a
   conversation somebody remembers. */
async function trail(claim, event, to, opts = {}) {
  try {
    await sb('claim_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        claim_id: claim.id,
        reference: claim.reference,
        from_status: opts.from || claim.status || null,
        to_status: to,
        event: event,
        reason: opts.reason ? String(opts.reason).slice(0, 800) : null,
        data: opts.data || null,
        actor_ref: opts.actor_ref || null,
        actor_name: opts.actor_name || null,
        actor_role: opts.actor_role || null,
        env: claim.env || 'production',
      }),
    });
  } catch (err) {
    /* A trail that cannot be written must not silently pass: the
       transition is refused, because an unaudited money change is worse
       than a failed one. */
    console.error('[claims] could not write the trail:', err && err.message);
    throw err;
  }
}

async function patch(id, patchBody) {
  const out = await sb('repair_claims?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patchBody)),
  });
  return Array.isArray(out) ? out[0] : out;
}

/* The answers that mean the job is NOT with this worker any more: they
   said no, or nobody ever heard from them and the clock took it back.
   Both keep the name, the number and the words on the row — that is what
   the OPERATOR reads — and neither is a worker who is coming. */
const NOT_ON_THE_JOB = ['declined', 'unanswered'];

/* What a student is allowed to see of their own claim. The team's
   notes, the actor references and the internal evidence list are not
   theirs — and are not sent, rather than hidden by the page. */
function studentClaim(row) {
  /* A worker who has said NO is not a worker who is coming. The row keeps
     the name, the number and their own words — that is what the OPERATOR
     reads to know who was asked and what they said — but a student who
     was told "Musa Ibrahim is coming" and then reads the same name on a
     page after he has turned the job down has been left waiting for a
     knock that is not coming. So the live handover is decided HERE, the
     way the rest of this file decides what a student may see: sent or
     not sent, never rendered and then hidden by the page. */
  const workerLive = !!row.provider_name && NOT_ON_THE_JOB.indexOf(row.provider_answer) === -1;
  return {
    id: row.id,
    reference: row.reference,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    issue: row.issue,
    photos: row.photos || [],
    property: row.property || null,
    room: row.room || null,
    eligibility: row.eligibility || null,
    eligibility_reason: row.eligibility_reason || null,
    call_out_no: row.call_out_no || null,
    provider_name: workerLive ? row.provider_name : null,
    provider_phone: workerLive ? (row.provider_phone || null) : null,
    /* Whether the person named has replied that the job is theirs. The
       page prints this as a reassurance beside the name — "they have
       confirmed" — and never as a status of its own: the claim's status
       is the queue's word, not the worker's. */
    worker_confirmed: row.provider_answer === 'accepted',
    /* THE DAY THEY OFFERED, in their own words. A worker handed a job
       often answers with a time instead of a yes ("I can do Saturday
       morning"), and the customer was told a worker is coming with no
       idea when they had suggested — so the customer reads this.

       Their words, not a computed date, and that is deliberate: turning
       "tomorrow morning" into an instant means guessing a timezone and
       which morning, and then printing a GUESSED APPOINTMENT as fact. */
    provider_proposal: workerLive ? (row.provider_proposal || null) : null,
    provider_proposed_at: workerLive ? (row.provider_proposed_at || null) : null,
    /* AND THE CUSTOMER'S OWN SIDE OF THAT CONVERSATION: the day they
       agreed to, and the day they suggested instead. Both are sent even
       with no worker live, unlike the worker's — a person's own words are
       theirs to read back, and "you asked for Sunday" is not the name of
       somebody who is not coming. */
    day_agreed_at: workerLive ? (row.day_agreed_at || null) : null,
    customer_proposal: row.customer_proposal || null,
    customer_proposed_at: row.customer_proposed_at || null,
    estimate_kobo: row.estimate_kobo === null || row.estimate_kobo === undefined ? null : Number(row.estimate_kobo),
    actual_kobo: row.actual_kobo === null || row.actual_kobo === undefined ? null : Number(row.actual_kobo),
    parts: row.parts || [],
    payout_settled: row.payout_settled || null,
    customer_confirmed_at: row.customer_confirmed_at || null,
    disputed_at: row.disputed_at || null,
    dispute_reason: row.dispute_reason || null,
    resolution: row.resolution || null,
    resolved_at: row.resolved_at || null,
  };
}

/* ------------------------------------------------------------
   THE STUDENT'S DOOR — the pass link is the credential
   ------------------------------------------------------------ */

const STUDENT_ACTIONS = ['list', 'create', 'confirm', 'dispute', 'cancel', 'agree_day', 'propose_day'];

async function planFromToken(body) {
  const plan = await planByToken(body.token);
  return plan || null;
}

async function actionList(plan) {
  const rows = await claimsForPlan(plan.id);
  return {
    status: 200,
    body: {
      ok: true,
      coverage: coverageOf(plan),
      plan: { session: plan.session, status: plan.status },
      claims: rows.map(studentClaim),
    },
  };
}

async function actionCreate(plan, body) {
  const issue = String(body.issue || '').trim().slice(0, 400);
  if (issue.length < 5) {
    return { status: 400, body: { error: 'Tell us what is broken — a sentence is enough.' } };
  }
  if (plan.status !== 'active') {
    return {
      status: 409,
      body: {
        error: plan.status === 'refunded'
          ? 'This pass was refunded, so there is nothing to claim on it. Message us if that is wrong.'
          : 'This pass has closed, so its coverage has ended. A new pass can be bought from care-pass.',
      },
    };
  }
  const coverage = coverageOf(plan);
  if (coverage && coverage.end && new Date(coverage.end) < new Date()) {
    return {
      status: 409,
      body: {
        error: 'Coverage on this pass ended on ' + String(coverage.end).slice(0, 10) +
          ', so a new claim cannot be opened against it. Message us if the fault started before that date.',
      },
    };
  }

  const p = plan.payload || {};
  const phone = normalizePhone(body.phone || p.phone);
  if (!phone) return { status: 400, body: { error: 'We need a number a worker can reach you on.' } };

  /* The photos are URLs the media step already uploaded — the page
     never sends a file here, and a claim is not a upload endpoint. */
  const photos = Array.isArray(body.photos)
    ? body.photos.filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 6)
    : [];

  const row = await sb('repair_claims', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      reference: reference(),
      plan_id: plan.id,
      payment_id: plan.payment_id || null,
      env: plan.env || 'production',
      status: 'submitted',
      student_name: p.name || null,
      student_phone: phone,
      property: String(body.property || p.property || '').slice(0, 120) || null,
      room: String(body.room || p.room || '').slice(0, 60) || null,
      issue: issue,
      photos: photos,
    }),
  });
  const claim = Array.isArray(row) ? row[0] : row;

  await trail(claim, 'filed', 'submitted', {
    from: null,
    reason: 'The student filed a claim from their pass link.',
    actor_name: p.name || 'the student',
    actor_role: 'student',
  });

  /* Somebody must see it: a claim nobody reads is the complaint. */
  await sendAlert(
    '🛠️ New repair claim\n' + claim.reference + ' — ' + (p.name || 'a student') + ' · ' + phone +
    '\n' + issue.slice(0, 200) +
    '\nPass ' + (plan.session || '') + ' · ' + (coverage ? coverage.call_out_cap + ' call-outs, ends ' +
      String(coverage.end).slice(0, 10) : 'no published window')
  );

  return { status: 201, body: { ok: true, claim: studentClaim(claim) } };
}

async function actionConfirm(plan, body) {
  const claim = await claimById(body.id);
  if (!claim || claim.plan_id !== plan.id) {
    return { status: 404, kind: 'rejected', body: { error: 'That claim is not on this pass.' } };
  }
  if (claim.status !== 'awaiting_customer') {
    return {
      status: 409,
      body: {
        error: claim.status === 'completed'
          ? 'This claim is already finished.'
          : 'That claim is not waiting for your confirmation yet (' + claim.status + ').',
      },
    };
  }
  const at = new Date().toISOString();
  await patch(claim.id, {
    status: 'completed',
    customer_confirmed_at: at,
    customer_note: body.note ? String(body.note).slice(0, 400) : null,
  });
  await trail(claim, 'customer_confirmed', 'completed', {
    reason: body.note ? String(body.note).slice(0, 400) : 'The customer confirmed the work.',
    actor_name: (plan.payload || {}).name || 'the student',
    actor_role: 'student',
  });
  return { status: 200, body: { ok: true, claim: studentClaim(Object.assign({}, claim, { status: 'completed', customer_confirmed_at: at })) } };
}

async function actionDispute(plan, body) {
  const claim = await claimById(body.id);
  if (!claim || claim.plan_id !== plan.id) {
    return { status: 404, kind: 'rejected', body: { error: 'That claim is not on this pass.' } };
  }
  const reason = String(body.reason || '').trim().slice(0, 400);
  if (reason.length < 5) {
    return { status: 400, body: { error: 'Say what is wrong with the work — a sentence is enough.' } };
  }
  if (['draft', 'submitted', 'under_review', 'cancelled'].indexOf(claim.status) !== -1) {
    return {
      status: 409,
      body: {
        error: claim.status === 'cancelled'
          ? 'That claim was cancelled, so there is nothing to dispute. File a new one or message us.'
          : 'Nothing has been done on this claim yet, so there is nothing to dispute — it is still with us.',
      },
    };
  }
  const at = new Date().toISOString();
  await patch(claim.id, { status: 'disputed', disputed_at: at, dispute_reason: reason });
  await trail(claim, 'disputed', 'disputed', {
    reason: reason,
    actor_name: (plan.payload || {}).name || 'the student',
    actor_role: 'student',
  });
  await sendAlert('⚠️ A repair claim is disputed\n' + claim.reference + ' — ' + (plan.payload || {}).name +
    '\n' + reason);
  return { status: 200, body: { ok: true, claim: studentClaim(Object.assign({}, claim, { status: 'disputed', disputed_at: at, dispute_reason: reason })) } };
}

async function actionCancel(plan, body) {
  const claim = await claimById(body.id);
  if (!claim || claim.plan_id !== plan.id) {
    return { status: 404, kind: 'rejected', body: { error: 'That claim is not on this pass.' } };
  }
  if (CANCELLABLE.indexOf(claim.status) === -1) {
    return {
      status: 409,
      body: {
        error: claim.status === 'in_progress'
          ? 'A worker is already on this job. Dispute it instead and we will sort it out with you.'
          : 'A claim that is ' + claim.status + ' cannot be withdrawn.',
      },
    };
  }

  /* A call-out that was committed to this claim goes back on the
     ledger, through the same kind of function that took it. */
  let released = false;
  if (claim.call_out_no) {
    released = await releaseCallout(plan, claim, 'withdrawn by the student', 'the student');
  }
  await patch(claim.id, { status: 'cancelled', resolved_at: new Date().toISOString(), resolution: 'withdrawn by the student' });
  await trail(claim, 'cancelled', 'cancelled', {
    reason: 'The student withdrew the claim.',
    data: { released: released },
    actor_name: (plan.payload || {}).name || 'the student',
    actor_role: 'student',
  });
  return { status: 200, body: { ok: true, released: released } };
}

/* ------------------------------------------------------------
   THE CUSTOMER'S ANSWER TO A DAY, from their own pass link

   A day a worker offers is a QUESTION, and the one person who can answer
   it is the tenant who has to be in when they come. Until this door the
   answer travelled as a phone call to the office — or did not travel, and
   the worker turned up to a gate nobody opened. Two answers, and the
   record keeps which one it was:

     agree_day    yes. The WORKER is told the visit is on, because they
                  are the one who has to turn up, and the agreement is
                  the instant alone: there is nothing to re-word, since
                  the day being agreed to is the worker's own sentence.
     propose_day  "not Saturday — Sunday afternoon", in the CUSTOMER's own
                  words, passed to the worker with the tenant's number,
                  and left on the trail. The day that was answered stays
                  on the row: it is what this is an answer to.

   Neither moves the claim and neither touches money. The link is the
   credential here exactly as it is everywhere else in this door, and a
   claim is only reachable through the pass it was filed against.
   ------------------------------------------------------------ */

/* The claim this pass may act on, or a refusal in the student's words.
   One place, because every action below asks the same question and a
   second copy of it is how one of them ends up asking something else. */
async function studentClaimOr(plan, body) {
  const claim = await claimById(body.id);
  if (!claim || claim.plan_id !== plan.id) {
    return { error: { status: 404, kind: 'rejected', body: { error: 'That claim is not on this pass.' } } };
  }
  return { claim: claim };
}

/* Is there a live worker to talk to about a day? A day is only ever
   something the two people who have to meet discuss, so with nobody named
   there is nothing to agree and nobody to pass anything to. */
function workerToTalkTo(claim) {
  if (!claim.provider_name || NOT_ON_THE_JOB.indexOf(claim.provider_answer) !== -1) {
    return 'Nobody is named on this repair yet, so there is no day to talk about. We message you '
      + 'the moment somebody is coming.';
  }
  return null;
}

async function actionAgreeDay(plan, body) {
  const found = await studentClaimOr(plan, body);
  if (found.error) return found.error;
  const claim = found.claim;

  const nobody = workerToTalkTo(claim);
  if (nobody) return { status: 409, body: { error: nobody } };
  if (!claim.provider_proposal) {
    return {
      status: 409,
      body: {
        error: 'The worker on this repair has not suggested a day yet. When they do, it appears '
          + 'here and you can agree it in one tap.',
      },
    };
  }
  /* Already agreed is not an error: the student tapped twice, or came back
     to a page they had already answered. Saying so is the honest reply,
     and it sends nothing a second time. */
  if (claim.day_agreed_at) {
    return {
      status: 200,
      body: { ok: true, already: true, agreed: claim.provider_proposal, claim: studentClaim(claim) },
    };
  }

  const at = new Date().toISOString();
  await patch(claim.id, { day_agreed_at: at });
  const agreed = Object.assign({}, claim, { day_agreed_at: at });
  await trail(agreed, 'day_agreed', claim.status, {
    reason: 'The customer agreed the day the worker suggested: "' + claim.provider_proposal + '".',
    actor_name: (plan.payload || {}).name || 'the student',
    actor_role: 'student',
  });

  /* The worker, because they are the person who has to turn up. A notice
     that did not arrive pages the team, the same way every other notice
     does — the customer has just confirmed a visit that nobody told the
     worker about. */
  const told = await tryNotify(agreed, plan, 'day_agreed', { worker: workerDayAgreedCopy(agreed) });

  return {
    status: 200,
    body: {
      ok: true, agreed: claim.provider_proposal,
      worker_told: told.channels, claim: studentClaim(agreed),
    },
  };
}

async function actionProposeDay(plan, body) {
  const found = await studentClaimOr(plan, body);
  if (found.error) return found.error;
  const claim = found.claim;

  const when = String(body.when || '').trim().slice(0, 200);
  if (when.length < 5) {
    return { status: 400, body: { error: 'Say when would suit you \u2014 a day and a part of the day is enough.' } };
  }
  const nobody = workerToTalkTo(claim);
  if (nobody) return { status: 409, body: { error: nobody } };
  if (['cancelled', 'rejected', 'completed'].indexOf(claim.status) !== -1) {
    return {
      status: 409,
      body: {
        error: claim.status === 'completed'
          ? 'This repair is finished, so there is no visit to move. Message us if something is wrong with it.'
          : 'This claim is closed, so there is no visit to move. File a new repair and we will arrange it.',
      },
    };
  }

  const at = new Date().toISOString();
  await patch(claim.id, { customer_proposal: when, customer_proposed_at: at });
  const moved = Object.assign({}, claim, { customer_proposal: when, customer_proposed_at: at });
  await trail(moved, 'day_proposed', claim.status, {
    reason: 'The customer answered with a day of their own: "' + when + '"' +
      (claim.provider_proposal ? ' (the worker had suggested "' + claim.provider_proposal + '")' : '') + '.',
    actor_name: (plan.payload || {}).name || 'the student',
    actor_role: 'student',
  });

  const told = await tryNotify(moved, plan, 'day_proposed', { worker: workerDayMovedCopy(moved) });

  /* AND THE TEAM, ON EVERY ONE OF THESE — which is where it differs from
     the agreement above, and deliberately. "That day works" needs nobody:
     the worker is told, the visit is on, nothing is left in the air. A
     MOVED day is a plan a third party is holding a stale belief about:
     the office thinks a visit is happening on the day the worker named,
     the two of them are now settling a different one between themselves,
     and the person who finds out it never got settled should not be the
     worker standing at a gate. One line, in the same class as "a worker
     turned a job down" — a human has to be able to see it without
     opening a dashboard. */
  const paged = await sendAlert(
    '\u23f0 A visit day moved and is being settled between them\n' + moved.reference + '\n' +
    (moved.provider_name || 'the worker') + ' suggested: "' +
      String(moved.provider_proposal || '').slice(0, 120) + '"\n' +
    'The customer said: "' + when.slice(0, 160) + '"\n' +
    'Both of them have each other\u2019s number and the job is still theirs \u2014 nothing was ' +
    're-assigned, no call-out moved, and no new day is booked until they agree one. Ring either ' +
    'of them if it goes quiet.\n' +
    'Customer: ' + firstName(moved.student_name) + ' \u00b7 ' +
      (moved.student_phone || 'no number') +
    '\nWorker: ' + (moved.provider_name || '\u2014') + ' \u00b7 ' +
      (moved.provider_phone || 'no number') + '\n' +
    'Claim: ' + moved.status + ' \u00b7 filed on the pass ' + moved.plan_id
  );

  return {
    status: 200,
    body: {
      ok: true, suggested: when, worker_told: told.channels,
      /* Whether the page reached the team. Reported rather than assumed:
         a phone that never buzzed is a fact the operator can act on, and
         the delivery itself is recorded on the trail by tryNotify() —
         this is about the alert, which has no trail row of its own. */
      team_paged: paged, claim: studentClaim(moved),
    },
  };
}

/* ------------------------------------------------------------
   the two RPCs the schema owns
   ------------------------------------------------------------ */

/* Take one call-out, atomically, or be told there is none left. */
async function reserveCallout(plan, claim, actorName, env) {
  const out = await sb('rpc/claim_reserve_callout', {
    method: 'POST',
    body: JSON.stringify({
      p_plan_id: plan.id,
      p_claim_ref: claim.reference,
      p_session: plan.session,
      p_name: (plan.payload || {}).name || null,
      p_actor: actorName,
      p_env: env || plan.env || 'production',
    }),
  });
  const value = Array.isArray(out) ? out[0] : out;
  const n = typeof value === 'object' && value !== null ? (value.claim_reserve_callout || value) : value;
  const no = Number(n);
  return Number.isFinite(no) && no > 0 ? no : null;
}

async function releaseCallout(plan, claim, reason, actorName) {
  const out = await sb('rpc/claim_release_callout', {
    method: 'POST',
    body: JSON.stringify({
      p_plan_id: plan.id,
      p_claim_ref: claim.reference,
      p_session: plan.session,
      p_name: (plan.payload || {}).name || null,
      p_reason: reason || null,
      p_actor: actorName,
      p_env: claim.env || plan.env || 'production',
    }),
  });
  const value = Array.isArray(out) ? out[0] : out;
  const flag = typeof value === 'object' && value !== null
    ? (value.claim_release_callout !== undefined ? value.claim_release_callout : value) : value;
  return flag === true || flag === 't' || flag === 1;
}

/* ------------------------------------------------------------
   THE TEAM'S DOOR
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   how long a claim has been where it is

   Read from the TRAIL, not from updated_at. updated_at moves for a
   re-assignment, a note, a re-decide — any touch — so a clock built on
   it would reset every time somebody looked busy, which is exactly the
   failure an aging clock exists to prevent. The trail's own row is when
   the status actually changed: the last event that landed on it.

   Returns null for a status with no clock (a draft, or anything
   finished), so "not on the clock" is a value rather than a guess.
   ------------------------------------------------------------ */
function agingOf(claim, statusSince, now) {
  const spec = CLOCK[claim.status];
  if (!spec) return null;
  const since = statusSince ? new Date(statusSince) : new Date(claim.updated_at || claim.created_at || now);
  const at = now ? new Date(now) : new Date();
  const elapsed = Math.max(0, at.getTime() - since.getTime());
  const due = new Date(since.getTime() + spec.hours * HOUR_MS);
  const hoursLeft = (due.getTime() - at.getTime()) / HOUR_MS;
  return {
    who: spec.who,
    says: spec.says,
    limit_hours: spec.hours,
    status_since: since.toISOString(),
    deadline_at: due.toISOString(),
    hours_in_status: Math.round((elapsed / HOUR_MS) * 10) / 10,
    days_in_status: Math.floor(elapsed / (24 * HOUR_MS)),
    hours_left: Math.round(hoursLeft * 10) / 10,
    overdue: hoursLeft < 0,
    hours_over: hoursLeft < 0 ? Math.round((-hoursLeft) * 10) / 10 : 0,
  };
}

/* When each claim on a page entered the status it is in now: the newest
   trail row per claim. One query for the page, because the alternative
   is one per claim. */
/* Rows that are ABOUT a status rather than a move between them: a note
   somebody left, a notice that went out, the clock's own nudge and its
   ask. Each is real evidence and each belongs on the trail — but none of
   them is when the status changed, and a claim must not buy itself
   another deadline by being talked about. Everything else on the trail
   is a transition, INCLUDING a re-naming that lands on the same status
   (a fresh worker starts a fresh clock). */
const ABOUT_EVENT = ['note', 'notified', 'overdue_nudge', 'chased', 'proposed'];

async function statusSinceFor(rows) {
  const ids = rows.map((r) => r.id).filter(Boolean);
  const since = {};
  if (!ids.length) return since;
  const events = await sb(
    'claim_events?select=claim_id,created_at,event,to_status&claim_id=in.(' + ids.join(',') +
      ')&order=created_at.desc',
    { method: 'GET' }
  );
  /* Newest first, so the FIRST row seen for a claim is the one that put
     it where it is. */
  for (const e of (Array.isArray(events) ? events : [])) {
    if (since[e.claim_id]) continue;
    if (ABOUT_EVENT.indexOf(e.event) !== -1) continue;
    since[e.claim_id] = e.created_at;
  }
  return since;
}

function withAging(rows, since, now) {
  return rows.map((r) => Object.assign({}, r, { aging: agingOf(r, since[r.id], now) }));
}

/* Overdue first, worst first. Then the two kinds of overdue are
   separated, because "the team is late" and "the customer has not
   replied" are different sentences to whoever reads the top of the
   queue — an angry customer is our problem, a quiet one is a reminder.

   Under the late ones: the claim closest to going late, so the queue is
   a work order and not just an alarm. A claim with NO clock (a draft,
   anything finished) never outranks one that is still moving — a closed
   claim cannot be the next thing a person does — and among those the
   oldest-first is kept.

   The page comes from the database by created_at, so this ordering is
   WITHIN the page: a queue long enough to paginate could hold an
   overdue claim on a later page. The scheduled clock is the backstop
   for exactly that — it scans every open claim, not a page of them. */
const WHO_RANK = { ours: 0, customer: 1 };

function byPain(a, b) {
  const ag = a.aging, bg = b.aging;
  if (!!ag && !!bg && ag.overdue !== bg.overdue) return ag.overdue ? -1 : 1;
  if (ag && bg && ag.overdue && bg.overdue) {
    if (WHO_RANK[ag.who] !== WHO_RANK[bg.who]) return WHO_RANK[ag.who] - WHO_RANK[bg.who];
    return bg.hours_over - ag.hours_over;
  }
  if (!!ag !== !!bg) return ag ? -1 : 1;
  if (ag && bg) return ag.hours_left - bg.hours_left;
  return String(a.created_at).localeCompare(String(b.created_at));
}

/* ------------------------------------------------------------
   THE DAY ON A CLAIM, IN ONE PLACE

   A visit day is a sentence two other people exchanged, and there are
   exactly three states of it that mean anything to the office:

     'agreed'    the customer said yes to the day the worker suggested.
                 That visit is going to happen unless somebody rings.
     'asked'     both halves have spoken and they do NOT match yet — the
                 worker offered a day, the customer answered with one of
                 their own. This is the state worth watching: the two of
                 them are settling it between themselves, and the only
                 thread holding it together is this record.
     'waiting'   a day is on the table and the customer has not answered
                 it at all.

   NOT in the list: a worker who has named no day yet. They will ring to
   arrange a time — there is nothing to agree, and counting them as "not
   settled" would put a number in front of the team that nobody can act
   on. `null` from this function is that case, and it is a real answer.

   Read by two callers that must never disagree: the queue's own summary
   (actionQueue, below) and the daily digest (claims-digest.js) — which
   is why the definition lives here and not in either of them. */
const VISIT_STATUSES = ['assigned', 'in_progress'];

/* A page, not the table: the cap only ever bites on an install with more
   than this many visits outstanding at once, and both callers say so
   rather than quietly counting a prefix as the whole truth. */
const VISITS_LIMIT = 500;

function dayStateOf(row) {
  if (!String(row.provider_proposal || '').trim()) return null;
  if (row.day_agreed_at) return 'agreed';
  return String(row.customer_proposal || '').trim() ? 'asked' : 'waiting';
}

/* The visits still to come: the days of claims whose work has not been
   reported yet. A day on a finished claim is history — the visit either
   happened or the claim was withdrawn — so counting it would make "how
   many visits are pinned down" grow for ever and mean nothing. */
async function visitsToCome(env) {
  /* An env is only a filter when it is NAMED. 'production' means the real
     visits (what the digest asks for, and what the page's own env switch
     is not); undefined means every row, which is what the queue has always
     done and what a mixed-environment dashboard expects to see. */
  const filter = env === 'test' ? '&env=eq.test'
    : env === 'production' ? '&env=eq.production' : '';
  const rows = await sb(
    'repair_claims?select=id,reference,status,student_name,student_phone,property,room,' +
      'provider_name,provider_phone,provider_proposal,provider_proposed_at,' +
      'customer_proposal,customer_proposed_at,day_agreed_at,created_at' +
      '&status=in.(' + VISIT_STATUSES.join(',') + ')' + filter +
      '&order=created_at.asc&limit=' + VISITS_LIMIT,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows : [];
}

function dayCounts(rows) {
  const out = { agreed: 0, asked: 0, waiting: 0, visits: 0, open: 0, capped: false };
  rows.forEach((r) => {
    const state = dayStateOf(r);
    if (!state) return;
    out.visits += 1;
    out[state] += 1;
    if (state !== 'agreed') out.open += 1;
  });
  out.capped = rows.length >= VISITS_LIMIT;
  return out;
}

async function actionQueue(actor, body) {
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 100);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const status = body.status ? String(body.status) : '';
  if (status && STATUSES.indexOf(status) === -1) {
    return { status: 400, body: { error: 'status must be one of: ' + STATUSES.join(', ') } };
  }
  const filter = status ? '&status=eq.' + encodeURIComponent(status) : '';
  const env = body.env === 'test' ? '&env=eq.test' : '';
  const rows = await sb(
    'repair_claims?select=*' + filter + env +
      '&order=created_at.asc&limit=' + limit + '&offset=' + offset,
    { method: 'GET' }
  );
  const summary = await sb('claims_summary?select=*', { method: 'GET' });
  const payoutRefs = (Array.isArray(rows) ? rows : []).filter((r) => Number(r.actual_kobo) > 0)
    .map((r) => [r.reference + ':settle', r.reference + ':cash']).reduce((all, refs) => all.concat(refs), []);
  let payoutRows = [];
  if (payoutRefs.length) {
    payoutRows = await sb('ledger_entries?select=entry_ref,account,direction,amount_kobo,source,business_line,env,memo,created_at&entry_ref=in.(' +
      payoutRefs.map(encodeURIComponent).join(',') + ')', { method: 'GET' });
  }
  const rowsWithPayout = (Array.isArray(rows) ? rows : []).map((r) => {
    const actual = Number(r.actual_kobo);
    const entries = (Array.isArray(payoutRows) ? payoutRows : []).filter((e) =>
      e.entry_ref === r.reference + ':settle' || e.entry_ref === r.reference + ':cash');
    const payable = entries.filter((e) => e.entry_ref === r.reference + ':settle')[0];
    const cash = entries.filter((e) => e.entry_ref === r.reference + ':cash')[0];
    const env = r.env || 'production';
    const exact = (e, account, direction) => !!e && e.account === account && e.direction === direction &&
      Number(e.amount_kobo) === actual && e.source === 'repair_payout' && e.business_line === 'care' &&
      (e.env || 'production') === env;
    const settled = actual > 0 && exact(payable, 'payable', 'debit') && exact(cash, 'cash', 'credit');
    return Object.assign({}, r, {
      payout_settled: settled ? {
        amount_kobo: actual,
        provider_transfer_ref: (String(payable.memo || '').match(/ · transfer (.+)$/) || [])[1] || null,
        settled_at: payable.created_at || null,
      } : null,
    });
  });

  const page = rowsWithPayout;
  let claims = page;
  let clocked = 0;
  let overdue = 0;
  try {
    const since = await statusSinceFor(page);
    claims = withAging(page, since, null).sort(byPain);
    clocked = claims.filter((c) => c.aging).length;
    overdue = claims.filter((c) => c.aging && c.aging.overdue).length;
  } catch (err) {
    /* The clock is a LENS on the queue, not a gate in front of it: if
       the trail cannot be read, the claims are still served the way
       they were before this existed rather than answered with an error
       about a feature nobody asked for. */
    console.error('[claims] the aging clock could not read the trail:', err && err.message);
    claims = page.map((r) => Object.assign({}, r, { aging: null }));
  }

  /* The visit days, counted over every open claim rather than over this
     page: "how many visits are pinned down" is a question about the
     whole install, and answering it from a page of 25 would move the
     number every time somebody scrolled. Its own read and its own
     catch, for the same reason the clock has one — a summary that
     cannot be read must not take the queue down with it. */
  let days = null;
  try {
    days = dayCounts(await visitsToCome(body.env));
  } catch (err) {
    console.error('[claims] the visit days could not be read:', err && err.message);
  }

  return {
    status: 200,
    body: {
      ok: true,
      claims: claims,
      summary: Array.isArray(summary) ? summary : [],
      limit: limit,
      offset: offset,
      statuses: STATUSES,
      aging: { clocked: clocked, overdue: overdue, limits: CLOCK },
      /* How many visits are actually pinned down, from the same reader
         the daily digest uses. `null` when that read failed: a dashboard
         that prints zero agrees with itself about a number it invented,
         and "not reported" and "none" are different facts. */
      days: days,
    },
  };
}

async function actionDecide(actor, body) {
  const claim = await claimById(body.id);
  if (!claim) return { status: 404, kind: 'rejected', body: { error: 'No such claim.' } };
  if (['submitted', 'under_review', 'draft'].indexOf(claim.status) === -1) {
    return { status: 409, body: { error: 'This claim has already been decided (' + claim.status + ').' } };
  }

  const eligibility = String(body.eligibility || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 800);
  if (['covered', 'not_covered'].indexOf(eligibility) === -1) {
    return { status: 400, body: { error: 'eligibility must be covered or not_covered.' } };
  }
  if (reason.length < 5) {
    return { status: 400, body: { error: 'A decision needs a reason in words — the customer reads it.' } };
  }

  const plan = await planById(claim.plan_id);
  if (!plan) {
    return { status: 409, body: { error: 'The pass this claim belongs to is not there any more — do not decide it by hand without finding out why.' } };
  }
  const at = new Date().toISOString();

  if (eligibility === 'not_covered') {
    await patch(claim.id, {
      status: 'rejected',
      eligibility: 'not_covered',
      eligibility_reason: reason,
      decided_by: actor.name,
      decided_at: at,
      resolved_at: at,
      resolution: 'refused: ' + reason,
      closed_by: actor.name,
    });
    await trail(claim, 'decision', 'rejected', {
      reason: reason, actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
    });
    const told = await tryNotify(
      Object.assign({}, claim, { status: 'rejected', eligibility: 'not_covered', eligibility_reason: reason }),
      plan, 'not_covered', { student: decisionCopy(claim, 'not_covered', reason) }
    );
    return { status: 200, body: { ok: true, status: 'rejected', notified: told.channels } };
  }

  /* COVERED. The call-out is taken before anything else is written: if
     the pass has nothing left, the claim is NOT approved and says so,
     rather than being approved against an allowance that is gone. */
  const no = await reserveCallout(plan, claim, actor.name, claim.env);
  if (!no) {
    await patch(claim.id, { status: 'under_review', eligibility: 'covered', eligibility_reason: reason, decided_by: actor.name, decided_at: at });
    await trail(claim, 'reviewed', 'under_review', {
      reason: 'Covered, but the pass has no call-outs left: ' + reason,
      actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
    });
    /* "The customer should be told" is this line: the refusal above has
       always said so, and until now nothing did it. */
    const toldNoCallOut = await tryNotify(
      Object.assign({}, claim, { status: 'under_review', eligibility: 'covered', eligibility_reason: reason }),
      plan, 'under_review', { student: decisionCopy(claim, 'under_review', reason) }
    );
    return {
      status: 409,
      body: {
        error: 'This pass has no call-outs left, so the claim was not approved. ' +
          'It stays under review — the customer has been told, and should be quoted for the work.',
        status: 'under_review',
        notified: toldNoCallOut.channels,
      },
    };
  }

  const estimate = body.estimate_kobo === undefined || body.estimate_kobo === null ? null : kobo(body.estimate_kobo);
  if (body.estimate_kobo !== undefined && body.estimate_kobo !== null && estimate === null) {
    /* Give the call-out back: a refused decision must not spend one. */
    await releaseCallout(plan, claim, 'decision refused: bad estimate', actor.name);
    return { status: 400, body: { error: 'estimate_kobo must be a whole number of kobo.' } };
  }

  await patch(claim.id, {
    status: 'approved',
    eligibility: 'covered',
    eligibility_reason: reason,
    decided_by: actor.name,
    decided_at: at,
    call_out_no: no,
    reserved_at: at,
    estimate_kobo: estimate,
  });
  await trail(claim, 'decision', 'approved', {
    reason: reason, data: { call_out_no: no, estimate_kobo: estimate },
    actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
  });
  await trail(claim, 'reserved', 'approved', {
    reason: 'Call-out ' + no + ' committed to this claim.',
    data: { call_out_no: no }, actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
  });
  const told = await tryNotify(
    Object.assign({}, claim, {
      status: 'approved', eligibility: 'covered', eligibility_reason: reason,
      call_out_no: no, estimate_kobo: estimate,
    }),
    plan, 'approved', {
      student: decisionCopy(
        Object.assign({}, claim, { call_out_no: no, estimate_kobo: estimate }), 'approved', reason
      ),
    }
  );
  return {
    status: 200,
    body: { ok: true, status: 'approved', call_out_no: no, estimate_kobo: estimate, notified: told.channels },
  };
}

async function actionAssign(actor, body) {
  const claim = await claimById(body.id);
  if (!claim) return { status: 404, kind: 'rejected', body: { error: 'No such claim.' } };
  if (['approved', 'assigned', 'in_progress'].indexOf(claim.status) === -1) {
    return { status: 409, body: { error: 'A claim must be approved before a worker is named (this one is ' + claim.status + ').' } };
  }
  const name = String(body.provider_name || '').trim().slice(0, 120);
  const phone = normalizePhone(body.provider_phone);
  if (name.length < 2) return { status: 400, body: { error: 'Name the worker who will do the job.' } };
  if (!phone) return { status: 400, body: { error: 'A worker needs a number the customer can reach.' } };

  /* Optional, and only a channel: a worker is reached on the phone
     first, so a typo in this field must not block an assignment — but a
     value that is not an address at all is refused rather than stored
     to fail silently at the next resolution. */
  const rawEmail = String(body.provider_email || '').trim().slice(0, 160);
  const emailCheck = rawEmail ? mailDeliverable(rawEmail) : { ok: true, address: null };
  if (!emailCheck.ok) {
    return { status: 400, body: { error: 'That worker email does not look like an address \u2014 leave it blank if there is none.' } };
  }

  await patch(claim.id, {
    status: 'assigned',
    provider_name: name,
    provider_phone: phone,
    provider_email: emailCheck.address,
    assigned_at: new Date().toISOString(),
    assigned_by: actor.name,
    /* A NEW NAMING, SO THE OLD ANSWER IS NOT THIS JOB'S ANSWER. If the
       worker named a moment ago declined — or accepted, and somebody else
       is being named now — the row must not carry a word from the person
       it is no longer about. The trail keeps that history; this row
       describes who is on the job now. */
    provider_answer: null,
    provider_answered_at: null,
    provider_answer_note: null,
    provider_proposal: null,
    provider_proposed_at: null,
    customer_proposal: null,
    customer_proposed_at: null,
    day_agreed_at: null,
  });
  await trail(claim, 'assigned', 'assigned', {
    reason: 'Assigned to ' + name + (emailCheck.address ? ' (email on file)' : '') + '.',
    actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
  });

  /* THE HANDOVER, in two messages that are not the same message. The
     worker is told the job is theirs, because a job that arrives as a
     phone call from somebody else has not been handed over yet. The
     customer is told who is coming and how to reach them, because the
     approval promised exactly that ("we name the worker who is coming and
     message you again when we do") — and a name is the one thing that
     turns "a worker" into somebody they can let through the gate. The
     student's copy is therefore NOT a repeat of the decision: it carries
     the name, and the decision it follows still says nothing about money
     it did not already say.

     The pass is read for the student's number and address, which live on
     its payload, the same way the resolution does it.

     After the row and the trail, never before: the claim is already
     assigned, so a notice that will not go must not undo it — the
     operator sees the channels in the answer and the record keeps them. */
  const plan = await planById(claim.plan_id);
  const assigned = Object.assign({}, claim, {
    status: 'assigned', provider_name: name, provider_phone: phone,
    provider_email: emailCheck.address,
  });
  const told = await tryNotify(assigned, plan, 'assigned', {
    worker: workerAssignedCopy(assigned),
    student: studentAssignedCopy(assigned),
  });
  return {
    status: 200,
    body: {
      ok: true, status: 'assigned',
      provider_email: emailCheck.address,
      notified: told.channels,
    },
  };
}

async function actionProgress(actor, body) {
  const claim = await claimById(body.id);
  if (!claim) return { status: 404, kind: 'rejected', body: { error: 'No such claim.' } };
  const to = String(body.status || '').trim();
  /* Support moves a job along; it does not close one. */
  if (['in_progress'].indexOf(to) === -1) {
    return {
      status: 400,
      body: { error: 'Support can mark a job in_progress. Reporting the work and closing a claim are the admin\u2019s.' },
    };
  }
  if (['assigned', 'in_progress'].indexOf(claim.status) === -1) {
    return { status: 409, body: { error: 'This claim is not with a worker yet (' + claim.status + ').' } };
  }
  await patch(claim.id, { status: 'in_progress' });
  await trail(claim, 'started', 'in_progress', {
    reason: body.note ? String(body.note).slice(0, 400) : 'Work started.',
    actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
  });
  return { status: 200, body: { ok: true, status: 'in_progress' } };
}

async function actionReportWork(actor, body) {
  const claim = await claimById(body.id);
  if (!claim) return { status: 404, kind: 'rejected', body: { error: 'No such claim.' } };
  if (['assigned', 'in_progress'].indexOf(claim.status) === -1) {
    return { status: 409, body: { error: 'Work can only be reported on a claim with a worker on it (' + claim.status + ').' } };
  }
  if (!String(claim.provider_name || '').trim()) {
    return { status: 409, body: { error: 'Name the worker before reporting this repair; the payable must belong to the person who did it.' } };
  }
  if (claim.actual_kobo !== undefined && claim.actual_kobo !== null) {
    return { status: 409, body: { error: 'This claim already has an actual cost. Do not overwrite its posted payable.' } };
  }
  const hasCost = body.actual_kobo !== undefined && body.actual_kobo !== null;

  const actual = body.actual_kobo === undefined || body.actual_kobo === null ? null : kobo(body.actual_kobo);
  if (actual === 0) {
    return { status: 400, body: { error: 'Enter a positive actual cost, or leave it blank if no provider payable is being recorded.' } };
  }
  if (hasCost && actual === null) {
    return { status: 400, body: { error: 'actual_kobo must be a whole number of kobo.' } };
  }
  if (actual !== null && claim.estimate_kobo != null && actual > Number(claim.estimate_kobo) * 3) {
    return { status: 400, body: { error: 'The actual cost is over three times the estimate. Check the amount against the quote before posting it.' } };
  }

  const parts = Array.isArray(body.parts)
    ? body.parts.slice(0, 20).map((p) => ({
      name: String((p && p.name) || '').slice(0, 80),
      kobo: kobo(p && p.kobo) || 0,
    }))
    : [];
  const evidence = Array.isArray(body.evidence)
    ? body.evidence.filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 6)
    : [];

  /* THE MONEY, POSTED. Expense up, provider payable up — kobo, and an
     entry_ref derived from the claim so a retry cannot double-post. */
  if (actual !== null && actual > 0) {
    await postLedger({
      entry_ref: claim.reference + ':cost',
      business_line: 'care',
      account: 'expense',
      direction: 'debit',
      amount_kobo: actual,
      source: 'repair_claim',
      memo: 'Repair ' + claim.reference + ' — ' + (claim.provider_name || 'worker'),
      actor_ref: actor.id,
      actor_name: actor.name,
      env: claim.env,
    });
    await postLedger({
      entry_ref: claim.reference + ':payable',
      business_line: 'care',
      account: 'payable',
      direction: 'credit',
      amount_kobo: actual,
      source: 'repair_claim',
      memo: 'Owed to ' + claim.provider_name + ' for ' + claim.reference,
      actor_ref: actor.id,
      actor_name: actor.name,
      env: claim.env,
    });
  }

  await patch(claim.id, {
    status: 'awaiting_customer',
    actual_kobo: actual,
    parts: parts,
    evidence: evidence,
    customer_note: body.note ? String(body.note).slice(0, 400) : null,
  });
  await trail(claim, 'work_reported', 'awaiting_customer', {
    reason: body.note ? String(body.note).slice(0, 400) : 'Work reported; waiting for the customer.',
    data: { actual_kobo: actual, parts: parts.length, evidence: evidence.length },
    actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
  });
  return { status: 200, body: { ok: true, status: 'awaiting_customer', actual_kobo: actual } };
}

async function actionSettlePayout(actor, body) {
  const id = String(body.id || '').trim();
  const transferRef = String(body.provider_transfer_ref || '').trim();
  if (!id) return { status: 400, body: { error: 'Select the repair claim this transfer belongs to.' } };
  if (!transferRef || transferRef.length < 4 || transferRef.length > 120 || /^(test|todo|tbd|pending|na|none|unknown|placeholder|0+)$/i.test(transferRef)) {
    return { status: 400, body: { error: 'Enter the real transfer reference from the bank or payment provider (4–120 characters). Placeholder references are not accepted.' } };
  }

  const claim = await claimById(id);
  if (!claim) return { status: 404, kind: 'rejected', body: { error: 'No such repair claim.' } };
  if (!claim.provider_name || !String(claim.provider_name).trim()) {
    return { status: 409, body: { error: 'This payable has no named worker. Correct the claim record before settling it.' } };
  }
  if (claim.actual_kobo === null || claim.actual_kobo === undefined || !Number.isSafeInteger(Number(claim.actual_kobo)) || Number(claim.actual_kobo) <= 0) {
    return { status: 409, body: { error: 'This claim has no positive, posted actual cost to settle.' } };
  }

  const expected = Number(claim.actual_kobo);
  const rows = await sb('ledger_entries?select=entry_ref,account,direction,amount_kobo,source,business_line,env&entry_ref=in.(' +
    encodeURIComponent(claim.reference + ':cost') + ',' + encodeURIComponent(claim.reference + ':payable') + ')', { method: 'GET' });
  const entries = Array.isArray(rows) ? rows : [];
  const cost = entries.filter((e) => e.entry_ref === claim.reference + ':cost')[0];
  const payable = entries.filter((e) => e.entry_ref === claim.reference + ':payable')[0];
  const exact = (e, account, direction) => !!e && e.business_line === 'care' && e.account === account &&
    e.direction === direction && Number(e.amount_kobo) === expected && e.source === 'repair_claim' &&
    (e.env || 'production') === (claim.env || 'production');
  if (!exact(cost, 'expense', 'debit') || !exact(payable, 'payable', 'credit')) {
    return { status: 409, body: { error: 'The Care ledger does not contain the matching repair expense and provider payable. Nothing was settled; reconcile the entries first.' } };
  }
  const settledRef = claim.reference + ':settle';
  const cashRef = claim.reference + ':cash';
  const existing = await sb('ledger_entries?select=entry_ref,account,direction,amount_kobo,source,business_line,env,memo,created_at&entry_ref=in.(' +
    encodeURIComponent(settledRef) + ',' + encodeURIComponent(cashRef) + ')', { method: 'GET' });
  if (Array.isArray(existing) && existing.length) {
    const priorPayable = existing.filter((e) => e.entry_ref === settledRef)[0];
    const priorCash = existing.filter((e) => e.entry_ref === cashRef)[0];
    const exactSettlement = (e, account, direction) => !!e && e.business_line === 'care' && e.account === account &&
      e.direction === direction && Number(e.amount_kobo) === expected && e.source === 'repair_payout' &&
      (e.env || 'production') === (claim.env || 'production') && String(e.memo || '').endsWith(' · transfer ' + transferRef);
    if (existing.length === 2 && exactSettlement(priorPayable, 'payable', 'debit') && exactSettlement(priorCash, 'cash', 'credit')) {
      return { status: 200, body: { ok: true, settled: true, already: true, reference: claim.reference,
        amount_kobo: expected, provider_transfer_ref: transferRef } };
    }
    return { status: 409, body: { error: 'A settlement movement already exists for this claim, but it does not match this transfer. Reconcile it before retrying.' } };
  }

  /* One balanced, idempotent database transaction is essential here.
     Two REST inserts cannot be atomic: if the first succeeds and the
     second fails, the payable is reduced without the matching cash
     movement. A small, claim-scoped RPC posts the pair together. */
  const settlement = await sb('rpc/claim_settle_payout', {
    method: 'POST',
    body: JSON.stringify({
      p_claim_ref: claim.reference,
      p_amount_kobo: expected,
      p_provider_name: claim.provider_name,
      p_transfer_ref: transferRef,
      p_actor_ref: actor.id,
      p_actor_name: actor.name,
      p_env: claim.env || 'production',
    }),
  });
  if (!settlement || settlement.ok !== true) {
    return { status: 409, body: { error: 'The Care ledger could not confirm an atomic payout posting. Nothing was marked settled.' } };
  }

  return { status: 200, body: { ok: true, settled: true, already: !!settlement.already, reference: claim.reference, amount_kobo: expected, provider_transfer_ref: transferRef } };
}

async function actionResolve(actor, body) {
  const claim = await claimById(body.id);
  if (!claim) return { status: 404, kind: 'rejected', body: { error: 'No such claim.' } };
  const outcome = String(body.outcome || '').trim();
  const resolution = String(body.resolution || '').trim().slice(0, 800);
  if (['completed', 'rejected', 'cancelled'].indexOf(outcome) === -1) {
    return { status: 400, body: { error: 'outcome must be completed, rejected or cancelled.' } };
  }
  if (resolution.length < 5) {
    return { status: 400, body: { error: 'A resolution is a sentence on the record, not a status change.' } };
  }
  if (claim.status !== 'disputed') {
    return { status: 409, body: { error: 'There is no open dispute on this claim (' + claim.status + ').' } };
  }

  const at = new Date().toISOString();
  /* The pass, for two reasons: giving a call-out back, and reaching the
     student — their number and address live on the pass's payload. */
  const plan = await planById(claim.plan_id);
  /* If the job is not happening, the call-out goes back. */
  let released = false;
  if (outcome !== 'completed' && claim.call_out_no && plan) {
    released = await releaseCallout(plan, claim, 'dispute resolved: ' + outcome, actor.name);
  }

  await patch(claim.id, {
    status: outcome,
    resolved_at: at,
    resolution: resolution,
    closed_by: actor.name,
  });
  await trail(claim, 'resolution', outcome, {
    reason: resolution, data: { released: released },
    actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
  });
  if (released) {
    await trail(claim, 'released', outcome, {
      reason: 'Call-out returned to the pass.',
      actor_ref: actor.id, actor_name: actor.name, actor_role: actor.role,
    });
  }

  /* The customer is the one who raised it, and the worker is the one
     whose money it was about — so both hear the outcome from us rather
     than by checking the page. A claim disputed with no worker named
     (the work was reported, then questioned) has only the student to
     tell, and the record says so rather than inventing a recipient. */
  const settled = Object.assign({}, claim, {
    status: outcome, resolution: resolution, resolved_at: at, released: released,
  });
  const told = await tryNotify(settled, plan, outcome, {
    student: resolutionCopy(settled, outcome, resolution, released),
    worker: claim.provider_name ? workerCopy(settled, outcome, resolution) : null,
  });

  return {
    status: 200,
    body: { ok: true, status: outcome, released: released, notified: told.channels },
  };
}

/* ------------------------------------------------------------
   TELLING THE PEOPLE THE DECISION AFFECTED

   The moment coverage is decided or a dispute is closed, the student
   stops having to ask. They read it on WhatsApp and, when their pass
   carries a real address, by email. The worker is only ever named when
   the job is handed over — so they only exist at resolution — and they
   get the same message, on WhatsApp and by email when the team
   recorded one.

   WHY THIS CANNOT FAIL THE DECISION
     Both channels answer a word instead of throwing (sendText and
     sendEmail are built that way), so a stale number or a mail key
     that was never set cannot turn an admin's click into an error.
     What it must never do is fail QUIETLY: every channel's outcome is
     written to the claim's own trail as a 'notified' row, and a
     channel that did not go out pings the team on Telegram with the
     number to use instead. A message lost in silence is the complaint
     that follows, which is why this is not a fire-and-forget.
   ------------------------------------------------------------ */

function naira(koboValue) {
  var n = Number(koboValue || 0) / 100;
  return '\u20a6' + n.toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

/* The WhatsApp JID, from whatever shape the phone was stored in. An
   unusable number answers empty rather than a JID that would be
   refused at the far end — so the record can say 'no number' instead
   of 'openwa-400'. */
function waJid(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const local = d.length === 11 && d[0] === '0' ? '234' + d.slice(1) : d;
  return /^234\d{10}$/.test(local) ? local + '@s.whatsapp.net' : '';
}

function firstName(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/)[0] : 'there';
}

/* The coverage decision, in the customer's words. Three answers are
   possible and all three are sent: covered, not covered, and covered
   but the pass has nothing left to spend — the last one is the one
   most likely to be forgotten, and the one the function's own refusal
   says the customer must hear. */
function decisionCopy(claim, kind, reason) {
  const head = 'Arzuz Care \u2014 claim ' + claim.reference;
  const who = firstName(claim.student_name);

  if (kind === 'not_covered') {
    return head + '\n\n' +
      'Hello ' + who + ' \u2014 we have looked at your claim, and it is not covered by your Care Pass.\n\n' +
      'Why: ' + reason + '\n\n' +
      'Nothing has been charged to you, and the call-outs on your pass are untouched. ' +
      'If you think this is wrong, reply to this number and we will look at it again.\n\n' +
      'Your pass link has the full record of this claim.';
  }

  if (kind === 'under_review') {
    return head + '\n\n' +
      'Hello ' + who + ' \u2014 the fault you reported is covered, but your pass has no call-outs ' +
      'left to spend on it.\n\n' +
      'We have kept the claim open and marked it covered, so nothing is lost. A team member ' +
      'will message you with a quote for the work.\n\n' +
      'Why: ' + reason;
  }

  return head + '\n\n' +
    'Hello ' + who + ' \u2014 your repair claim is approved. The fault is covered by your Care Pass.\n\n' +
    'Why: ' + reason + '\n' +
    'Call-out ' + claim.call_out_no + ' of your pass is committed to this claim' +
    (claim.estimate_kobo ? ' (a quote of ' + naira(claim.estimate_kobo) + ', not a bill)' : '') + '.\n\n' +
    'What happens next: we name the worker who is coming and message you again when we do. ' +
    'If the work costs anything, we pay the provider \u2014 you do not pay them.\n\n' +
    'You can watch this claim from your pass link.';
}

/* The dispute, closed by name. The student's side carries what was
   decided; the worker's side carries what they are owed, because the
   money in this workflow is a posting against their name. */
const OUTCOME_WORD = {
  completed: 'the work was accepted',
  rejected: 'the claim was refused',
  cancelled: 'the job is not going ahead',
};

function resolutionCopy(claim, outcome, resolution, released) {
  const head = 'Arzuz Care \u2014 claim ' + claim.reference;
  return head + '\n\n' +
    'Hello ' + firstName(claim.student_name) + ' \u2014 we have closed the dispute on your claim. ' +
    'The outcome: ' + (OUTCOME_WORD[outcome] || outcome) + '.\n\n' +
    'What we decided: ' + resolution + '\n\n' +
    (released
      ? 'The call-out this claim was holding has gone back on your pass, so it is available for ' +
        'another fault.\n\n'
      : 'The call-out stays committed to this claim.\n\n') +
    'If anything here is still not right, reply to this number \u2014 a person reads it.';
}

/* The other half of the handover, and a promise being kept: the approval
   told the customer "we name the worker who is coming and message you
   again when we do", so this is that message. It exists because a
   customer who is never told who is coming rings the team to ask, and a
   worker who arrives unannounced is somebody at the gate the tenant has
   no reason to let in.

   The worker's NUMBER travels here for the same reason the tenant's does
   in the other copy: the two people who have to agree a time are the two
   people who need to reach each other. */
function studentAssignedCopy(claim) {
  const issue = String(claim.issue || '').trim();
  return 'Arzuz Care \u2014 claim ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.student_name) + ' \u2014 the worker coming to do this repair ' +
    'has been named, so here they are.\n\n' +
    (issue ? 'What: ' + issue + '\n' : '') +
    'Who: ' + claim.provider_name + ' \u00b7 ' + claim.provider_phone + '\n\n' +
    'They will call this number to arrange a time with you. Nothing about the money has ' +
    'changed: the work is covered by your pass and we pay the provider \u2014 you do not pay ' +
    'them on the day.\n\n' +
    'If they do not turn up, or the visit goes wrong, reply to this number. ' +
    'Your pass link has the full record of this claim.';
}

/* The handover: what a person needs to actually DO the job, answered in
   the message rather than in the next phone call \u2014 where it is, what is
   wrong, how to reach the tenant, and the quote the customer was given,
   so nobody discovers the money halfway through.

   The customer's NUMBER travels here, deliberately: a worker who cannot
   reach the tenant cannot arrange access, and naming them is exactly the
   moment that number stops being internal. Only the first name goes with
   it \u2014 the worker needs somebody to call, not a dossier. */
function workerAssignedCopy(claim) {
  const where = [claim.property, claim.room].filter((x) => !!x).join(' \u00b7 ');
  return 'Arzuz Care \u2014 job ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.provider_name) + ' \u2014 you have been named on this repair. ' +
    'It is covered by a Care Pass, so the work is ours to arrange and the customer does not pay ' +
    'you on the day.\n\n' +
    'What: ' + (claim.issue || 'see the job sheet') + '\n' +
    (where ? 'Where: ' + where + '\n' : '') +
    'Customer: ' + firstName(claim.student_name) + ' \u00b7 ' +
      (claim.student_phone || 'no number on the claim \u2014 reply here and we will get one') + '\n\n' +
    (claim.estimate_kobo
      ? 'The quote the customer was given is ' + naira(claim.estimate_kobo) +
        '. If the job needs more than that, tell us before you buy anything.\n\n'
      : '') +
    'When the work is finished, send the cost and a photo of it to this number \u2014 the records here ' +
    'are what pays you on the next settlement. Anything blocking you, tell us the same way.';
}

/* THE VISIT IS ON. The customer has agreed the day this worker suggested,
   and this message exists because a confirmed appointment that only one of
   the two people knows about is not a confirmed appointment. Their own
   day is quoted back — it is the worker's sentence, and it is what was
   agreed to. */
function workerDayAgreedCopy(claim) {
  const where = [claim.property, claim.room].filter((x) => !!x).join(' \u00b7 ');
  return 'Arzuz Care \u2014 job ' + claim.reference + '\n\n' +
    'The customer has agreed the day you suggested \u2014 \u201c' +
    String(claim.provider_proposal || '').replace(/[\u201c\u201d"]/g, '') + '\u201d \u2014 so the visit ' +
    'is on.\n\n' +
    (where ? 'Where: ' + where + '\n' : '') +
    'Customer: ' + firstName(claim.student_name) + ' \u00b7 ' +
      (claim.student_phone || 'ask us for the number') + '\n\n' +
    'If anything changes and you cannot make it, tell us here before the day rather than on it \u2014 ' +
    'somebody is expecting you now. When the work is done, send the cost and a photo to this number.';
}

/* THE DAY DOES NOT SUIT THEM. The worker has to know BEFORE they set out,
   so this is not a note for the office: it carries the day the customer
   suggested, in their words, and the number to settle it on. The job is
   still theirs \u2014 a different day is not a refusal. */
function workerDayMovedCopy(claim) {
  return 'Arzuz Care \u2014 job ' + claim.reference + '\n\n' +
    'The customer cannot do ' +
    (claim.provider_proposal
      ? '\u201c' + String(claim.provider_proposal).replace(/[\u201c\u201d"]/g, '') + '\u201d'
      : 'the day you suggested') +
    '. They have suggested: \u201c' + String(claim.customer_proposal || '').replace(/[\u201c\u201d"]/g, '') + '\u201d\n\n' +
    'Please settle it with them directly: ' + firstName(claim.student_name) + ' \u00b7 ' +
      (claim.student_phone || 'ask us for the number') + '\n\n' +
    'Nothing else has changed: the job is still yours, it is still covered by the pass, and the ' +
    'customer pays you nothing on the day. If neither day works, reply NO and we will re-arrange it ' +
    'with them.';
}

function workerCopy(claim, outcome, resolution) {
  return 'Arzuz Care \u2014 job ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.provider_name) + ' \u2014 the customer dispute on this job is closed. ' +
    'The outcome: ' + (OUTCOME_WORD[outcome] || outcome) + '.\n\n' +
    'What was decided: ' + resolution + '\n\n' +
    (claim.actual_kobo
      ? 'The cost recorded for this job is ' + naira(claim.actual_kobo) +
        '. Anything owed to you is on the next settlement against your name.'
      : 'No cost was recorded for this job. If you paid for parts, send the receipts to this number.');
}

/* One channel, one word. Nothing here throws: a failure to reach a
   person is a fact, and this returns it as one. */
async function deliverWhatsApp(phone, text) {
  const jid = waJid(phone);
  if (!jid) return 'no number';
  const out = await sendText(jid, text);
  return out.ok ? 'sent' : String(out.reason || 'failed');
}

async function deliverEmail(address, subject, text) {
  if (!address) return 'no address';
  const out = await sendEmail({ to: address, subject: subject, text: text });
  if (out.ok) return 'sent';
  return String(out.reason || 'failed') + (out.detail ? ' (' + out.detail + ')' : '');
}

/* A channel that DOES NOT EXIST is not the same fact as one that
   FAILED, and reading them alike is how a notice turns into noise:

     no number / no address / placeholder-address
       there is nothing to send to — a worker is often a name and a
       phone, and a pass bought without an email carries the placeholder
       finance.js invents. Nothing the team does today changes that, so
       it is RECORDED and not shouted about.

     refused / unreachable / openwa-4xx / bad-address
       a channel existed and the message did not arrive. That is a call
       somebody owes, and it is what pages the team.

   And one case is worse than a failure: a person NO channel reached —
   no number and no address, on either one. "We told nobody" must not
   be the quiet outcome, so it is escalated in its own words. */
const NO_SUCH_CHANNEL = ['no number', 'no address', 'placeholder-address'];

/* Deliver, record, and only shout when something did not arrive. The
   trail row is the point: "was the customer told?" is answered by a
   row rather than by somebody's memory of a green toast. */
/* What each notice is ABOUT, in the subject line: the subject is read in
   a list of emails, so it has to say the thing without the body. A
   resolution falls through to 'was closed', which is the only one of
   these that a worker's own copy ever carries. The handover is not in
   here: it goes to two people who need different headlines, so it names
   its own in subjectFor(). */
const SUBJECT_TAIL = {
  approved: ' is approved',
  not_covered: ' was not covered',
  under_review: ' is covered, but the pass is spent',
  declined: ' needs another worker',
  unanswered: ' needs another worker',
  proposed: ' \u2014 a time has been suggested',
  day_agreed: ' \u2014 the customer agreed the day',
  day_proposed: ' \u2014 the customer suggested another day',
};

/* The handover's two headlines, because it is one action that sends two
   different messages: "job AZ-C-7 is yours" is only true for the worker,
   and the customer's subject is the news that somebody has been named. */
function subjectFor(kind, claim, who) {
  if (kind !== 'assigned') {
    return 'Arzuz Care \u2014 claim ' + claim.reference + (SUBJECT_TAIL[kind] || ' was closed');
  }
  return who === 'worker'
    ? 'Arzuz Care \u2014 job ' + claim.reference + ' is yours'
    : 'Arzuz Care \u2014 the worker coming for claim ' + claim.reference;
}

/* One sentence per kind of notice, so the trail cannot be read as saying
   something that did not happen. `decision` is the fallback every other
   kind gets. */
const NOTICE_ROW = {
  assigned: { said: 'The handover was delivered', failed: 'The handover was NOT fully delivered' },
  declined: {
    said: 'The customer was told the worker has turned the job down',
    failed: 'The customer was NOT told the worker turned the job down',
  },
  unanswered: {
    said: 'The customer was told the job has gone to somebody else',
    failed: 'The customer was NOT told the job had been taken back',
  },
  /* The customer's own two answers, which go to the WORKER: they are the
     person who has to turn up (or not). */
  day_agreed: {
    said: 'The worker was told the customer agreed the day',
    failed: 'The worker was NOT told the customer agreed the day',
  },
  day_proposed: {
    said: 'The worker was told the day the customer suggested',
    failed: 'The worker was NOT told the day the customer suggested',
  },
  proposed: {
    said: 'The customer was told when the worker can come',
    failed: 'The customer was NOT told when the worker can come',
  },
  decision: { said: 'The decision was delivered', failed: 'The decision was NOT fully delivered' },
};

async function notifyClaim(claim, plan, kind, copy) {
  const payload = (plan && plan.payload) || {};
  const channels = {};
  const failed = [];      /* a channel existed and did not deliver */
  const silent = [];      /* a person no channel reached at all */

  /* One person, both channels, one place that decides what the outcomes
     MEAN — so the student's notice and the worker's cannot drift into
     two different readings of "no address". */
  const tell = async (who, phone, address, body) => {
    const out = {
      whatsapp: await deliverWhatsApp(phone, body),
      email: await deliverEmail(address, subjectFor(kind, claim, who), body),
    };
    channels[who + '_whatsapp'] = out.whatsapp;
    channels[who + '_email'] = out.email;

    ['whatsapp', 'email'].forEach((k) => {
      if (out[k] !== 'sent' && NO_SUCH_CHANNEL.indexOf(out[k]) === -1) {
        failed.push('the ' + who + ' on ' + k + ' (' + out[k] + ')');
      }
    });
    /* The worst case is not a channel that failed — that is already in
       the list above — but a person with NO channel at all: nobody can
       be told anything by any door, and that must not be quiet. The
       student's number is required to file, so in practice this is a
       worker row that was written without one; the schema permits that,
       and this door is where it stops being invisible. */
    const none = ['whatsapp', 'email'].filter((k) => NO_SUCH_CHANNEL.indexOf(out[k]) !== -1).length;
    if (none === 2) {
      silent.push('the ' + who + ' (no number and no address on the claim)');
    }
  };

  /* The address a pass carries may be the placeholder finance.js
     invents when a pass is bought without one — sendEmail names that
     rather than bouncing into nowhere, and it is not a failure.

     Either half can be absent, and the handover uses both halves: the
     worker's copy and the student's copy are two different messages to
     two different people, so each goes only to the person it is
     addressed to and no channel is recorded for a message nobody was
     meant to receive. */
  if (copy.student) {
    await tell('student', claim.student_phone || payload.phone, payload.email, copy.student);
  }

  if (copy.worker) {
    await tell('worker', claim.provider_phone, claim.provider_email, copy.worker);
  }

  const undelivered = failed.concat(silent);
  const summary = Object.keys(channels).map((k) => k + ': ' + channels[k]).join('; ');
  /* The trail's own words. A handover is not a decision — and a decline
     is neither — and this row is read months later by somebody who was
     not in the room, so the first line says which notice it was. The
     sentence is per-kind rather than glued around one noun, because "the
     handover was delivered" is true of a naming and false of a
     withdrawal. */
  const phrase = NOTICE_ROW[kind] || NOTICE_ROW.decision;
  const reason = (undelivered.length ? phrase.failed : phrase.said) + ' (' + summary + ')';

  /* The row, but not at the cost of the row's subject: at this point the
     decision is committed and audited, so a trail write that fails is a
     log line rather than a reason to fail the admin's action. */
  try {
    await trail(claim, 'notified', claim.status, {
      reason: reason.slice(0, 800),
      data: { channels: channels, undelivered: undelivered.length },
      actor_name: 'the claim workflow',
      actor_role: 'system',
    });
  } catch (err) {
    console.error('[claims] the notice went out but its trail row did not:', err && err.message);
  }

  /* A message that did not arrive is a phone call somebody owes. This is
     the only reason the team is paged about a notice: a delivery that
     worked is already on the customer's screen, and a channel that does
     not exist was already on the record. */
  if (undelivered.length) {
    await sendAlert('\u26a0\ufe0f A claim notice did not reach everybody\n' + claim.reference +
      (failed.length ? '\nDid not arrive: ' + failed.join(', ') : '') +
      (silent.length ? '\nNobody could be reached: ' + silent.join(', ') : '') +
      '\nStudent: ' + (claim.student_name || '\u2014') + ' \u00b7 ' + (claim.student_phone || 'no number') +
      (claim.provider_name ? '\nWorker: ' + claim.provider_name + ' \u00b7 ' + (claim.provider_phone || 'no number') : ''));
  }

  return { channels: channels, failed: failed, silent: silent, undelivered: undelivered };
}

/* THE CALL-SITE GUARD. By the time this runs the decision is committed,
   so nothing about telling people may turn into an error the admin
   sees. It logs instead — and reports the notice itself as undelivered,
   which is the honest reading of "we do not know what was sent". */
async function tryNotify(claim, plan, kind, copy) {
  try {
    return await notifyClaim(claim, plan, kind, copy);
  } catch (err) {
    console.error('[claims] the notice could not be sent:', err && err.message);
    return { channels: {}, undelivered: ['the notice itself failed'] };
  }
}

/* ------------------------------------------------------------
   THE WORKER'S OWN DOOR — their reply to a handover

   Naming somebody is US saying who is coming. It is not them agreeing
   to come, and until this door the only place a worker's "I cannot
   take it" landed was a phone call to the office — while the claim sat
   in 'assigned' with somebody on it who was never going to turn up, and
   the customer waited for a knock that was not coming. The handover
   message ends by telling them to reply if anything is wrong, so this
   is the answer to an invitation we made.

   WHAT IT IS NOT: a general inbox. A message from a number we never
   asked anything is left alone. The office reads that number too, and a
   machine that answers the human conversation is its own kind of
   failure — which is also why every unclear reply gets a plain question
   rather than a guess. A guess here decides whether somebody turns up.

   NOTHING HERE IS SILENT. An answer is a row on the claim; the words
   the worker used are kept as given; a job that comes back to us pages
   the team, and the customer who was told a name is told there is no
   longer one — because the approval promised to name the worker who is
   coming, and that promise is not kept by naming somebody who has said
   no.
   ------------------------------------------------------------ */

/* The vocabulary of a yes and a no, kept as data with the reason it is
   data: this decides whether a person is expected at a flat. Two lists
   and a phrase list per side, matched on WORD boundaries so "i can"
   cannot be found inside "i cannot" — the mistake that would read a
   refusal as an acceptance. */
const YES_WORDS = ['y', 'yes', 'yess', 'yeah', 'yep', 'yup', 'ok', 'okay', 'okey', 'sure',
  'fine', 'accept', 'accepts', 'accepted', 'accepting', 'confirm', 'confirmed', 'agreed',
  'agree', 'alright', 'aight', 'noted', 'deal', 'available', 'ready', 'roger', 'k'];

/* 'on' and 'stop' are deliberately NOT words here, though both read as an
   answer on their own: "on Monday I am in Lagos" and "I will stop by in
   the morning" are statements about a DAY, and reading the first as a yes
   and the second as a no would put a worker on a job they are not taking,
   or take one off a worker who is coming. The phrases that need them ('on
   it', 'not available') are matched as phrases. */
const NO_WORDS = ['no', 'nope', 'nah', 'nor', 'cant', 'cannot', 'unable', 'unavailable',
  'decline', 'declined', 'declining', 'busy', 'occupied', 'unfortunately'];

const YES_PHRASES = ['i can', 'i will do it', 'i will take it', 'i can do it', 'i can come',
  'i will come', 'i am available', 'i am free', 'no problem', 'no wahala', 'will do',
  'on my way', 'am on it', 'i am on it', 'on it', 'sure thing', 'consider it done',
  'yes i can', 'when should i come', 'not a problem', 'i am coming'];

const NO_PHRASES = ['can not', 'cannot', 'can t', 'not able', 'not available', 'not possible',
  'not free', 'not around', 'no thanks', 'no thank you', 'i cant', 'i cannot', 'i wont',
  'will not', 'out of town', 'not in town', 'travelled', 'travelling', 'on another job',
  'another job', 'someone else', 'somebody else', 'another person', 'find another',
  'no longer available', 'not doing', 'not coming'];

/* WHAT A DAY OR A TIME LOOKS LIKE. Only ever used to RECOGNISE that a
   reply is about the timing — never to compute one, and never to decide
   what day it is. See provider_proposal in supabase-claims.sql for why:
   "tomorrow morning" is a timezone guess away from being a wrong
   appointment on a customer's page, while the worker's own words are
   exactly what a proposal is. */
const DAY_WORDS = ['today', 'tomorrow', '2moro', '2morrow', 'tmrw', 'tommorow', 'tonight',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'weds', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'morning', 'afternoon', 'evening', 'night', 'weekend', 'noon', 'midday'];

const DAY_PHRASES = ['next week', 'this week', 'end of the week', 'first thing', 'after work',
  'before work', 'in the morning', 'in the afternoon', 'in the evening', 'same time',
  'any time', 'later today', 'next month'];

/* A clock time: 9am, 10:30 am, 4 pm, 17:00. */
const CLOCK_RE = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b/;

/* Does this reply name a day or a time? Answers the matched words, or
   empty when the reply is not about the timing at all. */
function timeIn(text) {
  const t = replyWords(text);
  if (!t) return '';
  if (CLOCK_RE.test(t)) return 'a time';
  const day = DAY_WORDS.concat([]).filter((w) => phraseFound(t, [w]))[0];
  if (day) return day;
  const phrase = DAY_PHRASES.filter((p) => phraseFound(t, [p]))[0];
  return phrase || '';
}

/* Lower case, apostrophes dropped ("can't" is "cant", the same word the
   word list holds), everything else non-alphanumeric turned into a
   space — so emoji, punctuation and newlines cannot hide a word. */
function replyWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* A phrase, matched the way the word lists are: what sits on either side
   must not be a letter or a digit, so "on it" is found in "ok, on it"
   and not in "money". */
function phraseFound(haystack, phrases) {
  return phrases.some((p) => new RegExp('(^|[^a-z0-9])' + p.replace(/ /g, '[^a-z0-9]+') +
    '($|[^a-z0-9])').test(haystack));
}

/* What a reply MEANS. 'accepted', 'declined', or 'unclear' — and unclear
   is a real answer, not a failure: it is what makes the caller ask again
   in words instead of guessing. Exported so the tests can put a table of
   real replies through it. */
function classifyReply(text) {
  const t = replyWords(text);
  if (!t) return 'unclear';
  /* The phrases first: "no problem" and "not available" both begin with a
     word that also carries the opposite meaning on its own, and the
     longer phrase is the one the person actually meant. */
  if (phraseFound(t, NO_PHRASES)) return 'declined';
  if (phraseFound(t, YES_PHRASES)) return 'accepted';
  const first = t.split(' ')[0];
  if (NO_WORDS.indexOf(first) !== -1) return 'declined';
  if (YES_WORDS.indexOf(first) !== -1) return 'accepted';
  /* Neither a yes nor a no, but it names a DAY — which is an answer to
     the handover, just not to the question we asked. "Can I come on
     Saturday?" is not a yes and must not be recorded as one; it is also
     not an unreadable reply, and asking the worker to say YES or NO when
     they have already told us when they can come is how a machine reads
     as a machine. */
  if (timeIn(text)) return 'proposed';
  return 'unclear';
}

/* A reply that mentioned a job by its reference is about THAT job, and it
   wins over everything below — which is how a worker with three open
   jobs answers without being asked. */
function referenceIn(text) {
  const m = /AZ-C-[A-Z0-9-]+/i.exec(String(text || ''));
  return m ? m[0].toUpperCase() : '';
}

/* The statuses in which a "yes" or a "no" is an answer about the job
   this worker is on. Anything else — a finished claim, a withdrawn one —
   is not something a reply can move. */
const REPLYABLE = ['assigned', 'in_progress'];

/* WHAT THE WORKER IS TOLD BACK. Their own channel, the same door the
   handover went out on, and never a second message: one reply, one
   answer. `when` is the day or time the reply carried, and it changes
   what they are told rather than being swallowed: a worker who says
   when they can come has told us something worth repeating back. */
function workerAck(kind, claim, when, said) {
  const head = 'Arzuz Care \u2014 job ' + claim.reference;
  /* What we tell them we passed on is THEIR OWN words, quoted back — not
     the single word this file matched to notice there was a day in the
     reply. "We have passed \"saturday\" to the customer" is a machine
     reading its own notes back. */
  const quote = String(said || '').trim() || String(when || 'the time you gave');
  if (kind === 'accepted') {
    return head + '\n\nThank you \u2014 that is recorded and the job is yours.' +
      (when ? ' The customer has been told what you said about the time: \u201c' + quote +
        '\u201d, so they know when to expect you.' : '') +
      ' The customer has your number and you have theirs. Pay is the same as always: we settle ' +
      'against this job once the customer confirms the work. If anything changes, reply here.';
  }
  if (kind === 'proposed') {
    return head + '\n\nThank you \u2014 we have passed this to the customer: \u201c' + quote +
      '\u201d, so they know when to expect you.' +
      /* The job is not theirs to hold on a question, and saying it is
         would be answering their own question for them. */
      (['assigned', 'in_progress'].indexOf(claim.status) === -1
        ? ' The job is not yours yet \u2014 somebody here will confirm it with you. If you cannot ' +
          'take it after all, reply NO, and nothing is held against you.'
        : ' The job is still yours. If the day turns out not to work, tell us here and we will ' +
          'sort it out with the customer.');
  }
  if (kind === 'already') {
    return head + '\n\nAlready noted \u2014 nothing more for you to do on this one.';
  }
  if (kind === 'declined') {
    return head + '\n\nThank you for saying \u2014 we have taken you off this job and will find somebody ' +
      'else. Nothing is held against you: a no said early is worth more than a no said on the day. ' +
      'If your plans change, reply YES and we will put you back on it if it is still open.';
  }
  return head + '\n\nWe could not tell from that whether the job is yours. Reply YES if you are ' +
    'taking it, or NO if you cannot \u2014 one word is enough, and the customer is waiting on a name.';
}

/* The customer who was TOLD A NAME is told the name is gone — whether the
   worker said no, or said nothing at all and the clock took it back. Not
   the worker's words, and not our difficulty: what changes for them, and
   that nothing about the money or the cover has moved.

   The TWO causes are told apart in the one sentence that differs, because
   they are different things to hear: one is a worker who cannot come, the
   other is a worker nobody could reach. A customer told the wrong one
   rings the office about a person who never did anything wrong. */
function handoverBackCopy(claim) {
  const issue = String(claim.issue || '').trim();
  const unanswered = claim.provider_answer === 'unanswered';
  return 'Arzuz Care \u2014 claim ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.student_name) + ' \u2014 an update on this repair: ' +
    (unanswered
      ? 'we could not get a confirmation out of ' + claim.provider_name +
        ', the worker we named for it, so the job has gone to somebody else.'
      : claim.provider_name + ', the worker we named for it, is not able to take the job after all.') +
    '\n\n' +
    (issue ? 'What: ' + issue + '\n' : '') +
    'Nothing changes for you: the repair is still covered by your pass, nothing has been charged to ' +
    'you, and the call-out this claim holds stays where it is. We are naming somebody else, and we ' +
    'will message you their name and number the same way we did this one.\n\n' +
    'If you had already agreed a time with them, reply to this number and we will sort it out. ' +
    'Your pass link has the full record of this claim.';
}

/* THE CUSTOMER WHO WAS TOLD A WORKER IS COMING, AND NOW KNOWS WHEN. The
   day is the worker's OWN WORDS, quoted rather than turned into a date:
   "Saturday morning" is a promise about which half of a day, and printing
   it as a computed appointment would be this site inventing a time the
   worker never named — the one thing worse than no time at all, because
   somebody would rearrange their morning around it. */
function workerProposedCopy(claim) {
  const issue = String(claim.issue || '').trim();
  return 'Arzuz Care \u2014 claim ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.student_name) + ' \u2014 ' + claim.provider_name +
    ', the worker on this repair, has suggested when they can come.\n\n' +
    (issue ? 'What: ' + issue + '\n' : '') +
    'They said: "' + String(claim.provider_proposal || '').replace(/["\u201c\u201d]/g, '') + '"\n\n' +
    'That is what they told us, in their own words — not a booked appointment, and they may ring ' +
    'to settle the exact time with you. If it does not suit you, reply to this number with a day ' +
    'that does, and we will pass it on.\n\n' +
    'Nothing else has changed: the work is covered by your pass, and we pay the provider. ' +
    'Your pass link has the full record of this claim.';
}

/* The open jobs a reply could be about, found by the number it came FROM
   — the only identifier a WhatsApp message carries.

   The number is compared as a NUMBER, not as the string the worker typed
   it in: the same person stored as 08031119999 and replying from
   2348031119999 is one human being, and an exact match on the raw column
   would miss them. `actionAssign` normalises on the way IN, so the exact
   lookup is the normal case; the wider lookup by the last ten digits is
   for a row written before that — or by hand in the SQL editor — and it
   is a net rather than a decision, because every row it returns is still
   put through the same comparison. A reply that finds no job is a call
   nobody knows to make. */
async function claimsForWorker(phone) {
  const exact = await sb('repair_claims?select=*&provider_phone=eq.' + encodeURIComponent(phone) +
    '&order=created_at.desc&limit=20', { method: 'GET' });
  const mine = (Array.isArray(exact) ? exact : [])
    .filter((c) => normalizePhone(c.provider_phone) === phone);
  if (mine.length) return mine;

  const loose = await sb('repair_claims?select=*&provider_phone=like.*' +
    encodeURIComponent(phone.slice(-10)) + '&order=created_at.desc&limit=20', { method: 'GET' });
  return (Array.isArray(loose) ? loose : [])
    .filter((c) => normalizePhone(c.provider_phone) === phone);
}

/* Record it, page whoever needs to act, and answer the person who wrote.
   Returns a shape the caller (the inbound webhook) can log and answer
   with, and the tests can read. Nothing here throws: a reply that cannot
   be recorded is a fact the webhook logs, not an exception into whatever
   delivered it. */
async function workerReply(inbound) {
  const phone = normalizePhone((inbound && inbound.phone) || '');
  if (!phone) return { handled: false, reason: 'no-number' };

  const text = String((inbound && inbound.text) || '').slice(0, 600);
  const said = text.trim().slice(0, 300);
  const answer = classifyReply(text);

  const mine = await claimsForWorker(phone);

  const quoted = referenceIn(text);
  let claim = null;
  let why = '';

  if (quoted) {
    claim = mine.filter((c) => String(c.reference || '').toUpperCase() === quoted)[0] || null;
    if (!claim) why = 'unknown-job';
  }

  if (!claim && !quoted) {
    const open = mine.filter((c) => REPLYABLE.indexOf(c.status) !== -1);
    if (open.length === 1) claim = open[0];
    else if (open.length > 1) why = 'several-jobs';
    else {
      /* The change of mind, which is the one thing a declined job can
         still receive: we asked, they said no, and nobody has replaced
         them yet — so "actually, yes" is a true answer and putting them
         back on is what the operator would do by hand. */
      const back = mine.filter((c) => c.status === 'approved' && NOT_ON_THE_JOB.indexOf(c.provider_answer) !== -1);
      if ((answer === 'accepted' || answer === 'proposed') && back.length === 1) claim = back[0];
    }
  }

  if (!claim) {
    /* Silence is the answer to a message from a number we asked nothing,
       and the words to a worker whose message we could not place. */
    const note = why === 'several-jobs'
      ? 'You have more than one job open with us \u2014 reply with the reference, like ' +
        'AJ-C-0000, or tell us which address, and we will take it from there.'
      : why === 'unknown-job'
        ? 'We cannot find that job against this number. Reply with the address instead and we will ' +
          'look it up.'
        : '';
    return {
      handled: false, reason: why || 'no-open-job', claim: null, answered: null,
      replied: note ? await deliverWhatsApp(phone, 'Arzuz Care' + '\n\n' + note) : 'none',
    };
  }

  const at = new Date().toISOString();
  const wasDeclined = NOT_ON_THE_JOB.indexOf(claim.provider_answer) !== -1;
  /* The day or time this reply carries, if any: 'proposed' as an answer,
     or an extra fact on top of a yes ("yes, I can do Saturday"). */
  const when = timeIn(text);
  const plan = await planById(claim.plan_id);

  /* Already answered, and the same answer again: recorded, acknowledged,
     and NOT a second row and a second page. A worker who taps twice on
     "ok" has not changed anything; nor has one who sends a second no, or
     the same day twice — a day that has not changed is not news. A day
     that HAS changed is a new fact about when somebody is coming, and it
     does go out again. */
  const sameAgain = (when && claim.provider_proposal === said) ||
    (claim.provider_answer === answer && !when) ||
    (answer === 'declined' && NOT_ON_THE_JOB.indexOf(claim.provider_answer) !== -1);
  if (sameAgain) {
    return {
      handled: true, reason: 'already-answered', claim: claim.reference,
      answered: claim.provider_answer,
      replied: await deliverWhatsApp(phone, workerAck('already', claim)),
    };
  }

  if (answer === 'unclear') {
    /* The words are still evidence: somebody was asked, and this is what
       they sent instead of an answer. On the trail, and the team is NOT
       paged about it \u2014 an unreadable reply is a question we re-ask, not
       a call somebody owes. */
    await trail(claim, 'note', claim.status, {
      reason: (claim.provider_name || 'The worker') + ' replied to the handover with something that ' +
        'was not a yes or a no, so the question was asked again' +
        (said ? ': "' + said + '"' : '') + '.',
      actor_name: claim.provider_name, actor_role: 'worker',
    });
    return {
      handled: true, reason: 'unclear', claim: claim.reference, answered: null,
      replied: await deliverWhatsApp(phone, workerAck('unclear', claim)),
    };
  }

  /* ACCEPTED, AND/OR A DAY. Neither is a refusal, so the job does not
     leave anybody: a yes keeps it with the worker who was named, and a
     day offered by somebody holding the job leaves it exactly where it
     is. Both facts are recorded on the row, one row goes on the trail
     naming whichever was the news, and a day is ALSO told to the
     customer — they are the person who has to be in when the worker
     comes.

     A proposal is NOT an acceptance: "can I come Saturday?" is a
     question, and recording it as "has confirmed the job" would be
     answering it for them. The panel reads "has not answered yet"
     beside a name that has suggested a day, which is exactly what is
     true — the customer can see when, and nobody has been told the
     worker agreed to anything.

     A day from somebody who had ALREADY turned the job down (when the
     status is 'approved', nobody on it) is recorded and handed to the
     team rather than acted on: putting a job back on somebody on the
     strength of a question is the operator's call, not this door's. */
  if (answer === 'accepted' || answer === 'proposed') {
    const accepted = answer === 'accepted';
    const holdsIt = ['assigned', 'in_progress'].indexOf(claim.status) !== -1 || accepted;
    const body = {};
    if (holdsIt) body.status = 'assigned';
    if (accepted) {
      body.provider_answer = 'accepted';
      body.provider_answered_at = at;
      body.provider_answer_note = said || null;
    }
    if (when) {
      body.provider_proposal = said;
      body.provider_proposed_at = at;
    }
    await patch(claim.id, body);
    await trail(claim, accepted ? 'accepted' : 'proposed', holdsIt ? 'assigned' : claim.status, {
      from: claim.status,
      reason: accepted
        ? (claim.provider_name || 'The worker') + ' replied that the job is theirs' +
          (wasDeclined ? ', having turned it down first' : '') +
          (when ? ', and said when: "' + said + '"' : (said ? ': "' + said + '"' : '')) + '.'
        : holdsIt
          ? (claim.provider_name || 'The worker') + ' replied with a day rather than a yes or a no: "' +
            said + '". The job stays theirs — nobody has refused it — and the customer has been told ' +
            'what they suggested.'
          : (claim.provider_name || 'The worker') + ', who turned this job down, came back with a day ' +
            'instead: "' + said + '". Nothing was put back on them — a day is an offer, not an answer — ' +
            'so the claim is still approved with nobody on it, and naming them again is the team\u2019s ' +
            'call.',
      actor_name: claim.provider_name, actor_role: 'worker',
    });

    /* The customer, when a day has been suggested by somebody who is
       actually on the job. An acceptance on its own tells them nothing
       new: they were already told who is coming. And a worker who had
       turned it down is not announced to them a second time on a maybe —
       they were told the name had gone, and that stays true until a
       person decides otherwise. */
    const tellsTheCustomer = !!when && holdsIt;
    const told = tellsTheCustomer
      ? await tryNotify(Object.assign({}, claim, {
        status: 'assigned', provider_proposal: said, provider_proposed_at: at,
      }), plan, 'proposed', { student: workerProposedCopy(
        Object.assign({}, claim, { provider_proposal: said })) })
      : { channels: {}, undelivered: [] };

    /* Somebody is waiting on an answer we cannot give: the day is real
       information for a person to act on, and the office is the only
       place that can turn it into an appointment. */
    if (!tellsTheCustomer && when) {
      await sendAlert('\u23f0 A worker who is not on the job offered a day\n' + claim.reference + '\n' +
        (claim.provider_name || 'the worker') + ' \u00b7 ' + (claim.provider_phone || phone) +
        '\nThey said: "' + said.slice(0, 160) + '"' +
        '\nThe claim is still ' + claim.status + ' with nobody on it. Name them again if the day works.');
    }

    return {
      handled: true,
      reason: accepted ? (wasDeclined ? 'reinstated' : 'accepted') : 'proposed',
      claim: claim.reference, answered: accepted ? 'accepted' : null,
      student_told: told.channels,
      replied: await deliverWhatsApp(phone, workerAck(accepted ? 'accepted' : 'proposed', claim, when, said)),
    };
  }

  /* DECLINED \u2014 and this is the one path that takes the job back, whether
     the worker said no or (see handoverBack below) never said anything. */
  const back = await unhandJob(claim, {
    at: at,
    answer: 'declined',
    note: said,
    reason: (claim.provider_name || 'The worker') + ' turned this job down' +
      (said ? ': "' + said + '"' : '') +
      '. The claim is back to approved \u2014 covered, with nobody on it \u2014 and a worker must be ' +
      'named again.',
    actor_name: claim.provider_name, actor_role: 'worker',
  });

  /* A call somebody owes, in the same class as a notice that did not
     arrive. The claim is not lost — it is back in the queue with a
     fresh 24 hours — but the job that was thought to be moving has
     stopped, and nobody is looking at the dashboard at that moment. */
  await sendAlert('\u26a0\ufe0f A worker turned a job down\n' + claim.reference + '\n' +
    (claim.provider_name || 'the worker') + ' \u00b7 ' + (claim.provider_phone || phone) +
    (said ? '\nThey said: "' + said.slice(0, 160) + '"' : '') +
    '\nNobody is on this job now \u2014 it is back in the queue and needs another worker.' +
    (back.told_before ? '\nThe customer has been told and is waiting on a new name.' : ''));

  return {
    handled: true, reason: 'declined', claim: claim.reference, answered: 'declined',
    student_told: back.channels, replied: await deliverWhatsApp(phone, workerAck('declined', claim)),
  };
}

/* ------------------------------------------------------------
   HANDING THE JOB BACK, and the clock that gets there first

   THE ONE PLACE A JOB LEAVES A WORKER. Two things arrive here: the
   worker saying no, and the clock acting on a silence. They must leave
   the claim in exactly the same state, so they are the same function —
   and the only differences are the words: the answer recorded, the
   reason on the trail, and what the customer is told.
   ------------------------------------------------------------ */

async function unhandJob(claim, opts) {
  const at = opts.at || new Date().toISOString();
  const plan = await planById(claim.plan_id);

  /* The claim goes back to 'approved' — the status that already means
     "covered, and somebody must be found" — so the queue's own count, its
     clock (24h, name a worker) and its buttons all treat it as the job it
     now is, with no new state for anybody to learn. The name, the number
     and the words stay on the row: they are why the next person to read
     this knows who to ask and who not to. */
  await patch(claim.id, {
    status: 'approved',
    provider_answer: opts.answer,
    provider_answered_at: at,
    provider_answer_note: opts.note ? String(opts.note).slice(0, 300) : null,
  });
  await trail(claim, opts.answer, 'approved', {
    from: claim.status,
    reason: opts.reason,
    actor_name: opts.actor_name || claim.provider_name,
    actor_role: opts.actor_role || 'worker',
  });

  /* The customer, if they had been told a name. `studentAssignedCopy` was
     sent when the worker was named; the answer to "was the customer ever
     told?" is the trail, so that is what decides whether there is
     anything to un-tell — never a guess about whether the message got
     through. */
  const toldBefore = await wasToldAboutHandover(claim.id);
  const told = toldBefore
    ? await tryNotify(claim, plan, opts.answer, {
      student: handoverBackCopy(Object.assign({}, claim, {
        status: 'approved', provider_answer: opts.answer,
      })),
    })
    : { channels: {}, undelivered: [] };

  return { channels: told.channels, told_before: toldBefore };
}

/* WHAT THE WORKER IS ASKED WHEN THE JOB HAS GONE QUIET. One message, once
   (the clock's 'chased' row is what keeps it once), and it says what
   happens next out loud — a job taken back without warning is how a
   worker stops answering at all. */
function chaseCopy(claim, hours) {
  const where = [claim.property, claim.room].filter((x) => !!x).join(' \u00b7 ');
  return 'Arzuz Care \u2014 job ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.provider_name) + ' \u2014 we named you on this repair' +
    (hours ? ' about ' + hours + ' hours ago' : '') + ' and have not heard back, so we are checking: ' +
    'is it yours?\n\n' +
    'What: ' + (claim.issue || 'see the job sheet') + '\n' +
    (where ? 'Where: ' + where + '\n' : '') +
    'Customer: ' + firstName(claim.student_name) + ' \u00b7 ' +
      (claim.student_phone || 'ask us for the number') + '\n\n' +
    'One word is enough \u2014 reply YES if you are taking it, or NO if you cannot. If we do not hear ' +
    'from you we will give the job to somebody else, because a tenant cannot be left waiting on a ' +
    'knock that may not come. A day is fine too: tell us when you can come and we will pass it on.';
}

/* What the worker is told when we have taken it back \u2014 so nobody turns
   up to a flat with somebody else already in it. */
function takenBackCopy(claim) {
  return 'Arzuz Care \u2014 job ' + claim.reference + '\n\n' +
    'Hello ' + firstName(claim.provider_name) + ' \u2014 we asked you whether this job was yours and ' +
    'have not heard back, so we have given it to somebody else. Nobody is waiting on you for it.\n\n' +
    'That is not a mark against you, and there is nothing to pay: the tenant needed a date and we could ' +
    'not give them one. Reply here if you want to be considered for the next one.';
}

/* THE ASK. Returns what the WhatsApp channel said, so a run that could not
   reach the worker is visible in the log and on the trail rather than
   reading as an answered question. */
async function handoverQuiet(claim, hours) {
  const out = await deliverWhatsApp(claim.provider_phone, chaseCopy(claim, hours));
  await trail(claim, 'chased', claim.status, {
    reason: 'Nobody had answered the handover, so the worker was asked once whether the job is theirs (' +
      out + ').',
    actor_name: 'the handover clock', actor_role: 'system',
  });
  return out;
}

/* THE JOB COMES BACK, on the clock's terms: the same outcome as a refusal,
   said in the words the truth needs, and told to the worker as well as to
   the team.

   THE ROW IS RE-READ FIRST, and that is the whole safety of this door. A
   scheduled run decides who to chase from a page it read minutes ago; in
   between, the worker may have answered — or the office may have moved
   the claim on. Taking a job back from somebody who said yes while the
   clock was thinking is the one mistake here that costs a visit, so it is
   the row now that decides, not the row it started with. */
async function handoverBack(claim) {
  const now = await claimById(claim.id);
  if (!now || now.status !== 'assigned') {
    return { channels: {}, told_before: false, skipped: now ? 'status ' + now.status : 'gone' };
  }
  if (now.provider_answer || now.provider_proposal) {
    /* Answered — including with a day, which is somebody speaking. Nothing
       is taken back from a worker who has been heard from. */
    return { channels: {}, told_before: false, skipped: 'answered' };
  }
  claim = now;
  const back = await unhandJob(claim, {
    answer: 'unanswered',
    note: 'Nothing back from the worker, then or now.',
    reason: (claim.provider_name || 'The worker') + ' never answered the handover, or the one ask that ' +
      'followed it, so the job was taken back. The claim is back to approved \u2014 covered, with nobody ' +
      'on it \u2014 and a worker must be named again.',
    actor_name: 'the handover clock', actor_role: 'system',
  });
  await sendAlert('\u26a0\ufe0f A job was taken back from a worker who never answered\n' + claim.reference +
    '\n' + (claim.provider_name || 'the worker') + ' \u00b7 ' + (claim.provider_phone || 'no number') +
    '\nThey were named, asked once, and said nothing.' +
    '\nNobody is on this job now \u2014 it is back in the queue and needs another worker.' +
    (back.told_before ? '\nThe customer has been told and is waiting on a new name.' : ''));
  await deliverWhatsApp(claim.provider_phone, takenBackCopy(claim));
  return back;
}

/* Was the customer ever sent a handover for this claim? The trail is the
   only honest source: the 'notified' row carries the channels, and the
   handover's own row is the one that names the student channel. Reading
   it means a decline never sends a "the worker we named is not coming"
   message to somebody who was never told a worker was named. */
async function wasToldAboutHandover(claimId) {
  try {
    const rows = await sb('claim_events?select=event,reason,created_at&claim_id=eq.' +
      encodeURIComponent(claimId) + '&event=eq.notified&order=created_at.desc&limit=20',
    { method: 'GET' });
    return (Array.isArray(rows) ? rows : []).some((r) => {
      const why = String(r.reason || '');
      return why.indexOf('handover') !== -1 && /student_whatsapp: sent|student_email: sent/.test(why);
    });
  } catch (err) {
    /* Unreadable trail: assume the customer knows, because the cost of
       the wrong guess is asymmetrical — a needless "we are naming someone
       else" is a nuisance, and leaving somebody waiting for a worker who
       has said no is the complaint. */
    console.error('[claims] the handover trail could not be read:', err && err.message);
    return true;
  }
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
    return json(503, { error: 'Claims need SUPABASE_SERVICE_ROLE_KEY in Netlify before they can write anything.' }, 'not-ready');
  }

  /* THE STUDENT'S DOOR — the pass link is the credential, and the
     actions here cannot approve, spend money or close anything. */
  if (STUDENT_ACTIONS.indexOf(action) !== -1) {
    const ip = (headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    if (limited('claims-ip:' + ip, 60)) {
      return json(429, { error: 'That is a lot of claim attempts in a minute — wait a moment and try again.' });
    }
    try {
      const plan = await planFromToken(body);
      if (!plan) {
        return json(404, { error: 'We do not recognise that Care link. Message us and we will send it again.' }, 'rejected');
      }
      const out = action === 'list' ? await actionList(plan)
        : action === 'create' ? await actionCreate(plan, body)
          : action === 'confirm' ? await actionConfirm(plan, body)
            : action === 'dispute' ? await actionDispute(plan, body)
              : action === 'agree_day' ? await actionAgreeDay(plan, body)
                : action === 'propose_day' ? await actionProposeDay(plan, body)
                  : await actionCancel(plan, body);
      return json(out.status, out.body, out.kind);
    } catch (err) {
      if (missingTable(err)) {
        console.error('[claims] the claims tables are missing');
        return json(503, {
          error: 'Claims are not switched on for this site yet. Nothing is wrong with your pass — message us on WhatsApp and we will sort it out.',
        }, 'not-ready');
      }
      console.error('[claims] ' + action + ' failed:', err && err.message);
      return json(502, { error: 'We could not do that just now. Try again in a moment.' });
    }
  }

  /* THE TEAM'S DOOR. */
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const user = await liveUser(token);
  if (!user) return json(401, { error: 'Sign in to the Arzuz dashboard to work with claims.' }, 'expired');

  const role = await roleOf(token);
  if (role !== 'admin' && role !== 'support') {
    console.log('[claims] refused role:', role || '(unknown)');
    return json(403, { error: 'Only the admin and support logins may open the claim queue.' });
  }
  const actor = { id: user.id, name: (user.email || '').split('@')[0] || 'a team member', role: role };

  if (ADMIN_ONLY.indexOf(action) !== -1 && role !== 'admin') {
    return json(403, { error: 'Only the admin login may decide coverage, record a cost or close a claim.' });
  }

  if (limited(user.id, 120)) {
    return json(429, { error: 'That is a lot of claim changes in a minute — try again shortly.' });
  }

  try {
    const out = action === 'queue' ? await actionQueue(actor, body)
      : action === 'decide' ? await actionDecide(actor, body)
        : action === 'assign' ? await actionAssign(actor, body)
          : action === 'progress' ? await actionProgress(actor, body)
            : action === 'report_work' ? await actionReportWork(actor, body)
              : action === 'resolve' ? await actionResolve(actor, body)
                : action === 'settle_payout' ? await actionSettlePayout(actor, body)
                  : null;
    if (!out) {
      return json(400, {
        error: 'Unknown action. Student (with a pass link): ' + STUDENT_ACTIONS.join(', ') +
          '. Team: queue, decide, assign, progress, report_work, resolve, settle_payout.',
      });
    }
    return json(out.status, out.body, out.kind);
  } catch (err) {
    console.error('[claims] ' + action + ' failed:', err && err.message);
    return json(502, { error: 'The claim could not be recorded: ' + ((err && err.message) || 'unknown error') });
  }
};

exports.STATUSES = STATUSES;
exports.CANCELLABLE = CANCELLABLE;
exports.ADMIN_ONLY = ADMIN_ONLY;
exports.STUDENT_ACTIONS = STUDENT_ACTIONS;
exports.studentClaim = studentClaim;
exports.reference = reference;
exports.reserveCallout = reserveCallout;
exports.releaseCallout = releaseCallout;
/* The clock, shared with the scheduled nudge so there is ONE definition
   of how long each status may stand. claims-aging.js reads these rather
   than keeping a second table in step by hand. */
exports.CLOCK = CLOCK;
/* The worker's own door, called by netlify/functions/wa-inbound.js when
   OpenWA delivers a reply. Required rather than re-implemented for the
   same reason claims.js requires whatsapp-send.js: one implementation of
   "what a reply to a handover means", and one place that writes it. */
exports.workerReply = workerReply;
exports.claimsForWorker = claimsForWorker;
exports.classifyReply = classifyReply;
exports.referenceIn = referenceIn;
exports.workerAck = workerAck;
exports.handoverBackCopy = handoverBackCopy;
exports.workerProposedCopy = workerProposedCopy;
/* The handover's second half, driven by claims-aging.js. Exported rather
   than re-implemented there for the same reason workerReply is: what
   happens to a claim when the job goes quiet is ONE decision, written
   once, whether it was a person or the clock that reached it. */
exports.HANDOVER = HANDOVER;
exports.handoverQuiet = handoverQuiet;
exports.handoverBack = handoverBack;
exports.chaseCopy = chaseCopy;
exports.takenBackCopy = takenBackCopy;
exports.agingOf = agingOf;
/* The visit-day reader and its vocabulary, exported for the daily digest
   (claims-digest.js) — one definition of "agreed" between the number on
   the queue and the number in the message, or the two drift. */
exports.dayStateOf = dayStateOf;
exports.dayCounts = dayCounts;
exports.visitsToCome = visitsToCome;
exports.VISIT_STATUSES = VISIT_STATUSES;
exports.statusSinceFor = statusSinceFor;
exports.ABOUT_EVENT = ABOUT_EVENT;
exports.byPain = byPain;
exports.trail = trail;
