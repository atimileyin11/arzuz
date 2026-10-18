/* ============================================================
   Arzuz — the referral click beacon

   A personal share link is /register?ref=<code>, and the Growth view
   already counts the registrations that carry it. What it cannot see
   is the visits that did not convert — so this fires one best-effort
   ping per session when the current tag has a code's shape, and the
   referrer's dashboard can show the top of the funnel honestly.

   Loaded on the pages personal links land on (register.html,
   care-pass.html). Never imported, never awaited, never trusted:
   no fetch, no tag, or a blocked beacon all mean silence, and a click
   is logged but never rewarded — only a verified payment qualifies.

   Plain ES5, no dependencies.
   ============================================================ */

var ArzuzReferralClick = (function () {

  var SESSION_KEY = 'arzuz_refclick_v1';

  /* The code's shape, mirrored from netlify/functions/finance.js:
     AZ- plus 4-8 unambiguous chars. A channel tag like
     whatsapp-status must never become a click. Kept as a copy rather
     than an import on purpose: this file ships to browsers, the
     function does not, and scripts/test-referrals.mjs asserts the two
     agree rather than sharing a line that could rot silently. */
  function isCode(raw) {
    return /^AZ-[A-Z0-9]{4,8}$/.test(String(raw || '').trim().toUpperCase());
  }

  function seen(tag) {
    try {
      var v = sessionStorage.getItem(SESSION_KEY);
      if (!v) return false;
      return String(v).split(',').indexOf(tag) !== -1;
    } catch (e) { return false; }
  }

  function mark(tag) {
    try {
      var v = sessionStorage.getItem(SESSION_KEY);
      var list = v ? String(v).split(',') : [];
      if (list.indexOf(tag) === -1) list.push(tag);
      sessionStorage.setItem(SESSION_KEY, list.slice(-10).join(','));
    } catch (e) { /* a beacon that cannot remember still fires once */ }
  }

  function ping(tag) {
    var payload = JSON.stringify({
      action: 'referral_click',
      code: tag,
      env: (window.ARZUZ_CONFIG && window.ARZUZ_CONFIG.ENV) || 'production'
    });
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon('/api/finance', payload);
        return;
      }
      if (typeof fetch !== 'undefined') {
        fetch('/api/finance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* the funnel misses one visit — never the visitor */ }
  }

  /* Read the tag the way attribution filed it and ping once per session.
     Returns the code when it pinged, '' otherwise — the return is for
     the suite, not the page. */
  function boot() {
    var tag = '';
    try {
      if (window.ArzuzRef && window.ArzuzRef.tag) tag = window.ArzuzRef.tag();
    } catch (e) { tag = ''; }
    if (!isCode(tag)) return '';
    var code = String(tag).trim().toUpperCase();
    if (seen(code)) return '';
    mark(code);
    ping(code);
    return code;
  }

  return { boot: boot, isCode: isCode };
})();

if (typeof window !== 'undefined') window.ArzuzReferralClick = ArzuzReferralClick;
/* The pages this ships on call boot() themselves after ArzuzRef has
   captured the tag — attribution.js runs at load, this runs after it. */
