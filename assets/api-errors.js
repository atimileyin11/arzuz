/* ============================================================
   Arzuz — what a failed request actually means

   ONE classifier for the whole site, so a person is never told the
   same wrong thing twice and two pages cannot drift apart on the
   same failure.

   THE MISTAKE THIS PREVENTS

     Every page used to answer the platform's own words with a
     status code of its own making — "Could not save: HTTP 404",
     "The Care service answered 503.", "Sign-in failed (HTTP 500)."
     — and every one of those is a lie by omission: the status says
     WHICH, and the person needs to know WHOSE fault it is and what
     to do next. Worse, the failures that are NOT the visitor's
     fault were the ones that read as if they were.

   THE CLASSES

     not-ready   the function/table/route is not in this deployment
                 (PGRST202/PGRST205, a 404, a missing grant) — our
                 side, and the visitor must NOT be sent to retry or
                 to ask for a new link, because neither can work
     expired     a 401 on a page that holds a session — sign in again
     rejected    a 4xx that is neither: the request itself was
                 refused, and repeating it will be refused again
     busy        429 — wait, and nothing typed is lost
     offline     the request never arrived (status 0 / fetch threw)
     error       5xx or anything unreadable — our side of the wire

   WHAT A PAGE DOES WITH IT

     retryable(err)  → is it worth sending again? (offline/busy/error)
     queueable(err)  → is it worth holding for a later retry? A
                       refused request is not: it fails identically
                       forever, and "queued for auto-retry" then
                       reads as "it will work soon" when it cannot.
     sentence(err)   → one line to show a person, in words
     detail(err)     → the operator's line for the console/log, so
                       the platform's own sentence is still recorded
                       rather than paraphrased away

   Loads as window.ArzuzApiErrors in a browser and via require() in
   Node, exactly like assets/roommate-score.js and
   assets/draft-errors.js. The invite page's classifier is built on
   this one, so a fix to a shared sentence lands on every page.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzApiErrors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.2.0';

  /* The one number a person can actually use. Kept here beside the
     sentences that mention it so copy and contact cannot drift. */
  var WHATSAPP = '0902 481 4771';

  /* The country the number is in, for the one form a dialler needs:
     wa.me wants 2349024814771 — no plus, no leading zero. */
  var WHATSAPP_CC = '234';

  /* The same number in the form a link takes. A page that prints the
     number and a page that links it read this one file, so the two
     cannot end up pointing at different phones. */
  function waNumber() {
    var digits = String(WHATSAPP).replace(/[^\d]/g, '');
    if (digits.charAt(0) === '0') digits = WHATSAPP_CC + digits.slice(1);
    return digits;
  }

  /* `text` prefills the message, which is what saves a person typing
     it on a phone keyboard. Encoded here, never at the call site. */
  function waLink(text) {
    var n = waNumber();
    return n ? 'https://wa.me/' + n + (text ? '?text=' + encodeURIComponent(text) : '') : '';
  }

  /* ------------------------------------------------------------
     The words. One entry per class; `outcome` is what a page does
     with it — 'dead' may take the screen, 'inline' is a note that
     leaves the page intact.
     ------------------------------------------------------------ */

  var KINDS = {
    /* A deployment fact. The visitor did nothing wrong and       there is nothing they can retry, so the copy must not send them to. */
    'not-ready': {
      outcome: 'dead',
      title: 'This is not switched on yet',
      body: 'Nothing is wrong with what you did. Arzuz has to finish setting this part up on our ' +
        'side before it can answer. Message us on WhatsApp and we will sort it out, or come back ' +
        'and try again later.',
      inline: 'Arzuz has not finished switching this on yet \u2014 that is our side, not yours. ' +
        'Message us on WhatsApp and we will sort it out.',
      queued: 'Arzuz has not finished switching this on yet, so we could not save it \u2014 we have kept '
        + 'what you wrote and will keep trying. Message us on WhatsApp so it is not missed.'
    },

    /* Only for a page that holds a session: a 401 there means the
       token went stale, which the person can fix by signing in. */
    expired: {
      outcome: 'dead',
      title: 'Your session has timed out',
      body: 'Sign in again and you will be back where you left off. Nothing you have done has ' +
        'been lost.',
      inline: 'Your session has timed out \u2014 sign in again. Nothing you have done has been lost.'
    },

    /* The request itself was refused. Repeating it changes nothing,
       so this is the one class that must never be queued. */
    rejected: {
      outcome: 'inline',
      inline: 'Arzuz could not accept that \u2014 that is our side, not yours. Nothing you typed has ' +
        'been lost; message us on WhatsApp and we will finish it with you.'
    },

    /* Nothing to do but wait, and nothing typed is at risk: say both. */
    busy: {
      outcome: 'inline',
      inline: 'That is a lot of attempts in a minute \u2014 wait a moment and try again. Nothing you have ' +
        'typed has been lost.',
      queued: 'Arzuz is getting a lot of requests just now. We have kept what you wrote and will send '
        + 'it again in a moment.'
    },

    offline: {
      outcome: 'inline',
      inline: 'We could not reach Arzuz \u2014 check your connection and try again. Nothing you have typed ' +
        'has been lost.',
      queued: 'You look offline, so we have kept what you wrote and will send it the moment the '
        + 'connection is back.'
    },

    /* Everything else, including Arzuz being briefly unwell. Named as
       OUR side of the wire, because a 500 is not a fact about the
       person and must not read like one. */
    error: {
      outcome: 'inline',
      inline: 'Arzuz could not take that just now \u2014 that is our side, not yours. Try again in a ' +
        'minute; if it keeps happening, message us on WhatsApp and we will finish it with you.',
      queued: 'Arzuz could not take that just now. We have kept what you wrote and will send it '
        + 'again for you \u2014 that is our side, not yours.'
    }
  };

  /* ------------------------------------------------------------
     Telling them apart
     ------------------------------------------------------------ */

  /* PostgREST's "no matches were found in the schema cache", said
     either about a function (PGRST202) or a table (PGRST205): the
     thing is not in this project, so the site is running ahead of
     its database. The CODE is the contract and the sentence is how
     a person would explain it in a log, so both are matched. */
  function isMissingFunction(err) {
    if (!err) return false;
    if (err.code === 'PGRST202' || err.code === 'PGRST205') return true;
    return /could not find the (function|table)|no matches were found|schema cache/i.test(
      String(err.message || ''));
  }

  /* 401/403. On a page with no session both mean "this page may not
     call that yet"; a missing grant is not the visitor's problem. */
  function isRefused(err) {
    return !!err && (err.status === 401 || err.status === 403);
  }

  /* A request that never arrived. fetch() rejects with a TypeError and
     NO status at all, which is why `!err` counts as offline rather than
     as an error — and why the message is inspected too: an unreachable
     network and a server that answered 500 are different promises to
     the person holding the phone.

     TWO RUNTIMES, TWO SENTENCES, ONE EVENT. A browser says "Failed to
     fetch"; Node — which is where every Netlify function runs — says
     exactly "fetch failed", with a cause and no status. Both mean nothing
     answered. Without the second phrase a function whose database was
     unreachable read as "we could not take that just now, try again in a
     minute", which is advice about a server that was never reached
     (found by the verification clock, whose whole message is where to
     look next). */
  function isOffline(err) {
    if (!err) return true;
    if (err.status === 0 || err.offline === true) return true;
    if (typeof err.status === 'undefined' && /^fetch failed$/i.test(String(err.message || ''))) return true;
    return typeof err.status === 'undefined'
      && /failed to fetch|network ?error|networkerror|load failed|the internet connection appears to be offline/i
        .test(String(err.message || ''));
  }

  /* The class, as a name a page can branch on. */
  function kindOf(err, opts) {
    opts = opts || {};
    if (isOffline(err)) return 'offline';
    if (err.status === 429) return 'busy';
    if (isMissingFunction(err)) return 'not-ready';
    if (err.status === 404) return 'not-ready';       // a route, table or function this deploy does not have
    if (isRefused(err)) return (opts.session === true && err.status === 401) ? 'expired' : 'not-ready';
    if (err.status >= 400 && err.status < 500) return 'rejected';
    return 'error';
  }

  function describe(kind, reason) {
    return Object.assign({ kind: kind, reason: reason || kind }, KINDS[kind]);
  }

  /* A failure in, a class out. `opts.session` says the page holds a
     session, which is what makes a 401 an expired session instead of
     a missing grant. */
  function classify(err, opts) {
    if (typeof err === 'string') return describe('rejected', err);
    /* A class the server named wins over anything derived from the
       status: it is the only party that can tell a missing key from a
       bad minute behind the same 503. Validated against the vocabulary,
       so a stray `kind` on an error object is ignored, not trusted. */
    if (err && KINDS[err.kind]) return describe(err.kind, 'the server said so');
    return describe(kindOf(err, opts), reasonOf(err, opts));
  }

  /* ------------------------------------------------------------
     THE WIRE FORM

     A Netlify function answers a page with { error, kind }. The page
     reads `kind` instead of re-deriving the class from the status,
     because a number cannot say which of these it was:

       503  this deploy has no service key yet   → not-ready
       503  we are briefly unwell                → error

     Both are 503. Only the server knows which side of that line it is
     standing on, so the server names the class and the page believes
     it. Same module, same six names, both ends of the wire.

     SERVER   wireBody(status, body, kind)  the body to send back
     PAGE     failed(res, body, opts)       that body, read back as
                                            the error the page uses
     ------------------------------------------------------------ */

  /* Stamp a class onto an error body, keeping one the function chose
     for itself. A success body has no `error` and is returned as it is,
     so nothing else on the wire grows a field. */
  function withKind(status, body) {
    if (!body || typeof body !== 'object' || !body.error) return body;
    if (KINDS[body.kind]) return body;
    return Object.assign({}, body, { kind: kindOf({ status: status }) });
  }

  /* THE SERVER'S SIDE. The JSON body a function sends back for a
     failure: its own sentence, plus the class.

     `kind` is passed only where the status alone would be read wrong —
     a missing service key, a function that is not in this deployment,
     a table that has not been created — and a name that is not in the
     vocabulary is discarded by withKind() rather than shipped, so a
     typo can never put a class on the wire that no page can read. */
  function wireBody(status, body, kind) {
    var payload = body;
    if (kind && body && typeof body === 'object' && body.error && !KINDS[body.kind]) {
      payload = Object.assign({}, body, { kind: kind });
    }
    return withKind(status, payload);
  }

  /* THE PAGE'S SIDE, in one call. A failed answer from one of our own
     functions, read back as the Error the page will branch on:

       err.kind     the class the SERVER named, when it named one,
                    otherwise the one the status implies
       err.message  the server's own sentence when it sent one — that
                    is the answer to what was asked — otherwise the
                    class's line for a person
       err.status / err.code / err.detail   the operator's facts, for
                    the console and the log

     `res` may be the Response or the status number, and `body` may be
     the parsed payload or the raw text, because callers have both. A
     body that will not parse is not an answer from us: it becomes no
     sentence at all rather than a sentence about JSON.

     This is the ONLY reader a page should use for one of our own
     functions. It exists so no page has to re-derive the class from
     the number — which is exactly how a 503 that means "this deploy
     has no service key" got read as "try again in a minute". */
  function failed(res, body, opts) {
    var status = (res && typeof res === 'object') ? (res.status || 0) : (res || 0);
    var b = body;
    if (typeof b === 'string') {
      try { b = b ? JSON.parse(b) : null; } catch (e) { b = null; }
    }
    if (b && typeof b !== 'object') b = null;

    var wire = { status: status };
    if (b && KINDS[b.kind]) wire.kind = b.kind;
    if (b && b.code) wire.code = String(b.code);
    var own = b ? String(b.error || b.message || '') : '';
    if (own) wire.message = own;

    var err = new Error(own || sentence(wire, opts));
    err.status = status;
    if (wire.kind) err.kind = wire.kind;
    else err.kind = kindOf(wire, opts);
    if (wire.code) err.code = wire.code;
    err.detail = detail(wire);
    return err;
  }

  /* The reason is for the console, never for the person. */
  function reasonOf(err, opts) {
    if (!err) return 'unreachable';
    if (isOffline(err)) return 'unreachable';
    if (isMissingFunction(err)) return err.code || 'schema cache';
    if (err.status === 429) return '429';
    if (isRefused(err)) return 'refused';
    if (err.status) return 'HTTP ' + err.status;
    return (err && err.message) || 'unknown';
  }

  /* A descriptor for a class the page has already decided — a row
     that is not there is not an error at all, but the class is
     still the page's to name. */
  function state(kind, opts) {
    var k = KINDS[kind];
    if (!k) throw new Error('ArzuzApiErrors.state: unknown kind "' + kind + '"');
    return Object.assign({ kind: kind, reason: 'decided by the page' }, k);
  }

  /* The class of an error, preferring the one the SERVER named. Every
     branch below goes through here rather than kindOf() directly: an
     error built by failed() carries the server's class, and a decision
     made from the number instead — "this 503 is worth retrying" when
     the server said the deploy has no service key — is the drift this
     whole vocabulary exists to stop. */
  function kindOfErr(err, opts) {
    if (typeof err === 'string') return 'rejected';
    if (err && KINDS[err.kind]) return err.kind;
    return kindOf(err, opts);
  }

  /* What is sent again. A 'not-ready' is worth holding — the deploy
     it is waiting for may land — but it is not worth telling the
     person to press the button again, which is what `retryable`
     means and why the two are separate. */
  function retryable(err, opts) {
    var kind = kindOfErr(err, opts);
    return kind === 'offline' || kind === 'busy' || kind === 'error';
  }

  /* What may be put in the offline queue. A refused request is not
     in it: it will be refused identically forever, and a queue that
     holds it only hides the problem behind "we will retry". */
  function queueable(err, opts) {
    return kindOfErr(err, opts) !== 'rejected';
  }

  /* The operator's line, so the platform's own words are recorded
     rather than paraphrased away. */
  function detail(err) {
    if (typeof err === 'string') return err;
    if (!err) return 'no detail';
    return [err.status, err.code, err.message].filter(Boolean).join(' ');
  }

  /* The line for a failure that has been HELD for a later retry. It
     is not the same sentence as a plain failure: "check your
     connection and try again" is wrong advice from a page that is
     already going to try again by itself, and it is the reason this
     lives beside the class rather than in the page that queues. */
  function queueSentence(err, opts) {
    var kind = kindOfErr(err, opts);
    var k = KINDS[kind];
    return k.queued || k.inline || (k.title + ' ' + k.body);
  }

  /* One line to show a person. Never a status code — that is what
     detail() is for, and the two are deliberately different.

     `inline` is preferred wherever a class has one, because this is a
     SINGLE line: a toast, a modal's error slot, a console warning. The
     title/body pair is the copy for a screen that has room for it, and
     gluing the two together produced a two-sentence paragraph in a
     one-line slot — found by reading the string a browser really
     produced, not by reading this function. */
  function sentence(err, opts) {
    opts = opts || {};
    var d = classify(err, opts);
    var line = d.inline || (d.title + ' ' + d.body);
    /* An operator seeing "our side, not yours" needs the wire facts
       to act on; a student does not, and must not be shown them. */
    if (opts.audience === 'operator') line += ' (' + detail(err) + ')';
    return line;
  }

  return {
    VERSION: VERSION,
    WHATSAPP: WHATSAPP,
    waNumber: waNumber,
    waLink: waLink,
    KINDS: KINDS,
    classify: classify,
    kindOf: kindOf,
    state: state,
    sentence: sentence,
    queueSentence: queueSentence,
    withKind: withKind,
    wireBody: wireBody,
    failed: failed,
    detail: detail,
    retryable: retryable,
    queueable: queueable,
    isMissingFunction: isMissingFunction,
    isRefused: isRefused,
    isOffline: isOffline
  };
});
