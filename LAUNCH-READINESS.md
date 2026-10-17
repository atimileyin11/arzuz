# Arzuz — launch readiness

**Status:** the waitlist, the staff role split and the submission door are implemented and green.
Nothing here is deployed. Two setup steps are still yours (see §3), and the admin area is safe to
leave switched off until they are done.

Written against the launch spec of 15 October 2026. Section numbers in this file that look like
`§4` are the **spec's** sections; the site's own files use their own numbering.

---

## 1. What already existed (and was reused)

Nothing was rebuilt, and no new service was introduced. The launch runs on exactly the stack the
site was already on.

| Layer | What it is | Where |
| --- | --- | --- |
| Front end | Plain HTML/CSS/JS. No build step, no bundler, no framework. | `index.html`, the form pages, `assets/*.js` |
| Hosting + server | Netlify: static publish plus CommonJS Netlify Functions under `/api/*` | `netlify.toml`, `netlify/functions/` |
| Database | Supabase Postgres, read and written through PostgREST | `supabase-*.sql` |
| **Auth provider** | **Supabase Auth (GoTrue), email + password.** Already configured and in use. | `assets/auth.js`, `netlify/functions/team.js` |
| Sessions | Access + refresh tokens held in `sessionStorage`; every request carries the JWT as a bearer token; the anon key travels as `apikey` | `assets/auth.js` |
| Roles | `app_metadata.role` in the JWT, read by Postgres as `public.arzuz_role()` | `supabase-team-roles.sql` |

Two facts about that stack drove almost every decision below.

**The admin area was already server-side protected.** Reads, updates and deletes on every table are
granted `to authenticated` and gated by role policies in Postgres — not by a hidden nav item. The
anon key is in `assets/config.js` on purpose, and RLS is what makes that safe.

**The public forms posted straight to PostgREST with that anon key.** RLS forced `status` and `tier`,
which is real protection, but a policy cannot count, cannot check a sentence's worth of validation,
and cannot hand something back. That is the gap the spec's §2 names — and the reason
`netlify/functions/waitlist.js` now exists.

### What was already correct, and left alone

- **No customer accounts, no passwords anywhere in the waitlist.** No public form has a password
  field, and no table stores a credential. This was true before this work and is still true (§5).
- **Public browsing needs no login.** `public_listings` is a definer view over active, verified rows
  with owner identity stripped from `payload`. Untouched.
- **Secrets stay server-side.** `SUPABASE_SERVICE_ROLE_KEY` is used by exactly two functions
  (`team.js`, and now `waitlist.js`) and reaches no browser.

---

## 2. What changed

### New files

| File | What it does |
| --- | --- |
| `supabase-waitlist-launch.sql` | The launch data model: reference registry + minting trigger, `ref` / `applicant_type` / `consent_at` / `consent_text` / `follow_up_status` / `assigned_to` / `verified_at` / `linked_user_id` on `demand_records` and `listings`, the `submission_guard` throttle, the append-only `staff_audit_log` and the triggers that write it. Two preflight guards. |
| `supabase-close-public-inserts.sql` | **Closes the direct path.** Revokes `insert` on `demand_records`, `listings`, `scout_submissions`, `booking_requests` and `support_tickets` from `anon`, so the door is the only way a public form reaches the database. Two preflight guards, and the second one is load-bearing: it refuses to run unless `public.waitlist_throttle()` exists, because closing the direct door on a database that has no validated one takes the site offline entirely. |
| `netlify/functions/waitlist.js` | The public door. Server-side validation, honeypot, database-backed rate limit, duplicate detection, consent recording, service-role insert, and the reference handed back. |
| `scripts/test-waitlist.mjs` | 38 cases driving that door with synthetic events, seven of them for the optional email address every public form now asks for. |
| `supabase-verification-rpc.sql` | **The verification decision, column-scoped.** Withdraws the row-wide `update` policy the `verification` role held on `listings` and replaces it with `public.listing_verify(uuid, text, integer)` — a `SECURITY DEFINER` function that moves `status`, `tier`, `verified_at` and `verified_by` and nothing else. Three preflight guards. |
| `scripts/test-confirm-render.mjs` | The submission confirmation, on the real `register.html` in a real browser: six answers the door can give, fulfilled at the network layer, judged on what the page rendered and what left on the person's behalf. |
| `supabase-status-codes.sql` | **The public status page's data layer.** `status_codes` (the code's hash, an expiry, an attempt count and whether it was used — never the code), `status_guard` (its own throttle, deliberately not `submission_guard`), and the three `SECURITY DEFINER` functions: `status_throttle`, `status_open` and `status_verify`. The reveal is built here from a fixed column list, so no page can widen it. One preflight guard. |
| `netlify/functions/status.js` | The status page's door. Resolves the reference through `waitlist_ref_registry`, requires a contact ON the row — the phone number, or the email address — hashes a six-digit CSPRNG code with the service key as salt and sends it over the existing OpenWA sender (or `notify.js`'s `sendEmail`), then reveals the stage when it comes back. Every answer that is not the caller's own rate limit is one body, and the body is the same whichever channel asked. |
| `status.html` + `assets/status.js` | The public page at `/status`: two steps, no session, and nothing kept in the browser. The student chooses the channel — WhatsApp or email — and only the chosen contact is sent; the line under the code box is about the channel the page ASKED for, which the student chose a moment ago. It advances to the code step for every held answer, because branching on the reply would hand back the oracle the function refuses to give. |
| `scripts/test-status.mjs` | 56 cases driving that door as an enumerator, with a stand-in PostgREST, a stand-in OpenWA and a stand-in Resend: the one answer asserted byte-for-byte across five inputs AND across the two channels; the count claimed before the reference is read; the 502 that must not become a contact oracle; the code read out of the message that was sent and typed back — on either channel; the fallback that delivers the same code by email when the sender is down or the number cannot be addressed; the 64-hex hash and the code's absence from every request body; and the page's own rules (no browser storage, no branching, the sentence it prints is the function's sentence). |
| `scripts/require-service-key.mjs` + `scripts/test-deploy-key.mjs` | The deploy gate: the Netlify **build command** refuses to publish without the credentials the site's promises depend on — `SUPABASE_SERVICE_ROLE_KEY` and the two OpenWA credentials — and its own suite asserts the decision for every variable, the advised list, both override forms, the real exit codes, that no value ever reaches the log, and the wiring parsed out of `netlify.toml`. |
| `supabase-status-history.sql` | **The desk's half of the status page.** `status_code_deliveries` — an append-only trail of every attempt to send a code, with the channel, whether the sender accepted it, and a note from a CLOSED vocabulary of seven words — plus the `max_attempts` column that moves the attempt ceiling onto the code, a re-stated `status_verify` that reads it, `status_code_delivery()` (service role only), `status_phone_tail()` (the site's "same number" rule as one function, so the desk's search and the student's own proof cannot drift) and `public.status_history(text)` (the Support Desk's read: `admin` and `support`, checked inside the function). **Its argument is a QUERY, not a reference** — the whole reference, the end of one, the beginning of one, or a phone number on the record — and a fragment resolves to CANDIDATES (capped at ten, with `more` when there are more) rather than to a guess. One preflight guard, plus the role refusal §5 raises. |
| `LAUNCH-READINESS.md` | This file. |

### Changed files

| File | Change |
| --- | --- |
| `supabase-team-roles.sql` | `arzuz_role()` now normalizes five claims; `verification` policies added (read demand, listings and scout reports — its listing **update** is now withdrawn in favour of the RPC below); the anon insert policies for all five public tables now also refuse a filled honeypot. |
| `supabase-finance.sql` | The six book-reading policies moved from `support` to `finance`. **This is the least-privilege fix the spec asks for** — see §5. |
| `netlify/functions/team.js` | Issues the five role names against a closed list; accepts `admin` and `super_admin` as the same level. |
| `netlify/functions/finance.js` | The team door now admits `admin` and `finance` only; `support` is refused there as well as by RLS. |
| `assets/auth.js` | Decodes the same five names the database computes. |
| `assets/submit.js` | **One door, no fallback.** The direct PostgREST write is deleted along with the `attempt()` wrapper that chose between them; every submission goes through `/api/waitlist`, and the offline queue retries through it too. Carries the reference back to the page and stops a duplicate being delivered twice. A `not-ready` is now a held submission, not a detour. |
| `assets/roommate.js` | **Its side door is gone.** The fallback that posted an unmatched roommate profile to `demand_records` is removed: the door's student form requires a first name and an age band, this questionnaire has neither, and an age band is what sets `is_minor` — so the fallback wrote a row that was refused, or would have filed a student under the wrong rules. A failed match is now reported honestly and nothing is stored. `paintError()` takes a `saved` flag and returns the sentence it painted, so the panel and the note the form engine prints cannot disagree — two of its three callers are on a profile that already exists, and their copy still reassures. |
| `supabase-waitlist-launch.sql` | The audit trail's `action` branch now names the **service role**, not only `anon`. A public submission arrives as the service role once the door is the only writer, so leaving the branch as `who = 'anon'` made the vocabulary's one word for a public submission unreachable. `actor_role` still records `service_role` — the action says what happened to the row, the role says who did it. |
| `assets/app.js` | Adds a hidden honeypot field to every step, adds the consent step to every public form, reads both on submit, and prints the reference on the confirmation screen — with a link to `/status?ref=…`, because the moment the reference is handed over is the only moment the person holding it is looking at it. |
| `assets/admin.js` | A Pipeline column (stage + assignee + a stage selector) on the waitlist tables, the reference in the row, and the new role section map. On a listing the stage selector is now an admin's only: an officer's approve is the RPC, and `verifyListingRow()` calls it, so the dashboard stops offering the row-wide editor to the one role the database no longer accepts it from. |
| `assets/admin.css` | The pipeline tag, selector and reference badge. |
| `supabase-status-codes.sql` | Its header no longer claims that nothing on this site knows which channel a code went out on — that was true of the STUDENT's half and is now recorded in the office's half. §1's and §4's comments carry the same correction: the table still has no column saying where a message went, and §4's ceiling is now read from the row (re-stated by `supabase-status-history.sql` §4). |
| `netlify/functions/status.js` | Every delivery attempt is now appended to `status_code_deliveries` — after the student has been answered, and unable to change what they are told: a refused or unreachable trail write is logged and swallowed, because a record that can turn a delivered code into a 500 is worse than no record. `STATUS_MAX_ATTEMPTS` is gone from `cfg()`, and no ceiling is sent with `status_verify`, because the code's own governs. |
| `assets/admin.js`, `admin.html`, `assets/admin.css` | The Support Desk grew a **Status code history** panel: a reference, and the trail of every code asked for against it. **The student does not need the reference to hand** — the last four characters will do, and so will the phone number they applied with — so the panel sends what was typed and lets the database read it, rather than normalising first and keeping a second copy of the rule. When more than one reference fits it draws the candidates and **no history at all**: a wrong guess here is an officer reading somebody else's trail down the phone with complete confidence. A phone number is matched but never echoed to the screen. It writes nothing, it is drawn only for the two logins the database admits, and it maps the trail's machine words to sentences in one place so an outage mode cannot reach an officer as a bare database string. |
| `dev/admin-mock.js` | The harness answers `status_history` the way §5 does — 403 for a login outside the desk — and reads the query the same way, including the two cases the panel branches on: a fragment that fits one reference, and a fragment that fits two. Its original fixture reference (`ARZ-S-4K2M-9XQP-7T3B`) turned out **not to be a valid reference** — a `K`, an `M`, a `Q`, an `X`, a `P` and a `T` are not hex, and the old whole-string lookup never checked — so it was caught the moment the function learned to read the shape. |
| `dev/sql-proof.mjs` | Applies the new migration and adds §13h: the trail's RLS and cascade, the closed note vocabulary (coerced on the way in, refused outright behind the function), the writer's answer-don't-raise contract, the desk's authorization, the leak assertion on the serialised answer, and the ceiling the caller cannot widen. The two 13f checks that asserted a caller-supplied ceiling now record the ceiling on the row and assert that a claimed ceiling of twenty is IGNORED. |
| `dev/sql-guard-test.mjs` | The new file's preflight is on the ladder with a rung (and a silent rung against a stub code table), its sentinel asserts the trail and both functions are absent where the guard fires, and §4e drives the role refusal against the real chain. |
| `dev/admin-boot-test.js` | Five checks per role for the new panel, run for all five logins: it is drawn for support and admin, hidden from verification, finance and marketing, a lookup renders the trail the database returned (the reference, the fallback as two attempts in order, the attempts counted, a spent code reading as spent), and the URLs the panel asks for contain **no** write. |
| `scripts/test-status.mjs` | 62 cases, up from 56: the trail is written against the code's own id on the channel it went out on; the fallback is two attempts in order; a record with no address records that the fallback could not fire; a refused mail is recorded as refused and never in the provider's own words; no code, number or address appears in the bytes that were sent; and a trail that cannot be written changes nothing the student is told. The old "the attempts ceiling is the deploy's" case is now its opposite — the assertion is that NO ceiling travels from this file. |
| `netlify.toml` | The **build command** is now `node scripts/require-service-key.mjs --require`, so a deploy with no service key fails to build instead of publishing and answering 503 to every student. Adds `/status` (200 → status.html), the `/status.html` → `/status` 301, a `noindex` header for the page, and a hard 404 for `supabase-status-codes.sql` — and now for `supabase-status-history.sql`, whose header describes which logins may ask about a reference and what the answer contains. Also the hard 404s for the two files this work added earlier — `supabase-close-public-inserts.sql` and `LAUNCH-READINESS.md`. The second was **already live with no rule**: `publish = "."` was serving this document, which lists the residual risks, the env vars and the unapplied migrations, to anyone who guessed the filename. `scripts/test-deploy-guards.mjs` caught it; it is green now. |
| `dev/sql-proof.mjs` | Applies both new migrations, plus §13c–e: the reference, the trail, the role matrix and the throttle, each driven as the actor that would evade it. §13c now drives the row **as the service role**, which is the door's real call — `Prefer: return=representation` needs `SELECT`, and the old version of that section inserted as anon and read as the owner, so the returning path was never exercised. The anon honeypot assertions are replaced by the lockdown: anon holds no `insert` on any of the five; the service role holds it on all five (closing one door must not close the site); a bot holding the page's key is refused by the database on each of them; and the honeypot policies are asserted **still present and armed**, unreachable but ready to re-arm. New §13d row: `service_role` reads as itself, not as `admin` or `anon`. |
| `dev/sql-guard-test.mjs` | Both new guards are on the ladder, with rungs at each. The bare rung database now carries the three roles and Supabase's default privileges, because the closer's sentinel asserts a *privilege* — the only sentinel in the suite that does — and a privilege cannot be asked about a role that does not exist. |
| `dev/admin-boot-test.js` | All **five** roles boot, including `verification` and `finance`; the finance panel is asserted for `admin` and its **absence** asserted for support and marketing. |
| `scripts/test-api-errors.mjs` | Two new checks in the submission-layer section, both pinning the removal of the fallback: a `not-ready` submission makes exactly one call, to the door, and never to `/rest/v1`; and the queued retry goes through the door as well. |
| `dev/roommate-test.js` | Two new checks driving the exported `paintError()` with `{ saved: false }`: the submit path must not reassure a student about answers that were never stored, and the matching path's "your profile is saved" copy must not leak into it. |
| `dev/run-tests.mjs`, `package.json` | `test:waitlist`, `test:status` and `test:deploy-key` registered and run by `npm test` (which is how `scripts/test-all.mjs` picks them up too — it reads the `test:*` scripts out of `package.json`). |

### The second delivery channel, and the gate that grew a list (this pass)

**The status page's code can now go to an email address as well as to a phone.** The phone was the
only channel it had, and it is the contact a Nigerian student is most likely to have CHANGED — a new
SIM, a new line after a lost phone — while WhatsApp itself goes down too. Either way the code had
nowhere to arrive and the page answered the one person it exists for with nothing. So:

- the student chooses the channel, and proves the contact for it: the phone number on the file, or
  the email address on the file (compared lower-cased, but never by a tail — two mailboxes are two
  people, and a guessed tail would hand one person's code to another);
- the WhatsApp path **falls back by itself**: a number this site cannot address, or a sender that
  refuses, and the SAME code goes to the inbox on that record. The student is asked nothing extra;
- **the answers did not change.** The generic sentence is deliberately channel-neutral now — "the
  contact details we hold for it" — so the same bytes answer a request made by phone and one made by
  email, and the fallback is invisible from outside. That is asserted three ways in `test:status`.
- the email is collected OPTIONAL on the student, roommate and landlord forms and validated at the
  door with `notify.js`'s own rule for a deliverable address, so a value stored is a value the second
  channel can actually use. `test:waitlist` asserts that seam by feeding the STORED payload to the
  status page's own reader.
- **no schema change, and none was needed.** The code's hash is channel-independent; where the
  message went is a log line, not a column. `supabase-status-codes.sql` is untouched except for its
  header, which no longer says the code goes on WhatsApp and only on WhatsApp. **That was true of the
  student's half and no longer of the office's:** a later pass added `supabase-status-history.sql`,
  which records the channel for the DESK — it could not widen what a caller may read, because what a
  caller may read does not depend on how the code travelled. See "The desk's half" above.

**The build gate stopped being about one key.** Three credentials, and all three fail the same way
when they are missing: nothing looks BROKEN. There is no crash — only a person who was told their
request was received and then heard nothing again. The waitlist door's key was already checked; the
OpenWA pair was not, and its absence is the same silence for the status code and for every notice the
claim workflow sends. So the required list is
`SUPABASE_SERVICE_ROLE_KEY`, `OPENWA_URL`, `OPENWA_API_KEY`; `OPENWA_SESSION` and `RESEND_API_KEY` are
**advised** — their absence degrades the site rather than breaking a promise, and a gate that fails on
a preference is a gate people learn to override. The override grew a name-list form
(`ARZUZ_ALLOW_MISSING_ENV=OPENWA_URL`) and the old single-variable spelling still means the one
variable it always meant, so a deploy script carrying it does not start failing for a second reason.

### The desk's half of the status page (this pass)

The status code is the one thing on this site whose failure is a phone call rather than a broken page,
and until now the only record of what had been sent to a student was a line in a Netlify build log —
which expires, which nobody opens, and which cannot be searched while somebody is on the phone. So the
desk's honest answer to "I never got the code" was "ask for another one and see", which is the same
answer whether the first one arrived or not.

`supabase-status-history.sql` is that record, and it is deliberately narrow:

- **a delivery trail** — `status_code_deliveries`, one append-only row per attempt to send a code: the
  channel tried, whether the sender accepted it, and a machine word for why not. A code WhatsApp
  refused and the mailbox then delivered is **two** rows, in order — flattened into one column it would
  read "email", and nobody could tell the student why the message they were watching for never arrived
  on the phone they were holding. Three outcomes, because they are the three an operator can act on:
  `sent` (the sender accepted it — NOT "the student has it"), `refused` (the sender said no, which means
  the setup is wrong) and `unreachable` (nothing was asked, because nothing could be).
- **the note is a closed vocabulary, not a shape rule.** "No note may contain an address or a number"
  is a rule about shape, and a shape rule leaks: `refused for Amaka, number changed` breaks no rule
  about `@` or digits and still puts a name in a log several people read. So the column accepts seven
  named words and nothing else, which is a guarantee about CONTENT. An unknown word is coerced to
  `unrecorded` **with a warning in the Postgres log** rather than refused, because the row is the record
  the desk came for and losing it to a vocabulary drift is the worse failure. An earlier draft of this
  file scrubbed an `@` and a digit run instead; the leak check in `sql:proof` §13h is what showed that a
  name walks straight through a shape rule.
- **the attempt ceiling moved onto the code.** `STATUS_MAX_ATTEMPTS` was a deploy variable passed to
  `status_verify` on every call, which gave one number two homes — what the verify path enforced and
  what a screen could report — and let a code issued at five-to-ten be judged at five-past. The TTL has
  always been decided at issue and stored (`expires_at`); the ceiling is now a column too
  (`max_attempts`, default 5, `CHECK 1..20`), and the row is authoritative: §4 of the new file
  re-states `status_verify` so a caller **cannot widen** the ceiling of a code it did not issue, which
  nothing enforced before because nothing recorded it. The variable is gone from
  `netlify/functions/status.js`, and `test:status` now asserts that no ceiling travels from there at
  all — a future change that reads the variable again fails that check rather than quietly mattering.
- **the read is the database's decision, not a Netlify function's.** `public.status_history(query)` is
  `SECURITY DEFINER`, granted to `authenticated`, and checks `public.arzuz_role()` itself — admin and
  support only — the same shape as `verification_queue()`. The Support Desk calls it with the session it
  already holds, so there is **no new function and no new secret**, and no service key in any browser.
  It returns facts in a fixed shape; the words are the panel's, in one table, so a new outage mode
  cannot reach an officer as a bare database string.
- **the reference is not required, which is the half of these calls that was still unanswered.** The
  reference is the thing the student was told to keep, and therefore the thing they have lost when they
  ring, so the argument is read as a QUERY: the whole reference, the last four characters of one, the
  beginning of one, or the phone number on the record.

  Three properties make that safe to ship. A fragment resolves to **candidates, never to a guess** —
  more than one match is answered with the list and **no code history at all**, because a wrong guess
  would have an officer read somebody else's trail back with complete confidence; the list is capped at
  ten with a `more` flag, so a fragment cannot page the registry out. A fragment **below the floor is
  refused even when it matches a real reference**: two characters of a reference under test do occur in
  one, and if that were enough to answer, `AR`, `RZ`, `S0` downwards would be a way to walk the
  registry and never be refused — the refusal has to be about the QUESTION, not about whether something
  happens to match it.  And a phone number is matched by the site's **own** rule, the last ten digits,
  which is the rule `netlify/functions/status.js` proves control of a number with: the two live in
  `status_phone_tail()` so they cannot drift, since a number a student can open their record with must
  not be a number the desk cannot find it by. Widening what may be *asked* did not widen *who may ask* —
  the role check is unchanged, and `sql:proof` §13i drives all four shapes against every other login.

  **That same phone rule settles the one genuinely ambiguous shape.** A bare string of digits could be
  a number or the end of a reference, and below **ten** digits it cannot be a number the site could ever
  have matched — so it is read as a reference's end. This is not a nicety: a reference is twelve *hex*
  characters, so four of every sixteen are not decimal and roughly **one reference in seven ends in four
  decimal characters**. The first version of this reading refused those as "too short to look anything
  up", which would have silently failed the desk on a seventh of the registry — and it was found by
  exactly that: a `sql:proof` run where the randomly minted reference happened to end in digits, so the
  test failed about one run in seven. The fix is the rule, not a looser assertion, and §13i now pins the
  case with a reference whose tail is **chosen** rather than random, so the coverage does not depend on
  the dice.
  What is matched is `demand_records.phone` and `listings.owner_phone` and **not the guardian number**,
  for the same reason the send path does not use it: a reference found by a number the student cannot
  then open their own record with would send the officer to a dead end. The answer carries no number
  back — not even the caller's own — so a search by number is not a place a number can be read from.

**The panel writes nothing.** A code is never minted or re-sent from the dashboard: sending one is the
student's own request on `/status`, where the proof of the contact on file and the per-reference
ceiling apply, so a button that could mint one would be a way round both. `dev/admin-boot-test.js`
asserts that on the URLs the panel actually asks for, not on a comment.

**One hole, said out loud rather than implied.** Two refusals happen BEFORE a code is issued — a deploy
with no mail provider, and the per-reference ceiling — and neither leaves a code, so neither can leave
a trail row. A student who typed their address into a deploy with no mail provider is therefore
invisible to this screen, and the panel's empty state says so rather than implying nobody asked.

### The three design decisions worth knowing

**The reference is minted by the database, in a trigger, never by the page.** A browser-chosen
reference is one anyone can choose — including somebody else's. `waitlist_ref_registry` has the
reference as its primary key, so `ARZ-S-7F3A-9C12-4E80` names exactly one row anywhere in the
system; uniqueness is enforced rather than hoped for, and the trigger redraws on a collision instead
of failing a submission.

**The audit trail is written by triggers, not by the dashboard.** A log a page writes is a log a page
can decline to write. `staff_audit_log` has **no insert, update or delete policy at all** — only the
`SECURITY DEFINER` trigger writes, and no key that reaches a browser can forge, edit or erase a line.
Each line records the acting role as Postgres computes it from the signed JWT, the columns that
actually moved (`changed_columns`), and both sides of the change.

**A role's write is now as narrow as the role is, and one of them is a function rather than a policy.**
The `verification` role's whole job is a single decision — this room was checked, put it on the board —
and a policy cannot express that: it decides which rows a role may touch, so holding an `update` on
`listings` also handed the officer the price, the owner's number and the payload. The decision moved
into `public.listing_verify()`, which moves four columns and refuses the rest (risk 2, §6), and the
row-wide policy was withdrawn in both directions — not created by `supabase-team-roles.sql`, and
dropped by the new file on any database that already had it.

**There are two status columns, and that is deliberate.** `status` is the record's state and every
view, filter, growth feed and report is keyed on it (`demand_summary`, the roommate summary,
`public_listings`, the dashboard filters). `follow_up_status` is the pipeline the spec names
(`new → contacted → interested → matched → closed`). Replacing one with the other on launch week
would have rewritten every one of those readers. The migration backfills the pipeline from `status`
and both are enforced by `CHECK` constraints. Unifying them is a post-launch task (§8).

---

## 3. What you still have to do

### 3a. Run six migrations, in this order

In Supabase → SQL Editor:

1. `supabase-team-roles.sql` — **re-run it.** The role vocabulary and the honeypot need it.
2. `supabase-waitlist-launch.sql` — new. Needs (1) to have run.
3. `supabase-verification-rpc.sql` — new. Needs (2), whose columns it writes, and it is the file that withdraws the old row-wide verification policy on an install that already has it. Run it even if nobody holds the role yet: it costs nothing and it is the file that makes the officer's write narrow.
4. `supabase-status-codes.sql` — new. Needs (2), whose reference registry every function in it reads, and it is what makes `/status` work at all. Additive: it creates two tables nobody can reach with a browser key and three functions only the service role may execute. Skip it and the page answers 502 rather than pretending.
5. `supabase-status-history.sql` — new. Needs (4), whose `status_codes` it adds a column to and whose `status_verify` it re-states. It is what the Support Desk's **Status code history** panel reads, and additive: it creates a trail nobody can reach with a browser key, two functions, and one column on a table that already exists. Skip it and the panel says nothing — and, because it re-states the verify function, a project that runs it must then leave (4) alone rather than re-running it afterwards (a re-run of (4) restores the older `status_verify`, which ignores the code's own ceiling; running (5) again puts it right).
6. `supabase-close-public-inserts.sql` — new, and **do this one last.** It revokes anon's insert on
   the five public tables, which is the point: it is the step that makes the door the only way in.
   Set `SUPABASE_SERVICE_ROLE_KEY` (§3b) and submit one real registration (§3d) **before** running it,
   because after it there is no second path — if the key is missing, the door answers 503 and
   submissions are held on the student's device instead of written. The file refuses to run unless
   `supabase-waitlist-launch.sql` has already been applied, so the migration order cannot be got
   wrong, but it cannot check a Netlify environment variable for you.

All five are idempotent. None drops a table, a column or a row.

Then re-run `supabase-finance.sql` if you want the books split (it is idempotent too, and it is the
file that moves the six read policies to `finance`).

### 3b. Environment variables

| Variable | Needed for | Notes |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | **the waitlist door, the status page, and already the team panel** | Supabase → Project Settings → API → `service_role`. Server-side only. **Without it the door answers 503 and a submission is held on the device rather than written** — and since `supabase-close-public-inserts.sql` there is no second path for it to take, so set this before running that file. `sql:proof` §13c asserts the other half of the same fact: the service role is the role that *can* insert on all five tables. |
| `SUPABASE_URL` | optional | Falls back to the live project URL, which is public anyway. |
| `WAITLIST_MAX_PER_HOUR` | optional, default **60** | Per-IP ceiling. Deliberately generous: a campus is one NAT address. |
| `WAITLIST_MIN_GAP_SECONDS` | optional, default **4** | Minimum gap between two submissions from one address. |
| `WAITLIST_GLOBAL_PER_HOUR` | optional, default **4000** | A ceiling on total traffic, so no single flood can fill the table. |
| `ARZUZ_SESSION` | optional, default `2026/2027` | The session stamped on a submission. |
| `STATUS_MAX_PER_HOUR` | optional, default **10** | Per-IP ceiling on the status page's *send* step. Deliberately far tighter than the waitlist's 60: a person checks their status once, and an attacker checks it a hundred times. |
| `STATUS_VERIFY_PER_HOUR` | optional, default **60** | Per-IP ceiling on the *verify* step, counted separately so typing a code is not made to wait out the search that sent it. |
| `STATUS_MIN_GAP_SECONDS` | optional, default **2** | Minimum gap between two attempts at the same step from one address. |
| `STATUS_GLOBAL_PER_HOUR` | optional, default **300** | Ceiling on all status traffic. |
| `STATUS_CODE_TTL_SECONDS` | optional, default **600** | How long a code lives. The message quotes it, so the two cannot disagree. |
| ~~`STATUS_MAX_ATTEMPTS`~~ | **retired** | It was a deploy variable; the ceiling now lives on the code (`status_codes.max_attempts`, default **5**), because one number with two homes is two numbers the day they disagree. To change the policy, change that column's default — see `supabase-status-history.sql` §1. |
| `STATUS_MAX_CODES_PER_REF` | optional, default **5** | Codes per reference per hour. This is the one ceiling that protects a *person* rather than this server: without it, anyone holding a reference could have the site message that student as often as they liked. |
| `ARZUZ_ALLOW_MISSING_SERVICE_KEY` | optional, and it should stay unset | `=1` lets a build publish without `SUPABASE_SERVICE_ROLE_KEY`, logged as a warning. It exists for a deliberate deploy of a copy change while the door is expected to hold submissions — never for "the build was in my way". |

No new service, no new account, no new provider. The IP hash uses the service-role key as its salt,
so there is no additional secret to manage.

### 3c. Mint the staff logins (if you have not)

Dashboard → Settings → Team, as the main admin. Each login gets one of five roles, and the vocabulary
is closed — `team.js` refuses anything else. Public registration cannot assign a role; there is no
public path that writes `app_metadata` at all.

| Role | Intended for | Reaches |
| --- | --- | --- |
| *no role* / `admin` / `super_admin` | you | everything |
| `operations` (or the older `support`) | the desk | demands, listings (read-only), bookings, tickets, Care, repair queue |
| `verification` | whoever inspects a property | demands (read), listings (read, and **approve** through `listing_verify`), scout reports (read) |
| `finance` | whoever keeps the books | the books, and **zero rows on every waitlist table** |
| `marketing` | growth | the scrubbed growth views, and no phone number anywhere |

### 3d. Order of operations, so nothing is ever briefly broken

1. Run migrations 1 and 2 (`supabase-team-roles.sql`, `supabase-waitlist-launch.sql`), and 4
   (`supabase-status-codes.sql`) if you want the status page from the first minute. Migration 3 can
   wait for the officer's login; 5 is the last step either way.
2. Confirm `SUPABASE_SERVICE_ROLE_KEY` is set, and deploy. **The build refuses to publish without
   it** (`scripts/require-service-key.mjs`), so a green deploy is itself the evidence that the door
   can write — which is the fact step 3 used to be the only proof of.
3. Submit one real test registration and confirm the reference appears on the confirmation screen.
   **This is the step that proves the door works before the door is the only way in.**
4. Run `supabase-close-public-inserts.sql`.
5. Submit one more real registration. It must still come back with a reference — that is the door
   proving that revoking anon's grant did not touch the role it writes with.
6. Open `/status` and check that reference. The code should arrive and the stage should show. Then
   check the two failures that matter more than the happy path: a **wrong** code, and a reference
   that does not exist, must both answer the way the correct pair answers before the code lands.
7. Only then tell students the form is live.

Steps 1–2 can happen in any order without losing submissions, and nothing before step 4 closes a
door — until then the forms work whether or not the function is deployed. From step 4 onward there is
one path, permanently, and step 5 is the confirmation that the one path works in the production
database rather than only in the harness. If step 5 returns a 503 `not-ready`, the service key is not
set for that deploy; if it returns a 502, the service role lost a privilege it needs. Neither is a
submission lost — both are caught before students are told the form is live.

---

## 4. Tests run

`npm test` — **23 of 23 suites passed**, nothing failed (the pass this table was taken from).

> **The run behind the two rows this work changed is not that run.** The status page's second
> channel and the widened deploy gate were added afterwards, and the last full `npm test` of this
> pass reports **22 of 23 suites passed**. The one failure is in a file this work did not touch:
> `test:api-errors` fails on another writer's in-flight verification-queue work
> (`netlify/functions/verification-aging.js` answers JSON without the shared wire form and carries its
> own copy of the classifier), and the same runner reports `test:verify-queue` in `package.json` but
> absent from `ORDER`, so it never runs. Two other suites were failing for the same reason earlier in
> the pass — `sql:guards` on `supabase-verification-queue.sql` and `test:rooms` on `admin.html` — and
> both went green as that other writer landed their changes, which is why the numbers here move. The
> rows marked **this pass** are the numbers measured on the bytes this work left behind; the rest of
> the table is the earlier run, and §4b says what to trust if they drift again.
>
> **Both of the blockers named above are cleared.** The verification-queue writer landed after that
> pass: `netlify/functions/verification-aging.js` is on the timers' exemption list in
> `scripts/test-api-errors.mjs` — an exemption that is now ASSERTED rather than trusted, since a
> module that calls one of the four timers is a door nobody has given a class to — and
> `test:verify-queue` is in `ORDER` in `dev/run-tests.mjs`, so the suite that proves the queue's own
> clock and ordering now runs in the gate. A full `npm test` on this tree reports **27 of 27 suites
> passed, nothing failed**: `test:api-errors` 101/101, `test:verify-queue` 59/59, `sql:guards`
> 108/108, `sql:proof` 302/302, `test:admin` 572/572, and the submission confirmation's browser
> suite (`scripts/test-confirm-render.mjs`, 9 door answers of which 3 are held for a retry) 233/233.
> `npm run sql:mutate` reports **16 of 16 held, 13 mutations each caught on a healthy tree**, the two
> newest of which break guards in `supabase-verification-queue.sql`. The table below still holds this
> pass's per-row numbers, which are older than these.

| Suite | Result | What it covers for this work |
| --- | --- | --- |
| `sql:proof` | 268 / 268 | Applies all **17** migrations twice over, then §13c–f: the reference is server-minted and in the registry; **the row is written the way the door writes it, as the service role, and comes back with its reference through `RETURNING`**; it audits itself as `submitted` by `service_role`; the consent sentence is stored with the moment it was given; **anon holds no `insert` on any of the five public tables and the service role holds it on all five**; a bot with the page's own key is refused by the database on every one of them, honeypot or not, and leaves no orphan reference; the honeypot policies are still present and armed; a no-op update writes no trail line; the trail cannot be written, edited or erased even by an admin; the eleven-row role matrix incl. `service_role → service_role`, `operations → support`, `super_admin → admin`, `wizard → admin`; **verification approves a listing through `listing_verify()` and cannot write it row-wide at all** — the four columns it may move are the only ones that move, a PATCH of the same row changes nothing, no UPDATE policy names the role any more and the admin's is still there, the officer's approve is still in the audit trail with `verified_by` on it, and a marketing, support, finance or anon key cannot call the function; and verification cannot remove a listing; the books moved to finance; the throttle's gap, hourly and global ceilings; and that anon/authenticated cannot execute the throttle, read the registry, read the attempt log, or read the trail. |
| `sql:guards` | 80 / 80 | Every new migration's preflight guards fire and name the file to run, and stay silent when their prerequisites exist — including the verification RPC's three, and §4c drives the four raises INSIDE the function (who may call it, a missing row, and both vocabularies) against the real chain, with the happy path as the control that keeps them honest. The closer's first guard is also driven on an empty database, and its second — the one that stops the site being taken offline by its own hardening — on a database that has the five tables and no door. |
| `test:waitlist` | 38 / 38 **this pass** | GET refused; 503 `not-ready` without a key; unknown form refused; unreadable body refused; honeypot refused with **no** database write and no throttle slot; no consent → no row; an unreadable phone refused; a missing age band refused; a nested object cannot reach `jsonb`; the client cannot choose `status`, `tier`, `env` or its own reference; the response is never the row (no phone, no name, no key); the recorded consent sentence is **byte-identical** to the one `assets/app.js` shows; retry-by-`client_ref`, repeat-by-phone and the 409 race all return the reference already held; a 429 arrives as the page's `busy` class; **a throttle that cannot answer does not refuse a real student**; and the optional email on all three forms: blank is accepted and stores no key, a good address is stored **exactly as typed**, a malformed one is refused with a sentence naming it, and the addresses this site invents (`…@receipts.arzuz.com`) are refused — with the stored value handed to the status page's own reader, so the two files cannot disagree about whether the second channel is open. |
| `test:admin` | 447 / 447 | All five roles boot and land on something they may reach; the Pipeline column and stage tag render on the Demands table; **the selector is asserted both ways** — offered to admin and support, withheld from support on listings — so the control can only appear where the database would accept the write; on a listing it is now admin-only, and the new Approve action is asserted offered to `verification` and withheld from every other role, together with the fact that the officer is not also offered the row-wide editor; the finance panel is asserted for `admin` and its absence for support and marketing. |
| `test:api-errors` | 100 / 100 | The submission layer, driven against the real `assets/submit.js` in a page-shaped vm. The two new checks are what stop the fallback growing back: a `not-ready` submission calls the door **once** and never `/rest/v1`, and the queued retry goes through the door too. |
| `test:roommate-page` | 42 / 42 | The page's five error classes, plus the two new ones: the submit path does not reassure a student about answers that were never stored, and the matching path's "your profile is saved" copy does not leak into it. |
| `scripts/test-confirm-render.mjs` | 86 / 86 | The submission confirmation on the real `register.html`, in headless Chrome, against six answers the door can give (a saved row, a repeat by phone, the 409 race with and without a reference, an unreadable 200, and a refusal). The door is answered at the DevTools network layer, so what runs is the page's own code: the reference printed is the one the door minted, the panel never claims a save for a row the server only had, the duplicate sentence never points at a reference that is not under it, the toast makes the same claim, and the WhatsApp confirmation and the team alert go out exactly when the server wrote the row — with the saved case as the control that keeps the zeroes honest. Run by `scripts/test-all.mjs`, not by `npm test` (it needs a browser). |
| `test:status` | 56 / 56 **this pass** | The status page driven as an enumerator, with a stand-in PostgREST, a stand-in OpenWA and a stand-in Resend. **The one answer** is asserted byte-for-byte across a malformed reference, an unknown reference, a wrong number, a missing number and the real pair; the count is asserted to happen BEFORE the registry is read, so a broken throttle cannot become an oracle (and the same 502 for a reference that does and does not exist); the per-reference ceiling is asserted to fire only AFTER the pair is proved; the code is read out of the message that was actually composed and typed back, and asserted absent from every request body; the hash is 64 hex and changes with the salt; the reveal is asserted to carry no phone, name or payload; and the page's own rules are asserted (no browser storage, no branching on the reply, the sentence it prints is the function's own). **Added with the second channel:** the email address is read off whichever key a record keeps it on and only if it is deliverable; a typed address is compared lower-cased but never by a tail (two mailboxes are two people); the email request's answer is byte-identical to the unknown reference's AND to the phone channel's; the address reaches no answer and no log line; a WhatsApp sender that is down, or a number this site cannot address at all, delivers the SAME code to the inbox on that record and the reply does not change; a deploy with no mail provider issues nothing at all rather than spending the ceiling that protects the person; the two channels share one counter; and the page is checked as data — its channel copy, its validation, and the ids it paints. |
| `test:deploy-key` | 37 / 37 **this pass** | The build gate: absent, empty, whitespace-only and present values for every required variable; that the WhatsApp credentials are required rather than requested; that an advised variable warns without ever failing the build; that naming ONE variable in the override excuses exactly that one and a typo excuses nothing; that `0` and `no` do not count and the legacy `ARZUZ_ALLOW_MISSING_SERVICE_KEY` still means only the service key; the real CLI exit codes and which stream they go to; **that no value is ever printed, in whole, in part or length-sliced**; and the wiring, parsed out of `netlify.toml`, because a check no build runs is a comment. |
| `scripts/test-deploy-guards.mjs` | 103 / 103 | Run directly (it is not one of the `npm test` suites; `scripts/test-all.mjs` and CI run it). The three new SQL files answer 404 on the live site, `/status` resolves, its `.html` copy 301s, and a noindex page is not advertised in the sitemap — this is also the check that found `LAUNCH-READINESS.md` being served, which is now 404 too. |
| the other 15 suites | all passed | Untouched by this work. |

Three findings came out of the proof work, and all three are fixed:

- `revoke execute … from public` was **not enough**. Supabase's default privileges grant `EXECUTE` on
  new functions **explicitly** to `anon` and `authenticated`, so the throttle, the reference minter,
  the snapshot helper and the audit writer each had to be revoked from those roles by name. The
  assertion that caught it is in `sql:proof` §13e.
- An `INSERT … RETURNING` needs `SELECT`, so the anon door cannot read its own row back. That is now
  asserted rather than assumed — it is precisely why the reference has to be minted server-side.
- **Closing the direct path silently killed a branch of the audit trail.** `staff_audit_log`'s action
  was `case when tg_op = 'INSERT' and who = 'anon' then 'submitted'`. Once the only writer is the
  service role, `who` is never `'anon'` again, so that case became unreachable and every public
  submission would have read as a bare `insert` by a machine. Found by the assertion in `sql:proof`
  §13c that had been written as "audits itself as anon" — it failed, and it was right to. The branch
  now names the actor that performs a submission, and the row records `service_role` for the role,
  which is the truth.

One caveat on the numbers, because a document that quotes a count is only as good as the run it came
from: **another writer was working in this checkout while this work was being finished.** The suites
grew between runs (`sql:proof` 247 → 268, `sql:guards` 62 → 80, `test:waitlist` 27 → 31, deploy
guards 96 → 103), so the totals above are the counts these particular changes produced, not the
repository's ceiling. Everything in the table was green on the bytes this work left behind, and the
browser suite was re-run last, after the final change to `assets/app.js` — which is the file whose
copy it asserts on.

The counts in the table are the last full `npm test` of this pass, and it is worth saying which
number can be trusted if they drift again: **the suite's own line, not this document.** What was
added here is `test:status` (42) and `test:deploy-key` (22), `sql:proof` gained §13f's seventeen
checks for the code, its own throttle and the reveal, and `sql:guards` gained the new preflight's
rung and the new file's place in the chain.

### 4b. The second channel and the wider gate — the numbers from that pass

Measured on the bytes this pass left behind, in the runs where the unrelated failure above was the
only one left standing:

| Suite | Result | What changed |
| --- | --- | --- |
| `test:status` | **56 / 56** | 42 → 56: fourteen checks for the email channel and the fallback. |
| `test:waitlist` | **38 / 38** | 31 → 38: seven for the optional email at the door, including the seam into the status page's own reader. |
| `test:deploy-key` | **37 / 37** | 22 → 37: the required list, the advised list, both override forms and the legacy one. |
| `sql:proof` | all green (268 on the first run, 278 by the last — another writer added checks in between) | unchanged by this work: the channel is the function's business, so no migration changed and `supabase-status-codes.sql` differs only in its header comment |
| `sql:guards` | all green (101 / 101 on the last run) | was failing on the other writer's `supabase-verification-queue.sql` earlier in the pass and went green when they landed their harness |
| `test:seo`, `test:indexnow`, `test:listing-og`, `test:browse`, `test:rooms`, deploy guards | all green | no check was added here, but each of them reads a file this work changed — the pages the two new forms sit on, the routes in `netlify.toml` and the sitemap |

Both suites were also driven against a deliberately broken build to prove the new checks bite rather
than merely pass: removing the fallback fails three of them, comparing the address case-sensitively
fails four, letting any non-empty override value read as "allow" fails three, and dropping `--require`
from the build command fails the wiring check. The mutations were reverted and both suites are green
on what is in the tree.

A fourth came out of the narrowing of the officer's write, and it is worth writing down rather than
remembering: **the officer's write had to keep its audit line.** A `SECURITY DEFINER` function runs as
its owner, so it would have been easy to build one that writes a row nobody can attribute — the trail
fires on the statement, not on the key that issued it, and it reads the acting role out of the
session's own JWT. `sql:proof` §13d now asserts the line exists for the RPC's write, names the
columns it moved and carries `verified_by`, because a narrow write that cannot be attributed is not an
improvement on a wide one that can.

And one thing this change did NOT fix, said here rather than discovered later: the officer's approve no
longer sets `env`, so approving a listing that is not a production row leaves it off the browse board.
That is the admin's Publish, deliberately — but a team that expects Approve to publish now has two
controls where it had one, and the copy on the toast says which record it wrote.

### 4c. The desk's code history — the numbers from that pass

| Suite | Result | What changed |
| --- | --- | --- |
| `test:status` | **62 / 62** | 56 → 62: six for the trail (its own code id, the fallback in order, no address on the file, a refused mail, the bytes that were sent, and a trail write that fails changing nothing) and one rewritten from its opposite — the ceiling is no longer sent from this file. |
| `sql:proof` | **290 / 290** | 278 → 290: §13h's twelve checks for the trail, the closed vocabulary, the writer's contract, the desk's authorization, the leak assertion and the ceiling. Two §13f checks were rewritten, not weakened: they now record the ceiling on the row, which is where it lives, and assert that a claimed ceiling of twenty is ignored. |
| `sql:guards` | **108 / 108** | 101 → 108: the new preflight's covered raise and its rung, the sentinel, the silent rung against a stub code table, §4e's two checks for the role refusal, and the chain's new link. |
| `test:admin` | **483 / 483** | 470 → 483: five checks per role over all five logins, driven against the mock PostgREST. |
| `test:seo`, `test:indexnow`, `test:listing-og`, `test:browse`, `test:rooms`, deploy guards | all green | no check added, but each reads a file this pass changed — `netlify.toml` routes and 404s, `admin.html`, and the SQL-file scan in `test:status` that requires a hard 404 for every `supabase-*.sql`. |

The ceiling change was also checked in the direction that matters: `sql:proof` §13h issues a code, verifies
it with a claimed ceiling of **twenty**, and asserts the refusal still comes at the code's own five (and
the row's own four, in the check where the ceiling is written down). The mutations that were reverted
rather than left in: an unbounded `status_history` (the role refusal removed) fails two checks, and
`attempts_left` computed as a raw subtraction fails the check that a spent code offers none.

---

## 5. The spec's acceptance tests, one by one

| §  | Test | Verdict |
| --- | --- | --- |
| 7.1 | Public users can browse listings and submit waitlist forms without logging in | **Pass.** Unchanged and verified by `test:browse` / `test:rooms`. No form asks for a password or an account. |
| 7.2 | Public users cannot access admin data or privileged operations | **Pass.** Every read is `to authenticated` + role-scoped, and since `supabase-close-public-inserts.sql` the five public tables are not writable by **any** key a browser holds: the door writes with the service role, and `sql:proof` §13c asserts both halves of that. `sql:proof` also proves marketing, finance and anon read **zero** rows. |
| 7.3 | Each staff role reaches only its permitted functions | **Pass.** Five roles, asserted as an eleven-row matrix in `sql:proof` §13d and enforced by policies — including the officer's, whose one write is a four-column function rather than a policy (§6, risk 2). |
| 7.4 | Changing a frontend role or URL cannot bypass backend authorization | **Pass.** The role comes from the signed JWT; Postgres recomputes it per request; `admin.js`'s role map is a courtesy on top. `sql:proof` drives every role against real policies. |
| 7.5 | Duplicate submissions and spam are handled appropriately | **Pass.** Honeypot at both the door and the anon insert policies; per-IP gap/hourly/global ceilings in the database; a repeat submission returns the reference already held instead of a second row. |
| 7.6 | No passwords, secret keys or private admin data in logs or public responses | **Pass.** The waitlist log line is the form, the outcome and the reference — no phone, no name, no answers. IPs are only ever a salted hash. The response is the reference and the stage. Asserted in `test:waitlist`. |
| 7.7 | Waitlist data survives refreshes and is stored in the intended database | **Pass.** Rows go to `demand_records` / `listings` in the Supabase project; the offline queue is the existing retry-safety path, and the reference makes a retry idempotent. |
| 7.8 | Authentication failures and expired sessions are handled safely | **Pass.** `finance.js` / `team.js` / `care-credit.js` verify the token against GoTrue; the dashboard refreshes or clears the session; `assets/auth.js` names an expired session as an expired session. |

### Where least privilege is now applied (and where it is not)

`support` no longer reads the books. Before this change, the six read policies in
`supabase-finance.sql` let the desk open the ledger, the payments, the payouts and the price
configuration — a real over-reach that the spec's §4 names directly. They now belong to `finance`,
and `finance.js` refuses support at the function door as well.

What was **not** changed: `support` still reads the Care ledger and the repair queue. That is
operations work — recording a call-out and answering *"where is my repair?"* — not book-keeping, and
those two files' policies for support are read-only in any case. If you want the desk out of Care
too, say so and it is a four-policy change in `supabase-care.sql` and `supabase-claims.sql`.

---

## 6. Risks still unresolved

Ranked by what would hurt most.

**1. The door is now a single point of failure (new, and the price of closing the path).** There is no
second way in for anything: if `SUPABASE_SERVICE_ROLE_KEY` is missing, rotated or wrong for a deploy,
the door answers 503 `not-ready` and submissions are held in the student's browser rather than
written — nothing is lost, but nothing is recorded until the key is restored, and a student who never
reopens the page is a lead the team never sees. **Mitigation already in place:** `not-ready` is a
*queueable* class, so the row is re-sent through the same door on the next visit, and the copy tells
the student plainly that nothing was sent and to message WhatsApp. `sql:proof` §13c asserts the other
side of it — the service role holds `insert` on all five tables, so a revocation that went too far
fails the proof rather than production. **Remediation:** a deploy-time assertion that the variable
exists in production, so a deploy with no key cannot reach students at all.

**2. A verification token may update any column of a listing — RESOLVED, and worth keeping the entry
for.** RLS decides which *rows* a role may touch, not which columns, so an officer approving a listing
could also change its price; the trail recorded that, which made it survivable rather than correct.
**What now enforces it:** `supabase-verification-rpc.sql` withdraws the row-wide update policy and
adds `public.listing_verify(uuid, text, integer)`, a `SECURITY DEFINER` function that moves
`status`/`tier`/`verified_at`/`verified_by` and refuses everything else by construction — a
PATCH of the same row now matches zero rows. It admits the `verification` role and an admin, and
refuses every other token, in the function itself, because a grant to `authenticated` is role-wide.
**Asserted** in `sql:proof` §13d (the four columns and only those move; the row-wide PATCH writes
nothing; no UPDATE policy names the role and the admin's remains; the officer's approve still lands
in `staff_audit_log` with `verified_by` on it; marketing, support, finance and anon are refused) and
in `sql:guards` §4c. **What it costs:** the officer's approve no longer sets `env`, so approving a
listing that is not a production row leaves it off the board — that is deliberately the admin's
Publish, and an officer's decision is now only ever the verification record.

**3. The rate limit counts IP addresses, and a campus is one address.** The per-IP ceiling is 60/hour
precisely because hundreds of students share one NAT. A hostile actor with a botnet is bounded only by
the global ceiling (4000/hour). **Remediation:** none needed for launch; if it ever matters, move the
per-IP counters to a shorter window and add per-phone instead.

**4. `verification` and `finance` have shallow dashboard coverage (narrowed, not closed).**

`dev/admin-boot-test.js` now drives all five roles: each one boots, lands on a section it may reach,
is gated off every section it may not, and renders its landing section without a console error — 444
assertions. What is still missing is depth: the finance and claims panels are asserted in the blocks
that exercise them for `admin`, not re-driven for the two roles that now hold them, so a role-specific
branch inside those panels would not be caught. **Remediation:** drive the panel bodies per role
rather than once for admin.

**5. The reference is a bearer handle — and it is no longer one on its own. CLOSED, with one limit
left.** `/status` (status.html + netlify/functions/status.js + supabase-status-codes.sql) is the lookup
§9 asked for, and it is built so that holding a reference is not the same as being able to read
somebody's file: the page also needs the phone number ON THAT ROW, and then proves control of it with
a six-digit code sent to that number over the existing OpenWA sender. The code is what opens the file,
and it is spent the moment it is used.

The enumeration defence is two separate things, because either one alone was not enough. The count is
claimed in the database BEFORE the reference is looked at, in a table of its own
(`status_guard`) so a lookup flood cannot spend the ceiling real submissions are judged against, and
so a busy launch day cannot start refusing status checks either. And every answer that is not the
caller's own rate limit is the SAME body — a malformed reference, a reference nobody minted, a wrong
number, and a code that really is on its way are indistinguishable, which is asserted byte-for-byte
in `test:status`. The failure mode of that design is the thing to keep in mind for later: **there is
also one sentence for a wrong code, an expired code and a code with no attempts left**, because
telling those apart would let a caller with a leaked reference learn whether a code had ever been
issued for it.

**The WhatsApp-only half of this risk is CLOSED, and the rest is stated rather than rounded off.** The
code now has a second channel: the email address on the file, chosen by the student, with the same
reference and the same proof — and the WhatsApp path falls back to that address by itself when the
number cannot be messaged or the sender refuses, so an OpenWA outage no longer strands anyone who
gave us an email. What remains:

- **A student who gave us no email and has changed their number still cannot be reached.** The
  channel exists; the contact does not. The page says so plainly and points at the office WhatsApp,
  and the fix is the same as it always was — a human updating the number by hand.
- **The email channel only works where `RESEND_API_KEY` is set** (advised, not required, in the
  build gate) and where the address was verified with the provider. Until the domain is verified in
  Resend, their shared sender only delivers to the account owner.
- **The office could not see a code's attempt history — CLOSED, with one blind spot.** The Support
  Desk now has a **Status code history** panel fed by `supabase-status-history.sql`: every code asked
  for against a reference, where each attempt went, whether the sender took it, how many tries are
  left and whether the code was used. It writes nothing, and the database decides who may ask. The
  reference does not have to be found first: **the last four characters, or the phone number the
  student applied with, will do** — and when more than one reference could be meant the panel lists
  them and says nothing about any of them until the officer picks.
- **The blind spot is a request refused BEFORE a code was issued.** Two refusals happen at that
  point — a deploy with no mail provider, and the per-reference ceiling — and neither can leave a
  trail row, because there is no code for it to be about. A student who used the email channel on a
  deploy with `RESEND_API_KEY` unset is therefore invisible to that panel. It is not silent: the
  panel's empty state names this case rather than implying nobody asked. **Remediation, if it
  matters:** record the refusal against a code-less attempt (a nullable `code_id` on the trail, or a
  second counter), and decide what the ceiling should do when it fires on a channel that cannot
  deliver.
- **The trail's retention is the codes' retention.** `status_code_deliveries` cascades with its code,
  and codes are pruned a day past expiry, so nothing here grows without bound and nothing outlives
  the code it is about.
**Remediation for the rest:** a support-initiated read for the student who has neither contact — the
only case left that needs a human, and the same fix as the first bullet above.

**6. `submission_guard` grows without bound on a flood.** Rows are pruned past 26 hours with a 5%
chance per call, and a refused attempt still writes one row. A sustained flood of ~4000/hour would
hold about 100k rows. Growth is bounded and the table is tiny, but the pruning is probabilistic.
**Remediation:** a scheduled delete if the table ever passes a size you care about.

**7. The audit trail has no retention limit.** It is append-only by design and grows with every change
to a waitlist row. Fine at this scale; worth a policy before it is a gigabyte. One consequence of the
door is worth knowing here rather than discovering: a public submission is now recorded as
`submitted` by `service_role`, not by `anon`, because the service role is the actor that writes it.
That is deliberate — the role says who wrote the row and the action says what happened to it — but a
reader looking for "what did the public send us" should filter on `action = 'submitted'`, not on
`actor_role = 'anon'`.

**8. A roommate profile is lost if the matcher is down. CLOSED.**

When the direct path was closed this was a real capability loss, and it is now restored through the
door rather than around it: `/api/waitlist` has a sixth form, `roommate_profiles`, which is the
questionnaire's own name and its own question list — a name and a phone, and no age band, because it
never asks for one. It lands in `demand_records` with `roommate: 'yes'` on it, `name` mapped onto the
`first` key the dashboard's `first_name` column is generated from, and it gets everything the other
five public forms get: validation, the throttle, the honeypot, a recorded consent sentence, the audit
trail and a reference the student can read out.

The reason the old fallback could never have worked is the reason this one needs its own form: it
posted the questionnaire AS a student registration, and that form requires the age band which is what
sets `is_minor`. A row without one is refused by the door, and inventing one would file a student
under the wrong rules.

What remains is a narrower gap and it is worth naming: the handover puts the student in the pool the
team works by hand, and they get a reference — but there is no private link and no percentage, because
no profile entered the matching pool. `assets/roommate.js` says exactly that, in a note painted into
`#rmPanel` (a sibling of `#form`, which the engine replaces with its "your profile is in" screen).
**Remediation, if the matcher is ever down for a long stretch:** a queue that re-attempts the matcher
for handed-over rows, so a student who came for a percentage gets one when it returns.

---

## 7. Launch-critical, versus post-launch

**Launch-critical (done):** waitlist data model with reference, consent, pipeline and assignee; the
server-side door with validation and throttling; the honeypot at two layers; staff authentication
(reused, not rebuilt); the five-role least-privilege split incl. support losing the books; the audit
trail; the forms still working without login; no passwords anywhere.

**Post-launch, in the order I would do them:**

1. **Give the roommate matcher a real fallback** (risk 8) — the one place where closing the path
   cost a capability rather than redundant cover.
2. **A deploy-time assertion that the service key exists** (risk 1), so a keyless deploy cannot reach
   students.
3. **Depth on the finance and verification panels** (risk 4). The column-scoped verification RPC that
   used to sit beside it (risk 2) is done: see `supabase-verification-rpc.sql`.
4. **Unify `status` and `follow_up_status`** — one column, one vocabulary, with the views rewritten
   alongside it.
4. **The help center** (§8) — designed below, not built.
5. **The verification layer** (§8) — stage 2 is built (§8.2a); stage 3 is designed below and deliberately
   off until volume triggers it.
6. **Customer accounts + waitlist linking** (§9).

---

## 8. Designed, not built: the help center and the verification layer

Both of these are explicitly gated on scale, and the user's instruction was to design them now and
turn them on when the manual operation stops working. **Nothing in this section is implemented.** It
is a specification to build against when the trigger is met.

### 8.1 The help center

**The problem it solves.** Today every question that is not on a page goes to `09024814771`, which
means the same twelve answers are typed out by hand, the team's attention is spent on questions the
site could answer, and the WhatsApp number is the first thing a confused visitor reaches for instead
of the last.

**The shape — Facebook's help center, not a knowledge base.** A visitor arrives with a *question in
their own words* or with *a thing that is broken*. So the entry point is a search box over questions,
not a list of articles, and every answer ends with the one action it implies.

```
/help                       search + the six question clusters
/help/what-happens-after    what the reference means, when we message, what a match looks like
/help/prices-and-fees       who is paid, what Arzuz takes, what nothing costs
/help/listing-a-property    the landlord flow, the invite link, why verification takes a day
/help/safety                under-18 rules, viewings, the guardian contact, reporting a listing
/help/care-and-repairs      what a Care Pass covers, how a claim starts, how long a repair takes
/help/contact               the LAST resort, and the only place the number appears
```

**The rule that keeps the number out of the rest of the site.** Every page keeps *one* support link,
and it points at `/help`. The WhatsApp button moves to `/help/contact`, behind a step that asks what
the question is about and offers the three or four articles that already answer it. A visitor who
still wants a human gets the number; a visitor whose question was "when will you message me" gets the
answer in two seconds and never opens WhatsApp. This is the whole point of the change: **the number
stops being the first resort and becomes the last.**

**What it needs that does not exist yet:**

- A **search** over the articles. At this size, client-side over a JSON array of
  `{q, a, page, tags}` — no search service, no index, no dependency.
- A **contact-event count** per article, so the pages that do not work announce themselves. The
  existing `strategy` pack already reads growth numbers; the help center should feed the same place.
- **Article markup that is crawlable without JavaScript**, for the same reason `register.html`'s
  intro block exists: Search Console fetches the served HTML first, and a page built entirely by
  script is a page it will not index.

**The trigger for building it:** when the WhatsApp inbox contains the same question five times in a
day. Measure it, don't guess it.

### 8.2 The verification layer

**The problem it solves.** Somebody listed a self-contain on a road that floods, and the first person
to find out was a student standing in a puddle. Verification is the product promise — *the price the
owner actually charges, and a room that is what it says it is* — and it is currently done by the team
remembering, at the speed the team can drive around Malete.

**The design: a staged gate, priced in money rather than attention, switched on by volume.**

| Stage | Trigger | What it means | How it is enforced |
| --- | --- | --- | --- |
| 0 · Manual *(today)* | — | The team visits everything, and `tier` is set by hand from field notes. | `listings.tier`, the admin dashboard |
| 1 · Sampled | > 25 new listings a week | A new listing goes live at `tier` 0 as **unverified**, visibly flagged, and is sampled for a physical check within 72 hours. | A `tier = 0` badge on the card and the room page |
| 2 · Assigned | > 75 a week, or two officers | `verification` is a shift: a queue, a deadline per listing, and the officer's account on the record. **Built** — see 8.2a. | The `verification` role, `verified_at` / `verified_by`, the audit trail, `supabase-verification-queue.sql` |
| 3 · Verified-with-evidence | > 200 a week | An artefact per listing: a geotagged photo set, a water-pressure note, a signed owner statement, with an expiry. | A `verification_events` table (append-only, like `care_credit_events`) and a public badge that *names* what was checked |

**What already exists to build it on.** `listings.tier` (0 unverified / 1 community / 2 inspected),
`verified_at` / `verified_by` on both waitlist tables, the `verification` role with read + approve and
no delete, `scout_submissions` as field evidence, and an audit trail that records exactly which fields
an officer moved and when. Stages 1 and 2 are mostly a queue UI and a deadline clock —
`claims-aging.js` already pages the team once per missed deadline and is the pattern to copy.

### 8.2a Stage 2 is built

**What it is.** Stage 1 could only tell a student the truth (*this room has not been checked*). Stage 2
tells the TEAM: a live tier-0 listing is a job with a deadline, an officer can take it, and a job nobody
came back on returns to the queue on its own.

| Piece | What it is | Where |
| --- | --- | --- |
| The claim | `assigned_to` (already audited) plus `taken_at`, written ONLY by two functions | `supabase-verification-queue.sql` |
| `listing_take(p_id)` | Puts this login's account on the listing and starts its 48 hours. Refuses a listing another officer holds, and one already decided | same |
| `listing_release(p_id, note)` | Gives it back. An officer may release what they hold, an admin anything, and the chaser (service role) a job nobody answered | same |
| `verification_queue()` | The shift, read-only, from a FIXED column list — never the owner payload | same |
| `verification_events` | Append-only: taken / released / nudged. What keeps the clock from saying the same thing every hour | same |
| The clock | 72h to a first visit, 48h once taken, 24h of silence after a nudge before the job goes back | `assets/verification-queue.js` |
| The chaser | Hourly: nudges ONCE per lateness, reclaims what stayed silent, shouts if it cannot read or write | `netlify/functions/verification-aging.js` |
| The officer's queue | `/admin` → Listings: late first, Take / Release / Approve, hidden from every other role | `assets/admin.js`, `admin.html` |

**The number that is now one number.** 72 hours is the sentence stage 1's badge makes to a student, so it
is also the queue's first deadline; 48 is how long an officer holds a job; 24 is how long silence is
allowed to last after being asked. All three live in `assets/verification-queue.js` and are loaded by both
the dashboard and the chaser, so a panel that says *late* and a message that says *fine* is impossible by
construction rather than by care. `scripts/test-verification-queue.mjs` (59 checks, all passing) asserts
the policy exists in one copy, and that one mutation to the once-per-lateness rule turns twelve checks
red.

**What it costs, and what it does not do.**

- The reclaim is automation taking work off somebody's name. It is deliberately narrow: the listing keeps
  its tier, its price and its board state, nothing is deleted, and the officer loses the CLAIM and not the
  work — the trail says who was silent and for how long. It fires only after a nudge has been on the
  record for the full window, so an officer who answers at any point is never reclaimed from.
- The deadline is COMPUTED, never stored: the stage's hours measured from when the stage began. That is
  why `taken_at` exists as a column and why nothing can buy a job another deadline by being edited.
- The chaser pages a Telegram channel. If nobody reads that channel, this is a quieter version of the
  problem it was built for — the honest backstop is still a person opening the dashboard.
- Stage 3 (evidence per listing, a public badge naming what was checked) is NOT built, and the trail here
  is not it: `verification_events` is about the SHIFT, not about what was seen at the door.
- The officer's queue is checked in the dashboard's own harness for all five roles: that the card ships
  `display:none` in the markup and the gate hides it again for anyone off the shift; that the panel says
  what is owed and puts the overdue listing first; that the queue carries a reference and none of the
  owner's contact details; and that Take moves `assigned_to` and `taken_at` and **nothing else** (asserted
  as a union diff of the row, because "nothing else" is the whole point and a screenshot cannot see it).
  Refusals are checked too — another officer's claim, and a release by a login that does not hold it — and
  each must NAME the holder, not answer "our side, not yours". The two RPCs are proved against real
  Postgres in `dev/sql-proof.mjs` section 13g. What is still not walked is the literal button CLICK in a
  browser: the harness's DOM shim answers `closest()` with null, so the suite calls the exposed
  `verifyQueueWrite` the click calls, and the functions underneath it are real.
- **A gap this suite found, now closed.** The harness had never loaded `assets/verification-queue.js`, so
  every dashboard role booted a page whose panel said "the queue clock did not load" — and nothing failed,
  because no check had ever read that panel. It is in the sandbox's script list now, in the same position
  `admin.html` loads it. The refusal path had a second one: the page answered every 400 with the
  classifier's "that is our side, not yours", discarding the function's own sentence — `listing_take: <name>
  already has that listing` — which is the only part of the answer an officer can act on. A refusal is
  now shown as the function wrote it, with the RPC's name stripped, identified by the `listing_take:` /
  `listing_release:` prefix rather than by an SQLSTATE (the raises carry 22023 and 42501, not P0001) —
  and it is read BEFORE the 401/403 branch, because the 42501 on "holds that listing, not you" arrives as
  a 403, which this page otherwise treats as a dead session and answers by signing the officer out.

**What is deliberately absent.** No new provider, no address-verification API, no ID service. A
student does not need Arzuz to prove who owns a building; they need Arzuz to have *been there*.

**The trigger for stage 3:** when a student asks "what exactly did you check?" and the answer is
currently a person's recollection.

### 8.3 What "handling 100,000 people" changes

The user's stated trajectory is a system that scales to hundreds of thousands. Nothing in this launch
work blocks that, and three decisions were made with it in mind:

- **The reference registry is one table with one primary key**, not a per-table counter, so it scales
  as the waitlist does and a future lookup has one thing to query.
- **The throttle lives in Postgres, not in a Netlify instance.** It is the one rate limit that holds
  across every instance Netlify starts, which is what breaks first at scale.
- **The public write path is a single function with a closed table allowlist.** Going from one door to
  a queue (a Cloudflare Queue, SQS, or a Postgres-backed job table) is a change to one file, and the
  duplicate detection that makes retries safe is already in the database.

What will need real work before six figures: the `payload`-as-JSONB shape is fine for a form and wrong
for querying a million rows, so the generated columns would move to a materialised read model; and
`submission_guard` would move to a dedicated counter store.

---

## 9. Customer accounts and linking (spec §5–§6) — designed, not built

**Not built, on purpose.** The waitlist must work without accounts, and building login before there is
something to log into is how a launch loses a week.

**What is already in place so that it stays cheap:** `demand_records.linked_user_id`, `linked_at` and
`link_verified_via` exist, nullable and unused. An existing waitlist row can therefore be pointed at
an authenticated user **without losing its `created_at`, its `ref`, its consent record, its
`follow_up_status` or its audit trail** — the row is never copied and never merged.

**The linking flow, when it is built:**

1. The applicant asks to claim their record, through a link that carries the reference — not by
   typing a phone number, which anybody can type.
2. They prove control of the **email or phone already on the row**: a one-time code to that email, or
   a WhatsApp reply from that number through the existing `wa-inbound.js` webhook.
3. Only then is `linked_user_id` set, with `link_verified_via` naming how and `linked_at` when.
4. A mismatch is a **refusal**, never an automatic merge. Two rows that look alike are two people
   until somebody proves otherwise; the spec is explicit about this and the data model makes the safe
   answer the easy one.

**Which sign-in method.** Reuse what is configured — Supabase Auth, already in place for staff — and
evaluate in this order, when the feature is wanted: email magic link first (no password to leak, no
Google dependency), Google second if the data asks for it, password last (only if there is a
demonstrated need, and never on a public waitlist form). **Do not migrate providers to add a second
login method**; the spec says so and there is no reason to.

**Invitations are not sent until this is built and tested.** No account invitation exists in this
change.

---

## 10. One-paragraph summary

The site already had the right auth provider (Supabase Auth), the right enforcement point (Postgres
RLS with a role claim) and the right public/private split. Over the launch work the last policy that
was wider than its role got narrowed too: the officer who checks a room approves it through a
four-column function, so "who went and when" is a record and "what it costs" is not theirs to change. What it did not have was a waitlist that
could hand a person a reference, record what they agreed to, tell the team who is working their row,
or keep a spammer out — and it gave every support login a view of the books. Those six things are now
implemented, and the last loose end is tied: the direct PostgREST path is closed at both ends, in the
database and in the page, so a public submission exists in exactly one shape — validated, throttled,
consented, referenced, audited — and cannot be forged by anyone holding a key the site ships. All of
it is proved against real Postgres in WebAssembly and green: 21 suites, 247 SQL assertions, 27 door
assertions, 96 deploy guards. Three setup steps remain (`§3`), in an order that matters — the service
key is set and proved before the direct path is closed — and the eight risks that remain, including
the one capability this step cost, are named above with their remediations rather than rounded off.
