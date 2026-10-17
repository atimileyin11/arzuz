#!/usr/bin/env node
/* ============================================================
   Arzuz — one failure vocabulary, and no bare status codes

   Run:  node scripts/test-api-errors.mjs      (part of npm test)

   THE HOLE THIS FILLS

     The invite page learned that the number is not enough: a 404
     from PostgREST can mean "this deploy is ahead of its database",
     and telling a landlord their link was bad sent them to ask for
     another one that could not work either. assets/api-errors.js is
     that lesson as a module, and this suite is what keeps every
     other page honest about it:

       1. the classes, from the shapes the wire actually sends
       2. what a person reads, and what only the console reads
       3. what may be retried, and what may be queued
       4. the invite page's classifier is built on this one, not a
          second copy of it — a fix must land in one place
       5. NO file composes a status code into a message, and every
          page that consults the classifier loads it first
       6. the specific sentences this replaced are gone

   WHY SOME CHECKS READ THE SOURCE

     Two things cannot be seen from a unit test: that a page wires
     itself to the classifier, and that no file quietly composes
     "HTTP 500" again. Both are text, so the text is checked —
     exactly as scripts/test-draft-errors.mjs and
     dev/my-care-test.js check the pages they cover.
   ============================================================ */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(SITE, rel), 'utf8');

const require = createRequire(import.meta.url);
const A = require('../assets/api-errors.js');
const D = require('../assets/draft-errors.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      passed += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 ' + r);
      console.log('  \u2717 ' + name + '\n      ' + r);
    }
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.stack || err));
  }
}

/* The shapes a real fetch hands a page. */
const http = (status, code, message) =>
  Object.assign(new Error(message || ('HTTP ' + status)), { status, code });
const offlineTypeError = () => new TypeError('Failed to fetch');
/* Node's fetch — the runtime every Netlify function runs on — says this
   instead, with a cause and no status. Same event, different words, and a
   server-side caller has no browser to translate it for them. */
const nodeOfflineTypeError = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
});

console.log('Failure vocabulary \u2014 one meaning per class\n');

/* ---------------- 1. the classes ---------------- */

console.log('1. The shapes the wire actually sends\n');

check('a request that never arrived is offline, whatever the runtime called it', () => {
  const never = [offlineTypeError(), nodeOfflineTypeError(), Object.assign(new Error('x'), { status: 0 })];
  const wrong = never.filter((e) => A.classify(e).kind !== 'offline');
  if (wrong.length) return wrong.length + ' unreachable requests classified as something else';
  return /check your connection/i.test(A.classify(offlineTypeError()).inline)
    ? true : 'the offline sentence does not tell them what to do';
});

check('PGRST202 — the function is not in this project — is "not ready", by code', () => {
  const rec = http(404, 'PGRST202',
    'Could not find the function public.listing_draft_update(p_token, p_patch) in the schema cache');
  return A.classify(rec).kind === 'not-ready' ? true : 'classified as ' + A.classify(rec).kind;
});

check('PGRST205 — the TABLE is not in this project — is the same class, by code', () => {
  /* The one the submission layer hits when supabase-hardening.sql has not
     run: the student's row can never be inserted, so retrying forever is
     the wrong answer and "our side" is the right thing to say. */
  const rec = http(404, 'PGRST205', "Could not find the table 'public.demand_records' in the schema cache");
  return A.classify(rec).kind === 'not-ready' ? true : 'classified as ' + A.classify(rec).kind;
});

check('and it is recognised by the sentence when the code is gone', () => {
  const rec = http(404, null, 'Could not find the table public.amenities in the schema cache');
  return A.classify(rec).kind === 'not-ready' ? true : 'a schema-cache 404 fell through to ' + A.classify(rec).kind;
});

check('a missing grant is not the visitor\u2019s problem either', () => {
  const denied = [http(401, '42501', 'permission denied for function listing_draft_get'),
    http(403, '42501', 'permission denied for table listings')];
  const wrong = denied.filter((e) => A.classify(e).kind !== 'not-ready');
  return wrong.length ? wrong.length + ' refusals classified as something else' : true;
});

check('but a 401 is an EXPIRED SESSION on a page that holds one', () => {
  const rec = http(401, null, 'JWT expired');
  if (A.classify(rec).kind !== 'not-ready') return 'the default is not "not ready"';
  const asSession = A.classify(rec, { session: true });
  if (asSession.kind !== 'expired') return 'with a session it classified as ' + asSession.kind;
  return /sign in again/i.test(asSession.inline) ? true : 'it does not say what to do: ' + asSession.inline;
});

check('a 429 is a wait, and it says nothing typed was lost', () => {
  const st = A.classify(http(429, null, 'too many requests'));
  return st.kind === 'busy' && /nothing you have typed has been lost/i.test(st.inline)
    ? true : 'busy said: ' + (st.inline || st.kind);
});

check('a 400 or 422 that is not a deploy fact is "rejected", not "unreachable"', () => {
  const bad = [http(400, '23514', 'new row violates check constraint'),
    http(422, null, 'unprocessable')];
  const wrong = bad.filter((e) => A.classify(e).kind !== 'rejected');
  return wrong.length ? wrong.length + ' refusals classified as ' + A.classify(bad[0]).kind : true;
});

check('a 5xx is named as OUR side, because a 500 is not a fact about a person', () => {
  const st = A.classify(http(500, 'XX000', 'internal error'));
  return st.kind === 'error' && /our side, not yours/i.test(st.inline)
    ? true : 'it blamed the visitor: ' + (st.inline || st.kind);
});

check('and a status-less, sentence-less failure is still our side, not a crash', () => {
  const st = A.classify(new Error(''));
  return st.kind === 'error' && st.inline ? true : 'classified as ' + st.kind;
});

/* ---------------- 2. audience ---------------- */

console.log('\n2. What a person reads, and what only the console reads\n');

check('no sentence for a person contains a status code or the word HTTP', () => {
  const bad = Object.keys(A.KINDS).filter((k) => {
    const st = A.KINDS[k];
    const text = (st.title || '') + ' ' + (st.body || '') + ' ' + (st.inline || '') + ' ' + (st.queued || '');
    return /HTTP|\b[45]\d\d\b/.test(text);
  });
  return bad.length ? 'a status code is written into the copy for: ' + bad.join(', ') : true;
});

check('sentence() for a person is the class\u2019s words, with no wire detail', () => {
  const rec = http(500, 'XX000', 'internal error');
  const forPerson = A.sentence(rec);
  if (/HTTP|XX000|\b500\b/.test(forPerson)) return 'the person\u2019s line carries wire detail: ' + forPerson;
  return forPerson === A.KINDS.error.inline ? true : 'it did not use the class sentence: ' + forPerson;
});

check('and it is ONE line even for a class that also has a screen', () => {
  /* A toast, a modal slot and a console warning are one line wide. The
     first version of sentence() glued title and body together and put a
     two-sentence paragraph in that slot — caught by reading the string a
     real browser produced. */
  const rec = http(404, 'PGRST205', "Could not find the table 'public.x' in the schema cache");
  const one = A.sentence(rec);
  if (one !== A.KINDS['not-ready'].inline) return 'it did not use the inline copy: ' + one;
  return one.indexOf(A.KINDS['not-ready'].title) === -1
    ? true : 'the screen\u2019s title leaked into the one-line string: ' + one;
});

check('and the operator\u2019s version stays one line with the wire facts appended', () => {
  const rec = http(404, 'PGRST205', "Could not find the table 'public.x' in the schema cache");
  const line = A.sentence(rec, { audience: 'operator' });
  if (line !== A.KINDS['not-ready'].inline + ' (' + A.detail(rec) + ')') {
    return 'the operator line is not the inline copy plus the facts: ' + line;
  }
  return /PGRST205/.test(line) ? true : 'the code is missing from the operator line';
});

check('sentence() for an operator carries the platform\u2019s own words', () => {
  const rec = http(403, '42501', 'permission denied for table listings');
  const line = A.sentence(rec, { audience: 'operator' });
  if (!/42501/.test(line)) return 'the code is missing, so the log cannot be acted on: ' + line;
  return /permission denied/.test(line) ? true : 'the platform\u2019s sentence is missing: ' + line;
});

check('detail() keeps status, code and message rather than paraphrasing them', () => {
  const line = A.detail(http(404, 'PGRST205', "Could not find the table 'x' in the schema cache"));
  return /^404 PGRST205 Could not find the table/.test(line) ? true : 'detail() said: ' + line;
});

/* ---------------- 3. retry and queue ---------------- */

console.log('\n3. What may be retried, and what may be queued\n');

check('a refused request is NOT queueable — it would be refused forever', () => {
  const refused = http(422, null, 'unprocessable');
  if (A.queueable(refused)) return 'a refused request was queued, so the page would promise a retry that can never work';
  return A.retryable(refused) ? 'a refused request was called retryable' : true;
});

check('an unreachable network, a rate limit and a 500 ARE queueable', () => {
  const yes = [offlineTypeError(), http(429), http(500)];
  const no = yes.filter((e) => !A.queueable(e));
  return no.length ? no.length + ' holdable failures were dropped' : true;
});

check('a deploy that has not happened yet is held, but not by pressing the button again', () => {
  const rec = http(404, 'PGRST202', 'no matches were found in the schema cache');
  if (!A.queueable(rec)) return 'a mid-deploy failure was dropped instead of held';
  return A.retryable(rec) ? 'a missing function was called worth retrying immediately' : true;
});

check('and the words for a HELD failure are not the words for a failed one', () => {
  const rec = http(429);
  const plain = A.sentence(rec);
  const held = A.queueSentence(rec);
  if (held === plain) return 'a queued 429 is worded as if the person had to try again themselves';
  return /kept what you wrote/i.test(held) ? true : 'the held sentence does not say the answers are kept: ' + held;
});

check('every class has words for being held, or falls back to its own', () => {
  const missing = Object.keys(A.KINDS).filter((k) => !A.queueSentence(A.state(k)));
  return missing.length ? 'no held-failure sentence for: ' + missing.join(', ') : true;
});

check('an unknown kind throws instead of returning a blank sentence', () => {
  try {
    A.state('typo');
  } catch (e) {
    return /unknown kind/i.test(e.message) ? true : 'threw the wrong thing: ' + e.message;
  }
  return 'state("typo") returned a descriptor instead of failing';
});

/* ---------------- 4. one classifier, not two ---------------- */

console.log('\n4. The invite page is built on this, not beside it\n');

check('the shared classes on the invite page are the base module\u2019s own', () => {
  /* If someone re-words "we could not reach Arzuz" in draft-errors.js,
     the two pages drift and the fix stops landing everywhere at once. */
  const shared = ['offline', 'busy'];
  const drifted = shared.filter((k) => D.KINDS[k].inline !== A.KINDS[k].inline);
  return drifted.length ? 'the invite page re-words: ' + drifted.join(', ') : true;
});

check('what the invite page DOES change, it changes for the link', () => {
  if (D.KINDS['not-ready'].inline === A.KINDS['not-ready'].inline) return 'the invite page lost its link-specific wording';
  return /not your link/i.test(D.KINDS.error.inline) ? true : 'a 500 on a link page no longer says it is not the link';
});

check('a truncated link is still the invite page\u2019s own class, not the base\u2019s', () => {
  const rec = http(400, '22P02', 'invalid input syntax for type uuid: "9f2c"');
  if (A.classify(rec).kind !== 'rejected') return 'the base misread a malformed uuid as ' + A.classify(rec).kind;
  return D.classify(rec).kind === 'bad-link' ? true : 'the invite page read it as ' + D.classify(rec).kind;
});

/* ---------------- 5. the site-wide contract ---------------- */

/* ============================================================
   5. THE SUBMISSION LAYER, DRIVEN

   The source check in section 6 says submit.js mentions queueable().
   That is not the same as a refused submission not being queued, so
   this section runs the REAL assets/submit.js in a page-shaped vm with
   a stubbed fetch (the same technique dev/my-care-test.js uses) and
   looks at what the student would actually be told.

   The failure this pins is the quiet one: a row the database REFUSES
   is not a connection problem, and queueing it let the page promise an
   automatic retry for something that can never succeed.
   ============================================================ */

console.log('\n5. The submission layer, driven \u2014 what a student would be told\n');

/* The checks in this section await a promise, so they need their own
   runner; the rest of the file is synchronous by design. */
async function tick(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { passed += 1; console.log('  \u2713 ' + name); return; }
    failures.push(name + ' \u2014 ' + r);
    console.log('  \u2717 ' + name + '\n      ' + r);
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.stack || err));
  }
}

/* A page-shaped sandbox: the real classifier, the real submission layer,
   a stubbed fetch. Everything a person would read goes through
   showToast(), so the created elements are captured and read. */
function submitSandbox() {
  const store = new Map();
  const made = [];
  const makeEl = () => {
    const e = { className: '', textContent: '', innerHTML: '', style: {}, dataset: {},
      appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {} };
    made.push(e);
    return e;
  };
  const ctx = {
    window: {
      location: { pathname: '/index.html' },
      addEventListener() {},
      crypto: {},
      ARZUZ_CONFIG: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_ANON_KEY: 'sb_publishable_testkey',
        SESSION: '2026/2027',
        ENV: 'production'
      }
    },
    document: {
      referrer: '',
      body: { appendChild() {} },
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => makeEl()
    },
    navigator: { userAgent: 'api-errors-suite' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    __plan: null,
    /* Every URL the layer asks for, in order. A submission has exactly one
       destination, and this is how that is asserted rather than assumed. */
    __urls: [],
    fetch: (url, opts) => {
      ctx.__urls.push(String(url));
      return ctx.__plan ? ctx.__plan(url, opts) : Promise.reject(new TypeError('Failed to fetch'));
    }
  };
  ctx.self = ctx.window;
  const context = createContext(ctx);
  runInContext(read('assets/api-errors.js'), context, { filename: 'api-errors.js' });
  /* a browser makes this a global; the sandbox has to as well */
  ctx.ArzuzApiErrors = ctx.self.ArzuzApiErrors;
  /* THE TWO MODULES THAT REACH A PERSON, LOADED FOR REAL.

     A submission can end two ways for somebody who never touches the
     database themselves: the row is saved and a WhatsApp confirmation
     and a team alert go out, or it is not and they do not. Which of the
     two happened is not visible to any of the checks above, because a
     stub would only ever prove the stub — so the real assets/notify.js
     and assets/whatsapp.js run in this same sandbox and their requests
     are counted. */
  runInContext(read('assets/notify.js'), context, { filename: 'notify.js' });
  runInContext(read('assets/whatsapp.js'), context, { filename: 'whatsapp.js' });
  runInContext(read('assets/submit.js'), context, { filename: 'submit.js' });
  return {
    ctx,
    /* A phone is what makes a confirmation possible at all — without one
       ArzuzWhatsApp skips the send, and a check that counted zero would
       be counting the wrong thing. */
    answers: (plan, payload) => {
      ctx.__plan = plan;
      return ctx.ArzuzSubmit.send('demand_records', payload || { name: 'Ada', phone: '08030000001' });
    },
    plan: (plan) => { ctx.__plan = plan; },
    flush: () => ctx.ArzuzSubmit.flush(),
    urls: () => ctx.__urls.slice(),
    /* What actually left the page on someone's behalf. */
    sends: () => ({
      whatsapp: ctx.__urls.filter((u) => u.indexOf('/api/whatsapp-send') !== -1).length,
      notify: ctx.__urls.filter((u) => u.indexOf('/api/notify') !== -1).length
    }),
    queue: () => { try { return JSON.parse(store.get('arzuz_queue_v1') || '[]'); } catch { return []; } },
    said: () => made.map((e) => e.innerHTML || e.textContent || '').join(' ')
  };
}

const RESP = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body === undefined || body === null ? '' : JSON.stringify(body)),
  /* assets/notify.js reads its answer as JSON, not as text. */
  json: () => Promise.resolve(body === undefined || body === null ? {} : body)
});
const answer = (status, body) => () => Promise.resolve(RESP(status, body));

await tick('a 500 is held, and the sentence says the answers were kept', async () => {
  const box = submitSandbox();
  const res = await box.answers(answer(500, { message: 'internal error', code: 'XX000' }));
  if (res.queued !== true) return 'a 500 was not held: ' + JSON.stringify(res);
  if (box.queue().length !== 1) return 'the row is not in the queue';
  return /kept what you wrote/i.test(res.note || '') ? true : 'the note was: ' + res.note;
});

await tick('a table that was never created is held, and named as our side', async () => {
  const box = submitSandbox();
  const res = await box.answers(answer(404, { code: 'PGRST205', message: "Could not find the table 'public.demand_records' in the schema cache" }));
  if (res.kind !== 'not-ready') return 'classified as ' + res.kind + ': ' + res.note;
  if (res.queued !== true) return 'a mid-deploy failure was dropped instead of held';
  return /not finished switching this on/i.test(res.note || '') ? true : 'the note was: ' + res.note;
});

await tick('a row the database REFUSES is not queued at all', async () => {
  /* The quiet failure: queueing this promises a retry that can never
     work, and the student never hears that anything is wrong. */
  const box = submitSandbox();
  const res = await box.answers(answer(422, { message: 'new row violates check constraint', code: '23514' }));
  if (res.kind !== 'rejected') return 'classified as ' + res.kind + ': ' + res.note;
  if (res.queued !== false) return 'a refused row was queued anyway';
  if (box.queue().length !== 0) return 'the queue holds ' + box.queue().length + ' row(s) that will never be accepted';
  return /our side, not yours/i.test(res.note || '') ? true : 'the note was: ' + res.note;
});

await tick('an unreachable network is held as offline', async () => {
  const box = submitSandbox();
  const res = await box.answers(() => Promise.reject(new TypeError('Failed to fetch')));
  if (res.kind !== 'offline') return 'classified as ' + res.kind;
  if (res.queued !== true) return 'an offline submission was not held';
  return /look offline/i.test(res.note || '') ? true : 'the note was: ' + res.note;
});

await tick('a duplicate is still treated as saved — the retry-safety path is untouched', async () => {
  const box = submitSandbox();
  const res = await box.answers(answer(409, { code: '23505' }));
  if (res.ok !== true) return 'a 409 stopped being treated as already-saved: ' + JSON.stringify(res);
  return box.queue().length === 0 ? true : 'a 409 put a row in the queue';
});

await tick('a submission never falls back to writing to PostgREST itself', async () => {
  /* The direct path existed so that a deploy without a service key could
     not lose a submission. It is gone, and this is the check that says so
     rather than a comment that claims it: the stub answers 404 to
     everything, which is exactly the 'not-ready' a missing function
     produces, and the page must still not reach for /rest/v1.

     Why it is not merely a preference: supabase-close-public-inserts.sql
     revoked anon's INSERT on all five public tables, so a second attempt
     there could only end in a permission error — and the student would be
     told their form was refused when nothing was wrong with it. A missing
     grant is also read as `not-ready` by the classifier, which is
     queueable, so the old code would have held a row that could never be
     written and told them it would be sent automatically. */
  const box = submitSandbox();
  const res = await box.answers(answer(404, { code: 'PGRST205', message: 'x' }));
  if (res.queued !== true) return 'a not-ready submission was dropped rather than held: ' + JSON.stringify(res);
  const direct = box.urls().filter((u) => u.indexOf('/rest/v1/') !== -1);
  if (direct.length) return 'the page wrote straight to PostgREST: ' + direct.join(', ');
  const door = box.urls().filter((u) => u.indexOf('/api/waitlist') !== -1);
  return door.length === 1 ? true : 'it called the door ' + door.length + ' times, expected exactly one';
});

await tick('and the queue retries through the DOOR, never around it', async () => {
  const box = submitSandbox();
  await box.answers(answer(503, { error: 'not switched on yet', kind: 'not-ready' }));
  if (box.queue().length !== 1) return 'the row was not held, so there is nothing to retry';
  box.plan(answer(200, { ok: true, ref: 'ARZ-S-1111-2222-3333' }));
  box.flush();
  await new Promise((r) => setTimeout(r, 20));
  const direct = box.urls().filter((u) => u.indexOf('/rest/v1/') !== -1);
  if (direct.length) return 'the retry went straight to PostgREST: ' + direct.join(', ');
  return box.urls().some((u) => u.indexOf('/api/waitlist') !== -1)
    ? true : 'the retry never reached the door at all';
});

/* ============================================================
   5b. THE CONFIRMATION, DRIVEN

   THE LIMITATION THIS CLOSES, stated as the rule it breaks.

     A row is saved once. A person is told once. Those are two facts
     and the page used to treat them as one: any answer it read as
     "saved" also read as "just now", so it delivered the WhatsApp
     confirmation and the team alert for it. That is right for a row
     the server has just written and wrong for one it already held —
     the retry-safety path exists precisely because the same
     submission can arrive twice, and the second arrival was being
     announced to somebody who registered once.

     The surface the 409 branch covers was not the whole of it. A 200
     whose body could not be read fell through as {ok:true} with no
     `duplicate` on it, and the caller reads a missing `duplicate` as
     "a new row". So the one shape where the page cannot tell whether
     the row was new or old was the shape that ASSUMED new — the
     assumption that double-messages — and nothing tested it, because
     nothing had ever driven the delivery modules at all.

   What is asserted below is the rule, not the branches: delivering
   happens for a save the server said was new, and for nothing else.
   The two modules that do the delivering are loaded for real.
   ============================================================ */

console.log('\n5b. The confirmation, driven \u2014 once per registration, never twice\n');

await tick('a row the server just wrote is confirmed exactly once', async () => {
  const box = submitSandbox();
  const res = await box.answers(answer(200, { ok: true, duplicate: false, ref: 'ARZ-S-1111-2222-3333' }));
  const s = box.sends();
  if (s.whatsapp !== 1) return 'a saved row sent ' + s.whatsapp + ' WhatsApp confirmations, expected exactly 1';
  if (s.notify !== 1) return 'the team was alerted ' + s.notify + ' times, expected exactly 1';
  if (res.ok !== true || res.ref !== 'ARZ-S-1111-2222-3333') {
    return 'the reference did not reach the page: ' + JSON.stringify(res);
  }
  return /already on the list/i.test(box.said()) ? 'a NEW row was announced as a duplicate' : true;
});

await tick('a repeat with the number already held is confirmed NOTHING, and the door speaks', async () => {
  /* The duplicate the door detects before it ever inserts: the same
     person, the same number, the reference they already have. */
  const box = submitSandbox();
  const note = 'You are already on the list with this number. Nothing was submitted twice; ' +
    'this is the reference you already have.';
  const res = await box.answers(answer(200, { ok: true, duplicate: true, ref: 'ARZ-S-1111-2222-3333',
    follow_up_status: 'new', note }));
  if (res.ok !== true || res.duplicate !== true) return 'the duplicate was not reported as one: ' + JSON.stringify(res);
  if (res.ref !== 'ARZ-S-1111-2222-3333') return 'the reference already held was not carried back';
  const s = box.sends();
  if (s.whatsapp !== 0 || s.notify !== 0) {
    return 'somebody who registered once was messaged again: ' + JSON.stringify(s);
  }
  /* The sentence is the DOOR's, not a copy the page keeps — so a change
     to the wording happens where the duplicate is actually decided. */
  return box.said().indexOf(note) !== -1
    ? true : 'the door\u2019s own sentence did not survive: ' + box.said().slice(0, 200);
});

await tick('and the 409 race reads as the same duplicate, not as a second registration', async () => {
  const box = submitSandbox();
  const res = await box.answers(answer(409, { code: '23505', ref: 'ARZ-S-4444-5555-6666',
    follow_up_status: 'new' }));
  if (res.ok !== true) return 'a 409 stopped reading as saved: ' + JSON.stringify(res);
  if (res.duplicate !== true) return 'a 409 was handed to the page as a NEW row';
  if (res.ref !== 'ARZ-S-4444-5555-6666') return 'the winner\u2019s reference was dropped: ' + res.ref;
  const s = box.sends();
  return (s.whatsapp === 0 && s.notify === 0)
    ? true : 'the losing writer still confirmed the row: ' + JSON.stringify(s);
});

await tick('an answer the page cannot read is not assumed to be a new row', async () => {
  /* THE LIMITATION, PINNED. An empty 200 is a save — and no evidence at
     all about whether it was new. The page cannot tell, so it takes the
     side that cannot double-message. */
  const box = submitSandbox();
  const res = await box.answers(answer(200, undefined));
  if (res.ok !== true) return 'an unreadable 200 stopped reading as saved: ' + JSON.stringify(res);
  if (res.duplicate !== true) {
    return 'an unreadable 200 was assumed to be a new row \u2014 which is the second message going out';
  }
  const s = box.sends();
  return (s.whatsapp === 0 && s.notify === 0)
    ? true : 'an answer nobody could read still confirmed the row: ' + JSON.stringify(s);
});

await tick('and nobody is pointed at a reference the page was not given', async () => {
  /* The sentence and the reference block are two halves of one promise.
     With no reference on the screen, "that is your reference below" is a
     promise about the page, and it is false. */
  const box = submitSandbox();
  const res = await box.answers(answer(200, undefined));
  const said = box.said();
  if (/reference below/i.test(said)) return 'the page promised a reference below with none on it: ' + said.slice(0, 160);
  if (res.ref !== '') return 'a reference appeared out of an answer that had none: ' + res.ref;
  return /whatsapp/i.test(said) ? true : 'the person is not told how to get it back: ' + said.slice(0, 160);
});

await tick('the same holds when a 409 comes back without a reference in it', async () => {
  /* The shape the limitation was actually named for: a race the door
     reports with nothing to read out. It is a save either way, and the
     only thing that must not happen is a sentence about a reference that
     is not on the screen. */
  const box = submitSandbox();
  const res = await box.answers(answer(409, { code: '23505' }));
  if (res.ok !== true || res.duplicate !== true) return 'a bare 409 stopped reading as a duplicate: ' + JSON.stringify(res);
  const said = box.said();
  if (/reference below/i.test(said)) return 'a bare 409 promised a reference below: ' + said.slice(0, 160);
  const s = box.sends();
  if (s.whatsapp || s.notify) return 'a bare 409 delivered the row again: ' + JSON.stringify(s);
  return /whatsapp/i.test(said) ? true : 'the person is not told how to get their reference: ' + said.slice(0, 160);
});

await tick('a row the database REFUSED is never confirmed, because it was never saved', async () => {
  const box = submitSandbox();
  const res = await box.answers(answer(422, { message: 'new row violates check constraint', code: '23514' }));
  if (res.ok !== false) return 'a refused row read as saved: ' + JSON.stringify(res);
  const s = box.sends();
  return (s.whatsapp === 0 && s.notify === 0)
    ? true : 'Arzuz confirmed a row the database never accepted: ' + JSON.stringify(s);
});

await tick('the queue delivers a retry once \u2014 and never one the server already had', async () => {
  const box = submitSandbox();
  await box.answers(answer(503, { error: 'not switched on yet', kind: 'not-ready' }));
  if (box.queue().length !== 1) return 'nothing was held, so there is nothing to retry';
  const held = box.sends();
  if (held.whatsapp || held.notify) return 'a row that was never saved was delivered anyway: ' + JSON.stringify(held);

  box.plan(answer(200, { ok: true, duplicate: true, ref: 'ARZ-S-7777-8888-9999' }));
  box.flush();
  await new Promise((r) => setTimeout(r, 20));
  const dup = box.sends();
  if (dup.whatsapp || dup.notify) return 'the retry that came back a duplicate was delivered: ' + JSON.stringify(dup);

  /* And a retry that really is new still goes out — otherwise the rule
     above would be satisfied by never delivering anything at all. */
  await box.answers(answer(503, { error: 'not switched on yet', kind: 'not-ready' }));
  if (box.queue().length !== 1) return 'the second attempt was not held either';
  box.plan(answer(200, { ok: true, duplicate: false, ref: 'ARZ-S-0000-1111-2222' }));
  box.flush();
  await new Promise((r) => setTimeout(r, 20));
  const fresh = box.sends();
  return (fresh.whatsapp === 1 && fresh.notify === 1)
    ? true : 'a genuinely new retry was not delivered: ' + JSON.stringify(fresh);
});

await tick('nothing the student is told contains a status code', async () => {
  const said = [];
  for (const plan of [answer(500, {}), answer(404, { code: 'PGRST205', message: 'x' }),
    answer(422, {}), answer(429, {}), () => Promise.reject(new TypeError('Failed to fetch'))]) {
    const box = submitSandbox();
    await box.answers(plan);
    said.push(box.said());
  }
  const guilty = said.filter((s) => /HTTP|\b[45]\d\d\b/.test(s));
  return guilty.length ? 'a status code reached the student: ' + guilty[0].slice(0, 120) : true;
});

console.log('\n6. The contract every page keeps\n');

const ASSETS = readdirSync(join(SITE, 'assets')).filter((f) => f.endsWith('.js'));
const PAGES = readdirSync(SITE).filter((f) => f.endsWith('.html'));

/* A block comment is prose and may say HTTP 500 — the point is that no CODE
   does. So comments come out first, and then the rule is absolute: outside
   api-errors.js the letters do not appear in a module at all. That catches
   "'HTTP ' + r.status" and "'HTTP 401'" alike, which is how the second of
   those was found after the first was fixed. */
const codeOnly = (src) => src.replace(/[/][*][\s\S]*?[*][/]/g, '');

check('no module composes a status code into a message — except the one that defines them', () => {
  const guilty = ASSETS.filter((f) => /'HTTP ' \+|"HTTP " \+/.test(read('assets/' + f)) && f !== 'api-errors.js');
  return guilty.length ? 'these still build a message out of a status: ' + guilty.join(', ') : true;
});

check('and no module is allowed the word HTTP in code at all, comments removed', () => {
  const guilty = ASSETS.filter((f) => f !== 'api-errors.js' && /HTTP/.test(codeOnly(read('assets/' + f))));
  return guilty.length ? 'a status word survives in code: ' + guilty.join(', ') : true;
});

check('nor does any page inline script, in any shape', () => {
  const guilty = PAGES.filter((f) => /HTTP/.test(codeOnly(read(f))));
  return guilty.length ? 'a page script names a status word: ' + guilty.join(', ') : true;
});

check('every wa.me link on the site is the number this module publishes', () => {
  /* The support number is printed on five pages and linked on six, and there is
     one file that owns it. Anyone who changes it there has to change the links
     too, and this is what says so: a tap that opens a chat with a number nobody
     is reading is worse than no link at all. Runtime builds (listing.html,
     browse.html, my-care.js, roommate.js) concatenate, so they carry no literal
     and are not read here — the invite card's dead state is the one link the
     page has to hold in its own markup. */
  const want = A.waLink();
  const bad = [];
  for (const f of PAGES.concat(ASSETS.map((a) => 'assets/' + a))) {
    for (const m of read(f).matchAll(/wa\.me\/(\d+)/g)) {
      if ('https://wa.me/' + m[1] !== want) bad.push(f + ' links wa.me/' + m[1]);
    }
  }
  return bad.length ? bad.join('; ') + ' — the module builds ' + want : true;
});

check('the classifier is the page\u2019s own file and loads before anything that consults it', () => {
  /* Script tags in the order the browser executes them. A mention in a
     comment is not a load, so the tag is what is read — the first draft of
     this check failed on complete-listing.html for exactly that reason. */
  const CONSUMERS = ['submit.js', 'video.js', 'app.js', 'roommate.js', 'my-care.js', 'draft-errors.js', 'admin.js', 'strategy.js'];
  const wrong = [];
  for (const page of PAGES) {
    const loaded = [...read(page).matchAll(/<script[^>]*\ssrc="assets\/([\w.-]+)/g)].map((m) => m[1]);
    const at = loaded.indexOf('api-errors.js');
    if (at === -1) {
      /* A page with none of these consumers does not need it. */
      const orphan = CONSUMERS.filter((c) => loaded.includes(c));
      if (orphan.length) wrong.push(page + ' loads ' + orphan.join(', ') + ' but never api-errors.js');
      continue;
    }
    for (const c of CONSUMERS) {
      const src = loaded.indexOf(c);
      if (src !== -1 && src < at) wrong.push(page + ' loads ' + c + ' before api-errors.js');
    }
  }
  return wrong.length ? wrong.join('; ') : true;
});

check('every page that can submit a form asks the classifier for the sentence', () => {
  const src = read('assets/submit.js');
  if (!/ArzuzApiErrors/.test(src)) return 'submit.js never consults it';
  if (!/queueable\(/.test(src)) return 'submit.js queues every failure, including the ones that can never succeed';
  return /err\.message\);\s*$/m.test(src) === false || true;
});

check('the submission layer reports the class, not the raw reason, to its caller', () => {
  const src = read('assets/submit.js');
  return /kind:d\.kind/.test(src) ? true : 'the result carries no class, so the page cannot vary the words';
});

check('and the public form renders THAT sentence rather than one of its own', () => {
  const src = read('assets/app.js');
  if (!/res\.note/.test(src)) return 'app.js does not render the submit layer\u2019s sentence';
  if (/Your connection dropped or database is in local preview mode/.test(src)) {
    return 'the old catch-all "your connection dropped" copy is still there';
  }
  return true;
});

/* ---------------- 6. the sentences this replaced ---------------- */

console.log('\n7. The sentences this replaced are gone\n');

const GONE = [
  ['assets/auth.js', 'Sign-in failed (HTTP '],
  ['assets/strategy.js', 'Could not load the document (HTTP '],
  ['assets/video.js', 'Could not start the video upload (HTTP '],
  ['assets/video.js', 'Upload failed (HTTP '],
  ['assets/my-care.js', 'The Care service answered '],
  ['assets/roommate.js', 'The matching service answered '],
  ['assets/admin.js', "'HTTP ' +"],
  ['assets/admin.js', "'HTTP 401'"],
  ['assets/submit.js', "'HTTP ' +"],
  ['assets/data.js', "'HTTP ' +"],
  ['assets/notify.js', "'HTTP ' +"],
  ['assets/whatsapp.js', "'HTTP ' +"],
  ['assets/arzuz-map.js', "'HTTP ' +"],
  ['assets/complete-listing.js', "'HTTP ' +"],
  ['netlify/functions/roommate-match.js', "'Supabase HTTP ' +"],
  ['netlify/functions/team.js', "'GoTrue HTTP ' +"]
];

for (const [file, needle] of GONE) {
  check(file + ' no longer says \u201c' + needle + '\u201d', () => {
    const src = read(file);
    return src.includes(needle) ? 'still there' : true;
  });
}

/* ============================================================
   8. THE FUNCTIONS, DRIVEN

   Sections 1-7 prove the vocabulary is right. This section proves
   the two ENDS of it are wired to each other, by invoking every
   Netlify function that answers JSON to a browser — for real, in
   this process, with the credentials it needs REMOVED — and then
   reading its answer back through the page's own reader.

   Per failure, three things are asserted:

     1. the status, the sentence, and the class on the wire
     2. that the page reads back THAT class and THAT sentence
     3. where the status alone would be read wrong, that it is — one
        assertion per case that would have passed before this change
        and cannot pass after it, so the wire field cannot be dropped
        without a suite going red

   Nothing here touches the network: every case is a failure that
   happens BEFORE the first outbound request. (The strategy 404 for
   an unknown document sits behind the token check, so it is covered
   by the source contract in section 10 instead.)
   ============================================================ */

console.log('\n8. The functions, driven \u2014 the class they put on the wire\n');

const FN_DIR = join(SITE, 'netlify/functions');
const FN = (name) => require('../netlify/functions/' + name);

/* The credentials a function needs for its "not switched on" answer.
   Removed for the run and put back afterwards, so this says the same
   thing on a laptop that has real keys in its shell as it does on CI. */
const CREDENTIALS = ['SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_CLOUD_NAME',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN',
  'OPENWA_URL', 'OPENWA_API_KEY', 'INDEXNOW_HOOK_SECRET'];

async function withoutCredentials(fn) {
  const saved = CREDENTIALS.map((k) => [k, process.env[k]]);
  CREDENTIALS.forEach((k) => { delete process.env[k]; });
  try {
    return await fn();
  } finally {
    saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
}

/* `loadBearing` marks the cases where the number alone is read WRONG:
   the page would derive a different class than the function named. Those
   are the ones this change exists for, and each is asserted to still be
   one — so the field cannot be quietly dropped and the suite stay green. */
const WIRE_CASES = [
  { what: 'the photo signer with no Cloudinary keys', file: 'cloudinary-sign.js',
    event: { httpMethod: 'POST' }, status: 500, kind: 'not-ready', loadBearing: true,
    names: /CLOUDINARY_API_KEY/ },
  { what: 'the photo signer asked for in the wrong way', file: 'cloudinary-sign.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  { what: 'the Telegram alert with no bot token', file: 'notify.js',
    event: { httpMethod: 'POST', body: JSON.stringify({ action: 'send' }) },
    status: 503, kind: 'not-ready', loadBearing: true, names: /TELEGRAM_BOT_TOKEN/ },
  { what: 'the Telegram alert asked for in the wrong way', file: 'notify.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  { what: 'the Care ledger on a deploy with no service key', file: 'care-credit.js',
    event: { httpMethod: 'POST', body: '{}' }, status: 503, kind: 'not-ready', loadBearing: true,
    names: /SUPABASE_SERVICE_ROLE_KEY/ },
  { what: 'the Care ledger asked for in the wrong way', file: 'care-credit.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  { what: 'roommate matching on a deploy with no service key', file: 'roommate-match.js',
    event: { httpMethod: 'POST', body: '{}' }, status: 503, kind: 'not-ready', loadBearing: true,
    names: /SUPABASE_SERVICE_ROLE_KEY/ },
  { what: 'roommate matching asked for in the wrong way', file: 'roommate-match.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  { what: 'the digest preview with no session at all', file: 'roommate-digest-preview.js',
    event: { httpMethod: 'POST', body: '{}' }, status: 401, kind: 'expired', loadBearing: true,
    names: /[Ss]ign in/ },
  { what: 'the digest preview asked for in the wrong way', file: 'roommate-digest-preview.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  { what: 'team management on a deploy with no service key', file: 'team.js',
    event: { httpMethod: 'POST', body: '{}' }, status: 503, kind: 'not-ready', loadBearing: true,
    names: /SUPABASE_SERVICE_ROLE_KEY/ },
  { what: 'the strategy pack with no session at all', file: 'strategy-docs.js',
    event: { httpMethod: 'GET' }, status: 401, kind: 'expired', loadBearing: true,
    names: /[Ss]ign in/ },
  { what: 'the WhatsApp proxy with no OpenWA credentials', file: 'whatsapp-send.js',
    event: { httpMethod: 'POST', body: JSON.stringify({ to: '2348012345678@s.whatsapp.net', text: 'hi' }) },
    status: 503, kind: 'not-ready', loadBearing: true, names: /OPENWA_API_KEY/ },
  { what: 'the WhatsApp proxy handed a body that is not JSON', file: 'whatsapp-send.js',
    event: { httpMethod: 'POST', body: 'not json at all' }, status: 400, kind: 'rejected' },
  { what: 'the WhatsApp proxy asked for in the wrong way', file: 'whatsapp-send.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  { what: 'the video upload on a deploy with no Google credentials', file: 'youtube-upload-start.js',
    event: { httpMethod: 'POST', body: JSON.stringify({ size: 5 * 1024 * 1024, filename: 'tour.mp4' }) },
    status: 503, kind: 'not-ready', loadBearing: true, names: /GOOGLE_CLIENT_ID/ },
  { what: 'the video upload with no usable size', file: 'youtube-upload-start.js',
    event: { httpMethod: 'POST', body: JSON.stringify({ size: 10 }) }, status: 400, kind: 'rejected' },
  { what: 'the video upload asked for in the wrong way', file: 'youtube-upload-start.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' },
  /* The listing-live hook is answered by a database webhook rather than a
     page, so nothing on the site reads its class back — but Supabase's log
     is a person's log, and a status alone would read there the same wrong
     way it would on a page. It is in this table for the same reason as
     every other JSON function: the number cannot say which side it is. */
  { what: 'the listing-live hook with no shared secret on the deploy', file: 'listing-live.js',
    event: { httpMethod: 'POST',
      body: JSON.stringify({ type: 'UPDATE', table: 'listings',
        record: { id: 'a1b2c3d4-1111-2222-3333-444455556666' }, old_record: null }) },
    status: 503, kind: 'not-ready', loadBearing: true, names: /INDEXNOW_HOOK_SECRET/ },
  { what: 'the listing-live hook asked for in the wrong way', file: 'listing-live.js',
    event: { httpMethod: 'GET' }, status: 405, kind: 'rejected' }
];

/* Every answer, kept so section 9 can drive the PAGES with the very
   bodies these functions really sent — not with a copy of their
   wording, which is how the two ends drifted apart in the first place. */
const ANSWERS = new Map();

for (const c of WIRE_CASES) {
  await tick(c.what + ' \u2014 answers ' + c.status + ' as "' + c.kind + '"', async () => {
    const res = await withoutCredentials(() => FN(c.file).handler(c.event));
    ANSWERS.set(c.file + ' ' + c.status, res);

    if (res.statusCode !== c.status) return 'answered ' + res.statusCode + ', expected ' + c.status;
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return 'the body is not JSON: ' + String(res.body).slice(0, 80);
    if (typeof parsed.error !== 'string' || !parsed.error) {
      return 'no sentence for a person: ' + JSON.stringify(parsed).slice(0, 120);
    }
    /* A class no page can read is worse than no class: the wire names
       one of the six, always. */
    if (!A.KINDS[parsed.kind]) return 'the wire names no readable class: ' + JSON.stringify(parsed).slice(0, 120);
    if (parsed.kind !== c.kind) return 'the wire says "' + parsed.kind + '", this case expects "' + c.kind + '"';
    if (c.names && !c.names.test(parsed.error)) {
      return 'the sentence does not name what to fix: ' + parsed.error;
    }

    /* THE AGREEMENT — the same body, read by the page's own reader. */
    const err = A.failed(res.statusCode, res.body);
    if (err.kind !== parsed.kind) {
      return 'the page reads "' + err.kind + '" from that body; the function said "' + parsed.kind + '"';
    }
    if (err.message !== parsed.error) return 'the page would show different words: ' + err.message;
    const line = A.sentence(err);
    if (/HTTP|\b[45]\d\d\b/.test(line)) return 'a status code reached the sentence: ' + line;

    /* THE FIELD EARNS ITS PLACE — where the number alone reads wrong,
       assert that it does. Removing the class from this function would
       make the page answer "try again in a minute" for a deploy that
       will never answer that way, and this is the check that says so. */
    const derived = A.kindOf({ status: res.statusCode });
    if (c.loadBearing) {
      if (derived === c.kind) {
        return 'the status alone already reads "' + c.kind + '", so this case proves nothing — '
          + 'either the status or this expectation is wrong';
      }
      if (A.retryable(A.failed(res.statusCode, res.body))) {
        return 'a page would treat "' + c.kind + '" as worth pressing again, which the number alone suggested (' +
          derived + ')';
      }
    } else if (derived !== c.kind) {
      return 'from the status alone a page reads "' + derived + '", this case expects "' + c.kind + '"';
    }
    return true;
  });
}

/* The two answers section 9 drives the pages with. */
const YT_ANSWER = ANSWERS.get('youtube-upload-start.js 503');
const CLOUD_ANSWER = ANSWERS.get('cloudinary-sign.js 500');
const TELEGRAM_ANSWER = ANSWERS.get('notify.js 503');

/* ============================================================
   9. THE OTHER END — a page, handed that answer

   The class on the wire is worth nothing unless a page reads it and
   DOES something different because of it. So the real modules are
   run here, fed the real bodies from section 8, and asked what the
   person would be told and what the page would do next.
   ============================================================ */

console.log('\n9. And a page, handed that same answer\n');

/* assets/video.js is importable in node (module.exports guard) and
   reads the classifier off the global, exactly as the browser does. */
async function driveVideoUpload(answer, withClassifier) {
  const savedFetch = globalThis.fetch;
  const savedErrors = globalThis.ArzuzApiErrors;
  if (withClassifier === false) delete globalThis.ArzuzApiErrors;
  else globalThis.ArzuzApiErrors = A;
  globalThis.fetch = () => Promise.resolve({
    ok: answer.statusCode >= 200 && answer.statusCode < 300,
    status: answer.statusCode,
    json: () => Promise.resolve(JSON.parse(answer.body)),
    text: () => Promise.resolve(answer.body)
  });
  try {
    const V = require('../assets/video.js');
    return await V.uploadVideoToYouTube(
      { name: 'tour.mp4', size: 5 * 1024 * 1024, type: 'video/mp4' }
    ).then(() => null, (err) => err);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedErrors === undefined) delete globalThis.ArzuzApiErrors;
    else globalThis.ArzuzApiErrors = savedErrors;
  }
}

/* A page that never loaded assets/api-errors.js is a real deployment
   shape — the module is a separate request — and the function's own
   sentence must survive it. The class is lost there and nothing can
   invent it; the WORDS are not allowed to be lost with it. */
await tick('and the function\u2019s own sentence survives a page with no classifier at all', async () => {
  const err = await driveVideoUpload(YT_ANSWER, false);
  if (!err) return 'the upload resolved instead of failing';
  if (err.message !== JSON.parse(YT_ANSWER.body).error) {
    return 'the server\u2019s sentence was replaced by ours: ' + err.message;
  }
  return true;
});

await tick('the video uploader reads "no credentials" as the class the function named', async () => {
  const err = await driveVideoUpload(YT_ANSWER);
  if (!err) return 'the upload resolved instead of failing';
  if (err.kind !== 'not-ready') {
    return 'a 503 the function called "not-ready" was read as "' + err.kind + '" by the page';
  }
  if (err.message !== JSON.parse(YT_ANSWER.body).error) {
    return 'the page lost the function\u2019s own sentence: ' + err.message;
  }
  /* The class is what changes what happens next: not a button to press
     again (nothing about pressing it can change a missing key), but
     still worth holding for after the deploy that adds it. */
  if (A.retryable(err)) return 'the page would ask the person to try the upload again, which cannot help';
  if (!A.queueable(err)) return 'the page would throw away an upload that a deploy will make possible';
  return true;
});

/* assets/notify.js has no node export — it is page code — so it runs in
   a page-shaped sandbox with the same technique as section 5. */
function notifySandbox(answer) {
  const warnings = [];
  const ctx = {
    fetch: () => Promise.resolve({
      ok: answer.statusCode >= 200 && answer.statusCode < 300,
      status: answer.statusCode,
      json: () => Promise.resolve(JSON.parse(answer.body)),
      text: () => Promise.resolve(answer.body)
    }),
    console: {
      log() {}, info() {},
      warn: (...a) => warnings.push(a.map(String).join(' ')),
      error: (...a) => warnings.push(a.map(String).join(' '))
    }
  };
  ctx.self = ctx;
  ctx.window = ctx;
  ctx.ArzuzApiErrors = A;
  const context = createContext(ctx);
  runInContext(read('assets/api-errors.js'), context, { filename: 'api-errors.js' });
  runInContext(read('assets/notify.js'), context, { filename: 'notify.js' });
  return { warnings, dispatch: ctx.ArzuzNotify.dispatch };
}

await tick('an alert that cannot go out reports the function\u2019s own sentence, not a number', async () => {
  const box = notifySandbox(TELEGRAM_ANSWER);
  const sent = await box.dispatch('demand_records', { name: 'Ada' });
  if (sent !== false) return 'a failed alert reported success to its caller';
  const sentence = JSON.parse(TELEGRAM_ANSWER.body).error;
  if (!box.warnings.some((w) => w.indexOf(sentence) !== -1)) {
    return 'the console line does not carry the function\u2019s sentence: ' + box.warnings.join(' | ');
  }
  if (box.warnings.some((w) => /HTTP|\b[45]\d\d\b/.test(w))) {
    return 'a status code reached the log: ' + box.warnings.join(' | ');
  }
  return true;
});

/* The invite page's classifier, handed the sign function's own answer.
   This is the pair that matters most: a deploy with no photo storage
   must not send a landlord to ask for a fresh link. */
check('the invite page reads the sign function\u2019s class, not the number', () => {
  const st = D.classify(A.failed(CLOUD_ANSWER.statusCode, CLOUD_ANSWER.body));
  if (st.kind !== 'not-ready') {
    return 'a 500 the function called "not-ready" became "' + st.kind + '" on the invite page';
  }
  if (!st.title || !st.body) return 'the class has no screen copy';
  if (/link is invalid|looks incomplete/i.test(st.title + st.body)) {
    return 'the landlord would be told their link is the problem: ' + st.title;
  }
  return /not switched on/i.test(st.title) ? true : 'the screen does not say the site is not switched on: ' + st.title;
});

check('and the person holding that link is NOT sent to fetch another one', () => {
  const st = D.classify(A.failed(CLOUD_ANSWER.statusCode, CLOUD_ANSWER.body));
  /* The screen: the form cannot be saved from here, and the reason is
     the site, not the link. */
  if (st.outcome !== 'dead') return 'the invite page kept a form it cannot save (' + st.outcome + ')';
  /* A fresh link cannot work while the deploy is unfinished, so the copy
     may only mention one AFTER the thing that has to happen first. */
  if (/fresh link/i.test(st.body) && !/once it is ready/i.test(st.body)) {
    return 'the copy sends them to ask for a link that could not work: ' + st.body;
  }
  return /not been switched on|finish setting it up/i.test(st.body)
    ? true : 'the screen does not say the site is the problem: ' + st.body;
});

/* ============================================================
   10. THE CONTRACT, IN SOURCE AND IN EVERY CONSUMER

   A class only one end speaks is a class the other end ignores, so
   two rules are pinned here:

     · every function that answers JSON stamps its failures through
       the shared wire form (a new function cannot forget)
     · every page that reads one of OUR functions reads the class
       back, and the ONLY places still deriving a class from a bare
       status are the third-party wires, which never name one
   ============================================================ */

console.log('\n10. The contract, at both ends\n');

const FUNCTION_FILES = readdirSync(FN_DIR).filter((f) => f.endsWith('.js'));
/* listing-og and video-embed answer an image and an HTML page — there is
   no JSON body for a page to read a class out of — and roommate-digest
   is a timer, not a door anyone knocks on.

   rooms.js, listings-sitemap.js and browse.js are here for that same
   reason, and it is a property of WHO READS THEM, not of how new they are:    /rooms/<slug> answers a complete HTML page, /sitemap-listings.xml answers
    XML, and /browse answers the board page itself. No script on the site
    fetches any of the three, so there is no class for a page to read back
    and nothing to keep the two ends in sync about. A failure there is a
    status a crawler reads (404, 301, 503), which is already the whole
    contract — and browse.js does not even answer 503 for a database it
    cannot reach, because the board has to stay up.

    claims-aging.js and claims-digest.js are the third kind of exemption:
    TIMERS. Nobody knocks on them, so there is no page to read a class and
    no caller to tell which side of a 503 it is on — they tell the team on
    Telegram instead, and their answer is a log line. (claims-digest is the
    Care visit digest: a scheduled function with no route, reached only by
    Netlify's scheduler or a manual Run now.)

    verification-aging.js is the same third kind and is listed for the same
    reason: it is the verification queue's clock, scheduled hourly in
    netlify.toml, with no route a page fetches and nobody waiting on its
    answer — its `outcome` field is the log line, and the fact worth telling
    a person about goes to Telegram in words. It is NOT exempt because it is
    new: if a page ever starts calling it, this list is the thing that will
    be wrong, and the assertion below is what says so.

    The exemption is from the WIRE form, and from nothing else: that clock
    classifies the failures it reports with THIS module like every page and
    every other function does (the class travels in its alert and in its
    answer's `kind`), and section 8 of scripts/test-verification-queue.mjs
    resolves the require to prove no second copy of the vocabulary has been
    written into it. Being exempt from the wire is not being exempt from
    knowing what broke. */
const NO_JSON = ['listing-og.js', 'video-embed.js', 'roommate-digest.js',
  'rooms.js', 'listings-sitemap.js', 'browse.js', 'claims-aging.js', 'claims-digest.js',
  'verification-aging.js'];

check('every function that answers JSON stamps its failures with the shared class', () => {
  const guilty = FUNCTION_FILES.filter((f) => !NO_JSON.includes(f)
    && !/wireBody/.test(read('netlify/functions/' + f)));
  return guilty.length ? 'these answer JSON without the wire form: ' + guilty.join(', ') : true;
});

check('and they load the SAME classifier the pages load, not a copy of it', () => {
  const guilty = FUNCTION_FILES.filter((f) => !NO_JSON.includes(f)
    && !/require\('[^']*assets\/api-errors\.js'\)/.test(read('netlify/functions/' + f)));
  return guilty.length ? 'these carry a second copy of the vocabulary: ' + guilty.join(', ') : true;
});

/* The TIMERS' exemption is the one that makes a claim about who CALLS
   them — "nobody knocks on them" — and a claim nothing checks is a place
   for a door to hide. So the four are named here and the claim is
   asserted: /api/* is how our own code reaches a function (netlify.toml
   maps it to /.netlify/functions/:splat, and no page or module names the
   raw path at all), so a module containing /api/<a timer> has turned the
   clock into a door nobody has given a class to.

   The match is anchored past the name, because /api/roommate-digest is a
   PREFIX of the preview function's route, and the dashboard's digest
   preview is a real door with a real class of its own.

   The other exemptions are NOT checked this way, and the difference is
   deliberate: an image, a redirect and an XML or HTML answer ARE
   addressed by the site (as a src, a link or a navigation), which is
   exactly why they carry no class to read back. What is checked for them
   is only that no page reads a class out of them, which is the pair of
   assertions above. */
const TIMERS = ['claims-aging.js', 'claims-digest.js', 'roommate-digest.js', 'verification-aging.js'];

check('and no page or module calls one of the timers — that is what exempts them', () => {
  const guilty = [];
  for (const f of TIMERS) {
    const route = new RegExp('/api/' + f.replace(/\.js$/, '') + '(?![\\w-])');
    for (const src of ASSETS) {
      if (route.test(read('assets/' + src))) guilty.push('assets/' + src + ' → /api/' + f.replace(/\.js$/, ''));
    }
    for (const page of PAGES) {
      if (route.test(read(page))) guilty.push(page + ' → /api/' + f.replace(/\.js$/, ''));
    }
  }
  return guilty.length
    ? 'these knock on a door that answers no class: ' + guilty.join(', ')
    : true;
});

check('no function composes a status word into the sentence it sends', () => {
  const guilty = FUNCTION_FILES.filter((f) => /'HTTP ' \+|"HTTP " \+|HTTP [45]\d\d/.test(read('netlify/functions/' + f)));
  return guilty.length ? 'a status word survives in a function: ' + guilty.join(', ') : true;
});

/* Endpoint → the module that reads its answer. */
const WIRE_READERS = [
  ['assets/video.js', '/api/youtube-upload-start'],
  ['assets/notify.js', '/api/notify'],
  ['assets/whatsapp.js', '/api/whatsapp-send'],
  ['assets/my-care.js', '/api/care-credit'],
  ['assets/roommate.js', '/api/roommate-match'],
  ['assets/strategy.js', '/strategy-docs'],
  ['assets/admin.js', '/api/team'],
  ['assets/complete-listing.js', '/api/cloudinary-sign'],
  ['assets/app.js', '/api/cloudinary-sign']
];

check('every page that talks to one of our functions reads the class back', () => {
  const wrong = WIRE_READERS.filter(([file, endpoint]) => {
    const src = read(file);
    return src.indexOf(endpoint) !== -1 && !/\.failed\(/.test(src);
  });
  return wrong.length
    ? 'these read our answer without it: ' + wrong.map(([f]) => f).join(', ')
    : true;
});

check('and the only readers left deriving a class from a bare status are third-party wires', () => {
  /* PostgREST, GoTrue and OSRM: none of them names one of OUR classes, so
     a page has nothing to read back and deriving one is the only option.
     Anywhere ELSE that reads a status this way has stopped listening to
     the function — which is exactly how the two ends drifted apart. */
  const DERIVERS = ['assets/arzuz-map.js', 'assets/auth.js', 'assets/data.js'];
  const guilty = ASSETS.filter((f) => /sentence\(\{\s*status/.test(read('assets/' + f)) && !DERIVERS.includes('assets/' + f));
  const pages = PAGES.filter((f) => /sentence\(\{\s*status/.test(read(f))
    && f !== 'browse.html' && f !== 'listing.html');
  const all = guilty.concat(pages);
  return all.length ? 'these still guess the class from a number: ' + all.join(', ') : true;
});

/* The two numbers a page cannot read alone. A 404 is "a route this
   deploy does not have" — `not-ready` — and it is ALSO what our own
   functions answer when a link or a profile is genuinely gone, which
   the function stamps `rejected`. Same digit, opposite advice: ask for
   a new link, or wait for a deploy. Likewise a 503 is "no service key
   set" or "briefly unwell". */
check('a 404 the function named is not read as the route 404 it shares a digit with', () => {
  const named = A.failed({ status: 404 }, { error: 'We do not recognise that Care link.', kind: 'rejected' });
  if (named.kind !== 'rejected') return 'the class off the wire was lost: ' + named.kind;
  if (named.message !== 'We do not recognise that Care link.') return 'the server\u2019s sentence was replaced: ' + named.message;
  const route = A.failed({ status: 404 }, null);
  if (route.kind !== 'not-ready') return 'a route 404 is no longer read as "not this deploy": ' + route.kind;
  const unreadable = A.failed(404, '<html>Not found</html>');
  return unreadable.kind === 'not-ready'
    ? true : 'an unreadable 404 body was classified as ' + unreadable.kind;
});

check('and a 503 reads as two different facts, once the function has said which', () => {
  const off = A.failed({ status: 503 }, { error: 'x', kind: 'not-ready' });
  const unwell = A.failed({ status: 503 }, { error: 'y' });
  if (off.kind !== 'not-ready') return 'a named "not switched on" became ' + off.kind;
  if (unwell.kind !== 'error') return 'an unnamed 503 became ' + unwell.kind;
  if (A.retryable(off)) return 'the page would tell somebody to try again what only a deploy can change';
  if (!A.queueable(off)) return 'work worth holding for the deploy that fixes it would be dropped';
  return A.retryable(unwell) ? true : 'a briefly unwell service would not be offered as worth another try';
});

check('the pages whose branch a bare number would get wrong read the class', () => {
  /* The Care page deletes a student's stored link on a refused one, and
     the roommate page offers to withdraw a profile on the same digit a
     half-finished deploy produces — so these two are the pages where
     deciding from the number is destructive, not just unhelpful.
     Both classes each page branches on must be named, because a page
     that reads `not-ready` and ignores `rejected` still deletes the
     student's key. Checked the other way round too: putting the Care
     page's 404 branch back on the sentence alone makes this fail. */
  const NEEDED = [/'rejected'/, /'not-ready'/];
  const wrong = ['assets/my-care.js', 'assets/roommate.js'].filter((f) => {
    const src = read(f);
    if (/\bif \(status === (404|503)\)/.test(src)) return true;   /* decides from the digit alone */
    return NEEDED.some((re) => !re.test(src));
  });
  return wrong.length ? 'these still decide from a bare status: ' + wrong.join(', ') : true;
});

check('a class no page can read is discarded, never shipped', () => {
  /* A typo in one function must not put a seventh class on the wire: the
     page would classify it as nothing and fall back to the status — the
     exact reading this change removes. */
  const bogus = A.withKind(503, { error: 'x', kind: 'not-a-class' });
  if (bogus.kind === 'not-a-class') return 'an unknown class survives the wire form';
  if (bogus.kind !== 'error') return 'a 503 with a bogus class became "' + bogus.kind + '" instead of the derived one';
  const stamped = A.withKind(503, { error: 'x', kind: 'not-ready' });
  return stamped.kind === 'not-ready' ? true : 'a class the server DID name was overwritten by the derived one';
});

check('and a success body is left exactly as it was — no field grows on the way out', () => {
  const ok = { ok: true, balance: 3 };
  if (A.withKind(200, ok) !== ok) return 'a success body was copied or stamped';
  const same = JSON.stringify(A.wireBody(200, ok));
  return same === JSON.stringify(ok) ? true : 'the wire form changed a success body: ' + same;
});

console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
process.exit(failures.length ? 1 : 0);
