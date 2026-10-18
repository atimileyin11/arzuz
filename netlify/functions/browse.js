/* ============================================================
   Arzuz — Netlify Function: the browse board, rendered by the server

   /browse is the page that gets a room found. Every listing has had its
   own address since netlify/functions/rooms.js, and sitemap-listings.xml
   lists them all — but the board itself drew its cards in the browser,
   so the links a crawler follows to reach a room existed only in
   JavaScript. A sitemap tells a search engine a URL exists; a LINK is
   how it decides the page is part of the site.

   The board is now rendered HERE, in full. browse.html fetches nothing:
   the cards arrive with the document, the page's script is down to the
   shared header and footer, and there is one renderer of a room (this
   one) instead of a server copy for crawlers and a browser copy for
   people. That also removes the page's last Supabase request.

   Routing (netlify.toml): /browse → this function, status 200.

   WHAT IT DEGRADES TO
     · The database cannot be read → the board line is replaced with
       "listings are warming up" and the way to register. /browse must
       never answer 503 because Supabase blinked: it is the one page
       whose whole job is to be reachable.
     · No rows at all → the page is served exactly as it is on disk. Its
       own holder line already says the honest empty state ("no verified
       listings yet" plus the two doors), so there is nothing to swap in.
     · browse.html or its marker missing from the bundle → 503 with a
       short page and never a redirect. /browse.html answers a 301 back
       to /browse, so a bounce would loop.

   lastmod, the room order and the URL of each room are all decided by
   other files: assets/browse-card.js writes the markup, assets/listing-url.js
   the address and the walk, and public_listings the set (active, tier 1+,
   production — the same three conditions the rest of the site reads).
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');

/* The card markup lives with the other shared rules in assets/, and is
   required STATICALLY so Netlify's bundler picks it up (the same way
   paystack-webhook.js requires assets/api-errors.js). Its own two
   requires — listing-url.js and api-errors.js — come with it, which is
   why only the PAGE still has to be named in netlify.toml's
   included_files: a require is bundled, a readFileSync is not. */
const ArzuzBrowseCard = require('../../assets/browse-card.js');

const SITE = 'https://arzuz.com';

/* The board is a page, so it asks for the whole row — payload included.
   The payload is where the utilities, the media and the MEASURED walking
   route live, and it is what the browser used to fetch, so this is not a
   wider query than the one it replaces. */
const SELECT = '*';
const LIMIT = 500;

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* ---------- reading the page ---------- */

/* Where browse.html lands differs between the repo and the deploy, so
   every layout is tried, exactly as rooms.js does it. */
const PAGE_DIRS = [
  __dirname,
  path.join(__dirname, '..', '..'),
  '/var/task',
  process.cwd()
];

function stripBom(html) {
  return html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
}

function readPage() {
  for (const dir of PAGE_DIRS) {
    for (const rel of ['browse.html', path.join('..', '..', 'browse.html')]) {
      try {
        return stripBom(fs.readFileSync(path.join(dir, rel), 'utf8'));
      } catch (e) { /* try the next layout */ }
    }
  }
  return '';
}

/* ---------- the data ---------- */

async function fetchListings() {
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listings?select=' + SELECT +
    '&order=created_at.desc&limit=' + LIMIT;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('public_listings answered HTTP ' + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('public_listings did not return an array');
  return rows;
}

/* What the visits actually checked. A second query rather than a column
   on public_listings: the view is the public read surface and this is a
   one-to-many record, so folding it in would either fan the listing rows
   out or force an aggregate nobody else needs. Grouped here, so a card
   receives its own visit and never a neighbour's check.

   4000 is the ceiling, not a promise: eight checks on each of 500
   listings. More than that is a page nobody scrolls, and the badge says
   "Inspected" without parts rather than inventing them when it is cut. */
async function fetchChecks() {
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listing_checks?select=listing_id,visit_id,kind,detail,checked_at,expires_at' +
    '&order=checked_at.desc&limit=4000';
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('public_listing_checks answered HTTP ' + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('public_listing_checks did not return an array');
  const byListing = {};
  for (const row of rows) {
    if (!row || !row.listing_id) continue;
    (byListing[row.listing_id] = byListing[row.listing_id] || []).push(row);
  }
  return byListing;
}

/* ---------- the handler ---------- */

/* A minute, not five: the board is where a student looks first, and a
   room that was taken down an hour ago is worse than a slightly busier
   function. stale-while-revalidate keeps the re-render off the critical
   path for whoever arrives first after it expires. */
const HEAD = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=600'
};

/* The page minus its own dependency. Not a redirect — see the header. */
function unavailablePage() {
  return {
    statusCode: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>The listing board is temporarily unavailable | Arzuz</title>' +
      '<meta name="robots" content="noindex">' +
      '<link rel="stylesheet" href="/assets/arzuz.css"></head><body>' +
      '<div class="bw"><h1>We cannot show the board this second</h1>' +
      '<p>That is our side, not yours. Try again in a minute, or ' +
      '<a href="/register">tell us what you need</a> and we will match you on WhatsApp. ' +
      'Have a property? <a href="/list">List it free</a>.</p></div></body></html>'
  };
}

exports.handler = async function () {
  const page = readPage();
  if (!page) {
    console.error('[browse] browse.html missing from the function bundle');
    return unavailablePage();
  }

  /* The holder line is found by its marker. A page that has lost it is
     served unmodified rather than half-rewritten — the fallback state it
     ships with is honest, so this degrades instead of breaking. */
  if (page.indexOf(ArzuzBrowseCard.MARKER) === -1) {
    console.error('[browse] browse.html has no board marker — serving the page as it is');
    return { statusCode: 200, headers: HEAD, body: page };
  }

  let rows;
  try {
    rows = await fetchListings();
  } catch (e) {
    console.warn('[browse] the board could not be read:', e && e.message);
    const apologetic = ArzuzBrowseCard.fill(page, ArzuzBrowseCard.unavailable());
    return { statusCode: 200, headers: HEAD, body: apologetic || page };
  }

  /* The evidence is a SECOND read, and a failure of it must not take the
     board down: `null` means "not read", which the badge renders as
     "Inspected" with no claim about what was seen — never as "there is
     no record". The rooms are the page; the checks are the footnote. */
  let checks = null;
  try {
    checks = await fetchChecks();
  } catch (e) {
    console.warn('[browse] the visit evidence could not be read:', e && e.message);
  }

  /* No rooms is not an error and there is nothing to draw: the page's own
     holder line IS the empty state. */
  const html = ArzuzBrowseCard.board(rows, checks);
  if (!html) return { statusCode: 200, headers: HEAD, body: page };

  return { statusCode: 200, headers: HEAD, body: ArzuzBrowseCard.fill(page, html) };
};

/* Exported for scripts/test-browse.mjs. */
exports.SELECT = SELECT;
exports.SITE = SITE;
exports.fetchChecks = fetchChecks;
