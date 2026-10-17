#!/usr/bin/env node
/* ============================================================
   Arzuz — the SEO guard

   The site was live, fast and correct, and none of it was indexed.
   The reason was not a missing meta tag. It was that five of the
   pages a visitor can reach had no text in the HTML at all: the
   form, the listing cards and the building page were drawn by
   assets/app.js after load, so the document a crawler fetched held
   one empty <div>. A page with no heading and no words does not
   get indexed, however good it looks in a browser.

   This file is what stops that coming back. It reads the files on
   disk — no network, no secrets — and asserts the properties that
   make a page indexable, in the order that matters:

     1. every public page has a real <h1> and real text with
        JavaScript switched off, a title, a description, and a
        canonical that points at itself
     2. every internal link is the canonical, extension-less URL,
        so a page has one address instead of three
     3. sitemap.xml and the canonicals agree, both ways
     4. every .html duplicate answers a 301 to its canonical
     5. the structured data parses, and the homepage names the
        organisation rather than promising a site search that does
        not exist
     6. the IndexNow key file is where the engines will look for it
     7. the footer still links the pages that need to be found —
        a crawler reaches a page by following a link to it

   Run from arzuz-site/:
     node scripts/test-seo.mjs
   ============================================================ */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://arzuz.com';
const PASS = [];
const FAIL = [];
const check = (name, ok, note) => (ok ? PASS : FAIL).push(name + (ok || !note ? '' : '  ::  ' + note));

const read = (f) => readFileSync(join(SITE, f), 'utf8');

/* ---------------------------------------------------------------
   the public pages: one address each, and the file that serves it
   --------------------------------------------------------------- */

/* Pages deliberately NOT here:
   · admin.html, complete-listing.html, my-care.html — noindex by
     header, private, and their absence from the sitemap is checked by
     scripts/test-deploy-guards.mjs
   · 404.html — noindex, served at every missing path
   · listing.html — the canonical is /listing, but a listing needs an
     ?id=, so there is no one URL to canonicalise. Individual listings
     are reached through the links on /browse. */
const PUBLIC = [
  { file: 'index.html', path: '/' },
  { file: 'browse.html', path: '/browse' },
  { file: 'register.html', path: '/register' },
  { file: 'owner-list.html', path: '/list' },
  { file: 'scout.html', path: '/my-building' },
  { file: 'roommates.html', path: '/roommates' },
  { file: 'rent-in-malete.html', path: '/rent-in-malete' },
  { file: 'hostels-near-kwasu.html', path: '/hostels-near-kwasu' },
  { file: 'care.html', path: '/care' },
  { file: 'care-pass.html', path: '/care-pass' },
  { file: 'safety.html', path: '/safety' },
  { file: 'privacy.html', path: '/privacy' },
  { file: 'terms.html', path: '/terms' }
];

const CANONICAL_OF = Object.fromEntries(PUBLIC.map((p) => [p.file, p.path]));

/* ---------------------------------------------------------------
   helpers
   --------------------------------------------------------------- */

/* What a crawler that runs no script sees, minus the <head>: strip the
   scripts, styles and comments, then the tags, then collapse space. */
function staticText(html) {
  const body = html.slice(Math.max(html.search(/<body[^>]*>/i), 0));
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const one = (html, re) => {
  const m = html.match(re);
  return m ? m[1].trim() : '';
};

/* ---------------------------------------------------------------
   1. every public page is a page, with the script switched off
   --------------------------------------------------------------- */

const MIN_TEXT = 600;

for (const { file, path } of PUBLIC) {
  if (!existsSync(join(SITE, file))) {
    check(file + ' exists', false, 'the file this table names is not on disk');
    continue;
  }
  const html = read(file);
  const text = staticText(html);

  const h1s = html.match(/<h1[\s>]/gi) || [];
  check(file + ' has exactly one <h1>', h1s.length === 1, h1s.length + ' found — a page needs one heading, and it is what a crawler reads first');

  check(file + ' has text before any script runs (' + text.length + ' chars)',
    text.length >= MIN_TEXT,
    text.length + ' chars of real text — under ' + MIN_TEXT + ' means the page is drawn by JavaScript and a crawler fetches an empty document, which is what kept this site out of the index');

  const title = one(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  check(file + ' has a title', title.length > 0, 'no <title>');
  check(file + ' title is not truncated (' + title.length + ')', title.length <= 70, 'longer than a result snippet will show');

  const desc = one(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i);
  check(file + ' has a meta description', desc.length > 0, 'no description — a search engine will invent one from whatever it finds');
  check(file + ' description is snippet-sized (' + desc.length + ')', desc.length > 0 && desc.length <= 170, 'over 170 characters, so it will be cut mid-sentence');

  const canonical = one(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i);
  check(file + ' sets its own canonical', canonical === ORIGIN + path,
    canonical ? 'canonical is ' + canonical + ', expected ' + ORIGIN + path : 'no canonical link');

  const robots = one(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)/i);
  check(file + ' is not noindexed', !/noindex/i.test(robots), 'meta robots says "' + robots + '" on an indexable page');

  /* The bug this catches, which is invisible on disk and only shows up in a
     browser: the form engine's step question is an <h2 class="qh">, and
     Arzuz.form() overwrites #form. An <h1> placed inside #form therefore
     survives in the file and vanishes from the rendered document — leaving
     a page with no heading at all in the DOM a JS-rendering crawler reads.
     The page's own heading has to sit outside the container the form
     engine owns, which is why the markup puts it above #form. */
  const formAt = html.indexOf('id="form"');
  const h1At = html.search(/<h1[\s>]/i);
  if (formAt !== -1) {
    check(file + ' heading survives the form draw', h1At !== -1 && h1At < formAt,
      'the <h1> sits inside #form, which Arzuz.form() overwrites — the rendered page ends up with no heading');
  }

  const blocks = (html.match(/<(p|li)[\s>]/gi) || []).length;
  check(file + ' has real prose, not one line', blocks >= 3, blocks + ' paragraph/item blocks');

  /* a crawler gets from here to the rest of the site by following a link */
  const internal = [...html.matchAll(/href=["'](\/[^"'#?]*)/g)].map((m) => m[1]);
  check(file + ' links at least one other page from its own HTML', internal.length >= 1,
    'no static internal links — with the script off this page is a dead end');
}

/* ---------------------------------------------------------------
   2. one address per page
   --------------------------------------------------------------- */

/* The bug this catches: /register.html and /register are both served, so
   the page answers on two URLs, splits its own signals between them and
   spends crawl budget twice. The canonical says which one counts; this
   asserts nothing links at the loser. */
/* 404.html is in here on purpose even though it is noindex: it is the one
   page a lost crawler is guaranteed to land on, so its links are the ones
   that matter most. It was the last page still pointing at .html copies. */
const LINK_SCAN = [...PUBLIC.map((p) => p.file), '404.html', 'listing.html', 'assets/app.js', 'assets/roommate.js', 'assets/my-care.js'];

for (const f of LINK_SCAN) {
  const src = read(f);
  const bad = [...src.matchAll(/href=["']\/?[A-Za-z0-9._-]+\.html|backHref:\s*["'][A-Za-z0-9._-]+\.html/g)]
    .map((m) => m[0]);
  check(f + ' links canonical URLs, not .html duplicates', bad.length === 0,
    'found ' + bad.slice(0, 4).join(', ') + ' — every internal link must use the extension-less URL that is in the canonical tag and the sitemap');
}

/* ---------------------------------------------------------------
   3. the sitemap and the canonicals agree, both ways
   --------------------------------------------------------------- */

const sitemap = read('sitemap.xml');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
const sitemapPaths = locs.map((l) => {
  try { return new URL(l).pathname; } catch { return l; }
});

for (const { path } of PUBLIC) {
  const table = { '/': 'index.html' };
  const expected = path;
  check('sitemap.xml lists ' + expected, sitemapPaths.includes(expected),
    'a page whose canonical is ' + expected + ' is missing from the sitemap, so nothing tells a search engine it exists');
}

for (const p of sitemapPaths) {
  const known = PUBLIC.some((x) => x.path === p);
  check('sitemap entry ' + p + ' is a canonical page', known,
    'this URL is in the sitemap but is not a page canonical — a sitemap that disagrees with the canonicals makes them compete');
}

check('sitemap.xml declares lastmod on every URL',
  (sitemap.match(/<lastmod>/g) || []).length === locs.length,
  'lastmod is the only field Google reads here, and only while it stays accurate');

/* ---------------------------------------------------------------
   4. every .html duplicate answers a 301 to its canonical
   --------------------------------------------------------------- */

const toml = read('netlify.toml');
const REDIRECTS = toml.split('[[redirects]]').slice(1).map((block) => ({
  from: (block.match(/^\s*from\s*=\s*"([^"]+)"/m) || [])[1],
  to: (block.match(/^\s*to\s*=\s*"([^"]+)"/m) || [])[1],
  status: Number((block.match(/^\s*status\s*=\s*(\d+)/m) || [])[1] || 200),
  force: /^\s*force\s*=\s*true/m.test(block)
})).filter((r) => r.from && r.to);

const servedClean = new Set(REDIRECTS.filter((r) => r.status === 200).map((r) => r.from));
const redirected = new Map(REDIRECTS.filter((r) => r.status === 301).map((r) => [r.from, r]));

for (const { file, path } of PUBLIC) {
  const rule = redirected.get('/' + file);
  check('/' + file + ' 301s to ' + path, !!rule && rule.to === path,
    rule ? 'it redirects to ' + rule.to + ' instead' : 'no 301 — the duplicate stays live and competes with the canonical');
  if (rule) {
    check('/' + file + ' redirect is forced', rule.force,
      'without force = true Netlify serves the real file and never applies the rule');
  }
}

/* the two legacy addresses the home page used to link */
for (const [from, to] of [['/owner-list', '/list'], ['/scout', '/my-building']]) {
  const rule = redirected.get(from);
  check(from + ' 301s to ' + to, !!rule && rule.to === to,
    rule ? 'it goes to ' + rule.to : 'this URL answers 200 today and is a second address for the same page');
}

/* no redirect chains: a 301 target must be served, not redirected again */
for (const [from, rule] of redirected) {
  check('301 ' + from + ' → ' + rule.to + ' lands, not redirects again',
    rule.to === '/' || servedClean.has(rule.to),
    'the target is itself a redirect — a chain wastes a hop and some crawlers stop at two');
}

/* ---------------------------------------------------------------
   5. structured data
   --------------------------------------------------------------- */

for (const f of readdirSync(SITE).filter((f) => f.endsWith('.html'))) {
  const html = read(f);
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let parsed = null;
  try {
    parsed = blocks.map((b) => JSON.parse(b[1]));
  } catch (e) {
    check(f + ' structured data parses', false, 'invalid JSON in an ld+json block: ' + e.message);
  }
  if (blocks.length && parsed) check(f + ' structured data parses', true);

  if (f === 'index.html') {
    const graph = (parsed || []).flatMap((b) => b['@graph'] || [b]);
    const types = graph.map((n) => n['@type']);
    check('index.html names the organisation', types.includes('Organization'),
      'no Organization node — an answer engine has nothing to cite about who publishes this site');
    check('index.html still declares the WebSite', types.includes('WebSite'), 'the WebSite node is gone');
    check('index.html does not promise a site search',
      !JSON.stringify(graph).includes('SearchAction'),
      'a SearchAction points at /register, which is not a search — Google reports it as an error on a new property');
  }
}

/* ---------------------------------------------------------------
   5b. a listing has an address of its own
   --------------------------------------------------------------- */

/* A listing used to live at /listing?id=<uuid>: a query string, which is not
   an address a search engine will index for a room, and a page whose content
   only existed in JavaScript. It now lives at /rooms/<slug>, served with the
   room already in the HTML, and the listings are listed in a sitemap built
   from the database. This is what checks the wiring is all still there. */
const nf = (p) => '/.netlify/functions/' + p;

check('netlify.toml serves /rooms/* from a function',
  REDIRECTS.some((r) => r.from === '/rooms/*' && r.to === nf('rooms') && r.status === 200),
  'without this route there is no /rooms/<slug> at all');
check('netlify.toml serves the listings sitemap from a function',
  REDIRECTS.some((r) => r.from === '/sitemap-listings.xml' && r.to === nf('listings-sitemap') && r.status === 200),
  'the listing half of the sitemap is not wired up');
check('the /rooms function exists', existsSync(join(SITE, 'netlify/functions/rooms.js')));
check('the listings sitemap function exists', existsSync(join(SITE, 'netlify/functions/listings-sitemap.js')));

/* /browse is the page that LINKS a room. A sitemap tells an engine a URL
   exists; the board is how it decides the listing is part of the site. The
   cards were drawn by JavaScript until this function existed, so the link a
   crawler follows now has to be in the served HTML — which is why the board
   is served by a function rather than read off disk, and why the page no
   longer fetches the listings itself. */
check('netlify.toml serves /browse from a function',
  REDIRECTS.some((r) => r.from === '/browse' && r.to === nf('browse') && r.status === 200),
  '/browse is served as a file again, so every room link is back to being drawn by JavaScript');
check('the browse function exists', existsSync(join(SITE, 'netlify/functions/browse.js')));
check('browse.html keeps the holder line the server swaps the board into',
  read('browse.html').includes('<!--board-->'),
  'without the marker the function serves the page as it is on disk — the page still looks fine and shows no rooms');
check('browse.html reads the listings from nowhere itself',
  !/rest\/v1/.test(read('browse.html')) && !/fetch\(/.test(read('browse.html')),
  'the board has two renderers of one card again: the server\u2019s and the browser\u2019s');
check('the card markup lives in the module the function requires',
  read('assets/browse-card.js').includes('ArzuzListing.path('),
  'the card builder has stopped using the module that owns a room\u2019s address');
check('and the function requires it statically, so the bundler ships it',
  read('netlify/functions/browse.js').includes("require('../../assets/browse-card.js')"),
  'a module named only in a readFileSync is not bundled — the deploy would answer 503');

/* What the functions read at runtime has to be bundled with them. A missing
   entry here is invisible locally and breaks the live page — which is
   exactly why it is asserted rather than trusted. */
const included = one(toml, /included_files\s*=\s*\[([^\]]*)\]/);
for (const need of ['listing.html', '404.html', 'assets/listing-url.js']) {
  check('included_files bundles ' + need, included.includes('"' + need + '"'),
    'the functions read this at runtime; without it the deploy serves the fallback instead of the listing');
}

/* The board function reads the page it serves and the module that builds a
   room's address; the webhook reads the shared IndexNow request. */
for (const need of ['browse.html', 'assets/indexnow.js']) {
  check('included_files bundles ' + need, included.includes('"' + need + '"'),
    'a function reads this at runtime; without it the deploy answers a fallback instead');
}

check('robots.txt lists the listings sitemap',
  /^Sitemap:\s*https:\/\/arzuz\.com\/sitemap-listings\.xml\s*$/m.test(read('robots.txt')),
  'a sitemap nobody is pointed at is a sitemap nobody fetches');

check('browse.html no longer links listings by query string',
  !/href="\/listing\?id=/.test(read('browse.html')),
  'a query string was never indexable inventory — cards must link the listing address');
check('the board links a room through the shared address module',
  read('netlify/functions/browse.js').includes('assets/browse-card.js'),
  'the link builder and the function that serves the page have to agree');

check('listing.html loads assets/listing-url.js',
  read('listing.html').includes('src="assets/listing-url.js"'),
  'the address of a room is built in one place; a page that does not load it cannot link one');

/* ---------------------------------------------------------------
   6. IndexNow: the key file the engines fetch before they trust a POST
   --------------------------------------------------------------- */

const keyFiles = readdirSync(SITE).filter((f) => /^[a-f0-9]{8,128}\.txt$/i.test(f));
const keyFile = keyFiles.find((f) => read(f).trim() === f.replace(/\.txt$/i, ''));
check('an IndexNow key file sits in the site root', !!keyFile,
  keyFiles.length ? 'found ' + keyFiles.join(', ') + ' but the file name and its contents differ' : 'no <key>.txt — scripts/indexnow.mjs cannot submit anything without it');

if (keyFile) {
  check('IndexNow key file is ' + keyFile, read(keyFile).trim().length >= 8, 'the key is too short to be one');

  /* The key file is named in included_files EXPLICITLY — its file NAME is
     the key, so the entry cannot be a glob and still be checkable. Rotating
     the key means creating a new file, and this is what says the
     netlify.toml line has to move with it: without the file in the bundle
     the webhook can only answer 503, and it would do so silently. */
  check('included_files bundles the IndexNow key file by name',
    included.includes('"' + keyFile + '"'),
    'the key file is ' + keyFile + ' and included_files does not name it — a rotated key has to be added there too');
}

check('robots.txt does not block the IndexNow key file',
  !/Disallow:\s*\/[^#\n]*\.txt/i.test(read('robots.txt')),
  'a Disallow on .txt stops the engines fetching the key that authenticates the submission');

/* ---------------------------------------------------------------
   7. the footer is the internal link hub
   --------------------------------------------------------------- */

const appJs = read('assets/app.js');
const footerBody = (appJs.match(/function footer\(\)\{[\s\S]*?\n  \}/) || [''])[0];
check('the shared footer was found in assets/app.js', footerBody.length > 0, 'footer() has been renamed or reshaped — this check needs updating, do not delete it');

const HUB = ['/browse', '/register', '/list', '/my-building', '/roommates', '/rent-in-malete', '/hostels-near-kwasu', '/safety', '/care', '/privacy', '/terms'];
for (const href of HUB) {
  check('the site footer links ' + href, footerBody.includes('href="' + href + '"'),
    'not linked from the footer — with the site footer as the only shared navigation, a page nobody links to is a page nobody crawls');
}

/* ---------------------------------------------------------------
   report
   --------------------------------------------------------------- */

if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  ✗ ' + f));
}
console.log('seo guard — PASS ' + PASS.length + ' · FAIL ' + FAIL.length);
if (FAIL.length) process.exit(1);
