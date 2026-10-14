#!/usr/bin/env node
/* ============================================================
   Arzuz — how much of the day's YouTube quota the tours have eaten

   The free quota is 10,000 units a day and one video insert costs
   1,600, so a good day of filming runs out at SIX uploads — not the
   seven it is easy to assume. The seventh is not slower or flakier,
   it is a 403 quotaExceeded, which reads to whoever is standing in
   the apartment like "the site is broken".

   Netlify's own function logs are the only place a session start is
   recorded, so this reads them. It answers two things:

     · per day: how many inserts, how many units, how much of the
       day's 10,000 is gone, and whether that day was OK, close, or
       exhausted;
     · right now: how many uploads are still left before the 403.

   WHERE THE NUMBERS COME FROM
     One line, emitted by netlify/functions/youtube-upload-start.js
     when YouTube accepts a resumable session:

       [youtube-quota] {"at":"<iso>","event":"videos.insert","units":1600}

     A single greppable marker with its own ISO timestamp, because the
     timestamp Netlify prefixes to a log line is a display format that
     changes — the clock this tool trusts is the one written by the
     function that spent the units.

     Nothing marks a video COMPLETED: the bytes go from the browser
     straight to Google, so the only edge this deployment can see is
     the session start. That makes these figures an upper bound — a
     session that was opened and then abandoned still counts here.
     Which is the safe direction for a guardrail.

   RUN IT
     node scripts/youtube-quota.mjs --file=logs.txt
     netlify functions:log youtube-upload-start | node scripts/youtube-quota.mjs
     node scripts/youtube-quota.mjs --check-instrumentation

   Options:
     --file=<path>       a saved log (repeatable, and a directory works)
     --days=<n>          how many days to show (default 14)
     --units=<n>         quota units one insert costs (default 1600)
     --quota=<n>         the daily allowance (default 10000)
     --json              the same figures as JSON, for a script
     --check-instrumentation  does the function emit the marker yet?
   ============================================================ */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '[youtube-quota]';

/* One videos.insert, from Google's published quota cost table. */
const UNITS_PER_INSERT = 1600;
const DAILY_UNITS = 10000;

const args = process.argv.slice(2);
const argVal = key => {
  const hit = args.find(a => a.startsWith('--' + key + '='));
  return hit ? hit.slice(key.length + 3) : null;
};
const argAll = key => args.filter(a => a.startsWith('--' + key + '=')).map(a => a.slice(key.length + 3));
const asNumber = (text, fallback) => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const UNITS = asNumber(argVal('units'), UNITS_PER_INSERT);
const QUOTA = asNumber(argVal('quota'), DAILY_UNITS);
const DAYS = Math.round(asNumber(argVal('days'), 14));
const asJson = args.includes('--json');
const checkOnly = args.includes('--check-instrumentation');

/* ------------------------------------------------------------
   Parsing. Split from the reading and the printing so a test can
   hand it log text instead of a file.
   ------------------------------------------------------------ */

/* Every marker line that carries a usable ISO timestamp and a unit
   count. A line that merely MENTIONS the marker — this tool's own
   help text in a pasted log, say — is not an event, so the JSON that
   follows is what decides. Malformed lines are counted rather than
   dropped silently: a marker that stopped parsing is how this tool
   would quietly read zero for ever. */
function parseLog(text) {
  const events = [];
  let malformed = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const at = raw.indexOf(MARKER);
    if (at === -1) continue;
    const tail = raw.slice(at + MARKER.length).trim();
    const start = tail.indexOf('{');
    if (start === -1) { malformed++; continue; }
    let parsed;
    try {
      parsed = JSON.parse(tail.slice(start));
    } catch (e) { malformed++; continue; }
    const when = new Date(parsed.at);
    if (isNaN(when.getTime())) { malformed++; continue; }
    const units = Number(parsed.units);
    events.push({
      at: when,
      date: when.toISOString().slice(0, 10),
      event: String(parsed.event || 'videos.insert'),
      units: Number.isFinite(units) && units > 0 ? units : UNITS,
      title: parsed.title ? String(parsed.title).slice(0, 80) : '',
    });
  }
  return { events, malformed };
}

/* ------------------------------------------------------------
   The day buckets and the verdict
   ------------------------------------------------------------ */

/* exhausted at the ceiling, close from 80% — and 80% is the line
   because the last insert either fits or it does not: at 6,400 units
   two uploads remain, and an upload is not divisible. */
function verdictOf(units, quota) {
  if (units >= quota) return 'EXHAUSTED';
  if (units >= quota * 0.8) return 'CLOSE';
  return 'ok';
}

function bar(units, quota, width) {
  const filled = Math.max(0, Math.min(width, Math.round((units / quota) * width)));
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

function summarize(events, opts) {
  const options = opts || {};
  const quota = options.quota || QUOTA;
  const days = options.days || DAYS;
  const now = options.now instanceof Date ? options.now : new Date();

  const byDate = new Map();
  /* the newest `days` dates, so a quiet week still shows as quiet
     rather than as an empty table */
  const window = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    window.push(key);
    byDate.set(key, { date: key, uploads: 0, units: 0, titles: [] });
  }

  let older = 0;
  for (const e of events) {
    const bucket = byDate.get(e.date);
    if (!bucket) { older++; continue; }
    bucket.uploads++;
    bucket.units += e.units;
    if (e.title) bucket.titles.push(e.title);
  }

  const rows = window.map(key => {
    const b = byDate.get(key);
    return {
      date: key,
      uploads: b.uploads,
      units: b.units,
      percent: Math.round((b.units / quota) * 100),
      verdict: verdictOf(b.units, quota),
    };
  });

  /* "today" is UTC, matching the timestamps Google bills against —
     the quota itself resets at midnight Pacific, so the figure is a
     local-day proxy and the closing note says so. */
  const today = rows[rows.length - 1] || { units: 0, uploads: 0, verdict: 'ok' };
  const remaining = Math.max(0, Math.floor((quota - today.units) / UNITS));

  return {
    quota,
    unitsPerInsert: UNITS,
    rows,
    eventsOutsideWindow: older,
    today: {
      units: today.units,
      uploads: today.uploads,
      percent: Math.round((today.units / quota) * 100),
      verdict: today.verdict,
      uploadsRemaining: remaining,
    },
    /* what the free tier really is, derived rather than remembered */
    uploadsPerFullDay: Math.floor(quota / UNITS),
  };
}

/* ------------------------------------------------------------
   Reading the logs
   ------------------------------------------------------------ */

function filesFrom(argPath) {
  const p = resolve(argPath);
  if (!existsSync(p)) return [];
  if (statSync(p).isDirectory()) {
    return readdirSync(p)
      .filter(f => /\.(log|txt|ndjson)$/i.test(f))
      .map(f => join(p, f))
      .sort();
  }
  return [p];
}

function readStdin() {
  return new Promise(resolveText => {
    if (process.stdin.isTTY) return resolveText('');
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => resolveText(text));
    process.stdin.on('error', () => resolveText(text));
  });
}

/* ------------------------------------------------------------
   Is the marker emitted at all?

   The honest half of this tool: a quota report built on a marker
   nobody writes is a report that says zero for ever, and zero reads
   like good news. So when the marker is absent from the function
   that spends the units, say so and name the one line to add.
   ------------------------------------------------------------ */

const FUNCTION_FILE = 'netlify/functions/youtube-upload-start.js';

function instrumentationReport(root) {
  const path = join(root, FUNCTION_FILE);
  let source = '';
  try { source = readFileSync(path, 'utf8'); } catch (e) { return { found: false, reason: 'missing', path: FUNCTION_FILE }; }
  const found = source.includes(MARKER);
  return {
    found,
    path: FUNCTION_FILE,
    reason: found ? 'present' : 'marker-absent',
  };
}

const ADVICE = [
  '',
  '  The upload function does not emit the marker yet, so there is nothing',
  '  to count. Add one line where YouTube has accepted the session — in',
  '  netlify/functions/youtube-upload-start.js, immediately after the',
  '  `if (!init.ok || !uploadUrl)` guard, beside the success return:',
  '',
  '    console.log(\'' + MARKER + ' \' + JSON.stringify({',
  '      at: new Date().toISOString(), event: \'videos.insert\', units: 1600,',
  '      title: String(req.title || \'\').slice(0, 80),',
  '    }));',
  '',
  '  1,600 units is the published cost of videos.insert. Emitting it on a',
  '  session that YouTube ACCEPTED (not on a failure) is what keeps the',
  '  number comparable to the quota actually spent.',
  '',
].join('\n');

/* ------------------------------------------------------------
   Main
   ------------------------------------------------------------ */

async function main() {
  const root = resolve(process.cwd());

  if (checkOnly) {
    const state = instrumentationReport(root);
    if (asJson) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log('\nYouTube quota instrumentation\n');
      console.log('  ' + (state.found ? '✓' : '✗') + ' ' + state.path + ' emits ' + MARKER + (state.found ? '' : ' — not yet'));
    }
    if (!state.found) console.log(ADVICE);
    return state.found ? 0 : 1;
  }

  const sources = argAll('file').flatMap(filesFrom);
  let text = '';
  for (const f of sources) {
    try { text += readFileSync(f, 'utf8') + '\n'; } catch (e) { console.error('could not read ' + f + ': ' + e.message); }
  }
  if (!sources.length) text = await readStdin();

  if (!text.trim()) {
    console.error('\nNothing to read. Give it a log:');
    console.error('  node scripts/youtube-quota.mjs --file=logs.txt');
    console.error('  netlify functions:log youtube-upload-start | node scripts/youtube-quota.mjs');
    console.error('\nAnd check the marker is being written at all:');
    console.error('  node scripts/youtube-quota.mjs --check-instrumentation\n');
    return 2;
  }

  const parsed = parseLog(text);
  const report = summarize(parsed.events, { quota: QUOTA, units: UNITS, days: DAYS });

  if (asJson) {
    console.log(JSON.stringify({ ...report, malformedLines: parsed.malformed }, null, 2));
    return parsed.malformed ? 1 : 0;
  }

  const seen = parsed.events.length;
  console.log('\nYouTube Data API quota — video tours\n');
  console.log('  ' + report.unitsPerInsert + ' units per upload · ' + report.quota +
    ' units a day · a full day is ' + report.uploadsPerFullDay + ' uploads\n');
  console.log('  date          uploads      units    used   budget');
  console.log('  ----------------------------------------------------------');
  for (const row of report.rows) {
    console.log('  ' + row.date.padEnd(12) +
      String(row.uploads).padStart(6) +
      String(row.units).padStart(11) +
      String(row.percent + '%').padStart(8) +
      '   ' + bar(row.units, report.quota, 20) +
      (row.verdict === 'ok' ? '' : '  ' + row.verdict));
  }
  console.log('  ----------------------------------------------------------');
  console.log('\n  Today (UTC): ' + report.today.uploads + ' upload' + (report.today.uploads === 1 ? '' : 's') +
    ', ' + report.today.units + ' units, ' + report.today.percent + '% of the day');
  console.log('  Uploads left today: ' + report.today.uploadsRemaining);
  if (report.today.verdict === 'EXHAUSTED') {
    console.log('\n  ✗ Exhausted. The next upload answers 403 quotaExceeded — that is the');
    console.log('    free tier, not a bug. It resets at midnight Pacific.');
  } else if (report.today.verdict === 'CLOSE') {
    console.log('\n  ! Close to the ceiling. ' + report.today.uploadsRemaining +
      ' more upload' + (report.today.uploadsRemaining === 1 ? '' : 's') + ' fit before the 403.');
  }
  if (parsed.malformed) {
    console.log('\n  ! ' + parsed.malformed + ' marker line(s) did not parse — the count above is low.');
  }
  if (report.eventsOutsideWindow) {
    console.log('  (' + report.eventsOutsideWindow + ' event(s) fell outside the ' + DAYS + '-day window)');
  }
  if (!seen) {
    console.log('\n  No uploads in these logs.');
    const state = instrumentationReport(root);
    if (!state.found) console.log(ADVICE);
  }
  console.log('\n  Note: Netlify keeps function logs for a limited time, so this sees');
  console.log('  the window those logs still cover. Sessions are counted, not');
  console.log('  finished videos, so the figure is an upper bound.\n');

  return parsed.malformed ? 1 : 0;
}

export { parseLog, summarize, verdictOf, bar };

/* Importable for tests without running: scripts/test-youtube-url.mjs
   imports this module for its pure functions, and only a direct
   invocation runs the report. fileURLToPath is what makes that
   comparison true on Windows too — the naive URL pathname is
   /C:/…/youtube-quota.mjs there, and would never match. */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(err => {
    console.error('youtube-quota failed:', err && err.message);
    process.exit(1);
  });
}
