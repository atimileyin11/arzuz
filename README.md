# Arzuz — the site

A static, multi-page site with no build step, no framework and no dependencies in the browser.
Every page is plain HTML sharing six scripts in `assets/`, plus two Netlify Functions and a
Supabase database.

**Live and real** — the homepage and three forms write to Supabase. Verified, admin-approved
listings appear on `browse.html` through the `public_listings` view — the one public read surface.
Visitors can read exactly two things: verified listings, and the listing detail page behind
each card. Everything else stays write-only: a student who registers cannot wander into
data nobody verified, and a booking request can be sent but never read back.

---

## Run it

```bash
cd arzuz-site
python3 -m http.server 8000
```

Open `http://localhost:8000`. Forms work in preview: without Supabase configured they queue
submissions in localStorage. The Netlify Functions (`/api/notify`, `/api/cloudinary-sign`,
`/api/whatsapp-send`) only run under `netlify dev` or on a deploy — test those on the live URL.

**Deploy** — drag the folder onto [netlify.com/drop](https://app.netlify.com/drop), or push and
import the repo in Netlify so every push deploys itself. Environment variables are listed in
`netlify.toml`.

**Booking + roommate metric** — run `supabase-media-booking.sql` once in Supabase (it is
additive; it never touches existing rows). It creates the `booking_requests` table with the
same insert-only RLS as every other public table, plus the `roommate_match_summary` view
that powers the 14-day matching metric on the dashboard. New rooms and edits use the media
gallery manager in the admin dashboard — multiple photos plus a video tour, reorderable,
first photo is the cover, every asset carries the © Arzuz credit.

---

## Structure

```
arzuz-site/
├── index.html              Landing — hero, demand curve, problem, how it works, SEO FAQ
├── 404.html                Premium animated not-found page (served automatically
│                           by Netlify at any missing URL — root-absolute paths)
├── browse.html             Public verified listings (reads the public_listings view)
├── listing.html            Premium listing detail page: gallery, amenities, booking
├── register.html           Student: demand register          → demand_records
├── owner-list.html         Landlord: list a property         → listings
├── scout.html              Resident: register my building    → scout_submissions
├── safety.html             Your safety on Arzuz
├── privacy.html            Privacy policy
├── terms.html              Terms of use
├── admin.html              Private dashboard (Supabase Auth sign-in; sidebar shell —
│                           styles in assets/admin.css, logic in assets/admin.js)
├── complete-listing.html   No-login draft completion page behind the invite link
│                           (arzuz.com/complete-listing?ref=…) — logic in
│                           assets/complete-listing.js
│
├── strategy/               Positioning, market sizing, channels, unit economics —
│                           one framework per file, each linked to where it lands.
│                           PRIVATE: /strategy/* 404s on the public site; the docs are
│                           served only to a signed-in dashboard session by /strategy-docs
│                           (netlify/functions/strategy-docs.js)
├── supabase-schema.sql     Fresh install: tables, RLS, grants, views
├── supabase-drafts-support.sql  Additive upgrade: draft invite columns + RPCs,
│                           support_tickets, RLS and indexes
├── supabase-media-booking.sql  Upgrade: booking_requests + the 14-day roommate metric view
├── supabase-hardening.sql  Upgrades an existing database — run this one if you already have data
├── supabase-location.sql   Additive upgrade: pin-quality + passage-flag generated columns + indexes
├── supabase-public-view.sql One-paste addition of public_listings for a live, already-hardened DB
│
├── assets/
│   ├── arzuz.css           Design system — all colours, type, components
│   ├── admin.css           Admin dashboard only — dark shell, tables, modals
│   ├── config.js           Public config only (Supabase anon key, session, support number)
│   ├── auth.js             Supabase Auth session for admin.html (+ role() from app_metadata)
│   ├── complete-listing.js Logic for the no-login draft completion page
│   ├── strategy.js         In-dashboard strategy reader + the Growth (marketing) view
│   ├── data.js             Demand bands + ArzuzData + PROPERTY_TYPES (the one type list)
│   ├── admin.js            Dashboard logic: router, tables, add/edit, media, map, amenities
│   ├── arzuz-map.js        Precision mapping engine shared by every map surface:
│   │                       live-GPS pin capture (accuracy ring, best-fix memory),
│   │                       route tracing + walk recording, passage capture,
│   │                       OSRM road routing, listing route map + live tracking
│   ├── app.js              Page chrome, form engine (pin + passage steps delegate to ArzuzMap), photo upload
│   │                       (listing.html reuses the form engine for booking requests)
│   ├── submit.js           Supabase insert, offline queue, retry, post-save notifications
│   ├── notify.js           Thin client → /api/notify (Telegram lives server-side)
│   └── whatsapp.js         Post-submission WhatsApp confirmation → /api/whatsapp-send
│
└── netlify/functions/
    ├── notify.js           Owns TELEGRAM_BOT_TOKEN, formats alerts, status/detect/test
    ├── team-admin.js       Team & roles: verifies the caller is main admin, then uses
    │                       SUPABASE_SERVICE_ROLE_KEY (server-side only) against GoTrue
    ├── whatsapp-send.js    Owns OPENWA_* credentials, rate-limited proxy
    ├── cloudinary-sign.js  Signs uploads, enforces the 10 MB limit, stamps © Arzuz metadata
    ├── youtube-upload-start.js  Opens resumable upload sessions so video tours upload as
    │                       UNLISTED YouTube videos, streamed browser→Google, never via Netlify
    ├── video-embed.js      /api/video-embed/<id> 302s to the branding-stripped nocookie
    │                       embed — raw YouTube URLs stay out of the page source
    ├── listing-og.js       Serves /listing with the real listing's preview tags —
    │                       scrapers never run JS, so the per-listing card is built
    │                       server-side (see strategy/05 for the messaging it carries)
    └── strategy-docs.js    Serves the strategy pack ONLY to a valid Supabase session —
                            filename-whitelisted, no-store, /strategy/* itself 404s
```

---

## Draft apartments with invite links

Sometimes you find an apartment before you know everything about it. The dashboard's
**Listings → + Add Apartment → “Save as Draft + Invite Link”** creates the listing as
`status='draft'` with a secret `draft_token`, then shows a link:

```
arzuz.com/complete-listing?ref=<draft_token>
```

Send it to the landlord or agent on WhatsApp (the modal has a button for that). They open it,
fill in whatever is missing — details, amenities, photos, the gate pin, the passage — and tap
**Send to Arzuz**. No account, no login; the token is the key. You get a Telegram alert, and the
draft row shows *“completed — awaiting approval”*. Review it, set the tier, approve it (status
leaves `draft`), and the link dies automatically. Until then the landlord can re-open the link
and adjust.

How it is safe: anon never touches the `listings` table. Two security-definer RPCs
(`listing_draft_get` / `listing_draft_update`, created by `supabase-drafts-support.sql`) read and
write exactly one row for the token holder, and the update copies an explicit whitelist of fields
only — status, tier and the opening ask can never be changed through a link. Regenerate or revoke
the link any time from the Listings table (🔗 / rotate / revoke actions).

## Testing without touching real data

The dashboard has a built-in mock harness, guarded to localhost. Append **`?mock=1`** to the admin
URL and the page boots with a fake signed-in session and a fully stubbed Supabase/fetch layer —
nothing leaves your machine, and the sidebar badge reads **MOCK DB** so it can't be mistaken for
live. The harness seeds realistic rows into every table (drafts, minors, test rows included) and
exposes a scenario switcher on the console:

```js
__MOCK__.role('marketing')   // boot as marketing / support / admin
__MOCK__.empty()             // every table empty (honest empty states)
__MOCK__.slow(1200)          // add 1.2s latency
__MOCK__.error('rest')       // inject REST failures
__MOCK__.reset()             // restore the seed
__MOCK__.stats()
```

A headless regression suite runs the same harness through a VM-sandboxed DOM and walks all three
roles — boot, role gating, every route, overview-metric traceability, table row counts, all
modals (details/edit/delete), the delete type-to-confirm, add-apartment, CSV export, team and
amenities management, and the REST-failure scenario:

```bash
node dev/admin-boot-test.js   # expect: TOTAL 90 · PASS 90 · FAIL 0
```

See [dev/admin-test-report.md](dev/admin-test-report.md) for the full coverage matrix.

## Support Desk

The **Support Desk** section is the support team's home: tickets from the listing page's
“Report a problem” button, plus phone complaints logged with the form below the queue. Each
ticket carries status (`open → in_progress → resolved`), notes, a one-click WhatsApp button and
an **open-for timer** — anything past 48 hours is flagged red. A canned-replies panel holds
ready-to-send answers written from the site's own promises (no fees, viewing flow, safety tips).
The Overview shows open tickets alongside the draft queue.

---

## Team logins and roles

Every account is created by the main admin — public sign-ups are off, so there is no
self-service. Use **admin.html → Settings → Team** (create, role, reset password, remove); the
panel calls `netlify/functions/team-admin.js`, which holds `SUPABASE_SERVICE_ROLE_KEY` server-side
and only answers callers whose token is a main admin. Without that env var, the panel shows the
manual fallback: Supabase → Authentication → Users, then edit the Raw User JSON.

A user's role rides in the session token as `app_metadata.role`; the dashboard reads it with
`ArzuzAuth.role()`:

| Role | `app_metadata` | Lands on | Sees |
|---|---|---|---|
| Main admin (default) | *(unset)* | Overview | Everything, including Growth, Strategy, Settings — and the Team panel |
| Support | `{ "role": "support" }` | Support Desk | Tickets, bookings, demands, read-only listings. No delete buttons, no settings/growth/strategy |
| Marketing | `{ "role": "marketing" }` | Growth | Growth (traction, funnel, channels, what-to-do-next) + the Strategy docs, marketing ones first. No data tables, no settings |

To revert someone to main admin, set their role to “Main admin” in the Team panel (or remove the
`role` key in Supabase).

Role gating is presentation-level: under the current RLS every authenticated user can read the
same tables — support simply is never *shown* the sections or buttons outside its scope. For a
small team that matches the dashboard's trust model; if data-level separation is ever needed, add
a `staff` table and RLS policies keyed on it (the strategy pack itself is already enforced at the
server: `strategy-docs.js` rejects every request without a live Supabase session).

---

## Changing things

**Colours and type** — `assets/arzuz.css`, the `:root` block at the top.

**Demand numbers** — `assets/data.js`, `BANDS`. Every figure the site displays comes from there.
Set `DEMAND_IS_REAL = true` once the bands hold your own records and the wording switches to
"live" on its own.

**Amenity labels** — the built-in list is `_DEFAULT_UTILITIES` in `data.js`; anything the admin
dashboard adds lives in the `amenities` table so every browser sees it.

**Property types** — one list, `PROPERTY_TYPES` in `data.js`, used by the landlord form and both
admin modals. Change it there and every form follows.

**Maps and location** — everything lives in `assets/arzuz-map.js` (`ArzuzMap`). The pin-capture
widget writes `lat`, `lng`, `pin` and `pin_meta` (`source`, `accuracy_m`, `samples`, `captured_at`)
into the form payload; the passage editor writes `passage` (`landmark`, `gate`, `floor`, numbered
`steps`, a simplified `route`, and `route_src` of `traced`/`walk`/`osrm`). The listing page draws
the best route available: a community-traced path first, then a real road route from the free
FOSSGIS OSRM walking server (no API key, cached in localStorage), then a straight-line estimate.
`supabase-location.sql` exposes pin quality and passage presence as queryable columns — optional;
the site works without running it.

**Adding a page** — copy the head and script tags from an existing page, call
`Arzuz.chrome('student' | 'owner' | null)` at the top and `Arzuz.footer()` at the bottom. Form
pages that use `UTILITIES` start inside `ArzuzData.ready.then(...)`.

**Adding a form flow** — `Arzuz.form({steps, done, backHref, backLabel, table})`. Step types:

| Key | Renders |
|---|---|
| `o: [...]` | Tappable single-choice options, auto-advances |
| `c: [...]` | Multi-select chips |
| `f: [[id, label, type]]` | Text fields. Types: `text`, `tel`, `number`, `sel`, `pin`, `passage`, `rent-live`, `photo` |
| `ta: "placeholder"` | Textarea |
| `opt: true` | Button reads "Skip" instead of "Continue" |
| `ctx: true` | Shows the live demand context box above the question |
| `onlyIf: fn` | Step appears only when the function returns true |

---

## How a submission travels

`form finish → ArzuzSubmit.send → POST /rest/v1/<table>` with a `client_ref` UUID
→ **on success only**: Telegram alert via `/api/notify`, WhatsApp confirmation via
`/api/whatsapp-send` → on failure the row is queued in localStorage and flushed when the browser
comes back online. `client_ref` is unique in the database, so a retry can never write twice.

---

## Two rules that are not style preferences

**Every number shown must trace to a real record.** The demand counts, the enquiry counts, the
FAQ rent ranges. If a count is zero, say so — never round it up. A landlord who lists at your
price and finds nobody waiting will tell every other landlord in Malete within a week.

**Verifier assignment must be enforced in the database.** A caretaker can never be assigned a
compound they run, and assignment must be random. This is currently only stated in copy. When it
becomes real it needs to be a constraint between verifier and property, not an ops guideline.
Everything else in this system can be policy. That one cannot.

---

## Before this becomes the live site

- [x] `supabase-hardening.sql` (or `supabase-schema.sql` on a new project) run, and anon can no
      longer read rows — verified 3 Oct 2026: anon SELECT on the three tables returns 401
- [x] Supabase Auth admin user created, public sign-ups turned off, dashboard signed in
      (sign-up endpoint verified returning 422)
- [x] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set in Netlify; test alert received
- [x] Cloudinary API secret rotated (it once sat in a code comment) and the new value in Netlify
- [x] Self-host the two fonts, or drop to system fonts on the product pages (Bricolage Grotesque +
  Instrument Sans woff2 subsets now served from `assets/fonts/`, `font-display: swap`)
- [ ] Outline the `az` mark to SVG so the logo does not depend on a webfont loading on 3G
- [ ] Test on a sub-₦30,000 Android on real 3G
- [ ] Confirm the KWASU session start date and work the launch calendar backwards from it

---

Arzuz — open to students everywhere, starting in Malete, Kwara State. Pronounced AR-zuz.
