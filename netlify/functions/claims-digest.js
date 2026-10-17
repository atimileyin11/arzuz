/* ============================================================
   Arzuz — Netlify Function: the Care visit digest (scheduled)

   ONE message a day about the visits that have not happened yet, and
   the one question the office actually has about them: HOW MANY ARE
   PINNED DOWN?

   Why this exists next to claims-aging.js and the notifications:

     claims-aging.js pages the team about a claim that has stood in one
     status past its deadline — that is a claim going wrong. A visit day
     is a different thing: two other people (the worker and the tenant)
     are arranging a time between themselves, and nothing about it is
     late. What nobody can see today is the shape of the whole set: four
     visits agreed and one still being haggled over is a calm day. One
     agreed and four in the air is not, and no single claim's deadline
     says so.

   WHAT IT COUNTS, and the definitions are claims.js's (dayStateOf), so
   the number here and the number on the queue cannot drift apart:

     agreed    the customer said yes to the day the worker suggested
     asked     both halves have spoken and they do not match yet
     waiting   a day is on the table and the customer has not answered

   A claim whose work has already been reported is NOT in any of them:
   that visit happened. And a worker who has named no day yet is not
   "not settled" either — they ring to arrange a time — so they are
   reported as a count at the bottom, never as a problem.

   A QUIET DAY SENDS NOTHING. Not "everything is agreed" — that is a
   good day, and a message saying so every morning is how a team learns
   to ignore the channel (the same rule roommate-digest.js follows). It
   speaks when a day moved in the last 24 hours, or when something is
   still in the air between the two of them. Those are the days somebody
   might have to pick up a phone.

   The one exception is a read that failed: that IS sent, because a
   digest that stops running does it silently and the whole reason this
   job exists is that nobody is looking at the dashboard.

   Schedule: netlify.toml → [functions."claims-digest"] schedule — the
   cron lives in the config file rather than inline, because inline
   scheduling needs an ES module and every function in this repo is
   CommonJS. An hour after roommate-digest, so the two do not arrive
   together.

   Run it by hand: Netlify UI → Functions → claims-digest → Run now, or
   locally with `netlify functions:invoke claims-digest`.

   Environment variables (the same two every claims surface uses):
     SUPABASE_SERVICE_ROLE_KEY  — secret, Netlify only
     TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — optional; without a token
                                  the digest is composed and NOT sent
   ============================================================ */

const { sendAlert, esc } = require('./notify.js');

/* The Supabase plumbing has exactly one owner (claims.js → its own sb),
   and the readiness check has one owner too (roommate-match.js). Nothing
   is copied here. */
const { cfg } = require('./roommate-match.js');
const { visitsToCome, dayStateOf } = require('./claims.js');

/* The digest reports the last day. It is not "since the last digest": a
   missed run would then silently swallow a day, and a rerun would
   double-report. A fixed window is boring and correct. */
const WINDOW_HOURS = 24;

/* How many of each kind are printed. The COUNTS are always exact; only
   the lists are capped, because a Telegram message with forty bullets
   is a message nobody reads, and the dashboard has all of them. */
const LIST_LIMIT = 8;

/* PostgREST returns timestamptz in its own format, so never compare two
   timestamps as strings — "+00:00" and a trailing "Z" both appear. */
function time(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/* How long ago, in words. Never an absolute date: a visit day is a
   sentence a person said ("Sunday afternoon"), and turning it into a
   timestamp means guessing whose timezone and then printing the guess as
   an appointment. The AGE is the honest fact — how long something has
   been waiting on somebody. */
function ago(ms) {
  if (ms < 0) return 'just now';
  const mins = Math.round(ms / 6e4);
  if (mins < 60) return mins <= 1 ? 'a minute ago' : mins + ' minutes ago';
  const hrs = Math.round(ms / 36e5);
  if (hrs < 36) return hrs === 1 ? 'an hour ago' : hrs + ' hours ago';
  const days = Math.round(ms / 864e5);
  return days <= 1 ? 'a day ago' : days + ' days ago';
}

function where(r) {
  return [r.property, r.room].filter((x) => !!x).join(' \u00b7 ');
}

function who(r) {
  return esc(r.student_name || 'the tenant') + (where(r) ? ' \u00b7 ' + esc(where(r)) : '');
}

/* ------------------------------------------------------------
   collect — the model, from one read
   Exported (with digestText) so the tests can drive it at any point in
   time without waiting for tomorrow morning.
   ------------------------------------------------------------ */

async function collect(now) {
  const at = now instanceof Date ? now : new Date(now || Date.now());
  const from = at.getTime() - WINDOW_HOURS * 36e5;
  /* env=production, the same rule the roommate digest and the alerts
     follow: a claim filed in a test run is not a visit the team can do
     anything about, and naming one in the morning message is how a
     digest loses its readers. */
  const rows = await visitsToCome('production');

  const model = {
    at: at, windowHours: WINDOW_HOURS,
    agreed: [], asked: [], waiting: [],
    quietAgreed: 0, noDay: 0, listed: 0,
  };

  rows.forEach((r) => {
    const state = dayStateOf(r);
    if (!state) { model.noDay += 1; return; }
    if (state === 'agreed') {
      /* News only if it happened in the window: a visit agreed a week
         ago is one of the count, not one of today's facts. */
      if (time(r.day_agreed_at) >= from) model.agreed.push(r);
      else model.quietAgreed += 1;
      return;
    }
    if (state === 'asked') model.asked.push(r);
    else model.waiting.push(r);
  });

  /* Oldest first inside each list: the one that has been waiting longest
     is the one most likely to need a person. */
  ['agreed', 'asked', 'waiting'].forEach((k) => {
    model[k].sort((a, b) => best(a, k) - best(b, k));
  });

  model.counts = {
    visits: model.agreed.length + model.quietAgreed + model.asked.length + model.waiting.length,
    agreed: model.agreed.length + model.quietAgreed,
    asked: model.asked.length,
    waiting: model.waiting.length,
    open: model.asked.length + model.waiting.length,
    noDay: model.noDay,
    /* A page, not the table: said out loud rather than letting a caps'd
       read pass for the whole truth. */
    capped: rows.length >= 500,
  };
  return model;
}

/* When the thing started waiting: for a counter-offer, the moment the
   customer answered; for a bare suggestion, the moment the worker
   offered it. */
function best(r, kind) {
  if (kind === 'agreed') return time(r.day_agreed_at) || time(r.customer_proposed_at);
  return (kind === 'asked' ? time(r.customer_proposed_at) : time(r.provider_proposed_at)) || time(r.created_at);
}

/* Speak when a day moved in the window, or when something is still in
   the air between the two of them. Everything agreed and nothing new is
   a quiet day — the two of them settled it and nothing is owed. */
function worthSending(model) {
  return !!(model.agreed.length || model.asked.length || model.waiting.length);
}

function line(r, kind, at) {
  const ref = '<b>' + esc(r.reference) + '</b> \u00b7 ' + who(r);
  const worker = '<i>' + esc(r.provider_name || 'the worker') + '</i>';
  if (kind === 'agreed') {
    return '\u2022 ' + ref + '\n  ' + worker + ' suggested \u201c' +
      esc(String(r.provider_proposal || '').slice(0, 160)) +
      '\u201d, and the customer <b>agreed it</b> ' + ago(at - time(r.day_agreed_at)) + '.';
  }
  if (kind === 'asked') {
    return '\u2022 ' + ref + '\n  ' + worker + ' suggested \u201c' +
      esc(String(r.provider_proposal || '').slice(0, 160)) + '\u201d\n  the customer answered \u201c' +
      esc(String(r.customer_proposal || '').slice(0, 200)) + '\u201d, ' +
      ago(at - (time(r.customer_proposed_at) || time(r.created_at))) + '.';
  }
  return '\u2022 ' + ref + '\n  ' + worker + ' offered \u201c' +
    esc(String(r.provider_proposal || '').slice(0, 160)) + '\u201d ' +
    ago(at - (time(r.provider_proposed_at) || time(r.created_at))) +
    ' \u2014 the customer has not answered it.';
}

function section(lines, model, kind, title, warning) {
  const rows = model[kind];
  if (!rows.length) return;
  lines.push('');
  lines.push((warning ? '\u23f3 ' : '') + '<b>' + title + ' (' + rows.length + ')</b>');
  rows.slice(0, LIST_LIMIT).forEach((r) => lines.push(line(r, kind, model.at.getTime())));
  if (rows.length > LIST_LIMIT) {
    lines.push('(+' + (rows.length - LIST_LIMIT) + ' more \u2014 the oldest ' + LIST_LIMIT +
      ' are listed; the dashboard has every one.)');
  }
}

function digestText(model) {
  const c = model.counts;
  const lines = [];
  lines.push('\ud83d\uddd3\ufe0f <b>Arzuz Care \u2014 visits still to come</b>');
  lines.push('');
  lines.push('<b>' + c.visits + '</b> visit' + (c.visits === 1 ? '' : 's') + ' with a day on the table \u00b7 ' +
    '<b>' + c.agreed + '</b> agreed \u00b7 ' +
    (c.open ? '<b>' + c.open + '</b> not settled yet' : 'everything settled'));
  if (c.capped) lines.push('(Counting the most recent 500 claims \u2014 the number is a floor, not the total.)');

  section(lines, model, 'agreed', 'Agreed in the last day');
  section(lines, model, 'asked', 'Still being haggled over', true);
  section(lines, model, 'waiting', 'Offered, and the customer has not answered');

  lines.push('');
  if (c.quietAgreed) {
    lines.push('<b>Already agreed:</b> ' + c.quietAgreed + ' more visit' +
      (c.quietAgreed === 1 ? ' was' : 's were') + ' settled before yesterday and are still to come.');
  }
  if (c.noDay) {
    lines.push('<b>No day named yet:</b> ' + c.noDay + ' claim' + (c.noDay === 1 ? '' : 's') +
      ' with a worker on it \u2014 they ring to arrange the time, so nothing there is waiting on us.');
  }
  lines.push('');
  lines.push('\ud83d\udcde <b>What to do:</b> nothing, unless one of these goes quiet. The two of them have ' +
    'each other\u2019s number and settle the time between them \u2014 a moved day is not a refusal and the job is ' +
    'still theirs. Ring in if the same one is on this list tomorrow, or if the customer has not answered before ' +
    'the day the worker is expecting to come.');
  lines.push('');
  lines.push('\ud83d\udcc5 <b>Session:</b> ' + esc(process.env.ARZUZ_SESSION || '2026/2027'));
  lines.push('\ud83d\udccd <b>Environment:</b> ' + esc(process.env.ARZUZ_ENV || 'production'));
  return lines.join('\n');
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

/* Scheduled functions are invoked by Netlify's scheduler rather than by
   a request, so nothing here reads the event: a run either happens or it
   does not. The body is returned only so a manual invoke prints
   something useful. */
exports.handler = async function () {
  const done = (outcome, model) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok: true, outcome: outcome,
      visits: model ? model.counts.visits : 0,
      open: model ? model.counts.open : 0,
    }),
  });

  const { ready } = cfg();
  if (!ready) {
    /* Same shape as the other jobs' 503: not configured is a fact about
       the site, not an error worth a Telegram message every morning. */
    console.log('[claims-digest] skipped: SUPABASE_SERVICE_ROLE_KEY is not set');
    return done('not-configured');
  }

  let model;
  try {
    model = await collect(new Date());
  } catch (err) {
    console.error('[claims-digest] read failed:', err.message);
    /* The one failure that IS worth a phone: a digest that stops running
       does it silently, and the whole reason this job exists is that
       nobody is looking at the dashboard. */
    await sendAlert(
      '\u26a0\ufe0f <b>The Care visit digest could not run</b>\n\n' +
      esc(err.message) +
      '\n\nNothing is lost \u2014 the queue and every claim are still in the dashboard. Only the daily ' +
      'summary failed, and it will not say so again tomorrow unless it fails again.'
    );
    return done('read-failed');
  }

  if (!worthSending(model)) {
    console.log('[claims-digest] quiet: ' + model.counts.visits +
      ' visit(s), every one agreed and none moved in the last ' + WINDOW_HOURS + 'h');
    return done('quiet', model);
  }

  const sent = await sendAlert(digestText(model));
  /* sendAlert never throws and never fails the caller: no token, or the
     per-instance ceiling, answers false and logs. The digest is the
     caller here, so a false is a fact to record, not an error. */
  console.log('[claims-digest] ' + (sent ? 'sent' : 'not sent') +
    ': ' + model.counts.visits + ' visit(s), ' + model.counts.agreed + ' agreed, ' +
    model.counts.asked + ' haggled, ' + model.counts.waiting + ' unanswered, ' +
    model.counts.noDay + ' with no day named');
  return done(sent ? 'sent' : 'send-failed', model);
};

/* Exported for scripts/test-claims.mjs — the composition is tested at
   chosen instants rather than by waiting for the morning. */
exports.collect = collect;
exports.digestText = digestText;
exports.worthSending = worthSending;
exports.WINDOW_HOURS = WINDOW_HOURS;
exports.LIST_LIMIT = LIST_LIMIT;
