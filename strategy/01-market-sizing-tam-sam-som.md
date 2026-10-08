# 01 · Market sizing — TAM / SAM / SOM

**What it answers:** is Arzuz big enough to matter to investors, and small enough at the
start to actually win? Run bottom-up, never top-down: "1% of a huge number" is not a plan.

> **Numbers rule (from the site README):** every figure below must trace to a real record.
> Cited figures carry a source marker in the form **[S3]** and are listed in *Sources* at the
> bottom. Figures that are still judgement calls are marked **[ESTIMATE]** (a number somebody
> must go and get) or **[ASSUMPTION]** (a planning choice, with the range it was chosen from).
> A landlord who checks our maths and finds it wrong will tell every other landlord in Malete
> within a week.

---

## Definitions, applied to Arzuz

| Layer | Question | Arzuz's version |
|---|---|---|
| **TAM** | Total demand if everyone, everywhere | All Nigerian students renting off-campus housing, nationwide |
| **SAM** | The slice our model can serve today | Off-campus students in cities Arzuz actually operates in (Malete / KWASU now), renting rooms, self-contains and hostels |
| **SOM** | What we can realistically capture in the near term | Rooms we can verify + fill in Malete in 12 months |

## The bottom-up ladder

Every rung now carries a source or an explicit assumption. Sources are at the bottom of the
file; the marker next to each figure says which.

1. **KWASU student population — 30,000 [S1].**
   The university's own site says "over 30,000 students" [S1]. Two other published figures
   disagree with each other and with it: 25,639 (COPSUN's profile) [S4] and "over 40,000"
   (Wikipedia) [S3]. For a plan, take the **verifiable floor of the university's own claim**:
   30,000. The 2024/2025 intake was 13,602 new students in one matriculation [S2] — which is
   why any single "total" is stale within a session.

2. **% living off campus — 70% [ASSUMPTION].**
   The most defensible published figure is a Nigerian vice-chancellor's: only **7% of students
   live on campus** against a global standard of 40% [S5], i.e. ~93% off campus. KWASU is
   actively adding beds (a 600-bedspace block commissioned in October 2025 [S6]), which argues
   for planning *below* the national figure rather than at it. **Planning band: 70%–93%;
   70% used below** so the SOM is not built on the optimistic end.

3. **= SAM, student count → 21,000 off-campus students** (30,000 × 70%).
   At the top of the band (93%) it is 27,900. Treat 21,000 as the number to quote.

4. **Average per-session rent — ₦300,000 off campus [ASSUMPTION], observed band
   ₦230,000–₦500,000 [S8].**
   Two independent market reads agree on the shape: student-hostel reviews report agreed
   rates of about **₦230,000–₦500,000** depending on hostel and room type [S8], and live
   Malete agent listings for the 2025/2026 session quote **₦350,000** at Westend (plus a
   ₦20,000 agency markup) and **₦470,000** at Westerned [S9]. Outside campus generally,
   private hostels run to **₦500,000 for a self-contained room** [S10].
   On-campus is a different market and is still not cheap: the new university hostels are
   reported at roughly **₦350,000 per bed space per session** against about **₦150,000** in
   the older blocks [S7]. ₦300,000 is the conservative midpoint of the off-campus band.

5. **= SAM, naira → ₦6.3bn per session** (21,000 × ₦300,000).
   At the edges of the assumption band: **₦4.8bn** (21,000 × ₦230,000) to **₦10.5bn**
   (21,000 × ₦500,000). This is the rent students in Malete pay *to landlords* — not
   Arzuz's revenue, and never to be quoted as such.

6. **Take rate × realistic share = SOM [ESTIMATE].**
   Arzuz does not collect rent, so the rent pool above is the *size of the problem*, and the
   revenue is listing tiers + Arzuz Care attach. The one rung that can be bounded **today** is
   supply: it is capped by how many buildings one person can walk and verify, not by demand —
   at a realistic 8 verified rooms a week through the 10-week registration window, that is
   ~80 rooms. Write the revenue rung once the tier price exists.

The arithmetic to fill in (kept out of the list above so it renders as code, not prose):

```
SOM (session 2026/2027)
  = rooms verified AND filled in 12 months     [ESTIMATE — verifier capacity]
  × average rent of those rooms                NGN 300,000  [S8, S9]
  × blended take rate (tier + Care attach)     [ESTIMATE — set when pricing ships]
```

## Sanity checks before quoting any of it

- **The affordability gap is the story, and the illustrative data hides it.** The homepage's
  demand curve (`assets/data.js` BANDS) peaks at a **₦100,000–₦150,000** budget while every
  observed Malete asking rent in this file sits at **₦230,000–₦500,000**. Those two numbers
  cannot both be right about the same students — and BANDS is still illustrative
  (`DEMAND_IS_REAL = false`). **Before this doc is quoted anywhere, replace BANDS with real
  `demand_summary` counts.** If the gap survives real data, it is the single strongest
  argument for the verification model: students are not short of rooms, they are priced out
  of the rooms that exist.
- Cross the top-down number (Nigeria has ~2M+ students in off-campus housing [S11]) against
  the bottom-up number. If they differ by 100×, the bottom-up wins every time in a room — and
  in a deck.
- SOM must be bounded by **verified supply**, not demand: the demand register already
  outpaces verified rooms (see `demand_records` vs `public_listings` counts). State that
  asymmetry — it is the strongest slide we have: *demand is proven first, supply is the
  constraint, verification is the moat.*
- State the session clock: demand is seasonal (KWASU 2026/2027 session). A 12-month SOM is
  really a 10-week window around registration.

## Sources

| # | Figure used | Source | Date |
|---|---|---|---|
| S1 | "over 30,000 students" | Kwara State University — *About KWASU*, kwasu.edu.ng/about-kwasu | Nov 2025 |
| S2 | 13,602 new students admitted | KWASU — *16th Matriculation Ceremony*, kwasu.edu.ng | Jan 2025 |
| S3 | "over 40,000 students" (treated as unreliable) | Wikipedia — *Kwara State University* | accessed 2026 |
| S4 | 25,639 total enrolment | COPSUN university profile, copsun.org | accessed 2026 |
| S5 | only 7% of students live on campus | University World News — *Students feel economic crunch as they seek affordable housing* | Dec 2024 |
| S6 | new 600-bedspace hostel commissioned | KWASU — *VC Commissions New 600 Bedspace Hostel*, kwasu.edu.ng | Nov 2025 |
| S7 | new hostels ≈₦350,000/bed space, older ≈₦150,000 | reported university hostel pricing, Legit.ng / KWASU press coverage | 2025 |
| S8 | agreed rates ₦230,000–₦500,000 | *Best Boys & Girls Hostels in KWASU*, schooladmissions.com.ng | Sep 2026 |
| S9 | Westend ₦350,000 + ₦20,000 agency; Westerned ₦470,000 | live Malete agent listings for 2025/2026 | 2026 |
| S10 | up to ₦500,000 for a self-contained room off campus | The Guardian (Nigeria) — *How accommodation crisis in higher institutions diminishes rise in students admission* | Oct 2025 |
| S11 | ~2M+ students in off-campus housing (indicative) | industry commentary on Nigeria's student housing market — **not an audited figure** | 2026 |

> **Rule for this table:** a figure that cannot be sourced does not go in the ladder. S11 is
> listed *because* it is indicative only, so nobody later cites it as if it were measured.

## Where this lands on the site

- Homepage demand curve + FAQ rent ranges → [`assets/data.js`](../assets/data.js) BANDS, the
  single source of truth. Updating the doc means updating BANDS, never hard-coding.
- Investor one-pager (when written) → this file is its appendix.
- `DEMAND_IS_REAL` in [`assets/data.js`](../assets/data.js) flips all public wording from
  "illustrative" to "live" — flip it only when BANDS holds real records.

## Next 3 actions

1. Replace the last **[ESTIMATE]** rung — the tier price — then write the one-paragraph SOM
   statement (rooms × rent × take rate, 12 months) and pin it at the top of this file.
2. Pull real counts: `select count(*) from demand_records;` and the `demand_summary` view →
   recompute the ladder with the real median band, then set BANDS and `DEMAND_IS_REAL`.
3. Re-check the rent band each session (S8/S9 go stale fast): two agent listings and one
   resident report per area is enough to keep ₦300,000 honest.
