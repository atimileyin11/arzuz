#!/usr/bin/env node
/* ============================================================
   Arzuz — the hero object's paint, held against a stored image

   scripts/test-hero-geometry.mjs asserts where the plates LAND. It cannot see
   what they look like: the paper's tint and grid, the shadow the one light
   throws, the seal's own glint, the ring of type inside the disc, the aurora
   behind the paper. Every one of those is a number in the page, and every one
   of them can be changed by hand without the geometry moving a pixel.

   So this suite screenshots the object — .h-scene, the composition's own box —
   at both widths and holds it against the image recorded for that width on
   this platform (dev/hero-baselines/). A difference past tolerance is a red
   run that says how much of the object changed, and where.

   WHAT MAKES THE PAINT DETERMINISTIC (none of this is a mock; each is a
   source of nondeterminism in the page, pinned to one value):

     · reduced motion, emulated: the page's own supported static mode, in which
       the reveals land instantly and motion.js never binds a scene or a tilt.
     · the clock, pinned before any script of the page runs. The seal's date is
       `Arzuz.STAMP_DATE`, which is `new Date()` (assets/app.js) — without a pin
       a baseline would be wrong tomorrow by design.
     · every animation taken to the state a visitor is left with: the entrance
       ones are FINISHED (the seal's `coinIn` begins at opacity 0, so pinning it
       at its first frame records an object with no seal on it — that is what
       the first pass of this suite did, and the image said so), and the
       aurora's endless pulse is held at its first frame, since an infinite
       animation has no rest to be taken to. The run reports each one's state.
     · the fonts and the document height settled, and the scroll offset set
       rather than inherited.

   It also proves the capture's own coordinates on every width: the object is
   shot twice, from two different scroll offsets, and the two images must be the
   same one to within the tolerance a baseline is compared with. That is what
   says the clip is a region of the DOCUMENT rather than of the frame — a
   baseline recorded against the frame would silently encode wherever the page
   happened to be scrolled. The floor between the two offsets is printed on
   every run: no pixel moves past the channel tolerance, and the worst block
   moves by about 1, which is what the limits below are chosen against.

   A run prints all three statistics every time, so a drift is visible while it
   is small: the fraction of pixels whose worst channel moved further than 24,
   the mean channel difference across the whole box, and the worst 32px block
   of it — the last being what a change confined to one plate shows up in.

   THE BASELINE IS STORED, NOT ASSUMED. A machine with no baseline for its own
   platform records one and says so — it does not call that a comparison. So
   this is a tripwire on a checkout that has recorded one (the committed win32
   baselines) and self-seeding elsewhere. Text rasterization is the browser's
   and the OS's, which is why the file is keyed on platform: a Linux runner
   diffing a Windows baseline would be noise dressed as a regression.

   Run from arzuz-site/:
     node scripts/test-hero-visual.mjs
     node scripts/test-hero-visual.mjs --width=mobile
     node scripts/test-hero-visual.mjs --base=http://localhost:8123
     node scripts/test-hero-visual.mjs --urls
     node scripts/test-hero-visual.mjs --update            re-record from this run (how a real change is accepted)
     node scripts/test-hero-visual.mjs --page=<file>       capture another page

   Zero dependencies: Node's global WebSocket drives the Chrome, Edge or
   Chromium already on the machine over the DevTools protocol, and
   scripts/dev-server.mjs is started when nothing is listening. The PNGs are
   read with node:zlib — see readPng below.
   ============================================================ */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
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
const update = args.includes('--update');

const WIDTHS = [
  { key: 'desktop', w: 1440, h: 900 },
  { key: 'mobile', w: 390, h: 844 }
];

const BASELINE_DIR = join(SITE, 'dev', 'hero-baselines');

/* Tolerance, not equality. Two shots of the same page on the same machine are
   identical — that is what the pinned clock, the paused animations and the
   fixed scroll offset buy — so the margin is for what is not pinned: a browser
   update's rasterizer, a driver's blurred filter. A plate MOVING is
   percent-scale (the disc is a sixth of the box, the panel a third), so it
   lands in thousands of pixels; a tint or an opacity changing moves most
   channels by a little at once, which is the mean's job. Both print every run. */
const MAX_CHANGED_FRACTION = 0.015;
const MAX_MEAN_DELTA = 3.0;
const CHANNEL_TOLERANCE = 24;
/* and the local one. A single pixel's difference says nothing (that is what
   the channel tolerance is for), and the whole-image mean is dominated by the
   object's large flat areas — so a soft change confined to one plate can be
   invisible to both. The worst 32px block of the object is where a moved
   glint, a shadow with a new direction, or a ring at a different opacity shows
   up: those move their own area by a few levels each and nothing else at all.
   Measured floors on this machine, which is what the limit is chosen against:
   the same shot twice is 0, and the same object shot from two scroll offsets
   peaks at a block mean of 0.2. */
const BLOCK = 32;
const MAX_WORST_BLOCK = 6.0;

/* How far the second shot is taken from, to prove the clip is the document's.
   Both shots have to keep the object clear of the sticky header and inside the
   frame: the first puts its top 150px down the viewport, the second scrolls
   BACK by 137 so the object sits lower rather than off the top — a shot whose
   top rows are scrolled out from under a fixed bar is a comparison of the bar,
   not of the object. (It was: 4.8% of the object "moved" the first time this
   ran, all of it the header the object had slid under.) */
const OBJECT_TOP_IN_FRAME = 150;
const RESCROLL_BY = 137;

/* ---------------- the pinned clock ----------------
   Injected before any script of the page runs, because Arzuz.STAMP_DATE is
   computed at load and the date is real content on the seal — it cannot be
   blanked or faked, only pinned. */
const FIXED_DATE = Date.UTC(2026, 9, 15, 12, 0, 0);   /* 15·10·26, the day these were recorded */
const CLOCK_PIN = `(function () {
  var Real = Date;
  var FIXED = ${FIXED_DATE};
  function Pinned() {
    if (!(this instanceof Pinned)) return new Real(FIXED).toString();
    if (arguments.length === 0) return new Real(FIXED);
    return new Real(...arguments);
  }
  Pinned.prototype = Real.prototype;
  Pinned.now = function () { return FIXED; };
  Pinned.parse = Real.parse;
  Pinned.UTC = Real.UTC;
  window.Date = Pinned;
})();`;

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
    '--force-device-scale-factor=1',
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

/* ---------------- the in-page probes ----------------
   Nothing is mocked: the page is the page, and the only two things it is told
   are what time it is and that its animations are over. */

const SCENE = `var scene = document.querySelector('.h-scene');`;
const BOX = `var r = scene.getBoundingClientRect();
  out.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  out.doc = { x: r.left + window.scrollX, y: r.top + window.scrollY };
  out.scrollY = window.scrollY;`;
/* take every animation to its resting state, and say what each one is */
const PIN = `var anims = (document.getAnimations ? document.getAnimations() : []);
  /* finish() throws on an animation that never ends, which is the one case
     where holding the first frame is the best available answer; everything
     else is left exactly as a visitor is left with it. */
  anims.forEach(function (a) {
    try { a.finish(); return; } catch (e) {}
    try { a.pause(); a.currentTime = 0; } catch (e) {}
  });
  out.animations = anims.map(function (a) { return { name: a.animationName || '(scripted)', state: a.playState }; });`;

const PROBE = `(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};

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

  ${SCENE}
  out.found = !!scene;
  if (!out.found) return JSON.stringify(out);

  /* where the page is scrolled is part of the paint, so it is set rather than
     inherited: the object is brought to a fixed place in the frame */
  var at = window.scrollY + scene.getBoundingClientRect().top;
  window.scrollTo(0, Math.max(0, Math.round(at - ${OBJECT_TOP_IN_FRAME})));
  await sleep(250);

  ${PIN}
  await sleep(150);

  ${BOX}
  out.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  out.devicePixelRatio = window.devicePixelRatio;
  return JSON.stringify(out);
})()`;

/* the same object, measured again from a different scroll offset — the pair of
   shots is what proves the clip is read in the document's coordinates */
const RESCROLL = `(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  window.scrollBy(0, -${RESCROLL_BY});
  await sleep(220);

  ${SCENE}
  ${PIN}
  await sleep(120);
  /* what is still MOVING, as opposed to what has been taken to its rest:
     a finished entrance is the state the page is meant to be read in */
  out.running = (out.animations || []).filter(function (a) { return a.state === 'running'; })
    .map(function (a) { return a.name; });

  ${BOX}
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

/* ---------------- reading a PNG ----------------
   Page.captureScreenshot answers in PNG, so the two images have to be compared
   pixel by pixel, and that means a decoder: IHDR, the IDAT chunks through
   node:zlib, then the per-line filter pass — the whole format as far as a
   screenshot goes, and no dependency. It refuses anything that is not 8-bit,
   non-interlaced RGB or RGBA (which is all Chrome emits) rather than guessing,
   so a decoder that does not understand a file says so instead of comparing
   noise. */
function readPng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG');
  }
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
    throw new Error('the PNG reader understands 8-bit non-interlaced RGB/RGBA only, and this file is ' +
      w + 'x' + h + ', depth ' + depth + ', colour type ' + color + ', interlace ' + interlace);
  }
  const bpp = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) {
        throw new Error('PNG reader: unknown line filter ' + filter + ' on row ' + y);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = cur[x * bpp];
      px[o + 1] = cur[x * bpp + 1];
      px[o + 2] = cur[x * bpp + 2];
      px[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, px };
}

/* Three statistics and where they happened. The fraction is the one a moved
   plate trips hard; the mean catches a change spread thinly across the whole
   object, which no single pixel can report; the worst block catches a change
   confined to one plate, which neither of the others can see. */
function compare(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { shape: [a.w, a.h, b.w, b.h] };
  const n = a.w * a.h;
  const bw = Math.ceil(a.w / BLOCK), bh = Math.ceil(a.h / BLOCK);
  const blockSum = new Float64Array(bw * bh);
  let changed = 0, sum = 0, worst = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.h; y++) {
    const by = (y / BLOCK) | 0;
    for (let x = 0; x < a.w; x++) {
      const o = (y * a.w + x) * 4;
      const d = Math.max(
        Math.abs(a.px[o] - b.px[o]),
        Math.abs(a.px[o + 1] - b.px[o + 1]),
        Math.abs(a.px[o + 2] - b.px[o + 2]),
        Math.abs(a.px[o + 3] - b.px[o + 3])
      );
      sum += d;
      blockSum[by * bw + ((x / BLOCK) | 0)] += d;
      if (d > worst) worst = d;
      if (d > CHANNEL_TOLERANCE) {
        changed++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  let blockWorst = 0, blockAt = null;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const count = Math.min(BLOCK, a.h - by * BLOCK) * Math.min(BLOCK, a.w - bx * BLOCK);
      const m = blockSum[by * bw + bx] / count;
      if (m > blockWorst) { blockWorst = m; blockAt = { x: bx * BLOCK, y: by * BLOCK }; }
    }
  }
  return {
    n, changed,
    fraction: changed / n,
    mean: sum / n,
    worst,
    blockWorst,
    blockAt,
    box: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null
  };
}

/* one verdict, in one place: every comparison in this suite is judged the same
   way, so the tolerance the baseline is compared with is the same tolerance the
   suite's own determinism is held to */
const withinTolerance = d => !d.shape && d.fraction <= MAX_CHANGED_FRACTION &&
  d.mean <= MAX_MEAN_DELTA && d.blockWorst <= MAX_WORST_BLOCK;

/* ---------------- main ---------------- */

const pct = v => (v * 100).toFixed(2) + '%';
const num = v => Math.round(v * 100) / 100;
/* the three numbers, the same shape everywhere they are printed */
const stats = d => pct(d.fraction) + ' of pixels moved past ' + CHANNEL_TOLERANCE +
  ' (limit ' + pct(MAX_CHANGED_FRACTION) + '), mean ' + num(d.mean) + ' (limit ' + MAX_MEAN_DELTA + ')' +
  ', worst block ' + num(d.blockWorst) + (d.blockAt ? ' at ' + d.blockAt.x + ',' + d.blockAt.y : '') +
  ' (limit ' + MAX_WORST_BLOCK + '), worst pixel ' + d.worst;

(async function main() {
  const base = baseArg || 'http://localhost:8123';
  if (urlsOnly) {
    console.log('Open the page this captures:\n');
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

  const pageKey = basename(pageArg, extname(pageArg));
  /* the platform is in the name, not in the comparison: text rasterization is
     the browser's and the OS's, and a cross-platform baseline is noise */
  const baselineFor = vp => join(BASELINE_DIR, pageKey + '-' + vp.key + '-' + vp.w + '-' + process.platform + '.png');

  const { child: serverChild } = await ensureServer(base);
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-hero-visual-'));
  await mkdir(BASELINE_DIR, { recursive: true });
  console.log('Arzuz — the hero object’s paint, against its recorded image');
  console.log('chrome    ' + chrome);
  console.log('server    ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('page      ' + pageArg);
  console.log('baselines dev/hero-baselines/  ' + process.platform + ', deviceScaleFactor 1');
  console.log('widths    ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', '));
  console.log('mode      reduced motion, clock pinned to ' + new Date(FIXED_DATE).toISOString().slice(0, 10) +
    ', animations at rest (entrances finished, the endless pulse held at frame 0)');
  console.log('limits    ' + pct(MAX_CHANGED_FRACTION) + ' of pixels may move past ' + CHANNEL_TOLERANCE +
    ', mean channel difference ≤ ' + MAX_MEAN_DELTA + ', worst ' + BLOCK + 'px block ≤ ' + MAX_WORST_BLOCK);

  let total = 0, failed = 0, recordedCount = 0;
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
    /* the pin has to be in place before the page's own scripts run, which is
       what this call is for — a Runtime.evaluate after the load would find a
       stamp already computed from the real date */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_PIN });

    const url = base + '/' + pageArg;
    const shot = async clip => (await cdp.send('Page.captureScreenshot', {
      format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false
    })).data;

    for (const vp of widths) {
      const label = 'PAINT · ' + vp.key + ' ' + vp.w + 'px';
      const baseline = baselineFor(vp);
      const rel = 'dev/hero-baselines/' + basename(baseline);
      const errors = [];
      const checks = [];
      const t = (name, ok, note) => checks.push({ name, ok: !!ok, note: ok ? '' : (note || '') });

      const spy = msg => {
        if (msg.method === 'Runtime.exceptionThrown') {
          errors.push('uncaught: ' + ((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text));
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          errors.push('console.error: ' + (msg.params.args || []).map(a => a.value).join(' '));
        }
      };
      cdp.listeners.push(spy);

      let b64 = null, image = null, probe = null, again = null, invariant = null, failure = null;
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
        });
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
        });
        await cdp.send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 600));
        probe = JSON.parse(await cdp.evaluate(PROBE));
        if (!probe.found) throw new Error('there is no .h-scene on this page');

        const clip = {
          x: Math.round(probe.doc.x), y: Math.round(probe.doc.y),
          width: Math.round(probe.rect.width), height: Math.round(probe.rect.height)
        };
        b64 = await shot(clip);
        image = readPng(Buffer.from(b64, 'base64'));

        /* 1. the image IS the object's box. A clip read in the wrong
           coordinate space, or a pixel ratio quietly not 1, still produces a
           picture — this is what says it is the right one, and how big. */
        t('the image is the object’s own box (' + clip.width + '×' + clip.height + ')',
          image.w === clip.width && image.h === clip.height,
          'the screenshot came back ' + image.w + '×' + image.h + ', wanted ' + clip.width + '×' + clip.height);

        /* 2. the paint is deterministic, or nothing below means anything.
           Finished is a rest state, not a running one: an entrance animation
           that has ended is exactly how a visitor sees the page. */
        const running = (probe.animations || []).filter(a => a.state === 'running');
        t('the page is at rest: reduce is live and nothing is still animating',
          probe.reduce === true && running.length === 0,
          'reduce ' + probe.reduce + ', animations ' +
          ((probe.animations || []).map(a => a.name + ' ' + a.state).join(', ') || 'none'));

        /* 3. and the shot is a region of the document: the object shot again
           from another scroll offset has to be the same image, held to the
           same tolerance the baseline itself is compared with. A clip read
           against the frame would show a region that MOVES with the scroll,
           which is a change of most of the object, not a shade of it. */
        again = JSON.parse(await cdp.evaluate(RESCROLL));
        const clipAgain = {
          x: Math.round(again.doc.x), y: Math.round(again.doc.y),
          width: Math.round(again.rect.width), height: Math.round(again.rect.height)
        };
        invariant = compare(readPng(Buffer.from(await shot(clipAgain), 'base64')), image);
        const restarted = (again.running || []).length;
        t('the object does not ride on the scroll: shot again from another offset it is the same image',
          withinTolerance(invariant) && invariant.changed === 0 && restarted === 0,
          invariant.shape
            ? 'the two clips are different sizes (' + invariant.shape[0] + '×' + invariant.shape[1] + ' vs ' + invariant.shape[2] + '×' + invariant.shape[3] + ')'
            : 'the page scrolled from ' + probe.scrollY + ' to ' + again.scrollY + ' (the object from ' +
              Math.round(probe.rect.top) + 'px to ' + Math.round(again.rect.top) + 'px down the frame), and the second shot is ' +
              stats(invariant) +
              (restarted ? ', with ' + restarted + ' animation(s) restarted when the page moved' : '') +
              ' — a baseline whose clip was read against the frame would encode where the page happened to be scrolled');
      } catch (e) {
        failure = e.message;
      }
      cdp.listeners = cdp.listeners.filter(f => f !== spy);
      checks.push({ name: 'no uncaught errors, no console errors', ok: errors.length === 0, note: errors.join(' | ') });

      total += checks.length + (failure || !image ? 1 : 0);
      failed += checks.filter(c => !c.ok).length;

      console.log('\n' + label);
      if (probe && probe.found) {
        console.log('  · object ' + Math.round(probe.rect.width) + '×' + Math.round(probe.rect.height) +
          ' at ' + Math.round(probe.doc.x) + ',' + Math.round(probe.doc.y) + ' of the document' +
          ' (scrolled to ' + probe.scrollY + ', dpr ' + probe.devicePixelRatio + ')');
        console.log('  · animations: ' +
          ((probe.animations || []).map(a => a.name + ' → ' + a.state).join(', ') || 'nothing animating on this page'));
        if (invariant && !invariant.shape) {
          console.log('  · shot twice, scroll ' + probe.scrollY + ' → ' + again.scrollY + ': ' + stats(invariant) +
            ' — the floor this suite compares against');
        }
      }
      for (const c of checks) if (!c.ok) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));

      if (failure || !image) {
        failed += 1;
        console.log('  ✗ ' + (failure || 'the page never produced a screenshot'));
        continue;
      }
      const unproven = checks.some(c => !c.ok);
      if (unproven) {
        console.log('  · no baseline was compared: the capture has to be of the object, at rest, in the document’s coordinates before an image of it means anything');
        continue;
      }

      const had = existsSync(baseline);
      if (!had || update) {
        await writeFile(baseline, Buffer.from(b64, 'base64'));
        recordedCount++;
        console.log('  · ' + (had ? 're-recorded ' + rel + ' from this run' : 'recorded ' + rel +
          ' — nothing to compare against yet, so this run only says what the object looks like now'));
        continue;
      }

      let was = null, d = null;
      try {
        was = readPng(await readFile(baseline));
        d = compare(image, was);
      } catch (e) {
        failed += 1;
        total += 1;
        console.log('  ✗ the baseline could not be read: ' + e.message +
          '\n      → ' + rel + '; re-record it with --update');
        continue;
      }

      total += 1;
      if (d.shape) {
        failed += 1;
        console.log('  ✗ the object is a different size than its baseline: ' + image.w + '×' + image.h +
          ' now, ' + d.shape[2] + '×' + d.shape[3] + ' in ' + rel +
          '\n      → re-record with --update if that was the intent');
        continue;
      }
      const ok = withinTolerance(d);
      if (!ok) failed += 1;
      console.log('  ' + (ok ? '✓' : '✗') + ' the paint is the recorded one — ' + stats(d));
      if (!ok) {
        const current = 'dev/hero-baselines/' + basename(baseline).replace(/\.png$/, '.current.png');
        await writeFile(join(SITE, current), Buffer.from(b64, 'base64'));
        console.log('      → ' + d.changed + ' of ' + d.n + ' pixels differ' +
          (d.box ? ', in ' + d.box.w + '×' + d.box.h + ' at ' + d.box.x + ',' + d.box.y + ' of the object' : '') +
          '; this run is saved beside its baseline as ' + current + ' to compare' +
          '\n      → if the change was meant, re-record it: node scripts/test-hero-visual.mjs --update');
      }
    }
  } finally {
    if (cdp) await cdp.close();
    if (chromeChild) chromeChild.kill();
    if (serverChild) serverChild.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + total + ' · PASS ' + (total - failed) + ' · FAIL ' + failed +
    (recordedCount ? ' · RECORDED ' + recordedCount : ''));
  if (failed) process.exitCode = 1;
})().catch(e => {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
