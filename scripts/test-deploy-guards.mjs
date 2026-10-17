#!/usr/bin/env node
/* ============================================================
   Arzuz — deploy guards

   netlify.toml publishes the whole repo (`publish = "."`), which
   means every file in it is a URL. That is how the SQL schema —
   the complete RLS design, the table shapes, the admin model —
   was once readable by anyone who guessed the filename, and why
   every supabase-*.sql now carries a hard 404.

   The rule this file enforces is the one the config comment states
   and nothing else checks: if it is not part of the website, it is
   not public. It reads netlify.toml and the filesystem, so it is a
   static check with no network and no secrets.

   Also checked here, because they are the same class of mistake —
   a change in one place that silently invalidates another:

     · every URL in sitemap.xml still resolves to something real
     · a page the site keeps out of the index is not in the sitemap
     · robots.txt and sitemap.xml have no byte-order mark (a BOM in
       either one broke Search Console once already)
     · robots.txt still points at the sitemap

   Run from arzuz-site/:
     node scripts/test-deploy-guards.mjs
   ============================================================ */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASS = [];
const FAIL = [];
const check = (name, ok, note) => (ok ? PASS : FAIL).push(name + (ok || !note ? '' : '  ::  ' + note));

const toml = await readFile(join(SITE, 'netlify.toml'), 'utf8');

/* ---- the redirect table ---- */

const REDIRECTS = toml.split('[[redirects]]').slice(1).map(block => ({
  from: (block.match(/^\s*from\s*=\s*"([^"]+)"/m) || [])[1],
  to: (block.match(/^\s*to\s*=\s*"([^"]+)"/m) || [])[1],
  status: Number((block.match(/^\s*status\s*=\s*(\d+)/m) || [])[1] || 200),
  force: /^\s*force\s*=\s*true/m.test(block),
  comment: block
})).filter(r => r.from && r.to);

const denied = new Map(REDIRECTS.filter(r => r.status === 404).map(r => [r.from, r]));

/* ---- 1. only the website is public ---- */

const rootFiles = await readdir(SITE);
const mustBeDenied = [
  ...rootFiles.filter(f => f.endsWith('.sql')).map(f => '/' + f),
  ...rootFiles.filter(f => f.endsWith('.md')).map(f => '/' + f),
  ...rootFiles.filter(f => f === 'package.json' || f === 'package-lock.json' || f === 'netlify.toml').map(f => '/' + f),
  '/dev/*', '/scripts/*'
];

check('netlify.toml publishes the repo root, so every file in it is a URL',
  /publish\s*=\s*"\."/.test(toml),
  'publish changed — re-read what this file is protecting before trusting it');

for (const path of mustBeDenied) {
  const rule = denied.get(path);
  check(path + ' is not public', !!rule,
    rule ? '' : 'no [[redirects]] from = "' + path + '" with status 404 — with publish = "." this file is served to anyone who asks for it');
  if (rule) {
    const file = rule.to.replace(/^\//, '');
    check(path + ' → ' + rule.to + ' exists and is forced', existsSync(join(SITE, file)) && rule.force,
      existsSync(join(SITE, file)) ? 'the rule is not forced, so a real file at that path would win' : 'redirect target ' + rule.to + ' does not exist');
  }
}

/* every deny rule is deliberate: a 404 route that is not in the list above
   is either a new private path (add it to mustBeDenied) or a leftover */
const known = new Set(mustBeDenied.map(p => (p.endsWith('/*') ? p : p)));
for (const from of denied.keys()) {
  const expected = known.has(from) || /^\/(supabase-[a-z-]+\.sql|strategy.*|dev\/\*|scripts\/\*|.*\.md)$/.test(from);
  check('deny rule ' + from + ' is accounted for', expected, 'this 404 route is not in the guard list — is it still meant to be private?');
}

/* ---- 2. the sitemap points at things that exist ---- */

const sitemap = await readFile(join(SITE, 'sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

check('sitemap.xml has no byte-order mark', !sitemap.startsWith('\uFEFF'), 'a BOM here makes Search Console reject the file');
check('robots.txt has no byte-order mark',
  !(await readFile(join(SITE, 'robots.txt'), 'utf8')).startsWith('\uFEFF'),
  'a BOM here makes Search Console reject the file');
check('robots.txt still points at the sitemap',
  /^Sitemap:\s*https:\/\/arzuz\.com\/sitemap\.xml\s*$/m.test(await readFile(join(SITE, 'robots.txt'), 'utf8')),
  'the Sitemap line is missing or points somewhere else');

/* Where a URL's content actually comes from. A status-200 rule usually
   names a page file, but it can name a Netlify function instead —
   /.netlify/functions/<name> is served by netlify/functions/<name>.js —
   and what has to exist on disk is different in each case. Reading the
   function path as a filename made /browse look like a missing file the
   moment the board became a function. */
const routeFor = pathname => {
  const hit = REDIRECTS.find(r => r.from === pathname && r.status === 200);
  if (hit) {
    const target = hit.to.replace(/^\//, '');
    const fn = /^\.netlify\/functions\/(.+)$/.exec(target);
    return fn ? 'netlify/functions/' + fn[1] + '.js' : target;
  }
  if (pathname === '/') return 'index.html';
  return pathname.replace(/^\//, '') + '.html';
};

check('sitemap.xml lists at least one URL', locs.length > 0, 'empty sitemap');
for (const loc of locs) {
  const url = new URL(loc);
  const file = routeFor(url.pathname);
  check('sitemap URL ' + url.pathname + ' resolves', url.origin === 'https://arzuz.com' && existsSync(join(SITE, file)),
    url.origin !== 'https://arzuz.com' ? 'points at ' + url.origin + ' instead of the live domain' : 'no file at ' + file);
}

/* ---- 3. a noindex page is not advertised ---- */

const noindexPages = toml.split('[[headers]]').slice(1)
  .filter(block => /X-Robots-Tag\s*=\s*"[^"]*noindex/i.test(block))
  .map(block => (block.match(/^\s*for\s*=\s*"([^"]+)"/m) || [])[1])
  .filter(Boolean)
  .map(p => p.replace(/^\//, '').replace(/\.html$/, ''));

check('netlify.toml still marks the private pages noindex', noindexPages.length > 0,
  'the X-Robots-Tag: noindex headers are gone — admin.html and complete-listing.html would be indexable');

for (const page of noindexPages) {
  const inSitemap = locs.some(l => {
    try { return new URL(l).pathname.replace(/^\//, '').replace(/\.html$/, '') === page; } catch { return false; }
  });
  check('noindex page /' + page + ' is not in the sitemap', !inSitemap,
    'a page we ask crawlers to ignore is being advertised in sitemap.xml');
}

/* ---- report ---- */

if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach(f => console.log('  ✗ ' + f));
}
console.log('deploy guards — PASS ' + PASS.length + ' · FAIL ' + FAIL.length);
if (FAIL.length) process.exit(1);
