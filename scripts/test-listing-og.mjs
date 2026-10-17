/* Regression test for netlify/functions/listing-og.js.
   Run from arzuz-site/:  node scripts/test-listing-og.mjs
   Mocks global.fetch so no network or secrets are needed. */
import { readFile, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PASS = [];
const FAIL = [];

function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name + (cond ? '' : ' :: ' + (detail || '')));
}

const listingRow = {
  id: 'a1b2c3d4-1111-2222-3333-444455556666',
  tier: 2,
  listed_price_ngn: 250000,
  property_name: 'Sunrise Lodge',
  photo_url: 'https://res.cloudinary.com/demo/old-cover.jpg',
  property_type: 'self-contain',
  area: 'Malete',
  payload: {
    prop_name: 'Sunrise Lodge',
    ty: 'Self-contain',
    rent: 250000,
    ar: 'Malete',
    rm: '1',
    media: [
      { type: 'image', url: 'https://res.cloudinary.com/demo/photo-1.jpg' },
      { type: 'video', url: 'https://res.cloudinary.com/demo/tour.mp4' },
    ],
  },
};

const notFoundRow = { id: 'dead0000-0000-0000-0000-000000000000' };

let fetchCalls = [];
global.fetch = async (url) => {
  fetchCalls.push(String(url));
  const idMatch = /id=eq\.([^&]+)/.exec(String(url));
  const id = idMatch && decodeURIComponent(idMatch[1]);
  if (id === listingRow.id) {
    return { ok: true, status: 200, json: async () => [listingRow] };
  }
  return { ok: true, status: 200, json: async () => [] };
};

// sandbox: copy listing.html next to the function, as included_files would —
// and the shared address module, which is what makes the canonical point at
// /rooms/<slug> instead of the query-string form
await mkdir('netlify/functions/__sandbox', { recursive: true });
await copyFile('listing.html', 'netlify/functions/__sandbox/listing.html');
await copyFile('assets/listing-url.js', 'netlify/functions/__sandbox/listing-url.js');
const realRequire = require;
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'listing.html') return require('node:path').resolve('netlify/functions/__sandbox/listing.html');
  return origResolve.call(this, request, ...args);
};
// simplest: chdir trick is messy — instead read the function source and eval with __dirname pointed at sandbox
const fnSrc = await readFile('netlify/functions/listing-og.js', 'utf8');
const path = require('node:path');
const sandboxDir = path.resolve('netlify/functions/__sandbox');
const moduleShim = { exports: {} };
const fn = new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', fnSrc);
fn(moduleShim, moduleShim.exports, require, sandboxDir, process, global.fetch);
const handler = moduleShim.exports.handler;

function qs(obj) {
  return { queryStringParameters: obj, rawQuery: new URLSearchParams(obj).toString() };
}

// 1. found listing
let res = await handler(qs({ id: listingRow.id }));
let body = res.body;
check('found: status 200', res.statusCode === 200);
check('found: og:title has real name+area', body.includes('content="Sunrise Lodge &mdash;'.replace('&mdash;', '\u2014')) || body.includes('Sunrise Lodge \u2014 Malete | Arzuz'));
check('found: og:description has ₦250,000', body.includes('&#8358;250,000 per session') || body.includes('₦250,000 per session'));
check('found: og:image is first media photo (not video, not old cover)', body.includes('property="og:image" content="https://res.cloudinary.com/demo/photo-1.jpg"'));
/* The canonical of a listing is its /rooms/<slug> address, not the query
   string it was asked for: that is what stops the two from competing. */
const ROOM_PATH = '/rooms/sunrise-lodge-malete-' + listingRow.id;
check('found: og:url is the room address, not the query string',
  body.includes('property="og:url" content="https://arzuz.com' + ROOM_PATH + '"'),
  'og:url is still the query-string form');
check('found: canonical link is the room address',
  body.includes('<link rel="canonical" href="https://arzuz.com' + ROOM_PATH + '">'),
  'the legacy address claims to be canonical — two addresses for one room');
check('found: twitter:image mirrored', body.includes('name="twitter:image" content="https://res.cloudinary.com/demo/photo-1.jpg"'));
check('found: <title> rewritten', body.includes('<title>Sunrise Lodge \u2014 Malete | Arzuz</title>'));
/* The same builder the /rooms/<slug> function uses, so both addresses
   describe the room identically — price, currency and vacancy included. */
const ogLd = /<script type="application\/ld\+json" id="ldjson">([\s\S]*?)<\/script>/.exec(body);
let ogGraph = [];
try {
  ogGraph = (JSON.parse(ogLd[1]) || {})['@graph'] || [];
} catch (e) {
  check('found: JSON-LD parses', false, e.message);
}
const ogPlace = ogGraph.find((n) => n['@type'] === 'Apartment');
check('found: JSON-LD describes the apartment', !!ogPlace);
check('found: JSON-LD has offers NGN',
  !!ogPlace && !!ogPlace.offers && ogPlace.offers.price === 250000 && ogPlace.offers.priceCurrency === 'NGN',
  'the share card has no price on it');
check('found: JSON-LD says InStock while rooms are vacant',
  !!ogPlace && !!ogPlace.offers && ogPlace.offers.availability === 'https://schema.org/InStock');
check('found: JSON-LD url is the room address', !!ogPlace && ogPlace.url === 'https://arzuz.com' + ROOM_PATH);
check('found: no og:image duplication', (body.match(/<meta\s+property="og:image"/g) || []).length === 1);
check('found: page body intact (booking form present)', body.includes('book') && body.includes('assets/arzuz.css'));

// 2. unknown id → generic fallback
res = await handler(qs({ id: notFoundRow.id }));
body = res.body;
check('unknown id: status 200 (page still serves)', res.statusCode === 200);
check('unknown id: generic og:title kept', body.includes('content="Verified Apartment \u2014 Arzuz"'));
check('unknown id: generic og:image kept', body.includes('property="og:image" content="https://arzuz.com/assets/social/og-image.png"'));

// 3. no id → generic fallback, zero fetches
fetchCalls = [];
res = await handler(qs({}));
check('no id: status 200', res.statusCode === 200);
check('no id: no Supabase call made', fetchCalls.length === 0);

// 4. malformed id → no fetch, generic
fetchCalls = [];
res = await handler(qs({ id: "'; DROP TABLE listings; --" }));
check('malformed id: no fetch', fetchCalls.length === 0 && res.statusCode === 200);

// 5. fetch throws → generic fallback, no crash (rebuild handler: it closes over the fetch passed at instantiation)
global.fetch = async () => { throw new Error('network down'); };
const fnE = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', fnSrc)(fnE, fnE.exports, require, sandboxDir, process, global.fetch);
res = await fnE.exports.handler(qs({ id: listingRow.id }));
check('fetch error: status 200 + generic card', res.statusCode === 200 && res.body.includes('Verified Apartment \u2014 Arzuz'));

// 6. listing.html missing from sandbox → redirect
const fn2mod = { exports: {} };
const fn2 = new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', fnSrc);
fn2(fn2mod, fn2mod.exports, require, path.resolve('netlify/functions/__nope'), process, global.fetch);
res = await fn2mod.exports.handler(qs({ id: listingRow.id }));
check('missing page file: 302 redirect to /listing.html', res.statusCode === 302 && res.headers.Location.startsWith('/listing.html'));

// 7. shared module missing from the sandbox → the card still ships, at the old
// address, rather than the whole preview breaking over a bundling mistake.
// (Its own fetch: test 5 replaced global.fetch with a throwing stub.)
const okFetch = async (url) => {
  if (/id=eq\./.test(String(url))) return { ok: true, status: 200, json: async () => [listingRow] };
  return { ok: true, status: 200, json: async () => [] };
};
await mkdir('netlify/functions/__nomodule', { recursive: true });
await copyFile('listing.html', 'netlify/functions/__nomodule/listing.html');
const fnNoMod = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', fnSrc)(
  fnNoMod, fnNoMod.exports, require, path.resolve('netlify/functions/__nomodule'), process, okFetch
);
res = await fnNoMod.exports.handler(qs({ id: listingRow.id }));
check('listing-url.js missing: card still ships with the old og:url',
  res.statusCode === 200 && res.body.includes('property="og:url" content="https://arzuz.com/listing?id=' + listingRow.id + '"'),
  'got ' + res.statusCode);
await rm('netlify/functions/__nomodule', { recursive: true, force: true });

await rm('netlify/functions/__sandbox', { recursive: true, force: true });
console.log('\nPASS: ' + PASS.length);
PASS.forEach((p) => console.log('  \u2713 ' + p));
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('ALL HARNESS CHECKS PASSED');
