/* ============================================================
   Arzuz Admin — mock harness (DEV ONLY)
   Active only when admin.html?mock=1 is opened on localhost /
   127.0.0.1 (see the guarded loader in admin.html). On a real
   host this file is simply not loaded.

   Before admin.js boots it:
   1. Seeds a fake Supabase session in sessionStorage. The JWT
      payload carries app_metadata.role, decoded by
      ArzuzAuth.role() exactly as it decodes a real GoTrue
      token — the dashboard runs under admin / support /
      marketing with zero network.
   2. Wraps window.fetch and serves every endpoint the
      dashboard calls:
        /rest/v1/<table>          GET / POST / PATCH / DELETE
        /auth/v1/token, /logout   sign-in / sign-out
        /api/notify               status / detect / test
        /api/team                 list / create / set_role / ...
        /strategy-docs?name=...   the strategy pack
        Cloudinary sign/upload    NOT mocked (clean 503 error)
   3. Scenario switcher on window.__MOCK__:
        __MOCK__.role('admin'|'support'|'marketing')
        __MOCK__.empty()   __MOCK__.slow(1200)
        __MOCK__.error('rest'|'functions'|'auth')
        __MOCK__.reset()   __MOCK__.stats()   __MOCK__.db()
   ============================================================ */

(function () {
  'use strict';

  /* Only ever active on localhost with ?mock=1. */
  if (['localhost', '127.0.0.1', '0.0.0.0'].indexOf(location.hostname) === -1) return;
  var params = new URLSearchParams(location.search);
  if (params.get('mock') !== '1') return;

  var ROLE_KEY = 'arzuz_mock_role';
  var EXPIRES_IN = 3600;
  var TABLES = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets', 'amenities'];

  function log() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[ArzuzMock]');
    Function.prototype.apply.call(console.log, console, a);
  }

  /* ============================================================
     1. Fake session
     ============================================================ */

  var ROLE = sessionStorage.getItem(ROLE_KEY) || 'admin';

  function fakeToken(role) {
    var payload = { sub: 'mock-user', email: 'owner@arzuz.test', app_metadata: { role: role } };
    var headB64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    var payloadB64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/=+$/, '');
    return headB64 + '.' + payloadB64 + '.mock-signature';
  }

  function seedSession() {
    var session = {
      access_token: fakeToken(ROLE),
      refresh_token: 'mock-refresh-token',
      expires_at: Date.now() + EXPIRES_IN * 1000,
      email: 'owner@arzuz.test'
    };
    try { sessionStorage.setItem('arzuz_session_v1', JSON.stringify(session)); } catch (e) { /* ignore */ }
  }
  seedSession();

  /* ============================================================
     2. In-memory database
     ============================================================ */

  var DB = { rows: window.ArzuzMockData.seed(), seq: 100 };

  function nextId() {
    DB.seq += 1;
    return 'mock-' + DB.seq + '-' + Date.now().toString(36);
  }

  function nowIso() { return new Date().toISOString(); }

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function seedTeamUsers() {
    return [
      { id: 'u1', email: 'owner@arzuz.test', role: '', confirmed: true, last_sign_in_at: nowIso(), seeded: true },
      { id: 'u2', email: 'support@arzuz.test', role: 'support', confirmed: true, last_sign_in_at: nowIso(), seeded: true },
      { id: 'u3', email: 'growth@arzuz.test', role: 'marketing', confirmed: false, last_sign_in_at: null, seeded: true }
    ];
  }

  /* ============================================================
     3. Response helpers + scenario switches
     ============================================================ */

  var CONFIG = { delay: 0, fail: null };

  function resp(payload, opts) {
    opts = opts || {};
    var body = payload === undefined ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload));
    return new Response(body, {
      status: opts.status || 200,
      statusText: opts.status ? 'MOCK ' + opts.status : 'OK'
    });
  }

  function errResp(status, payload) {
    return resp(payload, { status: status });
  }

  function respondLater(promise) {
    var d = typeof CONFIG.delay === 'function' ? CONFIG.delay() : CONFIG.delay;
    if (!d) return Promise.resolve(promise);
    return new Promise(function (resolve) { setTimeout(function () { resolve(promise); }, d); });
  }

  function parseBody(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return raw;
  }

  /* ============================================================
     4. REST emulation (PostgREST conventions)
     ============================================================ */

  function handleRest(table, qs, method, body) {
    if (CONFIG.fail === 'rest' || CONFIG.fail === 'all') {
      return errResp(500, { message: 'MOCK REST failure', error: 'MOCK REST failure' });
    }
    var db = DB.rows;

    /* --- the scrubbed growth views (supabase-team-roles.sql, section 3) ---
       The dashboard reads these for every role except admin, so the mock
       has to serve them or the support/marketing walks read nothing and
       every modal comes up empty. It aliases each view onto its seeded base
       table and strips the SAME keys the SQL allow-lists, so the real read
       path is exercised and a scrubbed field that ever reached the UI would
       fail this harness instead of passing it. */
    var GROWTH_VIEW = {
      growth_demand_feed:  { from: 'demand_records',    keys: ['ref', 'roommate', 'type', 'budget', 'dist', 'when', 'age'],
                             flat: ['session', 'room_type', 'budget_band', 'distance', 'timing', 'age_band'] },
      growth_listing_feed: { from: 'listings',          keys: ['prop_name', 'ty', 'ar', 'rm', 'rent'],
                             flat: ['tier', 'opening_ask_ngn', 'listed_price_ngn', 'property_name', 'property_type', 'area', 'rooms'] },
      growth_scout_feed:   { from: 'scout_submissions', keys: ['area', 'vac'],
                             flat: ['area'] },
      growth_booking_feed: { from: 'booking_requests',  keys: ['when', 'roommate', 'listing_name'],
                             flat: [] }
    };

    if (GROWTH_VIEW[table]) {
      var spec = GROWTH_VIEW[table];
      return resp(clone(db[spec.from]).map(function (row) {
        var src = row.payload || {};
        var payload = {};
        spec.keys.forEach(function (k) { if (k in src) payload[k] = src[k]; });
        var out = { id: row.id, created_at: row.created_at, status: row.status, env: row.env, payload: payload };
        spec.flat.forEach(function (k) { if (k in row) out[k] = row[k]; });
        return out;
      }));
    }

    if (table === 'growth_roommate_summary') return resp(db.roommate_match_summary);
    if (table === 'minors_needing_guardian') return resp(db.minors_needing_guardian);
    if (table === 'roommate_match_summary') return resp(db.roommate_match_summary);
    if (TABLES.indexOf(table) === -1) return errResp(404, { message: 'Unknown table: ' + table });

    var rows = db[table];

    if (method === 'GET') {
      return resp(clone(rows));
    }

    if (method === 'POST') {
      var input = parseBody(body) || {};
      var items = Array.isArray(input) ? input : [input];
      var created = [];
      items.forEach(function (item) {
        var row = clone(item);
        row.id = nextId();
        row.created_at = nowIso();
        created.push(row);
      });
      rows.unshift.apply(rows, created);
      return resp(created);
    }

    if (method === 'PATCH') {
      var idMatch = /id=eq\.([^&]+)/.exec(qs || '');
      if (!idMatch) return errResp(405, { message: 'PATCH requires id=eq.<id>' });
      var patchId = decodeURIComponent(idMatch[1]);
      var patch = parseBody(body) || {};
      var updated = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === patchId) {
          Object.assign(rows[i], clone(patch));
          updated = rows[i];
          break;
        }
      }
      if (!updated) return errResp(406, { message: 'Row not found: ' + patchId });
      return resp([clone(updated)]);
    }

    if (method === 'DELETE') {
      var delMatch = /id=eq\.([^&]+)/.exec(qs || '');
      var delId = delMatch ? decodeURIComponent(delMatch[1]) : '';
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].id === delId) { rows.splice(j, 1); return resp({}); }
      }
      return errResp(406, { message: 'Row not found: ' + delId });
    }

    return errResp(405, { message: 'Method not mocked: ' + method });
  }

  /* ============================================================
     5. Auth / notify / team / strategy stubs
     ============================================================ */

  function handleAuth() {
    if (CONFIG.fail === 'auth') return errResp(400, { msg: 'Wrong email or password (mock).' });
    return resp({
      access_token: fakeToken(ROLE),
      refresh_token: 'mock-refresh',
      expires_in: EXPIRES_IN,
      user: { email: 'owner@arzuz.test', app_metadata: { role: ROLE } }
    });
  }

  function handleNotify(body) {
    if (CONFIG.fail === 'functions') return errResp(500, { error: 'MOCK function failure' });
    var b = parseBody(body) || {};
    if (b.action === 'status') return resp({ token: true, chatId: true });
    if (b.action === 'detect') return resp({ chatId: '552001122' });
    return resp({ ok: true });
  }

  function handleTeam(body) {
    if (CONFIG.fail === 'functions') return errResp(500, { error: 'MOCK function failure' });
    var b = parseBody(body) || {};
    var action = b.action || 'list';
    var users = DB.rows.team_users || (DB.rows.team_users = seedTeamUsers());

    if (action === 'list') return resp({ users: clone(users) });

    if (action === 'create') {
      var email = (b.email || '').toLowerCase();
      var exists = users.some(function (u) { return (u.email || '').toLowerCase() === email; });
      if (exists) return errResp(400, { error: 'A user with this email already exists (mock).' });
      users.unshift({ id: nextId(), email: b.email, role: b.role || '', confirmed: true, last_sign_in_at: null, seeded: false });
      return resp({ ok: true });
    }

    if (action === 'set_role') {
      var u1 = users.find(function (u) { return u.id === b.id; });
      if (u1) u1.role = b.role || '';
      return resp({ ok: true });
    }

    if (action === 'reset_password') return resp({ ok: true });

    if (action === 'delete') {
      DB.rows.team_users = users.filter(function (u) { return u.id !== b.id; });
      return resp({ ok: true });
    }

    return resp({ users: clone(users) });
  }

  /* The real pack lives in strategy/*.md served by a Netlify
     function. The mock serves short stand-in docs so the reader,
     active states and markdown rendering are fully testable. */
  var DOCS = {
    'README.md': {
      title: 'Strategy index',
      body: 'All seven frameworks and the order to run them in.\n\n## The order\n\n1. **Positioning** — pick the segment.\n2. **Channels** — bullseye the next 100 students.\n3. **Unit economics** — check LTV:CAC survives.\n\n> Mock document served by the dev harness.'
    },
    '05-positioning-stp.md': {
      title: 'Positioning — STP',
      body: 'Which segment first, and the sentence that wins it.\n\n## Segmentation\n\n| Segment | Size | Reachable |\n| --- | --- | --- |\n| Students, Malete | 5,000 | Yes |\n\n- First wedge: `Self-contain` near the gate.\n- Promise: no agent fees, ever.'
    },
    '06-channels-bullseye.md': {
      title: 'Channels — Bullseye',
      body: 'Where the next 100 students and 10 buildings come from.\n\n1. WhatsApp status loops\n2. One ambassador per hostel\n3. Flyer QR at the gate\n\n`?ref=` tags make every channel countable.'
    },
    '07-unit-economics-ltv-cac.md': {
      title: 'Growth model — funnel, LTV:CAC, churn',
      body: 'Does it survive scale; where users fall out.\n\n## Funnel\n\n1. See\n2. Register a demand\n3. Matched to a room\n4. Booking request\n5. Booked\n\n[ESTIMATE] numbers pending real records.'
    }
  };

  function handleStrategy(name) {
    if (CONFIG.fail === 'functions') return errResp(500, { error: 'MOCK function failure' });
    var doc = DOCS[name];
    if (!doc) return errResp(404, 'Not found');
    return resp('# ' + doc.title + '\n\n' + doc.body, { text: true });
  }

  /* ============================================================
     6. fetch wrapper
     ============================================================ */

  var realFetch = window.fetch;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var body = init && init.body;

    /* Real network for maps, tiles, fonts and the CDN. */
    if (/leaflet|unpkg|routing\.openstreetmap|tile\.|openstreetmap\.org|fonts/i.test(url)) {
      return realFetch.apply(this, arguments);
    }

    /* --- Netlify functions (relative routes) --- */
    if (url.indexOf('/api/notify') === 0) return respondLater(handleNotify(body));
    if (url.indexOf('/api/team') === 0) return respondLater(handleTeam(body));
    if (url.indexOf('/api/cloudinary-sign') === 0) {
      return respondLater(errResp(503, { error: 'Uploads are not mocked — paste direct media URLs in mock mode.' }));
    }
    if (url.indexOf('/api/youtube-upload-start') === 0) {
      /* exercise the real code path: admin.js falls back to the
         (also unmocked) Cloudinary signer and surfaces its error */
      return respondLater(errResp(503, { error: 'YouTube uploads are not configured on the server yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN).' }));
    }
    if (url.indexOf('/api/video-embed/') === 0) {
      return respondLater(errResp(404, { error: 'Embed proxy is not mocked — playback needs a deployed site.' }));
    }
    if (url.indexOf('/strategy-docs') === 0) {
      var nameParam = new URLSearchParams(url.split('?')[1] || '').get('name');
      return respondLater(handleStrategy(nameParam || 'README.md'));
    }

    /* --- Supabase auth + REST (absolute, config origin) --- */
    var SUPA_ROOT = ((window.ARZUZ_CONFIG && window.ARZUZ_CONFIG.SUPABASE_URL) || '').replace(/\/+$/, '');
    var SUPA_REST = SUPA_ROOT + '/rest/v1/';
    var SUPA_AUTH = SUPA_ROOT + '/auth/v1/';

    if (url.indexOf(SUPA_AUTH) === 0) return respondLater(handleAuth());

    if (url.indexOf(SUPA_REST) === 0) {
      var after = url.slice(SUPA_REST.length);
      var table = after.split('?')[0];
      var qs = after.indexOf('?') !== -1 ? after.slice(after.indexOf('?') + 1) : '';
      return respondLater(handleRest(table, qs, method, body));
    }

    /* Anything else (should be nothing) goes to the real network. */
    return realFetch.apply(this, arguments);
  };

  /* data.js fetched the amenities table before this wrapper existed,
     so re-read it through the mock now that the wrapper is live. */
  if (window.ArzuzData && window.ArzuzData.reload) {
    try { window.ArzuzData.reload(); } catch (e) { /* ignore */ }
  }

  /* the env badge would keep saying PRODUCTION DB while every byte of
     traffic is served by this harness — relabel it so nobody testing
     on ?mock=1 believes they are writing to live data. The badge is
     rendered when the gate opens, so check a couple of times. */
  [400, 1200].forEach(function (ms) {
    setTimeout(function () {
      var env = document.getElementById('envBadge');
      if (env && env.textContent === 'PRODUCTION DB') { env.textContent = 'MOCK DB'; env.className = 'admin-badge warn'; }
    }, ms);
  });

  /* ============================================================
     7. Scenario switcher
     ============================================================ */

  window.__MOCK__ = {
    role: function (r) {
      if (['admin', 'support', 'marketing'].indexOf(r) === -1) { log('unknown role:', r); return ROLE; }
      ROLE = r;
      try { sessionStorage.setItem(ROLE_KEY, r); } catch (e) { /* ignore */ }
      location.reload();
      return r;
    },
    empty: function () {
      var db = DB.rows;
      TABLES.forEach(function (t) { db[t] = []; });
      db.minors_needing_guardian = [];
      db.roommate_match_summary = [];
      log('database emptied — press Refresh in the dashboard');
    },
    slow: function (ms) {
      CONFIG.delay = ms || 1200;
      log('latency set to', CONFIG.delay, 'ms');
    },
    error: function (kind) {
      CONFIG.fail = kind || 'rest';
      log('injected failures:', CONFIG.fail);
    },
    reset: function () {
      CONFIG.delay = 0;
      CONFIG.fail = null;
      DB.rows = window.ArzuzMockData.seed();
      DB.rows.team_users = seedTeamUsers();
      log('database + scenario reset — press Refresh in the dashboard');
    },
    stats: function () {
      var db = DB.rows;
      var out = {};
      TABLES.forEach(function (t) { out[t] = db[t].length; });
      out.minors_needing_guardian = db.minors_needing_guardian.length;
      out.team_users = (db.team_users || []).length;
      out.role = ROLE;
      out.delay = CONFIG.delay;
      out.fail = CONFIG.fail;
      log('stats:', out);
      return out;
    },
    db: function () { return DB.rows; }
  };

  log('harness ready — role:', ROLE.toUpperCase(), '· try __MOCK__.stats()');
})();
