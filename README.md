# Arzuz — the site

A static, multi-page site with no build step, no framework and no dependencies in the browser.
Every page is plain HTML sharing six scripts in `assets/`, plus two Netlify Functions and a
Supabase database.

**Live and real** — the homepage and three forms write to Supabase. There is deliberately no
browse, listing or dashboard surface for students: until there is real inventory, a student who
registers must not be able to wander into invented data.

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

---

## Structure

```
arzuz-site/
├── index.html              Landing — hero, demand curve, problem, how it works, SEO FAQ
├── register.html           Student: demand register          → demand_records
├── owner-list.html         Landlord: list a property         → listings
├── scout.html              Resident: register my building    → scout_submissions
├── safety.html             Your safety on Arzuz
├── privacy.html            Privacy policy
├── terms.html              Terms of use
├── admin.html              Private dashboard (Supabase Auth sign-in)
│
├── supabase-schema.sql     Fresh install: tables, RLS, grants, views
├── supabase-hardening.sql  Upgrades an existing database — run this one if you already have data
│
├── assets/
│   ├── arzuz.css           Design system — all colours, type, components
│   ├── config.js           Public config only (Supabase anon key, session, support number)
│   ├── auth.js             Supabase Auth session for admin.html
│   ├── data.js             Demand bands + ArzuzData (loads shared amenities)
│   ├── app.js              Page chrome, form engine, Leaflet pin capture, photo upload
│   ├── submit.js           Supabase insert, offline queue, retry, post-save notifications
│   ├── notify.js           Thin client → /api/notify (Telegram lives server-side)
│   └── whatsapp.js         Post-submission WhatsApp confirmation → /api/whatsapp-send
│
└── netlify/functions/
    ├── notify.js           Owns TELEGRAM_BOT_TOKEN, formats alerts, status/detect/test
    ├── whatsapp-send.js    Owns OPENWA_* credentials, rate-limited proxy
    └── cloudinary-sign.js  Signs uploads, enforces the 10 MB limit
```

---

## Changing things

**Colours and type** — `assets/arzuz.css`, the `:root` block at the top.

**Demand numbers** — `assets/data.js`, `BANDS`. Every figure the site displays comes from there.
Set `DEMAND_IS_REAL = true` once the bands hold your own records and the wording switches to
"live" on its own.

**Amenity labels** — the built-in list is `_DEFAULT_UTILITIES` in `data.js`; anything the admin
dashboard adds lives in the `amenities` table so every browser sees it.

**Adding a page** — copy the head and script tags from an existing page, call
`Arzuz.chrome('student' | 'owner' | null)` at the top and `Arzuz.footer()` at the bottom. Form
pages that use `UTILITIES` start inside `ArzuzData.ready.then(...)`.

**Adding a form flow** — `Arzuz.form({steps, done, backHref, backLabel, table})`. Step types:

| Key | Renders |
|---|---|
| `o: [...]` | Tappable single-choice options, auto-advances |
| `c: [...]` | Multi-select chips |
| `f: [[id, label, type]]` | Text fields. Types: `text`, `tel`, `number`, `sel`, `pin`, `rent-live`, `photo` |
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

- [ ] `supabase-hardening.sql` (or `supabase-schema.sql` on a new project) run, and anon can no
      longer read rows — the checks are commented at the bottom of either file
- [ ] Supabase Auth admin user created, public sign-ups turned off, dashboard signed in
- [ ] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set in Netlify; test alert received
- [ ] Cloudinary API secret rotated (it once sat in a code comment) and the new value in Netlify
- [ ] Self-host the two fonts, or drop to system fonts on the product pages
- [ ] Outline the `az` mark to SVG so the logo does not depend on a webfont loading on 3G
- [ ] Test on a sub-₦30,000 Android on real 3G
- [ ] Confirm the KWASU session start date and work the launch calendar backwards from it

---

Arzuz — Malete, Kwara State. Pronounced AR-zuz.
