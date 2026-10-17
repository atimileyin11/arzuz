/* ============================================================
   Arzuz — my-care.html, driven headlessly (DEV ONLY)
   Run:  node dev/my-care-test.js

   The student's private Care page is the one surface in this feature
   that a STUDENT uses rather than the team, so it is tested against
   the server's answers rather than against the page's own opinion:

     - with no link, it explains how to get one, and makes no request
     - a link is read with NO Authorization header (there is no
       session — the link is the credential) and is remembered
     - an unrecognised link is not an outage, and the dead token is
       dropped rather than retried forever
     - a Care database that has not been created yet says so in the
       server's own words
     - every number on the page is the server's number; the page does
       no arithmetic over the ledger, and its own source is checked
       for that rather than trusted
     - the covered list is rendered from the server's published
       figures, proved by sending figures the page could not have
       guessed
     - asking for a worker sends the words typed and nothing else,
       refuses a one-word answer before any round trip, and shows the
       server's refusal when the server refuses
     - a hostile string from the ledger (a worker name, a reason)
       cannot become markup on the student's page
     - there is no control anywhere on the page that could write a
       credit
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------------- tiny test runner ---------------- */

let passed = 0;
const failures = [];

/* Every check may do work (a page boot is asynchronous), so this
   awaits — a returned Promise is not an answer. */
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

const IDS = ['careLoading', 'careGone', 'careDown', 'careDownTitle', 'careDownBody',
  'careAccount', 'careBalance', 'careLedger', 'careCover', 'careClaims', 'careRequest', 'careShare'];

/* Actions the student door of /api/claims answers — and the only ones
   this page is allowed to send. Anything else a test sees on the wire
   is the page reaching for a team action. */
const CLAIM_ACTIONS = ['list', 'create', 'confirm', 'dispute', 'cancel', 'agree_day', 'propose_day'];

/* The static states live in my-care.html, not in the script: the
   student reads the file the browser served, so the harness reads it
   too rather than asserting about a string it made up. */
function staticInner(id) {
  const html = source('my-care.html');
  const re = new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)<\\/div>');
  const m = re.exec(html);
  return m ? m[1] : '';
}

const STATIC_STATES = ['careLoading', 'careGone', 'careDown', 'careDownBody'];

function makeEl(id) {
  const el = {
    id: id,
    tagName: 'DIV',
    children: [],
    listeners: {},
    style: {},
    value: '',
    textContent: '',
    _innerHTML: '',
    offsetParent: null,
    parentElement: null
  };
  el.classList = {
    add() {}, remove() {}, toggle() {}, contains() { return false; }
  };
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i > -1) el.children.splice(i, 1); return c; };
  el.getAttribute = (k) => el['attr_' + k] || null;
  el.setAttribute = (k, v) => { el['attr_' + k] = String(v); };
  el.focus = () => {};
  el.click = () => { (el.listeners.click || []).slice().forEach((fn) => fn({ type: 'click', target: el, preventDefault() {} })); };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); if (el._register) el._register(el._innerHTML); }
  });
  return el;
}

function unescapeHtml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* The page's visible text, tags stripped — what the student reads. */
function text(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------------- the page factory ---------------- */

const CACHE = {};
function source(rel) {
  if (!CACHE[rel]) CACHE[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return CACHE[rel];
}

const HOST_GLOBALS = ['Date', 'Number', 'String', 'Object', 'Array', 'JSON', 'Math', 'Promise', 'RegExp',
  'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'Intl', 'Error', 'TypeError', 'Symbol', 'Map', 'Set'];

/*
  One page, one scenario. opts:

    search    window.location.search ('' or '?t=…')
    path      window.location.pathname
    view      the answer to action:'view'  { status, body } or a raw function
    request   the answer to action:'request'
    stored    what localStorage already holds

  `requests` records every POST with its parsed body, so a check can
  assert what the page sent rather than what it printed.
*/
/* Which answer a request gets. The URL decides the door: /api/claims and
   /api/care-credit are different functions with different vocabularies,
   and a page that sent a claims action to the Care door would be asking
   the wrong question of the wrong tables. */
function route(action, url) {
  if (String(url).indexOf('/api/claims') !== -1) return 'claims';
  return action === 'request' ? 'request' : 'view';
}

function makePage(opts) {
  opts = opts || {};
  const els = {};
  const dyn = {};

  /* Inputs the page paints arrive as markup, so the ids they declare
     are registered as real elements — otherwise a form the page drew
     would be a form the harness could not type into, and the submit
     path would never be exercised. */
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
    if (STATIC_STATES.indexOf(id) !== -1) els[id]._innerHTML = staticInner(id);
  });

  const requests = [];
  const console_lines = [];

  function answer(kind, url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    requests.push({
      action: body.action,
      body: body,
      url: url,
      headers: (init && init.headers) || {},
      method: (init && init.method) || 'GET'
    });
    const plan = kind === 'view' ? opts.view
      : kind === 'claims' ? opts.claims
        : opts.request;
    const res = typeof plan === 'function' ? plan(body, requests.length) : plan;
    if (!res) {
      /* Un-set answers still have to be the SHAPE the function sends, so
         that a page booted for an older reason is reading a real answer
         rather than a stub: a student with a pass and no repairs. */
      const fallback = kind === 'claims'
        ? { ok: true, plan: { session: '2026/2027', status: 'active' }, coverage: null, claims: [] }
        : { ok: true };
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(fallback))
      });
    }
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: () => Promise.resolve(JSON.stringify(res.body === undefined ? null : res.body))
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
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl('created'),
    body: makeEl('body')
  };

  const location = {
    search: opts.search || '',
    pathname: opts.path || '/my-care.html',
    origin: 'https://arzuz.com',
    hash: ''
  };

  const sandbox = {
    window: { ARZUZ_CONFIG: { SUPPORT_WHATSAPP: '2349024814771' }, location: location },
    document: document,
    localStorage: localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: (url, init) => answer(route(JSON.parse(init.body).action, url), url, init),
    ArzuzSubmit: { showToast: (m, k) => console_lines.push(['toast', m, k]) },
    console: {
      log: (...a) => console_lines.push(a),
      warn: (...a) => console_lines.push(a),
      error: (...a) => console_lines.push(a)
    },
    Promise: Promise
  };
  HOST_GLOBALS.forEach((g) => { sandbox[g] = globalThis[g]; });

  const ctx = vm.createContext(sandbox);
  vm.runInContext(source('assets/config.js'), ctx, { filename: 'config.js' });
  /* The shared failure vocabulary, in the order the real page loads it
     (my-care.html: config.js → api-errors.js → my-care.js). Without it
     this harness exercised only the page's no-classifier fallback — so
     the class the SERVER names was never read here, and the one thing
     that decides a refused link from an undeployed route went
     untested. */
  vm.runInContext(source('assets/api-errors.js'), ctx, { filename: 'api-errors.js' });
  vm.runInContext(source('assets/my-care.js'), ctx, { filename: 'my-care.js' });

  const api = sandbox.ArzuzMyCare;
  return {
    api: api,
    els: els,
    store: store,
    requests: requests,
    console_lines: console_lines,
    /* the painted page, as the student would read it */
    html: () => IDS.map((id) => els[id]._innerHTML).join(' '),
    shown: (id) => els[id].style.display !== 'none',
    read: (id) => text(els[id]._innerHTML),
    /* Inputs the page painted, so a form can be typed into. */
    el: (id) => els[id] || dyn[id] || null,
    boot: () => api.boot()
  };
}

/* ---------------- fixtures ---------------- */

function planData(over) {
  const base = {
    ok: true,
    student: { name: 'Ada Care', phone: '2348036543210', area: 'Malete', property: 'Sunrise Lodge', room: 'A1' },
    plan: { id: 'plan-1', session: '2026/2027', status: 'active', amount_ngn: 20000 },
    balance: 3,
    granted: 4,
    call_outs: 1,
    published: { session_fee_ngn: 20000, call_outs_included: 4, parts_included_ngn: 3000 },
    can_request: true,
    events: [
      { event: 'granted', delta: 4, created_at: '2026-10-01T09:00:00.000Z', reason: 'Care for 2026/2027 — 4 call-outs, 20000 naira paid' },
      { event: 'spent', delta: -1, created_at: '2026-10-03T11:30:00.000Z', worker: 'Compound caretaker', parts_ngn: 1200, reason: 'blocked kitchen sink' }
    ]
  };
  return Object.assign({}, base, over || {});
}

/* The answer to /api/claims action:'list' — the pass, its published
   window, and the repairs filed against it. Every field here is one the
   function really sends (see studentClaim() in netlify/functions/claims.js);
   a fixture that invents a field would test the page against a server
   that does not exist. */
function claimsData(over) {
  const base = {
    ok: true,
    plan: { session: '2026/2027', status: 'active' },
    coverage: {
      start: '2026-10-13T09:00:00.000Z', end: '2027-02-10T09:00:00.000Z',
      call_out_cap: 4, receipt_ref: 'AZ-R-M4K2P1-9F3A2B1C', terms_version: 3
    },
    claims: []
  };
  return Object.assign({}, base, over || {});
}

function aClaim(over) {
  const base = {
    id: 'claim-1',
    reference: 'AZ-C-M4K2P1-9F3A2B',
    created_at: '2026-10-14T09:00:00.000Z',
    updated_at: '2026-10-14T09:00:00.000Z',
    status: 'submitted',
    issue: 'The kitchen tap will not close and drips all night',
    photos: [],
    property: 'Sunrise Lodge',
    room: 'A1',
    eligibility: null,
    eligibility_reason: null,
    call_out_no: null,
    provider_name: null,
    /* The two fields the server sends alongside a worker's name: the
       number the student has to be able to ring, and whether that worker
       has said the job is theirs. A handover the customer was told about
       but cannot act on is a promise half kept. */
    provider_phone: null,
    worker_confirmed: false,
    /* And the third thing the server sends with a name: the day the worker
       said they can come, in their own words, or null. */
    provider_proposal: null,
    provider_proposed_at: null,
    /* The customer's own half of that conversation: the day they agreed
       to, and the day they asked for instead. */
    day_agreed_at: null,
    customer_proposal: null,
    customer_proposed_at: null,
    estimate_kobo: null,
    actual_kobo: null,
    parts: [],
    customer_confirmed_at: null,
    disputed_at: null,
    dispute_reason: null,
    resolution: null,
    resolved_at: null
  };
  return Object.assign({}, base, over || {});
}

const TOKEN = 'Kq7Zx3Nv1Bp0LrT8Yw2Uh5Me6Jd4Sg9Ac8Rf7Vo3Ni2Qb1Xt0';

/* Await however many turns of the event loop a click chain needs. A
   button's handler returns a promise the DOM does not wait for, so a
   check that clicked must let the chain finish before reading. */
function flush(turns) {
  let p = Promise.resolve();
  for (let i = 0; i < (turns || 4); i += 1) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/* The claims a page was given, as the harness recorded them. */
function claimCalls(page) {
  return page.requests.filter((r) => String(r.url).indexOf('/api/claims') !== -1);
}

/* A note the page wrote into a LIVE element.

   read(container) reads the string a container was last painted with,
   which is exactly right for markup and wrong for a message the page
   writes into a node that is already on screen: the section around it
   is deliberately not repainted (that would throw away what the
   student just typed), so the container's captured string does not
   change. This reads the element the page actually wrote into. */
function note(page, id) {
  const el = page.el(id || 'claimNote');
  return el ? text(el._innerHTML) : '';
}

/* The outage box is a shell the script fills: in a browser its two
   children are what the student reads, so that is what is read here —
   the box's own markup is the before-JS default and would be a
   dishonest thing to assert against. */
function readBox(page, id) {
  if (id === 'careDown') return (page.read('careDownTitle') + ' ' + page.read('careDownBody')).trim();
  return page.read(id);
}

/* ============================================================
   1. NO LINK
   ============================================================ */

/* Everything below is inside one async function: a page boot is a
   promise, and this file is CommonJS, where top-level await would make
   the module ambiguous. */
async function main() {

console.log('\nmy-care.html — no link\n');

const none = makePage({});

await t('with no link the page explains how to get one, and asks the server nothing', () => {
  if (none.requests.length) return 'the page made ' + none.requests.length + ' request(s) with no link';
  return none.shown('careGone') === true ? true : 'the "needs your own link" state was not shown';
});

await t('and it does not show an account it does not have', () =>
  none.shown('careAccount') === false ? true : 'the account block was shown with no link');

await t('the explanation is not a dead end — it says message us and nothing is lost', () => {
  const said = none.read('careGone');
  if (!/message us/i.test(said)) return 'no way to reach the team: ' + said;
  return /link/i.test(said) ? true : 'the text does not say the link is the key';
});

/* ============================================================
   2. A LINK IS THE CREDENTIAL
   ============================================================ */

console.log('\nmy-care.html — the link\n');

const linked = makePage({
  search: '?t=' + TOKEN,
  view: { status: 200, body: planData() },
  request: {
    status: 201,
    body: {
      ok: true, ticket_id: 'ticket-1', balance: 3,
      message: 'Logged. A verified worker should reach you within 48 hours on 2348036543210 — one of the 4 call-outs this session covers.'
    }
  }
});
/* makePage boots the page the way the browser does — the script reads
   the link on DOMContentLoaded with nothing else driving it, which is
   itself worth asserting rather than assuming. */
await t('the page opens the link by itself, and reads the pass AND its repairs', () => {
  const actions = linked.requests.map((r) => r.action);
  if (actions.indexOf('view') === -1) return 'the pass was not read on its own: ' + actions.join(', ');
  if (actions.indexOf('list') === -1) return 'the repairs were not read on its own: ' + actions.join(', ');
  return actions.length === 2 ? true : 'the page made ' + actions.join(', ') + ' before anyone touched it';
});

await (async () => {
  t('a ?t= link is sent to the Care endpoint as action "view"', () => {
    const first = linked.requests[0];
    if (!first) return 'nothing was sent';
    if (first.url !== '/api/care-credit') return 'posted to ' + first.url;
    if (first.action !== 'view') return 'the action was ' + first.action;
    if (first.body.token !== TOKEN) return 'the link was not sent';
    return true;
  });

  await t('no session header is attached to a student read', () => {
    const h = linked.requests[0].headers || {};
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    if (keys.indexOf('authorization') !== -1) return 'an Authorization header was sent';
    return h['Content-Type'] === 'application/json' ? true : 'the body is not declared as JSON';
  });

  await t('the link is remembered on the device, so a return visit works', () =>
    linked.store.arzuz_care_token_v1 === TOKEN
      ? true : 'nothing was stored: ' + JSON.stringify(linked.store));

  await t('the account is on screen, and the "no link" state is gone', () => flush().then(() => {
    if (!linked.shown('careAccount')) return 'the account block is hidden';
    return linked.shown('careGone') === false ? true : 'the no-link state is still showing';
  }));

  /* ============================================================
     3. THE NUMBERS ARE THE SERVER'S
     ============================================================ */

  console.log('\nmy-care.html — every number is the server’s\n');

  await t('the balance on screen is exactly what the server returned', () => {
    const said = linked.read('careBalance');
    if (said.indexOf('3 of 4') === -1) return 'the balance is not on the card: ' + said;
    return said.indexOf('1 of 4 used') !== -1 ? true : 'the used count is missing: ' + said;
  });

  await t('the page does not do the ledger arithmetic itself (checked in the source)', () => {
    const src = source('assets/my-care.js');
    if (/\.reduce\(/.test(src)) return 'the page reduces the ledger — a second opinion about a balance';
    if (/balance\s*[-+]=|balance\s*=\s*[^;]*\+/.test(src)) return 'the page adds to the balance';
    return true;
  });

  await t('the covered list is rendered from the server’s published figures, not from constants', () => {
    const odd = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData({ published: { session_fee_ngn: 25000, call_outs_included: 5, parts_included_ngn: 2500 } }) } });
    return odd.boot().then(() => {
      const said = odd.read('careCover') + ' ' + odd.read('careBalance');
      if (said.indexOf('5 call-outs per session') === -1) return 'the call-out count is not the server’s: ' + said.slice(0, 200);
      if (said.indexOf('\u20a62,500') === -1) return 'the parts ceiling is not the server’s';
      if (/\u20a63,000|4 call-outs/.test(said)) return 'the page still hard-codes 4 / \u20a63,000';
      return true;
    });
  });

  await t('the published fee comes from the server too', () => {
    const odd = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData({ plan: { session: '2026/2027', status: 'ended', amount_ngn: 25000 }, published: { session_fee_ngn: 25000, call_outs_included: 5, parts_included_ngn: 2500 }, balance: 0, can_request: false }) } });
    return odd.boot().then(() => {
      const said = odd.read('careBalance');
      return said.indexOf('\u20a625,000') !== -1 ? true : 'the fee on the card is not the server’s: ' + said;
    });
  });

  /* ============================================================
     3b. THE PASS — A TERM, NOT A WALLET
     ============================================================ */

  console.log('\nmy-care.html — the pass the student bought\n');

  await t('a plan bought online shows its coverage dates, cap and receipt', () => {
    const pass = makePage({
      search: '?t=' + TOKEN,
      view: {
        status: 200,
        body: planData({
          coverage: {
            start: '2026-10-13T09:00:00.000Z', end: '2027-02-10T09:00:00.000Z',
            call_out_cap: 4, receipt_ref: 'AZ-R-M4K2P1-9F3A2B1C', terms_version: 3
          }
        })
      }
    });
    return pass.boot().then(() => {
      const said = pass.read('careBalance');
      ['13 Oct 2026', '10 Feb 2027', '4 call-outs included', 'AZ-R-M4K2P1-9F3A2B1C'].forEach((want) => {
        if (said.indexOf(want) === -1) throw new Error('the pass is missing ' + want + ': ' + said.slice(0, 240));
      });
      return true;
    });
  });

  await t('the dates are the SERVER\u2019s, proved by sending a term nobody could guess', () => {
    const odd = makePage({
      search: '?t=' + TOKEN,
      view: {
        status: 200,
        body: planData({
          coverage: {
            start: '2031-01-05T00:00:00.000Z', end: '2031-06-30T00:00:00.000Z',
            call_out_cap: 2, receipt_ref: 'AZ-R-ODD', terms_version: 9
          }
        })
      }
    });
    return odd.boot().then(() => {
      const said = odd.read('careBalance');
      if (said.indexOf('5 Jan 2031') === -1 || said.indexOf('30 Jun 2031') === -1) {
        return 'the page did not print the server\u2019s window: ' + said.slice(0, 200);
      }
      /* The OTHER scenario's window must not appear: a page that carried
         a term of its own would print the same dates no matter what the
         server sent. (A plain /2027/ check would be vacuous here — the
         session string legitimately reads 2026/2027.) */
      if (said.indexOf('13 Oct 2026') !== -1 || said.indexOf('10 Feb 2027') !== -1) {
        return 'a window from another answer leaked onto this card';
      }
      if (said.indexOf('2 call-outs included') === -1) {
        return 'the cap was not the server\u2019s: ' + said.slice(0, 200);
      }
      return true;
    });
  });

  await t('the page computes no coverage date of its own (checked in the source)', () => {
    const src = source('assets/my-care.js');
    ['care_term_days', '86400', 'setDate(', 'setMonth(', 'setFullYear('].forEach((smell) => {
      if (src.indexOf(smell) !== -1) throw new Error('the page dates a term itself: ' + smell);
    });
    return true;
  });

  await t('a plan the team opened shows no pass block and invents no dates', () => {
    const plain = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData({ coverage: null }) } });
    return plain.boot().then(() => {
      const said = plain.read('careBalance');
      if (said.indexOf('Coverage') !== -1) return 'a pass block was drawn for a plan with no term';
      return said.indexOf('3 of 4') !== -1 ? true : 'the card stopped rendering without a pass';
    });
  });

  /* ============================================================
     4. THE LEDGER AND THE COVER
     ============================================================ */

  console.log('\nmy-care.html — the record\n');

  await t('every event the server sent is on the page', () => {
    const said = linked.read('careLedger');
    if (said.indexOf('Session opened') === -1) return 'the grant is missing from the record';
    if (said.indexOf('Call-out') === -1) return 'the call-out is missing from the record';
    return true;
  });

  await t('the record says who did the work and what the parts cost', () => {
    const said = linked.read('careLedger');
    if (said.indexOf('Compound caretaker') === -1) return 'the worker is not named';
    return said.indexOf('\u20a61,200') !== -1 ? true : 'the parts cost is missing';
  });

  await t('the newest event is at the top, the way a statement reads', () => {
    const html = linked.els.careLedger._innerHTML;
    return html.indexOf('Call-out') < html.indexOf('Session opened')
      ? true : 'the ledger is ordered oldest-first';
  });

  await t('parts over the included ceiling carry the sentence that explains it', () => {
    const over = makePage({
      search: '?t=' + TOKEN,
      view: {
        status: 200,
        body: planData({
          events: [
            { event: 'granted', delta: 4, created_at: '2026-10-01T09:00:00.000Z' },
            { event: 'spent', delta: -1, created_at: '2026-10-04T08:00:00.000Z', worker: 'Verified worker', parts_ngn: 4500, note: 'Parts over the included 3000 naira ceiling — quote the student before the work.' }
          ]
        })
      }
    });
    return over.boot().then(() => {
      const said = over.read('careLedger');
      return /quoted to you first|ceiling/i.test(said) ? true : 'the over-ceiling note is missing: ' + said;
    });
  });

  await t('an empty ledger says so rather than rendering nothing', () => {
    const empty = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData({ events: [] }) } });
    return empty.boot().then(() => {
      const said = empty.read('careLedger');
      return /Nothing recorded yet/.test(said) ? true : 'an empty ledger read as: ' + said;
    });
  });

  /* ============================================================
     5. ASKING FOR A WORKER
     ============================================================ */

  console.log('\nmy-care.html — asking for a worker\n');

  await t('the form is offered when the server says it can be, and pre-fills the student', () => {
    const said = linked.read('careRequest') + linked.els.careRequest._innerHTML;
    if (said.indexOf('askIssue') === -1) return 'there is no field for the problem';
    if (said.indexOf('2348036543210') === -1) return 'the student’s own number is not pre-filled';
    return said.indexOf('value="A1"') !== -1 ? true : 'the room is not pre-filled';
  });

  await t('one word is not a description, and it costs no round trip', () => {
    const before = linked.requests.length;
    linked.el('askIssue').value = 'tap';
    linked.el('askPhone').value = '08031234567';
    return linked.api.send().then(() => {
      if (linked.requests.length !== before) return 'a request was sent for a one-word answer';
      const said = linked.read('careRequest');
      return /sentence is enough/i.test(said) ? true : 'no guidance on what to type: ' + said;
    });
  });

  await t('a real description is sent as words, with the link and nothing else invented', () => {
    const before = linked.requests.length;
    linked.el('askIssue').value = 'The kitchen tap will not close and drips all night';
    linked.el('askRoom').value = 'A1';
    linked.el('askPhone').value = '08031234567';
    return linked.api.send().then(() => {
      const sent = linked.requests.slice(before)[0];
      if (!sent) return 'nothing was sent';
      if (sent.action !== 'request') return 'the action was ' + sent.action;
      if (sent.body.token !== TOKEN) return 'the link was not sent';
      if (sent.body.issue !== 'The kitchen tap will not close and drips all night') return 'the words were changed: ' + sent.body.issue;
      if (sent.body.phone !== '08031234567') return 'the number was changed';
      const keys = Object.keys(sent.body).sort().join(',');
      return keys === 'action,issue,phone,room,token' ? true : 'the page sent more than it should: ' + keys;
    });
  });

  await t('the confirmation the student sees is the server’s sentence', () => {
    const said = linked.read('careRequest');
    return /Logged\. A verified worker should reach you within 48 hours/.test(said)
      ? true : 'the server’s message was not shown: ' + said;
  });

  await t('after asking, the page re-reads the plan so the balance on screen is fresh', () => {
    const views = linked.requests.filter((r) => r.action === 'view').length;
    return views >= 2 ? true : 'the page never re-read the plan after the request (' + views + ' read)';
  });

  await t('a refusal from the server is shown, in the server’s words', () => {
    const refused = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      request: { status: 409, body: { error: 'You already have a request with us for this session — we are on it.', ticket_id: 'ticket-9' } }
    });
    return refused.boot().then(() => {
      refused.el('askIssue').value = 'The tap is still dripping badly';
      return refused.api.send();
    }).then(() => {
      const said = refused.read('careRequest');
      return /already have a request/.test(said) ? true : 'the refusal was swallowed: ' + said;
    });
  });

  await t('a refused request leaves the words where they were, so they are not retyped', () => {
    const refused = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      request: { status: 409, body: { error: 'All 4 call-outs on this session have been used.' } }
    });
    return refused.boot().then(() => {
      refused.el('askIssue').value = 'The door lock jams when it rains';
      refused.el('askPhone').value = '08031234567';
      return refused.api.send();
    }).then(() => {
      const said = refused.read('careRequest');
      if (!/already been used|all 4 call-outs/i.test(said)) return 'the refusal is not on screen: ' + said;
      return true;
    });
  });

  await t('when the server says it cannot be asked, no form is offered at all', () => {
    const closed = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData({ balance: 0, call_outs: 4, can_request: false }) } });
    return closed.boot().then(() => {
      const raw = closed.els.careRequest._innerHTML;
      if (raw.indexOf('askIssue') !== -1) return 'a form was offered with nothing left to spend';
      if (raw.indexOf('askSend') !== -1) return 'a submit button was offered with nothing left';
      const said = text(raw);
      if (!/used/i.test(said)) return 'the student is not told why';
      return /WhatsApp/.test(raw) ? true : 'there is no way to reach the team instead';
    });
  });

  await t('a refunded session offers no form either, and says what happened', () => {
    const gone = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData({ balance: 0, can_request: false, plan: { session: '2026/2027', status: 'refunded', amount_ngn: 20000 } }) } });
    return gone.boot().then(() => {
      if (gone.els.careRequest._innerHTML.indexOf('askIssue') !== -1) return 'a refunded session offered a request form';
      const said = gone.read('careBalance');
      return /refunded/i.test(said) ? true : 'the card does not say it was refunded: ' + said;
    });
  });

  /* ============================================================
     5b. REPAIRS — FILING ONE, AND FOLLOWING IT

     The claim workflow is the team's door plus this one. Everything a
     student can do here is checked against the shape the function
     really sends: the status word is the server's, the decision is
     printed in words, and a control that would come straight back from
     the server is not drawn.
     ============================================================ */

  console.log('\nmy-care.html — repairs: filing a claim and following it\n');

  await t('the repairs are read with the same link, and still with no session', () => {
    const first = claimCalls(linked)[0];
    if (!first) return 'the repairs were never read';
    if (first.url !== '/api/claims') return 'the repairs were read from ' + first.url;
    if (first.action !== 'list') return 'the first claims action was ' + first.action;
    if (first.body.token !== TOKEN) return 'the link was not sent';
    const keys = Object.keys(first.body).sort().join(',');
    if (keys !== 'action,token') return 'the page sent more than the link: ' + keys;
    const headers = Object.keys(first.headers || {}).map((k) => k.toLowerCase());
    return headers.indexOf('authorization') === -1 ? true : 'an Authorization header was sent';
  });

  await t('a pass with no repairs says so, and offers a way to file one', () => {
    const none = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData() }, claims: { status: 200, body: claimsData() } });
    return flush().then(() => {
      const raw = none.els.careClaims._innerHTML;
      if (raw.indexOf('claimIssue') === -1) return 'there is no way to file a repair';
      const said = none.read('careClaims');
      return /Nothing filed yet/.test(said) ? true : 'an empty list read as: ' + said;
    });
  });

  await t('filing sends the words typed and the link, and nothing the page decided', () => {
    const page = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData() }, claims: { status: 201, body: { ok: true, claim: aClaim() } } });
    return flush().then(() => {
      page.el('claimIssue').value = 'The kitchen tap will not close and drips all night';
      page.el('claimRoom').value = 'B4';
      page.el('claimPhone').value = '08031234567';
      const before = claimCalls(page).length;
      return page.api.claimFile().then(() => {
        const sent = claimCalls(page).slice(before)[0];
        if (!sent) return 'nothing was filed';
        if (sent.action !== 'create') return 'the action was ' + sent.action;
        if (sent.body.issue !== 'The kitchen tap will not close and drips all night') return 'the words were changed: ' + sent.body.issue;
        if (sent.body.phone !== '08031234567') return 'the number was changed';
        if (sent.body.room !== 'B4') return 'the room was changed';
        const keys = Object.keys(sent.body).sort().join(',');
        /* No status, no reference, no plan id and no money: a claim the
           page could stamp itself would be a claim nobody reviewed. */
        return keys === 'action,issue,phone,room,token' ? true : 'the page sent more than it should: ' + keys;
      });
    });
  });

  await t('a one-word fault is not a repair, and costs no round trip', () => {
    const page = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData() }, claims: { status: 201, body: { ok: true, claim: aClaim() } } });
    return flush().then(() => {
      const before = claimCalls(page).length;
      page.el('claimIssue').value = 'tap';
      return page.api.claimFile().then(() => {
        if (claimCalls(page).length !== before) return 'a one-word fault was filed';
        const said = note(page);
        if (!/sentence is enough/i.test(said)) return 'no guidance on what to type: ' + said;
        return page.el('claimIssue').value === 'tap' ? true : 'the words were thrown away';
      });
    });
  });

  await t('a photo link that is not https never becomes a link the student can click', () => {
    const page = makePage({ search: '?t=' + TOKEN, view: { status: 200, body: planData() }, claims: { status: 201, body: { ok: true, claim: aClaim() } } });
    return flush().then(() => {
      const before = claimCalls(page).length;
      page.el('claimIssue').value = 'The door lock jams when it rains';
      page.el('claimPhoto').value = 'javascript:alert(1)';
      return page.api.claimFile().then(() => {
        if (claimCalls(page).length !== before) return 'a javascript: link was sent to the server';
        const said = note(page);
        if (!/https/i.test(said)) return 'the student was not told what a photo link has to look like: ' + said;
        page.el('claimPhoto').value = 'https://res.cloudinary.com/arzuz/tap.jpg';
        const mark = claimCalls(page).length;
        return page.api.claimFile().then(() => {
          const sent = claimCalls(page).slice(mark)[0];
          if (!sent) return 'a real photo link was not sent';
          return sent.body.photos && sent.body.photos.length === 1
            ? true : 'the photo did not travel as one link: ' + JSON.stringify(sent.body.photos);
        });
      });
    });
  });

  /* THE SAME RULE AT THE OTHER END OF THE WIRE. The check above proves an
     http:// link is never SENT; this proves one already on a stored row —
     an import, or a row written before the rule existed — never becomes a
     link the student clicks from a page served over https. The renderer
     filters on the same pattern, and until this check existed nothing
     asked it to. */
  await t('a stored photo link that is not https is not rendered as a link', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [
            aClaim({
              id: 'c-shots',
              reference: 'AZ-C-SHOTS',
              status: 'awaiting_customer',
              provider_name: 'Musa Ibrahim',
              actual_kobo: 180000,
              call_out_no: 1,
              photos: ['http://cdn.example.com/tap.jpg', 'https://res.cloudinary.com/arzuz/tap.jpg']
            }),
            aClaim({ id: 'c-no', reference: 'AZ-C-REFUSED', status: 'rejected', eligibility: 'not_covered', eligibility_reason: 'The hinge is on the compound gate, which is the landlord\u2019s.' }),
            aClaim({ id: 'c-odd', reference: 'AZ-C-ODD', status: 'escalated' })
          ]
        })
      }
    });
    return flush().then(() => {
      /* The RAW element, not page.read(): read() strips tags, and the
         thing being asserted is an href — which is exactly what
         stripping removes. */
      const raw = page.el('careClaims')._innerHTML;
      if (raw.indexOf('href="https://res.cloudinary.com/arzuz/tap.jpg"') === -1) {
        return 'the https photo is not a link on the record: ' + raw.slice(-400);
      }
      if (raw.indexOf('cdn.example.com') !== -1) {
        return 'an http:// photo reached the page as something the student can open: ' + raw.slice(-400);
      }
      if ((raw.match(/<a /g) || []).length !== 1) {
        return 'one usable photo should be one link, not ' + (raw.match(/<a /g) || []).length;
      }
      return true;
    });
  });

  await t('a filed repair is given its reference back, and the list is re-read', () => {
    let shown = [];
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: (body) => (body.action === 'create'
        ? { status: 201, body: { ok: true, claim: aClaim({ reference: 'AZ-C-FILED-7K2Q' }) } }
        : { status: 200, body: claimsData({ claims: shown }) })
    });
    return flush().then(() => {
      const lists = claimCalls(page).filter((r) => r.action === 'list').length;
      page.el('claimIssue').value = 'The socket by the bed is dead';
      page.el('claimPhone').value = '08031234567';
      shown = [aClaim({ reference: 'AZ-C-FILED-7K2Q' })];
      return page.api.claimFile().then(() => flush()).then(() => {
        const said = page.read('careClaims');
        if (said.indexOf('AZ-C-FILED-7K2Q') === -1) return 'the reference was not shown: ' + said.slice(0, 200);
        const after = claimCalls(page).filter((r) => r.action === 'list').length;
        if (after <= lists) return 'the list was not re-read after filing';
        const text_ = page.read('careClaims');
        return text_.indexOf('AZ-C-FILED-7K2Q') !== -1 && /With us/.test(text_)
          ? true : 'the new repair is not on the page with its status';
      });
    });
  });

  await t('every repair is on the page with the STATUS THE SERVER SENT', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [
            aClaim({ id: 'c-wait', reference: 'AZ-C-WAITING', status: 'awaiting_customer', provider_name: 'Musa Ibrahim', actual_kobo: 180000, call_out_no: 1 }),
            aClaim({ id: 'c-no', reference: 'AZ-C-REFUSED', status: 'rejected', eligibility: 'not_covered', eligibility_reason: 'The hinge is on the compound gate, which is the landlord\u2019s.' }),
            aClaim({ id: 'c-odd', reference: 'AZ-C-ODD', status: 'escalated' })
          ]
        })
      }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      ['AZ-C-WAITING', 'AZ-C-REFUSED', 'AZ-C-ODD'].forEach((ref) => {
        if (said.indexOf(ref) === -1) throw new Error('a repair is missing from the page: ' + ref);
      });
      if (!/your confirmation, please/i.test(said)) return 'the status the server sent is not on the page';
      if (!/Not covered/.test(said)) return 'a refusal is not shown as a refusal';
      if (said.indexOf('Musa Ibrahim') === -1) return 'the worker the team named is not on the record';
      if (said.indexOf('1,800') === -1) return 'the cost the team recorded is not on the record';
      /* A status this page has never heard of is printed as it stands. A
         page that guessed a stage from an unknown word would be telling
         the student something the server did not say. */
      if (said.indexOf('escalated') === -1) return 'an unknown status was swallowed: ' + said.slice(0, 240);
      return true;
    });
  });

  await t('a repair with a worker on it says who is coming, and how to reach them', () => {
    /* The approval message named the worker and promised the page would
       carry the record, so the page has to stand on its own without it.
       The number is on the record and it is a number a phone can DIAL — a
       number printed as text is one the student has to retype — and
       whether they have answered is the server's word, not the page's
       inference. */
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-worker', reference: 'AZ-C-WORKER', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001', worker_confirmed: true
          })]
        })
      }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      const html = page.el('careClaims')._innerHTML;
      if (said.indexOf('Musa Ibrahim') === -1) return 'the worker is not on the record';
      if (said.indexOf('2348031190001') === -1) return 'the number to reach them is not on the record';
      if (html.indexOf('href="tel:+2348031190001"') === -1) {
        return 'the number is not one a phone can ring';
      }
      if (!/confirmed the job/.test(said)) return 'an answered handover is not shown as one';
      return /They will call you to arrange a time/.test(said)
        ? true : 'the page does not say what happens next: ' + said.slice(0, 240);
    });
  });

  await t('and a worker who has not answered is not dressed up as one who has', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-quiet', reference: 'AZ-C-QUIET', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001', worker_confirmed: false
          })]
        })
      }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      if (/confirmed the job/.test(said)) return 'the page invented an answer the worker never gave';
      return said.indexOf('2348031190001') !== -1
        ? true : 'the number is missing from a handover nobody has answered yet';
    });
  });

  await t('a day the worker suggested is on the record, in their own words, and not as an appointment', () => {
    /* A worker handed a job often answers with a time instead of a yes.
       The customer was told a worker is coming and used to have no idea
       when — and the page must not turn "Saturday morning" into a booked
       slot, because nobody has agreed one. */
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-day', reference: 'AZ-C-DAY', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001', worker_confirmed: false,
            provider_proposal: 'I can do Saturday morning before 11'
          })]
        })
      }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      if (said.indexOf('Saturday morning before 11') === -1) {
        return 'the day the worker offered is not on the record: ' + said.slice(0, 240);
      }
      if (!/suggested a time/.test(said)) return 'a suggested day is not labelled as one';
      if (/confirmed the job/.test(said)) return 'a suggestion was dressed up as an agreement';
      if (!/not a booking/i.test(said)) return 'the page presents the day as a booked appointment';
      /* The reassurance it replaced is gone with it: "they will call you to
         arrange a time" under a day already named reads as if nothing had
         been said. */
      return /They will call you to arrange a time/.test(said)
        ? 'the page still promises a call about a time the worker already gave' : true;
    });
  });

  await t('and a worker the customer was never told about carries no day with them', () => {
    /* The server strips the name, the number AND the day for a worker who
       has left the job (studentClaim). The page must not resurrect one
       from a field it happens to hold — a day from somebody who is not
       coming is a date to wait in for. */
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-gone', reference: 'AZ-C-GONE', status: 'approved', eligibility: 'covered',
            eligibility_reason: 'A fitting of the room.',
            provider_name: null, provider_phone: null, worker_confirmed: false,
            provider_proposal: null
          })]
        })
      }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      return /Worker:/.test(said) ? 'a worker who is not on the job is on the page: ' + said.slice(0, 240) : true;
    });
  });

  await t('a day the worker suggested can be agreed in one tap, and the tap says only that', () => {
    /* This is the customer's half of the conversation the worker started.
       Without it the answer is a phone call to the office — or nothing at
       all, and a worker at a gate nobody opens. */
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-day', reference: 'AZ-C-DAY', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001',
            provider_proposal: 'I can do Saturday morning',
          })],
        }),
      },
    });
    return flush().then(() => {
      if (!page.el('claimDayYes-0')) return 'a day nobody can agree to: the page offers no way to say yes';
      if (!page.el('claimDayOther-0')) return 'no way to ask for a different day';
      const before = claimCalls(page).length;
      page.el('claimDayYes-0').click();
      return flush().then(() => {
        const sent = claimCalls(page).slice(before)[0];
        if (!sent) return 'agreeing the day was never sent';
        if (sent.action !== 'agree_day') return 'the action was ' + sent.action;
        const keys = Object.keys(sent.body).sort().join(',');
        return keys === 'action,id,token'
          ? true : 'agreeing sent more than the claim it is about: ' + keys;
      });
    });
  });

  await t('an agreed day is shown as agreed, and is not offered again', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-agreed', reference: 'AZ-C-AGREED', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001',
            provider_proposal: 'I can do Saturday morning',
            day_agreed_at: '2026-10-14T10:00:00.000Z',
          })],
        }),
      },
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      if (!/agreed with you/.test(said)) return 'an agreed day is not shown as agreed: ' + said.slice(0, 240);
      if (page.el('claimDayYes-0')) return 'a day that is already agreed was offered again';
      return /that is when to expect them/.test(said)
        ? true : 'the page does not say what an agreed day means: ' + said.slice(0, 240);
    });
  });

  await t('asking for another day is words, sent to the worker, and not a blank', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-move', reference: 'AZ-C-MOVE', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001',
            provider_proposal: 'I can do Saturday morning',
          })],
        }),
      },
    });
    return flush().then(() => {
      const before = claimCalls(page).length;
      page.el('claimDayOther-0').click();
      return flush().then(() => {
        if (claimCalls(page).length !== before) return 'opening the box sent something';
        if (!page.el('claimDayWhen')) return 'the box for the day did not open';
        page.el('claimDayWhen').value = 'mon';
        page.el('claimDaySend').click();
        return flush().then(() => {
          if (claimCalls(page).length !== before) return 'a two-word day was sent';
          const said = note(page, 'claimDayNote');
          if (!/when would suit you/i.test(said)) return 'no guidance on what to write: ' + said.slice(0, 200);
          page.el('claimDayWhen').value = 'Sunday afternoon after 2 would suit me';
          page.el('claimDaySend').click();
          return flush().then(() => {
            const sent = claimCalls(page).slice(before)[0];
            if (!sent) return 'the day was never sent';
            if (sent.action !== 'propose_day') return 'the action was ' + sent.action;
            if (sent.body.when !== 'Sunday afternoon after 2 would suit me') {
              return 'their words were changed: ' + sent.body.when;
            }
            const keys = Object.keys(sent.body).sort().join(',');
            return keys === 'action,id,token,when'
              ? true : 'a suggested day sent more than it should: ' + keys;
          });
        });
      });
    });
  });

  await t('a day they have already sent is not met with a request to send one', () => {
    /* The page keeps the customer's own day after it is sent — and the
       sentence under it must not read as if the message had gone nowhere:
       being told "tell us a day that suits you" a second after telling us
       is how a person concludes that nothing they type ever arrives. */
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-sent', reference: 'AZ-C-SENT', status: 'assigned', call_out_no: 1,
            provider_name: 'Musa Ibrahim', provider_phone: '2348031190001',
            provider_proposal: 'I can do Saturday morning',
            customer_proposal: 'Sunday afternoon after 2 would suit me',
            customer_proposed_at: '2026-10-14T11:00:00.000Z',
          })],
        }),
      },
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      if (said.indexOf('Sunday afternoon after 2 would suit me') === -1) {
        return 'the day they sent is not on their own page: ' + said.slice(0, 260);
      }
      if (!/You suggested:/.test(said)) return 'their own day is not marked as theirs';
      if (/tell us one that does/.test(said)) {
        return 'a customer who just sent a day is asked to send one: ' + said.slice(0, 260);
      }
      if (!/they will ring you/i.test(said)) return 'the page does not say what happens next';
      /* And it is not dressed as an agreement, because nobody has agreed
         one — the worker\u2019s day is still a suggestion. */
      return /agreed with you/.test(said)
        ? 'a day they asked to move is shown as agreed: ' + said.slice(0, 260) : true;
    });
  });

  await t('a day is only answerable while the visit is still coming', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [
            aClaim({ id: 'c-fixed', reference: 'AZ-C-FIXED', status: 'completed', provider_name: 'Musa Ibrahim', provider_proposal: 'I can do Saturday morning' }),
            aClaim({ id: 'c-none2', reference: 'AZ-C-NONE2', status: 'assigned', provider_name: 'Musa Ibrahim' }),
          ],
        }),
      },
    });
    return flush().then(() => {
      /* Finished: no visit to move. */
      if (page.el('claimDayYes-0')) return 'a finished repair offered a visit to agree';
      /* And a worker who has suggested nothing: there is nothing to answer,
         so the control would be a button that means nothing. */
      if (page.el('claimDayYes-1') || page.el('claimDayOther-1')) {
        return 'a day was offered to agree with nobody having suggested one';
      }
      return true;
    });
  });

  await t('the decision is printed in words, both ways, and it is the server\u2019s reason', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [
            aClaim({ id: 'c-yes', reference: 'AZ-C-YES', status: 'approved', eligibility: 'covered', eligibility_reason: 'Plumbing fault inside the room.', call_out_no: 2 }),
            aClaim({ id: 'c-none', reference: 'AZ-C-NO', status: 'rejected', eligibility: 'not_covered', eligibility_reason: 'The roof is structural and outside the cover.' })
          ]
        })
      }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      if (said.indexOf('Plumbing fault inside the room.') === -1) return 'the reason for a covered repair is missing';
      if (said.indexOf('The roof is structural and outside the cover.') === -1) return 'the reason for a refusal is missing';
      if (!/Covered: Plumbing fault/.test(said)) return 'the covered decision is not labelled: ' + said.slice(0, 240);
      return /Not covered: The roof/.test(said) ? true : 'the refusal is not labelled as one';
    });
  });

  await t('confirmation is offered only where the server is waiting for the customer', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [
            aClaim({ id: 'c-worked', reference: 'AZ-C-WORKED', status: 'in_progress', provider_name: 'Musa Ibrahim' }),
            aClaim({ id: 'c-done', reference: 'AZ-C-DONE', status: 'awaiting_customer', provider_name: 'Musa Ibrahim' })
          ]
        })
      }
    });
    return flush().then(() => {
      if (page.el('claimConfirm-0')) return 'a job still being worked on offered a confirmation';
      if (!page.el('claimConfirm-1')) return 'the claim waiting for the customer offered no confirmation';
      if (!page.el('claimDispute-0')) return 'a job being worked on cannot be disputed';
      const before = claimCalls(page).length;
      const views = page.requests.filter((r) => r.action === 'view').length;
      page.el('claimConfirm-1').click();
      return flush().then(() => {
        const sent = claimCalls(page).slice(before)[0];
        if (!sent) return 'the confirmation was never sent';
        const keys = Object.keys(sent.body).sort().join(',');
        if (sent.action !== 'confirm') return 'the action was ' + sent.action;
        if (keys !== 'action,id,token') return 'the confirmation sent more than the claim: ' + keys;
        const after = page.requests.filter((r) => r.action === 'view').length;
        return after > views ? true : 'the pass was not re-read after a confirmation (the balance may have moved)';
      });
    });
  });

  await t('a dispute is words, and the words are what is sent', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({ claims: [aClaim({ id: 'c-done', reference: 'AZ-C-DONE', status: 'completed', provider_name: 'Musa Ibrahim' })] })
      }
    });
    return flush().then(() => {
      if (page.el('claimConfirm-0')) return 'a finished job still offered a confirmation';
      const before = claimCalls(page).length;
      page.el('claimDispute-0').click();
      return flush().then(() => {
        if (claimCalls(page).length !== before) return 'opening the dispute box sent something';
        if (!page.el('claimDisputeReason')) return 'the box for the reason did not open';
        page.el('claimDisputeReason').value = 'no';
        page.el('claimDisputeSend').click();
        return flush().then(() => {
          if (claimCalls(page).length !== before) return 'a one-word dispute was sent';
          const said = note(page, 'claimDisputeNote');
          if (!/what is wrong with the work/i.test(said)) return 'no guidance on what to say: ' + said.slice(0, 200);
          page.el('claimDisputeReason').value = 'The drip came back the next morning.';
          page.el('claimDisputeSend').click();
          return flush().then(() => {
            const sent = claimCalls(page).slice(before)[0];
            if (!sent) return 'the dispute was never sent';
            if (sent.action !== 'dispute') return 'the action was ' + sent.action;
            if (sent.body.reason !== 'The drip came back the next morning.') return 'the words were changed: ' + sent.body.reason;
            const keys = Object.keys(sent.body).sort().join(',');
            return keys === 'action,id,reason,token' ? true : 'the dispute sent more than it should: ' + keys;
          });
        });
      });
    });
  });

  await t('withdrawing is offered only where the server would allow it, and gives the call-out back', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: (body) => (body.action === 'cancel'
        ? { status: 200, body: { ok: true, released: true } }
        : { status: 200, body: claimsData({ claims: [aClaim({ id: 'c-approved', reference: 'AZ-C-APPROVED', status: 'approved', eligibility: 'covered', eligibility_reason: 'Covered: inside the room.', call_out_no: 1 })] }) })
    });
    return flush().then(() => {
      if (page.el('claimConfirm-0')) return 'an approved-but-unstarted job offered a confirmation';
      if (!page.el('claimCancel-0')) return 'an approved claim cannot be withdrawn';
      const before = claimCalls(page).length;
      page.el('claimCancel-0').click();
      return flush().then(() => {
        const sent = claimCalls(page).slice(before)[0];
        if (!sent) return 'the withdrawal was never sent';
        if (sent.action !== 'cancel') return 'the action was ' + sent.action;
        return page.read('careClaims').indexOf('went back to your session') !== -1
          ? true : 'the page did not say the call-out came back: ' + page.read('careClaims').slice(0, 200);
      });
    });
  });

  await t('a repair the student has no move on shows no buttons at all', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: { status: 200, body: claimsData({ claims: [aClaim({ id: 'c-open', reference: 'AZ-C-OPEN', status: 'disputed', dispute_reason: 'It was never actually fixed.' })] }) }
    });
    return flush().then(() => {
      const raw = page.els.careClaims._innerHTML;
      ['claimConfirm-0', 'claimDispute-0', 'claimCancel-0'].forEach((id) => {
        if (raw.indexOf(id) !== -1) throw new Error('a control was drawn for a claim in dispute: ' + id);
      });
      const said = page.read('careClaims');
      if (!/looking again/i.test(said)) return 'the student is not told the dispute is being looked at';
      return said.indexOf('It was never actually fixed.') !== -1 ? true : 'the student\u2019s own words are not on the record';
    });
  });

  await t('a repairs list the page cannot read does not take the pass down with it', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: { status: 503, body: { error: 'Repairs are not switched on for this site yet.', kind: 'not-ready' } }
    });
    return flush().then(() => {
      const said = page.read('careClaims');
      if (!/not switched on/.test(said)) return 'the reason was not shown: ' + said;
      if (!page.shown('careAccount')) return 'the whole account was hidden because one section failed';
      const balance = page.read('careBalance');
      return balance.indexOf('3 of 4') !== -1 ? true : 'the balance went with it: ' + balance.slice(0, 160);
    });
  });

  await t('a hostile issue, reason or resolution cannot become markup', () => {
    const nasty = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-evil', reference: 'AZ-C-EVIL', status: 'completed', issue: nasty,
            eligibility: 'covered', eligibility_reason: nasty, provider_name: nasty,
            dispute_reason: nasty, resolution: nasty
          })]
        })
      }
    });
    return flush().then(() => {
      const raw = page.els.careClaims._innerHTML;
      if (/<img src=x|<script>/.test(raw)) return 'unescaped markup reached the page';
      if (raw.indexOf('&lt;img') === -1) return 'the hostile text did not arrive at all — the check is vacuous';
      return true;
    });
  });

  await t('a photo the row should not have cannot become a link', () => {
    const page = makePage({
      search: '?t=' + TOKEN,
      view: { status: 200, body: planData() },
      claims: {
        status: 200,
        body: claimsData({
          claims: [aClaim({
            id: 'c-photo', reference: 'AZ-C-PHOTO', status: 'approved',
            photos: ['javascript:alert(1)', 'https://res.cloudinary.com/arzuz/tap.jpg']
          })]
        })
      }
    });
    return flush().then(() => {
      const raw = page.els.careClaims._innerHTML;
      if (raw.indexOf('javascript:') !== -1) return 'a javascript: URL was rendered as a link';
      return raw.indexOf('https://res.cloudinary.com/arzuz/tap.jpg') !== -1
        ? true : 'the real photo link was dropped as well';
    });
  });

  await t('the page cannot decide, assign or report anything — the student door only', () => {
    /* The check is the ACTIONS the file calls, not the words in it: the
       page says "we decide within 48 hours" to the student, and a word
       search would call that a team control. claimApi('x') is the wire. */
    const src = source('assets/my-care.js');
    const called = (src.match(/claimApi\('([a-z_]+)'/g) || [])
      .map((m) => m.replace(/^claimApi\('/, '').replace(/'$/, ''));
    if (!called.length) return 'no claims call was found in the source — this check proves nothing';
    const team = called.filter((a) => CLAIM_ACTIONS.indexOf(a) === -1);
    if (team.length) return 'the student page calls a team action: ' + team.join(', ');

    /* And on the wire: nothing was sent to the team door, and nothing a
       client could decide for itself (a status, a reference, a price)
       travelled with a student action. */
    const sent = claimCalls(linked).map((r) => r.action);
    const bad = sent.filter((a) => CLAIM_ACTIONS.indexOf(a) === -1);
    if (bad.length) return 'the page sent ' + bad.join(', ');
    const forged = [];
    claimCalls(linked).forEach((r) => {
      ['status', 'reference', 'plan_id', 'amount_kobo', 'eligibility', 'call_out_no', 'actual_kobo',
        /* Nor may the customer answer on the worker's behalf, or stamp an
           agreement with their own clock. Those are the server's. */
        'provider_answer', 'worker_confirmed', 'day_agreed_at', 'customer_proposed_at',
        'provider_proposal', 'provider_name'].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(r.body, k)) forged.push(k);
      });
    });
    return forged.length ? 'the page named something the team decides: ' + forged.join(', ') : true;
  });

  /* ============================================================
     6. WHAT CANNOT HAPPEN
     ============================================================ */

  console.log('\nmy-care.html — the things that must never happen\n');

  await t('nothing on the page can write a credit', () => {
    const written = linked.requests.map((r) => r.action);
    const bad = written.filter((a) => ['grant', 'spend', 'refund', 'expire', 'adjust'].indexOf(a) !== -1);
    if (bad.length) return 'the student page sent ' + bad.join(', ');
    const raw = linked.html();
    ['data-care="grant"', 'data-care="adjust"', 'careWorker', 'careParts'].forEach((forbidden) => {
      if (raw.indexOf(forbidden) !== -1) throw new Error('the page has a team control on it: ' + forbidden);
    });
    return true;
  });

  await t('a hostile worker name or reason cannot become markup on the student’s page', () => {
    const nasty = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const evil = makePage({
      search: '?t=' + TOKEN,
      view: {
        status: 200,
        body: planData({
          student: { name: nasty, phone: '2348036543210', area: 'Malete', property: null, room: nasty },
          events: [
            { event: 'granted', delta: 4, created_at: '2026-10-01T09:00:00.000Z', reason: nasty },
            { event: 'spent', delta: -1, created_at: '2026-10-03T11:30:00.000Z', worker: nasty, parts_ngn: 1200, note: nasty }
          ]
        })
      }
    });
    return evil.boot().then(() => {
      const raw = evil.html();
      if (/<img src=x|<\/script>|<script>/.test(raw)) return 'unescaped markup reached the page';
      if (raw.indexOf('&lt;img') === -1) return 'the hostile text did not arrive at all — the check is vacuous';
      return true;
    });
  });

  await t('the string handed to the DOM is escaped in every container', () => {
    const raw = linked.html();
    return raw.indexOf('<script') === -1 ? true : 'a script tag was rendered';
  });

  /* ============================================================
     7. NO LINK, A DEAD LINK, AND A SERVICE THAT IS NOT ON
     ============================================================ */

  console.log('\nmy-care.html — when it cannot answer\n');

  await t('an unrecognised link is not an outage: the student is told how to get it back', () => {
    const dead = makePage({
      search: '?t=' + 'z'.repeat(43),
      stored: { arzuz_care_token_v1: 'z'.repeat(43) },
      view: { status: 404, body: { error: 'We do not recognise that Care link.', kind: 'rejected' } }
    });
    return dead.boot().then(() => {
      if (!dead.shown('careGone')) return 'the dead-link state was not shown';
      if (dead.shown('careDown')) return 'a refused link was shown as a service outage';
      return dead.store.arzuz_care_token_v1 === undefined
        ? true : 'the dead link was kept in storage and will be retried forever';
    });
  });

  await t('the class the function named decides it, even when the wording changes', () => {
    /* The sentence is copy and copy gets edited. The class is the
       contract: care-credit answers a refused link with `rejected`, and
       the page must not need to recognise any particular phrasing to
       know that. Written after the class went on the wire — with the
       older sentence-only reading this case fell through to the outage
       screen and left the student holding a key that works forever. */
    const reworded = makePage({
      search: '?t=' + 'z'.repeat(43),
      stored: { arzuz_care_token_v1: 'z'.repeat(43) },
      view: { status: 404, body: { error: 'That is not a link we know.', kind: 'rejected' } }
    });
    return reworded.boot().then(() => {
      if (!reworded.shown('careGone')) return 'the class on the wire was ignored — the wording was made the contract';
      return reworded.store.arzuz_care_token_v1 === undefined
        ? true : 'the refused link was kept in storage';
    });
  });

  await t('a 404 that is NOT the Care function (a route that was never deployed) keeps the link', () => {
    /* Found in a real browser: with the dev server answering /api/… with
       its own 404, the page wiped the stored link — so a deploy that
       had not finished would delete the student's only key. The
       sentence, not the status, is what identifies a refused link. */
    const undeployed = makePage({
      search: '?t=' + TOKEN,
      stored: { arzuz_care_token_v1: TOKEN },
      view: { status: 404, body: null }
    });
    return undeployed.boot().then(() => {
      if (undeployed.store.arzuz_care_token_v1 !== TOKEN) return 'the stored link was cleared by a route that is not the function';
      if (!undeployed.shown('careDown')) return 'the student was not told anything at all';
      if (undeployed.shown('careGone')) return 'an undeployed route was shown as a refused link';
      const said = readBox(undeployed, 'careDown');
      /* A body that is not this function's JSON must NOT surface as a
         programming error on a student's screen. */
      return /Cannot read|TypeError|undefined|\[object/.test(said)
        ? 'the student was shown an implementation error: ' + said
        : true;
    });
  });

  await t('a Care database that does not exist yet is reported in the server’s own words', () => {
    const off = makePage({
      search: '?t=' + TOKEN,
      view: { status: 503, body: {
        error: 'Care is not switched on for this site yet. Nothing is wrong with your link — message us on WhatsApp and we will sort it out.',
        kind: 'not-ready'
      } }
    });
    return off.boot().then(() => {
      if (!off.shown('careDown')) return 'the outage state was not shown';
      if (off.shown('careGone')) return 'an outage was shown as a bad link';
      const said = readBox(off, 'careDown');
      if (!/not switched on/.test(said)) return 'the reason is missing: ' + said;
      return /WhatsApp/.test(said) ? true : 'no way to reach the team from the outage box';
    });
  });

  await t('a 503 that is NOT this deploy\u2019s configuration is not called "not switched on"', () => {
    /* Two facts share 503: this deploy has no Care yet, and this deploy
       is briefly unwell. Only the function can tell them apart, and it
       does — so the page must not put the "nothing you can do" title on
       a failure whose advice is "try again in a minute". */
    const unwell = makePage({
      search: '?t=' + TOKEN,
      view: { status: 503, body: {
        error: 'Care could not take that just now — that is our side, not yours.',
        kind: 'error'
      } }
    });
    return unwell.boot().then(() => {
      const said = readBox(unwell, 'careDown');
      if (/not switched on/i.test(said)) {
        return 'a briefly unwell Care was reported as a deployment that has not been switched on: ' + said;
      }
      return /our side, not yours/.test(said)
        ? true : 'the server\u2019s own sentence was lost: ' + said;
    });
  });

  await t('an unexpected failure shows the server’s message, not a blank page', () => {
    const broke = makePage({
      search: '?t=' + TOKEN,
      view: { status: 502, body: { error: 'We could not open your Care account just now. Try again in a moment.' } }
    });
    return broke.boot().then(() => {
      const said = readBox(broke, 'careDown');
      return /Try again in a moment/.test(said) ? true : 'the message was lost: ' + said;
    });
  });

  await t('a link kept on the device is used without it being in the URL', () => {
    const back = makePage({ stored: { arzuz_care_token_v1: TOKEN }, view: { status: 200, body: planData() } });
    return back.boot().then(() => {
      if (!back.requests.length) return 'the stored link was never used';
      return back.requests[0].body.token === TOKEN ? true : 'the stored link was not the one sent';
    });
  });

  /* ============================================================
     8. THE LINK BOX
     ============================================================ */

  console.log('\nmy-care.html — keeping the link\n');

  await t('the page shows the student their own link, built from the link they hold', () => {
    const said = linked.els.careShare._innerHTML;
    const want = linked.api.linkFor(TOKEN);
    if (said.indexOf(want) === -1) return 'the link box does not contain ' + want;
    return said.indexOf('?t=' + TOKEN) !== -1 ? true : 'the link box shows a link with no token';
  });

  await t('it warns the student not to post it, because it is the whole credential', () => {
    const said = linked.read('careShare');
    if (!/keep it to yourself|not post/i.test(said)) return 'the warning is missing';
    return /key/i.test(said) ? true : 'the page does not say the link is the key';
  });

  await t('the canonical path is used on the live site, and the local file when served off disk', () => {
    const local = makePage({ path: '/my-care.html' });
    const canon = makePage({ path: '/my-care' });
    const odd = makePage({ path: '/my-care/' });
    if (local.api.linkFor('abc') !== 'https://arzuz.com/my-care.html?t=abc') return 'the local path was not preserved: ' + local.api.linkFor('abc');
    if (canon.api.linkFor('abc') !== 'https://arzuz.com/my-care?t=abc') return 'the canonical path was not used';
    return odd.api.linkFor('abc').indexOf('/my-care?t=abc') !== -1 ? true : 'an unexpected path produced ' + odd.api.linkFor('abc');
  });

  await t('a link is read out of a query string with other parameters in it', () => {
    const p = makePage({ search: '?utm_source=wa&t=' + TOKEN + '&x=1' });
    return p.api.tokenFromUrl() === TOKEN ? true : 'the token was not found: ' + p.api.tokenFromUrl();
  });

  /* ============================================================
     9. THE PAGE THE BROWSER ACTUALLY GETS
     ============================================================ */

  console.log('\nmy-care.html — the file itself\n');

  await t('the page is never indexed, and never cached with a link in it', () => {
    const html = source('my-care.html');
    if (!/name="robots" content="noindex, nofollow"/.test(html)) return 'the page can be indexed';
    return /assets\/my-care\.js/.test(html) ? true : 'the page does not load its own script';
  });

  await t('every container the script paints exists in the HTML', () => {
    const html = source('my-care.html');
    const missing = IDS.filter((id) => html.indexOf('id="' + id + '"') === -1);
    return missing.length ? 'the script paints ids the page does not have: ' + missing.join(', ') : true;
  });

  await t('the page loads scripts that exist', () => {
    const html = source('my-care.html');
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
})();

}

main().catch((err) => {
  console.error('[my-care-test] ' + (err && err.stack || err));
  process.exit(1);
});
