#!/usr/bin/env node
/* ============================================================
   Arzuz — whole-site coordination audit

   test-home-motion.mjs proves the landing page in depth. This
   proves the OTHER pages are all still working together, which is
   a different question: a shared file changes (motion.js, arzuz.css,
   the nav) and thirteen pages nobody looked at go with it.

   Every *.html in the repo is loaded in real headless Chrome at
   desktop and mobile, and each one has to:

     · answer 200 and carry a title + meta description
     · boot the shared motion layer (html.motion-ready), on the pages
       that load motion.js
     · land EVERY reveal — vertical sweep and horizontal strips both,
       because a card that only reveals when its strip is scrolled is
       invisible in the meantime
     · not scroll sideways
     · load every stylesheet, script, image, font and icon it names
     · link only to destinations that exist: a real file, or the
       Netlify Function that netlify.toml actually routes it to

   The link and asset checks are the coordination part. A page that
   points at /care after care.html is renamed, or at /api/notify
   before the function is added, is broken for a visitor and nothing
   else in this repo would notice.

   Run from arzuz-site/:
     node scripts/test-site-audit.mjs
     node scripts/test-site-audit.mjs --width=mobile
     node scripts/test-site-audit.mjs --pages=index.html,browse.html
     node scripts/test-site-audit.mjs --base=http://localhost:8123

   Zero dependencies: Node's global WebSocket drives the Chrome,
   Edge or Chromium already on the machine over the DevTools
   protocol, and scripts/dev-server.mjs is started when nothing is
   listening.
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const pagesArg = argVal('pages');
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

/* minimal CDP client over one page target — same shape as
   scripts/test-home-motion.mjs and scripts/test-listing-render.mjs */
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
   Measures what the browser actually did, on the real page. No stubs:
   every URL it reports is resolved from the live DOM, so links added
   by JavaScript are covered too. */
const PROBE = `(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};

  /* Loaded first. Page.navigate resolves before the document is parsed, so
     on a busy machine a probe can read a half-built DOM: no title tag, no
     meta description, elements a section away not parsed yet. That is a
     test fidelity bug wearing a page bug's clothes (it is exactly how the
     homepage suite once reported "0 of 0" bars on a page that has them),
     and it is a bounded wait, so a resource that never arrives cannot park
     the run. */
  await new Promise(function (done) {
    if (document.readyState === 'complete') return done();
    var t = setTimeout(done, 8000);
    window.addEventListener('load', function () { clearTimeout(t); done(); }, { once: true });
  });

  /* The root element is read AFTER the wait, never before it. A probe that
     captures document.documentElement up front can hold a null it never
     revisits: the document it was injected into can be replaced while the
     wait runs, and the first use of it — the motion flag — then throws an
     anonymous TypeError that looks like a page bug. A document with no root
     is a departing one, so it is reported as itself ("torn") and the audit
     can tell the harness apart from the page it was meant to measure. */
  var H = document.documentElement;
  for (var g = 0; g < 40 && !H; g++) { await sleep(25); H = document.documentElement; }
  if (!H) return JSON.stringify({ torn: true });

  out.motionReady = H.classList.contains('motion-ready');
  out.title = (document.title || '').trim();
  var md = document.querySelector('meta[name="description"]');
  out.description = md ? (md.getAttribute('content') || '').trim() : '';
  out.hasMotionScript = !!document.querySelector('script[src*="motion.js"]');
  out.path = location.pathname + location.search;

  /* ---------- walk the page so every reveal gets its chance ----------
     Same discipline as the landing-page test, for the same measured
     reason: the height is still settling on a cold first paint (webfonts
     swap, late images take their space), the page scrolls smoothly by
     design so a programmatic jump never lands where it was asked to, and
     a sweep that stopped short must report itself as a sweep that stopped
     short rather than as thirteen pages of invisible content. */
  var prevBehaviour = H.style.scrollBehavior;
  H.style.scrollBehavior = 'auto';
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  var settled = H.scrollHeight;
  for (var s = 0; s < 8; s++) {
    await sleep(120);
    if (H.scrollHeight === settled) break;
    settled = H.scrollHeight;
  }
  var liveMax = function () { return Math.max(0, H.scrollHeight - window.innerHeight); };

  /* Coverage, not ceremony. An element reveals when it enters the viewport,
     so stepping by less than one viewport height guarantees every element is
     inside the viewport at some step — nothing can hide between two steps.
     That is the promise the fixed 30 steps made, at a cost that follows the
     page instead of the page following the constant: this loop is the
     audit's whole wall-clock, paid on ~30 page loads, and most of the fixed
     steps scrolled through positions no reveal had asked for. A page that
     grows while it is swept is caught by the pass loop below, which sweeps
     again anyway. */
  var sweepSteps = 0;
  var sweepVertical = async function () {
    var view = Math.max(200, window.innerHeight);
    var max = liveMax();
    var steps = max === 0 ? 1 : Math.min(30, Math.max(6, Math.ceil(max / (view * 0.8))));
    sweepSteps = steps;
    for (var i = 0; i <= steps; i++) {
      window.scrollTo(0, Math.round(liveMax() * i / steps));
      await sleep(70);
    }
    window.scrollTo(0, liveMax());
    await sleep(500);
  };

  /* ---------- the other axis ----------
     A card parked inside a horizontally scrolling strip is off the root
     rect, so it is never "intersecting" and never reveals until someone
     scrolls that strip. Scroll every strip that holds a reveal target to
     its end and back, so the audit is asking about the page a visitor can
     actually reach — a strip with nothing to reveal has nothing to prove. */
  var sweepStrips = async function () {
    var strips = [];
    var targets = [].slice.call(document.querySelectorAll('.rv, [data-rise]'));
    [].slice.call(document.querySelectorAll('body *')).forEach(function (el) {
      if (!(el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 4)) return;
      /* Scrolling a strip exists to bring its own children into view, so a
         strip with no reveal target inside it has nothing to reveal and is
         skipped — same assertion, fewer scrolls, on every pass of every page. */
      if (!targets.some(function (t) { return el.contains(t); })) return;
      strips.push(el);
    });
    for (var k = 0; k < strips.length; k++) {
      strips[k].scrollLeft = strips[k].scrollWidth;
      await sleep(140);
      strips[k].scrollLeft = 0;
    }
    await sleep(400);
    return strips.length;
  };

  /* ---------- reveals ----------
     The assertion is the symptom a visitor sees: an element that is meant
     to be revealed and is still invisible (or still mid-entrance) after
     both sweeps. An element with no box at all — display:none, a closed
     panel, a hidden tab — is not expected to have revealed, so it is
     counted separately rather than blamed. */
  /* Is this transform still displaced, or is it the resting frame?
     String comparison against "matrix(1, 0, 0, 1, 0, 0)" is not enough: an
     entrance that ends on a 3D transform computes to a matrix3d whose
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

  var measureReveals = function () {
    var targets = [].slice.call(document.querySelectorAll('.rv, [data-rise]'));
    var hidden = 0, boxless = 0, stuck = [];
    targets.forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || el.getClientRects().length === 0) { boxless++; return; }
      var op = parseFloat(cs.opacity);
      var tf = cs.transform;
      if (!(op > 0.99) || !nearIdentity(tf)) {
        hidden++;
        if (stuck.length < 6) stuck.push({
          el: (el.tagName + '.' + String(el.className)).slice(0, 70),
          inClass: el.classList.contains('in'), opacity: cs.opacity, transform: tf
        });
      }
    });
    return { total: targets.length, hidden: hidden, boxless: boxless, stuck: stuck };
  };

  /* Up to three sweeps, and the LAST one is what gets judged.
     A page can put its content on screen after a fetch resolves — a list, an
     empty state, a map — and an element inserted while the page sits at the
     top has not been scrolled through yet, so "not revealed" is then a fact
     about when the probe looked, not about the page. A visitor who scrolls
     again sees it, so the audit sweeps again; a reveal that is genuinely
     stuck is stuck through all three and still fails, and the count of
     passes is reported so a page that needed a second one is visible. */
  var passes = 0, revealed = null;
  while (passes < 3) {
    passes++;
    await sweepVertical();
    /* The bottom can still move while we are parked on it: a lazy image
       loads as the sweep arrives and grows the page by its own height, and
       a single landing then sits short of the bottom it just created. That
       is a broken precondition, not a broken page, so land again until the
       height stops moving — bounded, so a page that never stops growing is
       still reported rather than chased — and only then record where the
       sweep parked. */
    for (var reland = 0; reland < 8; reland++) {
      var bottom = liveMax();
      window.scrollTo(0, bottom);
      await sleep(80);
      if (liveMax() === bottom && window.scrollY >= bottom - 4) break;
    }
    out.sweepLandedAt = Math.round(window.scrollY);
    out.sweepWanted = liveMax();
    out.heightStart = settled;
    out.heightEnd = H.scrollHeight;
    out.strips = await sweepStrips();
    out.sweepSteps = sweepSteps;
    window.scrollTo(0, 0);
    /* Wait for the page to settle, rather than for a flat 900ms: poll until
       every reveal has landed and return, capped at the constant this
       replaces — so a genuinely stuck one still runs out the clock and fails
       exactly as it did. The timeout is unchanged, so this can only be
       faster, and the count of passes is reported as before. */
    var cap = passes === 1 ? 900 : 500, t0 = Date.now();
    revealed = measureReveals();
    while (revealed.hidden > 0 && Date.now() - t0 < cap) {
      await sleep(50);
      revealed = measureReveals();
    }
    out.settleMs = Date.now() - t0;
    if (revealed.hidden === 0) break;
  }
  H.style.scrollBehavior = prevBehaviour;
  out.passes = passes;
  out.revealTotal = revealed.total;
  out.revealHidden = revealed.hidden;
  out.revealBoxless = revealed.boxless;
  out.revealStuck = revealed.stuck;

  /* ---------- layout ---------- */
  out.scrollWidth = H.scrollWidth;
  out.innerWidth = window.innerWidth;
  var wide = 0;
  [].slice.call(document.querySelectorAll('body *')).forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 1) wide++;
  });
  out.wideElements = wide;

  /* ---------- every URL the page names, from the live DOM ---------- */
  var abs = function (u) { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  out.links = [];
  [].slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
    var h = abs(a.getAttribute('href'));
    if (h) out.links.push(h);
  });
  out.assets = [];
  var push = function (u) {
    if (!u || !String(u).trim()) return;
    if (/^(data:|blob:|about:|javascript:|mailto:|tel:)/i.test(String(u))) return;
    var h = abs(u);
    if (h) out.assets.push(h);
  };
  [].slice.call(document.querySelectorAll('link[href]')).forEach(function (el) { push(el.getAttribute('href')); });
  [].slice.call(document.querySelectorAll('script[src]')).forEach(function (el) { push(el.getAttribute('src')); });
  [].slice.call(document.querySelectorAll('img[src]')).forEach(function (el) { push(el.getAttribute('src')); });
  [].slice.call(document.querySelectorAll('source[src]')).forEach(function (el) { push(el.getAttribute('src')); });
  [].slice.call(document.querySelectorAll('video[poster]')).forEach(function (el) { push(el.getAttribute('poster')); });
  [].slice.call(document.querySelectorAll('iframe[src]')).forEach(function (el) { push(el.getAttribute('src')); });
  out.noindex = (function () {
    var m = document.querySelector('meta[name="robots"]');
    return !!(m && /noindex/i.test(m.getAttribute('content') || ''));
  })();

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

/* ---------------- routes ----------------
   What a link is allowed to point at. netlify.toml is the only source of
   truth for the clean URLs (/care → care.html) and for the routes that are
   served by a Function (/listing → listing-og). Reading it means the audit
   fails when a redirect is deleted, not just when a file moves. */

async function routeTable() {
  const toml = await readFile(join(SITE, 'netlify.toml'), 'utf8');
  const map = new Map();
  for (const block of toml.split('[[redirects]]').slice(1)) {
    const from = (block.match(/^\s*from\s*=\s*"([^"]+)"/m) || [])[1];
    const to = (block.match(/^\s*to\s*=\s*"([^"]+)"/m) || [])[1];
    const status = (block.match(/^\s*status\s*=\s*(\d+)/m) || [])[1];
    if (from && to) map.set(from, { to, status: Number(status || 200) });
  }
  return map;
}

/* Pages the deploy config keeps out of the index: netlify.toml sets
   X-Robots-Tag: noindex on them, and a private page is allowed to skip the
   meta tags a public one needs. */
async function noindexPaths() {
  const toml = await readFile(join(SITE, 'netlify.toml'), 'utf8');
  const out = new Set();
  for (const block of toml.split('[[headers]]').slice(1)) {
    const forPath = (block.match(/^\s*for\s*=\s*"([^"]+)"/m) || [])[1];
    if (forPath && /X-Robots-Tag\s*=\s*"[^"]*noindex/i.test(block)) out.add(forPath.replace(/^\//, ''));
  }
  return out;
}

const insideSite = p => {
  const full = resolve(SITE, p);
  return full === SITE || full.startsWith(SITE + sep) ? full : null;
};

/* Resolve one pathname to a real destination, or say why there isn't one. */
function resolveRoute(pathname, table, hop) {
  const p = pathname || '/';
  const hit = table.get(p);
  if (hit) {
    /* A 301 is a destination, not a broken link — it is how a duplicate
       address is retired, and the site retired .html copies of every page
       plus the legacy /owner-list and /scout paths. Follow it (bounded) to
       the address it lands on and judge THAT: a link to /register.html is
       fine because it ends at /register, and it is a failure only if the
       landing address has nothing behind it. */
    if ((hit.status === 301 || hit.status === 302) && (hop || 0) < 3) {
      const landed = resolveRoute(hit.to, table, (hop || 0) + 1);
      return landed.ok
        ? { ok: true, kind: 'redirect', file: landed.file, via: p + ' → ' + hit.to }
        : { ok: false, why: 'netlify.toml redirects ' + p + ' → ' + hit.to + ', and ' + landed.why };
    }
    if (hit.to.startsWith('/.netlify/functions/')) {
      const name = hit.to.slice('/.netlify/functions/'.length);
      const file = 'netlify/functions/' + name + '.js';
      return existsSync(join(SITE, file))
        ? { ok: true, kind: 'function', file }
        : { ok: false, why: 'netlify.toml routes ' + p + ' → ' + hit.to + ' but ' + file + ' does not exist' };
    }
    const rel = hit.to.replace(/^\//, '');
    const file = insideSite(rel);
    return file && existsSync(file)
      ? { ok: true, kind: 'redirect', file: rel }
      : { ok: false, why: 'netlify.toml routes ' + p + ' → ' + hit.to + ' but that file does not exist' };
  }

  if (p === '/' || p === '') return existsSync(join(SITE, 'index.html')) ? { ok: true, kind: 'file', file: 'index.html' } : { ok: false, why: 'no index.html' };

  const candidates = [];
  if (p.endsWith('.html')) candidates.push(p.replace(/^\//, ''));
  else { candidates.push(p.replace(/^\//, '') + '.html'); candidates.push(join(p.replace(/^\//, ''), 'index.html')); }
  for (const rel of candidates) {
    const file = insideSite(rel);
    if (file && existsSync(file)) return { ok: true, kind: 'file', file: rel };
  }
  return { ok: false, why: 'no file and no netlify.toml route for ' + p };
}

/* ---------------- expectations ---------------- */

function checks(page, vp) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
  const v = page.page;

  t('the page answers 200 with an HTML document',
    page.status === 200 && /text\/html/.test(page.contentType || ''),
    'HTTP ' + page.status + ' · ' + page.contentType +
      /* HTTP 0 is a request that never got a response — naming the transport
         error turns "the server is down", "the request timed out" and
         "something reset the connection mid-run" into different failures */
      (page.statusError ? ' — ' + page.statusError : ''));

  t('the page has a title', v.title.length > 0, 'title is empty');

  /* A meta description is what a search result shows, so it is required of
     every page a visitor can land on from a search — and pointless on the
     pages this site deliberately keeps out of the index (admin.html carries
     noindex from netlify.toml, complete-listing.html from its own meta tag).
     Requiring one there would be asserting a tag nobody wants. */
  if (!page.noindex) {
    t('the page has a meta description',
      v.description.length > 0,
      'no meta[name="description"] — a search result would show nothing');
  }

  if (v.hasMotionScript) {
    t('the motion layer booted (html.motion-ready)', v.motionReady === true,
      'assets/motion.js did not run — every reveal on this page would be gated off');
  }

  /* the sweep's own precondition — a short sweep is a broken test, not a
     broken page, and must never be reported as one */
  t('the sweep reached the bottom of the page',
    typeof v.sweepLandedAt === 'number' && typeof v.sweepWanted === 'number' && v.sweepLandedAt >= v.sweepWanted - 4,
    'sweep parked at ' + v.sweepLandedAt + ' but the bottom is at ' + v.sweepWanted +
    ' (height ' + v.heightStart + ' → ' + v.heightEnd + ')');

  t('all ' + v.revealTotal + ' reveals landed (' + v.passes + ' sweep' + (v.passes === 1 ? '' : 's') +
    ' + ' + v.strips + ' strip' + (v.strips === 1 ? '' : 's') + ' scrolled)',
    v.revealHidden === 0,
    v.revealHidden + ' of ' + v.revealTotal + ' still invisible or mid-entrance after ' + v.passes +
    ' sweep' + (v.passes === 1 ? '' : 's') + ': ' + JSON.stringify(v.revealStuck));

  t('nothing scrolls sideways',
    v.scrollWidth <= v.innerWidth + 1,
    'scrollWidth ' + v.scrollWidth + ' vs viewport ' + v.innerWidth + ' (' + v.wideElements + ' elements past the right edge)');  const badAssets = page.assets.filter(a => !a.ok);
  t('every local asset it names loads (' + page.assets.length + ' checked)',
    badAssets.length === 0,
    badAssets.map(a => a.path + ' → ' + (a.error || 'HTTP ' + a.status)).join(', '));

  const badLinks = page.links.filter(l => !l.ok);
  t('every internal link it points at exists',
    badLinks.length === 0,
    badLinks.map(l => l.href + ' (' + l.why + ')').join(', '));

  t('no uncaught error while loading and scrolling', page.exceptions.length === 0,
    page.exceptions.join(' | '));

  return out;
}

/* ---------------- main ---------------- */

(async function main() {
  const base = baseArg || 'http://localhost:8123';
  const allPages = (await readdir(SITE)).filter(f => f.endsWith('.html')).sort();
  const pages = pagesArg ? pagesArg.split(',').map(s => s.trim()).filter(Boolean) : allPages;
  const unknown = pages.filter(p => !allPages.includes(p));
  if (unknown.length) throw new Error('--pages names pages that do not exist: ' + unknown.join(', '));

  if (urlsOnly) {
    console.log('Open these pages in a browser:\n');
    pages.forEach(p => console.log('  ' + base + '/' + p));
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

  const table = await routeTable();
  const noindex = await noindexPaths();
  const { child: serverChild } = await ensureServer(base);
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-audit-'));

  console.log('Arzuz — whole-site coordination audit');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base + (serverChild ? '  (started by this test)' : '  (already running)'));
  console.log('pages   ' + pages.length + ' — ' + pages.join(', '));
  console.log('widths  ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', '));

  /* One cache of URL → result for the whole run: thirteen pages share a
     stylesheet, a motion layer and a nav, and there is no reason to fetch
     the same file thirty times. */
  const urlCache = new Map();
  /* Every request is bounded. fetch()'s own header timeout is five minutes,
     so a server that accepts a connection and then says nothing would park
     the whole gate in silence with no failing check to show for it. A check
     that cannot answer is reported as a failure, which is what it is — the
     page or asset did not load.

     The bound is 60s and a silent attempt is tried once more, because this
     suite does not run alone: the gate runs it beside the SQL proofs, and on
     a box where those are eating every core a local file has been measured
     taking longer than the 15s that used to be the verdict here. An
     unbounded retry would defeat the point, so 60s twice is still a hard
     stop: a server that truly will not answer is reported as a failure
     rather than waited on. */
  const PROBE_TIMEOUT = 60000;
  const PROBE_TRIES = 2;
  const probeUrl = async url => {
    if (urlCache.has(url)) return urlCache.get(url);
    let r;
    for (let attempt = 1; attempt <= PROBE_TRIES; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT);
      try {
        const res = await fetch(url, { method: 'GET', signal: abort.signal });
        r = { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '' };
      } catch (e) {
        r = { ok: false, status: 0, type: '', error: e.name === 'AbortError'
          ? 'no response within ' + (PROBE_TIMEOUT / 1000) + 's'
          : e.message };
      } finally {
        clearTimeout(timer);
      }
      /* An HTTP answer of any kind is this file's verdict; only silence or a
         transport error is worth a second attempt. */
      if (r.status) break;
    }
    if (!r.status) r.error += r.error ? ' (tried ' + PROBE_TRIES + ' times)' : '';
    urlCache.set(url, r);
    return r;
  };

  const seenLinks = new Map();   // href → resolution, so one verdict per route
  const seenAssets = new Map();

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

    /* the stylesheets are only reachable through the pages, but their
       url() references — five local webfonts — are not in any DOM, so
       they are read off disk once. Only real asset files count: an SVG
       fragment (url(%23noiseFilter)) and a data: URI are not requests. */
    const fontRefs = new Set();
    const ASSET_EXT = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)(\?|#|$)/i;
    for (const css of (await readdir(join(SITE, 'assets'))).filter(f => f.endsWith('.css'))) {
      const src = await readFile(join(SITE, 'assets', css), 'utf8');
      for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const u = m[1].trim();
        if (/^(data:|https?:|\/\/|#|%23)/.test(u) || !ASSET_EXT.test(u)) continue;
        fontRefs.add(JSON.stringify({ css, url: u }));
      }
    }

    for (const name of pages) {
      for (const vp of widths) {
        const url = base + '/' + name;
        const status = await probeUrl(url);

        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
        });

        const exceptions = [], consoleErrors = [];
        const spy = msg => {
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            exceptions.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
          }
          if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
          }
        };
        cdp.listeners.push(spy);

        let page = null, failure = null;
        for (let attempt = 1; attempt <= 2 && !page; attempt++) {
          try {
            /* Wait for the frame's own commit event, not for the page to say
               where it is. Page.navigate resolves before the new document
               has replaced the old one, and the SECOND viewport of every
               page navigates to the URL the browser is already on — so any
               "have we arrived?" test answered from the page is answered by
               the old, departing document, and a probe that starts there
               reads a torn-down one (measured: a crash in the probe's own
               first line, on mobile passes only). Page.frameNavigated can
               only arrive for a document the browser actually created. The
               wait is bounded, so a navigation that never commits cannot
               park the run. */
            let committed = false;
            const onCommit = msg => {
              if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) committed = true;
            };
            cdp.listeners.push(onCommit);
            try {
              const nav = await cdp.send('Page.navigate', { url });
              const navBy = Date.now() + 5000;
              while (!nav.errorText && !committed && Date.now() < navBy) {
                await new Promise(r => setTimeout(r, 25));
              }
            } finally {
              cdp.listeners = cdp.listeners.filter(f => f !== onCommit);
            }
            const raw = await cdp.evaluate(PROBE);
            const parsed = JSON.parse(raw);
            /* A page that was never actually loaded must not be judged: the
               probe reports a document with no root element positively
               instead of crashing, and the navigation is redone once. */
            if (parsed.torn) {
              failure = 'the probe read a document with no root element (a harness race, not a page bug)';
              continue;
            }
            page = parsed;
            failure = null;
          } catch (e) {
            failure = e.message;
            break;
          }
        }
        cdp.listeners = cdp.listeners.filter(f => f !== spy);

        const label = name + ' · ' + vp.key + ' ' + vp.w + 'px';
        if (failure || !page) {
          total++;
          failed++;
          console.log('\n' + label + '\n  ✗ ' + (failure || 'the page never reported back'));
          continue;
        }

        /* the URLs the page named, judged once each for the whole run */
        const assets = [];
        for (const abs of new Set(page.assets)) {
          if (!abs.startsWith(base)) continue;          // third-party: not ours to check
          const path = abs.slice(base.length);
          const r = await probeUrl(abs);
          assets.push({ path, ok: r.ok, status: r.status, error: r.error });
        }
        const links = [];
        for (const abs of new Set(page.links)) {
          if (!abs.startsWith(base)) continue;          // external links are the network's problem
          let path;
          try { path = new URL(abs).pathname; } catch { continue; }
          if (!seenLinks.has(path)) seenLinks.set(path, resolveRoute(decodeURIComponent(path), table));
          const r = seenLinks.get(path);
          links.push({ href: path, ok: r.ok, why: r.why });
        }

        const all = checks({
          page, status: status.status, contentType: status.type, statusError: status.error || '',
          assets, links, exceptions,
          noindex: !!page.noindex || noindex.has(name)
        }, vp)
          .concat([{
            /* reported, never asserted: a page that cannot reach Supabase on a
               laptop has nothing to say about whether the page is correct */
            name: 'console errors (reported, not asserted)',
            ok: true,
            note: consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : ''
          }]);
        const bad = all.filter(x => !x.ok);
        total += all.length;
        failed += bad.length;

        console.log('\n' + label);
        if (consoleErrors.length) {
          console.log('  · console errors: ' + consoleErrors.slice(0, 3).map(s => s.slice(0, 140)).join(' | '));
        }
        if (!bad.length) {
          console.log('  ✓ ' + all.length + '/' + all.length + ' checks passed' +
            (page.settleMs != null ? '  (settled in ' + page.settleMs + 'ms)' : ''));
        } else {
          for (const x of bad) console.log('  ✗ ' + x.name + (x.note ? '\n      → ' + x.note : ''));
          console.log('  ' + (all.length - bad.length) + '/' + all.length + ' checks passed');
        }
      }
    }

    /* ---- the fonts nothing on a page names directly ---- */
    console.log('\nSHARED STYLESHEET ASSETS');
    total++;
    const missingFonts = [];
    for (const ref of fontRefs) {
      const { css, url: rel } = JSON.parse(ref);
      const abs = new URL(rel, base + '/assets/' + css).href;
      const r = await probeUrl(abs);
      if (!r.ok) missingFonts.push('assets/' + css + ' → ' + rel + ' → HTTP ' + r.status);
    }
    if (missingFonts.length) { failed++; console.log('  ✗ ' + missingFonts.join(', ')); }
    else console.log('  ✓ all ' + fontRefs.size + ' url() references in assets/*.css resolve');

    /* ---- the site-wide link verdict, once ---- */
    console.log('\nROUTES LINKED FROM ANY PAGE (' + seenLinks.size + ' distinct)');
    const broken = [...seenLinks.entries()].filter(([, r]) => !r.ok);
    if (broken.length) {
      broken.forEach(([p, r]) => console.log('  ✗ ' + p + ' — ' + r.why));
    } else {
      const byKind = {};
      for (const [, r] of seenLinks) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      console.log('  ✓ every one resolves — ' + Object.entries(byKind).map(([k, n]) => n + ' ' + k).join(', '));
    }
  } finally {
    if (cdp) await cdp.close();
    if (chromeChild) chromeChild.kill();
    if (serverChild) serverChild.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + total + ' · PASS ' + (total - failed) + ' · FAIL ' + failed);

  /* The verdict is final on that line, so leave on purpose. A headless
     Chrome hands the stdout/stderr pipes it was launched with to its own
     child processes, and a Chrome that outlived the kill below can hold this
     process's event loop open after the last line is printed. A suite that
     never returns is worse than one that fails: it parks the push gate in
     silence with nothing to read. The short delay lets the lines above drain
     to a file or a pipe first. */
  setTimeout(() => process.exit(failed ? 1 : 0), 250);
})();
