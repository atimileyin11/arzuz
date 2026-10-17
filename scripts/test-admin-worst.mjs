#!/usr/bin/env node
/* ============================================================
   Arzuz — admin dashboard: the fixture, in a real browser

   WHY THIS EXISTS

     Round 4 fed the dashboard the break-ui fixture by hand
     (`admin.html?mock=1&seed=worst`) and found six real breaks,
     two of them silent: a NULL `env` reported as live, and every
     failing row saying only "hidden" with the reason nowhere on
     screen. A hand-walk proves that once. This proves it on every
     push, because the failures that matter here are not crashes —
     they are rows that save fine, render fine, and never reach a
     student, and none of them are visible in a screenshot.

   WHAT IT ASSERTS

     1. Nothing overflows. No text escapes the box holding it,
        nothing is clipped with no way to scroll to it, and the page
        never scrolls sideways — at 1440, at 390 (where the table
        becomes cards) and inside the composer at 309. The table's
        total width is bounded too, so the 2,343 px regression cannot
        come back while the page still "passes" because it scrolls.
        The three reasons an element can be too wide are NOT stated
        here: they are stated once in scripts/page-rules.mjs
        (LAYOUT_RULES) and interpolated into the scan below, so this
        suite cannot judge last month's vocabulary while the invite
        and listing suites judge this month's.
     2. Every row's Browse-board verdict is the one its OWN data
        earns, computed here from the three conditions the public
        view applies (status active, tier >= 1, env production).
        The fixture comes from the page (`__MOCK__.db()`) — the
        same rows the table is rendering — so the expectation and
        the rendering cannot drift apart.
     3. Every "hidden" badge carries a reason that names the
        condition that failed, and a draft is never offered the
        one-click Publish (publishing a draft kills its invite
        link, so that has to stay a two-step).
     4. The composer says the same thing before the save: the note
        under Verification Tier is never empty and follows the
        selects — tier 0 and a pending status each name themselves.
     5. The fixture still COVERS every status × tier × env
        combination, and no row's own record lies about it. The
        fixture is generated (dev/admin-mock-data.js → worstListings)
        and publishes its plan (worstPlan), so this reads the plan
        back from the page: the declared statuses must equal the
        Status filter the dashboard itself renders, the tiers its
        Tier select, and every cell of the product must have a row
        whose record matches its own data. The old hand-written list
        had no tier-0 row at all — the branch the bug report was
        about — which is why coverage is checked against the product
        now, not against a list someone has to remember to extend.

   LOSING A BOOT SCRIPT ON PURPOSE (--fault-inject)

     The dashboard's own boot is one script (assets/admin.js), and a request lost
     between the page being sent and the parser running it leaves the dashboard
     sitting on its shell. This suite reported that as "the dashboard never
     settled: the mock harness never booted" — a page bug's clothes on a lost
     request. dev/page-harness-boot.js repairs it in the page instead: it runs
     last, asks for the layer the boot needs, and reloads ONCE when any of it is
     missing. This mode reproduces the loss at the network layer, so a run proves
     the repair rather than a hand-edited page walk.

     The candidates come from scripts/page-rules.mjs, which reads the check's own
     LAYERS row for admin.html and intersects it with the scripts the page names
     — derived, never copied here. --fault-drops=2 kills the reload's copy as
     well, which MUST leave the run red: the control that proves a page which
     cannot be repaired is still reported as broken.

   Run from arzuz-site/:
     node scripts/test-admin-worst.mjs
     node scripts/test-admin-worst.mjs --case=worst      one case, full detail
     node scripts/test-admin-worst.mjs --urls            print the harness URLs
     node scripts/test-admin-worst.mjs --base=http://localhost:8123   reuse someone's server
     node scripts/test-admin-worst.mjs --dump            save each rendered page body
     node scripts/test-admin-worst.mjs --fault-inject                 lose one boot script per load; the page's own check must repair it
     node scripts/test-admin-worst.mjs --fault-inject --fault-drops=2  kill the reload's copy too — the control, which must FAIL
     node scripts/test-admin-worst.mjs --fault-inject --fault-rate=0.5 fault half the loads; the rest must boot clean
     node scripts/test-admin-worst.mjs --fault-inject --fault-seed=42  the plan is random; this replays one exactly

   Its own dev server listens on 8134 by default (see DEFAULT_BASE) so it
   never shares a server with the other browser suites.

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
/* the three overflow reasons — stated once, in the same file the invite and
   listing suites read them from, and never typed out below — and the boot layer
   this page's lost-script fault mode aims at, read back out of
   dev/page-harness-boot.js rather than kept here a second time */
import { LAYOUT_RULES, harnessBootPlan, HARNESS_BOOT_FILE } from './page-rules.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const onlyCase = argVal('case');
/* ARZUZ_TEST_BASE does the same job as --base for the whole suite:
   two checkouts (or an agent and a person) can run these at once
   without fighting over the port. */
const baseArg = argVal('base') || process.env.ARZUZ_TEST_BASE || null;
/* Its OWN default port, deliberately: the two older browser suites both
   default to 8123 and reuse whatever is already listening there. When
   they run in one lane that is a shared server, and whichever suite
   started it kills it on the way out — taking the others' page loads
   with it. A suite that brings its own port cannot be that victim. */
const DEFAULT_BASE = 'http://localhost:8134';
const widthArg = argVal('width');          /* desktop | mobile | both (default both) */
const urlsOnly = args.includes('--urls');
const keepBody = args.includes('--dump');

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

/* the composer is the third layout: the Add modal at 309 px, where the
   availability segment used to run 28 px off the right edge */
const COMPOSER = { key: 'composer', w: 309, h: 760 };

/* The table is content-driven and genuinely wider than its pane, so the
   bound is relative to the pane: measured 1,620 px in a 1,162 px pane
   after the round-4 fixes, and 2,343 px in a 991 px pane before them.
   700 px of headroom separates the two without pinning a font metric. */
const MAX_EXTRA_PX = 700;

const CASES = {
  worst: {
    seed: 'worst',
    note: 'the generated break-ui fixture — every status × tier × env, plus the payload extremes'
  },
  demo: {
    seed: 'demo',
    note: 'the everyday dataset — the clamp floor must not have cost the common case'
  }
};

/* ---------------- fault injection --------------

   The dashboard's dev mode hands the browser a document that names eleven
   scripts. The page's own boot (assets/admin.js) is the one everything else
   hangs off, and dev/page-harness-boot.js is what tells a request lost between
   the page being sent and the parser running it from a dashboard that is
   genuinely broken. Without it this suite reported the second as "the dashboard
   never settled: the mock harness never booted" — a test-fidelity bug wearing a
   page bug's clothes, which is the failure this mode exists to keep out.

   The candidates are DERIVED, never copied: scripts/page-rules.mjs reads
   dev/page-harness-boot.js's own LAYERS row for admin.html and intersects it
   with the scripts the page names (dev/admin-mock*.js included — admin.html
   injects those with document.write, so they are named in its text). A script
   added to both is instantly a target; one dropped from the page stops being
   one. If that intersection is ever empty the plan pins below fail before a
   browser opens, because a recovery nobody could have needed is not a passed
   test.

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
   moving. 'retrying' is a reload in flight, not a state to judge — and a faulted
   load's check can still be deciding while the dashboard already looks settled,
   because the dashboard renders from the mock before the check has spoken. */
const BOOT_SETTLED = ['ok', 'ok-after-retry', 'still-missing'];
async function bootState(cdp, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await cdp.evaluate(
        "JSON.stringify({ boot: document.documentElement.getAttribute('data-harness-boot')," +
        " missing: (window.__HARNESS__ && window.__HARNESS__.missing) || [], href: location.href })"));
    } catch { last = null; }
    if (last && BOOT_SETTLED.indexOf(last.boot) !== -1) return last;
    await new Promise(r => setTimeout(r, 150));
  }
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || ''));
    }
    return r.result.value;
  }
  async close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket error')); });
  });
}

/* ---------------- base server ---------------- */

async function reachable(base) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(base + '/admin.html', { signal: c.signal });
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

/* ---------------- the page probes ----------------
   One round trip returns the fixture, what the table rendered for it,
   the verdict the page claims, and the numbers the width bound needs. */

const READY = `(function(){
  try {
    var M = window.__MOCK__;
    if (!M || typeof M.db !== 'function') return JSON.stringify({ ready: false, why: 'the mock harness never booted' });
    var sec = document.querySelector('.section-view[data-section="listings"]');
    if (!sec) return JSON.stringify({ ready: false, why: 'no listings section in the page' });
    if (sec.offsetHeight === 0) return JSON.stringify({ ready: false, why: 'the listings section is not the active route' });

    var wrap = sec.querySelector('.table-wrap');
    var body = sec.querySelector('#tableBody');
    var cards = sec.querySelectorAll('#tableCards .row-card');
    var tableOn = !!wrap && getComputedStyle(wrap).display !== 'none';
    var trs = (body && tableOn) ? body.querySelectorAll('tr') : [];
    if (!trs.length && !cards.length) return JSON.stringify({ ready: false, why: 'the rows have not rendered yet' });

    var db = M.db();
    var fixture = (db.listings || []).map(function (r) {
      var c = r.case || null;
      return { id: String(r.id),
               status: r.status == null ? '' : String(r.status),
               tier: r.tier,
               env: r.env == null ? null : String(r.env),
               case: c ? {
                 label: String(c.label || ''),
                 status: c.status == null ? '' : String(c.status),
                 tier: c.tier,
                 env: c.env == null ? null : String(c.env),
                 exercise: String(c.exercise || ''),
                 stress: c.stress == null ? null : String(c.stress)
               } : null };
    });

    /* the fixture's own plan (the generated worst case publishes it),
       and the enumerations the dashboard itself is showing — read live,
       so a status added to the dashboard fails until the fixture grows
       it, and a fixture that invents one fails the other way */
    var plan = null;
    try {
      if (window.ArzuzMockData && typeof window.ArzuzMockData.worstPlan === 'function') plan = window.ArzuzMockData.worstPlan();
    } catch (e) { plan = null; }

    var sf = document.getElementById('statusFilter');
    var liveStatuses = [];
    if (sf) Array.prototype.forEach.call(sf.options, function (o) {
      var v = String(o.value || '');
      if (v && v !== 'all') liveStatuses.push(v);
    });
    var at = document.getElementById('add_tier');
    var liveTiers = [];
    if (at) Array.prototype.forEach.call(at.options, function (o) {
      var n = Number(o.value);
      if (isFinite(n)) liveTiers.push(n);
    });

    function describe(node) {
      var hit = node.querySelector('[data-id]');
      var badge = node.querySelector('.board-badge');
      var cls = badge ? String(badge.className || '') : '';
      var state = null;
      if (badge) state = cls.indexOf('live') !== -1 ? 'live' : (cls.indexOf('hidden') !== -1 ? 'hidden' : 'other');
      return {
        id: hit ? hit.getAttribute('data-id') : null,
        state: state,
        title: badge ? String(badge.getAttribute('title') || '') : '',
        label: badge ? String(badge.textContent || '').replace(/\\s+/g, ' ').trim() : '',
        publish: !!node.querySelector('[data-act="publish"]')
      };
    }

    var rendered = [];
    Array.prototype.forEach.call(trs, function (tr) { var d = describe(tr); if (d.id) rendered.push(d); });
    Array.prototype.forEach.call(cards, function (c) { var d = describe(c); if (d.id) rendered.push(d); });

    var toggle = document.getElementById('mockSeedToggle');
    var marked = null;
    if (toggle) {
      Array.prototype.forEach.call(toggle.querySelectorAll('[data-mock-seed]'), function (b) {
        if (String(b.getAttribute('style') || '').indexOf('rgba(122, 90, 248') !== -1) marked = b.getAttribute('data-mock-seed');
      });
    }

    var doc = document.documentElement;
    return JSON.stringify({
      ready: true,
      fixture: fixture,
      plan: plan,
      liveStatuses: liveStatuses,
      liveTiers: liveTiers,
      rendered: rendered,
      tableOn: tableOn,
      tablePx: wrap ? Math.round(wrap.scrollWidth) : 0,
      panePx: wrap ? Math.round(wrap.clientWidth) : 0,
      bodyPx: tableOn ? Math.round(sec.querySelector('table').scrollWidth) : 0,
      cardCount: cards.length,
      html: sec.innerHTML.length,
      badText: /NaN|undefined|\\[object Object\\]/.test(sec.innerHTML + ' ' + sec.textContent),
      horizontal: doc.scrollWidth > doc.clientWidth + 1,
      docScrollW: doc.scrollWidth,
      docClientW: doc.clientWidth,
      toggle: !!toggle,
      toggleMarked: marked,
      seed: (new URLSearchParams(location.search).get('seed') || 'demo')
    });
  } catch (e) {
    return JSON.stringify({ ready: false, why: 'probe threw: ' + (e && e.message) });
  }
})()`;

/* the overflow scan — three ways an element can be too wide, in the order
   that finds the real one rather than the harmless one. The three reasons are
   interpolated from scripts/page-rules.mjs (LAYOUT_RULES), so this scanner and
   the listing harness's and the invite suite's name the same sentences. */
const scanFn = `function __awScan(root){
  var offenders = [], count = 0;
  function shown(el){
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  /* A horizontally scrollable box is a viewport, not a place content gets
     lost — the table itself is wider than its pane on purpose. So a
     scroller is never an offender, and neither is anything inside one
     (its text is reachable by scrolling). */
  function isScroller(cs){ return cs.overflowX === 'auto' || cs.overflowX === 'scroll'; }
  function scrolled(el){
    var n = el.parentElement;
    while (n && n !== root && n !== document.body) {
      if (isScroller(getComputedStyle(n))) return n;
      n = n.parentElement;
    }
    return null;
  }
  function label(el){
    var cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    return (el.tagName.toLowerCase() + cls).slice(0, 64);
  }
  var els = root.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!shown(el)) continue;
    count++;
    var cs = getComputedStyle(el);
    var box = el.getBoundingClientRect();
    var text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 44);
    var scrollable = scrolled(el);

    /* a scroller is a viewport; an ellipsis is a deliberate cut, and the
       text behind it is meant to be cut. Neither is a layout break. */
    if (isScroller(cs) || cs.textOverflow === 'ellipsis') continue;

    /* text that runs past its own box, with nothing to scroll to */
    if (!scrollable && cs.textOverflow !== 'clip') {
      var range = document.createRange();
      range.selectNodeContents(el);
      var tb = range.getBoundingClientRect();
      if (tb.width && tb.right > box.right + 1.5) {
        offenders.push({ why: '${LAYOUT_RULES.text}', el: label(el), by: Math.round(tb.right - box.right), text: text });
        continue;
      }
    }

    /* content hidden behind an overflow with nothing to scroll */
    if (el.scrollWidth > el.clientWidth + 1.5 && cs.overflowX !== 'visible' && !scrollable) {        offenders.push({ why: '${LAYOUT_RULES.clip}', el: label(el), by: el.scrollWidth - el.clientWidth, text: text });
      continue;
    }

    /* the box itself wider than the thing that contains it */
    var par = el.parentElement;
    if (par && par !== root && !scrollable && par.offsetHeight !== undefined && shown(par) &&
        getComputedStyle(par).overflowX === 'visible') {
      var pb = par.getBoundingClientRect();
      if (pb.width && box.right > pb.right + 1.5) {
        offenders.push({ why: '${LAYOUT_RULES.box}', el: label(el), by: Math.round(box.right - pb.right), text: text });
      }
    }
  }
  return JSON.stringify({ scanned: count, offenders: offenders });
}`;

const scanner = scope => `(function(){ ${scanFn};
  var root = document.querySelector(${JSON.stringify(scope)});
  if (!root) return JSON.stringify({ missing: true, offenders: [] });
  return __awScan(root);
})()`;

/* ---------------- the fixture, read the same way the test reads it ---------------- */

/* The three conditions public_listings applies. Computed here from the
   row's own fields, NOT from the page's badge, so a badge that lies is
   the failure. The kind is the branch the row exercises — the FIRST
   condition that fails, exactly as boardState() ranks them. */
function expected(row) {
  const status = String(row.status == null ? '' : row.status).toLowerCase();
  const tier = Number(row.tier);
  const env = String(row.env == null ? '' : row.env).toLowerCase();
  if (status !== 'active') return { live: false, reason: 'its status is ' + (status || 'empty'), kind: 'hidden:status' };
  if (!(tier >= 1)) return { live: false, reason: 'it is tier 0', kind: 'hidden:tier' };
  if (env !== 'production') {
    return {
      live: false,
      reason: env ? 'its env is ' + env : 'its env is empty',
      kind: env ? 'hidden:env' : 'hidden:env-empty'
    };
  }
  return { live: true, reason: '', kind: 'live' };
}

/* The board's own vocabulary — mirroring boardState() in
   assets/admin.js and public_listings. The generated fixture has to
   declare all of it, and its rows have to exercise all of it. */
const BOARD_ENVS = ['production', 'test', null];
const BRANCHES = ['live', 'hidden:status', 'hidden:tier', 'hidden:env', 'hidden:env-empty'];

/* ---------------- main ---------------- */

(async function main() {
  const cases = onlyCase ? [onlyCase] : Object.keys(CASES);
  for (const c of cases) if (!CASES[c]) throw new Error('unknown case "' + c + '" — have: ' + Object.keys(CASES).join(', '));

  const base = baseArg || DEFAULT_BASE;
  if (urlsOnly) {
    console.log('Open any of these, then use the Fixtures switcher at the bottom of the page:\n');
    for (const c of cases) console.log('  ' + base + '/admin.html?mock=1' + (CASES[c].seed === 'worst' ? '&seed=worst' : '') + '#/listings');
    console.log('\n(the mock harness only loads on localhost with ?mock=1; nothing here ships)');
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
  /* the boot layer the fault mode aims at, and the plan pins that say the aim is
     still true — run in EVERY run, so a table that drifted from the page fails
     as a plan rather than as a fault mode that quietly shoots at nothing */
  const bootSource = await readFile(join(SITE, HARNESS_BOOT_FILE), 'utf8');
  const bootPlan = harnessBootPlan({
    page: 'admin.html',
    bootSource: bootSource,
    pageSource: await readFile(join(SITE, 'admin.html'), 'utf8')
  });
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
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-admin-'));
  console.log('Arzuz — admin dashboard worst-case render test');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('cases   ' + cases.join(', '));
  console.log('widths  ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', ') + ', composer ' + COMPOSER.w + 'px');

  let total = 0, failed = 0;
  const faultChecks = [];
  let chromeChild = null, cdp = null;

  /* ---- the boot plan, printed like every other block so a failure is readable ---- */
  {
    const bad = bootPlan.checks.filter(c => !c.ok);
    total += bootPlan.checks.length || 1;
    failed += bad.length;
    console.log('\n════ BOOT — the scripts ' + HARNESS_BOOT_FILE + ' repairs on this page (' +
      faultCandidates.join(', ') + ')');
    for (const c of bad) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
    console.log(bad.length
      ? '  ' + (bootPlan.checks.length - bad.length) + '/' + bootPlan.checks.length + ' checks passed'
      : '  ✓ ' + bootPlan.checks.length + '/' + bootPlan.checks.length + ' checks passed');
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

    /* the page's own console, quoted but not asserted on: the dashboard
       reaches for tile servers and fonts, and a laptop with no network
       must not fail this test for it */
    const pageErrors = [];
    cdp.listeners.push(msg => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push('console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
      }
    });

    /* the network layer the fault mode kills a request at: armed per load,
       aimed at that load's victim, and silent the rest of the time */
    if (faultInject) {
      cdp.listeners.push(msg => { if (msg.method === 'Fetch.requestPaused') onRequestPaused(cdp, msg.params); });
    }

    const settle = async (minRows = 1, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      let last = { why: 'nothing came back' };
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
        let raw;
        try { raw = await cdp.evaluate(READY); } catch { continue; }
        let page;
        try { page = JSON.parse(raw); } catch { continue; }
        last = page;
        if (page.ready && page.rendered.length >= minRows) return page;
      }
      /* What the document looked like when the clock ran out, read the same way
         the fault mode reads it: a load whose shared layer never arrived says so
         here instead of only saying "never settled". */
      let where = '';
      try {
        where = await cdp.evaluate(
          "JSON.stringify({ href: location.href, ready: document.readyState," +
          " boot: document.documentElement.getAttribute('data-harness-boot')," +
          " mock: typeof window.__MOCK__, admin: typeof window.ArzuzAdmin," +
          " scripts: [].slice.call(document.querySelectorAll('script[src]')).length })");
      } catch { where = 'the page could not be read back'; }
      throw new Error('the dashboard never settled: ' + (last && last.why) +
        ' (rows on screen: ' + ((last.rendered || []).length) + ', wanted ' + minRows + ')' +
        ' · the document at that moment: ' + where);
    };

    const openPage = async (seed, vp) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      const url = base + '/admin.html?mock=1' + (seed === 'worst' ? '&seed=worst' : '') + '#/listings';

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

      const nav = await cdp.send('Page.navigate', { url });
      /* Page.navigate resolves whether or not it got there, so the browser's own
         verdict on the request is said out loud rather than left to look like a
         dashboard that never rendered */
      if (nav && nav.errorText) console.log('  ✗ the browser refused ' + url + ': ' + nav.errorText);

      let page = null, neverSettled = null;
      try { page = await settle(); } catch (e) { neverSettled = e; }

      /* Stay armed across the page's own reload — one load is one document plus
         the retry it may take — then stand down and say what happened. */
      if (faultInject) {
        const sent = Object.assign({}, fault.sent);
        const landed = fault.landed;
        fault.armed = false;
        const boot = await bootState(cdp);
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
        console.log('  · fault: ' + (faulted
          ? faultLine(lost, sent) + ', boot ' + boot.boot
          : 'none (rate ' + faultRate + ' left this load clean), boot ' + boot.boot));

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
            name: 'the loss was answered — the boot check reloaded once and the dashboard came up with ' +
              (lost.length === 1 ? 'the lost script' : 'all ' + lost.length + ' lost scripts') + ' back',
            ok: answered || harmless,
            note: harmless
              ? 'the dashboard booted first try with everything present: Chrome served its own copy, so ' +
                'the kill cost this load nothing and it is not counted as proof of recovery'
              : 'boot state after the loss: ' + boot.boot +
                (boot.missing && boot.missing.length ? ' · still missing: ' + boot.missing.join(', ') : '') +
                (faultControl ? '  — this is the control: an unrecoverable loss is meant to be fatal' : '')
          });
        }
      }

      if (neverSettled) throw neverSettled;
      return page;
    };

    for (const name of cases) {
      const cfg = CASES[name];
      console.log('\n════ ' + name.toUpperCase() + ' — ' + cfg.note);

      let lastPage = null;

      for (const vp of widths) {
        const label = name.toUpperCase() + ' · ' + vp.key + ' ' + vp.w + 'px';
        const checks = [];
        const t = (n, ok, note) => checks.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });

        let page = null, failure = null, before = null;
        try {
          page = await openPage(cfg.seed, vp);
          /* Which row is the env=test one? The dashboard hides those from
             the production view until "Show test rows" is ticked, and the
             checkbox re-renders in place. Chrome restores a checkbox
             across a same-document navigation, so the OFF state is set
             explicitly rather than assumed. */
          const tick = on => `(function(){
            var c = document.getElementById('showTestRows');
            if (!c) return 'missing';
            if (c.checked !== ${on}) { c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); }
            return 'ok';
          })()`;
          if (await cdp.evaluate(tick(false)) !== 'ok') throw new Error('no "Show test rows" checkbox in the toolbar');
          try { page = await settle(1, 8000); } catch (e) { /* the checks below report it */ }
          const testRow = page.fixture.find(r => expected(r).kind === 'hidden:env');
          before = testRow ? page.rendered.some(r => r.id === testRow.id) : false;

          await cdp.evaluate(tick(true));
          try { page = await settle(page.fixture.length, 8000); } catch (e) { /* the presence check reports it */ }
        } catch (e) {
          failure = e.message;
        }
        if (page) lastPage = page;

        if (!failure) {
          if (before !== null) {
            const testRow = page.fixture.find(r => expected(r).kind === 'hidden:env');
            if (testRow) {
              t('a test-env row stays out of the production view until "Show test rows" is on',
                before === false, 'the test row was on screen before the toggle was ticked');
            }
          }
          const scan = JSON.parse(await cdp.evaluate(scanner('.section-view[data-section="listings"]')));

          t('nothing overflows: ' + Object.values(LAYOUT_RULES).join(', ') + ' — and no page-wide sideways scroll',
            scan.offenders.length === 0 && !page.horizontal,
            (page.horizontal ? 'the page scrolls sideways (' + page.docScrollW + ' > ' + page.docClientW + '); ' : '') +
            JSON.stringify(scan.offenders.slice(0, 6)));
          t('the table is at most ' + MAX_EXTRA_PX + ' px wider than its pane at ' + vp.w +
            ' (' + page.bodyPx + ' px in ' + page.panePx + ')',
            !page.tableOn || page.bodyPx <= page.panePx + MAX_EXTRA_PX,
            'the listing table is ' + page.bodyPx + ' px wide — the round-4 regression was 2,343 in a 991 px pane');
          t('nothing rendered as NaN / undefined / [object Object]', !page.badText, 'a bad value reached the table');
          t('the rows rendered', (vp.w > 860 ? page.rendered.length : page.cardCount) > 0,
            'table rows ' + page.rendered.length + ', cards ' + page.cardCount);
          t('every row carries a board verdict with a reason',
            page.rendered.length > 0 && page.rendered.every(r => r.state === 'live' || r.state === 'hidden'),
            JSON.stringify(page.rendered.filter(r => !r.state).slice(0, 4)));
          t('every verdict explains itself',
            page.rendered.every(r => r.title && r.title.length > 8),
            JSON.stringify(page.rendered.filter(r => !r.title || r.title.length <= 8).slice(0, 4)));
          t('the Fixtures toggle is present and marks the seed it booted with',
            page.toggle && page.toggleMarked === cfg.seed,
            'toggle ' + page.toggle + ', marked "' + page.toggleMarked + '", seed "' + page.seed + '"');

          /* the verdict is the one the row's own data earns */
          const byId = new Map(page.rendered.map(r => [r.id, r]));
          const missing = [], wrong = [];
          for (const row of page.fixture) {
            const want = expected(row);
            const got = byId.get(row.id);
            if (!got) { missing.push(row.id.slice(-4) + ' (' + want.kind + ')'); continue; }
            if (got.state !== (want.live ? 'live' : 'hidden')) {
              wrong.push(row.id.slice(-4) + ' claimed "' + got.state + '", earns "' + (want.live ? 'live' : 'hidden') + '"');
              continue;
            }
            if (!want.live && got.title.indexOf(want.reason) === -1) {
              wrong.push(row.id.slice(-4) + ' badged hidden without saying why: "' + got.title + '"');
            }
            if (want.live && got.title.indexOf('Students can see this') === -1) {
              wrong.push(row.id.slice(-4) + ' badged live without saying so: "' + got.title + '"');
            }
          }
          t('every fixture row is on screen', missing.length === 0, missing.join(', '));
          t('every verdict matches the row\'s own status / tier / env', wrong.length === 0, wrong.join(' ; '));

          /* the one-click Publish: offered exactly where it is safe */
          const wrongPublish = page.fixture.map(row => {
            const got = byId.get(row.id);
            if (!got) return null;
            const draft = String(row.status || '').toLowerCase() === 'draft';
            const want = !draft && !expected(row).live;
            if (got.publish === want) return null;
            return row.id.slice(-4) + (want ? ' hidden and not offered Publish' : ' offered Publish when it should not be');
          }).filter(Boolean);
          t('Publish is offered on every hidden non-draft row, and never on a draft',
            wrongPublish.length === 0, wrongPublish.join(', '));

        }

        const bad = checks.filter(c => !c.ok);
        total += checks.length || 1; failed += failure ? (checks.length + 1) : bad.length;

        console.log('\n' + label);
        if (failure) {
          console.log('  ✗ ' + failure);
        } else if (!bad.length) {
          console.log('  ✓ ' + checks.length + '/' + checks.length + ' checks passed  ·  table ' + page.bodyPx + 'px in a ' + page.panePx + 'px pane');
        } else {
          for (const c of bad) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
          console.log('  ' + (checks.length - bad.length) + '/' + checks.length + ' checks passed');
        }
      }

      /* ---- the fixture's own record ----
         The generated fixture publishes its plan (worstPlan), so the
         coverage question is answered from the page: does it emit every
         status × tier × env cell, and is every row's record true of the
         row it is written on? The old hand list quietly lost the tier-0
         case; a list can drift, a product cannot. */
      if (cfg.seed === 'worst') {
        const planChecks = [];
        const pt = (n, ok, note) => planChecks.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });
        let planFailure = null;
        try {
          const page = lastPage;
          if (!page) throw new Error('the page never settled, so the fixture could not describe itself');
          const plan = page.plan;
          if (!plan) throw new Error('the page has no fixture plan — window.ArzuzMockData.worstPlan is missing');

          const envKey = v => (v == null || v === '' ? 'NULL' : String(v).toLowerCase());
          const sameSet = (a, b) => {
            const A = new Set(a.map(String)), B = new Set(b.map(String));
            return A.size === B.size && [...A].every(x => B.has(x));
          };

          pt('the fixture declares the dashboard\'s own statuses (' + page.liveStatuses.join(', ') + ')',
            sameSet(plan.statuses, page.liveStatuses),
            'fixture: [' + plan.statuses.join(', ') + '] · dashboard: [' + page.liveStatuses.join(', ') + ']');
          pt('the fixture declares the dashboard\'s own tiers (' + page.liveTiers.join('/') + ')',
            sameSet(plan.tiers.map(String), page.liveTiers.map(String)),
            'fixture: [' + plan.tiers.join(', ') + '] · dashboard: [' + page.liveTiers.join(', ') + ']');
          pt('the fixture declares every env the board distinguishes (production · test · NULL)',
            sameSet(plan.envs.map(envKey), BOARD_ENVS.map(envKey)),
            'fixture: [' + plan.envs.map(envKey).join(', ') + ']');

          const keyOf = c => [String(c.status), Number(c.tier), envKey(c.env)].join('|');
          const want = new Set();
          plan.statuses.forEach(s => plan.tiers.forEach(t => plan.envs.forEach(e => {
            want.add([String(s), Number(t), envKey(e)].join('|'));
          })));
          const rowCells = page.fixture.filter(r => r.case && !r.case.stress).map(r => keyOf(r.case));
          const seen = new Set(), dupes = new Set();
          rowCells.forEach(c => { if (seen.has(c)) dupes.add(c); seen.add(c); });
          const missing = [...want].filter(c => !seen.has(c));
          const extra = [...seen].filter(c => !want.has(c));
          pt('every status × tier × env combination is emitted, exactly once (' + want.size + ' cells, ' +
             rowCells.length + ' matrix rows)',
            missing.length === 0 && dupes.size === 0 && extra.length === 0,
            (missing.length ? 'no row for: ' + missing.join(', ') + '. ' : '') +
            (dupes.size ? 'duplicated: ' + [...dupes].join(', ') + '. ' : '') +
            (extra.length ? 'not in the matrix: ' + extra.join(', ') : ''));

          const lying = [];
          for (const row of page.fixture) {
            const rec = row.case;
            if (!rec) { lying.push(row.id.slice(-4) + ': no case record'); continue; }
            if (String(rec.status) !== String(row.status)) {
              lying.push(row.id.slice(-4) + ': record says status ' + rec.status + ', row carries ' + row.status);
            } else if (Number(rec.tier) !== Number(row.tier)) {
              lying.push(row.id.slice(-4) + ': record says tier ' + rec.tier + ', row carries ' + row.tier);
            } else if (envKey(rec.env) !== envKey(row.env)) {
              lying.push(row.id.slice(-4) + ': record says env ' + envKey(rec.env) + ', row carries ' + envKey(row.env));
            } else {
              const earns = expected(row).kind;
              if (rec.exercise !== earns) {
                lying.push(row.id.slice(-4) + ': record says it exercises "' + rec.exercise + '", its data earns "' + earns + '"');
              }
            }
          }
          pt('every row carries a case record, and no record lies about its own row (' + page.fixture.length + ' rows)',
            lying.length === 0, lying.slice(0, 6).join('; '));

          const exercised = new Set(page.fixture.map(r => expected(r).kind));
          pt('rows exercise every branch of the board (' + BRANCHES.join(' · ') + ')',
            BRANCHES.every(b => exercised.has(b)) && sameSet(plan.branches, BRANCHES),
            'no row exercises: ' + BRANCHES.filter(b => !exercised.has(b)).join(', ') +
            (sameSet(plan.branches, BRANCHES) ? '' : ' · the fixture declares ' + JSON.stringify(plan.branches)));

          const stressed = page.fixture.filter(r => r.case && r.case.stress);
          pt('the payload extremes are recorded too (' + (plan.stress || []).map(s => s.name).join(', ') + ')',
            stressed.length === (plan.stress || []).length &&
            (plan.stress || []).every(s => stressed.some(r => r.case.stress === s.name && r.case.exercise === s.exercise)),
            'declared: ' + (plan.stress || []).map(s => s.name).join(', ') + ' · on screen: ' + stressed.map(r => r.case.stress).join(', '));
        } catch (e) {
          planFailure = e.message;
        }

        const pbad = planChecks.filter(c => !c.ok);
        total += planChecks.length || 1;
        failed += planFailure ? (planChecks.length + 1) : pbad.length;
        console.log('\n' + name.toUpperCase() + ' · fixture plan');
        if (planFailure) {
          console.log('  ✗ ' + planFailure);
        } else if (!pbad.length) {
          console.log('  ✓ ' + planChecks.length + '/' + planChecks.length + ' checks passed');
        } else {
          for (const c of pbad) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
          console.log('  ' + (planChecks.length - pbad.length) + '/' + planChecks.length + ' checks passed');
        }
      }

      /* ---- the composer, at the width that used to clip it ---- */
      const mchecks = [];
      const mt = (n, ok, note) => mchecks.push({ name: n, ok: !!ok, note: ok ? '' : (note || '') });
      let mfailure = null;
      let note = null;
      try {
        await openPage(cfg.seed, { w: COMPOSER.w, h: COMPOSER.h });
        const opened = await cdp.evaluate(`(function(){
          var b = document.getElementById('btnOpenAddApt');
          if (!b) return 'no Add apartment button on this route';
          b.click();
          var m = document.getElementById('addAptModal');
          if (!m) return 'no addAptModal in the page';
          if (m.offsetHeight === 0) return 'the modal did not open';
          return 'opened';
        })()`);
        if (opened !== 'opened') throw new Error(opened);

        note = await cdp.evaluate(`(function(){
          var el = document.getElementById('addBoardNote');
          return el ? JSON.stringify({ text: String(el.textContent || '').trim(), cls: String(el.className || '') }) : 'null';
        })()`);
        const first = note === 'null' ? null : JSON.parse(note);

        mt('the composer says what the save will do, before it happens',
          first && first.text.length > 20, String(note));
        mt('at ACTIVE + tier 2 the note says it is on the board',
          first && first.text.indexOf('Students can see this on the browse page now.') === 0,
          first ? first.text : '');

        /* drive the real selects, not the note directly */
        const drove = await cdp.evaluate(`(function(){
          function set(id, v){ var el = document.getElementById(id); if (!el) return 'missing ' + id; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; }
          var out = {};
          out.tier = set('add_tier', '0');
          out.noteTier = String((document.getElementById('addBoardNote') || {}).textContent || '').trim();
          out.tierBack = set('add_tier', '2');
          out.status = set('add_status', 'pending');
          out.noteStatus = String((document.getElementById('addBoardNote') || {}).textContent || '').trim();
          out.statusBack = set('add_status', 'active');
          out.noteBack = String((document.getElementById('addBoardNote') || {}).textContent || '').trim();
          return JSON.stringify(out);
        })()`);
        const d = JSON.parse(drove);

        mt('the note follows the tier: tier 0 names the tier',
          d.noteTier.indexOf('Not on the browse page yet — it is tier 0') === 0, d.noteTier);
        mt('the note follows the status: pending names the status',
          d.noteStatus.indexOf('Not on the browse page yet — its status is pending') === 0, d.noteStatus);
        mt('the note follows back: ACTIVE + tier 2 is live again',
          d.noteBack.indexOf('Students can see this on the browse page now.') === 0, d.noteBack);
        mt('the reason is never empty',
          !/—\s*\./.test(d.noteTier + ' ' + d.noteStatus) &&
          d.noteTier.indexOf('. It goes live when') !== -1 &&
          d.noteStatus.indexOf('. It goes live when') !== -1,
          'a reason clause came out blank or unpunctuated');

        const mscan = JSON.parse(await cdp.evaluate(scanner('#addAptModal .modal-box')));
        const mpage = JSON.parse(await cdp.evaluate(READY));
        mt('the composer fits ' + COMPOSER.w + 'px: nothing clipped, no sideways scroll',
          mscan.offenders.length === 0 && !mpage.horizontal,
          JSON.stringify(mscan.offenders.slice(0, 6)) + (mpage.horizontal ? ' (the page scrolls sideways)' : ''));
      } catch (e) {
        mfailure = e.message;
      }

      const mbad = mchecks.filter(c => !c.ok);
      total += mchecks.length || 1; failed += mfailure ? (mchecks.length + 1) : mbad.length;
      console.log('\n' + name.toUpperCase() + ' · composer ' + COMPOSER.w + 'px');
      if (mfailure) {
        console.log('  ✗ ' + mfailure);
      } else if (!mbad.length) {
        console.log('  ✓ ' + mchecks.length + '/' + mchecks.length + ' checks passed');
      } else {
        for (const c of mbad) console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
        console.log('  ' + (mchecks.length - mbad.length) + '/' + mchecks.length + ' checks passed');
      }

      if (keepBody) {
        const body = await cdp.evaluate('document.documentElement.outerHTML');
        const p = join(tmpdir(), 'arzuz-admin-' + name + '.html');
        await writeFile(p, body, 'utf8');
        console.log('  page → ' + p);
      }
    }

    if (pageErrors.length) {
      console.log('\nconsole output from the page (not asserted — tiles and fonts need a network):');
      for (const e of [...new Set(pageErrors)].slice(0, 6)) console.log('  · ' + e);
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
