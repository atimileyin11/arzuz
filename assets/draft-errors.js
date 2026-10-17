/* ============================================================
   Arzuz — what a failed invite-link call actually means

   ONE place that decides it, because three different things look
   identical from the landlord's side and only one of them is their
   fault:

     * the site has not had the draft upgrade run (the RPC is not
       there)                    → NOT the link
     * the page is not allowed to call it (no grant)  → NOT the link
     * the link arrived truncated, so it is not a uuid → NOT the link
     * the link was revoked, expired, or already used → THE LINK
     * Arzuz is briefly unwell / the phone is offline  → neither

   Before this file, all of them reached the landlord as the same
   sentence — "This link is not valid" — and the actual reason went to
   the console, where nobody looks. That is the worst of the three
   possible behaviours: a person whose site was mid-deploy was told to
   ask for a fresh link, which could not work either, and the one
   thing they needed to do (tell us) was the one thing they were not
   told to.

   The student's Care page makes the same distinction, for the same
   reason: /my-care does not treat every 404 as "bad link", it reads
   the platform's own words and keeps the student's link alive unless
   the answer really was about the link.

   BUILT ON THE SITE-WIDE CLASSIFIER

     The classes that are not about a link — offline, busy (429),
     our-side (5xx), not-switched-on and a refused grant — are
     assets/api-errors.js, the same file every other page now reads.
     This module only adds what an invite link makes different: the
     copy for a link page (a landlord is told "nothing is wrong with
     your link"), and the two link-specific classes, a truncated link
     and a link that is simply gone.

     Composition rather than a second copy is the point: a fix to
     "we could not reach Arzuz" must land on every page at once, and
     a page that re-worded it could not be trusted to.

   Loads as window.ArzuzDraftErrors in a browser and via require() in
   Node, exactly like assets/roommate-score.js. The page must load
   assets/api-errors.js first.

   THE CLASSES, AND WHY EACH ONE'S EXACT BODY IS IN THE TEST

     Every status/code/message pair below was measured against the
     live project on 10 Oct 2026 rather than guessed — see the table
     in dev/admin-test-report.md §20. scripts/test-draft-errors.mjs
     feeds those recorded bodies through classify() so a PostgREST
     upgrade that renames a code fails a suite instead of quietly
     telling a landlord their link is broken.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./api-errors.js'));
  else root.ArzuzDraftErrors = factory(root.ArzuzApiErrors);
})(typeof self !== 'undefined' ? self : this, function (base) {
  'use strict';

  if (!base || typeof base.classify !== 'function') {
    throw new Error('ArzuzDraftErrors needs assets/api-errors.js loaded first');
  }

  var VERSION = '1.2.0';

  /* The number, and the form a link takes, both the base module's
     own — the invite page prints one and links the other. */
  var WHATSAPP = base.WHATSAPP;
  var waNumber = base.waNumber;
  var waLink = base.waLink;

  /* ------------------------------------------------------------
     The words.

     Only the entries a link page has a different answer for live
     here: the shared classes are base.KINDS itself. For the invite
     page "our side" is worth saying "not your link" about, which is
     the one shared sentence this file re-words.
     ------------------------------------------------------------ */

  var KINDS = Object.assign({}, base.KINDS, {
    /* A site fact. The landlord must not be sent to ask for another
       link: the next one cannot work either. */
    'not-ready': {
      outcome: 'dead',
      title: 'This page is not switched on yet',
      body: 'Nothing is wrong with your link. The invite system has not been switched on for this site ' +
        'yet \u2014 Arzuz has to finish setting it up. Message us on WhatsApp and we will sort it out, or ' +
        'send you a fresh link once it is ready.',
      inline: 'Arzuz has not switched the invite system on for this site yet, so this cannot be saved ' +
        'from here. Nothing is wrong with your link \u2014 message us on WhatsApp and we will sort it out. ' +
        'Keep this page open if you want to copy anything out of it.'
    },

    /* The link itself cannot be read as one — almost always WhatsApp
       splitting a long URL across lines, which is why the advice is
       "open it in one piece" rather than "ask for another". */
    'bad-link': {
      outcome: 'dead',
      title: 'This link looks incomplete',
      body: 'Long invite links get broken up when they are forwarded. Open the message and tap the ' +
        'link in one piece, or copy the whole thing including the part after the last dash. If it ' +
        'still does not open, message us on WhatsApp and we will send a fresh one.'
    },

    /* Arrived with no link at all — the token is missing from the URL
       rather than wrong in it, which is what a forward that dropped
       the query string looks like. */
    'no-link': {
      outcome: 'dead',
      title: 'This page needs an invite link',
      body: 'Open the link Arzuz sent you \u2014 this page cannot do anything without it. If you have ' +
        'lost the message, WhatsApp us on the number below and we will send a new one.'
    },

    /* The one class that really is about the link. The original copy,
       kept word for word: it was written for this case and it is
       still right. */
    'dead-link': {
      outcome: 'dead',
      title: 'This link is not valid',
      body: 'The invite link may have been replaced, revoked, expired, or the apartment has ' +
        'already been approved. Ask the Arzuz team to send you a fresh link.'
    },

    /* Everything else, including Arzuz being briefly unwell — the one
       shared sentence a link page says in its own words. */
    error: {
      outcome: 'inline',
      inline: 'Arzuz could not take that just now \u2014 that is our side, not your link. Try again in a ' +
        'minute; if it keeps happening, message us on WhatsApp and we will finish it with you.'
    }
  });

  /* ------------------------------------------------------------
     Telling them apart
     ------------------------------------------------------------ */

  /* 22P02 is Postgres refusing to read the token as a uuid, i.e. the
     link arrived damaged rather than unknown. Checked before the
     shared classifier, which would otherwise read the 400 as a
     refused request — true of the wire, wrong for the landlord. */
  function isMalformed(err) {
    if (!err) return false;
    return err.code === '22P02' || /invalid input syntax for type uuid/i.test(String(err.message || ''));
  }

  /* What a shared class means on a page whose subject is a link. */
  var REMAP = {
    'not-ready': 'not-ready',
    expired: 'not-ready',
    rejected: 'error',
    busy: 'busy',
    offline: 'offline',
    error: 'error'
  };

  /* A string is the page's own reason — "No ref token in the URL" —
     which is always about the link, never about the site. */
  function classify(err, opts) {
    if (typeof err === 'string') return Object.assign({ kind: 'bad-link', reason: err }, KINDS['bad-link']);
    if (isMalformed(err)) return Object.assign({ kind: 'bad-link', reason: '22P02' }, KINDS['bad-link']);
    var shared = base.classify(err, opts);
    var kind = REMAP[shared.kind] || 'error';
    return Object.assign({ kind: kind, reason: shared.reason }, KINDS[kind]);
  }

  /* A descriptor for a class the page has already decided — the
     empty answer from listing_draft_get, which is not an error at
     all but a row that is not there. */
  function state(kind) {
    var k = KINDS[kind];
    if (!k) throw new Error('ArzuzDraftErrors.state: unknown kind "' + kind + '"');
    return Object.assign({ kind: kind, reason: 'decided by the page' }, k);
  }

  /* What goes in the console, so the page's operator line names the
     platform's own words rather than a paraphrase. */
  function detail(err) {
    return base.detail(err);
  }

  return {
    VERSION: VERSION,
    WHATSAPP: WHATSAPP,
    waNumber: waNumber,
    waLink: waLink,
    KINDS: KINDS,
    classify: classify,
    state: state,
    detail: detail,
    isMissingFunction: base.isMissingFunction,
    isRefused: base.isRefused,
    isMalformed: isMalformed,
    isOffline: base.isOffline
  };
});
