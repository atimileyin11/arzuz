/* ============================================================
   Arzuz — Netlify Function: a real URL, and a real page, per listing

   Until this existed, a listing had no address. It lived at
   /listing?id=<uuid> — a query string, which is not a URL a search
   engine will index for a room, cannot be listed in a sitemap as a
   stable location, and reads to a human as a search result rather
   than a place. It also had no content in its HTML: listing.html
   paints every word of it from Supabase after load, so a crawler
   that runs no script saw a skeleton.

   This function fixes both halves of that, for one room:

     GET /rooms/<name>-<area>-<uuid>
       → 200  listing.html with the real head tags AND the room's
              content already in the body, so the page is complete
              with JavaScript switched off
       → 301  /rooms/<current-slug>  when the readable part of the
              path is stale (the owner renamed the property). One
              room, one address — the alternative is two URLs for the
              same room, each competing with the other.
       → 404  a real 404 with the real 404 page when the id does not
              resolve. Not a 200 with "this listing isn't live" in
              it, which is a soft 404 and tells a crawler the page
              exists.
       → 301  /browse when there is no id in the path at all.

   Routing (netlify.toml): /rooms/* → this function, status 200,
   path preserved. included_files bundles listing.html, 404.html and
   assets/listing-url.js into the deploy sandbox — the page source
   is NOT duplicated here.

   Data source: public_listings — the same one public read surface
   the browse page and listing.html use, anon key only. That view
   already excludes owner names and phone numbers; nothing new is
   exposed here.

   If listing.html cannot be read from the sandbox the request is
   bounced to the old /listing?id= page rather than failing: a
   bundling mistake must not turn every listing into a 500.
   ============================================================ */

const fs = require('fs');
const path = require('path');

/* The URL and walking-time rules live in assets/listing-url.js, which
   browse.html and listing.html also load — one source of truth for the
   address of a room. Where it LANDS differs between the repo and the
   deploy: netlify.toml's included_files copies it next to this function
   in the sandbox, while in the repo it is two directories up. Both are
   tried, and a build that finds neither bounces to the old page rather
   than 500ing every listing. */
function loadListingUrl() {
  const candidates = [
    path.join(__dirname, 'listing-url.js'),
    path.join(__dirname, '..', '..', 'assets', 'listing-url.js'),
    '/var/task/assets/listing-url.js'
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (e) { /* try the next location */ }
  }
  return null;
}

const ArzuzListing = loadListingUrl();

/* The badge's words live in assets/verification-badge.js — the same
   module the browse card and listing.html load — so the page a crawler
   gets and the page a browser repaints agree about what was checked.
   Loaded the same way, and optional: without it the page keeps the
   stage-1 wording rather than 500ing. */
function loadBadge() {
  const candidates = [
    path.join(__dirname, 'verification-badge.js'),
    path.join(__dirname, '..', '..', 'assets', 'verification-badge.js'),
    '/var/task/assets/verification-badge.js'
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (e) { /* try the next location */ }
  }
  return null;
}

const ArzuzBadge = loadBadge();

const SITE = 'https://arzuz.com';
const GENERIC_IMAGE = SITE + '/assets/social/og-image.png';

/* Same env contract as the other functions: the anon key is public
   by design (config.js carries it in page source; RLS is the gate). */
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_URL_KEY ||
  'https://nihdbhjecdkpvzvjifrm.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM';

/* The columns the page needs. Wider than listing-og's list: this
   renders the room, not just its card. */
const SELECT = 'id,tier,listed_price_ngn,property_name,photo_url,property_type,area,rooms,latitude,longitude,payload';

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

function absoluteUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return SITE + (u.charAt(0) === '/' ? u : '/' + u);
}

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

function imageList(p, row) {
  const out = [];
  if (Array.isArray(p.media)) {
    for (const it of p.media) {
      if (it && it.url && it.type !== 'video') out.push(absoluteUrl(it.url));
    }
  }
  const cover = absoluteUrl(firstPhotoUrl(p) || row.photo_url);
  if (cover && out.indexOf(cover) === -1) out.unshift(cover);
  return out;
}

function stripBom(html) {
  return html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
}

/* The page is served from a NESTED path, and its own asset URLs are relative:
   "assets/app.js" resolves against /rooms/<slug>/ and asks for
   /rooms/assets/app.js, which is not a file. The stylesheet and every script
   then 404, and a visitor gets an unstyled page with nothing running — a
   crawler never notices, because it only reads the words.

   listing.html cannot simply be changed to root-absolute URLs: the same file
   is served at /listing (root level) and opened straight from disk in the
   harnesses, where an absolute path would break. So the rewrite happens here,
   on the way out, only for the path that needs it. Every relative reference
   in the page is an href="assets/…" or src="assets/…" (checked by
   scripts/test-rooms.mjs, which fails if a new one appears in another shape). */
function absolutizeAssets(html) {
  return html.replace(/(href|src)="assets\//g, '$1="/assets/');
}

function readPage(name) {
  try {
    return stripBom(fs.readFileSync(path.join(__dirname, name), 'utf8'));
  } catch (e) {
    return '';
  }
}

function meta(property, content) {
  return '<meta property="' + property + '" content="' + esc(content) + '">';
}

function metaName(name, content) {
  return '<meta name="' + name + '" content="' + esc(content) + '">';
}

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

/* ---------- Supabase read (12 s timeout — a crawler must never hang) ---------- */

/* The checks behind this room's badge, read from the public view. A
   failure returns null, not []: only a successful read may say that a
   listing has no record, and an outage is not a fact about the room. */
async function fetchChecks(id) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return null;
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listing_checks?select=listing_id,visit_id,kind,detail,checked_at,expires_at' +
    '&listing_id=eq.' + encodeURIComponent(id) + '&order=checked_at.desc';
  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    console.warn('[rooms] checks read failed:', e && e.message);
    return null;
  }
}

/* tier + evidence → label/class/sentence. Falls back to stage 1's label
   if the module is missing from the sandbox, so a bundling mistake
   degrades the wording instead of blanking the badge. */
function badgeOf(row, checks) {
  if (ArzuzBadge) return ArzuzBadge.summarise(row.tier, checks, Date.now());
  const n = Number(row.tier);
  return {
    cls: n >= 2 ? 'b2' : (n === 1 ? 'b1' : 'b0'),
    label: ArzuzListing.tierLabel(row.tier),
    sentence: ArzuzListing.tierLabel(row.tier),
    hasEvidence: false,
    expired: false,
    parts: [],
    checked_at: null,
    expires_at: null
  };
}

async function fetchListing(id) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return null;
  const url =
    SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/public_listings?select=' + SELECT + '&id=eq.' + encodeURIComponent(id);
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
    console.warn('[rooms] fetch failed:', e && e.message);
    return null;
  }
}

/* ---------- the body ---------- */


/* The room, written into the HTML. listing.html repaints this from
   Supabase when it boots — with the same fields — so a visitor ends
   up looking at the interactive page either way. The point of doing
   it here is the reader that never runs the script. */
function renderBody(row, checks) {
  const p = row.payload || {};
  const name = ArzuzListing.nameOf(row) || 'Verified room';
  const area = ArzuzListing.areaOf(row) || 'Malete';
  const type = String(first(p, ['ty']) || row.property_type || '').trim();
  const rooms = String(first(p, ['rm']) || row.rooms || '').trim();
  const rent = row.listed_price_ngn;
  const walk = ArzuzListing.walkText(row.latitude, row.longitude);
  const info = badgeOf(row, checks);
  const badge = info.label;
  const badgeClass = info.cls;
  const desc = String(p.desc || p.description || '').trim();
  const passage = String(p.passage || '').trim();
  const utilities = Array.isArray(p.ut) ? p.ut.filter(Boolean) : [];
  const images = imageList(p, row);

  let h = '';

  if (images.length) {
    h += '<div class="gal"><div class="gal-track"><div class="gal-slide">' +
      '<img src="' + esc(images[0]) + '" alt="' + esc(name + (type ? ' — ' + type : '') + ' in ' + area + ', near KWASU') + '">' +
      '<span class="cr">\u00A9 Arzuz 2026 \u00B7 Verified media</span></div></div>' +
      '<span class="gal-badge"><span class="h-badge ' + badgeClass + '">' + esc(badge) + '</span></span></div>';
  }

  h += '<div class="ld-head"><h1>' + esc(name) + '</h1></div>' +
    '<div class="ld-sub"><span>\uD83D\uDCCD ' + esc(area) + '</span>' +
    (type ? '<span>' + esc(type) + '</span>' : '') +
    (rooms ? '<span>' + esc(rooms) + ' vacant</span>' : '') +
    '</div>' +
    '<div class="stat-chips">' +
    '<span class="stat-chip"><span class="h-badge ' + badgeClass + '">' + esc(badge) + '</span></span>' +
    (walk ? '<span class="stat-chip">' + esc(walk) + '</span>' : '') +
    '</div>';

  if (rent) {
    h += '<div class="ld-price-row"><span class="ld-price">' + esc(ngn(rent)) + '</span>' +
      '<span class="ld-per">per session</span></div>';
  }

  if (desc) {
    h += '<div class="ld-sec"><h2>About this place</h2><div class="ld-card">' +
      '<div class="desc">' + esc(desc) + '</div></div></div>';
  }

  if (utilities.length) {
    h += '<div class="ld-sec"><h2>What it has</h2><div class="ld-card"><ul>' +
      utilities.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') +
      '</ul></div></div>';
  }

  if (passage) {
    h += '<div class="ld-sec"><h2>Getting there</h2><div class="ld-card"><p>' + esc(passage) + '</p></div></div>';
  }

  /* WHAT WE CHECKED — the stage-3 section, written into the HTML so a
     reader with no JavaScript still gets the parts of the badge. */
  h += '<div class="ld-sec" id="verified"><h2>What we checked</h2><div class="ld-card verify-detail">' +
    '<p>' + esc(info.sentence) + '</p>' +
    (info.hasEvidence
      ? '<ul>' + info.parts.map(function (part) {
          return '<li><b>' + esc(part.label) + '</b>' +
            (part.detail ? ' \u2014 ' + esc(part.detail) : '') + '</li>';
        }).join('') + '</ul>' +
        '<p class="note">We go back every six months. This record was made on ' +
        esc(ArzuzBadge ? ArzuzBadge.day(info.checked_at) : '') + ' and is current until ' +
        esc(ArzuzBadge ? ArzuzBadge.day(info.expires_at) : '') + '.</p>'
      : '') +
    '</div></div>';

  h += '<div class="ld-sec"><h2>About this price</h2><div class="ld-card"><p>' +
    'The price shown is what the owner is charging for the session, and Arzuz adds no agent fee. ' +
    'The walking time is measured from a pin dropped at the gate of the compound, not estimated. ' +
    'You pay the owner directly — ' +
    '<a href="/safety">what we tell every student before paying</a>.</p></div></div>';

  h += '<div class="ld-sec"><h2>Looking at this one?</h2><div class="ld-card"><p>' +
    'Contact goes through the Arzuz team, and the owner&rsquo;s number is never published. ' +
    '<a href="/register">Tell us what you need</a> and we will message you, or ' +
    '<a href="/browse">browse the other verified rooms</a>. ' +
    'Living in this compound already? <a href="/my-building">Register the building</a>.</p></div></div>';

  h += '<div class="ld-sec"><h2>Choosing a room near KWASU</h2><div class="ld-card"><p>' +
    'How rent works around KWASU is on <a href="/rent-in-malete">what rent costs in Malete</a>, ' +
    'and what &ldquo;near campus&rdquo; is worth is on ' +
    '<a href="/hostels-near-kwasu">choosing a hostel</a>.</p></div></div>';

  return h;
}

/* ---------- head ---------- */

function rewriteHead(html, row, canonicalUrl, checks) {
  const p = row.payload || {};
  const name = ArzuzListing.nameOf(row) || 'Verified room';
  const area = ArzuzListing.areaOf(row) || 'Malete';
  const rent = row.listed_price_ngn;
  const badge = badgeOf(row, checks).label;
  const title = name + ' \u2014 ' + area + ' | Arzuz';
  const desc = (rent ? ngn(rent) + ' per session \u00B7 ' : '') +
    badge + ' \u00B7 no agent fee \u00B7 ' + area + ', near KWASU.';
  const img = imageList(p, row)[0] || GENERIC_IMAGE;

  html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(title) + '</title>');
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*">/,
    metaName('description', desc)
  );
  html = html.replace(
    /<link\s+rel="canonical"\s+href="[^"]*">/,
    '<link rel="canonical" href="' + canonicalUrl + '">'
  );

  html = replaceMetaTags(html, [
    ['property', 'og:title', title],
    ['property', 'og:description', desc],
    ['property', 'og:image', img],
    ['property', 'og:url', canonicalUrl],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', desc],
    ['name', 'twitter:image', img],
  ]);

  html = html.replace(
    /<script type="application\/ld\+json" id="ldjson">[\s\S]*?<\/script>/,
    '<script type="application/ld+json" id="ldjson">' +
      JSON.stringify(ArzuzListing.schema(row, canonicalUrl)) + '</script>'
  );

  return html;
}

/* ---------- handler ---------- */

/* A minute of edge cache would stampede the database under a traffic
   spike; stale-while-revalidate keeps the re-render off the critical
   path for whoever arrives first after it expires — same pattern as
   browse.js. */
const HEAD = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=600'
};

/* Permanent: this room has a different address now, or never had this one.
   A crawler should forget the old URL and keep the new one. */
function redirect(to) {
  return { statusCode: 301, headers: { Location: to, 'Cache-Control': 'public, max-age=3600' } };
}

/* Temporary: this deploy is degraded (a bundled file missing). 301 here
   would tell a crawler that /rooms/<slug> is permanently gone, and it would
   drop the listing over a bundling mistake that the next deploy fixes. */
function bounce(to) {
  return { statusCode: 302, headers: { Location: to, 'Cache-Control': 'no-store' } };
}

function notFound(page) {
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' },
    body: page || '<!doctype html><meta charset="utf-8"><title>Not found</title>' +
      '<p>That room is not on Arzuz. <a href="/browse">See the verified rooms</a>.</p>'
  };
}

exports.handler = async function (event) {
  const rawUrl = event.rawUrl || '';
  const pathname = event.path || (rawUrl ? new URL(rawUrl).pathname : '');

  /* Without the shared rules there is no safe way to build or check an
     address, so the old query-string page takes the request. */
  if (!ArzuzListing) {
    console.error('[rooms] assets/listing-url.js missing from sandbox — falling back to /listing');
    const qs = rawUrl.indexOf('?') === -1 ? '' : rawUrl.slice(rawUrl.indexOf('?'));
    return bounce('/listing' + qs);
  }

  const id = ArzuzListing.idFromPath(pathname);

  /* /rooms/ with nothing after it is not a room. There is no index page
     for this path on purpose: a list of every room already exists at
     /browse, and two pages doing that job would compete with each other. */
  if (!id) return redirect('/browse?from=rooms');

  const page = readPage('listing.html');
  if (!page) {
    console.error('[rooms] listing.html missing from sandbox — falling back to /listing');
    return bounce('/listing?id=' + encodeURIComponent(id));
  }

  const row = await fetchListing(id);
  if (!row) return notFound(readPage('404.html'));

  const canonical = SITE + ArzuzListing.path(row);
  if (!ArzuzListing.isCanonical(pathname, row)) return redirect(ArzuzListing.path(row));

  const checks = await fetchChecks(id);
  const bodyHtml = renderBody(row, checks);
  let html = rewriteHead(page, row, canonical, checks);

  /* The room, in the markup, visible without a line of JavaScript. */
  html = html.replace(
    /<div id="ldSkeleton">/,
    '<div id="ldSkeleton" style="display:none">'
  );
  html = html.replace(
    '<div id="ldContent" style="display:none"></div>',
    '<div id="ldContent">' + bodyHtml + '</div>'
  );

  /* Hand the id to the page. /rooms/<slug> carries no ?id=, and this
     page is the same listing.html that /listing?id= serves — so the id
     has to arrive some other way, or the client would boot with no id
     and paint "this listing isn't live" over a page that is live.
     Before the page's own scripts, which read it on boot. */
  html = html.replace(
    '<script src="assets/config.js"></script>',
    '<script>window.ARZUZ_LISTING_ID=' + JSON.stringify(id) + ';</script>\n' +
      '<script src="assets/config.js"></script>'
  );

  /* LAST, once every step above has matched the page's own markup: the
     relative asset URLs become root-absolute only for this nested address. */
  html = absolutizeAssets(html);

  return { statusCode: 200, headers: HEAD, body: html };
};
