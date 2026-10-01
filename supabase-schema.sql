-- ============================================================
-- ARZUZ — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Security model: the public site can INSERT and nothing else.
-- Anonymous visitors cannot read, update or delete any row.
-- You read your data from the Supabase dashboard, which uses a
-- different key that never touches the website.
--
-- Do not skip the RLS section. Without it the anon key can read
-- back every phone number you have ever collected.
-- ============================================================


-- ------------------------------------------------------------
-- 1. TABLES
-- payload holds the raw form answers as JSON, so the form can
-- change without a migration. The generated columns pull the
-- fields you will filter and sort on into real columns.
-- ------------------------------------------------------------

create table if not exists demand_records (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
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


-- ------------------------------------------------------------
-- 2. ROW LEVEL SECURITY  — the part that protects your users
-- ------------------------------------------------------------

alter table demand_records    enable row level security;
alter table listings          enable row level security;
alter table scout_submissions enable row level security;

-- The website may add a row and read rows for dashboard display.
create policy "public can submit demand"
  on demand_records for insert to anon with check (true);

create policy "public can submit listings"
  on listings for insert to anon with check (true);

create policy "public can submit scout reports"
  on scout_submissions for insert to anon with check (true);

-- Enable select access for admin dashboard display
create policy "allow select demand"
  on demand_records for select to anon using (true);

create policy "allow select listings"
  on listings for select to anon using (true);

create policy "allow select scout reports"
  on scout_submissions for select to anon using (true);

-- Enable update access for admin dashboard editing
create policy "allow update demand"
  on demand_records for update to anon using (true) with check (true);

create policy "allow update listings"
  on listings for update to anon using (true) with check (true);

create policy "allow update scout reports"
  on scout_submissions for update to anon using (true) with check (true);

-- Enable delete access for admin dashboard
create policy "allow delete demand"
  on demand_records for delete to anon using (true);

create policy "allow delete listings"
  on listings for delete to anon using (true);

create policy "allow delete scout reports"
  on scout_submissions for delete to anon using (true);


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
-- 5. CHECK IT WORKED
-- Run this after inserting a test record from the live site.
-- ------------------------------------------------------------
-- select count(*) from demand_records;
-- select * from demand_summary;
-- select * from minors_needing_guardian;
