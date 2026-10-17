/* ============================================================
   Arzuz — Netlify Function: Cloudinary signed upload helper

   Returns a short-lived signed upload signature so the browser
   can POST directly to Cloudinary without exposing the API secret.

   Environment variables (set in Netlify dashboard — Site settings
   → Environment variables). Values never appear in this file or
   in any page source:
     CLOUDINARY_API_KEY    – your cloud's API key
     CLOUDINARY_API_SECRET – your cloud's API secret (keep it here only)
     CLOUDINARY_CLOUD_NAME – your cloud name
   ============================================================ */

const crypto = require('crypto');

/* The shared failure vocabulary — the SAME file the pages load, so the
   class in this body is the class assets/app.js, assets/admin.js and
   assets/complete-listing.js read, not a second guess at the status. */
const ApiErrors = require('../../assets/api-errors.js');

/* Copyright context stamped into every uploaded asset. Plain ASCII
   so the signature survives every client and encoding path — the
   visible "©" treatment is applied by the site itself. */
const COPYRIGHT_CONTEXT =
  'caption=(c) Arzuz 2026 - verified apartment media|alt=Verified apartment media by Arzuz';

exports.handler = async function (event) {
  // CORS pre-flight
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify(ApiErrors.wireBody(405, { error: 'Method not allowed' })),
    };
  }

  const API_KEY    = process.env.CLOUDINARY_API_KEY;
  const API_SECRET = process.env.CLOUDINARY_API_SECRET;
  const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

  if (!API_KEY || !API_SECRET || !CLOUD_NAME) {
    /* The status stays 500 — changing it is not this file's business —
       but the CLASS is 'not-ready', because a deploy with no Cloudinary
       credentials is not something to try again in a minute: every
       photo would fail identically forever, and the class is what tells
       the page that (it switches the upload button off instead of
       asking someone to press it again). This is the case the wire
       class exists for. */
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify(ApiErrors.wireBody(500, {
        /* The sentence names the fix. "not configured" alone told an
           operator there was a problem without saying which three
           variables to add — and this is the one failure that kills
           every photo upload until somebody does. */
        error: 'Photo storage is not configured on this deploy: CLOUDINARY_API_KEY, ' +
          'CLOUDINARY_API_SECRET and CLOUDINARY_CLOUD_NAME are not set in Netlify.',
      }, 'not-ready'))
    };
  }

  const timestamp    = Math.floor(Date.now() / 1000);
  const folder       = 'arzuz-buildings';
  const eager        = 'c_limit,w_1600,q_auto,f_auto';   // auto-compress on upload
  const maxFileSize  = 10 * 1024 * 1024;                 // 10 MB, matches the form copy
  const context      = COPYRIGHT_CONTEXT;                // copyright metadata on the asset

  // Build the string-to-sign exactly as Cloudinary expects:
  // signable params in alphabetical order, secret appended last.
  // max_file_size is part of the signature, so an oversized file
  // is rejected by Cloudinary itself — the signature cannot be
  // reused for something bigger than what we approved.
  const paramsToSign =
    `context=${context}&eager=${eager}&folder=${folder}&max_file_size=${maxFileSize}&timestamp=${timestamp}${API_SECRET}`;
  const signature    = crypto.createHash('sha1').update(paramsToSign, 'utf8').digest('hex');

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      signature,
      timestamp,
      api_key:      API_KEY,
      cloud_name:   CLOUD_NAME,
      folder,
      eager,
      context,
      max_file_size: maxFileSize,
    }),
  };
};
