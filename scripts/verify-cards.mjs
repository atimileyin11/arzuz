/* Live link-preview verification for the deployed site.
   Run from arzuz-site/:   node scripts/verify-cards.mjs
                            node scripts/verify-cards.mjs --id <listing-uuid>
                            node scripts/verify-cards.mjs --base http://localhost:8888

   WHY THIS EXISTS: the preview card is not a page feature you can eyeball in
   a browser. WhatsApp, X, Telegram, Facebook, Slack and iMessage fetch the
   URL with their own agent string, never run JavaScript, and read the tags
   out of the raw head. listing-og.js exists to write those tags; this script
   is the only thing that proves they arrived, on the live domain, for the
   agent strings that actually matter.

   It reads public_listings with the same public anon key the site ships, so
   it needs no secrets and touches nothing private. With no active listing it
   still verifies the generic fallback path and says so plainly rather than
   passing quietly.

   Exits 1 on any failure. Zero dependencies (Node 18+ fetch). */

const AGENTS = [
  { name: 'WhatsApp',        ua: 'WhatsApp/2.24.1.79 A' },
  { name: 'X / Twitter',     ua: 'Twitterbot/1.0' },
  { name: 'Telegram',        ua: 'TelegramBot (like TwitterBot)' },
  { name: 'Facebook',        ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  { name: 'Slack / iMessage', ua: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
  { name: 'Browser',         ua: 'Mozilla/5.0 (compatible; card-check)' },
];

const SUPABASE_URL = 'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

const PASS = [];
const FAIL = [];
const WARN = [];

function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name + (cond ? '' : '  ::  ' + (detail || '')));
  return cond;
}

function warn(name, detail) {
  WARN.push(name + '  ::  ' + detail);
}

/* ---------- args ---------- */
const argv = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const BASE = argOf('--base', 'https://arzuz.com').replace(/\/+$/, '');
const EXPLICIT_ID = argOf('--id', '');

/* ---------- helpers ---------- */

function meta(html, attr, name) {
  const re = new RegExp('<meta\\s+' + attr + '="' + name + '"\\s+content="([^"]*)"');
  const m = re.exec(html);
  return m ? m[1] : '';
}

function decode(s) {
  return String(s)
    .replace(/&#8358;|&nbsp;/g, '\u20A6')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
}

/* A real listing, or nothing. Anon read of the one public view — exactly
   what browse.html and listing-og.js do, so a failure here is a failure
   a scraper would hit too. */
async function newestActiveListing() {
  const url = SUPABASE_URL + '/rest/v1/public_listings?select=id,property_name,area,photo_url,listed_price_ngn' +
    '&order=created_at.desc&limit=1';
  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    });
    if (!res.ok) {
      warn('public_listings read', 'HTTP ' + res.status + ' — cannot auto-discover a listing');
      return null;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    warn('public_listings read', e.message);
    return null;
  }
}

async function fetchCard(id, ua) {
  const url = BASE + '/listing?id=' + encodeURIComponent(id);
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  return { url, status: res.status, type: res.headers.get('content-type') || '', html: await res.text() };
}

/* The card is only as good as the image: a scraper that cannot load
   og:image renders a bare grey box. HEAD first, GET as the fallback for
   the CDNs that reject HEAD. */
async function imageIsFetchable(src, ua) {
  try {
    let res = await fetch(src, { method: 'HEAD', headers: { 'User-Agent': ua } });
    if (!res.ok || !/^image\//i.test(res.headers.get('content-type') || '')) {
      res = await fetch(src, { headers: { 'User-Agent': ua } });
    }
    if (!res.ok) return { ok: false, why: 'HTTP ' + res.status };
    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) return { ok: false, why: 'content-type ' + (type || '(none)') };
    return { ok: true, type, bytes: res.headers.get('content-length') || '?' };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/* ---------- run ---------- */

const listing = EXPLICIT_ID
  ? { id: EXPLICIT_ID, property_name: '', area: '' }
  : await newestActiveListing();

const real = !!(listing && listing.id);
const id = real ? listing.id : '00000000-0000-0000-0000-000000000000';

console.log('\nArzuz link-preview verification');
console.log('  base    : ' + BASE);
console.log('  listing : ' + (real
  ? id + (listing.property_name ? '  (' + listing.property_name + (listing.area ? ', ' + listing.area : '') + ')' : '')
  : id + '  — no active listing found, verifying the generic fallback'));

if (!real) {
  console.log('\n  NOTE: public_listings returned no rows, so no real room can produce a');
  console.log('        card yet. Activate one (status = active, tier >= 1, env = production)');
  console.log('        and re-run with --id <uuid> to verify the real card.');
}

let firstImage = '';
let firstName = '';
let firstTitle = '';

for (const agent of AGENTS) {
  const res = await fetchCard(id, agent.ua);
  const tag = agent.name + ': ';
  const h = res.html;

  check(tag + 'HTTP 200', res.status === 200, 'got ' + res.status);
  check(tag + 'serves HTML', /text\/html/.test(res.type), res.type || '(no content-type)');

  const title = decode(meta(h, 'property', 'og:title'));
  const desc = decode(meta(h, 'property', 'og:description'));
  const image = meta(h, 'property', 'og:image');
  const ogUrl = meta(h, 'property', 'og:url');
  const twCard = meta(h, 'name', 'twitter:card');
  const twImage = meta(h, 'name', 'twitter:image');
  const pageTitle = decode((/<title>([\s\S]*?)<\/title>/.exec(h) || [])[1] || '');

  check(tag + 'og:title present', !!title, 'empty');
  check(tag + 'og:description present', !!desc, 'empty');
  check(tag + 'og:image present', !!image, 'empty');
  check(tag + 'og:image is absolute https', /^https:\/\//.test(image), image);
  check(tag + 'twitter:card = summary_large_image', twCard === 'summary_large_image', twCard || '(missing)');
  check(tag + 'twitter:image mirrors og:image', twImage === image, twImage + ' vs ' + image);
  check(tag + '<title> present', !!pageTitle, 'empty');
  /* og:url and canonical only carry the id once a real listing was found —
     listing-og.js rewrites them, the static fallback deliberately points at
     /listing. Assert the right thing for the mode we are actually in. */
  if (real) {
    check(tag + 'og:url points at this listing', new RegExp('id=' + id).test(ogUrl), ogUrl || '(missing)');
    check(tag + 'canonical is the tagged url', new RegExp('<link\\s+rel="canonical"\\s+href="[^"]*id=' + id + '"').test(h), 'canonical mismatch');
  } else {
    check(tag + 'og:url is the listing page (fallback)', ogUrl === BASE + '/listing', ogUrl || '(missing)');
    check(tag + 'canonical is the listing page (fallback)', new RegExp('<link\\s+rel="canonical"\\s+href="' + BASE + '/listing"').test(h), 'canonical mismatch');
  }
  check(tag + 'not noindex', !/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(h), 'page is noindex');
  /* Size hints are a nicety, not a requirement: every scraper fetches the
     image and measures it itself. Warn, never fail, so this check cannot
     cry wolf on a perfectly renderable photo. */
  if (!/og:image:width/.test(h)) warn(tag + 'og:image has no width/height hint', image);

  const ld = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(h);
  let ldOk = false;
  let ldType = '';
  if (ld) {
    try {
      const parsed = JSON.parse(ld[1]);
      ldType = parsed && parsed['@type'];
      ldOk = !!(parsed && parsed['@context'] === 'https://schema.org' && ldType);
    } catch (e) { ldOk = false; }
  }
  check(tag + 'JSON-LD parses and is typed', ldOk, 'invalid, empty or missing');
  if (real) check(tag + 'JSON-LD describes an Apartment', ldType === 'Apartment', ldType || '(none)');

  if (!firstName) { firstName = title; firstTitle = pageTitle; firstImage = image; }

  /* Every scraper must be handed the SAME card — if one agent gets a
     different title, the function is branching on the user agent. */
  check(tag + 'same og:title as the other agents', title === firstName, title + ' vs ' + firstName);

  if (desc.length > 200) warn(tag + 'og:description length', desc.length + ' chars — some clients truncate past ~160');
}

/* One image check is enough: it is the same URL for every agent. */
const img = await imageIsFetchable(firstImage, AGENTS[0].ua);
check('og:image actually resolves', img.ok, (img.why || '') + ' for ' + firstImage);
if (img.ok) console.log('\n  og:image OK: ' + firstImage + '  (' + img.type + ', ' + img.bytes + ' bytes)');

if (real) {
  const rowTitleMatches = !listing.property_name ||
    firstTitle.indexOf(listing.property_name) !== -1 ||
    firstName.indexOf(listing.property_name) !== -1;
  check('real listing: property name appears in the card', rowTitleMatches,
    '"' + listing.property_name + '" not in "' + firstTitle + '" / "' + firstName + '"');
  check('real listing: card is not the generic fallback', firstTitle.indexOf('Verified Apartment') === -1,
    firstTitle);
}

/* ---------- report ---------- */
console.log('\nPASS: ' + PASS.length);
PASS.forEach((p) => console.log('  \u2713 ' + p));
if (WARN.length) {
  console.log('WARN: ' + WARN.length);
  WARN.forEach((w) => console.log('  ! ' + w));
}
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('\nALL CARD CHECKS PASSED' + (real ? '' : ' (generic fallback only)'));
