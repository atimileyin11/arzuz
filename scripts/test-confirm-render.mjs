#!/usr/bin/env node
/* ============================================================
   Arzuz — the submission confirmation, on a real page, in a real browser

   WHY THIS EXISTS

     The submit layer has a suite (scripts/test-api-errors.mjs) that
     drives assets/submit.js in a page-shaped sandbox and wins on the
     rules: a row the server wrote once, a person told once. What that
     suite cannot see is the half a person actually reads, because the
     sentences are not in submit.js — the DOOR decides, the page PRINTS.
     assets/app.js builds the confirmation block inside its own form
     engine, and until this file existed no test had ever rendered it.
     The gap was measured, not guessed: the fix that stopped a duplicate
     being delivered twice also changed what the screen says about a
     reference, and that change was covered by reasoning and by a
     constraint in the submit layer — never by an assertion on the
     markup a student looks at.

     So this suite loads the REAL register.html in headless Chrome, walks
     its real multi-step form the way a student does, answers the door at
     the network layer with each answer the server can give, and then
     asserts on what the browser actually did:

       · the reference block, when it renders, prints the reference the
         door minted — the whole string, never a different one;
       · the duplicate sentence is never shown pointing at a reference
         that is not under it (the exact sentence this class of bug
         produced: "that is the reference you already have", with
         nothing below it);
       · the toast makes the same claim as the panel — a save, a
         duplicate, or a refusal — carries the reference when there is
         one, and claims nothing the door's answer does not support;
       · and the delivery that goes out matches the door's answer: one
         message for a row the server wrote, none for a row it already
         had. The first scenario is the control that keeps the zeroes
         honest, because a page that never delivers anything would
         satisfy every other one;
       · WHAT LEFT THE PAGE is judged as bytes rather than as intent: every
         answer a person typed, every option they tapped, the honeypot
         empty, the consent they gave, and one idempotency key that a
         retry has to carry again. The payload is read off the request the
         page really posted, so a page whose own state disagrees with what
         it sent is caught here and nowhere else;
       · and an answer that means NOTHING WAS WRITTEN — a 429, our own 5xx,
         a deploy with no service key — keeps the submission on the device
         and says so, in the classifier's own HELD sentence, on both
         surfaces, while nobody is messaged about a row nobody wrote; then
         the browser's own `online` event sends the SAME submission through
         the SAME door, with the same idempotency key, and the person is
         messaged exactly once — for the row that landed, not for the
         attempts.

   HOW THE DOOR IS ANSWERED

     Not by stubbing the page's own functions: the requests leave the
     page for real and are fulfilled at the DevTools network layer
     (Fetch.enable), so assets/submit.js runs its actual code path —
     r.ok, r.status === 409, the unreadable-body branch, the classifier —
     against an answer that arrived over HTTP. /api/notify and
     /api/whatsapp-send are counted the same way, which is what makes
     "no second message" a fact rather than an intention.

   WHAT IT DOES NOT COVER

     The email/WhatsApp function's own behaviour (that is
     scripts/test-waitlist.mjs and the door's suite), the admin area, and
     a real Supabase: this is the public page against the door's
     documented answers. It also assumes dev-server.mjs and the
     Chrome/Edge already on the machine, like every other browser suite
     here.

     Nor does it read the door's own verdicts. That a filled honeypot, a
     missing phone or a form outside the allowlist is REFUSED is asserted
     in the door's suite, against the function itself; what is asserted
     here is the other half — that this page sends an empty honeypot, the
     consent the door requires, and a form it accepts.

     And one thing the held path deliberately does NOT do, worth knowing
     before a green run is read as more than it is: a submission that goes
     through on the retry is not announced on the screen. The person keeps
     the sentence they were shown (we have kept what you wrote) and the
     notice that it worked is the WhatsApp confirmation, which goes out the
     moment the row lands. The screen changing under them — "actually, sent
     now" — is a copy decision nobody has made, so this suite asserts the
     delivery and not the sentence.

   Run from arzuz-site/:
     node scripts/test-confirm-render.mjs
     node scripts/test-confirm-render.mjs --scenario=unreadable-200
     node scripts/test-confirm-render.mjs --scenario=throttled-429
     node scripts/test-confirm-render.mjs --urls
     node scripts/test-confirm-render.mjs --base=http://localhost:8123
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/* THE TWO MODULES THE PAGE'S OWN WORDS HAVE TO AGREE WITH, loaded here in
   Node rather than restated as strings in this file:

     ApiErrors  the classifier — the sentence a held submission must be
                shown is ITS sentence, so the check below is "the screen
                prints what the classifier says" and not "the screen
                prints what this test remembers";
     Door       netlify/functions/waitlist.js — the sentence a person
                agreed to (consent_text, recorded on the row) and the form
                allowlist the payload's `form` has to be in.

   Both are CommonJS on purpose, exactly as the page and the function load
   them, so what is compared here is the shipped module and not a copy. */
const requireCjs = createRequire(import.meta.url);
const ApiErrors = requireCjs(join(SITE, 'assets/api-errors.js'));
const Door = requireCjs(join(SITE, 'netlify/functions/waitlist.js'));

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const argVal = (k) => {
  const hit = args.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const base = argVal('base') || process.env.ARZUZ_TEST_BASE || 'http://localhost:8123';
const pageArg = argVal('page') || 'register.html';
const only = argVal('scenario');
const settleMs = Number(argVal('render-timeout') || 15000);
const urlsOnly = args.includes('--urls');

/* ---------------- the door's answers ----------------

   Each one is an answer netlify/functions/waitlist.js really gives, and
   `answer` is what that answer CLAIMS — which is the thing the screen has
   to agree with. `sends` is what that claim implies for the two things
   that leave the page when a row is really written: the student's WhatsApp
   confirmation (assets/whatsapp.js → /api/whatsapp-send) and the team's
   alert (assets/notify.js → /api/notify). Both are counted, because both
   are messages about a person, and neither may go out about a row the
   server did not write.

   The reference shapes are the real ones (ARZ-S-XXXX-XXXX-XXXX, minted by
   the trigger in supabase-waitlist-launch.sql). REF_UNSENT is a reference
   the door never sends in any scenario: if it ever appears on the screen,
   the page invented a reference, and the sentinel check says so by name.
*/

const REF = 'ARZ-S-7F3A-9C12-4E80';
const REF_UNSENT = 'ARZ-S-BEEF-DEAD-0000';

/* `door` is a LIST: the answer the door gives to the first POST, then to the
   second, with the last one repeating. Six of these answers are one long,
   because a page that posts once is done. The three `held` ones are two, and
   the second is the point of the first: an answer that means NOTHING WAS
   WRITTEN puts the submission in the device's own queue and the person is
   told it is kept — and then the browser's `online` event re-sends the SAME
   submission, with the same idempotency key, and the row is written once
   however many times it was attempted. Those two numbers are what keep the
   retry honest: identical client_ref, exactly one message. */

const SCENARIOS = [
  {
    id: 'saved',
    why: 'the door wrote the row and handed back a reference — the one answer that messages somebody, and the control every zero-delivery check needs',
    door: [{ status: 200, body: { ok: true, ref: REF, follow_up_status: 'new' } }],
    answer: { claim: 'new', ref: REF },
    sends: { whatsapp: 1, notify: 1 },
    toast: { say: [/saved/i], notSay: [/already on the list/i] }
  },
  {
    id: 'duplicate-by-phone',
    why: 'the same phone number registered twice: the row already existed, so nobody is messaged again',
    door: [{ status: 200, body: { ok: true, duplicate: true, ref: REF, follow_up_status: 'new' } }],
    answer: { claim: 'duplicate', ref: REF },
    sends: { whatsapp: 0, notify: 0 },
    toast: { say: [/already on the list/i, /ARZ-S-7F3A-9C12-4E80/], notSay: [/Successfully saved/i] }
  },
  {
    id: 'race-409-with-ref',
    why: 'two attempts raced and client_ref is unique, so the retry is told the row is already saved — with the reference',
    door: [{ status: 409, body: { error: 'That submission is already saved.', ref: REF, follow_up_status: 'new' } }],
    answer: { claim: 'duplicate', ref: REF },
    sends: { whatsapp: 0, notify: 0 },
    toast: { say: [/already on the list/i, /ARZ-S-7F3A-9C12-4E80/], notSay: [/Successfully saved/i] }
  },
  {
    id: 'race-409-without-ref',
    why: 'the same race, answered without the reference — the page must say so rather than point at one that is not on the screen',
    door: [{ status: 409, body: { error: 'That submission is already saved.' } }],
    answer: { claim: 'duplicate', ref: null },
    sends: { whatsapp: 0, notify: 0 },
    toast: { say: [/already on the list/i, /whatsapp/i], notSay: [/ARZ-S-/, /Successfully saved/i] }
  },
  {
    id: 'unreadable-200',
    why: 'a 200 whose body this page cannot parse — the answer it cannot interpret, which must be read as already saved rather than as a new row',
    door: [{ status: 200, body: '<!doctype html><html><body>upstream</body></html>' }],
    answer: { claim: 'duplicate', ref: null },
    sends: { whatsapp: 0, notify: 0 },
    /* The honest sentence for this answer is neither "saved!" nor "you are
       already on the list": the page cannot tell which, so it says the
       answers are in and the reference could not be read back. What it
       must NOT do is promise a reference it does not have. */
    toast: { say: [/saved/i, /whatsapp/i],
      notSay: [/Successfully saved/i, /ARZ-S-/, /this is the reference you already have/i] }
  },
  {
    id: 'refused',
    why: 'the database refused the row: nothing was written, so nothing is delivered and the screen must not read as success',
    door: [{ status: 422, body: { code: '23514', message: 'new row for relation "demand_records" violates check constraint' } }],
    answer: { claim: 'not-saved', ref: null },
    sends: { whatsapp: 0, notify: 0 },
    toast: { say: [/could not accept|not been saved|refused/i],
      notSay: [/Successfully saved/i, /already on the list/i, /ARZ-S-/] }
  },

  /* ---------------- NOT WRITTEN, AND KEPT ----------------

     Three answers that mean the row was NOT written, none of which is the
     person's fault, all of which the page is expected to HOLD and re-send:

       · a rate limit (429, the door's own throttle)
       · our insert failing at the database (a 502 from the door)
       · a deploy with no service key (503, and the door names the class
         'not-ready' so the page does not read it as a bad minute)

     `end` is what the retry answers: the row lands, so one message goes
     out after it does. The `sends` on the scenario are the FIRST attempt's
     — the counts read while the panel was on the screen — and `after` is
     what the whole run adds up to. Everything the panel must say is the
     classifier's own held sentence for that class, looked up in
     assets/api-errors.js below rather than written into this file. */
  {
    id: 'throttled-429',
    why: 'the door is rate limiting this address: nothing was written, so the row is kept on the device and said to be kept — then re-sent through the same door',
    held: true,
    door: [
      { status: 429, body: { error: 'That is a lot of submissions in a short time. Wait a moment and try again — nothing you have typed has been lost.', kind: 'busy' } },
      { status: 200, body: { ok: true, ref: REF, follow_up_status: 'new' } }
    ],
    answer: { claim: 'held', ref: null },
    sends: { whatsapp: 0, notify: 0 },
    after: { sends: { whatsapp: 1, notify: 1 }, claim: 'new', ref: REF },
    toast: { say: [], notSay: [/Successfully saved/i, /ARZ-S-/, /already on the list/i] }
  },
  {
    id: 'insert-failed-502',
    why: 'the row did not reach the database — our side, not theirs: the submission is kept and the person is told it is kept, not that it was refused',
    held: true,
    door: [
      { status: 502, body: { error: 'Arzuz could not save that just now — that is our side, not yours. Try again in a minute, or message us on WhatsApp.' } },
      { status: 200, body: { ok: true, ref: REF, follow_up_status: 'new' } }
    ],
    answer: { claim: 'held', ref: null },
    sends: { whatsapp: 0, notify: 0 },
    after: { sends: { whatsapp: 1, notify: 1 }, claim: 'new', ref: REF },
    toast: { say: [], notSay: [/Successfully saved/i, /ARZ-S-/, /already on the list/i] }
  },
  {
    id: 'door-not-ready-503',
    why: 'a deploy with no service key: the door says by name that it is not switched on, so the page keeps the row and asks the person to message us rather than telling them their form was refused',
    held: true,
    door: [
      { status: 503, body: { error: 'The waitlist door is not switched on in this deploy: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify (Site settings → Environment variables).', kind: 'not-ready' } },
      { status: 200, body: { ok: true, ref: REF, follow_up_status: 'new' } }
    ],
    answer: { claim: 'held', ref: null },
    sends: { whatsapp: 0, notify: 0 },
    after: { sends: { whatsapp: 1, notify: 1 }, claim: 'new', ref: REF },
    toast: { say: [], notSay: [/Successfully saved/i, /ARZ-S-/, /already on the list/i] }
  }
];

const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
if (!scenarios.length) {
  console.error('no scenario named "' + only + '" — the ids are: ' + SCENARIOS.map((s) => s.id).join(', '));
  process.exit(2);
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
    '--hide-scrollbars', '--window-size=390,844', '--disable-background-networking',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'
  ], { windowsHide: true });

  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome never reported a DevTools endpoint in 60s.\n' + stderr.slice(-400))), 60000);
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('Chrome exited early (' + c + ')')); });
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
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
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
  async close() { try { this.ws.close(); } catch { /* already gone */ } }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket error')); });
  });
}

/* ---------------- the server ---------------- */

async function ensureServer(base) {
  try {
    const r = await fetch(base + '/index.html');
    if (r.ok) return { child: null };
  } catch { /* not listening yet */ }
  const port = new URL(base).port || '8123';
  const child = spawn(process.execPath, [join(SITE, 'scripts/dev-server.mjs'), port], { cwd: SITE, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch(base + '/index.html'); if (r.ok) return { child }; } catch { /* keep waiting */ }
  }
  child.kill();
  throw new Error('dev-server.mjs never answered on ' + base);
}

/* ---------------- the walk ----------------

   Injected as SOURCE (pageWalk.toString()), so what runs in the browser is
   this function and not a string that resembles it. It drives the page's
   own DOM — the option buttons the engine auto-advances on, the fields,
   the consent box, the same #fNext a student presses — and it never calls
   into the form engine, because a test that reaches past the interface it
   is checking is not testing that interface.

   It reports what it found and asserts nothing; the suite judges.
*/

async function pageWalk(scenarioId) {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* WHICH DOCUMENT THIS IS. Page.navigate resolves before the parser has
     finished with the old one, so an evaluation can land on the page being
     left behind — which would drive the PREVIOUS scenario's page and report
     it as this one's, the one failure mode that would make every check here
     meaningless. So the walk waits for the URL to name the scenario it was
     asked about, and the suite asserts the readout says so too. */
  var want = 'confirm=' + scenarioId;
  for (var waited = 0; waited < 150; waited++) {
    if (location.search.indexOf(want) !== -1 && document.readyState === 'complete') break;
    await sleep(100);
  }
  var form = document.getElementById('form');
  if (!form) return { ok: false, why: 'no #form container on this page (' + location.href + ')' };

  await new Promise(function (done) {
    if (document.readyState === 'complete') return done();
    window.addEventListener('load', function () { done(); }, { once: true });
    setTimeout(done, 8000);
  });
  /* the engine draws the first step on load; a walk that starts before it
     has would click a button that does not exist yet */
  for (var w = 0; w < 60 && !document.getElementById('fNext'); w++) await sleep(50);
  if (!document.getElementById('fNext')) return { ok: false, why: 'the form never drew a step (#fNext never appeared)' };

  var values = {
    first: 'Ada', last: 'Okafor', phone: '08031234567', email: 'ada@example.com',
    nm: 'Ada Okafor', ph: '08031234567', area: 'Malete', ar: 'Malete',
    rent: '150000', amt: '150000', g_name: 'Grace Okafor', g_phone: '08037654321'
  };

  function fill() {
    var nodes = form.querySelectorAll('input, select, textarea');
    Array.prototype.forEach.call(nodes, function (n) {
      if (n.type === 'checkbox' || n.type === 'hidden' || n.type === 'file') return;
      if (n.id === 'f_hp') return;   /* the honeypot: a person cannot see it */
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (n.value) return;
      var v = values[n.id];
      if (v === undefined) {
        if (n.tagName === 'SELECT') v = n.options[1] ? n.options[1].value : '';
        else if (n.type === 'tel') v = '08031234567';
        else if (n.type === 'number') v = '150000';
        else v = 'Ada';
      }
      if (n.tagName === 'SELECT') n.value = v;
      else n.value = v;
      /* WHAT THE PERSON PUT IN, kept as what they typed rather than as what
         the page later believes: the payload has to agree with this list,
         and a form engine that drops a field on the way out is only visible
         against the values somebody actually entered. */
      typed.push([n.id, v]);
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  var steps = 0;
  var stuck = 0;
  var typed = [];          /* [fieldId, value] for every field this walk filled */
  var chosen = [];         /* the value of every option button this walk tapped */
  var consentShown = '';   /* the consent sentence, read off the step that draws it */
  var hpValue = '';        /* the trap field, as the page left it */
  while (steps < 40) {
    steps += 1;
    if (form.querySelector('.live')) break;

    /* THE CONSENT SENTENCE AND THE TRAP, read while the step holding them is
       still on the screen: the panel replaces the step, so a read taken at
       the end would find neither. This is the sentence the person agreed to
       — the suite compares it with the one the door stores on the row — and
       the trap is a field a person cannot see and must therefore never have
       touched. */
    var cbox = document.getElementById('f_consent');
    if (cbox) {
      var lab = cbox.closest ? cbox.closest('label') : cbox.parentNode;
      var txt = String((lab && lab.textContent) || '').replace(/\s+/g, ' ').trim();
      if (txt) consentShown = txt;
    }
    var trap = document.getElementById('f_hp');
    if (trap) hpValue = String(trap.value || '');

    /* ONLY THE REAL OPTIONS: `.opts .opt` is the set the page draws as
       answers. A bare `.opt` also matches the step's own guidance badge
       (its class modifier is `req`/`opt`), which is a label and not a
       control — tapping that instead is how this walk once "answered" an
       optional step with nothing at all. */
    var opt = form.querySelector('.opts .opt:not(.sel)');
    if (opt) {
      chosen.push(String(opt.dataset.v));
      opt.click();     /* option steps advance themselves after their own delay */
    } else {
      var next = document.getElementById('fNext');
      /* A disabled Finish is the send in flight. Clicking it again would
         start a SECOND submission, which would make this suite's own
         counting meaningless. */
      if (!next || next.disabled) break;
      fill();
      var box = document.getElementById('f_consent');
      if (box && !box.checked) box.checked = true;
      next.click();
    }
    await sleep(240);
  }

  var deadline = Date.now() + 15000;
  while (!form.querySelector('.live') && Date.now() < deadline) await sleep(120);

  var blocks = [];
  Array.prototype.forEach.call(form.querySelectorAll('.live'), function (n) { blocks.push(n.outerHTML); });
  var toasts = [];
  Array.prototype.forEach.call(document.querySelectorAll('.arzuz-toast'), function (n) {
    toasts.push({ cls: String(n.className || ''), text: String(n.textContent || '').trim() });
  });
  var errors = [];
  Array.prototype.forEach.call(form.querySelectorAll('.fld-error, .input-error'), function (n) {
    var t = String(n.textContent || '').trim();
    if (t) errors.push(t);
  });

  /* WHAT IS ON THE DEVICE. A submission held for a later retry is only ever
     in localStorage — no request carries it yet — so this is the one place
     it can be seen, and the row it holds has to be the row that was
     attempted: the same idempotency key, the same answers, the consent, and
     an empty trap. */
  var queue = [];
  try { queue = JSON.parse(localStorage.getItem('arzuz_queue_v1') || '[]'); } catch (e) { queue = []; }
  if (!Array.isArray(queue)) queue = [];
  var held = queue.map(function (it) {
    var row = (it && it.row) || {};
    var pay = row.payload || {};
    return {
      table: it && it.table, client_ref: row.client_ref,
      first: pay.first, phone: pay.phone, consent: pay.consent, hp: pay.hp
    };
  });

  var heading = form.querySelector('.qh');
  return {
    ok: true,
    reached: blocks.length > 0,
    steps: steps,
    heading: heading ? String(heading.textContent || '').trim() : '',
    errors: errors.slice(0, 4),
    panel: String(form.innerText || '').replace(/\s+/g, ' ').trim(),
    blocks: blocks,
    toasts: toasts,
    typed: typed,
    chosen: chosen,
    consentShown: consentShown,
    hpValue: hpValue,
    queue: queue.length,
    held: held,
    href: String(location.href)
  };
}

/* ---------------- the moment after ----------------

   Two small probes rather than one walk, because the counters this suite
   has to keep apart — "was anybody messaged about a row nobody wrote?" and
   "was anybody messaged once it landed?" — are the same counters read at two
   different times. The walk reports the first; these report the second.

   Injected as source like the walk, and neither one calls into the page's
   own modules: the retry is dispatched as the BROWSER's event, which is the
   path assets/submit.js registered for it, so what runs is the page's real
   retry and not a function this test decided to invoke. */

function pageRetry() {
  var q = [];
  try { q = JSON.parse(localStorage.getItem('arzuz_queue_v1') || '[]'); } catch (e) { q = []; }
  if (!Array.isArray(q)) q = [];
  var out = { queuedBefore: q.length, dispatched: false };
  try {
    window.dispatchEvent(new Event('online'));
    out.dispatched = true;
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

function pageTail() {
  var q = [];
  try { q = JSON.parse(localStorage.getItem('arzuz_queue_v1') || '[]'); } catch (e) { q = []; }
  if (!Array.isArray(q)) q = [];
  var toasts = [];
  Array.prototype.forEach.call(document.querySelectorAll('.arzuz-toast'), function (n) {
    toasts.push({ cls: String(n.className || ''), text: String(n.textContent || '').trim() });
  });
  return {
    queue: q.length,
    pending: (typeof ArzuzSubmit !== 'undefined' && ArzuzSubmit.pending) ? ArzuzSubmit.pending() : -1,
    toasts: toasts
  };
}

/* ---------------- the door, answered at the network layer ---------------- */

function fulfil(cdp, params, code, text) {
  return cdp.send('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: code,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(text, 'utf8').toString('base64')
  }).catch(() => { /* the page may have gone away with the request in flight */ });
}

function router(cdp, sc, stats) {
  return (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const params = msg.params;
    const url = String((params.request || {}).url || '').split('?')[0];
    if (url.endsWith('/api/waitlist')) {
      const attempt = stats.door;
      stats.door += 1;
      /* WHAT LEFT THE PAGE, kept as the bytes of the request rather than as
         the page's own idea of what it sent. This is the only record of the
         submission in this suite that does not come from the code under
         test, which is why the answers, the trap and the idempotency key are
         all judged from here. */
      let sent = null;
      try { sent = JSON.parse(String((params.request || {}).postData || '')); } catch { sent = null; }
      stats.sent.push(sent);
      /* The answer for THIS attempt: the first answer to the first POST, the
         second to the retry, and the last one repeats if a page posts more
         times than an answer was written for. */
      const answer = sc.door[Math.min(attempt, sc.door.length - 1)];
      return fulfil(cdp, params, answer.status,
        typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    }
    if (url.endsWith('/api/notify')) { stats.notify += 1; return fulfil(cdp, params, 200, '{"ok":true}'); }
    if (url.endsWith('/api/whatsapp-send')) { stats.whatsapp += 1; return fulfil(cdp, params, 200, '{"ok":true}'); }
    return cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
  };
}

/* A bounded wait on a condition, for the one thing this suite waits FOR
   rather than waits OUT: the retry is a real request to the real door, so the
   honest thing to wait on is the counter moving, not a sleep long enough to
   usually be enough. */
async function waitUntil(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/* Two payloads compared as payloads: the keys sorted, so a differently
   ordered object is the same submission and a changed value is not. */
const stable = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));

/* ---------------- judging ----------------

   The checks are RELATIONAL: nothing here restates a sentence as the page
   must write it. Each one compares the screen to the answer the door gave
   — which reference, which claim, how many messages — so a copy change is
   not a test failure and a page that says one thing while the server did
   another is.
*/

function judge(sc, read, stats, pageErrors, expect) {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok: !!ok, note: note || '' });

  /* The bytes that left the page, in order, as far as they could be parsed. */
  const sent = (stats.sent || []).filter(Boolean);
  const firstSent = sent[0] || null;
  const atPanel = expect.atPanel || {};

  const panel = String(read.panel || '');
  const blocks = (read.blocks || []).join('\n');
  const toast = (read.toasts || []).map((t) => t.text).join(' | ');
  const surface = blocks + ' ' + panel + ' ' + toast;
  const refs = Array.from(new Set(surface.match(/ARZ-S-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g) || []));
  const doorRef = sc.answer.ref;
  const stamped = doorRef ? 'Your reference: ' + doorRef : null;

  /* FIDELITY FIRST: a readout from the wrong document is not a verdict. */
  add('the readout came from the page this scenario asked for',
    String(read.href || '').indexOf('confirm=' + sc.id) !== -1,
    'readout came from ' + (read.href || '(nowhere)'));

  add('the confirmation rendered', read.reached,
    'the form never finished' + (read.heading ? ' — it stopped on "' + read.heading + '"' : '') +
    (read.errors && read.errors.length ? ' (' + read.errors.join(' / ') + ')' : ''));

  if (sc.answer.claim === 'new') {
    add('it tells the person the row was saved',
      panel.indexOf('Submission saved!') !== -1,
      'the door wrote the row and the screen does not say so');
    add('the reference the door minted is printed, whole',
      (blocks + panel).indexOf(stamped) !== -1,
      'the door sent ' + doorRef + ' and the screen does not carry "Your reference: ' + doorRef + '"');
  } else if (sc.answer.claim === 'duplicate') {
    add('it tells the person they are already on the list',
      panel.indexOf('You are already on the list') !== -1,
      'the door said the row already existed and the screen does not say so');
    add('it does not ALSO claim a new row was saved',
      panel.indexOf('Submission saved!') === -1,
      'the screen claims a row was saved when the server said it already had one');
    if (doorRef) {
      add('the reference it prints is the door\u2019s, and it is printed in full',
        panel.indexOf(stamped) !== -1,
        'the door sent ' + doorRef + ' and the screen does not show it');
    } else {
      add('no reference block is drawn when the door sent no reference',
        panel.indexOf('Your reference:') === -1,
        'a reference block was rendered for an answer that carried no reference');
    }
    /* THE SENTENCE THAT USED TO LIE. It points at a reference below it, so
       it may only appear when the reference really is below it. */
    add('the sentence about the reference already held is never shown without that reference',
      panel.indexOf('this is the reference you already have') === -1 || panel.indexOf(stamped) !== -1,
      'the screen says the reference is below it, and it is not');
  } else if (sc.answer.claim === 'held') {
    /* AN ANSWER THAT MEANS NOTHING WAS WRITTEN, AND THE PERSON IS TOLD SO.

       The row was refused a place by something that is not this person's
       fault — a rate limit, our own 5xx, a deploy with no service key — so
       the page has two jobs and one sentence: KEEP the submission, and say it
       is kept, not sent. The sentence is looked up in the classifier for the
       class the door's own answer names, so this check is "the screen prints
       what the classifier says" rather than "the screen prints what this test
       remembers", and a copy change that lands in one place and not the other
       fails here. */
    add('it does not claim the row was saved',
      panel.indexOf('Submission saved!') === -1 && panel.indexOf('You are already on the list') === -1,
      'the door wrote nothing and the screen reads as success');
    add('it says the answers are KEPT, in the classifier\u2019s own held sentence',
      !!expect.heldSentence && panel.indexOf(expect.heldSentence) !== -1,
      'the door answered ' + sc.door[0].status + ' (' + expect.heldKind + ') and the panel does not carry the ' +
      'held sentence for that class: ' + JSON.stringify(expect.heldSentence));
    add('it does not promise a reference for a submission nobody wrote',
      panel.indexOf('Your reference:') === -1 && !/ARZ-S-/.test(panel),
      'a reference block was drawn for an answer that carried none');
  } else {
    add('it does not claim the row was saved',
      panel.indexOf('Submission saved!') === -1 && panel.indexOf('You are already on the list') === -1,
      'the screen reads as success for a row the database refused');
    add('it says the row was not accepted, in the classifier\u2019s own words',
      /could not accept|refused|not been saved/i.test(panel),
      'a refusal was reported as: ' + JSON.stringify(panel.slice(-160)));
  }

  /* THE RULE, WHICH IS ALSO ONE LINE: a message about a person goes out for
     a row the server said it had just WRITTEN, and for nothing else.

     A held submission needs that rule read twice, so both readings are
     checked and they are different questions. `sc.sends` is the FIRST
     attempt's count — nobody is messaged about a row nobody wrote — and
     `sc.after` is what the whole scenario adds up to once the retry has
     landed. The counters run through the retry, so the counts at the moment
     the panel was on the screen were snapshotted by the caller and are judged
     below; what is judged here is the total. */
  const finalSends = sc.after ? sc.after.sends : sc.sends;
  add('the person was messaged exactly ' + finalSends.whatsapp + ' time(s) for this answer',
    stats.whatsapp === finalSends.whatsapp,
    'the page sent ' + stats.whatsapp + ' WhatsApp confirmation(s) and this answer calls for ' +
    finalSends.whatsapp + (finalSends.whatsapp === 0
      ? ' \u2014 somebody who registered once must not be messaged twice'
      : ' \u2014 and a page that never delivers anything would satisfy every other check here') +
    (sc.after ? ', counted after the held row was re-sent' : ''));
  add('the team was alerted exactly ' + finalSends.notify + ' time(s) for this answer',
    stats.notify === finalSends.notify,
    'the page sent ' + stats.notify + ' alert(s) and this answer calls for ' + finalSends.notify +
    (sc.after ? ', counted after the held row was re-sent' : ''));
  const attempts = sc.held ? 2 : 1;
  add('the submission reached the door exactly ' + attempts + ' time(s)',
    stats.door === attempts,
    stats.door + ' POST(s) to /api/waitlist and this answer calls for ' + attempts +
    (sc.held
      ? ' \u2014 the attempt the door refused, and the same submission once the network was back'
      : ' \u2014 a second POST here would be a second submission, not a recovery'));

  /* ============================================================
     WHAT LEFT THE PAGE

     Read off the request the page actually posted, never off the page's own
     state, because the two can disagree and the DOOR is the one that acts on
     the bytes. Four things are checked, and each of them is a refusal the
     other end will make:

       · the answers this walk typed, and the options it tapped, so a form
         engine that drops a field on the way out is caught before a student
         loses their place in the queue;
       · an EMPTY honeypot, which is the difference between a submission and
         a bot to both the door and the database;
       · the consent, as the agreement the door requires and in the words the
         row will record — the same sentence, checked against the function
         that stores it;
       · and one idempotency key, which is what makes a retry a retry.
     ============================================================ */
  add('the submission left the page at all', !!firstSent,
    'no readable POST to /api/waitlist was seen');
  if (firstSent) {
    const answers = (firstSent.answers && typeof firstSent.answers === 'object') ? firstSent.answers : {};
    const missing = (read.typed || []).filter((pair) => String(answers[pair[0]]) !== String(pair[1]));
    add('every answer the person typed went with it',
      !missing.length,
      'the person typed ' + JSON.stringify(missing) + ' and the payload carries ' + JSON.stringify(answers));
    const values = Object.keys(answers).map((k) => String(answers[k]));
    const untapped = (read.chosen || []).filter((v) => values.indexOf(String(v)) === -1);
    add('every option the person tapped went with it',
      !untapped.length,
      'the person tapped ' + JSON.stringify(untapped) + ' and none of it is in the payload');
    add('the honeypot went out empty',
      answers.hp === '' && read.hpValue === '',
      'the trap left the page as ' + JSON.stringify(answers.hp) + ' \u2014 a filled one is refused as a bot, by the door and by the database');
    add('the consent travelled as the agreement the door requires',
      String(answers.consent).toLowerCase() === 'yes',
      'the payload carries consent ' + JSON.stringify(answers.consent) + ' and the door refuses a submission without it');
    add('the sentence the person agreed to is the sentence the server records',
      !!read.consentShown && read.consentShown === Door.CONSENT_TEXT,
      'the page showed ' + JSON.stringify(read.consentShown) + ' and the door stores ' +
      JSON.stringify(Door.CONSENT_TEXT));
    add('the page submitted a form the door accepts',
      !!(firstSent.form && Door.FORMS[firstSent.form]),
      'the page posted form ' + JSON.stringify(firstSent.form) + ' and the door serves ' +
      Object.keys(Door.FORMS).join(', '));
    add('the submission carried an idempotency key',
      /^[0-9a-f-]{36}$/i.test(String(firstSent.client_ref || '')),
      'client_ref left the page as ' + JSON.stringify(firstSent.client_ref) +
      ' \u2014 without one, a retry is a second submission');
  }

  /* NOTHING IS LEFT ON THE DEVICE FOR AN ANSWER THAT IS NOT HELD. A save, a
     duplicate and a refusal are all finished with: the first two were
     written, and the third will be refused identically forever. Only a held
     answer may put a row in the queue, which is what makes the held ones
     mean something. */
  if (!sc.held) {
    add('nothing was left on the device for this answer',
      read.queue === 0,
      'the device queue holds ' + read.queue + ' item(s) after an answer that is not a held one: ' +
      JSON.stringify(read.held));
  }

  /* AN ANSWER THAT MEANS NOTHING WAS WRITTEN, IN BOTH DIRECTIONS: nobody was
     messaged while the row sat unwritten on the device, and the SAME
     submission went through the SAME door once the browser said it was back
     online — carrying the same key, so the row can only exist once. */
  if (sc.held) {
    add('nothing was messaged about a row nobody wrote',
      atPanel.whatsapp === 0 && atPanel.notify === 0,
      'while the panel was on the screen the page had already sent ' + atPanel.whatsapp +
      ' WhatsApp and ' + atPanel.notify + ' alert(s)');
    add('the refused attempt had reached the door once, and only once',
      atPanel.door === 1,
      atPanel.door + ' POST(s) had reached the door while the row was only kept');
    add('the submission was kept on the device, whole',
      !!read.held && read.held.length === 1 &&
        read.held[0].client_ref === expect.firstRef &&
        read.held[0].consent === 'yes' && read.held[0].hp === '' &&
        read.held[0].first === (firstSent ? (firstSent.answers || {}).first : null),
      'the device holds ' + JSON.stringify(read.held) + ' and the attempt carried ' +
      JSON.stringify(expect.firstRef));
    add('the row left the device again when the browser came back online',
      read.retryDispatched === true && read.retryLanded === true,
      'the online event was ' + (read.retryDispatched ? 'dispatched' : 'never dispatched') +
      ' and the door saw ' + stats.door + ' POST(s) before the retry was answered');
    add('the re-send went through the same door as the first attempt',
      !!(firstSent && sent[1] && firstSent.form === sent[1].form && sent[1].form),
      'the attempts posted to forms ' + JSON.stringify([firstSent && firstSent.form, sent[1] && sent[1].form]));
    add('the re-send carried the SAME idempotency key, so the row can only be written once',
      !!(firstSent && sent[1] && firstSent.client_ref && sent[1].client_ref === firstSent.client_ref),
      'the first attempt carried ' + JSON.stringify(firstSent && firstSent.client_ref) +
      ' and the re-send carried ' + JSON.stringify((sent[1] || {}).client_ref));
    add('the re-send carried the same answers',
      !!(firstSent && sent[1] && stable(firstSent.answers) === stable(sent[1].answers)),
      'the answers changed between the attempt and the retry, which would make the retry a different submission');
    add('the queue is empty once the row has landed',
      read.queueAfter === 0 && read.pendingAfter === 0,
      'the device holds ' + read.queueAfter + ' item(s) and ArzuzSubmit.pending() says ' + read.pendingAfter);
    add('the toast said the row was kept, in the classifier\u2019s own words',
      !!expect.heldSentence && toast.indexOf(expect.heldSentence) !== -1,
      'the toast is ' + JSON.stringify(toast) + ' and the held sentence is ' + JSON.stringify(expect.heldSentence));
  }

  /* THE TOAST AND THE PANEL, ONE CLAIM, TWO SURFACES.

     What the toast must say and must not say is taken from the answer the
     door gave, not from a sentence copied out of the page: the reference
     it may carry is the door's own string, and "claims nothing extra" is
     what keeps a saved row from being announced as a duplicate and a
     refusal from reading as success. */
  const unmet = (sc.toast.say || []).filter((re) => !re.test(toast));
  const unsupported = (sc.toast.notSay || []).filter((re) => re.test(toast));
  add('the toast makes the claim this answer calls for',
    unmet.length === 0,
    'the toast is ' + JSON.stringify(toast) + ' and it is missing ' + unmet.map(String).join(', '));
  add('the toast claims nothing this answer does not support',
    unsupported.length === 0,
    'the toast is ' + JSON.stringify(toast) + ' and it claims ' + unsupported.map(String).join(', '));

  /* NO INVENTED HANDLE, AND NO BARE CODE. A reference the door never minted
     is worse than no reference: it is a string a person will quote to
     support, where it finds nothing. */
  add('no reference is shown that the door never sent',
    refs.every((r) => r === doorRef),
    'the page printed ' + refs.join(', ') + ' and the door sent ' + (doorRef || 'nothing'));
  /* The sentinel, said out loud: a reference-shaped string hardcoded in a
     page is a string a person will quote to support, where nothing
     answers to it. It is not in any answer above, so it can only appear
     if a page invented one. */
  add('and no reference-shaped string is hardcoded in the page',
    refs.indexOf(REF_UNSENT) === -1,
    REF_UNSENT + ' appeared on the screen, and no door ever minted it');
  add('no bare status code reached a person',
    !/HTTP \d{3}/.test(surface),
    'the screen carries a status code instead of a sentence');
  add('nothing threw while the page handled it',
    (pageErrors || []).length === 0,
    (pageErrors || []).join(' | '));

  return checks;
}

/* ---------------- main ---------------- */

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome, Edge or Chromium found. Set CHROME_PATH to one, or skip this suite.');
    process.exit(2);
  }

  if (urlsOnly) {
    for (const sc of scenarios) console.log(base + '/' + pageArg + '   (' + sc.id + ')');
    return;
  }

  let total = 0;
  let failed = 0;
  let chromeChild = null;
  let cdp = null;
  let serverChild = null;
  let profile = null;

  try {
    profile = await mkdtemp(join(tmpdir(), 'arzuz-confirm-'));
    const ensured = await ensureServer(base);
    serverChild = ensured.child;

    const launched = await launchChrome(chrome, profile);
    chromeChild = launched.child;
    const port = new URL(launched.endpoint).port;
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const target = targets.find((t) => t.type === 'page');
    if (!target) throw new Error('no page target in Chrome');
    cdp = new CDP(await openWs(target.webSocketDebuggerUrl));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('Arzuz submission confirmation — ' + pageArg + ', in a real browser');
    console.log('server  ' + base + (serverChild ? '  (started by this suite)' : '  (already running)'));
    console.log('chrome  ' + chrome);
    console.log('answers ' + scenarios.length + ' \u00b7 ' + SCENARIOS.length + ' known \u00b7 ' +
      scenarios.filter((s) => s.held).length + ' of them held for a retry');

    for (const sc of scenarios) {
      const stats = { door: 0, notify: 0, whatsapp: 0, sent: [] };
      const pageErrors = [];
      const spy = (msg) => {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          pageErrors.push('uncaught: ' + ((d.exception && d.exception.description) ? d.exception.description.split('\n')[0] : d.text));
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          pageErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
        }
      };
      const route = router(cdp, sc, stats);
      const listener = (msg) => { if (msg.method === 'Fetch.requestPaused') route(msg); else spy(msg); };
      cdp.listeners.push(listener);

      let read = null;
      let threw = null;
      /* WHAT THE COUNTERS SAID WHILE THE PANEL WAS ON THE SCREEN. For a held
         submission this is the only honest way to ask "was anybody messaged
         about a row nobody wrote?" — the counters keep running through the
         retry, so reading them at the end answers a different question. */
      let atPanel = { door: 0, whatsapp: 0, notify: 0 };
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        /* a fresh queue per scenario: the offline queue lives in
           localStorage, and a row held by one answer must not be flushed
           by the next one's page load */
        await cdp.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' }).catch(() => {});
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
        await cdp.send('Page.navigate', { url: base + '/' + pageArg + '?confirm=' + sc.id });
        read = await cdp.evaluate('(' + pageWalk.toString() + ')(' + JSON.stringify(sc.id) + ')');
        atPanel = { door: stats.door, whatsapp: stats.whatsapp, notify: stats.notify };

        /* THE SECOND HALF OF A HELD ANSWER. The row is on the device; the
           browser now says it is online again, and the page's own listener
           re-sends it through the same door. This is dispatched as the EVENT
           and not as a call into ArzuzSubmit, so what runs is the page's real
           retry path; the wait is on the door actually answering, bounded, so
           a retry that never leaves says so instead of hanging. */
        if (read && read.ok && sc.held) {
          const retry = await cdp.evaluate('(' + pageRetry.toString() + ')()');
          read.retryDispatched = !!(retry && retry.dispatched);
          read.queuedBeforeRetry = retry ? retry.queuedBefore : -1;
          read.retryLanded = await waitUntil(() => stats.door >= 2 && stats.whatsapp >= 1, 8000);
          const tail = await cdp.evaluate('(' + pageTail.toString() + ')()');
          if (tail) {
            read.queueAfter = tail.queue;
            read.pendingAfter = tail.pending;
            const seen = {};
            (read.toasts || []).forEach((t) => { seen[t.cls + '|' + t.text] = true; });
            (tail.toasts || []).forEach((t) => { if (!seen[t.cls + '|' + t.text]) read.toasts.push(t); });
          }
        }
      } catch (err) {
        threw = String((err && err.message) || err);
      } finally {
        await cdp.send('Fetch.disable').catch(() => {});
        cdp.listeners = cdp.listeners.filter((f) => f !== listener);
      }

      const asked = sc.door[0];
      console.log('\n\u2550\u2550\u2550\u2550 ' + sc.id.toUpperCase() + ' — door answers ' + asked.status +
        ', claim "' + sc.answer.claim + '"' + (sc.answer.ref ? ', ref ' + sc.answer.ref : '') +
        (sc.held ? ', then ' + sc.door[1].status + ' on the retry' : ''));
      console.log('  ' + sc.why);

      if (threw || !read || !read.ok) {
        total += 1;
        failed += 1;
        console.log('  \u2717 the page could not be driven to the confirmation');
        console.log('      ' + (threw || (read && read.why) || 'no readout'));
        continue;
      }

      /* WHAT THE PAGE MUST SAY ABOUT THE ANSWER IT GOT, derived from that
         answer rather than written out here: the class is the one the door's
         own body names — falling back to the status, exactly as
         assets/submit.js does — and the sentence is that class's HELD line in
         assets/api-errors.js. So the check on the screen is "the page prints
         what the classifier says", and neither half is a copy of the other. */
      const answerRead = ApiErrors.classify({
        status: asked.status,
        kind: (asked.body && typeof asked.body === 'object' && asked.body.kind) || undefined
      });
      const checks = judge(sc, read, stats, pageErrors, {
        atPanel: atPanel,
        heldKind: answerRead.kind,
        heldSentence: answerRead.queued || answerRead.inline || '',
        firstRef: stats.sent[0] ? stats.sent[0].client_ref : null
      });
      const bad = checks.filter((c) => !c.ok);
      total += checks.length;
      failed += bad.length;
      for (const c of bad) console.log('  \u2717 ' + c.name + '\n      \u2192 ' + c.note);
      console.log(bad.length
        ? '  ' + (checks.length - bad.length) + '/' + checks.length + ' checks passed  (' +
          read.steps + ' form step(s), whatsapp ' + stats.whatsapp + ', alert ' + stats.notify +
          (sc.held ? ', ' + stats.door + ' door attempt(s)' : '') + ')'
        : '  \u2713 ' + checks.length + '/' + checks.length + ' checks passed  (' +
          read.steps + ' form step(s), whatsapp ' + stats.whatsapp + ', alert ' + stats.notify +
          (sc.held ? ', ' + stats.door + ' door attempt(s)' : '') + ')');
    }
  } finally {
    if (cdp) await cdp.close();
    if (chromeChild) chromeChild.kill();
    if (serverChild) serverChild.kill();
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014');
  console.log('TOTAL ' + total + ' \u00b7 PASS ' + (total - failed) + ' \u00b7 FAIL ' + failed);
  if (failed) process.exitCode = 1;
})();
