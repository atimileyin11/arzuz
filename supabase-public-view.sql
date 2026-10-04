-- ============================================================
-- ARZUZ — one-time addition for the public browse page
-- Run this once in Supabase → SQL Editor → Run.
-- (Only needed because supabase-hardening.sql was already run
-- before browse.html existed; fresh installs get this from
-- supabase-schema.sql automatically.)

-- Safe to run more than once. It creates one view and one grant —
-- it does not touch any table, row or existing policy.
--
-- What browse.html may show: active, community-verified or
-- inspected, production listings only — and no owner names or
-- phone numbers. The base `listings` table stays anon-proof.
-- ============================================================

create or replace view public_listings
with (security_invoker = true) as
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
  payload
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
--   → returns [] today (no verified inventory yet) and will list
--     only active + verified rows once real ones exist.
--
--   The base table must still reject anon reads:
--   fetch(SUPABASE_URL + '/rest/v1/listings?select=id', …same headers…)
--   → { code: '42501', … } permission denied.
-- ------------------------------------------------------------
