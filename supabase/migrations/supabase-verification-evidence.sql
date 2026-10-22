-- ============================================================
-- ARZUZ — the verification layer, stage 3: what the visit SAW
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this AFTER supabase-verification-queue.sql (stage 2). Safe to
-- run more than once. Nothing here drops a table, a column or a row.
--
-- WHY THIS FILE EXISTS — LAUNCH-READINESS.md §8.2, stage 3
--
--   Stage 1 could say "this room has not been checked". Stage 2 could
--   say "somebody is owed a visit, by when". Neither could answer the
--   only question a student actually asks at the door of a room:
--
--       WHAT exactly did you check?
--
--   Until now the honest answer was a person's recollection and a
--   tier number. "Inspected" was a word with no parts. This file gives
--   it parts:
--
--     · EVIDENCE — one row per check, grouped into a VISIT, so the
--       badge can name water pressure, power, the photos, the price
--       and the way in, and say when each was seen and when it stops
--       being current;
--     · an ATTESTATION — listing_attest() records the visit and makes
--       the decision (tier 2, active, verified_at/by) in ONE
--       transaction, so an "Inspected" listing cannot exist in the
--       database without the checks that earned the word;
--     · a PUBLIC READ — public_listing_checks exposes the check name,
--       the officer's sentence, the date and the expiry of listings
--       that are already on the public board, and nothing else. Not
--       the officer's account, not a row for a draft, not a way to
--       write.
--
--   What a check ISN'T: this is not an inspection certificate and it
--   is not a promise about next month. Every row expires 180 days
--   after the visit, and the badge says so. A student reading it knows
--   exactly how old the evidence is — which is the point. A badge that
--   never ages is a badge nobody can trust.
--
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON listings
--
--   A visit is one-to-many with its checks, and a listing is one-to-many
--   with its visits. Columns would force one check and one visit, which
--   is the shape that quietly becomes "we ticked a box". A row per check
--   also means the trail is append-only: a re-visit ADDS a visit, it
--   never edits what was said last time. `verification_events` already
--   records the SHIFT (taken, released, nudged); this records what was
--   SEEN, which is a different fact and deserves a different table.
--
-- WHO MAY WRITE
--
--   Nobody with a browser key. The table has RLS on and no INSERT,
--   UPDATE or DELETE policy at all, and anon/authenticated are revoked
--   by name (Supabase grants new relations ALL by default). The only
--   writer is public.listing_attest(), SECURITY DEFINER, which admits
--   the verification role and an admin — the same two logins that may
--   approve a listing — and refuses everybody else before it reads a
--   row.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- The same three mistakes in the same order as the two files below
-- this one, plus the one that is new: this file calls public.
-- listing_verify() and inserts into a trail the queue file creates,
-- so it has TWO prerequisites above it rather than one. Naming the
-- wrong one costs an operator a file run in the right order.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.listings') is null then
    raise exception 'public.listings is missing. Run supabase-schema.sql first — it creates listings, and a visit is about a listing.';
  end if;

  if to_regprocedure('public.arzuz_role()') is null then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql before this file — every function below decides who may call it with it.';
  end if;

  /* Both halves of the shift are required, and they live in two files:
     the queue file creates the trail, the RPC file creates the decision
     this file calls. Checking one and assuming the other would let a
     database pass this preflight and then fail on the first officer. */
  if to_regclass('public.verification_events') is null
     or to_regprocedure('public.listing_verify(uuid,text,integer)') is null then
    raise exception 'The verification shift is missing. Run supabase-verification-queue.sql and supabase-verification-rpc.sql before this file — the trail and the decision it builds on are theirs.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE EVIDENCE
-- One row per check, grouped by visit_id. Append-only by grant and by
-- policy: there is no update path and no delete path, for anybody.
-- ------------------------------------------------------------

create table if not exists public.listing_evidence (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,

  /* One visit is several checks. A uuid, not a foreign key: this file
     deliberately does not add a table whose only job is to hold a
     timestamp the evidence rows already carry. */
  visit_id    uuid not null,

  /* A closed vocabulary, enforced here as well as in the function.
     The labels a student reads live in assets/verification-badge.js;
     the check that the two lists agree is scripts/test-verification-
     badge.mjs, which reads this constraint. A new kind has to be
     added in both places or the build says so. */
  kind        text not null
              check (kind in ('water', 'power', 'photos', 'price', 'access', 'security')),

  /* The officer's own sentence about what they saw. Optional, because
     "water pressure at the kitchen tap" with no note is still a check;
     bounded, because this is rendered into a public page and escaped,
     and an unbounded field is one somebody will paste a landlord's
     phone number into. */
  detail      text
              check (detail is null or char_length(detail) between 1 and 200),

  checked_at  timestamptz not null,
  /* Six months. Written by the function, never by the caller: a badge
     whose expiry the person being checked can choose is decoration. */
  expires_at  timestamptz not null,

  /* Who said so. The account, for the record — the public view does
     not expose either of these. */
  officer     text not null,
  officer_id  uuid,
  created_at  timestamptz not null default now(),

  constraint listing_evidence_window_check check (expires_at > checked_at)
);

alter table public.listing_evidence enable row level security;

/* Supabase's default privileges hand every new table ALL privileges to
   anon and authenticated. Strip them by name, then grant back exactly
   one thing: a read, to a signed-in officer or admin. */
revoke all on public.listing_evidence from anon, authenticated;
grant  select on public.listing_evidence to authenticated;

drop policy if exists "admin can read every visit" on public.listing_evidence;
create policy "admin can read every visit"
  on public.listing_evidence for select to authenticated
  using (public.arzuz_role() = 'admin');

drop policy if exists "verification can read the visits" on public.listing_evidence;
create policy "verification can read the visits"
  on public.listing_evidence for select to authenticated
  using (public.arzuz_role() = 'verification');

/* No INSERT, UPDATE or DELETE policy exists, deliberately. RLS with no
   permissive policy refuses every row to every browser key, and the
   revoke above refuses the statement before RLS is even consulted. */

create index if not exists idx_listing_evidence_listing
  on public.listing_evidence (listing_id, checked_at desc);
create index if not exists idx_listing_evidence_visit
  on public.listing_evidence (visit_id);

comment on table public.listing_evidence is
  'Append-only record of what a verification visit actually checked, one row per check, grouped by visit_id. Written only by public.listing_attest(); no key that reaches a browser can insert, change or delete a line. Publicly readable through public_listing_checks for listings already on the board (LAUNCH-READINESS.md §8.2, stage 3).';
comment on column public.listing_evidence.expires_at is
  'The moment this check stops being current: 180 days after the visit, written by the function. The public badge compares it with now() and says "re-check due" rather than implying the visit is still recent.';
comment on column public.listing_evidence.visit_id is
  'Groups the checks made on one visit. A re-visit adds a new group instead of editing the last one, so the trail keeps what was said the first time.';


-- ------------------------------------------------------------
-- 2. THE PUBLIC READ — what the badge is allowed to know
--
-- A definer view (the default), for the same reason public_listings
-- is one: anon holds no SELECT on listings, and a security_invoker
-- view would fail with "permission denied" for the website. What it
-- exposes is a fixed column list, and the join is the guard that
-- matters: evidence for a draft, a rejected or a tier-0 listing is
-- invisible, because nothing is on the board to put a badge on.
--
-- officer / officer_id are NOT here. A student needs to know what was
-- checked and when; the person's account is the team's record.
-- ------------------------------------------------------------

create or replace view public.public_listing_checks as
select
  e.listing_id,
  e.visit_id,
  e.kind,
  e.detail,
  e.checked_at,
  e.expires_at
from public.listing_evidence e
join public.listings l on l.id = e.listing_id
where l.status = 'active'
  and l.tier >= 1
  and l.env = 'production';

revoke all on public.public_listing_checks from anon, authenticated;
grant  select on public.public_listing_checks to anon, authenticated;

comment on view public.public_listing_checks is
  'The checks behind a public badge: kind, the officer''s sentence, when it was seen and when it expires, for listings that are already on the public board. Never the officer''s account, never a row for a draft (LAUNCH-READINESS.md §8.2, stage 3).';


-- ------------------------------------------------------------
-- 3. THE ATTESTATION — the visit becomes the decision
--
-- This is stage 2's listing_verify() plus evidence, in one
-- transaction. It is deliberately a CALL to that function rather than
-- a second copy of its update: the decision already has one
-- implementation, and a second one is how "approved" comes to mean
-- two different things depending on which button was pressed.
--
-- If the decision refuses (a role that may not verify, a row that
-- vanished), the whole function rolls back — plpgsql wraps it in one
-- transaction — so a refused visit cannot leave evidence behind.
-- ------------------------------------------------------------

create or replace function public.listing_attest(
  p_id     uuid,
  p_checks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  me      text := public.arzuz_role();
  who     text;
  visit   uuid := gen_random_uuid();
  at      timestamptz := now();
  item    jsonb;
  k       text;
  n       integer := 0;
  decision jsonb;
begin
  /* WHO MAY CALL IT. The grant is to `authenticated` — grants are
     role-wide — so this is where the officer is actually decided, the
     same way listing_verify() decides it. An admin passes for the same
     reason: an admin may already write the row, and the record of who
     went is worth having when they do. */
  if me not in ('verification', 'admin') then
    raise exception 'listing_attest: a % login may not record a visit. Going to the door is the verification role''s job, and an admin''s.', me
      using errcode = '42501';
  end if;

  /* THE ROW HAS TO EXIST. An insert against a stale id would raise the
     foreign key's error, which names a constraint and not a listing. */
  perform 1 from public.listings where id = p_id;
  if not found then
    raise exception 'listing_attest: no listing with id %. Nothing was changed.', p_id
      using errcode = 'P0002';
  end if;

  /* AT LEAST ONE CHECK, AT MOST EIGHT. Zero is the failure this whole
     file exists to prevent: a tier-2 badge with no parts. Eight is a
     shape limit, not a rule about thoroughness — a visit with more
     than eight distinct findings belongs in the note as well. */
  if p_checks is null
     or jsonb_typeof(p_checks) <> 'array'
     or jsonb_array_length(p_checks) < 1
     or jsonb_array_length(p_checks) > 8 then
    raise exception 'listing_attest: a visit records between 1 and 8 checks. An "Inspected" badge with nothing behind it is the thing this file exists to stop.'
      using errcode = '22023';
  end if;

  /* WHO SAID SO. The account, not a name typed into a box — the same
     rule listing_verify() uses, so the trail and the listing agree. */
  who := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text, me);

  for item in select * from jsonb_array_elements(p_checks) loop
    k := lower(btrim(coalesce(item ->> 'kind', '')));
    if k not in ('water', 'power', 'photos', 'price', 'access', 'security') then
      raise exception 'listing_attest: % is not a check we can publish. The vocabulary is water, power, photos, price, access, security.',
        coalesce(nullif(k, ''), '(none)')
        using errcode = '22023';
    end if;

    insert into public.listing_evidence
      (listing_id, visit_id, kind, detail, checked_at, expires_at, officer, officer_id)
    values
      (p_id, visit, k,
       nullif(left(btrim(coalesce(item ->> 'detail', '')), 200), ''),
       at, at + interval '180 days', who, auth.uid());

    n := n + 1;
  end loop;

  /* THE DECISION. If this raises, everything above is rolled back with
     it — the evidence and the decision are one act, not two.

     Three arguments and not four: listing_verify() has no note, and
     that is deliberate — the words an officer writes belong on the
     CHECK they are about, where the badge can print them, rather than
     in a visit-level paragraph nobody reads. */
  decision := public.listing_verify(p_id, 'active', 2);

  return decision || jsonb_build_object('visit_id', visit, 'checks', n, 'expires_at', at + interval '180 days');
end $fn$;

comment on function public.listing_attest(uuid, jsonb) is
  'Records one visit: 1–8 named checks with the officer''s own sentences, then makes the decision through public.listing_verify() — all in one transaction, so a tier-2 "Inspected" listing cannot exist without the evidence that earned it. Callable by the verification role and by an admin (LAUNCH-READINESS.md §8.2, stage 3).';


-- ------------------------------------------------------------
-- 4. GRANTS — the door, and only the door
-- Supabase grants EXECUTE on a new function explicitly to anon and
-- authenticated, so revoking from PUBLIC alone is not enough — the
-- same finding as the throttle and listing_verify().
-- ------------------------------------------------------------

revoke all on function public.listing_attest(uuid, jsonb) from public, anon;
grant  execute on function public.listing_attest(uuid, jsonb) to authenticated;


-- ------------------------------------------------------------
-- 5. CHECK IT WORKED
-- ------------------------------------------------------------

-- (a) The table refuses a browser key. Expect 0 for each.
--
--   select has_table_privilege('anon', 'public.listing_evidence', 'select')          as anon_reads,
--          has_table_privilege('anon', 'public.listing_evidence', 'insert')          as anon_writes,
--          has_table_privilege('authenticated', 'public.listing_evidence', 'update') as officer_updates;
--
-- (b) The public view answers, and only for board listings.
--
--   select * from public.public_listing_checks limit 5;
--
-- (c) The function exists, is a definer, and pins its search_path.
--
--   select proname, prosecdef, proconfig from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'listing_attest';
--
-- (d) The real test, from the dashboard signed in as the verification
--     login: take a listing, then record a visit with two checks. It
--     answers with the listing's new tier and a visit_id, and the
--     public view names both checks.
--
-- (e) Re-running: `create table if not exists`, `create or replace`
--     view/function, `drop policy if exists`. No row is touched.
