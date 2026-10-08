# 07 · Growth model — LTV:CAC, funnel, churn

**What it answers:** does the model survive scale, and where do users fall out? Nothing here
is quoteable until it holds real numbers — placeholders are marked **[ESTIMATE]**.

> **Numbers rule:** counts come from the database, not from memory:
> `demand_records`, `listings`, `booking_requests`, and the `roommate_match_summary`
> view (the 14-day matching metric on the dashboard) are the sources.

---

## The revenue model (what LTV is built from)

1. **Listing tiers** — free basic listing; paid premium placement (tier structure already
   exists in `listings.tier`).
2. **Arzuz Care** — optional repair service ([care.html](../care.html)); attach to occupied
   rooms at session start. This is the renewal-season product.
3. **Booking success is the product for landlords** — free until it fills rooms; premium
   tiers sell *results*, not exposure.

## LTV skeleton

```
Avg revenue per verified landlord per session
  = P(premium tier) × premium price            [ESTIMATE — set when pricing ships]
  + P(Care attach) × Care margin               [ESTIMATE]
LTV (session-based business)
  = revenue per session × P(re-lists next session)
CAC (landlord side)
  = direct walk-in cost + ambassador referral cost / signed landlords
CAC (student side) — near-zero by design; WhatsApp loops are the channel
Healthy target: LTV ≥ 3 × CAC.  Bootstrap reality: CAC ≈ shoe leather, so
the ratio is trivially healthy — the REAL constraint is verifier capacity,
not CAC. Say this out loud to investors; "CAC is fine" is not the story,
"supply verification throughput" is.
```

## Funnel — where users can fall out

| Step | Event | Lives in | Drop-off to watch |
|---|---|---|---|
| 1. See | Preview card / flyer / ambassador link | OG cards + `/register?ref=` | Card click-through. **Live**: `assets/attribution.js` captures the tag → `payload.ref`, and the Growth view counts registrations per channel. Impressions themselves are still unmeasured — say so rather than implying otherwise |
| 2. Register | demand_records row | [register.html](../register.html) → `demand_records` | Form abandonment (steps are tappable — keep them few) |
| 3. Get matched | Match made to a verified listing | Dashboard flow | Time-to-first-match; the metric that decides urgency |
| 4. Book | booking_requests row | [listing.html](../listing.html) → `booking_requests` | Landlord response time (gap from doc 02) |
| 5. Move in | Room filled | offline | The moment the platform proves itself |
| 6. Stay | Care attach / roommate match | [care.html](../care.html), `roommate_match_summary` | 14-day match rate — the retention metric |

## Churn & retention

- Student "churn" is structural: one booking per session. Retention = **re-listing by
  landlords** next session + **Care renewal**. Track both per session.
- The dashboard's **14-day roommate-match metric** is the one true in-session retention
  signal — keep it on the front page of the admin dashboard, not buried.
- High mid-session drop-off (rooms re-listed, Care cancelled) would signal a verification
  quality problem, not a marketing problem — same rule as the README's churn doctrine.

## Where this lands on the site

- [register.html](../register.html) funnel step 2; per-`?ref=` attribution makes channels
  measurable (doc 06).
- [listing.html](../listing.html) booking form is step 4 — its completion rate is the
  single most important number on the site.
- Admin dashboard: funnel counts + 14-day match metric → this file is the definition of
  every metric shown there.

## Next 3 actions

1. **Done** — the funnel counts (steps 1→6) card is on the Overview, and the Growth view draws
   the same steps from the same definition (`ArzuzStrategy.funnelCard`), so the two can never
   disagree.
2. **Done** — `?ref=` is instrumented: `assets/attribution.js` → `payload.ref`, counted per
   channel in the Growth view. The remaining gap is impressions, i.e. step 1's denominator.
3. Set premium-tier pricing, then fill the **[ESTIMATE]** slots above with real arithmetic.
