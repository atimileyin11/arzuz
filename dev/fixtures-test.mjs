#!/usr/bin/env node
/* ============================================================
   Arzuz — every fixture is a value the product could actually hold

   THE FAILURE THIS EXISTS FOR

     A test is only as good as its fixture. If a test hands the
     product a reference the product cannot mint, or a phone number
     too short for the comparison it is used in, the assertion can
     still be green — and it is then green about a string that
     could never exist in production. That is not a weak test, it
     is a test proving something else.

     It has already happened twice here. A reference with an X
     where hex belongs was used to prove "a reference nobody
     minted is not known", which the function satisfies for a
     different reason: it could not parse the string at all. And a
     nine-digit number was used where the tail comparison needs
     ten, so two different numbers compared EQUAL and a test about
     who may see a record was passing on a collision it never
     noticed.

   WHAT IT JUDGES, AND WITH WHOSE RULES

     The rules are not restated here. The reference, phone and
     email rules are the PRODUCT'S: netlify/functions/status.js is
     required and its own normaliseRef / looksLikePhone /
     normaliseEmail are called. The vocabulary columns are read
     from the CHECK constraints in supabase-*.sql, through
     dev/schema-vocab.mjs. A copy of a rule in a test file can
     drift from the rule; a call to it cannot.

   WHAT IT SCANS, AND WHAT IT DELIBERATELY DOES NOT

     Only files that hold fixtures — scripts/test-*.mjs and the
     dev/*test*, *mock*, *fixture* harnesses. Product code is not
     scanned: a doc comment may name a malformed reference to
     explain why it is malformed, and `'ARZ-'` in status.js is a
     prefix being compared, not a fixture.

     Comments are stripped before scanning (the file that explains
     the old bad fixture must not be accused of holding one), and
     a literal that is one piece of a concatenation is skipped —
     `'0803' + n` is a fragment of a number, not a number.

   AND THE ONES THAT ARE WRONG ON PURPOSE

     Some genuinely invalid values are the point of the test: a
     deliberately bad address asserted to be refused, a
     nine-digit number the panel must explain. Those are named,
     one by one, in EXPECTED_BAD with the sentence that licenses
     them — never waved through by a keyword in the surrounding
     line, because a heuristic like that also waves through the
     next real mistake. Each entry must still be present in its
     file, so the exemption list cannot rot into permission.

   Run from arzuz-site/:
     node dev/fixtures-test.mjs
   ============================================================ */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocab } from './schema-vocab.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/* status.js reads no env at load and touches no DOM outside a
   function, so requiring it here is the same file the function runs.
   It is the ONE owner of the reference, phone and email rules — the
   reason this suite can say "the product would refuse this" instead of
   "a regex here would refuse this". */
const status = require('../netlify/functions/status.js');

/* ------------------------------------------------------------
   the fixture files
   ------------------------------------------------------------ */

const FIXTURE_FILES = [];
for (const f of readdirSync(join(ROOT, 'scripts'))) {
  if (/^test-.*\.mjs$/.test(f)) FIXTURE_FILES.push('scripts/' + f);
}
for (const f of readdirSync(join(ROOT, 'dev'))) {
  /* proof as well as test/mock/fixture: dev/sql-proof.mjs is almost
     nothing BUT fixtures — it seeds real rows and asserts on what the
     database says about them — so leaving it out would exempt the
     largest set of domain literals in the repo. */
  if (!/(test|mock|fixture|proof).*\.(js|mjs)$/i.test(f)) continue;
  /* not this file, and not its sibling: their own tables name bad values
     on purpose (that IS the allowlist), so scanning them would make every
     exemption report itself */
  if (f === 'fixtures-test.mjs' || f === 'mock-schema-test.mjs') continue;
  FIXTURE_FILES.push('dev/' + f);
}

/* ------------------------------------------------------------
   source with nothing in it but code
   ------------------------------------------------------------ */

/* Block comments, line comments and string contents are the three
   places a scanner goes wrong. This keeps the strings (they are what we
   are here for) and removes the comments, preserving every newline so a
   reported line number still points at the source. */
/* A REGEX LITERAL IS THE REASON THIS IS A TOKENISER AND NOT A REGEX.

   The first version of this function tracked quote characters and nothing
   else, so a regex like /[^']+/ opened a "string" that never closed and
   every comment after it was read as code — which is how a paragraph
   explaining the OLD bad fixture got reported as holding one. The three
   things a scanner has to know about are strings, template literals and
   regex literals, and only then are comments comments. */
function codeOnly(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && n === '/') {
      out += '  ';
      i += 2;
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      out += src.slice(start, i);
      continue;
    }

    if (c === '/' && startsExpression(src, i)) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;
        i++;
      }
      out += src.slice(start, i);
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/* a `/` here begins a regex only where a value may begin: after an
   operator, an opening bracket, a comma, a keyword like `return`, or the
   start of the file. After an identifier or a closing paren it is the
   division operator, and treating it as a regex would eat the line. */
function startsExpression(src, i) {
  const before = src.slice(Math.max(0, i - 30), i);
  if (/\b(return|case|typeof|instanceof|in|of|new|delete|void|do|else|yield|await)\s*$/.test(before)) return true;
  const prev = before.replace(/\s+$/, '').slice(-1);
  return prev === '' || '(,=:[!&|?{};+-*/%~^<>'.includes(prev);
}

/* every single-quoted literal, with the index it starts at, so a
   concatenation on either side can be recognised and skipped */
function literals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== "'" && q !== '"') continue;
    let j = i + 1;
    let value = '';
    let closed = false;
    while (j < src.length) {
      if (src[j] === '\\') { value += src[j + 1] || ''; j += 2; continue; }
      if (src[j] === q) { closed = true; break; }
      if (src[j] === '\n') break;
      value += src[j];
      j++;
    }
    if (!closed) continue;
    /* part of a concatenation: `'0803' + n` or `a + '1234'` */
    const before = src.slice(Math.max(0, i - 40), i).trimEnd();
    const after = src.slice(j + 1, j + 40).trimStart();
    const joined = /[+]$/.test(before) || /^[+]/.test(after);
    out.push({ value, index: i, joined });
    i = j;
  }
  return out;
}

const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/* ------------------------------------------------------------
   the rules, from the product and from the schema
   ------------------------------------------------------------ */

const schema = loadVocab(ROOT);
const VOCAB_PROP = ['follow_up_status', 'applicant_type', 'draft_permission', 'business_line', 'provider_answer', 'eligibility'];

/* A column can be constrained on more than one table — follow_up_status
   is on demand_records AND listings, business_line on payments AND the
   journal. That is fine while the two lists agree, and it is NOT fine
   when they disagree: a fixture saying `follow_up_status: 'x'` then
   means two different things depending on which table it is headed for,
   and no scanner can decide it from the object literal alone.

   The first version of this function quietly returned null for more
   than one key, which skipped the check entirely — a vocabulary column
   that was never judged, reported as a pass. It surfaced because a
   deliberately-wrong stage in a fixture did not fail the run. */
const vocabState = {};
for (const prop of VOCAB_PROP) {
  const keys = [...new Set(schema.entries.filter((e) => e.column === prop).map((e) => e.key))];
  if (!keys.length) { vocabState[prop] = { missing: true }; continue; }
  const sigs = keys.map((k) => schema.effective(k).words.slice().sort().join('|'));
  if (new Set(sigs).size > 1) {
    vocabState[prop] = { conflict: keys.map((k, i) => k + ' allows ' + sigs[i].split('|').join(', ')) };
  } else {
    vocabState[prop] = { sql: schema.effective(keys[0]) };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidShaped = (v) => /^[0-9a-f]{8}(-[0-9a-f]{1,12}){2,4}$/i.test(v) && !UUID.test(v);
const digits = (v) => v.replace(/\D/g, '');
const PHONE_HINT = /\b(phone|tel|whatsapp|contact|owner_phone|student_phone|owner_tel|number(?!\s*\())\b/i;

/* ------------------------------------------------------------
   the values that are wrong on purpose
   ------------------------------------------------------------ */

const EXPECTED_BAD = [
  /* test-status.mjs — the ONE ANSWER is proved by feeding the door the
     shapes a curious caller would try, and asserting every one gets the
     same reply. A malformed reference is the whole point of the test. */
  { file: 'scripts/test-status.mjs', value: 'ARZ-S-1234', why: 'a reference too short to be one, fed to the door to prove the answer does not vary' },
  { file: 'scripts/test-status.mjs', value: 'ARZ-S-4F7A-2C9B-1D3', why: 'one character short; the door must answer exactly as it does for a real one' },
  { file: 'scripts/test-status.mjs', value: 'ARZ-X-4F7A-2C9B-1D3E', why: 'a letter that is not S or L; refused identically to a real reference' },
  { file: 'scripts/test-status.mjs', value: 'ARZ-S-4F7A-2C9B-1D3E; drop table demand_records', why: 'an injection attempt: the shape check is what stops it reaching the database' },
  { file: 'scripts/test-status.mjs', value: 'amaka@example', why: 'an address with no TLD, asserted to be refused — it is what "does not look complete" means' },

  /* test-waitlist.mjs — the door's own email refusal, one bad shape at
     a time, each asserted to be a 400. */
  { file: 'scripts/test-waitlist.mjs', value: 'amaka@example', why: 'the no-TLD address in the list the door must refuse, asserted 400' },

  /* sql-proof.mjs — the phone tail comparison, from the SQL side. The
     short number is asserted to produce "" rather than a tail. */
  { file: 'dev/sql-proof.mjs', value: '080300002', why: 'nine digits, asserted to have NO tail — the case that made two numbers compare equal' },

  /* admin-boot-test.js — the panel's "that is not a reference" hint. The
     typo is the input; the assertion is on the sentence explaining it. */
  { file: 'dev/admin-boot-test.js', value: '080300002', why: 'a mistyped number typed into the reference box, asserted to be explained, not resolved' },

  /* A reference in the fixtures that the door would refuse, kept where a
     stale or hand-edited row is being rendered rather than looked up: a
     dashboard has to survive a value that is not a reference at all. */
  /* The billing address the site INVENTS is not a mailbox, and both
     suites prove the code refuses to send a code there. It is a bad
     address on purpose, in the one place its badness is the subject. */
  { file: 'scripts/test-status.mjs', value: '08031234567@receipts.arzuz.com', why: 'the invented receipts address, asserted to be refused as a mailbox' },
  { file: 'scripts/test-waitlist.mjs', value: '08031234567@receipts.arzuz.com', why: 'the same invented address, asserted to be a 400 at the door' },
  { file: 'scripts/test-claims.mjs', value: 'maybe', why: 'eligibility: maybe — the word the decision test feeds in to prove a decision needs a real answer' },
];

const licensed = (file, value) => EXPECTED_BAD.filter((e) => e.file === file && e.value === value);

/* ------------------------------------------------------------
   scan
   ------------------------------------------------------------ */

const found = new Map();      /* key: file + '\u0000' + value -> [line] */
const violations = [];
/* `seen` counts VALUES JUDGED, `violations` counts the ones that failed.
   The first version incremented one counter only when a value was bad,
   so the "did the scanner actually read anything" check was measuring
   the failure count and calling it coverage — a green line about a
   scanner that had silently stopped finding fixtures. */
const seen = { ref: 0, phone: 0, email: 0, uuid: 0, vocab: 0 };

for (const rel of FIXTURE_FILES) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  const code = codeOnly(raw);

  const observe = (kind, value, line) => {
    seen[kind]++;
    const k = rel + '\u0000' + value;
    if (!found.has(k)) found.set(k, []);
    found.get(k).push(line);
  };
  const hit = (kind, value, line, why) => {
    observe(kind, value, line);
    if (!licensed(rel, value).length) violations.push({ rel, line, kind, value, why });
  };

  for (const lit of literals(code)) {
    const v = lit.value;
    if (!v || lit.joined) continue;
    const line = lineAt(code, lit.index);

    /* a reference: everything that starts like one has to BE one. The
       prefix is matched loosely on purpose — 'ARZ-X-…' is exactly the
       kind of near-miss a fixture must not smuggle in, and reading only
       ARZ-S/ARZ-L would skip the one that is wrong. */
    if (/^ARZ-/i.test(v) && !/-$/.test(v)) {
      observe('ref', v, line);
      if (!status.normaliseRef(v)) {
        hit('ref', v, line, 'the door would read this as no reference at all (normaliseRef → ""), so a test using it as one is testing the unreadable path');
      }
    }

    /* a phone number: only where the value is one, or the line says so.
       `number` must not be followed by a paren — `Number(count)` in a
       sentence about numbers is not a phone field, and that is how a
       nine-figure RENT (correctly) got reported as a short phone. */
    if (/^[0-9+\s()-]{7,20}$/.test(v) && digits(v).length >= 7 && digits(v).length <= 15
      && (/^(0|\+?234)/.test(digits(v)) || PHONE_HINT.test(code.split('\n')[line - 1] || ''))) {
      observe('phone', v, line);
      if (!status.looksLikePhone(v)) {
        hit('phone', v, line, 'the product needs 10–15 digits; with fewer, phoneTail() is "" and two different numbers compare EQUAL');
      }
    }

    /* an address: loosely shaped, and not a regex */
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(v) && !/[<>[\]()\\*?^${}|]/.test(v)) {
      observe('email', v, line);
      if (!status.normaliseEmail(v)) {
        hit('email', v, line, 'the door would refuse this address (no TLD, or not deliverable), so the second channel could never reach it');
      }
    }

    /* a UUID: counted when well-formed, refused when it only wears the
       shape — a 3-group string cast to ::uuid is a 22P02, not the
       refusal the test is asserting */
    if (UUID.test(v)) observe('uuid', v, line);
    if (uuidShaped(v)) {
      observe('uuid', v, line);
      hit('uuid', v, line, 'not a uuid Postgres accepts — a ::uuid cast would be a 22P02, not the refusal the test asserts');
    }
  }

  /* the vocabulary columns, in the object-literal form fixtures use */
  for (const prop of VOCAB_PROP) {
    const state = vocabState[prop];
    if (!state.sql) continue;
    const sql = state.sql;
    const re = new RegExp('\\b' + prop + '\\s*:\\s*[\'"]([^\'"]*)[\'"]', 'g');
    let m;
    while ((m = re.exec(code))) {
      observe('vocab', m[1], lineAt(code, m.index));
      if (licensed(rel, m[1]).length) continue;
      if (!sql.words.includes(m[1])) {
        violations.push({
          rel, line: lineAt(code, m.index), kind: 'vocab', value: m[1],
          why: prop + ' cannot be \'' + m[1] + '\' — ' + sql.file + ':' + sql.line + ' allows ' + sql.words.join(', '),
        });
      }
    }
  }
}

/* ------------------------------------------------------------
   the checks
   ------------------------------------------------------------ */

let pass = 0;
const failures = [];
const check = (name, ok, why) => {
  if (ok) pass++;
  else failures.push([name, why]);
};

check('the fixture set was found', FIXTURE_FILES.length >= 20,
  'only ' + FIXTURE_FILES.length + ' fixture files matched — the scanner is looking in the wrong place, and every result below would be vacuous');

check('the scan actually read values', seen.ref + seen.phone + seen.email + seen.vocab >= 100,
  'only ' + (seen.ref + seen.phone + seen.email + seen.vocab) + ' domain literals were judged — a scanner that finds nothing proves nothing');

check('references were exercised', seen.ref >= 20, 'only ' + seen.ref + ' reference literals were judged');
check('phone numbers were exercised', seen.phone >= 20, 'only ' + seen.phone + ' phone literals were judged');
check('addresses were exercised', seen.email >= 10, 'only ' + seen.email + ' address literals were judged');
check('schema vocabulary was exercised', seen.vocab >= 20, 'only ' + seen.vocab + ' fixture values used a vocabulary column');

/* a column whose tables disagree is a fixture the scanner must not
   pretend to have judged */
for (const prop of VOCAB_PROP) {
  const state = vocabState[prop];
  if (state.conflict) {
    failures.push([
      'the column ' + prop + ' means one thing on more than one table',
      state.conflict.join('  ·  ') + '. A fixture cannot say which table it is for, so every value was skipped — make the two CHECKs agree, and this scan can judge it again.',
    ]);
  }
  if (state.missing) {
    failures.push([
      'the column ' + prop + ' is no longer constrained',
      'the fixtures suite expects a vocabulary CHECK on it; either the constraint was dropped or the column was renamed',
    ]);
  }
}

for (const v of violations) {
  failures.push([
    v.rel + ':' + v.line + '  ' + JSON.stringify(v.value),
    v.why + '  (if the value is wrong on purpose, name it in EXPECTED_BAD with the sentence that licenses it)',
  ]);
}

/* anti-rot: an exemption for a value that is no longer there is a
   permission nobody is watching, and it hides the next real one */
for (const e of EXPECTED_BAD) {
  const seen = found.get(e.file + '\u0000' + e.value);
  check('EXPECTED_BAD still finds ' + JSON.stringify(e.value) + ' in ' + e.file,
    !!seen,
    'that value is not in the file any more — remove the exemption, or it is now covering something else');
}

/* ------------------------------------------------------------
   report
   ------------------------------------------------------------ */

console.log('\n' + '='.repeat(66));
console.log('fixture files: ' + FIXTURE_FILES.length +
  '  ·  judged: ' + seen.ref + ' refs, ' + seen.phone + ' phones, ' +
  seen.email + ' addresses, ' + seen.uuid + ' uuids, ' + seen.vocab + ' vocabulary values');
console.log('licensed exceptions: ' + EXPECTED_BAD.length + '  (each one must still be in its file)');
console.log('TOTAL ' + (pass + failures.length) + ' \u00b7 PASS ' + pass + ' \u00b7 FAIL ' + failures.length);
if (failures.length) {
  console.log('\nFailures:');
  for (const [name, why] of failures) console.log('  \u2717 ' + name + '\n      ' + why);
}
console.log('='.repeat(66));

process.exit(failures.length ? 1 : 0);
