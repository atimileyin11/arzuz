#!/usr/bin/env node
/* ============================================================
   Arzuz — the alert outbox drain

   netlify/functions/alert-drain.js sends what the waitlist door
   queued in alert_outbox, so a closed page or a Telegram blink no
   longer leaves a saved row with nobody told. Driven here as the
   quarter hour that would meet it:

     - with no service key it answers, not errors: a cron that
       errors is a retry storm nobody asked for
     - a pending row is sent once and marked sent, with the
       announcement built from the same formatter the live path uses
     - a Telegram outage keeps the row pending and counts the
       attempt; past eight it rests as failed but stays auditable
     - a spent shared ceiling leaves rows untouched for the next tick
       instead of tripping Telegram's own
     - a row this site has no formatter for still goes out as a
       generic line rather than dying in the queue

   The stand-in below is a small PostgREST plus a small Telegram.
   The waitlist door's own suite (scripts/test-waitlist.mjs) proves
   the other half — every one of its success tests runs against a
   stand-in with no alert_outbox table at all, and still answers 200
   with a reference, because the queue write must never fail the save.

   Run from arzuz-site/:
     node scripts/test-alert-outbox.mjs
   ============================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.SUPABASE_URL = 'https://stand-in.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stand-in-service-role-key';
process.env.TELEGRAM_BOT_TOKEN = 'stand-in-bot-token';
process.env.TELEGRAM_CHAT_ID = 'stand-in-chat-id';

const drain = require('../netlify/functions/alert-drain.js');
const notify = require('../netlify/functions/notify.js');
const AlertThrottle = require('../netlify/functions/lib/alert-throttle.js');

/* ---------------- the stand-in ---------------- */

function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const state = {
  pending: [],
  patches: [],
  telegramOk: true,
  throttleAllow: true,
  throttleFails: false,
  telegramCalls: 0,
};

function reset(over) {
  state.pending = [];
  state.patches = [];
  state.telegramOk = true;
  state.throttleAllow = true;
  state.throttleFails = false;
  state.telegramCalls = 0;
  Object.assign(state, over || {});
  notify.resetServerAlertBudget();
  AlertThrottle.clearMem();
}

function row(over) {
  return Object.assign({
    id: 'aaaaaaaa-1111-4222-8333-000000000001',
    table_name: 'demand_records',
    ref: 'ARZ-S-AAAA-BBBB-CCCC',
    payload: { first: 'Amaka', phone: '08031234567', age: '18-22' },
    attempts: 0,
  }, over || {});
}

global.fetch = async function (url) {
  const u = String(url);
  if (u.indexOf('/rest/v1/rpc/alert_throttle') !== -1) {
    if (state.throttleFails) return resp(500, { message: 'the stand-in is unwell' });
    return resp(200, { allow: state.throttleAllow });
  }
  if (u.indexOf('/rest/v1/alert_outbox') !== -1 && u.indexOf('id=eq.') !== -1) {
    const id = decodeURIComponent(u.split('id=eq.')[1]);
    state.patches.push(id);
    return resp(200, [{}]);
  }
  if (u.indexOf('/rest/v1/alert_outbox') !== -1) {
    return resp(200, state.pending);
  }
  if (u.indexOf('api.telegram.org/bot') !== -1) {
    state.telegramCalls += 1;
    if (!state.telegramOk) return resp(500, { ok: false });
    return resp(200, { ok: true });
  }
  return resp(404, { message: 'the stand-in does not know ' + u });
};

/* ---------------- the runner ---------------- */

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push(name + '  ::  ' + (err && err.message));
    console.log('  ✗ ' + name + '  ::  ' + (err && err.message));
  }
}

/* ============================================================
   1 · WITHOUT THE KEY IT ANSWERS, NOT ERRORS
   ============================================================ */

await t('with no service key the tick answers instead of erroring', async () => {
  reset();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const res = await drain.handler({});
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).reason, 'not-configured');
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }
  assert.equal(state.telegramCalls, 0, 'nothing was attempted with no key');
});

/* ============================================================
   2 · THE HAPPY TICK
   ============================================================ */

await t('pending rows are sent once and marked sent', async () => {
  reset({ pending: [row(), row({ id: 'bbbbbbbb-2222-4333-8444-000000000002' })] });
  const res = await drain.handler({});
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.counts, { sent: 2, kept: 0, rested: 0 });
  assert.equal(state.telegramCalls, 2);
  assert.equal(state.patches.length, 2, 'each send was marked');
});

/* ============================================================
   3 · A TELEGRAM OUTAGE KEEPS, THEN RESTS
   ============================================================ */

await t('an unanswered send stays pending and counts the attempt', async () => {
  reset({ pending: [row()], telegramOk: false });
  const counts = await drain.drain({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  assert.deepEqual(counts, { sent: 0, kept: 1, rested: 0 });
  assert.equal(state.patches.length, 1);
});

await t('past eight attempts the row rests as failed, still auditable', async () => {
  reset({ pending: [row({ attempts: 7 })], telegramOk: false });
  const counts = await drain.drain({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  assert.deepEqual(counts, { sent: 0, kept: 0, rested: 1 });
});

/* ============================================================
   4 · THE SHARED CEILING PACES THE BURST
   ============================================================ */

await t('a spent ceiling leaves rows untouched for the next tick', async () => {
  reset({ pending: [row(), row()], throttleAllow: false });
  const counts = await drain.drain({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  assert.deepEqual(counts, { sent: 0, kept: 0, rested: 0 });
  assert.equal(state.telegramCalls, 0, 'the burst never reached Telegram');
  assert.equal(state.patches.length, 0, 'nothing was marked');
});

await t('an unreachable counter sends anyway — the guard fails open', async () => {
  reset({ pending: [row()], throttleFails: true });
  const counts = await drain.drain({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  assert.deepEqual(counts, { sent: 1, kept: 0, rested: 0 });
});

/* ============================================================
   5 · NOTHING DIES IN THE QUEUE
   ============================================================ */

await t('a row with no formatter still goes out as a generic line', async () => {
  reset({ pending: [row({ table_name: 'a_table_from_next_year', payload: {} })] });
  const counts = await drain.drain({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  assert.deepEqual(counts, { sent: 1, kept: 0, rested: 0 });
  assert.equal(state.telegramCalls, 1);
});

await t('an empty outbox is a quiet tick', async () => {
  reset();
  const res = await drain.handler({});
  assert.deepEqual(JSON.parse(res.body).counts, { sent: 0, kept: 0, rested: 0 });
  assert.equal(state.telegramCalls, 0);
});

/* ------------------------------------------------------------ */

console.log('\n' + (failures.length ? '✗ ' : '') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(failures.length ? 1 : 0);
