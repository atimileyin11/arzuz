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
  /* Every relation `__MOCK__.empty()` clears and `__MOCK__.stats()`
     counts. The three roommate relations are listed here for exactly
     that reason — their read is role-gated below, before the generic
     path. */
  var TABLES = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets', 'amenities',
                'roommate_profiles', 'roommate_interests', 'roommate_events',
                'care_plans', 'care_credit_events',
                'repair_claims', 'claim_events'];

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

  /* ?seed=worst boots the break-ui fixture (see dev/admin-mock-data.js
     → worst()). The dashboard is the real dashboard either way — only
     the rows change, which is the point: the failures worth finding are
     the rows that are valid, saved, and invisible. */
  var SEED_KIND = params.get('seed') === 'worst' ? 'worst' : 'demo';

  function seedRows(kind) {
    if (kind === 'worst' && window.ArzuzMockData.worst) return window.ArzuzMockData.worst();
    return window.ArzuzMockData.seed();
  }

  var DB = { rows: seedRows(SEED_KIND), seq: 100 };

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

  /* The roommate pool is the only relation the dashboard asks PostgREST
     to filter server-side (?env=eq.production), so it is the only one
     that needs the filter semantics here. Applying them to every table
     would quietly change what the other sections read. Returning the
     test-env profile to a production query would make the panel look
     right while hiding the very filter it exists to exercise. */
  function filterRoommateRows(rows, qs) {
    var params = new URLSearchParams(qs || '');
    var out = rows.slice();

    ['env', 'status'].forEach(function (key) {
      var v = params.get(key);
      if (!v) return;
      if (v.indexOf('eq.') === 0) out = out.filter(function (r) { return r[key] === v.slice(3); });
      else if (v.indexOf('neq.') === 0) out = out.filter(function (r) { return r[key] !== v.slice(4); });
    });

    var idFilter = params.get('id');
    if (idFilter && idFilter.indexOf('in.(') === 0) {
      var ids = idFilter.slice(4, -1).split(',');
      out = out.filter(function (r) { return ids.indexOf(r.id) !== -1; });
    }

    /* or=(actor_ref.eq.X,subject_ref.eq.X) — the student dossier asks for
       "either side of this student" in a single request. Only eq terms are
       honoured, because that is all the dashboard sends; a richer or= would
       need PostgREST's full grammar to emulate honestly. */
    var orFilter = params.get('or');
    if (orFilter) {
      var terms = orFilter.replace(/^\(/, '').replace(/\)$/, '').split(',');
      out = out.filter(function (r) {
        return terms.some(function (t) {
          var m = /^([a-z_]+)\.eq\.(.*)$/.exec(t);
          return m ? String(r[m[1]]) === m[2] : false;
        });
      });
    }

    /* order=created_at.desc is what the panel asks for */
    out.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });

    var limit = params.get('limit');
    if (limit && /^\d+$/.test(limit)) out = out.slice(0, Number(limit));
    return out;
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

    /* Arzuz Care (supabase-care.sql). The dashboard reads the VIEW, never
       the ledger, so the mock serves care_plans_live and keeps the sum in
       one place — a balance that disagreed with its events would be the
       exact bug the real view exists to make impossible. */
    if (table === 'care_plans_live' || table === 'care_credit_balance') return resp(db.care_plans_live);
    if (table === 'care_plans') return resp(db.care_plans);
    if (table === 'care_credit_events') return resp(db.care_credit_events);

    if (table === 'growth_roommate_summary') return resp(db.roommate_match_summary);
    if (table === 'minors_needing_guardian') return resp(db.minors_needing_guardian);
    if (table === 'roommate_match_summary') return resp(db.roommate_match_summary);

    /* The questionnaire engine's own two views (supabase-roommate.sql).
       security_invoker, so they need a grant on the base tables — which
       only the admin holds, but they are served for any role here so the
       panel can be opened under each login and the difference seen. */
    if (table === 'roommate_engine_summary') return resp(db.roommate_engine_summary || []);
    if (table === 'roommate_mutual_pairs') return resp(db.roommate_mutual_pairs || []);

    /* The pool itself is scoped with public.arzuz_role(), and the table
       GRANT belongs to `authenticated` — so a support or marketing token
       is refused by ROW LEVEL SECURITY, which PostgREST reports as 200
       with an empty array, NOT 403. Answering 403 here would be a lie
       (that status means a missing grant) and would send admin.js down
       its auth-error path and sign the tester out. Only the main admin
       ever sees rows — which is the whole reason the panel is
       admin-only. */
    if (table === 'roommate_profiles' || table === 'roommate_interests') {
      if (ROLE !== 'admin') return resp([]);
      if (method === 'GET') return resp(clone(filterRoommateRows(db[table], qs)));
    }

    /* The consent trail is APPEND-ONLY, and the database says so: the
       table grants `authenticated` SELECT and nothing else, so no login —
       not even admin — can edit history. Refusing a write here rather
       than falling through to the generic handlers below is deliberate:
       the generic path would happily accept a POST and the harness would
       then pass a dashboard bug that tries to rewrite the trail. */
    if (table === 'roommate_events') {
      if (ROLE !== 'admin') return resp([]);
      if (method === 'GET') return resp(clone(filterRoommateRows(db.roommate_events, qs)));
      return errResp(403, {
        message: 'roommate_events is append-only: no client role may insert, update or delete',
        error: 'append-only'
      });
    }

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

  /* ------------------------------------------------------------
     THE VERIFICATION SHIFT (supabase-verification-queue.sql)

     Mocked here because the officer's queue is a SURFACE the dashboard
     draws, and a panel that cannot be drawn in this harness is a panel
     nothing ever checks. What is mocked is only what the PAGE has to
     handle: the role gate, the claim's two refusals, the queue's shape,
     and the fact that a take moves assigned_to/taken_at and nothing else.
     The SQL's own guards are proved against real Postgres in
     dev/sql-proof.mjs — not re-implemented here.

     `__MOCK__.lateListing(n)` back-dates the oldest open listings so the
     overdue path (the marking, the ordering, the counts) is reachable
     without waiting 72 hours for a fixture to age. */
  function openListings() {
    return (DB.rows.listings || []).filter(function (r) {
      var tier = Number(r.tier) || 0;
      var status = String(r.status || '').toLowerCase();
      return tier === 0 && ['pending', 'active', 'new'].indexOf(status) !== -1;
    });
  }

  function queueRow(r) {
    var held = !!(r.assigned_to && String(r.assigned_to) !== '');
    var stageSince = held ? (r.taken_at || r.created_at) : (r.created_at);
    var p = r.payload || {};
    return {
      id: r.id,
      ref: r.ref || r.ap_ref || shortMockId(r.id),
      apt_id: p.apt_id || p.custom_id || null,
      area: p.area || p.ar || null,
      status: r.status,
      tier: Number(r.tier) || 0,
      taken_by: r.assigned_to || null,
      taken_at: r.taken_at || null,
      created_at: r.created_at,
      stage: held ? 'visit' : 'queue',
      stage_since: stageSince,
      scout_reports: 0,
      last_nudged_at: null,
    };
  }

  function shortMockId(id) { return String(id || '').slice(0, 8); }

  function handleRpc(name, body) {
    if (CONFIG.fail === 'rest') return errResp(503, { message: 'MOCK REST failure' });
    var req = parseBody(body) || {};

    if (name === 'verification_queue') {
      if (ROLE !== 'verification' && ROLE !== 'admin' && ROLE !== 'service_role') {
        return errResp(403, { message: 'permission denied for function verification_queue' });
      }
      return resp(openListings().map(queueRow));
    }

    if (name === 'listing_take' || name === 'listing_release') {
      if (ROLE !== 'verification' && ROLE !== 'admin' && ROLE !== 'service_role') {
        return errResp(403, { message: 'permission denied for function ' + name });
      }
      var row = (DB.rows.listings || []).filter(function (r) { return r.id === req.p_id; })[0];
      if (!row) return errResp(404, { message: 'listing_take: no listing with id ' + req.p_id + '.' });
      var me = 'mock-' + ROLE + '@arzuz.com';
      if (name === 'listing_take') {
        /* THE CODES AND STATUSES POSTGREST ACTUALLY SENDS. The raises carry
           22023 (bad state) and 42501 (insufficient privilege), and PostgREST
           maps those to 400 and 403 — NOT to P0001, which is the unhandled
           default. A mock that answered P0001/400 for all of them would let a
           page pass while mis-reading the one refusal that arrives as a 403. */
        if (Number(row.tier) > 0) {
          return errResp(400, { code: '22023', message: 'listing_take: that listing has already been decided (tier ' + row.tier + '). Nothing was changed.' });
        }
        if (row.assigned_to && row.assigned_to !== me) {
          return errResp(400, { code: '22023', message: 'listing_take: ' + row.assigned_to + ' already has that listing. Ask them to release it rather than starting a second visit.' });
        }
        row.assigned_to = me;
        row.taken_at = nowIso();
        return resp({ id: row.id, stage: 'visit', taken_by: row.assigned_to, taken_at: row.taken_at });
      }
      if (!row.assigned_to) {
        return errResp(400, { code: '22023', message: 'listing_release: that listing is not held by anybody — it is already in the queue. Nothing was changed.' });
      }
      /* An officer may give back what they hold; an admin may give back
         anything. The SQL draws that line, so the replay has to draw it
         too, or the harness would praise a release the database refuses.
         This raise is 42501, so PostgREST answers **403** — the page has to
         read the function's sentence before it reads the status, or an
         officer pressing Release on somebody else's listing is signed out. */
      if (ROLE === 'verification' && row.assigned_to !== me) {
        return errResp(403, { code: '42501', message: 'listing_release: ' + row.assigned_to + ' holds that listing, not you. An admin can release it.' });
      }
      row.assigned_to = null;
      row.taken_at = null;
      return resp({ id: row.id, stage: 'queue', released_by: me });
    }

    if (name === 'verification_nudge') {
      /* The chaser's own line, service-role only in the SQL. Nothing in
         the dashboard calls it, so an authenticated login must not be
         able to: this branch exists to be refused. */
      return errResp(403, { message: 'verification_nudge: a ' + ROLE + ' login may not write to the verification trail.' });
    }

    if (name === 'status_history') {
      /* supabase-status-history.sql §5, as the harness sees it: the desk
         and an admin, and nobody else — asserted as a 403 so a panel
         drawn for the wrong login fails here rather than in production.
         The ANSWER below is fixture, and deliberately the interesting
         shape rather than a tidy one: a code that WhatsApp refused and
         the mailbox then delivered, and a used one before it. */
      if (ROLE !== 'support' && ROLE !== 'admin' && ROLE !== 'service_role') {
        return errResp(403, { code: '42501',
          message: 'status_history: a ' + ROLE + ' login may not read a reference code history.' });
      }
      /* THE QUERY IS THE ARGUMENT, not a reference — supabase-status-history.sql
         §5 reads it as the whole reference, the end of one, the start of one,
         or a phone number. The harness reproduces that reading rather than
         assuming it, because the panel branches on `lookup` and on
         `ambiguous`, and a mock that only ever answered the whole-reference
         case would leave both branches untested. */
      var want  = String(req.p_query || '').trim();
      var upper = want.toUpperCase();
      var compact = upper.replace(/[^0-9A-Za-z]/g, '');
      var digits = want.replace(/\D/g, '');
      var look = 'none';
      if (/[A-Z]/.test(compact)) {
        if (/^ARZ[SL][0-9A-F]{12}$/.test(compact)) look = 'ref';
        else if (compact.indexOf('ARZ') === 0) {
          if (compact.length >= 8 && compact.length < 16) look = 'head';
        } else if (compact.length >= 3 && compact.length <= 15) look = 'tail';
      } else if (digits.length >= 10 && digits.length <= 15) look = 'phone';
      /* ALL DIGITS AND TOO FEW TO BE A NUMBER — so the only other thing it
         can be is the end of a reference that is all digits. Same rule as
         §5, and the case that made this fixture set worth rebuilding: the
         four characters of a reference whose last group is all decimal
         used to be refused as "too short", which is roughly one reference
         in seven. */
      else if (digits.length >= 3 && digits.length <= 9) look = 'tail';

      if (!want) return resp({ ok: false, reason: 'no-ref' });
      if (look === 'none') {
        return resp({ ok: true, query: want, lookup: 'none', ref: null, kind: null,
          known_reference: false, ambiguous: false, matches: [], more: false,
          codes: [], asked_last_hour: 0, now: new Date().toISOString() });
      }

      /* A REFERENCE IS HEX: 'ARZ-[SL]' then twelve characters from 0-9A-F.
         The first fixture here was 'ARZ-S-4K2M-9XQP-7T3B', which has a K,
         an M, a Q, an X, a P and a T in it — not a reference this site can
         mint, and one the old whole-string lookup answered happily because
         it never checked the shape. It was caught the moment the function
         learned to read the shape, which is the argument for reading it
         there and not in the panel.

         THREE references, chosen so that every branch has a real case:
         A and B share a HEAD (asking for the start of one fits both), and
         A and C share a TAIL. A's last group is 9021 — ALL DECIMAL — so
         the all-digit fragment that used to be refused is exercised by a
         fragment that really is the end of a reference, and the mock now
         MATCHES rather than assuming: a fragment nothing ends with gets
         the same "no match" a real registry would give it. */
      var REF_A = 'ARZ-S-4A2B-9C11-9021';   // student
      var REF_B = 'ARZ-S-4A2B-7F3E-1111';   // student, same head as A
      var REF_C = 'ARZ-L-8C1E-2A9D-9021';   // landlord, same tail as A
      var ALL = [REF_A, REF_B, REF_C];
      var COMPACT = function (r) { return r.replace(/-/g, ''); };
      var endsWith = function (q) {
        return ALL.filter(function (r) { return COMPACT(r).slice(-q.length) === q; });
      };
      var startsWith = function (q) {
        return ALL.filter(function (r) { return COMPACT(r).indexOf(q) === 0; });
      };

      var now = Date.now();
      var iso = function (ms) { return new Date(ms).toISOString(); };

      /* The candidates this query fits, or null when the reading is one
         that does not search the registry. */
      var fits = null;
      if (look === 'tail')  fits = endsWith(compact);
      if (look === 'head')  fits = startsWith(compact);
      /* The number on the row is not modelled, so a number resolves to the
         reference the fixture data hangs off — except the shared one,
         which is how "two students on one number" is reachable at all. */
      if (look === 'phone') fits = digits.slice(-4) === '9999' ? [REF_A, REF_C] : [REF_A];

      if (look === 'ref') fits = ALL.indexOf(upper) === -1 ? [] : [upper];

      if (look !== 'ref' && fits && !fits.length) {
        return resp({ ok: true, query: want, lookup: look, ref: null, kind: null,
          known_reference: false, ambiguous: false, matches: [], more: false,
          codes: [], asked_last_hour: 0, now: iso(now) });
      }

      var kindOf = function (r) {
        return r.indexOf('-S-') !== -1 ? 'student' : (r.indexOf('-L-') !== -1 ? 'landlord' : null);
      };

      /* A FRAGMENT THAT FITS MORE THAN ONE resolves to neither. Both
         cases are real: A and C genuinely both end 9021 (and it is four
         DECIMAL characters, the case that used to be refused), and A and
         B genuinely both start ARZS4A2B. */
      if (fits && fits.length > 1) {
        return resp({
          ok: true, query: want, lookup: look, ref: null, kind: null,
          known_reference: false, ambiguous: true, more: false,
          matches: fits.map(function (r, i) {
            return { ref: r, kind: kindOf(r), asked_at: iso(now - (i + 1) * 9 * 60000) };
          }),
          codes: [], asked_last_hour: 0, now: iso(now)
        });
      }

      /* One match resolves — typed in full, or found by its end, its
         start, or the number on the row. A ref that matches nothing (a
         real-shaped reference nobody minted) reports so rather than
         resolving to a fixture. */
      var resolved = fits && fits.length === 1 ? fits[0] : (look === 'ref' ? upper : null);
      if (!resolved) {
        return resp({ ok: true, query: want, lookup: look, ref: null, kind: null,
          known_reference: false, ambiguous: false, matches: [], more: false,
          codes: [], asked_last_hour: 0, now: iso(now) });
      }
      var kind = kindOf(resolved);
      return resp({
        ok: true,
        query: want,
        lookup: look,
        ref: resolved,
        kind: kind,
        known_reference: !!kind,
        ambiguous: false,
        matches: [],
        more: false,
        asked_last_hour: 2,
        now: iso(now),
        codes: [
          {
            id: 2, asked_at: iso(now - 3 * 60000), expires_at: iso(now + 7 * 60000),
            attempts: 1, max_attempts: 5, attempts_left: 4, used_at: null, live: true,
            deliveries: [
              { channel: 'whatsapp', outcome: 'refused', note: 'openwa-refused', at: iso(now - 3 * 60000) },
              { channel: 'email', outcome: 'sent', note: null, at: iso(now - 3 * 60000) }
            ]
          },
          {
            id: 1, asked_at: iso(now - 26 * 60 * 60000), expires_at: iso(now - 26 * 60 * 60000 + 600000),
            attempts: 1, max_attempts: 5, attempts_left: 0, used_at: iso(now - 26 * 60 * 60000 + 90000),
            live: false,
            deliveries: [
              { channel: 'whatsapp', outcome: 'sent', note: null, at: iso(now - 26 * 60 * 60000) }
            ]
          }
        ]
      });
    }

    return errResp(404, { message: 'MOCK: no such function ' + name });
  }

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
     5b. The books

     The Finance screen's one promise is that its figures RECONCILE, and
     a mock that returned hand-written totals could never fail that
     promise — so it would prove nothing. This one keeps a small
     DOUBLE-ENTRY journal and derives the report out of it, using the
     same three posting patterns the real writers use:

       a sale        cash debit      / unearned credit   (finance.js)
       a repair      expense debit   / payable credit    (claims.js)
       a refund      cash credit     / refund debit       (finance.js)

     Every one of those pairs keeps the identity the screen checks, so a
     balanced panel means the arithmetic is right — and
     __MOCK__.financeOneSided() halves a pair, which must make the screen
     say so rather than round the difference away.
     ============================================================ */

  /* Set by __MOCK__.handoverFails(): the answer the real function gives
     when the worker's WhatsApp was refused. */
  var HANDOVER_FAILS = false;
  /* Set by __MOCK__.handoverUnreported(): the answer when the notice blew
     up before any channel ran — the function's tryNotify catch, which
     returns no channel words at all. The panel has nothing to report and
     must not invent a delivery. */
  var HANDOVER_UNREPORTED = false;

  var FINANCE = {
    journal: [
      /* a Care Pass sold: cash taken, the obligation recorded */
      { business_line: 'care', account: 'cash', direction: 'debit', amount_kobo: 2000000 },
      { business_line: 'care', account: 'unearned', direction: 'credit', amount_kobo: 2000000 },
      /* two repairs done: what they cost, and what we owe the workers */
      { business_line: 'care', account: 'expense', direction: 'debit', amount_kobo: 180000 },
      { business_line: 'care', account: 'payable', direction: 'credit', amount_kobo: 180000 },
      { business_line: 'care', account: 'expense', direction: 'debit', amount_kobo: 50000 },
      { business_line: 'care', account: 'payable', direction: 'credit', amount_kobo: 50000 }
    ],
    referrals: [
      { status: 'under_review', claims: 2, reward_kobo: 200000, first_at: '2026-10-02T09:00:00.000Z', last_at: '2026-10-09T09:00:00.000Z' },
      { status: 'payout_pending', claims: 1, reward_kobo: 100000, first_at: '2026-10-04T09:00:00.000Z', last_at: '2026-10-04T09:00:00.000Z' },
      { status: 'paid', claims: 1, reward_kobo: 100000, first_at: '2026-09-28T09:00:00.000Z', last_at: '2026-09-28T09:00:00.000Z' }
    ],
    orders: { 'care:paid': 3, 'care:pending': 1 }
  };

  /* business_line_summary + referral_report + the payments tally, in the
     shape netlify/functions/finance.js assembles them. The account sums
     are direction-filtered exactly as the views are — including refunds,
     costs and payable, which those views sum WITHOUT a direction filter. */
  function financeReport() {
    var lines = {};
    FINANCE.journal.forEach(function (e) {
      var line = lines[e.business_line] || (lines[e.business_line] = {
        cash_in_kobo: 0, cash_out_kobo: 0, revenue_kobo: 0,
        unearned_added_kobo: 0, unearned_released_kobo: 0, refunds_kobo: 0,
        costs_kobo: 0, payable_kobo: 0
      });
      var n = Number(e.amount_kobo) || 0;
      if (e.account === 'cash' && e.direction === 'debit') line.cash_in_kobo += n;
      if (e.account === 'cash' && e.direction === 'credit') line.cash_out_kobo += n;
      if (e.account === 'revenue' && e.direction === 'credit') line.revenue_kobo += n;
      if (e.account === 'unearned' && e.direction === 'credit') line.unearned_added_kobo += n;
      if (e.account === 'unearned' && e.direction === 'debit') line.unearned_released_kobo += n;
      if (e.account === 'refund') line.refunds_kobo += n;
      if (e.account === 'expense') line.costs_kobo += n;
      if (e.account === 'payable') line.payable_kobo += n;
    });

    Object.keys(lines).forEach(function (k) {
      var l = lines[k];
      l.unearned_kobo = l.unearned_added_kobo - l.unearned_released_kobo;
      l.contribution_margin_kobo = l.revenue_kobo - l.costs_kobo;
    });

    return {
      ok: true,
      housing: { listing_fee_kobo: 0, rent_commission_bps: 0, revenue_kobo: (lines.housing && lines.housing.revenue_kobo) || 0 },
      lines: lines,
      referrals: FINANCE.referrals.slice(),
      orders: Object.assign({}, FINANCE.orders),
      storage_enabled: false
    };
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

    /* Arzuz Care (netlify/functions/care-credit.js).

       The mock enforces the same three things the real function does —
       the role gate, the 4-call-out ceiling, and the published refund
       window (no refund once a call-out has been used) — because those
       are what the dashboard has to handle. The amounts, the ledger
       shape and the CHECK-constraint rules are NOT re-implemented here:
       those belong to scripts/test-care.mjs and to dev/sql-proof.mjs,
       which run the real function and the real constraints. */
    if (url.indexOf('/api/care-credit') === 0) {
      if (ROLE === 'marketing') {
        return respondLater(errResp(403, { error: 'Only the admin and support logins may record Care credits.' }));
      }
      var care = DB.rows;
      var careReq = {};
      try { careReq = JSON.parse(body || '{}'); } catch (e) { careReq = {}; }
      var act = String(careReq.action || '').toLowerCase();
      var target = care.care_plans.filter(function (p) { return p.id === careReq.plan_id; })[0];
      var careRows = function (id) { return care.care_credit_events.filter(function (e) { return e.plan_id === id; }); };
      var careBalance = function (id) { return careRows(id).reduce(function (n, e) { return n + e.delta; }, 0); };
      var appendCare = function (plan, event, delta, extra) {
        var row = Object.assign({
          id: care.care_credit_events.length + 1,
          created_at: nowIso(),
          plan_id: plan.id, student_name: plan.first_name, session: plan.session,
          event: event, delta: delta, reason: null, worker: null, parts_ngn: null,
          note: null, actor_ref: 'mock-user', actor_name: 'owner', env: plan.env
        }, extra || {});
        care.care_credit_events.unshift(row);
        plan.last_event_at = row.created_at;
        carePlansLive();
        return row;
      };
      /* Recomputed the way the SQL view recomputes it: from the events. */
      function carePlansLive() {
        care.care_plans_live = care.care_plans.map(function (p) {
          var rows = careRows(p.id);
          var bal = rows.reduce(function (n, e) { return n + e.delta; }, 0);
          return Object.assign({}, p, {
            balance: bal,
            granted: rows.filter(function (e) { return e.event === 'granted'; }).reduce(function (n, e) { return n + e.delta; }, 0),
            call_outs: rows.filter(function (e) { return e.event === 'spent'; }).length,
            has_credits: bal > 0,
            last_event_at: rows.length ? rows[0].created_at : null
          });
        }).sort(function (x, y) { return String(y.created_at).localeCompare(String(x.created_at)); });
      }

      /* Opening a plan. The mock normalises the phone number and
         refuses a second active plan for the same student exactly as
         the function does, because those two rules are what the
         dashboard's confirmation and its refusal message are about. */
      if (act === 'grant') {
        var gp = careReq.payload || {};
        if (!gp.name || !gp.phone) {
          return respondLater(errResp(400, { error: 'A plan needs a student: send payload.name and payload.phone.' }));
        }
        var gPhone = String(gp.phone).replace(/[^0-9]/g, '');
        if (gPhone.charAt(0) === '0') gPhone = '234' + gPhone.slice(1);
        if (!/^234\d{10}$/.test(gPhone)) {
          return respondLater(errResp(400, { error: 'payload.phone must be a Nigerian mobile number — 08031112233 or +2348031112233.' }));
        }
        var gSession = careReq.session || '2026/2027';
        var clash = care.care_plans.filter(function (x) {
          return x.session === gSession && x.status === 'active' && x.phone === gPhone;
        })[0];
        if (clash) {
          return respondLater(errResp(409, {
            error: gp.name + ' already has an active Care plan for ' + gSession +
              '. Refund or end that one first — a second plan would double the call-outs.'
          }));
        }
        var gCredits = Number(careReq.credits) > 0 ? Math.round(Number(careReq.credits)) : 4;
        var gAmount = Number(careReq.amount_ngn) > 0 ? Math.round(Number(careReq.amount_ngn)) : 20000;
        var gToken = 'mockcare' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        var newPlan = {
          id: 'care-' + (++DB.seq), created_at: nowIso(), session: gSession, env: 'production',
          status: 'active', amount_ngn: gAmount, first_name: gp.name, phone: gPhone,
          area: gp.area || null, property: null, notes: null,
          payload: { name: gp.name, phone: gPhone, area: gp.area || null, room: gp.room || null },
          token_hash: 'mock-hash-' + gToken
        };
        care.care_plans.unshift(newPlan);
        appendCare(newPlan, 'granted', gCredits, {
          reason: careReq.reason || ('Care for ' + gSession + ' — ' + gCredits + ' call-outs, ' + gAmount + ' naira paid'),
          actor_name: ROLE === 'admin' ? 'owner' : 'support'
        });
        return respondLater(resp({
          ok: true, plan_id: newPlan.id, token: gToken, credits: gCredits, balance: gCredits,
          session: gSession, amount_ngn: gAmount, student_name: gp.name, phone: gPhone,
          link_path: '/my-care?t=' + gToken
        }, { status: 201 }));
      }

      if (act === 'spend') {
        if (!target) return respondLater(errResp(404, { error: 'No such Care plan.' }));
        if (target.status === 'refunded') {
          return respondLater(errResp(409, { error: 'That session was refunded — there is nothing to spend.' }));
        }
        var left = careBalance(target.id);
        if (left <= 0) {
          return respondLater(errResp(409, {
            error: 'No call-outs left on this plan. Care covers 4 per session — agree anything further with the student before sending a worker.'
          }));
        }
        var parts = Number(String(careReq.parts_ngn === undefined || careReq.parts_ngn === '' ? 0 : careReq.parts_ngn).replace(/[^0-9]/g, '')) || 0;
        appendCare(target, 'spent', -1, {
          worker: careReq.worker || null, parts_ngn: parts,
          reason: careReq.reason || null,
          note: parts > 3000 ? 'Parts over the included 3000 naira ceiling — quote the student before the work.' : null
        });
        return respondLater(resp({ ok: true, plan_id: target.id, balance: careBalance(target.id),
          call_outs: careRows(target.id).filter(function (e) { return e.event === 'spent'; }).length,
          parts_over_ceiling: parts > 3000 }));
      }

      if (act === 'refund' || act === 'expire') {
        if (!target) return respondLater(errResp(404, { error: 'No such Care plan.' }));
        var spare = careBalance(target.id);
        if (act === 'refund' && target.status === 'refunded') {
          return respondLater(errResp(409, { error: 'That plan is already refunded.' }));
        }
        if (act === 'refund' && careRows(target.id).some(function (e) { return e.event === 'spent'; })) {
          return respondLater(errResp(409, {
            error: 'This plan has already used a call-out, so it is past the full-refund window on care.html.'
          }));
        }
        if (spare > 0) {
          appendCare(target, act === 'refund' ? 'refunded' : 'expired', -Math.abs(spare), {
            reason: act === 'refund' ? 'Refunded before the session started' : 'Session ended with credits unused'
          });
        }
        target.status = act === 'refund' ? 'refunded' : 'ended';
        carePlansLive();
        return respondLater(resp({ ok: true, plan_id: target.id, balance: 0, voided: spare, already_empty: spare === 0 }));
      }

      return respondLater(errResp(400, {
        error: 'Unknown action. The team\u2019s are: grant, spend, refund, expire, adjust ' +
          '(the student\u2019s two — view and request — take a link, not a session).'
      }));
    }

    /* The digest preview (netlify/functions/roommate-digest-preview.js).
       Role-gated to the two logins that may read the pool, and it NEVER
       sends anything — the same two promises the real function makes.

       The text below is deliberately NOT a re-implementation of the
       digest: composing it twice would mean the harness proves the
       mock's arithmetic and not the server's. What is shaped like the
       real message here is only its envelope, because that is what the
       dashboard renders; the counts and the staleness rule are covered
       by the engine suite against the real function. */
    if (url.indexOf('/api/roommate-digest-preview') === 0) {
      if (ROLE === 'marketing') {
        return respondLater(errResp(403, { error: 'Only the admin and support logins may read the roommate digest.' }));
      }
      var db = DB.rows;
      var since = Date.now() - 24 * 36e5;
      var inbox = db.roommate_events.filter(function (e) {
        return String(e.env) === 'production' && Date.parse(e.created_at) >= since;
      });
      var kind = function (n) { return inbox.filter(function (e) { return e.event === n; }).length; };
      var pairs = db.roommate_mutual_pairs || [];
      var open = db.roommate_profiles.filter(function (p) { return p.status === 'open'; }).length;
      var body = [
        '\ud83d\udcca <b>Roommate digest</b> \u2014 the last 24 hours',
        '',
        '\u2022 <b>Questionnaires completed:</b> ' + kind('created'),
        '\u2022 <b>Accepts:</b> ' + kind('accept') + ' \u00b7 <b>Passes:</b> ' + kind('pass') + ' \u00b7 <b>Matches:</b> ' + kind('matched'),
        '\u2022 <b>Pool:</b> ' + db.roommate_profiles.length + ' in \u00b7 ' + open + ' still waiting \u00b7 ' + pairs.length + ' mutual matches',
        '',
        '(MOCK HARNESS \u2014 this is the shape of the message, not the server\u2019s numbers.)'
      ].join('\n');
      return respondLater(resp({
        ok: true,
        role: ROLE,
        would_send: true,
        quiet_pairs: 0,
        half_quiet_pairs: 0,
        counts: { created: kind('created'), accept: kind('accept'), pass: kind('pass'), withdrawn: kind('withdrawn'), matched: kind('matched') },
        pool: { total: db.roommate_profiles.length, open: open, mutual: pairs.length },
        window_hours: 24,
        stale_days: 3,
        text: body
      }));
    }

    /* Finance (netlify/functions/finance.js). Read is admin + support;
       money only moves for admin — the same two rules the function
       enforces, because those are the ones the screen branches on. */
    if (url.indexOf('/api/finance') === 0) {
      if (ROLE === 'marketing') {
        return respondLater(errResp(403, { error: 'Only the admin and support logins may open the finance books.' }));
      }
      var finReq = {};
      try { finReq = JSON.parse(body || '{}'); } catch (e) { finReq = {}; }
      var finAct = String(finReq.action || '').toLowerCase();

      if (finAct === 'report') return respondLater(resp(financeReport()));

      if (['refund', 'referral_decide', 'publish_terms', 'set_config'].indexOf(finAct) !== -1 && ROLE !== 'admin') {
        return respondLater(errResp(403, { error: 'Only the admin login may change prices, terms, refunds and referral payouts.' }));
      }

      if (finAct === 'refund') {
        if (!String(finReq.reference || '').trim()) {
          return respondLater(errResp(400, { error: 'Send the payment reference to refund.' }));
        }
        var finAmount = Number(finReq.amount_kobo) > 0 ? Math.round(Number(finReq.amount_kobo)) : 2000000;
        /* The reversal PAIR, like the function posts: cash back out, the
           obligation released. Posting one of these two would be the bug
           the reconciliation exists to catch. */
        FINANCE.journal.push(
          { business_line: 'care', account: 'cash', direction: 'credit', amount_kobo: finAmount },
          { business_line: 'care', account: 'refund', direction: 'debit', amount_kobo: finAmount }
        );
        return respondLater(resp({
          ok: true, reference: finReq.reference, refunded_kobo: finAmount,
          provider_refund_ref: 'MOCK-TRF-' + Date.now().toString(36)
        }));
      }

      if (finAct === 'referral_decide') {
        if (!String(finReq.id || '').trim()) return respondLater(errResp(400, { error: 'Send the referral id.' }));
        if (['under_review', 'approved', 'payout_pending', 'paid', 'rejected', 'reversed'].indexOf(String(finReq.status)) === -1) {
          return respondLater(errResp(400, { error: 'status must be one of: under_review, approved, payout_pending, paid, rejected, reversed' }));
        }
        if (String(finReq.status) === 'paid' && !String(finReq.payout_provider_ref || '').trim()) {
          return respondLater(errResp(400, { error: 'A reward is only paid with the provider\u2019s own payout reference.' }));
        }
        return respondLater(resp({ ok: true, id: finReq.id, status: finReq.status }));
      }

      return respondLater(errResp(400, { error: 'Unknown action. Team: report, publish_terms, set_config, refund, referral_decide.' }));
    }

    /* Repair claims (netlify/functions/claims.js).

       The mock enforces the four things the SCREEN branches on — the role
       gate, decide/report_work/resolve being the admin's, the status
       transitions the panel offers, and the call-out allowance (read from
       the Care ledger, the way claim_reserve_callout() reads it) —
       because those are what the queue has to render, including the
       refusal. What is NOT re-implemented here is the part the schema
       owns: the CHECK constraints, the append-only trail, the advisory
       lock and the atomicity. Those belong to scripts/test-claims.mjs and
       dev/sql-proof.mjs, which run the real function against the real
       schema. */
    if (url.indexOf('/api/claims') === 0) {
      if (ROLE === 'marketing') {
        return respondLater(errResp(403, { error: 'Only the admin and support logins may open the claim queue.' }));
      }
      var clReq = {};
      try { clReq = JSON.parse(body || '{}'); } catch (e) { clReq = {}; }
      var clAct = String(clReq.action || '').toLowerCase();
      var theRows = DB.rows.repair_claims || (DB.rows.repair_claims = []);
      var theLedger = DB.rows.care_credit_events || (DB.rows.care_credit_events = []);
      var CLAIM_STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'assigned', 'in_progress',
        'awaiting_customer', 'completed', 'rejected', 'cancelled', 'disputed'];

      /* The two answers a coverage decision can give, named rather
         than written inline at the gate below — because
         dev/mock-schema-test.mjs compares this list with the CHECK on
         repair_claims.eligibility, and a literal in the middle of an
         `if` cannot be compared with anything. An inline one is how a
         mock invents a word the database would refuse, and the test
         that exercises it stays green. */
      var ELIGIBILITY = ['covered', 'not_covered'];

      /* The allowance, read the way the SQL reads it: the pass's own
         ledger, minus the rows an expiry voided. */
      var careLeft = function (planId) {
        return theLedger.filter(function (e) {
          return e.plan_id === planId && e.event !== 'expired';
        }).reduce(function (n, e) { return n + Number(e.delta || 0); }, 0);
      };
      var appendLedger = function (planId, event, delta, reason) {
        theLedger.unshift({
          id: theLedger.length + 1, created_at: nowIso(), plan_id: planId,
          event: event, delta: delta, reason: reason, actor_name: 'owner', env: 'production'
        });
      };
      var trail = function (claim, to, event, reason) {
        DB.rows.claim_events = DB.rows.claim_events || [];
        DB.rows.claim_events.unshift({
          id: DB.rows.claim_events.length + 1, created_at: nowIso(),
          claim_id: claim.id, reference: claim.reference, to_status: to, event: event,
          reason: reason || null, data: null, actor_ref: 'mock-user',
          actor_name: ROLE === 'admin' ? 'owner' : 'support', actor_role: ROLE,
          env: claim.env || 'production'
        });
      };
      var move = function (claim, status, extra) {
        Object.assign(claim, { status: status, updated_at: nowIso() }, extra || {});
        trail(claim, status, clAct);
        return claim;
      };

      /* THE AGING CLOCK, as netlify/functions/claims.js computes it.

         Re-stated rather than imported because this file runs IN A PAGE
         (the mock is a script the browser loads), and because the panel
         now BRANCHES on it — the order of the queue and the two
         different late states are screen behaviour, which is exactly the
         category of thing this mock exists to reproduce faithfully.

         The numbers below must stay in step with CLOCK in claims.js. A
         limit that differs is a mock that flatters the queue: it would
         show a claim as on time that the scheduler is already paging the
         team about. The boot test asserts the states render; the claims
         test asserts the real clock's arithmetic. */
      var CLOCK = {
        submitted:         { hours: 24,  who: 'ours',     says: 'decide coverage' },
        under_review:      { hours: 24,  who: 'ours',     says: 'decide coverage' },
        approved:          { hours: 24,  who: 'ours',     says: 'name a worker' },
        assigned:          { hours: 48,  who: 'ours',     says: 'get the work reported' },
        in_progress:       { hours: 48,  who: 'ours',     says: 'get the work reported' },
        disputed:          { hours: 24,  who: 'ours',     says: 'close the dispute' },
        awaiting_customer: { hours: 168, who: 'customer', says: 'hear back from the customer' }
      };

      /* When a claim entered the status it is in now: its newest trail
         row, or the row's own timestamp when there is no trail yet. */
      /* Rows that are ABOUT a status rather than a move into it — a note,
         a notice, the clock's ask and its nudge. Real evidence, and none
         of them when the status changed: a claim must not buy itself
         another deadline by being talked about. Mirrors ABOUT_EVENT in
         netlify/functions/claims.js. */
      var ABOUT_EVENT = ['note', 'notified', 'overdue_nudge', 'chased', 'proposed'];
      var statusSince = function (claim) {
        var mine = (DB.rows.claim_events || []).filter(function (e) {
          return e.claim_id === claim.id && ABOUT_EVENT.indexOf(e.event) === -1;
        });
        var newest = mine.sort(function (x, y) {
          return String(y.created_at).localeCompare(String(x.created_at));
        })[0];
        return (newest && newest.created_at) || claim.updated_at || claim.created_at;
      };

      var agingOf = function (claim) {
        var spec = CLOCK[claim.status];
        if (!spec) return null;
        var since = new Date(statusSince(claim));
        var at = new Date();
        var elapsed = Math.max(0, at.getTime() - since.getTime());
        var due = new Date(since.getTime() + spec.hours * 3600000);
        var hoursLeft = (due.getTime() - at.getTime()) / 3600000;
        return {
          who: spec.who,
          says: spec.says,
          limit_hours: spec.hours,
          status_since: since.toISOString(),
          deadline_at: due.toISOString(),
          hours_in_status: Math.round((elapsed / 3600000) * 10) / 10,
          days_in_status: Math.floor(elapsed / 86400000),
          hours_left: Math.round(hoursLeft * 10) / 10,
          overdue: hoursLeft < 0,
          hours_over: hoursLeft < 0 ? Math.round((-hoursLeft) * 10) / 10 : 0
        };
      };

      var WHO_RANK = { ours: 0, customer: 1 };

      /* The same order as byPain() in claims.js: late first, worst first,
         then the claim closest to going late, and a claim with no clock
         never outranks one that is still moving. */
      var byPain = function (a, b) {
        var ag = a.aging, bg = b.aging;
        if (!!ag && !!bg && ag.overdue !== bg.overdue) return ag.overdue ? -1 : 1;
        if (ag && bg && ag.overdue && bg.overdue) {
          if (WHO_RANK[ag.who] !== WHO_RANK[bg.who]) return WHO_RANK[ag.who] - WHO_RANK[bg.who];
          return bg.hours_over - ag.hours_over;
        }
        if (!!ag !== !!bg) return ag ? -1 : 1;
        if (ag && bg) return ag.hours_left - bg.hours_left;
        return String(a.created_at).localeCompare(String(b.created_at));
      };

      if (clAct === 'queue') {
        var wantStatus = clReq.status ? String(clReq.status) : '';
        if (wantStatus && CLAIM_STATUSES.indexOf(wantStatus) === -1) {
          return respondLater(errResp(400, { error: 'status must be one of: ' + CLAIM_STATUSES.join(', ') }));
        }
        var limit = Math.min(Math.max(Number(clReq.limit) || 25, 1), 100);
        var listed = theRows
          .filter(function (c) { return !wantStatus || c.status === wantStatus; })
          .slice(0, limit)
          .map(function (c) { return Object.assign({}, c, { aging: agingOf(c) }); })
          .sort(byPain);

        /* claims_summary, built the way the view builds it: by status and
           environment, with the commit and money columns. */
        var summary = [];
        theRows.forEach(function (c) {
          var s = summary.filter(function (x) {
            return x.status === c.status && x.env === (c.env || 'production');
          })[0];
          if (!s) {
            s = { env: c.env || 'production', status: c.status, claims: 0,
                  call_outs_committed: 0, estimated_kobo: 0, actual_kobo: 0 };
            summary.push(s);
          }
          s.claims += 1;
          if (c.call_out_no) s.call_outs_committed += 1;
          s.estimated_kobo += Number(c.estimate_kobo) || 0;
          s.actual_kobo += Number(c.actual_kobo) || 0;
        });
        /* The visit days, with the SAME definition claims.js uses
           (dayStateOf): a day is agreed, haggled over, or waiting on an
           answer, and a claim whose work is not reported yet is the only
           place a visit to come can live. Counted over EVERY row rather
           than over the page, because "how many visits are pinned down"
           must not change when somebody loads two more rows. */
        var VISIT_OPEN = ['assigned', 'in_progress'];
        var dayState = function (c) {
          if (!String(c.provider_proposal || '').trim()) return null;
          if (c.day_agreed_at) return 'agreed';
          return String(c.customer_proposal || '').trim() ? 'asked' : 'waiting';
        };
        var days = { agreed: 0, asked: 0, waiting: 0, visits: 0, open: 0, capped: false };
        theRows.filter(function (c) { return VISIT_OPEN.indexOf(c.status) !== -1; })
          .forEach(function (c) {
            var s = dayState(c);
            if (!s) return;
            days.visits += 1;
            days[s] += 1;
            if (s !== 'agreed') days.open += 1;
          });

        return respondLater(resp({
          ok: true, claims: listed, summary: summary,
          limit: limit, offset: 0, statuses: CLAIM_STATUSES,
          aging: {
            clocked: listed.filter(function (c) { return c.aging; }).length,
            overdue: listed.filter(function (c) { return c.aging && c.aging.overdue; }).length,
            limits: CLOCK
          },
          days: days
        }));
      }

      /* The admin's three. Support gets the refusal, not a hidden door. */
      if (['decide', 'report_work', 'resolve'].indexOf(clAct) !== -1 && ROLE !== 'admin') {
        return respondLater(errResp(403, {
          error: 'Only the admin login may decide coverage, record a cost or close a claim.'
        }));
      }

      var claim = theRows.filter(function (c) { return c.id === clReq.id; })[0];
      if (!claim) return respondLater(errResp(404, { error: 'No such claim.' }));

      if (clAct === 'decide') {
        if (['submitted', 'under_review', 'draft'].indexOf(claim.status) === -1) {
          return respondLater(errResp(409, { error: 'This claim has already been decided (' + claim.status + ').' }));
        }
        var eligibility = String(clReq.eligibility || '').trim();
        var why = String(clReq.reason || '').trim();
        if (ELIGIBILITY.indexOf(eligibility) === -1) {
          return respondLater(errResp(400, { error: 'eligibility must be covered or not_covered.' }));
        }
        if (why.length < 5) {
          return respondLater(errResp(400, { error: 'A decision needs a reason in words \u2014 the customer reads it.' }));
        }
        if (eligibility === 'not_covered') {
          move(claim, 'rejected', {
            eligibility: 'not_covered', eligibility_reason: why,
            decided_by: 'owner', decided_at: nowIso(),
            resolved_at: nowIso(), resolution: 'refused: ' + why, closed_by: 'owner'
          });
          return respondLater(resp({ ok: true, status: 'rejected' }));
        }

        /* COVERED. The call-out is taken before anything else is written,
           and a pass with nothing left REFUSES the approval — leaving the
           claim under review, exactly where the function leaves it. */
        if (careLeft(claim.plan_id) <= 0) {
          move(claim, 'under_review', {
            eligibility: 'covered', eligibility_reason: why,
            decided_by: 'owner', decided_at: nowIso()
          });
          return respondLater(errResp(409, {
            error: 'This pass has no call-outs left, so the claim was not approved. It stays under review \u2014 ' +
              'the customer should be told, and quoted for the work.',
            status: 'under_review'
          }));
        }
        var no = theLedger.filter(function (e) {
          return e.plan_id === claim.plan_id && e.event === 'reserved';
        }).length + 1;
        appendLedger(claim.plan_id, 'reserved', -1,
          'Call-out ' + no + ' committed to claim ' + claim.reference);
        var estimate = clReq.estimate_kobo === undefined || clReq.estimate_kobo === null
          ? null : Math.round(Number(clReq.estimate_kobo));
        move(claim, 'approved', {
          eligibility: 'covered', eligibility_reason: why,
          decided_by: 'owner', decided_at: nowIso(),
          call_out_no: no, reserved_at: nowIso(), estimate_kobo: estimate
        });
        return respondLater(resp({ ok: true, status: 'approved', call_out_no: no, estimate_kobo: estimate }));
      }

      if (clAct === 'assign') {
        if (['approved', 'assigned', 'in_progress'].indexOf(claim.status) === -1) {
          return respondLater(errResp(409, {
            error: 'A claim must be approved before a worker is named (this one is ' + claim.status + ').'
          }));
        }
        var worker = String(clReq.provider_name || '').trim();
        var workerPhone = String(clReq.provider_phone || '').trim();
        var workerEmail = String(clReq.provider_email || '').trim();
        if (worker.length < 2) return respondLater(errResp(400, { error: 'Name the worker who will do the job.' }));
        if (!workerPhone) return respondLater(errResp(400, { error: 'A worker needs a number the customer can reach.' }));
        /* Optional, and refused when it is not an address at all — the
           same two rules the function keeps, so the panel cannot be
           taught that a typo is an email. */
        if (workerEmail && !/^[^\s@,;"<>]+@[^\s@,;"<>]+\.[a-z]{2,}$/.test(workerEmail.toLowerCase())) {
          return respondLater(errResp(400, {
            error: 'That worker email does not look like an address \u2014 leave it blank if there is none.'
          }));
        }
        move(claim, 'assigned', {
          provider_name: worker, provider_phone: workerPhone,
          provider_email: workerEmail || null,
          assigned_at: nowIso(), assigned_by: ROLE === 'admin' ? 'owner' : 'support',
          /* A new naming, so the previous worker's answer is not this
             job's answer, and neither is a day THEY offered — the same
             reset the function does, for the same reason. */
          provider_answer: null, provider_answered_at: null, provider_answer_note: null,
          provider_proposal: null, provider_proposed_at: null
        });
        /* The channels the real function reports back on a handover —
           all four, because one action now sends two notices: the job to
           the worker, and the name to the customer the approval promised
           to tell. The mock cannot send anything, and it says what a site
           with both senders configured would say: a number was required to
           get this far (waJid accepts it), and the address is either there
           or it is not. The mock's passes carry no address at all, so the
           customer's email reads exactly as the function reads a pass
           bought without one. __MOCK__.handoverFails() is the other half
           — the handover that did not go — because a panel that says
           "delivered" whatever happened is the bug this sentence exists to
           make visible, and it has to be reachable on purpose. It breaks
           the WhatsApp SENDER, so both copies fail with it: one provider
           outage is one failure, not two. */
        var waOutcome = HANDOVER_FAILS ? 'openwa-502' : 'sent';
        return respondLater(resp({
          ok: true, status: 'assigned', provider_email: workerEmail || null,
          notified: HANDOVER_UNREPORTED ? undefined : {
            worker_whatsapp: waOutcome,
            worker_email: workerEmail ? 'sent' : 'no address',
            student_whatsapp: claim.student_phone ? waOutcome : 'no number',
            student_email: 'no address'
          }
        }));
      }

      if (clAct === 'progress') {
        if (String(clReq.status || '').trim() !== 'in_progress') {
          return respondLater(errResp(400, {
            error: 'Support can mark a job in_progress. Reporting the work and closing a claim are the admin\u2019s.'
          }));
        }
        if (['assigned', 'in_progress'].indexOf(claim.status) === -1) {
          return respondLater(errResp(409, { error: 'This claim is not with a worker yet (' + claim.status + ').' }));
        }
        move(claim, 'in_progress', {});
        return respondLater(resp({ ok: true, status: 'in_progress' }));
      }

      if (clAct === 'report_work') {
        if (['assigned', 'in_progress'].indexOf(claim.status) === -1) {
          return respondLater(errResp(409, {
            error: 'Work can only be reported on a claim with a worker on it (' + claim.status + ').'
          }));
        }
        var actual = clReq.actual_kobo === undefined || clReq.actual_kobo === null
          ? null : Math.round(Number(clReq.actual_kobo));
        if (actual !== null && !(actual >= 0)) {
          return respondLater(errResp(400, { error: 'actual_kobo must be a whole number of kobo.' }));
        }
        /* The pair the real function posts, into the same journal the
           Finance panel reconciles — so reporting a repair cannot make
           the books stop balancing in the mock, either. */
        if (actual && actual > 0) {
          FINANCE.journal.push(
            { business_line: 'care', account: 'expense', direction: 'debit', amount_kobo: actual },
            { business_line: 'care', account: 'payable', direction: 'credit', amount_kobo: actual }
          );
        }
        move(claim, 'awaiting_customer', {
          actual_kobo: actual,
          parts: Array.isArray(clReq.parts) ? clReq.parts : [],
          evidence: Array.isArray(clReq.evidence) ? clReq.evidence : [],
          customer_note: clReq.note ? String(clReq.note) : null
        });
        return respondLater(resp({ ok: true, status: 'awaiting_customer', actual_kobo: actual }));
      }

      if (clAct === 'resolve') {
        var outcome = String(clReq.outcome || '').trim();
        var resolution = String(clReq.resolution || '').trim();
        if (['completed', 'rejected', 'cancelled'].indexOf(outcome) === -1) {
          return respondLater(errResp(400, { error: 'outcome must be completed, rejected or cancelled.' }));
        }
        if (resolution.length < 5) {
          return respondLater(errResp(400, {
            error: 'A resolution is a sentence on the record, not a status change.'
          }));
        }
        if (claim.status !== 'disputed') {
          return respondLater(errResp(409, {
            error: 'There is no open dispute on this claim (' + claim.status + ').'
          }));
        }
        /* A call-out that is given back is given back ON THE LEDGER. */
        var released = false;
        if (outcome !== 'completed' && claim.call_out_no) {
          appendLedger(claim.plan_id, 'released', 1,
            'Call-out returned from claim ' + claim.reference + ' \u2014 dispute resolved: ' + outcome);
          released = true;
        }
        move(claim, outcome, {
          resolved_at: nowIso(), resolution: resolution, closed_by: 'owner'
        });
        return respondLater(resp({ ok: true, status: outcome, released: released }));
      }

      return respondLater(errResp(400, {
        error: 'Unknown action. Team: queue, decide, assign, progress, report_work, resolve.'
      }));
    }

    /* --- Supabase auth + REST (absolute, config origin) --- */
    var SUPA_ROOT = ((window.ARZUZ_CONFIG && window.ARZUZ_CONFIG.SUPABASE_URL) || '').replace(/\/+$/, '');
    var SUPA_REST = SUPA_ROOT + '/rest/v1/';
    var SUPA_AUTH = SUPA_ROOT + '/auth/v1/';

    if (url.indexOf(SUPA_AUTH) === 0) return respondLater(handleAuth());

    if (url.indexOf(SUPA_REST) === 0) {
      var after = url.slice(SUPA_REST.length);
      /* THE VERIFICATION SHIFT's three functions go through the same
         /rest/v1/ prefix as the tables — supabase-verification-queue.sql
         — so they are caught here, before the table path. */
      if (after.indexOf('rpc/') === 0) {
        return respondLater(handleRpc(after.slice(4).split('?')[0], body));
      }
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
      db.roommate_engine_summary = [];
      db.roommate_mutual_pairs = [];
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
      DB.rows = seedRows(SEED_KIND);
      DB.rows.team_users = seedTeamUsers();
      log('database + scenario reset — press Refresh in the dashboard');
    },
    /* Back-date the open tier-0 listings so the verification shift's
       overdue path is reachable in the harness: the marking, the
       ordering (late first) and the counts. Days, not hours, because the
       first deadline is 72 hours — see assets/verification-queue.js. */
    lateListing: function (days, count) {
      var d = Number(days) || 4;
      var n = Number(count) || 1;
      var open = openListings().slice(0, n);
      open.forEach(function (r) {
        var at = new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
        r.created_at = at;
        if (r.assigned_to) r.taken_at = at;
      });
      log(open.length + ' listing(s) back-dated by ' + d + ' days');
      return open.length;
    },
    /* swap the fixture and reload, so the toggle is a URL you can share */
    seed: function (kind) {
      var k = kind === 'worst' ? 'worst' : 'demo';
      var q = new URLSearchParams(location.search);
      if (k === 'worst') q.set('seed', 'worst'); else q.delete('seed');
      SEED_KIND = k;
      log('fixtures →', k, '(reloading)');
      location.search = '?' + q.toString();
      return k;
    },
    stats: function () {
      var db = DB.rows;
      var out = {};
      TABLES.forEach(function (t) { out[t] = db[t].length; });
      out.minors_needing_guardian = db.minors_needing_guardian.length;
      out.roommate_engine_summary = (db.roommate_engine_summary || []).length;
      out.roommate_mutual_pairs = (db.roommate_mutual_pairs || []).length;
      out.team_users = (db.team_users || []).length;
      out.role = ROLE;
      out.delay = CONFIG.delay;
      out.fail = CONFIG.fail;
      log('stats:', out);
      return out;
    },
    db: function () { return DB.rows; },

    /* HALF a posting: cash out with no obligation entry to match it. The
       Finance screen has to report the line as off — smoothing it away
       is the failure mode this hook exists to make reachable. */
    financeOneSided: function () {
      FINANCE.journal.push({ business_line: 'care', account: 'cash', direction: 'credit', amount_kobo: 500000 });
      log('posted one side of a refund — the Finance screen must flag it');
      return FINANCE.journal.length;
    },
    /* A handover whose WhatsApp was refused: the claim still moves, and
       the panel has to say the worker was NOT reached on that channel
       rather than report a success the sender never gave. */
    handoverFails: function (on) {
      HANDOVER_FAILS = on !== false;
      log('the next handover will report a refused WhatsApp');
      return HANDOVER_FAILS;
    },
    /* NO words about the channels at all: what the function answers when
       the notice threw before a channel ran. A panel that fills the gap
       with "delivered" is the bug this hook makes reachable. */
    handoverUnreported: function (on) {
      HANDOVER_UNREPORTED = on !== false;
      log('the next handover will report nothing about its channels');
      return HANDOVER_UNREPORTED;
    },
    /* THE WORKER'S REPLY, mirrored from workerReply() in claims.js: the
       named worker answers the handover, 'accepted' keeps the claim with
       them and 'declined' puts it back to 'approved' — covered, with
       nobody on it — while the name, the number and their own words stay
       on the row. Nothing here re-implements the classification (that is
       classifyReply in claims.js, tested in scripts/test-claims.mjs);
       this is the STATE the panel has to render, forced on purpose so the
       queue can be read with a real answer already in it. */
    workerReply: function (reference, answer, note) {
      var claim = (DB.rows.repair_claims || []).filter(function (c) {
        return c.reference === reference;
      })[0];
      if (!claim) return log('no claim ' + reference + ' to answer');
      var at = nowIso();
      var was = claim.status;
      claim.updated_at = at;
      DB.rows.claim_events = DB.rows.claim_events || [];

      /* A DAY RATHER THAN A YES OR A NO. The worker holds the job and has
         told us when they can come: the status does not move (nobody has
         refused it and nobody has agreed), the words are the day they
         offered, and the answer stays unanswered — "suggested a time" is
         exactly the state that has to be readable on the panel. */
      if (answer === 'proposed') {
        claim.provider_proposal = note || 'Saturday morning';
        claim.provider_proposed_at = at;
        DB.rows.claim_events.unshift({
          id: DB.rows.claim_events.length + 1, created_at: at,
          claim_id: claim.id, reference: claim.reference, from_status: was, to_status: claim.status,
          event: 'proposed', reason: 'the worker answered the handover with a day: ' + (note || ''),
          data: null, actor_ref: null, actor_name: claim.provider_name, actor_role: 'worker',
          env: claim.env || 'production'
        });
        log('the worker offered a day on ' + reference + ': ' + claim.provider_proposal);
        return respondLater(resp({ ok: true, answer: answer, provider_proposal: claim.provider_proposal }));
      }

      claim.provider_answer = answer;
      claim.provider_answered_at = at;
      claim.provider_answer_note = note || null;
      /* 'unanswered' is the clock's own verdict, not a thing the worker
         said: the job goes back exactly where a refusal leaves it. */
      claim.status = (answer === 'declined' || answer === 'unanswered') ? 'approved' : 'assigned';
      DB.rows.claim_events.unshift({
        id: DB.rows.claim_events.length + 1, created_at: at,
        claim_id: claim.id, reference: claim.reference, from_status: was, to_status: claim.status,
        event: answer === 'accepted' ? 'accepted' : answer,
        reason: 'the worker answered the handover', data: null, actor_ref: null,
        actor_name: claim.provider_name, actor_role: answer === 'unanswered' ? 'system' : 'worker',
        env: claim.env || 'production'
      });
      log('the worker answered ' + reference + ': ' + answer);
      return respondLater(resp({ ok: true, answer: answer }));
    },
    financeJournal: function () { return FINANCE.journal.slice(); },
    financeReport: financeReport
  };

  /* ============================================================
     7b. Demo data / Worst case — the visible toggle

     In the page rather than in a URL you have to remember, because
     the interesting failures are not crashes: they are rows that
     save fine, render fine, and never reach a student.
     ============================================================ */
  (function installSeedToggle() {
    try {
      var BTN = 'padding:4px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.2);' +
                'background:transparent;color:inherit;font:inherit;cursor:pointer';
      var bar = document.createElement('div');
      bar.id = 'mockSeedToggle';
      /* below the modal overlay on purpose: a modal has to cover it */
      bar.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:900;display:flex;gap:6px;' +
        'align-items:center;padding:6px 8px;border-radius:10px;background:rgba(20,12,28,.94);' +
        'border:1px solid rgba(255,255,255,.16);color:#EDE7F3;font:600 12px/1.2 system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.45)');
      bar.innerHTML = '<span style="opacity:.7;font-weight:500">Fixtures</span>' +
        '<button type="button" data-mock-seed="demo" style="' + BTN + '">Demo data</button>' +
        '<button type="button" data-mock-seed="worst" style="' + BTN + '">Worst case</button>';
      document.body.appendChild(bar);
      var btns = bar.querySelectorAll('[data-mock-seed]');
      Array.prototype.forEach.call(btns || [], function (b) {
        var on = b.getAttribute('data-mock-seed') === SEED_KIND;
        b.style.background = on ? 'rgba(122,90,248,.35)' : 'transparent';
        b.style.borderColor = on ? 'rgba(160,130,255,.7)' : 'rgba(255,255,255,.2)';
        b.onclick = function () { window.__MOCK__.seed(b.getAttribute('data-mock-seed')); };
      });
    } catch (e) { /* a dev tool must never be why the page fails */ }
  })();

  log('harness ready — role:', ROLE.toUpperCase(), '· fixtures:', SEED_KIND, '· try __MOCK__.stats()');
})();
