/* Regression test for the page whose links get a room found:

     netlify/functions/browse.js — /browse, rendered by the server
     assets/browse-card.js       — the card markup, in one place

   WHY THIS SUITE EXISTS

     The board used to draw its cards in the browser: browse.html fetched
     public_listings itself and built every card in an inline script. So the
     page had two renderers of one room — a server copy for a crawler and a
     browser copy for people — and the links a crawler follows to reach a
     /rooms page existed only in the second one. A sitemap tells a search
     engine a URL exists; a LINK is how it decides the page is part of the
     site.

     The checks worth reading twice are the first block: they are what the
     request was for. The cards, their links and their prices are in the
     SERVED HTML, and the page reads nothing from Supabase — no inline
     fetch, no query string, no client-side renderer left to disagree with
     the server's.

   Run from arzuz-site/:  node scripts/test-browse.mjs

   Mocks global.fetch, so no network and no secrets. The function is loaded
   out of a sandbox holding what netlify.toml's included_files would put
   beside it, AND through require() from the repo — one of those two layouts
   is the real deploy. */
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const PASS = [];
const FAIL = [];
const check = (name, cond, detail) => (cond ? PASS : FAIL).push(name + (cond ? '' : ' :: ' + (detail || '')));

/* ---------------------------------------------------------------
   the fixtures
   --------------------------------------------------------------- */

const AO = 'a1b2c3d4-1111-2222-3333-444455556666';
const BO = 'b2c3d4e5-2222-3333-4444-555566667777';

/* A traced route from the gate, so this room's walk is MEASURED — the
   number this site claims over a portal. */
const MEASURED = [[8.721, 4.484], [8.7245, 4.4875], [8.728, 4.491]];

const sunrise = {
  id: AO,
  tier: 2,
  listed_price_ngn: 250000,
  property_name: 'Sunrise Lodge',
  photo_url: 'https://res.cloudinary.com/demo/cover.jpg',
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
    photo: 'https://res.cloudinary.com/demo/cover.jpg',
    desc: 'A self-contain with a private bathroom.',
    passage: { route: MEASURED, route_src: 'traced' },
    ut: ['Borehole water', 'Private bathroom'],
    media: [
      { type: 'image', url: 'https://res.cloudinary.com/demo/one.jpg' },
      { type: 'image', url: 'https://res.cloudinary.com/demo/two.jpg' },
      { type: 'video', url: 'https://res.cloudinary.com/demo/tour.mp4' }
    ]
  }
};

/* Everything that has to be escaped, a tier that is only community
   verified, six utilities (so the "+N" chip is exercised) and no pin at
   all — so its walk can only be the empty string. */
const awkward = {
  id: BO,
  tier: 1,
  listed_price_ngn: 120000,
  property_name: 'A & B <Lodge> "Annex"',
  photo_url: '',
  property_type: 'single room',
  area: 'Malete',
  rooms: '2',
  latitude: null,
  longitude: null,
  payload: {
    prop_name: 'A & B <Lodge> "Annex"',
    ty: 'Single room',
    rent: 120000,
    ar: 'Malete',
    rm: '2',
    video: 'https://res.cloudinary.com/demo/tour2.mp4',
    ut: ['Water', 'Power', 'Gate', 'Kitchen', 'Toilet', 'Tiles']
  }
};

/* A pin but no traced route: the walk can only be the straight-line
   ESTIMATE, and the card has to say so rather than the same as a measured
   one. */
const pinOnly = {
  ...awkward,
  id: 'd4e5f6a7-4444-5555-6666-777788889999',
  latitude: 8.7265,
  longitude: 4.4895,
  payload: { ...awkward.payload, passage: {} }
};

const noRent = { ...sunrise, id: 'c3d4e5f6-3333-4444-5555-666677778888', listed_price_ngn: null, payload: { ...sunrise.payload, rent: '' } };
const noId = { ...sunrise, id: null, payload: { ...sunrise.payload, prop_name: 'No address at all' } };

let ROWS = [sunrise, awkward];
let fetchMode = 'ok';
let fetchCalls = [];

global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts: opts || {} });
  if (fetchMode === 'throw') throw new Error('network down');
  if (fetchMode === 'http500') return { ok: false, status: 500, json: async () => [] };
  return { ok: true, status: 200, json: async () => ROWS };
};

/* ---------------------------------------------------------------
   the two layouts
   --------------------------------------------------------------- */

/* netlify/functions/browse.js requires the card module STATICALLY, as
   '../../assets/browse-card.js', and reads browse.html from a directory it
   has to guess at deploy time. So the function is run twice: once with
   __dirname exactly where it lives in the repo (which is what a bundled
   deploy resolves against), and once from a directory with no page and no
   cwd — the state Netlify leaves if browse.html was not packaged. */
const src = await readFile('netlify/functions/browse.js', 'utf8');
const FUNC_DIR = resolve('netlify/functions');

/* A module in netlify/functions/ resolves './x' against ITS OWN directory,
   so a relative require inside the eval'd function has to be resolved the
   same way — otherwise the harness would be testing a path the deploy
   never takes. Everything BELOW that first hop is real Node resolution. */
const reqFrom = (base) => (name) => {
  const n = String(name);
  return n.charAt(0) === '.' ? require(resolve(base, n)) : require(n);
};

function load(dir, opts) {
  const hop = reqFrom(dir);
  /* The "page not in the bundle" state cannot be faked with a directory:
     the static require needs the real __dirname, and the page lookup would
     then find the real browse.html through its ../../ candidate. So the
     module is injected with a fs that reports browse.html missing — which
     is exactly what Netlify's bundle looks like if included_files ever
     stops listing it. */
  const hide = !!(opts && opts.hidePage);
  const requireShim = hide
    ? (name) => {
        const n = String(name);
        if (n === 'fs' || n === 'node:fs') {
          return Object.assign(Object.create(fs), {
            readFileSync: (p, enc) => {
              if (String(p).endsWith('browse.html')) {
                const e = new Error("ENOENT: no such file or directory, open '" + p + "'");
                e.code = 'ENOENT';
                throw e;
              }
              return fs.readFileSync(p, enc);
            }
          });
        }
        return hop(n);
      }
    : hop;
  const shim = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', src);
  fn(shim, shim.exports, requireShim, dir,
    { env: process.env, cwd: () => (opts && opts.cwd) || process.cwd() }, global.fetch);
  return shim.exports;
}

const browse = load(FUNC_DIR).handler;
const Board = require('../assets/browse-card.js');
const ArzuzListing = require('../assets/listing-url.js');
const pageFile = await readFile('browse.html', 'utf8');

const hrefOf = (row) => 'href="' + ArzuzListing.path(row) + '"';

/* Just the board container and what the FUNCTION put inside it. Checking
   the whole document would pass on strings that live in the page's own
   markup, which is the thing a server render is supposed to replace. */
const boardOf = (html) => {
  const a = html.indexOf('<div id="listings">');
  if (a === -1) return '';
  const b = html.indexOf('<p class="note"', a);
  return html.slice(a, b === -1 ? html.length : b);
};

/* ---------------------------------------------------------------
   1. the served page — the whole point
   --------------------------------------------------------------- */

let res = await browse({});
let html = res.body || '';
let board = boardOf(html);

check('status 200', res.statusCode === 200, 'got ' + res.statusCode);
check('answers HTML', /text\/html/.test(res.headers['Content-Type'] || ''));
check('is the browse page', html.includes('<h1>Verified rooms near campus</h1>'));
check('exactly one <h1> in the served page', (html.match(/<h1[\s>]/g) || []).length === 1,
  'the board must not add a heading of its own — the page has one');

/* THE FEATURE */
check('every room is a card in the served HTML',
  (html.match(/class="card"/g) || []).length === 2,
  'the cards are not in the document a crawler fetches: ' + (html.match(/class="card"/g) || []).length);
check('each card links its own /rooms/<slug> address',
  html.includes(hrefOf(sunrise)) && html.includes(hrefOf(awkward)),
  'the room links are missing from the HTML');
check('no card links by query string', !html.includes('href="/listing?id='),
  'a ?id= URL is not indexable inventory');
check('the board is inside #listings, inside the page',
  board.includes('<div class="grid">') && board.indexOf('<div class="grid">') < board.indexOf('</div>'),
  'the board was written outside its container');
check('the served page has exactly one #listings', (html.match(/id="listings"/g) || []).length === 1);

/* WHAT THE PAGE DOES NOT DO ANY MORE */
check('the page reads nothing from Supabase',
  !/rest\/v1/.test(html) && !/fetch\(/.test(html),
  'the board still fetches its own data in the browser: ' + (html.match(/.{0,40}fetch\(.{0,40}/) || [''])[0]);
check('there is no second renderer of a card left in the page',
  !/box\.innerHTML|ArzuzListing\.path|class="card"/.test(pageFile.replace(/[\s\S]*<style>[\s\S]*?<\/style>/, '')),
  'browse.html still builds cards itself — two renderers, one of them wrong');
check('and the page no longer loads the modules only a browser renderer needed',
  !pageFile.includes('assets/data.js') && !pageFile.includes('assets/arzuz-map.js'),
  'the board still loads the map/amenity modules (and their requests) for nothing');
check('the file on disk reads nothing from Supabase either',
  !/supabase/i.test(pageFile) && !/rest\/v1/.test(pageFile));
check('the inline script is down to the shared chrome',
  pageFile.includes("Arzuz.chrome('student')") && pageFile.includes('Arzuz.footer()'));

/* ---------------------------------------------------------------
   2. the card, field by field
   --------------------------------------------------------------- */

check('the name is in the card', board.includes('>Sunrise Lodge</h3>'));
check('the price and its period are in the card',
  board.includes('\u20A6250,000') && board.includes('per session'));
check('the badge says how far the check went',
  board.includes('Inspected') && board.includes('Community verified'));
check('the area, type and vacancy are in the card',
  board.includes('Malete') && board.includes('Self-contain') && board.includes('>1</span>'),
  'the area, the type or the vacancy dropped off the card');
/* The measured walk and the estimate are two different sentences, and the
   difference is the whole claim the site makes about walking times: a
   stored route is km · min, a bare pin is "≈ min". */
check('the MEASURED walk is in the card, not the straight-line estimate',
  board.includes(ArzuzListing.walkOf(sunrise)) &&
  /km · \d+ min walk to KWASU/.test(board) && !/≈/.test(board),
  'the walk for a traced route is ' + JSON.stringify(ArzuzListing.walkOf(sunrise)) +
  ' and the board says ' + JSON.stringify((board.match(/<div class="walk">[^<]*/) || [''])[0]));
check('a room with no pin and no route gets no walk line at all',
  ArzuzListing.walkOf(awkward) === '');
check('the utilities are chips, and an overflow is counted',
  board.includes('Borehole water') && board.includes('+2'),
  'six utilities should print four and say +2');
check('the cover photo is an img with alt text',
  /<img src="https:\/\/res\.cloudinary\.com\/demo\/cover\.jpg" alt="[^"]*Sunrise Lodge[^"]*"/.test(board),
  'no crawlable image, or no alt describing the room');
check('the media chips count photos and tour separately',
  board.includes('2 photos') && board.includes('Tour'));
check('the Ask link names the room, so the team does not have to ask which one',
  /href="https:\/\/wa\.me\/\d+\?text=[^"]*Sunrise%20Lodge/.test(board),
  'the WhatsApp link does not carry the listing');
check('Ask opens in a new tab safely',
  /target="_blank" rel="noopener noreferrer"/.test(board));

/* escaping — every value is written into markup by a server now */
check('an ampersand in a property name is escaped', board.includes('A &amp; B'));
check('an angle bracket cannot become a tag',
  !board.includes('<Lodge>') && board.includes('&lt;Lodge&gt;'));
check('a quote is escaped', board.includes('&quot;Annex&quot;'));
check('the name is still readable in the link text', board.includes('View details'));

/* the two half-filled rows */
ROWS = [noRent, noId];
res = await browse({});
const edge = boardOf(res.body || '');
check('a row with no rent invents no price', !edge.includes('class="price"') && !edge.includes('\u20A60'));
check('a row with no rent is still linked', (res.body || '').includes(hrefOf(noRent)));
check('a row with no id is not rendered at all',
  (edge.match(/class="card"/g) || []).length === 1 && !/undefined/.test(edge),
  'a row the address builder cannot name reached the page');
ROWS = [sunrise, awkward];

/* ---------------------------------------------------------------
   3. the query, and the holder the page keeps for it
   --------------------------------------------------------------- */

const listingQuery = fetchCalls.map((c) => c.url).find((u) => u.includes('public_listings'));
check('reads the public view', !!listingQuery && /rest\/v1\/public_listings\?select=/.test(listingQuery));
check('asks for the payload, because the walk and the utilities live in it',
  !!listingQuery && /select=\*/.test(listingQuery),
  'without the payload a measured route cannot be printed: ' + listingQuery);
check('newest first, like the page always did', !!listingQuery && /order=created_at\.desc/.test(listingQuery));

check('browse.html keeps the holder line the board is swapped into',
  pageFile.includes(Board.MARKER),
  'renaming the marker silently serves the fallback state on the live site');
check('the marker appears exactly once',
  pageFile.split(Board.MARKER).length === 2,
  'a second marker (in a comment, say) would be matched first and the wrong line would be replaced');
check('the holder line carries the board container and is complete on ONE line',
  /<div id="listings"><!--board-->[\s\S]*?<\/div><\/div>\r?$/m.test(pageFile),
  'the swap replaces one whole line, so the holder has to be one whole line');
check('the fallback state is the honest empty state, not a spinner',
  !/Loading…|Fetching verified listings/.test(pageFile) &&
  pageFile.includes('No verified listings yet') && pageFile.includes('href="/list"'),
  'a page with no server behind it would sit on "Loading…" for ever');

/* ---------------------------------------------------------------
   4. the three states the function can serve
   --------------------------------------------------------------- */

/* no rows: the page's own empty state IS the empty state */
ROWS = [];
fetchCalls = [];
res = await browse({});
check('nothing on the board: still 200', res.statusCode === 200, 'got ' + res.statusCode);
check('nothing on the board: the page is served exactly as it is on disk',
  res.body === pageFile,
  'an empty board should change nothing — the file already says the honest thing');
check('nothing on the board: no empty grid was written', !(res.body || '').includes('class="grid"'));

ROWS = [sunrise, awkward];

fetchMode = 'throw';
res = await browse({});
html = res.body || '';
check('database unreachable: 200, not 503', res.statusCode === 200,
  'the one page whose job is to be reachable went down with the database');
check('database unreachable: it says so, in the first person',
  html.includes('Listings are warming up') && /that is our side, not yours/.test(html),
  'the visitor was told about a database, or told nothing');
check('database unreachable: the empty state it does not know about is gone',
  !html.includes('No verified listings yet'),
  'the page claims there are no verified rooms when it simply could not ask');
check('database unreachable: the way out is still there', html.includes('href="/register"'));

fetchMode = 'http500';
res = await browse({});
check('database error: still 200', res.statusCode === 200, 'got ' + res.statusCode);
fetchMode = 'ok';

/* ---------------------------------------------------------------
   5. the page missing from the bundle
   --------------------------------------------------------------- */

const noPage = load(FUNC_DIR, { hidePage: true, cwd: '/nonexistent' });
res = await noPage.handler({});
check('browse.html missing from the bundle: 503, never a 200 with nothing in it',
  res.statusCode === 503, 'got ' + res.statusCode);
check('and never a redirect — /browse.html 301s straight back to /browse',
  !res.headers.Location, 'a bounce here is an infinite loop between the route and its own 301');check('the fallback is a real page with a way out',
  (res.body || '').includes('/register') && (res.body || '').includes('/list'));
check('the fallback is not indexable', /name="robots" content="noindex"/.test(res.body || ''));

/* ---------------------------------------------------------------
   6. the module on its own
   --------------------------------------------------------------- */

check('board([]) renders nothing, so the function serves the file instead',
  Board.board([]) === '' && Board.board(null) === '');
check('a row with no address is not a card', Board.card(noId) === '');
check('fill() returns nothing when the page has lost its marker',
  Board.fill('<p>no marker here</p>', 'X') === '');
check('fill() replaces the whole line and touches nothing else',
  Board.fill('a\n<p id="listings"><!--board-->default</p>\nb', 'X') === 'a\n<div id="listings">X</div>\nb',
  'the swap is line-scoped: ' + JSON.stringify(Board.fill('a\n<p id="listings"><!--board-->default</p>\nb', 'X')));
/* Only reached if the file ever gains CRLF endings. The closing \r goes with
   the line it belonged to, so the neighbours keep their own endings and the
   swapped line is left with a bare \n — HTML does not care, and asserting it
   here is how that stops being a surprise. */
check('fill() copes with CRLF line endings',
  Board.fill('a\r\n<p id="listings"><!--board-->default</p>\r\nb', 'X') === 'a\r\n<div id="listings">X</div>\nb',
  'got ' + JSON.stringify(Board.fill('a\r\n<p id="listings"><!--board-->default</p>\r\nb', 'X')));
check('every value goes through esc(), hrefs included',
  Board.esc('a & b <c> "d" \'e\'') === 'a &amp; b &lt;c&gt; &quot;d&quot; &#039;e&#039;');
check('a pin with no stored route falls back to the estimate, and says so',
  /≈ \d+ min walk to KWASU/.test(Board.board([pinOnly])) &&
  !/km ·/.test(Board.board([pinOnly])),
  'a room with only a pin printed ' + JSON.stringify(ArzuzListing.walkOf(pinOnly)));
check('a route that is not a list of [lat,lng] pairs is not trusted',
  ArzuzListing.walkOf({ ...sunrise, payload: { ...sunrise.payload, passage: { route: [{ lat: 8.7, lng: 4.5 }, { lat: 8.8, lng: 4.6 }] } } }).includes('≈'),
  'objects were read as a route, so a malformed passage would print a measured time');

/* ---------------------------------------------------------------
   7. the other layout — require() from the repo
   --------------------------------------------------------------- */

const fromRepo = require('../netlify/functions/browse.js');
res = await fromRepo.handler({});
check('the repo layout loads too (browse.html two directories up)',
  res.statusCode === 200 && (res.body || '').includes(hrefOf(sunrise)),
  'one of the two layouts is the real deploy; if only one works, the board is broken there');

/* ---------------------------------------------------------------
   report
   --------------------------------------------------------------- */

console.log('\nPASS: ' + PASS.length);
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
PASS.forEach((p) => console.log('  \u2713 ' + p));
console.log('ALL HARNESS CHECKS PASSED');
