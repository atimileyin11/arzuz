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
    roommatePool: { engine: null, profiles: [], pairs: [], trail: [] },   // questionnaire tables + views
    dossier: null,   // what the dossier modal is showing, for the export
    roommateFor: null,               // demand id whose candidates are open
    pendingDelete: null,
    detail: null,
    search: '',
    statusFilter: 'all',
    needsAskOnly: false,
    showTestRows: false,
    shareSchemaMissing: false,  // true when supabase-draft-sharing.sql has not been run yet
    /* The open-a-plan drawer: null when it is shut, an object of what
       has been typed while it is open, and { done: <the grant's own
       answer> } once the server has opened the plan and handed back
       the student's private link. */
    careGrant: null,
    /* The hourly check's one line: the endpoint's own sentence and its
       level, kept so every repaint prints the same reading. */
    health: { data: null, error: null, busy: false, readAt: 0 }
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
    /* every open gets a token. A dismiss can already be scheduled when a
       surface is reopened (the swipe's slide-away runs on a timer), and a
       stale close must never land on the fresh one — see slideAway() in
       2d/2e, the same idea as ArzuzUI's __closeToken. */
    el.__openToken = (el.__openToken || 0) + 1;
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

  /* ---------------- failures ----------------

     Every failed request in this dashboard makes its Error through
     apiErr(), which carries the wire facts (status, PostgREST code) AND
     a sentence in words: `message` is what a person reads, `detail` is
     what the console prints. Before this, twenty-odd call sites each
     composed "HTTP 500" by hand, so the dashboard could not tell a table
     that was never created from a rate limit from a missing permission —
     and neither could the person reading it. */
  function E(){ return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }

  /* `body` may be a parsed {code, message} payload or an already-read
     sentence. A sentence the server sent is always preferred — it is the
     answer to what was asked — and a class sentence is only the fallback
     for a failure that arrived with no words of its own. */
  function apiErr(res, body, extra){
    var status = (res && res.status) || 0;
    /* An already-read sentence arrives as a string; JSON arrives as one
       too, from the callers that kept the raw text. Both are normalised
       here so the classifier below reads a payload either way. */
    var b = body;
    if (typeof b === 'string') {
      try { b = b ? JSON.parse(b) : null; } catch (e) { b = { error: b.slice(0, 200) }; }
    }
    var code = (b && typeof b === 'object' && b.code) || null;
    var platform = (b && typeof b === 'object') ? (b.message || b.error || '') : '';
    var W = E();
    /* `session: true` because every request in this dashboard carries one:
       a 401 here is a stale token (sign in again), and a 403 is a grant
       that is missing — the two readings the file's own comment draws.
       The CLASS comes from the function's own answer where it named one,
       so the panel branches on exactly what the function meant instead
       of on the number: a 503 that says "SUPABASE_SERVICE_ROLE_KEY is
       missing" is a deploy to finish, not a minute to wait out. */
    var err = W ? W.failed({ status: status }, b, { audience: 'operator', session: true })
      : new Error(platform || 'Arzuz could not do that just now — that is our side, not yours. Try again in a minute.');
    err.status = status;
    if (code) err.code = code;
    if (platform) err.platform = platform;
    /* The wire facts for the console. The platform's own words are kept
       even when the classifier module is absent, so a console line never
       degrades to a bare number. */
    err.detail = W ? err.detail : (String(status) + (platform ? ' ' + platform : ''));
    if (extra) Object.assign(err, extra);
    return err;
  }

  /* First truthy value among a row column and its legacy payload keys. */
  function pick(row, col, payloadKeys) {
    if (row && row[col] !== undefined && row[col] !== null && row[col] !== '') return row[col];
    var p = payloadOf(row);
    for (var i = 0; i < payloadKeys.length; i++) {
      if (p[payloadKeys[i]] !== undefined && p[payloadKeys[i]] !== null && p[payloadKeys[i]] !== '') return p[payloadKeys[i]];
    }
    return '';
  }

  function waLink(phone, text) {
    var digits = str(phone).replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.charAt(0) === '0') digits = '234' + digits.slice(1);
    return 'https://wa.me/' + digits + (text ? '?text=' + encodeURIComponent(text) : '');
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

  /* ---- is this listing actually on the browse page, and if not, why? ----

     browse.html reads public_listings, which is

         where status = 'active' and tier >= 1 and env = 'production'

     Three ANDed conditions. The dashboard showed none of them, so a
     listing could look perfectly healthy here — added by hand, saved
     with a green toast — and be invisible to every student on the
     public page, with nothing anywhere on screen to say why. Approving
     a submitted listing by setting its status to active left the tier
     at 0, which is exactly that trap. This is the screen saying why. */
  function boardState(r) {
    var status = str(r && r.status).toLowerCase();
    var tier = Number(r && r.tier);
    if (!isFinite(tier)) tier = 0;
    /* env is NULLABLE, and the view asks for 'production' — so a row
       with no env at all is hidden, which is exactly the kind of row
       that looks healthy in this table. Empty is not production. */
    var env = str(r && r.env).toLowerCase();
    if (status !== 'active') return { live: false, why: 'its status is ' + (status || 'empty') };
    if (tier < 1) return { live: false, why: 'it is tier 0 — not verified yet' };
    if (env !== 'production') {
      return { live: false, why: env
        ? 'its env is ' + env + ' and the public board only reads production'
        : 'its env is empty, and the public board only reads production' };
    }
    return { live: true, why: '' };
  }

  function boardBadgeHtml(r) {
    var b = boardState(r);
    if (b.live) {
      return '<span class="board-badge live" title="Students can see this on /browse">' + ico('eye', 11) + ' live</span>';
    }
    return '<span class="board-badge hidden" title="Not on the browse page — ' + esc(b.why) + '">' +
      ico('alert', 11) + ' hidden</span>';
  }

  /* ================= how often the engines come back, and why =================

     A room's <changefreq> and <priority> are not set by hand. They come off
     ONE score, built from how much of the page there is and how recently it
     moved — and that score lives in assets/listing-score.js so this dashboard
     and the listings sitemap that publishes them cannot disagree about the
     same room (see netlify/functions/listings-sitemap.js).

     WHY THE DASHBOARD SHOWS IT. Without it, an owner whose room is checked
     yearly has no way to see that the reason is a missing photo and a rent
     nobody has corrected since last session — the only visible "why" was
     the order rooms appeared in. The Crawl cell answers it in one badge, the
     details modal spells it out, and "what to fill in" is the scorer's own
     list of missing signals, which is the same six facts the sitemap sizes a
     room with. Fix one of them and the badge moves on the next refresh.

     ONLY THE BASE TABLE CAN BE SCORED. The PII-scrubbed growth_listing_feed
     (section 3) carries no photo, no pin and no edit stamp, so scoring a row
     from it would report a half-filled page for a room that is complete.
     A role that reads the feed therefore sees no score rather than a wrong
     one. */
  var CRAWL_WORDS = {
    daily: 'checked daily',
    weekly: 'checked weekly',
    monthly: 'checked monthly',
    yearly: 'checked yearly \u2014 the engines rarely come back'
  };

  function crawlHintOf(r) {
    var S = window.ArzuzListingScore;
    if (!S || !r || currentRole() !== 'admin') return null;
    var hint = S.signals(r, Date.now());
    var missing = S.missing(r);
    return {
      hint: hint,
      missing: missing,
      has: S.SIGNALS.length - missing.length,
      total: S.SIGNALS.length,
      lastEdit: S.stampOf(r)
    };
  }

  /* One badge, with the whole answer in its title — the table is already
     wider than its pane, so the cell stays short and the detail lives on
     hover and in the modal. */
  function crawlBadgeHtml(r) {
    var c = crawlHintOf(r);
    if (!c) return '<span class="muted-cell">\u2014</span>';
    var title = CRAWL_WORDS[c.hint.changefreq] + ' \u00b7 ' + c.has + ' of ' + c.total +
      ' facts' + (c.missing.length ? ' \u00b7 missing ' + c.missing.join(', ') : ' \u00b7 nothing missing');
    var band = c.hint.changefreq === 'daily' ? 'daily'
      : c.hint.changefreq === 'weekly' ? 'weekly' : 'rare';
    return '<span class="crawl-badge ' + band + '" title="' + esc(title) + '">' +
      ico('search', 11) + ' ' + esc(c.hint.changefreq) + ' \u00b7 ' + c.has + '/' + c.total + '</span>';
  }

  function boardNoteText(status, tier, env) {
    var b = boardState({ status: status, tier: tier, env: env });
    if (b.live) return 'Students can see this on the browse page now.';
    return 'Not on the browse page yet — ' + b.why +
      '. It goes live when the status is ACTIVE, the verification tier is 1 or 2, and the environment is production.';
  }

  /* The note under the tier select, in both the Add and the Edit modal,
     so the answer is on screen BEFORE the save, not after the silence.

     The ids are spelled out rather than concatenated: the selects are
     add_status / edit_status, and `ctx + 'status'` silently produced
     'addstatus' — an empty element, so the note described a status
     nobody had chosen. */
  var BOARD_NOTE = {
    add:  { note: 'addBoardNote',  status: 'add_status',  tier: 'add_tier' },
    edit: { note: 'editBoardNote', status: 'edit_status', tier: 'edit_tier' }
  };

  function syncBoardNote(ctx, env) {
    var ids = BOARD_NOTE[ctx];
    if (!ids) return;
    var el = $(ids.note);
    if (!el) return;
    var st = $(ids.status), tr = $(ids.tier);
    if (!st || !tr) return;
    var b = boardState({ status: st.value, tier: tr.value, env: env });
    el.className = 'fld-note ' + (b.live ? 'is-live' : 'is-hidden');
    el.textContent = boardNoteText(st.value, tr.value, env);
  }

  /* The ONE write that puts a hidden row on the board: status active, a
     real tier, production. Offered as a single row action because
     "approve it" used to mean editing three fields in the right order
     and getting one of them wrong was silent. Never offered for a
     draft: publishing a draft is a deliberate two-step (the invite link
     dies the moment the status leaves 'draft'). */
  function publishToListingBoard(id) {
    var row = findRow('listings', id);
    if (!row) return;
    var patch = { status: 'active', tier: Math.max(1, Number(row.tier) || 0), env: 'production' };
    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/listings?id=eq.' + id, { method: 'PATCH', headers: h, body: JSON.stringify(patch) });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Publish rejected')); throw new Error('Your session has expired.'); }
        if (!r.ok) throw apiErr(r);
        return r.json();
      })
      .then(function (updated) {
        /* A 200 with an EMPTY array is PostgREST for "matched zero rows":
           this login holds no row-wide UPDATE on listings (the
           verification role lost it in supabase-verification-rpc.sql),
           so the PATCH changed nothing. Painting a success here used to
           be the bug — the row looked published until the next refresh,
           and never reached the board. Fall through to the RPC decision
           instead, which is the write this login is actually allowed. */
        if (updated && updated.length === 0) {
          verifyListingRow(id);
          return;
        }
        if (updated && updated[0]) Object.assign(row, updated[0]);
        else Object.assign(row, patch);
        renderRoute();
        var b = boardState(row);
        if (ArzuzSubmit && ArzuzSubmit.showToast) {
          ArzuzSubmit.showToast(b.live
            ? 'Published — this listing is on the browse page now.'
            : 'Saved, but still hidden — ' + b.why + '.', b.live ? 'success' : 'error');
        }
      })
      .catch(function (err) { alert('Could not publish it: ' + err.message); });
  }
  /* exposed the way openEditModal is, so dev/admin-boot-test.js can drive
     the one write that puts a hidden listing on the public board */
  window.publishToListingBoard = publishToListingBoard;

  /* THE OFFICER'S WRITE IS A FUNCTION, NOT A PATCH.

     supabase-verification-rpc.sql withdrew the row-wide UPDATE policy
     this table used to carry for the verification role, so an officer's
     PATCH of /rest/v1/listings now matches zero rows and changes
     nothing. What it may write is public.listing_verify(), which moves
     status, tier, verified_at and verified_by — the four columns that
     ARE the decision — and refuses everything else by construction.

     The price is the reason. Approving a listing used to mean holding an
     UPDATE on the row, so the officer who went to look at a room could
     also change what it costs; the write was recorded, which made it
     survivable, not correct (LAUNCH-READINESS.md risk 2).

     Note what this does NOT do: env is not one of the four, so approving
     a listing that is not a production row leaves it off the board. That
     is the admin's Publish, deliberately — an officer's decision is the
     verification record, not the deployment. */
  function verifyListingRow(id) {
    var row = findRow('listings', id);
    var tier = Math.max(1, Number(row && row.tier) || 0);
    ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/rpc/listing_verify', {
        method: 'POST', headers: h,
        body: JSON.stringify({ p_id: id, p_status: 'active', p_tier: tier })
      });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          onAuthError(new Error('Approve rejected'));
          throw new Error('Your session has expired, or this login may not verify a listing.');
        }
        if (!r.ok) throw apiErr(r);
        return r.json();
      })
      .then(function (out) {
        if (row) Object.assign(row, (out && out.id) ? out : { status: 'active', tier: tier });
        renderRoute();
        /* The RPC moves status and tier but never env, so approving a
           non-production row leaves it off the board by design — and
           that used to read as "approve does nothing". Say which it
           was, so nobody has to guess why the room is not on /browse. */
        var b = boardState(row);
        if (ArzuzSubmit && ArzuzSubmit.showToast) {
          ArzuzSubmit.showToast(b.live
            ? 'Approved — status and tier are set, and it is live on the browse page.'
            : 'Approved — status and tier are set, but it is still hidden: ' + b.why + '. An admin Publish puts it on the board.',
            b.live ? 'success' : 'error');
        }
      })
      .catch(function (err) { alert('Could not approve it: ' + err.message); });
  }
  /* exposed the way publishToListingBoard is, so the boot suite can drive
     the officer's one write instead of only its button */
  window.verifyListingRow = verifyListingRow;

  /* ============================================================
     THE VERIFICATION SHIFT  — LAUNCH-READINESS.md §8.2, stage 2

     Approving a listing was always the easy half. The hard half is that
     a listing live at tier 0 is owed a VISIT, and nothing said so: at
     twenty-five listings a week that lives in somebody's head, and at
     seventy-five the room goes live unvisited, the deadline passes on a
     Tuesday nobody noticed, and the first person to find out is the
     student standing in the room.

     So the shift is a panel above the listings table: every live tier-0
     listing, late ones first, with who holds it and how long it has
     waited. TAKE puts this login's account on it and starts its 48 hours;
     RELEASE gives it back; Approve is the same call the table's own
     button makes.

     Both new writes are FUNCTIONS, not PATCHes, for exactly the reason
     the approve above is: the verification role holds no row-wide UPDATE
     on listings (supabase-verification-rpc.sql), so `assigned_to` is not
     the officer's to write — public.listing_take() / listing_release()
     move it, and taken_at with it, and nothing else. A price is not a
     thing an officer's claim can change.

     This panel decides nothing about what is LATE. The deadlines and the
     ordering are assets/verification-queue.js, which the hourly chaser
     loads too, so the page and the message cannot disagree about whether
     a listing is overdue. */
  function verifyQueueCard() { return document.getElementById('verifyQueueCard'); }

  /* The visit form, drawn on a listing THIS login holds — the visit is
     the state a claim exists for. Every control carries data-ev so the
     delegated listeners below can write the draft, and every id is
     namespaced by listing so two cards cannot share a checkbox. */
  function evidenceFormHtml(r) {
    var kinds = evidenceKinds();
    if (!kinds.length) {
      return '<div class="verify-evidence"><div class="verify-empty">The check vocabulary did not load, so this panel cannot name what was checked.</div></div>';
    }
    return '<div class="verify-evidence">' +
      '<div class="verify-evidence-head">What did you check?</div>' +
      kinds.map(function (k) {
        return '<div class="verify-check">' +
          '<label><input type="checkbox" id="ev-' + esc(k.kind) + '-' + esc(r.id) + '"' +
          ' data-act="ev-kind" data-ev="' + esc(k.kind) + '" data-id="' + esc(r.id) + '"> ' +
          esc(k.label) + '</label>' +
          '<input type="text" maxlength="200" placeholder="what you saw, in your own words"' +
          ' data-act="ev-detail" data-ev="' + esc(k.kind) + '" data-id="' + esc(r.id) + '">' +
          '</div>';
      }).join('') +
      '<button type="button" class="act-btn act-approve" data-act="vattest" data-table="listings" data-id="' + esc(r.id) + '">' +
      ico('check', 13) + ' Record the visit</button>' +
      '</div>';
  }

  function queueRowHtml(r) {
    var aging = r.aging;
    var late = !!(aging && aging.overdue);
    var held = !!(aging && aging.stage === 'visit');
    return '<div class="verify-row' + (late ? ' late' : '') + '">' +
      '<div class="verify-head">' +
      '<b>' + esc(r.ref || shortId(r.id)) + '</b>' +
      '<span class="verify-area">' + esc(r.area || 'area unknown') + '</span>' +
      '</div>' +
      '<div class="verify-age">' + esc(ArzuzVerify.label(aging)) +
      (late && aging.who === 'officer' ? ' — our officer has not been back' : '') +
      (Number(r.scout_reports) > 0 ? ' · ' + esc(String(r.scout_reports)) + ' scout report(s) on file' : '') +
      '</div>' +
      '<div class="cell-actions">' +
      (held
        ? '<button type="button" class="act-btn" data-act="vrelease" data-table="listings" data-id="' + esc(r.id) + '">' + ico('refresh', 13) + ' Release</button>'
        : '<button type="button" class="act-btn" data-act="vtake" data-table="listings" data-id="' + esc(r.id) + '">' + ico('check', 13) + ' Take</button>') +
      '<button type="button" class="act-btn act-approve" data-act="verify" data-table="listings" data-id="' + esc(r.id) + '">' + ico('check', 13) + ' Approve</button>' +
      '</div>' +
      (held ? evidenceFormHtml(r) : '') +
      '</div>';
  }

  function renderVerifyQueue() {
    var card = verifyQueueCard();
    if (!card) return;
    /* Only the two logins the RPC admits. Drawing the panel for anyone
       else would be a control that teaches the dashboard lies — the same
       rule the listings stage selector follows. */
    var role = currentRole();
    if (role !== 'verification' && role !== 'admin') { card.style.display = 'none'; return; }
    card.style.display = '';

    var body = document.getElementById('verifyQueueBody');
    var counts = document.getElementById('verifyQueueCounts');
    if (!body) return;
    if (typeof ArzuzVerify === 'undefined') {
      body.innerHTML = '<div class="verify-empty">The queue clock did not load, so this panel cannot say what is late.</div>';
      return;
    }
    body.innerHTML = '<div class="verify-empty">Reading the queue…</div>';

    ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/rpc/verification_queue', {
        method: 'POST', headers: h, body: '{}'
      });
    })
      .then(function (r) {
        /* A login outside the shift is not an error worth a red panel:
           the function refuses it by design, and this panel is then not
           that login's business. */
        if (r.status === 401 || r.status === 403) return [];
        if (!r.ok) throw apiErr(r);
        return r.json();
      })
      .then(function (rows) {
        var list = toList(rows);
        if (!list.length) {
          if (counts) counts.textContent = 'nothing owed a visit';
          body.innerHTML = '<div class="verify-empty">Every live listing on this board has been visited and decided. ' +
            'A new one appears here the moment it goes live at tier 0.</div>';
          return;
        }
        var queue = ArzuzVerify.queueOf(list);
        if (counts) {
          counts.textContent = queue.total + ' owed a visit' +
            (queue.late
              ? ' · ' + queue.late + ' late (' + queue.owed_by_us + ' nobody has taken, ' +
                queue.owed_by_officers + ' held by us)'
              : ' · none late');
        }
        body.innerHTML = queue.rows.map(queueRowHtml).join('');
      })
      .catch(function (err) {
        body.innerHTML = '<div class="verify-empty">The queue could not be read: ' + esc(err.message || err) + '</div>';
      });
  }

  /* TAKE AND RELEASE, through the two column-scoped functions. */
  function verifyQueueWrite(method, id) {
    var payload = method === 'listing_take'
      ? { p_id: id }
      : { p_id: id, p_note: 'released from the dashboard' };
    ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/rpc/' + method, {
        method: 'POST', headers: h, body: JSON.stringify(payload)
      });
    })
      .then(function (r) {
        if (r.ok) return r.json();
        /* A REFUSAL IS NOT A FAULT, and the difference is the whole point of
           what these two functions raise. Their sentences are written FOR the
           officer — "that listing has already been decided", "<name> already
           has that listing. Ask them to release it", "that listing is not
           held by anybody" — and the classifier answers a 400 with "that is
           our side, not yours", which is false (nothing is broken) and
           useless (there is nobody to message). So the function's own words
           win, with the RPC's name stripped.

           The discriminator is the PREFIX of the message, not the SQLSTATE.
           The raises carry 22023 and 42501, not P0001, and 42501 is also what
           Postgres answers for a missing grant — so a code test would either
           miss the refusals or swallow a real permission problem. A message
           that starts with `listing_take:` / `listing_release:` can only be
           one of these raises; "permission denied for function listing_take"
           does not start that way and keeps the classifier's answer.

           It also has to be checked BEFORE the 401/403 branch, because
           PostgREST answers a 42501 with 403 — and a 403 here would otherwise
           be read as a dead session, signing out an officer for the crime of
           pressing Release on somebody else's listing. */
        return r.text().then(function (txt) {
          var err = apiErr(r, txt);
          var own = String(err.platform || '').match(/^listing_(?:take|release): (.+)$/);
          if (own) {
            err.message = own[1];
            err.refusal = true;
            throw err;
          }
          if (r.status === 401 || r.status === 403) {
            onAuthError(new Error(method));
            throw new Error('Your session has expired, or this login may not work the queue.');
          }
          throw err;
        });
      })
      .then(function () {
        renderVerifyQueue();
        if (ArzuzSubmit && ArzuzSubmit.showToast) {
          ArzuzSubmit.showToast(method === 'listing_take'
            ? 'Taken — the listing is on your name, and the visit is owed within ' +
              ArzuzVerify.POLICY.visit_hours + 'h.'
            : 'Released — it is back in the queue for anybody to take.', 'success');
        }
      })
      .catch(function (err) { alert('Could not ' + (method === 'listing_take' ? 'take' : 'release') + ' it: ' + err.message); });
  }

  /* exposed for dev/admin-boot-test.js, which drives the shift the way it
     drives the officer's approve */
  window.renderVerifyQueue = renderVerifyQueue;
  window.verifyQueueWrite = verifyQueueWrite;

  /* ============================================================
     WHAT THE VISIT SAW — LAUNCH-READINESS.md §8.2, stage 3

     Stage 2 got somebody to the door. It recorded that a listing WAS
     decided and who decided it — and the badge on the board said
     "Inspected", which is a word, not a list. The student asking "what
     exactly did you check?" got a person's recollection.

     So the officer's card carries a short form: the named checks, an
     optional sentence of their own about each, and a note for the
     record. Submitting it calls public.listing_attest(), which writes
     the evidence and makes the decision in ONE transaction — tier 2,
     active, verified_at/by, plus the checks behind the word. If the
     function refuses, nothing was written, and the officer sees the
     function's own sentence rather than a status code.

     WHY A DRAFT STORE RATHER THAN READING THE DOM BACK

     The form is plain markup (checkboxes and inputs with data-ev
     attributes) and the state lives in EVIDENCE_DRAFT, keyed by listing.
     Reading the DOM back at submit time would mean querySelector per
     field on a panel that re-renders under the officer's hands, and
     would make the payload — which is the whole point of this screen —
     testable only through a simulated browser. The delegated listeners
     still exist, so the browser writes the draft exactly the way the
     harness does; there is one implementation of "what did you tick".

     Nothing here decides what a check MEANS. The vocabulary and the
     labels are assets/verification-badge.js, which the QUEUE does not
     own any more than the board does — a check the admin cannot name is
     a check the public badge could not print. */
  var EVIDENCE_DRAFT = {};

  function evidenceKinds() {
    return (window.ArzuzBadge && ArzuzBadge.KINDS) || [];
  }

  function evidenceDraft(id) {
    if (!EVIDENCE_DRAFT[id]) EVIDENCE_DRAFT[id] = { checks: {} };
    return EVIDENCE_DRAFT[id];
  }

  function verifyEvidenceToggle(id, kind, on, detail) {
    if (!id || !kind) return null;
    var d = evidenceDraft(id);
    var prior = d.checks[kind] || { on: false, detail: '' };
    d.checks[kind] = {
      on: on === undefined ? !!prior.on : !!on,
      /* 200 is the column's own ceiling. Trimmed here too, so the officer
         sees what the database would keep rather than a silent cut. A null
         is an EMPTY sentence, never the word "null" — the payload sends
         null for a check the officer ticked and said nothing about. */
      detail: detail === undefined ? prior.detail
        : String(detail === null ? '' : detail).slice(0, 200)
    };
    return d.checks[kind];
  }

  /* The exact body the RPC receives. A function rather than an inline
     object so the harness can assert the PAYLOAD — which is what the
     database will store — instead of the fact that some request happened.

     No visit-level note: the officer's words belong on the CHECK they are
     about, where the public badge prints them. A paragraph attached to
     the visit would be a sentence nobody reading the badge would see. */
  function verifyEvidencePayload(id) {
    var d = evidenceDraft(id);
    var checks = [];
    evidenceKinds().forEach(function (k) {
      var c = d.checks[k.kind];
      if (c && c.on) checks.push({ kind: k.kind, detail: c.detail ? c.detail : null });
    });
    return { p_id: id, p_checks: checks };
  }

  function verifyAttest(id) {
    var payload = verifyEvidencePayload(id);
    if (!payload.p_checks.length) {
      alert('Tick at least one thing you checked. "Inspected" with nothing behind it is the one thing this badge must never say.');
      return Promise.resolve(null);
    }
    return ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/rpc/listing_attest', {
        method: 'POST', headers: h, body: JSON.stringify(payload)
      });
    })
      .then(function (r) {
        if (r.ok) return r.json();
        /* Same rule as the shift's two refusals: the function's sentence,
           then the status. listing_attest raises 42501 for the wrong
           login, which arrives as a 403 — read after the status it would
           sign the officer out for pressing a button that refused them. */
        return r.text().then(function (txt) {
          var err = apiErr(r, txt);
          var own = String(err.platform || '').match(/^listing_attest: (.+)$/);
          if (own) {
            err.message = own[1];
            err.refusal = true;
            throw err;
          }
          if (r.status === 401 || r.status === 403) {
            onAuthError(new Error('listing_attest'));
            throw new Error('Your session has expired, or this login may not record a visit.');
          }
          throw err;
        });
      })
      .then(function (out) {
        delete EVIDENCE_DRAFT[id];
        renderVerifyQueue();
        if (ArzuzSubmit && ArzuzSubmit.showToast) {
          ArzuzSubmit.showToast('Visit recorded — the listing is inspected, and the badge now names ' +
            payload.p_checks.length + (payload.p_checks.length === 1 ? ' check' : ' checks') +
            ' for six months.', 'success');
        }
        return out;
      })
      .catch(function (err) {
        alert('Could not record the visit: ' + err.message);
        return null;
      });
  }

  window.verifyEvidenceToggle = verifyEvidenceToggle;
  window.verifyEvidencePayload = verifyEvidencePayload;
  window.verifyAttest = verifyAttest;

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
    if (window.console) console.warn('[Arzuz Admin]', err && (err.detail || err.message));
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
    care: { title: 'Arzuz Care', icon: 'tag', label: 'Arzuz Care' },
    finance: { title: 'Finance — the books', icon: 'coin', label: 'Finance' },
    claims: { title: 'Repair Claims — the queue', icon: 'shield', label: 'Repair Claims' },
    growth: { title: 'Growth', icon: 'trending', label: 'Growth' },
    strategy: { title: 'Strategy', icon: 'book', label: 'Strategy' },
    settings: { title: 'Settings', icon: 'gear', label: 'Settings' }
  };

  /* small helper: the generated markup uses real icons everywhere */
  function ico(name, size) { return window.ArzuzUI ? ArzuzUI.icon(name, size || 16) : ''; }

  /* Sections hidden per role. The marketing login is prioritised for
     marketing: it lands on Growth and never sees the data tables or
     settings. Admin (the default) sees everything. */
  /* Sections hidden per role. This is a COURTESY, not the enforcement:
     supabase-team-roles.sql decides what each login can reach, and a
     hash typed into the address bar is gated a second time inside the
     router below. Marketing and finance land on a smaller dashboard
     because that is all their token can read, not because the others
     are hidden from them. */
  var ROLE_SECTIONS = {
    admin: null, // no restrictions
    marketing: ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'care', 'finance', 'claims', 'settings'],
    /* support lands on the Support Desk and works bookings + demands;
       listings are visible but read-only (actions hidden in the
       renderers). No scouts, roommates, growth, strategy or settings.

       FINANCE LEFT THIS LIST when the books moved to their own role
       (supabase-finance.sql section 4): the panel is hidden because the
       rows are gone, and a nav item pointing at an empty panel is a
       worse answer than no nav item. Care and Claims stay — recording a
       call-out and answering "where is my repair" IS the desk's job. */
    support: ['scout_submissions', 'roommate', 'growth', 'strategy', 'settings', 'finance'],

    /* verification reads a demand and a scout report, and may approve a
       listing — that IS the whole role. No bookings, no tickets, no
       roommates, no money, and nothing in Settings: it does not manage
       the team. */
    verification: ['bookings', 'tickets', 'roommate', 'care', 'finance', 'claims', 'growth', 'strategy', 'settings'],

    /* the money. Overview plus the books, and no waitlist table at all -
       the policies give it zero rows on every one of them, so showing it
       a demand list would be showing it an empty screen. */
    finance: ['demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'care', 'claims', 'growth', 'strategy', 'settings']
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
    if (sec === 'care') renderCarePanel();
    if (sec === 'finance') renderFinancePanel();
    if (sec === 'claims') renderClaimsPanel();
    if (sec === 'tickets') { renderSupportDesk(); renderStatusHistory(); }
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
        roommateSummary: state.roommateSummary,
        /* A failed scrubbed view (state.feedsMissing) is said out loud on
           this page, not left to draw zeros: see the note in
           assets/strategy.js renderGrowth. */
        feedsMissing: state.feedsMissing
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
      /* the shift is drawn beside the table it is about, from the queue
         function rather than from the loaded rows: what this panel must
         show is what the DATABASE considers owed a visit, and the rows a
         page holds can be minutes old */
      renderVerifyQueue();
    }

    /* The hourly line is global, so it is re-read on every navigation —
       throttled inside loadHealth, because a click-through is faster
       than the probe behind it. */
    loadHealth();
  }

  window.addEventListener('hashchange', renderRoute);

  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () {
      if (location.hash === '#/' + b.dataset.section) renderRoute();
      else location.hash = '#/' + b.dataset.section;
    });
  });

  /* ================= 2b. Shared touch-drag engine =================

     The drawer, the bottom sheets and the lightboxes are all thrown the
     same way, and the physics used to be copied into each one:

       · a slop gate that first decides which axis the finger means, so a
         vertical scroll and a sideways swipe never fight over a gesture,
       · a TICK-window velocity sample, so a stale sample cannot drag the
         average towards a speed the finger is no longer doing,
       · Apple's exponential momentum projection (WWDC 2018, "Designing
         Fluid Interfaces"), so a flick keeps travelling after release,
       · a click seal, so a throw that lands on a button cannot press it.

     Those four live here once. A surface now supplies only its own
     geometry (canStart / allow), its own paint (onDrag) and its own
     release policy (onEnd) — see the drawer (2c), the sheets (2d) and
     the lightboxes (2e). ES5, no deps. */

  /* The physics itself now lives in assets/swipe-gesture.js, loaded
     before this file by admin.html, so it can be driven by a Node
     harness with synthetic pointer events (`npm run test:gesture`).
     The four rules in it are the four that are invisible in a
     screenshot and tedious to reproduce by hand: the slop gate, the
     TICK-window velocity sample, pointer ownership, and the click seal.

     The wrapper is what keeps the three call sites below unchanged —
     `new SwipeGesture(opts)` returning an object is still `new`, and a
     missing module degrades to a surface that simply does not drag,
     with one warning, rather than a TypeError that would take the whole
     dashboard's boot with it. */
  var SwipeEngine = (typeof ArzuzSwipeGesture !== 'undefined') ? ArzuzSwipeGesture : null;
  var warnedNoEngine = false;
  function SwipeGesture(opts) {
    if (!SwipeEngine) {
      if (!warnedNoEngine) {
        warnedNoEngine = true;
        console.warn('[admin] assets/swipe-gesture.js did not load — the drawer, ' +
          'bottom-sheet and lightbox gestures are unavailable on this page.');
      }
      return;
    }
    return new SwipeEngine(opts);
  }

  /* The three RELEASE POLICIES — where a throw lands, when a sheet is
     dismissed, what a momentum coast may carry — now live in
     assets/release-policy.js, loaded before this file, so they can be
     swept in Node (`npm run test:policy`) across hundreds of geometries
     and velocities with no DOM and no dashboard boot.

     What stays here is the STATE: which gesture is live, where the finger
     has taken the surface, and what each surface does with the answer
     (openDrawer, slideAway, dismiss). A missing module degrades exactly
     the way a missing engine does below — the drag gestures are not
     registered, with one warning, rather than a TypeError thrown from
     inside a pointermove. */
  var Policy = (typeof ArzuzReleasePolicy !== 'undefined') ? ArzuzReleasePolicy : null;
  var warnedNoPolicy = false;
  function warnNoPolicy() {
    if (warnedNoPolicy) return;
    warnedNoPolicy = true;
    console.warn('[admin] assets/release-policy.js did not load — the drawer, ' +
      'bottom-sheet and lightbox drag gestures are unavailable on this page.');
  }

  /* ================= 2c. Sidebar: collapsible on desktop,
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

    var DOW = 0, OPEN0 = false, CUR = 0;

    function drawerWidth() {
      var r = side.getBoundingClientRect();
      return Policy.drawerWidth(r && r.width, window.innerWidth);
    }

    /* paint(raw): raw is where the finger put the drawer (px, 0 =
       fully open, -width = fully shut). Past either resting edge
       the door drags against its hinge — overscroll-style. Which edge
       gives, and by how much, is the policy's own arithmetic: see
       drawerPaint() in assets/release-policy.js. */
    function paint(raw) {
      CUR = raw;
      var v = Policy.drawerPaint(raw, DOW);
      side.style.setProperty('--side-x', v.x + 'px');
      /* the edge grip rides the drawer's leading edge (see .side-grip) */
      body.style.setProperty('--side-edge', v.edge + 'px');
      if (scrim) scrim.style.opacity = v.scrim;
    }

    if (!Policy) { warnNoPolicy(); return; }

    new SwipeGesture({
      axis: 'x',
      canStart: function (e) {
        if (isDesktop()) return false;
        OPEN0 = body.classList.contains('side-open') && side.classList.contains('open');
        /* a modal owns the screen while it is up: opening the drawer
           behind it would leave two overlays fighting over one gesture */
        if (!OPEN0 && document.querySelector('.modal-overlay.open, .lightbox.open')) return false;
        var inDrawer = !!(e.target && e.target.closest && e.target.closest('.admin-side'));
        var onScrim = !!(e.target && e.target.closest && e.target.closest('.side-scrim'));
        if (!OPEN0 && e.clientX > 28) return false;     /* edge zone only */
        if (OPEN0 && !inDrawer && !onScrim) return false;  /* the drawer or its scrim */
        return true;
      },
      allow: function () { return true; },              /* both directions are a pull */
      onBegin: function () {
        DOW = drawerWidth();
        body.classList.add('side-dragging');            /* kills the transition */
      },
      onDrag: function (d) { paint(OPEN0 ? d : d - DOW); },
      onEnd: function (v, d, proj) {
        var shouldOpen = Policy.policyFor('drawer').release(v, CUR, proj, DOW);
        /* hand off to the CSS transition from exactly where the finger
           left the drawer — removing the drag class and the inline px
           var IS the seam; the transition starts at the live value */
        body.classList.remove('side-dragging');
        side.style.removeProperty('--side-x');
        body.style.removeProperty('--side-edge');
        if (scrim) scrim.style.opacity = '';
        CUR = 0;
        if (shouldOpen) {
          if (!OPEN0) openDrawer();
        } else if (OPEN0) {
          closeDrawer();
        } else if (scrim) {
          scrim.classList.remove('show');
        }
      }
    });

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

  /* ================= 2d. Bottom sheets: swipe down to dismiss.

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

    if (!Policy) { warnNoPolicy(); return; }

    var OV = null, BOX = null;

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
      var token = ov.__openToken;
      var h = box.offsetHeight || 1;
      box.style.setProperty('--sheet-y', (h + 40) + 'px');
      ov.style.setProperty('--sheet-o', '0');
      setTimeout(function () {
        /* reopened while the throw was in flight: that open wins */
        if (ov.__openToken !== token) { clearVars(ov, box); return; }
        if (closeVia(ov)) setTimeout(function () { clearVars(ov, box); }, 340);
        else clearVars(ov, box);          /* stayed open — put it back in place */
      }, 210);
    }

    new SwipeGesture({
      axis: 'y',
      canStart: function (e) {
        if (isDesktop()) return false;
        var t = e.target;
        if (!t || !t.closest) return false;
        var head = t.closest('.modal-head');
        if (!head) return false;                        /* the header is the grab zone */
        var box = head.closest('.modal-box');
        var ov = (box && box.closest) ? box.closest('.modal-overlay') : null;
        if (!box || !ov || !ov.classList.contains('open')) return false;
        OV = ov; BOX = box;
        return true;
      },
      allow: function (d) { return d > 0; },            /* upward is not a dismiss */
      onBegin: function () {
        /* a grab outranks the open animation: when popIn is still in
           flight its transform would override the one painted below, so
           cancel it and let the finger own the frame */
        if (BOX.getAnimations) BOX.getAnimations().forEach(function (a) { a.cancel(); });
        body.classList.add('sheet-dragging');
      },
      onAbort: function () { OV = null; BOX = null; },
      onDrag: function (dy) {
        var h = BOX.offsetHeight || 1;
        var p = Policy.surfacePaint(dy);                /* resistance when lifted */
        BOX.style.setProperty('--sheet-y', p + 'px');
        OV.style.setProperty('--sheet-o', Math.max(0.06, Math.min(1, 1 - dy / (h * 1.4))).toFixed(3));
      },
      onEnd: function (v, dy, proj) {
        var ov = OV, box = BOX;
        OV = null; BOX = null;
        if (!ov || !box) return;
        body.classList.remove('sheet-dragging');
        var h = box.offsetHeight || 1;
        /* a flick wins outright; otherwise where the finger left the sheet,
           plus the coast it is carrying, has to clear the policy's own line
           for this height — see surfaceRelease() in
           assets/release-policy.js */
        if (Policy.policyFor('sheet').release(v, dy, proj, h)) {
          slideAway(ov, box);
        } else {
          box.style.setProperty('--sheet-y', '0px');    /* snap back */
          ov.style.setProperty('--sheet-o', '1');
          setTimeout(function () { clearVars(ov, box); }, 260);
        }
      }
    });
  })();

  /* ================= 2e. Lightboxes: swipe down to dismiss =================

     The same throw as the sheets, on the two full-screen viewers. The
     photo lightbox has nothing else to drag, so the whole surface is the
     grab zone; the video card hands over its title row and leaves the
     player's own controls alone. The video one must leave through
     closeVideoLightbox(): a bare hide() would strand ArzuzVideo's player,
     still polling a detached iframe. */

  (function initLightboxGestures() {
    var body = document.body;
    var mq = (typeof window.matchMedia === 'function') ? window.matchMedia('(min-width: 861px)') : null;
    function isDesktop() { return mq ? mq.matches : true; }

    if (!Policy) { warnNoPolicy(); return; }

    var OV = null, TARGET = null;

    function clearVars(ov, target) {
      if (target) target.style.removeProperty('--lb-y');
      if (ov) ov.style.removeProperty('--lb-o');
    }

    /* the video lightbox owns a live player, so dismissing it has to run
       the teardown rather than just hide the overlay */
    function dismiss(ov) {
      if (ov.id === 'videoLightbox') closeVideoLightbox();
      else hide(ov);
    }

    /* hand the viewer to the CSS transition from the live finger
       position, then dismiss once it is off-screen */
    function slideAway(ov, target) {
      var token = ov.__openToken;
      var h = target.offsetHeight || 1;
      target.style.setProperty('--lb-y', (h + 60) + 'px');
      ov.style.setProperty('--lb-o', '0');
      setTimeout(function () {
        if (ov.__openToken !== token) { clearVars(ov, target); return; }  /* reopened mid-throw */
        dismiss(ov);
        setTimeout(function () { clearVars(ov, target); }, 340);
      }, 210);
    }

    new SwipeGesture({
      axis: 'y',
      canStart: function (e) {
        if (isDesktop()) return false;
        var t = e.target;
        if (!t || !t.closest) return false;
        var ov = t.closest('.lightbox');
        if (!ov || !ov.classList.contains('open')) return false;
        /* the player keeps its own drags (the scrub bar); only the title
           row is a grab zone, the same rule the sheets use */
        if (t.closest('video')) return false;
        var target;
        if (ov.id === 'videoLightbox') {
          if (!t.closest('.lb-head')) return false;
          target = ov.querySelector('.lb-frame');
        } else {
          target = ov.querySelector('.lb-inner');
        }
        if (!target) return false;
        OV = ov; TARGET = target;
        return true;
      },
      allow: function (d) { return d > 0; },            /* upward is not a dismiss */
      onBegin: function () {
        if (TARGET.getAnimations) TARGET.getAnimations().forEach(function (a) { a.cancel(); });
        body.classList.add('lb-dragging');
      },
      onAbort: function () { OV = null; TARGET = null; },
      onDrag: function (dy) {
        var h = TARGET.offsetHeight || 1;
        var p = Policy.surfacePaint(dy);                /* resistance when lifted */
        TARGET.style.setProperty('--lb-y', p + 'px');
        OV.style.setProperty('--lb-o', Math.max(0.06, Math.min(1, 1 - dy / (h * 1.4))).toFixed(3));
      },
      onEnd: function (v, dy, proj) {
        var ov = OV, target = TARGET;
        OV = null; TARGET = null;
        if (!ov || !target) return;
        body.classList.remove('lb-dragging');
        var h = target.offsetHeight || 1;
        if (Policy.policyFor('lightbox').release(v, dy, proj, h)) {
          slideAway(ov, target);
        } else {
          target.style.setProperty('--lb-y', '0px');    /* snap back */
          ov.style.setProperty('--lb-o', '1');
          setTimeout(function () { clearVars(ov, target); }, 260);
        }
      }
    });
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

  /* The three reads behind the Roommate panel's questionnaire block,
     in one promise.

     env=eq.production is asked for at the source rather than filtered
     afterwards: test rows live in the same table, and a pool count that
     quietly includes them is a number nobody should act on.

     Every failure path resolves to [] instead of throwing. A missing
     supabase-roommate.sql is the expected state on a fresh database, and
     it should look like an empty pool with a note — not like a dashboard
     that broke. */
  function fetchRoommatePool(h) {
    function get(path) {
      return fetch(apiRoot() + '/rest/v1/' + path, { headers: h })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
    }
    return Promise.all([
      get('roommate_engine_summary?select=*'),
      get('roommate_profiles?select=*&env=eq.production&order=created_at.desc&limit=200'),
      get('roommate_mutual_pairs?select=*&order=matched_at.desc'),
      /* The consent trail. Also env-scoped and capped: this is a feed to
         read, not an export — the table itself is the record. */
      get('roommate_events?select=*&env=eq.production&order=created_at.desc&limit=40')
    ]).then(function (out) {
      return {
        engine: (out[0] && out[0][0]) || null,
        profiles: out[1] || [],
        pairs: out[2] || [],
        trail: out[3] || []
      };
    });
  }

  function fetchData() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
    state.feedsMissing = false;
    /* Beside the data reads, because it answers a different question
       and must not hold them up: what did the hourly check last
       ACCEPT? Forced, because this is a sign-in or a Refresh press and
       both ask for the reading as it is now. */
    loadHealth(true);
    var role = currentRole();
    ArzuzAuth.headers().then(function (h) {
      var promises = TABLES.map(function (tbl) {
        var url = apiRoot() + '/rest/v1/' + relFor(tbl) + '?select=*&order=created_at.desc';
        return fetch(url, { headers: h }).then(function (r) {
          /* The reason is kept as well as the status: onAuthError shows the
             gate and logs this line, and "401" alone would not say which
             read was refused. */
          if (r.status === 401 || r.status === 403) throw apiErr(r, 'Not authorised', { auth: true });
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

      /* The questionnaire pool — admin only, on purpose.

         supabase-roommate.sql scopes those two tables with
         public.arzuz_role(): a support or marketing login is answered
         with an empty list, so asking would cost three requests per
         refresh and return nothing. (Empty, not 403 — PostgREST filters
         rows rather than refusing, and fetchData treats a 403 as a dead
         session and signs the user out.) */
      promises.push(role === 'admin' ? fetchRoommatePool(h) : Promise.resolve(null));

      /* Arzuz Care — admin and support, because support is who records
         the visit. Marketing is left out for the same reason it is left
         out of the roommate pool: a plan is a phone number plus a bill,
         and its policy gives marketing nothing to read anyway. */
      promises.push((role === 'admin' || role === 'support') ? fetchCare(h) : Promise.resolve(null));

      return Promise.all(promises).then(function (results) {
        state.data.demand_records = results[0] || [];
        state.data.listings = results[1] || [];
        state.data.scout_submissions = results[2] || [];
        state.data.booking_requests = results[3] || [];
        state.minors = results[4] || [];
        state.roommateSummary = (results[5] && results[5][0]) ? results[5][0] : null;
        state.data.support_tickets = results[6] || [];
        state.roommatePool = results[7] || { engine: null, profiles: [], pairs: [], trail: [] };
        state.care = results[8] || { plans: [] };
        renderRoute();
      });
    }).catch(function (err) {
      if (err && err.auth) onAuthError(err);
      else if (window.console) console.warn('[Arzuz Admin] fetch failed:', err && (err.detail || err.message));
    });
  }

  /* ================= 3c. The hourly check, in one line =================

     THE QUESTION THIS ANSWERS

       The scheduled probe writes down when each credential last passed
       (netlify/functions/lib/health-state.js) and announces recoveries.
       Until this line existed, the only way to learn that state was to
       be paged — which tells you it broke, never that it is fine.

     WHAT IT PRINTS, AND WHAT IT REFUSES TO PRINT

       One line, from POST /api/health-summary: the last accepted hour for
       the database, the Paystack key and the Telegram token. The page does
       not judge staleness, absence or refusal — the endpoint composes the
       sentence with the SAME ninety-minute grace the all-clear uses, so
       the two can never disagree. A check with no recorded hour is said to
       have none; an unreadable marker is said to be unreadable. Neither is
       painted green.

     A DASHBOARD IS LEFT OPEN ON A WALL

       A line loaded at 9am that still says "14:00" at midnight is worse
       than no line. So it is re-read whenever the tab comes back or a
       section is opened (throttled to a minute), on sign-in, and on
       Refresh. The sentence itself carries the time it was READ, so a
       page nobody has touched since goes visibly old rather than quietly
       wrong.
     ============================================================ */

  function loadHealth(force) {
    if (state.health.busy) return;
    if (!(window.ArzuzAuth && ArzuzAuth.signedIn && ArzuzAuth.signedIn())) return;
    /* Navigating between sections asks again, but no more than once a
       minute: a dashboard is clicked through far faster than the probe
       behind this writes, and the answer cannot change in between. */
    if (!force && state.health.readAt && (Date.now() - state.health.readAt) < 60000) return;
    state.health.readAt = Date.now();
    state.health.busy = true;
    ArzuzAuth.headers().then(function (h) {
      return fetch('/api/health-summary', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: '{}'
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.status === 401) throw new Error('Your session has expired — sign in again.');
        if (!r.ok) throw apiErr(r, body);
        state.health.data = body;
        state.health.error = null;
      });
    }).catch(function (err) {
      /* Quiet on purpose: this line is a convenience, and a console
         warning here would be the only trace of a probe that is fine but
         an endpoint that is not deployed yet. The line itself says so. */
      state.health.error = err;
    }).then(function () {
      state.health.busy = false;
      renderHealthLine();
    });
  }

  function renderHealthLine() {
    var el = $('healthLine'), text = $('healthText');
    if (!el || !text) return;

    var level = 'warn';
    var line;
    if (state.health.error) {
      line = 'Hourly checks — could not be read: ' +
        ((state.health.error && state.health.error.message) || 'no answer') + '.';
    } else if (state.health.data) {
      level = state.health.data.level === 'ok' ? 'ok' : 'warn';
      line = state.health.data.line || 'Hourly checks — the answer carried no reading.';
    } else {
      /* Nothing has been asked yet. The placeholder in admin.html stays
         hidden rather than claiming a reading nobody has. */
      return;
    }

    el.className = 'health-line ' + level;
    text.textContent = line;
    el.hidden = false;
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) loadHealth(true);
  });

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
    var engine = (state.roommatePool || {}).engine;

    metricEl.innerHTML =
      '<h3>' + ico('users', 18) + ' Roommate matching — the one number</h3>' +
      '<p class="sub">The plan tracks exactly one roommate metric: the share of shared-type roommate demand matched within 14 days. A matching feature with nothing matched is just a form.</p>' +
      '<div class="metrics-grid" style="margin-top:14px">' +
        '<div class="metric-card"><div class="metric-lbl">Matched in 14 days</div><div class="metric-num">' + (rs ? esc(String(rs.pct_matched_within_14d)) + '%' : '—') + '</div><div class="metric-sub">' + (rs ? esc(rs.matched_within_14d + ' of ' + rs.roommate_demands_total + ' roommate requests') : 'Run supabase-media-booking.sql to enable this metric') + '</div></div>' +
        '<div class="metric-card"><div class="metric-lbl">Waiting now</div><div class="metric-num">' + waiting.length + '</div><div class="metric-sub">Open roommate requests to pair</div></div>' +
        /* The questionnaire engine's own numbers, next to the demand-based
           ones above rather than replacing them: the metric above counts
           requests the team took down by hand, these count students who
           matched themselves. The two will disagree for a long time, and
           watching that gap close is the point. */
        (engine
          ? '<div class="metric-card"><div class="metric-lbl">Questionnaires in</div><div class="metric-num">' + engine.profiles_total + '</div>' +
            '<div class="metric-sub">' + engine.profiles_open + ' still open \u00B7 ' + engine.mutual_pairs + ' mutual ' + (engine.mutual_pairs === 1 ? 'match' : 'matches') + '</div></div>' +
            '<div class="metric-card"><div class="metric-lbl">Questionnaire 14-day Match</div><div class="metric-num">' + engine.pct_matched_within_14d + '%</div>' +
            '<div class="metric-sub">' + engine.matched_within_14d + ' of ' + engine.profiles_total + ' matched within 14 days</div></div>'
          : '') +
      '</div>' +
      /* The daily digest is the one thing in this section that happens when
         nobody is looking, so it is also the one thing that cannot be read
         off the screen. This composes it on demand — from the server, with
         the real window and the real staleness rule — and sends nothing. */
      '<div class="mate-actions" style="margin-top:12px">' +
        '<button type="button" class="btn-inline" id="btnDigestPreview">' + ico('calendar', 13) + ' Preview the daily digest</button>' +
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
    html += renderPoolHtml();
    panel.innerHTML = html;
  }

  /* ================= 4c. The questionnaire pool =================
     The matching engine the public /roommates page writes into.

     The block above pairs students the team registered by hand, from
     demand records. This one shows the profiles students filled in
     themselves, and the pairs that BOTH of them already accepted in the
     browser — double opt-in, enforced in
     netlify/functions/roommate-match.js.

     Read-only on purpose. A mutual match is two students' decision, and
     the pair is what unlocked their contact details; a "pair" button
     here would let a dashboard click overrule consent, so there is not
     one. The team's job at this point is to send the introduction. */

  function renderPoolHtml() {
    var pool = state.roommatePool || {};
    var engine = pool.engine;
    /* env=eq.production is asked for at fetch time; this is the belt to
       that braces, for a row the query could not exclude. */
    var profiles = (pool.profiles || []).filter(function (r) { return !isTestRow(r); });
    var pairs = pool.pairs || [];
    var waiting = profiles.filter(function (r) { return str(r.status).toLowerCase() === 'open'; });

    var html = '<h3 style="margin:26px 0 10px;font-size:15px">' + ico('users', 16) +
      ' The questionnaire pool</h3>' +
      '<p class="sub">Students who answered the two-sided questionnaire on /roommates themselves. ' +
      'Their deal-breakers have already been applied to every pair they were shown, so what is left here ' +
      'is everyone still waiting.</p>';

    /* Empty and a missing migration look identical from here, so say both. */
    if (!engine && !profiles.length) {
      return html + '<div class="ops-row"><span class="ic">' + ico('alert', 15) + '</span><span class="tx">' +
        '<b>Nothing to show yet</b><span>If supabase-roommate.sql has not been run in Supabase, run it — ' +
        'the questionnaire tables do not exist until you do. Otherwise the pool is genuinely empty.</span>' +
        '</span></div>';
    }

    /* ---- already matched both ways: send the introductions ---- */
    if (pairs.length) {
      html += '<h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.7">' +
        'Matched both ways \u2014 send the intros</h4>';
      pairs.forEach(function (m) {
        var waA = waLink(m.a_phone), waB = waLink(m.b_phone);
        /* Each student gets the OTHER one's name in the greeting — the
           same intro the demand-based block above writes, so the team
           sends one consistent message whichever route made the match. */
        var introA = 'Hi ' + (m.a_name || 'there') + '! Arzuz here. You and ' + (m.b_name || 'your match') +
          ' both said yes, so you are matched as roommates. Want to agree the split on WhatsApp?';
        var introB = 'Hi ' + (m.b_name || 'there') + '! Arzuz here. You and ' + (m.a_name || 'your match') +
          ' both said yes, so you are matched as roommates. Want to agree the split on WhatsApp?';
        html += '<div class="mate-card">' +
          '<div class="mate-head"><b>' + esc(m.a_name || 'Student') + ' \u2194 ' + esc(m.b_name || 'Student') + '</b>' +
          '<span>matched ' + esc(fmtDate(m.matched_at)) + '</span></div>' +
          '<div class="mate-meta">' +
            (m.a_area ? '<span>' + ico('pin', 13) + ' ' + esc(m.a_area) + '</span>' : '') +
            (m.a_budget ? '<span>' + ico('tag', 13) + ' ' + esc(ngn(m.a_budget)) + '</span>' : '') +
            (m.b_area ? '<span>' + ico('pin', 13) + ' ' + esc(m.b_area) + '</span>' : '') +
            (m.b_budget ? '<span>' + ico('tag', 13) + ' ' + esc(ngn(m.b_budget)) + '</span>' : '') +
          '</div>' +
          '<div class="mate-actions">' +
            (waA ? '<a class="wa-btn" href="' + waA + '?text=' + encodeURIComponent(introA) + '" target="_blank" rel="noopener">Intro \u2192 ' + esc(m.a_name || 'student A') + '</a>' : '') +
            (waB ? '<a class="wa-btn" style="margin-left:8px" href="' + waB + '?text=' + encodeURIComponent(introB) + '" target="_blank" rel="noopener">Intro \u2192 ' + esc(m.b_name || 'student B') + '</a>' : '') +
            /* One dossier per side of the pair — the complaint about a
               match comes from one of the two, not from the pair. */
            '<button type="button" class="btn-inline" style="margin-left:8px" data-act="dossier" data-id="' + esc(m.a_id) + '">Dossier \u2192 ' + esc(m.a_name || 'student A') + '</button>' +
            '<button type="button" class="btn-inline" style="margin-left:8px" data-act="dossier" data-id="' + esc(m.b_id) + '">Dossier \u2192 ' + esc(m.b_name || 'student B') + '</button>' +
          '</div></div>';
      });
    }

    /* ---- still waiting ---- */
    html += '<h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.7">' +
      'Waiting in the pool (' + waiting.length + ')</h4>';
    if (!waiting.length) {
      html += '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx">' +
        '<b>Everyone in the pool has matched</b><span>A new questionnaire answer appears here the moment ' +
        'a student finishes it on /roommates.</span></span></div>';
    }
    waiting.forEach(function (r) {
      var name = pick(r, 'first_name', ['name']) || 'Student';
      var wa = waLink(pick(r, 'phone', ['phone']));
      var dbs = toList(r.dealbreakers);
      var chips = '';
      if (r.sleep) chips += '<span>' + ico('moon', 13) + ' ' + esc(r.sleep) + '</span>';
      if (r.cleanliness) chips += '<span>' + ico('check', 13) + ' cleans ' + esc(str(r.cleanliness).toLowerCase()) + '</span>';
      if (r.guests) chips += '<span>' + ico('users', 13) + ' ' + esc(r.guests) + '</span>';
      if (r.smoking) chips += '<span>' + ico('alert', 13) + ' ' + esc(r.smoking) + '</span>';
      if (r.noise) chips += '<span>' + ico('moon', 13) + ' ' + esc(r.noise) + '</span>';
      if (r.split_ok) chips += '<span>' + ico('tag', 13) + ' ' + esc(r.split_ok) + '</span>';

      html += '<div class="mate-card">' +
        '<div class="mate-head"><b>' + esc(name) + '</b>' +
        '<span>' + esc(pick(r, 'area', ['area']) || 'No area given') +
        (r.budget_ngn ? ' \u00B7 ' + esc(ngn(r.budget_ngn)) + ' a session' : '') + '</span></div>' +
        '<div class="mate-meta">' + chips +
          '<span>' + ico('calendar', 13) + ' ' + esc(ageLabel(r.created_at)) + ' ago</span>' +
          '<button type="button" class="btn-inline" data-act="dossier" data-id="' + esc(r.id) + '">' + ico('users', 13) + ' Dossier</button>' +
          (wa ? '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
        '</div>' +
        /* The ticked deal-breakers, shown because they are the reason
           this student is seeing a small pool and the team is about to
           be asked why. */
        (dbs.length
          ? '<div class="mate-meta" style="margin-top:6px;color:var(--aerr)"><span>' + ico('alert', 13) +
            ' Deal-breakers: ' + esc(dbs.join(', ')) + '</span></div>'
          : '') +
        '</div>';
    });

    /* ---- withdrawn: out of the pool, still on the record ----
       A closed profile is in neither list above, and it is the case most
       likely to produce a phone call — someone who asked us to stop and
       has not been removed from a page they can see. Keeping them reachable
       is the point of the trail: the record outlives the listing. */
    var closed = profiles.filter(function (r) { return str(r.status).toLowerCase() === 'closed'; });
    if (closed.length) {
      html += '<h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.7">' +
        'Withdrawn (' + closed.length + ')</h4>' +
        '<p class="sub">Out of everyone else\u2019s matches, and never off the record. ' +
        'Their dossier is still reachable in one click.</p>';
      closed.forEach(function (r) {
        html += '<div class="mate-cand"><div>' +
          '<b>' + esc(pick(r, 'first_name', ['name']) || 'Student') + '</b>' +
          '<span>' + esc(str(r.notes) || 'withdrew') + ' \u00b7 answered ' + esc(ageLabel(r.created_at)) + ' ago</span>' +
          '</div><button type="button" class="btn-inline" data-act="dossier" data-id="' + esc(r.id) + '">' +
          ico('users', 13) + ' Dossier</button></div>';
      });
    }

    html += stallHtml();

    return html + consentTrailHtml();
  }

  /* ================= 4d. The consent trail =================
     roommate_events — the append-only log roommate-match.js writes.

     It exists because roommate_interests holds only the LATEST decision
     per pair: a student who says yes and then changes their mind leaves
     one row saying 'pass'. "Who agreed to this, and when" is the
     question a disputed unlock actually asks, and this is the record
     that can answer it — the names are snapshotted at the time, so a
     line still reads years later even if the profile is deleted.

     Read-only, and more strictly so than the pool above: the database
     grants no client role INSERT, UPDATE or DELETE on this table, so a
     button here could not work even if one were drawn. */

  function consentLineHtml(e) {
    /* actor_name / subject_name are the stored name (the same value the
       profile's first_name column holds), escaped here because they are
       student-typed text going into innerHTML. */
    var actor = esc(e.actor_name || 'Student');
    var subject = esc(e.subject_name || 'a student');
    var tag = 'tag-draft';
    var line = esc(e.event);

    /* Plain text, no inner markup: .mate-cand renders its <b> as a block,
       so a nested <b> would break the sentence across lines. The whole
       sentence is the title line, the subtitle carries the time. */
    if (e.event === 'created') {
      tag = 'tag-viewed';    line = actor + ' joined the pool';
    } else if (e.event === 'accept') {
      tag = 'tag-open';      line = actor + ' said yes to ' + subject;
    } else if (e.event === 'pass') {
      tag = 'tag-cancelled'; line = actor + ' passed on ' + subject;
    } else if (e.event === 'withdrawn') {
      tag = 'tag-inactive';  line = actor + ' withdrew';
    } else if (e.event === 'matched') {
      tag = 'tag-matched';   line = 'Both said yes \u2014 ' + actor + ' \u2194 ' + subject;
    } else if (e.event === 'viewed') {
      /* Written by the engine the first time a matched student is shown
         their match's number. It is on this record on purpose: "was my
         number ever put in front of them, and when" is a question the
         company is expected to answer. */
      tag = 'tag-viewed';    line = actor + ' opened their matches and was shown ' + subject + '\u2019s number';
    }

    return '<div class="mate-cand"><div>' +
      '<b>' + line + '</b>' +
      '<span>' + (e.event === 'matched' ? 'contact unlocked for both \u00b7 ' : '') +
      esc(ageLabel(e.created_at)) + ' ago</span></div>' +
      /* The raw event name, not a prettier synonym: a line here can be
         searched for verbatim in roommate_events. */
      '<span class="tag-status ' + tag + '">' + esc(e.event) + '</span></div>';
  }

  function consentTrailHtml() {
    var trail = (state.roommatePool || {}).trail || [];
    var html = '<h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.7">' +
      'Consent trail (' + trail.length + ')</h4>' +
      '<p class="sub">Every answer a student has given, newest first, with their name as it was at the time. ' +
      'Append-only: the database gives no login the right to change or delete a line, so this is what a ' +
      'disputed match gets read back against.</p>';

    if (!trail.length) {
      return html + '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx">' +
        '<b>No consent events yet</b><span>One appears the moment a student answers the questionnaire ' +
        'on /roommates. If supabase-roommate.sql has not been run, the table does not exist yet.</span>' +
        '</span></div>';
    }

    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    trail.forEach(function (e) { html += consentLineHtml(e); });
    return html + '</div>';
  }

  /* ================= 4i. Arzuz Care — the ₦20,000 session ====
     care.html is the specification: ₦20,000 for the session, four
     call-outs, parts under ₦3,000 included, refundable before the
     session starts. This panel is how the team OPERATES that:

       - it READS care_plans_live, a view, never the ledger
       - every button POSTs to /api/care-credit, which holds the
         service key and appends the ledger row
       - it cannot set a balance by hand, and that is not a
         limitation to work around: supabase-care.sql gives no
         client role an INSERT on either table, so a panel that
         could write one would be a panel that could invent a
         call-out the student never had.

     A refusal is shown where it happened, in the row's own drawer,
     rather than as a toast that scrolls away — "no call-outs left"
     is a fact about that student, not a notification. */

  function fetchCare(h) {
    return fetch(apiRoot() + '/rest/v1/care_plans_live?select=*&env=eq.production&order=created_at.desc&limit=200', { headers: h })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (rows) { return { plans: rows || [] }; });
  }

  function carePlans() {
    return ((state.care || {}).plans || []).filter(function (r) { return !isTestRow(r); });
  }

  /* What care.html publishes, kept here so the drawer can quote the same
     ceiling the function enforces (PARTS_INCLUDED_NGN in care-credit.js). */
  var PARTS_INCLUDED_NGN = 3000;
  /* The other two published numbers, quoted here for the same reason:
     the panel states the promise the function enforces. All three
     files are pinned together by the drift check in dev/sql-proof.mjs,
     so a change to one that is not made to the others fails a suite
     rather than quietly disagreeing with care.html. */
  var CALL_OUTS_INCLUDED = 4;
  var SESSION_FEE_NGN = 20000;

  function careBalanceChip(p) {
    var left = Number(p.balance) || 0;
    var total = Number(p.granted) || 0;
    var cls = left > 0 ? 'tag-open' : 'tag-cancelled';
    var label = p.status === 'refunded' ? 'refunded — 0 of ' + total + ' left'
      : p.status === 'ended' ? 'session ended — ' + (Number(p.call_outs) || 0) + ' of ' + total + ' used'
      : left + ' of ' + total + ' call-outs left';
    return '<span class="tag-status ' + cls + '">' + esc(label) + '</span>';
  }

  function careRowHtml(p) {
    var name = p.first_name || 'Student';
    var wa = waLink(p.phone);
    var open = state.careSpend && state.careSpend.plan === p.id;
    var canSpend = (Number(p.balance) || 0) > 0 && p.status === 'active';
    var canRefund = p.status === 'active' && (Number(p.call_outs) || 0) === 0;

    var html = '<div class="mate-cand"><div>' +
      '<b>' + esc(name) + '</b>' +
      '<span>' + esc(p.session || '—') + ' · ' + esc(ngn(p.amount_ngn || 0)) + ' · ' + esc(p.status || 'active') +
      (p.area ? ' · ' + esc(p.area) : '') +
      (p.property ? ' · ' + esc(p.property) : '') +
      ' · <span style="font-family:var(--mono)">' + esc(String(p.phone || 'no phone')) + '</span></span></div>' +
      '<div class="mate-actions">' + careBalanceChip(p) +
      (wa ? '<a class="wa-btn" style="margin-left:8px" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
      '<button type="button" class="btn-inline" style="margin-left:8px" data-care="spend-open" data-plan="' + esc(p.id) + '"' +
      (canSpend ? '' : ' disabled title="No call-outs left on this plan"') + '>Record a call-out</button>' +
      '<button type="button" class="btn-inline" style="margin-left:8px" data-care="refund" data-plan="' + esc(p.id) + '"' +
      (canRefund ? '' : ' disabled title="Not refundable: the session has used a call-out, or is no longer active"') +
      '>Refund</button>' +
      '<button type="button" class="btn-inline" style="margin-left:8px" data-care="expire" data-plan="' + esc(p.id) + '"' +
      (p.status === 'active' ? '' : ' disabled') + '>End session</button>' +
      '</div>';

    /* The drawer: who did the work, what the parts cost. Two fields,
       because a call-out with no worker recorded is a credit taken
       for nothing anybody can name later. */
    if (open) {
      html += '<div class="care-drawer" style="margin-top:10px">' +
        '<div class="edit-fld"><label>Who did the work</label>' +
        '<input type="text" id="careWorker" placeholder="e.g. Compound caretaker, or a name" value="' + esc(state.careSpend.worker || '') + '"></div>' +
        '<div class="edit-fld"><label>Parts cost (₦, 0 if none)</label>' +
        '<input type="text" id="careParts" inputmode="numeric" placeholder="0" value="' + esc(state.careSpend.parts || '') + '"></div>' +
        '<div class="edit-fld"><label>What was it</label>' +
        '<input type="text" id="careReason" placeholder="e.g. blocked kitchen sink" value="' + esc(state.careSpend.reason || '') + '"></div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<button type="button" class="btn-inline" data-care="spend-confirm" data-plan="' + esc(p.id) + '">Record it — 1 credit</button>' +
        '<button type="button" class="btn-inline" data-care="spend-cancel">Cancel</button>' +
        '<span class="sub" id="careDrawerNote">Parts over ' + esc(ngn(PARTS_INCLUDED_NGN)) + ' are quoted to the student first — the ledger notes it either way.</span>' +
        '</div></div>';
    }

    return html + '</div>';
  }

  /* ------------------------------------------------------------
     Opening a plan from the dashboard

     The one Care action that creates money rather than recording
     work, and therefore the one that is gated rather than just
     logged:

       - it is offered to the roles the FUNCTION accepts (admin and
         support). Marketing never reaches this section, and the
         function refuses it anyway — the panel's gate is a courtesy,
         the server's gate is the rule.

       - it needs a student: a name and a phone a worker can ring.
         The number is normalised server-side before it is stored,
         which is what makes the one-active-plan-per-student index
         actually hold — two spellings of one number are one student.

       - every field the operator fills ends up on the ledger row,
         with their login against it, so "who opened this, and why"
         is answered by the record rather than by anyone's memory.

       - the raw link comes back ONCE. This panel shows it, offers to
         copy it, and says plainly that it cannot be shown again —
         only its hash is stored, which is the whole point.
     ------------------------------------------------------------ */

  function careCanGrant() {
    var r = currentRole();
    return r === 'admin' || r === 'support';
  }

  /* The dashboard is the only place that knows the site's own origin,
     so the link is assembled here from the path the function sent. */
  function careLinkFor(grant) {
    var path = (grant && grant.link_path) || ('/my-care?t=' + ((grant && grant.token) || ''));
    var origin = (window.location && window.location.origin) || '';
    return origin + path;
  }

  function careGrantFld(label, id, placeholder, value, hint) {
    return '<div class="edit-fld" style="flex:1 1 160px;min-width:140px">' +
      '<label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="text" id="' + id + '" placeholder="' + esc(placeholder || '') + '" value="' + esc(value || '') + '">' +
      (hint ? '<span class="sub">' + esc(hint) + '</span>' : '') +
      '</div>';
  }

  function careGrantNote(msg) {
    var el = $('careGrantNote');
    if (el) el.textContent = msg || '';
  }

  function careGrantBlockHtml() {
    if (!careCanGrant()) return '';
    var g = state.careGrant;

    if (!g) {
      return '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px">' +
        '<button type="button" class="btn-inline" data-care="grant-open">Open a Care plan</button>' +
        '<span class="sub">One session for one student: ' + esc(CALL_OUTS_INCLUDED) + ' call-outs and the ' +
        'published ' + esc(ngn(SESSION_FEE_NGN)) + '. The ledger records who opened it and why.</span></div>';
    }

    if (g.done) {
      var link = careLinkFor(g.done);
      var first = String(g.done.student_name || 'the student').split(' ')[0];
      var wa = waLink(g.done.phone,
        'Hi ' + first + '! Your Arzuz Care for ' + g.done.session + ' is set up — ' + g.done.credits +
        ' call-outs, ' + g.done.amount_ngn + ' naira paid. Your own page is here (keep the link to yourself — ' +
        'it is the key to your Care): ' + link);
      return '<div class="care-drawer" style="margin-bottom:14px">' +
        '<div class="edit-fld"><label>Plan opened — send this link to ' + esc(g.done.student_name) + '</label>' +
        '<input type="text" id="careGrantLink" readonly value="' + esc(link) + '">' +
        '<span class="sub">Shown once, and it cannot be shown again: only its hash is stored, which is exactly ' +
        'why a stolen database is not a stolen Care account. ' + esc(g.done.credits) + ' call-outs are on the ' +
        'ledger for ' + esc(g.done.session) + '.</span></div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">' +
        '<button type="button" class="btn-inline" data-care="grant-copy">Copy the link</button>' +
        (wa ? '<a class="wa-btn" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp it</a>' : '') +
        '<button type="button" class="btn-inline" data-care="grant-done">Done</button>' +
        '<span class="sub" id="careGrantNote">Next step: record a call-out from that student\u2019s row when a ' +
        'worker has been.</span></div></div>';
    }

    return '<div class="care-drawer" style="margin-bottom:14px">' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        careGrantFld('Student\u2019s name', 'careGrantName', 'e.g. Ada Okonkwo', g.name) +
        careGrantFld('Phone (a worker will ring it)', 'careGrantPhone', '0803 111 2233', g.phone) +
        careGrantFld('Area / property (optional)', 'careGrantArea', 'e.g. Malete · Sunrise Lodge', g.area) +
        careGrantFld('Room (optional)', 'careGrantRoom', 'e.g. A1', g.room) +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
        careGrantFld('Session', 'careGrantSession', '2026/2027', g.session) +
        careGrantFld('Call-outs', 'careGrantCredits', String(CALL_OUTS_INCLUDED), g.credits,
          'One credit is one call-out') +
        careGrantFld('Fee (\u20a6 paid)', 'careGrantAmount', String(SESSION_FEE_NGN), g.amount,
          'Default is the published fee') +
      '</div>' +
      '<div class="edit-fld" style="margin-top:10px">' +
        '<label for="careGrantReason">Why this plan exists — it goes on the ledger</label>' +
        '<input type="text" id="careGrantReason" placeholder="e.g. inspection was wrong — Care is free this session (terms \u00a77)" value="' + esc(g.reason) + '">' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
        '<button type="button" class="btn-inline" id="careGrantSubmit" data-care="grant-submit">Open it — ' +
        esc(g.credits || CALL_OUTS_INCLUDED) + ' credits</button>' +
        '<button type="button" class="btn-inline" data-care="grant-cancel">Cancel</button>' +
        '<span class="sub" id="careGrantNote">The fee is recorded, not charged here — take the payment the ' +
        'way it arrives, then open the plan.</span>' +
      '</div></div>';
  }

  function careGrantOpen() {
    state.careGrant = {
      name: '', phone: '', area: '', room: '',
      session: (cfg && cfg.SESSION) || '2026/2027',
      credits: String(CALL_OUTS_INCLUDED),
      amount: String(SESSION_FEE_NGN),
      reason: ''
    };
    renderCarePanel();
    var n = $('careGrantName');
    if (n) n.focus();
  }

  function careGrantClose() {
    state.careGrant = null;
    renderCarePanel();
  }

  function careGrantRead() {
    var val = function (id) { var el = $(id); return el ? String(el.value || '').trim() : ''; };
    var g = state.careGrant || {};
    g.name = val('careGrantName');
    g.phone = val('careGrantPhone');
    g.area = val('careGrantArea');
    g.room = val('careGrantRoom');
    g.session = val('careGrantSession') || g.session;
    g.credits = val('careGrantCredits') || g.credits;
    g.amount = val('careGrantAmount') || g.amount;
    g.reason = val('careGrantReason');
    state.careGrant = g;
    return g;
  }

  function careGrantSubmit() {
    var g = careGrantRead();
    /* The server checks all of this again — this is only so the person
       typing is told before a round trip. */
    if (String(g.name).length < 2) {
      careGrantNote('A plan needs a student: type their name.');
      return;
    }
    if (String(g.phone).replace(/[^0-9]/g, '').length < 10) {
      careGrantNote('A plan needs a number a worker can ring — 0803 111 2233 or +2348031112233.');
      return;
    }
    var credits = Number(String(g.credits).replace(/[^0-9]/g, '')) || CALL_OUTS_INCLUDED;
    var amount = Number(String(g.amount).replace(/[^0-9]/g, '')) || SESSION_FEE_NGN;
    var payload = {
      action: 'grant',
      payload: { name: g.name, phone: g.phone },
      session: g.session,
      credits: credits,
      amount_ngn: amount,
      source: 'admin.html'
    };
    if (g.area) payload.payload.area = g.area;
    if (g.room) payload.payload.room = g.room;
    if (g.reason) payload.reason = g.reason;

    var btn = $('careGrantSubmit');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }

    carePost(payload).then(function (body) {
      state.careGrant = { done: body };
      renderCarePanel();
      if (ArzuzSubmit && ArzuzSubmit.showToast) {
        ArzuzSubmit.showToast('Plan opened — ' + body.credits + ' call-outs for ' +
          (body.student_name || 'the student') + '. Send them the link.', 'success');
      }
      return careRefresh();
    }).catch(function (err) {
      /* The refusal stays in the drawer, beside the fields it is
         about — a duplicate plan is a fact about this student. */
      careGrantNote(err.message);
      var b = $('careGrantSubmit');
      if (b) { b.disabled = false; b.textContent = 'Open it — ' + credits + ' credits'; }
    });
  }

  function careGrantCopy() {
    var el = $('careGrantLink');
    if (!el) return;
    var ok = function () {
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Link copied.', 'success');
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(el.value).then(ok, function () { el.select(); });
    } else if (el.select) {
      el.select();
    }
  }

  function renderCarePanel() {
    var metricEl = $('careMetric'), panel = $('carePanel');
    if (!metricEl || !panel) return;

    var plans = carePlans();
    var active = plans.filter(function (p) { return p.status === 'active'; });
    var left = active.reduce(function (n, p) { return n + (Number(p.balance) || 0); }, 0);
    var used = plans.reduce(function (n, p) { return n + (Number(p.call_outs) || 0); }, 0);

    metricEl.innerHTML =
      '<h3 style="margin:0 0 10px;font-size:15px">' + ico('tag', 16) + ' Arzuz Care — credit balance</h3>' +
      '<p class="sub">One credit is one call-out, and a ₦20,000 session is four of them. The balance below is the ' +
      'sum of an append-only ledger: nothing here can edit a credit out of existence, and every button posts to the ' +
      'server that writes it.</p>' +
      '<div class="details-kv-grid">' +
        kv('Call-outs left', '<b>' + left + '</b>') +
        kv('Call-outs used', String(used)) +
        kv('Active plans', active.length + ' of ' + plans.length) +
      '</div>';

    var html = '<h3 style="margin:26px 0 10px;font-size:15px">' + ico('users', 16) + ' Care plans</h3>';
    html += careGrantBlockHtml();

    if (!plans.length) {
      html += '<div class="ops-row"><span class="ic">' + ico('alert', 15) + '</span><span class="tx">' +
        '<b>No Care plans yet</b><span>A plan appears here as soon as one is opened: use ' +
        (careCanGrant() ? 'Open a Care plan above' : 'the button the admin login has') +
        '. Every plan is created by netlify/functions/care-credit.js, which is the only writer of the ledger. ' +
        'If supabase-care.sql has not been run in Supabase, the tables do not exist until you do \u2014 think ' +
        'twice before creating them: the apply is additive and safe, but it is a schema change.</span>' +
        '</span></div>';
      panel.innerHTML = html;
      return;
    }

    plans.forEach(function (p) { html += careRowHtml(p); });

    html += '<p class="sub">Refunding returns what is left of the fee and is only offered before a session has used ' +
      'a call-out — that is the promise care.html makes. Ending a session voids whatever is unused, which is how ' +
      'credits expire: they belong to one session and nothing rolls over.</p>';

    panel.innerHTML = html;
  }

  /* One POST, then a re-read: the balance shown is always the one the
     database just computed, never a number this file did arithmetic
     on. */
  function carePost(payload) {
    return ArzuzAuth.headers().then(function (h) {
      return fetch('/api/care-credit', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: JSON.stringify(payload),
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        /* Only a 401 is a dead session. A 409 is the ledger refusing
           the change, which is information, not a logout. */
        if (r.status === 401) {
          onAuthError(Object.assign(new Error('Care refused'), { status: 401 }));
          throw apiErr(r, body);
        }
        if (!r.ok) throw apiErr(r, body);
        return body;
      });
    });
  }

  function careRefresh() {
    return ArzuzAuth.headers().then(fetchCare).then(function (care) {
      state.care = care;
      renderCarePanel();
    }).catch(function () { /* the panel keeps the last good read */ });
  }

  function careNote(msg) {
    var el = $('careDrawerNote');
    if (el) el.textContent = msg;
  }

  function careAct(act, planId) {
    var payload = { action: act, plan_id: planId };
    if (act === 'spend') {
      var workerEl = $('careWorker'), partsEl = $('careParts'), reasonEl = $('careReason');
      var worker = workerEl ? workerEl.value.trim() : '';
      var partsRaw = partsEl ? partsEl.value.trim() : '';
      var reason = reasonEl ? reasonEl.value.trim() : '';
      if (!worker) { careNote('Say who did the work — a credit with no name against it cannot be explained later.'); return; }
      var parts = partsRaw === '' ? 0 : Number(partsRaw.replace(/[^0-9]/g, ''));
      if (!isFinite(parts)) { careNote('Parts must be a number. Use 0 if there were none.'); return; }
      payload.worker = worker;
      payload.parts_ngn = parts;
      if (reason) payload.reason = reason;
    }

    carePost(payload).then(function (body) {
      state.careSpend = null;
      var says = act === 'spend' ? 'Call-out recorded — ' + body.balance + ' left'
        : act === 'refund' ? 'Refunded — ' + (body.voided || 0) + ' credits voided'
        : 'Session ended — ' + (body.voided || 0) + ' credits voided';
      if (body.parts_over_ceiling) says += '. Parts are over the included ceiling — quote the student.';
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(says, 'success');
      return careRefresh();
    }).catch(function (err) {
      /* Shown in the drawer, where the person is looking, and left there
         until they do something about it. */
      if (state.careSpend) careNote(err.message);
      else if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(esc(err.message), 'error');
    });
  }

  /* The three things a button can do, as named functions rather than as
     branches inside one delegated handler — because the boot harness
     cannot dispatch a document-level event (a real browser can, and the
     delegation below is how the buttons reach these). Exposing them
     means the test drives the SAME function the click would, instead of
     a second copy that could drift. */
  function careOpenSpend(planId) {
    state.careSpend = { plan: planId, worker: '', parts: '', reason: '' };
    renderCarePanel();
    var w = $('careWorker');
    if (w) w.focus();
  }

  function careCloseSpend() {
    state.careSpend = null;
    renderCarePanel();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-care]') : null;
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-care');
    var plan = b.getAttribute('data-plan');
    if (act === 'spend-open') return careOpenSpend(plan);
    if (act === 'spend-cancel') return careCloseSpend();
    if (act === 'grant-open') return careGrantOpen();
    if (act === 'grant-cancel' || act === 'grant-done') return careGrantClose();
    if (act === 'grant-submit') return careGrantSubmit();
    if (act === 'grant-copy') return careGrantCopy();
    if (act === 'spend-confirm' || act === 'refund' || act === 'expire') {
      careAct(act === 'spend-confirm' ? 'spend' : act, plan);
    }
  });

  window.arzuzCareRender = renderCarePanel;
  window.arzuzCareFrame = function (plans) { state.care = { plans: plans }; renderCarePanel(); };
  window.arzuzCareOpenSpend = careOpenSpend;
  window.arzuzCareAct = careAct;
  window.arzuzCareState = function () { return state.careSpend; };
  /* The grant drawer, exposed for the same reason careAct is: the boot
     harness cannot dispatch a document-level event, so it must drive
     the SAME function a click would rather than a copy of it. */
  window.arzuzCareGrant = {
    open: careGrantOpen,
    close: careGrantClose,
    submit: careGrantSubmit,
    copy: careGrantCopy,
    can: careCanGrant,
    state: function () { return state.careGrant; }
  };

  /* ================= 4e. The student dossier =================
     One student, everything the database holds about them: the answers
     they gave, every decision in either direction, their matches, and
     their whole consent trail.

     It exists because the feed above cannot answer a phone call on its
     own. "Did you show my number to anyone?" is a question about ONE
     student, and answering it by scrolling a 40-line feed for their name
     is how a team gets a dispute wrong — the feed is also capped, so an
     older event may not be on screen at all.

     The two reads below are therefore asked for by id, not read out of
     the panel's state, and the trail is NOT capped the way the feed is.
     Neither query is filtered by env: the trail is an audit log, and a
     student who arrived in a test run still has a history.

     Read-only, like everything else in this section. There is nothing
     here that can change a decision. */

  var dossierToken = 0;   /* a later click must beat an earlier slow fetch */

  /* id → name, from everything already loaded. The pool alone is not
     enough: a matched student has left the open pool, so the pairs and
     the feed are the only places their name still appears. */
  function dossierNames() {
    var map = {};
    (state.roommatePool.profiles || []).forEach(function (p) {
      map[p.id] = pick(p, 'first_name', ['name']) || 'Student';
    });
    (state.roommatePool.pairs || []).forEach(function (m) {
      map[m.a_id] = m.a_name; map[m.b_id] = m.b_name;
    });
    (state.roommatePool.trail || []).forEach(function (e) {
      if (e.actor_ref && e.actor_name) map[e.actor_ref] = e.actor_name;
      if (e.subject_ref && e.subject_name) map[e.subject_ref] = e.subject_name;
    });
    return map;
  }

  /* The questionnaire is rendered from the SHARED vocabulary
     (assets/roommate-score.js) rather than a list typed out here: the
     question labels are the ones the student actually saw, and a
     question added to the form shows up in the dossier for free. */
  function answersGrid(payload, group) {
    var A = window.ArzuzMatch;
    if (!A) return '<p class="sub">Questionnaire vocabulary not loaded.</p>';
    var defs = group === 'wants' ? A.WANTS : A.PROFILE;
    var html = '';
    Object.keys(defs).forEach(function (k) {
      var def = defs[k];
      var v = payload[k];
      if (v === undefined || v === null || v === '') return;
      if (def.kind === 'multi') {
        var list = A.list(v);
        if (!list.length) return;
        html += kv(def.short || def.label, esc(list.join(', ')));
        return;
      }
      html += kv(def.short || def.label, esc(k === 'budget' ? ngn(v) : v));
    });
    return html ? '<div class="details-kv-grid">' + html + '</div>' : '<p class="sub">Nothing answered.</p>';
  }

  function decisionRow(who, verb, whom, when, decision) {
    return '<div class="mate-cand"><div><b>' + esc(who) + ' ' + verb + ' ' + esc(whom) + '</b>' +
      '<span>' + esc(fmtDate(when)) + '</span></div>' +
      '<span class="tag-status ' + (decision === 'accept' ? 'tag-open' : 'tag-cancelled') + '">' +
      esc(decision) + '</span></div>';
  }

  function dossierSection(title, body, sub) {
    return '<h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.7">' +
      esc(title) + '</h4>' + (sub ? '<p class="sub">' + sub + '</p>' : '') + body;
  }

  var NOTE_ROW = function (msg) {
    return '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx">' +
      '<span>' + msg + '</span></span></div>';
  };

  function dossierHtml(profile, interests, events) {
    var p = profile.payload || {};
    var id = profile.id;
    var name = pick(profile, 'first_name', ['name']) || 'Student';
    var names = dossierNames();
    var phone = pick(profile, 'phone', ['phone']);
    var wa = waLink(phone);

    var mine = interests.filter(function (i) { return i.from_ref === id; });
    var theirs = interests.filter(function (i) { return i.to_ref === id; });
    var pairs = (state.roommatePool.pairs || []).filter(function (m) {
      return m.a_id === id || m.b_id === id;
    });

    /* ---- who they are ---- */
    var html = '<div class="details-kv-grid">';
    html += kv('Student', '<b>' + esc(name) + '</b>');
    html += kv('Status', statusTag(profile.status));
    html += kv('WhatsApp', esc(phone || '\u2014') +
      (wa ? ' <a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">Message</a>' : ''));
    html += kv('Area', esc(p.area || '\u2014'));
    html += kv('Budget', p.budget ? esc(ngn(p.budget)) + ' a session' : '\u2014');
    html += kv('Answered', esc(fmtDate(profile.created_at)) + ' (' + esc(ageLabel(profile.created_at)) + ' ago)');
    html += kv('Session', esc(profile.session || '\u2014') + ' \u00b7 ' + esc(profile.env || 'production'));
    html += kv('Source', esc(profile.source || '\u2014'));
    html += kv('Profile ID', '<span style="font-family:var(--mono);font-size:12px">' + esc(id) + '</span>', true);
    html += '</div>';

    /* ---- the two halves of the questionnaire, in the student's words ---- */
    html += dossierSection('Part A \u2014 about them', answersGrid(p, 'profile'));
    html += dossierSection('Part B \u2014 what they asked for', answersGrid(p, 'wants'),
      'Their own deal-breakers are absolute: a pair matching one is never shown, at any percentage.');

    /* ---- every decision, both directions ---- */
    var rows = '';
    mine.forEach(function (i) {
      rows += decisionRow(name, i.decision === 'accept' ? 'said yes to' : 'passed on',
        names[i.to_ref] || 'another student', i.created_at, i.decision);
    });
    theirs.forEach(function (i) {
      rows += decisionRow(names[i.from_ref] || 'Another student',
        i.decision === 'accept' ? 'said yes to' : 'passed on', name, i.created_at, i.decision);
    });
    html += dossierSection('Decisions (' + interests.length + ')',
      rows ? '<div style="display:flex;flex-direction:column;gap:8px">' + rows + '</div>'
           : NOTE_ROW('No decisions yet \u2014 this student has neither accepted nor passed on anyone.'),
      'Both directions are listed separately, because that is what a double opt-in is.');

    /* ---- who they are matched with ---- */
    var matchRows = '';
    pairs.forEach(function (m) {
      var otherIsA = m.a_id !== id;
      var otherName = otherIsA ? m.a_name : m.b_name;
      matchRows += '<div class="mate-cand"><div><b>Matched with ' + esc(otherName || 'a student') + '</b>' +
        '<span>both said yes \u00b7 ' + esc(fmtDate(m.matched_at)) + ' \u00b7 contact details unlocked for both</span></div>' +
        '<button type="button" class="btn-inline" data-act="dossier" data-id="' + esc(otherIsA ? m.a_id : m.b_id) + '">' +
        'Dossier \u2192 ' + esc(otherName || 'student') + '</button></div>';
    });
    html += dossierSection('Matched (' + pairs.length + ')',
      matchRows ? '<div style="display:flex;flex-direction:column;gap:8px">' + matchRows + '</div>'
                : NOTE_ROW('Not matched with anyone yet.'));

    /* ---- their whole consent trail ---- */
    html += dossierSection('Consent trail (' + events.length + ')',
      events.length ? '<div style="display:flex;flex-direction:column;gap:8px">' + events.map(consentLineHtml).join('') + '</div>'
                    : NOTE_ROW('No events on record for this student.'),
      'Append-only, and unfiltered \u2014 unlike the feed above, this is every event they are named in.');

    return html;
  }

  window.openDossier = function (id) {
    var profile = (state.roommatePool.profiles || []).find(function (r) { return r.id === id; });
    if (!profile) return;
    var token = ++dossierToken;

    $('dossierTitle').textContent = pick(profile, 'first_name', ['name']) || 'Student Dossier';
    $('dossierContent').innerHTML = '<p class="sub">Loading this student\u2019s decisions and consent trail\u2026</p>';
    show($('dossierModal'));

    ArzuzAuth.headers().then(function (h) {
      function get(path) {
        return fetch(apiRoot() + '/rest/v1/' + path, { headers: h })
          .then(function (r) { return r.ok ? r.json() : []; })
          .catch(function () { return []; });
      }
      /* or= is the only way to ask "either side" in one request. */
      var key = '(from_ref.eq.' + id + ',to_ref.eq.' + id + ')';
      var keyEv = '(actor_ref.eq.' + id + ',subject_ref.eq.' + id + ')';
      return Promise.all([
        get('roommate_interests?select=*&or=' + key + '&order=created_at.desc&limit=200'),
        get('roommate_events?select=*&or=' + keyEv + '&order=created_at.desc&limit=200')
      ]);
    }).then(function (out) {
      if (token !== dossierToken) return;   /* an older click, overtaken */
      /* Kept so the export below writes the SAME record that is on
         screen, down to the same two reads. The token guard above is
         what keeps it honest: a slow earlier fetch cannot replace this
         with another student's history. */
      state.dossier = { profile: profile, interests: out[0] || [], events: out[1] || [] };
      $('dossierContent').innerHTML = dossierHtml(profile, state.dossier.interests, state.dossier.events);
    }).catch(function (err) {
      if (token !== dossierToken) return;
      state.dossier = null;
      $('dossierContent').innerHTML = '<p class="sub">Could not load this dossier: ' + esc(err && err.message) + '</p>';
    });
  };

  /* ================= 4f. The dossier as a file =================
     The print sheet answers "read me this over the phone". This answers
     the other half: hand the record to someone who is not standing at
     the dashboard.

     JSON rather than CSV, and deliberately: CSV cannot hold the two
     halves of the questionnaire without flattening them into columns
     that mean nothing, and an archive that loses which question an
     answer belonged to is not an archive. The envelope also carries who
     it is about, when it was exported and the append-only note, so the
     file explains itself to whoever opens it years from now.

     What it does NOT contain is as deliberate. It is built from the same
     profile / interests / events the screen rendered — not from panel
     state — so another student's payload, or a student who merely
     appears in the feed above, cannot reach it. */
  function dossierSlug(name) {
    return String(name || 'student').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'student';
  }

  function dossierExport(profile, interests, events, now) {
    var p = profile.payload || {};
    var id = profile.id;
    var name = pick(profile, 'first_name', ['name']) || 'Student';
    var names = dossierNames();
    var at = now || new Date();

    var doc = {
      record: 'arzuz roommate consent record',
      format: 1,
      exported_at: at.toISOString(),
      note: 'Append-only. The database grants no login INSERT, UPDATE or DELETE on the consent trail, ' +
        'so nothing in this file can be changed or removed after the fact — and the names below are the ' +
        'ones stored at the time, which is why they survive a deleted profile.',
      student: {
        id: id,
        name: name,
        phone: pick(profile, 'phone', ['phone']) || null,
        area: p.area || null,
        budget: p.budget || null,
        status: profile.status || null,
        session: profile.session || null,
        env: profile.env || null,
        source: profile.source || null,
        answered_at: profile.created_at || null,
        answers: p,
        dealbreakers: toList(p.dealbreakers)
      },
      /* Both directions as separate rows, because that is what a double
         opt-in is — and the other student's name is the snapshot from
         the record, not a fresh lookup that a deleted profile would
         break. */
      decisions: (interests || []).map(function (i) {
        var mine = i.from_ref === id;
        return {
          from: mine ? name : (names[i.from_ref] || 'another student'),
          from_id: i.from_ref,
          to: mine ? (names[i.to_ref] || 'another student') : name,
          to_id: i.to_ref,
          decision: i.decision,
          at: i.created_at
        };
      }),
      matches: ((state.roommatePool || {}).pairs || []).filter(function (m) {
        return m.a_id === id || m.b_id === id;
      }).map(function (m) {
        var otherIsA = m.a_id !== id;
        return {
          with_id: otherIsA ? m.a_id : m.b_id,
          with_name: otherIsA ? m.a_name : m.b_name,
          matched_at: m.matched_at
        };
      }),
      events: (events || []).map(function (e) {
        return {
          id: e.id,
          event: e.event,
          at: e.created_at,
          actor_id: e.actor_ref,
          actor_name: e.actor_name,
          subject_id: e.subject_ref,
          subject_name: e.subject_name,
          env: e.env,
          session: e.session
        };
      })
    };

    return {
      filename: 'arzuz-consent-' + dossierSlug(name) + '-' + at.toISOString().slice(0, 10) + '.json',
      text: JSON.stringify(doc, null, 2)
    };
  }

  /* Exposed because the boot harness builds the file through the very
     function the button calls — a second copy in the test would be
     testing the test. */
  window.arzuzDossierExport = dossierExport;

  $('btnExportDossier').addEventListener('click', function () {
    var d = state.dossier;
    if (!d) return;
    var out = dossierExport(d.profile, d.interests, d.events, new Date());
    var blob = new Blob([out.text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = out.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (ArzuzSubmit && ArzuzSubmit.showToast) {
      ArzuzSubmit.showToast('Consent record exported as ' + out.filename, 'success');
    }
  });

  /* ================= 4g. Why matches stall =================
     The panel says who is waiting. It does not say WHY nobody has been
     matched with them, and the two honest answers are different:
     the pool has nobody suitable, or the students have not chosen each
     other. Only the first one is the team's problem.

     "Nobody suitable" is computed with the SHARED scorer
     (window.ArzuzMatch.eligible — the same call the server makes before
     it shows a card), so this cannot drift from what the engine
     actually does: a student named here is one the engine would not put
     in front of anyone either. */
  var COHORT_WAIT_MAX = 40;   /* pairwise cost, and say so when it bites */

  function medianDays(deltas) {
    if (!deltas.length) return null;
    var s = deltas.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    var v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    return Math.round(v * 10) / 10;
  }

  function daysBetween(fromIso, toIso) {
    var a = Date.parse(fromIso), b = Date.parse(toIso);
    if (!isFinite(a) || !isFinite(b) || b < a) return null;
    return (b - a) / 864e5;
  }

  /* Coarse groups for the roommate cohort table. The floor follows the
     public bands (assets/data.js): Malete totals under ₦150,000 a
     session barely exist, so they share one bucket instead of three. */
  function budgetBandOf(row) {
    var n = Number(pick(row, 'budget_ngn', ['budget']));
    if (!isFinite(n) || n <= 0) return null;
    if (n < 150000) return 'under \u20a6150k';
    if (n < 300000) return '\u20a6150\u2013300k';
    return '\u20a6300k+';
  }

  /* One row per group: how many are in it, how many matched, and how
     long the matched ones waited. The median rather than the mean
     because one student who answered in October and matched in January
     should not move the headline. */
  function cohortRows(profiles, pairs, keyOf) {
    var matchedAt = {};
    (pairs || []).forEach(function (m) {
      [m.a_id, m.b_id].forEach(function (pid) {
        if (!pid) return;
        if (!matchedAt[pid] || String(m.matched_at) < String(matchedAt[pid])) matchedAt[pid] = m.matched_at;
      });
    });

    var groups = {};
    profiles.forEach(function (r) {
      var key = keyOf(r);
      if (key === null || key === undefined || key === '') return;
      if (!groups[key]) groups[key] = { label: key, total: 0, matched: 0, deltas: [] };
      var g = groups[key];
      g.total += 1;
      if (matchedAt[r.id]) {
        g.matched += 1;
        var d = daysBetween(r.created_at, matchedAt[r.id]);
        if (d !== null) g.deltas.push(d);
      }
    });

    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.rate = g.total ? Math.round((g.matched / g.total) * 100) : 0;
      g.median_days = medianDays(g.deltas);
      return g;
    }).sort(function (a, b) { return (b.total - a.total) || a.label.localeCompare(b.label); });
  }

  function cohortLineHtml(g) {
    return '<div class="mate-cand"><div>' +
      '<b>' + esc(g.label) + '</b>' +
      '<span>' + g.total + (g.total === 1 ? ' student' : ' students') + ' \u00b7 ' +
      g.matched + ' matched \u00b7 ' + g.rate + '%' +
      (g.median_days !== null ? ' \u00b7 typically ' + g.median_days + ' ' + (g.median_days === 1 ? 'day' : 'days') + ' to match' : '') +
      '</span></div></div>';
  }

  /* Why one waiting student has nobody: the engine's own verdict, counted
     by reason so the line says which wall they hit rather than just how
     tall it is. */
  function noPartnerReason(A, me, others) {
    var counts = { gender: 0, dealbreaker: 0, thin: 0 };
    others.forEach(function (x) {
      var r = A.score(me.payload || {}, x.payload || {});
      if (r.pass && !r.dealbreaker) return;
      if (r.dealbreaker) counts.dealbreaker += 1;
      else if (/gender/i.test(String(r.reason || ''))) counts.gender += 1;
      else counts.thin += 1;
    });
    var bits = [];
    if (counts.gender) bits.push(counts.gender + ' by gender');
    if (counts.dealbreaker) bits.push(counts.dealbreaker + (counts.dealbreaker === 1 ? ' by a deal-breaker' : ' by deal-breakers'));
    if (counts.thin) bits.push(counts.thin + ' with too little in common to call');
    return {
      total: others.length,
      bits: bits,
      /* The biggest wall first — it is usually the gender rule or one
         deal-breaker, and naming it is the whole point of the block. */
      dominant: counts.gender >= counts.dealbreaker && counts.gender >= counts.thin ? 'gender'
        : (counts.dealbreaker >= counts.thin ? 'dealbreaker' : 'thin')
    };
  }

  function stallHtml() {
    var A = window.ArzuzMatch;
    var pool = state.roommatePool || {};
    var profiles = (pool.profiles || []).filter(function (r) { return !isTestRow(r); });
    var waiting = profiles.filter(function (r) { return str(r.status).toLowerCase() === 'open'; });
    var html = '<h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.7">' +
      'Why they are still waiting</h4>';

    if (!A) {
      return html + '<p class="sub">The matching vocabulary is not loaded, so this cannot be worked out.</p>';
    }
    if (!waiting.length) {
      return html + NOTE_ROW('Nobody is waiting, so there is nothing to explain.');
    }

    /* The two cohorts the plan actually asks about, plus the wall. */
    var byArea = cohortRows(profiles, pool.pairs, function (r) { return pick(r, 'area', ['area']) || 'No area given'; });
    var byBudget = cohortRows(profiles, pool.pairs, budgetBandOf);

    html += '<p class="sub">Every row below is computed from the ' + profiles.length +
      ' profiles this panel loaded — the same rows the pool above is built from, and the pool read is ' +
      'capped, so read it as a picture of the pool rather than an audit of it.</p>';

    html += '<div class="mate-meta" style="margin-bottom:4px"><span>By area</span></div>';
    html += byArea.map(cohortLineHtml).join('');
    html += '<div class="mate-meta" style="margin:10px 0 4px"><span>By budget</span></div>';
    html += byBudget.length ? byBudget.map(cohortLineHtml).join('')
      : NOTE_ROW('No waiting student has given a budget.');

    /* --- the wall --- */
    var considered = waiting.slice(0, COHORT_WAIT_MAX);
    var queue = [];
    considered.forEach(function (me) {
      var others = waiting.filter(function (x) { return x.id !== me.id; });
      var compatible = 0;
      others.forEach(function (x) { if (A.eligible(me.payload || {}, x.payload || {})) compatible += 1; });
      if (compatible === 0) queue.push({ row: me, why: noPartnerReason(A, me, others) });
    });

    html += '<div class="mate-meta" style="margin:12px 0 4px"><span>Nobody suitable in the pool (' + queue.length + ')</span></div>';
    if (!queue.length) {
      html += NOTE_ROW('Every waiting student has at least one compatible partner in the pool — what is left is their own decision, not the pool.');
    } else {
      queue.forEach(function (q) {
        html += '<div class="mate-cand"><div>' +
          '<b>' + esc(pick(q.row, 'first_name', ['name']) || 'Student') + '</b>' +
          '<span>' + (q.why.total ? 'all ' + q.why.total + ' other waiting ' + (q.why.total === 1 ? 'student is' : 'students are') + ' filtered out' : 'the only student waiting') +
          (q.why.bits.length ? ' — ' + esc(q.why.bits.join(', ')) : '') + '</span></div>' +
          '<button type="button" class="btn-inline" data-act="dossier" data-id="' + esc(q.row.id) + '">' + ico('users', 13) + ' Dossier</button>' +
          '</div>';
      });
      html += '<p class="sub">None of these is a bug to fix: the gender rule and a ticked deal-breaker are ' +
        'students\u2019 own choices. The reason to show it is that a thin pool and a student who cannot be ' +
        'matched are different problems, and only one of them is solved by finding more rooms.</p>';
    }

    if (waiting.length > COHORT_WAIT_MAX) {
      html += '<p class="sub">Only the first ' + COHORT_WAIT_MAX + ' waiting students were checked one against ' +
        'another (' + waiting.length + ' are waiting) — past that the check is slower than the page it is on.</p>';
    }
    return html;
  }

  /* ================= 4h. Previewing the daily digest =================
     netlify/functions/roommate-digest.js sends one message at 06:00 and
     nobody can watch that happen. This asks the server to compose the
     very same message — same function, not a copy — and shows it.

     Shown as TEXT, tags and all, rather than as rendered HTML. The text
     is Telegram's HTML dialect with student-typed values escaped
     server-side; rendering it here would put that escaping between us
     and innerHTML for the sake of bold text nobody needs in a preview,
     and "exactly what the message contains" is the more useful thing to
     read anyway. */
  window.openDigestPreview = function () {
    var box = $('digestPreviewText'), note = $('digestPreviewNote');
    if (!box) return;
    box.textContent = 'Composing\u2026';
    if (note) note.textContent = 'Reading the same tables the 06:00 job reads. Nothing is sent.';
    show($('digestModal'));

    ArzuzAuth.headers().then(function (h) {
      h['Content-Type'] = 'application/json';
      /* Root-relative, like /api/team and /strategy-docs: Netlify functions
         live on this site's origin, not on the Supabase project. */
      return fetch('/api/roommate-digest-preview', { method: 'POST', headers: h, body: '{}' });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        /* 401 is a dead session and the dashboard signs out for it \u2014 one
           convention, one handler. 403 is NOT: the session is fine and the
           role simply may not read this. Passing a 403 to onAuthError would
           log a signed-in colleague out because they opened the wrong
           screen, so it is shown here and nothing else. (The REST reads in
           fetchData can treat both alike because PostgREST answers 403 only
           for a missing grant, which IS a broken login \u2014 a difference
           worth keeping straight.) */
        if (r.status === 401) {
          onAuthError(Object.assign(new Error('Digest preview refused'), { status: r.status }));
          throw apiErr(r, body);
        }
        if (!r.ok) throw apiErr(r, body);
        return body;
      });
    }).then(function (body) {
      box.textContent = body.text;
      if (!note) return;
      var c = body.counts || {};
      note.textContent = (body.would_send
        ? 'The 06:00 job would send this now.'
        : 'Nothing needs attention \u2014 the 06:00 job would stay silent. This is what it WOULD say if it did not.') +
        ' Window: last ' + body.window_hours + ' hours \u00b7 ' + body.quiet_pairs + ' stalled ' +
        (body.quiet_pairs === 1 ? 'match' : 'matches') + ' \u00b7 ' + (c.created || 0) + ' questionnaires, ' +
        (c.matched || 0) + ' matches \u00b7 your role: ' + (body.role || '\u2014') + '.';
    }).catch(function (err) {
      /* The note said "reading the tables" a moment ago; leaving it there
         while the box says the read failed is a contradiction on screen. */
      if (note) note.textContent = 'The digest could not be composed. Nothing was sent.';
      box.textContent = 'Could not compose the digest: ' + (err && err.message);
    });
  };

  $('btnCloseDigest').addEventListener('click', function () { hide($('digestModal')); });

  /* The trigger lives in the panel HTML, so it is wired by delegation —
     the same reason every dossier button is. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('#btnDigestPreview') : null;
    if (b) openDigestPreview();
  });

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
        if (!r.ok) throw apiErr(r);
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

  /* ================= 4b. The waitlist pipeline =================

     `follow_up_status` is a DIFFERENT column from `status` on purpose.
     status is the record's state, and every view, filter, report and
     growth feed in this dashboard is keyed on it (open / matched /
     active / expired). The pipeline is where a PERSON has got to with
     the PERSON: new, contacted, interested, matched, closed. Merging
     them would have meant rewriting every one of those readers on the
     week of launch; supabase-waitlist-launch.sql reconciles the two in
     its backfill and enforces these five words with a CHECK constraint,
     so a value that is not here is refused by Postgres rather than
     quietly becoming a sixth stage nobody queries for. */
  var PIPELINE_STAGES = ['new', 'contacted', 'interested', 'matched', 'closed'];
  var PIPELINE_TABLES = ['demand_records', 'listings'];

  function pipelineOf(r) {
    var s = str(r.follow_up_status).toLowerCase();
    return PIPELINE_STAGES.indexOf(s) !== -1 ? s : 'new';
  }

  function pipelineTagHtml(r) {
    var s = pipelineOf(r);
    var who = str(r.assigned_to);
    return '<span class="pipeline-tag pipeline-' + s + '" title="' +
      esc(who ? 'Assigned to ' + who : 'Nobody has claimed this one yet') + '">' +
      esc(s.toUpperCase()) + (who ? ' \u00b7 ' + esc(who.split('@')[0]) : '') + '</span>';
  }

  /* THE CONTROL IS OFFERED ONLY WHERE THE DATABASE WILL ACCEPT THE
     WRITE. admin, support and verification may update a demand. On a
     listing only an ADMIN may write the row at all: verification's
     write is the approve below, which calls public.listing_verify() and
     moves four columns, so a stage selector on this table would be a
     select that answers 42501 — which is worse than no select, because
     it teaches whoever uses it that the dashboard lies. */
  function canWorkPipeline(table) {
    var role = currentRole();
    if (role === 'admin') return true;
    if (table === 'demand_records') return role === 'support' || role === 'verification';
    if (table === 'listings') return false;   // the RPC, or nothing — never a PATCH
    return false;
  }

  function pipelineSelectHtml(table, r) {
    if (PIPELINE_TABLES.indexOf(table) === -1 || !canWorkPipeline(table)) return '';
    var cur = pipelineOf(r);
    return '<select class="pipeline-select" data-act="pipeline" data-table="' + table +
      '" data-id="' + esc(r.id) + '" title="Move this one along the list">' +
      PIPELINE_STAGES.map(function (s) {
        return '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + s.toUpperCase() + '</option>';
      }).join('') + '</select>';
  }

  /* The reference, in the table, because it is the string the person has
     in the WhatsApp message they sent us. Looking a record up by it is
     the one lookup support will actually need. */
  function refBadgeHtml(r) {
    var ref = str(r.ref);
    return ref
      ? '<span class="ref-badge" title="Read this out to find them on WhatsApp">' + esc(ref) + '</span>'
      : '';
  }

  /* The write. Modelled on patchDraftRow below: same auth headers, same
     error handling, same refresh. `assigned_to` is the SIGNED-IN
     ACCOUNT, never a name typed into a box — "who is working this" is a
     question the audit trail answers from the token, and a text field
     answers a different one. */
  function patchWaitlistRow(table, id, patch, doneMsg) {
    ArzuzAuth.headers().then(function (h) {
      h['Prefer'] = 'return=representation';
      return fetch(apiRoot() + '/rest/v1/' + table + '?id=eq.' + id, {
        method: 'PATCH', headers: h, body: JSON.stringify(patch)
      });
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          onAuthError(new Error('Waitlist update rejected'));
          throw new Error('Your session has expired, or this login may not change a waitlist record.');
        }
        if (!r.ok) throw apiErr(r);
        return r.json();
      })
      .then(function (updated) {
        var row = findRow(table, id);
        if (row && updated && updated[0]) Object.assign(row, updated[0]);
        renderRoute();
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(doneMsg, 'success');
      })
      .catch(function (err) {
        if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(err.message, 'error');
        else alert(err.message);
      });
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
    var isVerifier = role === 'verification';
    var html = '';
    if (wa) html += '<a class="wa-btn" href="' + wa + '" target="_blank" rel="noopener">WA</a>';
    html += actBtn('view', table, r.id, ico('eye', 13) + ' View');
    /* support sees listings read-only, and so does verification — the
       officer's write is the approve below, not an edit of the row it
       decides about. Never delete for either. */
    if (!((isSupport || isVerifier) && table === 'listings')) html += actBtn('edit', table, r.id, ico('pencil', 13) + ' Edit');
    /* THE OFFICER'S ONE WRITE, and offered only where the RPC would accept
       it. Not on a draft — publishing one is the deliberate two-step, since
       the invite link dies the moment the status leaves 'draft' — and not
       on a row that is already live, because the decision has been made. */
    if (isVerifier && table === 'listings' && !boardState(r).live && str(r.status).toLowerCase() !== 'draft') {
      html += actBtn('verify', table, r.id, ico('check', 13) + ' Approve');
    }
    if (isAdmin && table === 'listings' && !boardState(r).live && str(r.status).toLowerCase() !== 'draft') {
      html += actBtn('publish', table, r.id, ico('check', 13) + ' Publish');
    }
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
      head.innerHTML = '<th>Date</th><th>Status</th><th>Pipeline</th><th>Name</th><th>Room Type</th><th>Budget</th><th>Distance</th><th>Timing</th><th>Contact</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var name = esc(pick(r, 'first_name', ['first'])) + (p.last ? ' ' + esc(p.last) : '');
        var wa = waLink(pick(r, 'phone', ['phone']));
        var isMinor = r.is_minor === true || p.age === 'Under 18';
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + '</td>' +
          '<td>' + pipelineTagHtml(r) + pipelineSelectHtml('demand_records', r) + '</td>' +
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
          '<div class="rc-tags">' + statusTag(r.status) + pipelineTagHtml(r) + (isMinor ? '<span class="no-ask-flag">minor</span>' : '') + '</div>' +
          pipelineSelectHtml('demand_records', r) +
          '<div class="rc-sub" style="margin-top:6px">Budget: ' + esc(pick(r, 'budget_band', ['budget']) || '—') + ' · ' + esc(pick(r, 'distance', ['dist']) || '—') + refBadgeHtml(r) + '</div>' +
          '<div class="rc-actions">' + rowActionsHtml(table, r) + '</div></div>';
      }).join('');

    } else if (table === 'listings') {
      /* "Browse board" sits next to Status on purpose: the two together are
         the whole answer (draft + hidden, live, pending + hidden), and the
         table is wider than its pane, so the right-hand columns are the
         ones you have to scroll to reach. */
      /* Crawl sits next to Browse board on purpose: both answer a
         visibility question about the same room — whether students can
         see it, and how often the engines come back to re-read it. */
      head.innerHTML = '<th>Date</th><th>Status</th><th>Browse board</th><th>Crawl</th><th>Apt ID</th><th>Photo</th><th>Property</th><th>Amenities</th><th>Type</th><th>Area</th><th>Opening Ask</th><th>Price</th><th>Location</th><th>Actions</th>';
      html = rows.map(function (r) {
        var p = payloadOf(r);
        var photoUrl = pick(r, 'photo_url', ['photo']);
        var aptId = p.apt_id || p.custom_id || shortId(r.id);
        var askCell = (r.opening_ask_ngn != null)
          ? '<b>' + ngn(r.opening_ask_ngn) + '</b>'
          : '<span class="no-ask-flag" title="Fill this in from your field notes">missing</span>';
        return '<tr>' +
          '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td>' + statusTag(r.status) + draftBadgeHtml(r) + pipelineTagHtml(r) + pipelineSelectHtml('listings', r) + '</td>' +
          '<td>' + boardBadgeHtml(r) + '</td>' +
          '<td>' + crawlBadgeHtml(r) + '</td>' +
          '<td><span class="apt-badge-id">' + esc(aptId) + '</span></td>' +
          '<td>' + (photoUrl
            ? '<img class="admin-photo-thumb" src="' + esc(photoUrl) + '" alt="Property" data-act="photo" data-url="' + esc(photoUrl) + '">'
            : '<span class="muted-cell">No photo</span>') + mediaCountHtml(p) + '</td>' +
          '<td><b class="cell-clamp">' + esc(pick(r, 'property_name', ['prop_name']) || '—') + '</b></td>' +
          '<td><div style="max-width:170px;display:flex;flex-wrap:wrap;gap:2px">' + amenitiesTags(p.ut || p.utilities, 3) + '</div></td>' +
          '<td>' + esc(pick(r, 'property_type', ['ty']) || '—') + '</td>' +
          '<td><span class="cell-clamp">' + esc(pick(r, 'area', ['ar']) || '—') + '</span></td>' +
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
          '<div class="rc-tags">' + statusTag(r.status) + pipelineTagHtml(r) + boardBadgeHtml(r) + crawlBadgeHtml(r) + draftBadgeHtml(r) +
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
    var colspan = { demand_records: 9, listings: 14, scout_submissions: 9, booking_requests: 8, support_tickets: 8 }[table];
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
    else if (act === 'dossier') openDossier(id);
    else if (act === 'draft-rotate') rotateDraftLink(table, id);
    else if (act === 'draft-revoke') revokeDraftLink(table, id);
    else if (act === 'draft-approve') openEditModal(table, id);   // admin sets tier + status deliberately
    else if (act === 'publish') publishToListingBoard(id);
    else if (act === 'verify') verifyListingRow(id);
    /* The shift's two moves. Same delegate as everything else: a row-
       scoped listener would have to be re-attached on every re-render,
       which is how handlers pile up on the same button. */
    else if (act === 'vtake') verifyQueueWrite('listing_take', id);
    else if (act === 'vrelease') verifyQueueWrite('listing_release', id);
    else if (act === 'vattest') verifyAttest(id);
  });

  /* The visit form's own two listeners. A change on a checkbox writes the
     tick; an input writes the sentence for that check (or the note). Both
     go through the same two functions the harness drives, so there is one
     reading of "what did you tick" and not a DOM path and a test path. */
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.dataset || t.dataset.act !== 'ev-kind') return;
    verifyEvidenceToggle(t.dataset.id, t.dataset.ev, !!t.checked);
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.act === 'ev-detail') verifyEvidenceToggle(t.dataset.id, t.dataset.ev, undefined, t.value);
  });

  /* 5d. Delegated changes — the pipeline selector.

     A `change` listener rather than a `click` one, and one listener for
     the whole document rather than one per row: the table re-renders on
     every keystroke in the search box, and a row-scoped listener would
     have to be re-attached each time (which is how handlers pile up on
     the same button). */
  document.addEventListener('change', function (e) {
    var sel = (e.target && e.target.dataset && e.target.dataset.act === 'pipeline') ? e.target : null;
    if (!sel) return;
    var table = sel.dataset.table, id = sel.dataset.id;
    var patch = { follow_up_status: sel.value };

    /* Claiming it: the moment somebody moves a row off 'new' it becomes
       theirs, unless it is already somebody's. Reassigning is the
       Settings panel's business, not a dropdown's. */
    var row = findRow(table, id);
    if (row && !str(row.assigned_to) && sel.value !== 'new') {
      patch.assigned_to = ArzuzAuth.email() || null;
    }

    patchWaitlistRow(table, id, patch, 'Moved to ' + sel.value.toUpperCase() + '.');
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
      specs += '<div class="edit-fld"><label>Property / Lodge Name <small>optional</small></label><input type="text" id="edit_prop_name" maxlength="70" value="' + esc(pick(row, 'property_name', ['prop_name'])) + '"></div>';
      specs += '<div class="edit-fld"><label>Property Type</label><select id="edit_ty">' +
        (typeof PROPERTY_TYPES !== 'undefined' ? PROPERTY_TYPES : []).map(function (t) {
          return '<option' + (pick(row, 'property_type', ['ty']) === t ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></div>';
      specs += '<div class="edit-fld"><label>Area / Street</label><input type="text" id="edit_ar" maxlength="80" value="' + esc(pick(row, 'area', ['ar'])) + '"></div>';
      specs += '<div class="edit-fld"><label>Rent Price (₦ / session)</label><input type="number" id="edit_rent" min="0" max="99999999" step="1" maxlength="8" value="' + esc(pick(row, 'listed_price_ngn', ['rent'])) + '"></div>';

      /* OPENING ASK — the thesis number. Locked once set. */
      var ask = row.opening_ask_ngn;
      specs += '<div class="edit-fld full"><label>Opening Ask (₦) <small>what the landlord asked BEFORE seeing demand data</small></label>' +
        (ask != null
          ? '<input type="number" id="edit_ask" min="0" max="99999999" step="1" maxlength="8" value="' + esc(ask) + '" disabled>' +
            '<label class="ask-unlock"><input type="checkbox" id="edit_ask_unlock">' +
            '<small>Unlock &amp; override deliberately — overwriting it destroys the only real measurement Arzuz has.</small></label>'
          : '<input type="number" id="edit_ask" min="0" max="99999999" step="1" maxlength="8" value="" placeholder="e.g. 200000">') +
        '</div>';

      /* availability — vacant count or fully occupied */
      specs += '<div class="edit-fld full"><label>Availability</label>' +
        '<div class="seg" id="editAvailSeg" role="group" aria-label="Availability">' +
          '<button type="button" class="seg-btn' + (availMode === 'vacant' ? ' on' : '') + '" data-seg="vacant" aria-pressed="' + (availMode === 'vacant' ? 'true' : 'false') + '">' + ico('check', 13) + ' Vacant units available</button>' +
          '<button type="button" class="seg-btn' + (availMode === 'occupied' ? ' on' : '') + '" data-seg="occupied" aria-pressed="' + (availMode === 'occupied' ? 'true' : 'false') + '">' + ico('x', 13) + ' Fully occupied</button>' +
        '</div>' +
        '<div id="editUnitsWrap"' + (availMode === 'occupied' ? ' style="display:none;"' : '') + '>' +
          '<input type="number" id="edit_units" min="0" max="999" step="1" maxlength="3" value="' + esc(unitsVal) + '" placeholder="How many units are vacant? e.g. 3">' +
          '<div class="fld-note" id="editUnitsNote">0 means nothing is left to let — the listing is stored as <b>fully occupied</b>.</div>' +
        '</div>' +
        '<input type="hidden" id="edit_avail" value="' + esc(availMode) + '"></div>';

      specs += '<div class="edit-fld"><label>Contact Person</label><input type="text" id="edit_nm" maxlength="60" value="' + esc((str(pick(row, 'owner_name', ['nm'])) + ' ' + str(p.last)).trim()) + '"></div>';
      specs += '<div class="edit-fld"><label>Contact Phone / WhatsApp</label><input type="tel" id="edit_ph" maxlength="24" value="' + esc(pick(row, 'owner_phone', ['ph'])) + '"></div>';
      specs += '<div class="edit-fld"><label>Contact Role</label><select id="edit_role">' + roleOptionsHtml(curRole) + '</select></div>';
      specs += '<div class="edit-fld"><label>Verification Tier</label><select id="edit_tier">' + tierOptionsHtml(row.tier) + '</select></div>';
      /* the same answer the Add modal gives: is this on the browse page? */
      specs += '<div class="edit-fld full"><div class="fld-note" id="editBoardNote" aria-live="polite"></div></div>';

      specs += '<div class="edit-fld full"><label>Amenities &amp; Utilities <small>type to search — Enter adds a new one</small></label>' +
        '<div class="tag-field" id="editAmenityField">' +
          '<span id="editAmenityChips" style="display:contents;"></span>' +
          '<input type="text" id="editAmenityInput" placeholder="e.g. solar, borehole, prepaid meter…" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="editAmenitySuggest">' +
          '<div class="tag-suggest" id="editAmenitySuggest" role="listbox" aria-label="Amenity suggestions"></div>' +
        '</div></div>';

      specs += '<div class="edit-fld full"><label>Description &amp; Features</label><textarea id="edit_desc" rows="2" maxlength="2000" placeholder="Running water, prepaid meter…">' + esc(p.desc || p.description || '') + '</textarea></div>';
      /* The public landlord form answers this as "Yes \u2014 sharing allowed"
         / "No \u2014 one tenant only" (owner-list.html); the dashboard and
         the invite link store a boolean. All three read as one consent. */
      specs += '<div class="edit-fld full"><label class="ck-line"><input type="checkbox" id="edit_split_ok"' +
        ((p.split_ok === true || p.split_ok === 'yes' || String(p.split_ok || '').indexOf('Yes') === 0) ? ' checked' : '') +
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
        '<textarea id="edit_access_notes" rows="3" maxlength="600" placeholder="e.g. Opposite the blue mosque, brown double gate with a small green door, first floor — stairs at the back.">' + esc(accessNotes) + '</textarea></div>';

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
        '<input type="url" id="edit_video_manual" maxlength="300" value="' + esc(videoUrl) + '" placeholder="…or paste a YouTube link">' +
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

      /* Status or tier changed: say whether the save will actually put
         this listing in front of students, before the save. */
      syncBoardNote('edit', row.env);
      ['edit_status', 'edit_tier'].forEach(function (id) {
        var el = $(id);
        if (el && typeof el.addEventListener === 'function') {
          el.addEventListener('change', function () { syncBoardNote('edit', row.env); });
        }
      });

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
      /* a typed 0 is "nothing left to let" — the same rule as the Add
         form, the landlord form and the payload clamp */
      var eFullyLet = (eMode === 'occupied') || (eUnitsRaw !== '' && isFinite(eUnits) && eUnits === 0);
      var eAvail = eFullyLet ? { mode: 'occupied', units: null } : { mode: 'vacant', units: (isFinite(eUnits) && eUnits > 0) ? Math.min(eUnits, MAX_UNITS) : null };
      p.avail = eAvail.mode;
      p.units = eAvail.units;
      p.rm = roomsText(eAvail);
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
        if (!r.ok) throw apiErr(r);
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

  var MAX_UNITS = 999;

  /* Zero is an answer, not an empty box.

     `parseInt('0')` used to fail a `> 0` test here, so a landlord with
     nothing left to let was stored as mode 'vacant' with a null count
     and the row read "Units available" — a fully-let lodge advertising
     rooms that do not exist, on the page students browse. Zero now
     means fully occupied, exactly as the landlord form and the SQL
     payload clamp treat it. */
  function availabilityState() {
    var mode = addSegAvail ? addSegAvail.get() : 'vacant';
    var raw = $('add_units') ? str($('add_units').value).trim() : '';
    var n = parseInt(raw, 10);
    if (raw !== '' && isFinite(n) && n === 0) return { mode: 'occupied', units: null, zero: true };
    return { mode: mode, units: (isFinite(n) && n > 0) ? Math.min(n, MAX_UNITS) : null, zero: false };
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
    syncBoardNote('add', cfg.ENV || 'production');
    if (addTabs) addTabs('specs');
    show(addModal);
  }

  $('btnOpenAddApt').addEventListener('click', openAddApt);

  /* The browse-board answer, live under the tier select. */
  ['add_status', 'add_tier'].forEach(function (id) {
    var el = $(id);
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('change', function () { syncBoardNote('add', cfg.ENV || 'production'); });
    }
  });

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
            if (!r2.ok) throw apiErr(r2);
            return r2.json();
          });
        }
        if (r.status === 401 || r.status === 403) { onAuthError(new Error('Insert rejected')); throw new Error('Your session has expired.'); }
        throw apiErr(r);
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
        else if (ArzuzSubmit && ArzuzSubmit.showToast) {
          /* A save with status active + tier 2 still misses the board when
             env is not production — and nothing said so, which is how a
             "saved" apartment never appears on /browse. Report the board
             state with the save, not after the silence. */
          var live = boardState(inserted);
          ArzuzSubmit.showToast(live.live
            ? 'Apartment ' + p.apt_id + ' saved — live on the browse page.'
            : 'Apartment ' + p.apt_id + ' saved, but hidden — ' + live.why + '.',
            live.live ? 'success' : 'error');
        }
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
    return base + 'complete-listing?ref=' + row.draft_token;
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
                  if (!r2.ok) throw apiErr(r2);
                  return r2.json();
                });
            }
            if (r.status === 401 || r.status === 403) { onAuthError(new Error('Draft update rejected')); throw new Error('Your session has expired.'); }
            throw apiErr(r);
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
        if (!r.ok) throw apiErr(r);
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
      .then(function (r) {
        if (r.ok) return r.json();
        /* The function knows WHY the upload cannot start, and its own
           sentence is the only thing an admin can act on: "Cloudinary
           environment variables not configured on server" is the one
           that kills every photo silently, and "HTTP 500" says nothing.
           Read the body and pass the reason through. */
        return r.text().then(function (body) {
          var detail = '';
          try { detail = (JSON.parse(body) || {}).error || ''; } catch (e) { detail = str(body).slice(0, 160); }
          throw apiErr(r, detail);
        });
      })
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
      .catch(function (err) {
        var msg = 'Upload failed: ' + err.message;
        if (/cloudinary environment variables|not configured|no credentials/i.test(err.message)) {
          msg += ' — set CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and CLOUDINARY_CLOUD_NAME in Netlify → Site settings → Environment variables, then redeploy.';
        }
        fail(msg);
      });
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
      if (window.console) console.warn('[Arzuz] YouTube upload unavailable, falling back to Cloudinary:', err.detail || err.message);
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
    var label = it.status === 'failed' ? 'Failed'
      : it.status === 'uploading' ? (it.pct > 0 ? it.pct + '%' : 'Uploading…')
      : it.status === 'done' ? 'Uploaded'
      : 'Queued';
    /* The reason a tile failed used to be dropped on the floor: the
       progress line said "1 failed" and the tile said "Failed —
       remove", so "my photos do not upload" had no answer anywhere on
       screen. It is on the tile (title) and in the summary line now. */
    return '<div class="stage-th' + (it.status === 'failed' ? ' is-failed' : '') + (it.status === 'done' ? ' is-done' : '') +
      '" data-sid="' + esc(it.id) + '"' + (it.error ? ' title="' + esc(it.error) + '"' : '') + '>' +
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

    /* A long reason is cut at a word boundary, not mid-word: the
       unconfigured-Cloudinary sentence ends "…Environment variables,
       t" when it is sliced at a fixed offset. */
    function clip(msg, max) {
      var s = String(msg);
      if (s.length <= max) return s;
      var cut = s.slice(0, max);
      var sp = cut.lastIndexOf(' ');
      return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
    }

    function report() {
      if (!prog) return;
      if (done + failed >= total) {
        var firstError = null;
        galStage(ctx).forEach(function (it) {
          if (!firstError && it.status === 'failed' && it.error) firstError = it.error;
        });
        prog.className = 'media-upload-status ' + (failed ? 'error' : 'success');
        prog.textContent = failed
          ? (done + ' uploaded, ' + failed + ' failed' + (firstError ? ' — ' + clip(firstError, 200) : ''))
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
        }, function (msg) {
          item.status = 'failed';
          item.error = msg || '';
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
  }  /* ================= 4j. Finance — the books, and what reconciles ====
     The dashboard's last question is the one the brief asks first:
     after the money moved, does what we took equal what we owe and
     what we earned?

     HOW THIS PANEL IS ALLOWED TO GET ITS NUMBERS

       ONE call — POST /api/finance { action: 'report' } — and every
       figure on the page comes out of that answer. It does NOT read
       ledger_entries itself, does NOT query the views, and does NOT
       hold a second opinion about a balance: the function computes,
       the page prints. (The one sum it does perform is adding the
       report's own per-line figures into a total, which is labelled
       as such.)

     RECONCILIATION, AND WHY IT IS SHOWN RATHER THAN ASSERTED

       Every posting is a pair — a debit and a credit — so for each
       business line:

         cash in − cash out = revenue + unearned + payable
                              − refunds − costs

       That is the double-entry identity, not a policy. The panel
       prints both sides and the RESIDUAL, and flags a line whose
       residual is not zero: one-sided entries are exactly the mistake
       this screen exists to catch, so smoothing them away here would
       be the bug. A companion test drives a one-sided line through it
       and requires the flag.

     WHAT MOVES MONEY, AND WHO

       Refunds and referral payouts POST back to the same function,
       which refuses a support login. The panel hides those controls
       from support for the same reason the Care panel does: the
       server's gate is the rule, this is courtesy. Nothing here can
       EDIT a ledger row — the table has no UPDATE for any client role.
     ============================================================ */

  var fin = {
    report: null,
    error: null,
    busy: false,
    notice: null,
    noticeKind: 'bad',
    refundRef: '',
    refundAmount: '',
    referralId: '',
    referralStatus: '',
    referralPayout: ''
  };

  /* The report is in KOBO integers, because that is what the ledger
     stores; the screen is in naira, and this is the only place the two
     meet. Never a float in the books, never kobo in a sentence. */
  function naira(kobo) { return ngn((Number(kobo) || 0) / 100); }

  /* The lines the brief names, in the order it names them. A line with
     no entries is shown as zero rather than omitted: "nothing here"
     and "we forgot to look" must not look the same. */
  var FIN_LINES = ['care', 'verification', 'monitoring', 'marketplace', 'storage', 'housing'];

  var FIN_LABEL = {
    care: 'Arzuz Care',
    verification: 'Verification',
    monitoring: 'Monitoring',
    marketplace: 'Marketplace',
    storage: 'Storage (off)',
    housing: 'Housing (no revenue, by design)'
  };

  var FIN_REFERRAL_LABEL = {
    under_review: 'Under review',
    approved: 'Approved — not yet paid',
    payout_pending: 'Payout pending',
    paid: 'Paid',
    rejected: 'Rejected',
    reversed: 'Reversed'
  };

  function financeCanMove() { return currentRole() === 'admin'; }

  function financePost(payload) {
    return ArzuzAuth.headers().then(function (h) {
      return fetch('/api/finance', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: JSON.stringify(payload)
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        /* Only a dead session is a logout; a 409 or a 403 is the books
           refusing, which is information the panel shows. */
        if (r.status === 401) {
          onAuthError(Object.assign(new Error('Finance refused'), { status: 401 }));
          throw apiErr(r, body);
        }
        if (!r.ok) throw apiErr(r, body);
        return body;
      });
    });
  }

  /* Written into the element BESIDE the fields rather than by repainting
     the panel: a refusal must not throw away what the operator typed. */
  function financeNote(msg, kind) {
    fin.notice = msg;
    fin.noticeKind = kind || 'bad';
    var el = $('finNoteLive') || $('finNote');
    if (el) {
      el.className = 'sub';
      el.style.color = fin.noticeKind === 'good' ? 'var(--ok, #1c7c4a)' : 'var(--alert, #b3261e)';
      el.textContent = msg;
    }
  }

  /* The same notice, rendered: shown to whoever is looking, not only to
     the role that could have acted — a support login that tried anyway
     is owed the refusal, and swallowing it would leave them thinking the
     click did nothing. */
  function finNoteHtml() {
    if (!fin.notice) return '';
    return '<p class="sub" id="finNote"' + (fin.noticeKind === 'good' ? '' : ' style="color:var(--alert,#b3261e)"') +
      '>' + esc(fin.notice) + '</p>';
  }

  function financeLoad() {
    if (fin.busy) return Promise.resolve(null);
    fin.busy = true;
    return financePost({ action: 'report' }).then(function (body) {
      fin.report = body;
      fin.error = null;
      renderFinancePanel();
      return body;
    }).catch(function (err) {
      /* The function's own sentence, not a guess: a 503 that means
         "the tables are not there yet" reads differently from a 403. */
      fin.error = err.message;
      renderFinancePanel();
      return null;
    }).then(function (out) { fin.busy = false; return out; });
  }

  /* Zeroed, so a line the ledger has never seen still prints as zeroes
     rather than as blanks the reader has to interpret. */
  function finLine(lines, key) {
    var z = { cash_in_kobo: 0, cash_out_kobo: 0, revenue_kobo: 0, unearned_added_kobo: 0, unearned_released_kobo: 0, unearned_kobo: 0, refunds_kobo: 0, costs_kobo: 0, payable_kobo: 0, contribution_margin_kobo: 0 };
    return Object.assign(z, (lines && lines[key]) || {});
  }

  /* cash in − cash out, against what the same rows say we owe, earned,
     refunded and spent. Both sides are the report's figures. */
  function finCash(x) { return (Number(x.cash_in_kobo) || 0) - (Number(x.cash_out_kobo) || 0); }
  function finClaim(x) {
    return (Number(x.revenue_kobo) || 0) + (Number(x.unearned_kobo) || 0) + (Number(x.payable_kobo) || 0)
      - (Number(x.refunds_kobo) || 0) - (Number(x.costs_kobo) || 0);
  }

  function finRow(label, valueHtml) {
    return '<tr><td>' + label + '</td><td style="text-align:right;font-family:var(--mono)">' + valueHtml + '</td></tr>';
  }

  function renderFinancePanel() {
    var head = $('finHead'), linesEl = $('finLines'), reconEl = $('finRecon');
    var refundsEl = $('finRefunds'), refsEl = $('finReferrals');
    if (!head || !linesEl || !reconEl || !refundsEl || !refsEl) return;

    if (fin.error) {
      head.innerHTML = '<h3>' + ico('coin', 16) + ' Finance</h3>' +
        '<p class="sub">' + esc(fin.error) + '</p>';
      linesEl.innerHTML = reconEl.innerHTML = refundsEl.innerHTML = refsEl.innerHTML = '';
      return;
    }
    if (!fin.report) {
      head.innerHTML = '<h3>' + ico('coin', 16) + ' Finance</h3><p class="sub">Reading the books\u2026</p>';
      financeLoad();
      return;
    }

    var rep = fin.report;
    var housing = rep.housing || {};

    /* --- the headline: the lines added up, labelled as a total of the
       report's own figures rather than a second opinion --- */
    var total = FIN_LINES.reduce(function (acc, key) {
      var x = finLine(rep.lines, key);
      ['cash_in_kobo', 'cash_out_kobo', 'revenue_kobo', 'refunds_kobo', 'costs_kobo', 'payable_kobo', 'unearned_kobo', 'contribution_margin_kobo'].forEach(function (k) {
        acc[k] = (acc[k] || 0) + (Number(x[k]) || 0);
      });
      return acc;
    }, {});

    head.innerHTML = '<h3>' + ico('coin', 16) + ' Finance \u2014 the books, from the ledger</h3>' +
      '<p class="sub">Every figure here came back from <b>/api/finance action:report</b>, which sums an append-only ' +
      'ledger. Nothing on this screen can edit a number \u2014 a wrong posting is corrected by posting its reverse, ' +
      'which is why the reconciliation below is worth reading rather than trusting.</p>' +
      '<div class="details-kv-grid">' +
        kv('Cash in (all lines)', '<b>' + esc(naira(total.cash_in_kobo)) + '</b>') +
        kv('Cash out (refunds)', esc(naira(total.cash_out_kobo))) +
        kv('Revenue recognised', esc(naira(total.revenue_kobo))) +
        kv('Unearned (owed as cover)', esc(naira(total.unearned_kobo))) +
        kv('Refunds', esc(naira(total.refunds_kobo))) +
        kv('Repair costs', esc(naira(total.costs_kobo))) +
        kv('Provider payable', esc(naira(total.payable_kobo))) +
        kv('Contribution margin', '<b>' + esc(naira(total.contribution_margin_kobo)) + '</b>') +
      '</div>' +
      '<p class="sub">Housing carries no revenue by design: listing fee ' + esc(naira(housing.listing_fee_kobo)) +
      ', rent commission ' + esc(Number(housing.rent_commission_bps) || 0) + ' bps, revenue ' +
      esc(naira(housing.revenue_kobo)) + '. Storage is ' + (rep.storage_enabled ? 'ON' : 'off') +
      ', so a storage order is refused rather than quietly priced.</p>' +
      '<p class="sub">Orders the provider accepted, by line and state: ' +
      (Object.keys(rep.orders || {}).length
        ? Object.keys(rep.orders).sort().map(function (k) {
          return '<b>' + esc(k.replace(':', ' \u00b7 ')) + '</b> ' + esc(rep.orders[k]);
        }).join(' \u00b7 ')
        : 'none yet') +
      '.</p>';

    /* --- the lines --- */
    var rows = FIN_LINES.map(function (key) {
      var x = finLine(rep.lines, key);
      var label = FIN_LABEL[key] || key;
      var isHousing = key === 'housing';
      return '<tr>' +
        '<td><b>' + esc(label) + '</b>' + (isHousing ? '<div class="sub" style="font-size:12px">rent and deposits are never ours</div>' : '') + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.cash_in_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.cash_out_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.unearned_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.revenue_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.refunds_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.costs_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.payable_kobo)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(x.contribution_margin_kobo)) + '</td>' +
        '</tr>';
    }).join('');

    linesEl.innerHTML = '<h3>' + ico('trending', 16) + ' Business lines</h3>' +
      '<p class="sub">Cash actually taken and returned, then what the same rows say about the obligation, the ' +
      'revenue and the cost. Contribution margin is revenue less repair costs \u2014 the report\u2019s figure, not one ' +
      'worked out here.</p>' +
      '<div class="table-wrap"><table><thead><tr>' +
      ['Line', 'Cash in', 'Cash out', 'Unearned', 'Revenue', 'Refunds', 'Costs', 'Payable', 'Margin']
        .map(function (h, i) { return '<th' + (i ? ' style="text-align:right"' : '') + '>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    /* --- the reconciliation --- */
    var bad = [];
    var reconRows = FIN_LINES.map(function (key) {
      var x = finLine(rep.lines, key);
      var cash = finCash(x);
      var claim = finClaim(x);
      var residual = cash - claim;
      if (residual !== 0) bad.push((FIN_LABEL[key] || key) + ' ' + naira(residual));
      return '<tr>' +
        '<td><b>' + esc(FIN_LABEL[key] || key) + '</b></td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(cash)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(claim)) + '</td>' +
        '<td style="text-align:right;font-family:var(--mono)">' + (residual === 0
          ? '<span class="tag-status tag-open">balanced</span>'
          : '<span class="tag-status tag-cancelled">off by ' + esc(naira(Math.abs(residual))) + '</span>') + '</td>' +
        '</tr>';
    }).join('');

    reconEl.innerHTML = '<h3>' + ico('shield', 16) + ' Reconciliation \u2014 from the same rows</h3>' +
      '<p class="sub">Every posting is a pair of entries, so per line: <b>cash in \u2212 cash out</b> must equal ' +
      '<b>revenue + unearned + payable \u2212 refunds \u2212 costs</b>. This is arithmetic on the ledger, not a policy ' +
      '\u2014 a line that does not balance has an entry on one side only, which is the mistake this screen exists to ' +
      'catch. It is shown, never smoothed.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Line</th>' +
      '<th style="text-align:right">Cash in \u2212 out</th><th style="text-align:right">Owed + earned \u2212 returned</th>' +
      '<th style="text-align:right">Check</th></tr></thead><tbody>' + reconRows + '</tbody></table></div>' +
      (bad.length
        ? '<div class="ops-row"><span class="ic">' + ico('alert', 15) + '</span><span class="tx"><b>' +
          bad.length + ' line(s) do not balance</b><span>' + esc(bad.join(' \u00b7 ')) +
          ' \u2014 find the one-sided entry in ledger_entries before trusting any figure above.</span></span></div>'
        : '<p class="sub">Every line balances. Cash taken equals what the books say we owe, earned, refunded and ' +
          'spent \u2014 which is what "the ledger is the record" is supposed to mean.</p>');

    /* --- refunds --- */
    var canMove = financeCanMove();
    refundsEl.innerHTML = '<h3>' + ico('refresh', 16) + ' Refunds</h3>' +
      '<p class="sub">A refund is a payment reference and an amount. The function asks the provider first, then ' +
      'posts the reversal pair \u2014 cash back out, the obligation released \u2014 so the books move with the money ' +
      'and the reconciliation above still balances afterwards.</p>' +
      (canMove
        ? '<div class="edit-fld"><label>Payment reference</label>' +
          '<input type="text" id="finRefundRef" maxlength="80" placeholder="e.g. AZ-P-\u2026" value="' + esc(fin.refundRef) + '"></div>' +
          '<div class="edit-fld"><label>Amount in \u20a6 (blank = the whole order)</label>' +
          '<input type="text" id="finRefundAmount" inputmode="numeric" placeholder="e.g. 20000" value="' + esc(fin.refundAmount) + '"></div>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
          '<button type="button" class="btn-inline" data-fin="refund">Refund it</button>' +
          '<span class="sub" id="finNoteLive"></span></div>'
        : '<p class="sub">Only the admin login may refund. Support can read every figure here, and the function ' +
          'refuses a refund from any other role.</p>') +
      finNoteHtml();

    /* --- referral payouts --- */
    var refs = rep.referrals || [];
    var refRows = refs.length
      ? refs.map(function (r) {
        return '<tr><td><b>' + esc(FIN_REFERRAL_LABEL[r.status] || r.status) + '</b></td>' +
          '<td style="text-align:right;font-family:var(--mono)">' + esc(r.claims) + '</td>' +
          '<td style="text-align:right;font-family:var(--mono)">' + esc(naira(r.reward_kobo)) + '</td>' +
          '<td style="font-family:var(--mono);font-size:12px">' + esc(r.first_at ? fmtDate(r.first_at) : '') + '</td></tr>';
      }).join('')
      : '<tr><td colspan="4" class="sub">No referral has been recorded yet \u2014 a code that nobody has used ' +
        'does not appear here.</td></tr>';

    /* The state list is the FUNCTION'S list (REFERRAL_STATES), quoted
       rather than invented: a status the server does not know would be
       refused, and offering it would be a control that cannot work. */
    var states = ['under_review', 'approved', 'payout_pending', 'paid', 'rejected', 'reversed'];
    refsEl.innerHTML = '<h3>' + ico('users', 16) + ' Referral payouts</h3>' +
      '<p class="sub">One reward per qualifying payment, one qualification per referred customer, and never a ' +
      'self-referral \u2014 the database enforces all three. A reward is only ever <b>paid</b> with the provider\u2019s ' +
      'own payout reference, so this box is where that reference is recorded.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>State</th><th style="text-align:right">Claims</th>' +
      '<th style="text-align:right">Rewards</th><th>First</th></tr></thead><tbody>' + refRows + '</tbody></table></div>' +
      (canMove
        ? '<div class="edit-fld"><label>Referral id (from the referrals table)</label>' +
          '<input type="text" id="finRefId" maxlength="80" placeholder="e.g. 8f1c\u2026" value="' + esc(fin.referralId) + '"></div>' +
          '<div class="edit-fld"><label>Move it to</label>' +
          '<select id="finRefStatus">' +
          ['<option value="">\u2014 pick a state \u2014</option>'].concat(states.map(function (s) {
            return '<option value="' + esc(s) + '"' + (fin.referralStatus === s ? ' selected' : '') + '>' +
              esc(FIN_REFERRAL_LABEL[s] || s) + '</option>';
          })).join('') + '</select></div>' +
          '<div class="edit-fld"><label>Provider payout reference (required for \u201cpaid\u201d)</label>' +
          '<input type="text" id="finRefPayout" maxlength="80" placeholder="e.g. TRF-\u2026" value="' + esc(fin.referralPayout) + '"></div>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
          '<button type="button" class="btn-inline" data-fin="referral">Record it</button>' +
          '<span class="sub" id="finRefNote">' + (fin.noticeKind === 'good' && fin.notice ? esc(fin.notice) : '') + '</span></div>' +
          '<div class="edit-fld" style="margin-top:10px"><label>Switch a referral code off or back on (e.g. a code being abused)</label>' +
          '<input type="text" id="finRefCode" maxlength="32" placeholder="e.g. KOLA-4821" value="' + esc(fin.referralCodeValue || '') + '"></div>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
          '<button type="button" class="btn-inline" data-fin="referral-code-off">Switch off</button>' +
          '<button type="button" class="btn-inline" data-fin="referral-code-on">Switch back on</button></div>'
        : '<p class="sub">Support reads the pipeline; only the admin login may move a payout.</p>');
  }

  /* One POST, then a re-read: every figure on screen is the one the
     function just computed, never one this file adjusted. */
  function financeRefund() {
    var refEl = $('finRefundRef'), amtEl = $('finRefundAmount');
    fin.refundRef = refEl ? String(refEl.value || '').trim() : '';
    fin.refundAmount = amtEl ? String(amtEl.value || '').trim() : '';
    if (!fin.refundRef) return financeNote('A refund needs the payment reference.');

    var payload = { action: 'refund', reference: fin.refundRef };
    if (fin.refundAmount) {
      var nairaAmount = Number(fin.refundAmount.replace(/[^0-9.]/g, ''));
      if (!isFinite(nairaAmount) || nairaAmount <= 0) {
        return financeNote('The amount has to be a number of naira, or blank for the whole order.');
      }
      payload.amount_kobo = Math.round(nairaAmount * 100);
    }

    var btn = document.querySelector('[data-fin="refund"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Refunding\u2026'; }

    return financePost(payload).then(function (body) {
      fin.notice = 'Refunded ' + naira(body.refunded_kobo) + ' on ' + (body.reference || fin.refundRef) +
        (body.provider_refund_ref ? ' \u2014 provider ref ' + body.provider_refund_ref : '') + '.';
      fin.noticeKind = 'good';
      fin.refundRef = '';
      fin.refundAmount = '';
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Refund posted.', 'success');
      return financeLoad();
    }).catch(function (err) {
      fin.notice = err.message;
      fin.noticeKind = 'bad';
      renderFinancePanel();
      return null;
    });
  }

  function financeReferral() {
    var idEl = $('finRefId'), stEl = $('finRefStatus'), pyEl = $('finRefPayout');
    fin.referralId = idEl ? String(idEl.value || '').trim() : '';
    fin.referralStatus = stEl ? String(stEl.value || '').trim() : '';
    fin.referralPayout = pyEl ? String(pyEl.value || '').trim() : '';
    if (!fin.referralId) return financeNote('A payout needs the referral id it belongs to.');
    if (!fin.referralStatus) return financeNote('Pick the state to move it to.');
    if (fin.referralStatus === 'paid' && !fin.referralPayout) {
      return financeNote('A reward cannot be marked paid without the provider\u2019s payout reference.');
    }

    var payload = { action: 'referral_decide', id: fin.referralId, status: fin.referralStatus };
    if (fin.referralPayout) payload.payout_provider_ref = fin.referralPayout;

    return financePost(payload).then(function () {
      fin.notice = 'Referral moved to ' + (FIN_REFERRAL_LABEL[fin.referralStatus] || fin.referralStatus) + '.';
      fin.noticeKind = 'good';
      fin.referralId = '';
      fin.referralStatus = '';
      fin.referralPayout = '';
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Referral updated.', 'success');
      return financeLoad();
    }).catch(function (err) {
      fin.notice = err.message;
      fin.noticeKind = 'bad';
      renderFinancePanel();
      return null;
    });
  }

  /* Switching a code off stops new buyers using it without touching
     rewards already earned; switching it back on restores it. Either
     way the server re-checks the admin login first. */
  function financeReferralCode(revoked) {
    var codeEl = $('finRefCode');
    fin.referralCodeValue = codeEl ? String(codeEl.value || '').trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{4,32}$/.test(fin.referralCodeValue)) {
      return financeNote('A referral code is the 4\u201332 letters-and-digits word on the share card.');
    }
    return financePost({
      action: 'referral_code',
      code: fin.referralCodeValue,
      revoked: !!revoked
    }).then(function () {
      fin.notice = 'Code ' + fin.referralCodeValue + (revoked ? ' switched off.' : ' switched back on.');
      fin.noticeKind = 'good';
      fin.referralCodeValue = '';
      if (ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Referral code updated.', 'success');
      return financeLoad();
    }).catch(function (err) {
      fin.notice = err.message;
      fin.noticeKind = 'bad';
      renderFinancePanel();
      return null;
    });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-fin]') : null;
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-fin');
    if (act === 'refund') return financeRefund();
    if (act === 'referral') return financeReferral();
    if (act === 'referral-code-off') return financeReferralCode(true);
    if (act === 'referral-code-on') return financeReferralCode(false);
  });

  /* Exposed for the boot harness, which cannot dispatch a document click:
     it drives the same functions a click would rather than a copy. */
  window.arzuzFinanceRender = renderFinancePanel;
  window.arzuzFinanceFrame = function (report) { fin.report = report; fin.error = null; renderFinancePanel(); };
  window.arzuzFinanceFail = function (message) { fin.report = null; fin.error = message; renderFinancePanel(); };
  window.arzuzFinance = {
    load: financeLoad,
    refund: financeRefund,
    referral: financeReferral,
    referralCode: financeReferralCode,
    state: function () { return fin; }
  };

  /* ================= 4k. Repair claims — the queue, and who may move ====

     WHAT THIS SCREEN IS FOR

       "Up to four call-outs" is a promise; a claim is one job asked for
       against it. What actually has to be answerable is what happened
       between the student asking and the job being done: who decided it
       was covered, on what grounds, which worker went, what it cost and
       whether the customer agreed. That is a QUEUE, and this is it.

     HOW THIS PANEL IS ALLOWED TO GET ITS NUMBERS

       ONE call — POST /api/claims { action: 'queue' } — and every row,
       every count and every status on the page comes out of that
       answer. It does NOT read repair_claims itself and does NOT invent
       a status: the function returns the rows and its status
       vocabulary, and the buttons under a claim are keyed to that
       claim's OWN status word.

     WHAT THIS PAGE IS NOT ALLOWED TO DO

       It cannot approve, cannot spend a call-out, cannot type a cost
       into the books and cannot close anything. Every control POSTs
       back to the function, which re-checks the login's role and the
       claim's real state before it writes. Support is offered no
       decision, no cost and no resolution, because the function refuses
       those from a support login — the server's gate is the rule and
       this is courtesy — and when a control is missing the panel says
       which rule is why rather than leaving a support login to guess.

     THE CALL-OUT, AND WHY THIS SCREEN CANNOT SPEND TWO

       Approving calls claim_reserve_callout(), which locks the pass and
       reads the credit ledger's own sum in the same transaction. Two
       admins approving the last call-out at the same moment: one gets
       it, the other is told the pass has nothing left. That sentence is
       rendered as the function sent it and the claim is left where the
       function left it — under review — never retried into a success.
     ============================================================ */

  var clq = {
    queue: null,       /* the one answer everything below is rendered from */
    error: null,
    busy: false,
    limit: 50,
    status: '',        /* the queue filter, in the SERVER's vocabulary */
    lateOnly: false,   /* and a look-at-what-is-late filter over the page sent */
    selected: null,    /* the claim being worked, by id */
    notice: null,
    noticeKind: 'bad',
    /* The action forms, held as the operator typed them: a refusal must
       never throw away their words. */
    decision: 'covered',
    reason: '',
    estimate: '',
    worker: '',
    workerPhone: '',
    workerEmail: '',
    note: '',
    actual: '',
    parts: '',
    evidence: '',
    transferRef: '',
    outcome: 'completed',
    resolution: ''
  };

  /* The status vocabulary, QUOTED from supabase-claims.sql's CHECK, so a
     status the schema does not have cannot be rendered as one here. */
  var CLAIM_STATUS = ['draft', 'submitted', 'under_review', 'approved', 'assigned',
    'in_progress', 'awaiting_customer', 'completed', 'rejected', 'cancelled', 'disputed'];

  var CLAIM_STATUS_LABEL = {
    draft: 'Draft',
    submitted: 'Filed',
    under_review: 'Under review',
    approved: 'Covered, no worker yet',
    assigned: 'With a worker',
    in_progress: 'Work started',
    awaiting_customer: 'Waiting on the customer',
    completed: 'Completed',
    rejected: 'Not covered',
    cancelled: 'Withdrawn',
    disputed: 'Disputed'
  };

  /* A dispute is not a refusal: the work happened and the customer says
     it is wrong, so it wears the alert colour rather than a grey. */
  var CLAIM_STATUS_TAG = {
    draft: 'tag-draft',
    submitted: 'tag-pending',
    under_review: 'tag-pending',
    approved: 'tag-open',
    assigned: 'tag-matched',
    in_progress: 'tag-in_progress',
    awaiting_customer: 'tag-awaiting_customer',
    completed: 'tag-completed',
    rejected: 'tag-cancelled',
    cancelled: 'tag-cancelled',
    disputed: 'tag-disputed'
  };

  /* What this page will OFFER, per status. A transcription of the
     function's own rules — decide only while a decision is still open,
     work only once a worker is on it, resolve only an open dispute —
     written as data so a status that gains a rule is one line here
     instead of a condition buried in the renderer. */
  var CLAIM_ACTS = {
    draft: ['decide'],
    submitted: ['decide'],
    under_review: ['decide'],
    approved: ['assign'],
    assigned: ['assign', 'progress', 'report_work'],
    in_progress: ['assign', 'report_work'],
    awaiting_customer: [],
    completed: [],
    rejected: [],
    cancelled: [],
    disputed: ['resolve']
  };

  /* The three the function refuses from a support login. Kept here so
     the panel can print which rule is why a control is missing. */
  var CLAIM_ADMIN_ONLY = ['decide', 'report_work', 'resolve', 'settle_payout'];

  var CLAIM_ACT_LABEL = {
    decide: 'decide coverage',
    assign: 'name a worker',
    progress: 'mark the work started',
    report_work: 'record the cost',
    settle_payout: 'record a provider payout',
    resolve: 'close a dispute'
  };

  function claimsCanDecide() { return currentRole() === 'admin'; }

  function claimsPost(payload) {
    return ArzuzAuth.headers().then(function (h) {
      return fetch('/api/claims', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: JSON.stringify(payload)
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        /* Only a dead session is a logout. A 409 is the queue refusing
           and a 403 is the role gate — both are information this screen
           exists to show. */
        if (r.status === 401) {
          onAuthError(Object.assign(new Error('Claims refused'), { status: 401 }));
          throw apiErr(r, body);
        }
        if (!r.ok) throw apiErr(r, body);
        return body;
      });
    });
  }

  /* Written beside the fields rather than by repainting the panel: a
     refusal must not throw away what the operator typed. */
  function claimsNote(msg, kind) {
    clq.notice = msg;
    clq.noticeKind = kind || 'bad';
    var el = $('claimNoteLive') || $('claimNote');
    if (el) {
      el.className = 'sub';
      el.style.color = clq.noticeKind === 'good' ? 'var(--ok, #1c7c4a)' : 'var(--alert, #b3261e)';
      el.textContent = msg;
    }
  }

  function clqNoteHtml() {
    if (!clq.notice) return '';
    return '<p class="sub" id="claimNote"' +
      (clq.noticeKind === 'good' ? '' : ' style="color:var(--alert,#b3261e)"') + '>' + esc(clq.notice) + '</p>';
  }

  function claimsLoad() {
    if (clq.busy) return Promise.resolve(null);
    clq.busy = true;
    var payload = { action: 'queue', limit: clq.limit };
    if (clq.status) payload.status = clq.status;
    return claimsPost(payload).then(function (body) {
      clq.queue = body;
      clq.error = null;
      renderClaimsPanel();
      return body;
    }).catch(function (err) {
      /* The function's own sentence: a 503 that means "claims are not
         switched on for this site yet" reads nothing like a 403. */
      clq.error = err.message;
      renderClaimsPanel();
      return null;
    }).then(function (out) { clq.busy = false; return out; });
  }

  function claimById(id) {
    var rows = (clq.queue && clq.queue.claims) || [];
    return rows.filter(function (r) { return r.id === id; })[0] || null;
  }

  function claimTag(status) {
    return '<span class="tag-status ' + esc(CLAIM_STATUS_TAG[status] || 'tag-draft') + '">' +
      esc(CLAIM_STATUS_LABEL[status] || status) + '</span>';
  }

  /* The first claim that still has something for us to do, else the
     newest row. Opening on a claim nobody can act on would make the
     screen look like it has no controls. */
  /* Which claim the work panel opens on: the top of the queue THAT THIS
     LOGIN CAN MOVE. The queue is ordered late-first, and the most late
     claim is often one only the admin may touch (a dispute awaiting a
     decision) — opening support on a claim with no button for them is a
     dead end dressed as a priority. So the first row with an action
     THIS role may take wins, then the first with any action at all, and
     only then the top of the queue. */
  function claimDefault(rows) {
    var yours = function (r) {
      return (CLAIM_ACTS[r.status] || []).filter(function (a) {
        return claimsCanDecide() || CLAIM_ADMIN_ONLY.indexOf(a) === -1;
      }).length > 0;
    };
    return rows.filter(yours)[0]
      || rows.filter(function (r) { return (CLAIM_ACTS[r.status] || []).length > 0; })[0]
      || rows[0] || null;
  }

  function claimsSelect(id) {
    clq.selected = id;
    clq.notice = null;
    renderClaimsPanel();
  }

  /* Naira typed by a person, kobo stored by the books. Blank is not zero
     here: it means "the operator did not say", which is a different fact
     from a cost of nothing. */
  function claimMoney(text) {
    var raw = String(text === undefined || text === null ? '' : text).replace(/[^0-9.]/g, '');
    if (!raw) return null;
    var n = Number(raw);
    return isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  }

  /* "name = amount" per line. A line without a number is dropped rather
     than sent as zero: a part that cost nothing is not a part. */
  function claimPartsLines(text) {
    return String(text || '').split('\n').map(function (line) {
      var bits = line.split('=');
      if (bits.length < 2) return null;
      var name = String(bits[0] || '').trim().slice(0, 80);
      var kobo = claimMoney(bits[1]);
      return (name && kobo) ? { name: name, kobo: kobo } : null;
    }).filter(function (x) { return !!x; }).slice(0, 20);
  }

  function claimEvidenceLines(text) {
    return String(text || '').split('\n').map(function (u) { return u.trim(); })
      .filter(function (u) { return /^https:\/\//.test(u); }).slice(0, 6);
  }

  function claimField(id, label, value, placeholder, kind) {
    return '<div class="edit-fld"><label>' + esc(label) + '</label>' +
      (kind === 'area'
        ? '<textarea id="' + id + '" rows="3" placeholder="' + esc(placeholder) + '">' + esc(value) + '</textarea>'
        : '<input type="text" id="' + id + '" placeholder="' + esc(placeholder) + '" value="' + esc(value) + '">') +
      '</div>';
  }

  function claimInput(id) {
    var el = $(id);
    return el ? String(el.value === undefined || el.value === null ? '' : el.value) : '';
  }

  function claimPick(id, fallback) {
    var v = claimInput(id);
    return v ? v : fallback;
  }

  function claimPhotosHtml(claim) {
    var photos = claim.photos || [];
    if (!photos.length) return '';
    return '<h3>' + ico('image', 16) + ' What the student sent</h3>' +
      '<p class="sub">' + esc(photos.length) + ' photo link(s) filed with the claim \u2014 uploaded by the ' +
      'student, not sent to this page.</p>' +
      '<p class="sub">' + photos.map(function (u, i) {
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener">photo ' + esc(i + 1) + '</a>';
      }).join(' \u00b7 ') + '</p>';
  }

  function claimPartsHtml(claim) {
    var parts = claim.parts || [];
    if (!parts.length) return '';
    var sum = parts.reduce(function (n, p) { return n + (Number(p && p.kobo) || 0); }, 0);
    return '<h3>' + ico('tag', 16) + ' Parts</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Part</th>' +
      '<th style="text-align:right">Cost</th></tr></thead><tbody>' +
      parts.map(function (p) {
        return '<tr><td>' + esc((p && p.name) || '') + '</td>' +
          '<td style="text-align:right;font-family:var(--mono)">' + esc(naira((p && p.kobo) || 0)) + '</td></tr>';
      }).join('') +
      '<tr><td><b>Total</b></td><td style="text-align:right;font-family:var(--mono)"><b>' +
      esc(naira(sum)) + '</b></td></tr></tbody></table></div>' +
      '<p class="sub">Parts are shown as reported. Whether they sit inside the published ceiling is a ' +
      'question for the cover\u2019s terms, not for this screen.</p>';
  }

  /* THE WORKER'S OWN ANSWER, in one place: it is read on the row, on the
     card and in the work panel, and three renderings of the same fact is
     how one of them ends up saying something the others do not.

     `provider_answer` is the worker's word, not ours: 'accepted' is them
     saying the job is theirs, 'declined' is them saying it is not, and
     null is us having heard nothing back. Everything below is the
     SERVER's data — the panel does not decide who agreed. */
  function claimAnswerText(claim) {
    if (claim.provider_answer === 'accepted') {
      return { said: 'accepted the job on', chip: 'accepted', bad: false };
    }
    if (claim.provider_answer === 'declined') {
      return { said: 'turned the job down on', chip: 'declined \u2014 needs another worker', bad: true };
    }
    /* THE ONE NOBODY SAID ANYTHING TO. Not the same fact as a refusal and
       not shown as one: 'unanswered' is a job the clock took back after
       the worker was asked and stayed silent, and the row says which — a
       panel that reads it as "they said no" sends the next person to ring
       somebody who may never have seen the message. */
    if (claim.provider_answer === 'unanswered') {
      return { said: 'never answered the handover, so the job was taken back on',
        chip: 'no answer \u2014 needs another worker', bad: true, unanswered: true };
    }
    return null;
  }

  /* WHEN THEY SAID THEY CAN COME. A day is the worker's own words and the
     panel quotes them: the reader is deciding who does what tomorrow, and
     a computed "Saturday" would be this screen guessing a timezone on a
     date somebody will be given. */
  function claimProposalText(claim) {
    var day = String(claim.provider_proposal || '').trim();
    return day ? day : null;
  }

  /* THE CUSTOMER'S OWN HALF OF THAT CONVERSATION, from the two columns the
     function writes: the instant they agreed a day, and the day they asked
     for instead with its own instant. One at a time \u2014 the server refuses
     to write both \u2014 because reading an agreement and a request off the
     same row is a reader guessing which of the two a customer meant.

     The day an agreement quotes is the WORKER's sentence, not a date this
     screen worked out: re-computing "Saturday morning" means guessing a
     timezone and then printing the guess as an appointment. And the panel
     never says the two days agree: the customer's "Sunday afternoon" is a
     sentence, and deciding it is the same day as the worker's is the
     office's call, not this function's. */
  function claimCustomerDayText(claim) {
    if (claim.day_agreed_at) {
      return { agreed: true, at: claim.day_agreed_at, day: claimProposalText(claim) };
    }
    var asked = String(claim.customer_proposal || '').trim();
    if (asked) {
      return {
        agreed: false, at: claim.customer_proposed_at, asked: asked,
        day: claimProposalText(claim)
      };
    }
    return null;
  }

  /* The same fact on a row that is SCANNED: four words, with the customer's
     own day in the title rather than across a column that is read by
     looking rather than by reading. */
  function claimCustomerDayMark(claim) {
    var theirs = claimCustomerDayText(claim);
    if (!theirs) return '';
    return theirs.agreed
      ? ' <span class="sub">customer agreed the day</span>'
      : ' <span class="sub" title="' + esc('They asked for: ' + theirs.asked) + '">' +
        'customer asked for another day</span>';
  }

  /* The Worker cell, and whether the person named agreed to come. A job
     somebody has turned down is back with us, and the queue has to say so
     ON THE ROW \u2014 a fact that only exists inside the work panel is a
     fact whoever scans the list never sees. */
  /* The same fact, as a suffix on the Worker value rather than a sentence
     of its own: on the panel the worker's line already carries the number
     and the address, and this is the third question about that person —
     did they say yes? */
  function claimAnswerKv(claim) {
    var a = claimAnswerText(claim);
    var day = claimProposalText(claim);
    /* The customer's answer rides on the same line as the worker's, because
       it is the same conversation: a day the worker offered and a day the
       customer agreed or refused are two halves of one fact, and a reader
       who sees only the offer thinks an appointment was made. */
    var theirs = claimCustomerDayText(claim);
    var theirMark = !theirs ? ''
      : theirs.agreed
        ? ' \u00b7 <span class="sub">the customer agreed this day on ' +
          esc(fmtDate(theirs.at)) + '</span>'
        : ' \u00b7 <span class="sub">the customer asked for another day on ' +
          esc(fmtDate(theirs.at)) + '</span>';
    if (!a) {
      /* A day is an answer to something, and saying "has not answered yet"
         beside the very words they sent would be the panel lying about
         its own row. It is still not a yes, so the chip says what is
         true: a time was suggested, and nobody agreed a job. */
      return (day
        ? ' \u00b7 <span class="sub">suggested a time: ' + esc(day) + '</span>'
        : ' \u00b7 <span class="sub">has not answered yet</span>') + theirMark;
    }
    if (a.unanswered) return ' \u00b7 <b style="color:var(--alert,#b3261e)">no answer</b>';
    return a.bad
      ? ' \u00b7 <b style="color:var(--alert,#b3261e)">declined</b>' +
        (day ? ' \u00b7 <span class="sub">then offered: ' + esc(day) + '</span>' : '')
      : ' \u00b7 <span class="sub">has confirmed the job</span>' +
        (day ? ' \u00b7 <span class="sub">can come ' + esc(day) + '</span>' : '') + theirMark;
  }

  function claimWorkerCell(r) {
    if (!r.provider_name) return '\u2014';
    var a = claimAnswerText(r);
    var day = claimProposalText(r);
    /* Scanned, not read: the Worker column answers "who, and are they
       actually coming". On one line, a day the worker offered is the fact
       that turns a name into an appointment. */
    if (!a) {
      /* Their words ride in the title rather than across the cell: a worker
         who answers with a sentence ("I can do Saturday morning before
         11") would push the table out of shape, and this column is read by
         scanning. The full day is on the claim, one click away. */
      return esc(r.provider_name) + (day
        ? ' <span class="sub" title="' + esc(day) + '">suggested a time</span>'
        : ' <span class="sub">not answered yet</span>') + claimCustomerDayMark(r);
    }
    return esc(r.provider_name) + ' <span class="sub"' +
      (a.bad ? ' style="color:var(--alert,#b3261e)"' : '') + '>' + esc(a.chip) + '</span>' +
      (day ? ' <span class="sub">' + esc(day) + '</span>' : '') + claimCustomerDayMark(r);
  }

  function claimHistoryHtml(claim) {
    var out = '';
    /* THE ANSWER, before anything else on this claim: it is the newest
       fact about it and the only one that decides what happens next. */
    var answer = claimAnswerText(claim);
    if (answer) {
      /* A decline is not a footnote: the job is back with us, the clock
         restarted at 'name a worker', and the person who might be named
         next is the reader. What the panel does NOT say is whether the
         customer has been told the name is gone — that is the trail's
         row, and this screen does not guess about a message. */
      if (answer.bad) {
        out += '<div class="ops-row"><span class="ic">' + ico('alert', 15) + '</span><span class="tx">' +
          '<b>' + esc(claim.provider_name || 'The worker') + ' ' + esc(answer.said) + ' ' +
          esc(fmtDate(claim.provider_answered_at)) + '</b><span>' +
          (answer.unanswered
            ? 'Nothing came back \u2014 not a yes, not a no \u2014 so the clock asked once and then gave the ' +
              'job to somebody else. Somebody should ring them before this becomes a pattern: a worker ' +
              'who never sees the handover is a number to fix, not a person to blame. '
            : 'They replied: ' + esc(claim.provider_answer_note || 'no reason given') + '. ') +
          'The claim went back to <b>covered with nobody on it</b>, so it is waiting in this queue for a ' +
          'name again \u2014 the person named next replaces nobody, because there is nobody on it now. ' +
          'Nothing about the customer\u2019s money or their call-out has moved.</span></span></div>';
      } else {
        out += '<p class="sub">' + esc(claim.provider_name || 'The worker') + ' ' +
          esc(answer.said) + ' ' + esc(fmtDate(claim.provider_answered_at)) + ' \u2014 the job is ' +
          'theirs, and they said so in their own words' +
          (claim.provider_answer_note ? ': \u201c' + esc(claim.provider_answer_note) + '\u201d' : '') +
          '.</p>';
      }
    }
    /* THE DAY THEY OFFERED, under the answer rather than instead of it:
       the customer has it on their pass link, and the team needs it to
       know whether the visit is going to happen when they expect. */
    var proposed = claimProposalText(claim);
    if (proposed) {
      out += '<div class="ops-row"><span class="ic">' + ico('calendar', 15) + '</span><span class="tx">' +
        '<b>' + esc(claim.provider_name || 'The worker') + ' said they can come: ' +
        esc(proposed) + '</b><span>Their own words, sent to the customer on ' +
        esc(fmtDate(claim.provider_proposed_at)) + ' in the message that names when a worker is coming. ' +
        'It is not a booked appointment \u2014 nobody here has agreed it with them \u2014 so if the day does ' +
        'not suit the customer they will say so, and the work is still reported the same way.</span></span></div>';
    }
    /* AND WHAT THE CUSTOMER SAID ABOUT IT, under the offer rather than
       instead of it: the offer is what the answer is an answer TO, and a
       panel that replaced "they can come Saturday" with "they want Sunday"
       would leave the reader unable to tell whether the two ever matched.

       The two days are printed side by side and NEVER compared: "Sunday
       afternoon" against "Saturday morning" is a judgement about somebody's
       calendar, and the panel's job is to show a person both sentences so
       they can make it. What it does say is what did NOT happen \u2014 no
       booking was made here, no day was published to anybody but the worker
       \u2014 because that is the mistake this row exists to prevent. */
    var theirs = claimCustomerDayText(claim);
    if (theirs) {
      out += theirs.agreed
        ? '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx">' +
          '<b>The customer agreed this day on ' + esc(fmtDate(theirs.at)) + '</b><span>' +
          'They said yes from their own pass link, and ' +
          esc(claim.provider_name || 'the worker') + ' was messaged that the visit is on \u2014 a ' +
          'confirmed visit only one of the two people knows about is not confirmed. The notice is on ' +
          'the trail as its own row, which is where the channel it went on is written: this panel does ' +
          'not guess about a message. ' +
          (theirs.day
            ? 'What was agreed to is the worker\u2019s own sentence: \u201c' + esc(theirs.day) + '\u201d. '
            : '') +
          'Nothing else moved: the same worker, the same call-out, the same clock. If the visit does ' +
          'not happen on that day, this is the row that says what was agreed.</span></span></div>'
        : '<div class="ops-row"><span class="ic">' + ico('calendar', 15) + '</span><span class="tx">' +
          '<b>The customer cannot do ' +
          (theirs.day ? esc('\u201c' + theirs.day + '\u201d') : 'the day the worker offered') +
          ' \u2014 they said so on ' + esc(fmtDate(theirs.at)) + '</b><span>' +
          'They suggested: \u201c' + esc(theirs.asked) + '\u201d, in their own words, and ' +
          esc(claim.provider_name || 'the worker') + ' was sent that with the tenant\u2019s number to ' +
          'settle it on. The job is still theirs \u2014 a different day is not a refusal \u2014 nothing was ' +
          're-assigned, and no day was booked here: the two of them are agreeing it between them, and ' +
          'this claim is on the same clock it was. If neither day ends up working, that is the row to ' +
          'read before ringing either of them.</span></span></div>';
    }
    if (claim.disputed_at) {
      out += '<div class="ops-row"><span class="ic">' + ico('alert', 15) + '</span><span class="tx">' +
        '<b>The customer disputed this on ' + esc(fmtDate(claim.disputed_at)) + '</b><span>' +
        esc(claim.dispute_reason || '') + '</span></span></div>';
    }
    if (claim.resolved_at) {
      out += '<p class="sub">Resolved ' + esc(fmtDate(claim.resolved_at)) + ' by ' +
        esc(claim.closed_by || 'the team') + ': ' + esc(claim.resolution || '') + '</p>';
    }
    if (claim.customer_confirmed_at) {
      out += '<p class="sub">The customer confirmed the work on ' +
        esc(fmtDate(claim.customer_confirmed_at)) + '.</p>';
    }
    return out;
  }

  function claimClosedReason(claim) {
    if (claim.status === 'awaiting_customer') {
      return 'Nothing for the team to do: the worker has reported the work and the claim is with the customer. ' +
        'They confirm it from their pass link, or dispute it \u2014 and this queue follows whichever they do.';
    }
    if (claim.status === 'completed') return 'Closed. The customer confirmed the work on their pass link.';
    if (claim.status === 'rejected') {
      /* The decision's own sentence, and it usually ends in a full stop
         already — appending ours unconditionally printed "covered..",
         which reads as a bug rather than as emphasis. */
      var why = String(claim.eligibility_reason || 'no reason recorded');
      return 'Refused: ' + why + (/\.$/.test(why) ? '' : '.');
    }
    if (claim.status === 'cancelled') {
      return 'Withdrawn by the student' + (claim.resolution ? ': ' + claim.resolution : '.');
    }
    return 'Nothing to do on this claim in its current state.';
  }

  function claimActsHtml(claim, mine, withheld) {
    var out = '';

    if (mine.indexOf('decide') !== -1) {
      out += '<h3>' + ico('shield', 16) + ' Decide coverage</h3>' +
        '<p class="sub">One decision, in words the customer reads. <b>Covered</b> takes a call-out through ' +
        'claim_reserve_callout(), which locks the pass and reads the credit ledger itself \u2014 so if the pass ' +
        'has nothing left the claim is told so and left under review rather than approved against an allowance ' +
        'that is gone. <b>Not covered</b> refuses it, records the reason and spends nothing.</p>' +
        '<div class="edit-fld"><label>Coverage</label><select id="claimDecide">' +
        '<option value="covered"' + (clq.decision === 'covered' ? ' selected' : '') +
        '>Covered \u2014 one call-out is committed</option>' +
        '<option value="not_covered"' + (clq.decision === 'not_covered' ? ' selected' : '') +
        '>Not covered \u2014 refused, nothing spent</option>' +
        '</select></div>' +
        claimField('claimReason', 'Why \u2014 in words, because the customer reads it', clq.reason,
          'e.g. a burst pipe inside the flat is what the cover is for') +
        claimField('claimEstimate', 'Estimate in \u20a6 (optional \u2014 a quote, not a cost)', clq.estimate, 'e.g. 4500') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<button type="button" class="btn-inline" data-claim-act="decide">Record the decision</button>' +
        '<span class="sub" id="claimNoteLive"></span></div>';
    }

    if (mine.indexOf('assign') !== -1) {
      out += '<h3>' + ico('users', 16) + ' Name a worker</h3>' +
        '<p class="sub">The customer is told who is coming, and a worker with no reachable number is not an ' +
        'assignment. Support may do this \u2014 coordination is what support is for.</p>' +
        claimField('claimWorker', 'Worker', clq.worker, 'e.g. Yinka, plumbing') +
        claimField('claimWorkerPhone', 'A number the customer can reach', clq.workerPhone, '0803\u2026') +
        claimField('claimWorkerEmail', 'Email (optional \u2014 the outcome is copied to it)',
          clq.workerEmail, 'e.g. musa@example.com') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<button type="button" class="btn-inline" data-claim-act="assign">Assign</button></div>';
    }

    if (mine.indexOf('progress') !== -1) {
      out += '<h3>' + ico('refresh', 16) + ' Mark the work started</h3>' +
        '<p class="sub">The only move support can make on a job that is already with a worker. Reporting the ' +
        'work and closing the claim are the admin\u2019s.</p>' +
        claimField('claimProgressNote', 'Note (optional)', clq.note, 'e.g. worker on site') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<button type="button" class="btn-inline" data-claim-act="progress">Work started</button></div>';
    }

    if (mine.indexOf('report_work') !== -1) {
      out += '<h3>' + ico('coin', 16) + ' Report the work, and what it cost</h3>' +
        '<p class="sub">This does not close the claim. It moves it to <b>waiting on the customer</b>, because a ' +
        'worker\u2019s word is not a finished job \u2014 the customer confirms from their pass link, or disputes it. ' +
        'The actual cost is POSTED to the books as a pair, an expense and the provider payable, under a ' +
        'reference derived from this claim, so a retry cannot double-post it.</p>' +
        claimField('claimActual', 'Actual cost in \u20a6', clq.actual, 'e.g. 3200') +
        claimField('claimParts', 'Parts, one per line as "name = \u20a6"', clq.parts, 'e.g. trap = 1800', 'area') +
        claimField('claimEvidence', 'Photo links, one https URL per line', clq.evidence, 'https://\u2026', 'area') +
        claimField('claimReportNote', 'What was done, and anything the customer should know', clq.note,
          'e.g. replaced the trap and tested it') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<button type="button" class="btn-inline" data-claim-act="report_work">Report the work</button></div>';
    }

    if (claim.actual_kobo !== null && claim.actual_kobo !== undefined && Number(claim.actual_kobo) > 0) {
      var payout = claim.payout_settled || null;
      out += '<h3>' + ico('coin', 16) + ' Care provider payout</h3>' +
        '<p class="sub">Actual cost: <b>' + esc(naira(claim.actual_kobo)) + '</b> · payable belongs to <b>' +
        esc(claim.provider_name || 'no named worker') + '</b>. The transfer happens outside Arzuz; only record it here after your bank/provider confirms it.</p>' +
        (payout
          ? '<div class="ops-row"><span class="ic">' + ico('check', 15) + '</span><span class="tx"><b>Marked settled</b><span>' +
            'Transfer reference: ' + esc(payout.provider_transfer_ref || 'not recorded') +
            (payout.settled_at ? ' · ' + esc(fmtDate(payout.settled_at)) : '') + '</span></span></div>'
          : (claimsCanDecide()
            ? '<div class="edit-fld"><label for="claimTransferRef">Confirmed transfer reference</label>' +
              '<input type="text" id="claimTransferRef" maxlength="120" autocomplete="off" placeholder="e.g. bank transfer reference" value="' + esc(clq.transferRef) + '"></div>' +
              '<p class="sub">Do not use a claim number or “pending”. Confirm the money left the account first.</p>' +
              '<button type="button" class="btn-inline" data-claim-act="settle_payout">I confirmed the transfer — record payout</button>'
            : '<p class="sub">Only the admin login can mark a confirmed transfer as settled.</p>'));
    }

    if (mine.indexOf('resolve') !== -1) {
      out += '<h3>' + ico('alert', 16) + ' Resolve the dispute</h3>' +
        '<p class="sub">A disputed claim is closed by name. If the outcome is not <b>completed</b> the committed ' +
        'call-out goes back to the pass through claim_release_callout() \u2014 appended as the opposite row, ' +
        'never by editing the ledger.</p>' +
        '<div class="edit-fld"><label>Outcome</label><select id="claimOutcome">' +
        [['completed', 'Completed \u2014 the complaint was the fix'],
          ['rejected', 'Rejected \u2014 the work was wrong or not covered'],
          ['cancelled', 'Cancelled \u2014 the job is not happening']].map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (clq.outcome === o[0] ? ' selected' : '') + '>' +
            esc(o[1]) + '</option>';
        }).join('') +
        '</select></div>' +
        claimField('claimResolution', 'The resolution, on the record', clq.resolution,
          'e.g. the trap was replaced again at our cost on 12 Oct') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<button type="button" class="btn-inline" data-claim-act="resolve">Close the dispute</button></div>';
    }

    /* What we are NOT offered, and which rule says so. A hidden button is
       not the protection — the function refuses these from support anyway
       — but a support login is owed the reason. */
    if (withheld.length) {
      out += '<div class="ops-row"><span class="ic">' + ico('lock', 15) + '</span><span class="tx">' +
        '<b>Only the admin login may ' +
        esc(withheld.map(function (a) { return CLAIM_ACT_LABEL[a] || a; }).join(', ')) + '</b>' +
        '<span>The function refuses these from a support login. Support can read the whole claim, name the ' +
        'worker and record that work started.</span></span></div>';
    }

    if (!(CLAIM_ACTS[claim.status] || []).length) {
      out += '<p class="sub">' + esc(claimClosedReason(claim)) + '</p>';
    }

    return out + clqNoteHtml();
  }

  function claimWorkHtml(claim) {
    var st = claim.status;
    var acts = CLAIM_ACTS[st] || [];
    var canDecide = claimsCanDecide();
    var mine = acts.filter(function (a) { return canDecide || CLAIM_ADMIN_ONLY.indexOf(a) === -1; });
    var withheld = acts.filter(function (a) { return CLAIM_ADMIN_ONLY.indexOf(a) !== -1 && !canDecide; });

    var money = function (kobo, note) {
      if (kobo === null || kobo === undefined || kobo === '') return '\u2014';
      return naira(kobo) + (note ? ' <span class="sub">' + esc(note) + '</span>' : '');
    };
    var where = [claim.property, claim.room].filter(function (x) { return !!x; }).join(' \u00b7 ');

    return '<h3>' + ico('clipboard', 16) + ' ' + esc(claim.reference) + ' \u2014 ' +
      esc(CLAIM_STATUS_LABEL[st] || st) + '</h3>' +
      '<p class="sub">' + esc(claim.issue || '') + '</p>' +
      '<div class="details-kv-grid">' +
        kv('Student', esc(claim.student_name || '\u2014') +
          (claim.student_phone ? ' \u00b7 ' + esc(claim.student_phone) : '')) +
        kv('Where', esc(where || '\u2014')) +
        kv('Coverage', claim.eligibility
          ? esc(claim.eligibility === 'covered' ? 'Covered' : 'Not covered') +
            (claim.eligibility_reason ? ' \u2014 ' + esc(claim.eligibility_reason) : '') +
            (claim.decided_by ? ' (by ' + esc(claim.decided_by) + ')' : '')
          : 'not decided yet') +
        kv('Call-out', claim.call_out_no
          ? '#' + esc(claim.call_out_no) + ' committed to this claim'
          : 'none taken \u2014 nothing is spent until a decision says covered') +
        kv('On the clock', claim.aging
          ? claimAgingHtml(claim) + '<span class="sub"> \u2014 in this status since ' +
            esc(fmtDate(claim.aging.status_since)) + ', ' +
            esc(claim.aging.limit_hours) + 'h allowed' +
            (claim.aging.who === 'customer' ? ', waiting on the customer' : '') + '</span>'
          : '<span class="sub">not on the clock \u2014 nothing is waiting on this one</span>') +
        /* The worker's ADDRESS is shown, not just their number: it is a
           channel the decision goes out on, so "is there anywhere to
           email them?" has to be answerable from this panel rather than
           from a bounce. And whether they have ANSWERED: a name we chose
           and a name that said yes are different states of the same job,
           and the row is where that difference is visible. */
        kv('Worker', claim.provider_name
          ? esc(claim.provider_name) + (claim.provider_phone ? ' \u00b7 ' + esc(claim.provider_phone) : '') +
            (claim.provider_email
              ? ' \u00b7 ' + esc(claim.provider_email)
              : ' <span class="sub">(no email on file)</span>') +
            claimAnswerKv(claim)
          : '\u2014') +
        kv('Estimate', money(claim.estimate_kobo, 'a quote')) +
        kv('Actual', money(claim.actual_kobo, 'posted to the books')) +
        kv('Provider payable', money(claim.actual_kobo, claim.actual_kobo > 0
          ? (claim.payout_settled ? 'settled' : 'unpaid — see payout checkpoint below')
          : 'no payable recorded')) +
        kv('Filed', esc(claim.created_at ? fmtDate(claim.created_at) : '')) +
        kv('Pass', '<span style="font-family:var(--mono);font-size:12px">' + esc(claim.plan_id) + '</span>') +
      '</div>' +
      claimPhotosHtml(claim) + claimPartsHtml(claim) + claimHistoryHtml(claim) +
      claimActsHtml(claim, mine, withheld);
  }

  /* The money on a row: the ACTUAL once the work was reported, otherwise
     the decision's estimate marked as the quote it still is, otherwise
     nothing. Never a figure this page worked out. */
  function claimMoneyHtml(r) {
    if (r.actual_kobo !== null && r.actual_kobo !== undefined) return esc(naira(r.actual_kobo));
    if (r.estimate_kobo !== null && r.estimate_kobo !== undefined) return esc(naira(r.estimate_kobo)) + '*';
    return '\u2014';
  }

  /* The same queue as cards, for the widths where admin.css hides
     .table-wrap (max-width: 860px). This is the section a teammate works
     from while standing in a hallway with a phone, so it cannot be the
     one that disappears there — the data tables all render both for the
     same reason.

     The meta rows sit INSIDE .rc-head: admin.css scopes the flex and
     the gap to `.row-card .rc-head .rc-sub`, and outside it the tokens
     run together with no space between them. */
  /* How long a claim may stand where it is, and whose move it is.
     The clock itself is the server's: claims.js computes it from the
     claim's own trail and the queue arrives already ordered by it, so
     this function renders a number rather than deciding what late
     means. `aging` is null for a status with no clock (a draft, or
     anything finished), which is why every use below is guarded. */
  function claimAgingHtml(r, opts) {
    var a = r.aging;
    if (!a) return '';
    var overdue = a.overdue;
    var waited = a.hours_over >= 48
      ? Math.round(a.hours_over / 24) + ' days'
      : Math.max(1, Math.round(a.hours_over)) + 'h';
    var left = a.hours_left >= 48
      ? Math.round(a.hours_left / 24) + ' days'
      : Math.max(1, Math.round(a.hours_left)) + 'h';
    /* Short on the row, exact on hover: a queue is scanned, and the one
       fact this line carries is how late and whose move it is. The whole
       deadline (the instant it was due) is in the title, and the work
       panel spells the same numbers out in a sentence where there is
       room for one. */
    var when = overdue
      ? (a.who === 'ours' ? waited + ' late' : 'no reply for ' + waited)
      : left + ' left';
    var title = 'Due ' + fmtDate(a.deadline_at) + ' \u00b7 ' + a.limit_hours +
      'h allowed in this status' + (a.who === 'customer' ? ' \u00b7 waiting on the customer' : ' \u00b7 waiting on us');
    /* Two different lates: a claim WE owe an answer on, and one waiting
       on the customer. The second is not a failure and must not read
       like one, or the queue teaches people to ignore red.

       The sentence is two spans, not one string: admin.css puts the
       second half on its own line, so the Status column is sized by the
       longer HALF rather than by the whole sentence — a sentence that
       sizes the column squeezes the date beside it into three lines, and
       a queue nobody can scan is a queue nobody uses. The text reads the
       same either way, which is also what the tests pin. */
    var cls = !overdue ? 'claim-due' : (a.who === 'ours' ? 'claim-late' : 'claim-waiting');
    return '<span class="' + cls + '"' + (opts && opts.block ? ' style="display:block;margin-top:6px"' : '') +
      ' title="' + esc(title) + '">' + esc(when) +
      '<span class="claim-says"> \u00b7 ' + esc(a.says) + '</span></span>';
  }

  function claimCardHtml(r) {
    var here = clq.selected === r.id;
    var a = r.aging;
    return '<div class="row-card"' + (here ? ' style="border-color:rgba(160,130,255,.55)"' : '') +
      (a && a.overdue && a.who === 'ours' ? ' style="border-color:rgba(248,113,113,.5)"' : '') + '>' +
      '<div class="rc-top"><div class="rc-head"><b>' + esc(r.reference) + '</b>' +
      '<div class="rc-sub"><span>' + esc(r.student_name || '\u2014') + '</span>' +
      (r.student_phone ? '<span>' + esc(r.student_phone) + '</span>' : '') +
      '<span>' + esc(r.created_at ? fmtDate(r.created_at) : '') + '</span></div>' +
      '<div class="rc-sub" style="margin-top:6px">' + claimTag(r.status) + '</div>' +
      claimAgingHtml(r, { block: true }) +
      '<div class="rc-sub" style="margin-top:6px"><span>Call-out ' +
        (r.call_out_no ? '#' + esc(r.call_out_no) : 'none') + '</span><span>' +
        (r.provider_name ? claimWorkerCell(r) : 'no worker named') + '</span><span>' +
        claimMoneyHtml(r) + '</span></div>' +
      '</div></div>' +
      '<div class="rc-sub" style="margin-top:6px">' +
        esc(String(r.issue || '').slice(0, 120)) + '</div>' +
      '<div style="margin-top:10px"><button type="button" class="btn-inline" data-claim="' +
        esc(r.id) + '">' + (here ? 'Working on it' : 'Work on it') + '</button></div>' +
      '</div>';
  }

  function renderClaimsPanel() {
    var head = $('claimsHead'), queueEl = $('claimsQueue'), workEl = $('claimsWork');
    if (!head || !queueEl || !workEl) return;

    if (clq.error) {
      head.innerHTML = '<h3>' + ico('shield', 16) + ' Repair claims</h3>' +
        '<p class="sub">' + esc(clq.error) + '</p>';
      queueEl.innerHTML = workEl.innerHTML = '';
      return;
    }
    if (!clq.queue) {
      head.innerHTML = '<h3>' + ico('shield', 16) + ' Repair claims</h3>' +
        '<p class="sub">Reading the queue\u2026</p>';
      claimsLoad();
      return;
    }

    var rows = clq.queue.claims || [];
    var summary = clq.queue.summary || [];
    var statuses = clq.queue.statuses || CLAIM_STATUS;
    var canDecide = claimsCanDecide();

    var countOf = function (s) {
      var m = summary.filter(function (x) { return x.status === s; })[0];
      return m ? Number(m.claims || 0) : 0;
    };
    var onRecord = summary.reduce(function (n, s) { return n + Number(s.claims || 0); }, 0);
    var committed = summary.reduce(function (n, s) { return n + Number(s.call_outs_committed || 0); }, 0);
    var wantUs = rows.filter(function (r) {
      return ['completed', 'rejected', 'cancelled', 'awaiting_customer'].indexOf(r.status) === -1;
    }).length;

    /* The clock, as the server sent it. `rows` arrives already ordered
       overdue-first, so this only has to count and (when asked) filter
       the page it was given — the filter says "of the page the server
       sent" out loud, because filtering a page is not the same promise
       as asking the database for every late claim. */
    var overdueHere = rows.filter(function (r) { return r.aging && r.aging.overdue; }).length;
    var overdueOurs = rows.filter(function (r) {
      return r.aging && r.aging.overdue && r.aging.who === 'ours';
    }).length;
    /* How many visits are actually pinned down, counted by the server over
       every open claim \u2014 not over this page. `null` is "that read
       failed", which is NOT the same fact as zero: a dashboard that prints
       "0 agreed" because it could not look is a dashboard that lies about
       the one number this row exists for, so it says so instead. */
    var days = (clq.queue && clq.queue.days) || null;
    var shown = clq.lateOnly
      ? rows.filter(function (r) { return r.aging && r.aging.overdue; })
      : rows;

    head.innerHTML = '<h3>' + ico('shield', 16) + ' Repair claims \u2014 the queue, and who may move</h3>' +
      '<p class="sub">Every row and every count here came back from <b>/api/claims action:queue</b>. The ' +
      'buttons under a claim are the ones that claim\u2019s own status permits: the function re-checks the ' +
      'login\u2019s role and the claim\u2019s real state before it writes, so a refusal on this screen is the ' +
      'server\u2019s and not a guess.</p>' +
      '<div class="details-kv-grid">' +
        kv('Claims on record', '<b>' + esc(onRecord) + '</b>') +
        kv('Want a person', '<b>' + esc(wantUs) + '</b> of the ' + esc(rows.length) + ' shown') +
        kv('Call-outs committed', esc(committed) + ' across every pass') +
        kv('Past the deadline', overdueOurs
          ? '<b>' + esc(overdueOurs) + '</b> waiting on us' +
            (overdueHere - overdueOurs ? ' \u00b7 ' + esc(overdueHere - overdueOurs) + ' waiting on a customer' : '')
          : 'none of the ' + esc(rows.length) + ' shown \u2014 the clock is keeping up') +
        /* The visits, in one line: what is settled and what is still being
           bargained over. Both figures are the server's, over every open
           claim \u2014 a count off this page would move as the operator
           scrolled, which is exactly the number that must not move. */
        kv('Visit days', days
          ? (days.visits
            ? '<b>' + esc(days.agreed) + '</b> agreed \u00b7 ' +
              (days.open
                ? '<b>' + esc(days.open) + '</b> still being haggled over'
                : 'nothing left in the air between a worker and a tenant')
            : 'no visit day offered yet \u2014 a worker with no day named rings to arrange the time')
          : '<span class="sub">not reported by this deploy \u2014 the queue read the days and could not '
            + 'get an answer, which is not the same as none</span>') +
        kv('Your login', esc(currentRole()) + ' \u2014 ' + (canDecide
          ? 'may decide coverage and record cost'
          : 'may coordinate the worker, not decide')) +
      '</div>' +
      '<p class="sub">' + CLAIM_STATUS.map(function (s) {
        return '<span class="tag-status ' + esc(CLAIM_STATUS_TAG[s]) + '">' +
          esc(CLAIM_STATUS_LABEL[s]) + ' ' + esc(countOf(s)) + '</span>';
      }).join(' ') + '</p>' +
      '<p class="sub">A status with a zero beside it is one nobody is in. Told rather than left out: ' +
      '"nothing here" and "we did not look" must not look the same.</p>';

    /* --- the queue --- */
    var statusOpts = statuses.map(function (s) {
      return '<option value="' + esc(s) + '"' + (clq.status === s ? ' selected' : '') + '>' +
        esc(CLAIM_STATUS_LABEL[s] || s) + '</option>';
    }).join('');

    var body = shown.length ? shown.map(function (r) {
      var here = clq.selected === r.id;
      return '<tr' + (here ? ' style="background:rgba(124,58,237,.12)"' : '') + '>' +
        '<td><b>' + esc(r.reference) + '</b><div class="sub" style="font-size:12px">' +
          esc(String(r.issue || '').slice(0, 90)) + '</div></td>' +
        '<td>' + esc(r.student_name || '\u2014') +
          (r.student_phone ? '<div class="sub" style="font-size:12px">' + esc(r.student_phone) + '</div>' : '') +
        '</td>' +
        '<td>' + claimTag(r.status) + claimAgingHtml(r, { block: true }) + '</td>' +
        '<td>' + (r.call_out_no ? '#' + esc(r.call_out_no) : '\u2014') + '</td>' +
        '<td>' + claimWorkerCell(r) + '</td>' +
        /* The money is right-aligned against a left-aligned date with no
           cell padding between them (see admin.css), so the two figures
           read as one number without these two gaps. */
        '<td style="text-align:right;font-family:var(--mono);padding-right:10px">' + claimMoneyHtml(r) + '</td>' +
        '<td style="font-family:var(--mono);font-size:12px;white-space:nowrap;padding-left:10px">' +
          esc(r.created_at ? fmtDate(r.created_at) : '') + '</td>' +
        '<td><button type="button" class="btn-inline" data-claim="' + esc(r.id) + '">' +
          (here ? 'Working on it' : 'Work on it') + '</button></td>' +
        '</tr>';
    }).join('')
      : '<tr><td colspan="8" class="sub">' + (clq.lateOnly
        ? 'Nothing on this page is past its deadline. That is not the same as nothing anywhere \u2014 ' +
          'the filter looks at the page the server sent, and the scheduled clock pages the team about every claim '
        : 'No claim matches that filter. A claim reaches this queue the moment ' +
          'a student files one from their pass link.') + '</td></tr>';

    queueEl.innerHTML = '<h3>' + ico('clipboard', 16) + ' The queue</h3>' +
      '<p class="sub">Late first, and the worst of them first \u2014 a claim past its deadline sits above ' +
      'everything that is on time, and under those come the ones closest to going late. A claim with no ' +
      'clock at all (a draft, or anything finished) never jumps one that is still moving. An asterisk on a ' +
      'figure means it is the estimate the decision carried, not a cost \u2014 an actual only exists once the ' +
      'work was reported.</p>' +
      '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px">' +
        '<div class="edit-fld" style="margin:0"><label>Show</label><select id="claimFilter">' +
        '<option value="">Every status</option>' + statusOpts + '</select></div>' +
        '<button type="button" class="btn-inline" data-claim-act="filter">Apply</button>' +
        '<button type="button" class="btn-inline" data-claim-act="more">Widen to ' +
        esc(Math.min(clq.limit + 50, 100)) + '</button>' +
        (overdueHere
          ? '<button type="button" class="btn-inline" data-claim-act="late"' +
            (clq.lateOnly ? ' style="border-color:rgba(248,113,113,.6)"' : '') + '>' +
            (clq.lateOnly ? 'Show every claim' : 'Show only the ' + esc(overdueHere) + ' past their deadline') +
            '</button>'
          : '') +
        '<span class="sub">' + esc(shown.length) + ' shown, of ' + esc(onRecord) + ' on record' +
        (clq.lateOnly ? ' \u00b7 filtered to what is overdue, of the page the server sent' : '') + '</span>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      ['Claim', 'Student', 'Status', 'Call-out', 'Worker', 'Money', 'Filed', '']
        .map(function (h, i) { return '<th' + (i === 5 ? ' style="text-align:right"' : '') + '>' + esc(h) + '</th>'; })
        .join('') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="cards-wrap">' + (shown.length ? shown.map(claimCardHtml).join('') : '') + '</div>';

    /* --- the claim being worked --- */
    var sel = claimById(clq.selected) || claimDefault(rows);
    clq.selected = sel ? sel.id : null;
    workEl.innerHTML = sel ? claimWorkHtml(sel)
      : '<h3>' + ico('clipboard', 16) + ' Nothing to work</h3>' +
        '<p class="sub">The queue is empty. A claim appears here the moment a student files one from their ' +
        'Care pass link, and a call-out is only ever spent by the decision recorded above.</p>';
  }

  /* One POST, then a re-read: every status on screen is the one the
     function just wrote, never one this file adjusted. */
  function claimsAct(payload, said) {
    var btn = document.querySelector('[data-claim-act="' + payload.action + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
    return claimsPost(payload).then(function (body) {
      clq.notice = said(body);
      clq.noticeKind = 'good';
      clq.reason = '';
      clq.estimate = '';
      clq.worker = '';
      clq.workerPhone = '';
      clq.workerEmail = '';
      clq.note = '';
      clq.actual = '';
      clq.parts = '';
      clq.evidence = '';
      clq.transferRef = '';
      clq.resolution = '';
      if (window.ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Claim updated.', 'success');
      return claimsLoad();
    }).catch(function (err) {
      clq.notice = err.message;
      clq.noticeKind = 'bad';
      renderClaimsPanel();
      return null;
    });
  }

  function claimDecide() {
    var claim = claimById(clq.selected);
    if (!claim) return claimsNote('Pick a claim from the queue first.');
    clq.decision = claimPick('claimDecide', clq.decision);
    var reason = claimInput('claimReason').trim() || clq.reason;
    clq.reason = reason;
    clq.estimate = claimInput('claimEstimate').trim();
    if (reason.length < 5) {
      return claimsNote('A decision needs a reason in words \u2014 a refusal without one is the complaint that follows.');
    }
    var payload = { action: 'decide', id: claim.id, eligibility: clq.decision, reason: reason };
    if (clq.estimate) {
      var kobo = claimMoney(clq.estimate);
      if (!kobo) return claimsNote('The estimate has to be a number of naira, or blank for no quote.');
      payload.estimate_kobo = kobo;
    }
    return claimsAct(payload, function (body) {
      return body.status === 'approved'
        ? 'Covered. Call-out #' + body.call_out_no + ' of the pass is committed to ' + claim.reference +
          (body.estimate_kobo ? ', quoted at ' + naira(body.estimate_kobo) : '') + '.'
        : 'Recorded as not covered. The reason is on the claim for the customer to read, and no call-out was spent.';
    });
  }

  function claimAssign() {
    var claim = claimById(clq.selected);
    if (!claim) return claimsNote('Pick a claim from the queue first.');
    var name = claimInput('claimWorker').trim() || clq.worker;
    var phone = claimInput('claimWorkerPhone').trim();
    var email = claimInput('claimWorkerEmail').trim();
    clq.worker = name;
    clq.workerPhone = phone;
    clq.workerEmail = email;
    if (name.length < 2) return claimsNote('Name the worker who will do the job.');
    if (!phone) return claimsNote('A worker needs a number the customer can reach.');
    /* The address is optional and the function refuses a malformed one
       rather than storing it to fail silently later, so it is sent as
       whatever was typed — not pre-cleaned here, which would hide the
       refusal. */
    return claimsAct({
      action: 'assign', id: claim.id, provider_name: name,
      provider_phone: phone, provider_email: email || undefined,
    }, function (body) {
      /* What the SERVER says the channels did, not what this page hopes.
         Naming a worker sends TWO notices — the job to them, and the name
         to the customer the approval promised to tell — so the operator is
         told about each separately: one "done" covering both is how a
         handover nobody received gets called a success. The failure
         wording matches the function's, and a failed channel is a call
         somebody owes that has already paged the team. */
      var told = (body && body.notified) || {};
      /* No report at all is its own answer: the function sends this back
         when the notice blew up before any channel ran. Nothing can be
         claimed about delivery or about a page here, so nothing is. */
      if (!Object.keys(told).length) {
        return claim.reference + ' is with ' + name + '. The handover could not be reported — ' +
          'the server said nothing about the channels, so nobody has been told yet. ' +
          'The claim stays assigned and the failure is in the site log.';
      }
      /* Each half of the handover is read on its own: a notice that did
         not go is a call somebody owes, and saying so is the only way the
         operator finds out. A channel that does not exist ('no number',
         'no address') counts as not reached here and is never dressed up. */
      var channels = function (wa, mail) {
        var kept = [];
        var gone = [];
        if (wa === 'sent') kept.push('WhatsApp');
        else gone.push('WhatsApp' + (wa ? ' (' + esc(String(wa)) + ')' : ''));
        if (mail === 'sent') kept.push('email');
        else gone.push('email' + (mail ? ' (' + esc(String(mail)) + ')' : ''));
        return { reached: kept.length > 0, kept: kept.join(' and '), gone: gone.join(', ') };
      };
      var who = channels(told.worker_whatsapp, told.worker_email);
      var customer = channels(told.student_whatsapp, told.student_email);
      var reach = who.reached
        ? 'The job details reached them on ' + who.kept + '.'
        : 'The job details did not reach them at all: ' + who.gone + '.';
      var customerReach = customer.reached
        ? 'The customer has been told who is coming and how to reach them, on ' + customer.kept + '.'
        : 'The customer has NOT been told who is coming: ' + customer.gone + '.';
      return claim.reference + ' is with ' + name + '. ' + reach + ' ' + customerReach +
        (who.reached && customer.reached
          ? ''
          : ' The team has been paged to chase whoever was not reached.');
    });
  }

  function claimProgress() {
    var claim = claimById(clq.selected);
    if (!claim) return claimsNote('Pick a claim from the queue first.');
    clq.note = claimInput('claimProgressNote').trim();
    return claimsAct({ action: 'progress', id: claim.id, status: 'in_progress', note: clq.note },
      function () { return 'Work is marked started on ' + claim.reference + '.'; });
  }

  function claimReportWork() {
    var claim = claimById(clq.selected);
    if (!claim) return claimsNote('Pick a claim from the queue first.');
    clq.actual = claimInput('claimActual').trim();
    clq.parts = claimInput('claimParts');
    clq.evidence = claimInput('claimEvidence');
    clq.note = claimInput('claimReportNote').trim();
    var payload = {
      action: 'report_work', id: claim.id, note: clq.note,
      parts: claimPartsLines(clq.parts), evidence: claimEvidenceLines(clq.evidence)
    };
    if (clq.actual) {
      var kobo = claimMoney(clq.actual);
      if (!kobo) return claimsNote('The actual cost has to be a number of naira, or blank if nothing was paid.');
      payload.actual_kobo = kobo;
    }
    return claimsAct(payload, function (body) {
      return 'Reported. ' + claim.reference + ' is now waiting on the customer' +
        (body.actual_kobo
          ? ', and ' + naira(body.actual_kobo) + ' was posted to the books as an expense and a provider payable'
          : ', with no cost recorded') + '.';
    });
  }

  function claimSettlePayout() {
    var claim = claimById(clq.selected);
    if (!claim) return claimsNote('Pick a claim from the queue first.');
    clq.transferRef = claimInput('claimTransferRef').trim();
    if (clq.transferRef.length < 4) return claimsNote('Enter the real bank or payment-provider transfer reference after confirming the transfer.');
    return claimsAct({ action: 'settle_payout', id: claim.id, provider_transfer_ref: clq.transferRef },
      function (body) {
        return 'Recorded: ' + naira(body.amount_kobo) + ' was transferred to ' + claim.provider_name +
          ' for ' + claim.reference + '. Reference: ' + body.provider_transfer_ref + '. No transfer was initiated here.';
      });
  }

  function claimResolve() {
    var claim = claimById(clq.selected);
    if (!claim) return claimsNote('Pick a claim from the queue first.');
    clq.outcome = claimPick('claimOutcome', clq.outcome);
    clq.resolution = claimInput('claimResolution').trim() || clq.resolution;
    if (clq.resolution.length < 5) {
      return claimsNote('A resolution is a sentence on the record, not a status change.');
    }
    return claimsAct({ action: 'resolve', id: claim.id, outcome: clq.outcome, resolution: clq.resolution },
      function (body) {
        return 'Dispute closed as ' + (CLAIM_STATUS_LABEL[body.status] || body.status) + ' on ' + claim.reference +
          (body.released ? ', and the call-out went back on the pass.' : '.');
      });
  }

  function claimFilter() {
    clq.status = claimInput('claimFilter');
    /* A new question, so the old answer's filter does not ride along. */
    clq.lateOnly = false;
    clq.notice = null;
    return claimsLoad();
  }

  function claimWiden() {
    clq.limit = Math.min(clq.limit + 50, 100);
    clq.lateOnly = false;
    return claimsLoad();
  }

  /* Not a server filter, and the button says so: the page that arrived is
     already ordered by the clock, so "show me the late ones" is a view of
     what is on screen. Asking the database for every late claim would be a
     different promise, and pretending the two are the same is how a filter
     starts lying. */
  function claimLateOnly() {
    clq.lateOnly = !clq.lateOnly;
    renderClaimsPanel();
    return true;
  }

  document.addEventListener('click', function (e) {
    var act = e.target.closest ? e.target.closest('[data-claim-act]') : null;
    if (act && !act.disabled) {
      var what = act.getAttribute('data-claim-act');
      if (what === 'decide') return claimDecide();
      if (what === 'assign') return claimAssign();
      if (what === 'progress') return claimProgress();
      if (what === 'report_work') return claimReportWork();
      if (what === 'settle_payout') return claimSettlePayout();
      if (what === 'resolve') return claimResolve();
      if (what === 'filter') return claimFilter();
      if (what === 'more') return claimWiden();
      if (what === 'late') return claimLateOnly();
      return;
    }
    var pick = e.target.closest ? e.target.closest('[data-claim]') : null;
    if (pick) return claimsSelect(pick.getAttribute('data-claim'));
  });

  /* Exposed for the boot harness, which cannot dispatch a document click:
     it drives the same functions a click would rather than a copy. */
  window.arzuzClaimsRender = renderClaimsPanel;
  window.arzuzClaimsFrame = function (q) { clq.queue = q; clq.error = null; renderClaimsPanel(); };
  window.arzuzClaimsFail = function (message) { clq.queue = null; clq.error = message; renderClaimsPanel(); };
  window.arzuzClaims = {
    load: claimsLoad,
    select: claimsSelect,
    filter: claimFilter,
    widen: claimWiden,
    late: claimLateOnly,
    decide: claimDecide,
    assign: claimAssign,
    progress: claimProgress,
    report: claimReportWork,
    settlePayout: claimSettlePayout,
    resolve: claimResolve,
    state: function () { return clq; }
  };

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

      /* The whole answer to "why is this room checked rarely?" — the score
         the badges above are drawn from, in the open rather than behind a
         hover, plus the list of what is missing from the page. It is the
         scorer's own list (assets/listing-score.js), so acting on it moves
         the <changefreq> the engines are given. */
      var crawl = crawlHintOf(row);
      if (crawl) {
        var editDate = crawl.lastEdit ? new Date(crawl.lastEdit) : null;
        html += kv('Crawl priority',
          '<b>' + esc(crawl.hint.changefreq) + '</b> \u2014 ' + esc(CRAWL_WORDS[crawl.hint.changefreq]) +
          ' (sitemap priority ' + esc(crawl.hint.priority) + ')');
        html += kv('Page completeness', esc(crawl.has + ' of ' + crawl.total + ' facts a student decides with'));
        html += kv('Last edited', esc(editDate && !isNaN(editDate.getTime()) ? fmtDate(crawl.lastEdit) : '\u2014'));
        html += kv('What to fill in',
          crawl.missing.length
            ? crawl.missing.map(function (m) { return '<span class="crawl-missing">' + esc(m) + '</span>'; }).join('')
            : '<span class="crawl-complete">nothing \u2014 the rent, a photo, a pin, the type, the vacancy and a description are all on the page</span>',
          true);
      }
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
  $('btnCloseDossier').addEventListener('click', function () { hide($('dossierModal')); });

  /* ================= The dossier, on paper =================
     The whole reason the dossier exists is a phone call about ONE
     student, and the answer usually has to leave the browser: attached
     to a ticket, or printed and read out to the person on the line.

     window.print() by itself prints the entire dark dashboard behind
     the modal. So the click puts a class on <body> and @media print in
     admin.css narrows the page to the dossier and re-inks it: black on
     white, no chrome, and a provenance line saying what this sheet is
     and that nothing on it can be edited.

     The class is removed on afterprint, with a timeout behind it —
     Safari does not fire afterprint consistently, and a class that
     outlived the dialog would silently clip every later print to the
     modal. */
  var dossierPrintTimer = 0;

  function endDossierPrint() {
    clearTimeout(dossierPrintTimer);
    dossierPrintTimer = 0;
    document.body.classList.remove('printing-dossier');
  }

  $('btnPrintDossier').addEventListener('click', function () {
    var meta = $('dossierPrintMeta');
    if (meta) {
      meta.textContent = 'Arzuz consent record \u2014 ' +
        ($('dossierTitle').textContent || 'Student') + ' \u2014 printed ' +
        new Date().toLocaleString('en-NG') +
        ' \u2014 append-only: no login can change or delete a line on this sheet.';
    }
    document.body.classList.add('printing-dossier');
    window.addEventListener('afterprint', endDossierPrint);
    dossierPrintTimer = setTimeout(endDossierPrint, 30000);
    window.print();
  });
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
        if (!res.ok) throw apiErr(res);
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
    [addModal, editModal, $('detailsModal'), $('dossierModal'), $('digestModal'), delModal, $('photoLightbox'), $('videoLightbox')].forEach(function (m) {
      if (m && m.classList.contains('open')) {
        if (m === $('videoLightbox')) closeVideoLightbox();
        else hide(m);
      }
    });
    if (state.pendingDelete) state.pendingDelete = null;
  });
  [addModal, editModal, $('detailsModal'), $('dossierModal'), $('digestModal'), delModal].forEach(function (m) {
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
      if (!r.ok) throw apiErr(r);
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
      if (!r.ok) throw apiErr(r);
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

  /* ================= 14b. Status code history — "I never got the code" =================

     A student rings the desk with a reference and no message. Before this
     panel the only record of what had been sent to them was a line in a
     Netlify build log, so the honest answer was "ask for another one and
     see" — the same answer whether the first one had been delivered or
     not. Everything here comes back from public.status_history()
     (supabase-status-history.sql §5), which authorizes the login itself:
     the Support Desk and an admin, and nobody else.

     IT WRITES NOTHING, and that is deliberate. A code is never re-sent
     from a dashboard: sending one is the student's own request on /status,
     where the per-reference ceiling and the proof of the contact on file
     are what stand between a leaked reference and somebody's file. A
     button here that could mint a code would be a way round both.

     The words are the panel's, mapped from the machine words the trail
     stores — one place, so a new outage mode cannot reach an officer as a
     bare database string, and an unknown one says so rather than
     pretending to be understood. */

  /* What each outcome MEANS, which is not what it says. `sent` is "the
     sender accepted it", not "the student has it": nothing here can know
     that, and a screen claiming it would be inventing a fact. */
  var CODE_OUTCOMES = {
    sent:        { word: 'accepted by the sender', cls: 'ok' },
    refused:     { word: 'refused', cls: 'bad' },
    unreachable: { word: 'nothing was sent', cls: 'warn' }
  };

  var CODE_NOTES = {
    'openwa-refused':      'the WhatsApp server was asked for this message and refused it',
    'openwa-unreachable':  'the number on the record is not one this site can message',
    'openwa-unconfigured': 'WhatsApp sending is not set up on this deploy',
    'no-mail-on-file':     'there is no email address on the record to fall back to',
    'mail-refused':        'the mail provider was asked for this message and refused it',
    'mail-unconfigured':   'the mail provider is not set up on this deploy',
    'unrecorded':          'the deployment that sent it recorded no reason '
  };

  var CHANNEL_WORD = { whatsapp: 'WhatsApp', email: 'Email' };

  function chWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    /* The clock time for something from today, because that is how it gets
       said out loud on a call ("you asked at 2:07"); the date for anything
       older, because "eight days ago" is not what a person checks. */
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : fmtDate(iso);
  }

  function chAgo(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function chDeliveryHtml(d) {
    var word = CODE_OUTCOMES[d.outcome] || { word: d.outcome, cls: 'warn' };
    var note = d.note ? (CODE_NOTES[d.note] || d.note) : '';
    return '<div class="ch-line">' +
      '<span class="ch-chan" data-ch="' + esc(d.channel) + '">' +
        ico(d.channel === 'email' ? 'mail' : 'whatsapp', 14) + ' ' +
        esc(CHANNEL_WORD[d.channel] || d.channel) + '</span>' +
      '<span class="ch-out ' + word.cls + '">' + esc(word.word) + '</span>' +
      '<span class="ch-when">' + esc(chWhen(d.at)) + '</span>' +
      (note ? '<span class="ch-note">' + esc(note) + '</span>' : '') +
      '</div>';
  }

  function chCodeHtml(c) {
    /* live / used / expired, straight from the row — the panel does not
       work out an expiry for itself, because the database is the thing
       that decides whether a code can still be typed. */
    var state = c.used_at ? { word: 'used', cls: 'ok' }
      : (c.live ? { word: 'still live', cls: 'ok' } : { word: 'expired', cls: 'muted' });
    var trail = toList(c.deliveries);

    return '<div class="ch-code">' +
      '<div class="ch-code-head">' +
        '<b>' + esc(chWhen(c.asked_at)) + '</b>' +
        '<span class="ch-ago">' + esc(chAgo(c.asked_at)) + '</span>' +
        '<span class="ch-state ' + state.cls + '">' + esc(state.word) + '</span>' +
      '</div>' +
      '<div class="ch-meta">' +
        (c.used_at
          ? 'used at ' + esc(chWhen(c.used_at)) + ' — they saw their record'
          : (c.max_attempts
              ? (Number(c.attempts) === 0
                  ? 'no attempt was made — ' + esc(String(c.max_attempts)) + ' are allowed'
                  : Number(c.attempts) + ' of ' + esc(String(c.max_attempts)) +
                    ' attempts used · ' + esc(String(c.attempts_left)) + ' left')
              : '')) +
      '</div>' +
      (trail.length
        ? trail.map(chDeliveryHtml).join('')
        : '<div class="ch-line"><span class="ch-note">Nothing was ever sent for this code — it was issued and no delivery attempt reached us.</span></div>') +
      '</div>';
  }

  /* How the query was READ, in the officer's words. The lookup accepts the
     whole reference, the end of one, the beginning of one, or a phone
     number, so the panel has to say which of those it took — otherwise an
     officer who typed four characters and got an answer cannot tell
     whether the answer is about the reference they meant. */
  var LOOKUP_WORD = {
    ref:   'read as the whole reference',
    tail:  'found by the end of a reference',
    head:  'found by the start of a reference',
    phone: 'found by the phone number on the record'
  };

  function chPickRowHtml(m) {
    var kind = m.kind === 'landlord' ? 'a landlord listing'
      : (m.kind === 'student' ? 'a student registration' : 'no record of it now');
    return '<button type="button" class="ch-pick-row" data-chpick="' + esc(m.ref) + '">' +
      '<b>' + esc(m.ref) + '</b>' +
      '<span class="ch-tag">' + esc(kind) + '</span>' +
      '<span class="ch-when">' + (m.asked_at ? 'handed out ' + esc(chWhen(m.asked_at)) : '') + '</span>' +
      '</button>';
  }

  function chHistoryHtml(h) {
    if (!h || h.ok !== true) {
      return '<div class="codehist-empty">That reference could not be read. ' +
        'If it keeps doing that, send it to the team — it is a fault in the lookup, not in the student\u2019s code.</div>';
    }

    /* TOO SHORT TO MEAN ANYTHING. Not an error and not a "no record": two
       characters of a reference would match hundreds of them, and a bare
       four-digit number could be the tail of one with the letters lost off
       the end. Saying which is missing is more use than an empty answer. */
    if (h.lookup === 'none') {
      return '<div class="codehist-empty">That is too short to look anything up. ' +
        'Type the whole reference, or the last four characters of it, or the phone number the student ' +
        'applied with — a number needs all ten digits, because that is what the site itself matches on.</div>';
    }

    /* MORE THAN ONE REFERENCE COULD BE MEANT — so the panel shows them and
       stops. It deliberately shows NO code history here: everything below
       this point belongs to one reference, and picking the newest would be
       the panel guessing which student is on the phone and then reading
       the wrong history back with complete confidence. */
    if (h.ambiguous) {
      var list = toList(h.matches);
      return '<div class="ch-pick">' +
        '<div class="ch-pick-head">' +
          '<b>' + list.length + (h.more ? '+' : '') + (list.length === 1 ? ' reference matches' : ' references match') + '</b>' +
          '<span class="ch-tag">' + esc(LOOKUP_WORD[h.lookup] || h.lookup) + '</span>' +
        '</div>' +
        '<p class="ch-pick-sub">Ask the student to read the rest of the reference, or pick the one on their ' +
        'confirmation below. Nothing is said about a reference until one is chosen, because only they know which is theirs.</p>' +
        list.map(chPickRowHtml).join('') +
        (h.more ? '<p class="ch-pick-sub">There are more than these ' + list.length +
          ' — read out more of the reference and the list will narrow.</p>' : '') +
        '</div>';
    }

    var codes = toList(h.codes);

    if (!codes.length) {
      /* THE ONE HOLE IN THIS RECORD, said out loud rather than implied.
         Two refusals happen before a code is issued — a deploy with no
         mail provider, and the per-reference ceiling — and neither leaves
         a code, so neither can leave a trail row. An officer who is told
         "nothing was ever asked for" about a student who really did ask
         would go looking for the wrong problem. */
      return '<div class="codehist-empty">' +
        (h.known_reference
          ? 'No code has ever been asked for against that reference. '
          : 'No record of that reference, and no code has ever been asked for against it. ') +
        'A request that was refused BEFORE a code was issued leaves no row here: that is a deploy with ' +
        'no mail provider, or more codes for that reference in the last hour than the page allows.' +
        (h.known_reference ? '' : ' If the student read out a reference and it is not a typo, the record was deleted by hand — reopen their row in Demands.') +
        /* WHAT A BARE RUN OF DIGITS COULD HAVE BEEN INSTEAD. Below ten
           digits a number cannot be one this site can match, so it is read
           as the end of a reference — which is right, and which also means
           a mistyped number lands here looking like a bad reference. Saying
           so is the difference between "they gave me a wrong number" and
           "this panel is broken". */
        (h.lookup === 'tail' && /^[0-9]{7,9}$/.test(String(h.query || ''))
          ? ' That was a run of digits: if it was meant to be a phone number it needs all ten of them, '
            + 'because ten is what the site itself matches a number on.'
          : '') +
        '</div>';
    }

    var kind = h.kind === 'landlord' ? 'a landlord listing' : 'a student registration';
    /* WHAT THE QUERY WAS, echoed — but only when it was part of a REFERENCE.
       A fragment is read back ("found by the end of a reference — 7E3F") so
       the officer can see which of two readings answered. A phone number is
       NOT: it is a contact detail, and the desk's screen should not carry a
       student's number in a tag that a screenshot or a shoulder keeps. The
       resolved reference below is the whole answer either way. */
    var how = LOOKUP_WORD[h.lookup] || '';
    var howText = how && h.lookup !== 'ref'
      ? how + ((h.lookup === 'head' || h.lookup === 'tail') && h.query ? ' \u2014 ' + h.query : '')
      : '';
    return '<div class="ch-head">' +
        '<b>' + esc(h.ref) + '</b>' +
        '<span class="ch-tag">' + esc(kind) + '</span>' +
        (h.known_reference ? '' : '<span class="ch-tag warn">no such record — deleted, or read out wrong</span>') +
        (howText ? '<span class="ch-tag">' + esc(howText) + '</span>' : '') +
        '<span class="ch-tag">' + (Number(h.asked_last_hour) === 1 ? '1 request' : Number(h.asked_last_hour) + ' requests') + ' in the last hour</span>' +
        '<span class="ch-tag">' + (codes.length === 1 ? '1 code' : codes.length + ' codes') + '</span>' +
      '</div>' +
      codes.map(chCodeHtml).join('');
  }

  function renderStatusHistory() {
    var panel = $('statusHistoryPanel');
    if (!panel) return;
    /* The two logins supabase-status-history.sql admits. Drawing the panel
       for anyone else would be a control that teaches the dashboard lies —
       the same rule the verification shift follows. */
    var role = currentRole();
    panel.style.display = (role === 'support' || role === 'admin') ? '' : 'none';
    if (panel.style.display === 'none') return;

    var out = $('chOut');
    if (out && !out.dataset.armed) {
      out.dataset.armed = '1';
      out.innerHTML = '<div class="codehist-empty">No reference looked up yet. It starts with ARZ- and is ' +
        'on the confirmation message the student got when their form was accepted \u2014 but the whole of it is ' +
        'not required: the last four characters will do, and so will the phone number they applied with.</div>';
    }
  }

  function statusHistoryLookup(override) {
    var input = $('chRef');
    var out = $('chOut');
    var btn = $('chLook');
    if (!input || !out) return;

    /* WHAT IS SENT IS WHAT WAS TYPED, trimmed and nothing else. The
       uppercasing, the dash-stripping and the "is this a phone number"
       question all belong to public.status_history(), which does them once;
       a panel that normalised first would be a second rule that has to stay
       in step with the first, and the day they disagree an officer is told
       "no record of that number" about a student who is on the phone. */
    var typed = String(override === undefined ? input.value : override).trim();
    input.value = typed;
    if (!typed) {
      out.innerHTML = '<div class="codehist-empty">Type the reference first — it is the ARZ- string on their ' +
        'confirmation — or the last few characters of it, or the phone number they applied with. ' +
        'Either way this only asks the database, and the database decides.</div>';
      return;
    }

    out.innerHTML = '<div class="codehist-empty">Reading ' + esc(typed) + '\u2026</div>';
    if (window.ArzuzUI && btn) ArzuzUI.setBusy(btn, true, 'Reading\u2026');

    ArzuzAuth.headers().then(function (h) {
      return fetch(apiRoot() + '/rest/v1/rpc/status_history', {
        method: 'POST', headers: h, body: JSON.stringify({ p_query: typed })
      });
    })
      .then(function (r) {
        /* 401 is a stale session — the one read an officer can act on.
           403 stays derived: it is a login outside the desk, which is a
           grant fact rather than something to renew. */
        if (r.status === 401) { onAuthError(new Error('status_history')); throw new Error('Your session has expired — sign in again.'); }
        if (r.status === 403) throw new Error('This login may not read a code history: it is the support desk\u2019s, and an admin\u2019s.');
        if (!r.ok) throw apiErr(r);
        return r.text();
      })
      .then(function (text) {
        var h = null;
        try { h = JSON.parse(text); } catch (e) { h = null; }
        out.innerHTML = chHistoryHtml(h);
      })
      .catch(function (err) {
        out.innerHTML = '<div class="codehist-empty bad">The lookup failed: ' + esc(err.message || err) + '</div>';
      })
      .then(function () { if (window.ArzuzUI && btn) ArzuzUI.setBusy(btn, false); });
  }

  if ($('chLook')) $('chLook').addEventListener('click', function () { statusHistoryLookup(); });
  if ($('chRef')) {
    $('chRef').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); statusHistoryLookup(); }
    });
    /* One clear puts the panel back to its own question. Without it a wrong
       answer stays on the screen until it is replaced by the next lookup,
       which is exactly the wrong way round on a call: the officer is
       looking at somebody's history while asking about somebody else. */
    $('chRef').addEventListener('input', function () {
      if (this.value.trim()) return;
      var o = $('chOut');
      if (o) delete o.dataset.armed;
      renderStatusHistory();
    });
  }

  /* The pick list. Delegated, because the panel is redrawn by innerHTML and
     a listener bound per button would be gone the moment it rendered once.
     Choosing one asks the SAME question again with the whole reference —
     the officer's own click is the narrowing, not a guess by the panel. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-chpick]') : null;
    if (!b) return;
    statusHistoryLookup(b.getAttribute('data-chpick'));
  });

  /* exposed for dev/admin-boot-test.js, which drives the desk the way it
     drives the shift */
  window.renderStatusHistory = renderStatusHistory;
  window.statusHistoryLookup = statusHistoryLookup;

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
        if (!r.ok) throw apiErr(r);
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
        if (!r.ok) throw apiErr(r, data);
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

  /* ------------------------------------------------------------------
     A name for THIS script, and the only thing that proves it ran.

     The dashboard's own boot is this file; every other layer it names is
     reached through a typeof guard, so losing one of them degrades a
     section rather than stopping the page. Losing this file leaves the
     dashboard on its shell with nothing in the console to say why — the
     failure the dev harness has to tell apart from a broken page
     (dev/page-harness-boot.js), and a marker is how the harness asks
     whether the boot ran. It is inert: nothing reads it but the harness.
     ------------------------------------------------------------------ */
  window.ArzuzAdmin = { booted: true, version: 25 };
})();
