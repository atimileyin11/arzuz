/* ============================================================
   Arzuz — the student's own Care page

   Drives my-care.html. The page a student opens from the link they
   were sent when a session was opened.

   THE SECURITY SHAPE OF THIS PAGE

     There is no login and no password: /my-care?t=… is the whole
     credential, the same model as a roommate profile. So this file
     does exactly two things with that link —

       view     read this one plan, its balance and its ledger
       list     read this pass's repair claims, and where each one is
       create   file a repair claim
       confirm  say the work that was reported is actually done
       dispute  say it is not, in words
       cancel   withdraw a claim nothing has happened on yet

     — and NONE of them can move a credit. The balance is never
     computed here: it is the sum the server returned, and the page
     rounds nothing, adds nothing and stores no total of its own. The
     ledger shown below is the server's list, in the server's order,
     and so is every claim status: the page prints the word the
     function sent rather than deciding what stage a repair is at.

     A claim spends a call-out only when the team decides it is
     covered, and that decision is the server's: the page can file,
     confirm, dispute and withdraw, and it cannot approve anything.

     Everything the server sends is text a person typed somewhere —
     a worker's name, a reason, the student's own words — so every
     value that reaches the DOM goes through esc() first.

   STATES

     no link      → how to get one back (nothing is lost)
     unrecognised → the same, said plainly
     switched off → the Care tables do not exist yet (503)
     ready        → balance, ledger, cover, the request form, the link
   ============================================================ */

var ArzuzMyCare = (function () {

  'use strict';

  var API = '/api/care-credit';
  var CLAIMS_API = '/api/claims';
  var TOKEN_KEY = 'arzuz_care_token_v1';

  var state = {
    token: '',
    data: null,      // the server's answer to 'view', untouched
    busy: false,
    sent: null,      // the confirmation after a request goes through
    notice: null,    // the last refusal or validation message
    noticeKind: 'bad',
    claims: null,    // the server's answer to claims 'list', untouched
    claimError: null,// why the repairs section is empty, in the server's words
    claimBusy: false,
    claimSent: null, // the confirmation after a claim action goes through
    claimNotice: null,
    claimDispute: null, // the claim whose "something is wrong" box is open
    claimDay: null // the claim whose "another day" box is open
  };

  /* Where a repair stands, in the words a student reads. The KEY is the
     status the function sent (supabase-claims.sql's vocabulary) — the
     page maps it, it never invents a stage or advances one itself. */
  var CLAIM_STATUS = {
    draft: { said: 'Not filed yet', chip: 'wait' },
    submitted: { said: 'With us \u2014 being checked', chip: 'wait' },
    under_review: { said: 'Under review', chip: 'wait' },
    approved: { said: 'Covered \u2014 a worker is being arranged', chip: 'ok' },
    assigned: { said: 'A worker is on it', chip: 'ok' },
    in_progress: { said: 'Being worked on', chip: 'ok' },
    awaiting_customer: { said: 'Done \u2014 your confirmation, please', chip: 'warn' },
    completed: { said: 'Completed', chip: 'done' },
    rejected: { said: 'Not covered', chip: 'warn' },
    cancelled: { said: 'Withdrawn', chip: 'wait' },
    disputed: { said: 'Disputed \u2014 we are looking again', chip: 'warn' }
  };

  /* Which buttons are worth offering. The SERVER refuses anything it
     does not allow (and says why), so this is only about not showing a
     control that would come straight back. A worker already on the job
     cannot be withdrawn from here — that is a dispute, and the team
     says so.

     Kept as literals rather than derived from CLAIM_STATUS so that a
     status added to the map cannot silently become actionable. */
  /* The statuses in which a day can still be answered: a visit is coming
     while the claim is with a worker (or the work has been reported and the
     customer is being asked about it). A finished or withdrawn claim has no
     visit to move. */
  var CAN_CONFIRM_DAY = ['assigned', 'in_progress', 'awaiting_customer'];
  var CAN_CONFIRM = ['awaiting_customer'];
  var CAN_DISPUTE = ['assigned', 'in_progress', 'awaiting_customer', 'completed'];
  var CAN_WITHDRAW = ['draft', 'submitted', 'under_review', 'approved', 'assigned'];

  function canDo(list, status) { return list.indexOf(status) !== -1; }

  function cfg() { return window.ARZUZ_CONFIG || {}; }
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ngn(n) { return '\u20a6' + Number(n || 0).toLocaleString('en-NG'); }

  /* A number a phone can dial. The server stores worker numbers in the
     234\u2026 form, and a handset wants the international one; anything that
     is not a number at all answers empty rather than a broken link. */
  function telHref(phone) {
    var d = String(phone || '').replace(/[^\d]/g, '');
    if (d.length === 11 && d.charAt(0) === '0') d = '234' + d.slice(1);
    return d.length >= 10 ? 'tel:+' + d : '';
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      return d.toDateString();
    }
  }

  function toast(msg, type) {
    if (typeof ArzuzSubmit !== 'undefined' && ArzuzSubmit.showToast) ArzuzSubmit.showToast(msg, type);
  }

  function waLink(text) {
    var num = String(cfg().SUPPORT_WHATSAPP || '').replace(/[^\d]/g, '');
    if (!num) return '';
    return 'https://wa.me/' + num + '?text=' + encodeURIComponent(text || 'Hi Arzuz — about my Care.');
  }

  /* ------------------------------------------------------------
     the link
     ------------------------------------------------------------ */

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* private mode */ }
  }

  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function tokenFromUrl() {
    var m = /[?&]t=([^&#]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* Prefer the canonical /my-care path, but stay on my-care.html when
     the page is served straight off the filesystem — the dev server
     has no redirect rules and a broken link in a test is noise. */
  function linkFor(token) {
    var path = window.location.pathname.replace(/index\.html$/, '');
    if (!/my-care(\.html)?$/.test(path)) path = '/my-care';
    return window.location.origin + path + '?t=' + encodeURIComponent(token);
  }

  /* ------------------------------------------------------------
     the API — one POST, the same shape the dashboard uses
     ------------------------------------------------------------ */

  /* The site-wide failure vocabulary (assets/api-errors.js), if this page
     loaded it. */
  function E(){ return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }

  function api(action, body) {
    var payload = { action: action };
    Object.keys(body || {}).forEach(function (k) { payload[k] = body[k]; });
    return post(API, payload);
  }

  /* The claims door. Same link, same no-session rule, same failure
     vocabulary — the answer is read back through the shared classifier,
     so a claim the server refuses and a deploy that has no claims table
     yet are told apart by the CLASS the function named, not by the
     digit they share. */
  function claimApi(action, body) {
    var payload = { action: action, token: state.token };
    Object.keys(body || {}).forEach(function (k) { payload[k] = body[k]; });
    return post(CLAIMS_API, payload);
  }

  function post(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        /* A body that is not an object is not an answer from this
           function — an error page, a proxy, a bare null. Normalised so
           the student sees a sentence and not a TypeError. */
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
        if (!r.ok) {
          /* The answer, read back through the shared classifier — the
             server's sentence is preferred (it is the answer to what
             the student just did), and its CLASS rides along, so the
             page branches on the class the function named rather than
             re-deriving one from the number. A 503 that means "not
             switched on in this deploy" and a 503 that means "unwell
             for a minute" are the same digit and different advice. */
          var W = E();
          /* Without the classifier the page still has to know WHICH
             failure it is looking at: a refused link is not an outage,
             and the status is what separates them here. So the fallback
             carries the status and the sentence exactly as the
             classified error does — only the class is missing. */
          if (!W){
            var plain = new Error(data.error || 'Arzuz could not open that just now — that is our side, not yours. ' +
              'Try again in a minute.');
            plain.status = r.status || 0;
            throw plain;
          }
          throw W.failed(r, data);
        }
        return data;
      });
    });
  }

  /* ------------------------------------------------------------
     rendering — pure functions of the server's answer

     Each returns a string, so the page can be painted in one go and
     the harness can read what the student would read.
     ------------------------------------------------------------ */

  var LABELS = {
    granted: 'Session opened',
    spent: 'Call-out',
    refunded: 'Refunded',
    expired: 'Session ended',
    adjusted: 'Correction'
  };

  function statusChip(d) {
    var s = d.plan.status;
    if (s === 'refunded') return '<span class="chip warn">refunded</span>';
    if (s === 'ended') return '<span class="chip warn">session ended</span>';
    return '<span class="chip ok">active</span>';
  }

  function renderBalance(d) {
    var left = Number(d.balance) || 0;
    var total = Number(d.granted) || 0;
    var used = Number(d.call_outs) || 0;
    var goal = Number(d.published && d.published.call_outs_included) || 4;

    var cov = d.coverage || null;
    var headline;
    if (d.plan.status === 'refunded') {
      headline = 'Refunded';
    } else if (d.plan.status === 'ended') {
      headline = 'Session ended';
    } else {
      headline = left + ' of ' + total;
    }

    var html = '<div class="balcard">' +
      '<div class="big"><small>' +
      (d.plan.status === 'active' ? 'Call-outs left this session' : 'This session') +
      '</small>' + esc(headline) + '</div>' +
      '<div class="chips">' +
      '<span class="chip">Session ' + esc(d.plan.session || '\u2014') + '</span>' +
      '<span class="chip">' + esc(used) + ' of ' + esc(total) + ' used</span>' +
      '<span class="chip">' + esc(ngn(d.plan.amount_ngn)) + ' paid</span>' +
      statusChip(d) +
      '</div>';

    /* THE PASS, WHEN IT WAS BOUGHT ONLINE. Both dates and the cap are
       the server's figures, printed as given: this file has no idea how
       long a term is, and must never work one out. */
    if (cov) {
      html += '<div class="chips">' +
        '<span class="chip ok">Coverage ' + esc(when(cov.start)) + ' \u2192 ' + esc(when(cov.end)) + '</span>' +
        (cov.call_out_cap ? '<span class="chip">' + esc(cov.call_out_cap) + ' call-outs included</span>' : '') +
        (cov.receipt_ref ? '<span class="chip">Receipt ' + esc(cov.receipt_ref) + '</span>' : '') +
        '</div>' +
        '<p class="note">Your pass runs from <b>' + esc(when(cov.start)) + '</b> to <b>' + esc(when(cov.end)) +
        '</b>. Everything on the covered list below counts against the call-outs above until that date; ' +
        'after it, the pass is closed. Your receipt reference is with your payment \u2014 keep it to ' +
        'quote if you ever need us.</p>';
    }

    if (d.plan.status === 'refunded') {
      html += '<p class="note">This session was refunded, so its call-outs are closed. A new session can be ' +
        'opened from the <a href="/care">Care page</a>.</p>';
    } else if (d.plan.status === 'ended') {
      html += '<p class="note">This session has ended, so its call-outs are closed. Nothing rolls over — Care ' +
        'for the next session is a fresh ' + esc(ngn(d.published.session_fee_ngn)) + '.</p>';
    } else if (left === 0) {
      html += '<p class="note">All ' + esc(goal) + ' call-outs on this session have been used. Tell us anyway ' +
        'if something is wrong — we will quote you before any work, and it goes on the record for your ' +
        'compound.</p>';
    } else {
      html += '<p class="note">' + esc(left) + ' of the ' + esc(goal) + ' call-outs this session covers ' +
        (left === 1 ? 'is' : 'are') + ' still yours to use. Ask below whenever something needs fixing.</p>';
    }

    return html + '</div>';
  }

  /* One line per event, newest first — a statement reads that way, and
     the display is the server's list reversed, never a running total
     this file worked out. */
  function renderLedger(d) {
    var events = (d.events || []).slice().reverse();
    if (!events.length) {
      return '<div class="led-row next"><div class="what"><b>Nothing recorded yet</b>' +
        '<span>Your first call-out will appear here the day it is made.</span></div></div>';
    }

    return events.map(function (e) {
      var delta = Number(e.delta) || 0;
      var sign = delta > 0 ? '+' : '\u2212';
      var cls = delta > 0 ? 'up' : 'down';
      var detail = [];

      if (e.event === 'spent') {
        if (e.worker) detail.push('Worker: ' + esc(e.worker));
        if (Number(e.parts_ngn) > 0) {
          detail.push('Parts ' + esc(ngn(e.parts_ngn)) +
            (Number(e.parts_ngn) > (Number(d.published && d.published.parts_included_ngn) || 0)
              ? ' — over the included amount, so it was quoted to you first' : ''));
        }
      }
      if (e.reason) detail.push(esc(e.reason));
      if (e.note) detail.push(esc(e.note));

      return '<div class="led-row">' +
        '<div class="when">' + esc(when(e.created_at)) + '</div>' +
        '<div class="what"><b>' + esc(LABELS[e.event] || e.event) + '</b>' +
        (detail.length ? '<span>' + detail.join(' \u00b7 ') + '</span>' : '') +
        '</div>' +
        '<div class="delta ' + cls + '">' + esc(sign + Math.abs(delta)) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderCovered(d) {
    var pub = d.published || {};
    var goal = Number(pub.call_outs_included) || 4;
    var parts = Number(pub.parts_included_ngn) || 3000;

    function li(ok, text) {
      return '<li><span class="ic">' + (ok ? '\u2713' : '\u2717') + '</span><span>' + text + '</span></li>';
    }

    return '<ul class="cov yes">' +
      li(true, 'Bulbs, sockets and switches') +
      li(true, 'Tap washers and small leaks') +
      li(true, 'Blocked sink or basin') +
      li(true, 'Door locks, handles and hinges') +
      li(true, 'Toilet flush and cistern') +
      li(true, 'Up to ' + esc(goal) + ' call-outs per session') +
      li(true, 'A verified worker within 48 hours of asking') +
      li(true, 'Parts under ' + esc(ngn(parts)) + ' included') +
      '</ul>' +
      '<ul class="cov no">' +
      li(false, 'Rewiring, fuse boxes or meters') +
      li(false, 'Roof, ceiling or structural work') +
      li(false, 'Soakaway, septic or main drainage') +
      li(false, 'Boreholes, pumps and tanks') +
      li(false, 'Parts over ' + esc(ngn(parts)) + ' \u2014 we quote you first') +
      li(false, 'Damage you or your guests caused') +
      '</ul>' +
      '<p class="note">The full promise, and its limits, are on the <a href="/care">Care page</a> and in ' +
      '<a href="/terms">our terms</a>. Not covered but broken? Tell us anyway \u2014 it goes into the ' +
      'record for your compound.</p>';
  }

  function noticeHtml() {
    if (state.sent) {
      return '<p class="note good" id="askNote">' + esc(state.sent) + '</p>';
    }
    if (state.notice) {
      return '<p class="note ' + (state.noticeKind === 'bad' ? 'bad' : 'good') + '" id="askNote">' +
        esc(state.notice) + '</p>';
    }
    return '<p class="note" id="askNote">We confirm by WhatsApp, and the visit appears on your record above ' +
      'the day it is made.</p>';
  }

  function renderRequest(d) {
    if (!d.can_request) {
      var why = d.plan.status !== 'active'
        ? 'This session is closed, so there is nothing to send a worker on.'
        : 'All the call-outs this session covers have been used.';
      var wa = waLink('Hi Arzuz \u2014 something needs fixing and I think my Care is finished for this ' +
        'session (session ' + d.plan.session + ').');
      return '<div class="ask"><p class="note">' + esc(why) + ' Something outside the published cover, or ' +
        'another problem? Tell us anyway \u2014 it goes on the record for your compound, and we will quote ' +
        'you before any work.' +
        (wa ? ' <a href="' + esc(wa) + '" target="_blank" rel="noopener">Message us on WhatsApp</a>.' : '') +
        '</p></div>';
    }

    var s = d.student || {};
    return '<div class="ask">' +
      '<div class="fld"><label for="askIssue">What is wrong?</label>' +
      '<textarea id="askIssue" maxlength="400" placeholder="e.g. The kitchen tap will not close and drips all night"></textarea></div>' +
      '<div class="row">' +
      '<div class="fld"><label for="askRoom">Room / apartment (optional)</label>' +
      '<input type="text" id="askRoom" maxlength="60" value="' + esc(s.room || '') + '" placeholder="e.g. B4"></div>' +
      '<div class="fld"><label for="askPhone">Phone a worker can call</label>' +
      '<input type="tel" id="askPhone" maxlength="20" value="' + esc(s.phone || '') + '"></div>' +
      '</div>' +
      '<button type="button" class="btn" id="askSend">Ask for a worker</button>' +
      noticeHtml() +
      '<p class="note">Asking does not use a credit by itself \u2014 the visit does, when it is recorded. ' +
      'Care covers ' + esc(d.published.call_outs_included) + ' call-outs this session and you have ' +
      esc(d.balance) + ' left.</p>' +
      '</div>';
  }

  function renderShare() {
    var link = linkFor(state.token);
    return '<b>This link is your key \u2014 keep it to yourself.</b>' +
      '<span>Anyone who has it can see your balance and ask for a worker on your session, so do not post ' +
      'it in a group or on social media. Opening it again from any device brings you back here.</span>' +
      '<code>' + esc(link) + '</code>' +
      '<button type="button" class="btn quiet" id="careCopy">Copy my link</button> ' +
      '<a class="wa" href="' + esc(waLink('Hi Arzuz \u2014 about my Care (session ' +
        (state.data && state.data.plan ? state.data.plan.session : '') + ').')) + '" target="_blank" ' +
      'rel="noopener">Ask about my Care</a>' +
      '<p class="note">Lost the link? Message us and we will send it again \u2014 your call-outs stay on ' +
      'your session either way.</p>';
  }

  /* ------------------------------------------------------------
     the repairs — file a claim, and follow the ones already filed

     Every rule here is the server's: filing costs nothing, a call-out
     is spent only when the team says a fault is covered, and only the
     team can say so. This section prints what came back.
     ------------------------------------------------------------ */

  function claimNote() {
    if (state.claimSent) return '<p class="note good" id="claimNote">' + esc(state.claimSent) + '</p>';
    if (state.claimNotice) return '<p class="note bad" id="claimNote">' + esc(state.claimNotice) + '</p>';
    return '<p class="note" id="claimNote">Filing costs nothing. A call-out is spent only when we say the ' +
      'fault is covered \u2014 and if it is not, the answer says why.</p>';
  }

  function renderClaimForm(c) {
    var plan = (c && c.plan) || {};
    var wa = waLink('Hi Arzuz \u2014 about a repair on my Care (session ' + (plan.session || '') + ').');

    /* The pass is the only thing that can be claimed against, so a pass
       that is not active is told plainly rather than offered a form
       that would be refused. */
    if (plan.status && plan.status !== 'active') {
      return '<div class="ask"><p class="note">This pass is ' +
        (plan.status === 'refunded' ? 'refunded, so there is nothing to claim on it.' : 'closed, so its coverage has ended.') +
        ' A fault you think started before then is still worth telling us about' +
        (wa ? ' \u2014 <a href="' + esc(wa) + '" target="_blank" rel="noopener">message us on WhatsApp</a>' : '') +
        '.</p></div>';
    }

    var s = (state.data && state.data.student) || {};
    var left = state.data ? Number(state.data.balance) : null;

    return '<div class="ask">' +
      '<div class="fld"><label for="claimIssue">What is broken?</label>' +
      '<textarea id="claimIssue" maxlength="400" placeholder="e.g. The kitchen tap will not close and drips all night"></textarea></div>' +
      '<div class="row">' +
      '<div class="fld"><label for="claimRoom">Room / apartment (optional)</label>' +
      '<input type="text" id="claimRoom" maxlength="60" value="' + esc(s.room || '') + '" placeholder="e.g. B4"></div>' +
      '<div class="fld"><label for="claimPhone">Phone a worker can call</label>' +
      '<input type="tel" id="claimPhone" maxlength="20" value="' + esc(s.phone || '') + '"></div>' +
      '</div>' +
      '<div class="fld"><label for="claimPhoto">A photo link (optional)</label>' +
      '<input type="url" id="claimPhoto" maxlength="300" placeholder="https://\u2026"></div>' +
      '<button type="button" class="btn" id="claimFile">File this repair</button>' +
      claimNote() +
      '<p class="note">We answer in words either way \u2014 covered, or not covered and why. ' +
      (left === null ? '' : esc(left) + ' of this session\u2019s call-outs are still yours.</p>') +
      '</div>';
  }

  function renderClaim(row, i) {
    var meta = CLAIM_STATUS[row.status] || { said: row.status, chip: 'wait' };
    var html = '<div class="claim" data-claim="' + esc(row.reference) + '">' +
      '<div class="top"><span class="ref">' + esc(row.reference) + '</span>' +
      '<span class="chip ' + esc(meta.chip) + '">' + esc(meta.said) + '</span>' +
      '<span class="ref">filed ' + esc(when(row.created_at)) + '</span>' +
      (row.call_out_no ? '<span class="ref">call-out ' + esc(row.call_out_no) + '</span>' : '') +
      '</div>' +
      '<div class="said">' + esc(row.issue) + '</div>';

    /* The decision, once there is one. A claim still being checked has
       no eligibility yet, and a page that printed "covered" before the
       team said so would be the page deciding. */
    if (row.eligibility_reason && row.eligibility) {
      html += '<div class="ans"><b>' + (row.eligibility === 'not_covered' ? 'Not covered' : 'Covered') +
        ':</b> ' + esc(row.eligibility_reason) + '</div>';
    }
    /* WHO IS COMING, AND HOW TO REACH THEM. The approval message that
       promised a name also promised this page would carry the record, so
       the page stands on its own without it: the number is here and
       tappable, because the two people who have to agree a time are the
       two people who have to reach each other. Whether they have said
       yes is the server's fact too \u2014 `worker_confirmed` \u2014 and a worker
       who has not answered yet is not dressed up as one who has. */
    if (row.provider_name) {
      var tel = telHref(row.provider_phone);
      /* WHEN THEY SAID THEY CAN COME, in their own words. A worker handed a
         job often answers with a time instead of a yes — "I can do
         Saturday morning" — and until this line the customer was told a
         worker is coming with no idea when.

         Quoted, never computed: turning "tomorrow morning" into a date
         means guessing a timezone and which morning, and printing the
         guess as an APPOINTMENT somebody might rearrange their day
         around. And the chip is one or the other, because a suggested day
         is not an agreement: "suggested a time" says exactly what
         happened. */
      var day = String(row.provider_proposal || '').trim();
      html += '<div class="ans"><b>Worker:</b> ' + esc(row.provider_name) +
        (row.provider_phone
          ? ' \u00b7 ' + (tel
            ? '<a href="' + esc(tel) + '">' + esc(row.provider_phone) + '</a>'
            : esc(row.provider_phone))
          : ' <span class="ref">no number on file \u2014 message us and we will pass one on</span>') +
        (row.worker_confirmed
          ? ' <span class="chip ok">confirmed the job</span>'
          : (day ? ' <span class="chip wait">suggested a time</span>' : '')) +
        '</div>';
      var agreed = !!row.day_agreed_at;
      var asked = String(row.customer_proposal || '').trim();
      if (day) {
        html += '<div class="ans"><b>They said they can come:</b> ' + esc(day) +
          (agreed
            ? ' <span class="chip ok">agreed with you</span>'
            : ' <span class="ref">their words, not a booking</span>') +
          '</div>';
      }
      /* AND WHAT THE CUSTOMER SAID BACK. A day the customer asked for is
         theirs, and it stays on their page after they send it: a form that
         swallows what somebody typed and answers nothing is how a person
         ends up not knowing whether the message went. */
      if (asked) {
        html += '<div class="ans"><b>You suggested:</b> ' + esc(asked) +
          ' <span class="ref">we passed this to the worker</span></div>';
      }
      /* The sentence underneath says which of the FOUR states this is:
         agreed, a day of their own already sent, a suggestion nobody has
         agreed to, or nothing yet. A customer who has agreed a day is not
         waiting on a call about the time — they are waiting on somebody to
         knock; and a customer who has just sent a day must not be told to
         send one, because that reads as their message having gone nowhere. */
      var dayNote = 'They will call you to arrange a time. ';
      if (day) {
        if (agreed) {
          dayNote = 'You agreed this day and we have told the worker, so that is when to expect them. ';
        } else if (asked) {
          dayNote = 'You have sent them a day that suits you, and it went to them with your number, ' +
            'so they will ring you to settle the exact time. ';
        } else {
          dayNote = (row.worker_confirmed
            ? 'They have confirmed the job, and that is the day they gave us. '
            : 'That is what they told us. ') +
            'Nobody here has agreed a booking with them, so they may ring to settle the exact time \u2014 '
            + 'and if the day does not suit you, tell us one that does and we will pass it on. ';
        }
      }
      html += '<p class="note">' + dayNote +
        'If you need them before that, ' +
        (tel ? 'ring the number above' : 'message us on WhatsApp and we will pass it on') +
        '. If nobody has come, or the work is not right, tell us from this page \u2014 it goes on ' +
        'the record and a person reads it.</p>';
    }
    if (row.actual_kobo !== null && row.actual_kobo !== undefined) {
      html += '<div class="ans"><b>The work cost:</b> ' + esc(ngn(Number(row.actual_kobo) / 100)) +
        ' \u2014 the figure the team recorded</div>';
    }
    if (row.dispute_reason) {
      html += '<div class="ans"><b>You told us:</b> ' + esc(row.dispute_reason) + '</div>';
    }
    if (row.resolution) {
      html += '<div class="ans"><b>How it ended:</b> ' + esc(row.resolution) + '</div>';
    }

    /* The server keeps only https links; this is the second gate rather
       than the only one, so a stored row that somehow carries something
       else cannot become a link the student clicks. */
    var shots = (row.photos || []).filter(function (u) { return /^https:\/\//i.test(String(u)); });
    if (shots.length) {
      html += '<div class="shots">' + shots.map(function (u, n) {
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener">Photo ' + (n + 1) + '</a>';
      }).join('') + '</div>';
    }

    var acts = [];
    /* THE DAY, ANSWERED IN ONE TAP. This is the customer's half of the
       conversation the worker started, and it is the only control here
       that exists because of somebody else's message: without it the
       answer is a phone call to the office, or nothing at all and a worker
       at a gate nobody opens. */
    var liveDay = String(row.provider_proposal || '').trim() && row.provider_name;
    if (liveDay && !row.day_agreed_at && canDo(CAN_CONFIRM_DAY, row.status)) {
      acts.push('<button type="button" class="btn" id="claimDayYes-' + i +
        '">Yes \u2014 that day works</button>');
      acts.push('<button type="button" class="btn quiet" id="claimDayOther-' + i +
        '">Ask for another day</button>');
    }
    if (canDo(CAN_CONFIRM, row.status)) {
      acts.push('<button type="button" class="btn" id="claimConfirm-' + i +
        '">Yes \u2014 it is fixed</button>');
    }
    if (canDo(CAN_DISPUTE, row.status)) {
      acts.push('<button type="button" class="btn quiet" id="claimDispute-' + i +
        '">Something is still wrong</button>');
    }
    if (canDo(CAN_WITHDRAW, row.status)) {
      acts.push('<button type="button" class="btn quiet" id="claimCancel-' + i +
        '">Withdraw this claim</button>');
    }
    if (acts.length) {
      html += '<div class="acts">' + acts.join('') +
        '<span class="ref" id="claimNote-' + i + '"></span></div>';
    }

    if (state.claimDay === row.id) {
      html += '<div class="ask" style="margin-top:10px">' +
        '<div class="fld"><label for="claimDayWhen">When would suit you?</label>' +
        '<textarea id="claimDayWhen" maxlength="200" placeholder="e.g. Not Saturday \u2014 Sunday afternoon after 2"></textarea></div>' +
        '<button type="button" class="btn" id="claimDaySend">Send it to the worker</button> ' +
        '<button type="button" class="btn quiet" id="claimDayDrop">Never mind</button>' +
        '<p class="note" id="claimDayNote">A day in your own words is passed straight to the worker, ' +
        'who will ring you to settle the exact time. Say when you can be in \u2014 that is all they ' +
        'need.</p>' +
        '</div>';
    }

    if (state.claimDispute === row.id) {
      html += '<div class="ask" style="margin-top:10px">' +
        '<div class="fld"><label for="claimDisputeReason">What is wrong with the work?</label>' +
        '<textarea id="claimDisputeReason" maxlength="400" placeholder="e.g. The drip came back the next morning"></textarea></div>' +
        '<button type="button" class="btn" id="claimDisputeSend">Send it to the team</button> ' +
        '<button type="button" class="btn quiet" id="claimDisputeDrop">Never mind</button>' +
        '<p class="note" id="claimDisputeNote">A dispute goes to a person, and the call-out stays spent ' +
        'until they decide \u2014 if the work was not done properly it comes back to your session.</p>' +
        '</div>';
    }

    return html + '</div>';
  }

  function renderClaims() {
    if (state.claimError) {
      return '<div class="ask"><p class="note bad">' + esc(state.claimError) + '</p></div>';
    }
    if (!state.claims) {
      return '<div class="ask"><p class="note">Reading your repairs\u2026</p></div>';
    }

    var rows = state.claims.claims || [];
    var html = renderClaimForm(state.claims);
    if (!rows.length) {
      return html + '<div class="led-row next"><div class="what"><b>Nothing filed yet</b>' +
        '<span>When you file a repair it appears here with our answer, so nothing rests on a phone call.</span>' +
        '</div></div>';
    }
    return html + rows.map(renderClaim).join('');
  }

  /* ------------------------------------------------------------
     doing something about a repair
     ------------------------------------------------------------ */

  function fieldValue(id) {
    var el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  /* A validation message or a refusal is written into the note that is
     already on screen rather than repainting the section: repainting
     would throw away what the student just typed, which is the one
     thing a refusal must not do. */
  function claimSay(msg, kind) {
    state.claimNotice = msg;
    state.claimSent = null;
    /* The open dispute box is where a refusal about a dispute belongs;
       otherwise it goes in the filed-repair form's own note. */
    var el = $('claimDayWhen') ? $('claimDayNote')
      : $('claimDisputeReason') ? $('claimDisputeNote') : $('claimNote');
    if (el) {
      el.className = 'note ' + (kind === 'good' ? 'good' : 'bad');
      el.innerHTML = esc(msg);
    }
    return Promise.resolve(null);
  }

  function claimFile() {
    if (!state.claims || state.claimBusy) return Promise.resolve(null);

    var issue = fieldValue('claimIssue');
    var room = fieldValue('claimRoom');
    var phone = fieldValue('claimPhone');
    var photo = fieldValue('claimPhoto');

    state.claimSent = null;
    if (issue.length < 5) return claimSay('Tell us what is broken \u2014 a sentence is enough.');
    if (photo && !/^https:\/\//i.test(photo)) {
      return claimSay('A photo link has to start with https:// \u2014 or leave it blank.');
    }

    state.claimBusy = true;
    var btn = $('claimFile');
    if (btn) { btn.disabled = true; btn.textContent = 'Filing\u2026'; }

    var body = { issue: issue, room: room, phone: phone };
    if (photo) body.photos = [photo];

    return claimApi('create', body)
      .then(function (res) {
        var ref = (res && res.claim && res.claim.reference) || '';
        state.claimSent = 'Filed' + (ref ? ' as ' + ref : '') +
          '. We decide within 48 hours and write the answer on this page.';
        state.claimNotice = null;
        toast('Repair filed.', 'success');
        return refresh().then(function () { return res; });
      })
      .catch(function (err) {
        return claimSay(err.message);
      })
      .then(function (out) {
        state.claimBusy = false;
        return out;
      });
  }

  function claimAct(kind, id) {
    if (state.claimBusy) return Promise.resolve(null);

    var body = { id: id };
    if (kind === 'dispute') {
      var reason = fieldValue('claimDisputeReason');
      if (reason.length < 5) return claimSay('Say what is wrong with the work \u2014 a sentence is enough.');
      body.reason = reason;
    }
    /* The server's rules, repeated only so the student is told before a
       round trip about a day they have not written yet. */
    if (kind === 'propose_day') {
      var when = fieldValue('claimDayWhen');
      if (when.length < 5) return claimSay('Say when would suit you \u2014 a day and a part of the day is enough.');
      body.when = when;
    }

    state.claimBusy = true;
    state.claimSent = null;

    return claimApi(kind, body)
      .then(function (res) {
        var said = {
          confirm: 'Thank you \u2014 the claim is closed and your call-out stays spent.',
          dispute: 'Thank you. Someone will look at it again and the answer goes on this page.',
          cancel: 'Withdrawn.' + (res && res.released ? ' The call-out went back to your session.' : ''),
          agree_day: 'Agreed \u2014 the worker has been told that day works, so that is when to expect '
            + 'them. If anything changes, tell us here.',
          propose_day: 'Sent to the worker, and it stays on this page. They will ring you to settle '
            + 'the exact time.'
        }[kind] || 'Done.';
        state.claimSent = said;
        state.claimNotice = null;
        state.claimDispute = null;
        state.claimDay = null;
        toast('Updated.', 'success');
        return refresh().then(function () { return res; });
      })
      .catch(function (err) { return claimSay(err.message); })
      .then(function (out) {
        state.claimBusy = false;
        return out;
      });
  }

  function bindClaims() {
    var rows = (state.claims && state.claims.claims) || [];

    rows.forEach(function (row, i) {
      bindOnce('claimConfirm-' + i, function () { claimAct('confirm', row.id); });
      bindOnce('claimDispute-' + i, function () {
        /* The box opens on this page rather than in a prompt: the reason
           is part of the record, and a prompt is not a form. */
        state.claimDispute = row.id;
        state.claimDay = null;
        state.claimNotice = null;
        state.claimSent = null;
        paintClaims();
      });
      bindOnce('claimCancel-' + i, function () { claimAct('cancel', row.id); });
      bindOnce('claimDayYes-' + i, function () { claimAct('agree_day', row.id); });
      bindOnce('claimDayOther-' + i, function () {
        /* The box opens on this page rather than in a prompt: what they
           write is passed to a person, and a prompt is not a form. */
        state.claimDay = row.id;
        state.claimDispute = null;
        state.claimNotice = null;
        state.claimSent = null;
        paintClaims();
      });
    });

    bindOnce('claimDaySend', function () { claimAct('propose_day', state.claimDay); });
    bindOnce('claimDayDrop', function () {
      state.claimDay = null;
      state.claimNotice = null;
      paintClaims();
    });

    bindOnce('claimDisputeSend', function () { claimAct('dispute', state.claimDispute); });
    bindOnce('claimDisputeDrop', function () {
      state.claimDispute = null;
      state.claimNotice = null;
      paintClaims();
    });
    bindOnce('claimFile', claimFile);
  }

  /* One binding per element, so a repaint cannot double-send a claim. */
  function bindOnce(id, fn) {
    var el = $(id);
    if (el && !el._claimBound) {
      el._claimBound = true;
      el.addEventListener('click', fn);
    }
  }

  /* ------------------------------------------------------------
     painting
     ------------------------------------------------------------ */

  function show(id, on) {
    var el = $(id);
    if (el) el.style.display = on ? '' : 'none';
  }

  function setHtml(id, html) {
    var el = $(id);
    if (el) el.innerHTML = html;
  }

  /* The repairs section on its own — used when the dispute box opens or
     closes, so the words already typed into the form beside it are not
     thrown away by a full repaint. */
  function paintClaims() {
    setHtml('careClaims', renderClaims());
    bindClaims();
  }

  function paint() {
    if (!state.data) {
      show('careLoading', false);
      show('careAccount', false);
      show('careGone', !state.token);
      show('careDown', !!state.token && !state.data);
      return;
    }
    show('careLoading', false);
    show('careGone', false);
    show('careDown', false);
    show('careAccount', true);
    setHtml('careBalance', renderBalance(state.data));
    setHtml('careLedger', renderLedger(state.data));
    setHtml('careCover', renderCovered(state.data));
    setHtml('careRequest', renderRequest(state.data));
    setHtml('careShare', renderShare());
    bindAsk();
    paintClaims();
  }

  function bindAsk() {
    var btn = $('askSend');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', function () { send(); });
    }
    var copy = $('careCopy');
    if (copy && !copy._bound) {
      copy._bound = true;
      copy.addEventListener('click', function () {
        try {
          navigator.clipboard.writeText(linkFor(state.token));
          toast('Link copied.', 'success');
        } catch (e) {
          toast('Copy it from the box above.', 'info');
        }
      });
    }
  }

  /* ------------------------------------------------------------
     loading and asking
     ------------------------------------------------------------ */

  function down(title, body) {
    state.data = null;
    show('careLoading', false);
    show('careAccount', false);
    show('careGone', false);
    show('careDown', true);
    setHtml('careDownTitle', esc(title));
    setHtml('careDownBody', esc(body));
  }

  /* The pass, on its own. Kept separate from load() so that a claim
     action can re-read both without re-reading either one twice. */
  function loadPlan() {
    return api('view', { token: state.token }).then(function (data) {
      state.data = data;
      state.notice = null;
      state.noticeKind = 'bad';
      return data;
    }).catch(function (err) {
      /* A refused link is not an outage, and an outage is not a refused
         link — the student is told which one they are looking at.

         The 404 has to be OUR 404 to count. A route that does not
         exist answers 404 too (a function that was never deployed,
         a proxy, a stale platform), and its body is not our JSON —
         so clearing the link on that would delete the student's only
         key because the site was mid-deploy.

         The CLASS is the contract and is read first: care-credit
         stamps its own 404 `rejected` (a link it will never
         recognise), while a route that is not in this deploy derives
         `not-ready` from the same digit. The sentence stays as the
         second signal, so a deploy still serving the older body — or
         a page that never loaded the classifier — behaves exactly as
         it did. Wording may be edited; the class may not. */
      const refused = err.kind === 'rejected' || /do not recognise/i.test(err.message || '');
      const linkRefused = err.status === 404 && refused;
      if (linkRefused) {
        clearToken();
        state.token = '';
        state.data = null;
        show('careLoading', false);
        show('careAccount', false);
        show('careDown', false);
        show('careGone', true);
      } else if (err.kind ? err.kind === 'not-ready' : err.status === 503) {
        /* A 503 is two different facts wearing one number: this deploy
           has no Care yet, or this deploy is briefly unwell. Only the
           function knows which, and it says so — so the branch that
           claims "not switched on" is the named class, not the digit. */
        down('Care is not switched on for this site yet.', err.message);
      } else {
        down('We could not open your Care account.', err.message);
      }
      return null;
    });
  }

  /* The pass and its repairs are two answers to the same link, so they
     are read together: a page showing a balance without the claims
     below it would look as though a repair had gone missing. */
  function load() {
    if (!state.token) { paint(); return Promise.resolve(null); }
    return Promise.all([loadPlan(), loadClaims()]).then(function (out) {
      paint();
      return out[0];
    });
  }

  /* A repair list that cannot be read must not take the page down: the
     balance and the record above it are still true, so the section says
     what it cannot do, in the server's words. */
  function loadClaims() {
    if (!state.token) return Promise.resolve(null);
    return claimApi('list').then(function (data) {
      state.claims = data;
      state.claimError = null;
      return data;
    }).catch(function (err) {
      state.claims = null;
      state.claimError = err.message;
      return null;
    });
  }

  /* After anything that moves a claim: the balance may have moved with
     it, so both halves are re-read rather than patched locally. */
  function refresh() { return load(); }

  /* The form's rules are the server's rules, repeated only so the
     student is told before a round trip. The server decides. */
  function send() {
    if (!state.data || state.busy) return Promise.resolve(null);
    var issueEl = $('askIssue'), roomEl = $('askRoom'), phoneEl = $('askPhone');
    var issue = issueEl ? String(issueEl.value || '').trim() : '';
    var room = roomEl ? String(roomEl.value || '').trim() : '';
    var phone = phoneEl ? String(phoneEl.value || '').trim() : '';

    state.sent = null;
    if (issue.length < 5) {
      state.notice = 'Tell us what is broken — a sentence is enough.';
      state.noticeKind = 'bad';
      setHtml('careRequest', renderRequest(state.data));
      bindAsk();
      return Promise.resolve(null);
    }

    state.busy = true;
    var btn = $('askSend');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }

    return api('request', { token: state.token, issue: issue, room: room, phone: phone })
      .then(function (res) {
        state.sent = res.message || 'Logged. We will be in touch.';
        state.notice = null;
        toast('Request logged.', 'success');
        return load().then(function () { return res; });
      })
      .catch(function (err) {
        state.notice = err.message;
        state.noticeKind = 'bad';
        setHtml('careRequest', renderRequest(state.data));
        bindAsk();
        return null;
      })
      .then(function (out) {
        state.busy = false;
        return out;
      });
  }

  function boot() {
    var fromUrl = tokenFromUrl();
    if (fromUrl) {
      state.token = fromUrl;
      setToken(fromUrl);
    } else {
      state.token = readToken();
    }
    if (!state.token) { paint(); return Promise.resolve(null); }
    return load();
  }

  if (typeof document !== 'undefined' && document.getElementById('careAccount')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { boot(); });
    } else {
      boot();
    }
  }

  return {
    boot: boot,
    load: load,
    paint: paint,
    send: send,
    state: function () { return state; },
    readToken: readToken,
    setToken: setToken,
    clearToken: clearToken,
    tokenFromUrl: tokenFromUrl,
    linkFor: linkFor,
    renderBalance: renderBalance,
    renderLedger: renderLedger,
    renderCovered: renderCovered,
    renderRequest: renderRequest,
    renderShare: renderShare,
    renderClaims: renderClaims,
    renderClaim: renderClaim,
    esc: esc,
    api: api,
    claimApi: claimApi,
    loadClaims: loadClaims,
    claimFile: claimFile,
    claimAct: claimAct,
    CLAIM_STATUS: CLAIM_STATUS,
    LABELS: LABELS
  };
})();
