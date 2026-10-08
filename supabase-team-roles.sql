-- ============================================================
-- ARZUZ — role-enforcing row level security
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this AFTER supabase-schema.sql (or supabase-hardening.sql),
-- supabase-media-booking.sql and supabase-drafts-support.sql.
-- Safe to run more than once. Nothing here drops a table, a column
-- or a row: it replaces policies, adds views and adds one helper
-- function.
--
-- WHY THIS FILE EXISTS
-- Every previous file answered one question: "is the caller signed
-- in?" — `to authenticated using (true)`. That is one role, not
-- three. The dashboard now issues marketing logins (created with
-- netlify/functions/team.js, which writes app_metadata.role)
-- so the database has to answer the second question itself: WHICH
-- signed-in user is this?
--
-- The three roles, and what each one may reach:
--
--   admin      the main admin — no role key at all, or role='admin'.
--              Sees and changes everything.
--   support    a team member who phones students and landlords.
--              Reads demands and listings, works bookings and
--              support tickets. Cannot delete, cannot touch scouts,
--              cannot see the strategy pack or the growth panel.
--   marketing  a growth teammate. NO policy on any table that holds
--              a phone number: with RLS on and no applicable policy
--              a select returns ZERO ROWS, so a marketing login
--              physically cannot read a student's or landlord's
--              contact details. It reads the growth numbers through
--              the scrubbed views in section 3 instead.
--
-- That last point is the whole purpose of the file. It is not
-- enforced by hiding a nav item in the browser (assets/admin.js
-- already does that, and browsers can be edited); it is enforced by
-- Postgres, where the marketing token has no path to the rows.
-- ============================================================


-- ------------------------------------------------------------
-- 1. THE ROLE CLAIM
-- Supabase signs app_metadata into the access token, so the claim
-- is available to any policy — no extra lookup, no cached copy to
-- go stale. assets/auth.js decodes the same claim for the UI;
-- netlify/functions/team.js is the only thing that writes it.
--
-- The guard on auth.role() is load-bearing. auth.jwt() for an
-- anonymous visitor is the anon token: it has role='anon' and NO
-- app_metadata, so a naive
--   coalesce(jwt->'app_metadata'->>'role', 'admin')
-- would return 'admin' for every visitor on the internet. Anon is
-- therefore matched first, and a JWT that does not exist at all
-- (auth.role() is null) falls through to 'anon' too.
--
-- Anything that is not the three known roles and not anon — most
-- importantly service_role — is returned as its own name, never as
-- 'admin'. service_role bypasses RLS anyway, so no policy ever
-- evaluates for it, and leaving it unnamed here means a future
-- policy can never mistake it for the main admin.
-- ------------------------------------------------------------

create or replace function public.arzuz_role()
returns text
language sql
stable
as $$
  select case
    when auth.role() = 'anon' then 'anon'
    when coalesce(auth.jwt(), '{}'::jsonb) -> 'app_metadata' ->> 'role' = 'marketing'
      then 'marketing'
    when coalesce(auth.jwt(), '{}'::jsonb) -> 'app_metadata' ->> 'role' = 'support'
      then 'support'
    when auth.role() = 'authenticated' then 'admin'
    else coalesce(auth.role(), 'anon')
  end;
$$;

-- Supabase grants EXECUTE on a new function to PUBLIC by default;
-- narrow it to exactly the roles that must evaluate a policy. Same
-- treatment as the draft RPCs in supabase-drafts-support.sql.
revoke execute on function public.arzuz_role() from public;
grant  execute on function public.arzuz_role() to anon, authenticated, service_role;

comment on function public.arzuz_role() is
  'Arzuz team role from the signed JWT: anon | marketing | support | admin.';


-- ------------------------------------------------------------
-- 2. POLICIES PER ROLE
-- Every policy on the six shared tables is dropped first, by name
-- AND by sweep, so a wide policy from an older file cannot survive
-- underneath the new ones (that is how the old `using (true)` set
-- hid during the last upgrade). The sweep is the same shape as
-- section 2 of supabase-schema.sql.
-- ------------------------------------------------------------

alter table demand_records    enable row level security;
alter table listings          enable row level security;
alter table scout_submissions enable row level security;
alter table amenities         enable row level security;
alter table booking_requests  enable row level security;
alter table support_tickets   enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in (
        'demand_records', 'listings', 'scout_submissions',
        'amenities', 'booking_requests', 'support_tickets'
      )
  loop
    execute format('drop policy if exists %I on %I', r.policyname, r.tablename);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 2a. DEMAND RECORDS — the students looking for a room
-- ------------------------------------------------------------

-- INSERT: the public registration form. A public form must never be
-- able to write its own approval state: with check (true) would let
-- anyone holding the anon key POST a demand already marked 'matched'.
create policy "anon can submit demand"
  on demand_records for insert to anon with check (status = 'open');

-- Admin creates records by hand (phone registrations at the gate).
create policy "admin can add demand"
  on demand_records for insert to authenticated
  with check (public.arzuz_role() = 'admin');

create policy "admin can read demand"
  on demand_records for select to authenticated
  using (public.arzuz_role() = 'admin');

-- Support phones students, so it needs the row — but only to read.
create policy "support can read demand"
  on demand_records for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin can update demand"
  on demand_records for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "admin can delete demand"
  on demand_records for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 2b. LISTINGS — landlord submissions and verified apartments
-- ------------------------------------------------------------

-- INSERT: the public landlord form. Status and tier are forced, so
-- nobody holding the anon key can post an 'active', tier 2 apartment
-- straight onto the public browse feed.
create policy "anon can submit listings"
  on listings for insert to anon
  with check (status = 'pending' and tier = 0);

create policy "admin can add listings"
  on listings for insert to authenticated
  with check (public.arzuz_role() = 'admin');

create policy "admin can read listings"
  on listings for select to authenticated
  using (public.arzuz_role() = 'admin');

-- Support calls about an apartment every day; it still may not
-- approve one (that is the tier/status change, i.e. an update).
create policy "support can read listings"
  on listings for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin can update listings"
  on listings for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "admin can delete listings"
  on listings for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 2c. SCOUT SUBMISSIONS — field reports and rent evidence
-- Admin only. A scout report carries the scout's own phone number
-- and the rent a real tenant pays; marketing has no reason to read
-- either, and support's job does not include the rent benchmark.
-- ------------------------------------------------------------

create policy "anon can submit scout reports"
  on scout_submissions for insert to anon with check (status = 'pending');

create policy "admin can add scout reports"
  on scout_submissions for insert to authenticated
  with check (public.arzuz_role() = 'admin');

create policy "admin can read scout reports"
  on scout_submissions for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "admin can update scout reports"
  on scout_submissions for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "admin can delete scout reports"
  on scout_submissions for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 2d. BOOKING REQUESTS — student says "I want to view this"
-- This is the one table support is expected to WORK, not just read:
-- the desk confirms viewings, so support may move the status. It may
-- not create or delete a request.
-- ------------------------------------------------------------

create policy "anon can request a booking"
  on booking_requests for insert to anon with check (status = 'pending');

create policy "admin can add bookings"
  on booking_requests for insert to authenticated
  with check (public.arzuz_role() = 'admin');

create policy "admin can read bookings"
  on booking_requests for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read bookings"
  on booking_requests for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin can update bookings"
  on booking_requests for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "support can update bookings"
  on booking_requests for update to authenticated
  using (public.arzuz_role() = 'support')
  with check (public.arzuz_role() = 'support');

create policy "admin can delete bookings"
  on booking_requests for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 2e. SUPPORT TICKETS — problem reports from the listing page
-- Same split as bookings: support triages and resolves, only the
-- admin deletes.
--
-- NOTE: support is deliberately NOT given insert here. If the
-- Support Desk grows an "add a ticket by hand" action, it needs a
-- matching `support can add tickets` policy below — without one the
-- insert fails loudly (42501) rather than quietly widening access,
-- which is the behaviour we want from a security file.
-- ------------------------------------------------------------

create policy "anon can report a problem"
  on support_tickets for insert to anon with check (status = 'open');

create policy "admin can add tickets"
  on support_tickets for insert to authenticated
  with check (public.arzuz_role() = 'admin');

create policy "admin can read tickets"
  on support_tickets for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read tickets"
  on support_tickets for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin can update tickets"
  on support_tickets for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "support can update tickets"
  on support_tickets for update to authenticated
  using (public.arzuz_role() = 'support')
  with check (public.arzuz_role() = 'support');

create policy "admin can delete tickets"
  on support_tickets for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 2f. AMENITIES — shared labels, not personal data
-- Everyone signed in (and the public forms) may read them; only the
-- admin curates the list.
-- ------------------------------------------------------------

create policy "anyone can read amenities"
  on amenities for select to anon, authenticated using (true);

create policy "admin can add amenities"
  on amenities for insert to authenticated
  with check (public.arzuz_role() = 'admin');

create policy "admin can remove amenities"
  on amenities for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 2g. WHAT IS MISSING ON PURPOSE
-- There is no marketing policy on demand_records, listings,
-- scout_submissions, booking_requests or support_tickets. That is
-- the enforcement, not an oversight: with RLS enabled and no
-- applicable policy, Postgres returns zero rows to a select and
-- refuses writes outright. Do not "fix" this by adding a
-- `to authenticated using (true)` policy. If marketing needs a new
-- number, add the column to a scrubbed view in section 3.
--
-- Equally deliberate: nothing is revoked from the `authenticated`
-- role in this file. Grants decide which OPERATIONS a role may
-- attempt and are role-wide; policies decide which ROWS and which
-- OPERATIONS actually pass. Revoking select from `authenticated`
-- would lock the main admin out along with marketing. The earlier
-- files already stripped anon back to insert-only, and that stays.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 3. THE MARKETING READ SURFACE
-- Four definer views and one aggregate. They are definer views in
-- exactly the sense outlined at the top of supabase-public-view.sql:
-- the view owner reads the base table, so the marketing role needs
-- no grant and no policy on it at all.
--
-- payload is rebuilt with jsonb_build_object — an explicit ALLOW
-- list, never `payload - 'ph'`. Subtraction leaks: the next field
-- someone adds to a form is exposed by default, and nobody notices.
-- With an allow list, a new field is invisible until it is named
-- here on purpose.
--
-- `env` is carried through rather than filtered on, so these views
-- return the same row set the admin dashboard sees; the client keeps
-- filtering test rows in one place.
-- ------------------------------------------------------------

drop view if exists growth_demand_feed;
create view growth_demand_feed as
select
  id,
  created_at,
  status,
  session,
  env,
  room_type,
  budget_band,
  distance,
  timing,
  age_band,
  jsonb_build_object(
    'ref',      payload ->> 'ref',
    'roommate', payload ->> 'roommate',
    'type',     payload ->> 'type',
    'budget',   payload ->> 'budget',
    'dist',     payload ->> 'dist',
    'when',     payload ->> 'when',
    'age',      payload ->> 'age'
  ) as payload
from demand_records;

-- No phone, no first_name, no guardian_phone, no notes: a marketing
-- login cannot reach them through this view, and cannot reach the
-- table they live in at all.

drop view if exists growth_listing_feed;
create view growth_listing_feed as
select
  id,
  created_at,
  status,
  tier,
  env,
  opening_ask_ngn,
  listed_price_ngn,
  property_name,
  property_type,
  area,
  rooms,
  jsonb_build_object(
    'prop_name', payload ->> 'prop_name',
    'ty',        payload ->> 'ty',
    'ar',        payload ->> 'ar',
    'rm',        payload ->> 'rm',
    'rent',      payload ->> 'rent'
  ) as payload
from listings;

-- owner_name, owner_phone, run_by and draft_token are excluded.
-- draft_token matters most: it is a live invite link that lets its
-- holder rewrite that apartment, so it must never be readable by a
-- non-admin role. (It works for the link holder through the definer
-- RPC listing_draft_get in supabase-drafts-support.sql, which
-- requires the token — it is never handed out by a read.)

drop view if exists growth_scout_feed;
create view growth_scout_feed as
select
  id,
  created_at,
  status,
  env,
  area,
  jsonb_build_object(
    'area', payload ->> 'area',
    'vac',  payload ->> 'vac'
  ) as payload
from scout_submissions;

-- The scout's own phone number and the rent they reported stay out:
-- the rent benchmark is aggregate-only by policy (three reports
-- minimum, see reported_rent_benchmark).

drop view if exists growth_booking_feed;
create view growth_booking_feed as
select
  id,
  created_at,
  status,
  env,
  jsonb_build_object(
    'when',         payload ->> 'when',
    'roommate',     payload ->> 'roommate',
    'listing_name', payload ->> 'listing_name'
  ) as payload
from booking_requests;

-- The student's name and phone are the point of a booking request;
-- marketing gets the count and the shape, not the contact.

drop view if exists growth_roommate_summary;
create view growth_roommate_summary as
with roommate_demands as (
  select
    id,
    created_at,
    status,
    (payload ->> 'matched_at')::timestamptz as matched_at
  from demand_records
  where payload ->> 'roommate' = 'yes'
    and env = 'production'
)
select
  count(*) as roommate_demands_total,
  count(*) filter (where status = 'matched') as matched_total,
  count(*) filter (where status = 'matched'
                     and matched_at is not null
                     and matched_at - created_at <= interval '14 days')
    as matched_within_14d,
  case
    when count(*) = 0 then 0
    else round(100.0 * count(*) filter (where status = 'matched'
                     and matched_at is not null
                     and matched_at - created_at <= interval '14 days')
               / count(*), 1)
  end as pct_matched_within_14d
from roommate_demands;

-- This is the definer twin of roommate_match_summary in
-- supabase-media-booking.sql. That one is security_invoker, so it is
-- admin-only by design; this one answers the same question for the
-- marketing role without granting it anything on demand_records.
-- CHANGE ONE, CHANGE THE OTHER — they must stay the same query, or
-- the growth panel and the Overview card start disagreeing.

-- Supabase's default privileges hand EVERY new relation — views
-- included — all privileges to anon and authenticated. Through a
-- definer view that would let any signed-in user UPDATE or DELETE
-- rows the view owner can reach, bypassing every policy above, so
-- strip both roles back to read-only. Identical reasoning to the
-- revoke at the bottom of supabase-public-view.sql.
revoke all on growth_demand_feed, growth_listing_feed, growth_scout_feed,
              growth_booking_feed, growth_roommate_summary
  from anon, authenticated;
grant  select on growth_demand_feed, growth_listing_feed, growth_scout_feed,
                 growth_booking_feed, growth_roommate_summary
  to authenticated;


-- ------------------------------------------------------------
-- 4. GRANTS — restated so this file is complete on its own
-- The public forms keep their insert-only path; this is the same
-- pair of statements as supabase-hardening.sql section 4, repeated
-- so a fresh editor session that runs only this file cannot leave
-- anon able to read a phone number.
-- ------------------------------------------------------------

revoke all on demand_records, listings, scout_submissions,
              booking_requests, support_tickets from anon;
grant  insert on demand_records, listings, scout_submissions,
                booking_requests, support_tickets to anon;

revoke all on amenities from anon;
grant  select on amenities to anon;


-- ------------------------------------------------------------
-- 5. CHECK IT WORKED
-- ------------------------------------------------------------

-- (a) The helper answers honestly even with no JWT at all. Run in the
--     SQL editor and expect 'anon': the editor has no signed token,
--     which is precisely why the real test is in a browser.
--
--   select public.arzuz_role() as role_without_a_token;

-- (b) No bare `authenticated` policy survived — every row below must
--     name a role in its `qual`/`with check` expression, or be the
--     anon insert with its state guard.
--
--   select tablename, policyname, cmd, roles::text
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('demand_records','listings','scout_submissions',
--                       'amenities','booking_requests','support_tickets')
--   order by tablename, cmd, policyname;

--     The demand_records set should read exactly:
--       anon            insert    (status = 'open')
--       admin           insert / select / update / delete
--       support         select
--     and NO row for marketing on any of the six tables.

-- (c) The real test, from the browser console on the live site, once
--     per login. Paste this after signing in (devtools → Console):
--
--   (async () => {
--     const API = ARZUZ_CONFIG.SUPABASE_URL + '/rest/v1/';
--     const h = await ArzuzAuth.headers();
--     const get = (t) => fetch(API + t, { headers: h }).then(r =>
--       r.status === 200 ? r.json() : ('HTTP ' + r.status));
--     console.log('role:', ArzuzAuth.role());
--     console.log('demand_records :', (await get('demand_records?select=id')).length);
--     console.log('growth feed    :', (await get('growth_demand_feed?select=id')).length);
--     console.log('bookings       :', (await get('booking_requests?select=id')).length);
--   })();
--
--     Marketing login → demand_records: 0, bookings: 0, growth feed: the
--     real count. Admin login → demand_records: the real count.
--     If marketing still sees demand rows, this file did not run.

-- (d) Re-running: everything above is idempotent. The function is
--     `create or replace`, the policies are swept and recreated, and
--     each view is dropped by name first:
--
--       drop view if exists growth_demand_feed;
--       drop view if exists growth_listing_feed;
--       drop view if exists growth_scout_feed;
--       drop view if exists growth_booking_feed;
--       drop view if exists growth_roommate_summary;
--
--     Dropping the views does NOT touch a single demand, listing,
--     booking, ticket or scout report — they are read surfaces.
