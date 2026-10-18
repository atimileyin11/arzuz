-- ============================================================
-- ARZUZ SHADOW — accounts (DRAFT, UNWIRED — do NOT run on live)
-- Profiles + legacy links. Additive only. No policy rewrites.
-- Live tables untouched; claim links rows, never copies them.
-- ============================================================

-- One row per login. user_id is auth.users.id (Supabase Auth).
create table if not exists shadow_profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  phone_tail text,                       -- last 10 digits, match-only
  email      text,                        -- lower-cased deliverable address
  first_name text
);

-- Links a login to legacy rows it proved ownership of.
-- kind: demand | listing | roommate | care | ticket | booking
-- ref_id holds the legacy row id (uuid) or token_hash id text.
create table if not exists shadow_profile_links (
  user_id    uuid not null references shadow_profiles (user_id) on delete cascade,
  kind       text not null check (kind in ('demand','listing','roommate','care','ticket','booking')),
  ref_id     text not null,
  claimed_at timestamptz not null default now(),
  unique (user_id, kind, ref_id)
);

alter table shadow_profiles enable row level security;
alter table shadow_profile_links enable row level security;

-- Owner-only reads. No anon access at all (shadow has no anon door).
drop policy if exists "shadow owner reads profile" on shadow_profiles;
create policy "shadow owner reads profile"
  on shadow_profiles for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "shadow owner reads links" on shadow_profile_links;
create policy "shadow owner reads links"
  on shadow_profile_links for select to authenticated
  using (auth.uid() = user_id);

-- Writes arrive only through the claim function (service role).
-- No insert/update/delete policy for any client role on purpose.
revoke all on shadow_profiles, shadow_profile_links from anon;
revoke all on shadow_profiles, shadow_profile_links from authenticated;
grant select on shadow_profiles, shadow_profile_links to authenticated;

create index if not exists idx_shadow_links_user on shadow_profile_links (user_id);
create index if not exists idx_shadow_profiles_tail on shadow_profiles (phone_tail);
create index if not exists idx_shadow_profiles_email on shadow_profiles (email);
