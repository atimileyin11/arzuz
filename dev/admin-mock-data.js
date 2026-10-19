/* ============================================================
   Arzuz Admin — mock data (DEV ONLY)
   Loaded by admin.html?mock=1 on localhost, right before
   admin-mock.js. Never loaded in production.

   Shapes mirror the real Supabase tables/views so the whole
   dashboard renders exactly as it does against live data:
     demand_records, listings, scout_submissions,
     booking_requests, support_tickets, amenities,
     minors_needing_guardian (view),
     roommate_match_summary  (view),
     roommate_profiles, roommate_interests, roommate_events,
     roommate_engine_summary (view), roommate_mutual_pairs (view)
   Photo URLs are inline SVG data URIs so thumbnails render
   with zero network access.
   ============================================================ */

(function () {
  'use strict';

  function ph(label, hue) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">' +
      '<rect width="100%" height="100%" fill="hsl(' + hue + ',28%,30%)"/>' +
      '<rect x="10" y="10" width="300" height="220" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>' +
      '<text x="50%" y="50%" fill="rgba(255,255,255,.75)" font-family="sans-serif" font-size="17" ' +
      'text-anchor="middle" dominant-baseline="middle">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var IMG = {
    blessing: ph('Blessing Lodge', 262),
    mlt: ph('MLT Court', 210),
    kwara: ph('Kwara Gardens', 335),
    peace: ph('Peace Villa', 150),
    scout1: ph('Hostel Block A', 200),
    scout2: ph('Boys Qtrs', 280),
    scout3: ph('Face-me Block', 320)
  };

  function iso(hoursAgo) {
    return new Date(Date.now() - hoursAgo * 36e5).toISOString();
  }

  /* Care plans are bought and spent in weeks, not hours. */
  function daysAgo(days) {
    return new Date(Date.now() - days * 864e5).toISOString();
  }

  function seed() {
    var now = new Date().toISOString();

    var demand_records = [
      {
        id: 'd1a2c3d4-0001-4a1a-9d01-111111111111', created_at: iso(3), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'open', notes: '',
        first_name: 'Amina', phone: '08031112233', room_type: 'Self-contain',
        budget_band: '₦150k–₦200k', distance: 'Within 10 min walk', timing: 'Immediately',
        is_minor: false,
        payload: { first: 'Amina', phone: '08031112233', type: 'Self-contain', budget: '₦150k–₦200k', dist: 'Within 10 min walk', when: 'Immediately', age: '18-24', roommate: 'no', pain: 'Current room has no running water.', ref: 'whatsapp-status' }
      },
      {
        id: 'd1a2c3d4-0002-4a1a-9d01-222222222222', created_at: iso(26), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'open', notes: 'Follow up Friday',
        first_name: 'Tunde', phone: '08054445566', room_type: 'Shared room',
        budget_band: 'Under ₦100k', distance: 'Behind campus gate', timing: 'Next week',
        is_minor: true,
        payload: { first: 'Tunde', phone: '08054445566', type: 'Shared room', budget: 'Under ₦100k', dist: 'Behind campus gate', when: 'Next week', age: 'Under 18', roommate: 'no' }
      },
      {
        id: 'd1a2c3d4-0003-4a1a-9d01-333333333333', created_at: iso(50), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'open', notes: '',
        first_name: 'Blessing', phone: '08077778899', room_type: 'Single Room',
        budget_band: '₦100k–₦150k', distance: 'Within 10 min walk', timing: 'In 2 weeks',
        is_minor: false,
        payload: { first: 'Blessing', phone: '08077778899', type: 'Single Room', budget: '₦100k–₦150k', dist: 'Within 10 min walk', when: 'In 2 weeks', age: '18-24', roommate: 'yes', mate_gender: 'female', mate_budget: '₦100k–₦150k', mate_style: 'Quiet' }
      },
      {
        id: 'd1a2c3d4-0004-4a1a-9d01-444444444444', created_at: iso(70), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'matched', notes: '',
        first_name: 'Khadija', phone: '08012123434', room_type: 'Shared room',
        budget_band: 'Under ₦100k', distance: 'Malete', timing: 'Immediately', is_minor: false,
        payload: { first: 'Khadija', phone: '08012123434', type: 'Shared room', budget: 'Under ₦100k', dist: 'Malete', when: 'Immediately', age: '18-24', roommate: 'yes', mate_gender: 'female', mate_budget: 'Under ₦100k', mate_style: 'Quiet', partner_ref: 'd1a2c3d4-0005-4a1a-9d01-555555555555', matched_at: iso(20), matched_with: 'Zainab' }
      },
      {
        id: 'd1a2c3d4-0005-4a1a-9d01-555555555555', created_at: iso(68), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'matched', notes: '',
        first_name: 'Zainab', phone: '08098787676', room_type: 'Shared room',
        budget_band: 'Under ₦100k', distance: 'Malete', timing: 'Immediately', is_minor: false,
        payload: { first: 'Zainab', phone: '08098787676', type: 'Shared room', budget: 'Under ₦100k', dist: 'Malete', when: 'Immediately', age: '18-24', roommate: 'yes', mate_gender: 'female', mate_budget: 'Under ₦100k', mate_style: 'Quiet', partner_ref: 'd1a2c3d4-0004-4a1a-9d01-444444444444', matched_at: iso(20), matched_with: 'Khadija' }
      },
      {
        id: 'd1a2c3d4-0006-4a1a-9d01-666666666666', created_at: iso(200), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'fulfilled', notes: 'Moved in',
        first_name: 'Emeka', phone: '08065654747', room_type: 'Self-contain',
        budget_band: '₦200k–₦300k', distance: 'Within 10 min walk', timing: 'Immediately', is_minor: false,
        payload: { first: 'Emeka', phone: '08065654747', type: 'Self-contain', budget: '₦200k–₦300k', dist: 'Within 10 min walk', when: 'Immediately', age: '25+', roommate: 'no' }
      },
      {
        id: 'd1a2c3d4-0007-4a1a-9d01-777777777777', created_at: iso(24 * 30), session: '2026/2027',
        env: 'production', source: 'register.html', status: 'expired', notes: '',
        first_name: 'Suli', phone: '', room_type: 'Hostel bunk',
        budget_band: 'Under ₦100k', distance: '—', timing: 'Last session', is_minor: false,
        payload: { first: 'Suli', type: 'Hostel bunk', budget: 'Under ₦100k', dist: '—', when: 'Last session', age: '18-24', roommate: 'no' }
      },
      {
        id: 'd1a2c3d4-0008-4a1a-9d01-888888888888', created_at: iso(5), session: '2026/2027',
        env: 'test', source: 'seed-script', status: 'open', notes: 'test row',
        first_name: 'TEST-Row', phone: '0000000000', room_type: 'Test',
        budget_band: '—', distance: '—', timing: '—', is_minor: false,
        payload: { first: 'TEST-Row', type: 'Test', budget: '—', dist: '—', when: '—', age: '18-24', roommate: 'no' }
      }
    ];

    var listings = [
      {
        id: 'e2b3d4e5-0001-4b2b-8e02-111111111111', created_at: iso(6), session: '2026/2027',
        env: 'production', source: 'admin_dashboard', status: 'active', tier: 2,
        opening_ask_ngn: 200000, listed_price_ngn: 185000,
        latitude: 9.1922, longitude: 4.6661, photo_url: IMG.blessing, notes: '',
        payload: {
          apt_id: 'APT-001', custom_id: 'APT-001', prop_name: 'Blessing Lodge', ty: 'Self-contain',
          ar: 'Behind KWASU Gate, Malete', rent: '185000', rm: '3 rooms available',
          nm: 'Alh. Kareem', last: '', ph: '08033445566', neg: 'Yes', who: 'A caretaker',
          desc: 'Running water, prepaid meter, paved compound, 5 mins walk to school.',
          photo: IMG.blessing, video: '', video_url: '',
          media: [{ type: 'image', url: IMG.blessing, label: 'Compound view', credit: { holder: 'Arzuz', year: 2026, note: 'Verified apartment media' } }],
          split_ok: false, ut: ['Borehole water', 'NEPA connection', 'Security gate', 'Perimeter fence'],
          utilities: ['Borehole water', 'NEPA connection', 'Security gate', 'Perimeter fence'],
          lat: '9.1922', lng: '4.6661', pin: '9.192200,4.666100',
          pin_meta: { source: 'gps', accuracy_m: 8, samples: 12 },
          vf: 'Yes, come and check it'
        }
      },
      {
        id: 'e2b3d4e5-0002-4b2b-8e02-222222222222', created_at: iso(30), session: '2026/2027',
        env: 'production', source: 'admin_dashboard', status: 'active', tier: 1,
        opening_ask_ngn: 150000, listed_price_ngn: 150000,
        latitude: 9.1905, longitude: 4.6642, photo_url: IMG.mlt, notes: '',
        payload: {
          apt_id: 'APT-002', custom_id: 'APT-002', prop_name: 'MLT Court', ty: 'Single Room',
          ar: 'Opposite MLT building', rent: '150000', rm: '5 rooms', nm: 'Mallam Sani', ph: '08055667788',
          neg: 'No', who: 'I do, myself', desc: 'Tiled floors, new roof.', photo: IMG.mlt, video: '', video_url: '',
          media: [{ type: 'image', url: IMG.mlt, label: 'Front', credit: { holder: 'Arzuz', year: 2026, note: 'Verified apartment media' } }],
          split_ok: true, ut: ['Pipe-borne water', 'Flush toilet', 'Private bathroom'],
          utilities: ['Pipe-borne water', 'Flush toilet', 'Private bathroom'],
          lat: '9.1905', lng: '4.6642', pin: '9.190500,4.664200',
          pin_meta: { source: 'tapped', accuracy_m: null, samples: 1 }
        }
      },
      {
        id: 'e2b3d4e5-0003-4b2b-8e02-333333333333', created_at: iso(54), session: '2026/2027',
        env: 'production', source: 'admin_dashboard', status: 'active', tier: 2,
        opening_ask_ngn: null, listed_price_ngn: 220000,
        latitude: 9.1880, longitude: 4.6690, photo_url: IMG.kwara, notes: '',
        payload: {
          apt_id: 'APT-003', custom_id: 'APT-003', prop_name: 'Kwara Gardens', ty: 'Two Bedroom',
          ar: 'Old Market Road', rent: '220000', rm: '2 units', nm: 'Chief Ola', ph: '08012123434',
          neg: 'Depends on the tenant', who: 'An agent', desc: 'Big compound, generator at night.',
          photo: IMG.kwara, video: '', video_url: '',
          media: [{ type: 'image', url: IMG.kwara, label: 'Gate', credit: { holder: 'Arzuz', year: 2026, note: 'Verified apartment media' } }],
          split_ok: false, ut: ['Generator backup', 'Borehole water'], utilities: ['Generator backup', 'Borehole water'],
          lat: '9.1880', lng: '4.6690', pin: '9.188000,4.669000', pin_meta: { source: 'dragged', accuracy_m: 15, samples: 4 }
        }
      },
      {
        id: 'e2b3d4e5-0004-4b2b-8e02-444444444444', created_at: iso(12), session: '2026/2027',
        env: 'production', source: 'admin_dashboard', status: 'active', tier: 2,
        opening_ask_ngn: null, listed_price_ngn: 95000,
        latitude: null, longitude: null, photo_url: IMG.peace, notes: '',
        payload: {
          apt_id: 'APT-004', custom_id: 'APT-004', prop_name: 'Peace Villa', ty: 'Face-me-I-face-you',
          ar: 'Sango Road, Malete', rent: '95000', rm: '4 rooms', nm: 'Mrs Peace', ph: '08044332211',
          neg: 'Yes', who: 'I do, myself', desc: 'Quiet street.', photo: IMG.peace, video: '', video_url: '',
          media: [{ type: 'image', url: IMG.peace, label: '', credit: { holder: 'Arzuz', year: 2026, note: 'Verified apartment media' } }],
          split_ok: false, ut: ['NEPA connection', 'Kitchen access'], utilities: ['NEPA connection', 'Kitchen access']
        }
      },
      {
        id: 'e2b3d4e5-0005-4b2b-8e02-555555555555', created_at: iso(20), session: '2026/2027',
        env: 'production', source: 'admin_dashboard', status: 'pending', tier: 0,
        opening_ask_ngn: null, listed_price_ngn: null, latitude: null, longitude: null,
        photo_url: '', notes: 'Waiting on landlord photos',
        payload: { apt_id: 'APT-005', custom_id: 'APT-005', prop_name: 'Sabo Flats', ty: 'Hostel', ar: 'Sabo Junction', rent: '', rm: '', nm: '', ph: '', neg: '', who: '', desc: '', photo: '', video: '', video_url: '', media: [], split_ok: false, ut: [], utilities: [] }
      },
      {
        id: 'e2b3d4e5-0006-4b2b-8e02-666666666666', created_at: iso(18), session: '2026/2027',
        env: 'production', source: 'admin_dashboard_draft', status: 'draft', tier: 2,
        opening_ask_ngn: null, listed_price_ngn: 120000, latitude: null, longitude: null,
        photo_url: '', notes: 'Draft — invite link created in dashboard (APT-006)',
        draft_token: 'tok-invite-pending-abc123', draft_completed_at: null, draft_last_saved_at: null,
        payload: { apt_id: 'APT-006', custom_id: 'APT-006', prop_name: 'Ile Oluwo Rooms', ty: 'Single Room', ar: 'Oluwo Street', rent: '120000', rm: '2 rooms', nm: 'Baba Oluwo', ph: '08023456789', neg: 'Yes', who: '', desc: '', photo: '', video: '', video_url: '', media: [], split_ok: false, ut: ['Borehole water'], utilities: ['Borehole water'] }
      },
      {
        id: 'e2b3d4e5-0007-4b2b-8e02-777777777777', created_at: iso(40), session: '2026/2027',
        env: 'production', source: 'admin_dashboard_draft', status: 'draft', tier: 1,
        opening_ask_ngn: 110000, listed_price_ngn: 100000, latitude: null, longitude: null,
        photo_url: '', notes: 'Draft — invite link created in dashboard (APT-007)',
        draft_token: 'tok-invite-done-def456', draft_completed_at: iso(4), draft_last_saved_at: iso(4),
        payload: { apt_id: 'APT-007', custom_id: 'APT-007', prop_name: 'Ashafa Lodge', ty: 'Self-contain', ar: 'Ashafa Road', rent: '100000', rm: '1 unit', nm: 'Alh. Ashafa', ph: '08032112345', neg: 'No', who: 'A caretaker', desc: 'Landlord completed the form.', photo: '', video: '', video_url: '', media: [], split_ok: false, ut: [], utilities: [] }
      },
      {
        id: 'e2b3d4e5-0008-4b2b-8e02-888888888888', created_at: iso(300), session: '2025/2026',
        env: 'production', source: 'owner-list.html', status: 'inactive', tier: 0,
        opening_ask_ngn: 90000, listed_price_ngn: 80000, latitude: null, longitude: null,
        photo_url: '', notes: '',
        payload: { apt_id: 'APT-000', custom_id: 'APT-000', prop_name: 'Old Demo Flat', ty: 'Boys quarters', ar: 'Demo area', rent: '80000', rm: '', nm: '', ph: '', neg: '', who: '', desc: '', photo: '', video: '', video_url: '', media: [], split_ok: false, ut: [], utilities: [] }
      },
      {
        id: 'e2b3d4e5-0009-4b2b-8e02-999999999999', created_at: iso(2), session: '2026/2027',
        env: 'test', source: 'seed-script', status: 'active', tier: 2,
        opening_ask_ngn: 1, listed_price_ngn: 1, latitude: null, longitude: null,
        photo_url: '', notes: 'test row',
        payload: { apt_id: 'TEST-1', custom_id: 'TEST-1', prop_name: 'TEST Listing', ty: 'Test', ar: 'Test', rent: '1', rm: '', nm: '', ph: '', neg: '', who: '', desc: '', photo: '', video: '', video_url: '', media: [], split_ok: false, ut: [], utilities: [] }
      }
    ];

    var scout_submissions = [
      {
        id: 'f3c4e5f6-0001-4c3c-7f03-111111111111', created_at: iso(9), session: '2026/2027',
        env: 'production', source: 'scout.html', status: 'pending', notes: '',
        photo_url: IMG.scout1, latitude: 9.1950, longitude: 4.6610,
        payload: { area: 'Campus Road, Block A', phone: '08011112222', amt: '120000', vac: '2 rooms empty', ut: ['NEPA connection', 'Borehole water'], lat: '9.1950', lng: '4.6610', pin: '9.195000,4.661000', pin_meta: { source: 'gps', accuracy_m: 6, samples: 10 }, who: 'A caretaker' }
      },
      {
        id: 'f3c4e5f6-0002-4c3c-7f03-222222222222', created_at: iso(33), session: '2026/2027',
        env: 'production', source: 'scout.html', status: 'pending', notes: '',
        photo_url: IMG.scout2, latitude: 9.1870, longitude: 4.6702,
        payload: { area: 'Boys Qtrs, Sango', phone: '08022223333', amt: '80000', vac: 'Full', ut: ['Generator backup'], lat: '9.1870', lng: '4.6702', pin: '9.187000,4.670200', pin_meta: { source: 'tapped' }, who: 'Nobody yet' }
      },
      {
        id: 'f3c4e5f6-0003-4c3c-7f03-333333333333', created_at: iso(80), session: '2026/2027',
        env: 'production', source: 'scout.html', status: 'pending', notes: '',
        photo_url: IMG.scout3, latitude: 9.1960, longitude: 4.6590,
        payload: { area: 'Face-me Block, Old Market', phone: '08033334444', amt: '65000', vac: '3 rooms empty', ut: ['Flush toilet', 'Pipe-borne water'], lat: '9.1960', lng: '4.6590', pin: '9.196000,4.659000', pin_meta: { source: 'tapped' }, who: 'An agent' }
      },
      {
        id: 'f3c4e5f6-0004-4c3c-7f03-444444444444', created_at: iso(4), session: '2026/2027',
        env: 'test', source: 'seed-script', status: 'pending', notes: 'test row',
        photo_url: '', latitude: null, longitude: null,
        payload: { area: 'TEST Scout', phone: '', amt: '1', vac: '—', ut: [] }
      }
    ];

    var booking_requests = [
      {
        id: 'a4d5f6a7-0001-4d4d-6a04-111111111111', created_at: iso(2), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'pending', notes: '', listing_id: 'e2b3d4e5-0001-4b2b-8e02-111111111111',
        payload: { name: 'Amina', phone: '08031112233', when: 'This weekend', listing_name: 'Blessing Lodge', roommate: 'no' }
      },
      {
        id: 'a4d5f6a7-0002-4d4d-6a04-222222222222', created_at: iso(28), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'pending', notes: '', listing_id: 'e2b3d4e5-0002-4b2b-8e02-222222222222',
        payload: { name: 'Blessing', phone: '08077778899', when: 'Next week', listing_name: 'MLT Court', roommate: 'yes', mate_gender: 'female', mate_budget: '₦100k–₦150k', mate_style: 'Quiet', note: 'Please a room close to the gate.' }
      },
      {
        id: 'a4d5f6a7-0003-4d4d-6a04-333333333333', created_at: iso(52), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'confirmed', notes: '', listing_id: 'e2b3d4e5-0001-4b2b-8e02-111111111111',
        payload: { name: 'Emeka', phone: '08065654747', when: 'Saturday 10am', listing_name: 'Blessing Lodge', roommate: 'no' }
      },
      {
        id: 'a4d5f6a7-0004-4d4d-6a04-444444444444', created_at: iso(96), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'completed', notes: '', listing_id: 'e2b3d4e5-0002-4b2b-8e02-222222222222',
        payload: { name: 'Khadija', phone: '08012123434', when: 'Last week', listing_name: 'MLT Court', roommate: 'no' }
      }
    ];

    var support_tickets = [
      {
        id: 'b5e6a7b8-0001-4e5e-5b05-111111111111', created_at: iso(5), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'open', notes: '',
        payload: { name: 'Amina', phone: '08031112233', category: 'listing_problem', listing_name: 'Blessing Lodge', message: 'The water stopped running since Tuesday.' }
      },
      {
        id: 'b5e6a7b8-0002-4e5e-5b05-222222222222', created_at: iso(75), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'open', notes: '',
        payload: { name: 'Tunde', phone: '08054445566', category: 'payment_or_fees', listing_name: 'Sabo Flats', message: 'Someone claiming to be from Arzuz asked for an inspection fee.' }
      },
      {
        id: 'b5e6a7b8-0003-4e5e-5b05-333333333333', created_at: iso(14), session: '2026/2027',
        env: 'production', source: 'admin_dashboard_phone', status: 'in_progress', notes: '',
        payload: { name: 'Mrs Adaeze (phone)', phone: '08091234567', category: 'booking_issue', listing_name: 'Kwara Gardens', message: 'Agent did not show up for the confirmed viewing.' }
      },
      {
        id: 'b5e6a7b8-0004-4e5e-5b05-444444444444', created_at: iso(120), session: '2026/2027',
        env: 'production', source: 'listing.html', status: 'resolved', notes: 'Fixed',
        payload: { name: 'Emeka', phone: '08065654747', category: 'other', listing_name: '', message: 'Wrong price shown on the listing page.' }
      },
      {
        id: 'b5e6a7b8-0005-4e5e-5b05-555555555555', created_at: iso(1), session: '2026/2027',
        env: 'test', source: 'seed-script', status: 'open', notes: 'test row',
        payload: { name: 'TEST', phone: '', category: 'other', listing_name: '', message: 'test ticket' }
      }
    ];

    var amenities = [{ name: 'Solar panels' }, { name: 'Security cameras' }];

    /* view: under-18 demand rows with no guardian on file */
    var minors_needing_guardian = demand_records.filter(function (r) {
      return r.is_minor === true && !(r.payload && (r.payload.g_phone || r.payload.g_name));
    }).map(function (r) {
      return { id: r.id, first_name: r.first_name, phone: r.phone, budget_band: r.budget_band, created_at: r.created_at };
    });

    var roommate_match_summary = [
      { roommate_demands_total: 3, matched_total: 2, matched_within_14d: 2, pct_matched_within_14d: 67 }
    ];

    /* ---- the questionnaire-backed pool (supabase-roommate.sql) ----
       TWO roommate metrics now exist and they are NOT the same number,
       so both are seeded on purpose:
         roommate_match_summary  — shared demand paired by hand from the
                                   Bookings / Demands side (above)
         roommate_engine_summary — the questionnaire pool below

       Each profile carries its payload AND the generated columns the
       real table computes from it, because the panel reads the columns
       directly. A mock that only had payload would render a row of
       blanks and still pass. */

    function mateProfile(id, hoursAgo, answers, meta) {
      var a = Object.assign({
        name: 'Student', phone: '2348000000000', gender: 'Female', area: 'Malete',
        sleep: '10pm – 12am', wake: '6 – 8am', clean: 'Weekly', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '90000',
        split: 'I can pay my half', want_gender: 'Same gender as me'
      }, answers || {});
      meta = meta || {};

      return {
        id: id,
        created_at: iso(hoursAgo),
        updated_at: iso(hoursAgo),
        token_hash: 'mockhash-' + id.slice(-6),
        payload: {
          name: a.name, phone: a.phone, gender: a.gender, area: a.area,
          sleep: a.sleep, wake: a.wake, clean: a.clean, guests: a.guests,
          smoke: a.smoke, noise: a.noise, budget: a.budget, split: a.split,
          want_gender: a.want_gender, dealbreakers: a.dealbreakers || [], note: a.note || ''
        },
        session: '2026/2027',
        env: meta.env || 'production',
        source: 'roommates.html',
        referrer: null,
        user_agent: 'mock-harness',
        status: meta.status || 'open',
        notes: meta.notes || '',
        first_name: a.name, phone: a.phone, gender: a.gender, area: a.area,
        sleep: a.sleep, wake: a.wake, cleanliness: a.clean, guests: a.guests,
        smoking: a.smoke, noise: a.noise, split_ok: a.split,
        dealbreakers: a.dealbreakers || [],
        budget_ngn: Number(a.budget)
      };
    }

    var roommate_profiles = [
      /* five OPEN profiles, deliberately at odds with each other so the
         panel's chips show a real spread instead of five tidy students */
      mateProfile('f0a1b2c3-0001-4f0a-8a01-111111111111', 4, {
        name: 'Aminah', phone: '2348031112233', gender: 'Female', area: 'Malete',
        sleep: 'After midnight', wake: 'After 9am', clean: 'As needed', guests: 'Most days',
        smoke: 'Non-smoker', noise: 'Lively', budget: '120000',
        dealbreakers: ['Very different sleep'], note: 'Final year, up late most nights.'
      }),
      mateProfile('f0a1b2c3-0002-4f0a-8a01-222222222222', 9, {
        name: 'Bashir', phone: '2348032223344', gender: 'Male', area: 'Oke-Odo',
        sleep: 'Before 10pm', wake: 'Before 6am', clean: 'Daily', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '95000',
        dealbreakers: ['Smoking', 'Frequent guests']
      }),
      mateProfile('f0a1b2c3-0003-4f0a-8a01-333333333333', 14, {
        name: 'Chidi', phone: '2348033334455', gender: 'Male', area: 'Malete',
        sleep: '10pm – 12am', wake: '6 – 8am', clean: 'Weekly', guests: 'Some weekends',
        smoke: 'Smoker', noise: 'Balanced', budget: '70000',
        split: 'I need help covering my half', note: 'Smoke outside only.'
      }),
      mateProfile('f0a1b2c3-0004-4f0a-8a01-444444444444', 22, {
        name: 'Damilola', phone: '2348034445566', gender: 'Female', area: 'Yikpata',
        sleep: 'After midnight', wake: '6 – 8am', clean: 'Weekly', guests: 'Some weekends',
        smoke: 'Smoker (outside only)', noise: 'Balanced', budget: '85000',
        dealbreakers: ['Loud noise']
      }),
      mateProfile('f0a1b2c3-0005-4f0a-8a01-555555555555', 30, {
        name: 'Efe', phone: '2348035556677', gender: 'Female', area: 'Malete',
        sleep: '10pm – 12am', wake: '6 – 8am', clean: 'Daily', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '180000',
        want_gender: 'Any gender', want_clean: 'Similar to mine', want_noise: 'Similar to mine'
      }),

      /* two mutual pairs, so four MATCHED profiles. Pair one answered
         within hours; pair two took 30 days, which is OUTSIDE the
         14-day window — so the pair count and the engine percentage
         disagree, exactly as they should. */
      mateProfile('f0a1b2c3-0006-4f0a-8a01-666666666666', 20, {
        name: 'Grace', phone: '2348036667788', gender: 'Female', area: 'Malete',
        sleep: '10pm – 12am', wake: '6 – 8am', clean: 'Weekly', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '90000'
      }, { status: 'matched' }),
      mateProfile('f0a1b2c3-0007-4f0a-8a01-777777777777', 20, {
        name: 'Halima', phone: '2348037778899', gender: 'Female', area: 'Malete',
        sleep: '10pm – 12am', wake: '6 – 8am', clean: 'Weekly', guests: 'Some weekends',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '95000'
      }, { status: 'matched' }),
      mateProfile('f0a1b2c3-0008-4f0a-8a01-888888888888', 960, {
        name: 'Ibrahim', phone: '2348038889900', gender: 'Male', area: 'Oke-Odo',
        sleep: 'Before 10pm', wake: 'Before 6am', clean: 'Daily', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '80000'
      }, { status: 'matched' }),
      mateProfile('f0a1b2c3-0009-4f0a-8a01-999999999999', 960, {
        name: 'Jide', phone: '2348039990011', gender: 'Male', area: 'Oke-Odo',
        sleep: 'Before 10pm', wake: 'Before 6am', clean: 'Daily', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Quiet', budget: '85000'
      }, { status: 'matched' }),

      /* withdrew — must disappear from everyone's list */
      mateProfile('f0a1b2c3-0010-4f0a-8a01-aaaaaaaaaaaa', 40, {
        name: 'Kemi', phone: '2348041112233', gender: 'Female', area: 'Malete'
      }, { status: 'closed', notes: 'Student withdrew' }),

      /* a test-env profile: the production filter must hide it */
      mateProfile('f0a1b2c3-0011-4f0a-8a01-bbbbbbbbbbbb', 2, {
        name: 'TEST-Pool', phone: '2348000000000'
      }, { env: 'test' }),

      /* The student the "why they are still waiting" block exists for:
         a night owl who will not live with an early riser or a smoker,
         and the only two men in the pool are exactly those two. Every
         candidate is vetoed — by his own deal-breakers, not by a bug —
         so the dashboard must say so instead of leaving him sitting in
         a waiting list that will never move. Realistic on purpose: one
         more man answers the questionnaire and he matches.

         (Verified through the shared scorer in dev/admin-boot-test.js,
         which recomputes this from the dataset rather than trusting a
         number written here.) */
      mateProfile('f0a1b2c3-0012-4f0a-8a01-cccccccccccc', 6, {
        name: 'Musa', phone: '2348042223344', gender: 'Male', area: 'Oke-Odo',
        sleep: 'After midnight', wake: 'After 9am', clean: 'Weekly', guests: 'Rarely',
        smoke: 'Non-smoker', noise: 'Balanced', budget: '110000',
        dealbreakers: ['Smoking', 'Very different sleep'],
        note: 'Night owl. Neither of the other two guys works.'
      })
    ];

    var roommate_interests = [
      /* pair one — both said yes within hours */
      { id: 'c1a2b3c4-0001-4c1a-8c01-111111111111', created_at: iso(18),
        from_ref: 'f0a1b2c3-0006-4f0a-8a01-666666666666', to_ref: 'f0a1b2c3-0007-4f0a-8a01-777777777777', decision: 'accept' },
      { id: 'c1a2b3c4-0002-4c1a-8c01-222222222222', created_at: iso(17),
        from_ref: 'f0a1b2c3-0007-4f0a-8a01-777777777777', to_ref: 'f0a1b2c3-0006-4f0a-8a01-666666666666', decision: 'accept' },
      /* pair two — matched, but the second yes landed 30 days later */
      { id: 'c1a2b3c4-0003-4c1a-8c01-333333333333', created_at: iso(250),
        from_ref: 'f0a1b2c3-0008-4f0a-8a01-888888888888', to_ref: 'f0a1b2c3-0009-4f0a-8a01-999999999999', decision: 'accept' },
      { id: 'c1a2b3c4-0004-4c1a-8c01-444444444444', created_at: iso(240),
        from_ref: 'f0a1b2c3-0009-4f0a-8a01-999999999999', to_ref: 'f0a1b2c3-0008-4f0a-8a01-888888888888', decision: 'accept' },
      /* one-sided — waiting on the other student, so no contact either way */
      { id: 'c1a2b3c4-0005-4c1a-8c01-555555555555', created_at: iso(9),
        from_ref: 'f0a1b2c3-0001-4f0a-8a01-111111111111', to_ref: 'f0a1b2c3-0002-4f0a-8a01-222222222222', decision: 'accept' },
      /* a pass — counted nowhere */
      { id: 'c1a2b3c4-0006-4c1a-8c01-666666666666', created_at: iso(7),
        from_ref: 'f0a1b2c3-0002-4f0a-8a01-222222222222', to_ref: 'f0a1b2c3-0003-4f0a-8a01-333333333333', decision: 'pass' }
    ];

    /* Both views are DERIVED from the rows above, the way the SQL derives
       them, so a count can never drift from the data it counts. */
    var poolById = {};
    roommate_profiles.forEach(function (p) { poolById[p.id] = p; });

    var accepts = roommate_interests.filter(function (i) { return i.decision === 'accept'; });
    var mutual = accepts.filter(function (a) {
      if (a.from_ref >= a.to_ref) return false;   /* one row per pair */
      return accepts.some(function (b) {
        return b.from_ref === a.to_ref && b.to_ref === a.from_ref;
      });
    }).map(function (a) {
      var back = accepts.filter(function (b) {
        return b.from_ref === a.to_ref && b.to_ref === a.from_ref;
      })[0];
      /* the pair completes when the SECOND yes lands */
      return {
        from_ref: a.from_ref,
        to_ref: a.to_ref,
        matched_at: new Date(a.created_at) > new Date(back.created_at) ? a.created_at : back.created_at
      };
    });

    var prodProfiles = roommate_profiles.filter(function (p) { return p.env === 'production'; });
    var paired = prodProfiles.filter(function (p) {
      return mutual.some(function (m) { return m.from_ref === p.id || m.to_ref === p.id; });
    });
    var within14 = paired.filter(function (p) {
      var m = mutual.filter(function (x) { return x.from_ref === p.id || x.to_ref === p.id; })[0];
      return m && (new Date(m.matched_at) - new Date(p.created_at)) <= 14 * 864e5;
    });

    var roommate_engine_summary = [{
      profiles_total: prodProfiles.length,
      profiles_open: prodProfiles.filter(function (p) { return p.status === 'open'; }).length,
      profiles_matched: prodProfiles.filter(function (p) { return p.status === 'matched'; }).length,
      mutual_pairs: mutual.length,
      profiles_matched_total: paired.length,
      matched_within_14d: within14.length,
      pct_matched_within_14d: prodProfiles.length
        ? Math.round(1000 * within14.length / prodProfiles.length) / 10
        : 0
    }];

    var roommate_mutual_pairs = mutual.map(function (m) {
      var a = poolById[m.from_ref], b = poolById[m.to_ref];
      return {
        matched_at: m.matched_at,
        a_id: a.id, a_name: a.first_name, a_phone: a.phone, a_area: a.area,
        a_budget: a.budget_ngn, a_split: a.split_ok,
        b_id: b.id, b_name: b.first_name, b_phone: b.phone, b_area: b.area,
        b_budget: b.budget_ngn, b_split: b.split_ok
      };
    }).sort(function (x, y) { return String(y.matched_at).localeCompare(String(x.matched_at)); });

    /* ---- the append-only consent trail (supabase-roommate.sql §5) ----
       Derived from the rows above, the way the engine's views are, so the
       trail cannot disagree with the decisions it documents. Two things
       here are real and are reproduced: a mutual pair gets the 'accept'
       from EACH side plus ONE 'matched' row, and the actor of that
       'matched' row is whoever said yes SECOND — that tap is the unlock,
       which is exactly what a dispute turns on. */
    var roommate_events = (function () {
      var ev = [];
      function push(when, event, actor, subject) {
        ev.push({
          id: ev.length + 1,
          created_at: when,
          event: event,
          actor_ref: actor.id, actor_name: actor.first_name,
          subject_ref: subject.id, subject_name: subject.first_name,
          env: actor.env, session: actor.session
        });
      }

      roommate_profiles.forEach(function (p) { push(p.created_at, 'created', p, p); });

      roommate_interests.forEach(function (i) {
        var from = poolById[i.from_ref], to = poolById[i.to_ref];
        if (from && to) push(i.created_at, i.decision === 'accept' ? 'accept' : 'pass', from, to);
      });

      /* a withdrawn profile leaves a line too — "this student asked us to
         stop" is the kind of thing a later dispute turns on */
      roommate_profiles.forEach(function (p) {
        if (p.status !== 'closed') return;
        push(new Date(new Date(p.created_at).getTime() + 6 * 36e5).toISOString(), 'withdrawn', p, p);
      });

      mutual.forEach(function (m) {
        var a = poolById[m.from_ref], b = poolById[m.to_ref];
        var find = function (f, t) {
          return roommate_interests.filter(function (i) { return i.from_ref === f && i.to_ref === t; })[0];
        };
        var iA = find(m.from_ref, m.to_ref), iB = find(m.to_ref, m.from_ref);
        var first = new Date(iA.created_at) >= new Date(iB.created_at);
        push(m.matched_at, 'matched', first ? a : b, first ? b : a);

        /* The follow-through signal: ONE side came back and was shown the
           match's contact details. Written by the engine on the first
           visit, one row per pair (roommate-match.js → noteViewed), and
           read by the daily digest to tell a live match from one nobody
           has opened. Only one side here on purpose: the dashboard should
           be developed against a half-quiet pair, not only the tidy case. */
        push(new Date(new Date(m.matched_at).getTime() + 2 * 36e5).toISOString(), 'viewed', a, b);
      });

      ev.sort(function (x, y) { return String(y.created_at).localeCompare(String(x.created_at)); });
      return ev;
    })();

    /* ---- Arzuz Care (supabase-care.sql) ----------------------------
       Three plans, chosen so the panel is developed against the cases
       that actually differ:

         - one ACTIVE with a call-out already spent (3 of 4 left, and a
           refund must therefore be refused)
         - one ACTIVE and untouched (4 of 4, refundable)
         - one REFUNDED (nothing left, buttons disabled)

       The ledger is DERIVED from the plans, the way the engine's views
       are derived, so a balance can never disagree with the events that
       explain it. It carries an 'adjusted' row too, because a correction
       is the case a counter would silently lose. */
    var care_plans = (function () {
      function plan(over) {
        return Object.assign({
          id: null, created_at: daysAgo(30), session: '2026/2027', env: 'production',
          status: 'active', amount_ngn: 20000, starts_at: daysAgo(30), ends_at: null,
          first_name: null, phone: null, area: 'Malete', property: null, notes: null,
          source: 'care.html', last_event_at: null
        }, over);
      }
      var list = [
        plan({ id: 'care-0001', token_hash: 'mock-care-hash-1', first_name: 'Halima', phone: '+2348030000001',
               area: 'Malete', property: 'Blessing Lodge', created_at: daysAgo(46) }),
        plan({ id: 'care-0002', token_hash: 'mock-care-hash-2', first_name: 'Ifeoma', phone: '+2348030000002',
               area: 'Oke-Odo', property: 'Peace Court', created_at: daysAgo(12) }),
        plan({ id: 'care-0003', token_hash: 'mock-care-hash-3', first_name: 'Bashir', phone: '+2348030000003',
               area: 'Yikpata', property: null, status: 'refunded', created_at: daysAgo(70) })
      ];
      return list;
    })();

    var care_credit_events = (function () {
      var ev = [];
      function push(plan, when, event, delta, extra) {
        ev.push(Object.assign({
          id: ev.length + 1, created_at: when, plan_id: plan.id,
          student_name: plan.first_name, session: plan.session, event: event, delta: delta,
          reason: null, worker: null, parts_ngn: null, note: null,
          actor_ref: null, actor_name: null, env: plan.env
        }, extra || {}));
      }
      care_plans.forEach(function (p) {
        push(p, p.created_at, 'granted', 4, {
          reason: 'Care for ' + p.session + ' — 4 call-outs, 20000 naira paid',
          actor_ref: 'u-support', actor_name: 'support'
        });
      });

      /* The one with a call-out behind it: a blocked sink, parts under the
         included ceiling. */
      var one = care_plans[0];
      push(one, daysAgo(20), 'spent', -1, {
        worker: 'Compound caretaker', parts_ngn: 1200,
        reason: 'blocked kitchen sink',
        actor_ref: 'u-support', actor_name: 'support'
      });

      /* A correction on the OTHER plan — a credit taken back without any
         call-out existing to explain it. This is the case a counter would
         silently lose, and the panel must show 3 of 4 with zero call-outs
         rather than either 4 or "1 used". */
      var two = care_plans[1];
      push(two, daysAgo(9), 'adjusted', -1, {
        reason: 'double-counted on the phone list — one credit taken back',
        actor_ref: 'u-admin', actor_name: 'owner'
      });

      var gone = care_plans[2];
      push(gone, daysAgo(60), 'refunded', -4, {
        reason: 'Refunded before the session started — 4 unused call-outs voided with the fee',
        actor_ref: 'u-admin', actor_name: 'owner'
      });

      ev.sort(function (x, y) { return String(y.created_at).localeCompare(String(x.created_at)); });
      return ev;
    })();

    /* Repair claims — the queue the dashboard works.

       One row per branch the panel has to render: undecided, covered and
       waiting for a worker, with a worker and waiting on the customer,
       disputed, covered-but-nothing-left-to-spend, and a refusal with
       its reason.

       The claims that hold a call-out get the matching 'reserved' row
       appended to the Care ledger right here — BEFORE care_plans_live is
       computed, which is the whole point of the placement: a claim's
       call-out number is only believable if the ledger moved with it,
       and the Care panel reads those same rows. */
    var repair_claims = (function () {
      function claim(over) {
        return Object.assign({
          id: null, created_at: daysAgo(3), updated_at: daysAgo(3),
          reference: null, plan_id: null, payment_id: null, env: 'production',
          status: 'submitted', student_name: null, student_phone: null,
          property: null, room: null, issue: null, photos: [],
          eligibility: null, eligibility_reason: null, decided_by: null, decided_at: null,
          call_out_no: null, reserved_at: null,
          provider_name: null, provider_phone: null, assigned_at: null, assigned_by: null,
          /* The worker's own words, in the same shapes the function writes
             them: what they answered, when, what a day they offered, and
             when they offered it. A fixture row without these fields is a
             panel that has never rendered a real answer. */
          provider_email: null, provider_answer: null, provider_answered_at: null,
          provider_answer_note: null, provider_proposal: null, provider_proposed_at: null,
          /* And the CUSTOMER'S half of the same conversation: the instant
             they agreed a day, and the day they asked for instead, in the
             shapes the function writes them. Without these the panel has
             never rendered the answer a customer can actually give. */
          day_agreed_at: null, customer_proposal: null, customer_proposed_at: null,
          estimate_kobo: null,          actual_kobo: null, parts: [], evidence: [],
          payout_settled: null,
          customer_confirmed_at: null, customer_note: null,
          disputed_at: null, dispute_reason: null,
          resolved_at: null, resolution: null, closed_by: null
        }, over);
      }
      var one = care_plans[0];    /* Halima — three call-outs left */
      var two = care_plans[1];    /* Ifeoma — one credit taken back by hand */
      var gone = care_plans[2];   /* Bashir — refunded, nothing left to spend */
      return [
        /* Filed, undecided. The case the decision form exists for — and,
           filed two days ago against a 24-hour clock, PAST its deadline:
           the fixture's one late claim that a single decision clears. */
        claim({ id: 'claim-0001', plan_id: one.id, reference: 'AZ-C-MOCK-1', created_at: daysAgo(2),
                updated_at: daysAgo(2),
                student_name: one.first_name, student_phone: one.phone, property: one.property,
                room: 'Room 4',
                issue: 'The kitchen tap has been running since yesterday and the floor is soaked.',
                photos: [IMG + '?w=900'], status: 'submitted' }),

        /* Covered, no worker named yet. The case the assign form exists
           for. Decided twenty hours ago, so it is the fixture's ONE claim
           still inside its deadline: the card has to be able to say
           "4h left" as well as "past the deadline". */
        claim({ id: 'claim-0002', plan_id: one.id, reference: 'AZ-C-MOCK-2', created_at: daysAgo(6),
                updated_at: iso(20),
                student_name: one.first_name, student_phone: one.phone, property: one.property,
                room: 'Room 1',
                issue: 'No water in the bathroom at all since Monday morning.',
                status: 'approved', eligibility: 'covered',
                eligibility_reason: 'A failed valve inside the flat is what the cover is for.',
                decided_by: 'owner', decided_at: iso(20),
                call_out_no: 1, reserved_at: iso(20), estimate_kobo: 450000 }),

        /* With a worker, work reported, waiting on the CUSTOMER — the
           state a worker's own word is not allowed to skip. */
        claim({ id: 'claim-0003', plan_id: two.id, reference: 'AZ-C-MOCK-3', created_at: daysAgo(11),
                updated_at: daysAgo(8),
                student_name: two.first_name, student_phone: two.phone, property: two.property,
                room: 'Room 2',
                issue: 'The socket by the bed sparks when the fan is plugged in.',
                status: 'awaiting_customer', eligibility: 'covered',
                eligibility_reason: 'An unsafe socket is a covered repair.',
                decided_by: 'owner', decided_at: daysAgo(10),
                call_out_no: 1, reserved_at: daysAgo(10), estimate_kobo: 350000,
                /* A worker with an address on file, so the email channel
                   of a notice has somewhere to go; the next claim's
                   worker has none, which the panel must also say out
                   loud rather than leave blank. */
                provider_name: 'Yinka, electrical', provider_phone: '+2348030000009',
                provider_email: 'yinka.electrical@example.com',
                assigned_at: daysAgo(9), assigned_by: 'support',
                actual_kobo: 320000, parts: [{ name: 'socket and back box', kobo: 180000 }],
                evidence: [IMG + '?w=900'],
                customer_note: 'Replaced the socket and tested the fan.' }),

        /* Disputed. The case the resolve form exists for. */
        claim({ id: 'claim-0004', plan_id: two.id, reference: 'AZ-C-MOCK-4', created_at: daysAgo(16),
                updated_at: daysAgo(12),
                student_name: two.first_name, student_phone: two.phone, property: two.property,
                room: 'Room 2',
                issue: 'The shower drain backs up whenever the tap runs.',
                status: 'disputed', eligibility: 'covered',
                eligibility_reason: 'A blocked drain serving the flat is covered.',
                decided_by: 'owner', decided_at: daysAgo(15),
                call_out_no: 2, reserved_at: daysAgo(15), estimate_kobo: 300000,
                provider_name: 'Sani, plumbing', provider_phone: '+2348030000010',
                assigned_at: daysAgo(14), assigned_by: 'support',
                actual_kobo: 420000, parts: [{ name: 'drain rods', kobo: 90000 }],
                disputed_at: daysAgo(12),
                dispute_reason: 'The drain still backs up after the visit and nobody tested it.' }),

        /* Decided covered, but the pass was refunded and has nothing left.
           Approving this one must be REFUSED and left under review: the
           queue may not show a success the function did not give. */
        claim({ id: 'claim-0005', plan_id: gone.id, reference: 'AZ-C-MOCK-5', created_at: daysAgo(21),
                updated_at: daysAgo(20),
                student_name: gone.first_name, student_phone: gone.phone,
                issue: 'The ceiling fan in the room stopped turning.',
                status: 'under_review', eligibility: 'covered',
                eligibility_reason: 'Covered — but this pass has no call-outs left to spend.',
                decided_by: 'owner', decided_at: daysAgo(20) }),

        /* A refusal, with the reason the customer reads. Nothing spent. */
        claim({ id: 'claim-0006', plan_id: one.id, reference: 'AZ-C-MOCK-6', created_at: daysAgo(26),
                updated_at: daysAgo(25),
                student_name: one.first_name, student_phone: one.phone, property: one.property,
                room: 'Room 4',
                issue: 'My laptop charger broke and I cannot afford a new one.',
                status: 'rejected', eligibility: 'not_covered',
                eligibility_reason: 'A personal item is not the flat, so it is outside the cover.',
                decided_by: 'owner', decided_at: daysAgo(25),
                resolved_at: daysAgo(25), resolution: 'refused: not the flat', closed_by: 'owner' }),

        /* A WORKER WHO SAID WHEN THEY CAN COME. This is the row the panel
           and the customer's pass link both have to be readable with: the
           worker has NOT answered "is it yours" — there is no answer here
           — but they have told us a day, and saying "has not answered
           yet" beside it is the panel lying about its own row.

           Inside its deadline on purpose: this fixture exists to render a
           KIND OF ANSWER, and a claim that is also late would put the
           queue's lateness counts on this row instead of on the rows the
           lateness fixtures already cover. The call-out is left unspent
           for the same reason — the Care ledger's balances are asserted
           against the plans these claims sit on. */
        claim({ id: 'claim-0009', plan_id: two.id, reference: 'AZ-C-MOCK-9', created_at: daysAgo(5),
                updated_at: iso(4),
                student_name: two.first_name, student_phone: two.phone, property: two.property,
                room: 'Room 3',
                issue: 'The wardrobe door has come off its runner and will not close.',
                status: 'assigned', eligibility: 'covered',
                eligibility_reason: 'Furniture the flat provides, broken through use.',
                decided_by: 'owner', decided_at: daysAgo(4),
                estimate_kobo: 250000,
                provider_name: 'Musa Ibrahim', provider_phone: '+2348030000011',
                assigned_at: iso(20), assigned_by: 'support',
                provider_proposal: 'I can do Saturday morning before 11',
                provider_proposed_at: iso(4) }),

        /* THE CUSTOMER SAID YES TO THE DAY THE WORKER OFFERED. The offer and
           the answer to it, on one row: the panel has to print which day was
           agreed to (the worker's words, not a date anybody computed), and
           the queue row has to be readable without opening the claim.

           No call-out and no estimate, for the same reason claim-0009 has
           none: this fixture exists to render a KIND OF ANSWER, and the Care
           ledger's balances are asserted against the plans these claims sit
           on. */
        claim({ id: 'claim-0011', plan_id: one.id, reference: 'AZ-C-MOCK-11', created_at: daysAgo(4),
                updated_at: iso(3),
                student_name: one.first_name, student_phone: one.phone, property: one.property,
                room: 'Room 4',
                issue: 'The front door lock turns but does not catch, so the room stays unlocked.',
                status: 'assigned', eligibility: 'covered',
                eligibility_reason: 'A fitting of the flat that has failed.',
                decided_by: 'owner', decided_at: daysAgo(3),
                provider_name: 'Musa Ibrahim', provider_phone: '+2348030000013',
                assigned_at: iso(30), assigned_by: 'support',
                provider_proposal: 'I can come Sunday afternoon', provider_proposed_at: iso(8),
                day_agreed_at: iso(3) }),

        /* AND THE OTHER ANSWER: THE DAY DOES NOT SUIT THEM. The customer's
           own sentence is on the row beside the day it is an answer to, and
           the panel must not turn it into a booking or a refusal. */
        claim({ id: 'claim-0012', plan_id: two.id, reference: 'AZ-C-MOCK-12', created_at: daysAgo(7),
                updated_at: iso(2),
                student_name: two.first_name, student_phone: two.phone, property: two.property,
                room: 'Room 3',
                issue: 'The generator changeover switch sparks when the light comes back.',
                status: 'assigned', eligibility: 'covered',
                eligibility_reason: 'An unsafe switch on the flat is covered.',
                decided_by: 'owner', decided_at: daysAgo(6),
                provider_name: 'Sani, plumbing', provider_phone: '+2348030000014',
                assigned_at: daysAgo(5), assigned_by: 'support',
                provider_proposal: 'Can I come Saturday morning?', provider_proposed_at: iso(9),
                customer_proposal: 'Not Saturday \u2014 Sunday afternoon after 2 would suit me',
                customer_proposed_at: iso(2) }),

        /* A JOB THE CLOCK TOOK BACK. Not the same fact as a refusal: this
           worker never said no — they never said anything — so the panel
           says so, and the row keeps the name and the number for whoever
           rings them next. */
        claim({ id: 'claim-0010', plan_id: one.id, reference: 'AZ-C-MOCK-10', created_at: daysAgo(9),
                updated_at: iso(1),
                student_name: one.first_name, student_phone: one.phone, property: one.property,
                room: 'Room 2',
                issue: 'The bathroom window will not latch and bangs in the wind.',
                status: 'approved', eligibility: 'covered',
                eligibility_reason: 'A fitting of the room that has failed.',
                decided_by: 'owner', decided_at: daysAgo(8),
                estimate_kobo: 180000,
                provider_name: 'Sani, carpentry', provider_phone: '+2348030000012',
                assigned_at: daysAgo(7), assigned_by: 'support',
                provider_answer: 'unanswered', provider_answered_at: iso(1),
                provider_answer_note: 'Nothing back from the worker, then or now.' })
      ];
    })();

    /* The reservations those claims hold. Appended to the Care events
       HERE so care_plans_live, computed below, already knows about them:
       claim-0002 took a call-out of Halima's pass; claim-0003 and
       claim-0004 took two of Ifeoma's. */
    (function holdCallOuts() {
      function reserve(plan, claim, when, no) {
        care_credit_events.push({
          id: care_credit_events.length + 1, created_at: when, plan_id: plan.id,
          student_name: plan.first_name, session: plan.session, event: 'reserved', delta: -1,
          reason: 'Call-out ' + no + ' committed to claim ' + claim.reference,
          worker: null, parts_ngn: null, note: null,
          actor_ref: 'u-admin', actor_name: 'owner', env: plan.env
        });
      }
      reserve(care_plans[0], repair_claims[1], iso(20), 1);
      reserve(care_plans[1], repair_claims[2], daysAgo(10), 1);
      reserve(care_plans[1], repair_claims[3], daysAgo(15), 2);

      care_credit_events.sort(function (x, y) { return String(y.created_at).localeCompare(String(x.created_at)); });
    })();

    /* THE TRAIL, and why it is written out by hand rather than derived
       from created_at.

       The aging clock reads the NEWEST row here to learn when a claim
       entered the status it is in now. A trail that dated every row from
       the filing date would tell the clock that a claim decided five days
       after it was filed entered 'approved' on the day it was filed —
       and the deadline on the card would be wrong by exactly that gap.
       So each claim's moves are listed with the dates the fixture's own
       story gives them, and updated_at is set to the last of them, the
       way the real function bumps it on every move.

       The guard at the end is the important line: a fixture claim with no
       history is a claim the clock would have to guess about by falling
       back to updated_at — which is the failure this fixture exists to
       not have. */
    var CLAIM_TRAIL = {
      'claim-0001': [['filed', 'submitted', daysAgo(2), 'student']],
      'claim-0002': [['filed', 'submitted', daysAgo(6), 'student'],
                     ['decision', 'approved', iso(20), 'owner']],
      'claim-0003': [['filed', 'submitted', daysAgo(11), 'student'],
                     ['decision', 'approved', daysAgo(10), 'owner'],
                     ['assigned', 'assigned', daysAgo(9), 'support'],
                     ['report_work', 'awaiting_customer', daysAgo(8), 'support']],
      'claim-0004': [['filed', 'submitted', daysAgo(16), 'student'],
                     ['decision', 'approved', daysAgo(15), 'owner'],
                     ['assigned', 'assigned', daysAgo(14), 'support'],
                     ['report_work', 'awaiting_customer', daysAgo(13), 'support'],
                     ['disputed', 'disputed', daysAgo(12), 'student']],
      'claim-0005': [['filed', 'submitted', daysAgo(21), 'student'],
                     ['decision', 'under_review', daysAgo(20), 'owner']],
      'claim-0006': [['filed', 'submitted', daysAgo(26), 'student'],
                     ['decision', 'rejected', daysAgo(25), 'owner'],
                     ['resolution', 'rejected', daysAgo(25), 'owner']],
      'claim-0009': [['filed', 'submitted', daysAgo(5), 'student'],
                     ['decision', 'approved', daysAgo(4), 'owner'],
                     ['assigned', 'assigned', iso(20), 'support'],
                     /* The day, on the trail as its own row: the panel reads
                        the row for when they said it, and the customer was
                        told in that same move. */
                     ['proposed', 'assigned', iso(4), 'worker']],
      'claim-0010': [['filed', 'submitted', daysAgo(9), 'student'],
                     ['decision', 'approved', daysAgo(8), 'owner'],
                     ['assigned', 'assigned', daysAgo(7), 'support'],
                     ['chased', 'assigned', daysAgo(2), 'system'],
                     ['unanswered', 'approved', iso(1), 'system']],
      /* The two answers a CUSTOMER gives, as the trail really records them:
         both by the student, both against 'assigned', because neither moves
         the claim. The clock reads the newest row here, so an agreement and
         a counter-offer reset nothing — the claim is still on the same 48
         hours it was, which is the fact the queue has to keep saying. */
      'claim-0011': [['filed', 'submitted', daysAgo(4), 'student'],
                     ['decision', 'approved', daysAgo(3), 'owner'],
                     ['assigned', 'assigned', iso(30), 'support'],
                     ['proposed', 'assigned', iso(8), 'worker'],
                     ['day_agreed', 'assigned', iso(3), 'student']],
      'claim-0012': [['filed', 'submitted', daysAgo(7), 'student'],
                     ['decision', 'approved', daysAgo(6), 'owner'],
                     ['assigned', 'assigned', daysAgo(5), 'support'],
                     ['proposed', 'assigned', iso(9), 'worker'],
                     ['day_proposed', 'assigned', iso(2), 'student']]
    };

    var claim_events = [];
    (function buildTrail() {
      repair_claims.forEach(function (c) {
        var moves = CLAIM_TRAIL[c.id];
        if (!moves) throw new Error('the fixture claim ' + c.reference + ' has no history: the clock cannot read it');
        var from = null;
        moves.forEach(function (m) {
          claim_events.push({
            id: claim_events.length + 1, created_at: m[2], claim_id: c.id, reference: c.reference,
            from_status: from, to_status: m[1], event: m[0], reason: null, data: null,
            actor_ref: m[3] === 'student' ? null : 'u-' + m[3],
            actor_name: m[3] === 'student' ? c.student_name : m[3],
            actor_role: m[3], env: c.env
          });
          from = m[1];
        });
        /* The last move is where the claim stands, so that is when it was
           last touched. The claim row and its trail cannot disagree. */
        c.updated_at = moves[moves.length - 1][2];
      });
    })();

    /* care_plans_live, computed the way the view computes it: the balance is
       the SUM of the ledger, never a column. */
    var care_plans_live = care_plans.map(function (p) {
      var rows = care_credit_events.filter(function (e) { return e.plan_id === p.id; });
      var balance = rows.reduce(function (n, e) { return n + e.delta; }, 0);
      var granted = rows.filter(function (e) { return e.event === 'granted'; })
        .reduce(function (n, e) { return n + e.delta; }, 0);
      return Object.assign({}, p, {
        balance: balance,
        granted: granted,
        call_outs: rows.filter(function (e) { return e.event === 'spent'; }).length,
        has_credits: balance > 0,
        last_event_at: rows.length ? rows[0].created_at : null
      });
    }).sort(function (x, y) { return String(y.created_at).localeCompare(String(x.created_at)); });

    return {
      care_plans: care_plans,
      care_credit_events: care_credit_events,
      care_plans_live: care_plans_live,
      repair_claims: repair_claims,
      claim_events: claim_events,
      demand_records: demand_records,
      listings: listings,
      scout_submissions: scout_submissions,
      booking_requests: booking_requests,
      support_tickets: support_tickets,
      amenities: amenities,
      minors_needing_guardian: minors_needing_guardian,
      roommate_match_summary: roommate_match_summary,
      roommate_profiles: roommate_profiles,
      roommate_interests: roommate_interests,
      roommate_events: roommate_events,
      roommate_engine_summary: roommate_engine_summary,
      roommate_mutual_pairs: roommate_mutual_pairs,
      created_at: now
    };
  }

  /* ============================================================
     WORST CASE — the break-ui fixture, GENERATED (DEV ONLY)

     Round 4 walked a hand-written version of this fixture and found
     four table breaks and two silent board failures. Hand-picked rows
     are the wrong shape for a regression: the board's verdict is three
     ANDed conditions (status active, tier >= 1, env production), so a
     row can only ever render ONE of the reason branches, and the hand
     list had no tier-0 row at all — the branch the bug report was
     about. So the fixture is emitted from the cross product instead:

       1. every status × tier × env combination the dashboard can hold
          (5 × 3 × 3 = 45 rows), with the dashboard's own enumerations
          as inputs, so every way the browse board can hide a listing
          is on screen;
       2. the payload extremes (70-character emoji name, an area with
          no space in it, a payload with no name at all, zero units, a
          ₦0 rent, sixty media items, RTL text) — each of which is
          also a board case.

     Every row records the case it is there to exercise:

         row.case = { label: 'active · tier 0 · production',
                      status: 'active', tier: 0, env: 'production',
                      exercise: 'hidden:tier',   // the board branch
                      stress: null }             // or the payload stress

     and `worstPlan()` publishes the same records (the enumerations,
     the matrix, the branch vocabulary, the stress list) so the
     regression test can check, from the page itself, that the product
     is complete and that no record lies about its own row.

     `exercise` is the FIRST failing condition, in boardState()'s
     order: live · hidden:status · hidden:tier · hidden:env ·
     hidden:env-empty.

     Only `listings` is replaced; every other relation keeps its demo
     rows so the rest of the dashboard still renders.
     ============================================================ */

  /* The dashboard's own enumerations, not an invented list: the five
     statuses its Status filter offers (statusOptionsHtml() in admin.js
     carries the same five), the three tiers its Tier select offers,
     and the envs public_listings distinguishes — 'production', 'test',
     and NULL (empty is not production). */
  var W_STATUSES = ['draft', 'pending', 'active', 'rejected', 'inactive'];
  var W_TIERS = [0, 1, 2];
  var W_ENVS = ['production', 'test', null];
  var W_BRANCHES = ['live', 'hidden:status', 'hidden:tier', 'hidden:env', 'hidden:env-empty'];

  function wKey(v) {
    return v == null || v === '' ? 'NULL' : String(v).toLowerCase();
  }

  /* Which branch a combination exercises — recomputed from the data
     here, NOT imported from admin.js, so a fixture that disagrees with
     the board fails the test instead of sharing the mistake. */
  function worstExercise(status, tier, env) {
    if (String(status).toLowerCase() !== 'active') return 'hidden:status';
    if (!(Number(tier) >= 1)) return 'hidden:tier';
    if (wKey(env) !== 'production') return wKey(env) === 'NULL' ? 'hidden:env-empty' : 'hidden:env';
    return 'live';
  }

  function worstCell(status, tier, env) {
    return {
      label: status + ' · tier ' + tier + ' · ' + (env == null ? 'env NULL' : env),
      status: status,
      tier: tier,
      env: env,
      exercise: worstExercise(status, tier, env)
    };
  }

  function worstMatrix() {
    var cells = [];
    W_STATUSES.forEach(function (status) {
      W_TIERS.forEach(function (tier) {
        W_ENVS.forEach(function (env) { cells.push(worstCell(status, tier, env)); });
      });
    });
    return cells;
  }

  /* The payload extremes. Each is still a board case: its record's
     `stress` names what makes it nasty, and `exercise` is recomputed
     from its own status / tier / env like every other row. */
  var W_STRESS = [
    { name: 'max-ceilings', status: 'active', tier: 2, env: 'production',
      why: '70-char emoji name · 80-char unbreakable area · 8-digit rent · 999 units · 30 amenities · 2,000-char desc' },
    { name: 'empty-payload', status: 'pending', tier: 0, env: 'production',
      why: 'payload: {} — the public form posts whatever it is given' },
    { name: 'zero-units', status: 'active', tier: 1, env: 'production',
      why: '0 vacant units · ₦0 rent · Yoruba diacritics in two fields' },
    { name: 'rtl-and-60-media', status: 'active', tier: 2, env: 'production',
      why: 'RTL name and area · 60 media items · a 300-character URL' }
  ];

  function worstListings() {
    var U = 'https://res.cloudinary.com/demo/image/upload/w_400/sample.jpg';
    function media(n) {
      var out = [], i;
      for (i = 0; i < n; i++) {
        out.push({ type: i % 10 === 9 ? 'video' : 'image', url: U, label: 'Photo ' + (i + 1),
                   credit: { holder: 'Arzuz', year: 2026, note: 'Verified apartment media' } });
      }
      return out;
    }
    var UNSET = [];              /* 30 amenities: the cell has to cope */
    for (var a = 0; a < 30; a++) UNSET.push('Amenity ' + (a + 1) + (a % 7 === 0 ? ' (emoji 🏠 ₦)' : ''));
    var TYPES = ['Self-contain', 'Single Room', 'Two Bedroom', 'Hostel', 'Face-me-I-face-you'];
    var AREAS = ['Tanke Road', 'Sango Road', 'Behind KWASU Gate, Malete', 'Oke-Odo', 'Oluwo Street'];
    var PEOPLE = ['Alh. Kareem', 'Mrs. Adeyemi', 'Chief Ola', 'Mallam Sani', 'Baba Oluwo'];
    var WHO = ['I do, myself', 'A caretaker', 'An agent'];

    function pad(n, w) {
      var s = String(n);
      while (s.length < w) s = '0' + s;
      return s;
    }

    /* One complete, plausible row. `k` drives every value, so the same
       cell always builds the same row and a fixture diff is a real
       change rather than a reshuffle. */
    function baseRow(cell, k) {
      var rent = 70000 + (k % 12) * 15000;
      var occupied = k % 5 === 0;
      var apt = 'APT-W' + pad(k, 2);
      var hasPhoto = k % 4 !== 0;
      var row = {
        id: 'w0000000-' + pad(k, 4) + '-4000-8000-' + pad(k, 12),
        created_at: iso(k),
        session: '2026/2027',
        env: cell.env,
        source: cell.status === 'draft' ? 'admin_dashboard_draft' : 'admin_dashboard',
        status: cell.status,
        tier: cell.tier,
        opening_ask_ngn: k % 3 === 0 ? null : rent + 20000,
        listed_price_ngn: rent,
        latitude: null,
        longitude: null,
        photo_url: hasPhoto ? IMG.blessing : '',
        notes: 'fixture · ' + cell.label + ' · exercises ' + cell.exercise,
        payload: {
          apt_id: apt, custom_id: apt,
          prop_name: 'Generated Lodge ' + pad(k, 2),
          ty: TYPES[k % TYPES.length],
          ar: AREAS[k % AREAS.length],
          rent: String(rent),
          rm: occupied ? 'Fully occupied' : (1 + (k % 4)) + ' rooms available',
          avail: occupied ? 'occupied' : 'vacant',
          units: occupied ? 0 : 1 + (k % 4),
          nm: PEOPLE[k % PEOPLE.length],
          last: '',
          ph: '0803' + pad(k % 10000, 4),
          who: WHO[k % WHO.length],
          desc: 'Generated fixture row ' + pad(k, 2) + ' — ' + cell.exercise + '.',
          photo: hasPhoto ? IMG.blessing : '',
          video: '', video_url: '',
          media: hasPhoto ? [{ type: 'image', url: IMG.blessing, label: 'Fixture photo',
            credit: { holder: 'Arzuz', year: 2026, note: 'Verified apartment media' } }] : [],
          split_ok: k % 2 === 0,
          ut: ['Borehole water', 'NEPA connection'],
          utilities: ['Borehole water', 'NEPA connection']
        }
      };
      if (cell.status === 'draft') {
        /* the four invite states draftBadgeHtml() can show, rotated so
           every draft row is not the same draft: revoked · expired ·
           completed · a live link */
        var v = k % 4;
        row.draft_token = v === 0 ? null : 'f0000000-0000-4000-8000-' + pad(k, 12);
        row.draft_permission = v === 3 ? 'edit' : 'view';
        row.draft_expires_at = v === 1
          ? new Date(Date.now() - 2 * 864e5).toISOString()
          : new Date(Date.now() + 3 * 864e5).toISOString();
        row.draft_completed_at = v === 2 ? iso(k) : null;
      }
      return row;
    }

    var rows = [];
    var k = 0;

    function emit(cell, over) {
      k += 1;
      var row = baseRow(cell, k);
      if (over) over(row, k);
      row.case = cell;
      rows.push(row);
      return row;
    }

    /* 1. the matrix — every status × tier × env combination */
    worstMatrix().forEach(function (cell) { emit(cell); });

    /* 2. the payload extremes, each still carrying its board case */
    W_STRESS.forEach(function (s) {
      var cell = worstCell(s.status, s.tier, s.env);
      cell.label = 'stress ' + s.name + ' · ' + cell.label;
      cell.stress = s.name;
      cell.why = s.why;
      emit(cell, function (row) {
        var p = row.payload;
        if (s.name === 'max-ceilings') {
          /* `padEnd` to the form's own `maxlength` (name 70, area 80) before
             the slice: the pads above are shorter than the ceiling, so a
             bare slice left this row at 58/58 and the row described as "a
             70-character name, an 80-character area" was neither */
          p.prop_name = ('Alhaja Blessing International Students Lodge 🏠 ' + 'WWWWWWWWWW').padEnd(70, 'W').slice(0, 70);
          p.ar = ('BehindKWASUGateMaleteNoSpacesAtAllInThisAreaName' + 'AAAAAAAAAA').padEnd(80, 'A').slice(0, 80);
          p.rent = '99999999';
          row.opening_ask_ngn = 99999999;
          row.listed_price_ngn = 99999999;
          p.rm = '999 units available'; p.avail = 'vacant'; p.units = 999;
          p.nm = 'Alhaja ♥ Mrs. Blessing'; p.ph = '+234 (0) 803 111 2233';
          p.desc = ('Running water, prepaid meter. ').repeat(70).slice(0, 2000);
          p.ut = UNSET; p.utilities = UNSET;
          p.vf = 'Yes, come and check it';
          row.latitude = 9.1922; row.longitude = 4.6661;
        }
        if (s.name === 'empty-payload') {
          row.payload = {};
          row.listed_price_ngn = 0;
          row.opening_ask_ngn = null;
        }
        if (s.name === 'zero-units') {
          p.prop_name = 'Ọ̀pẹ́ Lodge'; p.nm = 'Chief Ọlá'; p.ar = 'Opposite the blue mosque';
          p.rent = '0'; p.units = null; p.avail = 'occupied'; p.rm = 'Fully occupied';
          row.listed_price_ngn = 0; row.opening_ask_ngn = 0;
        }
        if (s.name === 'rtl-and-60-media') {
          p.prop_name = 'شقة الأمل للطلاب'; p.ar = 'الطريق الرئيسي، ماليتي'; p.nm = 'عبد الله';
          p.desc = '😀 🏠 ₦ ⚡ — emoji, currency and dashes.';
          p.ut = ['سخان', 'borehole']; p.utilities = p.ut;
          p.media = media(60);
          row.photo_url = U + '?v=' + 'x'.repeat(200);
          p.photo = row.photo_url; p.video_url = row.photo_url;
          row.latitude = 9.19; row.longitude = 4.66;
        }
      });
    });

    return rows;
  }

  /* The record the regression test reads back from the page: the
     enumerations the fixture emits over, the matrix it claims to
     cover, the branch vocabulary, and the stress list. */
  function worstPlan() {
    return {
      statuses: W_STATUSES.slice(),
      tiers: W_TIERS.slice(),
      envs: W_ENVS.slice(),
      branches: W_BRANCHES.slice(),
      cells: worstMatrix(),
      stress: W_STRESS.map(function (s) {
        return { name: s.name, why: s.why, status: s.status, tier: s.tier, env: s.env,
                 exercise: worstExercise(s.status, s.tier, s.env) };
      })
    };
  }

  /* The whole seed with only `listings` swapped for the worst case. */
  function worst() {
    var base = seed();
    base.listings = worstListings();
    return base;
  }

  window.ArzuzMockData = { seed: seed, worst: worst, images: IMG, worstPlan: worstPlan };
})();
