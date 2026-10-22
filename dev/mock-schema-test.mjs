#!/usr/bin/env node
/* ============================================================
   Arzuz — the mocks must refuse what Postgres refuses

   THE FAILURE THIS EXISTS FOR

     Twenty of the suites in this repo run against a stand-in: a
     small PostgREST, a mock admin backend, a fake ledger. Each of
     them restates some of the schema's rules in JavaScript, and
     the dangerous direction is always the same one — the mock
     accepts a word the database would refuse (23514), the test
     exercises it, the assertion passes, and the green line is
     about data that cannot exist in production.

     That is not hypothetical. The fixture audit that preceded
     this file found a reference and a phone number that the
     product's own rule rejects, sitting inside tests that read as
     "a real value is treated as real". The string was wrong; the
     test was green; the claim was false.

   HOW IT DECIDES WHAT POSTGRES REFUSES

     It does not keep a list. It parses the CHECK constraints out of
     supabase-*.sql (dev/schema-vocab.mjs) and compares the mocks
     against what the migrations actually say. A vocabulary is only
     recognised in its enumerable shape — `col in (...)` — because
     guessing at arbitrary SQL would produce a confident wrong
     answer, which is the bug class this file is about.

   THREE WAYS A JS LIST CAN RELATE TO A CHECK, and all three are
   checked, because only the middle one is "equal"

     MIRROR   the list IS the vocabulary: the same words, no more
              and no fewer. `repair_claims.status` and the claims
              API's STATUSES are this. A word in one and not the
              other is a defect in both directions — a mock that
              accepts more invents states, one that accepts less
              cannot express a legal one.
     SUBSET   the list is deliberately NARROWER, for one question:
              which statuses a student may withdraw from. Every
              word must still be legal; the missing ones must be
              named and explained, so "subset" is a decision on the
              record rather than an oversight.
     NONE     nothing in JavaScript restates it at all. Listed with
              a reason — because the completeness check below fails
              on any CHECK this file has never considered, so a new
              migration cannot arrive with its vocabulary unexamined.

   AND THAT THE LIST IS ACTUALLY A GATE

     A constant that looks like a vocabulary but is never compared
     against anything protects nothing. Every entry marked `gate`
     must be consulted by a membership test in its own file; an
     array that has become decorative fails here even though its
     words are right.

   WHAT THIS DOES NOT PROVE

     It compares vocabularies and proves they are used as gates. It
     does not replay a request and watch the refusal — that is each
     suite's own job, against its own stand-in. So this file is a
     drift detector, not a replacement for test-claims.mjs or
     test-status.mjs; it is the thing that tells you those suites
     are still testing against a schema that exists.

   Run from arzuz-site/:
     node dev/mock-schema-test.mjs
   ============================================================ */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocab } from './schema-vocab.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

let pass = 0;
const failures = [];
const check = (name, fn) => {
  let out;
  try { out = fn(); } catch (err) { out = (err && err.stack) || String(err); }
  if (out === true) { pass++; return; }
  failures.push([name, out]);
};

/* ------------------------------------------------------------
   reading a JS vocabulary out of the file that declares it
   ------------------------------------------------------------ */

/* A list, not a phrase: `const NAME = [ 'a', 'b' ]`, possibly across
   several lines, with nothing but strings and commas inside. Anything
   else returns an error string rather than a guess — an array that has
   grown a function call or a template literal is no longer a
   vocabulary this file can compare. */
function readList(rel, name) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const re = new RegExp('(?:const|var|let)\\s+' + name + '\\s*=\\s*\\[', 'g');
  const m = re.exec(src);
  if (!m) return { error: 'no `' + name + ' = [` in ' + rel + ' — the list was renamed or removed, so this check is unwitnessed' };
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close === -1) return { error: 'unbalanced [ for ' + name + ' in ' + rel };
  const body = src.slice(open + 1, close);
  const words = [...body.matchAll(/'([^'\\]*)'/g)].map((x) => x[1]);
  const rest = body.replace(/'[^'\\]*'/g, '').replace(/[\s,]/g, '');
  if (rest) return { error: name + ' in ' + rel + ' holds more than string literals (' + rest.slice(0, 40) + '), so it is no longer a vocabulary' };
  /* A gate is one of three visible shapes: the list is asked a question
     (`LIST.indexOf(x)`), the list is asked it by a helper that only
     exists to ask it (`canDo(LIST, x)` in my-care.js), or the list is
     the receiver's argument to includes/indexOf. What is NOT a gate is a
     list that is only ever mapped over to build labels — which is why
     `gate` is declared per entry rather than inferred as a pass. */
  return {
    words,
    line: src.slice(0, m.index).split('\n').length,
    gate: new RegExp('\\b' + name + '\\s*\\.\\s*(indexOf|includes|some|every|find|has)\\s*\\(').test(src)
      || new RegExp('\\b(includes|indexOf|has)\\s*\\(\\s*' + name).test(src)
      || new RegExp('[\\w$]+\\s*\\(\\s*' + name + '\\s*[,)]').test(src),
  };
}

const SHOW = (set, n) => set.slice(0, n).join(', ') + (set.length > n ? ', +' + (set.length - n) : '');

/* ------------------------------------------------------------
   the schema, read first
   ------------------------------------------------------------ */

const schema = loadVocab(ROOT);

check('the migrations were actually read', () => {
  if (schema.entries.length < 20) return 'only ' + schema.entries.length + ' vocabularies parsed — the reader has lost the schema';
  if (schema.entries.some((e) => !e.table)) return 'a vocabulary was parsed with no enclosing table: ' + JSON.stringify(schema.entries.filter((e) => !e.table).slice(0, 2));
  if (!schema.order.length) return 'the migration order could not be read from dev/sql-proof.mjs';
  return true;
});

/* Every key once, for the coverage sweep and for the report. */
const KEYS = [...new Set(schema.entries.map((e) => e.key))];

/* ------------------------------------------------------------
   MIRRORS — the list IS the vocabulary, word for word
   ------------------------------------------------------------ */

const MIRRORS = [
  {
    sql: 'repair_claims.status',
    why: 'the statuses a claim can be in. The API refuses anything else, the dashboard labels it, the mock stores it, and the claims suite restates it for its stand-in — four copies of one vocabulary, and the database is the owner.',
    js: [
      { file: 'netlify/functions/claims.js', name: 'STATUSES', gate: true },
      { file: 'dev/admin-mock.js', name: 'CLAIM_STATUSES', gate: true },
      { file: 'scripts/test-claims.mjs', name: 'vocabulary', gate: true },
      { file: 'assets/admin.js', name: 'CLAIM_STATUS', gate: false },
    ],
  },
  {
    sql: 'payments.business_line',
    why: 'the lines the books are kept in. The dashboard builds its revenue table from this list; a line the database does not have would be a column of zeroes nobody questions.',
    js: [{ file: 'assets/admin.js', name: 'FIN_LINES', gate: false }],
  },
  {
    sql: 'ledger_entries.business_line',
    why: 'the same six lines, restated on the journal itself.',
    js: [{ file: 'assets/admin.js', name: 'FIN_LINES', gate: false }],
  },
  {
    sql: 'demand_records.follow_up_status',
    why: 'the pipeline stages the desk moves a demand through. The panel clamps an unknown stage to "new" rather than rendering it; a stage the SQL no longer allows would be silently impossible to select.',
    js: [{ file: 'assets/admin.js', name: 'PIPELINE_STAGES', gate: true }],
  },
  {
    sql: 'listings.follow_up_status',
    why: 'the same five stages on the listings side of the pipeline.',
    js: [{ file: 'assets/admin.js', name: 'PIPELINE_STAGES', gate: true }],
  },
  {
    sql: 'status_code_deliveries.outcome',
    why: 'what a delivery attempt did. The status suite asserts every attempt it sees is one of these — so a suite that invented "done" would be asserting on a row the column cannot hold.',
    js: [{ file: 'scripts/test-status.mjs', name: 'TRAIL_OUTCOMES', gate: true }],
  },
  {
    sql: 'status_code_deliveries.note',
    why: 'why an attempt failed. The suite recomputes this list rather than importing it, which is exactly why it has to be compared: the copy is the thing that can rot.',
    js: [{ file: 'scripts/test-status.mjs', name: 'TRAIL_NOTES', gate: true }],
  },
  {
    sql: 'listing_evidence.kind',
    why: 'the six checks a visit may record \u2014 what an officer can attest at the door, and what the public badge prints as the reason a listing reads "Inspected". The mock refuses any other word with the migration\'s own sentence, so a kind the constraint does not allow cannot be planted in a fixture and then asserted on.',
    js: [{ file: 'dev/admin-mock.js', name: 'EVIDENCE_KINDS', gate: true }],
  },
  {
    sql: 'repair_claims.eligibility',
    why: 'covered / not covered, the answer the decision writes. The admin mock gates on it inline, restated here as a named list so it can be compared at all.',
    js: [{ file: 'dev/admin-mock.js', name: 'ELIGIBILITY', gate: true }],
  },
];

/* ------------------------------------------------------------
   SUBSETS — deliberately narrower than the CHECK
   ------------------------------------------------------------ */

const SUBSETS = [
  {
    sql: 'referrals.status',
    js: { file: 'netlify/functions/finance.js', name: 'REFERRAL_STATES', gate: true },
    why: 'the states a DECISION may move a referral to. pending_qualification is the state a referral is BORN in — the DB allows it, and letting an operator set one back to it would be a way to un-qualify money that already moved.',
  },
  {
    sql: 'referrals.status',
    js: { file: 'assets/admin.js', name: 'states', gate: false },
    why: 'quotes the function\'s list, so it is the same subset by construction — and the panel says so in its own comment.',
  },
  {
    sql: 'repair_claims.status',
    js: { file: 'scripts/test-claims.mjs', name: 'OPEN_CLAIM_STATUSES', gate: false },
    why: 'the states a call-out is still committed to. A closed claim holds no credit, so it is not "open" — a subset of the vocabulary by definition, not a copy of it.',
  },
  {
    sql: 'repair_claims.status',
    js: { file: 'assets/my-care.js', name: 'CAN_WITHDRAW', gate: true },
    why: 'the states a student may still pull out of. Once a worker is on the job, leaving is a dispute — the subset is the rule, so widening it to the full vocabulary would be a regression, not a fix.',
  },
  {
    sql: 'repair_claims.provider_answer',
    js: { file: 'netlify/functions/claims.js', name: 'NOT_ON_THE_JOB', gate: true },
    why: 'the two answers that mean nobody is coming. accepted is the third, and it is the one that keeps a worker on the job — so the list is a question about the answer, not the vocabulary.',
  },
  {
    sql: 'roommate_events.event',
    js: { file: 'netlify/functions/roommate-digest.js', name: 'COUNTED', gate: false },
    why: 'what the weekly digest counts. "viewed" is in the trail and deliberately not counted — "3 students opened their matches" is not news.',
  },
];

/* ------------------------------------------------------------
   NONE — no JS restates it, and here is why that is fine
   ------------------------------------------------------------ */

const NO_MIRROR = {
  'care_plans.status': 'written by the care functions, never named as a list; the panel renders whatever the row says.',
  'care_credit_events.event': 'written one row at a time by named actions (grant, spend, refund…), each of which passes its own literal — there is no list to compare, and the SQL shape check is the gate.',
  'payments.status': 'never set from outside: the webhook maps a provider outcome onto it, so the function has no vocabulary to accept.',
  'ledger_entries.direction': 'chosen per posting by the function that writes the pair (cash up, unearned up); no list, and a wrong one is a reconciliation bug the books suite catches.',
  'ledger_entries.account': 'the seven pots are named at each posting site. The finance mock derives its balances from the same literals, so a word Postgres refuses cannot reach a balance it asserts on.',
  'claim_events.event': 'twenty-three events, written one call at a time as `trail(claim, \'…\')`. A list would be a second copy of nothing — the union is not a thing any code needs.',
  'roommate_interests.decision': 'two words, compared directly as \'accept\'/\'pass\' in roommate-match.js. A one-word vocabulary does not earn a list.',
  'verification_events.event': 'taken / released / nudged, each written by the function that owns that transition.',
  'status_code_deliveries.channel': 'whatsapp or email, chosen by the branch that sends. The status suite asserts each attempt names one of them.',
  'demand_records.applicant_type': 'written by the SQL door, never named in JavaScript; a NULL is legal, so nothing in the app needs to restate it.',
  'listings.applicant_type': 'same column, same door, same reason.',
  'listings.draft_permission': 'view or edit, normalised by the dashboard (anything that is not "view" is "edit") — a defaulting rule, not a vocabulary that accepts words.',
};

/* ------------------------------------------------------------
   the checks
   ------------------------------------------------------------ */

const coveredByRegistry = new Set();

for (const m of MIRRORS) {
  const sql = schema.effective(m.sql);
  check('the schema still has ' + m.sql, () => sql
    ? true
    : 'supabase-*.sql no longer has a vocabulary CHECK on ' + m.sql + ' — either the constraint was dropped (the mock now refuses states the database allows) or it was renamed');
  if (!sql) continue;
  coveredByRegistry.add(m.sql);

  for (const j of m.js) {
    const got = readList(j.file, j.name);
    check(m.sql + ' — ' + j.name + ' is readable in ' + j.file, () => got.error ? got.error : true);
    if (got.error) continue;

    check(j.name + ' (' + j.file + ') is the same vocabulary as ' + m.sql, () => {
      const a = new Set(sql.words);
      const b = new Set(got.words);
      const missing = [...a].filter((w) => !b.has(w));
      const extra = [...b].filter((w) => !a.has(w));
      if (!missing.length && !extra.length) return true;
      return 'they disagree. ' +
        (extra.length ? 'THE MOCK ACCEPTS ' + SHOW(extra, 6) + ', which ' + sql.file + ':' + sql.line + ' refuses. ' : '') +
        (missing.length ? 'The mock cannot express ' + SHOW(missing, 6) + ', which the database allows. ' : '') +
        'One of the two moved and the other did not.';
    });

    /* Only the entries declared as gates are held to it. A display list
       (the dashboard's labels, the revenue table's columns) is checked
       for its vocabulary and nothing else — and if it later grows a
       membership test, that is an improvement the registry can record,
       not a failure to punish. */
    if (j.gate !== false) {
      check(j.name + ' is consulted as a gate, not merely declared', () => got.gate
        ? true
        : j.name + ' is declared in ' + j.file + ' but never compared against anything — a list nothing checks protects nothing');
    }
  }
}

for (const s of SUBSETS) {
  const sql = schema.effective(s.sql);
  check('the schema still has ' + s.sql + ' (for ' + s.js.name + ')', () => sql
    ? true
    : 'supabase-*.sql no longer has a vocabulary CHECK on ' + s.sql);
  if (!sql) continue;
  coveredByRegistry.add(s.sql);

  const got = readList(s.js.file, s.js.name);
  check(s.js.name + ' is readable in ' + s.js.file, () => got.error ? got.error : true);
  if (got.error) continue;

  check(s.js.name + ' (' + s.js.file + ') only narrows ' + s.sql, () => {
    const a = new Set(sql.words);
    const extra = got.words.filter((w) => !a.has(w));
    return extra.length
      ? 'THE MOCK ACCEPTS ' + SHOW(extra, 6) + ', which ' + sql.file + ':' + sql.line + ' refuses — the subset rule: ' + s.why
      : true;
  });

  check(s.js.name + ' says why it is narrower than ' + s.sql, () => s.why && s.why.length > 40
    ? true
    : 'a subset without a reason is indistinguishable from a list somebody forgot to update');

  if (s.js.gate) {
    check(s.js.name + ' is consulted as a gate, not merely declared', () => got.gate
      ? true
      : s.js.name + ' is declared in ' + s.js.file + ' but never compared against anything');
  }
}

/* ------------------------------------------------------------
   completeness: no CHECK goes unexamined
   ------------------------------------------------------------ */

for (const key of Object.keys(NO_MIRROR)) {
  check('NONE entry ' + key + ' still names a CHECK', () => schema.all(key).length
    ? true
    : 'there is no vocabulary CHECK on ' + key + ' any more — the exemption is stale, and it is hiding whatever replaced it');
  coveredByRegistry.add(key);
}

check('every vocabulary CHECK in the schema is accounted for', () => {
  const unexamined = KEYS.filter((k) => !coveredByRegistry.has(k));
  return unexamined.length
    ? 'a CHECK nobody has considered: ' + unexamined.join(', ') +
      ' — add it to MIRRORS, SUBSETS or NO_MIRROR, because a mock that accepts its words is exactly the bug this file exists to find'
    : true;
});

/* every JS list named in the registry must still point at a real key */
check('the registry does not name a vocabulary the schema lacks', () => {
  const stale = [...coveredByRegistry].filter((k) => !schema.all(k).length);
  return stale.length ? 'the registry names ' + stale.join(', ') + ', which no supabase-*.sql defines' : true;
});

/* ------------------------------------------------------------
   the appender's own list, against the column it writes
   ------------------------------------------------------------ */

/* supabase-status-history.sql holds TWO lists of the same words: the
   CHECK on status_code_deliveries.note, and the `known` array the
   appender compares an incoming note against, with 'unrecorded' as the
   sentinel for a word it does not know. If the CHECK grows a word the
   appender has not learned, that word is stored as 'unrecorded' and the
   one diagnostic sentence the desk needs is silently lost. */
check('the note appender knows every word the note column allows', () => {
  const note = schema.effective('status_code_deliveries.note');
  if (!note) return 'the note CHECK is gone';
  const src = readFileSync(join(MIGRATIONS, 'supabase-status-history.sql'), 'utf8').replace(/--[^\n]*/g, ' ');
  const m = /known\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return 'the appender no longer declares a `known` array in supabase-status-history.sql';
  const known = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const sentinel = 'unrecorded';
  const expected = note.words.filter((w) => w !== sentinel);
  const missing = expected.filter((w) => !known.includes(w));
  const extra = known.filter((w) => !expected.includes(w));
  if (missing.length) return 'the column allows ' + SHOW(missing, 6) + ' but the appender would store it as "' + sentinel + '"';
  if (extra.length) return 'the appender recognises ' + SHOW(extra, 6) + ', which the column does not allow — it can never be written';
  if (!note.words.includes(sentinel)) return 'the sentinel "' + sentinel + '" is no longer allowed by the column the appender writes it to';
  return true;
});

/* ------------------------------------------------------------
   report
   ------------------------------------------------------------ */

const mirrors = MIRRORS.reduce((n, m) => n + m.js.length, 0);
console.log('\n' + '='.repeat(66));
console.log('schema vocabularies: ' + schema.entries.length + ' in ' + schema.files.length + ' files · ' + KEYS.length + ' columns');
console.log('compared: ' + mirrors + ' mirrors, ' + SUBSETS.length + ' subsets, ' + Object.keys(NO_MIRROR).length + ' exempt');
console.log('TOTAL ' + (pass + failures.length) + ' \u00b7 PASS ' + pass + ' \u00b7 FAIL ' + failures.length);
if (failures.length) {
  console.log('\nFailures:');
  for (const [name, why] of failures) console.log('  \u2717 ' + name + '\n      ' + why);
}
console.log('='.repeat(66));

process.exit(failures.length ? 1 : 0);
