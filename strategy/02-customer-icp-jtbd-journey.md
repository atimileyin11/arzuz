# 02 · Customer & audience — ICP, Jobs-to-be-Done, journey map

**What it answers:** who exactly we build and market for, what job they hire Arzuz to do,
and every touchpoint from first hearing about us to telling a friend. If a marketing
message or a page feature doesn't serve a row on this page, question it.

---

## Three customers, one platform

Arzuz has a demand side, a supply side, and a trust side. Each needs its own ICP.

### Persona 1 — The student (demand side)

- **Who:** KWASU undergrad/postgrad (Malete first), 18–27, renting off-campus for the first
  or second time. Budget per session concentrates in the ₦100k–₦200k bands (see BANDS in
  [`assets/data.js`](../assets/data.js)).
- **Pain:** prices are whatever an agent says they are; photos lie; water/power are
  discovered after paying; the "inspection fee" scam.
- **Buying power:** low individually, but the decision is fast, seasonal, and social —
  decisions cluster around registration week and spread by WhatsApp.
- **Goal:** pay a fair, known price for a room that is what it claimed, near campus.

**JTBD statement:** *When I'm preparing for the new session, I want to know what rooms
actually cost and what they're actually like, so I can pay rent without being scammed or
overcharged.*

### Persona 2 — The landlord / caretaker (supply side)

- **Who:** owns 1–20 rooms in Malete; often not resident; rents through agents or WhatsApp
  groups today.
- **Pain:** vacancy is expensive; agents take a cut and bring tyre-kickers; no way to
  advertise beyond word of mouth.
- **Buying power:** moderate; pays for *filling rooms*, not for listings.
- **Goal:** fill rooms quickly at full price without an agent in the middle.

**JTBD statement:** *When my rooms are empty at session start, I want serious students to
find and book them directly, so I stop paying agents for tenants who never show up.*

### Persona 3 — The resident scout (trust side)

- **Who:** a student already living in a building — the "community verified" tier.
- **Pain:** none we solve for them directly; this is a contribution role.
- **Motivation:** status, helping coursemates, and (future) small incentives.

**JTBD statement:** *When I see friends getting scammed, I want to share what rent and
utilities in my building are really like, so the next person doesn't get burned.*

## Journey map — student side

| Stage | What happens | Where it lives today | Gap to close |
|---|---|---|---|
| Awareness | WhatsApp share, friend link, flyer, search | Link preview cards ([listing-og](../netlify/functions/listing-og.js)) are the billboard — the card IS the first impression | Share prompts inside the product (not built yet) |
| Consideration | Browses verified rooms, compares real prices | [`browse.html`](../browse.html) — public_listings view only | Inventory: cards are only as good as verified supply |
| Conversion | Books / sends booking request | [`listing.html`](../listing.html) booking form → `booking_requests` | Response-time promise per landlord |
| Onboarding | WhatsApp confirmation of the request | `/api/whatsapp-send` flow | — works today |
| Retention | Roommate matching, Arzuz Care | 14-day roommate-match metric on the dashboard; [`care.html`](../care.html) | Care is the natural renewal-season product |
| Advocacy | Student shares a listing link; scout registers a building | [`scout.html`](../scout.html) | Make the shareable moment explicit after booking |

## Where this lands on the site

- Persona 1 language is already the homepage copy ("real prices, no agent fees") — do not
  fork a second messaging doc; this file is the source.
- Persona 2 language is [`owner-list.html`](../owner-list.html) and the `/list` landing.
- Journey gaps above are the backlog; do not build a feature that has no row here.

## Next 3 actions

1. Interview 5 students in the demand register (phone numbers are in the records) and
   replace the two **[ESTIMATE]** assumptions above with quotes.
2. Add per-landlord response time to booking requests — the conversion table's gap.
3. Add a WhatsApp share prompt on the booking-confirmation screen (advocacy row).
