/* ============================================================
   Arzuz — shared application logic
   Page chrome, formatting helpers, and the multi-step form engine.
   Includes:
   - Interactive Leaflet + OpenStreetMap GPS Pin Capture
     (delegates to ArzuzMap in arzuz-map.js — live GPS watch,
      accuracy ring, best-fix memory, passage capture)
   - Compulsory vs. Optional Guidance Badges
   - Live Nigerian Phone & Name Validation
   ============================================================ */

var Arzuz = (function(){

  /* ---------- formatting helpers ---------- */
  function ng(n){ return "\u20A6" + Number(n).toLocaleString(); }

  function pad(n){ return String(n).padStart(2,'0'); }
  var D = new Date();
  var STAMP_DATE = pad(D.getDate())+'\u00B7'+pad(D.getMonth()+1)+'\u00B7'+String(D.getFullYear()).slice(2);

  function isReal(){
    return typeof DEMAND_IS_REAL !== 'undefined' && DEMAND_IS_REAL;
  }

  /* how many registered students can afford a given price */
  function reach(price){
    if (typeof CEILINGS === 'undefined') return 0;
    return CEILINGS.filter(function(c){ return c >= price; }).length;
  }

  /* The budget band with the most students in it — used instead of
     quoting a price range that no record supports. */
  function deepestBand(){
    if (typeof BANDS === 'undefined' || !BANDS.length) return null;
    return BANDS.reduce(function(a, b){ return b[2] > a[2] ? b : a; });
  }

  /* Nigerian Phone Number Validation (e.g. 08012345678, +2348012345678) */
  function isValidNigerianPhone(raw){
    if (!raw) return false;
    var digits = String(raw).replace(/[\s\-\+\(\)]/g, '');
    if (digits.charAt(0) === '0') digits = '234' + digits.slice(1);
    return /^234\d{10}$/.test(digits);
  }

  function isValidName(raw){
    return !!(raw && raw.trim().length >= 2);
  }

  /* ---------- page chrome ---------- */
  /* (map + passage capture live in assets/arzuz-map.js — ArzuzMap) */
  function chrome(role){
    if (document.querySelector('header')) return;
    var tag = role === 'owner' ? 'Landlord Portal' : (role === 'student' ? 'Student Portal' : 'Know before you pay.');
    document.body.insertAdjacentHTML('afterbegin',
      '<header><div class="hrow"><a href="/" aria-label="Arzuz Home">'+
      '<span class="m"><span>az</span></span>'+
      '<span class="hw">ar<i>z</i>u<i>z</i></span></a>'+
      '<span class="htag">' + tag + '</span></div></header>');
  }

  /* The footer is the site's internal-link hub: the only navigation every
     page shares, and the way a crawler gets from any page to the pages that
     need to be found. Two things about it are deliberate.

     The links are the canonical, extension-less URLs. They used to be
     `safety.html` and friends — a different address from the one in the
     page's own canonical tag and in sitemap.xml, so every page was
     reachable three ways (with .html, without, and via /list and /scout)
     and each copy competed with the others.

     And it links the money pages, not just the legal ones. A crawler
     discovers a page by following a link to it, which is why browse, the
     two forms and the building page each get a link from every page on the
     site. That is what internal linking means in practice: not a sitemap
     file, but a path from every page to every other page.

     The `if (document.querySelector('.sitefoot')) return;` above is what
     keeps a page that ships this markup statically from drawing it twice. */
  function footer(){
    if (document.querySelector('.sitefoot')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="wrap"><div class="sitefoot">'+
      '<div class="flinks"><b class="flbl">Find a room</b>'+
      '<a href="/browse">Browse verified rooms</a>'+
      '<a href="/register">Find a room</a></div>'+
      '<div class="flinks"><b class="flbl">List a property</b>'+
      '<a href="/list">List your property</a>'+
      '<a href="/my-building">Register your building</a></div>'+
      '<div class="flinks"><b class="flbl">Student guides</b>'+
      '<a href="/rent-in-malete">What rent costs</a>'+
      '<a href="/hostels-near-kwasu">Choosing a hostel</a></div>'+
      '<div class="flinks"><b class="flbl">Arzuz</b>'+
      '<a href="/safety">Your safety</a>'+
      '<a href="/care">Arzuz Care</a>'+
      '<a href="/privacy">Privacy</a>'+
      '<a href="/roommates">Roommate matching</a>'+
      '<a href="/terms">Terms</a>'+
      '<a href="mailto:support@arzuz.com">support@arzuz.com</a>'+
      '<a href="https://wa.me/2349024814771" target="_blank" rel="noopener noreferrer">WhatsApp: 09024814771</a></div>'+
      'Arzuz does not collect rent, hold deposits, or charge you to rent, view or contact a '+
      'landlord. The only thing Arzuz sells is an optional Care Pass for repairs. '+
      'Your phone number is used to verify your account and send you matches. '+
      'It is never shown publicly.<br><br>'+
      'Arzuz. Open to students everywhere, starting in Malete, Kwara State. Pronounced AR-zuz.'+
      '</div></div>');
  }

  /* ---------- multi-step form engine ---------- */
  var F = {steps:[], step:0, answers:{}, done:'', backHref:'', backLabel:'', table:null};

  /* THE FIVE TABLES THE PUBLIC DOOR SERVES (netlify/functions/waitlist.js).
     Consent is required for all of them, and is enforced on the server;
     this list exists so the CONSENT STEP is only added to a real public
     submission and never to an internal screen. */
  var CONSENT_TABLES = ['demand_records','listings','scout_submissions','booking_requests','support_tickets',
                        /* The roommate questionnaire is on this list for the
                           same reason as the other five and not because it
                           writes to demand_records: it collects a phone
                           number and it is a submission the server requires
                           consent for. It is also the one form whose name
                           differs from its table — netlify/functions/waitlist.js
                           maps form 'roommate_profiles' onto demand_records,
                           which is why the door's allowlist has to know this
                           name at all. */
                        'roommate_profiles'];

  /* THE EXACT SENTENCE THE SERVER RECORDS IN consent_text. It is the
     same string in netlify/functions/waitlist.js on purpose, and
     scripts/test-waitlist.mjs fails the build if the two ever say
     different things — a page that shows one version of what someone
     agreed to while the database stores another is worse than no
     consent record at all. CHANGE BOTH, OR NEITHER. */
  var CONSENT_SENTENCE = 'By submitting this form I agree that Arzuz may contact me on the phone number or email I have given, about my housing request and about rooms Arzuz matches to it. I can ask Arzuz to stop contacting me at any time.';
  var activePinCapture = null;
  var activePassageEditor = null;

  function form(opts){
    F.steps = opts.steps; F.step = 0; F.answers = {};
    F.done = opts.done; F.backHref = opts.backHref || 'index.html';
    F.backLabel = opts.backLabel || '\u2190 Back';
    F.table = opts.table || null;

    /* THE CONSENT STEP, ADDED BY THE ENGINE RATHER THAN IN EIGHT PAGES.
       Every public form now ends with one box and one sentence, because
       the server requires consent from all of them and records the
       sentence agreed to. Putting it here means the pages that call
       Arzuz.form() cannot drift apart from each other or from the
       server, and a page added next month gets it without knowing it
       exists. */
    if (CONSENT_TABLES.indexOf(F.table) !== -1
        && !F.steps.some(function(st){ return st.agree; })) {
      F.steps = F.steps.concat([{
        k: 'consent',
        h: 'Before we take your details',
        agree: CONSENT_SENTENCE
      }]);
    }
    draw();
  }

  function shown(i){
    var st = F.steps[i];
    return !st || !st.onlyIf || st.onlyIf(F.answers);
  }

  function isLast(){
    for(var i = F.step + 1; i < F.steps.length; i++) if(shown(i)) return false;
    return true;
  }

  /* Determine if a field or step is compulsory */
  function isFieldRequired(field, step){
    if (step.opt) return false;
    var name = field[0];
    if (['first', 'last', 'nm', 'g_name', 'phone', 'ph', 'g_phone', 'area', 'ar', 'rent', 'amt', 'type', 'ty'].indexOf(name) !== -1) {
      return true;
    }
    return !field[3] || !field[3].opt;
  }

  function draw(){
    var el = document.getElementById('form');
    if (!el) return;
    var s = F.steps[F.step];
    if (!s) return;

    var progressPct = Math.round(((F.step + 1) / F.steps.length) * 100);
    var isStepCompulsory = !s.opt;

    var h = '<div class="step-anim">';
    h += '<a class="back" href="'+F.backHref+'">'+F.backLabel+'</a>';
    h += '<div class="prog"><i style="width:'+progressPct+'%"></i></div>';

    // Step guidance badge banner
    h += '<div class="step-guide-bar '+(isStepCompulsory ? 'req' : 'opt')+'">'+
         (isStepCompulsory ? '⚡ Step '+(F.step+1)+' of '+F.steps.length+' · Compulsory' : 'Step '+(F.step+1)+' of '+F.steps.length+' · Optional (You can skip)')+
         '</div>';

    h += '<h2 class="qh">'+s.h+'</h2>';
    if(s.hint) h += '<div class="qhint">'+s.hint+'</div>';

    var band = deepestBand();
    if(s.ctx) h += '<div class="ctxbox">'+ (isReal() && band && typeof DEMAND_TOTAL !== 'undefined'
      ? '<b>'+DEMAND_TOTAL+' students</b> are registered on Arzuz this session. '+
        'Most can pay between '+ng(band[0])+' and '+ng(band[1])+'.'
      : 'We will show you exactly how many students are looking in your area, and what '+
        'they can pay, as soon as your listing is in.') +'</div>';

    // Multiple choice options
    /* THE HONEYPOT. A field no person can see and no person fills in,
       named the way a form-filler expects a form field to be named. It
       is here on every step, and it travels in the payload so that the
       DATABASE can refuse a filled one as well as this page's server
       (see the anon insert policies in supabase-team-roles.sql). A bot
       that talks to the API directly and sends an `hp` with anything in
       it meets that check whether or not it ever loaded this page. */
    h += '<div style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden" aria-hidden="true">'+
         '<label for="f_hp">Website</label>'+
         '<input type="text" id="f_hp" name="website" tabindex="-1" autocomplete="off" value="">'+
         '</div>';

    /* The consent box, on the one step that asks for it. */
    if (s.agree) {
      h += '<label for="f_consent" style="display:flex;gap:10px;align-items:flex-start;margin:16px 0;cursor:pointer">'+
           '<input type="checkbox" id="f_consent" style="margin-top:3px;width:18px;height:18px;flex:none"'+
           (F.answers.consent === 'yes' ? ' checked' : '')+'>'+
           '<span style="font-size:13.5px;color:var(--mid);line-height:1.5">'+ s.agree +'</span>'+
           '</label>';
    }

    if(s.o) h += '<div class="opts">'+ s.o.map(function(o){
      var isSel = F.answers[s.k] === o;
      return '<button type="button" class="opt'+(isSel?' sel':'')+'" data-v="'+o+'">'+o+'</button>';
    }).join('') +'</div>';

    // Checkboxes
    if(s.c) {
      var currentChecks = F.answers[s.k] || [];
      h += '<div class="checks">'+ s.c.map(function(o){
        var isChecked = Array.isArray(currentChecks) && currentChecks.indexOf(o) !== -1;
        return '<span class="chk'+(isChecked?' sel':'')+'" data-v="'+o+'">'+o+'</span>';
      }).join('') +'</div>';
    }

    // Input fields
    if(s.f) h += s.f.map(function(f){
      var req = isFieldRequired(f, s);
      var val = F.answers[f[0]] || '';
      var x = '<div class="fld">';

      // Header with required / optional indicator badge
      if (f[2] !== 'pin') {
        x += '<div class="fld-header">' +
             '<label for="'+f[0]+'">'+f[1]+'</label>' +
             '<span class="'+(req ? 'fld-badge-req' : 'fld-badge-opt')+'">' +
             (req ? '* Required' : 'Optional') + '</span>' +
             '</div>';
      }

      if(f[2]==='sel'){
        x += '<select id="'+f[0]+'"><option value="">Choose one</option>'+
             f[3].map(function(o){
               return '<option'+(val===o?' selected':'')+'>'+o+'</option>';
             }).join('')+'</select>';
      } else if(f[2]==='pin'){
        x += '<div class="fld-header">' +
             '<label>Location Pin</label>' +
             '<span class="fld-badge-req">📡 Live GPS + Satellite</span>' +
             '</div>' +
             '<div class="map-tip-banner" id="mapTipBanner">' +
             '<span class="map-tip-icon">🛰️</span>' +
             '<span><b>Live GPS is on.</b> The map follows you as you walk — stand at the gate and tap the pin onto it, or drag the marker onto your building on the satellite view.</span>' +
             '</div>' +
             '<div class="map-wrap">' +
             '<div id="leaflet-map"></div>' +
             '<div class="map-layer-switcher" id="mapLayerSwitcher">' +
             '<button type="button" class="map-layer-btn active" id="btnLayerSat" data-layer="sat">🛰 Satellite</button>' +
             '<button type="button" class="map-layer-btn" id="btnLayerStreet" data-layer="street">🗺 Street</button>' +
             '</div>' +
             '</div>' +
             '<div class="map-controls-bar">' +
             '<span class="map-coords-badge" id="mapCoordsText">📍 Tap map or drag marker to your gate</span>' +
             '<span class="map-gps-btns">' +
             '<button type="button" class="btn-locate map-follow-btn" id="btnFollowMe">🚶 Follow me</button>' +
             '<button type="button" class="btn-locate" id="btnLocateMe">🎯 Use My GPS</button>' +
             '</span>' +
             '</div>' +
             '<div class="map-status-box" id="mapLiveStatus">' +
             'Live GPS is starting — accuracy shows above. You can also switch to <b>Satellite</b> and tap your roof directly.' +
             '</div>';
      } else if(f[2]==='passage'){
        x += '<div class="passage-mount" id="passageMount"></div>';
      } else if(f[2]==='rent-live'){
        x += '<input type="number" id="'+f[0]+'" placeholder="e.g. 180000" value="'+val+'">'+
             '<div class="live" id="rentOut">Type a price and we will show how many students can reach you.</div>';
      } else if(f[2]==='tel'){
        x += '<input type="tel" id="'+f[0]+'" value="'+val+'" placeholder="e.g. 08012345678" inputmode="tel">';
      } else if(f[2]==='photo'){
        var hasPhoto = !!val;
        x += '<div class="photo-upload-wrap" id="photoWrap_'+f[0]+'">' +
             '<label class="photo-drop-zone" id="photoZone_'+f[0]+'" for="photoInput_'+f[0]+'">' +
             (hasPhoto
               ? '<img src="'+val+'" class="photo-preview" id="photoPreview_'+f[0]+'" alt="Building photo">'
               : '<div class="photo-drop-inner"><span class="photo-icon">📷</span><span class="photo-label">Tap to add a photo<br><small>JPG, PNG, WebP · max 10 MB</small></span></div>') +
             '</label>' +
             '<input type="file" id="photoInput_'+f[0]+'" accept="image/*" style="display:none" data-field="'+f[0]+'">' +
             '<div class="photo-progress" id="photoProgress_'+f[0]+'"></div>' +
             (hasPhoto ? '<button type="button" class="photo-remove" data-field="'+f[0]+'">✕ Remove photo</button>' : '') +
             '</div>';
      } else {
        x += '<input type="'+f[2]+'" id="'+f[0]+'" value="'+val+'" placeholder="'+f[1]+'">';
      }

      // Inline validation error container
      x += '<div class="fld-error" id="err_'+f[0]+'"></div>';
      return x + '</div>';
    }).join('');

    // Textarea
    if(s.ta) {
      var taReq = !s.opt;
      h += '<div class="fld-header" style="margin-top:14px;"><label for="'+s.k+'">Your Notes</label>'+
           '<span class="'+(taReq ? 'fld-badge-req' : 'fld-badge-opt')+'">'+(taReq ? '* Required' : 'Optional · Can skip')+'</span></div>'+
           '<textarea id="'+s.k+'" placeholder="'+s.ta+'">'+(F.answers[s.k]||'')+'</textarea>'+
           '<div class="fld-error" id="err_'+s.k+'"></div>';
    }

    // Navigation buttons
    h += '<div class="nav">';
    if(F.step > 0) h += '<button type="button" class="bk" id="fBack">Back</button>';
    if(s.opt) {
      h += '<button type="button" class="btn-skip" id="fSkip">Skip this step \u2192</button>';
    }
    h += '<button type="button" class="next" id="fNext">'+
         (isLast() ? 'Finish \u2192' : 'Continue \u2192')+'</button></div>';
    h += '</div>';

    el.innerHTML = h;
    /* Instant reset, not a smooth scroll: the old step just played its
       exit and the new step is about to play its entrance. A smooth
       scroll here chased the animation down the page and read as a
       refresh — the top is simply where every step starts. */
    window.scrollTo(0, 0);

    // Handle interactive Leaflet map if current step has a pin field
    var hasPinField = s.f && s.f.some(function(f){ return f[2] === 'pin'; });
    if (hasPinField) {
      setupLeafletMap();
    }

    // Handle passage editors ("how do you get in?" step)
    var passageField = s.f && s.f.find(function(f){ return f[2] === 'passage'; });
    if (passageField && typeof ArzuzMap !== 'undefined') {
      if (activePassageEditor) { try { activePassageEditor.destroy(); } catch(e){} activePassageEditor = null; }
      activePassageEditor = ArzuzMap.passageEditor({
        mountId: 'passageMount',
        answers: F.answers,
        miniMap: true,
        pin: (F.answers.lat && F.answers.lng) ? { lat: F.answers.lat, lng: F.answers.lng } : null
      });
    }

    // Wire up photo upload fields
    var photoFields = s.f ? s.f.filter(function(f){ return f[2] === 'photo'; }) : [];
    photoFields.forEach(function(f){
      var input = document.getElementById('photoInput_'+f[0]);
      if (!input) return;
      input.addEventListener('change', function(){
        var file = input.files && input.files[0];
        if (!file) return;
        handlePhotoUpload(f[0], file);
      });
      var removeBtn = el.querySelector('.photo-remove[data-field="'+f[0]+'"]');
      if (removeBtn) {
        removeBtn.addEventListener('click', function(){
          F.answers[f[0]] = '';
          draw();
        });
      }
    });

    /* SMOOTH STEP CHANGES. Tapping an option used to swap the whole step
       the instant the finger landed — a full innerHTML replace plus a
       smooth scroll to top — which read as the page refreshing. Now the
       tap marks the answer, the old step plays a short exit
       (.step-leaving in arzuz.css), and the next step is drawn as the
       exit finishes. The lock ignores extra taps mid-transition: slow
       phones fire twice, and two advances used to skip a step. */
    var advancing = false;
    function advance(fn){
      if (advancing) return;
      advancing = true;
      var card = el.querySelector('.step-anim');
      if (card) card.classList.add('step-leaving');
      setTimeout(function(){
        try { fn(); } finally { advancing = false; }
      }, 170);
    }

    // Option buttons event listener
    /* SCOPED TO THE REAL OPTIONS, and that is the whole point of the
       `.opts` prefix. This used to be a bare `.opt`, which also matched
       this step's OWN guidance badge — `step-guide-bar '+(compulsory ?
       'req' : 'opt')` above — so on an OPTIONAL step the decorative badge
       was a live control: tapping the thing that says "Optional (You can
       skip)" ran this handler, wrote `F.answers[s.k] = undefined` (a badge
       has no data-v) and advanced the step. A person could skip a whole
       optional step's fields without knowing, and every answer on it
       arrived empty. The badge is a label; only buttons drawn inside
       `.opts` are answers. */
    el.querySelectorAll('.opts .opt').forEach(function(b){
      b.addEventListener('click', function(){
        F.answers[s.k] = b.dataset.v;
        el.querySelectorAll('.opts .opt').forEach(function(o){o.classList.remove('sel')});
        b.classList.add('sel');
        advance(next);
      });
    });

    // Checkboxes event listener
    el.querySelectorAll('.chk').forEach(function(c){
      c.addEventListener('click', function(){ 
        c.classList.toggle('sel'); 
        var selectedChecks = [];
        el.querySelectorAll('.chk.sel').forEach(function(sc){
          selectedChecks.push(sc.dataset.v);
        });
        F.answers[s.k] = selectedChecks;
      });
    });

    // Rent live listener
    var rentField = s.f && s.f.find(function(f){ return f[2] === 'rent-live'; });
    if(rentField) {
      var rl = el.querySelector('#' + rentField[0]);
      if(rl) {
        var updateRentDisplay = function(){
          var v = Number(rl.value), out = document.getElementById('rentOut');
          if (!out) return;
          if(!v){ out.innerHTML = 'Type a price and we will show how many students can reach you.'; return; }
          var r = reach(v);
          var totalDemand = typeof DEMAND_TOTAL !== 'undefined' ? DEMAND_TOTAL : 0;
          out.innerHTML = isReal()
            ? '<b>'+r+'</b> of the '+totalDemand+' students on Arzuz can afford this.'
            : 'Noted. We will tell you how many students this reaches once your listing is live.';
        };
        rl.addEventListener('input', updateRentDisplay);
        if(rl.value) updateRentDisplay();
      }
    }

    // Live validation listener for inputs
    el.querySelectorAll('input, select, textarea').forEach(function(inp){
      inp.addEventListener('input', function(){
        inp.classList.remove('input-error');
        var errEl = document.getElementById('err_' + inp.id);
        if (errEl) {
          errEl.textContent = '';
          errEl.classList.remove('active');
        }
      });
    });

    var bk = document.getElementById('fBack');
    if(bk) bk.addEventListener('click', function(){ advance(prev); });

    var skipBtn = document.getElementById('fSkip');
    if(skipBtn) {
      skipBtn.addEventListener('click', function(){
        advance(function(){
          var i = F.step + 1;
          while(i < F.steps.length && !shown(i)) i++;
          if(i < F.steps.length){ F.step = i; draw(); }
          else finish();
        });
      });
    }

    /* Validated FIRST so a missing field errors immediately on this step
       instead of playing the exit and erroring on the next draw. */
    document.getElementById('fNext').addEventListener('click', function(){
      collect();
      if(!validateCurrentStep()) return;
      advance(function(){
        var i = F.step + 1;
        while(i < F.steps.length && !shown(i)) i++;
        if(i < F.steps.length){ F.step = i; draw(); }
        else finish();
      });
    });
  }

  /* ============================================================
     Setup Leaflet Map — delegated to ArzuzMap.pinCapture
     Live GPS watch + accuracy ring + best-fix memory + metadata.
     ============================================================ */
  function setupLeafletMap(){
    if (typeof ArzuzMap === 'undefined') return;

    if (activePinCapture) { try { activePinCapture.destroy(); } catch(e){} activePinCapture = null; }

    activePinCapture = ArzuzMap.pinCapture({
      containerId: 'leaflet-map',
      layerSwitchId: 'mapLayerSwitcher',
      coordsBadgeId: 'mapCoordsText',
      locateBtnId: 'btnLocateMe',
      followBtnId: 'btnFollowMe',
      statusBoxId: 'mapLiveStatus',
      tipBannerId: 'mapTipBanner',
      lat: F.answers.lat,
      lng: F.answers.lng,
      answers: F.answers,
      startGps: !F.answers.lat
    });
  }

  /* ============================================================
     Cloudinary photo upload — signs via Netlify Function then
     POSTs the file directly to Cloudinary's upload API.
     ============================================================ */
  function handlePhotoUpload(fieldId, file){
    var progressEl = document.getElementById('photoProgress_'+fieldId);
    var zoneEl     = document.getElementById('photoZone_'+fieldId);

    function setProgress(msg, cls){
      if (!progressEl) return;
      progressEl.className = 'photo-progress' + (cls ? ' '+cls : '');
      progressEl.textContent = msg;
    }

    setProgress('⏳ Getting upload permission…');
    if (zoneEl) zoneEl.classList.add('uploading');

    fetch('/api/cloudinary-sign', { method: 'POST' })
      .then(function(r){
        if (r.ok) return r.json();
        /* "Sign endpoint returned 500" hid the one sentence that
           explains every photo that never uploads: the function says
           which environment variable is missing. Pass it through. */
        return r.text().then(function(body){
          /* The sign function's sentence is preferred — it names the
             missing environment variable — and its CLASS comes with it,
             so a deploy with no Cloudinary key (every photo will fail
             the same way, forever) is not read as a bad minute. A bare
             status is never shown either way, and the server's sentence
             is not lost if the classifier did not load. */
          if (typeof ArzuzApiErrors !== 'undefined') throw ArzuzApiErrors.failed(r, body);
          var detail = '';
          try { detail = (JSON.parse(body) || {}).error || ''; } catch (e) { detail = String(body || '').slice(0, 160); }
          throw new Error(detail || 'Arzuz could not start the photo upload just now — that is our side, not yours.');
        });
      })
      .then(function(sig){
        setProgress('📤 Uploading photo…');

        var fd = new FormData();
        fd.append('file',       file);
        fd.append('api_key',    sig.api_key);
        fd.append('timestamp',  sig.timestamp);
        fd.append('signature',  sig.signature);
        fd.append('folder',     sig.folder);
        fd.append('eager',      sig.eager);
        if (sig.max_file_size) fd.append('max_file_size', sig.max_file_size);

        var url = 'https://api.cloudinary.com/v1_1/' + sig.cloud_name + '/image/upload';
        return fetch(url, { method: 'POST', body: fd }).then(function(r){
          if (!r.ok) return r.text().then(function(t){ throw new Error('Cloudinary: ' + t); });
          return r.json();
        });
      })
      .then(function(result){
        var secureUrl = result.secure_url;
        F.answers[fieldId] = secureUrl;
        setProgress('✅ Photo uploaded!', 'success');
        if (zoneEl) {
          zoneEl.classList.remove('uploading');
          zoneEl.innerHTML = '<img src="'+secureUrl+'" class="photo-preview" alt="Building photo">';
        }
        // Show remove button
        var wrap = document.getElementById('photoWrap_'+fieldId);
        if (wrap && !wrap.querySelector('.photo-remove')) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'photo-remove';
          btn.dataset.field = fieldId;
          btn.textContent = '✕ Remove photo';
          btn.addEventListener('click', function(){ F.answers[fieldId] = ''; draw(); });
          wrap.appendChild(btn);
        }
        console.log('[Arzuz] Photo uploaded to Cloudinary:', secureUrl);
      })
      .catch(function(err){
        console.error('[Arzuz] Photo upload failed:', err.message);
        setProgress('⚠️ Photo upload is unavailable — ' + err.message +
          '. You can still submit and send the photos on WhatsApp.', 'error');
        if (zoneEl) zoneEl.classList.remove('uploading');
      });
  }

  /* Validate all fields on current step before advancing */
  function validateCurrentStep(){
    var s = F.steps[F.step];
    if (!s) return true;
    if (s.opt) return true;

    var isValid = true;
    var firstInvalidEl = null;

    function setFieldError(fieldId, message){
      isValid = false;
      var inp = document.getElementById(fieldId);
      if (inp) {
        inp.classList.add('input-error');
        if (!firstInvalidEl) firstInvalidEl = inp;
      }
      var err = document.getElementById('err_' + fieldId);
      if (err) {
        err.textContent = message;
        err.classList.add('active');
      }
    }

    // Validate choices (s.o)
    if (s.o && !s.opt) {
      if (!F.answers[s.k]) {
        var el = document.getElementById('form');
        var errContainer = el.querySelector('.opts');
        if (errContainer) {
          errContainer.classList.add('input-error');
        }
        return false;
      }
    }

    // Validate checkboxes (s.c)
    if (s.c && !s.opt) {
      var checks = F.answers[s.k] || [];
      if (!checks.length) {
        var cWrap = document.querySelector('.checks');
        if (cWrap) cWrap.classList.add('input-error');
        return false;
      }
    }

    // Validate the consent box (s.agree). One box, and it is the one
    // answer the server will not accept a submission without.
    if (s.agree && F.answers.consent !== 'yes') {
      var boxEl = document.getElementById('f_consent');
      if (boxEl) boxEl.classList.add('input-error');
      var boxErr = document.getElementById('err_consent');
      if (!boxErr) {
        var wrapEl = document.getElementById('f_consent');
        if (wrapEl && wrapEl.parentNode) {
          var note = document.createElement('div');
          note.id = 'err_consent';
          note.className = 'fld-err active';
          note.textContent = 'We cannot take your details without this.';
          wrapEl.parentNode.appendChild(note);
        }
      }
      return false;
    }

    // Validate individual fields (s.f)
    if (s.f) {
      s.f.forEach(function(f){
        var id = f[0];
        var label = f[1];
        var type = f[2];
        var req = isFieldRequired(f, s);
        var el = document.getElementById(id);
        var val = el ? el.value.trim() : (F.answers[id] || '');

        if (type === 'pin') {
          /* No pin yet: say so. Inventing the town-centre coordinates
             here used to file the building in the middle of Malete for
             every visitor who never touched the map. */
          if (req && !F.answers.lat) {
            setFieldError(id, 'Drop the pin on your gate to continue — tap the map, drag the marker, or press “Use My GPS” while you stand there.');
          }
          return;
        }

        if (type === 'passage') return; /* optional by design; the editor writes into F.answers.passage */

        if (req && !val) {
          setFieldError(id, label + ' is required.');
          return;
        }

        if (val) {
          // Email validation — optional everywhere, but a malformed one is
          // refused inline so a student is not later told "the code is on
          // its way" to a mailbox that does not exist. Same rule as the
          // server (netlify/functions/waitlist.js via notify.js).
          if (type === 'email' || id === 'email') {
            if (!/^[^\s@,;"<>]+@[^\s@,;"<>]+\.[A-Za-z]{2,}$/.test(val)) {
              setFieldError(id, 'That email address does not look complete \u2014 check it, or leave it blank.');
            }
          }
          // Name validation
          else if (['first', 'last', 'nm', 'g_name'].indexOf(id) !== -1) {
            if (!isValidName(val)) {
              setFieldError(id, 'Please enter a valid full name (at least 2 characters).');
            }
          }
          // Nigerian Phone validation
          else if (type === 'tel' || ['phone', 'ph', 'g_phone', 'lp'].indexOf(id) !== -1) {
            if (!isValidNigerianPhone(val)) {
              setFieldError(id, 'Enter a valid Nigerian WhatsApp number (e.g. 08012345678 or 2348012345678).');
            }
          }
          // Number validation
          else if (type === 'number' || type === 'rent-live') {
            if (isNaN(Number(val)) || Number(val) <= 0) {
              setFieldError(id, 'Please enter a valid positive number.');
            }
          }
        }
      });
    }

    if (!isValid && firstInvalidEl) {
      firstInvalidEl.focus();
    }

    return isValid;
  }

  function collect(){
    /* The honeypot and the consent box are not fields of a step, so they
       are read here rather than by the s.f loop below. `hp` always
       exists in F.answers once a step has been drawn: an absent key and
       an empty one have to mean the same thing to the server, which
       reads a filled one as a bot (and the database refuses it too —
       the anon insert policies in supabase-team-roles.sql). */
    var trap = document.getElementById('f_hp');
    F.answers.hp = trap ? trap.value : (F.answers.hp || '');
    var box = document.getElementById('f_consent');
    if (box) F.answers.consent = box.checked ? 'yes' : '';
    var s = F.steps[F.step];
    if (!s) return;
    if(s.f) s.f.forEach(function(f){
      var e = document.getElementById(f[0]); 
      if(e && f[2] !== 'pin' && f[2] !== 'passage') F.answers[f[0]] = e.value.trim();
    });
    if (activePassageEditor && s.f && s.f.some(function(f){ return f[2] === 'passage'; })) {
      activePassageEditor.get(); /* flush the editor state into F.answers */
    }
    if(s.ta){ 
      var t = document.getElementById(s.k); 
      if(t) F.answers[s.k] = t.value.trim(); 
    }
  }

  function next(){
    collect();
    if (!validateCurrentStep()) {
      return;
    }
    var i = F.step + 1;
    while(i < F.steps.length && !shown(i)) i++;
    if(i < F.steps.length){ F.step = i; draw(); }
    else finish();
  }

  function prev(){
    collect();
    var i = F.step - 1;
    while(i >= 0 && !shown(i)) i--;
    if (i >= 0) { F.step = i; draw(); }
  }

  function finish(){
    var el = document.getElementById('form');

    if(!F.table || typeof ArzuzSubmit === 'undefined'){
      el.innerHTML = F.done; window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }

    var btn = document.getElementById('fNext');
    if(btn){ btn.textContent = 'Saving to database\u2026'; btn.disabled = true; }

    ArzuzSubmit.send(F.table, F.answers).then(function(res){
      el.innerHTML = F.done;
      /* The sentence is the submit layer's classifier's, not this page's.
         This block used to say "your connection dropped" about EVERY
         queued failure — a table that was never created, a rate limit,
         a local-preview build included — and said nothing at all about a
         refusal, so a save the database rejected ended on a screen that
         looked like success. */
      if(res.queued){
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #F59E0B;">'+
          (res.note || 'We could not send that just now, so it is kept on this device and will sync automatically.') + '</div>');
      } else if(res.ok) {
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #10B981;">'+
          '<b>'+(res.duplicate ? 'You are already on the list.' : 'Submission saved!')+'</b> '+
          (res.duplicate
            /* The door's own sentence when it has one, because the door is
               where "this is a duplicate" is actually decided. And when
               the reference did not come back, "this is the reference you
               already have" is a promise about this page — so the fallback
               is only used when there is a reference under it. */
            ? (res.note || 'Nothing was submitted twice \u2014 this is the reference you already have.')
            : 'Your information was securely sent to the database.')+'</div>'+
          /* THE REFERENCE, IN THE ONE MOMENT IT IS USEFUL. A person who
             has just been told they are on the list is the only person
             who will ever read this string, and it is the only handle
             they have: it goes in the WhatsApp message they send us and
             it is what a support agent types to find their row. */
          (res.ref
            ? '<div class="live" style="margin-top:12px;border-left:3.5px solid #6366F1;">'+
              '<b>Your reference: '+res.ref+'</b><br>Keep this \u2014 read it to us on WhatsApp and '+
              'we can find your place on the list straight away. '+
              /* AND THE OTHER THING A REFERENCE IS FOR. This is the only
                 moment the person holding it is looking at the string, so
                 it is the only moment worth linking /status from: the
                 page needs the reference and a phone number, and both are
                 in front of them right now. The ref is URL-encoded rather
                 than pasted in \u2014 it is a server-minted value, but a
                 value on its way into a URL is a value to encode. */
              'You can also <a href="/status?ref='+encodeURIComponent(res.ref)+'">check where it has '+
              'got to</a> yourself, any time.</div>'
            : '')+
          (res.note && !res.duplicate
            ? '<div class="live" style="margin-top:12px;">'+res.note+'</div>'
            : ''));
      } else {
        /* Not saved and deliberately not held: the database refused it,
           so retrying changes nothing. Saying so is the whole point —
           silence here read as success. */
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #EF4444;">'+
          (res.note || 'Arzuz could not save that — that is our side, not yours. Message us on WhatsApp and we will finish it with you.') + '</div>');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  return { 
    ng: ng, 
    STAMP_DATE: STAMP_DATE, 
    reach: reach, 
    isReal: isReal,
    chrome: chrome, 
    footer: footer, 
    form: form,
    answers: function(){ return F.answers; },
    uploadPhoto: handlePhotoUpload
  };
})();

