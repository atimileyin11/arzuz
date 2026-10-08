#!/usr/bin/env node
/* ============================================================
   Arzuz — homepage motion, placement and write-boundary test

   Loads the REAL index.html in headless Chrome at desktop and
   mobile widths and asserts on what the browser actually did:

     · the motion layer boots and every .rv reveal lands
       (a reveal that never fires leaves content invisible for good)
     · the hero plate animates on mobile too, sits whole inside the
       hero, and overlaps no copy, button or link
     · the demand-curve bars actually fill at both widths
     · a hostile value written into the page (a missing or
       non-numeric highlight width, a junk data-depth) can never
       reach the DOM as an invalid style — the write boundary
     · nothing overflows sideways and every section keeps its place
     · with prefers-reduced-motion: reduce, everything is visible
       immediately and no motion is left running

   Run from arzuz-site/:
     node scripts/test-home-motion.mjs
     node scripts/test-home-motion.mjs --width=mobile
     node scripts/test-home-motion.mjs --base=http://localhost:8123
     node scripts/test-home-motion.mjs --urls

   Zero dependencies: Node's global WebSocket drives the Chrome,
   Edge or Chromium already on the machine over the DevTools
   protocol, and scripts/dev-server.mjs is started when nothing
   is listening.
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const baseArg = argVal('base');
const widthArg = argVal('width');
const pageArg = argVal('page') || 'index.html';
const urlsOnly = args.includes('--urls');

const WIDTHS = [
  { key: 'desktop', w: 1440, h: 900 },
  { key: 'mobile', w: 390, h: 844 }
];

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
    this.listeners = [];
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  }
  async close() { try { this.ws.close(); } catch {} }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket error')); });
  });
}

/* ---------------- the in-page probe ----------------
   One expression, run after a full scroll pass. It measures geometry and
   computed styles only — nothing is mocked and nothing is stubbed, so what
   it reports is what a visitor gets. */
const PROBE = `(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var H = document.documentElement;
  var out = {};

  /* ---- walk the whole page so every scroll reveal has its chance ----
     scroll-behavior is forced to auto for the sweep: the page scrolls
     smoothly by design, and a programmatic jump that animates never
     actually lands where it was asked to, so the sweep would stop short of
     the page bottom and the last sections would look permanently hidden.

     Two properties of the page itself, both of which the test has to
     respect rather than blame the reveals for: the height is still settling
     on a cold first paint (webfonts swap, late images take their space), so
     the sweep waits for the fonts and then re-reads the height at every step
     instead of trusting one number captured up front; and it records where it
     actually landed, so a sweep that stopped short reports itself as a sweep
     that stopped short. A visitor's scroll is driven by the live height, so
     anything else is measuring a page nobody gets. */
  var prevBehavior = H.style.scrollBehavior;
  H.style.scrollBehavior = 'auto';
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  var settled = H.scrollHeight;
  for (var s = 0; s < 8; s++) {
    await sleep(120);
    if (H.scrollHeight === settled) break;
    settled = H.scrollHeight;
  }
  var liveMax = function () { return Math.max(0, H.scrollHeight - window.innerHeight); };
  var steps = 30;
  for (var i = 0; i <= steps; i++) {
    window.scrollTo(0, Math.round(liveMax() * i / steps));
    await sleep(90);
  }
  window.scrollTo(0, liveMax());
  await sleep(600);
  out.sweepLandedAt = Math.round(window.scrollY);
  await sleep(150);
  out.sweepWanted = liveMax();
  out.heightStart = settled;
  out.heightEnd = H.scrollHeight;
  window.scrollTo(0, 0);
  await sleep(1500);
  H.style.scrollBehavior = prevBehavior;

  var rect = function (sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  var overlap = function (a, b) {
    if (!a || !b) return 0;
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? Math.round(w * h) : 0;
  };
  var cs = function (sel, prop) {
    var el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };

  /* ---- 1. reveals landed ---- */
  var rv = [].slice.call(document.querySelectorAll('.rv'));
  out.rvTotal = rv.length;
  out.rvIn = rv.filter(function (e) { return e.classList.contains('in'); }).length;
  var invisible = [];
  rv.forEach(function (e, i) {
    var st = getComputedStyle(e);
    var op = parseFloat(st.opacity);
    if (!(op > 0.99)) invisible.push({ i: i, cls: e.className, opacity: st.opacity });
    /* a reveal that is still translated has not finished its entrance */
    if (st.transform && st.transform !== 'none' && !/matrix\\(1, 0, 0, 1, 0, 0\\)/.test(st.transform)) {
      invisible.push({ i: i, cls: e.className, transform: st.transform });
    }
  });
  out.rvInvisible = invisible.slice(0, 6);
  out.rvInvisibleCount = invisible.length;
  out.rvNotRevealed = rv.filter(function (e) { return !e.classList.contains('in'); })
    .map(function (e) { return e.className; }).slice(0, 8);

  /* ---- 2. the hero plate: in its place, whole, and moving ---- */
  var hero = rect('.h-hero');
  var scene = rect('.h-scene');
  var copy = rect('.h-copy');
  var doors = rect('.h-doors');
  var third = document.querySelector('.h-third');
  var thirdR = third ? (function () { var r = third.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })() : null;
  var strip = rect('.h-strip');

  out.scene = scene;
  out.hero = hero;
  out.copyOverlap = overlap(scene, copy);
  out.doorsOverlap = overlap(scene, doors);
  out.thirdOverlap = overlap(scene, thirdR);
  out.sceneInsideHero = !!(scene && hero &&
    scene.top >= hero.top - 1 && scene.left >= hero.left - 1 &&
    scene.bottom <= hero.bottom + 1 && scene.right <= hero.right + 1);
  out.sceneAboveStrip = !!(scene && strip && scene.bottom <= strip.top + 1);
  out.sceneOpacity = parseFloat(cs('.h-scene', 'opacity'));
  out.sceneAnim = cs('.h-scene', 'animationName');
  out.sceneAnimDur = cs('.h-scene', 'animationDuration');
  out.motionReady = document.documentElement.classList.contains('motion-ready');

  /* ---- 3. the bar wall filled ---- */
  var barsEls = [].slice.call(document.querySelectorAll('#bars i'));
  out.barsTotal = barsEls.length;
  out.barsFilled = barsEls.filter(function (el) {
    var m = getComputedStyle(el).transform.match(/matrix\\(([^)]+)\\)/);
    var sx = m ? parseFloat(m[1].split(',')[0]) : 0;
    out['bar_' + el.dataset.lo] = sx;
    return sx > 0.001;
  }).length;

  /* ---- 4. layout: no sideways scroll, sections in order ---- */
  out.scrollWidth = H.scrollWidth;
  out.innerWidth = window.innerWidth;
  var offenders = [];
  [].slice.call(document.querySelectorAll('body *')).forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 1) offenders.push(el.className || el.tagName);
  });
  out.wideOffenders = offenders.slice(0, 5);

  var order = ['.h-hero', '.h-strip', '.h-band', '.h-sec', '.h-close'].map(function (sel, idx) {
    var els = [].slice.call(document.querySelectorAll(sel));
    return els.map(function (e) { return { sel: sel, i: idx, top: Math.round(e.getBoundingClientRect().top + window.scrollY) }; });
  });
  var flat = [];
  order.forEach(function (g) { flat = flat.concat(g); });
  flat.sort(function (a, b) { return a.top - b.top; });
  out.orderPreserved = flat.every(function (s, i) { return i === 0 || s.i >= flat[i - 1].i; });
  out.orderSeen = flat.map(function (s) { return s.sel; }).join(' > ');

  /* ---- 5. the write boundary, exercised with hostile values ----
     These two injections are the whole point: a value that never existed in
     the source (a blank or junk highlight width, a junk depth) must be
     refused at the point it would be written, not turned into NaN. */
  var bar = barsEls[0];
  bar.dataset.w = 'abc';
  bar.style.transform = '';
  barsEls[1].dataset.w = '500';
  barsEls[1].style.transform = '';
  if (typeof window.fillBars === 'function') window.fillBars();
  /* the fill is staggered 80ms per bar, so the last one lands at ~400ms */
  await sleep(600);
  out.badWidthWrite = bar.style.transform;
  out.hugeWidthWrite = barsEls[1].style.transform;

  var host = document.createElement('div');
  host.setAttribute('data-scene', '');
  host.style.cssText = 'position:fixed;top:0;left:0;width:220px;height:220px;opacity:0;pointer-events:none;z-index:-1';
  host.innerHTML = '<div data-scene-stage></div>' +
    '<div data-depth="junk" data-z="nonsense"></div>' +
    '<div data-depth="0.5" data-z="10"></div>';
  document.body.appendChild(host);
  if (window.ArzuzMotion && window.ArzuzMotion.scan) window.ArzuzMotion.scan();
  await sleep(320);
  var layers = [].slice.call(host.querySelectorAll('[data-depth]'));
  layers.forEach(function (l) {
    l.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 200, clientY: 200 }));
  });
  host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 200, clientY: 40 }));
  await sleep(320);
  out.junkLayerTransform = layers[0].style.transform;
  out.goodLayerTransform = layers[1].style.transform;
  var stage = host.querySelector('[data-scene-stage]');
  out.junkStageTransform = stage.style.transform;
  host.remove();

  /* every inline transform on the page, to be certain none of them is invalid */
  var badInline = [];
  [].slice.call(document.querySelectorAll('body *')).forEach(function (el) {
    var t = el.style && el.style.transform ? el.style.transform : '';
    if (/NaN|Infinity|undefined/.test(t)) badInline.push((el.className || el.tagName) + ' => ' + t);
  });
  out.badInlineTransforms = badInline.slice(0, 5);

  return JSON.stringify(out);
})()`;

/* the same measurements, but taken without scrolling at all — the
   reduced-motion path has to be readable immediately */
const REDUCED_PROBE = `(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  await sleep(700);
  var rv = [].slice.call(document.querySelectorAll('.rv'));
  var hidden = rv.filter(function (e) { return !(parseFloat(getComputedStyle(e).opacity) > 0.99); });
  var barsEls = [].slice.call(document.querySelectorAll('#bars i'));
  var filled = barsEls.filter(function (el) {
    var m = getComputedStyle(el).transform.match(/matrix\\(([^)]+)\\)/);
    return (m ? parseFloat(m[1].split(',')[0]) : 0) > 0.001;
  });
  return JSON.stringify({
    rvTotal: rv.length,
    rvHidden: hidden.length,
    rvHiddenSample: hidden.slice(0, 4).map(function (e) { return e.className; }),
    barsTotal: barsEls.length,
    barsFilled: filled.length,
    sceneAnim: (function () { var s = document.querySelector('.h-scene'); return s ? getComputedStyle(s).animationName : null; })(),
    sceneDur: (function () { var s = document.querySelector('.h-scene'); return s ? getComputedStyle(s).animationDuration : null; })(),
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  });
})()`;

/* ---------------- base server ---------------- */

async function reachable(base) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(base + '/index.html', { signal: c.signal });
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

/* ---------------- expectations ---------------- */

function checks(page, vp) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
  const finite = v => typeof v === 'number' && isFinite(v);
  const px = v => (finite(v) ? Math.round(v) + 'px' : String(v));
  const mobile = vp.w < 940;

  t('the motion layer booted (html.motion-ready)',
    page.motionReady === true, 'assets/motion.js did not run — every reveal would be gated off');

  /* the sweep's own precondition: a sweep that stopped short would leave the
     last sections looking permanently hidden, which is a broken test, not a
     broken page — say so instead of blaming the reveals */
  t('the sweep reached the bottom of the page',
    finite(page.sweepLandedAt) && finite(page.sweepWanted) && page.sweepLandedAt >= page.sweepWanted - 4,
    'sweep parked at ' + page.sweepLandedAt + ' but the page bottom is at ' + page.sweepWanted +
    ' (height ' + page.heightStart + ' → ' + page.heightEnd + ')');

  t('all ' + page.rvTotal + ' scroll reveals landed',
    page.rvTotal > 0 && page.rvIn === page.rvTotal,
    page.rvIn + ' of ' + page.rvTotal + ' revealed' +
    (page.rvNotRevealed && page.rvNotRevealed.length ? ' — never revealed: ' + page.rvNotRevealed.join(' | ') : ''));

  t('no revealed section is left invisible or mid-transform',
    page.rvInvisibleCount === 0,
    JSON.stringify(page.rvInvisible));

  t('the hero plate is animating',
    typeof page.sceneAnim === 'string' && page.sceneAnim !== 'none',
    'animation-name is ' + page.sceneAnim + ' — the plate is static');

  t('the hero plate sits whole inside the hero',
    page.sceneInsideHero === true && page.sceneAboveStrip === true,
    'scene ' + JSON.stringify(page.scene) + ' hero ' + JSON.stringify(page.hero));

  t('the hero plate covers no copy, button or link',
    page.copyOverlap === 0 && page.doorsOverlap === 0 && page.thirdOverlap === 0,
    'overlap with copy ' + page.copyOverlap + 'px², with the buttons ' + page.doorsOverlap +
    'px², with the secondary links ' + page.thirdOverlap + 'px²');

  if (mobile) {
    t('the hero plate is actually visible on mobile',
      page.sceneOpacity >= 0.9 && page.scene && page.scene.width >= 100 && page.scene.height >= 100,
      'opacity ' + page.sceneOpacity + ', size ' +
      (page.scene ? px(page.scene.width) + '×' + px(page.scene.height) : 'none'));
  }

  t('every one of the ' + page.barsTotal + ' demand bars filled',
    page.barsTotal > 0 && page.barsFilled === page.barsTotal,
    page.barsFilled + ' of ' + page.barsTotal + ' filled');

  t('nothing scrolls sideways',
    page.scrollWidth <= page.innerWidth + 1,
    'scrollWidth ' + page.scrollWidth + ' vs viewport ' + page.innerWidth +
    (page.wideOffenders.length ? ' — past the edge: ' + page.wideOffenders.join(', ') : ''));

  t('sections keep their order down the page',
    page.orderPreserved === true, page.orderSeen);

  /* the write boundary */
  t('a junk highlight width is written as scaleX(0), never NaN',
    page.badWidthWrite === 'scaleX(0)',
    'wrote "' + page.badWidthWrite + '"');

  t('an out-of-range highlight width is clamped, not written raw',
    page.hugeWidthWrite === 'scaleX(1)',
    'wrote "' + page.hugeWidthWrite + '"');

  const junkOk = !/NaN|Infinity|undefined/.test(String(page.junkLayerTransform || '') + String(page.junkStageTransform || ''));
  t('a junk data-depth never reaches the DOM as an invalid transform',
    junkOk, 'layer "' + page.junkLayerTransform + '" / stage "' + page.junkStageTransform + '"');

  const goodOk = /translate3d\(\s*-?[\d.]+px,\s*-?[\d.]+px,\s*-?[\d.]+px\)/.test(String(page.goodLayerTransform || ''));
  t('a valid depth still moves (the guard does not disable the motion)',
    goodOk, 'layer "' + page.goodLayerTransform + '"');

  t('no invalid inline transform anywhere on the page',
    page.badInlineTransforms.length === 0, page.badInlineTransforms.join(' | '));

  return out;
}

function reducedChecks(page, vp) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });

  t('reduced motion: every reveal is visible without any scrolling',
    page.rvTotal > 0 && page.rvHidden === 0,
    page.rvHidden + ' of ' + page.rvTotal + ' still hidden (' + page.rvHiddenSample.join(', ') + ')');

  t('reduced motion: the bars show their real widths straight away',
    page.barsTotal > 0 && page.barsFilled === page.barsTotal,
    page.barsFilled + ' of ' + page.barsTotal + ' filled');

  t('reduced motion: the plate is not left running a long animation',
    page.sceneDur === null || parseFloat(page.sceneDur) <= 0.05,
    'animation-duration is ' + page.sceneDur);

  t('reduced motion: nothing scrolls sideways',
    page.scrollWidth <= page.innerWidth + 1,
    'scrollWidth ' + page.scrollWidth + ' vs viewport ' + page.innerWidth);

  return out;
}

/* ---------------- main ---------------- */

(async function main() {
  const base = baseArg || 'http://localhost:8123';
  if (urlsOnly) {
    console.log('Open the homepage these checks run against:\n');
    console.log('  ' + base + '/' + pageArg + '\n');
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
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-home-'));
  console.log('Arzuz — homepage motion, placement and write-boundary test');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('page    ' + pageArg);
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

    const url = base + '/' + pageArg;

    const run = async (vp, label, expression, list) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
      });

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

      let page = null, failure = null;
      try {
        await cdp.send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 600));
        await cdp.evaluate(expression).then(raw => { page = JSON.parse(raw); });
      } catch (e) {
        failure = e.message;
      }
      cdp.listeners = cdp.listeners.filter(f => f !== spy);

      total++;
      if (failure || !page) {
        console.log('\n' + label + '\n  ✗ ' + (failure || 'the page never reported back'));
        failed++;
        return;
      }

      const all = list(page, vp).concat([{
        name: 'no uncaught errors, no console errors', ok: cdpErrors.length === 0, note: cdpErrors.join(' | ')
      }]);
      const bad = all.filter(x => !x.ok);
      total += all.length;
      failed += bad.length;

      console.log('\n' + label);
      if (!bad.length) {
        console.log('  ✓ ' + all.length + '/' + all.length + ' checks passed');
      } else {
        for (const x of bad) console.log('  ✗ ' + x.name + (x.note ? '\n      → ' + x.note : ''));
        console.log('  ' + (all.length - bad.length) + '/' + all.length + ' checks passed');
      }
    };

    for (const vp of widths) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await run(vp, 'DEFAULT · ' + vp.key + ' ' + vp.w + 'px', PROBE, checks);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      });
      await run(vp, 'REDUCED · ' + vp.key + ' ' + vp.w + 'px', REDUCED_PROBE, reducedChecks);
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
