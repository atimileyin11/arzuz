#!/usr/bin/env node
/* ============================================================
   Arzuz — one-time YouTube channel authorization

   Mints the YOUTUBE_REFRESH_TOKEN that netlify/functions/
   youtube-upload-start.js uses to upload unlisted video tours
   to the Arzuz channel. Run this ONCE, locally:

     1. Google Cloud Console (console.cloud.google.com):
        - create/select a project
        - APIs & Services → Library → enable "YouTube Data API v3"
        - APIs & Services → OAuth consent screen → External,
          add yourself as a test user (test mode is fine)
        - APIs & Services → Credentials → Create credentials →
          OAuth client ID → Web application
          Authorized redirect URI: http://localhost:8765
     2.   node scripts/youtube-auth.mjs <CLIENT_ID> <CLIENT_SECRET>
        (sign in with the Google account that owns the channel
         the tours should live on — a brand account is ideal)
     3. Put the three printed values into Netlify env vars:
          GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN

   Node 18+ (uses global fetch). No dependencies.
   ============================================================ */

const http = require('http');
const { URL, URLSearchParams } = require('url');

const CLIENT_ID = process.argv[2] || process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8765';
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/youtube-auth.mjs <GOOGLE_CLIENT_ID> <GOOGLE_CLIENT_SECRET>');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',   // we need the refresh token
  prompt: 'consent',        // forces a refresh token even on re-consent
}).toString();

console.log('\n1. Open this URL in the browser signed into the Arzuz channel account:\n');
console.log(authUrl.toString() + '\n');
console.log('2. Approve the "unverified app" warning (Advanced → Go to project) — it is your own test app.\n');

/* catch the redirect on localhost and finish the exchange */
const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url, REDIRECT_URI);
  if (incoming.pathname !== '/') return; // favicon etc.

  const code = incoming.searchParams.get('code');
  const err = incoming.searchParams.get('error');
  if (err || !code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Authorization failed: ' + (err || 'no code'));
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<meta charset="utf-8"><body style="font-family:sans-serif"><h2>✅ Authorized.</h2><p>Go back to the terminal for your refresh token. You can close this tab.</p>');
  server.close();

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    const body = await tokenRes.json();
    if (!body.refresh_token) {
      console.error('No refresh token came back:', JSON.stringify(body).slice(0, 400));
      console.error('Re-run with prompt=consent (this script already sets it) and make sure the app is in testing mode.');
      process.exit(1);
    }
    console.log('\n3. Set these three variables in Netlify (Site settings → Environment variables):\n');
    console.log('   GOOGLE_CLIENT_ID      = ' + CLIENT_ID);
    console.log('   GOOGLE_CLIENT_SECRET  = ' + CLIENT_SECRET);
    console.log('   YOUTUBE_REFRESH_TOKEN = ' + body.refresh_token);
    console.log('\n   (Never put these in any page source — server env vars only.)');
    console.log('\nDone. Video tours now upload as unlisted videos to that channel.\n');
  } catch (e) {
    console.error('Token exchange failed:', e.message);
    process.exit(1);
  }
});

server.listen(8765, () => console.log('3. Waiting for the OAuth redirect on http://localhost:8765 ...\n'));
