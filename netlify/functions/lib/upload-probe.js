/* ============================================================
   Arzuz — does the live upload signature actually work?

   THE FAILURE THIS EXISTS FOR

     `/api/cloudinary-sign` answered 200 on the deployed site for
     weeks while every single upload was refused with `401 Invalid
     Signature`. The signer put one parameter in the hash that
     Cloudinary excludes, so the two could never agree — and nothing
     in the signed response said so. A green health check that only
     asked "does the function respond?" would have passed the whole
     time.

   HOW IT ASKS WITHOUT LEAVING ANYTHING BEHIND

     Cloudinary validates the signature BEFORE it looks for the file.
     So the probe sends a real signed request with the file omitted:

       signature valid   → 400 "Missing required parameter - file"
       signature invalid → 401 "Invalid Signature"

     That is a full round-trip through the real signer and the real
     upload endpoint, and it stores nothing: no asset, no folder, no
     cleanup. A probe that uploaded a file would leave 48 junk assets
     a day behind it if it ran on a schedule.

     AND IT CHECKS ITSELF. A probe that treats any non-2xx as "fine"
     would pass while the endpoint rejected everything. So a second
     request flips one byte of the signature and REQUIRES a 401. If
     the tampered request is not refused, the first result proves
     nothing and the probe says so.

   WHY THE 400 IS THE PASS

     It looks backwards, and it is the whole trick: "missing file" is
     the endpoint telling you it read your signature, liked it, and
     moved on to the next requirement. 401 is the endpoint refusing
     you before it looked at anything else.

   Used by:
     · scripts/smoke-upload.mjs    — after a deploy, from a shell/CI
     · netlify/functions/upload-health.js — on a schedule, with an alert
   ============================================================ */

const DEFAULT_CLOUDINARY = 'https://api.cloudinary.com/v1_1';

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    fd.append(k, String(v));
  }
  return fd;
}

async function post(url, fields) {
  const res = await fetch(url, { method: 'POST', body: form(fields) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  return { status: res.status, body, text: text.slice(0, 400) };
}

function cloudinaryMessage(body, text) {
  if (body && body.error && body.error.message) return String(body.error.message);
  return text || '(no body)';
}

/**
 * @param {object} opts
 * @param {string} [opts.base]         site origin, e.g. https://arzuz.com
 * @param {string} [opts.uploadBase]   Cloudinary API base (tests override it)
 * @param {boolean} [opts.sanity]      require the tampered request to be refused (default true)
 * @returns {Promise<{ok: boolean, stage: string, message: string, status?: number}>}
 */
async function probeUpload(opts = {}) {
  const base = String(opts.base || 'https://arzuz.com').replace(/\/+$/, '');
  const uploadBase = String(opts.uploadBase || DEFAULT_CLOUDINARY).replace(/\/+$/, '');
  const sanity = opts.sanity !== false;

  /* 1. the deployed signer */
  let sign;
  try {
    const res = await fetch(base + '/api/cloudinary-sign', { method: 'POST' });
    const text = await res.text();
    if (res.status !== 200) {
      let body = null;
      try { body = JSON.parse(text); } catch (_) { body = null; }
      return {
        ok: false,
        stage: 'sign',
        status: res.status,
        message: (body && body.error) || ('the signer answered ' + res.status + ': ' + text.slice(0, 200)),
      };
    }
    sign = JSON.parse(text);
  } catch (err) {
    return { ok: false, stage: 'sign', message: 'the site did not answer: ' + err.message };
  }

  const missing = ['signature', 'api_key', 'timestamp', 'cloud_name', 'folder', 'eager', 'context']
    .filter((k) => !sign[k]);
  if (missing.length) {
    return { ok: false, stage: 'sign', message: 'the signer left out: ' + missing.join(', ') };
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(sign.timestamp)) > 300) {
    return { ok: false, stage: 'sign', message: 'the timestamp is not fresh (' + sign.timestamp + ')' };
  }

  const url = uploadBase + '/' + sign.cloud_name + '/image/upload';
  const fields = {
    api_key: sign.api_key,
    timestamp: sign.timestamp,
    signature: sign.signature,
    folder: sign.folder,
    eager: sign.eager,
    context: sign.context,
    /* sent, never signed — Cloudinary's own rule */
    max_file_size: sign.max_file_size,
  };

  /* 2. the real endpoint, with no file: the signature is read first */
  const probe = await post(url, fields);
  const message = cloudinaryMessage(probe.body, probe.text);

  if (probe.status === 401) {
    return { ok: false, stage: 'rejects', status: 401, message: 'Cloudinary rejects the signature: ' + message };
  }
  if (probe.status !== 400 || !/missing required parameter/i.test(message)) {
    return {
      ok: false,
      stage: 'unknown',
      status: probe.status,
      message: 'unexpected answer from the upload endpoint: ' + probe.status + ' ' + message,
    };
  }

  /* 3. the probe must be able to fail, or step 2 proved nothing */
  if (sanity) {
    const flipped = sign.signature.slice(0, 1) === '0' ? '1' + sign.signature.slice(1) : '0' + sign.signature.slice(1);
    const bad = await post(url, Object.assign({}, fields, { signature: flipped }));
    if (bad.status !== 401) {
      return {
        ok: false,
        stage: 'probe',
        status: bad.status,
        message: 'the endpoint accepted a tampered signature (' + bad.status + ') — this check cannot see a bad signature, so its green means nothing',
      };
    }
  }

  return { ok: true, stage: 'accepts', message: 'the signature is one Cloudinary accepts' };
}

module.exports = { probeUpload };
