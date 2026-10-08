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
      '<header><div class="hrow"><a href="index.html" aria-label="Arzuz Home">'+
      '<span class="m"><span>az</span></span>'+
      '<span class="hw">ar<i>z</i>u<i>z</i></span></a>'+
      '<span class="htag">' + tag + '</span></div></header>');
  }

  function footer(){
    if (document.querySelector('.sitefoot')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="wrap"><div class="sitefoot">'+
      '<div class="flinks">'+
      '<a href="safety.html">Your safety</a>'+
      '<a href="privacy.html">Privacy</a>'+
      '<a href="terms.html">Terms</a>'+
      '<a href="mailto:support@arzuz.com">support@arzuz.com</a>'+
      '<a href="https://wa.me/2349024814771" target="_blank" rel="noopener noreferrer">WhatsApp: 09024814771</a></div>'+
      'Arzuz does not collect rent, hold deposits, or take payment from tenants. '+
      'Your phone number is used to verify your account and send you matches. '+
      'It is never shown publicly.<br><br>'+
      'Arzuz. Open to students everywhere, starting in Malete, Kwara State. Pronounced AR-zuz.'+
      '</div></div>');
  }

  /* ---------- multi-step form engine ---------- */
  var F = {steps:[], step:0, answers:{}, done:'', backHref:'', backLabel:'', table:null};
  var activePinCapture = null;
  var activePassageEditor = null;

  function form(opts){
    F.steps = opts.steps; F.step = 0; F.answers = {};
    F.done = opts.done; F.backHref = opts.backHref || 'index.html';
    F.backLabel = opts.backLabel || '\u2190 Back';
    F.table = opts.table || null;
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
    window.scrollTo({ top: 0, behavior: 'smooth' });

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

    // Option buttons event listener
    el.querySelectorAll('.opt').forEach(function(b){
      b.addEventListener('click', function(){
        F.answers[s.k] = b.dataset.v;
        el.querySelectorAll('.opt').forEach(function(o){o.classList.remove('sel')});
        b.classList.add('sel');
        setTimeout(next, 160);
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
    if(bk) bk.addEventListener('click', prev);

    var skipBtn = document.getElementById('fSkip');
    if(skipBtn) {
      skipBtn.addEventListener('click', function(){
        var i = F.step + 1;
        while(i < F.steps.length && !shown(i)) i++;
        if(i < F.steps.length){ F.step = i; draw(); }
        else finish();
      });
    }

    document.getElementById('fNext').addEventListener('click', next);
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
        if (!r.ok) throw new Error('Sign endpoint returned ' + r.status);
        return r.json();
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
        setProgress('⚠️ Upload failed — please try again.', 'error');
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
          // Name validation
          if (['first', 'last', 'nm', 'g_name'].indexOf(id) !== -1) {
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
      if(res.queued){
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #F59E0B;">'+
          'Your connection dropped or database is in local preview mode. Submission is '+
          'saved on your device and will sync automatically once online.</div>');
      } else if(res.ok) {
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #10B981;">'+
          '<b>Submission saved!</b> Your information was securely sent to the database.</div>');
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

