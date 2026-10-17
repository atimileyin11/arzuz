/* ============================================================
   Arzuz — Netlify Function: tell the engines the moment a room is live

   A listing is published from the admin dashboard
   (assets/admin.js → publishToListingBoard: one PATCH that sets
   status = 'active', a real tier and env = 'production'), and it can
   also be published by hand in the Supabase table editor. Both are
   the SAME event — a write to the listings table — so the hook is
   the database, not the dashboard. That is why this function has no
   code in admin.js pointing at it and why a listing published some
   other way is not quietly missed.

   Flow:

     listings INSERT/UPDATE
       → Supabase database webhook (see the setup note in SEO.md)
         → POST https://arzuz.com/api/listing-live
           → this function re-reads the row from public_listings
             → POST to IndexNow with /rooms/<slug>

   WHY RE-READ THE ROW INSTEAD OF TRUSTING THE BODY
     Two reasons, and the second is the one that matters.
     · public_listings is the same view the page, the browse board and
       the sitemap read, so the URL submitted here is by construction
       the URL the site serves. The body's own fields are not the
       authority on the address — that is assets/listing-url.js, and
       it needs the row.
     · A webhook body is an event, not state. A row can be taken down
       between the write and this request; the view catches that. Only
       when the view cannot be reached at all does the fallback body
       get used, and then only to say "this row was live, ask for a
       recrawl" (see the unreachable branch below).

   WHAT IT WILL NOT DO
     It will not re-submit a room that is already live and unchanged.
     Editors save live rows all day; IndexNow asks that a URL be
     submitted when it appears or changes, not on every save, and a
     function that pings on every write is a function that gets a host
     throttled.

     "Changed" is not only the address. A save that MOVES a room (the
     owner renamed the property, so the slug changed) is submitted
     because that is a new URL, and the old one 301s to it — but so is
     a save that leaves the address alone and changes what the page
     SAYS: the rent, the cover photo, how much of the property is free,
     what it is, where the pin is, the tier badge, and the description
     the owner rewrote. Those are the pages an engine has already
     indexed with yesterday's price — or yesterday's paragraph — on
     them, and an address-only rule quietly left every one of them
     stale. PAGE_FIELDS is the generated columns; descriptionOf() is
     the sixth fact, which lives in the payload and has no column.

     AND IT IS STILL ONLY WHAT THE PAGE PRINTS. public_listings scrubs
     the owner's identity out of payload before this function can read
     it (supabase-public-view.sql: `payload - 'nm' - 'last' - 'ph' -
     'who' - 'email'`), and descriptionOf() reads the description out
     of payload BY KEY rather than comparing payloads. A corrected
     caretaker phone number or a renamed landlord is not a page change:
     no visitor sees either, and pinging on one is precisely the
     every-save submission IndexNow asks a host not to send. The
     webhook body does carry those keys — which is exactly why the
     comparison never looks at the payload as a whole.

     It will not advertise a 404. Only the view's rows leave here, so
     a draft, an unverified tier or a non-production row is ignored.

   A TAKEDOWN IS SUBMITTED TOO
     When a room leaves the board the engines are told again, so they
     re-crawl it and see the real 404 that /rooms/<slug> now answers
     (netlify/functions/rooms.js reads the same view). Without this a
     room that was taken down stays in the index for weeks.

   Environment:
     INDEXNOW_HOOK_SECRET — required. The shared secret the webhook
                            sends in the x-arzuz-hook header (Supabase
                            Database Webhooks → "HTTP Headers"). This
                            function is public and unauthenticated
                            without it, and it writes to a search
                            engine's index on behalf of the domain.
     SUPABASE_URL / SUPABASE_ANON_KEY — same public pair the other
                            functions use; public_listings is the
                            anon-readable view.
   ============================================================ */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ApiErrors = require('../../assets/api-errors.js');

/* Both shared modules live in assets/ and are bundled by netlify.toml's
   included_files. Where they LAND differs between the repo and the
   deploy — next to this function in the sandbox, or under /var/task —
   so every layout is tried, exactly as rooms.js does it. A deploy that
   finds neither answers 503 rather than submitting a guessed URL. */
const MODULE_DIRS = [
  __dirname,
  path.join(__dirname, '..', '..'),
  '/var/task',
  '/var/task/netlify/functions',
  process.cwd()
];

function loadModule(fileName, repoRelative) {
  for (const dir of MODULE_DIRS) {
    for (const rel of [fileName, repoRelative]) {
      try {
        return require(path.join(dir, rel));
      } catch (e) { /* try the next layout */ }
    }
  }
  return null;
}

const ArzuzIndexNow = loadModule('indexnow.js', 'assets/indexnow.js');
const ArzuzListing = loadModule('listing-url.js', 'assets/listing-url.js');

const SITE = 'https://arzuz.com';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* The address fields, plus the ones a change is judged by (PAGE_FIELDS
   below), plus the payload — where the description lives, and the one
   fact a visitor reads that has no generated column. Nothing here is
   private: this is the anon-readable view and its payload is already
   scrubbed of owner identity. It is ONE row per webhook call, not the
   sitemap's thousand, so a paragraph in the response is the right
   price for noticing that the paragraph changed. */
const SELECT = 'id,tier,property_name,area,photo_url,property_type,rooms,listed_price_ngn,latitude,longitude,payload';

/* The COLUMN fields that change what a visitor reads on the room's page:
   the rent, the cover photo, how much of it is free, what it is, where
   the pin is, and the badge the tier draws. A save that leaves the
   address alone but moves one of these is a page an engine has already
   indexed with the old value on it, so it is worth a crawl — and it is
   the SAME facts netlify/functions/listings-sitemap.js sizes a room
   with (assets/listing-score.js), so "what the page says" means one
   thing on this site.

   The description is deliberately NOT in this list. It is compared by
   contentOf() below, on its own, because it is the one fact with no
   generated column to read and it must be read out of the payload by
   key — never by comparing payloads. */
const PAGE_FIELDS = ['listed_price_ngn', 'photo_url', 'rooms', 'property_type', 'latitude', 'longitude', 'tier'];

/* The payload as an object. PostgREST parses jsonb before it answers and
   the webhook body's record carries it parsed too, but a body that
   stringified it must not read as "this row has no description" — that
   would be a silent miss, which is the one failure this file does not
   accept. */
function payloadOf(row) {
  const p = row && row.payload;
  if (p && typeof p === 'object') return p;
  if (typeof p === 'string' && p.trim()) {
    try {
      const parsed = JSON.parse(p);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) { return {}; }
  }
  return {};
}

/* The description exactly as the room page reads it — desc first, then
   description (listing.html: `p.desc || p.description`), which is the
   same pair the view's has_description expression reads
   (supabase-public-view.sql). Trimmed, so a trailing newline the editor
   added is not a page change; absent and empty are the same fact.

   ONLY these two keys are read. That is what keeps a change to a
   field public_listings scrubs — the owner's name, initial, phone,
   who runs it, email — from being mistaken for a page change. */
function descriptionOf(row) {
  const p = payloadOf(row);
  const desc = p.desc;
  const raw = desc !== null && desc !== undefined && String(desc).trim() !== ''
    ? desc
    : p.description;
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

/* Null, undefined and "" are the same fact here — absent — and a number
   and its string form are the same rent, so the comparison is on text
   that has been through one normaliser rather than on the raw JSON. The
   description is appended last so the six facts read in one order. */
function contentOf(row) {
  if (!row) return '';
  return PAGE_FIELDS.map(function (field) {
    const v = row[field];
    return v === null || v === undefined ? '' : String(v).trim();
  }).join('|') + '|' + descriptionOf(row);
}

/* Where the key file can be in a bundle. The key is NOT a secret — it is
   served at the site root by design, and the engines fetch it before
   they will trust a submission — but the function still has to know it,
   and the file's name IS the key. */
const KEY_DIRS = [
  __dirname,
  path.join(__dirname, '..', '..'),
  '/var/task',
  process.cwd()
];

function findKey() {
  for (const dir of KEY_DIRS) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) { continue; }
    for (const name of names) {
      if (!ArzuzIndexNow.isKeyFileName(name)) continue;
      let contents = '';
      try {
        contents = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (e) { continue; }
      const key = ArzuzIndexNow.keyIn(name, contents);
      if (key) return { key: key, file: name };
    }
  }
  return null;
}

/* ---------- responses ---------- */

function json(status, obj, kind) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(ApiErrors.wireBody(status, obj, kind))
  };
}

/* Constant-time, length-checked — the same pattern paystack-webhook.js
   uses: timingSafeEqual throws on a length mismatch, so the throw is the
   "invalid" answer rather than a crash. */
function secretMatches(given, secret) {
  const a = String(given || '');
  if (!a || !secret) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(secret));
  } catch (e) {
    return false;
  }
}

/* ---------- Supabase ---------- */

/* Three answers, not two. "The view has no such row" and "the view could
   not be reached" are different facts and lead to different submissions:
   the first means the room is genuinely off the board, the second means
   we do not know and must fall back to the event's own body. Returning
   null for both would take a listing down over a dropped connection. */
async function fetchPublicListing(id) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(String(id || ''))) return { state: 'absent', row: null };
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listings?select=' + SELECT + '&id=eq.' + encodeURIComponent(id);
  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return { state: 'unreachable', row: null };
    const rows = await res.json();
    if (!Array.isArray(rows)) return { state: 'unreachable', row: null };
    return rows.length ? { state: 'row', row: rows[0] } : { state: 'absent', row: null };
  } catch (e) {
    console.warn('[listing-live] public_listings unreachable:', e && e.message);
    return { state: 'unreachable', row: null };
  }
}

/* ---------- what, if anything, to submit ---------- */

/* Same room AND nothing a visitor reads has moved: the address matches
   and so does every field the page prints. This is what "unchanged"
   means, and the reason it is not just the address is the whole point of
   the change — an edit that only moved the rent keeps the address, which
   is exactly the save an address-only rule dropped. */
function samePage(a, b) {
  if (!ArzuzListing) return false;
  return ArzuzListing.path(a) === ArzuzListing.path(b) && contentOf(a) === contentOf(b);
}

/* Decides from three inputs: what the site serves now (the view), what
   the event said the row was before, and the shared address builder.
   Returns either a URL to submit or a reason to do nothing — never a
   guess. */
function decide(view, before, after) {
  const live = ArzuzIndexNow.isLive;

  let target = null;
  let why = '';
  /* "Nothing changed" is only ever true when the room is STILL on the
     board. A room that has left it is the one case where the same address
     must be submitted again — that is how the engines come back and find
     the 404. Conflating the two is exactly how a gone room stays in the
     index for weeks. */
  let unchanged = false;

  if (view.state === 'row') {
    target = view.row;
    why = 'live on the board now';
    unchanged = live(before) && samePage(before, view.row);
  } else if (view.state === 'absent') {
    if (live(before)) {
      target = before;
      why = 'taken off the board — re-crawl so the engines see the 404';
    } else {
      return { submit: false, reason: 'not public inventory' };
    }
  } else if (live(after)) {
    /* The view could not be reached. The webhook body came from the
       database itself, so its record is the best available statement
       about the row — and a submission that turns out to be a 404 costs
       one crawl, while a missed listing costs the whole feature. */
    target = after;
    why = 'database unreachable — went by the event body';
    unchanged = live(before) && samePage(before, after);
  } else if (live(before)) {
    /* The event says a live row is no longer live, and the view cannot
       confirm it either way: a takedown during an outage. The old
       address is submitted for the same reason as any other takedown. */
    target = before;
    why = 'database unreachable — the row had been live';
  } else {
    return { submit: false, reason: 'not public inventory' };
  }

  const to = ArzuzListing ? ArzuzListing.path(target) : '';
  if (!to) return { submit: false, reason: 'the row has no id, so it has no address' };
  const url = SITE + to;

  /* Already live, same address, same page: a save that changed nothing a
     visitor can see. Resubmitting it is what IndexNow's own guidelines
     calls needless, and a host that does it on every save gets throttled.
     Every other save falls through to a submission — including one that
     kept the address and moved the rent. */
  if (unchanged) {
    return { submit: false, reason: 'already live, and nothing on the page changed', url: url };
  }

  return { submit: true, url: url, why: why };
}

/* ---------- handler ---------- */

exports.handler = async function (event) {
  if (String(event.httpMethod || 'GET').toUpperCase() !== 'POST') {
    return json(405, { error: 'POST only.' });
  }

  const secret = process.env.INDEXNOW_HOOK_SECRET || '';
  if (!secret) {
    return json(503, {
      error: 'This deploy has no INDEXNOW_HOOK_SECRET, so it cannot tell a real webhook from a stranger.'
    }, 'not-ready');
  }

  const headers = event.headers || {};
  const given =
    headers['x-arzuz-hook'] ||
    headers['X-Arzuz-Hook'] ||
    String(headers['authorization'] || headers['Authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!secretMatches(given, secret)) {
    return json(401, { error: 'That is not the shared secret, so nothing was submitted.' }, 'rejected');
  }

  if (!ArzuzIndexNow || !ArzuzListing) {
    return json(503, {
      error: 'The IndexNow modules are missing from this function bundle, so it will not submit a guessed URL.'
    }, 'not-ready');
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : String(event.body || '');

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (e) {
    return json(400, { error: 'The webhook body is not valid JSON.' });
  }
  if (!payload || typeof payload !== 'object') {
    return json(400, { error: 'The webhook sent no body to read a listing out of.' });
  }

  const before = payload.old_record || null;
  const after = payload.record || null;
  const id = (after && after.id) || (before && before.id) || '';
  if (!id) {
    return json(400, { error: 'The webhook body names no listing — no record and no old_record id.' });
  }

  const view = await fetchPublicListing(id);
  const verdict = decide(view, before, after);

  if (!verdict.submit) {
    /* Answered 2xx whether or not anything was submitted: a webhook that
       hears a failure retries, and retrying a decision ("this row is not
       inventory") cannot change the answer. */
    return json(200, { ok: true, ignored: verdict.reason, url: verdict.url || null });
  }

  const keyFile = findKey();
  if (!keyFile) {
    return json(503, {
      error: 'The IndexNow key file is not in this function bundle, so the submission would authenticate nothing.'
    }, 'not-ready');
  }

  let result;
  try {
    result = await ArzuzIndexNow.submit([verdict.url], { key: keyFile.key, keyFile: keyFile.file });
  } catch (e) {
    return json(502, { error: 'The submission never reached IndexNow: ' + (e && e.message) });
  }

  if (!result.ok) {
    /* 502 rather than a 200 that pretends: this is a real refusal, it is
       visible in the webhook's own log, and the engine's words are kept
       rather than paraphrased. */
    console.error('[listing-live] IndexNow refused:', result.status, result.text);
    return json(502, {
      error: 'IndexNow answered ' + result.status + (result.text ? ' — ' + result.text : '') + '.'
    });
  }

  console.log('[listing-live] submitted', verdict.url, '(' + verdict.why + ') HTTP ' + result.status);
  return json(200, { ok: true, submitted: verdict.url, why: verdict.why, status: result.status });
};

/* Exported for the suite, so the decision can be tested without a
   network or a webhook: scripts/test-indexnow.mjs. */
exports.decide = decide;
exports.contentOf = contentOf;
exports.descriptionOf = descriptionOf;
exports.PAGE_FIELDS = PAGE_FIELDS;
