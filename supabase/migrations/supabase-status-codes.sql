-- ============================================================
-- ARZUZ — "check my waitlist status", keyed on the ARZ- reference
--
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this AFTER supabase-waitlist-launch.sql. That file adds `ref`
-- to demand_records and listings and creates waitlist_ref_registry,
-- and every function below resolves a reference through them.
-- Safe to run more than once. Nothing here drops a table, a column
-- or a row.
--
-- WHY THIS FILE EXISTS
--
--   A student is given a reference — ARZ-S-4F7A-2C9B-1D3E — when
--   their form is accepted, and until now that string was only useful
--   to the team: it resolved a row in the dashboard, and the person
--   who owns it had no way to ask what had happened since. So they
--   rang the office, or messaged WhatsApp, to find out. That is a
--   support cost for an answer the database already has, and it is
--   worst exactly when the team is busiest.
--
--   THE REFERENCE ALONE IS NOT ENOUGH TO BE SHOWN ANYTHING.
--   netlify/functions/status.js requires a contact we hold for the row
--   as well — the phone number, or the email address when a student has
--   changed numbers — and then proves control of it: a six-digit code
--   goes to that contact (WhatsApp over the OpenWA sender the rest of
--   the site already uses, email over the same Resend one the claim
--   notices use), and nothing is revealed until that code comes back.
--   A reference that leaks — read out loud on a call, screenshotted,
--   guessed — reveals nothing on its own. The page stores no session
--   and no token: the code IS the proof, for that one answer.
--
--   NOTHING IN THIS FILE KNOWS WHICH CHANNEL A CODE WENT OUT ON, and
--   that is deliberate rather than unfinished. The hash below identifies
--   a code, not a mailbox, so a second channel needed no schema change:
--   the reveal is the same either way, and adding a channel cannot widen
--   what a caller may read here, because what a caller may read does not
--   depend on how the code travelled.
--
--   THAT WAS ABOUT THE STUDENT, AND IT IS NOT THE WHOLE STORY.
--   supabase-status-history.sql — run after this file — adds the OFFICE's
--   half: an append-only trail of every attempt to deliver a code (the
--   channel, whether the sender took it, and a machine word for why not),
--   and the one function the Support Desk asks it through. It could not
--   widen anything here for the same reason a channel could not: what a
--   caller may read is decided by the reveal below and by the role check
--   inside that file's reader. Where the code went was never a fact about
--   the student's answer; it is a fact about what to fix when the message
--   does not arrive, and that is a question for a screen rather than for a
--   build log that expires.
--
--   AND THE LOOKUP CANNOT BE USED TO ENUMERATE REFERENCES.
--   Two things hold that up, and they are different things:
--     · the answer is the SAME for every failure. Unknown reference,
--       wrong phone, wrong email, nothing left of the reference's hour
--       — one sentence: "if that reference and the contact details we
--       hold for it match a record of ours, a code is on its way." It
--       is deliberately channel-neutral, so the answer on one channel
--       cannot be read as a fact about the contacts a row has. There
--       is no oracle to read, so there is nothing to walk.
--     · the attempt is COUNTED, in the database, before the reference
--       is even looked up. See section 2 for why the counter is a
--       table of its own rather than the waitlist's.
--
-- WHAT A CODE IS WORTH
--
--   Six digits, hashed with the service key as salt before it is
--   stored, ten minutes to live, five attempts, and the newest code
--   is the only live one. Guessing is ~5 in a million per issued
--   code, and issuing a second code kills the first. The plaintext
--   code is never written anywhere: not to the table, not to a log.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
--
-- One guard, because this file has one prerequisite. plpgsql does
-- not resolve a column until a function is first CALLED, so an
-- install that skipped supabase-waitlist-launch.sql would create
-- every function below quite happily and then fail on the first
-- student who used the page — with a message about a missing column
-- rather than about the file to run. The registry is the sharper of
-- the two things to check: it is created by that file, and it is
-- also what section 3 reads to tell a student's reference from a
-- landlord's.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.waitlist_ref_registry') is null then
    raise exception 'public.waitlist_ref_registry is missing. Run supabase-waitlist-launch.sql before this file — it adds the ref column to demand_records and listings and creates the registry this file resolves a reference through.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE CODE, AND ONLY ITS HASH
--
-- One row per code asked for. `code_hash` is sha256 of
-- ref|code|<service key> — computed in netlify/functions/status.js,
-- so the salt never reaches the database and a leaked row cannot be
-- walked back to a code by anyone holding only the table.
--
-- The row is kept after it is spent, and that is deliberate: the
-- per-reference ceiling in section 3 counts issued codes over the
-- last hour, and a count that forgets the spent ones is a count an
-- attacker can spend around. Nothing here is a place a code could be
-- READ from — there is no plaintext column to forget to revoke.
---- No row here records who was told what, because nothing here is
--   told anything: this table is a code, an expiry, a count of
--   attempts, whether it was used, and the ceiling it was issued under
--   (that last column is added by supabase-status-history.sql §1).
-- ------------------------------------------------------------

create table if not exists public.status_codes (
  id          bigserial primary key,
  ref         text        not null,
  code_hash   text        not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  attempts    integer     not null default 0,
  consumed_at timestamptz
);

alter table public.status_codes enable row level security;
revoke all on public.status_codes from anon, authenticated;
revoke all on sequence public.status_codes_id_seq from anon, authenticated;

/* The partial index is the one the verify path actually walks: the
   newest LIVE code for one reference. `expires_at` is part of the
   predicate rather than of the index key because expiry is a
   comparison, not a lookup — but it is the column an index-only scan
   would want next, so it comes in the key after ref, before the
   ordering column, which cannot be indexed away anyway. */
create index if not exists idx_status_codes_ref  on public.status_codes (ref, created_at desc);
create index if not exists idx_status_codes_live on public.status_codes (ref, expires_at) where consumed_at is null;
create index if not exists idx_status_codes_time on public.status_codes (created_at desc);

comment on table public.status_codes is
  'One row per verification code handed to the status page: the hash of the code, when it dies, how many times it has been tried, and whether it was used. Service role only — never reachable with an anon key, and it stores no plaintext code.';

comment on column public.status_codes.code_hash is
  'sha256(ref|code|SUPABASE_SERVICE_ROLE_KEY), computed in netlify/functions/status.js. The salt is server-side, so a row that leaks is not a code that leaks.';


-- ------------------------------------------------------------
-- 2. THE LOOKUP THROTTLE — a table of its own, on purpose
--
-- The obvious thing to reuse was public.submission_guard, which
-- already holds a per-IP count for the public forms. It is the wrong
-- table, and the reason is worth writing down because it is not
-- visible from the columns:
--
--   submission_guard's ceiling counts EVERY ROW IN THE TABLE in the
--   last hour, not per form. Reusing it would mean one visitor
--   refreshing the status page could spend the budget that real
--   students' registrations are judged against — the lookup would
--   throttle the waitlist. The reverse is just as bad: a busy launch
--   day would start refusing status lookups, which are the cheap
--   question, to protect the expensive one.
--
-- So the counter lives here, and the two ceilings cannot reach each
-- other. What is deliberately NOT here is the reference: this table
-- records that an address asked, not WHAT it asked about, so it is
-- not a log of who looked up whose submission. The per-reference
-- ceiling below lives in status_codes, which already has to hold the
-- reference for other reasons.
-- ------------------------------------------------------------

create table if not exists public.status_guard (
  id         bigserial primary key,
  ip_hash    text        not null,
  scope      text        not null,   -- send / verify
  outcome    text        not null,   -- allowed / throttled_hour / throttled_gap / throttled_global
  created_at timestamptz not null default now()
);

alter table public.status_guard enable row level security;
revoke all on public.status_guard from anon, authenticated;
revoke all on sequence public.status_guard_id_seq from anon, authenticated;

create index if not exists idx_status_guard_ip   on public.status_guard (ip_hash, scope, created_at desc);
create index if not exists idx_status_guard_time on public.status_guard (created_at desc);

comment on table public.status_guard is
  'One row per status-page attempt, by hashed IP and by step. Held apart from submission_guard so that a lookup flood cannot throttle real waitlist submissions, or the reverse. It holds no reference, so it is not a record of who looked up which submission.';

/* The verdict, as jsonb, in one round trip — and deliberately the same
   SHAPE as waitlist_throttle()'s, because both are read by the same
   mistake-prone caller and "you have asked too often" is a 429 with a
   sentence on this site, never an error.

   `p_scope` separates the two steps. A student who has asked for a
   code and is now typing it is doing two different things, and a
   single counter would make the second one wait out the first. */
create or replace function public.status_throttle(
  p_ip_hash         text,
  p_scope           text,
  p_max_per_hour    int default 10,
  p_min_gap_seconds int default 2,
  p_global_per_hour int default 300
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
  /* Housekeeping with a 5% chance per call: the window is an hour, so
     nothing older than a day has a vote in anything below. A function
     that is already writing pays its own tidying-up rather than
     needing a cron — the same reasoning as waitlist_throttle(). */
  if random() < 0.05 then
    delete from public.status_guard where created_at < now() - interval '1 day';
  end if;

  select count(*), max(created_at)
    into hour_count, last_seen
    from public.status_guard
   where ip_hash = p_ip_hash
     and scope = p_scope
     and created_at > now() - interval '1 hour';

  if hour_count >= p_max_per_hour then
    insert into public.status_guard (ip_hash, scope, outcome)
      values (p_ip_hash, p_scope, 'throttled_hour');
    return jsonb_build_object('allow', false, 'reason', 'hour',
                              'used', hour_count, 'limit', p_max_per_hour);
  end if;

  if last_seen is not null and last_seen > now() - make_interval(secs => p_min_gap_seconds) then
    insert into public.status_guard (ip_hash, scope, outcome)
      values (p_ip_hash, p_scope, 'throttled_gap');
    return jsonb_build_object('allow', false, 'reason', 'gap',
                              'retry_after_seconds', p_min_gap_seconds);
  end if;

  select count(*) into global_count
    from public.status_guard
   where created_at > now() - interval '1 hour';

  if global_count >= p_global_per_hour then
    insert into public.status_guard (ip_hash, scope, outcome)
      values (p_ip_hash, p_scope, 'throttled_global');
    return jsonb_build_object('allow', false, 'reason', 'global',
                              'used', global_count, 'limit', p_global_per_hour);
  end if;

  insert into public.status_guard (ip_hash, scope, outcome)
    values (p_ip_hash, p_scope, 'allowed');

  return jsonb_build_object('allow', true, 'used', hour_count + 1, 'limit', p_max_per_hour);
end $$;

revoke execute on function public.status_throttle(text, text, int, int, int)
  from public, anon, authenticated;
grant  execute on function public.status_throttle(text, text, int, int, int) to service_role;


-- ------------------------------------------------------------
-- 3. ISSUE A CODE
--
-- Called only after netlify/functions/status.js has found the row by
-- reference AND matched the contact on it — the phone number, or the
-- email address. So a code row is only ever written for a real
-- reference, which is what makes the per-reference ceiling below
-- trustworthy: it counts codes, and codes only exist for references
-- that were someone's.
--
-- The ceiling is per reference, not per address, because the thing it
-- protects is a person's inbox — and it is ONE ceiling across both
-- channels: the function passes the same ceiling here whichever contact
-- proved itself, so a caller cannot double it by asking by email after
-- asking by WhatsApp. Five an hour is more than a student needs and far
-- less than a nuisance.
--
-- Issuing a second code KILLS the first. A student who asks again
-- because the message was slow must not leave two live codes behind,
-- and "the newest one is the only one that works" is a sentence the
-- page can say.
-- ------------------------------------------------------------

create or replace function public.status_open(
  p_ref                   text,
  p_code_hash             text,
  p_ttl_seconds           int default 600,
  p_max_per_ref_per_hour  int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  issued  int;
  mine_id bigint;
  dies    timestamptz;
begin
  if p_ref is null or btrim(p_ref) = '' then
    return jsonb_build_object('ok', false, 'reason', 'no-ref');
  end if;

  if p_code_hash is null or length(p_code_hash) < 32 then
    return jsonb_build_object('ok', false, 'reason', 'no-hash');
  end if;

  if random() < 0.05 then
    delete from public.status_codes where expires_at < now() - interval '1 day';
  end if;

  /* Every code asked for in the last hour, spent or not — see section
     1 for why the spent ones have to stay. */
  select count(*) into issued
    from public.status_codes
   where ref = p_ref
     and created_at > now() - interval '1 hour';

  if issued >= p_max_per_ref_per_hour then
    return jsonb_build_object('ok', false, 'reason', 'ref_limited',
                              'used', issued, 'limit', p_max_per_ref_per_hour);
  end if;

  /* The previous code dies now rather than at its own expiry, so
     exactly one code is live for a reference at any moment. */
  update public.status_codes
     set expires_at = now()
   where ref = p_ref
     and consumed_at is null
     and expires_at > now();

  dies := now() + make_interval(secs => greatest(60, least(3600, coalesce(p_ttl_seconds, 600))));

  insert into public.status_codes (ref, code_hash, expires_at)
    values (p_ref, p_code_hash, dies)
    returning id into mine_id;

  return jsonb_build_object('ok', true, 'code_id', mine_id,
                            'expires_at', dies, 'issued_this_hour', issued + 1);
end $$;

revoke execute on function public.status_open(text, text, int, int)
  from public, anon, authenticated;
grant  execute on function public.status_open(text, text, int, int) to service_role;


-- ------------------------------------------------------------
-- 4. THE CODE COMES BACK, AND THE ANSWER WITH IT
--
-- The reveal is built HERE rather than by the caller, and that is the
-- design. What a reference entitles its owner to see is a decision
-- about this site's data, so it is made in one place, in the database,
-- with a fixed list of columns — a caller cannot widen it, and a new
-- page cannot accidentally widen it either. The columns are: the
-- stage in the pipeline, the row's own status, when it arrived,
-- whether it has been checked and how far, and whether it was the
-- roommate questionnaire. NOT the phone, NOT the name, NOT the
-- answers, NOT the landlord's payload: the person asking already knows
-- those, and a page that repeats them back is a page that leaks them
-- to whoever is holding the phone.
--
-- A reference is a student's (demand_records) or a landlord's
-- (listings), and waitlist_ref_registry says which — that is what it
-- is for. The two branches are static SQL rather than a dynamic
-- format(): the table name is not interpolated, so there is no
-- string that could become a different query, and the two shapes stay
-- readable side by side.
--
-- ATTEMPTS ARE SPENT ATOMICALLY. The increment and the ceiling are one
-- statement with `attempts < p_max_attempts` in its WHERE, so two
-- requests arriving together cannot both spend the fifth attempt and
-- get a sixth try. The order matters: the attempt is spent BEFORE the
-- comparison, so a wrong code costs something even if the connection
-- dies mid-request.
--
-- AND THE CEILING IS NOW THE CODE'S OWN. supabase-status-history.sql §4
-- re-states this function so that `cap` comes from
-- `status_codes.max_attempts` — a column that file adds — instead of
-- from the caller. Nothing enforced the number before, because nothing
-- recorded it, so any holder of the service key could pass a larger one
-- for a code it did not issue. The parameter below stays as the fallback
-- for a row with no ceiling of its own, which §1's ALTER makes
-- impossible for a row that exists today. This copy is what a project
-- has between running this file and running that one.
-- ------------------------------------------------------------

create or replace function public.status_verify(
  p_ref          text,
  p_code_hash    text,
  p_max_attempts int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  live_id   bigint;
  spent     int;
  kind      text;
  reveal    jsonb;
  cap       int := greatest(1, least(20, coalesce(p_max_attempts, 5)));
begin
  select c.id into live_id
    from public.status_codes c
   where c.ref = p_ref
     and c.consumed_at is null
     and c.expires_at > now()
   order by c.created_at desc
   limit 1;

  if live_id is null then
    /* No live code for this reference: never asked, already used, or
       past its ten minutes. One answer, because telling them apart is
       an oracle — and the page has one sentence for all three. */
    return jsonb_build_object('ok', false, 'reason', 'no-code');
  end if;

  update public.status_codes
     set attempts = attempts + 1
   where id = live_id
     and attempts < cap
  returning attempts into spent;

  if spent is null then
    return jsonb_build_object('ok', false, 'reason', 'too-many', 'limit', cap);
  end if;

  /* A plain `=` on two hex digests, not a constant-time compare. The
     values being compared are already a sha256 of the code, so there
     is no secret in the comparison itself to time — and timing a
     network request closely enough to walk 64 hex characters would
     still leave the code unguessed. Written down so the next reader
     knows it was decided rather than missed. */
  if p_code_hash is null or p_code_hash <> (select code_hash from public.status_codes where id = live_id) then
    return jsonb_build_object('ok', false, 'reason', 'wrong',
                              'attempts_left', cap - spent, 'limit', cap);
  end if;

  /* Correct: the code is spent, and so is every other live code for
     this reference. */
  update public.status_codes
     set consumed_at = now(), expires_at = now()
   where ref = p_ref and consumed_at is null;

  select r.kind into kind
    from public.waitlist_ref_registry r
   where r.ref = p_ref;

  if kind = 'listings' then
    select jsonb_build_object(
             'ref',         l.ref,
             'kind',        'landlord',
             'state',       l.status,
             'stage',       l.follow_up_status,
             'received_at', l.created_at,
             'verified_at', l.verified_at,
             'tier',        l.tier,
             'roommate',    false)
      into reveal
      from public.listings l
     where l.ref = p_ref;
  else
    select jsonb_build_object(
             'ref',         d.ref,
             'kind',        'student',
             'state',       d.status,
             'stage',       d.follow_up_status,
             'received_at', d.created_at,
             'verified_at', d.verified_at,
             'tier',        null,
             'roommate',    coalesce(d.payload ->> 'roommate', '') = 'yes')
      into reveal
      from public.demand_records d
     where d.ref = p_ref;
  end if;

  if reveal is null then
    /* The code was right and the row is gone — deleted by hand in the
       dashboard, most likely. Say so rather than answering 200 with
       nothing in it. */
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;

  return jsonb_build_object('ok', true, 'reason', 'matched', 'reveal', reveal);
end $$;

revoke execute on function public.status_verify(text, text, int)
  from public, anon, authenticated;
grant  execute on function public.status_verify(text, text, int) to service_role;


-- ------------------------------------------------------------
-- 5. CHECK IT WORKED
-- ------------------------------------------------------------

-- (a) Both tables exist, have RLS on, and hold no policy — so no
--     browser key can reach them by any route.
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' and tablename in ('status_codes','status_guard');
--
--     rowsecurity must be true for both. Then:
--
--   select tablename, policyname from pg_policies
--    where schemaname = 'public' and tablename in ('status_codes','status_guard');
--
--     expect ZERO rows. RLS with no policy denies everyone; the
--     service role bypasses it.

-- (b) No browser role may execute any of the three functions, and the
--     service role may.
--
--   select has_function_privilege('anon',          'public.status_open(text,text,int,int)', 'execute') as anon_opens,
--          has_function_privilege('authenticated', 'public.status_open(text,text,int,int)', 'execute') as authed_opens,
--          has_function_privilege('service_role',  'public.status_open(text,text,int,int)', 'execute') as service_opens,
--          has_function_privilege('anon',          'public.status_verify(text,text,int)',     'execute') as anon_verifies,
--          has_function_privilege('service_role',  'public.status_throttle(text,text,int,int,int)', 'execute') as service_throttles;
--
--     Every anon/authed column must be false. The two service columns
--     must be true.

-- (c) The whole flow, as the database sees it. Run this in the SQL
--     editor, changing the reference to a real one from the
--     dashboard. It mints a code the way netlify/functions/status.js
--     does (the hash below is a stand-in — the real one is salted
--     with the service key, which is why a row copied out of this
--     table is not a usable code):
--
--   select public.status_throttle('check-1', 'send', 10, 0, 300);
--     -- {"allow": true, "used": 1, "limit": 10}
--
--   select public.status_open('ARZ-S-XXXX-XXXX-XXXX', 'a-stand-in-hash-that-is-long-enough');
--     -- {"ok": true, "code_id": …, "expires_at": …, "issued_this_hour": 1}
--
--   select public.status_verify('ARZ-S-XXXX-XXXX-XXXX', 'the-wrong-hash-entirely');
--     -- {"ok": false, "reason": "wrong", "attempts_left": 4, …}
--     -- run it five times and the sixth says {"reason":"too-many"}
--
--   select public.status_open('ARZ-S-XXXX-XXXX-XXXX', 'a-stand-in-hash-that-is-long-enough');
--     -- a NEW code, and the row from the first call now has
--     -- expires_at = now(): issuing a second code kills the first
--
--   select public.status_verify('ARZ-S-XXXX-XXXX-XXXX', 'a-stand-in-hash-that-is-long-enough');
--     -- {"ok": true, "reason": "matched", "reveal": {"kind": "student",
--     --  "stage": "new", "state": "open", …}}
--
--   select ref, attempts, consumed_at is not null as used, expires_at
--     from public.status_codes order by created_at desc limit 3;
--     -- then run the same verify again: {"reason": "no-code"}, because
--     -- the code was consumed. A spent code is not a reusable one.

-- (d) The end-to-end check is the page itself, because it is the only
--     thing that mints the real hash and sends the real message:
--     open /status with a reference and the phone number on that row.
--
--     Expected: a WhatsApp code arrives; the wrong code says the same
--     thing as an unknown reference; the right code shows the stage.
--     Then repeat the same reference from the same phone more than
--     five times inside an hour and expect the per-reference refusal,
--     and more than ten lookups inside an hour from the same address
--     and expect the throttle — neither of which has a browser
--     console equivalent, because both are decided by this file.

-- (e) Re-running: everything here is idempotent. `create table if not
--     exists`, `create index if not exists`, `create or replace
--     function`, and no data is touched. Running it twice changes
--     nothing on the second run but the function bodies.
