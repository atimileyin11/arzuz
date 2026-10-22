-- ============================================================
-- ARZUZ — the direct door is closed
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this LAST, after supabase-waitlist-launch.sql. Safe to run
-- more than once. It adds no table, no column, no policy and no
-- function: it removes five privileges, and that is the whole file.
--
-- WHY THIS FILE EXISTS
--
-- Until now there were TWO doors into the five public tables:
--
--   1. netlify/functions/waitlist.js — validates every answer on
--      the server, refuses a filled honeypot, throttles by address,
--      deduplicates, and mints the reference the person reads back.
--      It inserts with the SERVICE ROLE.
--
--   2. PostgREST, straight from the page, with the anon key that
--      ships in assets/config.js.
--
-- Door 2 was kept as a fallback so that a submission could never be
-- lost to a deploy order (the function answers 503 'not-ready' until
-- SUPABASE_SERVICE_ROLE_KEY is set, and assets/submit.js used to
-- fall back to the direct path when it did). That trade-off was
-- right while the door was new. It is wrong now, for a reason that
-- has nothing to do with how well the door works:
--
--   The row is inserted with the service role now, so it carries
--   columns that only the door can fill. `ref` comes from the
--   trigger. But `consent_text` — the exact sentence the person
--   agreed to — is written by the function, because a page that
--   sends its own consent text is a page that can send a different
--   one. A submission through door 2 therefore stores consent_at
--   and NOTHING to say what was agreed to, and no reference to read
--   out. Two doors means one of them produces rows the team cannot
--   audit and the student cannot quote.
--
--   And a fallback that only a broken deploy reaches is a fallback
--   that is never rehearsed. It was not exercised by any test that
--   drove a real submission; the code path was reason enough to
--   keep it, and reason is not evidence.
--
-- So the direct path is removed at BOTH ends, in one deliberate
-- step: the grants go here, and assets/submit.js stops carrying the
-- second door (see its header). Either alone is useless — a page
-- with no fallback still leaves the API open, and a closed API
-- leaves a page that quietly writes its queued rows into a 403.
--
-- WHAT THIS BREAKS, EXACTLY, AND WHY THAT IS FINE
--
--   · A browser holding the anon key can no longer INSERT into
--     demand_records, listings, scout_submissions, booking_requests
--     or support_tickets. That is every public form on the site.
--
--   · Nothing else changes. The service role is not touched — it
--     holds its own grant from Supabase's default privileges and
--     bypasses RLS — so the door keeps working. Admin writes go
--     through `authenticated` with a role policy and are untouched.
--     `amenities` is read by anon and is untouched. public_listings
--     is a view and is untouched.
--
--   · THIS FILE CANNOT BE RUN BEFORE THE DOOR EXISTS. That is the
--     first thing below, and it is the whole reason the guards in
--     this chain exist: closing door 2 on a database that has no
--     door 1 does not harden anything, it stops the site taking
--     submissions at all.
--
-- WHAT IS DELIBERATELY *NOT* DONE HERE
--
--   The `anon can submit …` INSERT policies are LEFT IN PLACE, and
--   the honeypot check inside them with them. They are now
--   unreachable — with no INSERT grant, RLS is never consulted — so
--   they cost nothing and they re-arm the honeypot in the same
--   instant somebody re-grants. Dropping them would be tidier to
--   read in pg_policies and strictly worse to operate: the guard
--   would have to be re-derived from memory by whoever needed it.
--   Section "CHECK IT WORKED" (c) asserts that they are still there,
--   so the tidying cannot happen by accident.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- Same contract as every other file in this chain: the SQL editor
-- runs a file as ONE transaction, so raising here leaves nothing
-- half-applied behind it.
--
-- Two guards, in the order the mistake would be made. The first is
-- about the privileges this file revokes (there must be something to
-- revoke FROM). The second is the load-bearing one, and it is why
-- this file is last in the chain rather than convenient: a database
-- with no waitlist_throttle() has no validated door, and closing the
-- door that does exist on that database would leave NO door.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.demand_records') is null
     or to_regclass('public.listings') is null
     or to_regclass('public.scout_submissions') is null
     or to_regclass('public.booking_requests') is null
     or to_regclass('public.support_tickets') is null then
    raise exception 'The public submission tables are missing. Run supabase-schema.sql, supabase-media-booking.sql and supabase-drafts-support.sql first — between them they create the five tables whose browser-facing grants this file revokes.';
  end if;

  if to_regprocedure('public.waitlist_throttle(text,text,integer,integer,integer)') is null then
    raise exception 'The waitlist door is missing. Run supabase-waitlist-launch.sql before this file — it builds the validated door (the reference registry, the throttle, the audit trail) that this file makes the ONLY way in. Closing the direct path without it leaves the site unable to take a submission at all.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE REVOKE
--
-- One statement, five tables, one role. `anon` is the only role a
-- browser can hold without signing in, and it is the role whose
-- privileges the whole public-form trade-off was made against.
--
-- Why it is INSERT alone and not `revoke all`:
--
--   The revokes that came before stripped anon back to insert-only
--   on exactly these five tables (supabase-hardening.sql section 4,
--   restated in supabase-team-roles.sql section 4). Insert is the
--   last privilege that was deliberately left, so insert is the one
--   this file takes away. Naming it keeps the file a record of the
--   decision rather than a sweep that would also hide a future
--   grant by someone who meant it.
--
--   The two grants anon still holds after this — USAGE on the
--   schema, and SELECT on amenities — are both deliberate and are
--   asserted below, so this file cannot be the reason a page loses
--   something it was meant to keep.
-- ------------------------------------------------------------

revoke insert on demand_records, listings, scout_submissions,
                 booking_requests, support_tickets
  from anon;


-- ------------------------------------------------------------
-- 2. CHECK IT WORKED
-- Run these in the SQL editor after the file commits. Each one is
-- expected to return the value in its comment.
-- ------------------------------------------------------------

-- (a) No browser-reachable key may insert into any of the five. The
--     pair of zeros is the whole point of the file; the pair of ones
--     on the right is the other half of it — the door inserts with
--     the service role, so revoking from anon must NOT have touched
--     it. If service_role reads 0 here, the door is broken and the
--     site is taking no submissions at all: check that Supabase's
--     default privileges still include service_role (they do on a
--     project created by Supabase; the ALTER DEFAULT PRIVILEGES
--     line names postgres, anon, authenticated AND service_role).
--
--   select 'anon'         as role, has_table_privilege('anon',         'demand_records', 'insert')::int as can_insert
--   union all
--   select 'service_role',          has_table_privilege('service_role', 'demand_records', 'insert')::int;
--
--     expect: anon 0 · service_role 1
--
--     Repeat for listings, scout_submissions, booking_requests and
--     support_tickets. The one-line version of the same question:
--
--   select t, has_table_privilege('anon', t, 'insert')::int as anon_can_insert
--   from unnest(array['demand_records','listings','scout_submissions',
--                     'booking_requests','support_tickets']) as t;
--
--     expect five rows, all 0.

-- (b) The privileges anon was ALWAYS meant to keep are still there.
--     Insert was never the only thing anon held, and a file called
--     "close the direct door" that also closed the public listings
--     page would be a much bigger change than it says it is.
--
--   select has_schema_privilege('anon', 'public', 'usage')::int    as schema_usage,
--          has_table_privilege('anon', 'amenities', 'select')::int as amenities_read;
--
--     expect: 1 · 1

-- (c) The anon insert policies survive, unreachable but armed. Five
--     rows, all still with an `hp` mention in the predicate — so if
--     anyone re-grants insert without thinking, the honeypot is
--     already in front of them and this file only removed the
--     second of two guards rather than the only one.
--
--   select tablename, policyname, cmd, roles::text
--   from pg_policies
--   where schemaname = 'public' and cmd = 'INSERT' and roles::text like '%anon%'
--   order by tablename;
--
--     expect: demand_records · listings · scout_submissions ·
--             booking_requests · support_tickets, one policy each.

-- (d) The door still works, end to end, after the revoke. This is
--     the only check that proves the site is still open for
--     business, and it needs the browser — the SQL editor has no
--     service key and no page. Submit one real registration from
--     the live register page and confirm it comes back with a
--     reference of the form ARZ-S-XXXX-XXXX-XXXX. A 502 with
--     "Arzuz could not save that just now" means the service role
--     lost a privilege it needed; a 503 'not-ready' means
--     SUPABASE_SERVICE_ROLE_KEY is not set in Netlify.
--
-- (e) Re-running: this file is idempotent by construction. A REVOKE
--     of a privilege that is already absent is a no-op, both guards
--     read existence only, and nothing here creates or drops an
--     object. Running it twice changes nothing — which
--     dev/sql-proof.mjs asserts by applying the whole chain twice
--     and fingerprinting the result.
