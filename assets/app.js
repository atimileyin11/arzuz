/* ============================================================
   Arzuz — shared application logic
   Page chrome, formatting helpers, and the multi-step form engine.
   Includes:
   - Interactive Leaflet + OpenStreetMap GPS Pin Capture
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
      '<a href="mailto:support@arzuz.com">support@arzuz.com</a></div>'+
      'Arzuz does not collect rent, hold deposits, or take payment from tenants. '+
      'Your phone number is used to verify your account and send you matches. '+
      'It is never shown publicly.<br><br>'+
      'Arzuz \u2014 Malete, Kwara State. Pronounced AR-zuz.'+
      '</div></div>');
  }

  /* ---------- multi-step form engine ---------- */
  var F = {steps:[], step:0, answers:{}, done:'', backHref:'', backLabel:'', table:null};
  var activeLeafletMap = null;
  var activeMarker = null;

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
    if (['first', 'nm', 'g_name', 'phone', 'ph', 'g_phone', 'area', 'ar', 'rent', 'amt', 'type', 'ty'].indexOf(name) !== -1) {
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

    if(s.ctx) h += '<div class="ctxbox">'+ (isReal()
      ? '<b>'+(typeof DEMAND_TOTAL !== 'undefined' ? DEMAND_TOTAL : '61')+' students</b> are looking in Malete this session. '+
        'Most can pay between \u20A6100,000 and \u20A6200,000.'
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
             '<label>Location Pin (Malete)</label>' +
             '<span class="fld-badge-req">📍 Draggable GPS</span>' +
             '</div>' +
             '<div class="map-wrap">' +
             '<div id="leaflet-map"></div>' +
             '<div class="map-controls-bar">' +
             '<span class="map-coords-badge" id="mapCoordsText">📍 Drag marker to entrance gate</span>' +
             '<button type="button" class="btn-locate" id="btnLocateMe">🎯 Detect My GPS</button>' +
             '</div>' +
             '<div class="live" style="margin-top:12px;" id="mapLiveStatus">' +
             'Map centered on Malete. Drag the purple marker to the exact entrance gate of your compound.' +
             '</div>' +
             '</div>';
      } else if(f[2]==='rent-live'){
        x += '<input type="number" id="'+f[0]+'" placeholder="e.g. 180000" value="'+val+'">'+
             '<div class="live" id="rentOut">Type a price and we will show how many students can reach you.</div>';
      } else if(f[2]==='tel'){
        x += '<input type="tel" id="'+f[0]+'" value="'+val+'" placeholder="e.g. 08012345678" inputmode="tel">';
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
          var totalDemand = typeof DEMAND_TOTAL !== 'undefined' ? DEMAND_TOTAL : 61;
          out.innerHTML = isReal()
            ? '<b>'+r+'</b> of the '+totalDemand+' students looking in Malete can afford this.'+
              (v > 200000 ? ' Drop to \u20A6200,000 and '+(reach(200000)-r)+' more can see you.' : '')
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

  /* Setup Leaflet Map & GPS Geolocation */
  function setupLeafletMap(){
    var defaultLat = 8.7113; // Malete, Kwara State
    var defaultLng = 4.4697;

    var savedLat = F.answers.lat ? parseFloat(F.answers.lat) : defaultLat;
    var savedLng = F.answers.lng ? parseFloat(F.answers.lng) : defaultLng;

    function renderMap(){
      var mapContainer = document.getElementById('leaflet-map');
      if (!mapContainer || typeof L === 'undefined') return;

      if (activeLeafletMap) {
        try { activeLeafletMap.remove(); } catch(e){}
      }

      activeLeafletMap = L.map('leaflet-map', { zoomControl: true }).setView([savedLat, savedLng], 15);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(activeLeafletMap);

      activeMarker = L.marker([savedLat, savedLng], {
        draggable: true
      }).addTo(activeLeafletMap);

      function updateCoordsUI(lat, lng, statusMsg){
        F.answers.lat = lat;
        F.answers.lng = lng;
        F.answers.pin = lat.toFixed(6) + ',' + lng.toFixed(6);

        var badge = document.getElementById('mapCoordsText');
        if (badge) {
          badge.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
        }
        var status = document.getElementById('mapLiveStatus');
        if (status && statusMsg) {
          status.innerHTML = '<b>Location set:</b> ' + statusMsg;
        }
      }

      activeMarker.on('dragend', function(){
        var pos = activeMarker.getLatLng();
        updateCoordsUI(pos.lat, pos.lng, 'Marker moved manually. Accurate coordinates recorded.');
      });

      // Geolocation trigger function
      function detectGps(){
        var status = document.getElementById('mapLiveStatus');
        if (!navigator.geolocation) {
          if (status) status.innerHTML = 'Geolocation is not supported by your browser. Please drag the pin on the map.';
          return;
        }
        if (status) status.innerHTML = '<i>Requesting GPS coordinates from your device\u2026</i>';

        navigator.geolocation.getCurrentPosition(function(pos){
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;
          var acc = Math.round(pos.coords.accuracy || 15);

          activeMarker.setLatLng([lat, lng]);
          activeLeafletMap.setView([lat, lng], 17);
          updateCoordsUI(lat, lng, 'GPS captured successfully! Accurate to \u00B1' + acc + 'm. Drag marker if needed.');
        }, function(err){
          console.warn('[Leaflet] GPS request failed:', err.message);
          if (status) {
            status.innerHTML = 'Could not acquire GPS (' + err.message + '). Please drag the purple pin to your compound entrance in Malete.';
          }
        }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
      }

      var btnLocate = document.getElementById('btnLocateMe');
      if (btnLocate) btnLocate.addEventListener('click', detectGps);

      if (!F.answers.lat) {
        detectGps();
      } else {
        updateCoordsUI(savedLat, savedLng, 'Restored previously pinned gate location.');
      }

      setTimeout(function(){
        if (activeLeafletMap) activeLeafletMap.invalidateSize();
      }, 300);
    }

    if (typeof L === 'undefined') {
      var script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = renderMap;
      document.head.appendChild(script);
    } else {
      setTimeout(renderMap, 50);
    }
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
          if (req && !F.answers.lat) {
            F.answers.lat = 8.7113;
            F.answers.lng = 4.4697;
            F.answers.pin = '8.711300,4.469700';
          }
          return;
        }

        if (req && !val) {
          setFieldError(id, label + ' is required.');
          return;
        }

        if (val) {
          // Name validation
          if (['first', 'nm', 'g_name'].indexOf(id) !== -1) {
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
      if(e && f[2] !== 'pin') F.answers[f[0]] = e.value.trim();
    });
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
    answers: function(){ return F.answers; }
  };
})();

