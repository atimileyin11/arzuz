/* ============================================================
   Arzuz — Netlify Function: the verification clock

   WHAT THIS IS

     The dashboard's queue puts the late listing at the top, which
     helps whoever opens it. This is for the days nobody does — or
     nobody is on shift at all, which is the honest description of a
     two-officer operation. It runs hourly, reads the queue, and pages
     the team about the listings that are past their deadline:
     unvisited rooms, and rooms an officer took and went quiet on.

   HOW "ONCE" IS KEPT

     Not with a flag on the listing. A nudge writes a real row to the
     listing's own trail (verification_events, event 'nudged'), and this
     job only speaks about a lateness that has no such row since the
     listing entered the stage it is in now. A listing that is nudged,
     released and taken again gets its own new chance, because that is a
     new lateness. A listing that is nudged and stays late goes quiet,
     which is the point: an hourly reminder about an unvisited room is a
     channel nobody reads by the third day.

   THE ONE MOVE IT MAKES

     A job an officer took, was told about once, and then said nothing
     about for POLICY.reclaim_after_hours goes BACK TO THE QUEUE. That is
     the same door an officer's own release goes through
     (public.listing_release), with a note saying who did it, so the trail
     cannot tell a clean handover from a reclaim by anything except why —
     which is exactly right: the listing's story is "it is back and
     anybody may take it".

     It is also why the reclaim is safe to automate. Nothing is deleted,
     no decision is reversed, and the listing keeps its tier, its price
     and its place in the board. What the officer loses is the claim, not
     the work they did.

   WHY IT IS A TIMER AND NOT PART OF THE QUEUE

     A read is not allowed to have side effects. Reading the queue five
     times would write five events and send five messages, and the panel
     would be the thing that pages the team. So the clock lives here, on
     its own schedule, and the queue only ever READS the same numbers.

   THE ONE THING IT SHOUTS ABOUT BESIDES A LISTING

     A run that could not read the queue at all. A chaser that stops
     working does it silently, and the whole reason this exists is that
     nobody is watching the dashboard.

   Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
   and TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID for the message itself.

   Schedule: netlify.toml → [functions."verification-aging"] (hourly).
   ============================================================ */

const { sb, cfg } = require('./roommate-match.js');
const { sendAlert, esc } = require('./notify.js');
const ArzuzVerify = require('../../assets/verification-queue.js');
/* The site's ONE classifier of a failed call — the module every page and
   every other function in this repo reads. What it is doing in a timer is
   the section below. */
const ApiErrors = require('../../assets/api-errors.js');

/* The clock and the policy are assets/verification-queue.js — the SAME
   file the dashboard loads. A page that says a listing is late and a
   message that says it is fine would be two copies of one number, which
   is the whole reason the policy is not written here. */
const { POLICY } = ArzuzVerify;

/* ------------------------------------------------------------
   WHICH KIND OF BROKEN, in the site's own vocabulary

   This file used to say what went wrong and stop there, passing the
   database's own sentence straight into a Telegram alert at 3am. The two
   failures it actually meets need OPPOSITE answers and read alike — which
   is the exact confusion assets/api-errors.js was written to end:

     "Could not find the function public.verification_queue … in the schema
      cache"          → the migration has not been run in this project.
                        Nothing anybody does changes that except running the
                        file; next hour's run will fail identically.
     a 502 from the pooler → a bad minute. Next hour is likely fine.

   So the CLASS comes from the shared module and is never re-derived from a
   status number here: one classifier for the site, or the clock and the
   dashboard come to disagree about the same failure. `detail` keeps the
   operator's facts — the status, the code, the database's own sentence —
   instead of paraphrasing them away, because a log line is where those
   belong.

   A timer is still exempt from the WIRE form: no page fetches this and
   nobody is waiting on its answer, which is what the exemption list in
   scripts/test-api-errors.mjs says and why it still holds. Being exempt
   from the wire is not being exempt from knowing what broke.
   ------------------------------------------------------------ */

/* WHAT THE TEAM DOES ABOUT EACH CLASS. The class is the classifier's; what
   a timed job knows and a page cannot is what happens next, which is a
   different task for each of these. A class this file has never seen is
   NAMED as unhandled rather than guessed at, so a vocabulary that grows
   upstream cannot quietly start reading as one of the cases below. */
const WHAT_TO_DO = {
  'not-ready': 'this deploy is missing something the database needs — a migration has not been run',
  offline: 'the database could not be reached at all',
  busy: 'the database is rate-limiting this clock',
  rejected: 'the database refused the call itself',
  error: 'the database answered with an error'
};

/* One failure in, everything a run needs out: the class, what to do about
   it, and the operator's own line. */
function broken(err) {
  const kind = ApiErrors.kindOf(err);
  return {
    kind: kind,
    action: WHAT_TO_DO[kind] || 'the database refused this call in a way the classifier does not name',
    detail: ApiErrors.detail(err)
  };
}

/* The distinct classes a run hit, in the order it hit them: 'rejected' and
   'offline' send a person to two different places, and a message that named
   only the first would hide the other. */
function kindsOf(failed) {
  const seen = [];
  for (const f of failed) if (seen.indexOf(f.kind) === -1) seen.push(f.kind);
  return seen.join(' + ') || 'unknown';
}

async function rpc(name, args) {
  return sb('rpc/' + name, { method: 'POST', body: JSON.stringify(args || {}) });
}

/* The queue as the database sees it, through the same function the
   dashboard calls — with the service role, which the function admits.
   Reading it through the RPC rather than off the table is deliberate:
   one shape of queue, so the chaser and the officer cannot be looking
   at different lists. */
async function readQueue() {
  const rows = await rpc('verification_queue', {});
  return Array.isArray(rows) ? rows : [];
}

/* ------------------------------------------------------------
   THE DECISION, one row at a time, in the shared clock.

   `stage_since` and `last_nudged_at` come back from the queue read,
   which is what makes "already told" a lookup rather than a guess — and
   what keeps a listing that was released and re-taken from being
   treated as the lateness we already spoke about.
   ------------------------------------------------------------ */
function plan(rows, now) {
  const at = now ? new Date(now) : new Date();
  const late = [];
  const moves = [];
  for (const row of rows) {
    const move = ArzuzVerify.nextMove(
      Object.assign({}, row, { taken_by: row.taken_by, taken_at: row.taken_at }),
      { since: row.stage_since, nudged_since: row.last_nudged_at, now: at }
    );
    if (move.move === 'none') continue;
    const item = { row: row, move: move.move, aging: move.aging, silent_hours: move.silent_hours };
    /* LATE IS NOT THE SAME AS SPOKEN ABOUT. Everything overdue is counted,
       including the ones this run stays quiet about because they were
       flagged an hour ago — a run that reported only what it said would
       answer "how many listings are late?" with a number that drops the
       moment the team has been told, which is the opposite of true. */
    late.push(item);
    if (move.move === 'nudge' || move.move === 'reclaim') moves.push(item);
  }
  return {
    moves: moves,
    late: late,
    late_count: late.length,
    quiet: late.filter((m) => m.move === 'quiet').length,
  };
}

function line(item) {
  const r = item.row;
  const a = item.aging;
  const over = a.hours_over >= 48
    ? Math.round(a.hours_over / 24) + ' days'
    : Math.round(a.hours_over) + 'h';
  return '• <b>' + esc(r.ref || r.id, 30) + '</b> — ' + esc(r.area || 'area unknown', 40) +
    '\n   ' + over + ' past its ' + a.limit_hours + 'h deadline' +
    (item.move === 'reclaim'
      ? '\n   taken by ' + esc(a.holder || 'an officer', 40) + ' and silent for ' +
        item.silent_hours + 'h — put back in the queue'
      : '\n   ' + (a.who === 'officer'
          ? 'held by ' + esc(a.holder || 'an officer', 40) + ' · told once already'
          : 'nobody has taken it')) +
    (Number(r.scout_reports) > 0 ? '\n   ' + r.scout_reports + ' scout report(s) on file' : '');
}

function nudgeText(moves) {
  const ours = moves.filter((m) => m.aging.who === 'ours');
  const officers = moves.filter((m) => m.aging.who === 'officer');
  let text = '🔍 <b>Listings owed a visit</b>\n\n';
  if (ours.length) {
    text += '<b>Nobody has taken these</b>\n' + ours.map(line).join('\n') + '\n\n';
  }
  if (officers.length) {
    /* Kept apart on purpose: these are rooms somebody said they would go
       to. Reading them together with the unclaimed ones is how a queue
       starts lying about who is late. */
    text += '<b>Taken and not done</b>\n' + officers.map(line).join('\n') + '\n\n';
  }
  text += 'Open the verification queue in the dashboard to take one, release one, or approve what has been seen.' +
    '\n\nA listing an officer took and left for ' + POLICY.reclaim_after_hours +
    'h past a nudge goes back to the queue by itself — nobody has to ask.';
  return text;
}

/* WHAT THE RUN FOUND, WHAT IT WROTE, AND WHAT IT ANNOUNCED — three numbers
   and not one, because the failure worth catching is the run that looks
   busy and wrote nothing. `nudged` is what the database ACCEPTED, never
   what this run intended: a response saying nudged 2 and failed 2 would be
   a response that cannot be true.

   `kind` is the shared class of the failure, carried on the answer the way
   every other function in this repo carries it — and only on a run that
   failed, so a clean hour says nothing about a class at all. `ok` stays
   true either way: the run DID run, and `outcome` is the sentence about
   what it managed to do. */
const done = (outcome, planned, failed, did, kind) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.assign({
    ok: true,
    outcome: outcome,
    late: planned ? planned.late_count : 0,
    quiet: planned ? planned.quiet : 0,
    nudged: did ? (did.nudged || 0) : 0,
    reclaimed: did ? (did.reclaimed || 0) : 0,
    announced: did ? (did.announced || 0) : 0,
    failed: (failed || []).length,
  }, kind ? { kind: kind } : {})),
});

/* The moves, one listing at a time, each in its own try: a listing whose
   trail write fails must not stop the reclaims behind it, and a failed
   reclaim must not stop the message about the rest. */
async function run(moves) {
  const out = { nudged: 0, reclaimed: 0, failed: [] };
  for (const item of moves) {
    const id = item.row.id;
    try {
      if (item.move === 'nudge') {
        await rpc('verification_nudge', {
          p_id: id,
          p_note: (item.aging.who === 'officer' ? 'held past its deadline by ' : 'unvisited for ') +
            Math.round(item.aging.hours_over) + 'h',
        });
        out.nudged += 1;
      } else {
        await rpc('listing_release', {
          p_id: id,
          p_note: 'the verification clock took it back: ' + (item.aging.holder || 'the officer on it') +
            ' was silent for ' + item.silent_hours + 'h after being told',
        });
        out.reclaimed += 1;
      }
    } catch (err) {
      /* The CLASS and the operator's line, not a bare sentence: whether a
         grant refused this write or the wire dropped decides whether the
         team is told to run a migration or to wait an hour. */
      const trouble = broken(err);
      out.failed.push({ ref: item.row.ref || id, kind: trouble.kind, detail: trouble.detail });
    }
  }
  return out;
}

exports.handler = async function () {
  const c = cfg();
  if (!c || !c.serviceKey) {
    /* Without the service key nothing can be read or written, and a run
       that pretends to have checked is the failure this file exists to
       prevent. The class is the shared one for a fact about the DEPLOYMENT
       rather than about the database — `state` is how a caller names a
       class it has already decided, and it refuses a name the vocabulary
       does not have. */
    console.error('[verification-aging] no service key on this deploy — nothing was read or written');
    return done('no-service-key', null, [], null, ApiErrors.state('not-ready').kind);
  }

  let rows;
  try {
    rows = await readQueue();
  } catch (err) {
    /* Could not read the queue at all. A chaser that dies quietly is
       worse than no chaser, so this is the one case that always speaks —
       and the class is the part that says WHERE to look: a not-ready is a
       migration nobody has run, an error is a bad minute. */
    const trouble = broken(err);
    console.error('[verification-aging] could not read the queue (' + trouble.kind + '):', trouble.detail);
    try {
      await sendAlert('⚠️ <b>The verification clock could not read the queue</b>\n\n' +
        '<b>' + esc(trouble.kind, 40) + '</b> — ' + esc(trouble.action, 200) + '\n' +
        esc(trouble.detail, 240) +
        '\n\nNobody is being told about listings that are late until this is fixed.');
    } catch (e) { /* nothing left to do: the log above carries it */ }
    return done('queue-unreadable', null, [], null, trouble.kind);
  }

  const planned = plan(rows);
  if (!planned.moves.length) return done('quiet', planned, [], null);

  const sent = await run(planned.moves);
  /* Written, not announced: a move the trail refused is not one the message
     may claim happened. */
  const announced = planned.moves.filter((m) => sent.failed.every((f) => f.ref !== (m.row.ref || m.row.id)));

  /* NOTHING GOT WRITTEN AT ALL. The trail is what keeps this from repeating
     every hour, so a run that could not write it is a run that will say the
     same thing again next hour — and it is the failure that must not be
     quiet about itself, because nobody is watching the dashboard. */
  if (!sent.nudged && !sent.reclaimed && sent.failed.length) {
    const classes = kindsOf(sent.failed);
    try {
      await sendAlert('\u26a0\ufe0f <b>The verification clock could not write to the trail</b>\n\n' +
        '<b>' + esc(classes, 80) + '</b> — ' +
        esc(WHAT_TO_DO[sent.failed[0].kind] || 'the database refused every write', 200) + '\n' +
        esc(sent.failed.map((f) => f.ref + ': ' + f.detail).join('; '), 300) +
        '\n\nEvery listing below is late and nobody has been told, and this will repeat every hour ' +
        'until the database accepts the write.');
    } catch (err) {
      const also = broken(err);
      console.error('[verification-aging] could not write the trail AND could not alert (' + also.kind + '):', also.detail);
    }
    console.error('[verification-aging] trail write failed for', sent.failed.length, 'listing(s) —', classes);
    /* The class on the answer is the FIRST one: a run can meet two, and the
       message above names both, but an answer a caller branches on has to be
       one name. */
    return done('trail-write-failed', planned, sent.failed, sent, sent.failed[0].kind);
  }

  let sentMessage = 0;
  if (announced.length) {
    try {
      await sendAlert(nudgeText(announced));
      sentMessage = announced.length;
    } catch (err) {
      const trouble = broken(err);
      console.error('[verification-aging] could not send the nudge (' + trouble.kind + '):', trouble.detail);
      /* The trail rows above are already written, which is the hard part:
         the listings will not be re-announced as NEW next hour. Losing the
         message is worth a log line here rather than a retry that would
         double-announce. */
      return done('nudge-undelivered', planned, sent.failed,
        { nudged: sent.nudged, reclaimed: sent.reclaimed, announced: 0 }, trouble.kind);
    }
  }

  console.log('[verification-aging] late', planned.late_count,
    '— nudged', sent.nudged, ', reclaimed', sent.reclaimed,
    sent.failed.length ? ', FAILED ' + sent.failed.length : '');

  return done(sent.reclaimed ? 'reclaimed-and-nudged' : 'nudged', planned, sent.failed,
    { nudged: sent.nudged, reclaimed: sent.reclaimed, announced: sentMessage });
};

/* Exported for scripts/test-verification-queue.mjs, which drives `plan`,
   `run` and the handler with a stubbed database — because a chaser
   nobody has seen refuse to speak is a chaser that speaks every hour. */
exports.plan = plan;
exports.run = run;
exports.readQueue = readQueue;
exports.nudgeText = nudgeText;
exports.POLICY = POLICY;
/* And the two helpers the failures go through, so the suite can check the
   class a given failure gets without waiting for an alert to be composed. */
exports.broken = broken;
exports.kindsOf = kindsOf;
exports.WHAT_TO_DO = WHAT_TO_DO;
