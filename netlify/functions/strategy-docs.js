/* ============================================================
   Arzuz — Netlify Function: private strategy docs

   The strategy pack (strategy/*.md) is business IP: pricing
   plans, competitor notes, unverified [ESTIMATE] figures. It
   must not be fetchable on the open internet, so:

     - /strategy/* on the public site is forced to 404
       (netlify.toml, force = true),
     - the markdown ships only inside the function sandbox
       (included_files) and is served exclusively by THIS
       function, which first verifies the caller's Supabase
       Auth session against Supabase's /auth/v1/user,
     - filenames are whitelisted (no path traversal, no
       dot-segment tricks — an unknown name is a 404),
     - responses are no-store so nothing lingers in shared
       caches.

   Routing (netlify.toml):
     /strategy-docs → this function (status 200)
   The dashboard calls it as /strategy-docs?name=<file.md>
   with the signed-in JWT as the Bearer token (auth.js
   supplies it via ArzuzAuth.headers()).
   ============================================================ */

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* The exact shipped documents. Anything else → 404. */
const DOCS = {
  'README.md': true,
  '01-market-sizing-tam-sam-som.md': true,
  '02-customer-icp-jtbd-journey.md': true,
  '03-competition-porters-five-forces.md': true,
  '04-pesteL.md': true,
  '05-positioning-stp.md': true,
  '06-channels-bullseye.md': true,
  '07-unit-economics-ltv-cac.md': true,
};

/* The shared failure vocabulary — the SAME file the page loads, so the
   class in this body is the class assets/strategy.js reads, not a
   second guess at the same status code. */
const ApiErrors = require('../../assets/api-errors.js');

function json(status, obj, kind) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(ApiErrors.wireBody(status, obj, kind)),
  };
}

/* A JWT is only trusted after Supabase itself says it is live —
   the anon key is public, so "the token decodes" proves nothing. */
async function verifyToken(token) {
  if (!token || token.length < 20) return null;
  try {
    const res = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    console.warn('[strategy-docs] token check failed:', e && e.message);
    return null;
  }
}

exports.handler = async function (event) {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  const user = await verifyToken(token);
  if (!user) {
    /* The dashboard holds a session, so a 401 is a token to renew. */
    return json(401, { error: 'Sign in to the Arzuz dashboard to read the strategy pack.' }, 'expired');
  }

  const name = (event.queryStringParameters && event.queryStringParameters.name) || '';
  if (!Object.prototype.hasOwnProperty.call(DOCS, name)) {
    /* 'not-ready', not 'rejected': the dashboard only ever asks for the
       names it lists, so a 404 here means the file is not in this
       deployment — which is what the admin pane says in its own words
       ("This document is not in the deployment"). One class, one
       meaning, both ends. */
    return json(404, { error: 'Unknown strategy document.' }, 'not-ready');
  }

  let md;
  try {
    md = await require('fs').promises.readFile(
      require('path').join(__dirname, 'strategy', name),
      'utf8'
    );
  } catch (e) {
    console.error('[strategy-docs] missing from sandbox:', name, e && e.message);
    return json(500, { error: 'Strategy document missing from deployment.' }, 'not-ready');
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: md,
  };
};
