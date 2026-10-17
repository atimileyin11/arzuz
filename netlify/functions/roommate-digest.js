/* ============================================================
   Arzuz — Netlify Function: the roommate digest (scheduled)

   ONE message a day, instead of one per event.

   Why this exists next to notify.js and roommate-match.js:

     roommate-match.js already buzzes Telegram twice — a new
     questionnaire, and a completed match. Both are instant, and both
     are one line long. What neither of them can say is the thing the
     team actually needs on day three: of the pairs that unlocked their
     contact details this week, which ones has NOBODY opened?

     A match is not a match until two students are talking. The engine
     therefore writes a 'viewed' row the first time a matched student
     is shown their match (roommate-match.js), and this function reads
     the gap: pairs matched more than FOLLOW_UP_DAYS ago where neither
     side has been back.

   It is scheduled rather than triggered, which is the point — nobody
   is watching the dashboard at 07:00, and a daily summary is a much
   smaller thing to ignore than a channel that pings on every tap.

     Schedule: netlify.toml → [functions."roommate-digest"] schedule
     (the cron lives in the config file rather than inline, because
     inline scheduling needs an ES module and the rest of the functions
     in this repo are CommonJS)

   Run it by hand: Netlify UI → Functions → roommate-digest → Run now,
   or locally with `netlify functions:invoke roommate-digest`.

   A quiet day sends NOTHING. Silence is the signal that nothing needs
   attention, and a daily "no news" message is how a team learns to
   ignore the channel. The one exception is a read that failed — that
   is sent, because a digest that stops running in silence is worse
   than a noisy one.

   Environment variables (same two as roommate-match.js):
     SUPABASE_SERVICE_ROLE_KEY  — secret, Netlify only
     TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — optional; no token means
                                  the digest is composed and NOT sent
   ============================================================ */

const { sendAlert, esc } = require('./notify.js');

/* The Supabase plumbing (and the service-role variable) has exactly one
   owner, roommate-match.js, the same way the Telegram token has one
   owner in notify.js. Nothing is copied here. */
const { sb, cfg, FOLLOW_UP_DAYS } = require('./roommate-match.js');

/* The digest reports the last day. It is not "since the last digest" —
   a missed run would then silently swallow a day, and a rerun would
   double-report. A fixed window is boring and correct. */
const WINDOW_HOURS = 24;

/* Two caps, for two different reasons.

   PAIRS: the ids of every stale pair go into one `in.(…)` filter, and a
   URL that long is the failure mode. 25 pairs is far more than a day
   can produce; if the cap is hit the message says so rather than
   pretending the list is complete.

   Events: a bound on a pathological day, so one busy week cannot make
   this function time out (scheduled functions get 30 seconds). */
const PAIRS_LIMIT = 25;
const EVENTS_LIMIT = 500;
const ACTIVITY_LIMIT = 1000;

/* The kinds of event the digest counts. 'viewed' is deliberately absent:
   it is read, not counted — "3 students opened their matches" is not
   news, "nobody opened this match" is. */
const COUNTED = ['created', 'accept', 'pass', 'withdrawn', 'matched'];

const LABELS = {
  created: 'Questionnaires completed',
  accept: 'Accepts',
  pass: 'Passes',
  withdrawn: 'Withdrawals',
  matched: 'Matches',
};

function iso(ms) {
  return new Date(ms).toISOString();
}

/* PostgREST returns timestamptz in its own format, so never compare two
   timestamps as strings — "+00:00" and a trailing "Z" both appear. */
function time(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function days(ms) {
  const d = Math.round(ms / 864e5);
  return d <= 1 ? '1 day' : d + ' days';
}

/* ------------------------------------------------------------
   collect — everything the message is built from, in three reads.
   Exported (with digestText) so the tests can drive it at any point in
   time without waiting for tomorrow.
   ------------------------------------------------------------ */

async function collect(now, options) {
  const at = now instanceof Date ? now : new Date(now || Date.now());
  const staleDays = (options && Number.isFinite(options.staleDays))
    ? options.staleDays : FOLLOW_UP_DAYS;
  const windowFrom = iso(at.getTime() - WINDOW_HOURS * 36e5);
  const staleBefore = iso(at.getTime() - staleDays * 864e5);

  const [events, pairs, summary] = await Promise.all([
    sb(
      'roommate_events?select=event,actor_ref,actor_name,subject_name,created_at' +
        '&env=eq.production&created_at=gte.' + encodeURIComponent(windowFrom) +
        '&order=created_at.desc&limit=' + EVENTS_LIMIT,
      { method: 'GET' }
    ),
    /* env=production, the same rule the alerts follow: a pair created in
       a test run is not a pair the team can do anything about, and a
       digest that names one is a digest people stop reading. */
    sb(
      'roommate_mutual_pairs?select=a_id,a_name,b_id,b_name,matched_at' +
        '&env=eq.production&matched_at=lte.' + encodeURIComponent(staleBefore) +
        '&order=matched_at.asc&limit=' + PAIRS_LIMIT,
      { method: 'GET' }
    ),
    sb('roommate_engine_summary?select=*&limit=1', { method: 'GET' }),
  ]);

  const counts = {};
  COUNTED.forEach((k) => { counts[k] = 0; });
  let opened = 0;
  (events || []).forEach((e) => {
    if (e.event === 'viewed') { opened += 1; return; }
    if (counts[e.event] !== undefined) counts[e.event] += 1;
  });

  /* Has either student done anything about this pair since it unlocked?

     Anything at all counts, not just a 'viewed' row: a student who came
     back and passed on somebody else has clearly not abandoned the
     exercise. The 'matched' row itself does not count — it is the
     unlock, not a response to it, and it is written in the same breath
     as the second accept. */
  const pairList = pairs || [];
  const ids = [];
  pairList.forEach((p) => {
    if (ids.indexOf(p.a_id) === -1) ids.push(p.a_id);
    if (ids.indexOf(p.b_id) === -1) ids.push(p.b_id);
  });

  let activity = [];
  if (ids.length) {
    const oldest = pairList.reduce((min, p) => {
      const t = time(p.matched_at);
      return (!min || t < min) ? t : min;
    }, 0);
    activity = (await sb(
      'roommate_events?select=actor_ref,event,created_at' +
        '&actor_ref=in.(' + ids.map(encodeURIComponent).join(',') + ')' +
        '&created_at=gte.' + encodeURIComponent(iso(oldest)) +
        '&order=created_at.desc&limit=' + ACTIVITY_LIMIT,
      { method: 'GET' }
    )) || [];
  }

  const rowsFor = (id) => activity.filter((e) => e.actor_ref === id);
  const live = (id, matchedAt) => rowsFor(id).some((e) =>
    e.event !== 'matched' && time(e.created_at) > time(matchedAt));

  const quiet = [];
  const halfQuiet = [];
  pairList.forEach((p) => {
    const a = live(p.a_id, p.matched_at);
    const b = live(p.b_id, p.matched_at);
    const entry = {
      a_name: p.a_name || 'student A',
      b_name: p.b_name || 'student B',
      matched_at: p.matched_at,
      age_ms: at.getTime() - time(p.matched_at),
    };
    if (!a && !b) quiet.push(entry);
    else if (a !== b) halfQuiet.push(entry);
  });

  const s = (summary && summary[0]) || {};
  return {
    at: iso(at.getTime()),
    windowHours: WINDOW_HOURS,
    stale_days: staleDays,
    counts: counts,
    opened: opened,
    pool: {
      total: Number(s.profiles_total) || 0,
      open: Number(s.profiles_open) || 0,
      mutual: Number(s.mutual_pairs) || 0,
    },
    quiet: quiet,
    half_quiet: halfQuiet,
    /* True when the read hit its cap — the message must not present a
       truncated list as the whole picture. */
    truncated: pairList.length === PAIRS_LIMIT,
  };
}

/* ------------------------------------------------------------
   worthSending / digestText
   ------------------------------------------------------------ */

/* Nothing happened and nothing is rotting → say nothing. A half-quiet
   pair (one side has looked) is a footnote, not a reason to buzz a
   team, so it never triggers a message on its own. */
function worthSending(model) {
  if (model.quiet.length) return true;
  return COUNTED.some((k) => model.counts[k] > 0);
}

function digestText(model) {
  const at = new Date(model.at);
  const days_ = model.windowHours === 24 ? 'last 24 hours' : 'last ' + model.windowHours + ' hours';

  const lines = [
    '\ud83d\udcca <b>Roommate digest</b> \u2014 the ' + days_,
    '',
  ];

  const moved = COUNTED.filter((k) => model.counts[k] > 0);
  if (moved.length) {
    moved.forEach((k) => {
      lines.push('\u2022 <b>' + LABELS[k] + ':</b> ' + model.counts[k]);
    });
  } else {
    lines.push('\u2022 No questionnaire activity \u2014 nobody answered, accepted, passed or withdrew.');
  }

  lines.push('\u2022 <b>Pool:</b> ' + model.pool.total + ' in \u00b7 ' +
    model.pool.open + ' still waiting \u00b7 ' + model.pool.mutual + ' mutual ' +
    (model.pool.mutual === 1 ? 'match' : 'matches'));

  /* Only shown once something has been matched: on a pool with no
     matches, "0 times" is a line nobody needs. */
  if (model.pool.mutual) {
    lines.push('\u2022 <b>Contact details opened:</b> ' + model.opened + ' ' +
      (model.opened === 1 ? 'time' : 'times') + ' in the window');
  }

  if (model.quiet.length) {
    lines.push('');
    lines.push('\u23f3 <b>Matched, and still quiet (' + model.quiet.length + ')</b>');
    model.quiet.forEach((p) => {
      lines.push('\u2022 ' + esc(p.a_name) + ' \u2194 ' + esc(p.b_name) + ' \u2014 unlocked ' +
        days(p.age_ms) + ' ago and <b>neither side has been back</b>');
    });
    lines.push('Send the intro, or check whether either of them ever opened it:');
    lines.push('Dashboard \u2192 Roommates \u2192 the dossier on either name.');
    if (model.truncated) {
      lines.push('(Only the oldest ' + PAIRS_LIMIT + ' are listed.)');
    }
  } else if (model.pool.mutual) {
    lines.push('');
    lines.push('\u2705 Every match older than ' + model.stale_days +
      ' ' + (model.stale_days === 1 ? 'day' : 'days') + ' has been opened by at least one side.');
  }

  if (model.half_quiet.length) {
    lines.push('');
    lines.push('(' + model.half_quiet.length + ' further ' +
      (model.half_quiet.length === 1 ? 'match has' : 'matches have') +
      ' only ONE side looking \u2014 worth a nudge, not a chase.)');
  }

  lines.push('');
  lines.push('\ud83d\udcc5 <b>Session:</b> ' + esc(process.env.ARZUZ_SESSION || '2026/2027'));
  lines.push('\ud83d\udccd <b>Environment:</b> ' + esc(process.env.ARZUZ_ENV || 'production'));
  return lines.join('\n');
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

/* Scheduled functions are invoked by Netlify's scheduler rather than by
   a request, so nothing here reads the event: a run either happens or
   it does not. The body is returned only so a manual invoke prints
   something useful. */
exports.handler = async function () {
  const done = (outcome, model) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, outcome: outcome, quiet_pairs: model ? model.quiet.length : 0 }),
  });

  const { ready } = cfg();
  if (!ready) {
    /* Same shape as roommate-match's 503: not configured is a fact about
       the site, not an error worth a Telegram message every morning. */
    console.log('[roommate-digest] skipped: SUPABASE_SERVICE_ROLE_KEY is not set');
    return done('not-configured');
  }

  let model;
  try {
    model = await collect(new Date());
  } catch (err) {
    console.error('[roommate-digest] read failed:', err.message);
    /* The one failure that IS worth a phone: a digest that stops running
       does it silently, and the whole reason this job exists is that
       nobody is looking at the dashboard. */
    await sendAlert(
      '\u26a0\ufe0f <b>Roommate digest could not run</b>\n\n' +
      esc(err.message) +
      '\n\nThe dashboard still has everything \u2014 only the daily summary failed.'
    );
    return done('read-failed');
  }

  if (!worthSending(model)) {
    console.log('[roommate-digest] quiet: nothing to report in ' + model.windowHours + 'h, no match is stale');
    return done('quiet', model);
  }

  const sent = await sendAlert(digestText(model));
  /* sendAlert never throws and never fails the caller: no token, or the
     per-instance ceiling, answers false and logs. The digest is the
     caller here, so a false is a fact to record, not an error. */
  console.log('[roommate-digest] ' + (sent ? 'sent' : 'not sent') +
    ': ' + model.quiet.length + ' quiet pair(s), ' +
    COUNTED.map((k) => k + '=' + model.counts[k]).join(' '));
  return done(sent ? 'sent' : 'send-failed', model);
};

/* Exported for scripts/test-roommate-score.mjs — the composition is
   tested at chosen instants rather than by waiting for 07:00. */
exports.collect = collect;
exports.digestText = digestText;
exports.worthSending = worthSending;
exports.FOLLOW_UP_DAYS = FOLLOW_UP_DAYS;
exports.WINDOW_HOURS = WINDOW_HOURS;
