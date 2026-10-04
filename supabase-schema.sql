-- ============================================================
-- ARZUZ — database schema (fresh install)
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Security model:
--   * The public site can INSERT and nothing else.
--   * Anonymous visitors cannot read, update or delete any row.
--     The anon key is public (it ships in assets/config.js), so
--     every privilege it holds is a privilege every visitor has.
--   * The admin dashboard reads and writes as an authenticated
--     Supabase Auth user (assets/auth.js). Nothing else can.
--
-- Upgrading a database that was created from an older version of
-- this file? Run supabase-hardening.sql instead — it does the same
-- job without recreating your tables.
-- ============================================================


-- ------------------------------------------------------------
-- 1. TABLES
-- payload holds the raw form answers as JSON, so the form can
-- change without a migration. The generated columns pull the
-- fields you will filter and sort on into real columns.
-- client_ref is a UUID the browser generates once per submission:
-- it makes retries from the offline queue idempotent.
-- ------------------------------------------------------------

create table if not exists demand_records (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  client_ref   uuid unique,
  payload      jsonb not null,
  session      text,
  env          text default 'production',
  source       text,
  referrer     text,
  user_agent   text,
  status       text not null default 'open',   -- open / matched / fulfilled / expired
  notes        text,

  room_type    text generated always as (payload->>'type')     stored,
  budget_band  text generated always as (payload->>'budget')   stored,
  distance     text generated always as (payload->>'dist')     stored,
  timing       text generated always as (payload->>'when')     stored,
  age_band     text generated always as (payload->>'age')      stored,
  first_name   text generated always as (payload->>'first')    stored,
  phone        text generated always as (payload->>'phone')    stored,
  guardian_phone text generated always as (payload->>'g_phone') stored,
  is_minor     boolean generated always as ((payload->>'age') = 'Under 18') stored
);

create table if not exists listings (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  client_ref   uuid unique,
  payload      jsonb not null,
  session      text,
  env          text default 'production',
  source       text,
  referrer     text,
  user_agent   text,
  status       text not null default 'pending', -- pending / active / rejected / inactive
  tier         int  not null default 0,         -- 0 unverified / 1 community / 2 inspected
  notes        text,

  -- THE TWO NUMBERS THAT MEASURE THE WHOLE THESIS.
  -- opening_ask is what the landlord said BEFORE seeing demand data.
  -- Fill it in by hand from your field notes. Never overwrite it.
  opening_ask_ngn  integer,
  listed_price_ngn integer generated always as
                   (nullif(payload->>'rent','')::integer) stored,

  property_name text generated always as (payload->>'prop_name') stored,
  photo_url     text generated always as (payload->>'photo')     stored,
  property_type text generated always as (payload->>'ty')   stored,
  area          text generated always as (payload->>'ar')   stored,
  rooms         text generated always as (payload->>'rm')   stored,
  owner_name    text generated always as (payload->>'nm')   stored,
  owner_phone   text generated always as (payload->>'ph')   stored,
  run_by        text generated always as (payload->>'who')  stored,
  latitude      double precision generated always as (nullif(payload->>'lat','')::double precision) stored,
  longitude     double precision generated always as (nullif(payload->>'lng','')::double precision) stored
);

create table if not exists scout_submissions (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  client_ref   uuid unique,
  payload      jsonb not null,
  session      text,
  env          text default 'production',
  source       text,
  referrer     text,
  user_agent   text,
  status       text not null default 'pending',
  notes        text,

  photo_url      text generated always as (payload->>'photo') stored,
  area           text generated always as (payload->>'area')  stored,
  scout_phone    text generated always as (payload->>'phone') stored,
  rent_reported  integer generated always as
                 (nullif(payload->>'amt','')::integer) stored,
  rent_collected_by text generated always as (payload->>'who') stored,
  vacancy_signal text generated always as (payload->>'vac')   stored,
  latitude       double precision generated always as (nullif(payload->>'lat','')::double precision) stored,
  longitude      double precision generated always as (nullif(payload->>'lng','')::double precision) stored
);

-- Custom amenity labels. The built-in list lives in assets/data.js;
-- this table only holds what the admin dashboard added, so a new
-- amenity appears on every browser instead of only yours.
create table if not exists amenities (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null unique
);


-- ------------------------------------------------------------
-- 2. ROW LEVEL SECURITY — the part that protects your users
-- ------------------------------------------------------------

alter table demand_records    enable row level security;
alter table listings          enable row level security;
alter table scout_submissions enable row level security;
alter table amenities         enable row level security;

-- INSERT: the public site, and the admin dashboard.
create policy "public can submit demand"
  on demand_records for insert to anon, authenticated with check (true);

create policy "public can submit listings"
  on listings for insert to anon, authenticated with check (true);

create policy "public can submit scout reports"
  on scout_submissions for insert to anon, authenticated with check (true);

-- SELECT / UPDATE / DELETE: the signed-in admin only.
-- There is deliberately no anon read policy anywhere: the anon key
-- is published in the page source, so anyone holding it could
-- otherwise download every phone number ever collected.
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
-- 2b. TABLE GRANTS — RLS decides which rows, grants decide which
-- operations are even possible. Belt and braces: a policy typo
-- must not hand anon a read of the phone numbers.
-- ------------------------------------------------------------

revoke all on demand_records, listings, scout_submissions from anon;
grant  insert on demand_records, listings, scout_submissions to anon;
grant  select on amenities to anon;


-- ------------------------------------------------------------
-- 3. INDEXES
-- ------------------------------------------------------------

create index if not exists idx_demand_created on demand_records (created_at desc);
create index if not exists idx_demand_status  on demand_records (status);
create index if not exists idx_demand_band    on demand_records (budget_band);
create index if not exists idx_listings_created on listings (created_at desc);
create index if not exists idx_listings_status  on listings (status);
create index if not exists idx_scout_created  on scout_submissions (created_at desc);


-- ------------------------------------------------------------
-- 4. VIEWS — what you will actually look at each day
-- security_invoker = true means each view runs with the caller's
-- privileges: anonymous callers see nothing, because they cannot
-- read the underlying tables at all.
-- ------------------------------------------------------------

-- The demand report, live. This is the number you show a landlord.
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

-- Under-18 accounts still missing a guardian contact.
-- Nothing should be matched to anyone on this list.
create or replace view minors_needing_guardian
with (security_invoker = true) as
select id, created_at, first_name, phone, budget_band
from demand_records
where is_minor and coalesce(guardian_phone,'') = ''
order by created_at desc;

-- THE THESIS. Every landlord who moved off their opening ask.
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

-- What residents say they actually pay, aggregated so no single
-- tenant can be identified. Three sources minimum — this rule is
-- in the privacy policy, so keep it here too.
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
-- 4b. PUBLIC LISTINGS VIEW — the one public read surface
-- ------------------------------------------------------------
-- browse.html reads this. Only active, verified, production rows,
-- and only columns that hold nothing personal: owner names and
-- phone numbers stay in the base table, which anon cannot read.
-- The contact path is the support WhatsApp, so no number leaks.

-- Deliberately a plain (definer) view: hardening revokes anon's
-- SELECT on listings, so a security_invoker view would fail with
-- "permission denied" for the website. The definer view exposes
-- exactly the filtered rows and columns defined here — nothing
-- more. payload is scrubbed of owner identity keys (nm/ph/who).

drop view if exists public_listings;
create view public_listings as
select
  id,
  created_at,
  tier,
  listed_price_ngn,
  latitude,
  longitude,
  property_name,
  photo_url,
  property_type,
  area,
  rooms,
  payload - 'nm' - 'ph' - 'who' as payload
from listings
where status = 'active'
  and tier >= 1
  and env = 'production';

grant select on public_listings to anon;


-- ------------------------------------------------------------
-- 5. CHECK IT WORKED
-- ------------------------------------------------------------
-- From the browser console on your live site, using the anon key
-- that is in assets/config.js:
--
--   // must come back [] — anon cannot read rows any more
--   fetch(SUPABASE_URL + '/rest/v1/demand_records?select=id',
--     { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => r.json()).then(console.log)
--
--   // must fail — anon cannot update rows
--   fetch(SUPABASE_URL + '/rest/v1/demand_records?limit=1',
--     { method: 'PATCH', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ANON_KEY,
--       'Content-Type': 'application/json', Prefer: 'return=representation' },
--       body: JSON.stringify({ status: 'open' }) }).then(r => console.log(r.status))
--
-- Then submit a test record from the live site and confirm the row
-- appears, and that the admin dashboard still reads it after signing in.
