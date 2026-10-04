# 04 · PESTEL — macro-environment scan

**What it answers:** the outside forces that could help or wreck the model, and what to do
about each *now*, not after it bites. Macro factors are the ones we cannot negotiate with.

---

| Factor | Force on Arzuz | Impact | What we do |
|---|---|---|---|
| **Political** | Kwara State / institutional politics around campus housing; any student-union or university policy on off-campus living; a potential push for more on-campus hostels | **Medium** — slow-moving but structural | Stay a neutral, student-first information platform; relationships with student union, not politics |
| **Economic** | Inflation pushes rents up mid-session; naira depreciation raises landlord costs (gen, diesel, repairs); students' allowance budgets lag inflation | **High** — hits both sides of the marketplace | Demand bands re-collected every session (BANDS is the instrument — see [`assets/data.js`](../assets/data.js)); never show stale prices; Arzuz Care priced in-session, not per year |
| **Social** | Peer trust networks dominate decisions; scam-awareness is high post-fraud-wave; parents often pay and increasingly vet | **High** — this is our tailwind | Verification *is* the social product; shareable preview cards ride the WhatsApp graph; parent-friendly [`safety.html`](../safety.html) page is a real conversion surface |
| **Technological** | Cheap Androids on 3G are the device reality; WhatsApp is the OS-of-record for students; Cloudinary/Netlify/Supabase are all foreign services subject to outage and FX | **Medium** — mostly risk to manage | The site is already built for this: self-hosted fonts, no-framework pages, sub-₦30k Android + real-3G testing is on the README's launch checklist — keep it there |
| **Environmental** | Rainy-season leaks/damage spike repair demand (Care!); power instability makes water/generator amenities premium signals | **Low→Medium** | Season-timed Care marketing; utility fields already captured per listing are the data backbone for "verified water & power" |
| **Legal** | Tenancy law (Kwara), agent regulation talk, NDPA (Nigeria Data Protection Act 2023) consent + deletion duties, RC/company status for landlord contracts | **Medium→High** — NDPA is not optional | Privacy policy already published ([privacy.html](../privacy.html)); keep data minimisation real: write-only forms, no public PII (already enforced in the schema); register the business before charging landlords at scale |

**The two to watch:** economic (inflation vs student budgets — the demand bands must be
re-run every session or the site starts lying) and legal (NDPA consent/erasure — the
write-only architecture is a strong start, but deletion requests need an owner and a
procedure before scale).

## Where this lands on the site

- Session-stamped pricing language ("2026/2027 session" in [`assets/config.js`](../assets/config.js)) → the
  economic row: prices are seasonal by design.
- [`privacy.html`](../privacy.html) → the legal row; review it when data collection changes.
- [`care.html`](../care.html) → environmental row; Care's covered-list is the rainy-season product.

## Next 3 actions

1. Put "re-run demand bands" on the session calendar (repeat annually, registration window).
2. Write the one-page NDPA deletion-request procedure (who receives, who deletes, SLA) and
   link it from privacy.html.
3. Confirm business registration status before the first landlord is charged.
