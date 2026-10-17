/* ============================================================
   Arzuz — the public status page

   Drives status.html. A student types the reference they were given
   and a contact we hold for them — their phone number, or the email
   address they gave us — receives a six-digit code on that channel,
   and then — and only then — sees where their submission has got to.

   THE SHAPE OF THE PAGE

     step 1  reference + contact  →  POST /api/status { step: 'send' }
     step 2  the code             →  POST /api/status { step: 'verify' }
     done    the stage

   WHY THERE ARE TWO CHANNELS

     The phone was the only one this page had, and it is the contact a
     student is most likely to have lost or changed — a new SIM, a new
     line after a stolen phone. WhatsApp itself goes down too. Either
     way the code had nowhere to arrive, and the page answered the one
     person it exists for with nothing. So the email they gave us is
     the second channel: the same reference, a contact that does not
     change when a SIM does, and a code that arrives in an inbox.

     The choice is the STUDENT's and it is sent as `channel`. The page
     never learns which channels the record has — the server will not
     say, and a page that guessed would be re-deriving the oracle the
     endpoint refuses to give.

   WHY THE PAGE CANNOT TELL YOU WHETHER YOUR REFERENCE IS REAL

     The send step answers the SAME thing for all of it: a reference
     that never existed, a reference whose phone is not the one typed,
     an email on record that is not the one typed, and a code that
     really is on its way. That is deliberate and it is the endpoint's
     whole defence (netlify/functions/status.js explains it at
     length). So this page does NOT branch on the answer — it always
     moves to step 2 with the neutral sentence and offers the code box,
     because a page that showed "we did not find that" for one case and
     "enter your code" for the other would hand an attacker the oracle
     the server refuses to give. The line under the code box is about
     the channel the page ASKED for, which the student chose a moment
     ago, and never about what came back.

   WHAT IT NEVER DOES

     · It never stores the reference, the phone or the email: not in
       localStorage, not in sessionStorage, not in a cookie. A shared
       device is the normal case on this site, and a cached reference
       is a handle someone else can pick up.
     · It never puts anything the server sent into the page without
       esc() first — the reveal carries a stage word and dates that
       come from the database, and a heading built from a value is
       exactly where that is forgotten.
     · It never decides what a stage means. The headline and the facts
       are the function's sentences; the page prints them.
   ============================================================ */

var ArzuzStatus = (function () {

  'use strict';

  var API = '/api/status';

  /* The sentence the server sends with a held answer. Kept here too so
     that the page still says something honest if a proxy ever eats the
     body — the page must not be the reason a student is left staring
     at an empty box. Both copies are asserted against the function's
     by scripts/test-status.mjs, so they cannot drift. */
  var SENT_ANYWAY = 'If that reference and the contact details we hold for it match a record of ours, a code ' +
    'is on its way. It arrives within a minute and expires in ten.';

  /* The two channels, and what each one needs from the person. Kept as
     data so the field, the button label and the line under the code
     box cannot disagree about which channel is in play. */
  var CHANNELS = {
    whatsapp: {
      key: 'phone',
      field: 'stPhone',
      send: 'Send me a code',
      where: 'The code goes to the number you gave us, on WhatsApp. If WhatsApp cannot reach you and we ' +
        'hold an email address for you, the same code goes to that inbox as well.'
    },
    email: {
      key: 'email',
      field: 'stEmail',
      send: 'Email me a code',
      where: 'The code goes to the email address you gave us, from Arzuz Care. Check the spam folder if it ' +
        'is not there in a minute.'
    }
  };

  var state = {
    step: 'ask',        // ask → code → done
    ref: '',            // what was typed, upper-cased; never persisted
    channel: 'whatsapp',// whatsapp | email — the student's choice
    ident: '',          // the contact typed for that channel; never persisted
    busy: false,
    note: null,
    noteKind: 'ok',     // ok | bad | wait
    reveal: null
  };

  /* ------------------------------------------------------------
     the two doors
     ------------------------------------------------------------ */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(id) { return document.getElementById(id); }
  function E() { return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }

  function post(payload) {
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
          /* The server's sentence is the answer to what the student
             just did, and its CLASS rides along so the page branches
             on the class the function named rather than re-deriving
             one from the number. */
          var W = E();
          if (!W) {
            var plain = new Error(data.error || 'Arzuz could not check that just now — that is our side, ' +
              'not yours. Try again in a minute.');
            plain.status = r.status || 0;
            throw plain;
          }
          throw W.failed(r, data);
        }
        return data;
      });
    });
  }

  function sentence(err) {
    var W = E();
    if (W && W.describe) {
      try { return W.describe(W.kindOfErr ? W.kindOfErr(err) : 'error', err); } catch (e) { /* fall through */ }
    }
    return (err && err.message) || 'Something went wrong — try again in a minute.';
  }

  /* ------------------------------------------------------------
     step 1 — ask for a code
     ------------------------------------------------------------ */

  function ask() {
    if (state.busy) return;
    var refRaw = ($('stRef') || {}).value || '';
    var channel = channelNow();
    var typed = String((($(CHANNELS[channel].field) || {}).value) || '').trim();
    var hp = ($('stHp') || {}).value || '';

    state.channel = channel;

    if (!String(refRaw).trim()) {
      state.note = 'Type the reference we gave you — it starts with ARZ- and is on the message or the screen you got when you submitted.';
      state.noteKind = 'bad';
      return paint();
    }
    if (!contactLooksUsable(channel, typed)) {
      state.note = channel === 'email'
        ? 'Type the email address you gave us when you submitted — the whole address, including the part after the @.'
        : 'We need the phone number you gave us — at least ten digits. It is the number the code goes to.';
      state.noteKind = 'bad';
      return paint();
    }

    state.busy = true;
    state.note = null;
    paint();

    /* Only the chosen channel's contact is sent. There is no reason to
       hand over the other one — the server has it already, or does not
       need it — and a request that carries less is a request with less
       to leak. */
    var payload = { step: 'send', ref: String(refRaw).trim(), channel: channel, hp: String(hp) };
    payload[CHANNELS[channel].key] = typed;

    post(payload)
      .then(function (data) {
        state.busy = false;
        state.ref = String(refRaw).trim().toUpperCase();
        state.ident = typed;
        state.step = 'code';
        /* The server's own sentence, not a second one written here.
           `held` is true for every answer this endpoint gives that is
           not a rate limit, so there is no case to branch on — which
           is the point. */
        state.note = (data && data.note) || SENT_ANYWAY;
        state.noteKind = 'ok';
        paint();
        var box = $('stCode');
        if (box && box.focus) box.focus();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = sentence(err);
        state.noteKind = (err && err.status === 429) ? 'wait' : 'bad';
        paint();
      });
  }

  /* The channel the radios are on. Anything unexpected reads as
     WhatsApp, which is the channel this page had before the email one
     existed. */
  function channelNow() {
    var mail = $('stChMail');
    return (mail && mail.checked) ? 'email' : 'whatsapp';
  }

  /* A shape a person could plausibly have typed. The SERVER decides
     whether it matches the record — this only stops a student wasting
     one of their ten attempts on a value that cannot be an address or
     a number. */
  function contactLooksUsable(channel, typed) {
    if (channel === 'email') return /^[^\s@,;"<>]+@[^\s@,;"<>]+\.[A-Za-z]{2,}$/.test(typed);
    return String(typed).replace(/\D/g, '').length >= 10;
  }

  /* ------------------------------------------------------------
     step 2 — the code comes back
     ------------------------------------------------------------ */

  function check() {
    if (state.busy) return;
    var code = (($('stCode') || {}).value || '').replace(/\D/g, '');

    if (code.length !== 6) {
      state.note = 'The code is six digits. Type all of them, exactly as they arrived.';
      state.noteKind = 'bad';
      return paint();
    }

    state.busy = true;
    state.note = null;
    paint();

    post({ step: 'verify', ref: state.ref, code: code })
      .then(function (data) {
        state.busy = false;
        state.reveal = data;
        state.step = 'done';
        state.note = null;
        paint();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = sentence(err);
        state.noteKind = (err && err.status === 429) ? 'wait' : 'bad';
        paint();
      });
  }

  /* Ask for a fresh code, from the code step. Neither the reference
     nor the contact is asked for again: both were proved a moment ago,
     and re-typing them is the step a person gets wrong. The channel is
     the one they chose, remembered in state — not re-read from the
     radios, which are on a step that is no longer on screen. */
  function resend() {
    if (state.busy) return;
    state.busy = true;
    state.note = null;
    paint();
    var payload = { step: 'send', ref: state.ref, channel: state.channel };
    payload[CHANNELS[state.channel].key] = state.ident;
    post(payload)
      .then(function (data) {
        state.busy = false;
        state.note = (data && data.note) || SENT_ANYWAY;
        state.noteKind = 'ok';
        paint();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = sentence(err);
        state.noteKind = (err && err.status === 429) ? 'wait' : 'bad';
        paint();
      });
  }

  function startOver() {
    state.step = 'ask';
    state.reveal = null;
    state.note = null;
    state.noteKind = 'ok';
    state.ref = '';
    state.ident = '';
    state.channel = 'whatsapp';
    paint();
    var box = $('stRef');
    if (box && box.focus) box.focus();
  }

  /* ------------------------------------------------------------
     painting — a pure function of state and the server's answer
     ------------------------------------------------------------ */

  function renderReveal(r) {
    var facts = (r.facts || []).map(function (f) {
      return '<li>' + esc(f) + '</li>';
    }).join('');
    return '' +
      '<div class="rvy">' +
        '<div class="rvy-ref"><span>Reference</span> <code>' + esc(r.ref) + '</code></div>' +
        '<h2>' + esc(r.headline || 'We have this.') + '</h2>' +
        (facts ? '<ul class="rvy-facts">' + facts + '</ul>' : '') +
        '<p class="rvy-keep">Keep your reference. It is how we find your file when you call, ' +
          'and it is what you would type here next time.</p>' +
        '<div class="st-acts">' +
          '<button type="button" class="st-go ghost" id="stAgain">Check another reference</button>' +
        '</div>' +
      '</div>';
  }

  function paint() {
    var ask = $('stAsk');
    var step2 = $('stCodeBox');
    var out = $('stOut');
    var note = $('stNote');
    var who = $('stWho');
    var ch = CHANNELS[state.channel] || CHANNELS.whatsapp;

    if (ask) ask.hidden = state.step !== 'ask';
    if (step2) step2.hidden = state.step !== 'code';

    /* The channel the page asked for decides which field is on screen
       and which line sits under the code box. It is read from STATE,
       never from the server's answer. */
    var phoneFld = $('stPhoneFld');
    if (phoneFld) phoneFld.hidden = state.channel === 'email';
    var mailFld = $('stEmailFld');
    if (mailFld) mailFld.hidden = state.channel !== 'email';
    var waRadio = $('stChWa');
    if (waRadio) waRadio.checked = state.channel !== 'email';
    var mailRadio = $('stChMail');
    if (mailRadio) mailRadio.checked = state.channel === 'email';
    var where = $('stWhere');
    if (where) where.textContent = ch.where;

    if (out) {
      out.hidden = state.step !== 'done';
      out.innerHTML = state.reveal ? renderReveal(state.reveal) : '';
    }
    if (who) {
      who.hidden = state.step === 'ask';
      who.innerHTML = state.ref ? 'Checking <code>' + esc(state.ref) + '</code>' : '';
    }
    if (note) {
      if (state.note) {
        note.hidden = false;
        note.className = 'st-note ' + (state.noteKind === 'ok' ? 'ok' : (state.noteKind === 'wait' ? 'wait' : 'bad'));
        note.textContent = state.note;
      } else {
        note.hidden = true;
        note.textContent = '';
      }
    }

    var go = $('stGo');
    if (go) { go.disabled = state.busy; go.textContent = state.busy ? 'Checking…' : ch.send; }
    var vg = $('stVerify');
    if (vg) { vg.disabled = state.busy; vg.textContent = state.busy ? 'Checking…' : 'Check my status'; }
    var rs = $('stResend');
    if (rs) rs.disabled = state.busy;
  }

  /* ------------------------------------------------------------
     wiring
     ------------------------------------------------------------ */

  function mount() {
    var go = $('stGo');
    if (go) go.addEventListener('click', ask);
    var form = $('stForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); ask(); });
    var vg = $('stVerify');
    if (vg) vg.addEventListener('click', check);
    var cf = $('stCodeForm');
    if (cf) cf.addEventListener('submit', function (e) { e.preventDefault(); check(); });
    var rs = $('stResend');
    if (rs) rs.addEventListener('click', resend);

    /* Choosing a channel only changes what is on screen. Nothing is
       asked of the server until the student presses send, so switching
       back and forth costs nothing and reveals nothing. */
    ['stChWa', 'stChMail'].forEach(function (id) {
      var radio = $(id);
      if (radio) radio.addEventListener('change', function () {
        state.channel = channelNow();
        state.note = null;
        paint();
      });
    });

    /* The one button inside the reveal is re-rendered with the reveal
       itself, so it is wired by delegation rather than by attaching a
       listener to a node that is about to be replaced. */
    var out = $('stOut');
    if (out) out.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'stAgain') startOver();
    });

    var rf = $('stRef');
    if (rf) rf.addEventListener('blur', function () { rf.value = String(rf.value || '').trim().toUpperCase(); });

    /* A reference in the URL is a convenience, never stored: /status?ref=
       is what the confirmation screen links to, so the person arrives
       with the field already filled in. Reading it does not cache it. */
    var from = '';
    try {
      from = new URLSearchParams(window.location.search).get('ref') || '';
    } catch (e) { from = ''; }
    if (from && rf) rf.value = from.trim().toUpperCase();

    paint();
  }

  return {
    state: state,
    CHANNELS: CHANNELS,
    mount: mount,
    ask: ask,
    check: check,
    resend: resend,
    startOver: startOver,
    channelNow: channelNow,
    contactLooksUsable: contactLooksUsable,
    renderReveal: renderReveal,
    esc: esc,
    SENT_ANYWAY: SENT_ANYWAY
  };
})();
