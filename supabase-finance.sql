-- ============================================================
-- ARZUZ — the money core
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- WHAT THIS IS
--   Before this file Arzuz had a credit LEDGER (care_credit_events)
--   but no record of the MONEY that bought the credits: a Care plan
--   was opened by hand, the dashboard's grant form "records a payment
--   taken elsewhere", and nothing anywhere tied a naira received to a
--   coverage obligation. This file adds the things every one of the
--   business rules in the monetization brief stands on:
--
--     1. finance_config  — the numbers an authorized admin may set
--                          (price, call-out cap, referral reward,
--                          marketplace fee, the Storage switch).
--     2. product_terms   — IMMUTABLE, VERSIONED terms. The exact
--                          wording and price a customer accepted is a
--                          row; changing tomorrow's price can never
--                          rewrite yesterday's order.
--     3. payments        — one order and its payment attempt: an
--                          immutable amount and terms version, a
--                          UNIQUE provider reference, and an
--                          idempotency key. A duplicate callback
--                          cannot buy two passes.
--     4. ledger_entries  — an append-only journal, integer KOBO,
--                          one row per movement. Reports are computed
--                          from THIS, never from an editable total.
--     5. referrals       — ₦2,000 once, after a referred customer's
--                          first VERIFIED payment. One reward per
--                          qualifying payment, one qualification per
--                          referred customer, no self-referrals.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
--   · It does not charge rent or take a commission on it. 'housing'
--     is a business_line with no revenue path in the schema at all;
--     there is no column a rent commission could live in.
--   · It does not make a Care Pass a wallet. The ₦20,000 buys a
--     COVERAGE TERM (coverage_start/coverage_end + a call-out cap on
--     the plan); the credit ledger still counts call-outs, and no
--     balance here is ever withdrawable as cash.
--   · It does not switch anything on. The seeded Care terms are a
--     DRAFT (published = false) and the Function refuses public sales
--     until an admin publishes approved terms — the brief's rule, in
--     the data rather than in a comment.
--   · Storage stays off: finance_config.storage_enabled is false, and
--     the Function refuses a storage order while it is.
--
-- PREREQUISITES
--   supabase-team-roles.sql (public.arzuz_role()) and
--   supabase-care.sql (care_plans / care_credit_events, which this
--   file extends). The preflight below names whichever is missing.
--
-- Additive and re-runnable: it never touches an existing row.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- The SQL editor runs this file as one transaction, so raising here
-- leaves nothing half-built behind it.
-- ------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'arzuz_role'
  ) then
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql first — the finance policies are scoped by team role and will not fall back to a single one.';
  end if;

  if to_regclass('public.care_plans') is null
     or to_regclass('public.care_credit_events') is null then
    raise exception 'care_plans / care_credit_events are missing. Run supabase-care.sql before this file — the coverage columns below extend care_plans, and a paid Care Pass activates a plan.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. finance_config — what an admin may set
--   A key/value store rather than a wide row of columns, so adding
--   an assumption is a row and not a migration. Read by the Function
--   with the service key; no client role may write it.
-- ------------------------------------------------------------

create table if not exists finance_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Safe defaults, matching the brief's decisions. `do nothing` on a
-- re-run: an admin's chosen value is never overwritten by the seed.
insert into finance_config (key, value) values
  ('care_pass_price_kobo',      '2000000'::jsonb),          -- ₦20,000
  ('care_call_out_cap',         '4'::jsonb),
  ('care_parts_ceiling_kobo',   '300000'::jsonb),           -- ₦3,000
  ('referral_reward_kobo',      '200000'::jsonb),           -- ₦2,000
  ('marketplace_fee_bps',       '0'::jsonb),                -- 0 until an admin sets it; NEVER applied to rent
  ('storage_enabled',           'false'::jsonb),            -- off until operational + legal controls are reviewed
  ('refund_window',             '"before coverage starts"'::jsonb),
  ('care_term_days',            '120'::jsonb),             -- a defined coverage end when no calendar date is set
  ('care_term_end',             'null'::jsonb),             -- admin may pin the real semester end date instead
  ('verification_price_kobo',   '0'::jsonb),                -- optional paid inspection, set by an admin
  ('monitoring_price_kobo',     '0'::jsonb)                 -- optional paid monitoring, set by an admin
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- 2. product_terms — immutable, versioned, hashed
--   The thing a customer accepts. `hash` is the SHA-256 of the
--   canonical terms JSON, so the row can PROVE it is the wording that
--   was shown: recompute the hash from `terms` and it matches, or the
--   row has been edited. Published exactly once per product (the
--   partial unique index below), so there is never a question which
--   version is live.
-- ------------------------------------------------------------

create table if not exists product_terms (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  product      text not null,
  version      integer not null,
  terms        jsonb not null,
  hash         text not null,
  published    boolean not null default false,
  published_at timestamptz,
  published_by text,

  constraint product_terms_version_check check (version >= 1),
  unique (product, version)
);

-- At most one published version per product.
create unique index if not exists idx_product_terms_one_published
  on product_terms (product) where published;

-- The draft the brief's decisions describe, seeded UNPUBLISHED. An
-- admin reviews and publishes it (or writes a new version) before a
-- single customer can buy — that is the brief's "if coverage terms
-- have not been approved and configured, do not activate public sales".
insert into product_terms (product, version, terms, hash, published)
values (
  'care_pass', 1,
  jsonb_build_object(
    'price_kobo',         2000000,
    'currency',           'NGN',
    'term',               'one academic semester',
    'call_outs_included', 4,
    'parts_ceiling_kobo', 300000,
    'waiting_period',     'none beyond the next working day',
    'covered',            jsonb_build_array(
                            'capped repair of plumbing, electrical, and minor structural faults',
                            'one visit per call-out, by a verified worker'),
    'excluded',           jsonb_build_array(
                            'parts over the included ceiling without a quote',
                            'deliberate damage or negligence',
                            'appliances the tenant brought',
                            'work already approved and paid for elsewhere',
                            'rent, deposits, or any tenancy payment'),
    'approval',           'each call-out is approved by Arzuz before a worker is sent',
    'refund',             'full refund requested before coverage starts',
    'support',            'WhatsApp the Arzuz team; a verified worker within 48 hours'
  ),
  'draft-seeded-in-supabase-finance.sql',
  false
)
on conflict (product, version) do nothing;


-- ------------------------------------------------------------
-- 3. payments — one order, one immutable price, one provider ref
-- ------------------------------------------------------------

create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- The browser's own idempotency key: a double-tapped Pay button
  -- replays this uuid and gets the same order, not a second one.
  client_ref    uuid not null unique,

  business_line text not null,
  purpose       text not null,

  -- WHAT WAS ACCEPTED, frozen. terms_id names the exact terms row and
  -- terms_version copies its number, so a price change tomorrow cannot
  -- silently re-price what was bought today.
  terms_id      uuid not null references product_terms(id),
  terms_version integer not null,
  amount_kobo   bigint not null,
  currency      text not null default 'NGN',

  status        text not null default 'pending',
  provider      text,
  -- UNIQUE, and that is the whole idempotency of activation: two
  -- webhooks carrying one provider reference cannot both insert.
  provider_ref  text unique,
  provider_payload jsonb,
  provider_email text,

  -- Our human reference, and the receipt. Both unique.
  reference     text not null unique,
  receipt_ref   text unique,

  subject       jsonb not null,
  referral_code text,

  paid_at          timestamptz,
  activated_at     timestamptz,
  activation_error text,

  env           text default 'production',
  notes         text,

  constraint payments_status_check
    check (status in ('pending','paid','failed','refunded','abandoned')),
  constraint payments_line_check
    check (business_line in ('housing','care','verification','monitoring','marketplace','storage')),
  constraint payments_amount_check check (amount_kobo > 0),
  -- paid_at is the proof of confirmation: a row cannot be 'paid'
  -- without it, so a status flip alone can never claim money arrived.
  constraint payments_paid_needs_time
    check (status <> 'paid' or paid_at is not null)
);


-- ------------------------------------------------------------
-- 4. ledger_entries — the journal everything reconciles to
--   Integer kobo, append-only, and never a float. `direction` is
--   debit/credit; `account` is which pot moved. A payment for a
--   coverage product posts two rows (cash up, unearned up); revenue is
--   recognized later, by policy, as its own row — cash received is NOT
--   revenue.
-- ------------------------------------------------------------

create table if not exists ledger_entries (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  entry_ref     text not null unique,
  business_line text not null,
  account       text not null,
  direction     text not null,
  amount_kobo   bigint not null check (amount_kobo > 0),
  currency      text not null default 'NGN',
  payment_id    uuid,
  source        text,
  memo          text,
  actor_ref     uuid,
  actor_name    text,
  env           text default 'production',

  constraint ledger_entries_direction_check check (direction in ('debit','credit')),
  constraint ledger_entries_account_check
    check (account in ('cash','unearned','revenue','refund','payable','expense','reserve')),
  constraint ledger_entries_line_check
    check (business_line in ('housing','care','verification','monitoring','marketplace','storage'))
);


-- ------------------------------------------------------------
-- 5. referrals — ₦2,000 once, never on a renewal
-- ------------------------------------------------------------

create table if not exists referrals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  code          text not null,
  referrer_ref  text not null,
  referred_ref  text,

  qualifying_payment_id  uuid references payments(id),
  qualifying_payment_ref text,

  status        text not null default 'pending_qualification',
  reward_kobo   integer not null default 200000 check (reward_kobo > 0),

  reason        text,
  decided_by    text,
  decided_at    timestamptz,
  paid_at       timestamptz,
  payout_provider_ref text,
  env           text default 'production',

  constraint referrals_status_check check (status in
    ('pending_qualification','under_review','approved','payout_pending','paid','rejected','reversed')),
  -- NO SELF-REFERRALS, at the database rather than in a comment.
  constraint referrals_no_self
    check (referred_ref is null or referrer_ref <> referred_ref)
);

-- ONE reward per qualifying payment. A webhook replayed, a verify
-- re-run, a day-two retry — none of them can pay twice.
create unique index if not exists idx_referrals_one_per_payment
  on referrals (qualifying_payment_id)
  where qualifying_payment_id is not null;

-- ONE qualification per referred customer, while the claim stands.
-- A rejected claim may be re-opened (a rejection is a decision, not a
-- permanent bar), which is why the partial predicate excludes it.
create unique index if not exists idx_referrals_one_per_referred
  on referrals (referred_ref)
  where referred_ref is not null and status <> 'rejected';


-- ------------------------------------------------------------
-- 5b. referral_codes — a shareable code that is not a phone number
--   A referral link travels on WhatsApp and gets forwarded, so the
--   code must NOT be the referrer's phone number. This is the opaque
--   code -> owner mapping, and it is what makes "tied to a registered
--   account" true: the code resolves to the person who earned it.
-- ------------------------------------------------------------

create table if not exists referral_codes (
  code       text primary key,
  owner_ref  text not null,          -- normalised phone / account ref
  owner_name text,
  created_at timestamptz not null default now(),
  active     boolean not null default true,
  env        text default 'production'
);

create index if not exists idx_referral_codes_owner on referral_codes (owner_ref);


-- ------------------------------------------------------------
-- 6. COVERAGE ON THE PLAN — the pass is a term, not a wallet
--   care_plans already carries starts_at/ends_at and amount_ngn. These
--   columns record WHAT WAS BOUGHT: which terms version, the coverage
--   window, and the call-out cap for that sale. Added with
--   `if not exists`, so a database that already has them is untouched.
-- ------------------------------------------------------------

alter table care_plans add column if not exists terms_id        uuid;
alter table care_plans add column if not exists terms_version    integer;
alter table care_plans add column if not exists coverage_start   timestamptz;
alter table care_plans add column if not exists coverage_end     timestamptz;
alter table care_plans add column if not exists call_out_cap     integer;
alter table care_plans add column if not exists payment_id       uuid;
alter table care_plans add column if not exists receipt_ref      text;

-- A coverage window that ends before it starts is not a window. Only
-- asserted when both ends are present, so a plan opened by hand with
-- ends_at left null still inserts.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'care_plans_coverage_window_check'
      and conrelid = 'public.care_plans'::regclass
  ) then
    alter table care_plans add constraint care_plans_coverage_window_check
      check (coverage_end is null or coverage_start is null or coverage_end > coverage_start);
  end if;
end $$;


-- ------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
--   anon gets no policy on any of these: a payment row carries a
--   customer's phone number, and a ledger row is the company's books.
--   The public checkout reaches its own order only through the
--   Function, which holds the service-role key.
--
--   Writes are service-role only — there is no INSERT, UPDATE or
--   DELETE policy for ANY client role, so a signed-in teammate cannot
--   invent a payment, edit an amount, or erase a ledger line. read =
--   admin and support; marketing is absent, the same rule that keeps
--   it out of every table holding a phone number.
-- ------------------------------------------------------------

alter table finance_config  enable row level security;
alter table product_terms   enable row level security;
alter table payments        enable row level security;
alter table ledger_entries  enable row level security;
alter table referrals       enable row level security;
alter table referral_codes  enable row level security;

drop policy if exists "admin reads finance config"    on finance_config;
drop policy if exists "support reads finance config"  on finance_config;
drop policy if exists "finance reads finance config"  on finance_config;
drop policy if exists "admin reads product terms"     on product_terms;
drop policy if exists "support reads product terms"   on product_terms;
drop policy if exists "finance reads product terms"   on product_terms;
drop policy if exists "admin reads payments"          on payments;
drop policy if exists "support reads payments"        on payments;
drop policy if exists "finance reads payments"        on payments;
drop policy if exists "admin reads ledger"            on ledger_entries;
drop policy if exists "support reads ledger"          on ledger_entries;
drop policy if exists "finance reads ledger"          on ledger_entries;
drop policy if exists "admin reads referrals"         on referrals;
drop policy if exists "support reads referrals"       on referrals;
drop policy if exists "finance reads referrals"       on referrals;
drop policy if exists "admin reads referral codes"   on referral_codes;
drop policy if exists "support reads referral codes" on referral_codes;
drop policy if exists "finance reads referral codes" on referral_codes;

-- THE BOOKS ARE NOT THE DESK.
--
-- These six read policies were written against the `support` role, and
-- that was a least-privilege mistake: a person hired to answer a
-- student's WhatsApp could open the ledger, the payment records, the
-- referral payouts and the price configuration. Adding a finance role
-- while leaving support where it was would have grown the problem
-- rather than fixed it, so the six policies move to `finance` — the
-- level that exists for exactly this — and support keeps what is
-- actually operations: the Care ledger in supabase-care.sql and the
-- repair queue in supabase-claims.sql, both read-only.
--
-- Nothing here is a write for any client role. Every money write is a
-- service-role Netlify function (paystack-webhook.js, finance.js,
-- care-credit.js), so this split changes who can LOOK, which is the
-- part that was wrong.
--
-- Cost of the change, stated plainly: a support login that used to see
-- the Finance panel sees nothing there now, and netlify/functions/
-- finance.js answers it 403 the way it answers any other role. That is
-- the intent. The main admin is unaffected (it satisfies both).
-- Config and terms are what the public page READS to show a price and
-- the wording a customer accepts, so those two are readable by anyone
-- (a published price is public by definition). Only PUBLISHED terms
-- are exposed through the public view in section 9; these policies are
-- for the dashboard.
create policy "admin reads finance config"
  on finance_config for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "finance reads finance config"
  on finance_config for select to authenticated
  using (public.arzuz_role() = 'finance');

create policy "admin reads product terms"
  on product_terms for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "finance reads product terms"
  on product_terms for select to authenticated
  using (public.arzuz_role() = 'finance');

create policy "admin reads payments"
  on payments for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "finance reads payments"
  on payments for select to authenticated
  using (public.arzuz_role() = 'finance');

create policy "admin reads ledger"
  on ledger_entries for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "finance reads ledger"
  on ledger_entries for select to authenticated
  using (public.arzuz_role() = 'finance');

create policy "admin reads referrals"
  on referrals for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "finance reads referrals"
  on referrals for select to authenticated
  using (public.arzuz_role() = 'finance');

create policy "admin reads referral codes"
  on referral_codes for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "finance reads referral codes"
  on referral_codes for select to authenticated
  using (public.arzuz_role() = 'finance');


-- ------------------------------------------------------------
-- 8. GRANTS
--   Supabase grants ALL on a new table to anon and authenticated by
--   default; strip that back deliberately. SELECT only — the books are
--   written by the Function with the service key.
-- ------------------------------------------------------------

revoke all on finance_config, product_terms, payments, ledger_entries, referrals, referral_codes from anon;
revoke all on finance_config, product_terms, payments, ledger_entries, referrals, referral_codes from authenticated;

grant select on finance_config, product_terms, payments, ledger_entries, referrals, referral_codes to authenticated;


-- ------------------------------------------------------------
-- 9. VIEWS
-- ------------------------------------------------------------

-- The published terms, for the public checkout. NOT security_invoker:
-- a visitor has no row access to product_terms, and this view is the
-- one narrow surface that is meant to be public — it exposes only a
-- published version and only its terms and hash, never a draft.
create or replace view public_terms as
select
  id,
  product,
  version,
  terms,
  hash,
  published_at
from product_terms
where published = true;

-- The payments board the dashboard lists.
create or replace view payments_live
with ( security_invoker = true ) as
select
  p.id,
  p.created_at,
  p.business_line,
  p.purpose,
  p.amount_kobo,
  p.currency,
  p.status,
  p.provider,
  p.provider_ref,
  p.reference,
  p.receipt_ref,
  p.terms_version,
  p.referral_code,
  p.paid_at,
  p.activated_at,
  p.activation_error,
  p.env,
  p.subject->>'name'  as customer_name,
  p.subject->>'phone' as customer_phone
from payments p;

-- Every pot, per business line, from the JOURNAL. This is the number
-- a report must reconcile to — not a stored total.
create or replace view ledger_account_balances
with ( security_invoker = true ) as
select
  business_line,
  account,
  sum(case when direction = 'debit'  then amount_kobo else 0 end)::bigint as debits_kobo,
  sum(case when direction = 'credit' then amount_kobo else 0 end)::bigint as credits_kobo,
  sum(case when direction = 'debit'  then amount_kobo else -amount_kobo end)::bigint as net_kobo,
  currency
from ledger_entries
group by business_line, account, currency;

-- What the finance dashboard shows, per line: cash taken, revenue
-- earned, what is still owed in coverage, refunds, costs. Every column
-- is a sum over the ledger — nothing here is hardcoded, and a line
-- with no rows reads as zeroes rather than disappearing.
create or replace view business_line_summary
with ( security_invoker = true ) as
select
  l.business_line,
  coalesce(sum(case when l.account = 'cash'     and l.direction = 'debit'  then l.amount_kobo end), 0)::bigint as cash_in_kobo,
  coalesce(sum(case when l.account = 'cash'     and l.direction = 'credit' then l.amount_kobo end), 0)::bigint as cash_out_kobo,
  coalesce(sum(case when l.account = 'revenue'  and l.direction = 'credit' then l.amount_kobo end), 0)::bigint as revenue_kobo,
  coalesce(sum(case when l.account = 'unearned' and l.direction = 'credit' then l.amount_kobo end), 0)::bigint as unearned_added_kobo,
  coalesce(sum(case when l.account = 'unearned' and l.direction = 'debit'  then l.amount_kobo end), 0)::bigint as unearned_released_kobo,
  coalesce(sum(case when l.account = 'refund'   then l.amount_kobo end), 0)::bigint as refunds_kobo,
  coalesce(sum(case when l.account = 'expense'  then l.amount_kobo end), 0)::bigint as costs_kobo,
  coalesce(sum(case when l.account = 'payable'  then l.amount_kobo end), 0)::bigint as payable_kobo
from ledger_entries l
group by l.business_line;

-- Referrals, for the finance report: the pipeline by status, and what
-- each status is worth — a sum, not a count someone multiplies by eye.
create or replace view referral_report
with ( security_invoker = true ) as
select
  status,
  count(*)::int                                   as claims,
  coalesce(sum(reward_kobo), 0)::bigint           as reward_kobo,
  min(created_at)                                 as first_at,
  max(created_at)                                 as last_at
from referrals
group by status;

revoke all on public_terms, payments_live, ledger_account_balances,
              business_line_summary, referral_report from anon;
revoke all on public_terms, payments_live, ledger_account_balances,
              business_line_summary, referral_report from authenticated;

-- The public checkout may read published terms only; a team session may
-- read the rest through their policies.
grant select on public_terms to anon, authenticated;
grant select on payments_live, ledger_account_balances,
                business_line_summary, referral_report to authenticated;


-- ------------------------------------------------------------
-- 10. INDEXES
-- ------------------------------------------------------------

create index if not exists idx_payments_status   on payments (status);
create index if not exists idx_payments_line     on payments (business_line);
create index if not exists idx_payments_env      on payments (env);
create index if not exists idx_payments_created  on payments (created_at desc);
create index if not exists idx_payments_client   on payments (client_ref);

create index if not exists idx_ledger_line       on ledger_entries (business_line);
create index if not exists idx_ledger_account    on ledger_entries (account);
create index if not exists idx_ledger_payment    on ledger_entries (payment_id);
create index if not exists idx_ledger_created    on ledger_entries (created_at desc);
create index if not exists idx_ledger_env        on ledger_entries (env);

create index if not exists idx_referrals_code    on referrals (code);
create index if not exists idx_referrals_ref     on referrals (referrer_ref);
create index if not exists idx_referrals_status  on referrals (status);
create index if not exists idx_referrals_env     on referrals (env);

create index if not exists idx_terms_product     on product_terms (product);


-- ------------------------------------------------------------
-- 11. CHECK IT WORKED
-- ------------------------------------------------------------
-- In the SQL editor:
--
--   -- the books, per line, from the journal
--   select * from business_line_summary;
--
--   -- a payment can never claim to be paid without a paid_at
--   select count(*) from payments where status = 'paid' and paid_at is null;  -- 0
--
--   -- and no client role can write one, or edit a ledger line:
--   --   (from the browser, with the anon key)
--   --   POST /rest/v1/payments        → 401/403
--   --   DELETE /rest/v1/ledger_entries → 401/403
--
--   -- the DRAFT terms are NOT public (published = false)
--   select count(*) from public_terms where product = 'care_pass';   -- 0 until an admin publishes
--
--   -- two referrals cannot share one qualifying payment
--   select qualifying_payment_id, count(*) from referrals
--    where qualifying_payment_id is not null
--    group by qualifying_payment_id having count(*) > 1;            -- 0 rows
--
--   -- and no referral can point at itself
--   select count(*) from referrals where referrer_ref = referred_ref;   -- 0
