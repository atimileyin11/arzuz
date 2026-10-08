/* ============================================================
   Arzuz — Netlify Function: video embed proxy

   GET /api/video-embed/<11-char id>[?autoplay=1][&controls=1]

   302-redirects to the privacy-enhanced YouTube embed with every
   branding/interaction parameter switched off. This keeps the raw
   youtube.com URL out of the page source and gives video.js one
   place to own the player settings. Used directly as the iframe
   fallback src and for the landlord preview player.
   ============================================================ */

const CORS = { 'Access-Control-Allow-Origin': '*' };

exports.handler = async function (event) {
  /* redirect /api/* → /.netlify/functions/:splat keeps the whole
     splat in event.path, so the id is the last path segment */
  const id = String(event.path.split('/').pop() || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    return { statusCode: 404, headers: CORS, body: 'Not a video id' };
  }

  const q = event.queryStringParameters || {};
  const params = new URLSearchParams({
    /* controls=0 + our own chrome is the default; ?controls=1 keeps
       YouTube's bar for landlord-preview contexts */
    controls:        q.controls === '1' ? '1' : '0',
    rel:             '0',   // no unrelated videos at the end
    modestbranding:  '1',   // no YouTube logo in the corner
    iv_load_policy:  '3',   // no annotations
    fs:              '0',   // YouTube's own fullscreen button off (we provide one)
    disablekb:       '1',   // keyboard handled by our player
    playsinline:     '1',   // iOS: play inside the page
    enablejsapi:     '1',   // required so video.js can drive playback
  });
  if (q.autoplay === '1') params.set('autoplay', '1');

  return {
    statusCode: 302,
    headers: {
      Location: 'https://www.youtube-nocookie.com/embed/' + id + '?' + params.toString(),
      'Cache-Control': 'no-store',
      ...CORS,
    },
    body: '',
  };
};
