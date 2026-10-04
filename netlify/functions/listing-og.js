/* ============================================================
   Arzuz — Netlify Function: dynamic listing preview cards

   Link scrapers (WhatsApp, X/Cards, iMessage, Facebook) do not
   run JavaScript, so the tags listing.html paints client-side in
   paintMeta() are invisible to them — every shared room showed
   the generic "Verified Apartment" card. This function serves
   listing.html with the real listing's tags already in the head.

   Routing (netlify.toml):
     /listing      → this function  (status 200, query preserved)
     /listing.html → this function  (status 200, query preserved)
   included_files in netlify.toml bundles listing.html into the
   deploy sandbox — the page source is NOT duplicated here.

   What it changes, and only this: og:title, og:description,
   og:image, og:url, twitter:title, twitter:description,
   twitter:image, <title>, meta description, canonical, and the
   <script type="application/ld+json" id="ldjson"> block.

   Data source: public_listings — the one public read surface,
   anon key only, same as browse.html and listing.html. No owner
   names or phone numbers exist in that view; nothing new is
   exposed. Unknown/expired id → the page ships with its generic
   card, which is exactly what listing.html itself shows ("This
   listing isn't live").
   ============================================================ */

const SITE = 'https://arzuz.com';
const GENERIC_IMAGE = SITE + '/assets/social/og-image.png';

/* Same env contract as the other functions: the anon key is public
   by design (config.js carries it in page source; RLS is the gate).
   SUPABASE_URL_KEY/SUPABASE_ANON_KEY_KEY allow a Netlify env override
   without touching this file; both fall back to the shipped values. */
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* ---------- helpers ---------- */

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function first(p, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (p[keys[i]] !== undefined && p[keys[i]] !== null && p[keys[i]] !== '') return p[keys[i]];
  }
  return '';
}

function ngn(n) {
  try {
    return '\u20A6' + Number(n).toLocaleString('en-NG');
  } catch (e) {
    return '\u20A6' + n;
  }
}

/* og:image must be absolute for every scraper; Cloudinary uploads are
   absolute already — this only guards a relative value slipping through. */
function absoluteUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return SITE + (u.charAt(0) === '/' ? u : '/' + u);
}

/* Same field map and media precedence as buildMedia() in listing.html:
   payload.media is the source of truth; photo / video_url are the
   fallback for listings created before the gallery manager. Videos
   never become the card image. */
function firstPhotoUrl(p) {
  const m = p.media;
  if (Array.isArray(m)) {
    for (const it of m) {
      if (it && it.url && it.type !== 'video') return String(it.url);
    }
  }
  if (p.photo) return String(p.photo);
  return '';
}

function descriptionFor(row, p) {
  const bits = [ngn(row.listed_price_ngn) + ' per session', 'verified', 'zero agent fees'];
  const area = first(p, ['ar']);
  if (area) bits.splice(1, 0, area);
  return bits.join(' \u00B7 ') + '.';
}

/* ---------- Supabase read (12 s timeout — a scraper must never hang) ---------- */

async function fetchListing(id) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return null;
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listings?select=id,tier,listed_price_ngn,property_name,photo_url,property_type,area,payload&id=eq.' +
    encodeURIComponent(id);
  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0];
  } catch (e) {
    console.warn('[listing-og] fetch failed:', e && e.message);
    return null;
  }
}

/* ---------- head rewriting ---------- */

function stripBom(html) {
  return html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
}

function meta(property, content) {
  return '<meta property="' + property + '" content="' + esc(content) + '">';
}

function metaName(name, content) {
  return '<meta name="' + name + '" content="' + esc(content) + '">';
}

/* Replace every complete <meta property="og:X" …> / <meta name="twitter:X" …>
   occurrence, wherever it sits in the head. Returning the line keeps any
   neighbouring tags intact. */
function replaceMetaTags(html, updates) {
  for (const [attr, name, value] of updates) {
    const re = new RegExp('<meta\\s+' + attr + '="' + name + '"\\s+content="[^"]*">');
    const line = attr === 'property' ? meta(name, value) : metaName(name, value);
    if (re.test(html)) {
      html = html.replace(re, line);
    } else {
      html = html.replace('</head>', '  ' + line + '\n</head>');
    }
  }
  return html;
}

function rewriteHead(html, listing) {
  const row = listing.row;
  const p = row.payload || {};
  const name = first(p, ['prop_name']) || row.property_name || 'Verified room';
  const area = first(p, ['ar']) || row.area || 'Malete';
  const rent = row.listed_price_ngn;
  const title = name + ' \u2014 ' + area + ' | Arzuz';
  const desc =
    (rent ? ngn(rent) + ' per session \u00B7 ' : '') +
    'Verified \u00B7 zero agent fees \u00B7 ' + area + ', near KWASU.';
  const img = absoluteUrl(firstPhotoUrl(p) || row.photo_url) || GENERIC_IMAGE;
  const url = SITE + '/listing?id=' + row.id;

  html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(title) + '</title>');
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*">/,
    metaName('description', desc)
  );
  html = html.replace(
    /<link\s+rel="canonical"\s+href="[^"]*">/,
    '<link rel="canonical" href="' + url + '">'
  );

  html = replaceMetaTags(html, [
    ['property', 'og:title', title],
    ['property', 'og:description', desc],
    ['property', 'og:image', img],
    ['property', 'og:url', url],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', desc],
    ['name', 'twitter:image', img],
  ]);

  /* Rebuild the placeholder JSON-LD with the real listing. */
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Apartment',
    name: name,
    address: area,
    image: img,
    ...(rent ? { offers: { '@type': 'Offer', price: rent, priceCurrency: 'NGN' } } : {}),
  };
  html = html.replace(
    /<script type="application\/ld\+json" id="ldjson">[\s\S]*?<\/script>/,
    '<script type="application/ld+json" id="ldjson">' + JSON.stringify(ld) + '</script>'
  );

  return html;
}

/* ---------- handler ---------- */

const HEAD = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' };

exports.handler = async function (event) {
  let html;
  try {
    html = stripBom(await require('fs').promises.readFile(require('path').join(__dirname, 'listing.html'), 'utf8'));
  } catch (e) {
    console.error('[listing-og] listing.html missing from sandbox:', e && e.message);
    return { statusCode: 302, headers: { Location: '/listing.html' + (event.rawQuery ? '?' + event.rawQuery : '') } };
  }

  const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (id) {
    const listing = await fetchListing(id);
    if (listing) html = rewriteHead(html, { row: listing });
  }

  return { statusCode: 200, headers: HEAD, body: html };
};
