/* ============================================================
   Arzuz — Netlify Function: is the YouTube upload path switched on?

   The failure this answers. A video tour can be refused three
   different ways, and from the browser they all look like "the
   upload did not work":

     · the three GOOGLE_* / YOUTUBE_* variables are not in this
       deployment at all (a 503 that means "not switched on"),
     · they are there but the client id/secret pair is wrong,
     · they are there and correct but the refresh token was
       revoked, rotated, or minted for a different client.

   Only the server can tell those apart, and until now the only way
   to ask was to attach a real video and watch it fail. This answers
   from the deployed site in one request, and it answers WITHOUT
   PUTTING A SECRET ON THE WIRE — every field below is a boolean, a
   scope name, or a sentence about what happened. There is no code
   path here that echoes a client secret or a refresh token, which
   is why the shape checks return true/false and never the value.

   WHY THE LIVE CHECK IS A REFRESH EXCHANGE
     The token this deployment holds has the `youtube.upload` scope
     only — deliberately, because it only ever needs to upload. It
     therefore CANNOT call channels?mine=true: that needs
     youtube.readonly, and a check built on it reports a perfectly
     good upload token as broken. (That mistake already shipped once
     in scripts/youtube-auth.mjs.) So health is measured by doing
     exactly what the upload function does first: exchange the
     refresh token for an access token.

     That exchange costs NO YouTube quota — it is an OAuth call, and
     the Data API's 10,000 units/day are not involved. It is also
     the exchange that fails when a refresh token is revoked, which
     is the failure that actually happens in production.

   ?deep=1 ADDS THE UPLOAD PROBE, AND IT IS NOT FREE
     An opt-in deep check opens a real resumable upload session
     against YouTube — the same first call youtube-upload-start
     makes. YouTube accepts it and no bytes are sent, but it is the
     request the free tier charges as a video insert (~1,600 units
     of 10,000/day, so roughly six a day). It is OFF by default and
     must be asked for: a health check that quietly burns an
     upload's worth of the day's quota is worse than no health
     check.

   WHO MAY ASK
     Deployment facts are operator information, not public
     information — a stranger learning whether Google credentials
     are configured on this site is a stranger learning where to
     push. So the function refuses by default and accepts one of:

       · a Supabase Auth session (the admin dashboard's own JWT,
         verified against Supabase rather than merely decoded), or
       · the x-arzuz-hook header matching YOUTUBE_HEALTH_SECRET,
         for a terminal/curl check.

     Set YOUTUBE_HEALTH_SECRET to check it from a shell. Until it is
     set that route is closed rather than open — an unset secret
     must never mean "no secret required".

   Routing: /api/* → /.netlify/functions/:splat (netlify.toml), so
   /api/youtube-health reaches this file with no extra rule.

   GET /api/youtube-health          → the report (no secrets)
   GET /api/youtube-health?deep=1   → …and one real upload session
   ============================================================ */

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* The same three names netlify/functions/youtube-upload-start.js
   reads, in the same order it reads them — this file exists to say
   whether THAT function will find them, so a drift between the two
   lists would make this report a lie. */
const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'];

const REFRESH_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_API =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

/* ------------------------------------------------------------
   THE FAILURE VOCABULARY — THE SHARED ONE

   Every other function stamps its failures with
   assets/api-errors.js so a page reads one class per failure, and
   this one is not the exception.

   IT WAS ONE, DELIBERATELY, and the reason is worth keeping because
   it is the reason the rule is safe to apply now. When the
   standalone version was written, that module was not in git at all
   — `git ls-files assets/api-errors.js` matched nothing — so a
   health check that required it would have answered 500 with a
   module-not-found, which reads exactly like the outage it exists
   to diagnose. The one function whose job is to say "this
   deployment is missing something" must not itself be missing
   something.

   That premise expired when the module was committed. With the file
   in the tree and nineteen functions already requiring it, a second
   copy is only a second place for the six names to drift — and
   scripts/test-api-errors.mjs refuses the exception it used to
   grant, because an exemption nothing asserts is where a door
   hides. scripts/test-youtube-url.mjs pins the require below, so
   the copy cannot come back by accident.

   kindForStatus() below is NOT a copy of that policy: it turns a
   status into a word for a sentence a person reads. The wire form
   itself — which class may go on the wire, and what happens to one
   that may not — is the shared module's, called, not restated.
   ------------------------------------------------------------ */
const ApiErrors = require('../../assets/api-errors.js');
const KINDS = ApiErrors.KINDS;

function kindForStatus(status) {
  if (status === 429) return 'busy';
  /* a route, table, function or grant this deployment does not have —
     our side, and retrying cannot fix it */
  if (status === 401 || status === 403 || status === 404) return 'not-ready';
  if (status >= 400 && status < 500) return 'rejected';
  return 'error';
}

function wireBody(status, body, kind) {
  return ApiErrors.wireBody(status, body, kind);
}

function json(status, obj, kind) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(wireBody(status, obj, kind)),
  };
}

/* ------------------------------------------------------------
   The report. Split out from the handler and given an injectable
   `deps` so the checks below can be driven in a test with no
   network at all — the same reason assets/video.js is importable
   from node.
   ------------------------------------------------------------ */

/* Presence, as booleans. Deliberately not the values, and not a
   prefix of them: "the client id ends with .apps.googleusercontent.com"
   is the useful fact, and it is one the id shares with every other
   Google web client, so it identifies nothing. */
function presenceOf(env) {
  const e = env || {};
  const value = name => String(e[name] || '').trim();

  const vars = {};
  REQUIRED.forEach(name => { vars[name] = value(name) !== ''; });

  const clientId = value('GOOGLE_CLIENT_ID');
  const refreshToken = value('YOUTUBE_REFRESH_TOKEN');

  return {
    vars,
    /* every required name present? */
    complete: REQUIRED.every(name => vars[name]),
    missing: REQUIRED.filter(name => !vars[name]),
    /* shape, not value — a Drive/Android client id or a stray paste is
       worth catching before it becomes "Google rejected the token" */
    clientIdIsWebClient: /\.apps\.googleusercontent\.com$/.test(clientId),
    refreshTokenLooksGoogley: /^1\/\//.test(refreshToken),
  };
}

/* The live check: the exchange youtube-upload-start performs first,
   and nothing more. Returns only facts about the exchange. */
async function checkToken(env, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const e = env || {};
  const clientId = String(e.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(e.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = String(e.YOUTUBE_REFRESH_TOKEN || '').trim();

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      reason: 'not-configured',
      /* the same sentence the upload function gives, so an operator
         reading both logs reads one sentence, not two */
      error: 'Video uploads are not configured on the server yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN).',
    };
  }

  let res;
  try {
    res = await fetchImpl(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: 'Could not reach Google: ' + (err && err.message) };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    return {
      ok: false,
      /* invalid_grant is the one an operator must act on: the stored
         token is dead and only scripts/youtube-auth.mjs can replace it */
      reason: body.error === 'invalid_grant' ? 'refresh-token-invalid' : 'exchange-refused',
      /* Google usually names the failure itself. When it does not, the
         fallback names the CLASS from the shared vocabulary rather than
         composing a status word into the sentence: this string rides the
         wire, and a page handed a status number would have to re-derive
         what only the server can say (see assets/api-errors.js). */
      error: (body.error_description || body.error ||
        ('Google refused the token exchange (' + kindForStatus(res.status) + ')')).slice(0, 200),
    };
  }

  /* scope proves the token is the upload-only one this deployment
     expects, without ever showing the token.

     `accessToken` is returned because the deep probe needs it. It is
     prefixed so that the one place that builds the response strips it
     by name, and a future field added here cannot leak by accident —
     the report whitelists, it does not redact. */
  return {
    ok: true,
    scope: String(body.scope || ''),
    expiresInSeconds: Number(body.expires_in) || null,
    /* the upload path needs this scope; a token without it would
       refresh fine and then fail at the upload */
    hasUploadScope: String(body.scope || '').split(/\s+/).indexOf('https://www.googleapis.com/auth/youtube.upload') !== -1,
    _accessToken: body.access_token,
  };
}

/* What the report may carry. Built by NAMING the fields rather than by
   deleting the secret from a wider object: a whitelist cannot leak a
   field nobody remembered to subtract. */
function publicToken(token) {
  const out = { ok: !!token.ok };
  if (!token.ok) {
    out.reason = token.reason;
    if (token.error) out.error = token.error;
    return out;
  }
  out.scope = token.scope;
  out.expiresInSeconds = token.expiresInSeconds;
  out.hasUploadScope = token.hasUploadScope;
  return out;
}

/* The deep probe: open a resumable session, send no bytes, learn
   whether YouTube will accept this channel for an unlisted insert. */
async function checkUploadSession(env, accessToken, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  if (!accessToken) return { ran: false, reason: 'no-access-token' };
  try {
    const res = await fetchImpl(UPLOAD_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': '1024',
      },
      body: JSON.stringify({
        snippet: { title: 'Arzuz health check', categoryId: '19' },
        status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
      }),
    });
    const location = res.headers && res.headers.get ? res.headers.get('location') : null;
    if (res.status === 200 && location) return { ran: true, ok: true };
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch (e) { /* HTML error body */ }
    return { ran: true, ok: false, status: res.status, error: detail };
  } catch (err) {
    return { ran: true, ok: false, error: (err && err.message) || 'request failed' };
  }
}

/* One call, one answer. `deps.fetch` makes it testable; `deps.env`
   makes the presence check testable without touching this process. */
async function healthReport(env, deps) {
  const options = deps || {};
  const presence = presenceOf(env);
  const token = await checkToken(env, options);

  const report = {
    checkedAt: new Date().toISOString(),
    /* the three variables the upload function reads */
    env: presence,
    token: publicToken(token),
    /* what to DO about it. The upload function's own three failures
       are named here, so the answer to "it did not work" is one
       sentence rather than a diagnosis. */
    verdict: verdictOf(presence, token),
  };

  if (options.deep && token.ok) {
    /* the token rides a local variable, never the object above */
    report.uploadSession = await checkUploadSession(env, token._accessToken, options);
  } else if (options.deep) {
    report.uploadSession = { ran: false, reason: 'token-unhealthy' };
  }

  return report;
}

function verdictOf(presence, token) {
  if (!presence.complete) {
    return {
      ready: false,
      code: 'not-configured',
      next: 'Add ' + presence.missing.join(', ') + ' in Netlify → Site configuration → Environment variables, then redeploy — variables only reach functions built after they exist.',
    };
  }
  if (!presence.clientIdIsWebClient) {
    return {
      ready: false,
      code: 'client-id-not-a-web-client',
      next: 'GOOGLE_CLIENT_ID is set but does not end in .apps.googleusercontent.com, so it is not a Google web OAuth client id. Re-run scripts/youtube-auth.mjs with the Web application client from the Cloud console.',
    };
  }
  if (!token.ok) {
    return {
      ready: false,
      code: token.reason,
      next: token.reason === 'refresh-token-invalid'
        ? 'The stored refresh token was revoked or rotated. Re-run scripts/youtube-auth.mjs and update YOUTUBE_REFRESH_TOKEN, then redeploy.'
        : 'The refresh exchange did not succeed — check GOOGLE_CLIENT_SECRET and the network, then try again.',
    };
  }
  if (token.hasUploadScope === false) {
    return {
      ready: false,
      code: 'missing-upload-scope',
      next: 'The token refreshes but does not carry youtube.upload, so it cannot start an upload. Re-run scripts/youtube-auth.mjs.',
    };
  }
  return {
    ready: true,
    code: 'ready',
    next: 'Uploads should start. Attach a video in the admin dashboard — the phases are Preparing, Uploading %, then Uploaded — processing.',
  };
}

/* ------------------------------------------------------------
   Who may ask
   ------------------------------------------------------------ */

/* A JWT is only trusted after Supabase itself says it is live — the
   anon key is public, so "the token decodes" proves nothing. */
async function verifyToken(token, deps) {
  if (!token || token.length < 20) return null;
  const fetchImpl = (deps && deps.fetch) || fetch;
  try {
    const res = await fetchImpl(SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    console.warn('[youtube-health] token check failed:', e && e.message);
    return null;
  }
}

/* Constant-time-ish compare, so a wrong secret cannot be discovered
   a character at a time by the clock. */
function sameSecret(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function bearerOf(event) {
  const h = (event && event.headers) || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

function hookOf(event) {
  const h = (event && event.headers) || {};
  return h['x-arzuz-hook'] || h['X-Arzuz-Hook'] || '';
}

async function authorized(event, env, deps) {
  /* The hook route is closed until a secret exists — an unset secret
     must never read as "no secret required". */
  const expected = String((env && env.YOUTUBE_HEALTH_SECRET) || '').trim();
  if (expected && sameSecret(hookOf(event), expected)) return { via: 'hook' };

  const user = await verifyToken(bearerOf(event), deps);
  if (user) return { via: 'session', user: user.id };
  return null;
}

exports.handler = async function (event) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-arzuz-hook' }, body: '' };
  }
  if (event && event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' }, 'rejected');

  const who = await authorized(event, process.env);
  if (!who) {
    return json(401, {
      error: 'This is an operator check. Sign in to the dashboard, or send the YOUTUBE_HEALTH_SECRET in the x-arzuz-hook header.',
    }, 'not-ready');
  }

  const query = (event && event.queryStringParameters) || {};
  const deep = query.deep === '1' || query.deep === 'true';

  try {
    const report = await healthReport(process.env, { deep });
    /* One line in the function log, because "when did it break" is the
       next question and the answer should not be re-derived. */
    console.log('[youtube-health]', JSON.stringify({
      via: who.via, ready: report.verdict.ready, code: report.verdict.code,
      missing: report.env.missing.length, token: report.token.ok, deep,
    }));
    return json(200, report);
  } catch (err) {
    console.error('[youtube-health]', err && err.message);
    return json(500, { error: (err && err.message) || 'The health check itself failed' });
  }
};

/* Exported for node tests (scripts/test-youtube-url.mjs). The handler
   stays the only thing Netlify calls. */
exports.presenceOf = presenceOf;
exports.publicToken = publicToken;
exports.checkToken = checkToken;
exports.checkUploadSession = checkUploadSession;
exports.healthReport = healthReport;
exports.verdictOf = verdictOf;
exports.sameSecret = sameSecret;
exports.authorized = authorized;
exports.REQUIRED = REQUIRED;
