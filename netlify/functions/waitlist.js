/* ============================================================
   Arzuz — Netlify Function: the public submission door
   POST /api/waitlist

   WHY THIS EXISTS
   Until now every public form posted straight to PostgREST with the
   anon key that ships in assets/config.js. Row level security made
   that safe to a point — it forced status and tier, and it refused
   reads — but it could not do the three things spec §2 asks for:

     · validate the input on the SERVER (a page that validates is a
       page that can be skipped)
     · rate limit (a policy cannot count; it only decides per row)
     · hand back a reference the person can actually read

   So the forms now post here, this function validates and throttles
   and inserts with the service role, and answers with the reference
   the database minted.

   IT IS THE ONLY WAY IN, AND THAT IS NEW

   It began life as the PREFERRED door with the direct path kept as a
   fallback, so that a deploy without a service key could not lose a
   submission. supabase-close-public-inserts.sql revoked anon's INSERT
   on all five public tables and assets/submit.js deleted the fallback,
   together: there is now one shape of public submission, and it cannot
   be forged by anything holding a key the site ships.

   So if this deploy has no service key, it answers 503 'not-ready' —
   and the page HOLDS the submission rather than writing it somewhere
   else. `not-ready` is a class assets/submit.js queues, so the row is
   re-sent through this same door once the key is set; the student is
   told plainly that nothing was sent and to message WhatsApp. Nothing
   is lost, and nothing is written unvalidated.

   THE OPTIONAL EMAIL, AND WHY THE DOOR CARES
   The forms now ask for an email address, and it is optional on every
   one of them: a student without one is not a student we turn away.
   It exists because the phone number is the contact a student is most
   likely to have changed, and the status page's code can go to an
   inbox as well as to a phone (netlify/functions/status.js). The door
   validates the shape — using notify.js's own rule, not a second regex
   — and stores what was typed, so the second channel cannot be opened
   to an address no sender would accept.

   WHAT IT NEVER DOES
   · It never stores a password, and it never accepts one. There is no
     account here and no field for one (spec §2, §5).
   · It never echoes PII back. The response is the reference, the
     pipeline stage and a sentence. Not the phone number, not the
     answers, not the row.
   · It never logs PII. The log line is the form, the outcome and the
     reference; an IP is only ever a salted hash, and the salt is the
     service key, so the hash is not reversible from the log.
   · It never trusts the row. status, tier, env and the reference are
     decided here or by the database, never taken from the client.
   ============================================================ */

const crypto = require('node:crypto');

/* The shared failure vocabulary — the SAME file the page loads. The
   class this function names is the class assets/submit.js reads, so a
   429 here is the page's 'busy' (wait a moment) rather than a second
   guess at the same number. */
const ApiErrors = require('../../assets/api-errors.js');

/* The one rule on this site for "is this an address we could send to",
   borrowed rather than written again. notify.js already owns sendEmail
   and the shape it will accept — including the addresses this site
   INVENTS (`<phone>@receipts.arzuz.com`, a billing identifier rather
   than a mailbox) — and the status page's second channel reads the
   same function. A second regex here is how a form starts accepting an
   address the sender then refuses. */
const { mailDeliverable } = require('./notify.js');

const SUPABASE_URL_FALLBACK = 'https://nihdbhjecdkpvzvjifrm.supabase.co';

function cfg() {
  const url = (process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || SUPABASE_URL_FALLBACK)
    .replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return {
    url,
    serviceKey,
    ready: !!serviceKey,
    session: (process.env.ARZUZ_SESSION || '2026/2027').slice(0, 20),
    maxPerHour: clampInt(process.env.WAITLIST_MAX_PER_HOUR, 60, 1, 5000),
    minGapSeconds: clampInt(process.env.WAITLIST_MIN_GAP_SECONDS, 4, 0, 600),
    globalPerHour: clampInt(process.env.WAITLIST_GLOBAL_PER_HOUR, 4000, 1, 200000),
  };
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(status, body, kind) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(ApiErrors.wireBody(status, body, kind)),
  };
}

/* ------------------------------------------------------------
   The forms this door serves, and what each one owes us.

   `table` is a CLOSED allowlist: a form name that is not here is not
   a form, and a request cannot name a table this function will write
   to. `status`/`tier` are the state the row is born in and are set
   HERE — the same state the anon insert policies in
   supabase-team-roles.sql force, asserted by scripts/test-waitlist.mjs,
   so that the one door and the (now revoked) direct path could never
   produce different rows.

   A form's NAME is the page's own name for what was submitted and its
   `table` is where it lands; for five of the six they are the same
   string. The sixth is the roommate questionnaire — see its entry below
   for why it is a form of its own rather than the student form.

   `need` is deliberately short and about one question only: can the
   team act on this row? For a student waitlist that is a name, a way
   to reach them, and their age band — the age band is not decoration,
   it is what sets demand_records.is_minor, and a row that arrives
   without one silently falls out of minors_needing_guardian. The rest
   of the form (budget, distance, timing) is the applicant's own
   preference and the client already requires it; refusing a whole
   submission because a preference did not arrive would lose a real
   person's place in the queue to save a null in a reporting view.
   ------------------------------------------------------------ */

const FORMS = {
  demand_records: {
    label: 'student registration',
    table: 'demand_records',
    state: { status: 'open' },
    phoneKeys: ['phone'],
    need: ['first', 'phone', 'age'],
  },
  listings: {
    label: 'landlord listing',
    table: 'listings',
    state: { status: 'pending', tier: 0 },
    phoneKeys: ['ph', 'owner_phone', 'phone'],
    need: ['nm', 'ph'],
  },
  scout_submissions: {
    label: 'building scout report',
    table: 'scout_submissions',
    state: { status: 'pending' },
    phoneKeys: ['phone'],
    need: ['area', 'phone'],
  },
  booking_requests: {
    label: 'booking request',
    table: 'booking_requests',
    state: { status: 'pending' },
    phoneKeys: ['phone'],
    need: ['name', 'phone'],
  },
  support_tickets: {
    label: 'support ticket',
    table: 'support_tickets',
    state: { status: 'open' },
    phoneKeys: ['phone'],
    need: ['phone'],
  },

  /* THE ROOMMATE QUESTIONNAIRE — and the one form whose NAME and TABLE
     are not the same string.

     It is not the student form with a different name. It collects a name
     and a phone and NO age band, and the student form above is not
     allowed to give the age band up: `is_minor` is generated from it, so
     a row without one silently falls out of minors_needing_guardian. That
     is exactly why the page's old side door wrote nothing usable — it
     posted this questionnaire as a student registration and the age band
     it never asked for made the row a lie.

     So it is its own form with its own question list, landing in the same
     table with `roommate: 'yes'` stamped on it — the flag demand_summary
     reads to tell a student looking for a roommate from one looking for a
     room. `map` renames the answers to the vocabulary the table and the
     dashboard use: payload->>'first' is the generated `first_name` column,
     so a row that kept the questionnaire's own key would arrive with a
     name nobody can read in the demands table. */
  roommate_profiles: {
    label: 'roommate questionnaire',
    table: 'demand_records',
    state: { status: 'open' },
    phoneKeys: ['phone'],
    need: ['first', 'phone'],
    map: { name: 'first' },
    extra: { roommate: 'yes' },
  },
};

/* ------------------------------------------------------------
   Cleaning

   Every value the client sends is a string that ends up in a jsonb
   column, in a view, and on a screen. `clean` is the one place that
   decides what a value may look like: text, trimmed, one line, no
   control characters, capped. A field that arrives as an object, an
   array or a number is not a value this site produces, so it becomes
   an empty string rather than JSON.stringify'd garbage that a later
   page would print.
   ------------------------------------------------------------ */

const CAP = 300;

function clean(v, cap) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
  return String(v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')   // no control characters, no newlines smuggled in
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap || CAP);
}

/* The digits of a phone number, and whether that could be a phone
   number at all. Deliberately generous: Nigerian mobiles are 11 digits
   with a leading zero, an international entry is 13 or 14, and a
   landline is shorter. This is a sanity check that a contact path
   EXISTS — it is not a validation of a subscriber, which only a call
   can be. What it does refuse is a field of prose, or a stray "+".
   The value stored is what the person typed, because Amaka's number
   is what her WhatsApp is registered to and reformatting it is how a
   confirmation stops arriving. */
function phoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function looksLikePhone(v) {
  const d = phoneDigits(v);
  return d.length >= 10 && d.length <= 15;
}

/* Consent is required for every public form and is recorded with the
   sentence that was agreed to. The sentence is THIS function's, not
   the client's: a page that sends its own consent text is a page that
   can send a different one, and the whole point of storing it is that
   "what did they agree to" has an answer we chose. */
const CONSENT_TEXT =
  'By submitting this form I agree that Arzuz may contact me on the phone number ' +
  'or email I have given, about my housing request and about rooms Arzuz matches ' +
  'to it. I can ask Arzuz to stop contacting me at any time.';

function consented(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === 'on' || s === '1' || s === 'agree';
}

/* ------------------------------------------------------------
   The caller's address, as a hash

   Netlify puts the real client address in its own header; the first
   hop of x-forwarded-for is the fallback. It is hashed with the service
   key as the salt — no new secret to configure, and the digest cannot
   be walked back to an address by anyone holding only the log. This is
   an anti-abuse identifier, not an identity: nothing in the waitlist
   is keyed on a person's IP.
   ------------------------------------------------------------ */
function hashIp(event, salt) {
  const h = event.headers || {};
  const raw = String(
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0] ||
    h['client-ip'] ||
    ''
  ).trim();
  if (!raw) return 'unknown';
  return crypto.createHash('sha256').update(salt + '|' + raw).digest('hex').slice(0, 40);
}

/* ------------------------------------------------------------
   Supabase, with the service role
   ------------------------------------------------------------ */

async function sb(cfgv, path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({
    apikey: cfgv.serviceKey,
    Authorization: 'Bearer ' + cfgv.serviceKey,
    'Content-Type': 'application/json',
  }, opts.headers || {});
  opts.signal = AbortSignal.timeout(9000);
  const res = await fetch(cfgv.url + '/rest/v1/' + path, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  if (!res.ok) {
    const err = new Error((body && (body.message || body.hint)) || ('Supabase answered ' + res.status));
    err.status = res.status;
    if (body && body.code) err.code = body.code;
    throw err;
  }
  return body;
}

async function rpc(cfgv, name, args) {
  return sb(cfgv, 'rpc/' + name, { method: 'POST', body: JSON.stringify(args || {}) });
}

/* ------------------------------------------------------------
   THE DUPLICATE, WHICH IS THE ONE THAT ACTUALLY HAPPENS

   A student on a slow connection taps submit twice, walks away, comes
   back and fills it in again, or asks a friend to do it for them. The
   right answer is not "you have already applied" — it is the row they
   already have, reported back with its own reference, so the second
   attempt costs nothing and loses nothing.

   Two keys, in order:

     client_ref   a UUID the browser minted for the FIRST attempt and
                  kept (assets/submit.js). A retry of the same attempt
                  is the same submission, and this is what makes the
                  offline queue safe.
     phone        the same person on a new attempt, within a day.

   Both are a lookup with the service role, so neither depends on
   anything the client could lie about beyond the value it sent for
   itself — and the phone number IS the claim being deduplicated.
   ------------------------------------------------------------ */
async function findExisting(cfgv, table, clientRef, phone) {
  if (clientRef && /^[0-9a-f-]{36}$/i.test(clientRef)) {
    const hit = await sb(cfgv,
      table + '?select=ref,follow_up_status&client_ref=eq.' + encodeURIComponent(clientRef) + '&limit=1');
    if (hit && hit.length) return { row: hit[0], how: 'retry' };
  }

  const digits = phoneDigits(phone);
  if (digits.length >= 10) {
    /* The stored phone is the typed value, so the comparison is made on
       the digits of the last ten — "0803 123 4567" and "2348031234567"
       are the same person, and a dedupe that misses that is a dedupe
       that mails a student twice. PostgREST cannot express a
       digits-only comparison, so the match is on the last ten digits
       with a LIKE on the tail, which is index-assisted enough for a
       table this size and exact for the normalisation this site uses. */
    const tail = digits.slice(-10);
    const check = await sb(cfgv,
      table + '?select=ref,follow_up_status,payload' +
      '&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 86400000).toISOString()) +
      '&order=created_at.desc&limit=50');
    const found = (check || []).find((r) => r && r.ref &&
      phoneDigits((r.payload && (r.payload.phone || r.payload.ph)) || '').slice(-10) === tail);
    if (found) return { row: found, how: 'phone' };
  }

  return null;
}

/* ------------------------------------------------------------
   Validation
   ------------------------------------------------------------ */

function validate(form, answers) {
  const problems = [];

  const missing = form.need.filter((k) => !clean(answers[k], 200));
  if (missing.length) {
    problems.push('Please fill in: ' + missing.join(', ') + '.');
  }

  /* An email address is OPTIONAL on every public form, and it is never
     required — a student without one is not a student we turn away.
     But a malformed one is refused rather than quietly dropped: it is
     the second channel the status page can open a record with (see
     netlify/functions/status.js), and an address we stored anyway is a
     student later told "the code is on its way" to a mailbox that does
     not exist. The value STORED is what they typed, as with the phone
     number — reformatting a contact is how a message stops arriving. */
  const mail = clean(answers.email, 200);
  if (mail && !mailDeliverable(mail).ok) {
    problems.push('That email address does not look complete \u2014 check it, or leave it blank.');
  }

  const phoneKey = form.phoneKeys.find((k) => clean(answers[k], 60));
  const phone = phoneKey ? clean(answers[phoneKey], 60) : '';
  if (phone && !looksLikePhone(phone)) {
    problems.push('That phone number does not look complete — we need at least ten digits to reach you.');
  }
  if (!phone) {
    problems.push('We need a phone number, or we cannot send you a match.');
  }

  if (!consented(answers.consent)) {
    problems.push('We cannot take this without your agreement to be contacted.');
  }

  return { problems, phone, phoneKey };
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'This endpoint only accepts a form submission.' });
  }

  const cfgv = cfg();

  /* Not configured yet is a DEPLOYMENT fact, and the page is told so:
     503 + 'not-ready' is the class that makes assets/submit.js
     HOLD the submission and retry it through this door, instead of
     telling a student their form is broken — and instead of what it
     used to do, which was write the row through a second path this
     function cannot validate. The class is the whole contract with the
     page; a bare 503 would read as "we are briefly unwell" and be
     retried as if the request were the problem. */
  if (!cfgv.ready) {
    return json(503, {
      error: 'The waitlist door is not switched on in this deploy: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify (Site settings → Environment variables).',
    }, 'not-ready');
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'That submission arrived in a shape we could not read.' }, 'rejected');
  }

  const form = FORMS[String(body.form || '').trim()];
  if (!form) {
    return json(400, { error: 'Unknown form.' }, 'rejected');
  }

  const raw = (body.answers && typeof body.answers === 'object') ? body.answers : {};

  /* ---- the honeypot, first, because it is the cheapest thing here ----
     A field no person can see and no person fills in. A bot that fills
     every input it finds fills this one. The answer is deliberately
     the same 400 an invalid form gets: a bot told "you tripped the
     trap" is a bot that skips the trap next time.

     This is ALSO enforced at the database, in the anon insert policies
     (supabase-team-roles.sql section 2a) — on both doors, so a
     submission that skips this function still meets it. */
  const hp = clean(raw.hp, 80);
  if (hp !== '') {
    console.warn('[waitlist] honeypot tripped on', form.table, '— refusing');
    return json(400, { error: 'That submission could not be accepted.' }, 'rejected');
  }

  /* ---- clean every answer, then validate ----
     Cleaning happens before validation because validation has to judge
     the value that will actually be stored: a name of two hundred
     spaces is not a name, and checking the raw string would pass it. */
  const answers = {};
  Object.keys(raw).forEach((k) => {
    if (!/^[a-z0-9_]{1,32}$/i.test(k)) return;    // no shape-changing keys
    answers[k] = clean(raw[k], CAP);
  });

  /* ---- map, then stamp, then validate ----
     `map` renames the page's own field names onto the ones the table and
     the dashboard actually read (name→first), and `extra` writes the
     facts only the SERVER may decide about what this row is. Both happen
     before validate() so the question list, the error text and the stored
     row all speak one vocabulary — a form whose `need` named a key that
     `map` had already renamed would refuse a submission the person had
     filled in perfectly. */
  if (form.map) {
    Object.keys(form.map).forEach((from) => {
      const to = form.map[from];
      if (answers[from] === undefined) return;
      if (answers[to] === undefined) answers[to] = answers[from];
      delete answers[from];
    });
  }
  if (form.extra) {
    Object.keys(form.extra).forEach((k) => { answers[k] = form.extra[k]; });
  }

  const v = validate(form, answers);
  if (v.problems.length) {
    return json(400, { error: v.problems.join(' ') }, 'rejected');
  }

  /* ---- the throttle, in the database, in one round trip ----
     See supabase-waitlist-launch.sql §3 for why the counter is not in
     this process's memory: Netlify runs as many instances as it likes,
     so a per-instance limit is a limit per instance. */
  const ipHash = hashIp(event, cfgv.serviceKey);
  let verdict;
  try {
    verdict = await rpc(cfgv, 'waitlist_throttle', {
      p_ip_hash: ipHash,
      p_form: form.table,
      p_max_per_hour: cfgv.maxPerHour,
      p_min_gap_seconds: cfgv.minGapSeconds,
      p_global_per_hour: cfgv.globalPerHour,
    });
  } catch (err) {
    /* The throttle is a guard, not the work. If it cannot answer — a
       deploy that predates the migration, a database hiccup — the
       submission is NOT refused on suspicion: it is let through and
       the failure is logged. Refusing a real student because our own
       counter broke is the worse of the two mistakes. */
    console.error('[waitlist] throttle unavailable:', err && err.message);
    verdict = { allow: true, degraded: true };
  }

  if (verdict && verdict.allow === false) {
    console.warn('[waitlist] throttled on', form.table, 'reason', verdict.reason);
    return json(429, {
      error: 'That is a lot of submissions in a short time. Wait a moment and try again — nothing you have typed has been lost.',
    }, 'busy');
  }

  const clientRef = clean(body.client_ref, 64);

  /* ---- the duplicate, before the insert ---- */
  try {
    const existing = await findExisting(cfgv, form.table, clientRef, v.phone);
    if (existing && existing.row && existing.row.ref) {
      console.log('[waitlist] duplicate', existing.how, 'on', form.table, '→', existing.row.ref);
      return json(200, {
        ok: true,
        duplicate: true,
        ref: existing.row.ref,
        follow_up_status: existing.row.follow_up_status || 'new',
        note: existing.how === 'retry'
          ? 'We already have this one — that is your reference below.'
          : 'You are already on the list with this number. Nothing was submitted twice; this is the reference you already have.',
      });
    }
  } catch (err) {
    /* A failed lookup must not become a failed submission: the worst
       case is a duplicate row, which the team can merge and which is
       far better than a person told "no" for no reason. */
    console.error('[waitlist] duplicate check failed:', err && err.message);
  }

  /* ---- the row ----
     payload holds the cleaned answers, plus the consent evidence. The
     state columns are the form's, never the client's: a caller cannot
     post itself an 'active' listing or a 'matched' demand, exactly as
     the anon insert policies refuse it. */
  const consolidated = Object.assign({}, answers, {
    consent: 'yes',
    consent_at: new Date().toISOString(),
  });

  const row = {
    payload: consolidated,
    session: cfgv.session,
    env: (clean(body.env, 20) === 'test' ? 'test' : 'production'),
    source: clean(body.source, 120) || 'api',
    referrer: clean(body.referrer, 300) || null,
    user_agent: clean(body.user_agent, 300) || null,
    consent_at: consolidated.consent_at,
    consent_text: CONSENT_TEXT,
  };
  if (clientRef && /^[0-9a-f-]{36}$/i.test(clientRef)) row.client_ref = clientRef;
  Object.keys(form.state).forEach((k) => { row[k] = form.state[k]; });

  let inserted;
  try {
    inserted = await sb(cfgv, form.table, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
  } catch (err) {
    /* The client_ref unique index is the retry safety net and it fires
       here as 409 when two attempts raced: the winner's row is the
       answer, so read it back rather than reporting a failure. */
    if (err && err.status === 409 && row.client_ref) {
      try {
        const again = await sb(cfgv,
          form.table + '?select=ref,follow_up_status&client_ref=eq.' +
          encodeURIComponent(row.client_ref) + '&limit=1');
        if (again && again.length && again[0].ref) {
          return json(200, { ok: true, duplicate: true, ref: again[0].ref,
            follow_up_status: again[0].follow_up_status || 'new' });
        }
      } catch (e) { /* fall through to the honest failure */ }
    }
    console.error('[waitlist] insert failed on', form.table, 'HTTP', err && err.status, err && err.code, err && err.message);
    return json(502, {
      error: 'Arzuz could not save that just now — that is our side, not yours. Try again in a minute, or message us on WhatsApp.',
    });
  }

  const saved = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!saved || !saved.ref) {
    /* The row went in but the reference did not come back, which means
       this deploy is running against a database that has not had
       supabase-waitlist-launch.sql applied. The submission is safe —
       say so, and say what to do about it. */
    console.error('[waitlist] row saved with no ref — run supabase-waitlist-launch.sql');
    return json(200, {
      ok: true,
      ref: '',
      follow_up_status: 'new',
      note: 'Your submission is saved. The reference has not been generated yet because the launch migration has not been run on this database.',
    });
  }

  /* The log line is the outcome, never the person: the form, the
     reference, and where it came from. No number, no name, no answers. */
  console.log('[waitlist] accepted', form.label, '→', saved.ref,
    'via', row.source, verdict.degraded ? '(throttle degraded)' : '');

  return json(200, {
    ok: true,
    duplicate: false,
    ref: saved.ref,
    follow_up_status: saved.follow_up_status || 'new',
  });
};

/* Exported for scripts/test-waitlist.mjs, which drives the handler with
   synthetic events and asserts the refusals above — because a validator
   nobody has ever seen refuse anything is a validator that does not
   work. */
exports.FORMS = FORMS;
exports.CONSENT_TEXT = CONSENT_TEXT;
exports.looksLikePhone = looksLikePhone;
exports.consented = consented;
exports.clean = clean;
