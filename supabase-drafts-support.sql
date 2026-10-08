-- ============================================================
-- ARZUZ — draft apartments, invite links & support tickets
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Adds, on top of supabase-schema.sql / supabase-hardening.sql /
-- supabase-media-booking.sql:
--   1. Draft invite links on listings:
--        draft_token / draft_completed_at / draft_last_saved_at /
--        draft_created_by + the new 'draft' status.
--      The admin creates a half-known apartment, gets a secret
--      link (arzuz.com/complete-listing?ref=<draft_token>) and
--      sends it to the landlord. Whoever holds the link can open
--      and complete that ONE apartment — no login needed.
--   2. Two security-definer RPCs so the link holder can read and
--      update exactly one draft. Anon never touches the listings
--      table directly; the token is the only key. The update
--      copies a whitelist of fields only — status, tier and the
--      opening ask can never be changed through the link.
--   3. support_tickets — visitors REPORT a problem (insert-only
--      for anon), the team triages it in the dashboard.
--
-- Run it on a live database without touching existing rows.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. DRAFT COLUMNS on listings (idempotent)
-- ------------------------------------------------------------

alter table listings add column if not exists draft_token        uuid;
alter table listings add column if not exists draft_completed_at timestamptz;
alter table listings add column if not exists draft_last_saved_at timestamptz;
alter table listings add column if not exists draft_created_by   uuid;

-- The token is the secret: one active link per listing, and the
-- partial index keeps lookups O(1) without indexing nulls.
create unique index if not exists idx_listings_draft_token
  on listings (draft_token) where draft_token is not null;

-- The dashboard's draft queue filter.
create index if not exists idx_listings_draft
  on listings (created_at desc) where status = 'draft';


-- ------------------------------------------------------------
-- 2. SUPPORT TICKETS
-- payload holds the report answers as JSON (same convention as
-- every other table). listing_id links the ticket to the
-- apartment being reported — plain uuid, no foreign key, so
-- deleting a listing never blocks. The public listing page
-- writes a ticket BEFORE opening WhatsApp, so the report exists
-- even if the WhatsApp message is never sent.
-- ------------------------------------------------------------

create table if not exists support_tickets (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  client_ref   uuid unique,
  payload      jsonb not null,
  listing_id   uuid,
  session      text,
  env          text default 'production',
  source       text,
  referrer     text,
  user_agent   text,
  status       text not null default 'open',   -- open / in_progress / resolved
  notes        text,

  -- generated columns for the dashboard queue
  contact_phone text generated always as (payload->>'phone') stored,
  category      text generated always as (payload->>'category') stored,
  listing_ref   text generated always as (payload->>'listing_name') stored
);


-- ------------------------------------------------------------
-- 2b. ROW LEVEL SECURITY — same shape as every other table
-- ------------------------------------------------------------

alter table support_tickets enable row level security;

drop policy if exists "public can report a problem" on support_tickets;
drop policy if exists "admin can add tickets"       on support_tickets;
drop policy if exists "admin can read tickets"      on support_tickets;
drop policy if exists "admin can update tickets"    on support_tickets;
drop policy if exists "admin can delete tickets"    on support_tickets;

-- INSERT: the public listing page. A ticket can only ever arrive
-- as 'open' — the team resolves it, never the submitter.
create policy "public can report a problem"
  on support_tickets for insert to anon with check (status = 'open');

create policy "admin can add tickets"
  on support_tickets for insert to authenticated with check (true);

create policy "admin can read tickets"
  on support_tickets for select to authenticated using (true);

create policy "admin can update tickets"
  on support_tickets for update to authenticated using (true) with check (true);

create policy "admin can delete tickets"
  on support_tickets for delete to authenticated using (true);


-- ------------------------------------------------------------
-- 2c. TABLE GRANTS + INDEXES
-- ------------------------------------------------------------

revoke all on support_tickets from anon;
grant  insert on support_tickets to anon;

create index if not exists idx_tickets_created on support_tickets (created_at desc);
create index if not exists idx_tickets_status  on support_tickets (status);
create index if not exists idx_tickets_listing on support_tickets (listing_id);


-- ------------------------------------------------------------
-- 3. DRAFT RPCs — the whole trick that makes no-login drafts
-- safe. Both are security definer: they run as the table owner,
-- so the anon caller needs no read/update grant on listings.
-- The token is the only key, and only while status = 'draft'
-- (approving the listing kills the link automatically).
-- ------------------------------------------------------------

create or replace function public.listing_draft_get(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id',                 l.id,
    'status',             l.status,
    'created_at',         l.created_at,
    'draft_completed_at', l.draft_completed_at,
    'draft_last_saved_at',l.draft_last_saved_at,
    'payload',            l.payload
  )
  from listings l
  where l.draft_token = p_token
    and l.status = 'draft';
$$;

create or replace function public.listing_draft_update(p_token uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_key     text;
  v_clean   jsonb := '{}'::jsonb;
  v_allowed text[] := array[
    'apt_id','custom_id','prop_name','ty','ar','rent','rm',
    'nm','last','ph','neg','who','vf','desc',
    'ut','utilities','media','photo','video','video_url',
    'split_ok','lat','lng','pin','pin_meta','passage'
  ];
  v_row listings;
begin
  if p_token is null then return null; end if;

  select id into v_id from listings
  where draft_token = p_token and status = 'draft';
  if v_id is null then
    return null;   -- wrong token, revoked link, or already approved
  end if;

  -- Copy ONLY whitelisted keys out of the caller's patch.
  foreach v_key in array v_allowed loop
    if p_patch ? v_key then
      v_clean := jsonb_set(v_clean, array[v_key], p_patch -> v_key, true);
    end if;
  end loop;

  -- Merge over the stored payload; anything outside the whitelist
  -- that was already stored (e.g. an admin note key) is untouched.
  update listings l
     set payload             = l.payload || v_clean,
         draft_last_saved_at = now(),
         draft_completed_at  = coalesce(l.draft_completed_at, now())
   where l.id = v_id
   returning * into v_row;

  return jsonb_build_object(
    'id',                 v_row.id,
    'draft_completed_at', v_row.draft_completed_at
  );
end;
$$;

-- Supabase grants EXECUTE on new functions to PUBLIC by default;
-- narrow it to exactly who needs it. service_role keeps access so
-- server-side jobs (if any) are not locked out.
revoke execute on function public.listing_draft_get(uuid)            from public;
revoke execute on function public.listing_draft_update(uuid, jsonb)  from public;
grant execute on function public.listing_draft_get(uuid)             to anon, authenticated, service_role;
grant execute on function public.listing_draft_update(uuid, jsonb)   to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. CHECK IT WORKED
-- ------------------------------------------------------------

-- (a) A draft with an invite link exists. From the admin
--     dashboard, create one ("Save as Draft + Invite Link"),
--     copy the token from the invite panel, then:
--
--   fetch(SUPABASE_URL + '/rest/v1/rpc/listing_draft_get', {
--     method: 'POST',
--     headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY,
--                'Content-Type': 'application/json' },
--     body: JSON.stringify({ p_token: 'PASTE-TOKEN-UUID' })
--   }).then(r => r.json()).then(console.log)
--   // → { id, status: 'draft', payload: {...} } — no auth needed
--
-- (b) The same call with a made-up token → null.
--
-- (c) Anon still cannot read the table the normal way — must 401:
--
--   fetch(SUPABASE_URL + '/rest/v1/listings?select=id', {
--     headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } })
--     .then(r => console.log(r.status))
--
-- (d) After the admin approves the draft (status leaves 'draft'),
--     the RPC with that token starts returning null — the link
--     is dead the moment the listing is approved.
--
-- (e) Confirm the policy list:
--
--   select policyname, cmd, roles from pg_policies
--   where schemaname='public' and tablename='support_tickets';
--   → insert→anon (status='open'), insert/select/update/delete→authenticated
