/* ============================================================
   Arzuz landlord invite form — offline seed fixture (DEV ONLY)

   Loaded by dev/complete-listing-harness.html (and by
   scripts/test-fixture-plans.mjs, which is why it has no DOM
   dependency). Nothing in complete-listing.html references it.

   The seeds are GENERATED from declared recipes, like
   dev/listing-fixture.js: each seed names the (field · state) pairs it is
   there to exercise and the seed is BUILT from those names, so it cannot
   describe data it does not carry. `plan()` publishes the matrix, the
   recipes and the scripted failure classes; `violations()` says out loud
   when a pair does not hold, when a field is declared twice, or when a
   declared cell has no seed. The harness marks the fixture red in the
   console when that happens, and test-fixture-plans.mjs fails the gate.
   ============================================================ */

(function (global) {
  'use strict';

  var IMG = '/assets/social/og-image.png';
  var TOUR = 'https://youtu.be/aqz-KE-bpKQ?si=Xk3r9Wq1ZvLmNpQr';
  var DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing';

  var LONG_DESC = ('Spacious compound with a paved driveway, standby generator, prepaid meter, ' +
    'borehole water, tiled floors and a caretaker on site. ').repeat(12) + 'Call the caretaker before 8pm.';

  var UT_12 = [
    'Borehole water', 'borehole water', 'NEPA connection', 'Generator backup', 'Prepaid meter',
    '24/7 💧 water', 'Security gate with a night guard', 'Perimeter fence', 'Kitchen access',
    'Borehole water with overhead tank and pressure pump', 'Tiled floors', 'Painted walls'
  ];

  var MEDIA_40 = (function () {
    var out = [];
    for (var i = 1; i <= 38; i++) out.push({ type: 'image', url: IMG + '?photo=' + i, label: '', credit: { holder: 'Arzuz' } });
    out.push({ type: 'video', url: TOUR, label: '', credit: { holder: 'Arzuz' } });
    out.push({ type: 'video', url: DRIVE, label: '', credit: { holder: 'Arzuz' } });
    return out;
  })();

  /* ---------- the matrix ----------------------------------------
     FIELD → the states that field is resolved in. Every cell must be
     exercised by a seed; every pair a seed declares must hold in the seed
     it built. */
  var MATRIX = {
    prop_name:  ['present', 'generated', 'ceiling', 'exotic'],
    ty:         ['present'],
    ar:         ['present', 'exotic'],
    rent:       ['present', 'ceiling'],
    ask:        ['present', 'ceiling', 'absent'],
    rooms:      ['present', 'single', 'zero'],
    nm:         ['present', 'exotic'],
    ph:         ['present', 'formatted'],
    contact_role: ['present'],
    who:        ['present'],
    desc:       ['present', 'empty', 'ceiling'],
    ut:         ['present', 'duplicate', 'ceiling'],
    media:      ['present', 'pair', 'many'],
    photo:      ['present'],
    video:      ['present', 'share-link'],
    pin:        ['present', 'absent'],
    pin_meta:   ['present', 'absent'],
    passage:    ['present', 'ceiling', 'absent'],
    split_ok:   ['present'],
    permission: ['edit', 'view']
  };

  var ABSENT = { absent: true };

  /* what each state means, on the value the form reads */
  var TEST = {
    present:   v => v !== undefined && v !== null && v !== '' && v !== ABSENT,
    absent:    v => v === undefined || v === null || v === ABSENT,
    generated: v => typeof v === 'string' && v.indexOf(' in ') !== -1 && v.length > 10,
    ceiling:   function (v, field) {
      if (field === 'rent' || field === 'ask') return Number(String(v).replace(/[^0-9]/g, '')) >= 1000000;
      if (field === 'passage') return !!v && typeof v.landmark === 'string' && v.landmark.split('\n').length >= 3;
      if (field === 'ut') return Array.isArray(v) && v.length >= 12;
      if (field === 'desc') return typeof v === 'string' && v.length >= 1500;
      return typeof v === 'string' && v.length >= 40;
    },
    exotic:    function (v, field) {
      var s = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
      return /[^\u0000-\u024F]/.test(s) || /[\u00C0-\u024F]/.test(s);
    },
    duplicate: v => Array.isArray(v) && new Set(v.map(s => String(s).toLowerCase().trim())).size < v.length,
    many:      v => Array.isArray(v) && v.length >= 40,
    pair:      v => Array.isArray(v) && v.length === 2 && v.some(m => m && m.type === 'video'),
    empty_str: v => v === '',
    formatted: v => typeof v === 'string' && /[^0-9]/.test(v) && /[0-9]/.test(v),
    share_link: v => /youtu\.be|drive\.google\.com|youtube\.com/.test(String(v)),
    single:    v => !!v && typeof v === 'object' && Number(v.units) === 1,
    zero:      v => (v && typeof v === 'object') ? Number(v.units) === 0 : Number(v) === 0,
    edit:      v => v === 'edit',
    view:      v => v === 'view'
  };
  TEST['share-link'] = TEST.share_link;

  /* ---------- the builders ---------------------------------------
     One value per (field · state); a recipe is a list of pairs and the
     seed is assembled from them. */
  var B = {
    prop_name: {
      present: () => 'Blessing Lodge',
      generated: () => 'Self-contain in Behind KWASU Gate, Malete',
      ceiling: () => 'Alhaji Adebayo Memorial Students Lodge \u2014 Phase 2 Annex Block C',
      exotic: () => 'Ọ̀pẹ́ Ọ̀gá Students Lodge 🏠'
    },
    ty: { present: () => 'Self-contain' },
    ar: {
      present: () => 'Behind KWASU Gate, Malete',
      exotic: () => '\u1ECC\u0300p\u1EB9\u0301 \u1ECC\u0300g\u00E1 Area \uD83C\uDFE0, behind KWASU Gate, Malete'
    },
    rent: { present: () => '180000', ceiling: () => '1250000' },
    ask: { present: () => '200000', ceiling: () => '1250000', absent: () => null },
    rooms: {
      present: () => ({ rm: '3 rooms available', avail: 'vacant', units: 3 }),
      single: () => ({ rm: '1 room available', avail: 'vacant', units: 1 }),
      zero: () => ({ rm: 'Units available', avail: 'vacant', units: 0 })
    },
    nm: {
      present: () => 'Alh. Kareem',
      exotic: () => 'Alh. Abdulrahman \u2018\u1ECC\u0300g\u00E1 \u00C0gb\u00E0\u2019 Kareem-Olaniyan'
    },
    ph: { present: () => '08033445566', formatted: () => '+234 803 345 5667' },
    contact_role: { present: () => 'Caretaker' },
    who: { present: () => 'A caretaker' },
    desc: {
      present: () => 'Tiled floors, prepaid meter.',
      empty: () => '',
      ceiling: () => LONG_DESC
    },
    ut: {
      present: () => ['Borehole water', 'NEPA connection'],
      duplicate: () => ['Borehole water', 'borehole water', 'NEPA connection'],
      ceiling: () => UT_12
    },
    media: {
      present: () => [{ type: 'image', url: IMG, label: 'Cover photo', credit: { holder: 'Arzuz' } }],
      pair: () => [
        { type: 'image', url: IMG, label: 'Cover photo', credit: { holder: 'Arzuz' } },
        { type: 'video', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', label: '', credit: { holder: 'Arzuz' } }
      ],
      many: () => MEDIA_40
    },
    photo: { present: () => IMG },
    video: { present: () => TOUR, 'share-link': () => TOUR },
    pin: { present: () => ({ lat: '9.195', lng: '4.661', pin: '9.195000,4.661000' }), absent: () => ABSENT },
    pin_meta: {
      present: () => ({ source: 'gps', accuracy_m: 6, samples: 9 }),
      absent: () => ABSENT
    },
    passage: {
      present: () => ({
        landmark: 'Opposite the blue mosque, brown double gate.',
        gate: '', floor: '', steps: [],
        route: [[9.195, 4.661], [9.1955, 4.6614], [9.196, 4.6619]],
        route_src: 'traced', route_km: 0.21, route_min: 3
      }),
      /* the three-line landmark a real landlord pastes out of WhatsApp */
      ceiling: () => ({
        landmark: 'Opposite the blue mosque \u2014 ask for \u2018Ile Alhaji\u2019. Brown double gate, small green door.\n' +
          'Second turning after the filling station. Map pinned at the gate (see pin).\n' +
          'If you reach the transformer you have gone too far \u2014 call me.',
        gate: '', floor: '', steps: [],
        route: [[9.195, 4.661], [9.1955, 4.6614], [9.196, 4.6619]],
        route_src: 'traced', route_km: 0.21, route_min: 3
      }),
      absent: () => null
    },
    split_ok: { present: () => true },
    permission: { edit: () => 'edit', view: () => 'view' }
  };

  var PAYLOAD_KEY = { prop_name: 'prop_name', ty: 'ty', ar: 'ar', rent: 'rent', ask: 'ask',
    nm: 'nm', ph: 'ph', contact_role: 'contact_role', who: 'who', desc: 'desc',
    ut: 'ut', media: 'media', photo: 'photo', video: 'video_url', passage: 'passage', split_ok: 'split_ok' };

  function buildSeed(pairs) {
    var payload = {};
    var out = { payload: payload, permission: 'edit', name_generated: false };
    pairs.forEach(function (pair) {
      var field = pair[0], state = pair[1];
      if (field === 'permission') { out.permission = state; return; }
      var val = B[field][state]();
      if (val === ABSENT) return;
      if (field === 'rooms') { payload.rm = val.rm; payload.avail = val.avail; payload.units = val.units; return; }
      if (field === 'pin') {
        payload.lat = val.lat; payload.lng = val.lng; payload.pin = val.pin;
        payload.pin_meta = (out.payload.pin_meta || null);
        if (state === 'absent') { delete payload.lat; delete payload.lng; delete payload.pin; }
        return;
      }
      if (field === 'pin_meta') { if (val === ABSENT) { delete payload.pin_meta; return; } payload.pin_meta = val; return; }
      if (field === 'ut') { payload.ut = val; payload.utilities = []; return; }
      if (field === 'video') { payload.video = val; payload.video_url = val; return; }
      if (field === 'prop_name' && state === 'generated') out.name_generated = true;
      payload[PAYLOAD_KEY[field]] = val;
    });
    return out;
  }

  /* ---------- the seeds ------------------------------------------ */

  var SEED_DEFS = {
    blank: {
      label: 'Empty',
      note: 'no row at all — the page has nothing to prefill',
      pairs: []
    },
    existing: {
      label: 'Demo',
      note: 'the row the harness has always booted: everything filled in, two media',
      pairs: [
        ['prop_name', 'present'], ['ty', 'present'], ['ar', 'present'], ['rent', 'present'],
        ['ask', 'present'], ['rooms', 'present'], ['nm', 'present'], ['ph', 'present'],
        ['contact_role', 'present'], ['who', 'present'], ['desc', 'present'], ['ut', 'present'],
        ['media', 'pair'], ['photo', 'present'], ['video', 'present'], ['pin', 'present'],
        ['pin_meta', 'present'], ['passage', 'present'], ['split_ok', 'present'], ['permission', 'edit']
      ]
    },
    generated: {
      label: 'Generated name',
      note: 'a title Arzuz wrote from type + area — the form must offer it, never force it to be cleared',
      pairs: [
        ['prop_name', 'generated'], ['ty', 'present'], ['ar', 'present'], ['rent', 'present'],
        ['rooms', 'present'], ['nm', 'present'], ['ph', 'present'], ['desc', 'present'],
        ['ut', 'present'], ['media', 'present'], ['permission', 'edit']
      ]
    },
    worst: {
      label: 'Worst',
      note: 'every value at its ceiling: a 62-character name, diacritics and an emoji, a formatted ' +
            'international phone, ₦1.25m, 0 units, a 1,578-character blurb, 12 amenities and 40 media ' +
            '— two of them the links people really send',
      pairs: [
        ['prop_name', 'ceiling'], ['ty', 'present'], ['ar', 'exotic'], ['rent', 'ceiling'],
        ['ask', 'ceiling'], ['rooms', 'zero'], ['nm', 'exotic'], ['ph', 'formatted'],
        ['contact_role', 'present'], ['who', 'present'], ['desc', 'ceiling'], ['ut', 'ceiling'],
        ['media', 'many'], ['photo', 'present'], ['video', 'share-link'], ['pin', 'present'],
        ['pin_meta', 'present'], ['passage', 'ceiling'], ['split_ok', 'present'], ['permission', 'edit']
      ]
    },
    one: {
      label: 'One',
      note: 'the smallest real invite: one room, one photo, a one-word name',
      pairs: [
        ['prop_name', 'present'], ['ty', 'present'], ['ar', 'present'], ['rent', 'present'],
        ['ask', 'absent'], ['rooms', 'single'], ['nm', 'present'], ['ph', 'present'],
        ['contact_role', 'present'], ['who', 'present'], ['desc', 'empty'], ['ut', 'present'],
        ['media', 'present'], ['photo', 'present'], ['pin', 'absent'], ['pin_meta', 'absent'],
        ['passage', 'absent'], ['permission', 'edit']
      ]
    },
    view: {
      label: 'Read-only link',
      note: 'the same row behind a view-only link — every control hidden',
      pairs: [
        ['prop_name', 'present'], ['ty', 'present'], ['ar', 'present'], ['rent', 'present'],
        ['rooms', 'present'], ['nm', 'present'], ['ph', 'present'], ['desc', 'present'],
        ['ut', 'present'], ['media', 'present'], ['permission', 'view']
      ]
    },
    exotic: {
      label: 'RTL + emoji',
      note: 'a non-Latin lodge name in a link a landlord can still fill in',
      pairs: [
        ['prop_name', 'exotic'], ['ty', 'present'], ['ar', 'present'], ['rent', 'present'],
        ['rooms', 'present'], ['nm', 'present'], ['ph', 'present'], ['desc', 'present'],
        ['ut', 'duplicate'], ['media', 'present'], ['permission', 'edit']
      ]
    }
  };

  var ORDER = ['blank', 'existing', 'generated', 'worst', 'one', 'view', 'exotic'];

  /* the scripted failures the harness can hand the page (?fail=…), and the
     draft states the mock RPC can be put in (?seed=no-row) */
  var FAILS = ['get-missing', 'get-refused', 'get-bad-token', 'update-missing',
    'update-refused', 'update-busy', 'update-unwell', 'update-offline'];
  var DRAFT_STATES = ['live', 'revoked', 'expired'];

  var SEEDS = {};
  ORDER.forEach(function (key) {
    SEEDS[key] = {
      label: SEED_DEFS[key].label,
      note: SEED_DEFS[key].note,
      pairs: SEED_DEFS[key].pairs,
      seed: buildSeed(SEED_DEFS[key].pairs)
    };
  });

  /* blank is the "no row at all" seed the harness has always used */
  SEEDS.blank.seed = null;

  function covered() {
    var seen = {};
    ORDER.forEach(function (key) {
      (SEED_DEFS[key].pairs || []).forEach(function (p) { seen[p[0] + '·' + p[1]] = key; });
    });
    return seen;
  }

  function readSeed(seed, field) {
    if (!seed) return undefined;
    var p = seed.payload || {};
    if (field === 'permission') return seed.permission || 'edit';
    if (field === 'prop_name') return p.prop_name;
    if (field === 'rooms') return { rm: p.rm, units: p.units, avail: p.avail };
    if (field === 'pin') return (p.lat === undefined && p.lng === undefined) ? undefined : p;
    if (field === 'pin_meta') return p.pin_meta;
    if (field === 'video') return p.video_url;
    return p[PAYLOAD_KEY[field]];
  }

  function violations() {
    var out = [];
    var seen = covered();
    ORDER.forEach(function (key) {
      var def = SEED_DEFS[key];
      var byField = {};
      (def.pairs || []).forEach(function (p) {
        var field = p[0], state = p[1];
        if (!MATRIX[field] || MATRIX[field].indexOf(state) === -1) {
          out.push(key + ': ' + field + '·' + state + ' is not a cell of the matrix');
        }
        if (byField[field]) out.push(key + ': ' + field + ' declared twice (' + byField[field] + ' and ' + state + ')');
        byField[field] = state;
        var v = readSeed(SEEDS[key].seed, field);
        var test = state === 'empty' ? TEST.empty_str : TEST[state];
        if (!test) { out.push(key + ': no test for state "' + state + '"'); return; }
        if (!test(v, field)) {
          out.push(key + ': claims ' + field + '·' + state + ' but the seed does not hold it (' +
            JSON.stringify(v === undefined ? null : v).slice(0, 60) + ')');
        }
      });
    });
    Object.keys(MATRIX).forEach(function (field) {
      MATRIX[field].forEach(function (state) {
        if (!seen[field + '·' + state]) out.push('no seed exercises ' + field + '·' + state);
      });
    });
    return out;
  }

  global.ARZUZ_INVITE_FIXTURE = {
    seeds: SEEDS,
    order: ORDER,
    matrix: MATRIX,
    fails: FAILS,
    draftStates: DRAFT_STATES,
    plan: function () {
      return {
        fields: Object.keys(MATRIX),
        matrix: MATRIX,
        cells: Object.keys(MATRIX).reduce(function (n, f) { return n + MATRIX[f].length; }, 0),
        coverage: covered(),
        fails: FAILS.slice(),
        draftStates: DRAFT_STATES.slice(),
        seeds: ORDER.map(function (key) {
          return { key: key, label: SEEDS[key].label, note: SEEDS[key].note,
                   /* `noRow` is the blank seed: "there is no row at all", so it
                      carries no pairs on purpose rather than by omission */
                   noRow: !(SEED_DEFS[key].pairs || []).length,
                   pairs: (SEED_DEFS[key].pairs || []).map(function (p) { return { field: p[0], state: p[1] }; }) };
        }),
        violations: violations()
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
