/* ============================================================
   Arzuz Admin — the VM sandbox the dashboard runs in (DEV ONLY)

   Extracted from dev/admin-boot-test.js so that a second harness
   (dev/postgrest-test.js) can boot the SAME real scripts against
   the REAL PostgREST error shapes without a second copy of a DOM
   drifting away from this one. admin-boot-test.js requires this
   file, and the boot suite's checks are the proof it is faithful.

   What it is NOT: the sandbox does not serve anything. Its fetch is
   a placeholder that records calls; dev/admin-mock.js replaces it
   when it loads, and dev/postgrest-test.js passes its own.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = [
  'assets/config.js',
  /* the failure vocabulary every module in here now builds its messages
     through — admin.html loads it directly after config.js, so the sandbox
     does too, or the harness would exercise a code path no browser has */
  'assets/api-errors.js',
  'assets/admin-ui.js',
  'assets/auth.js',
  'assets/data.js',
  'assets/strategy.js',
  'assets/arzuz-map.js',
  /* the dossier renders question labels from the SHARED vocabulary, so the
     harness has to load it too — exactly as admin.html does */
  'assets/roommate-score.js',
  'assets/notify.js',
  'assets/submit.js',
  /* the drawer, sheet and lightbox drag physics — admin.html loads it
     immediately before admin.js, and admin.js constructs through it, so
     without this line the sandbox would boot a page whose gestures are
     silently missing and the boot suite would be green about a page no
     browser ever serves */
  'assets/swipe-gesture.js',
  /* the listing freshness/completeness score, which draws the Listings
     table's Crawl column — admin.html loads it immediately before
     admin.js, so the sandbox does too, or the harness would boot a
     dashboard whose crawl badges are silently blank */
  'assets/listing-score.js',
  /* the release policies those gestures decide by — admin.html loads it
     before this file, and admin.js reads its arithmetic at every paint
     and every release. Without it the three drag gestures are not
     registered at all (see the guard in admin.js's section 2b), so a
     sandbox missing this line would test a page that does not drag */
  'assets/release-policy.js',
  /* the verification shift's clock and ordering — admin.html loads it
     before admin.js and admin.js draws the queue panel through it, so a
     sandbox without this line boots a dashboard whose panel says "the
     queue clock did not load" and never draws a single row. That is what
     the boot suite said the first time the panel's checks ran. */
  'assets/verification-queue.js',
  /* the public badge's vocabulary and wording — stage 3. admin.html loads
     it immediately before admin.js, and the officer's visit form draws its
     checks from it, so a sandbox without this line boots a panel that
     cannot name a single thing the officer checked. */
  'assets/verification-badge.js',
  'assets/admin.js'
].map(rel => ({ rel, code: fs.readFileSync(path.join(ROOT, rel.split('?')[0]), 'utf8') }));

/* The two dev-only files that install the fake session and the fake
   Supabase. Kept apart from SCRIPTS because the PostgREST replay must
   load the dashboard WITHOUT them — a mock that answers for the real
   API is the very thing being tested. */
const MOCK_SCRIPTS = ['dev/admin-mock-data.js', 'dev/admin-mock.js']
  .map(rel => ({ rel, code: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));

/* ---------------- DOM shim ---------------- */

/* The style object RECORDS what a drag paints. It used to stub
   setProperty to a no-op and offer no removeProperty at all, and those
   two facts together made a completed gesture untestable: every surface
   calls removeProperty when the finger lifts, so the shim would throw a
   TypeError at the exact moment a throw ended, and the values painted
   during the drag — the only evidence that 1:1 tracking happened — were
   thrown away. `_props` and getPropertyValue are how a check reads them
   back. */
function makeStyle() {
  const props = new Map();
  return new Proxy({ _props: props }, {
    get(t, k) {
      if (k === 'setProperty') return (name, v) => { props.set(String(name), String(v)); };
      if (k === 'removeProperty') return name => { props.delete(String(name)); return ''; };
      if (k === 'getPropertyValue') return name => (props.has(String(name)) ? props.get(String(name)) : '');
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach(c => set.add(c)),
    remove: (...cs) => cs.forEach(c => set.delete(c)),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains: c => set.has(c)
  };
}

/* ---- element geometry: each surface is measured, so each surface has a
   box -----------------------------------------------------------------

   Every release policy here is decided against the measured size of what
   is being dragged: the drawer asks for its own WIDTH (mobile CSS lays it
   out as `width: min(82vw, 288px)`), the sheets and lightboxes ask for
   their target's HEIGHT. The shim used to answer 375x812 for every element
   on the page, so one geometry was all any threshold could ever be tested
   against — and the drawer width it did report (a full-viewport 375) is one
   the stylesheet cannot produce. So a harness states the box a real layout
   would give: per element with setBox(), per viewport through
   makeSandbox(role, { viewport }). */

const DEFAULT_VIEWPORT = { width: 375, height: 812 };

function boxOf(t) {
  if (!t._box) t._box = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
  return t._box;
}

/* a fresh object per call, so a caller that mutates the rect it is handed
   cannot move the model underneath it */
function rectOf(t) {
  const b = boxOf(t);
  return { width: b.width, height: b.height, top: 0, left: 0, right: b.width, bottom: b.height };
}

function setBox(el, width, height) {
  const b = boxOf(el);
  if (width !== undefined && width !== null) b.width = width;
  if (height !== undefined && height !== null) b.height = height;
  return el;
}

let elCount = 0;
function makeEl(tag) {
  const target = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    listeners: {},
    dataset: {},
    attrs: {},
    value: '',
    textContent: '',
    _innerHTML: '',
    offsetParent: null,
    parentElement: null,
    style: makeStyle(),
    id: ''
  };
  const el = new Proxy(target, {
    get(t, k) {
      if (k === 'textContent') {
        if (t.textContent !== '' && t.textContent !== undefined) return t.textContent;
        return String(t._innerHTML || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (k in t) return t[k];
      switch (k) {
        case 'classList': return t._cl || (t._cl = makeClassList(t));
        case 'innerHTML': return t._innerHTML;
        case 'firstChild': return t.children[0] || null;
        case 'appendChild': return c => { t.children.push(c); if (c && typeof c === 'object') c.parentElement = el; return c; };
        case 'removeChild': return c => { const i = t.children.indexOf(c); if (i > -1) t.children.splice(i, 1); return c; };
        case 'remove': return () => {};
        case 'addEventListener': return (type, fn) => { (t.listeners[type] = t.listeners[type] || []).push(fn); };
        case 'removeEventListener': return (type, fn) => { if (t.listeners[type]) t.listeners[type] = t.listeners[type].filter(f => f !== fn); };
        case 'dispatch': return type => { (t.listeners[type] || []).slice().forEach(fn => fn.call(el, { type, target: el, preventDefault: () => {}, key: '' })); };
        case 'click': return () => { (t.listeners.click || []).slice().forEach(fn => fn.call(el, { type: 'click', target: el, preventDefault: () => {} })); };
        case 'closest': return () => null;
        case 'querySelector': return () => null;
        case 'querySelectorAll': return () => [];
        case 'setAttribute': return (n, v) => { t.attrs[n] = v; };
        case 'getAttribute': return n => (n in t.attrs ? t.attrs[n] : null);
        case 'removeAttribute': return n => { delete t.attrs[n]; };
        /* Gestures measure what they are dragging: the drawer asks for
           its own width to decide where a release lands, and the sheets
           and lightboxes ask for their height. Without this the drawer's
           onBegin threw on a missing method. */
        case 'getBoundingClientRect': return () => rectOf(t);
        case 'offsetWidth': return boxOf(t).width;
        case 'offsetHeight': return boxOf(t).height;
        case 'focus': case 'blur': case 'scrollIntoView': return () => {};
        case 'animate': return () => ({ onfinish: null, oncancel: null });
        case 'reset': return () => {};
        default: return undefined;
      }
    },
    set(t, k, v) { if (k === 'innerHTML') { t._innerHTML = v; return true; } t[k] = v; return true; }
  });
  elCount++;
  return el;
}

function makeSandbox(role, opts) {
  opts = opts || {};

  /* Geometry is an input, not a page-wide constant. The drawer's release
     threshold is half of what it measures, and what it measures is
     `min(82vw, 288px)` — so testing that policy at the widths real phones
     produce means saying which phone this is. 375x812 by default, which is
     what every check written before this one assumed. */
  const viewport = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
  if (opts.viewport) {
    if (opts.viewport.width) viewport.width = opts.viewport.width;
    if (opts.viewport.height) viewport.height = opts.viewport.height;
  }
  const drawerWidth = opts.drawerWidth !== undefined
    ? opts.drawerWidth
    : Math.min(viewport.width * 0.82, 288);

  /* a bare element at the viewport's own size — the full width of the page
     it lives in */
  const sized = tag => setBox(makeEl(tag), viewport.width, viewport.height);

  const registry = {};
  const docListeners = {};
  const winListeners = {};
  const storage = new Map();
  const consoleErrors = [];

  const loc = {
    href: 'http://localhost:8123/admin.html?mock=1',
    origin: 'http://localhost:8123',
    pathname: '/admin.html',
    search: opts.search !== undefined ? opts.search : '?mock=1',
    hostname: 'localhost',
    _hash: '#/overview',
    reload: () => {}
  };
  Object.defineProperty(loc, 'hash', {
    get() { return loc._hash; },
    set(v) {
      loc._hash = v;
      (winListeners.hashchange || []).forEach(fn => fn({ type: 'hashchange' }));
    }
  });

  /* section shim: admin.js scopes table lookups via
     document.querySelector('.section-view[data-section=…]').querySelector('#tableHead')
     so the shim mirrors that scoping onto the shared registry elements. */
  function sectionEl() {
    const sec = sized('section');
    sec.querySelector = sel => {
      if (sel === '#tableHead' || sel === '#tableBody' || sel === '#tableCards') {
        return document.getElementById(sel.slice(1));
      }
      if (sel === '#editLeafletMap' || sel === '#editMapLayerSwitcher' || sel === '#editMapCoordsText' ||
          sel === '#editBtnLocateMe' || sel === '#editMapStatus' || sel === '#editPassageMount') {
        return document.getElementById(sel.slice(1));
      }
      return null;
    };
    return sec;
  }

  const document = {
    title: 'Arzuz Admin',
    body: sized('body'),
    head: sized('head'),
    documentElement: sized('html'),
    activeElement: null,
    getElementById(id) {
      if (!registry[id]) {
        const el = sized('div');
        el.parentElement = document.body;
        registry[id] = el;
      }
      return registry[id];
    },
    /* Two elements the mobile drawer's gesture cannot exist without:
       initSidebar returns early unless `.admin-side` resolves, so with
       every selector answering null the whole drag path was never
       wired in here and could not be tested at all. These two are
       answered and everything else stays null — including the
       ".modal-overlay.open, .lightbox.open" guard, which is what keeps
       "is a modal up?" honest when nothing is open. */
    querySelector(sel) {
      if (typeof sel === 'string' && sel.indexOf('.section-view') === 0) return sectionEl();
      if (sel === '.admin-side') return (registry.__adminSide || (registry.__adminSide = setBox(makeEl('aside'), drawerWidth, viewport.height)));
      if (sel === '.side-scrim') return (registry.__sideScrim || (registry.__sideScrim = sized('div')));
      return null;
    },
    querySelectorAll() { return []; },
    createElement(t) {
      const el = sized(t);
      if (String(t).toLowerCase() === 'a') anchors.push(el);
      return el;
    },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener() {}
  };

  const session = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };

  const fetchCalls = [];
  /* Printing is a browser action the shim cannot perform, so it is
     recorded instead: the dossier's print contract (the class admin.css
     keys on, the provenance line) is only observable if the call
     happens. Without this stub the click would throw. */
  const printCalls = [];
  const blobs = [];       /* every Blob built, so exports can be read back */
  const anchors = [];     /* every <a> created, so a download's filename is visible */
  const sandboxFetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    fetchCalls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
    /* real handler chain lives in admin-mock.js — this placeholder is
       overwritten the moment dev/admin-mock.js loads */
    return Promise.resolve(new Response('[]', { status: 200 }));
  };

  const win = {
    console: {
      log: () => {}, warn: (...a) => { consoleErrors.push('warn: ' + a.join(' ')); },
      error: (...a) => { consoleErrors.push('error: ' + a.join(' ')); }
    },
    location: loc,
    navigator: { userAgent: 'node-shim', clipboard: { writeText: () => Promise.resolve() } },
    sessionStorage: session,
    localStorage: session,
    matchMedia: () => ({ matches: false }),
    /* a phone viewport, so the mobile paths are the ones taken and the
       drawer's fallback width (min(82vw, 288)) is a real number rather
       than NaN */
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 16),
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: opts.fetch || sandboxFetch,
    URLSearchParams,
    Response,
    /* Recorded, not discarded: the dossier export is only really tested
       if the test can read the bytes that were handed to the download. */
    Blob: class { constructor(parts, opts) { this.parts = parts; this.opts = opts || {}; blobs.push(this); } },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    document,
    alert: () => {}, confirm: () => true, prompt: () => 'x',
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    open: () => ({}),
    print: () => { printCalls.push(Date.now()); },
    ARZUZ_CONFIG: null
  };
  win.window = win;
  win.crypto = { randomUUID: () => 'u' + (++elCount) + '-4a1a-9d01-000000000000' };

  /* Leaflet stub: ArzuzMap.pinCapture guards on window.L, and the
     edit-modal flow calls L.map() immediately. Enough surface to
     exercise pin state without a real map. */
  const fakeLayer = { addTo: function () { return this; }, on: function () { return this; }, off: function () { return this; }, once: function () { return this; }, setLatLng: function () { return this; }, getLatLng: function () { return { lat: 9.19, lng: 4.66 }; }, bindPopup: function () { return this; }, unbindPopup: function () { return this; }, openPopup: function () { return this; }, closePopup: function () { return this; }, bindTooltip: function () { return this; }, unbindTooltip: function () { return this; }, setStyle: function () { return this; }, remove: function () {}, setIcon: function () { return this; }, setZIndexOffset: function () { return this; } };
  win.L = {
    map: function () {
      return {
        setView: function () { return this; }, on: function () { return this; },
        remove: function () {}, invalidateSize: function () {}, hasLayer: function () { return false; },
        addLayer: function (x) { return x; }, removeLayer: function () {}, eachLayer: function () {}
      };
    },
    tileLayer: () => Object.assign({}, fakeLayer, { addTo: function () { return this; } }),
    marker: () => Object.assign({}, fakeLayer),
    circleMarker: () => Object.assign({}, fakeLayer),
    polyline: () => Object.assign({}, fakeLayer),
    layerGroup: () => Object.assign({}, fakeLayer),
    divIcon: () => ({}), icon: () => ({}),
    Icon: { Default: Object.assign(function () {}, { prototype: { _getIconUrl: () => '' } }) },
    DomUtil: { create: () => makeEl('div') },
    DomEvent: { disableClickPropagation: () => {}, disableScrollPropagation: () => {} }
  };

  const ctx = vm.createContext(win);
  return { ctx, win, document, registry, docListeners, winListeners, fetchCalls, printCalls, blobs, anchors, consoleErrors, loc };
}

function runScripts(ctx, scripts) {
  for (const s of scripts) {
    vm.runInContext(s.code, ctx, { filename: s.rel });
  }
}

const tick = ms => new Promise(r => setTimeout(r, ms || 60));

/* The list the boot harness runs: the dashboard with the dev mock
   inserted BEFORE admin.js, which is not decoration — the mock seeds
   the fake session and wraps window.fetch, and admin.js reads both on
   the way up. Appended after it, the dashboard boots signed out and
   every metric reads zero (which is exactly what the boot suite says
   when this order is wrong). */
const MOCK_AT = SCRIPTS.map(rel => rel.rel).indexOf('assets/admin.js');
const DASHBOARD_SCRIPTS = SCRIPTS.slice(0, MOCK_AT).concat(MOCK_SCRIPTS, SCRIPTS.slice(MOCK_AT));

module.exports = {
  ROOT: ROOT,
  /* how a harness gives an element the box real layout would give it */
  setBox: setBox,
  SCRIPTS: SCRIPTS,
  MOCK_SCRIPTS: MOCK_SCRIPTS,
  DASHBOARD_SCRIPTS: DASHBOARD_SCRIPTS,
  makeSandbox: makeSandbox,
  runScripts: runScripts,
  tick: tick
};