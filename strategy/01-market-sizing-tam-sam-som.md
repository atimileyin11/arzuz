# 01 · Market sizing — TAM / SAM / SOM

**What it answers:** is Arzuz big enough to matter to investors, and small enough at the
start to actually win? Run bottom-up, never top-down: "1% of a huge number" is not a plan.

> **Numbers rule (from the site README):** every figure below must trace to a real record.
> Placeholders are marked **[ESTIMATE]** until replaced. A landlord who checks our maths and
> finds it wrong will tell every other landlord in Malete within a week.

---

## Definitions, applied to Arzuz

| Layer | Question | Arzuz's version |
|---|---|---|
| **TAM** | Total demand if everyone, everywhere | All Nigerian students renting off-campus housing, nationwide |
| **SAM** | The slice our model can serve today | Off-campus students in cities Arzuz actually operates in (Malete / KWASU now), renting rooms, self-contains and hostels |
| **SOM** | What we can realistically capture in the near term | Rooms we can verify + fill in Malete in 12 months |

## The bottom-up ladder

Fill each rung with a source and date. A rung without a source is a guess, not a number.

1. **KWASU student population** — **[ESTIMATE]**, replace with the registrar / NUC figure. ×
2. **% living off-campus** — **[ESTIMATE]**; most Nigerian universities house well under half
   of students on campus. ×
3. **= SAM, student count** (e.g. 20,000 × 65% ≈ 13,000 off-campus students). ×
4. **Average annual rent per student** — anchor to the demand bands in
   [`assets/data.js`](../assets/data.js): the BANDS distribution (median currently sits in
   the ₦100k–₦150k band, 44 of 143 respondents). ×
5. **= SAM, naira** (rent pool). ×
6. **Take rate × realistic share** — listing tiers, Arzuz Care attach, and
   **[ESTIMATE]** rooms actually filled in year one (capped by *verifier capacity*, not by
   demand). **= SOM.**

## Sanity checks before quoting any of it

- Cross the top-down number (Nigeria has ~2M+ students; off-campus housing spend is a
  multi-trillion-naira pool) against the bottom-up number. If they differ by 100×, the
  bottom-up wins every time in a room — and in a deck.
- SOM must be bounded by **verified supply**, not demand: the demand register already
  outpaces verified rooms (see `demand_records` vs `public_listings` counts). State that
  asymmetry — it is the strongest slide we have: *demand is proven first, supply is the
  constraint, verification is the moat.*
- State the session clock: demand is seasonal (KWASU 2026/2027 session). A 12-month SOM is
  really a 10-week window around registration.

## Where this lands on the site

- Homepage demand curve + FAQ rent ranges → [`assets/data.js`](../assets/data.js) BANDS, the
  single source of truth. Updating the doc means updating BANDS, never hard-coding.
- Investor one-pager (when written) → this file is its appendix.
- `DEMAND_IS_REAL` in [`assets/data.js`](../assets/data.js) flips all public wording from
  "illustrative" to "live" — flip it only when BANDS holds real records.

## Next 3 actions

1. Replace the two **[ESTIMATE]** rungs (KWASU population, % off-campus) with sourced figures.
2. Pull real counts: `select count(*) from demand_records;` and the `demand_summary` view →
   recompute the ladder with the real median band.
3. Write the one-paragraph SOM statement (rooms × rent × take rate, 12 months) and pin it at
   the top of this file.
