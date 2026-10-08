# 06 · Marketing channels — Bullseye

**What it answers:** where the next 100 verified students (and the next 10 verified
buildings) come from, tested cheaply before committing. The bullseye method: brainstorm
wide → rank by ICE → test the centre → only then scale.

---

## The candidate channels (ranked ICE: Impact / Confidence / Ease, 1–10 each)

| Channel | Idea | I | C | E | ICE | First test |
|---|---|---|---|---|---|---|
| **Campus student ambassadors** | 3–5 paid-per-signup students in Malete share verified listings in their faculty groups | 9 | 7 | 6 | **7.3** | One ambassador, one week, target 50 demand-registers |
| **WhatsApp share loops** | Every listing page becomes a shareable card; booking confirmation prompts "send to a coursemate" | 9 | 8 | 7 | **8.0** | **Shipped** — the share prompt is on the booking and registration confirmations, and every share carries a `?ref=` tag; measure tagged registrations per channel |
| **Scout referrals** | Resident scouts recruit the next building (they live next door to it) | 8 | 7 | 6 | **7.0** | Ask every scout for one neighbouring building at submission |
| **Flyers at registration points** | QR → /register during the 2-week registration crush | 7 | 6 | 8 | **7.0** | 200 flyers at faculty gates week one; QR scans tracked |
| **SEO (session-stamped queries)** | "KWASU hostel prices 2026/2027" — buy-intent, low competition, compounds yearly | 8 | 6 | 4 | **6.0** | Already started: homepage FAQ + sitemap; add per-session price pages later |
| **Landlord direct walk-in** | Physically sign up buildings in Malete before the session | 8 | 7 | 3 | **6.0** | 10 buildings/week target, paper form if needed |
| **Student-union / chapel-mosque announcements** | Free reach at the trust layer | 6 | 5 | 5 | **5.3** | Ask for one announcement slot at registration |
| **Paid social ads** | Instagram/TikTok reels of real rooms | 5 | 4 | 4 | **4.3** | Not yet — only after organic loops are measured |
| **Telegram campus groups** | Same loop as WhatsApp, smaller in this market | 4 | 4 | 6 | **4.7** | Revisit if a group >500 users appears |

## The bullseye (this session)

1. **WhatsApp share loops** — highest ICE, zero cash, rides the existing preview-card work.
2. **Campus ambassadors** — one paid test before scaling to five.
3. **Flyers at registration** — timed, trackable, dead cheap.

Everything else is in the outer rings. Do not spend real money on any channel before the
three centre channels have measured numbers.

## Where this lands on the site

- Channel 1 needs the share prompt on booking confirmation + the preview cards (already
  live via [`netlify/functions/listing-og.js`](../netlify/functions/listing-og.js)).
- Channel 2's ambassador funnel lands on [`register.html`](../register.html) — UTM or a
  per-ambassador `?ref=` on the demand form is how the test gets measured.
- Channel 3's QR lands on [`register.html`](../register.html) too — one landing surface
  keeps attribution honest.

## Next 3 actions

1. Ship the booking-confirmation share prompt (closes doc 02's advocacy gap and powers
   channel 1).
2. Define the ambassador unit economics *before* recruiting: payout per verified demand
   record, cap, and the metric that decides "scale or stop" after week one.
3. Order flyers with a QR code that points to `/register?ref=flyer-w1` so scans are
   attributable in `demand_records`.
