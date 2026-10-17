#!/usr/bin/env node
/* ============================================================
   Arzuz — the hero object's geometry, checked where it is drawn

   dev/hero-object.md is the page a future editor reads before touching the
   landing page's hero, and its middle section is a claim: the two scales are
   not two arrangements but one, because every POSITION is derived from four
   values the breakpoints set (--seal, --gutter, --lit and the turns).

     --seal-over = seal × .1     how far the seal crosses the paper's edge
     --seal-band = seal + 8px    the strip of plan above the panel
     --foot      = seal × .22    the plan showing under the panel
     stage padding = band / gutter + over / foot / gutter

   That claim is only as good as the last person to touch --seal. This suite
   is the note's table, executable: it loads the real page at both scales and
   asserts the derived relationships (not the incidental numbers) on live
   layout boxes — so changing a value and forgetting that the band, the
   overhang, the foot and the gutters follow it is a red run, not a slow
   drift nobody sees until the composition looks wrong on a phone.

   Layout, not paint: every measurement here comes from offsetLeft/offsetTop/
   offsetWidth/offsetHeight, which are transform-free. getBoundingClientRect
   would fold in --paper-turn at 1440 and --seal-turn on the disc, and this
   suite is about where the plates LAND, not how they are turned. The turns
   and the shadows are the motion suite's business.

   The seal's landing is the one that reads wrong first when the chain breaks:
   it is inset from the right by nothing (right: 0 on the stage's padding box)
   while the PAPER is inset by --seal-over, so disc and sheet land together on
   the column's edge. Assert that pair together, always: the seal can be flush
   while the paper has quietly grown, and then the overhang is a lie.

   The padding is also poked at on purpose, twice, in every run. It is written
   from four values a reader is invited to tune, and the two hand edits this has
   actually seen are both here: `--seal-over: 0` (the obvious way to say "no
   overhang") and a `--foot` left unitless. Written as one shorthand those two
   took the band, the foot and BOTH gutters down with them — a component the
   declaration could not parse makes the whole declaration invalid at
   computed-value time, so the stage lost its padding entirely and the object
   collapsed into its own corner. Written as four longhands (and registered as
   lengths, see the @property block in index.html) each costs only the edge it
   names. So the suite asserts the pair — the named edge gives way, the other
   three are still the object — and a browser that lost that property would fail
   here rather than in a reader's eyes.

   Run from arzuz-site/:
     node scripts/test-hero-geometry.mjs
     node scripts/test-hero-geometry.mjs --width=mobile
     node scripts/test-hero-geometry.mjs --base=http://localhost:8123
     node scripts/test-hero-geometry.mjs --urls
     node scripts/test-hero-geometry.mjs --page=<file>   measure another page

   Zero dependencies: Node's global WebSocket drives the Chrome, Edge or
   Chromium already on the machine over the DevTools protocol, and
   scripts/dev-server.mjs is started when nothing is listening.
   ============================================================ */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
/* ARZUZ_TEST_BASE does the same job as --base for the whole family:
   scripts/test-all.mjs passes it through, so two checkouts (or an agent and a
   person) can run these at once without fighting over port 8123. */
const baseArg = argVal('base') || process.env.ARZUZ_TEST_BASE || null;
const widthArg = argVal('width');
const pageArg = argVal('page') || 'index.html';
const urlsOnly = args.includes('--urls');

const WIDTHS = [
  { key: 'desktop', w: 1440, h: 900 },
  { key: 'mobile', w: 390, h: 844 }
];

/* The two scales' own values, straight out of the note's table. These are the
   only absolute numbers in here: everything else is derived from them, so a
   deliberate change to --seal is a change to this table and to
   dev/hero-object.md in the same breath — which is exactly the coupling the
   note warns about. */
const SCALES = {
  desktop: { seal: 156, gutter: 30, lit: 16 },
  mobile: { seal: 108, gutter: 15, lit: 8 }
};

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
    /* a launch is a wait, not a verdict: the gate runs this beside other
       browser suites, and Chrome can take a long time to say "here I am" on a
       loaded box while being perfectly fine */
    const timer = setTimeout(() => reject(new Error('Chrome never reported a DevTools endpoint in 60s.\n' + stderr.slice(-400))), 60000);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || ''));
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
   One expression, run once per scale, measuring layout boxes and the resolved
   custom properties. Nothing is mocked or stubbed: the page is the page. */
const PROBE = `(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};

  /* a measurement taken before the document has loaded is a measurement of
     something else — and the webfont swaps above all: the panel's height is
     its type, so fonts must be in before any of this means anything */
  await new Promise(function (done) {
    if (document.readyState === 'complete') return done();
    var t = setTimeout(done, 8000);
    window.addEventListener('load', function () { clearTimeout(t); done(); }, { once: true });
  });
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  var settled = document.documentElement.scrollHeight;
  for (var s = 0; s < 8; s++) {
    await sleep(120);
    if (document.documentElement.scrollHeight === settled) break;
    settled = document.documentElement.scrollHeight;
  }

  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : null; };
  var cs = function (el) { return el ? getComputedStyle(el) : null; };
  var px = function (el, prop) {
    var st = cs(el);
    return st ? num(st[prop] === 'auto' ? '' : st.getPropertyValue(prop)) : null;
  };

  var scene = document.querySelector('.h-scene');
  var stage = document.querySelector('.h-scene-stage');
  var paper = document.querySelector('.h-blueprint');
  var panel = document.querySelector('.h-ticketwrap');
  var seal = document.querySelector('.h-stampwrap');

  out.found = { scene: !!scene, stage: !!stage, paper: !!paper, panel: !!panel, seal: !!seal };
  if (!scene || !stage || !paper || !panel || !seal) return JSON.stringify(out);

  /* The values the breakpoints SET are literals, so they read back as
     lengths. The three DERIVED ones (--seal-over, --seal-band, --foot) are
     calc() over a custom property, and index.html registers all four as
     <length> so the same reading is available here (an unregistered token
     would keep its token stream and answer "calc(156px * .1)"). The padding
     below is still the honest reading of "derived": the used value, which is
     what the composition is actually built from. */
  var sst = cs(scene);
  var v = function (name) { return num(sst.getPropertyValue(name)); };
  var stageStyle = cs(stage);
  var gutter = v('--gutter');
  out.vars = {
    seal: v('--seal'), gutter: gutter, lit: v('--lit'),
    band: num(stageStyle.paddingTop),
    foot: num(stageStyle.paddingBottom),
    over: num(stageStyle.paddingRight) - gutter,
    overToken: sst.getPropertyValue('--seal-over').trim(),
    bandToken: sst.getPropertyValue('--seal-band').trim(),
    footToken: sst.getPropertyValue('--foot').trim()
  };

  /* the stage's own padding, as the browser resolved it */
  out.stage = {
    paddingTop: num(cs(stage).paddingTop),
    paddingRight: num(cs(stage).paddingRight),
    paddingBottom: num(cs(stage).paddingBottom),
    paddingLeft: num(cs(stage).paddingLeft),
    clientWidth: stage.clientWidth,
    clientHeight: stage.clientHeight
  };

  /* LAYOUT boxes (offset*), relative to the stage's padding box: the seal is
     inset from that edge by nothing while the paper is inset by --seal-over,
     and that pair is the composition. Transforms are deliberately excluded. */
  var box = function (el) {
    return {
      left: el.offsetLeft, top: el.offsetTop,
      width: el.offsetWidth, height: el.offsetHeight,
      right: el.offsetLeft + el.offsetWidth,
      bottom: el.offsetTop + el.offsetHeight
    };
  };
  out.paper = box(paper);
  out.panel = box(panel);
  out.seal = box(seal);
  out.sealRadius = cs(document.querySelector('.h-stamp') || seal).borderTopLeftRadius;
  out.panelRadius = cs(document.querySelector('.h-ticket')) ? cs(document.querySelector('.h-ticket')).borderTopLeftRadius : null;
  out.pageScrollWidth = document.documentElement.scrollWidth;
  out.innerWidth = window.innerWidth;
  return JSON.stringify(out);
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

/* ---------------- expectations ----------------
   Every check compares the browser's own numbers against the note's chain.
   Rounding is 1px on the derived lengths — the note's own measurements are
   whole pixels — and 0.02px on the three formulas, which is float noise. */

const close = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;

function checks(page, vp) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
  const scale = SCALES[vp.key];
  const px = v => (typeof v === 'number' ? Math.round(v * 100) / 100 + 'px' : String(v));
  const missing = Object.keys(page.found || {}).filter(k => !page.found[k]);

  t('the object is on the page (.h-scene, stage, paper, panel, seal)',
    missing.length === 0, 'not found: ' + missing.join(', '));
  if (missing.length) return out;

  const v = page.vars;
  const stage = page.stage;

  /* 1. the chain itself: the derived values follow --seal. Tolerance 0.02 on
     the padding-based readings (the pad is the resolved 15.6, not 16), and
     0.51 everywhere the measurement is an offset, which is always integral. */
  t('seal band, overhang and foot are derived from --seal, not set beside it',
    close(v.over, v.seal * 0.1, 0.51) &&
    close(v.band, v.seal + 8, 0.51) &&
    close(v.foot, v.seal * 0.22, 0.51),
    'seal ' + px(v.seal) + ' → over ' + px(v.over) + ' (want ' + px(v.seal * 0.1) + '), ' +
    'band ' + px(v.band) + ' (want ' + px(v.seal + 8) + '), foot ' + px(v.foot) + ' (want ' + px(v.seal * 0.22) + ')' +
    ' — read from the stage padding, which carries ' + v.overToken + ' / ' + v.bandToken + ' / ' + v.footToken);

  /* 2. the two scales' own numbers — the contract with the note's table */
  t('this scale is the one the note states (' + vp.key + ': seal ' + scale.seal +
    ', gutter ' + scale.gutter + ', lit ' + scale.lit + ')',
    v.seal === scale.seal && v.gutter === scale.gutter && v.lit === scale.lit,
    'measured seal ' + px(v.seal) + ', gutter ' + px(v.gutter) + ', lit ' + px(v.lit) +
    ' — dev/hero-object.md and this table move together, so change both or neither');

  /* 3. the stage's padding IS the composition */
  t('the stage padding is band / gutter + overhang / foot / gutter',
    close(stage.paddingTop, v.band, 0.02) &&
    close(stage.paddingRight, v.gutter + v.over, 0.02) &&
    close(stage.paddingBottom, v.foot, 0.02) &&
    close(stage.paddingLeft, v.gutter, 0.02),
    'measured ' + px(stage.paddingTop) + ' / ' + px(stage.paddingRight) + ' / ' +
    px(stage.paddingBottom) + ' / ' + px(stage.paddingLeft) + ', want ' +
    px(v.band) + ' / ' + px(v.gutter + v.over) + ' / ' + px(v.foot) + ' / ' + px(v.gutter));

  /* 3b. nothing positional is set per-breakpoint: the seal's own box is the
     one place a media query could hide a second arrangement, so read it here */
  t('the seal is placed by the derived overhang (top: -over, right: 0)',
    close(page.seal.top, -v.over, 0.51),
    'seal top ' + px(page.seal.top) + ', want ' + px(-v.over) + ' (the seal crosses the paper’s top edge by the same amount it crosses the right)');

  /* 4. the paper is the stage's padding box, short by the overhang on the right */
  t('the paper fills the stage and is inset by the overhang on its right',
    close(page.paper.left, 0, 0.51) && close(page.paper.top, 0, 0.51) &&
    close(page.paper.width, stage.clientWidth - v.over, 0.51) &&
    close(page.paper.height, stage.clientHeight, 0.51),
    'paper ' + px(page.paper.width) + '×' + px(page.paper.height) + ' at ' +
    px(page.paper.left) + ',' + px(page.paper.top) + '; stage ' +
    stage.clientWidth + '×' + stage.clientHeight + ', want width ' + px(stage.clientWidth - v.over));

  /* 5. the panel is in flow inside the gutters, one band down */
  t('the panel sits inside the gutters, one seal band down',
    close(page.panel.left, v.gutter, 0.51) &&
    close(stage.clientWidth - page.panel.right, v.gutter + v.over, 0.51) &&
    close(page.panel.top, v.band, 0.51),
    'panel at left ' + px(page.panel.left) + ', right gap ' + px(stage.clientWidth - page.panel.right) +
    ', top ' + px(page.panel.top) + '; want left ' + px(v.gutter) + ', right gap ' +
    px(v.gutter + v.over) + ', top ' + px(v.band));

  /* 6. and the plan shows the same gutter on both sides, the foot below */
  t('the plan shows equal gutters beside the panel and the foot under it',
    close(page.panel.left - page.paper.left, v.gutter, 0.51) &&
    close(page.paper.right - page.panel.right, v.gutter, 0.51) &&
    close(page.panel.top - page.paper.top, v.band, 0.51) &&
    close(page.paper.bottom - page.panel.bottom, v.foot, 0.51),
    'beside ' + px(page.panel.left - page.paper.left) + ' / ' + px(page.paper.right - page.panel.right) +
    ', above ' + px(page.panel.top - page.paper.top) + ', below ' + px(page.paper.bottom - page.panel.bottom) +
    '; want ' + px(v.gutter) + ' / ' + px(v.gutter) + ', ' + px(v.band) + ', ' + px(v.foot));

  /* 7. the seal: the disc, turned in the hand, landing on the column's edge */
  t('the seal is a square disc of --seal, flush with the column’s right edge',
    page.seal.width === page.seal.height && close(page.seal.width, v.seal, 0.51) &&
    close(stage.clientWidth - page.seal.right, 0, 0.51) &&
    page.sealRadius === '50%',
    'seal ' + px(page.seal.width) + '×' + px(page.seal.height) + ', right gap ' +
    px(stage.clientWidth - page.seal.right) + ', radius ' + page.sealRadius +
    '; want ' + px(v.seal) + '², flush, 50%');

  /* 8. it crosses the paper by exactly the overhang, on both edges it crosses */
  t('the seal crosses the paper by the overhang, not more and not less',
    close(page.seal.right - page.paper.right, v.over, 0.51) &&
    close(page.paper.top - page.seal.top, v.over, 0.51),
    'crosses the right edge by ' + px(page.seal.right - page.paper.right) + ' and the top by ' +
    px(page.paper.top - page.seal.top) + '; want ' + px(v.over) + ' each — the paper is inset by exactly ' +
    'what the seal overhangs, which is what lands the two together on the scene edge');

  /* 9. the object never widens the page (the seal is the least forgiving plate) */
  t('nothing in the object pushes the page sideways',
    page.pageScrollWidth <= page.innerWidth + 1,
    'scrollWidth ' + page.pageScrollWidth + ' vs viewport ' + page.innerWidth);

  return out;
}

/* ---------------- degradation: one bad value, one edge ----------------
   The pair of hand edits described at the top of this file, run against the
   live page in every pass. Each is applied AFTER the clean measurement, as a
   stylesheet on the same .h-scene the page itself writes its tokens on — a
   later rule of the same specificity wins, which is exactly what a person
   editing the page (or their devtools) would do. */
const TAMPERED = [
  {
    label: '--seal-over: 0 (unitless) — "no overhang"',
    css: '.h-scene{--seal-over:0}',
    /* which edge the value is allowed to take with it, and what the composition
       reads like once it has: no overhang means the plan reaches the scene's own
       right edge and the disc lands on the corner of it */
    moved: 'right',
    give: (clean, page) => ({
      ok: close(page.stage.paddingRight, clean.vars.gutter, 0.51) &&
          close(page.paper.width, page.stage.clientWidth, 0.51),
      want: 'the right pad back to the plain gutter (' + clean.vars.gutter + 'px), the plan filling the stage'
    })
  },
  {
    label: '--foot: 24 (unitless, not a length)',
    css: '.h-scene{--foot:24}',
    moved: 'bottom',
    give: (clean, page) => ({
      ok: close(page.stage.paddingBottom, 0, 0.02) &&
          close(page.paper.bottom - page.panel.bottom, 0, 0.51) &&
          close(page.seal.right - page.paper.right, clean.vars.over, 0.51),
      want: 'no foot (the panel on the plan\u2019s bottom edge), with the seal still crossing the paper by the overhang'
    })
  }
];

/* the injected stylesheet, and the probe after it. Both are evaluated as one
   script: the mutation lands, then the same measurements are taken again. */
const tamperExpr = css => '(function(){' +
  'var old=document.getElementById("tamper");if(old)old.parentNode.removeChild(old);' +
  'var s=document.createElement("style");s.id="tamper";s.textContent=' + JSON.stringify(css) + ';' +
  'document.head.appendChild(s);' +
  '})();\n' + PROBE;

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function degradation(clean, tampered) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
  const px = v => (typeof v === 'number' ? Math.round(v * 100) / 100 + 'px' : String(v));

  for (const { m, page, error } of tampered) {
    if (error || !page || !page.found || !page.found.seal) {
      t(m.label + ' is survived by the object', false,
        error || 'the page stopped answering once the value was set');
      continue;
    }

    const sides = {
      top: page.stage.paddingTop, right: page.stage.paddingRight,
      bottom: page.stage.paddingBottom, left: page.stage.paddingLeft
    };
    const mine = sides[m.moved];
    const rest = Object.keys(sides).filter(k => k !== m.moved);
    const kept = rest.filter(k => close(sides[k], clean.stage['padding' + cap(k)], 0.02));
    const want = rest.map(k => k + ' ' + px(clean.stage['padding' + cap(k)])).join(', ');
    const got = rest.map(k => k + ' ' + px(sides[k])).join(', ');

    /* 1. the object is still there: the collapse this guards against is the
       stage losing its padding altogether, and a plate losing its own size
       along with it. Three edges intact is what "survived" means — the fourth
       is the one the hand edit named, and check 2 is what it is allowed to be. */
    t(m.label + ' takes one edge with it, not the composition',
      kept.length === rest.length &&
      close(page.seal.width, clean.seal.width, 0.51) &&
      close(page.seal.height, clean.seal.height, 0.51) &&
      page.panel.width > 0 && page.panel.height > 0,
      'the stage now pads ' + px(sides.top) + ' / ' + px(sides.right) + ' / ' +
      px(sides.bottom) + ' / ' + px(sides.left) + ' (top / right / bottom / left), want ' + want +
      ' — got ' + got + ', the disc ' + px(page.seal.width) + '\u00b2, the panel ' +
      px(page.panel.width) + '\u00d7' + px(page.panel.height) +
      '; all four edges at zero is the composition gone');

    /* 2. and the edge it names degrades the way the note says it should, rather
       than becoming something nobody wrote down */
    const g = m.give(clean, page);
    t(m.label + ' — the named edge is the only one that moves, and it moves the way the note says',
      g.ok,
      'the ' + m.moved + ' pad is ' + px(mine) + ' (was ' + px(clean.stage['padding' + cap(m.moved)]) +
      '); want ' + g.want);
  }

  return out;
}

/* the note's own measured table, printed rather than asserted: heights here
   are the panel's type, so they are a reading to compare, not a contract */
function observations(page, vp) {
  if (!page.found || !page.found.seal) return [];
  const v = page.vars;
  return [
    'scene column ' + page.stage.clientWidth + '×' + page.stage.clientHeight,
    'paper ' + page.paper.width + '×' + page.paper.height,
    'panel ' + page.panel.width + '×' + page.panel.height +
      ' (' + v.gutter + ' in, ' + Math.round(v.band) + ' down)',
    'seal ' + page.seal.width + '², top ' + Math.round(page.seal.top) + ', flush right',
    'plan beside the panel ' + v.gutter + ' / ' + v.gutter + ', below it ' + Math.round(v.foot * 10) / 10
  ];
}

/* ---------------- main ---------------- */

(async function main() {
  const base = baseArg || 'http://localhost:8123';
  if (urlsOnly) {
    console.log('Open the page these checks run against:\n');
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
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-hero-'));
  console.log('Arzuz — the hero object’s geometry, at both scales');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('page    ' + pageArg);
  console.log('widths  ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', '));
  console.log('note    the numbers this checks are in dev/hero-object.md');

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

    for (const vp of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
      });

      const label = 'GEOMETRY · ' + vp.key + ' ' + vp.w + 'px';
      let page = null, failure = null;
      const tampered = [];
      const errors = [];
      const spy = msg => {
        if (msg.method === 'Runtime.exceptionThrown') {
          errors.push('uncaught: ' + ((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text));
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          errors.push('console.error: ' + (msg.params.args || []).map(a => a.value).join(' '));
        }
      };
      cdp.listeners.push(spy);
      try {
        await cdp.send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 600));
        await cdp.evaluate(PROBE).then(raw => { page = JSON.parse(raw); });
        /* the same page, then the same page with one value hand-set. The clean
           measurement is taken first so the tampered one has something to be
           compared against, and each tamper replaces the last (one style
           element, re-written) so neither mutates the other's reading. */
        if (page && page.found && page.found.seal) {
          for (const m of TAMPERED) {
            try {
              const raw = await cdp.evaluate(tamperExpr(m.css));
              tampered.push({ m, page: JSON.parse(raw) });
            } catch (e) {
              tampered.push({ m, error: e.message });
            }
          }
        }
      } catch (e) {
        failure = e.message;
      }
      cdp.listeners = cdp.listeners.filter(f => f !== spy);

      total++;
      if (failure || !page) {
        console.log('\n' + label + '\n  ✗ ' + (failure || 'the page never reported back'));
        failed++;
        continue;
      }

      const all = checks(page, vp).concat(degradation(page, tampered)).concat([{
        name: 'no uncaught errors, no console errors', ok: errors.length === 0, note: errors.join(' | ')
      }]);
      total += all.length;
      const bad = all.filter(x => !x.ok);
      failed += bad.length;

      console.log('\n' + label);
      for (const o of observations(page, vp)) console.log('  · ' + o);
      for (const { m, page: tp } of tampered) {
        if (tp && tp.found && tp.found.seal) {
          console.log('  · tampered ' + m.label + ' → pad ' + [
            tp.stage.paddingTop, tp.stage.paddingRight, tp.stage.paddingBottom, tp.stage.paddingLeft
          ].join(' / ') + '  (top / right / bottom / left)');
        }
      }
      if (!bad.length) {
        console.log('  ✓ ' + all.length + '/' + all.length + ' checks passed');
      } else {
        for (const x of bad) console.log('  ✗ ' + x.name + (x.note ? '\n      → ' + x.note : ''));
        console.log('  ' + (all.length - bad.length) + '/' + all.length + ' checks passed');
      }
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
})().catch(e => {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
