/* ============================================================
   Arzuz — hourly: can this deploy still do the three things that pay
   and page?

   THE FAILURE THIS EXISTS FOR

     Every door on the site went down at once and nothing said so. The
     service key in Netlify was set and Supabase refused it (rotated
     upstream, or an anon key pasted into the service slot). Visitors
     did not see an outage — they saw "we could not complete that just
     now, try again in a moment", which no retry fixes — and it was
     found by hand an afternoon later.

   WHAT IT DOES EVERY HOUR

     Runs three probes, each of which ASKS THE PROVIDER and then proves
     it can see a refusal, because a green that cannot be told from a
     red is not a green:

       database  lib/database-probe.js — reads a private table with the
                 key this deployment was built with, repeats the read
                 with one byte changed and requires that to be refused,
                 then calls the two doors a stranger would, /api/finance
                 and /api/care-credit, because the key can be right and
                 the DEPLOY still wrong.
       paystack  lib/credential-probes.js — GET /balance with the
                 secret key (your own balance: no customer record, no
                 state change), then the same read with a tampered key.
                 A refused key is the Care Pass checkout answering 502
                 to every buyer.
       telegram  getMe proves the token without messaging anyone, then
                 getChat proves the DESTINATION — a good token pointed
                 at a chat the bot cannot see is the quietest failure on
                 the site, because sendAlert answers false and the
                 student is never told.

     On failure it pages the team through sendAlert, the channel every
     other "our side broke" alert uses, with the stage and the sentence
     an operator can act on. notify.js rate-limits server alerts, so an
     outage cannot page endlessly.

     WHEN TELEGRAM ITSELF IS THE FAILING CHECK, sendAlert is the dead
     channel. That one alert falls back to email when ARZUZ_ALERT_EMAIL
     is set, and the function log records the stage either way — a
     pager that dies silently is the failure this function exists for.

   AND ON THE WAY BACK IT SAYS SO — ONCE PER CHECK

     A healthy hour says nothing, which means an outage used to end in
     silence: the last thing the team heard was "broken". So every
     healthy hour records ONE timestamp PER CHECK (lib/health-state.js)
     and a check that finds a gap longer than ninety minutes — one whole
     hourly run missed, with room for a late one — is announced. The
     checks that recovered in the same hour share ONE message, so a
     total outage is one notice and not three. It never fires on a
     literally consecutive hour, and never twice for the same gap: the
     new timestamps are written immediately after the attempt.

     That threshold is why the shortest outage gets a notice: refused at
     11:00, fixed, green at 12:00 is a two-hour gap from the last
     healthy hour, and it must not be mistaken for a quiet day.

     A check that has never passed — a credential that was already
     broken when this probe shipped — has no healthy hour to measure
     from, so the FIRST REFUSAL is recorded instead and the notice says
     so ("The first refusal was at …"). Without that the team would be
     paged every hour and then hear nothing when it was finally fixed,
     which is the silence in reverse.

     A FAILING check's timestamp is not written. Leaving the old one in
     place is what makes the gap — and so the recovery — visible. The
     checks that DID pass still write theirs, even on a failing run:
     otherwise a long Paystack outage would leave the database's marker
     stale and invent a database "recovery" the moment it ended.

   ALMOST NOTHING IS WRITTEN, WHICH IS WHY IT CAN RUN THIS OFTEN. The
   probes' requests are reads and denials; the only write in the whole
   run is the one state row, rewritten in place. And a healthy hour says
   nothing unless it is the first one after a gap — a daily "all good"
   is how a team learns to ignore the channel.

   IT CANNOT BE CALLED WITH HTTP, AND THAT IS NETLIFY'S RULE

     A function with a `schedule` answers 403 to every external request
     before its code runs (learned the hard way on upload-health). Its
     only outputs are the scheduler run and the alert. To run the same
     checks yourself, after a deploy or from CI:

       node scripts/require-service-key.mjs    # all three values, at build time
       node dev/care-live-check.mjs            # the Care door, from a shell

   Scheduled in netlify.toml. A missing schedule deploys fine and never
   runs — the same silent failure this function exists to catch, which
   is why the line is not left to memory.
   ============================================================ */

const { probeDatabase, DEFAULT_PROJECT } = require('./lib/database-probe.js');
const { probePaystack, probeTelegram } = require('./lib/credential-probes.js');
const { readState, markHealthy, recoveryForState } = require('./lib/health-state.js');
const { sendAlert, sendEmail } = require('./notify.js');

const HELP = {
  key: 'The variable is SET — this is not a missing one. It is either a key that was ROTATED in ' +
    'Supabase after it was copied in, an anon/publishable key pasted into the service slot, or a ' +
    'SUPABASE_URL pointing at another project. Replace the value, then REDEPLOY: a variable edited ' +
    'after a build only reaches the functions of the next deploy.',
  probe: 'The relation the probe reads is reachable WITHOUT a credential, so every green it could ' +
    'report is worthless until that is fixed. That is a leak (RLS or a grant), not a key.',
  unreachable: 'Supabase did not answer at all. Check the project\'s status page, then this deploy\'s ' +
    'SUPABASE_URL — a paused or deleted project looks exactly like this from inside a function.',
  door: 'The key is one Supabase accepts, so this is the DEPLOY: a door shipped before a migration it ' +
    'needs, or a function that never saw the variable. Run node dev/care-live-check.mjs for the layer-by-layer answer.',

  'paystack-refused': 'The variable is SET and Paystack refused it. Read the value back in Netlify: a pk_ PUBLIC ' +
    'key pasted into the secret slot, a TEST key left in a live deploy, or a key ROTATED in the Paystack ' +
    'dashboard — which stops working the moment it is replaced there. Replace the value, then REDEPLOY: a ' +
    'variable edited after a build only reaches the functions of the next deploy.',
  'paystack-account': 'The key was read far enough to identify the account, so this is not a paste error: Paystack is ' +
    'refusing the BUSINESS behind the key (not activated, restricted, or disabled). Nothing in Netlify fixes this. ' +
    'Check the Paystack dashboard, then re-check the key.',
  'paystack-probe': 'Paystack answered a tampered key as readily as the real one, so that route is not checking ' +
    'credentials and its green would prove nothing. Check the probe URL before trusting any result from it.',
  'paystack-api': 'Paystack answered something that is neither an acceptance nor a refusal. That is usually a ' +
    'provider incident or a rate limit: check status.paystack.com before touching the key.',
  'paystack-unreachable': 'Paystack did not answer at all. Check status.paystack.com first; a deploy that cannot ' +
    'reach it will fail every checkout, and rotating a working key would not help.',

  'telegram-token': 'The token is SET and Telegram refused it, so every alert this site sends is dropped — including ' +
    'the one about this. A token regenerated (or /revoke\'d) in BotFather replaces the old one. Replace the value, ' +
    'then REDEPLOY.',
  'telegram-chat': 'The token works but Telegram cannot deliver to TELEGRAM_CHAT_ID: the bot was never added to that ' +
    'chat, the id belongs to a different bot, or the variable is missing. Nothing else on the site complains, because ' +
    'sendAlert answers false and the send is simply dropped.',
  'telegram-probe': 'Telegram answered a tampered token as readily as the real one, so a green here would prove ' +
    'nothing. Check the probe origin before trusting any result from it.',
  'telegram-unreachable': 'Telegram did not answer. The rest of the site is unaffected except that every alert is ' +
    'dropped while this lasts; check status.telegram.org.',
};

/* What a check being down MEANS to a person, in the alert's first line. */
const TITLE = {
  database: 'The site cannot reach its database',
  paystack: 'The Care Pass checkout cannot take a payment',
  telegram: 'The pager is silent',
};

const IMPACT = {
  database: 'Every form, the Care panel and the checkout are answering "not switched on yet" to people who ' +
    'cannot fix it. Pages still render and buttons still work.',
  paystack: 'Every Care Pass checkout is answering 502 to the buyer, and nothing else on the site shows it. ' +
    'The forms, the Care panel and the pager are unaffected.',
  telegram: 'Every alert this site sends is dropped — form leads, claim decisions, and this page. A silent pager ' +
    'is indistinguishable from a healthy site, which is why this is being delivered another way.',
};

const RECOVERED = {
  database: 'The site can reach its database again',
  paystack: 'Paystack accepts its key again',
  telegram: 'The pager can reach Telegram again',
};

const BACK_DETAIL = {
  database: 'That is what a refused service key looks like from inside a function: every form, the Care panel and ' +
    'the checkout answering "not switched on yet" to people who cannot fix it, while every page renders.',
  paystack: 'That is what a refused Paystack key looks like from the outside: the Care Pass checkout answered 502 ' +
    'to every buyer, and the site looked otherwise fine.',
  telegram: 'For that whole time every alert this site sent was dropped — including the one about the outage ' +
    'itself, which is why it went unnoticed for so long.',
};

/* UTC, minute precision: the time is there so a person can line the gap
   up with the deploy that caused it, not to be pretty. */
function stamp(date) {
  return new Date(date).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/* One decimal, so "3 hours" stays "3" and a 2.5-hour gap does not round
   down to the wrong number of missed runs. */
function hours(gapMs) {
  return Math.round(gapMs / 360000) / 10;
}

/* The text, not a send: the caller decides which channel carries it,
   because one of the three checks being dead IS the channel. */
function alertText(name, probe) {
  return (
    '\u26a0\ufe0f <b>' + TITLE[name] + '</b>\n\n' +
    IMPACT[name] + '\n\n' +
    'Stage: <b>' + probe.stage + '</b>' + (probe.status ? ' (HTTP ' + probe.status + ')' : '') + '\n' +
    probe.message + '\n\n' +
    (HELP[probe.stage] || 'Check this deploy\'s environment variables in Netlify.') + '\n\n' +
    'Reproduce: node scripts/require-service-key.mjs --require'
  );
}

/* The same alert as plain text, for the one case where the channel that
   sends HTML is the thing that is broken. */
function plain(text) {
  return text
    .replace(/<b>/g, '').replace(/<\/b>/g, '')
    .replace(/\u26a0\ufe0f /g, '')
    .replace(/\u2705 /g, '');
}

/* ONE message for every check that came back in this hour, so a total
   outage is one notice rather than three. A single check keeps the
   sentence it has always had. */
async function allClear(recovered) {
  if (recovered.length === 1) {
    const one = recovered[0];
    const silence = one.since === 'failing'
      /* No passing hour was ever recorded: this outage began before the
         probe watched this credential, so the first REFUSAL is the
         honest starting point. */
      ? 'The first refusal was at <b>' + stamp(one.lastOkAt) + '</b>, so nothing has been accepted for <b>' +
        hours(one.gapMs) + ' hours</b>.\n'
      : 'No accepted ' + (one.name === 'database' ? 'check' : one.name + ' check') + ' was recorded for <b>' +
        hours(one.gapMs) + ' hours</b> — the last one was ' + stamp(one.lastOkAt) + '.\n';
    return sendAlert(
      '\u2705 <b>' + RECOVERED[one.name] + '</b>\n\n' +
      silence +
      BACK_DETAIL[one.name] + '\n\n' +
      'This hour is green: ' + one.message + '\n\n' +
      'If you replaced a credential and redeployed, this is the confirmation — nothing to do.\n' +
      'If nobody changed anything, a scheduled run may have been missed instead; the green hour above is the fact.'
    );
  }

  const lines = recovered.map((one) =>
    '• <b>' + one.name + '</b> — silent for ' + hours(one.gapMs) + ' hours, last accepted ' + stamp(one.lastOkAt)
  );
  return sendAlert(
    '\u2705 <b>' + recovered.length + ' checks are answering again</b>\n\n' +
    lines.join('\n') + '\n\n' +
    'They came back in the same hour, which is what a total outage — or one redeploy that fixed everything — ' +
    'looks like from here.\n\n' +
    'This hour is green: ' + recovered.map((r) => r.name + ' — ' + r.message).join('; ') + '\n\n' +
    'If you replaced the credentials and redeployed, this is the confirmation — nothing to do.'
  );
}

exports.handler = async function () {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://arzuz.com';
  const project = process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || DEFAULT_PROJECT;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const now = new Date();

  /* --- the three questions, asked one after another --- */

  let probe;
  try {
    probe = await probeDatabase({ key: key, project: project, base: base });
  } catch (err) {
    probe = { ok: false, stage: 'probe', message: 'the probe itself threw: ' + (err && err.message) };
  }
  const checks = [{ name: 'database', probe: probe }];

  const paystackKey = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  checks.push({
    name: 'paystack',
    probe: paystackKey
      ? await probePaystack({ key: paystackKey })
      : { ok: true, stage: 'accepts', skipped: 'PAYSTACK_SECRET_KEY is not set on this deploy' },
  });

  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  checks.push({
    name: 'telegram',
    probe: botToken
      ? await probeTelegram({ token: botToken, chatId: String(process.env.TELEGRAM_CHAT_ID || '').trim() })
      : { ok: true, stage: 'accepts', skipped: 'TELEGRAM_BOT_TOKEN is not set on this deploy' },
  });

  const failing = checks.filter((c) => c.probe.ok === false);
  const telegramDead = checks.some((c) => c.name === 'telegram' && c.probe.ok === false);

  /* --- page for each failing check --- */

  for (const c of failing) {
    const text = alertText(c.name, c.probe);
    let sent = await sendAlert(text);
    let channel = sent ? 'telegram' : 'none';

    /* The pager being the broken thing is not a reason for silence. */
    if (!sent && telegramDead) {
      const to = String(process.env.ARZUZ_ALERT_EMAIL || '').trim();
      if (to) {
        const mail = await sendEmail({ to: to, subject: 'Arzuz: ' + TITLE[c.name], text: plain(text) });
        if (mail.ok) {
          sent = true;
          channel = 'email';
        }
      }
    }

    console.error('[database-health] ' + c.name + ' ' + c.probe.stage + ': ' + c.probe.message +
      ' (paged via ' + channel + ')');
  }

  /* --- and announce anything that came back --- */

  let previous;
  try {
    previous = await readState({ project: project, key: key });
  } catch (err) {
    previous = { known: false, at: {}, reason: 'the marker read threw: ' + (err && err.message) };
  }

  const recovered = [];
  for (const c of checks) {
    if (c.probe.ok !== true) continue;
    const rec = recoveryForState(previous, c.name, now);
    if (rec.send) {
      recovered.push({
        name: c.name,
        gapMs: rec.gapMs,
        lastOkAt: rec.lastOkAt,
        since: rec.since,
        message: c.probe.message,
      });
    }
  }

  let announced = false;
  if (recovered.length) {
    announced = await allClear(recovered);
    console.log('[database-health] RECOVERED: ' + recovered.map((r) => r.name).join(', ') +
      ' after ' + hours(recovered[0].gapMs) + 'h — all-clear sent: ' + announced);
  } else if (previous.reason) {
    console.log('[database-health] no all-clear possible: ' + previous.reason);
  }

  /* Written AFTER the attempt, so one gap produces one notice: a send
     that failed is in the log above and is not retried every hour. Only
     the checks that PASSED are written, and they are written even on a
     failing run — a stale marker would invent a recovery later. */
  const healthy = checks.filter((c) => c.probe.ok === true && !c.probe.skipped).map((c) => c.name);
  if (healthy.length) {
    const marked = await markHealthy({
      project: project,
      key: key,
      at: now,
      checks: healthy,
      failing: failing.map((c) => c.name),
      previous: previous,
    });
    if (!marked.ok) console.error('[database-health] could not record ' + healthy.join(', ') + ': ' + marked.reason);
  }

  if (failing.length) {
    /* Thrown rather than returned so the failed run is marked failed in
       the function log — the alert is the page, the log is the record. */
    throw new Error(
      failing.length === 1 && failing[0].name === 'database'
        ? 'database health: ' + failing[0].probe.stage + ' — ' + failing[0].probe.message
        : 'health probe: ' + failing.map((c) => c.name + ' ' + c.probe.stage).join(', ')
    );
  }

  const state = {};
  for (const c of checks) state[c.name] = c.probe.skipped ? 'not-set' : 'accepts';

  console.log('[database-health] ok — ' + healthy.join(', ') + ' answered');
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      checks: state,
      recovered: recovered.length > 0,
      recovering: recovered.map((r) => r.name),
      announced: announced,
    }),
  };
};

/* For the suite, so the alert text is asserted rather than assumed. */
exports.HELP = HELP;
exports.TITLE = TITLE;
