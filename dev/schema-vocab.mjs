/* ============================================================
   Arzuz — the schema's OWN vocabularies, read from the migrations

   WHY THIS IS A FILE AND NOT A LISTED TABLE

     dev/mock-schema-test.mjs exists to catch one mistake: a mock
     that accepts a word Postgres would refuse. The only way to
     know which words Postgres refuses is to read the CHECK
     constraints in supabase-*.sql — and if the answer were a list
     written by hand in the test, it would be a third copy of the
     vocabulary, free to drift from both the schema and the mock.
     So this module parses the SQL and the test compares against
     what the database actually says.

   WHAT IT UNDERSTANDS, and why that is enough

     A CHECK is a vocabulary when its whole body is one of:

         col in ('a', 'b')
         col is null or col in ('a', 'b')

     which is the shape every enumerable column in this schema is
     written in. Anything else — `amount_kobo > 0`, the compound
     shape rules, `status <> 'paid' or paid_at is not null` — is a
     PREDICATE, not a vocabulary, and this module deliberately does
     not guess at its allowed values. A parser that tried to
     interpret arbitrary SQL would produce a confident wrong
     answer, which is the failure this whole audit is about.

     The table a CHECK belongs to is found by the statement that
     encloses it — `create table ... (...)` or `alter table ... ;`
     — rather than by looking upwards for the nearest CREATE TABLE.
     The distinction matters here: supabase-draft-sharing.sql adds
     `listings_draft_permission_chk` inside a `do $$ ... $$` block,
     and a scanner that cut out every dollar-quoted body to avoid
     function code would never see it.

   THE ORDER IS THE POINT TOO

     A vocabulary may be re-stated by a later migration —
     care_credit_events.event is 5 words in supabase-care.sql and
     7 in supabase-claims.sql. The file that runs LAST is the one
     the database enforces, so `effective()` reports that one and
     `all()` keeps every occurrence, so a test can say which
     migration it is talking about instead of trusting a guess at
     the order.
   ============================================================ */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* a region blanked but its newlines kept, so every offset and line
   number a caller prints still points at the source it came from */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/* ------------------------------------------------------------
   the order the migrations are applied in
   ------------------------------------------------------------ */

/* dev/sql-proof.mjs is the one place that states it, so the order is
   read from there rather than kept here as a second opinion. */
export function chainOrder(root) {
  const src = readFileSync(join(root, 'dev/sql-proof.mjs'), 'utf8');
  const at = src.indexOf("'supabase-schema.sql'");
  if (at === -1) return null;
  const open = src.lastIndexOf('[', at);
  const close = src.indexOf(']', at);
  if (open === -1 || close === -1) return null;
  return [...src.slice(open, close).matchAll(/'([^']+\.sql)'/g)].map((m) => m[1]);
}

/* ------------------------------------------------------------
   the enclosed statement for every CHECK
   ------------------------------------------------------------ */

/* create table ... ( ... ) — from the opening paren to its match */
function createRanges(src) {
  const out = [];
  const re = /create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close !== -1) out.push({ table: m[1].toLowerCase(), start: open, end: close });
  }
  return out;
}

/* alter table X ... ; — one statement, ending at the first semicolon
   after the statement starts (an ALTER here never nests a function) */
function alterRanges(src) {
  const out = [];
  const re = /alter table (?:if exists )?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(src))) {
    const semi = src.indexOf(';', m.index);
    out.push({ table: m[1].toLowerCase(), start: m.index, end: semi === -1 ? src.length : semi });
  }
  return out;
}

/* the innermost enclosing statement wins: a CHECK inside a `do $$`
   block that ALTERs a table belongs to that ALTER, not to whatever
   CREATE TABLE happened to be earlier in the file */
function tableAt(ranges, pos) {
  let best = null;
  for (const r of ranges) {
    if (pos >= r.start && pos <= r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
  }
  return best ? best.table : null;
}

/* the pure-vocabulary shapes, and nothing else */
const SHAPES = [
  /^([a-z_][a-z0-9_]*)\s+in\s*\(([^)]*)\)$/i,
  /^([a-z_][a-z0-9_]*)\s+is null or\s+([a-z_][a-z0-9_]*)\s+in\s*\(([^)]*)\)$/i,
];

export function loadVocab(root) {
  const files = readdirSync(root).filter((f) => /^supabase-.*\.sql$/.test(f)).sort();
  const order = chainOrder(root) || [];
  const rank = (f) => {
    const i = order.indexOf(f);
    return i === -1 ? order.length + files.indexOf(f) : i;
  };

  const entries = [];
  for (const file of files) {
    const raw = readFileSync(join(root, file), 'utf8');
    const src = raw.replace(/--[^\n]*/g, blank);
    const ranges = createRanges(src).concat(alterRanges(src));

    for (let i = 0; i < src.length; i++) {
      if (src.slice(i, i + 5).toLowerCase() !== 'check') continue;
      if (!/^check\s*\(/i.test(src.slice(i, i + 40))) continue;
      const open = src.indexOf('(', i);
      let depth = 0;
      let close = -1;
      for (let k = open; k < src.length; k++) {
        if (src[k] === '(') depth++;
        else if (src[k] === ')') {
          depth--;
          if (depth === 0) { close = k; break; }
        }
      }
      if (close === -1) continue;
      i = close;

      const body = src.slice(open + 1, close).trim();
      let column = null;
      let list = null;
      for (const shape of SHAPES) {
        const m = shape.exec(body);
        if (m) {
          column = m[1].toLowerCase();
          list = m[m.length - 1];
          /* `note is null or note in (...)` must name the SAME column
             twice; anything else is a different rule wearing the shape */
          if (m.length === 4 && m[2].toLowerCase() !== column) { column = null; break; }
          break;
        }
      }
      if (!column) continue;

      const words = [...list.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
      if (words.length < 2) continue;

      const table = tableAt(ranges, i);
      const line = src.slice(0, i).split('\n').length;
      entries.push({
        file,
        line,
        table,
        column,
        key: (table || '?') + '.' + column,
        words,
        rank: rank(file),
      });
    }
  }

  entries.sort((a, b) => a.rank - b.rank || a.line - b.line);

  const all = (key) => entries.filter((e) => e.key === key);
  /* the database enforces the LAST definition, which is the one in
     the migration that runs last — not the one printed last here */
  const effective = (key) => {
    const list = all(key);
    return list.length ? list.reduce((a, b) => (b.rank >= a.rank ? b : a)) : null;
  };

  return { entries, all, effective, files, order, rank };
}
