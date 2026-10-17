/* ============================================================
   Arzuz — scheduled: is media upload still switched on?

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
     Broken → 401. It then tampers with the signature once and
     requires a 401, so a probe that cannot see a bad signature cannot
     report a green one.

     On failure it pages the team through sendAlert — the same channel
     every other "our side broke" alert uses — with the stage and the
     sentence an operator can act on. notify.js rate-limits server
     alerts, so an outage cannot page 48 times a day.

   NO ASSETS ARE STORED. The probe never sends a file, which is why it
   can run this often: a check that uploaded would leave thousands of
   68-byte orphans in the media library.

   IT CANNOT BE CALLED WITH HTTP, AND THAT IS NETLIFY'S RULE

     A function with a `schedule` answers 403 to every external request
     before its code runs — this one was built as a health endpoint
     first and returned an empty 403 when curled, which is how the
     rule was learned. So there is no operator gate here: it could
     never run. For a check you can run yourself, after a deploy or
     from CI, use scripts/smoke-upload.mjs, which drives the same
     probe from a shell. This function's only outputs are the scheduler
     run and the alert.

   Scheduled in netlify.toml. A missing schedule deploys fine and never
   runs — the same silent failure this function exists to catch, which
   is why the line is not left to memory.
   ============================================================ */

const { probeUpload } = require('./lib/upload-probe.js');
const { sendAlert } = require('./notify.js');

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

exports.handler = async function () {
  let probe;
  try {
    probe = await probeUpload({ base: process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://arzuz.com' });
  } catch (err) {
    probe = { ok: false, stage: 'probe', message: 'the probe itself threw: ' + (err && err.message) };
  }

  if (!probe.ok) {
    const sent = await alert(probe);
    console.error('[upload-health] ' + probe.stage + ': ' + probe.message + ' (alert sent: ' + sent + ')');
    /* Thrown rather than returned so the failed run is marked failed in
       the function log — the alert is the page, the log is the record. */
    throw new Error('upload health: ' + probe.stage + ' — ' + probe.message);
  }

  console.log('[upload-health] ok — ' + probe.message);
  return { statusCode: 200, body: JSON.stringify({ ok: true, stage: probe.stage }) };
};
