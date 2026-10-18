/* ============================================================
   Arzuz — the hourly check, as ONE line the dashboard can print

   WHY THIS EXISTS

     The probe in netlify/functions/database-health.js already
     remembers when each credential last passed (lib/health-state.js)
     so it can announce a recovery. That memory was only ever read by
     the probe itself: the only way a person could learn the state was
     to be paged, which means the answer to "is Paystack still
     accepting our key?" existed in the database and nowhere a human
     looked.

     This turns it into a sentence. The team sees the last accepted
     hour for each check without waiting for an alert — and sees a
     STALE hour as stale, which is the half that matters: a line that
     printed "12:00" with no comment would be read as "fine" at six in
     the evening.

   THE PAGE HOLDS NO SECOND OPINION

     Same rule as the Finance panel: this module decides, the endpoint
     serves, the dashboard prints. If the page worked out staleness for
     itself there would be two definitions of the ninety-minute grace
     and they would drift — so the threshold is imported from
     health-state.js, which is also where the all-clear gets it.

   WHAT IT WILL NOT SAY

     · It never prints a green for a check with no recorded hour. A
       marker that was never written is not a healthy hour, and the
       first day of a deploy is exactly when that distinction matters.
     · It never calls a check fresh because the OTHER checks passed.
       Every check is judged on its own timestamp.
     · It never treats an unreadable marker as "nothing happened".
       The reason is printed, so a missing table or a refused read
       reads as "cannot be confirmed here", not as silence.

   THE ONE CASE THE TIMESTAMPS ALONE WOULD MISS

     A check refused at 14:00 after passing at 13:00 is inside the
     ninety-minute grace, so its last accepted hour still looks fresh.
     That is why health-state.js records the FIRST REFUSAL of an
     outage: a refusal newer than the last acceptance is a live
     failure, whatever the gap says. It is the same fact that lets an
     outage predating the probe still end.

   One caller: netlify/functions/health-summary.js, behind the staff
   login. Kept pure (no fetch, no clock of its own) so the suite can
   assert the sentences instead of stubbing a network.
   ============================================================ */

const { CHECKS, GRACE_MS } = require('./health-state.js');

const LABEL = {
  database: 'Database',
  paystack: 'Paystack',
  telegram: 'Telegram',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function when(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/* UTC, minute precision, because that is what the probe writes and
   what every alert already says. The date is dropped only for a
   timestamp from today in UTC: "14:00 UTC" is shorter and still
   unambiguous on the day it happened, while a mark from yesterday
   must not be read as this afternoon. */
function hourLabel(date, now) {
  const d = when(date);
  if (!d) return null;
  const n = when(now) || new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const sameDay = d.toISOString().slice(0, 10) === n.toISOString().slice(0, 10);
  if (sameDay) return hh + ':' + mm + ' UTC';
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + hh + ':' + mm + ' UTC';
}

/* One decimal, so a two-and-a-half hour gap does not read as "2h" —
   the same rounding the all-clear uses. */
function hours(ms) {
  return Math.round(ms / 360000) / 10;
}

function graceMinutes() {
  return Math.round(GRACE_MS / 60000);
}

/* One check, judged on its own two facts. */
function one(name, state, now) {
  const at = state && state.at ? when(state.at[name]) : null;
  const since = state && state.failing ? when(state.failing[name]) : null;

  /* A refusal AFTER the last acceptance is the outage. A refusal
     BEFORE it was cleared by that acceptance — health-state.js deletes
     it on a passing hour, and this guard keeps a stale row from
     resurrecting one. */
  const refusing = !!(since && (!at || since.getTime() > at.getTime()));
  const gapMs = at ? Math.max(0, now.getTime() - at.getTime()) : 0;
  const stale = !!at && gapMs > GRACE_MS;

  const label = LABEL[name] || name;
  const accepted = at ? hourLabel(at, now) : null;
  const refused = refusing ? hourLabel(since, now) : null;

  let kind;
  if (refusing) kind = 'refused';
  else if (!at) kind = 'never';
  else if (stale) kind = 'stale';
  else kind = 'fresh';

  let segment;
  if (kind === 'fresh') segment = label + ' ' + accepted;
  else if (kind === 'stale') segment = label + ' ' + accepted + ' (' + hours(gapMs) + 'h silent)';
  else if (kind === 'refused' && at) segment = label + ' ' + accepted + ', refused ' + refused;
  else if (kind === 'refused') segment = label + ' never accepted, refused ' + refused;
  else segment = label + ' never accepted';

  let problem = null;
  if (kind === 'stale') problem = label + ' has not been accepted since ' + accepted;
  else if (kind === 'refused' && at) problem = label + ' was refused at ' + refused;
  else if (kind === 'refused') problem = label + ' has never accepted the value, and was refused at ' + refused;
  else if (kind === 'never') problem = label + ' has never been accepted';

  return {
    name: name,
    label: label,
    state: kind,
    lastAcceptedAt: at ? at.toISOString() : null,
    lastAccepted: accepted,
    failingSince: refusing ? since.toISOString() : null,
    refusedAt: refused,
    hoursSilent: at ? hours(gapMs) : null,
    segment: segment,
    problem: problem,
  };
}

/**
 * The line, from the probe's own memory.
 *
 * @param {{known: boolean, at: object, failing: object, reason?: string}} state
 *        what lib/health-state.js readState() returned
 * @param {Date|string} [now]
 * @returns {{level: string, line: string, checks: object[], graceMinutes: number}}
 *          level: ok | warn — the dot colour, and nothing more
 */
function summarise(state, now) {
  const at = when(now) || new Date();
  const checks = CHECKS.map((name) => one(name, state, at));

  if (!state || !state.known) {
    const reason = (state && state.reason) || 'no marker';
    const first = /no marker recorded yet/.test(reason);
    return {
      level: 'warn',
      line: first
        ? 'Hourly checks — nothing recorded yet. The scheduled run writes the first line; if this stays empty, the schedule or the function is not running.'
        : 'Hourly checks — no record to read: ' + reason + '. Until the run can write its marker, nothing here can be confirmed.',
      checks: checks,
      graceMinutes: graceMinutes(),
    };
  }

  const problems = checks.map((c) => c.problem).filter(Boolean);
  const segments = checks.map((c) => c.segment).join(' \u00b7 ');

  /* When this reading was taken. Without it a dashboard left open shows
     "within the last 90 minutes" hours later — a sentence that was true
     when it was written and is not any more. The hours themselves are
     absolute and stay true; this is the one clause that ages. */
  const readAt = 'Read at ' + hourLabel(at, at) + '.';

  if (!problems.length) {
    return {
      level: 'ok',
      line: 'Hourly checks — ' + segments + ' — all accepted within the last ' + graceMinutes() + ' minutes. ' + readAt,
      checks: checks,
      graceMinutes: graceMinutes(),
    };
  }

  return {
    level: 'warn',
    line: 'Hourly checks — ' + segments + ' — ' + problems.join('; ') + '. ' + readAt,
    checks: checks,
    graceMinutes: graceMinutes(),
  };
}

module.exports = { summarise, hourLabel, LABEL, GRACE_MS };
