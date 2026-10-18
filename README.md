# Arzuz — the site

A static, multi-page site with no build step, no framework and no dependencies in the browser.
Every page is plain HTML sharing six scripts in `assets/`, plus two Netlify Functions and a
Supabase database.

**Live and real** — the homepage and three forms write to Supabase. Verified, admin-approved
listings appear on `browse.html` through the `public_listings` view — the one public read surface.
Visitors can read exactly two things: verified listings, and the listing detail page behind
each card. Everything else stays write-only: a student who registers cannot wander into
data nobody verified, and a booking request can be sent but never read back.

---

## Run it

```bash
cd arzuz-site
python3 -m http.server 8000
```

Open `http://localhost:8000`. Forms work in preview: without Supabase configured they queue
submissions in localStorage. The Netlify Functions (`/api/notify`, `/api/cloudinary-sign`,
`/api/whatsapp-send`) only run under `netlify dev` or on a deploy — test those on the live URL.

**Deploy** — drag the folder onto [netlify.com/drop](https://app.netlify.com/drop), or push and
import the repo in Netlify so every push deploys itself. Environment variables are listed in
`netlify.toml`.

**Prove the SQL runs** — `npm install` once (that is only for the tools; the site itself has no
dependencies and no build step), then:

```bash
npm run sql:proof     # node dev/sql-proof.mjs
npm run sql:guards    # node dev/sql-guard-test.mjs
npm run sql:mutate    # node dev/sql-guard-mutate.mjs — breaks a guard, requires a failure
```

Seventeen `supabase-*.sql` files, 6,588 lines, executed against **real PostgreSQL** — PGlite, which is
PostgreSQL 18.3 compiled to WebAssembly, so `create policy`, `security_invoker` views, generated
columns and RLS itself behave as they do on Supabase. No psql, no server, no Docker, no Supabase
project, and nothing of yours is touched: it builds a throwaway database in memory, applies
everything, asserts, and exits.

It asserts the things that are easy to get wrong and expensive to notice. That every file applies
**in dependency order** — the order is the point and is not alphabetical: `team-roles` will not run
without the tables it secures, and `roommate` refuses to build a policy unless
`public.arzuz_role()` is already there. That the whole set applies a **second time** without
changing a single policy, name included — that is the upgrade path for a live database. And then
the security model, under `set role` with a JWT: anon cannot read the pool, **marketing reads zero
rows** rather than an error, support and admin read rows, no client role can write or erase a line
of the consent trail, and `arzuz_role()` answers per token — including the branch that matters,
where a request with **no JWT at all** must come back `anon` and never `admin`.

It found two real bugs on its first run, both fixed:

1. **`supabase-hardening.sql` was not runnable after `supabase-schema.sql`.** Both files create
   policies under the same names, and hardening created them before the sweep that drops them — so
   the documented fresh install died on `42710 duplicate_object`. The SQL editor runs a pasted file
   in ONE transaction, so the entire hardening pass rolled back: no `tier`, no `env`, no generated
   pricing columns, and every later file's preflight then raised about a file that had "already"
   been run. The sweep now runs **first**, which is what makes the file idempotent.
2. **The same ordering deleted the admin's INSERT policies.** The sweep's name list includes
   `admin can add demand` / `listings` / `scout reports`, so running it after the creates removed
   the three policies it had just made, and the dashboard's Add modal was refused by RLS.

Both are pinned now: four checks assert the file's shape (the sweep first, inside the RLS section,
naming its own policies), and reordering it turns them red — verified by mutation, not by reading. The database-level checks cannot catch that on their own, because
`supabase-team-roles.sql` later creates its own INSERT policies under different names, so the end
state looks healthy either way.

What it is **not**: Supabase. The harness builds a stand-in for the four things Supabase supplies —
the three roles, the `auth` schema with `auth.uid()/jwt()/role()`, Supabase's default `grant all`
privileges (which is why the files spend so many lines revoking it), and a JWT as
`request.jwt.claims`. A policy passing here has been proved against real RLS and a stand-in JWT.

**Booking + roommate metric** — run `supabase-media-booking.sql` once in Supabase (it is
additive; it never touches existing rows). It creates the `booking_requests` table with the
same insert-only RLS as every other public table, plus the `roommate_match_summary` view
that powers the 14-day matching metric on the dashboard. New rooms and edits use the media
gallery manager in the admin dashboard — multiple photos plus a video tour, reorderable,
first photo is the cover, every asset carries the © Arzuz credit.

**Roommate matching** — run `supabase-roommate.sql` once (also additive, also never touching
existing rows). It adds `roommate_profiles`, `roommate_interests` and `roommate_events`, and it
is the strictest table set on the site: anon cannot read *or* write any of them. A roommate profile holds a
phone number and the answers used to judge a person, so anyone holding the published anon key
would otherwise be able to download the whole matching pool — or insert themselves into it.
The public page therefore reaches its own data only through `netlify/functions/roommate-match.js`,
which holds the service-role key, scores every pair server-side, and returns a first name, an
area, a percentage and a few reasons — never another student's answers, and never a phone
number that has not been unlocked by *both* sides accepting. A student owns their profile with
a private link (the same model as the draft invite link): the raw token is returned once and
only its SHA-256 hash is stored, so a dump of the table cannot be replayed against the API.

The dashboard's Roommate panel shows that same pool below its hand-paired list: who is still waiting
(with the deal-breakers that explain a thin pool), which pairs already matched both ways, and a
one-tap WhatsApp intro to each side. It is read-only on purpose — a mutual match is two students'
decision, and the pair is what unlocked their contact details, so the panel deliberately offers no
button that could overrule it. Both tables are scoped by `public.arzuz_role()`, so the support login
can read the pool and the marketing login cannot; the panel is only fetched for admin.

**The consent trail** is `roommate_events`, and it exists because `roommate_interests` is *current
state*: `(from_ref, to_ref)` is unique and the function upserts, so a student who says yes and then
changes their mind leaves one row saying `pass` and no trace of the yes. The trail is the second
record that keeps every decision, in order, with each name snapshotted at the time — so "when did
this pair unlock, and did both of them actually agree at that moment?" can be answered from data
years later, even after a profile is deleted. Nothing in the codebase updates or deletes a row:
there is no insert/update/delete policy for any client role, and `authenticated` holds `SELECT` and
nothing else. Append-only is enforced by the database, not by the convention of the code that
writes it, and the panel renders it under the pool with the raw event name so a line can be
grepped for verbatim.

One of its events is not a decision: `viewed`, written the first time a *matched* student is shown
their match's contact details (once per pair — a reload writes nothing, or the trail would fill with
page views). It is on the same record on purpose: "was my number ever put in front of them, and
when" is part of the answer, and it is what makes a stalled match detectable at all.

**Alerts** go out through the same Telegram bot as every other form, but two events only: a new
questionnaire, and a match completed both ways. One-sided accepts, passes and withdrawals are all
trailed and deliberately not alerted — a yes nobody has answered yet is not news. `roommate-match.js`
reaches the bot by requiring `sendAlert()` from `notify.js`, so `TELEGRAM_BOT_TOKEN` has one owner
instead of one copy per caller; both sends are awaited (Netlify can freeze an instance the moment a
handler returns, which would silently drop a pending fetch) and are capped by a 5s abort. Neither
the alert nor the trail write may fail the student's action — by then it is already committed, and
for `create` a retry would make a *second* profile — so a failure is logged loudly and swallowed.
Test-env profiles are trailed but never alerted, the same way they are excluded from the pool.

Because creating a profile is reachable from the public internet, the server-side path carries the
same kind of ceiling the browser action always had: at most 30 alerts a minute, then the alert is
dropped and **logged**. Dropping the alert is the right thing to lose — the event is in the trail
and the panel still shows it, whereas Telegram throttling or blocking the bot would cost every
future alert too.

**The daily digest** (`netlify/functions/roommate-digest.js`, scheduled in `netlify.toml` for 06:00
UTC) is the third thing that reaches Telegram, and the only *scheduled* one. Per-event alerts cannot
say the thing that matters on day three: of the pairs that unlocked their contact details, which
ones has nobody opened? So once a day the function reads the last 24 hours of the trail, the pool's
one number, and every production pair matched more than three days ago (`FOLLOW_UP_DAYS`), and names
the ones where neither side has come back — with that student's dossier a click away in the panel.
A pair only *one* side has looked at is a footnote, not a chase, and anything at all done by either
student after the unlock counts as follow-up: a student who came back and passed on somebody else
has not abandoned the exercise.

A quiet day sends **nothing** — silence is the signal that nothing needs attention, and a daily
"no news" message is how a team learns to ignore a channel. The one exception is a read that failed:
that *is* sent, because a digest that stops running does it silently, and nobody is looking at the
dashboard at 07:00. The cron lives in `netlify.toml` rather than inline in the function because
Netlify's inline `export const config` needs an ES module and every function here is CommonJS.

**The student dossier** opens from any student in that panel — a waiting card, either side of a
matched pair, or the partner link inside another dossier. It puts one student's whole record on one
screen: what they answered (both halves of the questionnaire, labelled with the shared vocabulary
from `assets/roommate-score.js`, so a question added to the form appears here for free), every
decision in *both* directions as its own line, who they are matched with, and their complete consent
trail — asked for by id, so it is the student's actual history rather than the 40-event, env-filtered
slice shown in the feed above. It answers "did you show my number to anyone?" without reading a feed
for a name. Read-only like the rest of the section: nothing on it can change a decision.

The record also has to be able to leave the browser, so the dossier has a **print / save as PDF**
button. `window.print()` on its own would print the entire dark dashboard, so the click puts a
class on `<body>` and `@media print` in `assets/admin.css` narrows the page to the modal — the whole
rest of the DOM is hidden — and re-inks it black on white with a provenance line at the top (the
student's name, the time it was printed, and the note that no login can change or delete a line on
it). The class comes off on `afterprint`, with a timeout behind it for browsers that do not fire it
consistently. Three files have to agree for this to work, so the boot harness asserts all three:
the button in `admin.html`, the class in `admin.js`, and the selectors in `admin.css`.

**The dossier also has to leave the browser as a file**, and that export is **JSON, not CSV** —
deliberately. CSV cannot hold the two halves of the questionnaire without flattening them into
columns that mean nothing, and an archive that loses which question an answer belonged to is not an
archive. The envelope carries the student, their answers, every decision in both directions, their
matches, their whole trail, who exported it and when, and the append-only note, so the file explains
itself to whoever opens it years from now. It is built from the same three reads the screen just
rendered (`state.dossier`), so another student's payload, or a student who merely appears in the feed
above, cannot reach it — and the by-id fetch's token guard is what keeps that promise when a slow
earlier click finishes late. Every name in it is the snapshot stored on the record, which is why it
survives a profile being deleted.

**Why they are still waiting** is the last block of the Roommate panel, and it exists because "who is
waiting" and "why nobody has been matched with them" are different questions with different answers:
the pool has nobody suitable, or the students have not chosen each other. Only the first is the
team's problem. It breaks the pool down by area and by budget band (count, matches, rate, and the
median wait — a median rather than a mean, so one student who answered in October and matched in
January cannot move the headline), then for every waiting student the engine would not put in front
of anyone it names the wall they hit, counted by reason: by gender, by a deal-breaker, or with too
little in common to call. "Nobody suitable" is computed with the **shared scorer**
(`assets/roommate-score.js`, the same `eligible()` call the server makes before it shows a card), so
a student named here is one the engine would not show either — it cannot drift from what the engine
does. The pairwise check is capped at 40 waiting students (`COHORT_WAIT_MAX`) and says so when it
bites: at the cap it is 1,560 `eligible` calls, measured at ~4 ms in the browser, so the cap is
headroom rather than a fix for a slow page. And because it is computed from the panel's own capped
pool read, the block says that on screen instead of reading as an audit.

**Previewing the digest** closes the loop on the 06:00 job: nobody can watch it run, and "what will
tomorrow's message say?" was not answerable from the dashboard. `netlify/functions/roommate-digest-preview.js`
composes the **same** message through the same `collect()` / `digestText()` the scheduled function
uses — not a copy that can drift — and hands it back to the person asking, with the window, the
follow-up threshold, the pair counts and the role it read them as. It can never send: the file does
not import `sendAlert` at all, which is the strongest form of that promise, because a future edit
cannot make the button page the team without also adding the import. It answers **POST only** (a
session token never travels in a URL) and checks the caller in the right order — Supabase's
`/auth/v1/user` proves the token is a live session, then `POST /rest/v1/rpc/arzuz_role` returns the
role **Postgres** computes from that JWT, so the browser can neither claim nor choose one. Only
`admin` and `support` may read it, which is the same rule `supabase-roommate.sql` already applies to
the pool; a marketing login is refused **before** a single roommate row is read, and the refusal is
shown, not a sign-out — a 401 means the session is dead and the dashboard signs out for it, whereas a
403 means the session is fine and the screen is not for you. Each caller is rate limited per instance
(12 a minute, the same best-effort ceiling `notify.js` uses), because the button costs three Supabase
reads and is easy to lean on.

**Arzuz Care credits** — run `supabase-care.sql` once (additive, and it must come after
`supabase-team-roles.sql`, because its policies are scoped by `public.arzuz_role()` and it refuses to
build an unprotected table). `care.html` is the specification and it is public: ₦20,000 for the
session, optional, never folded into rent, refundable before the session starts, up to **four
call-outs**, parts under ₦3,000 included, a verified worker within 48 hours. This puts that promise
in the database. It does not change it.

Five decisions, and they are the whole design:

1. **One credit is one call-out, and a session is four.** The unit is enforced, not written down:
the `'spent'` event may only ever carry `delta = -1`, so a later bug cannot charge one visit as two
credits.
2. **The balance is a ledger, not a counter.** `care_credit_events` is append-only and the balance is
its sum — the same shape as the consent trail, for the same reason. "How many call-outs are left, and
who took them" is a question that gets asked when somebody is unhappy, and a counter cannot answer it.
A correction (`adjusted`, always with a reason) is an **appended row**, which is why the table has no
edit path at all.
3. **The team writes and the student never does.** No client role has INSERT, UPDATE or DELETE on
either table: every change arrives through `netlify/functions/care-credit.js`, which holds the service
key and appends the ledger row. A student cannot award themselves a call-out, and a dashboard typo
cannot either — the panel has no control that sets a balance, and that is deliberate rather than a
missing feature.
4. **The price stays as published.** ₦20,000 flat, four credits, nothing derived from rent.
5. **Credits belong to one session.** An `expired` row voids whatever is left when it ends; nothing
rolls over by itself.

The ledger's balance is read through `care_plans_live` and `care_credit_balance`. The second one is
computed **from the ledger alone**, with no join to `care_plans`, because the ledger is the record of
money and work and a balance has to outlive the row it belongs to — that is the same reasoning as the
consent trail's missing foreign keys. A partial unique index (`session, phone` where `status =
'active'`) is what stops a double tap in the dashboard selling the same session twice, and a refunded
plan does not block a legitimate re-purchase.

`netlify/functions/care-credit.js` takes `grant`, `spend`, `refund`, `expire` and `adjust`, POST only,
behind the same two-step gate as the digest preview — Supabase proves the token is live, and
`POST /rest/v1/rpc/arzuz_role` returns the role **Postgres** computes from it, so the browser can
neither claim nor choose one. Admin and support may act; marketing is refused before a Care row is
read. It refuses a call-out when the balance is zero (rather than going negative), refuses a call-out
with no worker named, and refuses — through this button — a refund on a plan that has already used a
call-out. That last one is an interpretation worth naming: `care.html` says "cancel before the session
starts for a full refund", and once a worker has been sent the session is no longer unstarted, so a
plan with a visit behind it is a conversation rather than a button. Parts default to zero (a bulb, a
tap washer) but a value that *is* sent and is not a number is refused; parts over the ₦3,000 ceiling
are recorded and flagged rather than silently covered.

The dashboard's **Arzuz Care** section is how support operates it: plans with their balance, one
button to record a call-out (which asks who did the work, what the parts cost and what the job was),
a button to refund or end a session, and every refusal shown in the row's own drawer where the person
is looking. Balances on screen are always the ones the database just computed — the panel
never does credit arithmetic itself.

**Opening a plan** is the one money action on that screen, so it is a form and not a button: **Open a
Care plan** asks for the student's name, the phone a worker will ring, the session, the fee and *why
this plan exists*, and posts `grant` to the function. The server mints the link and returns it **once**
— only its hash is stored — so the panel shows it with **Copy** and **WhatsApp it**, plus the one step
that has to follow (record the first call-out from that student's row). The ledger carries the reason,
because "who opened this and why" is the question asked later.

**The student has their own page.** `/my-care?t=…` ([my-care.html](my-care.html), logic in
[assets/my-care.js](assets/my-care.js)) is one student's view of one plan: the balance the server
returned — never computed in the page — the whole ledger in the server's order, the published cover
(₦20,000, four call-outs, parts under ₦3,000) quoted from `care-credit.js` so it cannot drift from
`care.html`, a short **Ask for a worker** form that files a Support Desk ticket, and the whole
**repair-claim** record (below) — filing a fault, and following it to an answer.

It is shaped like the roommate link, and for the same reason: there is no login and no password, so
`?t=…` **is** the credential. Two things follow. First, the page can only `view`, `request`, and the
claim actions `list` / `create` / `confirm` / `dispute` / `cancel` / `agree_day` /
`propose_day` — **none of them moves a credit**:
a call-out is spent by the team deciding a fault is covered, never by anything a student can press,
and the ask form is gated by the server's `can_request` rather than by whether a button is drawn. Second, a route that does not exist answers `404` too, so the page treats *"we do not
recognise that link"* — the sentence, not the status — as the only signal to forget the token; a 404
from a half-deployed site would otherwise delete the one key the student has. A missing Care table
(PostgREST's schema-cache 404) is mapped to a **503** and rendered as *"Care is not switched on for
this site yet"*, which is what the live database currently says, honestly, until `supabase-care.sql`
is run.

**Repair claims — the workflow the cover exists for.** `supabase-claims.sql` plus
[netlify/functions/claims.js](netlify/functions/claims.js) turn "up to four call-outs" into something
that can be worked rather than promised. A claim is filed against **one pass**, by whoever holds that
pass's link, and the page's actions are `list` / `create` / `confirm` / `dispute` / `cancel` /
`agree_day` / `propose_day` — a student can say what is broken, say it is fixed, say it is not,
withdraw, and answer the day a worker offered, and none of that spends anything.

What spends is the decision, and only an admin makes it, in words: `covered` with a reason, or
`not_covered` with a reason — a refusal is recorded as a refusal and costs no call-out. Covered is
taken through `claim_reserve_callout()`, a function holding an advisory lock over the pass, so **two
approvals racing for the last call-out leave exactly one reservation** and the other claim is told the
pass has nothing left instead of being approved against an allowance that is gone. Cancelling,
refusing or resolving a reserved claim away appends a `released` row through the matching function:
a call-out comes back **on the ledger**, never by editing a number. Support then names a worker (with
a number a student can ring) and marks the job started — and a worker's report is **not** a finished
job: it moves the claim to `awaiting_customer` and posts the cost as an expense and a provider
payable, in kobo, with an `entry_ref` that cannot be posted twice. The customer's confirmation, or an
admin's named resolution, is what closes it; a resolution that ends the job without the work returns
the call-out. Every transition writes `claim_events` with the `from`, the `to`, the actor and the
reason, so "who refused this, and why" is a row rather than a conversation. Marketing reaches nothing,
and the student door cannot decide, assign, report or close.

**Nobody has to check the page to find out.** The moment coverage is decided, or a dispute is closed,
the student is told on **WhatsApp and by email** — the decision, its reason in words, the call-out it
committed, and what happens next. Naming a worker is the same kind of moment and gets the same
treatment, twice over, because it is two things to two people: the **worker** is told the job is theirs —
the reference, what is broken, where to go and how to reach the tenant — and the **customer** is told who
is coming and how to reach *them*, which is the message the approval promised ("we name the worker who is
coming and message you again when we do"). The two copies are different messages with different subjects,
so neither reads as the other misaddressed; a job that arrives as a phone call from somebody else has not
really been handed over, and a customer who was never told who is turning up at their room has been left
waiting on a promise. Every channel's outcome is written to the claim's own trail as a `notified`
row, so *"was the customer told?"* is a row and not somebody's memory of a green toast, and the
operator's own answer says which channel went. A delivery never fails the action: the channels answer a
word instead of throwing. A channel that **fails** pages the team on Telegram — a message lost in
silence is the complaint that follows. A channel that **does not exist** (a pass bought without an
email, a worker nobody gave an address for) is recorded and *not* escalated, because nobody can act on
it, and an alert that cries about a fact nobody can change is an alert people learn to ignore.

**A name is not an agreement.** Naming a worker records who *we* have asked; it is not them agreeing to
come. That gap used to be a phone call to the office — while the claim sat in `assigned` with somebody on
it who was never going to turn up and the customer waited for a knock that was not coming. So the handover
message, which already ended by telling them to reply if anything was wrong, is now answered:
`netlify/functions/wa-inbound.js` is OpenWA's `message.received` webhook, and it verifies the **HMAC-SHA256
signature over the exact bytes** OpenWA sent before it reads a word — without `OPENWA_WEBHOOK_SECRET` set
it refuses every request rather than trusting one. It drops our own echoes (`fromMe`), group messages,
status posts and redeliveries, then hands the text to `workerReply()`. A **yes** is recorded on the claim
and the job stays with them, and nobody else is told anything because nothing changed for them. A **no**
moves the claim back to `approved` — the status that already means *covered, and somebody must be found*,
so the queue's count, its 24-hour clock and its buttons are all already right — while the name, the number
and the worker's own words stay on the row, the customer who had been told a name is told that name is gone
(never the worker's reasons, and never a word to a customer who was never told a name at all), and the team
is paged. An answer that is neither a yes nor a no is **asked about again** rather than guessed at —
`classifyReply()` matches on word boundaries so "i can" is not found inside "i cannot" — and a message from
a number we never asked anything is left alone, because the office reads that number too. Both answers are
visible in the queue: on the row, in the work panel, and in the claim's own trail.

**A worker who answers with a DAY has told us something worth keeping.** "I can do Saturday morning" used
to read as an unreadable reply, so the question was put again while the customer was told a worker is coming
with no idea when — and the worker had in fact answered. A reply that names a day is now its own event: the
worker's **own words** are kept on the claim (`provider_proposal` / `provider_proposed_at`), one row goes on
the trail, and the **customer is told when** — quoted, never computed, because turning "tomorrow morning"
into an instant means guessing a timezone and which morning and then printing a guess as a booked
appointment. It is deliberately **not** an acceptance: `provider_answer` stays empty, the panel reads
*"suggested a time"* beside a name that has not agreed anything, and a day that arrives from somebody who had
already turned the job down is recorded and handed to the team to act on rather than quietly putting the job
back on them. Renaming a worker clears both fields with the previous answer, for the same reason the answer
is cleared: a day belongs to the person who offered it.

**And the customer can act on it without opening WhatsApp.** The pass link carries the handover, not just
the history: the worker's name, the number to ring as a tappable link, whether that worker has answered that
the job is theirs, and **the day they suggested** when there is one — their words, with "they have not agreed
a booking with us" said plainly underneath. A worker who has **turned the job down** is not on the page at
all — the function sends no name rather than letting the page hide one — because a customer reading a name on
the record is a customer waiting for somebody who is not coming. The day travels with the name for the same
reason: a day from somebody who is not coming is a date to wait in for.

**And the customer can answer the day, in one tap, from the same link.** A day a worker offers is a
*question* — "can I come Saturday?" — and the one person who can answer it is the tenant who has to be in.
Until this, the answer travelled as a phone call to the office, or it did not travel and the worker turned up
to a gate nobody opened. Two answers, and the record keeps which one it was. **Yes** writes `day_agreed_at`
and nothing else — there are no new words to keep, because the day being agreed to is `provider_proposal`, in
the worker's sentence — and the **worker is told the visit is on**, with their own day quoted back, because a
confirmed visit that only one of the two people knows about is not confirmed. Agreeing twice is one message,
not two: the second tap says so and sends nothing. **Not that day** keeps the customer's **own words**
(`customer_proposal` / `customer_proposed_at`), leaves the day they were answering on the row — it is what the
answer is an answer *to* — and sends the worker both halves with the tenant's number, because they cannot
re-arrange a visit with somebody they cannot reach. The job stays theirs: **a different day is not a refusal**,
nothing is re-assigned, no day is booked by this site, and the claim does not move for either answer — it is on
the same clock it was, and the schema refuses an agreement with no day to agree to at all. Both answers are
the team's too: the queue row says *customer agreed the day* or *customer asked for another day*,
the work panel prints the offered day and the customer's day side by side and **never compares them** —
deciding that "Sunday afternoon" is the same day as "Saturday morning" is a judgement about somebody's
calendar, and the panel's job is to show a person both sentences — and the notice to the worker is a
`notified` row like every other notice, so a worker nobody could reach pages the team rather than leaving two
people waiting on each other. Each answer is one row on the claim's own trail (`day_agreed`, `day_proposed`,
both `actor_role: 'student'`), which is how "did they actually agree a time?" is answered months later.
**A moved day also pages the team** — one line on Telegram, where a *yes* does not. That is the deliberate
asymmetry: "that day works" leaves nothing in the air, while a moved day is a plan the office still believes
something else about, and the two people now settling it between themselves are exactly the two who cannot be
counted on to ring us when they do not.

**And the office can see how many visits are actually pinned down.** *Agreed* and *still being haggled over*
are two different facts about a visit, and neither the queue nor a claim's own deadline makes the shape of
the whole set visible: four visits agreed and one in the air is a calm week, one agreed and four in the air is
not. So the queue's header carries `N agreed · M still being haggled over` — counted by the function over
**every** open claim rather than over the page it just sent, because a number that answers "how many visits
are pinned down" must not change when somebody loads two more rows — and the same counts go out once a day in
`netlify/functions/claims-digest.js` (07:00 UTC, `netlify.toml`), which quotes each day in the words the
worker or the customer actually used and says nothing at all on a day when everything is settled. Both read
the same definition (`dayStateOf` in `claims.js`), so the number on the screen and the number in the message
cannot drift: a claim whose work has already been reported is **not** a visit to come, and a worker who has
named no day yet is not "unsettled" — they ring to arrange a time, and they are reported as their own count.

**And the queue has a clock.** A claim that has stood in one status past the deadline for that status is
surfaced first — worst first, and the two kinds of late kept apart, because *the team is late* and *the
customer has not replied* are different sentences. The deadline is printed on the row and the card with
whose move it is, the queue has a filter for it, and the age is read from the claim's **own trail**
rather than from `updated_at`, so re-assigning or adding a note cannot buy a claim time. A scheduled
`claims-aging.js` (hourly, in `netlify.toml`) is the backstop for the days nobody opens the dashboard:
it messages the team about each crossing **once**, and a nudge is a row on the claim — so a claim that is
nudged, moved on, and goes late again in its new status is a new lateness and is nudged again. A row that is
*about* a status rather than a move into it — a note, a notice, a nudge, the clock's own ask, a day a worker
offered — does **not** restart the clock, so a claim cannot buy itself another deadline by being talked
about. The order is a promise, not a hint: a claim with no clock at all — a draft, anything finished — never
outranks one that is still moving.

**And the one hole left in the handover was a worker who never answered at all.** A job nobody had replied
to sat in `assigned` with somebody on it who was never going to turn up, and the customer waited on a knock
that was not coming. The same clock now does what a person would, in the same order: when a handover crosses
the claim's own `assigned` deadline with **not a word** back — no yes, no no, and no day offered — it asks the
worker **once**, in words that say what happens next, and writes a `chased` row that is what keeps it to
once. If that ask is still unanswered 24 hours later (`HANDOVER.reclaim_after_hours`), the job is given to
somebody else through **the same door a refusal goes through** — one `unhandJob()` — so the claim is back to
`approved` with the name and the number kept, the customer who was told a name is told there is no longer one
(in its own words: *we could not get a confirmation out of…*, never *not able to take the job*, because those
are two different people to ring), the team is paged, and the worker is told the job has gone so nobody turns
up to a flat with somebody else already in it. The answer recorded is `unanswered`, a separate word from
`declined`, and the schema refuses a claim that is `assigned` while carrying either. A run re-reads the row
before it takes anything back: a worker who says yes while the clock is deciding keeps the job.

**Finance — the books, and whether they reconcile.** The dashboard's **Finance** section reads
`POST /api/finance {action:'report'}` and nothing else: one call, and every figure on the screen comes
out of that answer — the page holds no second opinion about a balance, and no ledger row on this
screen can be edited. Business lines are shown from cash actually taken and returned through to what
the same rows say about the obligation, the revenue, the cost and the provider payable, and then they
are **reconciled**: every posting is a pair, so per line `cash in − cash out` must equal
`revenue + unearned + payable − refunds − costs`. The panel prints both sides and the residual and
**flags** a line that does not balance, because a one-sided entry is the mistake this screen exists to
catch. A refund asks the provider first and then posts the reversal pair, so the books move with the
money; a referral reward can only reach *paid* with the provider's own payout reference. Support reads
all of it; only the admin login moves money, and the function refuses that from any other role rather
than relying on the hidden button.

**And Care is not switched on — which is measured, not assumed.** `npm run care:live` asks the three
layers a student link needs and names the one that is missing: the **migration** (do the four Care
relations exist on the live database, with anon denied on all four?), the **door** (does
`/api/care-credit` answer a link at all, rather than the 404 page?), and the **page** (is
`/my-care.html` served?). As of 10 Oct 2026 it exits non-zero on all three — every Care relation
answers `404 PGRST205`, `/api/care-credit` returns the 404 page because the function has never been
deployed, and `my-care.html` is not served — while the deployed functions (`notify`, `listing-og`,
`strategy-docs`, `team`), `care.html` and the eight hardened relations are exactly as described here.
It is the one check no local suite can make: 717 of them pass while every Care layer above is absent.
`--base=http://localhost:8888` points it at a `netlify dev` first, and `--capture` re-records the
PostgREST fixture once it is green. Its offline half, `npm run test:care-live`, is in the gate.

`node scripts/test-roommate-score.mjs` runs the engine, API, trail, alert and digest tests (72);
`node scripts/test-care.mjs` runs the Care credit rules and the student door against a PostgREST
stand-in that enforces the same CHECK constraints (61); `node scripts/test-claims.mjs` runs the
whole repair-claim workflow against a stand-in that enforces the same vocabulary, the
completed-needs-confirmation rule and the same `reserve`/`release` serialisation the schema's
functions have — including two approvals racing for the last call-out (47);
`node dev/my-care-test.js` drives
`my-care.html` itself in a VM sandbox — every state, the money rules, the repair claims and the
things that must never happen (63); `node dev/roommate-test.js` does the same for the roommate page's failure vocabulary —
every class on the wire, and the two `404`s (a refused link against a route this deploy does not have)
and two `503`s (no matching service against a bad minute) read apart, so the branch that offers to
withdraw a student's profile is offered only when the server says the link is refused (36); `node dev/admin-boot-test.js` covers the dashboard — dossier, print sheet, export, stall
block, digest preview, the Care panel and the grant form, and the Finance books (report,
reconciliation, refunds, referral payouts, and what each role may reach) — across all three roles
(230);
`node dev/postgrest-test.js` replays a **recording of the live platform's own bytes** through the real
`admin.js` and proves a 401 and a 403 both sign the session out while a missing table does not (27) —
and reads *which world* the recording was taken in rather than assuming it, so applying
`supabase-care.sql` cannot turn the gate red for being right; `npm run test:care-live` runs the live
verdicts offline, including the pass path the live site cannot reach yet (20);
`node scripts/test-draft-errors.mjs` decides what the landlord's invite page says when a call fails —
the live platform's own `404 PGRST202`, `400 22P02`, a refusal, an offline request and a 500 each get
their own sentence, and only one of them blames the link (15); `node scripts/test-api-errors.mjs`
holds the vocabulary every other page shares (`assets/api-errors.js`) — the classes, the queue rule
that stops a refused submission from being promised an automatic retry, a whole-site scan showing no
module or inline script composes a status code into a message any more, and **both ends of the wire
driven for real**: every function that answers JSON is invoked and read back through the page's own
reader (`status`, class and sentence have to agree), a page is handed the very body that function
sent, and the two numbers that carry two meanings — a `404` that is a refused link and a `404` that is
a route this deploy does not have; a `503` with no service key and a `503` that is a bad minute — are
pinned to the class the function named rather than to the digit, and one scan holding every `wa.me` link on
  the site to the number the module publishes (88); `npm run sql:proof`
executes every `supabase-*.sql` against real PostgreSQL (131); `npm run sql:guards`
drives the preflight guards from the other side — deleting one prerequisite at a time and demanding
the raise that names the file to run (26). `npm run sql:mutate` keeps that suite honest: it breaks
one guard at a time — deleted, inverted, renamed, added, moved to the end — and requires `sql:guards`
to notice every one, on a throwaway copy whose SQL it hashes to prove your working tree was never
touched (10 checks). A test of a test is worth only what its failures prove, so it also carries a
control that must NOT be caught: if the runner were broken for some unrelated reason, every mutation
would "fail" and every one would look caught.

---

## Structure

```
arzuz-site/
├── index.html              Landing — hero, demand curve, problem, how it works, SEO FAQ
├── 404.html                Premium animated not-found page (served automatically
│                           by Netlify at any missing URL — root-absolute paths)
├── browse.html             Public verified listings (reads the public_listings view)
├── listing.html            Premium listing detail page: gallery, amenities, booking
├── register.html           Student: demand register          → demand_records
├── my-care.html            Student: one session's Care balance + ledger, reached only by
│                           the private link /my-care?t=… (logic in assets/my-care.js)
├── status.html             Anyone with a reference: where their request or listing has got
│                           to, at /status. Needs the reference AND a contact we hold — the
│                           phone number, or the email address when a number has changed —
│                           then a six-digit code sent to that contact: the reference on
│                           its own opens nothing (logic in assets/status.js)
├── owner-list.html         Landlord: list a property         → listings
├── scout.html              Resident: register my building    → scout_submissions
├── roommates.html          Student: two-sided roommate questionnaire + matches
│                           (no anon table access — writes through the match function)
├── safety.html             Your safety on Arzuz
├── privacy.html            Privacy policy
├── terms.html              Terms of use
├── admin.html              Private dashboard (Supabase Auth sign-in; sidebar shell —
│                           styles in assets/admin.css, logic in assets/admin.js)
├── complete-listing.html   No-login draft completion page behind the invite link
│                           (arzuz.com/complete-listing?ref=…) — logic in
│                           assets/complete-listing.js
│
├── strategy/               Positioning, market sizing, channels, unit economics —
│                           one framework per file, each linked to where it lands.
│                           PRIVATE: /strategy/* 404s on the public site; the docs are
│                           served only to a signed-in dashboard session by /strategy-docs
│                           (netlify/functions/strategy-docs.js)
├── supabase-schema.sql     Fresh install: tables, RLS, grants, views
├── supabase-drafts-support.sql  Additive upgrade: draft invite columns + RPCs,
│                           support_tickets, RLS and indexes
├── supabase-draft-sharing.sql  Additive upgrade: draft_permission + draft_expires_at,
│                           and the RPCs rewritten so a view-only or expired link is
│                           refused server-side
├── supabase-media-booking.sql  Upgrade: booking_requests + the 14-day roommate metric view
├── supabase-roommate.sql   Additive upgrade: roommate_profiles + roommate_interests +
│                           roommate_events (append-only consent trail), hashed private
│                           tokens, and the mutual-match views
├── supabase-hardening.sql  Upgrades an existing database — run this one if you already have data
├── supabase-location.sql   Additive upgrade: pin-quality + passage-flag generated columns + indexes
├── supabase-listings-updated-at.sql The day a listing was last EDITED (column + a stamp
│                           trigger), which sitemap-listings.xml reports as lastmod. Run
│                           BEFORE supabase-public-view.sql, which is what exposes it
├── supabase-public-view.sql One-paste addition of public_listings for a live, already-hardened DB
├── supabase-team-roles.sql Enforces the admin/support/marketing roles IN THE DATABASE:
│                           role-aware RLS + the PII-free growth views marketing reads
├── supabase-care.sql       Additive upgrade: care_plans + care_credit_events — the ₦20,000
│                           session as four call-out credits, on an append-only ledger that no
│                           client role may write. Run AFTER supabase-team-roles.sql
├── supabase-finance.sql    The books: payments, an append-only ledger (integer kobo), versioned
│                           published terms, referrals, and the coverage columns a paid pass
│                           carries. Run AFTER supabase-care.sql
├── supabase-claims.sql     Repair claims: the status vocabulary, the audit trail every
│                           transition writes, and claim_reserve_callout()/claim_release_callout()
│                           — the two functions that spend and return a call-out atomically, so
│                           two approvals at once cannot spend the last one twice. AFTER finance
├── supabase-verification-queue.sql Stage 2 of the verification layer: the SHIFT. The claim
│                           columns (assigned_to, taken_at), the append-only trail of takes,
│                           releases and nudges, and the three column-scoped functions —
│                           verification_queue() to read the shift, listing_take() and
│                           listing_release() to hold a listing and give it back — so an officer
│                           holding a listing still cannot change what it costs. The deadlines
│                           and the ordering are assets/verification-queue.js, which the
│                           dashboard and the hourly chaser both load. AFTER
│                           supabase-verification-rpc.sql
├── supabase-verification-evidence.sql Stage 3 of the verification layer: what the visit SAW.
│                           One append-only row per check, grouped by visit — a closed
│                           vocabulary of six (water, power, photos, price, access, security),
│                           an optional sentence of the officer's own, and an expiry 180 days
│                           out. public.listing_attest() records the checks AND makes the
│                           decision through listing_verify() in one transaction, so a tier-2
│                           "Inspected" listing cannot exist without the evidence that earned
│                           the word; a refused visit writes nothing. public_listing_checks is
│                           the one public read surface — the checks behind a badge, for
│                           listings already on the board, never the officer's account. The
│                           badge's wording lives in assets/verification-badge.js, loaded by
│                           the browse board, the room page and the dashboard. AFTER
│                           supabase-verification-queue.sql
├── supabase-status-codes.sql The public status page: the code a student proves a contact on
│                           their file with — phone or email, the channel is the
│                           function's business and never the table's — stored as a hash,
│                           never in the clear; a lookup throttle in
│                           its OWN table so it can never spend the waitlist's budget, and the
│                           reveal — a fixed column list, built server-side. AFTER
│                           supabase-waitlist-launch.sql, whose reference registry it reads
├── supabase-status-history.sql The DESK's half of the same page: an append-only trail of every
│                           attempt to deliver a code — the channel, whether the sender took it,
│                           and a note from a CLOSED list of seven words, so a note cannot carry
│                           a name, an address or a number — plus the attempt ceiling moved onto
│                           the code itself and the reader the Support Desk asks through
│                           (public.status_history, admin and support only, checked inside the
│                           function). That reader takes a QUERY rather than a reference: the
│                           whole reference, the last few characters of one, the beginning of
│                           one, or the phone number on the record (matched by
│                           status_phone_tail, the same last-ten-digits rule the site proves a
│                           number with). A fragment that fits more than one reference comes
│                           back as CANDIDATES — capped, and with no history attached — rather
│                           than as a guess. It RE-STATES status_verify, so it goes AFTER
│                           supabase-status-codes.sql, and that file must not be re-run
│                           afterwards without this one following it
├── package.json            Dev tooling only — the site ships as plain files with no build step.
│                           `npm test` runs every suite and reports each one, even after one
│                           fails; `sql:proof` is the Postgres one, `sql:guards` proves the
│                           preflight guards fire, and `sql:mutate` proves that suite can fail
│
├── assets/
│   ├── arzuz.css           Design system — all colours, type, components
│   ├── admin.css           Admin dashboard only — dark shell, tables, modals
│   ├── config.js           Public config only (Supabase anon key, session, support number)
│   ├── auth.js             Supabase Auth session for admin.html (+ role() from app_metadata)
│   ├── attribution.js      ?ref= channel capture → payload.ref (30-day TTL; never a draft token)
│   ├── share.js            Share prompt for the confirmation screens; share.css styles it
│   ├── complete-listing.js Logic for the no-login draft completion page
│   ├── strategy.js         In-dashboard strategy reader + the Growth (marketing) view
│   ├── data.js             Demand bands + ArzuzData + PROPERTY_TYPES (the one type list)
│   ├── admin.js            Dashboard logic: router, tables, the three-tab apartment
│   │                       composer (staged media queue, unified pin/path map,
│   │                       amenity combobox, draft-link permissions), amenities
│   ├── arzuz-map.js        Precision mapping engine shared by every map surface:
│   │                       live-GPS pin capture (accuracy ring, best-fix memory),
│   │                       route tracing + walk recording, passage capture,
│   │                       OSRM road routing, listing route map + live tracking
│   ├── app.js              Page chrome, form engine (pin + passage steps delegate to ArzuzMap), photo upload
│   │                       (listing.html reuses the form engine for booking requests)
│   ├── submit.js           Supabase insert, offline queue, retry, post-save notifications
│   ├── roommate.js         Roommate page logic: the two-sided questionnaire, the
│   │                       private-link recovery, accept/pass, the double opt-in
│   ├── roommate-score.js   The roommate vocabulary and the weighted compatibility
│   │                       engine — shared by the match function and the page
│   ├── my-care.js          The student's Care page: reads one plan through the link
│   │                       token, renders the balance and ledger the server sent,
│   │                       and files a worker request — it can never move a credit
│   ├── status.js           The status page: two steps, no session, and nothing kept
│   │                       in the browser. It moves to the code step for EVERY answer
│   │                       that is not a rate limit, because branching on the reply
│   │                       would hand back the oracle the server refuses to give
│   ├── notify.js           Thin client → /api/notify (Telegram lives server-side)
│   └── whatsapp.js         Post-submission WhatsApp confirmation → /api/whatsapp-send
│
└── netlify/functions/
    ├── notify.js           Owns TELEGRAM_BOT_TOKEN, formats alerts, status/detect/test —
    │                       and exports sendAlert() for other functions to share
    ├── team.js       Team & roles: verifies the caller is main admin, then uses
    │                       SUPABASE_SERVICE_ROLE_KEY (server-side only) against GoTrue
    ├── whatsapp-send.js    Owns OPENWA_* credentials, rate-limited proxy
    ├── cloudinary-sign.js  Signs uploads, enforces the 10 MB limit, stamps © Arzuz metadata
    ├── youtube-upload-start.js  Opens resumable upload sessions so video tours upload as
    │                       UNLISTED YouTube videos, streamed browser→Google, never via Netlify
    ├── video-embed.js      /api/video-embed/<id> 302s to the branding-stripped nocookie
    │                       embed — raw YouTube URLs stay out of the page source
    ├── listing-og.js       Serves /listing with the real listing's preview tags —
    │                       scrapers never run JS, so the per-listing card is built
    │                       server-side (see strategy/05 for the messaging it carries)
    ├── roommate-match.js   The ONLY reader of the roommate pool: scores each pair
    │                       server-side so raw answers stay off the wire, unlocks
    │                       contact only when both students accept, appends every
    │                       action to the consent trail, and alerts the team on a new
    │                       questionnaire or a completed match. Also owns the Supabase
    │                       REST plumbing the digest reuses
    ├── roommate-digest.js  Scheduled (netlify.toml, 06:00 UTC): one message a day —
    │                       the last 24 hours of the trail, plus every match older
    │                       than three days that NEITHER student has opened. Sends
    │                       nothing on a quiet day
    ├── roommate-digest-preview.js  Composes that SAME message on demand for admin
    │                       and support — the role read from Postgres, not the
    │                       browser — and sends nothing. What tomorrow's 06:00 will say
    ├── care-credit.js      The ONLY writer of the Care ledger: grant/spend/refund/expire/
    │                       adjust, role-gated, and it refuses a call-out past zero
    ├── claims.js           The ONLY writer of repair_claims, their trail and the call-out
    │                       reservations; decides coverage, posts the repair cost, and
    │                       tells the student and the worker what was decided, on
    │                       WhatsApp and by email, recording every channel's outcome
    ├── claims-aging.js     Scheduled (netlify.toml, hourly): the clock that pages the team
    │                       about a claim that has stood in one status past its deadline —
    │                       ONCE per crossing, which its own trail row is what keeps — and
    │                       the handover's second half: ask a worker who never answered
    │                       ONCE, then take the job back the way a decline does
    ├── verification-aging.js Scheduled (netlify.toml, hourly): the clock on the verification
    │                       shift. A live tier-0 listing nobody has taken, or one an officer
    │                       took and went quiet on, pages the team ONCE per lateness — the
    │                       row in verification_events is what keeps it from repeating — and
    │                       a job that was nudged and stayed silent for the policy's window
    │                       goes back to the queue by itself, through the same release an
    │                       officer's own handover uses. Shouts if it cannot read the queue
    │                       or cannot write the trail, because a chaser that dies quietly is
    │                       worse than none. The numbers are assets/verification-queue.js
    ├── claims-digest.js    Scheduled (netlify.toml, 07:00 UTC): one message a day about
    │                       the visits that have not happened yet — how many days are
    │                       AGREED and how many are still being haggled over between
    │                       the worker and the customer, each quoted in the words the
    │                       person used. Sends nothing when everything is settled and
    │                       nothing moved, and pages the team if its own read fails
    ├── wa-inbound.js       The inbound WhatsApp webhook. Verifies OpenWA's HMAC signature
    │                       over the exact bytes it sent, drops our own echoes, groups and
    │                       redeliveries, and hands the words to claims.js's workerReply()
    │                       — the worker's yes, no or suggested day for a handover,
    │                       recorded on the claim
    ├── strategy-docs.js    Serves the strategy pack ONLY to a valid Supabase session —
    │                       filename-whitelisted, no-store, /strategy/* itself 404s
    └── status.js           The public status page's door. Resolves the reference through
                            the registry, requires a contact on the file — the phone
                            number, or the email address for a student who changed
                            numbers — sends a six-digit code over the SAME OpenWA sender
                            the claims notices use (and the SAME Resend one for an email,
                            including as a fallback when WhatsApp cannot deliver), and
                            reveals the stage only when the code comes back. Every answer
                            that is not the caller's own rate limit is the same body,
                            whichever channel asked — which is what makes the lookup
                            useless for finding out whether a reference is real
```

---

## The apartment composer

**Listings → + Add apartment** (and **Edit** on any listing) open the same three-tab instrument
instead of one long scroll:

1. **Property & Pricing** — ID, optional name (a readable title is built from the type + area when
   it is left blank), type, area, rent, opening ask, availability (vacant *n* units / fully
   occupied), contact person + phone + role (Landlord · Caretaker · Agent · Admin), tier, status,
   description, and an amenity **tag input**: type to search the shared list, press Enter to add a
   new one to this listing.
2. **Location & Access** — one map with a **[Pin location | Draw path]** toggle. Satellite or
   street tiles, live GPS with an accuracy readout, and a traced walk-in route that is stored with
   the pin. Directions are a single **Access & Navigation Notes** box instead of four separate
   fields.
3. **Media & Draft** — pick or drag photos/videos and they appear **immediately** in a staging
   grid with an ✕ on each tile and a ★ cover badge. Photos are downscaled and re-encoded in the
   browser before upload; each tile shows a real upload percentage (XHR progress) and failures stay
   on screen to be removed or retried. Videos stream to unlisted YouTube, or accept a pasted link.

**Will students actually see it?** The composer answers that before you save. `browse.html` reads
`public_listings`, which is `status = 'active' AND tier >= 1 AND env = 'production'` — three ANDed
conditions the dashboard used to keep to itself. Both modals now carry a live line under
**Verification Tier**: green when the save would publish, amber with the reason when it would not
(*"Not on the browse page yet — it is tier 0 — not verified yet"*). Every row shows the same verdict
in the **Browse board** column next to its status, and a hidden row whose status is not `draft` gets a
one-click **Publish** that writes exactly those three fields. A public submission can only ever be
inserted as `status='pending', tier=0` (the anon INSERT policy), so approving one means changing the
status *and* the tier — the note says so while you are looking at both.

Beside it is a **Crawl** column: the freshness/completeness score the listings sitemap publishes as a
room's `changefreq` and `priority`, printed per row as a band and a fact count (`weekly · 4/6`, the six
facts a student decides with), with the missing ones named one chip each in the room's details. It is
the answer to *"why is this page re-checked rarely?"* — and it is the same score the engines are given,
because both read `assets/listing-score.js` rather than each doing their own arithmetic. Only the base
`listings` table can be scored; a role reading the PII-scrubbed `growth_listing_feed` sees no badge
rather than a wrong one.

Text fields carry the same `maxlength` ceilings the landlord form and the SQL clamp use (name 70,
area 80, contact 60, phone 24, description 2,000, notes 600, video link 300; money `max="99999999"`,
units 0–999), and **0 vacant units is an answer**: it is stored as `avail:'occupied'` with
`Fully occupied` rooms, never as "Units available". An upload that fails says why — the signer's own
sentence — the signer now names the fix ("Photo storage is not configured on this deploy: CLOUDINARY_API_KEY,
CLOUDINARY_API_SECRET and CLOUDINARY_CLOUD_NAME are not set in Netlify"), not "HTTP 500".

Closing a part-filled form offers **Save to draft · Discard · Keep editing** — never a silent loss.

## Draft apartments with invite links

Sometimes you find an apartment before you know everything about it. The composer
(**Listings → + Add apartment**, or **Cancel → Save to draft**) creates the listing as
`status='draft'` with a secret `draft_token`, then opens the **Draft link & permissions**
panel with a link:

```
arzuz.com/complete-listing?ref=<draft_token>
```

Send it to the landlord or agent on WhatsApp (the modal has a button for that). They open it,
fill in whatever is missing — details, amenities, photos, the gate pin, the walk-in path — and tap
**Send to Arzuz**. No account, no login; the token is the key. You get a Telegram alert, and the
draft row shows *“completed — awaiting approval”*. Review it, set the tier, approve it (status
leaves `draft`), and the link dies automatically. Until then the landlord can re-open the link
and adjust.

The landlord's page is the same composer as the dashboard's: **three tabs** (Property & Pricing,
Location & Access, Media & Draft), the same optional/auto apartment name, rent + opening ask, the
availability toggle with a unit count, contact person + role, a searchable amenity tag input, one
map with a `Pin location ↔ Draw path` switch, one *Access & Navigation Notes* box, and a staged
media grid that compresses photos in the browser, shows a real percentage per file and lets them
set the cover or remove a tile before anything is sent. `Save draft` keeps their progress without
telling the team it is finished (the write RPC reads `save_mode:'progress'` and leaves
`draft_completed_at` alone); `Discard changes` offers *save draft / discard / continue editing*.
Opening Ask only reaches the column while it is empty, so a landlord can never overwrite the number
the team recorded.

Every link carries two controls, both enforced server-side:

| Control | What it does |
|---|---|
| **Public view only** | The holder reads the details; the RPC refuses every write. For a landlord who just needs to confirm what you wrote before you show it to students. |
| **External edit allowed** | The holder fills in missing details and adds photos from their phone. You still approve everything. |
| **Link expires** | 24 hours / 7 days / 30 days / never. An expired token reads and writes nothing. |

How it is safe: anon never touches the `listings` table. Two security-definer RPCs
(`listing_draft_get` / `listing_draft_update`, created by `supabase-drafts-support.sql` and
replaced by `supabase-draft-sharing.sql`) read and write exactly one row for the token holder, and
the update copies an explicit whitelist of fields only — status, tier, the opening ask, the
permission and the expiry can never be changed through a link. The whitelisted patch is then run
through `listing_payload_clamp()`, which applies the forms' own field ceilings server-side, so a
caller posting straight at the endpoint cannot store an 8,000-character lodge name for the
dashboard table and the OG card to render. Regenerate, re-permission or revoke
it any time from the Listings table or the Edit modal's **Media & Draft** tab.

Until `supabase-draft-sharing.sql` has been run the composer still works: the insert is retried
without the two new columns and a toast reminds you to run the file. The permission and expiry
controls only start being enforced once it has run.

## Testing without touching real data

The dashboard has a built-in mock harness, guarded to localhost. Append **`?mock=1`** to the admin
URL and the page boots with a fake signed-in session and a fully stubbed Supabase/fetch layer —
nothing leaves your machine, and the sidebar badge reads **MOCK DB** so it can't be mistaken for
live. The harness seeds realistic rows into every table (drafts, minors, test rows included) and
exposes a scenario switcher on the console:

```js
__MOCK__.role('marketing')   // boot as marketing / support / admin
__MOCK__.empty()             // every table empty (honest empty states)
__MOCK__.slow(1200)          // add 1.2s latency
__MOCK__.error('rest')       // inject REST failures
__MOCK__.reset()             // restore the seed
__MOCK__.stats()
```

A headless regression suite runs the same harness through a VM-sandboxed DOM and walks all three
roles — boot, role gating, every route, overview-metric traceability, table row counts, all
modals (details/edit/delete), the delete type-to-confirm, add-apartment, the composer's
cancel/keep/discard exit path, CSV export, team and amenities management, and the REST-failure
scenario:

```bash
npm test   # every suite runs and is reported, even after one fails — dev/run-tests.mjs
```
or one at a time:

```bash
node scripts/test-roommate-score.mjs   # expect: 72 passed, 0 failed
node scripts/test-care.mjs             # expect: 61 passed, 0 failed
node scripts/test-claims.mjs           # expect: 116 passed, 0 failed  (the claim lifecycle + the digest)
node dev/my-care-test.js               # expect: 72 passed, 0 failed
node dev/roommate-test.js              # expect: 36 passed, 0 failed   (the failure vocabulary)
node dev/admin-boot-test.js            # expect: TOTAL 367 · PASS 367 · FAIL 0
node dev/postgrest-test.js             # expect: 27 passed, 0 failed
npm run test:care-live                 # expect: 20 passed, 0 failed   (the live verdicts, offline)
node scripts/test-draft-errors.mjs     # expect: 15 passed, 0 failed   (what a landlord is told)
node scripts/test-api-errors.mjs       # expect: 90 passed, 0 failed   (one vocabulary, no bare statuses)
node dev/care-live-check.mjs           # the live site itself: exit 0 only when Care answers
npm run sql:proof                      # expect: TOTAL 205 · PASS 205 · FAIL 0
npm run sql:guards                     # expect: TOTAL 47 · PASS 47 · FAIL 0
```

`npm test` does not short-circuit. It used to be a chain of `&&`, which stops at the first failure —
so a broken `test:care` meant the three suites after it, `sql:guards` among them, were never run and
never reported. `dev/run-tests.mjs` now runs all twenty whatever the others do, prints each one's
own verdict, and exits non-zero if any failed.

CI runs exactly that command — `.github/workflows/ci.yml`, on every push and pull request: Node from
`.nvmrc`, `npm ci`, then `npm test`. It uses no secrets, because the two SQL suites execute the real
`supabase-*.sql` against PostgreSQL compiled to WebAssembly, in memory, on the runner: there is no
Supabase project to reach and no production data within its grasp.

See [dev/admin-test-report.md](dev/admin-test-report.md) for the full coverage matrix — §12 (the exit
path) and §13 (the landlord invite form, end to end) in particular.

The landlord invite page boots against Supabase RPCs instead of the dashboard's rest calls, so it
has its own harness: `dev/complete-listing-harness.html` loads **the real** `complete-listing.html`
— same markup, same scripts — with `SUPABASE_URL` pointed at the dev server's mock RPC routes and a
stubbed uploader, so the tabs, the staged media percentages, the exit triad and a read-only link can
all be walked without a token or a live database:

```bash
node dev/upload-mock-server.mjs 8799
# in-page toggle: Demo · Worst · One · Empty · Generated name · Read-only link · RTL + emoji
# ?seed=blank | existing | demo | generated | worst | one | view | exotic · ?perm=view · ?ref=<uuid>
# http://localhost:8799/dev/complete-listing-harness.html?ref=11111111-1111-4111-8111-111111111111&seed=worst
```
`?seed=worst` is the break-ui seed — a 62-character lodge name, Yoruba diacritics and an emoji, 0
vacant units, a 1,578-character blurb, 12 amenities and 40 media items. Keep it: it is the regression
test for the next change to this form (see §13 of the report, *Worst-case data*).

The seeds are **generated, not written out**. [dev/invite-fixture.js](dev/invite-fixture.js) declares
the field · state matrix the form resolves (43 cells across 20 fields — a value at its ceiling, one
that is absent, an empty string, diacritics and emoji, a formatted number, a duplicate amenity, 40
media items, half a pin …) and **builds each seed from the names of the cells it is there to read**, so
a seed cannot describe data it does not carry. Every seed records which case it exercises, `plan()`
publishes those records plus the scripted failure classes, and `violations()` reports a pair that does
not hold, a field declared twice, or a declared cell with no seed — the harness logs any of those to the
console rather than letting them look like a page bug.

The dashboard has the same switch, in its own page. `admin.html?mock=1` boots the real dashboard
against an in-memory database, and the bottom-left **Fixtures · Demo data · Worst case** switcher
reloads it with `?seed=worst`: `worst()` in [dev/admin-mock-data.js](dev/admin-mock-data.js) swaps
every listing for the break-ui set — which is **generated, not written out**, so it cannot quietly lose
a case:

* **the matrix** — every status × tier × env combination the dashboard can hold (5 × 3 × 3 = **45
  cells**, 36 of which the board hides on status alone), built from the dashboard's own enumerations:
  the five statuses its Status filter offers, the three tiers its Tier select offers, and the three
  envs `public_listings` distinguishes (`production`, `test`, NULL).
* **the payload extremes** — a 70-character emoji name, an 80-character area with no spaces, a
  payload with no name at all, 0 units, a ₦0 rent, 60 media items, RTL text, a 2,000-character
  description, 30 amenities. Each is still a board case of its own. **49 rows** in all.

Every row records which case it is there to exercise — `row.case = { label, status, tier, env,
exercise, stress? }`, where `exercise` is the first condition that hides it (`live`, `hidden:status`,
`hidden:tier`, `hidden:env`, `hidden:env-empty`) — and the page publishes those records through
`worstPlan()` so the regression test can ask the fixture what it covers. It is what found the four
table and composer breaks in §14 of the report, and the mobile card break in §18 — a hand-walk finds
these once, so the same fixture is now asserted on every push:

```bash
node dev/upload-mock-server.mjs 8799
# http://localhost:8799/admin.html?mock=1              → Demo data
# http://localhost:8799/admin.html?mock=1&seed=worst   → Worst case

node scripts/test-admin-worst.mjs   # the same fixture, in headless Chrome, exit non-zero on a break
```

Two more harnesses cover the newer surfaces:

```bash
node scripts/test-attribution.mjs   # ?ref= capture, TTL and draft-token rules + the share card
node scripts/verify-cards.mjs       # LIVE: what WhatsApp / X / Telegram actually receive
```

And six that render the real pages in headless Chrome and assert on what the browser did — each
starts the server it needs itself and exits non-zero on any failure:

```bash
node scripts/test-listing-render.mjs  # listing.html against 9 generated cases (incl. worst) × 1440/390/320px
node scripts/test-invite-render.mjs   # complete-listing.html against its 7 seeds × 1440/390/320px
node scripts/test-invite-render.mjs --fail-bodies   # …and against each recorded platform failure
node scripts/test-home-motion.mjs     # index.html at 1440/390, with and without reduced motion
node scripts/test-hero-geometry.mjs   # the hero object's derived geometry, measured at 1440/390
node scripts/test-hero-visual.mjs     # the hero object's paint, against the image recorded for it
node scripts/test-admin-worst.mjs     # admin.html worst case: verdicts, reasons, overflow × 3 layouts
node scripts/test-home-motion.mjs --fault-inject   # lose one boot script per load; the page's own check must repair it
node scripts/test-admin-worst.mjs --fault-inject   # the same, on the dashboard's boot layer
```

And one that needs neither a browser nor a server, because what it guards is the data those suites
render — both fixtures' own declarations, the harnesses' instructions to them, and every number this
README and the report quote out of them:

```bash
node scripts/test-fixture-plans.mjs   # the generated fixtures, checked as fixtures
```

That last one is the point. The numbers in this prose, and in the report's, are a third copy of the
data — the cell and field counts, the worst rows' name and blurb lengths — and the suite builds every
phrase it searches for from the fixture itself, so a doc that disagrees with the data fails the push
instead of quietly outliving it.

The listing page's cases are generated the same way ([dev/listing-fixture.js](dev/listing-fixture.js)):
the same idea, 74 declared cells over 14 fields, nine named cases — the six the page has always been
walked with plus `exotic` (RTL, emoji and a youtu.be link), `shapes` (keys present but empty) and
`oddities` (values of the wrong type, a duplicate amenity, no photo at all). `test-listing-render.mjs`
no longer types its expectations out per case: it derives them from each row's own data by the rules
the page documents — restated once in [page-rules.mjs](scripts/page-rules.mjs), not inside the suite
— and pins that derivation against the hand-verified numbers for `demo`, `worst`, `empty` and `huge`,
so a case added to the fixture arrives already covered and a rule that stops matching the page cannot
pass by agreeing with itself.

`test-admin-worst.mjs` is the one that does not take a screenshot as evidence. For every row of the
`worst()` fixture it recomputes the browse-board verdict from that row's own `status` / `tier` / `env`
— the three conditions `public_listings` applies — and fails if the badge, or the reason inside its
tooltip, disagrees. It also fails if any element's text escapes its box, if anything is clipped with
nothing to scroll to, and if the page scrolls sideways at 1440, 390 or 309 px. Those three reasons
are not written down in that suite: it reads them from
[page-rules.mjs](scripts/page-rules.mjs) (`LAYOUT_RULES`) and interpolates them into the scan it runs
in the page, so the dashboard's suite is a fourth reader of one statement rather than a copy that
stops matching the day one of the other three changes.

It also checks the fixture against itself, which is what keeps the fixture honest: the page's plan must
match the statuses, tiers and envs the dashboard is offering *at that moment*, all 45 cells must be on
screen exactly once, and every row's `case` record must be true of the row it is written on — its
status, its tier, its env, and the branch its data actually earns. Add a status to the dashboard and
the fixture fails until it grows one; invent one and it fails the other way. Its own value was checked
by breaking things on purpose — the NULL-`env`-reads-as-production bug, a dropped status, a dropped
block of cells, a record claiming `live` for a row that is not, an emptied badge reason, and the mobile
card's missing word-break each turned it red on exactly the rows involved (§18).

`--fault-inject` is the same treatment pointed at the dashboard's own boot: it drops one boot-critical
script request per load at the network layer — `assets/admin.js`, `dev/admin-mock-data.js` or
`dev/admin-mock.js`, the three the page's dev mode needs — and requires
[dev/page-harness-boot.js](dev/page-harness-boot.js) to notice the missing global and reload once. A
load counts only when the page says `ok-after-retry` and every ordinary check then passes against the
recovered dashboard; a load the fault never reached fails the run, because that is a green run that
proved nothing. `--fault-drops=2` kills the reload's copy too and must be red.


`test-home-motion.mjs` is the regression test for the homepage's motion and placement: every `.rv`
reveal has to land, the hero plate has to animate, sit whole inside the hero and overlap no copy or
button, the demand bars have to fill, nothing may scroll sideways, and a hostile value written into
the page (a junk highlight width, a junk `data-depth`) must be refused at the write — never turned
into `NaN` or an invalid transform. `--page=<path>` runs it against any page, which is how a
regression here gets proved: point it at a copy carrying the old CSS and watch it fail.

The reveal half of that walk waits for PAINTED frames, not for the clock. A scroll position the
renderer never painted is a position the page was never in — an `IntersectionObserver` is evaluated
during a rendering update — so on a loaded box a reveal target whose whole visible window falls
between two frames reads exactly like a page that hides content for good. Every step now waits for a
frame (rAF, bounded, counted), the sweep re-walks once if the page grows under it, and anything still
un-revealed when the walk ends is put in the middle of the viewport and given one honest look: what
lands there is reported as rescued — a miss by the walk, said out loud in the run — and what does not
land is a page bug and stays red. `--cpu=<rate>` starves the renderer on purpose (CDP CPU
throttling), which is how that behaviour is exercised without waiting for a busy machine.

The object it guards has a page of its own: [dev/hero-object.md](dev/hero-object.md) — what each
plate is for, why the light comes from the upper left, the numbers that keep the two scales in step,
and the house rules to follow before touching it. `test-hero-geometry.mjs` is that middle section,
executable: it loads the page at 1440 and 390 and asserts the chain the note claims — the seal's own
size, and the band, the overhang and the foot derived from it, the stage padding being exactly those
four values, the plan showing the same gutter on both sides of the panel and the foot below it, and
the seal landing flush on the column's right edge while crossing the paper by exactly the overhang.
It measures layout boxes only (`offset*`), never painted ones, so the plates' turns cannot flatter a
number: the turns and the shadows are the motion suite's business. The note's measured table is what
the same run prints as observations, for a reader to compare. It also pokes the padding on purpose,
twice per width: the stage's composition is written from four values a reader is invited to tune, so
`--seal-over: 0` and a unitless `--foot` are applied to the live page and the run requires each to
cost only the edge it names. Written as one `padding` shorthand those two took all four edges down
with them — the object collapsed into its own corner — which is why the page now writes them as four
longhands and registers the four values as lengths.

`test-hero-visual.mjs` is the half geometry cannot reach: it screenshots the same object at both
widths and holds it against the image recorded for that width in
[dev/hero-baselines/](dev/hero-baselines/) — the paper's tint and grid, the shadow the one light
throws, the seal's glint, the type inside the disc, the aurora behind the paper. Nothing is mocked;
the page is told only what time it is (the seal's date is `new Date()`, so a baseline would be wrong
tomorrow) and that its animations are over, each taken to the state a visitor is left with — the
seal's own `coinIn` begins at `opacity: 0`, so pinning it at its first frame records an object with
no seal on it, which is exactly what the suite's first pass did. Each width is also shot twice from
two scroll offsets and the two images must be the same one to within the tolerance a baseline is
compared with (0 pixels move past the channel tolerance; the floor is a block mean of about 1, which
is where the limits above were chosen from), which is what says the clip is a region of the document
rather than of the frame. A run prints three numbers — the fraction of pixels that moved
past 24, the mean channel difference, and the worst 32px block — so a soft change confined to one
plate is caught by the last while a moved plate is caught by the first. A baseline is per-platform
(text rasterization is the browser's and the OS's) and a machine with none records one and says so
instead of pretending to have compared; a real change is accepted with `--update`.

`--fault-inject` loses one of the three scripts the homepage's boot needs (`assets/app.js`,
`assets/data.js`, `assets/motion.js`) per load and requires the page's own check to bring it back on
one reload — a genuine failure there is invisible to a reader, since a missing `assets/motion.js`
leaves every `.rv` section gated off for good rather than throwing. It is refused on any page other
than `index.html`: the repair is the boot block that page ends with, so pointing this mode at a copy
would aim it at a check the copy does not have, and the run would prove nothing while looking green.

`test-listing-render.mjs` loads the real `listing.html` through `dev/listing-harness.html`, which
writes that page's own markup into the document — so a subresource that never arrives leaves a page
whose inline boot never ran, and every assertion about it fails as though the page were broken. It
used to: one lost `/assets/app.js` turned into eleven failed checks about elements that were fine,
which is a test-fidelity bug wearing a page bug's clothes. The harness now preflights the scripts the
page names, confirms the shared layer is on `window` after the page boots, and replaces such a load
with **one** reload instead of judging it (`dev/listing-harness-boot.js`, status on
`<html data-harness-boot>`). If the script is still missing on the retry — or was never there at all
— the suite fails once and names the file rather than eleven times about a page it never loaded.
Both directions are checked against a dev server deliberately dropping one script request.

It also sweeps 320 px, where the gallery, the price and the map placeholder are what break first, and it
measures that width **settled**: the whole sweep runs under `prefers-reduced-motion: reduce` and a check
asserts it (reduced motion live, and `.gal` carrying no entrance transform). That is not decoration.
`.gal` rises with a `perspective()`/`rotateX` transition, and while it runs the browser projects the
whole row through it — 13,600 px of 50 slides inside a 271 px stage — so a frame's *rect* grows with its
distance along the row while every frame is the same width in layout (`offsetWidth` agrees on all 50).
Read mid-flight, the gallery looked like it drifted 12 px wider by frame 50; read settled, every frame is
the stage's width to the pixel, and that is what the pass asserts (within 1 px, at 50 items, with the
placeholder frame held to the same bound rather than a looser one).

`test-invite-render.mjs` is that treatment for the page a landlord actually fills in.
`complete-listing.html` is loaded through `dev/complete-listing-harness.html` — the harness stubs
Supabase at the mock RPC boundary and `document.write`s the real markup — once per generated seed, at
1440, 390 and 320 px. Its expectations are derived, not typed per seed: the page's own rules
(`fillForm`, the amenity de-duplication, the 12-tile cap, `availState` / `roomsText`) are restated
once in [page-rules.mjs](scripts/page-rules.mjs) and applied to the row the mock RPC was actually
holding when the page read it, fetched back over HTTP rather than taken from the fixture file. The
320px pass is its own measurement rather than a third repetition: it opens tab 3 — where the staged
grid lives, and which a width-agnostic pass structurally cannot see — and holds the availability
note, the capped grid and the action bar to the viewport a real phone reports, using the page's own
declared floors (`minmax(min(104px, 100%), 1fr)`, `min-width: 190px`) rather than numbers invented
here. A per-key comparison against the fixture's own seed reports a
mangled payload as the harness's fault instead of the page's, and before every load the mock is seeded
with a sentinel name the row must then have moved off — so a harness that silently fell back to the
demo row cannot pass this suite by asserting the demo row against itself.

It can also lose a script on purpose. `--fault-inject` drops one boot-critical request per load at
the network layer and requires the harness to repair the page, exactly as the listing suite does —
which it can, because `dev/complete-listing-harness.html` preflights every local script before it
writes the document and `dev/complete-listing-harness-boot.js` reloads **once** when the layer the
boot needs is missing. On this page that is not a test convenience: every layer except the page's own
`complete-listing.js` is behind a `typeof` guard, so a lost boot script leaves the form on its loading
card with nothing in the console — a failure that used to reach the suite as "the page never settled".
The candidates are derived (the harness's `LAYER` map intersected with the scripts the page names), so
the list cannot drift from the page. `--fault-drops=2` kills the retry's copy too and must leave the
run red — the control that proves an unrecoverable loss is still reported as one.

It also presses **Save draft** on the worst seed and reads the patch back off the mock: the
62-character name, ₦1.25m in both price boxes, 11 chips from the 12 stored amenities (the duplicate
pair is one amenity), all 40 media items with the youtu.be tour and the Drive copy, the three-line
landmark and the pin — and the 0-units row, which must be stored as `avail: occupied` /
`Fully occupied` rather than as a vacancy nobody has. `--seed=` and `--width=` narrow a run, `--urls`
prints the harness links to walk it by hand, and `--no-round-trip` renders without ever pressing save.

`--fail-bodies` is the other half of that page's testing, and the half a landlord's bad day lives in.
It walks the **eight failures recorded off the live project** — a schema cache with no such function, a
grant this page does not hold, a token that is not a uuid, a platform that is busy, unwell or gone, and
a connection that never answers — plus the empty answer, which is the one failure that really is about
the link. Each is a load of the harness with `?fail=<class>`, and each verdict is built from two things
neither of which is typed into the suite: **what the platform answered**, read back off the mock server
which is the body the page's own fetch received, and **what that means and what to say about it**, which
is `assets/draft-errors.js` classified in Node from that same body. The page then has to match it — the
dead-link card's title *and* body word for word for a failure on the way in, the form and its contents
kept with the module's inline sentence in the note for a save that did not happen, nothing written to the
backend either way, and the class the page announced on its console equal to the class the classifier
derives. So a page that skipped the classifier and wrote its own sentence fails even when the words
happen to match, and a half-deployed site can no longer answer a landlord with "this link is not valid".

[scripts/page-rules.mjs](scripts/page-rules.mjs) is where both suites' restatements live, and it
exists because of how each of them judges a page: by RESTATING that page's rules and applying them to
the row the page was given. An expectation copied from the page's current output proves nothing — but
a restatement that lives inside a suite drifts the moment the other page's suite is edited, and one
file keeps asserting last month's behaviour while the other is updated. So `INVITE` and `LISTING` are
two rule sets stated once each (they differ on purpose: the invite form does not de-duplicate media by
url, and the listing page builds a gallery), the three overflow rules are stated once and the injected
scanner is built from them, and the width table both suites sweep lives there too. It also runs on its
own — `node scripts/page-rules.mjs` prints every pin at once — and `verifyPageRules()` reads the
pages back: `GRID_CAP`, `MAX_UNITS`, the role tables, both stylesheet floors, and every sentence a
suite asserts by equality. A red line there means the page moved on and the restatement did not (or
the other way round), which is a decision to make rather than a pass to enjoy. Each suite calls the
half that describes its own page, **plus the shared layout vocabulary** — which is also what now
holds the admin dashboard's suite, the fourth reader of those three rules, to the same statement.

`verify-cards.mjs` fetches a listing through the deployed `/listing` function with each scraper's
own agent string and asserts the card that scraper needs — a 200, a real `og:title`, an `og:image`
that actually resolves, a canonical `og:url`, `twitter:card`, parseable JSON-LD. With no active
listing it verifies the generic path and says so rather than passing quietly; pass `--id <uuid>`
to check one room, or `--base http://localhost:8888` to check a local `netlify dev`.

---

## Every suite, one command — and the push gate

Nothing used to run every test file in this repo: `npm test` runs the suites package.json owns and
none of the browser ones, so "I ran the tests" could mean anything, and a suite nobody invokes is a
comment. This runner names every suite it runs and what it does not.

```bash
node scripts/test-all.mjs                 # every suite, three lanes, one summary, one exit code
node scripts/test-all.mjs --list          # what would run, and what nothing runs
node scripts/test-all.mjs --only=listing-render
node scripts/test-all.mjs --live          # adds the probes that talk to the live domain/database
node scripts/test-all.mjs --skip-npm      # the package.json suites already ran (CI uses this)
node scripts/test-all.mjs --serial        # one suite at a time, in listed order
node scripts/test-all.mjs --workers=3     # override the Node lane width
node scripts/test-all.mjs --self-test     # prove the lane plan itself drops no suite
node scripts/test-all.mjs --timing=strict # a suite slower than its own baseline fails the run (it warns by default)
node scripts/test-all.mjs --reset-baseline  # forget the learned per-suite timings and start again
node scripts/test-all.mjs --accept-slow-gate  # the machine really did change: clear the slowdown streak
node scripts/test-all.mjs --gate-ref=<id>  # which ref this run is, so a streak can say where it was seen (CI passes its own)
node scripts/test-all.mjs --baseline=f.json # which file that history lives in (CI keeps its own, in a cache)
node scripts/test-all.mjs --timing-report=t.json   # write this run out for the run after it
node scripts/test-all.mjs --timing-compare=t.json  # say what moved since that report
```

The Node suites are not listed in the runner — every `test:*` and `sql:*` script in package.json is
read and run, so a suite added there is picked up with no edit to this file (that is how `sql:guards`
and `sql:mutate` got in). The browser and deploy-guard suites are listed in the runner, because
package.json cannot own a suite that needs Chrome. And a test file that **neither** list covers is
reported on every run rather than ignored: `dev/my-care-test.js` was the live example — 41 checks
then (72 now), all passing, and nothing invoked it until it was wired in as `test:my-care`. That report is not a
failure, deliberately, because a file someone is still writing must not block anyone else's push.

An npm suite's **own arguments** are passed through, because the command can be the whole point.
`test:care-live` is `node dev/care-live-check.mjs --self-test` — the offline half of the Care probe,
which feeds its classifiers recorded answers and runs in the gate like any other suite. Running that
file without `--self-test` is the *live* probe instead, and a runner that spawned the file and
dropped the flag would turn a passing suite into a red gate that blamed production for a missing
argument. The live half is `care:live`; it asks the deployed site and database, needs the internet,
and is deliberately not a `test:*`/`sql:*` script, so the runner never picks it up — a suite that
only exists to ask production must not be able to block a push from a laptop on a train.

Each suite runs in its own process with its own exit code, and the run exits non-zero if any of them
failed. A suite that cannot run here (the SQL proof needs `npm ci` first) is reported as skipped,
never as a pass; `--strict` turns a skip into a failure, which is what the gate uses.

The suites run in **three lanes at once**, because they hold different things. The browser suites
drive headless Chrome and assert on a page's own timing, so they run one at a time — and each of them
gives Chrome **60s** to report its DevTools endpoint before calling the launch dead, because a launch
is a wait and not a verdict either: 25s was measured expiring on this machine while the browser itself
was fine and the pages had not even been asked for yet. Everything else
is a separate Node process, two at a time (`--workers=N` to change that), with the slowest (the SQL
mutation run, ~2 minutes) starting first in its lane so nothing queues behind it. And a suite that writes a fixed scratch path inside the repo
(`scripts/test-listing-og.mjs` and `scripts/test-strategy-docs.mjs` build a
`netlify/functions/__sandbox` tree and delete it — the file on disk is the fixture) gets a lane of
its own, one at a time: two of those at once is one unlinking the other's directory mid-run, which
is a harness collision, not a page bug. The runner decides that from each suite's own source, so the
next suite like it is covered without anyone remembering to list it. Every suite still runs exactly as
it did, with the same checks and the same exit-code verdict; only *when* it is allowed to start
changed. Output is printed as one block per finished suite so two logs never interleave, and the
summary reports wall-clock time beside the sum of the suites' own times — the size of the overlap,
measured rather than claimed. `--serial` puts everything back in one lane, in listed order.

The runner also tests *itself*, and that is a suite in the manifest named `runner`: it is
`node scripts/test-all.mjs --self-test`, which runs the lane plan over fake suite lists and asserts
that every input lands in exactly one lane (nothing dropped, nothing listed twice), that a suite
naming a scratch path is routed to its own lane, and that the estimates only reorder a lane. It
spawns nothing, costs a tenth of a second, and fails the moment a routing change would quietly drop
a suite — the same failure this runner exists to catch, pointed back at itself. It also pins every
rule the timing check below follows, because that is the one part of this runner that judges a number
rather than a boolean, and so the part most able to cry wolf.

**The runner watches the clock, not only the verdicts.** Every other check in this repo is a
boolean — a page either revealed or it did not — so a suite that quietly got three times slower
failed nothing; it just ate the gate until nobody was willing to run it, which is how a gate dies.
Each run records every suite's own wall time in `.test-timings.json` (local and gitignored: it
describes the machine, not the project) and compares the next run against what that suite normally
costs here — the median of its last five runs once there are three of them. Below three it judges
nothing: the built-in estimate appears as a learning line, because a guess that exists to order lanes
cannot prove a regression (the first gate run after this shipped flagged the SQL proof at 2.73× an
estimate of 12s that the suite has never once met). Slower than **1.5×** that median *and* at least
**5s** slower is printed in the summary with the ratio, the seconds over, and the reference it beat.
The 5s floor is what keeps a 1s suite's ordinary jitter out of the report, and only a *passing* suite
is judged: one that died after two seconds is fast, not healthy. It warns rather than fails by default, because wall time moves with
the machine (on a loaded box the SQL mutation run has been measured at 378s against its own 212s, and at **826.5s**
on the most loaded run recorded here),
and `--timing=strict` turns the warning into a failure for a gate that wants it.

Samples are kept per **run shape**, because a full run and a `--skip-npm` run are different machines
of a kind: the second leaves the Node lane half empty, so its suites come back faster, and averaging
the two would make every full run look slow. A suite is only ever judged against runs of its own
kind; an `--only` run is one suite nearly alone, which is neither, so it records nothing and is
judged against the full-run record — the slower, harder reference.

The lanes are ordered by the same numbers. Once a suite has three recorded runs here, its measured
median decides what starts first in its lane and the hand-written `est` becomes the fallback: an
estimate is a number someone typed and rots as the suites grow, a measurement does not.

The **whole gate** is watched too — every suite can be steady on its own while the run they share
gets longer — so the wall clock is compared against its own recent history in the same shape, at **1.3×**
and **45s** longer, and a run that is merely *bigger* (more suites in it) is reported as a bigger gate
rather than a slower one. A slow run also **names the suites that explain it**, largest first, measured
against each suite's *own* recorded runs rather than its share of the clock — the suite that is always
the slowest one here has not changed and is not named for it. If nothing clears 2s past its own
baseline, or the suites that do add up to under half the overage, the line says that instead: the run
got longer without one suite doing it, which points at the lanes or the machine rather than at a suite.

And there the warning **escalates**, because a warning nobody acts on is how a gate that got three
times slower stays that way: the same regression **three runs in a row fails the run**, so the pre-push
gate stops being something that only ever prints. Two details are what make the streak mean what it
says. The reference is **frozen at the run that started it** — counting slow runs against the rolling
median would not work, because three slow runs are enough to *become* the median, after which the very
same run reads 1.00× and `ok` and the evidence has absorbed itself. And a run of a different **size**
cannot be part of the same regression: adding a suite makes a run longer for reasons that have nothing
to do with rot, so that run is reported as a bigger gate and the streak neither counts it nor is ended
by it. Fixing it is the better way out, and the runner checks for it: every run that counts writes down
**which suites it blamed**, and the next run measures those first. When they are all back inside their
own baselines — a blamed suite is "back" when it is no longer *slow* by the runner's own suite bar,
1.5× its recorded runs and 5s past them, because a few percent on a busy box is the noise that check
exists to ignore — the regression the streak was counting is gone, so that slow run is not counted as
more of it: the streak ends, the count starts
again, and the run passes even if the machine is still slow for some other reason. A suite that
failed, was skipped or did not run is not evidence of anything, so a red gate cannot clear itself by a
suite quietly disappearing either. Escaping is still deliberate and one command wide for the case where
nothing was fixed — if the machine really did change, `--accept-slow-gate` says so once: the streak is
cleared, the run passes, and that run's cost becomes the reference the next one is judged against (and
stays the reference until another acceptance replaces it, so you do not accept the same slowdown
twice). `--timing=off` is the other way out. The
streak lives in that same baseline file, so on a laptop it is a fact about **this** machine — the file
is the machine. In CI that file is one cache entry restored by every ref, and the streak in it is
shared for exactly the reason the next paragraph gives.

CI keeps that file too, because otherwise the escalation could never fire there, and the one pull
request this whole check exists for — the one that slows **every** run — would always be its own
first slow run. The workflow caches the runner's baseline beside the cross-commit report, hands it
back as `--baseline`, and the runner writes it out again for the run after this one, so three
consecutive slow runs fail the CI job exactly as they fail a push. That cache is restored by prefix
from **any** ref, and the streak in it is deliberately shared for the same reason: the slowdown being
watched for is the *runner* getting slower, and that lands on whichever branch happens to run third.
Counted per branch it could never escalate — a branch with no history starts its own count at one, so
one slow runner reads as its own first slow run on every branch, for ever, and the regression that
slows every run is the one nobody ever sees fail. So each run labels itself instead (`--gate-ref`, the
ref CI is running), and every run that counts records it: the reporting line then says whether it was
**one branch three times** (somebody pushing a regression) or **three branches once** (`across 3 refs
(main, pull/7, pull/9)`, which is the machine, and the line says so). Accepting follows the same rule,
because accepting is a statement about the machine and there is one machine: one `accept_slow_gate`
run, or the `ARZUZ_ACCEPT_SLOW_GATE` variable, is the reference for every ref that reads the cache.

A gate that can only ever fail is a gate people turn off, so CI can be told the machine really did
change, by the same route as the local flag: dispatch this workflow with `accept_slow_gate` checked,
or set the repository variable `ARZUZ_ACCEPT_SLOW_GATE=true` (Settings → Secrets and variables →
Actions → Variables) to say it for every ref at once — the one to reach for when the runner image
itself got slower. Either way this run's cost becomes the reference and the streak is cleared for
every ref that reads the cache, because accepting is a statement about the machine. The
red gate's own line says so, and it says the CI version of it when the runner can tell it is in CI,
because "run this on your laptop" is not an instruction anyone can follow there.

Alongside the gate's history, each run can be written out as a per-suite report: `--timing-report`
writes the run as JSON and `--timing-compare` says what moved since an earlier report, which is how CI
shows a suite that got slower **across commits** — it caches each run's report and hands the next run
the previous one, then uploads it as an artifact. That report and the baseline are two different
memories: the report is what one run cost, the baseline is what this gate normally costs and how many
runs in a row have been past that.

That artifact is written for the run that **went red**, and a red gate is read by whoever has to act on
it, who cannot scroll a log they were not watching — so the report carries the explanation and not
just the numbers: which ref it was, the gate's verdict and reference, the **blamed suites** with each
one's time, seconds past its own baseline and ratio, how many suites were past the floor and how many
were still learning here, where a **streak** was seen (its count, its refs, and — for one a rerun
ended on evidence — the suites that came back), and the exact sentence the
log printed. `gate` is `null` when the run judged nothing, because an empty object would read as "no
suite was to blame" when the truth is that no verdict exists yet.

**`scripts/test-site-audit.mjs`** is the reason to run all of it. It loads every `*.html` in the repo
at 1440 and 390 and makes each page prove it still works alongside the rest: the page answers 200
with a title (and a description, unless the deploy config marks it noindex), the shared motion layer
boots, **every** reveal lands after a vertical sweep *and* a pass over every horizontally scrolling
strip that holds a reveal — a card that only appears once its strip is scrolled is invisible until
then, and the sweep steps by less than a viewport so no element can hide between two steps — nothing
scrolls sideways, every stylesheet, script, image, icon and webfont it names actually loads, and
every internal link resolves: to a real file, or to the Netlify Function `netlify.toml` routes it
to. Delete a redirect and the pages that used it fail here.

Those probes are bounded at **60s and retried once**, because this suite does not run alone: the gate
runs it beside the SQL proofs, and on a box where those are eating every core, a local file has been
measured taking longer than the 15s that used to be the verdict here — which reported a busy machine
as a missing asset (`/assets/admin.js?v=25 → no response within 15s`, twice, against a page that
passes alone in 90s). The bound still exists: a server that accepts a connection and then says nothing
is a failure after 60s twice, not a gate parked in silence. An HTTP answer of any kind — 200 or 404 —
is the file's verdict and is never retried.

**A lost script request, on purpose.** `scripts/test-listing-render.mjs` drives the real
`listing.html` through `dev/listing-harness.html`, and that harness exists for one failure mode: a
script request lost between the page being written and the parser running it, which used to surface
as "Arzuz is not defined" and a page reported broken. `node scripts/test-listing-render.mjs
--fault-inject` reproduces that loss on purpose — randomly chosen boot-critical scripts, failed at the
network layer — and then requires the harness to answer it, one family of loss per run:

| family | knob | what the harness has to do |
| --- | --- | --- |
| a lost script | `--fault-victims=K`, `--fault-drops=N` | bring every script back on its one reload (`ok-after-retry`) |
| the harness's own preflight | `--fault-preflight=N` | retry the fetch itself, so the **first** document boots |
| the stylesheet | `--fault-css=N` | report the page it wrote as unstyled, instead of passing a naked page |

The landlord invite suite has the same mode for the page a landlord fills in
(`node scripts/test-invite-render.mjs --fault-inject`), with one family — a lost boot-critical
script — because that page has one shape of fatal loss. It drops a single request per load, proves
the drop landed, proves the harness reloaded once and the page booted with the script back, and then
runs every ordinary check against the recovered page. Like the listing suite it refuses to run if the
drop never lands, and `--fault-drops=2` is its control.

The two pages with no harness page get the same treatment through a different repair.
`scripts/test-admin-worst.mjs --fault-inject` and `scripts/test-home-motion.mjs --fault-inject` load
`admin.html` and `index.html` whole — the dashboard's own dev mode, and the real homepage — so there
is nothing to preflight in a harness. Instead both pages end with a dev-only block that loads
[dev/page-harness-boot.js](dev/page-harness-boot.js), which states one row per page: the scripts that
hold up that page's own boot, and the global each of them must leave on `window` (the dashboard's
`dev/admin-mock-data.js` → `ArzuzMockData` and `dev/admin-mock.js` → `__MOCK__`, the homepage's
`assets/app.js`, `assets/data.js` and `assets/motion.js`). A lost script is noticed by the absence of
that global, and the page reloads **once** to fetch it again; the state it publishes
(`ok`, `ok-after-retry`, `still-missing`) is what the fault mode reads, so a load only counts as
repaired when the page's own check says the script came back and every ordinary check still passes
against the recovered page. `--fault-drops=2` kills the reload's copy too and must leave the run red —
same control, same message.

The candidates are derived, not retyped: `harnessBootPlan()` in
[page-rules.mjs](scripts/page-rules.mjs) reads that table back out of the boot file and intersects it
with the scripts the page itself names, and both suites call it before a browser opens. A script
added to a page and to the table is a fault target that day; one the page stopped loading leaves the
list the same way, because the table would be aiming at something the harness no longer repairs. Four
checks fail the run as a *plan* rather than as a mystery load: the table still carries a row for the
page, every script it watches is one the page names, the page still loads the check, and the
intersection is not empty. `page-rules.mjs` also pins that these two suites read their aim from that
function and not from a second copy of the table.

`--fault-rate=P` faults only that fraction of loads, so the clean path is exercised beside the
faulted ones instead of the mode only ever running broken, and `--fault-seed=N` makes the plan
deterministic: the seed is printed, and passing it back reproduces every victim on every load (a red
run that cannot be replayed is a red run nobody can debug). One family per run, refused otherwise —
a load that lost a script *and* a stylesheet would leave the harness's answer ambiguous.

The loss is aimed, not sprayed: interception is armed per load and its pattern names only **that
load's victims**, so no other request is ever paused — a clean load (the rate left it alone) is not
intercepted at all. That is not tidiness. Chrome never times a paused request out, so one lost
continue hangs that request for ever, and pausing every `.js` request on the page gave the suite a
way to hang that had nothing to do with the page it was judging.

A load is waited for, not rushed: `--render-timeout=<seconds>` (default **180s**) is how long one load
may take to settle before it is called stuck, and Chrome's own launch gets 60s for the same reason. It
is a wait, never a verdict — every check here is about what the page rendered — and it exists because
the gate runs two CPU-heavy node suites beside this one, where a starved load had not even had its
document written when the old 30s deadline expired. The failure message names the wait, the boot state
and the harness's own status, so a genuinely stuck page still reads as one instead of as a machine
that was merely busy.

One case is not a verdict at all: if not a single read ever came back — no document, no boot state,
nothing — the load is retried **once**, and the retry is printed. A renderer that never got CPU is not
a page, and that is measurably what a starved machine produces: this suite beside the SQL mutation
suite, 180s with nothing read, the very same load green when it ran alone. A page that is genuinely
broken fails both times, and the fault plan is untouched — interception stays armed across the retry,
so the second document loses exactly what the first one did.

The first two families are recoveries: a faulted load counts only if every request actually failed
(a load where nothing was dropped proves nothing, and fails) **and** the harness answered as above
with every check still passing; a load the rate left alone must boot `ok` on its first document. A
kill the browser itself undid — Chrome served its own copy, so the page booted first try with the
script the suite thought it had taken — is neither a recovery nor a failure: the load says `Chrome
served its own copy`, and it is **not counted as proof**, so it can never make this family look
greener than it was. A sweep in which not one faulted load needed the harness to answer for it
fails, for the same reason a sweep where the fault never fired fails: a green run that proved nothing
about the recovery is not a green run.

The stylesheet family proves the opposite kind of thing, because a stylesheet has no retry — so the
harness measures the document it wrote and says whether the page is styled at all, and in this family
that guard is asserted the other way round: the page must come back **unstyled** and the missing sheet
must be the exact one that was stopped. That guard runs on every load of every listing suite, which is
the point: an unstyled page used to pass, because every check here is about content and the markup of
a naked page is all still there.

The script list is read from the page and the harness's own layer map (the stylesheet list from the
page's own `<link rel=stylesheet>`), so a script or sheet added to the page becomes a fault candidate
the day it lands, and one deleted leaves the list the same way.

Measured: the full sweep at `--fault-victims=2` is 18 loads — every fixture case at both widths — with
18 recovered, 36 requests dropped, 503/503 checks, exit 0. The same sweep at `--fault-rate=0.5`
carries clean and compound loads side by side and stays green; the preflight family answers `boot ok`
on the first document. `--fault-seed` reproduces the plan exactly — every victim, on every load, in
order — which is what a failing run needs in order to be debugged; it is deliberately not a promise
about the clock, because a load that outlasts its wait is a matter of machine load and not of the
plan, and the seed cannot replay a busy machine. The controls: `--fault-drops=2` drops the retry's copy
too and must leave the page `still-missing`, `--fault-preflight=3` exhausts the harness's three
tries and must leave it `preflight-failed` — both exit 1, and the failure line names the control it
is — and a sweep in which the fault never fired at all fails too, because that is a green run that
proved nothing.

The gate runs four of these over the heaviest fixture: `listing-fault` (one script lost),
`listing-fault-compound` (two at once), `listing-fault-preflight`, and `listing-fault-css`. It runs
the invite form's one family as `invite-fault`, and the two boot-check pages as `home-motion-fault`
and `admin-fault` — four pages, four repairs, each on the load the gate actually runs rather than on
a hand-typed command nobody repeats. The controls stay out of the gate by design: a `--fault-drops=2`
entry is a suite that is meant to fail, and a gate that fails on purpose is a gate nobody trusts.

**`scripts/test-deploy-guards.mjs`** is static and instant. Because `publish = "."` publishes the
whole repo, it asserts that nothing but the website is public — every `supabase-*.sql`, every `*.md`,
`dev/*`, `scripts/*` and the dev manifests (`package.json`, `package-lock.json`, `netlify.toml`)
carry a forced 404 — and that `sitemap.xml` only points at pages that exist. It is what caught
`supabase-care.sql` (added without the deny rule the config comment asks for, so the Care ledger's
constraints and policies would have been readable by anyone) and the three dev files that arrive
with `package.json`. Those rules are in `netlify.toml` now; adding a `supabase-*.sql` without one
fails this suite.

**The gate.** Netlify deploys whatever lands on main, so a broken page — or a public `.sql` file — is
live the moment it is pushed:

```bash
git config core.hooksPath .githooks   # once per clone
```

`.githooks/pre-push` then runs `node scripts/test-all.mjs --quiet --strict` and aborts the push if
anything failed, printing the failing suite's own output and the command to re-run it alone. The
hooks path is repository-local config, so a fresh clone has to run that line once; the hook explains
itself if `node` or `scripts/test-all.mjs` is missing, and `git push --no-verify` pushes anyway when
you mean it.

The same runner is a step in [.github/workflows/ci.yml](.github/workflows/ci.yml), so a pull request
runs the browser suites as well as `npm test` — `--skip-npm` there, because the step above it has
just run the ten Node suites and there is no reason to pay for them twice. CI also starts every run
with no timing baseline (the file is gitignored because it describes a machine), so it can report a
suite far past its built-in estimate but never learns from a runner it will never see again; the
baseline that gets compared is the one learned where the gate actually runs.

---

## Support Desk

The **Support Desk** section is the support team's home: tickets from the listing page's
“Report a problem” button, plus phone complaints logged with the form below the queue. Each
ticket carries status (`open → in_progress → resolved`), notes, a one-click WhatsApp button and
an **open-for timer** — anything past 48 hours is flagged red. A canned-replies panel holds
ready-to-send answers written from the site's own promises (no fees, viewing flow, safety tips).
The Overview shows open tickets alongside the draft queue.

---

## Team logins and roles

Every account is created by the main admin — public sign-ups are off, so there is no
self-service. Use **admin.html → Settings → Team** (create, role, reset password, remove); the
panel calls `netlify/functions/team.js`, which holds `SUPABASE_SERVICE_ROLE_KEY` server-side
and only answers callers whose token is a main admin. Without that env var, the panel shows the
manual fallback: Supabase → Authentication → Users, then edit the Raw User JSON.

A user's role rides in the session token as `app_metadata.role`; the dashboard reads it with
`ArzuzAuth.role()`:

| Role | `app_metadata` | Lands on | Sees |
|---|---|---|---|
| Main admin (default) | *(unset)* | Overview | Everything, including Growth, Strategy, Settings — and the Team panel |
| Support | `{ "role": "support" }` | Support Desk | Tickets, bookings, demands, read-only listings. No delete buttons, no settings/growth/strategy |
| Marketing | `{ "role": "marketing" }` | Growth | Growth (traction, funnel, channels, what-to-do-next) + the Strategy docs, marketing ones first. No data tables, no settings |

To revert someone to main admin, set their role to “Main admin” in the Team panel (or remove the
`role` key in Supabase).

### Where the roles are enforced

That table describes what the dashboard *shows*. `supabase-team-roles.sql` makes the same three
roles true in the database, because a client-side gate is a hint, not a boundary. Run it after the
other SQL files; it is additive and safe to re-run.

It adds `public.arzuz_role()`, which reads `app_metadata.role` out of the request's signed JWT and
answers `anon | marketing | support | admin`. The `auth.role() = 'anon'` branch comes first on
purpose: an anonymous visitor's token carries no `app_metadata`, so the obvious
`coalesce(claim, 'admin')` would have made every visitor on the internet the main admin.

The policies then follow the table above: admin gets full read/write; support gets read on demands
and listings plus read/update on bookings and tickets; **marketing gets no policy on any base
table at all.** That is the enforcement, not an oversight — with RLS enabled and no applicable
policy a select returns zero rows, so a marketing login has no path to a student's or landlord's
phone number.

Marketing still needs its numbers, so the same file adds five definer views —
`growth_demand_feed`, `growth_listing_feed`, `growth_scout_feed`, `growth_booking_feed` and
`growth_roommate_summary` — whose `payload` is rebuilt with an explicit `jsonb_build_object`
allow-list rather than a `payload - 'phone'` subtraction, so a field somebody adds to a form
tomorrow is invisible until it is named on purpose. `assets/admin.js` reads the base tables for
admin and those views for every other role; when a view is missing the Growth page says
"run the role SQL" instead of drawing a funnel of zeros.

Until that file is run, role gating is presentation-only, exactly as it was before: every
authenticated user can still read the same tables. Running it is what makes the separation real.

---

## Attribution — where a registration came from

Every link Arzuz hands out can carry a channel tag: `arzuz.com/register?ref=flyer-q1`.
`assets/attribution.js` captures it on whatever page the visitor lands on (index, browse, register,
listing, owner-list, scout), remembers it for the visit and for 30 days after, and `submit.js`
copies the surviving tag into the row's `payload.ref`. The Growth view counts `payload.ref` per
channel, which is what turns doc 06 from a plan into a measurement.

- **Last touch wins.** A tag in the current URL beats a stored one; with none, the session's tag is
  used, then a stored tag younger than 30 days. An invalid tag never overwrites a valid one.
- **A tag is not a token.** `/complete-listing` uses the SAME `ref` parameter for the landlord's
  secret draft token, so attribution is switched off on that page entirely, and `sanitize()`
  rejects token-shaped values (a 32/40/64-char hex digest, a UUID) everywhere else.
- **Sharing is a channel too.** The confirmation screens show a share prompt built by
  `assets/share.js`, and every share carries its own tag — `listing-share`, `student-share`,
  `landlord-share` — so a referral is a countable channel instead of anonymous traffic.
- **House style for tags:** lowercase, `[a-z0-9._-]`, up to 40 characters — `whatsapp-status`,
  `ambassador-ayosha`, `flyer-q1`, `tiktok-bio`. Anything else is dropped rather than stored, and
  the Growth view shows which registrations still carry no tag so the habit is visible.

---

## Changing things

**Colours and type** — `assets/arzuz.css`, the `:root` block at the top.

**Demand numbers** — `assets/data.js`, `BANDS`. Every figure the site displays comes from there.
Set `DEMAND_IS_REAL = true` once the bands hold your own records and the wording switches to
"live" on its own.

**Amenity labels** — the built-in list is `_DEFAULT_UTILITIES` in `data.js`; anything the admin
dashboard adds lives in the `amenities` table so every browser sees it.

**Property types** — one list, `PROPERTY_TYPES` in `data.js`, used by the landlord form and both
admin modals. Change it there and every form follows.

**Maps and location** — everything lives in `assets/arzuz-map.js` (`ArzuzMap`). The pin-capture
widget writes `lat`, `lng`, `pin` and `pin_meta` (`source`, `accuracy_m`, `samples`, `captured_at`)
into the form payload; the passage editor writes `passage` (`landmark`, `gate`, `floor`, numbered
`steps`, a simplified `route`, and `route_src` of `traced`/`walk`/`osrm`). The listing page draws
the best route available: a community-traced path first, then a real road route from the free
FOSSGIS OSRM walking server (no API key, cached in localStorage), then a straight-line estimate.
`supabase-location.sql` exposes pin quality and passage presence as queryable columns — optional;
the site works without running it.

**Adding a page** — copy the head and script tags from an existing page, call
`Arzuz.chrome('student' | 'owner' | null)` at the top and `Arzuz.footer()` at the bottom. Form
pages that use `UTILITIES` start inside `ArzuzData.ready.then(...)`.

**Adding a form flow** — `Arzuz.form({steps, done, backHref, backLabel, table})`. Step types:

| Key | Renders |
|---|---|
| `o: [...]` | Tappable single-choice options, auto-advances |
| `c: [...]` | Multi-select chips |
| `f: [[id, label, type]]` | Text fields. Types: `text`, `tel`, `number`, `sel`, `pin`, `passage`, `rent-live`, `photo` |
| `ta: "placeholder"` | Textarea |
| `opt: true` | Button reads "Skip" instead of "Continue" |
| `ctx: true` | Shows the live demand context box above the question |
| `onlyIf: fn` | Step appears only when the function returns true |

---

## How a submission travels

`form finish → ArzuzSubmit.send → POST /rest/v1/<table>` with a `client_ref` UUID
→ **on success only**: Telegram alert via `/api/notify`, WhatsApp confirmation via
`/api/whatsapp-send` → on failure the row is queued in localStorage and flushed when the browser
comes back online. `client_ref` is unique in the database, so a retry can never write twice.

---

## The reference, and checking on it yourself

Every public submission is handed a reference — `ARZ-S-4F7A-2C9B-1D3E` — minted in the database by a
`BEFORE INSERT` trigger, never taken from what the browser sent. That is not decoration: a
browser-chosen handle is a handle an attacker can choose, to collide with somebody else's or to pick a
memorable one and be mistaken for them. One registry table means a reference names exactly one row
anywhere in the system, so a support agent can be given one string and resolve it.

The reference is useful to two people. The team types it into the dashboard. The person it belongs to
can now ask for it themselves at **`/status`**, and that page is built around the question of what
happens when a reference leaks — read out loud on a call, screenshotted, passed on in a group chat:

- **The reference alone opens nothing.** The page also needs a contact we hold for that record — the
  phone number, or the email address — and then proves control of it: a six-digit code goes to that
  contact and the stage appears only when the code comes back. No session and no token — the code
  *is* the proof, for one answer, and then it is spent.
- **There are two channels, because the phone is the contact people change.** A new SIM, a new line
  after a lost phone, or WhatsApp itself being down all used to mean the code had nowhere to arrive
  and the page answered the one person it exists for with nothing. So the code can go to the email on
  the file instead — a mailbox survives a changed number — and the WhatsApp path falls back to that
  same email by itself when the number cannot be messaged or the sender refuses. Both channels go out
  through the one sender that owns each of them (`netlify/functions/whatsapp-send.js` and
  `notify.js`'s `sendEmail`), so neither credential is read in two places.
- **Which channels a record has is never observable.** The generic sentence is channel-neutral, so the
  identical bytes answer a request made by phone and one made by email; the fallback that delivers by
  email when WhatsApp fails changes nothing in the reply; and both channels share one count, so
  switching channel cannot buy a second allowance. `scripts/test-status.mjs` asserts each of those,
  including byte-for-byte.
- **The lookup cannot be used to enumerate references.** The count happens in the database, BEFORE the
  reference is looked at, so every attempt is counted — including the ones aimed at a reference that
  does not exist. The counter's own failure is the same `502` for every reference, which
  `scripts/test-status.mjs` asserts by name rather than by reading the code.
- **Every answer is the same answer.** A malformed reference, a reference nobody ever minted, a phone
  number that is not the one on the file, and a code that really is on its way all get the identical
  `200` body. The only thing allowed to differ is a rate limit, because that depends on the caller and
  not on the reference. The suite compares those bodies byte for byte, because this is the property a
  later "helpful" error message would quietly destroy.
- **What it reveals is the stage and nothing else** — the pipeline stage, the row's own status, when it
  arrived, whether it has been checked and how far, and whether it was the roommate questionnaire. Not
  the phone, not the name, not the answers, not the landlord's payload. That list lives in SQL, so no
  page can widen it.

A code is six digits from the CSPRNG, hashed with the service key as the salt before it is stored, ten
minutes to live, five attempts, and issuing a second one kills the first. The plaintext is written
nowhere: not to a table, not to a log. The log line is the step, the reference and the outcome — and
the reference is never inside the WhatsApp message, so a lock-screen preview cannot hand over a handle.

### The gate that keeps a deploy that cannot keep its promises away from students

Three credentials, and all three fail the same way when they are missing: **nothing looks broken**.
There is no crash to notice — only a person who was told their request was received and then never
heard anything again.

- `SUPABASE_SERVICE_ROLE_KEY` — since anon's INSERT was revoked, the waitlist door is the **only**
  way a public form reaches the database. Without the key every page loads, every form submits, and
  every submission answers `503 not-ready` while the answers sit in the student's own browser.
- `OPENWA_URL` / `OPENWA_API_KEY` — every confirmation, coverage and dispute notice goes out over
  OpenWA, and so does the six-digit code the status page depends on. Without them the code is
  **issued and never delivered**: the student waits at a box that stays empty, and the notice is
  recorded as unsent in a trail nobody is reading.

`OPENWA_SESSION` and `RESEND_API_KEY` are on the script's **advised** list: their absence degrades the
site rather than breaking a promise (WhatsApp still delivers; the status page's second email channel
and the claim emails go quiet). Those print warnings and never fail the build — a gate that fails on a
preference is a gate people learn to override.

So the Netlify **build command** is a check rather than a copy step:

```toml
[build]
  command  = "node scripts/require-service-key.mjs --require"
  publish  = "."
```

A failed build does not publish, so the last good deploy stays live and nobody meets the broken one.
It never prints a value — only whether each variable is set and how long it is — and its failure names
BOTH causes for every missing name: the variable was never set, or it is set for "Functions" only,
which is a correct configuration that this build cannot see. `ARZUZ_ALLOW_MISSING_ENV=1` lets a
deliberate deploy through — or `ARZUZ_ALLOW_MISSING_ENV=OPENWA_URL,OPENWA_API_KEY` for exactly those —
and the older `ARZUZ_ALLOW_MISSING_SERVICE_KEY=1` still means the one variable it always meant.
`scripts/test-deploy-key.mjs` parses `netlify.toml` to assert the wiring, because a check no deploy
runs is a comment.

---

## How a failure travels — the class, not just the sentence

A page never has to guess what a failed answer meant. Every function that answers JSON builds its error
body through the **same module the page loads** (`assets/api-errors.js`), so the two ends cannot drift:

```js
/* the function (server) */        body: JSON.stringify(ApiErrors.wireBody(503, { error: '…' }, 'not-ready'))

/* the page (browser) */           throw ArzuzApiErrors.failed(res, body)   // err.kind, err.message, err.status
```

`kind` is named only where the number would be read **wrong**: `503` for a deploy with no service key is
`not-ready` (nothing the person can do), while the same `503` from a busy minute is `error`; a `404` from
`strategy-docs` is `not-ready`; a `401` on a page that holds a session is `expired`. Everywhere else the
class is derived from the status, so a page that reads it gets one of the same six names either way. A
class no page can read is discarded rather than shipped. The class is what changes what happens next —
`retryable()` and `queueable()` read it too, so a missing key is never answered with "try again in a
minute", and a page that lost the module still keeps the function's own sentence and status.

Two of the branches are **destructive** rather than merely unhelpful, and both have a suite that drives
them through a stubbed transport rather than reading the code: the Care page deletes a student's stored
link on a refused one (and must not, for a half-finished deploy), and the roommate page offers to
withdraw a profile on the same `404` a route that is not in this deploy answers. `node
dev/roommate-test.js` (36) and `node dev/my-care-test.js` (72) put each class on the wire through the
real `assets/api-errors.js`, so what is asserted is the sentence a student reads, not a status the
harness typed.

---

## Two rules that are not style preferences

**Every number shown must trace to a real record.** The demand counts, the enquiry counts, the
FAQ rent ranges. If a count is zero, say so — never round it up. A landlord who lists at your
price and finds nobody waiting will tell every other landlord in Malete within a week.

**Verifier assignment must be enforced in the database.** A caretaker can never be assigned a
compound they run, and assignment must be random. This is currently only stated in copy. When it
becomes real it needs to be a constraint between verifier and property, not an ops guideline.
Everything else in this system can be policy. That one cannot.

---

## Before this becomes the live site

- [x] `supabase-hardening.sql` (or `supabase-schema.sql` on a new project) run, and anon can no
      longer read rows — verified 3 Oct 2026: anon SELECT on the three tables returns 401
- [x] Supabase Auth admin user created, public sign-ups turned off, dashboard signed in
      (sign-up endpoint verified returning 422)
- [x] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set in Netlify; test alert received
- [x] Cloudinary API secret rotated (it once sat in a code comment) and the new value in Netlify
- [x] Self-host the two fonts, or drop to system fonts on the product pages (Bricolage Grotesque +
  Instrument Sans woff2 subsets now served from `assets/fonts/`, `font-display: swap`)
- [ ] Outline the `az` mark to SVG so the logo does not depend on a webfont loading on 3G
- [ ] Test on a sub-₦30,000 Android on real 3G
- [ ] Confirm the KWASU session start date and work the launch calendar backwards from it

---

Arzuz — open to students everywhere, starting in Malete, Kwara State. Pronounced AR-zuz.
