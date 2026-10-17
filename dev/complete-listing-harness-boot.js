/* ============================================================
   Arzuz dev harness — did the page we wrote actually boot?

   dev/complete-listing-harness.html fetches the real
   complete-listing.html, stubs Supabase at the mock RPC boundary, and hands
   the result to the browser with document.write(). The browser then
   re-requests every script the page names. If ONE of those requests is lost
   — a busy dev server, a reset connection — the parser carries on without it.

   On this page that failure is quiet and total. Every layer except the page's
   OWN boot script is reached through a `typeof` guard, so a lost
   api-errors.js or arzuz-map.js degrades one feature; a lost
   complete-listing.js leaves the form sitting on its loading card with
   nothing in the console to say why. scripts/test-invite-render.mjs used to
   report that as "the page never settled", which is a test-fidelity bug
   wearing a page bug's clothes.

   So the harness repairs it, the way dev/listing-harness-boot.js does for the
   listing page:

     · the loader preflights every LOCAL script before writing the document
       (dev/complete-listing-harness.html);
     · this file runs last, after the page's scripts, and confirms the layer
       the boot needs is on window;
     · if it is not, the harness reloads ONCE, with `hreload=1` in the URL so
       the retry is visible in what the suite reads and cannot loop;
     · a second miss is left alone, because a script that is genuinely missing
       must still fail the run.

   Deliberately NO stylesheet guard here, unlike the listing harness. This
   page links Leaflet's sheet from unpkg, and a machine with no network is
   expected to fail that request — a guard that counted it would turn an
   offline laptop into a page verdict. The suite still asserts that arzuz.css
   itself arrived and parsed, which is the sheet that carries this page.

   Status, read by scripts/test-invite-render.mjs:
     <html data-harness-boot="pending|ok|retrying|ok-after-retry|still-missing|preflight-failed">
     window.__HARNESS__ = { scripts, expected, boot, missing, retried, seed }
   ============================================================ */

(function () {
  'use strict';

  var cfg = window.__HARNESS__ || {};
  var expected = cfg.expected || [];

  function mark(state, detail) {
    document.documentElement.setAttribute('data-harness-boot', state);
    cfg.boot = state;
    window.__HARNESS__ = cfg;
    try { console.log('[harness] boot ' + state + (detail ? ' — ' + detail : '')); } catch (e) {}
  }

  function check() {
    var gone = expected.filter(function (name) { return typeof window[name] === 'undefined'; });

    if (!gone.length) {
      mark(cfg.retried ? 'ok-after-retry' : 'ok');
      return;
    }

    cfg.missing = gone;
    window.__HARNESS__ = cfg;

    if (cfg.retried) {
      /* the second load lost it too: say so and leave it for the suite */
      mark('still-missing', gone.join(', '));
      return;
    }

    mark('retrying', gone.join(', '));
    var url = new URL(location.href);
    url.searchParams.set('hreload', '1');
    location.replace(url.toString());
  }

  /* this file is injected immediately before </body>, so the page's own
     scripts have already run by the time it is parsed */
  check();
})();
