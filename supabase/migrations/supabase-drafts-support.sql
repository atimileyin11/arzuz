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

-- ------------------------------------------------------------
-- 2b. listing_payload_clamp — the length guard on the payload
--     Both forms cap every field (name 70, area 80, contact 60, phone 24,
--     description 2,000…) and the update RPC whitelists the keys, but the
--     payload is jsonb: a caller hitting the endpoint directly could store
--     an 8,000-character lodge name for the dashboard table and the OG card
--     to render. Same ceilings here, so the form and the database agree.
--     Returns a new object; the input is never modified.
-- ------------------------------------------------------------
create or replace function public.listing_payload_clamp(j jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_out  jsonb := coalesce(j, '{}'::jsonb);
  v_caps text[][] := array[
    ['prop_name', '70'],  ['ar', '80'],           ['ty', '40'],
    ['rm', '60'],         ['nm', '60'],           ['last', '60'],
    ['ph', '24'],         ['contact_role', '20'], ['who', '20'],
    ['vf', '40'],         ['photo', '300'],       ['video', '300'],
    ['video_url', '300'], ['access_notes', '600'], ['desc', '2000']
  ];
  v_i    int;
  v_key  text;
  v_txt  text;
  v_num  int;
begin
  -- text fields: trim to the same width the form accepts
  for v_i in 1 .. array_length(v_caps, 1) loop
    v_key := v_caps[v_i][1];
    if v_out ? v_key and jsonb_typeof(v_out -> v_key) = 'string' then
      v_txt := v_out ->> v_key;
      if length(v_txt) > v_caps[v_i][2]::int then
        v_out := jsonb_set(v_out, array[v_key],
                   to_jsonb(left(v_txt, v_caps[v_i][2]::int)), true);
      end if;
    end if;
  end loop;

  -- money: digits only, at most the width the form accepts
  foreach v_key in array array['rent','ask'] loop
    if v_out ? v_key and jsonb_typeof(v_out -> v_key) = 'string' then
      v_out := jsonb_set(v_out, array[v_key],
                 to_jsonb(left(regexp_replace(v_out ->> v_key, '[^0-9]', '', 'g'), 8)), true);
    end if;
  end loop;

  -- vacant rooms: 0–999. A zero means there is nothing to let, so the row is
  -- stored the way the rest of the site reads availability.
  if v_out ? 'units' and (v_out ->> 'units') ~ '^-?[0-9]{1,9}$' then
    v_num := (v_out ->> 'units')::int;
    if v_num <= 0 then
      v_out := jsonb_set(v_out, '{units}', 'null'::jsonb, true);
    elsif v_num > 999 then
      v_out := jsonb_set(v_out, '{units}', to_jsonb(999), true);
    end if;
    if v_num = 0 then
      v_out := jsonb_set(v_out, '{avail}', to_jsonb('occupied'::text), true);
      v_out := jsonb_set(v_out, '{rm}', to_jsonb('Fully occupied'::text), true);
    end if;
  end if;

  -- coordinates: lat/lng are generated columns cast to double precision, so
  -- a pin that is not a number raises 22P02 — for ANY writer. A listing must
  -- never fail to save because a pin was typed, pasted or traced wrongly, so
  -- an unparseable coordinate is stored as null and the map simply has no pin.
  foreach v_key in array array['lat','lng'] loop
    if v_out ? v_key and jsonb_typeof(v_out -> v_key) = 'string'
       and (v_out ->> v_key) !~ '^-?[0-9]+(\.[0-9]+)?$' then
      v_out := jsonb_set(v_out, array[v_key], 'null'::jsonb, true);
    end if;
  end loop;

  -- a media list nobody can scroll through: keep the first sixty
  if v_out ? 'media' and jsonb_typeof(v_out -> 'media') = 'array'
     and jsonb_array_length(v_out -> 'media') > 60 then
    v_out := jsonb_set(v_out, '{media}', coalesce((
      select jsonb_agg(e order by ord)
      from jsonb_array_elements(v_out -> 'media') with ordinality as t(e, ord)
      where ord <= 60
    ), '[]'::jsonb), true);
  end if;

  return v_out;
end;
$$;

-- ------------------------------------------------------------
-- 2c. The same ceilings for EVERY writer
--     The clamp above covered one door: the draft-update RPC. The
--     dashboard posts to /rest/v1/listings directly, the public
--     "I have a property" form posts to the same table as anon, and
--     the SQL editor posts as the table owner — three more doors, and
--     the ceilings only held for the one that called the function.
--     A BEFORE trigger closes all of them at once: whoever writes the
--     row, the payload is clamped on the way in. `update of payload`
--     keeps it out of the way of a status/tier change, and the clamp
--     is idempotent, so a writer that already clamped is not clamped
--     twice (and the RPC's own call stays harmless).
-- ------------------------------------------------------------
create or replace function public.listings_guard_payload()
returns trigger
language plpgsql
as $$
begin
  new.payload := public.listing_payload_clamp(coalesce(new.payload, '{}'::jsonb));
  return new;
end;
$$;

drop trigger if exists listings_guard_payload on listings;
create trigger listings_guard_payload
  before insert or update of payload on listings
  for each row execute function public.listings_guard_payload();

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
    'apt_id','custom_id','prop_name','name_generated','ty','ar','rent','ask','rm',
    'avail','units', 'nm','last','ph','contact_role','who','vf','desc','access_notes',
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

  -- The same ceilings both forms apply, so an API caller cannot store an
  -- 8,000-character lodge name for the dashboard and the OG card to render.
  v_clean := public.listing_payload_clamp(v_clean);

  -- Merge over the stored payload; anything outside the whitelist
  -- that was already stored (e.g. an admin note key) is untouched.
  --
  -- supabase-draft-sharing.sql replaces this function with the
  -- permission + expiry version. Both keep the same field list, so
  -- running only one of them never silently drops a field the forms
  -- send: ask is the landlord's own opening ask (written to the column
  -- only while it is empty) and save_mode ('progress') keeps a
  -- half-filled form out of the dashboard's completed count.
  update listings l
     set payload             = l.payload || v_clean,
         opening_ask_ngn     = case
                                 when l.opening_ask_ngn is not null then l.opening_ask_ngn
                                 when (p_patch ->> 'ask') ~ '^[0-9]{1,9}$' then (p_patch ->> 'ask')::integer
                                 else l.opening_ask_ngn
                               end,
         draft_last_saved_at = now(),
         draft_completed_at  = case
                                 when p_patch ->> 'save_mode' = 'progress' then l.draft_completed_at
                                 else coalesce(l.draft_completed_at, now())
                               end
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
revoke execute on function public.listing_payload_clamp(jsonb)      from public;
revoke execute on function public.listings_guard_payload()          from public;
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
