/* ============================================================
   Arzuz — complete-listing page logic

   The person holding an invite link lands here. No login: the
   secret token in the URL (?ref=…) is the only key, and it is
   validated server-side by the security-definer RPCs created
   in supabase-drafts-support.sql. The page can read and update
   exactly ONE draft listing — nothing else — and loses access
   the moment the admin approves the apartment.

   This page deliberately mirrors the admin "Add / Edit
   Apartment" composer: the same three tabs, the same field set
   (apartment name optional + auto title, rent + opening ask,
   availability toggle with a unit count, contact person + role,
   amenity tag input, ONE map with a Pin / Draw-path switch, one
   access-notes box, a staged media grid with cover + remove and
   a real percentage per file) and the same exit triad — save to
   draft, discard, keep editing. Same components, one vocabulary,
   so a landlord filling this in and an admin fixing it up are
   looking at the same form.

   Preview behaviour: with Supabase unconfigured (local preview)
   the page loads an empty form and simulates a save, mirroring
   the offline behaviour of the site's other forms.
   ============================================================ */

(function () {
  'use strict';

  var cfg = window.ARZUZ_CONFIG || {};
  var TOKEN = '';
  var VIEW_ONLY = false;     // the link holder may read but not write
  var draft = null;          // row returned by listing_draft_get
  var MEDIA = [];            // committed [{type:'image'|'video', url, label, credit}]
  var STAGE = [];            // uploads still in flight [{id, type, preview, status, pct}]
  var pinCapture = null;
  var mapReady = false;
  var segAvail = null;
  var segMap = null;
  var tagField = null;
  var pin = { lat: null, lng: null };
  var pinMeta = null;
  var storedPassage = null;  // what Arzuz already holds, so a re-save never wipes it
  var storedName = 'This apartment';
  var dirty = false;
  var TABS = null;

  var CONTACT_ROLES = ['Landlord', 'Caretaker', 'Agent', 'Admin'];

  /* old rows asked "who runs the compound?" — map those answers onto
     the role vocabulary so a legacy draft still opens correctly */
  var LEGACY_WHO = {
    'I do, myself': 'Landlord', 'The owner': 'Landlord', 'A landlord': 'Landlord',
    'A caretaker': 'Caretaker', 'A caretaker / security': 'Caretaker',
    'An agent': 'Agent', 'Nobody yet': 'Admin'
  };

  function $(id) { return document.getElementById(id); }
  function str(s) { return s === null || s === undefined ? '' : String(s); }
  function esc(s) {
    return str(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function cfgured() { return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY); }
  function toast(msg, type) {
    if (window.ArzuzSubmit && ArzuzSubmit.showToast) ArzuzSubmit.showToast(msg, type || 'info');
  }

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

  /* ---------------- unsaved-changes state ---------------- */

  function markDirty() {
    if (VIEW_ONLY) return;
    dirty = true;
    var b = $('clDiscard');
    if (b) b.disabled = false;
  }

  function markClean() {
    dirty = false;
    var b = $('clDiscard');
    if (b) b.disabled = true;
  }

  function setNote(el, msg, kind) {
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.className = kind === 'ok' ? 'cl-ok' : 'cl-err';
    el.textContent = msg;
    el.style.display = 'block';
  }

  /* ---------------- view-only / expiry note ----------------
     The permission and the expiry are decided in the dashboard and
     enforced server-side by listing_draft_get / listing_draft_update.
     This only renders the consequence: a reader gets a read-only page,
     an editor gets told when their link stops working. */

  function permNote(row) {
    var host = $('clPermNote');
    if (!host) return;
    var until = '';
    if (row && row.draft_expires_at) {
      var t = new Date(row.draft_expires_at);
      if (!isNaN(t)) {
        until = t.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
    }
    if (VIEW_ONLY) {
      host.innerHTML = '<div class="cl-perm"><b>View only</b>This link is for checking what Arzuz recorded, so the fields are locked.' +
        (until ? ' It can be opened until ' + esc(until) + '.' : '') +
        ' Need to make a change? Add it in a WhatsApp message to the Arzuz team.</div>';
      return;
    }
    host.innerHTML = until
      ? '<div class="cl-perm"><b>Your link expires ' + esc(until) + '</b>You can come back and change these details until then — or until Arzuz approves the apartment, whichever comes first.</div>'
      : '';
  }

  function lockForm() {
    document.body.classList.add('cl-view-only');
    document.querySelectorAll('#clFormEl input, #clFormEl select, #clFormEl textarea').forEach(function (el) {
      el.disabled = true;
      el.setAttribute('aria-disabled', 'true');
    });
    ['clSave', 'clSaveDraft', 'clDiscard'].forEach(function (id) {
      var b = $(id);
      if (b) b.style.display = 'none';
    });
    /* "will be saved as fully occupied" is an instruction to a filler-in,
       not copy for someone reading a finished listing */
    var unitsNote = $('clUnitsNote');
    if (unitsNote) unitsNote.hidden = true;
    var gps = $('clBtnGps');
    if (gps) gps.style.display = 'none';
    /* the map is a picture now: show what was recorded instead of an
       instruction the reader cannot follow */
    var badge = $('clMapCoords');
    if (badge) {
      badge.textContent = (pin.lat != null && pin.lng != null)
        ? '📍 ' + pin.lat.toFixed(5) + ', ' + pin.lng.toFixed(5)
        : '📍 No pin recorded for this apartment yet.';
      badge.classList.toggle('set', pin.lat != null && pin.lng != null);
    }
    var status = $('clMapStatus');
    if (status) status.textContent = (pin.lat != null && pin.lng != null)
      ? 'The team pinned this gate on the map.'
      : '';
    var label = $('clMapLabel');
    if (label) label.innerHTML = '📍 Map — the gate' + (storedPassage && storedPassage.route && storedPassage.route.length > 1 ? ' and the walk-in path' : '');
  }

  /* ---------------- three tabs ----------------
     Only the active panel is rendered; the panels stay in the DOM so
     the collectors keep working. The hook is how the Leaflet map
     avoids being built inside a hidden (display:none) container. */

  var TAB_HOOKS = { specs: null, location: null, media: null };

  function initTabs() {
    var scope = $('clForm');
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;
    var tabs = scope.querySelectorAll('[data-cl-tab]');
    var panels = scope.querySelectorAll('[data-cl-panel]');
    if (!tabs.length || !panels.length) return null;

    function activate(key) {
      var found = false;
      Array.prototype.forEach.call(tabs, function (t) {
        var on = t.getAttribute('data-cl-tab') === key;
        if (on) found = true;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (!found) return;
      Array.prototype.forEach.call(panels, function (p) {
        if (p.getAttribute('data-cl-panel') === key) p.removeAttribute('hidden');
        else p.setAttribute('hidden', 'hidden');
      });
      var fn = TAB_HOOKS[key];
      if (fn) { try { fn(); } catch (e) { if (window.console) console.warn('[complete-listing] tab hook', e && e.message); } }
    }

    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener('click', function () { activate(t.getAttribute('data-cl-tab')); });
    });
    activate(tabs[0].getAttribute('data-cl-tab') || 'specs');
    return activate;
  }

  /* ---------------- segmented control (data-seg carries the value) ---------------- */

  function initSeg(segId, onChange) {
    var seg = $(segId);
    if (!seg || typeof seg.querySelectorAll !== 'function') return null;
    var btns = seg.querySelectorAll('.cl-seg-btn');
    if (!btns.length) return null;
    var value = null;

    function apply(v, fire) {
      value = v;
      Array.prototype.forEach.call(btns, function (b) {
        var on = b.getAttribute('data-seg') === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (fire && onChange) onChange(v);
    }

    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () { apply(b.getAttribute('data-seg'), true); });
    });
    apply(btns[0].getAttribute('data-seg'), false);

    return {
      get: function () { return value; },
      set: function (v) { apply(v, true); },
      setSilent: function (v) { apply(v, false); }
    };
  }

  /* ---------------- amenity combobox / tag input ----------------
     Presets come from the shared UTILITIES list (data.js merges the
     defaults with the amenity table in Supabase). Anything typed that
     is not on the list becomes a custom tag on this listing only. */

  function initTagField(opts) {
    var field = $(opts.fieldId), box = $(opts.chipsId), input = $(opts.inputId), menu = $(opts.suggestId);
    if (!field || !box || !input) return null;
    var selected = (opts.value || []).slice();
    var hi = -1;
    /* one typed word can otherwise be a paragraph inside a chip */
    var MAX_TAG = 60;

    /* "24/7  💧  water" and "24/7 💧 water" are the same amenity */
    function norm(name) { return str(name).trim().replace(/\s+/g, ' ').toLowerCase(); }

    function presets() {
      var list = (typeof UTILITIES !== 'undefined' && UTILITIES && UTILITIES.length) ? UTILITIES
        : (typeof _DEFAULT_UTILITIES !== 'undefined' ? _DEFAULT_UTILITIES : []);
      return list.map(function (u) { return str(u); }).filter(Boolean);
    }
    function has(name) {
      var n = norm(name);
      return selected.some(function (x) { return norm(x) === n; });
    }
    function isCustom(name) {
      var n = norm(name);
      return !presets().some(function (p) { return norm(p) === n; });
    }
    function matchesFor(qq) {
      var query = str(qq).trim().toLowerCase();
      var out = [];
      presets().concat(selected).forEach(function (u) {
        var name = str(u);
        if (!name || has(name)) return;
        if (query && name.toLowerCase().indexOf(query) === -1) return;
        if (out.some(function (x) { return x.toLowerCase() === name.toLowerCase(); })) return;
        out.push(name);
      });
      return out.slice(0, 40);
    }
    function sync() {
      if (opts.hiddenId && $(opts.hiddenId)) $(opts.hiddenId).value = JSON.stringify(selected);
      if (opts.onChange) opts.onChange(selected.slice());
    }
    function paintChips() {
      box.innerHTML = selected.map(function (u, i) {
        return '<span class="cl-tag' + (isCustom(u) ? ' custom' : '') + '">' +
          '<span>' + esc(u) + '</span>' +
          '<button type="button" data-tag-remove="' + i + '" title="Remove ' + esc(u) + '" aria-label="Remove ' + esc(u) + '">✕</button>' +
          '</span>';
      }).join('');
    }
    function paintMenu(open) {
      if (!menu) return;
      var v = str(input.value).trim();
      var hits = matchesFor(v);
      var html = hits.slice(0, 8).map(function (u, i) {
        return '<button type="button" role="option" data-tag-pick="' + esc(u) + '"' + (i === hi ? ' class="hi"' : '') + '>' + esc(u) + '</button>';
      }).join('');
      if (v && !has(v) && !hits.some(function (h) { return h.toLowerCase() === v.toLowerCase(); })) {
        html += '<button type="button" role="option" class="cl-new" data-tag-pick="' + esc(v) + '">Create “' + esc(v) + '”</button>';
      }
      if (!html) html = '<button type="button" disabled class="cl-none" style="cursor:default">' + (v ? 'Nothing matches.' : 'All presets are already on this listing.') + '</button>';
      menu.innerHTML = html;
      menu.classList.toggle('open', !!open);
      input.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function add(name) {
      var n = str(name).trim().replace(/\s+/g, ' ');
      if (n.length > MAX_TAG) {
        n = n.slice(0, MAX_TAG);
        toast('Amenity names are capped at ' + MAX_TAG + ' characters.', 'info');
      }
      if (n && !has(n)) { selected.push(n); markDirty(); }
      input.value = '';
      hi = -1;
      paintChips(); sync(); paintMenu(true);
    }
    function removeAt(i) {
      if (i < 0 || i >= selected.length) return;
      selected.splice(i, 1);
      markDirty();
      paintChips(); sync(); paintMenu(true);
    }

    field.addEventListener('click', function (e) {
      var x = e.target && e.target.closest ? e.target.closest('[data-tag-remove]') : null;
      if (x) { removeAt(parseInt(x.getAttribute('data-tag-remove'), 10)); return; }
      if (e.target === field || e.target === box) input.focus();
    });
    if (menu) {
      /* keep the input focused so the click lands before the menu closes */
      menu.addEventListener('mousedown', function (e) { if (e.target !== menu) e.preventDefault(); });
      menu.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-tag-pick]') : null;
        if (!b) return;
        if (b.disabled) return;
        add(b.getAttribute('data-tag-pick'));
        input.focus();
      });
    }
    input.addEventListener('input', function () { hi = -1; paintMenu(true); });
    input.addEventListener('keydown', function (e) {
      var key = e.key;
      var hits = matchesFor(input.value).slice(0, 8);
      if (key === 'Enter' || key === ',') {
        e.preventDefault();
        if (hi >= 0 && hits[hi]) add(hits[hi]);
        else if (input.value.trim()) add(input.value);
      } else if (key === 'ArrowDown') {
        e.preventDefault();
        hi = Math.min(hi + 1, Math.max(hits.length - 1, 0));
        paintMenu(true);
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        hi = Math.max(hi - 1, -1);
        paintMenu(true);
      } else if (key === 'Escape') {
        paintMenu(false);
      } else if (key === 'Backspace' && !input.value && selected.length) {
        removeAt(selected.length - 1);
      }
    });
    input.addEventListener('focus', function () { paintMenu(true); });
    input.addEventListener('blur', function () { setTimeout(function () { paintMenu(false); }, 140); });

    paintChips(); sync();

    return {
      get: function () { return selected.slice(); },
      set: function (list) { selected = (list || []).slice(); paintChips(); sync(); paintMenu(false); }
    };
  }

  /* ---------------- image compression ----------------
     The same downscale the dashboard runs: a 6 MB phone photo lands
     around 300–600 KB before it ever touches the network. Any failure
     hands the original file straight back. */

  function compressImage(file, cb) {
    var type = str(file && file.type);
    if (!/^image\//.test(type) || /gif|svg|heic|heif/i.test(type)) return cb(file);
    if (typeof URL === 'undefined' || !URL.createObjectURL || typeof Image === 'undefined') return cb(file);
    var url = URL.createObjectURL(file);
    var img = new Image();
    var done = false;
    function bail() {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      cb(file);
    }
    img.onerror = bail;
    img.onload = function () {
      try {
        var MAX = 1920;
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) return bail();
        var scale = Math.min(1, MAX / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx2d = canvas.getContext && canvas.getContext('2d');
        if (!ctx2d) return bail();
        ctx2d.drawImage(img, 0, 0, cw, ch);
        if (!canvas.toBlob) return bail();
        canvas.toBlob(function (blob) {
          if (done) return;
          done = true;
          try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
          if (!blob || blob.size >= file.size) return cb(file);
          var name = str(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
          try { cb(new File([blob], name, { type: 'image/jpeg' })); }
          catch (e) { cb(blob); }
        }, 'image/jpeg', 0.82);
      } catch (e) { bail(); }
    };
    try { img.src = url; } catch (e) { bail(); }
  }

  /* ---------------- uploads (progress for photos AND video) ---------------- */

  function cloudinaryXhr(endpoint, fd, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = function () {
        var body = str(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('Cloudinary rejected the upload: ' + body.slice(0, 180)));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Cloudinary returned an unreadable response.')); }
      };
      xhr.onerror = function () { reject(new Error('Network error while uploading.')); };
      xhr.onabort = function () { reject(new Error('Upload cancelled.')); };
      xhr.send(fd);
    });
  }

  function uploadToCloudinary(file, resourceType, statusElId, onDone, onProgress, onError) {
    var statusEl = $(statusElId);
    var kind = resourceType === 'video' ? 'video tour' : 'photo';
    function fail(msg) {
      if (statusEl) { statusEl.className = 'cl-up error'; statusEl.textContent = msg; }
      if (onError) onError(msg);
    }
    if (statusEl) { statusEl.className = 'cl-up uploading'; statusEl.textContent = 'Preparing the signed upload…'; }
    fetch('/api/cloudinary-sign', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('Could not get an upload signature (HTTP ' + r.status + ')'); return r.json(); })
      .then(function (sig) {
        if (statusEl) statusEl.textContent = 'Uploading ' + kind + '…';
        var fd = new FormData();
        fd.append('file', file);
        fd.append('api_key', sig.api_key);
        fd.append('timestamp', sig.timestamp);
        fd.append('signature', sig.signature);
        fd.append('folder', sig.folder);
        fd.append('eager', sig.eager);
        if (sig.max_file_size) fd.append('max_file_size', sig.max_file_size);
        if (sig.context) fd.append('context', sig.context);
        var endpoint = 'https://api.cloudinary.com/v1_1/' + sig.cloud_name + '/' + (resourceType === 'video' ? 'video' : 'image') + '/upload';
        return cloudinaryXhr(endpoint, fd, onProgress);
      })
      .then(function (data) {
        if (statusEl) { statusEl.className = 'cl-up success'; statusEl.textContent = 'Uploaded!'; }
        onDone(data.secure_url);
      })
      .catch(function (err) { fail('Upload failed: ' + err.message); });
  }

  /* Video tours stream straight to YouTube (unlisted) with a live
     progress bar; Cloudinary is the fallback path. */
  function uploadFile(file, resourceType, statusElId, onDone, onProgress, onError) {
    var statusEl = $(statusElId);
    if (resourceType !== 'video' || !window.ArzuzVideo || file.size > ArzuzVideo.MAX_BYTES) {
      return uploadToCloudinary(file, resourceType, statusElId, onDone, onProgress, onError);
    }
    if (statusEl) { statusEl.className = 'cl-up uploading'; statusEl.textContent = 'Preparing the video upload…'; }
    ArzuzVideo.uploadVideoToYouTube(file, {
      onProgress: function (p) {
        if (onProgress) onProgress((p && p.percent) || 0);
        if (!statusEl) return;
        statusEl.className = 'cl-up uploading';
        if (p.phase === 'uploading') statusEl.innerHTML = ArzuzVideo.progressHTML(p);
        else if (p.phase === 'processing') statusEl.textContent = 'Uploaded — processing the video…';
        else statusEl.textContent = 'Preparing the video upload…';
      }
    }).then(function (url) {
      if (statusEl) { statusEl.className = 'cl-up success'; statusEl.textContent = 'Uploaded!'; }
      onDone(url);
    }).catch(function (err) {
      if (window.console) console.warn('[Arzuz] YouTube upload unavailable, falling back to Cloudinary:', err.message);
      uploadToCloudinary(file, 'video', statusElId, onDone, onProgress, onError);
    });
  }

  /* ---------------- staged media grid ---------------- */

  function mediaThumbHTML(url) {
    if (window.ArzuzVideo && ArzuzVideo.parseYouTube(url)) {
      return '<img src="' + esc(ArzuzVideo.thumb(url)) + '" alt="" loading="lazy">';
    }
    if (window.ArzuzVideo && ArzuzVideo.isPlayable && ArzuzVideo.isPlayable(url)) {
      return '<video src="' + esc(url) + '" muted preload="metadata"></video>';
    }
    /* Rows saved by older versions can hold a Drive / Photos page URL, which
       is not a video file: pointing <video> at it draws a black dead tile.
       Naming the host at least keeps the row identifiable. */
    var host = '';
    try { host = (new URL(url)).hostname; } catch (e) { host = ''; }
    return '<div class="cl-nothumb">🎥 ' + esc(host || 'video link') + '</div>';
  }

  function stageTileHtml(it) {
    var isVideo = it.type === 'video';
    var thumb = it.preview
      ? (isVideo ? '<video src="' + esc(it.preview) + '" muted preload="metadata"></video>'
                 : '<img src="' + esc(it.preview) + '" alt="" loading="lazy">')
      : '<div style="aspect-ratio:4/3;background:rgba(0,0,0,.06)"></div>';
    var label = it.status === 'failed' ? 'Failed — remove'
      : it.status === 'uploading' ? (it.pct > 0 ? it.pct + '%' : 'Uploading…')
      : it.status === 'done' ? 'Uploaded'
      : 'Queued';
    return '<div class="cl-tile' + (it.status === 'failed' ? ' failed' : '') + '" data-sid="' + esc(it.id) + '">' +
      thumb +
      '<span class="cl-kind">' + (isVideo ? '🎥 tour' : '📷 photo') + '</span>' +
      '<button type="button" class="cl-x" data-stage="drop" data-sid="' + esc(it.id) + '" title="Remove">✕</button>' +
      (it.status === 'done' ? '' :
        '<span class="cl-pct">' + esc(label) + '</span>' +
        '<span class="cl-bar"><i style="width:' + (it.status === 'failed' ? 100 : (it.pct || 0)) + '%"></i></span>') +
      '</div>';
  }

  function syncHidden() {
    var cover = MEDIA.filter(function (m) { return m.type === 'image'; })[0];
    var tour = MEDIA.filter(function (m) { return m.type === 'video'; })[0];
    if ($('cl_photo_url')) $('cl_photo_url').value = cover ? cover.url : '';
    if ($('cl_video_url')) $('cl_video_url').value = tour ? tour.url : '';
  }

  /* Forty phone photos in one go is a 1,900 px scroll and forty live <img>s.
     The committed grid shows the first twelve and offers the rest; staged
     tiles always render, because that is the batch the landlord is watching
     go up and they vanish as the uploads land. Nothing is dropped — the
     tiles behind the button are still MEDIA, still in the payload. */
  var GRID_CAP = 12;
  var showAllMedia = false;

  function renderGallery() {
    var grid = $('clStageGrid');
    if (!grid) return;
    if (!MEDIA.length && !STAGE.length) {
      grid.innerHTML = '<p class="cl-empty">No media yet. The first photo you upload becomes the cover students see on the browse page.</p>';
      syncHidden();
      return;
    }
    var firstImg = MEDIA.filter(function (m) { return m.type === 'image'; })[0];
    var capped = MEDIA.length > GRID_CAP;
    var hidden = (capped && !showAllMedia) ? MEDIA.length - GRID_CAP : 0;
    var html = STAGE.map(stageTileHtml).join('');
    html += MEDIA.map(function (m, i) {
      if (hidden && i >= GRID_CAP) return '';
      var isCover = (m === firstImg);
      var isVideo = m.type === 'video';
      var thumb = isVideo ? mediaThumbHTML(m.url) + '<span class="cl-kind">🎥 tour</span>'
                          : '<img src="' + esc(m.url) + '" alt="" loading="lazy"><span class="cl-kind">📷 photo</span>';
      var controls = VIEW_ONLY ? '' :
        '<button type="button" class="cl-x" data-gal="del" data-i="' + i + '" title="Remove">✕</button>' +
        (isVideo ? '' :
          '<button type="button" class="cl-cover' + (isCover ? ' is-cover' : '') + '" data-gal="cover" data-i="' + i + '" title="Use as the cover photo">' +
          (isCover ? '★ Cover photo' : '★ Set as cover') + '</button>');
      return '<div class="cl-tile">' + thumb + controls + '</div>';
    }).join('');
    if (capped) {
      html += '<button type="button" class="cl-more" data-gal="more">' +
        (showAllMedia ? 'Show fewer' : 'Show all ' + MEDIA.length + ' (' + hidden + ' more)') +
        '</button>';
    }
    grid.innerHTML = html;
    syncHidden();
  }

  function stageProgressTick(item) {
    var tile = document.querySelector('.cl-tile[data-sid="' + item.id + '"]');
    if (!tile) return;
    var bar = tile.querySelector('.cl-bar i');
    if (bar) bar.style.width = (item.pct || 0) + '%';
    var pctEl = tile.querySelector('.cl-pct');
    if (pctEl) pctEl.textContent = item.pct > 0 ? item.pct + '%' : 'Uploading…';
  }

  /* Phone photo batches arrive 20–40 files at a time. Three travel together:
     more than that saturate the uplink and starve every other request on the
     page. The grid is also painted once for the whole batch instead of once
     per file — with 40 files that was 40 re-renders of a growing list. */
  var MAX_PARALLEL_UPLOADS = 3;

  function stageFiles(files, kind) {
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    var progId = kind === 'video' ? 'clVideoProgress' : 'clPhotoProgress';
    var prog = $(progId);
    var total = arr.length, done = 0, failed = 0, active = 0, next = 0;

    function report() {
      if (!prog) return;
      if (done + failed >= total) {
        prog.className = 'cl-up ' + (failed ? 'error' : 'success');
        prog.textContent = failed
          ? (done + ' uploaded, ' + failed + ' failed')
          : done + ' ' + (kind === 'video' ? (done === 1 ? 'video' : 'videos') : (done === 1 ? 'photo' : 'photos')) + ' uploaded';
      } else {
        prog.className = 'cl-up uploading';
        prog.textContent = 'Uploading ' + Math.min(done + failed + active + 1, total) + ' of ' + total + '…';
      }
    }

    var items = arr.map(function (file, idx) {
      var item = {
        id: 'st' + Date.now().toString(36) + idx + Math.random().toString(36).slice(2, 6),
        type: kind === 'video' ? 'video' : 'image',
        preview: '', status: 'queued', pct: 0
      };
      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        try { item.preview = URL.createObjectURL(file); } catch (e) { item.preview = ''; }
      }
      STAGE.push(item);
      return item;
    });
    renderGallery();
    report();

    function start(i) {
      var item = items[i];
      active++;
      item.status = 'uploading';
      stageProgressTick(item);

      var send = function (f) {
        uploadFile(f, kind, progId, function (url) {
          /* the blob preview is dead the moment the real URL exists */
          if (item.preview && typeof URL !== 'undefined' && URL.revokeObjectURL) {
            try { URL.revokeObjectURL(item.preview); } catch (e) { /* ignore */ }
          }
          var at = STAGE.indexOf(item);
          if (at !== -1) STAGE.splice(at, 1);
          MEDIA.push({ type: kind === 'video' ? 'video' : 'image', url: url, label: '', credit: credit() });
          active--;
          done++;
          markDirty();
          renderGallery();
          report();
          pump();
        }, function (pct) {
          item.pct = pct;
          stageProgressTick(item);
        }, function () {
          item.status = 'failed';
          active--;
          failed++;
          renderGallery();
          report();
          pump();
        });
      };

      /* photos are downscaled first, so the tile is already on screen
         while the browser re-encodes the file */
      if (kind === 'image') compressImage(arr[i], send);
      else send(arr[i]);
    }

    function pump() {
      while (active < MAX_PARALLEL_UPLOADS && next < items.length) start(next++);
    }

    pump();
  }

  function bindDropZone(zone, kind) {
    if (!zone || typeof zone.addEventListener !== 'function') return;
    var input = $(kind === 'video' ? 'clVideoInput' : 'clPhotoInput');
    zone.addEventListener('click', function () { if (input) input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (input) input.click(); }
    });
    if (input) {
      input.addEventListener('change', function () {
        stageFiles(input.files, kind);
        input.value = '';
      });
    }
    ['dragenter', 'dragover'].forEach(function (t) {
      zone.addEventListener(t, function (e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        zone.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (t) {
      zone.addEventListener(t, function () { zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) stageFiles(files, kind);
    });
  }

  /* The rule itself lives in video.js, next to the player that has to honour
     it, so this form and the dashboard composer refuse the same links with
     the same sentence. */
  function videoUrlProblem(url) {
    if (!window.ArzuzVideo || !ArzuzVideo.playbackProblem) return '';
    return ArzuzVideo.playbackProblem(url);
  }

  function embedUrl() {
    var input = $('clVideoUrl');
    if (!input) return;
    var url = str(input.value).trim();
    if (!url) return;
    /* phones paste www.youtube.com/… and youtu.be/… with no scheme at all */
    if (window.ArzuzVideo && ArzuzVideo.normalizeUrl) url = ArzuzVideo.normalizeUrl(url);
    if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(url)) {
      toast('That does not look like a link.', 'error');
      return;
    }
    var problem = videoUrlProblem(url);
    if (problem) { toast(problem, 'error'); return; }
    if (!MEDIA.some(function (m) { return m.url === url; })) {
      MEDIA.push({ type: 'video', url: url, label: '', credit: credit() });
      markDirty();
      renderGallery();
      var st = $('clVideoProgress');
      if (st) { st.className = 'cl-up success'; st.textContent = 'Video link added.'; }
    }
    input.value = '';
  }

  /* media remove / cover — delegated, the grid is re-rendered */
  document.addEventListener('click', function (e) {
    var drop = e.target && e.target.closest ? e.target.closest('[data-stage="drop"]') : null;
    if (drop) {
      var at = -1;
      STAGE.forEach(function (it, i) { if (it.id === drop.getAttribute('data-sid')) at = i; });
      if (at !== -1) {
        if (STAGE[at].preview && typeof URL !== 'undefined' && URL.revokeObjectURL) {
          try { URL.revokeObjectURL(STAGE[at].preview); } catch (e2) { /* ignore */ }
        }
        STAGE.splice(at, 1);
        renderGallery();
      }
      return;
    }
    /* expanding the capped grid is a view, not a change: it works on a
       read-only link too, and it never marks the form dirty */
    var more = e.target && e.target.closest ? e.target.closest('[data-gal="more"]') : null;
    if (more) { showAllMedia = !showAllMedia; renderGallery(); return; }
    var b = e.target && e.target.closest ? e.target.closest('[data-gal]') : null;
    if (!b || VIEW_ONLY) return;
    var i = parseInt(b.getAttribute('data-i'), 10);
    if (isNaN(i) || !MEDIA[i]) return;
    if (b.getAttribute('data-gal') === 'del') MEDIA.splice(i, 1);
    else if (b.getAttribute('data-gal') === 'cover') { var m = MEDIA.splice(i, 1)[0]; MEDIA.unshift(m); }
    else return;
    markDirty();
    renderGallery();
  });

  /* ---------------- availability ---------------- */

  /* The believable ceiling for a students' lodge here. Above it the number
     is a slipped key, so it is capped and the landlord is told why. */
  var MAX_UNITS = 999;

  function unitsTyped() {
    var raw = str($('cl_units') ? $('cl_units').value : '').trim();
    if (raw === '') return NaN;
    return parseInt(raw.replace(/[^0-9]/g, ''), 10);
  }

  /* A zero in the box does not mean "some rooms are free": the landlord has
     just said there are none. It used to fall through to units: null, which
     renders "Units available" — a full apartment advertised as free. Zero is
     stored the way the rest of the site reads availability: avail 'occupied'. */
  function availState() {
    var mode = segAvail ? segAvail.get() : 'vacant';
    var n = unitsTyped();
    if (isFinite(n) && n === 0) return { mode: 'occupied', units: null, zero: true };
    return { mode: mode, units: (isFinite(n) && n > 0) ? Math.min(n, MAX_UNITS) : null, zero: false };
  }

  function roomsText(st) {
    if (st.mode === 'occupied') return 'Fully occupied';
    if (!st.units) return 'Units available';
    return st.units + (st.units === 1 ? ' room available' : ' rooms available');
  }

  function syncAvailabilityUi() {
    var mode = segAvail ? segAvail.get() : 'vacant';
    var wrap = $('clUnitsWrap');
    if (wrap) {
      if (mode === 'occupied') wrap.setAttribute('hidden', 'hidden');
      else wrap.removeAttribute('hidden');
    }
    /* the hidden field carries what will actually be stored, zero included */
    if ($('cl_avail')) $('cl_avail').value = availState().mode;
    /* the box flips nothing on screen, so it says what it is about to do */
    var note = $('clUnitsNote');
    if (note) {
      var n = unitsTyped();
      if (isFinite(n) && n === 0) {
        note.textContent = '0 vacant units — this listing will be saved as fully occupied.';
        note.hidden = false;
      } else if (isFinite(n) && n > MAX_UNITS) {
        note.textContent = 'That looks like a typo — the count is capped at ' + MAX_UNITS + '.';
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    }
  }

  /* The name is optional: a readable placeholder is derived from the
     type + area so the browse page never shows a blank card. */
  function autoTitle(ty, area) {
    var t = str(ty).trim(), a = str(area).trim();
    if (t && a) return t + ' in ' + a;
    if (a) return 'Apartment in ' + a;
    if (t) return t + ' apartment';
    return 'Untitled apartment';
  }

  /* ---------------- map (one map: pin or draw the path) ---------------- */

  function setMapMode(mode) {
    var bar = $('clTraceBar');
    var tgl = $('clTraceToggle');
    var tracing = !!(bar && bar.classList && bar.classList.contains('tracing'));
    if (tgl) {
      if (mode === 'path' && !tracing) tgl.click();
      else if (mode === 'pin' && tracing) tgl.click();
    }
    if (bar) {
      if (mode === 'path') bar.removeAttribute('hidden');
      else bar.setAttribute('hidden', 'hidden');
    }
  }

  function buildMap() {
    if (mapReady || typeof ArzuzMap === 'undefined') return;
    if (!$('cl-map')) return;
    mapReady = true;

    if (VIEW_ONLY) {
      if (isFinite(pin.lat) && isFinite(pin.lng)) {
        ArzuzMap.routeMap({
          containerId: 'cl-map', lat: pin.lat, lng: pin.lng,
          passage: storedPassage, name: storedName, trackable: false
        });
      }
      return;
    }

    if (pinCapture) { try { pinCapture.destroy(); } catch (e) { /* ignore */ } pinCapture = null; }
    pinCapture = ArzuzMap.pinCapture({
      containerId: 'cl-map',
      layerSwitchId: 'clMapLayerSwitcher',
      coordsBadgeId: 'clMapCoords',
      locateBtnId: 'clBtnGps',
      statusBoxId: 'clMapStatus',
      tipBannerId: null,
      startGps: false,
      trace: true,
      traceBarId: 'clTraceBar',
      traceToggleId: 'clTraceToggle',
      traceUndoId: 'clTraceUndo',
      traceClearId: 'clTraceClear',
      traceCountId: 'clTraceCount',
      traceSource: 'traced',
      existingRoute: (storedPassage && storedPassage.route) || null,
      lat: pin.lat,
      lng: pin.lng,
      onPin: function (lat, lng, meta) {
        pin = { lat: lat, lng: lng };
        /* merge, never replace: tracing the road re-commits the pin and
           must not wipe the source / accuracy the GPS or a tap set */
        pinMeta = Object.assign({}, pinMeta || {}, meta || {});
        var badge = $('clMapCoords');
        if (badge && !(meta && meta.route)) {
          badge.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
          badge.classList.add('set');
        }
      },
      /* a traced walk path with no pin yet: keep the route, add no position */
      onRoute: function (meta) {
        pinMeta = Object.assign({}, pinMeta || {}, meta || {});
      }
    });
    setMapMode(segMap ? segMap.get() : 'pin');
  }

  /* ---------------- fill the form from the draft row ---------------- */

  /* Rows written before the field de-duplicated itself can name the same
     amenity twice in different case — that is one chip, not two. */
  function cleanUt(list) {
    var arr = Array.isArray(list) ? list : (list ? str(list).split(',') : []);
    var seen = {};
    return arr.filter(function (u) {
      var k = str(u).trim().replace(/\s+/g, ' ').toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = 1;
      return true;
    }).map(function (u) { return str(u).trim().replace(/\s+/g, ' '); });
  }

  function fillForm(p, row) {
    p = p || {};
    storedPassage = (p.passage && typeof p.passage === 'object') ? p.passage : null;

    var ty = $('cl_ty');
    if (ty && typeof PROPERTY_TYPES !== 'undefined') {
      ty.innerHTML = PROPERTY_TYPES.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    }

    /* a title Arzuz built from the type + area is offered as the
       placeholder, not as text the landlord has to clear */
    var generated = (p.name_generated === true || p.name_generated === 'true');
    $('cl_prop_name').value = generated ? '' : (p.prop_name || '');
    if (generated && p.prop_name) $('cl_prop_name').placeholder = p.prop_name;
    if (p.ty && ty) ty.value = p.ty;
    $('cl_ar').value = p.ar || '';
    $('cl_rent').value = (p.rent === undefined || p.rent === null) ? '' : p.rent;
    var ask = (row && row.opening_ask_ngn != null) ? row.opening_ask_ngn : (p.ask != null ? p.ask : '');
    $('cl_ask').value = ask;
    $('cl_desc').value = p.desc || p.description || '';
    $('cl_split_ok').checked = p.split_ok === true || p.split_ok === 'yes';

    /* contact: one name box now, so a legacy first+last row still reads right */
    var fullName = (str(p.nm) + ' ' + str(p.last)).trim() || str(p.owner_name);
    $('cl_nm').value = fullName;
    $('cl_ph').value = p.ph || '';
    var role = (CONTACT_ROLES.indexOf(str(p.contact_role)) !== -1) ? str(p.contact_role) : (LEGACY_WHO[str(p.who)] || '');
    $('cl_role').value = role;

    /* availability: new rows carry avail + units, old ones only rm */
    var mode = str(p.avail) === 'occupied' ? 'occupied' : 'vacant';
    if (segAvail) segAvail.setSilent(mode);
    var units = p.units != null && p.units !== '' ? String(p.units) : '';
    if (!units && mode === 'vacant') units = str(p.rm).replace(/[^0-9]/g, '');
    $('cl_units').value = units;
    syncAvailabilityUi();

    $('cl_access_notes').value = (storedPassage && storedPassage.landmark) || p.access_notes || '';

    /* amenities */
    if (tagField) tagField.set(cleanUt(p.ut));

    /* media */
    MEDIA = [];
    STAGE = [];
    if (Array.isArray(p.media)) {
      p.media.forEach(function (m) {
        if (m && m.url) MEDIA.push({ type: m.type === 'video' ? 'video' : 'image', url: String(m.url), label: m.label || '', credit: m.credit || credit() });
      });
    }
    if (!MEDIA.length && p.photo) MEDIA.push({ type: 'image', url: p.photo, label: 'Cover photo', credit: credit() });
    if (!MEDIA.some(function (m) { return m.type === 'video'; }) && (p.video || p.video_url)) {
      MEDIA.push({ type: 'video', url: p.video || p.video_url, label: 'Video tour', credit: credit() });
    }
    renderGallery();

    /* pin + route */
    var lat = parseFloat((row && row.latitude) || p.lat), lng = parseFloat((row && row.longitude) || p.lng);
    pin = { lat: (isFinite(lat) ? lat : null), lng: (isFinite(lng) ? lng : null) };
    pinMeta = p.pin_meta || null;
    storedName = p.prop_name || 'This apartment';

    markClean();
  }

  /* ---------------- collect + save ---------------- */

  function collectPatch(saveMode) {
    var p = {};
    var area = $('cl_ar').value.trim();
    var name = $('cl_prop_name').value.trim();
    var ty = $('cl_ty').value || '';
    if (!ty && typeof PROPERTY_TYPES !== 'undefined' && PROPERTY_TYPES.length) ty = PROPERTY_TYPES[0];

    p.prop_name = name || autoTitle(ty, area);
    p.name_generated = !name;
    p.ty = ty;
    p.ar = area;
    p.rent = $('cl_rent').value.trim();
    p.ask = $('cl_ask').value.trim();

    var av = availState();
    p.avail = av.mode;
    p.units = av.units;
    p.rm = roomsText(av);

    p.nm = $('cl_nm').value.trim();
    p.last = '';
    p.ph = $('cl_ph').value.trim();
    p.contact_role = $('cl_role').value;
    p.who = p.contact_role;
    p.desc = $('cl_desc').value.trim();
    p.split_ok = $('cl_split_ok').checked;
    p.ut = tagField ? tagField.get() : [];
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
    }
    /* the meta travels even without a pin — that is how a traced walk path
       reaches the passage below */
    if (pinMeta) p.pin_meta = pinMeta;

    /* Access notes + the traced path live in ONE passage object, exactly
       where the dashboard and the public listing read them. A route the
       landlord is not touching is carried over, never dropped. */
    var notes = $('cl_access_notes').value.trim();
    var meta = pinMeta || {};
    var prev = storedPassage || {};
    var route = (meta.route && meta.route.length > 1) ? meta.route : (prev.route || []);
    var passage = {
      landmark: notes,
      gate: '',
      floor: '',
      steps: [],
      route: route,
      route_src: (meta.route && meta.route.length > 1) ? (meta.route_src || 'traced') : (prev.route_src || ''),
      route_km: (meta.route && meta.route.length > 1) ? (meta.route_km || null) : (prev.route_km || null),
      route_min: (meta.route && meta.route.length > 1) ? (meta.route_min || null) : (prev.route_min || null)
    };
    var hasContent = (typeof ArzuzMap !== 'undefined' && ArzuzMap.passage)
      ? ArzuzMap.passage.hasContent(passage)
      : !!(notes || passage.route.length > 1);
    p.passage = hasContent ? passage : null;
    p.access_notes = notes;

    /* consumed by the RPC to tell "saved my progress" from "ready for
       review"; it is not on the whitelist so it is never stored */
    p.save_mode = saveMode === 'progress' ? 'progress' : 'send';

    /* "Negotiable?" is gone from both forms — never written again.
       Legacy rows keep the value they already hold. */
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
          payload: { prop_name: p.prop_name, ar: p.ar, ty: p.ty, rent: p.rent, ph: p.ph, rooms: p.rm, contact_role: p.contact_role }
        })
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  function setBusy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.dataset.label || btn.textContent;
      btn.disabled = true;
      btn.textContent = label || 'Saving…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  /* mode: 'progress' = keep filling later · 'send' = ready for review */
  function save(mode) {
    if (VIEW_ONLY) return;
    var sending = mode !== 'progress';
    var btn = sending ? $('clSave') : $('clSaveDraft');
    setNote($('clError'), '');
    setNote($('clOk'), '');

    /* a draft may be half-filled; a submission needs the two numbers the
       team cannot work without */
    if (sending) {
      var problems = [];
      if (!$('cl_ar').value.trim()) problems.push({ id: 'cl_ar', tab: 'specs', msg: 'Add the area / location so the team knows where this is.' });
      if (!$('cl_rent').value.trim()) problems.push({ id: 'cl_rent', tab: 'specs', msg: 'Add the rent price for the session.' });
      if (problems.length) {
        if (TABS) TABS(problems[0].tab);
        setNote($('clError'), problems[0].msg);
        var el = $(problems[0].id);
        if (el && el.focus) el.focus();
        return;
      }
    }

    var p = collectPatch(mode);
    setBusy(btn, true, sending ? 'Sending…' : 'Saving…');

    var run;
    if (!cfgured() || !TOKEN) {
      /* local preview / no token: simulate the round-trip */
      run = new Promise(function (res) { setTimeout(res, 700); });
    } else {
      run = rpc('listing_draft_update', { p_token: TOKEN, p_patch: p }).then(function (out) {
        if (!out || !out.id) throw new Error('This link is no longer valid.');
      });
    }
    run
      .then(function () {
        markClean();
        if (sending) {
          notifyTeam(p);
          toast('Sent to Arzuz — thank you!', 'success');
          show('done');
        } else {
          toast('Draft saved — your link keeps working.', 'success');
          setNote($('clOk'), 'Progress saved. Nothing has been sent for review yet — press Send to Arzuz when you are done.');
          storedPassage = p.passage;
        }
      })
      .catch(function (e) {
        setNote($('clError'), 'Could not save: ' + e.message);
      })
      .then(function () { setBusy(btn, false); });
  }

  /* ---------------- the exit triad ----------------
     Instagram-style: save the progress, drop the changes, or stay. The
     same three answers the dashboard composer offers. */

  function openExit() {
    var m = $('clExitModal');
    if (!m) return;
    m.classList.add('open');
    var b = $('clExitSaveDraft');
    if (b && b.focus) b.focus();
  }

  function closeExit() {
    var m = $('clExitModal');
    if (!m) return;
    /* no animation callback: the class goes on and off synchronously, so
       the prompt can never be left on screen with dead buttons */
    m.classList.remove('open');
  }

  /* put the form back to what Arzuz already holds */
  function revert() {
    closeExit();
    if (!cfgured() || !TOKEN) {
      fillForm({}, null);
      toast('Changes discarded.', 'info');
      return;
    }
    rpc('listing_draft_get', { p_token: TOKEN })
      .then(function (row) {
        if (!row || !row.id) { failState('This link is no longer valid.'); return; }
        draft = row;
        fillForm(row.payload || {}, row);
        toast('Changes discarded.', 'info');
      })
      .catch(function (e) { setNote($('clError'), 'Could not reload your details: ' + e.message); });
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
      fillForm({}, null);
      return;
    }
    if (!TOKEN) { failState('No ref token in the URL'); return; }
    rpc('listing_draft_get', { p_token: TOKEN })
      .then(function (row) {
        if (!row || !row.id) { failState('Token rejected or draft already approved'); return; }
        draft = row;
        VIEW_ONLY = (row.draft_permission === 'view');
        show('form');
        fillForm(row.payload || {}, row);
        permNote(row);
        if (VIEW_ONLY) lockForm();
        var when = row.draft_completed_at ? new Date(row.draft_completed_at) : null;
        var whenText = (when && !isNaN(when))
          ? when.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        if (VIEW_ONLY) {
          /* a reader, not a filler-in: no "send" promises in the copy */
          $('clTitle').textContent = 'Your apartment details';
          var lead = document.querySelector('#clForm > .lead');
          if (lead) lead.textContent = 'These are the details Arzuz recorded for this apartment. Read them over and tell the team — on WhatsApp — anything that needs changing.';
          $('clSavedNote').innerHTML = whenText
            ? '<div class="cl-saved">These details were recorded on ' + esc(whenText) + '.</div>'
            : '';
        } else if (row.draft_completed_at) {
          $('clSavedNote').innerHTML = '<div class="cl-saved">✅ You sent this on ' + esc(whenText) +
            '. It is still editable until Arzuz approves it.</div>';
          $('clTitle').textContent = 'Adjust your apartment';
        }
      })
      .catch(function (e) { failState(e.message); });
  }

  /* ---------------- boot ---------------- */

  segAvail = initSeg('clAvailSeg', function () { syncAvailabilityUi(); markDirty(); });
  segMap = initSeg('clMapModeSeg', function (mode) { setMapMode(mode); markDirty(); });
  tagField = initTagField({ fieldId: 'clAmenityField', chipsId: 'clAmenityChips', inputId: 'clAmenityInput', suggestId: 'clAmenitySuggest' });
  syncAvailabilityUi();
  var unitsEl = $('cl_units');
  if (unitsEl) {
    /* typing 0 has to say what it will do, not wait for a save */
    unitsEl.addEventListener('input', syncAvailabilityUi);
    unitsEl.addEventListener('change', syncAvailabilityUi);
  }
  TAB_HOOKS.location = buildMap;
  TABS = initTabs();
  bindDropZone($('clPhotoZone'), 'image');
  bindDropZone($('clVideoZone'), 'video');

  var urlBtn = $('clVideoUrlAdd');
  if (urlBtn) urlBtn.addEventListener('click', embedUrl);
  var urlInput = $('clVideoUrl');
  if (urlInput) {
    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); embedUrl(); }
    });
  }

  var formEl = $('clFormEl');
  if (formEl) {
    formEl.addEventListener('submit', function (e) { e.preventDefault(); save('send'); });
    formEl.addEventListener('input', markDirty, true);
    formEl.addEventListener('change', markDirty, true);
  }

  var draftBtn = $('clSaveDraft');
  if (draftBtn) draftBtn.addEventListener('click', function () { save('progress'); });

  var discardBtn = $('clDiscard');
  if (discardBtn) {
    discardBtn.addEventListener('click', function () {
      if (!dirty) { toast('Nothing to discard — the form matches what Arzuz has.', 'info'); return; }
      openExit();
    });
  }

  var exitKeep = $('clExitKeep');
  if (exitKeep) exitKeep.addEventListener('click', closeExit);
  var exitDiscard = $('clExitDiscard');
  if (exitDiscard) exitDiscard.addEventListener('click', revert);
  var exitSave = $('clExitSaveDraft');
  if (exitSave) exitSave.addEventListener('click', function () { closeExit(); save('progress'); });

  var modal = $('clExitModal');
  if (modal) {
    modal.addEventListener('click', function (e) { if (e.target === modal) closeExit(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeExit();
    });
  }

  var backToForm = $('clBackToForm');
  if (backToForm) backToForm.addEventListener('click', function () { show('form'); });

  /* Tapping back on a phone is the real "exit" here — the browser asks
     before junking half a form. */
  window.addEventListener('beforeunload', function (e) {
    if (!dirty || VIEW_ONLY) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  if (typeof ArzuzData !== 'undefined' && ArzuzData.ready) {
    ArzuzData.ready.then(function () {
      /* the amenity table arrived: a draft may name an amenity that only
         exists there, so re-seed the combobox once it lands */
      if (tagField && draft && draft.payload && Array.isArray(draft.payload.ut)) {
        tagField.set(cleanUt(draft.payload.ut));
      }
    }).catch(function () {});
  }

  load();
})();
