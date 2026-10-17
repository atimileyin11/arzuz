#!/usr/bin/env node
/* ============================================================
   Arzuz — what the invite page tells a landlord, per failure

   Run:  node scripts/test-draft-errors.mjs      (part of npm test)

   THE HOLE THIS FILLS

     complete-listing.html is the only page whose audience is a
     landlord who did not ask for it: somebody forwarded them a link.
     Until this suite existed, every way that call could fail reached
     them as the same sentence — "This link is not valid" — and the
     real reason went to a console nobody reads.

     Three of those failures are NOT the link's fault:

       404 PGRST202   this site is running ahead of its database
       401/403 42501  this page is not allowed to call that
       400 22P02      the link arrived truncated

     Telling somebody their link is bad when the site is half-deployed
     sends them to ask for another link that cannot work either. That
     is the same mistake the Care page refuses to make, and the same
     one this suite exists to prevent.

   WHY THE BODIES ARE IN HERE

     Each status/code/message pair below was RECORDED against the live
     project on 10 Oct 2026, not invented: two of them came from
     calling the real functions with the public key (see §20 of
     dev/admin-test-report.md for the table and the exact commands).
     The classifier matches the CODE first — the code is the contract —
     but a PostgREST release that renames a code while keeping its
     sentence, or rewords a sentence while keeping the code, must not
     silently start telling landlords their link is broken. Both halves
     are asserted, in both directions.

   It also pins the thing that is easiest to lose later: the ONE class
   that really is about the link still says what it always said.
   ============================================================ */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(SITE, rel), 'utf8');

const require = createRequire(import.meta.url);
const D = require('../assets/draft-errors.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      passed += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 ' + r);
      console.log('  \u2717 ' + name + '\n      ' + r);
    }
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.stack || err));
  }
}

/* An rpc() failure the way complete-listing.js builds one. */
const errOf = (status, code, message) => Object.assign(new Error(message || ('HTTP ' + status)), { status, code });

console.log('Invite-link failures \u2014 the words a landlord reads\n');

/* ---------------- 1. the recorded shapes ---------------- */

console.log('1. What the live project answered (recorded 2026-10-10)\n');

check('the function that is not in the schema is "not switched on", not a bad link', () => {
  const rec = errOf(404, 'PGRST202',
    "Could not find the function public.listing_draft_update(p_token, p_patch) in the schema cache");
  const st = D.classify(rec);
  if (st.kind !== 'not-ready') return 'classified as ' + st.kind;
  if (!/nothing is wrong with your link/i.test(st.inline)) {
    return 'the inline sentence does not clear the link: ' + st.inline;
  }
  if (!/not switched on/i.test(st.title)) return 'the title says ' + st.title;
  return true;
});

check('and it is recognised by its sentence too, not only its code', () => {
  /* A PostgREST upgrade that keeps the meaning and changes the code
     must not turn this back into "your link is invalid". */
  const rec = errOf(404, null, "Could not find the function public.listing_draft_get(p_token) in the schema cache");
  return D.classify(rec).kind === 'not-ready' ? true : 'a schema-cache 404 fell through to ' + D.classify(rec).kind;
});

check('a grant this page does not hold is the same story for the landlord', () => {
  const denied = [
    errOf(401, '42501', 'permission denied for function listing_draft_get'),
    errOf(403, '42501', 'permission denied for function listing_draft_update')
  ];
  const wrong = denied.filter((e) => D.classify(e).kind !== 'not-ready');
  return wrong.length ? wrong.length + ' refusals classified as something else' : true;
});

check('a link that arrived truncated is "incomplete", not "invalid"', () => {
  const rec = errOf(400, '22P02', 'invalid input syntax for type uuid: "9f2c"');
  const st = D.classify(rec);
  if (st.kind !== 'bad-link') return 'classified as ' + st.kind;
  if (!/incomplete/i.test(st.title)) return 'the title says ' + st.title;
  return /one piece/i.test(st.body) ? true : 'it does not say what to do about a broken link: ' + st.body;
});

check('the empty answer from listing_draft_get is the ONE case that blames the link', () => {
  const st = D.state('dead-link');
  return /this link is not valid/i.test(st.title)
    ? true : 'the original wording was lost: ' + st.title;
});

check('and that wording is still the page\u2019s static default, so a no-JS view is right', () => {
  const html = read('complete-listing.html');
  const dead = html.slice(html.indexOf('id="clDead"'), html.indexOf('id="clDone"'));
  if (!/This link is not valid/.test(dead)) return 'the dead card no longer carries the dead-link copy';
  return /id="clDeadTitle"/.test(dead) && /id="clDeadBody"/.test(dead)
    ? true : 'the card has no slot for the script to write the real reason into';
});

/* ---------------- 2. every other way it can fail ---------------- */

console.log('\n2. The rest of the classes\n');

check('a rate limit is a wait, and it says nothing was lost', () => {
  const st = D.classify(errOf(429, 'PGRST999', 'too many requests'));
  return st.kind === 'busy' && /nothing you have typed has been lost/i.test(st.inline)
    ? true : 'busy said: ' + (st.inline || st.kind);
});

check('a 500 is named as OUR side, because a 500 is not a fact about a link', () => {
  const st = D.classify(errOf(500, 'XX000', 'internal error'));
  if (st.kind !== 'error') return 'classified as ' + st.kind;
  return /our side, not your link/i.test(st.inline) ? true : 'it blamed the landlord: ' + st.inline;
});

check('a request that never arrived is offline, not refused', () => {
  const drop = Object.assign(new Error('Failed to fetch'), { status: 0, rpc: 'listing_draft_get' });
  const st = D.classify(drop);
  if (st.kind !== 'offline') return 'classified as ' + st.kind;
  return /check your connection/i.test(st.inline) ? true : 'offline said: ' + st.inline;
});

check('the page\u2019s own reason (no ?ref at all) gets its own state', () => {
  const st = D.state('no-link');
  return /needs an invite link/i.test(st.title) ? true : 'no-link said: ' + st.title;
});

check('an unknown kind is a thrown error, not a silently wrong sentence', () => {
  try {
    D.state('typo');
  } catch (e) {
    return /unknown kind/i.test(e.message) ? true : 'threw the wrong thing: ' + e.message;
  }
  return 'state("typo") returned a descriptor instead of failing';
});

/* ---------------- 3. the contract with the page ---------------- */

console.log('\n3. The contract complete-listing.js relies on\n');

check('every kind carries either a screen or an inline sentence — never neither', () => {
  const bad = Object.keys(D.KINDS).filter((k) => {
    const st = D.KINDS[k];
    if (st.outcome === 'dead') return !(st.title && st.body);
    return !st.inline;
  });
  return bad.length ? 'incomplete copy for: ' + bad.join(', ') : true;
});

check('nothing the landlord reads tells them to ask for a new link when the link is fine', () => {
  /* The specific mistake: a link-flavoured instruction on a class that
     is not about the link. "send you a fresh link once it is ready" is
     the honest half of that sentence, and it is allowed — what is not
     allowed is sending them to re-request one NOW. */
  const wrong = ['not-ready', 'bad-link', 'busy', 'offline', 'error'].filter((k) => {
    const text = (D.KINDS[k].inline || '') + ' ' + (D.KINDS[k].body || '');
    return /ask (us|the arzuz team)? ?for (a )?(new|fresh) link|request a new link/i.test(text);
  });
  return wrong.length ? 'these send them after a link that cannot work: ' + wrong.join(', ') : true;
});

check('the classifier is the page\u2019s own file, loaded before it in the markup', () => {
  const html = read('complete-listing.html');
  const mine = html.indexOf('assets/draft-errors.js');
  const page = html.indexOf('assets/complete-listing.js');
  if (mine === -1) return 'the page does not load assets/draft-errors.js at all';
  return mine < page ? true : 'the page loads it AFTER itself, so the first failure would be unclassified';
});

check('the page actually reports through it, rather than composing its own sentences', () => {
  const src = read('assets/complete-listing.js');
  if (/Could not save: ' \+ e\.message/.test(src)) return 'a raw "Could not save: HTTP 404" is still composed in the page';
  const raw = src.split('\n').filter((l) => /failState\(|failNote\(/.test(l) && /e\.message/.test(l));
  return raw.length ? 'an error is still passed to the landlord as a message: ' + raw[0].trim() : true;
});

console.log('\n' + (failures.length ? '\u2717 ' : '') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
process.exit(failures.length ? 1 : 0);
