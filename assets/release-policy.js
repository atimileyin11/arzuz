/* ============================================================
   Arzuz — the release policies of the three touch surfaces
   (the drawer, the bottom sheets and the lightboxes)

   Every one of these surfaces is dragged 1:1 by a finger and then
   let go, and what happens at the moment of release is a decision:

     · where the drawer lands — open or shut — from where the finger
       left it, its own width, and the momentum coast;
     · whether a sheet or a lightbox is thrown away, at max(90px,
       30% of its height), or by a flick that wins outright;
     · how far past either resting edge the door gives against its
       hinge, and how much of a coast may carry the decision.

   That decision used to be arithmetic written inline at each of the
   three call sites in assets/admin.js — four constants repeated
   twice, the same paint formula three times, and a release rule no
   test could reach without booting the whole dashboard and driving
   real pointer events at it. Which meant the policy could only ever
   be sampled at a handful of geometries: one drag at one size
   exercises one branch of max(90, 30%) and nothing at all of the
   flick or of the momentum coast.

   So the arithmetic lives here, once, with no DOM and no globals.
   admin.js keeps the state (which gesture is live, where the finger
   has taken the surface) and calls in for the numbers; this file is
   pure, so dev/release-policy-test.mjs (`npm run test:policy`) can
   sweep it across hundreds of geometries, distances and velocities
   with no sandbox at all. What THAT suite cannot say is whether the
   page wires any of this up — that stays with the admin boot suite
   (`npm run test:admin`), which drives the same functions through
   real pointer sequences against the real scripts.

   WHAT IT IS NOT: the physics. The slop gate, the velocity sample,
   pointer ownership and the click seal are assets/swipe-gesture.js.
   This file starts where onEnd() does — it is handed the velocity,
   the distance and the projection, and answers what the release
   means.

   PRECONDITION: every function here takes a width or a height that
   is at least 1px, which is what drawerWidth() and the `|| 1` on
   each surface's own height already guarantee at the call sites. A
   measured width of 0 (a hidden drawer) is not a width — it is the
   absence of one, and drawerWidth() answers with the stylesheet's
   own fallback rather than dividing by it.

   Loads as window.ArzuzReleasePolicy in a browser and via require()
   in Node, exactly like assets/swipe-gesture.js and
   assets/api-errors.js. ES5, no deps.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzReleasePolicy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- the drawer ---------------------------------------------------

     Half its own width is the line. Past either resting edge the door
     gives against its hinge at RATIO, so a finger dragged 200px past a
     262px panel moves it 262 + 38 * 0.18 rather than 462 — overscroll
     for a door, not for a scroll view.

     A flick wins outright, by its sign: |v| > FLICK opens on a
     rightward flick and shuts on a leftward one wherever the finger
     happened to leave it.

     The coast (Apple's momentum projection, computed by the engine)
     may carry the decision 0.4 of the width further open, or 1.2 of it
     back towards shut — the extra margin there is room to overshoot the
     shut edge, where the door already gives at RATIO. */
  var DRAWER = {
    RATIO: 0.18,
    OPEN_MIN: 0.5,
    FLICK: 280,
    COAST_OPEN: 0.4,
    COAST_BACK: 1.2
  };

  /* ---- the sheets and the lightboxes --------------------------------

     One policy, both surfaces: thrown away when the finger plus its
     coast clears max(FAR, OPEN_MIN * height) — a 90px floor that
     decides for a short sheet and 30% of the height that decides for a
     tall one — or by a downward flick at any distance at all. Lifting
     the surface up RESISTS at RATIO instead of tracking, and the coast
     of an upward throw may not count against the dismiss. */
  var SURFACE = {
    RATIO: 0.4,
    OPEN_MIN: 0.3,
    FAR: 90,
    FLICK: 280
  };

  /* The drawer's fallback geometry, which is also the stylesheet's own
     `.admin-side { width: min(82vw, 288px) }` in the mobile block. Two
     files, one number: a change to that rule has to land here too. */
  var WIDTH_SHARE = 0.82;
  var WIDTH_MAX = 288;

  /* how far the backdrop dims at full open */
  var SCRIM = 0.62;

  function freeze(o) {
    return (Object.freeze ? Object.freeze(o) : o);
  }

  /* ---- the drawer --------------------------------------------------- */

  /* A hidden drawer measures 0x0 — in a browser as in the harness — so a
     zero or unmeasurable width is not a width to decide against: it
     answers with the fallback the stylesheet would have laid out. */
  function drawerWidth(measured, innerWidth) {
    return measured ? measured : Math.min(innerWidth * WIDTH_SHARE, WIDTH_MAX);
  }

  /* paint(raw): raw is where the finger put the drawer, in px, 0 = fully
     open and -dow = fully shut. Returns what the surface and its grip
     and its backdrop are painted with. */
  function drawerPaint(raw, dow) {
    var x;
    if (raw > 0) x = raw * DRAWER.RATIO;                            /* past the open edge */
    else if (raw < -dow) x = -dow + (raw + dow) * DRAWER.RATIO;     /* past the shut edge */
    else x = raw;                                                   /* 1:1 in between */
    return {
      x: x,
      edge: Math.max(0, dow + x),                                   /* the grip rides the leading edge */
      scrim: (Math.max(0, Math.min(1, 1 + x / dow)) * SCRIM).toFixed(3)
    };
  }

  /* paint is invertible: the resistance is applied to the finger's own
     position, so the finger's position is recoverable from the paint.
     That is what lets a release decide on the LOGICAL position and a
     flick decide on velocity alone. */
  function drawerLogical(cur, dow) {
    if (cur > 0) return cur / DRAWER.RATIO;
    if (cur < -dow) return -dow + (cur + dow) / DRAWER.RATIO;
    return cur;
  }

  function drawerCoast(proj, dow) {
    return Math.max(-DRAWER.COAST_BACK * dow, Math.min(DRAWER.COAST_OPEN * dow, proj));
  }

  /* where does the drawer land? `cur` is the raw position the finger
     left it at, `proj` the coast the engine projects for it. */
  function drawerRelease(v, cur, proj, dow) {
    if (Math.abs(v) > DRAWER.FLICK) return v > 0;
    return drawerLogical(cur, dow) + drawerCoast(proj, dow) >= -dow * DRAWER.OPEN_MIN;
  }

  /* ---- the sheets and the lightboxes -------------------------------- */

  /* Where the finger put the surface: 1:1 pulled down, resisted at RATIO
     when lifted. A pull down is not clamped at the surface's own height —
     the sheet leaves the screen entirely, which is what the slide-away
     then continues from. */
  function surfacePaint(dy) {
    return dy > 0 ? dy : dy * SURFACE.RATIO;
  }

  /* A coast only ever adds: it is the momentum of a throw, so it cannot
     un-dismiss a pull that already cleared the line, and it counts for
     at most the surface's own height. */
  function surfaceCoast(proj, height) {
    return Math.max(0, Math.min(height, proj));
  }

  /* Thrown away when the finger plus its coast clears max(90, 30% of the
     height) — the line is computed here, in the one place the decision is
     made, rather than by each caller. */
  function surfaceRelease(v, dy, proj, height) {
    if (v > SURFACE.FLICK) return true;
    return surfacePaint(dy) + surfaceCoast(proj, height) >= Math.max(SURFACE.FAR, height * SURFACE.OPEN_MIN);
  }

  /* ---- the CONTRACT, and the registry that makes it unavoidable ----

     Three surfaces are dragged on this page today and there is nothing
     stopping a fourth from being added with its own arithmetic written
     beside it — which is exactly how the four constants came to be copied
     into three call sites in the first place. So a surface is registered
     here by NAME, with the selector the page lays it out under:

       policyFor('sheet').release(v, dy, proj, h)

     `policyFor` throws for a name it does not know, naming the ones it has,
     so a surface cannot be dragged by inventing a name. And because each
     registration carries its OWN overlay selector, the boot suite can walk
     the page's HTML and fail when it finds a dismissible overlay — anything
     classed as an overlay, a lightbox or the side panel — that no
     registration claims. That is the half a module cannot enforce by
     itself: the module cannot see the page, so the page's own file is read
     by the test that holds this list to it.

     A registration is a KIND (which policy it obeys) plus the facts that are
     about the surface rather than the policy: the selector the page lays it
     out under, and how far past its own size a throw paints it — null for a
     surface that leaves by a class rather than a paint, which is the drawer.
     Everything a caller may do with a surface goes through here, and each
     entry hands back the SAME function objects the module implements, never
     a copy of them. */
  var REGISTRY = {
    drawer:   { kind: 'drawer',  overlay: '.admin-side',     thrownOffset: null },
    sheet:    { kind: 'surface', overlay: '.modal-overlay',  thrownOffset: 40 },
    lightbox: { kind: 'surface', overlay: '.lightbox',       thrownOffset: 60 }
  };

  function surfaceNames() {
    return Object.keys(REGISTRY);
  }

  /* the contract every registered surface satisfies, and the only way a call
     site should reach the arithmetic below */
  function policyFor(name) {
    var reg = REGISTRY[name];
    if (!reg) {
      throw new Error('ArzuzReleasePolicy: no policy for "' + name + '" \u2014 ' +
        'register it in REGISTRY. Known surfaces: ' + surfaceNames().join(', '));
    }
    var isDrawer = reg.kind === 'drawer';
    return {
      name: name,
      kind: reg.kind,
      overlay: reg.overlay,
      /* the px line this surface's release is decided against, for a size */
      line: function (size) {
        return isDrawer ? Math.ceil(size * DRAWER.OPEN_MIN)
          : Math.max(SURFACE.FAR, size * SURFACE.OPEN_MIN);
      },
      /* leave the resting state? (drawer: open; sheet/lightbox: dismissed) */
      release: isDrawer ? drawerRelease : surfaceRelease,
      /* where a throw paints it, from the size it divided — or null, for the
         drawer, whose release toggles a class and paints no throw at all */
      thrown: function (size) {
        return reg.thrownOffset === null ? null : (size + reg.thrownOffset) + 'px';
      },
      constants: isDrawer ? DRAWER : SURFACE
    };
  }

  return {
    REGISTRY: freeze(REGISTRY),
    surfaceNames: surfaceNames,
    policyFor: policyFor,
    DRAWER: freeze(DRAWER),
    SURFACE: freeze(SURFACE),
    WIDTH_SHARE: WIDTH_SHARE,
    WIDTH_MAX: WIDTH_MAX,
    SCRIM: SCRIM,
    drawerWidth: drawerWidth,
    drawerPaint: drawerPaint,
    drawerLogical: drawerLogical,
    drawerCoast: drawerCoast,
    drawerRelease: drawerRelease,
    surfacePaint: surfacePaint,
    surfaceCoast: surfaceCoast,
    surfaceRelease: surfaceRelease
  };
});
