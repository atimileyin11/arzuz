#!/usr/bin/env node
/* ============================================================
   Arzuz — the self-service referral loop

   netlify/functions/finance.js grew three public doors
   (referral_mint, referral_click, referral_stats), a team report
   that carries referrals, an admin referral_decide that pages the
   referrer on WhatsApp, and an admin referral_code switch — and the
   site grew the pages that knock on them (my-referrals.html, the
   share card in assets/referral-card.js, the beacon in
   assets/referral-click.js). The qualify-time fraud rules (verified
   payment only, no self-referral, one reward per payment, one per
   customer) already belong to scripts/test-finance.mjs, which drives
   them through order → verify; duplicating that here would test the
   stand-in twice. This suite owns everything AFTER that line:

     · minting is one code per phone, AZ-shaped, and metered
     · a click is logged but never rewarded, never identifying, and
       never fails the page — unknown codes, dead codes and database
       hiccups all answer ok
     · the dashboard reads through code + phone, splits earnings into
       pending vs paid, caps the click read, and says when a code is
       switched off
     · qualification pages the team on Telegram; a payout pages the
       referrer on WhatsApp — and neither channel can un-qualify or
       un-pay anything when it is down
     · switching a code off stops new qualifications without touching
       earned rewards; only the admin login may flip it
     · the beacon's idea of "a code" and the function's are the same
       idea, proved rather than imported
     · the routes, the privacy posture and the page wiring are still
       what the design doc promises

   The stand-in below is a small PostgREST for the referral paths
   only, plus captured Telegram and OpenWA endpoints. It enforces the
   SAME uniqueness supabase-finance.sql declares (one referral per
   qualifying payment, one live qualification per referred customer),
   so a test failing here is a bug in the function.

   Run from arzuz-site/:
     node scripts/test-referrals.mjs
   ============================================================ */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The module refuses to write without a service key (503), which is
   correct — so the key is set here first. Telegram and OpenWA get
   stand-in credentials so the notification paths actually send
   (into the capture below, not the network). */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stand-in.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'stand-in-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stand-in-service-role-key';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'stand-in-bot-token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'stand-in-chat-id';
process.env.OPENWA_URL = process.env.OPENWA_URL || 'https://openwa.stand-in';
process.env.OPENWA_API_KEY = process.env.OPENWA_API_KEY || 'stand-in-openwa-key';

const finance = require('../netlify/functions/finance.js');

/* ---------------- tiny runner ---------------- */

let passed = 0;
const failures = [];

async function t(name, body) {
  try {
    await body();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push(name + ' — ' + (err && err.message));
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((what || 'value') + ': expected ' + e + ', got ' + a);
}

/* ---------------- the stand-in ---------------- */

const state = {
  ip: 0,
  seq: 0,
  auth: null,
  codes: {},       // code -> { code, owner_ref, owner_name, active, env }
  clicks: [],      // { code, user_agent, env, created_at }
  demand: [],      // { ref, created_at, 'payload->>ref' }
  listed: [],      // listings rows carrying the same payload tag
  referrals: [],   // referral rows
  reportRows: [],  // referral_report view rows
  telegrams: [],   // captured sendMessage payloads
  whatsapps: [],   // captured OpenWA send-text payloads
};

function resp(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (obj === undefined ? '' : JSON.stringify(obj)),
    json: async () => (obj === undefined ? null : obj),
  };
}

const dup = (what) => resp(409, { code: '23505', message: 'duplicate key value violates unique constraint "' + what + '"' });

function filterMatch(row, q) {
  for (const [key, raw] of q.entries()) {
    if (key === 'select' || key === 'limit' || key === 'order' || key === 'on_conflict') continue;
    const val = String(raw);
    if (val === 'is.null') { if (row[key] != null) return false; continue; }
    if (val === 'is.true') { if (row[key] !== true) return false; continue; }
    if (/^eq\./.test(val)) { if (String(row[key]) !== val.slice(3)) return false; continue; }
  }
  return true;
}

global.fetch = async function (url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;

  /* --- Telegram capture --- */
  if (u.indexOf('api.telegram.org') !== -1) {
    if (u.indexOf('/sendMessage') !== -1) state.telegrams.push(body);
    return resp(200, { ok: true });
  }

  /* --- OpenWA capture --- */
  if (u.indexOf('openwa.stand-in') !== -1) {
    state.whatsapps.push(body);
    return resp(200, { ok: true });
  }

  /* --- Supabase auth + role --- */
  if (u.indexOf('/auth/v1/user') !== -1) {
    if (!state.auth || !state.auth.user) return resp(401, { message: 'invalid claim' });
    return resp(200, { id: state.auth.user, email: state.auth.user + '@arzuz.test' });
  }
  if (u.indexOf('/rest/v1/rpc/arzuz_role') !== -1) {
    if (!state.auth) return resp(401, {});
    return resp(200, state.auth.role);
  }

  if (u.indexOf('/rest/v1/') === -1) return resp(200, {});

  const rest = u.slice(u.indexOf('/rest/v1/') + '/rest/v1/'.length);
  const table = rest.split('?')[0];
  const qs = rest.indexOf('?') !== -1 ? rest.slice(rest.indexOf('?') + 1) : '';
  const q = new URLSearchParams(qs);

  if (table === 'referral_codes') {
    const all = Object.keys(state.codes).map((code) => Object.assign({ code }, state.codes[code]));
    if (method === 'GET') return resp(200, all.filter((r) => filterMatch(r, q)));
    if (method === 'POST') {
      if (state.codes[body.code]) return dup('referral_codes_pkey');
      state.codes[body.code] = { owner_ref: body.owner_ref, owner_name: body.owner_name, active: true, env: body.env };
      return resp(201, []);
    }
    if (method === 'PATCH') {
      const found = all.filter((r) => filterMatch(r, q));
      found.forEach((r) => Object.assign(state.codes[r.code], body));
      const want = (init.headers && init.headers.Prefer) || '';
      return /return=representation/.test(want) ? resp(200, found) : resp(204);
    }
  }

  if (table === 'referral_clicks') {
    if (method === 'POST') {
      state.clicks.push(Object.assign({ created_at: new Date().toISOString() }, body));
      return resp(201, []);
    }
    if (method === 'GET') {
      const rows = state.clicks.filter((r) => filterMatch(r, q));
      const limit = Number(q.get('limit')) || rows.length;
      return resp(200, rows.slice(0, limit));
    }
  }

  if (table === 'demand_records' && method === 'GET') {
    return resp(200, state.demand.filter((r) => filterMatch(r, q)));
  }

  if (table === 'listings' && method === 'GET') {
    return resp(200, state.listed.filter((r) => filterMatch(r, q)));
  }

  if (table === 'referrals') {
    if (method === 'POST') {
      if (body.qualifying_payment_id && state.referrals.some((r) => r.qualifying_payment_id === body.qualifying_payment_id)) {
        return dup('idx_referrals_one_per_payment');
      }
      if (body.referred_ref && state.referrals.some((r) => r.referred_ref === body.referred_ref && r.status !== 'rejected')) {
        return dup('idx_referrals_one_per_referred');
      }
      const row = Object.assign({ id: 'qr-' + (++state.seq), created_at: new Date().toISOString() }, body);
      state.referrals.push(row);
      return resp(201, [row]);
    }
    if (method === 'GET') {
      let rows = state.referrals.filter((r) => filterMatch(r, q));
      if ((q.get('order') || '').indexOf('created_at.desc') !== -1) {
        rows = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      const limit = Number(q.get('limit')) || rows.length;
      return resp(200, rows.slice(0, limit));
    }
    if (method === 'PATCH') {
      const found = state.referrals.filter((r) => filterMatch(r, q));
      found.forEach((r) => Object.assign(r, body));
      const want = (init.headers && init.headers.Prefer) || '';
      return /return=representation/.test(want) ? resp(200, found) : resp(204);
    }
  }

  if (table === 'referral_report' && method === 'GET') return resp(200, state.reportRows);

  return resp(200, []);
};

/* ---------------- helpers ---------------- */

/* Same discipline as test-finance.mjs: every call is a fresh caller,
   so no test measures the rate ceiling by accident — except the three
   tests that measure it on purpose, which pin one IP. */
async function call(body, opts = {}) {
  state.ip = (state.ip || 0) + 1;
  if (opts.role) {
    state.auth = { user: 'user-' + state.ip + '-0000000000000', role: opts.role };
  }
  const event = {
    httpMethod: 'POST',
    headers: Object.assign({
      'x-nf-client-connection-ip': opts.ip || ('10.' + (state.ip % 200) + '.' + (state.ip % 250) + '.' + (state.ip % 251)),
    }, opts.headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  const res = await finance.handler(event);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = null; }
  return { status: res.statusCode, body: parsed };
}

const source = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ============================================================
   1. minting — one code per phone, shaped, metered
   ============================================================ */

console.log('\n1. Minting hands out one shaped code per phone\n');

await t('a minted code is AZ- plus four unambiguous chars', async () => {
  const res = await call({ action: 'referral_mint', phone: '08031112233', name: 'Ada' });
  eq(res.status, 201, 'status');
  eq(res.body.ok, true, 'ok');
  if (!/^AZ-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(res.body.code)) {
    throw new Error('not a code: ' + res.body.code);
  }
  eq(state.codes[res.body.code].owner_ref, '2348031112233', 'the owner is the normalised phone');
});

await t('minting twice for one number returns the same code', async () => {
  const first = await call({ action: 'referral_mint', phone: '08031112233', name: 'Ada' });
  const second = await call({ action: 'referral_mint', phone: '08031112233', name: 'Ada Again' });
  eq(second.status, 200, 'status');
  eq(second.body.code, first.body.code, 'the code');
  eq(second.body.existing, true, 'it says so');
});

await t('two hundred mints are all distinct', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(finance.mintReferralCode());
  eq(seen.size, 200, 'distinct codes');
});

await t('a number that is not a phone mints nothing', async () => {
  const res = await call({ action: 'referral_mint', phone: 'not a number', name: 'X' });
  eq(res.status, 400, 'status');
});

await t('the sixth mint in a minute from one connection is refused', async () => {
  const ip = '9.9.9.11';
  for (let i = 0; i < 5; i += 1) {
    await call({ action: 'referral_mint', phone: '0801000000' + i, name: 'Meter' }, { ip });
  }
  const sixth = await call({ action: 'referral_mint', phone: '08019999999', name: 'Meter' }, { ip });
  eq(sixth.status, 429, 'status');
});

/* ============================================================
   2. clicks — counted, never rewarded, never failing
   ============================================================ */

console.log('\n2. A click is logged, never rewarded, never a failure\n');

await t('a visit to a live code leaves one row', async () => {
  const before = state.clicks.length;
  const res = await call({ action: 'referral_click', code: Object.keys(state.codes)[0], env: 'production' },
    { headers: { 'user-agent': 'test-agent' } });
  eq(res.status, 200, 'status');
  eq(res.body.ok, true, 'ok');
  eq(state.clicks.length, before + 1, 'one row');
});

await t('an unknown code still answers ok, and writes nothing', async () => {
  const before = state.clicks.length;
  const res = await call({ action: 'referral_click', code: 'AZ-ZZZZ' });
  eq(res.status, 200, 'status');
  eq(res.body.ok, true, 'ok — the ping never leaks which codes exist');
  eq(state.clicks.length, before, 'no row');
});

await t('a channel tag is not a code and writes nothing', async () => {
  const before = state.clicks.length;
  const res = await call({ action: 'referral_click', code: 'whatsapp-status' });
  eq(res.status, 200, 'status');
  eq(state.clicks.length, before, 'no row');
});

await t('a switched-off code stops counting visits', async () => {
  const minted = await call({ action: 'referral_mint', phone: '08032223344', name: 'Off' });
  await call({ action: 'referral_code', code: minted.body.code, revoked: true },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  const before = state.clicks.length;
  const res = await call({ action: 'referral_click', code: minted.body.code });
  eq(res.status, 200, 'status');
  eq(state.clicks.length, before, 'no row for a dead code');
});

await t('a long user agent is truncated, not rejected', async () => {
  const code = Object.keys(state.codes).filter((c) => state.codes[c].active)[0];
  await call({ action: 'referral_click', code: code }, { headers: { 'user-agent': 'x'.repeat(200) } });
  const last = state.clicks[state.clicks.length - 1];
  if (String(last.user_agent).length > 120) throw new Error('stored ' + last.user_agent.length + ' chars of agent');
});

await t('past the beacon ceiling the ping is dropped, never refused', async () => {
  const ip = '9.9.9.12';
  const code = Object.keys(state.codes).filter((c) => state.codes[c].active)[0];
  const before = state.clicks.length;
  let last = null;
  for (let i = 0; i < 61; i += 1) last = await call({ action: 'referral_click', code: code }, { ip });
  eq(last.status, 200, 'still 200 over the limit');
  eq(last.body.ok, true, 'still ok');
  if (state.clicks.length - before >= 61) throw new Error('over-limit pings were all written');
});

/* ============================================================
   3. the dashboard — code plus phone, honestly aggregated
   ============================================================ */

console.log('\n3. The dashboard answers only its owner, and splits pending from paid\n');

const DASH_PHONE = '08034445566';
let DASH_CODE = null;

await t('the dashboard needs both halves of the credential', async () => {
  const minted = await call({ action: 'referral_mint', phone: DASH_PHONE, name: 'Dash' });
  DASH_CODE = minted.body.code;
  const noPhone = await call({ action: 'referral_stats', code: DASH_CODE });
  eq(noPhone.status, 400, 'no phone');
  const noCode = await call({ action: 'referral_stats', phone: DASH_PHONE });
  eq(noCode.status, 400, 'no code');
  const ghost = await call({ action: 'referral_stats', code: 'AZ-QQQQ', phone: DASH_PHONE });
  eq(ghost.status, 404, 'unknown code');
});

await t('a wrong number is refused, not shown an empty page', async () => {
  const res = await call({ action: 'referral_stats', code: DASH_CODE, phone: '08039999999' });
  eq(res.status, 403, 'status');
});

await t('clicks, signups, rewards and earnings are aggregated', async () => {
  state.clicks.push({ code: DASH_CODE, user_agent: 'a', env: 'production', created_at: new Date().toISOString() });
  state.clicks.push({ code: DASH_CODE, user_agent: 'b', env: 'production', created_at: new Date().toISOString() });
  state.demand.push({ ref: 'wl-1', created_at: '2026-10-10T00:00:00.000Z', 'payload->>ref': DASH_CODE.toLowerCase() });
  state.referrals.push({
    id: 'qr-dash-1', code: DASH_CODE, status: 'approved', reward_kobo: 200000,
    created_at: '2026-10-11T00:00:00.000Z', decided_at: null, paid_at: null,
  });
  state.referrals.push({
    id: 'qr-dash-2', code: DASH_CODE, status: 'paid', reward_kobo: 200000,
    created_at: '2026-10-09T00:00:00.000Z', decided_at: '2026-10-09T00:00:00.000Z', paid_at: '2026-10-10T00:00:00.000Z',
  });
  state.referrals.push({
    id: 'qr-dash-3', code: DASH_CODE, status: 'rejected', reward_kobo: 200000,
    created_at: '2026-10-08T00:00:00.000Z', decided_at: '2026-10-08T00:00:00.000Z', paid_at: null,
  });
  const res = await call({ action: 'referral_stats', code: DASH_CODE.toLowerCase(), phone: DASH_PHONE });
  eq(res.status, 200, 'status — lookups uppercase their input');
  eq(res.body.clicks.count, 2, 'visits');
  eq(res.body.clicks.capped, false, 'capped flag');
  eq(res.body.registrations.length, 1, 'signups');
  eq(res.body.referrals.length, 3, 'three rewards');
  eq(res.body.referrals.map((r) => r.status), ['approved', 'paid', 'rejected'], 'newest first');
  eq(res.body.earnings.paid_kobo, 200000, 'paid out');
  eq(res.body.earnings.pending_kobo, 200000, 'pending — the rejected reward is in neither pile');
  eq(res.body.active, true, 'the code is live');
});

await t('a property listed through the link shows apart from signups', async () => {
  state.listed.push({ ref: 'wl-list-1', created_at: '2026-10-10T00:00:00.000Z', 'payload->>ref': DASH_CODE.toLowerCase() });
  const res = await call({ action: 'referral_stats', code: DASH_CODE, phone: DASH_PHONE });
  eq(res.status, 200, 'status');
  eq((res.body.listed || []).length, 1, 'one listing');
  eq(res.body.registrations.length, 1, 'signups untouched');
  eq(res.body.referrals.length, 3, 'rewards untouched — a listing never qualifies');
});

await t('five thousand visits raise the capped flag instead of a sixth thousand reads', async () => {
  for (let i = 0; i < 5000; i += 1) {
    state.clicks.push({ code: DASH_CODE, user_agent: 'bulk', env: 'production', created_at: new Date().toISOString() });
  }
  const res = await call({ action: 'referral_stats', code: DASH_CODE, phone: DASH_PHONE });
  eq(res.body.clicks.count, 5000, 'the read stops at the cap');
  eq(res.body.clicks.capped, true, 'and says so');
});

await t('the dashboard is metered, not open-ended', async () => {
  const ip = '9.9.9.13';
  for (let i = 0; i < 20; i += 1) {
    await call({ action: 'referral_stats', code: DASH_CODE, phone: DASH_PHONE }, { ip });
  }
  const over = await call({ action: 'referral_stats', code: DASH_CODE, phone: DASH_PHONE }, { ip });
  eq(over.status, 429, 'status');
});

/* ============================================================
   4. qualification pages the team — Telegram
   ============================================================ */

console.log('\n4. A qualification tells the team on Telegram, and nothing else moves money\n');

const QUAL_PHONE = '08035556677';
let QUAL_CODE = null;

await t('a verified first payment qualifies, and the team hears it now', async () => {
  const minted = await call({ action: 'referral_mint', phone: '08030001111', name: 'Kola' });
  QUAL_CODE = minted.body.code;
  state.telegrams.length = 0;
  const out = await finance.qualifyReferral({
    referral_code: QUAL_CODE.toLowerCase(),
    subject: { phone: QUAL_PHONE },
    id: 'pay-qual-1',
    reference: 'AZ-R-QUAL-1',
    reward_kobo: 200000,
    env: 'production',
  });
  eq(out.ok, true, 'qualified');
  eq(out.row.status, 'pending_qualification', 'born pending');
  eq(state.telegrams.length, 1, 'one alert');
  const text = state.telegrams[0].text;
  for (const need of [QUAL_CODE, '2348035556677', 'AZ-R-QUAL-1']) {
    if (text.indexOf(need) === -1) throw new Error('the alert does not name ' + need + ': ' + text.slice(0, 160));
  }
});

await t('the reward falls back to two thousand naira when none is priced', async () => {
  const out = await finance.qualifyReferral({
    referral_code: QUAL_CODE,
    subject: { phone: '08036667788' },
    id: 'pay-qual-2',
    reference: 'AZ-R-QUAL-2',
    env: 'production',
  });
  eq(out.ok, true, 'qualified');
  eq(out.row.reward_kobo, 200000, 'the fallback');
});

await t('a replayed payment cannot pay twice', async () => {
  const again = await finance.qualifyReferral({
    referral_code: QUAL_CODE,
    subject: { phone: QUAL_PHONE },
    id: 'pay-qual-1',
    reference: 'AZ-R-QUAL-1',
    reward_kobo: 200000,
    env: 'production',
  });
  eq(again.ok, false, 'refused');
  eq(again.reason, 'already claimed', 'the reason');
});

await t('sharing your own link pays nobody', async () => {
  const before = state.referrals.length;
  const out = await finance.qualifyReferral({
    referral_code: QUAL_CODE,
    subject: { phone: '08030001111' },
    id: 'pay-qual-3',
    reference: 'AZ-R-QUAL-3',
    reward_kobo: 200000,
    env: 'production',
  });
  eq(out.ok, false, 'refused');
  eq(out.reason, 'self-referral refused', 'the reason');
  eq(state.referrals.length, before, 'no row');
});

await t('a code that was switched off qualifies nobody', async () => {
  await call({ action: 'referral_code', code: QUAL_CODE, revoked: true },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  const out = await finance.qualifyReferral({
    referral_code: QUAL_CODE,
    subject: { phone: '08037778899' },
    id: 'pay-qual-4',
    reference: 'AZ-R-QUAL-4',
    reward_kobo: 200000,
    env: 'production',
  });
  eq(out.ok, false, 'refused');
  await call({ action: 'referral_code', code: QUAL_CODE, revoked: false },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
});

/* ============================================================
   5. the decision pages the referrer — WhatsApp
   ============================================================ */

console.log('\n5. A payout tells the referrer on WhatsApp, with the provider reference\n');

await t('moving a reward to paid notifies the code owner', async () => {
  const minted = await call({ action: 'referral_mint', phone: '08038889900', name: 'Funmi' });
  state.referrals.push({
    id: 'qr-pay-1', code: minted.body.code, status: 'approved', reward_kobo: 200000,
    referred_ref: '2348099999000', qualifying_payment_id: 'pay-x-1',
    created_at: new Date().toISOString(),
  });
  state.whatsapps.length = 0;
  const res = await call(
    { action: 'referral_decide', id: 'qr-pay-1', status: 'paid', payout_provider_ref: 'TRF-123' },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 200, 'status');
  eq(res.body.notified, true, 'the answer says so');
  eq(res.body.notify_reason, 'sent', 'the reason');
  eq(state.whatsapps.length, 1, 'one message');
  const msg = state.whatsapps[0];
  if (String(msg.chatId).indexOf('2348038889900') === -1) {
    throw new Error('the owner was not paged: ' + JSON.stringify(msg).slice(0, 160));
  }
  for (const need of ['2,000', 'TRF-123', minted.body.code]) {
    if (msg.text.indexOf(need) === -1) throw new Error('the message does not name ' + need);
  }
});

await t('a non-payout decision pages nobody', async () => {
  state.referrals.push({
    id: 'qr-pay-2', code: DASH_CODE, status: 'pending_qualification', reward_kobo: 200000,
    referred_ref: '2348011112222', qualifying_payment_id: 'pay-x-2',
    created_at: new Date().toISOString(),
  });
  state.whatsapps.length = 0;
  const res = await call({ action: 'referral_decide', id: 'qr-pay-2', status: 'approved' },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 200, 'status');
  eq(res.body.notified, false, 'nothing sent');
  eq(res.body.notify_reason, 'not-a-payout', 'the reason');
  eq(state.whatsapps.length, 0, 'no message');
});

await t('a mistyped id is a 404, not a confirmed payout', async () => {
  const res = await call({ action: 'referral_decide', id: 'qr-does-not-exist', status: 'approved' },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 404, 'status');
});

await t('paid still needs the provider reference', async () => {
  const res = await call({ action: 'referral_decide', id: 'qr-pay-2', status: 'paid' },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 400, 'status');
});

await t('an unknown state is refused with the vocabulary', async () => {
  const res = await call({ action: 'referral_decide', id: 'qr-pay-2', status: 'pending_qualification' },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 400, 'a referral is born pending — an operator cannot move one back to it');
});

await t('the desk cannot move a payout, and a stranger cannot open the books', async () => {
  const support = await call({ action: 'referral_decide', id: 'qr-pay-2', status: 'approved' },
    { role: 'support', headers: { authorization: 'Bearer support-token-000000001' } });
  eq(support.status, 403, 'support');
  state.auth = null;
  const anon = await call({ action: 'referral_decide', id: 'qr-pay-2', status: 'approved' },
    { headers: { authorization: 'Bearer short' } });
  eq(anon.status, 401, 'a junk token');
});

/* ============================================================
   6. revocation — off stops new earnings, old ones stand
   ============================================================ */

console.log('\n6. Switching a code off ends its future, not its past\n');

await t('revoked:true switches the code off, revoked:false switches it back', async () => {
  const minted = await call({ action: 'referral_mint', phone: '08039001122', name: 'Seun' });
  const off = await call({ action: 'referral_code', code: minted.body.code.toLowerCase(), revoked: true },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(off.status, 200, 'off answers 200 — lookups lowercase their input');
  eq(off.body.active, false, 'off');
  const stats = await call({ action: 'referral_stats', code: minted.body.code, phone: '08039001122' });
  eq(stats.body.active, false, 'the dashboard says so');
  const on = await call({ action: 'referral_code', code: minted.body.code, revoked: false },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(on.body.active, true, 'back on');
});

await t('the active:true form keeps working', async () => {
  const minted = await call({ action: 'referral_mint', phone: '08039003344', name: 'Tunde' });
  const off = await call({ action: 'referral_code', code: minted.body.code, active: false },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(off.body.active, false, 'off');
});

await t('a code that never existed is a 404, and support cannot flip one', async () => {
  const ghost = await call({ action: 'referral_code', code: 'AZ-QQQQ', revoked: true },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(ghost.status, 404, 'unknown code');
  const support = await call({ action: 'referral_code', code: DASH_CODE, revoked: true },
    { role: 'support', headers: { authorization: 'Bearer support-token-000000001' } });
  eq(support.status, 403, 'support');
});

/* ============================================================
   7. the team's report carries the pipeline
   ============================================================ */

console.log('\n7. The finance report still carries referrals\n');

await t('referral_report rows reach the team answer', async () => {
  state.reportRows = [{ status: 'paid', claims: 3, reward_kobo: 600000 }];
  const res = await call({ action: 'report' },
    { role: 'admin', headers: { authorization: 'Bearer admin-token-000000000001' } });
  eq(res.status, 200, 'status');
  eq(JSON.stringify(res.body.referrals).indexOf('paid') !== -1, true, 'the pipeline is in the answer');
});

/* ============================================================
   8. the two ends agree — beacon, card, pages, panel
   ============================================================ */

console.log('\n8. The browser files and the function speak one dialect\n');

function loadBrowser(rel, extra) {
  const sandbox = Object.assign({
    window: {},
    console: { log() {}, info() {}, warn() {}, error() {} },
  }, extra || {});
  sandbox.window = sandbox.window || {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source(rel), sandbox, { filename: rel });
  return sandbox;
}

await t('the beacon and the function agree on what a code is', async () => {
  const store = {};
  const sandbox = loadBrowser('assets/referral-click.js', {
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    navigator: {},
  });
  const beacon = sandbox.ArzuzReferralClick || sandbox.window.ArzuzReferralClick;
  const tags = ['AZ-4F2K', 'az-4f2k', '  az-9Q2W  ', 'whatsapp-status', 'register', 'AZ-ABC',
    'AZ-TOOLONG123', 'AMB-OK', '', null, undefined, 'AZ-4F2K EXTRA'];
  for (const tag of tags) {
    const theirs = beacon.isCode(tag);
    const ours = finance.normalizeReferralCode(tag) !== null;
    if (theirs !== ours) throw new Error('they disagree on ' + JSON.stringify(tag));
  }
});

await t('the beacon pings once per session, and never for a channel tag', async () => {
  const pings = [];
  const store = {};
  const sandbox = loadBrowser('assets/referral-click.js', {
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    navigator: { sendBeacon: (url, body) => { pings.push({ url, body: String(body) }); return true; } },
  });
  const beacon = sandbox.ArzuzReferralClick || sandbox.window.ArzuzReferralClick;
  sandbox.window.ArzuzRef = { tag: () => 'az-4f2k' };
  eq(beacon.boot(), 'AZ-4F2K', 'it pinged');
  eq(pings.length, 1, 'once');
  eq(pings[0].body.indexOf('referral_click') !== -1, true, 'the action');
  eq(beacon.boot(), '', 'a second boot in the session is silent');
  eq(pings.length, 1, 'still once');
  sandbox.window.ArzuzRef = { tag: () => 'whatsapp-status' };
  eq(beacon.boot(), '', 'a channel tag never pings');
  eq(pings.length, 1, 'still once');
});

await t('the server, not the buyer, attaches the code to the order', async () => {
  eq(finance.resolveReferralCode('az-4f2k', 'whatsapp-status'), 'AZ-4F2K', 'what the buyer typed wins, uppercased');
  eq(finance.resolveReferralCode('', 'az-4f2k'), 'AZ-4F2K', 'otherwise the code-shaped tag travels');
  eq(finance.resolveReferralCode('', 'whatsapp-status'), null, 'a channel tag travels as nothing');
  eq(finance.resolveReferralCode('  ', 'AZ-9Q2W'), 'AZ-9Q2W', 'blank input falls through to the tag');
});

await t('the card module exposes one door, and the link carries the tag', async () => {
  const sandbox = loadBrowser('assets/referral-card.js', {
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  });
  const card = sandbox.ArzuzReferralCard || sandbox.window.ArzuzReferralCard;
  for (const fn of ['mount', 'show', 'personalLink']) {
    if (typeof card[fn] !== 'function') throw new Error('ArzuzReferralCard.' + fn + ' is missing');
  }
  const link = card.personalLink('AZ-4F2K');
  if (link.indexOf('ref=az-4f2k') === -1) throw new Error('the personal link is not a tagged link: ' + link);
});

await t('register and care-pass carry the beacon, after attribution', async () => {
  for (const page of ['register.html', 'care-pass.html']) {
    const html = source(page);
    const beaconAt = html.indexOf('assets/referral-click.js');
    const bootAt = html.indexOf('ArzuzReferralClick.boot()');
    const attrAt = html.indexOf('assets/attribution.js');
    if (beaconAt === -1) throw new Error(page + ' does not load the beacon');
    if (bootAt === -1) throw new Error(page + ' never boots it');
    if (attrAt !== -1 && !(attrAt < beaconAt)) {
      throw new Error(page + ' boots the beacon before attribution filed the tag');
    }
  }
});

await t('register mints the personal code on its done screen', async () => {
  /* The done screen used to share only a channel tag, so a newly
     registered student had no personal link without a second journey
     to /referrals. The page must load the card module and mount it
     with the number just given — and only on a saved row (the
     reference box), never on a queued or refused save. */
  const html = source('register.html');
  if (html.indexOf('assets/referral-card.js') === -1) {
    throw new Error('register.html does not load the referral card module');
  }
  if (html.indexOf('ArzuzReferralCard.mount') === -1) {
    throw new Error('register.html never mounts the personal card');
  }
  if (html.indexOf('Your reference:') === -1) {
    throw new Error('the personal card is not gated on a saved row');
  }
});

await t('the admin panel switches codes through the revoked field', async () => {
  const js = source('assets/admin.js');
  for (const need of ['data-fin="referral-code-off"', 'data-fin="referral-code-on"', 'revoked', 'referralCode: financeReferralCode']) {
    if (js.indexOf(need) === -1) throw new Error('admin.js does not carry ' + need);
  }
});

await t('the function publishes exactly the actions the site uses', async () => {
  for (const a of ['referral_mint', 'referral_click', 'referral_stats']) {
    if (finance.PUBLIC_ACTIONS.indexOf(a) === -1) throw new Error(a + ' is not public');
  }
  for (const a of ['referral_decide', 'referral_code']) {
    if (finance.ADMIN_ONLY.indexOf(a) === -1) throw new Error(a + ' is not admin-only');
  }
  for (const s of ['under_review', 'approved', 'payout_pending', 'paid', 'rejected', 'reversed']) {
    if (finance.REFERRAL_STATES.indexOf(s) === -1) throw new Error(s + ' left the vocabulary');
  }
  if (finance.REFERRAL_STATES.indexOf('pending_qualification') !== -1) {
    throw new Error('an operator can move a referral back to pending — a way to un-qualify money that moved');
  }
});

/* ============================================================
   9. the address and the privacy posture
   ============================================================ */

console.log('\n9. One address, no index, no secret in reach\n');

await t('netlify.toml serves /referrals and retires the .html copy', async () => {
  const toml = source('netlify.toml');
  if (!/from\s*=\s*"\/referrals"\s*\n\s*to\s*=\s*"\/my-referrals\.html"\s*\n\s*status\s*=\s*200/.test(toml)) {
    throw new Error('/referrals is not served from my-referrals.html');
  }
  if (!/from\s*=\s*"\/my-referrals\.html"\s*\n\s*to\s*=\s*"\/referrals"\s*\n\s*status\s*=\s*301\s*\n\s*force\s*=\s*true/.test(toml)) {
    throw new Error('/my-referrals.html does not 301 (forced) to /referrals');
  }
  if (!/for\s*=\s*"\/my-referrals\.html"[\s\S]*?X-Robots-Tag\s*=\s*"noindex, nofollow"/.test(toml)) {
    throw new Error('the dashboard lacks its noindex header');
  }
});

await t('the dashboard is a real page that stays out of the index', async () => {
  const html = source('my-referrals.html');
  if ((html.match(/<h1[\s>]/gi) || []).length !== 1) throw new Error('no single heading');
  if (!/<title>[^<]+<\/title>/i.test(html)) throw new Error('no title');
  if (!/name="description" content="[^"]+"/i.test(html)) throw new Error('no description');
  if (!/name="robots" content="[^"]*noindex/i.test(html)) throw new Error('no meta noindex');
  const loaded = [...html.matchAll(/<script[^>]*\ssrc="assets\/([\w.-]+)/g)].map((m) => m[1]);
  const at = loaded.indexOf('api-errors.js');
  const appAt = loaded.indexOf('app.js');
  if (appAt !== -1 && at === -1) throw new Error('it loads app.js without the classifier');
  if (appAt !== -1 && at > appAt) throw new Error('the classifier loads after its consumer');
  for (const a of ['referral_stats', 'referral_mint']) {
    if (html.indexOf(a) === -1) throw new Error('the page never asks for ' + a);
  }
  const codeOnly = html.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/HTTP/.test(codeOnly)) throw new Error('a status word survives in the page');
  if (/wa\.me\/\d+/.test(html)) throw new Error('a hardcoded chat number — the module owns that');
});

await t('a private page is never advertised', async () => {
  const sitemap = source('sitemap.xml');
  for (const p of ['/referrals', '/my-referrals', 'my-referrals.html']) {
    if (sitemap.indexOf(p) !== -1) throw new Error('the sitemap advertises ' + p);
  }
  if (/Disallow:\s*\/referrals/i.test(source('robots.txt'))) {
    throw new Error('robots disallows the page instead of noindexing it');
  }
});

await t('clicks carry no identity, by migration as well as by code', async () => {
  const sql = source('supabase/migrations/supabase-finance.sql');
  if (sql.indexOf('create table if not exists referral_clicks') === -1) {
    throw new Error('the clicks table is not in the migration');
  }
  if (!/alter table referral_clicks enable row level security/i.test(sql)) {
    throw new Error('the clicks table is not locked down');
  }
  if (/create policy[^;]*referral_clicks/is.test(sql)) {
    throw new Error('a client policy on clicks — the service role writes them, nobody else');
  }
});

/* ---------------- verdict ---------------- */

if (failures.length) {
  console.log('\nFAIL: ' + failures.length);
  failures.forEach((f) => console.log('  ✗ ' + f));
}
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
