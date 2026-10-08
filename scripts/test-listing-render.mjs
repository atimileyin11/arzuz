#!/usr/bin/env node
/* ============================================================
   Arzuz — listing page render stress test

   Loads the REAL listing.html in headless Chrome, once per
   dataset, and asserts on what it actually rendered. The
   datasets live in dev/listing-fixture.js — the same file the
   browser harness loads — so the page under test and the
   assertions can never drift apart.

   Run from arzuz-site/:
     node scripts/test-listing-render.mjs
     node scripts/test-listing-render.mjs --case=worst     one case, full detail
     node scripts/test-listing-render.mjs --urls           print the harness URLs
     node scripts/test-listing-render.mjs --base=http://localhost:8799
     node scripts/test-listing-render.mjs --dump           save each rendered body

   Zero dependencies. It drives the Chrome/Edge/Chromium already on
   the machine over the DevTools protocol (Node's global WebSocket),
   and starts scripts/dev-server.mjs itself when nothing is listening.
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const onlyCase = argVal('case');
const baseArg = argVal('base');
const widthArg = argVal('width');          /* desktop | mobile | both (default both) */
const urlsOnly = args.includes('--urls');
const keepBody = args.includes('--dump');

const WIDTHS = [
  { key: 'desktop', w: 1440, h: 900 },
  { key: 'mobile', w: 390, h: 844 }
];

/* ---------------- datasets (from the shared fixture) ---------------- */

async function loadFixture() {
  const src = await readFile(join(SITE, 'dev/listing-fixture.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;ARZUZ_LISTING_FIXTURE', sandbox, { filename: 'dev/listing-fixture.js' });
  const fx = sandbox.ARZUZ_LISTING_FIXTURE;
  if (!fx || !fx.cases) throw new Error('dev/listing-fixture.js did not expose ARZUZ_LISTING_FIXTURE.cases');
  return fx;
}

/* ---------------- chrome ---------------- */

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/c/Program Files/Google/Chrome/Application/chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

const findChrome = () => CHROME_PATHS.find(existsSync) || null;

async function launchChrome(bin, profile) {
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--hide-scrollbars', '--window-size=1440,900', '--disable-background-networking',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'
  ], { windowsHide: true });

  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome never reported a DevTools endpoint.\n' + stderr.slice(-400))), 25000);
    child.stderr.on('data', d => {
      stderr += d;
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', c => { clearTimeout(timer); reject(new Error('Chrome exited early (' + c + ')')); });
  });
  return { child, endpoint };
}

/* minimal CDP client over one page target */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        this.listeners.forEach(fn => fn(msg));
      }
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  }
  async close() {
    try { this.ws.close(); } catch {}
  }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', e => { clearTimeout(timer); reject(new Error('CDP socket error')); });
  });
}

/* the bundle the page hands back once the listing has settled */
const READOUT = `(function(){
  function disp(id){ var el=document.getElementById(id); if(!el) return 'missing';
    var v=getComputedStyle(el).display; return v; }
  var d=document.getElementById('__fx-diag');
  return JSON.stringify({
    diag: d ? d.textContent : '',
    content: (document.getElementById('ldContent')||{}).outerHTML || '',
    errorDisplay: disp('ldError'),
    skeletonDisplay: disp('ldSkeleton'),
    hasRouteMap: !!document.getElementById('routeMap'),
    ready: !!d
  });
})()`;

async function render(cdp, url, timeoutMs = 30000) {
  await cdp.send('Page.navigate', { url });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    let raw;
    try { raw = await cdp.evaluate(READOUT); } catch { continue; }
    let page;
    try { page = JSON.parse(raw); } catch { continue; }
    if (page.ready && page.diag) {
      try { page.diagParsed = JSON.parse(page.diag); } catch { page.diagParsed = null; }
      last = page;
      /* the probe writes `overflow` last — that is the settled signal */
      if (page.diagParsed && page.diagParsed.overflow) return page;
    }
  }
  if (last) return last;
  throw new Error('the page never reported back (listed at ' + url + ')');
}

/* ---------------- base server ---------------- */

async function reachable(base) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(base + '/dev/listing-harness.html', { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function ensureServer(base) {
  if (await reachable(base)) return { base, child: null };
  const port = new URL(base).port || '8123';
  const child = spawn(process.execPath, [join(SITE, 'scripts/dev-server.mjs'), port], { cwd: SITE, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await reachable(base)) return { base, child };
  }
  child.kill();
  throw new Error('dev server never answered on ' + base);
}

/* ---------------- reading what rendered ---------------- */

const unescapeHtml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/* exact element counts: a plain substring count also matches the container
   class ("gal-thumb" counts "gal-thumbs", "feat" counts "feat-grid") */
const countRe = (hay, re) => (hay.match(re) || []).length;
const SLIDES = /<div class="gal-slide"/g;
const THUMBS = /<button type="button" class="gal-thumb/g;
const FEATURES = /<div class="feat /g;
const STEPS = /<li data-lat/g;
const textOf = (html, re) => { const m = html.match(re); return m ? unescapeHtml(m[1]).trim() : null; };

/* ---------------- expectations ---------------- */

/* true of every valid row, whatever the data */
function universal(page) {
  const content = page.content;
  const diag = page.diagParsed;
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });

  t('no console errors, no uncaught errors',
    diag.errors.length === 0 && page.cdpErrors.length === 0,
    (diag.errors.concat(page.cdpErrors)).join(' | '));
  t('no write reached the backend', diag.writes.length === 0, diag.writes.join(' | '));
  t('the listing rendered, not the error state', page.errorDisplay === 'none', 'the error state is showing');
  t('the loading skeleton is gone', page.skeletonDisplay === 'none', 'the skeleton is still visible');
  t('no NaN / undefined / [object Object] in the output',
    !/NaN|undefined|\[object Object\]/.test(content),
    (content.match(/.{0,40}(NaN|undefined|\[object Object\]).{0,40}/) || [''])[0]);
  t('data never lands as markup', !/<script/i.test(content), 'a <script> appeared inside the rendered listing');
  t('the page asked for exactly one listing row', diag.calls.filter(c => c.includes('public_listings')).length === 1,
    diag.calls.join(' | '));
  t('nothing overflows its box',
    !diag.overflow.horizontal && diag.overflow.offenders.length === 0,
    JSON.stringify(diag.overflow.offenders));
  t('no feature chip rendered blank',
    !/<div class="feat[^"]*"[^>]*>\s*<span class="ic">[^<]*<\/span><span>\s*<\/span>/.test(content),
    'a feature chip has an icon but no label');
  t('the page rendered real content', diag.contentChars > 0, 'the listing had no text at all');
  return out;
}

const EXPECT = {
  demo: {
    title: 'Ilorin Close Self-Contain', badge: 'Inspected', price: '₦185,000',
    slides: 3, thumbs: 3, features: 4,
    hasRouteMap: true, hasPassage: true, hasAbout: true, comingSoon: false
  },
  worst: {
    /* tier is the string 'verified' → Number() is NaN → the honest badge, not "NaN" */
    title: 'OLUWASEUNBABATUNDEADEGOKEMEMORIALSTUDENTLODGEANDSUITESSMALETE',
    badge: 'Unverified',
    /* a hand-edited "150,000" must print as a price, not as ₦NaN */
    price: '₦150,000',
    slides: 3, thumbs: 3,   /* the entry with no url drops; the rest are shown */
    features: 4,            /* '', null and 42 drop; the four real labels stay */
    hasRouteMap: false,     /* latitude without longitude is not a location */
    hasPassage: true, hasAbout: true, comingSoon: false,
    escapedScriptTag: true, longName: true
  },
  halfpos: {
    title: 'Adebayo Lodge', badge: 'Community verified', price: '₦170,000',
    slides: 2, thumbs: 2,
    hasRouteMap: false, hasPassage: false, hasAbout: true, comingSoon: false
  },
  empty: {
    title: 'Unnamed property', badge: 'Unverified', price: '₦0',
    slides: 1, thumbs: 0,   /* one placeholder frame saying "Photos coming soon" */
    features: 0,
    hasRouteMap: false, hasPassage: false, hasAbout: false, comingSoon: true
  },
  one: {
    title: 'Jo Lodge', badge: 'Community verified', price: '₦95,000',
    slides: 1, thumbs: 0, features: 1,
    hasRouteMap: true, hasPassage: false, hasAbout: true, comingSoon: false, noChip: true
  },
  huge: {
    title: 'Grand Imperial Student Village Phase 2 Annex Extension',
    badge: 'Inspected', price: '₦123,456,789',
    slides: 50, thumbs: 50, features: 40, steps: 12,
    hasRouteMap: true, hasPassage: true, hasAbout: true, comingSoon: false,
    chip: '1 / 50', videoThumb: true, escapedScriptTag: true
  }
};

function specifics(name, page) {
  const exp = EXPECT[name];
  const content = page.content;
  const diag = page.diagParsed;
  const out = [];
  const t = (n, ok, note) => out.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });

  const title = textOf(content, /<h1>([\s\S]*?)<\/h1>/);
  const badge = textOf(content, /class="h-badge[^"]*">([^<]*)</);
  const price = textOf(content, /class="ld-price">([^<]*)</);

  t('title', title === exp.title, 'got "' + title + '"');
  t('verification badge', badge === exp.badge, 'got "' + badge + '"');
  t('price', price === exp.price, 'got "' + price + '"');

  if (exp.slides !== undefined) {
    const n = countRe(content, SLIDES);
    t(exp.slides + ' gallery slide' + (exp.slides === 1 ? '' : 's'), n === exp.slides, 'got ' + n);
  }
  if (exp.thumbs !== undefined) {
    const n = countRe(content, THUMBS);
    t(exp.thumbs + ' thumbnail' + (exp.thumbs === 1 ? '' : 's'), n === exp.thumbs, 'got ' + n);
  }
  if (exp.features !== undefined) {
    const n = countRe(content, FEATURES);
    t(exp.features + ' feature chip' + (exp.features === 1 ? '' : 's'), n === exp.features, 'got ' + n);
  }
  if (exp.steps !== undefined) {
    const n = countRe(content, STEPS);
    t(exp.steps + ' passage steps', n === exp.steps, 'got ' + n);
  }
  if (exp.chip) t('gallery counter reads "' + exp.chip + '"', content.includes('>' + exp.chip + '<'), 'counter missing or wrong');
  if (exp.noChip) t('a single photo shows no counter', !content.includes('gal-chip'), 'a counter was shown for one photo');

  t('"Getting there" map ' + (exp.hasRouteMap ? 'present' : 'absent'),
    page.hasRouteMap === exp.hasRouteMap,
    exp.hasRouteMap ? 'no routeMap mounted' : 'a map was mounted without a complete pin');
  t('passage card ' + (exp.hasPassage ? 'present' : 'absent'),
    content.includes('passage-card') === exp.hasPassage, 'passage card mismatch');
  t('"About this place" ' + (exp.hasAbout ? 'present' : 'absent'),
    content.includes('About this place') === exp.hasAbout, 'description section mismatch');
  t('photo placeholder ' + (exp.comingSoon ? 'shown' : 'absent'),
    content.includes('Photos coming soon') === exp.comingSoon, 'placeholder mismatch');

  if (exp.escapedScriptTag) {
    t('a <script> tag in the description renders as text',
      content.includes('&lt;script&gt;alert(1)'), 'the description was not escaped');
  }
  if (exp.longName) {
    t('a long unbroken name stays inside its heading',
      !diag.overflow.offenders.some(o => o.sel.startsWith('#ldContent h1')),
      'the h1 text ran past its box');
  }
  if (exp.videoThumb) {
    t('the video thumbnail anchors its ▶ overlay inside itself',
      diag.thumbsPositioned !== false && diag.thumbsPositioned !== null,
      'no positioned ancestor for .gal-thumb::after — inset:0 escapes the thumb');
  }
  return out;
}

/* ---------------- main ---------------- */

(async function main() {
  const fx = await loadFixture();
  const cases = onlyCase ? [onlyCase] : fx.order;
  for (const c of cases) if (!fx.cases[c]) throw new Error('unknown case "' + c + '" — have: ' + fx.order.join(', '));

  const base = baseArg || 'http://localhost:8123';
  if (urlsOnly) {
    console.log('Open any of these, then use the switcher at the bottom of the page:\n');
    for (const c of cases) console.log('  ' + base + '/dev/listing-harness.html?case=' + c);
    console.log('\n(the harness loads the real listing.html; nothing here ships)');
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome/Edge/Chromium found. Set CHROME_PATH to the executable.');
    process.exitCode = 2;
    return;
  }

  const widths = WIDTHS.filter(w => !widthArg || widthArg === 'both' || widthArg === w.key);
  if (!widths.length) throw new Error('--width must be desktop, mobile or both');

  const { child: serverChild } = await ensureServer(base);
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-listing-'));
  console.log('Arzuz — listing render stress test');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('cases   ' + cases.join(', '));
  console.log('widths  ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', '));

  let total = 0, failed = 0;
  let chromeChild = null, cdp = null;
  try {
    const launched = await launchChrome(chrome, profile);
    chromeChild = launched.child;
    const port = new URL(launched.endpoint).port;
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const target = targets.find(t => t.type === 'page');
    if (!target) throw new Error('no page target in Chrome');
    cdp = new CDP(await openWs(target.webSocketDebuggerUrl));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const name of cases) {
      const url = base + '/dev/listing-harness.html?case=' + name + '&id=fx-' + name;

      for (const vp of widths) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
        });

        /* collect what the page itself threw this run */
        const cdpErrors = [];
        const spy = msg => {
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            cdpErrors.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
          }
          if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            cdpErrors.push('console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
          }
        };
        cdp.listeners.push(spy);

        const label = name.toUpperCase() + ' · ' + vp.key + ' ' + vp.w + 'px';
        let page = null, failure = null;
        try {
          page = await render(cdp, url);
        } catch (e) {
          failure = e.message;
        }
        cdp.listeners = cdp.listeners.filter(f => f !== spy);

        if (!failure && (!page || !page.diagParsed)) failure = 'the fixture never reported back — did the page boot?';
        if (failure) {
          console.log('\n' + label + '\n  ✗ ' + failure);
          total++; failed++;
          continue;
        }

        page.cdpErrors = cdpErrors;
        if (keepBody) {
          const p = join(tmpdir(), 'arzuz-listing-' + name + '-' + vp.key + '.html');
          await writeFile(p, page.content, 'utf8');
          console.log('  body → ' + p);
        }

        const checks = universal(page).concat(specifics(name, page));
        const bad = checks.filter(x => !x.ok);
        total += checks.length; failed += bad.length;

        console.log('\n' + label);
        if (!bad.length) {
          console.log('  ✓ ' + checks.length + '/' + checks.length + ' checks passed');
        } else {
          for (const x of bad) console.log('  ✗ ' + x.name + (x.note ? '\n      → ' + x.note : ''));
          console.log('  ' + (checks.length - bad.length) + '/' + checks.length + ' checks passed');
        }
      }
      console.log('  (' + fx.cases[name].note + ')');
    }
  } finally {
    if (cdp) await cdp.close();
    if (chromeChild) chromeChild.kill();
    if (serverChild) serverChild.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + total + ' · PASS ' + (total - failed) + ' · FAIL ' + failed);
  if (failed) process.exitCode = 1;
})();
