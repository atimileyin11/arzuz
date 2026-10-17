#!/usr/bin/env node
/* ============================================================
   Arzuz — care-pass.html, driven headlessly

   The Care Pass page is the only surface on the site where a
   customer hands over money, so it is tested against the SERVER'S
   answers rather than against the page's own opinion:

     · the price, the covered and not-covered lists, the call-out
       limit, the parts ceiling, the waiting period and the refund
       rule are PRINTED FROM THE TERMS the server sends — proved by
       sending a price the page could not have guessed
     · the page refuses to order anything until the customer has
       accepted the terms it just showed, and before it says a word
       about a phone number it can reach them on
     · the request it sends carries the customer's own details and
       an idempotency uuid, and NOTHING about money: no amount, no
       price, no status, no coverage window
     · a retry reuses the SAME uuid, so a double tap, a reload and a
       second attempt can only ever be one order
     · coming back from the provider proves nothing: the URL is read
       for a reference and then the SERVER is asked, and a page whose
       address says "success" shows no coverage when the server says
       it was not paid
     · the private pass link is used only when the server hands one
       over, it is stored under the same key my-care.html reads, and
       the page never follows a URL the server merely suggested
     · a hostile string in the terms, in a name or in the provider's
       answer cannot become markup on the customer's page

   Run from arzuz-site/:
     node scripts/test-care-pass-page.mjs
   ============================================================ */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { webcrypto } = require('node:crypto');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- tiny test runner ---------------- */

let passed = 0;
const failures = [];

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

/* ---------------- the files under test ---------------- */

const CACHE = {};
function source(rel) {
  if (!CACHE[rel]) CACHE[rel] = readFileSync(join(ROOT, rel), 'utf8');
  return CACHE[rel];
}

/* The page's visible text, tags stripped — what the customer reads. */
function text(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function unescapeHtml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* What a crawler that runs no script sees. */
function staticText(html) {
  const body = html.slice(Math.max(html.search(/<body[^>]*>/i), 0));
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- the DOM the page needs ---------------- */

const IDS = ['passPanel', 'passLookup'];

function makeEl(id) {
  const el = {
    id: id, tagName: 'DIV', children: [], listeners: {}, style: {},
    value: '', textContent: '', _innerHTML: '', disabled: false, checked: false
  };
  el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.getAttribute = (k) => el['attr_' + k] || null;
  el.setAttribute = (k, v) => { el['attr_' + k] = String(v); };
  el.focus = () => {};
  el.click = () => { (el.listeners.click || []).slice().forEach((fn) => fn({ type: 'click', target: el, preventDefault() {} })); };
  el.change = () => {
    el.checked = !el.checked;
    (el.listeners.change || []).slice().forEach((fn) => fn({ type: 'change', target: el, preventDefault() {} }));
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); if (el._register) el._register(el._innerHTML); }
  });
  return el;
}

const HOST_GLOBALS = ['Date', 'Number', 'String', 'Object', 'Array', 'JSON', 'Math', 'Promise', 'RegExp',
  'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'Intl', 'Error', 'TypeError', 'Symbol', 'Map', 'Set', 'Uint8Array'];

/*
  One page, one scenario. opts:

    search   window.location.search ('' or '?reference=…')
    terms    the answer to action:'terms'   { status, body } or a function
    order    the answer to action:'order'
    verify   the answer to action:'verify'
    status   the answer to action:'status'
    stored   what localStorage already holds
    readyState  'loading' (default) so the harness decides when to boot
*/
function makePage(opts = {}) {
  const els = {};
  const dyn = {};

  /* Inputs the page paints arrive as markup, so the ids they declare
     are registered as real elements — otherwise a form the page drew
     would be a form the harness could not type into, and the order
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
      if (/\bdisabled\b/.test(m[0])) el.disabled = true;
      dyn[id] = el;
    }
  }

  IDS.forEach((id) => {
    els[id] = makeEl(id);
    els[id]._register = register;
  });

  const requests = [];
  const assigns = [];
  const toasts = [];

  function answer(action, url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    requests.push({
      action: body.action,
      body: body,
      url: url,
      headers: (init && init.headers) || {},
      method: (init && init.method) || 'GET'
    });
    const plan = opts[body.action];
    let res;
    try {
      res = typeof plan === 'function' ? plan(body, requests.length) : plan;
    } catch (err) {
      /* A real fetch REJECTS when it cannot reach anything; it does not
         throw at the caller. Modelled the same way, or the outage path
         would be tested against something a browser never does. */
      return Promise.reject(err);
    }
    if (!res) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true })) });
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
    readyState: opts.readyState || 'loading',
    getElementById: (id) => els[id] || dyn[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl('created'),
    body: makeEl('body')
  };

  const location = {
    search: opts.search || '',
    pathname: opts.path || '/care-pass.html',
    origin: 'https://arzuz.com',
    hash: '',
    assign: (url) => { assigns.push(url); }
  };

  const sandbox = {
    window: {
      ARZUZ_CONFIG: { SUPPORT_WHATSAPP: '2349024814771' },
      location: location,
      crypto: webcrypto
    },
    document: document,
    localStorage: localStorage,
    fetch: (url, init) => answer(JSON.parse(init.body).action, url, init),
    ArzuzSubmit: { showToast: (m, k) => toasts.push([m, k]) },
    console: { log() {}, warn() {}, error() {} },
    Promise: Promise
  };
  HOST_GLOBALS.forEach((g) => { sandbox[g] = globalThis[g]; });

  const ctx = vm.createContext(sandbox);
  /* The order the real page loads them in (care-pass.html): config.js →
     api-errors.js → care-pass.js. The classifier matters here — a 503
     that means "not on sale" and a 503 that means "unwell" are the same
     digit and different advice. */
  vm.runInContext(source('assets/config.js'), ctx, { filename: 'config.js' });
  vm.runInContext(source('assets/api-errors.js'), ctx, { filename: 'api-errors.js' });
  vm.runInContext(source('assets/care-pass.js'), ctx, { filename: 'care-pass.js' });

  const api = sandbox.ArzuzCarePass;
  return {
    api: api,
    els: els,
    store: store,
    requests: requests,
    assigns: assigns,
    toasts: toasts,
    /* the painted page, as the customer would read it */
    html: () => IDS.map((id) => els[id]._innerHTML).join(' '),
    read: (id) => text(els[id]._innerHTML),
    all: () => text(IDS.map((id) => els[id]._innerHTML).join(' ')),
    el: (id) => els[id] || dyn[id] || null,
    boot: () => api.boot()
  };
}

/* ---------------- fixtures ---------------- */

const TERMS = {
  price_kobo: 2000000,
  currency: 'NGN',
  term: 'one academic semester',
  call_outs_included: 4,
  parts_ceiling_kobo: 300000,
  waiting_period: 'none beyond the next working day',
  covered: ['capped repair of plumbing, electrical, and minor structural faults', 'one visit per call-out, by a verified worker'],
  excluded: ['parts over the included ceiling without a quote', 'deliberate damage or negligence', 'rent, deposits, or any tenancy payment'],
  approval: 'each call-out is approved by Arzuz before a worker sends anybody',
  refund: 'full refund requested before coverage starts',
  support: 'WhatsApp the Arzuz team; a verified worker within 48 hours'
};

const TERMS_OK = { status: 200, body: { ok: true, product: 'care_pass', version: 3, terms: TERMS, hash: 'a'.repeat(64), storage_enabled: false, currency: 'NGN' } };

const OFF = { status: 503, body: { error: 'The Care Pass is not on sale yet — Arzuz is still approving the coverage terms.', kind: 'not-ready' } };

function fillForm(page, over = {}) {
  const values = Object.assign({
    cpName: 'Ada Okonkwo', cpPhone: '08031112233', cpEmail: 'ada@example.com',
    cpArea: 'Malete', cpProperty: 'Sunrise Lodge', cpRoom: 'A1', cpReferral: ''
  }, over);
  Object.keys(values).forEach((id) => { const el = page.el(id); if (el) el.value = values[id]; });
}

async function acceptAndOrder(page, over) {
  const accept = page.el('cpAccept');
  if (accept) accept.change();
  fillForm(page, over);
  if (page.el('cpPay')) page.el('cpPay').click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return page.requests.filter((r) => r.action === 'order').slice(-1)[0];
}

/* ============================================================
   1. THE FILE ITSELF
   ============================================================ */

console.log('\n1. The page a crawler and a customer both get\n');

const HTML = source('care-pass.html');
const JS = source('assets/care-pass.js');

await t('it is a real page: one <h1>, a title, a description and a canonical', async () => {
  const h1s = HTML.match(/<h1[\s>]/gi) || [];
  if (h1s.length !== 1) return h1s.length + ' <h1> elements';
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(HTML);
  const desc = /<meta name="description" content="([^"]+)"/i.exec(HTML);
  const canon = /<link rel="canonical" href="([^"]+)"/i.exec(HTML);
  if (!title) return 'no title';
  if (!desc) return 'no meta description';
  if (!canon) return 'no canonical';
  if (canon[1] !== 'https://arzuz.com/care-pass') return 'canonical is ' + canon[1];
  return true;
});

await t('it reads without JavaScript (' + staticText(HTML).length + ' chars of real text)', () =>
  staticText(HTML).length >= 600 ? true : staticText(HTML).length + ' chars — a crawler would fetch an empty document');

await t('it loads the page script and the shared failure vocabulary', async () => {
  const want = ['assets/care-pass.js', 'assets/api-errors.js', 'assets/config.js', 'assets/app.js'];
  const missing = want.filter((w) => HTML.indexOf(w) === -1);
  return missing.length ? 'not loaded: ' + missing.join(', ') : true;
});

await t('the static copy states no price, so it cannot drift from the published terms', async () => {
  const body = HTML.slice(0, HTML.search(/<script/i));
  const money = body.match(/\u20a6\s?[\d,]{3,}/g) || [];
  return money.length ? 'a hard-coded price on the page: ' + money.join(', ') : true;
});

await t('the static copy makes the housing promise in the brief\u2019s own terms', async () => {
  const body = staticText(HTML);
  const missing = [
    'no commission',
    'no listing fee',
    'bundled into rent'
  ].filter((s) => body.toLowerCase().indexOf(s.toLowerCase()) === -1);
  return missing.length ? 'not said: ' + missing.join(' | ') : true;
});

await t('the page never computes a coverage window of its own', async () => {
  const smells = ['care_term_days', '86400', 'setDate(', 'setMonth(', 'setFullYear('];
  const found = smells.filter((s) => JS.indexOf(s) !== -1);
  return found.length ? 'the page dates a term itself: ' + found.join(', ') : true;
});

await t('the private link is stored under the key my-care.html reads', async () => {
  const mine = /var TOKEN_KEY = '([^']+)'/.exec(source('assets/my-care.js'));
  const theirs = /var TOKEN_KEY = '([^']+)'/.exec(JS);
  if (!mine) return 'my-care.js no longer declares TOKEN_KEY — this check is stale';
  if (!theirs) return 'care-pass.js declares no TOKEN_KEY';
  return mine[1] === theirs[1] ? true : 'care-pass stores ' + theirs[1] + '; my-care reads ' + mine[1];
});

/* ============================================================
   2. THE TERMS, AS PUBLISHED
   ============================================================ */

console.log('\n2. What is for sale is read from the server, not typed on the page\n');

await t('the first thing it does is ask for the terms, and nothing else', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const first = page.requests[0];
  if (!first) return 'no request at all';
  if (first.action !== 'terms') return 'first action was ' + first.action;
  const keys = Object.keys(first.body);
  return keys.length === 1 ? true : 'the terms request carried ' + keys.join(', ');
});

await t('the price on the page is the server\u2019s price', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('\u20a620,000') === -1) return 'the price is not on the page: ' + shown.slice(0, 160);
  if (shown.indexOf('Pay \u20a620,000') === -1) return 'the button does not state the price';
  return true;
});

await t('a different published price changes the page \u2014 nothing is hard-coded', async () => {
  const page = makePage({
    terms: { status: 200, body: Object.assign({}, TERMS_OK.body, { terms: Object.assign({}, TERMS, { price_kobo: 2550000 }) }) }
  });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('\u20a625,500') === -1) return 'the server\u2019s price was not printed: ' + shown.slice(0, 160);
  return shown.indexOf('\u20a620,000') === -1 ? true : 'the old price is still on the page';
});

await t('every covered and not-covered line the server sent is on the page', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const shown = page.all();
  const missing = TERMS.covered.concat(TERMS.excluded).filter((t2) => shown.indexOf(t2) === -1);
  return missing.length ? 'not shown: ' + missing.join(' | ') : true;
});

await t('the limits a claim is judged against are all stated', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const shown = page.all();
  const want = [
    ['call-outs', String(TERMS.call_outs_included)],
    ['parts ceiling', '\u20a63,000'],
    ['waiting period', TERMS.waiting_period],
    ['approval', TERMS.approval],
    ['refund rule', TERMS.refund],
    ['support', TERMS.support],
    ['the term', TERMS.term]
  ];
  const missing = want.filter(([, needle]) => shown.indexOf(needle) === -1).map(([label]) => label);
  return missing.length ? 'not stated: ' + missing.join(', ') : true;
});

await t('the version accepted is named, and it is the version shown', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('v3') === -1) return 'the version is not named';
  if (shown.indexOf('aaaaaaaaaaaa') === -1) return 'the terms hash is not shown \u2014 nothing proves which wording was accepted';
  return true;
});

await t('the claim procedure says a job is finished by the customer, not by a worker', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const shown = page.all();
  return shown.indexOf('when you confirm it') !== -1 || shown.indexOf('you confirm') !== -1
    ? true : 'the page never says who finishes a claim';
});

/* ============================================================
   3. THE GATE BEFORE THE MONEY
   ============================================================ */

console.log('\n3. Nothing is ordered until the terms are accepted and the details are real\n');

await t('the pay button starts disabled', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  const pay = page.el('cpPay');
  if (!pay) return 'no pay button';
  return pay.disabled === true ? true : 'the pay button is live before the terms are accepted';
});

await t('clicking it anyway is refused, and sends nothing', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  fillForm(page);
  page.el('cpPay').click();
  await new Promise((r) => setTimeout(r, 0));
  const orders = page.requests.filter((r) => r.action === 'order');
  if (orders.length) return 'it ordered without acceptance';
  const shown = page.all();
  return shown.indexOf('accept') !== -1 ? true : 'no explanation was shown';
});

await t('a one-letter name is refused before a round trip', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  await acceptAndOrder(page, { cpName: 'A' });
  return page.requests.filter((r) => r.action === 'order').length === 0 ? true : 'it sent an order with no name';
});

await t('a phone number a worker could not ring is refused before a round trip', async () => {
  const page = makePage({ terms: TERMS_OK });
  await page.boot();
  await acceptAndOrder(page, { cpPhone: '12345' });
  return page.requests.filter((r) => r.action === 'order').length === 0 ? true : 'it sent an order with a bad number';
});

/* ============================================================
   4. THE ORDER
   ============================================================ */

console.log('\n4. The order carries the customer, never the money\n');

const ORDER_OK = {
  status: 201,
  body: {
    ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', amount_kobo: 2000000, currency: 'NGN',
    authorization_url: 'https://checkout.paystack.com/abc123', access_code: 'ac_abc123',
    version: 3, message: 'Pay \u20a620,000 to open your Care Pass.'
  }
};

await t('an accepted, complete form sends exactly the customer\u2019s own details', async () => {
  const page = makePage({ terms: TERMS_OK, order: ORDER_OK });
  await page.boot();
  const sent = await acceptAndOrder(page, { cpReferral: 'AZ-4F2K' });
  if (!sent) return 'no order was sent';
  const keys = Object.keys(sent.body).sort().join(',');
  const want = 'action,area,client_ref,email,name,phone,property,referral_code,room';
  if (keys !== want) return 'it sent: ' + keys;
  if (sent.body.name !== 'Ada Okonkwo') return 'the name did not survive';
  if (sent.body.referral_code !== 'AZ-4F2K') return 'the referral code did not survive';
  return true;
});

await t('and never an amount, a price, a status or a coverage window', async () => {
  const page = makePage({ terms: TERMS_OK, order: ORDER_OK });
  await page.boot();
  const sent = await acceptAndOrder(page);
  const forbidden = ['amount', 'amount_kobo', 'price', 'price_kobo', 'status', 'coverage', 'coverage_start',
    'coverage_end', 'receipt_ref', 'paid', 'activated', 'call_out_cap'];
  const found = forbidden.filter((k) => Object.prototype.hasOwnProperty.call(sent.body, k));
  return found.length ? 'the page tried to name: ' + found.join(', ') : true;
});

await t('the idempotency key is a uuid this browser made, and it is kept', async () => {
  const page = makePage({ terms: TERMS_OK, order: ORDER_OK });
  await page.boot();
  const sent = await acceptAndOrder(page);
  const cr = sent.body.client_ref;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(cr))) {
    return 'client_ref is not a uuid: ' + cr;
  }
  if (page.store[page.api.CLIENT_KEY] !== cr) return 'the uuid was not kept for the retry';
  return true;
});

await t('the same key is reused on a retry, so a second attempt is the SAME order', async () => {
  const first = { status: 503, body: { error: 'Payments are not switched on for this site yet. Your order is saved.', kind: 'not-ready' } };
  const page = makePage({ terms: TERMS_OK, order: first });
  await page.boot();
  const sent = await acceptAndOrder(page);
  const before = page.requests.filter((r) => r.action === 'order').length;

  /* The server said the provider is not configured: the page must not
     claim a pass and must not tell the customer to try again. */
  if (page.read('passPanel').indexOf('not on sale') === -1 &&
    page.all().indexOf('not switched on') === -1) {
    return 'the not-ready answer was not explained';
  }
  const off = page.all();
  if (off.indexOf('Pay \u20a6') !== -1) return 'it still offers a pay button when payments are off';

  /* Now let a real order through and try again from the same browser. */
  const page2 = makePage({ terms: TERMS_OK, order: first, stored: { [page.api.CLIENT_KEY]: sent.body.client_ref } });
  await page2.boot();
  await acceptAndOrder(page2);
  const second = page2.requests.filter((r) => r.action === 'order').slice(-1)[0];
  if (before !== 1) return 'the first attempt sent ' + before + ' orders';
  return second.body.client_ref === sent.body.client_ref
    ? true : 'the retry asked for a second order: ' + second.body.client_ref;
});

await t('a paid order takes the customer to the provider and claims no coverage', async () => {
  const page = makePage({ terms: TERMS_OK, order: ORDER_OK });
  await page.boot();
  await acceptAndOrder(page);
  if (page.assigns[0] !== 'https://checkout.paystack.com/abc123') {
    return 'it did not open the payment page: ' + JSON.stringify(page.assigns);
  }
  const shown = page.all();
  if (shown.indexOf('Care Pass is open') !== -1) return 'it claimed the pass before the provider confirmed';
  return shown.indexOf('Paystack') !== -1 ? true : 'it never mentioned where the customer was going';
});

await t('an order the server refuses with a sentence shows that sentence', async () => {
  const page = makePage({
    terms: TERMS_OK,
    order: { status: 400, body: { error: 'A Care Pass needs the student\u2019s name.' } }
  });
  await page.boot();
  await acceptAndOrder(page, { cpName: 'Ada Okonkwo' });
  const shown = page.all();
  return shown.indexOf('needs the student') !== -1 ? true : 'the server\u2019s sentence was not shown: ' + shown.slice(0, 200);
});

/* ============================================================
   5. COMING BACK FROM THE PROVIDER
   ============================================================ */

console.log('\n5. A return address is not a payment\n');

function activeAnswer(passLink, over) {
  return {
    status: 200,
    body: Object.assign({
      ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', status: 'paid', activated: true,
      amount_kobo: 2000000, terms_version: 3,
      receipt_ref: 'AZ-R-M4K2P1-9F3A2B1C', coverage_start: '2026-10-13T09:00:00.000Z',
      coverage_end: '2027-02-10T09:00:00.000Z', call_out_cap: 4,
      coverage: {
        plan_status: 'active', session: '2026/2027', start: '2026-10-13T09:00:00.000Z',
        end: '2027-02-10T09:00:00.000Z', call_out_cap: 4, receipt_ref: 'AZ-R-M4K2P1-9F3A2B1C'
      },
      pass_link: passLink
    }, over || {})
  };
}

await t('the reference in the address is asked about, with the key this browser holds', async () => {
  const cr = '11111111-1111-4111-8111-111111111111';
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C&trxref=ignored',
    verify: activeAnswer(null),
    stored: { 'arzuz_pass_client_ref_v1': cr }
  });
  await page.boot();
  const first = page.requests[0];
  if (first.action !== 'verify') return 'it did not verify, it did ' + first.action;
  if (first.body.reference !== 'AZ-M4K2P1-9F3A2B1C') return 'the reference did not survive the URL: ' + first.body.reference;
  if (first.body.client_ref !== cr) return 'the browser\u2019s own key was not sent';
  return true;
});

await t('an address that says success proves nothing when the server says it was not paid', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C&status=success&paid=true',
    verify: { status: 200, body: { ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', status: 'pending', activated: false } }
  });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('Care Pass is open') !== -1) return 'it opened coverage on the strength of the URL';
  if (shown.indexOf('not finished yet') === -1 && shown.indexOf('not completed') === -1) {
    return 'it did not tell the customer the payment is unfinished: ' + shown.slice(0, 200);
  }
  if (shown.indexOf('2027') !== -1) return 'it printed coverage dates for an unpaid order';
  return true;
});

await t('a confirmed payment is reported as a term, with the dates the server set', async () => {
  const page = makePage({ search: '?reference=AZ-M4K2P1-9F3A2B1C', verify: activeAnswer(null) });
  await page.boot();
  const shown = page.all();
  const want = ['Care Pass is open', 'AZ-R-M4K2P1-9F3A2B1C', '13 Oct 2026', '10 Feb 2027', '4'];
  const missing = want.filter((w) => shown.indexOf(w) === -1);
  return missing.length ? 'not shown: ' + missing.join(' | ') + ' :: ' + shown.slice(0, 240) : true;
});

await t('the receipt states what was paid and which terms were accepted', async () => {
  const page = makePage({ search: '?reference=AZ-M4K2P1-9F3A2B1C', verify: activeAnswer(null) });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('\u20a620,000') === -1) return 'the amount paid is not on the receipt';
  if (shown.indexOf('v3') === -1) return 'the terms version accepted is not stated';
  return true;
});

await t('a return page that was never shown the terms invents no version', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: activeAnswer(null, { terms_version: null, amount_kobo: null })
  });
  await page.boot();
  const shown = page.all();
  if (/\bv1\b/.test(shown)) return 'it printed a terms version nobody accepted';
  return shown.indexOf('the version on your receipt') !== -1
    ? true : 'it says nothing about which terms apply: ' + shown.slice(0, 200);
});

await t('the private link is used, saved where my-care.html will find it, and points at /my-care', async () => {
  const token = 'Kq7Zx3Nv1Bp0LrT8Yw2Uh5Me6Jd4Sg9Ac8Rf7Vo3Ni2Qb1Xt0';
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: activeAnswer({ token: token, path: '/my-care?t=' + token })
  });
  await page.boot();
  const href = page.api.passHref();
  if (href !== '/my-care?t=' + token) return 'the page built ' + href;
  if (page.store['arzuz_care_token_v1'] !== token) return 'the link was not saved for the pass page';
  const shown = page.all();
  return shown.indexOf('Open your pass') !== -1 ? true : 'no way to open the pass was offered';
});

await t('a link the server merely suggested is never followed as a URL', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: activeAnswer({ token: 'totally-legit-token', path: 'https://evil.test/claim?t=totally-legit-token' })
  });
  await page.boot();
  const html = page.html();
  if (html.indexOf('evil.test') !== -1) return 'the page rendered a URL the server suggested';
  const href = page.api.passHref();
  return href === '/my-care?t=totally-legit-token' ? true : 'it built ' + href;
});

await t('with no link released, the page says so and invents nothing', async () => {
  const page = makePage({ search: '?reference=AZ-M4K2P1-9F3A2B1C', verify: activeAnswer(null) });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('sent separately') === -1) return 'it never explains where the pass link is';
  return page.html().indexOf('/my-care?t=') === -1 ? true : 'it drew a pass link the server did not give';
});

await t('a stored pass from this device is offered back to its owner', async () => {
  const stored = 'stored-token-abcdefabcdef';
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: activeAnswer(null),
    stored: { arzuz_care_token_v1: stored }
  });
  await page.boot();
  const html = page.html();
  return html.indexOf('/my-care?t=' + stored) !== -1 ? true : 'the pass on this device was not offered';
});

await t('a declined attempt opens nothing and offers the same order again', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: { status: 200, body: { ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', status: 'failed', activated: false } }
  });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('not completed') === -1) return 'the failed attempt was not explained';
  if (shown.indexOf('have not been charged') === -1) return 'it does not say the customer was not charged';
  if (!page.el('cpRetry')) return 'no way to try again';
  return shown.indexOf('2027') === -1 ? true : 'it showed coverage for a failed payment';
});

await t('an amount that is not this order is refused and the customer is told not to pay again', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: { status: 409, body: { error: 'That payment does not match this order. We have flagged it and will sort it out — do not pay again.', kind: 'rejected' } }
  });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('do not pay again') === -1 && shown.indexOf('Do not pay again') === -1) {
    return 'it does not warn against paying twice: ' + shown.slice(0, 200);
  }
  return page.el('cpRetry') ? 'it offers to pay again on a mismatch' : true;
});

await t('paid but not opened automatically is escalated, never re-charged', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: { status: 202, body: { ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', status: 'paid', activated: false, message: 'Payment received. Our team is opening your pass by hand — do not pay again.' } }
  });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('by hand') === -1) return 'the customer is not told a person is opening it';
  return page.el('cpRetry') ? 'it offers another payment after a confirmed charge' : true;
});

await t('when the server is unreachable the customer is told it is not their fault', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    verify: () => { throw new Error('boom'); }
  });
  /* fetch rejecting is the offline case; a body-less answer is the other. */
  await page.boot();
  const shown = page.all();
  return shown.indexOf('Nothing was lost') !== -1 || shown.indexOf('not charged') !== -1
    ? true : 'no explanation for an outage: ' + shown.slice(0, 200);
});

await t('a reload without the address still asks about the order this browser began', async () => {
  const cr = '22222222-2222-4222-8222-222222222222';
  const page = makePage({
    search: '',
    verify: { status: 200, body: { ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', status: 'pending', activated: false } },
    stored: {
      'arzuz_pass_client_ref_v1': cr,
      'arzuz_pass_order_v1': JSON.stringify({ reference: 'AZ-M4K2P1-9F3A2B1C', at: '2026-10-13T09:00:00.000Z' })
    }
  });
  await page.boot();
  const first = page.requests[0];
  return first && first.action === 'verify' && first.body.reference === 'AZ-M4K2P1-9F3A2B1C'
    ? true : 'it forgot the order it had begun: ' + JSON.stringify(first && first.body);
});

await t('and once the pass is open it stops asking, and reads the terms again', async () => {
  const page = makePage({
    search: '?reference=AZ-M4K2P1-9F3A2B1C',
    terms: TERMS_OK,
    verify: activeAnswer(null),
    stored: {
      'arzuz_pass_order_v1': JSON.stringify({ reference: 'AZ-M4K2P1-9F3A2B1C', at: '2026-10-13T09:00:00.000Z' })
    }
  });
  await page.boot();
  if (page.store['arzuz_pass_order_v1']) return 'the finished order was left as a pending one';
  const again = makePage({ terms: TERMS_OK, stored: page.store });
  await again.boot();
  return again.requests[0].action === 'terms' ? true : 'it re-verified a finished order: ' + again.requests[0].action;
});

/* ============================================================
   6. LOOKING UP AN OLD ORDER
   ============================================================ */

console.log('\n6. Receipts, without a login\n');

await t('the lookup asks the server about the reference the customer typed', async () => {
  const page = makePage({
    terms: TERMS_OK,
    status: { status: 200, body: { ok: true, reference: 'AZ-M4K2P1-9F3A2B1C', status: 'paid', amount_kobo: 2000000, receipt_ref: 'AZ-R-M4K2P1-9F3A2B1C', activated: true, created_at: '2026-10-13T09:00:00.000Z', coverage: { start: '2026-10-13T09:00:00.000Z', end: '2027-02-10T09:00:00.000Z', call_out_cap: 4 } } }
  });
  await page.boot();
  page.el('cpRef').value = 'az-m4k2p1-9f3a2b1c';
  page.el('cpFind').click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const sent = page.requests.filter((r) => r.action === 'status').slice(-1)[0];
  if (!sent) return 'no lookup was sent';
  if (sent.body.reference !== 'AZ-M4K2P1-9F3A2B1C') return 'the reference was sent as ' + sent.body.reference;
  const keys = Object.keys(sent.body).sort().join(',');
  if (keys !== 'action,reference') return 'the lookup carried ' + keys;
  const shown = page.all();
  const want = ['AZ-R-M4K2P1-9F3A2B1C', '\u20a620,000', '13 Oct 2026', '4'];
  const missing = want.filter((w) => shown.indexOf(w) === -1);
  return missing.length ? 'the receipt did not show: ' + missing.join(' | ') : true;
});

await t('an order with no coverage open is reported as such, not as a pass', async () => {
  const page = makePage({
    terms: TERMS_OK,
    status: { status: 200, body: { ok: true, reference: 'AZ-X', status: 'pending', amount_kobo: 2000000, receipt_ref: null, activated: false, created_at: '2026-10-13T09:00:00.000Z', coverage: null } }
  });
  await page.boot();
  page.el('cpRef').value = 'AZ-X';
  page.el('cpFind').click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const shown = page.read('passLookup');
  if (shown.indexOf('no coverage open') === -1) return 'it did not say there is no coverage: ' + shown.slice(0, 200);
  return shown.indexOf('2027') === -1 ? true : 'it printed coverage dates for an unopened order';
});

await t('an unknown reference shows the server\u2019s own sentence', async () => {
  const page = makePage({
    terms: TERMS_OK,
    status: { status: 404, body: { error: 'No such order.', kind: 'rejected' } }
  });
  await page.boot();
  page.el('cpRef').value = 'AZ-NOPE';
  page.el('cpFind').click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const shown = page.read('passLookup');
  return shown.indexOf('No such order') !== -1 ? true : 'the server\u2019s sentence was not shown: ' + shown.slice(0, 200);
});

/* ============================================================
   7. WHAT MUST NEVER BECOME MARKUP
   ============================================================ */

console.log('\n7. Anything a person typed stays text\n');

await t('a hostile covered line cannot become markup on the page', async () => {
  const nasty = '<img src=x onerror="window.__pwned=1">';
  const page = makePage({
    terms: {
      status: 200,
      body: Object.assign({}, TERMS_OK.body, {
        terms: Object.assign({}, TERMS, { covered: [nasty], support: '"><script>window.__pwned=1</script>' })
      })
    }
  });
  await page.boot();
  const html = page.html();
  if (html.indexOf('<img src=x') !== -1) return 'an unescaped image tag reached the DOM';
  if (/<script/i.test(html)) return 'a script tag reached the DOM';
  return html.indexOf('&lt;img src=x') !== -1 ? true : 'the text was dropped instead of escaped';
});

await t('a hostile name from the terms is escaped in the acceptance line', async () => {
  const page = makePage({
    terms: { status: 200, body: Object.assign({}, TERMS_OK.body, { terms: Object.assign({}, TERMS, { term: '<b>one</b> semester' }) }) }
  });
  await page.boot();
  const html = page.html();
  return html.indexOf('&lt;b&gt;one&lt;/b&gt;') !== -1 ? true : 'the term was not escaped';
});

/* ============================================================
   8. WHEN IT IS NOT ON SALE
   ============================================================ */

console.log('\n8. Sales that have not been approved stay off\n');

await t('no terms means no checkout: no button, no retry, the server\u2019s sentence', async () => {
  const page = makePage({ terms: OFF });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('not on sale') === -1) return 'the customer is not told why: ' + shown.slice(0, 200);
  if (shown.indexOf('approving the coverage terms') === -1) return 'the server\u2019s own sentence was dropped';
  if (page.el('cpPay')) return 'a pay button was drawn for a product that is not on sale';
  if (page.el('cpAccept')) return 'a terms acceptance was drawn with no terms';
  return shown.indexOf('Try again') === -1 ? true : 'it invited a retry for a decision nobody can retry';
});

await t('an outage is not the same as not being on sale', async () => {
  const page = makePage({ terms: { status: 502, body: { error: 'Arzuz could not take that just now.' } } });
  await page.boot();
  const shown = page.all();
  if (shown.indexOf('not on sale') !== -1) return 'a temporary failure was reported as a closed shop';
  return shown.indexOf('Try again') !== -1 ? true : 'no way to try again after an outage: ' + shown.slice(0, 200);
});

/* ============================================================
   REPORT
   ============================================================ */

console.log('\n' + '='.repeat(64));
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
console.log('TOTAL ' + (passed + failures.length) + ' \u00b7 PASS ' + passed + ' \u00b7 FAIL ' + failures.length);
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);
