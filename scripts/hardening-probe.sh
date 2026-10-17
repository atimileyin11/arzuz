#!/usr/bin/env bash
# ============================================================
# ARZUZ — live hardening probe
# Re-runs the whole security review against the LIVE Supabase
# API using only the public anon key (the one in config.js,
# public by design). Read-only except four forged writes that
# the hardening is supposed to REJECT — so nothing is written
# to the database when the hardening holds.
#
# Usage:  bash scripts/hardening-probe.sh
# Exit 0 = every check passed, 1 = at least one failed.
# ============================================================

set -u

SUPABASE_URL="https://nihdbhjecdkpvzvjifrm.supabase.co"
# The anon key is public by design — it ships in every page's
# config.js. Everything it may do is decided server-side by RLS.
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM"

AUTH=( -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" )
NIL="00000000-0000-0000-0000-000000000000"

PASS=0; FAIL=0

# expect <label> <status-regex> [body-must-contain] <curl args...>
# Supabase maps Postgres 42501 to HTTP 401 (older) or 403 (newer),
# so most denial checks match on the status class AND the message.
expect() {
  local label="$1"; local want="$2"; local must="$3"; shift 3
  local raw status body code ok
  raw=$(curl -sS -m 25 -w $'\n__HTTP__%{http_code}' "$@" 2>&1) || raw=$'\n__HTTP__ERR'
  status="${raw##*__HTTP__}"
  body="${raw%__HTTP__*}"
  code=$(printf '%s' "$body" | grep -o '"code":"[A-Za-z0-9]*"' | head -1 | cut -d'"' -f4)
  ok=PASS
  if ! printf '%s' "$status" | grep -qE "^($want)$"; then ok=FAIL; fi
  if [ -n "$must" ] && ! printf '%s' "$body" | grep -qF "$must"; then ok=FAIL; fi
  if [ "$ok" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  printf '%-4s %-44s HTTP %-4s %-6s\n' "[$ok]" "$label" "$status" "${code:-—}"
  if [ "$ok" = FAIL ]; then printf '     body: %.300s\n' "$body"; fi
}

hr() { printf '\n%s\n' "$1"; }

hr "== A. anon READS on the phone-number tables — must be denied =="
RLS_MSG="permission denied"
for t in demand_records listings scout_submissions booking_requests; do
  expect "GET  /$t?select=id"      '401|403' "$RLS_MSG" "${AUTH[@]}" "$SUPABASE_URL/rest/v1/$t?select=id&limit=1"
  expect "HEAD /$t (count header)" '401|403' "" "${AUTH[@]}" -I "$SUPABASE_URL/rest/v1/$t?select=id&limit=1"
done

hr "== B. anon READS on admin-only views — must be denied =="
for v in demand_summary minors_needing_guardian price_movement reported_rent_benchmark roommate_match_summary; do
  expect "GET /$v"           '401|403|404' "$RLS_MSG" "${AUTH[@]}" "$SUPABASE_URL/rest/v1/$v?select=*&limit=1"
done

hr "== C. the ONE public read surface — must return 200 =="
expect "GET /public_listings" '200'      "" "${AUTH[@]}" "$SUPABASE_URL/rest/v1/public_listings?select=*&limit=5"
expect "GET /amenities"       '200'      "" "${AUTH[@]}" "$SUPABASE_URL/rest/v1/amenities?select=*&limit=3"

pl=$(curl -sS -m 25 "${AUTH[@]}" "$SUPABASE_URL/rest/v1/public_listings?select=payload&limit=50" 2>/dev/null || true)
leak=""
for k in '"nm"' '"last"' '"ph"' '"who"' '"email"'; do
  if printf '%s' "$pl" | grep -qF "$k"; then leak="$leak $k"; fi
done
if [ -z "$leak" ]; then
  printf '%-4s %-40s %s\n' "[PASS]" "public payload has no identity keys" "(nm/last/ph/who/email absent)"; PASS=$((PASS+1))
else
  printf '%-4s %-40s leaked:%s\n' "[FAIL]" "public payload has no identity keys" "$leak"; FAIL=$((FAIL+1))
fi

hr "== D. FORGED writes — INSERT with-check must reject them (no row) =="
RLS_CHECK="violates row-level security policy"
expect "POST listings         status=active tier=2" '401|403' "$RLS_CHECK" "${AUTH[@]}" -X POST \
  -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
  -d '{"payload":{},"status":"active","tier":2,"env":"production"}' \
  "$SUPABASE_URL/rest/v1/listings"
expect "POST demand_records   status=closed"        '401|403' "$RLS_CHECK" "${AUTH[@]}" -X POST \
  -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
  -d '{"payload":{},"status":"closed","env":"production"}' \
  "$SUPABASE_URL/rest/v1/demand_records"
expect "POST scout_submissions status=active"       '401|403' "$RLS_CHECK" "${AUTH[@]}" -X POST \
  -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
  -d '{"payload":{},"status":"active","env":"production"}' \
  "$SUPABASE_URL/rest/v1/scout_submissions"
expect "POST booking_requests status=confirmed"     '401|403' "$RLS_CHECK" "${AUTH[@]}" -X POST \
  -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
  -d '{"payload":{},"status":"confirmed","env":"production"}' \
  "$SUPABASE_URL/rest/v1/booking_requests"

hr "== D2. the direct door is closed — anon holds no INSERT grant =="
# THE LAST LAUNCH STEP, and the one easiest to believe without checking.
# supabase-close-public-inserts.sql revokes anon's insert on these five
# tables, and that revoke is what makes the server-side door the only way
# in. Section D cannot see it: a forged STATE column (status=active,
# tier=2) is refused by a row policy even while the grant is still open, so
# section D passes on a database that has not run that file — it asks "may
# you write an ACTIVE row", never "may you write at all". A bare insert is
# the question, so it is asked here.
#
# The body is empty on purpose, so both answers are safe to send: `payload`
# is NOT NULL on all five tables, so a live grant answers 400 (not-null
# violation) and writes nothing, while a revoked grant answers 401/403.
# 200/201 means the grant survived and this run has just left a junk row
# behind: delete it (Table Editor, or the admin's own delete), then run
# supabase-close-public-inserts.sql.
for t in demand_records listings scout_submissions booking_requests support_tickets; do
  expect "POST /$t (bare insert)" '401|403' "" "${AUTH[@]}" -X POST \
    -H 'Content-Type: application/json' -H 'Prefer: return=minimal' -d '{}' \
    "$SUPABASE_URL/rest/v1/$t"
done

hr "== E. anon UPDATE / DELETE — grants revoked, must be denied =="
expect "PATCH  /listings (no rows match)"          '401|403' "$RLS_MSG" "${AUTH[@]}" -X PATCH \
  -H 'Content-Type: application/json' -d '{"notes":"probe"}' \
  "$SUPABASE_URL/rest/v1/listings?id=eq.$NIL"
expect "DELETE /demand_records (no rows)"          '401|403' "$RLS_MSG" "${AUTH[@]}" -X DELETE \
  "$SUPABASE_URL/rest/v1/demand_records?id=eq.$NIL"
# tier is a plain, updatable base column, so this PATCH is only
# stopped by the revoked UPDATE grant: 401 = revoked, 404 would
# mean the grant survived the hardening (real gap).
expect "PATCH  /public_listings tier (grant test)" '401|403' "$RLS_MSG" "${AUTH[@]}" -X PATCH \
  -H 'Content-Type: application/json' -d '{"tier":5}' \
  "$SUPABASE_URL/rest/v1/public_listings?id=eq.$NIL"
expect "DELETE /public_listings via definer view"  '401|403' "$RLS_MSG" "${AUTH[@]}" -X DELETE \
  "$SUPABASE_URL/rest/v1/public_listings?id=eq.$NIL"

hr "== F. Supabase Auth — admin API closed, public sign-ups off =="
expect "GET /auth/v1/admin/users (anon)" '401|403' "" "${AUTH[@]}" "$SUPABASE_URL/auth/v1/admin/users"
ts=$(date +%s)
signup=$(curl -sS -m 25 "${AUTH[@]}" -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"hardening-probe+$ts@example.com\",\"password\":\"Xq9pt${ts}wTz\"}" \
  -o /dev/null -w '%{http_code}' "$SUPABASE_URL/auth/v1/signup" 2>/dev/null || echo ERR)
scase=FAIL
case "$signup" in 400|403|422) scase=PASS;; esac
if [ "$scase" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
printf '%-4s %-40s HTTP %-4s %s\n' "[$scase]" "POST /auth/v1/signup (public sign-up)" "$signup" "expect 400/403/422 = sign-ups off"

hr "== G. API health =="
# 200 is fine; 401 'only service_role' means even schema
# introspection is closed — stricter than required, still healthy.
expect "GET /rest/v1/ (OpenAPI)"                   '200|401' "" "${AUTH[@]}" "$SUPABASE_URL/rest/v1/"

hr "==================================================="
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
