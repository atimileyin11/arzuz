#!/usr/bin/env node
/* ============================================================
   Arzuz — is the database actually ready for launch?

   THE FAILURE THIS EXISTS FOR

     Every supabase-*.sql in this repo is applied BY HAND, in the
     SQL editor, in an order that matters. Nothing in the repository
     can see whether it happened. So the code can be perfect, every
     suite green, every page serving — and the site can still be
     unable to keep the promise it makes, because the table that
     mints a reference, or the column the status page reads, does
     not exist yet.

     That is not hypothetical, and it is not small. On 17 Oct 2026
     this check found EIGHT migrations unapplied on production:
     /status answered 502 on both steps, Care answered 502, and a
     student registering got no reference to read back. The whole
     waitlist launch package was missing. Every local suite passed
     throughout, because a suite that needs no database cannot miss
     one.

   HOW IT DECIDES, AND WHY IT NEEDS NO SECRET

     It reads the CREATE TABLE / CREATE VIEW statements out of each
     supabase-*.sql and asks PostgREST for one row of each relation,
     with the same public anon key the site ships in assets/config.js.
     PostgREST answers three ways, and all three are informative:

       404 PGRST205   not in the schema cache — the migration has
                      not run
       401 / 403      the relation exists and anon is denied. That
                      is the correct answer for every private table
                      (and 42501 "permission denied" is a POSITIVE
                      result here, not an error)
       200            the relation exists and anon may read it —
                      correct for the public views (public_listings,
                      amenities) and for nothing else

     Nothing is written and nothing private is read: the select asks
     for one row, and a private relation never gets that far.

   THE ONE EXCEPTION, AND WHY IT IS SAFE

     supabase-close-public-inserts.sql creates no relation, so the
     relation sweep cannot see it: it revokes anon's INSERT on the
     five public tables. That is the check `anon holds no INSERT
     grant` below, and it is the reason the door is the only way in.
     It sends an EMPTY body, which is safe in both states: `payload`
     is NOT NULL on all five tables, so a live grant answers 400
     (not-null, nothing written) and a revoked grant answers 401/403.
     A 200/201 means the grant survived — and, honestly, that this
     run has just left a row behind, named in the failure so it can
     be deleted.

   Run from arzuz-site/:
     node scripts/verify-migrations.mjs
     node scripts/verify-migrations.mjs --base <postgrest-url>

   Exits 1 if any migration is unapplied, so it can gate a launch.
   ============================================================ */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const cfg = readFileSync(join(SITE, 'assets', 'config.js'), 'utf8');
const DB = argOf('--base', (/SUPABASE_URL:\s*'([^']+)'/.exec(cfg) || [])[1] || '');
const ANON = (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(cfg) || [])[1] || '';
if (!DB || !ANON) {
  console.error('verify-migrations: assets/config.js has no SUPABASE_URL / SUPABASE_ANON_KEY to probe with');
  process.exit(2);
}
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

/* The launch-critical files, in the order LAUNCH-READINESS §3a says to
   run them. Anything else is reported after these, alphabetically. */
const LAUNCH_ORDER = [
  'supabase-team-roles.sql',
  'supabase-waitlist-launch.sql',
  'supabase-verification-rpc.sql',
  'supabase-verification-queue.sql',
  'supabase-verification-evidence.sql',
  'supabase-status-codes.sql',
  'supabase-status-history.sql',
  'supabase-close-public-inserts.sql'
];
const rank = (f) => {
  const i = LAUNCH_ORDER.indexOf(f);
  return i === -1 ? LAUNCH_ORDER.length : i;
};

const PASS = [];
const FAIL = [];
const ok = (name) => PASS.push(name);
const no = (name, why) => FAIL.push(name + '  ::  ' + why);

/* ---- what each migration says it creates (comments stripped, so a
   commented-out CREATE cannot be mistaken for the real thing) ---- */
const RELATION_RE = /create\s+(?:or\s+replace\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

const files = readdirSync(SITE).filter((f) => /^supabase-.*\.sql$/.test(f)).sort();
const plan = files.map((file) => {
  const src = readFileSync(join(SITE, file), 'utf8').replace(/--[^\n]*/g, ' ');
  const relations = [...new Set([...src.matchAll(RELATION_RE)].map((m) => m[1].toLowerCase()))];
  return { file, relations };
}).filter((m) => m.relations.length);

/* ---- probe one relation ---- */
async function look(name) {
  try {
    const res = await fetch(DB + '/rest/v1/' + name + '?select=*&limit=1', { headers: H });
    const body = await res.text();
    const code = (body.match(/"code":"([A-Z0-9]+)"/) || [])[1] || '';
    if (res.status === 200) return { state: 'readable', status: 200 };
    if (res.status === 404) return { state: 'missing', status: 404, code };
    if (res.status === 401 || res.status === 403) return { state: 'private', status: res.status, code };
    return { state: 'odd', status: res.status, code };
  } catch (err) {
    return { state: 'error', status: 0, code: err.message.slice(0, 60) };
  }
}

console.log('\nArzuz — migration state, read from the live database');
console.log('  database : ' + DB);
console.log('  key      : the public anon key from assets/config.js (read-only)\n');

const unapplied = [];
for (const m of plan.sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file))) {
  const seen = [];
  for (const name of m.relations) seen.push({ name, ...(await look(name)) });

  const gone = seen.filter((s) => s.state === 'missing');
  const broken = seen.filter((s) => s.state === 'error' || s.state === 'odd');

  console.log((gone.length ? '\u2717 ' : '\u2713 ') + m.file +
    (gone.length ? '   ' + gone.length + ' of ' + seen.length + ' relations MISSING' : '   all ' + seen.length + ' present'));
  for (const s of seen) {
    const mark = s.state === 'missing' ? '\u2717' : s.state === 'readable' ? '\u2713' : s.state === 'private' ? '\u2713' : '!';
    const note = s.state === 'missing' ? 'MISSING  ' + (s.code || '')
      : s.state === 'private' ? 'present, denied ' + (s.code || '')
      : s.state === 'readable' ? 'present, public'
      : 'HTTP ' + s.status + ' ' + (s.code || '');
    console.log('      ' + mark + ' ' + s.name.padEnd(30) + note);
  }
  console.log('');

  if (gone.length) unapplied.push({ file: m.file, missing: gone.map((s) => s.name) });
  if (broken.length) no(m.file + ' is reachable', broken.map((s) => s.name + ' answered ' + s.status + ' ' + s.code).join('; '));
  else if (gone.length) no(m.file + ' has been applied', gone.length + ' relation(s) missing: ' + gone.map((s) => s.name).join(', ') +
    ' — run it in Supabase → SQL Editor → New query');
  else ok(m.file + ' has been applied (' + seen.length + ' relation(s))');
}

/* ---- the grant that makes the door the only way in ---- */
const FIVE = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets'];
const open = [];
for (const t of FIVE) {
  try {
    const res = await fetch(DB + '/rest/v1/' + t, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      /* Empty on purpose: `payload` is NOT NULL on all five, so a live
         grant writes nothing and answers 400. */
      body: '{}'
    });
    if (res.status === 401 || res.status === 403) continue;
    /* 400 here is the not-null violation that means the grant is open and
       nothing was written; 200/201 means a row landed — say so, because
       that is a row somebody has to delete. */
    open.push(t + (res.status < 300 ? ' HTTP ' + res.status + ' (A ROW WAS WRITTEN — delete it)'
      : ' HTTP ' + res.status + ' (open, nothing written)'));
  } catch (err) {
    no('anon insert on ' + t + ' could be probed', err.message.slice(0, 60));
  }
}
if (open.length) {
  no('supabase-close-public-inserts.sql has been applied — anon still holds INSERT',
    open.join(', ') + '. Until this revoke runs the site has two doors: the validated function, and the anon key that ships in every page. This probe sends an empty body, which cannot satisfy the NOT NULL `payload`, so the failure above is the grant talking and not a row that was written.');
} else {
  ok('the direct door is closed — anon holds no INSERT on the five public tables');
}

/* ---- report ---- */
const totalMissing = unapplied.reduce((n, u) => n + u.missing.length, 0);
console.log('='.repeat(66));
console.log('migrations: ' + plan.length + ' files create relations · ' +
  (plan.length - unapplied.length) + ' applied · ' + unapplied.length + ' not applied');
if (unapplied.length) {
  console.log('\nNOT APPLIED, in the order LAUNCH-READINESS §3a gives:\n');
  unapplied.forEach((u, i) => console.log('  ' + (i + 1) + '. ' + u.file + '\n       ' + u.missing.join(', ')));
  console.log('\n  ' + totalMissing + ' relation(s) missing in total. Paste each file into');
  console.log('  Supabase → SQL Editor → New query → Run, then run this again.');
}
console.log('\nTOTAL ' + (PASS.length + FAIL.length) + ' \u00b7 PASS ' + PASS.length + ' \u00b7 FAIL ' + FAIL.length);
if (FAIL.length) {
  console.log('\nFailures:');
  for (const f of FAIL) console.log('  \u2717 ' + f);
}
console.log('='.repeat(66) + '\n');

process.exit(FAIL.length ? 1 : 0);
