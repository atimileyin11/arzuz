# Arzuz Admin — Rework Test Report

**Date:** 2026-10-06 · **Branch:** main (uncommitted working tree)
**Harness:** `?mock=1` (fake Supabase session + stubbed fetch, zero production data)
**Automated suite:** `node dev/admin-boot-test.js` — **95 / 95 PASS** (admin, support, marketing)

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

## 2. Automated coverage — 95 checks

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
- Add-apartment insert path, plus the cancel/keep/discard triad (see §12)
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

---

# Round 2 — the apartment composer (2026-10-08)

The Add/Edit apartment surfaces were rebuilt as a three-tab instrument (Property & Pricing ·
Location & Access · Media & Draft), keeping the flat grid for the other tables.

## 8. Automated suite

`node dev/admin-boot-test.js` — **95 / 95 PASS** (the original 90 checks plus five that pin down the
composer's exit path; see §12).

## 9. Browser walk (dev server + `?mock=1`)

| Surface | Checked |
|---|---|
| Tabs | Add modal opens on *Property & Pricing*; the other two panels stay `hidden` and keep their controls in the DOM |
| Amenity combobox | typing filters the shared list, ArrowDown highlights, Enter adds a preset; an unknown word creates a **custom** chip; ✕ removes a chip |
| Availability | segmented *Vacant units* / *Fully occupied* hides the unit count and stores `avail`; payload `rm` becomes “3 rooms available” / “Fully occupied” |
| Unified map | the map builds when the tab is first revealed; **[Pin location \| Draw path]** toggles leaflet's trace mode; a 3-point trace is simplified to a stored `route` (2 pts) and **`pin_meta.source` survives the linger** (it used to be overwritten by the trace commit) |
| Media queue | a picked photo appears in the staging grid with a **live %** (20 → 40 → 60 → 80 → committed), the ✕ removes it, ★ sets the cover, the hidden `add_photo_url` stays in sync; a failed upload stays on screen as *Failed — remove* with “0 uploaded, 1 failed” |
| Cancel | a dirty form opens **Unsaved changes** → *Save to draft* inserted `status='draft'` with token + permission + 7-day expiry and opened the share panel; *Discard* and *Keep editing* do what they say (see §12) |
| Draft link | switching to **Public view only** + *After 24 hours* PATCHed the row and re-rendered the panel (“Currently: View only · expires 09 Oct 2026”); the listings table badge reads *view link sent* |
| Edit modal | same three tabs; role/units/availability/amenity chips/access-notes pre-filled; the stored route is restored into the trace editor (“2 pts”); saving wrote `avail`, `rm`, `contact_role`, `passage.landmark` and preserved the route |
| complete-listing | permission `view` → `body.cl-view-only`, inputs disabled, upload + gallery + save hidden, “Your apartment details” copy, read-only route map; permission `edit` → expiry banner, editable form, upload zone and save button; the landlord save still PATCHes through the RPC stub |
| Missing migration | with the insert forced to fail with `PGRST204 draft_permission`, the composer retried without the two columns, created the draft, opened the share panel and toasted “run supabase-draft-sharing.sql” |

## 10. Notes / limitations

- The dev server (`dev/upload-mock-server.mjs`) answers `/api/cloudinary-sign` with 503, so the
  photo *success* path was verified against a stubbed XHR/signature; the real failure path was
  verified unmodified.
- YouTube upload could not run locally (`GOOGLE_*` not configured) — the code fell back to
  Cloudinary exactly as designed.
- View-only / expiry enforcement is server-side in `supabase-draft-sharing.sql`; until that file is
  run against the live project the controls save but are not yet enforced (the dashboard says so).

## 11. Version pins

`admin.css?v=5` · `admin-ui.js?v=5` · `admin.js?v=12` · `arzuz-map.js?v=3` (every page that loads
it: admin, browse, complete-listing, listing, owner-list, scout) · `complete-listing.js?v=3`.
Round 3 moved `arzuz-map.js` 2 → 3 (the pin-fabrication fix is in `pinCapture`, so every page
needs it) and `complete-listing.js` 2 → 3.

## 12. The exit path — a real bug found by re-walking it

A second pass over **Cancel → Unsaved changes** found that *Discard* and *Keep editing* could leave
the overlay on screen. The handler was never at fault (`closeModal()` was called for both overlays
and the “Changes discarded.” toast fired); the close itself was. `ArzuzUI.closeModal()` removed
`.open` **only** from the `animation.onfinish` callback, and in a document that is not painting
frames (backgrounded tab, headless renderer) that callback is deferred indefinitely — the animation
reports `finished` while `.open` stays on the element forever. A confirm dialog whose buttons do
nothing is a functional dead end, so the fix is in `admin-ui.js`:

- `closeModal()` now removes `.open` from the callback **and** from a 300 ms timer, with a token so a
  re-open inside that window cannot strip the class off a freshly shown overlay (`popIn`/`trapFocus`
  bump the token).

Verified in the preview browser (`?mock=1`, 1440×950), each step awaited past the 180 ms close:

| Step | Result |
|---|---|
| Clean form → **Cancel** | composer closes, no prompt |
| Edit a field → **Cancel** | *Unsaved changes* opens above the composer |
| **Keep editing** | prompt closes, composer + typed value intact |
| **Discard** | both overlays close, toast “Changes discarded.”, nothing written |
| Re-open → **Cancel** | clean close, no prompt (`dirty` flag reset) |
| Re-open | lands on *Property & Pricing* with area/media/chips/`add_photo_url` empty, availability back to *Vacant* |

Locked in by five new suite checks. The shim's `animate()` never fires `onfinish`, which is exactly
the failure mode, so the checks fail loudly if the fallback is dropped — confirmed by deleting the
`setTimeout(finish, 300)` line: `95 → 92 PASS`, with `cancel: “keep editing” returns to the form`,
`discard: closes both overlays without an animation callback` and `discard: resets the dirty flag`
all reporting `add open=true exit open=true`.
---

# Round 3 — the landlord invite form (2026-10-08)

## 13. The other form: `complete-listing.html` rebuilt to the same spec

`complete-listing.html` is the landlord's end of the same workflow — the page behind
`arzuz.com/complete-listing?ref=<draft_token>` — and it had been left on the old layout that the
composer rework replaced: one endless scroll, a `Negotiable?` select, a free-text “rooms available”
box, two name fields plus a “who runs the compound?” select, a fixed grid of amenity buttons, a map
that could only drop a pin, four separate landmark/gate/stairs answers, uploads that fired the moment
a file was picked, and a single `Send to Arzuz` button with nothing to catch a half-filled form. Two
of the same fields, two different vocabularies.

It now runs the same composer: **the same three tabs, the same field set, the same components.**

| Spec item | Admin composer | Landlord invite form |
|---|---|---|
| 3 tabs | Property & Pricing / Location & Access / Media & Draft | identical labels, same order |
| Apartment name | optional, `autoAptTitle()` + `name_generated` | same helper, same flag; a generated title is offered as the **placeholder**, not as text to clear |
| Pricing | Rent + Opening Ask, **no Negotiable** | same two fields (`ask` reaches `opening_ask_ngn` only while that column is empty); `neg` is never written by either form |
| Contact | Contact Person + Phone/WhatsApp + Role | same three fields, same four roles (`Landlord · Caretaker · Agent · Admin`) |
| Availability | `data-seg` toggle + unit count | same seg, same `avail` / `units` / `rm` payload keys |
| Amenities | searchable combobox + custom tags | same component (presets from `UTILITIES`, typed tags marked `custom`) |
| Map | one map, `[Pin · Draw path]` seg | same widget, same seg, trace-id overrides so the two maps can coexist |
| Directions | one *Access & Navigation Notes* textarea | same field → `passage.landmark` |
| Media | staging grid, ✕ remove, ★ cover, compression, % per file | same grid, same compression, same percentage bars, photos **and** video |
| Video | drop zone **or** URL embed | both, plus the YouTube poster frame in the tile |
| Exit | Cancel → Save to draft / Discard / Keep editing | Discard changes → Save draft & close / Discard changes / Continue editing |
| Draft links | permission + expiry panel (Viewer / Editor / 7 days) | the holder's side of it: expiry banner, `view` locks the page, `edit` stays open |

Two deliberate differences, both because the two people are not the same person:

- **Opening Ask** is written to the column only while it is empty, so a landlord cannot overwrite the
  number the team recorded from its own field notes — that number is the metric the whole business
  case rests on.
- **Save draft** on the landlord page sends `save_mode: 'progress'`, which the write RPC consumes (it
  is not on the whitelist, so it never reaches the payload) to leave `draft_completed_at` alone. A
  half-filled form no longer shows up as *Landlord completed*, which is what `draft_completed_at`
  means in the ops panel, the draft counters and the row detail.

### The bug this round found: a pin nobody placed

Both composers seed the shared map at the town centre (`MALETE`) when a row has no coordinates, and
`pinCapture` was *committing* that seed as `source: 'tapped'`. So simply opening the Location tab
wrote a real pin into the payload. Worse, `assets/app.js` (the owner and scout wizards) invented the
same coordinates during validation:

```js
if (type === 'pin') {
  if (req && !F.answers.lat) { F.answers.lat = 8.7113; F.answers.lng = 4.4697; … }
```

Every owner or scout submission without a pin was filed in the middle of Malete, and every listing
pinned that way fed a fabricated walking distance into the browse and listing pages.

Fixed at the source:

- `arzuz-map.js` tracks `pinned` — set only by a saved pin, a tap, a drag or a GPS fix. Until then
  the marker is a handle parked on the map centre, the host's fields stay empty, and nothing is
  reported. Tracing a path with no pin reports the **route alone** (`onRoute`), so a real walk path
  is never mixed with invented coordinates.
- `app.js` blocks the step with a real message instead of inventing a location: “Drop the pin on your
  gate to continue — tap the map, drag the marker, or press “Use My GPS” while you stand there.”
- `admin.js` (Add + Edit) and `complete-listing.js` implement `onRoute`, keeping the route without a
  position.
- The landlord page no longer carries `cl_lat` / `cl_lng` / `cl_pin` / `cl_pin_meta` hidden inputs at
  all — the map writes straight into the payload.

Verified in the browser on both forms: mounting the map writes nothing; a real tap writes
`source: 'tapped'` with the tapped coordinates; a payload saved with no map interaction contains no
`lat`, `lng`, `pin` or `pin_meta` key.

### How it was walked

`dev/complete-listing-harness.html` boots **the real page** — same markup, same scripts, fetched and
written into a dev-only document — after pointing `SUPABASE_URL` at the dev server's mock RPC routes
(`dev/upload-mock-server.mjs` gained seed / `listing_draft_get` / `listing_draft_update` /
`last-patch` under `/mock/sb/…`) and swapping `XMLHttpRequest` for a stub that reports real progress
ticks, so the tiles run 8 % → 51 % → 74 % → 93 % → 100 % instead of dying on the deliberate 503 from
`/api/cloudinary-sign`.

```bash
node dev/upload-mock-server.mjs 8799
# ?seed=blank | existing | generated   ·   ?perm=view   ·   ?ref=<uuid>
open http://localhost:8799/dev/complete-listing-harness.html?ref=11111111-1111-4111-8111-111111111111&seed=blank
```

| Walk step | Result |
|---|---|
| Boot, `seed=blank` | three tabs, *Property & Pricing* active, other two panels `hidden`; Discard disabled while clean |
| Tab 2 revealed | Leaflet builds into a visible container; no pin committed (`lat` / `lng` empty, badge still prompting) |
| `Pin location ↔ Draw path` | trace bar shown in Draw mode, hidden back in Pin mode |
| Tap the map | badge + `pin_meta {source:'tapped'}` written |
| Amenity combobox | presets listed, `Solar panels` added as a preset chip, `Roof water tank` created as a `custom` chip on Enter, ✕ removes |
| Photo staging | tile appears **before** upload (`Queued`), then 8 → 51 → 74 → 93 → 100 %, tile becomes committed with ★ Cover photo |
| Cover / remove | ★ on the second photo re-orders `MEDIA`; ✕ drops the tile and re-syncs `cl_photo_url` |
| Video | third tile renders the real `i.ytimg.com` poster frame from a pasted YouTube link |
| Send with no map use | payload has **no** `lat` / `lng` / `pin` / `pin_meta`; auto title `Self-contain in <area>`, `name_generated: true` |
| Save draft | `save_mode:'progress'`, `draft_completed_at` stays null, toast + “Progress saved” note, form stays open |
| Send to Arzuz | `save_mode:'send'`, `draft_completed_at` set, done screen, Telegram payload |
| Discard changes (dirty) | modal opens → **Continue editing** keeps the typed value → **Discard changes** re-reads the row and puts the form back, Discard disabled again |
| `seed=existing` + Send | legacy `who:'A caretaker'` → role *Caretaker*; `units` 3; `passage.landmark` → notes field; the 3-point traced route **survives a save that never touched the map** |
| `seed=generated` | name box empty, generated title shown as the placeholder, re-saved with `name_generated: true` |
| `perm=view` | `body.cl-view-only`, inputs disabled, save/draft/discard + drop zones + URL row hidden, map rendered read-only with the route polyline, tiles carry no ✕/★, copy switched to “These are the details Arzuz recorded…”, badge shows the recorded coordinates instead of an impossible instruction |
| Phone width (420 px) | all three tabs on screen (grid, wrapping labels, no horizontal scroll), seg full-width, media grid 2-up, actions wrap sensibly |

### Sibling sweep (one vocabulary everywhere)

- `owner-list.html` — `Negotiable?` removed (the spec says remove it completely), the “who runs it”
  answer set is now the four roles, and the rooms field is labelled “Vacant rooms right now (0 if the
  place is full)”. Its pin step no longer invents coordinates.
- `scout.html` — a scout report is hearsay by nature, so its `who` answers stay as written; the
  composer maps *The owner / A caretaker / An agent* onto the role vocabulary when it reads them.
- `browse.html` — the card said `per session · negotiable: ask us`; since no listing can be marked
  negotiable any more, the line is now just `per session`.
- `listing.html` — keeps its conditional `Negotiable:` chip for rows that already carry the value
  (legacy, read-only) and drops it for everything new.
- `netlify/functions/notify.js` — the Telegram templates no longer print a `Negotiable:` line; they
  print availability, and `contact_role` instead of the old `who`.
- `supabase-draft-sharing.sql` **and** `supabase-drafts-support.sql` — the same whitelist in both
  (`name_generated`, `ask`, `avail`, `units`, `contact_role`, `access_notes`), `ask` → the column
  while it is empty, `save_mode:'progress'` leaves `draft_completed_at` alone. Running only one of the
  two files can no longer silently drop a field the forms send.

### Limitations

- The signed-upload **success** path cannot be reached from the dev server (`/api/cloudinary-sign` is
  a deliberate 503). The failure path is real and was verified (staged tile → *Failed — remove*, with
  its ✕ and the untouched preview); the success path rides the harness's stub.
- `supabase-draft-sharing.sql` has **not** been run against the live project, so view-only/expiry
  enforcement plus the new `ask` / `save_mode` behaviour stay inert in production until it is.
- `beforeunload` (the unsaved-changes guard on the landlord page) could not be exercised in the
  attached browser: dispatching `beforeunload` from the console hangs the renderer, which is the same
  machinery the real dialog uses. Code-reviewed only; it arms only while `dirty`.
- No real-device pass on a phone; the mobile checks above are at a 420 px viewport.

### Worst-case data — the `break-ui` pass

The invite form was then fed one worst-case row (`?seed=worst`): a 62-character lodge name, `Ọ̀pẹ́ Ọ̀gá Area 🏠` for the area, `Alh. Abdulrahman ‘Ọ̀gá Àgbà’ Kareem-Olaniyan` for the contact, `+234 803 345 5667`, ₦1,250,000 rent *and* ask, **0** vacant units, a 1,578-character description, twelve amenities (one a case-duplicate of a preset, one 53 characters long), a three-line note and 40 media items — 38 photos, a `youtu.be` share link and a Google Drive file URL. The dev toggle now has four states: **Demo · Worst · Empty · One**.

| Break | Severity | Worst-case value | What happened | Fix |
| --- | --- | --- | --- | --- |
| Media panel overflowed its card | **Broken** | 40 tiles | At ≤330 px `repeat(auto-fill, minmax(118px, 1fr))` gave `.cl-stage` a 246 px min-content inside a 231 px track, so the whole `.cl-grid` track grew to 273 px: the page scrolled sideways (`scrollWidth 312` vs `clientWidth 309`) and the drop zone was clipped. Only visible on the media tab — which is why the earlier 320 px pass missed it | `minmax(0, 1fr)` tracks + `minmax(min(104px, 100%), 1fr)` tiles — [complete-listing.html:29](complete-listing.html#L29), [:134](complete-listing.html#L134) |
| `0` vacant units saved as *“Units available”* | **Broken** | `0` | `parseInt('0')` failed the `> 0` test → `units: null`, `rm: "Units available"`, `avail: "vacant"`. A fully let lodge advertised as free. `-5` behaved the same, `2.7` silently became `2` | An explicit zero is kept and stored as `avail:'occupied'` / `rm:'Fully occupied'`, with a note under the box; `> 999` is capped with its own note — [assets/complete-listing.js:803](assets/complete-listing.js#L803) |
| A pasted link that cannot play became a dead tile | **Ugly** | `drive.google.com/file/d/…/view`, `vimeo.com/76979871`, `not-a-video.example.com/photo.jpg` | The guard was a bare `^https?://`, so any URL was stored as `video_url` and drawn with `<video src>`: a black tile that never loads, and a public listing pointing at a web page instead of a video | Accept list = YouTube (all four shapes) or a direct video file; everything else is refused with a reason. Older rows render `🎥 drive.google.com` (`.cl-nothumb`). `javascript:` / `data:` refused, nothing injected — [assets/complete-listing.js:730](assets/complete-listing.js#L730), [:531](assets/complete-listing.js#L531) |
| 40 files staged in one synchronous pass | **Fragile** | 40 photos | `stageFiles` re-rendered the grid once per file *and* opened all 40 uploads at once | One paint per batch, three uploads in flight, the progress line counts in-flight. Measured: **102 ms** to stage 40 tiles (was ~4,900 ms), exactly 3 uploading / 37 queued — [assets/complete-listing.js:612](assets/complete-listing.js#L612) |
| The empty-state paragraph rendered as a 110 px column | **Ugly** | a brand-new invite | `.cl-empty` is a grid item of `.cl-stage`, so it sat in one 110 px column: 111×116 px of wrapped text | `.cl-empty { grid-column: 1 / -1 }` — one line, 495×39 px — [complete-listing.html:216](complete-listing.html#L216) |
| A 91-character single-word amenity stretched the page | **Fragile** | `SolarPanelWithBatteryBackup…` ×2 | `.cl-tag { max-width: 100% }` cannot clamp while the containing block is content-sized: the field measured 661 px inside a 309 px viewport (`scrollWidth 701`) | `min-width: 0` + `overflow-wrap: anywhere` on the chip text, `max-width: 100%` on the field, custom tags capped at 60 characters with a toast — [complete-listing.html:74](complete-listing.html#L74), [:84](complete-listing.html#L84) |
| Nothing had a length limit | **Fragile** | 62-char name, 1,578-char blurb | No `maxlength` anywhere in the form, and the payload is `jsonb`, so `property_name` is unbounded too — and it is rendered in the dashboard tables and on the OG card | `maxlength` on every text field (name 70, area 80, contact 60, phone 24, amenity 60, description 2000, notes 600, link 300) plus `min`/`max`/`step` on the money and unit inputs. **The server side stays unbounded** |
| A YouTube link pasted without a scheme was refused | **Ugly** | `www.youtube.com/watch?v=aqz-KE-bpKQ` | `^https?://` answered “That does not look like a link.” to the most common paste on a phone | A missing scheme is normalised to `https://` before the check |

**Held up.** `esc()` on every value: an injected `<img onerror>` and a `javascript:` URL produced no elements and no XSS. No horizontal overflow at 240 px, 320 px or 584 px after the fixes (0 overflowing elements on all three tabs; `.cl-tabs` `scrollWidth == clientWidth`). Diacritics, emoji, curly quotes and `₦` render without mojibake. A 1,578-character description scrolls inside its textarea; a 62-character name survives in its input. The case-duplicate amenity collapses to one chip on load. `✕` on a staged tile revokes its blob URL, and each preview is revoked once the real URL exists. `?perm=view` still hides every control (0 buttons inside 40 tiles), hides the unit note, and disables the fields. Saving the worst row wrote `avail:'occupied'`, `units:null`, `rm:'Fully occupied'`, `save_mode:'send'`; the *One* state wrote `rm:"1 room available"`.

**Left alone deliberately:** 40 tiles is a 965–1,860 px panel with no pagination (the real fix is a per-batch cap or a “show all” clamp); the 40 blob previews are held until each upload finishes; and the dashboard's manual video box still advertises “YouTube / Vimeo / direct video link” while the player is YouTube-only.

**Suite after every fix above:** `TOTAL 95 · PASS 95 · FAIL 0`, exit 0 (`/tmp/arzuz-suite5.log`).

### The three follow-ups (same day)

1. **The media grid is capped.** `GRID_CAP = 12`: the committed grid paints twelve tiles plus a full-width
   `Show all 40 (28 more)` row. Staged tiles always render, because that is the batch the landlord is
   watching go up and they disappear as the uploads land. Expanding is a *view*, not an edit — it works on
   a read-only link too, never marks the form dirty, and the hidden tiles never leave `MEDIA` or the
   payload. Removing a tile while capped still targets the real index (verified: after ✕ the label reads
   `Show all 39 (27 more)`, cover untouched). The media panel drops from ~1,860 px to 336 px, the whole
   page from ~4,000 px to 1,429 px, with no overflow at 584 px or 320 px.
   → [assets/complete-listing.js:559](assets/complete-listing.js#L559)
2. **The payload has a server-side length guard.** `public.listing_payload_clamp(jsonb)` is defined in both
   SQL files and `listing_draft_update` calls it on the whitelisted patch before the merge: text fields at
   the forms' own ceilings (name 70, area 80, contact 60, phone 24, description 2,000, notes 600, links
   300), money digits-only ≤ 8, units 0–999 (0 stores `avail:'occupied'` + `Fully occupied`), and a media
   list longer than 60 trimmed to its first 60. A caller posting straight at the endpoint can no longer
   store an 8,000-character lodge name for the dashboard table and the OG card to render. The helper is
   revoked from `public` alongside the two RPCs.
   **Not executed — no Postgres in this workspace.** Desk-checked only; §4 (i) of `supabase-draft-sharing.sql`
   is the query that proves it once the file is applied.
3. **One video rule, in the player's own file.** `ArzuzVideo.isPlayable` / `normalizeUrl` /
   `playbackProblem` now live in `assets/video.js`, and the landlord form *and* both dashboard entry points
   (add + edit) call them: a YouTube link or a direct video file, a missing scheme normalised, and the same
   sentence when a Drive / Photos / Vimeo page is refused. The dashboard's manual box no longer advertises
   Vimeo it cannot play, and it got the same `maxlength="300"`. Pins: `complete-listing.js?v=5`,
   `admin.js?v=14`, `video.js?v=2` (admin.html, listing.html, complete-listing.html).
   **The dashboard's embed box was verified as shipped, not clicked** — admin.html boots against Supabase
   and there is no session here; the shared rule itself was exercised in the browser through the landlord
   form (Vimeo and Drive both refused with their own sentence).

Suite after all three: `TOTAL 95 · PASS 95 · FAIL 0`, exit 0 (`/tmp/arzuz-suite7.log`).
