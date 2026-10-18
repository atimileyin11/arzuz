/* ============================================================
   Arzuz — Netlify Function: the sitemap the database writes

   sitemap.xml is hand-maintained because those ten pages are
   hand-maintained. Listings are the opposite: they appear, get
   edited, fill up and get taken down by owners, and nobody is going
   to remember to add a line to an XML file when that happens. So
   the listing half of the sitemap is generated from the same view
   the rest of the site reads, and it is wired up as:

     https://arzuz.com/sitemap-listings.xml

   It is a SEPARATE sitemap from sitemap.xml, not a merged one, and
   it is listed as a second Sitemap: line in robots.txt. That way a
   failure here — Supabase unreachable, a schema change — cannot take
   the ten stable pages down with it.

   Every <loc> is built with assets/listing-url.js, the same module
   the page and the browse links use, so a listing cannot be
   advertised at one address and canonicalised to another.

   The view already excludes listings that are not active, not
   verified and not production, so this file is exactly the set of
   rooms a visitor can actually open. Nothing private is exposed:
   the query asks for the id, the name, the area and the two dates,
   which are the generated columns and the stamps.

   lastmod IS THE EDIT DATE, NOT THE CREATION DATE. It used to report
   created_at, which told a search engine "nothing here has changed"
   about a room whose rent had just been corrected — on exactly the
   pages this site most needs re-crawled. It now reports
   listings.updated_at (supabase-listings-updated-at.sql), with
   created_at as the fallback until that file has been run.

   changefreq AND priority ARE PER ROOM, NOT CONSTANTS. They were
   weekly/0.6 on every URL — a claim that a sparse compound nobody has
   touched is exactly as likely to change as a complete room whose price
   moved yesterday. Both now come off one score built from how recently
   the room changed and how much of its page there is — one score, in
   assets/listing-score.js so the admin dashboard can show an owner the
   same numbers this file publishes to the engines (see signals()).

   A load failure returns 503, never an empty sitemap. An empty
   sitemap is read as "these pages are gone", and a search engine
   will believe it; a 503 is read as "ask again later", which is
   what is actually true.
   ============================================================ */

const path = require('path');

/* Both shared modules live in assets/ and are bundled by netlify.toml's
   included_files. Where they LAND differs between the repo and the
   deploy — next to this function in the sandbox, or under /var/task — so
   every layout is tried, exactly as rooms.js does it. */
function loadFromAssets(fileName) {
  const candidates = [
    path.join(__dirname, fileName),
    path.join(__dirname, '..', '..', 'assets', fileName),
    '/var/task/assets/' + fileName
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (e) { /* try the next location */ }
  }
  return null;
}

const ArzuzListing = loadFromAssets('listing-url.js');
/* The freshness/completeness score, in assets/listing-score.js so the
   admin dashboard publishes the same numbers this sitemap does — see
   that file. There is no fallback copy here on purpose: a deploy that
   lost it answers 503 rather than sizing every room the same, which is
   the kind of sitemap an engine learns to ignore. */
const Score = loadFromAssets('listing-score.js');

const SITE = 'https://arzuz.com';
/* What the sitemap queries. property_name and area are generated columns
   off the payload, so the slug comes out identical to the one the page
   builds from the full row; the rest are the completeness signals
   (completeness() below), asked for here rather than in a second round
   trip. Still no payloads: eight generated columns and one boolean are a
   few hundred bytes a room, a payload is a few kilobytes. The six signals
   they feed are named in assets/listing-score.js; has_description is the
   boolean among them — whether a description exists, without its text
   (see supabase-public-view.sql). */
const FIELDS = 'property_name,area,photo_url,property_type,rooms,listed_price_ngn,latitude,longitude';
const SELECT = 'id,created_at,updated_at,' + FIELDS + ',has_description';
/* The same SELECT minus the one column that is newest, so a database whose
   view has not been recreated stops losing the description rather than the
   whole completeness score. */
const SELECT_WITHOUT_DESCRIPTION = 'id,created_at,updated_at,' + FIELDS;

/* Before supabase-listings-updated-at.sql has been run there is no such
   column, and PostgREST answers 400 for the SELECT — which would take the
   whole listings sitemap to 503 and tell the engines every room is gone.
   So the edit stamp is a preference, not a requirement: the first query
   asks for it, and a 400 retries without it. See lastmod() below for what
   gets reported in the meantime (the honest older date, not a guess). */
const SELECT_WITHOUT_STAMP = 'id,created_at,' + FIELDS;
/* Last resort. Only the slug can still be built from this, so every room is
   sized the same — reached only by a database that predates the generated
   columns altogether. */
const SELECT_MINIMAL = 'id,created_at,property_name,area';
const LIMIT = 1000;

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

async function query(select) {
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listings?select=' + select +
    '&order=created_at.desc&limit=' + LIMIT;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('public_listings did not return an array');
  return { ok: true, rows };
}

/* Four SELECTs in descending order of what they ask for, because each one
   names columns an older database may not have and a 400 must never become
   a 503. Each step drops exactly one reason a database might refuse the
   query, newest first:

     1. everything — every generated column, the edit stamp, and whether
        there is a description;
     2. no has_description — a view that has not been recreated since that
        expression was added;
     3. no edit stamp either — a database that has not run
        supabase-listings-updated-at.sql;
     4. only the slug — a database that predates the generated columns,
        where every room is sized the same and the log says so.

   Anything that is not a 400 — a 500, a timeout, a refusal — is a real
   failure and is thrown, because retrying it without a column would only
   hide it. */
async function fetchListings() {
  const attempts = [
    { select: SELECT, note: '' },
    { select: SELECT_WITHOUT_DESCRIPTION,
      note: 'has_description is not in this view yet — run ' +
            'supabase-public-view.sql. Sizing rooms without the description until then.' },
    { select: SELECT_WITHOUT_STAMP,
      note: 'updated_at is not in this database yet — run ' +
            'supabase-listings-updated-at.sql, then supabase-public-view.sql. ' +
            'Reporting created_at as lastmod until then.' },
    { select: SELECT_MINIMAL,
      note: 'public_listings is missing the generated columns the sitemap sizes ' +
            'rooms with — run supabase-hardening.sql and supabase-public-view.sql. ' +
            'Sizing every listing the same until then.' }
  ];

  let last = 0;
  for (const attempt of attempts) {
    const res = await query(attempt.select);
    if (res.ok) {
      if (attempt.note) console.warn('[listings-sitemap] ' + attempt.note);
      return res.rows;
    }
    if (res.status !== 400) throw new Error('public_listings answered HTTP ' + res.status);
    last = res.status;
  }
  throw new Error('public_listings answered HTTP ' + last);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* The day the page last changed, which is the day the listing was last
   edited — not the day it was created. A row that nothing has touched
   since carries the same date in both columns (the SQL backfills it that
   way), so an untouched listing still reports the truth. Falls back to
   created_at when the column is not there yet. */
function lastmod(row) {
  const d = new Date(stampOf(row));
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------
   changefreq and priority, per room

   They used to be the constants weekly/0.6 on every URL — a claim that
   a compound with one photo and no rent is exactly as likely to change
   as a fully described room whose price moved yesterday, which is not
   true and is why engines ignore both fields when they are constant.
   Both are now derived from one score per room: how recently it changed,
   and how much of the page there is to change. The score itself, its
   bands and the wording of each missing signal are in
   assets/listing-score.js, because the admin dashboard shows the same
   numbers; this file only decides which day to judge (the edit stamp
   above) and how to render the two fields.
   --------------------------------------------------------------- */

/* Everything below is assets/listing-score.js, called through here so the
   sitemap and the admin dashboard cannot publish two different answers
   about the same room — and so a room the dashboard calls "monthly, no
   photo" is exactly the room this sitemap hands the engine as monthly. */
/* The edit stamp, or the creation date where there is no edit stamp. One
   place, so lastmod and the freshness band can never disagree about which
   day they are judging. */
function stampOf(row) { return Score.stampOf(row); }
function completeness(row) { return Score.completeness(row); }
function freshness(row, now) { return Score.freshness(row, now); }
function signals(row, now) { return Score.signals(row, now); }

/* An hour of edge cache with a day of stale-while-revalidate: a traffic
   spike revalidates in the background instead of stampeding PostgREST,
   and a slow database never turns the sitemap itself into a 503 wave. */
const HEAD = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
};

exports.handler = async function () {
  if (!ArzuzListing || !Score) {
    console.error('[listings-sitemap] assets/' +
      (ArzuzListing ? 'listing-score.js' : 'listing-url.js') + ' missing from sandbox');
    return { statusCode: 503, headers: { 'Content-Type': 'text/plain' }, body: 'sitemap temporarily unavailable' };
  }

  let rows;
  try {
    rows = await fetchListings();
  } catch (e) {
    /* 503, not an empty sitemap: see the header comment. */
    console.error('[listings-sitemap]', e && e.message);
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
      body: 'sitemap temporarily unavailable'
    };
  }

  /* One clock for the whole render, so two rooms with the same date cannot
     land in different freshness bands because a millisecond passed. */
  const now = Date.now();
  const urls = rows
    .map(function (row) {
      const p = ArzuzListing.path(row);
      if (!p) return '';
      const mod = lastmod(row);
      const hint = signals(row, now);
      return '  <url>\n' +
        '    <loc>' + xmlEscape(SITE + p) + '</loc>\n' +
        (mod ? '    <lastmod>' + mod + '</lastmod>\n' : '') +
        '    <changefreq>' + hint.changefreq + '</changefreq>\n' +
        '    <priority>' + hint.priority + '</priority>\n' +
        '  </url>';
    })
    .filter(Boolean);

  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    (urls.length ? urls.join('\n') + '\n' : '') +
    '</urlset>\n';

  return { statusCode: 200, headers: HEAD, body: body };
};

/* Exported for scripts/test-rooms.mjs, which pins the derivation itself
   (with an explicit `now`, so the bands can be asserted without depending
   on the day the test is run) as well as the XML it produces. */
exports.signals = signals;
exports.completeness = completeness;
exports.freshness = freshness;
exports.Score = Score;
