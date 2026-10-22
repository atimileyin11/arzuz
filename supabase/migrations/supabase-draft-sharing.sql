-- ============================================================
-- ARZUZ — draft link permissions & expiry (supabase-draft-sharing.sql)
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Builds on supabase-drafts-support.sql (draft_token + the two
-- security-definer RPCs). This file adds the two controls the
-- dashboard's "Draft link & permissions" panel writes:
--
--   1. draft_permission — 'view' (review only) or 'edit' (the
--      holder may fill in missing details + photos).
--   2. draft_expires_at — the link dies on its own. NULL = no
--      expiry (revoke it by hand from the dashboard).
--
--   3. Both RPCs are replaced so the rules are enforced on the
--      SERVER, not in the browser: a view-only link cannot write
--      anything, and an expired link cannot read or write. The
--      permission and expiry keys are NOT in the update whitelist,
--      so a link holder can never widen their own access.
--
-- Additive and re-runnable: it never touches existing rows. Drafts
-- created before this file default to permission 'edit' with no
-- expiry — exactly how they behaved before.
--
-- Until this file is run the dashboard still works: it detects the
-- missing columns, retries the insert without them and shows a
-- reminder, so nothing breaks while you are mid-upgrade.
--
-- This file also brings the write RPC up to the current field set of
-- the two forms (dashboard composer + landlord invite page): the new
-- availability keys (avail/units), contact_role, access_notes, the
-- opening ask and the save_mode marker that tells "saved my progress"
-- apart from "ready for review".
-- ============================================================


-- ------------------------------------------------------------
-- 1. COLUMNS (idempotent)
-- ------------------------------------------------------------

alter table listings add column if not exists draft_permission text;
alter table listings add column if not exists draft_expires_at timestamptz;

-- Existing drafts keep the behaviour they already had.
update listings set draft_permission = 'edit' where draft_permission is null;
alter table listings alter column draft_permission set default 'edit';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'listings_draft_permission_chk') then
    alter table listings
      add constraint listings_draft_permission_chk
      check (draft_permission in ('view', 'edit'));
  end if;
end $$;

-- The dashboard's "links about to expire" view.
create index if not exists idx_listings_draft_expiry
  on listings (draft_expires_at) where draft_expires_at is not null;


-- ------------------------------------------------------------
-- 2. READ RPC — returns null for a wrong token, a revoked link,
--    an approved listing, or a link past its expiry. The holder's
--    permission travels with the payload so the page can render
--    itself read-only without trusting the URL.
-- ------------------------------------------------------------

create or replace function public.listing_draft_get(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id',                  l.id,
    'status',              l.status,
    'created_at',          l.created_at,
    'draft_completed_at',  l.draft_completed_at,
    'draft_last_saved_at', l.draft_last_saved_at,
    'draft_permission',    coalesce(l.draft_permission, 'edit'),
    'draft_expires_at',    l.draft_expires_at,
    'opening_ask_ngn',     l.opening_ask_ngn,
    'payload',             l.payload
  )
  from listings l
  where l.draft_token = p_token
    and l.status = 'draft'
    and (l.draft_expires_at is null or l.draft_expires_at > now());
$$;


-- ------------------------------------------------------------
-- 3. WRITE RPC — same whitelist as before (plus the newer field
--    names), but only for a link that is still allowed to edit.
--    A view-only or expired link gets null back, which the page
--    turns into "this link is no longer valid".
-- ------------------------------------------------------------

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
  where draft_token = p_token
    and status = 'draft'
    and coalesce(draft_permission, 'edit') = 'edit'
    and (draft_expires_at is null or draft_expires_at > now());
  if v_id is null then
    return null;   -- wrong token, revoked, expired, view-only or approved
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
  -- that was already stored stays untouched — including
  -- draft_permission and draft_expires_at, which live in columns.
  --
  --   ask       — the landlord's own opening ask lands in the column
  --               ONLY while it is empty: what the team recorded from
  --               field notes is never overwritten from this link.
  --   save_mode — 'progress' means "I am still filling this in", so the
  --               link does NOT show up as completed in the dashboard.
  --               It is not whitelisted, so it is never stored.
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

revoke execute on function public.listing_draft_get(uuid)           from public;
revoke execute on function public.listing_draft_update(uuid, jsonb) from public;
revoke execute on function public.listing_payload_clamp(jsonb)     from public;
revoke execute on function public.listings_guard_payload()         from public;
grant execute on function public.listing_draft_get(uuid)            to anon, authenticated, service_role;
grant execute on function public.listing_draft_update(uuid, jsonb)  to anon, authenticated, service_role;


-- ------------------------------------------------------------
-- 4. CHECK IT WORKED
-- ------------------------------------------------------------
--
-- (a) Permission + expiry are stored:
--
--   select payload->>'apt_id' as apt, draft_token is not null as has_link,
--          draft_permission, draft_expires_at
--   from listings where status = 'draft' order by created_at desc;
--
-- (b) A VIEW-ONLY link refuses to write (must return null):
--
--   select public.listing_draft_update('<TOKEN-UUID>'::uuid,
--          '{"prop_name":"hacked"}'::jsonb);
--
--   → null, and payload->>'prop_name' is unchanged.
--
-- (c) An EXPIRED link reads nothing:
--
--   update listings set draft_expires_at = now() - interval '1 hour'
--   where draft_token = '<TOKEN-UUID>';
--   select public.listing_draft_get('<TOKEN-UUID>'::uuid);   → null
--
-- (d) Restore it (the dashboard's "Link expires" select does the same):
--
--   update listings set draft_expires_at = now() + interval '7 days'
--   where draft_token = '<TOKEN-UUID>';
--
-- (e) An edit link still works end to end:
--
--   select public.listing_draft_update('<TOKEN-UUID>'::uuid,
--          '{"rent":"150000","ut":["Borehole water"]}'::jsonb);
--
--   → { "id": …, "draft_completed_at": … }
--
-- (g) Saving progress does not mark the draft completed:
--
--   select public.listing_draft_update('<TOKEN-UUID>'::uuid,
--          '{"rent":"150000","save_mode":"progress"}'::jsonb);
--   select draft_completed_at, payload ? 'save_mode' as leak from listings
--    where draft_token = '<TOKEN-UUID>';
--
--   → draft_completed_at stays NULL (or keeps its earlier value) and
--     "leak" is false — the marker never lands in the payload.
--
-- (h) The opening ask lands once, and never overwrites the team's number:
--
--   select public.listing_draft_update('<TOKEN-UUID>'::uuid, '{"ask":"210000"}'::jsonb);
--   select opening_ask_ngn from listings where draft_token = '<TOKEN-UUID>';
--
--   → 210000 while the column was empty; a second call with a different
--     number leaves the first value in place.
--
-- (i) The payload clamp holds against a direct API caller:
--
--   select public.listing_draft_update('<TOKEN-UUID>'::uuid,
--          jsonb_build_object('prop_name', repeat('x', 5000),
--                             'ph',        repeat('9', 400),
--                             'desc',      repeat('y', 9000),
--                             'units',     0,
--                             'media',     (select jsonb_agg(jsonb_build_object('type','image','url','u'||g))
--                                           from generate_series(1, 120) g))::jsonb);
--   select length(payload->>'prop_name') as name_len,
--          length(payload->>'ph')        as phone_len,
--          length(payload->>'desc')      as desc_len,
--          payload->>'units'             as units,
--          payload->>'avail'             as avail,
--          payload->>'rm'                as rooms,
--          jsonb_array_length(payload->'media') as media
--   from listings where draft_token = '<TOKEN-UUID>';
--
--   → 70, 24, 2000, null, 'occupied', 'Fully occupied', 60 — the form's own
--     ceilings, applied to a patch that never came from the form.
--
-- (f) Approving the listing kills the link either way:
--
--   update listings set status = 'active' where id = '<LISTING-UUID>';
--   select public.listing_draft_get('<TOKEN-UUID>'::uuid);   → null
