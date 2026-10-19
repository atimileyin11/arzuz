/* ============================================================
   Arzuz — Netlify Function: the claim aging clock

   WHAT THIS IS

     The queue in the dashboard puts an overdue claim at the top, which
     helps whoever happens to open it. This is for the days nobody does.
     It runs on a schedule, finds every claim that has stood in one
     status past the deadline for that status, and tells the team on
     Telegram — ONCE per crossing, not once an hour.

   HOW "ONCE" IS KEPT

     Not with a flag on the claim. A nudge writes a real row to the
     claim's own trail (event 'overdue_nudge'), and this job only speaks
     about a crossing that has no such row since the claim entered its
     current status. A claim that is nudged, then moved on, then goes
     overdue again in its new status gets nudged again — because that is
     a new lateness. A claim that is nudged and stays late goes quiet,
     which is the point: the second morning's message would say nothing
     new, and a channel that cries every hour is one nobody reads.

   WHY IT IS A TIMER AND NOT PART OF THE QUEUE

     A read is not allowed to have side effects. Reading the queue five
     times would send five messages, and the panel would be the thing
     that pages you. So the clock lives here, on its own schedule, and
     the queue only ever READS the same numbers.

   THE ONE THING IT SHOUTS ABOUT BESIDES A CLAIM

     A run that could not read the database at all. A job that stops
     working does it silently, and the whole reason this exists is that
     nobody is watching the dashboard.

   Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
   and TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID for the message itself.

   Schedule: netlify.toml → [functions."claims-aging"] (hourly).
   ============================================================ */

const { sb, cfg } = require('./roommate-match.js');
const { sendAlert, esc } = require('./notify.js');
/* The site's ONE classifier of a failed call — the same module the pages
   and the verification clock read, so one failure reads the same
   everywhere (and a missing migration reads as the deploy fact it is). */
const ApiErrors = require('../../assets/api-errors.js');
const { CLOCK, HANDOVER, agingOf, statusSinceFor, handoverQuiet, handoverBack } = require('./claims.js');

/* Every status that is on a clock, from the one table that defines
   them — so adding a status to the clock in claims.js adds it here. */
const CLOCKED_STATUSES = Object.keys(CLOCK);

/* A page at a time. This is a small operator's queue; the cap is here so
   a runaway table cannot turn one run into a thousand queries. */
const PAGE = 200;
const MAX_PAGES = 5;

/* OPS-ALERT COOLDOWN — the same one the verification clock keeps (see
   netlify/functions/verification-aging.js): the log line fires every
   run, but the phone only fires for a new failure or an old reminder.
   An hourly "the clock could not run" about the same un-run migration
   is how the channel gets muted. Per function instance. */
var lastOpsAlertAt = {};
function opsAlertDue(key, kind, now) {
  var at = now || Date.now();
  var cool = kind === 'not-ready' ? 24 * 3600 * 1000 : 6 * 3600 * 1000;
  var last = lastOpsAlertAt[key] || 0;
  if (at - last < cool) return false;
  lastOpsAlertAt[key] = at;
  return true;
}

/* Both a missing claims migration and a rejected service key can surface
   while the scheduled function reads the queue. Never tell an operator to
   run SQL for an invalid Netlify credential. */
function clockFailure(err) {
  const kind = ApiErrors.kindOf(err);
  const detail = ApiErrors.detail(err);
  let action;
  if (err && (err.credentialRefused || err.status === 401 || err.status === 403)) {
    action = 'Supabase refused the service key this deploy holds. Check SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL in Netlify; replace it with a key from this same Supabase project, then redeploy.';
  } else if (kind === 'not-ready') {
    action = 'Supabase could not find a required claims relation. Verify the claims migration and deployed function version before applying SQL.';
  } else if (kind === 'offline') {
    action = 'Supabase could not be reached from this function; check project/network status before changing keys.';
  } else {
    action = 'Check the Supabase response and function logs; do not retry a payout until the database is healthy.';
  }
  return { kind: kind, detail: detail, action: action };
}

async function openClaims() {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await sb(
      'repair_claims?select=*&status=in.(' + CLOCKED_STATUSES.join(',') +
        ')&order=created_at.asc&limit=' + PAGE + '&offset=' + (page * PAGE),
      { method: 'GET' }
    );
    const list = Array.isArray(batch) ? batch : [];
    rows.push.apply(rows, list);
    if (list.length < PAGE) break;
  }
  return rows;
}

/* What this clock has already done to these claims — read once, so the
   decisions "have we said this before" and "have we asked yet" are
   lookups rather than messages. Two event kinds in one read because they
   answer the same question about the same claim: the nudge we already
   sent, and the ask the worker already got. */
async function alreadyFor(ids) {
  const out = { nudge: {}, chase: {} };
  if (!ids.length) return out;
  const rows = await sb(
    'claim_events?select=claim_id,created_at,event&claim_id=in.(' + ids.join(',') +
      ')&event=in.(overdue_nudge,chased)&order=created_at.desc',
    { method: 'GET' }
  );
  for (const e of (Array.isArray(rows) ? rows : [])) {
    const bucket = e.event === 'chased' ? out.chase : out.nudge;
    if (!bucket[e.claim_id]) bucket[e.claim_id] = e.created_at;
  }
  return out;
}

/* ------------------------------------------------------------
   THE HANDOVER'S SECOND HALF — the ask, then the reclaim

   A claim that was handed to somebody with nobody answering it is the
   one lateness this clock can DO something about rather than talk
   about, and the state it acts on is deliberately small:

     · the claim is 'assigned' — the job is on somebody's name
     · and NOT A WORD has come back: no yes, no no, and no day offered.
       A worker who says "I can come Saturday" HAS answered, and asking
       them whether the job is theirs would be a machine that was not
       listening.

   The two moves are the ones a person would make by hand, in the same
   order: ASK ONCE when the claim crosses its own assigned deadline (the
   same crossing the team is nudged about — a job nobody has accepted is
   not a job that is moving), then, if that ask is still unanswered
   HANDOVER.reclaim_after_hours later, give the job to somebody else by
   the same door a refusal goes through (claims.handoverBack).

   Nothing here re-implements either move: the words, the row, the
   customer's notice and the page to the team all live in claims.js, so
   the clock and a person cannot end up doing two different things to the
   same claim.
   ------------------------------------------------------------ */

function handoverWork(claims, since, asked, at) {
  const out = [];
  for (const claim of claims) {
    if (claim.status !== 'assigned') continue;
    /* Heard from: a word, a no, or a day. Not a silence. */
    if (claim.provider_answer || claim.provider_proposal) continue;
    const started = new Date(since[claim.id] || claim.assigned_at || claim.created_at).getTime();
    const askedAt = asked[claim.id] ? new Date(asked[claim.id]).getTime() : null;
    if (askedAt === null) {
      const hours = (at.getTime() - started) / 3600000;
      if (hours >= CLOCK.assigned.hours) {
        out.push({ claim: claim, due: 'ask', hours: Math.round(hours) });
      }
      continue;
    }
    const sinceAsk = (at.getTime() - askedAt) / 3600000;
    if (sinceAsk >= HANDOVER.reclaim_after_hours) {
      out.push({ claim: claim, due: 'reclaim', hours: Math.round(sinceAsk) });
    }
  }
  return out;
}

/* The work, with the clock injectable so the tests can stand at a chosen
   instant instead of waiting for one. */
async function collect(now) {
  const at = now ? new Date(now) : new Date();
  const claims = await openClaims();
  if (!claims.length) return { at: at.toISOString(), overdue: [], fresh: [] };

  const since = await statusSinceFor(claims);
  const already = await alreadyFor(claims.map((c) => c.id));

  const overdue = [];
  const fresh = [];
  for (const claim of claims) {
    const aging = agingOf(claim, since[claim.id], at);
    if (!aging || !aging.overdue) continue;
    const row = Object.assign({}, claim, { aging: aging });
    overdue.push(row);
    /* Said already, and nothing has happened since: quiet. */
    const told = already.nudge[claim.id];
    const wasToldForThisStatus = told && new Date(told).getTime() >= new Date(aging.status_since).getTime();
    if (!wasToldForThisStatus) fresh.push(row);
  }

  return {
    at: at.toISOString(), overdue: overdue, fresh: fresh,
    handover: handoverWork(claims, since, already.chase, at),
  };
}

function nudgeText(fresh) {
  const ours = fresh.filter((c) => c.aging.who === 'ours');
  const theirs = fresh.filter((c) => c.aging.who === 'customer');
  const line = (c) => {
    const waited = c.aging.hours_over >= 48
      ? Math.round(c.aging.hours_over / 24) + ' days'
      : Math.round(c.aging.hours_over) + 'h';
    return '• <b>' + esc(c.reference, 30) + '</b> — ' + esc(c.aging.says, 40) +
      '\n   ' + waited + ' past its ' + c.aging.limit_hours + 'h deadline' +
      ' · ' + esc(c.student_name || 'no name', 40) +
      (c.provider_name ? ' · worker ' + esc(c.provider_name, 40) : '') +
      /* The one thing the numbers cannot say: the worker on it has never
         answered, so this is not a job that is merely slow. */
      (c.status === 'assigned' && !c.provider_answer && !c.provider_proposal
        ? '\n   the handover was never answered' : '');
  };
  let text = '⏳ <b>Claims past their deadline</b>\n\n';
  if (ours.length) {
    text += '<b>Waiting on us</b>\n' + ours.map(line).join('\n') + '\n\n';
  }
  if (theirs.length) {
    /* Kept apart on purpose: this is the team's reminder to CHASE, not a
       failure to act, and reading the two together is how a queue starts
       lying about what is late. */
    text += '<b>Waiting on the customer</b>\n' + theirs.map(line).join('\n') + '\n\n';
  }
  text += 'Open the claim queue in the dashboard to decide coverage, name a worker or close a dispute.';
  return text;
}

const done = (outcome, model, handover) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ok: true, outcome: outcome, overdue: model ? model.overdue.length : 0,
    /* What the clock DID, not only what it found: an ask and a job given
       back are the two things here that change somebody's day. */
    asked: handover ? handover.asked : 0,
    taken_back: handover ? handover.taken_back : 0,
  }),
});

const workSaid = (handover) => {
  if (!handover || (!handover.asked && !handover.taken_back && !handover.failed.length)) return '';
  return '; asked ' + handover.asked + ', took back ' + handover.taken_back +
    (handover.failed.length ? ', ' + handover.failed.length + ' FAILED (' + handover.failed.join(', ') + ')' : '');
};

/* The two moves, one claim at a time, each in its own try: one worker's
   WhatsApp number refusing the message must not stop the reclaims behind
   it, and it must not stop the nudge either. */
async function runHandover(items) {
  const out = { asked: 0, taken_back: 0, failed: [] };
  for (const item of items || []) {
    const claim = item.claim;
    try {
      if (item.due === 'ask') {
        const channel = await handoverQuiet(claim, item.hours);
        out.asked += 1;
        /* The ask is our only way of reaching them, so a channel that did
           not carry it is a call somebody owes NOW — while the reclaim
           window is still open and a person can still save the visit. */
        if (channel !== 'sent') {
          await sendAlert('\u26a0\ufe0f <b>We could not ask the worker whether the job is theirs</b>\n\n' +
            esc(claim.reference, 30) + ' \u00b7 ' + esc(claim.provider_name || 'the worker', 40) +
            '\nThey have not answered the handover in ' + item.hours + 'h, and the ask did not go (' +
            esc(channel, 60) + ').\nRing them: ' + esc(claim.provider_phone || 'no number', 30) +
            '\nIf nothing changes, the job goes to somebody else in ' +
            HANDOVER.reclaim_after_hours + 'h.');
        }
      } else {
        const back = await handoverBack(claim);
        if (back.skipped) {
          /* Answered, or moved on, between the read and the act. Saying so
             is the point: a silent skip is how a clock looks broken. */
          console.log('[claims-aging] left ' + claim.reference + ' alone: ' + back.skipped);
          continue;
        }
        out.taken_back += 1;
      }
    } catch (err) {
      out.failed.push(claim.reference || 'a claim');
      console.error('[claims-aging] the handover work failed for ' + claim.reference + ':',
        err && err.message);
    }
  }

  if (out.failed.length) {
    await sendAlert('\u26a0\ufe0f <b>The handover clock could not do its job</b>\n\n' +
      esc(out.failed.join(', '), 200) +
      '\n\nNobody was asked whether the job is theirs, or a job was not given back. ' +
      'Open the claim queue: these are the claims to do by hand.');
  }
  return out;
}

exports.handler = async function () {
  const { ready } = cfg();
  if (!ready) {
    /* Not configured is a fact about the site, not an error worth a
       message — the same reading as every other scheduled job here. */
    console.log('[claims-aging] skipped: SUPABASE_SERVICE_ROLE_KEY is not set');
    return done('not-configured');
  }

  let model;
  try {
    model = await collect(null);
  } catch (err) {
    const trouble = clockFailure(err);
    console.error('[claims-aging] read failed (' + trouble.kind + '):', trouble.detail);
    var readKey = 'read-failed:' + trouble.kind + ':' + String(trouble.detail || '').slice(0, 120);
    if (opsAlertDue(readKey, trouble.kind)) {
      await sendAlert(
        '⚠️ <b>The claim clock could not run</b>\n\n' +
        '<b>' + esc(trouble.kind, 40) + '</b> — ' + esc(trouble.action, 220) + '\n' + esc(trouble.detail, 300) +
        '\n\nThe dashboard still has every claim — only the deadline check failed.'
      );
    } else {
      console.error('[claims-aging] telegram reminder suppressed — same failure, still inside its cooldown');
    }
    return done('read-failed');
  }

  /* THE HANDOVER FIRST, and before the early return below, because the
     reclaim lands LONG after the crossing that made the claim overdue:
     by then there is nothing new to nudge the team about, and a job that
     was given back would wait for a morning with news in it. */
  const handover = await runHandover(model.handover);

  if (!model.fresh.length) {
    console.log('[claims-aging] quiet: ' + model.overdue.length + ' claim(s) overdue, none newly' +
      workSaid(handover));
    return done('quiet', model, handover);
  }

  const sent = await sendAlert(nudgeText(model.fresh));

  /* The row is written whether or not Telegram was listening, and that is
     the deliberate order: the trail records that the clock REACHED this
     crossing. A site with no Telegram still gets the claim marked, so the
     day the token is set it does not shout about a month of old claims. */
  let recorded = 0;
  for (const claim of model.fresh) {
    try {
      await require('./claims.js').trail(claim, 'overdue_nudge', claim.status, {
        reason: 'Past its deadline for this status by ' + Math.round(claim.aging.hours_over) +
          'h (' + claim.aging.limit_hours + 'h allowed while ' + claim.aging.says + ').',
        data: { hours_over: claim.aging.hours_over, who: claim.aging.who, sent_to_team: sent },
        actor_name: 'the aging clock',
        actor_role: 'system',
      });
      recorded += 1;
    } catch (err) {
      console.error('[claims-aging] could not record the nudge for ' + claim.reference + ':', err && err.message);
    }
  }

  console.log('[claims-aging] ' + (sent ? 'sent' : 'not sent') + ': ' + recorded +
    ' newly overdue of ' + model.overdue.length + ' overdue' + workSaid(handover));
  return done(sent ? 'sent' : 'send-failed', model, handover);
};

/* Exported for the tests: the composition is proved at chosen instants
   rather than by waiting for the hour to turn. */
exports.collect = collect;
exports.nudgeText = nudgeText;
exports.handoverWork = handoverWork;
exports.CLOCKED_STATUSES = CLOCKED_STATUSES;
exports.clockFailure = clockFailure;
/* Resettable so the suite can prove the second identical failure stays
   quiet without waiting out the cooldown. */
exports.opsAlertDue = opsAlertDue;
exports._resetOpsAlerts = function () { lastOpsAlertAt = {}; };
