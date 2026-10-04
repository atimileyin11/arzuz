# Arzuz — Strategy pack

One file per framework. Each ends with **"Where this lands on the site"** (the exact page
or file its conclusions apply to) and **"Next 3 actions"** (the smallest concrete next
step). Nothing here is decorative: if a conclusion has no landing point, it doesn't ship.

## The frameworks

| # | File | Answers | Applies to |
|---|---|---|---|
| 01 | [Market sizing — TAM/SAM/SOM](01-market-sizing-tam-sam-som.md) | Is the market big enough — and is our slice winnable? | Homepage demand curve, BANDS in [assets/data.js](../assets/data.js), future investor one-pager |
| 02 | [Customer — ICP, JTBD, journey](02-customer-icp-jtbd-journey.md) | Who we build for, what job we're hired for, which touchpoint is broken | All page copy, [register.html](../register.html), [scout.html](../scout.html), share prompts |
| 03 | [Competition & Five Forces](03-competition-porters-five-forces.md) | Where the power sits and which rival actually matters | "Zero agent fees" headline, [safety.html](../safety.html), [owner-list.html](../owner-list.html) |
| 04 | [PESTEL](04-pesteL.md) | Which outside forces (inflation, NDPA, 3G reality) can hurt us and the mitigation | Session-stamped pricing in [assets/config.js](../assets/config.js), [privacy.html](../privacy.html), [care.html](../care.html) |
| 05 | [Positioning — STP](05-positioning-stp.md) | Which segment first, and the sentence that wins it | Homepage hero, meta titles, OG card copy, WhatsApp broadcast wording |
| 06 | [Channels — Bullseye](06-channels-bullseye.md) | Where the next 100 students and 10 buildings come from, tested cheaply | [register.html](../register.html) `?ref=` attribution, share prompts, ambassador program |
| 07 | [Unit economics — LTV:CAC, funnel, churn](07-unit-economics-ltv-cac.md) | Does it survive scale; where users fall out | Funnel metrics card in the admin dashboard, [listing.html](../listing.html) booking completion, 14-day match metric |

## Recommended execution order

1. **Positioning first** (05) — every other artifact inherits its words. Meta titles and
   OG cards already carry the five pillars.
2. **One channel, measured** (06) — WhatsApp share loops + ambassador test + flyer QR. No
   paid spend until these three have numbers.
3. **Unit economics proof** (07) — funnel counts and `?ref=` attribution make the model
   real; set premium pricing only when the funnel shows conversion.
4. **Market sizing for outsiders** (01) — bottom-up, with the verifier-capacity story.
5. **Keep the scans warm** (03, 04) — field notes and session calendar, not essays.

## Working rules

- **No number without a real record.** Placeholders are marked **[ESTIMATE]** and get
  replaced, never quietly rounded up. (Same rule as the main [README](../README.md).)
- **Every doc links its landing points** — if the site changes, the doc row changes with it.
- **Update cadence:** 01 and 04 re-run every session (registration window); 03 gets dated
  field notes; 06–07 get real numbers as the first tests land.
