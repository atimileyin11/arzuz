# Referral growth loop — end-to-end design

Status: approved for build. This doc is the contract; `scripts/test-referrals.mjs`
proves it. Nothing here changes the money rules in `supabase-finance.sql` §§1–4:
a Care Pass is still coverage (not a wallet), housing is still free, and only a
provider-verified payment activates anything.

## The loop being closed

Today the paid-referral backend is complete (`qualifyReferral` → `referrals` →
admin `referral_decide` → payout) but nobody can *get* a code without the admin
hand-inserting one in Supabase, and buyers must remember to type the code at
checkout. So the loop cannot run by itself. This design closes it:

```
student gets code (self-service mint)
  → shares personal link /register?ref=az-xxxx (code IS the tag)
    → friend registers (tag filed in payload.ref by existing attribution)
      → friend buys Care Pass (code auto-filled from the tag — no typing)
        → payment verifies → referral qualifies → Telegram pings the team
          → admin approves → payout → WhatsApp tells the referrer
            → referrer watches it all on their dashboard → shares again
```

## 1. Codes

- Shape: `AZ-` + 4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L —
  they get misread on WhatsApp forwards). ~1.5M space; collisions retried.
- Stored UPPERCASE in `referral_codes.code`. Lookups uppercase their input, so
  `az-4f2k`, `AZ-4F2K` and `Az-4F2k` are one code (today only the exact case
  matches — that is the first leak being fixed).
- The lowercased code passes `assets/attribution.js` `sanitize()` (letters +
  dash, ≤40 chars), so a personal link needs no new plumbing: the tag *is*
  the code, and the Growth view keeps counting it as a channel.

## 2. Endpoints (all in `netlify/functions/finance.js`)

| action | door | input | behaviour |
|---|---|---|---|
| `referral_mint` | public, 5/min/IP | `{phone, name}` | normalise+validate phone; return existing active code for that phone (idempotent — minting twice is not two codes); else generate, insert, return `{code}` |
| `referral_click` | public, best-effort | `{code}` | if the code is known+active, insert one `referral_clicks` row; always `200 {ok:true}` — a click ping never fails a page and never leaks code validity |
| `referral_stats` | public, 20/min/IP | `{code, phone}` | the code must belong to the phone (the pair is the credential, same pattern as the status page); returns clicks, registrations, referrals with status/reward, earnings split pending vs paid |
| `order` (extended) | public | `+ attribution_tag` | `referral_code = explicit code, else the tag uppercased when it is code-shaped, else null`. The server decides — a client-sent code-shaped tag is a hint, and a mistyped code still fails closed at qualification |

`qualifyReferral` itself is unchanged except uppercasing before lookup. The
qualification event (first verified payment) is unchanged.

## 3. Migration — `supabase-finance.sql` §5c (additive, re-runnable)

- `referral_clicks(id, code, created_at, user_agent, env)` + RLS enabled, **no**
  client policies (service-role writes only — clicks carry no PII and need none).
- Indexes on `(code)`, `(created_at desc)`. No new enums, no altered tables, no
  touched policies — `sql:proof` and `sql:guards` keep passing unmodified.

## 4. Fraud rules

1. **One code per phone** — lookup-first in `referral_mint` (idempotent), so a
   double-tap or a retry mints nothing new.
2. **No self-referral** — already enforced twice (function + `referrals_no_self`
   CHECK); unchanged.
3. **No reward without verified money** — qualification still happens only in
   `activate()` after `claimPaid()`; unchanged.
4. **No double-pay** — `idx_referrals_one_per_payment` + one-per-referred
   (partial, rejection re-opens); unchanged.
5. **No code farming** — mint is 5/min/IP *and* one-per-phone; clicks are
   logged, never rewarded (only verified payments qualify).
6. **Stolen-code use is harmless** — using someone's code gives the *owner* the
   reward, never the buyer; there is nothing to steal.
7. **Revocation** — `referral_codes.active=false` (existing column) already
   fails qualification; this build adds the admin toggle that was missing.

## 5. Pages

- **`my-referrals.html` (new, noindex, no login)** — two boxes: "see what your
  code earned" (`code` + `phone` → `referral_stats` → clicks, registrations,
  per-referral status/reward table, earnings pending vs paid) and "get a code"
  (phone + name → `referral_mint` + personal share link via `ArzuzShare`).
  Redirect pair in `netlify.toml` (`/referrals` ⇄ `/my-referrals.html`).
- **`care-pass.html` confirmation** — after activation, a "your code" card
  (`assets/referral-card.js`, new ES5 module): mints for the buyer's phone,
  shows the code + WhatsApp/copy/share-sheet buttons. Same card is reused on
  `my-referrals.html`.
- **Checkout prefill** — `assets/care-pass.js` fills `cpReferral` from
  `ArzuzRef.tag()` when the tag is code-shaped, with a "from your friend's
  link" note; the buyer can still edit it.
- **Click beacon** — `assets/referral-click.js` (new, ~40 lines): on
  `register.html`/`care-pass.html`, if the current tag is code-shaped, one
  fire-and-forget `referral_click` per session. Guarded (`typeof fetch`,
  try/catch) so a blocked beacon is silent and the attribution suite stays
  green.

## 6. Notifications

- **Qualification → Telegram (team).** `activate()` sends a dedicated
  `🤝 Referral qualified` alert (code, owner, buyer phone, ₦ reward, payment
  ref) in addition to the existing activation line. `sendAlert` never throws,
  so a Telegram outage cannot fail an activation.
- **Payout → WhatsApp (referrer).** `referral_decide` to `paid` looks up the
  owner's phone (`referral_codes.owner_ref`, normalised to a JID) and sends
  the earnings text through `whatsapp-send.js` `sendText()`. The outcome is
  recorded in the response (`notified: true/false + reason`) — a stale number
  fails the message, never the payout.

## 7. Tests — `scripts/test-referrals.mjs` (new, `test:referrals` in the gate)

Drives the real `finance.js` against a fetch-level stand-in (the same technique
as `test-finance.mjs`), plus the pure code-shape helpers:

- mint creates, mint twice returns the same code, bad phone is 400, collision
  retries, unknown/inactive/self code refuses at qualification (direct
  `qualifyReferral` drives), lowercase code qualifies (the case fix),
  order resolves the code from a code-shaped tag and ignores a channel tag,
  click logs best-effort and never 500s, stats refuses a wrong phone and
  aggregates clicks/registrations/referrals/earnings, qualification pages
  Telegram, `paid` decision messages the referrer on WhatsApp and records a
  stale number instead of failing.

Registered in `package.json` (`test:referrals`) and `dev/run-tests.mjs`
(`ORDER`, beside `test:finance`) — the runner refuses a suite that is not in
both, so both edits land together.

## 8. Rollout

1. Run `supabase-finance.sql` (re-runnable; only adds §5c).
2. Deploy. Netlify env: nothing new — Telegram and OpenWA credentials already
   exist; without them the two notifications degrade to logged facts.
3. Existing hand-made codes keep working (lookups are now case-insensitive;
   codes are minted uppercase going forward).
