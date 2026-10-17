/* ============================================================
   Arzuz listing page — offline data fixture (DEV ONLY)

   Loaded only by dev/listing-harness.html, which is loaded by
   scripts/test-listing-render.mjs. Nothing in listing.html
   references this file, so it cannot reach production.

   The cases are GENERATED, not written out
   ----------------------------------------
   `MATRIX` declares every state each field the page resolves can be
   in, and each case declares the (field · state) pairs it is there to
   exercise. `buildRow()` builds the row FROM those declarations, so a
   case cannot describe data it does not carry; `plan()` publishes the
   matrix, the pairs and the records, and `violations()` says out loud
   when a pair does not hold, when two pairs collide on one field, or
   when a declared cell has no case. scripts/test-fixture-plans.mjs
   asserts all of that on every push; the switcher marks the fixture
   red in the page if it is ever inconsistent.

   What it does
   ------------
     1. Replaces window.fetch so every Supabase call is answered
        from the generated dataset. It is the source of every
        response, so it performs no network write at all — it is
        safe to point at the real project.
     2. Records every intercepted call, every console error, every
        uncaught error and the result of a layout overflow probe
        into #__fx-diag, which scripts/test-listing-render.mjs reads
        back out of `chrome --headless --dump-dom`.
     3. Renders a "Demo data / Worst case / …" switcher so a human
        can flip cases on the real page and look at them.

   Cases are also readable from Node, with no DOM:
     const FX = vm.runInNewContext(SRC + '; ARZUZ_LISTING_FIXTURE')
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------- the values the builders draw on ---------- */

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

  var UTILITIES_40 = (function () {
    var out = [];
    for (var i = 1; i <= 40; i++) out.push('Amenity number ' + i + ' with a fairly long label');
    return out;
  })();

  var STEPS_12 = (function () {
    var out = [];
    for (var i = 1; i <= 12; i++) {
      out.push({ text: 'Step ' + i + ': keep walking past the kiosk and turn at the fence.',
                 lat: 8.71 + i / 1000, lng: 4.469 + i / 1000 });
    }
    return out;
  })();

  var DEMO_DESC = 'A quiet self-contain on Ilorin Close, two minutes past the second gate. New tiles, ' +
    'a private bathroom and a prepaid meter so you only pay for what you use.\n' +
    'The compound is fenced with a working gate and the caretaker lives on site.';

  /* ---------- the matrix ----------------------------------------
     FIELD → the states that field is resolved in. This is the list the
     coverage check uses: every cell below must be exercised by at least
     one case, and every pair a case declares must hold in the row that
     case builds. */
  var MATRIX = {
    payload:   ['present', 'absent'],
    name:      ['present', 'absent', 'empty', 'unbroken', 'exotic', 'huge'],
    type:      ['present', 'absent', 'empty', 'long', 'exotic'],
    rent:      ['present', 'absent', 'empty', 'formatted', 'zero', 'huge', 'junk'],
    area:      ['present', 'absent', 'empty', 'exotic'],
    rooms:     ['present', 'absent', 'empty', 'zero', 'huge'],
    neg:       ['present', 'absent', 'empty', 'long', 'short'],
    utilities: ['present', 'absent', 'empty', 'junk', 'huge', 'exotic', 'duplicate'],
    desc:      ['present', 'absent', 'empty', 'huge', 'hostile', 'exotic'],
    media:     ['present', 'single', 'absent', 'empty', 'junk', 'huge', 'exotic'],
    passage:   ['present', 'absent', 'empty', 'junk', 'huge'],
    pin:       ['present', 'absent', 'halfset', 'empty', 'wrongtype'],
    tier:      ['one', 'two', 'high', 'absent', 'empty', 'wrongtype'],
    split:     ['present', 'absent', 'true', 'wrongtype']
  };

  /* WHERE the page reads each field from — the same keys listing.html
     resolves (payload first, then the row itself for the pin and tier). */
  var READ = {
    payload:   function (row) { return row.payload; },
    name:      function (row) { return (row.payload || {}).prop_name; },
    type:      function (row) { return (row.payload || {}).ty; },
    rent:      function (row) { return (row.payload || {}).rent; },
    area:      function (row) { return (row.payload || {}).ar; },
    rooms:     function (row) {
      var p = row.payload || {};
      return (has(p, 'rm') || has(p, 'units') || has(p, 'avail'))
        ? { rm: p.rm, units: p.units, avail: p.avail } : undefined;
    },
    neg:       function (row) { return (row.payload || {}).neg; },
    utilities: function (row) { return (row.payload || {}).ut !== undefined && (row.payload || {}).ut !== null && (row.payload || {}).ut !== ''
      ? (row.payload || {}).ut : (row.payload || {}).utilities; },
    desc:      function (row) { return (row.payload || {}).desc; },
    media:     function (row) { return (row.payload || {}).media; },
    passage:   function (row) { return (row.payload || {}).passage; },
    pin:       function (row) {
      return (has(row, 'latitude') || has(row, 'longitude'))
        ? { latitude: row.latitude, longitude: row.longitude } : undefined;
    },
    tier:      function (row) { return row.tier; },
    split:     function (row) { return (row.payload || {}).split_ok; }
  };

  /* ---------- the states ---------------------------------------- */

  var ABSENT = { absent: true };                 /* "this key is not there at all" */
  var has = (row, k) => Object.prototype.hasOwnProperty.call(row, k);
  var isEmptyish = v =>
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

  /* What each state MEANS, in one place, so the fixture and any consumer
     read the same definition. `v` is what READ[field] returns; the field is
     passed in because "empty" means three different things (an absent
     payload, a pin with no numbers in it, a rooms line with no text). */
  var STATE_TEST = {
    present:   function (v, field) {
      if (field === 'payload') return v !== undefined && v !== null;
      if (field === 'pin') return !!v && isFinite(parseFloat(v.latitude)) && isFinite(parseFloat(v.longitude));
      if (field === 'rooms') return !!v && typeof v.rm === 'string' && v.rm.trim() !== '';
      return v !== undefined && v !== null && !isEmptyish(v) && !(v && v.absent);
    },
    absent:    function (v) { return v === undefined || (v && v.absent); },
    empty:     function (v, field) {
      if (v === undefined || v === null) return false;
      if (field === 'pin') {
        return (v.latitude === '' || v.latitude === null || v.latitude === undefined) &&
               (v.longitude === '' || v.longitude === null || v.longitude === undefined);
      }
      if (field === 'rooms') return v.rm === '';
      return isEmptyish(v);
    },
    unbroken:  v => typeof v === 'string' && !/\s/.test(v) && v.length >= 40,
    /* a value that carries its own length, either way */
    long:      function (v, field) {
      if (field === 'neg') return typeof v === 'string' && v.length >= 100;
      return typeof v === 'string' && v.length >= 30;
    },
    short:     v => typeof v === 'string' && v.trim() !== '' && !/\s/.test(v) && v.length <= 12,
    hostile:   v => /<script|["']/.test(String(v)),
    /* non-Latin text, wherever it sits: a string, or a label inside a list
       of media objects (the gallery is the field that carries it there) */
    exotic:    function (v) {
      var s = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
      return /[^\u0000-\u024F]/.test(s) || /[\u00C0-\u024F]/.test(s);
    },
    huge:      function (v, field) {
      if (field === 'name') return typeof v === 'string' && v.length >= 40;
      if (field === 'rent') return Number(String(v).replace(/[^0-9]/g, '')) >= 99999999;
      if (field === 'rooms') return !!v && Number(v.units) >= 40;
      if (field === 'passage') return !!v && Array.isArray(v.steps) && v.steps.length >= 12;
      if (Array.isArray(v)) return v.length >= 40;
      if (typeof v === 'string') return v.length >= 1000;
      return false;
    },
    formatted: v => typeof v === 'string' && /[0-9]/.test(v) && /[^0-9]/.test(v),
    junk:      function (v, field) {
      if (field === 'utilities') return Array.isArray(v) && v.some(it => typeof it !== 'string' || it.trim() === '');
      if (field === 'media') return Array.isArray(v) && v.some(it => !it || !it.url);
      if (field === 'passage') {
        return !!v && (!Array.isArray(v.steps) ||
          v.steps.some(s => !s || typeof s === 'string' || !String(s.text || '').trim()));
      }
      if (field === 'rent') return typeof v === 'string' && !/[0-9]/.test(v);
      return false;
    },
    zero:      function (v, field) {
      if (field === 'rooms') return !!v && Number(v.units) === 0;
      return String(v).trim() !== '' && Number(String(v).replace(/[^0-9.]/g, '')) === 0;
    },
    single:    v => Array.isArray(v) && v.length === 1,
    duplicate: v => Array.isArray(v) && new Set(v.map(s => String(s).toLowerCase().trim())).size < v.length,
    halfset:   v => !!v && !!v.latitude && (v.longitude === '' || v.longitude === null || v.longitude === undefined),
    true:      function (v, field) { return field === 'split' && v === true; },
    /* the badge has three branches, so tier is three cells, not one */
    one:       function (v, field) { return field === 'tier' && Number(v) === 1; },
    two:       function (v, field) { return field === 'tier' && Number(v) === 2; },
    high:      function (v, field) { return field === 'tier' && Number(v) >= 3; },
    wrongtype: function (v, field) {
      if (field === 'pin') return !!v && (!isFinite(parseFloat(v.latitude)) || !isFinite(parseFloat(v.longitude)));
      if (field === 'split') return typeof v === 'string' && v !== '';
      if (field === 'tier') return typeof v === 'string' && v !== '' && !/^[0-9]+$/.test(v);
      return false;
    }
  };

  /* ---------- the builders ---------------------------------------
     One value per (field · state). A case is a list of pairs, and its row
     is assembled from these — the declaration IS the data. */
  var B = {
    payload: {
      present: () => ({}),
      absent: () => ABSENT
    },
    name: {
      present: () => 'Ilorin Close Self-Contain',
      absent: () => ABSENT,
      empty: () => '',
      unbroken: () => 'OLUWASEUNBABATUNDEADEGOKEMEMORIALSTUDENTLODGEANDSUITESSMALETE',
      exotic: () => 'Ọ̀pẹ́ Ọ̀gá Students Lodge 🏠',
      huge: () => 'Grand Imperial Student Village Phase 2 Annex Extension'
    },
    type: {
      present: () => 'Self-contain',
      absent: () => ABSENT,
      empty: () => '',
      long: () => 'Face-me-I-face-you, self-contained bathroom, shared kitchen',
      exotic: () => 'غرفة ذاتية — Self-contain 🏠'
    },
    rent: {
      present: () => '185000',
      absent: () => ABSENT,
      empty: () => '',
      formatted: () => '150,000',
      zero: () => '0',
      huge: () => '123456789',
      junk: () => 'Call for price'
    },
    area: {
      present: () => 'Malete',
      absent: () => ABSENT,
      empty: () => '',
      exotic: () => 'Àgọ́ Ọ̀jọ̀'
    },
    rooms: {
      present: () => ({ rm: '1 room', units: 1, avail: 'vacant' }),
      absent: () => ABSENT,
      empty: () => ({ rm: '', units: null, avail: '' }),
      zero: () => ({ rm: 'Fully occupied', units: 0, avail: 'occupied' }),
      huge: () => ({ rm: '40 rooms available', units: 40, avail: 'vacant' })
    },
    neg: {
      present: () => 'Negotiable on a full-session payment',
      absent: () => ABSENT,
      empty: () => '',
      long: () => 'Copies of the tenancy agreement, the receipts and a signed inventory list are required ' +
                   'before the keys change hands, and the landlord prefers a full-session payment upfront',
      short: () => 'No'
    },
    utilities: {
      present: () => ['Borehole water', 'NEPA connection', 'Prepaid meter', 'Security / gateman'],
      absent: () => ABSENT,
      empty: () => [],
      junk: () => ['Borehole water', '', null, 42, 'Prepaid meter',
        'Standby generator with an automatic changeover switch',
        'Security / gateman on duty every night including weekends'],
      huge: () => UTILITIES_40,
      exotic: () => ['سخان ماء', 'Ọ̀pẹ́ borehole 🏠', 'Borehole water'],
      duplicate: () => ['Borehole water', 'borehole water', 'NEPA connection']
    },
    desc: {
      present: () => DEMO_DESC,
      absent: () => ABSENT,
      empty: () => '',
      huge: () => DESC_LONG + '\n\n' + DESC_LONG,
      hostile: () => DESC_LONG,
      exotic: () => 'شقة هادئة قرب البوابة، مياه جارية وعداد مسبق الدفع. 🏠\n' +
                    'Ọ̀pẹ́ Lodge — the caretaker lives on site and speaks Yoruba and Arabic.'
    },
    media: {
      present: () => gallery(3),
      single: () => [{ type: 'image', url: IMGS[0], label: 'Cover photo' }],
      absent: () => ABSENT,
      empty: () => [],
      junk: () => [
        { type: 'image', url: '', label: 'empty url' },
        { url: IMGS[1] },
        { type: 'video', url: 'https://example.com/not-a-video.mp4', label: 'Uploaded tour' },
        { type: 'image', url: IMGS[2], label: 'Third' }
      ],
      huge: () => gallery(49).concat([{ type: 'video', url: TOUR, label: 'Video tour' }]),
      exotic: () => [
        { type: 'image', url: IMGS[3] + '?rtl=1', label: 'الصورة الأولى' },
        { type: 'image', url: IMGS[4] + '?emoji=1', label: 'Ọ̀pẹ́ 🏠' },
        { type: 'video', url: 'https://youtu.be/aqz-KE-bpKQ?si=Xk3r9Wq1ZvLmNpQr', label: 'جولة بالفيديو' }
      ]
    },
    passage: {
      present: () => ({
        landmark: 'Beside the blue mosque, brown double gate.',
        gate: 'The left gate — the right one is bolted.',
        floor: 'First floor, room 3.',
        steps: [
          { text: 'From the KWASU main gate, walk south past the filling station.' },
          { text: 'Turn right at the mosque; the compound is 40m down.', lat: 8.7109, lng: 4.4692 }
        ]
      }),
      absent: () => ABSENT,
      empty: () => ({}),
      junk: () => ({
        landmark: 'Mobil filling station عند التقاطع, opposite the second gate',
        gate: 42,
        floor: null,
        steps: [null, { text: '   ' }, { text: 'Turn right at the mosque', lat: 'x', lng: 'y' },
                'Go past the yellow kiosk and the compound is the third gate on the left']
      }),
      huge: () => ({
        landmark: 'At the junction by the big mast, brown and cream building.',
        gate: 'Second gate on the right after the mast.',
        floor: 'Block C, first floor.',
        steps: STEPS_12
      })
    },
    pin: {
      present: () => ({ latitude: 8.7113, longitude: 4.4697 }),
      absent: () => ABSENT,
      halfset: () => ({ latitude: 8.7113, longitude: '' }),
      empty: () => ({ latitude: '', longitude: '' }),
      wrongtype: () => ({ latitude: 'x', longitude: 'y' })
    },
    /* the badge has three branches (>=2 · 1 · anything else), so the three
       numbers are three cells rather than one "present" */
    tier: {
      one: () => 1,
      two: () => 2,
      high: () => 3,
      absent: () => ABSENT,
      empty: () => '',
      wrongtype: () => 'verified'
    },
    split: {
      present: () => false,
      absent: () => ABSENT,
      true: () => true,
      wrongtype: () => 'yes'
    }
  };

  /* a fallback so a case can name any cell of the matrix without another
     pair in the same case colliding with it */
  var PAYLOAD_KEY = {
    name: 'prop_name', type: 'ty', rent: 'rent', area: 'ar', rooms: null, neg: 'neg',
    utilities: null, desc: 'desc', media: 'media', passage: 'passage', split: 'split_ok'
  };

  function buildRow(pairs) {
    var row = { id: 'fx-generated-0001' };
    var payload = {};
    var hasPayload = pairs.some(p => p[0] === 'payload');
    pairs.forEach(function (pair) {
      var field = pair[0], state = pair[1];
      var val = B[field][state](field);
      if (field === 'payload') { if (val === ABSENT) payload = null; return; }
      if (val === ABSENT) return;
      if (field === 'pin') { row.latitude = val.latitude; row.longitude = val.longitude; return; }
      if (field === 'tier') { row.tier = val; return; }
      if (field === 'rooms') { payload.rm = val.rm; payload.units = val.units; payload.avail = val.avail; return; }
      if (field === 'utilities') { payload.ut = val; payload.utilities = []; return; }
      if (field === 'media') {
        payload.media = val;
        /* the page falls back to photo/video when media is missing or empty —
           that fallback is the state being exercised, so it is declared as one */
        if (state === 'absent' || state === 'empty') {
          payload.photo = IMGS[0];
          payload.video = '';
          payload.video_url = '';
        }
        return;
      }
      var key = PAYLOAD_KEY[field];
      if (key) payload[key] = val;
    });
    if (hasPayload && payload === null) return row;      /* the empty case: no payload key at all */
    row.payload = payload;
    return row;
  }

  /* ---------- the cases ------------------------------------------
     Each one declares the pairs it is there to exercise. `worst` and
     `huge` keep the values they have always had (they are quoted in
     dev/admin-test-report.md and driven by test-all's fault modes). */
  var CASE_DEFS = {

    demo: {
      label: 'Demo data',
      note: 'the happy path — everything filled in, three photos',
      pairs: [
        ['payload', 'present'], ['name', 'present'], ['type', 'present'], ['rent', 'present'],
        ['area', 'present'], ['rooms', 'present'], ['neg', 'present'], ['utilities', 'present'],
        ['desc', 'present'], ['media', 'present'], ['passage', 'present'], ['pin', 'present'],
        ['tier', 'two'], ['split', 'present']
      ]
    },

    worst: {
      label: 'Worst case',
      note: 'unbroken long name, formatted rent, blank/number entries in ut, half-filled media ' +
            'entries, multi-script text, a long negotiable note, an unparseable tier',
      pairs: [
        ['payload', 'present'], ['name', 'unbroken'], ['type', 'long'], ['rent', 'formatted'],
        ['area', 'exotic'], ['rooms', 'empty'], ['neg', 'long'], ['utilities', 'junk'],
        ['desc', 'hostile'], ['media', 'junk'], ['passage', 'junk'], ['pin', 'halfset'],
        ['tier', 'wrongtype'], ['split', 'wrongtype']
      ]
    },

    halfpos: {
      label: 'Latitude only',
      note: 'a pin was started and never finished — lat set, lng empty',
      pairs: [
        ['payload', 'present'], ['name', 'present'], ['type', 'present'], ['rent', 'present'],
        ['area', 'present'], ['utilities', 'present'], ['desc', 'present'], ['media', 'present'],
        ['pin', 'halfset'], ['tier', 'one']
      ]
    },

    empty: {
      label: 'Empty',
      note: 'no payload key, no media, no pin — every optional field absent',
      pairs: [
        ['payload', 'absent'], ['name', 'absent'], ['type', 'absent'], ['rent', 'absent'],
        ['area', 'absent'], ['rooms', 'absent'], ['neg', 'absent'], ['utilities', 'absent'],
        ['desc', 'absent'], ['media', 'absent'], ['passage', 'absent'], ['pin', 'absent'],
        ['tier', 'absent']
      ]
    },

    one: {
      label: 'One item',
      note: 'a single photo, a single feature — every count is 1',
      pairs: [
        ['payload', 'present'], ['name', 'present'], ['type', 'present'], ['rent', 'present'],
        ['area', 'present'], ['rooms', 'present'], ['utilities', 'present'], ['desc', 'present'],
        ['media', 'single'], ['pin', 'present'], ['tier', 'one']
      ]
    },

    huge: {
      label: '1,000-row scale list',
      note: '50 media items, 40 features, a 12-step passage, a nine-figure rent and a very long description',
      pairs: [
        ['payload', 'present'], ['name', 'huge'], ['type', 'long'], ['rent', 'huge'],
        ['area', 'present'], ['rooms', 'huge'], ['neg', 'short'], ['utilities', 'huge'],
        ['desc', 'huge'], ['media', 'huge'], ['passage', 'huge'], ['pin', 'present'],
        ['tier', 'high'], ['split', 'true']
      ]
    },

    exotic: {
      label: 'RTL + emoji',
      note: 'a non-Latin name, type, area, description and gallery labels, rent 0, and a youtu.be share link',
      pairs: [
        ['payload', 'present'], ['name', 'exotic'], ['type', 'exotic'], ['rent', 'zero'],
        ['media', 'exotic'], ['utilities', 'exotic'], ['desc', 'exotic'], ['pin', 'present']
      ]
    },

    shapes: {
      label: 'Empty shapes',
      note: 'keys present but empty — empty strings, empty lists, half-filled forms',
      pairs: [
        ['payload', 'present'], ['name', 'empty'], ['type', 'empty'], ['rent', 'empty'],
        ['area', 'empty'], ['rooms', 'zero'], ['neg', 'empty'], ['utilities', 'empty'],
        ['desc', 'empty'], ['media', 'absent'], ['passage', 'empty'], ['pin', 'empty'],
        ['tier', 'empty'], ['split', 'absent']
      ]
    },

    oddities: {
      label: 'Odd shapes',
      note: 'values of the wrong type, a duplicate amenity, and a list with no photo at all',
      pairs: [
        ['payload', 'present'], ['name', 'present'], ['rent', 'junk'], ['utilities', 'duplicate'],
        ['desc', 'present'], ['media', 'empty'], ['passage', 'absent'], ['pin', 'wrongtype'],
        ['tier', 'one']
      ]
    }
  };

  var ORDER = ['demo', 'worst', 'halfpos', 'empty', 'one', 'huge', 'exotic', 'shapes', 'oddities'];

  /* ---------- the assembled fixture ---------- */

  var CASES = {};
  ORDER.forEach(function (key) {
    var def = CASE_DEFS[key];
    var row = buildRow(def.pairs);
    row.id = 'fx-' + key + '-0001';
    CASES[key] = {
      label: def.label,
      note: def.note,
      pairs: def.pairs,
      row: row
    };
  });

  /* ---------- the records, checkable from Node and from the page ---------- */

  function covered(matrixOnly) {
    var seen = {};
    ORDER.forEach(function (key) {
      CASE_DEFS[key].pairs.forEach(function (p) { seen[p[0] + '·' + p[1]] = key; });
    });
    return seen;
  }

  /* Every pair a case declares must hold in the row it built; no two pairs
     of one case may collide on the same field; every declared cell must be
     exercised; and no pair may name a cell the matrix does not declare. */
  function violations() {
    var out = [];
    var seen = covered();

    ORDER.forEach(function (key) {
      var def = CASE_DEFS[key], row = CASES[key].row;
      var byField = {};
      def.pairs.forEach(function (p) {
        var field = p[0], state = p[1];
        if (!MATRIX[field] || MATRIX[field].indexOf(state) === -1) {
          out.push(key + ': ' + field + '·' + state + ' is not a cell of the matrix');
        }
        if (byField[field]) {
          out.push(key + ': ' + field + ' is declared twice (' + byField[field] + ' and ' + state + ')');
        }
        byField[field] = state;

        var v = READ[field](row);
        var test = STATE_TEST[state];
        if (!test) { out.push(key + ': no test for state "' + state + '"'); return; }
        if (!test(v, field)) {
          out.push(key + ': claims ' + field + '·' + state + ' but the row does not hold it (' +
            JSON.stringify(v === undefined ? null : v).slice(0, 60) + ')');
        }
      });
      if (def.pairs.length !== (CASES[key].pairs || []).length) {
        out.push(key + ': the case record lost its pairs');
      }
    });

    Object.keys(MATRIX).forEach(function (field) {
      MATRIX[field].forEach(function (state) {
        if (!seen[field + '·' + state]) out.push('no case exercises ' + field + '·' + state);
      });
    });
    return out;
  }

  var API = {
    cases: CASES,
    order: ORDER,
    images: IMGS,
    tour: TOUR,
    matrix: MATRIX,
    states: STATE_TEST,
    read: READ,
    plan: function () {
      return {
        fields: Object.keys(MATRIX),
        matrix: MATRIX,
        cells: Object.keys(MATRIX).reduce(function (n, f) { return n + MATRIX[f].length; }, 0),
        coverage: covered(),
        cases: ORDER.map(function (key) {
          return {
            key: key,
            label: CASES[key].label,
            note: CASES[key].note,
            id: CASES[key].row.id,
            pairs: CASES[key].pairs.map(function (p) { return { field: p[0], state: p[1] }; })
          };
        }),
        violations: violations()
      };
    },
    holds: function (key, field, state) {
      return !!STATE_TEST[state] && !!STATE_TEST[state](READ[field](CASES[key].row), field);
    }
  };
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
    errorShown: null,
    fixtureViolations: null
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
    /* the fixture's own consistency check, on screen: a broken pairing must
       not look like a page bug */
    try {
      var bad = violations();
      DIAG.fixtureViolations = bad.length ? bad : null;
      diag();
      if (bad.length) global.console.error('[listing-fixture] ' + bad.length +
        ' violation(s): ' + bad.slice(0, 4).join(' · '));
    } catch (e) {
      global.console.error('[listing-fixture] violations() threw: ' + e.message);
    }

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
      a.title = CASES[k].note + '  ·  exercises ' +
        CASES[k].pairs.map(function (p) { return p[0] + '·' + p[1]; }).join(', ');
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
