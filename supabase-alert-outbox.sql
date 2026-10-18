-- ============================================================
-- ARZUZ — the alert outbox and the shared send throttle
--
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Run any time after supabase-waitlist-launch.sql. Safe to run more
-- than once. Nothing here drops a table, a column or a row.
--
-- WHY THIS FILE EXISTS
--
-- A submission is saved first and announced second: the browser
-- tells /api/notify only after the door answers 200
-- (assets/submit.js → deliver). If the student closes the page, the
-- network drops, or Telegram blinks at exactly that second, the row
-- sits in the database with nobody told — and nothing retries it.
-- Under a traffic spike the same gap widens: every save fires its
-- own Telegram call from whoever submitted it, with no shared
-- ceiling, because the per-minute caps live in each function
-- instance's memory (notify.js → recentSends) and Netlify runs as
-- many instances as it likes.
--
-- So the door now writes a second row, in alert_outbox, in the same
-- breath as the submission — and a scheduled drain
-- (netlify/functions/alert-drain.js) sends what is pending with
-- retries and a shared throttle. The outbox write is best-effort and
-- never fails the submission: an alert that did not get queued is a
-- missing message, while a submission refused over an alert is a
-- lost student.
--
-- alert_throttle() is the same idea as waitlist_throttle() for the
-- sending side: one counter in the database instead of one per
-- instance, so thirty submissions in one minute send at most the
-- ceiling however many instances served them. When it cannot answer,
-- every caller falls back to its in-memory cap rather than refusing
-- to send — a guard that fails open, because a missed alert pages
-- nobody while a refused one tells the team nothing either.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.demand_records') is null then
    raise exception 'demand_records is missing. Run supabase-schema.sql first — the outbox names the tables it announces.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE OUTBOX — every announcement that has not gone out yet
-- ------------------------------------------------------------
--
-- RLS is on with NO policy and every privilege revoked, exactly like
-- waitlist_ref_registry: written by the service role (the door, the
-- drain), read by nothing a browser can reach. payload carries the
-- same contact the source row holds — it is as sensitive as the
-- table it announces, and it lives under the same lock.

create table if not exists public.alert_outbox (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  table_name text not null,
  ref        text not null,
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'pending',
  attempts   integer not null default 0,
  last_error text,
  sent_at    timestamptz
);

alter table public.alert_outbox enable row level security;
revoke all on public.alert_outbox from anon, authenticated;

comment on table public.alert_outbox is
  'Announcements the drain has not sent yet. pending → sent once Telegram answers; attempts past 8 stop being retried but stay auditable.';


-- ------------------------------------------------------------
-- 2. THE SEND LOG the throttle counts
-- ------------------------------------------------------------

create table if not exists public.alert_send_log (
  key     text not null,
  sent_at timestamptz not null default now()
);

alter table public.alert_send_log enable row level security;
revoke all on public.alert_send_log from anon, authenticated;

create index if not exists alert_send_log_key_at_idx
  on public.alert_send_log (key, sent_at);


-- ------------------------------------------------------------
-- 3. alert_throttle — one ceiling, every instance
-- ------------------------------------------------------------
--
-- Clears entries older than the window, counts what is left under
-- the key, records this send when under the ceiling. SECURITY
-- DEFINER so the anon key can never spend the budget directly —
-- only the service role calls it, on behalf of a send that already
-- happened against a saved row.

create or replace function public.alert_throttle(p_key text, p_window_seconds integer, p_max integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  used integer;
begin
  delete from public.alert_send_log
   where sent_at < now() - (p_window_seconds || ' seconds')::interval;

  select count(*) into used from public.alert_send_log where key = p_key;

  if used >= p_max then
    return jsonb_build_object('allow', false, 'reason', 'ceiling', 'used', used, 'limit', p_max);
  end if;

  insert into public.alert_send_log (key) values (p_key);
  return jsonb_build_object('allow', true, 'used', used + 1, 'limit', p_max);
end;
$$;

revoke all on function public.alert_throttle(text, integer, integer) from anon, authenticated;
