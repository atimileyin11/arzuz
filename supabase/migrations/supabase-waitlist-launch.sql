-- ============================================================
-- ARZUZ — the launch waitlist: reference, consent, pipeline, audit
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this LAST, after supabase-team-roles.sql and everything it
-- depends on. Safe to run more than once. Nothing here drops a table,
-- a column or a row: it adds columns, constraints, one registry, one
-- guard table, one audit table and the triggers that keep them honest.
--
-- WHY THIS FILE EXISTS
--
-- Arzuz is opening in a week and the waitlist is the product until
-- there is a product. Four things a launch waitlist has to be able to
-- answer, and the database could not answer any of them before:
--
--   1. "I filled your form, what is my number?" — the site had a
--      client_ref, a UUID minted in the browser for retry safety. It
--      is the right thing for a machine and a useless thing for a
--      person on WhatsApp. `ref` is the same submission with a short,
--      speakable handle, minted SERVER-side (see the trigger at the
--      bottom) so a row can never arrive with one of its own choosing.
--
--   2. "Did they agree to be contacted?" — consent was implied by
--      pressing submit and recorded nowhere. `consent_at` and
--      `consent_text` record both the moment and the exact sentence
--      agreed to, because the sentence will change and the old
--      submissions must still say what they actually agreed to.
--
--   3. "Who is working this one, and where is it up to?" — the team
--      was keeping that in WhatsApp. `follow_up_status` and
--      `assigned_to` move it into the row.
--
--   4. "Who changed that?" — nothing recorded a staff action at all.
--      `staff_audit_log` is written by a trigger, not by the page, so
--      an action taken through any path at all lands in it.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No passwords, no password hashes, no auth users. The public forms
-- never collect a password and this file never stores one — sign-in
-- is Supabase Auth's job (assets/auth.js) and the waitlist is not an
-- account. `linked_user_id` is the SEAM for that future account: a
-- waitlist row can be pointed at an authenticated user once that user
-- has been verified to control the row's email or phone, and this
-- file does not decide how. See LAUNCH-READINESS.md §6.
--
-- TWO STATUS COLUMNS, ON PURPOSE
--
-- `status` already existed and is load-bearing: demand_summary reads
-- status = 'open', the roommate summary reads status = 'matched', the
-- public listings view reads status = 'active', the dashboard's
-- filters and the growth feeds are all keyed on it. It is the STATE
-- of the record. `follow_up_status` is the PIPELINE: new → contacted
-- → interested → matched → closed, which is what a person working the
-- list actually needs and what the spec names. Replacing one with the
-- other on the week of launch would touch every view, filter and test
-- that reads `status`. They are reconciled in the backfill below and
-- unifying them is a post-launch task, listed in LAUNCH-READINESS.md.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- Same contract as every other file in this chain: the SQL editor
-- runs a file as ONE transaction, so raising here leaves nothing
-- half-applied behind it.
--
-- The role model is not optional here. Every policy at the bottom is
-- scoped by public.arzuz_role(), and the audit trigger records it —
-- an install that skipped supabase-team-roles.sql would otherwise
-- build a trail whose actor column is a guess.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.demand_records') is null
     or to_regclass('public.listings') is null then
    raise exception 'A waitlist table is missing. Run supabase-schema.sql first — it creates demand_records and listings, which this file extends with the launch columns.';
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'arzuz_role'
  ) then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql before this file — the audit trail records the acting role, and every policy below is scoped by it.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE REFERENCE REGISTRY
--
-- One table, one primary key, both waitlist sides. A per-table unique
-- index would make a reference unique within demand_records and
-- separately unique within listings — which is not what a handle
-- needs to be. A single registry means `ARZ-S-4F7A-2C9B-1D3E` names
-- exactly one row anywhere in the system, so a support agent can be
-- given one string and resolve it, and a future "check my status"
-- page has a key to look up.
--
-- RLS is on with NO policy and every privilege revoked: this table is
-- written by the SECURITY DEFINER trigger below and read by nothing
-- a browser can reach. The service role bypasses RLS and can audit it.
-- ------------------------------------------------------------

create table if not exists public.waitlist_ref_registry (
  ref        text primary key,
  kind       text not null,
  created_at timestamptz not null default now()
);

alter table public.waitlist_ref_registry enable row level security;
revoke all on public.waitlist_ref_registry from anon, authenticated;

comment on table public.waitlist_ref_registry is
  'Every reference handed out, one row each. The primary key IS the uniqueness guarantee for ref on demand_records and listings.';

/* The readable part of a reference. Twelve hex characters taken from
   two fresh UUIDs: 48 bits, ~2.8e14 values. At 100,000 waitlist rows
   the birthday probability of a single collision is ~1.8e-5, and a
   collision is not a failure anyway — the registry primary key
   refuses the duplicate and the trigger mints another. That is the
   whole reason the registry exists rather than a hope and an index.

   Grouped 4-4-4 because this gets read aloud over a phone call. */
create or replace function public.arzuz_ref_token(p_letter text)
returns text
language sql
volatile
as $$
  select 'ARZ-' || upper(left(p_letter, 1)) || '-'
         || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) || '-'
         || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) || '-'
         || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
$$;

/* `from public, anon, authenticated` — and the two named roles are the
   load-bearing part. Supabase's default privileges run
   `alter default privileges in schema public grant all on functions to
   anon, authenticated`, so a function created after that statement
   holds an EXPLICIT execute grant to both, which `revoke ... from
   public` does NOT remove. This is the same trap supabase-hardening.sql
   documents for tables, and it is why every revoke in this file names
   the roles rather than relying on PUBLIC. */
revoke execute on function public.arzuz_ref_token(text) from public, anon, authenticated;
grant  execute on function public.arzuz_ref_token(text) to service_role;

/* Minted in the database, in a BEFORE INSERT trigger, and never taken
   from the row. A browser-generated reference is a reference anyone
   can choose — "ARZ-S-0000-0000-0001" would be a perfectly valid one,
   and an attacker who can pick their own handle can pick someone
   else's to collide with, or pick a memorable one to impersonate a
   different submission. The trigger also means the reference exists
   for rows the team adds by hand from the dashboard, not only for
   rows that came through the public form. */
create or replace function public.arzuz_assign_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  letter    text;
  candidate text;
  attempt   int := 0;
begin
  if new.ref is not null and btrim(new.ref) <> '' then
    return new;                 -- an explicit ref (a backfill, a fixture) is kept
  end if;

  letter := case tg_table_name
    when 'demand_records' then 'S'   -- a student
    when 'listings'       then 'L'   -- a landlord
    else 'X'
  end;

  loop
    attempt := attempt + 1;
    candidate := public.arzuz_ref_token(letter);

    begin
      insert into public.waitlist_ref_registry (ref, kind) values (candidate, tg_table_name);
      new.ref := candidate;
      return new;
    exception when unique_violation then
      /* Somebody else drew that token in the microseconds since it was
         generated. Drawing again is the fix and it costs one insert.
         Eight draws is ~1 in 4e38 of reaching the escape hatch, which
         appends more entropy rather than ever failing a submission:
         a person filling this form must not lose their entry to a
         collision of our own making. */
      if attempt >= 8 then
        candidate := candidate || '-'
          || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
        insert into public.waitlist_ref_registry (ref, kind) values (candidate, tg_table_name);
        new.ref := candidate;
        return new;
      end if;
    end;
  end loop;
end $$;


-- ------------------------------------------------------------
-- 2. THE LAUNCH COLUMNS
--
-- Added to both sides of the waitlist — a student looking for a room
-- and a landlord offering one are the same problem to the team: a
-- person to contact, a consent to respect, and a pipeline stage.
-- ------------------------------------------------------------

alter table public.demand_records
  add column if not exists ref              text,
  add column if not exists applicant_type   text,
  add column if not exists consent_at       timestamptz,
  add column if not exists consent_text     text,
  add column if not exists follow_up_status text,
  add column if not exists assigned_to      text,
  add column if not exists assigned_at      timestamptz,
  add column if not exists verified_at      timestamptz,
  add column if not exists verified_by      text,
  add column if not exists linked_user_id   uuid,
  add column if not exists linked_at        timestamptz,
  add column if not exists link_verified_via text;

alter table public.listings
  add column if not exists ref              text,
  add column if not exists applicant_type   text,
  add column if not exists consent_at       timestamptz,
  add column if not exists consent_text     text,
  add column if not exists follow_up_status text,
  add column if not exists assigned_to      text,
  add column if not exists assigned_at      timestamptz,
  add column if not exists verified_at      timestamptz,
  add column if not exists verified_by      text,
  add column if not exists linked_user_id   uuid,
  add column if not exists linked_at        timestamptz,
  add column if not exists link_verified_via text;

/* A constraint, not a comment. The vocabulary is the spec's, and a
   typo in a dashboard dropdown should be refused by Postgres rather
   than become a sixth status nobody queries for. */
alter table public.demand_records drop constraint if exists demand_follow_up_status_check;
alter table public.demand_records drop constraint if exists demand_applicant_type_check;
alter table public.demand_records
  add constraint demand_follow_up_status_check
    check (follow_up_status in ('new', 'contacted', 'interested', 'matched', 'closed')),
  add constraint demand_applicant_type_check
    check (applicant_type in ('student', 'landlord', 'other'));

alter table public.listings drop constraint if exists listing_follow_up_status_check;
alter table public.listings drop constraint if exists listing_applicant_type_check;
alter table public.listings
  add constraint listing_follow_up_status_check
    check (follow_up_status in ('new', 'contacted', 'interested', 'matched', 'closed')),
  add constraint listing_applicant_type_check
    check (applicant_type in ('student', 'landlord', 'other'));

/* The backfill, and the default. Existing rows are not orphans: a
   demand that was 'open' is 'new', one that matched is 'matched', and
   one that expired was closed without a deal. Listings follow the
   same logic — a pending listing is new, a rejected one is closed.
   Both then take the default, so a row inserted by an old build of
   the site (which sends neither column) still lands in the pipeline
   instead of arriving NULL and falling out of every filter. */
update public.demand_records
   set follow_up_status = case
     when status = 'matched'   then 'matched'
     when status = 'fulfilled' then 'matched'
     when status = 'expired'   then 'closed'
     else 'new'
   end
 where follow_up_status is null;

update public.listings
   set follow_up_status = case
     when status = 'rejected' then 'closed'
     when status = 'inactive' then 'closed'
     else 'new'
   end
 where follow_up_status is null;

update public.demand_records set applicant_type = 'student' where applicant_type is null;
update public.listings       set applicant_type = 'landlord' where applicant_type is null;

alter table public.demand_records alter column follow_up_status set default 'new';
alter table public.demand_records alter column applicant_type   set default 'student';
alter table public.listings       alter column follow_up_status set default 'new';
alter table public.listings       alter column applicant_type   set default 'landlord';

/* Not NOT NULL, deliberately. The default and the backfill cover every
   row that exists and every row an old build will insert; a NOT NULL
   here would be enforced against the row the trigger has not yet
   returned, and would turn a deploy-order mistake into a lost
   submission. The DEFAULT is the guarantee, and it is a sufficient one
   for a column nothing can write NULL into except a deliberate
   `set follow_up_status = null`, which no code path does. */

create index if not exists idx_demand_follow_up on public.demand_records (follow_up_status);
create index if not exists idx_demand_assigned  on public.demand_records (assigned_to);
create index if not exists idx_listings_follow_up on public.listings (follow_up_status);
create index if not exists idx_listings_assigned  on public.listings (assigned_to);

/* ref is unique per table as well as in the registry: the registry is
   the guarantee, this is the index the query planner wants and the
   error PostgREST would report if they ever disagreed. */
create unique index if not exists uq_demand_ref  on public.demand_records (ref) where ref is not null;
create unique index if not exists uq_listing_ref on public.listings (ref)       where ref is not null;

/* The two minting triggers. BEFORE INSERT, so the reference is part of
   the row that gets written — a reference handed back to a student has
   to be the reference that is in the table. */
drop trigger if exists trg_demand_assign_ref on public.demand_records;
create trigger trg_demand_assign_ref
  before insert on public.demand_records
  for each row execute function public.arzuz_assign_ref();

drop trigger if exists trg_listing_assign_ref on public.listings;
create trigger trg_listing_assign_ref
  before insert on public.listings
  for each row execute function public.arzuz_assign_ref();


-- ------------------------------------------------------------
-- 3. THE SUBMISSION THROTTLE
--
-- The public forms post through netlify/functions/waitlist.js. A rate
-- limit that lives in the function's memory is a rate limit per
-- Netlify instance, and Netlify runs as many instances as it likes —
-- so the count has to live somewhere shared. It lives here, and the
-- function calls it with the service key.
--
-- WHICH IS ALSO WHY IT IS NOT A POLICY. The throttle is not a table
-- the site can query: it is a decision made on the server, in one
-- round trip, by a function only the service role may execute.
--
-- A note on limits and a campus. Per-IP limiting is deliberately
-- generous — hundreds of students on one campus network share one
-- public address, and a launch that refuses the ninth student from
-- MTN's NAT because eight of their neighbours got there first is a
-- launch that looks broken. The tight, cheap defence against the
-- duplicate that actually happens is not this table: it is the
-- same-phone check in the function, which answers a repeat submission
-- with the reference the person already has instead of a refusal.
-- ------------------------------------------------------------

create table if not exists public.submission_guard (
  id         bigserial primary key,
  ip_hash    text not null,
  form       text not null,
  outcome    text not null,          -- allowed / throttled_hour / throttled_gap / throttled_global
  created_at timestamptz not null default now()
);

alter table public.submission_guard enable row level security;
revoke all on public.submission_guard from anon, authenticated;
revoke all on sequence public.submission_guard_id_seq from anon, authenticated;

create index if not exists idx_submission_guard_ip   on public.submission_guard (ip_hash, created_at desc);
create index if not exists idx_submission_guard_time on public.submission_guard (created_at desc);

comment on table public.submission_guard is
  'One row per public form attempt, by hashed IP. Read by the launch dashboard and by the throttle below; never reachable with an anon key.';

/* One round trip: decide, record the decision, answer. The decision is
   a jsonb verdict rather than a raise, because "you have sent too many"
   is not an error condition — it is a 429 with a sentence, and the
   page has a class and copy for exactly that (assets/api-errors.js). */
create or replace function public.waitlist_throttle(
  p_ip_hash          text,
  p_form             text,
  p_max_per_hour     int default 60,
  p_min_gap_seconds  int default 4,
  p_global_per_hour  int default 4000
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hour_count   int;
  last_seen    timestamptz;
  global_count int;
begin
  /* Housekeeping with a 5% chance per call: the window is one hour and
     the global ceiling counts the same hour, so nothing older than a
     day has a vote. Done here rather than by a cron because a function
     that is already writing should pay its own tidying-up, and 5% of
     submissions is a cost nobody can feel. */
  if random() < 0.05 then
    delete from public.submission_guard where created_at < now() - interval '26 hours';
  end if;

  /* Refused attempts are recorded too, and that is deliberate: a client
     being throttled keeps being throttled instead of getting a clean
     slate with every attempt, and the trail shows what actually
     happened when someone asks why a student could not submit. */
  select count(*), max(created_at)
    into hour_count, last_seen
    from public.submission_guard
   where ip_hash = p_ip_hash
     and created_at > now() - interval '1 hour';

  if hour_count >= p_max_per_hour then
    insert into public.submission_guard (ip_hash, form, outcome)
      values (p_ip_hash, p_form, 'throttled_hour');
    return jsonb_build_object('allow', false, 'reason', 'hour',
                              'used', hour_count, 'limit', p_max_per_hour);
  end if;

  if last_seen is not null and last_seen > now() - make_interval(secs => p_min_gap_seconds) then
    insert into public.submission_guard (ip_hash, form, outcome)
      values (p_ip_hash, p_form, 'throttled_gap');
    return jsonb_build_object('allow', false, 'reason', 'gap',
                              'retry_after_seconds', p_min_gap_seconds);
  end if;

  select count(*) into global_count
    from public.submission_guard
   where created_at > now() - interval '1 hour';

  if global_count >= p_global_per_hour then
    insert into public.submission_guard (ip_hash, form, outcome)
      values (p_ip_hash, p_form, 'throttled_global');
    return jsonb_build_object('allow', false, 'reason', 'global',
                              'used', global_count, 'limit', p_global_per_hour);
  end if;

  insert into public.submission_guard (ip_hash, form, outcome)
    values (p_ip_hash, p_form, 'allowed');

  return jsonb_build_object('allow', true, 'used', hour_count + 1, 'limit', p_max_per_hour);
end $$;

revoke execute on function public.waitlist_throttle(text, text, int, int, int)
  from public, anon, authenticated;
grant  execute on function public.waitlist_throttle(text, text, int, int, int) to service_role;


-- ------------------------------------------------------------
-- 4. THE STAFF AUDIT TRAIL
--
-- Spec §4 asks for audit logs for sensitive actions. The believable
-- version of that is a trigger, not a call the page makes: a log a
-- page writes is a log a page can decline to write, and the entries
-- that matter most are the ones someone would rather not have
-- written.
--
-- So the trail is written from the table itself, AFTER INSERT, UPDATE
-- or DELETE, for every actor — including the service role, which is the
-- actor a public submission arrives as now that the validated door
-- (netlify/functions/waitlist.js) is the only way in. It records the acting
-- role as POSTGRES computes it (public.arzuz_role(), i.e. from the
-- signed JWT) rather than anything the request claimed, and it lands
-- in a table with no insert, update or delete policy at all — the
-- trigger function is SECURITY DEFINER, so it writes, and nothing
-- holding an anon or authenticated key can add, edit or erase a line.
-- ------------------------------------------------------------

create table if not exists public.staff_audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  actor_id        uuid,
  actor_role      text,
  table_name      text not null,
  row_id          uuid,
  action          text not null,     -- submitted / insert / update / delete
  ref             text,
  changed_columns text[],
  before_row      jsonb,
  after_row       jsonb
);

alter table public.staff_audit_log enable row level security;
revoke all on public.staff_audit_log from anon, authenticated;
revoke all on sequence public.staff_audit_log_id_seq from anon, authenticated;
grant  select on public.staff_audit_log to authenticated;

create index if not exists idx_audit_at    on public.staff_audit_log (at desc);
create index if not exists idx_audit_row   on public.staff_audit_log (table_name, row_id);
create index if not exists idx_audit_ref   on public.staff_audit_log (ref);

comment on table public.staff_audit_log is
  'Append-only trail of waitlist row changes. Written by trg_*_audit triggers; no key that reaches a browser can insert, change or delete a line.';

/* The snapshot helper: only the columns a reviewer would ask about,
   and only the ones this table actually has — the same function serves
   both tables without either of them having to match the other. */
create or replace function public.arzuz_audit_snapshot(p_row jsonb, p_keys text[])
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(k, p_row -> k), '{}'::jsonb)
    from unnest(p_keys) as k
   where p_row ? k;
$$;

revoke execute on function public.arzuz_audit_snapshot(jsonb, text[]) from public, anon, authenticated;
grant  execute on function public.arzuz_audit_snapshot(jsonb, text[]) to service_role;

create or replace function public.arzuz_audit_waitlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  keys       text[];
  before_row jsonb := '{}'::jsonb;
  after_row  jsonb := '{}'::jsonb;
  moved      text[] := '{}'::text[];
  who        text;
begin
  /* The columns worth a line in the trail. Not the whole row: payload
     holds what the person typed, and a log that copies every free-text
     answer is a second place their words live, which is exactly what
     "collect only what you need" is about. */
  keys := case tg_table_name
    when 'demand_records' then array[
      'applicant_type', 'status', 'follow_up_status', 'assigned_to', 'notes', 'ref',
      'consent_at', 'verified_at', 'verified_by', 'linked_user_id'
    ]
    when 'listings' then array[
      'applicant_type', 'status', 'tier', 'follow_up_status', 'assigned_to', 'notes', 'ref',
      'opening_ask_ngn', 'listed_price_ngn', 'consent_at', 'verified_at', 'verified_by'
    ]
    else array['status', 'notes', 'ref']
  end;

  who := public.arzuz_role();

  if tg_op <> 'INSERT' then
    before_row := public.arzuz_audit_snapshot(to_jsonb(old), keys);
  end if;

  if tg_op <> 'DELETE' then
    after_row := public.arzuz_audit_snapshot(to_jsonb(new), keys);
  end if;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}'::text[])
      into moved
      from unnest(keys) as k
     where (to_jsonb(old) -> k) is distinct from (to_jsonb(new) -> k);

    /* Nothing the trail watches moved — a scroll position, a reopened
       drawer, a re-uploaded photo. Writing a line for those would bury
       the lines that matter under ones that do not. */
    if moved is null or array_length(moved, 1) is null then
      return null;
    end if;
  end if;

  insert into public.staff_audit_log
    (actor_id, actor_role, table_name, row_id, action, ref, changed_columns, before_row, after_row)
  values (
    auth.uid(),
    who,
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    /* 'submitted' is this vocabulary's one word for "a member of the
       public put this here", and the public now arrives as the SERVICE
       ROLE: supabase-close-public-inserts.sql revoked anon's INSERT on
       every waitlist table, and netlify/functions/waitlist.js writes
       with the service key. The branch has to name the actor that
       actually performs a submission, or it is dead code and every
       public submission reads as a bare `insert` by a machine.

       actor_role still says WHICH actor — 'service_role', not 'anon' —
       because that is the truth and it is the difference between "the
       door accepted a form" and "an operator wrote a row". The action
       says what happened to the row; the role says who did it. */
    case
      when tg_op = 'INSERT' and who in ('anon', 'service_role') then 'submitted'
      else lower(tg_op)
    end,
    case when tg_op = 'DELETE' then old.ref else new.ref end,
    moved,
    before_row,
    after_row
  );

  return null;   -- AFTER trigger: the return value is ignored
end $$;

/* The two trigger functions are not callable as functions at all —
   `select arzuz_assign_ref()` is refused by Postgres because a trigger
   function needs a trigger context — so these revokes are belt and
   braces rather than the guard. The guard is that the ONLY thing that
   can mint a reference is a row arriving, and the only thing that can
   write a trail line is a row changing. */
revoke execute on function public.arzuz_assign_ref() from public, anon, authenticated;
revoke execute on function public.arzuz_audit_waitlist() from public, anon, authenticated;

drop trigger if exists trg_demand_audit on public.demand_records;
create trigger trg_demand_audit
  after insert or update or delete on public.demand_records
  for each row execute function public.arzuz_audit_waitlist();

drop trigger if exists trg_listing_audit on public.listings;
create trigger trg_listing_audit
  after insert or update or delete on public.listings
  for each row execute function public.arzuz_audit_waitlist();

/* Who may READ the trail. The same role vocabulary as
   supabase-team-roles.sql, and the same deliberate absence: marketing
   has no policy here, so a growth login reads zero rows rather than a
   list of who contacted which student. `finance` is absent too — the
   money role has no business in the contact history. */
drop policy if exists "admin can read the audit trail" on public.staff_audit_log;
create policy "admin can read the audit trail"
  on public.staff_audit_log for select to authenticated
  using (public.arzuz_role() = 'admin');

drop policy if exists "operations can read the audit trail" on public.staff_audit_log;
create policy "operations can read the audit trail"
  on public.staff_audit_log for select to authenticated
  using (public.arzuz_role() in ('support', 'operations'));

drop policy if exists "verification can read the audit trail" on public.staff_audit_log;
create policy "verification can read the audit trail"
  on public.staff_audit_log for select to authenticated
  using (public.arzuz_role() = 'verification');


-- ------------------------------------------------------------
-- 5. WHAT THE WORDS MEAN
-- ------------------------------------------------------------

comment on column public.demand_records.ref is
  'Human reference shown to the applicant. Minted server-side by trg_demand_assign_ref; unique across every waitlist row through public.waitlist_ref_registry.';
comment on column public.demand_records.follow_up_status is
  'The team pipeline: new / contacted / interested / matched / closed. Distinct from status, which is the record state the views read.';
comment on column public.demand_records.assigned_to is
  'Email of the team member working this record. Null means unclaimed.';
comment on column public.demand_records.consent_at is
  'When the applicant agreed to be contacted. Consent is recorded, not assumed from pressing submit.';
comment on column public.demand_records.linked_user_id is
  'Seam for a future authenticated account. Set only after the applicant''s control of the email or phone has been verified; never on a bare match. See LAUNCH-READINESS.md §6.';


-- ------------------------------------------------------------
-- 6. CHECK IT WORKED
-- Run these in the SQL editor; each one is a fact, not a feeling.
-- ------------------------------------------------------------
--
-- (a) Every new column is there, on both sides:
--
--   select table_name, column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('demand_records','listings')
--      and column_name in ('ref','applicant_type','consent_at','consent_text',
--                          'follow_up_status','assigned_to','verified_at',
--                          'verified_by','linked_user_id')
--    order by table_name, column_name;
--
-- (b) A reference is minted, in the database, for a row that arrives
--     without one — and the registry knows about it:
--
--   insert into demand_records (payload) values ('{"first":"Test","hp":""}'::jsonb)
--     returning ref, follow_up_status, applicant_type;
--   select * from waitlist_ref_registry order by created_at desc limit 1;
--
-- (c) The trail wrote itself for that insert, as anon:
--
--   select at, actor_role, table_name, action, ref, changed_columns
--     from staff_audit_log order by at desc limit 5;
--
-- (d) The pipeline vocabulary is enforced by the database, not by a
--     dropdown. This must FAIL:
--
--   update demand_records set follow_up_status = 'done' where ref is not null;
--
-- (e) No key that reaches a browser can write, edit or delete a trail
--     line or a reference. Both must answer 0:
--
--   select has_table_privilege('anon','staff_audit_log','insert')::int,
--          has_table_privilege('authenticated','staff_audit_log','update')::int,
--          has_table_privilege('anon','waitlist_ref_registry','select')::int;
--
-- (f) Re-running this file changes nothing but the numbering inside
--     the registry. It is `if not exists` / `create or replace`
--     throughout, and the two backfills only touch NULLs.
