/* ============================================================
   Arzuz Admin — mock data (DEV ONLY)
   Loaded by admin.html?mock=1 on localhost, right before
   admin-mock.js. Never loaded in production.

   Shapes mirror the real Supabase tables/views so the whole
   dashboard renders exactly as it does against live data:
     demand_records, listings, scout_submissions,
     booking_requests, support_tickets, amenities,
     minors_needing_guardian (view),
     roommate_match_summary  (view)
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

    return {
      demand_records: demand_records,
      listings: listings,
      scout_submissions: scout_submissions,
      booking_requests: booking_requests,
      support_tickets: support_tickets,
      amenities: amenities,
      minors_needing_guardian: minors_needing_guardian,
      roommate_match_summary: roommate_match_summary,
      created_at: now
    };
  }

  window.ArzuzMockData = { seed: seed, images: IMG };
})();
