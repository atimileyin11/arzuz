/* Regression test for the two functions that give a listing an address:

     netlify/functions/rooms.js            — /rooms/<slug>
     netlify/functions/listings-sitemap.js — /sitemap-listings.xml

   and for the module they both read, assets/listing-url.js.

   Run from arzuz-site/:  node scripts/test-rooms.mjs

   Mocks global.fetch, so no network and no secrets. The two functions are
   eval'd with __dirname pointed at a sandbox holding the files that
   netlify.toml's included_files would put there — which is also what
   proves those files are the ones that need to be listed.

   The checks worth reading twice are the last four: they are the ones that
   stop the page and the sitemap from ever disagreeing about a room's
   address. */
import { readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const PASS = [];
const FAIL = [];
const check = (name, cond, detail) => (cond ? PASS : FAIL).push(name + (cond ? '' : ' :: ' + (detail || '')));

/* ---------------------------------------------------------------
   the fixtures
   --------------------------------------------------------------- */

const ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const fullRow = {
  id: ID,
  tier: 2,
  listed_price_ngn: 250000,
  property_name: 'Sunrise Lodge',
  photo_url: 'https://res.cloudinary.com/demo/old-cover.jpg',
  property_type: 'self-contain',
  area: 'Malete',
  rooms: '1',
  latitude: 8.7265,
  longitude: 4.4895,
  payload: {
    prop_name: 'Sunrise Lodge',
    ty: 'Self-contain',
    rent: 250000,
    ar: 'Malete',
    rm: '1',
    desc: 'A self-contain with a private bathroom and a borehole that runs when the light is off.',
    passage: 'Take the second turning after the gate; the compound is behind the blue kiosk.',
    ut: ['Borehole water', 'Private bathroom', 'Security gate'],
    media: [
      { type: 'image', url: 'https://res.cloudinary.com/demo/photo-1.jpg' },
      { type: 'video', url: 'https://res.cloudinary.com/demo/tour.mp4' },
    ],
  },
};

/* What the sitemap's query returns for the same room — no payload, but the
   generated columns its changefreq/priority are built from. This one is
   COMPLETE on all five signals. The rent was corrected six days after the
   room was registered, so the two dates differ and lastmod has something
   to get right. */
const sitemapRow = {
  id: ID,
  created_at: '2026-10-01T09:12:00.000Z',
  updated_at: '2026-10-07T08:41:00.000Z',
  property_name: 'Sunrise Lodge',
  area: 'Malete',
  photo_url: 'https://res.cloudinary.com/demo/old-cover.jpg',
  property_type: 'self-contain',
  rooms: '1',
  listed_price_ngn: 250000,
  latitude: 8.7265,
  longitude: 4.4895,
  has_description: true,
};

/* A room nobody has touched since it was registered, and a database that
   has never had supabase-listings-updated-at.sql run against it — hence
   the two dates being the same here and the column being absent. It is
   also SPARSE on all five signals: a name and an area and nothing else,
   which is what the completeness half of the score has to notice. */
const untouchedRow = {
  id: 'aaaaaaaa-1111-2222-3333-444455556666',
  created_at: '2026-09-20T07:00:00.000Z',
  property_name: 'Corner Room',
  area: 'Malete',
  photo_url: '',
  property_type: '',
  rooms: '',
  listed_price_ngn: null,
  latitude: null,
  longitude: null,
  has_description: false,
};

/* What a database that predates the generated columns can answer: the two
   fields the slug is built from, and nothing to size a room with. */
const minimalRow = {
  id: ID,
  created_at: '2026-10-01T09:12:00.000Z',
  property_name: 'Sunrise Lodge',
  area: 'Malete',
};

/* A compound with no vacant rooms left. The rent is still known — that is
   the point of the fixture: a full room still has an offer, and the offer
   is what says SoldOut. */
const soldOutRow = {
  ...fullRow,
  id: 'deadbeef-0000-0000-0000-000000000000',
  payload: { ...fullRow.payload, rm: '0' },
};

/* A listing with no price at all: the owner never filled the rent in. */
const noRentRow = {
  ...fullRow,
  id: 'ffffffff-0000-0000-0000-000000000000',
  listed_price_ngn: null,
  photo_url: '',
  payload: { ...fullRow.payload, rent: '', media: [] },
};

const BY_ID = {
  [fullRow.id]: fullRow,
  [soldOutRow.id]: soldOutRow,
  [noRentRow.id]: noRentRow
};

let fetchCalls = [];
let fetchMode = 'ok';
global.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (fetchMode === 'throw') throw new Error('network down');
  if (fetchMode === 'http500') return { ok: false, status: 500, json: async () => [] };
  const idMatch = /id=eq\.([^&]+)/.exec(String(url));
  if (idMatch) {
    const row = BY_ID[decodeURIComponent(idMatch[1])];
    return { ok: true, status: 200, json: async () => (row ? [row] : []) };
  }
  if (/public_listings\?select=/.test(String(url))) {
    /* A database without the edit stamp answers 400 for a SELECT that names
       it — that is the state this repo is in until the SQL is run. And when
       it does answer, the column is not in the rows either: a database
       cannot return a column it does not have, so the mock must not. */
    if (fetchMode === 'noStamp') {
      /* The view from before the edit stamp: it has neither updated_at nor
         has_description. Those two are inseparable — the view that adds one
         selects the other — so there is no state to model in which only
         has_description is present. */
      if (/updated_at|has_description/.test(String(url))) {
        return { ok: false, status: 400, json: async () => ({ message: 'column public_listings.updated_at does not exist' }) };
      }
      const { updated_at: _drop, has_description: _dropDesc, ...oldViewRow } = sitemapRow;
      return { ok: true, status: 200, json: async () => [oldViewRow, untouchedRow] };
    }
    /* A database older still: the generated columns the completeness score
       reads do not exist either, so even the stampless SELECT is a 400 and
       only the slug can be built. */
    if (fetchMode === 'noCols') {
      if (/photo_url|latitude|updated_at/.test(String(url))) {
        return { ok: false, status: 400, json: async () => ({ message: 'column does not exist' }) };
      }
      return { ok: true, status: 200, json: async () => [minimalRow] };
    }
    /* The view the site reads has every generated column, but it has not been
       recreated since has_description was added to the SELECT. */
    if (fetchMode === 'noDesc') {
      if (/has_description/.test(String(url))) {
        return { ok: false, status: 400, json: async () => ({ message: 'column public_listings.has_description does not exist' }) };
      }
      const { has_description: _dropDesc, ...withoutDesc } = sitemapRow;
      return { ok: true, status: 200, json: async () => [withoutDesc, untouchedRow] };
    }
    return { ok: true, status: 200, json: async () => [sitemapRow, untouchedRow] };
  }
  return { ok: true, status: 200, json: async () => [] };
};

/* ---------------------------------------------------------------
   the sandbox — what included_files bundles beside the function
   --------------------------------------------------------------- */

await mkdir('netlify/functions/__rooms_sandbox', { recursive: true });
for (const f of ['listing.html', '404.html']) {
  await copyFile(f, 'netlify/functions/__rooms_sandbox/' + f);
}
await copyFile('assets/listing-url.js', 'netlify/functions/__rooms_sandbox/listing-url.js');
/* The freshness/completeness score is a second shared module now
   (assets/listing-score.js), bundled beside the function by
   netlify.toml's included_files — so the sandbox carries it too. */
await copyFile('assets/listing-score.js', 'netlify/functions/__rooms_sandbox/listing-score.js');

const sandbox = resolve('netlify/functions/__rooms_sandbox');

/* Both functions are read once and eval'd with __dirname pointed at a
   sandbox, the way the other function harness in this repo does it. The
   global fetch is passed in as a parameter so it can be swapped per test. */
const roomsSrc = await readFile('netlify/functions/rooms.js', 'utf8');
const sitemapSrc = await readFile('netlify/functions/listings-sitemap.js', 'utf8');

function load(src, dir) {
  const shim = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', src);
  fn(shim, shim.exports, require, dir, process, global.fetch);
  return shim.exports;
}

const rooms = load(roomsSrc, sandbox).handler;
const sitemapExports = load(sitemapSrc, sandbox);
const sitemap = sitemapExports.handler;

const ArzuzListing = require('../assets/listing-url.js');
const canonicalPath = ArzuzListing.path(fullRow);
const canonicalSlug = ArzuzListing.slug(fullRow);

/* ---------------------------------------------------------------
   1. the canonical address
   --------------------------------------------------------------- */

/* The part of the served page the FUNCTION wrote, between the container it
   fills and the error box after it. Checking the whole document would pass
   on strings that live in listing.html's own script, which is exactly the
   bug this feature exists to fix — the page having content only in script. */
function servedBlock(html) {
  const a = html.indexOf('<div id="ldContent">');
  const b = html.indexOf('<div id="ldError"');
  return a === -1 || b === -1 || b < a ? '' : html.slice(a, b);
}

let res = await rooms({ path: canonicalPath, rawUrl: 'https://arzuz.com' + canonicalPath });
let body = res.body || '';
let block = servedBlock(body);
check('canonical: status 200', res.statusCode === 200, 'got ' + res.statusCode);
check('canonical: content type html', /text\/html/.test(res.headers['Content-Type'] || ''));
check('canonical: the served block is not empty', block.length > 200,
  'nothing was written into the page body');

check('canonical: the h1 is the property name', block.includes('<h1>Sunrise Lodge</h1>'),
  'the room is not in the markup a script-free crawler reads');
check('canonical: the price is in the body', block.includes('\u20A6250,000') && block.includes('per session'));
check('canonical: the badge is in the body', block.includes('Inspected'));
check('canonical: the measured walk is in the body', /min walk to KWASU/.test(block));
check('canonical: the utilities are in the body', block.includes('Borehole water') && block.includes('Security gate'));
check('canonical: the description is in the body', block.includes('borehole that runs when the light is off'));
check('canonical: the passage is in the body', block.includes('behind the blue kiosk'));
check('canonical: a photo is in the body with alt text',
  /<img src="https:\/\/res\.cloudinary\.com\/demo\/photo-1\.jpg" alt="[^"]*Sunrise Lodge[^"]*"/.test(block),
  'no crawlable image, or no alt text describing the room');
check('canonical: the video is not used as the hero image', !block.includes('tour.mp4'),
  'a video URL reached the image slot — cards and hero images must be photos');
check('canonical: the block links on to the rest of the site',
  block.includes('href="/browse"') && block.includes('href="/register"'),
  'the room is a dead end for a crawler — every page has to lead somewhere');
check('canonical: canonical link points at this path',
  body.includes('<link rel="canonical" href="https://arzuz.com' + canonicalPath + '">'));
check('canonical: og:url matches', body.includes('property="og:url" content="https://arzuz.com' + canonicalPath + '"'));
check('canonical: og:image is the first media photo',
  body.includes('property="og:image" content="https://res.cloudinary.com/demo/photo-1.jpg"'));
check('canonical: title rewritten', body.includes('<title>Sunrise Lodge \u2014 Malete | Arzuz</title>'));

/* the two things that make the server block visible without any script */
/* The page is served from /rooms/<slug>, so a relative "assets/…" would be
   requested from /rooms/assets/… — 404, no CSS, no scripts, and nobody but a
   browser would ever notice. This is the check that would have caught it. */
check('canonical: no relative asset URL survives on the nested path',
  !/[="']assets\//.test(body),
  'a relative asset URL resolves to /rooms/assets/… and 404s');
check('canonical: the stylesheet and the scripts are root-absolute',
  body.includes('href="/assets/arzuz.css"') && body.includes('src="/assets/app.js"') &&
  body.includes('src="/assets/listing-url.js"'),
  'the page cannot style itself or boot');

check('canonical: #ldContent is not hidden', !body.includes('<div id="ldContent" style="display:none">'));
check('canonical: #ldContent holds the room', /<div id="ldContent"><div class="gal">[\s\S]*Sunrise Lodge/.test(body));
check('canonical: #ldSkeleton is hidden', body.includes('<div id="ldSkeleton" style="display:none">'));
check('canonical: the id reaches the client', body.includes('window.ARZUZ_LISTING_ID="' + ID + '"'));
check('canonical: the id handoff is before the scripts',
  body.indexOf('window.ARZUZ_LISTING_ID') < body.indexOf('assets/config.js'));
check('canonical: the skeleton element survives (the client hides it by id)',
  body.includes('id="ldSkeleton"') && body.includes('id="ldContent"'));

/* structured data */
const ld = /<script type="application\/ld\+json" id="ldjson">([\s\S]*?)<\/script>/.exec(body);
check('canonical: the ld+json block is still there', !!ld);
if (ld) {
  let parsed = null;
  try {
    parsed = JSON.parse(ld[1]);
  } catch (e) {
    check('canonical: the ld+json block parses', false, e.message);
  }
  if (parsed) {
    check('canonical: the ld+json block parses', true);
    const graph = parsed['@graph'] || [];
    const place = graph.find((n) => n['@type'] === 'Apartment');
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList');
    check('canonical: ld+json describes the apartment', !!place);
    check('canonical: ld+json carries the price and currency',
      !!place && place.offers && place.offers.price === 250000 && place.offers.priceCurrency === 'NGN',
      'no offers node — a listing result needs the price and the old inline version never had one');
    check('canonical: ld+json says InStock for a room with vacancy',
      !!place && place.offers && place.offers.availability === 'https://schema.org/InStock');
    check('canonical: ld+json has the breadcrumb trail', !!crumbs && crumbs.itemListElement.length === 3);
    check('canonical: ld+json does not claim numberOfRooms from vacancy',
      !JSON.stringify(graph).includes('numberOfRooms'));
  }
}

/* ---------------------------------------------------------------
   2. the address was renamed, or never existed
   --------------------------------------------------------------- */

const stale = '/rooms/sunrise-lodge-old-name-' + ID;
res = await rooms({ path: stale, rawUrl: 'https://arzuz.com' + stale });
check('renamed property: 301 to the current address', res.statusCode === 301, 'got ' + res.statusCode);
check('renamed property: lands on the canonical path', res.headers.Location === canonicalPath,
  'sent to ' + res.headers.Location);

const ghost = '/rooms/ghost-room-malete-cccccccc-0000-0000-0000-000000000000';
res = await rooms({ path: ghost, rawUrl: 'x' });
check('a room that is not in the view: 404', res.statusCode === 404, 'got ' + res.statusCode);
check('a room that is not in the view: serves the real 404 page',
  (res.body || '').includes('doesn') && !(res.body || '').includes('id="ldRoot"'),
  'the 404 body is not 404.html — a soft 404 served with a real 404 status still reads as "try again" to a crawler, but the page has to be the 404 page');

res = await rooms({ path: '/rooms/', rawUrl: 'https://arzuz.com/rooms/' });
check('no id in the path: 301 to /browse', res.statusCode === 301 && res.headers.Location.indexOf('/browse') === 0,
  'got ' + res.statusCode + ' → ' + res.headers.Location);

res = await rooms({ path: '/rooms/not-a-uuid-at-all', rawUrl: 'x' });
check('a path with no uuid: 301 to /browse', res.statusCode === 301);

/* ---------------------------------------------------------------
   3. failures degrade, never 500
   --------------------------------------------------------------- */

fetchMode = 'throw';
res = await rooms({ path: canonicalPath, rawUrl: 'x' });
check('database unreachable: 404, not a crash', res.statusCode === 404, 'got ' + res.statusCode);

fetchMode = 'http500';
res = await rooms({ path: canonicalPath, rawUrl: 'x' });
check('database error: 404, not a crash', res.statusCode === 404, 'got ' + res.statusCode);

fetchMode = 'ok';

/* missing page file → bounce to the old page rather than 500. The sandbox
   has the shared module but not the page, so it is the PAGE that is missing
   — the module-missing case is tested separately below. */
await mkdir('netlify/functions/__rooms_nopage', { recursive: true });
await copyFile('assets/listing-url.js', 'netlify/functions/__rooms_nopage/listing-url.js');
const roomsNoPage = load(roomsSrc, resolve('netlify/functions/__rooms_nopage')).handler;
res = await roomsNoPage({ path: canonicalPath, rawUrl: 'https://arzuz.com' + canonicalPath });
check('listing.html missing from the sandbox: 302 to /listing',
  res.statusCode === 302 && res.headers.Location.indexOf('/listing?id=') === 0,
  'got ' + res.statusCode + ' → ' + res.headers.Location);

/* missing shared module → same bounce */
await mkdir('netlify/functions/__rooms_nomodule', { recursive: true });
await copyFile('listing.html', 'netlify/functions/__rooms_nomodule/listing.html');
const roomsNoModule = load(roomsSrc, resolve('netlify/functions/__rooms_nomodule')).handler;
res = await roomsNoModule({ path: '/rooms/anything-' + ID, rawUrl: 'https://arzuz.com/rooms/anything-' + ID + '?a=1' });
check('listing-url.js missing from the sandbox: 302 to /listing',
  res.statusCode === 302 && res.headers.Location.indexOf('/listing') === 0,
  'got ' + res.statusCode + ' → ' + res.headers.Location);

/* ---------------------------------------------------------------
   4. a room with no rent, and a full compound
   --------------------------------------------------------------- */

const sold = ArzuzListing.path(soldOutRow);
res = await rooms({ path: sold, rawUrl: 'x' });
body = res.body || '';
check('full compound: still 200', res.statusCode === 200, 'got ' + res.statusCode);
check('full compound: says 0 vacant, not "0 rooms"', servedBlock(body).includes('0 vacant'));
const ldSold = /<script type="application\/ld\+json" id="ldjson">([\s\S]*?)<\/script>/.exec(body);
check('full compound: availability is SoldOut', !!ldSold && /SoldOut/.test(ldSold[1]),
  'a compound with no rooms left is advertised as InStock — the one field that says it is full');

const noRent = ArzuzListing.path(noRentRow);
res = await rooms({ path: noRent, rawUrl: 'x' });
body = res.body || '';
check('no rent listed: still 200', res.statusCode === 200, 'got ' + res.statusCode);
check('no rent listed: no price row invented', !/<span class="ld-price">/.test(servedBlock(body)),
  'a price element was rendered with no price behind it');
check('no rent listed: the page still says what it is', servedBlock(body).includes('<h1>Sunrise Lodge</h1>'));
const ldNoRent = /<script type="application\/ld\+json" id="ldjson">([\s\S]*?)<\/script>/.exec(body);
check('no rent listed: no offers node (nothing to promise)', !!ldNoRent && !/"offers"/.test(ldNoRent[1]));

/* ---------------------------------------------------------------
   5. the listings sitemap
   --------------------------------------------------------------- */

res = await sitemap({});
body = res.body || '';
check('sitemap: status 200', res.statusCode === 200, 'got ' + res.statusCode);
check('sitemap: xml content type', /application\/xml/.test(res.headers['Content-Type'] || ''));
check('sitemap: is a urlset', body.indexOf('<?xml') === 0 && body.includes('<urlset') && body.includes('</urlset>'));
check('sitemap: lists the listing at its canonical address',
  body.includes('<loc>https://arzuz.com' + canonicalPath + '</loc>'));
check('sitemap: no raw ampersands', !/&(?!(amp|lt|gt|quot|apos);)/.test(body));

/* THE POINT OF THE EDIT STAMP. lastmod is the one field Google reads here,
   and it reads it only while it stays true; a sitemap that reports every
   room as unchanged is what stops the pages that DID change being crawled. */
const urlBlock = (hay, path) => {
  const at = hay.indexOf('<loc>https://arzuz.com' + path + '</loc>');
  return at === -1 ? '' : hay.slice(hay.lastIndexOf('<url>', at), hay.indexOf('</url>', at));
};
const edited = urlBlock(body, canonicalPath);
check('sitemap: lastmod is the last EDIT, not the day the room was registered',
  edited.includes('<lastmod>2026-10-07</lastmod>'),
  'the room was edited on 2026-10-07 and the sitemap says ' + (edited.match(/<lastmod>[^<]*/) || ['nothing'])[0]);
check('sitemap: and it no longer reports the registration date',
  !edited.includes('2026-10-01'),
  'a listing whose rent moved is advertised as unchanged since it was created');
const untouched = urlBlock(body, ArzuzListing.path(untouchedRow));
check('sitemap: a room nothing has touched still carries the day it was created',
  untouched.includes('<lastmod>2026-09-20</lastmod>'),
  'the backfill gives an untouched row created_at, so reporting it is the truth, not a guess');

/* ---------------------------------------------------------------
   changefreq and priority are per room now
   --------------------------------------------------------------- */

/* The 2×2 that proves BOTH halves of the score are load-bearing: a complete
   room edited today cannot land on the same answer as a sparse one nobody
   has touched, and the two off-diagonal cases do not collapse onto either.
   The clock is passed in explicitly so these are the same every day the
   suite runs. */
const NOW = Date.parse('2026-10-14T00:00:00.000Z');
const sig = (row) => sitemapExports.signals(row, NOW);
const fresh = (row) => ({ ...row, created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z' });
const old = (row) => ({ ...row, created_at: '2024-10-13T00:00:00.000Z', updated_at: '2024-10-13T00:00:00.000Z' });
const sparse = (row) => ({ ...row, photo_url: '', property_type: '', rooms: '', listed_price_ngn: null, latitude: null, longitude: null, has_description: false });

check('signals: a complete, just-edited room is daily/0.9',
  sig(fresh(sitemapRow)).changefreq === 'daily' && sig(fresh(sitemapRow)).priority === '0.9',
  JSON.stringify(sig(fresh(sitemapRow))));
check('signals: a complete but two-year-old room drops to weekly/0.7',
  sig(old(sitemapRow)).changefreq === 'weekly' && sig(old(sitemapRow)).priority === '0.7',
  JSON.stringify(sig(old(sitemapRow))));
check('signals: a sparse room that was just touched is only monthly/0.5',
  sig(fresh(sparse(sitemapRow))).changefreq === 'monthly' && sig(fresh(sparse(sitemapRow))).priority === '0.5',
  JSON.stringify(sig(fresh(sparse(sitemapRow)))));
check('signals: sparse and old is the floor — yearly/0.3',
  sig(old(sparse(sitemapRow))).changefreq === 'yearly' && sig(old(sparse(sitemapRow))).priority === '0.3',
  JSON.stringify(sig(old(sparse(sitemapRow)))));

check('signals: each of the six completeness signals moves the score',
  ['listed_price_ngn', 'photo_url', 'latitude', 'property_type', 'rooms', 'has_description'].every(
    (drop) => sitemapExports.completeness({ ...sitemapRow, [drop]: null }) === 5 / 6),
  'a room missing one signal was still scored complete — the derivation ignores it');
check('signals: a room with no description cannot reach the very top',
  sitemapExports.completeness({ ...sitemapRow, has_description: false }) === 5 / 6);
check('signals: the fields every listing has are not counted',
  sitemapExports.completeness({ ...sitemapRow, property_name: '', area: '' }) === 1,
  'property_name/area would raise the floor without separating any two rooms');

/* ONE score, TWO readers. The dashboard's Crawl column and this sitemap's
   <changefreq>/<priority> have to be the same numbers out of the same
   code — otherwise an owner is shown "weekly, the photo is missing"
   while the engine is told something else, and neither screen looks
   wrong on its own. */
const Score = sitemapExports.Score;
check('the sitemap sizes rooms with the shared scorer, not a copy of it',
  /loadFromAssets\('listing-score\.js'\)/.test(sitemapSrc) &&
  !/COMPLETENESS_SIGNALS|WEIGHT_FRESHNESS|FRESHNESS_WINDOW_DAYS/.test(sitemapSrc) &&
  Score.VERSION === require('../assets/listing-score.js').VERSION,
  'listings-sitemap.js is doing its own arithmetic again');

const adminSrc = await readFile('assets/admin.js', 'utf8');
const adminHtml = await readFile('admin.html', 'utf8');
const toml = await readFile('netlify.toml', 'utf8');
check('the dashboard reads that same module, not a second score',
  /ArzuzListingScore/.test(adminSrc) && /assets\/listing-score\.js/.test(adminHtml),
  'admin.js / admin.html do not load assets/listing-score.js');
check('and the deploy bundles it beside the function',
  /assets\/listing-score\.js/.test(toml),
  'included_files is missing assets/listing-score.js — the sitemap would answer 503 in the deploy');

/* What "what to fill in" says, in both directions: a complete room has
   nothing left to fill in, and a sparse one names all six facts in the
   words the dashboard prints. */
check('a complete room has nothing left to fill in',
  Score.missing(sitemapRow).length === 0, JSON.stringify(Score.missing(sitemapRow)));
check('a sparse room names every missing fact, for the owner to act on',
  Score.missing(untouchedRow).length === 6, JSON.stringify(Score.missing(untouchedRow)));

/* The dashboard reads the BASE table, which has no has_description column
   — the view computes it. So the scorer has to read the payload for those
   rows, and must still respect the view's own answer when it has one. */
check('the description is read from the payload when the row has no flag',
  Score.hasDescription({ payload: { desc: 'x' } }) === true &&
  Score.hasDescription({ payload: { description: 'x' } }) === true &&
  Score.hasDescription({ payload: {} }) === false,
  'a dashboard row with a description scored as having none, or vice versa');
check('and the view\u2019s own flag wins when the row carries one',
  Score.hasDescription({ has_description: false, payload: { desc: 'x' } }) === false,
  'a row the view says has no description was counted as having one');

/* THE DRAFT SHAPE. A listing is stored once and read in three places, and
   they do not carry the same columns: the base table, the public view, and
   a DRAFT — which has nothing but a payload and a couple of stamps
   (supabase-drafts-support.sql's listing_draft_get). The invite-link page
   scores a room BEFORE it is live, so the module has to read the six facts
   out of the payload under the keys the landlord form writes
   (assets/complete-listing.js's collectPatch). */
const draftPayload = {
  rent: '250000',
  photo: 'https://res.cloudinary.com/demo/cover.jpg',
  lat: '8.7265', lng: '4.4895',
  ty: 'Self-contain', rm: '1',
  desc: 'A self-contain with a private bathroom.'
};
check('a draft — a payload and nothing else — scores on all six facts',
  Score.completeness({ payload: draftPayload }) === 1,
  JSON.stringify(Score.missing({ payload: draftPayload })));
check('and each fact is found under the key the landlord form writes',
  Score.missing({ payload: {} }).length === 6 &&
  Score.missing({ payload: { rent: '1' } }).length === 5 &&
  Score.missing({ payload: { photo: 'x' } }).length === 5 &&
  Score.missing({ payload: { ty: 'Self-contain' } }).length === 5 &&
  Score.missing({ payload: { rm: '1' } }).length === 5 &&
  Score.missing({ payload: { desc: 'x' } }).length === 5,
  'a draft fact is not read from the payload: ' +
    JSON.stringify(Score.missing({ payload: { rent: '1' } })));
check('and half a pin in the payload is not a pin',
  Score.pinFrom({ payload: { lat: '8.7' } }) === false &&
  Score.pinFrom({ payload: { lat: '8.7', lng: '4.4' } }) === true &&
  Score.pinFrom({}) === false,
  'a latitude with no longitude read as a map pin');
check('and a row’s own column still wins over its payload',
  Score.completeness({ listed_price_ngn: 250000, payload: {} }) === 1 / 6 &&
  Score.completeness({ listed_price_ngn: 0, payload: { rent: '250000' } }) === 0,
  'the generated column and the payload it is derived from disagreed — ' +
    'the column is what the sitemap and the dashboard read, so it decides');
check('and the empty draft lands where the sitemap puts a sparse fresh room',
  Score.signals({ payload: {}, updated_at: new Date(NOW).toISOString() }, NOW).changefreq === 'monthly',
  'an empty draft is not the floor of the score: ' +
    JSON.stringify(Score.signals({ payload: {}, updated_at: new Date(NOW).toISOString() }, NOW)));

/* and the integration, on the XML the function actually writes */
const priorityOf = (block) => Number((block.match(/<priority>([\d.]+)<\/priority>/) || [])[1]);
check('sitemap: the complete room outranks the sparse one',
  priorityOf(edited) > priorityOf(untouched) && priorityOf(untouched) > 0,
  'complete ' + priorityOf(edited) + ' vs sparse ' + priorityOf(untouched));
check('sitemap: this room no longer ships the constant weekly/0.6',
  !(edited.includes('<changefreq>weekly</changefreq>') && edited.includes('<priority>0.6</priority>')),
  'the same hint every room got before is still going out');
check('sitemap: both hints are inside the protocol\u2019s vocabulary',
  /^0\.[3-9]$/.test(String(priorityOf(edited))) &&
  ['daily', 'weekly', 'monthly', 'yearly'].includes((edited.match(/<changefreq>([a-z]+)</) || [])[1]),
  'edited block: ' + edited);

/* A 503 rather than an empty urlset: an empty sitemap is read as "these
   pages are gone", and a search engine will believe it. */
fetchMode = 'throw';
res = await sitemap({});
check('sitemap: database unreachable → 503', res.statusCode === 503, 'got ' + res.statusCode);
fetchMode = 'http500';
res = await sitemap({});
check('sitemap: database error → 503', res.statusCode === 503, 'got ' + res.statusCode);
fetchMode = 'ok';

/* the query is the light one: ids, names and areas, no payloads */
const listingQuery = fetchCalls.find((u) => u.includes('public_listings') && !u.includes('id=eq.'));
check('sitemap: asks for generated columns, never payloads',
  !!listingQuery && !/payload/.test(listingQuery) && /order=created_at\.desc/.test(listingQuery),
  'the sitemap query is ' + listingQuery);

/* the query has to ASK for the stamp, or the fallback in lastmod() is all
   that ever ships and the sitemap keeps overstating how fresh a room is */
check('sitemap: the light query names updated_at',
  /select=[^&]*updated_at/.test(listingQuery || ''),
  'the sitemap query is ' + listingQuery);

/* and on a database that predates supabase-listings-updated-at.sql the
   sitemap still answers — with the older, honest date rather than a 503
   that would tell the engines every room is gone. */
fetchCalls = [];
fetchMode = 'noStamp';
res = await sitemap({});
let noStampBody = res.body || '';
check('sitemap: a database with no updated_at column still serves a sitemap',
  res.statusCode === 200, 'got ' + res.statusCode);
check('sitemap: and reports the date it does have',
  noStampBody.includes('<lastmod>2026-10-01</lastmod>'),
  'the pre-SQL fallback dropped the date instead of falling back to created_at');
check('sitemap: it steps past both missing columns in one descent',
  fetchCalls.filter((u) => u.includes('public_listings')).length === 3 &&
  !/updated_at|has_description/.test(fetchCalls[fetchCalls.length - 1]),
  'asked public_listings ' + fetchCalls.filter((u) => u.includes('public_listings')).length + ' times: ' +
  JSON.stringify(fetchCalls.filter((u) => u.includes('public_listings'))));
fetchMode = 'ok';

/* and a database older still — the generated columns the completeness score
   reads are missing too, so even the stampless SELECT is a 400. The sitemap
   steps down a third time rather than 503, sizes every room the same, and
   says so in its own log. */
fetchCalls = [];
fetchMode = 'noCols';
res = await sitemap({});
const noColsBody = res.body || '';
check('sitemap: a database with none of the sizing columns still serves a sitemap',
  res.statusCode === 200 && noColsBody.includes('<lastmod>2026-10-01</lastmod>'),
  'got ' + res.statusCode);
check('sitemap: it steps down one SELECT at a time, and stops at four',
  fetchCalls.filter((u) => u.includes('public_listings')).length === 4 &&
  /select=id,created_at,property_name,area&/.test(fetchCalls[fetchCalls.length - 1]),
  'asked public_listings ' +
  fetchCalls.filter((u) => u.includes('public_listings')).length + ' times: ' +
  JSON.stringify(fetchCalls.filter((u) => u.includes('public_listings'))));
fetchMode = 'ok';

/* and the state the site is in the day the description signal ships: the
   view has every generated column but has not been recreated yet, so only
   has_description is missing. That one column is dropped, not the whole
   completeness score. */
fetchCalls = [];
fetchMode = 'noDesc';
res = await sitemap({});
const noDescBody = res.body || '';
const noDescQueries = fetchCalls.filter((u) => u.includes('public_listings'));
check('sitemap: a view without has_description still serves a sitemap',
  res.statusCode === 200 && noDescBody.includes('<lastmod>2026-10-07</lastmod>'),
  'got ' + res.statusCode);
check('sitemap: and drops only that column, keeping the edit stamp',
  noDescQueries.length === 2 &&
  /updated_at/.test(noDescQueries[noDescQueries.length - 1]) &&
  !/has_description/.test(noDescQueries[noDescQueries.length - 1]),
  'asked public_listings ' + noDescQueries.length + ' times: ' + JSON.stringify(noDescQueries));
check('sitemap: and still sizes the rooms it can',
  /<priority>0\.[3-9]<\/priority>/.test(noDescBody));
check('sitemap: and it still emits both hints',
  /<changefreq>(daily|weekly|monthly|yearly)<\/changefreq>/.test(noColsBody) &&
  /<priority>0\.[3-9]<\/priority>/.test(noColsBody),
  'the degraded sitemap dropped changefreq/priority entirely');
fetchMode = 'ok';

/* ---------------------------------------------------------------
   6. the page and the sitemap must never disagree about an address
   --------------------------------------------------------------- */

const fromFull = ArzuzListing.path(fullRow);
const fromSitemap = ArzuzListing.path(sitemapRow);
check('the same room gets one address from the page row and the sitemap row',
  fromFull === fromSitemap,
  'page built ' + fromFull + ' and the sitemap built ' + fromSitemap);

check('the slug ends with the id, so it resolves without the readable part',
  new RegExp(ID + '$').test(canonicalSlug) && ArzuzListing.idFromPath(canonicalPath) === ID);

check('a slug with no name still resolves',
  ArzuzListing.idFromPath('/rooms/room-malete-' + ID) === ID);

check('a path that merely contains a uuid is not a listing path',
  ArzuzListing.idFromPath('/rooms/' + ID + '/edit') === '',
  'only the LAST segment, ending in the id, may resolve — otherwise any uuid anywhere in a path would be treated as a room');

/* the campus pin, which the map and the walk both measure from */
const mapSrc = await readFile('assets/arzuz-map.js', 'utf8');
const mapCampus = /CAMPUS\s*=\s*\{\s*lat:\s*([\d.]+)\s*,\s*lng:\s*([\d.]+)\s*\}/.exec(mapSrc);
check('assets/arzuz-map.js still declares a campus pin', !!mapCampus);
check('the map and the listing page measure from the same gate',
  !!mapCampus && Number(mapCampus[1]) === ArzuzListing.CAMPUS.lat && Number(mapCampus[2]) === ArzuzListing.CAMPUS.lng,
  'arzuz-map.js says ' + (mapCampus ? mapCampus[1] + ',' + mapCampus[2] : 'nothing') +
  ' and listing-url.js says ' + ArzuzListing.CAMPUS.lat + ',' + ArzuzListing.CAMPUS.lng +
  ' — the map and the walk would point at different places');

/* ---------------------------------------------------------------
   report
   --------------------------------------------------------------- */

for (const dir of ['__rooms_sandbox', '__rooms_nopage', '__rooms_nomodule']) {
  await rm('netlify/functions/' + dir, { recursive: true, force: true });
}

console.log('\nPASS: ' + PASS.length);
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
PASS.forEach((p) => console.log('  \u2713 ' + p));
console.log('ALL HARNESS CHECKS PASSED');
