/* ============================================================
   Arzuz — 3D motion layer
   Dependency-free. No build step, no library, no CDN.
   Written for the site's 3G-on-Android budget: one shared
   requestAnimationFrame loop, transform/opacity only, and it
   stops completely when nothing is moving or nothing is on screen.

   Markup contract
   ---------------
   [data-scene]              perspective stage. The stage rotates with
                             the pointer; children carrying data-depth
                             drift against it.
     [data-scene-stage]      the element that actually rotates
                             (defaults to [data-scene] itself)
     [data-depth="0..1"]     a layer. 0 = the far plate, 1 = nearest.
                             optional data-z="<px>" lifts it off the plane

   [data-tilt]               pointer-tracked 3D tilt + sheen on hover
     [data-layer="0..1"]     inner layer lifted toward the viewer while
                             the card is active (depth inside the card)

   [data-rise]               3D entrance when it scrolls into view.
                             Stagger is derived from the element's
                             position among its [data-rise] siblings.

   ArzuzMotion.init() auto-runs on parse/DOMContentLoaded.
   ArzuzMotion.scan() re-binds after a DOM injection (a MutationObserver
   already does this for you — scan() is the manual escape hatch).

   prefers-reduced-motion: scenes and tilt are never bound; reveals land
   on their final frame immediately. Coarse pointers (touch) never bind
   tilt — a tap would otherwise fire a false hover.
   ============================================================ */
var ArzuzMotion = (function () {
  /* This line is the whole no-JS safety net. The stylesheet only hides
     [data-rise]/.rv underneath html.motion-ready, and it is set here while
     the parser is still at the end of <body> — synchronously, before first
     paint, so nothing flashes. If this file is blocked, 404s, or is never
     fetched at all, the class never lands and every reveal target renders in
     place instead of staying invisible forever. */
  document.documentElement.classList.add('motion-ready');

  var reduce = false, fine = false;

  /* tuning — one place, so the whole site moves with one personality */
  var MAX_TILT = 8;      /* deg. Past ~12 a card reads as a gimmick */
  var TILT_LIFT = 9;     /* px the hovered card rises */
  var TILT_LAYER = 24;   /* px of depth for [data-layer="1"] inside a card */
  var SCENE_TILT_X = 6;  /* deg of stage pitch at full pointer deflection */
  var SCENE_TILT_Y = 9;  /* deg of stage yaw */
  var PARALLAX = 20;     /* px of layer travel at depth 1 */
  var LERP = 0.14;       /* per-frame approach; ~8 frames to settle */

  var scenes = [];
  var sceneIo = null, riseIo = null, watcher = null;
  var raf = null, current = null, currentLayers = [], scanTimer = null;

  function all(sel, root) {
    return [].slice.call((root || document).querySelectorAll(sel));
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* Every value this file writes into the DOM passes through num() first.
     The style write is the boundary: CSS drops an invalid declaration
     silently, so a `translate3d(NaNpx, …)` leaves the element wherever the
     last valid frame put it while the loop keeps firing — a stuck plate with
     no error anywhere. Non-finite input becomes 0 at the source instead. */
  function num(v) { v = parseFloat(v); return isFinite(v) ? v : 0; }

  function motionPrefs() {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }

  /* ---------- the shared frame ---------- */
  function kick() { if (raf === null) raf = window.requestAnimationFrame(frame); }

  function frame() {
    raf = null;
    var busy = false;
    for (var i = 0; i < scenes.length; i++) if (renderScene(scenes[i])) busy = true;
    if (busy) kick();
  }

  /* ---------- scenes ---------- */
  function setupScenes() {
    all('[data-scene]').forEach(function (sc) {
      if (sc.getAttribute('data-scene-bound')) return;
      sc.setAttribute('data-scene-bound', '1');

      var st = {
        sc: sc,
        stage: sc.querySelector('[data-scene-stage]') || sc,
        layers: all('[data-depth]', sc).map(function (el) {
          return {
            el: el,
            d: clamp(num(el.getAttribute('data-depth')), 0, 1),
            z: num(el.getAttribute('data-z'))
          };
        }),
        tx: 0, ty: 0, cx: 0, cy: 0, live: false, dirty: false
      };

      if (fine && !reduce) {
        sc.addEventListener('pointermove', function (e) {
          if (!st.live) return;
          var r = sc.getBoundingClientRect();
          if (!r.width || !r.height) return;
          st.tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
          st.ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
          kick();
        });
        sc.addEventListener('pointerleave', function () {
          st.tx = 0; st.ty = 0; kick();
        });
      }

      scenes.push(st);
      if (sceneIo) sceneIo.observe(sc);
    });
  }

  function renderScene(st) {
    var nx = st.cx + (st.tx - st.cx) * LERP;
    var ny = st.cy + (st.ty - st.cy) * LERP;
    /* the boundary check: a non-finite frame is never written */
    if (!isFinite(nx) || !isFinite(ny)) { nx = 0; ny = 0; }
    var settling = Math.abs(nx - st.tx) > 0.0015 || Math.abs(ny - st.ty) > 0.0015;
    if (!settling) { nx = st.tx; ny = st.ty; }
    if (nx === st.cx && ny === st.cy && !st.dirty) return false;
    st.cx = nx; st.cy = ny; st.dirty = false;

    if (!st.live || !st.stage || !st.stage.style) return false;
    st.stage.style.transform =
      'rotateX(' + (-st.cy * SCENE_TILT_X).toFixed(2) + 'deg)' +
      ' rotateY(' + (st.cx * SCENE_TILT_Y).toFixed(2) + 'deg)';
    for (var i = 0; i < st.layers.length; i++) {
      var l = st.layers[i];
      if (!l.el || !l.el.style) continue;
      /* written on the layer itself — never a CSS variable on a parent,
         which would recalculate style for every descendant */
      l.el.style.transform =
        'translate3d(' + (st.cx * PARALLAX * l.d).toFixed(2) + 'px,' +
        (st.cy * PARALLAX * l.d).toFixed(2) + 'px,' +
        (l.z * l.d).toFixed(1) + 'px)';
    }
    return settling;
  }

  /* ---------- tilt ---------- */
  function enterTilt(el) {
    current = el;
    el.classList.add('tilt-on');
    currentLayers = all('[data-layer]', el);
  }

  function leaveTilt() {
    if (!current) return;
    current.classList.remove('tilt-on');
    current.style.transform = '';
    current.style.removeProperty('--mx');
    current.style.removeProperty('--my');
    for (var i = 0; i < currentLayers.length; i++) currentLayers[i].style.transform = '';
    currentLayers = [];
    current = null;
  }

  function trackTilt(e) {
    var r = current.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var cx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
    var cy = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
    current.style.transform =
      'perspective(900px)' +
      ' rotateX(' + (-cy * MAX_TILT).toFixed(2) + 'deg)' +
      ' rotateY(' + (cx * MAX_TILT).toFixed(2) + 'deg)' +
      ' translate3d(0,' + (-TILT_LIFT).toFixed(1) + 'px,0)' +
      ' scale(1.012)';
    /* the sheen follows the pointer; the coordinates stay on the card itself */
    current.style.setProperty('--mx', ((cx * 0.5 + 0.5) * 100).toFixed(1) + '%');
    current.style.setProperty('--my', ((cy * 0.5 + 0.5) * 100).toFixed(1) + '%');
    for (var i = 0; i < currentLayers.length; i++) {
      var cl = currentLayers[i];
      if (!cl || !cl.style) continue;
      var d = clamp(num(cl.getAttribute('data-layer')), 0, 1);
      cl.style.transform =
        'translate3d(' + (cx * 8 * d).toFixed(1) + 'px,' + (cy * 8 * d).toFixed(1) + 'px,' +
        (TILT_LAYER * d).toFixed(1) + 'px)';
    }
  }

  function bindTilt() {
    document.addEventListener('pointermove', function (e) {
      if (!fine || reduce) return;
      /* touch fires a hover on tap; a card that jumps under a finger is a bug */
      if (e.pointerType && e.pointerType !== 'mouse') { leaveTilt(); return; }
      var el = e.target && e.target.closest ? e.target.closest('[data-tilt]') : null;
      if (el !== current) { leaveTilt(); if (el) enterTilt(el); }
      if (current) trackTilt(e);
    }, { passive: true });

    document.addEventListener('pointerout', function (e) {
      if (!current) return;
      if (!e.relatedTarget || !current.contains(e.relatedTarget)) leaveTilt();
    }, { passive: true });

    /* wheel-scrolling while hovering would leave a card tilted under the
       cursor's old position; clearing writes no layout on scroll */
    window.addEventListener('scroll', function () { leaveTilt(); }, { passive: true });
  }

  /* ---------- reveals ---------- */
  function markStagger(el) {
    if (el.style.getPropertyValue('--i')) return;
    var n = 0, prev = el.previousElementSibling;
    while (prev) { if (prev.hasAttribute('data-rise')) n++; prev = prev.previousElementSibling; }
    el.style.setProperty('--i', String(Math.min(n, 6)));
  }

  /* The stagger belongs to the entrance only. Once a card has landed, drop
     its --i so the transition-delay sits in front of nothing — otherwise a
     hover-out on the seventh card would wait 360ms before springing home. */
  function clearStagger(el) {
    window.setTimeout(function () { el.style.setProperty('--i', '0'); }, 1400);
  }

  function reveal() {
    var pending = all('[data-rise]:not(.in)');
    if (!pending.length) return;
    pending.forEach(markStagger);
    if (reduce || !('IntersectionObserver' in window)) {
      pending.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    pending.forEach(function (el) { riseIo.observe(el); });
  }

  function scan() { reveal(); setupScenes(); }

  function init() {
    if (document.body && document.body.getAttribute('data-motion-bound')) return;
    if (document.body) document.body.setAttribute('data-motion-bound', '1');
    motionPrefs();

    if ('IntersectionObserver' in window) {
      sceneIo = new IntersectionObserver(function (rows) {
        rows.forEach(function (r) {
          for (var i = 0; i < scenes.length; i++) {
            if (scenes[i].sc === r.target) {
              scenes[i].live = r.isIntersecting;
              scenes[i].dirty = true;
              if (r.isIntersecting) kick();
            }
          }
        });
      }, { rootMargin: '120px' });

      /* threshold 0, not a fraction of the element. A ratio can never be
         satisfied at all for an element taller than the root (a long legal
         table, a full-height card), and a fast flick can step a short one
         over between two samples. Any pixel crossing the line is enough, and
         because a target stays observed until it has actually revealed, one
         that was skipped lands the moment it is next in view — never
         permanently invisible. */
      riseIo = new IntersectionObserver(function (rows) {
        rows.forEach(function (r) {
          if (!r.isIntersecting) return;
          r.target.classList.add('in');
          riseIo.unobserve(r.target);
          clearStagger(r.target);
        });
      }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
    }

    if (fine && !reduce) bindTilt();
    scan();
    bindHeader();

    if ('MutationObserver' in window) {
      watcher = new MutationObserver(function () {
        if (scanTimer) return;
        scanTimer = window.setTimeout(function () { scanTimer = null; reveal(); }, 120);
      });
      watcher.observe(document.body, { childList: true, subtree: true });
    }

    var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    var onChange = function () { motionPrefs(); if (reduce) { leaveTilt(); reveal(); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* Scroll-linked header: shadow when scrolled, hide on scroll-down, show
     on scroll-up. Matches native iOS app behavior. Uses passive listener
     so it never blocks the scroll compositor thread. */
  function bindHeader() {
    var h = document.querySelector('header');
    if (!h) return;
    var last = window.scrollY;
    var hidden = false;
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      h.classList.toggle('scrolled', y > 4);
      /* Only apply hide/show past 80px — avoids jitter at the very top */
      if (y > 80) {
        var goingDown = y > last;
        if (goingDown && !hidden) {
          h.classList.add('header-hidden');
          hidden = true;
        } else if (!goingDown && hidden) {
          h.classList.remove('header-hidden');
          hidden = false;
        }
      } else {
        h.classList.remove('header-hidden');
        hidden = false;
      }
      last = y;
    }, { passive: true });
  }

  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
  boot();

  return { init: init, scan: scan, leaveTilt: leaveTilt };
})();
