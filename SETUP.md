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
   it adds just the `public_listings` view browse.html reads.
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
`netlify/functions/team-admin.js`, which verifies every caller is the main admin before using it.

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
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | The service-role key — server only. Powers Settings → Team (create users, set roles) and nothing else. Without it the Team panel shows the manual-fallback instructions | |
| `OPENWA_URL` / `OPENWA_API_KEY` / `OPENWA_SESSION` | WhatsApp confirmations |

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

Then **Site settings → Domain management** to point `arzuz.com` at it. Netlify issues the HTTPS certificate automatically.

## Step 6 — Test it properly

1. Open your live URL **on a phone, on mobile data** — not on your laptop over wifi
2. Complete the register form all the way through
3. Supabase → **Table Editor** → `demand_records` — your row should be there
4. Now switch on airplane mode, fill the form again, then switch it back on. The submission should arrive by itself within a couple of seconds. That is the offline queue, and it matters more here than almost anywhere else.

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

## Three things to do by hand, every day

**Check `minors_needing_guardian`.** Anyone on that list is under 18 with no guardian on file. **Match nothing to them until it is filled in.** The safeguarding policy is not optional and this view exists to make it easy.

**Fill in `opening_ask_ngn` on every listing.** The form cannot capture it, because the opening ask is what a landlord said to your face before you showed them any demand data. Enter it from your field notes the same day, and never overwrite it afterwards.

> The gap between `opening_ask_ngn` and `listed_price_ngn` is the only real measurement of whether Arzuz works. Every listing missing an opening ask is a landlord you cannot use as evidence.

**Move `status` along.** `open` → `matched` → `fulfilled` on demand records; `pending` → `active` on listings. Two minutes a day keeps `demand_summary` honest.

---

## Before you share the link publicly

- [x] Schema run (`supabase-schema.sql` or `supabase-hardening.sql`), and anon **cannot** read
      rows — verified 3 Oct 2026: anon SELECT returns 401 on all three tables
- [ ] Test submission arrives in the Table Editor
- [ ] Offline queue tested with airplane mode — one row, not two (`client_ref` makes retries safe)
- [ ] `ENV` switched from `test` to `production`, and test rows deleted
- [x] Admin user created in Supabase Auth, sign-ups off, dashboard signs in
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
