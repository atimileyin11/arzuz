# Arzuz — demo site

A static, multi-page prototype of the Arzuz product. No build step, no server, no dependencies.
Every page is plain HTML with three shared assets.

**This is a prototype running on sample data.** A red banner says so on every page. Do not remove
it until the data is real — a screenshot circulating as real traction would cost more than the
demo is worth.

---

## Run it

**Locally**

```bash
cd arzuz-demo
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

To test on your phone on the same wifi, find your computer's local IP (`ipconfig getifaddr en0`
on macOS, `hostname -I` on Linux) and open `http://<that-ip>:8000` on the phone. Test on a real
Android device on real mobile data before you show anyone.

**Deploy**

Drag the whole folder onto [netlify.com/drop](https://app.netlify.com/drop) or run `vercel` in it.
Both are free and give you a shareable URL in under a minute. It is pure static hosting, so
GitHub Pages or Cloudflare Pages work identically.

---

## Structure

```
arzuz-demo/
├── index.html              Landing — two doors, problem, how it works
├── pages.html              Index of every screen (for testing)
│
├── browse.html             Student: listings with filters
├── listing.html?id=N       Student: property detail — REAL SHAREABLE URL
├── register.html           Student: demand register
├── benchmark.html          Student: what housing costs in Malete
├── care.html               Student: Arzuz Care, covered and not covered
├── repair.html             Student: request a repair
├── scout.html              Student: register the building I live in
├── review.html?id=N        Student: write a review
├── visit.html?id=N         Student: before you visit
├── outcome.html?id=N       Student: visit follow-up
├── wrong.html              Student: claim against the inspection promise
│
├── owner.html              Owner: demand report + price slider
├── owner-claim.html        Owner: claim property → the reveal
├── owner-list.html         Owner: list a property
├── owner-dashboard.html    Owner: enquiries, reply speed, caretaker
│
├── caretaker.html          Caretaker: public record
├── caretaker-jobs.html     Caretaker: open Care jobs
├── caretaker-verify.html   Caretaker: verification assignment
├── caretaker-record.html   Caretaker: accuracy record
│
└── assets/
    ├── arzuz.css           Design system — all colours, type, components
    ├── data.js             ALL sample data
    └── app.js              Chrome, helpers, multi-step form engine
```

---

## Changing things

**Colours and type** — `assets/arzuz.css`, the `:root` block at the top. Change a token there and
it changes everywhere.

**Listings, prices, demand numbers** — `assets/data.js`. Every figure the site displays comes from
this one file. Nothing is hardcoded in a page.

**Adding a page** — copy the head and script tags from any existing page, call
`Arzuz.chrome('student' | 'owner' | 'caretaker' | null)` at the top and `Arzuz.footer()` at the
bottom.

**Adding a form flow** — call `Arzuz.form({steps, done, backHref, backLabel})`. Step types:

| Key | Renders |
|---|---|
| `o: [...]` | Tappable single-choice options, auto-advances |
| `c: [...]` | Multi-select chips |
| `f: [[id, label, type]]` | Text fields. Types: `text`, `tel`, `number`, `sel`, `pin`, `rent-live` |
| `ta: "placeholder"` | Textarea |
| `opt: true` | Button reads "Skip" instead of "Continue" |
| `ctx: true` | Shows the live demand context box above the question |

---

## Wiring it to a backend

Form answers land in `Arzuz.form`'s `finish()` in `assets/app.js`. Right now it logs to console.
Replace with POSTs:

| Flow | Endpoint |
|---|---|
| `register.html` | `POST /api/demand-records` |
| `owner-list.html` | `POST /api/listings` (status: pending) |
| `scout.html` | `POST /api/scout-submissions` |
| `outcome.html` | `POST /api/visit-outcomes` |
| `caretaker-verify.html` | `POST /api/verifications` |
| `repair.html` | `POST /api/care-jobs` |

---

## Two rules that are not style preferences

**Every number shown must trace to a real record.** The demand counts, the enquiry counts, the
benchmark medians. If a count is zero, say so — never round it up. A landlord who lists at your
price and finds nobody waiting will tell every other landlord in Malete within a week.

**Verifier assignment must be enforced in the database.** A caretaker can never be assigned a
compound they run, and assignment must be random. This is currently only stated in copy. When it
becomes real it needs to be a constraint between verifier and property, not an ops guideline.
Everything else in this system can be policy. That one cannot.

---

## Before this becomes the live site

- [ ] Remove the demo banner from `Arzuz.chrome()` in `app.js`
- [ ] Replace `data.js` with real API calls
- [ ] Outline the `az` mark to SVG so the logo does not depend on a webfont loading on 3G
- [ ] Self-host the two fonts, or drop to system fonts on the product pages
- [ ] Write privacy policy, terms, and review policy pages
- [ ] Add real team details
- [ ] Test on a sub-₦30,000 Android on real 3G
- [ ] Confirm the KWASU session start date and work the launch calendar backwards from it

---

Arzuz — Malete, Kwara State. Pronounced AR-zuz.
