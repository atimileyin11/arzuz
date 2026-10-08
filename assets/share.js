/* ============================================================
   Arzuz — the share prompt

   A confirmation screen is the one moment a student is pleased
   with Arzuz and has nothing else to do. That is where referrals
   actually happen — but only when the share is one tap and the
   link is worth sending.

   So this is deliberately small: a heading, one honest line, and
   three actions (WhatsApp / copy / the phone's own share sheet).
   Every link it hands out is stamped with a ?ref= channel tag
   through ArzuzRef (assets/attribution.js), because that is what
   turns a share from anonymous traffic into a countable channel
   in the admin Growth view — strategy doc 06 is only a plan until
   these tags exist.

   Two halves on purpose: card() returns markup, wire() makes it
   work. A page can render the card inside HTML it builds itself
   (the form engine's `done` screen is a string) and then call
   wire() once on the container.

   Plain ES5, no dependencies, no inline handlers, no inline
   style. Nothing here trusts its own input: every caller-supplied
   string is escaped, and a tag that does not look like a channel
   is dropped rather than stored.

   Usage:
     root.innerHTML = ArzuzShare.card({ url: 'https://arzuz.com/register' });
     ArzuzShare.wire(root);
   ============================================================ */

var ArzuzShare = (function () {

  /* A share that arrives with no tag is still worth making — it just
     cannot be attributed. This is the tag the student's own share
     carries, so their friends' registrations land in the Growth view
     as one channel instead of "no idea". */
  var DEFAULT_TAG = 'student-share';

  var DEFAULT_HEADING = 'Know someone still looking?';
  var DEFAULT_BODY = 'Send them the link \u2014 it takes them straight to the sign-up, and we will know it came from you.';
  var DEFAULT_TEXT = 'Arzuz is matching students to verified rooms near KWASU \u2014 real prices, zero agent fees. Have a look:';

  /* Says what the tag is for in the student's own interest, because a
     prompt that explains itself earns the tap. */
  var DEFAULT_NOTE = 'Each share carries its own tag, so we can tell which ones bring students in.';

  var RESTORE_MS = 4200;

  /* Same escaper as assets/strategy.js — one convention, so a string
     that is safe in one surface is safe in all of them. */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /* ------------------------------------------------------------
     Tags and links

     ArzuzRef owns the tag rules; this file repeats only the tiny
     validator so a page that forgot to load attribution.js still
     shares a working, correctly-tagged link instead of a broken
     one. It never invents a tag — an invalid one becomes ''.
     ------------------------------------------------------------ */

  function fallbackTag(raw) {
    if (typeof raw !== 'string') return '';
    var tag = raw.trim().toLowerCase()
      .replace(/^[\s._-]+/, '')
      .replace(/[\s._-]+$/, '');
    if (!tag || tag.length > 40) return '';
    if (!/^[a-z0-9._-]+$/.test(tag)) return '';
    /* Token-shaped, not channel-shaped — same three exact shapes as
       sanitize() in assets/attribution.js, so the two never disagree
       about what a tag is. */
    if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tag)) return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tag)) return '';
    if (/[+\/=]/.test(tag)) return '';
    return tag;
  }

  function cleanTag(raw) {
    try {
      if (window.ArzuzRef && ArzuzRef.share) return ArzuzRef.share(raw);
    } catch (e) { /* fall through to the local copy of the rule */ }
    return fallbackTag(raw);
  }

  /* Outbound links are pasted into other apps, so they must be
     absolute — a relative "/register" is useless in a WhatsApp
     message. Relative-input support keeps callers simple. */
  function absolutize(url) {
    var href = String(url === null || url === undefined ? '' : url);
    if (!href) return '';
    if (!window.location) return href;
    try { return new URL(href, window.location.href).toString(); }
    catch (e) { return href; }
  }

  /* set() rather than append(), so re-tagging a link can never leave
     two `ref` params for the server to disagree about. */
  function appendRef(href, tag) {
    if (!tag) return href;
    if (!window.location) return href;
    try {
      var abs = new URL(href, window.location.href);
      abs.searchParams.set('ref', tag);
      return abs.toString();
    } catch (e) {
      return href + (href.indexOf('?') === -1 ? '?' : '&') + 'ref=' + encodeURIComponent(tag);
    }
  }

  function taggedUrl(url, tag) {
    var absolute = absolutize(url);
    if (!absolute) return '';
    var t = cleanTag(tag || DEFAULT_TAG);
    if (!t) return absolute;                 // share anyway, just untagged
    try {
      if (window.ArzuzRef && ArzuzRef.link) return ArzuzRef.link(absolute, t);
    } catch (e) { /* fall through */ }
    return appendRef(absolute, t);
  }

  /* wa.me with no number opens the picker, which is exactly what a
     share wants: the sender chooses who gets it. */
  function waHref(text, url, tag) {
    var link = taggedUrl(url, tag);
    if (!link) return '';
    var message = String(text || DEFAULT_TEXT);
    return 'https://wa.me/?text=' + encodeURIComponent(message + '\n' + link);
  }

  /* ------------------------------------------------------------
     Markup
     ------------------------------------------------------------ */

  /* The share arrow, drawn rather than typed: an emoji glyph renders
     differently on every phone, a path never does. */
  function icon() {
    return '<span class="share-ic" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 12.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7.5"/>' +
      '<path d="M12 3v12"/>' +
      '<path d="M7.6 7.4 12 3l4.4 4.4"/>' +
      '</svg></span>';
  }

  function card(opts) {
    var o = opts || {};
    var url = absolutize(o.url);
    if (!url) return '';                     // nothing to share — render nothing

    var tag = cleanTag(o.tag || DEFAULT_TAG);
    var heading = o.heading ? String(o.heading) : DEFAULT_HEADING;
    var body = o.body ? String(o.body) : DEFAULT_BODY;
    var text = o.text ? String(o.text) : DEFAULT_TEXT;
    var note = o.note ? String(o.note) : DEFAULT_NOTE;
    var compact = !!o.compact;

    /* canShare is decided here, at render time, so the native button is
       never in the layout for a browser that cannot honour it. */
    var canShare = false;
    try { canShare = typeof navigator !== 'undefined' && !!navigator.share; } catch (e) {}

    /* A WhatsApp link with an empty href would reload the page when
       tapped, so the attribute is only written when there is a real
       destination. In practice `url` is always set here — this is the
       guard that keeps that from becoming a silent footgun later. */
    var wa = waHref(text, url, tag);

    return '<div class="share-card' + (compact ? ' share-compact' : '') + '" data-share-card' +
        ' data-share-url="' + esc(url) + '" data-share-text="' + esc(text) + '"' +
        ' data-share-tag="' + esc(tag) + '" data-share-heading="' + esc(heading) + '">' +
      '<div class="share-head">' +
        (compact ? '' : icon()) +
        '<div class="share-tx"><b>' + esc(heading) + '</b><span>' + esc(body) + '</span></div>' +
      '</div>' +
      '<div class="share-acts">' +
        '<a class="share-btn share-wa" data-share="wa" target="_blank" rel="noopener"' +
          (wa ? ' href="' + esc(wa) + '"' : '') + '>Send on WhatsApp</a>' +
        '<button type="button" class="share-btn" data-share="copy">Copy link</button>' +
        /* class and attribute together, exactly as hydrate() keeps them */
        '<button type="button" class="share-btn ghost' + (canShare ? '' : ' hidden') + '"' +
          ' data-share="native"' + (canShare ? '' : ' hidden') + '>Share</button>' +
      '</div>' +
      '<p class="share-note" data-share-note aria-live="polite">' + esc(note) + '</p>' +
    '</div>';
  }

  /* ------------------------------------------------------------
     Behaviour
     ------------------------------------------------------------ */

  function cardOf(el) {
    while (el && el !== document) {
      if (el.getAttribute && el.getAttribute('data-share-card') !== null) return el;
      el = el.parentNode;
    }
    return null;
  }

  function noteEl(cardEl) {
    return cardEl ? cardEl.querySelector('[data-share-note]') : null;
  }

  /* Feedback is written into the note line, never into a toast: on the
     confirmation screen the note is already the place the eye is, and
     a floating toast would cover the very button just tapped. The
     timer hangs off the element itself, so one card's countdown can
     never cancel another card's. */
  function setNote(cardEl, message, kind) {
    var el = noteEl(cardEl);
    if (!el) return;
    if (el.getAttribute('data-share-original') === null) {
      el.setAttribute('data-share-original', el.textContent || '');
    }
    el.textContent = message;
    el.className = 'share-note' + (kind ? ' ' + kind : '');

    if (el.__arzuzShareTimer) clearTimeout(el.__arzuzShareTimer);
    el.__arzuzShareTimer = setTimeout(function () {
      var back = el.getAttribute('data-share-original');
      el.textContent = back === null ? '' : back;
      el.className = 'share-note';
      el.__arzuzShareTimer = null;
    }, RESTORE_MS);
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    /* Old WebViews (and any non-secure origin) have no clipboard API.
       The textarea trick still works, so copy does not silently fail. */
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  }

  /* Every card is re-read from its own data attributes, so a card that
     was rendered before attribution.js finished loading still ends up
     with a correct, tagged href. */
  function hydrate(scope) {
    var cards = [];
    if (scope.getAttribute && scope.getAttribute('data-share-card') !== null) cards.push(scope);
    if (scope.querySelectorAll) {
      var found = scope.querySelectorAll('[data-share-card]');
      for (var i = 0; i < found.length; i++) cards.push(found[i]);
    }

    for (var k = 0; k < cards.length; k++) {
      var cardEl = cards[k];
      var url = cardEl.getAttribute('data-share-url') || '';
      var text = cardEl.getAttribute('data-share-text') || DEFAULT_TEXT;
      var tag = cardEl.getAttribute('data-share-tag') || '';
      var link = taggedUrl(url, tag);

      var wa = cardEl.querySelector('[data-share="wa"]');
      /* never write an empty href: an anchor with href="" reloads the
         page, which would look like the share button is broken */
      if (wa && link) {
        var href = waHref(text, url, tag);
        if (href) wa.setAttribute('href', href);
      }

      var native = cardEl.querySelector('[data-share="native"]');
      if (native) {
        var canShare = false;
        try { canShare = !!navigator.share; } catch (e) {}
        /* the class and the attribute are kept in step on purpose: the
           attribute hides the button before this script runs, the class
           is what the stylesheet actually reads */
        if (canShare) {
          native.classList.remove('hidden');
          native.removeAttribute('hidden');
        } else {
          native.classList.add('hidden');
          native.setAttribute('hidden', 'hidden');
        }
      }
    }
  }

  function onClick(event) {
    var el = event.target;
    /* closest() is already the project's convention for this in
       listing.html and admin.js. */
    var btn = el && el.closest ? el.closest('[data-share]') : null;
    if (!btn) return;
    var cardEl = cardOf(btn);
    if (!cardEl) return;

    var kind = btn.getAttribute('data-share');
    if (kind === 'wa') return;               // a real anchor: let the browser do its job

    var url = cardEl.getAttribute('data-share-url') || '';
    var text = cardEl.getAttribute('data-share-text') || DEFAULT_TEXT;
    var tag = cardEl.getAttribute('data-share-tag') || '';
    var link = taggedUrl(url, tag);
    if (!link) return;

    if (kind === 'copy') {
      copyText(link, function (ok) {
        if (ok) {
          setNote(cardEl, 'Link copied \u2014 ready to paste anywhere.', 'ok');
        } else {
          /* Honest dead-end instead of a button that does nothing: the
             link is printed so it can still be long-pressed and copied. */
          setNote(cardEl, 'Could not copy automatically \u2014 long-press this link instead: ' + link, 'err');
        }
      });
      return;
    }

    if (kind === 'native') {
      if (!navigator.share) return;
      navigator.share({
        title: cardEl.getAttribute('data-share-heading') || DEFAULT_HEADING,
        text: text,
        url: link
      }).catch(function (err) {
        /* The user closing the sheet is not an error worth reporting. */
        if (err && err.name === 'AbortError') return;
        copyText(link, function (ok) {
          setNote(cardEl, ok
            ? 'Your phone declined the share sheet \u2014 the link is copied instead.'
            : 'Sharing is unavailable here \u2014 long-press this link instead: ' + link,
            ok ? 'ok' : 'err');
        });
      });
    }
  }

  /* One delegated listener per container, and idempotent: a page that
     re-renders its `done` screen can call wire() again without
     stacking handlers and double-firing copies. */
  function wire(root) {
    var scope = root || document;
    if (!scope || !scope.addEventListener) return;
    if (scope.__arzuzShareWired) { hydrate(scope); return; }
    scope.__arzuzShareWired = true;
    hydrate(scope);
    scope.addEventListener('click', onClick);
  }

  return {
    DEFAULT_TAG: DEFAULT_TAG,
    DEFAULT_HEADING: DEFAULT_HEADING,
    DEFAULT_BODY: DEFAULT_BODY,
    DEFAULT_TEXT: DEFAULT_TEXT,
    DEFAULT_NOTE: DEFAULT_NOTE,
    card: card,
    wire: wire,
    hydrate: hydrate,
    taggedUrl: taggedUrl,
    waHref: waHref,
    escape: esc
  };
})();

if (typeof window !== 'undefined') window.ArzuzShare = ArzuzShare;
