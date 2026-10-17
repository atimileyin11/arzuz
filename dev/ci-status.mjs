#!/usr/bin/env node
/* ============================================================
   Arzuz — what did CI say about this commit?

   THE GAP THIS CLOSES

     The one thing this repo could never check from a terminal was
     whether GitHub Actions ran. `gh` is not installed here, and the
     obvious substitute — curl the public API — answers 404:

         https://api.github.com/repos/<owner>/<name>/actions/runs
         404 Not Found

     That 404 is not "this repo has no CI". GitHub answers 404 (never
     403) for a repository the caller may not see, so that a private
     repo cannot be distinguished from a missing one by an anonymous
     caller. The message is deliberate and the conclusion it invites is
     wrong, which is how "we cannot check CI" quietly becomes "CI is
     fine". This file asks the same question WITH credentials and says
     plainly which of the two answers it got.

   HOW TO USE IT

     node dev/ci-status.mjs                 the HEAD commit, from git
     node dev/ci-status.mjs --sha <sha>     a specific commit
     node dev/ci-status.mjs --repo o/n      override the remote
     node dev/ci-status.mjs --limit 10      how many runs to list

     It reads GH_TOKEN, then GITHUB_TOKEN, from the environment. It never
     prints, echoes or logs the value — only whether it found one, and
     what GitHub said back. Set it in the shell you run this from:

       GH_TOKEN=github_pat_... node dev/ci-status.mjs        (bash)
       $env:GH_TOKEN='github_pat_...'; node dev/ci-status.mjs  (PowerShell)

     A fine-grained token with `Actions: read` (and `Contents: read` for
     the commit lookup) is enough. Do NOT paste a token into a file in
     this repo: `publish = "."` serves every file, and scripts/test-
     deploy-guards.mjs is the only thing standing between a committed
     token and the open web.

   EXIT CODES

     0  every check GitHub knows about for that commit finished green
     1  something finished red (failed, cancelled, timed_out, action_required)
     2  it could NOT be checked — no token, no runs yet, or the API refused.
        "Not verified" is not "verified fine": a caller that treats 2 as
        success has rebuilt the bug this file exists to remove.
   ============================================================ */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

function git(args) {
  try {
    return execFileSync('git', args, { cwd: SITE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

/* owner/name from the remote, so nobody has to type it twice */
function repoFromRemote() {
  const url = git(['remote', 'get-url', 'origin']);
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1] + '/' + m[2] : '';
}

const REPO = argOf('--repo', repoFromRemote());
const SHA = argOf('--sha', git(['rev-parse', 'HEAD']));
const LIMIT = Number(argOf('--limit', '5')) || 5;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

async function main() {
console.log('\nArzuz — CI status');
console.log('  repo    : ' + (REPO || '(no GitHub remote found)'));
console.log('  commit  : ' + (SHA ? SHA.slice(0, 12) : '(git could not read HEAD)'));
console.log('  token   : ' + (TOKEN ? 'found in the environment (' +
  (process.env.GH_TOKEN ? 'GH_TOKEN' : 'GITHUB_TOKEN') + ')' : 'NOT SET'));

if (!REPO || !SHA) {
  console.log('\nCANNOT CHECK (2): this is not a git checkout with a GitHub remote.');
  return 2;
}

if (!TOKEN) {
  console.log('\nCANNOT CHECK (2) — and this is the 404 you have probably seen.\n');
  console.log('  Without a token, https://api.github.com/repos/' + REPO + '\n' +
    '  answers 404 ["Not Found"]. GitHub does that on purpose: a repository the\n' +
    '  caller may not see is answered exactly like one that does not exist, so a\n' +
    '  private repo cannot be discovered by probing. The 404 therefore means\n' +
    '  "credentials required", never "no CI here".\n');
  console.log('  Two ways to answer the question for real:\n');
  console.log('    1. a token (no gh needed):');
  console.log('         GH_TOKEN=<fine-grained token, Actions: read> node dev/ci-status.mjs');
  console.log('    2. the GitHub CLI, which stores its own:\n' +
    '         winget install --id GitHub.cli   (or brew install gh / apt install gh)\n' +
    '         gh auth login\n' +
    '         gh run list -L 5\n');
  console.log('  Either way the token stays out of this repo: it is read from the\n' +
    '  environment and never written, printed or committed.\n');
  return 2;
}

const H = {
  Accept: 'application/vnd.github+json',
  Authorization: 'Bearer ' + TOKEN,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'arzuz-ci-status'
};

async function api(path) {
  const res = await fetch('https://api.github.com' + path, { headers: H });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, body, text };
}

/* ---- 1. what did the checks say about this commit? ---- */
const checks = await api('/repos/' + REPO + '/commits/' + SHA + '/check-runs?per_page=100');
if (checks.status === 404) {
  console.log('\nCANNOT CHECK (2): GitHub answered 404 for ' + REPO + '.');
  console.log('  With a token in hand that means the token cannot see this repository —');
  console.log('  check the token\'s repository access, not the repo\'s CI.');
  return 2;
}
if (checks.status === 401) {
  console.log('\nCANNOT CHECK (2): the token was refused (401 Bad credentials).');
  console.log('  An expired or revoked token looks exactly like this.');
  return 2;
}
if (checks.status !== 200) {
  console.log('\nCANNOT CHECK (2): HTTP ' + checks.status + ' from the checks API — ' +
    String((checks.body && checks.body.message) || checks.text).slice(0, 160));
  return 2;
}

const runs = (checks.body && checks.body.check_runs) || [];
const RED = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];
const notDone = runs.filter((r) => r.status !== 'completed');
const red = runs.filter((r) => RED.indexOf(r.conclusion) !== -1);

console.log('\nCHECK RUNS on ' + SHA.slice(0, 12) + ' (' + runs.length + ')');
if (!runs.length) console.log('  none — GitHub has no check run for this commit at all');
for (const r of runs) {
  const mark = r.status !== 'completed' ? '\u2026' : RED.indexOf(r.conclusion) !== -1 ? '\u2717' : '\u2713';
  console.log('  ' + mark + ' ' + String(r.name).padEnd(34) +
    r.status + (r.status === 'completed' ? ' · ' + r.conclusion : '') +
    (r.html_url ? '' : ''));
}

/* ---- 2. what did Actions itself say? (a check run can be missing on a
   workflow that never started, so the run list is the second opinion) ---- */
const list = await api('/repos/' + REPO + '/actions/runs?per_page=' + Math.max(1, Math.min(50, LIMIT)));
if (list.status === 200 && list.body) {
  const all = list.body.workflow_runs || [];
  const forThis = all.filter((r) => r.head_sha === SHA);
  console.log('\nWORKFLOW RUNS for this commit (' + forThis.length + ' of the last ' + all.length + ')');
  if (!forThis.length) {
    console.log('  none in the last ' + all.length + ' runs — the workflows may not have been' +
      '\n  triggered for this commit at all (a push to another branch, or Actions disabled)');
  }
  for (const r of forThis) {
    const mark = r.status !== 'completed' ? '\u2026' : RED.indexOf(r.conclusion) !== -1 ? '\u2717' : '\u2713';
    console.log('  ' + mark + ' ' + String(r.name).padEnd(34) + r.status +
      (r.status === 'completed' ? ' · ' + r.conclusion : '') +
      '  (' + String(r.head_branch || '?') + ')');
  }
} else if (list.status !== 200) {
  console.log('\n  (the Actions run list was not readable — HTTP ' + list.status + ')');
}

/* ---- verdict ---- */
console.log('\n' + '='.repeat(60));
if (!runs.length) {
  console.log('CANNOT CHECK (2): no check run exists for this commit. Nothing failed,\n' +
    'and nothing passed either — that is the state this file refuses to call green.');
  return 2;
}
if (red.length) {
  console.log('RED (1): ' + red.map((r) => r.name + ' = ' + r.conclusion).join(', '));
  return 1;
}
if (notDone.length) {
  console.log('RUNNING (2): ' + notDone.map((r) => r.name + ' = ' + r.status).join(', ') +
    '\nRe-run this in a minute; a run in progress is not a passed run.');
  return 2;
}
console.log('GREEN (0): all ' + runs.length + ' check run(s) for ' + SHA.slice(0, 12) + ' completed cleanly.');
return 0;
}

process.exitCode = await main();
