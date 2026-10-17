/* ============================================================
   Arzuz — Netlify Function: "check my waitlist status"
   POST /api/status

   The question a student actually asks is "did you get it, and has
   anything happened since" — and until now the only way to answer it
   was to ring the office, because the reference they were given was
   only useful to the dashboard. This is the page's door.

   TWO STEPS, AND THE SECOND ONE IS THE POINT

     step 'send'    { ref, channel, phone | email }
       The reference AND the contact on the file for the channel asked
       for. If both are right, a six-digit code goes out over that
       channel. Nothing is revealed yet, and nothing is revealed even
       now: see THE ONE ANSWER below.

     step 'verify'  { ref, code }
       The code comes back. Only then does supabase-status-codes.sql
       hand over the stage, and only the stage.

   TWO CHANNELS, AND WHY THERE HAD TO BE A SECOND ONE

     channel 'whatsapp' (the default) — the phone number on the file,
       over the OpenWA sender the rest of the site already uses
       (netlify/functions/whatsapp-send.js — the same `sendText` the
       claims notices use, because a credential should have one owner).

     channel 'email' — the email address on the file, over the same
       Resend sender the coverage decisions use (notify.js owns
       sendEmail, and this file is the second caller rather than a
       second implementation of "send mail").

     The phone was the only channel this page had, and it is the one
     contact a Nigerian student is most likely to have CHANGED: a new
     SIM, a new number after a lost phone, a line that stops working
     while they are away from home. Add WhatsApp itself being down and
     the code has no way to arrive at all, which makes the page answer
     "nothing to see" to the one person it was built for. So the code
     can go to the email they gave us instead — same proof, different
     mailbox, and a mailbox is something they keep.

     AND THE WHATSAPP PATH FALLS BACK BY ITSELF. When the number on the
     file cannot be messaged or OpenWA refuses the message, the SAME
     code goes to the email on the file if there is one, and the answer
     does not change: see THE ONE ANSWER. That is the "WhatsApp is
     down" half of the problem, and it needs no new question for the
     student to answer.

   THE ONE ANSWER STILL HOLDS, CHANNEL BY CHANNEL

     The generic sentence is channel-neutral on purpose ("the contact
     details we hold for it"), because a sentence that named the phone
     would be a sentence the email channel has to vary — and a varying
     answer is what this endpoint exists without. So the body a caller
     gets is byte-for-byte the same whether they asked by phone or by
     email, whether the reference exists or not, and (on the WhatsApp
     path) whether the code went out on WhatsApp or quietly went out by
     email instead. Nothing about which channels a record has is
     readable from outside.

   WHY A CODE AT ALL

     The reference is a handle, and handles leak: read out loud on a
     call, screenshotted, typed into a group chat. Knowing one must
     not be the same as being able to read someone's file. The code
     turns "I have the reference" into "I have the reference AND I hold
     the phone — or the mailbox — this submission came from", which is
     the real claim. There is no session and no token: the code IS the
     proof, for one answer, and then it is spent.

   THE ONE ANSWER  — this is the part not to "improve" later

     Every outcome that is not the caller's own rate limit gets the
     SAME 200 and the SAME sentence:

         "If that reference and number match a record of ours, a code
          is on its way to that number."

     That covers: a malformed reference, a reference nobody ever
     minted, a reference whose row was deleted, a phone number that
     is not the one on the file, a code that was issued and sent, and
     a code that was issued and NOT sent because OpenWA was down.

     It has to be one answer because the alternative is an oracle: an
     attacker with a leaked reference could walk phone numbers and
     learn, from a difference in our reply, which one is on the file.
     When the sender is down the naive design leaks exactly that, so
     the failure is logged loudly and the student is told what the
     page always tells them — if nothing arrives in a minute, message
     us on WhatsApp. The cost is one sentence in a rare case; the
     thing bought is that this endpoint cannot be asked questions
     about whether a reference is real.

     The rate limit is NOT part of that. A 429 depends only on the
     caller's own behaviour, says nothing about the reference, and
     keeping it distinct is what lets a real student be told to wait
     rather than being told nothing is happening.

   AND THE RATE LIMIT IS NOT IN THIS PROCESS

     Netlify runs as many instances as it likes, so a counter in
     memory is a counter per instance. The count lives in
     public.status_guard, in its own table next to the waitlist's —
     supabase-status-codes.sql §2 explains why it is not the SAME
     table, and the short version is that the waitlist throttle's
     global ceiling counts every row in it, so one visitor refreshing
     this page would otherwise start refusing students' registrations.

   WHAT IT RECORDS, AND WHO FOR

     This function used to tell nobody but the log. Every attempt to
     deliver a code left one line in a Netlify build log, which is not
     a record: it expires, nobody opens it, and the desk cannot search
     it while a student is on the phone asking why the message never
     came. So each attempt is now appended to
     public.status_code_deliveries (supabase-status-history.sql) — the
     channel tried, whether the sender took it, and a machine word for
     why not — and the SUPPORT DESK reads it from a screen
     (status_history(), which authorizes the login itself).

     It is written AFTER the fact and never before it, and it cannot
     fail the caller: by the time it runs the student's request has
     already been answered, so a refused or broken trail write is logged
     and nothing else. A record that can turn a delivered code into a
     500 is worse than no record.

   WHAT IT NEVER DOES
   · It never returns the phone number, the email address, the name,
     the answers or the landlord's payload. The reveal is built in SQL
     from a fixed column list; this function only maps it to
     sentences.
   · It never logs a code, never a phone number and never an email
     address. The log line is the step, the reference, the channel and
     the outcome — and the trail row is a channel, one of three outcome
     words, and one of seven note words the schema names. A contact
     detail CANNOT be written to it: the column's CHECK takes a closed
     vocabulary, so this is a property of the table rather than a
     promise by this file.
   · It never stores a code in the clear, anywhere. The row holds
     sha256(ref|code|service key) — the salt never reaches the
     database, so a leaked row is not a leaked code.
   ============================================================ */

const crypto = require('node:crypto');

/* The shared failure vocabulary — the SAME file the page loads, so the
   class this function sends is the class assets/status.js reads. */
const ApiErrors = require('../../assets/api-errors.js');

/* The two senders, and there is only one of each on this site. claims.js
   reaches the same functions the same way — a credential with one owner
   and one implementation of "send a message". notify.js owns the mail
   one (and the rule for what a deliverable address is), so this file
   does not learn to speak to Resend itself. */
const { sendText } = require('./whatsapp-send.js');
const { sendEmail, emailConfig, mailDeliverable } = require('./notify.js');

const SUPABASE_URL_FALLBACK = 'https://nihdbhjecdkpvzvjifrm.supabase.co';

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cfg() {
  const url = (process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || SUPABASE_URL_FALLBACK)
    .replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return {
    url,
    serviceKey,
    ready: !!serviceKey,
    /* Whether the SECOND channel can deliver at all. It is read from
       its owner rather than from process.env, so "is mail configured"
       has one answer on this site. */
    mailReady: emailConfig().ready,
    /* The ceilings. Deliberately tighter than the waitlist's: a person
       checks their status once, and an attacker checks it a hundred
       times. The per-REFERENCE ceiling is not here — it is a parameter
       of the SQL function, because it protects a different person. */
    maxPerHour: clampInt(process.env.STATUS_MAX_PER_HOUR, 10, 1, 500),
    verifyPerHour: clampInt(process.env.STATUS_VERIFY_PER_HOUR, 60, 1, 5000),
    minGapSeconds: clampInt(process.env.STATUS_MIN_GAP_SECONDS, 2, 0, 600),
    globalPerHour: clampInt(process.env.STATUS_GLOBAL_PER_HOUR, 300, 1, 100000),
    codeTtlSeconds: clampInt(process.env.STATUS_CODE_TTL_SECONDS, 600, 60, 3600),
    /* ATTEMPTS PER CODE is NOT here any more, and that is a deliberate
       move rather than a missing line: the ceiling now lives on the code
       row (supabase-status-history.sql §1), decided when the code is
       issued. It was a deploy variable, which gave the same fact two
       homes — the number the verify path enforced and the number the
       desk's screen could report — and let a code issued before a
       settings change be judged after it. */
    maxCodesPerRef: clampInt(process.env.STATUS_MAX_CODES_PER_REF, 5, 1, 50),
  };
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
   The one answer. Exported so the test can assert that a malformed
   reference, an unknown reference and a wrong phone number produce
   byte-for-byte the same body — which is the property that makes
   enumeration pointless, and the one a future refactor is most
   likely to break by adding a helpful extra field.

   It is CHANNEL-NEUTRAL on purpose: "the contact details we hold for
   it" covers the phone and the email alike, so the same bytes answer
   a request made on either channel. A sentence that named the phone
   would have to be varied for the email channel, and a varying answer
   is the oracle this endpoint exists without. The page prints its own
   line about which channel it is about to use, before it ever asks.
   ------------------------------------------------------------ */

const SENT_ANYWAY =
  'If that reference and the contact details we hold for it match a record of ours, a code is on ' +
  'its way. It arrives within a minute and expires in ten.';

function sentAnyway() {
  return json(200, { ok: true, step: 'send', held: true, note: SENT_ANYWAY });
}

/* ------------------------------------------------------------
   Cleaning
   ------------------------------------------------------------ */

function clean(v, cap) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
  return String(v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap || 120);
}

/* A reference as this site mints it: ARZ-<S|L>-XXXX-XXXX-XXXX, hex.
   The normalisation is generous about what a person might type —
   lower case, spaces, or the dashes left out when copying — and
   strict about the rest, because a string that is not a reference
   must not reach the database as a lookup. */
function normaliseRef(raw) {
  const s = clean(raw, 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^ARZ[SL][0-9A-F]{12}$/.test(s)) return '';
  return 'ARZ-' + s.slice(3, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
}

function phoneDigits(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
}

function looksLikePhone(v) {
  const d = phoneDigits(v);
  return d.length >= 10 && d.length <= 15;
}

/* The last ten digits, which is how this site decides two typed
   numbers are the same person: "0803 123 4567" and "+2348031234567"
   are one subscriber, and a comparison that misses that locks a
   student out of their own record. The same rule the door uses for
   its duplicate check, deliberately. */
function phoneTail(v) {
  const d = phoneDigits(v);
  return d.length >= 10 ? d.slice(-10) : '';
}

/* ------------------------------------------------------------
   The email address, and the two rules about it

   WHICH KEY IT IS ON. A student's form files `email`; a landlord's
   listing has no email field yet, so a row that carries `mail` or
   `owner_email` is read too — one list, in one place, next to the
   phone list above, so the two sides of this file cannot drift.

   HOW IT IS COMPARED. Exactly, lower-cased — NOT by a tail the way a
   phone number is. "amaka@gmail.com" and "amaka2@gmail.com" are two
   different mailboxes, and a comparison that guessed otherwise would
   hand one person's code to another. The mailbox is the proof here,
   so it has to be the mailbox the record names.

   WHAT COUNTS AS DELIVERABLE is notify.js's answer (mailDeliverable),
   not a second regex written here: it already refuses the addresses
   this site INVENTS — `<phone>@receipts.arzuz.com` is a billing
   identifier, not a mailbox, and a code sent there is a code nobody
   can read. One owner for that rule.
   ------------------------------------------------------------ */

function emailOnRecord(row) {
  const p = (row && row.payload) || {};
  const keys = ['email', 'mail', 'owner_email'];
  for (let i = 0; i < keys.length; i++) {
    const raw = p[keys[i]];
    if (!raw) continue;
    const d = mailDeliverable(raw);
    if (d.ok) return d.address;
  }
  return '';
}

/* What the caller typed, as an address comparable to the one on the
   file — or empty, which is a refusal the caller cannot tell from any
   other. Deliberately the same rule as emailOnRecord's, so a value
   this endpoint would never accept as an address can never match one
   it holds. */
function normaliseEmail(v) {
  const d = mailDeliverable(clean(v, 254));
  return d.ok ? d.address : '';
}

/* The number, as OpenWA addresses it. 234XXXXXXXXXX only — a
   Nigerian mobile in international form — and anything else is
   refused here rather than sent to the provider to be rejected. A
   row whose number is a landline, or one nobody can decode, gets the
   email fallback instead of a failure. */
function jidFor(phone) {
  const d = phoneDigits(phone);
  let n = '';
  if (d.length === 13 && d.slice(0, 3) === '234') n = d;
  else if (d.length === 11 && d[0] === '0') n = '234' + d.slice(1);
  else if (d.length === 10) n = '234' + d;
  return /^234\d{10}$/.test(n) ? n + '@c.us' : null;
}

/* ------------------------------------------------------------
   The code, and the only form of it that is ever stored

   Six digits from the CSPRNG — not Math.random(), which is seeded for
   speed and not for unpredictability, and which would make the
   attempts ceiling the only real defence. The hash is salted with the
   service key, the same secret and the same reasoning as the IP hash:
   no new thing to configure, and a database row that leaks is not a
   code that leaks.
   ------------------------------------------------------------ */

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(ref, code, salt) {
  return crypto.createHash('sha256').update(salt + '|' + ref + '|' + code).digest('hex');
}

/* ------------------------------------------------------------
   The caller's address, as a hash — the same construction the
   waitlist door uses, so the two guards agree about what an address
   looks like and neither log line can be walked back to one.
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
   Issuing, and delivering — one place each

   The code itself is channel-independent: supabase-status-codes.sql
   stores a hash of it and never learns where it went, so the only
   difference between the two channels is the destination and the
   sentence. Both callers below go through these two helpers, so a
   third channel cannot invent a second way to spend the
   per-reference budget, and cannot deliver without saying so when it
   fails.
   ------------------------------------------------------------ */

/* Returns { ok: true } or { ok: false, limited, reason }. `limited` is
   the per-REFERENCE ceiling, which is reported to the caller — but
   only after the pair has been proved, where the caller already knows
   both halves of it and the answer tells them nothing new. */
async function issueCode(cfgv, ref, code) {
  const opened = await rpc(cfgv, 'status_open', {
    p_ref: ref,
    p_code_hash: hashCode(ref, code, cfgv.serviceKey),
    p_ttl_seconds: cfgv.codeTtlSeconds,
    p_max_per_ref_per_hour: cfgv.maxCodesPerRef,
  });
  /* The code's own id comes back with it, because every delivery attempt
     below is recorded AGAINST this code — "where did the message go" is
     a question about one code, not about a reference. */
  if (opened && opened.ok === true) return { ok: true, codeId: opened.code_id };
  return {
    ok: false,
    limited: !!(opened && opened.reason === 'ref_limited'),
    reason: (opened && opened.reason) || 'no answer',
  };
}

/* ------------------------------------------------------------
   The desk's record, written after the fact

   One row per attempt, appended to public.status_code_deliveries. It is
   deliberately NOT part of the answer to the caller and NOT able to
   change it: this runs after the student has been told what the page
   always tells them, so a refused or unreachable trail write is logged
   and swallowed. A record that can turn a delivered code into a 500 is
   worse than no record.

   The note is one of SEVEN words the schema names, and the mapping from
   the sender's own reason to those words is written out here rather
   than passed through. Pass-through would be shorter and would put the
   sender's vocabulary in the desk's screen — and, worse, the schema
   would coerce anything it did not know to 'unrecorded', which is a
   true but useless answer for somebody trying to work out whether the
   setup is broken. So: the three outcomes the table allows, from the
   reasons these two senders actually return.
   ------------------------------------------------------------ */

function whatsappOutcome(reason) {
  if (reason === 'not-configured') return { outcome: 'unreachable', note: 'openwa-unconfigured' };
  if (reason === 'bad-jid' || reason === 'unreachable') return { outcome: 'unreachable', note: 'openwa-unreachable' };
  /* openwa-401, openwa-403, openwa-5xx and anything else: it was asked
     and it said no. That is the one an operator acts on. */
  return { outcome: 'refused', note: 'openwa-refused' };
}

function mailOutcome(reason) {
  if (reason === 'not-configured') return { outcome: 'unreachable', note: 'mail-unconfigured' };
  return { outcome: 'refused', note: 'mail-refused' };
}

async function recordDelivery(cfgv, codeId, channel, outcome, note) {
  if (!codeId) return;
  try {
    const row = await rpc(cfgv, 'status_code_delivery', {
      p_code_id: codeId,
      p_channel: channel,
      p_outcome: outcome,
      p_note: note === undefined ? null : note,
    });
    if (!row || row.ok !== true) {
      console.error('[status] the delivery trail refused ' + channel + '/' + outcome +
        ':', (row && row.reason) || 'no answer');
    }
  } catch (err) {
    console.error('[status] could not write the delivery trail:', err && err.message);
  }
}

/* The message, and the ONE thing it deliberately does not carry: the
   reference. Whoever holds the mailbox or the phone is the owner, but
   a message that says "ARZ-S-...." is a message that hands the handle
   to anyone who glances at a lock-screen preview — and the code alone
   is what this page needs back. The same sentence goes out on both
   channels, because it means the same thing on both. */
function codeMessage(code, cfgv) {
  const minutes = Math.round(cfgv.codeTtlSeconds / 60);
  return 'Arzuz: your status code is ' + code + '. It expires in ' + minutes +
    ' minutes. If you did not ask for it, you can ignore this message.';
}

const CODE_SUBJECT = 'Your Arzuz status code';

/* The mail channel, in one place. Answers null when the code went out,
   or the reason it did not — which is logged and then answered with
   the generic sentence, EXACTLY like a WhatsApp send that failed. A
   visible failure here would be a difference in our reply that only a
   matched pair can cause, which is the oracle this endpoint exists
   without. sendEmail never throws (notify.js owns that promise), so
   there is nothing to catch. */
async function deliverByEmail(to, text, ref) {
  const sent = await sendEmail({ to: to, subject: CODE_SUBJECT, text: text });
  if (sent.ok) return null;
  console.error('[status] the email code for', ref, 'was NOT sent:', sent.reason);
  return sent.reason || 'refused';
}

/* ------------------------------------------------------------
   The row this reference names

   Two reads, because the reference registry is what says WHICH table
   holds it — a reference is a student's or a landlord's and the
   string itself does not say which. The registry is readable only
   with the service role (supabase-waitlist-launch.sql revokes both
   browser roles), which is the point of it.

   A `kind` that is neither table is not an error to report: it is a
   reference this endpoint cannot resolve, and the caller gets the
   one answer.
   ------------------------------------------------------------ */
async function findRow(cfgv, ref) {
  const reg = await sb(cfgv,
    'waitlist_ref_registry?select=kind&ref=eq.' + encodeURIComponent(ref) + '&limit=1');
  if (!reg || !reg.length) return null;

  const table = reg[0].kind === 'listings' ? 'listings'
    : (reg[0].kind === 'demand_records' ? 'demand_records' : null);
  if (!table) return null;

  const rows = await sb(cfgv,
    table + '?select=ref,payload&ref=eq.' + encodeURIComponent(ref) + '&limit=1');
  if (!rows || !rows.length) return null;
  return { table: table, row: rows[0], phone: phoneOnRecord(rows[0]) };
}

/* The number to prove control of. A student's form files `phone`; a
   landlord's files `ph` (and older rows `owner_phone`). One list, in
   one place, so the two sides cannot drift apart. */
function phoneOnRecord(row) {
  const p = (row && row.payload) || {};
  const keys = ['phone', 'ph', 'owner_phone'];
  for (let i = 0; i < keys.length; i++) {
    if (p[keys[i]]) return p[keys[i]];
  }
  return '';
}

/* ------------------------------------------------------------
   What the reveal MEANS

   supabase-status-codes.sql decides what may be seen and returns
   facts. The words are decided here, in one table, so the page has
   nothing to invent and a new stage cannot reach a student as a bare
   database word. Every stage in the vocabulary the launch migration
   constrains is covered — the test asserts that, because a missing
   one is a student shown an empty box at the moment they most want
   an answer.
   ------------------------------------------------------------ */

const HEADLINES = {
  student: {
    new: 'We have your request, and nobody has called you yet.',
    contacted: 'Someone from Arzuz has tried to reach you.',
    interested: 'You and a room are both in play — an agent is working on it.',
    matched: 'You have a match. Watch WhatsApp for the details.',
    closed: 'This request of yours is closed.',
  },
  landlord: {
    new: 'We have your listing, and it is waiting to be checked.',
    contacted: 'Someone from Arzuz has tried to reach you.',
    interested: 'A student is interested in this apartment.',
    matched: 'This apartment has been matched with a student.',
    closed: 'This listing is closed.',
  },
};

/* The sentences under the headline: what has actually happened, in
   the order a person asks it. Nothing here is read from the payload —
   only the facts the SQL function chose to hand over. */
function factsFor(rev) {
  const out = [];
  const when = new Date(rev.received_at);
  if (!isNaN(when.getTime())) {
    out.push('We received it on ' + when.toISOString().slice(0, 10) + '.');
  }
  if (rev.roommate === true) {
    out.push('It is also in the roommate pool, so you will be shown compatible profiles.');
  }
  if (rev.kind === 'landlord') {
    out.push(rev.verified_at
      ? 'This apartment has been checked by our team.'
      : 'This apartment has not been checked by our team yet.');
    if (rev.tier === 2) out.push('Its check was an inspection — the highest we do.');
    else if (rev.tier === 1) out.push('Its check was community verified.');
  } else if (rev.verified_at) {
    out.push('Someone from Arzuz has verified your details.');
  }
  return out;
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'This endpoint only accepts a status check.' });
  }

  const cfgv = cfg();

  /* A deploy with no service key cannot resolve anything at all, and
     the page is told which fact that is — 503 + 'not-ready' is the
     class assets/status.js reads as "not switched on", rather than
     being shown as a wrong reference or a wrong code. */
  if (!cfgv.ready) {
    return json(503, {
      error: 'The status page is not switched on in this deploy: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify (Site configuration → Environment variables).',
    }, 'not-ready');
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'That request arrived in a shape we could not read.' }, 'rejected');
  }

  const step = clean(body.step, 20).toLowerCase();
  if (step !== 'send' && step !== 'verify') {
    return json(400, { error: 'Unknown step.' }, 'rejected');
  }

  /* The honeypot, before the throttle, because it is the cheapest
     thing here: a field no person can see. Same refusal a bad request
     gets, for the same reason — a bot told it tripped a trap is a bot
     that skips the trap next time. */
  if (clean(body.hp, 80) !== '') {
    console.warn('[status] honeypot tripped on', step, '— refusing');
    return json(400, { error: 'That request could not be accepted.' }, 'rejected');
  }

  const ipHash = hashIp(event, cfgv.serviceKey);

  /* ---- THE COUNT, FIRST, BEFORE ANYTHING ABOUT THE REFERENCE ----
     Order matters here and it is not arbitrary. The throttle is the
     only thing that happens before the reference is looked at, so a
     broken throttle fails identically for every reference — which is
     what keeps the failure answer from becoming an oracle. It also
     means every attempt is counted, including the ones aimed at a
     reference that does not exist, which is the whole defence. */
  let verdict;
  try {
    verdict = await rpc(cfgv, 'status_throttle', {
      p_ip_hash: ipHash,
      p_scope: step,
      p_max_per_hour: step === 'verify' ? cfgv.verifyPerHour : cfgv.maxPerHour,
      p_min_gap_seconds: cfgv.minGapSeconds,
      p_global_per_hour: cfgv.globalPerHour,
    });
  } catch (err) {
    /* Here, and only here, is a failure allowed to be visible. It
       happens before the reference is touched, so it is the same
       answer for every reference and cannot be read as anything. The
       lookup is not let through un-throttled the way a submission is:
       losing a submission is worse than refusing one, and refusing a
       status check costs a refresh. */
    console.error('[status] throttle unavailable:', err && err.message);
    return json(502, {
      error: 'We could not check that just now — that is our side, not yours. Try again in a minute.',
    });
  }

  if (verdict && verdict.allow === false) {
    console.warn('[status] throttled on', step, 'reason', verdict.reason);
    return json(429, {
      error: 'That is a lot of status checks in a short time. Wait a few minutes and try again.',
    }, 'busy');
  }

  const ref = normaliseRef(body.ref);

  /* ============================================================
     step send — prove the phone, then put a code on it
     ============================================================ */

  if (step === 'send') {
    /* WHICH CONTACT IS BEING PROVED. Anything that is not exactly
       'email' is the phone path, so a page that sends no channel at
       all — an old cached copy of assets/status.js is the likely one —
       keeps the behaviour this endpoint has always had rather than
       being refused. */
    const channel = clean(body.channel, 20).toLowerCase() === 'email' ? 'email' : 'whatsapp';

    const typedPhone = clean(body.phone, 40);
    const typedMail = normaliseEmail(body.email);

    /* Every one of these leaves by the same door. A malformed
       reference, a contact too short or mis-shaped to be one, a
       reference nobody minted, a contact that is not the one on the
       file, a code that could not be sent — one body, one sentence, no
       way to tell them apart from the outside. */
    if (!ref) return sentAnyway();
    if (channel === 'email' ? !typedMail : !looksLikePhone(typedPhone)) return sentAnyway();

    let found = null;
    try {
      found = await findRow(cfgv, ref);
    } catch (err) {
      console.error('[status] lookup failed:', err && err.message);
      return sentAnyway();
    }
    if (!found) return sentAnyway();

    const mailOnFile = emailOnRecord(found.row);

    if (channel === 'email') {
      if (!mailOnFile || mailOnFile !== typedMail) return sentAnyway();
    } else if (!found.phone || phoneTail(found.phone) !== phoneTail(typedPhone)) {
      return sentAnyway();
    }

    /* ---- ABOVE HERE THE CONTACT IS PROVEN ----
       Past this point the caller has the reference AND a contact that
       is on the file, so an answer that differs from the generic one
       can no longer tell anyone anything they did not already know.
       That is why the two refusals below are allowed to speak, and why
       the per-reference ceiling is safe to report. */

    /* A deploy with no mail provider cannot deliver on this channel at
       all, and this is checked BEFORE a code is issued — unlike the
       phone path, where a code is issued and then sent. The
       per-reference ceiling is a budget that protects a person's
       inbox, and spending it on a message that cannot leave is
       spending it for nothing. */
    if (channel === 'email' && !cfgv.mailReady) {
      console.error('[status] the email code for', ref, 'was not even issued:',
        'RESEND_API_KEY is not set in Netlify');
      return sentAnyway();
    }

    const code = makeCode();
    const text = codeMessage(code, cfgv);

    let issued;
    try {
      issued = await issueCode(cfgv, ref, code);
    } catch (err) {
      console.error('[status] could not issue a code for', ref, '-', err && err.message);
      return sentAnyway();
    }

    /* The per-REFERENCE ceiling, which protects the person rather
       than this server: without it, anyone holding a reference could
       have this site message that student as often as they liked.
       Reported plainly BECAUSE the contact is already proven above. */
    if (!issued.ok) {
      console.warn('[status] code refused for', ref, '—', issued.reason);
      if (issued.limited) {
        return json(429, {
          error: 'Several codes have already been sent for that reference in the last hour. ' +
            'Use the newest one, or wait for the hour to pass.',
        }, 'busy');
      }
      return sentAnyway();
    }

    /* ---- DELIVERY, AND WHERE IT WENT ----
       Never anywhere but the caller's own contact, never reported when
       it fails, and always logged with the channel — an operator
       reading the log needs to know that code for X went out by email
       rather than by WhatsApp. The log carries no address and no
       number: the reference and the channel are enough. */
    if (channel === 'email') {
      const why = await deliverByEmail(mailOnFile, text, ref);
      const mail = why === null ? { outcome: 'sent', note: null } : mailOutcome(why);
      await recordDelivery(cfgv, issued.codeId, 'email', mail.outcome, mail.note);
      if (why === null) {
        console.log('[status] a code went out by email for', ref, '(' + found.table + ')');
      }
      return sentAnyway();
    }

    const jid = jidFor(found.phone);
    let delivered = '';

    if (!jid) {
      console.error('[status] the number on', ref, 'is not one we can message');
      await recordDelivery(cfgv, issued.codeId, 'whatsapp', 'unreachable', 'openwa-unreachable');
    } else {
      const sent = await sendText(jid, text);
      if (sent.ok) {
        delivered = 'whatsapp';
        await recordDelivery(cfgv, issued.codeId, 'whatsapp', 'sent', null);
      } else {
        console.error('[status] WhatsApp refused the code for', ref, ':', sent.reason);
        const wa = whatsappOutcome(sent.reason);
        await recordDelivery(cfgv, issued.codeId, 'whatsapp', wa.outcome, wa.note);
      }
    }

    /* THE FALLBACK — the half of the problem a second channel was
       added for. A number that cannot be messaged, or a sender that
       is down, is not the student's mistake, and the mailbox on the
       same record is still theirs. The SAME code goes to it, so the
       answer they are about to give is unchanged, and the reply to
       the caller is unchanged too: nothing outside can tell that the
       fallback happened.

       A record with NO address gets a row of its own rather than
       silence, and that row is the one the desk needs most: it says
       the fallback could not fire, which is the difference between
       "the message went somewhere they do not read" and "there was
       nowhere to send it". */
    if (!delivered) {
      if (!mailOnFile) {
        await recordDelivery(cfgv, issued.codeId, 'email', 'unreachable', 'no-mail-on-file');
      } else {
        const why = await deliverByEmail(mailOnFile, text, ref);
        const mail = why === null ? { outcome: 'sent', note: null } : mailOutcome(why);
        await recordDelivery(cfgv, issued.codeId, 'email', mail.outcome, mail.note);
        if (why === null) delivered = 'email';
      }
    }

    if (!delivered) {
      console.error('[status] the code for', ref, 'was issued but NOT sent');
      return sentAnyway();
    }

    console.log('[status] a code went out for', ref, '(' + found.table + ', ' + delivered + ')');
    return sentAnyway();
  }

  /* ============================================================
     step verify — the code comes back, and the stage goes out
     ============================================================ */

  const typedCode = clean(body.code, 12).replace(/\D/g, '');

  /* Wrong length, no reference, no live code, expired, already used,
     too many attempts and simply wrong: ONE answer, for the same
     reason as above. `status_verify` does tell them apart internally
     — it has to, to count attempts — but a caller holding a leaked
     reference could otherwise learn from our reply whether a code had
     ever been issued for it, which is a fact about a real person. */
  const wrong = json(400, {
    error: 'That code is not right, or it has expired. Ask for a new one if you need it.',
  }, 'rejected');

  if (!ref || typedCode.length !== 6) return wrong;

  let result;
  try {
    /* No ceiling is passed: the CODE's own ceiling governs, and
       supabase-status-history.sql §4 is where that is enforced. The
       parameter still exists as a fallback for a row without one, and
       deliberately not being sent from here is what keeps a deploy
       variable from becoming a second source for a number that is
       already recorded. */
    result = await rpc(cfgv, 'status_verify', {
      p_ref: ref,
      p_code_hash: hashCode(ref, typedCode, cfgv.serviceKey),
    });
  } catch (err) {
    console.error('[status] verify failed:', err && err.message);
    return json(502, {
      error: 'We could not check that code just now — that is our side, not yours. Try again in a minute.',
    });
  }

  if (!result || result.ok !== true || !result.reveal) return wrong;

  const rev = result.reveal;
  const words = HEADLINES[rev.kind] || HEADLINES.student;
  console.log('[status] revealed the stage for', ref, '(' + rev.kind + ', ' + rev.stage + ')');

  return json(200, {
    ok: true,
    step: 'verify',
    ref: rev.ref,
    kind: rev.kind,
    stage: rev.stage,
    state: rev.state,
    roommate: rev.roommate === true,
    tier: rev.tier === null || rev.tier === undefined ? null : rev.tier,
    received_at: rev.received_at || null,
    verified_at: rev.verified_at || null,
    headline: words[rev.stage] || 'We have this, and it is moving.',
    facts: factsFor(rev),
  });
};

/* Exported for scripts/test-status.mjs, which drives the handler with
   synthetic events and asserts the answers above — because an endpoint
   whose whole job is to answer the same thing to six different inputs
   if the one most likely to be "improved" into an oracle. */
exports.normaliseRef = normaliseRef;
exports.looksLikePhone = looksLikePhone;
exports.phoneDigits = phoneDigits;
exports.phoneTail = phoneTail;
exports.jidFor = jidFor;
exports.hashCode = hashCode;
exports.makeCode = makeCode;
exports.HEADLINES = HEADLINES;
exports.cfg = cfg;
/* The second channel's own rules, exported for the same reason: the
   test asserts them directly rather than through a network stand-in
   that could agree with a wrong implementation. */
exports.emailOnRecord = emailOnRecord;
exports.normaliseEmail = normaliseEmail;
exports.SENT_ANYWAY = SENT_ANYWAY;
