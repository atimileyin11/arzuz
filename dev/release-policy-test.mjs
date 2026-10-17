#!/usr/bin/env node
/* ============================================================
   Arzuz — the release policies of the drawer, the bottom sheets
   and the lightboxes (assets/release-policy.js)

   Run: npm run test:policy   (or directly: node dev/release-policy-test.mjs)

   WHAT THIS IS FOR
     Where a throw lands, when a sheet is dismissed and what a
     momentum coast may carry are decisions, and a decision is a
     step function of the finger: it holds for every distance short
     of its line and goes for every distance past it. That makes two
     things true of a policy that is right, and both of them are
     arithmetic rather than anything visible:

       · the verdict changes exactly ONCE across the whole travel,
         at the line the policy documents, in pixels;
       · the flick and the coast — the other half of every release —
         are decided by the same line, and neither may promote a
         pull the distance rule would refuse, or refuse one it
         would take.

     The boot suite (npm run test:admin) drives the same arithmetic
     through real pointer sequences against the real page, at the
     handful of geometries a phone actually lays out. This file has
     no DOM, no sandbox and no boot, so it can sweep HUNDREDS of
     geometries, every INTEGER distance at each, and a range of real
     velocities — 4,000px/s either way in 5px/s steps, every one of
     them pushed through the engine's own projection into the release
     — which is the only way the flick branch, the coast clamps, the
     sub-floor case (a surface shorter than the 90px floor) and the
     seam between the engine's momentum and the release decision get
     covered at all. 14.5 million cases, under two seconds.

     The velocities are the reason this file is not the whole story on
     its own, and not a weaker version of it either — but the seam runs
     through the projection, so exactly who owns what is worth writing
     down:

       · the projection's own ARITHMETIC (its slope, scale and sign) is
         the gesture suite's. It drives 310 real throws and compares
         each projection with Apple's decay curve. DECAY changed to
         0.999 passes every check in THIS file and fails on the first
         velocity there.
       · what a RELEASE makes of the numbers is this file's. A release
         that took the absolute value of the velocity fails here and
         nowhere else, because the engine never runs here — it is
         borrowed, never copied.

     Neither suite is sufficient, and each was mutated to show which
     half it misses.

   HOW IT IS REGISTERED, AND WHY THE NAME MATTERS
     `test:policy` is in ORDER in dev/run-tests.mjs, so `npm test`
     runs it and reports it like every other suite, and the strict
     gate's pairing (scripts/test-all.mjs derives its list from
     package.json) fails if either half of that pairing is removed.
     A suite nobody invokes is a comment — the same rule the
     gesture harness is held to.

   WHAT IT DOES NOT COVER
     Whether the page WIRES this up. That admin.js calls
     drawerPaint/drawerRelease/surfaceRelease at all, with the right
     state and the right geometry, and that the release then paints
     what this file says it should, is the admin boot suite's job:
     13 sweeps, 5,077 real drags, and a boundary pair at each
     geometry's own line.     Nor does it cover the physics that feeds
     these functions (dev/gesture-test.mjs) or the real thing —
     CSS transitions, layout, browser gesture arbitration — which is
     dev/mobile-qa-checklist.md and a phone. It borrows project()
     rather than copying it, so it can see that a projection kept its
     sign and cannot see that the curve behind it still has the scale
     Apple's does: that one number is the gesture suite's to defend.
   ============================================================ */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RP = require('../assets/release-policy.js');
const SwipeGesture = require('../assets/swipe-gesture.js');

let failures = 0;
let cases = 0;
/* Strict on purpose: the sweep helpers below hand back the FIRST reason a
   sweep failed as a STRING, and a non-empty string is truthy. A `check` that
   merely tested truthiness would print every one of those failures as a tick
   — which is exactly what happened here until a mutation that should have
   failed an aggregate check sailed through it. Same rule as the boot suite. */
function check(name, ok) {
  const pass = ok === true || (ok && typeof ok !== 'string');
  console.log((pass ? '  ✓ ' : '  ✗ ') + name + (pass ? '' : '  → ' + ok));
  if (!pass) failures++;
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
/* the first reason a sweep failed, or `true` — the strict check above is what
   makes the string case a failure rather than a tick */
const describe = list => (list.length === 0 ? true : list[0].why);

/* ------------------------------------------------------------
   THE SPEC, written out rather than imported from the module: a
   test that read the constants it is checking would agree with any
   value. Everything below is derived from these, so a number that
   moves in assets/release-policy.js and not here fails loudly.
   ------------------------------------------------------------ */
const FAR = 90;                  /* the floor, px */
const SURFACE_OPEN_MIN = 0.3;    /* the share of the surface's height */
const SURFACE_RATIO = 0.4;       /* its resistance when lifted */
const FLICK = 280;               /* px/s: past this a flick decides by sign */
const DRAWER_OPEN_MIN = 0.5;     /* the share of the drawer's width */
const DRAWER_RATIO = 0.18;       /* its give past a resting edge */
const COAST_OPEN = 0.4;          /* the most a coast may carry open */
const COAST_BACK = 1.2;          /* and the most it may carry back */
const WIDTH_SHARE = 0.82;        /* the stylesheet's min(82vw, 288px) */
const WIDTH_MAX = 288;

/* every integer height there is, from one pixel to the tallest sheet
   the CSS cap can produce on a phone */
const HEIGHTS = [];
for (let h = 1; h <= 900; h++) HEIGHTS.push(h);

/* a spread of them for the sweeps that are quadratic in the height */
const SOME_HEIGHTS = HEIGHTS.filter(h => h % 13 === 0);

/* every viewport width, and a spread of them for the same reason */
const WIDTHS = [];
for (let w = 200; w <= 1200; w++) WIDTHS.push(w);
const SOME_WIDTHS = WIDTHS.filter(w => w % 29 === 0);

/* where the surface policy's line sits, for a height */
const surfaceLine = h => Math.ceil(Math.max(FAR, h * SURFACE_OPEN_MIN));
const dowOf = w => Math.min(w * WIDTH_SHARE, WIDTH_MAX);

console.log('\n=== RELEASE POLICIES (no DOM, no sandbox, no boot) ===');

/* ------------------------------------------------------------
   1. The spec the module publishes
   ------------------------------------------------------------ */
console.log('\n-- the published policy --');
check('a sheet or a lightbox is dismissed at max(90px, 30% of its height), flick > 280px/s, resisted at 0.4 when lifted',
  RP.SURFACE.FAR === FAR && RP.SURFACE.OPEN_MIN === SURFACE_OPEN_MIN &&
  RP.SURFACE.RATIO === SURFACE_RATIO && RP.SURFACE.FLICK === FLICK);
check('the drawer opens at half its own width, gives at 0.18 past a resting edge, flick > 280px/s',
  RP.DRAWER.OPEN_MIN === DRAWER_OPEN_MIN && RP.DRAWER.RATIO === DRAWER_RATIO && RP.DRAWER.FLICK === FLICK);
check('its momentum coast may carry 0.4 of the width open and 1.2 of it back',
  RP.DRAWER.COAST_OPEN === COAST_OPEN && RP.DRAWER.COAST_BACK === COAST_BACK);
check('the fallback width is the stylesheet\'s own min(82vw, 288px)',
  RP.WIDTH_SHARE === WIDTH_SHARE && RP.WIDTH_MAX === WIDTH_MAX);
check('the policy tables are frozen, so a page cannot drift them at runtime',
  Object.isFrozen(RP.DRAWER) && Object.isFrozen(RP.SURFACE));
{
  /* The file's own prose is allowed to say "window" — it is describing where
     the module loads. What has to be true of the CODE is that nothing in it
     reaches for a document, a window or an element, because that is exactly
     what lets this suite sweep it in plain Node. */
  const code = readFileSync(join(ROOT, 'assets/release-policy.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')          /* drop the block comments */
    .replace(/^\s*\/\/.*$/gm, '');              /* and the line comments */
  check('the module\'s code reaches for no document, no window and no element — which is the whole reason a Node suite can sweep it',
    !/\bdocument\b|\bwindow\b|\bgetElementById\b|\bstyle\b/.test(code));
}

/* ------------------------------------------------------------
   2. The settled line, at EVERY integer height
   ------------------------------------------------------------ */
{
  const bad = [];
  let flipped = 0;
  for (const h of HEIGHTS) {
    const line = surfaceLine(h);
    const max = Math.max(h, line + 4);
    let first = null, flips = 0, prev = null;
    for (let d = 0; d <= max; d++) {
      const goes = RP.surfaceRelease(0, d, 0, h);
      cases++;
      if (prev !== null && goes !== prev) { flips++; flipped++; }
      if (goes && first === null) first = d;
      prev = goes;
    }
    if (flips !== 1 || first !== line) {
      bad.push({ why: 'at ' + h + 'px the first dismiss is ' + first + 'px after ' + flips +
        ' flip(s), and the policy line is ' + line + 'px' });
    }
  }
  check('over all ' + HEIGHTS.length + ' heights, a settled pull is dismissed at exactly max(90px, 30%) — one flip, at the documented line',
    describe(bad));
  check('every one of them reaches its own line: ' + HEIGHTS.length + ' geometries, ' + flipped + ' flips in all',
    HEIGHTS.length > 600 && flipped === HEIGHTS.length);
}
{
  /* the two branches of max(90, 30%) — a 90px floor that decides for a
     short surface and a percentage that decides for a tall one — and the
     case where the line is not on the surface at all */
  const under = HEIGHTS.filter(h => FAR > h * SURFACE_OPEN_MIN);
  const over = HEIGHTS.filter(h => h * SURFACE_OPEN_MIN > FAR);
  const beyond = HEIGHTS.filter(h => surfaceLine(h) > h);
  check('both branches are exercised: ' + under.length + ' heights under the branch point and ' + over.length + ' over it',
    under.length > 200 && over.length > 200);
  check(beyond.length + ' of them are shorter than the 90px floor itself, so their line is beyond their own height (' +
    beyond.map(h => h + 'px\u2192' + surfaceLine(h) + 'px').slice(0, 3).join(', ') + '\u2026)',
    beyond.length === HEIGHTS.filter(h => h < FAR).length && beyond.every(h => surfaceLine(h) > h));
}
{
  /* and on those, a pull of the surface's whole height is still not a
     dismiss: it takes a distance longer than the surface to dismiss one */
  const short = 40, line = surfaceLine(short);
  check('a surface shorter than the floor is not dismissed by a pull of its own height, only by one past the line',
    RP.surfaceRelease(0, short, 0, short) === false &&
    RP.surfaceRelease(0, line - 1, 0, short) === false &&
    RP.surfaceRelease(0, line, 0, short) === true);
  cases += 3;
}

/* ------------------------------------------------------------
   3. The flick — the half a settled sweep cannot reach
   ------------------------------------------------------------ */
{
  const bad = [];
  for (const h of HEIGHTS) {
    const line = surfaceLine(h);
    for (const d of [0, 1, 8, Math.max(0, line - 1), line, h]) {
      cases += 3;
      if (RP.surfaceRelease(FLICK + 1e-6, d, 0, h) !== true) {
        bad.push({ why: 'a ' + (FLICK + 1e-6) + 'px/s flick was refused at ' + d + 'px on a ' + h + 'px surface' });
      }
      if (RP.surfaceRelease(-FLICK - 1e-6, d, 0, h) !== (d >= line)) {
        bad.push({ why: 'an upward flick at ' + d + 'px on a ' + h + 'px surface did not fall back to the distance rule' });
      }
      if (RP.surfaceRelease(FLICK, d, 0, h) !== (d >= line)) {
        bad.push({ why: 'exactly ' + FLICK + 'px/s at ' + d + 'px on a ' + h + 'px surface was not read as a non-flick' });
      }
    }
  }
  check('a downward flick dismisses at every distance — including one pixel — and at every height',
    bad.filter(b => b.why.indexOf('flick was refused') !== -1).length === 0);
  check('an upward flick is never a dismiss and never rescues a pull short of the line',
    bad.filter(b => b.why.indexOf('upward flick') !== -1).length === 0);
  check('the flick gate is strict: exactly ' + FLICK + 'px/s is still the distance rule',
    bad.filter(b => b.why.indexOf('non-flick') !== -1).length === 0);
}

/* ------------------------------------------------------------
   4. The coast: what the momentum projection may and may not do
   ------------------------------------------------------------ */
{
  const bad = [];
  for (const h of HEIGHTS) {
    const line = surfaceLine(h);
    cases += 4;
    if (RP.surfaceCoast(-1e9, h) !== 0) bad.push({ why: 'a coast of -1e9 added ' + RP.surfaceCoast(-1e9, h) + 'px on a ' + h + 'px surface' });
    if (RP.surfaceCoast(1e9, h) !== h) bad.push({ why: 'a coast of 1e9 added ' + RP.surfaceCoast(1e9, h) + 'px, not the surface\'s own ' + h + 'px' });
    if (RP.surfaceRelease(0, 0, -1e9, h) !== (0 >= line)) bad.push({ why: 'a reverse coast un-dismissed nothing on a ' + h + 'px surface' });
  }
  check('a coast only ever adds: clamped at zero below, and at the surface\'s own height above, for every height',
    describe(bad));

  /* a coast cannot promote a pull it should not, and cannot fail to
     promote one it should: at the line, exactly one pixel of coast is
     the difference */
  const bad2 = [];
  for (const h of SOME_HEIGHTS) {
    const line = surfaceLine(h);
    for (let k = 1; k <= 25 && k <= h; k++) {
      const d = line - k;
      if (d < 0) continue;
      cases += 2;
      if (RP.surfaceRelease(0, d, k, h) !== true) {
        bad2.push({ why: 'a ' + k + 'px coast did not carry a ' + d + 'px pull over the ' + line + 'px line on a ' + h + 'px surface' });
      }
      if (RP.surfaceRelease(0, d, k - 1, h) !== false) {
        bad2.push({ why: 'a ' + (k - 1) + 'px coast cleared the ' + line + 'px line from ' + d + 'px on a ' + h + 'px surface' });
      }
    }
  }
  check('a coast carries a short pull over the line by exactly what it projects — one pixel less does not',
    describe(bad2));

  /* and the clamp is what stops the coast from dismissing a surface the
     line is not even on: under 90px tall, no projection can reach it */
  const bad3 = [];
  for (const h of HEIGHTS.filter(x => x < FAR)) {
    cases++;
    if (RP.surfaceRelease(0, 0, 1e9, h) !== false) bad3.push({ why: 'a huge coast dismissed a ' + h + 'px surface whose line is ' + surfaceLine(h) + 'px' });
  }
  check('on a surface shorter than the floor, no coast can dismiss it from nothing — the line is off the surface',
    describe(bad3));
}

/* ------------------------------------------------------------
   4b. The momentum from a REAL finger: a range of velocities
       through the engine's own projection

   Sections 3 and 4 hand the release a flick gate and a coast as
   separate inputs, and both of them are faked on one side of the
   seam: this file so far invented its own projections, and the
   gesture suite checks the engine's projection at a single velocity.
   Neither can say what a finger actually doing 1,900px/s gets,
   because the decay curve BETWEEN them is the engine's, and a
   projection that lost its sign or its scale would still leave both
   suites green.

   So this section takes project() off a real SwipeGesture (required
   from assets/swipe-gesture.js — the arithmetic is borrowed, never
   copied) and drives EVERY velocity in a range through it into the
   release, at every distance and every height. It is the only place
   the two halves meet, and it is why `v > 280` is a claim about the
   page rather than about this file's opinion.
   ------------------------------------------------------------ */
{
  /* the engine wants somewhere to hang its four listeners; nothing ever
     fires at this stub, so two no-ops are the whole surface it needs */
  const stub = { addEventListener() {}, removeEventListener() {} };
  const project = new SwipeGesture({ axis: 'y', target: stub }).project;

  /* every velocity a thumb can produce, both ways, in 5px/s steps */
  const VELOCITIES = [];
  for (let v = -4000; v <= 4000; v += 5) VELOCITIES.push(v);

  const badShape = [];
  let lastP = -Infinity;
  for (const v of VELOCITIES) {
    const p = project(v);
    cases++;
    if (v === 0 ? p !== 0 : (v > 0) !== (p > 0)) {
      badShape.push({ why: 'a ' + v + 'px/s finger projected ' + p + 'px' });
    }
    if (p < lastP - 1e-9) {
      badShape.push({ why: 'the projection fell from ' + lastP + 'px to ' + p + 'px as the finger sped up to ' + v + 'px/s' });
    }
    lastP = p;
  }
  check('over ' + VELOCITIES.length + ' velocities from -4,000 to 4,000px/s the engine projects nothing for a still finger, forward for a forward one, backward for a backward one, and further for every faster one',
    describe(badShape));

  /* the two halves, composed: a real velocity, its real projection, the
     release that follows from them. The expectation is the SPEC, written
     from the documented policy — a flick above the gate decides by its
     sign alone, and below it the finger plus at most the surface's own
     height of coast has to clear max(90px, 30%). */
  const COMPOSE_V = [];
  for (let v = -4000; v <= 4000; v += 40) COMPOSE_V.push(v);
  const badSweep = [], badFlick = [];
  const note = (list, why) => { if (list.length < 5) list.push({ why: why }); };

  for (const v of COMPOSE_V) {
    const proj = project(v);
    if (v > FLICK && RP.surfaceRelease(v, 0, proj, 900) !== true) {
      note(badFlick, 'a ' + v + 'px/s flick did not dismiss a 900px surface from a standstill');
    }
    if (v < -FLICK && RP.surfaceRelease(v, -50, proj, 900) !== false) {
      note(badFlick, 'a ' + v + 'px/s flick dismissed a 900px surface from a 50px lift');
    }
    for (const h of SOME_HEIGHTS) {
      /* The line the policy documents is max(90px, 30% of the height) — and it
         is NOT rounded. surfaceLine() takes its ceiling because a settled
         pull can only leave the finger at an integer distance, so ceil is the
         first integer that clears 0.3h. A coast is fractional, and that is
         the difference this composition exists to see: on a 312px surface the
         line is 93.6px, so a 74px pull carrying 19.96px of momentum reaches
         93.96px and IS dismissed — while a settled 74px pull is not, because
         the first integer distance that clears 93.6px is 94px. Both are the
         same rule; an expectation written with the rounded line would call
         the correct answer a failure. */
      const line = surfaceLine(h), thr = Math.max(FAR, h * SURFACE_OPEN_MIN);
      const top = Math.max(h, line + 2);
      for (let d = -top; d <= top; d++) {          /* pulled down, and lifted up (which resists) */
        cases++;
        const coast = Math.max(0, Math.min(h, proj));
        const want = v > FLICK ? true : (RP.surfacePaint(d) + coast >= thr);
        const got = RP.surfaceRelease(v, d, proj, h);
        if (got !== want) {
          note(badSweep, 'a ' + v + 'px/s finger leaving a ' + h + 'px surface at ' + d + 'px (line ' +
            line + 'px, coast ' + coast + 'px) was read as ' + got + ', not ' + want);
        }
      }
    }
  }
  check('a real flick above the gate dismisses from a standstill and a real flick the other way never does, at every velocity the range produces',
    describe(badFlick));
  check('and below the gate the release is the distance rule plus what the engine really projected — every distance on ' +
    SOME_HEIGHTS.length + ' heights, at ' + COMPOSE_V.length + ' velocities, against the line\'s own unrounded value',
    describe(badSweep));

  /* The one place the two readings of the line can disagree, stated rather
     than left implicit in the sweep above: the integer line is the first
     distance a SETTLED pull is dismissed at, and a fractional coast can
     promote the distance one pixel short of it — by exactly the gap. */
  const badEdge = [];
  let edges = 0;
  for (const h of SOME_HEIGHTS) {
    const thr = Math.max(FAR, h * SURFACE_OPEN_MIN), line = surfaceLine(h);
    const need = thr - (line - 1);            /* the coast that closes the gap from one px short */
    if (need <= 0 || need >= h) continue;     /* only where the line is fractional and reachable */
    edges++;
    cases += 2;
    if (RP.surfaceRelease(0, line - 1, need, h) !== true) {
      badEdge.push({ why: 'a ' + need + 'px coast did not carry a ' + (line - 1) + 'px pull over the ' + thr + 'px line on a ' + h + 'px surface' });
    }
    if (RP.surfaceRelease(0, line - 1, need - 1e-9, h) !== false) {
      badEdge.push({ why: 'a hair under ' + need + 'px of coast cleared the ' + thr + 'px line from ' + (line - 1) + 'px on a ' + h + 'px surface' });
    }
  }
  check('the line is unrounded, and that is the only way past it: on ' + edges + ' heights a coast of exactly the gap promotes a pull one pixel short of the integer line, and a hair less does not',
    describe(badEdge));

  /* the drawer, composed the same way: a real flick opens or shuts by its
     sign wherever the finger left it, and below the gate it is half the
     panel against the finger plus the clamped coast */
  const badDrawer = [];
  for (const v of COMPOSE_V) {
    const proj = project(v);
    for (const w of SOME_WIDTHS) {
      const dow = RP.drawerWidth(0, w), half = dow * DRAWER_OPEN_MIN;
      if (v > FLICK && RP.drawerRelease(v, -dow, proj, dow) !== true) {
        note(badDrawer, 'a ' + v + 'px/s rightward flick did not open a ' + dow + 'px drawer held fully shut');
      }
      if (v < -FLICK && RP.drawerRelease(v, 0, proj, dow) !== false) {
        note(badDrawer, 'a ' + v + 'px/s leftward flick did not shut a ' + dow + 'px drawer held fully open');
      }
      for (let cur = -2 * dow; cur <= dow; cur += 5) {
        cases++;
        const coast = RP.drawerCoast(proj, dow);
        const want = Math.abs(v) > FLICK ? v > 0 : (RP.drawerLogical(cur, dow) + coast >= -half);
        const got = RP.drawerRelease(v, cur, proj, dow);
        if (got !== want) {
          note(badDrawer, 'a ' + v + 'px/s finger leaving a ' + dow + 'px drawer at ' + cur + 'px was read as ' +
            got + ', not ' + want);
        }
      }
    }
  }
  check('a real flick decides the drawer by its sign wherever the finger left it, and below the gate it is half the panel against the finger plus the real coast',
    describe(badDrawer));
}

/* ------------------------------------------------------------
   5. The drawer's width: what it decides against
   ------------------------------------------------------------ */
{
  const bad = [];
  for (const w of WIDTHS) {
    cases += 2;
    const fallback = RP.drawerWidth(0, w);
    if (!near(fallback, dowOf(w))) bad.push({ why: 'at a ' + w + 'px viewport an unmeasurable panel fell back to ' + fallback + 'px, not ' + dowOf(w) + 'px' });
    if (fallback > WIDTH_MAX) bad.push({ why: 'the fallback exceeded the stylesheet\'s ' + WIDTH_MAX + 'px cap at ' + w + 'px' });
    if (!(fallback >= 1)) bad.push({ why: 'a ' + w + 'px viewport produced a ' + fallback + 'px panel — every decision below divides by this' });
  }
  check('the fallback is min(82vw, 288px) over all ' + WIDTHS.length + ' viewport widths, and is never zero',
    describe(bad));
  check('a measured panel wins over the fallback — 250px stays 250px, and a hidden panel (0) falls back to ' +
    RP.drawerWidth(0, 390) + 'px',
    RP.drawerWidth(250, 1200) === 250 && RP.drawerWidth(0, 390) === dowOf(390) &&
    RP.drawerWidth(288, 320) === 288 && RP.drawerWidth(0, 320) === dowOf(320));
  cases += 4;
}

/* ------------------------------------------------------------
   6. The drawer's paint, and the round trip a release depends on
   ------------------------------------------------------------ */
{
  const bad = [], badEdge = [], badScrim = [];
  let worstRound = 0;
  for (const w of SOME_WIDTHS) {
    const dow = RP.drawerWidth(0, w);
    /* the backdrop darkens as the door opens, so it rises with the finger */
    let lastScrim = -Infinity;
    for (let raw = -2 * dow; raw <= 2 * dow; raw += 1) {
      const painted = RP.drawerPaint(raw, dow);
      cases++;
      const want = (raw >= -dow && raw <= 0) ? raw
        : (raw > 0 ? raw * DRAWER_RATIO : -dow + (raw + dow) * DRAWER_RATIO);
      if (!near(painted.x, want, 1e-9)) bad.push({ why: 'a finger ' + raw + 'px on a ' + dow + 'px panel painted ' + painted.x + 'px, not ' + want + 'px' });
      worstRound = Math.max(worstRound, Math.abs(RP.drawerLogical(painted.x, dow) - raw));
      if (!near(painted.edge, Math.max(0, dow + painted.x), 1e-9)) badEdge.push({ why: 'the grip sat at ' + painted.edge + 'px for a ' + painted.x + 'px panel position' });
      const s = Number(painted.scrim);
      if (!(s >= 0 && s <= 0.62)) badScrim.push({ why: 'the backdrop read ' + painted.scrim + ' at ' + raw + 'px' });
      if (s < lastScrim - 1e-9) badScrim.push({ why: 'the backdrop brightened as the drawer was pulled open, at ' + raw + 'px' });
      lastScrim = s;
    }
    /* the two ends of it, exactly: opaque at rest and clear at full shut */
    cases += 2;
    if (RP.drawerPaint(0, dow).scrim !== '0.620') badScrim.push({ why: 'the backdrop read ' + RP.drawerPaint(0, dow).scrim + ' at full open' });
    if (RP.drawerPaint(-dow, dow).scrim !== '0.000') badScrim.push({ why: 'the backdrop read ' + RP.drawerPaint(-dow, dow).scrim + ' at full shut' });
  }
  check('1:1 between the resting edges, and ' + DRAWER_RATIO + ' of the finger past either one, over every position on ' +
    SOME_WIDTHS.length + ' panel widths', describe(bad));
  check('the paint ROUND-TRIPS: the logical position the release decides on is the finger\'s own (worst error ' +
    worstRound.toExponential(1) + 'px)', worstRound < 1e-9);
  check('the edge grip rides the leading edge of the door, at every position', describe(badEdge));
  check('the backdrop rises with the door, from 0.000 fully shut to 0.620 fully open, and never brightens on the way',
    describe(badScrim));
}

/* ------------------------------------------------------------
   7. The drawer's release, at the line and by the flick
   ------------------------------------------------------------ */
{
  const badOpen = [], badShut = [], badMono = [];
  for (const w of SOME_WIDTHS) {
    const dow = RP.drawerWidth(0, w);
    const openLine = Math.ceil(dow * DRAWER_OPEN_MIN);
    let first = null, flips = 0, prev = null;
    for (let d = 0; d <= dow + 2; d++) {
      const goes = RP.drawerRelease(0, d - dow, 0, dow);    /* swiped in from the shut edge */
      cases++;
      if (prev !== null && goes !== prev) flips++;
      if (goes && first === null) first = d;
      prev = goes;
    }
    if (flips !== 1 || first !== openLine) {
      badOpen.push({ why: 'on a ' + dow + 'px panel the first opening swipe is ' + first + 'px after ' + flips + ' flip(s), and half its width is ' + openLine + 'px' });
    }
    if (flips !== 1) badMono.push({ why: 'the swipe-in verdict flipped ' + flips + ' times on a ' + dow + 'px panel' });

    /* The other half: grabbed by the panel and thrown back. drawerRelease
       answers "should this be OPEN", so the mirror of the swipe-in above is
       the first m it answers FALSE at — reading its `true` as a shut is the
       one mistake this sweep could make, and did once. */
    const shutLine = Math.floor(dow * DRAWER_OPEN_MIN) + 1;
    let firstShut = null, shutFlips = 0, prevOpen = null;
    for (let m = 0; m <= dow + 2; m++) {
      const opens = RP.drawerRelease(0, -m, 0, dow);       /* dragged back from open */
      cases++;
      if (prevOpen !== null && opens !== prevOpen) shutFlips++;
      if (!opens && firstShut === null) firstShut = m;
      prevOpen = opens;
    }
    if (shutFlips !== 1 || firstShut !== shutLine) {
      badShut.push({ why: 'on a ' + dow + 'px panel the first shutting throw is ' + firstShut + 'px after ' + shutFlips + ' flip(s), and one pixel past half is ' + shutLine + 'px' });
    }
    if (shutFlips !== 1) badMono.push({ why: 'the throw-back verdict flipped ' + shutFlips + ' times on a ' + dow + 'px panel' });
  }
  check('swiped in from the edge, the drawer opens at exactly half its own width, over ' + SOME_WIDTHS.length + ' panel widths',
    describe(badOpen));
  check('grabbed by the panel and thrown back, it shuts one pixel past half — the two halves of the same line',
    describe(badShut));
  check('and the door never changes its mind twice: one flip across the whole travel, in both directions',
    describe(badMono));
}
{
  /* the flick decides by sign alone, and the coast may not exceed its clamps */
  const badFlick = [], badCoast = [];
  for (const w of SOME_WIDTHS) {
    const dow = RP.drawerWidth(0, w);
    for (const cur of [-dow, -dow * DRAWER_OPEN_MIN, -1, 0, dow * 0.5, dow]) {
      cases += 4;
      if (RP.drawerRelease(FLICK + 1e-6, cur, 0, dow) !== true) {
        badFlick.push({ why: 'a rightward flick at ' + FLICK + 'px/s did not open a drawer left at ' + cur + 'px' });
      }
      if (RP.drawerRelease(-FLICK - 1e-6, cur, 0, dow) !== false) {
        badFlick.push({ why: 'a leftward flick at ' + FLICK + 'px/s did not shut a drawer left at ' + cur + 'px' });
      }
      if (RP.drawerRelease(FLICK, cur, 0, dow) !== (cur >= -dow * DRAWER_OPEN_MIN)) {
        badFlick.push({ why: 'exactly ' + FLICK + 'px/s at ' + cur + 'px was not read as a non-flick' });
      }
      if (RP.drawerRelease(-FLICK, cur, 0, dow) !== (cur >= -dow * DRAWER_OPEN_MIN)) {
        badFlick.push({ why: 'exactly -' + FLICK + 'px/s at ' + cur + 'px was not read as a non-flick' });
      }
    }
    cases += 3;
    if (!near(RP.drawerCoast(1e9, dow), COAST_OPEN * dow, 1e-9)) badCoast.push({ why: 'a huge coast carried ' + RP.drawerCoast(1e9, dow) + 'px, not ' + COAST_OPEN * dow + 'px' });
    if (!near(RP.drawerCoast(-1e9, dow), -COAST_BACK * dow, 1e-9)) badCoast.push({ why: 'a huge reverse coast carried ' + RP.drawerCoast(-1e9, dow) + 'px, not ' + (-COAST_BACK * dow) + 'px' });
    let prev = -Infinity;
    for (let p = -2 * dow; p <= 2 * dow; p += 1) {
      const c = RP.drawerCoast(p, dow);
      cases++;
      if (c < prev - 1e-9) badCoast.push({ why: 'the coast fell as the projection rose, at ' + p + 'px' });
      prev = c;
    }
  }
  check('a drawer flick decides by its sign alone, wherever the finger left it — and exactly ' + FLICK + 'px/s does not',
    describe(badFlick));
  check('its coast is clamped at 0.4 of the width open and 1.2 of it back, and is monotone in between',
    describe(badCoast));
}
{
  /* what the clamp is for: a coast promoted a pull just short of the line,
     and cannot promote one a whole clamp short of it */
  const bad = [];
  for (const w of SOME_WIDTHS) {
    const dow = RP.drawerWidth(0, w);
    const half = dow * DRAWER_OPEN_MIN;
    cases += 2;
    if (RP.drawerRelease(0, -half - 1, COAST_OPEN * dow, dow) !== true) {
      bad.push({ why: 'a full coast did not carry a panel stopped 1px short of half on a ' + dow + 'px drawer' });
    }
    if (RP.drawerRelease(0, -half - COAST_OPEN * dow - 1, COAST_OPEN * dow, dow) !== false) {
      bad.push({ why: 'a full coast carried a panel more than its own clamp on a ' + dow + 'px drawer' });
    }
  }
  check('a coast promotes a throw stopped just short of the line, and no further than its own clamp',
    describe(bad));
}

/* ------------------------------------------------------------
   8. The contract, and the registry that makes it unavoidable

   The boot suite reads admin.html and fails on a dismissible overlay no
   registration claims — that is the half a pure module cannot do. What
   belongs HERE is the contract's own arithmetic: whatever a surface is
   registered as, its line has to be the policy's line for its kind, and a
   throw has to paint past its own size. A new surface gets those facts for
   free by being registered; it cannot get its own line by accident.
   ------------------------------------------------------------ */
console.log('\n-- the surface contract --');
{
  const names = RP.surfaceNames();
  check('the registry names ' + names.length + ' surface(s): ' + names.join(', ') +
    ' \u2014 and every one of them is a kind this file sweeps',
    names.length > 0 && names.every(n => ['drawer', 'surface'].indexOf(RP.policyFor(n).kind) !== -1));

  const badLine = [], badThrown = [];
  for (const n of names) {
    const p = RP.policyFor(n);
    const sizes = p.kind === 'drawer' ? SOME_WIDTHS : HEIGHTS;
    for (const s of sizes) {
      cases++;
      const want = p.kind === 'drawer' ? Math.ceil(s * DRAWER_OPEN_MIN) : Math.max(FAR, s * SURFACE_OPEN_MIN);
      if (p.line(s) !== want) badLine.push({ why: n + ' at ' + s + 'px has its line at ' + p.line(s) + ', not ' + want });
    }
    /* a throw paints the surface past its own size, or \u2014 the drawer, which
       leaves by a class rather than a paint \u2014 not at all */
    for (const s of [1, 40, 288, 900]) {
      cases++;
      const t = p.thrown(s);
      if (p.kind === 'drawer') {
        if (t !== null) badThrown.push({ why: n + '.thrown(' + s + ') is ' + t + ', and a drawer paints no throw' });
      } else if (typeof t !== 'string' || !(parseFloat(t) > s)) {
        badThrown.push({ why: n + '.thrown(' + s + ') is ' + JSON.stringify(t) + ', which is not past its own size' });
      }
    }
  }
  check('every registered surface\'s line is the policy\'s own for its kind, at every size it is laid out at', describe(badLine));
  check('and each one\'s throw paints past its own size (or, for the drawer, paints nothing)', describe(badThrown));

  check('the contract hands out the module\'s own functions, never a copy that could drift',
    names.every(n => {
      const p = RP.policyFor(n);
      return p.release === (p.kind === 'drawer' ? RP.drawerRelease : RP.surfaceRelease);
    }));
  check('the registry, its entries and the tables they hand out are all frozen',
    Object.isFrozen(RP.REGISTRY) && names.every(n => Object.isFrozen(RP.policyFor(n).constants)));
  check('an unregistered name is refused, and the refusal names the surfaces it does have',
    (() => {
      try { RP.policyFor('toast'); return false; }
      catch (e) { return names.every(n => String(e.message).indexOf(n) !== -1); }
    })());
}

console.log('\n' + (failures === 0
  ? 'All release-policy checks passed (' + cases.toLocaleString('en-GB') + ' cases swept).'
  : failures + ' check(s) FAILED (' + cases.toLocaleString('en-GB') + ' cases swept).'));
process.exitCode = failures === 0 ? 0 : 1;
