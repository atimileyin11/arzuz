/* Regression test for netlify/functions/strategy-docs.js.
   Run from arzuz-site/:  node scripts/test-strategy-docs.mjs
   Mocks global.fetch (Supabase) and file reads; no network or secrets. */
import { readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PASS = [];
const FAIL = [];

function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name + (cond ? '' : ' :: ' + (detail || '')));
}

const PATH = 'netlify/functions/strategy-docs.js';
const src = await readFile(PATH, 'utf8');

const SUPA = 'https://supa.example';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_ANON_KEY = 'anon-test-key';

const USER = { id: 'user-123', email: 'team@arzuz.com' };

let supaCalls = [];
global.fetch = async (url, opts) => {
  supaCalls.push(String(url));
  const h = (opts && opts.headers) || {};
  const auth = h.Authorization || h.authorization || '';
  const token = String(auth).replace(/^Bearer\s+/i, '').trim();
  if (token === 'live-token-0123456789abcdef') return { ok: true, status: 200, json: async () => USER };
  if (token === 'stale-token-0123456789abcdef') return { ok: false, status: 401, json: async () => ({}) };
  throw new Error('supabase unreachable');
};

const moduleShim = { exports: {} };
const fn = new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', src);

/* the real deploy bundles strategy/*.md into netlify/functions/strategy/
   via included_files — mirror that in a sandbox dir */
const SANDBOX = 'netlify/functions/__sandbox';
await mkdir(SANDBOX + '/strategy', { recursive: true });
for (const f of [
  'README.md', '01-market-sizing-tam-sam-som.md', '02-customer-icp-jtbd-journey.md',
  '03-competition-porters-five-forces.md', '04-pesteL.md', '05-positioning-stp.md',
  '06-channels-bullseye.md', '07-unit-economics-ltv-cac.md',
]) {
  await copyFile('strategy/' + f, SANDBOX + '/strategy/' + f);
}

fn(moduleShim, moduleShim.exports, require, SANDBOX, process, global.fetch);
const handler = moduleShim.exports.handler;

const req = (name, token) => ({
  headers: token ? { authorization: 'Bearer ' + token } : {},
  queryStringParameters: name ? { name } : {},
});

/* 1. auth gate */
supaCalls = [];
let res = await handler(req('README.md'));
check('no token: 401', res.statusCode === 401, 'got ' + res.statusCode);
check('no token: JSON error body', res.body.includes('Sign in'));

res = await handler(req('README.md', 'stale-token-0123456789abcdef'));
check('stale token (Supabase rejects): 401', res.statusCode === 401, 'got ' + res.statusCode);

res = await handler(req('README.md', 'garbage-token-0123456'));
check('garbage token: 401', res.statusCode === 401, 'got ' + res.statusCode);

/* a token shorter than the sanity threshold must never hit the network */
supaCalls = [];
res = await handler(req('README.md', 'short'));
check('short token: 401 with zero Supabase calls', res.statusCode === 401 && supaCalls.length === 0, 'status ' + res.statusCode + ', calls ' + supaCalls.length);

/* 2. valid session → docs serve */
supaCalls = [];
res = await handler(req('README.md', 'live-token-0123456789abcdef'));
check('live token: README 200', res.statusCode === 200, 'got ' + res.statusCode);
check('live token: markdown content-type', (res.headers['Content-Type'] || '').includes('text/markdown'));
check('live token: README body served', res.body.includes('Strategy pack'));
check('live token: no-store', res.headers['Cache-Control'] === 'no-store');
check('live token: noindex', (res.headers['X-Robots-Tag'] || '').includes('noindex'));
check('live token: token verified against Supabase', supaCalls.some((u) => u.includes('/auth/v1/user')));

res = await handler(req('05-positioning-stp.md', 'live-token-0123456789abcdef'));
check('doc 05 serves', res.statusCode === 200 && res.body.includes('Positioning'));
res = await handler(req('07-unit-economics-ltv-cac.md', 'live-token-0123456789abcdef'));
check('doc 07 serves', res.statusCode === 200 && res.body.includes('LTV:CAC'));
res = await handler(req('04-pesteL.md', 'live-token-0123456789abcdef'));
check('doc 04 exact-case filename serves', res.statusCode === 200);

/* 3. whitelist + traversal */
for (const bad of [
  '02-customer-icp-jtbd-journey.md%00.html',
  '../supabase-schema.sql',
  '..\\supabase-schema.sql',
  'README.md/',
  './README.md',
  '%2e%2e%2fconfig.js',
  'not-a-doc.md',
  'README.md.js',
  '',
]) {
  res = await handler(req(bad, 'live-token-0123456789abcdef'));
  check('whitelist/traversal rejected: "' + (bad || '(empty)') + '"', res.statusCode === 404, 'got ' + res.statusCode);
}
res = await handler({ headers: { authorization: 'Bearer live-token-0123456789abcdef' }, queryStringParameters: null });
check('missing query params: 404', res.statusCode === 404);

/* 4. lowercase variant of the pestel file is NOT whitelisted */
res = await handler(req('04-pestel.md', 'live-token-0123456789abcdef'));
check('wrong case rejected (exact whitelist)', res.statusCode === 404);

/* 5. missing file in sandbox → 500, not a leak */
const shim2 = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', src)(
  shim2, shim2.exports, require, 'netlify/functions/__nope', process, global.fetch
);
res = await shim2.exports.handler(req('README.md', 'live-token-0123456789abcdef'));
check('sandbox missing doc: 500 error', res.statusCode === 500 && res.body.includes('missing from deployment'));

await rm(SANDBOX, { recursive: true, force: true });

/* 6. static expectations on the source */
check('function reads the Bearer Authorization header', /event\.headers\.authorization\s*\|\|\s*event\.headers\.Authorization/.test(src));
check('function verifies against /auth/v1/user', src.includes('/auth/v1/user'));

console.log('\nPASS: ' + PASS.length);
PASS.forEach((p) => console.log('  \u2713 ' + p));
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('ALL STRATEGY-DOCS HARNESS CHECKS PASSED');
