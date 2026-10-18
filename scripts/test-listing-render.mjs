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
     node scripts/test-listing-render.mjs --case=worst     one case, full detail (comma-separate for several)
     node scripts/test-listing-render.mjs --urls           print the harness URLs
     node scripts/test-listing-render.mjs --base=http://localhost:8799
     node scripts/test-listing-render.mjs --dump           save each rendered body
     node scripts/test-listing-render.mjs --fault-inject   lose a boot-critical script per load; the harness must recover
     node scripts/test-listing-render.mjs --fault-inject --fault-victims=2   lose TWO at once (compound loss)
     node scripts/test-listing-render.mjs --fault-inject --fault-rate=0.5    fault half the loads; the rest must boot clean
     node scripts/test-listing-render.mjs --fault-inject --fault-drops=2     kill the retry's copy too — the control, which must FAIL
     node scripts/test-listing-render.mjs --fault-inject --fault-preflight=1 the harness's own preflight fetch fails; its retry must recover
     node scripts/test-listing-render.mjs --fault-inject --fault-css=1       the stylesheet never arrives; the harness must SAY so
     node scripts/test-listing-render.mjs --fault-inject --fault-seed=42     the plan is random; this replays one exactly
     node scripts/test-listing-render.mjs --width=narrow      320px only, and the 320px pass
     node scripts/test-listing-render.mjs --render-timeout=300  how long a load may take to settle (default 180s)

   Zero dependencies. It drives the Chrome/Edge/Chromium already on
   the machine over the DevTools protocol (Node's global WebSocket),
   and starts scripts/dev-server.mjs itself when nothing is listening.
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  LISTING, planChecks as fixturePlanChecks, verifyPageRules
} from './page-rules.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const onlyCase = argVal('case');
/* ARZUZ_TEST_BASE does the same job as --base for the whole suite:
   scripts/test-all.mjs passes it through, so two checkouts (or an agent
   and a person) can run these at once without fighting over port 8123. */
const baseArg = argVal('base') || process.env.ARZUZ_TEST_BASE || null;
const widthArg = argVal('width');          /* desktop | mobile | both (default both) */
const urlsOnly = args.includes('--urls');
const keepBody = args.includes('--dump');

/* Fault injection: a faulted load has randomly chosen boot-critical script
   requests dropped before the parser can run them, and the harness must get
   them back on its own single retry. See the fault-injection section below
   for what is dropped, how, and why the drop is aimed rather than sprayed. */
const faultInject = args.includes('--fault-inject');
/* requests of the SAME script that are failed: 1 is a loss the harness retry
   can undo, 2 also kills the retry's copy — the negative control. */
const faultDrops = argVal('fault-drops') ? Number(argVal('fault-drops')) : 1;
/* how many DIFFERENT scripts a faulted load loses at once: 1 is the single
   loss this mode shipped with, 2+ is a compound loss. 0 turns the parser
   family off so the preflight or stylesheet family can be measured alone. */
const faultVictims = argVal('fault-victims') !== null ? Number(argVal('fault-victims')) : 1;
/* how many times the harness's OWN preflight fetch for one script is failed
   before it is allowed through. 1 proves the preflight's retries work; 3
   exhausts them, which must leave preflight-failed — the control. */
const faultPreflight = argVal('fault-preflight') ? Number(argVal('fault-preflight')) : 0;
/* how many stylesheets the page names are stopped from arriving. A
   stylesheet has no retry, so this proves DETECTION rather than recovery. */
const faultCss = argVal('fault-css') ? Number(argVal('fault-css')) : 0;
/* the fraction of loads that are faulted at all, so one sweep can carry both
   paths: the faulted loads must recover, the rest must boot untouched. */
const faultRate = argVal('fault-rate') ? Number(argVal('fault-rate')) : 1;
/* The plan is drawn from a seed rather than Math.random, so a run that finds
   something can be run again exactly: the seed is printed, and passing it
   back reproduces every victim, on every load, in order. */
const faultSeed = argVal('fault-seed') ? Number(argVal('fault-seed')) : (Date.now() % 2147483647);
/* How long one load may take to settle before this suite calls it stuck. It is
   a WAIT, never a verdict: every check here is about what the page rendered, so
   a busy machine has to be allowed to be slow. At 30s, a load starved by the
   gate's own CPU-heavy node suites was reported as "the page never booted"
   when the harness had not even written its document yet — the machine was the
   problem, and the suite blamed the page. */
const renderTimeoutMs = (argVal('render-timeout') ? Number(argVal('render-timeout')) : 180) * 1000;

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

/* desktop, mobile and narrow come from the one width table in
   scripts/page-rules.mjs, the same one the invite page's suite sweeps */
const WIDTHS = LISTING.widths;

/* the width the 320px pass measures: the budget real handsets report, and the
   one complete-listing.html's own stylesheet names. WIDTHS above is the array
   this suite sweeps; this is its entry for that width, so the pass measures
   the same 320 px the invite suite does rather than a number typed here. */
const NARROW = WIDTHS.find(w => w.key === 'narrow');
if (!NARROW) throw new Error('scripts/page-rules.mjs no longer publishes a narrow width — the 320px pass needs one');

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

/* ---------------- fault injection --------------

   The harness's whole reason to exist is one failure mode: a script request
   lost between the document being written and the parser running it, which
   used to surface as "Arzuz is not defined" and a page reported broken.
   This mode reproduces that loss on purpose — randomly chosen boot-critical
   scripts, failed at the network layer — so the recovery is exercised by a
   run instead of by a hand-edited harness, the way it was first proven.

   THREE KNOBS, because "a lost script" is a family of failures and the
   harness's one retry has to answer all of them:

     --fault-victims=K   how many DIFFERENT scripts a faulted load loses at
                         once. K=1 is the original single loss; K=2 is a
                         compound loss — the parser has already carried on
                         past the first when the second fails, so the retry
                         has to bring back everything the first load was
                         missing, not just one script. Distinct scripts on
                         purpose: dropping the same one twice is the
                         negative control below, not a harder recovery.
     --fault-drops=N     how many requests of each victim are failed. N=1 is
                         recoverable (the retry's copy survives); N=2 kills
                         the retry's copy as well and MUST leave the page
                         `still-missing` — the control that proves a red page
                         can still go red.
     --fault-rate=P      the fraction of loads that are faulted at all. P=1
                         faults every load; a partial rate is how a sweep
                         proves the clean path stayed clean beside the
                         faulted ones instead of only ever running broken.
     --fault-preflight=N the PREFLIGHT family: the harness asks for every
                         script before it writes anything, with three tries
                         120ms apart (dev/listing-harness.html). N=1 fails
                         the first attempt, so the load is only saved by the
                         harness's own retry — and must then boot on the
                         FIRST document, because nothing else was lost.
                         N=3 exhausts those tries, which must leave the run
                         preflight-failed: that is this family's control.
     --fault-css=N       the STYLESHEET family: N of the sheets the page
                         names never arrive. A stylesheet has no retry and
                         no script guard covers it, so this proves
                         DETECTION rather than recovery — the harness has to
                         report the page it wrote as unstyled
                         (dev/listing-harness-boot.js) rather than the suite
                         passing a naked page as a good one.
     --fault-seed=N      the plan is drawn from this seed and the seed is
                         printed, so a run that found something can be run
                         again exactly.

   One family per run, and more than one is refused: each proves a
   different thing, and a load that lost a script AND a stylesheet would
   leave the harness's answer ambiguous about which guard fired.

   The two kinds of script request are told apart with the browser's own
   request metadata, because the harness makes the same request twice for
   two different reasons:
     · the preflight fetch runs BEFORE the document is written and has its
       own retries — Chrome reports it as resourceType: Fetch/XHR;
     · the parser's request has no retry and is the one that used to be
       lost — Chrome reports it as resourceType: Script.
   The parser family fails only parser requests, so what it proves is what
   the harness retry is for. The preflight family fails only the preflight,
   so what it proves is the harness's other recovery path. (Sec-Fetch-Dest
   would say the same thing, but Chrome does not send those headers over
   the plain-HTTP harness, measured — it does send resourceType.)

   The boot-critical list is derived, never copied: the harness's own LAYER
   map (dev/listing-harness.html) intersected with the scripts listing.html
   actually names. Add a script to the shared layer and it is instantly a
   fault candidate; drop one from the page and it leaves the list the same
   way. If the intersection is ever empty the mode refuses to run, because
   a recovery nobody could have needed is not a passed test. */
const fault = {
  armed: false,      /* true while a faulted load and its retry are in flight */
  family: null,      /* 'parser' | 'preflight' | 'css' | null, for this load */
  victims: [],       /* the scripts THIS load is losing */
  budget: 1,         /* requests to fail per victim (--fault-drops) */
  sent: {},          /* victim → requests actually failed for it this load */
  preflight: null,   /* { victim, budget } — the harness's own fetch retry */
  sheets: [],        /* stylesheets this load is not getting */
  landed: 0,         /* requests failed on this load, whatever the family */
  loads: 0,          /* loads this run has attempted */
  faulted: 0,        /* of those, how many were meant to lose something */
  losses: 0,         /* requests failed across the run */
  proved: 0          /* faulted loads the harness answered as it had to */
};

const rnd = rngFrom(faultSeed);

/* One line describing what this load lost, for the log and for a failure: a
   red run has to be readable as "the loss this family expects to be fatal"
   rather than as a page that broke on its own. */
function faultLine(lost, sheets, preflight, sent, preflightSent) {
  if (lost.length) {
    return 'the parser never got ' + lost.map(v => v + ' (' + (sent[v] || 0) + '/' + faultDrops + ')').join(', ');
  }
  if (preflight) {
    return 'the preflight fetch for ' + preflight.victim + ' failed ' + preflightSent + '/' + preflight.budget + ' time' +
      (preflight.budget === 1 ? '' : 's');
  }
  if (sheets.length) {
    return 'the stylesheet' + (sheets.length === 1 ? ' ' : 's ') + sheets.join(', ') + ' never arrived';
  }
  return 'nothing';
}

/* K distinct candidates, chosen fresh per load so a sweep does not keep
   losing the same one — one unlucky script must not be the only shape of
   failure this mode has ever seen. Drawn from the seeded generator, so the
   same seed gives the same plan. */
function pickVictims(candidates, count) {
  const pool = candidates.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function headerOf(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

async function bootCriticalScripts() {
  const harness = await readFile(join(SITE, 'dev/listing-harness.html'), 'utf8');
  const layer = [...harness.matchAll(/'((?:assets|dev)\/[\w.-]+\.js)':\s*'\w+'/g)].map(m => m[1]);
  const page = await readFile(join(SITE, 'listing.html'), 'utf8');
  const named = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].replace(/\?.*$/, ''));
  const candidates = layer.filter(name => named.includes(name));
  if (!candidates.length) {
    throw new Error('fault injection found no boot-critical script in listing.html — the harness LAYER map ' +
      'and the page have drifted apart, and this mode would prove nothing');
  }
  return candidates;
}

/* The stylesheets listing.html names, derived from the page so the css
   family follows it the way the script list does. */
async function pageStylesheets() {
  const page = await readFile(join(SITE, 'listing.html'), 'utf8');
  const tags = page.match(/<link\b[^>]*>/g) || [];
  const names = tags.filter(tag => /rel="stylesheet"/.test(tag))
    .map(tag => (tag.match(/href="([^"]+)"/) || [])[1])
    .filter(Boolean)
    .map(href => href.replace(/\?.*$/, ''));
  if (!names.length) {
    throw new Error('the css fault family found no stylesheet in listing.html — there would be nothing to lose, ' +
      'so a green run here would prove nothing');
  }
  return [...new Set(names)];
}

function onRequestPaused(cdp, params) {
  const req = params.request || {};
  const dest = headerOf(req.headers, 'sec-fetch-dest');
  const bare = String(req.url).replace(/\?.*$/, '');
  const type = params.resourceType;
  const isParserRequest = type === 'Script' || dest === 'script';
  const isPreflightFetch = type === 'Fetch' || type === 'XHR';
  const isStylesheet = type === 'Stylesheet' || dest === 'style';
  const fail = () => {
    fault.landed += 1;
    cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionClosed' }).catch(() => {});
  };

  if (fault.armed) {
    /* a victim is a path the page names, e.g. assets/app.js — and it is only
       failed while this load has budget left for it */
    if (isParserRequest && fault.family === 'parser') {
      const victim = fault.victims.find(v => bare.endsWith('/' + v));
      const sent = victim ? (fault.sent[victim] || 0) : 0;
      if (victim && sent < fault.budget) { fault.sent[victim] = sent + 1; return fail(); }
    }
    if (isPreflightFetch && fault.family === 'preflight' && fault.preflight &&
      bare.endsWith('/' + fault.preflight.victim) && fault.preflight.sent < fault.preflight.budget) {
      fault.preflight.sent += 1;
      return fail();
    }
    if (isStylesheet && fault.family === 'css') {
      const sheet = fault.sheets.find(v => bare.endsWith('/' + v));
      if (sheet && !fault.sent[sheet]) { fault.sent[sheet] = 1; return fail(); }
    }
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

/* Killing the browser process is not enough for Node to be able to exit: the
   stderr pipe this suite opened stays open while ANY process still holds the
   write end, and a renderer left behind by an aborted request is exactly
   that. The hang was real — the suite printed its total and then never
   exited, which is a hung gate and a hung pre-push hook. So the whole tree
   goes, then the pipe is closed and the child stops holding the loop open. */
function killChrome(child) {
  if (process.platform === 'win32' && child.pid) {
    /* /T while the browser process is still alive: once it is gone its
       renderers are no longer findable as a tree. This is also how a leaked
       Chrome tree used to outlive a killed run and slow the machine's loads. */
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  try { child.kill(); } catch {}
  try { if (child.stderr) child.stderr.destroy(); } catch {}
  try { child.unref(); } catch {}
}

async function launchChrome(bin, profile) {
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--hide-scrollbars', '--window-size=1440,900', '--disable-background-networking',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'
  ], {
    windowsHide: true,
    /* Only stderr is piped — that is where Chrome announces the DevTools
       endpoint. stdout is ignored on purpose: an unread pipe is an open
       handle, and this suite used to print its total and then sit there for
       ever because Chrome's own child processes still held the write end of
       a pipe nobody was reading. */
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    /* a launch is a wait too: the gate runs two CPU-heavy node suites beside
       the browser lane, and a 25s budget for Chrome to say "here I am" was
       measured failing on a loaded machine while the browser itself was fine */
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

/* minimal CDP client over one page target.

   How long one protocol call may sit unanswered. Every call is bounded,
   because a renderer that has stopped answering does not fail — it says
   NOTHING, ever — and an unbounded promise there is a suite that prints no
   total and no verdict and just sits there until someone kills it. That is
   not hypothetical: it is how this suite spent a 180s wait and kept going,
   wedged on the first read, with the deadline it had already checked never
   being reached again because the await in front of it never settled. */
const CDP_CALL_TIMEOUT = 30000;

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
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' went unanswered for ' + (CDP_CALL_TIMEOUT / 1000) +
          's — the page is not answering at all'));
      }, CDP_CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
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
    /* nothing may be left waiting on a socket that is going away */
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('the CDP socket was closed with call ' + id + ' unanswered'));
    }
    this.pending.clear();
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
  var h=window.__HARNESS__||{};
  var status=document.getElementById('hbStatus');
  return JSON.stringify({
    diag: d ? d.textContent : '',
    content: (document.getElementById('ldContent')||{}).outerHTML || '',
    errorDisplay: disp('ldError'),
    skeletonDisplay: disp('ldSkeleton'),
    hasRouteMap: !!document.getElementById('routeMap'),
    ready: !!d,
    boot: document.documentElement.getAttribute('data-harness-boot'),
    style: h.style || null,
    harnessScripts: h.scripts || [],
    harnessExpected: h.expected || [],
    harnessMissing: h.missing || [],
    harnessError: status ? status.textContent : ''
  });
})()`;

async function render(cdp, url, timeoutMs = renderTimeoutMs) {
  await cdp.send('Page.navigate', { url });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    let raw;
    try { raw = await cdp.evaluate(READOUT); } catch { continue; }
    let page;
    try { page = JSON.parse(raw); } catch { continue; }

    /* The harness could not even write the document (a script is missing for
       real, or the dev server is not there). Nothing in this page will ever
       settle, so stop waiting and let the caller say why. */
    if (page.boot === 'preflight-failed') return page;

    /* A document that never loaded its shared layer is being REPLACED by the
       harness's own retry (dev/listing-harness-boot.js). Judging this one
       would report a lost script request as a broken page, which is the
       whole bug this pairing exists to prevent: wait for the document the
       harness decided to keep. `pending` is set before the page's own
       scripts run, `retrying` immediately before the reload, and the last
       state is ok / ok-after-retry / still-missing. */
    if (page.boot !== 'ok' && page.boot !== 'ok-after-retry' && page.boot !== 'still-missing') {
      last = page;
      continue;
    }

    if (page.ready && page.diag) {
      try { page.diagParsed = JSON.parse(page.diag); } catch { page.diagParsed = null; }
      last = page;
      /* the probe writes `overflow` last — that is the settled signal */
      if (page.diagParsed && page.diagParsed.overflow) return page;
    }
  }
  if (last) return last;
  throw new Error('the page never reported back within ' + (timeoutMs / 1000) + 's (listed at ' + url +
    ')' + (last && last.boot ? ' — harness boot state ' + last.boot : ' — the harness never wrote a document') +
    ' · a machine this loaded needs --render-timeout=<seconds>');
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

/* ---------------- reading what rendered ----------------

   The page's own markup contract — which class a slide, a thumbnail, a
   feature chip and a passage step carry, and the three readers that read
   them — is stated once in scripts/page-rules.mjs (LISTING.render) and
   destructured here. Counting is exact-element on purpose: a plain substring
   count also matches the container class ("gal-thumb" counts "gal-thumbs",
   "feat" counts "feat-grid"). */

const {
  count: countRe, text: textOf, slides: SLIDES, thumbs: THUMBS,
  features: FEATURES, steps: STEPS
} = LISTING.render;


/* ---------------- expectations ---------------- */

/* true of every valid row, whatever the data */
function universal(page, opts) {
  opts = opts || {};
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

  /* The harness's own guard on the document it wrote: every stylesheet the
     page names actually applied (dev/listing-harness-boot.js). Nothing else
     here would notice — the markup of an unstyled page is all still there,
     so every content check would pass. The one exception is the css fault
     family, whose whole point is that this guard fires: there the
     expectation flips, and a page that came back styled would mean the loss
     never happened. */
  const style = page.style || null;
  out.push({
    name: opts.expectUnstyled
      ? 'the harness reported the page it wrote as unstyled'
      : 'every stylesheet the page names actually applied',
    ok: style ? (opts.expectUnstyled ? !style.styled : !!style.styled) : false,
    note: style
      ? (style.applied + ' of ' + style.linked + ' stylesheets applied' +
        (opts.expectUnstyled ? ' — the harness did not notice the loss' : ''))
      : 'the harness did not report the style state at all',
    /* marked so the css fault family can keep this one as its verdict and
       set the page's other checks aside as evidence — see the main loop */
    cssGuard: true
  });

  /* the harness's own verdict on the document it wrote — see
     dev/listing-harness-boot.js. A load that lost a script is reloaded once
     by the harness; if the shared layer is STILL missing on that second
     load, the page really is broken and this fails, as it should. */
  t('the page booted the shared layer its own boot calls',
    page.boot === 'ok' || page.boot === 'ok-after-retry',
    page.boot === 'still-missing'
      ? 'the document ran without ' + ((page.harnessMissing || []).join(', ') || (page.harnessExpected || []).join(', ')) +
        ' — a script the page names never loaded, on both the load and the harness retry'
      : 'harness boot state: ' + page.boot);

  /* and the page has to keep naming that layer: deleting assets/app.js from
     listing.html would make the required list shrink to fit, silently */
  t('listing.html still names the shared app layer',
    (page.harnessScripts || []).some(s => /\/assets\/app\.js/.test(String(s))),
    'assets/app.js is no longer in the page — its chrome, footer and modal helpers would not render');
  return out;
}

/* ---------------- what the page must do with a row --------------------

   NOT HERE. listing.html's rules — money(), buildMedia()'s de-duplication,
   the amenities grid, ArzuzMap.passage.normalise(), tierBadge(), and the old
   hand-verified ANCHOR table the derivation is checked against — are
   restated ONCE in scripts/page-rules.mjs (LISTING), beside the invite
   page's rules and imported by both suites. A restatement that lives inside
   one suite drifts the moment the other page's suite is edited.

   verifyPageRules('listing') below then holds that restatement to the page:
   every sentence pinned by equality, and the gallery classes this suite
   counts, are read back out of listing.html and the harness fixture, so a
   page that moves on fails as a stale restatement to decide about — never
   as a silent pass. */


function specifics(name, page, exp) {
  const content = page.content;
  const diag = page.diagParsed;
  const out = [];
  const t = (n, ok, note) => out.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });

  const title = textOf(content, /<h1>([\s\S]*?)<\/h1>/);
  /* The badge carries a title attribute with the sentence behind it (stage 3),
     so the class is never the last attribute — read the text, not the tag. */
  const badge = textOf(content, /class="h-badge[^"]*"[^>]*>([^<]*)</);
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
  t(exp.chip ? 'gallery counter reads "' + exp.chip + '"' : 'a single frame shows no counter',
    exp.chip ? content.includes('>' + exp.chip + '<') : !content.includes('gal-chip'),
    exp.chip ? 'counter missing or wrong' : 'a counter was shown for a single frame');

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

/* ---------------- the 320px pass (the phone width)

   The main sweep measures the page at every width it is told to, and
   `universal()` already says nothing overflows at each of them. This pass is
   the second measurement of the SAME document at the width real handsets
   report (page-rules.mjs WIDTHS.narrow — 320), and it holds the three things
   a squeezed screen breaks first to the viewport the page actually got:

     · the gallery — the stage on screen, one frame filling it, every frame
       the stage's width so the carousel stays aligned, the counter still on
       screen, and the thumbnail strip on screen with real tap targets (the
       strip scrolls; it must not burst the page);
     · the price — the number the student decides on, inside the viewport and
       still the price the row earns;
     · the map placeholder — the route card's map box, which has to keep the
       height its own stylesheet declares even when Leaflet never draws into
       it, and to be absent (not empty) when the pin is incomplete.

   Two floors are read out of the page rather than invented: the gallery's
   aspect ratio and the map's height, pinned in LISTING by
   verifyListingRules() and asserted against those pins. Everything else is
   measured.

   The measurement is taken with reduced motion emulated (the runner sets it
   once, for the whole sweep). That is the layout a visitor who asks for it
   gets, and it is the only stable one: `.gal` carries [data-rise], whose
   entrance is a perspective()/rotateX transform, and while that transition
   runs the browser projects the 50-slide row through it — a frame's rect then
   grows with its distance along the row even though every frame is the same
   width in layout. Reading that mid-flight is what once looked like a gallery
   drifting 12 px wider by frame 50. The pass now asserts the settled state in
   both directions: no entrance transform on the stage (see narrowChecks) and
   every frame exactly a stage wide. */

const NARROW_READOUT = `(function(){
  function box(sel){
    var n=document.querySelector(sel); if(!n) return null;
    var r=n.getBoundingClientRect();
    return { l:Math.round(r.left), r:Math.round(r.right), w:Math.round(r.width),
             h:Math.round(r.height), t:Math.round(r.top) };
  }
  function txt(sel){ var n=document.querySelector(sel); return n ? String(n.textContent||'').trim() : null; }
  function boxes(sel){
    var out=[]; Array.prototype.forEach.call(document.querySelectorAll(sel), function(n){
      var r=n.getBoundingClientRect();
      out.push({ l:Math.round(r.left), r:Math.round(r.right), w:Math.round(r.width), h:Math.round(r.height) });
    });
    return out;
  }
  var de=document.documentElement;
  return JSON.stringify({
    vw: de.clientWidth, docScrollW: de.scrollWidth,
    gal: box('.gal'),
    /* the stage's own transform, and whether the reduced-motion emulation is
       live: together they are what make a frame's width mean anything (see the
       runner's setEmulatedMedia note) */
    galTransform: (function(){ var n=document.querySelector('.gal');
      return n ? getComputedStyle(n).transform : null; })(),
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    track: box('.gal-track'),
    frames: boxes('.gal .gal-slide'),
    chip: box('.gal-chip'),
    chipText: txt('.gal-chip'),
    thumbsStrip: box('.gal-thumbs'),
    thumbs: boxes('.gal-thumb'),
    priceRow: box('.ld-price-row'),
    price: box('.ld-price'),
    priceText: txt('.ld-price'),
    per: box('.ld-per'),
    gettingThere: box('#getting-there'),
    mapWrap: box('.route-map-wrap'),
    routeMap: box('#routeMap'),
    hasRouteMap: !!document.getElementById('routeMap'),
    passage: box('.passage-card'),
    hasPassage: !!document.querySelector('.passage-card')
  });
})()`;

function narrowChecks(exp, narrow) {
  const out = [];
  const t = (n, ok, note) => out.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });
  const vw = narrow.vw;
  const inside = b => !!b && b.l >= -1 && b.r <= vw + 1 && b.w > 0;
  const fits = (b, what) => t(what, inside(b) && b.h > 0,
    JSON.stringify(b) + ' against a ' + vw + 'px viewport');

  t('the page was really measured at ' + NARROW.w + 'px (a device override, not the machine)',
    vw === NARROW.w, 'the page reports a ' + vw + 'px viewport');

  /* ---- the gallery ---- */
  fits(narrow.gal, 'the gallery stage is on screen and inside ' + vw + 'px');
  t('the stage keeps the stylesheet\'s own ' + LISTING.galRatio.w + ':' + LISTING.galRatio.h + ' shape',
    !!narrow.gal && Math.abs(narrow.gal.h - narrow.gal.w * LISTING.galRatio.h / LISTING.galRatio.w) <= 3,
    JSON.stringify(narrow.gal));
  /* Every frame is exactly one stage wide — the carousel's whole premise. The
     track is translated by multiples of 100% of ITS OWN width, so a frame that
     is even a pixel wider than the stage walks the paging step out of line and
     leaves a stripe of the next photo showing; a frame narrower than the stage
     leaves a gap. A rounded, clipped stage and sub-pixel rounding earn 1 px. */
  const FULL = 1;
  const full = f => !!f && Math.abs(f.w - narrow.gal.w) <= FULL && f.h > 0;
  /* The stage is the one element whose transform moves every frame's rect, so
     the widths above are only a verdict if there is no entrance transform to
     project them through. This pins the measurement itself: reduced motion on
     (the runner emulates it) and .gal's computed transform at `none`. Without
     it a future edit that drops the emulation would quietly go back to
     measuring a rising row and reporting a drift the layout does not have. */
  t('the page was measured settled (reduced motion, and the stage carries no entrance transform)',
    narrow.reduced === true && narrow.galTransform === 'none',
    JSON.stringify({ reduced: narrow.reduced, transform: narrow.galTransform }));
  t('the frame on screen is exactly a stage wide and inside ' + vw + 'px (of ' +
    narrow.frames.length + ' frame' + (narrow.frames.length === 1 ? '' : 's') + ')',
    narrow.frames.length > 0 && full(narrow.frames[0]) && inside(narrow.frames[0]),
    JSON.stringify({ frame: narrow.frames[0] || null, stage: narrow.gal,
      track: narrow.track, transform: narrow.galTransform }));
  t('every frame is exactly the stage\'s width, so paging lands on whole photos',
    narrow.frames.length > 0 && narrow.frames.every(full),
    'frame widths ' + narrow.frames.map(f => f.w).join(', ') +
      ' against a ' + narrow.gal.w + 'px stage (last frame left ' +
      (narrow.frames.length ? narrow.frames[narrow.frames.length - 1].l : '') +
      ') · track ' + JSON.stringify(narrow.track) +
      ' · transform ' + narrow.galTransform);
  if (exp.chip) {
    t('the gallery counter is inside ' + vw + 'px and still reads "' + exp.chip + '"',
      inside(narrow.chip) && narrow.chipText === exp.chip,
      JSON.stringify({ box: narrow.chip, text: narrow.chipText }));
  } else {
    t('a single frame shows no counter at ' + vw + 'px', !narrow.chip, JSON.stringify(narrow.chip));
  }
  if (exp.thumbs) {
    t('the thumbnail strip is on screen, inside ' + vw + 'px, with all ' + exp.thumbs +
      ' thumbnail' + (exp.thumbs === 1 ? '' : 's') + ' rendered',
      inside(narrow.thumbsStrip) && narrow.thumbs.length === exp.thumbs,
      JSON.stringify({ strip: narrow.thumbsStrip, thumbs: narrow.thumbs.length }));
    t('every thumbnail is a real tap target (the strip scrolls rather than bursting the page)',
      narrow.thumbs.length > 0 && narrow.thumbs.every(b => b.w > 0 && b.h >= 40),
      JSON.stringify(narrow.thumbs.filter(b => !(b.w > 0 && b.h >= 40)).slice(0, 3)));
  }

  /* ---- the price ---- */
  fits(narrow.priceRow, 'the price row is on screen and inside ' + vw + 'px');
  t('the price is inside ' + vw + 'px and still reads "' + exp.price + '"',
    inside(narrow.price) && narrow.priceText === exp.price && narrow.price.h > 0,
    JSON.stringify({ box: narrow.price, text: narrow.priceText }));
  fits(narrow.per, 'the "per session" line fits beside it');

  /* ---- the map placeholder ---- */
  if (exp.hasRouteMap) {
    fits(narrow.gettingThere, 'the "Getting there" section is on screen and inside ' + vw + 'px');
    t('the route map box keeps the stylesheet\'s own ' + LISTING.mapMinPx + 'px height at ' + vw + 'px',
      !!narrow.routeMap && inside(narrow.mapWrap) && narrow.routeMap.h >= LISTING.mapMinPx - 1,
      JSON.stringify({ wrap: narrow.mapWrap, map: narrow.routeMap }));
  } else {
    t('no map box is left behind when the pin is incomplete', !narrow.hasRouteMap,
      JSON.stringify(narrow.routeMap));
  }
  if (exp.hasPassage) {
    fits(narrow.passage, 'the walk-in card is on screen and inside ' + vw + 'px');
  }
  return out;
}

/* ---------------- main ---------------- */

(async function main() {
  const fx = await loadFixture();
  const cases = onlyCase ? onlyCase.split(',').map(s => s.trim()).filter(Boolean) : fx.order;
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
  if (!widths.length) throw new Error('--width must be desktop, mobile, narrow or both');
  if (!faultInject && (faultPreflight || faultCss || argVal('fault-seed') !== null)) {
    throw new Error('--fault-preflight, --fault-css and --fault-seed are --fault-inject options — add it');
  }
  if (faultInject && (!Number.isInteger(faultDrops) || faultDrops < 1)) {
    throw new Error('--fault-drops must be a positive integer');
  }
  if (faultInject && (!Number.isInteger(faultVictims) || faultVictims < 0)) {
    throw new Error('--fault-victims must be a whole number of scripts (0 turns the parser family off)');
  }
  if (faultInject && (!Number.isInteger(faultPreflight) || faultPreflight < 0)) {
    throw new Error('--fault-preflight must be a whole number of failed attempts');
  }
  if (faultInject && (!Number.isInteger(faultCss) || faultCss < 0)) {
    throw new Error('--fault-css must be a whole number of stylesheets');
  }
  if (faultInject && !(faultRate > 0 && faultRate <= 1)) {
    throw new Error('--fault-rate must be greater than 0 and at most 1');
  }
  if (!(renderTimeoutMs > 0)) {
    throw new Error('--render-timeout must be a positive number of seconds');
  }
  /* One family per run: each proves a different guard, and a load that lost a
     script AND a stylesheet would leave the harness's answer ambiguous. */
  const families = [
    faultVictims > 0 ? 'parser' : null,
    faultPreflight > 0 ? 'preflight' : null,
    faultCss > 0 ? 'css' : null
  ].filter(Boolean);
  if (faultInject && families.length > 1) {
    throw new Error('one fault family at a time — got ' + families.join(' + ') +
      '. Drop a script (--fault-victims), fail the preflight (--fault-preflight) or lose the stylesheet (--fault-css), separately.');
  }
  if (faultInject && !families.length) {
    throw new Error('--fault-inject with nothing to lose: give it --fault-victims=1, --fault-preflight=N or --fault-css=N');
  }
  const faultFamily = families[0] || null;
  const faultCandidates = (faultInject && faultFamily !== 'css') ? await bootCriticalScripts() : [];
  const faultSheets = (faultInject && faultFamily === 'css') ? await pageStylesheets() : [];
  /* asking to lose more than the page has is a request to weaken the mode
     quietly, so the count is capped here and said out loud below */
  const victimsPerLoad = Math.min(faultVictims, faultCandidates.length);
  const sheetsPerLoad = Math.min(faultCss, faultSheets.length);

  const { child: serverChild } = await ensureServer(base);
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-listing-'));
  console.log('Arzuz — listing render stress test');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('cases   ' + cases.join(', '));
  console.log('widths  ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', '));
  console.log('wait    ' + (renderTimeoutMs / 1000) + 's per load before a load is called stuck (--render-timeout=<seconds>)');
  if (faultInject) {
    const howOften = faultRate === 1 ? 'every load' : Math.round(faultRate * 100) + '% of loads';
    const what = faultFamily === 'parser'
      ? 'drop ' + faultDrops + ' parser request' + (faultDrops === 1 ? '' : 's') + ' per victim, losing ' +
        victimsPerLoad + ' of: ' + faultCandidates.join(', ')
      : faultFamily === 'preflight'
        ? 'fail ' + faultPreflight + ' preflight fetch' + (faultPreflight === 1 ? '' : 'es') + ' for one of: ' +
          faultCandidates.join(', ')
        : 'let ' + sheetsPerLoad + ' stylesheet' + (sheetsPerLoad === 1 ? '' : 's') + ' never arrive, of: ' +
          faultSheets.join(', ');
    console.log('fault   ' + what + '   (' + howOften + ')');
    console.log('seed    ' + faultSeed + '   (--fault-seed=' + faultSeed + ' replays this exact plan)');
    if (faultFamily === 'parser' && victimsPerLoad < faultVictims) {
      console.log('        (asked for ' + faultVictims + ' victims per load, but listing.html only names ' +
        faultCandidates.length + ' boot-critical scripts — losing all ' + victimsPerLoad + ')');
    }
    if (faultFamily === 'css' && sheetsPerLoad < faultCss) {
      console.log('        (asked for ' + faultCss + ' stylesheets per load, but listing.html only names ' +
        faultSheets.length + ' — losing all ' + sheetsPerLoad + ')');
    }
  }

  /* ---- the fixture's own plan, before a browser is opened ----
     The cases are generated from a declared matrix, so the questions to ask
     are: does the fixture agree with itself, is every declared cell covered,
     and does the derivation above still match the hand-verified numbers for
     the cases whose data has not changed? The last one is what stops the
     derivation from quietly becoming a description of whatever the page
     happens to do. */
  const derivations = {};
  cases.forEach(k => { derivations[k] = LISTING.deriveExpect(fx.cases[k].row); });

  /* the three questions every fixture plan is asked live in
     scripts/page-rules.mjs, beside the rules they describe; the rest are this
     page's own — the hand-verified table below, the cases the gate drives by
     name, and the restatement itself (verifyPageRules), which is what makes
     sharing the rules worth anything: this suite fails when listing.html
     moves on without the rules following */
  const planChecks = [];
  const pt = (n, ok, note) => planChecks.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });
  const fxPlan = typeof fx.plan === 'function' ? fx.plan() : null;
  if (!fxPlan) {
    pt('the fixture publishes its plan (dev/listing-fixture.js plan())', false,
      'ARZUZ_LISTING_FIXTURE has no plan() — the cases are not generated from a declared matrix');
  } else {
    planChecks.push.apply(planChecks, fixturePlanChecks(fxPlan, { noun: 'case' }));
    planChecks.push.apply(planChecks, await verifyPageRules('listing'));

    const mismatch = [];
    Object.keys(LISTING.anchor).forEach(k => {
      const want = LISTING.anchor[k];
      if (!fx.cases[k]) { mismatch.push(k + ': no such case in the fixture'); return; }
      const got = LISTING.deriveExpect(fx.cases[k].row);
      Object.keys(want).forEach(fieldName => {
        if (String(got[fieldName]) !== String(want[fieldName])) {
          mismatch.push(k + '.' + fieldName + ': derived ' + JSON.stringify(got[fieldName]) +
            ', hand-verified ' + JSON.stringify(want[fieldName]));
        }
      });
    });
    pt('the derivation matches the hand-verified table for ' + Object.keys(LISTING.anchor).join(', '),
      mismatch.length === 0, mismatch.slice(0, 6).join(' · '));

    /* the gate drives these two by name: test-all's fault modes run
       `--case=worst,huge`, so losing either is a silently reduced sweep */
    const missingDriven = ['worst', 'huge'].filter(k => !fxPlan.cases.some(c => c.key === k));
    pt('the cases the gate drives by name exist (worst, huge)', missingDriven.length === 0,
      'missing: ' + missingDriven.join(', '));
  }

  console.log('\nfixture plan');
  planChecks.forEach(c => {
    if (c.ok) console.log('  ✓ ' + c.name);
    else console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
  });

  let total = planChecks.length, failed = planChecks.filter(c => !c.ok).length;
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
    /* The settled layout, not a transform mid-flight — and reduced motion is
       also the layout a visitor who asks for it gets. This is not cosmetic:
       .gal carries [data-rise], and its entrance is a perspective()/rotateX
       transform. While that transition runs, the browser projects the 50-slide
       row through it, so a frame's getBoundingClientRect() grows with its
       distance along the row — measured 271 px → 377 px across frames that are
       all 272 px wide in layout (offsetWidth agrees on every one of them). The
       320px pass read the row mid-flight and reported a drift the page does not
       have; under this emulation the reveal is applied in place, the stylesheet
       zeroes the transform, and every frame measures the stage exactly. */
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    if (faultInject) {
      /* Interception is armed PER LOAD and AIMED at that load's victims — see
         the load loop below. It is never sprayed over every .js request:
         Chrome does not time a paused request out, so a single lost
         continueRequest hangs that request for ever, and this suite spent a
         morning reporting a harness that never booted because of exactly
         that. Fewer paused requests is fewer ways to hang a page. */
      cdp.listeners.push(msg => { if (msg.method === 'Fetch.requestPaused') onRequestPaused(cdp, msg.params); });
    }

    for (const name of cases) {
      const url = base + '/dev/listing-harness.html?case=' + name + '&id=fx-' + name;

      for (const vp of widths) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
        });

        /* collect what the page itself threw this run */
        const cdpErrors = [];
        const spy = msg => {
          /* a navigation starts a new document: errors thrown by a document
             the harness then discarded (its retry) must not sink the one we
             are actually judging */
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

        const label = name.toUpperCase() + ' · ' + vp.key + ' ' + vp.w + 'px';
        let page = null, failure = null;
        let faulted = false, lost = [], sheets = [], preflight = null;
        if (faultInject) {
          /* armed per load, and it stays armed across the harness's own
             reload: one load = one document plus the retry it may take, and
             the retry has to see the same plan (its requests are the ones
             the harness needs back). */
          faulted = rnd() < faultRate;
          if (faulted) {
            if (faultFamily === 'parser') lost = pickVictims(faultCandidates, victimsPerLoad);
            if (faultFamily === 'preflight') preflight = { victim: pickVictims(faultCandidates, 1)[0], budget: faultPreflight, sent: 0 };
            if (faultFamily === 'css') sheets = pickVictims(faultSheets, sheetsPerLoad);
          }
          fault.family = faulted ? faultFamily : null;
          fault.victims = lost;
          fault.sheets = sheets;
          fault.preflight = preflight;
          fault.budget = faultDrops;
          fault.sent = {};
          fault.landed = 0;
          fault.armed = faulted;
          fault.loads += 1;
          if (faulted) fault.faulted += 1;
          /* the pattern names this load's victims, so nothing else is paused;
             a load the rate left clean is not intercepted at all */
          const aimed = !faulted ? []
            : faultFamily === 'preflight' ? [preflight.victim]
              : faultFamily === 'css' ? sheets
                : lost;
          await cdp.send(aimed.length ? 'Fetch.enable' : 'Fetch.disable',
            aimed.length ? { patterns: aimed.map(v => ({ urlPattern: '*' + v + '*', requestStage: 'Request' })) } : {});
        }
        /* The browser wrote nothing at all: `render` only throws when not one
           evaluation came back, so there is no document — not a bad one, none
           — to judge. That is a renderer that never got CPU, and it is what a
           starved machine looks like (measured: this suite beside the SQL
           mutation suite, 180s with nothing read, the same load green alone).
           So the load gets one more document to try, and the retry is printed
           below. A page that is genuinely broken still fails: it fails twice.
           The fault plan is untouched — the interception stays armed, so the
           second document loses exactly what the first one did. */
        let documents = 0;
        for (;;) {
          documents += 1;
          try {
            page = await render(cdp, url);
            failure = null;
            break;
          } catch (e) {
            failure = e.message;
            page = null;
            if (documents >= 2) break;
          }
        }
        const secondDocument = documents > 1 && !!page;
        const faultSent = Object.assign({}, fault.sent);
        const faultLanded = fault.landed;
        const preflightSent = preflight ? preflight.sent : 0;
        if (faultInject) {
          fault.armed = false;
          const landedAll = faultFamily === 'parser'
            ? (lost.length > 0 && lost.every(v => (faultSent[v] || 0) >= faultDrops))
            : faultFamily === 'preflight'
              ? preflightSent >= faultPreflight
              : (sheets.length > 0 && sheets.every(v => !!faultSent[v]));
          fault.losses += Object.keys(faultSent).reduce((a, v) => a + faultSent[v], 0) + preflightSent;
          /* What the harness "answering as it had to" means depends on the
             family: a lost script must come back on the one reload, a failed
             preflight must be retried by the harness itself so the FIRST
             document boots, and a lost stylesheet must be reported as
             unstyled rather than passing. */
          const answered = !failure && !!page && (faultFamily === 'parser'
            ? page.boot === 'ok-after-retry'
            : faultFamily === 'preflight'
              ? page.boot === 'ok'
              : !!(page.style && !page.style.styled));
          if (faulted && landedAll && answered) fault.proved += 1;
        }
        cdp.listeners = cdp.listeners.filter(f => f !== spy);

        if (!failure && page && page.boot === 'preflight-failed') {
          failure = 'the harness could not write the page: ' +
            String(page.harnessError || 'no reason given').replace(/^Harness failed:\s*/, '');
        }
        if (!failure && (!page || !page.diagParsed)) {
          /* say what the wait was spent on: a page that was written but never
             settled and a page that was never written are different failures,
             and the old message could not tell them apart */
          failure = 'the fixture never reported back within ' + (renderTimeoutMs / 1000) +
            's — did the page boot?  (harness boot: ' + ((page && page.boot) || 'never wrote a document') +
            ')' + (page && page.harnessError ? '  ' + page.harnessError : '');
        }
        if (failure) {
          if (faultInject && faulted) {
            /* the control families are SUPPOSED to fail here: say what was
               taken, so the red is readable as the control and not as a page
               that broke on its own */
            const control = (faultFamily === 'parser' && faultDrops > 1) ||
              (faultFamily === 'preflight' && faultPreflight >= 3);
            failure += '\n      fault: ' + faultLine(lost, sheets, preflight, faultSent, preflightSent) +
              (control
                ? '  — this is the family control: an unrecoverable loss is meant to be fatal'
                : '  — nothing here was meant to be fatal; the harness should have carried this load');
          }
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

        /* In the css family the page is MEANT to be unstyled. The harness
           guard is asserted the other way round (a styled page there would
           mean the stylesheet arrived and the load proved nothing), and the
           page's OWN checks are not verdicts: a page without its stylesheet
           is expected to look wrong — that damage is the evidence the loss
           was real, and it is printed below — while what this family proves
           is that the loss can never pass unnoticed. Everywhere else those
           checks are verdicts as usual, with the style guard among them. */
        const cssFamily = faultInject && faulted && faultFamily === 'css';
        const pageChecks = universal(page, { expectUnstyled: cssFamily })
          .concat(specifics(name, page, derivations[name]));

        /* the phone width gets a second measurement of the same document —
           the gallery, the price and the map placeholder, which are what a
           squeezed screen breaks first. In the css family the page is
           deliberately unstyled, so those measurements are evidence rather
           than a verdict: they are appended before the filter below, which
           keeps only the style guard there. */
        if (vp.key === NARROW.key && !cssFamily) {
          try {
            const narrow = JSON.parse(await cdp.evaluate(NARROW_READOUT));
            pageChecks.push.apply(pageChecks, narrowChecks(derivations[name], narrow));
          } catch (e) {
            pageChecks.push({ name: 'the ' + NARROW.w + 'px pass could read the layout', ok: false,
              note: String((e && e.message) || e) });
          }
        }

        const checks = cssFamily ? pageChecks.filter(c => c.cssGuard) : pageChecks;
        if (faultInject) {
          /* A load the rate left alone has one obligation: it must have been
             left alone, and it must boot on the first document. */
          if (!faulted) {
            checks.push({
              name: 'this load was left alone (fault rate ' + faultRate + ') and booted first try',
              ok: faultLanded === 0 && page.boot === 'ok',
              note: faultLanded + ' request' + (faultLanded === 1 ? '' : 's') +
                ' failed on a load that was meant to be clean · boot ' + page.boot
            });
          } else if (faultFamily === 'parser') {
            /* the drop has to land (a load where nothing was dropped proves
               nothing, and fails) AND the harness's one retry has to bring
               every script back */
            checks.push({
              name: 'the fault landed — the parser never got ' + lost.join(' + '),
              ok: lost.every(v => (faultSent[v] || 0) >= faultDrops),
              note: lost.map(v => v + ': ' + (faultSent[v] || 0) + ' of ' + faultDrops + ' parser request' +
                (faultDrops === 1 ? '' : 's')).join(' · ') +
                ' — a zero means that script was never actually lost, so this load proved nothing'
            });
            /* A load whose page came out complete anyway — Chrome served the
               script from its own copy even though the request was killed — is
               neither a recovery nor a failure: the kill cost it nothing. It
               is reported as exactly that and never counted as proof (see
               fault.proved), so it cannot make this family look greener than
               it was. A boot of `ok` WITH something still missing is the
               harness's guard failing, and stays red. */
            const nothingMissing = !page.harnessMissing || !page.harnessMissing.length;
            const harmless = page.boot === 'ok' && nothingMissing;
            checks.push({
              name: 'the loss was answered — the harness reloaded once and the page booted with all ' +
                lost.length + ' lost script' + (lost.length === 1 ? '' : 's') + ' back',
              ok: page.boot === 'ok-after-retry' || harmless,
              note: harmless
                ? 'the page booted first try with everything present: Chrome served its own copy, ' +
                  'so the kill cost this load nothing and it is not counted as proof of recovery'
                : 'harness boot state after the loss: ' + page.boot +
                  (page.harnessMissing && page.harnessMissing.length
                    ? ' · still missing: ' + page.harnessMissing.join(', ')
                    : '')
            });
          } else if (faultFamily === 'preflight') {
            /* the harness's own retry has to carry this load: the preflight
               failed and the FIRST document still booted */
            checks.push({
              name: 'the fault landed — the preflight fetch for ' + preflight.victim + ' failed ' +
                faultPreflight + ' time' + (faultPreflight === 1 ? '' : 's'),
              ok: preflightSent >= faultPreflight,
              note: 'saw ' + preflightSent + ' of ' + faultPreflight + ' failed preflight attempt' +
                (faultPreflight === 1 ? '' : 's') + ' for ' + preflight.victim +
                ' — fewer means the harness did not ask again, so nothing was proven'
            });
            checks.push({
              name: 'the harness retried the preflight by itself and the first document booted',
              ok: page.boot === 'ok',
              note: 'boot after the preflight was refused: ' + page.boot +
                (page.boot === 'ok-after-retry'
                  ? ' — the document was reloaded, so it was not the preflight retry that saved this load'
                  : '')
            });
          } else {
            /* no retry exists for a stylesheet, so what is proven here is
               that the harness SAID the page is unstyled instead of the
               suite passing a naked page */
            checks.push({
              name: 'the fault landed — the stylesheet' + (sheets.length === 1 ? ' ' : 's ') + sheets.join(', ') +
                ' never arrived',
              ok: sheets.every(v => !!faultSent[v]),
              note: sheets.map(v => v + ': ' + (faultSent[v] || 0) + ' request arrived anyway').join(' · ')
            });
            const expectedApplied = page.style ? page.style.linked - sheets.length : null;
            checks.push({
              name: 'the harness named exactly the loss: ' + sheets.join(', ') + ' is the only sheet not applied',
              ok: !!page.style && page.style.applied === expectedApplied,
              note: page.style
                ? page.style.applied + ' of ' + page.style.linked + ' named stylesheets applied' +
                  ' (expected ' + expectedApplied + ' with ' + sheets.join(', ') + ' gone)'
                : 'the harness did not report the style state at all'
            });
          }
        }
        const bad = checks.filter(x => !x.ok);
        total += checks.length; failed += bad.length;

        console.log('\n' + label);
        if (faultInject) {
          console.log(faulted
            ? '  · fault: ' + faultLine(lost, sheets, preflight, faultSent, preflightSent) + ', boot ' + page.boot
            : '  · fault: none (rate ' + faultRate + ' left this load clean), boot ' + page.boot);
        }
        if (secondDocument) {
          console.log('  · no document came back in ' + (renderTimeoutMs / 1000) +
            's — not one read ever landed, so this load was retried once ' +
            '(a renderer that starved, not a page verdict)');
        }
        if (cssFamily) {
          const content = pageChecks.filter(c => !c.cssGuard);
          const broke = content.filter(c => !c.ok);
          console.log('  · the page itself: ' + broke.length + ' of ' + content.length +
            ' content checks failed — evidence, not a verdict in this family: a page without its stylesheet is meant to look wrong' +
            (broke.length ? ' (' + broke[0].name + (broke.length > 1 ? ', …' : '') + ')' : ''));
        }
        if (page.boot === 'ok-after-retry') {
          console.log('  · the harness reloaded once: the first load never booted its shared layer ' +
            '(a script request was lost), so the numbers below are the second load');
        }
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
    if (chromeChild) killChrome(chromeChild);
    if (serverChild) { serverChild.kill(); serverChild.unref(); }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + total + ' · PASS ' + (total - failed) + ' · FAIL ' + failed);
  if (faultInject) {
    console.log('fault  ' + fault.faulted + ' of ' + fault.loads + ' load' + (fault.loads === 1 ? '' : 's') +
      ' faulted (' + faultFamily + ') · ' + fault.losses + ' request' + (fault.losses === 1 ? '' : 's') +
      ' never arrived · ' + fault.proved + ' answered by the harness as this family requires');
    console.log('seed   ' + faultSeed + '   (this exact plan: --fault-seed=' + faultSeed + ')');
    /* A partial rate can select no load at all, and a fault sweep where the
       fault never fired is a green run that proved nothing — the exact
       failure this repo keeps naming. It is a failure, not a footnote. */
    if (!fault.faulted) {
      console.log('\n✗ no load was faulted, so nothing about the recovery was exercised' +
        ' (rate ' + faultRate + ' over ' + fault.loads + ' load' + (fault.loads === 1 ? '' : 's') +
        ') — re-run, or use --fault-rate=1');
      process.exitCode = 1;
    } else if (!fault.proved) {
      /* a faulted load that the browser undid on its own is not a proof that
         the harness can recover — and a sweep with no proof at all is the
         green run that proves nothing this mode exists to prevent */
      console.log('\n✗ not one of the ' + fault.faulted + ' faulted load' + (fault.faulted === 1 ? '' : 's') +
        ' needed the harness to answer for it (every kill was undone by the browser\'s own copy)' +
        ' — a green run here proves nothing about the recovery');
      process.exitCode = 1;
    }
  }
  if (failed) process.exitCode = 1;
})();
