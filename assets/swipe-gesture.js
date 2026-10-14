/* ============================================================
   Arzuz — the shared touch-drag engine (drawer, sheets, lightboxes)

   This is the physics that used to be copied into each surface in
   assets/admin.js. It was extracted so it can be TESTED, which is
   the whole point: it was already one copy per surface once, and
   the reason it became one engine was that a fix to the flick
   threshold had to be made three times or be wrong twice.

   The same reasoning applies to a regression. Every bug this engine
   can have is invisible in a screenshot and hard to catch by hand:

     · the slop gate deciding which axis a finger meant — get this
       wrong and a vertical scroll drags a drawer sideways;
     · the TICK-window velocity sample — get this wrong and a stale
       sample drags the average towards a speed the finger is no
       longer doing, so a slow drag is thrown away;
     · pointer ownership — get this wrong and a resting thumb drags
       the surface out from under the finger that is actually moving;
     · the click seal — get this wrong and a throw that lands on a
       button presses it, or (the other way) swallows the composer's
       own programmatic Cancel click.

   So the engine takes its event target from `opts.target`, defaulting
   to the document. That single seam is what lets dev/gesture-harness.mjs
   drive the real engine with synthetic pointer events in Node, with no
   browser and no second copy of the physics to drift out of step. A
   harness that re-implemented any of the four rules above would only
   be testing its own arithmetic.

   Loads as window.ArzuzSwipeGesture in a browser and via require() in
   Node, exactly like assets/api-errors.js. ES5, no deps.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzSwipeGesture = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SLOP = 8;      /* px before the gesture claims an axis */
  var TICK = 90;     /* ms of history the velocity sample may span */
  var DECAY = 0.998; /* Apple's projection decay, WWDC 2018 */

  function SwipeGesture(opts) {
    opts = opts || {};
    var axis = opts.axis === 'x' ? 'x' : 'y';
    /* the one thing that differs from the original copy: where the
       listeners go. A test hands in a fake target; a page gets the
       document it always had. */
    var target = opts.target || (root && root.document);

    var live = false, moved = false, P0 = 0, C0 = 0, LAST = 0, PID = null, SAMPLES = [];

    function stamp(e) { return e.timeStamp || Date.now(); }
    function along(e) { return axis === 'x' ? e.clientX : e.clientY; }
    function across(e) { return axis === 'x' ? e.clientY : e.clientX; }
    function touchy(e) { return !!(e.pointerType === 'touch' || e.pointerType === 'pen'); }

    function track(p, t) {
      SAMPLES.push({ p: p, t: t });
      while (SAMPLES.length > 2 && t - SAMPLES[0].t > TICK) SAMPLES.shift();
    }

    function velocity() {
      if (SAMPLES.length < 2) return 0;
      var a = SAMPLES[0], b = SAMPLES[SAMPLES.length - 1], dt = (b.t - a.t) / 1000;
      return dt ? (b.p - a.p) / dt : 0;
    }

    /* where a flick would coast to if nothing stopped it (px) */
    function project(v) { return (v / 1000) * DECAY / (1 - DECAY); }

    /* the point of the seal is that the page does not act on the throw;
       a synthetic click is our own code talking, not a finger, so those
       are let through — the composer's unsaved-changes path is a
       programmatic Cancel click and would otherwise be swallowed. */
    function sealClicks() {
      var catchIt = function (e) {
        if (!e.isTrusted) return;
        e.preventDefault(); e.stopPropagation();
      };
      target.addEventListener('click', catchIt, true);
      setTimeout(function () { target.removeEventListener('click', catchIt, true); }, 300);
    }

    function onDown(e) {
      if (live || e.button || !touchy(e) || !opts.canStart(e)) return;
      live = true; moved = false; PID = e.pointerId;
      P0 = along(e); C0 = across(e); LAST = 0;
      SAMPLES.length = 0;
      track(P0, stamp(e));
    }

    function onMove(e) {
      /* one finger owns the gesture: a second one touching down (or a
         resting thumb) must not drag the surface out from under it */
      if (!live || e.pointerId !== PID) return;
      var d = along(e) - P0, c = across(e) - C0;
      if (!moved) {
        if (Math.abs(d) < SLOP && Math.abs(c) < SLOP) return;
        /* the axis is claimed once, at the slop gate: a sideways drag or
           a direction this surface cannot travel in ends the gesture
           before it paints anything */
        if (Math.abs(c) > Math.abs(d) || (opts.allow && !opts.allow(d))) {
          live = false;
          if (opts.onAbort) opts.onAbort();
          return;
        }
        moved = true;
        if (opts.onBegin) opts.onBegin(d);
      }
      LAST = d;
      track(along(e), stamp(e));
      opts.onDrag(d);
      if (e.cancelable) e.preventDefault();   /* we own this gesture now */
    }

    function onUp(e) {
      if (!live || (e && e.pointerId !== undefined && e.pointerId !== PID)) return;
      var wasMoved = moved, v = velocity();
      if (e && e.type === 'pointerup') LAST = along(e) - P0;
      live = false; moved = false; PID = null;
      if (!wasMoved) return;                  /* plain tap: the click proceeds */
      sealClicks();
      opts.onEnd(v, LAST, project(v));
    }

    target.addEventListener('pointerdown', onDown, true);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp, true);
    target.addEventListener('pointercancel', onUp, true);

    /* Kept off the public surface on purpose: a page has no business
       reaching into a live gesture, and exposing it would invite the
       state to be poked from outside rather than end. The harness only
       needs to know whether a gesture is in flight, which `opts` can
       report through its own callbacks. */
    return { SLOP: SLOP, TICK: TICK, DECAY: DECAY, project: project };
  }

  return SwipeGesture;
});
