# Arzuz Admin — Rework Test Report

**Date:** 2026-10-06 · **Branch:** main (uncommitted working tree)
**Harness:** `?mock=1` (fake Supabase session + stubbed fetch, zero production data)
**Automated suite:** `node dev/admin-boot-test.js` — **95 / 95 PASS** (admin, support, marketing)

---

## 1. What the rework delivered

| Area | Before | After |
|---|---|---|
| Icons | Emoji glyphs everywhere (📈 📅 ✅ …) | ~35-glyph inline SVG sprite (`admin-ui.js`), hydrated via `[data-icon]` |
| Design system | Ad-hoc styles | Additive tokens in `arzuz.css` (`--dur-*`, `--r-*`, `--sp-*`, `--fs-*`); admin tokens (`--a1/a2/a3`, `--atext*`, `--apurple`, `--aok/warn/err/info`) |
| Motion | `transition: all` | CSS keyframes + WAAPI only: stagger-in sections, count-up metrics, pop-in modals, busy spinners, press scale(.97), `prefers-reduced-motion` respected |
| Accessibility | — | Modal `role=dialog` + `aria-modal` + focus trap + restore, `aria-live` modal errors, labelled close buttons, `focus-visible` rings, semantic table walked by a11y tree |
| Mobile | Fixed-width sidebar | dvh + safe-area insets, pill-scroll nav bar, bottom-sheet modals <860px, 16px inputs (no iOS zoom) |
| Testing | None | `dev/admin-mock-data.js` + `dev/admin-mock.js` (scenario switcher `__MOCK__.{role,empty,slow,error,reset,stats,db}`), `dev/admin-boot-test.js` VM-sandbox suite |

---

## Addendum — Arzuz Care as service credits (2026-10-09)

Three suites, all re-run after the last edit: `node scripts/test-care.mjs` → **31 passed, 0 failed**
(new), `node dev/admin-boot-test.js` → **TOTAL 182 · PASS 182 · FAIL 0** (was 164; +18), and
`npm run sql:proof` → **TOTAL 80 · PASS 80 · FAIL 0** (was 59; +21). `npm test` runs all four in
order and exits non-zero on any failure.

### The five decisions, and what each one bought

The spec did not exist in this repository — no table, no column, no function, and no `value_ngn`
anywhere either — so the design was settled with the team before any code, and each answer is now
enforced somewhere rather than documented somewhere:

| Decision | Where it is enforced |
|---|---|
| One credit = one call-out; a session is four | `care_credit_events_shape_check`: `'spent'` may only ever be `delta = -1` |
| The balance is an append-only ledger, not a counter | no INSERT/UPDATE/DELETE grant to ANY client role; the balance view sums the ledger and joins nothing |
| The team writes; a student never spends their own credit | `care-credit.js` holds the service key; the panel has no balance control at all |
| ₦20,000 flat, as published | `SESSION_FEE_NGN`/`CALL_OUTS_INCLUDED` compared against `care.html`'s numbers by a test |
| Credits are session-scoped | `expire` appends a negative row and sets the plan `ended` |

### The ledger is read from the ledger

`care_credit_balance` is computed **from `care_credit_events` alone**, with no join to `care_plans`,
so a balance survives the plan row it belongs to — the same reasoning that left the consent trail
without foreign keys. That is asserted directly: the SQL proof inserts a ledger row for a plan id that
has no `care_plans` row and reads the balance back. A second view, `care_plans_live`, is what the
panel lists.

Both CHECK constraints are named and **re-stated** (`drop constraint if exists` + `add`), before it is
needed rather than after: `create table if not exists` is a no-op on an existing database, so a future
widening would otherwise never reach a live install. That is the lesson the `'viewed'` event taught,
applied while it was still free.

### What the engine suite asserts

31 tests against a stand-in that implements the four PostgREST paths the function uses — and that
**enforces the same shape rules as the SQL**, so the suite can also assert the converse: *nothing the
function wrote would have been rejected by the database.* Beyond the gate (401/403/405/400, marketing
refused with no student data in the body, a non-JSON body refused rather than crashed on) and the
rate limit:

- a grant opens four credits at ₦20,000, appends `+4`, and returns the token **once** — the stored
  `token_hash` is a sha-256 digest and the raw token appears nowhere in the database
- the same student cannot hold two ACTIVE plans for one session (409, and no plan is created),
  while a different session, or a refunded plan, is a legitimate new one
- one call-out takes exactly one credit and records the worker, the parts and the reason; parts over
  the ₦3,000 ceiling are flagged, not clamped
- four call-outs reach zero, the fifth is refused with `409`, and **nothing is written** for the
  refused one — this is the test that would catch a counter drifting negative
- a refund is refused once a call-out has been used (409, plan status unchanged), voids the unused
  credits when it is allowed, and cannot happen twice
- expiry voids what is LEFT rather than the original grant (`3 call-outs unused`)
- expiring an empty plan writes **no row** — a zero-delta row is a comment, not a ledger entry
- a correction needs a reason, cannot take the balance below zero, and appends rather than editing
  (the earlier rows are still `-1` afterwards)

One ordering decision was settled by a failing test rather than by taste: a spend with unusable
`parts_ngn` now answers **400 before** the balance check, so the order is 404 (no such plan) → 400
(unusable payload) → 409 (state refuses it). Before that it answered `409 no call-outs left` to a
caller whose actual mistake was the field they typed.

### What the dashboard panel asserts (18 checks, three roles)

Every number is recomputed from `__MOCK__.db().care_credit_events` — the events, not the view — so a
panel or a mock that kept a running total would fail here instead of looking right on screen: the
per-plan balance equals its ledger sum, the metric totals are the same sums, and a credit taken back
with no call-out behind it reads as `0 of 4 used` rather than claiming a visit happened.

Disabled states are asserted as behaviour, not decoration: a plan that has used a call-out is **not**
offered a refund, and a plan with nothing left offers no call-out. Recording one opens a drawer that
asks who did the work (asserted), confirming with no worker named is refused **before any request is
sent** (asserted by counting writes, not by reading the note), and a confirmed call-out is written by
the endpoint with the worker and the parts on the row, after which the balance and the metric follow.

The role split is asserted per role rather than assumed: **support sees the panel** (they record the
visits) and is offered no balance control; **marketing never sees a plan**, is not offered the nav
item, and a deep link to `#/care` falls back to a section it may read.

### What only a browser could check

The harness cannot dispatch a document-level event, and the panel's buttons are wired by delegation —
so the click path was driven on a real page at `?mock=1` (dev server on 8132, stopped afterwards) with
the shipped pin `admin.js?v=19`. A real click on **Record a call-out** opened the drawer with all three
fields; **Confirm** with nothing typed produced the refusal note and posted **zero** requests; a filled
form posted exactly
`{"action":"spend","plan_id":"care-0001","worker":"Verified worker","parts_ngn":4500}`, the ledger
moved 3 → 2, the drawer closed, and the toast read *"Call-out recorded — 2 left. Parts are over the
included ceiling — quote the student."* The module's own numbers were confirmed against `care.html`
(₦20,000 / 4 / ₦3,000), the metric read `5 call-outs left · 2 used · 2 of 3 active` straight after the
write, and the console was clean.

A second pass re-ran the two paths that this addendum actually changed, on the final files served as
`admin.js?v=19` (dev server on 8133, stopped afterwards), driving real clicks rather than calling the
step functions:

- **A call-out with the parts field left empty.** The row landed as `parts_ngn: 0` with no note — the
  absent-field-defaults-to-zero fix, confirmed through the UI and through
  `__MOCK__.db().care_credit_events`. The balance moved 4 → 3 → **2 of 4**, the metric from
  `6 left · 1 used` to **`5 left · 2 used`**, and the drawer closed.
- **A call-out with ₦5,000 of parts.** The row landed with `parts_ngn: 5000` and
  `note: "Parts over the included 3000 naira ceiling — quote the student before the work."` — written
  and surfaced, not blocked, and a second call-out later the balance is 2 of 4.
- **The refund gate against the data, not a flag.** Only Ifeoma's plan offered an enabled **Refund**
  (its ledger has a `granted` and an `adjusted`, no `spent`); Halima's was disabled because its ledger
  holds a `spent`; Bashir's refunded plan disabled all three buttons. `call_outs` in
  `care_credit_balance` is `count(*) filter (where event = 'spent')`, so the gate reads the visit, not
  the credit count — the interpretation the limitation below names.

The console held one line (the harness's own ready log) and the network log was empty after both
writes — no failed request, no unhandled rejection.

### Limitations

- **Nothing sells Care yet.** There is no checkout, so a plan is opened by calling the `grant` action
  directly; the panel deliberately offers no grant button (it is a money path, and where students are
  picked from is a product decision, not a UI detail). There is no student-facing balance page either.
- **The refund rule is an interpretation.** `care.html` says "cancel before the session starts for a
  full refund"; the code reads that as *no refund through this button once a call-out has been used*.
  If the intended rule is calendar-based, the function's check is the one line to change.
- **Alerts are absent by design.** A spend, a refund and an expiry are actions the team just took, so
  none of them buzzes Telegram. If a Care event should reach the channel, that is a new decision.
- **The ₦3,000 parts ceiling is recorded, not enforced.** Over-ceiling parts are written to the row
  with a note and surfaced to the operator as a reminder to quote the student; nothing blocks the
  call-out.
- **`supabase-care.sql` is still unexecuted on Supabase itself.** It is proved against real
  PostgreSQL 18.3 by `npm run sql:proof`, with a stand-in for the `auth` schema and the Supabase
  roles — not against the platform's own Postgres version.

---

## Addendum — the student door, the grant form, and the platform's own 401 (2026-10-10)

The addendum above named two gaps on purpose: *nothing sells Care yet*, and *there is no
student-facing page*. This round closes the second and gives the first a real instrument. Every
suite was re-run on the final files: `node scripts/test-care.mjs` → **58 passed, 0 failed** (was 31),
`node dev/my-care-test.js` → **41 passed, 0 failed** (new), `node dev/admin-boot-test.js` →
**TOTAL 202 · PASS 202 · FAIL 0** (was 182), `node dev/postgrest-test.js` → **24 passed, 0 failed**
(new — §19 makes it 27 by asserting both Care worlds rather than assuming one), `npm run sql:proof` →
**TOTAL 131 · PASS 131 · FAIL 0** (was 80). `npm test` now runs seven suites and exits non-zero on
any failure — **eight** after §19 adds `test:care-live`.

### The student's page — and why it is a credential, not a login

`/my-care?t=…` is one plan, for one student, reached only by the link minted at grant time. There is
no login and no password, exactly like a roommate profile, so the link **is** the credential and the
page is written around that:

- **It can do two things, and neither moves a credit.** `view` reads the plan, its balance and its
  ledger; `request` files a Support Desk ticket. There is no `spend`, no `refund` and no `adjust` on
  this page — a student cannot award themselves a call-out, and the page has no control that would.
- **The balance is never computed in the page.** It renders the sum the server returned, in the
  server's order. A harness check greps the script to prove no arithmetic is done on it.
- **The form is gated by the server's `can_request`**, not by whether a button was drawn — the suite
  renders a plan where `can_request` is false and asserts the form is refused, then asserts the server
  refuses it again if the call is made anyway.
- **Every value is escaped.** Worker names, reasons and the student's own words are text a person
  typed, so `esc()` stands between them and the DOM; a fixture carrying `<script>` and quotes renders
  as text, asserted by reading the rendered string.

Two failure classes had to be distinguished, and the reason is a real deployment state rather than a
theory. PostgREST answers **404** both for "no such link" and for "that table is not in my schema
cache", so the page keys on the *sentence* `"we do not recognise"` before it will forget the token —
a 404 from a half-deployed site must not delete the student's only key. A missing Care table is
mapped by the function to **503** and the page says *"Care is not switched on for this site yet"*,
which is what the live database honestly reports today. `test-care.mjs` asserts the 404/503 split at
the function, and `my-care-test.js` asserts each one lands on the right screen at the page.

### The grant form

Opening a plan is a money path, so it is the one place the panel will not take a bare number: **Open a
Care plan** asks for the name, the phone a worker will ring, the session, the fee and *why this plan
exists*, and posts `grant`. The server mints the token, stores only its sha-256 hash and returns it
**once**; the panel shows it read-only with **Copy** and **WhatsApp it** and states that it cannot be
shown again — which the suite asserts by re-rendering (the link is gone from the payload, only the
hash lives in the table). The three role rules from the previous addendum still hold: support may open
and record, marketing sees nothing, and a 403 does not sign anyone out.

The four new `test:care` grants and the harness checks that matter most are the ones that would fail
quietly otherwise: the fee is recorded but **not charged** here, the same student cannot hold two
ACTIVE plans for a session (409, no row created), and the reason lands on the `granted` ledger row so
the "who opened this and why" question has an answer.

### The platform's own answers, replayed

`dev/postgrest-capture.mjs` records the live Supabase/PostgREST responses — status, headers and the
platform's own bytes — into `dev/postgrest-fixture.json`; `dev/postgrest-test.js` feeds that recording
through the **real** `admin.js` in the sandbox. It is a recording, not a stub, and the suite asserts
that: every denial carries Postgres `42501`, and every read `admin.js` makes at boot is present in the
recording, so nothing was answered from a fallback.

The point is the class distinction the dashboard depends on — a **401** and a **403** both sign the
session out with the operator's sentence and clear the dead token (a facts check: flipping one status
to 200 makes the session survive, so the status is the cause), while a **404 + PGRST205** for the
absent Care table does *not* sign anyone out and the panel simply says nothing is there yet. That is
the live state today, and the suite asserts the conclusion rather than a green tick: the database has
not had `supabase-care.sql` applied, and a student link is answered **503, not 404**.

### Browser walk (dev server, stopped afterwards)

Both pages were driven on a real page, not only through the harness.

- **`my-care.html`** — the no-link state renders its "this page needs your own link" card. With a
  stubbed `view` answer the page painted the balance (`2 of 4`, `₦20,000 paid`, `active`), the ledger
  in the server's order (`Call-out · Worker: Electrician — Musa · No power in room · Fuse replaced`,
  then the caretaker's `Parts ₦1,200`, then `Session opened +4`), the covered/not-covered lists and the
  request form pre-filled with the student's own room and phone. Typing an issue and pressing **Ask for
  a worker** posted `request` and the confirmation *"Logged — the team will WhatsApp you within 48
  hours"* replaced the note, with the balance untouched — asking does not spend a credit.
- **`admin.html?mock=1#/care`** — the panel read `6 left · 1 used · 2 of 3 active`. **Open a Care
  plan** revealed the seven fields; filling the name, the phone and the reason and pressing **Open it —
  4 credits** created `Test Student`, moved the metric to `10 left · 1 used · 3 of 4 active`, and
  returned the one-time link `…/my-care?t=mockcarenx2monvcazdmv1uj0et` with **Copy the link**,
  **WhatsApp it** and the follow-up step. Screenshots taken at each step; the console was clean.

### Limitations

- **The grant form still is not a checkout.** It records a payment taken elsewhere; it does not take
  one. A real sale needs a payment path, and that is a product decision, not a missing control.
- **The student page cannot cancel or refund.** It can read and ask. A refund is done by the team
  through the dashboard, which is where the refund rule is enforced.
- **`supabase-care.sql` is still unexecuted on Supabase itself**, so the live answer to a student link
  is `503` by design until it is run. The replay test asserts that state rather than hiding it; when
  the file is applied the expectation flips and the fixture must be re-captured with
  `npm run postgrest:capture`.
- **The capture is a point-in-time recording.** It proves the dashboard's handling of the platform's
  documented refusal classes, not that the platform's live schema is unchanged since; re-capture after
  any Supabase upgrade.

---

## Addendum — the SQL finally runs (2026-10-09)

`npm run sql:proof` → **`TOTAL 59 · PASS 59 · FAIL 0`, exit 0**. Two real bugs found and fixed.

Until this, **not one line of the `supabase-*.sql` set had ever been executed** — at the time that
was 2,812 lines across nine files, and `supabase-care.sql` has since made it ten — no
psql, no server, no Docker in this workspace — so the append-only consent trail, the role model and
the `security_invoker` views were all desk-checked by reading. `dev/sql-proof.mjs` runs them against
**PGlite**: PostgreSQL **18.3** compiled to WebAssembly, i.e. the real planner, the real RLS, the
real `create policy`. `@electric-sql/pglite` is a devDependency in a new `package.json`; the site
itself still has no build step and no runtime dependencies.

### What it proves

- **All nine files applied, in this order:** schema → hardening → location → public-view →
  media-booking → drafts-support → draft-sharing → team-roles → roommate. The order is not
  alphabetical and is the first thing asserted, because three of the files state prerequisites that
  are *enforced*: `team-roles` raises in a preflight if the tables it secures are missing, and
  `roommate` refuses to build its policies unless `public.arzuz_role()` already exists. (The list has
  since grown to ten — the addendum at the top of this file adds `supabase-care.sql`, which sits
  last because it also depends on `arzuz_role()`.)
- **The whole set applies a second time, unchanged** — the upgrade path for a live database. Counts
  *and* policy names are compared, because a sweep that deletes a policy and recreates it under
  another name keeps the total identical while changing what the database allows.
- **The security model, under `set role` with a JWT** — not described, exercised: anon cannot read
  or write the pool (42501), **marketing reads zero rows** (not an error — the distinction the
  dashboard's 401/403 handling depends on), support and admin read rows, marketing cannot reach a
  phone number through `roommate_mutual_pairs`, and no client role — including a full admin — can
  insert into or delete from the consent trail.
- **`arzuz_role()`'s truth table**, including the branch that matters: `service_role` returns its own
  name, an unknown role is not promoted, and a request with **no JWT at all** returns `anon` — the
  branch whose absence would make every visitor on the internet an admin.
- **The behaviour the app leans on:** the widened `'viewed'` CHECK (accepted, and exactly one CHECK
  constraint on the table), the guarded `budget_ngn` cast storing `"180,000"` as null, generated
  columns, self-match and duplicate-decision rejection, an admin being able to actually insert a
  listing, anon being unable to post one straight onto the browse feed, and `public_listings` still
  readable by anon.

### The two bugs

**1. `supabase-hardening.sql` could not be applied after `supabase-schema.sql`.** Both files create
policies under the same names, and hardening created its INSERT policies *before* the sweep that
drops old policies by name — so the second file died on `42710 duplicate_object: policy "public can
submit demand" for table "demand_records" already exists`. The Supabase SQL editor runs a pasted
file as ONE transaction, so the entire hardening pass rolled back: no `tier`, no `env`, no generated
`listed_price_ngn` / `property_name`, no `client_ref`. The next file's preflight then told the user
to run the file they had just run. The sweep now runs first, which is also what makes the file
idempotent as its header claims.

**2. The same sweep deleted the admin's INSERT policies.** Its name list includes `admin can add
demand`, `admin can add listings` and `admin can add scout reports` — the three policies the file
creates a few lines earlier — so hardening alone left the dashboard's Add modal refused by RLS.
Confirmed by the mutation below, not by inference.

### Mutation-tested, because a green harness proves nothing on its own

- **Reorder the sweep back after the creates** → the harness stops with the *original* error:
  `policy "public can submit demand" ... already exists`.
- **Drop the three INSERT names from the sweep list** (the re-runnability half) → run 1 fails with
  `policy "admin can add demand" ... already exists`, because `supabase-schema.sql` creates that same
  name and nothing removes it first.

Both mutations were reverted with the file byte-identical afterwards (`diff -q` clean) and the suite
re-run green. A third, subtler hole is covered separately: the *end state* of the database cannot
prove bug 2 either way, because `supabase-team-roles.sql` later creates its own INSERT policies under
different names — so four checks assert the file's shape instead (sweep before the first create,
inside the RLS section, naming its own policies, with the amenity names handled by their own block).

### Limitations

- **It is not Supabase.** The harness builds a stand-in for the four things Supabase provides: the
  roles, the `auth` schema with `auth.uid()` / `auth.jwt()` / `auth.role()`, Supabase's default
  `grant all on tables to anon, authenticated` (so the files' revokes are proved against the
  privilege set they were written for, rather than passing vacuously), and a JWT as
  `request.jwt.claims`. A policy passing here has been proved against real RLS and a stand-in JWT.
- **Postgres 18.3, not Supabase's version.** Supabase is on 15/17 depending on project age; nothing
  used here is version-sensitive (generated columns, `security_invoker`, `create policy` and
  `has_table_privilege` are all PG 15 era), but the version is not the same one.
- **No PGlite extension surface.** These files need none, so nothing was tested about extensions.
- **PostgREST is not exercised.** The harness proves the grants and the SQLSTATE each bad request
  produces; that PostgREST turns *these* codes into 401/403/404 rather than something else is still
  reasoned from its documented behaviour, and stays a live-site check.
- **The two files I edited this round were edited by me, not by Postgres.** The fix is verified by
  running it, in both directions.

---

## Addendum — previewing the digest, exporting the record, and why matches stall (2026-10-09)

`node scripts/test-roommate-score.mjs` → **`72 passed, 0 failed`, exit 0** (was `63`).
`node dev/admin-boot-test.js` → **`TOTAL 164 · PASS 164 · FAIL 0`, exit 0** (was `148`). Both re-run
*after* the last edit in this round, not carried over, and `node --check` is clean on every touched
file.

### 1. Previewing the digest — 9 new engine tests, 3 new harness checks

A daily 06:00 job nobody can watch, and "what will it say?" was unanswerable from the dashboard.
`netlify/functions/roommate-digest-preview.js` composes the **same** message — it imports
`collect()` / `digestText()` / `worthSending()` from `roommate-digest.js` rather than reimplementing
them, so the preview cannot drift from the send. The engine tests assert exactly that: the preview's
text is byte-compared with `digestText(await collect(now))` for the same instant.

It can never send, and the proof is structural: the file imports **no** `sendAlert` at all, so an edit
would have to add the import before the button could page anyone. The engine tests capture the
Telegram stand-in and assert zero sends on every path, including the read failure — which is reported
to the person who asked instead of being escalated, because a human poking a button must not be able
to page the team at 02:00. That matters: the *scheduled* job escalates the identical failure.

The gate is server-side and role-aware:

- **POST only** — a session token never travels in a URL (asserted: GET answers 405).
- `/auth/v1/user` proves the JWT is a live session; an unrecognised token is refused even though the
  anon key decodes it (asserted).
- `POST /rest/v1/rpc/arzuz_role` returns the role **Postgres** computes from that JWT, so the browser
  can neither claim nor choose one, and the check runs **before** any roommate read — the test asserts
  a marketing login is refused **with no student in the response body**, i.e. no pool row left Supabase.
  Only `admin` and `support` are allowed, matching the policies in `supabase-roommate.sql`.
- Per-instance rate limit (12 a minute), asserted by hammering one caller.

The dashboard control (`#btnDigestPreview` in the Roommate panel) shows the message **as text, tags and
all** — deliberately not rendered as markup, because the message is HTML for Telegram and injecting it
would make a student-typed name a markup sink; the harness asserts the tags are visible as characters.
The note under it says what the 06:00 job would do right now (`would_send`), the window, the pair
counts and the role it read them as, so "nothing needs attention" is visible rather than inferred from
an empty list.

**The bug this round found.** The dashboard's existing 401/403 convention (sign out, from `fetchData`)
was applied to this endpoint too — but PostgREST answers 403 only for a *missing grant*, which really
is a broken login, whereas this function answers 403 for **a valid session whose role may not read the
digest**. Passing that to `onAuthError` would have logged a signed-in colleague out for opening the
wrong screen. Only 401 signs out now; 403 is shown as a plain refusal. Verified in the browser by
stubbing the endpoint: with a 403 the session in `sessionStorage` **survives** and the modal shows the
refusal, with a 401 it is **cleared** — both read back from the live page.

Browser walk at `?mock=1` (dev server 8131, stopped afterwards; 8123 untouched): the panel renders the
button, the modal opens, and the composed message appears verbatim with the note — *"The 06:00 job would
send this now. Window: last 24 hours · 0 stalled matches · 7 questionnaires, 1 matches · your role:
admin."* A 502 is reported as *"Could not compose the digest: …"* with the note switched to *"The digest
could not be composed. Nothing was sent."* — the note used to keep saying *"reading the tables"* under a
failure message, which contradicted itself on screen. Console clean throughout.

### 2. The record as a file — 6 new harness checks

`#btnExportDossier` writes one **JSON** file (not CSV: CSV cannot hold the two halves of the
questionnaire without flattening which question an answer belonged to, and an archive that loses that
is not an archive). The envelope carries the format version, the export time, the student, their
answers and deal-breakers, **both directions** of every decision as separate rows, their matches, the
whole trail, and the append-only note. Every name in it is the snapshot stored on the record rather
than a fresh lookup, which is why it survives a profile being deleted — and that is the point of an
archive, not a detail.

The builder (`window.arzuzDossierExport`, exposed so the harness drives the same function the button
calls rather than a copy in the test) is fed `state.dossier`, which is filled from the two by-id reads
the screen just rendered — **not** from panel state. The checks say so: the exported student is the one
on screen, the decision and event counts equal that student's, a second student's events are absent,
and with no dossier open the click downloads nothing. The load token guard is what makes that hold
when a slow earlier dossier click lands late.

Browser walk: the real button was clicked with `URL.createObjectURL` and
`HTMLAnchorElement.prototype.click` captured in the live page — one download, `application/json`, 3,483
bytes, filename `arzuz-consent-grace-2026-10-09.json`, and the parsed payload is valid JSON with 15
answers, 2 decisions, 1 match and 5 events whose ids are **all Grace's** — no other student appears in
it.

### 3. Why they are still waiting — 7 new harness checks

The panel said who is waiting; it did not say **why** nobody has been matched with them, and the two
honest answers are different problems: the pool has nobody suitable, or the students have not chosen
each other. Only the first is solved by finding more rooms. The block breaks the pool down by area and
by budget band (count, matched, rate, and the **median** wait — a mean lets one student who answered in
October and matched in January move the headline), then names every waiting student the engine would
not put in front of anyone, with the wall counted by reason: by gender, by a deal-breaker, or with too
little in common to call.

"Nobody suitable" is computed with the **shared scorer** (`window.ArzuzMatch.eligible`), the same call
the server makes before it shows a card, so a student named here is one the engine would not show
either. The checks pin that: the students named are the ones the engine says are stuck, a student who
*does* have a partner is never reported, an area row counts the dataset rather than a number written by
hand, and every stuck row carries a reason with its count. Both caps are honest on screen: the pairwise
check stops at `COHORT_WAIT_MAX` (40) and says so when it bites, and the block states that it is built
from the panel's capped pool read rather than being an audit of it.

**Cost, measured rather than assumed.** The pairwise loop is `waiting × others` `eligible()` calls — at
the 40-student cap that is 1,560 calls, timed in the browser at **~4 ms** (warmed, best of 7; below
timer resolution at the mock's 6 waiting students). Re-rendering the whole pool panel with the stall
block, on a cached route switch with **zero** network calls, measured 23–137 ms across five runs with
no long tasks — so the spread is DOM and layout, not the scan, and the cap is headroom rather than a
fix for a slow page. Browser walk: area rows (Malete 6 students · 33% · typically 0.1 days), budget
bands, and three students with "all 5 other waiting students are filtered out — 3 by gender, 2 by
deal-breakers", each with its own dossier button.

### Limitations of this addendum

- **The digest preview has never run against real Supabase.** The role check is exercised against a
  stand-in that answers `/auth/v1/user` and `/rest/v1/rpc/arzuz_role`; `public.arzuz_role()` itself is
  still unexecuted — no Postgres here. Until it is, a preview from a real admin session depends on
  that function being deployed, and a missing one reads as "refused role" (403), not as success.
- **The 429 ceiling is per instance.** Like `notify.js`, a cold Netlify instance starts with an empty
  window, so the limit is a courtesy to Supabase rather than a guarantee.
- **The export is a file, not a submission.** Nothing sends it anywhere; a reviewer receiving one gets
  an unsigned JSON document, so it proves *what the database held* and not *who exported it*. The
  export timestamp and the record ids are the only provenance in it.
- **The stall block's own numbers were not reconciled against SQL.** They are computed client-side from
  the panel's capped read; a direct `count(*)` grouped by area is the thing that would settle them,
  and that needs a database.
- **`netlify.toml` is still not machine-validated** (no `netlify` CLI in this workspace) and no message
  has been delivered to a real Telegram chat.
- Pins bumped: `admin.js?v=18`, `admin.css?v=8` (`admin.html`).

---

## Addendum — the printed dossier, the daily digest, and the follow-through signal (2026-10-09)

`node dev/admin-boot-test.js` → **`TOTAL 148 · PASS 148 · FAIL 0`, exit 0** (the `133` in the addendum
below is what it reported before this change). `node scripts/test-roommate-score.mjs` → **`63 passed,
0 failed`, exit 0** (was `51`). Both re-run after the last edit, not carried over.

### 1. The dossier on paper — 8 new harness checks

The record has to be able to leave the browser: attached to a ticket, or printed and read out to
whoever phoned. `#btnPrintDossier` adds `printing-dossier` to `<body>` for the life of the print
dialog, and `@media print` in `assets/admin.css` hides every other child of `<body>`, makes the
overlay static, drops the close button / explainer / action row, and re-inks the sheet black on white
with a provenance line (`#dossierPrintMeta`: student, timestamp, and the note that no login can change
or delete a line).

Three files have to agree for that to work, and a rename in any one of them fails **silently** — the
entire dark dashboard prints instead — so all three are asserted rather than left to a look:

- `admin.html` contains `id="btnPrintDossier"` and a `class="print-only" id="dossierPrintMeta"`
- `admin.css` contains both `body.printing-dossier #dossierModal` and the
  `body.printing-dossier > *:not(#dossierModal)` isolation rule
- clicking it calls `window.print()` once, the class lands on `<body>`, the provenance line names the
  student, and the class comes back off on `afterprint`
- the control is **not** inside `#dossierContent` — the part that is printed

`window.print` is stubbed in the sandbox (`makeSandbox` records the call): printing is a browser action
the shim cannot perform, and without the stub the click would throw. The mutation was checked — renaming
`printing-dossier` in `admin.js` + `admin.css` turns exactly the two contract checks red, and they go
back to green on restore.

**Verified in a real browser** at `?mock=1` (dev server on 8131, stopped afterwards; the pre-existing
8123 was left alone). `window.print` was stubbed in the page so no native dialog could block the read;
the real button was then clicked and, for the rendering check, the stylesheet's `@media print` rule was
retargeted to `screen` in the live page (`CSSMediaRule.media.mediaText`) so the print sheet could be
looked at without editing a file. On paper the record renders white with black text, the provenance
line at the top, no chrome and no action row; the whole consent trail keeps its boxes and readable
tags (`VIEWED` / `ACCEPT` / `MATCHED` / `CREATED`); with the class removed and the media restored, the
screen is dark again and the console is clean.

### 2. The follow-through signal — 1 new harness check, 1 new engine test

A match handed two students each other's number and nothing recorded whether either of them came back
for it. `roommate-match.js` now appends a `viewed` row the first time a matched student is shown a
match (`noteViewed`) — **one row per pair**, because the existing rows are read first and only unseen
pairs are written. A reload writes nothing: otherwise the trail fills with page views and the question
it is asked (has this pair been looked at *yet*) becomes unanswerable. It is written after the trimming,
so the trail records what the student was actually shown, and the subject name comes from the profile
row (the stored name), not from the card's first-name-only copy.

The event is on the same append-only record on purpose — "was my number ever put in front of them, and
when" is part of the answer a disputed unlock asks — so `supabase-roommate.sql` widens the CHECK to
include `viewed` **and re-states it** (`drop constraint if exists` + `add constraint`): `create table if
not exists` is a no-op on a database that already has the table, and without that an existing install
would reject every `viewed` write with a 23514 and the only symptom would be a log line plus a digest
that never has a signal. §7 gained the query that proves it.

### 3. The daily digest — 11 new engine tests

`netlify/functions/roommate-digest.js`, scheduled in `netlify.toml` (`[functions."roommate-digest"]
schedule = "0 6 * * *"` = 07:00 Lagos). Once a day: the last 24 hours of the trail, the pool's one
number, and every **production** pair matched more than `FOLLOW_UP_DAYS` (3) ago where *neither* side
has done anything since the unlock. Anything at all by either student counts as follow-up — a student
who came back and passed on somebody else has not abandoned the exercise — and the `matched` row
itself never counts, because it is the unlock rather than a response to it.

The tests drive it at chosen instants instead of waiting for morning: the 24-hour window counts only
what is inside it (a 30-hour-old questionnaire is not reported twice), a pair nobody opened is named
with its age, a pair **both** sides opened is not chased, a pair only one side opened is a footnote,
a brand-new match is left alone, the run sends exactly one message through `notify.js`, a quiet day
sends **nothing**, a student-typed name arrives escaped, and with no token nothing is attempted and the
handler does not throw. The stand-in grew the two views the digest reads (`roommate_mutual_pairs`,
`roommate_engine_summary`, derived the way §6 derives them) and real `gte`/`lte` range filters — a
fake that quietly filtered nothing would have passed the window test for the wrong reason. The digest
is loaded as a **cold instance** (its `notify.js` entry is dropped from the require cache) because the
flood test above has just filled the per-instance 30-a-minute ceiling, which a 07:00 cron does not
inherit.

### Limitations of this addendum

- **Nothing was printed.** No PDF and no native dialog: the sheet was verified through the stylesheet
  retargeted to `screen`, with `window.print` stubbed. Page-break behaviour (`break-inside: avoid` on a
  trail line, a decision, a pair) is therefore reasoned, not observed.
- **The cron is not machine-validated.** There is no `netlify` CLI, no Python and no network in this
  workspace, so `netlify.toml` was not parsed by a TOML reader — the four lines follow the documented
  `[functions."name"] schedule = …` shape and were re-read by eye. A missing schedule is silent: the
  function still deploys and simply never runs.
- **The digest has never sent a real message.** Delivery is asserted against captured sends, exactly
  like the per-event alerts. Its schedule, its `included_files` bundling and its cold-start behaviour
  on Netlify are unobserved.
- **The new CHECK constraint is unexecuted.** As with everything else in `supabase-roommate.sql`, there
  is no Postgres in this workspace: the re-runnable constraint change and the `viewed` writes are
  desk-checked against the table definition, and §7 is the query that settles it.
- `roommate_mutual_pairs` gained a trailing `env` column so the digest can exclude test pairs. The
  `create or replace view` only allows a new column at the **end** of the list, which is why it is
  there rather than next to `matched_at`.

---

## Addendum — the student dossier (2026-10-09)

The suite now reports **`TOTAL 133 · PASS 133 · FAIL 0`, exit 0** — the `116` in the addendum below is
what it reported before this change. Seventeen checks were added for the dossier, which opens from
the pool, either side of a matched pair, or the partner link inside another dossier:

- it renders for a **matched** student — the case that matters, because their side of the pair has
  left the open pool, so a dossier assembled from panel state would come up short on exactly the
  student someone is asking about
- the student is named, with their own number
- their answers render through the **shared** vocabulary (`assets/roommate-score.js`, now loaded by
  both `admin.html` and this harness), and every ticked deal-breaker appears verbatim
- **both directions** of every decision are separate lines — that is what a double opt-in is — and
  the count matches the dataset, not the feed
- the match is shown with the partner named
- the trail is the **by-id history**, not the capped feed: the count matches the dataset, a
  **subject-side** event is included (Grace's `matched` line exists only as the subject — Halima
  completed the pair), and an unrelated student's events are absent
- a student with no decisions gets an empty-state note rather than a blank section
- it renders **no write control** (`data-act="pair"`, `del`, `edit`, `<input`, `<select`), and closing
  it clears the modal

The harness cannot reach one thing, and it was verified in a real browser instead: the `×` and
backdrop close are wired by an **inline script in `admin.html`**, which `runScripts` does not execute.
Both the `×` and a live click of `Dossier → Halima` inside Grace's dossier were driven against
`?mock=1` on a real page, with a clean console.

---

## Addendum — the consent trail and the team's alerts (2026-10-09)

The suite now reports **`TOTAL 116 · PASS 116 · FAIL 0`, exit 0** — the `107` in the addendum below
is what it reported before this change. Nine checks were added for the append-only consent trail
rendered under the pool, seeded from `roommate_events`:

- the heading counts the **production** events only; an `env=test` event is seeded specifically so
  the trail read's own env filter is *proven* — the count is asserted from both sides
- an event of every seeded kind (`created` / `accept` / `pass` / `withdrawn` / `matched`) renders a
  line, and the tag carries the **raw** event name so a rendered line can be grepped for verbatim
- the `matched` line says what it unlocked and names the student who completed the pair
- a withdrawal is on the record
- the trail renders no write control — a stronger guarantee than the pool's, because the database
  grants no client role insert, update or delete on that table at all

The mock refuses a non-GET on `roommate_events` outright instead of falling through to the generic
table handlers. With the generic path a dashboard bug that tried to rewrite history would have
passed the harness.

`node scripts/test-roommate-score.mjs` is now **50 passed, 0 failed** (was 37). It gained the trail
and alert coverage, including the check that makes the two tables disagree on purpose: accept then
pass leaves **two** trail rows and **one** interest row, which is the entire reason the trail exists.

Two defects the new tests caught, both fixed in the source rather than in the test:

- **a repeated acceptance re-alerted the team.** Tapping accept again on an already-matched pair
  re-patched both profiles, appended a second `matched` line and sent a second Telegram alert.
  `actionDecide` now reads the student's own prior decision *before* the upsert, so the match side
  effects fire on the transition into mutual and never again afterwards.
- **the stand-in Supabase stored only `payload`.** `first_name` is a `GENERATED` column in the real
  table, so it was `undefined` here and every trail line and alert read "Student". The stand-in now
  computes the generated columns the way the table does, so a naming bug can no longer pass in the
  harness and fail in production.

---

## Addendum — questionnaire pool in the Roommate panel (2026-10-09)

The report above is the 2026-10-06 rework, unchanged, and its `95 / 95` figures are what the suite
reported then. The suite now reports **`TOTAL 107 · PASS 107 · FAIL 0`, exit 0**.

Twelve checks were added for the questionnaire-backed block in the Roommate panel (fed by
`roommate_profiles` / `roommate_interests` / `roommate_engine_summary` / `roommate_mutual_pairs`,
supplied by an extended mock):

- the engine metric cards render and their numbers equal the seeded `roommate_engine_summary`
- the "waiting in the pool" count equals the open **production** profiles — a `env=test` profile is
  seeded specifically to prove the filter, and a check fails if its name reaches the panel
- a mutual pair renders an intro link to **both** students, labelled with the other student's name
- deal-breakers render where a student set them
- **consent guard:** the pool block renders no `data-mate="pair"` button — a dashboard click must
  never overrule a double opt-in
- the panel is never rendered at all for the `support` or `marketing` logins

The mock returns `200 []` rather than `403` for the two tables under a non-admin login, which is
what PostgREST actually does when RLS filters every row (a 403 means a missing grant, which is a
different bug) — and `fetchData` treats 403 as a dead session and signs the user out, so a 403 here
would have been actively destructive. `admin.js` therefore requests the pool for `admin` only.

`strategy.js` (student-facing, byte-locked) was **not modified** — its emoji output is swapped at the presentation layer by `ArzuzUI.deEmoji` (DOM text-node surgery) plus `armDeEmoji` (MutationObserver catches docs painted asynchronously).

## 2. Automated coverage — 95 checks

Per role (admin / support / marketing):

- Boot with no console errors; gate hidden when mock session accepted
- Role landing page (admin→Overview, support→Support Desk, marketing→Growth)
- Every allowed route renders without console errors
- **Nav/section collision guard:** sidebar buttons also carry `data-section`; the suite spies on every `document.querySelector` call and fails if admin.js ever queries a bare `[data-section=…]` (regression: growth markup once rendered *inside the nav button*)
- Growth/Strategy rendered chrome contains no emoji glyphs
- Overview metrics trace 1:1 to the mock dataset (incl. roommate SQL-view %)
- Table row counts match dataset (test-env rows excluded)
- Details / Edit / Delete modals open for every table
- Delete type-ID confirm: wrong code rejected, right code enables button, delete removes the row
- Add-apartment insert path, plus the cancel/keep/discard triad (see §12)
- CSV export, phone-ticket insert, team roster + create, amenities manager, telegram status
- REST-failure scenario surfaces without boot crash

## 3. Visual walk (preview browser, 1440×900 desktop + earlier 375px mobile pass)

| Surface | Result |
|---|---|
| Overview | Metric cards, grouped nav, attention states, MOCK DB badge ✔ |
| Listings toolbar | status select fixed (was stretching full width) ✔ |
| Listings table | semantic table, status dots, draft badges, missing-ask chips ✔ |
| Details modal | two-column field grid, ACTIVE dot badge, amenity chips ✔ |
| Edit modal | two-column form; locked-ask checkbox now inline label ✔ |
| Delete modal | type-ID confirm; wrong input disabled button, correct code deleted row (8→7) ✔ |
| Draft invite modal | link, Copy/WhatsApp/Open actions ✔ (opened via the WA/draft action; the "Link" button copies the link without a modal — as designed) |
| Growth | traction cards, funnel, channels, budget bands, all-SVG action rows ✔ |
| Strategy | doc list + reader, markdown rendered, privacy note with lock icon ✔ |
| Support Desk | ticket table, SLA emphasis, action buttons ✔ |
| Roommates | 67% match metric, mate cards, candidates toggle, intro links ✔ |
| Settings | role cards, team roster, amenities ✔ |

Recorded walkthrough: [dev/screenshots/admin-walkthrough.webm](screenshots/admin-walkthrough.webm) (Overview → Listings → Growth → Strategy → Support Desk → Roommates → Settings).

## 4. Bugs found & fixed during verification

1. **Status filter stretched full-width** — `arzuz.css` sets a global `select { width:100% }`; `.search-box select` now resets to `width:auto; flex:none; max-width:220px`.
2. **Growth rendered inside the sidebar nav button** — nav items carry `data-section`, and the unscoped `[data-section="growth"]` query matched the nav button first. Render targets are now scoped to `.section-view[data-section=…]`; boot test guards the selector with a query spy.
3. **Strategy doc stuck at "Loading…"** — `deEmoji` originally rewrote `root.innerHTML`, detaching the pane that the async `paint()` callback held. Now does in-place text-node surgery (never replaces subtree), plus a debounced MutationObserver re-swaps emoji that arrive in later paints.
4. **Roommate cards had no styles** — `.mate-card/.mate-head/.mate-meta/.mate-actions/.mate-cands/.mate-cand` were missing from the rebuilt admin.css; added a proper card block (section 7b).
5. **Locked-ask checkbox floated detached** in the edit modal; wrapped with its label as `.ask-unlock` (flex row, accent purple).
6. **MOCK DB badge** — the env badge said "PRODUCTION DB" under `?mock=1`; the harness now relabels it to a warning-styled "MOCK DB".

## 5. Known non-issues

- One early amenities fetch still escapes to real Supabase before the wrapper installs on first load; the harness immediately re-fetches through the mock, so data stays mock. Harmless read-only, logged for awareness.
- `draft-copy` intentionally shows no modal (clipboard copy); `draft-wa` opens the invite modal.

## 6. Reproduce

```bash
cd arzuz-site
python3 -m http.server 8123          # server
# open http://localhost:8123/admin.html?mock=1   (localhost-only guard)

node dev/admin-boot-test.js          # 90/90 headless suite
```

Scenario switching from the console: `__MOCK__.role('marketing')`, `__MOCK__.empty()`, `__MOCK__.slow(1200)`, `__MOCK__.error('rest')`, `__MOCK__.reset()`, `__MOCK__.stats()`.

## 7. Version pins (cache-bust)

`admin.css?v=3` · `admin-ui.js?v=3` · `admin.js?v=8` — bump on any further edit.

---

# Round 2 — the apartment composer (2026-10-08)

The Add/Edit apartment surfaces were rebuilt as a three-tab instrument (Property & Pricing ·
Location & Access · Media & Draft), keeping the flat grid for the other tables.

## 8. Automated suite

`node dev/admin-boot-test.js` — **95 / 95 PASS** (the original 90 checks plus five that pin down the
composer's exit path; see §12).

## 9. Browser walk (dev server + `?mock=1`)

| Surface | Checked |
|---|---|
| Tabs | Add modal opens on *Property & Pricing*; the other two panels stay `hidden` and keep their controls in the DOM |
| Amenity combobox | typing filters the shared list, ArrowDown highlights, Enter adds a preset; an unknown word creates a **custom** chip; ✕ removes a chip |
| Availability | segmented *Vacant units* / *Fully occupied* hides the unit count and stores `avail`; payload `rm` becomes “3 rooms available” / “Fully occupied” |
| Unified map | the map builds when the tab is first revealed; **[Pin location \| Draw path]** toggles leaflet's trace mode; a 3-point trace is simplified to a stored `route` (2 pts) and **`pin_meta.source` survives the linger** (it used to be overwritten by the trace commit) |
| Media queue | a picked photo appears in the staging grid with a **live %** (20 → 40 → 60 → 80 → committed), the ✕ removes it, ★ sets the cover, the hidden `add_photo_url` stays in sync; a failed upload stays on screen as *Failed — remove* with “0 uploaded, 1 failed” |
| Cancel | a dirty form opens **Unsaved changes** → *Save to draft* inserted `status='draft'` with token + permission + 7-day expiry and opened the share panel; *Discard* and *Keep editing* do what they say (see §12) |
| Draft link | switching to **Public view only** + *After 24 hours* PATCHed the row and re-rendered the panel (“Currently: View only · expires 09 Oct 2026”); the listings table badge reads *view link sent* |
| Edit modal | same three tabs; role/units/availability/amenity chips/access-notes pre-filled; the stored route is restored into the trace editor (“2 pts”); saving wrote `avail`, `rm`, `contact_role`, `passage.landmark` and preserved the route |
| complete-listing | permission `view` → `body.cl-view-only`, inputs disabled, upload + gallery + save hidden, “Your apartment details” copy, read-only route map; permission `edit` → expiry banner, editable form, upload zone and save button; the landlord save still PATCHes through the RPC stub |
| Missing migration | with the insert forced to fail with `PGRST204 draft_permission`, the composer retried without the two columns, created the draft, opened the share panel and toasted “run supabase-draft-sharing.sql” |

## 10. Notes / limitations

- The dev server (`dev/upload-mock-server.mjs`) answers `/api/cloudinary-sign` with 503, so the
  photo *success* path was verified against a stubbed XHR/signature; the real failure path was
  verified unmodified.
- YouTube upload could not run locally (`GOOGLE_*` not configured) — the code fell back to
  Cloudinary exactly as designed.
- View-only / expiry enforcement is server-side in `supabase-draft-sharing.sql`; until that file is
  run against the live project the controls save but are not yet enforced (the dashboard says so).

## 11. Version pins

`admin.css?v=5` · `admin-ui.js?v=5` · `admin.js?v=12` · `arzuz-map.js?v=3` (every page that loads
it: admin, browse, complete-listing, listing, owner-list, scout) · `complete-listing.js?v=3`.
Round 3 moved `arzuz-map.js` 2 → 3 (the pin-fabrication fix is in `pinCapture`, so every page
needs it) and `complete-listing.js` 2 → 3.

## 12. The exit path — a real bug found by re-walking it

A second pass over **Cancel → Unsaved changes** found that *Discard* and *Keep editing* could leave
the overlay on screen. The handler was never at fault (`closeModal()` was called for both overlays
and the “Changes discarded.” toast fired); the close itself was. `ArzuzUI.closeModal()` removed
`.open` **only** from the `animation.onfinish` callback, and in a document that is not painting
frames (backgrounded tab, headless renderer) that callback is deferred indefinitely — the animation
reports `finished` while `.open` stays on the element forever. A confirm dialog whose buttons do
nothing is a functional dead end, so the fix is in `admin-ui.js`:

- `closeModal()` now removes `.open` from the callback **and** from a 300 ms timer, with a token so a
  re-open inside that window cannot strip the class off a freshly shown overlay (`popIn`/`trapFocus`
  bump the token).

Verified in the preview browser (`?mock=1`, 1440×950), each step awaited past the 180 ms close:

| Step | Result |
|---|---|
| Clean form → **Cancel** | composer closes, no prompt |
| Edit a field → **Cancel** | *Unsaved changes* opens above the composer |
| **Keep editing** | prompt closes, composer + typed value intact |
| **Discard** | both overlays close, toast “Changes discarded.”, nothing written |
| Re-open → **Cancel** | clean close, no prompt (`dirty` flag reset) |
| Re-open | lands on *Property & Pricing* with area/media/chips/`add_photo_url` empty, availability back to *Vacant* |

Locked in by five new suite checks. The shim's `animate()` never fires `onfinish`, which is exactly
the failure mode, so the checks fail loudly if the fallback is dropped — confirmed by deleting the
`setTimeout(finish, 300)` line: `95 → 92 PASS`, with `cancel: “keep editing” returns to the form`,
`discard: closes both overlays without an animation callback` and `discard: resets the dirty flag`
all reporting `add open=true exit open=true`.
---

# Round 3 — the landlord invite form (2026-10-08)

## 13. The other form: `complete-listing.html` rebuilt to the same spec

`complete-listing.html` is the landlord's end of the same workflow — the page behind
`arzuz.com/complete-listing?ref=<draft_token>` — and it had been left on the old layout that the
composer rework replaced: one endless scroll, a `Negotiable?` select, a free-text “rooms available”
box, two name fields plus a “who runs the compound?” select, a fixed grid of amenity buttons, a map
that could only drop a pin, four separate landmark/gate/stairs answers, uploads that fired the moment
a file was picked, and a single `Send to Arzuz` button with nothing to catch a half-filled form. Two
of the same fields, two different vocabularies.

It now runs the same composer: **the same three tabs, the same field set, the same components.**

| Spec item | Admin composer | Landlord invite form |
|---|---|---|
| 3 tabs | Property & Pricing / Location & Access / Media & Draft | identical labels, same order |
| Apartment name | optional, `autoAptTitle()` + `name_generated` | same helper, same flag; a generated title is offered as the **placeholder**, not as text to clear |
| Pricing | Rent + Opening Ask, **no Negotiable** | same two fields (`ask` reaches `opening_ask_ngn` only while that column is empty); `neg` is never written by either form |
| Contact | Contact Person + Phone/WhatsApp + Role | same three fields, same four roles (`Landlord · Caretaker · Agent · Admin`) |
| Availability | `data-seg` toggle + unit count | same seg, same `avail` / `units` / `rm` payload keys |
| Amenities | searchable combobox + custom tags | same component (presets from `UTILITIES`, typed tags marked `custom`) |
| Map | one map, `[Pin · Draw path]` seg | same widget, same seg, trace-id overrides so the two maps can coexist |
| Directions | one *Access & Navigation Notes* textarea | same field → `passage.landmark` |
| Media | staging grid, ✕ remove, ★ cover, compression, % per file | same grid, same compression, same percentage bars, photos **and** video |
| Video | drop zone **or** URL embed | both, plus the YouTube poster frame in the tile |
| Exit | Cancel → Save to draft / Discard / Keep editing | Discard changes → Save draft & close / Discard changes / Continue editing |
| Draft links | permission + expiry panel (Viewer / Editor / 7 days) | the holder's side of it: expiry banner, `view` locks the page, `edit` stays open |

Two deliberate differences, both because the two people are not the same person:

- **Opening Ask** is written to the column only while it is empty, so a landlord cannot overwrite the
  number the team recorded from its own field notes — that number is the metric the whole business
  case rests on.
- **Save draft** on the landlord page sends `save_mode: 'progress'`, which the write RPC consumes (it
  is not on the whitelist, so it never reaches the payload) to leave `draft_completed_at` alone. A
  half-filled form no longer shows up as *Landlord completed*, which is what `draft_completed_at`
  means in the ops panel, the draft counters and the row detail.

### The bug this round found: a pin nobody placed

Both composers seed the shared map at the town centre (`MALETE`) when a row has no coordinates, and
`pinCapture` was *committing* that seed as `source: 'tapped'`. So simply opening the Location tab
wrote a real pin into the payload. Worse, `assets/app.js` (the owner and scout wizards) invented the
same coordinates during validation:

```js
if (type === 'pin') {
  if (req && !F.answers.lat) { F.answers.lat = 8.7113; F.answers.lng = 4.4697; … }
```

Every owner or scout submission without a pin was filed in the middle of Malete, and every listing
pinned that way fed a fabricated walking distance into the browse and listing pages.

Fixed at the source:

- `arzuz-map.js` tracks `pinned` — set only by a saved pin, a tap, a drag or a GPS fix. Until then
  the marker is a handle parked on the map centre, the host's fields stay empty, and nothing is
  reported. Tracing a path with no pin reports the **route alone** (`onRoute`), so a real walk path
  is never mixed with invented coordinates.
- `app.js` blocks the step with a real message instead of inventing a location: “Drop the pin on your
  gate to continue — tap the map, drag the marker, or press “Use My GPS” while you stand there.”
- `admin.js` (Add + Edit) and `complete-listing.js` implement `onRoute`, keeping the route without a
  position.
- The landlord page no longer carries `cl_lat` / `cl_lng` / `cl_pin` / `cl_pin_meta` hidden inputs at
  all — the map writes straight into the payload.

Verified in the browser on both forms: mounting the map writes nothing; a real tap writes
`source: 'tapped'` with the tapped coordinates; a payload saved with no map interaction contains no
`lat`, `lng`, `pin` or `pin_meta` key.

### How it was walked

`dev/complete-listing-harness.html` boots **the real page** — same markup, same scripts, fetched and
written into a dev-only document — after pointing `SUPABASE_URL` at the dev server's mock RPC routes
(`dev/upload-mock-server.mjs` gained seed / `listing_draft_get` / `listing_draft_update` /
`last-patch` under `/mock/sb/…`) and swapping `XMLHttpRequest` for a stub that reports real progress
ticks, so the tiles run 8 % → 51 % → 74 % → 93 % → 100 % instead of dying on the deliberate 503 from
`/api/cloudinary-sign`.

```bash
node dev/upload-mock-server.mjs 8799
# ?seed=blank | existing | generated   ·   ?perm=view   ·   ?ref=<uuid>
open http://localhost:8799/dev/complete-listing-harness.html?ref=11111111-1111-4111-8111-111111111111&seed=blank
```

| Walk step | Result |
|---|---|
| Boot, `seed=blank` | three tabs, *Property & Pricing* active, other two panels `hidden`; Discard disabled while clean |
| Tab 2 revealed | Leaflet builds into a visible container; no pin committed (`lat` / `lng` empty, badge still prompting) |
| `Pin location ↔ Draw path` | trace bar shown in Draw mode, hidden back in Pin mode |
| Tap the map | badge + `pin_meta {source:'tapped'}` written |
| Amenity combobox | presets listed, `Solar panels` added as a preset chip, `Roof water tank` created as a `custom` chip on Enter, ✕ removes |
| Photo staging | tile appears **before** upload (`Queued`), then 8 → 51 → 74 → 93 → 100 %, tile becomes committed with ★ Cover photo |
| Cover / remove | ★ on the second photo re-orders `MEDIA`; ✕ drops the tile and re-syncs `cl_photo_url` |
| Video | third tile renders the real `i.ytimg.com` poster frame from a pasted YouTube link |
| Send with no map use | payload has **no** `lat` / `lng` / `pin` / `pin_meta`; auto title `Self-contain in <area>`, `name_generated: true` |
| Save draft | `save_mode:'progress'`, `draft_completed_at` stays null, toast + “Progress saved” note, form stays open |
| Send to Arzuz | `save_mode:'send'`, `draft_completed_at` set, done screen, Telegram payload |
| Discard changes (dirty) | modal opens → **Continue editing** keeps the typed value → **Discard changes** re-reads the row and puts the form back, Discard disabled again |
| `seed=existing` + Send | legacy `who:'A caretaker'` → role *Caretaker*; `units` 3; `passage.landmark` → notes field; the 3-point traced route **survives a save that never touched the map** |
| `seed=generated` | name box empty, generated title shown as the placeholder, re-saved with `name_generated: true` |
| `perm=view` | `body.cl-view-only`, inputs disabled, save/draft/discard + drop zones + URL row hidden, map rendered read-only with the route polyline, tiles carry no ✕/★, copy switched to “These are the details Arzuz recorded…”, badge shows the recorded coordinates instead of an impossible instruction |
| Phone width (420 px) | all three tabs on screen (grid, wrapping labels, no horizontal scroll), seg full-width, media grid 2-up, actions wrap sensibly |

### Sibling sweep (one vocabulary everywhere)

- `owner-list.html` — `Negotiable?` removed (the spec says remove it completely), the “who runs it”
  answer set is now the four roles, and the rooms field is labelled “Vacant rooms right now (0 if the
  place is full)”. Its pin step no longer invents coordinates.
- `scout.html` — a scout report is hearsay by nature, so its `who` answers stay as written; the
  composer maps *The owner / A caretaker / An agent* onto the role vocabulary when it reads them.
- `browse.html` — the card said `per session · negotiable: ask us`; since no listing can be marked
  negotiable any more, the line is now just `per session`.
- `listing.html` — keeps its conditional `Negotiable:` chip for rows that already carry the value
  (legacy, read-only) and drops it for everything new.
- `netlify/functions/notify.js` — the Telegram templates no longer print a `Negotiable:` line; they
  print availability, and `contact_role` instead of the old `who`.
- `supabase-draft-sharing.sql` **and** `supabase-drafts-support.sql` — the same whitelist in both
  (`name_generated`, `ask`, `avail`, `units`, `contact_role`, `access_notes`), `ask` → the column
  while it is empty, `save_mode:'progress'` leaves `draft_completed_at` alone. Running only one of the
  two files can no longer silently drop a field the forms send.

### Limitations

- The signed-upload **success** path cannot be reached from the dev server (`/api/cloudinary-sign` is
  a deliberate 503). The failure path is real and was verified (staged tile → *Failed — remove*, with
  its ✕ and the untouched preview); the success path rides the harness's stub.
- `supabase-draft-sharing.sql` has **not** been run against the live project, so view-only/expiry
  enforcement plus the new `ask` / `save_mode` behaviour stay inert in production until it is.
- `beforeunload` (the unsaved-changes guard on the landlord page) could not be exercised in the
  attached browser: dispatching `beforeunload` from the console hangs the renderer, which is the same
  machinery the real dialog uses. Code-reviewed only; it arms only while `dirty`.
- No real-device pass on a phone; the mobile checks above are at a 420 px viewport.

### Worst-case data — the `break-ui` pass

The invite form was then fed one worst-case row (`?seed=worst`): a 62-character lodge name, `Ọ̀pẹ́ Ọ̀gá Area 🏠` for the area, `Alh. Abdulrahman ‘Ọ̀gá Àgbà’ Kareem-Olaniyan` for the contact, `+234 803 345 5667`, ₦1,250,000 rent *and* ask, **0** vacant units, a 1,578-character description, twelve amenities (one a case-duplicate of a preset, one 51 characters long), a three-line note and 40 media items — 38 photos, a `youtu.be` share link and a Google Drive file URL. The dev toggle now has four states: **Demo · Worst · Empty · One**.

| Break | Severity | Worst-case value | What happened | Fix |
| --- | --- | --- | --- | --- |
| Media panel overflowed its card | **Broken** | 40 tiles | At ≤330 px `repeat(auto-fill, minmax(118px, 1fr))` gave `.cl-stage` a 246 px min-content inside a 231 px track, so the whole `.cl-grid` track grew to 273 px: the page scrolled sideways (`scrollWidth 312` vs `clientWidth 309`) and the drop zone was clipped. Only visible on the media tab — which is why the earlier 320 px pass missed it | `minmax(0, 1fr)` tracks + `minmax(min(104px, 100%), 1fr)` tiles — [complete-listing.html:29](complete-listing.html#L29), [:134](complete-listing.html#L134) |
| `0` vacant units saved as *“Units available”* | **Broken** | `0` | `parseInt('0')` failed the `> 0` test → `units: null`, `rm: "Units available"`, `avail: "vacant"`. A fully let lodge advertised as free. `-5` behaved the same, `2.7` silently became `2` | An explicit zero is kept and stored as `avail:'occupied'` / `rm:'Fully occupied'`, with a note under the box; `> 999` is capped with its own note — [assets/complete-listing.js:803](assets/complete-listing.js#L803) |
| A pasted link that cannot play became a dead tile | **Ugly** | `drive.google.com/file/d/…/view`, `vimeo.com/76979871`, `not-a-video.example.com/photo.jpg` | The guard was a bare `^https?://`, so any URL was stored as `video_url` and drawn with `<video src>`: a black tile that never loads, and a public listing pointing at a web page instead of a video | Accept list = YouTube (all four shapes) or a direct video file; everything else is refused with a reason. Older rows render `🎥 drive.google.com` (`.cl-nothumb`). `javascript:` / `data:` refused, nothing injected — [assets/complete-listing.js:730](assets/complete-listing.js#L730), [:531](assets/complete-listing.js#L531) |
| 40 files staged in one synchronous pass | **Fragile** | 40 photos | `stageFiles` re-rendered the grid once per file *and* opened all 40 uploads at once | One paint per batch, three uploads in flight, the progress line counts in-flight. Measured: **102 ms** to stage 40 tiles (was ~4,900 ms), exactly 3 uploading / 37 queued — [assets/complete-listing.js:612](assets/complete-listing.js#L612) |
| The empty-state paragraph rendered as a 110 px column | **Ugly** | a brand-new invite | `.cl-empty` is a grid item of `.cl-stage`, so it sat in one 110 px column: 111×116 px of wrapped text | `.cl-empty { grid-column: 1 / -1 }` — one line, 495×39 px — [complete-listing.html:216](complete-listing.html#L216) |
| A 91-character single-word amenity stretched the page | **Fragile** | `SolarPanelWithBatteryBackup…` ×2 | `.cl-tag { max-width: 100% }` cannot clamp while the containing block is content-sized: the field measured 661 px inside a 309 px viewport (`scrollWidth 701`) | `min-width: 0` + `overflow-wrap: anywhere` on the chip text, `max-width: 100%` on the field, custom tags capped at 60 characters with a toast — [complete-listing.html:74](complete-listing.html#L74), [:84](complete-listing.html#L84) |
| Nothing had a length limit | **Fragile** | 62-char name, 1,578-char blurb | No `maxlength` anywhere in the form, and the payload is `jsonb`, so `property_name` is unbounded too — and it is rendered in the dashboard tables and on the OG card | `maxlength` on every text field (name 70, area 80, contact 60, phone 24, amenity 60, description 2000, notes 600, link 300) plus `min`/`max`/`step` on the money and unit inputs. **The server side stays unbounded** |
| A YouTube link pasted without a scheme was refused | **Ugly** | `www.youtube.com/watch?v=aqz-KE-bpKQ` | `^https?://` answered “That does not look like a link.” to the most common paste on a phone | A missing scheme is normalised to `https://` before the check |

**Held up.** `esc()` on every value: an injected `<img onerror>` and a `javascript:` URL produced no elements and no XSS. No horizontal overflow at 240 px, 320 px or 584 px after the fixes (0 overflowing elements on all three tabs; `.cl-tabs` `scrollWidth == clientWidth`). Diacritics, emoji, curly quotes and `₦` render without mojibake. A 1,578-character description scrolls inside its textarea; a 62-character name survives in its input. The case-duplicate amenity collapses to one chip on load. `✕` on a staged tile revokes its blob URL, and each preview is revoked once the real URL exists. `?perm=view` still hides every control (0 buttons inside 40 tiles), hides the unit note, and disables the fields. Saving the worst row wrote `avail:'occupied'`, `units:null`, `rm:'Fully occupied'`, `save_mode:'send'`; the *One* state wrote `rm:"1 room available"`.

**Left alone deliberately:** 40 tiles is a 965–1,860 px panel with no pagination (the real fix is a per-batch cap or a “show all” clamp); the 40 blob previews are held until each upload finishes; and the dashboard's manual video box still advertises “YouTube / Vimeo / direct video link” while the player is YouTube-only.

**Suite after every fix above:** `TOTAL 95 · PASS 95 · FAIL 0`, exit 0 (`/tmp/arzuz-suite5.log`).

### The three follow-ups (same day)

1. **The media grid is capped.** `GRID_CAP = 12`: the committed grid paints twelve tiles plus a full-width
   `Show all 40 (28 more)` row. Staged tiles always render, because that is the batch the landlord is
   watching go up and they disappear as the uploads land. Expanding is a *view*, not an edit — it works on
   a read-only link too, never marks the form dirty, and the hidden tiles never leave `MEDIA` or the
   payload. Removing a tile while capped still targets the real index (verified: after ✕ the label reads
   `Show all 39 (27 more)`, cover untouched). The media panel drops from ~1,860 px to 336 px, the whole
   page from ~4,000 px to 1,429 px, with no overflow at 584 px or 320 px.
   → [assets/complete-listing.js:559](assets/complete-listing.js#L559)
2. **The payload has a server-side length guard.** `public.listing_payload_clamp(jsonb)` is defined in both
   SQL files and `listing_draft_update` calls it on the whitelisted patch before the merge: text fields at
   the forms' own ceilings (name 70, area 80, contact 60, phone 24, description 2,000, notes 600, links
   300), money digits-only ≤ 8, units 0–999 (0 stores `avail:'occupied'` + `Fully occupied`), and a media
   list longer than 60 trimmed to its first 60. A caller posting straight at the endpoint can no longer
   store an 8,000-character lodge name for the dashboard table and the OG card to render. The helper is
   revoked from `public` alongside the two RPCs.
   **Not executed — no Postgres in this workspace.** Desk-checked only; §4 (i) of `supabase-draft-sharing.sql`
   is the query that proves it once the file is applied.
3. **One video rule, in the player's own file.** `ArzuzVideo.isPlayable` / `normalizeUrl` /
   `playbackProblem` now live in `assets/video.js`, and the landlord form *and* both dashboard entry points
   (add + edit) call them: a YouTube link or a direct video file, a missing scheme normalised, and the same
   sentence when a Drive / Photos / Vimeo page is refused. The dashboard's manual box no longer advertises
   Vimeo it cannot play, and it got the same `maxlength="300"`. Pins: `complete-listing.js?v=5`,
   `admin.js?v=14`, `video.js?v=2` (admin.html, listing.html, complete-listing.html).
   **The dashboard's embed box was verified as shipped, not clicked** — admin.html boots against Supabase
   and there is no session here; the shared rule itself was exercised in the browser through the landlord
   form (Vimeo and Drive both refused with their own sentence).

Suite after all three: `TOTAL 95 · PASS 95 · FAIL 0`, exit 0 (`/tmp/arzuz-suite7.log`).

---

# Round 4 — the dashboard composer, and why a listing was invisible (2026-10-10)

## 14. `?seed=worst` on the admin dashboard itself

The landlord form got a worst-case pass in Round 3. The dashboard shares its primitives — the media
queue, the tag input, the availability control, the map switch — but **not its CSS**, so the same
fixture was run against it: `admin.html?mock=1&seed=worst`, with a **Fixtures · Demo data · Worst
case** toggle in the page (bottom-left, `z-index: 900` so a modal covers it) and `worst()` in
[dev/admin-mock-data.js](dev/admin-mock-data.js) swapping every listing for the break-ui set — which is
**generated, not written out**. `worstListings()` emits rules; there is no list of rows for anyone to
forget to update. Rule 1 is the matrix, and it is complete by construction:

| Cells (45) | Rows | The verdict they exercise |
|---|---|---|
| draft · pending · rejected · inactive, each × tier 0/1/2 × env `production`/`test`/NULL | 36 | `hidden:status` — the status is the first thing that fails |
| **active** · tier 0 · `production` · `test` · NULL | 3 | `hidden:tier` — **the bug report's own shape**: approved, tier never raised |
| active · tier 1/2 · `test` | 2 | `hidden:env` |
| active · tier 1/2 · NULL `env` | 2 | `hidden:env-empty` — the row that looks healthy and is invisible |
| active · tier 1/2 · `production` | 2 | `live` — the only cells the board shows |

The enumerations are the dashboard's own, not an invented list: the five statuses its Status filter
offers, the three tiers its Tier select offers, and the three envs `public_listings` distinguishes. So
of the 45 cells the board can show exactly two, and each of the four ways it can hide a listing has
rows that reach it. Rule 2 adds the payload extremes:

| Payload extreme (4 rows) | The case it adds |
|---|---|
| `max-ceilings` — 70-character emoji name, 80-character area **with no spaces**, 8-digit rent, 999 units, 30 amenities, 2,000-character description | every ceiling at once, in one row |
| `empty-payload` — `payload: {}` | the public form posts whatever it is given |
| `zero-units` — 0 units → *Fully occupied*, ₦0 rent, Yoruba diacritics in two fields | the fully-let lodge + non-Latin text |
| `rtl-and-60-media` — RTL name **and** area, 60 media items, a 300-character URL | bidirectional text, the media cap |

Each of those is still a board case in its own right, and the draft rows rotate the four invite states
`draftBadgeHtml()` can show (link **revoked** · **expired** · **completed** · a live link), so no draft
row is the same draft. **49 rows** in all.

Every row records which case it is there to exercise:

    row.case = { label: 'active · tier 0 · production',
                 status: 'active', tier: 0, env: 'production',
                 exercise: 'hidden:tier',     // the first condition that hides it
                 stress: null }               // or the name of the payload extreme

`exercise` is recomputed inside the fixture from the row's own three fields — **not** imported from
`admin.js`, so a fixture that shares the dashboard's mistake cannot pass by sharing it — and the page
publishes the records through `worstPlan()` for the regression test in §18 to read back.

### What broke

1. **The table was 2,343 px inside a 991 px pane.** The 80-character area is one unbroken string, and
   its cell measured **509 px**; a draft row's button set put **490 px** in the Actions cell. The two
   rightmost columns — *Actions* and the new *Browse board* — were simply not on screen. Fixed with
   `.cell-clamp` (a 140 px floor under a 190 px ceiling, breaking anywhere) on the property and area
   cells, and `flex-wrap: wrap; max-width: 230px` on `.cell-actions`.
   → [assets/admin.css:687](assets/admin.css#L687), [main.js rows](assets/admin.js)
2. **`overflow-wrap: anywhere` alone was the wrong fix** — it also collapsed the column's min-content,
   so Area shrank to 67 px and *every* value hyphenated mid-word ("Behi / ndK / WAS / UGat"). The floor
   is what makes it safe: with `min-width: 140px` the demo rows are single-line and the pathological one
   wraps into 172 px.
3. **`Publish` was on the wrong side of the scroll.** *Browse board* sat next to *Actions*, so the
   answer to "why is my listing not live?" needed a horizontal scroll to read. It now sits beside
   **Status** — the two together are the whole sentence (`draft` + `hidden`) — and Date, Status, Browse
   board, Apt ID, Photo, Property, Amenities and Type all fit at 1280 px.
4. **The Availability segment ran 28 px off a 309 px screen.** "Vacant units available" + "Fully
   occupied" is 306 px of content in a 231 px group with `flex-wrap: nowrap`, so the second option was
   clipped and untappable. Under 420 px the group stacks.
   → [assets/admin.css](assets/admin.css) `@media (max-width: 420px)`
5. **An upload failure said "1 failed" and nothing else.** `stageFiles` passed `statusElId = null` and
   its `onError` took no argument, so the reason was computed and thrown away. It is now on the tile
   (`title` + `Failed`) and in the summary line, cut at a word boundary:
   *"0 uploaded, 1 failed — Upload failed: Cloudinary environment variables not configured on server —
   set CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and CLOUDINARY_CLOUD_NAME in Netlify → Site settings →
   Environment variables, then redeploy."*
6. **A NULL `env` was reported as live.** The helper fell back to `'production'` for an empty value,
   but the view asks for `'production'` exactly, so the NULL-`env` row is hidden while the badge said
   `live`. Empty
   is its own reason now: *"its env is empty, and the public board only reads production"*. Caught by
   the fixture, not by reading the code.

7. **On a phone the cards clipped the same unbreakable area.** The `max-ceilings` row's 80-character
   area ran past the card at 390 px: `.rc-sub` is a flex row, and a flex item's `min-width` is `auto`,
   so the span grew to its content instead of wrapping in the card — which then clipped it with
   nothing to scroll to. Fixed on `.rc-sub > span` with `min-width: 0` **plus** a wrap permission.
   Round 5 wrote that up as *"the floor is `min-width`, not a wrap permission"*; the mutation run in
   §18 measured the opposite — `min-width: 0` **alone** still clips 165 px, and `min-width: 0` +
   `overflow-wrap: break-word` holds. The comment in the CSS and this line now say what was measured.
   → [assets/admin.css](assets/admin.css) `@media (max-width: 860px)`

   This one was found by the automated pass in §18, not by the hand-walk: the round-4 walk measured
   the table at 1280 px and the composer at 309 px, and never rendered the card layout at all.

### Held up

The board note matches the status/tier pair in both modals and updates on change; the one-click
**Publish** sends exactly `status: active`, `tier: max(1, current)`, `env: production` and never
appears on a draft (publishing a draft is a deliberate two-step — the invite link dies the moment the
status leaves `draft`); the tag input, the 30-amenity cell, the 60-item gallery and the RTL row all
render without a single overflowing element; `Demo data` still reads normally, so the clamp floor did
not cost the common case; at 309 px the whole Add modal has **zero** overflowing elements and the page
never scrolls sideways.

## 15. The three conditions, and the live diagnosis

`browse.html` reads `public_listings`, which is

```sql
where status = 'active' and tier >= 1 and env = 'production'
```

The report that started this round was *"the listing I added does not display and it just says there
are no apartments"*. Read against the live project with the anon key the page itself ships
(`GET /rest/v1/public_listings?select=id,tier,property_name`):

```
HTTP 200  []                       ← the view exists, and returns nothing
HTTP 401  {"code":"42501"}         ← and anon still cannot read listings itself (correct)
```

So the row is not lost and the endpoint is not broken: it fails one of the three filters, and nothing
in the dashboard said which. The likeliest of the three is `tier`: a submission from `owner-list.html`
can *only* be inserted as `status='pending', tier=0` (the anon INSERT policy), and approving it by
setting the status to active leaves it invisible — silently. That path, and the `env` one, are now
both on screen before and after the save.

## 16. The ceilings apply to every writer

The clamp used to live inside `listing_draft_update` — one door. The dashboard POSTs to
`/rest/v1/listings`, the public form POSTs to the same table as anon, and the SQL editor writes as the
owner: three doors it never saw. `public.listings_guard_payload()` is now a `BEFORE INSERT OR UPDATE
OF payload` trigger in **both** draft files, and the clamp also nulls an unparseable `lat`/`lng` so a
bad pin cannot make an otherwise-fine save raise on the generated column. `update of payload` keeps it
out of a status/tier write, and clamping twice is the same as clamping once (asserted).

**This is now executed, not desk-checked.** Round 3 could only say the SQL had never run. `npm run
sql:proof` applies all ten files to PostgreSQL 18 in WebAssembly and asserts the clamp as a function
**and** as a trigger: all fifteen text ceilings, money digits-only ≤ 8, 0 units → `units: null` +
`avail: 'occupied'` + `rm: 'Fully occupied'`, 999999999 → 999, a negative count refused, 120 media →
the first 60 in order, idempotency, the INSERT door, the UPDATE door, the **anon** door, and the seven
browse-board combinations — including that a normal *Add apartment* save does land on the board and a
tier-0 row never does. Forty-four of those checks are new, and the file-parity check reads the
`maxlength` values back out of both HTML files — **and the matching `max` ceiling**, because the
browser ignores `maxlength` on `<input type="number">` — so the three layers cannot drift.

## 17. Verification for this round

| Check | Result |
|---|---|
| `npm test` (7 suites) | **7 of 7 passed · nothing failed**, exit 0 — roommate 72, care 58, my-care 41, admin 202, postgrest 24, sql:proof 131, sql:guards 26 |
| `maxlength` under real typing (name/area/phone/description/notes/video link) | 200→**70**, 200→**80**, 60→**24**, 2600→**2000**, 900→**600**, 500→**300** |
| 9-digit rent | `validity.rangeOverflow === true` — the browser refuses the submit |
| Board note, both modals, worst row | live → "Students can see this on the browse page now."; tier 0 → the reason; pending → the reason |
| One-click Publish (boot test) | one PATCH, `{status:'active', tier>=1, env:'production'}`, row flips to live, action disappears |
| Upload failure | the signer's own sentence + the Netlify fix, in the progress line and the tile `title` |
| Layout, listing table | 2,343 → **1,446 px** at 1280 (zero overflowing cells); 0 overflowing elements at 309 px |
| Layout, Add + Edit modal | 0 overflowing elements at 309 px in both |

**Could not run:** the real Cloudinary success path (there are no credentials in this workspace — the
failure path is proved against the function's own 500 body, byte for byte), and a real phone. The
`?seed=worst` fixture and the fixtures toggle are dev-only and never load in production.

## 18. The fixture, on every push

Round 4 found its breaks by hand, and a hand-walk proves a thing once. The same fixture now runs in
headless Chrome on every push — `scripts/test-admin-worst.mjs`, registered in `scripts/test-all.mjs`
next to the two other browser suites (the pre-push gate in `.githooks/pre-push`), **65 checks** over
two fixtures and three layouts, **9.4 s**, exit non-zero on any failure. The fixture itself is
generated (§14), which is what makes the completeness checks below possible: there is no list of rows
left for anyone to forget to update.

### What it asserts, and why

| Check | The bug it would catch |
|---|---|
| Every row's verdict is recomputed here from that row's own `status` / `tier` / `env` — the three conditions `public_listings` applies — and compared with the badge | the NULL `env` read as live, and any future drift between the badge and the view |
| Every hidden badge's tooltip carries the reason, and the reason names the condition that failed | the "1 failed" problem, in the table: hidden with nothing on screen explaining it |
| Publish is offered on every hidden non-draft row **and never on a draft** | publishing a draft kills its invite link; that has to stay a two-step |
| No text escapes its box, nothing is clipped with nothing to scroll to, the page never scrolls sideways at 1440 / 390 / 309, and the table stays within 700 px of its pane | the 2,343 px table, the clipped card, and the 28 px segment |
| The composer's note follows the real selects and is never empty | a reason clause that comes out blank before the save |
| **The fixture's own plan**, read back from the page: the statuses / tiers / envs it declares match the ones the dashboard is offering at that moment, all 45 cells are on screen exactly once, and every row's `case` record is true of the row it is written on | the hand list that lost the tier-0 case — this one did — a fixture that drifts when the dashboard gains a status, and a record that describes a row it is not on |
| Every branch of the board has a row that reaches it, the fixture declares that vocabulary itself, and the `env`=test row stays out of the production view until **Show test rows** is ticked | assertions that pass because nobody looks at anything |

### The gap the hand list had — and why it cannot come back

The tier branch — *active, tier 0, production*, the exact shape of the original report — had **no row
in the round-4 fixture**. Rows 2, 7, 8 and 9 all failed the status check first, so `it is tier 0 — not
verified yet` was never rendered by the table, and the round-4 note that covered it had been driven by
hand in the composer. One row was added for it, and that was the wrong fix: a hand-written list is a
list somebody has to remember to extend.

So the list is gone. `worstListings()` now *builds* the fixture — every status × tier × env
combination the dashboard can hold, the enumerations taken from the dashboard's own controls, plus
the payload extremes — and every row carries the case it is there to exercise. The page publishes
the same records through `worstPlan()`, so the suite asks the fixture what it covered and gets an
answer it can check four ways:

* a status added to the dashboard's Status filter fails the suite until the fixture grows it (and a
  status the fixture invents fails the other way — the two are compared as sets against what the
  filter is offering at that moment);
* a cell that goes missing fails **by name**: `no row for: inactive|0|production, inactive|0|test, …`;
* a duplicated cell fails;
* a row whose record disagrees with its own `status` / `tier` / `env`, or with the branch its data
  actually earns, fails by id: `0019: record says it exercises "live", its data earns "hidden:tier"`.

The tier-0 case is not one row any more, it is three of the 45 — and if the dashboard ever grows a
fourth tier, the fixture has to grow with it or the suite says so.

### Proving the test can fail

A green suite is worth nothing until it has been red for the right reason. Six mutations, each applied
to the tree as it stands and each reverted afterwards with the restored file re-read and compared to
the original bytes (the harness was deleted, not left in the tree):

| Mutation | Result |
|---|---|
| `worstMatrix()` drops one status (`inactive`) | **failed**: `the fixture declares the dashboard's own statuses (draft, pending, active, rejected, inactive)` → `fixture: [draft, pending, active, rejected] · dashboard: [draft, pending, active, rejected, inactive]` |
| the three active · tier 0 cells record themselves as `live` | **failed**: `every row carries a case record, and no record lies about its own row (49 rows)` → `0019: record says it exercises "live", its data earns "hidden:tier"` — 0020 and 0021 the same |
| the `inactive` cells are never emitted | **failed**: `every status × tier × env combination is emitted, exactly once (45 cells, 36 matrix rows)` → `no row for: inactive\|0\|production, inactive\|0\|test, …` — all nine named |
| `boardState`: an empty `env` falls back to `'production'` (the round-4 bug, restored) | **failed** on both layouts: `every verdict matches the row's own status / tier / env` → `0024 claimed "live", earns "hidden"; 0027 claimed "live", earns "hidden"` + `Publish is offered on every hidden non-draft row` → `0024 hidden and not offered Publish` |
| the hidden badge's `title` emptied | **failed** on both layouts: `every verdict explains itself` + `every verdict matches the row's own status / tier / env` → `0001 badged hidden without saying why: ""` … naming **all 44 hidden rows** (the five live ones are the ones it does not name) |
| the whole `.rc-sub > span` rule deleted | **failed**: `clipped, and nothing scrolls to it (div.table-card, 165px)` + `box escapes its parent (span, 194px — BehindKWASugateMaleteNoSpacesAtAllInThisArea)` |

### A claim the mutations corrected

Break 7 in §14 was written up as *"the floor is `min-width`, not a wrap permission"*. Measuring it says
the reverse:

| The card rule at 390 px | Result |
|---|---|
| `min-width: 0` **alone** (both wrap properties dropped) | **red** — `clipped, and nothing scrolls to it (div.table-card, 165px)` |
| `min-width: 0` + `overflow-wrap: break-word` | green |
| `min-width: 0` + `word-break: break-word` | green |
| the wrap pair with `min-width: 0` dropped | green |
| the whole rule deleted | **red** — the clip returns, 165 px |

So `min-width: 0` is what lets the flex item shrink, and the wrap permission is what breaks the word
inside it — **both are load-bearing, and the pair is redundant** (either wrap property carries it). The
comment in [assets/admin.css](assets/admin.css) and break 7 in §14 now say what was measured instead of
the reverse.

| Check | Result |
|---|---|
| `node scripts/test-admin-worst.mjs` | **TOTAL 65 · PASS 65 · FAIL 0**, exit 0, **9.4 s** alone — 10.4 s with the runner's `--only`, 15.8 s inside a full sweep (the 49-row worst fixture + demo × desktop 1440 / mobile 390 / composer 309) |
| `node scripts/test-all.mjs --only=admin-worst` | **✓ admin-worst passed (10.4 s)**, 1 suite |
| `node scripts/test-all.mjs --list` | 13 owned suites + 10 from `package.json`, **0 test-like files no runner invokes** |
| `node scripts/test-all.mjs` (every suite) | **22 suites · 22 passed · 0 failed · 0 skipped**, exit 0 (232.0 s wall) |
| `site-audit` inside that sweep | **TOTAL 321 · PASS 321 · FAIL 0** (107.4 s) — the card CSS change cost nothing |
| `npm test` | **9 of 9 suites passed**, exit 0 — admin 202, sql:proof 131, sql:guards 26 |
| The six mutations above | red, on the rows involved, each reverted byte-for-byte |
| The same suite re-run after the fixture/CSS edits, against the live tree | **TOTAL 65 · PASS 65 · FAIL 0**, exit 0 |

**The tree is shared while this was measured.** Another lane is editing `assets/admin.js` and
`package.json` at the same time as this work, and a `npm test` re-run minutes after the one above
reports `test:postgrest — 26 passed, 1 failed` (`the console is told what happened, rather than the
failure vanishing` → `nothing was logged: ["warn: [Arzuz Admin] 401"]`), plus one package.json suite
it no longer runs. That failure is in that lane's files: `assets/admin.js`'s `onAuthError` path now
passes `err.detail || err.message` to `console.warn`, so a 401 logs `401` where the postgrest suite
expects the sentence, and `dev/postgrest-test.js` **never loads this fixture** (it boots its own
recorded REST world — no `admin-mock-data`, no `?seed=`). The fixture work here is independent of it,
and the suite above is green on the tree as it stands. The failure did not survive the afternoon: the
last `npm test` on this tree is **10 of 10 suites passed**, postgrest included (27.8 s, with nothing
changed here in between). §22 records that resolution, and the weaker form of the attribution the
file times can actually support.

### The shared server, and why this suite brings its own port

The two older browser suites both default to `http://localhost:8123` and **reuse** whatever is already
listening there. In the runner that is one shared server for several suites (`listing-render` runs
three times, plus `site-audit` and `home-motion`), and whichever one started it kills it on the way
out — so the longest suite can lose its page loads to another suite finishing. That is exactly what
happened on the first full sweep: `site-audit` failed at 231 s while passing **321/321** standalone,
and the only change on my side was that it now had one more suite sharing the port.
`test-admin-worst.mjs` defaults to **8134** now (`--base` / `ARZUZ_TEST_BASE` still override), and the
sweep recorded above — 22 of 22, with `site-audit` at 321/321 in 107.4 s — is the same tree. The other two suites were left alone: that is their file, and
the fix belongs with whoever owns the runner lanes.

**Could not run here:** a real phone (the 309 and 390 px passes are emulated viewports), the Cloudinary
success path, and a second browser engine — the suite drives Chrome/Edge, and the card's wrap was only
measured there, so whether `overflow-wrap: break-word` / `word-break: break-word` hold in Firefox is
unmeasured. Nothing in this section is desk-checked — every number above came from the suite as it
stands on disk.

## 19. Care was never switched on, and nothing here could see it

Round 5 ended with 554 local checks passing and Care described as shipped. Asked to confirm a student
link resolves on the live site instead of 503, the honest answer turned out to be that **there is no
live student link to resolve**: two of the three layers under it have never existed in production.

`npm run care:live` (new) asks the three of them and names the one that is missing.

| Gate | What it asks | Answer, measured 2026-10-10 |
|---|---|---|
| 1. the migration landed | `care_plans`, `care_credit_events`, `care_credit_balance`, `care_plans_live` exist and anon is denied on all four | **all four 404 + PGRST205** — PostgREST has no such relation, so `supabase-care.sql` has never been run against this project |
| 2. the door is deployed | `/api/care-credit` answers a link | **the 404 page** — the function is not on the deploy at all |
| 3. the page is deployed | `/my-care.html` is served | **404** |

The second gate is not a routing problem: `/api/notify` answers `405 {"error":"Method not allowed"}`
on the same host, so `/api/*` → `/.netlify/functions/:splat` works. The deploy simply predates the
Care work — `notify`, `listing-og`, `strategy-docs` and `team` are live; `care-credit`,
`roommate-match`, `roommate-digest`, `my-care.html` and `roommates.html` are not, while `care.html`
(200) and `admin.html` (200) are. The database itself is not the problem: the eight real relations
still answer **401 + 42501** to the public key, so the hardening holds exactly as `SETUP.md` claims.

### What stopped there, and what did not

Applying `supabase-care.sql` needs a credential that is not in this workspace: no `DATABASE_URL`, no
`SUPABASE_SERVICE_ROLE_KEY`, no Supabase access token, no `psql`, no Supabase CLI, no `netlify` CLI —
only the public anon key in `assets/config.js`. The service key would not help even if it were here,
because PostgREST exposes no DDL: the doors are the SQL Editor, a direct connection, or the
Management API. Deploying is the other half, and the site is git-connected (`atimileyin11/arzuz`), so
that means a push — which is the operator's call, not something a test run should decide.

So the confirmation was built instead, and re-capturing the fixture — the part that needs no
credential — was done.

| New | What it is |
|---|---|
| `npm run care:live` | the three gates against the live site and live database. Prints which layer is missing and exits non-zero; `--capture` re-records the fixture and replays it once green; `--base=http://localhost:8888` points it at `netlify dev` instead |
| `npm run test:care-live` | the same verdicts **offline**, in the gate — 20 checks |
| `npm run postgrest:other-world` | derives the other Care world from the recording, so the branch that needs the migration can be rehearsed before it happens |

### The recording could not answer the question it was being asked

Re-captured 2026-10-10, and the re-capture was not a formality. The old capture probed **one** Care
relation (`care_plans_live`, the view the panel reads) and never read `care_credit_events` at all —
only wrote at it. The replay was then supposed to decide "has the migration been applied?" from that,
and one relation out of four cannot tell a half-applied migration from a finished one. The capture now
reads all four, and the replay asserts there is **exactly one GET per relation** — because "the last
entry for `care_credit_events`" stops being an answer the moment the table exists.

### The replay asserts the world it was recorded in, not the world it was written in

§3 used to state, as a check, that `supabase-care.sql` **had not** been applied — a fact about the
live database written into a suite. That goes red the hour the file is run, which is the hour it has
the least right to be wrong, and the temptation then is to delete the check rather than teach it the
other answer. It now reads the world out of the recording, fails if the four relations disagree with
each other (a half-applied migration), and asserts what that world means for a student link: **503**
while the tables are absent, **404 — never 503 — once they exist.** The two claims that do not depend
on the world are asserted in both: that `care-credit.js` still recognises PGRST205 and still tells the
student their link is fine, and that the student door is reached **before** the role gate (a student
has no session to offer, so a student link answered 401 would be a bug in the function's order, and
§3 now compares the two positions in the source).

Rehearsing the present world found a real bug in that classifier immediately — the first run of it
read the *write* entries, saw the forged ledger insert recorded as `skipped`, and called a **finished
migration half-applied**. That is the failure mode a rehearsal exists to catch, and it is why the
world is read from the GETs explicitly. A derived copy also announces itself on every run
(`⚠ THIS IS A DERIVED COPY, NOT A RECORDING — nothing here was measured`), and §1 now fails any
fixture that is silent about which it is: a recording must give the re-capture command, a copy must
say it is derived and how to rebuild itself.

### Verification for this round

| Check | Result |
|---|---|
| `npm test` (8 suites) | **8 of 8 passed · nothing failed**, exit 0 — roommate 72, care 58, my-care 41, admin 202, postgrest **27**, care-live **20**, sql:proof 131, sql:guards 26 = **577** |
| The replay on the RECORDED world (`npm run test:postgrest`) | **27 passed, 0 failed** — this recording says ABSENT: plans/events/balance/live all PGRST205 |
| The replay on the DERIVED present world | **28 passed, 0 failed** — says PRESENT: all four 42501, anon still denied, the link answer asserted as 404 |
| The derived-copy guard | announced on the run; §1 fails a fixture that does not declare itself (mutation-tested by deriving a copy) |
| `npm run care:live` (the live half) | **exit 1**, naming gate 1 (four relations 404 PGRST205), gate 2 (the 404 page) and gate 3 (my-care.html 404) — the honest red |

**Could not run, and why:** the SQL itself (no credential here, named above — so this is a measured
red, not an assumed one); a real student link (it needs a real grant, and a grant needs the service
key and a signed-in team member); and the live half of gate 2 entirely, because `care-credit.js` is not
on any deploy yet. The derived present world carries one assumption and it is stated in both the script
and the fixture it writes: that anon's denial on the four relations is **401 + 42501**. That is
executed against real PostgreSQL by `sql:proof` for `care_plans` and `care_credit_events`, and measured
on this platform eight times in the recording — but whether the live project answers 401 or 403 for the
two views is unverified, which is exactly why the check accepts both and why `admin.js` folds them.

To finish this, in order: run `supabase-care.sql` (SQL Editor → New query → paste → Run), set
`SUPABASE_SERVICE_ROLE_KEY` in Netlify, deploy, then `npm run care:live` — and when it is green,
`npm run care:live -- --capture` re-records the fixture in the world the database is now actually in.

---

## 20. The landlord's invite page: what a failure is allowed to say

`complete-listing.html` is the only page in the product whose reader did not ask for it: somebody
forwarded them a link on WhatsApp. Until this round, **every** way the page's two calls could fail
reached that person as the same sentence — *"This link is not valid"* — and the actual reason went to
a console nobody reads. A half-deployed site therefore sent a landlord to ask for a fresh link that
could not work either, and the one thing they needed to do (tell us) was the one thing they were not
told to. The Care page already refused to make that mistake; this is the invite page catching up.

### The measurement, and the correction it forced

The first probe of this round was wrong and it is worth writing down, because the shape of it is what
the fix is about. Calling `listing_draft_get` with an empty body `{}` answers `404 PGRST202`, which
reads exactly like "this function does not exist". It is not: PostgREST answers `PGRST202` for **any**
function with parameters when the call does not name them, so `{}` proves only that the signature was
wrong. Named properly, both functions answer. Everything below was measured on the live project on
10 Oct 2026 with the public key from `assets/config.js` — `curl -s -w '\n[HTTP %{http_code}]\n' -X
POST $URL/rest/v1/rpc/<fn> -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type:
application/json" --data '<body>'` — and every body is quoted verbatim from that run:

| the call | what the live project answered | what the landlord is told now |
|---|---|---|
| `listing_draft_get` with `{}` | `404` · `PGRST202` · "Could not find the function public.listing_draft_get without parameters in the schema cache" | *This page is not switched on yet* — nothing is wrong with your link |
| `listing_draft_get` with `{"p_token":"<uuid>"}` | `200` · the row, or `null` for a token it does not know | the form — or, for the `null`, the one class that really is about the link |
| `listing_draft_update` with `{"p_token":"<uuid>","p_patch":{}}` | `200` · `null` | — (the function exists and ran: no `PGRST202` risk here) |
| `listing_draft_get` with `{"p_token":"9f2c"}` | `400` · `22P02` · "invalid input syntax for type uuid: \"9f2c\"" | *This link looks incomplete* — open it in one piece |
| `listing_draft_nope` with `{"p_token":"<uuid>"}` (the control: a function that really is absent) | `404` · `PGRST202` · "Could not find the function public.listing_draft_nope(p_token) in the schema cache" | the same *not switched on* class |

So the adjacent finding this round started from — "the page calls two RPCs that do not exist in
production" — was a probe artifact, and the correction changes the fix. Production is **not** missing
`listing_draft_get` / `listing_draft_update`: `supabase-drafts-support.sql` is applied, both functions
answer the anon key, and an unknown token is a `200 null`, not an error. What was actually broken is
that the page could not tell any of these apart, and the control row is the reason it matters: a
missing function and a wrong signature are **the same HTTP status**, so a classifier keyed on the
status alone cannot be right for both. `assets/draft-errors.js` keys on the Postgres code and the
sentence (`PGRST202`, schema-cache wording, `22P02`, `42501`) and treats the status as the fallback.

### What changed

| file | the change |
|---|---|
| `assets/draft-errors.js` (new) | the classifier and the words, one entry per class: `not-ready`, `bad-link`, `no-link`, `dead-link`, `busy`, `offline`, `error`. Same UMD pattern as `assets/roommate-score.js`, so a Node suite loads the very file the browser does |
| `assets/complete-listing.js` | `rpc()` now carries `status`, `code` and the platform's own `message` instead of throwing `HTTP 404`; `failState` / `failNote` / `describe` render a class, not a message; a save that fails keeps the form and everything typed in it; the upload path prefers the server's sentence to "HTTP 500" |
| `complete-listing.html` | the dead card gains `#clDeadTitle` / `#clDeadBody`; the static copy stays as the no-JS default and is still the dead-link wording, because that is the one class that really is about the link |
| `dev/upload-mock-server.mjs` | answers `PGRST202`, `22P02`, `42501`, `429`, `500` and a refused connection on request, so every state can be walked without touching production |
| `dev/complete-listing-harness.html` | `?fail=<class>` to drive any one of them |
| `scripts/test-draft-errors.mjs` (new) | 15 checks over the recorded bodies — the code **and** the sentence, in both directions — plus the two page-level contracts (the classifier is loaded before the page; no raw `e.message` reaches a landlord) |

### Verification for this round

| Check | Result |
|---|---|
| `npm test` | **9 of 9 passed**, exit 0 — roommate 72, care 58, my-care 41, admin 202, postgrest 27, care-live 20, **draft-errors 15**, sql:proof 131, sql:guards 26 = **592** |
| `npm run test:draft-errors` | **15 passed, 0 failed**, exit 0 |
| the browser walk | all four reachable states seen in Chrome against the mock server: the *not switched on* screen, the *incomplete link* screen, the offline inline note, and a 500 named as our side |
| `node scripts/test-site-audit.mjs` | **321 · PASS 321 · FAIL 0**, exit 0, with the new script tag on the page |
| `node scripts/test-deploy-guards.mjs` | **71 · PASS 71 · FAIL 0**, exit 0 |

**Could not run here:** the `PGRST202` path cannot be produced by the live database, because the two
functions *are* present — it is proven against the recorded body and the mock server, not against
production. Whether the live project answers `401` or `403` when a grant is missing is likewise
unverified, which is why the classifier accepts both and the test feeds it one of each. And the
`not-ready` copy is a judgement: it tells the landlord not to bother asking for another link, which is
right for this page's own fixed calls — where `PGRST202` can only mean the function or the upgrade is
missing — and would be the wrong sentence for a caller whose argument names could drift.

One environment note from this round, recorded because it cost two confusing red runs: the whole-site
audit trusts **any** listener already answering on port 8123, so a stray dev server left behind by an
earlier run makes thirteen pages "fail" with a signature that has nothing to do with the code
(`server … (already running)` in its header is the tell). Re-running with the port free gives 321/321.

---

## 21. The same lesson everywhere else: no page says "HTTP 500"

### The finding

§20 fixed one page and left the other thirteen saying the same thing. A grep for the construction that
makes a message out of a status — `'HTTP ' + r.status` — found it in **eleven** modules and in the inline
scripts of **two pages**: `submit.js`, `data.js`, `video.js`, `whatsapp.js`, `notify.js`, `arzuz-map.js`,
`auth.js`, `strategy.js`, `app.js`, `complete-listing.js`, `admin.js` (**seventeen** separate
constructions), `browse.html` and `listing.html`. Two server-side fallbacks (`roommate-match.js`,
`team.js`) returned `Supabase HTTP 500` / `GoTrue HTTP 500` in the JSON body a page then shows as the
server's own sentence.

The worst of them was the behaviour, not the wording. `submit.js` queued **every** failure and told the
student *“Connection issue — queued for auto-retry when online.”* A row the database refuses — a CHECK
constraint, a table that was never created, a missing grant — is refused identically forever: the queue
never drains, the student is told it will retry by itself, and the one thing that could fix it (telling
them) never happens. `app.js` then rendered that queue note as *“your connection dropped”* and ended a
**refused** save on a screen that looked like success.

### What changed

| file | the change |
|---|---|
| `assets/api-errors.js` (new) | the shared vocabulary, loadable in a browser and by `require()` in Node: six classes — `not-ready` (PGRST202 / PGRST205 / a 404 / a missing grant), `expired` (a 401 on a page that holds a session), `rejected` (any other 4xx), `busy` (429), `offline` (a rejected `fetch`, which carries no status at all), `error` (5xx and anything unreadable). `sentence()` is what a person reads and never contains a status; `detail()` is what the console prints and always does; `retryable()` and `queueable()` are separate on purpose — a missing function is worth holding, and is not worth telling somebody to press the button again |
| `assets/draft-errors.js` | now **built on** `api-errors.js` rather than beside it: the shared classes are the base module's own object (`busy`/`offline` identical, asserted), and only the link-specific copy and the two link classes are re-worded. Every sentence unchanged, so §20's 15 checks still pass untouched |
| `assets/submit.js` | `post()` throws the platform's `{code, message}` instead of `HTTP 404 — {json}`; a failure is classified; **only a holdable failure is queued**; the result carries the class and the exact sentence the page should show |
| `assets/app.js` | renders that sentence; a refused save no longer lands on a success-looking screen; the photo-upload sign failure no longer prints `Sign endpoint returned 500` |
| `assets/admin.js` | one `apiErr(res, body)` builds every failure with its status and PostgREST code, a sentence in `message` and the wire facts in `detail`; **seventeen** constructions replaced, 28 display sites inherit the sentence, and the three console lines moved to `detail` so the log did not lose the reason |
| `assets/auth.js`, `strategy.js`, `video.js`, `roommate.js`, `my-care.js` | sign-in, the strategy reader, video start/upload, the matcher and the Care page now classify; each keeps the server's own sentence when it has one, because that is the answer to what was asked — bar one: on a **5xx** `roommate.js` keeps its own outage line instead, because an outage has advice to give ("your profile is saved") and the function's sentence for one paraphrases the same fact. §31 pins that so it is a decision rather than a drift |
| `assets/data.js`, `notify.js`, `whatsapp.js`, `arzuz-map.js`, `complete-listing.js`, `browse.html`, `listing.html` | the remaining constructions, so one rule can be checked across the whole site instead of a majority of it |
| `netlify/functions/roommate-match.js`, `team.js` | the fallback sentence no longer returns a status in the JSON a page shows; the status goes to the function log |
| every page with a script tag | loads `assets/api-errors.js` directly after `config.js`, before anything that consults it |
| `dev/admin-sandbox.js` | loads it too, because a harness must exercise a script list a browser actually has |
| `scripts/test-api-errors.mjs` (new) | 54 checks in seven groups, six of which **drive the real `submit.js`** in a page-shaped VM with a stubbed fetch |
| `README.md` | ten suites, 642 checks |

### Verification for this round

| Check | Result |
|---|---|
| `npm test` | **10 of 10 passed**, exit 0 — roommate 72, care 58, my-care 41, admin 202, postgrest 27, care-live 20, draft-errors 15, **api-errors 54**, sql:proof 131, sql:guards 26 = **646** |
| `npm run test:api-errors` | **54 passed, 0 failed**, exit 0 |
| `node scripts/test-site-audit.mjs` | **321 · PASS 321 · FAIL 0**, exit 0 — every page loads the new module with no console error |
| `node scripts/test-deploy-guards.mjs` | **71 · PASS 71 · FAIL 0**, exit 0 |
| `node scripts/test-home-motion.mjs` | **47 · PASS 47 · FAIL 0** |
| `node scripts/test-listing-render.mjs` | **276 · PASS 276 · FAIL 0**, and **108 · PASS 108** under `--fault-inject --case=worst,huge` |
| `node scripts/test-admin-worst.mjs` | **65 · PASS 65 · FAIL 0** |
| `test-youtube-url`, `test-attribution`, `test-strategy-docs`, `test-strategy-render`, `test-listing-og` | all exit 0 |
| the whole-site rule | `grep -rn "'HTTP ' +" assets/*.js *.html` returns **one** line — `api-errors.js` building the operator's reason string. Nothing else makes a message out of a status |

**Three bugs this round found in its own work, all fixed.** Replacing
`throw new Error('Not authorised (HTTP 401)')` with a class-aware error left the console line as just
`401`, and `dev/postgrest-test.js` fails when the log stops naming what happened — so the reason is kept
beside the status, and the harness loads the new module so it exercises the same script list `admin.html`
does. Found by the suite, not by reading the diff. The second was two `throw new Error(body.error || 'HTTP 401')`
lines in `admin.js` that the first pattern — `'HTTP ' + r.status` — could not see, because they are a bare
literal rather than a concatenation; the invariant was tightened from "no concatenation" to "outside
`api-errors.js` the letters do not appear in code at all, comments removed", which is what found them. The
third came from reading the string **a real browser** produced rather than the code: `sentence()` glued a
class's screen title and its body together,
so a one-line slot (a toast, a modal's error line, a console warning) got a two-sentence paragraph —
"This is not switched on yet Nothing is wrong with what you did. …". It now prefers the class's own
`inline` sentence wherever there is one, and both halves are asserted.

**Could not run here:** the four failure classes the submission layer now distinguishes cannot be
*produced* by the live database — a table that exists is not missing, and a CHECK constraint no form can
violate does not fire — so those paths are proven against the classifier and against the real `submit.js`
driven with a stubbed fetch, not against production. Whether the live project answers `401` or `403` for a
missing grant is still unverified, which is why both map to the same class. A queued `not-ready`
submission is held rather than dropped, on the judgement that a deploy may finish — the copy says so
(“we will keep trying” plus the WhatsApp route) rather than promising it silently. And the operator
`audience` string is a judgement: it appends the wire facts for the dashboard and not for a student, which
is right for these surfaces and would be wrong for a page an outsider could read.

## 22. The other two break-ui fixtures, generated the same way

Round 4's admin fixture became a generator in §18: 45 declared status × tier × env cells, four payload
extremes, a record on every row saying which case it is there to exercise, and a suite that reads those
records back from the page. The two older break-ui fixtures were still hand-written, and both were the
same kind of liability:

| Fixture | Was | Is |
|---|---|---|
| [dev/listing-fixture.js](dev/listing-fixture.js) — the six listing-page datasets | six row literals and a hand-typed `EXPECT` table in the suite | a declared field · state matrix (**74 cells over 14 fields**), **nine** generated cases, a `plan()` and a `violations()` |
| [dev/complete-listing-harness.html](dev/complete-listing-harness.html) — the landlord invite seeds | five seed literals inside the harness, plus the failure classes | [dev/invite-fixture.js](dev/invite-fixture.js): a declared matrix (**43 cells over 20 fields**), **seven** generated seeds, the same `plan()` / `violations()` |

### Why "generated" is the point, and not just tidier

A hand-written case can describe data it does not carry, and nothing notices: the round-4 admin list had
no *active · tier 0 · production* row for months. So in both fixtures the declaration **is** the data.
A case names `['name', 'unbroken']` and the row is built from that name; `STATE_TEST` says what
`name·unbroken` means; `violations()` then reports, from the built row, a pair that does not hold, a
field declared twice in one case, a pair naming a cell the matrix does not have, and — the one that
matters most — a declared cell that no case exercises.

That check earned its keep while the fixture was being written. It caught, in order:

1. **the `media·exotic` test was reading urls, not labels** — the Arabic and Yoruba labels ride in the
   media objects, so a test that stringified the array saw only ASCII and the pair "did not hold";
2. **`pin_meta` was declared but never read** — the fixture's own reader looked up the wrong key, so a
   seed claimed metadata the check could not see;
3. **the 1-room seed had lost its whole reason to exist** — moving to a shared `rooms.present` made
   every seed say "3 rooms available", and `rooms·single` (the `1 room available` branch, where
   `1 rooms available` bugs live) was left uncovered.

### The listing page: the suite stopped typing expectations

`scripts/test-listing-render.mjs` used to hold a literal `EXPECT` table per case — ₦170,000 here, two
slides there. Now it derives every expectation from the row's own data by the rules the page documents
(`money()`, `tierBadge()`, `buildMedia()`, the amenities filter, `ArzuzMap.passage.normalise()`), so a
new case arrives already covered. The literal numbers were not thrown away: they became `ANCHOR`,
asserted against **the derivation** for the four cases whose data is byte-for-byte what it always was
(`demo`, `worst`, `empty`, `huge`). A derivation that quietly stops matching the page therefore fails
before it is ever used to judge one.

Three cases were added because the matrix had cells nothing reached: **`exotic`** (a non-Latin name,
type, area, description and gallery labels, rent 0, a youtu.be link), **`shapes`** (keys present but
empty, and the photo fallback), **`oddities`** (wrong types, a duplicate amenity, a list with no photo
at all). Nine cases × two widths make **467 checks**. The one number measured on the finished suite is
**336 s**, taken while other lanes were running their own headless Chrome; nothing in it separates the
suite's cost from the load it shared, so read it as an upper bound rather than as the suite's price.
That ambiguity is the runner's problem, not this suite's: `.test-timings.json` records every suite's
own time and never judges one against the built-in estimate, so a contended run shows up as a learning
line and not as a verdict.

| Check | Result |
|---|---|
| `node scripts/test-listing-render.mjs` | **TOTAL 467 · PASS 467 · FAIL 0**, exit 0 — 5 plan checks + 9 cases (25–28 checks each) × desktop 1440 / mobile 390 |
| `node scripts/test-fixture-plans.mjs` | **TOTAL 88 · PASS 88 · FAIL 0**, exit 0 |
| `node scripts/test-all.mjs --only=listing-render` | passed |
| `node scripts/test-all.mjs --only=fixture-plans` | passed — it reads all three fixtures and both documents now |
| the invite harness, walked in the browser | `?seed=worst` prefills the real form from the generated row, field by field: `cl_prop_name` **62** chars, `cl_ar` **45** (diacritics + emoji), `cl_rent` and `cl_ask` both `1250000`, `cl_units` `0`, `cl_nm` **44**, `cl_ph` `+234 803 345 5667`, `cl_desc` **1578**; the in-page toggle carries the fixture's own seven labels; `?seed=view` renders the same row with **0 editable controls** — 16 fields, all read-only, and both save buttons unrendered |

### The invite fixture, and the harness it replaced

The seeds now live in [dev/invite-fixture.js](dev/invite-fixture.js), generated from the same kind of
matrix, and the harness loads them — it no longer defines a single seed value of its own.

`scripts/test-fixture-plans.mjs` (new, Node-only, no browser, no server, registered in
`scripts/test-all.mjs` beside the browser suites) is what keeps them honest on a push:

* **the fixture's own verdict** — `violations()` empty, and every declared cell exercised;
* **the values the fixtures hold** — the worst invite still has a 62-character name, ₦1.25m rent *and*
  ask, 0 units, a 1,578-character blurb, twelve amenities with a case-duplicate and a 51-character
  label, 40 media with two share links (youtu.be and Drive), and a three-line landmark; the listing
  fixture still has the 61-character unbroken name, `150,000`, the unparseable `verified` tier, seven
  amenities of which four survive, 50 media / 40 features / 12 steps / `123456789` on `huge`;
* **the numbers in the prose** — sections 3 and 4 read this report and README.md and demand every value
  they quote, and every phrase either looks for is BUILT from a value the fixture just reported, so a
  doc can only fail by disagreeing with the data it describes. Section 4 also reads the third fixture,
  [dev/admin-mock-data.js](dev/admin-mock-data.js), from Node — it needs no DOM — and checks the
  README's admin paragraph and the fixture's own `why` tooltips against the rows it builds. They caught
  five wrong numbers on the proving run: "one 53 characters long" just above (the label is 51), the
  "≥45-character label" this bullet used to carry, the invite fixture's own `worst` note, which called
  its seed "a 70-character name" and "an 1,800-character blurb" (62 and 1,578), and this table's `TOTAL`
  row, which now has to name the count the suite actually runs;
* **fixture ↔ harness drift** — the `?case=`, `?seed=` and `?fail=` documentation lines, the failure
  classes the harness scripts, and the seed labels must match what the fixture publishes. This is how
  the listing harness's stale `?case=demo|worst|halfpos|empty|one|huge` line was caught the moment the
  three new cases existed.

### The admin fixture's "ceiling" row was not at the ceiling

Reading the third fixture the same way found something prose alone could not: `max-ceilings` built a
**58**-character name and a **58**-character area, while the README, the fixture's own comment and its
`why` tooltip all said 70 and 80. The builder padded ten characters onto each and then sliced to the
form's `maxlength` (name 70, area 80) — and `slice` on a string that is already shorter than its limit is
a no-op. So the row that exists to test the ceiling tested 58, and only the docs hinted that it should
not have.

Here the **docs were right**, which is why the fix is in the builder and not in four paragraphs: pad to
the limit first, then slice, and the row is the 70/80 it is described as. That is not a cosmetic change,
and it was verified as one: the admin suite was re-run on it and is **TOTAL 65 · PASS 65 · FAIL 0**, exit
0 — the worst case at 1440, 390 and 309 px, all 11 / 11 / 7 / 7 checks green, with the table now
**~1,690 px inside a 1,162 px pane** on a row that is genuinely at the form's limits, so the clamp holds
where it is now harder to hold. That is a measurement, not a pinned value, and the two consecutive runs
say why: 1,691 then 1,690 px for the same row, which is exactly why the check bounds the table *relative*
to its pane (700 px of headroom over the 2,343 px / 991 px regression) instead of typing a font metric. Had it failed, the fix would have belonged in the board, not in a
sentence.

### What is not covered here

The invite page's own gap is closed. §13's seeds were checked as data by the plan suite and otherwise
only walked by hand, so a seed that renders wrongly on that page was found by eye first;
[scripts/test-invite-render.mjs](../scripts/test-invite-render.mjs) now loads the real page through
`dev/complete-listing-harness.html` for every seed at 1440, 390 and 320 px and derives what it expects
from the row the mock RPC actually held — read back over HTTP, with a sentinel proving the seed reached
the page and a per-key comparison against the fixture proving the harness did not mangle it. The worst
seed is also saved, and the patch it collected is read off the mock, including the row that must go to
`avail: occupied` rather than advertise a vacancy it does not have.

What is still not covered: the listing page has no fault-injection for the new cases either — `test-all`'s two fault modes run
`--case=worst,huge` as before, so recovery is proven on the same data it always was.

**Attribution, corrected — and since resolved.** §18 recorded a `test:postgrest` failure seen minutes
after the round-4 suite went green (`the console is told what happened` → `nothing was logged:
["warn: [Arzuz Admin] 401"]`) and blamed a concurrent lane. The failure did not survive: the last
`npm test` on this tree is **10 of 10 suites passed**, postgrest included (27.8 s when first seen,
7.1 s on the re-run for this line), with nothing changed here in between.

What survives of the attribution is weaker, and is worth stating only at the strength the evidence
supports. `dev/postgrest-test.js` reads `assets/admin.js` and its own recording,
`dev/postgrest-fixture.json`, and names none of the fixtures this work touches — no `*-mock-data`, no
`?seed=`, no `listing-fixture` or `invite-fixture` — so the fixture work cannot have caused it, which
is the part that matters. Who edited `assets/admin.js`'s `onAuthError` log line
(`err.detail || err.message`, so a 401 logs `401` where that suite expects the sentence), and when, I
still cannot say: the tree carries a large uncommitted delta and its file times are not a reliable
witness, because the clock moved during this work. The habit this leaves behind is the one that
answered the question — re-run the failing suite alone, on the tree you actually have, before believing
a sweep or blaming a lane.

# Round 5 — the invite page's browser suite (2026-10-11)

## 23. Seven seeds, asserted on the form instead of by eye

§13's seeds were checked as data by `scripts/test-fixture-plans.mjs`, and their rendering was checked by
walking `dev/complete-listing-harness.html`. [scripts/test-invite-render.mjs](../scripts/test-invite-render.mjs)
closes that: it drives the real `complete-listing.html` in headless Chrome through the same harness, once
per seed at 1440, 390 and 320 px, and asserts on the form that came out — every field's value, the
availability trap, the amenity chips, the capped media grid, the read-only link, and nothing overflowing
at any width. 953 checks (§24), and one save.

Three things it is careful about, because each is a way a suite like this passes without proving anything:

* **the expectations are derived.** The page's own rules are restated once — in
  [scripts/page-rules.mjs](../scripts/page-rules.mjs), not in the suite (§24) — and applied to the row the
  mock RPC was actually holding when the page read it — fetched back over `/mock/sb/last-patch`, not read
  from `dev/invite-fixture.js` — and that row is compared key by key against the fixture's own seed, so a
  payload the harness mangled is reported as the harness's fault and not the page's.
* **the seed is proven to have arrived.** Before each load the mock is seeded with a sentinel name and the
  row is required to have moved off it: a harness that fell back to the demo row (`?seed=` it does not
  recognise) would otherwise have this suite assert the demo row against itself, and pass.
* **a load that never booted is a named failure, not a quiet pass.** The page's `⏳` card is not a resting
  state, so two identical reads on it mean "nothing has happened yet": the suite waits out its render
  timeout and then reports the URL, the failed requests and what the document actually reads. (That was a
  real bug in this suite — a stalled load was first accepted as settled, and the empty form it judged was
  reported as 26 page failures.)

The round trip is where the form's own scar is checked. Pressing **Save draft** on the worst seed sends
exactly one patch, read back off the mock: the 62-character name with the `name_generated: false` that
goes with it, ₦1.25m in both price boxes, 11 chips from the 12 stored amenities, all 40 media items with
the youtu.be tour and the Drive copy, the pin and the three-line landmark as the passage. And the
0-units row — `avail: 'occupied'`, `units: null`, `rm: 'Fully occupied'` — the bug §13 fixed, now
asserted on the wire rather than at the widget.

**Verified:** `node scripts/test-invite-render.mjs` → **TOTAL 953 · PASS 953 · FAIL 0**, exit 0 on two
consecutive runs, 35s wall. Wired into the runner as a Chrome suite:
`node scripts/test-all.mjs --only=invite-render` → 1 suite passed (21.7s), exit 0; `--self-test` → 55/55,
exit 0 (the lane plan still drops no suite); `node scripts/test-fixture-plans.mjs` → 88/88, exit 0, after
every doc edit in this round.

**Still not covered:** the form's scripted failure classes (`?fail=…`, the eight platform and offline
bodies) are walked by hand and by nothing in a browser; and the wrap behaviour is measured in Chrome
and Edge, never on a real handset. The third gap named here — *"the suite has no fault-injection mode
… so a lost `/assets/complete-listing.js` is diagnosed as a load that never booted rather than repaired
and re-judged"* — **is closed in §28**: the suite has `--fault-inject` now, and the harness repairs the
page the way `dev/listing-harness-boot.js` does it.

## 24. One restatement, and the pass at the width a phone reports

Two follow-ups landed on top of §23, and the second one found a bug in the first's own harness rather
than in the page.

**The rules moved out of the suites.** Each browser suite judges a page by restating that page's rules
and applying them to the row the page was given — that is what makes an expectation worth having, since
one copied from the page's current output proves nothing. But a restatement that lives inside a suite
drifts the moment the *other* page's suite is edited: one file gets the rule, the other keeps asserting
last month's behaviour, and both go green.
[scripts/page-rules.mjs](../scripts/page-rules.mjs) is now the one place either page's rules are
written down: `INVITE` (complete-listing.html: `cleanUt`, the media rule, the 12-tile cap,
`availState`/`roomsText`, both availability notes, the legacy role table, and `wireChecks` — what the
patch the page collects must say) and `LISTING` (listing.html: `money`, `buildMedia`'s de-duplication,
the amenities grid, `passage.normalise`, `tierBadge`, the hand-verified `anchor` table, and the gallery
classes the suite counts). The two sets differ on purpose — the invite form does not de-duplicate media
by url — so sharing *them* would be wrong; sharing the *statement* of them is the fix. The three
overflow rules are stated there once too and the scanner both suites inject is built from them, and the
width table lives there so neither suite can sweep a width the other was never told about. It runs
standalone — `node scripts/page-rules.mjs` → **TOTAL 16 · PASS 16 · FAIL 0** as this round left it
(**20** once §26–§27 added the four pins below) — and `verifyPageRules()`
reads the pages back: `GRID_CAP`, `MAX_UNITS`, the role vocabulary, the legacy answers, both stylesheet
floors the new pass asserts (`minmax(min(104px, 100%), 1fr)` and `.cl-actions .next { min-width: 190px }`),
every sentence a suite asserts by equality (18 invite pins, 7 listing pins), the 24 ids and 13 classes the
invite probe reads, the 17 selectors its overflow scan walks, and the gallery classes the listing probe
counts. Each suite calls the half that describes its own page plus the shared layout vocabulary, so the
shared file cannot go stale in one suite while the other is updated.

That mechanism was proved by letting it fail: the pins were written, then run, and the first run went
red on exactly the two things that had already drifted inside the suites — `unitsTypo`, a sentence the
page assembles from `MAX_UNITS` rather than storing whole, and `__fx-diag`, an id the listing *fixture*
writes rather than the page. Both were fixed in the restatement, which is the direction the failure is supposed to
push.

**The 320px pass.** §23 measured 1440 and 390 px with tab 1 open, which is all a width-agnostic pass can
see: the staged grid lives in a hidden panel until tab 3 is clicked. The pass at 320 — the width budget
real handsets report, and the width this page's own stylesheet names ("at 320px two 118px tiles do not
fit") — opens tab 3, measures the settled layout there, closes it again, and holds three things to the
viewport it actually got: the availability note (the only place the page says typing 0 stores the row as
fully occupied), the capped grid (two tiles still side by side, the "show all" button still a full-width
row rather than a sliver, nothing overflowing with the panel open), and the action bar (all three buttons
on screen, inside the viewport, at least 36 px tall, overlapping nothing, with the send button holding
its declared 190 px floor). It also reports whether the pass left the page on the tab it opened on, so a
pass that measured the wrong state cannot pass by measuring something.

The second run found one real bug, and it was the harness's: the "every tile is inside the viewport"
check required at least one tile, so the `blank` seed — a link with no row at all, and therefore an empty
grid — failed a check about tiles it does not have. The fix asserts the count separately and, where the
seed has no media, that the grid still shows its "no media yet" paragraph whole. Nothing in the page
broke at 320: the layout holds, which is a measurement rather than a claim — all 21 loads (7 seeds × 3
widths) are green, 13–18 narrow checks each, the two-tile row measuring ≥ 104 px per tile as the
stylesheet's floor requires.

**Verified:** `node scripts/test-invite-render.mjs` → **TOTAL 953 · PASS 953 · FAIL 0**, exit 0, 35s
wall; `node scripts/test-listing-render.mjs` (all 9 cases × 2 widths) → **TOTAL 470 · PASS 470 · FAIL 0**,
exit 0, after the same rules were pulled out from under it; `node scripts/page-rules.mjs` →
**TOTAL 16 · PASS 16 · FAIL 0**; `node scripts/test-all.mjs --only=invite-render` → 1 suite passed, exit 0;
`node scripts/test-fixture-plans.mjs` → 88/88, exit 0. (Those counts are this round's; §26–§28 moved
them — the restatement gained four pins and the suites gained checks — and that section quotes the
current numbers.)

## 25. The class rides with the sentence, so the two ends agree on more than wording

### The finding

§21 gave every page one vocabulary and left the wire saying only a sentence. A page that failed read the
number back and guessed, and two digits carried two meanings each — only the function knows which one it
is standing on:

| digit | what it means there | what it means here |
|---|---|---|
| `404` | a route, table or function **this deploy does not have** — nothing the person can do, and a deploy may still be landing (`not-ready`) | **"We do not recognise that Care link"** / "we could not find that profile" — the link *is* the credential and has to be replaced (`rejected`) |
| `503` | **this deploy has no service key yet** (`not-ready`) — a deployment fact | briefly unwell, try again in a minute (`error`) |

Both readings were already in the code, as behaviour. The roommate page answered *every* `503` with "not
switched on yet on this deployment", including a bad minute; the Care page read any `503` the same way,
and identified a refused link by matching the **words** of the sentence — so a copy edit ("We do not
recognise that Care link.") would have silently turned a dead link into an outage screen, leaving the
student holding a key that can never work. And when the number was genuinely all a page had, the Care
page deleted the student's only key on a `404` that was a half-finished deploy.

### What changed

| file | the change |
|---|---|
| `assets/api-errors.js` | both ends of the wire, in the module both sides already share: `wireBody(status, body, kind)` stamps the class onto a failure body and leaves a success body **byte-identical**; `withKind()` keeps the class a function chose, derives the rest, and **discards a name that is not in the vocabulary** rather than putting a seventh class on the wire a page would classify as nothing; `failed(res, body)` is the one reader a page uses for one of our own answers — the server's sentence, the class and the operator's facts on one error |
| `netlify/functions/*.js` (nine that answer JSON) | every one `require`s **the same file the pages load** (`../../assets/api-errors.js`) and stamps its failures through `wireBody`, so the two ends cannot drift and a new function cannot forget. `listing-og` answers an image, `video-embed` an HTML page, `roommate-digest` is a timer |
| 21 call sites, named only where the digit reads wrong | `care-credit` (refused link `rejected`, dashboard door `expired`, both config `503`s `not-ready`), `roommate-match` (three refusals, config `not-ready`), `team`, `strategy-docs`, `roommate-digest-preview`, `notify`, `whatsapp-send`, `cloudinary-sign`, `youtube-upload-start` (a `503` riding the handler's own throw). Everywhere else — 54 failure answers — the class is derived from the status, which is what it means |
| `assets/my-care.js`, `assets/roommate.js` | branch on the class where the number is **destructive** rather than merely unhelpful: the Care page deletes the student's stored link on a refused one and must not do it for a half-finished deploy; the roommate page offered to withdraw a profile and told a bad minute it was a switch that was never flipped. The sentence (Care) and the digit (roommate, only when no class is present) stay as the second signal, so a deploy still serving the older body behaves exactly as it did |
| the page modules | `failed()` is now the only way a page reads one of our own answers, and `scripts/test-api-errors.mjs` fails the build if a module that talks to a function stops reading the class back |
| `dev/my-care-test.js`, `scripts/test-api-errors.mjs`, `README.md` | the harness loads the classifier the page loads (43 checks), the suite grew 54 → 87, the README says how a failure travels |

### Verification for this round

| Check | Result |
|---|---|
| `npm test` | **10 of 10**, exit 0 — roommate 72, care 58, **my-care 43**, admin 202, postgrest 27, care-live 20, draft-errors 15, **api-errors 87**, sql:proof 131, sql:guards 26 = **681** |
| the real handlers, through a throwaway HTTP shim (no Netlify CLI offline) — **a deploy with no key** | `care-credit` `503` **not-ready**; `team` `503` **not-ready**; `cloudinary-sign` `500` **not-ready** (a 5xx that is a deployment fact, not a bad minute); `strategy-docs` `401` **expired**; `whatsapp-send` `400` **rejected** (derived); `notify` `200` with **no class at all** |
| the same handlers with a stand-in service key present | `care-credit` `404` **rejected** — the refused link — where *the same request* answers `503` **not-ready** without the key; `care-credit` `502` **error** (derived); `team` `401` **expired**; `whatsapp-send` `503` **not-ready** where that same function's `400` is `rejected`; `youtube-upload-start` `503` **not-ready** |
| a real browser, the real page, the real function | `my-care.html` against a deploy with no key → *"Care is not switched on for this site yet."* plus the function's own sentence, and **the link is kept**; the same page against the `502` → *"We could not open your Care account."*, link kept, `careGone` not shown |
| the roommate page, the same way | the real `503 not-ready` → the "not switched on yet" line, one `.rm-err`, and **no stale "Loading your matches…"** left underneath |
| negative control | putting the Care page's `404` branch back on the sentence alone fails **both** the behavioural check in `dev/my-care-test.js` and the source-level check in `scripts/test-api-errors.mjs` (86 passed, 1 failed); restored and re-verified |
| `node scripts/test-site-audit.mjs` | **321 · PASS 321 · FAIL 0** — every page still loads the classifier before anything that consults it |
| `node scripts/test-deploy-guards.mjs` | **PASS 71 · FAIL 0** |

**A bug the browser walk found, and fixed.** The roommate page put a "Loading your matches…" placeholder
in the panel before it asked, and never removed it when the ask failed — so a student on a deploy with no
matching service read the error *and* a line claiming we were still working on it. `paintError` drops the
placeholder first now, which is what the last row above measures.

**The harness had the same blind spot as the page.** `dev/my-care-test.js` loaded `config.js` and
`my-care.js` but never `assets/api-errors.js` — so the suite had only ever exercised the page's
*no-classifier fallback*, and the class the server now names was never read by the thing that tests it.
It loads the module in the page's own order now, the two existing fixtures carry the classes the live
functions send, and two checks were added: the class decides a refused link **even when the wording
changes**, and a `503` that is not this deploy's configuration is not called "not switched on". The
fixture was made faithful *after* the wire changed, which is the mistake worth naming: a fixture that
describes an older server tests the older page and passes.

### What is not covered here

No `netlify dev` — no Netlify CLI offline — so what was driven is the **handlers**, with the platform's
own plumbing (redirects, headers, `included_files`) absent; that plumbing is covered by
`scripts/test-deploy-guards.mjs`, not by this walk. The refused-link `404` cannot be *produced* by a live
database from here: it is proven by the real handler's body and the real page with the transport stubbed,
which is one step short of the deployed site answering it. The stand-in service key that reaches the
`404 rejected` branch is a stand-in — its Supabase calls fail, which is why the neighbouring row reads
`502`. `assets/roommate.js` had **no suite of its own** at this round: its five branches were walked by
hand in a browser and the check that pinned the page's classes was a source-level one. (§31 closes it.)
And a returning visitor whose
browser holds the old JavaScript keeps working: `failed()` prefers the server's sentence, so the class is
an addition to the wire, not a requirement of it.

# Round 6 — one statement with four readers, the phone width, and the repair the invite page never had (2026-10-11)

## 26. The fourth reader of the overflow rules

§24 pulled the three overflow reasons into [scripts/page-rules.mjs](../scripts/page-rules.mjs) and built
both browsers' scanners from them — but only two of the three scanners followed. The admin dashboard's
suite ([scripts/test-admin-worst.mjs](../scripts/test-admin-worst.mjs)) kept its own copy, and its copy
had already drifted: it said **`clipped, and nothing scrolls to it`** where the other two say
**`content clipped`**, and its suite header had the third sentence retyped again. Nothing held that
fourth reader to the statement, which is exactly the failure §24 exists to stop, one reader further out.

The suite now imports `LAYOUT_RULES` and interpolates the three sentences into the scan string it runs
in the page, so the dashboard's scanner is built from the same words as the invite suite's injected scan
and the listing fixture's copy.

**Held to it, not just told.** `verifyLayoutRules()` reads
[scripts/test-admin-worst.mjs](../scripts/test-admin-worst.mjs) back and fails if any of the three
sentences reappears there, or if it stops naming `LAYOUT_RULES`. The second half matters as much as the
first: a suite that simply deleted the words would satisfy a "does not restate" check while judging
nothing. Both directions were proved by letting them fail — appending a comment containing
`box escapes its parent` to the suite turned the pin red on exactly that rule (**TOTAL 20 · PASS 19 ·
FAIL 1**, exit 1) and the file was restored byte-identically.

`verifyPageRules(scope)` also had a documented contract it was not keeping: its comment says each suite
asks for *"the half that describes its own page, plus the layout vocabulary both pages are scanned
with"*, but the code returned only the page's own half — so the layout pins ran **only** in the
standalone run, and a drift in the shared vocabulary would have gone unnoticed by the suites that
depend on it. Every scope now carries `layout`, which is what makes "the fourth reader is held to one
statement" true of the suites and not only of `node scripts/page-rules.mjs`.

## 27. The listing page at the width a phone reports

§24 gave the invite page a 320px pass because a width-agnostic sweep cannot see a hidden panel. The
listing page has no panels — everything the student reads is in the first render — but it had never been
measured at a phone's own width either: its suite swept the shared table's `desktop` and `mobile` and
ignored the third entry, so the one number each suite was told about (§24's "one table, so a suite
cannot quietly sweep a width the other one was told about") was only half true.

`LISTING.widths` now includes `WIDTHS.narrow`, and every case is measured at 320 alongside 1440 and 390.
On top of the ordinary checks — which already assert no overflow at every width — the 320px pass takes a
second measurement of the same document and holds the three things a squeezed screen breaks first to the
viewport it actually got:

* **the gallery** — the stage on screen, the frame on screen full-bleed, no frame narrower than the
  stage (a shrunken frame leaves a stripe of the next photo), the counter on screen and still reading
  `1 / 50`, and the thumbnail strip on screen with real tap targets;
* **the price** — the row, and the number the student decides on, inside the viewport and still the price
  the row earns;
* **the map placeholder** — the route card's map box keeping the height its stylesheet declares even when
  Leaflet never draws into it, and no map box at all when the pin is incomplete.

The floors are read out of the page, not invented: `verifyListingRules()` now pins `.gal`'s own
`aspect-ratio: 16 / 10` and `.route-map-wrap #routeMap`'s `height: 380px` (out of
[assets/arzuz.css](../assets/arzuz.css), since `listing.html` carries its stylesheet by link), and the
pass asserts on those pins.

**What the pass found, and what was done about it.** Two checks failed on the first green-ish run, and
they were not the same kind of thing. At 50 media items every frame came out **at or above** the stage's
width — 271 → 283 px as the row was read — so a flat "every frame is the stage's width" assertion was not
true of *that measurement*, and the assertion was weakened to the one that describes a breakage rather
than a rounding: no frame may be **narrower** than the stage. The other failure was the harness's own
tolerance: for the `no media` seeds the placeholder frame came out 2 px narrower than the stage.

> **Corrected in §29.** There was no drift to describe. The pass was measuring the gallery *mid
> entrance*: `.gal` carries `[data-rise]`, whose transition is a `perspective()`/`rotateX` transform, and
> while it runs the browser projects the 50-slide row through it — so a frame's rect grows with its
> distance along the row even though every frame is the same width in layout. Read settled, all 50 frames
> measure the stage exactly. The weakened bound was therefore relaxed around a defect that did not exist,
> and §29 makes the pass measure a settled page and asserts flat uniformity.

## 28. A lost script on the invite page, and the harness that puts it back

The listing suite has been able to lose a boot-critical script on purpose since §19; the invite page
could not, and the asymmetry was not cosmetic. Every layer `complete-listing.html` names except the
page's **own** boot script is reached through a `typeof` guard, so losing `api-errors.js` or
`arzuz-map.js` degrades one feature — but losing `/assets/complete-listing.js` stops the form dead on its
loading card with nothing in the console, and the suite reported that as *"the page never settled"*. That
is a lost request wearing a page bug's clothes, which is the one thing this pairing exists to prevent.

**The repair lives in the harness, where the listing page's already does.**
`dev/complete-listing-harness.html` now preflights every *local* script the page names (three tries,
120 ms apart) before it writes the document, and injects
[dev/complete-listing-harness-boot.js](../dev/complete-listing-harness-boot.js) last, which confirms the
layer the boot needs is on `window` and reloads **once** with `?hreload=1` if it is not. A second miss is
left alone, because a script that is genuinely gone must still fail the run. Two differences from the
listing harness, both named in the file: Leaflet's CDN `<script>` is not preflighted (a machine with no
network is allowed to fail it), and there is **no** stylesheet guard — this page links Leaflet's sheet
from unpkg, and a guard that counted it would turn an offline laptop into a page verdict.

The one thing the harness needs to ask *"did the page's own boot run?"* is a name for that script, so
[assets/complete-listing.js](../assets/complete-listing.js) now ends by assigning
`window.ArzuzCompleteListing` — inert, one line, and the only global on this page that proves which file
ran. Its line endings were preserved (1,470 CRLF, no LF-only lines). The two ends of that contract are
held against each other before a browser opens: the suite derives the required global from the harness's
`LAYER` map and requires the page to *assign* it. The first version of that check used a substring match
and passed when the marker was renamed to `…Renamed` — a pin that looked like evidence and was not; the
assignment form was verified by renaming the marker and watching it go red, with the reason in the
message.

**The mode.** `--fault-inject` loses one boot-critical request per load at the network layer (Chrome's
own request metadata tells the parser's request apart from the harness's preflight `fetch`), then
requires the harness to answer it: the drop must have landed, the boot must be `ok-after-retry`, and —
the part that matters — every ordinary check runs against the **recovered** page, including the round
trip that presses **Save draft**. The candidates are derived, never copied: the harness's `LAYER` map
intersected with the scripts the page actually names, so dropping a script tag from the page shrinks the
list the same way. Like the listing suite it refuses to run when the drop never lands, and a load Chrome
served from its own copy is reported as having cost nothing rather than counted as a recovery.
`--fault-drops=2` kills the retry's copy too and is the **control**: it must leave the run red, and it
does — with the reason in the failure (`… this is the control: an unrecoverable loss is meant to be
fatal`), and with the consequence visible rather than asserted: `assets/data.js` gone on both loads left
the room-type select empty, which is what the checks then reported.

**Verified, on the final bytes:** `node scripts/test-invite-render.mjs` → **TOTAL 979 · PASS 979 · FAIL 0**,
exit 0 (21 loads, 7 seeds × 3 widths; up from §24's 953 because every load now also asserts the harness's
own boot verdict and the plan gained the two marker preconditions).
`node scripts/test-invite-render.mjs --fault-inject --width=desktop --seed=worst` →
**TOTAL 80 · PASS 80 · FAIL 0**, exit 0, the loss landing and the harness answering it; two further
single-load runs lost `assets/complete-listing.js` and then `assets/arzuz-map.js`, both came back
`ok-after-retry` with every check green, and the first of them **including the save round trip**
(the `worst,view` sweep at one width: **TOTAL 122 · PASS 122 · FAIL 0**, exit 0).
`--fault-inject --fault-drops=2` → **TOTAL 80 · PASS 77 · FAIL 3**, exit 1, the control failing as it must.
`node scripts/test-listing-render.mjs` (all 9 cases × 1440/390/320) → **TOTAL 813 · PASS 813 · FAIL 0**,
exit 0, up from §24's 470 across two widths. `node scripts/page-rules.mjs` →
**TOTAL 20 · PASS 20 · FAIL 0**, exit 0.

**Wired into the gate:** the runner gains a suite (`invite-fault`: `--fault-inject --width=desktop
--seed=worst`) so the repair is exercised on every push rather than by hand, and the listing entry's
label now says the three widths it actually sweeps.

**Still not covered here.** The invite page's fault mode has one family (a lost script) and no control
entry in the gate, by design — the `--fault-drops=2` control is meant to be red, so it cannot be a gate
suite; the listing suite's preflight and stylesheet families stay listing-only, because the invite
harness deliberately has no stylesheet guard. The wrap behaviour of either page is still measured in Chrome and Edge only, never on a real handset.
(§27's "50-item frame drift" was not a property of the page at all — §29 removed it by measuring the
settled layout, so there is nothing left unfixed there.)
## 29. The gallery drift that was never in the gallery

Asked for: make every slide exactly the stage's width at 50 items instead of drifting up to 12 px wider,
then tighten the 320px pass from "no frame narrower than the stage" to flat uniformity. The first half
turned out to be the wrong job.

**What the pass was actually measuring.** `.gal` carries `[data-rise]`, and on this page that entrance is
a `perspective(1000px) translate3d(0, 30px, 0) rotateX(8deg) scale(0.985)` transition
([assets/arzuz.css](../assets/arzuz.css) — the gated rule at 2135-2143, its reduce block at 2289-2296).
The fixture's diag says the *listing* has settled, not the *motion*, and the 320px readout ran ~0.35 s
after the reveal started, while `.gal`'s computed transform was still a `matrix3d` — mid-transition,
`rotateX` around 4.6°. A 50-item gallery is a **13,600 px row inside a 271 px stage**, and while that
transform is live the browser projects the whole row through it, so a frame's `getBoundingClientRect()`
grows with its distance along the row. Measured on the same load:

| probe | frame 0 | frame 5 | frame 25 | frame 49 |
|---|---|---|---|---|
| rect width, mid-entrance | 270.8 | 280.5 | 324.2 | 376.7 |
| `offsetWidth`, every frame | 272 | 272 | 272 | 272 |

and the stage itself (`galRaw`) was `w 270.8, ow 272`, with the track the same 270.8. Every frame is the
same width **in layout**; only the projection differed, and the same page measured settled — the harness
open in a normal browser after the entrance — reports all 50 frames at 260.667 px against a 260.667 px
stage. Two runs of the same assertion gave +12 px by frame 50 and +64 px by frame 50: the number was a
function of *when the readout landed*, which is the signature of a moving page, not a rounding.

**The fix is in the pass, and no page file moved.** The runner now emulates `prefers-reduced-motion:
reduce` once, before the sweep, exactly as `test-invite-render.mjs` has since §24 — the settled layout,
and the layout a visitor who asks for it gets. Under it `motion.js` applies the reveal in place and the
stylesheet's matched-specificity reduce block zeroes the transform and its transition, so there is
nothing to project through. `listing.html` and `assets/arzuz.css` are untouched by this round: the
"drift" was never theirs to fix.

**And the pass now says so itself, in two pins per 320px load.** The first is new and asserts the
*measurement*, not the page: `matchMedia('(prefers-reduced-motion: reduce)').matches === true` **and**
`.gal`'s computed transform `=== 'none'`. The second is the assertion the round asked for — every frame
within **1 px** of the stage (was: not narrower than the stage, i.e. a 2 px allowance downward only),
which now also covers the `no media` seeds' placeholder frame. The 2 px allowance that §27 kept for that
placeholder was an artefact of the same mid-flight reading; nothing needed it after the fix. The old
behaviour is *reported* the way it always was: the failing check prints the frame widths, the last
frame's left, the track and the transform.

**Both directions proved.** With the emulation call flipped to `features: []`, the pin that goes red is
the new one — `✗ the page was measured settled (reduced motion, and the stage carries no entrance
transform) → {"reduced":false,"transform":"none"}` — and the file was restored byte-identically
(`cmp` clean) after the run. Note what that run also shows: the *width* assertion passed there, because
that readout happened to land after the transition finished. The drift is intermittent, which is exactly
why the precondition is asserted rather than inferred from the widths being uniform today.

**Verified, on the final bytes:** `node scripts/test-listing-render.mjs` (all 9 cases × 1440/390/320) →
**TOTAL 822 · PASS 822 · FAIL 0**, exit 0. `--width=narrow` over five cases → **TOTAL 209 · PASS 209 ·
FAIL 0**. `--fault-inject --case=worst,huge` → **TOTAL 219 · PASS 219 · FAIL 0**, 6 of 6 loads faulted
and all 6 recovered by the harness. `--fault-inject --fault-css=1 --fault-victims=0 --case=demo` →
**TOTAL 22 · PASS 22 · FAIL 0** (the css family keeps its style guard and skips the narrow verdicts by
design). `node scripts/page-rules.mjs` → **TOTAL 20 · PASS 20 · FAIL 0**.
`node scripts/test-fixture-plans.mjs` → **TOTAL 88 · PASS 88 · FAIL 0**.
`node scripts/test-all.mjs --self-test` → **71 passed, 0 failed**, `--list` → no unwired suite.

**Not covered here.** The transient is real but invisible, and was left alone: during the 0.8 s entrance
a frame's projection grows with its distance along the row, but only the first frame is on screen — and
frame 0 measured 270.8 px against a 270.8 px stage mid-flight, with the one-pixel sliver of frame 1 about
1.7% wide. Nothing on the page was changed for it. The 320px pass remains Chrome/Edge at an emulated
width; no real handset was involved, and the other two asks that arrived with this one — fault injection
for the admin dashboard and home-motion browser suites, and driving the invite page's eight scripted
failure bodies in a browser — are not part of this section.
## 30. The eight failures, in a browser, in front of a landlord

Asked for: point the invite harness's existing `?fail=` knob at all eight recorded failure bodies (plus
the empty answer) and assert, for each, the sentence the landlord is given and the class the page chose.
This is the last mile of §20–§22, which recorded those bodies off the live project and pinned what they
MEAN — but never drove one to a page.

**What was already there, and what was missing.** `dev/complete-listing-harness.html` has taken
`?fail=get-missing|get-refused|get-bad-token|update-missing|update-refused|update-busy|update-unwell|
update-offline|no-row` since §20 and hands the class to `dev/upload-mock-server.mjs`, which answers it
in the recorded shape (`{status, code, message}`, or `drop: true` for a connection that never arrives).
Nothing drove it end to end: the bodies were classified in Node by `scripts/test-draft-errors.mjs`, and
the keys were only pinned as *documentation* (`scripts/test-fixture-plans.mjs` compares the harness's own
list with the fixture's). So the wiring from a failed RPC to a sentence on screen was walked by hand.

**Two halves, both derived.** `--fail-bodies` loads the harness once per class and builds each verdict
from:

* **what the platform answered** — read back off the mock (`GET /mock/sb/last-patch` now carries the
  fail config, one line in [dev/upload-mock-server.mjs](../dev/upload-mock-server.mjs)). It is the same
  body the page's own `fetch` received, so a load where the scripted failure never reached the page
  cannot pass by accident;
* **what that body means, and what to say about it** — [assets/draft-errors.js](../assets/draft-errors.js)
  itself, `require()`d by the suite and classified in Node from that recorded body.

The page then has to match it in the way the class allows: the dead-link card for a failure on the way
**in**, with its `#clDeadTitle` **and** `#clDeadBody` equal to the module's own sentences word for word;
for a failure on the way **out** (a save) the form and its contents kept — a save that did not happen is
a fact about the last minute, not a reason to throw somebody's work away — with the note equal to the
module's inline sentence for that class. Either way nothing may reach the backend, and the page must not
be showing its "could not finish loading" fallback, which is what a `draft-errors.js` that never loaded
would produce. The class the page *chose* is asserted too: the page already announces it on the console
(`[complete-listing] <kind> — <the platform's own words>`) and the suite compares it with what the
classifier derives from the body, so a page that skipped the classifier and composed its own sentence
fails here even if the words happen to match.

The only change to page-side files is one line of mock and two ids: `INVITE.dom.html` in
[scripts/page-rules.mjs](../scripts/page-rules.mjs) gains `clDeadTitle` and `clDeadBody`, which the
probe now reads, so the existing pin ("every id the invite probe reads is still in
complete-listing.html") covers them like the other 24. `complete-listing.html` and
`assets/complete-listing.js` are untouched: the page was already right, and this section is the first
thing that says so with evidence.

**Verified, on the final bytes.** `node scripts/test-invite-render.mjs --fail-bodies` → **TOTAL 105 ·
PASS 105 · FAIL 0**, exit 0: nine loads, 10 checks each for the four dead-card classes and 8 each for the
five save classes, plus one check that all nine were driven. (§32 adds the link to the number and takes
the same run to **TOTAL 121**, 14 per dead load.) The normal sweep is unchanged and green:
**TOTAL 981 · PASS 981 · FAIL 0** (up from §28's 979 by the two new plan pins below), and the fault mode
**TOTAL 82 · PASS 82 · FAIL 0** with the `--fault-drops=2` control still red at exit 1. Two new plan pins
run in *every* invite run, before a browser opens: the harness must accept every class the fixture
declares plus `no-row`, and every class must name the route it fails on (`get-…` / `update-…`), because a
key the harness does not recognise falls back to the happy path and a class named for another route would
be armed on the wrong one. `node scripts/test-fixture-plans.mjs` → **88/88**, `node scripts/page-rules.mjs`
→ **20/20**, `node scripts/test-all.mjs --self-test` → **71 passed, 0 failed**, `--list` → no unwired
suite, and the mode is wired into the gate as `invite-fail-bodies` (**PASS, 15.7 s**).

**Both directions proved by letting them fail.** (1) `describe()` in `assets/complete-listing.js` was
patched to ignore the classifier and blame the link for everything — the §20 bug, exactly. Every class
went red on the kind *and* on the sentence, with the platform's own words in the message: *`get-missing ·
the page decided "not-ready" for it — the class assets/draft-errors.js derives` → the page said
"dead-link" ([complete-listing] dead-link — 404 PGRST202 Could not find the function
public.listing_draft_get(p_token) in the schema ) · the classifier says "not-ready"*, and *the card says
"This link is not valid", the module says "This page is not switched on yet"*. Restored byte-identically
(`cmp` clean). (2) A class the harness does not know (`?fail=not-a-class`, one class driven) proved the
precondition is not vacuous: *`✗ the platform answered with the mock was NOT holding a get failure →
{"get":null,"update":null}`*, plus *`✗ all 9 recorded failures were driven — never loaded: get-refused,
…`*. **That second test also found a real bug in the first draft of this pass**: with no descriptor to
compare against, the title check dereferenced `null` and took the suite down before it printed a total —
no verdict at all, the one failure shape this repo refuses. The missing descriptor is now carried into
the check notes instead, and the run reports.

**One thing found here and fixed in §32.** The dead card printed the WhatsApp number as *text* ("WhatsApp
us on **0902 481 4771**") and had no `wa.me` link anywhere on the page — a landlord on a phone could not
tap it. This pass pinned what was true and load-bearing instead: the number the card prints must be the
one the shared layer publishes (`assets/api-errors.js` `WHATSAPP`), so changing it in the module goes red
until the page follows. §32 turned that line into a link and gave the Link its own check, and the checks
below are 14 per dead load now, not 10 (**TOTAL 121**, not 105).

**Not covered here.** The classes are the eight recorded shapes plus the empty row, not a sample of
production traffic: a new PostgREST failure the recording does not know about reaches the landlord as the
page's generic class, and nothing here would notice until a body is recorded. The flow is driven on the
`worst` seed only, at desktop width, and the whole pass is Chrome/Edge — no real handset, which is also
where §32's link matters most.

---

## 31. The roommate page's failure vocabulary, driven instead of remembered

`assets/roommate.js` decides in `paintError()` which of five sentences a student reads when the matcher
cannot answer — and two of those decisions are **destructive**: a refused private link offers to withdraw
the profile, and a deployment that has no matching service must not. The Care page next to it had a
suite (43 checks — `dev/my-care-test.js`); this page's branches were walked by hand in a real browser
once, which proves a thing once. `dev/roommate-test.js` is that suite: **every branch of the failure
vocabulary, each driven end to end**, so the reading of the wire is asserted rather than remembered.

**The transport is stubbed, not the page.** `fetch()` answers with the body a Netlify function would
send — `{ error, kind }`, wrapped in the status — and the **real** `assets/api-errors.js` reads it back,
exactly as the browser does, because the harness loads the same file the served page loads. The page
itself runs unmodified in a VM against the containers `roommates.html` really has, with a DOM faithful
for the one query `paintError` makes (it looks for its own stale placeholder and strips it), and the
markup is read as **text** — so what is asserted is the sentence a student reads, not a status code the
harness typed.

**36 checks in nine groups.** *A failure off the wire* (4) — a boot with a stored link makes exactly one
request, with the link in the body; a good answer paints no error over the matches; the class the
function named is what the page branches on and the digit is not; a server sentence that is the whole
answer is shown as written. *Every class the vocabulary names* (9) — the six the vocabulary publishes
(`not-ready`, `expired`, `rejected`, `busy`, `error`, `offline`) each driven off a wire body, a **404
that names no class at all** (a function that forgot, or an older deploy of it — the class is derived,
and the derived `not-ready` has to be honoured or the digit offers a withdrawal nobody qualified for),
a request that never arrived (`fetch()` rejects, which no function can put on the wire), and one check
that the six are every class `assets/api-errors.js` publishes — so a seventh class added to the
vocabulary cannot pass silently. How the fallback is *not* the default is group 4's job: a class the page
cannot read, and a page with no classifier at all. *The class decides the branch* (7) — the two `404`s (a
refused link against a route this deploy does not have) and the two `503`s (no matching service against
a bad minute) read apart; the destructive consequence is named in both directions. *An older deploy, with
no classifier loaded* (5) — the page is booted without `api-errors.js` at all, which is what a
half-finished deploy serves, and the old `503` / `404` / `429` ladder has to still hold. *Starting again*
(2), *the line the page leaves behind* (2) — the `Loading your matches…` placeholder is gone when the
ask fails, because it told a student we were still working on something we had given up on. *The things
that must never reach the screen* (2) — no `[1-5]\d\d` anywhere in the panel text, and a hostile sentence
from the server stays text and never becomes markup. *The source is checked, not trusted* (2) and *the
file itself* (3) — the page branches on the class and keeps the digit only as the fallback, `roommates.html`
loads the classifier **before** the script that consults it, and every container the script paints and
every script the page loads actually exists.

**The one place the page does not repeat the server, pinned rather than quietly true.** On a **5xx**
`roommate.js` keeps its own outage line — *"Your answers are safe — the team has them"* — and drops the
function's sentence for the same fact. That is deliberate (an outage has advice to give) and it is the
exception to the row in §25's table that says these pages keep the server's own sentence; the row now
says so, and a check makes dropping the reassurance — or deciding to show both — a change someone makes
on purpose.

**Verified, on the final bytes.** `node dev/roommate-test.js` → **36 passed, 0 failed**, exit 0.
`npm test` → **11 of 11 suites**, exit 0: 72 + 36 + 58 + 43 + 202 + 27 + 20 + 15 + 87 + 131 + 26 = **717**
checks (the gate is **12 of 12** and 718 as of §32: a `test:seo` suite landed while this pass was in
flight, and §32 added one check to `test:api-errors`), which is the number the README quotes next to
`care:live`'s "every Care layer above is absent".

**Both directions proved by letting them fail.** (1) *The digit-only control* — lines 496/499 patched to
decide from the bare `status`, which is exactly the bug this page must not have: **30 passed, 6 failed**,
exit 1, and the messages name the consequence rather than the mechanism — *"a briefly unwell matcher was
reported as a switch that was never flipped: Roommate matching is not switched on yet…"*, *"a 503 that
meant too-many-requests was read as a deployment fact"*, *"the two 404s read identically — the class was
ignored"*, and the two destructive readings: *"a bare 404 was read as a refused profile … Start a new
profile"* and *"an undeployed route was read as a refused profile: We could not find that profile… Start
a new profile"*. Restored — `diff` against the copy taken before the patch is empty but for one
unrelated line (`backHref`, edited on this machine while the pass was in flight, and left alone) — and
both this suite (36) and `test:api-errors` (87 at the time; 88 as of §32) are green again. (2) *A weaker edit, and what it taught* — patching only
`kind === 'rejected' || (kind ? false : status === 404)` to `status === 404` gives **35 passed, 1 failed**
(exit 1): the source check, *"the page does not name the `rejected` class it must branch on"*. **No
driven case notices**, and the reason is worth keeping: the earlier `not-ready` guard reads a `404` as
`not-ready` whether the class was named or derived, so it intercepts the number this line would have
swallowed — including the bare-404 case. Recorded because it is the honest limit of the behavioural
layer: for every `404` shape the vocabulary can produce today, that edit is equivalent, and the page's
*naming* of the class is what only the source check can hold.

**Not covered here.** The six classes are the vocabulary's own names, not a sample of production
traffic — a function that invents a seventh reaches the student as the page's generic class and nothing
here would notice until the vocabulary grows a case. The DOM is a stand-in rather than a browser: it
answers the queries `paintError` makes today, so a change to *those* queries can pass here and still
break on a real page, which is why §30's browser pass and this one are complements, not substitutes. The
source check reads what the file says, so a page that decided from the digit through some other construct
would not be caught by it. And nothing here touches the handset — the same gap §30 records, on the same
screen where it matters most.

---

## 32. The dead card's number is a link — and the module still owns the number

Asked for: the dead card's WhatsApp number should be tappable, with `assets/api-errors.js` staying the
single place the number lives. §30 found the gap and left it open on purpose (*"Turning that line into a
link is a product decision, not a test's"*); this is that decision, made, with the check that keeps it
from drifting.

**What the site already did, and the one card that did not.** Every other page that publishes the number
already links it — `404.html`, `assets/app.js`, `privacy.html`, `safety.html` and `terms.html` carry
`https://wa.me/2349024814771` with `target="_blank" rel="noopener noreferrer"`, and `listing.html`,
`browse.html`, `my-care.js` and `roommate.js` build the same link at runtime. The invite card was the one
that only printed `0902 481 4771`, on the screen a landlord reaches when *their* link has failed — the
screen most likely to be opened on a phone, which is the whole reason this was worth doing.

**What changed.**
- `assets/api-errors.js` (**1.2.0**) — `waNumber()` and `waLink(text)` beside `WHATSAPP`. `waNumber()` is
  the normaliser the site already uses (`0902 481 4771` → `2349024814771`; a leading zero becomes the
  country code), and `waLink()` does its own `encodeURIComponent`. The number and the link now read one
  file, so a page that prints the number and a page that links it cannot point at different phones.
- `assets/draft-errors.js` (**1.2.0**) — re-exports both, the way it already re-exported `WHATSAPP`,
  because the invite page loads *this* module and never the base one.
- `complete-listing.html` — an `<a href="https://wa.me/2349024814771" target="_blank"
  rel="noopener noreferrer">` around the same `<b>0902 481 4771</b>`. The static markup carries it on
  purpose: a view with no JavaScript reads nothing else, which is the same reason §30 left the number
  itself in the markup.
- `scripts/test-invite-render.mjs` — the failure pass reads the anchor (`href`, text, `target`, `rel`) and
  holds it to the module: **four checks per dead load** — the number is a link and not a string; the href
  *is* the module's own `waLink()`; the linked number is the number printed; it opens in a new tab and
  carries `noopener`. 105 → 121.
- `scripts/test-api-errors.mjs` — one more whole-site scan, in the section that holds every page to the
  same contract: **every `wa.me` link on the site must be the number this module publishes**. Five pages
  hard-code that href, so "one place owns the number" is now enforced rather than intended. 87 → 88.

**Why the href is in the markup instead of written by the script.** If `failState()` set the href from
the module, the check holding the page to the module would compare the module with itself — vacuous — and
a view with no JavaScript would have no link at all. It is exactly the trade §30 recorded for the printed
number, now covering the link too: the two ends are held against each other, so changing the number in
the module goes red until the page follows. A prefilled message was left out for the same reason — the
text would have to be a third copy in the markup, or written by the script — and a tap that opens the
chat is the whole ask.

**Verified, on the final bytes.** `node scripts/test-invite-render.mjs --fail-bodies` → **TOTAL 121 ·
PASS 121 · FAIL 0**, exit 0 (14 per dead load, 8 per save load, all nine driven). The normal sweep is
unchanged: **TOTAL 981 · PASS 981 · FAIL 0**. `node scripts/test-api-errors.mjs` → **88 passed, 0 failed**,
exit 0. `npm test` → **12 of 12 suites**, exit 0.

**Both directions proved by letting them fail.** (1) *The module moves, the page must follow* — `WHATSAPP`
changed to `'0902 481 4772'`: **TOTAL 121 · PASS 109 · FAIL 12**, exit 1, three checks red on each of the
four dead loads (the printed number, the href, the anchor's text). Restored, `diff` clean. (2) *A wrong
link with the right number* — the href's last digit changed to `…779` in the markup only: **TOTAL 121 ·
PASS 117 · FAIL 4**, exit 1, one red per dead load — *"the card links https://wa.me/2349024814779, the
module builds https://wa.me/2349024814771"*. That second control is the one that matters: the link is not
piggy-backing on the number check. (3) *The site-wide scan is not vacuous* — `terms.html`'s href changed
to `…775`: **87 passed, 1 failed**, exit 1, naming the file and both numbers. All three restored, `diff`
clean.

**Not covered here.** The href is still a second copy of the number in the markup — the price of a link
that works with no JavaScript, paid down by the check rather than removed. Nothing here opens WhatsApp or
proves that `2349024814771` answers: `waNumber()` is asserted against the normaliser the site already
uses, not against a live account. The device this exists for — a phone — is still the one §30 and §31
both record as missing.

**A red suite this pass saw and did not fix.** The full lane (`node scripts/test-all.mjs`) ended **32
suites · 31 passed · 1 failed**, and the failure is `site-audit` on `404.html` at both widths: six of its
own links (`/browse.html`, `/register.html`, `/owner-list.html`, `/safety.html`, `/privacy.html`,
`/terms.html`) resolve through the clean-URL rules that `netlify.toml` has grown in the working tree, and
the audit cannot find a file for the rewrite's target. `complete-listing.html` passes **10/10** in the very
same run, and nothing this pass touched is in those six paths — it is the in-flight clean-URL work's
failure, recorded here so it is not mistaken for this pass's.

## 33. The same loss, on the two pages that have no harness

Asked for: give the admin dashboard and the homepage the fault-injection treatment the listing and invite
suites already have — lose a boot-critical script per load and make the harness prove it puts the page
back. Both pages were the odd ones out, and for a reason worth naming: `dev/listing-harness.html` and
`dev/complete-listing-harness.html` **write** the document, so they can preflight a script *before* the
parser asks for it. `scripts/test-admin-worst.mjs` loads `admin.html?mock=1` and
`scripts/test-home-motion.mjs` loads the real `index.html`, whole. There is nowhere to stand in front of
those loads, so the loss had no repair and reached both suites as a page bug — *"the motion layer booted"*
and *"the dashboard never settled"* are the same test-fidelity bug §28 fixed for the invite form.

**The repair is a reload, published the way the other two harnesses publish theirs.**
[dev/page-harness-boot.js](../dev/page-harness-boot.js) is injected by a dev-only block at the end of each
page (localhost only), runs last, and carries one row per page: the scripts that hold up that page's own
boot, and the **global each must leave on `window`** — `assets/admin.js` → `ArzuzAdmin`,
`dev/admin-mock-data.js` → `ArzuzMockData`, `dev/admin-mock.js` → `__MOCK__` for the dashboard, and
`assets/app.js` → `Arzuz`, `assets/data.js` → `ArzuzData`, `assets/motion.js` → `ArzuzMotion` for the
homepage. A missing global means the script never ran, so it reloads **once** with `?hreload=1` and
leaves a second miss alone, because a script that is genuinely gone must still fail the run. What it
publishes — `<html data-harness-boot="ok|retrying|ok-after-retry|still-missing">` and
`window.__HARNESS__` — is the same vocabulary the other two harnesses use, so a suite reads the repair
the same way on all four pages. There is deliberately no preflight, and the file says why: nothing here
can happen before the parser has already asked.

**The candidates are derived, not retyped.** [scripts/page-rules.mjs](../scripts/page-rules.mjs) gained a
sixth section, `harnessBootPlan()`, which reads that table back **out of the boot file** (the same shape
§28's suite reads the invite harness's `LAYER` map with) and intersects it with the scripts the page
itself names — so `admin.html`'s two mock files, which arrive by `document.write`, count as named. Four
checks fail the run as a *plan* before a browser opens: the table still carries a row for the page, every
script it watches is one the page names, the page still loads the check (a page that dropped the dev-only
block would leave a lost script unrepaired and the suite would report a page bug), and the intersection is
not empty — which is what a table aiming at nothing would look like. The section also pins that the two
suites take their aim **from** that function: a second copy of the table inside a suite is how one of them
keeps aiming at a script the harness stopped repairing while still going green, which is §26's lesson
applied to the repair rather than to the overflow rules.

**The mode.** Both suites now take the same flags as the listing and invite ones — `--fault-inject`,
`--fault-victims=K`, `--fault-drops=N`, `--fault-rate=P`, `--fault-seed=N` — aimed the same way: one
family per run, interception armed per load with a pattern naming only **that load's victims** (a clean
load under `--fault-rate` is not intercepted at all, because a paused request Chrome never releases is a
hang with nothing to do with the page), the drop proven to have landed, the boot state read only once it
has stopped moving (`ok`, `ok-after-retry`, `still-missing` — `retrying` is a reload in flight, not a
verdict), and then **every ordinary check re-run against the recovered page**. A load the fault never
reached fails the run, and a sweep in which no faulted load needed the harness to answer fails too, for
the reason a green run that proved nothing is not a green run. `test-home-motion.mjs` refuses
`--fault-inject` on any `--page=` other than `index.html`: the repair is the dev-only block *that page*
ends with, so pointing this mode at a copy would aim it at a check the copy does not have and print green
for it.

**Verified, on the final bytes.** `node scripts/test-home-motion.mjs` → **TOTAL 51 · PASS 51 · FAIL 0**,
exit 0 (desktop 1440 + mobile 390, default and reduced motion).
`--fault-inject --width=desktop` → **TOTAL 31 · PASS 31 · FAIL 0**, exit 0: **2 of 2 loads faulted, 2
requests never arrived, 2 answered by the page's own check** — the loss landing on `assets/motion.js` on
one load and `assets/app.js` on the other, both `boot ok-after-retry`, every check green against the
recovered page. `node scripts/test-admin-worst.mjs` → **TOTAL 69 · PASS 69 · FAIL 0**, exit 0 (worst +
demo × 1440 / 390 / 309). `--fault-inject --case=worst --width=desktop` → **TOTAL 33 · PASS 33 · FAIL 0**,
exit 0: **2 of 2 loads faulted, 2 requests never arrived, 2 answered**, `dev/admin-mock.js` lost on both
loads and back on the reload, with the 45-cell matrix, the fixture-against-itself pass and the 309px
composer pane all re-measured afterwards. Both runs print the seed they used (`787685454`, `787739907`)
and replay it exactly with `--fault-seed=`.

**The controls, both red as they must be.** `--fault-inject --fault-drops=2` drops the reload's copy too:
home-motion → **TOTAL 31 · PASS 25 · FAIL 6**, exit 1 (`boot still-missing · still missing: ArzuzMotion`,
29 of 30 reveals landed, `.rv` section 3 left mid-transform — the damage is *shown*, not inferred);
admin-worst → **TOTAL 11 · PASS 6 · FAIL 5**, exit 1 (`still missing: ArzuzMockData, __MOCK__` then
`ArzuzAdmin`, 0 rows on screen, and the page's own `TypeError: Cannot read properties of undefined
(reading 'worst')` quoted beside it). Both end on the same sentence the listing suite's control does:
*this run is meant to be red*. Neither control is a gate suite — a gate that fails on purpose is a gate
nobody trusts.

**Wired into the gate:** two more entries in [scripts/test-all.mjs](../scripts/test-all.mjs),
`home-motion-fault` (`--fault-inject --width=desktop`) and `admin-fault` (`--fault-inject --case=worst
--width=desktop`), so all four pages' repairs are exercised on every push rather than by hand. The
runner's own plan check is unchanged and still green: `node scripts/test-all.mjs --self-test` → **78
passed, 0 failed**. Both entries were then run through the runner by name — `--only=home-motion-fault` →
**PASS 35.5s**, `--only=admin-fault` → **PASS 22.5s and 35.0s on two runs** (the two-load dashboard is the
jittery one; its estimate was set to the middle of those, 30s, rather than left at a guess that the first
three runs would have called a regression). `node scripts/page-rules.mjs` → exit 0 (its boot-layer section reads both pages back),
`node scripts/test-fixture-plans.mjs` → **88 · PASS 88 · FAIL 0**, and the README gained the mode beside
the other two.

**Not covered here.** Both pages still have one family — a lost script — and no `--fault-preflight` or
`--fault-css`, because neither page has a harness that writes the document or a stylesheet guard to make
those families mean anything; the stylesheet guard stays listing-only, where the harness measures the
document it wrote. The device both suites lack is unchanged from §30–§32: Chrome and Edge on a desktop,
never a real handset. And a faulted dashboard load is judged on the layout the boot check repaired — there
is no claim here about what a *production* reader sees when a script request is lost, since
`dev/page-harness-boot.js` is localhost-only by design and the real page has no repair at all.
