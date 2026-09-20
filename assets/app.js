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
             '<span class="fld-badge-req">📡 Satellite + Street</span>' +
             '</div>' +
             '<div class="map-tip-banner" id="mapTipBanner">' +
             '<span class="map-tip-icon">🛰️</span>' +
             '<span><b>Satellite view is active.</b> You can see real rooftops, gates, and trees — zoom in and drop your pin directly on your building.</span>' +
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
             '<button type="button" class="btn-locate" id="btnLocateMe">🎯 Use My GPS</button>' +
             '</div>' +
             '<div class="map-status-box" id="mapLiveStatus">' +
             'Switch to <b>Satellite</b> view to see actual rooftops. Tap anywhere on the map to drop a pin, or drag the marker to the exact gate of your compound.' +
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

  /* ============================================================
     Setup Leaflet Map — Hybrid Satellite + Street Layer Switcher
     Default: Esri World Imagery (real satellite photography)
     Secondary: OpenStreetMap (street names for orientation)
     Features: click-to-pin, drag-to-pin, GPS detect, layer toggle
     ============================================================ */
  function setupLeafletMap(){
    var MALETE_LAT = 8.7113; // Malete, Kwara State centre
    var MALETE_LNG = 4.4697;

    var savedLat = F.answers.lat ? parseFloat(F.answers.lat) : MALETE_LAT;
    var savedLng = F.answers.lng ? parseFloat(F.answers.lng) : MALETE_LNG;

    // Track active tile layer so we can swap it
    var activeTileLayer = null;

    // Tile layer definitions
    var LAYERS = {
      sat: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: {
          maxZoom: 19,
          attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, GeoEye, Earthstar Geographics'
        }
      },
      street: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
      }
    };

    function renderMap(){
      var mapContainer = document.getElementById('leaflet-map');
      if (!mapContainer || typeof L === 'undefined') return;

      // Destroy any existing map instance cleanly
      if (activeLeafletMap) {
        try { activeLeafletMap.remove(); } catch(e){}
        activeLeafletMap = null;
        activeMarker = null;
        activeTileLayer = null;
      }

      // Initialise map — satellite by default, zoom 16 for building-level view
      activeLeafletMap = L.map('leaflet-map', {
        zoomControl: true,
        attributionControl: true
      }).setView([savedLat, savedLng], 16);

      // Load satellite layer by default
      activeTileLayer = L.tileLayer(LAYERS.sat.url, LAYERS.sat.options);
      activeTileLayer.addTo(activeLeafletMap);

      // Custom pin icon — larger, more precise for satellite use
      var pinIcon = L.divIcon({
        className: '',
        html: '<div class="map-pin-custom"><div class="map-pin-ring"></div><div class="map-pin-dot"></div></div>',
        iconSize: [32, 42],
        iconAnchor: [16, 42],
        popupAnchor: [0, -42]
      });

      activeMarker = L.marker([savedLat, savedLng], {
        draggable: true,
        icon: pinIcon,
        title: 'Drag to your entrance gate'
      }).addTo(activeLeafletMap);

      activeMarker.bindTooltip('Drag me to your gate', {
        permanent: false,
        direction: 'top',
        offset: [0, -10],
        className: 'map-tooltip'
      });

      // ---- Update coordinates display ----
      function updateCoordsUI(lat, lng, statusMsg, isGps){
        F.answers.lat = lat;
        F.answers.lng = lng;
        F.answers.pin = lat.toFixed(6) + ',' + lng.toFixed(6);

        var badge = document.getElementById('mapCoordsText');
        if (badge) {
          badge.textContent = '\uD83D\uDCCD ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
          badge.classList.add('coords-set');
        }
        var status = document.getElementById('mapLiveStatus');
        if (status && statusMsg) {
          var icon = isGps ? '\uD83C\uDF0D' : '\uD83D\uDCCD';
          status.innerHTML = icon + ' <b>' + (isGps ? 'GPS locked:' : 'Pin placed:') + '</b> ' + statusMsg;
          status.classList.add('status-success');
        }
      }

      // ---- Drag to place pin ----
      activeMarker.on('dragend', function(){
        var pos = activeMarker.getLatLng();
        updateCoordsUI(pos.lat, pos.lng, 'Marker repositioned. Accurate coordinates recorded.', false);
      });

      // ---- Click-to-pin: tap anywhere on the map ----
      activeLeafletMap.on('click', function(e){
        activeMarker.setLatLng(e.latlng);
        updateCoordsUI(e.latlng.lat, e.latlng.lng, 'Tapped location pinned. Drag to refine if needed.', false);
      });

      // ---- GPS detection ----
      function detectGps(){
        var status = document.getElementById('mapLiveStatus');
        var btnLocate = document.getElementById('btnLocateMe');
        if (!navigator.geolocation) {
          if (status) status.innerHTML = '\u26A0\uFE0F Geolocation not supported. Tap your building on the satellite view to pin it.';
          return;
        }
        if (status) status.innerHTML = '<span class="map-loading"></span> Requesting GPS from your device\u2026';
        if (btnLocate) { btnLocate.textContent = '\u23F3 Locating\u2026'; btnLocate.disabled = true; }

        navigator.geolocation.getCurrentPosition(
          function(pos){
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            var acc = Math.round(pos.coords.accuracy || 15);

            activeMarker.setLatLng([lat, lng]);
            // Zoom to building level (18) on GPS success for precision
            activeLeafletMap.setView([lat, lng], 18);
            updateCoordsUI(lat, lng, 'Accurate to \u00B1' + acc + 'm. You can drag the pin to fine-tune.', true);

            if (btnLocate) { btnLocate.textContent = '\uD83C\uDF0D GPS Locked'; btnLocate.disabled = false; }
          },
          function(err){
            console.warn('[Leaflet] GPS failed:', err.message);
            if (status) {
              status.innerHTML = '\u26A0\uFE0F Could not get GPS (' + err.message + '). Switch to <b>Satellite</b> and tap your building roof to pin it.';
            }
            if (btnLocate) { btnLocate.textContent = '\uD83C\uDFAF Use My GPS'; btnLocate.disabled = false; }
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      }

      var btnLocate = document.getElementById('btnLocateMe');
      if (btnLocate) btnLocate.addEventListener('click', detectGps);

      // ---- Layer switcher buttons ----
      function switchLayer(layerKey){
        if (!activeLeafletMap) return;
        if (activeTileLayer) {
          activeLeafletMap.removeLayer(activeTileLayer);
        }
        var def = LAYERS[layerKey];
        activeTileLayer = L.tileLayer(def.url, def.options);
        activeTileLayer.addTo(activeLeafletMap);
        // Bring marker to front after layer swap
        if (activeMarker) activeMarker.bringToFront();

        // Update button active state
        var btns = document.querySelectorAll('.map-layer-btn');
        btns.forEach(function(b){ b.classList.remove('active'); });
        var activeBtn = document.getElementById(layerKey === 'sat' ? 'btnLayerSat' : 'btnLayerStreet');
        if (activeBtn) activeBtn.classList.add('active');

        // Show/hide the satellite tip banner
        var tip = document.getElementById('mapTipBanner');
        if (tip) tip.style.display = layerKey === 'sat' ? '' : 'none';
      }

      var btnSat = document.getElementById('btnLayerSat');
      var btnStreet = document.getElementById('btnLayerStreet');
      if (btnSat) btnSat.addEventListener('click', function(){ switchLayer('sat'); });
      if (btnStreet) btnStreet.addEventListener('click', function(){ switchLayer('street'); });

      // ---- Restore saved pin or auto-detect GPS ----
      if (F.answers.lat) {
        updateCoordsUI(savedLat, savedLng, 'Previously pinned location restored. Tap or drag to move.', false);
      } else {
        // Auto-detect GPS on first load
        detectGps();
      }

      // Fix Leaflet container sizing after DOM settles
      setTimeout(function(){
        if (activeLeafletMap) activeLeafletMap.invalidateSize();
      }, 320);
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

