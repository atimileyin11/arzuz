-- ============================================================
-- ARZUZ — phone_tail: the duplicate check without the scan
--
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Run any time after supabase-waitlist-launch.sql. Safe to run more
-- than once. Nothing here drops a table, a column or a row.
--
-- WHY THIS FILE EXISTS
--
-- The waitlist door deduplicates same-number re-submissions by
-- fetching the last fifty rows of the table and comparing digits in
-- JavaScript (netlify/functions/waitlist.js → findExisting). At a
-- hundred submissions a day that is a rounding error; under a
-- traffic spike every single submit pays a fifty-row read before it
-- is even known to be new, and the spike pays for itself twice.
--
-- phone_tail stores the last ten digits of the contact number beside
-- the row, kept honest by a trigger (not by the function, which must
-- never be trusted with a column it also queries). The door asks
-- phone_tail=eq.<tail> first — one indexed row back — and only falls
-- back to the fifty-row scan when the column is not there yet, so a
-- database that predates this file behaves exactly as before.
--
-- The last ten digits are the same identity the scan uses ("0803 123
-- 4567" and "2348031234567" are the same subscriber), so the fast
-- path and the slow path cannot disagree about who is who.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.demand_records') is null
     or to_regclass('public.listings') is null then
    raise exception 'A waitlist table is missing. Run supabase-schema.sql first — it creates demand_records and listings, which this file extends.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE COLUMN, on every table the door writes
-- ------------------------------------------------------------
--
-- Nullable with a partial index: legacy rows are backfilled below,
-- but a row whose contact has fewer than ten digits is not a phone
-- number at all (see looksLikePhone in waitlist.js) and stays NULL
-- rather than indexing garbage every scan would trip over.

alter table public.demand_records    add column if not exists phone_tail text;
alter table public.listings          add column if not exists phone_tail text;
alter table public.scout_submissions add column if not exists phone_tail text;
alter table public.booking_requests  add column if not exists phone_tail text;
alter table public.support_tickets   add column if not exists phone_tail text;


-- ------------------------------------------------------------
-- 2. THE TRIGGER — the database decides, never the caller
-- ------------------------------------------------------------
--
-- The contact lives under different keys per form (phone on the
-- student form, ph / owner_phone on the landlord form — see FORMS
-- in waitlist.js), so every variant is tried in the same order the
-- door validates them. A value that cannot be a phone number leaves
-- NULL behind rather than a fragment the door would then match.
--
-- No RLS change: the column inherits its table's policies, the
-- service role bypasses them for the write, and anon never had
-- INSERT after supabase-close-public-inserts.sql anyway.

create or replace function public.populate_phone_tail()
returns trigger
language plpgsql
as $$
declare
  v text;
  d text;
begin
  v := coalesce(
    new.payload ->> 'phone',
    new.payload ->> 'ph',
    new.payload ->> 'owner_phone',
    ''
  );
  d := regexp_replace(v, '\D', '', 'g');
  if char_length(d) >= 10 then
    new.phone_tail := right(d, 10);
  else
    new.phone_tail := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_phone_tail on public.demand_records;
create trigger trg_phone_tail
  before insert or update of payload on public.demand_records
  for each row execute function public.populate_phone_tail();

drop trigger if exists trg_phone_tail on public.listings;
create trigger trg_phone_tail
  before insert or update of payload on public.listings
  for each row execute function public.populate_phone_tail();

drop trigger if exists trg_phone_tail on public.scout_submissions;
create trigger trg_phone_tail
  before insert or update of payload on public.scout_submissions
  for each row execute function public.populate_phone_tail();

drop trigger if exists trg_phone_tail on public.booking_requests;
create trigger trg_phone_tail
  before insert or update of payload on public.booking_requests
  for each row execute function public.populate_phone_tail();

drop trigger if exists trg_phone_tail on public.support_tickets;
create trigger trg_phone_tail
  before insert or update of payload on public.support_tickets
  for each row execute function public.populate_phone_tail();


-- ------------------------------------------------------------
-- 3. BACKFILL — rows written before the trigger existed
-- ------------------------------------------------------------
--
-- The trigger only fires on write, so every existing row gets one
-- honest UPDATE. Rows whose contact is not a phone number resolve
-- to NULL and are simply never matched by the fast path.

update public.demand_records set payload = payload where phone_tail is null;
update public.listings set payload = payload where phone_tail is null;
update public.scout_submissions set payload = payload where phone_tail is null;
update public.booking_requests set payload = payload where phone_tail is null;
update public.support_tickets set payload = payload where phone_tail is null;


-- ------------------------------------------------------------
-- 4. THE INDEX — one row back, not fifty
-- ------------------------------------------------------------

create index if not exists demand_records_phone_tail_idx
  on public.demand_records (phone_tail) where phone_tail is not null;
create index if not exists listings_phone_tail_idx
  on public.listings (phone_tail) where phone_tail is not null;
create index if not exists scout_submissions_phone_tail_idx
  on public.scout_submissions (phone_tail) where phone_tail is not null;
create index if not exists booking_requests_phone_tail_idx
  on public.booking_requests (phone_tail) where phone_tail is not null;
create index if not exists support_tickets_phone_tail_idx
  on public.support_tickets (phone_tail) where phone_tail is not null;
