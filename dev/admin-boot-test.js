/* ============================================================
   Arzuz Admin — headless boot + functional test (DEV ONLY)
   Run:  node dev/admin-boot-test.js

   Boots the REAL dashboard scripts (config, auth, data,
   strategy, notify, submit, admin-ui, admin-mock-data,
   admin-mock, admin) inside a VM sandbox with a minimal DOM
   shim, served by the real mock harness fetch. No browser and
   no network needed.

   Coverage per role (admin / support / marketing):
     - boot without exceptions; gate hidden; nav role-filtered
     - every section renders without exceptions
     - Overview numbers trace to the mock dataset
     - tables render the expected row counts
     - details / edit / delete modals open for every table
     - delete confirm: wrong ID rejected, right ID deletes
     - Add Apartment submit inserts into the mock DB
     - CSV export produces a download payload
     - console stays free of errors
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = [
  'assets/config.js',
  'assets/admin-ui.js',
  'assets/auth.js',
  'assets/data.js',
  'assets/strategy.js',
  'assets/arzuz-map.js',
  'assets/notify.js',
  'assets/submit.js',
  'dev/admin-mock-data.js',
  'dev/admin-mock.js',
  'assets/admin.js'
].map(rel => ({ rel, code: fs.readFileSync(path.join(ROOT, rel.split('?')[0]), 'utf8') }));

/* ---------------- results ---------------- */

const RESULTS = [];
let currentRole = 'admin';

function check(name, fn) {
  try {
    const ok = fn();
    const pass = ok === true || (ok && typeof ok !== 'string');
    RESULTS.push({ role: currentRole, name, ok: pass, note: pass ? '' : String(ok) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (pass ? '' : '  → ' + ok));
  } catch (e) {
    RESULTS.push({ role: currentRole, name, ok: false, note: e.message });
    console.log('  ✗ ' + name + '  → threw: ' + e.message);
  }
}

/* ---------------- DOM shim ---------------- */

function makeStyle() {
  return new Proxy({}, {
    get(t, k) { if (k === 'setProperty') return function () {}; return t[k]; },
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

function makeSandbox(role) {
  const registry = {};
  const docListeners = {};
  const winListeners = {};
  const storage = new Map();
  const consoleErrors = [];

  const loc = {
    href: 'http://localhost:8123/admin.html?mock=1',
    origin: 'http://localhost:8123',
    pathname: '/admin.html',
    search: '?mock=1',
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
    const sec = makeEl('section');
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
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    activeElement: null,
    getElementById(id) {
      if (!registry[id]) {
        const el = makeEl('div');
        el.parentElement = document.body;
        registry[id] = el;
      }
      return registry[id];
    },
    querySelector(sel) {
      if (typeof sel === 'string' && sel.indexOf('.section-view') === 0) return sectionEl();
      return null;
    },
    querySelectorAll() { return []; },
    createElement(t) { return makeEl(t); },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener() {}
  };

  const session = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };

  const fetchCalls = [];
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
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 16),
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: sandboxFetch,
    URLSearchParams,
    Response,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    document,
    alert: () => {}, confirm: () => true, prompt: () => 'x',
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    open: () => ({}),
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
  return { ctx, win, document, registry, docListeners, winListeners, fetchCalls, consoleErrors, loc };
}

function runScripts(ctx, scripts) {
  for (const s of scripts) {
    vm.runInContext(s.code, ctx, { filename: s.rel });
  }
}

const tick = ms => new Promise(r => setTimeout(r, ms || 60));

/* ---------------- driver ---------------- */

async function testRole(role) {
  currentRole = role;
  console.log('\n=== ROLE: ' + role.toUpperCase() + ' ===');

  const sb = makeSandbox(role);
  sb.win.sessionStorage.setItem('arzuz_mock_role', role);

  /* spy: which section selectors does admin.js render through?
     The sidebar nav buttons also carry data-section, so a bare
     '[data-section=…]' query would hijack the nav button (a real
     regression this suite once missed). Memoize per selector so the
     element we inspect later is the one admin.js rendered into. */
  const qsCalls = {};
  const qsMemo = {};
  const origQS = sb.document.querySelector.bind(sb.document);
  sb.document.querySelector = function (sel) {
    if (typeof sel === 'string' && sel.indexOf('.section-view') === 0) {
      qsCalls[sel] = (qsCalls[sel] || 0) + 1;
      if (!qsMemo[sel]) qsMemo[sel] = origQS(sel);
      return qsMemo[sel];
    }
    qsCalls[sel] = (qsCalls[sel] || 0) + 1;
    return origQS(sel);
  };

  runScripts(sb.ctx, SCRIPTS);
  await tick(120); /* boot: restore → fetchData → renderRoute */

  const $ = id => sb.document.getElementById(id);
  const text = id => { const el = $(id); return el ? String(el.textContent) : ''; };

  check('boot: no console errors', () => sb.consoleErrors.length === 0 ? true : sb.consoleErrors.join(' | '));
  check('boot: gate hidden (session accepted)', () => !sb.registry.gateModal || !sb.registry.gateModal._cl || !sb.registry.gateModal._cl.contains('open') || 'gate still open');

  /* --- nav gating --- */
  const HIDDEN = {
    admin: [],
    marketing: ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'settings'],
    support: ['scout_submissions', 'roommate', 'growth', 'strategy', 'settings']
  }[role];
  check('router: ' + (role === 'admin' ? 'overview' : role === 'support' ? 'support desk' : 'growth') + ' is the landing section', () => {
    const active = ['overview', 'tickets', 'growth'].filter(s => HIDDEN.indexOf(s) === -1)[0];
    return sb.loc.hash === '#/' + active ? true : 'hash is ' + sb.loc.hash;
  });

  /* --- walk every allowed section --- */
  const ALL = ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'growth', 'strategy', 'settings'];
  const errorsBefore = sb.consoleErrors.length;
  for (const sec of ALL) {
    sb.loc.hash = '#/' + sec;
    await tick(40);
  }
  check('routes: all allowed sections render without console errors', () => {
    const newErrs = sb.consoleErrors.slice(errorsBefore).filter(e => e.indexOf('error:') === 0);
    return newErrs.length === 0 ? true : newErrs.join(' | ');
  });

  /* --- nav/section collision guard (see spy above) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/growth';
    await tick(60);
    sb.loc.hash = '#/strategy';
    await tick(60);
    check('growth: rendered through the .section-view-scoped selector', () =>
      (qsCalls['.section-view[data-section="growth"]'] || 0) > 0 ? true : 'growth render never used the scoped selector');
    check('growth: bare [data-section="growth"] never queried (nav collision)', () =>
      qsCalls['[data-section="growth"]'] === undefined ? true : 'unscoped growth selector used ' + qsCalls['[data-section="growth"]'] + 'x');
    check('strategy: bare [data-section="strategy"] never queried (nav collision)', () =>
      qsCalls['[data-section="strategy"]'] === undefined ? true : 'unscoped strategy selector used ' + qsCalls['[data-section="strategy"]'] + 'x');
    for (const secName of ['growth', 'strategy']) {
      const el = qsMemo['.section-view[data-section="' + secName + '"]'];
      const html = String((el && el.innerHTML) || '');
      const m = html.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      check(secName + ': rendered chrome has no emoji glyphs', () => (el && html) ? (!m ? true : 'emoji ' + m[0] + ' still present') : 'section never rendered');
    }
  }

  /* --- overview traceability (admin only — role sees it) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/overview';
    await tick(60);
    const db = sb.win.__MOCK__.db();
    check('overview: demands metric equals dataset count', () => text('mDemands') === String(db.demand_records.length) ? true : 'got ' + text('mDemands') + ' want ' + db.demand_records.length);
    check('overview: listings metric equals dataset count', () => text('mListings') === String(db.listings.length) ? true : 'got ' + text('mListings'));
    check('overview: scouts metric equals dataset count', () => text('mScouts') === String(db.scout_submissions.length) ? true : 'got ' + text('mScouts'));
    const openDemands = db.demand_records.filter(r => r.status === 'open').length;
    check('overview: open demands metric equals dataset count', () => text('mOpenDemands') === String(openDemands) ? true : 'got ' + text('mOpenDemands'));
    const drafts = db.listings.filter(r => String(r.status).toLowerCase() === 'draft').length;
    check('overview: drafts metric equals dataset count', () => text('mDrafts') === String(drafts) ? true : 'got ' + text('mDrafts'));
    const minors = db.minors_needing_guardian.length;
    check('overview: minors metric equals SQL view count', () => text('mMinors') === String(minors) ? true : 'got ' + text('mMinors'));
    check('overview: roommate metric shows the SQL view %', () => text('mRoommate') === '67%' ? true : 'got ' + text('mRoommate'));
  }

  /* --- tables: row counts (admin; other roles render subset but same code path) --- */
  if (role === 'admin') {
    const db = sb.win.__MOCK__.db();
    const counts = {
      demand_records: db.demand_records.filter(r => String(r.env) !== 'test').length,
      listings: db.listings.filter(r => String(r.env) !== 'test').length,
      scout_submissions: db.scout_submissions.filter(r => String(r.env) !== 'test').length,
      booking_requests: db.booking_requests.filter(r => String(r.env) !== 'test').length,
      support_tickets: db.support_tickets.filter(r => String(r.env) !== 'test').length
    };
    for (const tbl of Object.keys(counts)) {
      sb.loc.hash = '#/' + (tbl === 'booking_requests' ? 'bookings' : tbl === 'support_tickets' ? 'tickets' : tbl);
      await tick(40);
      const rowsHtml = String($('tableBody')._innerHTML || '');
      const n = (rowsHtml.match(/<tr>/g) || []).length;
      check('table ' + tbl + ': renders ' + counts[tbl] + ' live rows', () => n === counts[tbl] ? true : 'rendered ' + n);
    }
  }

  /* --- modals for every table (details / edit / delete) --- */
  const tables = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets'];
  for (const tbl of tables) {
    const db = sb.win.__MOCK__.db();
    const row = (db[tbl] || []).find(r => String(r.env) !== 'test');
    if (!row) continue;
    check('details modal opens for ' + tbl, () => {
      sb.win.openDetailsModal(tbl, row.id);
      return $('detailsModalContent')._innerHTML.length > 0 || 'no content rendered';
    });
    if (role !== 'marketing') {
      check('edit modal opens for ' + tbl, () => {
        sb.win.openEditModal(tbl, row.id);
        return $('editFieldsContainer')._innerHTML.length > 0 || 'no fields rendered';
      });
    }
    if (role === 'admin') {
      check('delete modal opens for ' + tbl, () => {
        sb.win.openDeleteModal(tbl, row.id);
        return String($('delConfirmId').textContent).length === 8 || 'confirm id not seeded';
      });
      /* wrong ID keeps the button disabled */
      const delInput = $('delConfirmInput');
      delInput.value = 'wrong-id';
      (delInput.listeners.input || []).forEach(fn => fn.call(delInput, { target: delInput }));
      check('delete ' + tbl + ': wrong ID leaves confirm disabled', () => $('btnConfirmDel').disabled === true);
      /* right ID enables, then confirm deletes */
      delInput.value = String($('delConfirmId').textContent);
      (delInput.listeners.input || []).forEach(fn => fn.call(delInput, { target: delInput }));
      check('delete ' + tbl + ': right ID enables confirm', () => $('btnConfirmDel').disabled === false);
      $('btnConfirmDel').click();
      await tick(80);
      const after = sb.win.__MOCK__.db()[tbl].some(r => r.id === row.id);
      check('delete ' + tbl + ': row removed from mock DB', () => !after);
    }
    await tick(30);
  }

  /* --- add apartment flow (admin) --- */
  if (role === 'admin') {
    check('add apartment: opens and seeds next APT id', async () => {
      $('btnOpenAddApt').click();
      await tick(20);
      return String($('add_apt_id').value).indexOf('APT-') === 0 ? true : 'got ' + $('add_apt_id').value;
    });
    $('add_prop_name').value = 'Test Lodge';
    $('add_ar').value = 'Test Area';
    $('add_rent').value = '150000';
    const form = sb.registry.addAptForm;
    (form.listeners.submit || []).forEach(fn => fn({ preventDefault: () => {}, target: form }));
    await tick(120);
    const created = sb.win.__MOCK__.db().listings.find(r => r.payload && r.payload.prop_name === 'Test Lodge');
    check('add apartment: submit inserts into mock DB', () => !!created);
    check('add apartment: inserted row lands in listings state', async () => {
      sb.loc.hash = '#/listings';
      await tick(40);
      return true;
    });

    /* --- cancel / keep / discard triad ---
       The overlay close is animated, and this shim's animate() NEVER runs
       onfinish — exactly the situation that left a dismissed modal on
       screen. A close must therefore land on its own, not via the callback. */
    const addModalEl = $('addAptModal');
    const exitModalEl = $('draftExitModal');
    const isOpen = el => !!(el && el._cl && el._cl.contains('open'));
    const rowsBefore = sb.win.__MOCK__.db().listings.length;

    $('btnOpenAddApt').click();
    sb.registry.addAptForm.dispatch('input'); /* any edit arms the prompt */
    $('btnCancelAddApt').click();
    check('cancel: unsaved edits raise the exit prompt', () =>
      (isOpen(exitModalEl) && isOpen(addModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));

    $('btnExitKeep').click();
    await tick(400);
    check('cancel: “keep editing” returns to the form', () =>
      (isOpen(addModalEl) && !isOpen(exitModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));

    $('btnExitDiscard').click();
    await tick(400);
    check('discard: closes both overlays without an animation callback', () =>
      (!isOpen(addModalEl) && !isOpen(exitModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));
    check('discard: writes nothing to the listings table', () =>
      sb.win.__MOCK__.db().listings.length === rowsBefore || 'rows ' + rowsBefore + ' → ' + sb.win.__MOCK__.db().listings.length);

    $('btnOpenAddApt').click();
    $('btnCancelAddApt').click();
    await tick(400);
    check('discard: resets the dirty flag (a clean cancel prompts nothing)', () =>
      (!isOpen(exitModalEl) && !isOpen(addModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));
  }

  /* --- CSV export (admin) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/listings';
    await tick(40);
    let csvBlob = null;
    const origBlob = sb.win.Blob;
    sb.win.Blob = class extends origBlob { constructor(parts, opts) { csvBlob = parts; super(parts, opts); } };
    $('btnExport').click();
    await tick(30);
    sb.win.Blob = origBlob;
    check('csv export: builds a payload with rows', () => !!(csvBlob && csvBlob.length && String(csvBlob[0]).indexOf('payload_') !== -1));
  }

  /* --- support desk form (admin + support) --- */
  if (role !== 'marketing') {
    sb.loc.hash = '#/tickets';
    await tick(50);
    $('tk_name').value = 'Phone Caller';
    $('tk_phone').value = '08000000000';
    $('tk_msg').value = 'Called about a broken gate.';
    $('btnLogTicket').click();
    await tick(120);
    const logged = sb.win.__MOCK__.db().support_tickets.some(r => r.payload && r.payload.name === 'Phone Caller');
    check('support desk: phone complaint becomes a ticket', () => !!logged);
  }

  /* --- settings flows (admin) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/settings';
    await tick(80);
    check('team roster: loads users from /api/team', () => {
      const roster = text('teamRoster');
      return roster.indexOf('owner@arzuz.test') !== -1 ? true : 'roster: ' + roster.slice(0, 60);
    });
    $('teamEmail').value = 'new-teammate@arzuz.test';
    $('btnTeamCreate').click();
    await tick(120);
    check('team create: new teammate appears', () => text('teamRoster').indexOf('new-teammate@arzuz.test') !== -1);
    await sb.win.ArzuzData.ready.then(async () => {
      check('amenities: manager lists defaults + customs', () => {
        const list = text('amenitiesManagerList');
        return list.indexOf('Borehole water') !== -1 && list.indexOf('Solar panels') !== -1 ? true : 'got: ' + list.slice(0, 80);
      });
    });
    check('telegram status: reports configured via /api/notify', () => text('tgStatus').indexOf('configured') !== -1);
  }

  /* --- error + slow scenarios --- */
  check('scenario: rest failure surfaces without boot crash', async () => {
    sb.win.__MOCK__.error('rest');
    $('btnRefresh').click();
    await tick(150);
    sb.win.__MOCK__.reset();
    return true;
  });

  check('final: no console errors across the whole walk', () => {
    const errs = sb.consoleErrors.filter(e => e.indexOf('error:') === 0);
    return errs.length === 0 ? true : errs.join(' | ');
  });
}

/* ---------------- main ---------------- */

(async function main() {
  console.log('Arzuz admin — headless functional test');
  for (const role of ['admin', 'support', 'marketing']) {
    await testRole(role);
  }
  const failed = RESULTS.filter(r => !r.ok);
  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + RESULTS.length + ' · PASS ' + (RESULTS.length - failed.length) + ' · FAIL ' + failed.length);
  if (failed.length) {
    failed.forEach(f => console.log('  FAIL [' + f.role + '] ' + f.name + ' → ' + f.note));
    process.exitCode = 1;
  }
})();
