# GOING LIVE
## Netlify + Supabase, start to finish

About 40 minutes. No servers to run — three small Netlify Functions handle the sending, and both
services are free at your scale.

---

## What you are putting live

**Live and real** — the homepage, and three forms that write to your database:

| Page | Collects | Table |
|---|---|---|
| `register.html` | Student housing needs | `demand_records` |
| `owner-list.html` | Property listings | `listings` |
| `scout.html` | Building registrations, real rent paid | `scout_submissions` |

**That is the whole site** — plus `browse.html`, the public board of verified rooms. It reads the
`public_listings` view (active + community-verified or inspected + production only) and shows
nothing when that view is empty. A student who registers cannot wander into invented data,
which is the only version of this that is honest before you have real inventory.

The homepage carries one illustrative element: the price curve a landlord drags. It is labelled
**Illustrative figures** until you set `DEMAND_IS_REAL = true` in `assets/data.js`, at which point
the label and the wording switch to live automatically.

---

## Step 1 — Supabase project

1. Go to **supabase.com** → sign up → **New project**
2. Name it `arzuz`. Choose the region closest to Nigeria — **eu-west-1 (Ireland)** or **eu-central-1 (Frankfurt)**. Nothing is hosted in Africa; Europe is the shortest hop.
3. Set a database password and save it somewhere safe.
4. Wait about two minutes for it to build.

## Step 2 — Create the tables

1. Left sidebar → **SQL Editor** → **New query**
2. **New project?** Paste all of `supabase-schema.sql`. **Already have data?** Paste
   `supabase-hardening.sql` instead — it does the same job without touching your rows.
   Already hardened *before* the browse page existed? Run `supabase-public-view.sql` once —
   it adds just the `public_listings` view the site reads. Run
   `supabase-listings-updated-at.sql` **before** it: that adds `listings.updated_at`, the day a
   listing was last edited, which is what `sitemap-listings.xml` reports as each room's
   `lastmod`. Without it the sitemap still works but falls back to the day the room was
   registered — the wrong signal on the pages whose price has moved. Additive and safe to
   re-run; `supabase-public-view.sql` has to be re-run after it to expose the new column.
   The sitemap's per-room `changefreq`/`priority` need no extra SQL either: they are sized from
   the generated columns (photo, pin, price, type, rooms) and the `has_description` flag that
   the same view exposes, so re-running `supabase-public-view.sql` is also what adds the
   description signal. Until then the sitemap sizes each room without it and logs a line. The
   same score is what the dashboard's **Crawl** column shows an owner (`assets/listing-score.js`,
   read by both), so re-running the view is also what fills in the badge they act on.
   Using the dashboard's draft-invite links? Run `supabase-drafts-support.sql`, then
   `supabase-draft-sharing.sql` (adds **view-only / edit** permissions and link expiry, and
   enforces both on the server). Both are additive and safe to run more than once.
   Selling Care credits? Run `supabase-team-roles.sql` first — `supabase-care.sql`'s policies are
   scoped by the role model it builds, and the file refuses to create an unprotected table — then
   `supabase-care.sql`, the ₦20,000-session ledger. Both are additive and safe to run twice.
   Taking payment for a Care Pass, or working the repair claims it covers? Then, in this order:
   `supabase-finance.sql` (the books: payments, an append-only ledger, versioned published terms,
   referrals — it extends `care_plans` with the coverage window, cap and receipt a paid pass
   needs), then `supabase-claims.sql` (repair claims, their audit trail, and the two functions that
   take and return a call-out **atomically**). Each one names whichever file it needs if you run it
   out of order, and leaves nothing half-built when it refuses.
   Taking public form submissions? Then `supabase-team-roles.sql` (a re-run is fine), then
   `supabase-waitlist-launch.sql` — the waitlist's reference registry, consent columns, pipeline
   stage and append-only audit trail, plus the door's own throttle. **Then set
   `SUPABASE_SERVICE_ROLE_KEY` and deploy**, submit one real registration and check it comes back
   with a reference, and only then run `supabase-close-public-inserts.sql`. That last one revokes
   `insert` on the five public tables from `anon`, which is what makes the validated door the only
   way in — so it is the one file in the chain whose order is not merely about the schema: run it
   before the door works and the site takes no submissions at all. It refuses to run unless
   `waitlist_throttle()` exists, so the migration order cannot be got wrong, but it cannot check a
   Netlify environment variable for you.
   Using the **verification** role — the officer who checks a property before it goes live? Run
   `supabase-verification-rpc.sql` too, after the waitlist file and before the closer. It withdraws the
   row-wide update policy that let an approving officer change a listing's price and adds
   `public.listing_verify()`, which moves `status`, `tier`, `verified_at` and `verified_by` and nothing
   else. Safe to run more than once, and it leaves every listing where it is.
   Working that role as a **shift** — a queue of live listings nobody has visited, a 48-hour deadline
   once an officer takes one, and a job nobody came back on going back to the queue by itself? Then
   `supabase-verification-queue.sql` as well, right after the RPC file above (it is stage 2 of the same
   layer, and it asks the database for the same role model). It adds the claim columns, the append-only
   `verification_events` trail and three column-scoped functions: `verification_queue()` to read the
   shift, `listing_take()` / `listing_release()` to hold a listing and give it back. Additive and safe
   to run twice. **The queue is drawn on `/admin` as soon as the file is run**, and the hourly chaser
   (`netlify/functions/verification-aging.js`, scheduled in `netlify.toml`) starts paging the team
   within the hour — so run it when somebody is on the shift, not the day before a holiday.
   Letting students check their own reference — the **/status** page? Run
   `supabase-status-codes.sql` after the waitlist file. It adds the code table (a hash of the code, never
   the code), a lookup throttle in a table of its own so a lookup flood can never throttle real
   submissions, and the function that builds the reveal from a fixed column list. Its one guard names
   the file to run if the reference registry is not there yet. Additive, and safe to run twice.

   Then run `supabase-status-history.sql`, which is the other half of that page: it records where each
   code was actually sent, so the Support Desk can answer "I never got the code" from the dashboard
   instead of from a build log. The desk does not need the student to have kept their reference — the
   last four characters of it, or the phone number they applied with, will find it, and if a fragment
   fits more than one reference the panel lists them and says nothing about any of them until the
   officer picks one. It adds one column to the code table and re-states the verify function
   on top of it, so run it after the file above — and if you ever re-run that file, run this one again
   afterwards, because re-running the older one restores the earlier verify function, which does not
   read the code's own attempt ceiling. Additive, and safe to run twice.

   **Care is not live until that has run *and* the site has been deployed.** `npm run care:live`
   checks both (plus `/my-care.html`) against the live site and database and names whichever layer
   is missing; nothing local can see the difference.
3. Press **Run**

You should see *Success. No rows returned.*

**Do not skip this file or write your own tables.** It contains the row-level security rules that
stop your public site from being able to read data back. The anon key is published in every page
you serve, so anything it is allowed to do, every visitor is allowed to do. With these rules the
site can **add a record and nothing else**: no reads, no updates, no deletes. Reads, updates and
deletes are granted only to a signed-in admin (Step 4b).

## Step 3 — Get your keys

1. Left sidebar → **Project Settings** → **Data API**
2. Copy the **Project URL** and the **anon / public** key

The anon key is designed to be public — it is in every Supabase site on the internet. It is only safe because of the rules in Step 2, which is why Step 2 comes first.

**Never put the `service_role` key on the website.** That one bypasses every rule — on this
project it exists only as the Netlify env var `SUPABASE_SERVICE_ROLE_KEY`, read exclusively by
`netlify/functions/team.js`, which verifies every caller is the main admin before using it.

## Step 4 — Fill in the config

Open `assets/config.js` and set:

```js
SUPABASE_URL: 'https://yourproject.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi...',
SESSION: '2026/2027',
ENV: 'production',
SUPPORT_WHATSAPP: '234...'      // your number, no + or spaces
```

That is the whole file now. The Telegram bot token, the Cloudinary secret, the OpenWA key and the
admin login **do not live in the browser** — if a value can be abused by whoever reads the page
source, it belongs to the server. Next step.

Set `ENV` to `'test'` while you are trying things out. Every view in the database filters to
`production`, so your test rows will not pollute the numbers you show a landlord.

## Step 4b — Netlify environment variables

**Site configuration → Environment variables**, then set:

| Variable | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather. Alerts go out through `/api/notify` with it |
| `TELEGRAM_CHAT_ID` | Yours. Get it from the admin dashboard → Auto-Detect Chat ID |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` / `CLOUDINARY_CLOUD_NAME` | Signed photo uploads (and video fallback) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` | Video tour uploads to an unlisted YouTube video — one-time setup, next section |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | The service-role key — server only. Powers Settings → Team (create users, set roles) **and `/api/waitlist`, the public submission door**. Without it the Team panel shows the manual-fallback instructions and every public form holds its submission in the browser instead of writing it — since `supabase-close-public-inserts.sql` there is no second path | |
| `PAYSTACK_SECRET_KEY` | The money core's secret key — server only. Without it every payment write answers `503 not-ready` and `/care-pass` says so instead of offering a checkout, so nothing half-charges |
| `OPENWA_URL` / `OPENWA_API_KEY` / `OPENWA_SESSION` | WhatsApp confirmations — the coverage and dispute notices the claim workflow sends a student or a worker, and **the six-digit code the /status page sends before it will show anybody their stage**. The first two are on the build gate's **required** list: without them the code is issued and never delivered, and the build refuses rather than publishing that. `OPENWA_SESSION` is **advised** — the code falls back to a hardcoded session name, and if that is not the session your OpenWA server actually has, every message is refused while the site looks healthy. When OpenWA refuses a code the status page still answers — it always says the code is on its way — and it records the refusal on that code's own trail and falls back to the email on the record when there is one, which is what the Support Desk's code history panel reads |
| `OPENWA_WEBHOOK_SECRET` | The secret on the OpenWA webhook that posts to `/api/wa-inbound` — the same value OpenWA signs each delivery with. The only thing that makes a worker's reply trustworthy: without it the function refuses every request rather than reading an unsigned one. See Step 4b-3 |
| `RESEND_API_KEY` | Email for those same notices, **and the status page's second channel** — the code a student can have sent to the address on their file when they have changed their number or when WhatsApp is down. Advised rather than required: without it the decision still goes out on WhatsApp, the claim's own record says the email was not sent, and `/status` simply stops offering the email option. Until your domain is verified in Resend, their shared sender only delivers **to your own account address**, and the refusal is passed through rather than swallowed. One refusal it cannot leave a trace of: an `/status` request made **by email** on a deploy with no mail provider is refused before a code is minted, so the Support Desk's code history has no row for it and says so (LAUNCH-READINESS.md §6, risk 5) |
| `ARZUZ_MAIL_FROM` | Optional. The verified sender, e.g. `Arzuz Care <care@arzuz.com>`. Defaults to that address when unset |

### Step 4b-1 — Paystack (the money core, ~10 minutes)

Care Pass sales go through Paystack. Two values, and only one of them is a secret:

1. Paystack dashboard → **Settings → API Keys & Webhooks**. Copy the **secret key**
   (`sk_live_…`) into `PAYSTACK_SECRET_KEY`. It is server-side only — it must never
   appear in a page, a config file, or this repository. The **public key** (`pk_live_…`)
   is not used anywhere: the server opens the transaction and hands the browser
   Paystack's own hosted checkout URL, so no key ever reaches the browser.
2. Same page → **Webhook URL**: `https://arzuz.com/api/paystack-webhook`. Paystack signs
   the exact bytes it sends, and that function verifies the HMAC-SHA512 signature before
   it parses anything.
3. The **callback URL** needs no dashboard entry. The server builds it from the
   deployment's own origin at checkout time (`ARZUZ_SITE_URL`, else the deploy URL),
   never from the incoming request, and the buyer lands back on
   `/care-pass?reference=…` — which still asks Paystack directly before it says a word
   about coverage.
4. Sales stay **off** until the Care Pass terms are approved and published in the admin
   dashboard (Finance → terms). Until then `/care-pass` says exactly that rather than
   offering a checkout.

### Step 4b-2 — Video tours on YouTube (one-time, ~10 minutes)

Video tours are stored as **unlisted YouTube videos** on your channel. Visitors play them
inside the site's own player — no YouTube branding, no links — and the video never counts
against your Cloudinary storage. Set it up once:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create (or pick) a project.
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **APIs & Services → OAuth consent screen** → External → fill the app name/email → add your
   own Google account as a **test user** (test mode is enough).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI: `http://localhost:8765`. Copy the **client ID** and **client secret**.
5. On your computer, sign the browser into the Google account that owns the channel the tours
   should live on (a **brand account** keeps your personal channel clean), then run:

   ```
   node scripts/youtube-auth.mjs <CLIENT_ID> <CLIENT_SECRET>
   ```

   Open the printed URL, approve access, and the script prints a refresh token.
6. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `YOUTUBE_REFRESH_TOKEN` into the Netlify
   environment variables and redeploy. Done — every video tour now streams straight from the
   uploader's browser to YouTube as an unlisted video.

**Good to know**

- Google's free quota allows about **6 uploads per day**. When it runs out, uploads
  automatically fall back to Cloudinary (the 10 MB limit applies there), so a tour is never lost —
  but ask Google for a quota increase if you list more than a handful of videos daily.
- Unlisted videos do not appear on the channel or in search, but anyone holding the link can
  open it. That is fine: the stored links are never shown to visitors — they play through the
  site's masked player.
- If the token is ever revoked, uploads fail over to Cloudinary and the terminal log shows a
  reminder to re-run `scripts/youtube-auth.mjs`.

### Step 4b-3 — The worker's reply (OpenWA inbound webhook, ~5 minutes)

Naming a worker is you saying who is coming; it is not them agreeing to come. So the handover message
lets the worker answer — **YES** to take the job, **NO** if they cannot, or a **day** if they can come
but have not said yes — and that reply has to reach the claim. Set it up once, on the OpenWA server:

1. In OpenWA's dashboard, open the **session** the site sends through and add a **webhook**:
   - **URL**: `https://arzuz.com/api/wa-inbound`
   - **Events**: `message.received` (that is the only one this endpoint reads)
   - **Secret**: a long random string. OpenWA signs every delivery with it (HMAC-SHA256 over the
     exact body, in the `X-OpenWA-Signature` header).
2. Put that same string into the Netlify environment variables as `OPENWA_WEBHOOK_SECRET` and
   redeploy. It is a secret: never in a page, a config file, or this repository.
3. Test it: WhatsApp the session from a number you have just named on a claim — reply `yes` — and
   the claim's trail should gain an `accepted` row, with "has confirmed the job" beside the worker's
   name in the queue.

**What it does with a reply.** A *yes* is recorded against the claim and the job stays with them. A
*no* puts the claim back to **covered, with nobody on it** — so the queue's own clock starts its
24-hour "name a worker" again — keeps who was asked and what they said on the record, tells the
customer whose name has just evaporated, and pages the team. A **day** ("I can do Saturday morning",
"could I come Monday?") is kept in the worker's own words and the customer is told when, on their pass
link and by message — quoted, never turned into a date, and never counted as a yes. An answer that is
neither is asked about again rather than guessed at, and a message from a number the team never asked
anything is left alone: the office reads that WhatsApp number too, and a machine talking over a human
conversation is its own kind of failure.

**And a worker who never answers at all is chased by the clock, not by you.** When a handover has gone
unanswered past its deadline, the hourly `claims-aging` job (see *The claim queue: deadlines, and who gets
told*, below) asks the worker **once**
— "reply YES if you are taking it, or NO if you cannot; if we do not hear from you we will give the job
to somebody else" — and, if that ask is still unanswered the next day, takes the job back the same way a
refusal does: back to **covered with nobody on it**, the customer told there is no longer a name (and
*told differently* — "we could not get a confirmation out of…", not "not able to take the job"), the team
paged, and the worker told the job has gone so nobody turns up to a flat somebody else is already in.
Nothing to set up: it runs with the rest of the clock.


## Step 4c — Create the admin login

The dashboard at `/admin.html` signs in with **Supabase Auth**, not a passcode — a passcode in a
web page is a passcode in everyone's hands.

1. Supabase → **Authentication → Users → Add user** → email + a long password you have not used
   anywhere else. Save it in your password manager.
2. Turn **off** public sign-ups (Authentication → Settings). You are the only account.
3. Open `/admin.html`, sign in, confirm the three tabs fill up. Signing out or closing the tab
   ends the session.

## Step 5 — Deploy

**Fastest way:** go to **app.netlify.com/drop** and drag the whole `arzuz-demo` folder onto the page. You will have a live URL in under a minute.

**Better, once you have a repo:** push to GitHub, then Netlify → Add new site → Import from Git. Every push then deploys itself.

The build runs `node scripts/require-service-key.mjs --require` **before** it publishes. If a
credential the site's promises depend on is not in this deploy's environment, the build fails and the
last good deploy stays live. The required list is:

- `SUPABASE_SERVICE_ROLE_KEY` — the waitlist door is the only way a public form reaches the database,
  and a deploy without the key answers `503 not-ready` to every student while looking perfectly
  healthy.
- `OPENWA_URL` and `OPENWA_API_KEY` — the status page's verification code, and every confirmation,
  coverage and dispute notice, goes out over OpenWA. Without them the code is **issued and never
  delivered**: the student waits at a box that stays empty.

`OPENWA_SESSION` and `RESEND_API_KEY` are on the **advised** list: their absence degrades the site
rather than breaking a promise, so they are printed as warnings and never fail the build.

The failure names both causes for every missing variable (never set, or set for "Functions" only) and
never prints a value — only whether each one is set and how long it is. For a deliberate deploy of
something else, `ARZUZ_ALLOW_MISSING_ENV=1` lets the whole list through and logs a warning, and
`ARZUZ_ALLOW_MISSING_ENV=OPENWA_URL,OPENWA_API_KEY` lets exactly those through. The older
`ARZUZ_ALLOW_MISSING_SERVICE_KEY=1` still works and still means the one variable it always meant.

This applies to **every** build, deploy previews included — a preview whose forms silently take
nothing is worse than no preview. If you want previews that do not carry the key, give the variable a
preview-scoped value rather than removing it from production.

Then **Site settings → Domain management** to point `arzuz.com` at it. Netlify issues the HTTPS certificate automatically.

## Step 6 — Test it properly

1. Open your live URL **on a phone, on mobile data** — not on your laptop over wifi
2. Complete the register form all the way through
3. Supabase → **Table Editor** → `demand_records` — your row should be there
4. Now switch on airplane mode, fill the form again, then switch it back on. The submission should arrive by itself within a couple of seconds. That is the offline queue, and it matters more here than almost anywhere else.
5. Open **`/status`** and put in that reference with the phone number you used. A six-digit code should
   arrive on WhatsApp within a minute, and the code should show you the stage. Then check the two
   things that matter more than the happy path: a **wrong** code and a **wrong** number must both say
   the same thing the right pair says before the code arrives — "if that reference and number match a
   record of ours, a code is on its way" — and an unknown reference must say it too.

---

## Reading your data

**Supabase → Table Editor** for the raw rows. Every table has an **Export to CSV** button.

**Supabase → SQL Editor** for the views the schema already built for you:

```sql
select * from demand_summary;              -- the demand report, live
select * from price_movement;              -- landlords who moved off their opening ask
select * from minors_needing_guardian;     -- check this every single day
select * from reported_rent_benchmark;     -- what residents say they really pay
```

`demand_summary` is the one you show a landlord. `price_movement` is the one that proves the business.

---

## The claim queue: deadlines, and who gets told

The queue in the admin dashboard is ordered by **pain, not by age**: a claim that has stood in one status
past the deadline for that status is at the top, worst first, and the deadline is printed on its row and its
card. Below the late ones sit the claims closest to going late, and a claim with no clock at all — a draft,
or anything finished — never outranks one that is still moving. Two kinds of late are kept apart on purpose:

| Status | Allowed | Whose move it is |
|---|---|---|
| `submitted`, `under_review` | 24h | us — decide coverage |
| `approved` | 24h | us — name a worker |
| `assigned`, `in_progress` | 48h | us — get the work reported |
| `disputed` | 24h | us — close the dispute |
| `awaiting_customer` | 168h (7 days) | the customer — a reminder to chase, not a failure |

Nothing is on a clock that nobody is waiting for: a draft is the student's own unfinished form, and a
completed or refused claim is done. The clock is read from each claim's **own trail**, not from `updated_at`,
so touching a claim — re-assigning it, adding a note — does not buy it time.

`netlify/functions/claims-aging.js` runs **hourly** (declared in `netlify.toml` — a missing schedule deploys
fine and silently never runs) and messages the team on Telegram about every claim that has just crossed its
deadline. It is deliberately a timer rather than part of the queue: reading a page must not have side
effects, and a queue read five times would send five messages. **Once per crossing**, not once an hour — a
nudge writes an `overdue_nudge` row to the claim's trail, and a claim that is nudged, moved on, and goes late
again in its new status is a new crossing and is nudged again.

**And when a handover has gone unanswered, this clock is the thing that acts.** A claim sitting in
`assigned` with no word back is not merely late — nobody is coming. So at its own 48-hour crossing the
worker is asked **once** ("is it yours? reply YES or NO"), the `chased` row being what keeps it to once,
and if that ask is still unanswered 24 hours later the job is **taken back the same way a refusal goes**:
back to covered with nobody on it, the name and the number kept on the row with `provider_answer` set to
`unanswered`, the customer told there is no longer a name, and the team paged. A worker who replies *while*
the clock is deciding keeps the job — the row is re-read before anything is given back — and a worker who
answers with a day has answered, so nothing is taken from them.

The moment coverage is decided, or a dispute is closed, the student is told on **WhatsApp and email**. The
moment a worker is **named**, two notices go out: the job goes to **them** — the reference, the fault, the
address to go to, how to reach the tenant and the quote the customer was given — and the **customer** is
told who is coming and how to reach them, which is what the approval promised them. So the handover is not
a phone call somebody has to remember to make, and the customer is not left waiting for a message they
were told to expect. Every attempt is written to the claim's trail as a `notified` row naming
each channel and its outcome, so "were they told?" is a row rather than somebody's memory of a green toast,
and the answer the operator sees on assigning says which channel actually went. A channel that **fails**
pages the team on Telegram; a channel that does not exist — a pass bought without an email, a worker nobody
gave an address for — is recorded and not escalated, because nobody can act on it.

## How many visits are actually pinned down

Two counts sit in the header of the claim queue, and they are the fastest answer to "how are the visits
going":

```
Visit days   2 agreed · 2 still being haggled over
```

**Agreed** means the customer tapped *yes* to the day the worker suggested — that visit is going to happen
unless somebody rings. **Still being haggled over** means both of them have spoken and they do not match
yet: the worker offered a day, the customer answered with one of their own. That second number is the one to
watch, because the two of them are settling it between themselves and the only thing holding the thread is
this record.

Three things that are deliberately NOT in either number. A claim whose work has already been reported — the
visit happened, so its day is history. A worker who has named no day at all (they ring to arrange a time, so
there is nothing to agree), which the panel says in words instead of counting. And any page limit: both
figures are counted over **every** open claim by the function, so they do not change when you load more rows
— and if that read fails, the row says so rather than printing a zero it made up.

Once a day at **07:00 UTC (08:00 Lagos)**, `netlify/functions/claims-digest.js` sends the same two numbers to
Telegram with the days themselves listed: what was agreed in the last 24 hours, everything still being
haggled over, and everything offered that the customer has not answered — each in the words the person
actually used, never converted into a date, because the two of them used sentences and a computed "Saturday"
would be this site inventing an appointment nobody named. It **sends nothing at all** on a day when
everything is settled and nothing moved; the one thing it will always send is a failure to read the
database, because a digest that stops running does it silently. Run it by hand from Netlify → Functions →
claims-digest → Run now.

**And a day the worker offers is a question the customer answers for themselves.** A day a worker sends is
not a booking: from their pass link the customer either taps **yes — this day works**, or writes the day that
suits them instead ("not Saturday — Sunday afternoon after 2"). A *yes* messages the **worker** that the visit
is on, quoting the day they themselves suggested back at them, because a confirmed visit only one of the two
people knows about is not confirmed; agreeing twice is one message, not two. The *other day* goes to the
**worker** in the customer's own words with the tenant's number to settle it on — they cannot re-arrange a
visit with somebody they cannot reach — and it does not read as a refusal, because it is not one: the job stays
theirs. Neither answer moves the claim, spends a call-out, or restarts the 48-hour clock, and no appointment is
invented here: the day is always somebody's own sentence, never a date this site computed. Both answers are on
the team's screen as well — the queue row says **customer agreed the day** or **customer asked for another
day**, the work panel prints the day that was offered and the day the customer wants side by side (it does not
decide they are the same day; that is yours), and each answer is a `day_agreed` or `day_proposed` row on the
claim's own trail under the customer's own name.

**A moved day does page you** — one line on Telegram, and a *yes* does not. That is on purpose. "This day
works" leaves nothing in the air: the worker has been told, the visit is on. A moved day is a plan the
office still believes something else about, and the two people now settling it between themselves are exactly
the two who cannot be counted on to ring us if they never do. The message carries both days as they said
them and both numbers. **Your move: usually none.** The two of them settle the time between them. You are
paged too if the notice to the worker could not be delivered (the same escalation every other notice gets),
and the job comes back to the queue by itself if the worker ends up replying **NO** — if neither day works,
that reply is how a new worker gets found.

---

## Three things to do by hand, every day

**Check `minors_needing_guardian`.** Anyone on that list is under 18 with no guardian on file. **Match nothing to them until it is filled in.** The safeguarding policy is not optional and this view exists to make it easy.

**Fill in `opening_ask_ngn` on every listing.** The form cannot capture it, because the opening ask is what a landlord said to your face before you showed them any demand data. Enter it from your field notes the same day, and never overwrite it afterwards.

> The gap between `opening_ask_ngn` and `listed_price_ngn` is the only real measurement of whether Arzuz works. Every listing missing an opening ask is a landlord you cannot use as evidence.

**Move `status` along.** `open` → `matched` → `fulfilled` on demand records; `pending` → `active` on listings. Two minutes a day keeps `demand_summary` honest.

---

## Before you share the link publicly

> The ordered version of this, with the command that re-verifies each step (including the six
> migrations the launch depends on, and `npm run migrations:live` to say which are still missing),
> is [LAUNCH-RUNBOOK.md](LAUNCH-RUNBOOK.md).

- [x] Schema run (`supabase-schema.sql` or `supabase-hardening.sql`), and anon **cannot** read
      rows — verified 3 Oct 2026: anon SELECT returns 401 on all three tables
- [ ] Test submission arrives in the Table Editor
- [ ] Offline queue tested with airplane mode — one row, not two (`client_ref` makes retries safe)
- [ ] `ENV` switched from `test` to `production`, and test rows deleted
- [x] Admin user created in Supabase Auth, sign-ups off, dashboard signs in
- [ ] `npm run care:live` exits 0 — the Care migration, the `/api/care-credit` function and
      `my-care.html` all answer (until they do it exits non-zero and names the one that is missing)
- [ ] `RESEND_API_KEY` set and `ARZUZ_MAIL_FROM` verified in Resend, then decide one test claim and
      confirm both the WhatsApp message and the email arrive (the trail row on the claim says what went out)
- [ ] On `/status`, ask for a code with **Email** selected and one with **WhatsApp** selected, using a
      reference whose row carries the address you tested with — both should arrive, and the reply
      should be word-for-word the same
- [x] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set in Netlify; test alert received
- [x] Cloudinary API secret rotated and the new value in Netlify
- [ ] **Safeguarding lead named** in the safeguarding policy, number in the team group
- [ ] `safety.html`, `privacy.html` and `terms.html` published (operator address in privacy and
      terms is Abuja — update it if that changes)
- [ ] Support WhatsApp number set in `config.js`
- [ ] Session set to the correct academic year
- [ ] Opened on a real Android phone on real mobile data

That second-to-last checklist item is the one people skip. **Do not launch a form that collects a minor's phone number with no privacy policy behind it.**

---

## When you outgrow this

The free tier gives you 500MB of database and 50,000 monthly active users. At Malete scale you will not come close — 80 demand records is a few kilobytes.

What changes later, not now:

**A team in the admin page.** `/admin.html` exists and signs in with Supabase Auth, but it is one
login and it can read and delete everything. When a field team arrives, give each person their own
Supabase Auth account, add roles (who may delete, who may only read), and log who changed what —
right now the single shared login cannot tell you which of you deleted a row.

**Real columns instead of JSON.** The schema stores raw answers in `payload` and pulls out the important fields as generated columns, so you can change the form without a migration. When the form settles after a session of real use, promote the rest.

**Automated matching.** At 80 records you match by hand, and a message you wrote yourself converts better anyway. Automate when volume forces it, not before.

---

*Netlify and Supabase are both free at this scale. The only thing that costs money in the next three months is your time in the field.*
