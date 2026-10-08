/* ============================================================
   Arzuz listing page — offline data fixture (DEV ONLY)

   Loaded only by dev/listing-harness.html, which is loaded by
   dev/listing-harness.html → scripts/test-listing-render.mjs.
   Nothing in listing.html references this file, so it cannot
   reach production.

   What it does
   ------------
     1. Replaces window.fetch so every Supabase call is answered
        from the dataset below. It is the source of every
        response, so it performs no network write at all — it is
        safe to point at the real project.
     2. Records every intercepted call, every console error, every
        uncaught error and the result of a layout overflow probe
        into #__fx-diag, which scripts/test-listing-render.mjs reads
        back out of `chrome --headless --dump-dom`.
     3. Renders a "Demo data / Worst case / …" switcher so a human
        can flip cases on the real page and look at them.

   Cases are also readable from Node, with no DOM:
     const CASES = vm.runInNewContext(SRC + '; ARZUZ_LISTING_FIXTURE')
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------- the datasets ---------- */

  /* six local files exist under assets/ — recycle them so the fixture
     never triggers a 404 that would muddy the console/error capture */
  var IMGS = [
    '/assets/social/og-image.png',
    '/assets/icons/icon-512.png',
    '/assets/logo-mark.svg',
    '/assets/icons/icon-192.png',
    '/assets/icons/apple-touch-icon.png',
    '/assets/icons/icon-32.png'
  ];
  var TOUR = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

  /* URLs must be distinct or buildMedia's de-duplication collapses the
     gallery — a "50 photos" case built from 6 URLs really renders 6 */
  function gallery(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({ type: 'image', url: IMGS[i % IMGS.length] + '?n=' + i, label: i === 0 ? 'Cover photo' : 'Photo ' + (i + 1) });
    }
    return out;
  }

  var DESC_LONG = (function () {
    var bits = [];
    for (var i = 1; i <= 12; i++) {
      bits.push('Paragraph ' + i + ': the compound is fenced, the borehole runs all day and the prepaid meter is ' +
        'recharged from the kiosk by the gate. <script>alert(1)</script> & "quotes" and apostrophes\' all render as text.');
    }
    return bits.join('\n\n');
  })();

  var CASES = {

    /* ---- the control: what the design was built against ---- */
    demo: {
      label: 'Demo data',
      note: 'the happy path — everything filled in, three photos',
      row: {
        id: 'fx-demo-0001',
        tier: 2,
        latitude: 8.7113,
        longitude: 4.4697,
        payload: {
          prop_name: 'Ilorin Close Self-Contain',
          ty: 'Self-contain',
          rent: '185000',
          ar: 'Malete',
          rm: '1 room',
          neg: 'Negotiable on a full-session payment',
          ut: ['Borehole water', 'NEPA connection', 'Prepaid meter', 'Security / gateman'],
          desc: 'A quiet self-contain on Ilorin Close, two minutes past the second gate. New tiles, ' +
                'a private bathroom and a prepaid meter so you only pay for what you use.\n' +
                'The compound is fenced with a working gate and the caretaker lives on site.',
          split_ok: false,
          media: gallery(3),
          passage: {
            landmark: 'Beside the blue mosque, brown double gate.',
            gate: 'The left gate — the right one is bolted.',
            floor: 'First floor, room 3.',
            steps: [
              { text: 'From the KWASU main gate, walk south past the filling station.' },
              { text: 'Turn right at the mosque; the compound is 40m down.', lat: 8.7109, lng: 4.4692 }
            ]
          }
        }
      }
    },

    /* ---- the aggressive mix: several realistic failures in one row ---- */
    worst: {
      label: 'Worst case',
      note: 'unbroken long name, formatted rent, ' +
            'blank/number entries in ut, half-filled media entries, multi-script text, a long ' +
            'negotiable note, an unformatted long name',
      row: {
        id: 'fx-worst-0001',
        /* an unparseable tier must still read as a badge, never as "NaN" */
        tier: 'verified',
        latitude: 8.7113,
        longitude: null,
        payload: {
          /* no maximum length is enforced anywhere in the dashboard or in
             the column, so this is what an owner who types in caps with no
             spaces produces — and nothing can break it */
          prop_name: 'OLUWASEUNBABATUNDEADEGOKEMEMORIALSTUDENTLODGEANDSUITESSMALETE',
          ty: 'Face-me-I-face-you, self-contained bathroom, shared kitchen',
          /* a formatted price — what a hand-edited row or a CSV import looks like */
          rent: '150,000',
          ar: 'Àgọ́ Ọ̀jọ̀',
          rm: '',
          neg: 'Copies of the tenancy agreement, the receipts and a signed inventory list are required ' +
               'before the keys change hands, and the landlord prefers a full-session payment upfront',
          ut: ['Borehole water', '', null, 42, 'Prepaid meter',
               'Standby generator with an automatic changeover switch',
               'Security / gateman on duty every night including weekends'],
          desc: DESC_LONG,
          split_ok: 'yes',
          /* half-filled media entries: one with no url at all, one with no type,
             one video url that is not a YouTube link */
          media: [
            { type: 'image', url: '', label: 'empty url' },
            { url: IMGS[1] },
            { type: 'video', url: 'https://example.com/not-a-video.mp4', label: 'Uploaded tour' },
            { type: 'image', url: IMGS[2], label: 'Third' }
          ],
          passage: {
            landmark: 'Mobil filling station عند التقاطع, opposite the second gate',
            gate: 42,
            floor: null,
            steps: [null, { text: '   ' }, { text: 'Turn right at the mosque', lat: 'x', lng: 'y' },
                    'Go past the yellow kiosk and the compound is the third gate on the left']
          }
        }
      }
    },

    /* ---- a half-set pin: latitude but no longitude ---- */
    halfpos: {
      label: 'Latitude only',
      note: 'a pin was started and never finished — lat set, lng empty',
      row: {
        id: 'fx-halfpos-0001',
        tier: 1,
        latitude: 8.7113,
        longitude: '',
        payload: {
          prop_name: 'Adebayo Lodge',
          ty: 'Self-contain',
          rent: '170000',
          ar: 'Malete',
          ut: ['Borehole water'],
          desc: 'Pin was dropped but the longitude never saved.',
          media: gallery(2)
        }
      }
    },

    /* ---- no payload at all ---- */
    empty: {
      label: 'Empty',
      note: 'no payload key, no media, no pin — every optional field absent',
      row: {
        id: 'fx-empty-0001'
      }
    },

    /* ---- exactly one of everything ---- */
    one: {
      label: 'One item',
      note: 'a single photo, a single feature — every count is 1',
      row: {
        id: 'fx-one-0001',
        tier: 1,
        latitude: 8.7113,
        longitude: 4.4697,
        payload: {
          prop_name: 'Jo Lodge',
          ty: 'Hostel bunk',
          rent: '95000',
          ar: 'Malete',
          ut: ['Borehole water'],
          desc: 'One room, one photo.',
          media: [{ type: 'image', url: IMGS[0], label: 'Cover photo' }]
        }
      }
    },

    /* ---- the realistic upper bound ---- */
    huge: {
      label: '1,000-row scale list',
      note: '50 media items, 40 features, a 12-step passage, a nine-figure rent and a very long description',
      row: {
        id: 'fx-huge-0001',
        tier: 3,
        latitude: 8.7113,
        longitude: 4.4697,
        payload: {
          prop_name: 'Grand Imperial Student Village Phase 2 Annex Extension',
          ty: 'Face-me-I-face-you',
          rent: '123456789',
          ar: 'Malete',
          rm: '40 rooms available',
          neg: 'No',
          ut: (function () {
            var out = [];
            for (var i = 1; i <= 40; i++) out.push('Amenity number ' + i + ' with a fairly long label');
            return out;
          })(),
          desc: DESC_LONG + '\n\n' + DESC_LONG,
          split_ok: true,
          media: gallery(49).concat([{ type: 'video', url: TOUR, label: 'Video tour' }]),
          passage: {
            landmark: 'At the junction by the big mast, brown and cream building.',
            gate: 'Second gate on the right after the mast.',
            floor: 'Block C, first floor.',
            steps: (function () {
              var out = [];
              for (var i = 1; i <= 12; i++) {
                out.push({ text: 'Step ' + i + ': keep walking past the kiosk and turn at the fence.',
                           lat: 8.71 + i / 1000, lng: 4.469 + i / 1000 });
              }
              return out;
            })()
          }
        }
      }
    }
  };

  var ORDER = ['demo', 'worst', 'halfpos', 'empty', 'one', 'huge'];

  var API = { cases: CASES, order: ORDER, images: IMGS, tour: TOUR };
  global.ARZUZ_LISTING_FIXTURE = API;

  /* Node reads the datasets and stops here. */
  if (typeof document === 'undefined') return;

  /* ---------- browser side: stub, diagnostics, switcher ---------- */

  var params = new URLSearchParams(global.location.search);
  var CASE = params.get('case') || params.get('fx') || 'demo';
  if (!CASES[CASE]) CASE = 'demo';

  var DIAG = {
    case: CASE,
    errors: [],
    calls: [],
    writes: [],
    overflow: null,
    thumbsPositioned: null,
    contentChars: 0,
    errorShown: null
  };

  function diag() {
    var el = document.getElementById('__fx-diag');
    if (el) el.textContent = JSON.stringify(DIAG);
  }

  /* -- capture everything that went wrong -- */
  var _err = global.console && global.console.error;
  if (_err) {
    global.console.error = function () {
      DIAG.errors.push(Array.prototype.map.call(arguments, String).join(' '));
      diag();
      return _err.apply(global.console, arguments);
    };
  }
  global.addEventListener('error', function (e) {
    DIAG.errors.push('uncaught: ' + (e.message || e.type) + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
    diag();
  });
  global.addEventListener('unhandledrejection', function (e) {
    DIAG.errors.push('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason));
    diag();
  });

  /* -- answer every backend call locally -- */
  var CALL_PAT = /supabase\.co|\/rest\/v1\/|\/api\/|\.netlify\/functions/;
  var realFetch = global.fetch;

  global.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (!CALL_PAT.test(url)) {
      /* fonts and tiles are allowed through — a 404 in the console is a real signal */
      return realFetch.apply(global, arguments);
    }
    DIAG.calls.push(method + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
    if (method !== 'GET' && method !== 'HEAD') DIAG.writes.push(method + ' ' + url);
    diag();

    var body;
    if (url.indexOf('public_listings') !== -1) body = [CASES[CASE].row];
    else if (/\/api\/notify/.test(url)) body = { ok: true };
    else body = [];
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  };

  /* -- the layout probe ---------------------------------------------------
     Removing the motion gate is deliberate: an entrance transform would
     move every rect we compare. Without it we measure the settled layout —
     which is also the layout a no-JS or reduced-motion visitor gets. */
  function probe() {
    var de = document.documentElement;
    document.documentElement.classList.remove('motion-ready');

    /* three ways an element can be too wide, checked in that order:
         text escapes its box   — an unbreakable string in a fixed-width box
                                  (the box has min-width:auto and grew with it,
                                  so comparing the box to itself finds nothing)
         box escapes its parent — the element itself is wider than the thing
                                  that contains it, even when the page survives
         content clipped        — hidden behind an overflow with no way to see it */
    var offenders = [];
    var SEL = ['#ldContent h1', '.ld-sub span', '.stat-chip', '.feat', '.feat > span:last-child',
               '.desc', '.psg-kv > span:last-child', '.ld-price', '.route-meta', '.h-badge',
               '.ld-content-note', '.gal-slide .cr'];
    SEL.forEach(function (sel) {
      var nodes;
      try { nodes = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(nodes, function (el, i) {
        var box = el.getBoundingClientRect();
        if (!box.width) return;
        var why = null, by = 0;

        var range = document.createRange();
        range.selectNodeContents(el);
        var txt = range.getBoundingClientRect();
        if (txt.width && txt.right > box.right + 1.5) { why = 'text escapes its box'; by = txt.right - box.right; }

        var par = el.parentElement;
        if (!why && par) {
          var pb = par.getBoundingClientRect();
          if (pb.width && box.right > pb.right + 1.5) { why = 'box escapes its parent'; by = box.right - pb.right; }
        }

        if (!why && el.scrollWidth > el.clientWidth + 1.5 &&
            getComputedStyle(el).overflow !== 'visible') {
          why = 'content clipped'; by = el.scrollWidth - el.clientWidth;
        }

        if (why) {
          offenders.push({
            sel: sel + '[' + i + ']',
            why: why,
            by: Math.round(by),
            text: String(el.textContent || '').trim().slice(0, 48)
          });
        }
      });
    });

    /* does any ancestor give .gal-thumb.has-video::after a containing block?
       It uses inset:0, so a static chain sends the ▶ overlay to the page origin. */
    var vt = document.querySelector('.gal-thumb.has-video');
    if (vt) {
      var node = vt, positioned = null;
      while (node && node !== document.body) {
        if (getComputedStyle(node).position !== 'static') { positioned = node.className || node.tagName; break; }
        node = node.parentElement;
      }
      DIAG.thumbsPositioned = positioned || false;
    }

    DIAG.overflow = {
      viewport: de.clientWidth,
      docScrollW: de.scrollWidth,
      horizontal: de.scrollWidth > de.clientWidth + 1,
      offenders: offenders
    };

    var content = document.getElementById('ldContent');
    DIAG.contentChars = content ? String(content.textContent || '').length : 0;
    DIAG.errorShown = !!(document.getElementById('ldError') &&
                         document.getElementById('ldError').style.display !== 'none');
    diag();
  }

  function whenRendered(cb) {
    var tries = 0;
    (function step() {
      var c = document.getElementById('ldContent');
      var done = (c && c.innerHTML.length > 0) ||
                 (tries > 40 && document.getElementById('ldError') &&
                  document.getElementById('ldError').style.display !== 'none');
      tries++;
      if (done || tries > 120) return setTimeout(cb, 220);
      setTimeout(step, 80);
    })();
  }

  /* -- the switcher: dev chrome, not part of the design under test -- */
  function switcher() {
    var bar = document.createElement('div');
    bar.setAttribute('data-fx-chrome', '1');
    bar.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;' +
      'display:flex;gap:4px;align-items:center;padding:5px;border-radius:999px;' +
      'background:#e5e7eb;font:500 12px/1 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.22)';
    var lbl = document.createElement('span');
    lbl.textContent = 'listing data';
    lbl.style.cssText = 'color:#374151;padding:0 8px 0 10px';
    bar.appendChild(lbl);

    ORDER.forEach(function (k) {
      var on = k === CASE;
      var a = document.createElement('a');
      a.href = '?case=' + k;
      a.textContent = CASES[k].label;
      a.title = CASES[k].note;
      a.setAttribute('data-fx-case', k);
      a.style.cssText = 'text-decoration:none;padding:6px 11px;border-radius:999px;' +
        (on ? 'background:#fff;color:#111827;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.16)'
            : 'color:#4b5563');
      bar.appendChild(a);
    });
    document.body.appendChild(bar);

    var d = document.createElement('div');
    d.id = '__fx-diag';
    d.setAttribute('data-fx-chrome', '1');
    d.hidden = true;
    document.body.appendChild(d);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { switcher(); whenRendered(probe); });
  } else {
    switcher();
    whenRendered(probe);
  }
})(typeof window !== 'undefined' ? window : globalThis);
