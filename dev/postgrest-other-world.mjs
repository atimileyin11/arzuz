#!/usr/bin/env node
/* ============================================================
   Arzuz — the OTHER Care world, derived from the recording (DEV ONLY)

     node dev/postgrest-other-world.mjs                  writes dev/.other-world.json
     ARZUZ_POSTGREST_FIXTURE=dev/.other-world.json node dev/postgrest-test.js

   WHY THIS EXISTS

     dev/postgrest-test.js §3 asserts what a student link means in
     whichever Care world the recording was taken in — and only ONE of
     those worlds can be recorded at a time, because the other one
     requires supabase-care.sql to have been applied. So the branch
     that matters most after the migration is the branch that never
     runs before it.

     This derives that world from the recording so it can be rehearsed.
     It earned its place immediately: the first rehearsal caught a
     classifier that read "the last entry for care_credit_events" —
     which, once the tables exist, is a note about a POST that was
     never sent, so a finished migration read as half-applied.

   THE ONE ASSUMPTION, STATED RATHER THAN HIDDEN

     Flipping to the PRESENT world sets every Care read to 401 + 42501,
     i.e. "the relation exists and the public key has no grant on it".
     That is not a wish: `npm run sql:proof` executes it against real
     PostgreSQL (anon is refused 42501 on care_plans, holds no SELECT
     on care_credit_events, and both views carry security_invoker), and
     the recording itself measures the 401 + 42501 mapping on eight
     other relations. What is NOT certain is only whether the live
     project would answer 401 or 403 for the views — the platform has
     used both — which is why admin.js folds them, and why the check in
     §3 accepts either. The real recording is what settles it.

     Flipping BACK to the ABSENT world assumes 404 + PGRST205, which is
     the one class PostgREST uses for a relation missing from its schema
     cache — recorded eleven times in the current fixture.

   It is a COPY. The header of what it writes says so, the path it
   writes to is a dot-file, and nothing in the suite treats it as a
   recording.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDING = process.env.ARZUZ_POSTGREST_FIXTURE || join(ROOT, 'dev/postgrest-fixture.json');
const OUT = join(ROOT, 'dev/.other-world.json');

const CARE = ['care_plans', 'care_credit_events', 'care_credit_balance', 'care_plans_live'];
const VIEWS = { care_plans_live: 1, care_credit_balance: 1 };
const relationOf = (p) => String(p).split('?')[0];

const fixture = JSON.parse(readFileSync(RECORDING, 'utf8'));

/* Which world is this recording in? The GET per relation, never "the
   last entry" — the same mistake this file was written to catch. */
const reads = CARE.map((rel) =>
  fixture.responses.filter((r) => r.method === 'GET' && relationOf(r.path) === rel)[0]);
const absent = reads.filter((r) => r && r.code === 'PGRST205').length;
const present = reads.filter((r) => r && (r.status === 401 || r.status === 403)).length;
const from = absent === CARE.length ? 'absent' : present === CARE.length ? 'present' : null;
if (!from) {
  console.error('The recording is not in one clean world (absent=' + absent + ' present=' + present +
    ' of ' + CARE.length + '). Re-capture first: npm run postgrest:capture');
  process.exit(1);
}
const to = from === 'absent' ? 'present' : 'absent';

for (const r of fixture.responses) {
  const rel = relationOf(r.path);
  if (CARE.indexOf(rel) === -1) continue;

  /* The forged ledger insert: recorded live only while the table is
     absent, because once it exists the request would be a real write.
     So in the present world it is a skip note, and flipping back means
     restoring the class the platform gives an absent relation. */
  if (r.method === 'POST') {
    if (to === 'present') {
      r.status = null;
      r.code = 'skipped';
      r.bodyKind = 'none';
      r.bodyText = '';
      r.message = 'not sent';
      r.note = 'Skipped on purpose: the table exists, so a forged insert that the platform wrongly ' +
        'allowed would be a real row in the Care ledger. The claim it would test (no client role may ' +
        'insert) is asserted against real PostgreSQL by npm run sql:proof, which revokes the privilege ' +
        'and proves the refusal with 42501.';
    } else {
      r.status = 404;
      r.code = 'PGRST205';
      r.bodyKind = 'object';
      r.message = "Could not find the table 'public.care_credit_events' in the schema cache";
      r.bodyText = JSON.stringify({ code: 'PGRST205', details: null, hint: null, message: r.message });
      r.note = null;
    }
    continue;
  }

  if (to === 'present') {
    r.status = 401;
    r.code = '42501';
    r.message = 'permission denied for ' + (VIEWS[rel] ? 'view' : 'table') + ' ' + rel;
  } else {
    r.status = 404;
    r.code = 'PGRST205';
    r.message = "Could not find the table 'public." + rel + "' in the schema cache";
  }
  r.bodyKind = 'object';
  r.bodyText = JSON.stringify({ code: r.code, details: null, hint: null, message: r.message });
}

fixture.captured_at += ' + derived to the ' + to.toUpperCase() + ' world (' + from + ' flipped, derived not recorded)';
fixture.note = 'DERIVED COPY of ' + RECORDING + ' — dev/postgrest-other-world.mjs flipped the Care ' +
  'relations from ' + from + ' to ' + to + ', because a world that needs supabase-care.sql applied ' +
  'cannot be recorded until it is. Rebuild with: node dev/postgrest-other-world.mjs';

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');

console.log('Derived the ' + to.toUpperCase() + ' world from the ' + from + ' recording.');
console.log('  wrote: ' + OUT);
console.log('  then : ARZUZ_POSTGREST_FIXTURE=dev/.other-world.json node dev/postgrest-test.js');
