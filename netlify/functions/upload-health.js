/* ============================================================
   Arzuz — Netlify Function: is media upload switched on, right now?

   THE FAILURE THIS EXISTS FOR

     Every photo upload on the live site was refused with `401 Invalid
     Signature` while `/api/cloudinary-sign` kept answering `200`. No
     page error reached the team, no function logged anything, and the
     first person to notice was a landlord trying to add an apartment.
     It ran for weeks.

   WHAT IT DOES EVERY HALF HOUR

     Runs the probe in lib/upload-probe.js: signs on this deployment,
     then asks Cloudinary to accept that signature with no file
     attached. Valid → 400 "Missing required parameter - file".
     Broken → 401. It also tampers with the signature once and
     requires the endpoint to refuse THAT, so a probe that cannot see
     a bad signature does not report a green one.

     On failure it pages the team through sendAlert — the same channel
     every other "our side broke" alert uses — with the class and the
     one sentence an operator can act on. notify.js already rate-limits
     server alerts, so an outage cannot page 48 times a day.

   NO ASSETS ARE STORED. The probe never sends a file, which is why it
   can run this often: a check that uploaded would leave thousands of
   68-byte orphans in the media library.

   WHO MAY ASK

     Anyone may poke it; the run happens either way and the alert never
     depends on who asked. But the DETAIL is operator information — so
     the body is reduced to ok/health for a caller without the
     x-arzuz-hook header matching UPLOAD_HEALTH_SECRET. An unset secret
     means "no detail", never "no secret required".

   Scheduled in netlify.toml — a missing schedule deploys fine and
   never runs, which is the same silent failure this function is here
   to catch.
   ============================================================ */

const { probeUpload } = require('./lib/upload-probe.js');
const { sendAlert } = require('./notify.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-arzuz-hook',
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const h = (event && event.headers) || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return String(h[k] || '');
  return '';
}

function isOperator(event) {
  const expected = String(process.env.UPLOAD_HEALTH_SECRET || '').trim();
  const given = header(event, 'x-arzuz-hook').trim();
  /* Timing-safe enough for a shared hook: compare lengths first, then
     every character, so an early mismatch cannot be timed. */
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function alert(probe) {
  return sendAlert(
    '\u26a0\ufe0f <b>Media upload is broken on the live site</b>\n\n' +
    'Photos and video tours are being refused. A landlord adding an apartment will lose the media.\n\n' +
    'Stage: <b>' + probe.stage + '</b>' + (probe.status ? ' (HTTP ' + probe.status + ')' : '') + '\n' +
    probe.message + '\n\n' +
    'Check: node scripts/smoke-upload.mjs\n' +
    'The signature is built in netlify/functions/cloudinary-sign.js.'
  );
}

exports.handler = async function (event) {
  if (event && String(event.httpMethod || '').toUpperCase() === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  let probe;
  try {
    probe = await probeUpload({ base: process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://arzuz.com' });
  } catch (err) {
    probe = { ok: false, stage: 'probe', message: 'the probe itself threw: ' + (err && err.message) };
  }

  if (!probe.ok) await alert(probe);

  const operator = isOperator(event);
  if (!operator) {
    /* The fact is public enough to be a health answer; the reason is
       operator information and names a fix. */
    return json(probe.ok ? 200 : 503, { ok: probe.ok, health: probe.ok ? 'accepts' : 'rejects' });
  }

  return json(probe.ok ? 200 : 503, {
    ok: probe.ok,
    stage: probe.stage,
    status: probe.status || null,
    message: probe.message,
    checked_at: new Date().toISOString(),
  });
};
