-- ============================================================
-- ARZUZ — media, booking & roommate upgrade
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Adds, on top of supabase-schema.sql / supabase-hardening.sql:
--   1. booking_requests   — "Book this apartment" requests from the
--                           listing detail page. Anon can INSERT only;
--                           Arzuz never collects money, so a booking is
--                           a request the team confirms on WhatsApp.
--   2. roommate_match_summary — the ONE roommate metric from the
--                           business plan: % of shared-type roommate
--                           demand matched within 14 days.
--
-- Run it on a live database without touching existing rows.
-- ============================================================


-- ------------------------------------------------------------
-- 1. BOOKING REQUESTS
-- payload holds the form answers as JSON (same convention as the
-- other tables). listing_id links the request to the apartment the
-- student tapped "Book" on — stored as a plain uuid, deliberately
-- without a foreign key, so deleting a listing never blocks on it.
-- ------------------------------------------------------------

create table if not exists booking_requests (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  client_ref   uuid unique,
  payload      jsonb not null,
  listing_id   uuid,
  session      text,
  env          text default 'production',
  source       text,
  referrer     text,
  user_agent   text,
  status       text not null default 'pending', -- pending / confirmed / viewed / completed / cancelled
  notes        text,

  -- generated columns for the dashboard
  student_name  text generated always as (payload->>'name') stored,
  phone         text generated always as (payload->>'phone') stored,
  move_in       text generated always as (payload->>'when') stored,
  listing_ref   text generated always as (payload->>'listing_id') stored,
  wants_roommate boolean generated always as ((payload->>'roommate') = 'yes') stored
);


-- ------------------------------------------------------------
-- 2. ROW LEVEL SECURITY — same shape as every other table
-- ------------------------------------------------------------

alter table booking_requests enable row level security;

-- INSERT: the public listing detail page, and the admin dashboard.
create policy "public can request a booking"
  on booking_requests for insert to anon, authenticated with check (true);

-- SELECT / UPDATE / DELETE: the signed-in admin only. There is
-- deliberately no anon read policy: phone numbers live here.
create policy "admin can read bookings"
  on booking_requests for select to authenticated using (true);

create policy "admin can update bookings"
  on booking_requests for update to authenticated using (true) with check (true);

create policy "admin can delete bookings"
  on booking_requests for delete to authenticated using (true);


-- ------------------------------------------------------------
-- 3. TABLE GRANTS — belt and braces, exactly like the other tables
-- ------------------------------------------------------------

revoke all on booking_requests from anon;
grant  insert on booking_requests to anon;


-- ------------------------------------------------------------
-- 4. INDEXES
-- ------------------------------------------------------------

create index if not exists idx_bookings_created on booking_requests (created_at desc);
create index if not exists idx_bookings_status  on booking_requests (status);
create index if not exists idx_bookings_listing on booking_requests (listing_id);


-- ------------------------------------------------------------
-- 5. ROOMMATE METRIC — the one number from the business plan (§4.3)
-- "the percentage of shared-type demand records matched to a
--  compatible partner within a set window (start with 14 days)"
--
-- A demand record is a roommate request when payload.roommate = 'yes'.
-- A match is recorded by the admin matching panel: status flips to
-- 'matched' and payload.matched_at gets the pairing timestamp.
-- The view is security_invoker: anonymous callers see nothing.
-- ------------------------------------------------------------

create or replace view roommate_match_summary
with (security_invoker = true) as
with roommate_demands as (
  select
    id,
    created_at,
    status,
    (payload->>'matched_at')::timestamptz as matched_at
  from demand_records
  where payload->>'roommate' = 'yes'
    and env = 'production'
)
select
  count(*) as roommate_demands_total,
  count(*) filter (where status = 'matched') as matched_total,
  count(*) filter (where status = 'matched'
                     and matched_at is not null
                     and matched_at - created_at <= interval '14 days') as matched_within_14d,
  case
    when count(*) = 0 then 0
    else round(100.0 * count(*) filter (where status = 'matched'
                     and matched_at is not null
                     and matched_at - created_at <= interval '14 days') / count(*), 1)
  end as pct_matched_within_14d
from roommate_demands;


-- ------------------------------------------------------------
-- 6. CHECK IT WORKED
-- ------------------------------------------------------------
-- From the browser console on the live site, using the anon key
-- that is in assets/config.js:
--
--   // must come back [] — anon cannot read booking requests
--   fetch(SUPABASE_URL + '/rest/v1/booking_requests?select=id',
--     { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => r.json()).then(console.log)
--
--   // must come back 201 — anon may request a booking
--   fetch(SUPABASE_URL + '/rest/v1/booking_requests',
--     { method: 'POST', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ANON_KEY,
--       'Content-Type': 'application/json' },
--       body: JSON.stringify({ payload: { name: 'Test', phone: '08000000000' },
--                              env: 'test', source: 'sql-check' }) })
--     .then(r => console.log(r.status))
--
-- Then sign in to the admin dashboard: the new Bookings section must
-- show the row, and the Roommate panel must load its metric.
