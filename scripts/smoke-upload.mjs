#!/usr/bin/env node
/* ============================================================
   Arzuz — post-deploy smoke test: can a landlord actually upload?

   Run this after a deploy, or from CI against the deployed URL:

     node scripts/smoke-upload.mjs                    # the live site
     node scripts/smoke-upload.mjs --base=http://127.0.0.1:8799
     node scripts/smoke-upload.mjs --upload           # also store one 1x1

   The default check is the zero-debris probe in
   netlify/functions/lib/upload-probe.js: sign on the live site, then
   ask Cloudinary to accept that signature with no file attached. A
   valid signature answers 400 "Missing required parameter - file"; a
   broken one answers 401. It also tampers with the signature and
   requires the endpoint to refuse it, so the probe cannot pass by
   being blind.

   --upload goes one step further and stores a real 1x1 PNG, which is
   the only way to prove the bytes travel. It leaves a 68-byte asset
   in the Cloudinary library each time (no delete credential here), so
   it is opt-in and not what runs on a schedule.

   Exit 0 only when the whole probe passed. The reason is printed in
   words either way — "Invalid Signature" is the sentence that would
   have saved weeks.
   ============================================================ */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { probeUpload } = require('../netlify/functions/lib/upload-probe.js');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const base = arg('base', 'https://arzuz.com');
const withUpload = process.argv.includes('--upload');

const ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

console.log('\nArzuz upload smoke test — ' + base);

const probe = await probeUpload({ base });
if (!probe.ok) {
  console.log('  ✗ ' + probe.stage.toUpperCase() + ' — ' + probe.message);
  console.log('\n  Photo and video uploads are broken on this deployment.');
  console.log('  A landlord sees "Cloudinary rejected the upload" and loses the photos.\n');
  process.exit(1);
}
console.log('  ✓ signature accepted by Cloudinary (' + probe.message + ')');

if (!withUpload) {
  console.log('  · skipped the stored upload (--upload to write one 1x1 PNG)\n');
  process.exit(0);
}

/* The full path: a real file through the same signature. */
const signRes = await fetch(base + '/api/cloudinary-sign', { method: 'POST' });
const sign = await signRes.json();
const fd = new FormData();
fd.append('file', new Blob([ONE_PIXEL], { type: 'image/png' }), 'smoke-1x1.png');
for (const k of ['api_key', 'timestamp', 'signature', 'folder', 'eager', 'max_file_size', 'context']) {
  if (sign[k] !== undefined) fd.append(k, String(sign[k]));
}
const up = await fetch('https://api.cloudinary.com/v1_1/' + sign.cloud_name + '/image/upload', {
  method: 'POST', body: fd,
});
const body = await up.text();

if (up.status !== 200) {
  console.log('  ✗ UPLOAD — HTTP ' + up.status + ' ' + body.slice(0, 300));
  console.log('\n  The signature was accepted but the file was refused. Uploads are broken.\n');
  process.exit(1);
}

let stored = null;
try { stored = JSON.parse(body); } catch (_) { stored = null; }
console.log('  ✓ stored ' + (stored && stored.secure_url ? stored.secure_url : '(unreadable response)'));
if (stored && stored.public_id) {
  console.log('  · this run left arzuz/' + stored.public_id + ' (68 bytes) in the media library');
}
console.log('');
