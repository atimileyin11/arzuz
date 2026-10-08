/* ============================================================
   Arzuz Admin — private dashboard logic
   Plain ES5, no build step. Loaded by admin.html after
   config.js, auth.js, data.js, notify.js and submit.js.

   Sections:
   0.  Helpers
   1.  Auth gate (Supabase Auth — no passcode in the page)
   2.  Hash router (Overview / Demands / Listings / Scouts / Settings)
   3.  Data fetch + shared state
   4.  Overview (metrics + daily ops)
   5.  Table renderers (demand / listings / scouts)
   6.  Edit modal (all three tables, incl. opening ask + tier)
   7.  Add Apartment (mirrors the public landlord form)
   8.  Media upload (Cloudinary signed) + lightboxes
   9.  Map pin (Add Apartment)
   10. Details modal
   11. Delete confirmation (shows the row, requires the ID)
   12. CSV export
   13. Amenities manager + Telegram settings
   ============================================================ */

(function () {
  'use strict';

  /* ================= 0. Helpers ================= */

  var cfg = window.ARZUZ_CONFIG || {};
  var TABLES = ['demand_records', 'listings', 'scout_submissions', 'booking_requests'];
  var TICKETS_TABLE = 'support_tickets';   // fetched separately, see fetchData

  var state = {
    currentSection: 'overview',
    data: { demand_records: [], listings: [], scout_submissions: [], booking_requests: [], support_tickets: [] },
    minors: [],                      // rows of minors_needing_guardian view
    roommateSummary: null,           // row of roommate_match_summary view
    roommateFor: null,               // demand id whose candidates are open
    pendingDelete: null,
    detail: null,
    search: '',
    statusFilter: 'all',
    needsAskOnly: false,
    showTestRows: false,
    shareSchemaMissing: false   // true when supabase-draft-sharing.sql has not been run yet
  };

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function $(id) { return document.getElementById(id); }
  function apiRoot() { return (cfg.SUPABASE_URL || '').replace(/\/+$/, ''); }
  function show(el) {
    if (!el) return;
    el.classList.add('open');
    if (window.ArzuzUI) {
      ArzuzUI.popIn(el.querySelector('.modal-box, .gate-card, .lb-frame') || el);
      ArzuzUI.trapFocus(el);
    }
  }
  function hide(el) {
    if (!el) return;
    if (window.ArzuzUI) { ArzuzUI.releaseFocus(); ArzuzUI.closeModal(el); }
    else el.classList.remove('open');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function shortId(id) { return id ? String(id).substring(0, 8) : ''; }

  function ngn(n) { return '₦' + Number(n || 0).toLocaleString('en-NG'); }

  function payloadOf(row) { return (row && row.payload) || {}; }

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }

  /* First truthy value among a row column and its legacy payload keys. */
  function pick(row, col, payloadKeys) {
    if (row && row[col] !== undefined && row[col] !== null && row[col] !== '') return row[col];
    var p = payloadOf(row);
    for (var i = 0; i < payloadKeys.length; i++) {
      if (p[payloadKeys[i]] !== undefined && p[payloadKeys[i]] !== null && p[payloadKeys[i]] !== '') return p[payloadKeys[i]];
    }
    return '';
  }

  function waLink(phone) {
    var digits = str(phone).replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.charAt(0) === '0') digits = '234' + digits.slice(1);
    return 'https://wa.me/' + digits;
  }

  function isTestRow(row) { return str(row.env) === 'test'; }

  function ageHours(iso) {
    var d = new Date(iso);
    return isFinite(d) ? (Date.now() - d.getTime()) / 36e5 : 0;
  }
  function ageLabel(iso) {
    var h = ageHours(iso);
    if (!h) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
    if (h < 48) return Math.round(h) + 'h';
    return Math.floor(h / 24) + 'd';
  }

  /* draft invite tokens are generated in the browser (crypto.randomUUID
     where available) and stored in listings.draft_token */
  function newToken() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  function findRow(table, id) { return (state.data[table] || []).find(function (r) { return r.id === id; }); }

  /* invite state shown next to the status tag on draft rows */
  function draftBadgeHtml(r) {
    if (str(r.status).toLowerCase() !== 'draft') return '';
    if (!r.draft_token) return '<span class="draft-badge sent">' + ico('pencil', 12) + ' draft · link revoked</span>';
    if (draftExpired(r)) return '<span class="draft-badge sent">' + ico('alert', 12) + ' link expired</span>';
    return r.draft_completed_at
      ? '<span class="draft-badge done">' + ico('check', 12) + ' completed — awaiting approval</span>'
      : '<span class="draft-badge sent">' + ico('link', 12) +
        (draftPermission(r) === 'view' ? ' view link sent' : ' edit link sent') + '</span>';
  }

  /* the Bookings / Support Desk SECTIONS map to different TABLES */
  function sectionTable(sec) {
    if (sec === 'bookings') return 'booking_requests';
    if (sec === 'tickets') return 'support_tickets';
    return sec;
  }

  function toList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim()) return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return [];
  }

  function utilitiesList() {
    return (typeof UTILITIES !== 'undefined' && UTILITIES.length) ? UTILITIES :
      (typeof _DEFAULT_UTILITIES !== 'undefined' ? _DEFAULT_UTILITIES.slice() : []);
  }

  /* Status → tag html */
  function statusTag(status) {
    var s = str(status || 'pending').toLowerCase();
    return '<span class="tag-status tag-' + esc(s) + '">' + esc(s) + '</span>';
  }

  function amenitiesTags(list, max) {
    var arr = toList(list);
    if (!arr.length) return '<span class="muted-cell">—</span>';
    var out = arr.slice(0, max).map(function (u) { return '<span class="table-amenity-tag">' + esc(u) + '</span>'; }).join('');
    if (arr.length > max) out += '<span class="table-amenity-tag" style="opacity:.7">+' + (arr.length - max) + '</span>';
    return out;
  }

  /* photo/tour counts under the listings thumbnail */
  function mediaCountHtml(p) {
    var nI = 0, nV = 0;
    if (Array.isArray(p.media)) p.media.forEach(function (m) { if (m && m.url) { if (m.type === 'video') nV++; else nI++; } });
    if (!nI && !nV) return '';
    return '<div class="media-count-cell">' + nI + ' photo' + (nI === 1 ? '' : 's') + (nV ? ' · ' + nV + ' tour' : '') + '</div>';
  }

  function mapLink(row) {
    var p = payloadOf(row);
    var lat = row.latitude || p.lat, lng = row.longitude || p.lng;
    if (!lat || !lng) return '<span class="muted-cell">No pin</span>';
    return '<a class="act-btn act-map" href="https://www.google.com/maps?q=' + encodeURIComponent(lat + ',' + lng) +
      '" target="_blank" rel="noopener">' + ico('pin', 13) + ' Map</a>';
  }

  /* Buttons inside re-rendered HTML use delegated events (section 5c). */
  function actBtn(kind, table, id, label) {
    return '<button type="button" class="act-btn act-' + kind + '" data-act="' + kind + '" data-table="' + table +
      '" data-id="' + esc(id) + '">' + label + '</button>';
  }

  function setError(elId, msg) {
    var el = $(elId);
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
  }

  /* ================= 1. Auth gate ================= */

  var gateModal = $('gateModal');

  function showGate(msg) {
    gateModal.style.display = 'flex';
    var err = $('gateErr');
    if (msg) { err.textContent = msg; err.style.display = 'block'; }
    else { err.style.display = 'none'; }
  }

  function hideGate() {
    gateModal.style.display = 'none';
    var email = ArzuzAuth.email();
    var role = currentRole();
    var who = $('whoBadge');
    if (who) who.textContent = (email || 'Signed in') + (role === 'marketing' ? ' · marketing' : role === 'support' ? ' · support' : ' · admin');
    var env = $('envBadge');
    env.textContent = (cfg.ENV === 'test' ? 'TEST DB' : 'PRODUCTION DB');
    env.className = 'admin-badge ' + (cfg.ENV === 'test' ? 'warn' : 'ok');
    applyRoleNav();
  }

  function onAuthError(err) {
    ArzuzAuth.clear();
    showGate('Your session has expired. Please sign in again.');
    if (window.console) console.warn('[Arzuz Admin]', err && err.message);
  }

  function checkAuth() {
    ArzuzAuth.restore().then(function (s) {
      if (s) { hideGate(); fetchData(); }
      else showGate();
    }).catch(function () { showGate(); });
  }

  $('btnUnlock').addEventListener('click', function () {
    var email = $('gateEmail').value.trim();
    var pass = $('gatePass').value;
    if (!email || !pass) { showGate('Enter your email and password.'); return; }
    var btn = $('btnUnlock');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    ArzuzAuth.signIn(email, pass)
      .then(function () {
        btn.textContent = 'Sign in';
        btn.disabled = false;
        $('gatePass').value = '';
        hideGate();
        fetchData();
      })
      .catch(function (err) {
        btn.textContent = 'Sign in';
        btn.disabled = false;
        showGate(err.message);
      });
  });

  function gateKey(e) { if (e.key === 'Enter') $('btnUnlock').click(); }
  $('gateEmail').addEventListener('keydown', gateKey);
  $('gatePass').addEventListener('keydown', gateKey);

  $('btnLock').addEventListener('click', function () {
    ArzuzAuth.signOut().then(function () { location.reload(); });
  });

  $('btnRefresh').addEventListener('click', function () {
    if (window.ArzuzUI) ArzuzUI.setBusy(this, true, 'Refreshing…');
    fetchData();
    var btn = this;
    setTimeout(function () { if (window.ArzuzUI) ArzuzUI.setBusy(btn, false); }, 900);
  });

  /* ================= 2. Hash router ================= */

  var SECTIONS = {
    overview: { title: 'Overview', icon: 'grid', label: 'Overview' },
    demand_records: { title: 'Student Demands', icon: 'cap', label: 'Demands' },
    listings: { title: 'Landlord Listings', icon: 'home', label: 'Listings' },
    scout_submissions: { title: 'Building Scouts', icon: 'clipboard', label: 'Scouts' },
    bookings: { title: 'Booking Requests', icon: 'calendar', label: 'Bookings' },
    tickets: { title: 'Support Desk', icon: 'headset', label: 'Support Desk' },
    roommate: { title: 'Roommate Matching', icon: 'users', label: 'Roommates' },
    growth: { title: 'Growth', icon: 'trending', label: 'Growth' },
    strategy: { title: 'Strategy', icon: 'book', label: 'Strategy' },
    settings: { title: 'Settings', icon: 'gear', label: 'Settings' }
  };

  /* small helper: the generated markup uses real icons everywhere */
  function ico(name, size) { return window.ArzuzUI ? ArzuzUI.icon(name, size || 16) : ''; }

  /* Sections hidden per role. The marketing login is prioritised for
     marketing: it lands on Growth and never sees the data tables or
     settings. Admin (the default) sees everything. */
  var ROLE_SECTIONS = {
    admin: null, // no restrictions
    marketing: ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'settings'],
    /* support lands on the Support Desk and works bookings + demands;
       listings are visible but read-only (actions hidden in the
       renderers). No scouts, roommates, growth, strategy or settings. */
    support: ['scout_submissions', 'roommate', 'growth', 'strategy', 'settings']
  };

  function sectionsFor(role) {
    var hidden = ROLE_SECTIONS[role] || [];
    return Object.keys(SECTIONS).filter(function (k) { return hidden.indexOf(k) === -1; });
  }

  function currentRole() {
    return (window.ArzuzAuth && ArzuzAuth.role) ? ArzuzAuth.role() : 'admin';
  }

  /* Split "strategy/<file>.md" sub-routes out of the plain section key. */
  function routeFromHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var sec = h.split('/')[0];
    return SECTIONS[sec] ? sec : 'overview';
  }

  function routeDoc() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/');
    return parts[0] === 'strategy' && parts[1] ? parts.slice(1).join('/') : '';
  }

  function applyRoleNav() {
    var allowed = sectionsFor(currentRole());
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.style.display = (allowed.indexOf(b.dataset.section) !== -1) ? '' : 'none';
    });
  }

  function renderRoute() {
    var sec = routeFromHash();

    /* role gate INSIDE the router: a deep link or stale hash into a
       section this role cannot see falls back to the landing page */
    var allowed = sectionsFor(currentRole());
    if (allowed.indexOf(sec) === -1) {
      var fallback = (currentRole() === 'support' && allowed.indexOf('tickets') !== -1) ? 'tickets'
        : (allowed.indexOf('growth') !== -1) ? 'growth' : allowed[0];
      if (location.hash !== '#/' + fallback) { location.hash = '#/' + fallback; return; }
      sec = fallback;
    }
    state.currentSection = sec;

    document.querySelectorAll('.section-view').forEach(function (v) {
      v.style.display = (v.dataset.section === sec) ? '' : 'none';
    });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.section === sec);
    });
    $('sectionTitle').textContent = SECTIONS[sec].title;

    /* section-enter stagger: the freshly shown section rises in */
    if (window.ArzuzUI) {
      document.querySelectorAll('.section-view').forEach(function (v) {
        v.classList.remove('active-enter');
      });
      var active = document.querySelector('.section-view[data-section="' + sec + '"]');
      if (active) {
        active.classList.add('active-enter');
        var m = 0;
        active.querySelectorAll('[data-motion]').forEach(function (el) {
          el.style.setProperty('--motion-i', m++);
        });
      }
    }

    /* shared table toolbar: visible on the data sections only,
       with listings-specific controls shown just there */
    var isTable = sec === 'demand_records' || sec === 'listings' || sec === 'scout_submissions' || sec === 'bookings' || sec === 'tickets';
    var toolbar = $('dataTableControls');
    if (toolbar) toolbar.style.display = isTable ? '' : 'none';
    if ($('filterAsk')) $('filterAsk').style.display = sec === 'listings' ? '' : 'none';
    if ($('btnOpenAddApt')) $('btnOpenAddApt').style.display = (sec === 'listings' && currentRole() === 'admin') ? '' : 'none';

    if (sec === 'overview') renderOverview();
    if (sec === 'roommate') renderRoommatePanel();
    if (sec === 'tickets') renderSupportDesk();
    if (sec === 'settings') renderTeamRoster();
    if (sec === 'growth' && window.ArzuzStrategy) {
      /* NOTE: scoped to .section-view — the sidebar nav buttons also carry
         data-section, and querySelector returns the first match in DOM order. */
      var growthRoot = document.querySelector('.section-view[data-section="growth"]');
      ArzuzStrategy.renderGrowth(growthRoot, {
        demands: state.data.demand_records,
        listings: state.data.listings,
        scouts: state.data.scout_submissions,
        bookings: state.data.booking_requests,
        roommateSummary: state.roommateSummary
      });
      if (window.ArzuzUI && ArzuzUI.deEmoji) ArzuzUI.deEmoji(growthRoot);
    }
    if (sec === 'strategy' && window.ArzuzStrategy) {
      var strategyRoot = document.querySelector('.section-view[data-section="strategy"]');
      ArzuzStrategy.renderStrategy(strategyRoot, routeDoc());
      if (window.ArzuzUI && ArzuzUI.deEmoji) ArzuzUI.deEmoji(strategyRoot);
      if (window.ArzuzUI && ArzuzUI.armDeEmoji) ArzuzUI.armDeEmoji(strategyRoot);
    }
    if (isTable) {
      state.search = '';
      state.statusFilter = 'all';
      state.needsAskOnly = false;
      var si = $('searchInput'); if (si) si.value = '';
      var sf = $('statusFilter'); if (sf) { sf.value = 'all'; sf.dataset.for = ''; }
      var fa = $('filterAsk'); if (fa) fa.classList.remove('on');
      renderTable();
    }
  }

  window.addEventListener('hashchange', renderRoute);

  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () {
      if (location.hash === '#/' + b.dataset.section) renderRoute();
      else location.hash = '#/' + b.dataset.section;
    });
  });

  /* ================= 2b. Sidebar: collapsible on desktop,
     slide-in drawer on mobile (hamburger, scrim, Escape) ================= */

  (function initSidebar() {
    var body = document.body;
    var btn = $('sideToggle');
    var side = document.querySelector('.admin-side');
    var scrim = $('sideScrim');
    var closeBtn = $('sideClose');
    if (!btn || !side) return;

    var mq = (typeof window.matchMedia === 'function') ? window.matchMedia('(min-width: 861px)') : null;
    function isDesktop() { return mq ? mq.matches : true; }

    var KEY = 'arzuz_admin_side_collapsed';
    var collapsed = false;
    try { collapsed = localStorage.getItem(KEY) === '1'; } catch (e) { /* storage blocked */ }
    if (collapsed && isDesktop()) body.classList.add('side-collapsed');

    function syncBtn() {
      var open = isDesktop() ? !collapsed : (body.classList.contains('side-open') && side.classList.contains('open'));
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function openDrawer() {
      body.classList.add('side-open');
      side.classList.add('open');
      if (scrim) scrim.classList.add('show');
      if (window.ArzuzUI && ArzuzUI.trapFocus) ArzuzUI.trapFocus(side);
      syncBtn();
    }

    function closeDrawer() {
      if (!body.classList.contains('side-open')) return;
      body.classList.remove('side-open');
      side.classList.remove('open');
      if (scrim) scrim.classList.remove('show');
      if (window.ArzuzUI && ArzuzUI.releaseFocus) ArzuzUI.releaseFocus();
      syncBtn();
    }

    btn.addEventListener('click', function () {
      if (isDesktop()) {
        collapsed = !collapsed;
        body.classList.toggle('side-collapsed', collapsed);
        try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) { /* storage blocked */ }
      } else if (body.classList.contains('side-open')) {
        closeDrawer();
      } else {
        openDrawer();
      }
      syncBtn();
    });

    if (scrim) scrim.addEventListener('click', closeDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') closeDrawer();
    });

    /* picking a destination closes the mobile drawer */
    side.addEventListener('click', function (e) {
      var t = (e.target && e.target.closest) ? e.target.closest('.nav-item') : null;
      if (t && !isDesktop()) closeDrawer();
    });

    /* ---------- touch drag: swipe the drawer open from the left
       edge, or grab and throw the open drawer away. 1:1 finger
       tracking, resistance past both resting edges, flick release
       with momentum projection (Apple, "Designing Fluid
       Interfaces"). ES5, no deps: the release snaps to the nearest
       resting state and lets the existing CSS transition carry it. */

    var DOW = 0, DIX = 0, DIY = 0, DRAGGING = false, MOVED = false,
        OPEN0 = false, CUR = 0, VT = [];
    var RATIO = 0.18, OPEN_MIN = 0.5, FLICK = 280, TICK = 90, SLOP = 8;

    function drawerWidth() {
      var r = side.getBoundingClientRect();
      return (r && r.width) ? r.width : Math.min(window.innerWidth * 0.82, 288);
    }

    /* a flick keeps going: v (px/s) decays exponentially */
    function project(v) {
      var rate = 0.998;
      return (v / 1000) * rate / (1 - rate);
    }

    function trackVelocity(x, t) {
      VT.push({ x: x, t: t });
      while (VT.length > 2 && t - VT[0].t > TICK) VT.shift();
    }

    function velocity() {
      if (VT.length < 2) return 0;
      var a = VT[0], b = VT[VT.length - 1], dt = (b.t - a.t) / 1000;
      return dt ? (b.x - a.x) / dt : 0;
    }

    /* paint(raw): raw is where the finger put the drawer (px, 0 =
       fully open, -width = fully shut). Past either resting edge
       the door drags against its hinge — overscroll-style. */
    function paint(raw) {
      CUR = raw;
      var p;
      if (raw > 0) p = raw * RATIO;
      else if (raw < -DOW) p = -DOW + (raw + DOW) * RATIO;
      else p = raw;
      side.style.setProperty('--side-x', p + 'px');
      /* the edge grip rides the drawer's leading edge (see .side-grip) */
      body.style.setProperty('--side-edge', Math.max(0, DOW + p) + 'px');
      if (scrim) scrim.style.opacity = (Math.max(0, Math.min(1, 1 + p / DOW)) * 0.62).toFixed(3);
    }

    function logicalFrom(cur) {
      if (cur > 0) return cur / RATIO;
      if (cur < -DOW) return -DOW + (cur + DOW) / RATIO;
      return cur;
    }

    /* flick or far-enough drag: where does the drawer land? */
    function decide(v) {
      var logical = logicalFrom(CUR);
      var proj = logical + Math.max(-1.2 * DOW, Math.min(0.4 * DOW, project(v)));
      if (Math.abs(v) > FLICK) return v > 0;
      return proj >= -DOW * OPEN_MIN;
    }

    function hasTouch(e) {
      return !!(e.pointerType === 'touch' || e.pointerType === 'pen');
    }

    /* a horizontal drag that ends inside the drawer must not fire
       the button it landed on */
    function sealClicks() {
      var catchIt = function (e) { e.preventDefault(); e.stopPropagation(); };
      document.addEventListener('click', catchIt, true);
      side.addEventListener('click', catchIt, true);
      setTimeout(function () {
        document.removeEventListener('click', catchIt, true);
        side.removeEventListener('click', catchIt, true);
      }, 300);
    }

    function onDown(e) {
      if (DRAGGING || isDesktop() || !hasTouch(e) || e.button) return;
      var inDrawer = !!(e.target && e.target.closest && e.target.closest('.admin-side'));
      var onScrim = !!(e.target && e.target.closest && e.target.closest('.side-scrim'));
      OPEN0 = body.classList.contains('side-open') && side.classList.contains('open');
      if (!OPEN0 && e.clientX > 28) return;           /* edge zone only */
      if (OPEN0 && !inDrawer && !onScrim) return;     /* swipe the drawer or its scrim */
      DOW = drawerWidth();
      DIX = e.clientX;
      DIY = e.clientY;
      DRAGGING = true;
      MOVED = false;
      VT.length = 0;
      trackVelocity(DIX, e.timeStamp || Date.now());
    }

    function onMove(e) {
      if (!DRAGGING) return;
      var dx = e.clientX - DIX, dy = e.clientY - DIY;
      if (!MOVED) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) {           /* vertical scroll wins */
          DRAGGING = false;
          return;
        }
        MOVED = true;
        body.classList.add('side-dragging');          /* kills the transition */
      }
      trackVelocity(e.clientX, e.timeStamp || Date.now());
      paint(OPEN0 ? dx : dx - DOW);
      e.preventDefault();                             /* we own this gesture */
    }

    function onUp(e) {
      if (!DRAGGING) return;
      var wasOpen = OPEN0, wasMoved = MOVED, v = velocity();
      DRAGGING = false;
      if (!wasMoved) return;                          /* plain tap: click proceeds */
      sealClicks();
      var shouldOpen = decide(v);
      /* hand off to the CSS transition from exactly where the finger
         left the drawer — removing the drag class and the inline px
         var IS the seam; the transition starts at the live value */
      body.classList.remove('side-dragging');
      side.style.removeProperty('--side-x');
      body.style.removeProperty('--side-edge');
      if (scrim) scrim.style.opacity = '';
      CUR = 0;
      if (shouldOpen) {
        if (!wasOpen) openDrawer();
      } else if (wasOpen) {
        closeDrawer();
      } else if (scrim) {
        scrim.classList.remove('show');
      }
    }

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);

    /* crossing the 860px boundary resets the mobile drawer and the
       desktop collapse so both states start clean on the other side */
    if (mq) {
      var onChange = function () {
        closeDrawer();
        if (!mq.matches) body.classList.remove('side-collapsed');
        syncBtn();
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    }
    syncBtn();
  })();

  /* ================= 2c. Bottom sheets: swipe down to dismiss.

     On mobile the modals present as bottom sheets. Grabbing the sheet
     header and pulling down throws it away: 1:1 tracking, resistance
     when lifted past its resting spot, a flick release with momentum
     projection, and a click seal so the throw never presses whatever
     it lands on. Only the header is a grab zone (touch-action: none)
     so the sheet body keeps scrolling normally. ES5, no deps. */

  (function initSheetGestures() {
    var body = document.body;
    var mq = (typeof window.matchMedia === 'function') ? window.matchMedia('(min-width: 861px)') : null;
    function isDesktop() { return mq ? mq.matches : true; }

    var RATIO = 0.4, OPEN_MIN = 0.3, FAR = 90, FLICK = 280, TICK = 90, SLOP = 8;

    var OV = null, BOX = null, Y0 = 0, X0 = 0, DRAGGING = false, MOVED = false, VT = [];

    function hasTouch(e) {
      return !!(e.pointerType === 'touch' || e.pointerType === 'pen');
    }
    function stamp(e) { return e.timeStamp || Date.now(); }

    /* a flick keeps going: v (px/s) decays exponentially */
    function project(v) {
      var rate = 0.998;
      return (v / 1000) * rate / (1 - rate);
    }
    function track(y, t) {
      VT.push({ y: y, t: t });
      while (VT.length > 2 && t - VT[0].t > TICK) VT.shift();
    }
    function velocity() {
      if (VT.length < 2) return 0;
      var a = VT[0], b = VT[VT.length - 1], dt = (b.t - a.t) / 1000;
      return dt ? (b.y - a.y) / dt : 0;
    }

    /* a throw that ends over a control must not press it — but our own
       programmatic clicks (the composer's Cancel, below) are not trusted
       events and must still land, or the discard prompt would be swallowed */
    function sealClicks() {
      var catchIt = function (e) {
        if (!e.isTrusted) return;
        e.preventDefault(); e.stopPropagation();
      };
      document.addEventListener('click', catchIt, true);
      setTimeout(function () { document.removeEventListener('click', catchIt, true); }, 300);
    }

    function clearVars(ov, box) {
      if (box) box.style.removeProperty('--sheet-y');
      if (ov) ov.style.removeProperty('--sheet-o');
    }

    /* the composer has an unsaved-changes prompt, so its swipe travels
       the same road as its Cancel button instead of hiding outright.
       Returns whether the sheet actually closed. */
    function closeVia(ov) {
      if (ov.id === 'addAptModal' && addDirty) {
        var cancel = document.getElementById('btnCancelAddApt');
        if (cancel) cancel.click();       /* surfaces the discard prompt on top */
        return false;                     /* composer stays — snap it back */
      }
      hide(ov);
      if (ov.id === 'delModal') state.pendingDelete = null;
      return true;
    }

    /* hand the sheet to the CSS transition from the live finger position,
       then close once it is off-screen */
    function slideAway(ov, box) {
      var h = box.offsetHeight || 1;
      box.style.setProperty('--sheet-y', (h + 40) + 'px');
      ov.style.setProperty('--sheet-o', '0');
      setTimeout(function () {
        if (closeVia(ov)) setTimeout(function () { clearVars(ov, box); }, 340);
        else clearVars(ov, box);          /* stayed open — put it back in place */
      }, 210);
    }

    function onDown(e) {
      if (DRAGGING || isDesktop() || !hasTouch(e) || e.button) return;
      var t = e.target;
      if (!t || !t.closest) return;
      var head = t.closest('.modal-head');
      if (!head) return;                  /* the header is the grab zone */
      var box = head.closest('.modal-box');
      var ov = (box && box.closest) ? box.closest('.modal-overlay') : null;
      if (!box || !ov || !ov.classList.contains('open')) return;
      OV = ov; BOX = box;
      Y0 = e.clientY; X0 = e.clientX;
      DRAGGING = true; MOVED = false;
      VT.length = 0;
      track(Y0, stamp(e));
    }

    function onMove(e) {
      if (!DRAGGING) return;
      var dy = e.clientY - Y0, dx = e.clientX - X0;
      if (!MOVED) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dx) > Math.abs(dy) || dy <= 0) {   /* sideways or upward: not a dismiss */
          DRAGGING = false; OV = null; BOX = null;
          return;
        }
        MOVED = true;
        body.classList.add('sheet-dragging');           /* kills the transition */
      }
      track(e.clientY, stamp(e));
      var h = BOX.offsetHeight || 1;
      var p = dy > 0 ? dy : dy * RATIO;                 /* resistance when lifted */
      BOX.style.setProperty('--sheet-y', p + 'px');
      OV.style.setProperty('--sheet-o', Math.max(0.06, Math.min(1, 1 - dy / (h * 1.4))).toFixed(3));
      if (e.cancelable) e.preventDefault();             /* we own this gesture */
    }

    function onUp(e) {
      if (!DRAGGING) return;
      var ov = OV, box = BOX, moved = MOVED, v = velocity();
      DRAGGING = false; MOVED = false; OV = null; BOX = null;
      if (!moved || !ov || !box) return;                /* plain tap: click proceeds */
      body.classList.remove('sheet-dragging');
      sealClicks();
      var h = box.offsetHeight || 1;
      var dy = (e && typeof e.clientY === 'number') ? e.clientY - Y0 : 0;
      if (dy < 0) dy = dy * RATIO;
      var proj = dy + Math.max(0, Math.min(h, project(v)));
      if (v > FLICK || proj >= Math.max(FAR, h * OPEN_MIN)) {
        slideAway(ov, box);
      } else {
        box.style.setProperty('--sheet-y', '0px');      /* snap back */
        ov.style.setProperty('--sheet-o', '1');
        setTimeout(function () { clearVars(ov, box); }, 260);
      }
    }

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  })();

  /* ================= 3. Data fetch ================= */

  /* Which relation each table is read from in this session.
     Admin (the default, and the role with no `app_metadata.role`) reads
     the base tables. Every other role is denied them by row-level
     security — see supabase-team-roles.sql — so it reads the
     PII-scrubbed `growth_*` views instead: real counts and channel tags,
     and no student or landlord contact details. state.feedsMissing
     records a failed scrubbed view so the Growth page can say "run the
     role SQL" instead of quietly showing zero as if it were a fact. */
  var FEED_VIEWS = {
    demand_records: 'growth_demand_feed',
    listings: 'growth_listing_feed',
    scout_submissions: 'growth_scout_feed',
    booking_requests: 'growth_booking_feed'
  };

  function relFor(tbl) {
    return currentRole() === 'admin' ? tbl : (FEED_VIEWS[tbl] || tbl);
  }

  function fetchData() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
    state.feedsMissing = false;
    var role = currentRole();
    ArzuzAuth.headers().then(function (h) {
      var promises = TABLES.map(function (tbl) {
        var url = apiRoot() + '/rest/v1/' + relFor(tbl) + '?select=*&order=created_at.desc';
        return fetch(url, { headers: h }).then(function (r) {
          if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Not authorised (HTTP ' + r.status + ')'), { auth: true });
          if (!r.ok && role !== 'admin') state.feedsMissing = true;
          return r.ok ? r.json() : [];
        });
      });
      // minors view for the Overview safeguarding panel
      promises.push(fetch(apiRoot() + '/rest/v1/minors_needing_guardian?select=*', { headers: h })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; }));

      // roommate metric view (the business plan's one number for this line)
      // Non-admin roles read the definer twin of that view, which needs no
      // grant on demand_records — see supabase-team-roles.sql section 3.
      promises.push(fetch(apiRoot() + '/rest/v1/' +
        (role === 'admin' ? 'roommate_match_summary' : 'growth_roommate_summary') + '?select=*', { headers: h })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; }));

      // support tickets for the Support Desk
      promises.push(fetch(apiRoot() + '/rest/v1/support_tickets?select=*&order=created_at.desc', { headers: h })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; }));

      return Promise.all(promises).then(function (results) {
        state.data.demand_records = results[0] || [];
        state.data.listings = results[1] || [];
        state.data.scout_submissions = results[2] || [];
        state.data.booking_requests = results[3] || [];
        state.minors = results[4] || [];
        state.roommateSummary = (results[5] && results[5][0]) ? results[5][0] : null;
        state.data.support_tickets = results[6] || [];
        renderRoute();
      });
    }).catch(function (err) {
      if (err && err.auth) onAuthError(err);
      else if (window.console) console.warn('[Arzuz Admin] fetch failed:', err && err.message);
    });
  }

  /* ================= 4. Overview ================= */

  function renderOverview() {
    var d = state.data;
    var listings = d.listings, demands = d.demand_records, scouts = d.scout_submissions;

    var openDemands = demands.filter(function (r) { return r.status === 'open'; }).length;
    var activeListings = listings.filter(function (r) { return r.status === 'active'; }).length;
    var missingAsk = listings.filter(function (r) { return r.opening_ask_ngn == null; }).length;
    var minorsCount = state.minors.length;

    var T = window.ArzuzUI ? ArzuzUI.tick : null;
    if (T) {
      T($('mDemands'), demands.length);
      T($('mListings'), listings.length);
      T($('mScouts'), scouts.length);
      T($('mOpenDemands'), openDemands);
    } else {
      $('mDemands').textContent = demands.length;
      $('mListings').textContent = listings.length;
      $('mScouts').textContent = scouts.length;
      $('mOpenDemands').textContent = openDemands;
    }

    /* roommate 14-day metric — from the SQL view */
    var rs = state.roommateSummary;
    var mRoom = $('mRoommate');
    if (mRoom) {
      mRoom.textContent = rs ? (rs.pct_matched_within_14d + '%') : '—';
      var roomCard = mRoom.parentElement;
      if (roomCard) roomCard.classList.toggle('attention', !!(rs && rs.roommate_demands_total > rs.matched_total));
    }
    $('mActiveListings').textContent = activeListings;

    /* draft apartments: how many invite links are out, how many are back */
    var drafts = listings.filter(function (r) { return str(r.status).toLowerCase() === 'draft'; });
    var draftsOpen = drafts.filter(function (r) { return !r.draft_completed_at; }).length;
    $('mDrafts').textContent = drafts.length;
    $('mDraftsSub').textContent = drafts.length
      ? draftsOpen + ' awaiting completion · ' + (drafts.length - draftsOpen) + ' awaiting approval'
      : 'Invite links awaiting completion';
    $('mMissingAsk').textContent = missingAsk;
    $('mMissingAsk').parentElement.classList.toggle('attention', missingAsk > 0);
    $('mMinors').textContent = minorsCount;
    $('mMinors').parentElement.classList.toggle('attention', minorsCount > 0);
    $('navPillMinors').textContent = minorsCount ? String(minorsCount) : '';

    /* --- daily ops: minors --- */
    var minorsBox = $('opsMinors');
    if (!state.minors.length) {
      minorsBox.innerHTML = '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx"><b>No minors missing a guardian</b><span>Every under-18 registration has a guardian on file. Nothing to do today.</span></span></div>';
    } else {
      minorsBox.innerHTML =
        '<p class="sub" style="margin-bottom:10px"><b style="color:#FCA5A5">' + state.minors.length + '</b> under-18 ' +
        (state.minors.length === 1 ? 'registration has' : 'registrations have') +
        ' no guardian contact. Match nothing to them until this is filled in.</p>' +
        state.minors.slice(0, 6).map(function (m) {
          return '<div class="ops-row alert">' +
            '<span class="ic">' + ico('alert', 15) + '</span>' +
            '<span class="tx"><b>' + esc(m.first_name || 'Student') + '</b>' +
            '<span>' + esc(str(m.budget_band) || '—') + ' · registered ' + esc(fmtDate(m.created_at)) +
            (m.phone ? ' · ' + esc(m.phone) : '') + '</span></span>' +
            '<span class="ops-cta"><button type="button" class="btn-inline green" data-act="edit" data-table="demand_records" data-id="' + esc(m.id) + '">Add guardian</button></span>' +
            '</div>';
        }).join('') +
        (state.minors.length > 6 ? '<p class="sub" style="margin-top:10px">…and ' + (state.minors.length - 6) + ' more. SQL view: <code>minors_needing_guardian</code></p>' : '');
    }

    /* --- daily ops: opening ask --- */
    var askBox = $('opsAsk');
    if (!missingAsk) {
      askBox.innerHTML = '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx"><b>Every listing has its opening ask</b><span>The gap between opening ask and listed price is the only measurement of whether Arzuz works.</span></span></div>';
    } else {
      var sample = listings.filter(function (r) { return r.opening_ask_ngn == null; }).slice(0, 4);
      askBox.innerHTML =
        '<p class="sub" style="margin-bottom:10px"><b style="color:#FBBF24">' + missingAsk + '</b> listing' +
        (missingAsk === 1 ? ' is' : 's are') + ' missing <b>opening_ask_ngn</b> — the price the landlord asked ' +
        'before seeing any demand data. Enter it from your field notes the same day; never overwrite it afterwards.</p>' +
        sample.map(function (r) {
          var p = payloadOf(r);
          return '<div class="ops-row">' +
            '<span class="ic">' + ico('tag', 15) + '</span>' +
            '<span class="tx"><b>' + esc(pick(r, 'property_name', ['prop_name']) || 'Unnamed property') + '</b>' +
            '<span>' + esc(pick(r, 'area', ['ar']) || '—') + ' · listed at ' + ngn(pick(r, 'listed_price_ngn', ['rent'])) + '</span></span>' +
            '<span class="ops-cta"><button type="button" class="btn-inline green" data-act="edit" data-table="listings" data-id="' + esc(r.id) + '">Add opening ask</button></span>' +
            '</div>';
        }).join('');
    }

    /* --- daily ops: draft invite links --- */
    var draftsBox = $('opsDrafts');
    if (draftsBox) {
      if (!drafts.length) {
        draftsBox.innerHTML = '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx"><b>No open drafts</b>' +
          '<span>Create one with “Save as Draft + Invite Link” when you only know part of the story.</span></span></div>';
      } else {
        draftsBox.innerHTML = drafts.slice(0, 5).map(function (r) {
          var p = payloadOf(r);
          var done = !!r.draft_completed_at;
          return '<div class="ops-row' + (done ? ' alert' : '') + '">' +
            '<span class="ic">' + (done ? ico('check', 15) : ico('link', 15)) + '</span>' +
            '<span class="tx"><b>' + esc(pick(r, 'property_name', ['prop_name']) || 'Unnamed draft') + '</b>' +
            '<span>' + esc(pick(r, 'area', ['ar']) || '—') + ' · ' + (done ? 'landlord finished — review and approve' : 'waiting for the landlord') + '</span></span>' +
            '<span class="ops-cta">' +
            (done ? '<button type="button" class="btn-inline green" data-act="draft-approve" data-table="listings" data-id="' + esc(r.id) + '">Review &amp; approve</button>' : '') +
            '<button type="button" class="btn-inline" data-act="draft-share" data-table="listings" data-id="' + esc(r.id) + '">' + ico('link', 13) + ' Share link</button>' +
            '</span></div>';
        }).join('') +
          (drafts.length > 5 ? '<p class="sub" style="margin-top:10px">…and ' + (drafts.length - 5) + ' more in Listings.</p>' : '');
      }
    }

    /* --- daily ops: support tickets --- */
    var tixBox = $('opsTickets');
    if (tixBox) {
      var tix = (state.data.support_tickets || []).filter(function (r) { return str(r.status).toLowerCase() !== 'resolved' && !isTestRow(r); });
      if (!tix.length) {
        tixBox.innerHTML = '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx"><b>No open tickets</b>' +
          '<span>Reports from the listing page land in the Support Desk automatically.</span></span></div>';
      } else {
        tixBox.innerHTML = tix.slice(0, 5).map(function (r) {
          var p = payloadOf(r);
          var old = ageHours(r.created_at) > 48;
          return '<div class="ops-row' + (old ? ' alert' : '') + '">' +
            '<span class="ic">' + (old ? ico('alert', 15) : ico('headset', 15)) + '</span>' +
            '<span class="tx"><b>' + esc(pick(r, 'category', ['category']) || 'Ticket') + '</b>' +
            '<span>' + esc(p.message || p.note || '') + ' · open for ' + esc(ageLabel(r.created_at)) + '</span></span>' +
            '<span class="ops-cta"><button type="button" class="btn-inline" data-act="view" data-table="support_tickets" data-id="' + esc(r.id) + '">Open</button></span>' +
            '</div>';
        }).join('') +
          (tix.length > 5 ? '<p class="sub" style="margin-top:10px">…and ' + (tix.length - 5) + ' more in the Support Desk.</p>' : '');
      }
    }

    /* --- the funnel (strategy doc 07) ---
       One definition, in ArzuzStrategy, so this card and the Growth page
       can never show two different funnels. When the role SQL has not been
       run yet the scrubbed views 404 — say so rather than draw zeros. */
    var funnelBox = $('opsFunnel');
    if (funnelBox && window.ArzuzStrategy && ArzuzStrategy.funnelCard) {
      funnelBox.innerHTML = state.feedsMissing
        ? '<div class="ops-row alert"><span class="ic">' + ico('alert', 15) + '</span><span class="tx">' +
          '<b>Growth data is not being served to this login yet</b><span>Run ' +
          '<code>supabase-team-roles.sql</code> in Supabase &rarr; SQL Editor, then reload. ' +
          'Until then this role is denied the tables the funnel is built from.</span></span></div>'
        : ArzuzStrategy.funnelCard({
            demands: d.demand_records,
            listings: d.listings,
            bookings: d.booking_requests
          });
    }
  }

  /* ================= 4b. Roommate matching panel =================
     Business plan §4: matching lives INSIDE Housing, applies only to
     shared-occupancy demand (or listings with landlord consent), and
     is measured by ONE number — % matched within 14 days. */

  function roommateDemands() {
    return (state.data.demand_records || []).filter(function (r) {
      var p = payloadOf(r);
      return p.roommate === 'yes' && str(r.status).toLowerCase() === 'open' && !isTestRow(r);
    });
  }

  function candidateScore(a, b) {
    var pa = payloadOf(a), pb = payloadOf(b);
    var s = 0;
    if (pa.budget && pb.budget && pa.budget === pb.budget) s += 3;
    if (pa.when && pb.when && pa.when === pb.when) s += 2;
    if (pa.mate_style && pb.mate_style && pa.mate_style === pb.mate_style) s += 1;
    return s;
  }

  function renderRoommatePanel() {
    var metricEl = $('roommateMetric'), panel = $('roommatePanel');
    if (!metricEl || !panel) return;
    var rs = state.roommateSummary;
    var waiting = roommateDemands();

    metricEl.innerHTML =
      '<h3>' + ico('users', 18) + ' Roommate matching — the one number</h3>' +
      '<p class="sub">The plan tracks exactly one roommate metric: the share of shared-type roommate demand matched within 14 days. A matching feature with nothing matched is just a form.</p>' +
      '<div class="metrics-grid" style="margin-top:14px">' +
        '<div class="metric-card"><div class="metric-lbl">Matched in 14 days</div><div class="metric-num">' + (rs ? esc(String(rs.pct_matched_within_14d)) + '%' : '—') + '</div><div class="metric-sub">' + (rs ? esc(rs.matched_within_14d + ' of ' + rs.roommate_demands_total + ' roommate requests') : 'Run supabase-media-booking.sql to enable this metric') + '</div></div>' +
        '<div class="metric-card"><div class="metric-lbl">Waiting now</div><div class="metric-num">' + waiting.length + '</div><div class="metric-sub">Open roommate requests to pair</div></div>' +
      '</div>';

    var html = '';
    if (!waiting.length) {
      html += '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx"><b>No open roommate requests</b>' +
        '<span>When a student books a shared room and asks for a roommate, they appear here to pair.</span></span></div>';
    }
    waiting.forEach(function (r) {
      var p = payloadOf(r);
      var wa = waLink(pick(r, 'phone', ['phone']));
      var open = state.roommateFor === r.id;
      var cands = open
        ? waiting.filter(function (x) { return x.id !== r.id; })
          .map(function (x) { return { row: x, score: candidateScore(r, x) }; })
          .sort(function (a, b) { return b.score - a.score; })
        : [];
      html += '<div class="mate-card">' +
        '<div class="mate-head"><b>' + esc(pick(r, 'first_name', ['first']) || 'Student') + '</b>' +
        '<span>' + esc(pick(r, 'room_type', ['type']) || '') + ' · ' + esc(pick(r, 'budget_band', ['budget']) || '') + ' · ' + esc(pick(r, 'timing', ['when']) || '') + '</span></div>' +
        '<div class="mate-meta">' +
          (p.mate_gender ? '<span>' + ico('users', 13) + ' ' + esc(p.mate_gender) + '</span>' : '') +
          (p.mate_budget ? '<span>' + ico('tag', 13) + ' ' + esc(p.mate_budget) + '</span>' : '') +
          (p.mate_style ? '<span>' + ico('moon', 13) + ' ' + esc(p.mate_style) + '</span>' : '') +
          '<span>' + ico('calendar', 13) + ' ' + esc(fmtDate(r.created_at)) + '</span>' +
          (wa ? '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
        '</div>' +
        '<div class="mate-actions"><button type="button" class="btn-inline" data-mate="toggle" data-id="' + esc(r.id) + '">' + (open ? 'Close candidates' : 'Find match') + '</button></div>' +
        (open
          ? '<div class="mate-cands">' + (cands.length
            ? cands.map(function (cd) {
                return '<div class="mate-cand">' +
                  '<div><b>' + esc(pick(cd.row, 'first_name', ['first']) || 'Student') + '</b>' +
                  '<span>' + esc(pick(cd.row, 'budget_band', ['budget']) || '') + ' · ' + esc(pick(cd.row, 'timing', ['when']) || '') +
                  (cd.score ? ' · match score ' + cd.score : '') + '</span></div>' +
                  '<button type="button" class="btn-inline green" data-mate="pair" data-a="' + esc(r.id) + '" data-b="' + esc(cd.row.id) + '">' + ico('users', 13) + ' Match</button>' +
                  '</div>';
              }).join('')
            : '<p class="sub">No other open roommate request to pair right now. One appears the moment another shared-room booking comes in.</p>') + '</div>'
          : '') +
        '</div>';
    });

    /* recently matched — ready-to-send WhatsApp intros for both sides */
    var matched = (state.data.demand_records || []).filter(function (r) {
      var p = payloadOf(r);
      return p.roommate === 'yes' && str(r.status).toLowerCase() === 'matched' && p.matched_at;
    }).sort(function (x, y) { return String(payloadOf(y).matched_at).localeCompare(String(payloadOf(x).matched_at)); }).slice(0, 5);
    if (matched.length) {
      html += '<h3 style="margin:20px 0 10px;font-size:15px">Recently matched — send the intros</h3>';
      matched.forEach(function (r) {
        var p = payloadOf(r);
        var partner = (state.data.demand_records || []).find(function (x) { return x.id === p.partner_ref; });
        var pp = payloadOf(partner || {});
        var waMe = waLink(pick(r, 'phone', ['phone']));
        var waP = partner ? waLink(pick(partner, 'phone', ['phone'])) : '';
        var introA = 'Hi ' + (p.first || 'there') + '! Arzuz here 🤝 We found a compatible roommate for you: ' + (pp.first || 'your match') + '. You both asked to share ' + (p.type || 'a room') + '. Want to meet on WhatsApp and agree on the split?';
        var introB = 'Hi ' + (pp.first || 'there') + '! Arzuz here 🤝 We found a compatible roommate for you: ' + (p.first || 'your match') + '. You both asked to share ' + (p.type || 'a room') + '. Want to meet on WhatsApp and agree on the split?';
        html += '<div class="mate-card"><div class="mate-head"><b>' + esc(p.first || 'Student') + ' ↔ ' + esc(pp.first || '—') + '</b>' +
          '<span>matched ' + esc(fmtDate(p.matched_at)) + '</span></div><div class="mate-actions">' +
          (waMe ? '<a class="wa-btn" href="' + waMe + '?text=' + encodeURIComponent(introA) + '" target="_blank" rel="noopener">Intro → ' + esc(p.first || 'student A') + '</a>' : '') +
          (waP ? '<a class="wa-btn" style="margin-left:8px" href="' + waP + '?text=' + encodeURIComponent(introB) + '" target="_blank" rel="noopener">Intro → ' + esc(pp.first || 'student B') + '</a>' : '') +
          '</div></div>';
      });
    }
    panel.innerHTML = html;
  }

  function pairRoommates(aId, bId, btn) {
    var a = (state.data.demand_records || []).find(function (r) { return r.id === aId; });
    var b = (state.data.demand_records || []).find(function (r) { return r.id === bId; });
    if (!a || !b) return;
    var pa = payloadOf(a), pb = payloadOf(b);
    if (!confirm('Match ' + (pa.first || 'student A') + ' with ' + (pb.first || 'student B') + '? Both records flip to MATCHED, each stores the other as partner, and the 14-day clock for the metric stops here.')) return;
    btn.disabled = true; btn.textContent = 'Matching…';
    var now = new Date().toISOString();
    function patchHalf(row, partner) {
      var payload = Object.assign({}, payloadOf(row), {
        partner_ref: partner.id,
        matched_at: now,
        matched_with: payloadOf(partner).first || ''
      });
      return ArzuzAuth.headers().then(function (h) {
        h['Prefer'] = 'return=representation';
        return fetch(apiRoot() + '/rest/v1/demand_records?id=eq.' + row.id, {
          method: 'PATCH', headers: h, body: JSON.stringify({ status: 'matched', payload: payload })
        });
      }).then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Match rejected')); throw new Error('Your session has expired.'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (updated) {
        Object.assign(row, { status: 'matched', payload: payload });
        if (updated && updated[0]) Object.assign(row, updated[0]);
      });
    }
    Promise.all([patchHalf(a, b), patchHalf(b, a)]).then(function () {
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Matched! Send each student their intro on WhatsApp.', 'success');
      state.roommateFor = null;
      renderRoommatePanel();
      renderOverview();
    }).catch(function (err) {
      alert('Could not complete the match: ' + err.message);
      btn.disabled = false; btn.textContent = 'Match';
    });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-mate]') : null;
    if (!b) return;
    if (b.dataset.mate === 'toggle') {
      state.roommateFor = state.roommateFor === b.dataset.id ? null : b.dataset.id;
      renderRoommatePanel();
      return;
    }
    if (b.dataset.mate === 'pair') pairRoommates(b.dataset.a, b.dataset.b, b);
  });

  /* ================= 5. Table renderers ================= */

  function statusOptionsHtml(table, current) {
    var list = (table === 'demand_records')
      ? ['open', 'matched', 'fulfilled', 'expired']
      : (table === 'booking_requests')
        ? ['pending', 'confirmed', 'viewed', 'completed', 'cancelled']
        : (table === 'support_tickets')
          ? ['open', 'in_progress', 'resolved']
          : ['draft', 'pending', 'active', 'rejected', 'inactive'];
    return list.map(function (s) {
      return '<option value="' + s + '"' + (str(current).toLowerCase() === s ? ' selected' : '') + '>' + s.toUpperCase() + '</option>';
    }).join('');
  }

  function visibleRows() {
    var table = sectionTable(state.currentSection);
    var rows = state.data[table] || [];
    var q = state.search.toLowerCase().trim();

    if (!state.showTestRows) rows = rows.filter(function (r) { return !isTestRow(r); });
    if (state.statusFilter !== 'all') rows = rows.filter(function (r) { return str(r.status).toLowerCase() === state.statusFilter; });
    if (state.needsAskOnly && table === 'listings') rows = rows.filter(function (r) { return r.opening_ask_ngn == null; });
    if (q) rows = rows.filter(function (r) { return JSON.stringify(r).toLowerCase().indexOf(q) !== -1; });
    return rows;
  }

  function rowActionsHtml(table, r) {
    var p = payloadOf(r);
    var phone = table === 'demand_records' ? pick(r, 'phone', ['phone'])
      : table === 'listings' ? pick(r, 'owner_phone', ['ph'])
      : table === 'booking_requests' ? pick(r, 'phone', ['phone'])
      : table === 'support_tickets' ? pick(r, 'contact_phone', ['phone'])
      : pick(r, 'scout_phone', ['phone']);
    var wa = waLink(phone);
    var role = currentRole();
    var isAdmin = role === 'admin';
    var isSupport = role === 'support';
    var html = '';
    if (wa) html += '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WA</a>';
    html += actBtn('view', table, r.id, ico('eye', 13) + ' View');
    /* support sees listings read-only — no edit there; never delete */
    if (!(isSupport && table === 'listings')) html += actBtn('edit', table, r.id, ico('pencil', 13) + ' Edit');
    if (isAdmin && table === 'listings' && str(r.status).toLowerCase() === 'draft') {
      if (r.draft_token) {
        html += '<button type="button" class="act-btn" data-act="draft-share" data-table="listings" data-id="' + esc(r.id) + '">' + ico('link', 13) + ' Share</button>';
        html += '<button type="button" class="act-btn" data-act="draft-copy" data-table="listings" data-id="' + esc(r.id) + '">' + ico('copy', 13) + '</button>';
        html += '<button type="button" class="act-btn" data-act="draft-wa" data-table="listings" data-id="' + esc(r.id) + '">' + ico('whatsapp', 13) + '</button>';
      } else {
        html += '<button type="button" class="act-btn" data-act="draft-rotate" data-table="listings" data-id="' + esc(r.id) + '">' + ico('refresh', 13) + ' New link</button>';
      }
      if (r.draft_completed_at) {
        html += '<button type="button" class="act-btn act-approve" data-act="draft-approve" data-table="listings" data-id="' + esc(r.id) + '">' + ico('check', 13) + ' Approve</button>';
      }
    }
    if (isAdmin) html += actBtn('del', table, r.id, ico('trash', 13));
    return html;
  }

  function renderTable() {
    var table = sectionTable(state.currentSection);
    /* every table section repeats the tableHead/tableBody/tableCards ids,
       so scope the lookups to the current section — a bare getElementById
       would always hit the first (hidden) section's table */
    var secEl = document.querySelector('.section-view[data-section="' + state.currentSection + '"]');
    var head = secEl ? secEl.querySelector('#tableHead') : null;
    var body = secEl ? secEl.querySelector('#tableBody') : null;
    var cards = secEl ? secEl.querySelector('#tableCards') : null;
    var rows = visibleRows();
    var html = '';

    if (table === 'demand_records') {
      head.innerHTML = '<th>Date</th><th>Status</th><th>Name</th><th>Room Type</th><th>Budget</th><th>Distance</th><th>Timing</th><th>Contact</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var name = esc(pick(r, 'first_name', ['first'])) + (p.last ? ' ' + esc(p.last) : '');
        var wa = waLink(pick(r, 'phone', ['phone']));
        var isMinor = r.is_minor === true || p.age === 'Under 18';
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + '</td>' +
          '<td><b>' + (name || '—') + '</b>' + (isMinor ? '<span class="no-ask-flag" title="Under 18 — check guardian">minor</span>' : '') + '</td>' +
          '<td>' + esc(pick(r, 'room_type', ['type']) || '—') + '</td>' +
          '<td>' + esc(pick(r, 'budget_band', ['budget']) || '—') + '</td>' +
          '<td>' + esc(pick(r, 'distance', ['dist']) || '—') + '</td>' +
          '<td>' + esc(pick(r, 'timing', ['when']) || '—') + '</td>' +
          '<td>' + (wa ? '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '<span class="muted-cell">—</span>') + '</td>' +
          '<td><div class="cell-actions">' + rowActionsHtml(table, r) + '</div></td>' +
          '</tr>';
      }).join('');
      cards.innerHTML = rows.map(function (r) {
        var p = payloadOf(r);
        var isMinor = r.is_minor === true || p.age === 'Under 18';
        return '<div class="row-card">' +
          '<div class="rc-top"><div class="rc-head"><b>' + esc(pick(r, 'first_name', ['first']) || 'Student') + '</b>' +
          '<div class="rc-sub"><span>' + esc(fmtDate(r.created_at)) + '</span><span>' + esc(pick(r, 'room_type', ['type']) || '—') + '</span></div></div></div>' +
          '<div class="rc-tags">' + statusTag(r.status) + (isMinor ? '<span class="no-ask-flag">minor</span>' : '') + '</div>' +
          '<div class="rc-sub" style="margin-top:6px">Budget: ' + esc(pick(r, 'budget_band', ['budget']) || '—') + ' · ' + esc(pick(r, 'distance', ['dist']) || '—') + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');

    } else if (table === 'listings') {
      head.innerHTML = '<th>Date</th><th>Status</th><th>Apt ID</th><th>Photo</th><th>Property</th><th>Amenities</th><th>Type</th><th>Area</th><th>Opening Ask</th><th>Price</th><th>Location</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var photoUrl = pick(r, 'photo_url', ['photo']);
        var aptId = p.apt_id || p.custom_id || shortId(r.id);
        var askCell = (r.opening_ask_ngn != null)
          ? '<b>' + ngn(r.opening_ask_ngn) + '</b>'
          : '<span class="no-ask-flag" title="Fill this in from your field notes">missing</span>';
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + draftBadgeHtml(r) + '</td>' +
          '<td><span class="apt-badge-id">' + esc(aptId) + '</span></td>' +
          '<td>' + (photoUrl
            ? '<img class="admin-photo-thumb" src="' + esc(photoUrl) + '" alt="Property" data-act="photo" data-url="' + esc(photoUrl) + '">'
            : '<span class="muted-cell">No photo</span>') + mediaCountHtml(p) + '</td>' +
          '<td><b>' + esc(pick(r, 'property_name', ['prop_name']) || '—') + '</b></td>' +
          '<td><div style="max-width:170px;display:flex;flex-wrap:wrap;gap:2px">' + amenitiesTags(p.ut || p.utilities, 3) + '</div></td>' +
          '<td>' + esc(pick(r, 'property_type', ['ty']) || '—') + '</td>' +
          '<td>' + esc(pick(r, 'area', ['ar']) || '—') + '</td>' +
          '<td>' + askCell + '</td>' +
          '<td><b>' + ngn(pick(r, 'listed_price_ngn', ['rent'])) + '</b></td>' +
          '<td>' + mapLink(r) + '</td>' +
          '<td><div class="cell-actions">' + rowActionsHtml(table, r) + '</div></td>' +
          '</tr>';
      }).join('');
      cards.innerHTML = rows.map(function (r) {
        var p = payloadOf(r);
        var photoUrl = pick(r, 'photo_url', ['photo']);
        var aptId = p.apt_id || p.custom_id || shortId(r.id);
        return '<div class="row-card">' +
          '<div class="rc-top">' +
          (photoUrl ? '<img class="rc-thumb" src="' + esc(photoUrl) + '" alt="" data-act="photo" data-url="' + esc(photoUrl) + '">' : '') +
          '<div class="rc-head"><b>' + esc(pick(r, 'property_name', ['prop_name']) || 'Unnamed') + '</b>' +
          '<div class="rc-sub"><span class="apt-badge-id">' + esc(aptId) + '</span><span>' + esc(pick(r, 'area', ['ar']) || '—') + '</span><span>' + esc(pick(r, 'property_type', ['ty']) || '—') + '</span></div></div></div>' +
          '<div class="rc-price">' + ngn(pick(r, 'listed_price_ngn', ['rent'])) + '</div>' +
          '<div class="rc-tags">' + statusTag(r.status) + draftBadgeHtml(r) +
          (r.opening_ask_ngn == null ? '<span class="no-ask-flag">no opening ask</span>' : '') + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');

    } else if (table === 'scout_submissions') {
      head.innerHTML = '<th>Date</th><th>Status</th><th>Photo</th><th>Area</th><th>Rent Paid</th><th>Vacancy</th><th>Utilities</th><th>Location</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var photoUrl = pick(r, 'photo_url', ['photo']);
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + '</td>' +
          '<td>' + (photoUrl
            ? '<img class="admin-photo-thumb" src="' + esc(photoUrl) + '" alt="Building" data-act="photo" data-url="' + esc(photoUrl) + '">'
            : '<span class="muted-cell">No photo</span>') + '</td>' +
          '<td><b>' + esc(pick(r, 'area', ['area']) || '—') + '</b></td>' +
          '<td><b>' + ngn(pick(r, 'rent_reported', ['amt'])) + '</b></td>' +
          '<td>' + esc(pick(r, 'vacancy_signal', ['vac']) || '—') + '</td>' +
          '<td><div style="max-width:140px;display:flex;flex-wrap:wrap;gap:2px">' + amenitiesTags(p.ut || p.utilities, 2) + '</div></td>' +
          '<td>' + mapLink(r) + '</td>' +
          '<td><div class="cell-actions">' + rowActionsHtml(table, r) + '</div></td>' +
          '</tr>';
      }).join('');
      cards.innerHTML = rows.map(function (r) {
        var p = payloadOf(r);
        var photoUrl = pick(r, 'photo_url', ['photo']);
        return '<div class="row-card">' +
          '<div class="rc-top">' +
          (photoUrl ? '<img class="rc-thumb" src="' + esc(photoUrl) + '" alt="" data-act="photo" data-url="' + esc(photoUrl) + '">' : '') +
          '<div class="rc-head"><b>' + esc(pick(r, 'area', ['area']) || 'Building') + '</b>' +
          '<div class="rc-sub"><span>' + esc(fmtDate(r.created_at)) + '</span><span>' + esc(pick(r, 'vacancy_signal', ['vac']) || '—') + '</span></div></div></div>' +
          '<div class="rc-price">' + ngn(pick(r, 'rent_reported', ['amt'])) + '</div>' +
          '<div class="rc-tags">' + statusTag(r.status) + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');
    } else if (table === 'booking_requests') {
      head.innerHTML = '<th>Date</th><th>Status</th><th>Student</th><th>Contact</th><th>Move-in</th><th>Roommate</th><th>Apartment</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var wa = waLink(pick(r, 'phone', ['phone']));
        var mate = (p.roommate === 'yes')
          ? '<span class="tag-status tag-matched">roommate</span>'
          : '<span class="muted-cell">—</span>';
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + '</td>' +
          '<td><b>' + esc(pick(r, 'student_name', ['name']) || 'Student') + '</b></td>' +
          '<td>' + (wa ? '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '<span class="muted-cell">—</span>') + '</td>' +
          '<td>' + esc(pick(r, 'move_in', ['when']) || '—') + '</td>' +
          '<td>' + mate + '</td>' +
          '<td>' + esc(p.listing_name || (r.listing_id ? shortId(r.listing_id) : '—')) + '</td>' +
          '<td><div class="cell-actions">' + rowActionsHtml(table, r) + '</div></td>' +
          '</tr>';
      }).join('');
      cards.innerHTML = rows.map(function (r) {
        var p = payloadOf(r);
        return '<div class="row-card">' +
          '<div class="rc-top"><div class="rc-head"><b>' + esc(pick(r, 'student_name', ['name']) || 'Student') + '</b>' +
          '<div class="rc-sub"><span>' + esc(fmtDate(r.created_at)) + '</span><span>' + esc(pick(r, 'move_in', ['when']) || '—') + '</span></div></div></div>' +
          '<div class="rc-tags">' + statusTag(r.status) +
          (p.roommate === 'yes' ? '<span class="tag-status tag-matched">roommate</span>' : '') + '</div>' +
          '<div class="rc-sub" style="margin-top:6px">' + esc(p.listing_name || 'Apartment request') + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');
    } else if (table === 'support_tickets') {
      head.innerHTML = '<th>Date</th><th>Status</th><th>Category</th><th>Contact</th><th>Report</th><th>Apartment</th><th>Open for</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var wa = waLink(pick(r, 'contact_phone', ['phone']));
        var aged = ageHours(r.created_at) > 48 && str(r.status).toLowerCase() !== 'resolved';
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + '</td>' +
          '<td>' + esc(pick(r, 'category', ['category']) || '—') + '</td>' +
          '<td>' + (wa ? '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '<span class="muted-cell">—</span>') + '</td>' +
          '<td style="max-width:260px">' + esc(p.message || p.note || '—') + '</td>' +
          '<td>' + esc(p.listing_name || '—') + '</td>' +
          '<td class="age-cell' + (aged ? ' age-old' : '') + '">' + esc(ageLabel(r.created_at)) + '</td>' +
          '<td><div class="cell-actions">' + rowActionsHtml(table, r) + '</div></td>' +
          '</tr>';
      }).join('');
      cards.innerHTML = rows.map(function (r) {
        var p = payloadOf(r);
        var aged = ageHours(r.created_at) > 48 && str(r.status).toLowerCase() !== 'resolved';
        return '<div class="row-card">' +
          '<div class="rc-top"><div class="rc-head"><b>' + esc(pick(r, 'category', ['category']) || 'Ticket') + '</b>' +
          '<div class="rc-sub"><span>' + esc(fmtDate(r.created_at)) + '</span><span>' + esc(p.listing_name || '') + '</span></div></div></div>' +
          '<div class="rc-tags">' + statusTag(r.status) + (aged ? '<span class="no-ask-flag">open &gt;48h</span>' : '') + '</div>' +
          '<div class="rc-sub" style="margin-top:6px">' + esc(p.message || p.note || '') + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');
    }

    var emptyMsg = {
      demand_records: 'No student records found.',
      listings: 'No listings found.',
      scout_submissions: 'No scout reports found.',
      booking_requests: 'No booking requests yet.',
      support_tickets: 'No support tickets yet — reports from the listing page arrive here automatically.'
    }[table];
    var colspan = { demand_records: 9, listings: 12, scout_submissions: 9, booking_requests: 8, support_tickets: 8 }[table];
    if (!rows.length) {
      html = '<tr><td class="table-empty" colspan="' + colspan + '"><div class="big">' + ico('clipboard', 26) + '</div>' +
        (state.search || state.statusFilter !== 'all' || state.needsAskOnly
          ? 'Nothing matches the current filters.'
          : emptyMsg) + '</td></tr>';
      cards.innerHTML = '<div class="row-card" style="text-align:center;color:#8D8099">Nothing matches the current filters.</div>';
    }
    body.innerHTML = html;

    // status filter options follow the table
    var sf = $('statusFilter');
    if (sf && sf.dataset.for !== table) {
      sf.dataset.for = table;
      var opts = ['all'].concat(table === 'demand_records'
        ? ['open', 'matched', 'fulfilled', 'expired']
        : table === 'booking_requests'
          ? ['pending', 'confirmed', 'viewed', 'completed', 'cancelled']
          : table === 'support_tickets'
            ? ['open', 'in_progress', 'resolved']
            : ['draft', 'pending', 'active', 'rejected', 'inactive']);
      sf.innerHTML = opts.map(function (s) { return '<option value="' + s + '">' + (s === 'all' ? 'All statuses' : s) + '</option>'; }).join('');
      sf.value = state.statusFilter;
    }
  }

  /* 5c. Delegated actions (view / edit / delete / photo) */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.dataset.act;
    if (act === 'photo') { openPhotoLightbox(btn.dataset.url); return; }
    var table = btn.dataset.table, id = btn.dataset.id;
    if (act === 'view') openDetailsModal(table, id);
    else if (act === 'edit') openEditModal(table, id);
    else if (act === 'del') openDeleteModal(table, id);
    else if (act === 'draft-copy') copyDraftLink(table, id);
    else if (act === 'draft-share') { var ds = findRow(table, id); if (ds) openShareModal(ds, false); }
    else if (act === 'draft-wa') { var dr = findRow(table, id); if (dr) openShareModal(dr, false); }
    else if (act === 'draft-rotate') rotateDraftLink(table, id);
    else if (act === 'draft-revoke') revokeDraftLink(table, id);
    else if (act === 'draft-approve') openEditModal(table, id);   // admin sets tier + status deliberately
  });

  /* Toolbar wiring */
  $('searchInput').addEventListener('input', function () {
    state.search = this.value;
    renderTable();
  });
  $('statusFilter').addEventListener('change', function () {
    state.statusFilter = this.value;
    renderTable();
  });
  $('filterAsk').addEventListener('click', function () {
    state.needsAskOnly = !state.needsAskOnly;
    this.classList.toggle('on', state.needsAskOnly);
    renderTable();
  });
  $('showTestRows').addEventListener('change', function () {
    state.showTestRows = this.checked;
    renderTable();
  });

  /* ================= 6. Edit modal ================= */

  var editModal = $('editModal');

  function chipHtml(name, u, checked) {
    return '<label class="admin-chip' + (checked ? ' active' : '') + '">' +
      '<input type="checkbox" name="' + name + '" value="' + esc(u) + '"' + (checked ? ' checked' : '') +
      ' onchange="this.parentElement.classList.toggle(\'active\', this.checked)">' +
      '<span>' + (checked ? ico('check', 12) + ' ' : '+ ') + esc(u) + '</span></label>';
  }

  window.openEditModal = function (table, id) {
    var row = (state.data[table] || []).find(function (r) { return r.id === id; });
    if (!row) return;
    var p = payloadOf(row);
    var html = '';

    $('editRowId').value = id;
    $('editRowTable').value = table;
    $('editModalTitle').textContent = 'Edit ' + (table === 'demand_records' ? 'Student Demand' : table === 'listings' ? 'Property Listing' : 'Scout Report');
    setError('editModalError', '');

    /* status + notes are shared across tables */
    html += '<div class="edit-fld"><label>Status</label><select id="edit_status">' + statusOptionsHtml(table, row.status) + '</select></div>';
    html += '<div class="edit-fld"><label>Admin Notes</label><input type="text" id="edit_notes" value="' + esc(row.notes || '') + '" placeholder="Internal notes…"></div>';

    if (table === 'demand_records') {
      html += '<div class="edit-fld"><label>First Name</label><input type="text" id="edit_first" value="' + esc(pick(row, 'first_name', ['first'])) + '"></div>';
      html += '<div class="edit-fld"><label>Last Name</label><input type="text" id="edit_last" value="' + esc(p.last || '') + '"></div>';
      html += '<div class="edit-fld"><label>Phone / WhatsApp</label><input type="tel" id="edit_phone" value="' + esc(pick(row, 'phone', ['phone'])) + '"></div>';
      html += '<div class="edit-fld"><label>Room Type</label><input type="text" id="edit_room_type" value="' + esc(pick(row, 'room_type', ['type'])) + '"></div>';
      html += '<div class="edit-fld"><label>Budget Band</label><input type="text" id="edit_budget_band" value="' + esc(pick(row, 'budget_band', ['budget'])) + '"></div>';
      /* guardian fields — closes the safeguarding loop in-page */
      html += '<div class="edit-fld"><label>Guardian Name</label><input type="text" id="edit_g_name" value="' + esc(p.g_name || '') + '"></div>';
      html += '<div class="edit-fld"><label>Guardian WhatsApp</label><input type="tel" id="edit_g_phone" value="' + esc(p.g_phone || '') + '"></div>';
    }

    else if (table === 'booking_requests') {
      html += '<div class="edit-fld"><label>Student</label><input type="text" id="edit_name" value="' + esc(pick(row, 'student_name', ['name'])) + '"></div>';
      html += '<div class="edit-fld"><label>WhatsApp</label><input type="tel" id="edit_phone" value="' + esc(pick(row, 'phone', ['phone'])) + '"></div>';
      html += '<div class="edit-fld"><label>Move-in</label><input type="text" id="edit_when" value="' + esc(pick(row, 'move_in', ['when'])) + '"></div>';
      html += '<div class="edit-fld"><label>Apartment</label><input type="text" id="edit_apt_name" value="' + esc(p.listing_name || '') + '"></div>';
      if (p.roommate === 'yes') {
        html += '<div class="edit-fld full"><label>Roommate request</label><input type="text" id="edit_mate_info" value="' + esc([p.mate_gender, p.mate_budget, p.mate_style].filter(Boolean).join(' · ')) + '" readonly></div>';
      }
      if (p.note) html += '<div class="edit-fld full"><label>Student note</label><input type="text" id="edit_note_txt" value="' + esc(p.note) + '"></div>';
    }

    else if (table === 'listings') {
      var photoUrl = pick(row, 'photo_url', ['photo']);
      var videoUrl = p.video || p.video_url || '';
      var aptId = p.apt_id || p.custom_id || shortId(row.id);
      var curRole = str(p.contact_role) || str(p.who);
      var availMode = str(p.avail) === 'occupied' ? 'occupied' : 'vacant';
      var unitsVal = str(p.units) || (availMode === 'vacant' ? str(p.rm).replace(/[^0-9]/g, '') : '');
      var accessNotes = (p.passage && str(p.passage.landmark)) || str(p.access_notes);
      var pLat = row.latitude || p.lat || '';
      var pLng = row.longitude || p.lng || '';
      var pinStr = p.pin || (pLat && pLng ? pLat + ',' + pLng : '');
      var hasRoute = !!(p.passage && p.passage.route && p.passage.route.length > 1);

      /* Status + admin notes were rendered above; they belong at the top
         of the first tab. */
      var sharedFields = html;

      /* ---------------- tab 1 — property details & pricing ---------------- */
      var specs = '';
      specs += '<div class="edit-fld"><label>Apartment ID / Code</label><input type="text" id="edit_apt_id" value="' + esc(aptId) + '" placeholder="e.g. APT-001"></div>';
      specs += '<div class="edit-fld"><label>Property / Lodge Name <small>optional</small></label><input type="text" id="edit_prop_name" value="' + esc(pick(row, 'property_name', ['prop_name'])) + '"></div>';
      specs += '<div class="edit-fld"><label>Property Type</label><select id="edit_ty">' +
        (typeof PROPERTY_TYPES !== 'undefined' ? PROPERTY_TYPES : []).map(function (t) {
          return '<option' + (pick(row, 'property_type', ['ty']) === t ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></div>';
      specs += '<div class="edit-fld"><label>Area / Street</label><input type="text" id="edit_ar" value="' + esc(pick(row, 'area', ['ar'])) + '"></div>';
      specs += '<div class="edit-fld"><label>Rent Price (₦ / session)</label><input type="number" id="edit_rent" value="' + esc(pick(row, 'listed_price_ngn', ['rent'])) + '"></div>';

      /* OPENING ASK — the thesis number. Locked once set. */
      var ask = row.opening_ask_ngn;
      specs += '<div class="edit-fld full"><label>Opening Ask (₦) <small>what the landlord asked BEFORE seeing demand data</small></label>' +
        (ask != null
          ? '<input type="number" id="edit_ask" value="' + esc(ask) + '" disabled>' +
            '<label class="ask-unlock"><input type="checkbox" id="edit_ask_unlock">' +
            '<small>Unlock &amp; override deliberately — overwriting it destroys the only real measurement Arzuz has.</small></label>'
          : '<input type="number" id="edit_ask" value="" placeholder="e.g. 200000">') +
        '</div>';

      /* availability — vacant count or fully occupied */
      specs += '<div class="edit-fld full"><label>Availability</label>' +
        '<div class="seg" id="editAvailSeg" role="group" aria-label="Availability">' +
          '<button type="button" class="seg-btn' + (availMode === 'vacant' ? ' on' : '') + '" data-seg="vacant" aria-pressed="' + (availMode === 'vacant' ? 'true' : 'false') + '">' + ico('check', 13) + ' Vacant units available</button>' +
          '<button type="button" class="seg-btn' + (availMode === 'occupied' ? ' on' : '') + '" data-seg="occupied" aria-pressed="' + (availMode === 'occupied' ? 'true' : 'false') + '">' + ico('x', 13) + ' Fully occupied</button>' +
        '</div>' +
        '<div id="editUnitsWrap"' + (availMode === 'occupied' ? ' style="display:none;"' : '') + '>' +
          '<input type="number" id="edit_units" min="1" step="1" value="' + esc(unitsVal) + '" placeholder="How many units are vacant? e.g. 3">' +
        '</div>' +
        '<input type="hidden" id="edit_avail" value="' + esc(availMode) + '"></div>';

      specs += '<div class="edit-fld"><label>Contact Person</label><input type="text" id="edit_nm" value="' + esc((str(pick(row, 'owner_name', ['nm'])) + ' ' + str(p.last)).trim()) + '"></div>';
      specs += '<div class="edit-fld"><label>Contact Phone / WhatsApp</label><input type="tel" id="edit_ph" value="' + esc(pick(row, 'owner_phone', ['ph'])) + '"></div>';
      specs += '<div class="edit-fld"><label>Contact Role</label><select id="edit_role">' + roleOptionsHtml(curRole) + '</select></div>';
      specs += '<div class="edit-fld"><label>Verification Tier</label><select id="edit_tier">' + tierOptionsHtml(row.tier) + '</select></div>';

      specs += '<div class="edit-fld full"><label>Amenities &amp; Utilities <small>type to search — Enter adds a new one</small></label>' +
        '<div class="tag-field" id="editAmenityField">' +
          '<span id="editAmenityChips" style="display:contents;"></span>' +
          '<input type="text" id="editAmenityInput" placeholder="e.g. solar, borehole, prepaid meter…" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="editAmenitySuggest">' +
          '<div class="tag-suggest" id="editAmenitySuggest" role="listbox" aria-label="Amenity suggestions"></div>' +
        '</div></div>';

      specs += '<div class="edit-fld full"><label>Description &amp; Features</label><textarea id="edit_desc" rows="2" placeholder="Running water, prepaid meter…">' + esc(p.desc || p.description || '') + '</textarea></div>';
      specs += '<div class="edit-fld full"><label class="ck-line"><input type="checkbox" id="edit_split_ok"' +
        ((p.split_ok === true || p.split_ok === 'yes') ? ' checked' : '') +
        '> <span>Landlord consents to this room being shared by two tenants who split the cost <small>(enables roommate matching on the public page)</small></span></label></div>';

      /* ---------------- tab 2 — location & access ---------------- */
      var loc = '';
      loc += '<div class="edit-fld full"><label>' + ico('pin', 13) + ' Map <small>one map — pin the gate, or trace the walk-in path</small></label>' +
        '<div class="map-mode-bar">' +
          '<div class="seg" id="editMapModeSeg" role="group" aria-label="Map mode">' +
            '<button type="button" class="seg-btn on" data-seg="pin" aria-pressed="true">' + ico('pin', 13) + ' Pin location</button>' +
            '<button type="button" class="seg-btn" data-seg="path" aria-pressed="false">' + ico('trending', 13) + ' Draw path</button>' +
          '</div>' +
          '<span class="map-coords" id="editMapCoordsText">' + (pinStr ? ico('pin', 13) + ' ' + esc(pinStr) : ico('pin', 13) + ' Tap the map at the gate') + '</span>' +
        '</div>' +
        '<div class="admin-map-wrap"><div id="editLeafletMap"></div>' +
          '<div class="map-float-btns" id="editMapLayerSwitcher">' +
            '<button type="button" class="map-layer-btn active" data-layer="sat">' + ico('image', 12) + ' Satellite</button>' +
            '<button type="button" class="map-layer-btn" data-layer="street">' + ico('search', 12) + ' Street</button>' +
          '</div>' +
        '</div>' +
        '<div class="map-bottom-bar">' +
          '<div class="admin-trace-bar" id="editTraceBar" style="display:none;">' +
            '<button type="button" id="editTraceToggle" style="display:none;">Trace</button>' +
            '<button type="button" class="psg-tool" id="editTraceUndo">' + ico('chevL', 12) + ' Undo</button>' +
            '<button type="button" class="psg-tool" id="editTraceClear">' + ico('x', 12) + ' Clear path</button>' +
            '<span class="psg-count" id="editTraceCount"></span>' +
          '</div>' +
          '<button type="button" class="gps-btn" id="editBtnLocateMe">' + ico('pin', 13) + ' Use GPS</button>' +
        '</div>' +
        '<div class="map-status-box" id="editMapStatus">Live GPS is off here to save battery — tap Use GPS when you are at the gate.</div>' +
        '<input type="hidden" id="edit_lat" value="' + esc(pLat) + '">' +
        '<input type="hidden" id="edit_lng" value="' + esc(pLng) + '">' +
        '<input type="hidden" id="edit_pin_meta" value=\'' + esc(JSON.stringify(p.pin_meta || null)) + '\'>' +
        (hasRoute ? '<div class="apt-hint" style="margin-top:8px;">A ' + p.passage.route.length + '-point walk path is stored on this listing. Switch to <b>Draw path</b> to see or change it.</div>' : '') +
        '</div>';

      loc += '<div class="edit-fld full"><label>' + ico('pin', 13) + ' Access &amp; Navigation Notes <small>optional — landmark, gate colour, stairs, what to look for</small></label>' +
        '<textarea id="edit_access_notes" rows="3" placeholder="e.g. Opposite the blue mosque, brown double gate with a small green door, first floor — stairs at the back.">' + esc(accessNotes) + '</textarea></div>';

      /* ---------------- tab 3 — media & draft sharing ---------------- */
      var media = '';
      media += '<div class="edit-fld full"><label>' + ico('image', 13) + ' Photos <small>drag &amp; drop or click · compressed in the browser before upload</small></label>' +
        '<div class="admin-media-zone" id="galEditZone" role="button" tabindex="0">' + ico('image', 15) + ' Add photos — drop them here, or click to choose several' +
        '<input type="file" id="galEditInput" accept="image/*" multiple style="display:none;">' +
        '</div><div class="media-upload-status" id="galEditProgress"></div></div>';

      media += '<div class="edit-fld full"><label>' + ico('video', 13) + ' Video tour <small>drag &amp; drop a file, or paste a link</small></label>' +
        '<div class="admin-media-zone" id="galEditVideoZone" role="button" tabindex="0">' + ico('video', 15) + ' Drop a video tour here, or click to choose' +
        '<input type="file" id="galEditVideoInput" accept="video/*" style="display:none;">' +
        '</div><div class="media-upload-status" id="galEditVideoProgress"></div>' +
        '<div class="admin-media-zone url-zone" style="margin-top:8px;"><div class="url-row">' +
        '<input type="url" id="edit_video_manual" value="' + esc(videoUrl) + '" placeholder="…or paste a YouTube link">' +
        '<button type="button" id="edit_video_url_add">' + ico('plus', 12) + ' Embed</button>' +
        '</div></div></div>';

      media += '<div class="edit-fld full"><label>Staged media <small>nothing is sent until it lands here · ✕ removes · ★ sets the cover</small></label>' +
        '<div class="gal-mgr" id="galEditGrid"></div>' +
        '<input type="hidden" id="edit_photo" value="' + esc(photoUrl) + '">' +
        '<input type="hidden" id="edit_video" value="' + esc(videoUrl) + '">' +
        '</div>';

      if (str(row.status).toLowerCase() === 'draft') {
        media += '<div class="edit-fld full"><label>' + ico('link', 13) + ' Draft link &amp; permissions</label>' +
          '<div class="apt-hint">' + (row.draft_token
            ? 'Permission: <b>' + esc(draftPermission(row) === 'view' ? 'View only' : 'Can edit') + '</b> · ' + esc(expiryLabel(row)) + '.'
            : 'The link is revoked — issue a new one below.') +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
            '<button type="button" class="btn-inline green" data-act="draft-share" data-table="listings" data-id="' + esc(row.id) + '">' + ico('link', 13) + ' Manage permissions</button>' +
            (row.draft_token ? '<button type="button" class="btn-inline" data-act="draft-copy" data-table="listings" data-id="' + esc(row.id) + '">' + ico('copy', 13) + ' Copy link</button>' : '') +
            '<button type="button" class="btn-inline" data-act="draft-wa" data-table="listings" data-id="' + esc(row.id) + '">' + ico('whatsapp', 13) + ' Send</button>' +
            '<button type="button" class="btn-inline" data-act="draft-rotate" data-table="listings" data-id="' + esc(row.id) + '">' + ico('refresh', 13) + ' New link</button>' +
            (row.draft_token ? '<button type="button" class="btn-inline" data-act="draft-revoke" data-table="listings" data-id="' + esc(row.id) + '">' + ico('x', 13) + ' Revoke</button>' : '') +
          '</div></div>';
      }

      html = '<div class="apt-tabs" role="tablist" aria-label="Apartment sections">' +
        '<button type="button" class="apt-tab active" role="tab" aria-selected="true" data-apt-tab="specs">' + ico('home', 15) + ' Property &amp; Pricing</button>' +
        '<button type="button" class="apt-tab" role="tab" aria-selected="false" data-apt-tab="location">' + ico('pin', 15) + ' Location &amp; Access</button>' +
        '<button type="button" class="apt-tab" role="tab" aria-selected="false" data-apt-tab="media">' + ico('image', 15) + ' Media &amp; Draft</button>' +
        '</div>' +
        '<div class="apt-panel" data-apt-panel="specs"><div class="edit-form-grid">' + sharedFields + specs + '</div></div>' +
        '<div class="apt-panel" data-apt-panel="location" hidden><div class="edit-form-grid">' + loc + '</div></div>' +
        '<div class="apt-panel" data-apt-panel="media" hidden><div class="edit-form-grid">' + media + '</div></div>';
    }
    /* Location + passage editor — scout reports keep the flat grid;
       apartment listings carry the same widgets inside their tabs. */
    if (table === 'scout_submissions') {
      var sLat = row.latitude || p.lat || '';
      var sLng = row.longitude || p.lng || '';
      var sPin = p.pin || (sLat && sLng ? sLat + ',' + sLng : '');
      html += '<div class="edit-fld full"><label>' + ico('pin', 13) + ' Location Pin <small>live GPS · tap or drag · accuracy and source are stored</small></label>' +
        '<div class="admin-map-wrap"><div id="editLeafletMap"></div>' +
        '<div class="map-float-btns" id="editMapLayerSwitcher">' +
        '<button type="button" class="map-layer-btn active" data-layer="sat">' + ico('image', 12) + ' Satellite</button>' +
        '<button type="button" class="map-layer-btn" data-layer="street">' + ico('search', 12) + ' Street</button>' +
        '</div></div>' +
        '<div class="map-bottom-bar"><span class="map-coords" id="editMapCoordsText">' + (sPin ? ico('pin', 13) + ' ' + esc(sPin) : ico('pin', 13) + ' Tap map or drag marker to the gate') + '</span>' +
        '<button type="button" class="gps-btn" id="editBtnLocateMe">' + ico('pin', 13) + ' Use GPS</button></div>' +
        '<div class="map-status-box" id="editMapStatus">Live GPS is off here to save battery — tap Use GPS when you are at the gate.</div>' +
        '<input type="hidden" id="edit_lat" value="' + esc(sLat) + '">' +
        '<input type="hidden" id="edit_lng" value="' + esc(sLng) + '">' +
        '<input type="hidden" id="edit_pin_meta" value=\'' + esc(JSON.stringify(p.pin_meta || null)) + '\'></div>';
      html += '<div class="edit-fld full"><label>' + ico('pin', 13) + ' Passage to the apartment <small>landmark · gate · steps · traced path — shown on the public listing page</small></label>' +
        '<div id="editPassageMount"></div></div>';
    }

    $('editFieldsContainer').innerHTML = html;
    show(editModal);

    if (table === 'scout_submissions') {
      destroyEditMap();
      if (typeof ArzuzMap !== 'undefined') {
        editPinCapture = ArzuzMap.pinCapture({
          containerId: 'editLeafletMap',
          layerSwitchId: 'editMapLayerSwitcher',
          coordsBadgeId: 'editMapCoordsText',
          locateBtnId: 'editBtnLocateMe',
          statusBoxId: 'editMapStatus',
          tipBannerId: null,
          startGps: false,
          trace: false,
          lat: sLat || null,
          lng: sLng || null,
          onPin: function (lat, lng, meta) {
            var la = $('edit_lat'), ln = $('edit_lng'), mt = $('edit_pin_meta');
            if (la) la.value = lat;
            if (ln) ln.value = lng;
            if (mt) mt.value = JSON.stringify(meta);
            var badge = $('editMapCoordsText');
            if (badge) { badge.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5); badge.classList.add('set'); }
          }
        });
        editPassageEditor = ArzuzMap.passageEditor({
          mountId: 'editPassageMount',
          answers: null,
          passage: p.passage || null,
          miniMap: true,
          pin: sLat ? { lat: sLat, lng: sLng } : null,
          onChange: null
        });
      }
    }

    if (table === 'listings') {
      /* The map and the media queue are built when their tab is first
         revealed — Leaflet cannot size a container that is display:none. */
      initAptTabs($('editFieldsContainer'), 'edit', {
        location: function () {
          if (editMapReady) return;
          editMapReady = true;
          initEditListingMap(row);
        }
      });
      APT_TAG.edit = initTagField({
        fieldId: 'editAmenityField', chipsId: 'editAmenityChips',
        inputId: 'editAmenityInput', suggestId: 'editAmenitySuggest',
        value: toList(p.ut || p.utilities)
      });
      var availSeg = initSeg('editAvailSeg', function (mode) {
        var wrap = $('editUnitsWrap');
        if (wrap) wrap.style.display = (mode === 'occupied') ? 'none' : '';
        if ($('edit_avail')) $('edit_avail').value = mode;
      });
      if ($('edit_avail')) $('edit_avail').value = availSeg ? availSeg.get() : availMode;
      editMapMode = initSeg('editMapModeSeg', function (mode) { setEditMapMode(mode); });

      var unlock = $('edit_ask_unlock');
      if (unlock) unlock.addEventListener('change', function () { $('edit_ask').disabled = !this.checked; });

      initGalleryManager('edit', seedMedia(p, photoUrl, videoUrl));

      var emanual = $('edit_video_manual');
      var eadd = $('edit_video_url_add');
      function embedEditUrl() {
        var url = emanual ? str(emanual.value).trim() : '';
        if (!url) return;
        /* same rule as the add form — see video.js:playbackProblem */
        if (window.ArzuzVideo && ArzuzVideo.normalizeUrl) url = ArzuzVideo.normalizeUrl(url);
        if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(url)) {
          if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('That does not look like a link.', 'error');
          return;
        }
        if (window.ArzuzVideo && ArzuzVideo.playbackProblem) {
          var eproblem = ArzuzVideo.playbackProblem(url);
          if (eproblem) {
            if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(eproblem, 'error');
            return;
          }
        }
        var list = galList('edit');
        if (!list.some(function (m) { return m.url === url; })) {
          list.push({ type: 'video', url: url, label: 'Video tour', credit: credit() });
          renderGal('edit');
        }
        emanual.value = '';
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Video tour attached.', 'success');
      }
      if (eadd) eadd.addEventListener('click', embedEditUrl);
      if (emanual) emanual.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); embedEditUrl(); } });
    }
  };

  /* Contact-role + tier selects shared by the composer and the editor */
  var CONTACT_ROLES = ['Landlord', 'Caretaker', 'Agent', 'Admin'];

  function roleOptionsHtml(current) {
    var cur = str(current);
    return ['<option value="">—</option>'].concat(CONTACT_ROLES.map(function (r) {
      return '<option value="' + esc(r) + '"' + (cur === r ? ' selected' : '') + '>' + esc(r) + '</option>';
    })).join('');
  }

  function tierOptionsHtml(tier) {
    var t = Number(tier);
    return ['Tier 0 — Unverified', 'Tier 1 — Community Verified', 'Tier 2 — Inspected'].map(function (label, i) {
      return '<option value="' + i + '"' + (t === i ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
  }
  function collectEditPayload(table, row) {
    var p = Object.assign({}, payloadOf(row));

    if (table === 'demand_records') {
      p.first = $('edit_first').value.trim();
      if ($('edit_last')) p.last = $('edit_last').value.trim();
      p.phone = $('edit_phone').value.trim();
      p.type = $('edit_room_type').value.trim();
      p.budget = $('edit_budget_band').value.trim();
      p.g_name = $('edit_g_name') ? $('edit_g_name').value.trim() : (p.g_name || '');
      p.g_phone = $('edit_g_phone') ? $('edit_g_phone').value.trim() : (p.g_phone || '');
    } else if (table === 'listings') {
      p.apt_id = $('edit_apt_id') ? $('edit_apt_id').value.trim() : '';
      p.custom_id = p.apt_id;
      p.prop_name = $('edit_prop_name') ? $('edit_prop_name').value.trim() : '';
      p.nm = $('edit_nm') ? $('edit_nm').value.trim() : '';
      /* one contact-name field now — the legacy split column is cleared */
      p.last = '';
      p.ph = $('edit_ph') ? $('edit_ph').value.trim() : '';
      var eRole = $('edit_role') ? $('edit_role').value : '';
      p.contact_role = eRole;
      p.who = eRole || p.who || '';
      p.ty = $('edit_ty') ? $('edit_ty').value : p.ty;
      p.ar = $('edit_ar') ? $('edit_ar').value.trim() : '';
      var eMode = $('edit_avail') ? $('edit_avail').value : (str(p.avail) === 'occupied' ? 'occupied' : 'vacant');
      var eUnitsRaw = $('edit_units') ? str($('edit_units').value).trim() : '';
      var eUnits = parseInt(eUnitsRaw, 10);
      p.avail = eMode;
      p.units = (eMode === 'vacant' && isFinite(eUnits) && eUnits > 0) ? eUnits : (eMode === 'occupied' ? 0 : null);
      if (eMode === 'occupied') p.rm = 'Fully occupied';
      else if (p.units) p.rm = p.units + (p.units === 1 ? ' room available' : ' rooms available');
      else p.rm = 'Units available';
      p.rent = $('edit_rent') ? $('edit_rent').value.trim() : '';
      if ($('edit_desc')) p.desc = $('edit_desc').value.trim();
      var sel = APT_TAG.edit ? APT_TAG.edit.get() : toList(p.ut || p.utilities);
      p.ut = sel; p.utilities = sel.slice();
      var gl = galList('edit');
      p.media = gl.map(function (m) { return { type: m.type, url: m.url, label: m.label || '', credit: m.credit || credit() }; });
      var coverM = gl.filter(function (m) { return m.type === 'image'; })[0];
      var tourM = gl.filter(function (m) { return m.type === 'video'; })[0];
      p.photo = coverM ? coverM.url : '';
      var vid = tourM ? tourM.url : '';
      p.video = vid; p.video_url = vid;
      if ($('edit_split_ok')) p.split_ok = $('edit_split_ok').checked;
    } else if (table === 'booking_requests') {
      if ($('edit_name')) p.name = $('edit_name').value.trim();
      if ($('edit_phone')) p.phone = $('edit_phone').value.trim();
      if ($('edit_when')) p.when = $('edit_when').value.trim();
      if ($('edit_apt_name')) p.listing_name = $('edit_apt_name').value.trim();
    } else if (table === 'scout_submissions') {
      p.area = $('edit_area').value.trim();
      p.phone = $('edit_phone').value.trim();
      p.amt = $('edit_amt').value.trim();
      p.vac = $('edit_vac') ? $('edit_vac').value.trim() : (p.vac || '');
    }

    /* Location + passage — only touched where the editor rendered them.
       pin_meta replaces only when a new fix was captured this session. */
    if (table === 'listings' || table === 'scout_submissions') {
      var eLat = $('edit_lat'), eLng = $('edit_lng'), eMeta = $('edit_pin_meta');
      if (eLat && eLng && eLat.value.trim() && eLng.value.trim()) {
        p.lat = eLat.value.trim();
        p.lng = eLng.value.trim();
        p.pin = Number(eLat.value).toFixed(6) + ',' + Number(eLng.value).toFixed(6);
      }
      if (eMeta && eMeta.value && eMeta.value !== 'null') {
        try { p.pin_meta = JSON.parse(eMeta.value); } catch (e2) { /* keep old */ }
      }
      if (table === 'scout_submissions' && editPassageEditor) {
        var psg = editPassageEditor.get();
        if (ArzuzMap && ArzuzMap.passage.hasContent(psg)) p.passage = psg;
        else delete p.passage;
      }
      /* listings: one access-notes box + whatever route was traced on
         the map. Both live in the passage object so the public listing
         page (and the route map) keep working unchanged. */
      if (table === 'listings') {
        var notes = $('edit_access_notes') ? str($('edit_access_notes').value).trim() : '';
        var meta = readPinMeta('edit_pin_meta') || {};
        var prev = (p.passage && typeof p.passage === 'object') ? p.passage : {};
        var route = (meta.route && meta.route.length > 1) ? meta.route : (prev.route || []);
        var next = {
          landmark: notes,
          gate: str(prev.gate),
          floor: str(prev.floor),
          steps: Array.isArray(prev.steps) ? prev.steps : [],
          route: route,
          route_src: str(meta.route_src) || str(prev.route_src),
          route_km: meta.route_km || prev.route_km || null,
          route_min: meta.route_min || prev.route_min || null
        };
        if (ArzuzMap && ArzuzMap.passage.hasContent(next)) p.passage = next;
        else delete p.passage;
      }
    }
    return p;
  }

  $('btnCancelEdit').addEventListener('click', function () { hide(editModal); destroyEditMapAndPassage(); });

  $('editRecordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var table = $('editRowTable').value;
    var id = $('editRowId').value;
    var row = (state.data[table] || []).find(function (r) { return r.id === id; });
    if (!row) return;

    var patch = {
      status: $('edit_status').value,
      notes: $('edit_notes').value.trim(),
      payload: collectEditPayload(table, row)
    };
    if (table === 'listings') {
      patch.tier = parseInt($('edit_tier').value, 10) || 0;
      var askRaw = $('edit_ask') && !$('edit_ask').disabled ? $('edit_ask').value.trim() : '';
      if (askRaw !== '') {
        var askNum = parseInt(askRaw, 10);
        /* honour "never overwrite": only write when currently empty,
           or when the unlock box was ticked */
        if (row.opening_ask_ngn == null) patch.opening_ask_ngn = isNaN(askNum) ? null : askNum;
        else if ($('edit_ask_unlock') && $('edit_ask_unlock').checked) patch.opening_ask_ngn = isNaN(askNum) ? null : askNum;
      }
    }

    var btn = $('btnSaveEdit');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    setError('editModalError', '');

    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/' + table + '?id=eq.' + id, {
        method: 'PATCH', headers: h, body: JSON.stringify(patch)
      });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Update rejected')); throw new Error('Your session has expired.'); }
        if (!r.ok) throw new Error('Update failed (HTTP ' + r.status + ')');
        return r.json();
      })
      .then(function (updated) {
        Object.assign(row, { status: patch.status, notes: patch.notes, payload: patch.payload });
        if (updated && updated[0]) Object.assign(row, updated[0]);
        hide(editModal);
        renderRoute();
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Record updated successfully!', 'success');
      })
      .catch(function (err) { setError('editModalError', 'Could not update record: ' + err.message); })
      .finally(function () { btn.textContent = 'Save Changes'; btn.disabled = false; });
  });

  /* media remove buttons (delegated — previews are re-rendered) */
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.media-remove-btn') : null;
    if (!b) return;
    var inp = $(b.dataset.clear), prev = $(b.dataset.prev);
    if (inp) inp.value = '';
    if (prev) { prev.innerHTML = ''; prev.style.display = 'none'; }
  });

    /* ================= 6b. Apartment composer primitives =================
     One home for the pieces the two apartment surfaces (Add and Edit)
     share: the tab shell, the segmented toggles, the amenity combobox
     and the staged media queue. Plain DOM — no framework — so both
     builders stay independent of each other.
     ------------------------------------------------------------ */

  var APT_HOOKS = { add: null, edit: null };   // tab-key → callback
  var APT_GO = { add: null, edit: null };      // tab activator per surface
  var APT_TAG = { add: null, edit: null };     // amenity combobox per surface

  /* Only the active panel is shown; every control stays in the DOM so
     the collectors (and the map / gallery widgets) keep working. The
     hooks let a panel initialise the first time it is revealed — that
     is how the Leaflet map avoids being built inside a display:none
     container. */
  function initAptTabs(scope, ctx, hooks) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;
    var tabs = scope.querySelectorAll('[data-apt-tab]');
    var panels = scope.querySelectorAll('[data-apt-panel]');
    if (!tabs.length || !panels.length) return null;
    APT_HOOKS[ctx] = hooks || {};

    function activate(key) {
      var found = false;
      Array.prototype.forEach.call(tabs, function (t) {
        var on = t.getAttribute('data-apt-tab') === key;
        if (on) found = true;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (!found) return;
      Array.prototype.forEach.call(panels, function (p) {
        if (p.getAttribute('data-apt-panel') === key) p.removeAttribute('hidden');
        else p.setAttribute('hidden', 'hidden');
      });
      var fn = APT_HOOKS[ctx] && APT_HOOKS[ctx][key];
      if (fn) { try { fn(); } catch (e) { if (window.console) console.warn('[Arzuz Admin] tab hook', e && e.message); } }
    }

    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener('click', function () { activate(t.getAttribute('data-apt-tab')); });
    });
    APT_GO[ctx] = activate;
    activate(tabs[0].getAttribute('data-apt-tab') || 'specs');
    return activate;
  }

  /* Segmented control: data-seg carries the value of each button. */
  function initSeg(segId, onChange) {
    var seg = $(segId);
    if (!seg || typeof seg.querySelectorAll !== 'function') return null;
    var btns = seg.querySelectorAll('.seg-btn');
    if (!btns.length) return null;
    var value = null;

    function apply(v, fire) {
      value = v;
      Array.prototype.forEach.call(btns, function (b) {
        var on = b.getAttribute('data-seg') === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (fire && onChange) onChange(v);
    }

    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () { apply(b.getAttribute('data-seg'), true); });
    });
    apply(btns[0].getAttribute('data-seg'), false);

    return {
      get: function () { return value; },
      set: function (v) { apply(v, true); },
      setSilent: function (v) { apply(v, false); }
    };
  }

  /* Amenity combobox / tag input. Presets come from the shared UTILITIES
     list (the Settings → Amenities manager writes to the same source);
     anything typed that is not on the list becomes a custom tag on this
     listing only — promote it in Settings to make it a preset. */
  function initTagField(opts) {
    var field = $(opts.fieldId), box = $(opts.chipsId), input = $(opts.inputId), menu = $(opts.suggestId);
    if (!field || !box || !input) return null;
    var selected = (opts.value || []).slice();
    var hi = -1;

    function presets() { return utilitiesList().map(function (u) { return str(u); }); }
    function has(name) {
      var n = str(name).trim().toLowerCase();
      return selected.some(function (x) { return str(x).trim().toLowerCase() === n; });
    }
    function isCustom(name) {
      var n = str(name).trim().toLowerCase();
      return !presets().some(function (p) { return p.trim().toLowerCase() === n; });
    }
    function matchesFor(q) {
      var query = str(q).trim().toLowerCase();
      var out = [];
      presets().concat(selected).forEach(function (u) {
        var name = str(u);
        if (!name || has(name)) return;
        if (query && name.toLowerCase().indexOf(query) === -1) return;
        if (out.some(function (x) { return x.toLowerCase() === name.toLowerCase(); })) return;
        out.push(name);
      });
      return out.slice(0, 40);
    }
    function sync() {
      if (opts.hiddenId && $(opts.hiddenId)) $(opts.hiddenId).value = JSON.stringify(selected);
      if (opts.onChange) opts.onChange(selected.slice());
    }
    function paintChips() {
      box.innerHTML = selected.map(function (u, i) {
        return '<span class="tag-chip' + (isCustom(u) ? ' custom' : '') + '">' +
          '<span>' + esc(u) + '</span>' +
          '<button type="button" data-tag-remove="' + i + '" title="Remove ' + esc(u) + '" aria-label="Remove ' + esc(u) + '">✕</button>' +
          '</span>';
      }).join('');
    }
    function paintMenu(open) {
      if (!menu) return;
      var q = str(input.value).trim();
      var hits = matchesFor(q);
      var html = hits.slice(0, 8).map(function (u, i) {
        return '<button type="button" role="option" data-tag-pick="' + esc(u) + '"' + (i === hi ? ' class="hi"' : '') + '>' + esc(u) + '</button>';
      }).join('');
      if (q && !has(q) && !hits.some(function (h) { return h.toLowerCase() === q.toLowerCase(); })) {
        html += '<button type="button" role="option" class="tag-new" data-tag-pick="' + esc(q) + '">Create “' + esc(q) + '”</button>';
      }
      if (!html) html = '<button type="button" disabled style="cursor:default;opacity:.6">' + (q ? 'Nothing matches.' : 'All presets are already on this listing.') + '</button>';
      menu.innerHTML = html;
      menu.classList.toggle('open', !!open);
      input.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function add(name) {
      var n = str(name).trim();
      if (n && !has(n)) selected.push(n);
      input.value = '';
      hi = -1;
      paintChips(); sync();
      paintMenu(true);
    }
    function removeAt(i) {
      if (i < 0 || i >= selected.length) return;
      selected.splice(i, 1);
      paintChips(); sync();
      paintMenu(true);
    }

    field.addEventListener('click', function (e) {
      var x = e.target && e.target.closest ? e.target.closest('[data-tag-remove]') : null;
      if (x) { removeAt(parseInt(x.getAttribute('data-tag-remove'), 10)); return; }
      if (e.target === field || e.target === box) input.focus();
    });
    if (menu) {
      menu.addEventListener('mousedown', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-tag-pick]') : null;
        if (!b) return;
        e.preventDefault();
        add(b.getAttribute('data-tag-pick'));
      });
    }
    input.addEventListener('focus', function () { paintMenu(true); });
    input.addEventListener('blur', function () { setTimeout(function () { paintMenu(false); }, 140); });
    input.addEventListener('input', function () { hi = -1; paintMenu(true); });
    input.addEventListener('keydown', function (e) {
      var q = str(input.value).trim();
      var hits = matchesFor(q).slice(0, 8);
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (hi >= 0 && hits[hi]) add(hits[hi]);
        else add(q);
        return;
      }
      if (e.key === 'Backspace' && !q && selected.length) { removeAt(selected.length - 1); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!hits.length) return;
        hi = e.key === 'ArrowDown' ? (hi + 1) % hits.length : (hi <= 0 ? hits.length - 1 : hi - 1);
        paintMenu(true);
        return;
      }
      if (e.key === 'Escape') { paintMenu(false); }
    });

    paintChips();
    paintMenu(false);
    sync();

    return {
      get: function () { return selected.slice(); },
      set: function (list) { selected = (list || []).slice(); paintChips(); sync(); paintMenu(false); }
    };
  }

  /* Downscale + re-encode a phone photo in the browser. A 6 MB HEIC-ish
     JPEG lands around 300–600 KB, which is the difference between a
     usable listing page and a slow one. Any failure (canvas missing,
     the file is already small, a format we must not touch) hands the
     original file straight back. */
  function compressImage(file, cb) {
    var type = str(file && file.type);
    if (!/^image\//.test(type) || /gif|svg|heic|heif/i.test(type)) return cb(file);
    if (typeof URL === 'undefined' || !URL.createObjectURL || typeof Image === 'undefined') return cb(file);
    var url = URL.createObjectURL(file);
    var img = new Image();
    var done = false;
    function bail() {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      cb(file);
    }
    img.onerror = bail;
    img.onload = function () {
      try {
        var MAX = 1920;
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) return bail();
        var scale = Math.min(1, MAX / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx2d = canvas.getContext && canvas.getContext('2d');
        if (!ctx2d) return bail();
        ctx2d.drawImage(img, 0, 0, cw, ch);
        if (!canvas.toBlob) return bail();
        canvas.toBlob(function (blob) {
          if (done) return;
          done = true;
          try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
          if (!blob || blob.size >= file.size) return cb(file);
          var name = str(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
          try { cb(new File([blob], name, { type: 'image/jpeg' })); }
          catch (e) { cb(blob); }
        }, 'image/jpeg', 0.82);
      } catch (e) { bail(); }
    };
    try { img.src = url; } catch (e) { bail(); }
  }

  /* ================= 7. Add Apartment — the composer ================= */

  var addModal = $('addAptModal');
  var exitModal = $('draftExitModal');
  var addTabs = null;
  var addSegAvail = null;
  var addSegMap = null;
  var addMapReady = false;
  var addDirty = false;

  function nextAptId() {
    var max = 0;
    state.data.listings.forEach(function (r) {
      var id = payloadOf(r).apt_id || payloadOf(r).custom_id || '';
      var m = /^APT-(\d+)$/i.exec(str(id).trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'APT-' + String(max + 1).padStart(3, '0');
  }

  /* The name is optional: a readable placeholder is derived from the
     type + area so the browse page never shows a blank card. */
  function autoAptTitle(ty, area) {
    var t = str(ty).trim(), a = str(area).trim();
    if (t && a) return t + ' in ' + a;
    if (a) return 'Apartment in ' + a;
    if (t) return t + ' apartment';
    return 'Untitled apartment';
  }

  /* ---- availability ---- */

  function availabilityState() {
    var mode = addSegAvail ? addSegAvail.get() : 'vacant';
    var raw = $('add_units') ? str($('add_units').value).trim() : '';
    var n = parseInt(raw, 10);
    return { mode: mode, units: (isFinite(n) && n > 0) ? n : null };
  }

  function roomsText(st) {
    if (st.mode === 'occupied') return 'Fully occupied';
    if (!st.units) return 'Units available';
    return st.units + (st.units === 1 ? ' room available' : ' rooms available');
  }

  function syncAvailabilityUi() {
    var mode = addSegAvail ? addSegAvail.get() : 'vacant';
    var wrap = $('addUnitsWrap');
    if (wrap) wrap.style.display = (mode === 'occupied') ? 'none' : '';
    if ($('add_avail')) $('add_avail').value = mode;
  }

  /* ---- the map is built the first time its tab is revealed ---- */

  function setMapMode(mode) {
    var bar = $('adminTraceBar');
    var tgl = $('traceToggle');
    var tracing = !!(bar && bar.classList && bar.classList.contains('tracing'));
    if (tgl) {
      if (mode === 'path' && !tracing) tgl.click();
      else if (mode === 'pin' && tracing) tgl.click();
    }
    if (bar) bar.style.display = (mode === 'path') ? 'flex' : 'none';
  }

  function destroyAdminMap() {
    if (adminPinCapture) { try { adminPinCapture.destroy(); } catch (e) { /* ignore */ } adminPinCapture = null; }
    addMapReady = false;
  }

  /* ---- open / reset ---- */

  function resetComposer() {
    var form = $('addAptForm');
    if (form && typeof form.reset === 'function') form.reset();
    ['add_photo_url', 'add_video_url', 'add_lat', 'add_lng', 'add_pin', 'add_pin_meta'].forEach(function (id) {
      if ($(id)) $(id).value = '';
    });
    ['galAddProgress', 'galAddVideoProgress'].forEach(function (id) {
      var el = $(id);
      if (el) { el.className = 'media-upload-status'; el.textContent = ''; }
    });
    initGalleryManager('add', []);
    if (APT_TAG.add) APT_TAG.add.set([]);
    if (addSegAvail) { addSegAvail.setSilent('vacant'); syncAvailabilityUi(); }
    if (addSegMap) addSegMap.setSilent('pin');
    destroyAdminMap();
    addDirty = false;
    setError('addModalError', '');
  }

  function openAddApt() {
    resetComposer();
    $('add_apt_id').value = nextAptId();
    if (addSegAvail) syncAvailabilityUi();
    if (addTabs) addTabs('specs');
    show(addModal);
  }

  $('btnOpenAddApt').addEventListener('click', openAddApt);

  $('btnCancelAddApt').addEventListener('click', function () {
    if (!addDirty) { hide(addModal); destroyAdminMap(); return; }
    show(exitModal);
  });

  $('btnExitKeep').addEventListener('click', function () { hide(exitModal); });
  $('btnExitDiscard').addEventListener('click', function () {
    hide(exitModal);
    hide(addModal);
    destroyAdminMap();
    addDirty = false;
    if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Changes discarded.', 'info');
  });
  $('btnExitSaveDraft').addEventListener('click', function () {
    hide(exitModal);
    saveApartment(true);
  });

  /* Any edit inside the form arms the unsaved-changes prompt. */
  (function bindAddDirtyWatcher() {
    var form = $('addAptForm');
    if (!form || typeof form.addEventListener !== 'function') return;
    form.addEventListener('input', function () { addDirty = true; }, true);
    form.addEventListener('change', function () { addDirty = true; }, true);
  })();

  /* ---- validation ---- */

  function addProblems() {
    var out = [];
    if (!str($('add_apt_id') ? $('add_apt_id').value : '').trim()) out.push({ id: 'add_apt_id', tab: 'specs', msg: 'Apartment ID / code is required.' });
    if (!str($('add_ar') ? $('add_ar').value : '').trim()) out.push({ id: 'add_ar', tab: 'specs', msg: 'Area / location is required.' });
    if (!str($('add_rent') ? $('add_rent').value : '').trim()) out.push({ id: 'add_rent', tab: 'specs', msg: 'Rent price is required.' });
    return out;
  }

  /* ---- payload ---- */

  /* Shared builder for BOTH save paths: the complete listing and the
     private draft. A draft skips nothing — the admin can still record
     the opening ask and a pin from field notes. */
  function buildAddAptListing(isDraft) {
    var pinVals = adminPinValues();
    var meta = pinVals.meta || {};
    var notes = $('add_access_notes') ? str($('add_access_notes').value).trim() : '';
    var hasRoute = !!(meta.route && meta.route.length > 1);
    var passage = (notes || hasRoute) ? {
      landmark: notes,
      gate: '',
      floor: '',
      steps: [],
      route: meta.route || [],
      route_src: meta.route_src || '',
      route_km: meta.route_km || null,
      route_min: meta.route_min || null
    } : null;

    var avail = availabilityState();
    var area = $('add_ar') ? str($('add_ar').value).trim() : '';
    var name = $('add_prop_name') ? str($('add_prop_name').value).trim() : '';
    var ty = $('add_ty') ? str($('add_ty').value) : '';
    if (!ty && typeof PROPERTY_TYPES !== 'undefined' && PROPERTY_TYPES.length) ty = PROPERTY_TYPES[0];
    var role = $('add_role') ? str($('add_role').value) : '';

    var p = {
      apt_id: str($('add_apt_id').value).trim(),
      custom_id: str($('add_apt_id').value).trim(),
      prop_name: name || autoAptTitle(ty, area),
      name_generated: !name,
      ty: ty,
      ar: area,
      rent: str($('add_rent').value).trim(),
      rm: roomsText(avail),
      avail: avail.mode,
      units: avail.units,
      nm: $('add_nm') ? str($('add_nm').value).trim() : '',
      ph: $('add_ph') ? str($('add_ph').value).trim() : '',
      contact_role: role,
      who: role,
      desc: $('add_desc') ? str($('add_desc').value).trim() : '',
      photo: '',
      video: '',
      video_url: '',
      media: [],
      split_ok: $('add_split_ok') ? !!$('add_split_ok').checked : false,
      ut: [],
      lat: pinVals.lat,
      lng: pinVals.lng,
      pin: pinVals.pin,
      pin_meta: meta || null,
      passage: (passage && ArzuzMap && ArzuzMap.passage.hasContent(passage)) ? passage : null,
      vf: $('add_vf') ? str($('add_vf').value) : ''
    };
    p.ut = APT_TAG.add ? APT_TAG.add.get() : [];
    p.utilities = p.ut.slice();

    /* media gallery → payload.media, with photo/video kept in sync */
    var agl = galList('add');
    p.media = agl.map(function (m) { return { type: m.type, url: m.url, label: m.label || '', credit: m.credit || credit() }; });
    var acover = agl.filter(function (m) { return m.type === 'image'; })[0];
    var atour = agl.filter(function (m) { return m.type === 'video'; })[0];
    p.photo = acover ? acover.url : '';
    p.video = atour ? atour.url : '';
    p.video_url = p.video;

    var listing = {
      session: cfg.SESSION || '2026/2027',
      env: cfg.ENV || 'production',
      source: isDraft ? 'admin_dashboard_draft' : 'admin_dashboard',
      status: isDraft ? 'draft' : ($('add_status') ? $('add_status').value : 'active'),
      tier: parseInt($('add_tier') ? $('add_tier').value : '0', 10) || 0,
      notes: isDraft ? 'Draft — shareable verification link created in the dashboard (' + p.apt_id + ')'
                     : 'Added via Admin Dashboard (' + p.apt_id + ')',
      payload: p
    };
    var askRaw = $('add_ask') ? str($('add_ask').value).trim() : '';
    if (askRaw !== '') {
      var askNum = parseInt(askRaw, 10);
      if (!isNaN(askNum)) listing.opening_ask_ngn = askNum;
    }
    if (isDraft) {
      listing.draft_token = newToken();
      var perm = sharePermSelection();
      listing.draft_permission = perm;
      listing.draft_expires_at = defaultExpiryIso(shareExpiryDays());
    }
    return listing;
  }

  /* ---- insert with a graceful transition path ----
     The permission + expiry columns arrive with
     supabase-draft-sharing.sql. Until that file is run, PostgREST
     rejects the insert with the unknown-column error — we retry once
     without them so draft creation never breaks, and the dashboard
     tells the admin what to run to switch the controls on. */

  function unknownShareColumn(status, body) {
    return status === 400 && /draft_permission|draft_expires_at/.test(str(body));
  }

  function postListing(headers, listing) {
    return fetch(apiRoot() + '/rest/v1/listings', {
      method: 'POST', headers: headers, body: JSON.stringify(listing)
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (body) {
        if (unknownShareColumn(r.status, body)) {
          state.shareSchemaMissing = true;
          var slim = Object.assign({}, listing);
          delete slim.draft_permission;
          delete slim.draft_expires_at;
          return fetch(apiRoot() + '/rest/v1/listings', {
            method: 'POST', headers: headers, body: JSON.stringify(slim)
          }).then(function (r2) {
            if (r2.status === 401 || r2.status === 403) { onAuthError(new Error('Insert rejected')); throw new Error('Your session has expired.'); }
            if (!r2.ok) throw new Error('Insert failed (HTTP ' + r2.status + ')');
            return r2.json();
          });
        }
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Insert rejected')); throw new Error('Your session has expired.'); }
        throw new Error('Insert failed (HTTP ' + r.status + ')');
      });
    });
  }

  function saveApartment(isDraft) {
    var listing = buildAddAptListing(isDraft);
    var p = listing.payload;
    var btn = isDraft ? $('btnSaveDraftApt') : $('btnSaveAddApt');
    if (window.ArzuzUI) ArzuzUI.setBusy(btn, true, isDraft ? 'Creating draft…' : 'Saving…');
    else if (btn) btn.disabled = true;
    setError('addModalError', '');

    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return postListing(h, listing);
    })
      .then(function (created) {
        var inserted = (created && created[0]) ? created[0] : listing;
        state.data.listings.unshift(inserted);
        addDirty = false;
        hide(addModal);
        destroyAdminMap();
        location.hash = '#/listings';
        renderRoute();
        if (state.shareSchemaMissing) warnShareSchema();
        if (isDraft) openShareModal(inserted, true);
        else if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Apartment ' + p.apt_id + ' saved.', 'success');
      })
      .catch(function (err) { setError('addModalError', (isDraft ? 'Could not create the draft: ' : 'Could not save the apartment: ') + err.message); })
      .then(function () { if (window.ArzuzUI) ArzuzUI.setBusy(btn, false); else if (btn) btn.disabled = false; });
  }

  $('btnSaveDraftApt').addEventListener('click', function () {
    var problems = addProblems();
    if (problems.length) {
      if (addTabs) addTabs(problems[0].tab);
      setError('addModalError', problems[0].msg);
      var el = $(problems[0].id);
      if (el && el.focus) el.focus();
      return;
    }
    saveApartment(true);
  });

  $('addAptForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var problems = addProblems();
    if (problems.length) {
      if (addTabs) addTabs(problems[0].tab);
      setError('addModalError', problems[0].msg);
      var el = $(problems[0].id);
      if (el && el.focus) el.focus();
      return;
    }
    saveApartment(false);
  });

  /* ---- wire the composer controls (once) ---- */

  (function initAddComposer() {
    addSegAvail = initSeg('addAvailSeg', function () { syncAvailabilityUi(); });
    var units = $('add_units');
    if (units) units.addEventListener('input', function () { addDirty = true; });
    addSegMap = initSeg('addMapModeSeg', function (mode) { setMapMode(mode); });
    APT_TAG.add = initTagField({
      fieldId: 'addAmenityField', chipsId: 'addAmenityChips',
      inputId: 'addAmenityInput', suggestId: 'addAmenitySuggest'
    });
    var manual = $('add_video_url_manual');
    var addBtn = $('add_video_url_add');
    function embedManualUrl() {
      if (!manual) return;
      var url = str(manual.value).trim();
      if (!url) return;
      /* the same rule the player enforces: a YouTube link or a direct video
         file. A Drive / Photos / Vimeo page would sit in the gallery as a
         black tile forever. */
      if (window.ArzuzVideo && ArzuzVideo.normalizeUrl) url = ArzuzVideo.normalizeUrl(url);
      if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(url)) {
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('That does not look like a link.', 'error');
        return;
      }
      if (window.ArzuzVideo && ArzuzVideo.playbackProblem) {
        var problem = ArzuzVideo.playbackProblem(url);
        if (problem) {
          if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(problem, 'error');
          return;
        }
      }
      var list = galList('add');
      if (!list.some(function (m) { return m.url === url; })) {
        list.push({ type: 'video', url: url, label: 'Video tour', credit: credit() });
        renderGal('add');
        addDirty = true;
      }
      manual.value = '';
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Video tour attached.', 'success');
    }
    if (addBtn) addBtn.addEventListener('click', embedManualUrl);
    if (manual) manual.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); embedManualUrl(); } });

    addTabs = initAptTabs($('addAptModal'), 'add', {
      location: function () {
        if (addMapReady) return;
        addMapReady = true;
        initAdminMap();
        setMapMode(addSegMap ? addSegMap.get() : 'pin');
      }
    });
  })();

  /* ================= 7b. Draft links, permissions & expiry =================
     One token per draft. The link holder is validated server-side by the
     RPCs in supabase-drafts-support.sql; supabase-draft-sharing.sql adds
     the permission (view / edit) and the expiry, and enforces both.
     ------------------------------------------------------------ */

  function draftLink(row) {
    var base = location.origin + location.pathname.replace(/[^\/]*$/, '');
    return base + 'complete-listing.html?ref=' + row.draft_token;
  }

  function draftPermission(row) { return str(row && row.draft_permission) === 'view' ? 'view' : 'edit'; }

  function draftExpired(row) {
    var t = Date.parse(str(row && row.draft_expires_at));
    return isFinite(t) && t < Date.now();
  }

  function expiryLabel(row) {
    var iso = str(row && row.draft_expires_at);
    if (!iso) return 'no expiry';
    var t = Date.parse(iso);
    if (!isFinite(t)) return 'no expiry';
    return (t < Date.now() ? 'expired ' : 'expires ') + fmtDate(iso);
  }

  function defaultExpiryIso(days) {
    var d = parseInt(days, 10);
    if (!isFinite(d) || d <= 0) return null;
    return new Date(Date.now() + d * 86400000).toISOString();
  }

  function sharePermSelection() {
    var picked = 'edit';
    var opts = document.querySelectorAll('#sharePerm input[name="share_perm"]');
    Array.prototype.forEach.call(opts || [], function (r) { if (r.checked) picked = r.value; });
    return picked;
  }

  function shareExpiryDays() {
    var sel = $('shareExpiry');
    return sel ? str(sel.value) : '7';
  }

  function syncSharePermUi() {
    var perm = sharePermSelection();
    var opts = document.querySelectorAll('#sharePerm .share-opt');
    Array.prototype.forEach.call(opts || [], function (o) {
      o.classList.toggle('on', o.getAttribute('data-perm-opt') === perm);
    });
  }

  function shareWaMessage(row) {
    var p = payloadOf(row);
    var name = pick(row, 'property_name', ['prop_name']) || 'your apartment';
    var verb = draftPermission(row) === 'view'
      ? 'review the details we recorded for '
      : 'complete the details for ';
    return 'Hello! Arzuz here 🏠 Here is the link to ' + verb + name +
      '. Open it, check what we have and send it back — no account needed: ' + draftLink(row);
  }

  var shareRow = null;

  function openShareModal(row, created) {
    if (!row) return;
    shareRow = row;
    var perm = draftPermission(row);
    var radios = document.querySelectorAll('#sharePerm input[name="share_perm"]');
    Array.prototype.forEach.call(radios || [], function (r) { r.checked = (r.value === perm); });

    var sel = $('shareExpiry');
    if (sel) {
      var days = 7;
      var iso = str(row.draft_expires_at);
      if (!iso) days = 0;
      else {
        var t = Date.parse(iso);
        if (isFinite(t)) {
          var left = (t - Date.now()) / 86400000;
          days = left <= 0 ? 1 : left <= 1.5 ? 1 : left <= 10 ? 7 : 30;
        }
      }
      sel.value = String(days);
    }
    syncSharePermUi();

    var link = draftLink(row);
    $('inviteLink').value = link;
    $('btnInviteOpen').href = link;
    $('btnInviteWa').onclick = function () {
      var phone = waLink(pick(row, 'owner_phone', ['ph']));
      var text = encodeURIComponent(shareWaMessage(row));
      window.open(phone ? phone + '?text=' + text : 'https://wa.me/?text=' + text, '_blank', 'noopener');
    };

    var p = payloadOf(row);
    var who = (perm === 'view' ? 'View only' : 'Can edit');
    $('inviteMeta').textContent = (created ? 'Draft ' + (p.apt_id || '') + ' created. ' : '') +
      'Currently: ' + who + ' · ' + expiryLabel(row) +
      '. Anyone holding this link can open this one apartment — approve the listing to kill the link.';
    show($('inviteModal'));
  }

  (function bindShareModal() {
    var box = $('sharePerm');
    if (box && typeof box.addEventListener === 'function') {
      box.addEventListener('change', syncSharePermUi);
      box.addEventListener('click', function () { syncSharePermUi(); });
    }
    var sel = $('shareExpiry');
    if (sel && typeof sel.addEventListener === 'function') sel.addEventListener('change', syncSharePermUi);
  })();

  function warnShareSchema() {
    state.shareSchemaMissing = false;
    if (ArzuzSubmit && ArzuzSubmit.showToast) {
      ArzuzSubmit.showToast('Saved — but run supabase-draft-sharing.sql to switch on view-only links and expiry.', 'info');
    }
  }

  function patchShareRow(id, patch, doneMsg) {
    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/listings?id=eq.' + id, { method: 'PATCH', headers: h, body: JSON.stringify(patch) })
        .then(function (r) {
          if (r.ok) return r.json();
          return r.text().then(function (body) {
            if (unknownShareColumn(r.status, body)) {
              state.shareSchemaMissing = true;
              var slim = Object.assign({}, patch);
              delete slim.draft_permission;
              delete slim.draft_expires_at;
              if (!Object.keys(slim).length) return [];
              return fetch(apiRoot() + '/rest/v1/listings?id=eq.' + id, { method: 'PATCH', headers: h, body: JSON.stringify(slim) })
                .then(function (r2) {
                  if (r2.status === 401 || r2.status === 403) { onAuthError(new Error('Draft update rejected')); throw new Error('Your session has expired.'); }
                  if (!r2.ok) throw new Error('HTTP ' + r2.status);
                  return r2.json();
                });
            }
            if (r.status === 401 || r.status === 403) { onAuthError(new Error('Draft update rejected')); throw new Error('Your session has expired.'); }
            throw new Error('HTTP ' + r.status);
          });
        });
    })
      .then(function (updated) {
        var row = findRow('listings', id);
        if (row) {
          if (updated && updated[0]) Object.assign(row, updated[0]);
          Object.assign(row, patch);
        }
        if (state.shareSchemaMissing) warnShareSchema();
        renderRoute();
        if (ArzuzSubmit && ArzuzSubmit.showToast && doneMsg) ArzuzSubmit.showToast(doneMsg, 'success');
        if (shareRow && row && shareRow.id === row.id) openShareModal(row, false);
      })
      .catch(function (err) { alert('Could not update the draft link: ' + err.message); });
  }

  $('btnInviteSave').addEventListener('click', function () {
    if (!shareRow) return;
    var perm = sharePermSelection();
    var days = shareExpiryDays();
    patchShareRow(shareRow.id, {
      draft_permission: perm,
      draft_expires_at: defaultExpiryIso(days)
    }, 'Draft permissions saved.');
  });

  function copyDraftLink(table, id) {
    var row = findRow(table, id);
    if (!row || !row.draft_token) return;
    var link = draftLink(row);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Draft link copied.', 'success');
      }, function () { window.prompt('Copy this link:', link); });
    } else window.prompt('Copy this link:', link);
  }

  $('btnInviteCopy').addEventListener('click', function () {
    var link = $('inviteLink').value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Draft link copied.', 'success');
      }, function () { window.prompt('Copy this link:', link); });
    } else window.prompt('Copy this link:', link);
  });

  function rotateDraftLink(table, id) {
    if (!confirm('Generate a NEW link? The old one stops working immediately.')) return;
    patchDraftRow(table, id, { draft_token: newToken(), draft_completed_at: null, draft_last_saved_at: null },
      'New draft link generated — the old one is dead.');
  }

  function revokeDraftLink(table, id) {
    if (!confirm('Revoke this link? Nobody can open or edit the draft any more.')) return;
    patchDraftRow(table, id, { draft_token: null }, 'Draft link revoked.');
  }

  function patchDraftRow(table, id, patch, doneMsg) {
    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/' + table + '?id=eq.' + id, { method: 'PATCH', headers: h, body: JSON.stringify(patch) });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Draft update rejected')); throw new Error('Your session has expired.'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (updated) {
        var row = findRow(table, id);
        if (row && updated && updated[0]) Object.assign(row, updated[0]);
        renderRoute();
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(doneMsg, 'success');
      })
      .catch(function (err) { alert('Could not update the draft: ' + err.message); });
  }

  /* ================= 8. Media upload + lightboxes =================
     Photos and any Cloudinary fallback use the signed upload (with a
     real progress bar via XHR); video tours go to YouTube (unlisted)
     with live progress and fall back to Cloudinary. */

  function cloudinaryXhr(endpoint, fd, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = function () {
        var body = str(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('Cloudinary rejected the upload: ' + body.slice(0, 180)));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Cloudinary returned an unreadable response.')); }
      };
      xhr.onerror = function () { reject(new Error('Network error while uploading.')); };
      xhr.onabort = function () { reject(new Error('Upload cancelled.')); };
      xhr.send(fd);
    });
  }

  function uploadMediaToCloudinary(file, resourceType, statusElId, onDone, onProgress, onError) {
    var statusEl = $(statusElId);
    var kind = resourceType === 'video' ? 'video tour' : 'photo';
    var fail = function (msg) {
      if (statusEl) { statusEl.className = 'media-upload-status error'; statusEl.textContent = msg; }
      if (onError) onError(msg);
    };
    if (statusEl) { statusEl.className = 'media-upload-status uploading'; statusEl.textContent = 'Preparing the signed upload…'; }
    fetch('/api/cloudinary-sign', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('Could not get an upload signature (HTTP ' + r.status + ')'); return r.json(); })
      .then(function (sig) {
        if (statusEl) statusEl.textContent = 'Uploading ' + kind + '…';
        var fd = new FormData();
        fd.append('file', file);
        fd.append('api_key', sig.api_key);
        fd.append('timestamp', sig.timestamp);
        fd.append('signature', sig.signature);
        fd.append('folder', sig.folder);
        /* every param inside the signature must also be sent, or
           Cloudinary rejects the upload with an invalid signature */
        fd.append('eager', sig.eager);
        if (sig.max_file_size) fd.append('max_file_size', sig.max_file_size);
        if (sig.context) fd.append('context', sig.context);
        var endpoint = 'https://api.cloudinary.com/v1_1/' + sig.cloud_name + '/' + (resourceType === 'video' ? 'video' : 'image') + '/upload';
        return cloudinaryXhr(endpoint, fd, onProgress);
      })
      .then(function (data) {
        if (statusEl) { statusEl.className = 'media-upload-status success'; statusEl.textContent = 'Uploaded!'; }
        onDone(data.secure_url);
      })
      .catch(function (err) { fail('Upload failed: ' + err.message); });
  }

  /* Videos go to YouTube (unlisted) with a live progress bar; if YouTube
     cannot take it (not configured, quota, network) fall back to the
     Cloudinary video path. */
  function uploadMedia(file, resourceType, statusElId, onDone, onProgress, onError) {
    var statusEl = $(statusElId);
    if (resourceType !== 'video' || !window.ArzuzVideo || file.size > ArzuzVideo.MAX_BYTES) {
      return uploadMediaToCloudinary(file, resourceType, statusElId, onDone, onProgress, onError);
    }
    if (statusEl) { statusEl.className = 'media-upload-status uploading'; statusEl.textContent = 'Preparing the video upload…'; }
    ArzuzVideo.uploadVideoToYouTube(file, {
      onProgress: function (p) {
        var pct = (p && p.percent) || 0;
        if (onProgress) onProgress(pct);
        if (!statusEl) return;
        statusEl.className = 'media-upload-status uploading';
        if (p.phase === 'uploading') statusEl.innerHTML = ArzuzVideo.progressHTML(p);
        else if (p.phase === 'processing') statusEl.textContent = 'Uploaded — processing the video…';
        else statusEl.textContent = 'Preparing the video upload…';
      }
    }).then(function (url) {
      if (statusEl) { statusEl.className = 'media-upload-status success'; statusEl.textContent = 'Uploaded!'; }
      onDone(url);
    }).catch(function (err) {
      if (window.console) console.warn('[Arzuz] YouTube upload unavailable, falling back to Cloudinary:', err.message);
      uploadMediaToCloudinary(file, 'video', statusElId, onDone, onProgress, onError);
    });
  }

  /* gallery + staged thumbnails: YouTube items show their public poster
     frame; direct files keep the inline <video> preview */
  function mediaThumbHTML(url) {
    if (window.ArzuzVideo && ArzuzVideo.parseYouTube(url)) {
      return '<img src="' + esc(ArzuzVideo.thumb(url)) + '" alt="" loading="lazy">';
    }
    return '<video src="' + esc(url) + '" muted preload="metadata"></video>';
  }

  window.openPhotoLightbox = function (url) {
    $('lightboxImg').src = url;
    show($('photoLightbox'));
  };
  $('photoLightbox').addEventListener('click', function () { hide($('photoLightbox')); });

  window.openVideoLightbox = function (url) {
    var box = $('videoLightboxContainer');
    if (window.ArzuzVideo && ArzuzVideo.parseYouTube(url)) {
      /* masked player — the same chrome visitors see; a previous player
         must be torn down or it keeps polling a detached iframe */
      ArzuzVideo.stopIn(box);
      box.innerHTML = '';
      ArzuzVideo.mountPlayer(box, url, { autoplay: true });
    } else {
      box.innerHTML = '<video src="' + esc(url) + '" controls autoplay></video>';
    }
    show($('videoLightbox'));
  };
  function closeVideoLightbox() {
    if (window.ArzuzVideo) ArzuzVideo.stopIn($('videoLightboxContainer'));
    $('videoLightboxContainer').innerHTML = '';
    hide($('videoLightbox'));
  }
  window.closeVideoLightbox = closeVideoLightbox;
  $('videoLightboxClose').addEventListener('click', closeVideoLightbox);

  /* ================= 8b. Media queue: stage → compress → upload =================
     One queue per surface ('add' | 'edit'). GAL[ctx] holds the media
     that is actually saved (the source of truth for payload.media);
     GAL_STAGE[ctx] holds tiles still in flight, so the admin sees the
     photo the instant it is picked, can drop it again, and watches a
     real percentage as it uploads. The hidden photo/video fields stay
     in sync so every older code path keeps working. */

  var GAL = { add: [], edit: [] };
  var GAL_STAGE = { add: [], edit: [] };

  function galList(ctx) { return GAL[ctx] || (GAL[ctx] = []); }
  function galStage(ctx) { return GAL_STAGE[ctx] || (GAL_STAGE[ctx] = []); }

  /* every asset gets the same copyright credit object */
  function credit() {
    return { holder: 'Arzuz', year: new Date().getFullYear(), note: 'Verified apartment media' };
  }

  function seedMedia(p, photoUrl, videoUrl) {
    var out = [];
    if (Array.isArray(p.media)) {
      p.media.forEach(function (m) {
        if (m && m.url) out.push({ type: m.type === 'video' ? 'video' : 'image', url: String(m.url), label: m.label || '', credit: m.credit || credit() });
      });
    }
    if (!out.length && photoUrl) out.push({ type: 'image', url: photoUrl, label: 'Cover photo', credit: credit() });
    if (!out.length && videoUrl) out.push({ type: 'video', url: videoUrl, label: 'Video tour', credit: credit() });
    return out;
  }

  function syncGalHidden(ctx) {
    var list = galList(ctx);
    var cover = list.filter(function (m) { return m.type === 'image'; })[0];
    var tour = list.filter(function (m) { return m.type === 'video'; })[0];
    var ph = $(ctx === 'add' ? 'add_photo_url' : 'edit_photo');
    var vi = $(ctx === 'add' ? 'add_video_url' : 'edit_video');
    if (ph) ph.value = cover ? cover.url : '';
    if (vi) vi.value = tour ? tour.url : '';
  }

  function stageTileHtml(it) {
    var isVideo = it.type === 'video';
    var thumb = it.preview
      ? (isVideo ? '<video src="' + esc(it.preview) + '" muted preload="metadata"></video>'
                 : '<img src="' + esc(it.preview) + '" alt="" loading="lazy">')
      : '<div style="aspect-ratio:4/3;background:rgba(255,255,255,.05)"></div>';
    var label = it.status === 'failed' ? 'Failed — remove'
      : it.status === 'uploading' ? (it.pct > 0 ? it.pct + '%' : 'Uploading…')
      : it.status === 'done' ? 'Uploaded'
      : 'Queued';
    return '<div class="stage-th' + (it.status === 'failed' ? ' is-failed' : '') + (it.status === 'done' ? ' is-done' : '') + '" data-sid="' + esc(it.id) + '">' +
      thumb +
      '<span class="stage-kind">' + ico(isVideo ? 'video' : 'image', 12) + '</span>' +
      '<button type="button" class="stage-x" data-stage="drop" data-ctx="' + it.ctx + '" data-sid="' + esc(it.id) + '" title="Remove">' + ico('x', 11) + '</button>' +
      (it.status === 'done' ? '' :
        '<span class="stage-pct">' + esc(label) + '</span>' +
        '<span class="stage-bar"><i style="width:' + (it.status === 'failed' ? 100 : (it.pct || 0)) + '%"></i></span>') +
      '</div>';
  }

  function renderGal(ctx) {
    var grid = $(ctx === 'add' ? 'galAddGrid' : 'galEditGrid');
    if (!grid) return;
    var list = galList(ctx), stage = galStage(ctx);
    if (!list.length && !stage.length) {
      grid.innerHTML = '<p class="stage-empty">No media yet. The first photo you upload becomes the cover students see on the browse page.</p>';
      syncGalHidden(ctx);
      return;
    }
    var firstImg = list.filter(function (m) { return m.type === 'image'; })[0];
    var html = stage.map(stageTileHtml).join('');
    html += list.map(function (m, i) {
      var isCover = (m === firstImg);
      var thumb = (m.type === 'video')
        ? mediaThumbHTML(m.url) + '<span class="gal-kind">' + ico('video', 12) + '</span>'
        : '<img src="' + esc(m.url) + '" alt="" loading="lazy"><span class="gal-kind">' + ico('image', 12) + '</span>';
      var coverBtn = (m.type === 'image')
        ? '<button type="button" class="stage-cover-btn' + (isCover ? ' is-cover' : '') + '" data-gal="cover" data-ctx="' + ctx + '" data-i="' + i + '" title="Use as the cover photo">' +
          ico('star', 11) + (isCover ? ' Cover photo' : ' Set as cover') + '</button>'
        : '';
      return '<div class="stage-th">' + thumb +
        '<button type="button" class="stage-x" data-gal="del" data-ctx="' + ctx + '" data-i="' + i + '" title="Remove">' + ico('x', 11) + '</button>' +
        coverBtn +
        '<input type="text" class="gal-lbl" data-gal="label" data-ctx="' + ctx + '" data-i="' + i + '" value="' + esc(m.label || '') + '" placeholder="Label (optional)" maxlength="48">' +
        '</div>';
    }).join('');
    grid.innerHTML = html;
    syncGalHidden(ctx);
  }

  function stageProgressTick(item) {
    var tile = document.querySelector('.stage-th[data-sid="' + item.id + '"]');
    if (!tile) return;
    var bar = tile.querySelector('.stage-bar i');
    if (bar) bar.style.width = (item.pct || 0) + '%';
    var pctEl = tile.querySelector('.stage-pct');
    if (pctEl) pctEl.textContent = item.pct > 0 ? item.pct + '%' : 'Uploading…';
  }

  function stageFiles(ctx, files, kind) {
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    var prog = $(ctx === 'add'
      ? (kind === 'video' ? 'galAddVideoProgress' : 'galAddProgress')
      : (kind === 'video' ? 'galEditVideoProgress' : 'galEditProgress'));
    var total = arr.length, done = 0, failed = 0;

    function report() {
      if (!prog) return;
      if (done + failed >= total) {
        prog.className = 'media-upload-status ' + (failed ? 'error' : 'success');
        prog.textContent = failed
          ? (done + ' uploaded, ' + failed + ' failed')
          : done + ' ' + (kind === 'video' ? (done === 1 ? 'video' : 'videos') : (done === 1 ? 'photo' : 'photos')) + ' uploaded';
      } else {
        prog.className = 'media-upload-status uploading';
        prog.textContent = 'Uploading ' + (done + failed + 1) + ' of ' + total + '…';
      }
    }

    arr.forEach(function (file, idx) {
      var item = {
        id: 'st' + Date.now().toString(36) + idx + Math.random().toString(36).slice(2, 6),
        ctx: ctx,
        type: kind === 'video' ? 'video' : 'image',
        preview: '',
        status: 'queued',
        pct: 0
      };
      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        try { item.preview = URL.createObjectURL(file); } catch (e) { item.preview = ''; }
      }
      galStage(ctx).push(item);
      renderGal(ctx);
      report();

      var send = function (f) {
        item.status = 'uploading';
        stageProgressTick(item);
        uploadMedia(f, kind, null, function (url) {
          item.status = 'done';
          item.pct = 100;
          galList(ctx).push({ type: kind === 'video' ? 'video' : 'image', url: url, label: '', credit: credit() });
          if (item.preview && URL.revokeObjectURL) { try { URL.revokeObjectURL(item.preview); } catch (e) { /* ignore */ } }
          var at = galStage(ctx).indexOf(item);
          if (at !== -1) galStage(ctx).splice(at, 1);
          done++;
          renderGal(ctx);
          report();
        }, function (pct) {
          item.pct = pct;
          stageProgressTick(item);
        }, function () {
          item.status = 'failed';
          failed++;
          renderGal(ctx);
          report();
        });
      };

      /* photos are downscaled first — it happens on the picker's own
         thread step so the tile is already on screen */
      if (kind === 'image') compressImage(file, send);
      else send(file);
    });
  }

  function initGalleryManager(ctx, seed) {
    GAL[ctx] = (seed || []).slice();
    GAL_STAGE[ctx] = [];
    var zone = $(ctx === 'add' ? 'galAddZone' : 'galEditZone');
    var input = $(ctx === 'add' ? 'galAddInput' : 'galEditInput');
    var vzone = $(ctx === 'add' ? 'galAddVideoZone' : 'galEditVideoZone');
    var vinput = $(ctx === 'add' ? 'galAddVideoInput' : 'galEditVideoInput');

    if (zone && input) {
      zone.onclick = function () { input.click(); };
      input.onchange = function () { stageFiles(ctx, input.files, 'image'); input.value = ''; };
      bindDropZone(zone, ctx, 'image');
    }
    if (vzone && vinput) {
      vzone.onclick = function () { vinput.click(); };
      vinput.onchange = function () { stageFiles(ctx, vinput.files, 'video'); vinput.value = ''; };
      bindDropZone(vzone, ctx, 'video');
    }
    renderGal(ctx);
  }

  /* drag & drop onto either zone */
  function bindDropZone(zone, ctx, kind) {
    if (!zone || typeof zone.addEventListener !== 'function') return;
    ['dragenter', 'dragover'].forEach(function (t) {
      zone.addEventListener(t, function (e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        zone.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (t) {
      zone.addEventListener(t, function () { zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) stageFiles(ctx, files, kind);
    });
  }

  /* queue + committed controls — delegated (the grid is re-rendered) */
  document.addEventListener('click', function (e) {
    var drop = e.target && e.target.closest ? e.target.closest('[data-stage="drop"]') : null;
    if (drop) {
      var ctxS = drop.dataset.ctx, sid = drop.dataset.sid;
      var stage = galStage(ctxS);
      var at = -1;
      stage.forEach(function (it, i) { if (it.id === sid) at = i; });
      if (at !== -1) {
        if (stage[at].preview && typeof URL !== 'undefined' && URL.revokeObjectURL) {
          try { URL.revokeObjectURL(stage[at].preview); } catch (e2) { /* ignore */ }
        }
        stage.splice(at, 1);
        renderGal(ctxS);
      }
      return;
    }
    var b = e.target && e.target.closest ? e.target.closest('[data-gal]') : null;
    if (!b) return;
    var act = b.dataset.gal, ctx = b.dataset.ctx, i = parseInt(b.dataset.i, 10);
    var list = galList(ctx);
    if (isNaN(i) || !list[i]) return;
    if (act === 'del') {
      var removed = list.splice(i, 1)[0];
      if (removed && removed.preview && typeof URL !== 'undefined' && URL.revokeObjectURL) { try { URL.revokeObjectURL(removed.preview); } catch (e3) { /* ignore */ } }
    } else if (act === 'cover') {
      var m = list.splice(i, 1)[0];
      list.unshift(m);
    } else return;
    renderGal(ctx);
  });
  document.addEventListener('input', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-gal="label"]') : null;
    if (!b) return;
    var list = galList(b.dataset.ctx), i = parseInt(b.dataset.i, 10);
    if (list[i]) list[i].label = str(b.value).slice(0, 48);
  });

  /* ================= 9. Map pin — via ArzuzMap ================= */

  var adminPinCapture = null;
  var editPinCapture = null;

  function readPinMeta(id) {
    var el = $(id);
    if (!el || !el.value) return null;
    try { return JSON.parse(el.value); } catch (e) { return null; }
  }

  /* Reads the hidden inputs the shared widget maintains. */
  function adminPinValues() {
    return {
      lat: $('add_lat') ? str($('add_lat').value).trim() || null : null,
      lng: $('add_lng') ? str($('add_lng').value).trim() || null : null,
      pin: $('add_pin') ? str($('add_pin').value).trim() || null : null,
      meta: readPinMeta('add_pin_meta')
    };
  }

  function initAdminMap() {
    if (typeof ArzuzMap === 'undefined') return;
    var mapEl = $('admin-leaflet-map');
    if (!mapEl) return;
    if (adminPinCapture) { try { adminPinCapture.destroy(); } catch (e) { /* ignore */ } adminPinCapture = null; }

    var start = adminPinValues();
    adminPinCapture = ArzuzMap.pinCapture({
      containerId: 'admin-leaflet-map',
      layerSwitchId: 'adminMapLayerSwitcher',
      coordsBadgeId: 'adminMapCoordsText',
      locateBtnId: 'adminBtnLocateMe',
      statusBoxId: 'adminMapStatus',
      tipBannerId: 'adminMapNote',
      startGps: false,
      trace: true,
      traceBarId: 'adminTraceBar',
      traceSource: 'traced',
      existingRoute: (start.meta && start.meta.route) || null,
      lat: start.lat,
      lng: start.lng,
      onPin: function (lat, lng, meta) {
        /* merge instead of replace: tracing the road re-commits the pin
           and must not wipe the source / accuracy the GPS or tap set */
        var merged = Object.assign({}, readPinMeta('add_pin_meta') || {}, meta || {});
        var la = $('add_lat'), ln = $('add_lng'), pn = $('add_pin'), mt = $('add_pin_meta');
        if (la) la.value = lat;
        if (ln) ln.value = lng;
        if (pn) pn.value = lat.toFixed(6) + ',' + lng.toFixed(6);
        if (mt) mt.value = JSON.stringify(merged);
        var badge = $('adminMapCoordsText');
        if (badge && !(meta && meta.route)) {
          badge.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
          badge.classList.add('set');
        }
      },
      /* a traced walk path with no pin yet: keep the route, add no position */
      onRoute: function (meta) {
        var merged = Object.assign({}, readPinMeta('add_pin_meta') || {}, meta || {});
        var mt = $('add_pin_meta');
        if (mt) mt.value = JSON.stringify(merged);
      }
    });
  }

  /* ---- the Edit-modal map: built when its tab is first revealed ---- */

  var editPassageEditor = null;   /* scout reports only — listings use access notes */
  var editMapReady = false;
  var editMapMode = null;

  function destroyEditMap() {
    if (editPinCapture) { try { editPinCapture.destroy(); } catch (e) { /* ignore */ } editPinCapture = null; }
    if (editPassageEditor) { try { editPassageEditor.destroy(); } catch (e) { /* ignore */ } editPassageEditor = null; }
    editMapReady = false;
  }
  /* the Edit-modal cancel button still calls the old name */
  var destroyEditMapAndPassage = destroyEditMap;

  function setEditMapMode(mode) {
    var bar = $('editTraceBar');
    var tgl = $('editTraceToggle');
    var tracing = !!(bar && bar.classList && bar.classList.contains('tracing'));
    if (tgl) {
      if (mode === 'path' && !tracing) tgl.click();
      else if (mode === 'pin' && tracing) tgl.click();
    }
    if (bar) bar.style.display = (mode === 'path') ? 'flex' : 'none';
  }

  function initEditListingMap(row) {
    if (typeof ArzuzMap === 'undefined') return;
    if (editPinCapture) { try { editPinCapture.destroy(); } catch (e) { /* ignore */ } editPinCapture = null; }
    var lp = payloadOf(row);
    var lat = row.latitude || lp.lat || '';
    var lng = row.longitude || lp.lng || '';
    editPinCapture = ArzuzMap.pinCapture({
      containerId: 'editLeafletMap',
      layerSwitchId: 'editMapLayerSwitcher',
      coordsBadgeId: 'editMapCoordsText',
      locateBtnId: 'editBtnLocateMe',
      statusBoxId: 'editMapStatus',
      tipBannerId: null,
      startGps: false,
      trace: true,
      traceBarId: 'editTraceBar',
      traceToggleId: 'editTraceToggle',
      traceUndoId: 'editTraceUndo',
      traceClearId: 'editTraceClear',
      traceCountId: 'editTraceCount',
      traceSource: 'traced',
      existingRoute: (lp.passage && lp.passage.route) || null,
      lat: lat || null,
      lng: lng || null,
      onPin: function (la, ln, meta) {
        var merged = Object.assign({}, readPinMeta('edit_pin_meta') || {}, meta || {});
        var latEl = $('edit_lat'), lngEl = $('edit_lng'), metaEl = $('edit_pin_meta');
        if (latEl) latEl.value = la;
        if (lngEl) lngEl.value = ln;
        if (metaEl) metaEl.value = JSON.stringify(merged);
        var badge = $('editMapCoordsText');
        if (badge && !(meta && meta.route)) {
          badge.textContent = la.toFixed(5) + ', ' + ln.toFixed(5);
          badge.classList.add('set');
        }
      },
      /* a traced walk path with no pin yet: keep the route, add no position */
      onRoute: function (meta) {
        var merged = Object.assign({}, readPinMeta('edit_pin_meta') || {}, meta || {});
        var metaEl = $('edit_pin_meta');
        if (metaEl) metaEl.value = JSON.stringify(merged);
      }
    });
    setEditMapMode(editMapMode ? editMapMode.get() : 'pin');
  }

/* ================= 10. Details modal ================= */

  function kv(label, valueHtml, full) {
    return '<div class="details-kv-item"' + (full ? ' style="grid-column:1/-1"' : '') + '><div class="details-kv-lbl">' + esc(label) + '</div><div class="details-kv-val">' + valueHtml + '</div></div>';
  }

  window.openDetailsModal = function (table, id) {
    var row = (state.data[table] || []).find(function (r) { return r.id === id; });
    if (!row) return;
    state.detail = { table: table, id: id };
    var p = payloadOf(row);

    $('detailsModalTitle').textContent = table === 'demand_records' ? 'Student Need Details' : table === 'listings' ? 'Apartment & Hostel Details' : 'Scout Submission Details';
    $('detailsModalBadge').textContent = str(row.status || 'open').toUpperCase();

    var html = '<div class="details-kv-grid">';
    html += kv('Record ID', '<span style="font-family:var(--mono);font-size:12px">' + esc(row.id) + '</span>');
    html += kv('Created At', esc(fmtDate(row.created_at)));
    html += kv('Status', statusTag(row.status));
    if (row.notes) html += kv('Admin Notes', esc(row.notes), true);
    if (row.source) html += kv('Source', esc(row.source));
    if (row.tier !== undefined && table === 'listings') html += kv('Tier', 'Tier ' + esc(row.tier));

    if (table === 'demand_records') {
      html += kv('Full Name', '<b>' + esc(pick(row, 'first_name', ['first'])) + ' ' + esc(p.last || '') + '</b>');
      html += kv('Phone / WhatsApp', esc(pick(row, 'phone', ['phone']) || '—'));
      html += kv('Room Type Needed', esc(pick(row, 'room_type', ['type']) || '—'));
      html += kv('Budget Band', esc(pick(row, 'budget_band', ['budget']) || '—'));
      html += kv('Distance to Campus', esc(pick(row, 'distance', ['dist']) || '—'));
      html += kv('Needed When', esc(pick(row, 'timing', ['when']) || '—'));
      html += kv('Age Group', esc(p.age || pick(row, 'age_band', []) || '—'));
      if (p.g_phone) html += kv('Guardian Contact', esc((p.g_name || 'Guardian') + ' — ' + p.g_phone));
      if (p.pain) html += kv('Current Housing Feedback', esc(p.pain), true);
    } else if (table === 'listings') {
      var aptId = p.apt_id || p.custom_id || shortId(row.id);
      /* pin quality — tells the verifier how much to trust the pin */
      var pm = p.pin_meta || {};
      if (p.pin || row.latitude) {
        var srcLabel = { gps: 'Live GPS', tapped: 'Tapped', dragged: 'Dragged', admin: 'Restored' }[pm.source] || 'Placed';
        var accTxt = pm.accuracy_m != null ? ' ±' + pm.accuracy_m + 'm' : '';
        html += kv('Pin Quality', srcLabel + accTxt + (pm.samples ? ' · ' + pm.samples + ' samples' : ''));
      }
      if (ArzuzMap && ArzuzMap.passage.hasContent(p.passage)) {
        html += kv('Passage', esc(ArzuzMap.passage.summarise(p.passage)), true);
      }
      html += kv('Apartment ID', '<span class="apt-badge-id">' + esc(aptId) + '</span>');
      if (str(row.status).toLowerCase() === 'draft') {
        html += kv('Invite Link', row.draft_token
          ? '<span style="font-family:var(--mono);font-size:11px;word-break:break-all">' + esc(draftLink(row)) + '</span>'
          : '<span class="muted-cell">revoked</span>');
        html += kv('Landlord Completed', row.draft_completed_at ? esc(fmtDate(row.draft_completed_at)) : '<span class="muted-cell">not yet</span>');
        if (row.draft_last_saved_at) html += kv('Last Saved', esc(fmtDate(row.draft_last_saved_at)));
      }
      html += kv('Property / Lodge Name', esc(pick(row, 'property_name', ['prop_name']) || '—'));
      html += kv('Owner / Caretaker', esc(pick(row, 'owner_name', ['nm']) || '—') + (p.last ? ' ' + esc(p.last) : ''));
      html += kv('Contact Phone', esc(pick(row, 'owner_phone', ['ph']) || '—'));
      html += kv('Property Type', esc(pick(row, 'property_type', ['ty']) || '—'));
      html += kv('Area / Street', esc(pick(row, 'area', ['ar']) || '—'));
      if (row.opening_ask_ngn != null) html += kv('Opening Ask', ngn(row.opening_ask_ngn));
      html += kv('Price / Session', ngn(pick(row, 'listed_price_ngn', ['rent'])));
      html += kv('Units Available', esc(pick(row, 'rooms', ['rm']) || '—'));
      html += kv('Who Runs It', esc(p.who || '—'));
      if (p.neg) html += kv('Negotiable', esc(p.neg));
      var utList = toList(p.ut || p.utilities);
      if (utList.length) {
        html += kv('Verified Utilities & Amenities',            utList.map(function (u) { return '<span class="admin-chip active" style="font-size:11.5px;padding:3px 10px">' + ico('check', 11) + ' ' + esc(u) + '</span>'; }).join(''), true);
      }
      if (p.desc || p.description) html += kv('Description', esc(p.desc || p.description), true);
      var photoUrl = pick(row, 'photo_url', ['photo']);
      if (photoUrl) html += kv('Photo', '<img class="details-media" src="' + esc(photoUrl) + '" alt="Listing photo" data-act="photo" data-url="' + esc(photoUrl) + '">', true);
      var videoUrl = p.video || p.video_url;
      if (videoUrl)        html += kv('Video Tour', '<button type="button" class="act-btn act-video" style="padding:8px 14px;margin-top:4px" onclick="window.openVideoLightbox(\'' + esc(videoUrl) + '\')">Play Video Tour</button>', true);
    } else if (table === 'scout_submissions') {
      html += kv('Area / Street', esc(pick(row, 'area', ['area']) || '—'));
      html += kv('Rent Paid', ngn(pick(row, 'rent_reported', ['amt'])));
      html += kv('Scout Phone', esc(pick(row, 'scout_phone', ['phone']) || '—'));
      html += kv('Vacancy Signal', esc(pick(row, 'vacancy_signal', ['vac']) || '—'));
      html += kv('Rent Collected By', esc(p.who || '—'));
      var spm = p.pin_meta || {};
      if (p.pin || row.latitude) {
        var sSrc = { gps: 'Live GPS', tapped: 'Tapped', dragged: 'Dragged', admin: 'Restored' }[spm.source] || 'Placed';
        html += kv('Pin Quality', sSrc + (spm.accuracy_m != null ? ' ±' + spm.accuracy_m + 'm' : ''));
      }
      if (ArzuzMap && ArzuzMap.passage.hasContent(p.passage)) {
        html += kv('Passage', esc(ArzuzMap.passage.summarise(p.passage)), true);
      }
      var scoutPhoto = pick(row, 'photo_url', ['photo']);
      if (scoutPhoto) html += kv('Building Photo', '<img class="details-media" src="' + esc(scoutPhoto) + '" alt="Building photo" data-act="photo" data-url="' + esc(scoutPhoto) + '">', true);
    }

    html += '</div>';
    $('detailsModalContent').innerHTML = html;
    show($('detailsModal'));
  };

  $('btnCloseDetails').addEventListener('click', function () { hide($('detailsModal')); });
  $('btnEditFromDetails').addEventListener('click', function () {
    if (state.detail) { hide($('detailsModal')); openEditModal(state.detail.table, state.detail.id); }
  });

  /* ================= 11. Delete confirmation ================= */

  var delModal = $('delModal');

  window.openDeleteModal = function (table, id) {
    var row = (state.data[table] || []).find(function (r) { return r.id === id; });
    if (!row) return;
    state.pendingDelete = { table: table, id: id };
    var p = payloadOf(row);

    var title, sub, photoUrl;
    if (table === 'demand_records') {
      title = (pick(row, 'first_name', ['first']) || 'Student') + (p.last ? ' ' + p.last : '');
      sub = (pick(row, 'room_type', ['type']) || '—') + ' · ' + (pick(row, 'budget_band', ['budget']) || '—') + ' · ' + fmtDate(row.created_at);
      photoUrl = '';
    } else if (table === 'listings') {
      title = pick(row, 'property_name', ['prop_name']) || 'Unnamed property';
      sub = (p.apt_id || shortId(id)) + ' · ' + (pick(row, 'area', ['ar']) || '—') + ' · ' + ngn(pick(row, 'listed_price_ngn', ['rent'])) + ' · ' + fmtDate(row.created_at);
      photoUrl = pick(row, 'photo_url', ['photo']);
    } else {
      title = pick(row, 'area', ['area']) || 'Building';
      sub = ngn(pick(row, 'rent_reported', ['amt'])) + ' · ' + (pick(row, 'vacancy_signal', ['vac']) || '—') + ' · ' + fmtDate(row.created_at);
      photoUrl = pick(row, 'photo_url', ['photo']);
    }

    $('delSummary').innerHTML =
      (photoUrl ? '<img src="' + esc(photoUrl) + '" alt="">' : '<div class="del-fallback" >' + ico('clipboard', 24) + '</div>') +
      '<div class="dt"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span>' +
      '<span style="margin-top:4px"><span class="apt-badge-id">' + esc(shortId(id)) + '</span> ' + statusTag(row.status) + '</span></div>';

    $('delConfirmInput').value = '';
    var delCode = $('delConfirmId');
    if (delCode) delCode.textContent = shortId(id);
    $('btnConfirmDel').disabled = true;
    setError('delModalError', '');
    show(delModal);
    setTimeout(function () { $('delConfirmInput').focus(); }, 60);
  };

  $('delConfirmInput').addEventListener('input', function () {
    $('btnConfirmDel').disabled = this.value.trim().toUpperCase() !== shortId(state.pendingDelete && state.pendingDelete.id).toUpperCase();
  });

  $('btnCancelDel').addEventListener('click', function () {
    hide(delModal);
    state.pendingDelete = null;
  });

  $('btnConfirmDel').addEventListener('click', function () {
    if (!state.pendingDelete) return;
    var table = state.pendingDelete.table, id = state.pendingDelete.id;
    var btn = $('btnConfirmDel');
    btn.textContent = 'Deleting…';
    btn.disabled = true;
    setError('delModalError', '');

    ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/' + table + '?id=eq.' + id, { method: 'DELETE', headers: h });
    })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { onAuthError(new Error('Delete rejected')); throw new Error('Your session has expired.'); }
        if (!res.ok) throw new Error('Deletion failed (HTTP ' + res.status + ')');
        state.data[table] = (state.data[table] || []).filter(function (r) { return r.id !== id; });
        hide(delModal);
        state.pendingDelete = null;
        renderRoute();
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Record deleted.', 'info');
      })
      .catch(function (err) { setError('delModalError', 'Could not delete record: ' + err.message); })
      .finally(function () { btn.textContent = 'Yes, Delete'; btn.disabled = false; });
  });

  /* ================= Esc / backdrop close ================= */

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    [addModal, editModal, $('detailsModal'), delModal, $('photoLightbox'), $('videoLightbox')].forEach(function (m) {
      if (m && m.classList.contains('open')) {
        if (m === $('videoLightbox')) closeVideoLightbox();
        else hide(m);
      }
    });
    if (state.pendingDelete) state.pendingDelete = null;
  });
  [addModal, editModal, $('detailsModal'), delModal].forEach(function (m) {
    if (m) m.addEventListener('click', function (e) { if (e.target === m) { hide(m); if (m === delModal) state.pendingDelete = null; } });
  });

  /* ================= 12. CSV export ================= */

  $('btnExport').addEventListener('click', function () {
    var table = state.currentSection === 'overview' || state.currentSection === 'settings' ? 'listings' : sectionTable(state.currentSection);
    var rows = visibleRows();
    if (!rows.length) { alert('No data to export in ' + table + '.'); return; }

    var keysSet = new Set();
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (k !== 'payload') keysSet.add(k); });
      if (r.payload) Object.keys(r.payload).forEach(function (pk) { keysSet.add('payload_' + pk); });
    });
    var headers = Array.from(keysSet);
    var lines = [headers.map(function (h) { return '"' + h.replace(/"/g, '""') + '"'; }).join(',')];
    rows.forEach(function (r) {
      lines.push(headers.map(function (h) {
        var val;
        if (h.indexOf('payload_') === 0) val = (r.payload && r.payload[h.substring(8)] !== undefined) ? r.payload[h.substring(8)] : '';
        else val = r[h] !== undefined ? r[h] : '';
        if (val !== null && typeof val === 'object') val = JSON.stringify(val);
        return '"' + String(val).replace(/"/g, '""') + '"';
      }).join(','));
    });
    var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'arzuz_' + table + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('CSV export downloaded!', 'success');
  });

  /* ================= 13. Amenities + Telegram ================= */

  function renderAmenitiesManager() {
    var listEl = $('amenitiesManagerList');
    if (!listEl) return;
    var all = utilitiesList();
    listEl.innerHTML = all.map(function (u) {
      var isDefault = (typeof _DEFAULT_UTILITIES !== 'undefined') && _DEFAULT_UTILITIES.indexOf(u) !== -1;        return '<label class="admin-chip amenity-row active"><span>' + esc(u) + '</span>' +
        (isDefault
          ? '<span class="amenity-lock" title="Built-in — cannot remove">' + ico('lock', 11) + '</span>'
          : '<button type="button" class="amenity-x" data-amenity="' + esc(u) + '" title="Remove" aria-label="Remove amenity">' + ico('x', 11) + '</button>') +
        '</label>';
    }).join('') || '<span style="color:#6B5C7D;font-size:13px">No amenities defined yet.</span>';
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.amenity-x') : null;
    if (!b) return;
    var name = b.dataset.amenity;
    if (typeof _DEFAULT_UTILITIES !== 'undefined' && _DEFAULT_UTILITIES.indexOf(name) !== -1) return;
    if (!confirm('Remove amenity "' + name + '"? It disappears from every form.')) return;
    ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/amenities?name=eq.' + encodeURIComponent(name), { method: 'DELETE', headers: h });
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) { onAuthError(new Error('Amenity delete rejected')); throw new Error('Your session has expired.'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return ArzuzData.reload();
    }).then(function () {
      renderAmenitiesManager();
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Amenity "' + name + '" removed.', 'info');
    }).catch(function (err) { alert('Could not remove amenity: ' + err.message); });
  });

  $('btnAddAmenity').addEventListener('click', function () {
    var input = $('newAmenityInput');
    var val = input.value.trim();
    var fb = $('amenityFeedback');
    if (!val) return;
    var current = utilitiesList();
    if (current.indexOf(val) !== -1) {        fb.style.color = '#F59E0B'; fb.textContent = '“' + val + '" already exists.'; fb.style.display = 'block';
      return;
    }
    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/amenities', { method: 'POST', headers: h, body: JSON.stringify({ name: val }) });
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) { onAuthError(new Error('Amenity insert rejected')); throw new Error('Your session has expired.'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return ArzuzData.reload();
    }).then(function () {
      input.value = '';
      fb.style.color = '#34D399';
      fb.textContent = '"' + val + '" added! It now appears in all forms and the Add Apartment modal.';
      fb.style.display = 'block';
      renderAmenitiesManager();
      setTimeout(function () { fb.style.display = 'none'; }, 4000);
    }).catch(function (err) {
      fb.style.color = '#F87171';
      fb.textContent = 'Could not save: ' + err.message;
      fb.style.display = 'block';
    });
  });
  $('newAmenityInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('btnAddAmenity').click(); }
  });
  ArzuzData.ready.then(renderAmenitiesManager);

  /* Telegram — the token lives only in Netlify */
  (function initTelegram() {
    var tgChatEl = $('tgChat'), tgStatusEl = $('tgStatus');
    ArzuzNotify.status()
      .then(function (st) {
        if (!tgStatusEl) return;
        tgStatusEl.textContent = (st.token ? 'Bot token configured.' : 'TELEGRAM_BOT_TOKEN is not set in Netlify.') +
          '  ' + (st.chatId ? 'Chat ID configured.' : 'TELEGRAM_CHAT_ID is not set yet.');
        tgStatusEl.style.color = (st.token && st.chatId) ? '#34D399' : '#FBBF24';
        if (st.chatId && tgChatEl) tgChatEl.value = 'Configured in Netlify (hidden)';
      })
      .catch(function () {
        if (tgStatusEl) { tgStatusEl.textContent = 'Could not reach /api/notify — has this site been deployed with the function?'; tgStatusEl.style.color = '#FBBF24'; }
      });

    $('btnAutoDetect').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      ArzuzNotify.detect()
        .then(function (st) {
          if (!st.chatId) {
            alert('No recent chat found. Open Telegram, send your bot any message (e.g. /start), then click Auto-Detect again.');
            return;
          }
          tgChatEl.value = st.chatId;
          alert('Detected Chat ID: ' + st.chatId + '\n\nCopy it into Netlify → Environment variables → TELEGRAM_CHAT_ID, then redeploy.');
        })
        .catch(function (err) { alert('Could not detect a chat ID: ' + err.message); })
        .finally(function () { btn.disabled = false; });
    });

    $('btnCopyChat').addEventListener('click', function () {
      var v = (tgChatEl.value || '').trim();
      if (!v || v.indexOf('Configured') === 0) { alert('Click Auto-Detect Chat ID first.'); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(function () { alert('Copied: ' + v); }).catch(function () { alert(v); });
      } else alert(v);
    });

    $('btnTestNotify').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      ArzuzNotify.test()
        .then(function () { alert('Test alert sent to Telegram!'); })
        .catch(function (err) { alert('Failed to send test alert: ' + err.message); })
        .finally(function () { btn.disabled = false; });
    });
  })();

  /* ================= 14. Support Desk ================= */

  /* Canned replies are written from the site's own public promises:
     no fees, contact via WhatsApp, viewings confirmed by the team,
     safety guidance. {name} is a placeholder support replaces by hand. */
  var CANNED_REPLIES = [
    { label: 'Booking — next steps', text: 'Hi {name}! Arzuz here 🏠 Thank you for booking. Next step: we confirm the viewing with the landlord/caretaker and message you here with a time. Arzuz never collects money — you pay the landlord directly at the apartment.' },
    { label: 'Viewing scheduled', text: 'Hi {name}! Arzuz here 🏠 Your viewing is confirmed. Please go with a friend and tell someone where you are going. Anything that does not match the listing, tell us straight away.' },
    { label: 'Report received', text: 'Hi {name}, thank you for reporting this 🙏 We have logged your ticket and the team is looking into it now. We will come back to you on this number.' },
    { label: 'Apartment unavailable', text: 'Hi {name}, sadly the apartment you asked about is no longer available. We have your budget and area on file and will message you the moment something matching opens up.' },
    { label: 'No fees, ever', text: 'Hi! A quick reminder: Arzuz is completely free for students — zero agent fees. Nobody from Arzuz will ever ask you for money. If anyone does, report it to us immediately on this number.' },
    { label: 'Safety first', text: 'Hi {name}! Safety tips for your viewing: go during the day, take a friend, tell someone where you are going, and never pay any “inspection fee”. If anything feels wrong, leave and message us.' },
    { label: 'Roommate update', text: 'Hi {name}! Your roommate request is on the list 🤝 We pair compatible students as new shared-room bookings come in and will introduce you on WhatsApp when we find a match.' },
    { label: 'Escalated to admin', text: 'Hi {name}, your issue has been escalated to our senior team for a decision. You will hear back from us within 48 hours. Thank you for your patience.' }
  ];

  function renderSupportDesk() {
    var tix = (state.data.support_tickets || []).filter(function (r) { return !isTestRow(r); });
    var open = tix.filter(function (r) { return str(r.status).toLowerCase() === 'open'; });
    var prog = tix.filter(function (r) { return str(r.status).toLowerCase() === 'in_progress'; });
    var today = tix.filter(function (r) {
      var d = new Date(r.created_at);
      return isFinite(d) && d.toDateString() === new Date().toDateString();
    }).length;
    var oldest = 0;
    open.forEach(function (r) { oldest = Math.max(oldest, ageHours(r.created_at)); });

    var el = $('supportMetrics');
    if (el) {
      el.innerHTML = '<h3>' + ico('headset', 18) + ' Support Desk</h3>' +
        '<p class="sub">Every report from the listing page and the phones, in one queue. Anything left open past 48 hours turns red — clear it or escalate it.</p>' +
        '<div class="support-counts" style="margin-top:12px">' +
        '<div class="sc"><b>' + open.length + '</b><span>open</span></div>' +
        '<div class="sc"><b>' + prog.length + '</b><span>in progress</span></div>' +
        '<div class="sc"><b>' + today + '</b><span>new today</span></div>' +
        '<div class="sc"><b>' + (oldest >= 24 ? Math.floor(oldest / 24) + 'd' : (oldest ? Math.round(oldest) + 'h' : '—')) + '</b><span>oldest open</span></div>' +
        '</div>';
    }

    var cr = $('cannedReplies');
    if (cr) {
      cr.innerHTML = CANNED_REPLIES.map(function (c, i) {
        return '<button type="button" class="canned-btn" data-canned="' + i + '">' + esc(c.label) + '</button>';
      }).join('');
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-canned]') : null;
    if (!b) return;
    var c = CANNED_REPLIES[parseInt(b.dataset.canned, 10)];
    if (!c) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(c.text).then(function () {
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Reply copied — paste it in WhatsApp.', 'success');
      }, function () { window.prompt('Copy this reply:', c.text); });
    } else window.prompt('Copy this reply:', c.text);
  });

  /* Phone complaints become normal tickets (admin inserts authenticated). */
  $('btnLogTicket').addEventListener('click', function () {
    var fb = $('tkFeedback');
    var name = $('tk_name').value.trim();
    var phone = $('tk_phone').value.trim();
    var msg = $('tk_msg').value.trim();      if (!msg) { fb.textContent = 'Write what the problem is first.'; fb.classList.add('show'); return; }
    var btn = this;
    btn.disabled = true;
    var row = {
      client_ref: newToken(),
      payload: { name: name, phone: phone, category: $('tk_cat').value, listing_name: $('tk_listing').value.trim(), message: msg },
      session: cfg.SESSION || '2026/2027',
      env: cfg.ENV || 'production',
      source: 'admin_dashboard_phone',
      status: 'open'
    };
    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/support_tickets', { method: 'POST', headers: h, body: JSON.stringify(row) });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Ticket insert rejected')); throw new Error('Your session has expired.'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (created) {
        if (created && created[0]) state.data.support_tickets.unshift(created[0]);
        ['tk_name', 'tk_phone', 'tk_listing', 'tk_msg'].forEach(function (id) { if ($(id)) $(id).value = ''; });
        fb.textContent = 'Ticket logged in the queue above.';
        fb.style.color = '#34D399';
        fb.style.display = 'block';
        renderSupportDesk();
        renderTable();
        setTimeout(function () { fb.style.display = 'none'; }, 4000);
      })
      .catch(function (err) {
        fb.textContent = 'Could not log the ticket: ' + err.message;
        fb.style.color = '#F87171';
        fb.style.display = 'block';
      })
      .then(function () { btn.disabled = false; });
  });

  /* ================= 15. Team management (main admin) ================= */

  function teamFeedback(msg, color) {
    var el = $('teamFeedback');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = color || '#FCA5A5';
    el.style.display = msg ? 'block' : 'none';
  }

  function teamCall(body) {
    return ArzuzAuth.headers().then(function (h) {
      return fetch('/api/team', { method: 'POST', headers: h, body: JSON.stringify(body) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function tempPassword() {
    var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 14; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  function renderTeamRoster() {
    var body = $('teamRoster');
    if (!body) return;
    if (currentRole() !== 'admin') return;
    teamCall({ action: 'list' }).then(function (data) {
      var users = data.users || [];
      if (!users.length) {
        body.innerHTML = '<tr><td colspan="4" class="table-empty">No users found.</td></tr>';
        return;
      }
      body.innerHTML = users.map(function (u) {
        var roleSel = '<select class="team-role-select" data-team-id="' + esc(u.id) + '">' +
          ['support', 'marketing', 'admin'].map(function (r) {
            return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' +
              (r === 'admin' ? 'Main admin' : r.charAt(0).toUpperCase() + r.slice(1)) + '</option>';
          }).join('') + '</select>';
        return '<tr>' +
          '<td><b>' + esc(u.email || u.id) + '</b>' + (u.confirmed ? '' : ' <span class="no-ask-flag">unconfirmed</span>') + '</td>' +
          '<td>' + roleSel + '</td>' +
          '<td>' + esc(u.last_sign_in_at ? fmtDate(u.last_sign_in_at) : 'never') + '</td>' +
          '<td><div class="cell-actions">' +
          '<button type="button" class="act-btn" data-team="reset" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">' + ico('key', 13) + ' Reset password</button>' +
          '<button type="button" class="act-btn act-del" data-team="remove" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">' + ico('trash', 13) + '</button>' +
          '</div></td></tr>';
      }).join('');
    }).catch(function (err) {
      body.innerHTML = '<tr><td colspan="4" class="table-empty">' + esc(err.message) + '</td></tr>';
    });
  }

  $('btnTeamCreate').addEventListener('click', function () {
    var email = $('teamEmail').value.trim();
    var role = $('teamRole').value;
    if (!email) { teamFeedback('Enter the teammate\u2019s email first.'); return; }
    var pw = tempPassword();
    var btn = this;
    btn.disabled = true;
    teamCall({ action: 'create', email: email, role: role, password: pw })
      .then(function () {
        var box = $('teamCreated');
        box.innerHTML = '<b>' + esc(email) + '</b> created as <b>' + (role || 'main admin') + '</b>.<br>' +
          'Temporary password: <span class="team-pw">' + esc(pw) + '</span> ' +
          '<button type="button" class="btn-inline" id="btnCopyPw">Copy password</button><br>' +
          '<small style="color:#9A8CA8">Shown once. Send it with this address; they sign in at admin.html.</small>';
        box.style.display = 'block';
        var cp = $('btnCopyPw');
        if (cp) cp.addEventListener('click', function () {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pw);
          if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Password copied.', 'success');
        });
        $('teamEmail').value = '';
        teamFeedback('');
        renderTeamRoster();
      })
      .catch(function (err) { teamFeedback('Could not create the account: ' + err.message); })
      .then(function () { btn.disabled = false; });
  });

  document.addEventListener('change', function (e) {
    var sel = e.target.closest ? e.target.closest('.team-role-select') : null;
    if (!sel) return;
    var id = sel.dataset.teamId, role = sel.value;
    if (!confirm('Change this teammate\u2019s role to ' + (role === 'admin' ? 'MAIN ADMIN (full access)' : role.toUpperCase()) + '? It applies at their next sign-in.')) {
      renderTeamRoster();
      return;
    }
    teamCall({ action: 'set_role', id: id, role: role === 'admin' ? '' : role })
      .then(function () { teamFeedback('Role updated. It applies the next time they sign in.', '#34D399'); renderTeamRoster(); })
      .catch(function (err) { teamFeedback('Could not update role: ' + err.message); });
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-team]') : null;
    if (!b) return;
    var id = b.dataset.id, email = b.dataset.email;
    if (b.dataset.team === 'reset') {
      var pw = tempPassword();
      if (!confirm('Set a new temporary password for ' + email + '? Their current password stops working.')) return;
      teamCall({ action: 'reset_password', id: id, password: pw })
        .then(function () {
          window.prompt('New temporary password for ' + email + ' — copy it now:', pw);
          renderTeamRoster();
        })
        .catch(function (err) { teamFeedback('Could not reset password: ' + err.message); });
    } else if (b.dataset.team === 'remove') {
      if (!confirm('Remove ' + email + ' completely? They lose access immediately. This cannot be undone.')) return;
      teamCall({ action: 'delete', id: id })
        .then(function () { teamFeedback('Removed ' + email + '.', '#34D399'); renderTeamRoster(); })
        .catch(function (err) { teamFeedback('Could not remove: ' + err.message); });
    }
  });

  /* ================= boot ================= */

  /* Hide role-restricted nav before anything renders (booting
     signed-out on a shared screen must not advertise the layout). */
  applyRoleNav();
  renderRoute();
  checkAuth();
})();
