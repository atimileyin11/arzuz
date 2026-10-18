#!/usr/bin/env node
/* ============================================================
   Arzuz — the verification shift, and the clock that chases it

   WHY THIS SUITE EXISTS

     LAUNCH-READINESS.md §8.2 stage 2 is "a queue, a deadline per listing,
     and the officer's account on the record". Three things can be wrong
     with that and none of them look wrong on a screen:

       · the DEADLINE  — a listing that is not late reads as late, or a
                         late one reads as fine, and the queue is then
                         worse than no queue, because it is trusted;
       · the CLAIM     — a job two officers both think they have (one of
                         them drives across town for nothing), or a job
                         that can never be given back;
       · the CHASER    — a clock that says the same thing every hour
                         (a channel nobody reads by the third day), one
                         that stops working silently, or — the one that
                         matters most — one that RECLAIMS a job from an
                         officer who answered yesterday.

     So this suite drives the real modules: assets/verification-queue.js
     for the clock and the ordering, and netlify/functions/verification-aging.js
     for the chaser, with a stubbed database and a recorded Telegram. The
     policy is asserted as ONE copy in ONE file, because two files with
     their own "48 hours" is how a panel and a message come to disagree
     about whether a room is overdue.

     The SQL half — that a take moves assigned_to and taken_at and
     nothing else, that a second officer is refused, that a reclaim by
     the service role is admitted while a nudge by a person is not — is
     proved against Postgres in dev/sql-proof.mjs. A stub here cannot
     prove a grant.

   Run from arzuz-site/:
     node scripts/test-verification-queue.mjs
   ============================================================ */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);

const HOUR = 3600 * 1000;

let passed = 0;
const failures = [];

function check(name, fn) {
  let out;
  try { out = fn(); } catch (err) { out = 'threw: ' + ((err && err.message) || err); }
  if (out === true) { passed += 1; console.log('  \u2713 ' + name); return; }
  failures.push({ name, why: String(out) });
  console.log('  \u2717 ' + name + '\n      \u2192 ' + out);
}

const eq = (got, want, what) =>
  (JSON.stringify(got) === JSON.stringify(want) ? true
    : (what || 'value') + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));

/* ---------------- the model ---------------- */

const ArzuzVerify = req(join(SITE, 'assets/verification-queue.js'));
/* The site's one classifier of a failed call. Section 8 is about the chaser
   using THIS one rather than a vocabulary of its own. */
const ApiErrors = req(join(SITE, 'assets/api-errors.js'));

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR);
const iso = (hoursAgo) => at(hoursAgo).toISOString();

/* Reference shapes are REAL: 'ARZ-L-1' and 'ARZ-L-2' are not references
   this site can mint (a reference is twelve hex characters in three
   groups), and a fixture that cannot exist is a fixture that teaches the
   wrong shape to the next reader. These rows are only policy input — the
   module never parses `ref` — so this is cosmetic, and that is exactly
   why it is worth keeping honest: nothing would ever have caught it. */
const unclaimed = (hoursAgo) => ({
  id: 'l-1', ref: 'ARZ-L-1111-1111-1111', area: 'Malete', status: 'active', tier: 0,
  created_at: iso(hoursAgo || 1), taken_by: null, taken_at: null
});
const held = (createdHoursAgo, takenHoursAgo, who) => ({
  id: 'l-2', ref: 'ARZ-L-2222-2222-2222', area: 'Malete', status: 'pending', tier: 0,
  created_at: iso(createdHoursAgo), taken_by: who || 'officer@arzuz.com', taken_at: iso(takenHoursAgo)
});

console.log('\n1. The policy is one copy, in one file');
{
  check('the three numbers are the ones the site promises', () => eq(
    ArzuzVerify.POLICY, { queue_hours: 72, visit_hours: 48, reclaim_after_hours: 24 }));
  check('stage 1\'s "within 72 hours" badge is the queue deadline, not a second promise', () =>
    ArzuzVerify.STAGE.queue.hours === ArzuzVerify.POLICY.queue_hours &&
    ArzuzVerify.STAGE.queue.hours === 72 ? true : 'the badge and the clock disagree');
  check('an unclaimed job is the team\'s, a taken one is the officer\'s', () =>
    ArzuzVerify.STAGE.queue.who === 'ours' && ArzuzVerify.STAGE.visit.who === 'officer'
      ? true : 'both stages are read as the same kind of lateness');
}

console.log('\n2. Which listings are on the clock at all');
{
  check('a live tier-0 listing is owed a visit', () => eq(ArzuzVerify.stageOf(unclaimed(1)), 'queue'));
  check('a pending tier-0 listing is owed one too — nobody has decided it', () =>
    eq(ArzuzVerify.stageOf({ status: 'pending', tier: 0, created_at: iso(2) }), 'queue'));
  check('a listing an officer holds is the visit stage', () => eq(ArzuzVerify.stageOf(held(3, 1)), 'visit'));
  check('a decided listing is off the clock', () =>
    ArzuzVerify.stageOf({ status: 'active', tier: 1, created_at: iso(99) }) === null
      ? true : 'a decided listing is still being chased for a visit');
  check('a listing whose tier was set by hand is off the clock too', () =>
    ArzuzVerify.stageOf({ status: 'active', tier: 2, created_at: iso(99) }) === null
      ? true : 'a room that was already visited is being sent an officer again');
  check('a draft is nobody\'s job yet', () =>
    ArzuzVerify.stageOf({ status: 'draft', tier: 0, created_at: iso(99) }) === null
      ? true : 'a draft is being chased for a visit');
  check('a rejected listing is not owed a visit — somebody looked and said no', () =>
    ArzuzVerify.stageOf({ status: 'rejected', tier: 0, created_at: iso(99) }) === null
      ? true : 'a rejected listing is still in the queue');
}

console.log('\n3. The deadline, measured from the right moment');
{
  const a = ArzuzVerify.agingOf(unclaimed(80));
  check('80 hours old is 8 hours late against the 72-hour promise', () =>
    a && a.overdue && Math.round(a.hours_over) === 8 && a.limit_hours === 72
      ? true : 'aging is ' + JSON.stringify(a));
  const fresh = ArzuzVerify.agingOf(unclaimed(2));
  check('2 hours old is not late, and the hours left are counted down', () =>
    fresh && !fresh.overdue && Math.round(fresh.hours_left) === 70 ? true : 'aging is ' + JSON.stringify(fresh));
  const b = ArzuzVerify.agingOf(held(100, 50));
  check('an officer 50 hours in is 2 hours late against THEIR 48, not the queue\'s 72', () =>
    b && b.overdue && Math.round(b.hours_over) === 2 && b.who === 'officer' && b.limit_hours === 48
      ? true : 'aging is ' + JSON.stringify(b));
  check('a job that was released and re-taken starts its own 48 hours', () => {
    /* This is what `since` is for: the row says taken_at, the CALLER says
       when this stage began — and the release is when it began. */
    const row = held(400, 1);
    const age = ArzuzVerify.agingOf(row, iso(1));
    return age && !age.overdue && Math.round(age.hours_left) === 47 ? true : 'aging is ' + JSON.stringify(age);
  });
  check('a listing with no created_at is not invented a deadline', () =>
    ArzuzVerify.agingOf({ status: 'active', tier: 0 }) === null ? true : 'a deadline was invented from nothing');
}

console.log('\n4. What the clock decides, and when it stays quiet');
{
  const lateUnclaimed = unclaimed(80);
  const lateHeld = held(100, 50);
  check('not late yet: nothing to say', () =>
    ArzuzVerify.nextMove(unclaimed(2)).move === 'none' ? true : 'the clock spoke early');
  check('late and never told: a nudge', () =>
    ArzuzVerify.nextMove(lateUnclaimed).move === 'nudge' ? true : 'nobody was told');
  check('told an hour ago: quiet, because saying it again says nothing new', () =>
    ArzuzVerify.nextMove(lateUnclaimed, { nudged_since: iso(1) }).move === 'quiet'
      ? true : 'the clock repeats itself every hour');
  check('a held job, told once, silent for the whole window: taken back', () =>
    ArzuzVerify.nextMove(lateHeld, { nudged_since: iso(25) }).move === 'reclaim'
      ? true : 'a job nobody came back on stays on their name forever');
  check('inside the silence window: not taken back yet', () =>
    ArzuzVerify.nextMove(lateHeld, { nudged_since: iso(3) }).move === 'quiet'
      ? true : 'a job was taken back hours after the officer was asked');
  check('an UNCLAIMED job is never "reclaimed" — there is nobody to take it from', () =>
    ArzuzVerify.nextMove(unclaimed(300), { nudged_since: iso(200) }).move === 'quiet'
      ? true : 'the clock claims to reclaim a job nobody holds');
  check('told about a PREVIOUS lateness, this is a new one: a nudge again', () => {
    /* Nudged 80 hours ago while nobody had it, then taken 50 hours ago and
       now 2 hours past the officer's 48. The old nudge predates the current
       stage, so this is a new lateness — which is exactly the case a flag on
       the row would get wrong, and the reason the trail is the record. */
    const move = ArzuzVerify.nextMove(held(400, 50), { since: iso(50), nudged_since: iso(80) });
    return move.move === 'nudge' ? true
      : 'a released-and-retaken job is treated as the lateness already spoken about: ' + move.move;
  });
  check('the sentence says which kind of late it is', () => {
    const ours = ArzuzVerify.sentence(ArzuzVerify.agingOf(unclaimed(80)));
    const theirs = ArzuzVerify.sentence(ArzuzVerify.agingOf(held(100, 50)));
    return (ours && theirs && ours !== theirs && /owed a visit/.test(ours) && /officer/.test(theirs))
      ? true : 'the two latenesses read the same: ' + ours + ' / ' + theirs;
  });
}

console.log('\n5. The order of the queue — late first, worst first, and never a decided row');
{
  const rows = [
    Object.assign(unclaimed(2), { id: 'fresh' }),
    Object.assign(held(100, 90), { id: 'officer-very-late', taken_at: iso(90) }),
    Object.assign(unclaimed(80), { id: 'team-late-8h' }),
    { id: 'decided', status: 'active', tier: 1, created_at: iso(500) },
    Object.assign(held(200, 60), { id: 'officer-late-12h', taken_at: iso(60) }),
    Object.assign(unclaimed(76), { id: 'team-late-4h' })
  ].map((r) => Object.assign({}, r, { stage_since: r.taken_at || r.created_at }));

  const ordered = ArzuzVerify.orderFor(rows, new Date()).map((r) => r.id);
  check('the officer who has been silent longest is at the top', () =>
    eq(ordered[0], 'officer-very-late', 'the first row'));
  check('then the officer slightly less late', () => eq(ordered[1], 'officer-late-12h', 'the second row'));
  check('then the team\'s own lateness, worst first', () =>
    eq(ordered.slice(2, 4), ['team-late-8h', 'team-late-4h'], 'the team\'s late rows'));
  check('then what is closest to going late', () => eq(ordered[4], 'fresh', 'the fifth row'));
  check('and a decided listing is LAST — it is not the next thing anybody does', () =>
    eq(ordered[ordered.length - 1], 'decided', 'the last row'));
  const q = ArzuzVerify.queueOf(rows, new Date());
  check('the counts separate the two kinds of late, because they need different sentences', () =>
    q.total === 6 && q.late === 4 && q.owed_by_us === 2 && q.owed_by_officers === 2 && q.with_officers === 2
      ? true : 'counts are ' + JSON.stringify(q));
  check('a deadline reads as words, never as a timestamp', () => {
    const line = ArzuzVerify.label(ArzuzVerify.agingOf(unclaimed(80)));
    return (/late$/.test(line) ? true : 'the label is ' + JSON.stringify(line));
  });
}

/* ---------------- the chaser ---------------- */

/* The stubbed database and Telegram.

   netlify/functions/verification-aging.js destructures sb/cfg and
   sendAlert at LOAD time, the way every function in this repo does, so
   the stub is installed on the modules' exports BEFORE the chaser is
   required. Requiring it first would capture the real ones and every
   call below would leave the building. */
const calls = { rpc: [], alerts: [] };
let queue = [];
let queueThrows = null;

const roommateMatch = req(join(SITE, 'netlify/functions/roommate-match.js'));
roommateMatch.cfg = () => ({ serviceKey: 'stub-service-key', url: 'http://stub.local' });
roommateMatch.sb = async (path, opts) => {
  const name = String(path).replace(/^rpc\//, '');
  let args = {};
  try { args = JSON.parse((opts && opts.body) || '{}'); } catch (e) { args = {}; }
  calls.rpc.push({ name, args });
  if (name === 'verification_queue') {
    /* Thrown AS IT IS, never wrapped in an Error of this suite's own
       making: the chaser reads the class off the failure (its status, its
       code, the database's sentence), so a stub that flattened an error
       into a string would be testing the wrapper instead of the classifier
       — and would have hidden the very thing section 8 asserts. */
    if (queueThrows) throw queueThrows;
    return queue;
  }
  if (name === 'verification_nudge' || name === 'listing_release') {
    return { ok: true, id: args.p_id, at: new Date().toISOString() };
  }
  throw new Error('the chaser called something this suite does not stub: ' + name);
};

const notify = req(join(SITE, 'netlify/functions/notify.js'));
notify.sendAlert = async (text) => { calls.alerts.push(String(text)); return { ok: true }; };

const chaser = req(join(SITE, 'netlify/functions/verification-aging.js'));

const reset = () => { calls.rpc.length = 0; calls.alerts.length = 0; queue = []; queueThrows = null; };

console.log('\n6. The chaser: what it says, what it does, and what it leaves alone');
{
  reset();
  /* Four listings, covering every branch the clock has:
       l-silent  taken 90h ago, told 30h ago  → reclaimed
       l-told    taken 50h ago, told 2h ago   → quiet (said already)
       l-held    taken 60h ago, never told    → nudged (the ask)
       l-team    never taken, 80h old         → nudged (the team owes it)
       l-fresh   3h old                       → untouched
     The last one matters as much as the first: a clock that nudges
everything late is a clock nobody can act on. */
  const longSilent = Object.assign(held(200, 90, 'grace@arzuz.com'), { id: 'l-silent' });
  longSilent.last_nudged_at = iso(30);
  longSilent.stage_since = longSilent.taken_at;
  const justTold = Object.assign(held(100, 50, 'bode@arzuz.com'), { id: 'l-told' });
  justTold.last_nudged_at = iso(2);
  justTold.stage_since = justTold.taken_at;
  const heldNoWord = Object.assign(held(120, 60, 'kemi@arzuz.com'), { id: 'l-held' });
  heldNoWord.last_nudged_at = null;
  heldNoWord.stage_since = heldNoWord.taken_at;
  const teamLate = Object.assign(unclaimed(80), { id: 'l-team' });
  teamLate.last_nudged_at = null;
  teamLate.stage_since = teamLate.created_at;
  const fresh = Object.assign(unclaimed(3), { id: 'l-fresh' });
  fresh.last_nudged_at = null;
  fresh.stage_since = fresh.created_at;
  queue = [longSilent, justTold, heldNoWord, teamLate, fresh];

  const first = await chaser.handler({});
  const body = JSON.parse(first.body);
  const nudged = calls.rpc.filter((c) => c.name === 'verification_nudge').map((c) => c.args.p_id);
  const released = calls.rpc.filter((c) => c.name === 'listing_release').map((c) => c.args.p_id);

  check('it nudges the unclaimed job and the one an officer took without a word', () =>
    eq(nudged.slice().sort(), ['l-held', 'l-team'], 'the nudged listings'));
  check('it takes back the job nobody came back on', () =>
    eq(released, ['l-silent'], 'the reclaimed listings'));
  check('it does not ALSO nudge the job it is taking back', () =>
    nudged.indexOf('l-silent') === -1 ? true : 'the same lateness was both announced and acted on');
  check('it says NOTHING about the job that was told two hours ago', () =>
    nudged.indexOf('l-told') === -1 && released.indexOf('l-told') === -1
      ? true : 'the clock repeated itself about a lateness it already flagged');
  check('it leaves a listing that is not late completely alone', () =>
    nudged.concat(released).indexOf('l-fresh') === -1 ? true
      : 'the clock touched a listing that is not late');
  check('the reclaim goes through the same door an officer\u2019s release does, and says who was silent', () => {
    const rec = calls.rpc.filter((c) => c.name === 'listing_release')[0];
    return rec && /grace@arzuz.com/.test(rec.args.p_note) && /silent/.test(rec.args.p_note)
      ? true : 'the reclaim is ' + JSON.stringify(rec);
  });
  check('one message, not one per listing', () =>
    eq(calls.alerts.length, 1, 'the number of Telegram messages'));
  check('the message separates the two kinds of late', () =>
    /Nobody has taken these/.test(calls.alerts[0]) && /Taken and not done/.test(calls.alerts[0])
      ? true : 'the message is ' + JSON.stringify(calls.alerts[0]));
  check('and it says the job goes back to the queue, not that somebody was told off', () =>
    /goes back to the queue|put back in the queue/.test(calls.alerts[0])
      ? true : 'the message does not say what it did: ' + JSON.stringify(calls.alerts[0]));
  check('the run reports what it FOUND, what it WROTE and what it ANNOUNCED, kept apart', () =>
    body.ok === true && body.late === 4 && body.quiet === 1 &&
      body.nudged === 2 && body.reclaimed === 1 && body.announced === 3 && body.failed === 0
      ? true : 'the response is ' + JSON.stringify(body));
  check('and a run that went through names no class at all — only a failure has one', () =>
    !Object.prototype.hasOwnProperty.call(body, 'kind') ? true
      : 'a clean hour answered with a class: ' + JSON.stringify(body));

  /* AN HOUR LATER, with what the first run WROTE now on the record: the two
     nudged listings carry this hour's nudge, and the reclaimed one is back
     in the queue with its stage starting now (which is what the release
     did to it). The clock must go quiet — a reminder that arrives every
     hour is one nobody reads, and that is the whole reason the trail
     exists instead of a flag on the row. */
  reset();
  queue = [
    Object.assign({}, longSilent, { taken_by: null, taken_at: null, stage_since: iso(0) }),
    justTold,
    Object.assign({}, heldNoWord, { last_nudged_at: iso(0) }),
    Object.assign({}, teamLate, { last_nudged_at: iso(0) }),
    fresh
  ];
  const second = await chaser.handler({});
  const secondBody = JSON.parse(second.body);
  const wrote = () => calls.rpc.filter((c) => c.name !== 'verification_queue').length;
  check('an hour later it says nothing about a lateness it has already spoken about', () =>
    secondBody.outcome === 'quiet' && wrote() === 0 && calls.alerts.length === 0
      ? true : 'the second run did ' + JSON.stringify(secondBody) + ' with ' + wrote() + ' write(s)');

  /* AND A RUN THAT COULD NOT WRITE. The trail is what stops the next hour
     repeating this one, so a run whose writes all failed has to say SO — it
     is the difference between "the team has been told" and "nobody has".

     Same trap as the keyless run below: sb is captured at load, so the
     failing stub needs its own load of the module — patching the export
     afterwards would leave the real one in place and this check would pass
     for the wrong reason. */
  reset();
  const chasePath = req.resolve(join(SITE, 'netlify/functions/verification-aging.js'));
  const goodSb = roommateMatch.sb;
  roommateMatch.sb = async (path, opts) => {
    if (String(path) === 'rpc/verification_nudge') throw new Error('trail write refused');
    return goodSb(path, opts);
  };
  delete req.cache[chasePath];
  const chaserBroken = req(chasePath);
  queue = [justTold, Object.assign({}, heldNoWord, { last_nudged_at: null }), teamLate];
  const partial = JSON.parse((await chaserBroken.handler({})).body);
  roommateMatch.sb = goodSb;
  delete req.cache[chasePath];
  check('a run whose trail writes all fail says so, instead of looking like a quiet hour', () =>
    partial.failed === 2 && partial.nudged === 0 && partial.announced === 0 &&
      partial.outcome === 'trail-write-failed'
      ? true : 'the run answered ' + JSON.stringify(partial));
  check('and a response can never claim more nudges than it wrote', () =>
    partial.nudged + partial.reclaimed + partial.failed === 2 ? true
      : 'nudged + reclaimed + failed does not add up: ' + JSON.stringify(partial));
  check('and the team is told the clock is not working, not left to infer it', () =>
    calls.alerts.length === 1 && /could not write to the trail/.test(calls.alerts[0])
      ? true : 'the alert was ' + JSON.stringify(calls.alerts));
}

console.log('\n7. The chaser when the database cannot be read at all');
{
  reset();
  queueThrows = 'the database is not answering';
  const r = await chaser.handler({});
  const body = JSON.parse(r.body);
  check('it reports the failure rather than a quiet run', () =>
    eq(body.outcome, 'queue-unreadable', 'the outcome'));
  check('and it SHOUTS, because a chaser that dies quietly is worse than none', () =>
    calls.alerts.length === 1 && /could not read the queue/.test(calls.alerts[0])
      ? true : 'the team was not told: ' + JSON.stringify(calls.alerts));

  /* A RUN WITH NO SERVICE KEY. The chaser destructures cfg at load, so the
     only honest way to reach this branch is a SECOND load of the module
     with a stub that has no key — poking the export afterwards would change
     nothing and the check would pass for the wrong reason. */
  reset();
  const chaserPath = req.resolve(join(SITE, 'netlify/functions/verification-aging.js'));
  const withKey = roommateMatch.cfg;
  roommateMatch.cfg = () => ({ serviceKey: '' });
  delete req.cache[chaserPath];
  const chaserNoKey = req(chaserPath);
  const out = await chaserNoKey.handler({});
  roommateMatch.cfg = withKey;
  delete req.cache[chaserPath];
  const keyless = JSON.parse(out.body);
  check('a run with no service key says so instead of pretending to have checked', () =>
    keyless.outcome === 'no-service-key' && calls.rpc.length === 0 && calls.alerts.length === 0
      ? true : 'the keyless run answered ' + JSON.stringify(keyless));
  check('and it names that as the deployment fact it is, not as a database that misbehaved', () =>
    keyless.kind === 'not-ready' ? true
      : 'a missing key was reported as ' + JSON.stringify(keyless.kind));
}

console.log('\n8. Which kind of broken \u2014 the site\u2019s one classifier, and what the clock does about each');
{
  /* THE PATH, NOT THE WORDS. The class must come from the module the pages
     load. A second copy of the vocabulary in this file would pass every
     behavioural check below and still be the bug: the clock and the
     dashboard would then be free to disagree about the same failure, which
     is the thing assets/api-errors.js was written to stop. So the require is
     resolved and compared with the file the pages are sent. */
  const chaserSrc = readFileSync(join(SITE, 'netlify/functions/verification-aging.js'), 'utf8');

  check('the chaser loads the classifier the PAGES load, by the path that lands on it', () => {
    const m = chaserSrc.match(/require\('([^']*api-errors\.js)'\)/);
    if (!m) return 'the chaser does not require assets/api-errors.js at all';
    const landed = req.resolve(join(SITE, 'netlify/functions', m[1]));
    const pages = req.resolve(join(SITE, 'assets/api-errors.js'));
    return landed === pages ? true
      : 'that require lands on ' + landed + ', not on ' + pages + ' \u2014 a second copy of the vocabulary';
  });

  check('and the class it reports is the classifier\u2019s own, for every shape the wire sends', () => {
    const shapes = [
      Object.assign(new Error('x'), { status: 404, code: 'PGRST202' }),
      Object.assign(new Error('x'), { status: 400, code: '23502' }),
      Object.assign(new Error('x'), { status: 429 }),
      Object.assign(new Error('x'), { status: 503 }),
      new TypeError('fetch failed')
    ];
    const wrong = shapes.filter((e) => chaser.broken(e).kind !== ApiErrors.kindOf(e));
    return wrong.length
      ? 'the chaser named ' + JSON.stringify(wrong.map((e) => chaser.broken(e).kind)) + ' where the classifier says otherwise'
      : true;
  });

  /* EVERY CLASS THE CLOCK CAN MEET HAS AN ANSWER, and the one it cannot meet
     is named here rather than left to luck: a timer holds no session, so the
     session class is unreachable without opts.session \u2014 asserted, because
     if that ever changed, a 401 would silently arrive with no answer at all. */
  check('every class the clock can meet has an answer, and the session\u2019s is the one it cannot', () => {
    const missing = Object.keys(ApiErrors.KINDS).filter((k) => !(k in chaser.WHAT_TO_DO));
    if (missing.join(',') !== 'expired') {
      return 'the vocabulary has grown \u2014 nothing here says what the clock does about: ' + missing.join(', ');
    }
    return ApiErrors.kindOf({ status: 401 }) === 'not-ready' ? true
      : 'a 401 without a session now reads as ' + ApiErrors.kindOf({ status: 401 }) + ', which has no answer above';
  });

  /* THE MIGRATION NOBODY HAS RUN. This is the failure this clock meets first
     in a fresh project, and the one it used to report as a general error:
     PostgREST\u2019s own sentence, with no hint that the fix is a file. */
  reset();
  queueThrows = Object.assign(
    new Error('Could not find the function public.verification_queue(p_args, p_limit) in the schema cache'),
    { status: 404, code: 'PGRST202' }
  );
  const unrun = JSON.parse((await chaser.handler({})).body);
  check('a queue that is not in this database is not-ready, not \u201ca bad minute\u201d', () =>
    unrun.kind === 'not-ready' && unrun.outcome === 'queue-unreadable' ? true
      : 'the run answered ' + JSON.stringify(unrun));
  check('and the alert names the class and says what to do about it', () =>
    calls.alerts.length === 1 && /<b>not-ready<\/b>/.test(calls.alerts[0]) &&
      /migration has not been run/.test(calls.alerts[0]) ? true
      : 'the alert was ' + JSON.stringify(calls.alerts));
  check('and the database\u2019s own sentence survives into it \u2014 a class alone is not a diagnosis', () =>
    /in the schema cache/.test(calls.alerts[0]) ? true
      : 'the alert lost the operator\u2019s line: ' + JSON.stringify(calls.alerts));

  /* A DATABASE THAT ANSWERED BADLY, and one that never answered at all. The
     first is a bad minute and will very likely be fine next hour. The second
     is the same event whichever runtime reports it: Node says exactly "fetch
     failed", with a cause and no status, and a message that read as an error
     would send the team looking at a server that was never reached. */
  reset();
  queueThrows = Object.assign(new Error('upstream connect error or disconnect/reset before headers'), { status: 502 });
  const unwell = JSON.parse((await chaser.handler({})).body);
  check('a database that answered with an error is named an error, and is not sent to run a migration', () =>
    unwell.kind === 'error' && unwell.kind !== 'not-ready' &&
      /the database answered with an error/.test(calls.alerts[0]) ? true
      : 'the run answered ' + JSON.stringify(unwell) + ' / ' + JSON.stringify(calls.alerts));

  reset();
  queueThrows = new TypeError('fetch failed');
  const unreachable = JSON.parse((await chaser.handler({})).body);
  check('and one that never answered at all is offline, in Node\u2019s words as well as the browser\u2019s', () =>
    unreachable.kind === 'offline' && /could not be reached at all/.test(calls.alerts[0]) ? true
      : 'the run answered ' + JSON.stringify(unreachable) + ' / ' + JSON.stringify(calls.alerts));

  /* A TRAIL THAT REFUSES THE WRITE. A 400 is the request being refused, and
     naming that class is the difference between "somebody must look at the
     grants" and "wait an hour" \u2014 which is what the operator\u2019s sentence
     alone could not say. */
  reset();
  const chasePath = req.resolve(join(SITE, 'netlify/functions/verification-aging.js'));
  const goodSb = roommateMatch.sb;
  roommateMatch.sb = async (path, opts) => {
    if (String(path) === 'rpc/verification_nudge') {
      throw Object.assign(
        new Error('null value in column "event" of relation "verification_events" violates not-null constraint'),
        { status: 400, code: '23502' }
      );
    }
    return goodSb(path, opts);
  };
  delete req.cache[chasePath];
  const chaserRefused = req(chasePath);
  const heldNoWord = Object.assign(held(120, 60, 'kemi@arzuz.com'), { id: 'l-held', last_nudged_at: null });
  heldNoWord.stage_since = heldNoWord.taken_at;
  const teamLate = Object.assign(unclaimed(80), { id: 'l-team', last_nudged_at: null });
  teamLate.stage_since = teamLate.created_at;
  queue = [heldNoWord, teamLate];
  const refused = JSON.parse((await chaserRefused.handler({})).body);
  roommateMatch.sb = goodSb;
  delete req.cache[chasePath];
  check('a trail that refuses the write is named rejected, not described in prose', () =>
    refused.kind === 'rejected' && refused.outcome === 'trail-write-failed' && refused.failed === 2
      ? true : 'the run answered ' + JSON.stringify(refused));
  check('and the alert carries the class AND the operator\u2019s line for the write that failed', () =>
    calls.alerts.length === 1 && /<b>rejected<\/b>/.test(calls.alerts[0]) &&
      /the database refused the call itself/.test(calls.alerts[0]) &&
      /not-null constraint/.test(calls.alerts[0]) ? true
      : 'the alert was ' + JSON.stringify(calls.alerts));
}

console.log('\n9. The phone stays quiet about the SAME failure twice');
{
  /* The hourly spam this cooldown ends: a queue nobody can read fails
     identically every hour, and every one of those runs used to page
     Telegram — a channel that cries hourly is one nobody reads. The log
     line still fires per run; the phone fires once per window. */
  reset();
  chaser._resetOpsAlerts();
  queueThrows = new TypeError('fetch failed');
  const firstMiss = JSON.parse((await chaser.handler({})).body);
  const secondMiss = JSON.parse((await chaser.handler({})).body);
  check('the first identical failure pages, the repeat inside the window does not', () =>
    firstMiss.outcome === 'queue-unreadable' && secondMiss.outcome === 'queue-unreadable' &&
      calls.alerts.length === 1
      ? true : 'alerts: ' + JSON.stringify(calls.alerts));
  /* NOTE: check() is sync, so the run is driven by hand and only the
     assertion sits inside it — an async body would answer a promise
     the counter never awaits. */
  queueThrows = Object.assign(new Error('upstream connect error or disconnect/reset before headers'), { status: 502 });
  const other = JSON.parse((await chaser.handler({})).body);
  check('and a DIFFERENT failure still speaks immediately (driven)', () =>
    other.outcome === 'queue-unreadable' && calls.alerts.length === 2
      ? true : 'alerts: ' + JSON.stringify(calls.alerts));
}

console.log('\n\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014');
console.log('TOTAL ' + (passed + failures.length) + ' \u00b7 PASS ' + passed + ' \u00b7 FAIL ' + failures.length);
if (failures.length) process.exitCode = 1;
