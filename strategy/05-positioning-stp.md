# 05 · Positioning — Segmentation, Targeting, Positioning

**What it answers:** which segments we serve, which we serve *first*, and the sentence that
makes Arzuz the obvious choice against every alternative from doc 03.

---

## Segmentation

| Segment | Description | Size signal | Willingness to pay | Priority |
|---|---|---|---|---|
| **Fresher seeking off-campus** | First time renting; highest anxiety, highest scam exposure; parent-influenced | Largest yearly cohort; demand-register joins peak at registration | Low individually; parent wallet behind them | **P1 — beachhead** |
| **Returning student relocating** | Knows prices, wants better water/power or lower rent | Steady trickle all session | Medium | **P2** |
| **Finalist / postgrad** | Wants self-contain, quieter, will pay for certainty | Smaller band, higher budgets (₦300k+ bands in BANDS) | **High** | **P2** |
| **Parents paying remotely** | Not on campus; cannot inspect; needs a trusted proxy | Underserved by everyone | **High** (for verification, not rooms) | **P3 — emerging** |
| **Small landlords (1–20 rooms)** | Supply side; want rooms filled, hate agent cuts | Malete has hundreds of buildings | Medium; free listing + paid Care | **P1 enabler** |

## Targeting

**Beachhead:** freshers + the landlords whose rooms they need, in **Malete only**, for the
**2026/2027 session**. One city, one session, one metric: verified rooms filled. The parent
segment is served *implicitly* by the same trust artifacts (safety page, verified photos,
real prices) — not with a separate product yet.

## Positioning statement

> For Nigerian students renting off-campus, **Arzuz** is the verified housing platform that
> shows real prices and inspected rooms *before you pay* — unlike agents and WhatsApp
> groups, where every listing is a guess and every inspection is a scam risk.

## Messaging pillars (already on the site — keep them consistent everywhere)

1. **Real prices, published** — "₦X per session" on every card, from BANDS and listings,
   never "Call for price".
2. **Zero agent fees** — the direct attack on the default alternative.
3. **Verified before listed** — community-verified and inspected tiers on
   [`safety.html`](../safety.html).
4. **Measured walk to campus** — walking-time, not "close to KWASU" vagueness.
5. **Built for the device reality** — fast pages on cheap Androids over 3G (the README's
   launch checklist item).

Anti-pillar (what we never say): "luxury", "premium lifestyle", anything that smells like
the portals. We say *honest*, *verified*, *walkable*.

## Where this lands on the site

- Homepage hero + meta titles → pillars 1–3; the OG card copy mirrors these words.
- [`owner-list.html`](../owner-list.html) → the landlord-side mirror: "students already
  waiting, zero agent fees."
- Link preview cards ([listing-og](../netlify/functions/listing-og.js)) → pillar 1 and 3 in
  one line: "₦250,000 per session · Verified · zero agent fees."

## Next 3 actions

1. Audit every page title/description against the five pillars (done this session for OG
   tags — keep future copy edits consistent with them).
2. Write the 3 message variants for the WhatsApp broadcast (short / long / parent-angle)
   from the positioning statement.
3. Test the parent-angle variant on the P3 segment: one flyer in the chapel/mosque/faculty
   parents' groups with the safety-page link.
