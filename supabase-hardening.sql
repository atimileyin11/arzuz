-- ============================================================
-- ARZUZ — security hardening for an EXISTING database
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Safe to run more than once. Nothing here drops a table, a column
-- or a row: it only replaces policies, revokes privileges and adds
-- the columns/views a fresh install gets from supabase-schema.sql.
--
-- What it changes:
--   1. The public site can INSERT and nothing else. Anonymous
--      visitors lose read, update and delete on every table that
--      holds a phone number.
--   2. The admin dashboard reads and writes as an authenticated
--      Supabase Auth user instead of as the anon key.
--   3. client_ref makes offline-queue retries idempotent.
--   4. amenities table so admin-added amenity labels reach every
--      browser, not just yours.
--
-- Run this, then create your admin login:
--   Authentication → Users → Add user → email + password,
--   and turn off public sign-ups in Authentication → Settings.
-- ============================================================


-- ------------------------------------------------------------
-- 1. COLUMNS (idempotent)
-- ------------------------------------------------------------

alter table demand_records    add column if not exists client_ref uuid unique;
alter table listings          add column if not exists client_ref uuid unique;
alter table scout_submissions add column if not exists client_ref uuid unique;


-- ------------------------------------------------------------
-- 2. AMENITIES TABLE
-- ------------------------------------------------------------

create table if not exists amenities (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null unique
);

alter table amenities enable row level security;


-- ------------------------------------------------------------
-- 3. ROW LEVEL SECURITY — replace every policy on the three
-- tables so an older, wider policy cannot survive this run.
-- ------------------------------------------------------------

alter table demand_records    enable row level security;
alter table listings          enable row level security;
alter table scout_submissions enable row level security;

-- INSERT: public site + admin dashboard.
drop policy if exists "public can submit demand"     on demand_records;
drop policy if exists "public can submit listings"   on listings;
drop policy if exists "public can submit scout reports" on scout_submissions;
drop policy if exists "allow insert demand"          on demand_records;
drop policy if exists "allow insert listings"        on listings;
drop policy if exists "allow insert scout reports"   on scout_submissions;

create policy "public can submit demand"
  on demand_records for insert to anon, authenticated with check (true);

create policy "public can submit listings"
  on listings for insert to anon, authenticated with check (true);

create policy "public can submit scout reports"
  on scout_submissions for insert to anon, authenticated with check (true);

-- The old policies: anonymous read / update / delete with using (true).
-- Anyone holding the public anon key could read, alter or wipe every
-- phone number on the site. All of them go.
do $$
declare p text;
begin
  foreach p in array array[
    'allow select demand', 'allow select listings', 'allow select scout reports',
    'allow update demand', 'allow update listings', 'allow update scout reports',
    'allow delete demand', 'allow delete listings', 'allow delete scout reports',
    'public can select demand', 'public can select listings',
    'public can select scout reports', 'public can update demand',
    'public can update listings', 'public can update scout reports',
    'public can delete demand', 'public can delete listings',
    'public can delete scout reports',
    'admin can read demand', 'admin can read listings', 'admin can read scout reports',
    'admin can update demand', 'admin can update listings', 'admin can update scout reports',
    'admin can delete demand', 'admin can delete listings', 'admin can delete scout reports',
    'admin can add amenities', 'admin can remove amenities', 'public can read amenities'
  ] loop
    execute format('drop policy if exists %I on demand_records',    p);
    execute format('drop policy if exists %I on listings',          p);
    execute format('drop policy if exists %I on scout_submissions', p);
  end loop;
end $$;

-- SELECT / UPDATE / DELETE: the signed-in admin only.
create policy "admin can read demand"
  on demand_records for select to authenticated using (true);

create policy "admin can read listings"
  on listings for select to authenticated using (true);

create policy "admin can read scout reports"
  on scout_submissions for select to authenticated using (true);

create policy "admin can update demand"
  on demand_records for update to authenticated using (true) with check (true);

create policy "admin can update listings"
  on listings for update to authenticated using (true) with check (true);

create policy "admin can update scout reports"
  on scout_submissions for update to authenticated using (true) with check (true);

create policy "admin can delete demand"
  on demand_records for delete to authenticated using (true);

create policy "admin can delete listings"
  on listings for delete to authenticated using (true);

create policy "admin can delete scout reports"
  on scout_submissions for delete to authenticated using (true);

-- Amenities: everyone may read the labels, only the admin may change them.
create policy "public can read amenities"
  on amenities for select to anon, authenticated using (true);

create policy "admin can add amenities"
  on amenities for insert to authenticated with check (true);

create policy "admin can remove amenities"
  on amenities for delete to authenticated using (true);


-- ------------------------------------------------------------
-- 4. TABLE GRANTS — RLS picks the rows, grants pick the
-- operations. A policy typo must not hand anon a read.
-- ------------------------------------------------------------

revoke all on demand_records, listings, scout_submissions from anon;
grant  insert on demand_records, listings, scout_submissions to anon;
grant  select on amenities to anon;


-- ------------------------------------------------------------
-- 5. INDEXES
-- ------------------------------------------------------------

create index if not exists idx_demand_created on demand_records (created_at desc);
create index if not exists idx_demand_status  on demand_records (status);
create index if not exists idx_demand_band    on demand_records (budget_band);
create index if not exists idx_listings_created on listings (created_at desc);
create index if not exists idx_listings_status  on listings (status);
create index if not exists idx_scout_created  on scout_submissions (created_at desc);


-- ------------------------------------------------------------
-- 6. VIEWS (unchanged behaviour, restated so an old install
-- without security_invoker gets it)
-- ------------------------------------------------------------

create or replace view demand_summary
with (security_invoker = true) as
select
  room_type,
  budget_band,
  distance,
  count(*) as students
from demand_records
where status = 'open' and env = 'production'
group by room_type, budget_band, distance
order by students desc;

create or replace view minors_needing_guardian
with (security_invoker = true) as
select id, created_at, first_name, phone, budget_band
from demand_records
where is_minor and coalesce(guardian_phone,'') = ''
order by created_at desc;

create or replace view price_movement
with (security_invoker = true) as
select
  id, created_at, area, property_type,
  opening_ask_ngn, listed_price_ngn,
  opening_ask_ngn - listed_price_ngn as reduction_ngn,
  round(100.0 * (opening_ask_ngn - listed_price_ngn)
        / nullif(opening_ask_ngn,0), 1) as reduction_pct
from listings
where opening_ask_ngn is not null and listed_price_ngn is not null
order by reduction_ngn desc;

create or replace view reported_rent_benchmark
with (security_invoker = true) as
select area,
       count(*) as reports,
       round(avg(rent_reported)) as avg_reported,
       min(rent_reported) as low,
       max(rent_reported) as high
from scout_submissions
where rent_reported is not null and env = 'production'
group by area
having count(*) >= 3;


-- ------------------------------------------------------------
-- 7. CHECK IT WORKED
-- ------------------------------------------------------------
-- Run these two, in this order:

-- (a) as the anon key the website uses: must return 0 rows.
--     In Supabase the SQL editor runs as your own account, so the
--     real test is in the browser console — see the comments at
--     the bottom of supabase-schema.sql.

-- (b) confirm no anon policy survived:
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('demand_records','listings','scout_submissions')
order by tablename, policyname;

-- You should see only:
--   insert    → anon, authenticated
--   select    → authenticated
--   update    → authenticated
--   delete    → authenticated
