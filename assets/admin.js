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

  var state = {
    currentSection: 'overview',
    data: { demand_records: [], listings: [], scout_submissions: [], booking_requests: [] },
    minors: [],                      // rows of minors_needing_guardian view
    roommateSummary: null,           // row of roommate_match_summary view
    roommateFor: null,               // demand id whose candidates are open
    pendingDelete: null,
    detail: null,
    search: '',
    statusFilter: 'all',
    needsAskOnly: false,
    showTestRows: false
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
  function show(el) { if (el) el.classList.add('open'); }
  function hide(el) { if (el) el.classList.remove('open'); }

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

  /* the Bookings SECTION maps to the booking_requests TABLE */
  function sectionTable(sec) { return sec === 'bookings' ? 'booking_requests' : sec; }

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
      '" target="_blank" rel="noopener">📍 Map</a>';
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
    if (who) who.textContent = (email || 'Signed in') + (role === 'marketing' ? ' · marketing' : ' · admin');
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

  $('btnRefresh').addEventListener('click', function () { fetchData(); });

  /* ================= 2. Hash router ================= */

  var SECTIONS = {
    overview: { title: 'Overview', icon: '▦', label: 'Overview' },
    demand_records: { title: 'Student Demands', icon: '🎓', label: 'Demands' },
    listings: { title: 'Landlord Listings', icon: '🏠', label: 'Listings' },
    scout_submissions: { title: 'Building Scouts', icon: '📋', label: 'Scouts' },
    bookings: { title: 'Booking Requests', icon: '📅', label: 'Bookings' },
    roommate: { title: 'Roommate Matching', icon: '🤝', label: 'Roommates' },
    growth: { title: 'Growth', icon: '📈', label: 'Growth' },
    strategy: { title: 'Strategy', icon: '📚', label: 'Strategy' },
    settings: { title: 'Settings', icon: '⚙', label: 'Settings' }
  };

  /* Sections hidden per role. The marketing login is prioritised for
     marketing: it lands on Growth and never sees the data tables or
     settings. Admin (the default) sees everything. */
  var ROLE_SECTIONS = {
    admin: null, // no restrictions
    marketing: ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'roommate', 'settings']
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
      var fallback = (allowed.indexOf('growth') !== -1) ? 'growth' : allowed[0];
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

    /* shared table toolbar: visible on the data sections only,
       with listings-specific controls shown just there */
    var isTable = sec === 'demand_records' || sec === 'listings' || sec === 'scout_submissions' || sec === 'bookings';
    var toolbar = $('dataTableControls');
    if (toolbar) toolbar.style.display = isTable ? '' : 'none';
    if ($('filterAsk')) $('filterAsk').style.display = sec === 'listings' ? '' : 'none';
    if ($('btnOpenAddApt')) $('btnOpenAddApt').style.display = sec === 'listings' ? '' : 'none';

    if (sec === 'overview') renderOverview();
    if (sec === 'roommate') renderRoommatePanel();
    if (sec === 'growth' && window.ArzuzStrategy) {
      ArzuzStrategy.renderGrowth(document.querySelector('[data-section="growth"]'), {
        demands: state.data.demand_records,
        listings: state.data.listings,
        scouts: state.data.scout_submissions,
        bookings: state.data.booking_requests,
        roommateSummary: state.roommateSummary
      });
    }
    if (sec === 'strategy' && window.ArzuzStrategy) {
      ArzuzStrategy.renderStrategy(document.querySelector('[data-section="strategy"]'), routeDoc());
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

  /* ================= 3. Data fetch ================= */

  function fetchData() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
    ArzuzAuth.headers().then(function (h) {
      var promises = TABLES.map(function (tbl) {
        var url = apiRoot() + '/rest/v1/' + tbl + '?select=*&order=created_at.desc';
        return fetch(url, { headers: h }).then(function (r) {
          if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Not authorised (HTTP ' + r.status + ')'), { auth: true });
          return r.ok ? r.json() : [];
        });
      });
      // minors view for the Overview safeguarding panel
      promises.push(fetch(apiRoot() + '/rest/v1/minors_needing_guardian?select=*', { headers: h })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; }));

      // roommate metric view (the business plan's one number for this line)
      promises.push(fetch(apiRoot() + '/rest/v1/roommate_match_summary?select=*', { headers: h })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; }));

      return Promise.all(promises).then(function (results) {
        state.data.demand_records = results[0] || [];
        state.data.listings = results[1] || [];
        state.data.scout_submissions = results[2] || [];
        state.data.booking_requests = results[3] || [];
        state.minors = results[4] || [];
        state.roommateSummary = (results[5] && results[5][0]) ? results[5][0] : null;
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

    $('mDemands').textContent = demands.length;
    $('mListings').textContent = listings.length;
    $('mScouts').textContent = scouts.length;
    $('mOpenDemands').textContent = openDemands;

    /* roommate 14-day metric — from the SQL view */
    var rs = state.roommateSummary;
    var mRoom = $('mRoommate');
    if (mRoom) {
      mRoom.textContent = rs ? (rs.pct_matched_within_14d + '%') : '—';
      var roomCard = mRoom.parentElement;
      if (roomCard) roomCard.classList.toggle('attention', !!(rs && rs.roommate_demands_total > rs.matched_total));
    }
    $('mActiveListings').textContent = activeListings;
    $('mMissingAsk').textContent = missingAsk;
    $('mMissingAsk').parentElement.classList.toggle('attention', missingAsk > 0);
    $('mMinors').textContent = minorsCount;
    $('mMinors').parentElement.classList.toggle('attention', minorsCount > 0);
    $('navPillMinors').textContent = minorsCount ? String(minorsCount) : '';

    /* --- daily ops: minors --- */
    var minorsBox = $('opsMinors');
    if (!state.minors.length) {
      minorsBox.innerHTML = '<div class="ops-row"><span class="ic">✅</span><span class="tx"><b>No minors missing a guardian</b><span>Every under-18 registration has a guardian on file. Nothing to do today.</span></span></div>';
    } else {
      minorsBox.innerHTML =
        '<p class="sub" style="margin-bottom:10px"><b style="color:#FCA5A5">' + state.minors.length + '</b> under-18 ' +
        (state.minors.length === 1 ? 'registration has' : 'registrations have') +
        ' no guardian contact. Match nothing to them until this is filled in.</p>' +
        state.minors.slice(0, 6).map(function (m) {
          return '<div class="ops-row alert">' +
            '<span class="ic">⚠️</span>' +
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
      askBox.innerHTML = '<div class="ops-row"><span class="ic">✅</span><span class="tx"><b>Every listing has its opening ask</b><span>The gap between opening ask and listed price is the only measurement of whether Arzuz works.</span></span></div>';
    } else {
      var sample = listings.filter(function (r) { return r.opening_ask_ngn == null; }).slice(0, 4);
      askBox.innerHTML =
        '<p class="sub" style="margin-bottom:10px"><b style="color:#FBBF24">' + missingAsk + '</b> listing' +
        (missingAsk === 1 ? ' is' : 's are') + ' missing <b>opening_ask_ngn</b> — the price the landlord asked ' +
        'before seeing any demand data. Enter it from your field notes the same day; never overwrite it afterwards.</p>' +
        sample.map(function (r) {
          var p = payloadOf(r);
          return '<div class="ops-row">' +
            '<span class="ic">🏷️</span>' +
            '<span class="tx"><b>' + esc(pick(r, 'property_name', ['prop_name']) || 'Unnamed property') + '</b>' +
            '<span>' + esc(pick(r, 'area', ['ar']) || '—') + ' · listed at ' + ngn(pick(r, 'listed_price_ngn', ['rent'])) + '</span></span>' +
            '<span class="ops-cta"><button type="button" class="btn-inline green" data-act="edit" data-table="listings" data-id="' + esc(r.id) + '">Add opening ask</button></span>' +
            '</div>';
        }).join('');
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
      '<h3>🤝 Roommate matching — the one number</h3>' +
      '<p class="sub">The plan tracks exactly one roommate metric: the share of shared-type roommate demand matched within 14 days. A matching feature with nothing matched is just a form.</p>' +
      '<div class="metrics-grid" style="margin-top:14px">' +
        '<div class="metric-card"><div class="metric-lbl">Matched in 14 days</div><div class="metric-num">' + (rs ? esc(String(rs.pct_matched_within_14d)) + '%' : '—') + '</div><div class="metric-sub">' + (rs ? esc(rs.matched_within_14d + ' of ' + rs.roommate_demands_total + ' roommate requests') : 'Run supabase-media-booking.sql to enable this metric') + '</div></div>' +
        '<div class="metric-card"><div class="metric-lbl">Waiting now</div><div class="metric-num">' + waiting.length + '</div><div class="metric-sub">Open roommate requests to pair</div></div>' +
      '</div>';

    var html = '';
    if (!waiting.length) {
      html += '<div class="ops-row"><span class="ic">✅</span><span class="tx"><b>No open roommate requests</b>' +
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
          (p.mate_gender ? '<span>🧑‍🤝‍🧑 ' + esc(p.mate_gender) + '</span>' : '') +
          (p.mate_budget ? '<span>💰 ' + esc(p.mate_budget) + '</span>' : '') +
          (p.mate_style ? '<span>🌙 ' + esc(p.mate_style) + '</span>' : '') +
          '<span>📅 ' + esc(fmtDate(r.created_at)) + '</span>' +
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
                  '<button type="button" class="btn-inline green" data-mate="pair" data-a="' + esc(r.id) + '" data-b="' + esc(cd.row.id) + '">🤝 Match</button>' +
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
      btn.disabled = false; btn.textContent = '🤝 Match';
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
        : ['pending', 'active', 'rejected', 'inactive'];
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
      : pick(r, 'scout_phone', ['phone']);
    var wa = waLink(phone);
    var html = actBtn('view', table, r.id, '👁 View') + actBtn('edit', table, r.id, '✎ Edit');
    if (wa) html = '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WA</a>' + html;
    html += actBtn('del', table, r.id, '🗑');
    return html;
  }

  function renderTable() {
    var table = sectionTable(state.currentSection);
    var head = $('tableHead'), body = $('tableBody'), cards = $('tableCards');
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
          '<td><b>' + (name || '—') + '</b>' + (isMinor ? '<span class="no-ask-flag" title="Under 18 — check guardian">🛡 minor</span>' : '') + '</td>' +
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
          '<div class="rc-tags">' + statusTag(r.status) + (isMinor ? '<span class="no-ask-flag">🛡 minor</span>' : '') + '</div>' +
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
          '<td>' + statusTag(r.status) + '</td>' +
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
          '<div class="rc-tags">' + statusTag(r.status) +
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
          ? '<span class="tag-status tag-matched">🤝 roommate</span>'
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
          (p.roommate === 'yes' ? '<span class="tag-status tag-matched">🤝 roommate</span>' : '') + '</div>' +
          '<div class="rc-sub" style="margin-top:6px">' + esc(p.listing_name || 'Apartment request') + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');
    }

    var emptyMsg = {
      demand_records: 'No student records found.',
      listings: 'No listings found.',
      scout_submissions: 'No scout reports found.',
      booking_requests: 'No booking requests yet.'
    }[table];
    var colspan = { demand_records: 9, listings: 12, scout_submissions: 9, booking_requests: 8 }[table];
    if (!rows.length) {
      html = '<tr><td class="table-empty" colspan="' + colspan + '"><div class="big">🗂</div>' +
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
          : ['pending', 'active', 'rejected', 'inactive']);
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
      '<span>' + (checked ? '✓ ' : '+ ') + esc(u) + '</span></label>';
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

      html += '<div class="edit-fld"><label>Apartment ID / Code</label><input type="text" id="edit_apt_id" value="' + esc(aptId) + '" placeholder="e.g. APT-001"></div>';
      html += '<div class="edit-fld"><label>Property Name</label><input type="text" id="edit_prop_name" value="' + esc(pick(row, 'property_name', ['prop_name'])) + '"></div>';
      html += '<div class="edit-fld"><label>Owner First Name</label><input type="text" id="edit_nm" value="' + esc(pick(row, 'owner_name', ['nm'])) + '"></div>';
      html += '<div class="edit-fld"><label>Owner Last Name</label><input type="text" id="edit_nm_last" value="' + esc(p.last || '') + '"></div>';
      html += '<div class="edit-fld"><label>Phone / WhatsApp</label><input type="tel" id="edit_ph" value="' + esc(pick(row, 'owner_phone', ['ph'])) + '"></div>';
      html += '<div class="edit-fld"><label>Property Type</label><select id="edit_ty">' +
        (typeof PROPERTY_TYPES !== 'undefined' ? PROPERTY_TYPES : []).map(function (t) {
          return '<option' + (pick(row, 'property_type', ['ty']) === t ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></div>';
      html += '<div class="edit-fld"><label>Area / Street</label><input type="text" id="edit_ar" value="' + esc(pick(row, 'area', ['ar'])) + '"></div>';
      html += '<div class="edit-fld"><label>Rooms Available</label><input type="text" id="edit_rm" value="' + esc(pick(row, 'rooms', ['rm'])) + '"></div>';
      html += '<div class="edit-fld"><label>Listed Price (₦ / session)</label><input type="number" id="edit_rent" value="' + esc(pick(row, 'listed_price_ngn', ['rent'])) + '"></div>';

      /* OPENING ASK — the thesis number. Locked once set. */
      var ask = row.opening_ask_ngn;
      html += '<div class="edit-fld full"><label>Opening Ask (₦) <small>What the landlord asked BEFORE seeing demand data. Enter it from field notes.</small></label>' +
        (ask != null
          ? '<input type="number" id="edit_ask" value="' + esc(ask) + '" disabled>' +
            '<input type="checkbox" id="edit_ask_unlock" style="accent-color:#8B5CF6;width:auto">' +
            '<small style="color:#B3A7BF">The opening ask is <b>locked</b> — overwriting it destroys the only real measurement Arzuz has. Tick to override deliberately.</small>'
          : '<input type="number" id="edit_ask" value="" placeholder="e.g. 200000">' +
            '<small style="color:#9A8CA8">Leave empty only if genuinely unknown.</small>') +
        '</div>';

      html += '<div class="edit-fld"><label>Verification Tier</label><select id="edit_tier">' +
        '<option value="0"' + (Number(row.tier) === 0 ? ' selected' : '') + '>Tier 0 — Unverified</option>' +
        '<option value="1"' + (Number(row.tier) === 1 ? ' selected' : '') + '>Tier 1 — Community Verified</option>' +
        '<option value="2"' + (Number(row.tier) === 2 ? ' selected' : '') + '>Tier 2 — Inspected</option>' +
        '</select></div>';
      html += '<div class="edit-fld"><label>Negotiable?</label><select id="edit_neg">' +
        ['Yes', 'No', 'Depends on the tenant'].map(function (o) { return '<option' + ((p.neg || '') === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') +
        '</select></div>';

      html += '<div class="edit-fld full"><label>Description & Features</label><textarea id="edit_desc" rows="2" placeholder="Running water, prepaid meter…">' + esc(p.desc || p.description || '') + '</textarea></div>';

      var curUt = toList(p.ut || p.utilities);
      html += '<div class="edit-fld full"><label>Hostel Amenities & Utilities</label><div class="admin-chips-wrap">' +
        utilitiesList().map(function (u) { return chipHtml('edit_ut', u, curUt.indexOf(u) !== -1); }).join('') +
        '</div></div>';

      /* media gallery — several assets per listing, each carrying the © credit */
      html += '<div class="edit-fld full"><label>Apartment Media Gallery <small>first photo is the cover · every asset is stamped © Arzuz</small></label>' +
        '<div class="admin-media-zone" id="galEditZone">📷 Click to upload photos (select several)' +
        '<input type="file" id="galEditInput" accept="image/*" multiple style="display:none;">' +
        '<div id="galEditProgress" class="media-upload-status"></div>' +
        '</div>' +
        '<div class="admin-media-zone" id="galEditVideoZone" style="margin-top:8px;">🎥 Click to upload a video tour' +
        '<input type="file" id="galEditVideoInput" accept="video/*" style="display:none;">' +
        '<div id="galEditVideoProgress" class="media-upload-status"></div>' +
        '</div>' +
        '<input type="url" id="edit_video_manual" value="' + esc(videoUrl) + '" placeholder="Or paste direct video URL" style="margin-top:6px;font-size:12.5px">' +
        '<div class="gal-mgr" id="galEditGrid"></div>' +
        '<input type="hidden" id="edit_photo" value="' + esc(photoUrl) + '">' +
        '<input type="hidden" id="edit_video" value="' + esc(videoUrl) + '">' +
        '</div>';
      html += '<div class="edit-fld full"><label class="ck-line"><input type="checkbox" id="edit_split_ok"' +
        ((p.split_ok === true || p.split_ok === 'yes') ? ' checked' : '') +
        '> <span>Landlord consents to this room being shared by two tenants who split the cost <small>(enables roommate matching on the public page)</small></span></label></div>';
    }

    else if (table === 'scout_submissions') {
      var scoutPhoto = pick(row, 'photo_url', ['photo']);
      html += '<div class="edit-fld"><label>Area / Street</label><input type="text" id="edit_area" value="' + esc(pick(row, 'area', ['area'])) + '"></div>';
      html += '<div class="edit-fld"><label>Scout Phone</label><input type="tel" id="edit_phone" value="' + esc(pick(row, 'scout_phone', ['phone'])) + '"></div>';
      html += '<div class="edit-fld"><label>Rent Paid (₦)</label><input type="number" id="edit_amt" value="' + esc(pick(row, 'rent_reported', ['amt'])) + '"></div>';
      html += '<div class="edit-fld"><label>Vacancy Signal</label><input type="text" id="edit_vac" value="' + esc(pick(row, 'vacancy_signal', ['vac'])) + '"></div>';
      if (scoutPhoto) {
        html += '<div class="edit-fld full"><label>Building Photo</label>' +
          '<img class="details-media" src="' + esc(scoutPhoto) + '" alt="Building photo" data-act="photo" data-url="' + esc(scoutPhoto) + '"></div>';
      }
    }

    /* Location + passage editor — listings and scout reports both carry a pin */
    if (table === 'listings' || table === 'scout_submissions') {
      var pLat = row.latitude || p.lat || '';
      var pLng = row.longitude || p.lng || '';
      var pinStr = p.pin || (pLat && pLng ? pLat + ',' + pLng : '');
      html += '<div class="edit-fld full"><label>📍 Location Pin <small>live GPS · tap or drag · accuracy and source are stored</small></label>' +
        '<div class="admin-map-wrap"><div id="editLeafletMap"></div>' +
        '<div class="map-float-btns" id="editMapLayerSwitcher">' +
        '<button type="button" class="map-layer-btn active" data-layer="sat">🛰 Satellite</button>' +
        '<button type="button" class="map-layer-btn" data-layer="street">🗺 Street</button>' +
        '</div></div>' +
        '<div class="map-bottom-bar"><span class="map-coords" id="editMapCoordsText">' + (pinStr ? '📍 ' + esc(pinStr) : '📍 Tap map or drag marker to the gate') + '</span>' +
        '<button type="button" class="gps-btn" id="editBtnLocateMe">🎯 Use GPS</button></div>' +
        '<div class="map-status-box" id="editMapStatus">Live GPS is off here to save battery — tap Use GPS when you are at the gate.</div>' +
        '<input type="hidden" id="edit_lat" value="' + esc(pLat) + '">' +
        '<input type="hidden" id="edit_lng" value="' + esc(pLng) + '">' +
        '<input type="hidden" id="edit_pin_meta" value=\'' + esc(JSON.stringify(p.pin_meta || null)) + '\'></div>';
      html += '<div class="edit-fld full"><label>🚶 Passage to the apartment <small>landmark · gate · steps · traced path — shown on the public listing page</small></label>' +
        '<div id="editPassageMount"></div></div>';
    }

    $('editFieldsContainer').innerHTML = html;
    show(editModal);

    if (table === 'listings' || table === 'scout_submissions') {
      destroyEditMapAndPassage();
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
          lat: pLat || null,
          lng: pLng || null,
          onPin: function (lat, lng, meta) {
            var la = $('edit_lat'), ln = $('edit_lng'), mt = $('edit_pin_meta');
            if (la) la.value = lat;
            if (ln) ln.value = lng;
            if (mt) mt.value = JSON.stringify(meta);
            var badge = $('editMapCoordsText');
            if (badge) { badge.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5); badge.classList.add('set'); }
          }
        });
        editPassageEditor = ArzuzMap.passageEditor({
          mountId: 'editPassageMount',
          answers: null,
          passage: p.passage || null,
          miniMap: true,
          pin: pLat ? { lat: pLat, lng: pLng } : null,
          onChange: null
        });
      }
    }

    if (table === 'listings') {
      var unlock = $('edit_ask_unlock');
      if (unlock) unlock.addEventListener('change', function () { $('edit_ask').disabled = !this.checked; });
      initGalleryManager('edit', seedMedia(p, photoUrl, videoUrl));
      var manual = $('edit_video_manual');
      if (manual) manual.addEventListener('change', function () {
        var url = manual.value.trim();
        if (!url) return;
        var has = galList('edit').some(function (m) { return m.url === url; });
        if (!has) { galList('edit').push({ type: 'video', url: url, label: 'Video tour', credit: credit() }); renderGal('edit'); }
      });
    }
  };

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
      p.prop_name = $('edit_prop_name').value.trim();
      p.nm = $('edit_nm').value.trim();
      p.last = $('edit_nm_last') ? $('edit_nm_last').value.trim() : (p.last || '');
      p.ph = $('edit_ph').value.trim();
      p.ty = $('edit_ty') ? $('edit_ty').value : p.ty;
      p.ar = $('edit_ar').value.trim();
      p.rm = $('edit_rm') ? $('edit_rm').value.trim() : (p.rm || '');
      p.rent = $('edit_rent').value.trim();
      if ($('edit_neg')) p.neg = $('edit_neg').value;
      if ($('edit_desc')) p.desc = $('edit_desc').value.trim();
      var sel = [];
      document.querySelectorAll('input[name="edit_ut"]:checked').forEach(function (ck) { sel.push(ck.value); });
      p.ut = sel; p.utilities = sel;
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
      if (editPassageEditor) {
        var psg = editPassageEditor.get();
        if (ArzuzMap && ArzuzMap.passage.hasContent(psg)) p.passage = psg;
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

  /* ================= 7. Add Apartment ================= */

  var addModal = $('addAptModal');

  function nextAptId() {
    var max = 0;
    state.data.listings.forEach(function (r) {
      var id = payloadOf(r).apt_id || payloadOf(r).custom_id || '';
      var m = /^APT-(\d+)$/i.exec(str(id).trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'APT-' + String(max + 1).padStart(3, '0');
  }

  $('btnOpenAddApt').addEventListener('click', function () {
    $('addAptForm').reset();
    ['add_photo_url', 'add_video_url', 'add_lat', 'add_lng', 'add_pin', 'add_pin_meta'].forEach(function (id) { if ($(id)) $(id).value = ''; });
    ['galAddProgress', 'galAddVideoProgress'].forEach(function (id) { var el = $(id); if (el) el.textContent = ''; });
    var amanual = $('add_video_url_manual');
    if (amanual) amanual.value = '';
    initGalleryManager('add', []);
    $('add_apt_id').value = nextAptId();
    setError('addModalError', '');

    var wrap = $('addAptUtilitiesWrap');
    if (wrap) {
      wrap.innerHTML = utilitiesList().map(function (u) { return chipHtml('add_ut', u, false); }).join('');
    }
    show(addModal);
    setTimeout(function () {
      initAdminMap();
      initAdminPassageAdd();
    }, 200);
  });

  $('btnCancelAddApt').addEventListener('click', function () {
    hide(addModal);
    destroyAdminPassage();
  });  $('addAptForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pinVals = adminPinValues();
    var p = {
      apt_id: $('add_apt_id').value.trim(),
      custom_id: $('add_apt_id').value.trim(),
      prop_name: $('add_prop_name').value.trim(),
      ty: $('add_ty').value,
      ar: $('add_ar').value.trim(),
      rent: $('add_rent').value.trim(),
      rm: $('add_rm').value.trim(),
      nm: $('add_nm').value.trim(),
      last: $('add_nm_last') ? $('add_nm_last').value.trim() : '',
      ph: $('add_ph').value.trim(),
      neg: $('add_neg') ? $('add_neg').value : '',
      who: $('add_who') ? $('add_who').value : '',
      desc: $('add_desc') ? $('add_desc').value.trim() : '',
      photo: '',
      video: '',
      video_url: '',
      media: [],
      split_ok: $('add_split_ok') ? $('add_split_ok').checked : false,
      ut: [],
      lat: pinVals.lat,
      lng: pinVals.lng,
      pin: pinVals.pin,
      pin_meta: pinVals.meta || null,
      passage: (pinVals.passage && ArzuzMap && ArzuzMap.passage.hasContent(pinVals.passage)) ? pinVals.passage : null,
      vf: $('add_vf') ? $('add_vf').value : ''
    };
    document.querySelectorAll('input[name="add_ut"]:checked').forEach(function (ck) { p.ut.push(ck.value); });
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
      source: 'admin_dashboard',
      status: $('add_status').value,
      tier: parseInt($('add_tier').value, 10) || 0,
      notes: 'Added via Admin Dashboard (' + p.apt_id + ')',
      payload: p
    };
    var askRaw = $('add_ask') ? $('add_ask').value.trim() : '';
    if (askRaw !== '') {
      var askNum = parseInt(askRaw, 10);
      if (!isNaN(askNum)) listing.opening_ask_ngn = askNum;
    }

    var btn = $('btnSaveAddApt');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    setError('addModalError', '');

    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/listings', {
        method: 'POST', headers: h, body: JSON.stringify(listing)
      });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Insert rejected')); throw new Error('Your session has expired.'); }
        if (!r.ok) throw new Error('Insert failed (HTTP ' + r.status + ')');
        return r.json();
      })
      .then(function (created) {
        var inserted = (created && created[0]) ? created[0] : listing;
        state.data.listings.unshift(inserted);
        hide(addModal);
        location.hash = '#/listings';
        renderRoute();
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Apartment ' + p.apt_id + ' added successfully!', 'success');
      })
      .catch(function (err) { setError('addModalError', 'Could not add apartment: ' + err.message); })
      .finally(function () { btn.textContent = 'Save Apartment'; btn.disabled = false; });
  });

  /* ================= 8. Media upload + lightboxes ================= */

  function uploadMediaToCloudinary(file, resourceType, statusElId, onDone) {
    var statusEl = $(statusElId);
    if (statusEl) { statusEl.className = 'media-upload-status uploading'; statusEl.textContent = '⏳ Preparing signed upload…'; }
    fetch('/api/cloudinary-sign', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('Could not get upload signature (HTTP ' + r.status + ')'); return r.json(); })
      .then(function (sig) {
        if (statusEl) statusEl.textContent = '📤 Uploading ' + (resourceType === 'video' ? 'video tour' : 'photo') + '…';
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
        return fetch(endpoint, { method: 'POST', body: fd }).then(function (res) {
          if (!res.ok) return res.text().then(function (t) { throw new Error('Cloudinary error: ' + t); });
          return res.json();
        });
      })
      .then(function (data) {
        if (statusEl) { statusEl.className = 'media-upload-status success'; statusEl.textContent = '✅ Uploaded!'; }
        onDone(data.secure_url);
      })
      .catch(function (err) {
        if (statusEl) { statusEl.className = 'media-upload-status error'; statusEl.textContent = '❌ Upload failed: ' + err.message; }
      });
  }

  function initUploader(zoneId, inputId, kind, previewId, hiddenId, manualId, progressId) {
    var zone = $(zoneId);
    if (!zone) return;
    /* dropzones carry their own hidden file input; progress lives beside it */
    var input = $(inputId) || zone.querySelector('input[type=file]');

    var submit = function (file) {
      if (!file) return;
      uploadMediaToCloudinary(file, kind, progressId, function (url) {
        var hidden = $(hiddenId);
        if (hidden) hidden.value = url;
        var manual = manualId ? $(manualId) : null;
        if (manual) manual.value = url;
        var prev = $(previewId);
        if (prev) {
          prev.innerHTML = kind === 'video'
            ? '<video src="' + esc(url) + '" controls></video><button type="button" class="media-remove-btn" data-clear="' + hiddenId + '" data-prev="' + previewId + '">✕ Remove</button>'
            : '<img src="' + esc(url) + '" alt="Upload preview"><button type="button" class="media-remove-btn" data-clear="' + hiddenId + '" data-prev="' + previewId + '">✕ Remove</button>';
          prev.style.display = 'block';
        }
      });
    };

    if (zone) {
      zone.onclick = function () { if (input) input.click(); };
      if (input) {
        input.onchange = function () { submit(input.files && input.files[0]); };
      }
    }
    var manual = manualId ? $(manualId) : null;
    if (manual) {
      manual.addEventListener('input', function () {
        var url = manual.value.trim();
        var hidden = $(hiddenId); if (hidden) hidden.value = url;
        var prev = $(previewId);
        if (!prev) return;
        if (url) {
          prev.innerHTML = kind === 'video'
            ? '<video src="' + esc(url) + '" controls></video><button type="button" class="media-remove-btn" data-clear="' + hiddenId + '" data-prev="' + previewId + '">✕ Remove</button>'
            : '<img src="' + esc(url) + '" alt="Preview"><button type="button" class="media-remove-btn" data-clear="' + hiddenId + '" data-prev="' + previewId + '">✕ Remove</button>';
          prev.style.display = 'block';
        } else { prev.innerHTML = ''; prev.style.display = 'none'; }
      });
    }
  }

  /* the Add Apartment photo/video zones are handled by the gallery
     manager (initGalleryManager) — see section 8b */

  window.openPhotoLightbox = function (url) {
    $('lightboxImg').src = url;
    show($('photoLightbox'));
  };
  $('photoLightbox').addEventListener('click', function () { hide($('photoLightbox')); });

  window.openVideoLightbox = function (url) {
    $('videoLightboxContainer').innerHTML = '<video src="' + esc(url) + '" controls autoplay></video>';
    show($('videoLightbox'));
  };
  function closeVideoLightbox() {
    $('videoLightboxContainer').innerHTML = '';
    hide($('videoLightbox'));
  }
  window.closeVideoLightbox = closeVideoLightbox;
  $('videoLightboxClose').addEventListener('click', closeVideoLightbox);

  /* ================= 8b. Media gallery manager =================
     One manager per modal context ('add' | 'edit'). The list is the
     source of truth for payload.media; the hidden photo/video fields
     stay in sync so every older code path keeps working. */

  var GAL = { add: [], edit: [] };

  function galList(ctx) { return GAL[ctx] || (GAL[ctx] = []); }

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

  function renderGal(ctx) {
    var grid = $(ctx === 'add' ? 'galAddGrid' : 'galEditGrid');
    if (!grid) return;
    var list = galList(ctx);
    if (!list.length) {
      grid.innerHTML = '<p class="gal-empty">No media yet. The first photo you upload becomes the cover students see on the browse page.</p>';
      syncGalHidden(ctx);
      return;
    }
    var firstImg = list.filter(function (m) { return m.type === 'image'; })[0];
    grid.innerHTML = list.map(function (m, i) {
      var isCover = (m === firstImg);
      var thumb = m.type === 'video'
        ? '<video src="' + esc(m.url) + '" muted preload="metadata"></video><span class="gal-kind">🎥</span>'
        : '<img src="' + esc(m.url) + '" alt="" loading="lazy"><span class="gal-kind">📷</span>';
      return '<div class="gal-th">' + thumb +
        (isCover ? '<span class="gal-cover">Cover</span>' : '') +
        '<span class="gal-cr">© Arzuz</span>' +
        '<div class="gal-th-btns">' +
          '<button type="button" class="gal-b" data-gal="left" data-ctx="' + ctx + '" data-i="' + i + '" title="Move left">◀</button>' +
          '<button type="button" class="gal-b" data-gal="right" data-ctx="' + ctx + '" data-i="' + i + '" title="Move right">▶</button>' +
          (m.type === 'image' && !isCover ? '<button type="button" class="gal-b" data-gal="cover" data-ctx="' + ctx + '" data-i="' + i + '" title="Make cover">★</button>' : '') +
          '<button type="button" class="gal-b danger" data-gal="del" data-ctx="' + ctx + '" data-i="' + i + '" title="Remove">✕</button>' +
        '</div>' +
        '<input type="text" class="gal-lbl" data-gal="label" data-ctx="' + ctx + '" data-i="' + i + '" value="' + esc(m.label || '') + '" placeholder="Label (optional)" maxlength="48">' +
        '</div>';
    }).join('');
    syncGalHidden(ctx);
  }

  function uploadIntoGallery(ctx, files, kind) {
    var list = galList(ctx);
    var prog = $(ctx === 'add' ? (kind === 'video' ? 'galAddVideoProgress' : 'galAddProgress')
                               : (kind === 'video' ? 'galEditVideoProgress' : 'galEditProgress'));
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    var done = 0;
    if (prog) { prog.className = 'media-upload-status uploading'; prog.textContent = '📤 Uploading ' + arr.length + ' file' + (arr.length > 1 ? 's' : '') + '…'; }
    arr.forEach(function (file) {
      uploadMediaToCloudinary(file, kind, null, function (url) {
        list.push({ type: kind === 'video' ? 'video' : 'image', url: url, label: '', credit: credit() });
        done++;
        if (prog) { prog.className = 'media-upload-status success'; prog.textContent = '✅ ' + done + ' of ' + arr.length + ' uploaded'; }
        renderGal(ctx);
      });
    });
  }

  function initGalleryManager(ctx, seed) {
    GAL[ctx] = (seed || []).slice();
    var zone = $(ctx === 'add' ? 'galAddZone' : 'galEditZone');
    var input = $(ctx === 'add' ? 'galAddInput' : 'galEditInput');
    var vzone = $(ctx === 'add' ? 'galAddVideoZone' : 'galEditVideoZone');
    var vinput = $(ctx === 'add' ? 'galAddVideoInput' : 'galEditVideoInput');
    if (zone && input) {
      zone.onclick = function () { input.click(); };
      input.onchange = function () { uploadIntoGallery(ctx, input.files, 'image'); input.value = ''; };
    }
    if (vzone && vinput) {
      vzone.onclick = function () { vinput.click(); };
      vinput.onchange = function () { uploadIntoGallery(ctx, vinput.files, 'video'); vinput.value = ''; };
    }
    renderGal(ctx);
  }

  /* gallery thumbnail controls — delegated (grid is re-rendered) */
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-gal]') : null;
    if (!b) return;
    var act = b.dataset.gal, ctx = b.dataset.ctx, i = parseInt(b.dataset.i, 10);
    var list = galList(ctx);
    if (isNaN(i) || !list[i]) return;
    if (act === 'left' && i > 0) { var t1 = list[i - 1]; list[i - 1] = list[i]; list[i] = t1; }
    else if (act === 'right' && i < list.length - 1) { var t2 = list[i + 1]; list[i + 1] = list[i]; list[i] = t2; }
    else if (act === 'del') list.splice(i, 1);
    else if (act === 'cover') { var m = list.splice(i, 1)[0]; list.unshift(m); }
    else return;
    renderGal(ctx);
  });
  document.addEventListener('input', function (e) {
    var b = e.target.closest ? e.target.closest('[data-gal="label"]') : null;
    if (!b) return;
    var list = galList(b.dataset.ctx), i = parseInt(b.dataset.i, 10);
    if (list[i]) list[i].label = b.value.slice(0, 48);
  });

  /* ================= 9. Map pin (Add Apartment) — via ArzuzMap ================= */

  var adminPinCapture = null;
  var adminPassageEditor = null;
  var editPinCapture = null;
  var editPassageEditor = null;

  /* Reads the hidden inputs + passage state the shared widget maintains. */
  function adminPinValues() {
    var meta = null;
    if ($('add_pin_meta') && $('add_pin_meta').value) {
      try { meta = JSON.parse($('add_pin_meta').value); } catch (e) { meta = null; }
    }
    return {
      lat: $('add_lat') ? $('add_lat').value.trim() || null : null,
      lng: $('add_lng') ? $('add_lng').value.trim() || null : null,
      pin: $('add_pin') ? $('add_pin').value.trim() || null : null,
      meta: meta,
      passage: adminPassageEditor ? adminPassageEditor.get() : null
    };
  }

  function initAdminMap() {
    if (typeof ArzuzMap === 'undefined') return;
    var mapEl = $('admin-leaflet-map');
    if (!mapEl) return;

    if (adminPinCapture) { try { adminPinCapture.destroy(); } catch (e) { } adminPinCapture = null; }

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
      onPin: function (lat, lng, meta) {
        var la = $('add_lat'), ln = $('add_lng'), pn = $('add_pin'), mt = $('add_pin_meta');
        if (la) { la.value = lat; la.dataset.src = meta.source || 'tapped'; }
        if (ln) { ln.value = lng; ln.dataset.src = meta.source || 'tapped'; }
        if (pn) pn.value = lat.toFixed(6) + ',' + lng.toFixed(6);
        if (mt) mt.value = JSON.stringify(meta);
        var badge = $('adminMapCoordsText');
        if (badge) { badge.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5); badge.classList.add('set'); }
      }
    });
  }

  /* Passage editor inside the Add Apartment modal. The Edit modal keeps
     its own instance keyed off the payload being edited. */
  function initAdminPassageAdd() {
    if (typeof ArzuzMap === 'undefined') return;
    if (adminPassageEditor) { try { adminPassageEditor.destroy(); } catch (e) { } adminPassageEditor = null; }
    adminPassageEditor = ArzuzMap.passageEditor({
      mountId: 'adminPassageMount',
      answers: null,
      passage: null,
      miniMap: true,
      pin: null
    });
  }

  function destroyAdminPassage() {
    if (adminPassageEditor) { try { adminPassageEditor.destroy(); } catch (e) { } adminPassageEditor = null; }
  }

  /* Tear down the Edit-modal map + passage instances before a rebuild */
  function destroyEditMapAndPassage() {
    if (editPinCapture) { try { editPinCapture.destroy(); } catch (e) { } editPinCapture = null; }
    if (editPassageEditor) { try { editPassageEditor.destroy(); } catch (e) { } editPassageEditor = null; }
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
        var srcLabel = { gps: '📡 Live GPS', tapped: '🗺 Tapped', dragged: '✋ Dragged', admin: '🛰 Restored' }[pm.source] || '🗺 Placed';
        var accTxt = pm.accuracy_m != null ? ' ±' + pm.accuracy_m + 'm' : '';
        html += kv('Pin Quality', srcLabel + accTxt + (pm.samples ? ' · ' + pm.samples + ' samples' : ''));
      }
      if (ArzuzMap && ArzuzMap.passage.hasContent(p.passage)) {
        html += kv('Passage', '🚶 ' + esc(ArzuzMap.passage.summarise(p.passage)), true);
      }
      html += kv('Apartment ID', '<span class="apt-badge-id">' + esc(aptId) + '</span>');
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
        html += kv('Verified Utilities & Amenities',
          utList.map(function (u) { return '<span class="admin-chip active" style="font-size:11.5px;padding:3px 10px">✓ ' + esc(u) + '</span>'; }).join(''), true);
      }
      if (p.desc || p.description) html += kv('Description', esc(p.desc || p.description), true);
      var photoUrl = pick(row, 'photo_url', ['photo']);
      if (photoUrl) html += kv('Photo', '<img class="details-media" src="' + esc(photoUrl) + '" alt="Listing photo" data-act="photo" data-url="' + esc(photoUrl) + '">', true);
      var videoUrl = p.video || p.video_url;
      if (videoUrl) html += kv('Video Tour', '<button type="button" class="act-btn act-video" style="padding:8px 14px;margin-top:4px" onclick="window.openVideoLightbox(\'' + esc(videoUrl) + '\')">🎥 Play Video Tour</button>', true);
    } else if (table === 'scout_submissions') {
      html += kv('Area / Street', esc(pick(row, 'area', ['area']) || '—'));
      html += kv('Rent Paid', ngn(pick(row, 'rent_reported', ['amt'])));
      html += kv('Scout Phone', esc(pick(row, 'scout_phone', ['phone']) || '—'));
      html += kv('Vacancy Signal', esc(pick(row, 'vacancy_signal', ['vac']) || '—'));
      html += kv('Rent Collected By', esc(p.who || '—'));
      var spm = p.pin_meta || {};
      if (p.pin || row.latitude) {
        var sSrc = { gps: '📡 Live GPS', tapped: '🗺 Tapped', dragged: '✋ Dragged', admin: '🛰 Restored' }[spm.source] || '🗺 Placed';
        html += kv('Pin Quality', sSrc + (spm.accuracy_m != null ? ' ±' + spm.accuracy_m + 'm' : ''));
      }
      if (ArzuzMap && ArzuzMap.passage.hasContent(p.passage)) {
        html += kv('Passage', '🚶 ' + esc(ArzuzMap.passage.summarise(p.passage)), true);
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
      (photoUrl ? '<img src="' + esc(photoUrl) + '" alt="">' : '<div style="width:64px;height:64px;border-radius:8px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:26px;flex:none">' + (table === 'demand_records' ? '🎓' : table === 'listings' ? '🏠' : '📋') + '</div>') +
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
      var isDefault = (typeof _DEFAULT_UTILITIES !== 'undefined') && _DEFAULT_UTILITIES.indexOf(u) !== -1;
      return '<label class="admin-chip amenity-row active"><span>✓ ' + esc(u) + '</span>' +
        (isDefault
          ? '<span class="amenity-lock" title="Built-in — cannot remove">🔒</span>'
          : '<button type="button" class="amenity-x" data-amenity="' + esc(u) + '" title="Remove">✕</button>') +
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
    if (current.indexOf(val) !== -1) {
      fb.style.color = '#F59E0B'; fb.textContent = '⚠️ "' + val + '" already exists.'; fb.style.display = 'block';
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
      fb.textContent = '✅ "' + val + '" added! It now appears in all forms and the Add Apartment modal.';
      fb.style.display = 'block';
      renderAmenitiesManager();
      setTimeout(function () { fb.style.display = 'none'; }, 4000);
    }).catch(function (err) {
      fb.style.color = '#F87171';
      fb.textContent = '⚠️ Could not save: ' + err.message;
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
        tgStatusEl.textContent = (st.token ? '✓ Bot token configured.' : '⚠ TELEGRAM_BOT_TOKEN is not set in Netlify.') +
          '  ' + (st.chatId ? '✓ Chat ID configured.' : '⚠ TELEGRAM_CHAT_ID is not set yet.');
        tgStatusEl.style.color = (st.token && st.chatId) ? '#34D399' : '#FBBF24';
        if (st.chatId && tgChatEl) tgChatEl.value = 'Configured in Netlify (hidden)';
      })
      .catch(function () {
        if (tgStatusEl) { tgStatusEl.textContent = '⚠ Could not reach /api/notify — has this site been deployed with the function?'; tgStatusEl.style.color = '#FBBF24'; }
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

  /* ================= boot ================= */

  /* Hide role-restricted nav before anything renders (booting
     signed-out on a shared screen must not advertise the layout). */
  applyRoleNav();
  renderRoute();
  checkAuth();
})();
