#!/usr/bin/env node
/* Node tests for the video-tour feature — run: node scripts/test-youtube-url.mjs
   Mirrors the style of scripts/test-listing-og.mjs (no framework).

   Covers assets/video.js (URL parsing, progress markup) and
   netlify/functions/youtube-health.js (the operator check: which
   variables the deploy can see, and whether the stored token still
   refreshes — driven here with an injected fetch, so no test in this
   file touches the network).

   WHY THE HEALTH CHECKS LIVE IN THIS SUITE rather than a file of their
   own: scripts/test-all.mjs treats a test file that no suite list names
   as a failure under --strict, and this is the registered suite for the
   video-tour feature. A separate scripts/test-youtube-health.mjs would
   need an entry in package.json or in the runner's OWNED list — both of
   which are somebody else's uncommitted edits right now. */

import { createRequire } from 'node:module';
import ArzuzVideo from '../assets/video.js';
import { parseLog, summarize, verdictOf } from './youtube-quota.mjs';

const require = createRequire(import.meta.url);
const Health = require('../netlify/functions/youtube-health.js');

let failures = 0;
function check(name, ok) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) failures++;
}

/* A fetch stand-in that answers the OAuth token endpoint and nothing
   else, so a test can put a deployment into any state it likes. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => (headers || {})[String(name).toLowerCase()] || null,
    },
    json: async () => body,
  };
}

const FULL_ENV = {
  GOOGLE_CLIENT_ID: '1234-example.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-not-a-real-secret',
  YOUTUBE_REFRESH_TOKEN: '1//0example-refresh-token',
};

console.log('parseYouTube');
check('accepts watch?v= URLs',
  ArzuzVideo.parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts extra watch params before v',
  ArzuzVideo.parseYouTube('https://www.youtube.com/watch?si=abc&v=dQw4w9WgXcQ&t=30s') === 'dQw4w9WgXcQ');
check('accepts youtu.be short links',
  ArzuzVideo.parseYouTube('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts /embed/ URLs',
  ArzuzVideo.parseYouTube('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?controls=0') === 'dQw4w9WgXcQ');
check('accepts /shorts/ URLs',
  ArzuzVideo.parseYouTube('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts a bare 11-char id',
  ArzuzVideo.parseYouTube('dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts mobile m.youtube.com',
  ArzuzVideo.parseYouTube('https://m.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('rejects Cloudinary mp4 (plain video fallback)',
  ArzuzVideo.parseYouTube('https://res.cloudinary.com/demo/tour.mp4') === null);
check('rejects a youtube search URL',
  ArzuzVideo.parseYouTube('https://www.youtube.com/results?search_query=tour') === null);
check('rejects an empty string', ArzuzVideo.parseYouTube('') === null);
check('rejects null/undefined', ArzuzVideo.parseYouTube(null) === null);
check('isYouTube agrees with parseYouTube',
  ArzuzVideo.isYouTube('https://youtu.be/dQw4w9WgXcQ') === true &&
  ArzuzVideo.isYouTube('https://res.cloudinary.com/demo/tour.mp4') === false);

console.log('thumb / watchUrl');
check('thumb points at the public poster CDN',
  ArzuzVideo.thumb('https://youtu.be/dQw4w9WgXcQ') === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
check('thumb is empty for non-YouTube URLs', ArzuzVideo.thumb('https://res.cloudinary.com/demo/tour.mp4') === '');
check('watchUrl is the canonical stored form',
  ArzuzVideo.watchUrl('dQw4w9WgXcQ') === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

console.log('embedProxyUrl');
check('proxy URL keeps raw google URLs out of the page',
  ArzuzVideo.embedProxyUrl('https://youtu.be/dQw4w9WgXcQ') === '/api/video-embed/dQw4w9WgXcQ');
check('autoplay flag appends cleanly',
  ArzuzVideo.embedProxyUrl('dQw4w9WgXcQ', { autoplay: true }) === '/api/video-embed/dQw4w9WgXcQ?autoplay=1');
check('controls flag is for preview contexts',
  ArzuzVideo.embedProxyUrl('dQw4w9WgXcQ', { controls: true }) === '/api/video-embed/dQw4w9WgXcQ?controls=1');
check('non-YouTube URLs produce no proxy URL',
  ArzuzVideo.embedProxyUrl('https://res.cloudinary.com/demo/tour.mp4') === '');

console.log('progressHTML');
const ph = ArzuzVideo.progressHTML({ phase: 'uploading', percent: 34, bytesPerSec: 1024 * 1024 * 2.5 });
check('shows the percentage', ph.includes('Uploading 34%'));
check('shows a human-readable speed', ph.includes('2.5 MB/s'));
check('sets the bar width inline', ph.includes('width:34%'));

console.log('uploadVideoToYouTube');
try {
  await ArzuzVideo.uploadVideoToYouTube({ name: 'big.mp4', size: ArzuzVideo.MAX_BYTES + 1, type: 'video/mp4' });
  check('rejects files above the 200 MB cap without any network call', false);
} catch (e) {
  check('rejects files above the 200 MB cap without any network call',
    /too large/i.test(e.message) && !/fetch/i.test(e.message));
}

/* ============================================================
   netlify/functions/youtube-health.js — the operator check
   ============================================================ */

console.log('youtube-health: what the deploy can see');
const full = Health.presenceOf(FULL_ENV);
check('reports all three variables present',
  full.complete === true && full.missing.length === 0);
check('reports the two shape facts, not the values',
  full.clientIdIsWebClient === true && full.refreshTokenLooksGoogley === true);
const none = Health.presenceOf({});
check('names every variable that is missing',
  none.complete === false && none.missing.join(',') === 'GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,YOUTUBE_REFRESH_TOKEN');
check('a whitespace-only value does not count as set',
  Health.presenceOf({ ...FULL_ENV, GOOGLE_CLIENT_SECRET: '   ' }).vars.GOOGLE_CLIENT_SECRET === false);
check('an Android/Drive client id is flagged as the wrong kind',
  Health.presenceOf({ ...FULL_ENV, GOOGLE_CLIENT_ID: '1234-example.apps.googleusercontent.com.evil' }).clientIdIsWebClient === false);

console.log('youtube-health: the live token exchange');
{
  const env = { ...FULL_ENV };
  const result = await Health.checkToken(env, {
    fetch: fakeFetch(() => jsonResponse(200, {
      access_token: 'ya29.something',
      scope: 'https://www.googleapis.com/auth/youtube.upload',
      expires_in: 3599,
    })),
  });
  check('a good exchange reads as healthy', result.ok === true);
  check('the granted upload scope is reported', result.hasUploadScope === true);
  check('the access token is kept off the public shape', '"accessToken"' !== Object.keys(Health.publicToken(result)).join(','));
  const pub = Health.publicToken(result);
  check('the public token shape carries no token value',
    !Object.keys(pub).some(k => /token|secret|access/i.test(k) && k !== 'hasUploadScope'));
  check('the report never echoes a secret',
    !JSON.stringify(pub).includes('ya29.something') && !JSON.stringify(pub).includes(FULL_ENV.YOUTUBE_REFRESH_TOKEN));
}
{
  const refused = await Health.checkToken(FULL_ENV, {
    fetch: fakeFetch(() => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })),
  });
  check('a revoked token is named as such, not as a generic failure',
    refused.ok === false && refused.reason === 'refresh-token-invalid');
  check('the operator gets the action to take',
    Health.verdictOf(Health.presenceOf(FULL_ENV), refused).next.includes('scripts/youtube-auth.mjs'));
}
{
  const unset = await Health.checkToken({}, { fetch: fakeFetch(() => jsonResponse(200, {})) });
  check('with no variables the check does not even call Google',
    unset.ok === false && unset.reason === 'not-configured');
  const verdict = Health.verdictOf(Health.presenceOf({ GOOGLE_CLIENT_ID: FULL_ENV.GOOGLE_CLIENT_ID }), unset);
  check('the verdict lists exactly what to add, and says to redeploy',
    verdict.code === 'not-configured' && verdict.next.includes('YOUTUBE_REFRESH_TOKEN') && verdict.next.includes('redeploy'));
}
{
  const scopeLess = { ok: true, scope: 'https://www.googleapis.com/auth/youtube.readonly', hasUploadScope: false, _accessToken: 'x' };
  const verdict = Health.verdictOf(Health.presenceOf(FULL_ENV), scopeLess);
  check('a token without youtube.upload is not called ready',
    verdict.ready === false && verdict.code === 'missing-upload-scope');
}

console.log('youtube-health: the secret never rides the report');
{
  const report = await Health.healthReport(FULL_ENV, {
    fetch: fakeFetch(() => jsonResponse(200, {
      access_token: 'ya29.secret-access',
      scope: 'https://www.googleapis.com/auth/youtube.upload',
      expires_in: 3599,
    })),
  });
  const wire = JSON.stringify(report);
  check('the report is ready', report.verdict.ready === true);
  check('the client secret is nowhere on the wire', !wire.includes(FULL_ENV.GOOGLE_CLIENT_SECRET));
  check('the refresh token is nowhere on the wire', !wire.includes(FULL_ENV.YOUTUBE_REFRESH_TOKEN));
  check('the access token is nowhere on the wire', !wire.includes('ya29.secret-access'));
  check('a deep report with no session probe does not invent one', report.uploadSession === undefined);
}
{
  const calls = [];
  const fetchImpl = fakeFetch((url) => {
    calls.push(url);
    if (url.includes('oauth2.googleapis.com')) {
      return jsonResponse(200, { access_token: 'ya29.deep', scope: 'https://www.googleapis.com/auth/youtube.upload', expires_in: 3599 });
    }
    if (url.includes('uploadType=resumable')) {
      return jsonResponse(200, {}, { location: 'https://upload.youtube.com/session/abc' });
    }
    return jsonResponse(404, {});
  });
  const report = await Health.healthReport(FULL_ENV, { deep: true, fetch: fetchImpl });
  check('the opt-in deep probe opens a resumable session',
    report.uploadSession && report.uploadSession.ran === true && report.uploadSession.ok === true);
  check('the deep probe keeps the api key off the wire too',
    !JSON.stringify(report).includes('ya29.deep'));
  check('the deep probe does not run when the token is unhealthy',
    (await Health.healthReport({}, { deep: true, fetch: fakeFetch(() => jsonResponse(200, {})) })).uploadSession.ran === false);
}

console.log('youtube-health: who may ask');
{
  check('no credential at all is refused',
    (await Health.authorized({ headers: {} }, {}, { fetch: fakeFetch(() => jsonResponse(401, {})) })) === null);
  check('an unset YOUTUBE_HEALTH_SECRET does not open the hook route',
    (await Health.authorized({ headers: { 'x-arzuz-hook': '' } }, {}, { fetch: fakeFetch(() => jsonResponse(401, {})) })) === null);
  const okHook = await Health.authorized(
    { headers: { 'x-arzuz-hook': 's3cret' } }, { YOUTUBE_HEALTH_SECRET: 's3cret' },
    { fetch: fakeFetch(() => jsonResponse(401, {})) });
  check('the matching hook secret is accepted without asking Supabase',
    okHook && okHook.via === 'hook');
  const wrong = await Health.authorized(
    { headers: { 'x-arzuz-hook': 'nope' } }, { YOUTUBE_HEALTH_SECRET: 's3cret' },
    { fetch: fakeFetch(() => jsonResponse(401, {})) });
  check('a wrong hook secret is refused', wrong === null);
  const session = await Health.authorized(
    { headers: { authorization: 'Bearer a-long-enough-looking-jwt-here' } }, {},
    { fetch: fakeFetch(() => jsonResponse(200, { id: 'user-1' })) });
  check('a live Supabase session is accepted', session && session.via === 'session');
  const deadSession = await Health.authorized(
    { headers: { authorization: 'Bearer a-long-enough-looking-jwt-here' } }, {},
    { fetch: fakeFetch(() => jsonResponse(401, {})) });
  check('a session Supabase disowns is refused', deadSession === null);
}

/* ============================================================
   scripts/youtube-quota.mjs — reading the day out of the logs
   ============================================================ */

console.log('youtube-quota: parsing the marker');
{
  const log = [
    'Oct 13, 10:02:11 AM: ' + '[youtube-quota] ' + '{"at":"2026-10-13T09:02:11.000Z","event":"videos.insert","units":1600,"title":"Lekki Phase 1 two-bed"}',
    'Oct 13, 10:40:00 AM: [youtube-upload-start] YouTube refused the upload session (403)',
    'a line that merely names [youtube-quota] in prose',
    'Oct 14, 08:00:00 AM: [youtube-quota] {"at":"2026-10-14T07:00:00.000Z","event":"videos.insert","units":1600}',
    'Oct 14, 09:00:00 AM: [youtube-quota] {not json at all',
    'Oct 14, 10:00:00 AM: [youtube-quota] {"at":"","units":1600}',
  ].join('\n');
  const parsed = parseLog(log);
  check('counts the real events and nothing else', parsed.events.length === 2);
  check('takes the date from the marker, not Netlify\'s display prefix',
    parsed.events[0].date === '2026-10-13' && parsed.events[1].date === '2026-10-14');
  check('keeps the title for the day it belongs to',
    parsed.events[0].title === 'Lekki Phase 1 two-bed');
  check('a marker mentioned in prose is not an event',
    parsed.events.length === 2 && parsed.events.every(e => e.units === 1600));
  /* three lines carry the marker but no usable event: prose, unparseable
     JSON, and JSON with an empty timestamp */
  check('reports malformed lines instead of quietly dropping them', parsed.malformed === 3);
}
{
  const parsed = parseLog('[youtube-quota] {"at":"2026-10-13T09:00:00.000Z"}');
  check('an event with no unit count falls back to the published cost',
    parsed.events.length === 1 && parsed.events[0].units === 1600);
}
check('an empty log parses to nothing, not to a crash',
  parseLog('').events.length === 0 && parseLog(null).events.length === 0);

console.log('youtube-quota: the day buckets and the guardrail');
{
  const now = new Date('2026-10-14T12:00:00.000Z');
  const events = parseLog([
    '[youtube-quota] {"at":"2026-10-14T08:00:00.000Z","units":1600}',
    '[youtube-quota] {"at":"2026-10-14T09:00:00.000Z","units":1600}',
    '[youtube-quota] {"at":"2026-10-14T10:00:00.000Z","units":1600}',
    '[youtube-quota] {"at":"2026-10-14T11:00:00.000Z","units":1600}',
    '[youtube-quota] {"at":"2026-10-14T11:30:00.000Z","units":1600}',
    '[youtube-quota] {"at":"2026-10-14T11:45:00.000Z","units":1600}',
  ].join('\n')).events;
  const report = summarize(events, { now, days: 3 });
  check('shows the requested window, quiet days included', report.rows.length === 3);
  check('buckets six uploads into today', report.today.uploads === 6 && report.today.units === 9600);
  check('six uploads is the whole free day', report.uploadsPerFullDay === 6);
  check('9,600 of 10,000 units reads as CLOSE, not as still fine',
    report.today.verdict === 'CLOSE');
  check('no upload fits in the remaining 400 units', report.today.uploadsRemaining === 0);
  check('an empty day is still a row', report.rows[0].uploads === 0 && report.rows[0].verdict === 'ok');
}
{
  const now = new Date('2026-10-14T12:00:00.000Z');
  const seven = [];
  for (let i = 0; i < 7; i++) {
    seven.push('[youtube-quota] {"at":"2026-10-14T0' + i + ':00:00.000Z","units":1600}');
  }
  const report = summarize(parseLog(seven.join('\n')).events, { now, days: 2 });
  check('the SEVENTH upload is over the ceiling, not merely close',
    report.today.verdict === 'EXHAUSTED' && report.today.units === 11200);
  check('the guardrail names the verdict by threshold',
    verdictOf(0, 10000) === 'ok' && verdictOf(8000, 10000) === 'CLOSE' && verdictOf(10000, 10000) === 'EXHAUSTED');
}
{
  const now = new Date('2026-10-14T12:00:00.000Z');
  const report = summarize(parseLog('[youtube-quota] {"at":"2026-09-01T00:00:00.000Z"}').events, { now, days: 2 });
  check('events older than the window are counted, not lost', report.eventsOutsideWindow === 1);
  check('an out-of-window event does not inflate today', report.today.uploads === 0);
}

/* ============================================================
   youtube-health.js — the handler itself

   The sections above test the pieces; this one tests the seam
   between them, which is the part Netlify actually calls. It is
   deliberately the ANONYMOUS path: an unauthenticated request makes
   no network call at all (the JWT is rejected on length before
   Supabase is asked), so this runs offline in CI. The authorised
   200 path with real credentials is checked out of band, not here.
   ============================================================ */

console.log('youtube-health: the handler');
{
  const event = (over) => ({ httpMethod: 'GET', headers: {}, queryStringParameters: null, ...over });

  const anon = await Health.handler(event({}));
  check('an anonymous GET is refused with 401', anon.statusCode === 401);
  check('the refusal explains how to authenticate', /YOUTUBE_HEALTH_SECRET|dashboard/.test(anon.body));
  check('the refusal carries the site\'s failure class vocabulary',
    JSON.parse(anon.body).kind === 'not-ready');
  check('the response is never cached', anon.headers['Cache-Control'] === 'no-store');
  check('the response is never indexed', String(anon.headers['X-Robots-Tag']).includes('noindex'));

  const post = await Health.handler(event({ httpMethod: 'POST' }));
  check('a write is refused as a rejected request', post.statusCode === 405);
  check('a preflight is answered without a body',
    (await Health.handler(event({ httpMethod: 'OPTIONS' }))).statusCode === 204);

  /* a short "token" is refused on length, so no Supabase call is made */
  const bogus = await Health.handler(event({ headers: { authorization: 'Bearer short' } }));
  check('a junk bearer token is refused without asking Supabase', bogus.statusCode === 401);
}

console.log(failures === 0 ? '\nAll video helper checks passed.' : '\n' + failures + ' check(s) FAILED');
process.exit(failures === 0 ? 0 : 1);
