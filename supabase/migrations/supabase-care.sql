-- ============================================================
-- ARZUZ — Arzuz Care as service credits
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- WHAT CARE IS, AS THE SITE ALREADY SELLS IT
--   care.html is the specification, and it is public: ₦20,000 for
--   the session, optional, never folded into rent, refundable before
--   the session starts, covering up to FOUR call-outs, parts under
--   ₦3,000 included, a verified worker within 48 hours. This file
--   puts that promise in the database. It does not change it: the
--   price is a flat ₦20,000 and nothing here derives it from rent.
--
-- THE FIVE RULES THIS ENCODES
--
--   1. ONE CREDIT = ONE CALL-OUT. A session is 4 credits.
--      The unit is enforced, not documented: 'spent' may only ever
--      be -1 (see the CHECK below), so a call-out cannot be charged
--      as two credits by a later bug.
--
--   2. THE BALANCE IS A LEDGER, NOT A COUNTER. care_credit_events
--      is append-only and the balance is its sum — the same shape as
--      the consent trail (roommate_events), for the same reason: a
--      counter can be edited to hide what happened, and "how many
--      call-outs does this student have left, and who took them"
--      is a question that gets asked when someone is unhappy.
--
--   3. THE TEAM WRITES, THE STUDENT NEVER DOES. Support records the
--      visit; the server-side function (netlify/functions/care-credit.js)
--      holds the service key and appends the row. No client role has
--      INSERT on either table, so a student cannot award themselves
--      a call-out and a dashboard typo cannot either.
--
--   4. SESSION-SCOPED. Credits belong to one session ('2026/2027')
--      and are zeroed by an 'expired' row when it ends. Nothing
--      rolls over by itself.
--
--   5. THE PRICE STAYS AS PUBLISHED. ₦20,000 flat, four credits.
--      No percentage of rent, no tier-dependent pricing.
--
-- WHY THERE IS NO FOREIGN KEY FROM THE LEDGER TO THE PLAN
--   Same reasoning as the consent trail. The ledger is the record of
--   money and work; if a plan row were ever removed, a cascading
--   ledger would evaporate exactly when someone asks what happened.
--   plan_id is a plain uuid and the student's name and session are
--   snapshotted onto every row, so a balance can be read without the
--   plan it belongs to. The rollup view below reads the ledger ALONE
--   for that reason.
--
-- WHY NO CLIENT MAY UPDATE A PLAN EITHER
--   Every state change — grant, spend, refund, expire, correction —
--   goes through the function, so it writes its ledger row in the
--   same breath. If the dashboard could flip a plan's status by
--   hand, a plan could read 'refunded' with credits still unspent,
--   and the two records would tell different stories. Read-only in
--   the dashboard, write-once server-side.
--
-- PREREQUISITE: run supabase-team-roles.sql first — the policies
-- below are scoped with public.arzuz_role(), and this file refuses
-- to create an unprotected table rather than guess at the role model.
--
-- Additive and re-runnable: it never touches an existing row.
-- ============================================================


-- ------------------------------------------------------------
-- 1. TABLES
-- ------------------------------------------------------------

-- One paid session. The student owns it with a private link, the
-- same model as a roommate profile and a draft invite: the raw
-- token is returned once and only its SHA-256 hash is stored, so a
-- dump of this table cannot be replayed against the API.
create table if not exists care_plans (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  token_hash   text not null unique,

  -- '2026/2027'. Credits belong to exactly one session.
  session      text not null,
  env          text default 'production',
  status       text not null default 'active',

  -- What was actually paid. A default rather than a constant: a
  -- goodwill plan or a discounted one is a fact about a row, and
  -- hard-coding 20000 here would make that fact unrecordable.
  amount_ngn   integer not null default 20000,

  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,          -- null = it ends with the session

  payload      jsonb not null,
  source       text,
  referrer     text,
  user_agent   text,
  notes        text,

  -- Generated columns for the dashboard, exactly like the roommate
  -- profile: the payload can grow without a migration, and the
  -- fields the team sorts on are pulled out here.
  first_name   text generated always as (payload->>'name')     stored,
  phone        text generated always as (payload->>'phone')    stored,
  area         text generated always as (payload->>'area')     stored,
  property     text generated always as (payload->>'property') stored,

  constraint care_plans_status_check check (status in ('active', 'ended', 'refunded')),
  constraint care_plans_amount_check check (amount_ngn > 0)
);

-- The ledger. Append-only by grant and by the absence of any policy
-- that would let a client write to it.
create table if not exists care_credit_events (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),

  -- Deliberately NOT a foreign key — see the header.
  plan_id      uuid not null,
  student_name text,
  session      text,

  -- granted   +4  the session's four call-outs, written when it is sold
  -- spent     -1  one call-out completed by a worker
  -- refunded  -n  the session was cancelled and the credits voided
  -- expired   -n  the session ended with credits left over
  -- adjusted  ±n  a correction, always with a reason, never an edit
  event        text not null,
  delta        integer not null,

  reason       text,
  worker       text,        -- who did the work, for 'spent'
  parts_ngn    integer,     -- parts cost, against the ₦3,000 ceiling
  note         text,

  actor_ref    uuid,        -- the team member who recorded it
  actor_name   text,
  env          text default 'production',

  constraint care_credit_events_delta_nonzero check (delta <> 0),

  -- The unit and the direction, per event kind. 'spent' is exactly
  -- -1 so that one call-out can never be charged as two credits.
  constraint care_credit_events_shape_check check (
    (event = 'granted'  and delta > 0) or
    (event = 'spent'    and delta = -1) or
    (event in ('refunded', 'expired') and delta < 0) or
    (event = 'adjusted' and delta <> 0)
  ),
  constraint care_credit_events_event_check check (
    event in ('granted', 'spent', 'refunded', 'expired', 'adjusted')
  ),
  constraint care_credit_events_parts_check check (parts_ngn is null or parts_ngn >= 0)
);

-- Both constraints are re-stated, and that is not belt-and-braces for
-- its own sake: `create table if not exists` is a no-op on a database
-- that already has the table, so a future widening of either rule
-- would never reach an existing install — it would reject the write
-- with a 23514 whose only symptom is a log line in Netlify. This is
-- how the 'viewed' event was added to roommate_events, and it is
-- done here BEFORE it is needed, while it is free.
alter table care_credit_events drop constraint if exists care_credit_events_event_check;
alter table care_credit_events add constraint care_credit_events_event_check
  check (event in ('granted', 'spent', 'refunded', 'expired', 'adjusted'));

alter table care_credit_events drop constraint if exists care_credit_events_shape_check;
alter table care_credit_events add constraint care_credit_events_shape_check
  check (
    (event = 'granted'  and delta > 0) or
    (event = 'spent'    and delta = -1) or
    (event in ('refunded', 'expired') and delta < 0) or
    (event = 'adjusted' and delta <> 0)
  );


-- ------------------------------------------------------------
-- 2. PREFLIGHT — fail loudly, and early
-- The SQL editor runs this file as a single transaction, so raising
-- here leaves nothing half-built behind it.
-- ------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'arzuz_role'
  ) then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql first — the Care policies are scoped by team role and will not fall back to a single one.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ------------------------------------------------------------
-- anon gets no policy at all, in either direction: a plan carries a
-- student's phone number and the record of what they were charged.
-- The public page reaches its own plan only through the function,
-- which holds the service-role key and bypasses RLS.

alter table care_plans         enable row level security;
alter table care_credit_events enable row level security;

drop policy if exists "admin can read care plans"     on care_plans;
drop policy if exists "support can read care plans"   on care_plans;
drop policy if exists "admin can read care credits"   on care_credit_events;
drop policy if exists "support can read care credits" on care_credit_events;

-- SELECT only, for the two roles that work with students. Marketing
-- is absent for the same reason it is absent from every policy that
-- holds a phone number, and there is no INSERT, UPDATE or DELETE
-- policy for ANY client role: every write arrives through the
-- function with the service key, which is what keeps a plan's status
-- and its ledger from ever disagreeing.
create policy "admin can read care plans"
  on care_plans for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read care plans"
  on care_plans for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin can read care credits"
  on care_credit_events for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support can read care credits"
  on care_credit_events for select to authenticated
  using (public.arzuz_role() = 'support');


-- ------------------------------------------------------------
-- 4. GRANTS — RLS decides which rows, grants decide which
-- operations are even possible.
-- ------------------------------------------------------------
-- Supabase's default privileges grant ALL on every new table to
-- anon, so this strips that back deliberately.
revoke all on care_plans, care_credit_events from anon;

revoke all on care_plans, care_credit_events from authenticated;
-- SELECT and nothing else. Not INSERT: credits are money, and they
-- are spent by the server that can write the ledger row beside them.
grant select on care_plans         to authenticated;
grant select on care_credit_events to authenticated;


-- ------------------------------------------------------------
-- 5. INDEXES
-- ------------------------------------------------------------

create index if not exists idx_care_plans_session  on care_plans (session);
create index if not exists idx_care_plans_status   on care_plans (status);
create index if not exists idx_care_plans_env      on care_plans (env);
create index if not exists idx_care_plans_created  on care_plans (created_at desc);

-- ONE ACTIVE PLAN PER STUDENT PER SESSION. Without this, a double
-- tap in the dashboard sells the same session twice and the student
-- quietly holds eight call-outs for one ₦20,000 payment. Partial, so
-- a refunded or ended plan does not block a legitimate re-purchase.
create unique index if not exists idx_care_plans_one_active
  on care_plans (session, phone) where status = 'active';

create index if not exists idx_care_events_plan    on care_credit_events (plan_id);
create index if not exists idx_care_events_created on care_credit_events (created_at desc);
create index if not exists idx_care_events_event   on care_credit_events (event);
create index if not exists idx_care_events_env     on care_credit_events (env);


-- ------------------------------------------------------------
-- 6. VIEWS — what the dashboard reads
-- ------------------------------------------------------------

-- The balance, computed from the LEDGER ALONE. No join to care_plans,
-- on purpose: the ledger is the record of money and work, and a
-- balance must still be readable after the plan row it belongs to is
-- gone. The student's name comes from the most recent row that
-- carried one.
create or replace view care_credit_balance
with (security_invoker = true) as
select
  plan_id,
  (array_agg(student_name order by created_at desc))[1]  as student_name,
  (array_agg(session      order by created_at desc))[1]  as session,
  sum(delta)::int                                        as balance,
  coalesce(sum(delta) filter (where event = 'granted'), 0)::int  as granted,
  count(*) filter (where event = 'spent')                as call_outs,
  count(*) filter (where event = 'refunded') > 0         as refunded,
  count(*) filter (where event = 'expired')  > 0         as expired,
  min(created_at)                                        as first_event_at,
  max(created_at)                                        as last_event_at
from care_credit_events
group by plan_id;

-- What the dashboard panel lists: one row per plan, with its balance
-- beside it. security_invoker, so a role that cannot read the base
-- tables reads nothing through this either.
create or replace view care_plans_live
with ( security_invoker = true ) as
select
  p.id,
  p.created_at,
  p.session,
  p.status,
  p.env,
  p.amount_ngn,
  p.starts_at,
  p.ends_at,
  p.first_name,
  p.phone,
  p.area,
  p.property,
  p.notes,
  coalesce(b.balance, 0)    as balance,
  coalesce(b.call_outs, 0)  as call_outs,
  coalesce(b.granted, 0)    as granted,
  b.last_event_at,
  (coalesce(b.balance, 0) > 0) as has_credits
from care_plans p
left join care_credit_balance b on b.plan_id = p.id;

revoke all on care_credit_balance, care_plans_live from anon;
revoke all on care_credit_balance, care_plans_live from authenticated;
grant select on care_credit_balance, care_plans_live to authenticated;


-- ------------------------------------------------------------
-- 7. CHECK IT WORKED
-- ------------------------------------------------------------
-- From the browser console on the live site with the anon key from
-- assets/config.js:
--
--   // must come back [] — anon cannot read a plan or a balance
--   fetch(SUPABASE_URL + '/rest/v1/care_plans_live?select=id',
--     { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => r.json()).then(console.log)
--
--   // must FAIL — anon cannot award itself four call-outs
--   fetch(SUPABASE_URL + '/rest/v1/care_credit_events',
--     { method: 'POST', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
--       body: JSON.stringify({ plan_id: '…', event: 'granted', delta: 4 }) })
--     .then(r => console.log(r.status))   // 401/403, never 201
--
--   // as an ADMIN session: must ALSO fail. Credits are written by the
--   // server with the service key, so a signed-in teammate cannot
--   // invent a call-out either — and cannot erase one:
--   fetch(SUPABASE_URL + '/rest/v1/care_credit_events',
--     { method: 'POST', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ADMIN_SESSION_TOKEN, 'Content-Type': 'application/json' },
--       body: JSON.stringify({ plan_id: '…', event: 'granted', delta: 4 }) })
--     .then(r => console.log(r.status))   // 401/403
--
--   fetch(SUPABASE_URL + '/rest/v1/care_credit_events?id=eq.1',
--     { method: 'DELETE', headers: { apikey: ANON_KEY,
--       Authorization: 'Bearer ' + ADMIN_SESSION_TOKEN } })
--     .then(r => console.log(r.status))   // 401/403 — nobody can erase the ledger
--
--   // as a SUPPORT login: 200 with rows, not an error. RLS filters
--   // rows; a 403 would mean a missing grant, which is a different
--   // (worse) bug — admin.js signs the session out on a 403.
--
-- Then, in the SQL editor:
--
--   -- one row per plan, balance = granted - spent - refunded - expired
--   select plan_id, student_name, session, balance, granted, call_outs
--     from care_credit_balance order by last_event_at desc;
--
--   -- must be 0 rows: a plan's balance can never be counted twice
--   select plan_id, count(*) from care_credit_balance
--    group by plan_id having count(*) > 1;
--
--   -- the four call-outs of one session, in order
--   select event, delta, worker, parts_ngn, reason, created_at
--     from care_credit_events where plan_id = '<uuid>' order by created_at;
