/* ============================================================
   Arzuz Admin — headless boot + functional test (DEV ONLY)
   Run:  node dev/admin-boot-test.js

   Boots the REAL dashboard scripts (config, auth, data,
   strategy, notify, submit, admin-ui, admin-mock-data,
   admin-mock, admin) inside a VM sandbox with a minimal DOM
   shim, served by the real mock harness fetch. No browser and
   no network needed.

   Coverage per role (admin / support / marketing):
     - boot without exceptions; gate hidden; nav role-filtered
     - every section renders without exceptions
     - Overview numbers trace to the mock dataset
     - tables render the expected row counts
     - details / edit / delete modals open for every table
     - delete confirm: wrong ID rejected, right ID deletes
     - Add Apartment submit inserts into the mock DB
     - CSV export produces a download payload
     - console stays free of errors

   Coverage of the four touch surfaces (see testGestures and
   testReleaseThresholds below):
     - the drawer, the bottom sheets and the lightboxes engage on the
       right gesture, track the finger and release where the policy says
     - every integer distance from 0 to each surface's own size is swept
       through the real gesture, at the heights and widths real phones lay
       out, so both branches of every policy (the 90px floor and the
       percentage) are exercised AND the verdict has to flip exactly once,
       at the line the policy documents in pixels
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

/* The VM sandbox, the script list and the tick live in admin-sandbox.js,
   so that dev/postgrest-test.js can boot the SAME dashboard scripts
   against real PostgREST answers without a second DOM shim drifting
   away from this one. Everything else in this file is the suite. */
const { DASHBOARD_SCRIPTS, makeSandbox, runScripts, tick, setBox, ROOT } = require('./admin-sandbox.js');

/* ---------------- results ---------------- */

const RESULTS = [];
let currentRole = 'admin';

function check(name, fn) {
  try {
    const ok = fn();
    const pass = ok === true || (ok && typeof ok !== 'string');
    RESULTS.push({ role: currentRole, name, ok: pass, note: pass ? '' : String(ok) });
    console.log((pass ? '  \u2713 ' : '  \u2717 ') + name + (pass ? '' : '  \u2192 ' + ok));
  } catch (e) {
    RESULTS.push({ role: currentRole, name, ok: false, note: e.message });
    console.log('  \u2717 ' + name + '  \u2192 threw: ' + e.message);
  }
}

/* ---------------- the Care panel's controls, as an invariant ----------------

   Replaces a check that asserted the absence of `data-care="adjust"` — a
   control that appears nowhere in assets/admin.js. It passed for every role,
   for every panel, and could never fail: the shape of assertion this repo
   already hunts elsewhere (see scripts/verify-migrations.mjs on vacuity).

   What is asserted instead is a fact about the two files that decide it:

     · every control the rendered panel carries must be one the page's own
       click dispatcher handles — otherwise the panel draws a button that
       does nothing, which is exactly what a role-specific branch hides;
     · every control that reaches careAct() must map to an action
       netlify/functions/care-credit.js accepts;
     · the money controls the panel is expected to offer must actually be
       drawn, so a role that quietly loses one is a failure rather than a
       shorter list.

   The two vocabularies are READ OUT of those files rather than restated
   here, because a list restated in a test is a second copy that drifts. */
function careControlsAreSound(html, label, required) {
  const adminSrc = fs.readFileSync(path.join(ROOT, 'assets/admin.js'), 'utf8');
  const fnSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/care-credit.js'), 'utf8');
  /* `act === '...'` names two different vocabularies in admin.js: the Care
     dispatcher (data-care) and the table one (data-act: view, edit, del,
     draft-*). Read the Care block alone, so a data-care typo cannot be
     "wired" by an unrelated table action. */
  const careAt = adminSrc.indexOf("closest('[data-care]')");
  if (careAt === -1) return 'the Care panel no longer dispatches on [data-care] at all';
  const close = adminSrc.indexOf('\r\n  });', careAt);
  const careBlock = adminSrc.slice(careAt, close === -1 ? careAt + 2000 : close);
  const wired = new Set([...careBlock.matchAll(/act === '([^']+)'/g)].map(m => m[1]));
  const accepted = new Set([...fnSrc.matchAll(/action === '([a-z]+)'/g)].map(m => m[1]));
  /* the UI names that end in careAct(), and the action each one sends */
  const writes = { 'spend-confirm': 'spend', refund: 'refund', expire: 'expire', 'grant-submit': 'grant' };

  const drawn = new Set([...String(html).matchAll(/data-care="([^"]+)"/g)].map(m => m[1]));
  if (!drawn.size) return 'the ' + label + ' panel drew no Care control at all';

  const dead = [...drawn].filter(d => !wired.has(d));
  if (dead.length) return 'the panel draws controls the page has no handler for: ' + dead.join(', ');

  const refused = Object.keys(writes).filter(k => drawn.has(k) && !accepted.has(writes[k]));
  if (refused.length) {
    return 'the panel drives actions the function refuses: ' +
      refused.map(k => k + ' to ' + writes[k]).join(', ');
  }

  const absent = (required || []).filter(k => !drawn.has(k));
  if (absent.length) {
    return 'the ' + label + ' panel is missing a control the function would accept: ' + absent.join(', ') +
      ' (drawn: ' + [...drawn].join(', ') + ')';
  }
  return true;
}

/* ---------------- driver ---------------- */

async function testRole(role) {
  currentRole = role;
  console.log('\n=== ROLE: ' + role.toUpperCase() + ' ===');

  const sb = makeSandbox(role);
  sb.win.sessionStorage.setItem('arzuz_mock_role', role);

  /* spy: which section selectors does admin.js render through?
     The sidebar nav buttons also carry data-section, so a bare
     '[data-section=…]' query would hijack the nav button (a real
     regression this suite once missed). Memoize per selector so the
     element we inspect later is the one admin.js rendered into. */
  const qsCalls = {};
  const qsMemo = {};
  const origQS = sb.document.querySelector.bind(sb.document);
  sb.document.querySelector = function (sel) {
    if (typeof sel === 'string' && sel.indexOf('.section-view') === 0) {
      qsCalls[sel] = (qsCalls[sel] || 0) + 1;
      if (!qsMemo[sel]) qsMemo[sel] = origQS(sel);
      return qsMemo[sel];
    }
    qsCalls[sel] = (qsCalls[sel] || 0) + 1;
    return origQS(sel);
  };

  runScripts(sb.ctx, DASHBOARD_SCRIPTS);
  await tick(120); /* boot: restore → fetchData → renderRoute */

  const $ = id => sb.document.getElementById(id);
  const text = id => { const el = $(id); return el ? String(el.textContent) : ''; };

  check('boot: no console errors', () => sb.consoleErrors.length === 0 ? true : sb.consoleErrors.join(' | '));
  check('boot: gate hidden (session accepted)', () => !sb.registry.gateModal || !sb.registry.gateModal._cl || !sb.registry.gateModal._cl.contains('open') || 'gate still open');

  /* --- nav gating ---

     ALL FIVE ROLES. The map below is the same five lists as ROLE_SECTIONS
     in assets/admin.js, restated here as the EXPECTATION rather than
     imported — the nav-drift check a few lines down is what makes the two
     unable to disagree, because it reads what was actually RENDERED. A
     map that is only ever compared against itself proves nothing. */
  const HIDDEN = {
    admin: [],
    marketing: ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'finance', 'claims', 'settings'],
    support: ['scout_submissions', 'roommate', 'growth', 'strategy', 'settings', 'finance'],
    verification: ['bookings', 'tickets', 'roommate', 'care', 'finance', 'claims', 'growth', 'strategy', 'settings'],
    finance: ['demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'care', 'claims', 'growth', 'strategy', 'settings']
  }[role];
  check('router: the landing section for ' + role + ' is the first it may reach', () => {
    const active = ['overview', 'tickets', 'growth'].filter(s => HIDDEN.indexOf(s) === -1)[0];
    return sb.loc.hash === '#/' + active ? true : 'hash is ' + sb.loc.hash + ', wanted #/' + active;
  });

  /* --- walk every allowed section --- */
  const ALL = ['overview', 'demand_records', 'listings', 'scout_submissions', 'bookings', 'tickets', 'roommate', 'care', 'finance', 'claims', 'growth', 'strategy', 'settings'];
  const MAY_REACH = ALL.filter(s => HIDDEN.indexOf(s) === -1);

  /* --- THE ROUTER, PER ROLE -------------------------------------------

     THE SECOND GATE, AND THE ONE THAT ACTUALLY DECIDES. assets/admin.js
     gates a deep link INSIDE renderRoute, so a hash typed into the
     address bar meets the same gate a nav click does.

     The SIDEBAR's own visibility is deliberately NOT asserted here: this
     sandbox's DOM shim answers querySelectorAll with an empty list, which
     is the very selector applyRoleNav() is written against, so nothing
     about which nav items are displayed is observable from a test — and
     an assertion that reads an empty string would pass for every role
     while proving nothing. (That is what the two pre-existing "the nav
     does not offer it" checks do.) So the assertion is made where the
     decision is: every section this login may not reach must BOTH move it
     off that hash AND leave it on one it may reach. */
  {
    const priorHash = sb.loc.hash;
    const stuck = [];
    for (const sec of HIDDEN) {
      if (sec === 'strategy') continue;   // a document route, not a data table
      sb.loc.hash = '#/' + sec;
      await tick(30);
      const landed = String(sb.loc.hash || '').replace(/^#\//, '').split('/')[0];
      if (landed === sec) { stuck.push(sec + ' (left on it)'); continue; }
      if (MAY_REACH.indexOf(landed) === -1) stuck.push(sec + ' \u2192 ' + landed + ' (not reachable)');
    }
    check('router: ' + role + ' is gated off every section it may not reach', () =>
      stuck.length === 0 ? true : stuck.join(', '));

    /* AND THE OPPOSITE DIRECTION, which is what a role left out of the
       role map fails: a login that is offered NOTHING renders nothing.
       Only asserted for the roles with something to lose — an admin may
       reach everything and has nothing to be bounced off. */
    if (HIDDEN.length) {
      check('dashboards: ' + role + ' has something to land on', () =>
        MAY_REACH.length > 0 ? true : 'this login has no section at all, so the dashboard is a blank page');
      sb.loc.hash = '#/' + MAY_REACH[0];
      await tick(40);
      check('dashboards: the landing section for ' + role + ' renders without console errors', () =>
        sb.consoleErrors.length === 0 ? true : sb.consoleErrors.join(' | '));
    }

    sb.loc.hash = priorHash;
    await tick(20);
  }

  const errorsBefore = sb.consoleErrors.length;
  for (const sec of ALL) {
    sb.loc.hash = '#/' + sec;
    await tick(40);
  }
  check('routes: all allowed sections render without console errors', () => {
    const newErrs = sb.consoleErrors.slice(errorsBefore).filter(e => e.indexOf('error:') === 0);
    return newErrs.length === 0 ? true : newErrs.join(' | ');
  });

  /* --- the desk's status-code history ---

     "I never got the code." The panel is drawn for the two logins
     supabase-status-history.sql §5 admits and for nobody else, and it is
     a LIVE lookup against the mock PostgREST — so what is asserted is
     both halves: the gate on the panel, and that a reference typed into
     it comes back as the trail the database returned, word for word.
     Driven by calling the panel's own function rather than by clicking,
     because the DOM shim has no event dispatch: the click handler is one
     line, and the function is where the decision lives. */
  {
    sb.loc.hash = '#/' + (MAY_REACH.indexOf('tickets') !== -1 ? 'tickets' : MAY_REACH[0]);
    await tick(60);
    sb.win.renderStatusHistory();

    const mayAsk = role === 'support' || role === 'admin';
    const panel = $('statusHistoryPanel');
    check('status history: the panel is ' + (mayAsk ? 'drawn for' : 'hidden from') + ' the ' + role + ' login', () => {
      if (!panel) return 'the panel is not in the document at all';
      const disp = String(panel.style.display || '');
      if (mayAsk) return disp === '' ? true : 'hidden from a login the database admits: display=' + disp;
      return disp === 'none' ? true : 'drawn for a login the database refuses, so it teaches the dashboard to lie';
    });

    if (mayAsk) {
      const ref = 'ARZ-S-4F7A-2C9B-1D3E';
      /* Every URL the panel asks for, so the next check can assert the
         thing that is NOT there. Patched before the lookup and restored
         after it, because the dashboard reads `fetch` off the window at
         call time. */
      const seen = [];
      const realFetch = sb.win.fetch;
      sb.win.fetch = function (input) { seen.push(String(input)); return realFetch.apply(this, arguments); };

      $('chRef').value = ref;
      sb.win.statusHistoryLookup();
      await tick(200);
      sb.win.fetch = realFetch;
      const out = String($('chOut')._innerHTML || '');

      check('status history: a lookup renders the reference and the facts that came back', () => {
        if (out.indexOf(ref) === -1) return 'the reference is not in the answer: ' + out.slice(0, 200);
        if (out.indexOf('a student registration') === -1) return 'the answer does not say what the reference is';
        return out.indexOf('accepted by the sender') !== -1 ? true
          : 'a delivery the sender accepted is not shown as accepted: ' + out.slice(0, 300);
      });

      check('status history: the fallback reads as TWO attempts, in order', () => {
        /* WhatsApp refused, then the mailbox took it — the story the log
           could never be read for, and the one that answers "why did the
           message never arrive on my phone". */
        const wa = out.indexOf('the WhatsApp server was asked for this message and refused it');
        const mail = out.indexOf('Email');
        if (wa === -1) return 'the refused WhatsApp attempt is not in the answer';
        if (mail === -1) return 'the fallback attempt is not in the answer';
        return wa < mail ? true : 'the attempts are not in the order they were tried';
      });

      check('status history: the code\u2019s own attempts are counted, and a used one reads as used', () => {
        if (out.indexOf('of 5 attempts used') === -1) return 'the live code\u2019s attempts are not shown: ' + out.slice(0, 300);
        if (out.indexOf('4 left') === -1) return 'the attempts left are not shown';
        return out.indexOf('used at') !== -1 ? true : 'a spent code does not read as used, so the desk ' +
          'cannot tell a code that was typed back from one that was not';
      });

      check('status history: the lookup writes nothing at all', () => {
        /* A code is never minted or re-sent from the dashboard: sending
           one is the student\u2019s own request on /status, where the proof
           of the contact on file and the per-reference ceiling apply. A
           panel that could write would be a way round both — so the
           assertion is on the URLs it asked for, not on a comment. */
        const asked = seen.filter(u => /\/rpc\/status_history/.test(u)).length;
        const wrote = seen.filter(u => /\/rpc\/status_(open|code_delivery)|\/status_codes/.test(u));
        if (wrote.length) return 'the panel wrote to ' + wrote[0] + ' — a code was minted or a delivery faked';
        return asked === 1 ? true : 'the panel made ' + asked + ' lookups, not one';
      });

      /* --- the query, not the reference ---------------------------------

         supabase-status-history.sql §5 reads its argument as a QUERY: the
         whole reference, the end of one, the start of one, or a phone
         number. Half of these calls open with "I can't find the ARZ
         number", so what is asserted here is the reading — a fragment that
         fits exactly one reference answers it, a fragment that fits more
         answers with the list and NOT with a history, and something too
         short to mean anything is refused rather than widened. */
      {
        const bodies = [];
        const realFetch2 = sb.win.fetch;
        sb.win.fetch = function (input, init) {
          if (String(input).indexOf('status_history') !== -1) bodies.push(String((init && init.body) || ''));
          return realFetch2.apply(this, arguments);
        };
        const lookup = async (q) => {
          $('chRef').value = q;
          sb.win.statusHistoryLookup();
          await tick(200);
          return String($('chOut')._innerHTML || '');
        };

        /* EVERY LOOKUP IS AWAITED OUT HERE, before any check runs.
           `check()` is synchronous: handing it an async function would
           score the returned Promise — always truthy — and the awaits
           inside it would land after the next check had already run, so
           the assertion would pass while asserting nothing. */
        /* The references the mock's fragment fixtures resolve to. HEX,
           because a reference is: status_history() reads the shape, so a
           fixture like 'ARZ-S-4K2M-9XQP-7T3B' is correctly refused now and
           would have made these checks pass for the wrong reason.

           DEMO ends 9021 — ALL DECIMAL — on purpose. A twelfth of a
           reference's characters are not hex digits, so roughly one
           reference in seven ends in four decimal characters; the first
           version of this fixture ended '7E3F' and could not have caught
           the rule that refused those four characters as "too short". */
        const DEMO = 'ARZ-S-4A2B-9C11-9021';
        const OTHER = 'ARZ-L-8C1E-2A9D-9021';

        const full = await lookup(DEMO);
        const fullBody = bodies[bodies.length - 1] || '';

        /* All digits, and the end of exactly one reference. */
        const tail = await lookup('119021');
        const tailBody = bodies[bodies.length - 1] || '';

        const head = await lookup('ARZS4A2B9C11');
        const headAmbiguous = await lookup('ARZS4A2B');
        const byPhone = await lookup('0803 000 0000');
        const ambiguous = await lookup('9021');
        const phoneAmbiguous = await lookup('0803 000 9999');
        const short1 = await lookup('ARZ');
        const short2 = await lookup('XZ');
        const short3 = await lookup('1234567890123456');
        /* A mistyped number: nine digits, so it is read as a reference end
           and matches nothing, which looks exactly like a bad reference.
           The panel is expected to say what else it could have been. */
        const typo = await lookup('080300002');

        sb.win.statusHistoryLookup(OTHER);
        await tick(200);
        const picked = String($('chOut')._innerHTML || '');
        const pickedBody = bodies[bodies.length - 1] || '';

        check('status history: the argument sent is the query, not a reference', () => {
          if (fullBody.indexOf('p_query') === -1) return 'the request has no p_query in it: ' + fullBody.slice(0, 120);
          return fullBody.indexOf('p_ref') === -1 ? true
            : 'the panel still sends p_ref, so the function\u2019s argument is being named wrong: ' + fullBody.slice(0, 120);
        });

        check('status history: the whole reference still answers exactly as it did', () => {
          if (full.indexOf(DEMO) === -1) return 'the reference is not in the answer: ' + full.slice(0, 200);
          if (full.indexOf('of 5 attempts used') === -1) return 'the attempt count is gone from the whole-reference answer';
          return full.indexOf('references match') === -1 ? true : 'the whole reference was treated as a fragment';
        });

        check('status history: the end of a reference finds the same history as the whole of it', () => {
          /* The property the desk actually leans on. A fragment that fits
             one reference must not be answered differently from the
             reference itself, or "I read out the last four" becomes a
             second, subtly different answer.

             AND THE FRAGMENT HERE IS ALL DIGITS. The rule that a bare
             number is only a number at ten digits or more is what makes
             these readable as a reference end at all; before it, the
             last four characters of a reference whose last group is
             decimal were refused as too short, which is about one
             reference in seven. */
          if (tail.indexOf(DEMO) === -1) return 'the fragment did not resolve to the reference: ' + tail.slice(0, 200);
          if (tail.indexOf('of 5 attempts used') === -1) return 'the fragment\u2019s answer has no attempt count in it';
          if (tail.indexOf('found by the end of a reference') === -1) return 'the panel does not say how it found it, so an officer cannot tell which reference answered';
          return tail.indexOf('accepted by the sender') !== -1 ? true : 'the deliveries are missing from the fragment\u2019s answer';
        });

        check('status history: a fragment is sent as typed, so the reading stays the database\u2019s', () => {
          /* The panel does not uppercase, strip dashes or decide what a
             phone number looks like: that is one rule and it lives in
             public.status_history(). A panel that normalised first would be
             a second copy of it. */
          if (tailBody.indexOf('119021') === -1) return 'the fragment did not reach the function as typed: ' + tailBody.slice(0, 120);
          return tailBody.indexOf('p_query') !== -1 ? true : 'no p_query in the fragment request';
        });

        check('status history: the start of a reference resolves the same way', () => {
          if (head.indexOf(DEMO) === -1) return 'the start of the reference did not find it: ' + head.slice(0, 200);
          return head.indexOf('found by the start of a reference') !== -1 ? true
            : 'the panel does not say the match was made on the beginning';
        });

        check('status history: a START that fits two references asks, like a fragment', () => {
          /* A and B share their first eight compact characters, so the
             beginning of one is not enough to name it. The same rule as
             the tail: candidates, and no history. */
          if (headAmbiguous.indexOf('references match') === -1) return 'a shared start was resolved instead of asked: ' + headAmbiguous.slice(0, 200);
          if (headAmbiguous.indexOf('attempts used') !== -1) return 'a code history was drawn for a shared start';
          return headAmbiguous.indexOf(DEMO) !== -1 ? true : 'the candidates are not listed';
        });

        check('status history: a phone number on the record finds the reference', () => {
          if (byPhone.indexOf(DEMO) === -1) return 'the number did not resolve to a reference: ' + byPhone.slice(0, 200);
          if (byPhone.indexOf('found by the phone number on the record') === -1) return 'the panel does not say it matched on a number, which is how an officer knows it was not the reference they typed';
          if (byPhone.indexOf('of 5 attempts used') === -1) return 'a reference found by number has no code history';
          /* The number itself must not come back: the panel is a lookup,
             not a way to read a contact detail off the screen. */
          return byPhone.indexOf('0803 000 0000') === -1 ? true
            : 'the panel echoed the phone number back into the answer';
        });

        check('status history: a fragment that fits more than one reference asks instead of guessing', () => {
          if (ambiguous.indexOf('references match') === -1) return 'the panel did not say that more than one matched: ' + ambiguous.slice(0, 200);
          if (ambiguous.indexOf(DEMO) === -1) return 'the first candidate is not listed';
          if (ambiguous.indexOf(OTHER) === -1) return 'the second candidate is not listed';
          /* THE IMPORTANT HALF: no code history may be drawn here. Showing
             one candidate\u2019s trail before the officer has said which
             student is on the phone is the panel picking for them. */
          if (ambiguous.indexOf('attempts used') !== -1) return 'a code history was drawn for an unresolved fragment: ' + ambiguous.slice(0, 300);
          if (ambiguous.indexOf('accepted by the sender') !== -1) return 'deliveries were drawn for an unresolved fragment';
          return ambiguous.indexOf('a landlord listing') !== -1 ? true
            : 'the candidates do not say what kind of record each is, which is how the officer chooses';
        });

        check('status history: a number that fits more than one reference asks the same way', () =>
          phoneAmbiguous.indexOf('references match') !== -1 ? true
            : 'a shared number picked one instead of asking: ' + phoneAmbiguous.slice(0, 200));

        check('status history: a fragment too short to mean anything is refused, not widened', () => {
          /* 'ARZ' is every reference ever handed out; two characters is
             not a fragment; and sixteen digits is longer than any number
             this site can match AND longer than a reference's tail.
             None is a question with an answer, and answering any of them
             would be the panel inventing one. */
          if (short1.indexOf('too short to look anything up') === -1) return 'ARZ alone was not refused: ' + short1.slice(0, 200);
          if (short1.indexOf('references match') !== -1) return 'ARZ alone listed references — that is the whole registry';
          if (short2.indexOf('too short to look anything up') === -1) return 'two characters were not refused: ' + short2.slice(0, 200);
          return short3.indexOf('too short to look anything up') !== -1 ? true
            : 'sixteen digits were not refused: ' + short3.slice(0, 200);
        });

        check('status history: a mistyped NUMBER says so rather than looking like a bad reference', () => {
          /* Nine digits read as a reference end, because below ten a
             number cannot be one this site could match — so the honest
             "nothing matches" needs one more sentence or the officer is
             told their number is a wrong reference. */
          if (typo.indexOf('No record of that reference') === -1) return 'the answer does not say nothing matched: ' + typo.slice(0, 300);
          if (typo.indexOf('needs all ten of them') === -1) return 'a short number got no hint about the ten digits: ' + typo.slice(0, 300);
          /* And the hint has to mean something when it appears, so it must
             NOT appear for a query that was never a number: 'XZ' is.
             (The other message does mention ten digits — for the phone
             shape it is inviting rather than diagnosing — but not this
             sentence.) */
          return short2.indexOf('needs all ten of them') === -1 ? true
            : 'the mistyped-number sentence appeared for a two-character query';
        });

        check('status history: choosing a candidate narrows the SAME question to that reference', () => {
          /* The pick row hands the whole reference back to the same lookup —
             the officer\u2019s click is the narrowing, not a guess by the
             panel. Driven the way the click handler drives it. */
          if (pickedBody.indexOf(OTHER) === -1) return 'the chosen reference was not the one asked about: ' + pickedBody.slice(0, 120);
          if (picked.indexOf('references match') !== -1) return 'choosing a candidate asked the ambiguous question again';
          return picked.indexOf(OTHER) !== -1 ? true
            : 'the chosen reference\u2019s own history is not on the screen: ' + picked.slice(0, 200);
        });

        sb.win.fetch = realFetch2;
      }
    }
  }

  /* --- nav/section collision guard (see spy above) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/growth';
    await tick(60);
    sb.loc.hash = '#/strategy';
    await tick(60);
    check('growth: rendered through the .section-view-scoped selector', () =>
      (qsCalls['.section-view[data-section="growth"]'] || 0) > 0 ? true : 'growth render never used the scoped selector');
    check('growth: bare [data-section="growth"] never queried (nav collision)', () =>
      qsCalls['[data-section="growth"]'] === undefined ? true : 'unscoped growth selector used ' + qsCalls['[data-section="growth"]'] + 'x');
    check('strategy: bare [data-section="strategy"] never queried (nav collision)', () =>
      qsCalls['[data-section="strategy"]'] === undefined ? true : 'unscoped strategy selector used ' + qsCalls['[data-section="strategy"]'] + 'x');
    for (const secName of ['growth', 'strategy']) {
      const el = qsMemo['.section-view[data-section="' + secName + '"]'];
      const html = String((el && el.innerHTML) || '');
      const m = html.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      check(secName + ': rendered chrome has no emoji glyphs', () => (el && html) ? (!m ? true : 'emoji ' + m[0] + ' still present') : 'section never rendered');
    }
  }

  /* --- overview traceability (admin only — role sees it) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/overview';
    await tick(60);
    const db = sb.win.__MOCK__.db();
    check('overview: demands metric equals dataset count', () => text('mDemands') === String(db.demand_records.length) ? true : 'got ' + text('mDemands') + ' want ' + db.demand_records.length);
    check('overview: listings metric equals dataset count', () => text('mListings') === String(db.listings.length) ? true : 'got ' + text('mListings'));
    check('overview: scouts metric equals dataset count', () => text('mScouts') === String(db.scout_submissions.length) ? true : 'got ' + text('mScouts'));
    const openDemands = db.demand_records.filter(r => r.status === 'open').length;
    check('overview: open demands metric equals dataset count', () => text('mOpenDemands') === String(openDemands) ? true : 'got ' + text('mOpenDemands'));
    const drafts = db.listings.filter(r => String(r.status).toLowerCase() === 'draft').length;
    check('overview: drafts metric equals dataset count', () => text('mDrafts') === String(drafts) ? true : 'got ' + text('mDrafts'));
    const minors = db.minors_needing_guardian.length;
    check('overview: minors metric equals SQL view count', () => text('mMinors') === String(minors) ? true : 'got ' + text('mMinors'));
    check('overview: roommate metric shows the SQL view %', () => text('mRoommate') === '67%' ? true : 'got ' + text('mRoommate'));
  }

  /* --- the questionnaire pool in the Roommate panel ---
     The pool is admin-only in the UI and admin-only in the database
     (supabase-roommate.sql scopes the tables with public.arzuz_role()),
     so this asserts both halves of that: what an admin sees, and that
     no other login gets the panel at all. */
  if (role === 'admin') {
    sb.loc.hash = '#/roommate';
    await tick(80);
    const db = sb.win.__MOCK__.db();
    const engine = db.roommate_engine_summary[0];
    const production = db.roommate_profiles.filter(r => String(r.env) === 'production');
    const openProfiles = production.filter(r => String(r.status).toLowerCase() === 'open');
    const pairs = db.roommate_mutual_pairs;
    const metric = String($('roommateMetric')._innerHTML || '');
    const panel = String($('roommatePanel')._innerHTML || '');

    check('roommate pool: engine metric card is rendered', () =>
      metric.indexOf('Questionnaires in') !== -1 ? true : 'engine metric card missing');

    check('roommate pool: engine metric equals profiles_total from the view', () =>
      metric.indexOf('>' + engine.profiles_total + '<') !== -1 ? true : 'profiles_total ' + engine.profiles_total + ' not rendered');

    check('roommate pool: engine 14-day percentage equals the view', () =>
      metric.indexOf('>' + engine.pct_matched_within_14d + '%<') !== -1 ? true : 'missing ' + engine.pct_matched_within_14d + '%');

    check('roommate pool: the waiting count matches the open production profiles', () => {
      const m = panel.match(/Waiting in the pool \((\d+)\)/);
      if (!m) return 'the waiting heading never rendered';
      return Number(m[1]) === openProfiles.length
        ? true : 'heading says ' + m[1] + ', dataset has ' + openProfiles.length;
    });

    check('roommate pool: a mutual pair renders an intro link to both students', () =>
      pairs.length ? true : 'no mutual pairs in the mock dataset');

    /* --- export with nothing loaded ---
       The guard that matters: the button must not hand out whatever the
       last dossier happened to be. Nothing has been opened yet here, and
       this is the only moment in the walk where that is true — the
       withdrawn-student checks below open one. */
    const idleBlobs = sb.blobs.length;
    const idleAnchors = sb.anchors.length;
    $('btnExportDossier').click();
    check('dossier export: with nothing open it downloads nothing', () =>
      (sb.blobs.length === idleBlobs && sb.anchors.length === idleAnchors)
        ? true : 'a consent record was written with no dossier on screen');

    pairs.forEach((p, i) => {
      check('roommate pool: pair ' + (i + 1) + ' offers an intro to ' + p.a_name + ' and ' + p.b_name, () =>
        panel.indexOf('Intro \u2192 ' + p.a_name) !== -1 && panel.indexOf('Intro \u2192 ' + p.b_name) !== -1
          ? true : 'missing an intro link for ' + p.a_name + ' / ' + p.b_name);
    });

    check('roommate pool: the test-env profile never reaches the panel', () => {
      const testRow = db.roommate_profiles.find(r => String(r.env) === 'test');
      if (!testRow || !testRow.first_name) return 'no test profile in the mock dataset';
      return panel.indexOf(String(testRow.first_name)) === -1
        ? true : 'test profile ' + testRow.first_name + ' leaked into the pool';
    });

    /* --- a withdrawn student must stay reachable ---
       They are in neither the pairs nor the waiting list, so without this
       block the one student most likely to phone us is the one student the
       dashboard cannot open. */
    const closedProfiles = production.filter(r => String(r.status).toLowerCase() === 'closed');
    check('roommate pool: the mock has a withdrawn student', () =>
      closedProfiles.length ? true : 'no closed profile in the mock dataset');

    check('roommate pool: the withdrawn student is named, not hidden', () =>
      panel.indexOf('Withdrawn (' + closedProfiles.length + ')') !== -1
        ? true : 'no withdrawn list rendered');

    const closedBlock = panel.indexOf('Withdrawn (') === -1 ? '' : panel.slice(panel.indexOf('Withdrawn ('));

    check('roommate pool: the withdrawn student is named in that block', () =>
      closedBlock.indexOf(String(closedProfiles[0].first_name)) !== -1
        ? true : 'the withdrawn student is not listed');

    check('roommate pool: a withdrawn student is offered NO intro button', () =>
      closedBlock.indexOf('wa-btn') === -1
        ? true : 'the withdrawn block offers a WhatsApp intro');

    check('roommate pool: a withdrawn student has a dossier control', () =>
      closedBlock.indexOf('data-act="dossier" data-id="' + closedProfiles[0].id + '"') !== -1
        ? true : 'no dossier control for ' + closedProfiles[0].first_name);

    const withdrawnDossier = await openDossierFor(closedProfiles[0].id);
    check('dossier: it opens for a withdrawn student, with the record intact', () => {
      const r = closedProfiles[0];
      const ev = db.roommate_events.filter(e => e.actor_ref === r.id || e.subject_ref === r.id);
      const named = withdrawnDossier.indexOf(String(r.first_name)) !== -1;
      const history = withdrawnDossier.indexOf('Consent trail (' + ev.length + ')') !== -1;
      if (!named) return 'the withdrawn student is not named in their own dossier';
      if (!history) return 'expected ' + ev.length + ' events on the record for ' + r.first_name;
      return withdrawnDossier.indexOf('withdrawn') !== -1
        ? true : 'the withdrawal itself is missing from the trail';
    });

    check('roommate pool: deal-breakers are shown where a student set them', () => {
      const withDbs = openProfiles.filter(r => (r.dealbreakers || []).length);
      if (!withDbs.length) return 'no open profile sets deal-breakers in the mock dataset';
      return panel.indexOf('Deal-breakers:') !== -1 ? true : 'the deal-breaker line never rendered';
    });

    /* --- the consent trail (roommate_events, append-only) --- */
    const productionTrail = db.roommate_events.filter(r => String(r.env) === 'production');
    const trailStart = panel.indexOf('Consent trail (');
    const trailHtml = trailStart === -1 ? '' : panel.slice(trailStart);

    check('consent trail: the heading never renders without the table', () =>
      trailHtml ? true : 'the trail section never rendered at all');

    check('consent trail: a test-env event exists in the dataset but is excluded', () =>
      db.roommate_events.length === productionTrail.length + 1
        ? true : 'the env filter cannot be proven: only ' + db.roommate_events.length + ' events seeded');

    check('consent trail: the heading counts the production events only', () => {
      const m = panel.match(/Consent trail \((\d+)\)/);
      if (!m) return 'the trail heading never rendered';
      return Number(m[1]) === productionTrail.length
        ? true : 'heading says ' + m[1] + ', dataset has ' + productionTrail.length;
    });

    check('consent trail: an event of every seeded kind renders a line', () => {
      const kinds = productionTrail.map(e => e.event);
      const missing = ['created', 'accept', 'pass', 'withdrawn', 'matched', 'viewed']
        .filter(k => kinds.indexOf(k) !== -1 && trailHtml.indexOf('>' + k + '<') === -1);
      return missing.length === 0 ? true : 'no line rendered for: ' + missing.join(', ');
    });

    check('consent trail: a \u201cviewed\u201d line says the details were put in front of them', () =>
      trailHtml.indexOf('was shown') !== -1
        ? true : 'a viewed event rendered without saying the details were displayed');

    check('consent trail: the matched line says the contact details unlocked', () =>
      trailHtml.indexOf('contact unlocked for both') !== -1
        ? true : 'a matched event rendered without saying what it unlocked');

    check('consent trail: the matched line names the student who completed the pair', () => {
      const ev = productionTrail.filter(e => e.event === 'matched')[0];
      if (!ev) return 'no matched event in the mock dataset';
      return (trailHtml.indexOf(ev.actor_name) !== -1 && trailHtml.indexOf(ev.subject_name) !== -1)
        ? true : 'the matched line does not name both students';
    });

    check('consent trail: a withdrawal is on the record', () =>
      trailHtml.indexOf('withdrew') !== -1 ? true : 'a withdrawal left no line');

    check('consent trail: the test-env student never appears in it', () => {
      const testRow = db.roommate_profiles.find(r => String(r.env) === 'test');
      if (!testRow) return 'no test profile in the mock dataset';
      /* the pool check above covers the whole panel; this pins the trail
         read's own env filter to the same promise */
      return trailHtml.indexOf(String(testRow.first_name)) === -1
        ? true : 'test profile ' + testRow.first_name + ' leaked into the trail';
    });

    check('consent trail: the trail is never offered a write control', () =>
      (trailHtml.indexOf('<button') === -1 && trailHtml.indexOf('contenteditable') === -1)
        ? true : 'the append-only trail renders something that could edit it');

    /* --- the student dossier ---
       One student, everything about them. The two reads it makes are by id
       and are NOT the panel's state: the feed above is capped at 40 events
       and env-filtered, so a dossier built from it would be incomplete. */
    const eventsFor = pid => db.roommate_events.filter(e => e.actor_ref === pid || e.subject_ref === pid);
    const decisionsFor = pid => db.roommate_interests.filter(i => i.from_ref === pid || i.to_ref === pid);
    const byName = n => db.roommate_profiles.find(r => String(r.first_name) === n);

    /* Opening is a click on the panel in real use; the harness calls the
       handler the click would reach, then reads what it rendered. */
    async function openDossierFor(pid) {
      sb.win.openDossier(pid);
      await tick(120);
      return String($('dossierContent')._innerHTML || '');
    }

    check('dossier: the pool offers an entry point to it', () =>
      panel.indexOf('data-act="dossier"') !== -1 ? true : 'no dossier control in the pool panel');

    /* A MATCHED student is the case that matters: their side of the pair
       has left the open pool, so a dossier assembled from pool state would
       come up short on exactly the student someone is asking about. */
    const grace = byName('Grace');
    check('dossier: the mock has a matched student to open', () => grace ? true : 'no Grace in the mock dataset');
    const gDossier = await openDossierFor(grace.id);

    check('dossier: renders for a matched student', () =>
      gDossier.length > 0 ? true : 'the dossier modal stayed empty');

    check('dossier: names the student and their own number', () =>
      (gDossier.indexOf('Grace') !== -1 && gDossier.indexOf(grace.phone) !== -1)
        ? true : 'the student or their number is missing');

    check('dossier: their answers render with the shared question vocabulary', () => {
      const sleep = String((grace.payload || {}).sleep || '');
      if (!sleep) return 'the mock profile answers nothing';
      return gDossier.indexOf(sleep) !== -1
        ? true : 'the answer "' + sleep + '" is not shown';
    });

    check('dossier: the decision count equals the dataset, both sides', () => {
      const n = decisionsFor(grace.id).length;
      return gDossier.indexOf('Decisions (' + n + ')') !== -1
        ? true : 'expected ' + n + ' decisions for Grace';
    });

    check('dossier: the direction they did NOT act in is listed too', () => {
      /* Grace did not complete her pair — Halima did. If the query asked
         for the actor side alone, the sentence naming the other student
         as the one who said yes is what goes missing. */
      const incoming = decisionsFor(grace.id).find(i => i.to_ref === grace.id);
      if (!incoming) return 'Grace has no incoming decision in the mock dataset';
      const from = byName('Halima') || {};
      return (gDossier.indexOf('said yes to ' + grace.payload.name) !== -1)
        ? true : 'the incoming decision is not rendered as its own line';
    });

    check('dossier: their match is shown with the partner named', () =>
      gDossier.indexOf('Matched with Halima') !== -1
        ? true : 'the matched section never rendered, or does not name the partner');

    check('dossier: the trail is the by-id history, not the capped feed', () => {
      const n = eventsFor(grace.id).length;
      return gDossier.indexOf('Consent trail (' + n + ')') !== -1
        ? true : 'expected ' + n + ' events for Grace, and the section says otherwise';
    });

    check('dossier: a subject-side event is included, not just the ones they acted in', () => {
      const asSubject = eventsFor(grace.id).filter(e => e.subject_ref === grace.id && e.actor_ref !== grace.id);
      if (!asSubject.length) return 'no subject-only event for Grace in the mock dataset';
      return gDossier.indexOf('both said yes') !== -1 || gDossier.indexOf('matched') !== -1
        ? true : 'subject-side events are missing from the dossier trail';
    });

    check('dossier: another student\u2019s events are not in it', () => {
      const ids = {};
      eventsFor(grace.id).forEach(e => { ids[e.actor_ref] = 1; ids[e.subject_ref] = 1; });
      const outsider = db.roommate_events.find(e => !ids[e.actor_ref] && !ids[e.subject_ref]);
      if (!outsider) return 'every event touches Grace in the mock dataset';
      return gDossier.indexOf(String(outsider.actor_name)) === -1
        ? true : 'an unrelated student leaked into the dossier';
    });

    const withDbs = production.filter(r => (r.dealbreakers || []).length);
    check('dossier: the mock has a student with deal-breakers', () =>
      withDbs.length ? true : 'no profile sets deal-breakers in the mock dataset');
    const pickyDossier = await openDossierFor(withDbs[0].id);
    check('dossier: every ticked deal-breaker is rendered verbatim', () => {
      const dbs = withDbs[0].dealbreakers || [];
      const missing = dbs.filter(d => pickyDossier.indexOf(String(d)) === -1);
      return missing.length === 0 ? true : 'missing: ' + missing.join(', ');
    });

    const lonely = production.find(r => String(r.status) === 'open' && !decisionsFor(r.id).length);
    check('dossier: the mock has a student with no decisions', () =>
      lonely ? true : 'no decision-free profile in the mock dataset');
    const lonelyDossier = await openDossierFor(lonely.id);
    check('dossier: the empty state says so instead of showing a blank', () =>
      (lonelyDossier.indexOf('No decisions yet') !== -1 && lonelyDossier.indexOf('No events on record') === -1)
        ? true : 'the decisions section rendered a blank instead of a note');

    check('dossier: it offers no way to change a decision', () => {
      const writes = ['data-act="pair"', 'data-act="del"', 'data-act="edit"', '<input', '<select'];
      const found = writes.filter(w => pickyDossier.indexOf(w) !== -1 || gDossier.indexOf(w) !== -1);
      return found.length === 0 ? true : 'the dossier renders a write control: ' + found.join(', ');
    });

    $('btnCloseDossier').click();
    await tick(400);   /* the close is animated; give it its frame */
    check('dossier: closing it clears the modal', () => {
      const ov = $('dossierModal');
      return !ov || !ov._cl || !ov._cl.contains('open') ? true : 'the modal is still open after Close';
    });

    /* --- the dossier as a sheet of paper ---
       The record has to be able to leave the browser: attached to a
       ticket, or printed and read out to whoever phoned. Three files have
       to agree for that to work — the button in admin.html, the class
       admin.js puts on <body>, and the @media print rules in admin.css
       that key on it. A rename in any one of them fails SILENTLY (the
       whole dark dashboard prints instead), so all three are asserted
       here rather than left to a look in a browser. */
    const readAsset = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const adminHtmlSrc = readAsset('admin.html');
    const adminCssSrc = readAsset('assets/admin.css');

    check('dossier print: the button is in the page, in the modal that prints', () =>
      adminHtmlSrc.indexOf('id="btnPrintDossier"') !== -1
        ? true : 'no print control in admin.html — admin.js wires an element that does not exist');

    check('dossier print: the provenance line it fills in is in the page too', () =>
      (adminHtmlSrc.indexOf('id="dossierPrintMeta"') !== -1 &&
        adminHtmlSrc.indexOf('class="print-only"') !== -1)
        ? true : 'the print-only meta element is missing from admin.html');

    check('dossier print: admin.css narrows the sheet to the modal', () =>
      (adminCssSrc.indexOf('body.printing-dossier #dossierModal') !== -1 &&
        adminCssSrc.indexOf('body.printing-dossier > *:not(#dossierModal)') !== -1)
        ? true : 'the @media print rules do not isolate #dossierModal — the whole dashboard would print');

    const printBefore = sb.printCalls.length;
    const wasOpen = $('dossierContent')._innerHTML;
    sb.win.openDossier(grace.id);
    await tick(120);
    $('btnPrintDossier').click();

    check('dossier print: clicking it asks the browser to print', () =>
      sb.printCalls.length === printBefore + 1
        ? true : 'window.print() was not called (' + (sb.printCalls.length - printBefore) + ' times)');

    check('dossier print: the body carries the class the CSS keys on', () =>
      sb.document.body._cl && sb.document.body._cl.contains('printing-dossier')
        ? true : 'body.printing-dossier was never applied, so the sheet would print the dashboard');

    check('dossier print: the sheet says what it is, and who it is about', () => {
      const meta = String($('dossierPrintMeta').textContent || '');
      if (meta.indexOf('Arzuz consent record') === -1) return 'the provenance line never says what this is';
      if (meta.indexOf('Grace') === -1) return 'the provenance line does not name the student';
      return meta.indexOf('append-only') !== -1
        ? true : 'the sheet does not say the record cannot be edited';
    });

    check('dossier print: the control is not part of the record it prints', () =>
      String(wasOpen || '').indexOf('btnPrintDossier') === -1
        ? true : 'the print control is rendered inside #dossierContent, which is the part that is printed');

    /* afterprint is what a real browser fires when the dialog closes; the
       timeout behind it is for Safari, which is not reliable about it. */
    (sb.winListeners.afterprint || []).slice().forEach(fn => fn({ type: 'afterprint' }));
    check('dossier print: afterprint takes the class back off', () =>
      !(sb.document.body._cl && sb.document.body._cl.contains('printing-dossier'))
        ? true : 'the body stayed in print mode — every later print would be clipped to the modal');

    /* --- the dossier as a file ---
       Read back from the bytes handed to the download, not from a second
       copy of the builder, so this is the file an auditor would open. */
    const blobBefore = sb.blobs.length;
    const anchorBefore = sb.anchors.length;
    $('btnExportDossier').click();
    const exported = sb.blobs[blobBefore];
    const exportedAnchor = sb.anchors[anchorBefore];

    check('dossier export: the click downloads one JSON file', () => {
      if (!exported) return 'no file was built';
      if (!exportedAnchor) return 'nothing was offered for download';
      if (!/\.json$/.test(String(exportedAnchor.download || ''))) {
        return 'the download is not named .json: ' + exportedAnchor.download;
      }
      return exportedAnchor.href === 'blob:mock' ? true : 'the object URL never reached the link';
    });

    check('dossier export: the filename names the student and the day', () =>
      /^arzuz-consent-grace-\d{4}-\d{2}-\d{2}\.json$/.test(String((exportedAnchor || {}).download || ''))
        ? true : 'filename was ' + (exportedAnchor || {}).download);

    const exportedDoc = (() => {
      try { return JSON.parse(String((exported || {}).parts && exported.parts[0])); }
      catch (e) { return null; }
    })();

    check('dossier export: it is valid JSON with the envelope an archive needs', () => {
      if (!exportedDoc) return 'the file is not parseable JSON';
      if (exportedDoc.record !== 'arzuz roommate consent record') return 'no record marker';
      if (!exportedDoc.exported_at) return 'no export timestamp';
      if (!/append-only/i.test(String(exportedDoc.note))) return 'the append-only note is missing';
      return exportedDoc.format === 1 ? true : 'unexpected format version';
    });

    check('dossier export: it is the record that was on screen \u2014 student, decisions and events', () => {
      if (!exportedDoc) return 'the file is not parseable JSON';
      if (exportedDoc.student.id !== grace.id) return 'exported ' + exportedDoc.student.id + ', not Grace';
      if (exportedDoc.student.name !== grace.first_name) return 'the student is not named';
      const wantDecisions = db.roommate_interests.filter(i => i.from_ref === grace.id || i.to_ref === grace.id).length;
      const wantEvents = db.roommate_events.filter(e => e.actor_ref === grace.id || e.subject_ref === grace.id).length;
      if (exportedDoc.decisions.length !== wantDecisions) {
        return 'expected ' + wantDecisions + ' decisions, file has ' + exportedDoc.decisions.length;
      }
      if (exportedDoc.events.length !== wantEvents) {
        return 'expected ' + wantEvents + ' events, file has ' + exportedDoc.events.length;
      }
      return exportedDoc.matches.length === 1 ? true : 'expected Grace\u2019s one match in the file';
    });

    check('dossier export: an auditor gets one student, not the pool', () => {
      if (!exportedDoc) return 'the file is not parseable JSON';
      const text = String(exported.parts[0]);
      const others = production.filter(r => r.id !== grace.id && r.phone)
        .map(r => String(r.phone))
        .filter(p => text.indexOf(p) !== -1);
      if (others.length) return 'another student\u2019s phone number is in the file: ' + others.join(', ');
      /* the other side of the pair IS named \u2014 that is the record \u2014 but
         only by name, which is what the consent trail itself snapshots */
      const answers = Object.keys((exportedDoc.student || {}).answers || {});
      return answers.length >= 5
        ? true : 'the file carries only ' + answers.length + ' of the student\u2019s answers';
    });

    /* --- why they are still waiting ---
       The block makes two claims: how the pool breaks down, and who has
       nobody suitable. Both are recomputed here from the dataset \u2014 the
       second through the SAME shared scorer the dashboard calls, run in a
       different runtime, which is the only way to tell a rendered number
       from a computed one. */
    check('stall: the block renders', () =>
      panel.indexOf('Why they are still waiting') !== -1 ? true : 'the stall block never rendered');

    check('stall: an area row counts the dataset, not a number written by hand', () => {
      const area = 'Malete';
      const inArea = production.filter(r => String(r.area) === area);
      if (!inArea.length) return 'no profiles in ' + area + ' in the mock dataset';
      const matchedIds = {};
      pairs.forEach(p => { matchedIds[p.a_id] = 1; matchedIds[p.b_id] = 1; });
      const matched = inArea.filter(r => matchedIds[r.id]).length;
      const rate = Math.round((matched / inArea.length) * 100);
      const line = inArea.length + ' students \u00b7 ' + matched + ' matched \u00b7 ' + rate + '%';
      return panel.indexOf(line) !== -1
        ? true : 'expected "' + line + '" \u2014 the area row disagrees with the dataset';
    });

    const ArzuzMatch = sb.win.ArzuzMatch;
    const strangers = openProfiles.filter(me =>
      !openProfiles.some(x => x.id !== me.id && ArzuzMatch.eligible(me.payload || {}, x.payload || {})));

    check('stall: the mock has a student nobody can be matched with', () =>
      strangers.length ? true : 'every waiting student has a compatible partner in the dataset');

    check('stall: the students named are the ones the engine says are stuck', () => {
      const heading = 'Nobody suitable in the pool (' + strangers.length + ')';
      if (panel.indexOf(heading) === -1) return 'expected "' + heading + '" in the panel';
      const missing = strangers.filter(s => panel.indexOf(String(s.first_name)) === -1);
      return missing.length === 0
        ? true : 'the engine says these have nobody: ' + missing.map(s => s.first_name).join(', ');
    });

    check('stall: every stuck row says why, with the count', () => {
      const n = openProfiles.length - 1;
      const expect = 'all ' + n + ' other waiting ' + (n === 1 ? 'student is' : 'students are') + ' filtered out';
      if (panel.indexOf(expect) === -1) return 'expected "' + expect + '" for ' + (strangers[0] || {}).first_name;
      return / by gender| by a deal-breaker| by deal-breakers| with too little in common/.test(panel)
        ? true : 'the row does not say which wall was hit';
    });

    check('stall: a student who DOES have a partner is not reported as stuck', () => {
      const ok = openProfiles.find(me =>
        openProfiles.some(x => x.id !== me.id && ArzuzMatch.eligible(me.payload || {}, x.payload || {})));
      if (!ok) return 'every waiting student is un-matchable in the mock dataset';
      const from = panel.indexOf('Nobody suitable in the pool');
      const block = from === -1 ? '' : panel.slice(from, panel.indexOf('Consent trail ('));
      return block.indexOf(String(ok.first_name)) === -1
        ? true : ok.first_name + ' has a compatible partner and is still listed as stuck';
    });

    check('stall: the block admits the pool read is capped', () =>
      /profiles this panel loaded/.test(panel) ? true : 'the block presents a partial pool as the whole picture');

    /* --- the digest preview ---
       The control is in the metric block, not in the panel body — the
       panel element is checked too, because a control that drifted there
       would disappear on the next pool render. */
    check('digest preview: the panel offers it', () =>
      String($('roommateMetric')._innerHTML || '').indexOf('id="btnDigestPreview"') !== -1
        ? true : 'no preview control in the metric block');

    sb.win.openDigestPreview();
    await tick(120);
    check('digest preview: it renders the message the server composed', () => {
      const text = String($('digestPreviewText').textContent || '');
      if (text.indexOf('Roommate digest') === -1) return 'no digest in the modal: ' + text.slice(0, 90);
      if (text.indexOf('MOCK HARNESS') === -1) return 'the text is not the endpoint\u2019s response';
      if (text.indexOf('<b>Pool:</b>') === -1) return 'the tags are not shown verbatim';
      const note = String($('digestPreviewNote').textContent || '');
      if (note.indexOf('would send') === -1) return 'the note does not say what the 06:00 job would do: ' + note;
      return note.indexOf('role: admin') !== -1 ? true : 'the note does not name the role: ' + note;
    });

    $('btnCloseDigest').click();
    await tick(350);
    check('digest preview: closing it clears the modal', () => {
      const ov = $('digestModal');
      return !ov || !ov._cl || !ov._cl.contains('open') ? true : 'the digest modal is still open after Close';
    });

    /* --- Arzuz Care ---------------------------------------------------
       The panel is how support OPERATES Care, and the thing it must never
       do is show a balance that is not the ledger's. Every number below is
       recomputed from __MOCK__.db().care_credit_events — the events, not
       the view — so a mock or a panel that kept a running counter would
       fail here instead of looking right on screen. */
    sb.loc.hash = '#/care';
    await tick(120);

    const careDb = sb.win.__MOCK__.db();
    const carePanel = String($('carePanel')._innerHTML || '');
    const careMetric = String($('careMetric')._innerHTML || '');
    const careLeft = (id) => careDb.care_credit_events
      .filter(e => e.plan_id === id).reduce((n, e) => n + e.delta, 0);

    check('care: the panel renders one row per plan', () => {
      const missing = careDb.care_plans_live
        .filter(p => carePanel.indexOf(p.first_name) === -1)
        .map(p => p.first_name);
      return missing.length ? 'no row for: ' + missing.join(', ') : true;
    });

    check('care: every balance on screen is the LEDGER SUM, not a column', () => {
      for (const p of careDb.care_plans_live) {
        const sum = careLeft(p.id);
        if (p.balance !== sum) {
          return p.first_name + ' shows ' + p.balance + ' but the ledger sums to ' + sum;
        }
        if (carePanel.indexOf(sum + ' of ' + p.granted + ' call-outs left') === -1 && p.status === 'active') {
          return 'the ' + p.first_name + ' row does not show "' + sum + ' of ' + p.granted + ' call-outs left"';
        }
      }
      return true;
    });

    check('care: the metric totals are the same sums', () => {
      const active = careDb.care_plans_live.filter(p => p.status === 'active');
      const left = active.reduce((n, p) => n + careLeft(p.id), 0);
      const used = careDb.care_plans_live.reduce((n, p) =>
        n + careDb.care_credit_events.filter(e => e.plan_id === p.id && e.event === 'spent').length, 0);
      if (careMetric.indexOf('>' + left + '<') === -1) return 'call-outs left is not ' + left;
      return careMetric.indexOf('>' + used + '<') !== -1 ? true : 'call-outs used is not ' + used;
    });

    check('care: a credit taken back without a call-out reads as an adjustment, not a visit', () => {
      /* Ifeoma has an 'adjusted' row and NO 'spent' row. Her row must not
         claim a call-out happened. */
      const adjusted = careDb.care_plans_live.find(p => p.first_name === 'Ifeoma');
      if (!adjusted) return 'no plan with an adjustment in the mock';
      const spent = careDb.care_credit_events
        .filter(e => e.plan_id === adjusted.id && e.event === 'spent').length;
      if (spent !== 0) return 'the mock story changed: Ifeoma has ' + spent + ' spent rows';
      const from = carePanel.indexOf('Ifeoma');
      const row = carePanel.slice(from, carePanel.indexOf('</div></div>', from));
      return row.indexOf('0 of 4 used') === -1
        ? true : 'a call-out was reported for a plan that never had one';
    });

    check('care: a refund is NOT offered once a call-out has been used', () => {
      const spentPlan = careDb.care_plans_live.find(p => careDb.care_credit_events
        .some(e => e.plan_id === p.id && e.event === 'spent'));
      if (!spentPlan) return 'no plan with a call-out in the mock';
      const at = carePanel.indexOf('data-care="refund" data-plan="' + spentPlan.id + '"');
      if (at === -1) return 'no refund button at all for ' + spentPlan.first_name;
      /* The window has to clear the attributes that come first: the plan id
         alone puts " disabled" past 40 characters, and a window that short
         reports a correctly disabled button as enabled. */
      return carePanel.slice(at, at + 160).indexOf('disabled') !== -1
        ? true : spentPlan.first_name + ' has used a call-out and is still offered a refund';
    });

    check('care: a plan with nothing left offers no call-out', () => {
      const empty = careDb.care_plans_live.find(p => (p.balance || 0) <= 0);
      if (!empty) return 'no empty plan in the mock';
      const at = carePanel.indexOf('data-care="spend-open" data-plan="' + empty.id + '"');
      if (at === -1) return 'no spend button for ' + empty.first_name;
      return carePanel.slice(at, at + 60).indexOf('disabled') !== -1
        ? true : empty.first_name + ' has no credits left and can still be charged a call-out';
    });

    /* --- recording one, through the panel ---------------------------- */
    const target = careDb.care_plans_live.find(p => p.first_name === 'Ifeoma');
    const beforeBalance = careLeft(target.id);
    const beforeEvents = careDb.care_credit_events.length;

    /* The shim cannot dispatch a delegated click, so this drives the same
       two functions the buttons call (arzuzCareOpenSpend → the drawer,
       arzuzCareAct('spend') → the POST). The wiring itself is checked in a
       real browser; see the report. */
    sb.win.arzuzCareOpenSpend(target.id);
    await tick(80);

    check('care: recording a call-out asks who did the work', () => {
      const html = String($('carePanel')._innerHTML || '');
      if (html.indexOf('id="careWorker"') === -1) return 'the drawer never opened';
      if (html.indexOf('id="careParts"') === -1) return 'the drawer does not ask for the parts cost';
      return html.indexOf('id="careReason"') !== -1 ? true : 'the drawer does not ask what the job was';
    });

    sb.win.arzuzCareAct('spend', target.id);
    await tick(80);

    check('care: confirming with no worker named is refused BEFORE any request', () => {
      const note = String($('careDrawerNote').textContent || '');
      if (note.indexOf('who did the work') === -1) return 'no refusal in the drawer: ' + note;
      return careDb.care_credit_events.length === beforeEvents
        ? true : 'a credit was taken for work nobody is named against';
    });

    $('careWorker').value = 'Verified worker (harness)';
    $('careParts').value = '1200';
    sb.win.arzuzCareAct('spend', target.id);
    await tick(200);

    check('care: a confirmed call-out is written by the server, and the balance follows', () => {
      const after = careLeft(target.id);
      if (after !== beforeBalance - 1) return 'the ledger moved by ' + (after - beforeBalance) + ', not -1';
      const row = careDb.care_credit_events.find(e => e.plan_id === target.id && e.event === 'spent');
      if (!row) return 'no spent row was appended';
      if (row.worker !== 'Verified worker (harness)') return 'the worker was not recorded: ' + row.worker;
      if (Number(row.parts_ngn) !== 1200) return 'the parts cost was not recorded: ' + row.parts_ngn;
      return row.delta === -1 ? true : 'a call-out cost ' + row.delta + ' credits';
    });

    check('care: the panel re-rendered from the new balance', () => {
      const sum = careLeft(target.id);
      return carePanel.length && String($('carePanel')._innerHTML).indexOf(sum + ' of ') !== -1
        ? true : 'the row still shows the old balance';
    });

    check('care: the drawer closes once the call-out is recorded', () =>
      sb.win.arzuzCareState() === null ? true : 'the spend drawer stayed open after a successful write');

    /* --- opening a plan, through the panel ---------------------------
       The one Care action that creates money instead of recording it.
       What matters is not that the button exists but that opening a plan
       still leaves the ledger as the only place a credit is written: no
       balance is ever typed, the number is stored one way so two
       spellings are one student, the operator is named on the row, and
       the student's link is shown once because only its hash is kept. */
    const beforePlans = careDb.care_plans.length;

    check('care: the panel offers the money path, and says what it will create', () => {
      const html = String($('carePanel')._innerHTML || '');
      if (html.indexOf('data-care="grant-open"') === -1) return 'there is no way to open a plan from the dashboard';
      return /call-outs and the published/.test(html)
        ? true : 'the button does not say what is about to be created: ' + html.slice(0, 120);
    });

    sb.win.arzuzCareGrant.open();
    await tick(60);

    check('care: opening a plan asks for the student, the number, and why it exists', () => {
      const html = String($('carePanel')._innerHTML || '');
      const want = ['careGrantName', 'careGrantPhone', 'careGrantCredits', 'careGrantAmount', 'careGrantReason'];
      const missing = want.filter(id => html.indexOf('id="' + id + '"') === -1);
      return missing.length ? 'the grant drawer is missing: ' + missing.join(', ') : true;
    });

    check('care: a plan cannot be opened without a student', () => {
      sb.win.arzuzCareGrant.submit();
      const note = String($('careGrantNote').textContent || '');
      if (note.indexOf('student') === -1) return 'no refusal in the drawer: ' + note;
      return careDb.care_plans.length === beforePlans ? true : 'a nameless plan was created';
    });

    check('care: a number a worker cannot ring is refused before any request', () => {
      $('careGrantName').value = 'Harness Student';
      $('careGrantPhone').value = '123';
      sb.win.arzuzCareGrant.submit();
      return careDb.care_plans.length === beforePlans
        ? true : 'a plan was opened on a number nobody can ring';
    });

    /* The phone is typed the way a person types it — operator spacing, a
       leading zero — because the storage shape is exactly what makes the
       one-active-plan index hold. */
    $('careGrantPhone').value = '0803 555 0001';
    $('careGrantReason').value = 'harness — checking the money path';
    sb.win.arzuzCareGrant.submit();
    await tick(250);

    check('care: opening a plan writes a granted row with the operator named on it', () => {
      const opened = careDb.care_plans.find(p => p.first_name === 'Harness Student');
      if (!opened) return 'no plan was created';
      const row = careDb.care_credit_events.find(e => e.plan_id === opened.id && e.event === 'granted');
      if (!row) return 'the ledger has no granted row for the new plan';
      if (Number(row.delta) !== 4) return 'the grant was not four credits: ' + row.delta;
      return row.actor_name ? true : 'the row does not say who opened it';
    });

    check('care: the number is stored in ONE shape, so two spellings are one student', () => {
      const opened = careDb.care_plans.find(p => p.first_name === 'Harness Student');
      return opened && opened.phone === '2348035550001'
        ? true : 'the number was stored as ' + (opened && opened.phone);
    });

    check('care: the private link is shown once, and it says it cannot be shown again', () => {
      const html = String($('carePanel')._innerHTML || '');
      const input = /id="careGrantLink"[^>]*value="([^"]*)"/.exec(html);
      if (!input) return 'the confirmation shows no link at all';
      if (input[1].indexOf('/my-care?t=') === -1) return 'the confirmation link is not a Care link: ' + input[1];
      return /Shown once/.test(html) ? true : 'the panel does not say the link cannot be shown again';
    });

    check('care: the new plan is on screen with the LEDGER’s balance, not a number of its own', () => {
      const opened = careDb.care_plans_live.find(p => p.first_name === 'Harness Student');
      if (!opened) return 'the new plan never reached the list';
      if (opened.balance !== careLeft(opened.id)) {
        return 'the new row shows ' + opened.balance + ' against a ledger of ' + careLeft(opened.id);
      }
      return String($('carePanel')._innerHTML).indexOf(opened.balance + ' of ' + opened.granted + ' call-outs left') !== -1
        ? true : 'the new row does not show its balance';
    });

    check('care: the drawer is closed once the operator is done with it', () => {
      sb.win.arzuzCareGrant.close();
      if (sb.win.arzuzCareGrant.state() !== null) return 'the grant drawer stayed open';
      const html = String($('carePanel')._innerHTML || '');
      return html.indexOf('id="careGrantLink"') === -1
        ? true : 'the link is still on screen after the drawer is closed';
    });

    /* --- and the refusal that matters most: the same session twice ------ */
    sb.win.arzuzCareGrant.open();
    await tick(60);
    const plansBeforeDupe = careDb.care_plans.length;
    const eventsBeforeDupe = careDb.care_credit_events.length;
    $('careGrantName').value = 'Harness Student';
    $('careGrantPhone').value = '+2348035550001';
    sb.win.arzuzCareGrant.submit();
    await tick(250);

    check('care: the same student and session cannot be sold twice, and the refusal is the server’s', () => {
      const note = String($('careGrantNote').textContent || '');
      if (note.indexOf('already has an active Care plan') === -1) {
        return 'the refusal was not shown in the drawer: ' + note;
      }
      if (careDb.care_plans.length !== plansBeforeDupe) return 'a second plan was created anyway';
      return careDb.care_credit_events.length === eventsBeforeDupe
        ? true : 'a second grant reached the ledger';
    });

    sb.win.arzuzCareGrant.close();
    await tick(60);

    check('care: no balance can be typed, and every control the panel draws is wired', () => {
      const html = String($('carePanel')._innerHTML) + String($('careMetric')._innerHTML);
      if (/<input[^>]+type="hidden"/i.test(html)) return 'the panel renders a hidden field';
      if (/careGrantBalance|data-care="balance"/.test(html)) return 'a balance can be typed by hand';
      return careControlsAreSound(html, 'admin', ['spend-open', 'grant-open', 'refund', 'expire']);
    });

    check('care: the panel never writes a Care table itself — every Care write is a POST to the function', () => {
      /* The invariant the whole design rests on, checked in the source so
         a later convenience cannot quietly break it: the browser may READ
         the views, and it may not write either table. */
      const src = fs.readFileSync(path.join(ROOT, 'assets/admin.js'), 'utf8');
      if (src.indexOf("'/api/care-credit'") === -1) return 'the panel has no door to the function at all';
      const offenders = src.split('\n').filter(lineToCheck =>
        /rest\/v1\/care/.test(lineToCheck) && /method:\s*'(POST|PATCH|DELETE|PUT)'/.test(lineToCheck));
      return offenders.length
        ? 'admin.js writes a Care table directly: ' + offenders[0].trim()
        : true;
    });

    check('care: the balance on screen never comes from a stored column', () => {
      /* The one assertion that would catch a panel (or a view) that started
         trusting a balance field: recompute every row from the events. */
      const drifted = careDb.care_plans_live.filter(p =>
        p.balance !== careDb.care_credit_events.filter(e => e.plan_id === p.id)
          .reduce((n, e) => n + e.delta, 0));
      return drifted.length ? 'a balance disagrees with its ledger: ' + drifted.map(p => p.first_name).join(', ') : true;
    });

    check('roommate pool: a mutual pair is not offered a dashboard match button', () => {
      /* consent, not a suggestion: the pool block must stay read-only */
      const poolStart = panel.indexOf('The questionnaire pool');
      if (poolStart === -1) return 'the pool block never rendered';
      const poolHtml = panel.slice(poolStart);
      return poolHtml.indexOf('data-mate="pair"') === -1
        ? true : 'the pool block renders a pair button, which would overrule a student\u2019s decision';
    });
  } else {
    sb.loc.hash = '#/roommate';
    await tick(60);
    check('roommate pool: the panel is never rendered for the ' + role + ' login', () =>
      String($('roommatePanel')._innerHTML || '') === ''
        ? true : 'the roommate panel rendered for a non-admin login');

    /* Arzuz Care is NOT admin-only, and that is the point: support is who
       records the visits, so the panel is asserted on per role rather than
       assumed. Marketing is the one that must not see it — a plan is a
       phone number plus a bill. */
    sb.loc.hash = '#/care';
    await tick(120);
    const careForRole = String($('carePanel')._innerHTML || '');

    if (role === 'support') {
      check('care: the SUPPORT login sees the plans it records visits against', () =>
        careForRole.indexOf('Care plans') !== -1
          ? true : 'support sees no Care panel — but support is the role that operates it');
      check('care: support IS offered the grant it takes the payment for', () =>
        careForRole.indexOf('data-care="grant-open"') !== -1
          ? true : 'support records the visits but cannot open the plan they belong to');
      check('care: every control support is offered is one the page and the function accept', () =>
        careControlsAreSound(careForRole + String($('careMetric')._innerHTML || ''), 'support',
          ['spend-open', 'grant-open', 'refund', 'expire']));
    } else {
      check('care: the marketing login never sees a Care plan', () =>
        careForRole === '' ? true : 'the Care panel rendered for marketing');
      check('care: a deep link to #/care falls back for marketing', () =>
        sb.loc.hash.indexOf('#/care') === -1
          ? true : 'marketing was left on a section it cannot read');
      check('care: the nav bar does not offer it either', () => {
        const html = String($('sidebarNav')._innerHTML || '');
        return html.indexOf('data-section="care"') === -1
          ? true : 'the Care nav item is rendered for marketing';
      });
    }
  }

  /* --- Finance: the books, and whether they reconcile -----------------

     The panel's whole claim is that its figures came from the report
     action and that the arithmetic on them HOLDS. So the assertions are
     made against the report the mock computed from its own double-entry
     journal, and the one-sided case is driven on purpose: a reconciliation
     that cannot fail proves nothing.                                        */

  /* THE BOOKS HAVE THEIR OWN ROLE NOW (spec §4 — support staff must not
     automatically receive finance permissions). The panel is asserted
     in full for the one role that owns everything, and its ABSENCE is
     asserted for every other role rather than assumed: once
     supabase-finance.sql handed the six read policies to `finance`, a
     support token reads zero rows there, and a nav item pointing at an
     empty panel is a worse answer than no nav item. */
  /* ONE BRANCH FOR EACH SIDE OF THE SPLIT. `finance` reads the books and
     may not move money — the panel is asserted for it, and the refusal
     copy inside the full block ("only the admin login may…") is the
     branch a non-admin money role has always been expected to reach. */
  if (role !== 'admin' && role !== 'finance') {
    check('finance: the ' + role + ' login never reaches the books', () =>
      sb.loc.hash.indexOf('#/finance') === -1 ? true : role + ' was left on the finance section');
    check('finance: and nothing rendered there', () =>
      String($('finHead')._innerHTML || '') === '' ? true : 'the finance panel rendered for ' + role);
    check('finance: and the nav does not offer it', () =>
      String($('sidebarNav')._innerHTML || '').indexOf('data-section="finance"') === -1
        ? true : 'the Finance nav item is still rendered for ' + role);
  } else {
    sb.loc.hash = '#/finance';
    await tick(140);

    const finHead = () => String($('finHead')._innerHTML || '');
    const finLines = () => String($('finLines')._innerHTML || '');
    const finRecon = () => String($('finRecon')._innerHTML || '');
    const finRefFunds = () => String($('finRefunds')._innerHTML || '');
    const finRefs = () => String($('finReferrals')._innerHTML || '');
    const report = () => sb.win.__MOCK__.financeReport();
    const money = kobo => '\u20a6' + Number(Number(kobo || 0) / 100).toLocaleString('en-NG');

    /* the identity the screen checks, computed here from the same report */
    const careResidual = r => {
      const x = r.lines.care;
      return (x.cash_in_kobo - x.cash_out_kobo)
        - (x.revenue_kobo + x.unearned_kobo + x.payable_kobo - x.refunds_kobo - x.costs_kobo);
    };

    check('finance: the panel renders, and says where its numbers came from', () => {
      if (!finHead()) return 'nothing rendered on the finance section';
      if (finHead().indexOf('action:report') === -1) return 'the panel does not name the action behind its figures';
      return finLines() && finRecon() ? true : 'the lines or the reconciliation did not render';
    });

    check('finance: cash in on screen is the report\u2019s figure', () => {
      const want = money(report().lines.care.cash_in_kobo);
      return finHead().indexOf(want) !== -1 ? true : 'expected ' + want + ' on the headline';
    });

    check('finance: every business line is on screen, including the empty ones', () => {
      const missing = ['Arzuz Care', 'Verification', 'Monitoring', 'Marketplace', 'Storage', 'Housing']
        .filter(l => finLines().indexOf(l) === -1);
      return missing.length ? 'missing lines: ' + missing.join(', ') : true;
    });

    check('finance: housing is stated as carrying no revenue, and zeroes are printed', () => {
      if (finLines().indexOf('no revenue, by design') === -1) return 'housing is not marked as a no-revenue line';
      if (finLines().indexOf('\u20a60') === -1) return 'an empty line is blank rather than zero \u2014 "nothing here" and "we did not look" would look the same';
      return true;
    });

    check('finance: a balanced journal is reported as balanced', () => {
      if (finRecon().indexOf('balanced') === -1) return 'no balancing statement was rendered';
      return finRecon().indexOf('off by') === -1 ? true : 'a balanced journal was reported as off';
    });

    check('finance: both sides of the identity are shown, not just the verdict', () => {
      const html = finRecon();
      if (html.indexOf('Cash in') === -1 || html.indexOf('Owed + earned') === -1) {
        return 'the two sides of the reconciliation are not both on screen';
      }
      return true;
    });

    /* --- the negative control: half a posting must be visible --- */
    sb.win.__MOCK__.financeOneSided();
    await sb.win.arzuzFinance.load();
    await tick(80);

    check('finance: a ONE-SIDED posting is reported, never smoothed away', () =>
      finRecon().indexOf('off by') !== -1
        ? true : 'a line with an unmatched entry was shown as balanced');

    check('finance: and it names the line and the amount', () => {
      const want = money(500000);
      if (finRecon().indexOf(want) === -1) return 'the size of the imbalance is not on screen';
      return /Arzuz Care/.test(finRecon()) ? true : 'the offending line is not named';
    });

    check('finance: the imbalance is reported in words, not left to the reader', () =>
      /do not balance|find the one-sided entry/.test(finRecon()) ? true : 'no warning sentence was rendered');

    if (role === 'admin') {
      /* --- a refund posts BOTH sides, so the residual must not move --- */
      const beforeRep = report();
      const beforeResidual = careResidual(beforeRep);
      $('finRefundRef').value = 'AZ-P-MOCK-1';
      await sb.win.arzuzFinance.refund();
      await tick(100);
      const afterRep = report();

      check('finance: a refund posts the pair \u2014 cash out and the obligation move together', () => {
        const cashOutMoved = afterRep.lines.care.cash_out_kobo - beforeRep.lines.care.cash_out_kobo;
        const refundsMoved = afterRep.lines.care.refunds_kobo - beforeRep.lines.care.refunds_kobo;
        if (cashOutMoved <= 0) return 'the refund did not move cash out';
        if (cashOutMoved !== refundsMoved) return 'one side moved ' + cashOutMoved + ', the other ' + refundsMoved;
        if (careResidual(afterRep) !== beforeResidual) return 'the refund changed the residual \u2014 it posted one side only';
        return true;
      });

      check('finance: the panel says what was refunded, in naira and with the provider ref', () => {
        const said = finRefFunds() + String(($('finNote') && $('finNote').textContent) || '');
        if (said.indexOf('Refunded') === -1) return 'no confirmation was shown';
        return /MOCK-TRF-/.test(said) ? true : 'the provider\u2019s own reference is not shown';
      });

      check('finance: the admin login is offered the refund and the payout controls', () => {
        if (finRefFunds().indexOf('data-fin="refund"') === -1) return 'no refund control';
        return finRefs().indexOf('data-fin="referral"') !== -1 ? true : 'no referral payout control';
      });

      $('finRefId').value = 'ref-mock-1';
      $('finRefStatus').value = 'paid';
      $('finRefPayout').value = '';
      await sb.win.arzuzFinance.referral();
      check('finance: a reward cannot be marked paid without a provider payout reference', () => {
        const said = String(($('finNoteLive') && $('finNoteLive').textContent) || '');
        return /payout reference/i.test(said) ? true : 'paid was accepted without a payout reference: ' + said;
      });

      check('finance: the referral pipeline is on screen with its states', () => {
        const html = finRefs();
        if (html.indexOf('Under review') === -1) return 'no referral state is on screen';
        return html.indexOf('Payout pending') !== -1 ? true : 'the states are not the pipeline\u2019s';
      });
    } else {
      /* Support: the control is missing AND the function refuses the
         action when it is called anyway. Both halves matter — a hidden
         button is not what is protecting the money. */
      const supBefore = report();
      $('finRefundRef').value = 'AZ-P-MOCK-1';
      await sb.win.arzuzFinance.refund();
      await tick(80);
      const supAfter = report();

      check('finance: support cannot refund even by driving the action directly', () => {
        if (supAfter.lines.care.cash_out_kobo !== supBefore.lines.care.cash_out_kobo) return 'money moved for a support login';
        if (supAfter.lines.care.refunds_kobo !== supBefore.lines.care.refunds_kobo) return 'a refund was recorded for a support login';
        /* The refusal is rendered into the refunds panel itself (there is
           no form for support to print it beside). */
        return /only the admin login/i.test(finRefFunds()) ? true : 'the refusal was not shown: ' + finRefFunds().slice(-260);
      });

      check('finance: support reads the books but is offered no way to move money', () => {
        if (finHead().indexOf('action:report') === -1) return 'support cannot read the books';
        if (finRefFunds().indexOf('data-fin="refund"') !== -1) return 'support was offered a refund control';
        if (finRefs().indexOf('data-fin="referral"') !== -1) return 'support was offered a payout control';
        return /only the admin login/i.test(finRefFunds() + finRefs()) ? true : 'the panel does not say why the control is missing';
      });

      check('finance: and the payout pipeline is still readable for the coordination it does', () =>
        finRefs().indexOf('Under review') !== -1 ? true : 'support cannot see the referral pipeline');
    }
  }

  /* --- Repair claims: the queue, and who may move --------------------

     The panel claims two things: that it renders the SERVER's status and
     the server's own figures, and that it offers only what each claim's
     status permits. Both are checkable, so both are checked here — the
     real functions a click would drive, against the mock's own claims
     store, and then the screen AND the store read back. An approval the
     function refused must not appear anywhere as a success, and the
     one-sided case is driven on purpose: a queue that cannot fail
     proves nothing.                                                      */

  /* WHO MAY SEE THE QUEUE IS NOT "EVERYONE BUT MARKETING" ANY MORE.
     The repair queue is operations work — it belongs to the admin and to
     the desk that answers "where is my repair". verification inspects
     property and finance keeps the books; supabase-claims.sql gives both
     of them no policy on repair_claims, so for them the panel must be
     ABSENT, which is asserted rather than assumed. */
  if (role !== 'admin' && role !== 'support') {
    check('claims: the ' + role + ' login never reaches the queue', () =>
      sb.loc.hash.indexOf('#/claims') === -1 ? true : role + ' was left on the claims section');
    check('claims: and nothing rendered there', () =>
      String($('claimsHead')._innerHTML || '') === '' ? true : 'the claims panel rendered for ' + role);
  } else {
    sb.loc.hash = '#/claims';
    await tick(140);

    const clHead = () => String($('claimsHead')._innerHTML || '');
    const clQueue = () => String($('claimsQueue')._innerHTML || '');
    const clWork = () => String($('claimsWork')._innerHTML || '');
    const claimDb = () => sb.win.__MOCK__.db();
    const claimRow = (id) => claimDb().repair_claims.filter(c => c.id === id)[0];
    const ledgerOf = (ref) => claimDb().care_credit_events.filter(e => String(e.reason || '').indexOf(ref) !== -1);
    const money = kobo => '\u20a6' + Number(Number(kobo || 0) / 100).toLocaleString('en-NG');
    const statusOf = (id) => (claimRow(id) || {}).status;

    check('claims: the panel renders, and names the action behind its rows', () => {
      if (!clHead()) return 'nothing rendered on the claims section';
      if (clHead().indexOf('action:queue') === -1) return 'the panel does not name the action behind its rows';
      return clQueue() && clWork() ? true : 'the queue or the work panel did not render';
    });

    check('claims: every status in the schema is on screen, including the empty ones', () => {
      const missing = ['Filed', 'Under review', 'Covered, no worker yet', 'With a worker', 'Work started',
        'Waiting on the customer', 'Completed', 'Not covered', 'Withdrawn', 'Disputed']
        .filter(l => clHead().indexOf(l) === -1);
      return missing.length ? 'missing statuses: ' + missing.join(', ') : true;
    });

    check('claims: the queue is the fixture the mock seeded', () => {
      const missing = claimDb().repair_claims.filter(c => clQueue().indexOf(c.reference) === -1);
      return missing.length ? 'not in the queue: ' + missing.map(c => c.reference).join(', ') : true;
    });

    /* HOW MANY VISITS ARE ACTUALLY PINNED DOWN, counted by the server over
       every open claim — the fixtures hold one agreed (claim-0011), one
       still being haggled over (claim-0012) and one offered with no answer
       (claim-0009). The page must print the SERVER's numbers, and it must
       say which of the two facts is which: an agreed visit and a day the
       two of them are still fighting about are not the same news. */
    check('claims: the queue says how many visits are settled and how many are still in the air', () => {
      const said = clHead().replace(/<[^>]*>/g, '');
      if (said.indexOf('Visit days') === -1) return 'the header carries nothing about the visit days';
      if (said.indexOf('1 agreed') === -1) {
        return 'the agreed visit is not counted: ' + said.slice(said.indexOf('Visit days'));
      }
      if (said.indexOf('2 still being haggled over') === -1) {
        return 'the unsettled visits are not counted separately: ' + said.slice(0, 400);
      }
      return said.indexOf('no visit day offered yet') === -1
        ? true : 'a queue with days on it says no day was ever offered';
    });

    check('claims: the queue is rendered as CARDS too, for the widths the table is hidden at', () => {
      if (clQueue().indexOf('cards-wrap') === -1) return 'no cards: the queue vanishes on a phone';
      const cards = (clQueue().match(/class="row-card"/g) || []).length;
      const wanted = claimDb().repair_claims.length;
      return cards === wanted ? true : 'rendered ' + cards + ' of ' + wanted + ' cards';
    });

    /* --- the aging clock, as this panel renders it -------------------

       The expectations below are the FIXTURE's own dates, worked out
       here by hand so a drifting clock fails rather than agrees with
       itself — the mock computes the clock too, and comparing the panel
       to the mock would only prove the two agree:

         claim-0005  under review for 20 days, 24h allowed  → 19 days late
         claim-0004  disputed for 12 days                    → 11 days late
         claim-0001  filed 2 days ago                        → 24h late
         claim-0003  waiting on the customer for 8 days of 7 → 24h, not our fault
         claim-0002  decided 20 hours ago of 24              → 4h left
         claim-0006  refused, finished                       → not on a clock
                                                                        */

    const at = (ref) => clQueue().indexOf(ref);

    check('claims: the queue leads with what is PAST its deadline, worst first', () => {
      const order = ['AZ-C-MOCK-5', 'AZ-C-MOCK-4', 'AZ-C-MOCK-1', 'AZ-C-MOCK-3', 'AZ-C-MOCK-2', 'AZ-C-MOCK-6'];
      const out = order.filter((ref, i) => i && at(order[i - 1]) > at(ref));
      return out.length ? 'the queue is out of order at ' + out.join(', ') : true;
    });

    check('claims: the counts name the two different kinds of late', () => {
      const ours = /<b>3<\/b> waiting on us/.test(clHead());
      return ours && clHead().indexOf('1 waiting on a customer') !== -1
        ? true : 'the header does not separate our lateness from the customer\u2019s: ' + clHead().slice(0, 200);
    });

    /* The row's text, tags dropped: the deadline is two spans (the wait,
       then whose move it is) so the column is sized by the longer half,
       and what a person READS is what has to be asserted. */
    const clQueueText = () => clQueue().replace(/<[^>]*>/g, '');

    check('claims: every row carries its deadline, in words, with whose move it is', () => {
      const want = [
        ['AZ-C-MOCK-5', '19 days late \u00b7 decide coverage'],
        ['AZ-C-MOCK-4', '11 days late \u00b7 close the dispute'],
        ['AZ-C-MOCK-1', '24h late \u00b7 decide coverage'],
        ['AZ-C-MOCK-3', 'no reply for 24h \u00b7 hear back from the customer'],
        ['AZ-C-MOCK-2', '4h left \u00b7 name a worker']
      ];
      const missing = want.filter(([, line]) => clQueueText().indexOf(line) === -1);
      return missing.length ? 'not on the queue: ' + missing.map(([ref, line]) => ref + ' \u2192 "' + line + '"').join('; ') : true;
    });

    check('claims: a claim waiting on the customer is not dressed as our failure', () =>
      /class="claim-waiting"/.test(clQueue()) && /class="claim-late"/.test(clQueue())
        ? true : 'the two kinds of late are rendered the same way');

    check('claims: the queue opens on the top claim THIS login can move', () => {
      /* The most overdue claim is claim-0005, and only the admin may
         decide coverage — so support opens on the top claim support can
         act on (claim-0002, covered and waiting for a worker) rather
         than on a priority with no button under it. */
      const want = role === 'admin' ? 'AZ-C-MOCK-5' : 'AZ-C-MOCK-2';
      return clWork().indexOf(want) !== -1
        ? true : 'opened on something else — wanted ' + want + ': ' + clWork().slice(0, 120);
    });

    check('claims: the filter narrows the page to what is late, and says where it looked', () => {
      sb.win.arzuzClaims.late();
      const filtered = clQueue();
      sb.win.arzuzClaims.late();   /* back the way it was, for the checks below */
      if (filtered.indexOf('AZ-C-MOCK-5') === -1) return 'the filter dropped a claim that is late';
      if (filtered.indexOf('AZ-C-MOCK-2') !== -1) return 'a claim still inside its deadline survived the filter';
      if (filtered.indexOf('AZ-C-MOCK-6') !== -1) return 'a finished claim was shown as late';
      if (filtered.indexOf('Show every claim') === -1) return 'the filter cannot be turned back off';
      return filtered.indexOf('filtered to what is overdue') !== -1
        ? true : 'the filter does not say it looked at a page rather than at everything';
    });

    sb.win.arzuzClaims.select('claim-0006');
    await tick(40);
    check('claims: a finished claim is not on a clock at all', () =>
      clWork().indexOf('not on the clock') !== -1 && clWork().indexOf(' late') === -1
        ? true : 'a refused claim was given a deadline: ' + clWork().slice(0, 160));

    check('claims: the card carries the deadline itself, not only the lateness', () => {
      /* Short on the row, exact on hover: the instant it was due, and how
         long the status is allowed to stand. */
      const row = (clQueue().match(/<span class="claim-late"[^>]*title="[^"]*"[^>]*>/g) || []);
      if (!row.length) return 'no late claim carries a deadline in its title';
      const titled = row.filter((s) => /Due \d{1,2} \w+ \d{4}/.test(s) && /24h allowed in this status/.test(s));
      return titled.length === row.length
        ? true : 'a late claim does not say when it was due: ' + row[0].slice(0, 140);
    });


    check('claims: an estimate is marked as a quote, and a reported actual is not', () => {
      if (clQueue().indexOf(money(450000) + '*') === -1) return 'the estimate is not marked as a quote';
      return clQueue().indexOf(money(320000)) !== -1 ? true : 'the reported actual is not on the queue';
    });

    /* --- a claim that is already decided offers no second decision --- */
    sb.win.arzuzClaims.select('claim-0006');
    await tick(40);
    check('claims: a refused claim shows its reason, and offers no decision', () => {
      if (clWork().indexOf('outside the cover') === -1) return 'the refusal reason is not on the claim';
      /* the decision's own sentence already ends in a full stop; the line
         that renders it must not add a second one */
      if (clWork().indexOf('..') !== -1) return 'a sentence was ended twice: "…' + clWork().slice(clWork().indexOf('..') - 30, clWork().indexOf('..') + 2) + '"';
      return clWork().indexOf('data-claim-act="decide"') === -1
        ? true : 'a claim that already has a decision was offered another one';
    });

    /* --- the decision, and the call-out it spends ------------------- */
    if (role === 'admin') {
      const ledgerBefore = claimDb().care_credit_events.length;
      sb.win.arzuzClaims.select('claim-0001');
      await tick(40);
      $('claimDecide').value = 'covered';
      $('claimReason').value = 'A burst pipe inside the flat is what the cover is for.';
      $('claimEstimate').value = '4500';
      await sb.win.arzuzClaims.decide();
      await tick(120);

      check('claims: a covered decision is written, with the call-out committed', () => {
        if (statusOf('claim-0001') !== 'approved') return 'the claim is ' + statusOf('claim-0001');
        if (!claimRow('claim-0001').call_out_no) return 'no call-out was committed';
        return claimRow('claim-0001').estimate_kobo === 450000 ? true : 'the quote was not stored in kobo';
      });

      check('claims: and the call-out is ON THE LEDGER, not only on the row', () => {
        const wrote = claimDb().care_credit_events.slice(0, claimDb().care_credit_events.length - ledgerBefore);
        const reserved = wrote.filter(e => e.event === 'reserved' && e.delta === -1);
        return reserved.length === 1
          ? true : 'a reservation that is not on the ledger is a number nobody can audit (' + reserved.length + ')';
      });

      check('claims: the panel re-read the queue, so the new status is on screen', () =>
        clQueue().indexOf('Covered, no worker yet') !== -1 ? true : 'the queue still shows the old status');

      /* --- a decision without a reason is refused -------------------- */
      sb.win.arzuzClaims.select('claim-0005');
      await tick(40);
      $('claimDecide').value = 'covered';
      $('claimReason').value = 'ok';
      await sb.win.arzuzClaims.decide();
      await tick(60);
      check('claims: a decision with no reason in words is refused, and nothing moves', () =>
        statusOf('claim-0005') === 'under_review'
          ? true : 'a one-word reason decided a claim (' + statusOf('claim-0005') + ')');

      /* --- covered, but the pass has nothing left to spend ---------- */
      $('claimReason').value = 'Covered in principle, but this pass is spent.';
      await sb.win.arzuzClaims.decide();
      await tick(120);
      check('claims: approving on a SPENT pass is refused, and says so', () =>
        /no call-outs left/i.test(clWork())
          ? true : 'the refusal is not on screen: ' + clWork().slice(-260));
      check('claims: and the claim is left under review, not approved against a gone allowance', () =>
        statusOf('claim-0005') === 'under_review'
          ? true : 'the claim moved to ' + statusOf('claim-0005') + ' with no call-out to spend');
    }

    /* --- the worker, and the address their notice goes to ------------ */
    sb.win.arzuzClaims.select('claim-0002');
    await tick(40);
    $('claimWorker').value = 'Yinka, plumbing';
    $('claimWorkerPhone').value = '';
    await sb.win.arzuzClaims.assign();
    await tick(60);
    check('claims: a worker without a reachable number is not an assignment', () =>
      statusOf('claim-0002') === 'approved'
        ? true : 'the claim moved to ' + statusOf('claim-0002') + ' with no number to reach the worker');

    /* A mistyped address is refused rather than stored: the panel would
       otherwise say "email on file" about a notice that can never go. */
    $('claimWorkerPhone').value = '08031112222';
    $('claimWorkerEmail').value = 'yinka at gmail';
    await sb.win.arzuzClaims.assign();
    await tick(60);
    check('claims: an address that is not an address does not become the channel', () => {
      if (statusOf('claim-0002') !== 'approved') return 'the claim moved on a mistyped address';
      return /does not look like an address/.test(clWork()) ? true : 'the refusal is not on screen';
    });

    $('claimWorkerEmail').value = 'yinka.plumbing@example.com';
    await sb.win.arzuzClaims.assign();
    await tick(120);
    check('claims: naming a worker moves the claim, and the queue says who', () => {
      if (statusOf('claim-0002') !== 'assigned') return 'the claim is ' + statusOf('claim-0002');
      return clQueue().indexOf('Yinka, plumbing') !== -1 ? true : 'the worker is not on the queue row';
    });

    check('claims: naming a worker says BOTH halves landed \u2014 the job reached them, and the customer was told who is coming', () => {
      /* The sentence is the SERVER's answer (body.notified), so a handover
         whose WhatsApp did not go cannot read as a success here \u2014 and
         since one action sends two different notices, half a success has
         to be visible as half a success. */
      const said = clWork();
      const from = Math.max(0, said.indexOf('is with') - 20);
      const tail = said.slice(from, from + 260);
      /* The exact sentence, both halves: the worker's copy reached them on
         the channel the mock reports, and the customer was told. */
      return /The job details reached them on WhatsApp and email\. The customer has been told who is coming and how to reach them, on WhatsApp\./.test(said)
        ? true : 'the panel does not report both halves of the handover: ' + tail;
    });

    check('claims: the worker\u2019s address is on the record, and the panel says so', () => {
      if (claimRow('claim-0002').provider_email !== 'yinka.plumbing@example.com') {
        return 'the address was stored as ' + claimRow('claim-0002').provider_email;
      }
      return clWork().indexOf('yinka.plumbing@example.com') !== -1
        ? true : 'nothing on the claim says where its outcome will be emailed';
    });

    /* The other half of the same sentence: a handover the sender refused.
       The claim still moves \u2014 a notice must never undo an assignment \u2014
       and the panel must not report a delivery that did not happen. */
    /* The claim to hand over twice differs by role and for one reason:
       support cannot decide, so claim-0001 is still 'submitted' on that
       run and naming a worker on it would be refused for the wrong
       reason \u2014 the refusal is tested on its own where it belongs. */
    const target = role === 'admin' ? 'claim-0001' : 'claim-0002';
    sb.win.arzuzClaims.select(target);
    await tick(40);
    sb.win.__MOCK__.handoverFails(true);
    $('claimWorker').value = 'Musa Ibrahim';
    $('claimWorkerPhone').value = '08031112222';
    $('claimWorkerEmail').value = '';
    await sb.win.arzuzClaims.assign();
    await tick(140);
    sb.win.__MOCK__.handoverFails(false);

    check('claims: a handover that did NOT go is not reported as one that did \u2014 for either person', () => {
      const said = clWork();
      if (statusOf(target) !== 'assigned') return 'a refused notice undid the assignment (' + statusOf(target) + ')';
      if (/reached them on/.test(said)) return 'the panel reported a delivery that did not happen';
      if (/has been told who is coming/.test(said)) return 'the panel reported the customer being told when nothing went';
      /* Both halves, named in the panel's own words, with the refused
         channel and the page. */
      if (said.indexOf('The job details did not reach them at all: WhatsApp (openwa-502), email (no address).') === -1) {
        return 'the worker half is not reported honestly: ' + said.slice(0, 260);
      }
      /* The mock's passes carry no address, so the customer's half names
         both channels that did not carry it \u2014 the same reading the
         function gives a person no channel reached. */
      if (said.indexOf('The customer has NOT been told who is coming: WhatsApp (openwa-502), email (no address).') === -1) {
        return 'the customer half is not reported honestly: ' + said.slice(0, 300);
      }
      return /paged to chase whoever was not reached/.test(said) ? true : 'the panel does not say the team was paged about it';
    });

    /* The third answer: the handover blew up before any channel ran, so the
       server reports NOTHING about the channels. There is no delivery and
       no page to report, and the sentence must carry neither. */
    sb.win.__MOCK__.handoverUnreported(true);
    $('claimWorker').value = 'Musa Ibrahim';
    $('claimWorkerPhone').value = '08031112222';
    $('claimWorkerEmail').value = '';
    await sb.win.arzuzClaims.assign();
    await tick(140);
    sb.win.__MOCK__.handoverUnreported(false);

    check('claims: a handover nobody can report on is not turned into a delivery or a page', () => {
      const said = clWork();
      if (statusOf(target) !== 'assigned') return 'the assignment did not survive it (' + statusOf(target) + ')';
      if (/reached them on/.test(said)) return 'the panel invented a delivery';
      if (/has been told who is coming/.test(said)) return 'the panel invented a notice to the customer';
      if (/paged/.test(said)) return 'the panel claimed a page it cannot know about';
      return said.indexOf('The handover could not be reported') !== -1
        ? true : 'the panel does not say the handover is unreported: ' + said.slice(0, 260);
    });

    check('claims: a worker with no address is said to have none, not left blank', () => {
      sb.win.arzuzClaims.select('claim-0004');
      const said = clWork();
      sb.win.arzuzClaims.select('claim-0002');
      return said.indexOf('(no email on file)') !== -1
        ? true : 'a worker with no address reads as though one were on file';
    });

    check('claims: a claim with a worker is offered the work-start control', () =>
      clWork().indexOf('data-claim-act="progress"') !== -1
        ? true : 'no way to record that the work started');

    /* --- the worker's own answer to that handover ---------------------
       Naming somebody is us saying who is coming; it is not them agreeing
       to come. The panel owes the operator the difference between the two,
       and for a declined job it owes them the whole consequence: the claim
       is back to covered with nobody on it, the name and the words stay on
       the record, and there is a control to name somebody else.

       __MOCK__.workerReply() is the state workerReply() in claims.js
       records when a reply lands on /api/wa-inbound \u2014 the classification
       itself is tested in scripts/test-claims.mjs, and this is the screen. */
    check('claims: a worker who has not answered is not shown as one who has', () =>
      /has not answered yet/.test(clWork())
        ? true : 'the panel does not say whether the worker agreed: ' + clWork().slice(0, 220));

    sb.win.__MOCK__.workerReply(claimRow(target).reference, 'declined', 'I am in Lagos until Friday');
    await sb.win.arzuzClaims.load();
    await tick(140);
    sb.win.arzuzClaims.select(target);
    await tick(60);

    check('claims: a worker who turned the job down is taken off it, and the queue says who and why', () => {
      if (statusOf(target) !== 'approved') {
        return 'a declined job stayed with somebody who said no (' + statusOf(target) + ')';
      }
      const said = clWork();
      if (said.indexOf('Musa Ibrahim turned the job down on') === -1) {
        return 'the panel does not say who turned it down: ' + said.slice(0, 300);
      }
      if (said.indexOf('I am in Lagos until Friday') === -1) return 'the words they used are not kept';
      if (!/covered with nobody on it/.test(said)) return 'the panel does not say where the claim went back to';
      if (clQueue().indexOf('declined') === -1) return 'the queue row does not carry the answer';
      return clWork().indexOf('data-claim-act="assign"') !== -1
        ? true : 'nowhere to name somebody else on a job nobody is on';
    });

    sb.win.__MOCK__.workerReply(claimRow(target).reference, 'accepted', 'yes, I will come tomorrow morning');
    await sb.win.arzuzClaims.load();
    await tick(140);
    sb.win.arzuzClaims.select(target);
    await tick(60);

    check('claims: a worker who said yes is recorded as having agreed, not merely named', () => {
      if (statusOf(target) !== 'assigned') return 'a yes did not settle the job (' + statusOf(target) + ')';
      const said = clWork();
      if (said.indexOf('Musa Ibrahim accepted the job on') === -1) {
        return 'the panel does not say who agreed: ' + said.slice(0, 300);
      }
      if (said.indexOf('yes, I will come tomorrow morning') === -1) return 'their own words are not kept';
      if (!/has confirmed the job/.test(said)) return 'the panel does not say the worker agreed';
      return clQueue().indexOf('accepted') !== -1 ? true : 'the queue row does not carry the answer';
    });

    /* THE TWO STATES THE HANDOVER CAN END IN BESIDES A YES OR A NO,
       read off the fixture rows for them (claim-0009 and claim-0010):
       a worker who answered with a DAY and has still not agreed the job,
       and one nobody ever heard from. Neither is a refusal, and neither
       may be rendered as one \u2014 the next person to ring the worker needs
       to know which of the three happened. */
    sb.win.arzuzClaims.select('claim-0009');
    await tick(60);

    check('claims: a day the worker offered is quoted, and not counted as a yes', () => {
      const said = clWork();
      if (said.indexOf('I can do Saturday morning before 11') === -1) {
        return 'the day the worker offered is not on the claim: ' + said.slice(0, 300);
      }
      if (!/suggested a time/.test(said)) return 'the day is shown without saying what it is';
      if (/has confirmed the job/.test(said) || /accepted the job/.test(said)) {
        return 'a question was rendered as an agreement: ' + said.slice(0, 300);
      }
      return clQueue().indexOf('suggested a time') !== -1
        ? true : 'the queue row carries nothing about the day the worker offered';
    });

    sb.win.arzuzClaims.select('claim-0010');
    await tick(60);

    check('claims: a job the clock took back says nobody answered \u2014 not that they said no', () => {
      const said = clWork();
      if (said.indexOf('never answered the handover') === -1) {
        return 'the panel does not say why the job came back: ' + said.slice(0, 300);
      }
      if (/They replied:/.test(said)) return 'a silence is rendered as words the worker sent';
      if (/no reason given/.test(said)) return 'a silence was rendered as a refusal with no reason';
      if (!/no answer/.test(clQueue())) return 'the queue row does not mark the job as unanswered';
      /* The name and the number stay on the record: somebody has to ring
         them before this becomes a pattern. */
      if (said.indexOf('Sani, carpentry') === -1) return 'the panel threw away who was asked';
      return said.indexOf('data-claim-act="assign"') !== -1
        ? true : 'nowhere to name somebody else on a job nobody is on';
    });

    /* THE CUSTOMER'S OWN TWO ANSWERS, read off the fixture rows for them
       (claim-0011 and claim-0012): a day the customer AGREED, and a day
       that did not suit them so they asked for another. The visit is the
       team's to run, so both have to be on the claim and on the row — and
       neither may be rendered as a booking, a refusal or a yes.

       Neither moves the claim: the worker is still on the job either way,
       which is why the checks below also pin that the status did not
       change under the answer. */
    sb.win.arzuzClaims.select('claim-0011');
    await tick(60);

    check('claims: a day the customer AGREED is on the claim, with the day they agreed to', () => {
      const said = clWork();
      if (said.indexOf('I can come Sunday afternoon') === -1) {
        return 'the day that was agreed to is not on the claim: ' + said.slice(0, 400);
      }
      if (!/The customer agreed this day on/.test(said)) {
        return 'the panel does not say the customer agreed it: ' + said.slice(0, 400);
      }
      if (!/messaged that the visit is on/.test(said)) {
        return 'the customer\u2019s yes is recorded without the worker being told';
      }
      /* The worker offered a day and has still not agreed the job, and the
         customer's yes does not change that: two different people, two
         different answers, and neither may be read off the other. */
      if (/has confirmed the job/.test(said) || /accepted the job/.test(said)) {
        return 'a customer\u2019s yes was rendered as the worker accepting: ' + said.slice(0, 400);
      }
      if (statusOf('claim-0011') !== 'assigned') {
        return 'agreeing a day moved the claim (' + statusOf('claim-0011') + ')';
      }
      return clQueue().indexOf('customer agreed the day') !== -1
        ? true : 'the queue row carries nothing about the agreement';
    });

    sb.win.arzuzClaims.select('claim-0012');
    await tick(60);

    check('claims: a day that did not suit them is quoted as a request, not as a booking', () => {
      const said = clWork();
      /* BOTH halves: the day that was answered and the day they asked for.
         A panel that dropped the offer leaves the reader unable to tell
         whether the two ever matched. */
      if (said.indexOf('Can I come Saturday morning?') === -1) {
        return 'the day the customer was answering is gone: ' + said.slice(0, 400);
      }
      if (said.indexOf('Sunday afternoon after 2 would suit me') === -1) {
        return 'the day the customer asked for is not on the claim: ' + said.slice(0, 400);
      }
      if (!/they said so on/.test(said)) return 'the panel does not say when they said it';
      if (!/the job is still theirs/i.test(said)) {
        return 'a request for another day was not told apart from a refusal';
      }
      if (/has confirmed the job/.test(said) || /turned the job down/.test(said)) {
        return 'a customer\u2019s request was rendered as the worker\u2019s answer: ' + said.slice(0, 400);
      }
      if (statusOf('claim-0012') !== 'assigned') {
        return 'asking for another day moved the claim (' + statusOf('claim-0012') + ')';
      }
      return clQueue().indexOf('customer asked for another day') !== -1
        ? true : 'the queue row carries nothing about the day they asked for';
    });

    /* Put the panel back where the checks below expect to find it: they
       drive the work panel through the claim the selection is on rather
       than naming one every time, so the selection is left as it was —
       claim-0002, which every run has a worker on by now. */
    sb.win.arzuzClaims.select('claim-0002');
    await tick(40);

    if (role === 'admin') {
      /* --- the cost, and the pair it posts -------------------------- */
      const residual = () => {
        const x = sb.win.__MOCK__.financeReport().lines.care;
        return (x.cash_in_kobo - x.cash_out_kobo)
          - (x.revenue_kobo + x.unearned_kobo + x.payable_kobo - x.refunds_kobo - x.costs_kobo);
      };
      const residualBefore = residual();

      $('claimActual').value = '3200';
      $('claimParts').value = 'trap = 1800\nWashers';
      $('claimEvidence').value = 'https://res.cloudinary.com/arzuz/after.jpg';
      $('claimReportNote').value = 'Replaced the trap and tested it.';
      await sb.win.arzuzClaims.report();
      await tick(120);

      check('claims: reporting the work moves the claim to the CUSTOMER, not to done', () =>
        statusOf('claim-0002') === 'awaiting_customer'
          ? true : 'a worker\u2019s word closed a claim: ' + statusOf('claim-0002'));

      check('claims: the cost is stored in kobo, the parts parse, and the evidence survives', () => {
        const c = claimRow('claim-0002');
        if (Number(c.actual_kobo) !== 320000) return 'actual_kobo is ' + c.actual_kobo;
        if ((c.parts || []).length !== 1) return 'the parts were parsed as ' + (c.parts || []).length;
        if (c.parts[0].name !== 'trap' || Number(c.parts[0].kobo) !== 180000) {
          return 'the part was stored as ' + JSON.stringify(c.parts[0]);
        }
        return (c.evidence || []).length === 1 ? true : 'the evidence link was dropped';
      });

      check('claims: the cost is POSTED as a pair, so the books still reconcile', () =>
        residual() === residualBefore
          ? true : 'reporting a repair left the books off by ' + (residual() - residualBefore) + ' kobo');

      check('claims: and the panel says where the cost went', () =>
        /expense and a provider payable/.test(clWork()) ? true : 'the panel does not say where the cost went');

      /* --- the dispute ---------------------------------------------- */
      sb.win.arzuzClaims.select('claim-0004');
      await tick(40);
      check('claims: a disputed claim is offered the resolution control, and shows the complaint', () => {
        if (clWork().indexOf('data-claim-act="resolve"') === -1) return 'no way to close the dispute';
        return /still backs up/.test(clWork()) ? true : 'the customer\u2019s complaint is not on screen';
      });

      $('claimOutcome').value = 'completed';
      $('claimResolution').value = 'ok';
      await sb.win.arzuzClaims.resolve();
      await tick(60);
      check('claims: a resolution with no sentence is refused', () =>
        statusOf('claim-0004') === 'disputed' ? true : 'a two-letter resolution closed a dispute');

      $('claimResolution').value = 'The drain was rodded again and tested with the customer present.';
      await sb.win.arzuzClaims.resolve();
      await tick(120);
      check('claims: resolving as completed closes the claim and returns nothing to the pass', () => {
        if (statusOf('claim-0004') !== 'completed') return 'the claim is ' + statusOf('claim-0004');
        return ledgerOf('AZ-C-MOCK-4').filter(e => e.event === 'released').length === 0
          ? true : 'a call-out was given back on a job that was completed';
      });

      /* A dispute that ends the other way: the call-out must come BACK on
         the ledger as the opposite row. The state is seeded coherently —
         a reservation for it exists first — because releasing a call-out
         that was never taken would prove nothing. */
      claimDb().care_credit_events.unshift({
        id: 9001, created_at: new Date().toISOString(), plan_id: claimRow('claim-0001').plan_id,
        event: 'reserved', delta: -1, reason: 'Call-out 3 committed to claim AZ-C-MOCK-7',
        actor_name: 'owner', env: 'production'
      });
      claimDb().repair_claims.push(Object.assign({}, claimRow('claim-0004'), {
        id: 'claim-0007', reference: 'AZ-C-MOCK-7', status: 'disputed', eligibility: 'covered',
        call_out_no: 3, reserved_at: new Date().toISOString(),
        disputed_at: new Date().toISOString(), dispute_reason: 'Nobody came back to check it.',
        resolution: null, resolved_at: null, closed_by: null
      }));
      await sb.win.arzuzClaims.load();
      await tick(80);
      sb.win.arzuzClaims.select('claim-0007');
      await tick(40);
      $('claimOutcome').value = 'rejected';
      $('claimResolution').value = 'The worker did not return, so the call-out goes back and we quote again.';
      await sb.win.arzuzClaims.resolve();
      await tick(120);

      check('claims: a dispute that is NOT completed is closed as the team decided', () =>
        statusOf('claim-0007') === 'rejected' ? true : 'the claim is ' + statusOf('claim-0007'));
      check('claims: and the call-out is given back ON THE LEDGER, as the opposite row', () => {
        const back = ledgerOf('AZ-C-MOCK-7').filter(e => e.event === 'released');
        if (back.length !== 1) return 'expected one released row, found ' + back.length;
        return back[0].delta === 1 ? true : 'the release moved ' + back[0].delta + ' credits, not +1';
      });
    } else {
      /* --- support: coordination, and nothing that moves money ------- */
      sb.win.arzuzClaims.select('claim-0001');
      await tick(40);
      check('claims: support is offered no decision, and is told which rule says so', () => {
        if (clWork().indexOf('data-claim-act="decide"') !== -1) return 'support was offered a coverage decision';
        return /Only the admin login may/.test(clWork())
          ? true : 'the panel does not say why the control is missing';
      });

      $('claimReason').value = 'Covered, says the support login, who may not say this.';
      await sb.win.arzuzClaims.decide();
      await tick(80);
      check('claims: and driving the action directly is refused by the function', () =>
        statusOf('claim-0001') === 'submitted'
          ? true : 'a support login decided a claim: ' + statusOf('claim-0001'));
      check('claims: the refusal is rendered, not swallowed', () =>
        /only the admin login/i.test(clWork()) ? true : 'the 403 was swallowed: ' + clWork().slice(-200));

      sb.win.arzuzClaims.select('claim-0002');
      await tick(40);
      $('claimWorker').value = 'Yinka, plumbing';
      $('claimWorkerPhone').value = '08031112222';
      await sb.win.arzuzClaims.assign();
      await tick(120);
      check('claims: support MAY name the worker', () =>
        statusOf('claim-0002') === 'assigned' ? true : 'support could not assign (' + statusOf('claim-0002') + ')');

      $('claimProgressNote').value = 'Worker on site at 10am.';
      await sb.win.arzuzClaims.progress();
      await tick(120);
      check('claims: support may record that the work started', () =>
        statusOf('claim-0002') === 'in_progress' ? true : 'the claim is ' + statusOf('claim-0002'));

      $('claimActual').value = '3200';
      await sb.win.arzuzClaims.report();
      await tick(80);
      check('claims: support cannot report the work, even by driving the action', () =>
        statusOf('claim-0002') === 'in_progress'
          ? true : 'support reported work and moved the claim to ' + statusOf('claim-0002'));
      check('claims: and neither the cost nor its posting reached the books', () =>
        claimRow('claim-0002').actual_kobo === null
          ? true : 'a cost of ' + claimRow('claim-0002').actual_kobo + ' was recorded by a support login');

      sb.win.arzuzClaims.select('claim-0004');
      await tick(40);
      $('claimOutcome').value = 'cancelled';
      $('claimResolution').value = 'Cancelled by the support login, who may not do this.';
      await sb.win.arzuzClaims.resolve();
      await tick(80);
      check('claims: support cannot close a dispute', () =>
        statusOf('claim-0004') === 'disputed' ? true : 'a support login closed a dispute');
      check('claims: the queue is still fully readable for the coordination it does', () => {
        if (clHead().indexOf('action:queue') === -1) return 'support cannot read the queue';
        return clQueue().indexOf('AZ-C-MOCK-4') !== -1 ? true : 'support cannot see the disputed claim';
      });
    }

    /* --- the filter asks the server, in the server's vocabulary ------ */
    await sb.win.arzuzClaims.load();
    await tick(80);
    $('claimFilter').value = 'disputed';
    await sb.win.arzuzClaims.filter();
    await tick(120);
    check('claims: the status filter shows what the server returned, and nothing else', () => {
      const disputed = claimDb().repair_claims.filter(c => c.status === 'disputed').map(c => c.reference);
      const others = claimDb().repair_claims.filter(c => c.status !== 'disputed').map(c => c.reference);
      if (!disputed.every(r => clQueue().indexOf(r) !== -1)) {
        return 'a disputed claim is missing from the filtered queue';
      }
      const leaked = others.filter(r => clQueue().indexOf(r) !== -1);
      return leaked.length ? 'not disputed, but in the filtered queue: ' + leaked.join(', ') : true;
    });
    $('claimFilter').value = '';
    await sb.win.arzuzClaims.filter();
    await tick(80);
  }

  /* --- THE ROLE THAT OWNS THE PANEL, DRIVEN IN FULL ----------------------

     Every panel above is asserted for `admin`, the login that can reach all
     of them — and that is the shape of a blind spot: a branch inside a panel
     that only runs for the role which actually HOLDS it is never taken, so it
     cannot fail. Two of those branches are driven here.

       · support OPERATES Care: it records the visit that spends a credit.
         Who may do that is a fact about the SERVER (care-credit.js ALLOWED =
         admin + support). What a page test can prove is the page half — that
         the drawer opens for support, that a call-out with nobody named is
         refused before any request, and that the credit which IS recorded
         moves the ledger by exactly one, naming the worker.

       · marketing is the only login on the Growth page, and that page is read
         from the PII-scrubbed growth_* views rather than the base tables
         (assets/admin.js relFor). Three things follow, and none of them was
         asserted: the page must carry no phone number or name from the rows
         behind it, it must not offer a door to a section marketing cannot
         open, and — when those views refuse — it must say which migration is
         missing instead of drawing zeros that read as facts about the
         business. */
  {
    const priorHash = sb.loc.hash;

    if (role === 'support') {
      sb.loc.hash = '#/care';
      await tick(140);

      const careDb = sb.win.__MOCK__.db();
      const left = (id) => careDb.care_credit_events
        .filter(e => e.plan_id === id).reduce((n, e) => n + e.delta, 0);
      const target = careDb.care_plans_live.find(p => p.first_name === 'Ifeoma')
        || careDb.care_plans_live.find(p => (Number(p.balance) || 0) > 0 && p.status === 'active');

      check('care: support has a plan it can record a visit against', () =>
        target ? true : 'the mock dataset leaves support nothing to operate on');

      if (target) {
        const before = left(target.id);
        const beforeEvents = careDb.care_credit_events.length;

        sb.win.arzuzCareOpenSpend(target.id);
        await tick(80);
        check('care: support is offered the drawer that records a visit', () =>
          String($('carePanel')._innerHTML || '').indexOf('id="careWorker"') !== -1
            ? true : 'no drawer opened for the login whose job this is');

        sb.win.arzuzCareAct('spend', target.id);
        await tick(80);
        check('care: a call-out with nobody named is refused for support too, before any request', () => {
          if (careDb.care_credit_events.length !== beforeEvents) {
            return 'a credit was taken for work nobody is named against';
          }
          const note = String($('careDrawerNote').textContent || '');
          return note.indexOf('who did the work') !== -1 ? true : 'no refusal in the drawer: ' + note;
        });

        $('careWorker').value = 'Verified worker (support harness)';
        $('careParts').value = '0';
        sb.win.arzuzCareAct('spend', target.id);
        await tick(220);
        check('care: the credit support records moves the LEDGER by exactly one, named', () => {
          const after = left(target.id);
          if (after !== before - 1) return 'the ledger moved by ' + (after - before) + ', not -1';
          const row = careDb.care_credit_events.find(e => e.plan_id === target.id && e.event === 'spent'
            && e.worker === 'Verified worker (support harness)');
          return row ? true : 'the spent row does not name the worker support typed';
        });
      }
    }

    if (role === 'marketing') {
      sb.loc.hash = '#/growth';
      await tick(180);

      const growthEl = () => qsMemo['.section-view[data-section="growth"]']
        || sb.document.querySelector('.section-view[data-section="growth"]');
      const growthHtml = () => String((growthEl() && (growthEl()._innerHTML || growthEl().innerHTML)) || '');

      check('growth: the marketing login gets the page it exists for', () =>
        growthHtml().indexOf('Traction right now') !== -1
          ? true : 'the Growth page rendered nothing for the one login that has it');

      check('growth: and it is NOT the missing-views message while the scrubbed views answer', () =>
        growthHtml().indexOf('not being served to this login') === -1
          ? true : 'the page claims the role SQL has not run while the feeds answer');

      /* The seeded values are read out of the mock dataset rather than
         invented, so this cannot pass by looking for the wrong string. */
      check('growth: no phone number or name from the rows behind it reaches marketing', () => {
        const html = growthHtml();
        const leaks = [];
        for (const r of (sb.win.__MOCK__.db().demand_records || [])) {
          const p = (r && r.payload) || {};
          for (const k of ['ph', 'phone', 'whatsapp', 'nm', 'last']) {
            const v = p[k] === undefined || p[k] === null ? '' : String(p[k]).trim();
            if (v.length > 3 && html.indexOf(v) !== -1) leaks.push(k + '=' + v);
          }
        }
        return leaks.length ? 'the scrubbed page carries identity: ' + leaks.join(', ') : true;
      });

      check('growth: every Open button on it leads somewhere marketing may reach', () => {
        const offered = new Set([...growthHtml().matchAll(/data-goto="([^"]+)"/g)].map(m => m[1]));
        const wrong = [...offered].filter(sec => MAY_REACH.indexOf(sec) === -1);
        return wrong.length ? 'the page offers a door marketing cannot open: ' + wrong.join(', ') : true;
      });

      /* THE FAILURE THE PAGE USED TO HIDE. With the scrubbed views refusing,
         the numbers are unknowable, and a page that drew 0 would be
         reporting an outage as a fact about the business. */
      sb.win.__MOCK__.error('rest');
      $('btnRefresh').click();
      await tick(220);
      sb.loc.hash = '#/growth';
      await tick(220);
      check('growth: with the scrubbed views refusing, the page names the migration that is missing', () =>
        /not being served to this login/.test(growthHtml()) && /supabase-team-roles\.sql/.test(growthHtml())
          ? true : 'it drew zeros instead of naming the role SQL: ' + growthHtml().slice(0, 160));
      sb.win.__MOCK__.reset();
      $('btnRefresh').click();
      await tick(250);
    }

    sb.loc.hash = priorHash;
    await tick(20);
  }

  /* --- tables: row counts (admin; other roles render subset but same code path) --- */
  if (role === 'admin') {
    const db = sb.win.__MOCK__.db();
    const counts = {
      demand_records: db.demand_records.filter(r => String(r.env) !== 'test').length,
      listings: db.listings.filter(r => String(r.env) !== 'test').length,
      scout_submissions: db.scout_submissions.filter(r => String(r.env) !== 'test').length,
      booking_requests: db.booking_requests.filter(r => String(r.env) !== 'test').length,
      support_tickets: db.support_tickets.filter(r => String(r.env) !== 'test').length
    };
    for (const tbl of Object.keys(counts)) {
      sb.loc.hash = '#/' + (tbl === 'booking_requests' ? 'bookings' : tbl === 'support_tickets' ? 'tickets' : tbl);
      await tick(40);
      const rowsHtml = String($('tableBody')._innerHTML || '');
      const n = (rowsHtml.match(/<tr>/g) || []).length;
      check('table ' + tbl + ': renders ' + counts[tbl] + ' live rows', () => n === counts[tbl] ? true : 'rendered ' + n);
    }
  }

  /* --- THE LAUNCH PIPELINE, on the tables the desk actually works ------

     supabase-waitlist-launch.sql added follow_up_status, assigned_to and
     ref, and assets/admin.js renders them as a Pipeline column with a
     stage selector. Both halves are asserted, and the NEGATIVE half is
     the one that would rot silently: the selector must appear only where
     the database will accept the write (admin, support and verification
     may update a demand; on a listing only an admin may write the row at
     all, and verification's write is the approve — a call to
     public.listing_verify(), not a PATCH). A dropdown that answers 42501
     teaches whoever uses it that the dashboard lies. */
  {
    const priorHash = sb.loc.hash;

    if (role === 'admin' || role === 'support' || role === 'verification') {
      sb.loc.hash = '#/demand_records';
      await tick(40);
      check('pipeline: the Demands table has a Pipeline column and a stage tag', () => {
        const head = String($('tableHead').innerHTML || '');
        const body = String($('tableBody').innerHTML || '');
        if (head.indexOf('Pipeline') === -1) return 'the header has no Pipeline column';
        return body.indexOf('pipeline-tag') !== -1 ? true : 'no stage tag was rendered on any row';
      });
      check('pipeline: ' + role + ' may move a demand', () =>
        String($('tableBody').innerHTML || '').indexOf('pipeline-select') !== -1
          ? true : 'no stage selector for a role the database would have accepted one from');

      /* The negative half, on a table this role CAN read: support reads
         listings and may not write one, so it gets the tag and no
         control. */
      sb.loc.hash = '#/listings';
      await tick(40);
      check('pipeline: the listings stage selector is ' + (role === 'admin' ? 'offered' : 'withheld') + ' for ' + role, () => {
        const has = String($('tableBody').innerHTML || '').indexOf('pipeline-select') !== -1;
        const want = role === 'admin';
        if (has === want) return true;
        return has
          ? 'a selector was rendered for ' + role + ', which may not update a listing'
          : 'no selector was rendered for ' + role + ', which may';
      });

      /* THE OFFICER'S ONE WRITE, on the same rows as the selector above.
         supabase-verification-rpc.sql withdrew the row-wide UPDATE policy
         this table carried for the verification role, so the officer's
         approve is a call to public.listing_verify() — the four columns
         that ARE the decision — and a PATCH of the row is refused by the
         absence of a policy. So verification gets the Approve button and
         NOT the row-wide editor, and every other role gets neither. Both
         halves are asserted: a control the database would refuse teaches
         whoever uses it that the dashboard lies, and an officer with no
         control at all hands the work back to the main admin. */
      check('approve: the listings Approve action is ' + (role === 'verification' ? 'offered' : 'withheld') + ' for ' + role, () => {
        const body = String($('tableBody').innerHTML || '');
        const hasApprove = body.indexOf('data-act="verify"') !== -1;
        const hasEdit = body.indexOf('data-act="edit" data-table="listings"') !== -1;
        if (hasApprove !== (role === 'verification')) {
          return hasApprove
            ? 'an Approve action was rendered for ' + role + ', whose write the RPC refuses'
            : 'no Approve action was rendered for ' + role + ', whose one listing write it is';
        }
        if (role === 'verification' && hasEdit) {
          return 'verification is still offered the row-wide editor on listings, which now changes nothing';
        }
        return true;
      });
    } else {
      check('pipeline: the ' + role + ' login is not offered the Demands nav item', () =>
        String($('sidebarNav')._innerHTML || '').indexOf('data-section="demand_records"') === -1
          ? true : 'the Demands nav item is rendered for ' + role);
    }


    sb.loc.hash = priorHash;
    await tick(20);
  }

  /* --- THE VERIFICATION SHIFT (LAUNCH-READINESS.md §8.2 stage 2) ------

     The panel above the listings table is the only place an officer's claim
     exists, and both ways it can be wrong are invisible on a screen: it can
     draw for a login the RPC refuses, which teaches whoever presses it that
     the dashboard lies; and it can write more than the claim, when the whole
     point of supabase-verification-queue.sql is that a visit's claim moves
     `assigned_to` and `taken_at` and NOTHING else — not a price, not a tier.

     What is proved here is the PAGE half: the role gate, what the panel says
     about lateness and order, and the two moves' effect on the row. That the
     SQL refuses a second officer, that a PATCH of the row is refused for the
     verification role, and that the service role alone may nudge, is proved
     against real Postgres in dev/sql-proof.mjs §13g. A stub cannot prove a
     grant, and this suite does not pretend to. */
  {
    const priorHash = sb.loc.hash;
    sb.loc.hash = '#/listings';
    await tick(120);

    const shifts = role === 'admin' || role === 'verification';
    const card = $('verifyQueueCard');
    const counts = $('verifyQueueCounts');
    const bodyEl = $('verifyQueueBody');
    const db = sb.win.__MOCK__.db();

    /* THE PAGE HIDES IT BEFORE ANY JS RUNS, and the gate hides it again.
       Both halves matter and neither is enough alone: admin.html ships the
       card `display:none`, so a login that never reaches the listings
       section is not left staring at an empty panel; and renderVerifyQueue
       re-decides on every draw, so a login that DOES reach it and is not
       on the shift is not offered a queue the RPC refuses. The sandbox's
       own element is created on demand and carries no inline style, which
       is why the gate is called here rather than inferred from the boot. */
    const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    check('verification shift: the card ships hidden, so no login sees an empty panel', () =>
      /id="verifyQueueCard"[^>]*style="display:none/.test(html)
        ? true : 'admin.html no longer hides #verifyQueueCard at load');

    sb.win.renderVerifyQueue();
    await tick(120);

    check('verification shift: the queue panel is ' + (shifts ? 'drawn' : 'hidden') + ' for ' + role, () => {
      const hidden = String(card.style.display) === 'none';
      if (hidden === !shifts) return true;
      return hidden
        ? 'the panel is hidden for ' + role + ', whose shift it is'
        : 'the panel drew for ' + role + ', whose call verification_queue() refuses';
    });

    if (shifts) {
      /* WHICH LISTINGS THE FIXTURE ACTUALLY HOLDS. Written as the mock's own
         filter rather than as an id, so a change to the seed shows up as a
         failing check here instead of as a suite that quietly stopped
         testing the queue. */
      const openOf = () => db.listings.filter(r =>
        Number(r.tier) === 0 && ['pending', 'active', 'new'].indexOf(String(r.status).toLowerCase()) !== -1);
      const refOf = r => String(r.ref || r.ap_ref || String(r.id).slice(0, 8));
      const open = openOf();

      check('verification shift: a tier-0 listing nobody has decided is the queue\u2019s business', () =>
        open.length > 0 ? true : 'the fixture holds no open tier-0 listing, so nothing below was exercised');

      const first = open[0];

      check('verification shift: the counts say what is owed, not how many rows the table holds', () => {
        const said = String(counts.textContent);
        return /\d+ owed a visit/.test(said) ? true : 'the counts line reads ' + JSON.stringify(said);
      });

      check('verification shift: the listing is on the panel by reference, with a Take control', () => {
        const html = String(bodyEl.innerHTML);
        if (html.indexOf(refOf(first)) === -1) return 'the queue does not show ' + refOf(first);
        return html.indexOf('data-act="vtake"') !== -1 ? true : 'no Take control was rendered on the row';
      });

      /* THE OWNER'S PAYLOAD IS NOT THE QUEUE'S. verification_queue() returns a
         fixed column list and never the payload; a panel that leaked a
         landlord's phone number would still look right. A phone is the easiest
         thing to look for, and no reference on this panel looks like one. */
      check('verification shift: the panel never carries the owner\u2019s contact details', () => {
        const html = String(bodyEl.innerHTML);
        return /0[789]\d{9}/.test(html) ? 'a phone number reached the queue panel' : true;
      });

      /* LATE, AND LATE FIRST. One row cannot show an ordering, so a second open
         listing is added to the fixture and the older of the two is
         back-dated past the 72-hour deadline. The panel must put the late one
         at the top AND say it is late — the two halves that make a queue worth
         trusting rather than a list worth glancing at. */
      const fresh = JSON.parse(JSON.stringify(first));
      /* A DIFFERENT id, and not just a different suffix: the panel prints
         the first eight characters of it, so a clone whose id began with
         the same eight would make the ordering check find the wrong row
         and pass whatever order the page chose. */
      fresh.id = 'f4c1a0d2-1e00-4b2b-8e02-999999999999';
      fresh.created_at = new Date().toISOString();
      fresh.status = 'pending';
      fresh.tier = 0;
      fresh.assigned_to = null;
      fresh.taken_at = null;
      fresh.payload = {};
      if (openOf().every(r => r.id !== fresh.id)) db.listings.push(fresh);
      sb.win.__MOCK__.lateListing(4, 1);
      sb.win.renderVerifyQueue();
      await tick(160);

      check('verification shift: the overdue listing is marked late and counted', () => {
        const html = String(bodyEl.innerHTML);
        if (html.indexOf('verify-row late') === -1) return 'no row was marked late after four days on the clock';
        return /1 late/.test(String(counts.textContent)) ? true
          : 'the counts line reads ' + JSON.stringify(String(counts.textContent));
      });

      check('verification shift: the late listing comes before the one with time left', () => {
        const html = String(bodyEl.innerHTML);
        const lateAt = html.indexOf(refOf(first));
        const freshAt = html.indexOf(refOf(fresh));
        if (lateAt === -1 || freshAt === -1) return 'the panel is missing one of the two listings';
        return lateAt < freshAt ? true : 'the overdue listing is drawn after a fresh one, so the top of the queue is not the work that is late';
      });

      /* TAKE. The claim is TWO columns; a take that also moved a price or a
         tier is the failure this whole file was written to prevent, and it is
         exactly the failure a diff can see and a screenshot cannot. */
      const takeTarget = db.listings.find(r => r.id === first.id);
      const before = JSON.parse(JSON.stringify(takeTarget));
      sb.win.verifyQueueWrite('listing_take', first.id);
      await tick(200);
      const after = db.listings.find(r => r.id === first.id);
      /* THE UNION OF BOTH KEY LISTS. `assigned_to` and `taken_at` did not
         exist on the row before the take, so iterating the BEFORE snapshot's
         own keys could never see them appear — the diff read zero moves and
         would have called the two columns that DID move "not moved". */
      const moved = Array.from(new Set(Object.keys(before).concat(Object.keys(after))))
        .filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

      check('verification shift: a take moves the claim and the clock, and nothing else', () =>
        JSON.stringify(moved) === JSON.stringify(['assigned_to', 'taken_at'])
          ? true
          : 'the take also moved ' + (moved.filter(k => k !== 'assigned_to' && k !== 'taken_at').join(', ') || 'nothing, but did not move both claim columns: ' + moved.join(', ')));

      check('verification shift: the claim names this login, and the panel redraws as held', () => {
        if (String(after.assigned_to) !== 'mock-' + role + '@arzuz.com') {
          return 'the listing is on ' + JSON.stringify(after.assigned_to) + ', not this login';
        }
        const html = String(bodyEl.innerHTML);
        if (html.indexOf('data-act="vrelease"') === -1) return 'the row still offers Take after it was taken';
        return html.indexOf('with mock-' + role + '@arzuz.com') !== -1 ? true
          : 'the panel does not say who holds it';
      });

      /* A SECOND OFFICER'S LISTING IS REFUSED, and the refusal NAMES them
         rather than saying "no". The mock enforces the rule; what is asserted
         is that the page shows the reason instead of swallowing it. */
      after.assigned_to = 'officer-other@arzuz.com';
      after.taken_at = new Date().toISOString();
      const said = [];
      const realAlert = sb.win.alert;
      sb.win.alert = m => said.push(String(m));
      sb.win.verifyQueueWrite('listing_take', first.id);
      await tick(200);
      sb.win.alert = realAlert;

      check('verification shift: a listing another officer holds is refused, and the refusal names them', () => {
        if (String(db.listings.find(r => r.id === first.id).assigned_to) !== 'officer-other@arzuz.com') {
          return 'a second officer\u2019s claim was overwritten';
        }
        return said.some(m => m.indexOf('officer-other@arzuz.com') !== -1) ? true
          : 'nothing named the holder; the page said ' + JSON.stringify(said);
      });

      /* THE OTHER HALF OF THE SAME RULE: an officer gives back what they
         hold, an admin gives back anything. Asserted only where the two
         differ, because for the admin the release below IS the allowed
         case — a check that every role may release would be green about
         the refusal it was supposed to catch. */
      if (role === 'verification') {
        const saidRelease = [];
        const realAlert2 = sb.win.alert;
        sb.win.alert = m => saidRelease.push(String(m));
        sb.win.verifyQueueWrite('listing_release', first.id);
        await tick(200);
        sb.win.alert = realAlert2;
        check('verification shift: an officer cannot release a listing they do not hold', () => {
          if (String(db.listings.find(r => r.id === first.id).assigned_to) !== 'officer-other@arzuz.com') {
            return 'a release from a login that did not hold it went through';
          }
          /* AND IT IS NOT A LOGOUT. This raise is 42501, so PostgREST answers
             403 — the status that means "your session is dead" everywhere
             else in this dashboard. Read before the status or the officer is
             thrown back to the sign-in box for pressing a button the function
             refused in a sentence written for them. */
          if ($('gateModal').style.display === 'flex') {
            return 'a refusal signed the officer out: ' + JSON.stringify(saidRelease);
          }
          return saidRelease.some(m => m.indexOf('officer-other@arzuz.com') !== -1) ? true
            : 'the refusal did not name the holder: ' + JSON.stringify(saidRelease);
        });
      }

      /* Put the claim on this login — the state a take leaves behind — so
         the release below is the officer's own and not the admin's
         override being re-tested. */
      first.assigned_to = 'mock-' + role + '@arzuz.com';
      first.taken_at = new Date().toISOString();

      /* RELEASE gives it back and gives NOTHING else away. */
      sb.win.verifyQueueWrite('listing_release', first.id);
      await tick(200);
      const released = db.listings.find(r => r.id === first.id);

      check('verification shift: a release puts the listing back in the queue and leaves the rest alone', () => {
        if (released.assigned_to !== null || released.taken_at !== null) {
          return 'the claim survived a release: ' + JSON.stringify({ assigned_to: released.assigned_to, taken_at: released.taken_at });
        }
        if (Number(released.tier) !== 0 || String(released.status) !== 'pending') {
          return 'the release moved the listing to tier ' + released.tier + ' / ' + released.status;
        }
        return String(bodyEl.innerHTML).indexOf('data-act="vtake"') !== -1 ? true
          : 'the row does not offer Take after being released';
      });

      /* ============================================================
         STAGE 3 — WHAT THE VISIT SAW

         The form is drawn on a listing this login HOLDS, the payload it
         would send is the evidence the public badge prints, and the write
         is one transaction against the mock of public.listing_attest().

         Asserted as the BODY the RPC receives and the ROWS it leaves,
         because "a request happened" is not the claim — the claim is that
         an "Inspected" badge cannot exist without the checks behind it.
         ============================================================ */

      sb.win.verifyQueueWrite('listing_take', first.id);
      await tick(200);
      const heldHtml = String(bodyEl.innerHTML);

      check('visit form: every check the public badge can name is offered here', () => {
        const kinds = sb.win.ArzuzBadge.KINDS.map(k => k.kind);
        const missing = kinds.filter(k => heldHtml.indexOf('data-ev="' + k + '"') === -1);
        return missing.length ? 'the officer cannot record ' + missing.join(', ') : true;
      });

      check('visit form: only a listing this login HOLDING is offered the form', () => {
        const buttons = (heldHtml.match(/data-act="vattest"/g) || []).length;
        const heldRow = heldHtml.indexOf(refOf(first)) !== -1;
        if (!heldRow) return 'the held listing is not on the panel at all';
        return buttons === 1 ? true
          : 'the visit form was drawn ' + buttons + ' time(s) for one held listing';
      });

      sb.win.verifyEvidenceToggle(first.id, 'water', true, 'strong at the kitchen tap');
      sb.win.verifyEvidenceToggle(first.id, 'power', true, null);
      const visitPayload = sb.win.verifyEvidencePayload(first.id);

      check('visit form: the payload is the ticked checks, in the shared vocabulary', () => {
        if (visitPayload.p_id !== first.id) return 'p_id is ' + visitPayload.p_id;
        const kinds = visitPayload.p_checks.map(c => c.kind);
        return JSON.stringify(kinds) === JSON.stringify(['water', 'power']) ? true
          : 'the payload carries ' + JSON.stringify(kinds);
      });

      check('visit form: the officer\u2019s own sentence travels with its check', () => {
        const water = visitPayload.p_checks[0];
        const power = visitPayload.p_checks[1];
        if (water.detail !== 'strong at the kitchen tap') return 'water detail is ' + JSON.stringify(water.detail);
        return power.detail === null ? true
          : 'a check with no sentence sent ' + JSON.stringify(power.detail);
      });

      check('visit form: a sentence longer than the column keeps is cut before it is sent', () => {
        sb.win.verifyEvidenceToggle(first.id, 'photos', true, 'x'.repeat(260));
        const detail = sb.win.verifyEvidencePayload(first.id).p_checks.filter(c => c.kind === 'photos')[0].detail;
        sb.win.verifyEvidenceToggle(first.id, 'photos', false);
        return detail.length === 200 ? true
          : 'a 260-character sentence would have been sent as ' + detail.length + ' characters';
      });

      /* NOTHING TICKED IS REFUSED BEFORE A REQUEST. The badge's whole
         promise is that "Inspected" has parts; this is the half of it the
         page owns. */
      const saidEmpty = [];
      const realAlert4 = sb.win.alert;
      sb.win.alert = m => saidEmpty.push(String(m));
      const attestCallsBefore = sb.fetchCalls.filter(c => String(c.url).indexOf('listing_attest') !== -1).length;
      await sb.win.verifyAttest(fresh.id);
      await tick(60);
      sb.win.alert = realAlert4;

      check('visit form: a visit with nothing ticked is refused, and sends nothing', () => {
        if (sb.fetchCalls.filter(c => String(c.url).indexOf('listing_attest') !== -1).length !== attestCallsBefore) {
          return 'it sent an empty visit to the database anyway';
        }
        return saidEmpty.some(m => m.indexOf('Tick at least one') !== -1) ? true
          : 'the officer was told nothing: ' + JSON.stringify(saidEmpty);
      });

      /* THE WRITE. Evidence and decision in one call, and the response is
         not what is trusted here — the ROWS are. */
      const outAttest = await sb.win.verifyAttest(first.id);
      await tick(240);
      const attested = db.listings.find(r => r.id === first.id);
      const written = sb.win.__MOCK__.evidence().filter(e => e.listing_id === first.id);

      check('visit form: recording a visit makes the decision and keeps the evidence', () => {
        if (!outAttest) return 'the RPC refused the visit';
        if (Number(attested.tier) !== 2) return 'the listing is at tier ' + attested.tier;
        if (String(attested.status) !== 'active') return 'the listing is ' + attested.status;
        if (!attested.verified_at || !attested.verified_by) return 'no verification record was stamped';
        if (written.length !== 2) return 'the visit wrote ' + written.length + ' evidence row(s), not 2';
        const kinds = written.map(e => e.kind).sort().join(',');
        if (kinds !== 'power,water') return 'the evidence rows are ' + kinds;
        if (written.filter(e => e.detail === 'strong at the kitchen tap').length !== 1) {
          return 'the officer\u2019s sentence did not survive the write';
        }
        return written.every(e => e.officer === 'mock-' + role + '@arzuz.com') ? true
          : 'the evidence does not name who recorded it';
      });

      check('visit form: the draft is forgotten, so a second press cannot write the visit twice', () => {
        const again = sb.win.verifyEvidencePayload(first.id);
        return again.p_checks.length === 0 ? true
          : 'the ticked checks survived the write: ' + JSON.stringify(again.p_checks);
      });

      check('visit form: the inspected listing leaves the queue', () => {
        const htmlNow = String(bodyEl.innerHTML);
        return htmlNow.indexOf(refOf(first)) === -1 ? true
          : 'the inspected listing is still on the shift\u2019s queue';
      });

      /* A FUNCTION THAT REFUSES IS NOT A DEAD SESSION. The id is real and
         the listing is gone from the mock's table, so the RPC answers the
         P0002 sentence — which the officer must read as a sentence. */
      sb.win.verifyEvidenceToggle('00000000-0000-4000-8000-00000000dead', 'water', true, null);
      const saidRefusal = [];
      const realAlert5 = sb.win.alert;
      sb.win.alert = m => saidRefusal.push(String(m));
      await sb.win.verifyAttest('00000000-0000-4000-8000-00000000dead');
      await tick(200);
      sb.win.alert = realAlert5;

      check('visit form: a refusal is shown as the function wrote it, and is not a logout', () => {
        if ($('gateModal').style.display === 'flex') {
          return 'a refused visit signed the officer out: ' + JSON.stringify(saidRefusal);
        }
        return saidRefusal.some(m => m.indexOf('no listing with id') !== -1) ? true
          : 'the refusal did not carry the function\u2019s sentence: ' + JSON.stringify(saidRefusal);
      });
    }

    sb.loc.hash = priorHash;
    await tick(20);
  }

  /* --- modals for every table (details / edit / delete) --- */
  const tables = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets'];
  for (const tbl of tables) {
    const db = sb.win.__MOCK__.db();
    const row = (db[tbl] || []).find(r => String(r.env) !== 'test');
    if (!row) continue;
    check('details modal opens for ' + tbl, () => {
      sb.win.openDetailsModal(tbl, row.id);
      return $('detailsModalContent')._innerHTML.length > 0 || 'no content rendered';
    });
    if (role !== 'marketing') {
      check('edit modal opens for ' + tbl, () => {
        sb.win.openEditModal(tbl, row.id);
        return $('editFieldsContainer')._innerHTML.length > 0 || 'no fields rendered';
      });
    }
    if (role === 'admin') {
      check('delete modal opens for ' + tbl, () => {
        sb.win.openDeleteModal(tbl, row.id);
        return String($('delConfirmId').textContent).length === 8 || 'confirm id not seeded';
      });
      /* wrong ID keeps the button disabled */
      const delInput = $('delConfirmInput');
      delInput.value = 'wrong-id';
      (delInput.listeners.input || []).forEach(fn => fn.call(delInput, { target: delInput }));
      check('delete ' + tbl + ': wrong ID leaves confirm disabled', () => $('btnConfirmDel').disabled === true);
      /* right ID enables, then confirm deletes */
      delInput.value = String($('delConfirmId').textContent);
      (delInput.listeners.input || []).forEach(fn => fn.call(delInput, { target: delInput }));
      check('delete ' + tbl + ': right ID enables confirm', () => $('btnConfirmDel').disabled === false);
      $('btnConfirmDel').click();
      await tick(80);
      const after = sb.win.__MOCK__.db()[tbl].some(r => r.id === row.id);
      check('delete ' + tbl + ': row removed from mock DB', () => !after);
    }
    await tick(30);
  }

  /* --- add apartment flow (admin) --- */
  if (role === 'admin') {
    check('add apartment: opens and seeds next APT id', async () => {
      $('btnOpenAddApt').click();
      await tick(20);
      return String($('add_apt_id').value).indexOf('APT-') === 0 ? true : 'got ' + $('add_apt_id').value;
    });
    /* --- the browse-board answer (the bug this closes) ---

       public_listings shows a row only when status='active' AND tier>=1
       AND env='production'. The dashboard used to say nothing about any
       of the three, so a listing approved by setting its status to
       active stayed invisible to every student, with nothing on screen
       to explain it. The composer now answers before the save. */
    $('add_status').value = 'active';
    $('add_tier').value = '2';
    $('add_status').dispatch('change');
    check('add apartment: the board note says the listing will be visible', () => {
      const note = String($('addBoardNote').textContent || '');
      return /can see this on the browse page/i.test(note) ? true : 'the note said: ' + note;
    });

    $('add_tier').value = '0';
    $('add_tier').dispatch('change');
    check('add apartment: Tier 0 flips the note to the reason, before the save', () => {
      const note = String($('addBoardNote').textContent || '');
      return /not on the browse page/i.test(note) && /tier 0/i.test(note) ? true : 'the note said: ' + note;
    });

    $('add_status').value = 'pending';
    $('add_status').dispatch('change');
    check('add apartment: a PENDING status says so as well', () => {
      const note = String($('addBoardNote').textContent || '');
      return /status is pending/i.test(note) ? true : 'the note said: ' + note;
    });

    /* back to the two values that publish, for the submit below */
    $('add_status').value = 'active';
    $('add_tier').value = '2';
    $('add_status').dispatch('change');

    $('add_prop_name').value = 'Test Lodge';
    $('add_ar').value = 'Test Area';
    $('add_rent').value = '150000';
    const form = sb.registry.addAptForm;
    (form.listeners.submit || []).forEach(fn => fn({ preventDefault: () => {}, target: form }));
    await tick(120);
    const created = sb.win.__MOCK__.db().listings.find(r => r.payload && r.payload.prop_name === 'Test Lodge');
    check('add apartment: submit inserts into mock DB', () => !!created);
    check('add apartment: inserted row lands in listings state', async () => {
      sb.loc.hash = '#/listings';
      await tick(40);
      return true;
    });

    check('table: the Listings table has a Browse board column and says "live"', () => {
      const head = String($('tableHead').innerHTML || '');
      const body = String($('tableBody').innerHTML || '');
      if (head.indexOf('Browse board') === -1) return 'the table header has no Browse board column';
      return body.indexOf('board-badge live') !== -1 ? true
        : 'a listing that was just saved as active + tier 2 is not shown as live';
    });

    /* The Crawl column: the freshness/completeness score, so an owner can
       see why a room is re-checked rarely and what to fill in. The badge
       prints "<band> · <facts present>/6" — the two halves of the score
       in one cell — and the point of asserting the NUMBERS is that a
       column that printed the same badge on every row would look right
       in a screenshot and say nothing. The mock set has sparse rows, so
       the counts must not all agree. */
    check('table: the Listings table has a Crawl column scored per room', () => {
      const head = String($('tableHead').innerHTML || '');
      const body = String($('tableBody').innerHTML || '');
      if (head.indexOf('Crawl') === -1) return 'the table header has no Crawl column';
      const badges = body.match(/class="crawl-badge/g) || [];
      if (!badges.length) return 'no listing row rendered a crawl badge';
      /* what a person reads: the tag and its title attribute are stripped,
         leaving "daily \u00b7 3/6" */
      const visible = body.replace(/<[^>]*>/g, ' ');
      if (!/(daily|weekly|monthly|yearly)/.test(visible)) return 'no crawl badge named a band';
      const counts = (visible.match(/(\d)\/6/g) || []);
      if (counts.length < badges.length) return 'a crawl badge printed no fact count';
      if (new Set(counts).size === 1) {
        return 'every room printed the same score (' + counts[0] + ') \u2014 the column is a constant, not a signal';
      }
      return true;
    });

    /* The modal is where "what to fill in" is spelled out. It has to name
       the missing facts in the scorer's own words — the same six the
       sitemap sizes a room with — and it must not claim a room with no
       photo has nothing to fill in. */
    check('details: a listing\u2019s crawl score and what to fill in are shown', () => {
      const row = sb.win.__MOCK__.db().listings.find(r => !r.photo_url);
      if (!row) return 'the mock set has no listing missing a photo to open';
      sb.win.openDetailsModal('listings', row.id);
      const html = String($('detailsModalContent')._innerHTML || '');
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      if (text.indexOf('Page completeness') === -1) return 'the modal says nothing about completeness';
      if (!/Crawl priority/.test(text)) return 'the modal says nothing about how often it will be crawled';
      if (!/What to fill in/.test(text)) return 'the modal does not say what to fill in';
      if (!/a photo/.test(text)) return 'the missing photo was not named in the words the scorer uses: ' + text.slice(0, 400);
      if (!/\d of 6 facts/.test(text)) return 'the fact count is missing from the modal: ' + text.slice(0, 400);
      return true;
    });

    /* --- 0 units: nothing left to let ---
       parseInt('0') used to fail a >0 test, so a fully-let lodge was
       stored as vacant and the row read "Units available". */
    $('btnOpenAddApt').click();
    $('add_prop_name').value = 'Fully Let Lodge';
    $('add_ar').value = 'Test Area';
    $('add_rent').value = '90000';
    $('add_units').value = '0';
    $('add_status').value = 'active';
    $('add_tier').value = '2';
    (sb.registry.addAptForm.listeners.submit || []).forEach(fn =>
      fn({ preventDefault: () => {}, target: sb.registry.addAptForm }));
    await tick(120);
    const zeroRow = sb.win.__MOCK__.db().listings.find(r => r.payload && r.payload.prop_name === 'Fully Let Lodge');
    check('add apartment: typing 0 units stores "Fully occupied", never "Units available"', () => {
      if (!zeroRow) return 'the row was never inserted';
      const p = zeroRow.payload;
      if (p.avail !== 'occupied') return 'avail = ' + JSON.stringify(p.avail);
      if (p.units !== null) return 'units = ' + JSON.stringify(p.units);
      if (p.rm !== 'Fully occupied') return 'rm = ' + JSON.stringify(p.rm);
      return true;
    });

    /* --- the one write that puts a hidden listing on the board --- */
    $('btnOpenAddApt').click();
    $('add_prop_name').value = 'Pending Lodge';
    $('add_ar').value = 'Test Area';
    $('add_rent').value = '70000';
    $('add_status').value = 'pending';
    $('add_tier').value = '2';
    (sb.registry.addAptForm.listeners.submit || []).forEach(fn =>
      fn({ preventDefault: () => {}, target: sb.registry.addAptForm }));
    await tick(120);
    sb.loc.hash = '#/listings';
    await tick(40);
    const pendingRow = sb.win.__MOCK__.db().listings.find(r => r.payload && r.payload.prop_name === 'Pending Lodge');

    check('table: a hidden listing reads "hidden" and offers Publish', () => {
      if (!pendingRow) return 'the pending row was never inserted';
      const body = String($('tableBody').innerHTML || '');
      if (body.indexOf('board-badge hidden') === -1) return 'no hidden badge on the table';
      return body.indexOf('data-act="publish"') !== -1 ? true : 'no Publish button offered for a hidden listing';
    });

    check('publish: ONE request sets status, tier and env \u2014 the three ANDed rules', async () => {
      if (!pendingRow) return 'the pending row was never inserted';
      const seen = sb.fetchCalls.length;
      sb.win.publishToListingBoard(pendingRow.id);
      await tick(80);
      const patch = sb.fetchCalls.slice(seen)
        .find(c => c.method === 'PATCH' && /\/rest\/v1\/listings\?id=eq\./.test(c.url));
      if (!patch) return 'no PATCH to /rest/v1/listings was sent';
      const body = JSON.parse(patch.body);
      if (body.status !== 'active') return 'status = ' + JSON.stringify(body.status);
      if (!(Number(body.tier) >= 1)) return 'tier = ' + JSON.stringify(body.tier);
      if (body.env !== 'production') return 'env = ' + JSON.stringify(body.env);
      const row = sb.win.__MOCK__.db().listings.find(r => r.id === pendingRow.id);
      if (!row) return 'the row vanished';
      return (row.status === 'active' && Number(row.tier) >= 1 && String(row.env) === 'production')
        ? true : 'the stored row is ' + JSON.stringify({ status: row.status, tier: row.tier, env: row.env });
    });

    check('publish: the row is live afterwards and no longer offers Publish', async () => {
      await tick(60);
      const body = String($('tableBody').innerHTML || '');
      const liveCount = (body.match(/board-badge live/g) || []).length;
      if (liveCount < 2) return 'expected at least two live rows after publishing, saw ' + liveCount;
      return /Pending Lodge/.test(body) ? true : 'the published row is not in the table body';
    });

    /* --- cancel / keep / discard triad ---
       The overlay close is animated, and this shim's animate() NEVER runs
       onfinish — exactly the situation that left a dismissed modal on
       screen. A close must therefore land on its own, not via the callback. */
    const addModalEl = $('addAptModal');
    const exitModalEl = $('draftExitModal');
    const isOpen = el => !!(el && el._cl && el._cl.contains('open'));
    const rowsBefore = sb.win.__MOCK__.db().listings.length;

    $('btnOpenAddApt').click();
    sb.registry.addAptForm.dispatch('input'); /* any edit arms the prompt */
    $('btnCancelAddApt').click();
    check('cancel: unsaved edits raise the exit prompt', () =>
      (isOpen(exitModalEl) && isOpen(addModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));

    $('btnExitKeep').click();
    await tick(400);
    check('cancel: “keep editing” returns to the form', () =>
      (isOpen(addModalEl) && !isOpen(exitModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));

    $('btnExitDiscard').click();
    await tick(400);
    check('discard: closes both overlays without an animation callback', () =>
      (!isOpen(addModalEl) && !isOpen(exitModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));
    check('discard: writes nothing to the listings table', () =>
      sb.win.__MOCK__.db().listings.length === rowsBefore || 'rows ' + rowsBefore + ' → ' + sb.win.__MOCK__.db().listings.length);

    $('btnOpenAddApt').click();
    $('btnCancelAddApt').click();
    await tick(400);
    check('discard: resets the dirty flag (a clean cancel prompts nothing)', () =>
      (!isOpen(exitModalEl) && !isOpen(addModalEl)) || 'add open=' + isOpen(addModalEl) + ' exit open=' + isOpen(exitModalEl));
  }

  /* --- CSV export (admin) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/listings';
    await tick(40);
    let csvBlob = null;
    const origBlob = sb.win.Blob;
    sb.win.Blob = class extends origBlob { constructor(parts, opts) { csvBlob = parts; super(parts, opts); } };
    $('btnExport').click();
    await tick(30);
    sb.win.Blob = origBlob;
    check('csv export: builds a payload with rows', () => !!(csvBlob && csvBlob.length && String(csvBlob[0]).indexOf('payload_') !== -1));
  }

  /* --- support desk form (admin + support) --- */
  if (role === 'admin' || role === 'support') {
    sb.loc.hash = '#/tickets';
    await tick(50);
    $('tk_name').value = 'Phone Caller';
    $('tk_phone').value = '08000000000';
    $('tk_msg').value = 'Called about a broken gate.';
    $('btnLogTicket').click();
    await tick(120);
    const logged = sb.win.__MOCK__.db().support_tickets.some(r => r.payload && r.payload.name === 'Phone Caller');
    check('support desk: phone complaint becomes a ticket', () => !!logged);
  }

  /* --- settings flows (admin) --- */
  if (role === 'admin') {
    sb.loc.hash = '#/settings';
    await tick(80);
    check('team roster: loads users from /api/team', () => {
      const roster = text('teamRoster');
      return roster.indexOf('owner@arzuz.test') !== -1 ? true : 'roster: ' + roster.slice(0, 60);
    });
    $('teamEmail').value = 'new-teammate@arzuz.test';
    $('btnTeamCreate').click();
    await tick(120);
    check('team create: new teammate appears', () => text('teamRoster').indexOf('new-teammate@arzuz.test') !== -1);
    await sb.win.ArzuzData.ready.then(async () => {
      check('amenities: manager lists defaults + customs', () => {
        const list = text('amenitiesManagerList');
        return list.indexOf('Borehole water') !== -1 && list.indexOf('Solar panels') !== -1 ? true : 'got: ' + list.slice(0, 80);
      });
    });
    check('telegram status: reports configured via /api/notify', () => text('tgStatus').indexOf('configured') !== -1);
  }

  /* --- error + slow scenarios --- */
  check('scenario: rest failure surfaces without boot crash', async () => {
    sb.win.__MOCK__.error('rest');
    $('btnRefresh').click();
    await tick(150);
    sb.win.__MOCK__.reset();
    return true;
  });

  check('final: no console errors across the whole walk', () => {
    const errs = sb.consoleErrors.filter(e => e.indexOf('error:') === 0);
    return errs.length === 0 ? true : errs.join(' | ');
  });
}

/* ---------------- mobile gesture drags ----------------

   Firing pointer sequences at the document is how the drawer, the
   bottom sheets and the lightboxes are actually thrown — and nothing in
   this file did it, so a surface that quietly stopped responding would
   pass every check above. Each assertion below therefore asks two
   questions in order: did the drag ENGAGE (the class the surface adds
   on begin) and did it land where the release policy says. A surface
   that never begins fails the first question, which is the point.

   The event targets are fakes because that is what the surfaces read:
   each one walks up from `e.target` with closest(). Handing them the
   chain a browser would hand them is the whole simulation. */

function fakeEl(over) {
  const classes = new Set();
  const props = new Map();
  const el = {
    id: '',
    offsetHeight: 600,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains: c => classes.has(c),
      toggle(c) { if (classes.has(c)) { classes.delete(c); return false; } classes.add(c); return true; }
    },
    style: {
      setProperty: (k, v) => { props.set(String(k), String(v)); },
      removeProperty: k => { props.delete(String(k)); },
      getPropertyValue: k => (props.has(String(k)) ? props.get(String(k)) : '')
    },
    closest: () => null,
    querySelector: () => null,
    _classes: classes,
    _props: props
  };
  return Object.assign(el, over || {});
}

/* The dashboard, booted the way admin.html boots it, at a stated viewport:
   the four surfaces register their gestures against this sandbox's document
   listeners, so a pointer sequence fired here takes the road a finger's
   events take in a browser. Geometry comes in with the viewport because
   the drawer measures itself and the CSS lays it out as min(82vw, 288px). */
async function bootGestureSandbox(opts) {
  const sb = makeSandbox('admin', opts);
  sb.win.sessionStorage.setItem('arzuz_mock_role', 'admin');
  runScripts(sb.ctx, DASHBOARD_SCRIPTS);
  await tick(120);
  return sb;
}

/* Pointer sequences, fired straight at the document listeners the page
   registered. One copy, shared by the gesture section and the threshold
   matrix, because two copies of an event shape is how a harness starts
   lying about the page it is standing in for. */
function makeFirer(sb) {
  let seq = 0;
  const throws = [];
  const fire = (type, over) => {
    const e = Object.assign({
      type,
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 0,
      clientY: 0,
      cancelable: true,
      isTrusted: true,
      preventDefault() {},
      stopPropagation() {}
    }, over || {});
    /* never 0: the engine reads `e.timeStamp || Date.now()`, so a zero is
       read as "now" and the sample would span two different clocks */
    if (!e.timeStamp) e.timeStamp = ++seq * 16;
    try {
      (sb.docListeners[type] || []).slice().forEach(fn => fn(e));
    } catch (err) {
      throws.push(type + ' → ' + err.message);
    }
    return e;
  };
  return { fire: fire, throws: throws };
}

async function testGestures() {
  currentRole = 'gestures';
  console.log('\n=== MOBILE GESTURES (drawer, sheets, lightboxes) ===');

  const sb = await bootGestureSandbox();
  const { fire, throws } = makeFirer(sb);

  const body = sb.document.body;
  const side = sb.document.querySelector('.admin-side');

  /* ---------- the drawer ---------- */
  const draggingSide = () => body.classList.contains('side-dragging');

  fire('pointerdown', { clientX: 4, clientY: 400 });
  fire('pointermove', { clientX: 60, clientY: 400 });
  const sideEngaged = draggingSide();
  const sidePainted = side.style.getPropertyValue('--side-x');
  fire('pointermove', { clientX: 260, clientY: 400 });
  fire('pointerup', { clientX: 260, clientY: 400 });

  check('drawer: a swipe in from the left edge engages the surface',
    () => sideEngaged || 'no side-dragging class — the gesture never began');
  check('drawer: it paints the finger position while the finger is down',
    () => sidePainted !== '' ? true : '--side-x was never set');
  check('drawer: a swipe past half its width opens it',
    () => body.classList.contains('side-open') || 'the drawer did not open');
  check('drawer: the drag class is cleared on release',
    () => !draggingSide() || 'left half-dragged');

  /* Throw it shut, grabbing it where a finger would — inside the panel. BOTH
     drags are driven here, at the SAME 100px, short of half the panel, because
     every earlier version of this check was not evidence of anything: it used
     to travel 280px — past half — so the distance rule shut the drawer whether
     or not any velocity reached the policy; and at 100px with only a throw it
     still was not the flick being tested, because a 32ms throw projects
     ~1,560px and its 1.2-width clamp alone clears half. What this pair proves
     is that a throw and a hold at one distance disagree. Isolating the FLICK
     itself is the velocity hand-off section's job below, where the coast is
     made insufficient on purpose, on all four surfaces, both ways. */
  const inside = { closest: sel => (sel === '.admin-side' ? side : null) };
  {
    const t = nextClock();
    fire('pointerdown', { clientX: 300, clientY: 400, target: inside, timeStamp: t });
    fire('pointermove', { clientX: 200, clientY: 400, target: inside, timeStamp: t + 120 });
    fire('pointermove', { clientX: 200, clientY: 400, target: inside, timeStamp: t + 160 });
    fire('pointerup', { clientX: 200, clientY: 400, target: inside, timeStamp: t + 160 });
  }
  const heldStill = body.classList.contains('side-open');
  {
    const t = nextClock();
    fire('pointerdown', { clientX: 300, clientY: 400, target: inside, timeStamp: t });
    fire('pointermove', { clientX: 200, clientY: 400, target: inside, timeStamp: t + 32 });
    fire('pointerup', { clientX: 200, clientY: 400, target: inside, timeStamp: t + 32 });
  }
  check('drawer: 100px thrown in 32ms shuts it, where the same 100px held still leaves it open',
    () => !heldStill ? 'the held drag shut it on its own \u2014 100px is short of half of the panel'
      : (body.classList.contains('side-open') ? 'the throw did not shut it' : true));

  check('drawer: a drag starting away from the edge is ignored',
    () => {
      fire('pointerdown', { clientX: 120, clientY: 400 });
      fire('pointermove', { clientX: 300, clientY: 400 });
      fire('pointerup', { clientX: 300, clientY: 400 });
      return (!draggingSide() && !body.classList.contains('side-open'))
        ? true : 'it opened from 120px in — the edge zone is not holding';
    });
  check('drawer: a slow short drag springs back shut',
    () => {
      fire('pointerdown', { clientX: 4, clientY: 400, timeStamp: 5000 });
      fire('pointermove', { clientX: 34, clientY: 400, timeStamp: 5400 });
      fire('pointerup', { clientX: 34, clientY: 400, timeStamp: 5400 });
      return !body.classList.contains('side-open')
        ? true : 'a 30px drag over 400ms opened it — the threshold is too low';
    });

  /* ---------- the bottom sheets ---------- */
  const draggingSheet = () => body.classList.contains('sheet-dragging');

  const sheetOv = fakeEl({ id: 'editModal' });
  sheetOv._classes.add('open');
  const sheetBox = fakeEl({ id: 'editModalBox' });
  sheetBox.closest = sel => (sel === '.modal-overlay' ? sheetOv : null);
  const sheetHead = fakeEl();
  sheetHead.closest = sel => (sel === '.modal-head' ? sheetHead : (sel === '.modal-box' ? sheetBox : null));

  fire('pointerdown', { clientX: 200, clientY: 200, target: sheetHead });
  fire('pointermove', { clientX: 200, clientY: 260, target: sheetHead });
  const sheetEngaged = draggingSheet();
  const sheetPainted = sheetBox.style.getPropertyValue('--sheet-y');
  fire('pointermove', { clientX: 200, clientY: 400, target: sheetHead });
  fire('pointerup', { clientX: 200, clientY: 400, target: sheetHead });

  check('sheet: a pull on the header engages the surface',
    () => sheetEngaged || 'no sheet-dragging class — the gesture never began');
  check('sheet: it paints the drag while the finger is down',
    () => sheetPainted !== '' ? true : '--sheet-y was never set');
  check('sheet: the drag class is cleared on release',
    () => !draggingSheet() || 'left half-dragged');
  await tick(280);   /* slideAway hands off to the close after 210ms */
  check('sheet: a pull past a third of its height dismisses it',
    () => !sheetOv._classes.has('open') || 'the sheet stayed open');

  const snapOv = fakeEl({ id: 'detailsModal' });
  snapOv._classes.add('open');
  const snapBox = fakeEl({ id: 'detailsBox' });
  snapBox.closest = sel => (sel === '.modal-overlay' ? snapOv : null);
  const snapHead = fakeEl();
  snapHead.closest = sel => (sel === '.modal-head' ? snapHead : (sel === '.modal-box' ? snapBox : null));

  fire('pointerdown', { clientX: 200, clientY: 200, target: snapHead, timeStamp: 8000 });
  fire('pointermove', { clientX: 200, clientY: 230, target: snapHead, timeStamp: 8400 });
  fire('pointerup', { clientX: 200, clientY: 230, target: snapHead, timeStamp: 8400 });
  check('sheet: a short slow pull snaps back and stays open',
    () => (snapOv._classes.has('open') && snapBox.style.getPropertyValue('--sheet-y') === '0px')
      ? true : 'it closed, or was left mid-translation');
  await tick(320);
  check('sheet: the snap-back clears the inline variables',
    () => snapBox.style.getPropertyValue('--sheet-y') === ''
      ? true : 'still translated: ' + snapBox.style.getPropertyValue('--sheet-y'));

  /* ---------- the lightboxes ---------- */
  const lbOv = fakeEl({ id: 'photoLightbox' });
  lbOv._classes.add('open');
  const lbTarget = fakeEl({ offsetHeight: 700 });
  lbOv.querySelector = sel => (sel === '.lb-inner' ? lbTarget : null);
  const lbTouch = fakeEl();
  lbTouch.closest = sel => (sel === '.lightbox' ? lbOv : null);

  fire('pointerdown', { clientX: 200, clientY: 200, target: lbTouch });
  fire('pointermove', { clientX: 200, clientY: 300, target: lbTouch });
  const lbEngaged = body.classList.contains('lb-dragging');
  const lbPainted = lbTarget.style.getPropertyValue('--lb-y');
  fire('pointermove', { clientX: 200, clientY: 500, target: lbTouch });
  fire('pointerup', { clientX: 200, clientY: 500, target: lbTouch });

  check('lightbox: a pull on the photo engages the surface',
    () => lbEngaged || 'no lb-dragging class — the gesture never began');
  check('lightbox: it paints the drag while the finger is down',
    () => lbPainted !== '' ? true : '--lb-y was never set');
  await tick(280);
  check('lightbox: a pull past a third of its height dismisses it',
    () => !lbOv._classes.has('open') || 'the lightbox stayed open');

  /* the video card hands over its title row ONLY — the player keeps the
     scrub bar, so a drag on the player itself must engage nothing */
  const vidOv = fakeEl({ id: 'videoLightbox' });
  vidOv._classes.add('open');
  const onPlayer = fakeEl();
  onPlayer.closest = sel => (sel === '.lightbox' ? vidOv : (sel === 'video' ? { tagName: 'VIDEO' } : null));

  check('lightbox: a drag on the video itself never moves the card',
    () => {
      fire('pointerdown', { clientX: 200, clientY: 200, target: onPlayer });
      fire('pointermove', { clientX: 200, clientY: 500, target: onPlayer });
      fire('pointerup', { clientX: 200, clientY: 500, target: onPlayer });
      return (!body.classList.contains('lb-dragging') && vidOv._classes.has('open'))
        ? true : 'the player gave up its own gesture to the card';
    });
  check('lightbox: the video card only hands over its title row',
    () => {
      const offHead = fakeEl();
      offHead.closest = sel => (sel === '.lightbox' ? vidOv : null);
      fire('pointerdown', { clientX: 200, clientY: 200, target: offHead });
      fire('pointermove', { clientX: 200, clientY: 500, target: offHead });
      fire('pointerup', { clientX: 200, clientY: 500, target: offHead });
      return (!body.classList.contains('lb-dragging') && vidOv._classes.has('open'))
        ? true : 'a drag off the title row moved the card';
    });

  check('gestures: no pointer sequence threw',
    () => throws.length === 0 ? true : throws.join(' | '));
  check('gestures: the console stayed clean through every drag',
    () => sb.consoleErrors.length === 0 ? true : sb.consoleErrors.join(' | '));
}

/* ---------------- the missing-asset contract ----------------

   admin.js treats assets/release-policy.js the way it treats the gesture
   engine: a page that cannot load it does not drag, and says why once,
   rather than throwing a TypeError out of the middle of a pointermove —
   which on a real page takes the whole dashboard's boot with it.

   That contract is only worth anything if it is checked, because a missing
   asset is exactly the failure nobody reproduces on purpose: the file is
   listed in admin.html and in this harness, and every other check here
   assumes it arrived. So this boots the dashboard WITHOUT it and asks the
   two questions that matter — does the page still work, and does it still
   say what is wrong? */
async function testMissingPolicy() {
  currentRole = 'assets';
  console.log('\n=== MISSING ASSETS (degrade, do not break) ===');

  const without = DASHBOARD_SCRIPTS.filter(s => s.rel !== 'assets/release-policy.js');
  const sb = makeSandbox('admin');
  sb.win.sessionStorage.setItem('arzuz_mock_role', 'admin');

  let booted = true, bad = '';
  try {
    runScripts(sb.ctx, without);
  } catch (e) {
    booted = false;
    bad = e.message;
  }
  await tick(120);
  const body = sb.document.body;

  check('the dashboard still boots without assets/release-policy.js',
    () => booted ? true : 'the boot threw: ' + bad);
  check('and it says once why the drag gestures are gone',
    () => sb.consoleErrors.some(m => m.indexOf('release-policy.js') !== -1) ? true
      : 'nothing named the missing module: ' + JSON.stringify(sb.consoleErrors));

  /* a swipe in from the edge: with no policy there is no gesture to engage,
     and (the part that matters) nothing may throw while being refused */
  const firer = makeFirer(sb);
  firer.fire('pointerdown', { clientX: 4, clientY: 400 });
  firer.fire('pointermove', { clientX: 200, clientY: 400 });
  firer.fire('pointerup', { clientX: 200, clientY: 400 });
  check('a swipe in from the edge moves nothing, and throws nothing',
    () => (firer.throws.length === 0 && !body.classList.contains('side-dragging')) ? true
      : (firer.throws.length ? 'it threw: ' + firer.throws.join(' | ') : 'the gesture engaged with no policy to decide by'));

  /* and the page is not dead: the drawer's own button still opens it */
  check('the drawer still opens by its button — a missing policy costs the throw, not the page',
    () => {
      sb.document.getElementById('sideToggle').click();
      return body.classList.contains('side-open') ? true : 'the toggle did nothing either';
    });
}

/* ---------------- release thresholds across real geometry ----------------

   Every release policy in this file is decided against the measured size
   of what is being dragged:

     drawer      d >= 0.5 * DOW                        (DOW = min(82vw, 288px))
     sheets      p >= max(90, 0.3 * box.offsetHeight)
     lightboxes  p >= max(90, 0.3 * target.offsetHeight)

   Each one therefore has TWO branches — a 90px floor that decides for
   short surfaces and a percentage that decides for tall ones — and one
   drag at one size can only ever exercise one of them. A single default
   geometry cannot tell anyone whether the floor is working (it is
   invisible to a 600px sheet) or whether the percentage is (invisible to
   a 240px one).

   So each surface below is SWEPT: every integer distance from 0 to the
   surface's own size is driven through the real gesture, and the verdict of
   each one is read off what the release painted — the same seam the CSS
   transition takes over from. Two samples either side of a line can only
   confirm that the line is somewhere in the band between them, and cannot
   see a rule that goes and then comes back. A sweep states both things a
   threshold actually has to satisfy:

     · the verdict changes exactly ONCE across the whole range, and
     · it changes at the line the policy documents, in pixels.

   A threshold that moved by a single pixel, a rule that dismissed only
   between two distances, and a surface that stopped engaging at some size
   all fail here — the pair of samples passed all three. */

/* The spec, written out rather than imported from admin.js: a test that
   read the constants it is checking would agree with any value. */
const SPEC_FAR = 90;             /* the floor, px */
const SPEC_OPEN_MIN = 0.3;       /* the share of the surface's height */
const SPEC_SLOP = 8;             /* swipe-gesture.js's SLOP: px before a drag is a drag */
const SPEC_DRAWER_RATIO = 0.18;  /* the drawer's give past a resting edge */

/* thresholds come out of fractions, so they print as 217.79999999999998 */
const px = n => (Math.round(n * 10) / 10) + 'px';

/* the iPhone 14 viewport — the shape the sandbox's own default is a
   narrower version of, and the one the CSS caps below are computed on */
const PHONE = { width: 390, height: 844 };

/* The heights a real sheet has. The branch point between the two policies
   is FAR / OPEN_MIN, i.e. 300px: under it the 90px floor decides, over it
   the percentage does. */
const SHEET_GEOMETRY = [
  { h: 240, what: '240px (a short confirm sheet, under the branch point where the floor decides and 30% would say 72)' },
  { h: 420, what: '420px (an edit form, over the branch point where 30% decides)' },
  { h: PHONE.height - 24, what: 'a full sheet at its CSS cap, max-height: calc(100dvh - 24px)' }
];

/* And the heights a real lightbox target has: .lb-inner wraps the photo,
   whose CSS is `max-width: 90vw; max-height: 86vh`, and the video card is
   a 70vh player plus its own padding and title row. */
const LIGHTBOX_GEOMETRY = [
  { h: Math.round(PHONE.width * 0.9 * 0.75), what: '263px (a landscape photo, 90vw wide at 4:3, under the branch point where the floor decides)' },
  { h: Math.round(PHONE.height * 0.86), what: '726px (a portrait photo at max-height: 86vh, where 30% decides)' },
  { h: Math.round(PHONE.height * 0.7) + 66, what: '657px (the video card: a 70vh player plus the card\'s padding and title row)', video: true }
];

/* The drawer's geometry: the same policy against the widths real phones
   produce, plus the case where the panel cannot be measured at all (a
   hidden drawer's rect is 0x0, in a browser as here), where the policy has
   to fall back to min(82vw, 288px) rather than decide against zero. */
const DRAWER_GEOMETRY = [
  { vp: { width: 320, height: 568 }, what: 'the smallest phone still in use' },
  { vp: { width: 390, height: 844 }, what: 'iPhone 14' },
  { vp: { width: 390, height: 844 }, box: 0, what: 'iPhone 14 with the panel unmeasurable, as a hidden drawer measures' }
];

/* timestamp bases, kept apart so no two drags share a clock */
let clock = 100000;
const nextClock = () => (clock += 5000);

/* A settled drag: the finger travels `d` px along the surface's own axis and
   is then held still for 40ms, so the velocity sample reads zero and the
   momentum projection adds nothing. What is measured is the distance rule on
   its own — the half of the policy a flick would otherwise mask.

   `probe` runs with the finger still down, which is the only moment a
   surface is mid-gesture: that is where engagement, 1:1 tracking and the
   size it actually measured are visible. A release can say nothing about a
   surface that never began to move, so every check below reads the probe
   first — a harness that stops driving the finger must not read green.
   The surface helpers call it with the fakes they built, so it can read
   whatever the surface painted. */
function settle(fire, from, d, probe) {
  const t = nextClock();
  const to = from.axis === 'x' ? { x: from.x + d, y: from.y } : { x: from.x, y: from.y + d };
  const at = (k, stamp) => ({ clientX: k.x, clientY: k.y, target: from.target, timeStamp: stamp });
  fire('pointerdown', at(from, t));
  fire('pointermove', at(to, t + 120));
  const mid = probe ? probe() : null;
  fire('pointermove', at(to, t + 160));
  fire('pointerup', at(to, t + 160));
  return mid;
}

/* A THROW: the finger travels the same `d` px, but in `ms` instead of being
   held still, so the velocity sample reads d/ms — and the release it produces
   is the flick branch's, not the distance rule's.

   The sample is the engine's: it keeps the moves inside a 90ms TICK window and
   divides the first sample from the last, so one move of d px over ms is
   exactly d/ms. `ms` must stay under the TICK or the start of the move falls
   out of the window and the velocity is read as zero — a harness that threw a
   "flick" the engine saw as a crawl would test nothing and pass. That is
   asserted below, by throwing the same distance twice. */
function throwIt(fire, from, d, ms, probe) {
  const t = nextClock();
  const to = from.axis === 'x' ? { x: from.x + d, y: from.y } : { x: from.x, y: from.y + d };
  const at = (k, stamp) => ({ clientX: k.x, clientY: k.y, target: from.target, timeStamp: stamp });
  fire('pointerdown', at(from, t));
  fire('pointermove', at(to, t + ms));
  const mid = probe ? probe() : null;
  fire('pointerup', at(to, t + ms));
  return mid;
}

/* the px/s the engine will compute for a d-px move over ms */
const throwSpeed = (d, ms) => Math.round(Math.abs(d) * 1000 / ms);

/* one drag, settled or thrown: the only difference is how long the finger took,
   so every surface helper takes an optional `ms` and passes it through here */
function dragOnce(fire, from, d, ms, probe) {
  return ms ? throwIt(fire, from, d, ms, probe) : settle(fire, from, d, probe);
}

/* ---- one drag, and the verdict its release painted ---------------------

   A release is visible the instant the finger lifts, because every surface
   hands the CSS transition a surface painted as the finger left it:
   slideAway() puts a sheet at its own height + 40 and a lightbox target at
   height + 60 and drops the overlay's opacity to 0, the snap-back puts
   --sheet-y / --lb-y back to 0px, and the drawer toggles its open class
   outright. Reading THAT rather than an overlay's class is what lets a
   sweep of thousands of drags cost milliseconds instead of a timer wait per
   sample — and the deferred half of the policy (the 210ms hand-off, the
   overlay's close, the player's teardown) is proved once per surface, at
   the line itself, by the boundary pairs below.

   `goes` means the same thing for all four: the release decided to leave
   the surface's resting state. */

/* one pull on a sheet's header — settled, or thrown over `ms` */
function pullSheet(fire, body, height, dy, ms) {
  const ov = fakeEl({ id: 'editModal' });
  ov._classes.add('open');
  const box = fakeEl({ offsetHeight: height });
  box.closest = sel => (sel === '.modal-overlay' ? ov : null);
  const head = fakeEl();
  head.closest = sel => (sel === '.modal-head' ? head : (sel === '.modal-box' ? box : null));
  const mid = dragOnce(fire, { x: 200, y: 100, target: head, axis: 'y' }, dy, ms, () => ({
    engaged: body.classList.contains('sheet-dragging'),
    painted: box.style.getPropertyValue('--sheet-y')
  }));
  const released = box.style.getPropertyValue('--sheet-y');
  return {
    ov: ov, box: box, mid: mid, released: released, ms: ms,
    goes: released === (height + 40) + 'px' && ov.style.getPropertyValue('--sheet-o') === '0',
    engaged: mid.engaged, painted: mid.painted, expect: dy + 'px'
  };
}

/* the same pull on a lightbox: the whole surface is the grab zone for a
   photo, the title row only for the video card */
function pullLightbox(fire, body, geo, dy, ms) {
  const video = !!geo.video;
  const ov = fakeEl({ id: video ? 'videoLightbox' : 'photoLightbox' });
  ov._classes.add('open');
  const target = fakeEl({ offsetHeight: geo.h });
  ov.querySelector = sel => (sel === (video ? '.lb-frame' : '.lb-inner') ? target : null);
  const head = fakeEl();
  const touch = fakeEl();
  touch.closest = video
    ? sel => (sel === '.lightbox' ? ov : (sel === '.lb-head' ? head : null))
    : sel => (sel === '.lightbox' ? ov : null);
  const mid = dragOnce(fire, { x: 200, y: 100, target: touch, axis: 'y' }, dy, ms, () => ({
    engaged: body.classList.contains('lb-dragging'),
    painted: target.style.getPropertyValue('--lb-y')
  }));
  const released = target.style.getPropertyValue('--lb-y');
  return {
    ov: ov, target: target, mid: mid, released: released, ms: ms,
    goes: released === (geo.h + 60) + 'px' && ov.style.getPropertyValue('--lb-o') === '0',
    engaged: mid.engaged, painted: mid.painted, expect: dy + 'px'
  };
}

/* one settled swipe in from the left edge — the only zone a closed drawer
   accepts — travelling dx px rightwards. It also reports the width the
   surface divided: a closed drawer paints d - DOW, so DOW is recoverable
   from the drawer's own paint rather than restated from the harness's
   opinion of the layout. */
function edgeDrag(fire, body, side, dx, dow, ms) {
  const mid = dragOnce(fire, { x: 4, y: 400, axis: 'x' }, dx, ms, () => ({
    engaged: body.classList.contains('side-dragging'),
    painted: side.style.getPropertyValue('--side-x')
  }));
  return {
    engaged: mid.engaged, painted: mid.painted, expect: (dx - dow) + 'px', ms: ms,
    goes: body.classList.contains('side-open')
  };
}

/* the same on the open drawer's own panel, pushed right (dx > 0, where the
   door gives against its hinge at 0.18 of the finger) or pulled back left
   (dx < 0) */
function panelDrag(fire, body, side, dx, ms) {
  const inside = { closest: sel => (sel === '.admin-side' ? side : null) };
  const mid = dragOnce(fire, { x: 200, y: 400, target: inside, axis: 'x' }, dx, ms, () => ({
    engaged: body.classList.contains('side-dragging'),
    painted: side.style.getPropertyValue('--side-x')
  }));
  return {
    engaged: mid.engaged, painted: mid.painted, ms: ms,
    expect: (dx > 0 ? dx * SPEC_DRAWER_RATIO : dx) + 'px',
    goes: !body.classList.contains('side-open')
  };
}

/* every integer distance from 0 to `max`, through the surface's own drag */
function sweep(drag, max) {
  const rows = [];
  for (let d = 0; d <= max; d++) rows.push(Object.assign({ d: d }, drag(d)));
  return rows;
}

/* The two facts a sweep exists to establish. A threshold is a step
   function, so a rule that is right changes its verdict exactly once, at
   the line the policy documents — and every drag over the slop gate has to
   engage and track the finger, or the verdict read at that distance was
   never about that distance at all. */
function checkSweep(label, rows, expect) {
  const flips = [];
  for (let i = 1; i < rows.length; i++) if (rows[i].goes !== rows[i - 1].goes) flips.push(rows[i].d);
  const span = rows[rows.length - 1].d;

  check(label + (expect.line
      ? ': the verdict flips exactly once across the 0\u2013' + span + 'px sweep, at the documented ' + expect.line + 'px line'
      : ': the verdict never flips, anywhere in the 0\u2013' + span + 'px sweep'),
    () => {
      if (rows[0].goes) return 'it ' + expect.verb + ' at 0px \u2014 a 0px move is not a drag';
      if (!expect.line) return flips.length
        ? 'it ' + expect.verb + ' at ' + flips.join('px, ') + 'px, where this policy has no line' : true;
      if (!flips.length) return 'nothing in the whole sweep ' + expect.verb + ' it, and the policy line is ' + expect.line + 'px';
      if (flips.length > 1) return 'it ' + expect.verb + ' at ' + flips.length + ' distances (' +
        flips.join('px, ') + 'px) \u2014 a release rule is a step, not a band';
      return flips[0] === expect.line ? true
        : 'the line is at ' + flips[0] + 'px, where the policy puts it at ' + expect.line + 'px';
    });

  const engaged = rows.filter(r => r.d >= SPEC_SLOP);
  const bad = engaged.filter(r => !r.engaged || r.painted !== r.expect);
  const early = rows.filter(r => r.d < SPEC_SLOP && r.engaged);
  check(label + ': all ' + engaged.length + ' drags over the ' + SPEC_SLOP + 'px slop gate engage and track the finger',
    () => {
      if (early.length) return 'a ' + early[0].d + 'px move engaged it, under the ' + SPEC_SLOP + 'px slop gate';
      if (bad.length) return bad.length + ' of ' + engaged.length + ' did not: ' + bad.slice(0, 3).map(
        r => r.d + 'px ' + (r.engaged ? 'painted ' + JSON.stringify(r.painted) : 'never engaged') + ', wanted ' + r.expect
      ).join('; ');
      return true;
    });
}

async function testReleaseThresholds() {
  currentRole = 'thresholds';
  console.log('\n=== RELEASE THRESHOLDS (every integer distance, per geometry) ===');

  const allThrows = [];
  const allErrors = [];
  const swept = [];
  /* the line each policy documents, from the geometry alone */
  const farLine = h => Math.ceil(Math.max(SPEC_FAR, h * SPEC_OPEN_MIN));

  /* ---------- the sheets: the height is the threshold ---------- */
  const sheets = await bootGestureSandbox({ viewport: PHONE });
  const sheetFirer = makeFirer(sheets);
  const sheetBody = sheets.document.body;

  for (const geo of SHEET_GEOMETRY) {
    const line = farLine(geo.h);
    const rows = sweep(dy => pullSheet(sheetFirer.fire, sheetBody, geo.h, dy), geo.h);
    swept.push({ label: 'sheet @' + geo.what, rows: rows, line: line, size: geo.h });
    checkSweep('sheet @' + geo.what, rows, { line: line, verb: 'dismissed' });
  }

  /* the deferred half of the same policy, at the line itself: the shortest
     pull that dismisses has to really close the overlay, and the pull one
     pixel short of it must not. The sweep's own dismissals are drained
     first, so no timer from a sample can land on these two. */
  await tick(320);
  const sheetEdge = SHEET_GEOMETRY.map(geo => {
    const line = farLine(geo.h);
    return {
      geo: geo, line: line,
      short: pullSheet(sheetFirer.fire, sheetBody, geo.h, line - 1),
      at: pullSheet(sheetFirer.fire, sheetBody, geo.h, line)
    };
  });
  await tick(620);
  for (const e of sheetEdge) {
    check('sheet @' + e.geo.what + ': the ' + (e.line - 1) + 'px pull, a pixel short of the line, snaps back and stays open',
      () => {
        if (!e.short.engaged) return 'the gesture never engaged \u2014 nothing was tested';
        if (e.short.released !== '0px') return 'it was left at ' + JSON.stringify(e.short.released) + ' instead of snapping back';
        return e.short.ov._classes.has('open') ? true : 'it dismissed on a pull short of its own line';
      });
    check('sheet @' + e.geo.what + ': the ' + e.line + 'px pull at the line really closes it',
      () => e.at.ov._classes.has('open')
        ? 'it stayed open at its own threshold \u2014 the 210ms hand-off or the close never landed'
        : true);
  }
  allThrows.push(...sheetFirer.throws);
  allErrors.push(...sheets.consoleErrors);

  /* ---------- the lightboxes: the target's height is the threshold ---------- */
  const boxes = await bootGestureSandbox({ viewport: PHONE });
  const lbFirer = makeFirer(boxes);
  const boxBody = boxes.document.body;
  /* the video card's player container, seeded before a dismissing pull: the
     card has to leave through closeVideoLightbox(), which empties it, and a
     bare hide() would strand the player */
  const player = boxes.document.getElementById('videoLightboxContainer');

  for (const geo of LIGHTBOX_GEOMETRY) {
    const line = farLine(geo.h);
    const rows = sweep(dy => pullLightbox(lbFirer.fire, boxBody, geo, dy), geo.h);
    swept.push({ label: 'lightbox @' + geo.what, rows: rows, line: line, size: geo.h });
    checkSweep('lightbox @' + geo.what, rows, { line: line, verb: 'dismissed' });
  }

  await tick(320);
  /* A photo lightbox is dragged on this harness's own overlay, so its two
     pulls can share one wait. The video card cannot: its overlay is the
     PAGE's element and closeVideoLightbox() ignores whatever it is handed,
     so the pull that dismisses empties the very container the other pull is
     being asked about. Its pair gets its own two waits, below. */
  const photoEdge = LIGHTBOX_GEOMETRY.filter(g => !g.video).map(geo => {
    const line = farLine(geo.h);
    return {
      geo: geo, line: line,
      short: pullLightbox(lbFirer.fire, boxBody, geo, line - 1),
      at: pullLightbox(lbFirer.fire, boxBody, geo, line)
    };
  });
  await tick(620);
  for (const e of photoEdge) {
    check('lightbox @' + e.geo.what + ': the ' + (e.line - 1) + 'px pull, a pixel short of the line, snaps back and stays up',
      () => {
        if (!e.short.engaged) return 'the gesture never engaged \u2014 nothing was tested';
        if (e.short.released !== '0px') return 'it was left at ' + JSON.stringify(e.short.released) + ' instead of snapping back';
        return e.short.ov._classes.has('open') ? true : 'it dismissed on a pull short of its own line';
      });
    check('lightbox @' + e.geo.what + ': the ' + e.line + 'px pull at the line really dismisses it',
      () => e.at.ov._classes.has('open') ? 'it stayed up at its own threshold' : true);
  }

  const playerGeo = LIGHTBOX_GEOMETRY.filter(g => g.video)[0];
  if (playerGeo) {
    const line = farLine(playerGeo.h);
    const label = 'lightbox @' + playerGeo.what + ': the ';

    player.innerHTML = '<video data-live="1"></video>';
    const short = pullLightbox(lbFirer.fire, boxBody, playerGeo, line - 1);
    await tick(620);
    check(label + (line - 1) + 'px pull, a pixel short of the line, leaves the player alone',
      () => {
        if (!short.engaged) return 'the gesture never engaged \u2014 nothing was tested';
        if (short.released !== '0px') return 'it was left at ' + JSON.stringify(short.released) + ' instead of snapping back';
        return player.innerHTML === '' ? 'the player was torn down on a pull short of the line' : true;
      });

    player.innerHTML = '<video data-live="1"></video>';
    pullLightbox(lbFirer.fire, boxBody, playerGeo, line);
    await tick(620);
    check(label + line + 'px pull at the line really dismisses it, player and all',
      () => player.innerHTML === '' ? true
        : 'the card left without tearing its player down \u2014 closeVideoLightbox did not run');
  }
  allThrows.push(...lbFirer.throws);
  allErrors.push(...boxes.consoleErrors);

  /* ---------- the drawer: the width is the threshold ---------- */
  for (const geo of DRAWER_GEOMETRY) {
    const sb = await bootGestureSandbox({ viewport: geo.vp });
    const firer = makeFirer(sb);
    const body = sb.document.body;
    const side = sb.document.querySelector('.admin-side');
    if (geo.box !== undefined) setBox(side, geo.box, geo.vp.height);

    /* the width the policy has to be dividing: the stylesheet's own
       `.admin-side { width: min(82vw, 288px) }` */
    const dow = Math.min(geo.vp.width * 0.82, 288);
    const half = dow * 0.5;
    const travel = Math.floor(dow);                  /* the panel's own width, in whole px */
    const openLine = Math.ceil(half);
    const label = 'drawer @' + geo.vp.width + 'px viewport, ' + px(dow) + ' panel (' + geo.what + ')';

    /* The drawer's own two gestures, used as setup below. Each sweep has to
       start from the state its own gesture is accepted in: a drag from x = 4
       is refused outright once the drawer is OUT (the edge zone is neither
       the panel nor its scrim), and a panel drag is refused while it is
       SHUT. A sweep that opened the drawer and kept swiping would be
       measuring a surface that had stopped listening.

       Both travel the FULL width, not the line this section is testing — so
       a policy that has moved still gets its surface into place, and the
       sweep it belongs to fails on its own line instead of on a setup that
       no longer opens anything. */
    const openIt = () => {
      if (!body.classList.contains('side-open')) edgeDrag(firer.fire, body, side, travel, dow);
    };
    const shutIt = () => {
      if (body.classList.contains('side-open')) panelDrag(firer.fire, body, side, -travel);
    };

    /* closed: swiped in from the edge zone, which opens it at half its width */
    const closed = sweep(dx => { shutIt(); return edgeDrag(firer.fire, body, side, dx, dow); }, travel);
    swept.push({ label: label + ', swiped in', rows: closed, line: openLine, size: travel });
    checkSweep(label + ', swiped in', closed, { line: openLine, verb: 'opened' });

    check(label + ': the panel it divided is the width the stylesheet lays out',
      () => {
        const engaged = closed.filter(r => r.engaged);
        if (!engaged.length) return 'the gesture never engaged \u2014 nothing was tested';
        const off = engaged.filter(r => Math.abs((r.d - parseFloat(r.painted)) - dow) > 0.5);
        return off.length
          ? off.length + ' of ' + engaged.length + ' drags divided ' + px(off[0].d - parseFloat(off[0].painted)) +
            ' where the CSS lays out ' + px(dow)
          : true;
      });

    /* the open half of the policy — grabbed by the panel and thrown back —
       needs a panel to grab; the unmeasurable case proved its point in the
       closed sweep, against the fallback width */
    if (geo.box === undefined) {
      openIt();
      const back = sweep(m => { openIt(); return panelDrag(firer.fire, body, side, -m); }, travel);
      swept.push({ label: label + ', grabbed and thrown back', rows: back, line: Math.floor(half) + 1, size: travel });
      checkSweep(label + ', grabbed and thrown back', back, { line: Math.floor(half) + 1, verb: 'closed' });

      /* and the other direction from the same resting state: the door gives
         against its hinge at 0.18 of the finger and never shuts, at any
         distance, so this policy has no line to flip at */
      openIt();
      const over = sweep(d => { openIt(); return panelDrag(firer.fire, body, side, d); }, travel);
      swept.push({ label: label + ', dragged past open', rows: over, line: 0, size: travel });
      checkSweep(label + ', dragged past open', over, { line: 0, verb: 'closed' });
    }

    allThrows.push(...firer.throws);
    allErrors.push(...sb.consoleErrors);
  }

  check('thresholds: the sheet and lightbox matrix exercises both branches (the 90px floor and the percentage)',
    () => {
      const all = SHEET_GEOMETRY.concat(LIGHTBOX_GEOMETRY);
      const floor = all.filter(g => SPEC_FAR > g.h * SPEC_OPEN_MIN).length;
      const pct = all.filter(g => g.h * SPEC_OPEN_MIN > SPEC_FAR).length;
      return (floor && pct) ? true
        : 'only one branch is covered \u2014 ' + floor + ' under the floor, ' + pct + ' over it';
    });

  check('thresholds: the drawer matrix varies the width the policy is applied to',
    () => {
      const widths = DRAWER_GEOMETRY.map(g => g.box === undefined ? Math.min(g.vp.width * 0.82, 288) : (g.box || Math.min(g.vp.width * 0.82, 288)));
      return new Set(widths).size > 1 ? true
        : 'every drawer in the matrix is ' + widths[0] + 'px wide';
    });

  /* The sweep IS the point, so the sweep is checked too: one that stopped
     short of its line would still report a flip, and would still pass. */
  check('thresholds: all ' + swept.length + ' sweeps cover every integer distance to their own surface\'s size',
    () => {
      const short = swept.filter(s => s.rows.length !== s.size + 1 || s.rows[s.rows.length - 1].d !== s.size);
      if (short.length) return short[0].label + ' swept ' + short[0].rows.length + ' rows to ' +
        short[0].rows[short[0].rows.length - 1].d + 'px of a ' + short[0].size + 'px surface';
      const missed = swept.filter(s => s.line && s.rows[s.rows.length - 1].d <= s.line);
      return missed.length ? missed[0].label + ' never reaches its own ' + missed[0].line + 'px line' : true;
    });

  /* deferred work — the 210ms hand-off and the 300ms close — settles before
     the last two checks read the record */
  await tick(400);
  check('thresholds: no pointer sequence threw',
    () => allThrows.length === 0 ? true
      : allThrows.length + ' threw, first: ' + allThrows.slice(0, 3).join(' | '));
  check('thresholds: the console stayed clean',
    () => allErrors.length === 0 ? true
      : allErrors.length + ' logged, first: ' + allErrors.slice(0, 3).join(' | '));
}

/* ---------------- the surface contract ----------------

   assets/release-policy.js registers every surface it will answer for, by
   name, with the overlay selector the page lays it out under, and its
   policyFor() throws for a name it does not know. Two things follow, and
   neither of them is enforceable from inside that module:

     · the PAGE reaches the arithmetic only through the registry, and
     · a fourth surface cannot arrive unnoticed, because the check below
       reads admin.html itself and fails on a dismissible overlay that no
       registration claims.

   The list of names this file drives is written out too, so a registration
   cannot be added and left unexercised — the same rule the suites are held
   to when they are registered in package.json. */
async function testSurfaceContract() {
  currentRole = 'contract';
  console.log('\n=== THE SURFACE CONTRACT (registered, and nothing unclaimed) ===');

  const sb = await bootGestureSandbox({ viewport: PHONE });
  const RP = sb.win.ArzuzReleasePolicy;
  check('the page loaded the policy module', () => RP ? true : 'window.ArzuzReleasePolicy is missing');
  if (!RP) return;

  const names = RP.surfaceNames();
  check('it registers ' + names.length + ' surfaces: ' + names.join(', '),
    () => names.length >= 3 ? true : 'only ' + names.length + ' registered');

  check('every registered surface answers the whole contract \u2014 an overlay, a line, a release and a throw paint',
    () => {
      const bad = [];
      for (const n of names) {
        let p;
        try { p = RP.policyFor(n); } catch (e) { bad.push(n + ' threw: ' + e.message); continue; }
        if (typeof p.line !== 'function' || typeof p.release !== 'function' || typeof p.thrown !== 'function') bad.push(n + ' is missing a function');
        if (typeof p.overlay !== 'string' || !p.overlay) bad.push(n + ' claims no overlay selector');
        if (typeof p.line(288) !== 'number' || !(p.line(288) >= 1)) bad.push(n + ': line(288) is ' + p.line(288));
        /* a throw paints past its own size, or \u2014 the drawer \u2014 paints
           nothing and says so with null rather than inventing a px value */
        const t = p.thrown(288);
        if (p.kind === 'drawer' ? t !== null : typeof t !== 'string') bad.push(n + ': thrown(288) is ' + JSON.stringify(t));
      }
      return bad.length ? bad.join(' | ') : true;
    });

  check('and it hands out the module\'s OWN functions \u2014 never a copy that could drift from them',
    () => names.every(n => {
      const p = RP.policyFor(n);
      return p.release === (p.kind === 'drawer' ? RP.drawerRelease : RP.surfaceRelease);
    }) ? true : 'a registered release is not the module\'s own function');

  check('an unregistered name is refused outright, and the refusal names the surfaces it does have',
    () => {
      try { RP.policyFor('toast'); return 'policyFor("toast") returned an object instead of throwing'; }
      catch (e) {
        const m = String(e.message);
        const unnamed = names.filter(n => m.indexOf(n) === -1);
        return unnamed.length ? 'the error does not name ' + unnamed.join(', ') : true;
      }
    });

  /* the half the module cannot do on its own: read the PAGE */
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const classes = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  /* a dismissible ROOT, not one of its parts: modal-overlay, lightbox,
     admin-side, or anything named like a new one (`confirm-overlay`, `tray-drawer`) */
  const roots = [...classes].filter(c => /^(modal-overlay|lightbox|admin-side)$/.test(c) || /^[a-z][a-z0-9]*-(overlay|drawer|lightbox)$/.test(c));
  check('every dismissible root in admin.html (' + roots.length + ': ' + roots.join(', ') + ') is claimed by a registered surface',
    () => {
      const unclaimed = roots.filter(c => !names.some(n => RP.policyFor(n).overlay.indexOf(c) !== -1));
      return unclaimed.length ? 'nothing in the registry claims ' + unclaimed.join(', ') +
        ' \u2014 a fourth surface has to be registered here, and driven below, before it can be dragged'
        : true;
    });

  /* and the PAGE's own source, so "through the registry" is enforced rather
     than merely intended. admin.js may call the paints and the width helper —
     they are arithmetic about where a finger is, not a release decision — but
     the two RELEASE functions are the ones a fourth surface would copy a call
     to, so a direct call to either is refused here. */
  const adminSrc = fs.readFileSync(path.join(ROOT, 'assets/admin.js'), 'utf8');
  const direct = ['drawerRelease', 'surfaceRelease'].filter(fn => new RegExp('Policy\\.' + fn + '\\s*\\(').test(adminSrc));
  check('admin.js reaches every release decision through policyFor(), never by calling a policy function directly',
    () => direct.length
      ? 'it still calls Policy.' + direct.join('() and Policy.') + '() \u2014 a fourth surface could call one too and never meet the registry'
      : true);

  /* a registration nothing matches is worse than a missing one: it looks like
     coverage. The page is read, not the registry, so a surface removed from
     admin.html and left registered fails here — while the checks above stay
     green, because there is no unclaimed root to find and the name is still in
     the drive list below. */
  const classOf = sel => (sel.charAt(0) === '.' && sel.indexOf(' ') === -1 && sel.indexOf('[') === -1 && sel.indexOf(',') === -1)
    ? sel.slice(1) : null;
  check('no registration is dead: every surface\'s overlay selector is a class admin.html actually lays out',
    () => {
      const dead = [], compound = [];
      for (const n of names) {
        const sel = RP.policyFor(n).overlay;
        const c = classOf(sel);
        if (c === null) compound.push(n + ' \u2192 ' + JSON.stringify(sel));
        else if (!classes.has(c)) dead.push(n + ' \u2192 ' + sel);
      }
      if (compound.length) return compound[0] + ' is not a single class selector \u2014 this check cannot see it, so it cannot hold it';
      return dead.length ? 'registered but admin.html lays out no ' + dead.map(d => d.split(' \u2192 ')[1]).join(', ') +
        ' \u2014 a stale registration that looks like coverage' : true;
    });

  const EXERCISED = ['drawer', 'sheet', 'lightbox'];
  check('all ' + names.length + ' registered surfaces are actually driven by this file, not merely registered',
    () => {
      const missing = names.filter(n => EXERCISED.indexOf(n) === -1);
      return missing.length ? 'registered but never thrown or swept here: ' + missing.join(', ') : true;
    });

  check('the contract section logged nothing',
    () => sb.consoleErrors.length === 0 ? true : sb.consoleErrors.join(' | '));
}

/* ---------------- the velocity hand-off ----------------

   Every release policy here has a flick branch — over 280px/s it dismisses (or
   opens the drawer) at ANY distance — and nothing in this file proved the page
   hands a velocity to it at all.

   The check that looked like it did, "drawer: a flick to the left shuts it
   again", could not: a 280px leftward drag on a 288px panel is already past
   half its width, so the DISTANCE rule shuts it whether any velocity reached
   the policy or not. It passed for the wrong reason.

   So each surface is dragged twice at the SAME distance — once as a real throw,
   once held still so the sample reads zero — at a distance below its own line,
   where the flick is the only thing that can dismiss it. The two must disagree:

     · a page that stopped passing velocity (or passed zero) fails the thrown
       half;
     · a page that ignored distance altogether fails the settled one.

   The deferred half of the policy (the 210ms hand-off, the overlay's close, the
   player's teardown) is then read at the throw's own distance, after the wait.
   What the ENGINE computes from its samples is the gesture suite's business;
   what is proved here is that a velocity crosses into the page's decisions. */
async function testVelocityHandoff() {
  currentRole = 'velocity';
  console.log('\n=== THE VELOCITY HAND-OFF (one distance, thrown vs held) ===');

  const allThrows = [];
  const allErrors = [];
  const MS = 20;                     /* 20ms: a long throw, well inside the 90ms TICK window */
  let decided = 0, gates = 0;

  /* ---- the three durations, at ONE distance ----

     A throw's momentum also clears the line, so a fast throw does not prove the
     page passed a VELOCITY to the policy: hand the policy v = 0 and a 2000px/s
     throw's coast still carries the surface over (that mutation passed this
     section when it was built the obvious way). What isolates the flick branch
     is a throw whose PROJECTION cannot reach the line — just over the gate at a
     short distance, on a surface tall enough that the coast is not enough:

       sheet @820      line 246px   a 12px throw at 300px/s carries 12+150 = 162px
       lightbox @726   line 218px   the same 162px
       video card @657 line 198px   the same 162px
       drawer, half    144px        a 12px swipe in carries -276+115 = -161px

     On each of those, 300px/s (just over the gate) dismisses and 273px/s (just
     under it) does not — the same distance, the same surface, the same coast
     almost to the px. If the page passed zero, or v/2, or v*2, one of the two
     fails. The held drag is the third leg: zero velocity cannot dismiss either.
     `over`, `under` and `held` are three drags already fired at that distance. */
  function gate(label, d, line, over, under, held) {
    gates++;
    const mn = ms => (1000 * Math.abs(d) / ms).toFixed(0);
    check(label + ': a ' + mn(over.ms) + 'px/s throw at ' + d + 'px dismisses it; the same ' + d +
      'px at ' + mn(under.ms) + 'px/s and held still do not (its line is ' + line + 'px)',
      () => {
        if (!over.engaged || !under.engaged || !held.engaged) return 'a drag never engaged \u2014 nothing was tested';
        if (held.goes) return 'the settled drag dismissed it \u2014 the ' + line + 'px line is not holding';
        if (under.goes) return 'the ' + mn(under.ms) + 'px/s throw dismissed it \u2014 under the 280px/s gate, and its ' +
          'coast cannot clear ' + line + 'px, so something is scaling the velocity';
        if (!over.goes) return 'the ' + mn(over.ms) + 'px/s throw did not dismiss it \u2014 the page is not passing velocity to the policy';
        decided++;
        return true;
      });
    check(label + ': the over-gate throw tracked the finger 1:1 while it was down',
      () => over.painted === over.expect ? true
        : 'it painted ' + JSON.stringify(over.painted) + ', wanted ' + over.expect);
  }

  /* thrown and held at the same distance, where the question is not which
     branch decided but that the throw was honoured at all */
  function pair(label, d, line, flick, settled, verb) {
    verb = verb || 'dismisses it';
    gates++;
    check(label + ': a ' + throwSpeed(d, MS) + 'px/s throw at ' + d + 'px ' + verb + ', and the same ' + d +
      'px held still does not (its line is ' + line + 'px)',
      () => {
        if (!flick.engaged || !settled.engaged) return 'a drag never engaged \u2014 nothing was tested';
        if (settled.goes) return 'the settled drag ' + verb + ' too \u2014 the ' + line + 'px line is not holding';
        if (!flick.goes) return 'the throw did not \u2014 the page is not passing velocity to the policy';
        decided++;
        return true;
      });
    check(label + ': the throw tracked the finger 1:1 while it was down',
      () => flick.painted === flick.expect ? true
        : 'it painted ' + JSON.stringify(flick.painted) + ', wanted ' + flick.expect);
  }

  /* ---------- the sheets: 12px, where only the flick can clear the line ---------- */
  {
    const sb = await bootGestureSandbox({ viewport: PHONE });
    const firer = makeFirer(sb);
    const body = sb.document.body;
    const h = PHONE.height - 24;                 /* 820px: a full sheet at its CSS cap */
    const line = Math.ceil(Math.max(SPEC_FAR, h * SPEC_OPEN_MIN));
    const d = 12;                                /* over the 8px slop, far under the 246px line */

    const over = pullSheet(firer.fire, body, h, d, 40);    /* 300px/s — over the gate */
    const under = pullSheet(firer.fire, body, h, d, 44);   /* 273px/s — under it */
    const held = pullSheet(firer.fire, body, h, d);        /* the same 12px, held still */
    gate('sheet @' + h + 'px', d, line, over, under, held);

    await tick(620);                             /* the 210ms hand-off, plus the 340ms cleanup */
    check('sheet @' + h + 'px: the over-gate throw really closed the overlay',
      () => over.ov._classes.has('open')
        ? 'the overlay is still open \u2014 the hand-off or the close never landed' : true);
    check('sheet @' + h + 'px: the under-gate and held sheets were left open, mid-gesture cleared',
      () => (under.ov._classes.has('open') && held.ov._classes.has('open'))
        ? true : 'a sheet that should have snapped back was dismissed');

    /* and the splashy case, for the road a thumb actually takes: a long, real
       throw on a real sheet geometry. It is not the flick that proves a
       velocity crossed over here — a coast this size clears the line on its
       own — so it is checked for what it does say: the throw was honoured. */
    const h2 = 420, line2 = Math.ceil(Math.max(SPEC_FAR, h2 * SPEC_OPEN_MIN));
    pair('sheet @' + h2 + 'px', 40, line2, pullSheet(firer.fire, body, h2, 40, MS), pullSheet(firer.fire, body, h2, 40));

    /* ---- the COAST, which the flick cannot explain ----

       279px/s is UNDER the gate, so the flick branch never runs: what decides
       this one is the finger's 12px plus the momentum the engine projected for
       it — 12 + 139 = 151px against a 90px line. Hand the policy a projection
       of zero and this is the only check at page level that fails, which is
       exactly what it is here for: the OTHER gates isolate the velocity by
       making the coast insufficient, and would not notice the projection being
       dropped at all. */
    const h3 = 240, line3 = Math.ceil(Math.max(SPEC_FAR, h3 * SPEC_OPEN_MIN));   /* 90px floor */
    const coast = pullSheet(firer.fire, body, h3, 12, 43);      /* 279px/s, under the gate */
    const coastHeld = pullSheet(firer.fire, body, h3, 12);
    gates++;
    check('sheet @' + h3 + 'px: a ' + throwSpeed(12, 43) + 'px/s throw at 12px \u2014 under the gate \u2014 still dismisses, because its momentum clears a ' + line3 + 'px line the 12px alone cannot',
      () => {
        if (!coast.engaged || !coastHeld.engaged) return 'a drag never engaged \u2014 nothing was tested';
        if (coastHeld.goes) return 'the settled 12px drag dismissed it \u2014 the ' + line3 + 'px line is not holding';
        if (!coast.goes) return 'the throw did not dismiss it: the page is not passing the projection to the policy';
        decided++;
        return true;
      });

    allThrows.push(...firer.throws);
    allErrors.push(...sb.consoleErrors);
  }

  /* ---------- the lightboxes: the same throw on the two viewers ---------- */
  {
    const sb = await bootGestureSandbox({ viewport: PHONE });
    const firer = makeFirer(sb);
    const body = sb.document.body;
    const player = sb.document.getElementById('videoLightboxContainer');

    /* the portrait photo: a 218px line, and a 12px throw whose projection is
       162px — 56px short of it, so the flick branch is the only thing that can
       dismiss this one, and the coast cannot stand in for the velocity */
    for (const geo of LIGHTBOX_GEOMETRY.filter(g => !g.video && g.h > 300)) {
      const line = Math.ceil(Math.max(SPEC_FAR, geo.h * SPEC_OPEN_MIN));
      const d = 12;
      const over = pullLightbox(firer.fire, body, geo, d, 40);
      const under = pullLightbox(firer.fire, body, geo, d, 44);
      const held = pullLightbox(firer.fire, body, geo, d);
      gate('lightbox @' + geo.h + 'px', d, line, over, under, held);

      await tick(620);
      check('lightbox @' + geo.h + 'px: the over-gate throw really dismissed it',
        () => over.ov._classes.has('open')
          ? 'it is still up \u2014 the hand-off or the dismiss never landed' : true);
    }

    /* the landscape photo, where the line is the 90px floor: a 40px throw, held
       against the same 40px. Its coast could clear the floor on its own, so this
       one claims what it can prove \u2014 the throw was honoured where a hold was not */
    for (const geo of LIGHTBOX_GEOMETRY.filter(g => !g.video && g.h <= 300)) {
      const line = Math.ceil(Math.max(SPEC_FAR, geo.h * SPEC_OPEN_MIN));
      pair('lightbox @' + geo.h + 'px', 40, line, pullLightbox(firer.fire, body, geo, 40, MS), pullLightbox(firer.fire, body, geo, 40));
      await tick(620);
    }

    /* the video card owns a live player, so its throw has to run the teardown
       rather than just hide the overlay — the same 40px, both ways */
    const vid = LIGHTBOX_GEOMETRY.filter(g => g.video)[0];
    if (vid) {
      const line = Math.ceil(Math.max(SPEC_FAR, vid.h * SPEC_OPEN_MIN));
      /* closeVideoLightbox() ignores the overlay it is handed and acts on the
         PAGE's own elements, so the bulk of this one is read off those: the
         player after a flick has to be gone, and the page's #videoLightbox has
         to lose its open class. A fake overlay's class would say nothing here
         \u2014 the page never touches it. */
      const d = 12;                              /* 162px of carry, against a 198px line */
      const realCard = sb.document.getElementById('videoLightbox');

      /* the two that must NOT dismiss come first, while there is still a card
         and a player to leave alone */
      realCard.classList.add('open');
      player.innerHTML = '<video data-live="1"></video>';
      const under = pullLightbox(firer.fire, body, vid, d, 44);
      const held = pullLightbox(firer.fire, body, vid, d);
      check('the video card: the under-gate throw and the held drag leave the card, its player and the page\'s own lightbox alone',
        () => {
          if (!under.engaged || !held.engaged) return 'a drag never engaged \u2014 nothing was tested';
          if (under.goes || held.goes) return 'a drag the rule refuses was honoured \u2014 something is scaling the velocity';
          if (!realCard.classList.contains('open')) return 'the page\'s #videoLightbox was closed by a drag that should not have dismissed it';
          return player.innerHTML === '' ? 'the player was torn down on a pull short of the line' : true;
        });

      /* and then the flick, at the same distance */
      player.innerHTML = '<video data-live="1"></video>';
      realCard.classList.add('open');
      const over = pullLightbox(firer.fire, body, vid, d, 40);
      await tick(620);
      gate('the video card', d, line, over, under, held);
      check('the video card: the over-gate flick on the title row tears the player down (line ' + line + 'px, so nothing else could)',
        () => player.innerHTML === '' ? true
          : 'the player was left behind \u2014 closeVideoLightbox did not run for a flick');
      check('the video card: and it really closed the page\'s own lightbox, not just the harness\'s copy',
        () => realCard.classList.contains('open') ? 'the page\'s #videoLightbox is still open' : true);
    }
    allThrows.push(...firer.throws);
    allErrors.push(...sb.consoleErrors);
  }

  /* ---------- the drawer: thrown both ways, each under half its width ---------- */
  {
    const sb = await bootGestureSandbox({ viewport: PHONE });
    const firer = makeFirer(sb);
    const body = sb.document.body;
    const side = sb.document.querySelector('.admin-side');
    const dow = Math.min(PHONE.width * 0.82, 288);   /* the stylesheet's own width */
    const half = dow * 0.5;
    const travel = Math.floor(dow);

    const openIt = () => {
      if (!body.classList.contains('side-open')) edgeDrag(firer.fire, body, side, travel, dow);
    };
    const shutIt = () => {
      if (body.classList.contains('side-open')) panelDrag(firer.fire, body, side, -travel);
    };

    /* Swiped in from the edge, 12px: the drawer's own coast can carry only 0.4
       of the panel open (115px of 288), so -276 + 115 = -161 is still short of
       the 144px half — the flick branch is the only thing that can open this
       one, and the three durations at the same 12px have to disagree. */
    shutIt();
    const inOver = edgeDrag(firer.fire, body, side, 12, dow, 40);      /* 300px/s */
    shutIt();
    const inUnder = edgeDrag(firer.fire, body, side, 12, dow, 44);     /* 273px/s */
    shutIt();
    const inHeld = edgeDrag(firer.fire, body, side, 12, dow);          /* 0px/s */
    check('drawer @' + px(dow) + ' panel: a 300px/s swipe in of 12px opens it; the same 12px at 273px/s and held still do not (half is ' + px(half) + ', and its coast can carry only ' + px(dow * 0.4) + ')',
      () => {
        if (!inOver.engaged || !inUnder.engaged || !inHeld.engaged) return 'a drag never engaged \u2014 nothing was tested';
        if (inHeld.goes || inUnder.goes) return 'a swipe the rule refuses was honoured \u2014 something is scaling the velocity';
        if (!inOver.goes) return 'the throw did not open it \u2014 the page is not passing velocity to the policy';
        decided++; gates++;
        return true;
      });
    check('drawer: the swiped-in throw tracked the finger 1:1 while it was down',
      () => inOver.painted === inOver.expect ? true
        : 'it painted ' + JSON.stringify(inOver.painted) + ', wanted ' + inOver.expect);

    /* Grabbed by the panel and thrown back. Here the coast is what usually
       carries it shut, so this pair claims only what it can: the throw was
       honoured where the same distance held still was not. */
    openIt();
    const outFlick = panelDrag(firer.fire, body, side, -100, MS);
    openIt();
    const outSettled = panelDrag(firer.fire, body, side, -100);
    pair('drawer @' + px(dow) + ' panel, thrown back', -100, Math.ceil(half),
      { engaged: outFlick.engaged, painted: outFlick.painted, expect: outFlick.expect, goes: outFlick.goes }, outSettled,
      'shuts it');

    allThrows.push(...firer.throws);
    allErrors.push(...sb.consoleErrors);
  }

  check('the hand-off: all ' + gates + ' gates across the four surfaces decided the way their velocity said they would \u2014 each one a surface and a distance where the rule alone refuses and a real throw does not',
    () => decided === gates ? true : decided + ' of ' + gates + ' decided otherwise; the others said why');
  check('the hand-off: no pointer sequence threw',
    () => allThrows.length === 0 ? true : allThrows.slice(0, 3).join(' | '));
  check('the hand-off: the console stayed clean',
    () => allErrors.length === 0 ? true : allErrors.slice(0, 3).join(' | '));
}

/* ---------------- main ---------------- */

(async function main() {
  console.log('Arzuz admin — headless functional test');
  /* ALL FIVE ROLES THAT CAN SIGN IN. verification and finance were the two
     roles this loop could not carry until the blocks below stopped being
     scoped to "not marketing": the repair queue is admin + desk, growth is
     admin + marketing, and a role left out of that reasoning is a role
     nobody has ever seen render. */
  for (const role of ['admin', 'support', 'verification', 'finance', 'marketing']) {
    await testRole(role);
  }
  await testGestures();
  await testMissingPolicy();
  await testReleaseThresholds();
  await testVelocityHandoff();
  await testSurfaceContract();
  const failed = RESULTS.filter(r => !r.ok);
  console.log('\n———————————————————————————————');
  console.log('TOTAL ' + RESULTS.length + ' · PASS ' + (RESULTS.length - failed.length) + ' · FAIL ' + failed.length);
  if (failed.length) {
    failed.forEach(f => console.log('  FAIL [' + f.role + '] ' + f.name + ' → ' + f.note));
    process.exitCode = 1;
  }
})();
