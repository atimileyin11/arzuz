#!/usr/bin/env node
/* ============================================================
   Arzuz — what the public badge is allowed to say

   The badge is the product promise in six words. "Inspected" on a
   listing is the sentence a student pays attention to, so the module
   behind it is tested the way a claim is tested, not the way a label
   is:

     · the word only appears when there is a visit on file, and every
       check in it is still current;
     · the moment the six-month record runs out, the word becomes
       "Re-check due" and the badge prints the date of the last visit;
     · a tier-2 listing from before this layer says it has no record,
       rather than inventing one;
     · a re-visit is READ AS ONE VISIT — the newest — instead of
       pooling two partial visits into one perfect badge;
     · evidence dated in the future is not fresh evidence yet.

   The last section pairs the vocabulary with the database: the kinds
   this module can name must be exactly the kinds the CHECK constraint
   in supabase-verification-evidence.sql accepts. A check added to one
   and not the other is a build failure, not a badge that silently
   omits what an officer recorded.

   Pure Node. No DOM, no database, no network.

   Run:  npm run test:verify-badge
   ============================================================ */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const Badge = require(join(SITE, 'assets/verification-badge.js'));

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      pass += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 ' + r);
      console.log('  \u2717 ' + name + '\n      ' + r);
    }
  } catch (err) {
    failures.push(name + ' \u2014 ' + (err && err.message));
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message));
  }
}

function eq(got, want, what) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error((what || 'value') + ': expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got));
  }
}

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const inDays = (days) => new Date(NOW + days * DAY).toISOString();

function row(kind, opts = {}) {
  const checked = opts.checked || at(opts.A || 10);
  return {
    listing_id: 'listing-1',
    visit_id: opts.visit || 'visit-1',
    kind: kind,
    detail: opts.detail === undefined ? null : opts.detail,
    checked_at: checked,
    expires_at: opts.expires === undefined ? new Date(Date.parse(checked) + Badge.EVIDENCE_DAYS * DAY).toISOString() : opts.expires,
  };
}

function visit(visitId, daysAgo, kinds) {
  return kinds.map((k) => row(k, { visit: visitId, A: daysAgo }));
}

console.log('Arzuz verification badge \u2014 what it may say, and when\n');

/* ------------------------------------------------------------ */
console.log('1. The three tiers, in their own words\n');

check('tier 0 says the room has not been seen', () => {
  const s = Badge.summarise(0, [], NOW);
  eq(s.label, 'Unverified', 'label');
  eq(s.cls, 'b0', 'class');
  return s.sentence.indexOf('not been to the room') !== -1 ? true : s.sentence;
});

check('tier 1 says a tenant confirmed the price, and that it is not a visit', () => {
  const s = Badge.summarise(1, [], NOW);
  eq(s.label, 'Community verified', 'label');
  eq(s.cls, 'b1', 'class');
  return /tenant in the building/.test(s.sentence) && /not a visit/.test(s.sentence)
    ? true : s.sentence;
});

check('a tier arrives as a string from PostgREST and still works', () => {
  eq(Badge.summarise('1', [], NOW).label, 'Community verified', 'label');
});

check('a missing tier is unverified, never inspected', () => {
  eq(Badge.summarise(null, [], NOW).label, 'Unverified', 'label');
});

/* ------------------------------------------------------------ */
console.log('\n2. "Inspected" only with a visit behind it\n');

check('tier 2 with no evidence rows says so instead of inventing checks', () => {
  const s = Badge.summarise(2, [], NOW);
  eq(s.label, 'Inspected', 'label');
  eq(s.hasEvidence, false, 'evidence');
  return /no record of what was checked/.test(s.sentence) ? true : s.sentence;
});

check('tier 2 whose evidence could not be READ does not claim there is none', () => {
  const s = Badge.summarise(2, null, NOW);
  eq(s.hasEvidence, false, 'evidence');
  return /could not read/.test(s.note) && !/no record/.test(s.note) ? true : s.note;
});

check('a fresh visit is named in full, with the dates', () => {
  const s = Badge.summarise(2, visit('v1', 10, ['water', 'power', 'photos']), NOW);
  eq(s.label, 'Inspected', 'label');
  eq(s.hasEvidence, true, 'evidence');
  eq(s.expired, false, 'expired');
  eq(s.parts.map((p) => p.label), [
    'Water pressure at the tap',
    'Power supply and meter',
    'Photos match the room',
  ], 'parts, in vocabulary order');
  eq(s.checked_at, at(10), 'checked_at');
  eq(s.expires_at, new Date(NOW - 10 * DAY + 180 * DAY).toISOString(), 'expires_at');
  return /Water pressure at the tap, Power supply and meter and Photos match the room/.test(s.sentence) &&
    /checked 7 Oct 2026/.test(s.sentence) &&
    /current until 5 Apr 2027/.test(s.sentence)
    ? true : s.sentence;
});

check('the officer\'s sentence is carried through untouched', () => {
  const s = Badge.summarise(2, [row('water', { detail: 'good at the kitchen tap' })], NOW);
  eq(s.parts[0].detail, 'good at the kitchen tap', 'detail');
});

/* ------------------------------------------------------------ */
console.log('\n3. The moment it stops being true\n');

check('the expiry instant itself is already expired', () => {
  const r = row('water', { checked: at(180) });
  const s = Badge.summarise(2, [r], NOW);
  eq(s.expired, true, 'expired at 180 days');
  eq(s.label, 'Re-check due', 'label');
});

check('one millisecond earlier it is still current', () => {
  const r = row('water', { expires: new Date(NOW + 1).toISOString() });
  const s = Badge.summarise(2, [r], NOW);
  eq(s.expired, false, 'expired');
  eq(s.label, 'Inspected', 'label');
});

check('an expired badge never says "current until"', () => {
  const s = Badge.summarise(2, [row('water', { checked: at(200) })], NOW);
  eq(s.expired, true, 'expired');
  return !/current until/.test(s.sentence) && /Last inspected/.test(s.sentence)
    ? true : s.sentence;
});

check('expired evidence is not the same as no evidence', () => {
  const old = Badge.summarise(2, [row('water', { checked: at(200) })], NOW);
  const none = Badge.summarise(2, [], NOW);
  eq(old.label, 'Re-check due', 'old label');
  eq(none.label, 'Inspected', 'none label');
  return old.note !== none.note ? true : 'the two states print the same sentence';
});

check('a visit expires when its EARLIEST check does, not its latest', () => {
  const early = row('water', { checked: at(10), expires: inDays(5) });
  const late = row('power', { checked: at(10), expires: inDays(100) });
  const s = Badge.summarise(2, [early, late], NOW);
  eq(s.parts.length, 2, 'both checks');
  eq(s.expires_at, inDays(5), 'the group expiry');
});

/* ------------------------------------------------------------ */
console.log('\n4. One visit, not a mixture of two\n');

check('the newest visit wins, even if an older one checked more', () => {
  const rows = visit('v-old', 40, ['water', 'power', 'photos', 'price']).concat(
    visit('v-new', 5, ['water'])
  );
  const s = Badge.summarise(2, rows, NOW);
  eq(s.parts.map((p) => p.kind), ['water'], 'parts');
  eq(s.checked_at, at(5), 'the date');
  return s.sentence.indexOf('Photos match the room') === -1
    ? true : 'two visits were pooled into one badge: ' + s.sentence;
});

check('a re-visit does not inherit checks it did not make', () => {
  const rows = visit('v1', 20, ['water', 'power', 'photos']).concat(visit('v2', 1, ['price']));
  const s = Badge.summarise(2, rows, NOW);
  eq(s.parts.map((p) => p.kind), ['price'], 'parts');
});

check('rows without a visit_id group by the instant they claim', () => {
  const rows = [
    { kind: 'water', checked_at: at(3), expires_at: inDays(177), detail: null },
    { kind: 'power', checked_at: at(3), expires_at: inDays(177), detail: null },
    { kind: 'photos', checked_at: at(30), expires_at: inDays(150), detail: null },
  ];
  const s = Badge.summarise(2, rows, NOW);
  eq(s.parts.map((p) => p.kind), ['water', 'power'], 'the newer group only');
});

/* ------------------------------------------------------------ */
console.log('\n5. Evidence that is not evidence yet\n');

check('a check dated in the future is ignored, not counted as fresh', () => {
  const s = Badge.summarise(2, [row('water', { checked: inDays(2), expires: inDays(182) })], NOW);
  eq(s.hasEvidence, false, 'evidence');
  eq(s.label, 'Inspected', 'label');
});

check('a check with no readable date is ignored', () => {
  const s = Badge.summarise(2, [{ kind: 'water', checked_at: 'not-a-date', expires_at: inDays(30) }], NOW);
  eq(s.hasEvidence, false, 'evidence');
});

check('a row that expires before it was checked is malformed and ignored', () => {
  const s = Badge.summarise(2, [row('water', { checked: at(2), expires: at(3) })], NOW);
  eq(s.hasEvidence, false, 'evidence');
});

check('an unknown check kind is dropped, and never printed as raw text', () => {
  const s = Badge.summarise(2, [row('water'), row('vibes')], NOW);
  eq(s.parts.map((p) => p.kind), ['water'], 'parts');
  return s.sentence.indexOf('vibes') === -1 ? true : s.sentence;
});

check('a visit made only of unknown kinds is no evidence at all', () => {
  const s = Badge.summarise(2, [row('vibes'), row('niceness')], NOW);
  eq(s.hasEvidence, false, 'evidence');
});

/* ------------------------------------------------------------ */
console.log('\n6. Dates, and the detail lines a page prints\n');

check('a date is printed in UTC, the same everywhere', () => {
  eq(Badge.day('2026-08-12T23:30:00.000Z'), '12 Aug 2026', 'date');
  eq(Badge.day('nonsense'), '', 'junk');
});

check('detail lines are one per check, carrying both dates', () => {
  const s = Badge.summarise(2, visit('v1', 10, ['water', 'price']), NOW);
  const lines = Badge.detailLines(s);
  eq(lines.length, 2, 'lines');
  eq(lines[0].label, 'Water pressure at the tap', 'first');
  eq(lines[0].checked_at, s.checked_at, 'checked');
  eq(lines[0].expires_at, s.expires_at, 'expires');
});

check('an unvisited or evidence-less listing has no detail lines to print', () => {
  eq(Badge.detailLines(Badge.summarise(0, [], NOW)), [], 'tier 0');
  eq(Badge.detailLines(Badge.summarise(2, [], NOW)), [], 'no evidence');
});

/* ------------------------------------------------------------ */
console.log('\n7. The module and the migration cannot drift apart\n');

const SQL = readFileSync(join(SITE, 'supabase-verification-evidence.sql'), 'utf8');

check('the CHECK constraint accepts exactly the kinds this module can name', () => {
  const m = /kind\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*kind\s+in\s*\(([^)]+)\)/i.exec(SQL);
  if (!m) return 'the CHECK constraint was not found in supabase-verification-evidence.sql';
  const inSql = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  const inModule = Badge.KINDS.map((k) => k.kind).sort();
  eq(inSql, inModule, 'the two vocabularies');
  return true;
});

check('the database\u2019s expiry and the module\u2019s number are the same 180 days', () => {
  const m = /interval\s+'(\d+)\s+days'/.exec(SQL);
  if (!m) return 'no interval was found in the migration';
  eq(Number(m[1]), Badge.EVIDENCE_DAYS, 'days');
  return true;
});

check('the function refuses the same vocabulary it is asked to record', () => {
  const raises = /is not a check we can publish/i.test(SQL);
  return raises ? true : 'the function has no unknown-kind refusal';
});

/* ------------------------------------------------------------ */
console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  \u2717 ' + f));
}
console.log(pass + ' passed, ' + failures.length + ' failed');
console.log('='.repeat(52));
process.exit(failures.length ? 1 : 0);
