-- ============================================================
-- ARZUZ — the day a listing was last EDITED
--
-- Run this once in Supabase → SQL Editor → Run, and then run
-- supabase-public-view.sql again: that file drops and recreates
-- public_listings, which is how updated_at becomes readable by the
-- sitemap. (It is safe to run this file more than once.)
--
-- WHY THIS EXISTS
--
--   sitemap-listings.xml reported `created_at` as every room's lastmod.
--   That is the day the owner registered the room — not the day its
--   price, description or vacancy changed. So the sitemap told Google
--   "nothing here has changed" about a page that had changed, which is
--   precisely the wrong signal on the pages this site most needs
--   re-crawled: a room whose rent has moved.
--
--   An untrustworthy lastmod is worse than no lastmod at all: Google
--   ignores the field for the WHOLE site once it decides the dates are
--   noise, not just for the one URL that was wrong. That is why the
--   listings sitemap would rather report the wrong-but-honest older
--   date until this has been run (netlify/functions/listings-sitemap.js
--   falls back to created_at, and says so in its own log).
--
-- WHY A TRIGGER AND NOT THE APP
--
--   A listing is edited from the admin dashboard, from a hand edit in
--   the Supabase table editor, and by the SQL in this folder. Only some
--   of those pass through code that could remember to stamp a date, and
--   the table editor is exactly where the owner's real price ends up
--   being corrected. The database stamps itself instead, so the date is
--   right no matter which door the edit came through.
-- ============================================================

-- 1) the column. Nullable first, so the backfill below can fill it.
alter table listings add column if not exists updated_at timestamptz;

-- 2) existing rows: created_at, NOT now(). Backfilling with now() would
--    claim every listing on the site was edited in the same second — the
--    same lie in a different shape. A row nothing has touched since it
--    was created is honestly reported as created that day.
update listings set updated_at = created_at where updated_at is null;

alter table listings alter column updated_at set not null;
alter table listings alter column updated_at set default now();

-- 3) every update stamps it. Unconditional on purpose: the trigger
--    cannot know whether a change is "content" or a tier flip, and both
--    of them change what the page says (the badge is part of the page).
create or replace function public.listings_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists listings_touch_updated_at on listings;
create trigger listings_touch_updated_at
  before update on listings
  for each row execute function public.listings_touch_updated_at();

-- 4) the trigger function is not a door of its own. Supabase grants EXECUTE
--    on every new function to PUBLIC, and this one is only ever meant to be
--    fired by the trigger — the same line the payload guard carries, and the
--    same line dev/sql-proof.mjs checks for.
revoke execute on function public.listings_touch_updated_at() from public;

-- ------------------------------------------------------------
-- CHECK IT WORKED — from the Supabase SQL editor:
--
--   select id, created_at, updated_at from listings order by created_at desc limit 5;
--   -- updated_at = created_at on rows nobody has edited yet
--
--   update listings set notes = notes where id = '<a real id>';
--   select updated_at from listings where id = '<the same id>';
--   -- now() — the trigger fired
--
-- Then run supabase-public-view.sql, and this should stop erroring:
--
--   select updated_at from public_listings limit 1;
-- ------------------------------------------------------------
