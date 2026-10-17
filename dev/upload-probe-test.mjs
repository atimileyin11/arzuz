#!/usr/bin/env node
/* ============================================================
   Arzuz — can the upload probe tell a good signature from a bad one?

   scripts/smoke-upload.mjs and the scheduled upload-health function
   both decide "are uploads working?" from one signal: Cloudinary
   answering 400 "Missing required parameter - file" instead of 401.
   If that reading is wrong, the smoke test is theatre — a green line
   after a deploy that proves nothing, which is exactly the failure
   mode it was built to end.

   So this file stands up a local endpoint that behaves like the two
   real ones, and makes the probe judge it:

     correct signature, no file      → 400, probe passes
     wrong signature                 → 401, probe fails as "rejects"
     endpoint that accepts anything  → probe fails as "probe", because
                                       its own sanity request was not
                                       refused and a green would be a lie
     signer down / missing fields / stale timestamp / non-JSON
                                     → each fails at "sign", by name

   No network, no Cloudinary, no credentials: the arithmetic is local
   and the endpoint is a few lines of http.

   Run:  node dev/upload-probe-test.mjs
   ============================================================ */

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { probeUpload } = require('../netlify/functions/lib/upload-probe.js');

const CLOUD = 'testcloud';
const GOOD = 'a'.repeat(40);

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    return Promise.resolve(fn()).then((out) => {
      if (out === true || out === undefined) { pass++; return; }
      failures.push(name + '\n      → ' + out);
    }).catch((err) => {
      failures.push(name + '\n      → threw: ' + (err && err.message));
    });
  } catch (err) {
    failures.push(name + '\n      → threw: ' + (err && err.message));
    return Promise.resolve();
  }
}

/* mode:
   'ok'        the signer is correct and the endpoint validates
   'badsig'    the signer returns a signature the endpoint refuses
   'noSane'    the endpoint accepts every signature (the blind case)
   'signer500' the signer answers 500 with a sentence */
let mode = 'ok';
let stale = false;
let omit = null;
let signBody = 'json';

function signer() {
  const body = {
    signature: mode === 'badsig' ? 'b'.repeat(40) : GOOD,
    timestamp: stale ? Math.floor(Date.now() / 1000) - 7200 : Math.floor(Date.now() / 1000),
    api_key: 'key',
    cloud_name: CLOUD,
    folder: 'arzuz-buildings',
    eager: 'c_limit,w_1600,q_auto,f_auto',
    context: 'caption=test',
    max_file_size: 10485760,
  };
  if (omit) delete body[omit];
  return body;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/cloudinary-sign') {
      if (mode === 'signer500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Photo storage is not configured on this deploy' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (signBody === 'garbage') return res.end('<html>not json</html>');
      return res.end(JSON.stringify(signer()));
    }

    if (req.url === '/cl/' + CLOUD + '/image/upload') {
      const sig = (body.match(/name="signature"\r\n\r\n([0-9a-f]+)/) || [])[1] || '';
      const hasFile = /name="file"/.test(body);
      if (mode === 'noSane') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Missing required parameter - file' } }));
      }
      if (sig !== GOOD) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid Signature ' + sig } }));
      }
      if (!hasFile) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Missing required parameter - file' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ secure_url: 'https://res.cloudinary.com/x/y.png' }));
    }

    res.writeHead(404); res.end('no');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

try {
  await check('a correct signature passes, at the "accepts" stage', async () => {
    mode = 'ok'; stale = false; omit = null; signBody = 'json';
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    return (r.ok && r.stage === 'accepts') ? true : 'got ' + JSON.stringify(r);
  });

  await check('a signature the endpoint refuses fails, and says Invalid Signature', async () => {
    mode = 'badsig';
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    return (!r.ok && r.stage === 'rejects' && /invalid signature/i.test(r.message))
      ? true : 'got ' + JSON.stringify(r);
  });

  await check('an endpoint that accepts anything is reported as a broken probe, not a pass', async () => {
    mode = 'noSane';
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    return (!r.ok && r.stage === 'probe' && /tampered/.test(r.message))
      ? true : 'a blind endpoint produced ' + JSON.stringify(r);
  });

  await check('a signer that is down fails at "sign", with its own sentence', async () => {
    mode = 'signer500';
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    return (!r.ok && r.stage === 'sign' && /not configured/.test(r.message))
      ? true : 'got ' + JSON.stringify(r);
  });

  await check('a signer missing cloud_name fails at "sign" and names the field', async () => {
    mode = 'ok'; omit = 'cloud_name';
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    omit = null;
    return (!r.ok && r.stage === 'sign' && /cloud_name/.test(r.message))
      ? true : 'got ' + JSON.stringify(r);
  });

  await check('a stale timestamp fails at "sign"', async () => {
    stale = true;
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    stale = false;
    return (!r.ok && r.stage === 'sign' && /not fresh/.test(r.message))
      ? true : 'got ' + JSON.stringify(r);
  });

  await check('a signer that answers HTML fails at "sign" instead of throwing', async () => {
    signBody = 'garbage';
    const r = await probeUpload({ base, uploadBase: base + '/cl' });
    signBody = 'json';
    return (!r.ok && r.stage === 'sign') ? true : 'got ' + JSON.stringify(r);
  });

  await check('a site that cannot be reached fails at "sign", not with a thrown promise', async () => {
    const r = await probeUpload({ base: 'http://127.0.0.1:9', uploadBase: base + '/cl' });
    return (!r.ok && r.stage === 'sign') ? true : 'got ' + JSON.stringify(r);
  });
} finally {
  server.close();
}

console.log('');
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('\n' + pass + ' passed, ' + failures.length + ' failed.');
  console.log('  The smoke test cannot be trusted until these pass.\n');
  process.exit(1);
}
console.log('  ✓ ' + pass + ' checks passed — the probe tells a good signature from a bad one.');
console.log('');
