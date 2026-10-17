-- ============================================================
-- ARZUZ — where the code went, and what the student saw of it
--
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Run this AFTER supabase-status-codes.sql. That file creates
-- status_codes, status_guard and the three status_* functions, and
-- every statement below changes or reads what it made. Safe to run
-- more than once. Nothing here drops a table, a column or a row.
--
-- WHY THIS FILE EXISTS
--
--   supabase-status-codes.sql deliberately records nothing about
--   DELIVERY. Its header says so, and the reasoning was sound for what
--   it was protecting: the code's hash identifies a code, not a
--   mailbox, so a second channel needed no schema change, and what a
--   caller may READ does not depend on how the code travelled. The
--   reveal is the same either way, and that is the property that keeps
--   the endpoint from being an oracle.
--
--   That reasoning was about the STUDENT. It says nothing about the
--   OFFICE, and the office has a question it was answering from a build
--   log: "I never got the code." A student rings the desk with a
--   reference, and until now the only record of what had been sent to
--   them — on which channel, whether the sender accepted it, whether
--   the fallback fired — was a console line in a Netlify build log that
--   nobody opens and that expires. So the desk's honest answer was "ask
--   for another one and see", which is the same answer whether the
--   first one was delivered or not.
--
--   This file is that record, and ONLY that record. Two things change:
--
--     · a code now carries its own ATTEMPT CEILING (see §1). It was a
--       per-deploy environment variable, which meant the number the
--       verify path enforced and the number a screen could report had
--       two sources and could disagree; and it meant a code issued
--       under one setting was judged under another if the setting
--       changed inside its ten minutes. The TTL has always been decided
--       at issue and stored (`expires_at`); the ceiling now is too.
--     · every attempt to DELIVER a code is appended to a trail (§2),
--       with the channel it was attempted on, whether the sender took
--       it, and a machine word for why not — never an address, never a
--       number, never the code.
--
--   NOTHING HERE IS READABLE BY A BROWSER, AND THAT IS THE FIRST
--   PROPERTY TO KEEP. The trail is RLS-on with no policy, exactly like
--   the two tables beside it, and the one function that reads it is
--   executable by a signed-in team member and by nobody else — it
--   checks public.arzuz_role() itself, on the same pattern as
--   verification_queue(). It deliberately does NOT go through a Netlify
--   function holding the service key: the dashboard already holds a
--   Supabase session for its own tables, and the database is the real
--   boundary on this site (supabase-team-roles.sql), so the decision
--   about what a support login may see is made where every other such
--   decision is made.
--
--   AND IT STILL CANNOT WIDEN THE REVEAL. status_verify returns the
--   stage and nothing personal, and nothing in this file touches it
--   except its attempt ceiling. The screen below is for the desk, it
--   answers a question about a REFERENCE rather than a person, and the
--   columns it may return are a fixed list written in §5 — no phone, no
--   address, no name, no answers.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly, and early
--
-- plpgsql resolves nothing until a function is first CALLED, so a
-- project that skipped supabase-status-codes.sql would take every
-- function below quite happily and then fail on the first student who
-- used the status page, with a message about a missing column rather
-- than about the file to run. The table is the sharper of the two
-- things to check: the functions below are meaningless without it, and
-- §4 re-states one of that file's own.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.status_codes') is null then
    raise exception 'public.status_codes is missing. Run supabase-status-codes.sql before this file — it creates the code table, its throttle and the three status_* functions, and this file adds the delivery trail and re-states the verify function on top of them.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE CEILING BELONGS TO THE CODE
--
-- Five attempts, and this column is where that number lives now. It
-- was STATUS_MAX_ATTEMPTS in Netlify, read by the verify path on every
-- call — which made the ceiling a property of the DEPLOY rather than of
-- the code, and the difference is not academic: a code issued at five
-- minutes to ten and verified at five past would be judged by whatever
-- the setting said at the second moment, and the ceiling reported to a
-- desk answering "it says my code is wrong" would come from somewhere
-- else entirely.
--
-- The range is the range the old knob allowed (1 to 20) so nothing an
-- operator could set before is rejected now. To change the policy, this
-- default is the one line to change: it is the only place a new code's
-- ceiling comes from.
-- ------------------------------------------------------------

alter table public.status_codes
  add column if not exists max_attempts integer not null default 5;

alter table public.status_codes
  drop constraint if exists status_codes_max_attempts_range;
alter table public.status_codes
  add constraint status_codes_max_attempts_range check (max_attempts between 1 and 20);

comment on column public.status_codes.max_attempts is
  'How many times this code may be tried before it is dead. Decided when the code is issued and then fixed, so the verify path and the desk screen cannot disagree about the same code. Replaced the STATUS_MAX_ATTEMPTS deploy variable; the default is the policy.';


-- ------------------------------------------------------------
-- 2. THE DELIVERY TRAIL — an attempt per row, append-only
--
-- One row per attempt to send a code, so the story is readable rather
-- than summarised. A code asked for by WhatsApp that OpenWA refused and
-- that the email fallback then delivered is TWO rows, in order, and
-- that is the whole point: flattened into one column it would read
-- "email", and the desk would have no way to tell the student why the
-- message they were watching for never arrived on the phone they were
-- holding.
--
-- THE OUTCOME VOCABULARY IS THREE WORDS, and they are the three states
-- an operator can act on:
--
--   sent         the sender accepted it. Not "the student has it" —
--                nothing here can know that, and a screen that claimed
--                it would be lying about a fact nobody has.
--   refused      the sender was asked and said no. The channel is up
--                and the message did not go. This is the one that means
--                "something is wrong with the setup".
--   unreachable  nothing was asked, because nothing could be: a number
--                this site cannot turn into a JID, or a record with no
--                address on it.
--
-- `note` IS A CLOSED VOCABULARY, and that is a privacy decision rather
-- than a tidiness one. The obvious promise — "no note may contain an
-- address or a number" — is a rule about SHAPE, and a shape rule leaks:
-- 'refused for Amaka, number changed' breaks no rule about '@' or
-- digits and still puts a student's name in a log that more than one
-- person reads. So the column accepts a fixed list of machine words and
-- nothing else, which is a guarantee about CONTENT: a stored note cannot
-- name anybody, because the only values it can hold are ones written
-- here. An unknown word is coerced to 'unrecorded' by §3 (with a
-- warning in the Postgres log) rather than refused, so the row — the
-- record the desk came for — is never lost to a vocabulary drift.
--
-- The row cascades with its CODE, not with the reference: §1's
-- housekeeping deletes codes a day after they die, and a delivery for a
-- code that no longer exists is a record of nothing.
-- ------------------------------------------------------------

create table if not exists public.status_code_deliveries (
  id         bigserial primary key,
  code_id    bigint      not null references public.status_codes(id) on delete cascade,
  channel    text        not null,
  outcome    text        not null,
  note       text,
  created_at timestamptz not null default now(),
  constraint status_code_deliveries_channel check (channel in ('whatsapp', 'email')),
  constraint status_code_deliveries_outcome check (outcome in ('sent', 'refused', 'unreachable')),
  constraint status_code_deliveries_note    check (
    note is null or note in (
      'openwa-refused',      -- the WhatsApp sender was asked and said no
      'openwa-unreachable',  -- the number on the file is not a JID we can message
      'openwa-unconfigured', -- OPENWA_URL / OPENWA_API_KEY are not set
      'no-mail-on-file',     -- no address on the record to fall back to
      'mail-refused',        -- the mail provider was asked and said no
      'mail-unconfigured',   -- RESEND_API_KEY is not set
      'unrecorded'           -- a word this file does not know; see §3
    )
  )
);

alter table public.status_code_deliveries enable row level security;
revoke all on public.status_code_deliveries from anon, authenticated;
revoke all on sequence public.status_code_deliveries_id_seq from anon, authenticated;

create index if not exists idx_status_code_deliveries_code
  on public.status_code_deliveries (code_id, created_at);

comment on table public.status_code_deliveries is
  'One row per attempt to deliver a status code: the channel tried, whether the sender accepted it, and a machine word for why not. Append-only in practice — nothing here is ever updated — and it holds no address, no number and no code. Service role writes it; only status_history() reads it.';

comment on column public.status_code_deliveries.outcome is
  'sent = the sender accepted it (not "the student has it"); refused = the sender said no, which means the setup is wrong; unreachable = nothing was asked because nothing could be.';

comment on column public.status_code_deliveries.note is
  'A machine word from a CLOSED list — never a contact, never free text. The CHECK accepts only seven named values, so a note cannot carry a name, an address or a number: content is constrained, not shape. An unknown word is stored as ''unrecorded''.';


-- ------------------------------------------------------------
-- 3. RECORDING AN ATTEMPT
--
-- Called by netlify/functions/status.js immediately after it tries to
-- send, once per channel it tries. Nothing else writes here.
--
-- IT ANSWERS, IT NEVER RAISES, for a reason that matters more than the
-- tidiness of it: this call happens AFTER a code has been issued and
-- after a message has (or has not) gone out, and the student's request
-- is already answered by then. A booking error here — the code row
-- deleted by the housekeeping between the two calls, a channel word
-- from a newer version of the function — must not turn a delivered code
-- into a 500. So every refusal is a value: the caller logs it and the
-- student is unaffected.
--
-- The vocabulary check is the second half of §2's constraint. A note
-- outside the list is stored as 'unrecorded' and `raise warning` puts
-- the substitution in the Postgres log, so a caller whose note drifted
-- is findable without either the student's request or the desk's record
-- being the thing that breaks. Coerced rather than refused, deliberately:
-- the row is what the desk came for, and a row lost to a vocabulary
-- mismatch is worse than a row that says "unrecorded".
-- ------------------------------------------------------------

create or replace function public.status_code_delivery(
  p_code_id bigint,
  p_channel text,
  p_outcome text,
  p_note    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  here_id  bigint;
  landed   bigint;
  known    text[] := array[
    'openwa-refused', 'openwa-unreachable', 'openwa-unconfigured',
    'no-mail-on-file', 'mail-refused', 'mail-unconfigured'
  ];
  note     text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_channel is null or p_channel not in ('whatsapp', 'email') then
    return jsonb_build_object('ok', false, 'reason', 'bad-channel');
  end if;

  if p_outcome is null or p_outcome not in ('sent', 'refused', 'unreachable') then
    return jsonb_build_object('ok', false, 'reason', 'bad-outcome');
  end if;

  /* A delivery is about a code, so a code has to be there to be about.
     Checked rather than left to the foreign key so the answer is a
     sentence the caller can log instead of a constraint violation. */
  select c.id into here_id from public.status_codes c where c.id = p_code_id;
  if here_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no-code');
  end if;

  if note is not null and not (note = any (known)) then
    raise warning 'status_code_delivery: the note "%" for code % is not one of this schema''s words and was stored as unrecorded', note, p_code_id;
    note := 'unrecorded';
  end if;

  insert into public.status_code_deliveries (code_id, channel, outcome, note)
    values (here_id, p_channel, p_outcome, note)
    returning id into landed;

  return jsonb_build_object('ok', true, 'id', landed, 'at', now());
end $$;

/* The service role only. The dashboard does NOT hold one: it reads this
   table through status_history() in §5, which decides for itself who is
   asking. A browser key can neither write a delivery nor forge one. */
revoke execute on function public.status_code_delivery(bigint, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.status_code_delivery(bigint, text, text, text) to service_role;

comment on function public.status_code_delivery(bigint, text, text, text) is
  'Appends one delivery attempt for a code: the channel, whether the sender accepted it, and a machine word for why not. Service role only. Answers {ok:false, reason} rather than raising, because it is called after the student''s request has already been answered.';


-- ------------------------------------------------------------
-- 4. THE VERIFY PATH, RE-STATED — the row''s ceiling governs
--
-- Identical to supabase-status-codes.sql section 4 in every respect but
-- one, and the one is the point of §1: the ceiling is read from the code
-- rather than taken from the caller. The atomic spend is untouched —
-- the attempt is still spent and the ceiling still checked in ONE
-- statement, so two requests arriving together cannot both spend the
-- last attempt — and the ORDER is untouched: the attempt is spent
-- before the comparison, so a wrong code costs something even if the
-- connection dies mid-request.
--
-- `p_max_attempts` stays in the signature and is now the FALLBACK for a
-- row with no ceiling of its own. It cannot happen through this file
-- (the column is NOT NULL with a default, so §1 backfills every row that
-- already exists), and it is kept so that the function is correct read
-- on its own rather than only in the company of this migration.
--
-- WHAT THIS BUYS, BEYOND THE SCREEN. It used to be possible for any
-- caller holding the service key to pass a LARGER ceiling than the code
-- was issued under — nothing enforced the number, because nothing
-- recorded it. Now the row does. A check in dev/sql-proof.mjs drives
-- exactly that: a code issued at five, verified with a claimed ceiling
-- of twenty, is still refused on the sixth attempt.
-- ------------------------------------------------------------

create or replace function public.status_verify(
  p_ref          text,
  p_code_hash    text,
  p_max_attempts int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  live_id   bigint;
  row_cap   int;
  spent     int;
  kind      text;
  reveal    jsonb;
  cap       int := greatest(1, least(20, coalesce(p_max_attempts, 5)));
begin
  select c.id, c.max_attempts into live_id, row_cap
    from public.status_codes c
   where c.ref = p_ref
     and c.consumed_at is null
     and c.expires_at > now()
   order by c.created_at desc
   limit 1;

  if live_id is null then
    /* No live code for this reference: never asked, already used, or
       past its ten minutes. One answer, because telling them apart is
       an oracle — and the page has one sentence for all three. */
    return jsonb_build_object('ok', false, 'reason', 'no-code');
  end if;

  /* The code''s own ceiling, which the caller cannot widen. */
  if row_cap is not null then
    cap := greatest(1, least(20, row_cap));
  end if;

  update public.status_codes
     set attempts = attempts + 1
   where id = live_id
     and attempts < cap
  returning attempts into spent;

  if spent is null then
    return jsonb_build_object('ok', false, 'reason', 'too-many', 'limit', cap);
  end if;

  /* A plain `=` on two hex digests, not a constant-time compare. The
     values being compared are already a sha256 of the code, so there
     is no secret in the comparison itself to time — and timing a
     network request closely enough to walk 64 hex characters would
     still leave the code unguessed. Written down so the next reader
     knows it was decided rather than missed. */
  if p_code_hash is null or p_code_hash <> (select code_hash from public.status_codes where id = live_id) then
    return jsonb_build_object('ok', false, 'reason', 'wrong',
                              'attempts_left', cap - spent, 'limit', cap);
  end if;

  /* Correct: the code is spent, and so is every other live code for
     this reference. */
  update public.status_codes
     set consumed_at = now(), expires_at = now()
   where ref = p_ref and consumed_at is null;

  select r.kind into kind
    from public.waitlist_ref_registry r
   where r.ref = p_ref;

  if kind = 'listings' then
    select jsonb_build_object(
             'ref',         l.ref,
             'kind',        'landlord',
             'state',       l.status,
             'stage',       l.follow_up_status,
             'received_at', l.created_at,
             'verified_at', l.verified_at,
             'tier',        l.tier,
             'roommate',    false)
      into reveal
      from public.listings l
     where l.ref = p_ref;
  else
    select jsonb_build_object(
             'ref',         d.ref,
             'kind',        'student',
             'state',       d.status,
             'stage',       d.follow_up_status,
             'received_at', d.created_at,
             'verified_at', d.verified_at,
             'tier',        null,
             'roommate',    coalesce(d.payload ->> 'roommate', '') = 'yes')
      into reveal
      from public.demand_records d
     where d.ref = p_ref;
  end if;

  if reveal is null then
    /* The code was right and the row is gone — deleted by hand in the
       dashboard, most likely. Say so rather than answering 200 with
       nothing in it. */
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;

  return jsonb_build_object('ok', true, 'reason', 'matched', 'reveal', reveal);
end $$;

revoke execute on function public.status_verify(text, text, int)
  from public, anon, authenticated;
grant  execute on function public.status_verify(text, text, int) to service_role;


-- ------------------------------------------------------------
-- 5. THE DESK'S QUESTION — one reference, and everything that was sent
--
-- Called by assets/admin.js from the Support Desk, with the signed-in
-- team member's own session. So this function AUTHORIZES: it is
-- executable by `authenticated` and it checks public.arzuz_role() itself,
-- the same shape as verification_queue() and for the same reason — the
-- database is the boundary on this site, so the answer to "may this
-- login see this" is made once, here, rather than in a page that could
-- be edited.
--
-- IT IS THE SUPPORT DESK'S QUESTION. A student on the phone with a
-- reference and a message they never got is the desk's call, so support
-- and admin may ask; verification, finance and marketing may not, and
-- the refusal is the same 42501 the queue function raises.
--
-- AND IT DOES NOT NEED THE WHOLE REFERENCE. The reference is the thing
-- the student was told to keep, so it is the thing they have lost when
-- they ring: half of these calls open with "I can't find the ARZ number"
-- or with the student reading out the phone they applied from instead.
-- So the one argument is a QUERY rather than a reference, and three
-- shapes of it are answered:
--
--   · the whole reference, as before, and exactly as before;
--   · a FRAGMENT of it — the last four characters, which is what gets
--     read out over the phone, or the beginning of one;
--   · a PHONE NUMBER, matched the way the site itself matches one.
--
-- A fragment is answered with CANDIDATES, never with a guess. If more
-- than one reference could be meant the function says so and lists them
-- (capped — see below) instead of picking the newest and presenting it
-- as the student's; an officer told "this is their reference, and here
-- is what was sent" about somebody else's row would read the wrong
-- history back down the phone with complete confidence. One match is
-- resolved; anything else is a question for the person on the call.
--
-- WIDENING WHO MAY ASK WAS NOT PART OF THIS. The role check is exactly
-- what it was — admin and support — because nothing about "I cannot
-- find my reference" is a reason for a different login to see a
-- student's history. What grew is the shape of the question, not the
-- list of people allowed to ask it, and the CAP is what keeps the new
-- shapes from becoming a way to page the registry out ten rows at a
-- time.
--
-- WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT. Facts, in one
-- fixed shape: the reference, whether it names a record, and one object
-- per code asked for — when it was asked for, when it dies, how many
-- attempts it has spent and how many it may spend, whether it was used —
-- each with its own delivery attempts in order. NOT the phone, NOT the
-- email address, NOT the name, NOT the answers, NOT the code itself
-- (there is nowhere to get it from: only a hash was ever stored). The
-- sentences are the page's business; this hands over the facts and
-- nothing else, which is why `kind` is a word ('student'/'landlord')
-- and not a table name. The new fields are `lookup` (how the query was
-- READ — 'ref', 'head', 'tail' or 'phone'), `matches` (the candidates,
-- when there is more than one) and `more` (there were more than the cap).
-- A candidate carries its reference, its kind and when it was handed
-- out — and NOT the phone number it was found by, which is the one
-- detail a search by number exists to avoid putting on a screen.
--
-- `known_reference` is FALSE when the registry has no row for it, which
-- is worth reporting rather than hiding: a reference that resolves to a
-- demand is a real one, and one that does not is either a typo or a
-- record somebody deleted by hand — and those two need different
-- answers from the person on the phone, even though the STUDENT's page
-- must never distinguish them.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5a. THE SITE'S OWN RULE ABOUT TWO PHONE NUMBERS
--
-- "The last ten digits, and only when there are ten of them." The same
-- rule the public door uses for its same-phone check and the same rule
-- netlify/functions/status.js proves control of a number with, in
-- `phoneTail`. It lives here as a function rather than as a
-- regexp_replace written out four times so that the desk's search and
-- the student's own proof cannot drift apart: if they ever disagree, a
-- number the student can open their record with is a number the desk
-- cannot find it by, and the officer is left saying "there is no record
-- of that number" to the person who owns it.
--
-- It returns '' for anything with fewer than ten digits, which is how
-- "too short to be a number we could ever have matched" is said once.
-- ------------------------------------------------------------

create or replace function public.status_phone_tail(p_value text)
returns text
language sql
immutable
as $$
  select case when length(d) >= 10 then right(d, 10) else '' end
    from (select regexp_replace(coalesce(p_value, ''), '\D', '', 'g') as d) s;
$$;

/* `from public, anon, authenticated` — and the named roles are
   load-bearing: Supabase's default privileges grant execute on new
   functions to anon and authenticated EXPLICITLY, which `revoke ...
   from public` does not remove. The same trap supabase-hardening.sql
   documents, and the same shape supabase-waitlist-launch.sql uses for
   arzuz_ref_token. */
revoke execute on function public.status_phone_tail(text) from public, anon, authenticated;
grant  execute on function public.status_phone_tail(text) to service_role;

comment on function public.status_phone_tail(text) is
  'The last ten digits of a phone number, and empty for anything shorter — the same rule netlify/functions/status.js proves control of a number with. One definition so the Support Desk''s search by number and the student''s own proof of it cannot disagree.';


create or replace function public.status_history(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  /* How many candidates one fragment may answer with before the desk is
     told to type more. Ten is more than an officer will read down a
     phone line and small enough that a three-character fragment cannot
     be used to page the registry out. */
  c_cap constant int := 10;

  /* The two floors, and why they differ. A FRAGMENT is the END of a
     reference: the last group is four hex characters and that is what
     gets read out, so three is the shortest thing a person can mean by
     "the end of it". A fragment that is the BEGINNING needs more,
     because 'ARZ' and 'ARZS' are not a reference at all — they are
     every reference there has ever been, or half of them — so the
     beginning is only read as one at eight compact characters, which is
     a person reading the first two groups out rather than asking for
     the table. Both are capped below, so the floor is about intent and
     the cap is about exposure. */
  c_part_min constant int := 3;
  c_head_min constant int := 8;

  me      text := public.arzuz_role();
  typed   text := btrim(coalesce(p_query, ''));
  digits  text;
  compact text;
  look    text := 'none';
  cand    jsonb := '[]'::jsonb;
  more    boolean := false;
  one     text;
  kind    text;
  matches jsonb := '[]'::jsonb;
  codes   jsonb := '[]'::jsonb;
  asked   int := 0;
begin
  if me not in ('admin', 'support') then
    raise exception 'status_history: a % login may not read a reference''s code history. It is the support desk''s question, and an admin''s.', me
      using errcode = '42501';
  end if;

  if typed = '' then
    return jsonb_build_object('ok', false, 'reason', 'no-ref');
  end if;

  /* ------------------------------------------------------------
     WHAT DID THEY TYPE? Read here, once, rather than in the panel.
     A page that decided for itself what a phone number looks like would
     be a second rule to keep in step with this one, and the day the two
     disagree the desk is told "no record of that number" about a student
     who is on the phone.

     A LETTER MAKES IT A REFERENCE. Every reference carries letters —
     'ARZ', the S/L, and hex that is frequently alphabetic — and a phone
     number carries none, so one test separates the two kinds and no
     threshold is guessed at.

     A BARE STRING OF DIGITS IS A NUMBER ONLY AT TEN OR MORE. That is the
     site's own minimum (see status_phone_tail above), and it settles the
     one case that would otherwise be a guess: below ten digits it cannot
     be a number this site could ever have matched, so the only other
     thing it can be is the END OF A REFERENCE THAT IS ALL DIGITS. About
     one reference in seven ends in four digits — the last group is twelve
     hex characters, so an all-decimal tail is ordinary — and a reader
     that resolved those to 'nothing' would refuse the desk the answer for
     a seventh of the references in the registry, with a message telling
     them the fragment was too short to mean anything.

     The cost of reading them as a tail is bounded by the same cap as any
     other fragment: at most ten candidates, and a question rather than a
     history unless exactly one fits. A bare phone number that is short of
     a digit reads as a tail and matches nothing, which is the same answer
     the desk gets for any fragment nothing ends with.
     ------------------------------------------------------------ */
  digits  := regexp_replace(typed, '\D', '', 'g');
  compact := upper(regexp_replace(typed, '[^0-9A-Za-z]', '', 'g'));

  if compact ~ '[A-Z]' then
    if compact ~ '^ARZ[SL][0-9A-F]{12}$' then
      look := 'ref';
      cand := jsonb_build_array(jsonb_build_object(
        'ref', 'ARZ-' || substr(compact, 4, 1) || '-' || substr(compact, 5, 4) || '-'
               || substr(compact, 9, 4) || '-' || substr(compact, 13, 4),
        'at', null));
    elsif compact like 'ARZ%' then
      if length(compact) >= c_head_min and length(compact) < 16 then
        look := 'head';
      end if;
    elsif length(compact) >= c_part_min and length(compact) <= 15 then
      look := 'tail';
    end if;
  elsif length(digits) between 10 and 15 then
    look := 'phone';
  elsif length(digits) between c_part_min and 9 then
    look := 'tail';
  end if;

  /* A fragment resolves to CANDIDATES — newest hand-out first, which is
     the order a person rings in. `limit c_cap + 1` is how "there are
     more of these than fit" is answered without counting every one. */
  if look = 'head' then
    select coalesce(jsonb_agg(jsonb_build_object('ref', s.ref, 'at', s.created_at)
                              order by s.created_at desc), '[]'::jsonb)
      into cand
      from (select r.ref, r.created_at
              from public.waitlist_ref_registry r
             where replace(r.ref, '-', '') like compact || '%'
             order by r.created_at desc
             limit c_cap + 1) s;

  elsif look = 'tail' then
    select coalesce(jsonb_agg(jsonb_build_object('ref', s.ref, 'at', s.created_at)
                              order by s.created_at desc), '[]'::jsonb)
      into cand
      from (select r.ref, r.created_at
              from public.waitlist_ref_registry r
             where replace(r.ref, '-', '') like '%' || compact
             order by r.created_at desc
             limit c_cap + 1) s;

  elsif look = 'phone' then
    /* THE COLUMNS ARE THE SEND PATH'S OWN, and that is the point.
       netlify/functions/status.js proves control of a number by reading
       `phone`, then `ph`, then `owner_phone` off the row — and the
       GUARDIAN's number is NOT among them. So a guardian number is not a
       number this site will message, and it must not be one the desk can
       find a reference by either: a panel that resolved it would send an
       officer to a record the student cannot then open for themselves.

       A student's form files `phone` (demand_records); a landlord's
       files `ph` (listings.owner_phone) — two branches, static SQL, for
       the same reason the verify function's reveal has two. */
    select coalesce(jsonb_agg(jsonb_build_object('ref', s.ref, 'at', s.created_at)
                              order by s.created_at desc), '[]'::jsonb)
      into cand
      from (select r.ref, r.created_at
              from (select d.ref, d.created_at
                      from public.demand_records d
                     where d.ref is not null
                       and public.status_phone_tail(d.phone) <> ''
                       and public.status_phone_tail(d.phone) = public.status_phone_tail(digits)
                    union all
                    select l.ref, l.created_at
                      from public.listings l
                     where l.ref is not null
                       and public.status_phone_tail(l.owner_phone) <> ''
                       and public.status_phone_tail(l.owner_phone) = public.status_phone_tail(digits)) r
             order by r.created_at desc
             limit c_cap + 1) s;
  end if;

  more := jsonb_array_length(cand) > c_cap;
  if more then
    cand := (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
               from jsonb_array_elements(cand) with ordinality as t(e, ord)
              where ord <= c_cap);
  end if;

  /* ONE match is an answer; none, or more than one, is a question. */
  if jsonb_array_length(cand) = 1 then
    one := cand -> 0 ->> 'ref';
  end if;

  /* `matches` IS THE QUESTION, NOT THE ANSWER. It is filled only when there
     is more than one candidate, so that `codes` and `matches` are never
     both populated and a caller cannot half-render one as the other: a
     panel that drew a single "candidate" for a reference it had already
     resolved would be showing the officer a choice where there is none. */
  if jsonb_array_length(cand) > 1 then
    matches := (select coalesce(jsonb_agg(jsonb_build_object(
                          'ref',     e ->> 'ref',
                          'kind',    case rk.kind
                                       when 'listings'       then 'landlord'
                                       when 'demand_records' then 'student'
                                       else null
                                     end,
                          'asked_at', e -> 'at') order by ord), '[]'::jsonb)
                  from jsonb_array_elements(cand) with ordinality as t(e, ord)
                  left join public.waitlist_ref_registry rk on rk.ref = e ->> 'ref');
  end if;

  if one is not null then
    select rk.kind into kind
      from public.waitlist_ref_registry rk
     where rk.ref = one;

    select coalesce(jsonb_agg(code order by asked_at desc), '[]'::jsonb)
      into codes
      from (
        select c.created_at as asked_at,
             jsonb_build_object(
               'id',            c.id,
               'asked_at',      c.created_at,
               'expires_at',    c.expires_at,
               'attempts',      c.attempts,
               'max_attempts',  c.max_attempts,
               /* Zero unless the code is LIVE. "Attempts left" is only a
                  question while a code can still be tried: a used or
                  expired code has none, and reporting max_attempts
                  minus attempts for it would offer the desk three more
                  tries on something the verify path already refuses.
                  Clamped at zero rather than reported negative for the
                  same reason — the ceiling cannot shrink on its own,
                  but a row edited by hand can. */
               'attempts_left', case
                                  when c.consumed_at is not null or c.expires_at <= now() then 0
                                  else greatest(0, c.max_attempts - c.attempts)
                                end,
               'used_at',       c.consumed_at,
               'live',          (c.consumed_at is null and c.expires_at > now()),
               'deliveries',    coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'channel', d.channel,
                          'outcome', d.outcome,
                          'note',    d.note,
                          'at',      d.created_at
                        ) order by d.created_at, d.id)
                   from public.status_code_deliveries d
                  where d.code_id = c.id), '[]'::jsonb)
             ) as code
        from public.status_codes c
       where c.ref = one
    ) rows;

    select count(*)::int into asked
      from public.status_codes c
     where c.ref = one
       and c.created_at > now() - interval '1 hour';
  end if;

  return jsonb_build_object(
    'ok',              true,
    /* ECHOED BACK FOR THE FRAGMENTS, AND ONLY WHEN IT WAS PART OF A
       REFERENCE. A fragment is echoed because an officer who typed four
       characters is owed the reading ("found by the end of a reference —
       7E3F"); the whole reference is not echoed because `ref` already is
       it. A PHONE NUMBER IS NEVER ECHOED — not even the caller's own
       copy of it — so that the answer to a search by number is a place a
       number cannot be read from at all: not by a screenshot, not by a
       debugger, not by any screen built on this function later. */
    'query',           case when look in ('head', 'tail') then typed else null end,
    'lookup',          look,
    'ref',             one,
    'kind',            case kind
                         when 'listings'       then 'landlord'
                         when 'demand_records' then 'student'
                         else null
                       end,
    'known_reference', kind is not null,
    'ambiguous',       jsonb_array_length(cand) > 1,
    'matches',         matches,
    'more',            more,
    'codes',           codes,
    /* The per-reference budget the status page itself is judged against,
       so a desk can see that the student is IN it rather than guessing
       why a sixth request was refused. Zero unless a reference was
       resolved: this is a per-REFERENCE number, and adding it up across
       candidates would report a busy afternoon as one student's flood. */
    'asked_last_hour', asked,
    'now',             now()
  );
end $$;

/* `authenticated` keeps the grant it had; the function authorizes on the
   role inside. The two browser roles are named rather than PUBLIC for
   the reason given at status_phone_tail above. */
revoke all on function public.status_history(text) from public, anon;
grant  execute on function public.status_history(text) to authenticated;

comment on function public.status_history(text) is
  'For the Support Desk: every code asked for against one reference, with its ceiling, its spent attempts, whether it was used, and where each delivery attempt went. The argument is a QUERY, not a reference — the whole reference, the last few characters of one, the beginning of one, or a phone number on the record — and a fragment resolves to candidates rather than to a guess. Authorizes internally on public.arzuz_role(): admin and support only. Returns no contact detail, no name, no phone number and no code.';


-- ------------------------------------------------------------
-- 6. CHECK IT WORKED
-- ------------------------------------------------------------

-- (a) The trail is unreachable with a browser key, like the two tables
--     beside it. Expect rowsecurity = true for both and ZERO policies
--     for status_code_deliveries:
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' and tablename in ('status_codes','status_code_deliveries');
--
--   select tablename, policyname from pg_policies
--    where schemaname = 'public' and tablename = 'status_code_deliveries';
--
-- (b) The writer is the service role's alone, the reader is the team's,
--     and neither is a browser key's by accident:
--
--   select has_function_privilege('anon',          'public.status_code_delivery(bigint,text,text,text)', 'execute') as anon_writes,
--          has_function_privilege('authenticated', 'public.status_code_delivery(bigint,text,text,text)', 'execute') as authed_writes,
--          has_function_privilege('service_role',  'public.status_code_delivery(bigint,text,text,text)', 'execute') as service_writes,
--          has_function_privilege('anon',          'public.status_history(text)', 'execute') as anon_reads,
--          has_function_privilege('authenticated', 'public.status_history(text)', 'execute') as authed_reads,
--          has_function_privilege('service_role',  'public.status_history(text)', 'execute') as service_reads;
--
--     anon_writes and authed_writes must be false; service_writes true.
--     anon_reads false; authed_reads true; service_reads is false by
--     default and does not matter — the function holds no grant on the
--     trail, so it does not need one, and the dashboard is the only
--     caller.

-- (c) The whole screen, as a signed-in support login. Run this in the
--     SQL editor (the SQL editor runs as the owner and bypasses the
--     role check, so use the dashboard for the real thing), changing
--     the reference to a real one:
--
--   select jsonb_pretty(public.status_history('ARZ-S-XXXX-XXXX-XXXX'));
--
--     Expect: lookup='ref', query and ref both echoed, kind,
--     known_reference, ambiguous false, matches empty, asked_last_hour,
--     and one entry per code with its deliveries in order. Then ask for
--     a code on /status with that reference and the number on the row,
--     and run it again — a delivery row appears with channel 'whatsapp'
--     and outcome 'sent', or with outcome 'refused'/'unreachable' and a
--     note.
--
-- (c2) The same question asked the three other ways. With 'XXXX' the
--     last group of a reference that exists:
--
--   select public.status_history('XXXX')            -- lookup 'tail'
--        , public.status_history('ARZ-S-XXXX')       -- lookup 'head'
--        , public.status_history('0803 123 4567');   -- lookup 'phone'
--
--     Each answers lookup and either ref (one match) or matches (many).
--     The tail and the head are the SAME query underneath, so a
--     reference that exists lands here whatever end of it was typed:
--
--   select public.status_history(right('ARZ-S-XXXX-XXXX-XXXX', 4)) -> 'ref';
--
--     Fragments below the floor are refused rather than widened:
--
--   select public.status_history('XZ') -> 'lookup';        -- 'none'
--        , public.status_history('ARZ') -> 'lookup';       -- 'none'
--        , public.status_history('1234') -> 'lookup';      -- 'none'
--
--     Nothing below the floor resolves, because 'ARZ' is every reference
--     ever handed out and '1234' could be the tail of one with the
--     letters stripped off — and neither is a question with an answer.

-- (d) The ceiling is the code's, not the caller's — as the service role:
--
--   select public.status_open('ARZ-S-XXXX-XXXX-XXXX', 'a-stand-in-hash-that-is-long-enough');
--     -- {"ok": true, "code_id": N, ...}
--   select max_attempts from public.status_codes where id = N;   -- 5
--   select public.status_verify('ARZ-S-XXXX-XXXX-XXXX', 'wrong', 20);
--     -- attempts_left 4 — the claimed ceiling of 20 was ignored
--
-- (e) Re-running: everything here is idempotent. `add column if not
--     exists`, a drop-and-add of one named CHECK, `create table if not
--     exists`, `create index if not exists`, `create or replace
--     function`, and no data is touched. Running it twice changes
--     nothing on the second run but the function bodies.
