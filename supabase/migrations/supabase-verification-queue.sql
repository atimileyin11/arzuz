-- ============================================================
-- ARZUZ — the verification shift: the queue, the claim, the trail
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this AFTER supabase-team-roles.sql (the functions below decide
-- who may call them with public.arzuz_role()) and AFTER
-- supabase-verification-rpc.sql (this is stage 2 of that file's
-- layer — the same listing, the decision it made possible, and the
-- shift that gets somebody to the door to make it). Safe to run more
-- than once. Nothing here drops a table, a column or a row.
--
-- WHY THIS FILE EXISTS  — LAUNCH-READINESS.md §8.2, stage 2
--
--   supabase-verification-rpc.sql made the verification DECISION
--   correct: an officer can move status, tier, verified_at and
--   verified_by and nothing else. What it did not do is make sure the
--   decision ever gets made. A tier-0 listing is live on the board
--   with a badge that says so, and nothing anywhere said that listing
--   was OWED a visit, by when, or by whom — so the answer to "has
--   anyone been to this room?" depended on somebody remembering.
--
--   Stage 2 is the shift:
--
--     · a QUEUE  — every live tier-0 listing, oldest-first, with the
--                  ones past their deadline on top (the ordering and
--                  the deadlines are assets/verification-queue.js,
--                  read by the dashboard and by the chaser);
--     · a CLAIM  — an officer TAKES a listing, which puts their
--                  account on it and starts their 48 hours;
--     · a TRAIL  — verification_events, append-only, so the chaser
--                  can tell "we have already said this" from "this is
--                  new lateness" without a flag on the row; and
--     · the RECLAIM — a job an officer took and went quiet on comes
--                  back to the queue, by the same door a release goes
--                  through, once the chaser has said so once.
--
--   None of that is a new kind of write. taking a listing would have
--   been a PATCH of `assigned_to`, which is exactly the row-wide write
--   supabase-verification-rpc.sql withdrew — so it is two more
--   COLUMN-SCOPED functions instead, moving `assigned_to` and
--   `taken_at` and nothing else. An officer still cannot change a
--   price, a phone number, `env`, or the payload a landlord typed.
--
-- WHY `assigned_to` AND A NEW `taken_at`
--
--   `assigned_to` already exists (supabase-waitlist-launch.sql) and is
--   already one of the columns the audit trigger watches on listings,
--   so a take lands in staff_audit_log as `assigned_to` moving, with the
--   acting role and the instant of the audit row itself. What it does
--   not carry is WHEN: the clock needs a start time per claim, and
--   reading it back out of the audit trail would be a per-listing query
--   against the biggest table here. So this file adds `taken_at`, which
--   only the two functions below can write — and the audit trigger's key
--   list is deliberately left alone rather than copied into this file: a
--   second copy of a trigger is how two files come to disagree about what
--   the trail records.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- The same three mistakes, in the same order as the RPC file: a
-- database with no listings, one with no role model (both functions
-- below authorize with public.arzuz_role()), and one that never ran
-- the launch migration — which matters here because this file's read
-- function returns verified_at / verified_by and its trail is
-- meaningless without the columns the DECISION writes. The last guard
-- is checked rather than assumed for the reason that file gives:
-- plpgsql resolves no column until the function is first called, so a
-- wrong install would work right up until the first officer used it.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.listings') is null then
    raise exception 'public.listings is missing. Run supabase-schema.sql first — it creates listings, which is the table this shift is about.';
  end if;

  if to_regprocedure('public.arzuz_role()') is null then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql before this file — every function below decides who may call it with it.';
  end if;

  if exists (
    select 1
      from (values ('assigned_to'), ('verified_at'), ('verified_by')) as need(col)
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
    raise exception 'listings is missing the columns this shift moves or reports (assigned_to, verified_at, verified_by). Run supabase-waitlist-launch.sql before this file.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE CLAIM'S START TIME
-- Added, never dropped, and written only by section 3. The default is
-- deliberately absent: a column that defaults to now() would make
-- every listing look claimed the moment it was created, which is the
-- one thing the clock must not be told.
-- ------------------------------------------------------------

alter table public.listings add column if not exists taken_at timestamptz;

create index if not exists idx_listings_queue
  on public.listings (status, tier, created_at)
  where tier = 0;

create index if not exists idx_listings_taken
  on public.listings (taken_at)
  where taken_at is not null;

comment on column public.listings.taken_at is
  'When the officer named in assigned_to took this listing for verification. Written only by public.listing_take() / public.listing_release(). The clock in assets/verification-queue.js measures the 48-hour visit deadline from it.';


-- ------------------------------------------------------------
-- 2. THE TRAIL
--
-- Append-only, and the reason it exists is one question the chaser
-- has to answer without a flag on the row: "have we already told the
-- team this listing is late?" A 'nudged' event IS that sentence, and a
-- listing that is nudged, released and taken again gets its own new
-- lateness because the newest nudge is older than the new claim —
-- which is the same rule netlify/functions/claims.js applies to its
-- own nudge, arrived at from this side.
--
-- `actor` is the account, resolved by the functions that write here
-- (the email GoTrue signs into the token when there is one, the
-- subject when there is not), so a line says who did it even after
-- that person's login is gone. `actor_id` is auth.uid() for the same
-- reason staff_audit_log keeps it.
--
-- No insert, update or delete policy: the functions are SECURITY
-- DEFINER and nothing else holds the grant. A trail a browser can
-- edit is not a trail.
-- ------------------------------------------------------------

create table if not exists public.verification_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  listing_id uuid not null,
  -- taken      an officer took the listing
  -- released   it went back to the queue (by them, by an admin, or by the chaser)
  -- nudged     the clock said it was late. Touches nothing else on purpose
  event      text not null check (event in ('taken', 'released', 'nudged')),
  actor      text,
  actor_id   uuid,
  actor_role text,
  note       text
);

alter table public.verification_events enable row level security;
revoke all on public.verification_events from anon, authenticated;
revoke all on sequence public.verification_events_id_seq from anon, authenticated;
grant  select on public.verification_events to authenticated;

create index if not exists idx_verification_events_listing
  on public.verification_events (listing_id, at desc);
create index if not exists idx_verification_events_at
  on public.verification_events (at desc);

drop policy if exists "admin can read the verification trail" on public.verification_events;
create policy "admin can read the verification trail"
  on public.verification_events for select to authenticated
  using (public.arzuz_role() = 'admin');

drop policy if exists "verification can read the verification trail" on public.verification_events;
create policy "verification can read the verification trail"
  on public.verification_events for select to authenticated
  using (public.arzuz_role() = 'verification');

comment on table public.verification_events is
  'Append-only trail of the verification shift: who took a listing, who gave it back, and what the clock said. Written only by the SECURITY DEFINER functions in supabase-verification-queue.sql; no key that reaches a browser can insert, change or delete a line.';


-- ------------------------------------------------------------
-- 3. THE THREE FUNCTIONS
--
-- One reader and two writers. All three are SECURITY DEFINER with a
-- pinned search_path, all three decide the caller INSIDE (a grant to
-- `authenticated` is role-wide and says nothing about which signed-in
-- person is asking), and none of them can write anything except the
-- columns named in it.
-- ------------------------------------------------------------

-- WHO SIGNED THIS. The account, not a name typed into a box — the same
-- resolution supabase-verification-rpc.sql uses for verified_by, kept
-- identical so an officer's claim and their approval carry the same
-- string for the same person.
create or replace function public.arzuz_actor()
returns text
language sql
stable
as $$
  select coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text, public.arzuz_role());
$$;

revoke execute on function public.arzuz_actor() from public, anon;
grant  execute on function public.arzuz_actor() to authenticated;


-- ------------------------------------------------------------
-- 3a. THE QUEUE, READ
--
-- The read half, and it is a FUNCTION rather than a view on purpose:
-- a view over listings would carry the whole row, and the whole row is
-- the owner's payload — their phone number, their typed-in words. An
-- officer needs to know WHAT to go and look at and whether anybody
-- already has it, not the owner's details, so the reveal is built from
-- a fixed column list here. A page cannot widen it and a future column
-- cannot leak into it by being added to the table.
--
-- `stage_since` is the honest start of the CURRENT stage, and it is
-- the one thing here the row alone cannot say: a listing that was
-- taken, released and left sitting came back to the queue at the
-- moment it was released, not when it was created. The trail knows
-- that, so this reads it — newest 'taken'/'released' event first,
-- falling back to created_at for a listing nobody has ever touched.
-- ------------------------------------------------------------

create or replace function public.verification_queue()
returns table (
  id            uuid,
  ref           text,
  apt_id        text,
  area          text,
  status        text,
  tier          integer,
  taken_by      text,
  taken_at      timestamptz,
  created_at    timestamptz,
  stage         text,
  stage_since   timestamptz,
  scout_reports integer,
  last_nudged_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  me text := public.arzuz_role();
begin
  if me not in ('verification', 'admin') then
    raise exception 'verification_queue: a % login may not read the verification queue. It is the verification role''s shift, and an admin''s.', me
      using errcode = '42501';
  end if;

  return query
    with open_listings as (
      /* apt_id is NOT a column — it lives in the payload, which is where
         the form engine and complete-listing.js put it, and it is the key a
         scout report matches on below. Selecting it as l.apt_id is the
         mistake this comment exists to stop somebody making twice. */
      select l.id, l.ref, l.payload, l.status, l.tier,
             l.assigned_to, l.taken_at, l.created_at
        from public.listings l
       where coalesce(l.tier, 0) = 0
         and lower(coalesce(l.status, '')) in ('pending', 'active', 'new')
    ),
    shifts as (
      /* The newest event that MOVED the listing, per listing. A 'nudged'
         event is about a stage rather than a move between stages, so it
         is filtered out here — the clock must not buy a job another
         deadline by being talked about. */
      select distinct on (e.listing_id) e.listing_id, e.at, e.event
        from public.verification_events e
       where e.event in ('taken', 'released')
       order by e.listing_id, e.at desc
    ),
    nudges as (
      select e.listing_id, max(e.at) as at
        from public.verification_events e
       where e.event = 'nudged'
       group by e.listing_id
    ),
    scouts as (
      /* Field evidence already on file for this property — the officer
         reads it before driving anywhere. Matched on the payload's own
         apt id, because that is what a scout report carries. */
      select s.payload ->> 'apt_ref' as apt_ref, count(*) as n
        from public.scout_submissions s
       where s.payload ? 'apt_ref'
       group by 1
    )
    select o.id,
           o.ref,
           o.payload ->> 'apt_id',
           coalesce(o.payload ->> 'area', o.payload ->> 'ar'),
           o.status,
           coalesce(o.tier, 0),
           o.assigned_to,
           o.taken_at,
           o.created_at,
           case when o.assigned_to is not null and o.assigned_to <> '' then 'visit' else 'queue' end,
           coalesce(sh.at, o.created_at),
           coalesce(sc.n, 0)::integer,
           nu.at
      from open_listings o
      left join shifts sh on sh.listing_id = o.id
      left join nudges nu on nu.listing_id = o.id
      left join scouts sc on sc.apt_ref = o.payload ->> 'apt_id'
     order by
       /* Late first is the DASHBOARD's job (assets/verification-queue.js
          owns the ordering, because lateness is a computation and not a
          column). What this orders is the tie the database can see: the
          oldest shift first, so a page of the queue in the SQL editor and
          a page of it on screen agree about where to start. */
       coalesce(sh.at, o.created_at) asc
     limit 500;
end $fn$;

comment on function public.verification_queue() is
  'The verification shift, read only: every live tier-0 listing with who holds it, when the current stage started and whether the clock has already spoken about it. Returns a fixed column list — never the owner payload. Callable by the verification role and by an admin (LAUNCH-READINESS.md §8.2, stage 2).';


-- ------------------------------------------------------------
-- 3b. TAKE IT
--
-- The claim. Two refusals that matter, and both are refusals of things
-- that would otherwise be silent:
--
--   a listing somebody else already holds — taking it anyway would give
--   two people the same 48 hours and one of them a wasted drive. The
--   holder is named in the message so the second officer knows who to
--   ask rather than guessing.
--
--   a listing that is already DECIDED — an officer should not be able
--   to start a shift on a room that has been ruled on and quietly put
--   it back on somebody's list.
--
-- No admin override on the first: an admin who needs it can wait for
-- the release, and a function that can take a job out of somebody's
-- hands is a function two officers will end up arguing about.
-- ------------------------------------------------------------

create or replace function public.listing_take(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  me      text := public.arzuz_role();
  who     text := public.arzuz_actor();
  listing public.listings;
begin
  if me not in ('verification', 'admin') then
    raise exception 'listing_take: a % login may not take a listing for verification. It is the verification role''s shift, and an admin''s.', me
      using errcode = '42501';
  end if;

  select * into listing from public.listings where id = p_id;
  if not found then
    raise exception 'listing_take: no listing with id %. Nothing was changed.', p_id
      using errcode = 'P0002';
  end if;

  if coalesce(listing.tier, 0) > 0 then
    raise exception 'listing_take: that listing has already been decided (tier %). Nothing was changed.', listing.tier
      using errcode = '22023';
  end if;

  if coalesce(listing.assigned_to, '') <> '' and listing.assigned_to <> who then
    raise exception 'listing_take: % already has that listing. Ask them to release it rather than starting a second visit.', listing.assigned_to
      using errcode = '22023';
  end if;

  update public.listings
     set assigned_to = who,
         taken_at    = now()
   where id = p_id
  returning * into listing;

  insert into public.verification_events (listing_id, event, actor, actor_id, actor_role)
  values (p_id, 'taken', who, auth.uid(), me);

  return jsonb_build_object(
    'id', listing.id, 'stage', 'visit',
    'taken_by', listing.assigned_to, 'taken_at', listing.taken_at
  );
end $fn$;

comment on function public.listing_take(uuid) is
  'Takes one listing for verification: sets assigned_to and taken_at and nothing else. Refuses a listing another officer already holds, and one that has already been decided (LAUNCH-READINESS.md §8.2, stage 2).';


-- ------------------------------------------------------------
-- 3c. GIVE IT BACK
--
-- The release, and it has two callers: the officer who cannot get there
-- after all, and the CHASER, which runs with the service role and gives
-- back a job nobody came back on. Both write the same event with the
-- same columns, so the trail cannot tell a clean handover from a
-- reclaim by anything except its note — which is exactly right, because
-- the listing's story is "it is back in the queue", and the note is
-- where the reason belongs.
--
-- An officer may only release what they hold; an admin may release
-- anything, because the alternative is a job stuck on somebody's name
-- who has left.
-- ------------------------------------------------------------

create or replace function public.listing_release(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  me      text := public.arzuz_role();
  who     text := public.arzuz_actor();
  listing public.listings;
begin
  /* The service role is the CHASER: netlify/functions/verification-aging.js
     runs as service_role (there is no signed-in officer at 6am), and it
     is the one caller that is not a person. It is admitted here and
     nowhere else in this file, and the trail records it as such. */
  if me not in ('verification', 'admin', 'service_role') then
    raise exception 'listing_release: a % login may not release a listing.', me
      using errcode = '42501';
  end if;

  select * into listing from public.listings where id = p_id;
  if not found then
    raise exception 'listing_release: no listing with id %. Nothing was changed.', p_id
      using errcode = 'P0002';
  end if;

  if coalesce(listing.assigned_to, '') = '' then
    raise exception 'listing_release: that listing is not held by anybody — it is already in the queue. Nothing was changed.'
      using errcode = '22023';
  end if;

  if me = 'verification' and listing.assigned_to <> who then
    raise exception 'listing_release: % holds that listing, not you. An admin can release it.', listing.assigned_to
      using errcode = '42501';
  end if;

  update public.listings
     set assigned_to = null,
         taken_at    = null
   where id = p_id
  returning * into listing;

  insert into public.verification_events (listing_id, event, actor, actor_id, actor_role, note)
  values (p_id, 'released', who, auth.uid(), me, nullif(left(coalesce(p_note, ''), 300), ''));

  return jsonb_build_object('id', listing.id, 'stage', 'queue',
    'released_by', who, 'note', p_note);
end $fn$;

comment on function public.listing_release(uuid, text) is
  'Gives one listing back to the queue: clears assigned_to and taken_at and nothing else. An officer may release what they hold, an admin anything, and the scheduled chaser is the service role (LAUNCH-READINESS.md §8.2, stage 2).';


-- ------------------------------------------------------------
-- 3d. SAY IT
--
-- The chaser's own line, and the reason it is a function rather than
-- the chaser's SELECT: this is the record that decides whether the
-- NEXT run speaks again. It touches no listing at all — a nudge is a
-- message, not a state change, and a function that could move the row
-- as well as talk about it is one that will eventually be used for
-- both.
--
-- service_role only. An officer's nudge would be them talking to
-- themselves, and staff_audit_log already records everything a person
-- does to a listing.
-- ------------------------------------------------------------

create or replace function public.verification_nudge(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  me text := public.arzuz_role();
  stamped timestamptz;
begin
  if me <> 'service_role' then
    raise exception 'verification_nudge: a % login may not write to the verification trail. The clock that chases the queue is the only caller.', me
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.listings where id = p_id) then
    raise exception 'verification_nudge: no listing with id %. Nothing was changed.', p_id
      using errcode = 'P0002';
  end if;

  insert into public.verification_events (listing_id, event, actor, actor_id, actor_role, note)
  values (p_id, 'nudged', 'the verification clock', null, me,
          nullif(left(coalesce(p_note, ''), 300), ''))
  returning at into stamped;

  return jsonb_build_object('id', p_id, 'event', 'nudged', 'at', stamped);
end $fn$;

comment on function public.verification_nudge(uuid, text) is
  'Records that the verification clock has said one listing is late. Writes to the trail and touches no listing — it is what makes the next run quiet about the same lateness (LAUNCH-READINESS.md §8.2, stage 2).';


-- ------------------------------------------------------------
-- 4. GRANTS — the door, and only the door
--
-- Supabase grants EXECUTE on a new function explicitly to anon and
-- authenticated, so `revoke ... from public` is not enough on its own
-- (the same finding supabase-waitlist-launch.sql section 5 records).
-- The reader and the two claim functions are revoked from anon and
-- granted to authenticated, where the role check inside decides the
-- rest. The chaser's function is service_role ONLY: no browser may
-- write to the trail.
-- ------------------------------------------------------------

revoke all on function public.verification_queue() from public, anon;
grant  execute on function public.verification_queue() to authenticated;

revoke all on function public.listing_take(uuid) from public, anon;
grant  execute on function public.listing_take(uuid) to authenticated;

revoke all on function public.listing_release(uuid, text) from public, anon;
grant  execute on function public.listing_release(uuid, text) to authenticated;

revoke all on function public.verification_nudge(uuid, text) from public, anon, authenticated;
grant  execute on function public.verification_nudge(uuid, text) to service_role;


-- ------------------------------------------------------------
-- 5. CHECK IT WORKED
-- ------------------------------------------------------------
--
-- (a) The queue, as the officer's login. Expect the live tier-0
--     listings and NO payload column:
--
--   select * from public.verification_queue();
--
-- (b) The claim, and its two refusals. From a browser console signed
--     in as the verification login:
--
--   (async () => {
--     const rpc = (name, body) => fetch(ARZUZ_CONFIG.SUPABASE_URL + '/rest/v1/rpc/' + name, {
--       method: 'POST', headers: await ArzuzAuth.headers(), body: JSON.stringify(body)
--     }).then(async r => r.status + ' ' + (await r.text()).slice(0, 160));
--     console.log('take   :', await rpc('listing_take', { p_id: '<a real tier-0 listing id>' }));
--     console.log('again  :', await rpc('listing_take', { p_id: '<the same id>' }));   -- idempotent for the same officer
--     console.log('release:', await rpc('listing_release', { p_id: '<the same id>', p_note: 'could not get there today' }));
--   })();
--
--     Both take calls answer 200 for the SAME officer (it is their own
--     claim either way); a DIFFERENT officer gets 22023 with the first
--     one's account named. A release of something nobody holds is
--     refused, which is what stops the chaser's reclaim racing a person.
--
-- (c) The column scope, which is the whole point: after a take, the
--     price has not moved.
--
--   select id, assigned_to, taken_at, listed_price_ngn, status, tier
--     from public.listings where id = '<the same id>';
--
-- (d) The trail, and who may read it. As the officer, expect the lines
--     this file wrote and nothing else; as `anon`, expect zero rows.
--
--   select at, event, actor_role, actor, note from public.verification_events
--    order by at desc limit 20;
--
-- (e) Re-running: everything above is idempotent. The table and the
--     columns are `if not exists`, the functions are `create or
--     replace`, and no data and no policy is deleted except the two
--     named policies this file creates again.
