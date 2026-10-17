/* ============================================================
   Arzuz dev harness — did the page we sent actually boot?

   Two of the four browser suites drive a page that has no document.write
   harness. scripts/test-admin-worst.mjs loads the dashboard's own dev mode
   (admin.html?mock=1), and scripts/test-home-motion.mjs loads the real
   index.html with nothing stubbed at all. dev/listing-harness.html and
   dev/complete-listing-harness.html carry their own boot check; these two
   pages have nowhere to put one, so the harness is THIS file, injected by a
   dev-only block at the end of each page (localhost only — see the bottom of
   admin.html and index.html). Nothing here ships, and nothing here mocks or
   stubs anything: it looks, and it repairs.

   WHY THE REPAIR IS NEEDED

   A request lost between the page being sent and the parser running it (a
   busy dev server, a reset connection) leaves a script the page's own boot
   needs out of the document, and the parser carries on without it. On the
   homepage that failure is completely silent: assets/motion.js never adds
   html.motion-ready, so every reveal target stays hidden, and the inline boot
   dies with "Arzuz is not defined". The suites saw that as a page bug —
   "the motion layer booted" and "the dashboard never settled" are both test
   fidelity bugs wearing a page bug's clothes.

   So this check reloads ONCE, the way the other two harnesses do:

     · it runs LAST, after the page's own scripts, and asks for the layer the
       page's boot needs (LAYERS, keyed by the page it finds itself on);
     · if any of that layer is missing it reloads once with `hreload=1` in the
       URL, so the retry is visible in what the suite reads and cannot loop;
     · a second miss is left alone, because a script that is genuinely missing
       must still fail the run.

   There is deliberately NO preflight here, unlike dev/listing-harness.html and
   dev/complete-listing-harness.html. Those two WRITE the document, so they can
   ask for every script before writing it; these pages are served whole, and
   nothing this file does can happen before the parser has already asked for
   them. The repair is the reload — and the suites' fault modes are what prove
   it, by killing one of these requests at the network layer and requiring the
   page to come back booted.

   Status, read by the suites through window.__HARNESS__ — the same vocabulary
   the other two harnesses publish:
     <html data-harness-boot="ok|retrying|ok-after-retry|still-missing">
     window.__HARNESS__ = { page, layers, scripts, expected, boot, missing, retried }

   Each layer entry is [a script the page names, the global it must leave on
   window]. ArzuzMotion is the one to watch on the homepage: assets/motion.js
   adds html.motion-ready as its first statement and returns its API at the
   end, so the global exists exactly when the class does.
   ============================================================ */

(function () {
  'use strict';

  var LAYERS = {
    'admin.html': [
      ['assets/admin.js', 'ArzuzAdmin'],
      ['dev/admin-mock-data.js', 'ArzuzMockData'],
      ['dev/admin-mock.js', '__MOCK__']
    ],
    'index.html': [
      ['assets/app.js', 'Arzuz'],
      ['assets/data.js', 'ArzuzData'],
      ['assets/motion.js', 'ArzuzMotion']
    ]
  };

  var page = location.pathname.split('/').pop() || 'index.html';
  var rows = LAYERS[page];
  if (!rows) return;   /* a page this file has no opinion about never reloads */

  var cfg = window.__HARNESS__ || {};
  cfg.page = page;
  cfg.layers = rows;
  cfg.scripts = rows.map(function (r) { return r[0]; });
  cfg.expected = rows.map(function (r) { return r[1]; });
  cfg.retried = new URLSearchParams(location.search).get('hreload') === '1';
  window.__HARNESS__ = cfg;

  function mark(state, detail) {
    document.documentElement.setAttribute('data-harness-boot', state);
    cfg.boot = state;
    window.__HARNESS__ = cfg;
    try { console.log('[harness] boot ' + state + (detail ? ' — ' + detail : '')); } catch (e) {}
  }

  var gone = cfg.expected.filter(function (name) { return typeof window[name] === 'undefined'; });

  if (!gone.length) {
    mark(cfg.retried ? 'ok-after-retry' : 'ok');
    return;
  }

  cfg.missing = gone;
  window.__HARNESS__ = cfg;

  if (cfg.retried) {
    /* the second document lost it too: say so and leave it for the suite */
    mark('still-missing', gone.join(', '));
    return;
  }

  mark('retrying', gone.join(', '));
  var url = new URL(location.href);
  url.searchParams.set('hreload', '1');
  location.replace(url.toString());
})();
