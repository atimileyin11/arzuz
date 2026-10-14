#!/usr/bin/env node
/* ============================================================
   Arzuz — synthetic-pointer harness for the drawer, sheet and
   lightbox gestures (assets/swipe-gesture.js)

   Run: node dev/gesture-harness.mjs

   WHAT THIS IS FOR
     Every bug the shared drag engine can have is invisible in a
     screenshot and tedious to reproduce by hand: which axis a
     finger meant, whether a stale sample poisoned the velocity,
     whose finger owns the gesture, and whether the click seal
     swallowed the wrong click. Those are the four rules, and all
     four are arithmetic that synthetic events can drive exactly —
     so they get tested here rather than hoped for on a phone.

   WHY IT IS NOT NAMED `*-test.mjs`
     scripts/test-all.mjs treats a test-like file that no suite list
     names as a FAILURE under --strict, and every list that could
     name it is uncommitted work in flight right now (package.json,
     scripts/test-all.mjs, dev/run-tests.mjs). Renaming it to look
     like a suite before it is registered would turn the gate red
     for a harness that passes. Register it in one of those three
     and rename it; until then it runs on demand.

   WHAT IT DOES NOT COVER
     The engine is shared physics. The RELEASE POLICY of each
     surface — where the drawer lands, when a sheet is thrown away,
     what a lightbox does with a pull — is still in assets/admin.js,
     because it paints CSS custom properties that only exist in a
     browser. Multi-touch ownership, the reopen race in the engine's
     own state, the slop gate and the seal are covered.
   ============================================================ */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SwipeGesture = require('../assets/swipe-gesture.js');

let failures = 0;
function check(name, ok) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) failures++;
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
  check('the projection matches Apple\'s decay curve', near(proj, 1497, 1));
  check('a fast flick projects forward, not backwards', proj > 0 && v > 0);
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
