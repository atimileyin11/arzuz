/* ============================================================
   Arzuz dev harness — did the page we wrote actually boot?

   dev/listing-harness.html fetches the real listing.html, injects the
   offline fixture, and hands the result to the browser with
   document.write(). The browser then re-requests every script the page
   names. If ONE of those requests is lost — a busy dev server, a reset
   connection — the parser carries on without it and the page's own inline
   boot dies with "Arzuz is not defined". The suite then reports a page
   failure for a page that is perfectly fine, which is a test-fidelity bug
   wearing a page bug's clothes.

   This is the harness's own boot check, and it exists so a lost request
   cannot be mistaken for a broken page:

     · the loader preflights every script before writing the document;
     · this file runs last, after the page's scripts, and confirms the
       shared layer is on window;
     · if it is not, the harness reloads ONCE, with `hreload=1` in the URL
       so the retry is visible in what the suite reads and cannot loop;
     · a second miss is left alone, because a script that is genuinely
       missing must still fail the run.

   It also reports whether the page it wrote is actually STYLED. Every
   check the suite makes is about content — how many gallery slides, which
   feature chips, whether anything overflows — and a stylesheet request lost
   between the document being written and the parser running it would fail
   none of them: the markup is all still there, so a naked page would pass
   as a good one. (The script layer has the guard above; a lost fixture has
   its own evidence, because a page that never booted never reports back.)

   Status, read by scripts/test-listing-render.mjs:
     <html data-harness-boot="pending|ok|retrying|ok-after-retry|still-missing">
     <html data-harness-style="styled|unstyled">
     window.__HARNESS__ = { scripts, expected, boot, retried, caseKey, style }
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

  /* ---------- and it is actually styled ----------
     Every <link rel=stylesheet> the page names is looked up in
     document.styleSheets: a request that never arrived leaves the link with
     no sheet at all (`link.sheet` is null), and an empty sheet is not a
     stylesheet. The verdict is taken at `load` as well, so a stylesheet
     that is merely slow is never called missing — what this catches is one
     that is gone. */
  function styleReport() {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    var linked = links.length, applied = 0;
    for (var i = 0; i < linked; i++) {
      var sheet = links[i].sheet;
      if (!sheet) continue;
      try { if (sheet.cssRules && sheet.cssRules.length) applied++; } catch (e) {}
    }
    /* no stylesheet named at all is its own kind of unstyled */
    return { linked: linked, applied: applied, styled: linked > 0 && applied === linked };
  }

  function markStyle() {
    var r = styleReport();
    cfg.style = r;
    window.__HARNESS__ = cfg;
    document.documentElement.setAttribute('data-harness-style', r.styled ? 'styled' : 'unstyled');
  }

  /* this file is injected immediately before </body>, so the page's own
     scripts have already run by the time it is parsed */
  markStyle();
  if (document.readyState !== 'complete') window.addEventListener('load', markStyle);
  check();
})();
