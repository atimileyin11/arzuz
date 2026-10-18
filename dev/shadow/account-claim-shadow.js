/* ============================================================
   ARZUZ SHADOW — account claim (DRAFT, UNWIRED)
   NOT in netlify/functions — do not deploy. Draft only.

   Flow: OTP (Supabase Auth email/phone) proves inbox ownership.
   Then POST { kind, ref, otp_session } — service role matches
   phoneTail()/lower-cased email against the legacy row's payload,
   and writes shadow_profile_links. Never grants on typed number
   alone; typed contact proves nothing, holding the inbox proves
   everything (same rule as status.js).

   Reads legacy via service role; writes link only; returns
   { ok, linked: n } — never the row, never PII.
   ============================================================ */

'use strict';

function phoneTail(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/.test(s) ? s : '';
}

// SHADOW: verify otp_session with Supabase Auth (/auth/v1/user),
// extract proven phone/email, match against legacy payload,
// insert into shadow_profile_links. Service role only.
exports.handler = async function () {
  return {
    statusCode: 501,
    body: JSON.stringify({ error: 'shadow draft — not wired' }),
  };
};

exports.phoneTail = phoneTail;
exports.normEmail = normEmail;
