# Arzuz — the launch runbook

One ordered list, from today's production state to a site that can keep its promise. Every step
says **Run** (what to do), **Verify** (the exact command or click) and **Expect** (the output that
means it worked). Nothing here is optional, and no step's verification is another step's output —
each one is re-checked on its own.

Why a runbook rather than a checklist: every one of these migrations is applied **by hand**, and
nothing in the repository can see whether that happened. On 17 Oct 2026 that gap was measured
rather than assumed — the code was green on all 51 suites while `/status` answered 502, Care
answered 502, and a registering student was told *"the reference has not been generated yet
because the launch migration has not been run on this database"*.

**One command answers "is it done yet", at any point in this document:**

```
npm run migrations:live        # exit 0 = every supabase-*.sql has run
```

It is read-only, needs no secret (the anon key from `assets/config.js`), writes nothing, and names
each migration that is still missing with the relations it would create. Re-run it after every step
below; the file you just ran should flip from ✗ to ✓ and the script's exit code should move toward 0.

---

## Where production is right now (measured, not assumed)

| | State | How it was measured |
| --- | --- | --- |
| Code | deployed, 51/51 suites green | full gate, `node scripts/test-all.mjs` |
| Database | **8 migrations unapplied, 30 relations missing** | `npm run migrations:live` |
| The public door | open to anon (grant not revoked) | `bash scripts/hardening-probe.sh` §D2, 5 failures |
| `/status` | **502** on both steps | `POST /api/status`, steps `send` and `verify` |
| Care | **502** | `npm run care:live`, exit 1 |
| Board | **0 listings** | `public_listings` count = 0 |
| Pages, assets, RLS, cards, 404s | all correct | live probes + browser |

Two of those are code-shaped problems and are fixed by running SQL. The last row is inventory.

---

## Step 0 — the credentials a later step depends on

**Run** — Netlify → Site configuration → Environment variables. These must exist before step 10,
because step 10 is the step that makes the door the *only* way in:

| Variable | The gate treats it as | Needed by | If it is missing |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | **REQUIRED** — the build refuses to publish | the door, the status page, the team panel | the door answers 503 and holds the answers in the student's browser |
| `OPENWA_URL`, `OPENWA_API_KEY` | **REQUIRED** — the build refuses to publish | confirmations, and every status code | the code is issued and never delivered |
| `RESEND_API_KEY` | ADVISED — reported, never blocking | the email channel of `/status` | the email channel cannot send; WhatsApp still works |
| `ARZUZ_MAIL_FROM` | optional, with a working default | the verified sender address | falls back to the default sender in `notify.js` |
| `OPENWA_SESSION` | ADVISED | which OpenWA session sends | falls back to a hardcoded name, and every message is refused if it is not the session your server actually has |

**Also check, once, that CI can be read at all** — `node dev/ci-status.mjs` (or `npm run ci:status`).
GitHub answers `404 Not Found` for this repository from an unauthenticated caller, and that 404 is
not "no CI": GitHub answers 404 (never 403) for a repo the caller may not see, so it hides whether
the repo exists at all. The tool says which answer it got and exits **2** when it could not check —
"not verified" is never reported as "verified fine". To make it real, give it a token instead of
installing `gh`: `GH_TOKEN=<fine-grained, Actions: read> node dev/ci-status.mjs`. The token is read
from the environment and is never written, printed or committed.

**Verify** — the build already asserts the first three: `netlify.toml` runs
`node scripts/require-service-key.mjs --require` as its build command, so **a deploy that is live is
itself the evidence**. For the mail pair (which the gate advises on rather than requires), run
`node scripts/require-service-key.mjs` — the reporting mode — which names each variable as set or
missing and never prints a value.

**Expect** — a green deploy. If the deploy is red, stop here: nothing below can help.

## Step 1 — the role vocabulary and the honeypot

**Run** — Supabase → SQL Editor → New query → paste all of `supabase-team-roles.sql` → Run.
Re-run it even if it has run before; it is idempotent and the launch expects its current contents.

**Verify** — `npm run migrations:live` → `✓ supabase-team-roles.sql all 5 present`.

**Expect** — the five `growth_*` views. (Already true today; this step is a confirmation.)

## Step 2 — the waitlist door, which is the one that mints the reference

**Run** — `supabase-waitlist-launch.sql`. Needs step 1.

**Verify** — `npm run migrations:live` → `✓ supabase-waitlist-launch.sql all 3 present`
(`waitlist_ref_registry`, `submission_guard`, `staff_audit_log`).

**Expect** — Submit one real registration from `/register` afterwards. The confirmation must show a
reference of the form `ARZ-S-XXXX-XXXX-XXXX`. **Before this step, the same submission is saved but
returns no reference** — that is the promise this migration is what keeps.

## Step 3 — the officer's approve, column-scoped

**Run** — `supabase-verification-rpc.sql`. Needs step 2.

**Verify** — `node dev/sql-proof.mjs` locally (it asserts §13d), and on the live side the officer's
PATCH must match zero rows while `listing_verify` moves exactly four columns.

## Step 4 — the status page

**Run** — `supabase-status-codes.sql` (needs step 2), then `supabase-status-history.sql`, which
adds a column to the codes file's table and re-states its `status_verify`. That order matters in one
direction only: **never re-run the codes file after the history file**, because it would restore the
older function that ignores the code's own ceiling.

**Verify** — `npm run migrations:live` → both files ✓, then open `/status` and ask for a code. It
must answer, not 502. Then check the two failures that matter more than the happy path: a **wrong**
code and a reference that does not exist must both read exactly like the correct pair before the
code lands.

**Expect** — `status_codes`, `status_guard`, `status_code_deliveries` present, and the Support
Desk's **Status code history** panel filling in.

## Step 5 — the verification queue

**Run** — `supabase-verification-rpc.sql` if it is not already in (the decision), then
`supabase-verification-queue.sql` (the shift).

**Verify** — `npm run migrations:live` → ✓ for both, then sign in on `/admin` as the verification
login and confirm the queue panel draws: a live tier-0 listing owed a visit, and no listing drawn
for a login that is not on the shift.

## Step 5b — what the visit saw

**Run** — `supabase-verification-evidence.sql` (needs both files in step 5).

**Verify** — `npm run migrations:live` → `✓ supabase-verification-evidence.sql` (the table
`listing_evidence`, the view `public_listing_checks`). Then take a listing on the dashboard's queue
panel, tick two checks with a sentence each and press **Record the visit**: the panel must replace the
listing with the next one, and `select * from public_listing_checks` must show both checks — while
`select * from public.listing_evidence where listing_id = '<id>'` shows the officer whose account
recorded it. The badge on `/browse` and on the room page must now name those checks and the date,
and must read **Re-check due** rather than "Inspected" once `expires_at` has passed.

## Step 6 — Care

**Run** — `supabase-care.sql`.

**Verify** — `npm run care:live`. **Expect exit 0.** Until then it exits 1 and names the missing
layer; the message changes as each layer lands. The students' page `/my-care.html` already serves.

## Step 7 — claims and the repair queue

**Run** — `supabase-claims.sql`.

**Verify** — `npm run migrations:live` → ✓ for the three relations, then open the dashboard's claims
panel on a real signed-in session and confirm it renders instead of erroring.

## Step 8 — the roommate matcher

**Run** — `supabase-roommate.sql`.

**Verify** — open `/roommates` and complete the questionnaire; the percentage path needs these five
tables. (The hand-over path through the door works without them and gives a reference.)

## Step 9 — the books

**Run** — `supabase-finance.sql`. Idempotent; safe to re-run if you want the six read policies moved
to the `finance` role.

**Verify** — the dashboard's finance panel, signed in as `finance`, shows the books and **zero rows
on every waitlist table**.

## Step 10 — close the second door. LAST, and only after a successful submission

**Run** — `supabase-close-public-inserts.sql`.

This is the step that makes `/api/waitlist` the only way a public form reaches the database. It
refuses to run unless step 2 has landed (it checks for `waitlist_throttle`), but it cannot check a
Netlify environment variable for you — which is why step 0 comes first and step 2 is verified with a
real submission before you get here.

**Verify** — `bash scripts/hardening-probe.sh`. **Expect `RESULT: 27 passed, 0 failed`.** Before this
step the same probe reports **5 failures** in section D2 ("the direct door is closed — anon holds no
INSERT grant"), because section D only ever asked whether a forged *active* row is refused, and that
is a different question from whether a bare insert is.

**Expect** — then submit one more real registration. It must still come back with a reference: that
is the door proving the revoke did not touch the role it writes with.

## Step 10b — the two guards that check the dashboard per role

**Run** — nothing to configure; these run in `npm test`.

**Verify** — `npm test` and read the admin suite's two role blocks:

- **support** drives Care the way the desk drives it — the drawer opens, a call-out with nobody
  named is refused before any request, and the credit that *is* recorded moves the ledger by exactly
  one and names the worker.
- **marketing** drives the Growth page — the only page that login has. It must carry no phone number
  or name from the rows behind it, must not offer a door to a section marketing cannot open, and when
  the PII-scrubbed `growth_*` views refuse it must **name the missing migration instead of drawing
  zeros**. The last one was a real defect: the page's own comment said it should say so and only the
  overview card did, so the one login that lives on that page saw an outage reported as "zero
  registrations".

**Expect** — `TOTAL 581 · PASS 581 · FAIL 0` for the admin suite (572 before these blocks, with two
checks removed because they could never fail: they asserted the absence of a `data-care="adjust"`
control that exists nowhere in `assets/admin.js`).

## Step 11 — the promises around the form

**Run** — the open boxes in [SETUP.md](SETUP.md#before-you-share-the-link-publicly):

- offline queue tested with airplane mode — one row, not two
- `ENV` on `production` and any test rows deleted
- `RESEND_API_KEY` set **and `ARZUZ_MAIL_FROM` verified in Resend** (until the domain is verified,
  Resend's shared sender only delivers to the account owner)
- on `/status`, one code by **Email** and one by **WhatsApp**, word-for-word the same reply
- safeguarding lead named in the policy, number in the team group
- support WhatsApp number on `config.js` (already set) and the session on the right academic year
- opened on a **real Android phone on real mobile data**

**Verify** — `node scripts/test-all.mjs --live`. **Expect zero failed suites**, including
`live-migrations` and `live-hardening` — and `node dev/ci-status.mjs` exit 0 for the commit you
pushed, which is the only way to know GitHub Actions agreed with you about this tree.

## Step 12 — the board

**Run** — activate at least one listing (`status = active`, `tier >= 1`, `env = production`) and an
opening ask per [SETUP.md](SETUP.md).

**Verify** — `node scripts/verify-cards.mjs`. **Expect `ALL CARD CHECKS PASSED`** rather than
`(generic fallback only)`, plus the real card's property name appearing in the preview.

**Expect** — `/browse` showing rooms instead of "No verified listings yet". Launching a room-matching
site with no rooms is a decision, not a bug; make it deliberately.

---

## The one-line definition of done

```
npm run migrations:live && npm run care:live && node scripts/test-all.mjs --live
```

Exit 0 from all three, plus one real registration that comes back with a reference and one real
code that arrives — that is "launched", and each part of it is a check somebody can re-run rather
than a memory.
