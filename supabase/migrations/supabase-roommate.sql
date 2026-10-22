-- ============================================================
-- ARZUZ — roommate matching engine (questionnaire + double opt-in)
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Adds, on top of supabase-schema.sql / supabase-hardening.sql /
-- supabase-media-booking.sql:
--
--   1. roommate_profiles  — the two-sided questionnaire: Part A
--                           (about you) and Part B (ideal roommate
--                           + deal-breakers), stored as one JSON
--                           payload, exactly like every other form
--                           on this site.
--   2. roommate_interests — one row per one-sided decision. A pair
--                           unlocks contact details only when BOTH
--                           directions say 'accept'.
--   3. roommate_events    — the append-only consent trail: who agreed
--                           to what, and when. Nothing ever updates or
--                           deletes a row in it, by grant and by policy.
--
-- WHY THERE IS NO ANON POLICY HERE
--   Every other public table lets anon INSERT and nothing else.
--   These two are stricter still: anon cannot touch them at all.
--   A roommate profile holds a phone number AND the answers used
--   to judge a person; if anon could read the pool, anyone with
--   the published anon key could download the whole matching
--   dataset, and if anon could INSERT a profile, they could write
--   one that scores against everyone. Both directions are closed.
--   The public page reaches this data only through
--   netlify/functions/roommate-match.js, which holds the
--   service-role key server-side and answers with scrubbed cards.
--
-- WHY THE TOKEN IS HASHED
--   A student owns their profile with a private link — the same
--   model as the draft-invite link. The token is the only key to
--   it, so what is stored is its SHA-256 hash (token_hash), never
--   the token itself. A dump of this table cannot be replayed
--   against the API. The raw token is returned to the browser once,
--   at creation, and never again.
--
-- PREREQUISITE: run supabase-team-roles.sql first. Every policy
-- below is scoped with public.arzuz_role(), and this file refuses to
-- create an unprotected table rather than guess at the role model.
--
-- Run it on a live database without touching existing rows.
-- ============================================================


-- ------------------------------------------------------------
-- 1. TABLES
-- ------------------------------------------------------------

create table if not exists roommate_profiles (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- SHA-256 hex of the private token. Unique: two profiles can
  -- never share a key. The raw token exists only in the student's
  -- browser, so there is nothing here to decrypt.
  token_hash   text not null unique,

  payload      jsonb not null,
  session      text,
  env          text default 'production',
  source       text,
  referrer     text,
  user_agent   text,
  status       text not null default 'open',  -- open / matched / closed
  notes        text,

  -- Generated columns for the dashboard. The questionnaire can
  -- change without a migration; the fields the team filters and
  -- sorts on are pulled out here.
  first_name   text    generated always as (payload->>'name')    stored,
  phone        text    generated always as (payload->>'phone')   stored,
  gender       text    generated always as (payload->>'gender')  stored,
  area         text    generated always as (payload->>'area')    stored,
  sleep        text    generated always as (payload->>'sleep')   stored,
  wake         text    generated always as (payload->>'wake')    stored,
  cleanliness  text    generated always as (payload->>'clean')   stored,
  guests       text    generated always as (payload->>'guests')  stored,
  smoking      text    generated always as (payload->>'smoke')   stored,
  noise        text    generated always as (payload->>'noise')   stored,
  split_ok     text    generated always as (payload->>'split')   stored,
  dealbreakers jsonb   generated always as (payload->'dealbreakers') stored,

  -- Guarded on purpose. A bare (payload->>'budget')::integer aborts
  -- the whole INSERT the moment a browser sends "180,000" or "" —
  -- the student loses their questionnaire to a formatting detail.
  -- A non-numeric answer is stored as null instead; the scorer
  -- already treats a missing budget as unknown, not as zero.
  budget_ngn   integer generated always as (
                 case when payload->>'budget' ~ '^[0-9]+$'
                      then (payload->>'budget')::integer
                      else null end
               ) stored
);

-- One row per decision a student makes about another student.
-- The unique pair is what makes a repeat tap idempotent: the
-- function upserts, so tapping "Accept" twice cannot create two
-- rows or two notifications.
create table if not exists roommate_interests (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  from_ref   uuid not null references roommate_profiles(id) on delete cascade,
  to_ref     uuid not null references roommate_profiles(id) on delete cascade,
  decision   text not null check (decision in ('accept', 'pass')),

  unique (from_ref, to_ref),
  check (from_ref <> to_ref)   -- nobody matches with themselves
);


-- ------------------------------------------------------------
-- 2. ROW LEVEL SECURITY
-- ------------------------------------------------------------
-- anon: no policy at all, in either direction. This is the point
-- of the module — see the header. The service-role key used by
-- the match function bypasses RLS, which is exactly how the
-- public page reaches its own data and nothing else.

alter table roommate_profiles  enable row level security;
alter table roommate_interests enable row level security;

-- Fail loudly, and early, if the role model is not in place.
--
-- Writing these policies without public.arzuz_role() would mean falling
-- back to `using (true)` — one role, not four — which would hand a pool
-- of student phone numbers to every signed-in login, including the
-- marketing one the whole role split exists to keep out of contact
-- data. The SQL editor runs this file as a single transaction, so
-- raising here leaves nothing half-built behind it.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'arzuz_role'
  ) then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql first — the roommate policies are scoped by team role and will not fall back to a single one.';
  end if;
end $$;

-- Re-runnable, exactly like supabase-media-booking.sql.
drop policy if exists "admin can read roommate profiles"    on roommate_profiles;
drop policy if exists "support can read roommate profiles"  on roommate_profiles;
drop policy if exists "admin can update roommate profiles"  on roommate_profiles;
drop policy if exists "admin can delete roommate profiles"  on roommate_profiles;
drop policy if exists "admin can read roommate interests"   on roommate_interests;
drop policy if exists "support can read roommate interests" on roommate_interests;
drop policy if exists "admin can update roommate interests" on roommate_interests;
drop policy if exists "admin can delete roommate interests" on roommate_interests;

-- SELECT: admin and support, the two roles that work with students.
-- Postgres ORs multiple permissive policies, so these two compose into
-- "role in (admin, support)".
-- Marketing is absent on purpose: growth reads the PII-free views, and
-- a roommate profile is a phone number plus the answers used to judge
-- a person.
create policy "admin can read roommate profiles"
  on roommate_profiles for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read roommate profiles"
  on roommate_profiles for select to authenticated
  using (public.arzuz_role() = 'support');

-- UPDATE / DELETE: admin only. Support can read the pool to answer a
-- student on the phone; changing or erasing someone's profile is not
-- that.
create policy "admin can update roommate profiles"
  on roommate_profiles for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "admin can delete roommate profiles"
  on roommate_profiles for delete to authenticated
  using (public.arzuz_role() = 'admin');

create policy "admin can read roommate interests"
  on roommate_interests for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read roommate interests"
  on roommate_interests for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin can update roommate interests"
  on roommate_interests for update to authenticated
  using (public.arzuz_role() = 'admin')
  with check (public.arzuz_role() = 'admin');

create policy "admin can delete roommate interests"
  on roommate_interests for delete to authenticated
  using (public.arzuz_role() = 'admin');


-- ------------------------------------------------------------
-- 3. TABLE GRANTS — RLS decides which rows, grants decide which
-- operations are even possible. Belt and braces: a policy typo
-- must not hand anon a read of every phone number in the pool.
-- ------------------------------------------------------------
-- Supabase's default privileges grant ALL on every new table to
-- anon. Strip that back to nothing here.
revoke all on roommate_profiles, roommate_interests from anon;

revoke all on roommate_profiles, roommate_interests from authenticated;
grant select, update, delete on roommate_profiles  to authenticated;
grant select, update, delete on roommate_interests to authenticated;
-- Deliberately NOT granted to authenticated: insert. Profiles
-- arrive through the match function, which validates them. A
-- dashboard typo must not be able to create a matchable person.


-- ------------------------------------------------------------
-- 4. INDEXES
-- ------------------------------------------------------------

create index if not exists idx_roommate_profiles_created on roommate_profiles (created_at desc);
create index if not exists idx_roommate_profiles_status  on roommate_profiles (status);
create index if not exists idx_roommate_profiles_env     on roommate_profiles (env);
create index if not exists idx_roommate_profiles_area    on roommate_profiles (area);
-- the pool the function scans: open, production profiles
create index if not exists idx_roommate_pool
  on roommate_profiles (env, status, created_at desc);
create index if not exists idx_roommate_interests_from on roommate_interests (from_ref);
create index if not exists idx_roommate_interests_to   on roommate_interests (to_ref);


-- ------------------------------------------------------------
-- 5. THE CONSENT TRAIL — roommate_events
-- ------------------------------------------------------------
-- Why this table exists, when roommate_interests already records
-- every decision:
--
--   roommate_interests is CURRENT STATE. (from_ref, to_ref) is unique
--   and the function upserts, so a student who accepts and then
--   changes their mind leaves ONE row saying 'pass'. The record of
--   that they said yes first — and when — is gone. That is exactly
--   the question a dispute asks: "when did this pair unlock, and did
--   both of them actually agree at that moment?"
--
--   So every action also APPENDS a row here. Nothing in the codebase
--   updates or deletes one: there is no insert/update/delete policy
--   for any client role, and the grants below give `authenticated`
--   SELECT only. The service-role key used by roommate-match.js is
--   the sole writer. Append-only is therefore enforced by the
--   database, not by the convention of the code that writes it.
--
--   The same table carries one non-decision event, 'viewed': the first
--   time a matched student is shown their match's contact details.
--   It is here rather than in a log of its own because it is part of
--   the answer to "was this number shown to them, and when" — and it
--   is what lets the daily digest (netlify/functions/roommate-digest.js)
--   tell a live match from one nobody has opened.
--
-- WHY THERE ARE NO FOREIGN KEYS
--   The whole point is to survive the thing it documents. Admin can
--   delete a profile (policy below); a trail that cascaded away with
--   it would evaporate at precisely the moment someone needs it. The
--   ids are kept as plain uuid, and the two NAMES are snapshotted
--   next to them, so a dispute can be read years later without a
--   profile row to join to.

create table if not exists roommate_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),

  -- created   — a student finished the questionnaire
  -- accept    — said yes to another student (one side only)
  -- pass      — said no
  -- withdrawn — closed their own profile
  -- matched   — the second yes landed: contact details unlocked for both
  -- viewed    — a matched student was shown the other one's contact
  --             details (written once per pair, on the first visit)
  event      text not null check (event in ('created', 'accept', 'pass', 'withdrawn', 'matched', 'viewed')),

  -- The student who acted, and the one they acted on. For 'created'
  -- and 'withdrawn' both point at the same profile; for 'matched' the
  -- actor is whoever completed the pair.
  actor_ref    uuid,
  subject_ref  uuid,
  actor_name   text,
  subject_name text,

  env        text default 'production',
  session    text
);

-- 'viewed' was added after the first deployments, and `create table if
-- not exists` above is a no-op on a database that already has the
-- table — so the CHECK is re-stated here. Without this an existing
-- install would reject every 'viewed' write with a 23514, the trail
-- write would fail, and the only visible symptom would be a log line
-- in Netlify plus a digest that never has a follow-through signal.
-- Re-runnable: the drop is conditional.
alter table roommate_events drop constraint if exists roommate_events_event_check;
alter table roommate_events add constraint roommate_events_event_check
  check (event in ('created', 'accept', 'pass', 'withdrawn', 'matched', 'viewed'));

alter table roommate_events enable row level security;

drop policy if exists "admin can read roommate events"   on roommate_events;
drop policy if exists "support can read roommate events" on roommate_events;

-- Read-only, and the same two roles that can already read a profile:
-- a trail nobody can read answers no dispute. Note what is absent —
-- there is deliberately no INSERT, UPDATE or DELETE policy for any
-- client role, in either direction, for either admin or support.
create policy "admin can read roommate events"
  on roommate_events for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read roommate events"
  on roommate_events for select to authenticated
  using (public.arzuz_role() = 'support');

revoke all on roommate_events from anon;
revoke all on roommate_events from authenticated;
-- SELECT and nothing else. A dashboard bug cannot edit history, and
-- a compromised `authenticated` session cannot erase its own trail.
grant select on roommate_events to authenticated;

create index if not exists idx_roommate_events_created on roommate_events (created_at desc);
create index if not exists idx_roommate_events_actor   on roommate_events (actor_ref);
create index if not exists idx_roommate_events_env     on roommate_events (env);


-- ------------------------------------------------------------
-- 6. VIEWS — what the dashboard reads.
-- security_invoker = true means each view runs with the caller's
-- privileges: an anonymous caller fails closed, because anon has
-- no grant on the underlying tables at all.
-- ------------------------------------------------------------

-- Mutual accepts, written once because two views need them.
-- a.from_ref < a.to_ref keeps each pair to a single row: without
-- it every match would be counted twice, once from each side.
create or replace view roommate_mutual_pairs
with (security_invoker = true) as
with accepts as (
  select from_ref, to_ref, created_at from roommate_interests where decision = 'accept'
),
mutual as (
  select a.from_ref, a.to_ref, greatest(a.created_at, b.created_at) as matched_at
  from accepts a
  join accepts b on b.from_ref = a.to_ref and b.to_ref = a.from_ref
  where a.from_ref < a.to_ref
)
select
  m.matched_at,
  m.from_ref                                        as a_id,
  a.first_name                                      as a_name,
  a.phone                                           as a_phone,
  a.area                                            as a_area,
  a.budget_ngn                                      as a_budget,
  coalesce(a.payload->>'split', '')                 as a_split,
  m.to_ref                                          as b_id,
  b.first_name                                      as b_name,
  b.phone                                           as b_phone,
  b.area                                            as b_area,
  b.budget_ngn                                      as b_budget,
  coalesce(b.payload->>'split', '')                 as b_split,
  -- Both sides are always the same env — a student is only ever shown
  -- candidates from their own env (roommate-match.js → candidatePool) —
  -- and the daily digest filters on this so a pair created in a test run
  -- can never be reported to the team as a match going quiet.
  -- Appended at the END of the list on purpose: `create or replace view`
  -- only allows new columns there.
  coalesce(a.env, 'production')                     as env
from mutual m
join roommate_profiles a on a.id = m.from_ref
join roommate_profiles b on b.id = m.to_ref;

-- THE ONE NUMBER for this line, in the same shape as
-- roommate_match_summary so the dashboard can render it the same
-- way: the share of roommate profiles that reach a mutual match,
-- and the share that do it inside 14 days.
create or replace view roommate_engine_summary
with (security_invoker = true) as
with prof as (
  select id, created_at, status from roommate_profiles where env = 'production'
),
accepts as (
  select from_ref, to_ref, created_at from roommate_interests where decision = 'accept'
),
mutual as (
  select a.from_ref, a.to_ref, greatest(a.created_at, b.created_at) as matched_at
  from accepts a
  join accepts b on b.from_ref = a.to_ref and b.to_ref = a.from_ref
  where a.from_ref < a.to_ref
),
paired as (
  select p.id, p.created_at, m.matched_at
  from prof p
  join mutual m on m.from_ref = p.id or m.to_ref = p.id
)
select
  (select count(*) from prof)                                   as profiles_total,
  (select count(*) from prof where status = 'open')              as profiles_open,
  (select count(*) from prof where status = 'matched')           as profiles_matched,
  (select count(*) from mutual)                                  as mutual_pairs,
  (select count(*) from paired)                                  as profiles_matched_total,
  (select count(*) from paired
    where matched_at - created_at <= interval '14 days')         as matched_within_14d,
  case
    when (select count(*) from prof) = 0 then 0
    else round(100.0 * (select count(*) from paired
                        where matched_at - created_at <= interval '14 days')
               / (select count(*) from prof), 1)
  end                                                            as pct_matched_within_14d;

-- anon has no grant on these tables, so it cannot read the views
-- either; this revoke keeps the intent explicit and tidy.
revoke all on roommate_mutual_pairs, roommate_engine_summary from anon;

-- Support and marketing read the dashboard's PII-free growth views for
-- this line; the two above are the admin panel's, and neither is
-- writable (they aggregate and join, so Postgres will not make them
-- updatable). Narrowing the grant to SELECT says so out loud and stops
-- a future dashboard bug from ever attempting a write through one.
revoke all on roommate_mutual_pairs, roommate_engine_summary from authenticated;
grant select on roommate_mutual_pairs, roommate_engine_summary to authenticated;


-- ------------------------------------------------------------
-- 7. CHECK IT WORKED
-- ------------------------------------------------------------
-- From the browser console on the live site, using the anon key
-- that is in assets/config.js:
--
--   // must come back [] — anon cannot read the roommate pool
--   fetch(SUPABASE_URL + '/rest/v1/roommate_profiles?select=id',
--     { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => r.json()).then(console.log)
--
--   // must FAIL — anon cannot insert itself into the pool
--   fetch(SUPABASE_URL + '/rest/v1/roommate_profiles',
--     { method: 'POST', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
--       body: JSON.stringify({ token_hash: 'x', payload: {} }) })
--     .then(r => console.log(r.status))   // 401/403, never 201
--
--   // must come back [] — no interest rows leak either
--   fetch(SUPABASE_URL + '/rest/v1/roommate_interests?select=id',
--     { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => r.json()).then(console.log)
--
--   // as a SUPPORT or MARKETING login: 200 with [], NOT an error.
--   // RLS filters rows rather than refusing the request, because the
--   // SELECT grant still belongs to authenticated; a 403 here would
--   // mean a missing grant, which is a different (worse) bug. The
--   // dashboard relies on this: admin.js signs the session out on 403.
--
--   // The trail is APPEND-ONLY, so unlike the tables above these must be
--   // a real 401/403 — a missing grant, not a filtered read. If either
--   // of these ever answers 201 or 204, the audit trail is writable and
--   // the guarantee is gone:
--   fetch(SUPABASE_URL + '/rest/v1/roommate_events',
--     { method: 'POST', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
--       body: JSON.stringify({ event: 'accept' }) })
--     .then(r => console.log(r.status))   // 401/403, never 201
--
--   fetch(SUPABASE_URL + '/rest/v1/roommate_events?id=eq.1',
--     { method: 'DELETE', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ADMIN_SESSION_TOKEN } })
--     .then(r => console.log(r.status))   // 401/403 — admin cannot erase history
--
-- Then complete the questionnaire at /roommates and confirm the
-- dashboard's Roommate panel shows the profile, and that answering
-- 'accept' adds a line to the consent trail below the pool.
--
-- One more, for the follow-through signal: once a pair is matched,
-- open /roommates?t=<A's link> AGAIN. Exactly one row with
-- event = 'viewed' must appear for that pair, and a second reload must
-- add none:
--
--   select event, actor_name, subject_name, created_at
--   from roommate_events where event = 'viewed' order by created_at desc;
--
-- No 'viewed' rows at all, after a matched student has loaded their
-- matches page, means the check constraint above was not applied —
-- re-run this file.
