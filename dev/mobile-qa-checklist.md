# Arzuz admin — mobile touch QA checklist

Run this **on real hardware** before this work is called done. The gesture logic,
geometry and state machine were verified in desktop emulation at 375×812 with
synthetic `PointerEvent`s — that proves the decision code, not the feel. Real
fingers, real compositors and real browser gesture arbitration are the parts
that only a phone can answer.

Scope: the mobile drawer swipe, the new drawer drag indicator, the new
swipe-down-to-dismiss bottom sheets, and the shell around them.

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

## 6. Keyboard + safe areas (this is where sheets usually break)

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

## 7. Cross-cutting

- [ ] Reduce Motion ON: drawer and sheets should still move and dismiss, just
      without decorative transitions. Nothing should be stuck.
- [ ] Very long content (a sheet taller than the screen, a drawer with every nav
      item): gestures still behave at both ends of the scroll.
- [ ] Low battery / Low Power Mode on iOS: re-check the drawer settle and the sheet
      dismissal — throttled devices historically change animation timing.
- [ ] Watch for per-frame smoothness during a drag (this is the honest measure of
      1:1 tracking on a real compositor; emulation cannot show it).
- [ ] No text selection or long-press callout while dragging a header.
- [ ] No scrollbar flicker or layout shift when a sheet is thrown away.

---

## What emulation already proved (don't re-litigate)

Verified at 375×812 with synthetic touch pointer events on the current build:
40 px and 130 px drags track 1:1; the backdrop alpha dims from 0.94 to 0.827 and
to 0; a 30 px slow drag snaps back (sheet stays open, vars cleared); a 60 px fast
flick dismisses; upward and horizontal drags never engage; a tap on ✕ still
closes; the dirty composer raises the discard prompt and is put back in place
(computed transform is identity); swiping the prompt keeps the composer; the
drawer's `--side-edge` tracks 50 → 170 px with the grip's translation matching
exactly; the grip is 0.5 opacity at rest, 0 when open, 0.85 during a drag; and
the boot suite is 95/95 with no console errors.

## What emulation cannot prove

- Feel: rubber-band stiffness, flick threshold, momentum — thresholds were chosen
  from Apple's fluid-interface guidance (0.998 decay, 280 px/s flick, 8 px slop)
  and only a thumb can confirm them.
- Per-frame smoothness on a real compositor.
- Browser gesture arbitration: iOS edge back-swipe, pull-to-refresh, and the
  keyboard's interaction with a raised sheet.
- Safe-area behaviour under a real notch/home indicator.
- Anything about the on-screen keyboard, which desktop emulation does not have.

## Results

| # | Check | Device | Result | Notes |
|---|-------|--------|--------|-------|
|   |       |        |        |       |
