/* ============================================================
   Arzuz — Netlify Function: YouTube video upload starter

   Video tours are stored on YouTube as UNLISTED videos. The
   browser asks this function to open a resumable upload session,
   then streams the file DIRECTLY to Google — the video bytes
   never pass through Netlify.

   Environment variables (Netlify dashboard → Site settings →
   Environment variables — values never appear in page source):
     GOOGLE_CLIENT_ID       – OAuth web client id
     GOOGLE_CLIENT_SECRET   – OAuth web client secret
     YOUTUBE_REFRESH_TOKEN  – long-lived token for the Arzuz
                              channel account (see scripts/
                              youtube-auth.mjs for the one-time
                              setup, documented in SETUP.md)

   POST /api/youtube-upload-start   { filename, size, contentType, title }
     → { uploadUrl }                the browser PUTs the file here
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_BYTES     = 200 * 1024 * 1024;   // 200 MB cap for video tours
const REFRESH_URL   = 'https://oauth2.googleapis.com/token';
const UPLOAD_API    = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const TOKEN_TTL_MS  = 50 * 60 * 1000;      // refresh safely before the 1 h expiry

/* Access tokens live ~1 h; cache one in module scope so a burst of
   uploads does not hammer the token endpoint. Netlify keeps the
   module warm between invocations often enough for this to help. */
let cachedToken = { token: '', expiresAt: 0 };

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

async function getAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw Object.assign(new Error(
      'Video uploads are not configured on the server yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN).'
    ), { status: 503 });
  }
  if (cachedToken.token && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    /* a revoked/rotated refresh token must not stay cached */
    cachedToken = { token: '', expiresAt: 0 };
    throw Object.assign(new Error(
      'Google rejected the stored channel token (' + (body.error || res.status) + '). Re-run scripts/youtube-auth.mjs to mint a new one.'
    ), { status: 502 });
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return cachedToken.token;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' });

  try {
    const req = JSON.parse(event.body || '{}');
    const size = Number(req.size);
    if (!size || size < 1024)  return json(400, { error: 'Missing or invalid video size' });
    if (size > MAX_BYTES)      return json(413, { error: 'Video is too large — the limit is 200 MB' });

    const contentType = /^video\//.test(String(req.contentType || '')) ? req.contentType : 'video/mp4';

    const token = await getAccessToken();

    /* Metadata kept deliberately generic: unlisted videos are reachable
       by anyone holding the link, so nothing identifying lands in it. */
    const metadata = {
      snippet: {
        title: String(req.title || 'Apartment video tour').slice(0, 90),
        description: '(c) Arzuz 2026 - verified apartment media',
        tags: ['arzuz'],
        categoryId: '19',                       // Travel & Events
      },
      status: {
        privacyStatus: 'unlisted',              // the whole point — no search, no channel page
        selfDeclaredMadeForKids: false,
      },
    };

    const init = await fetch(UPLOAD_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify(metadata),
    });

    const uploadUrl = init.headers.get('location');
    if (!init.ok || !uploadUrl) {
      let detail = '';
      try { detail = JSON.stringify(await init.json()).slice(0, 300); } catch (e) { /* HTML error body */ }
      throw Object.assign(new Error('YouTube refused the upload session (' + init.status + ') ' + detail), { status: 502 });
    }

    return json(200, { uploadUrl, maxBytes: MAX_BYTES });
  } catch (err) {
    console.error('[youtube-upload-start]', err.message);
    return json(err.status || 500, { error: err.message || 'Could not start the video upload' });
  }
};
