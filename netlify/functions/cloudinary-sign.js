/* ============================================================
   Arzuz — Netlify Function: Cloudinary signed upload helper

   Returns a short-lived signed upload signature so the browser
   can POST directly to Cloudinary without exposing the API secret.

   Environment variables (set in Netlify dashboard):
     CLOUDINARY_API_KEY    – 879621267632718
     CLOUDINARY_API_SECRET – 3klddUOrhMI45s_ejS9bJMywBnU
     CLOUDINARY_CLOUD_NAME – zrptjhes
   ============================================================ */

const crypto = require('crypto');

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
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const API_KEY    = process.env.CLOUDINARY_API_KEY    || '879621267632718';
  const API_SECRET = process.env.CLOUDINARY_API_SECRET || '3klddUOrhMI45s_ejS9bJMywBnU';
  const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'zrptjhes';

  const timestamp  = Math.floor(Date.now() / 1000);
  const folder     = 'arzuz-buildings';
  const eager      = 'c_limit,w_1600,q_auto,f_auto';   // auto-compress on upload

  // Build the string-to-sign exactly as Cloudinary expects
  const paramsToSign = `eager=${eager}&folder=${folder}&timestamp=${timestamp}${API_SECRET}`;
  const signature    = crypto.createHash('sha1').update(paramsToSign).digest('hex');

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      signature,
      timestamp,
      api_key:    API_KEY,
      cloud_name: CLOUD_NAME,
      folder,
      eager,
    }),
  };
};
