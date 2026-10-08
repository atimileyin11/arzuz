/* ============================================================
   Arzuz — complete-listing page logic

   The person holding an invite link lands here. No login: the
   secret token in the URL (?ref=…) is the only key, and it is
   validated server-side by the security-definer RPCs created
   in supabase-drafts-support.sql. The page can read and update
   exactly ONE draft listing — nothing else — and loses access
   the moment the admin approves the apartment.

   Preview behaviour: with Supabase unconfigured (local preview)
   the page loads an empty form and simulates a save, mirroring
   the offline behaviour of the site's other forms.
   ============================================================ */

(function () {
  'use strict';

  var cfg = window.ARZUZ_CONFIG || {};
  var TOKEN = '';
  var draft = null;          // row returned by listing_draft_get
  var MEDIA = [];            // [{type:'image'|'video', url, label, credit}]
  var pinCapture = null;
  var passageEditor = null;
  var pinMeta = null;
  var pin = { lat: null, lng: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function cfgured() { return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY); }

  function q(name) {
    var m = new RegExp('[?&]' + name + '=([^&]+)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = (c === 'x') ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  function rpc(name, args) {
    var key = cfg.SUPABASE_ANON_KEY;
    var headers = { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key };
    if (key && key.indexOf('sb_publishable') === 0) headers['sb-anon-key'] = key;
    return fetch(cfg.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers, body: JSON.stringify(args || {})
    }).then(function (r) {
      if (!r.ok) throw new Error('Supabase RPC failed (HTTP ' + r.status + ')');
      return r.json();
    });
  }

  function show(which) {
    $('clLoading').style.display = which === 'loading' ? '' : 'none';
    $('clDead').style.display = which === 'dead' ? '' : 'none';
    $('clDone').style.display = which === 'done' ? '' : 'none';
    $('clForm').style.display = which === 'form' ? '' : 'none';
    window.scrollTo(0, 0);
  }

  function failState(msg) {
    show('dead');
    if (window.console) console.warn('[complete-listing]', msg);
  }

  function credit() {
    return { holder: 'Arzuz', year: new Date().getFullYear(), note: 'Verified apartment media' };
  }

  /* ---------------- populate the form from a draft row ---------------- */

  function fillAmenities(selected) {
    var host = $('clAmenities');
    var list = (typeof UTILITIES !== 'undefined' && UTILITIES.length) ? UTILITIES
      : (typeof _DEFAULT_UTILITIES !== 'undefined' ? _DEFAULT_UTILITIES : []);
    host.innerHTML = list.map(function (u) {
      var on = (selected || []).indexOf(u) !== -1;
      return '<label class="cl-chip' + (on ? ' on' : '') + '"><input type="checkbox" value="' + esc(u) + '"' + (on ? ' checked' : '') + '><span>' + (on ? '✓ ' : '') + esc(u) + '</span></label>';
    }).join('') || '<span class="cl-status">No amenity list available.</span>';
  }

  function fillForm(p) {
    $('cl_prop_name').value = p.prop_name || '';
    var ty = $('cl_ty');
    if (typeof PROPERTY_TYPES !== 'undefined') {
      ty.innerHTML = PROPERTY_TYPES.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    }
    if (p.ty) ty.value = p.ty;
    $('cl_ar').value = p.ar || '';
    $('cl_rent').value = p.rent || '';
    $('cl_rm').value = p.rm || '';
    $('cl_neg').value = p.neg || '';
    $('cl_desc').value = p.desc || p.description || '';
    $('cl_nm').value = p.nm || '';
    $('cl_last').value = p.last || '';
    $('cl_ph').value = p.ph || '';
    $('cl_who').value = p.who || '';
    $('cl_split_ok').checked = p.split_ok === true || p.split_ok === 'yes';
    fillAmenities(Array.isArray(p.ut) ? p.ut : (p.ut ? String(p.ut).split(',') : []));

    /* media */
    MEDIA = [];
    if (Array.isArray(p.media)) {
      p.media.forEach(function (m) { if (m && m.url) MEDIA.push({ type: m.type === 'video' ? 'video' : 'image', url: String(m.url), label: m.label || '', credit: m.credit || credit() }); });
    }
    if (!MEDIA.length && p.photo) MEDIA.push({ type: 'image', url: p.photo, label: 'Cover photo', credit: credit() });
    if (!MEDIA.some(function (m) { return m.type === 'video'; }) && (p.video || p.video_url)) {
      MEDIA.push({ type: 'video', url: p.video || p.video_url, label: 'Video tour', credit: credit() });
    }
    renderGallery();

    /* map + passage */
    var lat = parseFloat(p.lat), lng = parseFloat(p.lng);
    if (isFinite(lat) && isFinite(lng)) { pin = { lat: lat, lng: lng }; pinMeta = p.pin_meta || null; }
    initMap();
    if (typeof ArzuzMap !== 'undefined') {
      passageEditor = ArzuzMap.passageEditor({
        mountId: 'clPassageMount', answers: null, passage: p.passage || null,
        miniMap: true, pin: (isFinite(lat) && isFinite(lng)) ? { lat: lat, lng: lng } : null, onChange: null
      });
    }
  }

  /* ---------------- map ---------------- */

  function initMap() {
    if (typeof ArzuzMap === 'undefined') return;
    if (pinCapture) { try { pinCapture.destroy(); } catch (e) {} pinCapture = null; }
    pinCapture = ArzuzMap.pinCapture({
      containerId: 'cl-map',
      layerSwitchId: 'clMapLayerSwitcher',
      coordsBadgeId: 'clMapCoords',
      locateBtnId: 'clBtnGps',
      statusBoxId: 'clMapStatus',
      tipBannerId: null,
      startGps: false,
      trace: false,
      lat: pin.lat, lng: pin.lng,
      onPin: function (lat, lng, meta) {
        pin = { lat: lat, lng: lng };
        pinMeta = meta;
        var badge = $('clMapCoords');
        if (badge) { badge.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5); badge.classList.add('set'); }
      }
    });
  }

  /* ---------------- gallery ---------------- */

  function renderGallery() {
    var grid = $('clGallery');
    if (!grid) return;
    if (!MEDIA.length) { grid.innerHTML = ''; return; }
    var firstImg = MEDIA.filter(function (m) { return m.type === 'image'; })[0];
    grid.innerHTML = MEDIA.map(function (m, i) {
      var isYT = window.ArzuzVideo && ArzuzVideo.parseYouTube(m.url);
      var thumb = m.type === 'video'
        ? (isYT ? '<img src="' + esc(ArzuzVideo.thumb(m.url)) + '" alt="" loading="lazy">' : '<video src="' + esc(m.url) + '" muted preload="metadata"></video>') + '<span class="kind">🎥 tour</span>'
        : '<img src="' + esc(m.url) + '" alt="" loading="lazy">' + (m === firstImg ? '<span class="cover-tag">Cover</span>' : '');
      var mkCover = (m.type === 'image' && m !== firstImg)
        ? '<button type="button" data-gal="cover" data-i="' + i + '">★ Make cover</button>' : '';
      return '<div class="cl-th">' + thumb + '<button type="button" data-gal="del" data-i="' + i + '">✕ Remove</button>' + mkCover + '</div>';
    }).join('');
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-gal]') : null;
    if (!b) return;
    var i = parseInt(b.dataset.i, 10);
    if (isNaN(i) || !MEDIA[i]) return;
    if (b.dataset.gal === 'del') MEDIA.splice(i, 1);
    else if (b.dataset.gal === 'cover') { var m = MEDIA.splice(i, 1)[0]; MEDIA.unshift(m); }
    else return;
    renderGallery();
  });

  /* Signed Cloudinary upload — used for photos, and as the
     fallback when YouTube cannot take a video tour. */
  function cloudinaryUpload(file, kind, st) {
    return fetch('/api/cloudinary-sign', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('Could not get upload signature (HTTP ' + r.status + ')'); return r.json(); })
      .then(function (sig) {
        if (st) st.textContent = '📤 Uploading ' + (kind === 'video' ? 'video tour' : 'photos') + '…';
        var fd = new FormData();
        fd.append('file', file);
        fd.append('api_key', sig.api_key);
        fd.append('timestamp', sig.timestamp);
        fd.append('signature', sig.signature);
        fd.append('folder', sig.folder);
        fd.append('eager', sig.eager);
        if (sig.max_file_size) fd.append('max_file_size', sig.max_file_size);
        if (sig.context) fd.append('context', sig.context);
        var endpoint = 'https://api.cloudinary.com/v1_1/' + sig.cloud_name + '/' + (kind === 'video' ? 'video' : 'image') + '/upload';
        return fetch(endpoint, { method: 'POST', body: fd }).then(function (res) {
          if (!res.ok) return res.text().then(function (t) { throw new Error('Cloudinary: ' + t); });
          return res.json();
        });
      })
      .then(function (data) {
        if (st) st.textContent = '✅ Uploaded!';
        MEDIA.push({ type: kind === 'video' ? 'video' : 'image', url: data.secure_url, label: '', credit: credit() });
        renderGallery();
      })
      .catch(function (err) {
        if (st) st.textContent = '❌ Upload failed: ' + err.message;
      });
  }

  function uploadFile(file, kind) {
    var st = $('clUploadStatus');
    if (st) { st.textContent = '⏳ Preparing upload of ' + file.name + '…'; }
    /* video tours stream straight to YouTube (unlisted) with a
       live progress bar; Cloudinary is the fallback path */
    if (kind === 'video' && window.ArzuzVideo && file.size <= ArzuzVideo.MAX_BYTES) {
      return ArzuzVideo.uploadVideoToYouTube(file, {
        onProgress: function (p) {
          if (!st) return;
          if (p.phase === 'uploading') st.innerHTML = '📤 ' + ArzuzVideo.progressHTML(p);
          else if (p.phase === 'processing') st.textContent = '🎬 Uploaded — processing video…';
          else st.textContent = '⏳ Preparing upload of ' + file.name + '…';
        },
      }).then(function (url) {
        if (st) st.textContent = '✅ Uploaded!';
        MEDIA.push({ type: 'video', url: url, label: '', credit: credit() });
        renderGallery();
      }).catch(function (err) {
        console.warn('[Arzuz] YouTube upload unavailable, falling back to Cloudinary:', err.message);
        return cloudinaryUpload(file, 'video', st);
      });
    }
    return cloudinaryUpload(file, kind, st);
  }

  /* ---------------- collect + save ---------------- */

  function selectedAmenities() {
    var out = [];
    document.querySelectorAll('#clAmenities input[type=checkbox]:checked').forEach(function (ck) { out.push(ck.value); });
    return out;
  }

  function collectPatch() {
    var p = {};
    p.prop_name = $('cl_prop_name').value.trim();
    p.ty = $('cl_ty').value || '';
    p.ar = $('cl_ar').value.trim();
    p.rent = $('cl_rent').value.trim();
    p.rm = $('cl_rm').value.trim();
    p.neg = $('cl_neg').value;
    p.who = $('cl_who').value;
    p.desc = $('cl_desc').value.trim();
    p.nm = $('cl_nm').value.trim();
    p.last = $('cl_last').value.trim();
    p.ph = $('cl_ph').value.trim();
    p.split_ok = $('cl_split_ok').checked;
    p.ut = selectedAmenities();
    p.utilities = p.ut.slice();
    p.media = MEDIA.map(function (m) { return { type: m.type, url: m.url, label: m.label || '', credit: m.credit || credit() }; });
    var cover = MEDIA.filter(function (m) { return m.type === 'image'; })[0];
    var tour = MEDIA.filter(function (m) { return m.type === 'video'; })[0];
    p.photo = cover ? cover.url : '';
    p.video = tour ? tour.url : '';
    p.video_url = p.video;
    if (pin.lat != null && pin.lng != null) {
      p.lat = String(pin.lat);
      p.lng = String(pin.lng);
      p.pin = pin.lat.toFixed(6) + ',' + pin.lng.toFixed(6);
      if (pinMeta) p.pin_meta = pinMeta;
    }
    if (passageEditor) {
      var psg = passageEditor.get();
      if (typeof ArzuzMap !== 'undefined' && ArzuzMap.passage.hasContent(psg)) p.passage = psg;
    }
    return p;
  }

  function notifyTeam(p) {
    /* Telegram alert through the existing server-side formatter.
       Failure never blocks the save — the dashboard already shows
       the draft the moment it was created. */
    try {
      return fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send', table: 'draft_completed',
          payload: { prop_name: p.prop_name, ar: p.ar, ty: p.ty, rent: p.rent, ph: p.ph }
        })
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  function save() {
    var btn = $('clSave');
    var err = $('clError');
    err.style.display = 'none';
    var p = collectPatch();
    if (!p.prop_name && !p.ar) {
      err.textContent = 'Write at least the apartment name or the area so the team knows what this is.';
      err.style.display = 'block';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';

    var finish = function () {
      if (window.ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast('Sent to Arzuz — thank you!', 'success');
      show('done');
    };

    var run;
    if (!cfgured() || !TOKEN) {
      /* local preview / no token: simulate the round-trip */
      run = new Promise(function (res) { setTimeout(res, 900); });
    } else {
      run = rpc('listing_draft_update', { p_token: TOKEN, p_patch: p }).then(function (out) {
        if (!out || !out.id) throw new Error('This link is no longer valid.');
      });
    }
    run.then(function () { notifyTeam(p); finish(); })
      .catch(function (e) {
        err.textContent = 'Could not save: ' + e.message;
        err.style.display = 'block';
      })
      .then(function () { btn.disabled = false; btn.textContent = '✅ Send to Arzuz'; });
  }

  /* ---------------- load ---------------- */

  function load() {
    TOKEN = q('ref');
    if (!cfgured()) {
      /* preview mode — no Supabase configured */
      var note = document.createElement('div');
      note.className = 'cl-note';
      note.textContent = 'Preview mode: Supabase is not configured here, so the form loads empty and saving is simulated.';
      $('clForm').insertBefore(note, $('clForm').firstChild);
      show('form');
      fillForm({});
      return;
    }
    if (!TOKEN) { failState('No ref token in the URL'); return; }
    rpc('listing_draft_get', { p_token: TOKEN })
      .then(function (row) {
        if (!row || !row.id) { failState('Token rejected or draft already approved'); return; }
        draft = row;
        show('form');
        fillForm(row.payload || {});
        if (row.draft_completed_at) {
          var when = new Date(row.draft_completed_at);
          $('clSavedNote').innerHTML = '<div class="cl-saved">✅ You sent this on ' +
            (isNaN(when) ? '' : when.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) +
            '. It is still editable until Arzuz approves it.</div>';
          $('clTitle').textContent = 'Adjust your apartment';
        }
      })
      .catch(function (e) { failState(e.message); });
  }

  /* ---------------- boot ---------------- */

  $('clSave').addEventListener('click', save);
  $('clBackToForm').addEventListener('click', function () { show('form'); });

  var pz = $('clPhotoZone'), pi = $('clPhotoInput');
  if (pz && pi) {
    pz.addEventListener('click', function () { pi.click(); });
    pi.addEventListener('change', function () {
      var files = pi.files || [];
      for (var i = 0; i < files.length; i++) uploadFile(files[i], 'image');
      pi.value = '';
    });
  }
  var vz = $('clVideoZone'), vi = $('clVideoInput');
  if (vz && vi) {
    vz.addEventListener('click', function () { vi.click(); });
    vi.addEventListener('change', function () {
      if (vi.files && vi.files[0]) uploadFile(vi.files[0], 'video');
      vi.value = '';
    });
  }

  if (typeof ArzuzData !== 'undefined' && ArzuzData.ready) {
    ArzuzData.ready.then(function () { if (draft) fillAmenities(Array.isArray(draft.payload && draft.payload.ut) ? draft.payload.ut : []); })
      .catch(function () {});
  }

  load();
})();
