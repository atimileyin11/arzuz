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

     And each of the three fails a SECOND time, one step later: a
     ROTATED key is present, so a gate that only reads names passes,
     the deploy ships, and the silence arrives with the build's
     blessing. So the gate now TRIES every value against the provider
     that has to accept it, and reports what came back — see THE VALUE,
     NOT JUST THE NAME below.

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
    name: 'PAYSTACK_SECRET_KEY',
    why: 'The money core. Without it every checkout answers not-ready and the webhook cannot verify a ' +
      'signature — which is correct while the Care Pass is deliberately off sale, and a dead end the ' +
      'moment it is put on sale. Absence is a product state; a value Paystack REFUSES is not, and that is ' +
      'checked below like the others.',
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    why: 'The alert channel. Without it sendAlert answers false and nothing reaches the team — including ' +
      'the alert that would have told them something else broke. The pager being silent looks exactly ' +
      'like everything being fine.',
  },
  {
    name: 'TELEGRAM_CHAT_ID',
    why: 'The destination the alert goes TO. A token with no chat id sends nothing, with no error ' +
      'anywhere a person would look.',
  },
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
   comma-separated form.

   Both lists are nameable, not just REQUIRED. RESEND_API_KEY is
   ADVISED (its absence degrades rather than breaks), but a value the
   provider REFUSES is a different fact — it blocks — so the one
   documented hatch has to be able to name it, or the report would
   print a hatch that does not open.

   A name on neither list is ignored rather than honoured, so a typo
   cannot quietly excuse the variable it was meant to name. */
export function allowedMissing(env) {
  const e = env || {};
  const names = new Set();
  const raw = String(e[OVERRIDE_NAME] || '').trim();
  const lower = raw.toLowerCase();
  if (lower === '1' || lower === 'true') return { all: true, names };

  if (raw) {
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      if (REQUIRED.concat(ADVISED).some((v) => v.name === s)) names.add(s);
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

/* ------------------------------------------------------------
   THE VALUE, NOT JUST THE NAME

   Everything above reads whether a variable is SET. A rotated key is
   set: this gate passes, the deploy ships, and every door answers
   "not switched on yet" to a person who cannot fix it. That is the
   same silence one step later — the build said the credential was
   there, the site could not use it, and nobody was told.

   So the build now spends two requests proving the VALUE is one the
   project accepts. Two, because a check that cannot fail is not a
   check: the second sends a tampered copy of the same key and
   REQUIRES the project to refuse it. If it is not refused, then the
   relation is readable without a key at all and the first answer
   would have been green for the wrong reason.

   THE SAME PROOF, FOR THE OTHER TWO CREDENTIALS

     A missing OPENWA_API_KEY fails this build already. A ROTATED one
     did not: it is set, so the gate passed, and the site then issued
     students a code and recorded the message as unsent. Same for
     RESEND_API_KEY, which is why both are tried here too — one request
     each, plus a tampered copy that has to be refused before a green
     counts.
   ------------------------------------------------------------ */

/* The same fallback the functions carry (waitlist.js, status.js and the
   rest), so the build checks the project the deploy will actually talk
   to rather than one only this file knows about. */
export const SUPABASE_URL_FALLBACK = 'https://nihdbhjecdkpvzvjifrm.supabase.co';

/* The cheapest read that proves a SERVICE key: finance_config is a
   private table under RLS, so a key that is not this project's cannot
   read it, and the rows are settings rather than anybody's details. */
export const PROBE_PATH = 'finance_config?select=key&limit=1';

export function projectUrl(env) {
  const raw = String((env || {}).SUPABASE_URL || (env || {}).SUPABASE_URL_KEY || '').trim();
  return (raw || SUPABASE_URL_FALLBACK).replace(/\/+$/, '');
}

/* ONE byte of the key, so the tampered request is the same shape as the
   real one — not an empty string, which some proxies refuse before any
   credential is looked at. */
export function tamperKey(key) {
  const s = String(key || '');
  if (!s) return 'x';
  const first = s.slice(0, 1);
  return (first === 'a' ? 'b' : 'a') + s.slice(1);
}

/* 401/403 is the project refusing the value. Any other answer below 500
   means PostgREST read the request — so the credential was accepted and
   whatever went wrong was the request, not the key. A 5xx is the project
   having a bad minute, which is not a fact about the value. */
export function classifyAnswer(status) {
  if (status === 401 || status === 403) return 'refused';
  if (status >= 200 && status < 500) return 'accepted';
  return 'unknown';
}

async function ask(doFetch, url, key) {
  let controller = null;
  let timer = null;
  try {
    /* A controller rather than AbortSignal.timeout(), and the timer is
       cleared in `finally`: this process is about to exit, and a timer
       still armed at exit takes the whole build down with it on some
       platforms (libuv asserts instead of returning the exit code). */
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 8000);
    }
    const res = await doFetch(url + '/rest/v1/' + PROBE_PATH, {
      method: 'GET',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      signal: controller ? controller.signal : undefined,
    });
    /* READ, even though nothing here needs the body: an unconsumed
       response leaves its socket open, and an exit with one pending is
       the crash above wearing a different hat. */
    if (res && typeof res.text === 'function') await res.text().catch(() => '');
    const status = Number(res && res.status);
    const state = classifyAnswer(status);
    return {
      state: state,
      status: status,
      message: state === 'refused'
        ? 'the project refused this value (HTTP ' + status + ')'
        : 'the project answered HTTP ' + status,
    };
  } catch (err) {
    return { state: 'unreachable', message: 'the project did not answer: ' + ((err && err.message) || 'unknown') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.url]    project origin; the caller resolves it with projectUrl()
 * @param {string} [opts.key]    the value to try — never printed, never returned
 * @param {boolean} [opts.sanity] require the tampered key to be refused (default true)
 * @param {Function} [opts.fetch] injected by the suite; global fetch in a build
 * @returns {Promise<{state: string, status?: number, message: string, host?: string}>}
 *          state: accepted | refused | blind | unreachable | unknown | unchecked
 */
export async function probeServiceKey(opts) {
  const o = opts || {};
  const url = String(o.url || '').replace(/\/+$/, '');
  const key = String(o.key || '');
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const host = url.replace(/^https?:\/\//, '');

  if (!url || !key) return { state: 'unchecked', message: 'there is no value to try' };
  if (!doFetch) return { state: 'unchecked', host: host, message: 'this Node has no fetch, so the value cannot be tried' };

  const tried = await ask(doFetch, url, key);
  if (tried.state !== 'accepted') return Object.assign(tried, { host: host });

  if (o.sanity !== false) {
    const bad = await ask(doFetch, url, tamperKey(key));
    if (bad.state === 'accepted') {
      return {
        state: 'blind',
        status: bad.status,
        host: host,
        message: 'the project accepted a TAMPERED key, so this relation can be read without one ' +
          '— a green here would have proved nothing about the credential',
      };
    }
  }

  return Object.assign(tried, { host: host });
}

/* ------------------------------------------------------------
   THE WHATSAPP SENDER, TRIED

   GET /api/sessions is the cheapest read that proves an OpenWA key:
   it is behind the same global API-key guard every send goes through,
   it writes nothing, and it needs no role — any valid key may list
   sessions. It also answers the second question the send path cares
   about (does the configured session exist?), which a bare
   "valid: true" endpoint would not.

   WHAT IS *NOT* A REFUSED KEY

     403 means the key was FOUND and the ADDRESS was turned away — an
     IP allowlist on the key. Netlify's build egress and its function
     egress are different addresses, so a build blocked on that would
     stop a deploy that works. It is reported, loudly, and does not
     block. 404 means this OpenWA has no such route: a version
     mismatch, not a verdict about the value, so it does not block
     either. Only 401 is "the sender does not know this key".
   ------------------------------------------------------------ */

export const OPENWA_PROBE_PATH = '/api/sessions';

/* Where the email key is tried. Overridable ONLY so the suite can point
   at a stand-in; nothing else in the repo sets it. */
export const RESEND_PROBE_URL = 'https://api.resend.com/emails';
export const RESEND_PROBE_URL_ENV = 'ARZUZ_RESEND_PROBE_URL';

export function senderUrl(env) {
  return String((env || {}).OPENWA_URL || '').trim().replace(/\/+$/, '');
}

/* The STATUS is the fact. Bodies from these two providers are prose
   that can change without notice, and one of them is not ours to
   quote; the classification never reads a body. */
export function classifySenderAnswer(status) {
  if (status === 401) return 'refused';
  if (status === 403) return 'forbidden';
  if (status >= 200 && status < 500) return 'accepted';
  return 'unknown';
}

/* Resend reads the credential before the body: a wrong key is 401 and a
   valid one is a 4xx about the empty body. Any other status below 500
   is still proof the credential was read — and a 5xx is Resend having a
   bad minute, which is not a fact about the value. */
export function classifyEmailAnswer(status) {
  if (status === 401) return 'refused';
  /* 403 is the account or the domain, not the credential — Resend uses it
     for a key that is real but not allowed to do THIS. Warning, never a
     failed build, and never a green either. */
  if (status === 403) return 'unknown';
  if (status >= 200 && status < 500) return 'accepted';
  return 'unknown';
}

/* One request with a hard stop, body always drained. The timer is
   cleared in `finally` for the reason ask() documents: an armed timer
   at exit can abort the process instead of returning the exit code. */
async function request(doFetch, url, init) {
  let controller = null;
  let timer = null;
  try {
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 8000);
    }
    const res = await doFetch(url, Object.assign({}, init, {
      signal: controller ? controller.signal : undefined,
    }));
    const text = res && typeof res.text === 'function'
      ? await res.text().catch(() => '')
      : '';
    return { status: Number(res && res.status), text: text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* The list is an array on every version of the route this repo has
   used; the two wrappers are tolerated so a future shape does not turn
   a proven key into "could not check". Anything else is `null`, which
   means "no verdict about the session" rather than "missing". */
function parseSessions(text) {
  let body = null;
  try { body = JSON.parse(text); } catch (_) { return null; }
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  if (body && Array.isArray(body.data)) return body.data;
  return null;
}

/* The env may hold the session's uuid or its name, and the server's own
   send route accepts either — so a match on either is a match, and an
   unparseable list is "unknown", never "wrong". */
export function sessionFound(sessions, wanted) {
  if (!Array.isArray(sessions) || !wanted) return null;
  const w = String(wanted).trim().toLowerCase();
  return sessions.some((s) => String((s && s.id) || '').toLowerCase() === w ||
    String((s && s.name) || '').toLowerCase() === w);
}

async function senderAsk(doFetch, url, key) {
  try {
    const res = await request(doFetch, url + OPENWA_PROBE_PATH, {
      method: 'GET',
      headers: { 'X-API-Key': key },
    });
    const state = classifySenderAnswer(res.status);
    return {
      state: state,
      status: res.status,
      sessions: state === 'accepted' ? parseSessions(res.text) : null,
      message: state === 'refused'
        ? 'the sender refused this value (HTTP ' + res.status + ')'
        : state === 'forbidden'
          ? 'the sender knows this key but refused this ADDRESS (HTTP ' + res.status + ')'
          : 'the sender answered HTTP ' + res.status,
    };
  } catch (err) {
    return { state: 'unreachable', message: 'the sender did not answer: ' + ((err && err.message) || 'unknown') };
  }
}

async function emailAsk(doFetch, url, key) {
  try {
    const res = await request(doFetch, url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      /* An EMPTY body on purpose: no recipient, no sender, no text. Resend
         validates the credential first and then the body, so this can
         prove the key without a single mail leaving the account. */
      body: '{}',
    });
    const state = classifyEmailAnswer(res.status);
    return {
      state: state,
      status: res.status,
      message: state === 'refused'
        ? 'Resend refused this value (HTTP ' + res.status + ')'
        : 'Resend read the credential and answered HTTP ' + res.status,
    };
  } catch (err) {
    return { state: 'unreachable', message: 'Resend did not answer: ' + ((err && err.message) || 'unknown') };
  }
}

/**
 * @returns {Promise<{state: string, status?: number, message: string, host?: string,
 *                    sessions?: Array|null, session?: string|null, sessionFound?: boolean|null}>}
 */
export async function probeSender(opts) {
  const o = opts || {};
  const url = String(o.url || '').replace(/\/+$/, '');
  const key = String(o.key || '');
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const host = url.replace(/^https?:\/\//, '');

  if (!url || !key) return { state: 'unchecked', message: 'there is no value to try' };
  if (!doFetch) return { state: 'unchecked', host: host, message: 'this Node has no fetch, so the value cannot be tried' };

  const tried = await senderAsk(doFetch, url, key);
  if (tried.state !== 'accepted') return Object.assign(tried, { host: host });

  if (o.sanity !== false) {
    const bad = await senderAsk(doFetch, url, tamperKey(key));
    const tamperAccepted = bad.state === 'accepted';
    if (tamperAccepted) {
      return {
        state: 'blind',
        status: bad.status,
        host: host,
        message: 'the sender answered a TAMPERED key with HTTP ' + bad.status + ' too, so it is not ' +
          'checking the credential on this route — a green here would have proved nothing',
      };
    }
  }

  const session = String(o.session || '').trim();
  return Object.assign(tried, {
    host: host,
    session: session || null,
    sessionFound: session ? sessionFound(tried.sessions, session) : null,
  });
}

/**
 * @returns {Promise<{state: string, status?: number, message: string, host?: string}>}
 */
export async function probeEmail(opts) {
  const o = opts || {};
  const url = String(o.url || RESEND_PROBE_URL);
  const key = String(o.key || '');
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const host = url.replace(/^https?:\/\//, '').split('/')[0];

  if (!key) return { state: 'unchecked', message: 'there is no value to try' };
  if (!doFetch) return { state: 'unchecked', host: host, message: 'this Node has no fetch, so the value cannot be tried' };

  const tried = await emailAsk(doFetch, url, key);
  if (tried.state !== 'accepted') return Object.assign(tried, { host: host });

  if (o.sanity !== false) {
    const bad = await emailAsk(doFetch, url, tamperKey(key));
    const tamperAccepted = bad.state === 'accepted';
    if (tamperAccepted) {
      return {
        state: 'blind',
        status: bad.status,
        host: host,
        message: 'Resend answered a TAMPERED key with HTTP ' + bad.status + ' too, so this route is ' +
          'not checking the credential — a green here would have proved nothing',
      };
    }
  }

  return Object.assign(tried, { host: host });
}

/* ------------------------------------------------------------
   THE MONEY KEY AND THE PAGER, TRIED THE SAME WAY

   Paystack: GET /balance is the cheapest read that needs the SECRET
   key — your own balance, no customer data, no state change. A real
   key (live or test) answers 200; anything else is 401 "Invalid key",
   which is also what a pk_ public key pasted into the secret slot
   gets. 403 is not a verdict about the value, so it warns.

   Telegram: GET /bot<token>/getMe is the one call that proves a token
   without sending a message to anyone. THREE ANSWERS MATTER: 200 for a
   real token, 401 for a revoked or wrong one, and 404 for a token that
   is not even the right SHAPE (`botnotatoken/getMe`) — which must NOT
   be read as accepted, or a typo would turn the pager's check green.
   getChat then proves the chat id, because a working token pointed at
   the wrong chat delivers alerts to nobody.

   THE TOKEN IS IN THE URL, SO NOTHING HERE MAY PRINT A URL.
   
   Paths are built from a constant origin and the requests are never
   echoed; messages are built from the status alone. A Telegram error
   body is never quoted for the same reason.
   ------------------------------------------------------------ */

export const PAYSTACK_PROBE_URL = 'https://api.paystack.co/balance';
/* Overridable only so the suite can point at a stand-in. */
export const PAYSTACK_PROBE_URL_ENV = 'ARZUZ_PAYSTACK_PROBE_URL';
export const TELEGRAM_ORIGIN = 'https://api.telegram.org';
export const TELEGRAM_ORIGIN_ENV = 'ARZUZ_TELEGRAM_PROBE_ORIGIN';

export function classifyPaystackAnswer(status) {
  if (status === 401) return 'refused';
  if (status >= 200 && status < 500 && status !== 403) return 'accepted';
  return 'unknown';
}

/* Only a 2xx proves a bot token: 404 is a MALFORMED token, not a
   missing route, and 400 could be either. Both warn. */
export function classifyTelegramAnswer(status) {
  if (status === 401) return 'refused';
  if (status >= 200 && status < 300) return 'accepted';
  return 'unknown';
}

async function paystackAsk(doFetch, url, key) {
  try {
    const res = await request(doFetch, url, { method: 'GET', headers: { Authorization: 'Bearer ' + key } });
    const state = classifyPaystackAnswer(res.status);
    return {
      state: state,
      status: res.status,
      message: state === 'refused'
        ? 'Paystack refused this value (HTTP ' + res.status + ')'
        : 'Paystack answered HTTP ' + res.status,
    };
  } catch (err) {
    return { state: 'unreachable', message: 'Paystack did not answer: ' + ((err && err.message) || 'unknown') };
  }
}

async function telegramAsk(doFetch, origin, token, method, query) {
  try {
    const res = await request(doFetch, origin + '/bot' + token + '/' + method + (query || ''), { method: 'GET' });
    return { status: res.status, text: res.text };
  } catch (err) {
    return { status: 0, text: '', failed: (err && err.message) || 'Telegram did not answer' };
  }
}

/**
 * @returns {Promise<{state: string, status?: number, message: string, host?: string,
 *                    chatFound?: boolean|null}>}
 */
export async function probePaystack(opts) {
  const o = opts || {};
  const url = String(o.url || PAYSTACK_PROBE_URL);
  const key = String(o.key || '');
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const host = 'api.paystack.co';

  if (!key) return { state: 'unchecked', message: 'there is no value to try' };
  if (!doFetch) return { state: 'unchecked', host: host, message: 'this Node has no fetch, so the value cannot be tried' };

  const tried = await paystackAsk(doFetch, url, key);
  if (tried.state !== 'accepted') return Object.assign(tried, { host: host });

  if (o.sanity !== false) {
    const bad = await paystackAsk(doFetch, url, tamperKey(key));
    if (bad.state === 'accepted') {
      return {
        state: 'blind',
        status: bad.status,
        host: host,
        message: 'Paystack answered a TAMPERED key with HTTP ' + bad.status + ' too, so this route is not ' +
          'checking the credential — a green here would have proved nothing',
      };
    }
  }

  return Object.assign(tried, { host: host });
}

/**
 * @returns {Promise<{state: string, status?: number, message: string, host?: string,
 *                    chatFound?: boolean|null}>}
 */
export async function probeTelegram(opts) {
  const o = opts || {};
  const origin = String(o.origin || TELEGRAM_ORIGIN).replace(/\/+$/, '');
  const token = String(o.token || '');
  const chatId = String(o.chatId || '').trim();
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const host = 'api.telegram.org';

  if (!token) return { state: 'unchecked', message: 'there is no value to try' };
  if (!doFetch) return { state: 'unchecked', host: host, message: 'this Node has no fetch, so the value cannot be tried' };

  const me = await telegramAsk(doFetch, origin, token, 'getMe');
  if (!me.status) return { state: 'unreachable', host: host, message: 'Telegram did not answer: ' + me.failed };

  const state = classifyTelegramAnswer(me.status);
  if (state === 'refused') {
    return { state: state, status: me.status, host: host, message: 'Telegram refused this token (HTTP 401)' };
  }
  if (state !== 'accepted') {
    return {
      state: state,
      status: me.status,
      host: host,
      message: 'Telegram answered HTTP ' + me.status + ' to getMe, which is not a bot that exists — a ' +
        'token of the wrong SHAPE (no bot id, a missing colon) looks like this',
    };
  }

  if (o.sanity !== false) {
    const bad = await telegramAsk(doFetch, origin, tamperKey(token), 'getMe');
    if (bad.status >= 200 && bad.status < 300) {
      return {
        state: 'blind',
        status: bad.status,
        host: host,
        message: 'Telegram answered a TAMPERED token with HTTP ' + bad.status + ' too, so a green here ' +
          'would have proved nothing',
      };
    }
  }

  const out = { state: state, status: me.status, host: host, message: 'the bot answered getMe' };
  if (!chatId) return Object.assign(out, { chatFound: null });

  /* The destination. getChat writes nothing and sends nothing; a bot that
     has never met the chat gets 400 "chat not found", which is the warning
     this exists for. */
  const chat = await telegramAsk(doFetch, origin, token, 'getChat', '?chat_id=' + encodeURIComponent(chatId));
  if (!chat.status) return Object.assign(out, { chatFound: null, chatMessage: 'Telegram did not answer the chat lookup: ' + chat.failed });
  if (chat.status >= 200 && chat.status < 300) return Object.assign(out, { chatFound: true });
  if (chat.status === 400 || chat.status === 404) {
    return Object.assign(out, {
      chatFound: false,
      chatMessage: 'Telegram does not know that chat (HTTP ' + chat.status + ') — a bot can only see a ' +
        'chat it has been added to or that has messaged it.',
    });
  }
  return Object.assign(out, { chatFound: null, chatMessage: 'Telegram answered the chat lookup HTTP ' + chat.status });
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

  /* What the caller found when it TRIED the value. Absent in a pure
     decision run (`--report`, or the suite driving the arithmetic), and
     then this file says nothing about a value it never tried. */
  const live = (opts && opts.live) || null;
  const liveSender = (opts && opts.liveSender) || null;
  const liveEmail = (opts && opts.liveEmail) || null;
  const livePaystack = (opts && opts.livePaystack) || null;
  const liveTelegram = (opts && opts.liveTelegram) || null;

  const keyEntry = state.filter((v) => v.name === KEY_NAME)[0] || null;
  const keyExcused = !!(keyEntry && keyEntry.excused);
  const senderEntry = state.filter((v) => v.name === 'OPENWA_API_KEY')[0] || null;
  const senderExcused = !!(senderEntry && senderEntry.excused);
  const emailSet = readEnv(env, 'RESEND_API_KEY').present;
  const emailExcused = allow.all || allow.names.has('RESEND_API_KEY');
  const paystackSet = readEnv(env, 'PAYSTACK_SECRET_KEY').present;
  const paystackExcused = allow.all || allow.names.has('PAYSTACK_SECRET_KEY');
  const telegramSet = readEnv(env, 'TELEGRAM_BOT_TOKEN').present;
  const telegramExcused = allow.all || allow.names.has('TELEGRAM_BOT_TOKEN');

  const refused = !!(live && live.state === 'refused') && !keyExcused;
  const senderRefused = !!(liveSender && liveSender.state === 'refused') && !senderExcused;
  const emailRefused = !!(liveEmail && liveEmail.state === 'refused') && emailSet && !emailExcused;
  const paystackRefused = !!(livePaystack && livePaystack.state === 'refused') && paystackSet && !paystackExcused;
  const telegramRefused = !!(liveTelegram && liveTelegram.state === 'refused') && telegramSet && !telegramExcused;

  /* A refused value is present and unusable, which is the same
     consequence as absent: the door answers not-ready to every visitor.
     It joins the blocking list so the exit code cannot disagree with
     the sentence, and it is not put in `missing` — "missing" is what
     sends someone to add a variable that is already there. */
  if (refused) {
    blocking.push({
      name: KEY_NAME,
      present: true,
      refused: true,
      why: 'The value is there and the project refuses it: ' + (live.message || 'no reason given') +
        '. Every door that writes through it — the public forms, Care, payments — answers not-ready to ' +
        'a person who cannot fix it, and nothing looks broken from the outside.',
    });
  }

  if (senderRefused) {
    blocking.push({
      name: 'OPENWA_API_KEY',
      present: true,
      refused: true,
      why: 'The value is there and the WhatsApp sender refuses it: ' + (liveSender.message || 'no reason given') +
        '. Every code, confirmation and coverage notice is recorded as unsent while the student is told ' +
        'it is on its way, and nothing on the site looks broken.',
    });
  }

  if (emailRefused) {
    blocking.push({
      name: 'RESEND_API_KEY',
      present: true,
      refused: true,
      why: 'The value is there and Resend refuses it: ' + (liveEmail.message || 'no reason given') +
        '. The status page offers the email channel and the mail never leaves, and a claim decision ' +
        'is emailed to nobody — both recorded as refused where no one is reading.',
    });
  }

  if (paystackRefused) {
    blocking.push({
      name: 'PAYSTACK_SECRET_KEY',
      present: true,
      refused: true,
      why: 'The value is there and Paystack refuses it: ' + (livePaystack.message || 'no reason given') +
        '. Every checkout answers not-ready and the webhook cannot verify a signature, so a payment ' +
        'taken on the provider\'s page would never activate a pass — and nothing on the site looks broken.',
    });
  }

  if (telegramRefused) {
    blocking.push({
      name: 'TELEGRAM_BOT_TOKEN',
      present: true,
      refused: true,
      why: 'The value is there and Telegram refuses it: ' + (liveTelegram.message || 'no reason given') +
        '. Every alert this site sends — including the one about an outage — is dropped, and a silent ' +
        'pager looks exactly like a healthy site.',
    });
  }

  const lines = [];

  state.forEach((v) => {
    lines.push((v.present ? '  ok   ' : (v.excused ? '  skip ' : '  MISSING ')) + v.name +
      (v.present ? ' (set, ' + v.length + ' characters)' : v.excused ? ' (allowed to be missing here)' : ''));
  });

  if (live) {
    if (live.state === 'accepted') {
      lines.push('  ok   ' + KEY_NAME + ' is one ' + (live.host || 'the project') +
        ' accepts (HTTP ' + live.status + ', and a tampered copy was refused)');
    } else if (live.state === 'refused') {
      lines.push('  REFUSED ' + KEY_NAME + ' — ' + live.message);
    } else {
      lines.push('  ?    ' + KEY_NAME + ' was not proved: ' + live.message +
        ' (state: ' + live.state + ')');
    }
  }

  if (liveSender) {
    if (liveSender.state === 'accepted') {
      lines.push('  ok   OPENWA_API_KEY is one ' + (liveSender.host || 'the sender') +
        ' accepts (HTTP ' + liveSender.status + ', and a tampered copy was refused)');
      if (liveSender.session && liveSender.sessionFound === true) {
        lines.push('  ok   OPENWA_SESSION "' + liveSender.session + '" is a session that server lists');
      } else if (liveSender.session && liveSender.sessionFound === false) {
        lines.push('  ?    OPENWA_SESSION "' + liveSender.session + '" is NOT a session that server lists');
      }
    } else if (liveSender.state === 'refused') {
      lines.push('  REFUSED OPENWA_API_KEY — ' + liveSender.message);
    } else if (liveSender.state === 'forbidden') {
      lines.push('  ?    OPENWA_API_KEY exists — ' + liveSender.message +
        ' — so this build cannot prove the value from where it runs');
    } else {
      lines.push('  ?    OPENWA_API_KEY was not proved: ' + liveSender.message +
        ' (state: ' + liveSender.state + ')');
    }
  }

  if (liveEmail) {
    if (liveEmail.state === 'accepted') {
      lines.push('  ok   RESEND_API_KEY is one ' + (liveEmail.host || 'Resend') +
        ' accepts (HTTP ' + liveEmail.status + ', and a tampered copy was refused)');
    } else if (liveEmail.state === 'refused') {
      lines.push('  REFUSED RESEND_API_KEY — ' + liveEmail.message);
    } else {
      lines.push('  ?    RESEND_API_KEY was not proved: ' + liveEmail.message +
        ' (state: ' + liveEmail.state + ')');
    }
  }

  if (livePaystack) {
    if (livePaystack.state === 'accepted') {
      lines.push('  ok   PAYSTACK_SECRET_KEY is one ' + (livePaystack.host || 'Paystack') +
        ' accepts (HTTP ' + livePaystack.status + ', and a tampered copy was refused)');
    } else if (livePaystack.state === 'refused') {
      lines.push('  REFUSED PAYSTACK_SECRET_KEY — ' + livePaystack.message);
    } else {
      lines.push('  ?    PAYSTACK_SECRET_KEY was not proved: ' + livePaystack.message +
        ' (state: ' + livePaystack.state + ')');
    }
  }

  if (liveTelegram) {
    if (liveTelegram.state === 'accepted') {
      lines.push('  ok   TELEGRAM_BOT_TOKEN is one Telegram accepts (HTTP ' + liveTelegram.status +
        ', and a tampered copy was refused)');
      if (liveTelegram.chatFound === true) lines.push('  ok   TELEGRAM_CHAT_ID is a chat that bot can see');
      else if (liveTelegram.chatFound === false) lines.push('  ?    TELEGRAM_CHAT_ID is NOT a chat that bot can see');
    } else if (liveTelegram.state === 'refused') {
      lines.push('  REFUSED TELEGRAM_BOT_TOKEN — ' + liveTelegram.message);
    } else {
      lines.push('  ?    TELEGRAM_BOT_TOKEN was not proved: ' + liveTelegram.message +
        ' (state: ' + liveTelegram.state + ')');
    }
  }

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

  if (live && live.state === 'blind') {
    lines.push('');
    lines.push('WARNING: the live check could not tell a real key from a tampered one — ' + live.message + '.');
    lines.push('         That means the relation it reads is reachable WITHOUT a credential, which is a ' +
      'leak to fix, not a key to rotate. This check cannot report on the key until it is fixed.');
  }

  if (liveSender && (liveSender.state === 'blind' || liveSender.state === 'forbidden' ||
    liveSender.state === 'unreachable' || liveSender.state === 'unknown')) {
    lines.push('');
    lines.push('WARNING: OPENWA_API_KEY was NOT proved — ' + liveSender.message + '.');
    lines.push('         ' + (liveSender.state === 'forbidden'
      ? 'A 403 is the key being found and this ADDRESS being turned away (an IP allowlist). Netlify ' +
        'builds and its functions do not share an address, so this is reported and not blocked: a ' +
        'working deploy must not stop for where the build runs.'
      : liveSender.state === 'blind'
        ? 'The sender did not check the credential on the route the probe uses, so a green from it ' +
          'would have meant nothing. It is a leak to fix, not a key to rotate.'
        : 'The sender was unreachable or answered in a way this check does not read. A network minute ' +
          'is not a fact about the value, so this does not block a hotfix — but the next build should ' +
          'be looked at if it repeats.'));
    lines.push('         Check by hand: GET ' + (liveSender.host || 'OPENWA_URL') + OPENWA_PROBE_PATH +
      ' with the X-API-Key header.');
  }

  if (liveSender && liveSender.state === 'accepted' && liveSender.session &&
    liveSender.sessionFound === false) {
    lines.push('');
    lines.push('WARNING: OPENWA_SESSION names "' + liveSender.session + '", and that sender does not list it.');
    lines.push('         The key is good and every message will still be refused — the send route is ' +
      'per-session — so the code is issued and never delivered, exactly as if the key were missing. ' +
      'Set OPENWA_SESSION to a session the server lists (its name or its uuid).');
  }

  if (liveEmail && liveEmail.state === 'blind') {
    lines.push('');
    lines.push('WARNING: the email check could not tell a real key from a tampered one — ' + liveEmail.message + '.');
    lines.push('         Something on the way to Resend is answering without checking the credential. ' +
      'This check cannot report on the key until that is understood.');
  } else if (liveEmail && (liveEmail.state === 'unreachable' || liveEmail.state === 'unknown')) {
    lines.push('');
    lines.push('WARNING: RESEND_API_KEY was NOT proved — ' + liveEmail.message + '.');
    lines.push('         A provider outage is not a fact about the value, so this does not block. If it ' +
      'repeats, try the key by hand: POST https://api.resend.com/emails with an empty body.');
  }

  if (livePaystack && livePaystack.state !== 'accepted' && livePaystack.state !== 'refused') {
    lines.push('');
    lines.push('WARNING: PAYSTACK_SECRET_KEY was NOT proved — ' + livePaystack.message + '.');
    lines.push('         Not a verdict about the value, so it does not block: a 403 is the account, a 5xx ' +
      'is Paystack\'s minute. If it repeats, check the key by hand against GET api.paystack.co/balance.');
  }

  if (liveTelegram && (liveTelegram.state === 'unreachable' || liveTelegram.state === 'unknown')) {
    lines.push('');
    lines.push('WARNING: TELEGRAM_BOT_TOKEN was NOT proved — ' + liveTelegram.message + '.');
    lines.push('         A token of the wrong shape, or a provider minute, is not a fact about the value, so ' +
      'this does not block — but a bad shape means EVERY alert is already going nowhere.');
  }

  if (liveTelegram && liveTelegram.state === 'accepted' && liveTelegram.chatFound === false) {
    lines.push('');
    lines.push('WARNING: TELEGRAM_CHAT_ID is not a chat that bot can see — ' + (liveTelegram.chatMessage || 'Telegram said no') + '.');
    lines.push('         The token is good, so this looks configured, and every alert is still dropped. Add ' +
      'the bot to that chat (or message it once), or correct the id.');
  }

  if (advised.length) {
    lines.push('');
    advised.forEach((v) => {
      lines.push('WARNING: ' + v.name + ' is not set.');
      lines.push('         ' + v.why);
    });
  }

  if (blocking.length) {
    const absent = blocking.filter((v) => !v.refused);
    lines.push('');
    if (absent.length) {
      lines.push('This deploy cannot do what the site promises: ' + absent.length + ' required environment ' +
        'variable' + (absent.length === 1 ? ' is' : 's are') + ' missing. Every one of them fails ' +
        'SILENTLY — nothing looks broken, and the only symptom is a person who was never told anything.');
    }
    if (refused) {
      lines.push('THE SERVICE KEY THIS BUILD WAS HANDED DOES NOT WORK.');
      lines.push('');
      lines.push('It is SET — this is not a missing variable — and the project refused it: ' +
        (live.message || 'no reason given') + '.');
      lines.push('A deploy built on it publishes a site whose forms, Care panel and checkout all answer ' +
        '"we are not switched on yet" to people who cannot fix it, while every page renders and every ' +
        'button works.');
      lines.push('');
      lines.push('  Three causes, in the order they happen:');
      lines.push('    1. The key was ROTATED in Supabase after it was copied in here. Copy the current ' +
        'service_role key from Supabase → Project Settings → API.');
      lines.push('    2. An anon/publishable key was pasted into the service slot. The anon key is refused ' +
        'by the private tables this site reads.');
      lines.push('    3. SUPABASE_URL points at another project, so a good key is being offered to a project ' +
        'that never issued it. This build tried ' + (live.host || 'the configured project') + '.');
      lines.push('  Change the value, then redeploy — a variable edited after a build is only in the ' +
        'functions of the NEXT deploy.');
    }
    if (senderRefused) {
      lines.push('THE WHATSAPP SENDER THIS BUILD WAS HANDED DOES NOT KNOW THE KEY.');
      lines.push('');
      lines.push('It is SET — this is not a missing variable — and the sender refused it: ' +
        (liveSender.message || 'no reason given') + '.');
      lines.push('Nothing on the site will look broken. The status page tells a student their code is on its ' +
        'way, the send route records it as unsent, and it never leaves. Coverage and dispute notices ' +
        'go the same route.');
      lines.push('');
      lines.push('  Three causes, in the order they happen:');
      lines.push('    1. The key was ROTATED or revoked on the OpenWA server after it was copied in here. Copy ' +
        'the current key from that server\'s dashboard.');
      lines.push('    2. OPENWA_URL points at a different OpenWA instance than the one that issued this key, ' +
        'so a good key is being offered to a server that never had it.');
      lines.push('    3. The key was restricted to roles or sessions that do not include the one this site ' +
        'sends from.');
      lines.push('  This build tried ' + (liveSender.host || 'the configured sender') + '. Change the value, ' +
        'then redeploy.');
      lines.push('');
    }
    if (emailRefused) {
      lines.push('THE EMAIL KEY THIS BUILD WAS HANDED DOES NOT WORK.');
      lines.push('');
      lines.push('It is SET — and Resend refused it: ' + (liveEmail.message || 'no reason given') + '.');
      lines.push('The status page offers a student the email channel and the mail never leaves, and a claim ' +
        'decision is emailed to nobody. Both are recorded as refused where nobody is reading, which is ' +
        'the same silence as a key that was never set — one step later.');
      lines.push('');
      lines.push('  Two causes, in the order they happen:');
      lines.push('    1. The key was ROTATED or revoked in Resend after it was copied in here. Resend shows ' +
        'each key\'s created date next to its last use.');
      lines.push('    2. The key belongs to a different Resend team or account than the one this site sends ' +
        'from — a good key offered to the wrong account.');
      lines.push('  This build tried ' + (liveEmail.host || 'Resend') + '. Change the value, then redeploy.');
      lines.push('');
    }
    if (paystackRefused) {
      lines.push('THE PAYSTACK KEY THIS BUILD WAS HANDED DOES NOT WORK.');
      lines.push('');
      lines.push('It is SET — and Paystack refused it: ' + (livePaystack.message || 'no reason given') + '.');
      lines.push('The checkout answers not-ready to a student who has decided to buy, and the webhook cannot ' +
        'verify a signature — so a payment taken on the provider\'s own page would never activate a pass. ' +
        'Nothing on the site looks broken.');
      lines.push('');
      lines.push('  Three causes, in the order they happen:');
      lines.push('    1. The key was ROTATED in the Paystack dashboard after it was copied in here. Copy the ' +
        'current secret key from Paystack → Settings → API Keys & Webhooks.');
      lines.push('    2. A PUBLIC key (pk_…) was pasted into the secret slot. The public key is not refused ' +
        'by a browser, so nothing else on the site would complain.');
      lines.push('    3. The key belongs to another Paystack account or business than the one this site ' +
        'charges on.');
      lines.push('  This build tried ' + (livePaystack.host || 'Paystack') + '. Change the value, then redeploy.');
      lines.push('');
    }
    if (telegramRefused) {
      lines.push('THE TELEGRAM TOKEN THIS BUILD WAS HANDED DOES NOT WORK.');
      lines.push('');
      lines.push('It is SET — and Telegram refused it: ' + (liveTelegram.message || 'no reason given') + '.');
      lines.push('Every alert this site sends is dropped, including the ones about an outage. A silent pager ' +
        'is indistinguishable from a healthy site, which is why this is a failed build rather than a ' +
        'warning in a log.');
      lines.push('');
      lines.push('  Three causes, in the order they happen:');
      lines.push('    1. The token was REVOKED in BotFather (/revoke) after it was copied in here.');
      lines.push('    2. The token belongs to a different bot than the one the chat id points at.');
      lines.push('    3. The value is truncated or has a stray fragment — a token is `<bot id>:<35 characters>`, ' +
        'and Telegram answers 404, not 401, to one that is not even that shape.');
      lines.push('  Change the value, then redeploy.');
      lines.push('');
    }
    lines.push('');
    blocking.forEach((v) => {
      lines.push('  ' + v.name);
      lines.push('    ' + v.why);
    });
    if (absent.length) {
      lines.push('');
      lines.push('  Two possible causes, and only you can tell them apart:');
      lines.push('    1. The variable has not been set. Netlify → Site configuration → Environment ' +
        'variables → Add a variable. It must exist for BOTH the build and the functions, because this ' +
        'build reads it and the functions read it at runtime.');
      lines.push('    2. The variable is set but scoped to "Functions" only. That is a correct configuration ' +
        'for the runtime, and it is what this build cannot see. Give it the site-wide scope as well, or ' +
        'set both.');
    }
    lines.push('');
    lines.push('  If this deploy is meant to go out anyway — a copy change, a page nobody submits from — ' +
      'say so on purpose with a value, not by deleting the check:');
    lines.push('    ' + OVERRIDE_NAME + '=1                       (allow all of them, loudly)');
    lines.push('    ' + OVERRIDE_NAME + '=' + blocking.map((v) => v.name).join(',') +
      '   (allow exactly these)');
  }

  return {
    ok: blocking.length === 0,
    exit: (require_ && blocking.length) ? 1 : 0,
    live: live ? live.state : null,
    liveSender: liveSender ? liveSender.state : null,
    liveEmail: liveEmail ? liveEmail.state : null,
    livePaystack: livePaystack ? livePaystack.state : null,
    liveTelegram: liveTelegram ? liveTelegram.state : null,
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

  /* THREE probes — the database, the sender and the mail provider — each
     two requests when the value is accepted and one when it is not.
     They run together: three sequential 8-second timeouts would turn a
     provider outage into a build that looks hung.

     Only when there is a value to try — a variable that is simply
     absent is already the MISSING case, and asking the network about a
     variable nobody set would only add a line to the report. */
  const key = readEnv(process.env, KEY_NAME).present
    ? String(process.env[KEY_NAME]).trim()
    : '';
  const waKey = readEnv(process.env, 'OPENWA_API_KEY').present
    ? String(process.env.OPENWA_API_KEY).trim()
    : '';
  const waUrl = senderUrl(process.env);
  const mailKey = readEnv(process.env, 'RESEND_API_KEY').present
    ? String(process.env.RESEND_API_KEY).trim()
    : '';
  const mailUrl = String(process.env[RESEND_PROBE_URL_ENV] || '').trim() || RESEND_PROBE_URL;
  const paystackKey = readEnv(process.env, 'PAYSTACK_SECRET_KEY').present
    ? String(process.env.PAYSTACK_SECRET_KEY).trim()
    : '';
  const paystackUrl = String(process.env[PAYSTACK_PROBE_URL_ENV] || '').trim() || PAYSTACK_PROBE_URL;
  const tgToken = readEnv(process.env, 'TELEGRAM_BOT_TOKEN').present
    ? String(process.env.TELEGRAM_BOT_TOKEN).trim()
    : '';
  const tgOrigin = String(process.env[TELEGRAM_ORIGIN_ENV] || '').trim() || TELEGRAM_ORIGIN;
  const tgChat = String(process.env.TELEGRAM_CHAT_ID || '').trim();

  const [live, liveSender, liveEmail, livePaystack, liveTelegram] = await Promise.all([
    key ? probeServiceKey({ url: projectUrl(process.env), key: key }) : null,
    (waKey && waUrl)
      ? probeSender({ url: waUrl, key: waKey, session: process.env.OPENWA_SESSION || '' })
      : null,
    mailKey ? probeEmail({ key: mailKey, url: mailUrl }) : null,
    paystackKey ? probePaystack({ key: paystackKey, url: paystackUrl }) : null,
    tgToken ? probeTelegram({ token: tgToken, origin: tgOrigin, chatId: tgChat }) : null,
  ]);
  const out = checkEnv(process.env, {
    require: require_, live: live, liveSender: liveSender, liveEmail: liveEmail,
    livePaystack: livePaystack, liveTelegram: liveTelegram,
  });

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

  /* the CODE, not process.exit(). Now that the gate makes a request, an
     exit taken while undici still holds its connection pool aborts the
     process on some platforms instead of returning a status (observed
     as a libuv assertion and exit 127) — and a build that fails for the
     wrong reason is the one thing this file must not do. Setting
     exitCode lets the loop drain and the code still reaches Netlify. */
  process.exitCode = out.exit;
}

/* For scripts/test-deploy-key.mjs, which drives the decision and then
   the CLI with a controlled environment. */
export default {
  checkEnv, readEnv, allowedMissing, overrideSet,
  REQUIRED, ADVISED, KEY_NAME, OVERRIDE_NAME, LEGACY_OVERRIDE_NAME,
  probeServiceKey, probeSender, probeEmail, probePaystack, probeTelegram,
  classifyAnswer, classifySenderAnswer, classifyEmailAnswer, classifyPaystackAnswer,
  classifyTelegramAnswer, senderUrl, sessionFound,
};
