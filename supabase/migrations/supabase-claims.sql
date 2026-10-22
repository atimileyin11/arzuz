-- ============================================================
-- ARZUZ — REPAIR CLAIMS
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- WHAT THIS IS
--   A Care Pass is COVERAGE for a term. Until this file there was no
--   record of a job asked for against that coverage: the student's
--   page filed a Support Desk ticket and the call-out ledger was
--   corrected by hand. This file adds the workflow the brief calls
--   for — a claim with a status, a decision, a provider, costs, an
--   audit trail, and a call-out that cannot be spent twice.
--
-- THE RULES THIS SCHEMA IS BUILT TO KEEP
--
--   1. THE ALLOWANCE IS ENFORCED WHERE IT IS SPENT. A call-out is
--      reserved by claim_reserve_callout(), which takes a lock on the
--      plan and checks the ledger's sum in the SAME transaction. Two
--      claims arriving at once for the last call-out queue behind that
--      lock, and the second is told no. A read-then-write in the
--      application could not promise that.
--
--   2. A WORKER'S WORD IS NOT A FINISHED JOB. The table refuses a
--      'completed' row that has neither the customer's confirmation
--      nor an authorized resolution. Provider marks it done →
--      'awaiting_customer'; the customer confirms, or a dispute is
--      settled by name. There is no third path in the schema.
--
--   3. NOTHING IS DELETED AND NOTHING IS EDITED AWAY. Status changes
--      are appended to claim_events with who did it and why. A claim
--      that was refused in March is still readable in July, with the
--      reason it was refused.
--
--   4. THE STUDENT NEVER WRITES MONEY. No client role has INSERT or
--      UPDATE on either table: eligibility, provider, costs and
--      payments are recorded by the Function with the service key.
--      A page can ask for a claim; it cannot approve one.
--
--   5. A CALL-OUT THAT IS GIVEN BACK IS GIVEN BACK ON THE LEDGER.
--      Cancelling or rejecting a reserved claim appends a 'released'
--      row — the exact opposite of the 'reserved' row — so the balance
--      is always the sum of what happened, never a corrected figure.
--
--   6. COVERAGE IS DECIDED AGAINST PUBLISHED TERMS. The claim stores
--      the terms version its pass was bought under (via the plan), and
--      the decision records the reason in words. A claim cannot be
--      judged against terms nobody accepted.
--
--   7. A NAME IS NOT AN AGREEMENT. Naming a worker records who WE have
--      asked; `provider_answer` records what THEY said back, and
--      `provider_proposal` records a day they offered. A refusal — or a
--      silence we finally acted on — moves the claim to where a job with
--      nobody on it belongs and keeps the name, the number and their own
--      words, because "who did we ask, and what did they say" is the
--      question the next call starts with.
--
-- PREREQUISITES
--   supabase-team-roles.sql (public.arzuz_role()), supabase-care.sql
--   (care_plans / care_credit_events) and supabase-finance.sql (a pass
--   bought online, and the ledger a repair cost is posted to). The
--   preflight below names whichever is missing.
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
    raise exception 'public.arzuz_role() is missing. Run supabase-team-roles.sql first — the claim policies are scoped by team role and will not fall back to a single one.';
  end if;

  if to_regclass('public.care_plans') is null
     or to_regclass('public.care_credit_events') is null then
    raise exception 'care_plans / care_credit_events are missing. Run supabase-care.sql before this file — a claim is filed against a pass and spends its call-outs.';
  end if;

  if to_regclass('public.ledger_entries') is null then
    raise exception 'ledger_entries is missing. Run supabase-finance.sql before this file — the cost of a completed repair is a posting in the books, not a number on a row.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. THE LEDGER LEARNS TWO NEW WORDS
--   'reserved'  −1  a claim was approved: this call-out is committed
--   'released'  +1  the claim was cancelled or refused: it comes back
--
--   Both constraints are re-stated rather than assumed. `create table
--   if not exists` is a no-op on a database that already has the
--   table, so a widening that is not re-stated here would never reach
--   an existing install — the write would fail with a 23514 whose only
--   symptom is a log line in Netlify.
-- ------------------------------------------------------------

alter table care_credit_events drop constraint if exists care_credit_events_event_check;
alter table care_credit_events add constraint care_credit_events_event_check
  check (event in ('granted', 'spent', 'refunded', 'expired', 'adjusted', 'reserved', 'released'));

alter table care_credit_events drop constraint if exists care_credit_events_shape_check;
alter table care_credit_events add constraint care_credit_events_shape_check
  check (
    (event = 'granted'  and delta > 0) or
    (event = 'spent'    and delta = -1) or
    (event in ('refunded', 'expired') and delta < 0) or
    (event = 'adjusted' and delta <> 0) or
    (event = 'reserved' and delta = -1) or
    (event = 'released' and delta = 1)
  );


-- ------------------------------------------------------------
-- 2. repair_claims — one job asked for against one pass
-- ------------------------------------------------------------

create table if not exists repair_claims (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Ours, and what the customer quotes. Unique, like every reference.
  reference      text not null unique,

  -- The pass this is claimed against. NOT a cascading foreign key, for
  -- the same reason the credit ledger has none: the claim is the record
  -- of what happened, and it must not evaporate with the plan row.
  plan_id        uuid not null,
  payment_id     uuid,

  env            text not null default 'production',

  -- The statuses the brief names. The transitions between them are the
  -- Function's business; this CHECK is the vocabulary, so a typo in a
  -- query cannot read as a legitimate state.
  status         text not null default 'submitted',
  constraint repair_claims_status_check check (status in (
    'draft', 'submitted', 'under_review', 'approved', 'assigned', 'in_progress',
    'awaiting_customer', 'completed', 'rejected', 'cancelled', 'disputed'
  )),

  -- Who and where, snapshotted at filing time: the student may move,
  -- and the claim must still say where the tap was.
  student_name   text,
  student_phone  text,
  property       text,
  room           text,

  issue          text not null,
  photos         jsonb not null default '[]'::jsonb,

  -- THE DECISION. `eligibility` is the covered/not-covered answer,
  -- always with a reason in words, because "no" without a why is the
  -- complaint that follows.
  eligibility          text,
  constraint repair_claims_eligibility_check check (
    eligibility is null or eligibility in ('covered', 'not_covered')
  ),
  eligibility_reason   text,
  decided_by           text,
  decided_at           timestamptz,

  -- THE CALL-OUT. `call_out_no` is set only by claim_reserve_callout()
  -- — it is the proof that the allowance was checked and spent, so a
  -- claim can never claim to have reserved one it did not.
  call_out_no    integer,
  reserved_at    timestamptz,

  provider_name  text,
  provider_phone text,
  -- Optional, and only ever used to TELL the worker what the decision
  -- was. A worker is reached on a phone first; this is the second door
  -- for the ones who read email, and it is never a credential.
  provider_email text,
  assigned_at    timestamptz,
  assigned_by    text,

  -- Money, in integer kobo, non-negative. Estimate and actual are
  -- separate columns: an estimate is a quote, not a cost.
  estimate_kobo  bigint,
  actual_kobo    bigint,
  constraint repair_claims_estimate_check check (estimate_kobo is null or estimate_kobo >= 0),
  constraint repair_claims_actual_check   check (actual_kobo   is null or actual_kobo   >= 0),
  constraint repair_claims_cost_order     check (
    estimate_kobo is null or actual_kobo is null or actual_kobo <= estimate_kobo * 3
  ),

  parts          jsonb not null default '[]'::jsonb,
  evidence       jsonb not null default '[]'::jsonb,

  -- THE CUSTOMER'S SIDE. A job is not finished because a worker said so.
  customer_confirmed_at timestamptz,
  customer_note         text,
  disputed_at           timestamptz,
  dispute_reason        text,

  -- The authorized path out of a dispute, by name.
  resolved_at    timestamptz,
  resolution     text,
  closed_by      text,

  constraint repair_claims_issue_check check (length(btrim(issue)) >= 5),

  -- RULE 2 OF THE HEADER, in the data: 'completed' needs the
  -- customer's confirmation OR a named resolution. Nothing else.
  constraint repair_claims_completed_needs_confirmation check (
    status <> 'completed'
    or customer_confirmed_at is not null
    or (resolved_at is not null and resolution is not null)
  ),

  -- 'not_covered' is an answer, so it carries one.
  constraint repair_claims_refusal_reason check (
    (status <> 'rejected' and eligibility is distinct from 'not_covered')
    or eligibility_reason is not null
  ),

  -- A DISPUTE IS HISTORY, so it is not erased by what happens next. A
  -- claim that was disputed in March and settled in April keeps both
  -- facts: the stamp and the reason travel together (both or neither),
  -- and 'disputed' as a STATUS requires the dispute to be recorded.
  -- (The first draft of this constraint demanded disputed_at be null
  -- whenever the status was not 'disputed', which made a settlement
  -- impossible to record — the SQL harness caught it.)
  constraint repair_claims_dispute_check check (
    (disputed_at is null and dispute_reason is null)
    or (disputed_at is not null and dispute_reason is not null)
  ),
  constraint repair_claims_disputed_needs_stamp check (
    status <> 'disputed' or disputed_at is not null
  ),

  -- A reservation is a call-out number and a time, together or not at all.
  constraint repair_claims_reservation_check check (
    (call_out_no is null and reserved_at is null)
    or (call_out_no is not null and call_out_no > 0 and reserved_at is not null)
  )
);

-- WIDENING, RE-STATED. `create table if not exists` above is a no-op
-- on a database that already has repair_claims, so a column added to
-- that block alone would never reach an existing install and the first
-- assignment with an email would fail on a 42703 in a Netlify log.
-- Every column added after the first release is repeated here.
alter table repair_claims add column if not exists provider_email text;

-- THE WORKER'S OWN ANSWER to being named on the job.
--
--   Naming somebody is US saying who is coming; it is not them agreeing
--   to come. Until this column, a worker could read the handover, be
--   unable to take it, and the only record of that was somebody
--   eventually ringing the office — while the claim sat in 'assigned'
--   with a worker on it who was never going to turn up. The handover
--   message ends by telling them to reply if anything is wrong, so the
--   reply is the answer this records.
--
--   'accepted' keeps the claim where it is: the job is with this worker.
--   'declined'  puts it BACK to 'approved' — the status that already means
--               "covered, and somebody must be found" — while the name, the
--               number and the words they used stay on the row, because the
--               next person to read this needs to know who was asked and
--               what they said.
--   'unanswered' is the same outcome with a different cause: the job went
--               quiet, the worker was asked once, and nothing came back. It
--               is a separate word from 'declined' because the two people
--               are different people to ring — one told us no, the other may
--               simply never have seen it — and a status that says "we asked
--               and they said no" about somebody who never replied is a lie
--               told by a database.
--
--   Only the answer changes the status; nothing here is ever written by
--   hand.
alter table repair_claims add column if not exists provider_answer text;

alter table repair_claims drop constraint if exists repair_claims_provider_answer_check;
alter table repair_claims add constraint repair_claims_provider_answer_check check (
  provider_answer is null or provider_answer in ('accepted', 'declined', 'unanswered')
);

-- THE DAY THEY PROPOSED, in their own words.
--
--   A worker who is handed a job often answers with a time instead of a
--   yes — "I can do Saturday morning", "can I come Monday?". That used to
--   read as an unreadable reply, and the question was put again; meanwhile
--   the customer was told a worker is coming and had no idea that the
--   worker had already suggested when. These two columns are that answer:
--   the worker's OWN words, kept as given, and when they said it.
--
--   Their words, not a computed date, and deliberately: turning "tomorrow
--   morning" into an instant means guessing a timezone, guessing which
--   morning, and putting a GUESSED APPOINTMENT on a customer's page. What
--   the customer reads here is what the worker actually said, which is
--   exactly what a proposal is.
alter table repair_claims add column if not exists provider_proposal text;
alter table repair_claims add column if not exists provider_proposed_at timestamptz;

alter table repair_claims drop constraint if exists repair_claims_proposal_pair_check;
alter table repair_claims add constraint repair_claims_proposal_pair_check check (
  (provider_proposal is null and provider_proposed_at is null)
  or (provider_proposal is not null and provider_proposed_at is not null)
);

-- THE OTHER HALF OF THAT CONVERSATION: the customer's answer to it.
--
--   A day offered by a worker is a question — "can I come Saturday?" — and
--   the only person who can answer it is the tenant who has to be in. Two
--   answers are possible and both are kept here:
--
--     day_agreed_at       they said YES. An instant and nothing else,
--                         because there is no new words to keep: the day
--                         being agreed to is provider_proposal, in the
--                         worker's words, and it needs no second copy.
--     customer_proposal   they said "not Saturday — Sunday afternoon", in
--                         their OWN words, kept as given for the same
--                         reason the worker's is: it is passed to a person
--                         to act on, and a computed date would be this
--                         site inventing a time nobody named.
--
--   An agreed day with no day to agree to is not a fact, so the last
--   constraint refuses it: the agreement is always ABOUT a proposal, and
--   re-naming a worker clears all three together, because a day belongs to
--   the two people who discussed it.
alter table repair_claims add column if not exists customer_proposal text;
alter table repair_claims add column if not exists customer_proposed_at timestamptz;
alter table repair_claims add column if not exists day_agreed_at timestamptz;

alter table repair_claims drop constraint if exists repair_claims_customer_proposal_pair_check;
alter table repair_claims add constraint repair_claims_customer_proposal_pair_check check (
  (customer_proposal is null and customer_proposed_at is null)
  or (customer_proposal is not null and customer_proposed_at is not null)
);

alter table repair_claims drop constraint if exists repair_claims_day_agreed_needs_a_day;
alter table repair_claims add constraint repair_claims_day_agreed_needs_a_day check (
  day_agreed_at is null or provider_proposal is not null
);

-- An answer is a word and an instant, together or not at all — the same
-- rule the reservation pair follows, for the same reason: a status that
-- says "we asked and they said no" with no date on it is not evidence.
alter table repair_claims add column if not exists provider_answered_at timestamptz;
alter table repair_claims add column if not exists provider_answer_note text;

alter table repair_claims drop constraint if exists repair_claims_answer_pair_check;
alter table repair_claims add constraint repair_claims_answer_pair_check check (
  (provider_answer is null and provider_answered_at is null)
  or (provider_answer is not null and provider_answered_at is not null)
);

-- A status a worker is ON cannot carry an answer that says they are not.
-- Both words are re-stated rather than assumed, for the same reason the
-- credit-ledger vocabulary above is: on a database that already has the
-- constraint, a widening that is not written here never arrives.
alter table repair_claims drop constraint if exists repair_claims_declined_is_not_assigned;
alter table repair_claims add constraint repair_claims_declined_is_not_assigned
  check (status <> 'assigned' or provider_answer is null
         or provider_answer not in ('declined', 'unanswered'));

-- A claim against a live pass is looked up by plan on every page load;
-- the queue is read by status, newest first; and a worker's reply is
-- looked up by the number it came FROM, which is the only identifier a
-- WhatsApp message carries. Without this index that lookup is a scan
-- of the whole claim table on every inbound message.
create index if not exists idx_repair_claims_plan    on repair_claims (plan_id, created_at desc);
create index if not exists idx_repair_claims_status  on repair_claims (status, created_at desc);
create index if not exists idx_repair_claims_env     on repair_claims (env, status);
create index if not exists idx_repair_claims_worker  on repair_claims (provider_phone, status);

-- One live claim per call-out number per pass. A released call-out is
-- reusable by a later claim (the row records the release), so this
-- index is on the reserved-and-still-open claims only.
create unique index if not exists idx_repair_claims_one_per_callout
  on repair_claims (plan_id, call_out_no)
  where call_out_no is not null
    and status in ('approved', 'assigned', 'in_progress', 'awaiting_customer', 'completed', 'disputed');


-- ------------------------------------------------------------
-- 3. claim_events — the audit trail
--   Append-only by grant and by policy, exactly like the consent
--   trail and the credit ledger. Every status change, decision,
--   assignment, cost and confirmation lands here with who and why.
-- ------------------------------------------------------------

create table if not exists claim_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),

  claim_id    uuid not null,
  reference   text,

  from_status text,
  to_status   text not null,
  event       text not null,

  reason      text,
  data        jsonb,

  actor_ref   uuid,
  actor_name  text,
  actor_role  text,
  env         text default 'production'
);

create index if not exists idx_claim_events_claim on claim_events (claim_id, created_at asc);

-- The vocabulary of the trail, stated once. 'viewed' is not here: a
-- claim is read by whoever holds the link, and logging reads of a
-- private page would be surveillance of the wrong party.
--   'notified'       the customer/worker were told what happened — or
--                    could not be, and this row says which channel and
--                    why. A notice that silently fails is the failure
--                    this harness exists to prevent, so the trail is
--                    where a lost message stops being invisible.
--   'accepted'       the named worker replied that the job is theirs.
--                    The claim does not move; the row is how "did they
--                    actually agree?" is answered months later.
--   'proposed'      the named worker replied with a DAY instead of a
--                    yes or a no ("Saturday morning"). The claim does not
--                    move — the job is still theirs unless they refuse it
--                    — and the customer is told what was suggested.
--   'declined'       the named worker replied that they cannot take it,
--                    so the claim went back to 'approved'. The reason is
--                    their own words, which is what the next person to
--                    ring them needs.
--   'chased'        the once-only ask the handover clock sends a worker
--                    who has said nothing since we named them. One row per
--                    ask, which is what keeps it once rather than hourly —
--                    the same trick the overdue nudge uses.
--   'unanswered'    the job came back because nobody ever answered: the
--                    name is still on the row, the customer is told there
--                    is no longer one coming, and the claim went to
--                    'approved' for somebody else to be named.
--   'day_agreed'     the CUSTOMER said yes to the day the worker
--                    suggested, from their pass link. No new words to
--                    keep: the day being agreed to is provider_proposal.
--   'day_proposed'   the customer answered a proposed day with one of
--                    their own ("not Saturday — Sunday afternoon"), kept
--                    in their words and passed to the worker.
--   'overdue_nudge'  the once-per-status escalation the aging clock
--                    sends when a claim crosses its deadline. One row
--                    per crossing, which is what makes the nudge
--                    exactly ONCE and not once an hour.
alter table claim_events drop constraint if exists claim_events_event_check;
alter table claim_events add constraint claim_events_event_check
  check (event in (
    'filed', 'reviewed', 'decision', 'reserved', 'assigned', 'started',
    'progress', 'work_reported', 'customer_confirmed', 'disputed',
    'released', 'resolution', 'cancelled', 'note',
    'notified', 'overdue_nudge', 'accepted', 'declined', 'proposed', 'chased', 'unanswered',
    'day_agreed', 'day_proposed', 'payout_settled'
  ));


-- ------------------------------------------------------------
-- 4. THE ATOMIC CALL-OUT
--   Rule 1 of the header. One transaction, one lock on the plan, and
--   a conditional INSERT that reads the ledger's own sum — so the
--   allowance can never be exceeded by two requests arriving together,
--   and a refusal writes nothing at all.
--
--   Returns the call-out number it took, or NULL when the pass has
--   nothing left. SECURITY DEFINER because no client role may write
--   the ledger; the Function calls this with the service key.
-- ------------------------------------------------------------

create or replace function claim_reserve_callout(
  p_plan_id   uuid,
  p_claim_ref text,
  p_session   text,
  p_name      text,
  p_actor     text,
  p_env       text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left integer;
  v_no   integer;
begin
  if p_plan_id is null then
    raise exception 'claim_reserve_callout: a plan is required';
  end if;

  /* ONE LOCK PER PASS, held until this transaction ends. Two claims
     arriving at the same moment serialise here instead of both reading
     the same balance — which is the entire reason this is a function
     and not three statements in the application. */
  perform pg_advisory_xact_lock(hashtext('care_plan:' || p_plan_id::text));

  select coalesce(sum(delta), 0) into v_left
    from care_credit_events
   where plan_id = p_plan_id and event <> 'expired';

  if v_left <= 0 then
    return null;
  end if;

  /* Which call-out this is — counted from the reservations already on
     the ledger, so the number is the ledger's, not a guess. */
  select coalesce(count(*), 0) + 1 into v_no
    from care_credit_events
   where plan_id = p_plan_id and event = 'reserved';

  insert into care_credit_events
    (plan_id, student_name, session, event, delta, reason, actor_name, env)
  values
    (p_plan_id, p_name, p_session, 'reserved', -1,
     'Call-out ' || v_no || ' committed to claim ' || p_claim_ref,
     p_actor, coalesce(p_env, 'production'));

  return v_no;
end $$;

/* Give it back. Used when a reserved claim is cancelled, rejected or
   refunded — never to edit history, always as the opposite row. */
create or replace function claim_release_callout(
  p_plan_id   uuid,
  p_claim_ref text,
  p_session   text,
  p_name      text,
  p_reason    text,
  p_actor     text,
  p_env       text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved integer;
  v_released integer;
begin
  if p_plan_id is null then
    raise exception 'claim_release_callout: a plan is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('care_plan:' || p_plan_id::text));

  select count(*) into v_reserved
    from care_credit_events
   where plan_id = p_plan_id and event = 'reserved'
     and reason like '%' || p_claim_ref || '%';

  select count(*) into v_released
    from care_credit_events
   where plan_id = p_plan_id and event = 'released'
     and reason like '%' || p_claim_ref || '%';

  /* Already given back, or never taken: nothing to do, and no negative
     allowance invented. The caller is told which. */
  if v_reserved <= v_released then
    return false;
  end if;

  insert into care_credit_events
    (plan_id, student_name, session, event, delta, reason, actor_name, env)
  values
    (p_plan_id, p_name, p_session, 'released', 1,
     'Call-out returned from claim ' || p_claim_ref || coalesce(' — ' || p_reason, ''),
     p_actor, coalesce(p_env, 'production'));

  return true;
end $$;

-- Supabase's default privileges hand EXECUTE to anon and authenticated
-- THROUGH `public`, so revoking from those two roles alone would leave
-- every visitor able to spend another student's call-out. PUBLIC goes
-- first, and the two named roles are stripped as well so an install that
-- granted them directly is cleaned up too. The Function calls these with
-- the service key, which is not covered by either.
revoke all on function claim_reserve_callout(uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function claim_release_callout(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4b. THE ATOMIC PROVIDER PAYOUT CHECKPOINT
--   The operator has already transferred money outside Arzuz. This RPC
--   only records that confirmed movement: one debit to the payable and
--   one credit to cash, in the transaction that holds the claim lock.
--   The claim-scoped unique references prevent duplicate or partial
--   settlements, including two admins acting at the same time.
-- ------------------------------------------------------------
create or replace function claim_settle_payout(
  p_claim_ref text,
  p_amount_kobo bigint,
  p_provider_name text,
  p_transfer_ref text,
  p_actor_ref uuid,
  p_actor_name text,
  p_env text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim repair_claims%rowtype;
  v_payable ledger_entries%rowtype;
  v_cost ledger_entries%rowtype;
  v_ref text;
  v_cash_ref text;
begin
  if length(btrim(coalesce(p_claim_ref, ''))) < 5
     or length(btrim(coalesce(p_provider_name, ''))) < 2
     or length(btrim(coalesce(p_transfer_ref, ''))) < 4
     or length(btrim(coalesce(p_transfer_ref, ''))) > 120
     or lower(btrim(p_transfer_ref)) in ('test','todo','tbd','pending','na','none','unknown','placeholder','0+')
     or p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'claim_settle_payout: invalid claim, worker, transfer reference or amount';
  end if;

  perform pg_advisory_xact_lock(hashtext('care_claim_payout:' || p_claim_ref));

  select * into v_claim from repair_claims where reference = p_claim_ref;
  if not found then raise exception 'claim_settle_payout: no such claim'; end if;
  if btrim(coalesce(v_claim.provider_name, '')) <> btrim(p_provider_name)
     or btrim(coalesce(v_claim.provider_name, '')) = '' then
    raise exception 'claim_settle_payout: the named worker changed';
  end if;
  if coalesce(v_claim.env, 'production') <> coalesce(p_env, 'production')
     or v_claim.actual_kobo is null or v_claim.actual_kobo <= 0 then
    raise exception 'claim_settle_payout: no matching reported payable';
  end if;

  select * into v_cost from ledger_entries
   where entry_ref = p_claim_ref || ':cost';
  select * into v_payable from ledger_entries
   where entry_ref = p_claim_ref || ':payable';
  if v_cost.entry_ref is null or v_cost.business_line <> 'care' or v_cost.account <> 'expense'
     or v_cost.direction <> 'debit' or v_cost.amount_kobo <> v_claim.actual_kobo
     or v_cost.source <> 'repair_claim' or coalesce(v_cost.env, 'production') <> coalesce(v_claim.env, 'production')
     or v_payable.entry_ref is null or v_payable.business_line <> 'care' or v_payable.account <> 'payable'
     or v_payable.direction <> 'credit' or v_payable.amount_kobo <> v_claim.actual_kobo
     or v_payable.source <> 'repair_claim' or coalesce(v_payable.env, 'production') <> coalesce(v_claim.env, 'production') then
    raise exception 'claim_settle_payout: the repair cost and payable do not reconcile';
  end if;

  v_ref := p_claim_ref || ':settle';
  v_cash_ref := p_claim_ref || ':cash';
  select * into v_payable from ledger_entries where entry_ref = v_ref;
  select * into v_cost from ledger_entries where entry_ref = v_cash_ref;
  if v_payable.entry_ref is not null or v_cost.entry_ref is not null then
    if v_payable.entry_ref is not null and v_cost.entry_ref is not null
       and v_payable.business_line = 'care' and v_payable.account = 'payable'
       and v_payable.direction = 'debit' and v_payable.amount_kobo = p_amount_kobo
       and v_payable.source = 'repair_payout' and coalesce(v_payable.env, 'production') = coalesce(v_claim.env, 'production')
       and v_cost.business_line = 'care' and v_cost.account = 'cash'
       and v_cost.direction = 'credit' and v_cost.amount_kobo = p_amount_kobo
       and v_cost.source = 'repair_payout' and coalesce(v_cost.env, 'production') = coalesce(v_claim.env, 'production')
       and right(v_payable.memo, length(' · transfer ' || btrim(p_transfer_ref))) = ' · transfer ' || btrim(p_transfer_ref)
       and right(v_cost.memo, length(' · transfer ' || btrim(p_transfer_ref))) = ' · transfer ' || btrim(p_transfer_ref) then
      return jsonb_build_object('ok', true, 'already', true, 'amount_kobo', p_amount_kobo, 'entry_ref', v_ref);
    end if;
    raise exception 'claim_settle_payout: a settlement movement already exists but does not match this transfer';
  end if;
  if p_amount_kobo <> v_claim.actual_kobo then
    raise exception 'claim_settle_payout: settlement must exactly clear the reported provider payable';
  end if;

  insert into ledger_entries
    (entry_ref, business_line, account, direction, amount_kobo, source, memo, actor_ref, actor_name, env)
  values
    (v_ref, 'care', 'payable', 'debit', p_amount_kobo, 'repair_payout',
     'Paid to ' || btrim(p_provider_name) || ' for ' || p_claim_ref || ' · transfer ' || btrim(p_transfer_ref),
     p_actor_ref, p_actor_name, coalesce(p_env, 'production'));
  insert into ledger_entries
    (entry_ref, business_line, account, direction, amount_kobo, source, memo, actor_ref, actor_name, env)
  values
    (v_cash_ref,
     'care', 'cash', 'credit', p_amount_kobo, 'repair_payout',
     'Transfer to ' || btrim(p_provider_name) || ' for ' || p_claim_ref || ' · transfer ' || btrim(p_transfer_ref),
     p_actor_ref, p_actor_name, coalesce(p_env, 'production'));

  insert into claim_events
    (claim_id, reference, from_status, to_status, event, reason, data,
     actor_ref, actor_name, actor_role, env)
  values
    (v_claim.id, v_claim.reference, v_claim.status, v_claim.status, 'payout_settled',
     'Admin recorded the already-completed transfer to ' || btrim(p_provider_name) || ': ' || btrim(p_transfer_ref),
     jsonb_build_object('amount_kobo', p_amount_kobo, 'provider_name', btrim(p_provider_name),
       'provider_transfer_ref', btrim(p_transfer_ref), 'settled_entry_ref', v_ref),
     p_actor_ref, p_actor_name, 'admin', coalesce(p_env, 'production'));

  return jsonb_build_object('ok', true, 'amount_kobo', p_amount_kobo, 'entry_ref', v_ref);
end $$;

revoke all on function claim_settle_payout(text, bigint, text, text, uuid, text, text)
  from public, anon, authenticated;


grant execute on function claim_reserve_callout(uuid, text, text, text, text, text)
  to service_role;
grant execute on function claim_release_callout(uuid, text, text, text, text, text, text)
  to service_role;
grant execute on function claim_settle_payout(text, bigint, text, text, uuid, text, text)
  to service_role;


-- ------------------------------------------------------------
-- 5. RLS — read for the team, write for nobody
--   The claims are personal data and money. Support needs to see them
--   to answer a customer; only the Function (service key) writes.
-- ------------------------------------------------------------

alter table repair_claims enable row level security;
alter table claim_events  enable row level security;

drop policy if exists "admin reads claims"   on repair_claims;
drop policy if exists "support reads claims" on repair_claims;
drop policy if exists "admin reads claim events"   on claim_events;
drop policy if exists "support reads claim events" on claim_events;

create policy "admin reads claims"
  on repair_claims for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support reads claims"
  on repair_claims for select to authenticated
  using (public.arzuz_role() = 'support');

create policy "admin reads claim events"
  on claim_events for select to authenticated
  using (public.arzuz_role() = 'admin');

create policy "support reads claim events"
  on claim_events for select to authenticated
  using (public.arzuz_role() = 'support');


-- ------------------------------------------------------------
-- 6. GRANTS
--   Supabase grants ALL on a new table to anon and authenticated by
--   default; strip that back deliberately. SELECT only, and only for
--   the two roles with a policy above.
-- ------------------------------------------------------------

revoke all on repair_claims, claim_events from anon;
revoke all on repair_claims, claim_events from authenticated;

grant select on repair_claims, claim_events to authenticated;


-- ------------------------------------------------------------
-- 7. THE REPORTING VIEW the dashboard reads
--   Counts by status and the money recorded so far, per environment.
--   Deliberately NOT sums of the ledger — the ledger is the ledger;
--   this is the claim queue's own shape.
-- ------------------------------------------------------------

create or replace view claims_summary as
select
  env,
  status,
  count(*)::int                             as claims,
  count(*) filter (where call_out_no is not null)::int as call_outs_committed,
  coalesce(sum(estimate_kobo), 0)::bigint   as estimated_kobo,
  coalesce(sum(actual_kobo), 0)::bigint     as actual_kobo
from repair_claims
group by env, status;

revoke all on claims_summary from anon, authenticated;
grant select on claims_summary to authenticated;


-- ------------------------------------------------------------
-- 8. WHAT A HEALTHY INSTALL LOOKS LIKE
--
--   select count(*) from pg_proc where proname in
--     ('claim_reserve_callout','claim_release_callout');        -- 2
--
--   -- no claim is completed without the customer's word or a named
--   -- resolution (the CHECK should make this impossible; this proves it)
--   select count(*) from repair_claims
--    where status = 'completed'
--      and customer_confirmed_at is null and resolution is null; -- 0
--
--   -- no call-out is reserved twice at once
--   select plan_id, call_out_no, count(*) from repair_claims
--    where call_out_no is not null
--    group by plan_id, call_out_no having count(*) > 1;         -- 0 rows
--
--   -- the ledger still balances to the reservations + releases
--   select plan_id, sum(delta) from care_credit_events
--    where event in ('reserved','released') group by plan_id;   -- sums to 0 when every claim is closed
--
--   -- nobody but the service key may write a claim
--   select has_table_privilege('authenticated', 'repair_claims', 'INSERT'); -- false
--
--   -- every worker answer carries the instant it was given
--   select count(*) from repair_claims
--    where (provider_answer is null) <> (provider_answered_at is null);  -- 0
--
--   -- a claim is never 'assigned' to somebody who has said no, or to
--   -- somebody the clock has already taken the job back from
--   select count(*) from repair_claims
--    where status = 'assigned'
--      and provider_answer in ('declined', 'unanswered');     -- 0
--
--   -- every proposal carries the instant it was made
--   select count(*) from repair_claims
--    where (provider_proposal is null) <> (provider_proposed_at is null);  -- 0
--
--   -- a day agreed to is always a day somebody actually suggested
--   select count(*) from repair_claims
--    where day_agreed_at is not null and provider_proposal is null;   -- 0
--
--   -- the customer's own suggested day carries the instant too
--   select count(*) from repair_claims
--    where (customer_proposal is null) <> (customer_proposed_at is null);  -- 0
-- ============================================================
