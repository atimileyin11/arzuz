# Arzuz — financial system & monetization: implementation report

Four phases so far.

**Phase 1 — the money core** (schema + API + tests).
**Phase 2 — the customer storefront**: a customer can now read the published
terms, pay, and receive a pass with a receipt and a private link.
**Phase 3 — the repair-claim workflow**: the statuses, server-side eligibility,
the atomic call-out cap, provider assignment, customer confirmation and
disputes — with the customer pages to file and track a claim.
**Phase 4 — the admin finance dashboard**: business-line reports, a
ledger-derived reconciliation, refunds and referral payouts, all read from the
same `report` action the API already answered.

Still not built: the **student-facing referral dashboard** (a student seeing
their own code and rewards), the **verification / monitoring / marketplace
purchase flows**, **pro-rated revenue recognition** and the **forecast /
break-even module**. Section 7 is the honest boundary.

---

## 1. What was implemented

### Phase 1 — the books (`supabase-finance.sql`, new, additive, re-runnable)

| Object | What it holds / enforces |
|---|---|
| `finance_config` | key/value assumptions an admin may set: Care Pass price, call-out cap, parts ceiling, referral reward, marketplace fee bps, **`storage_enabled` (default `false`)**, term length/end. |
| `product_terms` | **Immutable, versioned, hashed** terms. One published version per product (partial unique index). The seeded Care Pass v1 is a **draft** (`published = false`). |
| `payments` | One order + its provider attempt. Immutable `terms_id`/`terms_version`/`amount_kobo`; `provider_ref` UNIQUE; `client_ref` UNIQUE (idempotency); a `paid` row **cannot exist without `paid_at`**. |
| `ledger_entries` | Append-only journal, **integer kobo**, one row per movement. No INSERT/UPDATE/DELETE for any client role. |
| `referrals` + `referral_codes` | Opaque code → owner; one reward per qualifying payment (unique); one qualification per referred customer (unique); **no self-referrals** (CHECK). |
| `care_plans` (+7 columns) | `terms_id`, `terms_version`, `coverage_start`, `coverage_end`, `call_out_cap`, `payment_id`, `receipt_ref` — a pass is a **term**, not a wallet. |
| Views | `public_terms` (published only), `payments_live`, `ledger_account_balances`, `business_line_summary`, `referral_report`. |

### Phase 1 — `netlify/functions/finance.js` (new) and the webhook

Public (metered, unauthenticated): `terms`, `order`, `verify`, `status`.
Team (live token + role read from Postgres): `report`, `publish_terms`,
`set_config`, `refund`, `referral_decide`. Support reads; **only admin moves
money**. `paystack-webhook.js` verifies the raw-body HMAC-SHA512 signature
**before** parsing, then activates through the same `activate()`.

Price from published terms only; activation only after server-side
verification or a signed webhook; amount+currency must match; `paid_at` claimed
with a conditional update so nothing activates twice; ledger refs derived from
the payment so a replay cannot double-post; self-referral refused; a referral is
never `paid` without a `provider_payout_ref`; storage and housing have no charge
path.

### Phase 2 — handing the product over (this phase)

A pass is a `care_plans` row whose only credential is a token this server
hashes and does not keep. So the link has to reach the buyer **without** being
handed to anyone who can merely name the order:

- `verify` reports the **coverage the plan actually opened** (`coverageOf`):
  start, end, cap, session, receipt — never a window the database did not open.
- The **pass link is released only to the browser that paid**, proved by the
  `client_ref` IT generated at checkout (`sameClientRef`) — a capability that
  lives in that browser, not the reference that travels in a URL. A caller with
  only the reference gets the receipt and the dates, and no link at all.
- **Issued once** (`PASS_LINK_MARK` on the order). When the webhook won the
  race, the buyer's own browser may claim the link exactly once
  (`claimPassLink`), replacing a token nobody ever saw. A second claim is
  refused, so a reload cannot mint a link behind one the team already sent.
- The receipt is minted **before** the plan is created, so the pass and the
  order carry the **same** reference (this was a real defect: the plan was
  written first and its `receipt_ref` stayed null — found by a test).
- `verify` also reports `amount_kobo` and `terms_version` **from the stored
  order**, so a return page cannot print an amount or a version nobody agreed
  to (both defects were found by walking the flow in a real browser).
- `callback_url` is built from **the deployment's own origin**
  (`ARZUZ_SITE_URL` / `DEPLOY_PRIME_URL` / `URL`), never from the request, so a
  caller cannot aim the post-payment redirect at a site of their choosing.

### Phase 2 — `care-pass.html` + `assets/care-pass.js` (new)

One public, indexable page that is the whole customer journey: published terms
→ acceptance → checkout → provider → verified return → pass, receipt and
private link, plus a reference lookup for an old order. The page decides
nothing about money: it sends the customer's own details and an idempotency
uuid, and prints the price, the coverage, the limits and the receipt it is
given. A retry reuses the same `client_ref`, so a double tap, a reload and a
second attempt can only ever be one order. A URL that says "success" is not a
payment — the page asks the server, and the server asks the provider.

No new migration was needed: Phase 2 writes only columns Phase 1 created.

### Phase 3 — the repair-claim workflow (`supabase-claims.sql`, `claims.js`)

A claim is filed against **one pass**, by the holder of that pass's link, and
the customer's page can only do what a customer may do:

| Action | What it can do | What it cannot |
|---|---|---|
| `list` | read this pass's claims, with the coverage the plan opened | see another pass's claims, or any team note |
| `create` | file the words, the room, the phone and https photo links | name a status, a reference, a price or a plan id |
| `confirm` | close a job that is `awaiting_customer` | confirm anything else, or confirm twice |
| `dispute` | say what is wrong, in words | dispute a claim nothing has happened on |
| `cancel` | withdraw a claim no worker has started | withdraw one a worker is already on (that is a dispute) |

None of those moves a credit. The credit is spent by the team's decision:

- **Coverage is decided in words.** `covered` or `not_covered`, each with a
  reason the customer reads. A refusal is recorded as a refusal (`rejected`,
  `eligibility_reason`) and spends nothing; a one-word reason is refused.
- **The call-out is taken atomically.** `claim_reserve_callout()` takes an
  advisory lock on the pass, reads the balance and appends the `reserved` row
  as one statement — so two approvals racing for the last call-out leave
  exactly one reservation, and the loser is told the pass has nothing left and
  left `under_review`, rather than approved against an allowance that is gone.
  A decision refused *after* the reservation (a bad `estimate_kobo`) gives it
  straight back through `claim_release_callout()`.
- **A worker's report is not a finished job.** Support names a worker with a
  number a student can ring and marks the job started; `report_work` posts the
  cost as an **expense and a provider payable in kobo**, with an `entry_ref`
  that cannot be posted twice, and moves the claim to `awaiting_customer`.
  Only the customer's confirmation — or an admin's named resolution — closes
  it, and a resolution that ends the job without the work returns the call-out
  **on the ledger** (a `released` row), never by editing a number.
- **Every transition writes `claim_events`** with a `from`, a `to`, an actor
  and a reason. An unaudited money change is refused rather than written.
- **The walls are the server's.** Marketing reaches nothing; support may
  coordinate but not decide, report or close; only the admin login moves money
  and closes a dispute by name.

### Phase 3 — `my-care.html` + `assets/my-care.js` (the customer pages)

One student's page, and the whole claim journey on it: file a fault, watch its
status in the server's own words, confirm it is fixed, dispute it with a reason,
or withdraw it. Three decisions worth naming:

- **The page prints the status the server sent.** A status it has never heard
  of is shown as it stands rather than guessed at, and the buttons offered are
  keyed on the status the server returned — a control the server would refuse
  is not drawn.
- **A refusal never throws away what the student typed.** Validation messages
  and refusals are written into the note beside the field (a live element)
  instead of repainting the section, which is also why the page harness reads
  the note element rather than the section's captured markup.
- **The repairs list cannot take the page down.** If `/api/claims` is not
  switched on, that section says so in the server's words while the balance and
  the ledger above it stay on screen.

### Phase 4 — the admin finance dashboard (`admin.html`, `assets/admin.js`)

One new section, and one rule about where its numbers come from: a **single**
`POST /api/finance {action:'report'}`, and every figure on the screen comes out
of that answer. The page does not read `ledger_entries`, does not query the
views and holds no second opinion about a balance. It shows:

- the lines (Care, verification, monitoring, marketplace, storage, housing —
  including the lines with no entries, printed as zeroes, with housing stated
  as carrying no revenue **by design**), and the orders the provider accepted;
- a **reconciliation** per line: `cash in − cash out` against
  `revenue + unearned + payable − refunds − costs`. Every posting is a pair, so
  that identity holds for real rows — and the panel prints both sides and the
  residual and **flags** a line that does not balance, because a one-sided entry
  is exactly the mistake this screen exists to catch;
- **refunds**: a reference and an amount, posted through the function (provider
  first, then the reversal pair, so the books move with the money);
- **referral payouts**: the pipeline by state, and a move that can only reach
  `paid` with the provider's own payout reference.

Support reads all of it and is offered no control that moves money; only the
admin login is — and the function refuses those actions from any other role, so
the hidden button is not what is protecting the money.

## 2. Files changed

- Phase 1 new: `supabase-finance.sql`, `netlify/functions/finance.js`,
  `netlify/functions/paystack-webhook.js`, `scripts/test-finance.mjs`, this
  report.
- Phase 2 new: `care-pass.html`, `assets/care-pass.js`,
  `scripts/test-care-pass-page.mjs`.
- Phase 3 new: `supabase-claims.sql`, `netlify/functions/claims.js`,
  `scripts/test-claims.mjs`; edited: `assets/my-care.js`, `my-care.html`,
  `dev/my-care-test.js`, `package.json` + `dev/run-tests.mjs` (`test:claims` in
  the gate).
- Phase 4 new: the Finance section in `admin.html` + `assets/admin.js` (with a
  `coin` icon in `assets/admin-ui.js`), the `/api/finance` and double-entry
  journal in `dev/admin-mock.js`, and the finance checks in
  `dev/admin-boot-test.js`.
- Phase 2 edited: `netlify/functions/finance.js` (link claim, coverage,
  callback URL, one receipt), `scripts/test-finance.mjs`,
  `netlify.toml` (`/care-pass` ⇄ `/care-pass.html`), `sitemap.xml`,
  `scripts/test-seo.mjs` (the page registry), `care.html` (a buy link),
  `package.json` + `dev/run-tests.mjs` (`test:care-pass` in the gate).
- Phase 2 copy corrected, because a paid Care Pass made it untrue: the shared
  footer (`assets/app.js`), `assets/roommate.js`, `browse.html` (twice),
  `register.html`, `listing.html`, `404.html` — "does not take payment from
  tenants" now reads "takes no rent and holds no deposit; the only thing Arzuz
  sells is an optional Care Pass".

## 3. Running the migration

`supabase-finance.sql` runs **after** `supabase-team-roles.sql` and
`supabase-care.sql`. Paste it into Supabase → SQL Editor → Run. It is
idempotent; the preflight names whichever prerequisite is missing. It is served
as a 404 on the live site (deploy guard verified).

## 4. Environment variables required (names only)

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (already used
  by the other functions).
- **`PAYSTACK_SECRET_KEY`** — new, server-side only. Without it every money
  write answers `503 not-ready`; nothing half-charges.
- `ARZUZ_SITE_URL` — optional. Overrides the origin the post-payment redirect
  returns to; when unset the deployment's own URL is used.

## 5. Payment provider configuration still needed

1. Create the Paystack account and set `PAYSTACK_SECRET_KEY` in Netlify.
2. Point the Paystack webhook at `https://arzuz.com/api/paystack-webhook`.
3. Confirm the settlement account and that NGN is the settlement currency.
4. **Approve and publish the Care Pass terms** — sales stay off until then, and
   `/care-pass` will say so rather than offering a checkout.

## 5b. A checkout that never opened, and a checkout replayed

Two failures that are not "the code is wrong" but "the buyer cannot pay",
both found by asking what happens to the ORDER when the provider misbehaves:

1. **A replayed order had no payment page.** Paystack refuses a second
   `transaction/initialize` for a reference it already holds, so an order
   replay (a double tap, a reload, a response that never arrived) used to
   return the same order with **no `authorization_url`** — the page set
   `state.phase = 'paying'` and navigated nowhere. The buyer saw a Pay button
   that did nothing. The provider's own answer is now stored on the order
   (`provider_payload.checkout`) the moment it arrives, and the replay hands
   back **the same payment page**. Nothing re-initializes, so nothing can
   open a second transaction against a reference the provider already has.
2. **A dead provider bricked the checkout.** If `initialize` failed, the
   order stayed `pending` with no URL and every later attempt replayed it —
   a permanently unusable order and no sentence on screen saying why. It is
   now marked `abandoned` with the reason, and the page is told `retry`, which
   makes it forget the stored `client_ref` and write a **fresh order**. One
   automatic attempt, then the sentence — a provider outage must not become a
   loop of invisible orders. `initialize` does not move money, so this can
   never charge anybody twice.

**The payment-specific security checks** (all in `scripts/test-finance.mjs`):
no page or asset the browser can fetch carries the provider secret (read from
DISK, so it is a claim about what is served); the public `status` answer
exposes neither the checkout capability, the provider payload nor the
idempotency key; an unsigned or wrongly-signed webhook is refused **before any
database read**; the amount is re-checked against the order on both doors; the
pass link goes only to the `client_ref` that paid.

## 6. Tests executed, and their results

| Suite | Result |
|---|---|
| `node scripts/test-finance.mjs` | **55 passed, 0 failed**, exit 0 (48 before §5b's seven) |
| `node scripts/test-claims.mjs` | **47 passed, 0 failed**, exit 0 |
| `node dev/my-care-test.js` (the claim pages included) | **63 passed, 0 failed**, exit 0 |
| `node dev/admin-boot-test.js` (finance panel, all three roles) | **TOTAL 230 · PASS 230 · FAIL 0**, exit 0 |
| `node scripts/test-care-pass-page.mjs` | **TOTAL 47 · PASS 47 · FAIL 0**, exit 0 (46 before the fresh-order check) |
| `node scripts/test-site-audit.mjs` (changed pages, real Chrome, 2 widths) | **TOTAL 61 · PASS 61 · FAIL 0** |
| `node scripts/test-admin-worst.mjs` (worst case + demo, real Chrome) | **TOTAL 69 · PASS 69 · FAIL 0** |
| `node scripts/test-seo.mjs` | **PASS 269 · FAIL 0** |
| `npm test` | **every suite the repo has passed**, exit 0 (19 of them when this was written; the count only grows) |

**Negative controls, Phase 3 and 4 (each proved by letting it fail, then
restored):**
- Two approvals driven concurrently for the last call-out: with the reservation
turned into a plain read-then-insert, both claims were approved on a pass with
one call-out left. The atomic function is what makes exactly one win.
- The reconciliation driven with **half a posting**
(`__MOCK__.financeOneSided()`): the line must report `off by ₦5,000`. A panel
that always said "balanced" fails this — which is the point of asserting it
rather than trusting the arithmetic.
- A refund driven as a support login: money must not move, and the refusal must
be **shown**. It was not, at first — the notice was rendered only for roles
that could act, so a support user's refusal vanished. Fixed, and pinned.

The finance suite drives the real function against a PostgREST/Paystack
stand-in that enforces the same constraints as the migration. The page suite
drives `care-pass.html`'s own script in a DOM harness against server answers.

**Negative controls, both suites (each proved by letting it fail, then
restored):**
- `sameClientRef` forced to `true` → a stranger got a link. This control *found
  a weak test*: the earlier assertions passed because the "issued once" marker
  refused the stranger, not the ownership check. A test that isolates the
  ownership rule was added, and the mutation now fails it.
- An `amount_kobo` added to the page's order request → the page suite went red
  on both the payload-shape check and the "never names money" check.
- The page forced to treat any answer as an activated pass → the return-flow
  checks went red.

**Browser evidence.** The whole journey was walked in real Chrome against a
local stand-in of the function (outside the repo): terms rendered from the
server (₦20,000, v3 + hash, limits, covered/not-covered), acceptance gate
holding the button disabled, order placed, provider redirect, return verified,
pass shown with receipt `AZ-R-…`, coverage 13 Oct 2026 → 10 Feb 2027, cap 4 and
a working "Open your pass" link. That walk found the two receipt defects listed
above, which are now fixed and pinned by tests.

## 7. Not implemented (and therefore not claimed)

- **No live payment was ever exercised.** No Paystack keys exist in this
  workspace, so no real charge, webhook delivery or refund happened — only the
  provider contract against a stand-in. `PAYSTACK_SECRET_KEY` is the gate.
- **Repair claims — the team's side of the queue.** The workflow is complete
  and tested end to end *through the API* (`claims.js` actions `queue`,
  `decide`, `assign`, `progress`, `report_work`, `resolve`, all role-gated), and
  the customer can file, follow, confirm, dispute and withdraw from `/my-care`.
  What does not exist is a **claims panel in the dashboard**: today the team
  works the queue by calling the function (or through the API until one is
  built), so the operator surface is the remaining gap, not the rules. No
  evidence **upload** either — a claim takes https photo links, which the
  existing media steps produce.
- **The student's own referral view**: referral terms are visible at checkout,
  and the dashboard shows the pipeline, but a student cannot yet see their own
  code, their rewards or a payout status.
- **Verification / monitoring / marketplace purchase flows**: only their config
  keys, business-line guards and reporting buckets exist. Marketplace fee is
  `0` until an admin sets it, and it is never applied to rent. **Storage is off
  by design** and a storage order is refused while it is.
- **No pro-rated revenue recognition** over the coverage term (the ledger books
  cash and the unearned obligation; a recognition policy/scheduler is future
  work), and **no forecast / break-even module** (§11).
- **No live repair was ever worked end to end either.** The claim suite drives
  the real function against a stand-in that enforces the schema's own rules,
  and the SQL proof runs the real reserve/release functions on PostgreSQL in
  WebAssembly — but no claim has been filed, approved, assigned and confirmed
  against the live database, because Care is not switched on there yet.

## 8. Run it locally / deploy safely

```bash
cd arzuz-site
npm install
npm test                    # every suite the repo has, each reported separately
node scripts/test-finance.mjs
node scripts/test-claims.mjs
node dev/my-care-test.js    # the customer pages, claims included
node dev/admin-boot-test.js # the dashboard, finance panel included
node scripts/test-care-pass-page.mjs
```

Deploy: the SQL is additive; run it in the SQL editor **before** the deploy that
ships the functions. Set `PAYSTACK_SECRET_KEY`, then publish approved Care Pass
terms through the admin door. Until terms are published, `/care-pass` shows the
"not on sale yet" state and offers no checkout — deliberately.

## 9. Needs your approval before going live

1. **Publish the Care Pass coverage terms** (currently a draft). Sales are
   refused until this happens.
2. The **refund policy wording** as published terms, and the **marketplace fee
   bps** (currently `0`).
3. **Paystack** account, live keys and webhook URL.
4. Whether to switch **storage** on after its operational and legal controls are
   reviewed (default: off).
5. The **revenue-recognition policy** for a coverage term.
6. The **corrected non-payment wording** across the site (section 2) — it is a
   claim about how Arzuz makes money, so it is yours to approve.
