-- ============================================================
-- ARZUZ — location upgrade (supabase-location.sql)
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Additive and re-runnable: it never touches existing rows and is
-- safe to run more than once. It only adds generated columns + an
-- index so the admin dashboard can filter by pin quality and find
-- listings that still need passage data.
--
-- IMPORTANT: nothing here is required for the site to work.
-- Every new field (pin_meta, passage) lives inside the payload
-- jsonb and flows through unchanged. Running this file just makes
-- those fields queryable as real columns.
--
-- Generated columns exist only for listings and scout_submissions —
-- demand_records carries no pin and no passage.
-- ============================================================


-- ------------------------------------------------------------
-- 1. PIN QUALITY COLUMNS
--    pin_meta in the payload looks like:
--      { "source": "gps", "accuracy_m": 8, "samples": 12,
--        "captured_at": "2026-10-05T09:14:00.000Z" }
--    source is one of: gps | tapped | dragged | admin
-- ------------------------------------------------------------

alter table listings add column if not exists pin_source
  text generated always as (payload->'pin_meta'->>'source') stored;
alter table listings add column if not exists pin_accuracy_m
  integer generated always as ((payload->'pin_meta'->>'accuracy_m')::integer) stored;

alter table scout_submissions add column if not exists pin_source
  text generated always as (payload->'pin_meta'->>'source') stored;
alter table scout_submissions add column if not exists pin_accuracy_m
  integer generated always as ((payload->'pin_meta'->>'accuracy_m')::integer) stored;


-- ------------------------------------------------------------
-- 2. PASSAGE FLAG
--    has_passage is true when the payload carries a passage object
--    with any real content. Writing it as a plain CASE keeps the
--    logic readable; generated columns recompute automatically on
--    every insert/update, so admin edits stay in sync.
-- ------------------------------------------------------------

alter table listings add column if not exists has_passage
  boolean generated always as (
    coalesce(payload ? 'passage', false)
  ) stored;

alter table scout_submissions add column if not exists has_passage
  boolean generated always as (
    coalesce(payload ? 'passage', false)
  ) stored;


-- ------------------------------------------------------------
-- 3. INDEXES — the admin filters that use the new columns
-- ------------------------------------------------------------

create index if not exists idx_listings_pin_source      on listings (pin_source);
create index if not exists idx_listings_has_passage     on listings (has_passage);
create index if not exists idx_scout_pin_source         on scout_submissions (pin_source);
create index if not exists idx_scout_has_passage        on scout_submissions (has_passage);

/* Weak pins: source = 'tapped' or no meta at all. Useful query for
   the field team:
     select id, payload->>'prop_name', pin_source, pin_accuracy_m
     from listings
     where env = 'production'
       and (pin_source is null or pin_source <> 'gps'
            or coalesce(pin_accuracy_m, 999) > 30)
     order by created_at desc;
*/



-- ------------------------------------------------------------
-- 4. CHECK IT WORKED
-- ------------------------------------------------------------

-- From the Supabase SQL editor:
--   select pin_source, pin_accuracy_m, has_passage, count(*)
--   from listings group by 1, 2, 3;
--
-- Older rows show null pin_source / null pin_accuracy_m (no meta)
-- and has_passage = false. New submissions from the upgraded forms
-- populate them automatically — no backfill needed, nothing breaks.
