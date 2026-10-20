#!/usr/bin/env node
/* ============================================================
   Arzuz — roommate matching engine tests

   Two things are tested here, and both run with zero dependencies:

     1. assets/roommate-score.js — the scoring rules. Deal-breakers
        are absolute, answers are compared by position not by
        string, both sides are scored, missing answers are excluded
        rather than zeroed.
     2. netlify/functions/roommate-match.js — the API, end to end,
        against an in-memory stand-in for the Supabase REST
        surface. That includes the part the whole module exists
        for: contact details appear only after BOTH students say
        accept, and never before.
     3. The consent trail and the team's alerts. The trail is
        append-only — a decision that is changed leaves TWO rows,
        even though roommate_interests upserts to one. And only two
        events may buzz a phone: a new questionnaire, and a match.

     4. netlify/functions/roommate-digest.js — the daily summary.
        Tested at chosen instants rather than by waiting for 07:00:
        what the 24-hour window counts, which matches are old enough
        to chase, and the day where nothing moved at all.

   Run from arzuz-site/:
     node scripts/test-roommate-score.mjs
   ============================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* Requiring the function also proves its shared-module path
   (`require('../assets/roommate-score.js')`) resolves under Node,
   which is how Netlify will bundle it. */
const ArzuzMatch = require('../assets/roommate-score.js');
const fn = require('../netlify/functions/roommate-match.js');
const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_URL_KEY = process.env.SUPABASE_URL_KEY;
const ORIGINAL_SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGINAL_FETCH = global.fetch;
process.env.SUPABASE_URL = 'https://stand-in.supabase.co';
delete process.env.SUPABASE_URL_KEY;

/* ---------------- tiny test runner ---------------- */

let passed = 0;
const failures = [];

async function t(name, body) {
  const pending = [];
  const check = (label) => (ok, detail) => {
    if (ok) return;
    failures.push(label + (detail ? ' — ' + detail : ''));
  };
  try {
    await body(check);
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message));
  }
  return pending;
}

const P = ArzuzMatch.PROFILE;
const W = ArzuzMatch.WANTS;

function full(over = {}) {
  return Object.assign({
    name: 'Ada',
    phone: '08031234567',
    gender: P.gender.options[0],              // Female
    sleep: P.sleep.options[1],                // 10pm – 12am
    wake: P.wake.options[1],                  // 6 – 8am
    clean: P.clean.options[1],                // Weekly
    guests: P.guests.options[0],              // Rarely
    smoke: P.smoke.options[0],                // Non-smoker
    noise: P.noise.options[0],                // Quiet
    budget: '90000',
    split: P.split.options[0],                // Equal halves
    want_gender: W.want_gender.options[0],    // Same gender as me
  }, over);
}

/* ============================================================
   1. THE SCORING ENGINE
   ============================================================ */

console.log('\nroommate-score.js — the algorithm\n');

await t('identical answers score 100% and pass', () => {
  const r = ArzuzMatch.score(full(), full());
  assert.equal(r.pct, 100);
  assert.equal(r.pass, true);
  assert.equal(r.dealbreaker, null);
  assert.equal(r.verdict, 'Excellent match');
});

await t('an ordinal answer is compared by position, not by string', () => {
  /* "Early riser" versus "Night owl" is the maximum distance, and
     the field score must land at the opposite end of the scale. */
  assert.equal(ArzuzMatch.distance('sleep', P.sleep.options[0], P.sleep.options[0]), 0);
  assert.equal(ArzuzMatch.distance('sleep', P.sleep.options[0], P.sleep.options[2]), 1);
  assert.equal(ArzuzMatch.distance('sleep', P.sleep.options[0], P.sleep.options[1]), 0.5);
  assert.equal(ArzuzMatch.fieldScore('sleep', P.sleep.options[0], P.sleep.options[2]), 0);
  assert.equal(ArzuzMatch.fieldScore('sleep', P.sleep.options[1], P.sleep.options[1]), 1);
});

await t('an unknown answer is null, never zero', () => {
  assert.equal(ArzuzMatch.distance('sleep', P.sleep.options[0], undefined), null);
  assert.equal(ArzuzMatch.distance('sleep', P.sleep.options[0], 'Whenever'), null);
  assert.equal(ArzuzMatch.fieldScore('sleep', undefined, undefined), null);
});

await t('a deal-breaker blocks the pair outright, at any percentage', () => {
  const me = full({ dealbreakers: ['Smoking'] });
  const them = full({ smoke: P.smoke.options[1] });   // smoker, outside only
  const r = ArzuzMatch.score(me, them);
  assert.equal(r.pass, false);
  assert.equal(r.dealbreaker, 'Smoking');
  assert.equal(r.pct, 0);
  /* and it is the OTHER side's deal-breaker that also blocks */
  const mirrored = ArzuzMatch.score(them, me);
  assert.equal(mirrored.dealbreaker, 'Smoking');
});

await t('the same pair without the deal-breaker still scores', () => {
  const r = ArzuzMatch.score(full(), full({ smoke: P.smoke.options[1] }));
  assert.equal(r.pass, true);
  assert.equal(r.dealbreaker, null);
  assert.ok(r.pct < 100, 'a smoker must not be a perfect match with a non-smoker');
});

await t('a pair rule can be a deal-breaker (opposite sleep schedules)', () => {
  const me = full({ sleep: P.sleep.options[0], dealbreakers: ['Very different sleep'] });
  const them = full({ sleep: P.sleep.options[2] });
  const r = ArzuzMatch.score(me, them);
  assert.equal(r.pass, false);
  assert.equal(r.dealbreaker, 'Very different sleep');

  /* one notch apart is not "very different" */
  const near = ArzuzMatch.score(me, full({ sleep: P.sleep.options[1] }));
  assert.equal(near.pass, true);
});

await t('deal-breakers can be an array, a single string, or a comma list', () => {
  assert.deepEqual(ArzuzMatch.list(['Smoking', 'Loud noise']), ['Smoking', 'Loud noise']);
  assert.deepEqual(ArzuzMatch.list('Smoking'), ['Smoking']);
  assert.deepEqual(ArzuzMatch.list('Smoking,Loud noise'), ['Smoking', 'Loud noise']);
  assert.deepEqual(ArzuzMatch.list(undefined), []);
  assert.deepEqual(ArzuzMatch.list([]), []);
});

await t('the score is symmetric — one side cannot inflate a pair', () => {
  const a = full({ sleep: P.sleep.options[0], clean: P.clean.options[2], noise: P.noise.options[0] });
  const b = full({ sleep: P.sleep.options[2], clean: P.clean.options[0], noise: P.noise.options[2] });
  assert.equal(ArzuzMatch.score(a, b).pct, ArzuzMatch.score(b, a).pct);
});

await t('a soft preference raises a category\u2019s weight', () => {
  const them = full({ clean: P.clean.options[2] });   // cleaner than me
  const indifferent = ArzuzMatch.score(full({ want_clean: 'Any' }), them);
  const caring = ArzuzMatch.score(full({ want_clean: 'Similar to mine' }), them);
  assert.ok(
    caring.pct <= indifferent.pct,
    'caring about cleanliness must not score higher than being indifferent when it differs'
  );
});

/* THE CATEGORY HAS TO COUNT, NOT JUST EXIST.

   A mutation audit set cleanliness's weight to 0 — one of the two
   heaviest categories, silently ignored — and this suite stayed green.
   The soft-preference check above only asserts an inequality that holds
   at weight 0 too, so nothing here ever isolated a single category.

   Two pairs, identical except for cleaning habits: the one that agrees
   must score strictly higher. At weight 0 they score the same, which is
   what this catches. */
await t('cleaning habits move the score — the category is not decorative', () => {
  const me = full({ clean: P.clean.options[0] });
  const agrees = ArzuzMatch.score(me, full({ clean: P.clean.options[0] }));
  const differs = ArzuzMatch.score(me, full({ clean: P.clean.options[2] }));
  assert.ok(
    agrees.pct > differs.pct,
    'agreeing about cleaning must beat disagreeing (got ' + agrees.pct + ' vs ' + differs.pct + ')'
  );
});

await t('missing answers are excluded, not counted against the pair', () => {
  const sparse = { gender: P.gender.options[0], smoke: P.smoke.options[0] };
  const r = ArzuzMatch.score(sparse, full());
  assert.equal(r.pass, false, 'too few shared answers must not be shown as a match');
  assert.ok(r.coverage < ArzuzMatch.MIN_COVERAGE);
  assert.ok(r.pct > 0, 'the categories that ARE known must still count');
});

await t('same gender by default, any gender when asked', () => {
  const me = full();                                    // Female, default preference
  const him = full({ gender: P.gender.options[1] });    // Male
  assert.equal(ArzuzMatch.score(me, him).pass, false);
  const open = ArzuzMatch.score(full({ want_gender: 'Any gender' }), him);
  assert.equal(open.pass, true);
});

await t('a blank gender never filters the pool', () => {
  assert.equal(ArzuzMatch.score(full(), full({ gender: '' })).pass, true);
});

await t('rent split rewards the same arrangement and halves a mixed one', () => {
  /* The split question was reworded from "I can pay my half / I need help
     covering my half" to equal-halves vs flexible, so the old conflict
     (two people who each need covering) no longer exists: two people who
     want the same arrangement score full, a mixed pair scores half. */
  const fine = ArzuzMatch.splitScore(full(), full());
  const bothFlex = ArzuzMatch.splitScore(
    full({ split: P.split.options[1] }), full({ split: P.split.options[1] }));
  const mixed = ArzuzMatch.splitScore(
    full({ split: P.split.options[0] }), full({ split: P.split.options[1] }));
  assert.equal(fine, 1);
  assert.equal(bothFlex, 1);
  assert.equal(mixed, 0.5);
  assert.equal(ArzuzMatch.splitScore(undefined, undefined), null);
});

await t('closer budgets score higher than far ones', () => {
  const me = full({ budget: '100000' });
  const near = ArzuzMatch.score(me, full({ budget: '110000' }));
  const far = ArzuzMatch.score(me, full({ budget: '400000' }));
  assert.ok(near.pct > far.pct, 'budget distance must move the score');
});

await t('a stated "equal split only" is a real penalty', () => {
  const me = full({ want_split: 'Equal split only' });
  const helper = full({ split: P.split.options[1] });
  const even = full();
  assert.ok(ArzuzMatch.score(me, helper).pct < ArzuzMatch.score(me, even).pct);
});

/* ============================================================
   2. THE API — against a stand-in for Supabase's REST surface
   ============================================================ */

console.log('\nroommate-match.js — the API\n');

/* An honest-enough emulation of the PostgREST calls the function
   actually makes: filters, upsert on conflict, and
   Prefer: return=representation. */
function fakeSupabase() {
  const state = {
    roommate_profiles: [],
    roommate_interests: [],
    roommate_events: [],       /* the append-only consent trail */
    telegram: [],              /* every sendMessage the function asked for */
    __failEvents: false,       /* simulate the trail table being unwritable */
    __databaseError: null,     /* simulate invalid REST configuration or a network failure */
    requests: [],              /* calls made by the stand-in client */
    /* filled in on demand by the two view builders above */
    roommate_mutual_pairs: [],
    roommate_engine_summary: [],
    /* who Supabase thinks the caller is — see the auth branch above */
    __auth: null,
  };
  let seq = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');

  function parse(search) {
    const filters = [];
    let onConflict = null;
    let limit = null;
    for (const [k, v] of new URLSearchParams(search)) {
      if (k === 'select' || k === 'order') continue;
      if (k === 'on_conflict') { onConflict = v; continue; }
      if (k === 'limit') { limit = Number(v); continue; }
      const inMatch = /^in\.\((.*)\)$/.exec(v);
      const eqMatch = /^(eq|neq)\.(.*)$/.exec(v);
      /* The digest windows on time (created_at=gte.…, matched_at=lte.…),
         so ranges have to be real here — an unhandled operator would
         silently filter nothing and a window test would pass for the
         wrong reason. */
      const rangeMatch = /^(gte|gt|lte|lt)\.(.*)$/.exec(v);
      if (inMatch) filters.push({ key: k, op: 'in', values: inMatch[1].split(',') });
      else if (eqMatch) filters.push({ key: k, op: eqMatch[1], value: eqMatch[2] });
      else if (rangeMatch) filters.push({ key: k, op: rangeMatch[1], value: rangeMatch[2] });
      else filters.push({ key: k, op: 'eq', value: v });
    }
    return { filters, onConflict, limit };
  }

  const str = (row, key) => (row[key] === undefined || row[key] === null ? '' : String(row[key]));

  /* roommate_profiles computes these with GENERATED ALWAYS AS … STORED.
     The function reads first_name (to name a person in the trail and in
     an alert) and area / budget_ngn, so a stand-in that stored only the
     payload would report 'Student' for every row and let a naming bug
     pass here that fails in production. Mirrors supabase-roommate.sql,
     budget guard included. */
  function applyGenerated(row) {
    if (!row.payload) return row;
    const p = row.payload;
    const val = (k) => (p[k] === undefined || p[k] === null ? null : String(p[k]));
    row.first_name   = val('name');
    row.phone        = val('phone');
    row.gender       = val('gender');
    row.area         = val('area');
    row.sleep        = val('sleep');
    row.wake         = val('wake');
    row.cleanliness  = val('clean');
    row.guests       = val('guests');
    row.smoking      = val('smoke');
    row.noise        = val('noise');
    row.split_ok     = val('split');
    row.dealbreakers = p.dealbreakers || [];
    row.budget_ngn   = /^[0-9]+$/.test(String(p.budget)) ? Number(p.budget) : null;
    return row;
  }

  function apply(rows, filters) {
    return rows.filter((r) => filters.every((f) => {
      if (f.op === 'in') return f.values.indexOf(str(r, f.key)) !== -1;
      if (f.op === 'neq') return str(r, f.key) !== f.value;
      /* timestamptz compares as a DATE, not as text: PostgREST answers
         "+00:00" where the tests write "…Z", and a string comparison of
         those two is simply wrong. */
      if (f.op === 'gte' || f.op === 'gt' || f.op === 'lte' || f.op === 'lt') {
        const a = Date.parse(str(r, f.key));
        const b = Date.parse(f.value);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        if (f.op === 'gte') return a >= b;
        if (f.op === 'gt') return a > b;
        if (f.op === 'lte') return a <= b;
        return a < b;
      }
      return str(r, f.key) === f.value;
    }));
  }

  /* THE TWO VIEWS the digest reads are derived here the way
     supabase-roommate.sql §6 derives them — there is nothing to seed.
     roommate_mutual_pairs keeps ONE row per pair (a.from_ref < a.to_ref)
     and carries the pair's env; roommate_engine_summary is the line's
     one number. A stand-in that could not answer these would leave the
     whole digest untested. */
  function mutualPairs() {
    const accepts = state.roommate_interests.filter((i) => i.decision === 'accept');
    const find = (f, t) => accepts.filter((i) => i.from_ref === f && i.to_ref === t)[0];
    const byId = {};
    state.roommate_profiles.forEach((p) => { byId[p.id] = p; });
    const seen = {};
    const out = [];
    accepts.forEach((a) => {
      const back = find(a.to_ref, a.from_ref);
      if (!back) return;
      const lo = a.from_ref < a.to_ref ? a.from_ref : a.to_ref;
      const hi = a.from_ref < a.to_ref ? a.to_ref : a.from_ref;
      if (seen[lo + hi]) return;
      seen[lo + hi] = 1;
      const A = byId[lo], B = byId[hi];
      if (!A || !B) return;
      out.push({
        matched_at: new Date(Math.max(Date.parse(a.created_at), Date.parse(back.created_at))).toISOString(),
        a_id: lo, a_name: A.first_name, b_id: hi, b_name: B.first_name,
        env: A.env || 'production',
      });
    });
    return out;
  }

  function engineSummary() {
    const prof = state.roommate_profiles.filter((p) => (p.env || 'production') === 'production');
    const pairs = mutualPairs();
    return [{
      profiles_total: prof.length,
      profiles_open: prof.filter((p) => p.status === 'open').length,
      profiles_matched: prof.filter((p) => p.status === 'matched').length,
      mutual_pairs: pairs.length,
    }];
  }

  global.fetch = async (url, options = {}) => {
    const u = new URL(url);
    state.requests.push(String(url));

    if (state.__databaseError && u.hostname !== 'api.telegram.org') throw state.__databaseError;

    /* The alert path. It is captured rather than sent, and answered
       like Telegram would — so a test can assert on how many alerts a
       given action produced, which is the only way to prove the
       "don't buzz the team for a one-sided yes" rule. */
    if (u.hostname === 'api.telegram.org') {
      state.telegram.push(JSON.parse(options.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
    }

    /* The digest preview's two auth calls (roommate-digest-preview.js
       mirrors strategy-docs.js for the session, then asks Postgres for
       the role). What Supabase says about a token is a SCENARIO here,
       not a fact: state.__auth makes the caller a live admin, a live
       marketing login, or a dead session, which is exactly the set the
       function has to tell apart. */
    /* Both auth answers carry json() as well as text(), because these two
       are the calls that read the body with .json() — a stand-in that
       only spoke text() would make every live session look dead, which
       is a failure mode worth NOT having: it would pass the 401 tests
       for the wrong reason. */
    if (u.pathname.indexOf('/auth/v1/user') !== -1) {
      if (!state.__auth || !state.__auth.user) {
        return {
          ok: false, status: 401,
          json: async () => ({ message: 'invalid JWT' }),
          text: async () => JSON.stringify({ message: 'invalid JWT' }),
        };
      }
      const user = { id: state.__auth.user, email: 'owner@arzuz.test' };
      return {
        ok: true, status: 200,
        json: async () => user,
        text: async () => JSON.stringify(user),
      };
    }
    if (u.pathname.indexOf('/rpc/arzuz_role') !== -1) {
      if (!state.__auth || !state.__auth.role) {
        return {
          ok: false, status: 401,
          json: async () => ({ message: 'no role' }),
          text: async () => JSON.stringify({ message: 'no role' }),
        };
      }
      return {
        ok: true, status: 200,
        json: async () => state.__auth.role,
        text: async () => JSON.stringify(state.__auth.role),
      };
    }

    const table = u.pathname.split('/').pop();
    if (table === 'roommate_mutual_pairs') state.roommate_mutual_pairs = mutualPairs();
    if (table === 'roommate_engine_summary') state.roommate_engine_summary = engineSummary();
    const rows = state[table];
    if (!rows) throw new Error('fake supabase: unknown table ' + table);

    if (table === 'roommate_events' && state.__failEvents) {
      return {
        ok: false, status: 500,
        text: async () => JSON.stringify({ message: 'MOCK consent trail is unwritable' }),
      };
    }

    const method = (options.method || 'GET').toUpperCase();
    const { filters, onConflict, limit } = parse(u.search);
    const prefer = String((options.headers && options.headers.Prefer) || '');
    const body = options.body ? JSON.parse(options.body) : null;
    let result = [];

    if (method === 'GET') {
      result = apply(rows, filters);
      if (limit) result = result.slice(0, limit);
    } else if (method === 'POST') {
      for (const item of (Array.isArray(body) ? body : [body])) {
        let existing = null;
        if (onConflict) {
          const keys = onConflict.split(',');
          existing = rows.find((r) => keys.every((k) => r[k] === item[k]));
        }
        if (existing) applyGenerated(Object.assign(existing, item));
        else {
          const row = applyGenerated(
            Object.assign({ id: uuid(), created_at: new Date().toISOString() }, item));
          rows.push(row);
          result.push(row);
        }
      }
      if (!prefer.includes('return=representation')) result = [];
    } else if (method === 'PATCH') {
      const hits = apply(rows, filters);
      hits.forEach((r) => applyGenerated(Object.assign(r, body)));
      result = prefer.includes('return=representation') ? hits : [];
    }

    return {
      ok: true,
      status: method === 'POST' ? 201 : 200,
      text: async () => JSON.stringify(result),
    };
  };

  return state;
}

/* create is rate-limited per IP, so every profile gets its own. */
let ipSeq = 0;
const nextIp = () => '10.0.0.' + (++ipSeq);

const state = fakeSupabase();
const call = async (body, ip) => {
  const res = await fn.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': ip || nextIp() },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

await t('without the service key the function says so instead of failing', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await call({ action: 'create', payload: full() });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /SUPABASE_SERVICE_ROLE_KEY/);
});

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

await t('validation rejects an answer the scorer does not understand', () => {
  const { bad } = fn.sanitizeProfile(full({ sleep: 'Whenever I feel like it' }));
  assert.ok(bad.indexOf('sleep') !== -1, 'an unknown option must be reported, not stored');
});

await t('validation normalises a Nigerian phone number and rejects a bad one', () => {
  assert.equal(fn.normalizePhone('08031234567'), '2348031234567');
  assert.equal(fn.normalizePhone('+234 803 123 4567'), '2348031234567');
  assert.equal(fn.normalizePhone('12345'), null);
  const { bad } = fn.sanitizeProfile(full({ phone: 'nope' }));
  assert.ok(bad.indexOf('phone') !== -1);
});

await t('validation refuses a half-finished questionnaire', () => {
  const { profile } = fn.sanitizeProfile({ name: 'Ada', phone: '08031234567', gender: P.gender.options[0] });
  assert.ok(fn.missingAnswers(profile).length > 0);
});

let adaToken;
let bolaToken;
let chiomaToken;
let bolaId;

await t('create returns a private token, and stores only its hash', async () => {
  const r = await call({ action: 'create', payload: full({ name: 'Ada', phone: '08031234567' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.token && r.body.token.length >= 30, 'a real token must come back');
  adaToken = r.body.token;

  const stored = state.roommate_profiles[0];
  assert.equal(stored.token_hash, fn.hashToken(adaToken));
  assert.ok(!JSON.stringify(stored).includes(adaToken), 'the raw token must never be stored');
  assert.ok(!JSON.stringify(stored).includes('token":'), 'no raw token field');
});

await t('a malformed or unknown private link is refused, not guessed', async () => {
  assert.equal((await call({ action: 'matches', token: 'x' })).status, 404);
  assert.equal((await call({ action: 'matches', token: 'a'.repeat(40) })).status, 404);
});

await t('an incomplete profile is refused with the missing fields named', async () => {
  const r = await call({ action: 'create', payload: { name: 'Ada', phone: '08031234567', gender: P.gender.options[0] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /incomplete/i);
});

await t('the first student on the platform simply sees nobody yet', async () => {
  const r = await call({ action: 'matches', token: adaToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.matches.length, 0);
  assert.equal(r.body.me.name, 'Ada');
});

await t('a compatible second student appears, scored, with no contact yet', async () => {
  const created = await call({ action: 'create', payload: full({ name: 'Bola', phone: '08039876543' }) });
  bolaToken = created.body.token;
  bolaId = created.body.id;

  const r = await call({ action: 'matches', token: adaToken });
  assert.equal(r.body.matches.length, 1);
  const card = r.body.matches[0];
  assert.equal(card.name, 'Bola');
  assert.equal(card.pct, 100);
  assert.equal(card.unlocked, false);
  assert.equal(card.contact, null);
  assert.ok(Array.isArray(card.reasons));
  /* the one thing that must never leak before both sides agree */
  assert.ok(!JSON.stringify(card).includes('08039876543'), 'phone leaked before opt-in');
  assert.ok(!JSON.stringify(card).includes('2348039876543'), 'normalised phone leaked before opt-in');
  /* and a candidate's private preferences must not be echoed back */
  assert.ok(!JSON.stringify(card).includes('want_'), 'private preference keys leaked');
});

await t('one acceptance unlocks nothing on its own', async () => {
  const r = await call({ action: 'decide', token: bolaToken, target: state.roommate_profiles[0].id, decision: 'accept' });
  assert.equal(r.status, 200);
  assert.equal(r.body.unlocked, false);
  assert.equal(r.body.contact, null);

  /* Ada can see Bola is interested, but still gets no phone number */
  const ada = await call({ action: 'matches', token: adaToken });
  const card = ada.body.matches[0];
  assert.equal(card.their_decision, 'accept');
  assert.equal(card.unlocked, false);
  assert.equal(card.contact, null);
});

await t('the second acceptance unlocks contact for both, and normalises the number', async () => {
  const r = await call({ action: 'decide', token: adaToken, target: bolaId, decision: 'accept' });
  assert.equal(r.body.unlocked, true);
  assert.equal(r.body.contact.name, 'Bola');
  assert.equal(r.body.contact.phone, '2348039876543');

  /* Bola's card for Ada must carry ADA's number — each side is
     given the other person's details, never their own. */
  const back = await call({ action: 'matches', token: bolaToken });
  const adaCard = back.body.matches.find((c) => c.name === 'Ada');
  assert.ok(adaCard, 'the other side must see the match too');
  assert.equal(adaCard.unlocked, true);
  assert.equal(adaCard.contact.phone, '2348031234567');
});

await t('a live match survives a reload even though it left the open pool', async () => {
  /* both profiles are now 'matched', so neither is in the pool */
  assert.equal(state.roommate_profiles[0].status, 'matched');
  assert.equal(state.roommate_profiles[1].status, 'matched');

  const r = await call({ action: 'matches', token: adaToken });
  assert.equal(r.body.matches.length, 1, 'the unlocked match must still be listed');
  assert.equal(r.body.matches[0].unlocked, true);
  assert.equal(r.body.matches[0].contact.phone, '2348039876543');
});

await t('a repeat decision upserts instead of duplicating rows', async () => {
  const before = state.roommate_interests.length;
  await call({ action: 'decide', token: adaToken, target: bolaId, decision: 'accept' });
  assert.equal(state.roommate_interests.length, before, 'a second tap created another row');
});

await t('a decision about a profile that no longer exists is refused', async () => {
  const r = await call({ action: 'decide', token: adaToken, target: '11111111-1111-4111-8111-111111111111', decision: 'accept' });
  assert.equal(r.status, 404);
});

await t('a bad decision value is refused', async () => {
  const r = await call({ action: 'decide', token: adaToken, target: bolaId, decision: 'maybe' });
  assert.equal(r.status, 400);
});

await t('someone who has already passed on you is left out of your matches', async () => {
  const created = await call({ action: 'create', payload: full({ name: 'Dayo', phone: '08055555555' }) });
  const dayoToken = created.body.token;
  /* Dayo passes on Ada */
  await call({ action: 'decide', token: dayoToken, target: state.roommate_profiles[0].id, decision: 'pass' });

  const r = await call({ action: 'matches', token: adaToken });
  assert.equal(r.body.matches.filter((c) => c.name === 'Dayo').length, 0);
});

await t('a deal-breaker keeps a candidate off the list end to end', async () => {
  const smoker = await call({ action: 'create', payload: full({ name: 'Eze', phone: '08051111111', smoke: P.smoke.options[2] }) });
  assert.equal(smoker.status, 200);

  const picky = await call({
    action: 'create',
    payload: full({ name: 'Femi', phone: '08052222222', dealbreakers: ['Smoking'] }),
  });
  assert.equal(picky.status, 200);

  const r = await call({ action: 'matches', token: picky.body.token });
  assert.equal(r.body.matches.filter((c) => c.name === 'Eze').length, 0, 'a smoker must not be shown');
  assert.ok(r.body.matches.length >= 1, 'a deal-breaker must not empty the whole pool');
});

await t('withdrawing removes a profile from everyone else\u2019s matches', async () => {
  const grace = await call({ action: 'create', payload: full({ name: 'Grace', phone: '08054444444' }) });
  const chioma = await call({ action: 'create', payload: full({ name: 'Chioma', phone: '08053333333' }) });
  chiomaToken = chioma.body.token;

  const open = await call({ action: 'matches', token: grace.body.token });
  assert.ok(
    open.body.matches.some((c) => c.name === 'Chioma'),
    'an open profile must be visible while it is in the pool'
  );

  const w = await call({ action: 'withdraw', token: chiomaToken });
  assert.equal(w.body.ok, true);
  assert.equal(state.roommate_profiles.find((p) => p.payload.name === 'Chioma').status, 'closed');

  const after = await call({ action: 'matches', token: grace.body.token });
  assert.equal(after.body.matches.filter((c) => c.name === 'Chioma').length, 0);
});

await t('the pool is scoped — a test-mode profile never meets a production one', async () => {
  const testProfile = await call({
    action: 'create',
    payload: full({ name: 'Testa', phone: '08056666666' }),
    env: 'test',
  });
  const r = await call({ action: 'matches', token: testProfile.body.token });
  assert.equal(r.body.matches.length, 0, 'a test profile must not be matched with real students');
});

await t('creating profiles in a loop is rate-limited', async () => {
  const ip = '10.9.9.9';
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const r = await call({ action: 'create', payload: full({ name: 'Flood' + i, phone: '0805777777' + i }) }, ip);
    codes.push(r.status);
  }
  assert.equal(codes.filter((c) => c === 429).length, 1, 'the fourth create from one IP must be refused');
});

await t('an unknown action is rejected', async () => {
  assert.equal((await call({ action: 'delete_everything' })).status, 400);
  assert.equal((await call({})).status, 400);
});

await t('a GET is rejected', async () => {
  const res = await fn.handler({ httpMethod: 'GET', headers: {}, body: '' });
  assert.equal(res.statusCode, 405);
});

/* ============================================================
   3. THE CONSENT TRAIL

   roommate_interests holds the LATEST decision per pair. The trail
   holds EVERY decision. The two must disagree on the same data, and
   the test that matters is the one below that makes them disagree on
   purpose.
   ============================================================ */

console.log('\nroommate-match.js — the consent trail\n');

await t('creating a profile appends a "created" event, naming the student', async () => {
  const r = await call({ action: 'create', payload: full({ name: 'Nkem', phone: '08060000001' }) });
  assert.equal(r.status, 200);
  const rows = state.roommate_events.filter((e) => e.actor_ref === r.body.id);
  assert.equal(rows.length, 1, 'one create must leave exactly one trail row');
  assert.equal(rows[0].event, 'created');
  assert.equal(rows[0].actor_name, 'Nkem', 'the name is snapshotted, not joined');
  assert.equal(rows[0].subject_ref, r.body.id);
  assert.equal(rows[0].env, 'production', 'the trail is scoped like the profile');
});

await t('the trail keeps EVERY decision while roommate_interests upserts to the latest', async () => {
  const a = await call({ action: 'create', payload: full({ name: 'Obi', phone: '08060000002' }) });
  const b = await call({ action: 'create', payload: full({ name: 'Peter', phone: '08060000003' }) });
  const pairA = a.body.id, pairB = b.body.id;

  /* Obi says yes, then changes his mind and passes. */
  await call({ action: 'decide', token: a.body.token, target: pairB, decision: 'accept' });
  await call({ action: 'decide', token: a.body.token, target: pairB, decision: 'pass' });

  const interests = state.roommate_interests.filter((i) => i.from_ref === pairA && i.to_ref === pairB);
  const events = state.roommate_events.filter((e) => e.actor_ref === pairA && e.subject_ref === pairB);

  assert.equal(interests.length, 1, 'the interest table still upserts — current state, one row');
  assert.equal(interests[0].decision, 'pass');
  assert.equal(events.length, 2, 'the trail must keep BOTH decisions — this is the whole point of it');
  assert.deepEqual(events.map((e) => e.event), ['accept', 'pass']);
  assert.equal(events[0].actor_name, 'Obi');
  assert.equal(events[0].subject_name, 'Peter');
});

await t('a pass is trailed but never alerts', async () => {
  const a = await call({ action: 'create', payload: full({ name: 'Halima', phone: '08060000004' }) });
  const b = await call({ action: 'create', payload: full({ name: 'Ifeoma', phone: '08060000005' }) });
  const before = state.telegram.length;
  await call({ action: 'decide', token: a.body.token, target: b.body.id, decision: 'pass' });
  assert.equal(state.telegram.length, before, 'a pass is not news');
});

await t('a withdrawal is trailed and does not erase anything', async () => {
  const r = await call({ action: 'create', payload: full({ name: 'Kemi', phone: '08060000006' }) });
  const w = await call({ action: 'withdraw', token: r.body.token });
  assert.equal(w.body.ok, true);
  const rows = state.roommate_events.filter((e) => e.actor_ref === r.body.id);
  assert.deepEqual(rows.map((e) => e.event), ['created', 'withdrawn']);
  /* the profile row is still there — closing is not erasing */
  assert.ok(state.roommate_profiles.some((p) => p.id === r.body.id));
});

await t('the trail is unfiltered by env, unlike the pool the panel reads', async () => {
  const r = await call({ action: 'create', payload: full({ name: 'QA Pool', phone: '08060000007' }), env: 'test' });
  assert.equal(r.status, 200);
  const rows = state.roommate_events.filter((e) => e.actor_ref === r.body.id);
  assert.equal(rows.length, 1, 'an audit log that skips some requests answers no dispute');
  assert.equal(rows[0].env, 'test', 'and it says which environment it happened in');
});

await t('a trail write that fails does not fail the action, and is not silent', async () => {
  const a = await call({ action: 'create', payload: full({ name: 'Yemi', phone: '08060000008' }) });
  const b = await call({ action: 'create', payload: full({ name: 'Zainab', phone: '08060000009' }) });
  const createdRows = state.roommate_events.filter((e) => e.actor_ref === a.body.id).length;

  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  state.__failEvents = true;
  let r;
  try {
    r = await call({ action: 'decide', token: a.body.token, target: b.body.id, decision: 'accept' });
  } finally {
    state.__failEvents = false;
    console.error = realError;
  }

  assert.equal(r.status, 200, 'the decision itself must stand — a retry would be worse than the error');
  const interests = state.roommate_interests.filter((i) => i.from_ref === a.body.id && i.to_ref === b.body.id);
  assert.equal(interests.length, 1, 'the decision is still recorded');
  assert.equal(state.roommate_events.filter((e) => e.actor_ref === a.body.id).length, createdRows,
    'the failed write left no row');
  assert.ok(logged.some((l) => /consent trail write failed/.test(l)),
    'a lost trail row must be logged — silence would be the real bug');
});

/* ============================================================
   4. THE ALERTS

   No token is set anywhere above, which is itself the first check:
   an unconfigured Telegram must look like a quiet site, not a broken
   one. Then the token goes on and the rules are asserted on counts —
   because "the team is not spammed" is a measurable claim.
   ============================================================ */

console.log('\nroommate-match.js — the alerts\n');

await t('with no Telegram token nothing is sent, and the student is not told about it', async () => {
  assert.equal(state.telegram.length, 0, 'a send was attempted without a token');
  const r = await call({ action: 'create', payload: full({ name: 'NoTelegram', phone: '08060000010' }) });
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'the private link must still come back');
  assert.equal(state.telegram.length, 0);
});

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.TELEGRAM_CHAT_ID = '999001';

await t('a new questionnaire raises exactly one alert, through the notify.js token', async () => {
  const before = state.telegram.length;
  const r = await call({ action: 'create', payload: full({ name: 'Rukayat', phone: '08060000011' }) });
  assert.equal(r.status, 200);
  const sent = state.telegram.slice(before);
  assert.equal(sent.length, 1, 'one questionnaire, one alert');
  assert.equal(sent[0].chat_id, '999001', 'the credential comes from notify.js, not a copy');
  assert.equal(sent[0].parse_mode, 'HTML');
  assert.match(sent[0].text, /New roommate questionnaire/);
  assert.match(sent[0].text, /Rukayat/);
});

await t('a student-typed name cannot break out of the alert\u2019s HTML', async () => {
  const before = state.telegram.length;
  await call({ action: 'create', payload: full({ name: '<b>Hack</b>', phone: '08060000012' }) });
  const sent = state.telegram.slice(before);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.indexOf('&lt;b&gt;Hack&lt;/b&gt;') !== -1,
    'the typed name must arrive escaped');
  assert.equal(sent[0].text.indexOf('<b>Hack</b>'), -1,
    'an unescaped name would let a student forge message formatting');
});

let sadeToken, tundeToken, sadeId, tundeId;

await t('a one-sided acceptance is trailed but alerts nobody', async () => {
  const sade = await call({ action: 'create', payload: full({ name: 'Sade', phone: '08060000013' }) });
  const tunde = await call({ action: 'create', payload: full({ name: 'Tunde', phone: '08060000014' }) });
  sadeToken = sade.body.token; sadeId = sade.body.id;
  tundeToken = tunde.body.token; tundeId = tunde.body.id;

  const before = state.telegram.length;
  const r = await call({ action: 'decide', token: sadeToken, target: tundeId, decision: 'accept' });
  assert.equal(r.body.unlocked, false);
  assert.equal(state.telegram.length, before, 'a yes nobody has answered is not news');

  const events = state.roommate_events.filter((e) => e.actor_ref === sadeId && e.subject_ref === tundeId);
  assert.equal(events.length, 1, 'but it is in the trail');
  assert.equal(events[0].event, 'accept');
});

await t('the completing acceptance records a "matched" event and alerts both names once', async () => {
  const before = state.telegram.length;
  const r = await call({ action: 'decide', token: tundeToken, target: sadeId, decision: 'accept' });
  assert.equal(r.body.unlocked, true);

  /* Two trail rows for Tunde here — his accept, then the match itself.
     They are different facts: one is what he decided, the other is
     what unlocked the contact details. */
  const mine = state.roommate_events.filter((e) => e.actor_ref === tundeId && e.subject_ref === sadeId);
  assert.deepEqual(mine.map((e) => e.event), ['accept', 'matched']);
  assert.equal(mine[1].actor_name, 'Tunde');
  assert.equal(mine[1].subject_name, 'Sade');

  const sent = state.telegram.slice(before);
  assert.equal(sent.length, 1, 'one match, one alert');
  assert.match(sent[0].text, /both said yes/);
  assert.match(sent[0].text, /Sade/);
  assert.match(sent[0].text, /Tunde/);
});

await t('a repeated acceptance after a match does not alert again', async () => {
  const before = state.telegram.length;
  await call({ action: 'decide', token: tundeToken, target: sadeId, decision: 'accept' });
  assert.equal(state.telegram.length, before, 'a second tap on an unlocked pair is not a second event');
});

await t('opening the matches page records that the pair was shown — exactly once', async () => {
  /* The follow-through signal. Sade and Tunde matched above, so Sade
     loading her matches is the first moment either of them has seen the
     other's number. */
  const before = state.roommate_events.length;
  const first = await call({ action: 'matches', token: sadeToken });
  assert.equal(first.status, 200);
  assert.ok(first.body.matches.filter((m) => m.unlocked).length,
    'a matched pair must still come back unlocked');

  const viewed = state.roommate_events.filter((e) => e.event === 'viewed' && e.actor_ref === sadeId);
  assert.equal(viewed.length, 1, 'one visit writes one viewed row');
  assert.equal(viewed[0].subject_ref, tundeId);
  assert.equal(viewed[0].actor_name, 'Sade', 'the trail snapshots the name as stored');
  assert.equal(viewed[0].subject_name, 'Tunde');

  /* A reload is not a second event. Without this the trail fills with
     "Grace opened her matches" and the question the digest actually asks
     — has this pair been looked at YET — becomes unanswerable. */
  await call({ action: 'matches', token: sadeToken });
  assert.equal(state.roommate_events.length, before + 1, 'a second visit must write nothing');
});

await t('a test-env profile is trailed but never alerts the real team', async () => {
  const before = state.telegram.length;
  const r = await call({ action: 'create', payload: full({ name: 'QA Only', phone: '08060000015' }), env: 'test' });
  assert.equal(r.status, 200);
  assert.equal(state.telegram.length, before, 'a test profile is not in the pool the team can see');
  assert.equal(state.roommate_events.filter((e) => e.actor_ref === r.body.id).length, 1);
});

await t('a flood of questionnaires cannot flood the channel — but the trail still records every one', async () => {
  /* `create` is reachable from the public internet, so this path needs the
     same ceiling the /api/notify action has. Each create gets its own IP
     so the create rate limit is not what is being measured here. */
  const FLOOD = 40;
  const sendsBefore = state.telegram.length;
  const trailBefore = state.roommate_events.length;

  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    for (let i = 0; i < FLOOD; i++) {
      const r = await call({ action: 'create', payload: full({ name: 'Flood ' + i, phone: '0807000' + String(i).padStart(4, '0') }) });
      assert.equal(r.status, 200, 'create ' + i + ' was refused: ' + JSON.stringify(r.body));
    }
  } finally {
    console.error = realError;
  }

  const sent = state.telegram.length - sendsBefore;
  assert.ok(sent >= 1, 'the first alerts must go out');
  /* The contract is a number, not merely "a cap exists": notify.js allows
     MAX_SERVER_ALERTS_PER_WINDOW per minute, the same spirit as the 30/min
     the browser action already had. */
  assert.ok(sent <= 30, 'the channel must be capped at 30 a minute — ' + sent + ' of ' + FLOOD + ' were sent');

  /* every dropped alert is logged exactly once, so a silent loss is not
     a possibility */
  const dropped = logged.filter((l) => /server alert dropped/.test(l)).length;
  assert.equal(FLOOD - sent, dropped, 'drops must be logged, one line each');

  /* and the audit log is NOT subject to that cap: the alert is lossy by
     design, the record of what happened is not */
  assert.equal(state.roommate_events.length - trailBefore, FLOOD,
    'every questionnaire must be trailed even when its alert is dropped');
});

/* ============================================================
   5. THE DAILY DIGEST

   A scheduled function cannot be poked with curl, so it is driven here
   at chosen instants: collect(now) reads the trail, the pairs and the
   summary, digestText() is what the team would read, and the handler is
   the one thing that sends.

   It is loaded as a COLD INSTANCE. The flood test above has just used up
   notify.js's per-instance alert ceiling — 30 a minute — and a 07:00
   cron does not inherit that. Dropping the module from the cache is how
   a cold instance is reproduced; without it every send below would be
   dropped by a ceiling that would not exist tomorrow morning.
   ============================================================ */

console.log('\nroommate-digest.js — the daily summary\n');

delete require.cache[require.resolve('../netlify/functions/notify.js')];
delete require.cache[require.resolve('../netlify/functions/roommate-digest.js')];
delete require.cache[require.resolve('../netlify/functions/lib/alert-throttle.js')];
try { require('../netlify/functions/lib/alert-throttle.js').clearMem(); } catch (e) {}
const digest = require('../netlify/functions/roommate-digest.js');

const HOUR = 36e5;
const DAY = 24 * HOUR;
const T = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/* History the API has no reason to produce — pairs that unlocked days
   ago — written straight into the stand-in. The digest reads three
   things, so fabricating those is clearer than driving weeks of calls. */
let seedSeq = 0;
function seedProfile(name, createdAt, env) {
  const row = {
    id: '00000000-0000-4000-9000-' + String(++seedSeq).padStart(12, '0'),
    created_at: iso(createdAt),
    payload: full({ name, phone: '080999' + String(seedSeq).padStart(5, '0') }),
    env: env || 'production',
    status: 'matched',
    /* mirrors roommate_profiles.first_name, which is GENERATED ALWAYS
       AS (payload->>'name') STORED — the pairs view reads it */
    first_name: name,
  };
  state.roommate_profiles.push(row);
  return row;
}
function seedAccept(from, to, when) {
  state.roommate_interests.push({
    id: 'seed-interest-' + (++seedSeq),
    created_at: iso(when),
    from_ref: from.id, to_ref: to.id, decision: 'accept',
  });
}
function seedEvent(event, actor, subject, when, env) {
  state.roommate_events.push({
    id: state.roommate_events.length + 1,
    created_at: iso(when),
    event,
    actor_ref: actor ? actor.id : null,
    actor_name: actor ? actor.first_name : null,
    subject_ref: subject ? subject.id : null,
    subject_name: subject ? subject.first_name : null,
    env: env || 'production',
    session: null,
  });
}

await t('the digest reports the last 24 hours of the trail, and the pool', async () => {
  const model = await digest.collect(new Date());
  assert.ok(model.counts.matched >= 1, 'the run matched at least one pair');
  assert.ok(model.counts.created >= 1, 'the run created profiles');
  const text = digest.digestText(model);
  assert.match(text, /Roommate digest/);
  assert.match(text, /last 24 hours/);
  assert.match(text, /Matches:/);
  assert.match(text, /Pool:/);
});

await t('the scheduled run sends exactly one message, through notify.js', async () => {
  const before = state.telegram.length;
  const res = await digest.handler();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).outcome, 'sent');
  const sent = state.telegram.slice(before);
  assert.equal(sent.length, 1, 'a digest is ONE message, not one per event');
  assert.equal(sent[0].chat_id, '999001', 'the credential comes from notify.js, not a copy');
  assert.match(sent[0].text, /Roommate digest/);
});

await t('a day where nothing moved is silent — no \u201cno news\u201d message', async () => {
  /* 40 hours on: the 24-hour window holds nothing, and every pair in the
     dataset unlocked minutes ago — too young to be called stale. */
  const future = await digest.collect(new Date(T + 40 * HOUR));
  assert.equal(future.counts.created + future.counts.accept + future.counts.matched, 0,
    'the window must be empty at that instant');
  assert.equal(future.quiet.length, 0, 'a fresh match is not a stalled one');
  assert.equal(digest.worthSending(future), false,
    'a quiet day must not send — a daily "no news" is how a channel gets ignored');
});

/* --- the follow-through watch: three pairs, three verdicts --- */

const staleA = seedProfile('Ifeoma', T - 8 * DAY);
const staleB = seedProfile('Kunle', T - 8 * DAY);
seedAccept(staleA, staleB, T - 5 * DAY);
seedAccept(staleB, staleA, T - 5 * DAY);

const liveA = seedProfile('Ngozi', T - 7 * DAY);
const liveB = seedProfile('Uche', T - 7 * DAY);
seedAccept(liveA, liveB, T - 4 * DAY);
seedAccept(liveB, liveA, T - 4 * DAY);
seedEvent('viewed', liveA, liveB, T - 2 * DAY);
seedEvent('viewed', liveB, liveA, T - 2 * DAY);

const halfA = seedProfile('Praise', T - 7 * DAY);
const halfB = seedProfile('Yemi', T - 7 * DAY);
seedAccept(halfA, halfB, T - 4 * DAY);
seedAccept(halfB, halfA, T - 4 * DAY);
seedEvent('viewed', halfA, halfB, T - 2 * DAY);

await t('a match nobody has opened is named, with how long it has been', async () => {
  const model = await digest.collect(new Date(T));
  const named = model.quiet.map((p) => p.a_name + '|' + p.b_name);
  assert.ok(named.indexOf('Ifeoma|Kunle') !== -1,
    'the unopened pair must be reported — saw: ' + named.join(', '));
  const text = digest.digestText(model);
  assert.match(text, /Ifeoma/);
  assert.match(text, /neither side has been back/);
  assert.match(text, /5 days/);
});

await t('a pair BOTH sides have opened is not chased', async () => {
  const model = await digest.collect(new Date(T));
  assert.equal(model.quiet.filter((p) => p.a_name === 'Ngozi').length, 0,
    'a live match was reported as stalled');
  assert.equal(model.half_quiet.filter((p) => p.a_name === 'Ngozi').length, 0,
    'both sides looked; neither is a footnote');
});

await t('a pair only ONE side has opened is a footnote, not a chase', async () => {
  const model = await digest.collect(new Date(T));
  assert.equal(model.quiet.filter((p) => p.a_name === 'Praise').length, 0,
    'one side looking is not "neither side has been back"');
  assert.equal(model.half_quiet.filter((p) => p.a_name === 'Praise').length, 1);
  assert.match(digest.digestText(model), /only ONE side looking/);
});

await t('a pair younger than the follow-up threshold is left alone', async () => {
  const model = await digest.collect(new Date(T));
  const named = model.quiet.concat(model.half_quiet).map((p) => p.a_name + '|' + p.b_name);
  /* Sade and Tunde matched during this run — minutes ago, not days. */
  assert.equal(named.indexOf('Sade|Tunde'), -1, 'a brand-new match must not be chased');
});

await t('opening a match is read, never counted as progress', async () => {
  const model = await digest.collect(new Date());
  assert.equal(model.counts.viewed, undefined, 'a page view is not activity to report');
  assert.ok(model.opened >= 1, 'but it is still summarised — the viewed rows in the window');
});

await t('the window is the last 24 hours, not \u201ceverything since the last digest\u201d', async () => {
  const before = (await digest.collect(new Date())).counts.created;
  const old = seedProfile('Old News', T - 30 * HOUR);
  seedEvent('created', old, old, T - 30 * HOUR);
  const after = await digest.collect(new Date());
  assert.equal(after.counts.created, before,
    'a 30-hour-old questionnaire belongs to yesterday, and yesterday is not reported twice');
});

await t('a student-typed name cannot forge the digest formatting', async () => {
  const bad = seedProfile('<b>Fake</b>', T - 9 * DAY);
  const other = seedProfile('Chidi', T - 9 * DAY);
  seedAccept(bad, other, T - 6 * DAY);
  seedAccept(other, bad, T - 6 * DAY);
  const text = digest.digestText(await digest.collect(new Date(T)));
  assert.ok(text.indexOf('&lt;b&gt;Fake&lt;/b&gt;') !== -1,
    'the typed name must arrive escaped');
  assert.equal(text.indexOf('<b>Fake</b>'), -1,
    'an unescaped name would let a student forge the message');
});

await t('a PostgreSQL connection string is rejected before fetch and never leaks its credentials', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousUrlKey = process.env.SUPABASE_URL_KEY;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = 'postgresql://private-user:TOPSECRET@db.example.supabase.co:5432/postgres';
  process.env.SUPABASE_URL = url;
  delete process.env.SUPABASE_URL_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stand-in-service-role-key';
  state.__databaseError = null;
  const databaseRequestsBefore = state.requests.filter((request) => !request.includes('api.telegram.org')).length;
  const before = state.telegram.length;
  let log = '';
  const oldError = console.error;
  console.error = (...args) => { log += args.join(' ') + '\n'; };
  try {
    const res = await digest.handler();
    assert.equal(JSON.parse(res.body).outcome, 'invalid-config');
    assert.equal(state.telegram.length, before + 1, 'the bad deploy needs one actionable alert');
    const alert = state.telegram[before].text;
    assert.match(alert, /Correct SUPABASE_URL.*HTTPS origin.*PostgreSQL/s);
    assert.ok(!alert.includes('TOPSECRET') && !alert.includes(url), 'database credentials leaked to Telegram');
    assert.ok(!log.includes('TOPSECRET') && !log.includes(url), 'database credentials leaked to logs');
    assert.match(log, /SUPABASE_URL.*HTTPS origin.*PostgreSQL/);
    const repeat = await digest.handler();
    assert.equal(JSON.parse(repeat.body).outcome, 'invalid-config');
    assert.equal(state.telegram.length, before + 1, 'identical invalid configuration paged repeatedly');
    const databaseRequestsAfter = state.requests.filter((request) => !request.includes('api.telegram.org')).length;
    assert.equal(databaseRequestsAfter, databaseRequestsBefore,
      'invalid configuration made a Supabase request before failing closed');
  } finally {
    console.error = oldError;
    state.__databaseError = null;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousUrlKey === undefined) delete process.env.SUPABASE_URL_KEY;
    else process.env.SUPABASE_URL_KEY = previousUrlKey;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

await t('a transient database fetch failure is logged and alerted without URL credentials', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousUrlKey = process.env.SUPABASE_URL_KEY;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = 'postgresql://private-user:TOPSECRET@db.example.supabase.co:5432/postgres';
  process.env.SUPABASE_URL = 'https://stand-in.supabase.co';
  delete process.env.SUPABASE_URL_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stand-in-service-role-key';
  state.__databaseError = Object.assign(new TypeError('Request cannot be constructed from a URL that includes credentials: ' + url), { cause: new Error('credential-bearing cause') });
  let log = '';
  const oldError = console.error;
  console.error = (...args) => { log += args.join(' ') + '\n'; };
  const before = state.telegram.length;
  try {
    const res = await digest.handler();
    assert.equal(JSON.parse(res.body).outcome, 'read-failed');
    assert.equal(state.telegram.length, before + 1);
    const alert = state.telegram[before].text;
    assert.match(alert, /Could not reach the configured Supabase REST endpoint/i);
    assert.ok(!alert.includes('TOPSECRET') && !alert.includes(url), 'credentials leaked to Telegram');
    assert.ok(!log.includes('TOPSECRET') && !log.includes(url), 'credentials leaked to logs');
  } finally {
    console.error = oldError;
    state.__databaseError = null;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousUrlKey === undefined) delete process.env.SUPABASE_URL_KEY;
    else process.env.SUPABASE_URL_KEY = previousUrlKey;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

await t('with no Telegram token the digest sends nothing and does not fail', async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const before = state.telegram.length;
  let res;
  try {
    res = await digest.handler();
  } catch (err) {
    throw new Error('the digest threw without a token: ' + err.message);
  }
  assert.equal(JSON.parse(res.body).outcome, 'send-failed');
  assert.equal(state.telegram.length, before, 'nothing may be attempted without a token');
  process.env.TELEGRAM_BOT_TOKEN = token;
});

/* ============================================================
   6. THE DIGEST PREVIEW

   roommate-digest-preview.js is the only way a human can see what the
   06:00 job will say. It is HTTP-reachable, so what matters most is not
   what it returns but what it REFUSES: a dead session, a marketing
   login, and — above all — a preview that sends a Telegram message.
   ============================================================ */

console.log('\nroommate-digest-preview.js — the gate and the preview\n');

const preview = require('../netlify/functions/roommate-digest-preview.js');

const previewCall = async (opts = {}) => {
  const res = await preview.handler({
    httpMethod: opts.method || 'POST',
    headers: opts.token ? { authorization: 'Bearer ' + opts.token } : {},
    body: '{}',
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

await t('a preview with no session is refused before it reads anything', async () => {
  state.__auth = null;
  const sends = state.telegram.length;
  const r = await previewCall({});
  assert.equal(r.status, 401);
  assert.equal(r.body.text, undefined, 'a refused call must not compose a digest');
  assert.equal(state.telegram.length, sends);
});

await t('a token Supabase does not recognise is refused — the anon key decodes nothing', async () => {
  state.__auth = { user: null, role: 'admin' };
  const r = await previewCall({ token: 'x'.repeat(40) });
  assert.equal(r.status, 401);
  assert.equal(r.body.text, undefined);
});

await t('a marketing login is refused with 403, and sees no student in the body', async () => {
  /* The dashboard hides the panel from marketing, but the endpoint is on
     the internet: the gate has to be here, on the server, and it has to
     answer BEFORE any pool row leaves Supabase. */
  state.__auth = { user: 'u-marketing', role: 'marketing' };
  const r = await previewCall({ token: 'y'.repeat(40) });
  assert.equal(r.status, 403);
  assert.equal(r.body.text, undefined);
  const body = JSON.stringify(r.body);
  assert.equal(/Grace|Ifeoma|Ngozi|Kunle/.test(body), false,
    'a refused caller was handed a student\u2019s name: ' + body);
});

await t('the admin gets the composed message, and nothing is sent to Telegram', async () => {
  state.__auth = { user: 'u-admin', role: 'admin' };
  const sends = state.telegram.length;
  const r = await previewCall({ token: 'z'.repeat(40) });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'admin');
  assert.equal(r.body.window_hours, 24);
  assert.equal(r.body.stale_days, 3);
  assert.ok(r.body.text && r.body.text.length > 40, 'no message was composed');
  assert.equal(state.telegram.length, sends,
    'a preview must never reach the channel \u2014 that is the whole contract of a preview');
});

await t('the preview composes the SAME message the scheduled job sends', async () => {
  /* Not a copy: the stale-match section the digest tests seeded above has
     to appear here, through this entirely different entry point. */
  const r = await previewCall({ token: 'z'.repeat(40) });
  assert.match(r.body.text, /Roommate digest/);
  assert.match(r.body.text, /neither side has been back/, 'the preview lost the follow-through section');
  assert.match(r.body.text, /Ifeoma/, 'the preview did not name the stalled pair');
  assert.equal(r.body.would_send, true);
  assert.ok(r.body.quiet_pairs >= 1, 'quiet pairs must be reported for the note under the preview');
});

await t('support may read it too \u2014 they can already read the pool', async () => {
  state.__auth = { user: 'u-support', role: 'support' };
  const r = await previewCall({ token: 's'.repeat(40) });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'support');
});

await t('a read that fails is reported to the asker, and never paged to the team', async () => {
  /* The scheduled job sends a Telegram alert when its read fails, because
     nobody is watching it. A human who clicked a button is watching, so
     the failure belongs in the response — and the channel stays quiet. */
  state.__auth = { user: 'u-admin', role: 'admin' };
  state.__failEvents = true;
  /* Counted before the call, not after: the scheduled digest tests above
     legitimately put digest messages in this list, so an absolute count
     would prove nothing. What must hold is that THIS call adds none. */
  const sendsBefore = state.telegram.length;
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  let r;
  try {
    r = await previewCall({ token: 'z'.repeat(40) });
  } finally {
    state.__failEvents = false;
    console.error = realError;
  }
  assert.equal(r.status, 502);
  assert.match(String(r.body.error), /Could not read/);
  assert.ok(logged.some((l) => /read failed/.test(l)), 'a lost digest must still be logged');
  assert.equal(state.telegram.length, sendsBefore,
    'a preview failure reached the team\u2019s channel \u2014 the one thing a preview must never do');
});

await t('the preview is POST only \u2014 a session token never travels in a URL', async () => {
  state.__auth = { user: 'u-admin', role: 'admin' };
  const r = await previewCall({ method: 'GET', token: 'z'.repeat(40) });
  assert.equal(r.status, 405);
  assert.equal(r.body.text, undefined);
});

await t('one signed-in user cannot hammer it', async () => {
  /* Each call is three Supabase reads, and a dashboard button is easy to
     lean on. The ceiling is per instance and per user, like every other
     limit in this repo: it slows a loop down rather than pretending to
     be a global quota. */
  state.__auth = { user: 'u-limiter', role: 'admin' };
  const codes = [];
  for (let i = 0; i < preview.PREVIEW_MAX + 2; i++) {
    codes.push((await previewCall({ token: 'l'.repeat(40) })).status);
  }
  assert.deepEqual(codes.slice(0, preview.PREVIEW_MAX), new Array(preview.PREVIEW_MAX).fill(200),
    'the allowed previews were refused: ' + codes.join(','));
  assert.equal(codes[codes.length - 1], 429, 'the cap never engaged: ' + codes.join(','));
});

/* Restore the caller's environment: this suite can also be run from the
   repository's aggregate runner, where mutating the parent's test setup
   would make results depend on execution order. */
if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
else process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;
if (ORIGINAL_SUPABASE_URL_KEY === undefined) delete process.env.SUPABASE_URL_KEY;
else process.env.SUPABASE_URL_KEY = ORIGINAL_SUPABASE_URL_KEY;
if (ORIGINAL_SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_SUPABASE_SERVICE_ROLE_KEY;
if (ORIGINAL_FETCH === undefined) delete global.fetch;
else global.fetch = ORIGINAL_FETCH;

/* ---------------- summary ---------------- */

console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
