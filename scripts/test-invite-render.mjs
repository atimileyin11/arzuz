#!/usr/bin/env node
/* ============================================================
   Arzuz — landlord invite form render test

   WHY THIS EXISTS

     The listing page has had `test-listing-render.mjs` for a while:
     seven real pages are loaded in headless Chrome and judged on what
     they rendered. The invite form — complete-listing.html, the page a
     landlord actually fills in from a WhatsApp link — had nothing.
     Its seven seeds lived in dev/invite-fixture.js, were checked as
     data by test-fixture-plans.mjs, and were otherwise only ever
     *looked at by eye* through dev/complete-listing-harness.html. A
     seed can be perfect data and still reach the form wrong: the
     62-character name can land in a box that clips it, the 0-units
     row can come back as "Units available", the 12 amenities can
     render as 12 chips because the de-duplication rule stopped
     running. None of that is visible in the fixture, and all of it
     is visible in the DOM.

   WHAT IT DOES

     Loads the REAL complete-listing.html in headless Chrome — through
     dev/complete-listing-harness.html, which stubs Supabase at the
     mock RPC boundary and then document.writes the real markup — once
     per seed, at 1440, 390 AND 320 px, and asserts on the form that
     came out: every field's value, the availability trap, the amenity
     chips, the capped media grid, the read-only link, and the layout
     (nothing overflows at any width).

     320 is not decoration. It is the width budget phones actually
     report, and the narrow pass measures the three things a squeezed
     screen breaks first — the availability note, the capped grid
     behind tab 3, and the action bar — with the media panel OPEN,
     which the width-agnostic pass structurally cannot see (the grid
     lives in a hidden panel until tab 3 is clicked).

   WHERE THE EXPECTATIONS COME FROM

     Not from a hand-written table, and not from this file either. The
     page's documented rules are restated ONCE, in
     scripts/page-rules.mjs (INVITE) — shared with the listing page's
     suite so neither can drift alone — and they are applied to THE ROW
     THE MOCK SERVER ACTUALLY HELD when the page read it: read back
     over HTTP, not from the fixture file. So the suite says what the
     page was given, and then says what the page did with it.
     Two things keep it honest:

       · before each load the mock is seeded with a sentinel value,
         and the row is required to have moved off it — the seed this
         suite asked for is proven to be the seed the page got, so a
         harness that silently fell back to the demo row cannot pass;
       · the row is compared against the fixture's own seed for every
         key the fixture carries, so a harness that mangles a payload
         on the way in is reported as that, not as a page bug.

   THE ROUND TRIP (--no-round-trip turns it off)

     Rendering right is half of it. The worst seed is also SAVED, and
     the patch the page collected is read back off the mock: the 62-
     character name, ₦1.25m in both boxes, the 40 media items with
     their two share links, the three-line landmark, the pin — and the
     0-units row, which the page must store as `avail: occupied` /
     `Fully occupied` rather than as a vacancy nobody has (§20). That
     assertion is the reason a landlord's "0" cannot come back as an
     apartment advertised in the browse board.

   LOSING A SCRIPT ON PURPOSE (--fault-inject)

     The listing suite can lose a boot-critical script at the network layer and
     watch the harness put the page back together; this page could not, so a
     lost /assets/complete-listing.js was diagnosed as "the page never settled"
     — a page bug where there was a lost request. That is fixed at the source:
     dev/complete-listing-harness.html preflights every local script before it
     writes the document, dev/complete-listing-harness-boot.js reloads ONCE
     (with ?hreload=1) when the layer the boot needs is missing, and this mode
     reproduces the loss on purpose — one randomly chosen boot-critical script
     per load, failed at the network layer — so the recovery is exercised by a
     run instead of by a hand-edited harness.

     The candidates are derived, never copied: the harness's LAYER map
     intersected with the scripts complete-listing.html actually names. Lose
     one, and the harness must reload once and boot with everything back; a
     lost /assets/complete-listing.js stops the form dead, which is the loss
     this mode exists to prove recoverable. --fault-drops=2 kills the retry's
     copy as well, which MUST leave the run red — the control that proves a
     page which cannot be repaired is still reported as broken.

   Run from arzuz-site/:
     node scripts/test-invite-render.mjs
     node scripts/test-invite-render.mjs --seed=worst            one seed, full detail
     node scripts/test-invite-render.mjs --width=desktop         one width
     node scripts/test-invite-render.mjs --width=narrow          320px, and the narrow pass
     node scripts/test-invite-render.mjs --urls                  print the harness URLs
     node scripts/test-invite-render.mjs --base=http://localhost:8799
     node scripts/test-invite-render.mjs --dump                  save each load's probe (JSON, temp dir)
     node scripts/test-invite-render.mjs --no-round-trip         render only, never press Save
     node scripts/test-invite-render.mjs --fail-bodies          the eight recorded failures + no-row, instead of the seeds
     node scripts/test-invite-render.mjs --render-timeout=300    how long a load may take to settle
     node scripts/test-invite-render.mjs --fault-inject               lose one boot-critical script per load; the harness must recover
     node scripts/test-invite-render.mjs --fault-inject --fault-drops=2      kill the retry's copy too — the control, which must FAIL
     node scripts/test-invite-render.mjs --fault-inject --fault-rate=0.5     fault half the loads; the rest must boot clean
     node scripts/test-invite-render.mjs --fault-inject --fault-seed=42      the plan is random; this replays one exactly

   Zero dependencies. It drives the Chrome/Edge/Chromium already on the
   machine over the DevTools protocol (Node's global WebSocket) and
   starts dev/upload-mock-server.mjs itself when nothing is listening —
   that is the server that answers /mock/sb, the same one the harness is
   walked with by hand. Reusing an already-running one means this suite
   re-seeds it, exactly as reloading the harness in a browser would.
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {
  INVITE, WIDTHS, planChecks as fixturePlanChecks, scanSource, verifyPageRules
} from './page-rules.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The module the page itself decides with, loaded here so the suite can say
   what a recorded answer MEANS without restating it: one classifier answers
   in both runtimes (assets/draft-errors.js loads in a browser and via
   require()). test-draft-errors.mjs reads it the same way. */
const require = createRequire(import.meta.url);
const D = require('../assets/draft-errors.js');
/* The freshness/completeness score. This suite reads it so the panel it
   asserts on is held against the MODULE's own vocabulary rather than a
   list typed out here — the labels a landlord reads and the words the
   scorer uses have to be the same words. */
const Score = require('../assets/listing-score.js');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = k => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const onlySeed = argVal('seed');
const baseArg = argVal('base') || process.env.ARZUZ_TEST_BASE || null;
const widthArg = argVal('width');               /* desktop | mobile | narrow | both (default both) */
const urlsOnly = args.includes('--urls');
const keepBody = args.includes('--dump');
const roundTrip = !args.includes('--no-round-trip');
/* --fail-bodies walks the eight recorded platform failures (?fail=…) plus the
   empty answer, instead of the seeds: what each failure LOOKS LIKE to a
   landlord, and which class the page decided on. See the section below. */
const failBodies = args.includes('--fail-bodies');
const renderTimeoutMs = (argVal('render-timeout') ? Number(argVal('render-timeout')) : 120) * 1000;

/* Fault injection: a faulted load has one boot-critical script request dropped
   before the parser can run it, and the harness must get it back on its own
   single retry. See the fault-injection section below for what is dropped,
   how, and why the drop is aimed rather than sprayed. */
const faultInject = args.includes('--fault-inject');
/* requests of the SAME script that are failed: 1 is a loss the harness retry
   can undo, 2 also kills the retry's copy — the negative control. */
const faultDrops = argVal('fault-drops') ? Number(argVal('fault-drops')) : 1;
/* how many DIFFERENT scripts a faulted load loses at once. 1 is the single
   loss this mode is for; more is a compound loss. */
const faultVictims = argVal('fault-victims') !== null ? Number(argVal('fault-victims')) : 1;
/* the fraction of loads that are faulted at all, so one sweep can carry both
   paths: the faulted loads must recover, the rest must boot untouched. */
const faultRate = argVal('fault-rate') ? Number(argVal('fault-rate')) : 1;
/* The plan is drawn from a seed rather than Math.random, so a run that finds
   something can be run again exactly: the seed is printed, and passing it
   back reproduces every victim, on every load, in order. */
const faultSeed = argVal('fault-seed') ? Number(argVal('fault-seed')) : (Date.now() % 2147483647);

/* the widths are stated once, in scripts/page-rules.mjs, so this suite and
   the listing one sweep the same desktop and mobile — and so the 320px pass
   below is the same number the other suite would use if it grew one */
const NARROW = WIDTHS.narrow;

/* The server the harness needs. 8799 is the port dev/upload-mock-server.mjs
   documents and the one the harness is walked on by hand; a different one is
   a --base away. */
const DEFAULT_BASE = 'http://localhost:8799';

/* Seeded into the mock before every load, and required to be gone afterwards:
   see the header — a harness that fell back to the demo row would otherwise
   have this suite assert the demo row against itself, and pass. */
const SENTINEL = 'ARZUZ-SENTINEL-DO-NOT-RENDER';

/* ---------------- the fixture (Node, no DOM) ---------------- */

async function loadFixture() {
  const src = await readFile(join(SITE, 'dev/invite-fixture.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;ARZUZ_INVITE_FIXTURE', sandbox, { filename: 'dev/invite-fixture.js' });
  const fx = sandbox.ARZUZ_INVITE_FIXTURE;
  if (!fx || !fx.seeds) throw new Error('dev/invite-fixture.js did not expose ARZUZ_INVITE_FIXTURE.seeds');
  return fx;
}

/* ---------------- fault injection --------------

   The harness's whole reason to exist is one failure mode: a script request
   lost between the document being written and the parser running it. On this
   page a lost /assets/complete-listing.js is the worst of them — every other
   layer is behind a typeof guard, so only the page's own boot script stops the
   form dead — and it used to reach this suite as "the page never settled".
   This mode reproduces the loss on purpose, at the network layer, so the
   harness's repair (preflight + one reload) is exercised by a run.

   The candidates are derived, never copied: the harness's own LAYER map
   (dev/complete-listing-harness.html) intersected with the scripts
   complete-listing.html actually names. Add a script to the shared layer and
   it is instantly a fault candidate; drop one from the page and it leaves the
   list the same way. If the intersection is ever empty the mode refuses to
   run, because a recovery nobody could have needed is not a passed test.

   One family only, because this page has one shape of loss: a parser request.
   The harness's preflight is deliberately NOT a target — it runs before the
   document is written and has its own retries, and Chrome reports it as
   resourceType Fetch/XHR rather than Script, which is how the two are told
   apart. */

const fault = {
  armed: false,      /* true while a faulted load and its retry are in flight */
  victims: [],       /* the scripts THIS load is losing */
  budget: 1,         /* requests to fail per victim (--fault-drops) */
  sent: {},          /* victim → requests actually failed for it this load */
  landed: 0,         /* requests failed on this load */
  loads: 0,          /* loads this run has attempted */
  faulted: 0,        /* of those, how many were meant to lose something */
  losses: 0,         /* requests failed across the run */
  proved: 0          /* faulted loads the harness answered as it had to */
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

/* One line describing what this load lost, for the log and for a failure: a
   red run has to be readable as "the loss this mode expects to be fatal"
   rather than as a page that broke on its own. */
function faultLine(lost, sent) {
  if (!lost.length) return 'nothing';
  return 'the parser never got ' + lost.map(v => v + ' (' + (sent[v] || 0) + '/' + faultDrops + ')').join(', ');
}

function headerOf(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

async function bootCriticalScripts() {
  const harness = await readFile(join(SITE, 'dev/complete-listing-harness.html'), 'utf8');
  const layer = [...harness.matchAll(/'((?:assets|dev)\/[\w.-]+\.js)':\s*'\w+'/g)].map(m => m[1]);
  const page = await readFile(join(SITE, 'complete-listing.html'), 'utf8');
  const named = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(m => m[1].replace(/\?.*$/, '').replace(/^\//, ''));
  const candidates = layer.filter(name => named.includes(name));
  if (!candidates.length) {
    throw new Error('fault injection found no boot-critical script in complete-listing.html — the harness LAYER map ' +
      'and the page have drifted apart, and this mode would prove nothing');
  }
  return candidates;
}

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
    /* a victim is a path the page names, e.g. assets/submit.js — and it is
       only failed while this load has budget left for it */
    const victim = fault.victims.find(v => bare.endsWith('/' + v));
    const sent = victim ? (fault.sent[victim] || 0) : 0;
    if (victim && sent < fault.budget) { fault.sent[victim] = sent + 1; return fail(); }
  }
  cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
}

/* ---------------- what the page must do with a row ----------------

   NOT HERE. complete-listing.html's rules — fillForm's field-by-field
   prefill, cleanUt's de-duplication, renderGallery's cap, availState and
   roomsText, both availability notes, and the patch the page collects —
   are restated ONCE in scripts/page-rules.mjs (INVITE), beside the
   listing page's rules, and imported by this suite and the listing one.
   Two restatements in two files is exactly how one suite ends up still
   asserting last month's behaviour while the other is updated.

   verifyPageRules() (same file) then holds that restatement to the page:
   GRID_CAP, MAX_UNITS, the role tables, and every sentence this suite
   asserts by equality are read back out of complete-listing.html and its
   script, so a page that moves on fails as a stale restatement to decide
   about — never as a silent pass. */


/* ---------------- the page probe ----------------

   One evaluation returns everything the checks need. Nothing here asserts:
   it reports the form as it stands, and the suite decides. The overflow scan
   is the three layout rules scripts/page-rules.mjs states once
   (LAYOUT_RULES) — injected from there, not typed here — over this page's
   selector list (INVITE.overflowSelectors), and it walks the SETTLED layout:
   the load is measured under prefers-reduced-motion, so no entrance
   transform is mid-flight and what is measured is the layout a
   reduced-motion visitor gets. */

const READOUT = `(function(){
${scanSource()}
  var SEL=${JSON.stringify(INVITE.overflowSelectors)};
  function el(id){ return document.getElementById(id); }
  function shown(node){
    if(!node) return false;
    var cs=getComputedStyle(node);
    return cs.display!=='none' && cs.visibility!=='hidden';
  }
  function txtSel(sel){
    var n=document.querySelector(sel);
    return n ? String(n.textContent||'').trim() : '';
  }
  function val(id){ var n=el(id); return n ? String(n.value) : null; }
  var view='none';
  [['form','clForm'],['dead','clDead'],['done','clDone'],['loading','clLoading']].forEach(function(pair){
    if(shown(el(pair[1]))) view=pair[0];
  });

  var form=el('clFormEl');
  var editable=[];
  if(form){
    Array.prototype.forEach.call(form.querySelectorAll('input,select,textarea'), function(c){
      if(!c.disabled && shown(c)) editable.push(c.id||c.tagName);
    });
  }

  var chips=[];
  var box=el('clAmenityChips');
  if(box){
    Array.prototype.forEach.call(box.querySelectorAll('.cl-tag'), function(t){
      var inner=t.querySelector('span');
      chips.push(inner ? String(inner.textContent).trim() : String(t.textContent).replace('✕','').trim());
    });
  }

  var grid=el('clStageGrid');
  var tiles=grid ? grid.querySelectorAll('.cl-tile').length : 0;
  var kinds={};
  if(grid){
    Array.prototype.forEach.call(grid.querySelectorAll('.cl-tile .cl-kind'), function(k){
      var t=String(k.textContent||'').trim();
      kinds[t]=(kinds[t]||0)+1;
    });
  }
  var moreEl=grid ? grid.querySelector('.cl-more') : null;
  var emptyEl=grid ? grid.querySelector('.cl-empty') : null;
  var tileButtons=grid ? grid.querySelectorAll('.cl-tile button').length : 0;
  var coverBadges=[];
  var isCover=0;
  if(grid){
    Array.prototype.forEach.call(grid.querySelectorAll('.cl-tile .cl-cover'), function(b){
      coverBadges.push(String(b.textContent||'').trim());
      if(b.classList.contains('is-cover')) isCover++;
    });
  }
  var formRect=form ? form.getBoundingClientRect() : null;
  var titleRect=null;
  var h1=document.querySelector('#clTitle');
  if(h1) titleRect=h1.getBoundingClientRect();

  var saveDisplay={};
  ['clSave','clSaveDraft','clDiscard'].forEach(function(id){
    var b=el(id);
    saveDisplay[id]= b ? getComputedStyle(b).display : 'missing';
  });

  var sheets=[];
  Array.prototype.forEach.call(document.styleSheets, function(s){
    var rules=null;
    try { rules = s.cssRules ? s.cssRules.length : null; } catch(e){ rules='cross-origin'; }
    sheets.push({ href: s.href || 'inline', rules: rules });
  });

  /* the overflow scan — the walk itself comes from scanSource() above */
  var offenders=__offenders(SEL);
  var de=document.documentElement;
  var wrap=document.querySelector('.cl-wrap');

  return JSON.stringify({
    href: String(location.href),
    body: document.body ? String(document.body.innerText || '').slice(0, 160) : '',
    ready: !!form,
    view: view,
    /* the harness's own verdict on the document it wrote — see
       dev/complete-listing-harness-boot.js. A load that lost a script is
       reloaded once by the harness; if the layer the boot needs is STILL
       missing on that second load the page really is broken, and the checks
       below fail as they should. */
    boot: document.documentElement.getAttribute('data-harness-boot'),
    harnessMissing: (window.__HARNESS__ && window.__HARNESS__.missing) || [],
    harnessExpected: (window.__HARNESS__ && window.__HARNESS__.expected) || [],
    harnessScripts: (window.__HARNESS__ && window.__HARNESS__.scripts) || [],
    harnessRetried: !!(window.__HARNESS__ && window.__HARNESS__.retried),
    harnessStatus: (el('hbStatus') ? String(el('hbStatus').textContent) : ''),
    harnessLog: (el('hbLog') ? String(el('hbLog').textContent) : ''),
    title: txtSel('#clTitle'),
    permText: (el('clPermNote') ? String(el('clPermNote').textContent).trim() : ''),
    savedText: (el('clSavedNote') ? String(el('clSavedNote').textContent).trim() : ''),
    okText: (el('clOk') ? String(el('clOk').textContent).trim() : ''),
    errText: (el('clError') ? String(el('clError').textContent).trim() : ''),
    fields: {
      prop_name: val('cl_prop_name'),
      namePlaceholder: (el('cl_prop_name') ? String(el('cl_prop_name').placeholder) : null),
      ty: val('cl_ty'),
      ar: val('cl_ar'),
      rent: val('cl_rent'),
      ask: val('cl_ask'),
      nm: val('cl_nm'),
      ph: val('cl_ph'),
      role: val('cl_role'),
      units: val('cl_units'),
      avail: val('cl_avail'),
      desc: val('cl_desc'),
      access_notes: val('cl_access_notes')
    },
    splitOk: !!(el('cl_split_ok') && el('cl_split_ok').checked),
    segment: (function(){
      var seg=el('clAvailSeg'); if(!seg) return null;
      var on=seg.querySelector('.cl-seg-btn.on');
      return on ? on.getAttribute('data-seg') : null;
    })(),
    unitsNote: (function(){
      var n=el('clUnitsNote');
      return n ? { hidden: !!n.hidden, text: String(n.textContent).trim() } : null;
    })(),
    unitsWrapHidden: (function(){ var w=el('clUnitsWrap'); return w ? !!w.getAttribute('hidden') : null; })(),
    /* the page-strength panel: the score this landlord is shown, and the
       ids it is drawn through */
    strength: (function(){
      var host=el('clStrength'); if(!host) return null;
      var chips=host.querySelectorAll('.cl-strength-chip');
      var fill=el('clStrengthFill');
      var r=host.getBoundingClientRect();
      return {
        shown: shown(host),
        count: (el('clStrengthCount') ? String(el('clStrengthCount').textContent||'').trim() : ''),
        band: (el('clStrengthBand') ? String(el('clStrengthBand').textContent||'').trim() : ''),
        missing: Array.prototype.map.call(chips,function(c){ return String(c.textContent||'').trim(); }),
        nudgeShown: (el('clStrengthNudge') ? shown(el('clStrengthNudge')) : false),
        nudgeText: (el('clStrengthNudge') ? String(el('clStrengthNudge').textContent||'').trim() : ''),
        fill: (fill && fill.style ? String(fill.style.width||'') : ''),
        /* the box is built here, not through a helper: this readout has no
           box() of its own — the narrow one does, and reaching for the name
           here is how the probe first landed on a global that is not the
           helper it wanted */
        box: { l:Math.round(r.left), r:Math.round(r.right), w:Math.round(r.width),
               h:Math.round(r.height), t:Math.round(r.top) },
        clipped: host.scrollWidth > Math.ceil(r.width) + 1
      };
    })(),
    chips: chips,
    tiles: tiles,
    tileKinds: kinds,
    tileButtons: tileButtons,
    coverBadges: coverBadges,
    isCover: isCover,
    painted: { formH: formRect ? Math.round(formRect.height) : 0,
               titleW: titleRect ? Math.round(titleRect.width) : 0 },
    more: moreEl ? String(moreEl.textContent).trim() : null,
    empty: emptyEl ? String(emptyEl.textContent).trim() : null,
    photoUrl: val('cl_photo_url'),
    videoUrl: val('cl_video_url'),
    coords: txtSel('#clMapCoords'),
    coordsSet: !!(el('clMapCoords') && el('clMapCoords').classList.contains('set')),
    viewOnly: document.body.classList.contains('cl-view-only'),
    editable: editable,
    saveDisplay: saveDisplay,
    sheets: sheets,
    text: wrap ? String(wrap.innerText||'').slice(0, 12000) : '',
    overflow: { viewport: de.clientWidth, docScrollW: de.scrollWidth, horizontal: de.scrollWidth>de.clientWidth+1, offenders: offenders }
  });
})()`;

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

/* Killing the browser process is not enough for Node to exit: a renderer left
   behind by an aborted request still holds the write end of the stderr pipe
   this suite opened, and the suite then prints its total and never exits. The
   whole tree goes, then the pipe is closed. */
function killChrome(child) {
  if (process.platform === 'win32' && child.pid) {
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
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    /* a launch is a wait: the gate runs CPU-heavy node suites beside the
       browser lane, and a short budget here reports a starved machine as a
       browser that would not start */
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

/* ---------------- the mock server ---------------- */

async function reachable(base) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(base + '/mock/sb/last-patch', { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function ensureMock(base) {
  if (await reachable(base)) return { base, child: null };
  const port = new URL(base).port || '8799';
  const child = spawn(process.execPath, [join(SITE, 'dev/upload-mock-server.mjs'), port], { cwd: SITE, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await reachable(base)) return { base, child };
  }
  try { child.kill(); } catch {}
  throw new Error('dev/upload-mock-server.mjs never answered on ' + base +
    ' — is something else on that port? Use --base=http://localhost:<port>');
}

/* what the mock is holding: the seeded row, the last patch, every write */
async function readMock(base) {
  const r = await fetch(base + '/mock/sb/last-patch');
  if (!r.ok) throw new Error('GET /mock/sb/last-patch → HTTP ' + r.status);
  return r.json();
}

async function seedSentinel(base) {
  await fetch(base + '/mock/sb/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row: { payload: { prop_name: SENTINEL } } })
  });
}

/* ---------------- the load ---------------- */

async function settle(cdp, url, timeoutMs = renderTimeoutMs) {
  await cdp.send('Page.navigate', { url });
  const deadline = Date.now() + timeoutMs;
  let last = null, lastSig = null, lastErr = null;
  let navAt = Date.now(), attempts = 1;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    let raw;
    try { raw = await cdp.evaluate(READOUT); } catch (e) { lastErr = e; continue; }
    let page;
    try { page = JSON.parse(raw); } catch (e) { lastErr = e; continue; }
    last = page;
    /* a load is settled when two reads a quarter-second apart say the same
       thing — the page's last async step is the amenity table arriving, and
       a state that is still moving is not a state to judge */
    /* 'loading' is the page's own pre-boot state and 'none' means none of
       this page is loaded at all: neither is a resting state, and a stable
       pair of reads on either says "nothing has happened yet", not "this is
       what the page settled on". Waiting is the only honest answer — the
       timeout turns a page that never booted into a named failure. */
    if (page.view === 'none' || page.view === 'loading') {
      if (page.view === 'none' && Date.now() - navAt > 4000 && attempts < 3 &&
          !/complete-listing-harness/.test(page.href)) {
        /* an aborted navigation (a starved machine, a server that had not
           bound yet) leaves a document with none of this page in it. Ask
           for it again — three times, then say what the page actually was. */
        attempts++;
        navAt = Date.now();
        try { await cdp.send('Page.navigate', { url }); } catch { /* the next read will say */ }
      }
      continue;
    }
    const sig = JSON.stringify(page);
    if (lastSig === sig) return page;
    lastSig = sig;
  }
  return last || { view: 'none', href: url, body: '',
                   __err: lastErr ? String(lastErr && lastErr.message || lastErr) : 'no read at all' };
}

/* ---------------- checks ---------------- */

function checksFor(seedKey, exp, page, mock, wire) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
  const f = page.fields || {};
  const eq = (name, got, want) => t(name, String(got) === String(want),
    'got ' + JSON.stringify(got) + ', the seed says ' + JSON.stringify(want));

  /* ---- the load itself ---- */
  t('the real form booted, not the loading card, the dead link or the sent page', page.view === 'form',
    'the page is showing: ' + page.view +
    (page.harnessStatus ? ' · harness: ' + page.harnessStatus : '') +
    (page.errText ? ' · page error: ' + page.errText : ''));
  /* the reveal animation is not part of this measurement (the load is taken
     under prefers-reduced-motion), but a page that never painted would make
     everything below pass for the wrong reason */
  t('the form is painted, not merely present (' + page.painted.formH + 'px tall)',
    page.painted.formH > 300 && page.painted.titleW > 50, JSON.stringify(page.painted));
  t('no console errors, no uncaught errors', (page.cdpErrors || []).length === 0, (page.cdpErrors || []).join(' | '));
  t('the seed this suite asked for is the one the page got (the mock left the sentinel behind)',
    wire.moved && !wire.leaked, wire.note);
  t('the row the page read is the fixture\'s own seed, key for key', wire.faithful, wire.faithfulNote);
  t('loading the page wrote nothing to the backend', (mock.writes || []).length === 0,
    (mock.writes || []).length + ' write(s) on a plain load: ' + JSON.stringify((mock.writes || []).slice(0, 2)));
  t('a stylesheet arrived and parsed (this is a styled page, not a naked one)',
    (page.sheets || []).some(s => /arzuz\.css/.test(s.href || '') && typeof s.rules === 'number' && s.rules > 0),
    JSON.stringify(page.sheets));
  /* the harness's own verdict on the document it wrote — see
     dev/complete-listing-harness-boot.js. On a clean load it must be `ok`; a
     load that lost a script and was reloaded reports ok-after-retry; a page
     that never loaded the layer its own boot needs reports still-missing, and
     fails here as it should. */
  t('the page booted the layer its own boot needs (harness: ' + page.boot + ')',
    page.boot === 'ok' || page.boot === 'ok-after-retry',
    page.boot === 'still-missing'
      ? 'the document ran without ' +
        ((page.harnessMissing || []).join(', ') || (page.harnessExpected || []).join(', ')) +
        ' — a script the page names never loaded, on both the load and the harness retry'
      : 'harness boot state: ' + page.boot + (page.harnessStatus ? ' · ' + page.harnessStatus : ''));
  t('nothing overflows its box at ' + page.overflow.viewport + 'px',
    !page.overflow.horizontal && page.overflow.offenders.length === 0,
    (page.overflow.horizontal ? 'the page scrolls sideways (' + page.overflow.docScrollW + ' > ' + page.overflow.viewport + ') ' : '') +
    JSON.stringify(page.overflow.offenders.slice(0, 4)));
  t('no NaN / undefined / [object Object] reaches the form',
    !/NaN|undefined|\[object Object\]/.test(page.text) &&
    !Object.keys(f).some(k => /NaN|undefined|\[object Object\]/.test(String(f[k]))),
    (page.text.match(/.{0,40}(NaN|undefined|\[object Object\]).{0,40}/) || [''])[0]);

  /* ---- the prefill, field by field, from the row the page was given ---- */
  eq('the lodge name', f.prop_name, exp.propName);
  eq('the name placeholder' + (exp.generated ? ' (the generated title is OFFERED, not typed into the box)' : ''),
    f.namePlaceholder, exp.namePlaceholder);
  eq('the room type', f.ty, exp.ty);
  eq('the area', f.ar, exp.ar);
  eq('the rent', f.rent, exp.rent);
  eq('the opening ask', f.ask, exp.ask);
  eq('the contact name', f.nm, exp.nm);
  eq('the phone', f.ph, exp.ph);
  eq('the contact role', f.role, exp.role);
  eq('the description (the blob is pasted, not retyped)', f.desc, exp.desc);
  eq('the access notes (the passage landmark)', f.access_notes, exp.accessNotes);
  t('the split-cost box is ' + (exp.splitOk ? 'ticked' : 'unticked'), page.splitOk === exp.splitOk,
    'got ' + page.splitOk);

  /* ---- availability: the segment, the box, and the zero trap ---- */
  eq('the availability segment', page.segment, exp.segment);
  eq('the units box', f.units, exp.units);
  eq('what will be stored for availability' + (exp.unitsNote ? ' (0 units is stored as occupied)' : ''),
    f.avail, exp.storedAvail);
  if (exp.unitsNote) {
    t('the zero-units row says so on screen', page.unitsNote && !page.unitsNote.hidden,
      'the note is ' + JSON.stringify(page.unitsNote));
    eq('the note\'s words', page.unitsNote ? page.unitsNote.text : null, exp.unitsNote);
  } else {
    t('no availability warning is shown', !!page.unitsNote && page.unitsNote.hidden,
      'the note is showing: ' + JSON.stringify(page.unitsNote));
  }
  t('the units box is ' + (exp.segment === 'occupied' ? 'hidden — nothing to count' : 'visible'),
    page.unitsWrapHidden === (exp.segment === 'occupied'), 'units wrap hidden: ' + page.unitsWrapHidden);

  /* ---- the page-strength panel ----

     The landlord's page shows the same score the listings sitemap turns into
     a room's <changefreq>/<priority> (assets/listing-score.js), so it is
     asserted the way the other readouts are: derived, never hand-typed. The
     six labels come out of the MODULE, the count has to agree with the chips
     the panel printed, and the bar has to be that count as a percentage —
     three ways of saying the same thing that a panel rendering a constant
     would get wrong. */
  const st = page.strength;
  t('the page-strength panel is drawn on the landlord\'s page',
    !!st && st.shown, 'the panel is ' + JSON.stringify(st));
  if (st && st.shown) {
    const found = Number((st.count.match(/^(\d+) of (\d+)/) || [])[1]);
    const total = Number((st.count.match(/^(\d+) of (\d+)/) || [])[2]);
    eq('the score is out of the six facts the module names', total, Score.SIGNALS.length);
    t('the count agrees with the chips it printed (' + found + ' present, ' +
      st.missing.length + ' named missing)',
      found + st.missing.length === total,
      'the panel says ' + JSON.stringify(st.count) + ' and names ' + JSON.stringify(st.missing));
    t('every missing fact is printed in the scorer\'s own words',
      st.missing.every(m => Score.SIGNALS.some(s => s.label === m)),
      JSON.stringify(st.missing) + ' is not a subset of ' +
        JSON.stringify(Score.SIGNALS.map(s => s.label)));
    t('and nothing the module counts present is named as missing',
      st.missing.length === total - found,
      'the chips and the count disagree: ' + JSON.stringify(st));
    eq('the bar is the count as a percentage', st.fill,
      Math.round((found / total) * 100) + '%');
    t('the band it quotes is one of the four the protocol allows',
      ['daily', 'weekly', 'monthly', 'yearly'].some(b => st.band.indexOf(b) !== -1),
      'the panel says ' + JSON.stringify(st.band));
    t('the panel fits inside its card at ' + page.overflow.viewport + 'px',
      st.box && st.box.r <= page.overflow.viewport && !st.clipped,
      JSON.stringify({ box: st.box, clipped: st.clipped, vw: page.overflow.viewport }));
  }

  /* ---- amenities: the de-duplication rule, on screen ---- */
  t(exp.chips.length + ' amenity chip' + (exp.chips.length === 1 ? '' : 's') +
    (exp.chips.length !== (wire.utCount || exp.chips.length) ? ' (from ' + wire.utCount + ' stored)' : ''),
    JSON.stringify(page.chips) === JSON.stringify(exp.chips),
    'rendered ' + JSON.stringify(page.chips) + ', the rule says ' + JSON.stringify(exp.chips));

  /* ---- media: the cap, the kinds, the cover, the tour ---- */
  t(exp.tiles + ' media tile' + (exp.tiles === 1 ? '' : 's') +
    (exp.more ? ' with the rest behind one button' : ''),
    page.tiles === exp.tiles, 'rendered ' + page.tiles + ' tiles');
  t('the tiles are the first ' + exp.tiles + ' of the row, by kind (' +
    JSON.stringify(exp.tileKinds) + ')', JSON.stringify(page.tileKinds) === JSON.stringify(exp.tileKinds),
    'rendered ' + JSON.stringify(page.tileKinds));
  eq(exp.more ? 'the "show all" button counts what is left' : 'no cap button on a grid this size',
    page.more, exp.more);
  if (exp.viewOnly) {
    t('a read-only grid has no remove or cover buttons on its tiles', page.tileButtons === 0,
      page.tileButtons + ' button(s) inside the tiles');
  } else {
    t('every tile carries its remove button, and every photo a cover button (' +
      exp.tiles + ' tiles + ' + exp.imageCount + ' photos)',
      page.tileButtons === exp.tiles + exp.imageCount,
      'rendered ' + page.tileButtons + ' buttons');
    t(exp.imageCount ? 'exactly one tile is badged as the cover' : 'no cover badge without a photo',
      page.isCover === (exp.imageCount ? 1 : 0) &&
      (exp.imageCount ? page.coverBadges.indexOf(INVITE.text.coverIs) !== -1 : true),
      JSON.stringify(page.coverBadges));
  }
  t(exp.empty ? 'an empty grid says what to add' : 'the empty-state paragraph is gone',
    page.empty === exp.empty, 'got ' + JSON.stringify(page.empty));
  eq('the hidden cover URL', page.photoUrl, exp.photoUrl);
  eq('the hidden video URL', page.videoUrl, exp.videoUrl);

  /* ---- the read-only link ---- */
  if (exp.viewOnly) {
    t('the view-only link renders the reader\'s page, not the filler\'s',
      page.viewOnly && page.title === INVITE.text.titleView &&
      page.permText.indexOf(INVITE.text.permView) === 0,
      'view-only class: ' + page.viewOnly + ' · title: ' + JSON.stringify(page.title) +
      ' · note: ' + JSON.stringify(page.permText.slice(0, 60)));
    t('not one editable control is left (0 of ' + (page.editable || []).length + ')',
      (page.editable || []).length === 0, 'still editable: ' + (page.editable || []).join(', '));
    t('both save buttons and the discard button are unrendered',
      page.saveDisplay.clSave === 'none' && page.saveDisplay.clSaveDraft === 'none' && page.saveDisplay.clDiscard === 'none',
      JSON.stringify(page.saveDisplay));
    t('the map badge says no pin was recorded, rather than inventing one',
      /No pin recorded/.test(page.coords) && !page.coordsSet,
      JSON.stringify({ coords: page.coords, set: page.coordsSet }));
    t('the "will be saved as fully occupied" instruction is not shown to a reader',
      !!page.unitsNote && page.unitsNote.hidden, JSON.stringify(page.unitsNote));
  } else {
    t('the edit link renders the filler-in\'s page',
      !page.viewOnly && page.title === INVITE.text.titleEdit,
      'view-only class: ' + page.viewOnly + ' · title: ' + JSON.stringify(page.title));
    t('the link\'s expiry is stated',
      page.permText.indexOf(INVITE.text.permExpires) === 0, JSON.stringify(page.permText.slice(0, 80)));
    t('all three buttons are on screen', page.saveDisplay.clSave !== 'none' &&
      page.saveDisplay.clSaveDraft !== 'none' && page.saveDisplay.clDiscard !== 'none',
      JSON.stringify(page.saveDisplay));
    t('the discard button starts disabled — nothing has been changed yet',
      (page.editable || []).length > 0, 'no editable control at all');
  }
  return out;
}


/* ---------------- the narrow pass (320px) ----------------

   At 1440 and 390 px everything above is measured with TAB 1 open, which is
   all a width-agnostic pass can see: the staged grid lives in a hidden panel
   until tab 3 is clicked, so a grid that overflows at 320 has nothing to
   overflow *into* while the panel is closed.

   A phone squeezed to 320 — the width budget real handsets report, and the
   width complete-listing.html's own stylesheet names ("at 320px two tiles do
   not fit") — is where three things break first, and all three are things a
   landlord cannot work around:

     · the availability note, which is the only place the page says that
       typing 0 will store the row as fully occupied;
     · the capped grid, which has to stay two tiles wide and keep its
       "show all" button a button rather than a sliver;
     · the action bar, which is the only way to save.

   So this pass opens tab 3, measures the settled layout there, closes it
   again, and holds all three to the viewport it actually got — the page
   rule's own numbers (INVITE.tileMinPx, INVITE.ctaMinPx) where the page has
   declared one. */

const NARROW_READOUT = `(async function(){
${scanSource()}
  var SEL=${JSON.stringify(INVITE.overflowSelectors)};
  function el(id){ return document.getElementById(id); }
  function shown(node){ if(!node) return false; var cs=getComputedStyle(node);
    return cs.display!=='none' && cs.visibility!=='hidden'; }
  function box(node){ if(!node) return null; var r=node.getBoundingClientRect();
    return { l:Math.round(r.left), r:Math.round(r.right), w:Math.round(r.width),
             h:Math.round(r.height), t:Math.round(r.top) }; }
  function frame(){ return new Promise(function(res){
    requestAnimationFrame(function(){ requestAnimationFrame(res); }); }); }

  var vw=document.documentElement.clientWidth;
  var buttons={};
  ['clDiscard','clSaveDraft','clSave'].forEach(function(id){
    var b=el(id);
    buttons[id]={ box: box(b), shown: b ? shown(b) : false, text: b ? String(b.textContent||'').trim() : null };
  });
  var specs={
    seg: box(el('clAvailSeg')),
    unitsInput: box(el('cl_units')),
    note: box(el('clUnitsNote')),
    noteShown: el('clUnitsNote') ? shown(el('clUnitsNote')) : false,
    noteText: el('clUnitsNote') ? String(el('clUnitsNote').textContent||'').trim() : ''
  };

  /* tab 3 is where the grid lives: open it, measure there, put the page back */
  var tabs=document.querySelectorAll('[data-cl-tab]');
  var wasOn=null;
  Array.prototype.forEach.call(tabs,function(t){
    if(t.classList.contains('active')) wasOn=t.getAttribute('data-cl-tab');
  });
  var mediaTab=document.querySelector('[data-cl-tab="media"]');
  if(mediaTab) mediaTab.click();
  await frame();
  var grid=el('clStageGrid');
  var moreEl=grid ? grid.querySelector('.cl-more') : null;
  var emptyEl=grid ? grid.querySelector('.cl-empty') : null;
  var media={
    panelShown: shown(document.querySelector('[data-cl-panel="media"]')),
    grid: box(grid),
    tiles: [],
    more: box(moreEl),
    moreShown: moreEl ? shown(moreEl) : false,
    moreText: moreEl ? String(moreEl.textContent||'').trim() : null,
    empty: box(emptyEl),
    emptyShown: emptyEl ? shown(emptyEl) : false,
    emptyText: emptyEl ? String(emptyEl.textContent||'').trim() : null,
    offenders: __offenders(SEL)
  };
  if(grid) Array.prototype.forEach.call(grid.querySelectorAll('.cl-tile'),function(tl){ media.tiles.push(box(tl)); });
  var back=document.querySelector('[data-cl-tab="' + (wasOn || 'specs') + '"]');
  if(back) back.click();
  await frame();
  var on=null;
  Array.prototype.forEach.call(tabs,function(t){
    if(t.classList.contains('active')) on=t.getAttribute('data-cl-tab');
  });

  /* the page-strength panel, measured at this width like everything else */
  var strengthHost=el('clStrength');
  var sr=strengthHost ? strengthHost.getBoundingClientRect() : null;
  var strength=strengthHost ? {
    shown: shown(strengthHost),
    box: box(strengthHost),
    clipped: strengthHost.scrollWidth > Math.ceil(sr.width) + 1,
    missing: Array.prototype.map.call(strengthHost.querySelectorAll('.cl-strength-chip'),
      function(c){ return String(c.textContent||'').trim(); })
  } : null;

  return JSON.stringify({
    vw: vw, docScrollW: document.documentElement.scrollWidth,
    actions: box(document.querySelector('.cl-actions')),
    buttons: buttons, specs: specs, media: media, strength: strength,
    tabWas: wasOn, tabRestored: on === (wasOn || 'specs')
  });
})()`;

function narrowChecks(exp, narrow) {
  const out = [];
  const t = (name, ok, note) => out.push({ name, ok: !!ok, note: ok ? '' : (note || '') });
  const vw = narrow.vw;
  const inside = b => !!b && b.l >= -1 && b.r <= vw + 1;
  const fits = (b, what) => t(what, inside(b), JSON.stringify(b) + ' against a ' + vw + 'px viewport');
  const ids = ['clDiscard', 'clSaveDraft', 'clSave'];

  t('the page was really measured at ' + NARROW.w + 'px (a device override, not the machine)',
    vw === NARROW.w, 'the page reports a ' + vw + 'px viewport');
  t('the pass left the page on the tab it opened on', narrow.tabRestored,
    'the tab was ' + narrow.tabWas + ' and the pass ended on ' + narrow.tabRestored);

  /* ---- the availability note, and the control it belongs to ---- */
  fits(narrow.specs.seg, 'the availability control fits inside ' + vw + 'px');
  if (exp.segment === 'occupied') {
    t('a fully-occupied row has no units box to type into at this width',
      !narrow.specs.unitsInput || narrow.specs.unitsInput.w === 0,
      JSON.stringify(narrow.specs.unitsInput));
  } else {
    fits(narrow.specs.unitsInput, 'the units box fits inside ' + vw + 'px');
  }
  if (exp.unitsNote) {
    t('the availability note is on screen at ' + vw + 'px, whole and unclipped',
      narrow.specs.noteShown && inside(narrow.specs.note) && narrow.specs.note.w > 0 && narrow.specs.note.h > 0,
      JSON.stringify({ shown: narrow.specs.noteShown, box: narrow.specs.note }));
    t('the note still says the sentence the rule quotes',
      narrow.specs.noteText === exp.unitsNote,
      'the page says ' + JSON.stringify(narrow.specs.noteText));
  } else {
    t('no availability warning at ' + vw + 'px (there is nothing to warn about)',
      !narrow.specs.noteShown, JSON.stringify(narrow.specs.note));
  }

  /* ---- the page-strength panel at the narrowest width ----
     It is the first thing under the lead paragraph, so a panel that does not
     fit here pushes the whole form sideways at the width most of these
     landlords will open the link at. */
  t('the page-strength panel is on screen at ' + vw + 'px, whole and unclipped',
    narrow.strength && narrow.strength.shown && narrow.strength.box.w > 0 && !narrow.strength.clipped,
    JSON.stringify(narrow.strength));
  fits(narrow.strength ? narrow.strength.box : null, 'the panel fits inside ' + vw + 'px');

  /* ---- the capped grid, measured with the media panel open ---- */
  t('the grid still renders ' + exp.tiles + ' tile' + (exp.tiles === 1 ? '' : 's') + ' at ' + vw + 'px' +
    (exp.more ? ' (the cap holds at this width too)' : ''),
    narrow.media.tiles.length === exp.tiles,
    'measured ' + narrow.media.tiles.length + ' tiles with the media panel open');
  if (exp.tiles >= 2) {
    t('two tiles still sit side by side, each at least the stylesheet\'s own ' + INVITE.tileMinPx + 'px',
      Math.abs(narrow.media.tiles[0].t - narrow.media.tiles[1].t) <= 1 &&
      narrow.media.tiles[0].w >= INVITE.tileMinPx - 1,
      JSON.stringify(narrow.media.tiles.slice(0, 2)));
  }
  t('every media tile is inside the viewport at ' + vw + 'px',
    narrow.media.tiles.every(inside),
    JSON.stringify(narrow.media.tiles.filter(b => !inside(b))));
  if (exp.empty) {
    t('an empty grid still says what to add, on screen at ' + vw + 'px',
      narrow.media.emptyShown && inside(narrow.media.empty) && narrow.media.emptyText === exp.empty,
      JSON.stringify({ shown: narrow.media.emptyShown, box: narrow.media.empty, text: narrow.media.emptyText }));
  }
  t('nothing overflows while tab 3 is open at ' + vw + 'px' +
    (narrow.media.offenders.length ? ' — ' + narrow.media.offenders.length + ' offender(s)' : ''),
    narrow.media.offenders.length === 0 && narrow.docScrollW <= vw + 1,
    JSON.stringify(narrow.media.offenders.slice(0, 4)));
  if (exp.more) {
    t('the "show all" button is still a full-width row at ' + vw + 'px, not a sliver',
      narrow.media.moreShown && inside(narrow.media.more) &&
      narrow.media.more.w >= Math.round(vw * 0.5) && narrow.media.more.h >= 36,
      JSON.stringify(narrow.media.more));
    t('the button still counts what is behind it',
      narrow.media.moreText === exp.more,
      'the page says ' + JSON.stringify(narrow.media.moreText));
  } else {
    t('no cap button at ' + vw + 'px on a grid this small',
      !narrow.media.more, JSON.stringify(narrow.media.more));
  }

  /* ---- the action bar: the only way to save ---- */
  if (exp.viewOnly) {
    t('a reader\'s link has no action bar at ' + vw + 'px either',
      ids.every(id => !narrow.buttons[id].shown),
      JSON.stringify(ids.map(id => id + ':' + narrow.buttons[id].shown)));
  } else {
    t('all three buttons are on screen at ' + vw + 'px',
      ids.every(id => narrow.buttons[id].shown),
      JSON.stringify(ids.map(id => id + ':' + narrow.buttons[id].shown)));
    t('every button is inside the viewport at ' + vw + 'px',
      ids.every(id => inside(narrow.buttons[id].box)),
      JSON.stringify(ids.map(id => [id, narrow.buttons[id].box])));
    t('every button is a real tap target, not a squeezed label (at least 36px tall)',
      ids.every(id => narrow.buttons[id].box && narrow.buttons[id].box.h >= 36),
      JSON.stringify(ids.map(id => id + ':' + (narrow.buttons[id].box || {}).h)));
    t('no two of the three buttons overlap each other',
      !ids.some((a, i) => ids.slice(i + 1).some(b => {
        const x = narrow.buttons[a].box, y = narrow.buttons[b].box;
        return !!x && !!y && x.l < y.r - 1 && y.l < x.r - 1 && x.t < y.t + y.h - 1 && y.t < x.t + x.h - 1;
      })),
      JSON.stringify(ids.map(id => [id, narrow.buttons[id].box])));
    t('the send button keeps the page\'s own minimum width (' + INVITE.ctaMinPx + 'px)',
      !!narrow.buttons.clSave.box && narrow.buttons.clSave.box.w >= INVITE.ctaMinPx - 1,
      JSON.stringify(narrow.buttons.clSave.box));
  }
  return out;
}

/* ---------------- the recorded failures (--fail-bodies) ----------------

   dev/complete-listing-harness.html has been able to hand the page each of the
   eight failures recorded off the live project since §20 (?fail=…), and
   dev/upload-mock-server.mjs answers them in the shapes that were measured —
   a schema cache with no such function, a grant this page does not hold, a
   token that is not a uuid, a platform that is busy, unwell, or gone, and a
   connection that never answers at all. Nothing drove them end to end: the
   bodies were classified in Node (scripts/test-draft-errors.mjs) and the keys
   were pinned as documentation (scripts/test-fixture-plans.mjs), so the last
   mile — a failed RPC arriving as the right sentence in front of a landlord,
   in a browser — was walked by hand. This pass walks it, once per class, plus
   ?fail=no-row: the empty answer, the one failure that really is about the
   link.

   Neither half of a verdict is typed here:

     · what the platform answered is read back OFF THE MOCK
       (GET /mock/sb/last-patch carries the fail config now) — the same body
       the page's own fetch received. A load where the scripted failure never
       reached the page therefore cannot pass by accident;
     · what that body MEANS, and what to say about it, is
       assets/draft-errors.js itself, classified in Node from that recorded
       body — the module the page decides with.

   The page then has to match it in the way that class allows:

     · a failure on the way in (the link) is the dead card, and its title AND
       body must be the module's own sentences, word for word — not the old
       "This link is not valid" for everything, and not a sentence the page
       composed for itself;
     · a failure on the way out (a save) keeps the form and the work in it —
       a save that did not happen is a fact about the last minute, not a reason
       to throw somebody's work away — and the note must be the module's inline
       sentence for that class;
     · either way, nothing may reach the backend.

   The class the page chose is asserted too. The page announces it on the
   console (`[complete-listing] <kind> — <the platform's own words>`), and the
   suite compares it with what the classifier says that body means — so a page
   that skipped the classifier and wrote its own sentence fails here even if
   the words happen to match. */

const FAIL_READOUT = `(function(){
  function el(id){ return document.getElementById(id); }
  function shown(id){
    var n=el(id); if(!n) return false;
    var c=getComputedStyle(n);
    return c.display!=='none' && c.visibility!=='hidden';
  }
  function txt(id){ var n=el(id); return n ? String(n.textContent||'').trim() : null; }
  var view='none';
  [['form','clForm'],['dead','clDead'],['done','clDone'],['loading','clLoading']].forEach(function(pair){
    if(shown(pair[1])) view=pair[0];
  });
  return JSON.stringify({
    href: String(location.href),
    view: view,
    boot: document.documentElement.getAttribute('data-harness-boot'),
    harnessStatus: (function(){ var n=el('hbStatus'); return n ? String(n.textContent||'').trim() : null; })(),
    deadShown: shown('clDead'),
    deadTitle: txt('clDeadTitle'),
    deadBody: txt('clDeadBody'),
    formShown: shown('clForm'),
    noteShown: shown('clError'),
    note: txt('clError'),
    saveShown: shown('clSaveDraft'),
    deadText: (function(){ var n=el('clDead'); return n ? String(n.textContent||'').replace(/\s+/g,' ').trim() : null; })(),
    deadWa: (function(){
      var n=el('clDead'); if(!n || !n.querySelector) return null;
      var a=n.querySelector('a[href*="wa.me"]'); if(!a) return null;
      return { href: String(a.getAttribute('href')||''), text: String(a.textContent||'').trim(),
        target: String(a.getAttribute('target')||''), rel: String(a.getAttribute('rel')||'') };
    })(),
    vw: document.documentElement.clientWidth,
    docScrollW: document.documentElement.scrollWidth,
    kinds: (function(){ var m=window.ArzuzDraftErrors; return m && m.KINDS ? Object.keys(m.KINDS) : null; })()
  });
})()`;

/* The token the harness is walked with: the mock ignores it (it answers with
   whatever row the seed put there), so the one that matters is that the page
   reads it as a uuid rather than deciding "this link is incomplete" first. */
const FAIL_REF = '11111111-1111-4111-8111-111111111111';

/* What the mock answered for this class, turned into the descriptor the page
   owes the landlord. no-row is not an error at all — a row that is not there —
   and it is the one class the page decides for itself (`state()`). */
function answerFor(mock, key) {
  if (key === 'no-row') {
    return { route: null, body: null, descriptor: D.state('dead-link'),
             note: 'the mock held no row at all (the token that matches nothing)' };
  }
  const route = key.startsWith('get-') ? 'get' : 'update';
  const f = (mock.fail || {})[route] || null;
  if (!f) {
    return { route, body: null, descriptor: null,
             note: 'the mock was NOT holding a ' + route + ' failure' };
  }
  /* the page's own rpc() wrapper builds exactly this out of a dead connection:
     status 0, and the transport's message */
  const body = f.drop
    ? { status: 0, message: 'the request did not go through' }
    : { status: f.status, code: f.code || null, message: f.message || '' };
  return { route, body, descriptor: D.classify(body),
           note: f.drop ? 'the connection was dropped (no answer at all)'
                        : 'HTTP ' + f.status + ' ' + (f.code || '') };
}

function failBodyChecks(key, answer, read, mock, warns, errs) {
  const out = [];
  const t = (name, ok, note) => out.push({ name: key + ' · ' + name, ok: !!ok, note: ok ? '' : (note || '') });
  const d = answer.descriptor;
  const line = warns.length ? warns[warns.length - 1] : null;
  const chose = line ? line.kind : null;
  /* Every comparison below is guarded on the descriptor existing. A class the
     mock was NOT holding a failure for leaves nothing to compare against, and
     a comparison that throws there would take the suite down with it — no
     total, no verdict, which is the one kind of failure this repo refuses. So
     the missing descriptor is carried into the notes instead. */
  const kind = d ? d.kind : null;
  const wantTitle = d ? d.title : null;
  const wantBody = d ? d.body : null;
  const wantNote = d ? (d.inline || 'That did not go through.') : null;
  const why = d ? '' : ' — nothing to compare against: ' + answer.note;

  /* 1. the failure was really in force: without this, every check below could
        be about a page that quietly walked the happy path */
  t('the platform answered with ' + answer.note,
    key === 'no-row' ? mock.row === null : !!answer.body,
    key === 'no-row'
      ? 'the mock is holding a row after all: ' + JSON.stringify((mock.row || {}).id || null)
      : JSON.stringify(mock.fail || null));

  /* 2. the class the page chose is the class the classifier derives */
  t('the page decided "' + kind + '" for it — the class assets/draft-errors.js derives',
    !!d && chose === kind,
    'the page said ' + JSON.stringify(chose) +
      (line ? ' (' + line.line.slice(0, 120) + ')' : ' — it logged no [complete-listing] line at all') +
      ' · the classifier says ' + JSON.stringify(kind));

  if (answer.route === 'update') {
    /* 3. a failed save keeps the work, and says why in the module's words */
    t('the form survives the failed save, with the work still in it',
      read.formShown && !read.deadShown && read.view === 'form',
      JSON.stringify({ view: read.view, form: read.formShown, dead: read.deadShown }));
    t('the note in front of the landlord is the module\'s own sentence for ' + kind,
      !!wantNote && !!read.noteShown && !!read.note &&
        (d.inline ? read.note === wantNote : read.note.indexOf(wantNote) === 0),
      'the page says ' + JSON.stringify(read.note) + ', the module says ' + JSON.stringify(wantNote) + why);
    t('nothing was written: a save that failed is not a save',
      (mock.writes || []).length === 0,
      (mock.writes || []).length + ' write(s) reached the backend: ' +
        JSON.stringify((mock.writes || []).slice(0, 2)));
  } else {
    /* 4. a failure on the link itself is the dead card — in the module's words */
    t('the dead-link card is what the landlord is given (not the form, not a spinner)',
      read.view === 'dead' && read.deadShown && !read.formShown,
      JSON.stringify({ view: read.view, dead: read.deadShown, form: read.formShown }));
    t('the card\'s title is the module\'s own sentence for ' + kind,
      !!wantTitle && read.deadTitle === wantTitle,
      'the card says ' + JSON.stringify(read.deadTitle) + ', the module says ' + JSON.stringify(wantTitle) + why);
    t('the card\'s body is the module\'s own sentence for ' + kind,
      !!wantBody && read.deadBody === wantBody,
      'the card says ' + JSON.stringify(read.deadBody) + ', the module says ' + JSON.stringify(wantBody) + why);
    /* The card's copy tells the landlord to message us, and the number it
       prints is the shared layer's own (assets/api-errors.js WHATSAPP). The
       static markup has to carry it — a no-JS view reads nothing else — so the
       two ends are held against each other here: change the number in the
       module and this goes red until the page follows. */
    t('the card carries the number the shared layer publishes (' + D.WHATSAPP + ')',
      !!read.deadText && read.deadText.indexOf(D.WHATSAPP) !== -1,
      'the card reads ' + JSON.stringify(read.deadText));
    /* Printing the number is not enough on the device this page is opened on:
       a landlord reading it on a phone cannot tap text. The card links it —
       and the href has to be the shared layer's own international form, not a
       second copy of the number typed into the markup, which is exactly how a
       print-and-link pair drifts apart. */
    t('the number is a link, not a string the landlord has to copy out',
      !!read.deadWa && /^https:\/\/wa\.me\/\d+$/.test(read.deadWa.href),
      'the card links ' + JSON.stringify(read.deadWa && read.deadWa.href));
    t('the link is the shared layer\'s own waLink() — ' + D.waLink(),
      !!read.deadWa && read.deadWa.href === D.waLink(),
      'the card links ' + JSON.stringify(read.deadWa && read.deadWa.href) +
        ', the module builds ' + JSON.stringify(D.waLink()) + why);
    t('the linked number is the one printed on the card (' + D.WHATSAPP + ')',
      !!read.deadWa && read.deadWa.text === D.WHATSAPP,
      'the anchor reads ' + JSON.stringify(read.deadWa && read.deadWa.text));
    t('it opens in a new tab, and cannot reach back into the invite page',
      !!read.deadWa && read.deadWa.target === '_blank' && /noopener/.test(read.deadWa.rel),
      JSON.stringify(read.deadWa && { target: read.deadWa.target, rel: read.deadWa.rel }));
    t('nothing was written on a load that never had a form to save',
      (mock.writes || []).length === 0, JSON.stringify((mock.writes || []).slice(0, 2)));
  }

  /* 5. it is not the page's no-classifier fallback, and the page threw nothing */
  t('the page is not showing its "could not finish loading" fallback',
    read.deadTitle !== 'We could not open this page',
    'assets/draft-errors.js did not load, or the page bypassed it: ' + JSON.stringify(read.deadTitle));
  t('the page threw nothing of its own on the way here', errs.length === 0, errs.join(' | '));
  return out;
}

/* One load per class. The update classes only reach the page's save path by
   being saved, so this presses Save the way a landlord would and waits for the
   page to say something. */
async function failureBodies(cdp, base, fx) {
  const rows = [];
  for (const key of fx.fails.concat('no-row')) {
    const url = base + '/dev/complete-listing-harness.html?seed=worst&fail=' + key + '&ref=' + FAIL_REF;
    const warns = [], errs = [];
    const spy = msg => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const line = msg.params.args.map(a => String((a && (a.value != null ? a.value : a.description)) || '')).join(' ');
        if (msg.params.type === 'warning') {
          const m = line.match(/\[complete-listing\]\s+([a-z][a-z-]*)/);
          if (m) warns.push({ kind: m[1], line: line });
        } else if (msg.params.type === 'error') {
          errs.push('console.error: ' + line);
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        const text = String((d.exception && d.exception.description) || d.text || '');
        errs.push('uncaught: ' + text.split('\n')[0]);
      }
    };
    cdp.listeners.push(spy);

    let read = null, mock = null, page = null, failure = null;
    try {
      page = await settle(cdp, url);
      read = JSON.parse(await cdp.evaluate(FAIL_READOUT));
      if (key.startsWith('update-')) {
        await cdp.evaluate("(function(){ var b=document.getElementById('clSaveDraft');" +
          " if(b){ b.click(); return true; } return false; })()");
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 200));
          read = JSON.parse(await cdp.evaluate(FAIL_READOUT));
          if (read.noteShown) break;
        }
      }
      mock = await readMock(base);
    } catch (e) {
      failure = String((e && e.message) || e);
    }
    cdp.listeners = cdp.listeners.filter(fn => fn !== spy);
    rows.push({ key, url, page, read, mock, warns, errs, failure });
  }
  return rows;
}

/* ---------------- main ---------------- */

(async function main() {
  const fx = await loadFixture();
  const all = fx.order.slice();
  const seeds = onlySeed ? onlySeed.split(',').map(s => s.trim()).filter(Boolean) : all;
  for (const s of seeds) if (!fx.seeds[s]) throw new Error('unknown seed "' + s + '" — have: ' + all.join(', '));

  const base = baseArg || DEFAULT_BASE;
  if (urlsOnly) {
    console.log('Open any of these, then use the switcher at the bottom of the page:\n');
    for (const s of seeds) console.log('  ' + base + '/dev/complete-listing-harness.html?seed=' + s);
    console.log('\nEach recorded failure, on the seed built to break a save:\n');
    for (const k of fx.fails.concat('no-row')) {
      console.log('  ' + base + '/dev/complete-listing-harness.html?seed=worst&fail=' + k);
    }
    console.log('\n(the harness loads the real complete-listing.html; nothing here ships)');
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome/Edge/Chromium found. Set CHROME_PATH to the executable.');
    process.exitCode = 2;
    return;
  }
  const widths = INVITE.widths.filter(w => !widthArg || widthArg === 'both' || widthArg === w.key);
  if (!widths.length) throw new Error('--width must be desktop, mobile, narrow or both');
  if (!(renderTimeoutMs > 0)) throw new Error('--render-timeout must be a positive number of seconds');

  /* ---- the fixture's own plan, before a browser is opened ---- */
  const plan = fx.plan();
  /* the three questions every fixture plan gets live in scripts/page-rules.mjs;
     the rest are this page's own — its seeds, its harness, and the restatement
     itself (verifyPageRules), which is the point of the shared file: this suite
     fails when complete-listing.html moves on without the rules following, and
     when the three overflow rules stop matching the scan the other suite
     injects */
  const planChecks = fixturePlanChecks(plan, { noun: 'seed' });
  planChecks.push.apply(planChecks, await verifyPageRules('invite'));
  const pt = (name, ok, note) => planChecks.push({ name, ok: !!ok, note: ok ? '' : (note || '') });

  pt('the seven seeds this suite drives exist, in order (' + all.join(', ') + ')',
    all.length === 7 && all.every(k => plan.seeds.some(s => s.key === k)),
    'fixture order: ' + all.join(', '));

  /* the suite drives ?seed=<key>; a key the harness does not accept falls back
     to the demo row, which would make every check below assert the wrong seed —
     so the harness's own documented list is a precondition of this run */
  const harness = await readFile(join(SITE, 'dev/complete-listing-harness.html'), 'utf8');
  const docMatch = harness.replace(/\s+/g, ' ').match(/\?seed=([a-z|]+)/);
  const documented = docMatch ? docMatch[1].split('|') : [];
  pt('the harness accepts every seed this suite drives (' + documented.length + ' documented)',
    all.every(k => documented.includes(k)) && documented.includes('demo'),
    'documented: ' + documented.join(', ') + ' · driven: ' + all.join(', '));

  /* The same precondition for the failure classes: --fail-bodies drives
     ?fail=<key>, and a key the harness does not recognise falls back to the
     happy path (it says so on its own log) — which would make every check
     below about a page that simply worked. The list is the fixture's, so a
     class added there is driven here on the next run. */
  /* the harness wraps this list across two lines, so the match allows for the
     whitespace and the spaces are stripped before it is split */
  const failDoc = (harness.replace(/\s+/g, ' ').match(/\?fail=([a-z|\s-]+)/) || [])[1];
  const documentedFails = failDoc ? failDoc.replace(/\s+/g, '').split('|').filter(Boolean) : [];
  const drivenFails = fx.fails.concat('no-row');
  pt('the harness accepts every failure class this suite can drive (' + documentedFails.length +
    ' documented, ' + drivenFails.length + ' driven)',
    drivenFails.every(k => documentedFails.includes(k)),
    'not accepted by the harness: ' + drivenFails.filter(k => !documentedFails.includes(k)).join(', ') +
      ' · documented: ' + documentedFails.join(', '));
  /* the route a class fails on is read off its name (get-… / update-…), which
     is how the mock is armed; a class named for anything else would be armed
     on the wrong route and reported as "the mock was holding no failure" */
  pt('every failure class this suite drives names the route it fails on',
    drivenFails.every(k => k === 'no-row' || /^(get|update)-/.test(k)),
    'neither get- nor update-: ' + drivenFails.filter(k => k !== 'no-row' && !/^(get|update)-/.test(k)).join(', '));

  /* The harness's repair asks whether the page's OWN boot script ran, and the
     answer is a marker that script sets. A harness expecting a marker the page
     no longer sets would make every faulted load look unrecoverable, so the two
     ends are held against each other here, before a browser is opened. */
  const bootEntry = [...harness.matchAll(/'((?:assets|dev)\/[\w.-]+\.js)':\s*'(\w+)'/g)]
    .map(m => ({ file: m[1], global: m[2] }))
    .find(e => e.file === 'assets/complete-listing.js');
  const clJs = await readFile(join(SITE, 'assets/complete-listing.js'), 'utf8');
  pt('the harness names the page\'s own boot script and the global that proves it ran (' +
    'assets/complete-listing.js → ' + (bootEntry ? bootEntry.global : 'nothing') + ')',
    !!bootEntry, 'the harness LAYER map has no entry for assets/complete-listing.js');
  /* the ASSIGNMENT, not a substring that could be a longer name's prefix */
  const markerSet = !!bootEntry &&
    new RegExp('window\\.' + bootEntry.global + '\\s*=').test(clJs);
  pt('complete-listing.js still sets the marker the harness asks for (' +
    (bootEntry ? 'window.' + bootEntry.global : '?') + ')',
    markerSet,
    'assets/complete-listing.js no longer assigns window.' + (bootEntry ? bootEntry.global : '') +
    ' — the harness would report every load as still-missing');

  /* ---- the strength panel reads the SHARED score ----

     The band a landlord is shown on this page and the <changefreq> the
     listings sitemap hands the engines have to be one number. Two
     implementations would drift, and the drift would be invisible on both
     sides: the landlord would be told "weekly" while the sitemap published
     "monthly", and neither screen would look wrong. */
  const clPage = await readFile(join(SITE, 'complete-listing.html'), 'utf8');
  const scoreAt = clPage.indexOf('assets/listing-score.js');
  const pageJsAt = clPage.indexOf('assets/complete-listing.js');
  pt('complete-listing.html loads assets/listing-score.js, ahead of its own script',
    scoreAt !== -1 && pageJsAt !== -1 && scoreAt < pageJsAt,
    'the landlord page does not load assets/listing-score.js before assets/complete-listing.js');
  pt('and the page draws the panel from that module, not from its own arithmetic',
    /ArzuzListingScore/.test(clJs) &&
    !/WEIGHT_COMPLETENESS|FRESHNESS_WINDOW_DAYS/.test(clJs),
    'assets/complete-listing.js has its own copy of the score');
  pt('and netlify.toml bundles that module for the sitemap function',
    /included_files/.test(await readFile(join(SITE, 'netlify.toml'), 'utf8')) &&
    /assets\/listing-score\.js/.test(await readFile(join(SITE, 'netlify.toml'), 'utf8')),
    'netlify.toml does not list assets/listing-score.js in included_files — the sitemap would answer 503 in the deploy');

  /* ---- fault injection, before a browser is opened ---- */
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
  const faultCandidates = faultInject ? await bootCriticalScripts() : [];
  const victimsPerLoad = Math.min(faultVictims, faultCandidates.length);
  /* a loss with no surviving copy is the control: nothing can repair it, so
     this run is meant to come out red */
  const faultControl = faultDrops > 1;

  console.log('Arzuz — landlord invite form render test');
  console.log('chrome  ' + chrome);
  console.log('server  ' + base);
  console.log('seeds   ' + seeds.join(', ') + '   (' + all.length + ' generated from a declared matrix)');
  console.log('widths  ' + widths.map(w => w.key + ' ' + w.w + 'px').join(', '));
  console.log('wait    ' + (renderTimeoutMs / 1000) + 's per load before a load is called stuck');
  if (!roundTrip) console.log('note    --no-round-trip: the worst seed will not be saved');
  if (faultInject) {
    const howOften = faultRate === 1 ? 'every load' : Math.round(faultRate * 100) + '% of loads';
    console.log('fault   drop ' + faultDrops + ' parser request' + (faultDrops === 1 ? '' : 's') + ' per victim, losing ' +
      victimsPerLoad + ' of: ' + faultCandidates.join(', ') + '   (' + howOften + ')');
    console.log('seed    ' + faultSeed + '   (--fault-seed=' + faultSeed + ' replays this exact plan)');
    if (victimsPerLoad < faultVictims) {
      console.log('        (asked for ' + faultVictims + ' victims per load, but complete-listing.html only names ' +
        faultCandidates.length + ' boot-critical scripts — losing all ' + victimsPerLoad + ')');
    }
    if (faultControl) {
      console.log('        (--fault-drops=' + faultDrops + ' kills the harness retry\'s copy too: this is the control and is meant to FAIL)');
    }
  }
  console.log('\nfixture plan');
  planChecks.forEach(c => {
    if (c.ok) console.log('  ✓ ' + c.name);
    else console.log('  ✗ ' + c.name + (c.note ? '\n      → ' + c.note : ''));
  });

  let total = planChecks.length, failed = planChecks.filter(c => !c.ok).length;
  const { child: serverChild } = await ensureMock(base);
  const profile = await mkdtemp(join(tmpdir(), 'arzuz-invite-'));
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
    /* request bookkeeping: when a load stalls, "the assets never arrived" and
       "the draft RPC hung" look identical from the DOM, and they are not the
       same bug */
    await cdp.send('Network.enable');
    const requestUrls = new Map();
    if (faultInject) {
      /* Interception is armed PER LOAD and AIMED at that load's victims — see
         the fault-injection section above. It is never sprayed over every .js
         request: Chrome does not time a paused request out, so a single lost
         continueRequest hangs that request for ever. */
      cdp.listeners.push(msg => { if (msg.method === 'Fetch.requestPaused') onRequestPaused(cdp, msg.params); });
    }
    /* the settled layout, not a transform mid-flight — and reduced motion is
       also the layout a visitor who asks for it gets */
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });

    /* --fail-bodies is a different measurement of the same page, not a third
       width of the sweep: it walks the failure classes once each and skips the
       seeds, so the gate entry for it is a minute, not four. */
    for (const key of (failBodies ? [] : seeds)) {
      const fixtureSeed = fx.seeds[key];
      for (const vp of widths) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
        });

        /* what the page threw, collected per load */
        const cdpErrors = [];
        const cdnNotes = [];
        const netFails = [];
        const spy = msg => {
          if (msg.method === 'Page.frameNavigated' && msg.params.frame && !msg.params.frame.parentId) {
            cdpErrors.length = 0;
            cdnNotes.length = 0;
            netFails.length = 0;
            requestUrls.clear();
          }
          if (msg.method === 'Network.requestWillBeSent') {
            requestUrls.set(msg.params.requestId, msg.params.request.url);
          }
          if (msg.method === 'Network.loadingFailed') {
            const url = requestUrls.get(msg.params.requestId) || '';
            if (!/unpkg\.com/.test(url)) netFails.push(url + ' → ' + msg.params.errorText);
          }
          if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
            const url = msg.params.response.url;
            if (!/unpkg\.com/.test(url)) netFails.push(url + ' → HTTP ' + msg.params.response.status);
          }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            cdpErrors.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
          }
          if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            const line = 'console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' ');
            /* Leaflet is a CDN stylesheet+script for a map this suite never
               opens (tab 2 is not clicked): an offline machine must not turn
               that into a page verdict. It is reported, loudly, as an
               environment note instead. */
            if (/unpkg\.com|ERR_(NAME|INTERNET|CONNECTION|ADDRESS|TIMED)_|net::ERR/.test(line)) cdnNotes.push(line);
            else cdpErrors.push(line);
          }
        };
        cdp.listeners.push(spy);

        const label = key.toUpperCase() + ' · ' + vp.key + ' ' + vp.w + 'px';
        const ref = [key, vp.key, '0000-4000-8000-000000000000'].join('-').replace(/[^0-9a-f-]/g, 'a');
        const url = base + '/dev/complete-listing-harness.html?seed=' + key + '&ref=' + ref;

        /* ---- fault injection: armed per load, aimed at this load's victim ---- */
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

        /* the sentinel: prove the seed that reached the page is the one asked for */
        await seedSentinel(base);
        let page = null;
        try {
          page = await settle(cdp, url);
        } catch (e) {
          page = null;
        }
        /* stay armed across the harness's own reload — one load is one document
           plus the retry it may take — then stand down */
        const faultSent = Object.assign({}, fault.sent);
        const faultLanded = fault.landed;
        if (faultInject) {
          fault.armed = false;
          /* What the harness "answering as it had to" means here: the drop has
             to have landed, and the harness's one reload has to have brought
             every script back (`ok-after-retry`). A load Chrome served from
             its own copy is neither a recovery nor a failure, so it is never
             counted as proof. */
          const landedAll = lost.length > 0 && lost.every(v => (faultSent[v] || 0) >= faultDrops);
          const answered = !!page && page.boot === 'ok-after-retry';
          fault.losses += Object.keys(faultSent).reduce((a, v) => a + faultSent[v], 0);
          if (faulted && landedAll && answered) fault.proved += 1;
          await cdp.send('Fetch.disable');
        }
        const mock = await readMock(base);
        cdp.listeners = cdp.listeners.filter(fn => fn !== spy);

        if (!page || page.view === 'none' || page.view === 'loading') {
          const wroteNothing = !!page && page.boot === 'preflight-failed';
          console.log('\n' + label + '\n  ✗ ' +
            (wroteNothing
              ? 'the harness could not write the page: ' +
                String((page && page.harnessStatus) || 'no reason given').replace(/^Harness failed:\s*/, '')
              : 'the page never settled within ' + (renderTimeoutMs / 1000) +
                's — it is still showing ' + JSON.stringify(page ? page.view : '')) +
            ' at ' + JSON.stringify((page && page.href) || '') +
            (page && page.boot && !wroteNothing ? ' · harness boot: ' + page.boot : '') +
            (page && page.harnessStatus && !wroteNothing ? ' · the harness last said: ' + JSON.stringify(page.harnessStatus) : '') +
            (page && page.body ? ' · the document reads: ' + JSON.stringify(page.body) : '') +
            (page && page.__err ? ' · the probe said: ' + page.__err : '') +
            (netFails.length ? ' · ' + netFails.length + ' request(s) failed: ' + netFails.slice(0, 3).join(' | ') : '') +
            (faultInject && faulted
              ? '\n      fault: ' + faultLine(lost, faultSent) + (faultControl
                ? '  — this is the control: an unrecoverable loss is meant to be fatal'
                : '  — nothing here was meant to be fatal; the harness should have carried this load')
              : ''));
          total++; failed++;
          continue;
        }
        page.cdpErrors = cdpErrors;
        if (keepBody) {
          const p = join(tmpdir(), 'arzuz-invite-' + key + '-' + vp.key + '.json');
          await writeFile(p, JSON.stringify({ page, mock }, null, 1), 'utf8');
          console.log('  probe → ' + p);
        }

        /* the row the page read, and whether it is the fixture's own seed */
        const row = mock.row || {};
        const payload = row.payload || {};
        const moved = payload.prop_name !== SENTINEL;
        const declared = Object.keys((fixtureSeed.seed && fixtureSeed.seed.payload) || {});
        const drift = declared.filter(k =>
          JSON.stringify(payload[k]) !== JSON.stringify(fixtureSeed.seed.payload[k]));
        const wire = {
          moved,
          leaked: page.text.indexOf(SENTINEL) !== -1,
          note: moved
            ? (page.text.indexOf(SENTINEL) !== -1
              ? 'the sentinel is not in the seeded row, but it is on the page'
              : 'the harness re-seeded the row the page read')
            : 'the mock is still holding the sentinel — the page read a row nothing seeded, so every check below would be about the wrong seed',
          faithful: drift.length === 0,
          faithfulNote: 'the row the page read differs from dev/invite-fixture.js at: ' + drift.join(', '),
          utCount: (payload.ut || []).length
        };

        const exp = INVITE.deriveExpect(row);
        let checks = checksFor(key, exp, page, mock, wire);

        /* the narrow pass, in a state the checks above never put the page in:
           tab 3 open, so the capped grid is measured where it actually lives */
        if (vp.key === NARROW.key) {
          let narrow = null;
          try {
            narrow = JSON.parse(await cdp.evaluate(NARROW_READOUT));
          } catch (e) {
            checks.push({ name: 'the narrow pass could read the 320px layout', ok: false,
              note: String((e && e.message) || e) });
          }
          if (narrow) checks = checks.concat(narrowChecks(exp, narrow));
        }

        /* the round trip, on the seed built to break a save */
        if (roundTrip && key === 'worst' && vp.key === 'desktop') {
          await cdp.evaluate("(function(){ var b=document.getElementById('clSaveDraft'); if(b) b.click(); return true; })()");
          const deadline = Date.now() + 20000;
          let after = null;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 250));
            after = await readMock(base);
            if ((after.writes || []).length) break;
          }
          const settled = await cdp.evaluate(READOUT).then(JSON.parse).catch(() => page);
          checks = checks.concat(INVITE.wireChecks(exp, row, after && after.patch, (after && after.writes) || [], settled));
        }

        /* what the fault mode has to say about this load */
        if (faultInject) {
          if (!faulted) {
            /* A load the rate left alone has one obligation: it must have been
               left alone, and it must boot on the first document. */
            checks.push({
              name: 'this load was left alone (fault rate ' + faultRate + ') and booted first try',
              ok: faultLanded === 0 && page.boot === 'ok',
              note: faultLanded + ' request' + (faultLanded === 1 ? '' : 's') +
                ' failed on a load that was meant to be clean · boot ' + page.boot
            });
          } else {
            checks.push({
              name: 'the fault landed — the parser never got ' + lost.join(' + '),
              ok: lost.every(v => (faultSent[v] || 0) >= faultDrops),
              note: lost.map(v => v + ': ' + (faultSent[v] || 0) + ' of ' + faultDrops +
                ' parser request' + (faultDrops === 1 ? '' : 's')).join(' · ') +
                ' — a zero means that script was never actually lost, so this load proved nothing'
            });
            /* A load whose page came out complete anyway — Chrome served the
               script from its own copy even though the request was killed — is
               neither a recovery nor a failure: the kill cost it nothing. It
               is reported as exactly that and never counted as proof (see
               fault.proved), so it cannot make this mode look greener than it
               was. */
            const nothingMissing = !page.harnessMissing || !page.harnessMissing.length;
            const harmless = page.boot === 'ok' && nothingMissing;
            checks.push({
              name: 'the loss was answered — the harness reloaded once and the page booted with ' +
                (lost.length === 1 ? 'the lost script' : 'all ' + lost.length + ' lost scripts') + ' back',
              ok: page.boot === 'ok-after-retry' || harmless,
              note: harmless
                ? 'the page booted first try with everything present: Chrome served its own copy, so the kill ' +
                  'cost this load nothing and it is not counted as proof of recovery'
                : 'harness boot state after the loss: ' + page.boot +
                  (page.harnessMissing && page.harnessMissing.length
                    ? ' · still missing: ' + page.harnessMissing.join(', ') : '') +
                  (faultControl ? '  — this is the control: an unrecoverable loss is meant to be fatal' : '')
            });
          }
        }

        const bad = checks.filter(c => !c.ok);
        total += checks.length;
        failed += bad.length;

        console.log('\n' + label + '   (' + fixtureSeed.label + ')');
        if (faultInject) {
          console.log(faulted
            ? '  · fault: ' + faultLine(lost, faultSent) + ', boot ' + page.boot
            : '  · fault: none (rate ' + faultRate + ' left this load clean), boot ' + page.boot);
        }
        if (page.boot === 'ok-after-retry') {
          console.log('  · the harness reloaded once: the first load never loaded its shared layer ' +
            '(a script request was lost), so the numbers below are the second load');
        }
        if (cdnNotes.length) {
          console.log('  · environment: ' + cdnNotes.length + ' CDN request(s) failed (Leaflet/unpkg) — the map is not part of what this suite measures');
        }
        if (bad.length) {
          for (const x of bad) console.log('  ✗ ' + x.name + (x.note ? '\n      → ' + x.note : ''));
        }
        console.log('  ' + (checks.length - bad.length) + '/' + checks.length + ' checks passed');
      }
      console.log('  (' + fixtureSeed.note + ')');
    }

    /* ---- the recorded failures, as the landlord sees them ---- */
    if (failBodies) {
      const rows = await failureBodies(cdp, base, fx);
      for (const row of rows) {
        /* the answer is read off the mock for THIS load, so the expectation is
           built from the body the page actually received */
        const answer = answerFor(row.mock || {}, row.key);
        let checks;
        if (row.failure || !row.read) {
          checks = [{ name: row.key + ' · the load came back at all', ok: false,
            note: row.failure || 'no read came back' }];
        } else {
          checks = failBodyChecks(row.key, answer, row.read, row.mock || {}, row.warns, row.errs);
          checks.push({
            name: row.key + ' · the harness wrote a document it stands behind',
            ok: row.read.boot === 'ok' || row.read.boot === 'ok-after-retry',
            note: 'harness boot state: ' + row.read.boot + ' · ' + (row.read.harnessStatus || '')
          });
        }
        const bad = checks.filter(c => !c.ok);
        total += checks.length;
        failed += bad.length;
        console.log('\n' + row.key.toUpperCase() + ' · ?fail=' + row.key + '   (' + answer.note + ')');
        for (const x of bad) console.log('  ✗ ' + x.name + (x.note ? '\n      → ' + x.note : ''));
        console.log('  ' + (checks.length - bad.length) + '/' + checks.length + ' checks passed');
      }
      /* a class that was never driven is a hole in the pass, and the pass's
         whole value is that every recorded failure is walked every run */
      const driven = new Set(rows.map(r => r.key));
      const missed = fx.fails.concat('no-row').filter(k => !driven.has(k));
      total += 1;
      if (missed.length) failed += 1;
      console.log('\n' + (missed.length ? '  ✗ ' : '  ✓ ') +
        'all ' + (fx.fails.length + 1) + ' recorded failures were driven' +
        (missed.length ? ' — never loaded: ' + missed.join(', ') : ''));
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
      ' faulted · ' + fault.losses + ' request' + (fault.losses === 1 ? '' : 's') +
      ' never arrived · ' + fault.proved + ' answered by the harness as this mode requires');
    console.log('seed   ' + faultSeed + '   (this exact plan: --fault-seed=' + faultSeed + ')');
    /* A partial rate can select no load at all, and a fault sweep where the
       fault never fired is a green run that proved nothing — the exact failure
       this repo keeps naming. It is a failure, not a footnote. */
    if (!fault.faulted) {
      console.log('\n✗ no load was faulted, so nothing about the recovery was exercised' +
        ' (rate ' + faultRate + ' over ' + fault.loads + ' load' + (fault.loads === 1 ? '' : 's') +
        ') — re-run, or use --fault-rate=1');
      process.exitCode = 1;
    } else if (!fault.proved) {
      console.log('\n✗ ' + (faultControl
        ? 'the control: ' + fault.faulted + ' load' + (fault.faulted === 1 ? '' : 's') +
          ' lost a script with no surviving copy, so no harness could have carried it — this run is meant to be red'
        : 'not one of the ' + fault.faulted + ' faulted load' + (fault.faulted === 1 ? '' : 's') +
          ' needed the harness to answer for it (every kill was undone by the browser\'s own copy)' +
          ' — a green run here proves nothing about the recovery'));
      process.exitCode = 1;
    }
  }
  if (failed) process.exitCode = 1;
})();
