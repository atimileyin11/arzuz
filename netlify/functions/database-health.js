/* ============================================================
   Arzuz — hourly: can this deploy still reach its database?

   THE FAILURE THIS EXISTS FOR

     Every door on the site went down at once and nothing said so. The
     service key in Netlify was set and Supabase refused it (rotated
     upstream, or an anon key pasted into the service slot). Visitors
     did not see an outage — they saw "we could not complete that just
     now, try again in a moment", which no retry fixes — and it was
     found by hand an afternoon later.

   WHAT IT DOES EVERY HOUR

     Runs the probe in lib/database-probe.js: reads a private table
     with the key this deployment was built with, repeats the read
     with one byte changed and REQUIRES that to be refused (so the
     probe cannot report a green it could not tell from a red), then
     calls the two doors a stranger would — /api/finance and
     /api/care-credit — because the key can be right and the DEPLOY
     still wrong.

     On failure it pages the team through sendAlert, the channel every
     other "our side broke" alert uses, with the stage and the sentence
     an operator can act on. notify.js rate-limits server alerts, so an
     outage cannot page endlessly.

   AND ON THE WAY BACK IT SAYS SO — ONCE

     A healthy hour says nothing, which means an outage used to end in
     silence: the last thing the team heard was "broken". So every
     healthy hour records ONE timestamp (lib/health-state.js) and a
     healthy run that finds a gap longer than two hours — at least one
     whole healthy run missed — sends a single all-clear with the last
     healthy time and how long the silence was. It never fires on a
     literal healthy hour, and never twice for the same gap: the new
     timestamp is written immediately after the attempt.

     A FAILING hour writes nothing. The database is the thing that is
     broken, so the write would fail too — and leaving the old
     timestamp in place is what makes the gap visible on the other
     side.

   ALMOST NOTHING IS WRITTEN, WHICH IS WHY IT CAN RUN THIS OFTEN. The
   probe's requests are reads and denials; the only write in the whole
   run is the one timestamp row, rewritten in place. And a healthy hour
   says nothing unless it is the first one after a gap — a daily "all
   good" is how a team learns to ignore the channel.

   IT CANNOT BE CALLED WITH HTTP, AND THAT IS NETLIFY'S RULE

     A function with a `schedule` answers 403 to every external request
     before its code runs (learned the hard way on upload-health). Its
     only outputs are the scheduler run and the alert. To run the same
     check yourself, after a deploy or from CI:

       node scripts/require-service-key.mjs    # the value, at build time
       node dev/care-live-check.mjs            # the Care door, from a shell

   Scheduled in netlify.toml. A missing schedule deploys fine and never
   runs — the same silent failure this function exists to catch, which
   is why the line is not left to memory.
   ============================================================ */

const { probeDatabase, DEFAULT_PROJECT } = require('./lib/database-probe.js');
const { readLastOk, markHealthy, recoveryFrom } = require('./lib/health-state.js');
const { sendAlert } = require('./notify.js');

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
};

/* UTC, minute precision: the time is there so a person can line the gap
   up with the deploy that caused it, not to be pretty. */
function stamp(date) {
  return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

async function allClear(info, probe) {
  const hours = Math.round(info.gapMs / 360000) / 10;
  return sendAlert(
    '\u2705 <b>The site can reach its database again</b>\n\n' +
    'No healthy check was recorded for <b>' + hours + ' hours</b> — the last one was ' + stamp(info.lastOkAt) + '.\n' +
    'That is what a refused service key looks like from inside a function: every form, the Care panel and ' +
    'the checkout answering "not switched on yet" to people who cannot fix it, while every page renders.\n\n' +
    'This hour is green: ' + probe.message + '\n\n' +
    'If you replaced a credential and redeployed, this is the confirmation — nothing to do.\n' +
    'If nobody changed anything, a scheduled run may have been missed instead; the green hour above is the fact.'
  );
}

async function alert(probe) {
  return sendAlert(
    '\u26a0\ufe0f <b>The site cannot reach its database</b>\n\n' +
    'Every form, the Care panel and the checkout are answering "not switched on yet" to people who ' +
    'cannot fix it. Pages still render and buttons still work.\n\n' +
    'Stage: <b>' + probe.stage + '</b>' + (probe.status ? ' (HTTP ' + probe.status + ')' : '') + '\n' +
    probe.message + '\n\n' +
    (HELP[probe.stage] || 'Check the deploy\'s Supabase variables in Netlify.') + '\n\n' +
    'Reproduce: node scripts/require-service-key.mjs --require'
  );
}

exports.handler = async function () {
  let probe;
  try {
    probe = await probeDatabase({
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
      project: process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY,
      base: process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://arzuz.com',
    });
  } catch (err) {
    probe = { ok: false, stage: 'probe', message: 'the probe itself threw: ' + (err && err.message) };
  }

  if (!probe.ok) {
    const sent = await alert(probe);
    console.error('[database-health] ' + probe.stage + ': ' + probe.message + ' (alert sent: ' + sent + ')');
    /* Thrown rather than returned so the failed run is marked failed in
       the function log — the alert is the page, the log is the record. */
    throw new Error('database health: ' + probe.stage + ' — ' + probe.message);
  }

  /* A green hour. Is this the first one after a gap? The read and the
     write are best-effort by design: a project that cannot keep the
     marker still gets a working probe, and the log says which half is
     missing instead of pretending a recovery was announced. */
  const project = process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || DEFAULT_PROJECT;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const now = new Date();

  let recovery;
  try {
    recovery = recoveryFrom(await readLastOk({ project: project, key: key }), now);
  } catch (err) {
    recovery = { send: false, gapMs: 0, lastOkAt: null, reason: 'the marker read threw: ' + (err && err.message) };
  }

  let announced = false;
  if (recovery.send) {
    announced = await allClear(recovery, probe);
    console.log('[database-health] RECOVERED after ' + Math.round(recovery.gapMs / 360000) / 10 +
      ' hours of silence — all-clear sent: ' + announced);
  } else if (recovery.reason) {
    console.log('[database-health] no all-clear possible: ' + recovery.reason);
  }

  /* Written AFTER the attempt, so one gap produces one notice: a send
     that failed is in the log above and is not retried every hour. The
     failed hour never writes, which is what makes the gap measurable. */
  const marked = await markHealthy({ project: project, key: key, at: now });
  if (!marked.ok) console.error('[database-health] could not record this healthy hour: ' + marked.reason);

  console.log('[database-health] ok — ' + probe.message);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, stage: probe.stage, recovered: recovery.send, announced: announced }),
  };
};

/* For the suite, so the alert text is asserted rather than assumed. */
exports.HELP = HELP;
