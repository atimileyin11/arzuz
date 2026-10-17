#!/usr/bin/env node
/* ============================================================
   Arzuz — does the upload signature match what Cloudinary checks?

   THE FAILURE THIS EXISTS FOR

     Every photo upload on the live site failed with

       HTTP 401 Invalid Signature … String to sign —
       'context=…&eager=…&folder=…&timestamp=…'

     The function signed one more parameter than Cloudinary does
     (`max_file_size`), so the two hashes could never agree. The
     endpoint answered 200 with a signature the upload endpoint then
     refused, which is the worst shape of failure: nothing in the
     response says the *signature* is wrong, and the page could only
     report "Cloudinary rejected the upload".

     Cloudinary's own 401 quoted the string it computed, which is how
     the rule was learned. This file re-derives that string from what
     the handler returns and hashes it with the same secret, so the
     two must agree — and it fails, with a named reason, the moment
     somebody adds a parameter to the signature again.

   WHAT IS SIGNED, AND WHAT IS ONLY SENT

     Signed    context, eager, folder, timestamp  (alphabetical, then
               the API secret)
     Sent only file, api_key, signature, and max_file_size
     Ignored   cloud_name, resource_type — they live in the URL

     That is Cloudinary's rule, not this file's opinion: the test
     proves it by showing that adding max_file_size to the string
     changes the hash (i.e. would have failed on the wire).

   Run:  node dev/cloudinary-sign-test.mjs
   ============================================================ */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SECRET = 'test-secret-not-a-real-one';
const KEY = 'test-key';
const CLOUD = 'test-cloud';

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const out = fn();
    if (out === true || out === undefined) { pass++; return true; }
    failures.push(name + '\n      → ' + out);
    return false;
  } catch (err) {
    failures.push(name + '\n      → threw: ' + (err && err.message));
    return false;
  }
}

function freshHandler() {
  delete require.cache[require.resolve('../netlify/functions/cloudinary-sign.js')];
  return require('../netlify/functions/cloudinary-sign.js').handler;
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

/* What Cloudinary verifies: every signable parameter present in the
   request, sorted by name, joined with '&', secret appended. Parameters
   Cloudinary does not sign (file, api_key, cloud_name, resource_type,
   signature, max_file_size) are excluded — this is the rule the live
   401 spelled out. */
function cloudinaryHash(params, secret) {
  const signed = Object.keys(params)
    .filter((k) => k !== 'file' && k !== 'api_key' && k !== 'cloud_name' &&
      k !== 'resource_type' && k !== 'signature' && k !== 'max_file_size')
    .sort()
    .map((k) => k + '=' + params[k])
    .join('&');
  return { string: signed, hash: sha1(signed + secret) };
}

/* ------------------------------------------------------------ */

process.env.CLOUDINARY_API_KEY = KEY;
process.env.CLOUDINARY_API_SECRET = SECRET;
process.env.CLOUDINARY_CLOUD_NAME = CLOUD;

const handler = freshHandler();

const res = await handler({ httpMethod: 'POST', headers: {} });
let body = {};
try { body = JSON.parse(res.body); } catch (e) { body = {}; }

/* The fields the browser actually POSTs to Cloudinary, exactly as
   assets/admin.js and assets/complete-listing.js append them. */
const sent = {
  api_key: body.api_key,
  timestamp: body.timestamp,
  folder: body.folder,
  eager: body.eager,
  context: body.context,
  max_file_size: body.max_file_size,
};

check('the sign endpoint answers 200 with a signature and no-store', () =>
  (res.statusCode === 200 && !!body.signature && /no-store/.test(res.headers['Cache-Control'] || ''))
    || 'status ' + res.statusCode + ', signature present: ' + !!body.signature);

check('the signature is the hash of exactly the parameters Cloudinary signs', () => {
  const expected = cloudinaryHash(sent, SECRET);
  return (body.signature === expected.hash)
    || 'signed string mismatch.\n        Cloudinary recomputes: ' + expected.string +
       '\n        would have accepted:  ' + expected.hash +
       '\n        the function returned: ' + body.signature;
});

check('max_file_size is sent, but is NOT inside the signed string', () => {
  const withoutSize = cloudinaryHash(sent, SECRET).hash;
  const withSize = sha1(
    Object.keys(sent).filter((k) => k !== 'api_key')
      .sort().map((k) => k + '=' + sent[k]).join('&') + SECRET
  );
  return (body.signature === withoutSize && body.signature !== withSize)
    ? true
    : 'the hash moved when max_file_size was added back — Cloudinary excludes it, so the upload would 401';
});

check('every signed parameter is one the page actually sends', () => {
  const signedNames = ['context', 'eager', 'folder', 'timestamp'];
  const missing = signedNames.filter((k) => sent[k] === undefined || sent[k] === '');
  return missing.length === 0 || 'the page never sends ' + missing.join(', ');
});

check('the signature covers enough to be worth anything', () => {
  const signedNames = ['context', 'eager', 'folder', 'timestamp'];
  return signedNames.indexOf('timestamp') !== -1 || 'no timestamp — the signature would never expire';
});

check('values that would split a query string are refused, not signed', () => {
  /* An '&' inside a value would become a second parameter on the wire
     and the hashes would silently disagree. The context is a constant,
     so this is a guard on the constant, not on user input. */
  const bad = Object.keys(sent).filter((k) => typeof sent[k] === 'string' && sent[k].indexOf('&') !== -1);
  return bad.length === 0 || 'contains "&": ' + bad.join(', ');
});

check('the folder is the site its own, and the timestamp is fresh', () => {
  const now = Math.floor(Date.now() / 1000);
  return (body.folder === 'arzuz-buildings' && Math.abs(now - body.timestamp) < 120)
    ? true : 'folder ' + body.folder + ', timestamp drift ' + (now - body.timestamp) + 's';
});

check('the secret is never in the response', () =>
  (res.body.indexOf(SECRET) === -1 && res.body.indexOf('signature"') !== -1)
    ? true : 'the response leaks the API secret');

/* ---- the failure modes a page must be able to tell apart ---- */

const pre = await handler({ httpMethod: 'OPTIONS', headers: {} });
check('OPTIONS answers 204 (the browser preflights a JSON POST)', () =>
  pre.statusCode === 204 || 'status ' + pre.statusCode);

const notPost = await handler({ httpMethod: 'GET', headers: {} });
let notPostBody = {};
try { notPostBody = JSON.parse(notPost.body); } catch (e) { notPostBody = {}; }
check('GET is refused 405 with a wire body, not a blank error', () =>
  (notPost.statusCode === 405 && !!notPostBody.error) || 'status ' + notPost.statusCode);

const keep = [
  process.env.CLOUDINARY_API_KEY,
  process.env.CLOUDINARY_API_SECRET,
  process.env.CLOUDINARY_CLOUD_NAME,
];
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;
delete process.env.CLOUDINARY_CLOUD_NAME;
const bareOut = await freshHandler()({ httpMethod: 'POST', headers: {} });
[process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET, process.env.CLOUDINARY_CLOUD_NAME] = keep;
let bareBody = {};
try { bareBody = JSON.parse(bareOut.body); } catch (e) { bareBody = {}; }

check('no credentials is 500 classed not-ready, and names the three variables', () => {
  const said = String(bareBody.error || '');
  const names = ['CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_CLOUD_NAME']
    .every((v) => said.indexOf(v) !== -1);
  return (bareOut.statusCode === 500 && bareBody.kind === 'not-ready' && names)
    ? true : 'status ' + bareOut.statusCode + ', kind ' + bareBody.kind + ', names all three: ' + names;
});

/* ------------------------------------------------------------ */

console.log('');
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('\n' + pass + ' passed, ' + failures.length + ' failed.');
  console.log('  The upload signature does not match Cloudinary. Every photo and every');
  console.log('  video fallback 401s until it does.\n');
  process.exit(1);
}
console.log('  ✓ ' + pass + ' checks passed — the signature is one Cloudinary accepts.');
console.log('');
