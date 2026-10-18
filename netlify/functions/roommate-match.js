/* ============================================================
   Arzuz — Netlify Function: roommate matching

   The ONLY reader of the roommate pool. It holds the Supabase
   service-role key server-side and hands the browser scrubbed
   cards — never another student's raw answers, never a phone
   number that has not been unlocked.

   Why a function and not the browser:
     * supabase-roommate.sql gives anon NO access to
       roommate_profiles or roommate_interests. If the page could
       read the pool directly, anyone holding the published anon
       key could download every profile and its phone number.
     * A candidate's answers are the input to a judgement about
       them. The score is computed here so the answers never leave
       the server; the browser only ever receives a percentage and
       a few reasons.

   Ownership model — the private link, exactly like the draft
   invite link:
     * create returns a random token ONCE. Only its SHA-256 hash is
       stored (roommate_profiles.token_hash), so a dump of the
       table cannot be replayed against this API.
     * Every later action is authenticated by that token. There is
       no login and no session to steal — the link is the key.
     * Unknown or missing token → 404, with a body that tells the
       page to offer a fresh start rather than a stack trace.

   Double opt-in:
     * One student's 'accept' changes nothing. Contact is returned
       only when BOTH directions say 'accept', which is the whole
       point of the questionnaire.

   Three things happen here in addition to the match itself:

     1. THE CONSENT TRAIL. Every action appends a row to
        roommate_events (supabase-roommate.sql §5). It is a second
        record because roommate_interests is current state — it
        upserts, so a student who says yes and then changes their mind
        leaves one row saying 'pass' and no trace of the yes. The trail
        answers the question a dispute actually asks: who agreed to
        what, and when.

     2. THE FOLLOW-THROUGH SIGNAL. A match hands two students each
        other's number, and nothing in the database used to say
        whether either of them ever came back for it. Now, every read
        of the matches page notes which unlocked pairs it just put in
        front of the student ('viewed' in the trail, one row per
        pair). It is what lets the daily digest separate a pair who
        have both seen each other's number from one nobody has opened
        the page for since the unlock.

     3. THE TEAM'S ALERT. A new questionnaire and a completed match
        both buzz Telegram, through sendAlert() in notify.js so the
        bot token has one owner. Neither write may fail the student's
        action — see the note above trail() below.

   Environment variables (already used by team.js / notify.js):
     SUPABASE_SERVICE_ROLE_KEY  — secret, Netlify only
     SUPABASE_URL               — optional; falls back to the
                                  public project URL in config.js
     TELEGRAM_BOT_TOKEN         — optional; no token means no alerts,
     TELEGRAM_CHAT_ID             not a broken request

   Actions (POST /api/roommate-match, JSON):
     create   { payload, session?, env?, source? } → { ok, token, id }
     matches  { token }                            → { ok, me, matches }
     decide   { token, target, decision }          → { ok, unlocked, contact }
     withdraw { token }                            → { ok }
   ============================================================ */

const crypto = require('node:crypto');

/* The scoring engine is ONE source of truth, shared with the page
   and the unit tests (assets/roommate-score.js). It is a plain
   UMD module with no browser dependency, so requiring it here
   keeps the algorithm from being reimplemented server-side. */
const ArzuzMatch = require('../../assets/roommate-score.js');

/* notify.js owns TELEGRAM_BOT_TOKEN and the HTML escaping that keeps a
   student-typed name from breaking out of a message. Requiring it
   rather than reimplementing the send is what stops the token from
   being copied into a second function that someone then forgets to
   rotate. */
const { sendAlert, esc } = require('./notify.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUPABASE_URL_FALLBACK = 'https://nihdbhjecdkpvzvjifrm.supabase.co';

/* How many candidates a student is shown. The pool is scored in
   full and then cut, so this is a display cap, not a search cap. */
const MAX_MATCHES = 30;

/* The pool scan. Scoring 300 profiles is trivial; the cap exists
   so one very popular area cannot make a request slow. */
const POOL_LIMIT = 300;

/* How long an unlocked match may sit unopened before the daily digest
   names it. Three days is long enough that a student who checks their
   matches at the weekend is not flagged, and short enough that a dead
   match is caught while the team can still do something about it. The
   digest reads this constant, so the threshold lives in one place. */
const FOLLOW_UP_DAYS = 3;

/* Answers every profile must have before it may enter the pool.
   Without these the scorer has too little to judge, and a
   half-empty profile would sit there scoring 0 against everyone. */
const REQUIRED_ANSWERS = [
  'name', 'phone', 'gender',
  'sleep', 'wake', 'clean', 'guests', 'smoke', 'noise',
  'budget', 'split',
];

/* The shared failure vocabulary — the SAME file the page loads, so the
   class in this body is the class assets/roommate.js reads, not a
   second guess at the same status code. Loaded exactly like
   assets/roommate-score.js above, which is the same arrangement. */
const ApiErrors = require('../../assets/api-errors.js');

function json(statusCode, body, kind) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(ApiErrors.wireBody(statusCode, body, kind)),
  };
}

/* ------------------------------------------------------------
   Supabase REST plumbing (service role — bypasses RLS)
   ------------------------------------------------------------ */

function cfg() {
  const url = (process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || SUPABASE_URL_FALLBACK).replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, serviceKey, ready: !!serviceKey };
}

async function sb(path, options = {}) {
  const { url, serviceKey } = cfg();
  const res = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    /* The platform's own sentence first — "relation does not exist" is
       diagnosable and a bare status is not — and never a status code in
       the message itself, because this one is returned to a student's
       browser as the refusal they read. */
    const own = data && (data.message || data.hint || data.error);
    if (!own) console.error('[roommate-match] Supabase answered HTTP', res.status, String(text).slice(0, 200));
    const err = new Error(own || 'The matching service could not read its database just now.');
    err.status = res.status;
    /* THE DEPLOY'S OWN CREDENTIAL, REFUSED.

       sb() sends the SERVICE key on every call — no caller overrides
       Authorization — and the service role holds every grant on every
       table in this schema. So a 401 or a 403 here is never a
       student's session expiring and never a policy doing its job: it
       is the key this deploy was BUILT with being wrong, rotated, or
       an anon key pasted into the service slot. That is a deployment
       fact, not a bad minute, and the flag lets a door answer it the
       way it already answers a key that is simply absent, instead of
       inviting a retry that cannot succeed. */
    err.credentialRefused = res.status === 401 || res.status === 403;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------
   Tokens
   ------------------------------------------------------------ */

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/* ------------------------------------------------------------
   Rate limiting — per function instance, like whatsapp-send.js.
   Creating profiles is the only expensive, abusable call: a loop
   of them would flood the pool with matchable people. Reads are
   cheap and get a generous ceiling instead.
   ------------------------------------------------------------ */

const buckets = new Map();
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const CREATE_MAX = 3;
const READ_WINDOW_MS = 60 * 1000;
const READ_MAX = 120;

function limited(key, max, windowMs) {
  const now = Date.now();
  const hit = buckets.get(key);
  if (!hit || now - hit.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  hit.count += 1;
  return hit.count > max;
}

/* ------------------------------------------------------------
   Validation — the pool only ever contains answers the scorer
   actually understands. An unrecognised option is not silently
   kept: it would score as "unknown" forever and quietly poison
   everyone's percentages.
   ------------------------------------------------------------ */

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[\s\-()+]/g, '');
  if (digits.startsWith('0')) digits = '234' + digits.slice(1);
  return /^234\d{10}$/.test(digits) ? digits : null;
}

function sanitizeProfile(payload) {
  const out = {};
  const bad = [];

  Object.keys(ArzuzMatch.PROFILE).forEach((key) => {
    const def = ArzuzMatch.PROFILE[key];
    const value = payload ? payload[key] : undefined;

    if (key === 'budget') {
      const n = Number(value);
      if (value !== undefined && value !== null && value !== '') {
        if (!Number.isFinite(n) || n <= 0 || n > 100000000) bad.push(key);
        else out[key] = String(Math.round(n));
      }
      return;
    }
    if (value === undefined || value === null || value === '') return;
    if (def.options.indexOf(String(value)) === -1) bad.push(key);
    else out[key] = String(value);
  });

  /* Part B: soft preferences and deal-breakers. */
  Object.keys(ArzuzMatch.WANTS).forEach((key) => {
    const def = ArzuzMatch.WANTS[key];
    const value = payload ? payload[key] : undefined;
    if (value === undefined || value === null || value === '') return;

    if (def.kind === 'multi') {
      const wanted = ArzuzMatch.list(value).filter((v) => def.options.indexOf(v) !== -1);
      if (wanted.length) out[key] = wanted;
      return;
    }
    if (def.options.indexOf(String(value)) === -1) bad.push(key);
    else out[key] = String(value);
  });

  /* name / phone / free text */
  if (payload && payload.name !== undefined) out.name = String(payload.name).trim().slice(0, 60);
  if (payload && payload.area !== undefined) out.area = String(payload.area).trim().slice(0, 80);
  /* The situation answers are not scored — they decide what the team reads
     and which follow-up fits — but they must survive sanitizing or the
     pool holds profiles that no longer say which of the two situations
     they are. Capped and trimmed like every other kept value. */
  if (payload && payload.situation !== undefined) out.situation = String(payload.situation).trim().slice(0, 80);
  if (payload && payload.period !== undefined) out.period = String(payload.period).trim().slice(0, 40);
  if (payload && payload.total_rent !== undefined) {
    const tr = Number(payload.total_rent);
    if (payload.total_rent !== '' && (!Number.isFinite(tr) || tr <= 0 || tr > 100000000)) bad.push('total_rent');
    else if (payload.total_rent !== '') out.total_rent = String(Math.round(tr));
  }
  if (payload && payload.note !== undefined) out.note = String(payload.note).trim().slice(0, 600);
  if (payload && payload.phone !== undefined) {
    const phone = normalizePhone(payload.phone);
    if (phone) out.phone = phone; else bad.push('phone');
  }

  /* Only the language the student actually writes is kept — a
     free-text field is the one place a payload could grow. */
  return { profile: out, bad };
}

function missingAnswers(profile) {
  return REQUIRED_ANSWERS.filter((k) => {
    const v = profile[k];
    if (v === undefined || v === null) return true;
    return typeof v === 'string' && v.trim() === '';
  });
}

function firstNameOf(profile) {
  const raw = String((profile && profile.name) || '').trim();
  if (!raw) return 'Student';
  return raw.split(/\s+/)[0].slice(0, 40);
}

/* The name AS STORED. roommate_profiles.first_name is generated from
   payload->>'name' — the whole name the student typed, not just their
   first word. The trail and the alerts both snapshot that same value,
   so a line in the trail and a row in the dashboard read identically,
   and a dispute can be answered without joining back to a profile that
   an admin may have deleted in the meantime. */
function nameSnapshot(profile) {
  const raw = String((profile && profile.name) || '').trim();
  return raw ? raw.slice(0, 60) : 'Student';
}

function naira(value) {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0) ? '\u20a6' + n.toLocaleString('en-NG') : '';
}

/* ------------------------------------------------------------
   The card. Built field by field on purpose: a candidate's
   payload is never spread into a response, so a new question
   added to the questionnaire can never leak by default.
   ------------------------------------------------------------ */

function cardFor(mePayload, them, myDecision, theirDecision) {
  const score = ArzuzMatch.score(mePayload, them.payload || {});
  const p = them.payload || {};
  const unlocked = myDecision === 'accept' && theirDecision === 'accept';
  const budget = Number(p.budget);
  return {
    id: them.id,
    name: firstNameOf(p),
    pct: score.pct,
    verdict: score.verdict,
    reasons: score.reasons,
    area: p.area || '',
    budget: Number.isFinite(budget) && budget > 0 ? budget : null,
    gender: p.gender || '',
    my_decision: myDecision || null,
    their_decision: theirDecision || null,
    unlocked,
    contact: unlocked ? { name: firstNameOf(p), phone: p.phone || '' } : null,
    _score: score,
  };
}

/* ------------------------------------------------------------
   The consent trail, and the two alerts
   ------------------------------------------------------------

   Neither of these may fail the student's action.

   By the time either runs, the profile or the decision is already
   committed. Throwing here would show an error for something that
   actually succeeded — and for `create` a retry is worse than an
   error: that insert has no conflict key, so retrying makes a SECOND
   profile. So a failure is logged loudly and swallowed, and the
   student's request stands. An alert that is not sent is a missed
   notification; a profile duplicated because we insisted on
   reporting a Telegram outage is real damage.

   Both are awaited rather than fired and forgotten: Netlify may freeze
   the instance the moment the handler returns, which would drop a
   pending fetch silently. The 5s abort inside notify.js caps what
   that costs the student. */
/* ------------------------------------------------------------
   The follow-through signal — see (2) in the header.

   One row per (student, partner), not one per page load: a student
   refreshing their matches in a shop queue would otherwise bury the
   trail in "Grace opened her matches" and the digest's question (has
   this pair been looked at YET) would be unanswerable. So the existing
   rows are read first and only the pairs with no 'viewed' row are
   written.

   A failure is logged and swallowed, exactly like every other trail
   write: the student's own page must never break because an audit
   write did. It is the weakest kind of audit line to lose — the next
   visit writes it again. */
async function noteViewed(me, partners) {
  if (!partners.length) return;
  try {
    const seen = await sb(
      'roommate_events?select=subject_ref&event=eq.viewed' +
        '&actor_ref=eq.' + encodeURIComponent(me.id) +
        '&subject_ref=in.(' + partners.map((p) => encodeURIComponent(p.id)).join(',') + ')',
      { method: 'GET' }
    );
    const already = new Set((seen || []).map((r) => r.subject_ref));
    const rows = partners
      .filter((p) => !already.has(p.id))
      .map((p) => ({
        event: 'viewed',
        actor_ref: me.id,
        actor_name: nameSnapshot(me.payload || {}),
        subject_ref: p.id,
        subject_name: nameSnapshot({ name: p.first_name }),
        env: me.env,
        session: me.session,
      }));
    if (!rows.length) return;
    await sb('roommate_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    console.error('[roommate-match] consent trail write failed (viewed):', err.message);
  }
}

async function trail(event, opts) {
  try {
    await sb('roommate_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        event: event,
        actor_ref: opts.actor || null,
        actor_name: opts.actorName || null,
        subject_ref: opts.subject || null,
        subject_name: opts.subjectName || null,
        env: opts.env || 'production',
        session: opts.session || null,
      }),
    });
    return true;
  } catch (err) {
    /* Expected once on a database where supabase-roommate.sql has been
       run but the trail table predates it — the log line says which
       write was lost, so the gap is visible rather than silent. */
    console.error('[roommate-match] consent trail write failed (' + event + '):', err.message);
    return false;
  }
}

/* Only two events are worth a phone buzzing: the pool grew, or a pair
   completed. A one-sided accept, a pass and a withdrawal are all in
   the trail and deliberately NOT alerted — a yes nobody has answered
   is not news, and a student changing their mind is not something to
   announce to the team. */

function newProfileAlert(profile, envName, session) {
  const lines = [
    '\ud83c\udf95 <b>New roommate questionnaire</b>',
    '',
    '\u2022 <b>Student:</b> ' + esc(nameSnapshot(profile)),
    '\u2022 <b>Area:</b> ' + (profile.area ? esc(profile.area) : 'not given') +
      (naira(profile.budget) ? ' \u00b7 ' + naira(profile.budget) + ' a session' : ''),
    '\u2022 <b>Sleep:</b> ' + esc(profile.sleep || '\u2014') + ' \u00b7 <b>Cleans:</b> ' + esc(profile.clean || '\u2014'),
  ];
  const dbs = ArzuzMatch.list(profile.dealbreakers);
  if (dbs.length) lines.push('\u2022 <b>Deal-breakers:</b> ' + esc(dbs.join(', ')));
  lines.push('');
  lines.push('\ud83d\udcc5 <b>Session:</b> ' + esc(session || process.env.ARZUZ_SESSION || '2026/2027'));
  lines.push('\ud83d\udccd <b>Environment:</b> ' + esc(envName));
  lines.push('Dashboard \u2192 Roommates shows who else is waiting.');
  return lines.join('\n');
}

function matchAlert(a, b, session) {
  return [
    '\ud83e\udd1d <b>Roommate match \u2014 both said yes</b>',
    '',
    '\u2022 <b>Student A:</b> ' + esc(a.name) + (a.area ? ' \u00b7 ' + esc(a.area) : '') +
      (naira(a.budget) ? ' \u00b7 ' + naira(a.budget) : ''),
    '\u2022 <b>Student B:</b> ' + esc(b.name) + (b.area ? ' \u00b7 ' + esc(b.area) : '') +
      (naira(b.budget) ? ' \u00b7 ' + naira(b.budget) : ''),
    '',
    'Their contact details are now visible to each other.',
    'Send the introduction from Dashboard \u2192 Roommates.',
    '',
    '\ud83d\udcc5 <b>Session:</b> ' + esc(session || process.env.ARZUZ_SESSION || '2026/2027'),
  ].join('\n');
}

/* ------------------------------------------------------------
   Data access
   ------------------------------------------------------------ */

async function profileByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const rows = await sb(
    'roommate_profiles?token_hash=eq.' +
      encodeURIComponent(hashToken(token)) +
      '&select=*&limit=1',
    { method: 'GET' }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function decisionsFor(column, id) {
  const rows = await sb(
    'roommate_interests?select=' + (column === 'from_ref' ? 'to_ref' : 'from_ref') +
      ',decision&' + column + '=eq.' + encodeURIComponent(id) + '&limit=1000',
    { method: 'GET' }
  );
  const map = {};
  (rows || []).forEach((r) => {
    const key = column === 'from_ref' ? r.to_ref : r.from_ref;
    map[key] = r.decision;
  });
  return map;
}

async function candidatePool(me) {
  const env = me.env === 'test' ? 'test' : 'production';
  let path =
    'roommate_profiles?select=id,payload,status,created_at' +
    '&env=eq.' + env +
    '&status=eq.open' +
    '&id=neq.' + encodeURIComponent(me.id) +
    '&order=created_at.desc&limit=' + POOL_LIMIT;
  if (me.session) path += '&session=eq.' + encodeURIComponent(me.session);
  return (await sb(path, { method: 'GET' })) || [];
}

/* Anyone this student has already decided about, or who has decided
   about them — fetched by id, ignoring pool status.

   This is what makes double opt-in survive a page reload. A mutual
   match flips both profiles to 'matched', which takes them out of
   the open pool; without this second read the student would refresh
   and find the contact details they just unlocked had vanished.
   'closed' (withdrawn) profiles are dropped — a withdrawn student
   must stop appearing in anyone's list. */
async function connectedProfiles(mineOut, theirsIn) {
  const ids = Object.keys(mineOut)
    .concat(Object.keys(theirsIn))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 200);
  if (!ids.length) return [];
  const rows = await sb(
    'roommate_profiles?select=id,payload,status&id=in.(' + ids.join(',') + ')&limit=200',
    { method: 'GET' }
  );
  return (rows || []).filter((r) => r.status !== 'closed');
}

/* ------------------------------------------------------------
   Actions
   ------------------------------------------------------------ */

async function actionCreate(body) {
  const { profile, bad } = sanitizeProfile(body.payload || {});
  if (bad.length) {
    return json(400, {
      error: 'Some answers were not recognised: ' + bad.join(', ') +
        '. Refresh the page and answer each question from the list given.',
    });
  }
  const missing = missingAnswers(profile);
  if (missing.length) {
    return json(400, { error: 'The questionnaire is incomplete. Missing: ' + missing.join(', ') + '.' });
  }

  const token = newToken();
  const row = {
    token_hash: hashToken(token),
    payload: profile,
    session: body.session || null,
    env: body.env === 'test' ? 'test' : 'production',
    source: String(body.source || 'roommates.html').slice(0, 120),
    referrer: String(body.referrer || '').slice(0, 300) || null,
    user_agent: String(body.user_agent || '').slice(0, 300) || null,
    status: 'open',
  };

  const inserted = await sb('roommate_profiles', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const created = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!created || !created.id) throw new Error('Profile was not stored');

  /* Recorded before the token is handed back, so a profile the student
     can see is one the trail already accounts for. */
  await trail('created', {
    actor: created.id, actorName: nameSnapshot(profile),
    subject: created.id, subjectName: nameSnapshot(profile),
    env: row.env, session: row.session,
  });

  /* A test-env profile buzzes nobody: it is not in the pool the panel
     reads either, so an alert about one would point the team at
     something they cannot see. The trail still records it — the audit
     log is not filtered, only the phone notification is. */
  if (row.env !== 'test') {
    await sendAlert(newProfileAlert(profile, row.env, row.session));
  }

  /* The token is returned exactly once, here. It is not stored in
     readable form anywhere, so a lost link cannot be recovered —
     the page tells the student that plainly. */
  return json(200, { ok: true, token, id: created.id });
}

async function actionMatches(body) {
  const me = await profileByToken(body.token);
  /* A link that is not in this database. NOT 'not-ready': the SAME
     link will be unknown forever, and the class is what stops the page
     telling the student to try again. */
  if (!me) return json(404, { error: 'No profile is linked to this private link.' }, 'rejected');

  const [pool, mineOut, theirsIn] = await Promise.all([
    candidatePool(me),
    decisionsFor('from_ref', me.id),
    decisionsFor('to_ref', me.id),
  ]);
  const known = await connectedProfiles(mineOut, theirsIn);

  /* The open pool plus this student's own connections, one row per
     person — a profile that is both gets counted once. */
  const byId = new Map();
  pool.forEach((p) => byId.set(p.id, p));
  known.forEach((p) => byId.set(p.id, p));

  const cards = [];
  for (const them of byId.values()) {
    const myDecision = mineOut[them.id];
    const theirDecision = theirsIn[them.id];
    const mutual = myDecision === 'accept' && theirDecision === 'accept';
    const card = cardFor(me.payload || {}, them, myDecision, theirDecision);

    if (!mutual) {
      /* Someone who already passed on this student is not put back
         in front of them — that is what 'pass' means. */
      if (theirDecision === 'pass') continue;
      if (!card._score.pass || card._score.dealbreaker) continue;
    }
    delete card._score;
    cards.push(card);
  }

  /* A live match is pinned to the top and never trimmed away: the
     contact details must still be here tomorrow. Everything else
     is ranked by score and capped. */
  cards.sort((a, b) => (Number(b.unlocked) - Number(a.unlocked)) || (b.pct - a.pct));
  const unlockedCards = cards.filter((c) => c.unlocked);
  const rest = cards.filter((c) => !c.unlocked).slice(0, MAX_MATCHES);
  const trimmed = unlockedCards.concat(rest);

  /* The follow-through signal. Written only now, after the trimming, so
     the trail records what the student was ACTUALLY shown — a pair cut
     from the list above was never put in front of them. The profile row
     is used rather than the card, because the card carries a first name
     only and the trail snapshots the name as stored. */
  await noteViewed(me, unlockedCards.map((c) => byId.get(c.id)).filter(Boolean));

  return json(200, {
    ok: true,
    me: {
      name: firstNameOf(me.payload || {}),
      area: (me.payload || {}).area || '',
      gender: (me.payload || {}).gender || '',
      budget: Number((me.payload || {}).budget) || null,
      status: me.status,
    },
    matches: trimmed,
  });
}

async function actionDecide(body) {
  const me = await profileByToken(body.token);
  /* A link that is not in this database. NOT 'not-ready': the SAME
     link will be unknown forever, and the class is what stops the page
     telling the student to try again. */
  if (!me) return json(404, { error: 'No profile is linked to this private link.' }, 'rejected');

  const decision = body.decision === 'accept' ? 'accept' : (body.decision === 'pass' ? 'pass' : null);
  if (!decision) return json(400, { error: 'decision must be "accept" or "pass".' });

  const target = String(body.target || '');
  if (!/^[0-9a-f-]{36}$/i.test(target)) return json(400, { error: 'Missing or malformed target.' });
  if (target === me.id) return json(400, { error: 'You cannot decide about your own profile.' });

  /* The target must still be a real profile — otherwise a stale
     card could write a row pointing at nobody. The generated columns
     come along so the trail and the match alert do not each need
     another round trip to name the person. */
  const targetRows = await sb(
    'roommate_profiles?id=eq.' + encodeURIComponent(target) +
      '&select=id,first_name,area,budget_ngn&limit=1',
    { method: 'GET' }
  );
  if (!targetRows || !targetRows[0]) return json(404, { error: 'That profile is no longer available.' }, 'rejected');

  /* The student's OWN previous decision, read BEFORE the upsert.

     The match side effects below must fire on the transition INTO a
     mutual match, not on every tap after it. Without this read a
     student who reloads and taps accept a second time re-alerts the
     team and appends a second 'matched' line for a pair that unlocked
     yesterday — and the trail, which exists to be precise about when a
     pair unlocked, would stop being precise. */
  const priorRows = await sb(
    'roommate_interests?from_ref=eq.' + encodeURIComponent(me.id) +
      '&to_ref=eq.' + encodeURIComponent(target) + '&select=decision&limit=1',
    { method: 'GET' }
  );
  const alreadyAccepted = !!(priorRows && priorRows[0] && priorRows[0].decision === 'accept');

  /* Upsert: (from_ref, to_ref) is unique, so a second tap
     overwrites the decision instead of creating a second row. */
  await sb('roommate_interests?on_conflict=from_ref,to_ref', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ from_ref: me.id, to_ref: target, decision }),
  });

  const myName = nameSnapshot(me.payload || {});
  const theirName = nameSnapshot({ name: targetRows[0].first_name });

  /* Appended IMMEDIATELY after the upsert, before anything that could
     fail later. This row is the one that survives a change of mind: if
     the student accepts today and passes next week, the upsert above
     leaves one row saying 'pass' and this is the only remaining record
     that a yes was given — and when. */
  await trail(decision === 'accept' ? 'accept' : 'pass', {
    actor: me.id, actorName: myName,
    subject: target, subjectName: theirName,
    env: me.env, session: me.session,
  });

  if (decision !== 'accept') return json(200, { ok: true, unlocked: false, contact: null });

  const back = await sb(
    'roommate_interests?from_ref=eq.' + encodeURIComponent(target) +
      '&to_ref=eq.' + encodeURIComponent(me.id) + '&decision=eq.accept&select=id&limit=1',
    { method: 'GET' }
  );

  if (!back || !back[0]) {
    /* One-sided. The other student is told nothing yet. */
    return json(200, { ok: true, unlocked: false, contact: null, awaiting: true });
  }

  const other = await sb(
    'roommate_profiles?id=eq.' + encodeURIComponent(target) + '&select=payload&limit=1',
    { method: 'GET' }
  );
  const p = (other && other[0] && other[0].payload) || {};
  const contact = { name: firstNameOf(p), phone: p.phone || '' };

  /* Already a match. The student re-tapped, or reloaded and tapped
     again: they get the contact details back — the link must keep
     working — but nothing else happens. No second status flip, no
     second 'matched' line, and above all no second alert. */
  if (alreadyAccepted) return json(200, { ok: true, unlocked: true, contact: contact });

  /* Double opt-in complete, for the first time. Both profiles flip to
     'matched', which is what stops them being re-scored against the
     open pool. */
  const now = new Date().toISOString();
  await Promise.all([
    sb('roommate_profiles?id=eq.' + encodeURIComponent(me.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'matched', updated_at: now }),
    }),
    sb('roommate_profiles?id=eq.' + encodeURIComponent(target), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'matched', updated_at: now }),
    }),
  ]);

  /* A second row, not a flag on the first: the accept and the unlock
     are two facts that happen at two moments, and a dispute is usually
     about the gap between them. Written after the status patches, so a
     'matched' line can never claim an unlock that did not commit. */
  await trail('matched', {
    actor: me.id, actorName: myName,
    subject: target, subjectName: theirName,
    env: me.env, session: me.session,
  });

  if (me.env !== 'test') {
    await sendAlert(matchAlert(
      { name: myName, area: me.area, budget: me.budget_ngn },
      { name: theirName, area: targetRows[0].area, budget: targetRows[0].budget_ngn },
      me.session
    ));
  }

  return json(200, { ok: true, unlocked: true, contact: contact });
}

async function actionWithdraw(body) {
  const me = await profileByToken(body.token);
  /* A link that is not in this database. NOT 'not-ready': the SAME
     link will be unknown forever, and the class is what stops the page
     telling the student to try again. */
  if (!me) return json(404, { error: 'No profile is linked to this private link.' }, 'rejected');

  await sb('roommate_profiles?id=eq.' + encodeURIComponent(me.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'closed', updated_at: new Date().toISOString() }),
  });

  /* Not alerted — a withdrawal is not news — but it belongs in the
     trail: "this student asked me to stop" is exactly the kind of
     thing a later dispute turns on. */
  const myName = nameSnapshot(me.payload || {});
  await trail('withdrawn', {
    actor: me.id, actorName: myName,
    subject: me.id, subjectName: myName,
    env: me.env, session: me.session,
  });

  /* Withdrawing closes the profile; it does not erase the record.
     A living match keeps its contact — pulling it back from the
     other student mid-conversation would be worse than keeping it. */
  return json(200, { ok: true });
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const { ready } = cfg();
  if (!ready) {
    /* A 503 that is a DEPLOYMENT FACT: roommate matching cannot answer
       until the key is added, and no amount of retrying by a student
       will change that. 'not-ready' is what says so. */
    return json(503, {
      error: 'Roommate matching is not switched on yet: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify. ' +
        'Add it under Site settings → Environment variables, then redeploy.',
    }, 'not-ready');
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const action = String(body.action || '');
  const ip = (event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for'] ||
    'unknown').split(',')[0].trim();

  try {
    if (action === 'create') {
      if (limited('create:' + ip, CREATE_MAX, CREATE_WINDOW_MS)) {
        return json(429, { error: 'Too many profiles created from this connection. Try again shortly.' });
      }
      return await actionCreate(body);
    }

    if (limited('read:' + ip, READ_MAX, READ_WINDOW_MS)) {
      return json(429, { error: 'Too many requests. Try again in a minute.' });
    }

    if (action === 'matches') return await actionMatches(body);
    if (action === 'decide') return await actionDecide(body);
    if (action === 'withdraw') return await actionWithdraw(body);

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('[roommate-match]', action, err.message);
    return json(502, { error: 'The matching service could not complete that request.' });
  }
};

/* Exported for the test harness — the pieces that are worth
   testing on their own, without a network in the way. */

/* And for the daily digest, which reads the same tables through the
   same REST helper rather than copying this plumbing (and the name of
   the service-role variable) into a second function. */
exports.sb = sb;
exports.cfg = cfg;
exports.FOLLOW_UP_DAYS = FOLLOW_UP_DAYS;

exports.sanitizeProfile = sanitizeProfile;
exports.missingAnswers = missingAnswers;
exports.cardFor = cardFor;
exports.normalizePhone = normalizePhone;
exports.hashToken = hashToken;
/* Exported for care-credit.js: the private-link token has one owner,
   the same way the Supabase plumbing does. */
exports.newToken = newToken;
exports.REQUIRED_ANSWERS = REQUIRED_ANSWERS;
