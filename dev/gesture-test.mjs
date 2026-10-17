#!/usr/bin/env node
/* ============================================================
   Arzuz — synthetic-pointer harness for the drawer, sheet and
   lightbox gestures (assets/swipe-gesture.js)

   Run: npm run test:gesture      (or directly: node dev/gesture-test.mjs)

   WHAT THIS IS FOR
     Every bug the shared drag engine can have is invisible in a
     screenshot and tedious to reproduce by hand: which axis a
     finger meant, whether a stale sample poisoned the velocity,
     whose finger owns the gesture, and whether the click seal
     swallowed the wrong click. Those are the four rules, and all
     four are arithmetic that synthetic events can drive exactly —
     so they get tested here rather than hoped for on a phone.

   HOW IT IS REGISTERED, AND WHY THE NAME MATTERS
     `npm run test:gesture` runs this file, and `test:gesture` is in
     ORDER in dev/run-tests.mjs, so `npm test` runs it and reports it
     like every other suite. scripts/test-all.mjs derives its suite
     list from package.json, so the strict gate no longer sees a
     test-like file that nothing runs.

     That pairing is asserted rather than assumed: a `test:*` script
     in package.json that ORDER does not name is reported as
     forgotten, and a name in ORDER with no script fails the run. So
     this file cannot be renamed to something the runner does not
     know, and it cannot be dropped from the run by accident — which
     is the whole reason it is named `gesture-test.mjs` and not
     `gesture-harness.mjs`. A suite nobody invokes is a comment.

   WHAT IT DOES NOT COVER — and one of these is a real blind spot

     · The RELEASE POLICY of each surface — where the drawer lands,
       when a sheet is thrown away, what a lightbox does with a pull —
       used to be arithmetic inside assets/admin.js, out of this file's
       reach. It now lives in assets/release-policy.js, which holds no
       DOM at all, so it is covered from BOTH sides and neither is
       optional. `npm run test:policy` sweeps it directly — every
       integer height from 1 to 900 px, a thousand viewport widths,
       every integer distance on each, and 201 real velocities from
       -4,000 to +4,000 px/s pushed through project() into the release,
       14.5 million cases in under two seconds — and that is the ONLY
       place the flick (v > 280 px/s) and the momentum coast are
       exercised, because neither is reachable from a settled drag.
       `npm run test:admin` covers the wiring instead: that admin.js
       calls that module with the right state and geometry, swept
       across every integer distance to each surface's own size at the
       geometries a phone lays out, asserting at each that the verdict
       flips exactly once at the px line the policy documents. A
       threshold that moved by a single pixel fails both. Use those two
       for a policy regression and this file for the physics.

       THE PROJECTION IS THE SEAM BETWEEN US, and how far each side
       reaches is not symmetrical, so it is stated here rather than
       left to be discovered by whoever changes a number. `project(v)`
       is THIS file's arithmetic, and the 310 measured throws above pin
       its slope, its scale and its sign: change DECAY and this suite
       fails on the first velocity, change the projection to Math.abs
       and it fails on the negative ones. (Neither failed here before —
       one point at 3,000px/s on a line with a slope was all there was.)
       What this file cannot see is what a RELEASE then makes of that
       projection — a release rule that took the absolute value of the
       velocity or of the coast never runs in this file at all, because
       the release policies live in the other module. That is the policy
       suite's composed sweep: the same projection, carried into every
       distance on every height. Neither is sufficient; both were
       mutated to show what each one misses.

     · WHETHER THE MODULE CAN FIND A DOCUMENT AT ALL. This harness
       always injects opts.target, so the `opts.target || root.document`
       fallback is never evaluated here and a module that cannot resolve
       its own root still passes 30 checks. That is not hypothetical: it
       happened. The factory closed over `root` from the wrong scope and
       threw a ReferenceError for every real page, and this file was
       green about it. The admin boot suite found it, because it loads
       admin.html's real script chain with no target injected.

       So: this file proves the PHYSICS, the boot suite proves the
       WIRING and the per-surface release POLICIES. Run both — a green
       run here says nothing about whether the drawer gets a document.

     · What none of them cover is the real thing: actual CSS
       transitions, real layout (those heights and widths are written
       from the stylesheet's own numbers, not measured by a layout
       engine), and browser gesture arbitration —
       iOS's edge back-swipe, pull-to-refresh, the keyboard. That is
       what dev/mobile-qa-checklist.md is for, and it is still the
       only test for it.
   ============================================================ */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SwipeGesture = require('../assets/swipe-gesture.js');

let failures = 0;
/* STRICT on purpose: `ok` must be the boolean true. The aggregate checks below
   report the FIRST reason a sweep failed as a STRING, and a non-empty string
   is truthy — so a check that merely tested truthiness would print a
   half-failed sweep as a tick. That happened here: a mutation that doubled the
   projection's slope made one of these read "✓ … (worst error 2000.00px)" and
   the suite still exited 0. Every call site below passes a comparison, so
   requiring true costs nothing and closes the trap. */
function check(name, ok) {
  const pass = ok === true;
  console.log((pass ? '  ✓ ' : '  ✗ ') + name);
  if (!pass) failures++;
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------
   A fake document: four listeners and a way to fire at them.
   The engine only ever calls addEventListener, removeEventListener,
   and — through the events it is handed — preventDefault and
   stopPropagation. So this is the whole surface it needs, and the
   physics under test is the real one, not a re-implementation.
   ------------------------------------------------------------ */
function fakeTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i > -1) a.splice(i, 1);
    },
    fire(e) { (listeners[e.type] || []).slice().forEach(fn => fn(e)); },
    count(type) { return (listeners[type] || []).length; },
  };
}

function ev(type, over) {
  return Object.assign({
    type,
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    cancelable: true,
    isTrusted: true,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  }, over || {});
}

/* a surface wired to a fresh fake target, recording what the engine said */
function surface(over) {
  const calls = { begin: [], drag: [], end: [], abort: 0 };
  const target = fakeTarget();
  new SwipeGesture(Object.assign({
    axis: 'x',
    target,
    canStart: () => true,
    allow: () => true,
    onBegin: d => calls.begin.push(d),
    onDrag: d => calls.drag.push(d),
    onEnd: (v, d, proj) => calls.end.push({ v, d, proj }),
    onAbort: () => { calls.abort++; },
  }, over || {}));
  return { target, calls };
}

/* ============================================================
   1. The slop gate — which axis did the finger mean?
   ============================================================ */

console.log('slop gate');
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { clientX: 103, clientY: 300, timeStamp: 16 }));
  check('a 3px wobble paints nothing and begins nothing',
    s.calls.begin.length === 0 && s.calls.drag.length === 0);

  s.target.fire(ev('pointermove', { clientX: 140, clientY: 300, timeStamp: 32 }));
  check('past the gate the finger is tracked 1:1', s.calls.drag[0] === 40 && s.calls.begin[0] === 40);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { clientX: 104, clientY: 360, timeStamp: 16 }));
  check('a mostly-vertical move is not a sideways swipe (aborts, never paints)',
    s.calls.abort === 1 && s.calls.drag.length === 0 && s.calls.end.length === 0);
}
{
  const s = surface({ allow: d => d > 0 });   /* outward only */
  s.target.fire(ev('pointerdown', { clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { clientX: 60, clientY: 300, timeStamp: 16 }));
  check('a direction the surface cannot travel ends the gesture before it paints',
    s.calls.abort === 1 && s.calls.drag.length === 0);
}
{
  const s = surface({ canStart: () => false });
  s.target.fire(ev('pointerdown', { clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { clientX: 300, clientY: 300, timeStamp: 16 }));
  check('canStart refusing means no gesture at all', s.calls.drag.length === 0 && s.calls.abort === 0);
}

/* ============================================================
   2. Whose finger owns it — multitouch and foreign events
   ============================================================ */

console.log('pointer ownership');
{
  const s = surface();
  s.target.fire(ev('pointerdown', { pointerId: 1, clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { pointerId: 1, clientX: 140, clientY: 300, timeStamp: 32 }));
  const afterFirst = s.calls.drag.length;

  /* a second finger lands mid-gesture — a resting thumb, say */
  s.target.fire(ev('pointerdown', { pointerId: 2, clientX: 300, clientY: 100, timeStamp: 40 }));
  s.target.fire(ev('pointermove', { pointerId: 2, clientX: 380, clientY: 300, timeStamp: 48 }));
  check('a second finger cannot drag the surface out from under the first',
    s.calls.drag.length === afterFirst && s.calls.drag[afterFirst - 1] === 40);

  s.target.fire(ev('pointermove', { pointerId: 1, clientX: 180, clientY: 300, timeStamp: 64 }));
  check('the first finger still owns it', s.calls.drag[s.calls.drag.length - 1] === 80);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { pointerId: 1, clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { pointerId: 1, clientX: 140, clientY: 300, timeStamp: 32 }));
  s.target.fire(ev('pointerup', { pointerId: 2, clientX: 140, clientY: 300, timeStamp: 36 }));
  check('another pointer lifting does not end the gesture',
    s.calls.end.length === 0);
  s.target.fire(ev('pointerup', { pointerId: 1, clientX: 140, clientY: 300, timeStamp: 40 }));
  check('the owning finger lifting does', s.calls.end.length === 1);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { pointerType: 'mouse', clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { pointerType: 'mouse', clientX: 300, clientY: 300, timeStamp: 16 }));
  s.target.fire(ev('pointerup', { pointerType: 'mouse', clientX: 300, clientY: 300, timeStamp: 32 }));
  check('a mouse never starts a touch drag', s.calls.drag.length === 0 && s.calls.end.length === 0);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { button: 2, clientX: 100, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { button: 2, clientX: 300, clientY: 300, timeStamp: 16 }));
  check('a non-primary button never starts one either', s.calls.drag.length === 0);
}

/* ============================================================
   3. The velocity sample — and the stale sample that must not
      drag the average backwards
   ============================================================ */

console.log('velocity and projection');
{
  const s = surface();
  /* A long, slow crawl first, then a fast flick in the last 40ms.
     Note the timestamps are never 0: the engine reads
     `e.timeStamp || Date.now()`, and 0 is falsy, so a synthetic event
     stamped 0 is read as "now" and the samples end up on two
     different clocks. Real DOM timeStamps are never 0; a harness that
     uses one is measuring its own arithmetic. */
  s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: 1000 }));
  s.target.fire(ev('pointermove', { clientX: 40, clientY: 300, timeStamp: 2000 }));
  s.target.fire(ev('pointermove', { clientX: 160, clientY: 300, timeStamp: 2040 }));
  s.target.fire(ev('pointerup', { clientX: 160, clientY: 300, timeStamp: 2040 }));

  const { v, d, proj } = s.calls.end[0];
  /* (160-40)px over 0.04s. Including the sample from t=1000 would give
     ~154 px/s — a flick that throws the drawer the wrong way. */
  check('a stale sample does not drag the average down', near(v, 3000, 1));
  check('the finger travelled 160px', near(d, 160, 0.001));
  check('a fast flick projects forward, not backwards', proj > 0 && v > 0);
}
{
  /* ---- the projection, MEASURED, over a whole range of velocities ----

     This block used to assert the decay curve at ONE velocity (3,000px/s
     → 1497px). One point is a point on a line, and a line is what is being
     claimed: `project(v)` is linear, and the thing a single sample cannot
     see is the slope — 0.999 instead of 0.998 doubles it and would still
     project forward at 3,000px/s. So 310 real throws are driven through
     the engine instead, from 150 to 4,000px/s in 25px/s steps and back the
     other way, and each one's projection is compared with the curve the
     comment on `project()` promises.

     The velocity is not passed in — it IS the move: 60ms of travel at v
     px/s, inside the 90ms TICK window, and past the 8px slop gate for
     every speed here (150px/s × 0.06s = 9px). What the engine reports back
     is what the finger did, and the assertion is that the two agree. */
  const SPEC_DECAY = 0.998;                       /* written out: reading it off
                                                     the engine would agree with
                                                     any value it was given */
  const specProj = v => (v / 1000) * SPEC_DECAY / (1 - SPEC_DECAY);

  const DT = 60;
  const badV = [], badD = [], badP = [];
  let n = 0, worstV = 0, worstP = 0, slowest = Infinity, fastest = 0;
  for (const sign of [1, -1]) {
    for (let speed = 150; speed <= 4000; speed += 25) {
      const want = sign * speed;
      const move = (want * DT) / 1000;             /* the px that IS this velocity */
      const s = surface();
      const t0 = 1000000 + n * 1000;               /* no two throws share a clock */
      s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: t0 }));
      s.target.fire(ev('pointermove', { clientX: move, clientY: 300, timeStamp: t0 + DT }));
      s.target.fire(ev('pointerup', { clientX: move, clientY: 300, timeStamp: t0 + DT }));
      n++;
      if (s.calls.end.length !== 1) {
        badV.push({ why: 'a ' + want + 'px/s throw (' + move + 'px in ' + DT + 'ms) released nothing' });
        continue;
      }
      const got = s.calls.end[0];
      slowest = Math.min(slowest, speed);
      fastest = Math.max(fastest, speed);
      if (!near(got.v, want, 1)) {
        worstV = Math.max(worstV, Math.abs(got.v - want));
        badV.push({ why: 'a ' + move + 'px move in ' + DT + 'ms read as ' + got.v + 'px/s, not ' + want });
      }
      if (!near(got.d, move, 0.001)) {
        badD.push({ why: 'the finger moved ' + move + 'px and the release reported ' + got.d });
      }
      if (!near(got.proj, specProj(want), 1)) {
        worstP = Math.max(worstP, Math.abs(got.proj - specProj(want)));
        badP.push({ why: 'a ' + want + 'px/s throw projected ' + got.proj + 'px, not the ' +
          specProj(want).toFixed(1) + 'px Apple\'s decay gives it' });
      }
    }
  }

  /* the reason rides in the NAME, so a strict check can still say why */
  const why = list => (list.length === 0 ? '' : '  \u2192 ' + list[0].why);
  check(n + ' real throws from ' + slowest + ' to ' + fastest + 'px/s either way: the engine measures the velocity the finger was doing (worst error ' +
    worstV.toFixed(2) + 'px/s)' + why(badV), badV.length === 0);
  check('and each one travelled the distance the move gave it' + why(badD), badD.length === 0);
  check('the ENGINE\'S OWN PROJECTION matches Apple\'s decay curve at every one of those velocities — the slope, not one point on it (worst error ' +
    worstP.toFixed(2) + 'px)' + why(badP), badP.length === 0);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: 1000 }));
  s.target.fire(ev('pointerup', { clientX: 0, clientY: 300, timeStamp: 1010 }));
  check('a tap that never moved is not a throw at all', s.calls.end.length === 0);
  check('and nothing was painted for it', s.calls.drag.length === 0);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: 1000 }));
  const overflow = ev('pointermove', { clientX: 60, clientY: 300, timeStamp: 1030, cancelable: false });
  s.target.fire(overflow);
  check('a move the page will not let us cancel still tracks', s.calls.drag[0] === 60);
  check('and is left alone — we cannot cancel what we do not own yet',
    overflow.prevented === false);
  const claimed = ev('pointermove', { clientX: 90, clientY: 300, timeStamp: 1060, cancelable: true });
  s.target.fire(claimed);
  check('once the gesture is ours, the page default IS suppressed', claimed.prevented === true);
}

/* ============================================================
   4. The reopen race — one throw must not poison the next
   ============================================================ */

console.log('the reopen race');
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { clientX: 120, clientY: 300, timeStamp: 30 }));
  s.target.fire(ev('pointerup', { clientX: 120, clientY: 300, timeStamp: 30 }));
  check('the first throw was delivered', s.calls.end.length === 1);

  /* a second gesture starts before any animation has finished — the
     state has to be clean, or the new finger inherits the old one's
     pointer id and its own movement is ignored */
  s.target.fire(ev('pointerdown', { pointerId: 7, clientX: 0, clientY: 300, timeStamp: 60 }));
  s.target.fire(ev('pointermove', { pointerId: 7, clientX: 50, clientY: 300, timeStamp: 90 }));
  check('a gesture started right after a throw is not ignored',
    s.calls.drag[s.calls.drag.length - 1] === 50);

  s.target.fire(ev('pointerup', { pointerId: 7, clientX: 50, clientY: 300, timeStamp: 90 }));
  check('and it releases on its own pointer', s.calls.end.length === 2);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { pointerId: 3, clientX: 0, clientY: 300, timeStamp: 0 }));
  s.target.fire(ev('pointermove', { pointerId: 3, clientX: 90, clientY: 300, timeStamp: 30 }));
  s.target.fire(ev('pointercancel', { pointerId: 3, clientX: 90, clientY: 300, timeStamp: 30 }));
  check('a cancelled pointer ends the gesture rather than leaving it live',
    s.calls.end.length === 1);
  s.target.fire(ev('pointerdown', { pointerId: 4, clientX: 0, clientY: 300, timeStamp: 60 }));
  s.target.fire(ev('pointermove', { pointerId: 4, clientX: 45, clientY: 300, timeStamp: 90 }));
  check('so the surface is usable again immediately',
    s.calls.drag[s.calls.drag.length - 1] === 45);
}

/* ============================================================
   5. The click seal — the throw must not press a button, but our
      own programmatic click must still get through
   ============================================================ */

console.log('the click seal');
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: 1000 }));
  s.target.fire(ev('pointermove', { clientX: 120, clientY: 300, timeStamp: 1030 }));
  /* the seal is armed on RELEASE: a drag still in progress has no click
     to catch yet, which is why the pointerup has to come first here */
  s.target.fire(ev('pointerup', { clientX: 120, clientY: 300, timeStamp: 1035 }));
  const trusted = ev('click');
  const synthetic = ev('click', { isTrusted: false });
  s.target.fire(trusted);
  s.target.fire(synthetic);

  check('a real click landing on the throw is swallowed',
    trusted.prevented === true && trusted.stopped === true);
  check('a programmatic click passes through (the composer\'s Cancel path)',
    synthetic.prevented === false && synthetic.stopped === false);
}
{
  const s = surface();
  s.target.fire(ev('pointerdown', { clientX: 0, clientY: 300, timeStamp: 1000 }));
  s.target.fire(ev('pointerup', { clientX: 0, clientY: 300, timeStamp: 1010 }));
  const trusted = ev('click');
  s.target.fire(trusted);
  check('a plain tap is not sealed — the button it tapped still works',
    trusted.prevented === false);
}

console.log(failures === 0 ? '\nAll gesture checks passed.' : '\n' + failures + ' check(s) FAILED');
process.exitCode = failures === 0 ? 0 : 1;
