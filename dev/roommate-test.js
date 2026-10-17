/* ============================================================
   Arzuz — roommates.html, driven headlessly (DEV ONLY)
   Run:  node dev/roommate-test.js

   THE GAP THIS CLOSES

     assets/roommate.js decides in paintError() which of five
     sentences a student reads when the matcher cannot answer, and
     two of those decisions are DESTRUCTIVE: a refused link offers to
     withdraw the profile, and a deployment that has no matching
     service must not. Those branches were walked by hand in a real
     browser once — which proves a thing once — while the Care page
     next to it had a suite. This is that suite: every branch of the
     failure vocabulary (assets/api-errors.js), each one driven end to
     end through a stubbed transport, so the reading of the wire is
     asserted rather than remembered.

   WHAT IT HOLDS THE PAGE TO

     - a failure's class, not its digit, decides the branch: the same
       503 reads "not switched on yet" when the function says
       `not-ready` and something else when it says `error`; a 404 that
       is `not-ready` (a route this deploy does not have) must NOT
       offer to withdraw the student's profile, and a 404 that is
       `rejected` must
     - the digit is still the second signal: with no classifier on the
       page (an older deploy, a page that never loaded the module) the
       old 503 / 404 / 429 ladder still holds, which is what keeps a
       half-finished deploy behaving exactly as it did
     - a request that never arrived is not reported as an outage with
       advice it cannot take
     - the "Loading your matches…" placeholder the page writes before
       it asks is gone when the ask fails — the stale line that told a
       student we were still working on something we had given up on
     - nothing on the screen is a status code, and a hostile sentence
       from the server cannot become markup
     - the page the browser actually gets loads the classifier BEFORE
       the script that consults it, and every container it paints
       exists in the HTML

   The transport is stubbed, not the page: fetch() answers with the
   body a Netlify function would send — { error, kind } — and the real
   assets/api-errors.js reads it back, exactly as in the browser.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------------- tiny test runner ---------------- */

let passed = 0;
const failures = [];

/* A page boot is asynchronous, so every check awaits; a returned
   Promise is not an answer. */
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) {
      passed += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 ' + r);
      console.log('  \u2717 ' + name + '\n      ' + r);
    }
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message));
  }
}

/* ---------------- the DOM the page needs ---------------- */

/* The containers the served page really has; the script paints into
   them and reads some of them back. */
const IDS = ['form', 'rmReturn', 'rmLink', 'rmPanel', 'rmSeeMatches', 'rmStartOver'];

const CACHE = {};
function source(rel) {
  if (!CACHE[rel]) CACHE[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return CACHE[rel];
}

function unescapeHtml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* What the student reads: the markup, with the tags taken off. */
function text(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function makeEl(id) {
  const el = {
    id: id,
    tagName: 'DIV',
    children: [],
    listeners: {},
    style: {},
    value: '',
    textContent: '',
    className: '',
    _innerHTML: '',
    parentElement: null
  };
  el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (c) => { el.children.push(c); return c; };

  /* paintError looks for its own stale placeholder and takes it out
     again, so the panel has to answer both. The element it is handed
     back carries the matched markup, which is what removeChild() then
     strips — a DOM faithful enough for the one query the page makes. */
  el.removeChild = (c) => {
    if (c && c.__match) { el._innerHTML = el._innerHTML.replace(c.__match, ''); return c; }
    const i = el.children.indexOf(c);
    if (i > -1) el.children.splice(i, 1);
    return c;
  };
  /* paintError builds a <div class="rm-err"> off the DOM (the class is
     a property, the sentence is markup) and inserts the NODE, so the
     wrapper the student sees has to be serialized here or the panel
     would hold the sentence without the box around it. */
  el.insertBefore = (child) => {
    const cls = child && child.className ? ' class="' + child.className + '"' : '';
    const html = child && child._innerHTML ? '<div' + cls + '>' + child._innerHTML + '</div>' : '';
    el._innerHTML = html + el._innerHTML;
    return child;
  };
  el.querySelector = (sel) => {
    if (sel !== '.rm-empty') return null;
    const m = /<div class="rm-empty"[^>]*>([\s\S]*?)<\/div>/.exec(el._innerHTML);
    return m ? { textContent: text(m[1]), __match: m[0] } : null;
  };
  el.getAttribute = (k) => el['attr_' + k] || null;
  el.setAttribute = (k, v) => { el['attr_' + k] = String(v); };
  el.focus = () => {};
  el.click = () => {
    (el.listeners.click || []).slice().forEach((fn) => fn({ type: 'click', target: el, preventDefault() {} }));
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); if (el._register) el._register(el._innerHTML); }
  });
  return el;
}

const HOST_GLOBALS = ['Date', 'Number', 'String', 'Object', 'Array', 'JSON', 'Math', 'Promise', 'RegExp',
  'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'Intl', 'Error', 'TypeError', 'Symbol', 'Map', 'Set'];

const TOKEN = 'Kq7Zx3Nv1Bp0LrT8Yw2Uh5Me6Jd4Sg9Ac8Rf7Vo3Ni2Qb1Xt0';

/*
  One page, one scenario. opts:

    stored       what localStorage already holds (the private link)
    search       window.location.search
    path         window.location.pathname
    answer       the transport's answer: { status, body } or a
                 function (body, n) => { status, body }
    networkError an Error to reject with instead (a request that
                 never arrived)
    classifier   false to leave assets/api-errors.js unloaded (the
                 older deploy / the page that never got the module)

  The page boots itself as soon as the script runs, exactly as it does
  in a browser — so a scenario is built by describing the answer, not
  by calling anything. `settle()` awaits the flight it started.
*/
function makePage(opts) {
  opts = opts || {};
  const els = {};
  const dyn = {};

  /* Ids the page paints arrive as markup, so they are registered as
     real elements — otherwise a control the page drew (the retry
     button) would be one the harness could not press. */
  function register(html) {
    const re = /<[^>]*\bid="([^"]+)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
      const id = m[1];
      if (dyn[id] || els[id]) continue;
      const el = makeEl(id);
      el._register = register;
      const val = /value="([^"]*)"/.exec(m[0]);
      if (val) el.value = unescapeHtml(val[1]);
      dyn[id] = el;
    }
  }

  IDS.forEach((id) => {
    els[id] = makeEl(id);
    els[id]._register = register;
    /* The panel starts empty in the served page, and a hidden
       "welcome back" section starts hidden. */
    if (id === 'rmReturn' || id === 'rmLink') els[id].style.display = 'none';
  });

  const requests = [];
  const lines = [];

  function transport(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    requests.push({
      action: body.action,
      body: body,
      url: url,
      headers: (init && init.headers) || {},
      method: (init && init.method) || 'GET'
    });
    if (opts.networkError) return Promise.reject(opts.networkError);
    const spec = typeof opts.answer === 'function'
      ? opts.answer(body, requests.length)
      : (opts.answer || { status: 200, body: { ok: true } });
    return Promise.resolve({
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      text: () => Promise.resolve(JSON.stringify(spec.body === undefined ? null : spec.body))
    });
  }

  const store = Object.assign({}, opts.stored || {});
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };

  const document = {
    readyState: 'complete',
    getElementById: (id) => els[id] || dyn[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => { const el = makeEl('created'); el._register = register; return el; },
    body: makeEl('body'),
    head: makeEl('head')
  };

  const location = {
    search: opts.search || '',
    pathname: opts.path || '/roommates.html',
    origin: 'https://arzuz.com',
    hash: '',
    href: 'https://arzuz.com/roommates.html'
  };

  const sandbox = {
    window: { ARZUZ_CONFIG: { ENV: 'production', SESSION: '2026/2027' }, location: location },
    document: document,
    localStorage: localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: transport,
    Arzuz: { chrome() {}, footer() {} },
    ArzuzSubmit: { showToast: (m, k) => lines.push(['toast', m, k]),
      send: () => Promise.resolve({ ok: true }) },
    console: {
      log: (...a) => lines.push(a),
      warn: (...a) => lines.push(a),
      error: (...a) => lines.push(a)
    },
    Promise: Promise
  };
  HOST_GLOBALS.forEach((g) => { sandbox[g] = globalThis[g]; });

  const ctx = vm.createContext(sandbox);
  vm.runInContext(source('assets/config.js'), ctx, { filename: 'config.js' });
  /* The page loads the vocabulary in this order
     (roommates.html: config.js → api-errors.js → roommate.js) and
     skips it only when a scenario asks for the older deploy — the
     page that never loaded the module. */
  if (opts.classifier !== false) {
    vm.runInContext(source('assets/api-errors.js'), ctx, { filename: 'api-errors.js' });
  }
  vm.runInContext(source('assets/roommate.js'), ctx, { filename: 'roommate.js' });

  const api = sandbox.ArzuzRoommate;

  /* The chain the stub's answer starts (fetch → text → failed →
     paintError) is microtasks only, so one macrotask turn drains it;
     three is headroom, not patience. */
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  return {
    api: api,
    els: els,
    store: store,
    location: location,
    requests: requests,
    lines: lines,
    errors: sandbox.ArzuzApiErrors || null,
    el: (id) => els[id] || dyn[id] || null,
    /* what the student reads in the matches panel */
    panel: () => text(els.rmPanel._innerHTML),
    panelRaw: () => els.rmPanel._innerHTML,
    /* the message shown, with the panel's own "Heads up." heading off */
    message: () => text(els.rmPanel._innerHTML).replace(/^Heads up\.\s*/, '').trim(),
    settle: settle
  };
}

/* A failure the function sent: { error, kind } on the wire, read back
   by the real assets/api-errors.js the same way the browser reads it. */
function failure(status, error, kind) {
  const body = { error: error };
  if (kind) body.kind = kind;
  return { status: status, body: body };
}

/* Every class, and the status a page would see it behind. A class
   added to the vocabulary without a case here must not pass silently,
   which is what the check below the table asserts. */
const STATUS_FOR = {
  'not-ready': 503,
  expired: 401,
  rejected: 404,
  busy: 429,
  error: 500,
  offline: 0
};

const NO_STATUS_CODE = /\b[1-5]\d\d\b/;

function booted(opts) {
  const page = makePage(Object.assign({ stored: { arzuz_roommate_token_v1: TOKEN } }, opts));
  return page.settle().then(() => page);
}

/* ============================================================

   The suite. One async main, because top-level await would make this
   CommonJS file ambiguous.

   ============================================================ */

async function main() {

/* ============================================================
   1. THE TRANSPORT — a failure off the wire reaches the page
   ============================================================ */

console.log('\nroommates.html — a failure off the wire\n');

await t('boot with a stored link asks the matcher for the matches, and nothing else', async () => {
  const page = await booted({ answer: { status: 200, body: { matches: [] } } });
  if (page.requests.length !== 1) return 'the page made ' + page.requests.length + ' request(s)';
  const r = page.requests[0];
  if (r.url !== '/api/roommate-match') return 'posted to ' + r.url;
  if (r.action !== 'matches') return 'the action was ' + r.action;
  if (r.body.token !== TOKEN) return 'the link was not sent';
  if (r.headers['Content-Type'] !== 'application/json') return 'the body is not declared as JSON';
  return true;
});

await t('a 200 with matches renders them, and shows no error at all', async () => {
  const page = await booted({
    answer: {
      status: 200,
      body: {
        matches: [{
          id: 'm1', name: 'Ada', pct: 82, area: 'Malete', budget: 90000,
          reasons: [{ ok: true, text: 'Both sleep early' }],
          my_decision: null, their_decision: null, unlocked: false
        }]
      }
    }
  });
  const said = page.panel();
  if (/Heads up/.test(said)) return 'an error was painted over a good answer: ' + said;
  if (!/Your matches/.test(said)) return 'the list was not rendered: ' + said;
  return /Ada/.test(said) ? true : 'the match is missing from the card: ' + said;
});

await t('the class the function named is what the page reads, not the digit', async () => {
  /* Two facts share 503. The function says which; the page must
     believe it rather than the number. */
  const off = await booted({ answer: failure(503, 'Roommate matching is not switched on for this site yet.', 'not-ready') });
  const unwell = await booted({ answer: failure(503, 'The matcher could not take that just now.', 'error') });
  const a = off.message();
  const b = unwell.message();
  if (!/not switched on/i.test(a)) return 'the not-ready 503 did not read as a deployment that is not switched on: ' + a;
  if (/not switched on/i.test(b)) return 'a briefly unwell matcher was reported as a switch that was never flipped: ' + b;
  if (a === b) return 'the two 503s read the same';
  return true;
});

await t('the server\u2019s own sentence is shown when it is the one that answers', async () => {
  /* A refusal whose class is not one of the three the page names
     falls through to "the server knows which part" — and its own
     sentence is the answer to what was asked. */
  const page = await booted({ answer: failure(401, 'Your roommate session has timed out \u2014 start again.', 'expired') });
  return /timed out/.test(page.message())
    ? true : 'the server\u2019s sentence was lost: ' + page.message();
});

/* ============================================================
   2. EVERY CLASS IN THE VOCABULARY
   ============================================================ */

console.log('\nroommates.html — every class the vocabulary names\n');

/* Held to the vocabulary itself: a seventh class added to
   assets/api-errors.js is a case this suite was not told about, and
   the run says so rather than passing on the classes it remembers. */
await t('this suite has a case for every class in the vocabulary', async () => {
  const page = await booted({ answer: { status: 200, body: { matches: [] } } });
  if (!page.errors) return 'the classifier did not load';
  const missing = Object.keys(page.errors.KINDS).filter((k) => !(k in STATUS_FOR));
  return missing.length
    ? 'the vocabulary grew a class this suite does not drive: ' + missing.join(', ')
    : true;
});

for (const kind of Object.keys(STATUS_FOR)) {
  await t('a ' + kind + ' failure reaches the page as a sentence, with no status code on screen', async () => {
    const page = await booted({ answer: failure(STATUS_FOR[kind], 'The matcher could not answer that.', kind) });
    const said = page.message();
    if (!said) return 'nothing was painted into the panel';
    if (NO_STATUS_CODE.test(said)) return 'a status code is on a student\u2019s screen: ' + said;
    if (/undefined|\[object|Cannot read/.test(said)) return 'an implementation detail reached the screen: ' + said;
    return true;
  });
}

/* A function that forgot to name the class — an older deploy of
   roommate-match, or a body from some other version of it. The
   vocabulary derives `not-ready` from a 404 (a route, table or
   function this deploy does not have), so the destructive branch
   stays shut: the page must not offer to withdraw a profile because
   of a number nobody qualified. */
await t('a 404 that names no class is not read as a refused link', async () => {
  const page = await booted({ answer: { status: 404, body: { error: 'No profile linked to that token.' } } });
  const said = page.message();
  if (/could not find that profile/i.test(said)) return 'a bare 404 was read as a refused profile: ' + said;
  if (!/not switched on yet on this deployment/i.test(said)) return 'the derived class was not honoured: ' + said;
  return page.el('rmAgain') === null
    ? true : 'a bare 404 offered to withdraw the profile on the strength of the digit';
});

/* Offline deserves its own check, because it is not something a
   function can put on the wire: fetch() never returns. */
await t('a request that never arrived is an outage, not a refusal', async () => {
  const page = await booted({ networkError: new TypeError('Failed to fetch') });
  const said = page.message();
  if (!/could not reach the matching service/i.test(said)) return 'the page did not read it as unreachable: ' + said;
  if (/\b4\d\d\b|\b5\d\d\b/.test(said)) return 'a status code is on screen for a request with no status';
  return true;
});

/* ============================================================
   3. THE THREE BRANCHES WHERE THE NUMBER WOULD BE WRONG
   ============================================================ */

console.log('\nroommates.html — the class decides the branch\n');

await t('not-ready says the deploy has no matcher, and offers no way to withdraw the profile', async () => {
  const page = await booted({ answer: failure(503, 'Roommate matching is not switched on for this site yet.', 'not-ready') });
  const said = page.message();
  if (!/not switched on yet on this deployment/i.test(said)) return 'the deployment fact is missing: ' + said;
  if (!/answers are safe/i.test(said)) return 'the student is not reassured about their answers: ' + said;
  return page.el('rmAgain') === null
    ? true : 'a "start a new profile" button was offered for a deployment that has no matcher';
});

await t('rejected says the profile cannot be found, and offers to start a fresh one', async () => {
  const page = await booted({ answer: failure(404, 'No profile is linked to this private link.', 'rejected') });
  const said = page.message();
  if (!/could not find that profile/i.test(said)) return 'the refused link is not explained: ' + said;
  if (/not switched on/i.test(said)) return 'a refused link was reported as a deployment that has not been switched on';
  return page.el('rmAgain') !== null ? true : 'no way to start again from a dead link';
});

await t('busy asks the student to wait, and does not fault the deployment', async () => {
  const page = await booted({ answer: failure(429, 'Too many requests just now.', 'busy') });
  const said = page.message();
  if (!/lot of requests at once/i.test(said)) return 'the rate limit is not explained: ' + said;
  if (/not switched on/i.test(said)) return 'a bad minute was reported as a missing matcher';
  return page.el('rmAgain') === null ? true : 'an offer to withdraw the profile was shown for a rate limit';
});

await t('a 404 that is NOT the matcher keeps the profile: not-ready on a 404 offers nothing', async () => {
  /* The destructive case: a route this deploy does not have yet
     answers 404 too, and its class is `not-ready`. Offering "start a
     fresh one" there would throw away a student's profile because
     the site was mid-deploy. */
  const page = await booted({ answer: failure(404, 'Not found', 'not-ready') });
  const said = page.message();
  if (!/not switched on yet on this deployment/i.test(said)) return 'an undeployed route was read as a refused profile: ' + said;
  if (/could not find that profile/i.test(said)) return 'the page told the student their profile is gone because a deploy was unfinished';
  return page.el('rmAgain') === null
    ? true : 'a half-finished deploy offered to withdraw the profile';
});

await t('a 503 that is `busy` reads as a bad minute, not as a missing matcher', async () => {
  const page = await booted({ answer: failure(503, 'Slow down.', 'busy') });
  const said = page.message();
  if (/not switched on/i.test(said)) return 'a 503 that meant too-many-requests was read as a deployment fact';
  return /lot of requests at once/i.test(said) ? true : 'the busy reading is missing: ' + said;
});

await t('a 5xx gets the page\u2019s own outage line, not the function\u2019s sentence', async () => {
  /* Deliberate, and the one place this page does not repeat the
     server: an outage has its own advice ("your profile is saved")
     and the function's line for a 5xx is a paraphrase of the same
     fact. Pinned so that dropping it — or deciding to show both —
     is a change someone makes on purpose. */
  const page = await booted({ answer: failure(500, 'The matcher could not take that just now.', 'error') });
  const said = page.message();
  if (!/could not reach the matching service/i.test(said)) return 'the outage line is missing: ' + said;
  if (/could not take that just now/.test(said)) return 'the function\u2019s sentence is now being repeated — decide it, not drift into it';
  return /profile is saved/i.test(said) ? true : 'the reassurance that the profile is safe is missing: ' + said;
});

await t('a submission the matcher never accepted does not claim the profile is stored', async () => {
  /* Every scenario above boots with a token, so its failures are about
     MATCHING and the reassurance is true. The questionnaire is the other
     case: wireSubmit() hands paintError `{ saved: false }` because the
     `create` call is what failed, and nothing reached the server. The
     page's own copy used to say "Your answers are safe — the team has
     them" there, which was the one sentence on this page that was simply
     untrue. Driven through the exported paintError because the harness
     has a token, and the RETURN is asserted as well: that value is the
     note the form engine prints, so the panel and the form cannot end up
     saying different things. */
  const page = await booted({ answer: failure(503, 'Roommate matching is not switched on for this site yet.', 'not-ready') });
  const note = page.api.paintError({ status: 503, kind: 'not-ready' }, { saved: false });
  if (!note) return 'paintError returned nothing, so the form engine has no note to show';
  if (/answers are safe|profile is stored|profile is saved/i.test(note)) {
    return 'the copy reassures the student about answers that were never stored: ' + note;
  }
  return /nothing you typed has been sent/i.test(note)
    ? true : 'the student is not told that nothing was sent: ' + note;
});

await t('nor does an outage \u2014 on the submit path, nothing was saved is the whole story', async () => {
  const page = await booted({ answer: failure(500, 'The matcher could not take that just now.', 'error') });
  const note = page.api.paintError({ status: 500, kind: 'error' }, { saved: false });
  if (!/nothing has been saved/i.test(note || '')) return 'an outage told the student their profile is stored: ' + note;
  return /profile is saved on the server/i.test(note)
    ? 'the matching path\u2019s copy leaked into the submit path: ' + note : true;
});

await t('the same 404 digit reads two ways depending only on the class', async () => {
  const refused = await booted({ answer: failure(404, 'No profile is linked to this private link.', 'rejected') });
  const undeployed = await booted({ answer: failure(404, 'Not found', 'not-ready') });
  if (refused.message() === undeployed.message()) return 'the two 404s read identically — the class was ignored';
  return refused.el('rmAgain') !== null && undeployed.el('rmAgain') === null
    ? true : 'the retry affordance does not follow the class';
});

/* ============================================================
   3b. THE HANDOVER — the questionnaire that outlives the matcher

   When /api/roommate-match cannot take the profile, the answers are
   handed to the WAITLIST DOOR instead. It is driven here with a stub
   `orig` rather than through the questionnaire, because the two things
   worth asserting are what it sends and what it does with the answer —
   not the form engine that calls it.
   ============================================================ */

const ANSWERS = { name: 'Grace', phone: '08037654321', area: 'Malete', consent: 'yes', hp: '' };
const MATCHER_DOWN = { status: 500, kind: 'error', message: 'the matcher is unwell' };

await t('the questionnaire is handed to the door as the ROOMMATE form, not as a student registration', async () => {
  /* The form name matters and is the whole point: the door maps only
     'roommate_profiles' onto demand_records with its own question list.
     Posted as 'demand_records' it would meet the student form's required
     age band, which this questionnaire never asks for — which is exactly
     how the old side door came to store nothing. */
  const page = await booted({ answer: failure(500, 'x', 'error') });
  const calls = [];
  const orig = (table, answers) => {
    calls.push({ table: table, answers: answers });
    return Promise.resolve({ ok: true, queued: false, duplicate: false,
      ref: 'ARZ-S-7777-8888-9999', follow_up_status: 'new' });
  };
  await page.api.handOver(orig, ANSWERS, MATCHER_DOWN);

  if (calls.length !== 1) return 'it called the submit layer ' + calls.length + ' times, expected one';
  if (calls[0].table !== 'roommate_profiles') {
    return 'it handed the questionnaire over as "' + calls[0].table + '" \u2014 the door only maps the roommate form';
  }
  return calls[0].answers === ANSWERS ? true : 'the answers it sent are not the ones the student typed';
});

await t('a taken handover says what happened, and gives the reference in both places', async () => {
  const page = await booted({ answer: failure(500, 'x', 'error') });
  const res = await page.api.handOver(
    () => Promise.resolve({ ok: true, queued: false, ref: 'ARZ-S-7777-8888-9999' }),
    ANSWERS, MATCHER_DOWN);

  if (res.ok !== true || res.queued !== false) return 'a stored profile was not reported as stored: ' + JSON.stringify(res);
  if (res.ref !== 'ARZ-S-7777-8888-9999') return 'the reference was not carried back to the page';
  if (!/by hand/.test(res.note || '')) return 'the note does not say the team will match them by hand: ' + res.note;
  if (!/ARZ-S-7777-8888-9999/.test(res.note || '')) return 'the note does not name the reference: ' + res.note;

  /* The panel and the note agree, and the panel is the one inside #rmPanel
     — a SIBLING of #form, because the engine replaces #form with its "your
     profile is in" screen the moment this resolves. A note painted inside
     #form would be erased by the very success it describes. */
  const raw = page.panelRaw();
  if (!/rm-note/.test(raw)) return 'the handover painted no note in the panel';
  if (!/ARZ-S-7777-8888-9999/.test(raw)) return 'the panel does not carry the reference';
  return /private link/.test(raw) ? true : 'the note does not say there is no private link for this one';
});

await t('a doorstep refusal passes the door\u2019s own sentence through, unqueued', async () => {
  const page = await booted({ answer: failure(500, 'x', 'error') });
  const doorNote = 'Arzuz could not accept that \u2014 that is our side, not yours.';
  const res = await page.api.handOver(
    () => Promise.resolve({ ok: false, queued: false, kind: 'rejected', note: doorNote }),
    ANSWERS, MATCHER_DOWN);
  if (res.queued !== false) return 'a refused profile was held as if it would be retried';
  if (res.kind !== 'rejected') return 'the class the door named was lost: ' + res.kind;
  return res.note === doorNote ? true : 'the sentence was paraphrased instead of passed through: ' + res.note;
});

await t('and a door that is not in this deploy means HELD, not refused', async () => {
  /* 'not-ready' is the class the submit layer queues: the answers are kept
     and retried through the same door once the deploy catches up. Reporting
     it as a refusal would throw away a profile that was never even refused. */
  const page = await booted({ answer: failure(500, 'x', 'error') });
  const res = await page.api.handOver(
    () => Promise.resolve({ ok: false, queued: true, kind: 'not-ready',
      note: 'Arzuz has not finished switching this on yet.' }),
    ANSWERS, MATCHER_DOWN);
  if (res.queued !== true) return 'a not-ready door was reported as a loss the student caused';
  return res.kind === 'not-ready' ? true : 'the class was dropped: ' + res.kind;
});

/* ============================================================
   4. THE DIGIT AS THE SECOND SIGNAL (no classifier on the page)
   ============================================================ */

console.log('\nroommates.html — an older deploy, with no classifier loaded\n');

await t('with no classifier, a 503 still reads as "not switched on"', async () => {
  const page = await booted({ classifier: false, answer: { status: 503, body: { error: 'Matcher unavailable.' } } });
  return /not switched on yet on this deployment/i.test(page.message())
    ? true : 'the older reading of 503 was lost: ' + page.message();
});

await t('with no classifier, a 404 still reads as a profile that cannot be found', async () => {
  const page = await booted({ classifier: false, answer: { status: 404, body: { error: 'No profile linked.' } } });
  if (!/could not find that profile/i.test(page.message())) return 'the older reading of 404 was lost: ' + page.message();
  return page.el('rmAgain') !== null ? true : 'the older 404 offered no way to start again';
});

await t('with no classifier, a 429 still reads as a bad minute', async () => {
  const page = await booted({ classifier: false, answer: { status: 429, body: { error: 'Slow down.' } } });
  return /lot of requests at once/i.test(page.message())
    ? true : 'the older reading of 429 was lost: ' + page.message();
});

await t('with no classifier, a 4xx refusal still shows the server\u2019s sentence', async () => {
  const page = await booted({ classifier: false, answer: { status: 409, body: { error: 'You already have a live profile with this link.' } } });
  return /already have a live profile/i.test(page.message())
    ? true : 'the refusal sentence was lost: ' + page.message();
});

await t('with no classifier, a 5xx is still the outage line', async () => {
  const page = await booted({ classifier: false, answer: { status: 500, body: { error: 'boom' } } });
  return /could not reach the matching service/i.test(page.message())
    ? true : 'the older reading of 500 was lost: ' + page.message();
});

/* ============================================================
   5. THE RETRY AFFORDANCE DOES WHAT IT SAYS
   ============================================================ */

console.log('\nroommates.html — starting again\n');

await t('the "start a new profile" button on a dead link clears the link and leaves the page', async () => {
  const page = await booted({ answer: (body) => body.action === 'withdraw'
    ? { status: 200, body: { ok: true } }
    : failure(404, 'No profile is linked to this private link.', 'rejected') });
  const btn = page.el('rmAgain');
  if (!btn) return 'the button was not there to press';
  btn.click();
  await page.settle();
  if (page.store.arzuz_roommate_token_v1 !== undefined) {
    return 'the dead link was kept in storage and will be retried forever';
  }
  return /roommates/.test(page.location.href)
    ? true : 'the page did not leave for a fresh questionnaire: ' + page.location.href;
});

await t('and it asks the server to withdraw the profile rather than only forgetting it', async () => {
  const page = await booted({ answer: (body) => body.action === 'withdraw'
    ? { status: 200, body: { ok: true } }
    : failure(404, 'No profile is linked to this private link.', 'rejected') });
  const before = page.requests.length;
  page.el('rmAgain').click();
  await page.settle();
  const sent = page.requests.slice(before).filter((r) => r.action === 'withdraw');
  if (!sent.length) return 'the profile was abandoned locally without telling the server';
  return sent[0].body.token === TOKEN ? true : 'the withdraw was not sent with the student\u2019s own link';
});

/* ============================================================
   6. THE PLACEHOLDER
   ============================================================ */

console.log('\nroommates.html — the line the page leaves behind\n');

await t('after the page fails, the "Loading your matches…" line is gone', async () => {
  const page = await booted({ answer: failure(503, 'Matcher unavailable.', 'not-ready') });
  const raw = page.panelRaw();
  if (/Loading your matches/.test(raw)) return 'a failed ask left the student reading that we are still working on it';
  if (!/Heads up/.test(raw)) return 'the error was not shown at all: ' + raw.slice(0, 160);
  if ((raw.match(/class="rm-err"/g) || []).length !== 1) return 'more than one error box was added: ' + raw;
  return true;
});

await t('and a good answer leaves no placeholder and no error either', async () => {
  const page = await booted({ answer: { status: 200, body: { matches: [] } } });
  const raw = page.panelRaw();
  if (/Loading your matches/.test(raw)) return 'a successful ask left the loading line in place';
  return /Nobody compatible yet/.test(text(raw)) ? true : 'an empty pool was not explained: ' + text(raw);
});

/* ============================================================
   7. WHAT MUST NOT REACH THE SCREEN
   ============================================================ */

console.log('\nroommates.html — the things that must never reach the screen\n');

await t('a hostile sentence from the server cannot become markup', async () => {
  const nasty = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const page = await booted({ answer: failure(401, nasty, 'expired') });
  const raw = page.panelRaw();
  if (/<img src=x|<\/script>|<script>/.test(raw)) return 'unescaped markup reached the page';
  if (raw.indexOf('&lt;img') === -1) return 'the hostile text did not arrive at all — the check is vacuous';
  return true;
});

await t('no status code is ever shown to the student, in any branch', async () => {
  for (const kind of Object.keys(STATUS_FOR)) {
    const page = await booted({ answer: failure(STATUS_FOR[kind], 'The matcher could not answer that.', kind) });
    if (NO_STATUS_CODE.test(page.message())) return 'the ' + kind + ' branch printed a status code: ' + page.message();
  }
  const plain = await booted({ classifier: false, answer: { status: 500, body: { error: 'boom 500' } } });
  /* The server's own sentence may contain anything; the page's own
     copy must not. What is asserted is the copy the page contributes,
     which is why the branches above carry a clean sentence. */
  return plain.message().length > 0 ? true : 'nothing was painted for a bare 500';
});

/* ============================================================
   8. THE PAGE'S OWN SOURCE
   ============================================================ */

console.log('\nroommates.html — the source is checked, not trusted\n');

await t('the page branches on the class, and keeps the digit only as the fallback', async () => {
  const src = source('assets/roommate.js');
  for (const kind of ['not-ready', 'rejected', 'busy']) {
    if (src.indexOf("kind === '" + kind + "'") === -1) {
      return 'the page does not name the "' + kind + '" class it must branch on';
    }
  }
  if (/\bif \(status === (404|429|503)\)/.test(src)) return 'a branch decides from the bare digit alone';
  return /err\.kind/.test(src) ? true : 'the page never reads the class off the error';
});

await t('the page reads the class back off the wire through the shared vocabulary', async () => {
  const src = source('assets/roommate.js');
  if (!/ArzuzApiErrors/.test(src)) return 'the page does not consult the shared classifier';
  return /W\.failed\(r, data\)/.test(src)
    ? true : 'the page builds its own error instead of reading the function\u2019s answer back';
});

/* ============================================================
   9. THE PAGE THE BROWSER ACTUALLY GETS
   ============================================================ */

console.log('\nroommates.html — the file itself\n');

await t('the page loads the classifier before the script that consults it', async () => {
  const html = source('roommates.html');
  const errors = html.indexOf('assets/api-errors.js');
  const page = html.indexOf('assets/roommate.js');
  if (errors === -1) return 'the page never loads the classifier';
  if (page === -1) return 'the page never loads its own script';
  return errors < page ? true : 'roommate.js runs before api-errors.js, so the class is never read';
});

await t('every container the script paints exists in the HTML', async () => {
  const html = source('roommates.html');
  const missing = IDS.filter((id) => html.indexOf('id="' + id + '"') === -1);
  return missing.length ? 'the script paints ids the page does not have: ' + missing.join(', ') : true;
});

await t('the scripts the page loads all exist', async () => {
  const html = source('roommates.html');
  const srcs = (html.match(/src="(assets\/[^"]+)"/g) || [])
    .map((m) => m.slice(5, -1).split('?')[0]);
  const missing = srcs.filter((s) => !fs.existsSync(path.join(ROOT, s)));
  return missing.length ? 'missing scripts: ' + missing.join(', ') : true;
});

/* ------------------------------------------------------------ */

console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
process.exit(failures.length ? 1 : 0);

}

main().catch((err) => {
  console.error('[roommate-test] ' + (err && err.stack || err));
  process.exit(1);
});
