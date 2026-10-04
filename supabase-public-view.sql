-- ============================================================
-- ARZUZ — one-time addition for the public browse page
-- Run this once in Supabase → SQL Editor → Run.
-- (Only needed because supabase-hardening.sql was already run
-- before browse.html existed; fresh installs get this from
-- supabase-schema.sql automatically.)
--
-- Safe to run more than once. It only ever ADDS things: any
-- missing generated columns (no-ops when already present),
-- one view and one grant. It never changes or deletes
-- existing data, columns or policies.
--
-- What browse.html may show: active, community-verified or
-- inspected, production listings only — and no owner names,
-- phones or runner identities (scrubbed from payload below).
-- The base `listings` table itself stays anon-proof.
--
-- NOTE: this is deliberately a plain (definer) view. anon has
-- no SELECT grant on listings (that is the hardening), so a
-- security_invoker view would fail with "permission denied"
-- for the public. The definer view exposes exactly the
-- filtered rows and columns defined here — nothing else.
-- ============================================================

-- 0) Ensure the columns the view reads exist. Older live
--    schemas may predate the generated map-pin/pricing
--    columns; each of these is an additive no-op when the
--    column is already there.
alter table listings add column if not exists tier int not null default 0;          -- 0 unverified / 1 community / 2 inspected
alter table listings add column if not exists env text default 'production';
alter table listings add column if not exists listed_price_ngn integer generated always as (nullif(payload->>'rent','')::integer) stored;
alter table listings add column if not exists property_name text generated always as (payload->>'prop_name') stored;
alter table listings add column if not exists photo_url text generated always as (payload->>'photo') stored;
alter table listings add column if not exists property_type text generated always as (payload->>'ty') stored;
alter table listings add column if not exists area text generated always as (payload->>'ar') stored;
alter table listings add column if not exists rooms text generated always as (payload->>'rm') stored;
alter table listings add column if not exists latitude double precision generated always as (nullif(payload->>'lat','')::double precision) stored;
alter table listings add column if not exists longitude double precision generated always as (nullif(payload->>'lng','')::double precision) stored;

-- 1) The public, anon-readable listing feed.
--    payload is scrubbed of owner identity keys (nm/ph/who)
--    so no name, phone number or runner identity ever becomes
--    publicly readable.
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
-- CHECK IT WORKED — from the browser console of the live site:
--
--   fetch(SUPABASE_URL + '/rest/v1/public_listings?select=id',
--     { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => r.json()).then(console.log)
--
--   → returns [] today (no verified inventory yet) and will
--     list only active + verified rows once real ones exist.
--   → a 42501/permission error here means the Run failed —
--     read the error banner in the SQL editor.
--
--   The base table must still reject anon reads:
--   fetch(SUPABASE_URL + '/rest/v1/listings?select=id', …same headers…)
--   → { code: '42501', … } permission denied.
-- ------------------------------------------------------------
