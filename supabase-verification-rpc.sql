-- ============================================================
-- ARZUZ — the verification decision, column-scoped
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this AFTER supabase-waitlist-launch.sql (it reads the
-- verified_at / verified_by columns that file adds) and after
-- supabase-team-roles.sql (the RPC decides who may call it with
-- public.arzuz_role(), and it withdraws a policy that file created).
-- Safe to run more than once. Nothing here drops a table, a column
-- or a row.
--
-- WHY THIS FILE EXISTS  — LAUNCH-READINESS.md, risk 2
--
--   A policy decides which ROWS a role may touch. It cannot decide
--   which COLUMNS, and for a while nobody pretended otherwise: the
--   `verification` role held an UPDATE policy on listings, so the
--   officer who is hired to answer "has anyone been to this room?"
--   could also change what the room costs. That was survivable only
--   because every change is written to staff_audit_log with the
--   column named — an audit trail that tells you what happened is
--   not the same thing as a door that only opens one way.
--
--   So the row-wide policy is WITHDRAWN and the decision moves into
--   a SECURITY DEFINER function that can only write four columns:
--
--       status, tier, verified_at, verified_by
--
--   That is not a narrowing for its own sake. Those four ARE the
--   verification act: `status` puts the apartment on the board,
--   `tier` says how far the check went, and `verified_at` /
--   `verified_by` are the record of who went and when — which is the
--   only thing on this site that answers a student asking "what
--   exactly did you check?". Nothing else about the row is the
--   officer's to change. The price, the owner's phone number, the
--   payload the landlord typed, the environment and the follow-up
--   pipeline all stay where they were.
--
--   RLS still does the row half, and it still does it per role: an
--   admin keeps its row-wide UPDATE policy (see
--   supabase-team-roles.sql section 2b) because an admin's job
--   includes the columns an officer's does not. What changed is that
--   the ONE role whose decision is a fixed, four-column act no
--   longer holds an unfixed one.
--
--   The audit trail still records the officer's write: the triggers
--   in supabase-waitlist-launch.sql fire for this UPDATE exactly as
--   they did for the row-wide one, because a trigger fires on the
--   statement and not on the key that issued it. What is inside the
--   function is all the trail can now be asked to describe.
--
-- WHY A POLICY IS DROPPED HERE RATHER THAN ONLY IN THE FILE ABOVE
--
--   supabase-team-roles.sql no longer creates
--   `verification can approve a listing`, so a fresh install never
--   has it. This file's drop is for the databases that do — every
--   install that ran an earlier version of that file — and it is
--   idempotent, so it is a no-op on the ones that never did. Both
--   halves are asserted in dev/sql-proof.mjs section 13d: the policy
--   must be absent whichever order the two files were run in, and
--   the RPC must be the only way a verification token writes a
--   listing at all.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- Three guards, in the order the three mistakes are made: a
-- database with no listings at all, one with the tables but no
-- role model (the RPC's own authorization reads it), and one that
-- ran everything except the launch migration — the state that
-- makes the two columns this file exists to write absent. The
-- last one is the interesting one: plpgsql does not resolve a
-- column until the function is first CALLED, so an install that
-- skipped supabase-waitlist-launch.sql would create this function
-- quite happily and then fail on the first officer who used it.
-- Checking here turns that into a message naming the file to run.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.listings') is null then
    raise exception 'public.listings is missing. Run supabase-schema.sql first — it creates listings, and this file narrows the write path to it.';
  end if;

  if to_regprocedure('public.arzuz_role()') is null then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql before this file — the function below decides who may verify a listing with it, and withdraws a policy that file builds.';
  end if;

  if exists (
    select 1
      from (values ('tier'), ('verified_at'), ('verified_by')) as need(col)
     where not exists (
       select 1
         from pg_attribute a
         join pg_class     c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'listings'
          and a.attname::text = need.col
          and a.attnum > 0
          and not a.attisdropped
     )
  ) then
    raise exception 'listings is missing the verification columns this file writes (tier, verified_at, verified_by). Run supabase-waitlist-launch.sql before this file.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE ROW-WIDE POLICY IS WITHDRAWN
--
-- By name, and only that one: the sweep in supabase-team-roles.sql
-- section 2 already clears the table's policies before rebuilding
-- them, and this file must not become a second place that decides
-- what the rest of the role model is.
--
-- What replaces it is NOT another policy. There is deliberately no
-- `verification can ... for update` line anywhere below, in this
-- file or in the one above: with no applicable rule a verification
-- token's PATCH of /rest/v1/listings matches zero rows, which is the
-- silence the role model gives marketing on every table. The write
-- it is allowed is the function in section 2, and the function is
-- the only thing it can call.
-- ------------------------------------------------------------

drop policy if exists "verification can approve a listing" on listings;


-- ------------------------------------------------------------
-- 2. THE DECISION
--
-- SECURITY DEFINER, because that is the whole mechanism: the
-- function runs as its owner, so the caller's own row privileges
-- are not what admits the UPDATE — the four columns listed in it
-- are. Every refusal it needs is inside it, because a grant to
-- `authenticated` is role-wide and says nothing about which
-- signed-in person is asking.
--
-- `set search_path = public, pg_temp` is not decoration on a
-- definer function: without it the caller's search_path applies to
-- the names resolved inside the body, which is how a definer
-- function becomes a way to run somebody else's `listings`.
--
-- The four columns it can move are named ONCE, below, and nowhere
-- else in the file. `coalesce` on status and tier is what makes a
-- call that only wants to stamp the verification (or only wants to
-- approve) possible without inventing a value for the other.
-- ------------------------------------------------------------

create or replace function public.listing_verify(
  p_id     uuid,
  p_status text    default null,
  p_tier   integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  me      text := public.arzuz_role();
  stamped text;
  after_row public.listings;
begin
  /* WHO MAY CALL IT. The grant is to `authenticated` — policies and
     grants are role-wide, and narrowing the grant to one role would
     mean a second role to keep in step with the vocabulary — so this
     is where the officer is actually decided, and it reads the claim
     the same way every policy in supabase-team-roles.sql does. An
     admin passes: an admin may already write the whole row, and the
     record of WHO verified is worth having when they do. */
  if me not in ('verification', 'admin') then
    raise exception 'listing_verify: a % login may not verify a listing. Approving one is the verification role''s decision, and an admin''s.', me
      using errcode = '42501';
  end if;

  /* THE ROW HAS TO EXIST. An UPDATE that matches nothing succeeds and
     returns nothing, so without this the caller would be told a
     listing was approved that was never touched. */
  perform 1 from public.listings where id = p_id;
  if not found then
    raise exception 'listing_verify: no listing with id %. Nothing was changed.', p_id
      using errcode = 'P0002';
  end if;

  /* THE VOCABULARY, refused here rather than trusted to the table.
     listings.status has no CHECK constraint of its own (the anon
     insert policies are what force 'pending' on the public path), so
     without this an officer could set a status no view filters on —
     a listing that is on no board and in no queue. */
  if p_status is not null
     and p_status not in ('draft', 'pending', 'active', 'rejected', 'inactive') then
    raise exception 'listing_verify: % is not a listing status. The vocabulary is draft, pending, active, rejected, inactive.', p_status
      using errcode = '22023';
  end if;

  if p_tier is not null and p_tier not between 0 and 2 then
    raise exception 'listing_verify: tier % is out of range. 0 is unverified, 1 is community-checked, 2 is inspected.', p_tier
      using errcode = '22023';
  end if;

  /* WHO STAMPED IT. The account, not a name typed into a box: the
     email GoTrue signs into the token when there is one, the subject
     when there is not, and the normalized role as the last resort so
     the column is never empty on a row that says it was verified. */
  stamped := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text, me);

  update public.listings
     set status      = coalesce(p_status, status),
         tier        = coalesce(p_tier, tier),
         verified_at = now(),
         verified_by = stamped
   where id = p_id
  returning * into after_row;

  return jsonb_build_object(
    'id',          after_row.id,
    'status',      after_row.status,
    'tier',        after_row.tier,
    'verified_at', after_row.verified_at,
    'verified_by', after_row.verified_by
  );
end $fn$;

comment on function public.listing_verify(uuid, text, integer) is
  'The verification decision, column-scoped: moves status, tier, verified_at and verified_by on one listing, and nothing else. Callable by the verification role and by an admin. Replaces the row-wide update policy, which would have let an approving officer change a listing''s price (LAUNCH-READINESS.md risk 2).';


-- ------------------------------------------------------------
-- 3. GRANTS — the door, and only the door
--
-- Supabase's default privileges grant EXECUTE on a new function
-- EXPLICITLY to anon and authenticated, so `revoke ... from public`
-- is not enough on its own — the same finding that made the throttle
-- and the reference minter revoke these two roles by name
-- (supabase-waitlist-launch.sql section 5). The difference here is
-- the grant that follows: `authenticated` MAY call it, and the role
-- check inside decides whether the call is allowed. An anon visitor
-- is refused by the grant, before the function ever runs.
-- ------------------------------------------------------------

revoke all on function public.listing_verify(uuid, text, integer) from public, anon;
grant  execute on function public.listing_verify(uuid, text, integer) to authenticated;


-- ------------------------------------------------------------
-- 4. CHECK IT WORKED
-- ------------------------------------------------------------

-- (a) The row-wide policy is gone. Expect ZERO rows — a row for
--     `verification` with cmd = 'UPDATE' on listings means this file
--     did not run, or ran before the file that creates it.
--
--   select tablename, policyname, cmd, roles::text
--   from pg_policies
--   where schemaname = 'public' and tablename = 'listings'
--   order by cmd, policyname;
--
--     listings should read: admin insert/select/update/delete, anon
--     insert, support select, verification select. No UPDATE row may
--     name verification.

-- (b) The function exists, is a definer, and pins its search_path.
--
--   select proname, prosecdef, proconfig from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'listing_verify';
--
--     prosecdef must be true and proconfig must contain
--     search_path=public, pg_temp.

-- (c) Only `authenticated` holds EXECUTE on it.
--
--   select has_function_privilege('anon', 'public.listing_verify(uuid,text,integer)', 'execute') as anon_may,
--          has_function_privilege('authenticated', 'public.listing_verify(uuid,text,integer)', 'execute') as authed_may;
--
--     anon_may must be false. authed_may true is correct: the role
--     check inside the function is what refuses the wrong officer.

-- (d) The real test, from the browser console signed in as the
--     verification login, once per release. Expect 200 with the
--     listing's new status/tier — and expect a row-wide PATCH of the
--     same listing to change NOTHING:
--
--   (async () => {
--     const API = ARZUZ_CONFIG.SUPABASE_URL + '/rest/v1/';
--     const h = await ArzuzAuth.headers();
--     const rpc = (body) => fetch(API + 'rpc/listing_verify', {
--       method: 'POST', headers: h, body: JSON.stringify(body)
--     }).then(r => r.status + ' ' + r.statusText);
--     console.log('approve :', await rpc({ p_id: '<a real listing id>', p_status: 'active', p_tier: 1 }));
--     console.log('price   :', await rpc({ p_id: '<the same id>', p_status: 'active', p_tier: 1, p_price: 1 }));
--   })();
--
--     The first answers 200. A PATCH of the same row (rather than the
--     RPC) answers 200 with an EMPTY array — zero rows matched, which
--     is RLS refusing it the only way it can — and the listing is
--     unchanged.

-- (e) Re-running: everything above is idempotent. The function is
--     `create or replace`, the policy drop is `if exists`, and no
--     data is touched. Running it twice changes nothing on the second
--     run but the function's own definition.
