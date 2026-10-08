# Arzuz Admin — Rework Test Report

**Date:** 2026-10-06 · **Branch:** main (uncommitted working tree)
**Harness:** `?mock=1` (fake Supabase session + stubbed fetch, zero production data)
**Automated suite:** `node dev/admin-boot-test.js` — **90 / 90 PASS** (admin, support, marketing)

---

## 1. What the rework delivered

| Area | Before | After |
|---|---|---|
| Icons | Emoji glyphs everywhere (📈 📅 ✅ …) | ~35-glyph inline SVG sprite (`admin-ui.js`), hydrated via `[data-icon]` |
| Design system | Ad-hoc styles | Additive tokens in `arzuz.css` (`--dur-*`, `--r-*`, `--sp-*`, `--fs-*`); admin tokens (`--a1/a2/a3`, `--atext*`, `--apurple`, `--aok/warn/err/info`) |
| Motion | `transition: all` | CSS keyframes + WAAPI only: stagger-in sections, count-up metrics, pop-in modals, busy spinners, press scale(.97), `prefers-reduced-motion` respected |
| Accessibility | — | Modal `role=dialog` + `aria-modal` + focus trap + restore, `aria-live` modal errors, labelled close buttons, `focus-visible` rings, semantic table walked by a11y tree |
| Mobile | Fixed-width sidebar | dvh + safe-area insets, pill-scroll nav bar, bottom-sheet modals <860px, 16px inputs (no iOS zoom) |
| Testing | None | `dev/admin-mock-data.js` + `dev/admin-mock.js` (scenario switcher `__MOCK__.{role,empty,slow,error,reset,stats,db}`), `dev/admin-boot-test.js` VM-sandbox suite |

`strategy.js` (student-facing, byte-locked) was **not modified** — its emoji output is swapped at the presentation layer by `ArzuzUI.deEmoji` (DOM text-node surgery) plus `armDeEmoji` (MutationObserver catches docs painted asynchronously).

## 2. Automated coverage — 90 checks

Per role (admin / support / marketing):

- Boot with no console errors; gate hidden when mock session accepted
- Role landing page (admin→Overview, support→Support Desk, marketing→Growth)
- Every allowed route renders without console errors
- **Nav/section collision guard:** sidebar buttons also carry `data-section`; the suite spies on every `document.querySelector` call and fails if admin.js ever queries a bare `[data-section=…]` (regression: growth markup once rendered *inside the nav button*)
- Growth/Strategy rendered chrome contains no emoji glyphs
- Overview metrics trace 1:1 to the mock dataset (incl. roommate SQL-view %)
- Table row counts match dataset (test-env rows excluded)
- Details / Edit / Delete modals open for every table
- Delete type-ID confirm: wrong code rejected, right code enables button, delete removes the row
- Add-apartment insert path
- CSV export, phone-ticket insert, team roster + create, amenities manager, telegram status
- REST-failure scenario surfaces without boot crash

## 3. Visual walk (preview browser, 1440×900 desktop + earlier 375px mobile pass)

| Surface | Result |
|---|---|
| Overview | Metric cards, grouped nav, attention states, MOCK DB badge ✔ |
| Listings toolbar | status select fixed (was stretching full width) ✔ |
| Listings table | semantic table, status dots, draft badges, missing-ask chips ✔ |
| Details modal | two-column field grid, ACTIVE dot badge, amenity chips ✔ |
| Edit modal | two-column form; locked-ask checkbox now inline label ✔ |
| Delete modal | type-ID confirm; wrong input disabled button, correct code deleted row (8→7) ✔ |
| Draft invite modal | link, Copy/WhatsApp/Open actions ✔ (opened via the WA/draft action; the "Link" button copies the link without a modal — as designed) |
| Growth | traction cards, funnel, channels, budget bands, all-SVG action rows ✔ |
| Strategy | doc list + reader, markdown rendered, privacy note with lock icon ✔ |
| Support Desk | ticket table, SLA emphasis, action buttons ✔ |
| Roommates | 67% match metric, mate cards, candidates toggle, intro links ✔ |
| Settings | role cards, team roster, amenities ✔ |

Recorded walkthrough: [dev/screenshots/admin-walkthrough.webm](screenshots/admin-walkthrough.webm) (Overview → Listings → Growth → Strategy → Support Desk → Roommates → Settings).

## 4. Bugs found & fixed during verification

1. **Status filter stretched full-width** — `arzuz.css` sets a global `select { width:100% }`; `.search-box select` now resets to `width:auto; flex:none; max-width:220px`.
2. **Growth rendered inside the sidebar nav button** — nav items carry `data-section`, and the unscoped `[data-section="growth"]` query matched the nav button first. Render targets are now scoped to `.section-view[data-section=…]`; boot test guards the selector with a query spy.
3. **Strategy doc stuck at "Loading…"** — `deEmoji` originally rewrote `root.innerHTML`, detaching the pane that the async `paint()` callback held. Now does in-place text-node surgery (never replaces subtree), plus a debounced MutationObserver re-swaps emoji that arrive in later paints.
4. **Roommate cards had no styles** — `.mate-card/.mate-head/.mate-meta/.mate-actions/.mate-cands/.mate-cand` were missing from the rebuilt admin.css; added a proper card block (section 7b).
5. **Locked-ask checkbox floated detached** in the edit modal; wrapped with its label as `.ask-unlock` (flex row, accent purple).
6. **MOCK DB badge** — the env badge said "PRODUCTION DB" under `?mock=1`; the harness now relabels it to a warning-styled "MOCK DB".

## 5. Known non-issues

- One early amenities fetch still escapes to real Supabase before the wrapper installs on first load; the harness immediately re-fetches through the mock, so data stays mock. Harmless read-only, logged for awareness.
- `draft-copy` intentionally shows no modal (clipboard copy); `draft-wa` opens the invite modal.

## 6. Reproduce

```bash
cd arzuz-site
python3 -m http.server 8123          # server
# open http://localhost:8123/admin.html?mock=1   (localhost-only guard)

node dev/admin-boot-test.js          # 90/90 headless suite
```

Scenario switching from the console: `__MOCK__.role('marketing')`, `__MOCK__.empty()`, `__MOCK__.slow(1200)`, `__MOCK__.error('rest')`, `__MOCK__.reset()`, `__MOCK__.stats()`.

## 7. Version pins (cache-bust)

`admin.css?v=3` · `admin-ui.js?v=3` · `admin.js?v=8` — bump on any further edit.
