#!/usr/bin/env node
/* ============================================================
   Arzuz — can this deploy do what the site promises?

   WHY THIS EXISTS

     The site has a handful of things it tells people it will do, and
     each of them is done by a Netlify Function holding a credential
     that no page can see. Every one of those credentials fails the
     same way when it is missing: NOTHING looks broken. The page
     renders, the button works, the visitor is told their request was
     received — and the message, the row or the code never goes
     anywhere. A missing key is not a crash on this site; it is a
     silence, and silence is what nobody reports.

     The original case: supabase-close-public-inserts.sql revoked
     anon's INSERT on the five public tables and assets/submit.js
     deleted the fallback, so the waitlist door is the ONLY way a
     public form reaches the database — and it needs
     SUPABASE_SERVICE_ROLE_KEY. Without it the door answers 503, the
     page holds the answers in the student's browser, and a student who
     never reopens the page is a lead the team never sees.

     The same shape, twice more:
       · the status page's code, and every confirmation, coverage and
         dispute notice, is sent over OpenWA. Without OPENWA_URL and
         OPENWA_API_KEY the code is ISSUED and never delivered — the
         student waits at a box that will stay empty — and the notices
         are recorded as "not sent" in a trail nobody is reading.
       · the status page's second channel is email. Without
         RESEND_API_KEY that channel is inert, which matters most
         exactly to the student who changed their number.

     So the build refuses. It runs as the Netlify BUILD COMMAND
     (netlify.toml [build] command), which is what makes it a
     deploy-time gate rather than a note in a README: a failed build
     does not publish, so the last good deploy stays live and nobody is
     exposed to the new one. scripts/test-deploy-key.mjs asserts that
     wiring, because a check no deploy runs is decoration.

   REQUIRED vs ADVISED — and why the difference is not a cop-out

     REQUIRED is a list of variables whose absence makes a promise the
     site makes impossible to keep. The build fails.

     ADVISED is a list whose absence degrades the site rather than
     breaking a promise: mail that will not go when WhatsApp still
     will, or a session name that falls back to a hardcoded default.
     Those are printed as warnings and do NOT change the exit code —
     because a gate that fails on a preference is a gate people learn
     to override, and then the real check is worthless.

   WHICH DEPLOYS IT APPLIES TO

     Every build Netlify runs, and that is deliberate — a deploy
     preview is a URL a person can be sent, and a preview whose forms
     silently take nothing is worse than no preview. So a branch or PR
     build needs the same variables, or the override; if a team would
     rather previews build without them, they should set
     preview-scoped variables rather than widen the production ones.
     There is no third mode where the check is only advisory: a warning
     in a build log is a line nobody reads.

   WHAT IT CAN AND CANNOT SEE

     Netlify gives the build the site's environment variables. It does
     NOT give it a variable that was scoped to "Functions" only — and
     a project configured that way is correct, not broken. The script
     cannot tell those two cases apart from inside the build, so it
     does not guess: it fails, and the message names BOTH causes so a
     scoped variable is a one-minute fix rather than a mystery.

     The override is deliberate and documented, in the same spirit as
     `force = true` on a redirect: ARZUZ_ALLOW_MISSING_ENV=1 lets a
     deploy through with nothing set, and ARZUZ_ALLOW_MISSING_ENV=
     OPENWA_URL,OPENWA_API_KEY lets it through with exactly those
     missing. Both say so loudly in the log. The older
     ARZUZ_ALLOW_MISSING_SERVICE_KEY=1 still works and still means the
     one variable it always meant, so a deploy script that already
     carries it does not start failing for a second reason.

   WHAT IT NEVER DOES

     It never prints a value, in whole or in part. A secret read into a
     build log is a secret in a build log, and the log outlives the
     deploy. The only facts it prints are whether each variable is set
     and how long it is.

   Run it:
     node scripts/require-service-key.mjs            # report, never fail
     node scripts/require-service-key.mjs --require  # the build's mode
   ============================================================ */

import { pathToFileURL } from 'node:url';

/* The name the door reads. Kept as its own export because it is the one
   variable with a legacy override of its own, and because the test names
   it in a dozen places. */
export const KEY_NAME = 'SUPABASE_SERVICE_ROLE_KEY';

/* The deliberate override, in two forms: '1'/'true' for everything, or a
   comma-separated list of names for one or two of them. Nothing else —
   so a stray `=0` cannot read as "allow". */
export const OVERRIDE_NAME = 'ARZUZ_ALLOW_MISSING_ENV';

/* The older spelling, kept working: it allowed exactly one variable and
   it still does. A deploy script that already sets it must not start
   failing for a reason it was never asked about. */
export const LEGACY_OVERRIDE_NAME = 'ARZUZ_ALLOW_MISSING_SERVICE_KEY';

/* ------------------------------------------------------------
   The two lists

   Each entry is the name and the SENTENCE A PERSON CAN ACT ON. "Not
   set" is a fact about the build; the `why` is what makes it a fact
   about a student, which is the only kind anyone fixes at 11pm.
   ------------------------------------------------------------ */

export const REQUIRED = [
  {
    name: KEY_NAME,
    why: 'The public submission door cannot write anything without it. Every form on the site — ' +
      'registration, landlord listings, scout reports, bookings, support tickets and the roommate ' +
      'questionnaire — answers 503 not-ready and holds the answers in the visitor\'s browser. There is ' +
      'no fallback path any more: supabase-close-public-inserts.sql revoked it.',
  },
  {
    name: 'OPENWA_URL',
    why: 'The status page\'s verification code, and every confirmation, coverage and dispute notice, ' +
      'goes out over OpenWA. Without this the code is ISSUED and never delivered — the student waits at ' +
      'a box that stays empty — and the notices are recorded as unsent where nobody is reading.',
  },
  {
    name: 'OPENWA_API_KEY',
    why: 'The same sender, and the same silence: the OpenWA request is refused, the message is recorded ' +
      'as not sent, and the person it was for is never told anything.',
  },
];

export const ADVISED = [
  {
    name: 'OPENWA_SESSION',
    why: 'The WhatsApp sending code falls back to a hardcoded session name. If that is not the session ' +
      'your OpenWA server actually has, every message is refused and the site looks healthy while ' +
      'delivering nothing. Set it to the session name (or its UUID) explicitly.',
  },
  {
    name: 'RESEND_API_KEY',
    why: 'The status page\'s SECOND channel — the email a code can go to when a student has changed ' +
      'their number, or when WhatsApp itself is down — is inert without it, and so are the emails on a ' +
      'claim decision. WhatsApp still works, so this is a degradation rather than a broken promise.',
  },
];

/* Absent, '', and '   ' are the same fact: nothing to read. A value of
   spaces is what a half-finished dashboard edit looks like, and it
   would fail at the first request rather than here. */
export function readEnv(env, name) {
  const raw = (env || {})[name];
  const value = String(raw === undefined || raw === null ? '' : raw).trim();
  return { present: value.length > 0, length: value.length };
}

/* What this environment says is allowed to be missing. Answers
   { all, names } — `all` for the '1'/'true' form, `names` for the
   comma-separated form. A name that is not on the REQUIRED list is
   ignored rather than honoured, so a typo cannot quietly excuse the
   variable it was meant to name. */
export function allowedMissing(env) {
  const e = env || {};
  const names = new Set();
  const raw = String(e[OVERRIDE_NAME] || '').trim();
  const lower = raw.toLowerCase();
  if (lower === '1' || lower === 'true') return { all: true, names };

  if (raw) {
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      if (REQUIRED.some((v) => v.name === s)) names.add(s);
    });
  }

  const legacy = String(e[LEGACY_OVERRIDE_NAME] || '').trim().toLowerCase();
  if (legacy === '1' || legacy === 'true') names.add(KEY_NAME);

  return { all: false, names };
}

export function overrideSet(env) {
  const a = allowedMissing(env);
  return a.all || a.names.size > 0;
}

/* The answer, as data — so the test asserts the DECISION rather than a
   sentence, and the CLI only has to print it. */
export function checkEnv(env, opts) {
  const require_ = !!(opts && opts.require);
  const allow = allowedMissing(env);

  const state = REQUIRED.map((v) => {
    const r = readEnv(env, v.name);
    const excused = allow.all || allow.names.has(v.name);
    return { name: v.name, why: v.why, present: r.present, length: r.length, excused: excused };
  });

  const missing = state.filter((v) => !v.present);
  const blocking = missing.filter((v) => !v.excused);
  const excused = missing.filter((v) => v.excused);
  const advised = ADVISED
    .map((v) => ({ name: v.name, why: v.why, present: readEnv(env, v.name).present }))
    .filter((v) => !v.present);

  const lines = [];

  state.forEach((v) => {
    lines.push((v.present ? '  ok   ' : (v.excused ? '  skip ' : '  MISSING ')) + v.name +
      (v.present ? ' (set, ' + v.length + ' characters)' : v.excused ? ' (allowed to be missing here)' : ''));
  });

  if (excused.length && !blocking.length) {
    lines.push('');
    lines.push('WARNING: ' + excused.map((v) => v.name).join(', ') + ' is NOT set and ' +
      (allow.all ? OVERRIDE_NAME + ' allows the whole list' : OVERRIDE_NAME + ' names it') +
      ', so this deploy is proceeding anyway. The features that need ' +
      (excused.length === 1 ? 'it' : 'them') + ' will fail SILENTLY in production: the person on the other ' +
      'end is told their request was received and hears nothing more. Set ' +
      (excused.length === 1 ? 'it' : 'them') + ' under Netlify → Site configuration → Environment ' +
      'variables, then redeploy.');
  }

  if (advised.length) {
    lines.push('');
    advised.forEach((v) => {
      lines.push('WARNING: ' + v.name + ' is not set.');
      lines.push('         ' + v.why);
    });
  }

  if (blocking.length) {
    lines.push('');
    lines.push('This deploy cannot do what the site promises: ' + blocking.length + ' required environment ' +
      'variable' + (blocking.length === 1 ? ' is' : 's are') + ' missing. Every one of them fails ' +
      'SILENTLY — nothing looks broken, and the only symptom is a person who was never told anything.');
    lines.push('');
    blocking.forEach((v) => {
      lines.push('  ' + v.name);
      lines.push('    ' + v.why);
    });
    lines.push('');
    lines.push('  Two possible causes, and only you can tell them apart:');
    lines.push('    1. The variable has not been set. Netlify → Site configuration → Environment ' +
      'variables → Add a variable. It must exist for BOTH the build and the functions, because this ' +
      'build reads it and the functions read it at runtime.');
    lines.push('    2. The variable is set but scoped to "Functions" only. That is a correct configuration ' +
      'for the runtime, and it is what this build cannot see. Give it the site-wide scope as well, or ' +
      'set both.');
    lines.push('');
    lines.push('  If this deploy is meant to go out without ' + (blocking.length === 1 ? 'it' : 'them') +
      ' — a copy change, a page nobody submits from — say so on purpose with a value, not by deleting ' +
      'the check:');
    lines.push('    ' + OVERRIDE_NAME + '=1                       (allow all of them, loudly)');
    lines.push('    ' + OVERRIDE_NAME + '=' + blocking.map((v) => v.name).join(',') +
      '   (allow exactly these)');
  }

  return {
    ok: blocking.length === 0,
    exit: (require_ && blocking.length) ? 1 : 0,
    required: state,
    missing: missing.map((v) => v.name),
    blocking: blocking.map((v) => v.name),
    excused: excused.map((v) => v.name),
    advised: advised.map((v) => v.name),
    override: !!overrideSet(env),
    message: lines.join('\n'),
  };
}

/* ---------------- the CLI ---------------- */

/* Run directly, or imported by the test? Compared by resolved URL so it
   is the same answer on every platform's path separator. */
const invokedDirectly = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const require_ = process.argv.includes('--require') || process.argv.includes('--ci');
  const out = checkEnv(process.env, { require: require_ });

  /* stderr for a failure, stdout for everything else: a build log is
     read top-down by whoever is looking for the red line. An OK with
     warnings still goes to stdout — it is not why the build stopped. */
  if (out.ok) {
    console.log('[deploy-key] ' + out.message);
  } else {
    console.error('[deploy-key] ' + out.message);
    if (!require_) {
      console.error('[deploy-key] (reporting only — pass --require to make this a build failure)');
    }
  }
  process.exit(out.exit);
}

/* For scripts/test-deploy-key.mjs, which drives the decision and then
   the CLI with a controlled environment. */
export default {
  checkEnv, readEnv, allowedMissing, overrideSet,
  REQUIRED, ADVISED, KEY_NAME, OVERRIDE_NAME, LEGACY_OVERRIDE_NAME,
};
