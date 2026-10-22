# Arzuz admin — mobile touch QA checklist

Run this **on real hardware** before this work is called done. The gesture logic,
geometry and state machine were verified in desktop emulation at 375×812 with
synthetic `PointerEvent`s — that proves the decision code, not the feel. Real
fingers, real compositors and real browser gesture arbitration are the parts
that only a phone can answer.

Scope: the mobile drawer swipe, the drawer drag indicator, the
swipe-down-to-dismiss bottom sheets, the swipe-dismiss lightboxes, and the shell
around them. All four surfaces run on one shared gesture engine (`SwipeGesture`
in `assets/swipe-gesture.js`, extracted from `assets/admin.js` so a Node harness
can drive the real physics), so a fix in one place moves them together — test
them together.

Each check below names the constant it is really asking about, because "the
flick feels wrong" is only actionable as "the 280 px/s threshold is too high".

---

## 0. Setup

- [ ] Device A: iPhone (iOS Safari) — the primary target. Device B: Android (Chrome).
- [ ] Serve over **HTTPS or localhost**; touch gestures are not worth testing on a
      LAN-http origin where the browser may behave differently.
- [ ] Open `admin.html` signed in as admin (the composer and delete flows need it),
      and once with `?mock=1` for the draft/listings rows.
- [ ] Note the browser's chrome: Safari's bottom toolbar shrinks the visual
      viewport and will move the "bottom" the sheets sit on.
- [ ] Set **Reduce Motion** on/off at least once (Settings → Accessibility).

Record results in the table at the end. A check is only "pass" if it behaved on
the device you wrote down.

---

## 0.5 Start here — the four checks only a thumb can settle

Do these four **before** the rest, while you are fresh and before the page has
been through a dozen state changes. They are the ones emulation cannot judge, and
the ones whose answers change code. For each: what you did, what happened, what
you expected, and — where the check names a constant — whether the number feels
right on a real thumb.

### A. Rubber-band stiffness — past both resting edges (drawer)

The drawer resists past its edges at `RATIO = 0.18`: drag 100 px past the edge and
the drawer moves about 18 px.

- [ ] Open the drawer, then keep pulling right so the drawer's left edge passes
      the right side of the screen. It should follow with clear resistance —
      never detach, never stop dead, never run away.
- [ ] Shut the drawer, then keep pulling left well past closed. Same question.
- [ ] **Record:** about right / too stiff (feels stuck) / too loose (feels like it
      will fly off). Say how far you dragged before noticing it. This is
      `RATIO = 0.18` in `assets/swipe-gesture.js`.

### B. Flick threshold — the number that decides "throw" vs "spring back"

A flick is `FLICK = 280` px/s. Below it, the surface settles by distance instead
(`OPEN_MIN`): drawer 0.5 of its width, sheet 0.3 of its height, lightbox by `FAR`.

- [ ] On each of the four surfaces, do a **short fast flick** (~50 px in under
      150 ms) and release. It must throw, not snap back.
- [ ] Then do a **slow drag of the same distance** and release. It must return.
- [ ] Repeat the fast flick five times each. Find the smallest flick that still
      throws, and the largest one that did not.
- [ ] **Record:** the flick that failed, if any. A natural flick that sometimes
      fails means 280 is too high; a slow drag that throws means it is too low.
      This is `FLICK = 280` in the drawer, sheet and lightbox blocks.

### C. iOS edge back-swipe — the browser's own gesture (drawer)

The drawer claims the left-edge zone within `28 px` (`e.clientX > 28` bails).

- [ ] On iOS Safari, swipe right from inside that edge zone, ten times.
- [ ] **Record:** does Safari navigate back, does the drawer open, or do they
      fight? If Safari wins even occasionally, the edge zone has to shrink or the
      gesture has to start further inboard — log how far in you had to start
      before it stopped happening.

### D. Pull-to-refresh — and the gestures it hijacks

- [ ] Drag the **body** of a long sheet down from its very top. The sheet body
      must scroll; the browser's refresh must not take the gesture.
- [ ] Do the same at the top of the page behind the drawer.
- [ ] **Record:** which won, and whether the sheet ended up half-dragged when it
      did.

---

## 1. Drawer — swipe from the left edge to open

- [ ] Shut the drawer. Swipe right starting **within ~25 px of the left edge**.
      The drawer should follow your finger 1:1, not jump.
- [ ] Pull past the resting edge and keep going: the drawer should resist
      (rubber-band), not run away or detach.
- [ ] Release after a short flick: it should keep going and settle open.
- [ ] Release after a slow short drag (~1/3 of the width): it should settle open.
- [ ] Release after a slow tiny drag: it should settle shut.
- [ ] While dragging, drag **up and down** instead: the page should scroll and the
      drawer should not move (vertical scroll wins).
- [ ] Scroll the page mid-drag: no jitter, no scroll-position jump on release.
- [ ] Start the same swipe at x ≈ 60 px (well away from the edge): the drawer must
      **not** open.
- [ ] iOS only: does the system's **back-swipe** (left-edge) fight this? Try
      repeatedly at the very edge. If Safari navigates back instead, the edge zone
      has to shrink or the gesture has to move inboard — log it.

## 2. Drawer — swipe to close

- [ ] With the drawer open, grab it anywhere and drag left: it follows 1:1.
- [ ] Flick it left: it closes and does not bounce.
- [ ] Short slow drag that is not far enough: it springs back open.
- [ ] Drag the drawer left and release **over the gap between nav items**: the item
      under your finger must not activate (300 ms click seal).
- [ ] Same test releasing **over a nav item**: no navigation on release; a fresh
      clean tap on the next item does navigate.
- [ ] Grab the **scrim** (the dimmed page) and drag left: it closes.
- [ ] Throwing the drawer shut should not scroll the page underneath.
- [ ] Open the drawer, drag it part-way, then reverse and re-open in the same
      gesture: it must reverse smoothly (no stuck half-open state).

## 3. Drawer — drag indicator (new)

The indicator is the small pill on the left edge: 20×60 px, purple, with a white
inner bar. It rests at the screen edge when the drawer is shut.

- [ ] Drawer shut, page at top: the pill is visible at the left edge, vertically
      centred, and is **not** clipped by the viewport.
- [ ] The pill must not block taps: tap a control that sits under/near the left
      edge — it should still respond (the pill is `pointer-events: none`).
- [ ] Slowly pull the drawer open: the pill should **travel with the drawer's
      leading edge**, staying on the edge, brightening as you drag.
- [ ] Release: the pill should settle away (fade out as the drawer opens, or
      return to the edge if the drag is abandoned).
- [ ] Drawer open: the pill is gone (not floating over the page).
- [ ] Grab the **open** drawer and start pulling it shut: the pill should light
      back up and track the leading edge during the throw.
- [ ] Switch to a light/other page state and confirm the pill still reads as a
      handle, not as a broken element. Judge the taste call here: is 50 % opacity
      too loud or too quiet against real content?
- [ ] Landscape: pill still centred and not clipped.

## 4. Bottom sheets — swipe down to dismiss (new)

Open a sheet (Edit / Details / Delete / Share / Discard / Add Apartment). On
mobile every modal is a bottom sheet with a grab pill at the top.

- [ ] Each of the six sheets shows the grab pill, centred at the top of the sheet.
- [ ] Grab the **header area** (around the pill / title) and pull down: the sheet
      follows the finger 1:1 and the page behind gets lighter as it moves.
- [ ] Short slow pull (~40 px) then release: it snaps back and stays open.
- [ ] Pull past roughly a third of the sheet's height and release: it slides away
      and closes.
- [ ] Quick short flick down (~60 px, fast): it dismisses on the flick even though
      the distance was small.
- [ ] Flick **upward**: it must not dismiss (nothing happens, or a small resisted
      lift on a very fast upward flick).
- [ ] Drag **sideways** across the header: nothing happens, the sheet stays put.
- [ ] Grab the sheet **body** (below the header) and pull down: the **content
      scrolls**; the sheet itself must not move. This is the deliberate split —
      only the header is a grab zone.
- [ ] Scroll a long sheet to the middle, then drag the header down: it should still
      dismiss (the header is always grabbable).
- [ ] Release a big throw **over a button inside the sheet**: that button must not
      fire (click seal).
- [ ] Plain tap on the ✕ must still close the sheet; plain tap on any field must
      still focus it.
- [ ] After a dismissed sheet, re-open it: it must appear at its normal resting
      position — never stuck half-translated or invisible.
- [ ] Dismiss then immediately re-open rapidly, several times: no sheet left
      translated off-screen.

## 5. Bottom sheets — the guards (must not regress)

- [ ] **Composer, clean:** open Add Apartment, change nothing, swipe the header
      down. It should close straight away.
- [ ] **Composer, dirty:** open Add Apartment, type into any field, swipe the
      header down. The **discard prompt** must appear and the composer must stay
      (hidden behind it). It must not silently discard the work.
- [ ] Swipe the discard prompt itself → "Keep editing" behaviour, composer intact
      with your text still there.
- [ ] Choose Discard → composer and prompt both close, toast shows.
- [ ] **Delete sheet:** open a delete confirm, swipe it away → it must cancel, and
      deleting again must still require the typed id. Try to delete right after a
      swipe-dismiss: it must not fire the delete.
- [ ] **Details sheet:** swipe away, then re-open the same row.
- [ ] Escape/X/backdrop taps still close every sheet (unchanged paths).
- [ ] Focus behaviour: with a sheet open, hardware keyboard Tab should stay inside
      the sheet; after a swipe-dismiss, focus should be free again.

## 6. Lightboxes — swipe down to dismiss (new)

The photo viewer (any gallery image, full screen) has a grab pill at the **top
edge of the screen** and takes a drag from anywhere on it. The video card has its
pill on the **title row**, and only that row is a grab zone.

- [ ] Tap a gallery photo: it opens full screen with the pill visible at the top,
      and "Click anywhere to close" still under it.
- [ ] Drag down anywhere on the photo: it follows 1:1 and the black backdrop gets
      lighter (the page behind shows through).
- [ ] Short slow pull then release: it snaps back and stays open.
- [ ] Fast flick down: it dismisses, sliding away with the backdrop.
- [ ] Flick **upward**: nothing happens. Drag **sideways**: nothing happens.
- [ ] Plain tap anywhere still closes it (the tap path must not be sealed by a
      drag that never moved).
- [ ] Re-open the same photo right after dismissing it: it must be at its normal
      position, not stuck translated down or invisible.
- [ ] Dismiss and immediately re-open within a quarter second, repeatedly: the
      reopen must win — it must never appear and vanish again.
- [ ] Open a **video** tour: the pill sits on the title row; drag the title row
      down → the card follows and the backdrop lightens.
- [ ] Drag the **video/poster area** instead: it must **not** move the card (the
      player keeps its own gestures — try the scrub bar, it must still work).
- [ ] Flick the video card away: it closes, the backdrop holds, and **the player
      is torn down** (re-open a different video: no ghost audio from the previous
      one, no stuck iframe).
- [ ] Swipe the video card away mid-playback: sound must stop.
- [ ] With a lightbox open, swipe from the left edge: the nav drawer must **not**
      open behind it.
- [ ] Escape still closes both lightboxes; the video's ✕ still works.
- [ ] Very tall photo (portrait) and very wide photo (landscape): the pill is not
      overlapped by the image, and both still dismiss.

## 7. Keyboard + safe areas (this is where sheets usually break)

- [ ] Focus a text field in a tall sheet → the on-screen keyboard opens. The sheet
      must stay usable, keep its field visible, and **not** push the grab pill off
      screen.
- [ ] With the keyboard open, swipe the header down — does it dismiss cleanly, or
      does the keyboard fight the drag?
- [ ] Type, then drag the **body**: the sheet must not scroll the whole page behind
      it (`overscroll-behavior`).
- [ ] iPhone with a notch/home indicator: the sheet's bottom padding and the
      drawer's bottom padding must clear the indicator. Nothing important under it.
- [ ] Rotate to landscape mid-sheet: the sheet re-fits and can still be dismissed.
- [ ] Pull-to-refresh: drag the **body** of a sheet down from the very top — the
      browser's refresh must not hijack the gesture.

## 8. Cross-cutting

- [ ] Reduce Motion ON: drawer and sheets should still move and dismiss, just
      without decorative transitions. Nothing should be stuck.
- [ ] Very long content (a sheet taller than the screen, a drawer with every nav
      item): gestures still behave at both ends of the scroll.
- [ ] Low battery / Low Power Mode on iOS: re-check the drawer settle and the sheet
      dismissal — throttled devices historically change animation timing.
- [ ] Watch for per-frame smoothness during a drag (this is the honest measure of
      1:1 tracking on a real compositor; emulation cannot show it).
- [ ] **Two fingers:** start a drag with one finger, then rest a second finger on
      the screen and slide it. The surface must **not** jump to the second finger,
      and lifting the second finger must **not** end the drag. Then lift the first.
- [ ] Interrupt a drag with a system gesture (swipe from the very bottom edge,
      notification shade, incoming call): the surface must not be left stranded
      half-dragged — it should settle back or dismiss cleanly.
- [ ] No text selection or long-press callout while dragging a header.
- [ ] No scrollbar flicker or layout shift when a sheet is thrown away.

---

## What the Node harness now proves (don't re-test these on the phone)

`npm run test:gesture` (dev/gesture-test.mjs) drives the real engine with
synthetic pointer events — 30 checks, no browser. It runs in `npm test` and in
the strict gate like every other suite, so every one of these rules is now caught
before it reaches a phone:

- **The slop gate** (`SLOP = 8`): a 3 px wobble paints nothing; past the gate the
  finger tracks 1:1; a mostly-vertical move aborts instead of dragging sideways; a
  direction the surface refuses ends the gesture before anything paints;
  `canStart` returning false means no gesture at all.
- **Pointer ownership**: a second finger landing mid-drag cannot drag the surface
  out from under the first; a second finger lifting does not end the gesture; a
  mouse and a non-primary button never start a touch drag.
- **The velocity sample and the projection, measured over a range**: a stale
  sample outside the 90 ms window does not drag the average down (a 3,000 px/s
  flick stays 3,000, where including the old sample would have read ~154); and
  **310 real throws — 150 to 4,000 px/s either way, in 25 px/s steps — are driven
  through the engine**, each one's projection compared with Apple's decay curve
  (the slope, not one point on it: the previous single 3,000 px/s sample could not
  see the constant, and 0.999 doubled it and passed). A tap that never moved is
  not a throw.
- **The reopen race**: a gesture started immediately after a throw is not ignored,
  and a cancelled pointer (the browser taking the gesture) leaves the surface
  usable at once rather than stuck live.
- **The click seal**: a real click landing on a throw is swallowed, a programmatic
  click passes through (the composer's Cancel path), and a plain tap is not sealed
  at all — so the button it tapped still works.

The **release policies** — where the drawer lands, when a sheet is thrown away,
what a lightbox does with a pull — live in `assets/release-policy.js`, which
holds no DOM at all, and two suites cover them from either side.

`npm run test:policy` (dev/release-policy-test.mjs) is pure Node and sweeps
them directly: **every integer height from 1 to 900 px, a thousand viewport
widths, every integer distance on each, and 201 real velocities from -4,000 to
+4,000 px/s driven through the engine's own projection into the release** —
14.5 million cases in under two seconds. That is the only place the *flick*
(`v > 280 px/s`, which dismisses at any distance) and the *momentum coast*
(what a projection may carry over the line, and the clamps at 0.4 and 1.2 of
the drawer's width) are exercised at all, because neither is reachable from a
settled drag — and the velocities are what make them one test rather than two:
the release is checked against what the engine really projects, so a
release that misread a projection fails there. It also
asserts the drawer's paint round-trips — the position a release decides on is
the finger's own, at any distance — and that the line for a surface shorter
than the 90 px floor sits beyond its own height, so such a surface can only be
thrown away by a longer pull or a flick. What it cannot defend is the
projection's own arithmetic, because it borrows that rather than copying it:
`DECAY` passes every check here and fails the gesture suite's measured sweep,
which drives 310 real throws and owns the curve. What it catches that nothing
else can is a *release* that misreads a projection. Both were mutated to show
which half each one misses.

The admin boot suite (`npm run test:admin`) covers the other half: that the
page actually *calls* that module, with the right state and geometry, through
real pointer sequences at its sandbox's document listeners, reading the painted
custom properties back. It asserts that each surface *engages* and tracks the
finger before asserting where it landed, so a surface that stops responding
fails there rather than on your phone.

It also owns the two things a pure module cannot reach. **The velocity
hand-off**: eight *gates* — a surface, a distance its distance rule refuses, and
the same finger thrown at 300 px/s and at 273 px/s and held still — across all
four surfaces, with the throw's deferred half (the 210 ms hand-off, the overlay's
close, the player's teardown) read afterwards. Handing the policy a velocity of
zero, or halving it, fails exactly those checks and nothing else; the same
mutation is invisible to every other suite. (The drawer's old flick check could
not do this: a 280 px leftward drag on a 288 px panel is past half its width, so
it shut the drawer whether any velocity arrived or not. It travels 100 px now.)
One further gate isolates the *projection* instead: a 279 px/s throw — under the
gate, so the flick never runs — dismisses because 12 px plus 139 px of momentum
clears a 90 px line the 12 px alone cannot, and dropping the projection to zero
fails that check alone. **The surface contract**: every dismissible root in
`admin.html` — `admin-side`, `modal-overlay`, `lightbox` — has to be claimed by a
registration in `assets/release-policy.js`, by name, with `policyFor()` throwing
for a name it does not know. Add a fourth overlay, or rename a registration, and
the suite fails; renaming one breaks the page loudly, which is how the test
proves the page really reaches the rules through the registry rather than beside
it. A registration that matches *nothing* in the page fails too, so a surface
removed from the HTML cannot leave a stale entry behind looking like coverage,
and `admin.js` is held to the registry at the source level — a direct call to
`Policy.surfaceRelease()` fails one named check.

Each policy is **swept**, not sampled: every integer distance from 0 to the
surface's own size is driven through the real gesture at several geometries —
sheet heights of 240/420/820 px, lightbox targets of 263/726/657 px (a landscape
photo, a portrait photo at `max-height: 86vh`, the video card), and drawer
widths of `min(82vw, 288px)` on 320 px and 390 px viewports plus the case where
the panel cannot be measured at all. That is 13 sweeps and 5,077 drags, and
they are what exercise both branches of `max(90, 0.3 * height)` — the 90 px floor
decides for a short sheet, the percentage for a tall one. What they assert is
stronger than the two drags either side of a line that stood here before: the
verdict changes **exactly once** across the whole range, at the px line the
policy documents — so a threshold that moved by a single pixel, or a rule that
dismissed in a band and relented past it, fails there rather than on a phone.
Both suites assert the same two facts, which is what makes the extraction safe:
a policy that moves fails the pure sweep (many geometries, instant) *and* the
boot suite (one page, wired end to end).
The drawer also reports the width it actually divided, read off its own paint,
so the harness cannot quietly test a panel the stylesheet never lays out.

What remains uncovered, and is therefore still the reason to run sections 1–7 on
real hardware: actual CSS transitions, real layout — those heights and widths are
written from the stylesheet's own numbers, not measured by a layout engine — and
browser gesture arbitration — the iOS
edge back-swipe, pull-to-refresh, and the keyboard. One more caveat worth
knowing: the Node harness always injects an event target, so a module that cannot
find the document passes all 30 of its checks while every real page throws. That
happened once and the boot suite caught it, which is the reason to run both.

## What emulation already proved (don't re-litigate)

Verified at 375×812 with synthetic touch pointer events on the current build:
40 px and 130 px drags track 1:1; the backdrop alpha dims from 0.94 to 0.827 and
to 0; a 30 px slow drag snaps back (sheet stays open, vars cleared); a 60 px fast
flick dismisses; upward and horizontal drags never engage; a tap on ✕ still
closes; the dirty composer raises the discard prompt and is put back in place
(computed transform is identity); swiping the prompt keeps the composer; the
drawer's `--side-edge` tracks 50 → 170 px with the grip's translation matching
exactly; the grip is 0.5 opacity at rest, 0 when open, 0.85 during a drag; and
the boot suite is green with no console errors.

Added with the lightboxes and the shared engine:

- Photo viewer: a 40 px slow drag tracks 1:1 (`--lb-y: 40px`, backdrop 0.947),
  a 45 px slow drag snaps back, a 70 px flick dismisses and **cleans its vars**
  so the next open is untranslated; a plain tap still closes it.
- Video card: the title row tracks 1:1 (50 px → `translateY(50px)`, backdrop
  0.907) and snaps back; dragging the video or the card's padding engages
  nothing; a flick dismisses and the player container is emptied.
- Grabbing a surface **during** its open animation cancels that animation and the
  finger owns the frame from that moment (the sheet showed `translateY(45px)`
  with zero animations left, where it used to be pinned at the popIn's scale).
- Reopening a sheet or a lightbox **during** its 210 ms slide-away now keeps the
  fresh open (open-token guard) — before the fix the stale close won and the
  surface appeared then vanished.
- Stress: 12 rapid open/close cycles of the details sheet left no open overlay,
  no stray `--sheet-*` vars and no drag classes; an 11-section walk (3 rounds)
  stayed clean; 8 search terms and every status filter ran without console
  errors; no horizontal overflow at 375 px (`scrollWidth - clientWidth` = 0);
  and a swipe in the **dirty composer** still raised the discard prompt with the
  composer intact.
- The drawer no longer opens from the left edge while a sheet or lightbox is up,
  and a quick tap on a nav item still navigates (no seal without movement).
- **One finger owns a gesture:** a second finger touching down mid-drag no longer
  drags the surface out from under the first (the engine pins the pointer id), and
  its release no longer ends the gesture — the first finger kept tracking (40 px
  held while the second finger moved and lifted, then continued to 80 px).
- **pointercancel** (the browser taking the gesture away) settles cleanly: the
  lightbox dismissed, its vars were cleared and no drag class was left on `body`.
- An 11-section walk plus every status filter and 8 search terms ran with a clean
  console (only the mock harness's own boot line).

## What emulation cannot prove

- Feel: rubber-band stiffness, flick threshold, momentum — thresholds were chosen
  from Apple's fluid-interface guidance (0.998 decay, 280 px/s flick, 8 px slop)
  and only a thumb can confirm them. **`dev/feel-tuner.html` is where that happens**:
  it loads the real `swipe-gesture.js` and `release-policy.js` with the constants
  substituted, shows the velocity, projection, line and verdict of every release
  you make on it, and prints the exact `from → to` pair to fold back when a value
  feels right. Changing a value there is a real change to the real files (never a
  second implementation) and folding one in without moving the spec fails
  `npm run test:policy` — deliberately: a policy change and its spec move together.
- Per-frame smoothness on a real compositor.
- Browser gesture arbitration: iOS edge back-swipe, pull-to-refresh, and the
  keyboard's interaction with a raised sheet.
- Safe-area behaviour under a real notch/home indicator.
- Anything about the on-screen keyboard, which desktop emulation does not have.

## Results

Fill this in and paste the table back — one row per check that did **not** simply
pass, so the fix can start from your repro rather than from a description. For a
gesture failure the four things that make it fixable are: direction, distance,
speed (fast flick or slow drag), and what the surface did instead.

| # | Check | Device | Result | Direction / distance / speed | What happened instead |
|---|-------|--------|--------|------------------------------|-----------------------|
|   |       |        |        |                              |                       |

If the whole run passes, say so and name the device, OS version and browser —
that is what makes "verified on hardware" a claim rather than a phrase.
