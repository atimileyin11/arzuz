/* ============================================================
   Arzuz — precision mapping engine (arzuz-map.js)

   One shared module behind every map surface on the site:

     ArzuzMap.pinCapture(opts)   live-GPS pin capture (forms + admin)
     ArzuzMap.routeMap(opts)     read-only route map + "track me there"
     ArzuzMap.geo                haversine, polyline length, simplify, OSRM
     ArzuzMap.passage            normalise + summarise passage records
     ArzuzMap.PASSAGE_KEY        the payload key passage data rides in

   Data model (all stored inside the row's payload jsonb):

     pin      "8.711300,4.469700"          unchanged legacy value
     lat/lng  numbers as strings           unchanged legacy values
     pin_meta { source: 'gps'|'tapped'|'dragged'|'admin',
                  accuracy_m: number,       metres — lower is better
                  samples: number,          GPS readings averaged in
                  captured_at: ISO string,
                  altitude_m?: number, heading_deg?: number,
                  follow?: boolean }

     passage  { landmark?: string, gate?: string, floor?: string,
                steps: [{ text, lat?, lng? }],        ordered directions
                route:  [[lat, lng], …],              traced/recorded path
                route_src: 'traced'|'walk'|'osrm',
                route_km?: number, route_min?: number }

   ES5 only, no build step, Leaflet 1.9.4 expected as global L.
   ============================================================ */

var ArzuzMap = (function () {

  /* ---------- shared constants ---------- */

  var MALETE = [8.7113, 4.4697];
  var CAMPUS = { lat: 8.721, lng: 4.484 };   /* KWASU main gate */

  var TILE = {
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opt: {
        maxZoom: 19,
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, GeoEye, Earthstar Geographics'
      }
    },
    street: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      opt: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    }
  };

  var PASSAGE_KEY = 'passage';

  /* ---------- tiny DOM + format helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  /* Toast when the submit layer is present, console otherwise */
  function toast(msg, type) {
    if (window.ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(msg, type || 'info');
    else console.log('[ArzuzMap]', msg);
  }

  /* ============================================================
     geo — distance, length, simplification, OSRM routing
     ============================================================ */

  var geo = {};

  /* straight-line km between two points */
  geo.haversineKm = function (lat1, lng1, lat2, lng2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  /* walking time estimate from a path length */
  geo.walkMinutes = function (km) { return Math.round(km / 4.5 * 60); };

  /* total km along a polyline [[lat,lng],…] */
  geo.polylineKm = function (pts) {
    if (!pts || pts.length < 2) return 0;
    var total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += geo.haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    return total;
  };

  /* Douglas–Peucker in metres — collapses GPS jitter into a clean path */
  geo.simplify = function (pts, tolM) {
    if (!pts || pts.length < 3) return (pts || []).slice();
    var tol = (tolM || 4) / 111320; /* metres → degrees, good enough near the equator */
    var keep = new Array(pts.length);
    keep[0] = keep[pts.length - 1] = true;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var range = stack.pop(), a = range[0], b = range[1];
      var maxD = -1, idx = -1;
      for (var i = a + 1; i < b; i++) {
        var d = perpDist(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) {
        keep[idx] = true;
        stack.push([a, idx], [idx, b]);
      }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
    return out;
  };

  function perpDist(p, a, b) {
    var ax = a[0], ay = a[1], bx = b[0], by = b[1], px = p[0], py = p[1];
    var dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) {
      var ddx = px - ax, ddy = py - ay;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }
    var t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    t = clamp(t, 0, 1);
    var cx = ax + t * dx, cy = ay + t * dy;
    var ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /* Nearest distance (degrees) from a point to a polyline segment chain */
  geo.distToPolyline = function (lat, lng, pts) {
    if (!pts || pts.length < 2) return Infinity;
    var min = Infinity;
    for (var i = 1; i < pts.length; i++) {
      min = Math.min(min, perpDist([lat, lng], pts[i - 1], pts[i]));
    }
    return min;
  };

  /* OSRM walking route via the free FOSSGIS server — no API key.
     coords: [[lat,lng],…] — [origin, …optional via points…, destination].
     Resolves { km, min, pts: [[lat,lng],…] } or rejects. */
  var OSRM_CACHE_PREFIX = 'arzuz_osrm_v1_';
  geo.footRoute = function (coords) {
    if (!coords || coords.length < 2) return Promise.reject(new Error('need two points'));
    var coordStr = coords.map(function (c) {
      return Number(c[1]).toFixed(6) + ',' + Number(c[0]).toFixed(6); /* OSRM wants lng,lat */
    }).join(';');
    var key = OSRM_CACHE_PREFIX + coordStr;
    try {
      var hit = localStorage.getItem(key);
      if (hit) return Promise.resolve(JSON.parse(hit));
    } catch (e) { /* private mode — fetch live */ }

    var url = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/' +
      coordStr + '?overview=full&geometries=geojson&steps=false';
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('OSRM HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var route = j && j.routes && j.routes[0];
        if (!route || !route.geometry || !route.geometry.coordinates || !route.geometry.coordinates.length) {
          throw new Error('OSRM returned no route');
        }
        var pts = route.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
        var out = {
          km: route.distance / 1000,
          min: geo.walkMinutes(route.duration),
          pts: pts,
          fetched_at: new Date().toISOString()
        };
        try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) { /* full — skip */ }
        return out;
      });
  };

  /* ============================================================
     passage — normalise + describe
     ============================================================ */

  var passage = {};

  /* Accept anything (legacy rows, partial admin edits) and return a
     clean { landmark, gate, floor, steps[], route[], route_src } —
     or null when nothing usable is stored. */
  passage.normalise = function (raw) {
    if (!raw || typeof raw !== 'object') return null;
    var out = {
      landmark: typeof raw.landmark === 'string' ? raw.landmark : '',
      gate: typeof raw.gate === 'string' ? raw.gate : '',
      floor: typeof raw.floor === 'string' ? raw.floor : '',
      steps: [],
      route: [],
      route_src: (raw.route_src === 'traced' || raw.route_src === 'walk' || raw.route_src === 'osrm') ? raw.route_src : ''
    };
    if (Array.isArray(raw.steps)) {
      raw.steps.forEach(function (s) {
        if (!s) return;
        if (typeof s === 'string') s = { text: s };
        if (s.text && String(s.text).trim()) {
          var st = { text: String(s.text).trim() };
          if (isFinite(Number(s.lat)) && isFinite(Number(s.lng))) {
            st.lat = Number(s.lat); st.lng = Number(s.lng);
          }
          out.steps.push(st);
        }
      });
    }
    if (Array.isArray(raw.route)) {
      raw.route.forEach(function (pt) {
        var la = Number(pt && pt[0]), ln = Number(pt && pt[1]);
        if (isFinite(la) && isFinite(ln)) out.route.push([la, ln]);
      });
    }
    if (!out.landmark && !out.gate && !out.floor && !out.steps.length && out.route.length < 2) return null;
    return out;
  };

  passage.hasContent = function (raw) { return !!passage.normalise(raw); };

  /* Short human summary for chips and admin tables */
  passage.summarise = function (raw) {
    var ps = passage.normalise(raw);
    if (!ps) return '';
    var bits = [];
    if (ps.steps.length) bits.push(ps.steps.length + (ps.steps.length === 1 ? ' step' : ' steps'));
    if (ps.landmark) bits.push('landmark');
    if (ps.gate) bits.push('gate');
    if (ps.floor) bits.push('floor');
    if (ps.route && ps.route.length > 1) {
      var km = geo.polylineKm(ps.route);
      bits.push(km >= 0.1 ? km.toFixed(1) + ' km path' : Math.round(km * 1000) + ' m path');
    }
    return bits.join(' · ');
  };

  /* Walk description that prefers a stored measured route over the
     straight-line guess — shared by browse + listing. */
  passage.walkChip = function (raw) {
    var ps = passage.normalise(raw);
    if (ps && ps.route && ps.route.length > 1) {
      var km = geo.polylineKm(ps.route);
      var min = geo.walkMinutes(km);
      if (min >= 1 && min <= 90) {
        return { km: km, min: min, src: ps.route_src || 'measured',
                 text: '\uD83D\uDEB6 ' + (km >= 0.1 ? km.toFixed(1) + ' km' : Math.round(km * 1000) + ' m') +
                       ' · ' + min + ' min walk to KWASU' };
      }
    }
    return null;
  };

  /* ============================================================
     pinCapture — live-GPS pin capture widget
     ============================================================ */

  /* Quality bands for the ±m badge */
  function accState(acc) {
    if (!isFinite(acc)) return { cls: 'poor', label: 'no fix' };
    if (acc <= 10) return { cls: 'precise', label: 'precise' };
    if (acc <= 30) return { cls: 'good', label: 'good' };
    return { cls: 'poor', label: 'weak' };
  }

  /* options:
       containerId   leaflet-map div id (required)
       layerSwitchId wrapper id for the satellite/street pill (required)
       coordsBadgeId status text id (required)
       locateBtnId   "use my GPS" button id (required)
       statusBoxId   live status box id (required)
       tipBannerId   satellite tip banner id (optional)
       lat/lng       initial pin position (defaults: Malete centre)
       answers       object to write lat/lng/pin/pin_meta into (forms)
       onPin         callback (lat, lng, meta) for hidden-input style hosts
       startGps      auto-start live GPS on mount (default: true when no saved pin)
       trace         show the route-trace toolbar (default false)
   */
  function pinCapture(opts) {
    if (!opts || !opts.containerId) return null;
    var host = {
      answers: opts.answers || null,
      onPin: typeof opts.onPin === 'function' ? opts.onPin : function () {}
    };
    var map, marker, tileLayer, accRing, meDot;
    var watchId = null, bestAcc = Infinity, samples = 0;
    var follow = false, userMovedMap = false, started = false;
    var traceMode = false, tracePts = [], traceLine = null, traceUndoStack = [];
    var initial = {
      lat: isFinite(parseFloat(opts.lat)) ? parseFloat(opts.lat) : MALETE[0],
      lng: isFinite(parseFloat(opts.lng)) ? parseFloat(opts.lng) : MALETE[1]
    };
    var hasSavedPin = isFinite(parseFloat(opts.lat)) && !!parseFloat(opts.lat);

    /* ---- write through to the host ---- */
    function commit(lat, lng, source, extraMeta) {
      var meta = {
        source: source,
        accuracy_m: isFinite(bestAcc) && bestAcc !== Infinity ? Math.round(bestAcc) : null,
        samples: samples,
        captured_at: new Date().toISOString()
      };
      if (extraMeta) {
        Object.keys(extraMeta).forEach(function (k) { meta[k] = extraMeta[k]; });
      }
      if (host.answers) {
        host.answers.lat = lat;
        host.answers.lng = lng;
        host.answers.pin = lat.toFixed(6) + ',' + lng.toFixed(6);
        host.answers.pin_meta = meta;
      }
      host.onPin(lat, lng, meta);
      return meta;
    }

    function paintCoords(lat, lng, msg, kind) {
      var badge = $(opts.coordsBadgeId);
      if (badge) {
        badge.textContent = '\uD83D\uDCCD ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
        badge.classList.add('coords-set');
      }
      var box = $(opts.statusBoxId);
      if (box) {
        box.innerHTML = msg;
        if (kind) box.classList.add('status-success');
      }
    }

    /* ---- GPS state machine ---- */
    function setStatus(html, cls) {
      var box = $(opts.statusBoxId);
      if (box) {
        box.innerHTML = html;
        box.classList.remove('status-success');
        if (cls) box.classList.add(cls);
      }
    }

    function gpsBadge(acc) {
      var st = accState(acc);
      return '<span class="gps-acc gps-' + st.cls + '" id="gpsAccBadge">\u00B1' +
        (isFinite(acc) ? Math.round(acc) : '—') + 'm · ' + st.label + '</span>';
    }

    function startGpsLive() {
      if (started || !navigator.geolocation) return;
      started = true;
      setStatus('<span class="map-loading"></span> Searching for GPS satellites\u2026', null);
      watchId = navigator.geolocation.watchPosition(onFix, onGpsError,
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 });
    }

    function stopGpsLive() {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null; started = false;
    }

    function onFix(pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var acc = pos.coords.accuracy || 999;
      samples++;
      var firstFix = !isFinite(bestAcc) || bestAcc === Infinity;

      /* live dot — tracks even the lightest movement */
      if (meDot) meDot.setLatLng([lat, lng]);
      else {
        meDot = L.circleMarker([lat, lng], {
          radius: 7, weight: 2.5, color: '#2563EB', fillColor: '#60A5FA', fillOpacity: 0.9, opacity: 1
        }).addTo(map).bindTooltip('You, live', { direction: 'top', className: 'map-tooltip' });
      }

      /* accuracy ring — resize with every reading */
      var ringLl = L.latLng(lat, lng);
      if (accRing) accRing.setLatLng(ringLl).setRadius(acc);
      else accRing = L.circle(ringLl, {
        radius: acc, weight: 1, color: '#2563EB', fillColor: '#3B82F6', fillOpacity: 0.08, opacity: 0.35
      }).addTo(map);

      /* best-fix memory: hold on to the most precise sample */
      if (acc < bestAcc) {
        bestAcc = acc;
        marker.setLatLng([lat, lng]);
        if (!hasSavedPin || firstFix) commit(lat, lng, 'gps');
        else commit(lat, lng, 'gps');
      }

      if (follow && !userMovedMap) map.setView([lat, lng], Math.max(map.getZoom(), 17), { animate: true });

      var qual = accState(acc);
      var msg = '\uD83C\uDF0D <b>Live GPS:</b> tracking every move. ' + gpsBadge(acc) +
        (qual.cls === 'precise' ? ' — drop the pin on your gate.' :
         qual.cls === 'good' ? ' — step outside or tap your roof on satellite.' :
         ' — stand still near a window, or tap the roof directly.');
      setStatus(msg, 'status-success');

      /* a strong fix with no saved pin: gently settle the map the first time */
      if (!hasSavedPin && firstFix) {
        map.setView([lat, lng], acc <= 15 ? 18 : 16);
      }
    }

    function onGpsError(err) {
      console.warn('[ArzuzMap] GPS error:', err && err.message);
      setStatus('\u26A0\uFE0F GPS unavailable (' + esc(err && err.message || 'unknown') +
        '). <b>Tap your building on the satellite view</b> — the pin still stores exact coordinates.', null);
      var btn = $(opts.locateBtnId);
      if (btn) { btn.textContent = '\uD83C\uDFAF Retry GPS'; btn.disabled = false; }
      started = false; /* allow retry */
    }

    /* ---- map scaffolding ---- */
    function buildMap() {
      var el = $(opts.containerId);
      if (!el || typeof L === 'undefined') return;

      if (map) { try { map.remove(); } catch (e) {} map = null; marker = null; accRing = null; meDot = null; traceLine = null; }

      map = L.map(opts.containerId, { zoomControl: true, attributionControl: true })
        .setView([initial.lat, initial.lng], hasSavedPin ? 18 : 15);

      tileLayer = L.tileLayer(TILE.sat.url, TILE.sat.opt);
      tileLayer.addTo(map);

      var pinIcon = L.divIcon({
        className: '',
        html: '<div class="map-pin-custom"><div class="map-pin-ring"></div><div class="map-pin-dot"></div></div>',
        iconSize: [32, 42], iconAnchor: [16, 42], popupAnchor: [0, -42]
      });
      marker = L.marker([initial.lat, initial.lng], { draggable: true, icon: pinIcon, title: 'Drag to the exact gate' })
        .addTo(map)
        .bindTooltip('Drag me to the exact gate', { direction: 'top', offset: [0, -10], className: 'map-tooltip' });

      marker.on('dragend', function () {
        var p = marker.getLatLng();
        userMovedMap = true;
        commit(p.lat, p.lng, 'dragged');
        paintCoords(p.lat, p.lng, '\uD83D\uDCCD <b>Pin placed:</b> dragged position stored. Nudge it until it sits on the gate.', 'ok');
      });

      map.on('click', function (e) {
        if (traceMode) { addTraceVertex(e.latlng); return; }
        marker.setLatLng(e.latlng);
        commit(e.latlng.lat, e.latlng.lng, 'tapped');
        paintCoords(e.latlng.lat, e.latlng.lng,
          '\uD83D\uDCCD <b>Pin placed:</b> tapped location stored. Drag to refine if needed.', 'ok');
      });

      map.on('dragstart zoomstart', function () { userMovedMap = true; });

      /* layer switcher */
      function swLayer(k) {
        if (tileLayer) map.removeLayer(tileLayer);
        tileLayer = L.tileLayer(TILE[k].url, TILE[k].opt).addTo(map);
        if (marker) marker.bringToFront();
        var btns = document.querySelectorAll('.map-layer-btn');
        btns.forEach(function (b) { b.classList.remove('active'); });
        var active = document.querySelector('.map-layer-btn[data-layer="' + k + '"]');
        if (active) active.classList.add('active');
        var tip = $(opts.tipBannerId);
        if (tip) tip.style.display = k === 'sat' ? '' : 'none';
      }
      var sw = $(opts.layerSwitchId);
      if (sw) {
        sw.querySelectorAll('.map-layer-btn').forEach(function (b) {
          b.addEventListener('click', function () { swLayer(b.dataset.layer); });
        });
      }

      /* GPS button */
      var btnLocate = $(opts.locateBtnId);
      if (btnLocate) {
        btnLocate.addEventListener('click', function () {
          if (!navigator.geolocation) {
            setStatus('\u26A0\uFE0F Geolocation is not supported in this browser. Tap your building on the satellite view instead.', null);
            return;
          }
          btnLocate.textContent = '\u23F3 Tracking\u2026';
          follow = true;
          startGpsLive();
        });
      }

      /* follow-me toggle lives inside the switcher row if present */
      var btnFollow = $(opts.followBtnId || '');
      if (btnFollow) {
        btnFollow.classList.toggle('on', follow);
        btnFollow.addEventListener('click', function () {
          follow = !follow;
          btnFollow.classList.toggle('on', follow);
          if (follow) startGpsLive();
        });
      }

      /* ---- trace toolbar (optional) ---- */
      if (opts.trace) {
        var bar = $(opts.traceBarId || '');
        if (bar) {
          var btnTrace = $('traceToggle'), btnUndo = $('traceUndo'), btnClear = $('traceClear');
          if (btnTrace) btnTrace.addEventListener('click', function () {
            traceMode = !traceMode;
            btnTrace.classList.toggle('on', traceMode);
            btnTrace.textContent = traceMode ? '\u2713 Done tracing' : '\u2795 Trace the road';
            bar.classList.toggle('tracing', traceMode);
            if (traceMode) {
              userMovedMap = false;
              map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
            } else {
              saveTrace();
            }
          });
          if (btnUndo) btnUndo.addEventListener('click', function () {
            tracePts.pop();
            traceUndoStack.push(1);
            drawTrace();
          });
          if (btnClear) btnClear.addEventListener('click', function () {
            tracePts = []; traceUndoStack = []; drawTrace(); saveTrace();
          });
        }
      }

      /* restore an existing route into the trace editor */
      var existing = opts.existingRoute;
      if (existing && existing.length > 1) {
        tracePts = existing.map(function (pt) { return [Number(pt[0]), Number(pt[1])]; });
        drawTrace();
      }

      /* seed state */
      commit(initial.lat, initial.lng, hasSavedPin ? 'admin' : 'tapped');
      if (hasSavedPin) {
        paintCoords(initial.lat, initial.lng, '\uD83D\uDCCD <b>Saved pin restored.</b> Tap or drag to move it — live GPS stays on for refinement.', 'ok');
      }
      if (opts.startGps !== false && (!hasSavedPin || opts.startGps === true)) startGpsLive();

      setTimeout(function () { if (map) map.invalidateSize(); }, 320);
    }

    /* ---- trace helpers ---- */
    function addTraceVertex(ll) {
      tracePts.push([ll.lat, ll.lng]);
      traceUndoStack = [];
      drawTrace();
    }
    function drawTrace() {
      if (traceLine) { map.removeLayer(traceLine); traceLine = null; }
      if (tracePts.length > 1) {
        traceLine = L.polyline(tracePts, { color: '#F59E0B', weight: 4, opacity: 0.85, dashArray: '1 8', lineCap: 'round' }).addTo(map);
      }
      var n = $('traceCount');
      if (n) n.textContent = tracePts.length ? tracePts.length + ' pts' : '';
      if (traceMode && tracePts.length > 1) {
        map.fitBounds(traceLine.getBounds(), { padding: [30, 30] });
      }
    }
    function saveTrace() {
      if (tracePts.length < 2) return;
      var simple = geo.simplify(tracePts, 4);
      var km = geo.polylineKm(simple);
      var meta = {
        route: simple.map(function (p) { return [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]; }),
        route_src: opts.traceSource || 'traced',
        route_km: Number(km.toFixed(3)),
        route_min: geo.walkMinutes(km)
      };
      if (host.answers) {
        var ps = host.answers[PASSAGE_KEY] || {};
        ps.route = meta.route; ps.route_src = meta.route_src;
        ps.route_km = meta.route_km; ps.route_min = meta.route_min;
        host.answers[PASSAGE_KEY] = ps;
      }
      host.onPin(marker ? marker.getLatLng().lat : initial.lat, marker ? marker.getLatLng().lng : initial.lng,
        { route: meta.route, route_src: meta.route_src, route_km: meta.route_km, route_min: meta.route_min });
    }

    buildMap();
    if (typeof L === 'undefined') {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = buildMap;
      document.head.appendChild(s);
    }

    return {
      destroy: function () { stopGpsLive(); if (map) { try { map.remove(); } catch (e) {} } map = null; },
      stopGps: stopGpsLive,
      getRoute: function () { return tracePts.slice(); }
    };
  }

  /* ============================================================
     routeMap — read-only map for listing.html + live tracking
     ============================================================ */

  /* options:
       containerId  div id (required)
       lat/lng      property pin (required)
       campus       { lat, lng } origin marker (default KWASU gate)
       passage      normalised passage object (may carry a route)
       name         property name for popups
       trackable    render the "track me there" controls (default true)
   */
  function routeMap(opts) {
    if (!opts || !opts.containerId) return null;
    var dest = { lat: parseFloat(opts.lat), lng: parseFloat(opts.lng) };
    var origin = opts.campus || CAMPUS;
    var psg = passage.normalise(opts.passage) || { landmark: '', gate: '', floor: '', steps: [], route: [], route_src: '' };

    var map, layers = {};
    var walkLine, routeLine, trackDot, trackLine;
    var watchId = null, offRouteShown = false;
    var LEVEL = { mode: 'direct' }; /* direct | osrm | stored */

    function markerIcon(cls, label) {
      return L.divIcon({
        className: '',
        html: '<div class="route-marker ' + cls + '">' + label + '</div>',
        iconSize: [34, 34], iconAnchor: [17, 17]
      });
    }

    function build() {
      var el = $(opts.containerId);
      if (!el || typeof L === 'undefined') return;

      map = L.map(opts.containerId, { zoomControl: true, attributionControl: true, scrollWheelZoom: false })
        .setView([(dest.lat + origin.lat) / 2, (dest.lng + origin.lng) / 2], 15);

      layers.sat = L.tileLayer(TILE.sat.url, TILE.sat.opt).addTo(map);
      var switcher = document.querySelector('#' + opts.containerId + '-switcher');
      if (switcher) {
        switcher.querySelectorAll('.map-layer-btn').forEach(function (b) {
          b.addEventListener('click', function () {
            var k = b.dataset.layer;
            Object.keys(layers).forEach(function (key) { map.removeLayer(layers[key]); });
            layers = {};
            layers[k] = L.tileLayer(TILE[k].url, TILE[k].opt).addTo(map);
            switcher.querySelectorAll('.map-layer-btn').forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            if (routeLine) routeLine.bringToFront();
            if (walkLine) walkLine.bringToFront();
            if (trackDot) trackDot.bringToFront();
          });
        });
      }

      L.marker([origin.lat, origin.lng], { icon: markerIcon('origin', '\uD83C\uDFEB') }).addTo(map)
        .bindPopup('<b>KWASU main gate</b><br>Walking routes start here.');
      L.marker([dest.lat, dest.lng], { icon: markerIcon('dest', '\uD83C\uDFE0') }).addTo(map)
        .bindPopup('<b>' + esc(opts.name || 'This property') + '</b><br>' + esc(psg.gate || 'The gate of the compound.'));

      drawDirect();

      if (opts.trackable !== false) wireTrackControls();
    }

    /* ---- route layers, in fallback order ---- */
    function drawDirect() {
      LEVEL.mode = 'direct';
      routeLine = L.polyline([[origin.lat, origin.lng], [dest.lat, dest.lng]],
        { color: '#7C3AED', weight: 3, opacity: 0.75, dashArray: '6 8' }).addTo(map);
      var km = geo.haversineKm(origin.lat, origin.lng, dest.lat, dest.lng) * 1.25;
      setRouteMeta('\u2248 ' + (km >= 0.1 ? km.toFixed(1) + ' km' : Math.round(km * 1000) + ' m') +
        ' straight line', 'straight-line estimate');
    }

    function drawStored(route) {
      clearRouteLines();
      LEVEL.mode = 'stored';
      routeLine = L.polyline(route, { color: '#7C3AED', weight: 4, opacity: 0.9, lineCap: 'round' }).addTo(map);
      var km = geo.polylineKm(route);
      setRouteMeta(km >= 0.1 ? km.toFixed(1) + ' km' : Math.round(km * 1000) + ' m',
        psg.route_src === 'walk' ? 'recorded walk' : 'traced on the ground');
      map.fitBounds(routeLine.getBounds(), { padding: [26, 26] });
    }

    function drawOsrm(r) {
      clearRouteLines();
      LEVEL.mode = 'osrm';
      routeLine = L.polyline(r.pts, { color: '#7C3AED', weight: 4, opacity: 0.9, lineCap: 'round' }).addTo(map);
      setRouteMeta((r.km >= 0.1 ? r.km.toFixed(1) + ' km' : Math.round(r.km * 1000) + ' m') + ' · ' + r.min + ' min',
        'real roads, walking');
      map.fitBounds(routeLine.getBounds(), { padding: [26, 26] });
    }

    function clearRouteLines() {
      if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    }

    function setRouteMeta(main, sub) {
      var el = $(opts.containerId + '-routemeta');
      if (el) el.innerHTML = '<b>' + main + '</b> · ' + sub;
      var badge = $(opts.containerId + '-routebadge');
      if (badge) {
        badge.className = 'route-src-badge src-' + LEVEL.mode;
        badge.textContent = LEVEL.mode === 'stored' ? (psg.route_src === 'walk' ? '\uD83D\uDC63 recorded walk' : '\u2795 traced') :
                            LEVEL.mode === 'osrm' ? '\uD83D\uDEB6 road route' : '\uD83D\uDCD0 estimate';
      }
      var trackMeta = $(opts.containerId + '-trackmeta');
      if (trackMeta && LEVEL.mode !== 'direct') trackMeta.textContent = main + ' · ' + sub;
    }

    function fetchBestRoute() {
      if (psg.route && psg.route.length > 1) { drawStored(psg.route); return; }
      geo.footRoute([[origin.lat, origin.lng], [dest.lat, dest.lng]])
        .then(drawOsrm)
        .catch(function (err) {
          console.warn('[ArzuzMap] OSRM fallback to straight line:', err.message);
          /* drawDirect already visible — nothing to do */
        });
    }

    /* ---- live tracking ---- */
    function wireTrackControls() {
      var btn = $(opts.containerId + '-track');
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (watchId !== null) { stopTracking(); return; }
        if (!navigator.geolocation) {
          var b1 = $(opts.containerId + '-trackmeta');
          if (b1) b1.textContent = 'Live tracking is not supported in this browser.';
          return;
        }
        btn.classList.add('on');
        btn.innerHTML = '\u23F3 Tracking\u2026 tap to stop';
        watchId = navigator.geolocation.watchPosition(onTrack, onTrackError,
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 });
      });
    }

    function onTrack(pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var acc = pos.coords.accuracy || 999;

      if (!trackDot) {
        trackDot = L.circleMarker([lat, lng], {
          radius: 8, weight: 3, color: '#2563EB', fillColor: '#93C5FD', fillOpacity: 0.95, opacity: 1
        }).addTo(map).bindTooltip('You', { direction: 'top', className: 'map-tooltip' });
        if (routeLine) map.fitBounds(routeLine.getBounds().pad(0.15));
      } else {
        trackDot.setLatLng([lat, lng]);
      }

      /* trail of where the student has walked */
      if (!trackLine) {
        trackLine = L.polyline([[lat, lng]], { color: '#2563EB', weight: 3, opacity: 0.5, dashArray: '4 6' }).addTo(map);
      } else {
        trackLine.addLatLng([lat, lng]);
      }

      /* live remaining distance along the drawn route */
      var remKm;
      if (routeLine && LEVEL.mode !== 'direct') {
        var pts = routeLine.getLatLngs().map(function (p) { return [p.lat, p.lng]; });
        var bestI = 0, bestD = Infinity;
        for (var i = 0; i < pts.length; i++) {
          var d = geo.haversineKm(lat, lng, pts[i][0], pts[i][1]);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        var ahead = pts.slice(bestI);
        ahead.unshift([lat, lng]);
        remKm = geo.polylineKm(ahead);
        var offRouteM = geo.distToPolyline(lat, lng, pts) * 111320;
        if (offRouteM > 60 && !offRouteShown) {
          offRouteShown = true;
          toastTrack('You seem off the route — the line updates as you move. Keep the map open.');
        } else if (offRouteM <= 40) {
          offRouteShown = false;
        }
      } else {
        remKm = geo.haversineKm(lat, lng, dest.lat, dest.lng);
      }

      var meta = $(opts.containerId + '-trackmeta');
      if (meta) {
        meta.innerHTML = '\uD83D\uDC63 ' + (remKm >= 0.1 ? remKm.toFixed(2) + ' km' : Math.round(remKm * 1000) + ' m') +
          ' to go · \u00B1' + Math.round(acc) + ' m';
      }

      /* arrival */
      if (remKm < 0.03) {
        var arrived = $(opts.containerId + '-trackmeta');
        if (arrived) arrived.innerHTML = '\uD83C\uDF89 You have arrived — the gate should be right here.';
        stopTracking();
      }
    }

    function onTrackError(err) {
      console.warn('[ArzuzMap] track error:', err && err.message);
      var meta = $(opts.containerId + '-trackmeta');
      if (meta) meta.textContent = 'Tracking stopped: ' + (err && err.message || 'no fix');
      stopTracking();
    }

    function stopTracking() {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      var btn = $(opts.containerId + '-track');
      if (btn) { btn.classList.remove('on'); btn.innerHTML = '\uD83C\uDFAF Track me there'; }
      /* the trail stays visible until the page closes — it is this session's own path */
    }

    function toastTrack(msg) {
      if (window.ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(msg, 'info');
    }

    build();
    if (typeof L === 'undefined') {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = build;
      document.head.appendChild(s);
    }

    return {
      destroy: stopTracking,
      routeLevel: function () { return LEVEL.mode; },
      panTo: function (lat, lng, zoom) {
        if (map) map.setView([Number(lat), Number(lng)], zoom || 19, { animate: true });
        if (trackDot && trackDot.bringToFront) trackDot.bringToFront();
      }
    };
  }

  /* ============================================================
     passageEditor — form-engine step type + admin editor widget
     ============================================================ */

  /* Renders the passage capture block inside a step. Used by the form
     engine (app.js) and directly by admin.js. options:
       mountId     container div id (required)
       answers     object holding passage/pin (forms) — optional
       passage     existing passage object (admin) — optional
       pin         {lat,lng} of the property pin (admin) — optional
       miniMap     mount a small trace map below the fields (default false on mobile widths)
   */
  function passageEditor(opts) {
    if (!opts || !opts.mountId) return null;
    var mount = $(opts.mountId);
    if (!mount) return null;
    var state = opts.answers ? (opts.answers[PASSAGE_KEY] = opts.answers[PASSAGE_KEY] || {}) :
                               (opts.passage ? JSON.parse(JSON.stringify(opts.passage)) : {});
    var captured = passage.normalise(state) || { landmark: '', gate: '', floor: '', steps: [], route: [], route_src: '' };

    mount.innerHTML =
      '<div class="psg-editor">' +
        '<div class="psg-fld"><label for="psg_landmark">\uD83D\uDCCD A landmark everyone knows</label>' +
        '<input type="text" id="psg_landmark" maxlength="120" placeholder="e.g. Opposite the blue mosque, beside Sarafa cement shop" value="' + esc(captured.landmark) + '"></div>' +
        '<div class="psg-fld"><label for="psg_gate">\uD83D\uDEAA At the gate</label>' +
        '<input type="text" id="psg_gate" maxlength="120" placeholder="e.g. Brown double gate with a small green door beside it" value="' + esc(captured.gate) + '"></div>' +
        '<div class="psg-fld"><label for="psg_floor">\uD83E\uDE9C Stairs / floor</label>' +
        '<input type="text" id="psg_floor" maxlength="120" placeholder="e.g. Ground floor, walk past the tap; or first floor, stairs at the back" value="' + esc(captured.floor) + '"></div>' +
        '<div class="psg-steps"><label>Walk-in steps <small>one line each, in order</small></label>' +
        '<div id="psgStepsList"></div>' +
        '<button type="button" class="psg-add" id="psgAddStep">\u2795 Add a step</button></div>' +
        (opts.miniMap ?
          '<div class="psg-minimap-wrap"><label>\uD83D\uDDFA Trace the road from the main road to the gate <small>optional — helps students see the exact path</small></label>' +
          '<div class="psg-minimap" id="psgMiniMap"></div>' +
          '<div class="psg-minimap-toolbar"><button type="button" class="psg-tool" id="psgTraceToggle">\u2795 Trace</button>' +
          '<button type="button" class="psg-tool" id="psgTraceUndo">\u21A9 Undo</button>' +
          '<button type="button" class="psg-tool" id="psgTraceClear">\uD83D\uDDF4 Clear</button>' +
          '<span class="psg-count" id="psgTraceCount"></span></div></div>' : '') +
      '</div>';

    var mini = null;
    var stepsList = $('psgStepsList');

    function stepRow(text, lat, lng) {
      var wrap = document.createElement('div');
      wrap.className = 'psg-step-row';
      var num = document.createElement('span');
      num.className = 'psg-step-num';
      var inp = document.createElement('input');
      inp.type = 'text'; inp.maxLength = 160;
      inp.placeholder = 'e.g. Enter the gate, take the path on the right';
      inp.value = text || '';
      inp.addEventListener('input', sync);
      var pinBtn = document.createElement('button');
      pinBtn.type = 'button'; pinBtn.className = 'psg-step-pin';
      pinBtn.title = 'Attach this step to a spot on the map';
      pinBtn.textContent = '\uD83D\uDCCD';
      pinBtn.addEventListener('click', function () {
        pinBtn.classList.toggle('on');
        if (pinBtn.classList.contains('on') && mini) {
          toast('Tap the mini map to drop this step\'s marker.');
          pendingStepPin = wrap;
        } else if (!pinBtn.classList.contains('on')) {
          pendingStepPin = null;
        } else {
          toast('The mini map is still loading — try again in a moment.');
        }
        sync();
      });
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'psg-step-del';
      del.innerHTML = '\u2715';
      del.title = 'Remove step';
      del.addEventListener('click', function () { wrap.remove(); renumber(); sync(); });
      wrap.appendChild(num); wrap.appendChild(inp); wrap.appendChild(pinBtn); wrap.appendChild(del);
      if (isFinite(Number(lat)) && isFinite(Number(lng))) {
        wrap.dataset.lat = Number(lat); wrap.dataset.lng = Number(lng);
        pinBtn.classList.add('on');
      }
      return wrap;
    }

    var pendingStepPin = null;

    function renumber() {
      var rows = stepsList.querySelectorAll('.psg-step-row');
      rows.forEach(function (r, i) { r.querySelector('.psg-step-num').textContent = String(i + 1); });
    }

    function sync() {
      var rows = stepsList.querySelectorAll('.psg-step-row');
      var steps = [];
      rows.forEach(function (r) {
        var t = r.querySelector('input').value.trim();
        if (!t) return;
        var st = { text: t };
        if (r.dataset.lat && r.dataset.lng) { st.lat = Number(r.dataset.lat); st.lng = Number(r.dataset.lng); }
        steps.push(st);
      });
      state.landmark = $('psg_landmark').value.trim();
      state.gate = $('psg_gate').value.trim();
      state.floor = $('psg_floor').value.trim();
      state.steps = steps;
      if (opts.answers) opts.answers[PASSAGE_KEY] = state;
      if (opts.onChange) opts.onChange(state);
    }

    function initMiniMap() {
      if (!opts.miniMap || typeof L === 'undefined') return;
      var centre = opts.pin ? [Number(opts.pin.lat) || MALETE[0], Number(opts.pin.lng) || MALETE[1]] : MALETE;
      var mm = L.map('psgMiniMap', {
        zoomControl: true, attributionControl: false, scrollWheelZoom: false, dragging: true
      }).setView(centre, 18);
      L.tileLayer(TILE.sat.url, TILE.sat.opt).addTo(mm);
      if (opts.pin) {
        L.marker([Number(opts.pin.lat), Number(opts.pin.lng)], {
          icon: L.divIcon({ className: '', html: '<div class="map-pin-custom"><div class="map-pin-ring"></div><div class="map-pin-dot"></div></div>',
            iconSize: [32, 42], iconAnchor: [16, 42] })
        }).addTo(mm);
      }
      if (captured.route && captured.route.length > 1) {
        L.polyline(captured.route, { color: '#F59E0B', weight: 4, opacity: 0.85 }).addTo(mm);
        mm.fitBounds(L.polyline(captured.route).getBounds(), { padding: [20, 20] });
      }
      var pts = (captured.route || []).slice();
      var line = null;
      function redraw() {
        if (line) { mm.removeLayer(line); line = null; }
        if (pts.length > 1) {
          line = L.polyline(pts, { color: '#F59E0B', weight: 4, opacity: 0.85, dashArray: '1 8', lineCap: 'round' }).addTo(mm);
        }
        var n = $('psgTraceCount');
        if (n) n.textContent = pts.length ? pts.length + ' pts' : '';
      }
      var tracing = false;
      var btnT = $('psgTraceToggle'), btnU = $('psgTraceUndo'), btnC = $('psgTraceClear');
      if (btnT) btnT.addEventListener('click', function () {
        tracing = !tracing;
        btnT.classList.toggle('on', tracing);
        btnT.textContent = tracing ? '\u2713 Done' : '\u2795 Trace';
      });
      if (btnU) btnU.addEventListener('click', function () { pts.pop(); redraw(); store(); });
      if (btnC) btnC.addEventListener('click', function () { pts = []; redraw(); store(); });
      mm.on('click', function (e) {
        if (pendingStepPin) {
          pendingStepPin.dataset.lat = e.latlng.lat;
          pendingStepPin.dataset.lng = e.latlng.lng;
          pendingStepPin.querySelector('.psg-step-pin').classList.add('on');
          pendingStepPin = null;
          sync();
          return;
        }
        if (!tracing) return;
        pts.push([e.latlng.lat, e.latlng.lng]);
        redraw();
        store();
      });
      function store() {
        if (pts.length >= 2) {
          var simple = geo.simplify(pts, 4);
          var km = geo.polylineKm(simple);
          state.route = simple.map(function (p) { return [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]; });
          state.route_src = 'traced';
          state.route_km = Number(km.toFixed(3));
          state.route_min = geo.walkMinutes(km);
        } else {
          delete state.route; delete state.route_src; delete state.route_km; delete state.route_min;
        }
        if (opts.answers) opts.answers[PASSAGE_KEY] = state;
        if (opts.onChange) opts.onChange(state);
      }
      redraw();
      mini = mm;
      setTimeout(function () { if (mini) mini.invalidateSize(); }, 250);
    }

    /* restore existing steps */
    captured.steps.forEach(function (s) { stepsList.appendChild(stepRow(s.text, s.lat, s.lng)); });
    renumber();

    $('psgAddStep').addEventListener('click', function () {
      stepsList.appendChild(stepRow(''));
      renumber();
      var rows = stepsList.querySelectorAll('.psg-step-row input');
      if (rows.length) rows[rows.length - 1].focus();
    });
    mount.querySelectorAll('.psg-editor input[type="text"]').forEach(function (inp) {
      inp.addEventListener('input', sync);
    });
    initMiniMap();

    return {
      get: function () { sync(); return state; },
      destroy: function () { if (mini) { try { mini.remove(); } catch (e) {} } mini = null; }
    };
  }

  /* ---------- public surface ---------- */

  return {
    MALETE: MALETE,
    CAMPUS: CAMPUS,
    PASSAGE_KEY: PASSAGE_KEY,
    TILE: TILE,
    geo: geo,
    passage: passage,
    pinCapture: pinCapture,
    routeMap: routeMap,
    passageEditor: passageEditor
  };

})();
