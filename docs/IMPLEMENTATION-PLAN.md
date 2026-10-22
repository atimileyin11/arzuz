# Arzuz site-wide implementation plan

**Scope:** review and improve the landing page through mobile and desktop, make property forms match real-world housing/utilities workflows, close the most consequential admin operational gaps, and correct the Arzuz Care payout checkpoint. This is an implementation plan plus the follow-through work in this change; it does not authorize or perform production money movement, deploy, or apply a database migration.

## Findings from the first code pass

- The landing hero already has a coherent responsive 3D composition: desktop uses a two-column interactive depth scene; below 940px the scene moves below the copy, suppresses the pointer-driven depth transforms, and keeps a light ambient float. It is labelled as a single accessible image. Preserve this unless browser checks show an actual defect; do not force perspective/tilt on touch screens.
- The invited property form is a 3-tab, autosaved draft form. Its amenities field already accepts custom tags and reads `UTILITIES` from the shared list, but the suggestion vocabulary is a short, ungrouped list (including the locally ambiguous “NEPA connection”) and does not teach the difference between a service being available and how it works in this specific property.
- The admin has dedicated finance, repair-claims, and Care sections with responsive tables/cards, but repair-work costs are posted as provider payables and there is no visible, end-to-end checkpoint for verifying and settling those repair-provider payables. Referral payouts already have a separate status/reference flow; do not conflate the two.
- The financial code is ledger-based. Any payout correction must be admin-only, auditable, idempotent, and must never claim a real bank transfer happened merely because an operator recorded a reference.

## Prioritized implementation

### P0 — Verify the actual page at both sizes; retain good 3D behavior

1. Walk the complete landing page and the property invite, staff/admin, and Care journeys at wide desktop and narrow phone widths. Check every section, fixed control, form input, table/card, and browser console/network error.
2. Run the homepage motion/geometry and site-wide audit suites. Retain the existing hero behavior if it passes. If a test exposes an overflow, obscured action, or broken scene, fix the cause rather than removing the scene wholesale.

**Acceptance:** no page-level horizontal overflow at the audit phone widths; no hero 3D plate covers copy or a control; object is legible and placed beneath copy on touch-sized viewports; pointer/depth motion is limited to pointer-capable desktops; reduced motion stays readable and settled.

### P1 — Make property and utility entry feel like completing a real property record

1. Organize utility suggestions by what a renter inspects in real life (water, electricity, sanitation, security, cooking/common facilities, connectivity) while continuing to accept an unlisted, property-specific amenity.
2. Replace ambiguous utility language with actionable labels/examples and an explicit “Other” path that saves a custom value; preserve existing stored amenity values and admin-created suggestions.
3. Check the full listing form for missing label/input associations, realistic units, useful keyboard/input modes, conditional details, required-field guidance, and errors that preserve work and lead to the relevant tab/field.
4. Keep the landlord invite and admin add/edit listing forms in one vocabulary and make the interaction comfortable at phone width (16px touch inputs, fitting segments, map/media controls, and non-overflowing long custom values).

**Acceptance:** custom utilities survive edit/reopen/save; default suggestions are recognizable local services and grouped; keyboard users can identify and select/remove each value; missing required listing data focuses its field and keeps the draft intact; the same records remain compatible with the existing database payload vocabulary.

### P2 — Close the Arzuz Care provider-payout checkpoint safely

1. Follow a repair claim from approved work through actual-cost report and ledger payable. Distinguish estimate, actual cost, payable, transfer, and settlement in the UI.
2. Add a guarded reconciliation checkpoint for a *specific claim and named worker*: require an existing posted payable matching the reported actual cost and a real provider transfer reference before an admin can mark it settled.
3. Post settlement as the matching pair of append-only ledger entries (debit provider payable / credit cash), with a stable claim-scoped idempotency reference; reject duplicates, mismatched amounts, missing work, missing worker, non-admins, or an empty/placeholder transfer reference.
4. Make the claims panel and finance reconciliation expose the resulting state, and exercise success, refusal, duplicate/replay, and ledger-balance paths with test fixtures.

**Acceptance:** no direct provider/bank transfer is initiated by this control; it records a transfer that the operator has already confirmed. A retry cannot settle twice, unauthorized callers cannot post, and the Care reconciliation balances before and after settlement.

### P3 — Reduce the admin’s avoidable gaps and verify end-to-end

1. Walk each admin section and role, concentrating on first actions, missing/empty/loading/error states, status-to-action consistency, and whether a teammate can find the next step without leaving a section.
2. Fix only gaps confirmed by the real browser and existing boot/worst-case suites; preserve each role boundary and make dense finance/claims views usable on phone-sized screens.
3. Re-run focused Care, claims, finance, forms, admin, landing-motion, geometry, and whole-site layout suites after the final edits. Check the real browser at desktop and phone sizes; identify device-only behavior that needs a real phone rather than claiming it was verified.

**Acceptance:** existing workflows and permission checks still pass; only project-relevant files change; all reported checks run against the final edited files. Unavailable production configuration, migrations, or physical-device checks are named as limitations, not presented as verified.

## Execution boundary

Proceed in order from verification to the smallest fixes that satisfy the checks. Never run a provider transfer, edit production records, apply SQL to Supabase, deploy, or push changes as part of this code task. A production payout is only marked settled after the operator verifies the external transfer and enters its provider reference.
