#!/usr/bin/env node
/* ============================================================
   Arzuz — the ONE place a page's own display rules are restated

   Both browser suites judge a page the same way: they RESTATE that
   page's rules and apply them to the row the page was given —
   `scripts/test-listing-render.mjs` for listing.html,
   `scripts/test-invite-render.mjs` for complete-listing.html.
   Restating is the whole point; an expectation copied from the page's
   current output proves nothing.

   But a restatement that lives inside a suite drifts the moment the
   OTHER page's suite is edited: one file gets the new rule, the other
   keeps asserting last month's behaviour and still goes green. So
   each page's rules are stated exactly once — here — and both suites
   import them. That is also why this file carries no assertions about
   what a page DID: it states what a page MUST do, and the suites
   compare.

   FIVE THINGS KEEP THIS FILE HONEST

     · LAYOUT_RULES — the three overflow rules ("text escapes its box",
       "box escapes its parent", "content clipped") are stated once, and
       the THREE scanners built from them follow: `scanSource()` (the
       text the invite suite injects into the page), the browser-side
       copy in dev/listing-fixture.js, and the admin dashboard suite,
       which used to carry a fourth copy of the same sentences and now
       imports this object. A rule retyped anywhere fails
       `verifyPageRules()` instead of passing unnoticed — either because
       the scanner stopped naming it, or because a reader started
       restating it.

     · THE BOOT LAYER — the two pages whose harness is not a page
       (dev/page-harness-boot.js) carry the scripts their own boot
       depends on, and both of their suites derive their fault targets
       from that table rather than keeping a copy of it.

     · PAGE RULES differ per page, on purpose. `INVITE` and `LISTING`
       are two separate rule sets because the pages really do differ
       (the invite form does not de-duplicate media by url; the listing
       page builds a gallery). Sharing them would be wrong; not sharing
       the STATEMENT of them is what was wrong.

     · WORKED EXAMPLES — a rule that cannot be read back out of the
       page's source is pinned by an input whose answer is written
       down (INVITE.legacyWho, LISTING.anchor), so the rule has at
       least one case that can be checked by eye.

     · verifyPageRules() — every sentence, id and class a suite
       asserts by equality is named here beside the file it must be
       found in. It reads the page and fails when the page has moved
       on. That failure is neither a page bug nor a suite bug: it says
       "this restatement is stale — decide which of the two is wrong",
       which is the decision both suite headers always asked for and
       nothing was forcing anyone to make.

   Run it on its own to see every pin at once:

     node scripts/page-rules.mjs            (and --quiet to print only failures)
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

const str = s => (s === null || s === undefined ? '' : String(s));

/* ---------------- 1. the three layout rules ----------------

   One statement of the rule, used by both sides: the invite suite
   injects scanSource() into the page it loaded, and the listing suite
   reads offenders out of the diagnostic dev/listing-fixture.js already
   runs — with verifyPageRules() holding that copy to these names. */

export const LAYOUT_RULES = {
  text: 'text escapes its box',        /* a range wider than the box holding it */
  box: 'box escapes its parent',       /* the element itself wider than its parent */
  clip: 'content clipped'              /* hidden behind an overflow with nothing to scroll to */
};

/* the FOURTH reader of those rules: the admin dashboard's browser suite
   scans a different surface (a card grid and a modal, not a page of the
   site) so its scanner is its own — but the three sentences are not. */
export const LAYOUT_ADMIN_SUITE = 'scripts/test-admin-worst.mjs';
export const LAYOUT_SLACK = 1.5;       /* px of sub-pixel layout noise to ignore */

/* the two numbers the invite rule arithmetic runs on, named once so the
   sentences built from them below cannot carry a stale digit */
export const INVITE_GRID_CAP = 12;
export const INVITE_MAX_UNITS = 999;
const UNITS_TYPO_LEAD = 'That looks like a typo — the count is capped at ';

export function scanSource() {
  return `function __offenders(SEL){
  var offenders=[];
  SEL.forEach(function(sel){
    var nodes; try { nodes=document.querySelectorAll(sel); } catch(e){ return; }
    Array.prototype.forEach.call(nodes, function(node,i){
      var bx=node.getBoundingClientRect();
      if(!bx.width) return;
      var why=null, by=0;
      var range=document.createRange();
      range.selectNodeContents(node);
      var tx=range.getBoundingClientRect();
      if(tx.width && tx.right>bx.right+${LAYOUT_SLACK}){ why='${LAYOUT_RULES.text}'; by=tx.right-bx.right; }
      var par=node.parentElement;
      if(!why && par){
        var pb=par.getBoundingClientRect();
        if(pb.width && bx.right>pb.right+${LAYOUT_SLACK}){ why='${LAYOUT_RULES.box}'; by=bx.right-pb.right; }
      }
      if(!why && node.scrollWidth>node.clientWidth+${LAYOUT_SLACK} && getComputedStyle(node).overflow!=='visible'){
        why='${LAYOUT_RULES.clip}'; by=node.scrollWidth-node.clientWidth;
      }
      if(why) offenders.push({ sel: sel+'['+i+']', why: why, by: Math.round(by),
                               text: String(node.textContent||'').trim().slice(0,48) });
    });
  });
  return offenders;
}`;
}

/* the browser-side copy of the same scan, in the harness's own fixture */
export const LAYOUT_SCAN_FILE = 'dev/listing-fixture.js';

/* ---------------- 2. the widths ----------------

   One table, so a suite cannot quietly sweep a width the other one
   was told about. Narrow is 320: the width budget phones actually
   report, and the one complete-listing.html's own stylesheet names
   ("at 320px two 118px tiles do not fit"). */

export const WIDTHS = {
  desktop: { key: 'desktop', w: 1440, h: 900 },
  mobile: { key: 'mobile', w: 390, h: 844 },
  narrow: { key: 'narrow', w: 320, h: 568 }
};

/* ---------------- 3. the fixture-plan questions ----------------

   Both fixtures publish a plan() built from a declared matrix, and both
   suites ask it the same three questions. The words differ; the
   questions do not. */

export function planChecks(plan, { noun = 'case', cells = 'declared cells' } = {}) {
  const items = plan.cases || plan.seeds || [];
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });

  t('the fixture reports no internal violation (' + items.length + ' ' + noun + 's, ' +
    plan.cells + ' ' + cells + ')',
    plan.violations.length === 0, plan.violations.slice(0, 6).join(' · '));

  const uncovered = [];
  Object.keys(plan.matrix).forEach(field => plan.matrix[field].forEach(state => {
    if (!items.some(s => s.pairs.some(p => p.field === field && p.state === state))) {
      uncovered.push(field + '·' + state);
    }
  }));
  t('every declared cell of the matrix is exercised by a ' + noun + ' (' + plan.cells + ' cells)',
    uncovered.length === 0, 'no ' + noun + ' exercises: ' + uncovered.join(', '));

  t('every ' + noun + ' carries a label, a note and its pairs',
    items.every(s => s.label && s.note && (s.pairs.length > 0 || s.noRow)),
    items.filter(s => !s.label || !s.note || (!s.pairs.length && !s.noRow))
      .map(s => s.key || s.id).join(', '));
  return out;
}

/* ---------------- 4. complete-listing.html ----------------

   The invite form's rules, restated from assets/complete-listing.js
   (fillForm, cleanUt, renderGallery's cap, availState/roomsText, the
   two availability notes) and applied to THE ROW THE PAGE WAS GIVEN.
   `verifyPageRules()` below pins every constant and sentence here
   against that file. */

/* the media rule: the payload's media list (url required), else the row's
   photo, else its video link — and, unlike the listing page, NO
   de-duplication: this form shows the landlord what is stored */
function inviteMediaOf(p) {
  const out = [];
  if (Array.isArray(p.media)) {
    p.media.forEach(m => {
      if (m && m.url) out.push({ type: m.type === 'video' ? 'video' : 'image', url: String(m.url) });
    });
  }
  if (!out.length && p.photo) out.push({ type: 'image', url: String(p.photo) });
  if (!out.some(m => m.type === 'video') && (p.video || p.video_url)) {
    out.push({ type: 'video', url: String(p.video || p.video_url) });
  }
  return out;
}

export const INVITE = {
  /* what the browser suite sweeps */
  widths: [WIDTHS.desktop, WIDTHS.mobile, WIDTHS.narrow],

  /* the committed grid shows the first twelve and offers the rest behind one
     button; nothing is dropped from the payload (renderGallery) */
  GRID_CAP: INVITE_GRID_CAP,
  /* the units ceiling the page applies and says out loud */
  MAX_UNITS: INVITE_MAX_UNITS,
  /* the two floors the page's own stylesheet declares, read back out of it by
     verifyPageRules() and asserted on the rendered layout in the 320px pass */
  tileMinPx: 104,     /* .cl-stage  — minmax(min(104px, 100%), 1fr) */
  ctaMinPx: 190,      /* .cl-actions .next — min-width: 190px */
  /* the three tabs, and the panel each one owns */
  TABS: ['specs', 'location', 'media'],
  /* the role vocabulary, and the legacy "who runs the compound?" answers
     mapped onto it — the same two tables complete-listing.js carries */
  CONTACT_ROLES: ['Landlord', 'Caretaker', 'Agent', 'Admin'],
  legacyWho: {
    'I do, myself': 'Landlord', 'The owner': 'Landlord', 'A landlord': 'Landlord',
    'A caretaker': 'Caretaker', 'A caretaker / security': 'Caretaker',
    'An agent': 'Agent', 'Nobody yet': 'Admin'
  },

  /* every sentence a suite asserts by equality, with the value it is built
     from — verifyPageRules() looks each one up in the page */
  text: {
    titleEdit: 'Complete your apartment',
    titleView: 'Your apartment details',
    permView: 'View only',
    permExpires: 'Your link expires',
    namePlaceholder: 'e.g. Blessing Lodge',
    emptyMedia: 'No media yet. The first photo you upload becomes the cover students see on the browse page.',
    zeroUnits: '0 vacant units — this listing will be saved as fully occupied.',
    unitsTypo: UNITS_TYPO_LEAD + INVITE_MAX_UNITS + '.',
    /* the sentence as the page assembles it: the lead is a literal, the
       ceiling is the constant — so the lead is what gets pinned below */
    unitsTypoLead: UNITS_TYPO_LEAD,
    roomsOne: ' room available',
    roomsMany: ' rooms available',
    roomsNone: 'Units available',
    fullyOccupied: 'Fully occupied',
    coverIs: '★ Cover photo',
    coverSet: '★ Set as cover',
    kindPhoto: '📷 photo',
    kindTour: '🎥 tour',
    moreAll: 'Show all ',
    moreFewer: 'Show fewer'
  },

  /* the ids and classes a suite's probe reads — the page's own display
     contract, and the thing that breaks silently when the page renames one */
  dom: {
    html: ['clLoading', 'clDead', 'clDeadTitle', 'clDeadBody', 'clDone', 'clForm', 'clFormEl',
      'clTitle', 'clPermNote',
      'clSavedNote', 'clOk', 'clError', 'clAvailSeg', 'clUnitsWrap', 'clUnitsNote', 'cl_avail',
      'clStageGrid', 'cl_units', 'cl_access_notes',
      'clSave', 'clSaveDraft', 'clDiscard', 'clAmenityChips', 'clMapCoords', 'cl_photo_url',
      'cl_video_url'],
    script: ['cl-tile', 'cl-kind', 'cl-cover', 'cl-x', 'cl-more', 'cl-empty', 'cl-tag',
      'cl-seg-btn', 'cl-view-only'],
    css: ['.cl-actions', '.cl-stage', '.cl-grid .full', 'minmax(min('],
    panels: ['data-cl-tab', 'data-cl-panel']
  },

  /* what the probe walks when it looks for overflow (see LAYOUT_RULES) */
  overflowSelectors: ['.cl-card h1', '#clTitle', '.cl-tag > span', '.cl-coords', '.cl-status',
    '.cl-up', '.cl-empty', '.cl-more', '.cl-perm', '.cl-hint', '.cl-saved', '.cl-drop small',
    '.cl-kind', '.cl-tab', '#clUnitsNote', '.fld > label', '.cl-note'],

  /* cleanUt(): trim, collapse runs of space, drop case-insensitive duplicates
     — "Borehole water" and "borehole water" are one chip, not two */
  cleanUt(list) {
    const arr = Array.isArray(list) ? list : (list ? str(list).split(',') : []);
    const seen = {};
    return arr.filter(u => {
      const k = str(u).trim().replace(/\s+/g, ' ').toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = 1;
      return true;
    }).map(u => str(u).trim().replace(/\s+/g, ' '));
  },

  mediaOf: inviteMediaOf,

  deriveExpect(row) {
    const p = (row && row.payload) || {};
    const generated = (p.name_generated === true || p.name_generated === 'true');
    const media = inviteMediaOf(p);
    const chips = INVITE.cleanUt(p.ut);

    /* availability: `avail` decides the segment, `units` the box — and a legacy
       row can say "vacant, 0 units", which the page must read as fully occupied */
    const mode = str(p.avail) === 'occupied' ? 'occupied' : 'vacant';
    let units = (p.units !== null && p.units !== undefined && p.units !== '') ? String(p.units) : '';
    if (!units && mode === 'vacant') units = str(p.rm).replace(/[^0-9]/g, '');
    const unitsTyped = units === '' ? null : parseInt(units.replace(/[^0-9]/g, ''), 10);
    const zeroUnits = unitsTyped === 0;

    const firstImage = media.filter(m => m.type === 'image')[0];
    const firstVideo = media.filter(m => m.type === 'video')[0];
    const capped = media.length > INVITE.GRID_CAP;
    const shown = capped ? media.slice(0, INVITE.GRID_CAP) : media;
    const kinds = {};
    shown.forEach(m => { const k = m.type === 'video' ? INVITE.text.kindTour : INVITE.text.kindPhoto; kinds[k] = (kinds[k] || 0) + 1; });

    const role = INVITE.CONTACT_ROLES.indexOf(str(p.contact_role)) !== -1
      ? str(p.contact_role) : (INVITE.legacyWho[str(p.who)] || '');

    const lat = parseFloat((row && row.latitude) || p.lat);
    const lng = parseFloat((row && row.longitude) || p.lng);

    return {
      generated,
      propName: generated ? '' : str(p.prop_name),
      namePlaceholder: (generated && p.prop_name) ? str(p.prop_name) : INVITE.text.namePlaceholder,
      ty: str(p.ty),
      ar: str(p.ar),
      rent: (p.rent === null || p.rent === undefined) ? '' : str(p.rent),
      ask: (row && row.opening_ask_ngn !== null && row.opening_ask_ngn !== undefined)
        ? str(row.opening_ask_ngn)
        : ((p.ask !== null && p.ask !== undefined) ? str(p.ask) : ''),
      nm: str(((str(p.nm) + ' ' + str(p.last)).trim()) || str(p.owner_name)),
      ph: str(p.ph),
      role,
      desc: str(p.desc || p.description || ''),
      accessNotes: (p.passage && typeof p.passage === 'object' && str(p.passage.landmark)) || str(p.access_notes),
      splitOk: (p.split_ok === true || p.split_ok === 'yes'),
      segment: mode,
      units,
      storedAvail: zeroUnits ? 'occupied' : mode,
      unitsNote: zeroUnits
        ? INVITE.text.zeroUnits
        : (unitsTyped !== null && unitsTyped > INVITE.MAX_UNITS ? INVITE.text.unitsTypo : null),
      chips,
      media: media,
      tiles: shown.length,
      imageCount: shown.filter(m => m.type === 'image').length,
      tileKinds: kinds,
      more: capped ? INVITE.text.moreAll + media.length + ' (' + (media.length - INVITE.GRID_CAP) + ' more)' : null,
      empty: media.length ? null : INVITE.text.emptyMedia,
      photoUrl: firstImage ? firstImage.url : '',
      videoUrl: firstVideo ? firstVideo.url : '',
      pin: (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null,
      viewOnly: (str((row || {}).draft_permission) === 'view')
    };
  },

  /* what the patch the page collected must say, for the seed whose data is at
     every ceiling — derived from the same row everything above was derived from */
  wireChecks(exp, row, patch, writes, page) {
    const out = [];
    const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
    const p = (row && row.payload) || {};

    t('pressing Save draft wrote exactly one patch', writes.length === 1,
      writes.length + ' write(s): ' + JSON.stringify(writes.map(w => Object.keys(w || {}).join(','))));
    if (!patch) {
      t('the patch the page sent', false, 'nothing arrived at the mock — the page\'s own error note says: ' +
        JSON.stringify(page.errText || page.okText || ''));
      return out;
    }
    t('the page confirmed the save', /Progress saved/.test(page.okText), 'the page says: ' + JSON.stringify(page.okText));
    t('the patch is marked as progress, not as ready for review', patch.save_mode === 'progress', JSON.stringify(patch.save_mode));
    t('the ceiling name survives the round trip (' + exp.propName.length + ' characters)',
      patch.prop_name === exp.propName && patch.name_generated === false,
      JSON.stringify({ got: patch.prop_name, generated: patch.name_generated }));
    t('the exotic area survives', patch.ar === exp.ar, JSON.stringify(patch.ar));
    t('both prices survive', patch.rent === exp.rent && patch.ask === exp.ask,
      JSON.stringify({ rent: patch.rent, ask: patch.ask }));
    t('0 vacant units is stored as fully occupied, not as a vacancy',
      patch.avail === 'occupied' && patch.units === null && patch.rm === INVITE.text.fullyOccupied,
      JSON.stringify({ avail: patch.avail, units: patch.units, rm: patch.rm }));
    t('the pins survive as a pin, in the format the dashboard reads',
      patch.lat === String(exp.pin.lat) && patch.lng === String(exp.pin.lng) &&
      patch.pin === exp.pin.lat.toFixed(6) + ',' + exp.pin.lng.toFixed(6),
      JSON.stringify({ lat: patch.lat, lng: patch.lng, pin: patch.pin }));
    t('the landmark survives as the passage', (patch.passage || {}).landmark === exp.accessNotes &&
      patch.access_notes === exp.accessNotes, JSON.stringify((patch.passage || {}).landmark || patch.access_notes));
    t('the traced walk-in path is carried over, not dropped',
      Array.isArray((patch.passage || {}).route) && patch.passage.route.length ===
        ((p.passage && p.passage.route) || []).length,
      JSON.stringify((patch.passage || {}).route));
    t('the ' + exp.chips.length + ' amenity chips are what gets saved',
      JSON.stringify(patch.ut) === JSON.stringify(exp.chips), JSON.stringify(patch.ut));
    t('all ' + exp.media.length + ' media items are saved, and the cover with them',
      Array.isArray(patch.media) && patch.media.length === exp.media.length && patch.photo === exp.photoUrl,
      JSON.stringify({ media: (patch.media || []).length, photo: patch.photo }));
    t('both share links survive: the youtu.be tour and the Drive copy',
      patch.video === exp.videoUrl && patch.video_url === exp.videoUrl && patch.media.some(m => /youtu\.be/.test(m.url)) &&
        patch.media.some(m => /drive\.google\.com/.test(m.url)),
      JSON.stringify({ video: patch.video, urls: (patch.media || []).filter(m => m.type === 'video').map(m => m.url) }));
    t('the pasted blurb is saved whole (' + exp.desc.length + ' characters)',
      patch.desc === exp.desc, (patch.desc || '').length + ' characters arrived');
    t('the contact survives', patch.nm === exp.nm && patch.ph === exp.ph && patch.contact_role === exp.role,
      JSON.stringify({ nm: patch.nm, ph: patch.ph, role: patch.contact_role }));
    return out;
  }
};

/* ---------------- 5. listing.html ----------------

   The student-facing listing page's rules, restated from the inline
   script in listing.html (money, buildMedia, the amenities grid,
   ArzuzMap.passage.normalise, tierBadge) and applied to the row the
   harness held. */

/* the page's own money(): a number, a digit string, or a formatted
   "150,000" from an import — NaN becomes 0, never the string "NaN" */
function listingMoney(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : 0;
}

/* buildMedia(): entries with a url, video only when the type says so,
   then the row's photo, then its video link, de-duplicated by url */
function listingMediaOf(row) {
  const p = (row && row.payload) || {};
  const out = [];
  if (Array.isArray(p.media)) {
    p.media.forEach(it => {
      if (it && it.url) out.push({ type: it.type === 'video' ? 'video' : 'image', url: String(it.url) });
    });
  }
  if (!out.length && p.photo) out.push({ type: 'image', url: String(p.photo) });
  if (!out.length && (p.video || p.video_url)) out.push({ type: 'video', url: String(p.video || p.video_url) });
  const seen = {}; const ded = [];
  out.forEach(it => { if (!seen[it.url]) { seen[it.url] = 1; ded.push(it); } });
  return ded;
}

/* the amenities grid takes the first non-empty of ut / utilities, splits a
   legacy comma-joined string, and keeps only non-empty strings */
function listingUtilitiesOf(row) {
  const p = (row && row.payload) || {};
  let ut = (p.ut !== undefined && p.ut !== null && p.ut !== '') ? p.ut : p.utilities;
  if (typeof ut === 'string') ut = ut.split(',');
  if (!Array.isArray(ut)) ut = [];
  return ut.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
}

/* ArzuzMap.passage.normalise(): strings only for the three fields, steps
   kept when their text is non-empty, and null when nothing usable is there */
function listingPassageOf(row) {
  const raw = ((row && row.payload) || {}).passage;
  if (!raw || typeof raw !== 'object') return null;
  const out = { landmark: typeof raw.landmark === 'string' ? raw.landmark : '', gate: typeof raw.gate === 'string' ? raw.gate : '', floor: typeof raw.floor === 'string' ? raw.floor : '', steps: [], route: [] };
  if (Array.isArray(raw.steps)) {
    raw.steps.forEach(s => {
      if (!s) return;
      if (typeof s === 'string') s = { text: s };
      if (s.text && String(s.text).trim()) out.steps.push(String(s.text).trim());
    });
  }
  if (Array.isArray(raw.route)) {
    raw.route.forEach(pt => {
      const la = Number(pt && pt[0]), ln = Number(pt && pt[1]);
      if (isFinite(la) && isFinite(ln)) out.route.push([la, ln]);
    });
  }
  if (!out.landmark && !out.gate && !out.floor && !out.steps.length && out.route.length < 2) return null;
  return out;
}

/* reading what rendered: exact element counts, because a plain substring
   count also matches the container class ("gal-thumb" counts "gal-thumbs",
   "feat" counts "feat-grid") */
const unescapeHtml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export const LISTING = {
  widths: [WIDTHS.desktop, WIDTHS.mobile, WIDTHS.narrow],
  /* the two numbers the 320px pass asserts on, both read back out of the
     stylesheet by verifyListingRules() so the pass cannot invent a floor */
  galRatio: { w: 16, h: 10 },   /* .gal — aspect-ratio: 16 / 10 */
  mapMinPx: 380,                /* .route-map-wrap #routeMap — height: 380px */
  money: listingMoney,
  mediaOf: listingMediaOf,
  utilitiesOf: listingUtilitiesOf,
  passageOf: listingPassageOf,

  /* the page's own markup contract, exactly as the suite counts it */
  render: {
    slides: /<div class="gal-slide"/g,
    thumbs: /<button type="button" class="gal-thumb/g,
    features: /<div class="feat /g,
    steps: /<li data-lat/g,
    count: (hay, re) => (hay.match(re) || []).length,
    text: (html, re) => { const m = html.match(re); return m ? unescapeHtml(m[1]).trim() : null; }
  },
  dom: {
    ids: ['ldContent', 'ldError', 'ldSkeleton', 'routeMap', '__fx-diag'],
    classes: ['gal-slide', 'gal-thumb', 'gal-chip', 'ld-price', 'h-badge', 'passage-card',
      'ld-card', 'ld-sec', 'About this place', 'data-lat'],
    text: {
      unnamed: 'Unnamed property',
      placeholder: 'Photos coming soon',
      badge1: 'Community verified',
      badge2: 'Inspected',
      badge0: 'Unverified'
    }
  },

  deriveExpect(row) {
    const p = (row && row.payload) || {};
    const media = listingMediaOf(row);
    const ut = listingUtilitiesOf(row);
    const ps = listingPassageOf(row);
    const name = str(p.prop_name).trim();
    const desc = p.desc || p.description || '';
    const tier = Number(row && row.tier);
    const hasPassage = !!(ps && (ps.landmark || ps.gate || ps.floor || ps.steps.length));
    const slides = media.length || 1;                      /* 0 media → one placeholder frame */
    return {
      title: name || LISTING.dom.text.unnamed,
      badge: tier >= 2 ? LISTING.dom.text.badge2 : (tier === 1 ? LISTING.dom.text.badge1 : LISTING.dom.text.badge0),
      price: '₦' + listingMoney(p.rent).toLocaleString(),
      slides: slides,
      thumbs: media.length > 1 ? media.length : 0,
      features: ut.length,
      steps: ps ? ps.steps.length : 0,
      hasRouteMap: isFinite(parseFloat(row && row.latitude)) && isFinite(parseFloat(row && row.longitude)),
      hasPassage: hasPassage,
      hasAbout: !!String(desc).trim(),
      comingSoon: media.length === 0,
      chip: slides > 1 ? '1 / ' + slides : null,
      noChip: slides <= 1,
      videoThumb: media.some(m => m.type === 'video'),
      escapedScriptTag: /<script/i.test(String(desc)),
      longName: name.length >= 40 && !/\s/.test(name)
    };
  },

  /* The old hand-verified table for the four cases whose data is byte-for-byte
     what it always was. It is not used to assert on the page; it is used to
     assert on the DERIVATION, so a rule that quietly stops matching the page's
     behaviour cannot pass by agreeing with itself. */
  anchor: {
    demo: {
      title: 'Ilorin Close Self-Contain', badge: 'Inspected', price: '₦185,000',
      slides: 3, thumbs: 3, features: 4,
      hasRouteMap: true, hasPassage: true, hasAbout: true, comingSoon: false
    },
    worst: {
      /* tier is the string 'verified' → Number() is NaN → the honest badge, not "NaN" */
      title: 'OLUWASEUNBABATUNDEADEGOKEMEMORIALSTUDENTLODGEANDSUITESSMALETE',
      badge: 'Unverified',
      /* a hand-edited "150,000" must print as a price, not as ₦NaN */
      price: '₦150,000',
      slides: 3, thumbs: 3,   /* the entry with no url drops; the rest are shown */
      features: 4,            /* '', null and 42 drop; the four real labels stay */
      hasRouteMap: false,     /* latitude without longitude is not a location */
      hasPassage: true, hasAbout: true, comingSoon: false,
      escapedScriptTag: true, longName: true
    },
    empty: {
      title: 'Unnamed property', badge: 'Unverified', price: '₦0',
      slides: 1, thumbs: 0,   /* one placeholder frame saying "Photos coming soon" */
      features: 0,
      hasRouteMap: false, hasPassage: false, hasAbout: false, comingSoon: true
    },
    huge: {
      title: 'Grand Imperial Student Village Phase 2 Annex Extension',
      badge: 'Inspected', price: '₦123,456,789',
      slides: 50, thumbs: 50, features: 40, steps: 12,
      hasRouteMap: true, hasPassage: true, hasAbout: true, comingSoon: false,
      chip: '1 / 50', videoThumb: true, escapedScriptTag: true
    }
  }
};

/* ---------------- 6. the boot layer of the two pages with no harness page ----

   scripts/test-listing-render.mjs and scripts/test-invite-render.mjs each load a
   document.write harness that repairs a lost script before the suite ever sees
   the page (dev/listing-harness.html, dev/complete-listing-harness.html).
   scripts/test-admin-worst.mjs and scripts/test-home-motion.mjs load their page
   whole — the dashboard's own dev mode, and the real index.html — so their
   repair is dev/page-harness-boot.js, injected by a dev-only block at the end of
   each page, and it states one thing per page: the scripts that hold up that
   page's own boot, and the global each of them must leave on window.

   That table is read back OUT of the boot file rather than copied here — the
   same shape scripts/test-invite-render.mjs reads the invite harness's LAYER map
   with — because what a fault mode needs is the aim the harness actually
   repairs. Derived, a script added to the page and to the table is instantly a
   target; copied, the two drift until a mode aims at nothing and still passes.

   What is restated here is what those two readers must meet, and both of them
   run it before a browser opens — so a drifted table is a plan failure, never a
   load that quietly proves nothing:

     · the boot file still carries a layer for a page the suite drives;
     · every script it watches for that page is a script the page itself names;
     · the page still loads the check (a page that dropped the dev-only block
       would leave a lost script unrepaired, and the suite would report a page
       bug where a request was lost);
     · the intersection the fault mode aims at is not empty. */

export const HARNESS_BOOT_FILE = 'dev/page-harness-boot.js';

/* page → [{ script, global }], as dev/page-harness-boot.js states it. The row is
   read by counting brackets rather than by a regex to its first ]: every pair
   inside the row is an array of its own, so the first ] in the text is the end
   of a pair, not of the row. */
export function harnessLayers(bootSource) {
  const src = String(bootSource);
  const at = src.indexOf('var LAYERS = {');
  const body = at === -1 ? '' : src.slice(at);
  const out = {};
  for (const key of body.matchAll(/'([\w.-]+\.html)':\s*\[/g)) {
    const open = key.index + key[0].length - 1;
    const close = matchingBracket(body, open);
    if (close === -1) continue;
    out[key[1]] = [...body.slice(open + 1, close).matchAll(/\['([^']+)',\s*'([^']+)'\]/g)]
      .map(m => ({ script: m[1], global: m[2] }));
  }
  return out;
}

/* the index of the ] that closes the [ at `open`, counting nesting */
function matchingBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '[') depth += 1;
    else if (s[i] === ']') {
      depth -= 1;
      if (!depth) return i;
    }
  }
  return -1;
}

/* Every local script the page names. This reads the page's TEXT, so a script
   the page injects with document.write counts as named — which is how
   admin.html's dev/admin-mock*.js arrive, and they are half of what holds that
   dashboard's boot up. */
export function pageScriptsNamed(pageSource) {
  return [...String(pageSource).matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(m => m[1].replace(/\?.*$/, '').replace(/^\//, ''));
}

/* Everything a fault mode needs to aim at this page's boot layer, plus the pins
   that say the aim is still true. Both suites run this before a browser opens,
   so a drifted table fails the run as a plan rather than as a load that proved
   nothing. */
export function harnessBootPlan({ page, bootSource, pageSource }) {
  const checks = [];
  const t = (name, ok, note) => checks.push({ name: name, ok: !!ok, note: ok ? '' : (note || '') });
  const rows = harnessLayers(bootSource)[page] || [];
  const named = pageScriptsNamed(pageSource);
  const candidates = rows.map(r => r.script).filter(script => named.indexOf(script) !== -1);

  t(HARNESS_BOOT_FILE + ' still carries a boot layer for ' + page,
    rows.length > 0,
    'no row for ' + page + ' in its LAYERS table — the boot check would have no opinion about this ' +
    'page, and its fault mode would aim at nothing');
  t('every script the boot check watches on ' + page + ' is one the page itself names (' +
    rows.map(r => r.script).join(', ') + ')',
    rows.length > 0 && rows.every(r => named.indexOf(r.script) !== -1),
    'the page no longer names: ' +
    rows.filter(r => named.indexOf(r.script) === -1).map(r => r.script).join(', ') +
    ' — delete it from ' + HARNESS_BOOT_FILE + ', or put it back on the page');
  t(page + ' still loads that check from its own end (' + HARNESS_BOOT_FILE + ')',
    String(pageSource).indexOf(HARNESS_BOOT_FILE) !== -1,
    'the page no longer names ' + HARNESS_BOOT_FILE + ' — a request lost on this page would reach the ' +
    'suite as a broken page instead of a repaired one');
  t('the fault candidates for ' + page + ' are not empty',
    candidates.length > 0,
    'the table and the page share no script, so a fault mode here would prove nothing');

  return { rows: rows, named: named, candidates: candidates, checks: checks };
}
/* ---------------- 7. does the page still say any of this? ----------------

   Every pin is (what this file restates) → (the file that must still say it).
   A red line here means one of the two moved: decide which is wrong. */

const flat = s => String(s).replace(/\s+/g, ' ');

/* ---- the sources every pin reads ---- */

async function pageSources() {
  const inviteJs = flat(await readFile(join(SITE, 'assets/complete-listing.js'), 'utf8'));
  const inviteHtml = await readFile(join(SITE, 'complete-listing.html'), 'utf8');
  const listingHtml = await readFile(join(SITE, 'listing.html'), 'utf8');
  const fixture = flat(await readFile(join(SITE, LAYOUT_SCAN_FILE), 'utf8'));
  const adminSuite = flat(await readFile(join(SITE, LAYOUT_ADMIN_SUITE), 'utf8'));
  /* listing.html carries its own stylesheet by link, so the two numbers the
     320px pass asserts on have to be read out of assets/arzuz.css */
  const listingCss = flat(await readFile(join(SITE, 'assets/arzuz.css'), 'utf8'));
  /* ...and the check badge labels now come from assets/listing-url.js, which
     the page loads by script tag: the page and the server-rendered /rooms/
     block have to say the same words, so the words live in one file. Reading
     it here keeps the pin watching the label a visitor actually sees rather
     than letting it pass by being deleted from the page. */
  const listingUrl = flat(await readFile(join(SITE, 'assets/listing-url.js'), 'utf8'));
  return {
    adminSuite: adminSuite,
    listingCss: listingCss,
    inviteJs: inviteJs,
    inviteHtml: inviteHtml,
    inviteFlat: flat(inviteHtml),
    inviteAll: flat(inviteHtml) + ' ' + inviteJs,
    listingHtml: listingHtml,
    fixture: fixture,
    /* the listing diagnostic (its own id, and its scan) is written by the
       fixture, not by the page: those pins look in both — and the labels the
       page renders are in the module it loads, so that is read too */
    listingAll: flat(listingHtml) + ' ' + fixture + ' ' + listingUrl
  };
}

const collector = () => {
  const out = [];
  return { out: out, t: (name, ok, note) => out.push({ name: name, ok: !!ok, note: ok ? '' : (note || '') }) };
};

/* ---- the layout vocabulary, which both pages are scanned with ---- */

async function verifyLayoutRules() {
  const s = await pageSources();
  const c = collector();
  const rules = Object.values(LAYOUT_RULES);

  const missingRules = rules.filter(r => s.fixture.indexOf(r) === -1);
  c.t('the scan the listing harness runs (' + LAYOUT_SCAN_FILE + ') still names all ' +
    rules.length + ' overflow rules this file defines',
    missingRules.length === 0,
    'the fixture no longer says: ' + missingRules.join(', ') +
    ' — if it grew or renamed a rule, decide whether this file or the fixture is right');

  /* The admin dashboard's suite is the fourth reader. It used to restate these
     three sentences beside its own scanner; a retyped sentence there is a
     second statement of the same rule, which is how one reader ends up judging
     last month's behaviour while the others move on. So: the suite must not
     carry the copy, and it must actually read this object. */
  const restated = rules.filter(r => s.adminSuite.indexOf(r) !== -1);
  c.t('the admin dashboard\'s suite does not restate the overflow rules — it reads them from here (' +
    LAYOUT_ADMIN_SUITE + ')',
    restated.length === 0,
    LAYOUT_ADMIN_SUITE + ' hardcodes: ' + restated.join(', ') +
    ' — delete the copy and interpolate LAYOUT_RULES instead');

  c.t('the admin suite builds its overflow scan from this file\'s LAYOUT_RULES',
    /\bLAYOUT_RULES\b/.test(s.adminSuite),
    LAYOUT_ADMIN_SUITE + ' no longer names LAYOUT_RULES — its three reasons would drift ' +
    'from the other three readers');

  return c.out;
}

/* ---- the boot layer of the two pages with no harness page ---- */

async function verifyHarnessRules() {
  const bootSource = await readFile(join(SITE, HARNESS_BOOT_FILE), 'utf8');
  const c = collector();
  const pages = Object.keys(harnessLayers(bootSource));

  c.t('the boot check carries a layer for both pages that have no harness page (' +
    (pages.join(', ') || 'none') + ')',
    pages.indexOf('admin.html') !== -1 && pages.indexOf('index.html') !== -1,
    'it names: ' + (pages.join(', ') || 'nothing'));

  for (const page of pages) {
    const pageSource = await readFile(join(SITE, page), 'utf8');
    const plan = harnessBootPlan({ page: page, bootSource: bootSource, pageSource: pageSource });
    plan.checks.forEach(x => c.out.push(x));
  }

  /* The two readers must take the aim FROM that table. A second copy of it in
     a suite is how one of them keeps aiming at a script the harness stopped
     repairing, while still going green. */
  const readers = {
    'scripts/test-admin-worst.mjs': 'admin.html',
    'scripts/test-home-motion.mjs': 'index.html'
  };
  for (const file of Object.keys(readers)) {
    const src = flat(await readFile(join(SITE, file), 'utf8'));
    c.t(file + ' takes its fault candidates from ' + HARNESS_BOOT_FILE + ' (harnessBootPlan)',
      /\bharnessBootPlan\b/.test(src),
      file + ' does not name harnessBootPlan — its fault mode would aim at its own idea of ' + readers[file]);
  }

  return c.out;
}
/* ---- complete-listing.html ---- */

async function verifyInviteRules() {
  const s = await pageSources();
  const c = collector();
  const t = c.t;

  const gridCap = (s.inviteJs.match(/var GRID_CAP = (\d+);/) || [])[1];
  t('complete-listing.js still caps the committed grid at ' + INVITE.GRID_CAP +
    ' (the tile count is derived from it)',
    Number(gridCap) === INVITE.GRID_CAP,
    'the page now declares GRID_CAP = ' + JSON.stringify(gridCap));

  const maxUnits = (s.inviteJs.match(/var MAX_UNITS = (\d+);/) || [])[1];
  t('complete-listing.js still caps units at ' + INVITE.MAX_UNITS + ' (the typo note quotes it)',
    Number(maxUnits) === INVITE.MAX_UNITS,
    'the page now declares MAX_UNITS = ' + JSON.stringify(maxUnits));

  const tileMin = (s.inviteHtml.match(/grid-template-columns: repeat\(auto-fill, minmax\(min\((\d+)px, 100%\), 1fr\)\)/) || [])[1];
  t('the staged grid still declares the ' + INVITE.tileMinPx + 'px tile floor the 320px pass asserts',
    Number(tileMin) === INVITE.tileMinPx,
    'the stylesheet now says ' + JSON.stringify(tileMin) + ' — decide which of the two is right');

  const ctaMin = (s.inviteAll.match(/\.cl-actions \.next \{[^}]*min-width: (\d+)px/) || [])[1];
  t('the action bar still declares the ' + INVITE.ctaMinPx + 'px floor for the send button',
    Number(ctaMin) === INVITE.ctaMinPx,
    'the stylesheet now says ' + JSON.stringify(ctaMin) + ' — decide which of the two is right');

  const roles = (s.inviteJs.match(/var CONTACT_ROLES = \[([^\]]*)\]/) || [])[1];
  const roleList = roles ? roles.split(',').map(x => x.trim().replace(/^'|'$/g, '')) : [];
  t('the role vocabulary is still ' + INVITE.CONTACT_ROLES.join(', '),
    roleList.join('|') === INVITE.CONTACT_ROLES.join('|'), 'the page now lists: ' + roleList.join(', '));

  const missingWho = Object.keys(INVITE.legacyWho).filter(k => s.inviteJs.indexOf(k) === -1);
  t('every legacy "who runs the compound?" answer this file maps is still in the page (' +
    Object.keys(INVITE.legacyWho).length + ' of them)',
    missingWho.length === 0, 'gone from the page: ' + missingWho.join(', '));

  /* unitsTypo is built here from unitsTypoLead + MAX_UNITS, so pinning the lead
     (and the constant, above) pins the sentence the note must say */
  const inviteText = Object.keys(INVITE.text)
    .filter(k => k !== 'unitsTypo')
    .filter(k => s.inviteAll.indexOf(flat(INVITE.text[k])) === -1);
  t('every sentence the invite rules quote is still on complete-listing.html or its script (' +
    (Object.keys(INVITE.text).length - 1) + ' pins)',
    inviteText.length === 0,
    inviteText.map(k => k + ' → ' + JSON.stringify(INVITE.text[k])).join(' · '));

  /* the static copy a view with no JavaScript reads is the same sentence */
  const staticNote = (s.inviteHtml.match(/<small id="clUnitsNote" hidden>([^<]*)</) || [])[1];
  t('the no-JavaScript copy of the availability note is the same sentence the rules quote',
    flat(staticNote) === flat(INVITE.text.zeroUnits),
    'the page now ships: ' + JSON.stringify(staticNote));

  const missingIds = INVITE.dom.html.filter(id => s.inviteHtml.indexOf('id="' + id + '"') === -1);
  t('every id the invite probe reads is still in complete-listing.html (' +
    INVITE.dom.html.length + ' of them)',
    missingIds.length === 0, 'gone from the page: ' + missingIds.join(', '));

  const missingNames = INVITE.dom.script.concat(INVITE.dom.css)
    .filter(name => s.inviteAll.indexOf(name.replace(/^\./, '')) === -1);
  t('every class the invite rules name is still rendered by the page (' +
    (INVITE.dom.script.length + INVITE.dom.css.length) + ' of them)',
    missingNames.length === 0, 'gone from the page: ' + missingNames.join(', '));

  const missingPanels = INVITE.dom.panels.concat(INVITE.TABS).filter(name => s.inviteAll.indexOf(name) === -1);
  t('the three tabs and their panels are still the ones the rules drive (' +
    INVITE.TABS.join(', ') + ')',
    missingPanels.length === 0, 'gone from the page: ' + missingPanels.join(', '));

  const missingOverflow = INVITE.overflowSelectors.filter(sel =>
    s.inviteAll.indexOf(sel.replace(/^\./, '').split(' ')[0].replace(/^#/, '')) === -1);
  t('every selector the overflow scan walks still exists on the invite page (' +
    INVITE.overflowSelectors.length + ' of them)',
    missingOverflow.length === 0, 'gone from the page: ' + missingOverflow.join(', '));

  return c.out;
}

/* ---- listing.html ---- */

async function verifyListingRules() {
  const s = await pageSources();
  const c = collector();
  const t = c.t;

  const listingStrings = Object.values(LISTING.dom.text).concat(['About this place', 'passage-card']);
  const missingListing = listingStrings.filter(x => s.listingAll.indexOf(x) === -1);
  t('every sentence the listing rules quote is still on listing.html (' +
    listingStrings.length + ' pins)',
    missingListing.length === 0, 'gone from the page: ' + missingListing.join(', '));

  const missingListingDom = LISTING.dom.ids
    .concat(LISTING.render.slides.source.replace(/<div class="([^"]*)"/, '$1'))
    .filter(name => s.listingAll.indexOf(name) === -1);
  t('every id and gallery class the listing probe reads is still in listing.html or ' +
    LAYOUT_SCAN_FILE + ' (' + (LISTING.dom.ids.length + 1) + ' of them)',
    missingListingDom.length === 0, 'gone from the page: ' + missingListingDom.join(', '));

  const anchored = Object.keys(LISTING.anchor).length;
  t('the hand-verified table still covers ' + anchored + ' cases (' + Object.keys(LISTING.anchor).join(', ') + ')',
    anchored >= 4, 'cases: ' + Object.keys(LISTING.anchor).join(', '));

  const galRatio = s.listingCss.match(/\.gal \{[^}]*?aspect-ratio: (\d+) \/ (\d+)/);
  t('the gallery still declares the ' + LISTING.galRatio.w + ':' + LISTING.galRatio.h +
    ' shape the 320px pass measures',
    !!galRatio && Number(galRatio[1]) === LISTING.galRatio.w && Number(galRatio[2]) === LISTING.galRatio.h,
    'the stylesheet now says ' + (galRatio ? galRatio[1] + '/' + galRatio[2] : 'nothing') +
    ' — decide which of the two is right');

  const mapH = s.listingCss.match(/\.route-map-wrap #routeMap \{[^}]*?height: (\d+)px/);
  t('the route map still declares the ' + LISTING.mapMinPx + 'px height the 320px pass asserts',
    !!mapH && Number(mapH[1]) === LISTING.mapMinPx,
    'the stylesheet now says ' + (mapH ? mapH[1] : 'nothing') + 'px — decide which of the two is right');

  return c.out;
}

/* The suites ask for the half that describes their own page, plus the layout
   vocabulary both pages are scanned with — so the shared statement cannot go
   stale in one suite while the other one is updated. 'all' is for a standalone
   run, which has nobody else to catch it. */

export async function verifyPageRules(scope = 'all') {
  const groups = { layout: verifyLayoutRules, invite: verifyInviteRules, listing: verifyListingRules, harness: verifyHarnessRules };
  if (scope !== 'all' && !groups[scope]) {
    throw new Error('verifyPageRules(scope) is invite, listing, harness, layout or all — got ' + JSON.stringify(scope));
  }
  /* Every scope carries the layout vocabulary. It describes every scanner —
     the invite page's, the listing harness's and the admin suite's — so a
     page suite that asked only for its own half would leave the shared
     statement unwatched for the whole run, which is the drift this file
     exists to stop. */
  const wanted = scope === 'all' ? ['layout', 'invite', 'listing', 'harness']
    : (scope === 'layout' ? ['layout'] : ['layout', scope]);
  const out = [];
  for (const key of wanted) out.push.apply(out, await groups[key]());
  return out;
}

/* ---------------- run it alone ---------------- */

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/page-rules.mjs')) {
  const quiet = process.argv.slice(2).includes('--quiet');
  const checks = await verifyPageRules('all');
  const bad = checks.filter(c => !c.ok);
  if (!quiet) {
    checks.forEach(c => console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name));
    console.log('\nTOTAL ' + checks.length + ' · PASS ' + (checks.length - bad.length) + ' · FAIL ' + bad.length);
  } else if (bad.length) {
    bad.forEach(c => console.log('  ✗ ' + c.name + '\n      → ' + c.note));
    console.log('TOTAL ' + checks.length + ' · PASS ' + (checks.length - bad.length) + ' · FAIL ' + bad.length);
  }
  if (bad.length) process.exitCode = 1;
}
