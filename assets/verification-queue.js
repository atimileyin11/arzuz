/* ============================================================
   Arzuz — the verification shift: its clock, and the queue it orders

   THE PROBLEM THIS IS (LAUNCH-READINESS.md §8.2, stage 2)

     A listing that nobody has visited is on the board at tier 0 with a
     badge that tells a STUDENT the truth and tells the TEAM nothing.
     Nothing in the system says a listing is owed a visit, when it is owed
     by, or who has it. At twenty-five listings a week that lives in
     somebody's head; at seventy-five it becomes the thing that is always
     true and never scheduled — a room goes live unvisited, the deadline
     passes on a Tuesday nobody noticed, and the first person to find out
     is the student standing in the room.

     So an unverified listing becomes a JOB: it has a deadline, an officer
     can TAKE it (their account goes on the record for it), and the shift
     is ended by the act that always ended it — public.listing_verify().

   ONE SET OF NUMBERS, TWO READERS

     The dashboard draws the queue and netlify/functions/verification-aging.js
     chases it on a schedule. Were those two to carry their own copy of
     "48 hours" they could disagree about whether a listing is late, and a
     queue that calls something late while the message about it calls it
     fine is worse than no clock at all. So the policy lives HERE, once,
     and both load this file — the function through require(), the
     dashboard as a script tag.

   WHY A DEADLINE IS COMPUTED AND NOT A STORED COLUMN

     A stored deadline is a second fact about a row that can be wrong, and
     the way it goes wrong is always the same: something touches the row,
     the deadline is not refreshed, and the job quietly stops being late.
     So the deadline here is DERIVED — the stage's hours, measured from the
     moment the row entered that stage (`created_at`, or the officer's
     `taken_at`), which is the same reasoning netlify/functions/claims.js
     uses for its own clock. The database stores what HAPPENED (who holds
     it, when they took it); this file decides what that means.

   THE STAGES OF ONE LISTING, AND WHO OWES WHAT

     queue   nobody has it — tier 0, not decided   72h   ours
     visit   an officer has taken it               48h   that officer
     done    the decision landed                   —     nobody

     `ours` and `that officer` are different sentences to whoever reads
     the top of the queue: one is work the team owes a student, the other
     is a person who said they would go and has not. Reading the two
     together is how a queue starts lying about what is late.

   LOADED AS window.ArzuzVerify or via require(), like
   assets/api-errors.js and assets/roommate-score.js. Pure: no fetch, no
   DOM, no clock of its own. Every function takes the instant it should
   judge at, so the tests can stand at a chosen one instead of waiting
   for it.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzVerify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  var HOUR_MS = 60 * 60 * 1000;

  /* ------------------------------------------------------------
     THE POLICY. Three numbers, and every one of them is a promise
     the site makes somewhere else:

       72h  stage 1's badge says a listing is sampled for a physical
            check "within 72 hours" (LAUNCH-READINESS.md §8.2). This
            is that sentence, as a number.
       48h  how long an officer holds a listing. Long enough for a
            Saturday, short enough that a room is not going live
            unvisited for a week because somebody's week changed.
       24h  the silence after the nudge. An officer who has been told
            and has said nothing for a day has stopped being the
            answer, so the job goes back to the queue where the next
            person can take it.
     ------------------------------------------------------------ */
  var POLICY = {
    queue_hours: 72,
    visit_hours: 48,
    reclaim_after_hours: 24
  };

  /* The stages, and the words each one is read as. `who` is the point:
     it decides whether a late listing is the team's problem or one
     officer's. */
  var STAGE = {
    queue: { hours: POLICY.queue_hours, who: 'ours',     says: 'visit it and decide' },
    visit: { hours: POLICY.visit_hours, who: 'officer',  says: 'make the visit you took' }
  };

  /* The statuses that mean "this listing is still owed a visit". A
     rejected or inactive listing is not owed anything (somebody looked
     and said no), and neither is a draft (the landlord is still typing).
     A listing that is LIVE at tier 0 is the one this whole file is about:
     students can see it, and nobody has been to it. */
  var OPEN_STATUS = ['pending', 'active', 'new'];

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function text(v) {
    return (v === null || v === undefined) ? '' : String(v);
  }

  function tierOf(row) {
    return num(row && row.tier);
  }

  function takenBy(row) {
    return text(row && (row.taken_by || row.assigned_to)).trim();
  }

  function takenAt(row) {
    return (row && (row.taken_at || row.assigned_at)) || null;
  }

  /* WHICH STAGE A LISTING IS IN, or null for "no clock". Null is a
     VALUE here and not a guess: a decided listing, a draft and a
     rejected one are all off the clock, and the queue must not invent a
     deadline for something nobody owes.

     A LIVE tier-0 listing is in the queue; so is a pending one. An
     officer holding it moves it to `visit` — the stage, not the status,
     is what the clock reads, because taking a job is not a change to
     what the listing IS. */
  function stageOf(row) {
    if (!row) return null;
    var status = text(row.status).toLowerCase();
    if (status === 'draft' || status === 'rejected' || status === 'inactive') return null;
    if (OPEN_STATUS.indexOf(status) === -1) return null;
    /* DECIDED IS A TIER, AND ONLY A TIER. 0 unverified / 1 community /
       2 inspected is the site's own vocabulary (supabase-schema.sql), so
       anything above 0 means somebody ruled on it — including the stage-0
       listings whose tier was set by hand from field notes before any of
       this existed. Those were visited; putting them back in the queue
       because they have no `verified_at` would send an officer to a room
       that has already been seen. tier 0 with a live status is the
       unverified listing this file is about. */
    if (tierOf(row) > 0) return null;
    if (takenBy(row)) return 'visit';
    return 'queue';
  }

  function dueAtFor(row, since) {
    var stage = stageOf(row);
    if (!stage) return null;
    var spec = STAGE[stage];
    var from = since || (stage === 'visit' ? takenAt(row) : null) || row.created_at;
    if (!from) return null;
    return new Date(new Date(from).getTime() + spec.hours * HOUR_MS);
  }

  /* ------------------------------------------------------------
     THE AGE OF ONE JOB, as numbers and as a sentence.

     `since` is when the listing entered the stage it is in now — the
     caller passes it when it knows better than the row does (the
     queue reader derives "back in the queue" from the trail, so a
     listing that was taken and released starts a fresh 72 hours
     rather than being late the moment it comes back).
     ------------------------------------------------------------ */
  function agingOf(row, since, now) {
    var stage = stageOf(row);
    if (!stage) return null;
    var spec = STAGE[stage];
    var at = now ? new Date(now) : new Date();
    var from = since || (stage === 'visit' ? takenAt(row) : null) || row.created_at;
    if (!from) return null;
    var started = new Date(from);
    var elapsed = Math.max(0, at.getTime() - started.getTime());
    var due = new Date(started.getTime() + spec.hours * HOUR_MS);
    var hoursLeft = (due.getTime() - at.getTime()) / HOUR_MS;
    return {
      stage: stage,
      who: spec.who,
      says: spec.says,
      holder: stage === 'visit' ? takenBy(row) : '',
      limit_hours: spec.hours,
      stage_since: started.toISOString(),
      deadline_at: due.toISOString(),
      hours_in_stage: Math.round((elapsed / HOUR_MS) * 10) / 10,
      days_in_stage: Math.floor(elapsed / (24 * HOUR_MS)),
      hours_left: Math.round(hoursLeft * 10) / 10,
      overdue: hoursLeft < 0,
      hours_over: hoursLeft < 0 ? Math.round((-hoursLeft) * 10) / 10 : 0
    };
  }

  /* ------------------------------------------------------------
     THE CLOCK'S DECISION, in one function, so the scheduled job and
     the tests cannot disagree about it.

     It is a pure function of: the row, when it entered its stage,
     whether the clock has ALREADY spoken since that moment, and the
     instant being judged.

       none     not late yet
       nudge    late, and nobody has been told about THIS lateness
       reclaim  late, told once, and still silent past the window —
                the job goes back to the queue
       quiet    late and already told; saying it again every hour is
                how a channel stops being read

     `nudged_since` is the time of the last nudge, or null. Because it
     is compared against the stage's start, a listing that is nudged,
     released and taken again gets its own new chance: that is a new
     lateness, not the one already spoken about.
     ------------------------------------------------------------ */
  function nextMove(row, opts) {
    opts = opts || {};
    var aging = agingOf(row, opts.since, opts.now);
    if (!aging) return { move: 'none', aging: null };
    if (!aging.overdue) return { move: 'none', aging: aging };
    var told = opts.nudged_since ? new Date(opts.nudged_since) : null;
    var stage_started = new Date(aging.stage_since);
    var toldForThisLateness = told && told.getTime() >= new Date(stage_started).getTime();
    if (!toldForThisLateness) return { move: 'nudge', aging: aging };
    /* Only a job somebody is HOLDING can be taken back: one already in
       the queue has nobody to take it from, and it is the nudge that
       matters there. */
    var at = opts.now ? new Date(opts.now) : new Date();
    var waited = (at.getTime() - told.getTime()) / HOUR_MS;
    if (aging.stage === 'visit' && waited >= POLICY.reclaim_after_hours) {
      return { move: 'reclaim', aging: aging, silent_hours: Math.round(waited) };
    }
    return { move: 'quiet', aging: aging, silent_hours: Math.round(waited) };
  }

  /* ------------------------------------------------------------
     THE ORDER OF THE QUEUE

     Late first, worst first — that is the whole point of putting it in
     a queue rather than a list. Under the late ones, whatever is
     closest to going late, so the queue is a work order and not only
     an alarm. Anything with no clock (decided, draft, rejected) sorts
     last and never outranks a live job: it is not the next thing
     anybody does.
     ------------------------------------------------------------ */
  function orderFor(rows, now) {
    var at = now ? new Date(now) : new Date();
    return (rows || []).map(function (row, i) {
      return { row: row, aging: agingOf(row, row && row.stage_since, at), i: i };
    }).sort(function (a, b) {
      var A = a.aging, B = b.aging;
      if (!A && !B) return a.i - b.i;
      if (!A) return 1;
      if (!B) return -1;
      if (A.overdue !== B.overdue) return A.overdue ? -1 : 1;
      /* Among the late: the one whose lateness is the team's own doing
         first (an officer we sent and who never came back is a worse
         silence than a listing that is simply waiting), then worst. */
      if (A.overdue && B.overdue && (A.who === 'officer') !== (B.who === 'officer')) {
        return A.who === 'officer' ? -1 : 1;
      }
      if (A.overdue) return B.hours_over - A.hours_over;
      return A.hours_left - B.hours_left;
    }).map(function (x) { return x.row; });
  }

  /* A person's line for a deadline, never a number of seconds. */
  function waited(aging) {
    if (!aging) return '';
    if (aging.hours_over >= 48) return Math.round(aging.hours_over / 24) + ' days late';
    if (aging.hours_over) return Math.round(aging.hours_over) + 'h late';
    if (aging.hours_left >= 48) return 'due in ' + Math.round(aging.hours_left / 24) + ' days';
    return 'due in ' + Math.max(0, Math.round(aging.hours_left)) + 'h';
  }

  function label(aging) {
    if (!aging) return 'decided';
    if (aging.stage === 'visit') {
      return 'with ' + (aging.holder || 'an officer') + ' · ' + waited(aging);
    }
    return 'nobody has it · ' + waited(aging);
  }

  /* What the team is told, in the two voices this needs: the message
     that goes to the channel, and the line a row carries. Kept here so
     the aging function and the dashboard say the same thing about the
     same listing. */
  function sentence(aging) {
    if (!aging) return '';
    if (!aging.overdue) return '';
    return (aging.who === 'officer'
      ? 'taken and not done: ' + (aging.holder || 'an officer') + ' has held it ' +
        Math.round(aging.hours_in_stage) + 'h'
      : 'owed a visit by the team for ' + Math.round(aging.hours_in_stage) + 'h');
  }

  /* The queue as the dashboard wants it: ordered, each row carrying its
     own aging, and the counts the header shows. */
  function queueOf(rows, now) {
    var at = now ? new Date(now) : new Date();
    var ordered = orderFor(rows, at).map(function (row) {
      return Object.assign({}, row, { aging: agingOf(row, row && row.stage_since, at) });
    });
    var late = ordered.filter(function (r) { return r.aging && r.aging.overdue; });
    return {
      rows: ordered,
      at: at.toISOString(),
      total: ordered.length,
      late: late.length,
      with_officers: ordered.filter(function (r) { return r.aging && r.aging.stage === 'visit'; }).length,
      owed_by_us: late.filter(function (r) { return r.aging.who === 'ours'; }).length,
      owed_by_officers: late.filter(function (r) { return r.aging.who === 'officer'; }).length
    };
  }

  return {
    VERSION: VERSION,
    POLICY: POLICY,
    STAGE: STAGE,
    OPEN_STATUS: OPEN_STATUS,
    stageOf: stageOf,
    tierOf: tierOf,
    takenBy: takenBy,
    takenAt: takenAt,
    dueAt: dueAtFor,
    agingOf: agingOf,
    nextMove: nextMove,
    orderFor: orderFor,
    waited: waited,
    label: label,
    sentence: sentence,
    queueOf: queueOf
  };
});
