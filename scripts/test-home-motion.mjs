#!/usr/bin/env node
/* ============================================================
   Arzuz — homepage motion, placement and write-boundary test

   Loads the REAL index.html in headless Chrome at desktop and
   mobile widths and asserts on what the browser actually did:

     · the motion layer boots and every .rv reveal lands
       (a reveal that never fires leaves content invisible for good)
       The walk that gives every reveal its chance waits for PAINTED frames,
       not timer ticks: on a busy box a scroll position scrolled through
       between two frames is a position the page was never in, and a reveal
       whose whole visible window falls in that gap reads as a page that
       hides content for good. Anything still un-revealed when the walk ends
       is put in the middle of the viewport and given one honest look; what
       lands there is reported as rescued (the sweep's miss, said out loud),
       and what does not is a page bug and stays red.
     · the hero plate animates on mobile too, sits whole inside the
       hero, and overlaps no copy, button or link
     · the demand-curve bars actually fill at both widths
     · a hostile value written into the page (a missing or
       non-numeric highlight width, a junk data-depth) can never
       reach the DOM as an invalid style — the write boundary
     · nothing overflows sideways and every section keeps its place
     · with prefers-reduced-motion: reduce, everything is visible
       immediately and no motion is left running

   LOSING A BOOT SCRIPT ON PURPOSE (--fault-inject)

     This page fails SILENTLY when a script request is lost between the document
     being sent and the parser running it: assets/motion.js never adds
     html.motion-ready, so every reveal target stays hidden, and the inline boot
     dies with "Arzuz is not defined". This suite used to report that as "the
     motion layer booted" — a page bug's clothes on a lost request.
     dev/page-harness-boot.js repairs it in the page instead: it runs last, asks
     for the layer the boot needs, and reloads ONCE when any of it is missing.
     This mode reproduces the loss at the network layer, so a run proves the
     repair rather than a hand-edited page walk.

     The candidates come from scripts/page-rules.mjs, which reads the check's own
     LAYERS row for index.html and intersects it with the scripts the page names
     — derived, never copied here. --fault-drops=2 kills the reload's copy as
     well, which MUST leave the run red: the control that proves a page which
     cannot be repaired is still reported as broken.

   Run from arzuz-site/:
     node scripts/test-home-motion.mjs
     node scripts/test-home-motion.mjs --width=mobile
     node scripts/test-home-motion.mjs --base=http://localhost:8123
     node scripts/test-home-motion.mjs --urls
     node scripts/test-home-motion.mjs --fault-inject                 lose one boot script per load; the page's own check must repair it
     node scripts/test-home-motion.mjs --fault-inject --fault-drops=2  kill the reload's copy too — the control, which must FAIL
     node scripts/test-home-motion.mjs --fault-inject --fault-rate=0.5 fault half the loads; the rest must boot clean
     node scripts/test-home-motion.mjs --fault-inject --fault-seed=42  the plan is random; this replays one exactly
     node scripts/test-home-motion.mjs --cpu=20                   starve the renderer on purpose: the sweep has to keep its word when frames are scarce

   Zero dependencies: Node's global WebSocket drives the Chrome,
   Edge or Chromium already on the machine over the DevTools
   protocol, and scripts/dev-server.mjs is started when nothing
   is listening.
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* the boot layer this page's lost-script fault mode aims at — read back out of
   dev/page-harness-boot.js rather than kept here a second time */
import { harnessBootPlan, HARNESS_BOOT_FILE } from './page-rules.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
/* ARZUZ_TEST_BASE does the same job as --base for the whole suite:
   scripts/test-all.mjs passes it through, so two checkouts (or an agent
   and a person) can run these at once without fighting over port 8123. */
const baseArg = argVal('base') || process.env.ARZUZ_TEST_BASE || null;
const widthArg = argVal('width');
const pageArg = argVal('page') || 'index.html';
const urlsOnly = args.includes('--urls');
/* CDP CPU throttling, 1 = off. A starved renderer is the flake this suite has
   actually seen on a loaded box: the sweep moves the page in steps, and a step
   whose frame never lands is a position the page was never in — so an element
   that was only ever visible during that step is never seen by the reveal
   observer and looks like a page that hides it forever. Rate > 1 puts that
   condition on demand instead of hoping for a busy machine. It costs nothing
   when unused, and the run says the rate out loud whenever it is on. */
const cpuArg = argVal('cpu') ? Number(argVal('cpu')) : 1;
if (!isFinite(cpuArg) || cpuArg < 1) throw new Error('--cpu must be 1 or more (1 = no throttling)');

/* Fault injection: a faulted load has one boot-critical script request dropped
   before the parser can run it, and the page's own boot check
   (dev/page-harness-boot.js) must get it back on its own single reload. See the
   fault-injection section below for what is dropped, and why the drop is aimed
   rather than sprayed. */
const faultInject = args.includes('--fault-inject');
/* requests of the SAME script that are failed: 1 is a loss the one reload can
   undo, 2 also kills the reload's copy — the negative control. */
const faultDrops = argVal('fault-drops') ? Number(argVal('fault-drops')) : 1;
/* how many DIFFERENT scripts a faulted load loses at once: 1 is the single loss
   this mode is for; more is a compound loss. */
const faultVictims = argVal('fault-victims') !== null ? Number(argVal('fault-victims')) : 1;
/* the fraction of loads that are faulted at all, so one sweep can carry both
   paths: the faulted loads must recover, the rest must boot clean. */
const faultRate = argVal('fault-rate') ? Number(argVal('fault-rate')) : 1;
/* The plan is drawn from a seed rather than Math.random, so a run that finds
   something can be run again exactly: the seed is printed, and passing it back
   reproduces every victim, on every load, in order. */
const faultSeed = argVal('fault-seed') ? Number(argVal('fault-seed')) : (Date.now() % 2147483647);
/* more than one request per victim is the control: the loss has no surviving
   copy, so no boot check can carry it and the run is meant to be red. */
const faultControl = faultDrops > 1;

const WIDTHS = [
  { key: 'desktop', w: 1440, h: 900 },
  { key: 'mobile', w: 390, h: 844 }
];

/* ---------------- fault injection --------------

   The homepage's own boot is inline, and two of the three scripts it needs are
   silent when they are missing: assets/motion.js is what adds html.motion-ready
   (without it every reveal target stays hidden), and the inline boot dies with
   "Arzuz is not defined" when assets/app.js or assets/data.js never arrives.
   dev/page-harness-boot.js is what tells a request lost between the document
   being sent and the parser running it from a page that is genuinely broken,
   and this mode reproduces the loss at the network layer so a run can prove the
   repair instead of a hand-edited page walk.

   The candidates are DERIVED, never copied: scripts/page-rules.mjs reads
   dev/page-harness-boot.js's own LAYERS row for index.html and intersects it
   with the scripts the page names. A script added to both is instantly a target;
   one dropped from the page stops being one. If that intersection is ever empty
   the plan pins below fail before a browser opens, because a recovery nobody
   could have needed is not a passed test.

   One family only, because this page has one shape of loss: a parser request. */

const fault = {
  armed: false,      /* true while a faulted load and its reload are in flight */
  victims: [],       /* the scripts THIS load is losing */
  budget: 1,         /* requests to fail per victim (--fault-drops) */
  sent: {},          /* victim → requests actually failed for it this load */
  landed: 0,         /* requests failed on this load */
  loads: 0,          /* loads this run has attempted */
  faulted: 0,        /* of those, how many were meant to lose something */
  losses: 0,         /* requests failed across the run */
  proved: 0          /* faulted loads the page's own check answered for */
};

/* mulberry32 — small, deterministic, and enough for choosing a script. */
function rngFrom(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rngFrom(faultSeed);

/* K distinct candidates, chosen fresh per load so a sweep does not keep losing
   the same one — one unlucky script must not be the only shape of failure this
   mode has ever seen. Drawn from the seeded generator, so the same seed gives
   the same plan. */
function pickVictims(candidates, count) {
  const pool = candidates.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/* One line describing what this load lost, for the log and for a failure: a red
   run has to be readable as "the loss this mode expects to be fatal" rather
   than as a page that broke on its own. */
function faultLine(lost, sent) {
  if (!lost.length) return 'nothing';
  return 'the parser never got ' + lost.map(v => v + ' (' + (sent[v] || 0) + '/' + faultDrops + ')').join(', ');
}

/* The status dev/page-harness-boot.js publishes, read only once it has stopped
   moving: 'retrying' is a reload in flight, not a state to judge. */
const BOOT_SETTLED = ['ok', 'ok-after-retry', 'still-missing'];
async function bootState(cdp, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  let last = null, tries = 0, unreadable = 0;
  while (Date.now() < deadline) {
    tries += 1;
    try {
      last = JSON.parse(await cdp.evaluate(
        "JSON.stringify({ boot: document.documentElement.getAttribute('data-harness-boot')," +
        " missing: (window.__HARNESS__ && window.__HARNESS__.missing) || [], href: location.href })"));
    } catch (e) {
      unreadable += 1;
      last = null;
      if (process.env.ARZUZ_DEBUG) console.error('    boot read ' + tries + ' unreadable: ' + e.message.slice(0, 120));
    }
    if (last && BOOT_SETTLED.indexOf(last.boot) !== -1) {
      if (process.env.ARZUZ_DEBUG) console.error('    boot settled after ' + tries + ' read(s): ' + JSON.stringify(last));
      return last;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  if (process.env.ARZUZ_DEBUG) console.error('    boot never settled: ' + tries + ' read(s), ' + unreadable + ' unreadable, last ' + JSON.stringify(last));
  return last || { boot: null, missing: [], href: '' };
}

function headerOf(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

/* The dropped request: a parser request for one of this load's victims, while
   the load still has budget for it. Anything else is passed straight through. */
function onRequestPaused(cdp, params) {
  const req = params.request || {};
  const bare = String(req.url).replace(/\?.*$/, '');
  const dest = headerOf(req.headers, 'sec-fetch-dest');
  const isParserRequest = params.resourceType === 'Script' || dest === 'script';
  const fail = () => {
    fault.landed += 1;
    cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionClosed' }).catch(() => {});
  };

  if (fault.armed && isParserRequest) {
    const victim = fault.victims.find(v => bare.endsWith('/' + v));
    const sent = victim ? (fault.sent[victim] || 0) : 0;
    if (victim && sent < fault.budget) { fault.sent[victim] = sent + 1; return fail(); }
  }
  cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
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
    /* A launch is a wait, not a verdict. The gate runs the SQL mutation
       suite beside this one, and 25s for Chrome to say "here I am" was
       measured expiring on a loaded machine while the browser itself was
       fine — the pages had not even been asked for yet. */
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

  /* The page has to be LOADED before any of it is measured. Page.navigate
     resolves before the document is parsed, and on a loaded machine the
     parser can still be a section behind when a probe runs — which is how
     this suite once reported "0 of 0" bars on a page that has them, a test
     fidelity bug wearing a page bug's clothes. Bounded, so a resource that
     never arrives cannot park the suite. */
  await new Promise(function (done) {
    if (document.readyState === 'complete') return done();
    var t = setTimeout(done, 8000);
    window.addEventListener('load', function () { clearTimeout(t); done(); }, { once: true });
  });

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
     anything else is measuring a page nobody gets.

     And one property of the TEST, which is what a loaded box breaks: a
     step is not a position unless the renderer painted it. An
     IntersectionObserver is evaluated during a rendering update, so a
     position scrolled through between two frames was never a position the
     page was in — and a reveal target whose whole visible window falls in
     such a gap stays unrevealed, which reads exactly like a page that hides
     content for good. Timer ticks are not frames: on a busy box the 90ms
     sleep below can elapse many times over without the compositor producing
     anything. So every step waits for a frame on purpose (rAF, the same unit
     the observer thinks in), a step whose frame never arrives is COUNTED
     rather than swallowed, the sweep says how many frames it actually got,
     and if the page grew under the sweep it re-samples once rather than
     leaving the new range unwalked. */
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

  /* one painted frame, bounded: a frozen renderer is reported, never waited
     on forever */
  var frames = 0, stalledSteps = 0;
  var frameTick = function () {
    return new Promise(function (done) {
      var t = setTimeout(function () { done(false); }, 4000);
      requestAnimationFrame(function () { clearTimeout(t); frames++; done(true); });
    });
  };
  var steps = 30;
  var sweepOnce = async function () {
    for (var i = 0; i <= steps; i++) {
      window.scrollTo(0, Math.round(liveMax() * i / steps));
      if (!(await frameTick())) stalledSteps++;
      await sleep(90);
    }
  };
  var heightAtStart = H.scrollHeight;
  await sweepOnce();
  window.scrollTo(0, liveMax());
  await sleep(600);
  /* the page grew while the sweep walked it: the sampled positions no longer
     describe this page, so walk the settled one again (once, bounded) */
  var passes = 1;
  if (H.scrollHeight > heightAtStart + window.innerHeight / 2) {
    passes = 2;
    heightAtStart = H.scrollHeight;
    await sweepOnce();
    window.scrollTo(0, liveMax());
    await sleep(600);
  }
  out.sweepPasses = passes;
  out.sweepFrames = frames;
  out.sweepStalled = stalledSteps;
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

  /* Is this transform still displaced, or is it the resting frame?
     String comparison against "matrix(1, 0, 0, 1, 0, 0)" is not enough:
     an entrance that ends on a 3D transform computes to a matrix3d whose
     numbers are identity to about four decimals (0.999996 …), which is a
     settled element, not a moving one. Read the numbers instead — a real
     residual is a translation of more than half a pixel or a scale/rotate
     off by more than 0.002. */
  var nearIdentity = function (tf) {
    if (!tf || tf === 'none') return true;
    var m3 = tf.match(/matrix3d\\(([^)]+)\\)/);
    var m2 = tf.match(/matrix\\(([^)]+)\\)/);
    var nums = m3 ? m3[1].split(',').map(parseFloat) : m2 ? m2[1].split(',').map(parseFloat) : null;
    if (!nums) return false;
    if (nums.length === 6) {
      if (Math.abs(nums[4]) > 0.5 || Math.abs(nums[5]) > 0.5) return false;
      return Math.max(Math.abs(nums[0] - 1), Math.abs(nums[1]), Math.abs(nums[2]), Math.abs(nums[3] - 1)) <= 0.002;
    }
    if (Math.abs(nums[12]) > 0.5 || Math.abs(nums[13]) > 0.5 || Math.abs(nums[14]) > 0.5) return false;
    var id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    var worst = 0;
    for (var i = 0; i < 16; i++) {
      if (i === 12 || i === 13 || i === 14) continue;
      worst = Math.max(worst, Math.abs(nums[i] - id[i]));
    }
    return worst <= 0.002;
  };

  /* ---- 1. reveals landed ----
     Before the count: anything the sweep did not reveal gets the second look a
     visitor gives it — held in the middle of the viewport, on painted frames,
     for as long as one entrance takes. If it lands there, the SWEEP is what
     failed to see it, and that is reported as rescued (visible in the run's
     own output, never as proof the page is fine); if it does not land even
     held in view, the page is hiding content and the checks below stay red. */
  var pendingReveal = [].slice.call(document.querySelectorAll('.rv:not(.in)'));
  out.rvPending = pendingReveal.length;
  if (pendingReveal.length) {
    for (var k = 0; k < pendingReveal.length; k++) {
      pendingReveal[k].scrollIntoView({ block: 'center' });
      await frameTick();
      await sleep(500);
    }
    /* the same 1500ms the walk itself allows at the top: an entrance that has
       been triggered is 0.8s long and can be delayed up to 350ms, so reading
       sooner would report a section mid-transition — a fact about this probe,
       not about the page */
    window.scrollTo(0, 0);
    await frameTick();
    await sleep(1500);
  }
  out.rvRescued = pendingReveal.filter(function (e) { return e.classList.contains('in'); }).length;

  var rv = [].slice.call(document.querySelectorAll('.rv'));
  out.rvTotal = rv.length;
  out.rvIn = rv.filter(function (e) { return e.classList.contains('in'); }).length;
  var invisible = [];
  rv.forEach(function (e, i) {
    var st = getComputedStyle(e);
    var op = parseFloat(st.opacity);
    if (!(op > 0.99)) invisible.push({ i: i, cls: e.className, opacity: st.opacity });
    /* a reveal that is still translated has not finished its entrance */
    if (!nearIdentity(st.transform)) invisible.push({ i: i, cls: e.className, transform: st.transform });
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
  /* loaded first, then measured — see the note on PROBE above */
  await new Promise(function (done) {
    if (document.readyState === 'complete') return done();
    var t = setTimeout(done, 8000);
    window.addEventListener('load', function () { clearTimeout(t); done(); }, { once: true });
  });
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

  /* what the sweep itself managed, phrased for a reader of a failure: a run
     that got few frames or parked on a stalled one is a run to distrust, and
     saying so is the difference between "the page hides content" and "this
     box never painted the positions we asked for". */
  const sweepNote = ' — sweep saw ' + page.sweepFrames + ' painted frame' +
    (page.sweepFrames === 1 ? '' : 's') + ' over 31 positions' +
    (page.sweepPasses > 1 ? ', twice (the page grew while it walked it)' : '') +
    (page.sweepStalled ? ', ' + page.sweepStalled + ' step(s) never rendered at all' : '') +
    (page.rvRescued ? '; ' + page.rvRescued + ' landed only when held in view' : '');

  t('all ' + page.rvTotal + ' scroll reveals landed',
    page.rvTotal > 0 && page.rvIn === page.rvTotal,
    page.rvIn + ' of ' + page.rvTotal + ' revealed' +
    (page.rvNotRevealed && page.rvNotRevealed.length ? ' — STILL HIDDEN with the element held in the middle of the viewport: ' + page.rvNotRevealed.join(' | ') : '') +
    sweepNote);

  t('no revealed section is left invisible or mid-transform',
    page.rvInvisibleCount === 0,
    JSON.stringify(page.rvInvisible) + sweepNote);

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

  /* ---- the fault mode's own preconditions, before a browser is opened ---- */
  const faultFlags = ['fault-drops', 'fault-victims', 'fault-rate', 'fault-seed'];
  if (!faultInject && faultFlags.some(k => argVal(k) !== null)) {
    throw new Error('--fault-drops, --fault-victims, --fault-rate and --fault-seed are --fault-inject options — add it');
  }
  if (faultInject && (!Number.isInteger(faultDrops) || faultDrops < 1)) {
    throw new Error('--fault-drops must be a positive integer');
  }
  if (faultInject && (!Number.isInteger(faultVictims) || faultVictims < 1)) {
    throw new Error('--fault-victims must be a whole number of scripts (at least 1)');
  }
  if (faultInject && !(faultRate > 0 && faultRate <= 1)) {
    throw new Error('--fault-rate must be greater than 0 and at most 1');
  }
  /* The boot check states index.html's layer and nothing else: a run driving
     another page says so and skips the pins rather than pretending they ran,
     and --fault-inject is refused there because there is no repair to prove. */
  const bootPage = pageArg === 'index.html' ? pageArg : null;
  if (faultInject && !bootPage) {
    throw new Error('--fault-inject is driving ' + pageArg + ', and ' + HARNESS_BOOT_FILE +
      ' states the boot layer of index.html only — there is nothing on this page for the check to repair');
  }
  const bootSource = await readFile(join(SITE, HARNESS_BOOT_FILE), 'utf8');
  const bootPlan = bootPage
    ? harnessBootPlan({
      page: bootPage,
      bootSource: bootSource,
      pageSource: await readFile(join(SITE, bootPage), 'utf8')
    })
    : { rows: [], named: [], candidates: [], checks: [] };
  const faultCandidates = bootPlan.candidates;
  const victimsPerLoad = Math.min(faultVictims, faultCandidates.length);

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
  if (cpuArg > 1) console.log('cpu     throttled ' + cpuArg + '× — the renderer is starved on purpose');

  let total = 0, failed = 0;
  const faultChecks = [];
  let chromeChild = null, cdp = null;

  /* ---- the boot plan, printed like every other block so a failure is readable ---- */
  if (bootPage) {
    const bad = bootPlan.checks.filter(c => !c.ok);
    total += bootPlan.checks.length || 1;
    failed += bad.length;
    console.log('\n════ BOOT — the scripts ' + HARNESS_BOOT_FILE + ' repairs on this page (' +
      faultCandidates.join(', ') + ')');
    for (const c of bad) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
    console.log(bad.length
      ? '  ' + (bootPlan.checks.length - bad.length) + '/' + bootPlan.checks.length + ' checks passed'
      : '  ✓ ' + bootPlan.checks.length + '/' + bootPlan.checks.length + ' checks passed');
  } else {
    console.log('\n════ BOOT — skipped: this run drives ' + pageArg + ', and ' + HARNESS_BOOT_FILE +
      ' states the boot layer of index.html only');
  }
  if (faultInject) {
    const howOften = faultRate === 1 ? 'every load' : Math.round(faultRate * 100) + '% of loads';
    console.log('fault   drop ' + faultDrops + ' parser request' + (faultDrops === 1 ? '' : 's') +
      ' per victim, losing ' + victimsPerLoad + ' of: ' + faultCandidates.join(', ') + '   (' + howOften + ')');
    console.log('seed    ' + faultSeed + '   (--fault-seed=' + faultSeed + ' replays this exact plan)');
    if (victimsPerLoad < faultVictims) {
      console.log('        (asked for ' + faultVictims + ' victims per load, but this page only names ' +
        faultCandidates.length + ' boot-critical script' + (faultCandidates.length === 1 ? '' : 's') +
        ' — losing all ' + victimsPerLoad + ')');
    }
    if (faultControl) {
      console.log('        (--fault-drops=' + faultDrops + ' kills the reload\'s copy too: this is the control and is meant to FAIL)');
    }
  }
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

    /* the network layer the fault mode kills a request at: armed per load,
       aimed at that load's victim, and silent the rest of the time */
    if (faultInject) {
      cdp.listeners.push(msg => { if (msg.method === 'Fetch.requestPaused') onRequestPaused(cdp, msg.params); });
    }

    const url = base + '/' + pageArg;

    if (cpuArg > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuArg });

    const run = async (vp, label, expression, list) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
      });

      const cdpErrors = [];
      const spy = msg => {
        /* A document that lost a script is replaced by the page's own check, and
           whatever it threw on the way is not this page's verdict: what counts
           is what the document it settled on produced. */
        if (msg.method === 'Page.frameNavigated' && msg.params.frame && !msg.params.frame.parentId) {
          cdpErrors.length = 0;
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          cdpErrors.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          cdpErrors.push('console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
        }
      };
      cdp.listeners.push(spy);

      /* ---- the fault, armed for this load and the reload it may take ---- */
      let faulted = false, lost = [];
      if (faultInject) {
        faulted = rnd() < faultRate;
        if (faulted) lost = pickVictims(faultCandidates, victimsPerLoad);
        fault.victims = lost;
        fault.budget = faultDrops;
        fault.sent = {};
        fault.landed = 0;
        fault.armed = faulted;
        fault.loads += 1;
        if (faulted) fault.faulted += 1;
        await cdp.send(faulted ? 'Fetch.enable' : 'Fetch.disable',
          faulted ? { patterns: lost.map(v => ({ urlPattern: '*' + v + '*', requestStage: 'Request' })) } : {});
      }

      let page = null, failure = null, boot = null, faultNote = '';
      try {
        const nav = await cdp.send('Page.navigate', { url });
        /* Page.navigate resolves whether or not it got there, so the browser's
           own verdict is said out loud rather than left to look like a page that
           never rendered */
        if (nav && nav.errorText) console.log('  ✗ the browser refused ' + url + ': ' + nav.errorText);

        /* A faulted load's document can be replaced by the page's own check at
           any moment, and a probe aimed at the document being replaced measures
           nothing — so the check is allowed to stop moving first. The sweep's
           own wait below is untouched, so timing is the same as any other run. */
        if (faultInject) boot = await bootState(cdp);

        await new Promise(r => setTimeout(r, 600));
        await cdp.evaluate(expression).then(raw => { page = JSON.parse(raw); });
      } catch (e) {
        failure = e.message;
      }

      /* ---- what the fault mode saw on this load ---- */
      if (faultInject) {
        const sent = Object.assign({}, fault.sent);
        const landed = fault.landed;
        fault.armed = false;
        if (!boot) boot = await bootState(cdp, 8000);
        const lostAll = lost.length > 0 && lost.every(v => (sent[v] || 0) >= faultDrops);
        const answered = boot.boot === 'ok-after-retry';
        const nothingMissing = !boot.missing || !boot.missing.length;
        /* a load whose page came out complete anyway — Chrome served the script
           from its own copy even though the request was killed — is neither a
           recovery nor a failure: the kill cost it nothing. Reported as exactly
           that, and never counted as proof. */
        const harmless = boot.boot === 'ok' && nothingMissing;
        fault.losses += Object.keys(sent).reduce((a, v) => a + sent[v], 0);
        if (faulted && lostAll && answered) fault.proved += 1;
        await cdp.send('Fetch.disable');
        faultNote = faulted
          ? faultLine(lost, sent) + ', boot ' + boot.boot
          : 'none (rate ' + faultRate + ' left this load clean), boot ' + boot.boot;

        if (!faulted) {
          /* A load the rate left alone has one obligation: it must have been
             left alone, and it must boot on the first document. */
          faultChecks.push({
            name: 'this load was left alone (fault rate ' + faultRate + ') and booted first try',
            ok: landed === 0 && boot.boot === 'ok',
            note: landed + ' request' + (landed === 1 ? '' : 's') +
              ' failed on a load that was meant to be clean · boot ' + boot.boot
          });
        } else {
          faultChecks.push({
            name: 'the fault landed — the parser never got ' + lost.join(' + '),
            ok: lostAll,
            note: lost.map(v => v + ': ' + (sent[v] || 0) + ' of ' + faultDrops +
              ' parser request' + (faultDrops === 1 ? '' : 's')).join(' · ') +
              ' — a zero means that script was never actually lost, so this load proved nothing'
          });
          faultChecks.push({
            name: 'the loss was answered — the boot check reloaded once and the page booted with ' +
              (lost.length === 1 ? 'the lost script' : 'all ' + lost.length + ' lost scripts') + ' back',
            ok: answered || harmless,
            note: harmless
              ? 'the page booted first try with everything present: Chrome served its own copy, so the ' +
                'kill cost this load nothing and it is not counted as proof of recovery'
              : 'boot state after the loss: ' + boot.boot +
                (boot.missing && boot.missing.length ? ' · still missing: ' + boot.missing.join(', ') : '') +
                (faultControl ? '  — this is the control: an unrecoverable loss is meant to be fatal' : '')
          });
        }
      }
      cdp.listeners = cdp.listeners.filter(f => f !== spy);

      total++;
      if (failure || !page) {
        console.log('\n' + label + (faultNote ? '\n  · fault: ' + faultNote : '') +
          '\n  ✗ ' + (failure || 'the page never reported back'));
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
      if (faultNote) console.log('  · fault: ' + faultNote);
      /* A green run that needed a second look is not the same as a clean one:
         the sweep is a walk, and a box that starved it says so here even when
         every check passed. Silence means the sweep saw the page itself. */
      if (page && page.rvPending) {
        console.log('  · the sweep did not see ' + page.rvPending + ' reveal' +
          (page.rvPending === 1 ? '' : 's') + ' (' + page.sweepFrames + ' painted frames' +
          (page.sweepStalled ? ', ' + page.sweepStalled + ' step(s) never rendered' : '') +
          '); ' + page.rvRescued + ' landed once held in view' +
          (page.rvPending - page.rvRescued ? ', ' + (page.rvPending - page.rvRescued) + ' did not' : ''));
      } else if (page && page.sweepStalled) {
        console.log('  · ' + page.sweepStalled + ' sweep step(s) never rendered a frame (' +
          page.sweepFrames + ' painted frames total) — a starved box, not a quiet one');
      }
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

  /* ---- what the fault mode saw, load by load ---- */
  if (faultChecks.length) {
    const bad = faultChecks.filter(c => !c.ok);
    total += faultChecks.length;
    failed += bad.length;
    console.log('\n════ FAULT — one boot script request lost per load, on purpose');
    for (const c of bad) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
    console.log(bad.length
      ? '  ' + (faultChecks.length - bad.length) + '/' + faultChecks.length + ' checks passed'
      : '  ✓ ' + faultChecks.length + '/' + faultChecks.length + ' checks passed');
  }

  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + total + ' · PASS ' + (total - failed) + ' · FAIL ' + failed);
  if (faultInject) {
    console.log('fault  ' + fault.faulted + ' of ' + fault.loads + ' load' + (fault.loads === 1 ? '' : 's') +
      ' faulted · ' + fault.losses + ' request' + (fault.losses === 1 ? '' : 's') +
      ' never arrived · ' + fault.proved + ' answered by the page\'s own check as this mode requires');
    console.log('seed   ' + faultSeed + '   (this exact plan: --fault-seed=' + faultSeed + ')');
    /* A partial rate can select no load at all, and a fault sweep where the
       fault never fired is a green run that proved nothing. It is a failure,
       not a footnote. */
    if (!fault.faulted) {
      console.log('\n✗ no load was faulted, so nothing about the recovery was exercised (rate ' + faultRate +
        ' over ' + fault.loads + ' load' + (fault.loads === 1 ? '' : 's') + ') — re-run, or use --fault-rate=1');
      process.exitCode = 1;
    } else if (!fault.proved) {
      console.log('\n✗ ' + (faultControl
        ? 'the control: ' + fault.faulted + ' load' + (fault.faulted === 1 ? '' : 's') +
          ' lost a script with no surviving copy, so no boot check could have carried it — this run is meant to be red'
        : 'not one of the ' + fault.faulted + ' faulted load' + (fault.faulted === 1 ? '' : 's') +
          ' needed the page\'s own check to answer for it (every kill was undone by the browser\'s own copy)' +
          ' — a green run here proves nothing about the recovery'));
      process.exitCode = 1;
    }
  }
  if (failed) process.exitCode = 1;
})();
