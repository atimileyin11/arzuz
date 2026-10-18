# Shadow spec — My space + receipts + queue pagination

## My space IA (one inbox, four tabs)
- Requests (demand/listings/bookings by linked ref, stage headline reused
  from `status.js:HEADLINES`, facts list, no payload widening)
- Roommates (pool state + mutual-unlock cards, numbers only after both
  accept — same rule as today)
- Care (balance from server, ledger order, Ask-for-worker files ticket)
- Messages (claim days, ticket replies, worker handovers — all tap-to-act,
  same token auth as `my-care?t=` until accounts flip)

Old `?t=` / `?ref=` links keep rendering (back-compat for screenshots);
when logged in they render inside inbox chrome.

## Receipt card (replaces "we'll WhatsApp you")
- Mono reference, 3-step "what happens next", buttons
  [Check status] [Save my link], copy reused from `.rvy` + `.st-note`.
- Email field required on all forms from flipover (phone stays);
  status fallback (WhatsApp→email same-code) already covers downtime.

## Queue pagination RPC (draft: queue-read-shadow.sql next)
- `SECURITY DEFINER`, role-checked inside via `arzuz_role()`,
  fixed column list (no payload widening), cursor on
  `(created_at, id)`, filters: status, late-only, mine-only,
  per-officer counts in header (`N open · M late · K unclaimed>24h`).
- Reuse for Support Desk / bookings / tickets / verify queue.

## Worker magic link (draft next)
- Single-claim link: Accept / Decline / Propose-day buttons posting
  to claims door; `workerReply()` logic unchanged, transport changes.
- Interim: dashboard "Record worker answer" (phone-call fallback)
  so `wa-inbound.js` can retire before SMS links land.

## Scale index adds (draft with queue RPC)
- `pg_trgm` on listings(area, property_name); composite
  `(env, status, tier, area)`; CDN `s-maxage + stale-while-revalidate`
  on browse/rooms/sitemap-listings; DB-backed send/dedupe tables.
