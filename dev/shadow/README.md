# Arzuz — shadow track: accounts + WhatsApp exit + scale + UI/UX

All files in `dev/shadow/` are UNWIRED. No live page, function, SQL runner,
or `netlify.toml` references them. Safe to build here until flipover.

## Goal
Operate from the site only (no WhatsApp dependency) with normal
signup/login, carrying every legacy contact (demand_records, listings,
roommate_profiles, care plans, tickets) into accounts — without touching
the live anon-insert door, RLS, or OpenWA path.

## Phases
1. **Accounts (dark):** `supabase-accounts-shadow.sql` + `account-claim-shadow.js`
   + OTP login mock. Claim-not-migrate: OTP proves inbox ownership, then
   links legacy refs. Phone-tail match alone never grants history.
2. **WhatsApp exit (dark, then flag):** on-site receipts (ref + status link),
   email required on forms, ticket-follow on `/status`, worker magic link
   (Accept/Decline/Propose-day) + dashboard "Record worker answer" fallback.
   Delete OpenWA only after phases 1–2 prove out.
3. **Scale:** paginated queue RPCs (`queue-read-shadow.sql`), per-officer load
   header, `pg_trgm` + `(env,status,tier,area)` indexes, CDN s-maxage on
   public reads, move in-memory rate maps to DB tables, page-only-on-money
   Telegram rule.
4. **UI/UX:** one nav (Sign in / My space), receipt cards reusing `.rvy`,
   single inbox (Requests / Roommates / Care / Messages), sessionStorage
   sessions (shared devices), OTP code UI reused from `status.html`,
   no passwords, no localStorage handles. Team: one triage view,
   late-first, canned replies posting to inbox.

## Flipover rule
Nothing here ships until: `npm test` green on live paths, shadow SQL
applies twice idempotently on a throwaway DB, claim-rate validated on test
data, and flip is a config flag — never a rewrite of a live file.

## Files
- `supabase-accounts-shadow.sql` — profiles + profile_links (additive draft)
- `account-claim-shadow.js` — claim function draft (NOT in netlify/functions)
- `myspace-spec.md` — My-space IA + queue pagination + receipt copy
