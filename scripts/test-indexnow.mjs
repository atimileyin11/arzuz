/* Regression test for the two halves of "tell the engines when a room goes
   live":

     assets/indexnow.js                    — the request, in one place
     netlify/functions/listing-live.js     — the webhook that sends it

   WHY THIS SUITE EXISTS

     The manual push (scripts/indexnow.mjs) already existed, and it built
     its own body, knew its own endpoint and had its own idea of what
     counts as accepted. A second implementation for the automatic push
     would have drifted the first time either changed — and the failure is
     silent: IndexNow answers 400 to a malformed body, which looks exactly
     like a submission that worked until somebody checks the index.

     The checks worth reading twice are in section 6: the decision about
     WHAT to submit. A save that changes nothing a visitor can read must
     NOT be resubmitted (IndexNow asks for that explicitly, and a host
     that ignores it gets throttled); a rename must be, because the
     address is new; a save that keeps the address and moves the rent, the
     photo or the vacancy must be, because that is a page the engine has
     already indexed with the wrong figure on it; and a takedown must be,
     so the engines re-crawl and see the 404 rather than keeping a gone
     room in the index for weeks.

   Run from arzuz-site/:  node scripts/test-indexnow.mjs

   Mocks global.fetch, so no network and no secrets. The webhook secret is
   set for the run and put back afterwards. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const readFileAt = (f) => readFile(join(SITE, f), 'utf8');

const PASS = [];
const FAIL = [];
const check = (name, cond, detail) => (cond ? PASS : FAIL).push(name + (cond ? '' : ' :: ' + (detail || '')));

const I = require('../assets/indexnow.js');
const A = require('../assets/api-errors.js');
const ArzuzListing = require('../assets/listing-url.js');
const listingLive = require('../netlify/functions/listing-live.js');

/* ---------------------------------------------------------------
   1. the key file: its NAME is the key
   --------------------------------------------------------------- */

const KEY_FILE = '8e15f62cc98636edef91c1ba76943ebb.txt';
const KEY = '8e15f62cc98636edef91c1ba76943ebb';

check('a hex-named .txt whose contents are its own name is the key',
  I.keyIn(KEY_FILE, KEY + '\n') === KEY, 'the file the repo ships was not recognised');
check('the same file with different contents is not a key',
  I.keyIn(KEY_FILE, 'something else') === '', 'a file that authenticates nothing was accepted');
check('robots.txt is not a key', I.keyIn('robots.txt', 'User-agent: *') === '');
check('a .txt that is not hex is not a key',
  I.keyIn('indexnow.txt', 'indexnow') === '',
  'the engines fetch <key>.txt and read the name as the key — a friendly name authenticates nothing');

/* ---------------------------------------------------------------
   2. the body and the URLs
   --------------------------------------------------------------- */

const body = I.payload(KEY, KEY_FILE, ['https://arzuz.com/a']);
check('the body names the host, the key, where the key file is, and the URLs',
  body.host === 'arzuz.com' && body.key === KEY && body.urlList.length === 1 &&
  body.keyLocation === 'https://arzuz.com/' + KEY_FILE,
  JSON.stringify(body));
check('and nothing else', Object.keys(body).sort().join(',') === 'host,key,keyLocation,urlList',
  'the body grew a field: ' + Object.keys(body).join(','));
check('a payload with no key throws rather than sending an unauthenticated body', (() => {
  try { I.payload('', KEY_FILE, ['https://arzuz.com/a']); return false; } catch (e) { return true; }
})());
check('a payload with no key file name throws too', (() => {
  try { I.payload(KEY, '', ['https://arzuz.com/a']); return false; } catch (e) { return true; }
})());

check('a path becomes a URL on our own host', I.absolute('/browse') === 'https://arzuz.com/browse');
check('a bare word becomes one too', I.absolute('care') === 'https://arzuz.com/care');
check('a full URL is left alone', I.absolute('https://arzuz.com/x') === 'https://arzuz.com/x');
check('one off-host URL is caught, because the engines refuse the whole batch',
  I.offHost(['https://arzuz.com/a', 'https://example.com/b']).length === 1);
check('our own URLs are not flagged', I.offHost(['https://arzuz.com/a']).length === 0);
check('200 is accepted', I.accepted(200));
check('202 is accepted — the key is still being validated', I.accepted(202));
check('403 is not accepted', !I.accepted(403));
check('a 400 is not accepted, which is what a malformed body gets', !I.accepted(400));

/* ---------------------------------------------------------------
   3. the request itself, with fetch injected
   --------------------------------------------------------------- */

let sent = [];
let engineStatus = 202;
let engineText = '';
const stubFetch = async (url, opts) => {
  sent.push({ url: String(url), opts: opts || {} });
  return { status: engineStatus, text: async () => engineText };
};

sent = [];
let out = await I.submit(['/rooms/x'], { key: KEY, keyFile: KEY_FILE, fetch: stubFetch });
check('the submission goes to the one shared endpoint', sent[0] && sent[0].url === I.ENDPOINT,
  sent[0] ? sent[0].url : 'no request was made');
check('as a POST', sent[0] && sent[0].opts.method === 'POST');
check('declaring JSON', sent[0] && /application\/json/.test(sent[0].opts.headers['Content-Type'] || ''));
check('with the body built by payload(), not by the caller',
  sent[0] && JSON.parse(sent[0].opts.body).keyLocation === 'https://arzuz.com/' + KEY_FILE);
check('a short path is made absolute before it is sent',
  sent[0] && JSON.parse(sent[0].opts.body).urlList[0] === 'https://arzuz.com/rooms/x');
check('202 reads as accepted', out.ok === true && out.status === 202);

engineStatus = 403;
engineText = 'Forbidden';
out = await I.submit(['https://arzuz.com/a'], { key: KEY, keyFile: KEY_FILE, fetch: stubFetch });
check('403 reads as refused', out.ok === false && out.status === 403);
check('the engine\u2019s own words come back rather than a summary', out.text === 'Forbidden');

engineStatus = 202;
sent = [];
out = await I.submit(['https://example.com/a'], { key: KEY, keyFile: KEY_FILE, fetch: stubFetch });
check('an off-host URL is refused before it is sent', out.ok === false && sent.length === 0,
  'a batch the engines would reject as a whole was put on the wire anyway');

sent = [];
out = await I.submit([], { key: KEY, keyFile: KEY_FILE, fetch: stubFetch });
check('nothing to submit sends nothing', out.ok === false && sent.length === 0);

/* ---------------------------------------------------------------
   4. which rows the engines may be told about
   --------------------------------------------------------------- */

check('active + verified + production is public inventory',
  I.isLive({ status: 'active', tier: 1, env: 'production' }) === true);
check('an inspected room too', I.isLive({ status: 'active', tier: 2, env: 'production' }) === true);
check('a draft is not', I.isLive({ status: 'draft', tier: 2, env: 'production' }) === false);
check('an unverified row is not', I.isLive({ status: 'active', tier: 0, env: 'production' }) === false);
check('a staging row is not', I.isLive({ status: 'active', tier: 2, env: 'staging' }) === false);
check('a row with no env is production, because the column defaults to it',
  I.isLive({ status: 'active', tier: 2 }) === true);
check('nothing is not inventory', I.isLive(null) === false);

/* ---------------------------------------------------------------
   5. ONE implementation — the manual push and the automatic one
   --------------------------------------------------------------- */

const cli = await readFileAt('scripts/indexnow.mjs');
const live = await readFileAt('netlify/functions/listing-live.js');
const shared = await readFileAt('assets/indexnow.js');
const toml = await readFileAt('netlify.toml');

check('the CLI submits through the shared module', cli.includes("require('../assets/indexnow.js')"),
  'the manual push kept its own copy of the request');
check('the webhook submits through the shared module', live.includes("loadModule('indexnow.js'"),
  'the automatic push has a second implementation of the request');
check('neither caller restates the endpoint',
  !cli.includes('api.indexnow.org') && !live.includes('api.indexnow.org'),
  'a second copy of the endpoint is a second thing to change');
check('the shared module is the one that knows it',
  shared.includes("'https://api.indexnow.org/indexnow'"));
check('netlify.toml serves the webhook under the /api/* rule, as /api/listing-live',
  /from = "\/api\/\*"/.test(toml) && /to\s*=\s*"\/\.netlify\/functions\/:splat"/.test(toml));
check('netlify.toml bundles the shared module and the key file into the function',
  /included_files/.test(toml) && /"assets\/indexnow\.js"/.test(toml) &&
  new RegExp('"' + KEY_FILE + '"').test(toml),
  'the webhook would answer 503 in the deploy — the key file is named in included_files on purpose, see that comment');
check('the webhook secret is documented where the other secrets are',
  /INDEXNOW_HOOK_SECRET/.test(toml));

/* ---------------------------------------------------------------
   6. the webhook, driven

   The function re-reads the row from public_listings and posts to
   IndexNow, so one fetch stub answers both — and the assertions are on
   what a visitor's search result would be, not on an internal call.
   --------------------------------------------------------------- */

const ROW_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const liveRow = {
  id: ROW_ID, tier: 2, listed_price_ngn: 250000,
  property_name: 'Sunrise Lodge', area: 'Malete',
  status: 'active', env: 'production'
};
const draftRow = { ...liveRow, status: 'draft' };
const renamed = { ...liveRow, property_name: 'Sunrise Court' };

let viewMode = 'row';        /* row | empty | throw | http500 */
let viewRows = [liveRow];
let engineCalls = [];
let supabaseCalls = [];
let engineStatus2 = 202;

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.indexOf('api.indexnow.org') !== -1) {
    engineCalls.push({ url: u, body: JSON.parse((opts && opts.body) || '{}') });
    return { status: engineStatus2, text: async () => (engineStatus2 === 202 ? '' : 'Forbidden') };
  }
  supabaseCalls.push(u);
  if (viewMode === 'throw') throw new Error('network down');
  if (viewMode === 'http500') return { ok: false, status: 500, json: async () => [] };
  return { ok: true, status: 200, json: async () => (viewMode === 'empty' ? [] : viewRows) };
};

const SECRET = 'test-secret-not-a-real-one';
const savedSecret = process.env.INDEXNOW_HOOK_SECRET;
process.env.INDEXNOW_HOOK_SECRET = SECRET;

const event = (payload, header) => ({
  httpMethod: 'POST',
  headers: header === null ? {} : { 'x-arzuz-hook': header === undefined ? SECRET : header },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload)
});

const webhook = (record, oldRecord, header) =>
  listingLive.handler(event({ type: 'UPDATE', table: 'listings', record, old_record: oldRecord || null }, header));

const bodyOf = (res) => {
  try { return JSON.parse(res.body); } catch (e) { return null; }
};

/* --- the door --- */

delete process.env.INDEXNOW_HOOK_SECRET;
let res = await webhook(liveRow, draftRow);
let parsed = bodyOf(res);
check('with no shared secret on the deploy: 503, and it says which setting is missing',
  res.statusCode === 503 && parsed && parsed.kind === 'not-ready' && /INDEXNOW_HOOK_SECRET/.test(parsed.error || ''),
  'got ' + res.statusCode + ' ' + res.body);
check('and the wire body is readable by the page\u2019s own classifier',
  A.failed(res.statusCode, res.body).kind === 'not-ready');

process.env.INDEXNOW_HOOK_SECRET = SECRET;
engineCalls = [];
res = await webhook(liveRow, draftRow, 'not-the-secret');
parsed = bodyOf(res);
check('the wrong secret: 401 and nothing submitted',
  res.statusCode === 401 && engineCalls.length === 0, 'got ' + res.statusCode);
check('the refusal carries a class a page can read', parsed && parsed.kind === 'rejected');

res = await listingLive.handler({ httpMethod: 'GET', headers: {} });
check('a GET is refused before anything else happens', res.statusCode === 405, 'got ' + res.statusCode);
check('the method refusal says POST only', /POST only/.test((bodyOf(res) || {}).error || ''));

res = await webhook('{not json');
parsed = bodyOf(res);
check('a body that is not JSON: 400', res.statusCode === 400, 'got ' + res.statusCode);
check('and the 400 reads as refused, not as a broken deployment', parsed && parsed.kind === 'rejected');

res = await webhook({ type: 'UPDATE', table: 'listings' });
check('a body naming no listing: 400', res.statusCode === 400, 'got ' + res.statusCode);
check('the sentence says what was missing', /no listing/i.test((bodyOf(res) || {}).error || ''));

res = await webhook(liveRow, draftRow);
check('every answer is uncached', /no-store/.test(res.headers['Cache-Control'] || ''));

/* --- the decisions --- */

viewMode = 'row';
viewRows = [liveRow];
engineCalls = [];
supabaseCalls = [];
res = await webhook(liveRow, draftRow);
parsed = bodyOf(res);
const wanted = 'https://arzuz.com' + ArzuzListing.path(liveRow);
check('a listing that goes live is submitted', res.statusCode === 200 && engineCalls.length === 1,
  'got ' + res.statusCode + ' and ' + engineCalls.length + ' submissions: ' + res.body);
check('at its canonical /rooms/<slug> address', engineCalls[0] && engineCalls[0].body.urlList[0] === wanted,
  'submitted ' + (engineCalls[0] ? engineCalls[0].body.urlList[0] : 'nothing') + ', expected ' + wanted);
check('and the answer says so', parsed && parsed.submitted === wanted, res.body);
check('the address is checked against the view the site serves from',
  supabaseCalls.some((u) => u.indexOf('public_listings') !== -1 && u.indexOf('id=eq.' + ROW_ID) !== -1),
  'the function went by the webhook body alone: ' + supabaseCalls.join(' | '));
check('the submission is authenticated by the key file on the site',
  engineCalls[0] && /^[a-f0-9]{8,128}$/.test(engineCalls[0].body.key) &&
  /^https:\/\/arzuz\.com\/[a-f0-9]{8,128}\.txt$/.test(engineCalls[0].body.keyLocation),
  'the body has no usable key: ' + JSON.stringify(engineCalls[0] && engineCalls[0].body));

/* An editor saving a row that is ALREADY live at the same address. */
engineCalls = [];
res = await webhook(liveRow, liveRow);
parsed = bodyOf(res);
check('an edit that does not move the room is not resubmitted', engineCalls.length === 0,
  'every save on a live row pings the engines — that is what gets a host throttled');
check('and the answer says why nothing was sent',
  res.statusCode === 200 && parsed && /already live/.test(parsed.ignored || ''), res.body);

/* A rename: the address really did change, so the view serves the new one. */
viewRows = [renamed];
engineCalls = [];
res = await webhook(renamed, liveRow);
check('a rename is submitted, because the address is new', engineCalls.length === 1,
  'the room moved and the engines were not told');
check('to the NEW address',
  engineCalls[0] && engineCalls[0].body.urlList[0] === 'https://arzuz.com' + ArzuzListing.path(renamed));

/* THE SAVES THIS CHANGE EXISTS FOR. The address does not move — the owner
   corrected the price, or swapped the cover photo, or the last unit went.
   An address-only rule dropped every one of these, so the engine kept the
   old figure in its index until something unrelated made it look again. */
const rentRaised = { ...liveRow, listed_price_ngn: 300000 };
const newCover = { ...liveRow, photo_url: 'https://res.cloudinary.com/demo/new-cover.jpg' };
const filledUp = { ...liveRow, rooms: 'Fully occupied' };

viewRows = [rentRaised];
engineCalls = [];
res = await webhook(rentRaised, liveRow);
parsed = bodyOf(res);
check('a rent change at the SAME address is submitted', engineCalls.length === 1,
  'the price moved and the engines were not told: ' + res.body);
check('to the address the room already had',
  engineCalls[0] && engineCalls[0].body.urlList[0] === wanted);
check('and the answer records the submission',
  res.statusCode === 200 && parsed && parsed.submitted === wanted, res.body);

viewRows = [newCover];
engineCalls = [];
res = await webhook(newCover, liveRow);
check('a new cover photo is submitted too', engineCalls.length === 1,
  'the room looks different and the engines were not told');

viewRows = [filledUp];
engineCalls = [];
res = await webhook(filledUp, liveRow);
check('a room that fills up is submitted too', engineCalls.length === 1,
  'the vacancy changed and the engines were not told');

/* The other half of the same rule: a change to a field the page does not
   print is still not worth a crawl. The trigger stamps updated_at for it,
   but that is not what a visitor reads. */
const noted = { ...liveRow, notes: 'called the landlord, rent confirmed' };
viewRows = [noted];
engineCalls = [];
res = await webhook(noted, liveRow);
parsed = bodyOf(res);
check('a change to a field the page does not print is not submitted', engineCalls.length === 0,
  'an internal note pinged the engines: ' + res.body);
check('and the answer says why', parsed && /nothing on the page changed/.test(parsed.ignored || ''), res.body);

/* THE DESCRIPTION. The one fact a visitor reads that has no generated
   column: it lives in the payload, so an address-only rule never saw it
   and an owner who rewrote the paragraph kept the engine's old copy.
   The view row now carries the payload, and only the two keys the page
   reads out of it are compared. */
const DESC_OLD = { ...liveRow, payload: { desc: 'Two rooms left, borehole water.' } };
const DESC_NEW = { ...liveRow, payload: { desc: 'Two rooms left, borehole water and a prepaid meter.' } };

viewRows = [DESC_NEW];
engineCalls = [];
supabaseCalls = [];
res = await webhook(DESC_NEW, DESC_OLD);
parsed = bodyOf(res);
check('a rewritten description at the SAME address is submitted', engineCalls.length === 1,
  'the paragraph changed and the engines kept the old one: ' + res.body);
check('to the address the room already had',
  engineCalls[0] && engineCalls[0].body.urlList[0] === wanted);
check('the row is re-read WITH its payload, or the description is never seen',
  supabaseCalls.some((u) => /public_listings\?select=[^&]*payload/.test(u)),
  'the SELECT cannot notice a description edit: ' + JSON.stringify(supabaseCalls));

/* desc and description are ONE fact, because the page reads either
   (`p.desc || p.description`). Moving the same sentence from one key to
   the other is not a change a visitor can see. */
const DESC_OTHER_KEY = { ...liveRow, payload: { description: 'Two rooms left, borehole water.' } };
viewRows = [DESC_OTHER_KEY];
engineCalls = [];
res = await webhook(DESC_OTHER_KEY, DESC_OLD);
parsed = bodyOf(res);
check('a description moved between desc and description is not a change', engineCalls.length === 0,
  'the same sentence under the page\u2019s other key pinged the engines: ' + res.body);

/* The fields public_listings scrubs. A corrected caretaker number or a
   renamed landlord never reaches a visitor, so it is not a page change —
   and it is not worth the crawl a save would otherwise buy. Driven
   through the handler, because the webhook BODY carries these keys even
   though the view does not. */
const SCRUBBED = ['nm', 'last', 'ph', 'who', 'email'];
for (const key of SCRUBBED) {
  const before = { ...liveRow, payload: { desc: 'Two rooms left.', [key]: 'one value' } };
  const after = { ...liveRow, payload: { desc: 'Two rooms left.', [key]: 'another value' } };
  viewRows = [after];
  engineCalls = [];
  res = await webhook(after, before);
  parsed = bodyOf(res);
  check('a change to ' + key + ' (scrubbed from the public page) is not submitted',
    engineCalls.length === 0,
    'a private field the page scrubs pinged the engines: ' + res.body);
}

/* The comparison is on normalised text, so 250000 and "250000" are the
   same rent rather than a phantom change. */
check('the change comparison normalises numbers and blanks',
  listingLive.contentOf({ listed_price_ngn: 250000 }) === listingLive.contentOf({ listed_price_ngn: '250000' }) &&
  listingLive.contentOf({ photo_url: null }) === listingLive.contentOf({ photo_url: '' }),
  'a number and its string form, or null and "", read as different pages');

check('the change comparison counts the description',
  listingLive.contentOf({ payload: { desc: 'a' } }) !== listingLive.contentOf({ payload: { desc: 'b' } }),
  'a rewritten paragraph read as the same page');
check('and reads desc and description as one fact',
  listingLive.contentOf({ payload: { desc: 'a' } }) === listingLive.contentOf({ payload: { description: 'a' } }),
  'the same sentence under the page\u2019s other key read as a change');
check('and never reads a key the public view scrubs',
  SCRUBBED.every((k) =>
    listingLive.contentOf({ payload: { desc: 'a', [k]: 'one' } }) ===
    listingLive.contentOf({ payload: { desc: 'a', [k]: 'two' } })),
  'the comparison is looking at the payload as a whole, not at the description');
check('and ignores whitespace the editor added',
  listingLive.contentOf({ payload: { desc: 'a' } }) === listingLive.contentOf({ payload: { desc: 'a\n' } }),
  'a trailing newline read as a page change');
check('and the page\u2019s reading order is the view\u2019s own',
  listingLive.descriptionOf({ payload: { desc: '', description: 'fallback' } }) === 'fallback' &&
  listingLive.descriptionOf({ payload: { desc: 'primary', description: 'fallback' } }) === 'primary',
  'an empty desc must fall through to description, exactly as listing.html does');
check('and a row with no payload at all is not a crash',
  listingLive.descriptionOf({}) === '' && listingLive.descriptionOf({ payload: null }) === '' &&
  listingLive.descriptionOf({ payload: 'not json at all' }) === '',
  'a row the view carried no payload for threw instead of reading as no description');
check('and a payload that arrived as a string is still read',
  listingLive.descriptionOf({ payload: '{"desc":"from a string"}' }) === 'from a string',
  'a stringified payload read as "no description" — a silent miss');

/* A takedown: the URL now answers a 404, and a crawl is how that is learned. */
viewRows = [liveRow];
viewMode = 'empty';
engineCalls = [];
res = await webhook(null, liveRow);
parsed = bodyOf(res);
check('a room taken off the board is submitted again, so the engines see the 404',
  engineCalls.length === 1 && engineCalls[0].body.urlList[0] === wanted,
  'a gone room stays in the index until something else makes the engine look');
check('and the answer records why', parsed && /404/.test(parsed.why || ''), res.body);

/* A row that never was public inventory. */
engineCalls = [];
res = await webhook(draftRow, draftRow);
parsed = bodyOf(res);
check('a draft is never submitted', engineCalls.length === 0);
check('and it is a 200 with a reason, not an error',
  res.statusCode === 200 && parsed && /not public inventory/.test(parsed.ignored || ''), res.body);

/* The view unreachable: the event body is all there is. */
viewMode = 'throw';
engineCalls = [];
res = await webhook(liveRow, null);
check('the database unreachable: the event body still gets the room submitted',
  engineCalls.length === 1, 'a missed listing is worse than a wasted crawl');
engineCalls = [];
res = await webhook(draftRow, draftRow);
check('the database unreachable, nothing live: still nothing submitted', engineCalls.length === 0);

/* The engine refuses. */
viewMode = 'row';
engineStatus2 = 403;
engineCalls = [];
res = await webhook(liveRow, draftRow);
parsed = bodyOf(res);
check('an engine refusal is a 502, not a 200 that pretends', res.statusCode === 502,
  'got ' + res.statusCode);
check('the refusal carries the engine\u2019s own answer',
  parsed && /403/.test(parsed.error || '') && /Forbidden/.test(parsed.error || ''), res.body);
check('a 502 is read by a page as worth trying again', A.retryable(A.failed(res.statusCode, res.body)),
  'a failure the webhook could retry was named as one it could not');
engineStatus2 = 202;

/* ---------------------------------------------------------------
   7. a deploy with the key file outside the bundle
   --------------------------------------------------------------- */

const src = await readFileAt('netlify/functions/listing-live.js');
const noKeyShim = { exports: {} };
/* The only thing this stub changes is the filesystem: the function's own
   requires must still resolve, and the relative ones resolve against the
   function's directory, exactly as Node would for the real file. */
const FUNCTION_DIR = join(SITE, 'netlify/functions');
const fakeRequire = (name) => {
  if (name === 'node:fs' || name === 'fs') return { readdirSync: () => [], readFileSync: () => '' };
  if (String(name).charAt(0) === '.') return require(join(FUNCTION_DIR, name));
  return require(name);
};
new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', src)(
  noKeyShim, noKeyShim.exports, fakeRequire, FUNCTION_DIR, process, global.fetch
);
engineCalls = [];
res = await noKeyShim.exports.handler(event({ type: 'UPDATE', table: 'listings', record: liveRow, old_record: draftRow }));
parsed = bodyOf(res);
check('no key file in the bundle: 503 rather than a submission that authenticates nothing',
  res.statusCode === 503, 'got ' + res.statusCode);
check('and the sentence names the key file as the thing to fix',
  parsed && parsed.kind === 'not-ready' && /key file/i.test(parsed.error || ''), res.body);
check('nothing was sent', engineCalls.length === 0);

/* ---------------------------------------------------------------
   report
   --------------------------------------------------------------- */

if (savedSecret === undefined) delete process.env.INDEXNOW_HOOK_SECRET;
else process.env.INDEXNOW_HOOK_SECRET = savedSecret;

console.log('\nPASS: ' + PASS.length);
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
PASS.forEach((p) => console.log('  \u2713 ' + p));
console.log('ALL HARNESS CHECKS PASSED');
