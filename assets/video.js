/* ============================================================
   Arzuz — video media helper (YouTube-backed video tours)

   One module for everything video:
     • parseYouTube / isYouTube   URL → video id
     • thumb                      public poster image for a video
     • uploadVideoToYouTube       resumable upload, direct to
                                  Google, with live progress
     • mountPlayer                the masked player: our own play
                                  button, progress bar, mute and
                                  fullscreen over a branding-free
                                  youtube-nocookie embed
     • progressHTML               styled upload progress line

   Plain ES5, no build step. Loaded by listing.html, admin.html
   and complete-listing.html. Also importable from node tests
   (module.exports guard at the bottom).

   Videos are stored UNLISTED on the Arzuz channel; the stored
   payload URL is the plain watch link, so old listings and the
   draft SQL keep working untouched.
   ============================================================ */

var ArzuzVideo = (function () {
  'use strict';

  /* ---------------- URL parsing ---------------- */

  var ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /* Accepts every YouTube URL shape we might store or paste,
     plus a bare 11-char id. Returns null for anything else
     (e.g. a Cloudinary .mp4 — callers then render <video>). */
  function parseYouTube(url) {
    if (url === null || url === undefined) return null;
    var s = String(url).trim();
    if (ID_RE.test(s)) return s;
    var m;
    m = /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})/i.exec(s);
    if (m) return m[1];
    m = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/i.exec(s);
    if (m) return m[1];
    m = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com)\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/i.exec(s);
    if (m) return m[1];
    return null;
  }

  function isYouTube(url) { return parseYouTube(url) !== null; }

  function watchUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

  /* Poster frames of unlisted videos are publicly served by the
     i.ytimg.com CDN — good enough for gallery thumbnails, and it
     carries no YouTube UI. */
  function thumb(url) {
    var id = parseYouTube(url);
    return id ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : '';
  }

  /* ---------------- embed URL (via our proxy) ---------------- */

  /* The proxy (/api/video-embed/<id>) 302s to the nocookie embed
     with all branding params off, so raw google URLs stay out of
     the page source. controls=1 keeps YouTube's own bar — used
     only in landlord/admin preview contexts. */
  function embedProxyUrl(url, opts) {
    var id = parseYouTube(url);
    if (!id) return '';
    opts = opts || {};
    var qs = [];
    if (opts.autoplay) qs.push('autoplay=1');
    if (opts.controls) qs.push('controls=1');
    return '/api/video-embed/' + id + (qs.length ? '?' + qs.join('&') : '');
  }

  /* ---------------- resumable upload ---------------- */

  var MAX_BYTES = 200 * 1024 * 1024;   // mirrored by youtube-upload-start

  function startSession(file, title) {
    return fetch('/api/youtube-upload-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name || 'tour.mp4',
        size: file.size,
        contentType: file.type || 'video/mp4',
        title: title || 'Apartment video tour',
      }),
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'Could not start the video upload (HTTP ' + r.status + ')');
        return body;
      });
    });
  }

  /* Uploads the file straight to Google's resumable endpoint and
     resolves with the canonical watch URL for the new unlisted
     video. onProgress fires with:
       { phase: 'preparing'|'uploading'|'processing',
         percent, loaded, total, bytesPerSec }               */
  function uploadVideoToYouTube(file, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};

    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('No video file selected')); return; }
      if (file.size > MAX_BYTES) {
        reject(new Error('Video is too large — the limit is 200 MB'));
        return;
      }

      onProgress({ phase: 'preparing', percent: 0 });

      startSession(file, opts.title).then(function (session) {
        if (!session || !session.uploadUrl) throw new Error('Upload session did not return an upload URL');

        var xhr = new XMLHttpRequest();
        var startedAt = Date.now();

        xhr.open('PUT', session.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');

        /* fetch() has no upload events — XHR is the only way to
           get honest progress while the bytes stream out */
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var elapsed = (Date.now() - startedAt) / 1000;
          onProgress({
            phase: 'uploading',
            percent: Math.round((e.loaded / e.total) * 100),
            loaded: e.loaded,
            total: e.total,
            bytesPerSec: elapsed > 0.2 ? e.loaded / elapsed : 0,
          });
        };

        xhr.onload = function () {
          if (xhr.status === 200 || xhr.status === 201) {
            try {
              var body = JSON.parse(xhr.responseText);
              if (body && body.id) {
                onProgress({ phase: 'processing', percent: 100, loaded: file.size, total: file.size, bytesPerSec: 0 });
                resolve(watchUrl(body.id));
                return;
              }
            } catch (e) { /* fall through */ }
            reject(new Error('Upload finished but no video id came back'));
          } else {
            reject(new Error('Upload failed (HTTP ' + xhr.status + ')'));
          }
        };
        xhr.onerror = function () {
          reject(new Error('Network error during upload — check your connection and try again'));
        };
        xhr.send(file);
      }).catch(reject);
    });
  }

  /* ---------------- upload progress markup ---------------- */

  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return '';
    if (bps >= 1024 * 1024) return ' · ' + (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
    return ' · ' + Math.round(bps / 1024) + ' kB/s';
  }

  /* Renders into a status element: text + a thin progress bar.
     Callers wrap it with their own phase wording. */
  function progressHTML(p) {
    var pct = Math.max(0, Math.min(100, p && p.percent || 0));
    var label = (p && p.phase === 'uploading') ? ('Uploading ' + pct + '%' + fmtSpeed(p.bytesPerSec)) : '';
    return '<span class="upline">' + label + '</span>' +
      '<span class="upbar"><span style="width:' + pct + '%"></span></span>';
  }

  /* ---------------- masked player ----------------
     Our own chrome over a branding-free nocookie embed: big
     play button, seek bar, time, mute, fullscreen. YouTube's
     own controls/logo/related grid are all switched off and an
     overlay shade keeps clicks away from its player. */

  /* every mounted player registers here so pages can pause or
     tear down on slide change / lightbox close */
  var MOUNTED = [];

  function pauseAll() {
    MOUNTED.slice().forEach(function (h) { h.pause(); });
  }

  /* destroys every player mounted inside (or around) container */
  function stopIn(container) {
    if (!container) return;
    MOUNTED.slice().forEach(function (h) {
      if (h.root === container || h.root.contains(container) || container.contains(h.root)) h.destroy();
    });
  }

  /* The official IFrame Player API drives playback of an embed
     whose own chrome we never show. Loaded once, on first play. */
  var apiPromise = null;
  function loadApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise(function (resolve) {
      if (window.YT && window.YT.Player) { resolve(); return; }
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (prev) { try { prev(); } catch (e) { /* other listener */ } }
        resolve();
      };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
      /* if the API script is blocked, stop waiting — mountPlayer
         falls back to a plain proxied iframe (playable, unlisted) */
      setTimeout(function () { resolve(); }, 8000);
    });
    return apiPromise;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* Builds the player into `container` and returns a handle
     { pause, destroy }. Non-YouTube URLs return null so callers
     render their plain <video> fallback instead. */
  function mountPlayer(container, url, opts) {
    opts = opts || {};
    var id = parseYouTube(url);
    if (!container || !id) return null;

    var root = document.createElement('div');
    root.className = 'azv-player';
    root.innerHTML =
      '<div class="azv-stage">' +
        '<div class="azv-poster"><img alt="" src="' + thumb(url) + '"></div>' +
        '<div class="azv-slot"></div>' +
        '<div class="azv-shade"></div>' +
        '<button type="button" class="azv-big" aria-label="Play video">&#9654;</button>' +
        '<div class="azv-bar">' +
          '<button type="button" class="azv-btn azv-play" aria-label="Play or pause">&#9654;</button>' +
          '<div class="azv-track"><div class="azv-fill"></div></div>' +
          '<span class="azv-time">0:00</span>' +
          '<button type="button" class="azv-btn azv-mute" aria-label="Mute or unmute">&#128263;</button>' +
          '<button type="button" class="azv-btn azv-fs" aria-label="Fullscreen">&#9974;</button>' +
        '</div>' +
      '</div>';
    container.appendChild(root);

    var stage   = root.querySelector('.azv-stage');
    var slot    = root.querySelector('.azv-slot');
    var shade   = root.querySelector('.azv-shade');
    var big     = root.querySelector('.azv-big');
    var btnPlay = root.querySelector('.azv-play');
    var track   = root.querySelector('.azv-track');
    var fill    = root.querySelector('.azv-fill');
    var timeEl  = root.querySelector('.azv-time');
    var btnMute = root.querySelector('.azv-mute');
    var btnFs   = root.querySelector('.azv-fs');

    var st = { player: null, ready: false, playing: false, duration: 0,
               poll: null, hideTimer: null, destroyed: false, apiStarted: false };

    function showBar() {
      root.classList.remove('bar-hidden');
      if (st.hideTimer) { clearTimeout(st.hideTimer); st.hideTimer = null; }
    }
    function scheduleBarHide() {
      showBar();
      st.hideTimer = setTimeout(function () { root.classList.add('bar-hidden'); }, 2600);
    }
    function setPlayingUI(playing) {
      st.playing = playing;
      btnPlay.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
      root.classList.toggle('is-playing', playing);
      if (playing) scheduleBarHide(); else showBar();
    }

    function tick() {
      if (!st.player || !st.ready || st.destroyed) return;
      try {
        var cur = st.player.getCurrentTime() || 0;
        var dur = st.player.getDuration() || 0;
        if (dur) {
          fill.style.width = Math.min(100, (cur / dur) * 100) + '%';
          timeEl.textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
        }
      } catch (e) { /* iframe mid-load or detached */ }
    }
    function startPoll() { if (!st.poll) st.poll = setInterval(tick, 250); }
    function stopPoll()  { if (st.poll) { clearInterval(st.poll); st.poll = null; } }

    function fallbackIframe() {
      /* API script blocked — still playable through the proxy,
         just with YouTube's own controls instead of ours */
      root.classList.add('is-live');
      slot.innerHTML = '<iframe src="' + embedProxyUrl(url, { autoplay: opts.autoplay, controls: true }) + '" ' +
        'allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen frameborder="0"></iframe>';
      big.style.display = 'none';
      bar.style.display = 'none';
      shade.style.display = 'none';
    }

    /* the iframe is only created on first play — until then the
       poster shows and nothing from YouTube loads */
    function firstPlay() {
      if (st.apiStarted) return;
      st.apiStarted = true;
      big.classList.add('loading');
      loadApi().then(function () {
        if (st.destroyed) return;
        if (!(window.YT && window.YT.Player)) { fallbackIframe(); return; }
        st.player = new YT.Player(slot, {
          videoId: id,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            iv_load_policy: 3,
            fs: 0,
            disablekb: 1,
            playsinline: 1,
          },
          events: {
            onReady: function (e) {
              if (st.destroyed) return;
              st.ready = true;
              root.classList.add('is-live');
              big.classList.remove('loading');
              try { st.duration = e.target.getDuration() || 0; } catch (err) { /* */ }
              try { e.target.playVideo(); } catch (err) { /* */ }
              startPoll();
              /* if the browser blocks unmuted autoplay the PLAYING
                 state never arrives and the big button stays for a tap */
              setTimeout(function () {
                if (!st.destroyed && !st.playing && st.ready) big.classList.remove('loading');
              }, 1600);
            },
            onStateChange: function (e) {
              if (e.data === YT.PlayerState.PLAYING)      setPlayingUI(true);
              else if (e.data === YT.PlayerState.PAUSED)  setPlayingUI(false);
              else if (e.data === YT.PlayerState.ENDED) { setPlayingUI(false); big.classList.remove('loading'); }
            },
          },
        });
      });
    }

    big.addEventListener('click', function (e) { e.stopPropagation(); firstPlay(); });
    btnPlay.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!st.player || !st.ready) { firstPlay(); return; }
      try { if (st.playing) st.player.pauseVideo(); else st.player.playVideo(); } catch (err) { /* */ }
    });
    shade.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!st.player || !st.ready) { firstPlay(); return; }
      try { if (st.playing) st.player.pauseVideo(); else st.player.playVideo(); } catch (err) { /* */ }
    });
    btnMute.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!st.player || !st.ready) return;
      try {
        if (st.player.isMuted()) { st.player.unMute(); btnMute.innerHTML = '&#128263;'; }
        else { st.player.mute(); btnMute.innerHTML = '&#128266;'; }
      } catch (err) { /* */ }
    });
    btnFs.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (stage.requestFullscreen) stage.requestFullscreen();
        else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
      } catch (err) { /* fullscreen not available */ }
    });

    /* seek: click or drag on the progress track */
    function seekToClientX(clientX) {
      if (!st.player || !st.ready) return;
      var r = track.getBoundingClientRect();
      if (!r.width) return;
      var frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      try { st.player.seekTo(frac * (st.player.getDuration() || 0), true); } catch (err) { /* */ }
      tick();
    }
    track.addEventListener('click', function (e) { e.stopPropagation(); seekToClientX(e.clientX); });
    track.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      seekToClientX(e.clientX);
      var move = function (ev) { seekToClientX(ev.clientX); };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    /* moving the pointer (or touching) brings the bar back */
    root.addEventListener('pointermove', function () { if (st.playing) scheduleBarHide(); else showBar(); });
    root.addEventListener('pointerleave', function () { if (st.playing) scheduleBarHide(); });

    var handle = {
      root: root,
      pause: function () {
        try { if (st.player && st.ready && st.playing) st.player.pauseVideo(); } catch (err) { /* */ }
      },
      destroy: function () {
        if (st.destroyed) return;
        st.destroyed = true;
        stopPoll();
        if (st.hideTimer) clearTimeout(st.hideTimer);
        try { if (st.player && st.player.destroy) st.player.destroy(); } catch (err) { /* */ }
        if (root.parentNode) root.parentNode.removeChild(root);
        var i = MOUNTED.indexOf(handle);
        if (i !== -1) MOUNTED.splice(i, 1);
      },
    };
    MOUNTED.push(handle);
    if (opts.autoplay) firstPlay();
    return handle;
  }

  return {
    parseYouTube: parseYouTube,
    isYouTube: isYouTube,
    watchUrl: watchUrl,
    thumb: thumb,
    embedProxyUrl: embedProxyUrl,
    uploadVideoToYouTube: uploadVideoToYouTube,
    progressHTML: progressHTML,
    mountPlayer: mountPlayer,
    pauseAll: pauseAll,
    stopIn: stopIn,
    MAX_BYTES: MAX_BYTES,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ArzuzVideo;
