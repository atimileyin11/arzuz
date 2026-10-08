/* Regression harness for the strategy reader's markdown renderer.
   Run from arzuz-site/:  node scripts/test-strategy-render.mjs

   The reader renders strategy/*.md in the browser with a deliberately small
   renderer (mdToHtml in assets/strategy.js). It is small enough to be wrong
   quietly: a wrapped bullet that falls out of its list, a table that renders
   as a paragraph full of pipes, bold that never becomes bold. This walks
   EVERY doc in the pack and fails on any of those tells, so filling in the
   market numbers can never silently break the page a marketing teammate
   reads.

   Zero dependencies; it evaluates the real asset in a fake window. */

import { readFile, readdir } from 'node:fs/promises';

const PASS = [];
const FAIL = [];

function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name + (cond ? '' : '  ::  ' + (detail || '')));
}

const SRC = await readFile('assets/strategy.js', 'utf8');

/* strategy.js reads ArzuzAuth.role() at render time; mdToHtml needs none of
   that, but the IIFE must load without touching a real DOM. */
function loadModule() {
  const win = { location: { hash: '', href: 'https://arzuz.com/admin.html', pathname: '/admin.html' } };
  const fn = new Function(
    'window', 'document', 'location', 'fetch', 'navigator',
    SRC + '\n//# sourceURL=strategy.js',
  );
  fn(win, { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
     win.location, () => Promise.reject(new Error('no network in this harness')), {});
  return win.ArzuzStrategy;
}

const strategy = loadModule();
check('strategy.js exports mdToHtml for testing', typeof strategy.mdToHtml === 'function');

/* ---------- unit cases for the renderer ---------- */

const wrapSource = [
  '1. **First item** — starts here and the sentence runs on',
  '   across a wrapped line that belongs to the same item.',
  '2. **Second item** — its own line.',
].join('\n');
const wrapHtml = strategy.mdToHtml(wrapSource);
check('renderer: a wrapped ordered item stays ONE <li>', (wrapHtml.match(/<li>/g) || []).length === 2, wrapHtml);
check('renderer: the wrapped text is inside the item', wrapHtml.indexOf('belongs to the same item') !== -1 &&
  /<li>[^]*belongs to the same item[^]*<\/li>/.test(wrapHtml), wrapHtml);
check('renderer: bold inside a list item is parsed', wrapHtml.indexOf('<b>First item</b>') !== -1, wrapHtml);

const bulletSource = [
  '- one',
  '- two, which also wraps',
  '  onto a second line',
  '',
  'A paragraph after the list.',
].join('\n');
const bulletHtml = strategy.mdToHtml(bulletSource);
check('renderer: bullets with wrapped lines stay one list', (bulletHtml.match(/<li>/g) || []).length === 2, bulletHtml);
check('renderer: a following paragraph is not swallowed by the list',
  /<\/ul>\s*<p class="md-p">A paragraph after the list\.<\/p>/.test(bulletHtml), bulletHtml);

const tableHtml = strategy.mdToHtml('| A | B |\n|---|---|\n| 1 | 2 |\n');
check('renderer: tables become tables', tableHtml.indexOf('<table') !== -1 && tableHtml.indexOf('<td>1</td>') !== -1, tableHtml);

const fenceHtml = strategy.mdToHtml('```\nline one\nline two\n```\n');
check('renderer: fences become code blocks', fenceHtml.indexOf('<pre class="md-code">') !== -1 &&
  fenceHtml.indexOf('line two') !== -1, fenceHtml);

const quoteHtml = strategy.mdToHtml('> quoted line one\n> continues here\n');
check('renderer: blockquotes join into one quote', quoteHtml.indexOf('quoted line one continues here') !== -1, quoteHtml);

const estimateHtml = strategy.mdToHtml('The figure is **[ESTIMATE]** for now.\n');
check('renderer: [ESTIMATE] is flagged, not left plain', estimateHtml.indexOf('md-estimate') !== -1, estimateHtml);

const linkHtml = strategy.mdToHtml('See [assets/data.js](../assets/data.js) for the bands.\n');
check('renderer: a relative link becomes an anchor', /<a href="\/assets\/data\.js"/.test(linkHtml), linkHtml);

const docLinkHtml = strategy.mdToHtml('See [doc 06](06-channels-bullseye.md) for channels.\n');
check('renderer: a cross-document link opens in the reader',
  /href="#\/strategy\/06-channels-bullseye\.md"/.test(docLinkHtml), docLinkHtml);

/* ---------- every doc in the pack ---------- */

const files = (await readdir('strategy')).filter((f) => f.endsWith('.md')).sort();
check('the pack has the 8 expected documents', files.length === 8, files.join(', '));

for (const file of files) {
  const md = await readFile('strategy/' + file, 'utf8');
  const html = strategy.mdToHtml(md);
  const tag = file + ': ';

  /* 1. every list marker in the source must produce a list item */
  const ordered = (md.match(/^\s*\d+\.\s+/gm) || []).length;
  const bullets = (md.match(/^\s*[-*]\s+/gm) || []).length;
  const items = (html.match(/<li>/g) || []).length;
  check(tag + 'every list marker becomes a list item', items === ordered + bullets,
    'source ' + (ordered + bullets) + ' vs rendered ' + items);

  /* 2. a paragraph that begins with a lowercase letter is the signature of a
        wrapped line that escaped its list item — nothing authored here
        starts a paragraph mid-sentence */
  const paras = html.match(/<p class="md-p">([^]*?)<\/p>/g) || [];
  const orphans = paras.filter((p) => {
    const text = p.replace(/<[^>]*>/g, '').trim();
    return /^[a-z]/.test(text) || /^(of|to|and|the|a|in|at|for|with|from|by|but|so|or)\b/.test(text);
  });
  check(tag + 'no stray paragraph from a wrapped line', orphans.length === 0, orphans.join(' | ').slice(0, 240));

  /* 3. no unrendered markdown syntax survives into a paragraph */
  const pipeParas = paras.filter((p) => p.indexOf('|') !== -1);
  check(tag + 'no pipe table rendered as a paragraph', pipeParas.length === 0, pipeParas.join(' | ').slice(0, 160));
  const boldParas = paras.filter((p) => /\*\*/.test(p));
  check(tag + 'no unparsed ** in a paragraph', boldParas.length === 0, boldParas.join(' | ').slice(0, 160));
  const fenceParas = paras.filter((p) => p.indexOf('```') !== -1);
  check(tag + 'no unparsed fence in a paragraph', fenceParas.length === 0, fenceParas.join(' | ').slice(0, 160));

  /* 4. tables and headings actually rendered */
  const sourceTables = (md.match(/^\s*\|.*\|\s*$/gm) || []).length;
  if (sourceTables) {
    check(tag + 'table rows were rendered as tables',
      html.indexOf('<table') !== -1 && html.indexOf('|---') === -1, 'table syntax left raw');
  }
  check(tag + 'headings rendered', /<h[2-5] class="md-h">/.test(html));
}

/* ---------- the numbers we just filled in ---------- */

const market = await readFile('strategy/01-market-sizing-tam-sam-som.md', 'utf8');
check('market doc: the KWASU population rung is sourced, not [ESTIMATE]',
  /KWASU student population — 30,000 \[S1\]/.test(market), 'rung 1 still placeholder');
check('market doc: every [S#] marker has a row in the sources table',
  (market.match(/\[S\d+\]/g) || []).every((m) => market.indexOf('| ' + m.slice(1, -1) + ' |') !== -1),
  'a cited figure has no source row');
check('market doc: a figure that cannot be sourced is called out as indicative',
  /not an audited figure/.test(market));
check('market doc: the affordability gap is stated as a check, not a claim',
  /BANDS is still illustrative/.test(market) && /before this doc is quoted/i.test(market));
check('market doc: the SAM arithmetic is present',
  /21,000 × NG?N?₦?300,000/.test(market) || /21,000 × ₦300,000/.test(market), 'missing 21,000 × ₦300,000');

/* ---------- report ---------- */

console.log('\nPASS: ' + PASS.length);
PASS.forEach((p) => console.log('  \u2713 ' + p));
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('\nALL STRATEGY RENDER CHECKS PASSED');
