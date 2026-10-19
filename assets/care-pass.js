/* ============================================================
   Arzuz — buying a Care Pass

   Drives care-pass.html. This is the one page on the site where a
   customer hands over money, so it is deliberately thin:

     THE PAGE DECIDES NOTHING ABOUT MONEY.

     The price, the coverage window, the call-out cap and the receipt
     are read from /api/finance and printed. The page has no price of
     its own, computes no dates, and sends no amount — the order it
     asks for carries the student's own details and an idempotency
     uuid, and the server prices it from the terms in force.

     A REDIRECT IS NOT A PAYMENT. Coming back from the provider with
     ?reference=… proves nothing, so the page asks the server, the
     server asks the provider, and only that answer activates anything.

     THE LINK IS THE KEY. A pass is opened with a private token, and
     the server hands it to the browser that paid — proved by the
     client_ref IT generated, never by a reference that travels in a
     URL. When the server does not hand one over, the page says so
     instead of inventing one.

   It lives on the public site (indexable, with a canonical), so it has
   to make sense to a reader: the states below are written as sentences
   a person would say, and every failure says who it is about.

     phases
       loading    reading the terms
       off        not on sale / payments not switched on (no retry)
       ready      terms on screen, nothing bought yet
       paying     opening the provider's checkout
       verifying  back from the provider, asking the server
       active     a pass, its dates, its cap and its receipt
       pending    NOT paid (or not yet settled) — coverage is NOT open
       failed     the attempt was declined — nothing was opened
       mismatch   the provider took an amount that is not this order
       opening    paid, but the team is opening the pass by hand
       error      we could not reach the server
   ============================================================ */

var ArzuzCarePass = (function () {

  'use strict';

  var API = '/api/finance';

  /* The capability the buying browser keeps: the uuid it generated for
     this order. Reused on every retry so a double tap, a reload and a
     second attempt can only ever be ONE order. */
  var CLIENT_KEY = 'arzuz_pass_client_ref_v1';
  var ORDER_KEY = 'arzuz_pass_order_v1';
  /* The same key my-care.js reads — a pass opened on this device is the
     same pass, and the link the server hands over must work there. */
  var TOKEN_KEY = 'arzuz_care_token_v1';

  var state = {
    phase: 'loading',
    terms: null,
    termsVersion: null,
    termsHash: '',
    accepted: false,
    notice: null,
    noticeKind: 'bad',
    order: null,      // the server's answer to 'order' (quantity of truth only)
    pass: null,       // the coverage block the server reported
    receipt: null,
    lookupRef: '',
    lookup: null,     // the server's answer to 'status'
    lookupBusy: false,
    lookupError: null,
    reference: '',
    linkToken: '',
    busy: false,
    lastSent: null    // exactly what the last request carried — asserted by the suite
  };

  function cfg() { return window.ARZUZ_CONFIG || {}; }
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Kobo in, naira out — the ONE piece of arithmetic on the page, and
     it is lossless: the server stores integer kobo. */
  function naira(koboValue) {
    var n = Number(koboValue);
    if (!isFinite(n)) return '';
    return '\u20a6' + Math.round(n / 100).toLocaleString('en-NG');
  }

  function day(iso) {
    if (!iso) return '';
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
    return 'https://wa.me/' + num + '?text=' + encodeURIComponent(text || 'Hi Arzuz — about my Care Pass.');
  }

  function E() { return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }

  function setHtml(id, html) {
    var el = $(id);
    if (el) el.innerHTML = html;
  }

  /* ------------------------------------------------------------
     what this browser already holds
     ------------------------------------------------------------ */

  function read(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function newUuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    var hex = [];
    for (var j = 0; j < 16; j++) hex.push((b[j] + 256).toString(16).slice(1));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') +
      '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
  }

  /* One uuid per pass, kept until a pass exists. A retry reuses it, so
     the server replays the same order instead of raising a second one. */
  function clientRef() {
    var mine = read(CLIENT_KEY);
    if (!/^[0-9a-fA-F-]{36}$/.test(mine)) {
      mine = newUuid();
      write(CLIENT_KEY, mine);
    }
    return mine;
  }

  function pendingOrder() {
    try { return JSON.parse(read(ORDER_KEY) || 'null'); } catch (e) { return null; }
  }

  function rememberOrder(reference, order) {
    write(ORDER_KEY, JSON.stringify({ reference: reference, at: new Date().toISOString(), order: order }));
  }

  function forgetOrder() { drop(ORDER_KEY); drop(CLIENT_KEY); }

  function referenceFromUrl() {
    var m = /[?&](?:reference|trxref)=([^&#]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]).trim() : '';
  }

  /* ------------------------------------------------------------
     the API — one POST, the same shape the rest of the site uses
     ------------------------------------------------------------ */

  function api(action, body) {
    var payload = { action: action };
    Object.keys(body || {}).forEach(function (k) { payload[k] = body[k]; });
    state.lastSent = payload;

    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
        if (!r.ok) {
          var W = E();
          if (!W) {
            var plain = new Error(data.error || 'Arzuz could not take that just now — that is our side, not yours.');
            plain.status = r.status || 0;
            plain.body = data;
            throw plain;
          }
          throw W.failed(r, data);
        }
        data.status = data.status !== undefined ? data.status : r.status;
        return data;
      });
    }).catch(function (err) {
      /* A request that never arrived is not an answer from the server.
         Read it through the same vocabulary, so the page says something
         about the connection instead of printing a TypeError at the
         customer. */
      if (err && (err.kind || err.status)) throw err;
      var W = E();
      if (W) throw W.failed({ status: 0 }, {});
      throw err;
    });
  }

  /* ------------------------------------------------------------
     what the student typed
     ------------------------------------------------------------ */

  function field(id) {
    var el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function form() {
    return {
      name: field('cpName'),
      phone: field('cpPhone'),
      email: field('cpEmail'),
      area: field('cpArea'),
      property: field('cpProperty'),
      room: field('cpRoom'),
      referral_code: field('cpReferral')
    };
  }

  /* The server's rules, said here only so nobody waits for a round trip
     to be told. The server still decides. */
  function problemWith(f) {
    if (f.name.length < 2) return 'We need the name the pass should be in.';
    var digits = f.phone.replace(/[^\d]/g, '');
    if (!/^(0\d{10}|234\d{10}|234\d{9,10})$/.test(digits)) {
      return 'Enter a Nigerian mobile number — 08031112233 or +2348031112233.';
    }
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) {
      return 'That email does not look right — leave it blank if you would rather not give one.';
    }
    return null;
  }

  /* ------------------------------------------------------------
     rendering — the server's answer, printed
     ------------------------------------------------------------ */

  function header(version, hash) {
    return '<p class="termsline">Coverage terms <b>v' + esc(version) + '</b>' +
      (hash ? ' \u00b7 ' + esc(String(hash).slice(0, 12)) + '\u2026' : '') +
      ' \u2014 the exact version you are accepting is recorded against your receipt.</p>';
  }

  function list(items, mark, cls) {
    var rows = (items || []).map(function (t) {
      return '<li><span class="ic">' + mark + '</span><span>' + esc(t) + '</span></li>';
    }).join('');
    return '<ul class="cov ' + cls + '">' + rows + '</ul>';
  }

  function renderLoading() {
    return '<div class="statebox" id="cpLoading"><b>Reading the current Care Pass terms\u2026</b>' +
      '<span>What you are about to read is the wording Arzuz has actually approved, fetched from the ' +
      'books \u2014 not a copy typed onto this page.</span></div>';
  }

  function renderNotice() {
    if (!state.notice) return '';
    return '<p class="note ' + (state.noticeKind === 'good' ? 'good' : 'bad') + '" id="cpNotice">' +
      esc(state.notice) + '</p>';
  }

  function renderOff() {
    return '<div class="statebox" id="cpOff"><b>The Care Pass is not on sale at this moment.</b>' +
      '<span>' + esc(state.notice || 'Arzuz is still approving the coverage terms. Nothing is wrong on your side — ' +
        'check back shortly, or message us and we will tell you the day it opens.') + '</span>' +
      supportLine('Ask about the Care Pass') + '</div>';
  }

  function supportLine(text) {
    var wa = waLink(text);
    if (!wa) return '';
    return '<p class="note"><a class="wa" href="' + esc(wa) + '" rel="noopener">Message us on WhatsApp</a></p>';
  }

  function renderTerms() {
    var t = state.terms || {};
    var price = naira(t.price_kobo);
    var out = '';
    /* Nothing here is bought yet, so the accepted version is the one
       being read — recorded only when the customer actually orders. */
    out += '<div class="pricebox" id="cpPrice"><div class="p">' + esc(price) + ' for ' +
      esc(t.term || 'one academic semester') + '</div>' +
      '<p>Optional, and separate from everything else. Housing is free, your rent is never touched, ' +
      'and nothing here is added to a tenancy payment.</p></div>';
    out += header(state.termsVersion, state.termsHash);

    out += '<h2>What the pass is</h2>';
    out += '<p>A pass is <b>coverage for a term</b>, not a wallet and not a balance you can spend. It ' +
      'opens on the day your payment clears and closes on a date Arzuz sets for the term \u2014 both dates ' +
      'are on your receipt.</p>';
    out += '<ul class="facts">';
    out += '<li><b>Call-outs included</b><span>' + esc(String(t.call_outs_included || '')) +
      ' per pass \u2014 not unlimited</span></li>';
    out += '<li><b>Parts included</b><span>up to ' + esc(naira(t.parts_ceiling_kobo)) +
      ' per call-out; anything above that is quoted to you first</span></li>';
    out += '<li><b>Waiting period</b><span>' + esc(t.waiting_period || 'as published') + '</span></li>';
    out += '<li><b>Approval</b><span>' + esc(t.approval || 'each call-out is approved by Arzuz first') + '</span></li>';
    out += '<li><b>Refunds</b><span>' + esc(t.refund || 'as published') + '</span></li>';
    out += '<li><b>Support</b><span>' + esc(t.support || 'WhatsApp the Arzuz team') + '</span></li>';
    out += '</ul>';

    out += '<h2>Covered</h2>' + list(t.covered, '\u2713', 'yes');
    out += '<h2>Not covered</h2>' + list(t.excluded, '\u2717', 'no');

    out += '<h2>How a claim works</h2>';
    out += '<p>Ask from your pass page. Arzuz checks the request against these terms and against the ' +
      'call-outs you have left, says yes or no <b>in writing</b>, and only then sends a worker. A job is ' +
      'finished when you confirm it \u2014 or when a dispute is settled \u2014 not when a worker says so.</p>';

    out += '<h2>Your details</h2>';
    out += '<div class="form">';
    out += '<div class="row"><div class="fld"><label for="cpName">Full name</label>' +
      '<input id="cpName" name="name" autocomplete="name" required></div>' +
      '<div class="fld"><label for="cpPhone">Phone (WhatsApp)</label>' +
      '<input id="cpPhone" name="phone" inputmode="tel" autocomplete="tel" required></div></div>';
    out += '<div class="row"><div class="fld"><label for="cpEmail">Email <span class="opt">(optional \u2014 the receipt)</span></label>' +
      '<input id="cpEmail" name="email" type="email" autocomplete="email"></div>' +
      '<div class="fld"><label for="cpArea">Area</label>' +
      '<input id="cpArea" name="area" placeholder="Malete, behind KWASU gate"></div></div>';
    out += '<div class="row"><div class="fld"><label for="cpProperty">Property <span class="opt">(optional)</span></label>' +
      '<input id="cpProperty" name="property"></div>' +
      '<div class="fld"><label for="cpRoom">Room <span class="opt">(optional)</span></label>' +
      '<input id="cpRoom" name="room"></div></div>';
    out += '<div class="fld"><label for="cpReferral">A friend\u2019s referral code <span class="opt">(optional)</span></label>' +
      '<input id="cpReferral" name="referral_code" placeholder="e.g. AZ-4F2K">' +
      '<p class="hint">Referrals pay <b>\u20a62,000 once</b>, after the referred student\u2019s first pass is ' +
      'paid for \u2014 one reward per friend, never on renewals, and never to your own code.</p></div>';
    out += '</div>';

    out += '<div class="accept">';
    out += '<label class="check"><input type="checkbox" id="cpAccept"' + (state.accepted ? ' checked' : '') + '>' +
      '<span>I have read version ' + esc(state.termsVersion) + ' of the coverage terms above \u2014 including what ' +
      'is not covered, the call-out limit and the parts ceiling \u2014 and I accept them.</span></label>';
    out += '<button class="btn" id="cpPay"' + (state.accepted ? '' : ' disabled') + '>Pay ' + esc(price) +
      ' for this pass</button>';
    out += '<p class="note" id="cpPayNote">' + (state.accepted
      ? 'You will be taken to Paystack to pay. Your pass opens only once the provider confirms the payment to our server.'
      : 'Tick the box above to continue. Nothing is charged until you pay.') + '</p>';
    out += '</div>';

    out += renderNotice();
    out += supportLine('Ask about the Care Pass');
    return out;
  }

  function renderPaying() {
    return '<div class="statebox" id="cpPaying"><b>Taking you to Paystack\u2026</b>' +
      '<span>If nothing happens, <a id="cpManual" rel="noopener" href="' +
      esc(state.order && state.order.authorization_url ? state.order.authorization_url : '#') +
      '">open the payment page yourself</a>. Your order is <b>' + esc(state.reference) + '</b>.</span></div>';
  }

  function renderVerifying() {
    return '<div class="statebox" id="cpVerifying"><b>Checking your payment with Paystack\u2026</b>' +
      '<span>This page does not decide whether you paid \u2014 the provider does, and we ask it directly. ' +
      'Order <b>' + esc(state.reference) + '</b>.</span></div>';
  }

  function coverageBlock() {
    var p = state.pass || {};
    var out = '<ul class="facts">';
    out += '<li><b>Coverage starts</b><span>' + esc(day(p.start) || 'set on the receipt') + '</span></li>';
    out += '<li><b>Coverage ends</b><span>' + esc(day(p.end) || 'set on the receipt') + '</span></li>';
    out += '<li><b>Call-outs included</b><span>' + esc(p.call_out_cap === null || p.call_out_cap === undefined
      ? 'as published' : String(p.call_out_cap)) + '</span></li>';
    if (p.session) out += '<li><b>Session</b><span>' + esc(p.session) + '</span></li>';
    out += '</ul>';
    return out;
  }

  /* The version the ORDER was created against, which the server reports
     with the payment. The terms read from the page are the fallback for
     a customer who bought in this same session — and when neither is
     known the page says so rather than printing a version nobody
     accepted. */
  function acceptedVersion() {
    var v = (state.order && state.order.terms_version) || state.termsVersion;
    return v ? String(v) : '';
  }

  function renderActive() {
    var t = state.terms || {};
    var version = acceptedVersion();
    var paid = naira(state.order && state.order.amount_kobo);
    var out = '<div class="statebox good" id="cpActive"><b>Your Care Pass is open.</b>' +
      '<span>Paid and confirmed by the provider. Keep the reference below \u2014 it is your receipt.</span></div>';
    out += '<ul class="facts">';
    out += '<li><b>Receipt</b><span>' + esc(state.receipt || '\u2014') + '</span></li>';
    out += '<li><b>Order reference</b><span>' + esc(state.reference) + '</span></li>';
    out += '<li><b>Paid</b><span>' + esc(paid || 'confirmed by the provider') + '</span></li>';
    out += '<li><b>Terms accepted</b><span>' + (version ? 'v' + esc(version) : 'the version on your receipt') +
      '</span></li>';
    out += '</ul>';
    out += coverageBlock();

    if (state.linkToken) {
      out += '<p class="note good" id="cpLinkNote">Your pass page is private: no login, no password \u2014 this ' +
        'link is the key, and it has been saved on this device.</p>';
      out += '<p><a class="btn" id="cpOpenPass" href="' + esc(passHref()) + '">Open your pass</a></p>';
    } else {
      out += '<p class="note" id="cpNoLink">Your pass page is sent separately \u2014 a private link with no ' +
        'login. If it does not arrive, message us with the reference above and we will hand it over.</p>';
      if (read(TOKEN_KEY)) {
        out += '<p><a class="btn quiet" id="cpOpenStored" href="' + esc(passHref(read(TOKEN_KEY))) +
          '">Open the pass saved on this device</a></p>';
      }
    }
    out += '<p class="note">What is covered and what is not is in ' +
      (version ? esc('v' + version) + ' of the coverage terms' : 'the coverage terms you accepted') +
      ', and it is what your claims are decided against. ' +
      (t.refund ? esc(t.refund) + '.' : 'Refunds follow the published terms.') + '</p>';
    out += supportLine('About my Care Pass ' + (state.reference || ''));
    /* The happiest moment is also the emptiest — a personal referral code
       belongs here, minted for the buyer's own number and shared in one
       tap (assets/referral-card.js). Mounted by paint(), not here, so a
       re-paint never mints twice. */
    out += '<div id="cpRefCard"></div>';
    return out;
  }

  function passHref(token) {
    var t = token || state.linkToken;
    return '/my-care?t=' + encodeURIComponent(t || '');
  }

  function renderPending() {
    var kind = state.phase === 'failed' ? 'not completed' : 'not finished yet';
    return '<div class="statebox" id="cpPending"><b>That payment is ' + esc(kind) + ' \u2014 nothing is open.</b>' +
      '<span>A Care Pass opens only when the provider confirms a successful payment to our server. ' +
      'Your order is <b>' + esc(state.reference) + '</b>; you have not been charged, and no coverage has started.</span></div>' +
      '<p class="note">You can pay again \u2014 it reuses the <b>same order</b>, so trying twice cannot buy two ' +
      'passes or charge you twice.</p>' +
      '<p><button class="btn" id="cpRetry">Pay ' + esc(naira(state.order && state.order.amount_kobo) || 'again') +
      '</button> <button class="btn quiet" id="cpCheck">Check again</button></p>' +
      renderNotice() + supportLine('About my unpaid Care Pass order ' + (state.reference || ''));
  }

  function renderMismatch() {
    return '<div class="statebox" id="cpMismatch"><b>That payment does not match this order.</b>' +
      '<span>The provider took an amount that is not what this pass costs, so we have flagged it for the team ' +
      'and opened no coverage. <b>Do not pay again</b> \u2014 message us with order ' + esc(state.reference) +
      ' and we will sort it out.</span></div>' + supportLine('About my Care Pass order ' + (state.reference || ''));
  }

  function renderOpening() {
    return '<div class="statebox" id="cpOpening"><b>Payment received \u2014 we are opening your pass by hand.</b>' +
      '<span>Something on our side did not finish automatically. Your money is safe and the team has been ' +
      'alerted. <b>Do not pay again.</b> Order ' + esc(state.reference) + '.</span></div>' +
      supportLine('Please open the Care Pass for order ' + (state.reference || ''));
  }

  function renderError() {
    return '<div class="statebox" id="cpError"><b>' + esc(state.notice || 'We could not reach Arzuz.') + '</b>' +
      '<span>Nothing was lost or charged. Try again in a moment.</span></div>' +
      '<p><button class="btn" id="cpRetry">Try again</button></p>' +
      supportLine('About my Care Pass order ' + (state.reference || ''));
  }

  function renderLookup() {
    return '<h2>Already bought a pass?</h2>' +
      '<p>Enter the reference from your receipt to see the order, the coverage dates and the receipt without ' +
      'a login. Your private pass page is separate \u2014 this only reads the order.</p>' +
      '<div class="lookup">' +
      '<label for="cpRef">Order reference</label>' +
      '<input id="cpRef" name="reference" placeholder="AZ-XXXXXX-XXXXXXXX" autocapitalize="characters" ' +
      'value="' + esc(state.lookupRef) + '">' +
      '<button class="btn quiet" id="cpFind">Look it up</button>' +
      '</div><div id="cpLookupOut">' + renderLookupOut() + '</div>';
  }

  /* The lookup is painted from state like everything else, so the whole
     block is one rendering of one answer rather than a box the page
     reaches into afterwards. */
  function renderLookupOut() {
    if (state.lookupBusy) return '<p class="note">Looking up ' + esc(state.lookupRef) + '\u2026</p>';
    if (state.lookupError) return '<p class="note bad">' + esc(state.lookupError) + '</p>';
    if (state.lookup) return renderLookupResult(state.lookup);
    return '';
  }

  function renderLookupResult(res) {
    if (!res) return '';
    var p = res.coverage;
    var out = '<ul class="facts">';
    out += '<li><b>Order</b><span>' + esc(res.reference) + '</span></li>';
    out += '<li><b>Status</b><span>' + esc(res.status) + '</span></li>';
    out += '<li><b>Amount</b><span>' + esc(naira(res.amount_kobo)) + '</span></li>';
    if (res.receipt_ref) out += '<li><b>Receipt</b><span>' + esc(res.receipt_ref) + '</span></li>';
    if (p) {
      out += '<li><b>Coverage starts</b><span>' + esc(day(p.start) || '\u2014') + '</span></li>';
      out += '<li><b>Coverage ends</b><span>' + esc(day(p.end) || '\u2014') + '</span></li>';
      out += '<li><b>Call-outs included</b><span>' + esc(String(p.call_out_cap === null || p.call_out_cap === undefined
        ? '\u2014' : p.call_out_cap)) + '</span></li>';
    }
    out += '</ul>';
    if (!res.activated) {
      out += '<p class="note">This order has no coverage open. If you paid for it, message us with the ' +
        'reference \u2014 do not pay again.</p>';
    }
    return out;
  }

  function render() {
    if (state.phase === 'loading') { setHtml('passPanel', renderLoading()); return; }
    if (state.phase === 'off') { setHtml('passPanel', renderOff()); return; }
    if (state.phase === 'paying') { setHtml('passPanel', renderPaying()); return; }
    if (state.phase === 'verifying') { setHtml('passPanel', renderVerifying()); return; }
    if (state.phase === 'active') { setHtml('passPanel', renderActive()); return; }
    if (state.phase === 'mismatch') { setHtml('passPanel', renderMismatch()); return; }
    if (state.phase === 'opening') { setHtml('passPanel', renderOpening()); return; }
    if (state.phase === 'error') { setHtml('passPanel', renderError()); return; }
    if (state.phase === 'pending' || state.phase === 'failed') { setHtml('passPanel', renderPending()); return; }
    setHtml('passPanel', renderTerms());
  }

  /* Everything on this page is painted, so the behaviour has to be
     rebound after every paint — not once at load. */
  function bind() {
    var accept = $('cpAccept');
    if (accept) {
      accept.addEventListener('change', function () {
        state.accepted = !!accept.checked;
        render();
        bind();
      });
    }
    var pay = $('cpPay');
    if (pay) pay.addEventListener('click', function () { order(); });
    var retry = $('cpRetry');
    if (retry) retry.addEventListener('click', function () { retryPayment(); });
    var check = $('cpCheck');
    if (check) check.addEventListener('click', function () { verify(state.reference); });
    var find = $('cpFind');
    if (find) find.addEventListener('click', function () { lookup(); });
    var ref = $('cpRef');
    if (ref) {
      ref.addEventListener('keydown', function (ev) {
        if ((ev.key || ev.keyCode === 13) === 'Enter') lookup();
      });
    }
    var open = $('cpOpenPass');
    if (open) {
      open.addEventListener('click', function () {
        /* The token is stored as it arrives, so /my-care works on this
           device even if the link is never clicked again. */
        if (state.linkToken) write(TOKEN_KEY, state.linkToken);
      });
    }
    /* Live confirmation on the referral box — a yes-line only, never a
       refusal. A typed code with the code's shape earns confirmation;
       anything else earns silence, because a hand-made legacy code that
       is not AZ-shaped still travels when typed (the server honours any
       typed value), so warning would talk a real referral out of the box. */
    var cref = $('cpReferral');
    if (cref) {
      cref.addEventListener('input', function () {
        var v = String(cref.value || '').trim().toUpperCase().replace(/[\s_]+/g, '-');
        var ok = /^AZ-[A-Z0-9]{4,8}$/.test(v);
        var note = $('cpReferralNote');
        if (!note) {
          note = document.createElement('p');
          note.id = 'cpReferralNote';
          note.className = 'hint';
          try { cref.parentNode.appendChild(note); } catch (e) { return; }
        }
        note.textContent = ok
          ? '\u2713 That looks like a referral code \u2014 your friend gets credited after your first pass is paid for.'
          : '';
        note.style.display = ok ? '' : 'none';
      });
    }
  }

  /* A code the friend's link carried pre-fills the optional field, so a
     referred buyer who would have left it blank is still referred. Only
     when the field is untouched and the tag has a code's shape — a
     channel tag must never appear in this box. */
  function prefillReferral() {
    var cref = $('cpReferral');
    if (!cref || cref.value) return;
    var tag = '';
    try { tag = (window.ArzuzRef && ArzuzRef.tag) ? ArzuzRef.tag() : ''; } catch (e) {}
    if (!/^az-[a-z0-9]{4,8}$/.test(tag)) return;
    cref.value = tag.toUpperCase();
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Filled in from your friend\u2019s link — change it if a different friend sent you.';
    try { cref.parentNode.appendChild(hint); } catch (e) {}
  }

  function paint() {
    render();
    var lookupTarget = $('passLookup');
    if (lookupTarget) setHtml('passLookup', renderLookup());
    bind();
    prefillReferral();
    /* The active screen carries the mount point; the card mints once per
       phone (the server is idempotent), and a paint without a mount
       point or without a buyer number simply draws no card. */
    var slot = $('cpRefCard');
    if (slot && !slot.getAttribute('data-ref-mounted') && state.buyerPhone &&
        window.ArzuzReferralCard && ArzuzReferralCard.mount) {
      slot.setAttribute('data-ref-mounted', 'yes');
      ArzuzReferralCard.mount(slot, { phone: state.buyerPhone, name: state.buyerName });
    }
  }

  /* ------------------------------------------------------------
     the flow
     ------------------------------------------------------------ */

  function loadTerms() {
    state.phase = 'loading';
    paint();
    return api('terms', {}).then(function (res) {
      state.terms = res.terms || {};
      state.termsVersion = res.version || null;
      state.termsHash = res.hash || '';
      state.accepted = false;
      state.phase = 'ready';
      paint();
      return res;
    }).catch(function (err) {
      var W = E();
      if (W && err.kind === 'not-ready') {
        state.phase = 'off';
        state.notice = err.message;
        paint();
        return null;
      }
      state.phase = 'error';
      state.notice = (err && err.message) || null;
      paint();
      return null;
    });
  }

  function order(retried) {
    if (state.phase !== 'ready' || state.busy) return Promise.resolve(null);
    var f = form();
    state.notice = null;

    /* The acceptance is a rule, not a decoration: refused here, and the
       server refuses an order that carries no accepted terms anyway. */
    if (!state.accepted) {
      state.notice = 'Tick the box to accept the coverage terms you have just read.';
      state.noticeKind = 'bad';
      paint();
      return Promise.resolve(null);
    }
    var problem = problemWith(f);
    if (problem) {
      state.notice = problem;
      state.noticeKind = 'bad';
      paint();
      return Promise.resolve(null);
    }

    state.busy = true;
    /* The number the referral code will belong to — stashed now, because
       the checkout form is gone by the time the pass opens. */
    state.buyerPhone = f.phone;
    state.buyerName = f.name;
    var btn = $('cpPay');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening Paystack\u2026'; }

    /* Exactly the student's own words and the idempotency uuid. No
       amount, no price, no status, no window — the server has those. */
    return api('order', {
      client_ref: clientRef(),
      name: f.name,
      phone: f.phone,
      email: f.email,
      area: f.area,
      property: f.property,
      room: f.room,
      referral_code: f.referral_code,
      /* The tag the friend's link carried. The server only honours it
         when it has a code's shape — a channel tag stays a channel. */
      attribution_tag: (window.ArzuzRef && ArzuzRef.tag) ? ArzuzRef.tag() : ''
    }).then(function (res) {
      /* THE ORDER EXISTED BUT ITS PAYMENT PAGE NEVER OPENED. The server
         has marked that row abandoned and told the page to start again —
         re-initializing the same reference would be refused by Paystack,
         and the buyer would be looking at a Pay button that does nothing.
         The stored client_ref is the thing that made it replay, so it is
         forgotten here and a genuinely fresh order is written. One
         automatic attempt, then the sentence is shown: a provider that is
         down must not become a loop of invisible orders. */
      if (res && res.retry) {
        forgetOrder();
        state.order = null;
        state.reference = '';
        state.busy = false;
        if (!retried) return order(true);
        state.phase = 'ready';
        state.notice = res.error || 'Our payment page did not open. Nothing has been charged — try again.';
        state.noticeKind = 'bad';
        paint();
        return null;
      }
      state.order = res;
      state.reference = res.reference || '';
      rememberOrder(state.reference, res);
      state.phase = 'paying';
      paint();
      if (res.authorization_url) window.location.assign(res.authorization_url);
      return res;
    }).catch(function (err) {
      state.busy = false;
      var W = E();
      if (W && err.kind === 'not-ready') {
        state.phase = 'off';
        state.notice = err.message;
        paint();
        return null;
      }
      state.phase = 'error';
      state.notice = (err && err.message) || null;
      paint();
      return null;
    }).then(function (out) {
      state.busy = false;
      return out;
    });
  }

  /* Pay again: the SAME client_ref, so the server replays the order. */
  function retryPayment() {
    state.notice = null;
    state.phase = 'ready';
    state.accepted = true;
    return order().then(function (res) {
      if (!res && state.phase === 'ready') { paint(); }
      return res;
    });
  }

  function verify(reference) {
    var ref = String(reference || state.reference || '').trim();
    if (!ref) return Promise.resolve(null);
    state.reference = ref;
    state.phase = 'verifying';
    paint();

    var payload = { reference: ref };
    var held = read(CLIENT_KEY);
    if (/^[0-9a-fA-F-]{36}$/.test(held)) payload.client_ref = held;

    return api('verify', payload).then(function (res) {
      state.order = res;
      if (res.activated) {
        state.pass = res.coverage || null;
        state.receipt = res.receipt_ref || (res.coverage && res.coverage.receipt_ref) || null;
        if (res.pass_link && res.pass_link.token) {
          state.linkToken = res.pass_link.token;
          write(TOKEN_KEY, res.pass_link.token);
        }
        state.phase = 'active';
        forgetOrder();
        toast('Care Pass open.', 'success');
      } else if (res.status === 'paid') {
        state.phase = 'opening';
      } else {
        state.phase = res.status === 'failed' || res.status === 'abandoned' ? 'failed' : 'pending';
      }
      paint();
      return res;
    }).catch(function (err) {
      var W = E();
      var kind = W ? err.kind : (err && err.status === 409 ? 'rejected' : 'error');
      if (kind === 'not-ready') {
        state.phase = 'off';
        state.notice = err.message;
      } else if (kind === 'rejected' && err.status === 409) {
        state.phase = 'mismatch';
      } else {
        state.phase = 'error';
        state.notice = (err && err.message) || null;
      }
      paint();
      return null;
    });
  }

  function lookup() {
    state.lookupRef = field('cpRef').toUpperCase();
    state.lookup = null;
    state.lookupError = null;
    if (!state.lookupRef) return Promise.resolve(null);
    state.lookupBusy = true;
    paint();
    return api('status', { reference: state.lookupRef }).then(function (res) {
      state.lookup = res;
      state.lookupBusy = false;
      paint();
      return res;
    }).catch(function (err) {
      state.lookupBusy = false;
      state.lookupError = (err && err.message) || 'We could not look that up just now.';
      paint();
      return null;
    });
  }

  function boot() {
    var fromUrl = referenceFromUrl();
    var remembered = pendingOrder();
    if (fromUrl) {
      state.reference = fromUrl;
      return verify(fromUrl);
    }
    if (remembered && remembered.reference) {
      /* Came back without the query string (or reloaded): still ask the
         server about the order this browser began. */
      state.reference = remembered.reference;
      state.order = remembered.order || null;
      return verify(remembered.reference);
    }
    return loadTerms();
  }

  if (typeof document !== 'undefined' && document.getElementById('passPanel')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { boot(); });
    } else {
      boot();
    }
  }

  return {
    boot: boot,
    loadTerms: loadTerms,
    order: order,
    retryPayment: retryPayment,
    verify: verify,
    lookup: lookup,
    render: render,
    paint: paint,
    state: function () { return state; },
    clientRef: clientRef,
    form: form,
    naira: naira,
    day: day,
    esc: esc,
    referenceFromUrl: referenceFromUrl,
    passHref: passHref,
    renderTerms: renderTerms,
    renderLookup: renderLookup,
    renderActive: renderActive,
    renderPending: renderPending,
    renderLookupResult: renderLookupResult,
    CLIENT_KEY: CLIENT_KEY,
    ORDER_KEY: ORDER_KEY,
    TOKEN_KEY: TOKEN_KEY,
    API: API
  };
})();
