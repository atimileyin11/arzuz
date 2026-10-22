#!/usr/bin/env node
/* ============================================================
   Arzuz — the generated fixtures, checked as fixtures

   Both dev/listing-fixture.js and dev/invite-fixture.js BUILD their rows
   and seeds from a declared field · state matrix, and each row records the
   case it is there to exercise. This suite asks the questions that makes
   possible, with no browser and no server:

     · does the fixture agree with itself — every pair a case declares
       really holds in the row that case built, no field declared twice,
       no pair naming a cell the matrix does not have?
     · is every declared cell of the matrix exercised by some case, so a
       cell cannot be added and quietly left uncovered?
     · do the values dev/admin-test-report.md quotes still exist?
     · do the harnesses still load the fixture (and no longer carry their
       own hand-written copies), and do their ?case= / ?seed= / ?fail=
       documentation lists match what the fixture publishes?
     · do README.md and dev/admin-test-report.md still quote the numbers the
       fixtures actually hold? Those quotes are a third copy of the data, and
       section 3 below builds every phrase it searches for FROM the fixtures,
       so a doc can only fail by disagreeing with the data it describes.

   Run from arzuz-site/:
     node scripts/test-fixture-plans.mjs
   ============================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(SITE, p), 'utf8');

let total = 0, failed = 0;
const t = (name, ok, note) => {
  total++;
  if (ok) { console.log('  ✓ ' + name); return true; }
  failed++;
  console.log('  ✗ ' + name + (note ? '\n      → ' + note : ''));
  return false;
};
const section = title => console.log('\n' + title + '\n' + '—'.repeat(60));

/* load a fixture the way the harnesses do: no window, no document */
function loadFixture(path, globalName) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(read(path) + '\n;' + globalName, sandbox, { filename: path });
  const fx = sandbox[globalName];
  if (!fx || typeof fx.plan !== 'function') throw new Error(path + ' did not expose ' + globalName + '.plan()');
  return fx;
}

/* every declared cell, and the cases that claim it */
function uncoveredCells(plan, key) {
  const out = [];
  Object.keys(plan.matrix).forEach(field => {
    plan.matrix[field].forEach(state => {
      const hit = plan[key].some(c => c.pairs.some(p => p.field === field && p.state === state));
      if (!hit) out.push(field + '·' + state);
    });
  });
  return out;
}

/* a record has to say what it is for; a seed that declares NO pairs is only
   acceptable when it says so (`noRow` — the blank seed is "no row at all") */
const shapeProblems = cases => cases
  .filter(c => !c.label || !c.note || !c.pairs || (!c.pairs.length && !c.noRow))
  .map(c => c.key);

/* ============================================================
   1. the listing page fixture (browser suite owns the rendering)
   ============================================================ */

section('1. dev/listing-fixture.js — the listing page cases');

const listing = loadFixture('dev/listing-fixture.js', 'ARZUZ_LISTING_FIXTURE');
const lPlan = listing.plan();

t('the fixture reports no internal violation (' + lPlan.cases.length + ' cases, ' + lPlan.cells + ' declared cells)',
  lPlan.violations.length === 0, lPlan.violations.slice(0, 6).join(' · '));
t('every declared cell of the matrix is exercised by a case (' + lPlan.cells + ' cells)',
  uncoveredCells(lPlan, 'cases').length === 0,
  'no case exercises: ' + uncoveredCells(lPlan, 'cases').join(', '));
t('every case carries a label, a note and its pairs', shapeProblems(lPlan.cases).length === 0,
  shapeProblems(lPlan.cases).join(', '));
t('the cases the gate drives by name exist (worst, huge)',
  ['worst', 'huge'].every(k => lPlan.cases.some(c => c.key === k)),
  'the fault modes run --case=worst,huge');
const lIds = lPlan.cases.map(c => c.id);
t('every row has its own id', new Set(lIds).size === lIds.length, lIds.join(' '));
t('the fixture is the only source — its rows no longer exist beside it',
  !/fx-worst-0001[\s\S]{0,200}payload: \{\s*\/\* no maximum length/.test(read('dev/listing-fixture.js')),
  'a hand-written row block is still in the file');

/* the values dev/admin-test-report.md quotes, still byte-for-byte there */
const rowOf = k => listing.cases[k].row;
const worst = rowOf('worst'), huge = rowOf('huge'), demo = rowOf('demo'), empty = rowOf('empty');
t('worst: the 61-character unbroken name, the formatted rent and the unparseable tier',
  worst.payload.prop_name === 'OLUWASEUNBABATUNDEADEGOKEMEMORIALSTUDENTLODGEANDSUITESSMALETE' &&
  worst.payload.rent === '150,000' && worst.tier === 'verified',
  JSON.stringify([worst.payload.prop_name.length, worst.payload.rent, worst.tier]));
t('worst: seven amenities of which four survive, and four media entries',
  worst.payload.ut.length === 7 && worst.payload.media.length === 4,
  'ut ' + worst.payload.ut.length + ' · media ' + worst.payload.media.length);
t('worst: half a pin — latitude with no longitude',
  !!worst.latitude && (worst.longitude === '' || worst.longitude === null || worst.longitude === undefined),
  JSON.stringify([worst.latitude, worst.longitude]));
t('huge: 50 media, 40 features, 12 steps, a nine-figure rent, tier 3',
  huge.payload.media.length === 50 && huge.payload.ut.length === 40 &&
  huge.payload.passage.steps.length === 12 && huge.payload.rent === '123456789' && Number(huge.tier) === 3,
  JSON.stringify([huge.payload.media.length, huge.payload.ut.length, huge.payload.passage.steps.length, huge.payload.rent, huge.tier]));
t('empty: no payload key at all', !Object.prototype.hasOwnProperty.call(empty, 'payload'),
  JSON.stringify(Object.keys(empty)));
t('demo: the row the design was built against',
  demo.payload.prop_name === 'Ilorin Close Self-Contain' && demo.payload.rent === '185000' && Number(demo.tier) === 2,
  JSON.stringify([demo.payload.prop_name, demo.payload.rent, demo.tier]));

const lHarness = read('dev/listing-harness.html');
/* the doc line wraps, so read it across newlines and whitespace */
const lDocMatch = lHarness.replace(/\s+/g, ' ').match(/\?case=([a-z|]+)/);
const lDoc = lDocMatch ? lDocMatch[1].split('|') : [];
t('the harness documents exactly the cases the fixture publishes',
  lDoc.length === lPlan.cases.length && lPlan.cases.every(c => lDoc.includes(c.key)),
  'documented: ' + lDoc.join(', ') + ' · published: ' + lPlan.cases.map(c => c.key).join(', '));

/* ============================================================
   2. the landlord invite fixture (harness only; no browser suite yet)
   ============================================================ */

section('2. dev/invite-fixture.js — the landlord invite seeds');

const invite = loadFixture('dev/invite-fixture.js', 'ARZUZ_INVITE_FIXTURE');
const iPlan = invite.plan();

t('the fixture reports no internal violation (' + iPlan.seeds.length + ' seeds, ' + iPlan.cells + ' declared cells)',
  iPlan.violations.length === 0, iPlan.violations.slice(0, 6).join(' · '));
t('every declared cell of the matrix is exercised by a seed (' + iPlan.cells + ' cells)',
  uncoveredCells(iPlan, 'seeds').length === 0,
  'no seed exercises: ' + uncoveredCells(iPlan, 'seeds').join(', '));
t('every seed carries a label, a note and its pairs', shapeProblems(iPlan.seeds).length === 0,
  shapeProblems(iPlan.seeds).join(', '));
t('the seeds the harness switches between exist (blank, existing, worst, one, view)',
  ['blank', 'existing', 'worst', 'one', 'view'].every(k => iPlan.seeds.some(x => x.key === k)),
  iPlan.seeds.map(x => x.key).join(', '));

/* the worst invite, as dev/admin-test-report.md §13 describes it */
const iWorst = invite.seeds.worst.seed.payload;
const iUt = iWorst.ut;
const iInv = [
  ['the name is at the 70-character ceiling without passing it', iWorst.prop_name.length >= 40 && iWorst.prop_name.length <= 70, iWorst.prop_name.length],
  ['the area and the contact carry diacritics and an emoji', /[^\u0000-\u024F]/.test(iWorst.ar + iWorst.nm), 'no non-Latin text'],
  ['the phone is a formatted international number', /[^0-9]/.test(iWorst.ph) && /[0-9]/.test(iWorst.ph), iWorst.ph],
  ['rent and ask are both ₦1.25m', iWorst.rent === '1250000' && iWorst.ask === '1250000', iWorst.rent + ' / ' + iWorst.ask],
  ['zero vacant units', Number(iWorst.units) === 0, String(iWorst.units)],
  ['the blurb is pasted-length (>= 1,500 characters)', String(iWorst.desc).length >= 1500, String(iWorst.desc).length],
  ['twelve amenities, with a case-duplicate and one long label',
    iUt.length >= 12 && new Set(iUt.map(s => s.toLowerCase())).size < iUt.length &&
    Math.max.apply(null, iUt.map(s => s.length)) >= 45,
    iUt.length + ' amenities'],
  ['forty media items, two of them share links (youtu.be and Drive)',
    iWorst.media.length >= 40 &&
    iWorst.media.filter(m => m.type === 'video').length >= 2 &&
    iWorst.media.some(m => /youtu\.be/.test(m.url)) &&
    iWorst.media.some(m => /drive\.google\.com/.test(m.url)),
    iWorst.media.length + ' items'],
  ['the landmark is the three-line note a landlord pastes out of WhatsApp',
    String(iWorst.passage.landmark).split('\n').length >= 3,
    String(iWorst.passage.landmark).split('\n').length + ' lines']
];
iInv.forEach(pair => t('worst: ' + pair[0], pair[1], String(pair[2])));

const iHarness = read('dev/complete-listing-harness.html');
t('the harness loads the fixture', /<script src="invite-fixture\.js"><\/script>/.test(iHarness),
  'no script tag for dev/invite-fixture.js');
t('the harness no longer carries its own seed literals',
  !/WORST_MEDIA|SEEDS\.worst = \{|SEEDS\.one = \{/.test(iHarness),
  'a hand-written seed block is still in the harness');
t('the harness posts the fixture\'s seeds (and its own permission)',
  /ARZUZ_INVITE_FIXTURE/.test(iHarness) && /__permission/.test(iHarness),
  'the harness is not reading the generated seeds');

const iFails = iHarness.slice(iHarness.indexOf('var FAILS = {')).match(/^\s{4}'([a-z-]+)':/gm) || [];
const harnessFails = iFails.map(s => s.trim().replace(/^'|':$/g, '')).sort();
const declaredFails = iPlan.fails.slice().sort();
t('the failure classes the harness scripts are exactly the ones the fixture declares',
  harnessFails.length === declaredFails.length && harnessFails.every((k, i) => k === declaredFails[i]),
  'harness: ' + harnessFails.join(', ') + ' · fixture: ' + declaredFails.join(', '));

const iSeedDoc = (iHarness.match(/\?seed=([a-z|]+)/) || [])[1];
const iSeedKeys = iSeedDoc ? iSeedDoc.split('|') : [];
t('the harness documents exactly the seeds the fixture publishes (plus the demo alias)',
  iPlan.seeds.every(x => iSeedKeys.includes(x.key)) && iSeedKeys.includes('demo') &&
  iSeedKeys.filter(k => k !== 'demo').length === iPlan.seeds.length,
  'documented: ' + iSeedKeys.join(', ') + ' · published: ' + iPlan.seeds.map(x => x.key).join(', '));

/* ============================================================
   3. the prose: README.md and dev/admin-test-report.md
   ------------------------------------------------------------
   Both documents quote this fixture's numbers — the cell counts, the worst
   seed's name and blurb lengths, the huge case's 50/40/12. Those quotes are
   a THIRD copy of the data and nothing checked them: a case could gain a
   field and the README would keep saying "74". So the strings searched for
   below are not typed here either — every one is BUILT from a value the
   fixtures just reported, which is why a fixture that changes fails the doc
   that no longer matches it, and this suite is never the copy that drifts.
   ============================================================ */

section('3. the numbers README.md and dev/admin-test-report.md quote');

/* strip markdown emphasis so a phrase reads the same in both files */
const flat = s => s.replace(/\*/g, '').replace(/\s+/g, ' ');
const README = flat(read('README.md'));
const REPORT = flat(read('docs/admin-test-report.md'));
const commas = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty'];
const word = n => WORDS[n] !== undefined ? WORDS[n] : String(n);

/* `want` is built by the caller from the fixture; the failure prints it, so a
   red line always says what the data says now, not what it said when written */
function quotes(docName, doc, want) {
  return t(docName + ' quotes the fixture: "' + want + '"', doc.indexOf(want) !== -1,
    'not in ' + docName + ' — the fixture now says "' + want + '"');
}

/* ---- the invite fixture: README.md ---- */
const iW = invite.seeds.worst.seed.payload;
const inv = {
  cells: iPlan.cells,
  fields: iPlan.fields.length,
  seeds: iPlan.seeds.length,
  nameLen: iW.prop_name.length,
  units: Number(iW.units),
  descLen: String(iW.desc).length,
  amenities: iW.ut.length,
  longestAmenity: Math.max.apply(null, iW.ut.map(s => String(s).length)),
  media: iW.media.length,
  rent: Number(String(iW.rent).replace(/[^0-9]/g, '')),
  landmarkLines: String(iW.passage.landmark).split('\n').length
};

quotes('README.md', README, inv.nameLen + '-character lodge name');
quotes('README.md', README, inv.units + ' vacant units');
quotes('README.md', README, commas(inv.descLen) + '-character blurb');
quotes('README.md', README, inv.amenities + ' amenities and ' + inv.media + ' media items');
quotes('README.md', README, inv.cells + ' cells across ' + inv.fields + ' fields');

/* the README's toggle comment names every seed the fixture publishes */
const toggleLine = (read('README.md').match(/# in-page toggle:([^\n]*)/) || [, ''])[1];
const unwritten = iPlan.seeds.map(s => s.label).filter(label => toggleLine.indexOf(label) === -1);
t('README.md\'s toggle comment names every seed the fixture builds (' + iPlan.seeds.length + ' labels)',
  iPlan.seeds.length > 0 && unwritten.length === 0, 'not in the toggle line: ' + unwritten.join(', '));

/* the fixture's own worst note is the same copy one level down — it described
   its seed as a 70-character name and an 1,800-character blurb */
const iSrc = flat(read('dev/invite-fixture.js'));
quotes('dev/invite-fixture.js (worst note)', iSrc, inv.nameLen + '-character name');
quotes('dev/invite-fixture.js (worst note)', iSrc, commas(inv.descLen) + '-character blurb');
quotes('dev/invite-fixture.js (worst note)', iSrc, inv.amenities + ' amenities and ' + inv.media + ' media');

/* ---- the invite fixture: dev/admin-test-report.md ---- */
quotes('docs/admin-test-report.md', REPORT, inv.nameLen + '-character lodge name');
quotes('docs/admin-test-report.md', REPORT, inv.nameLen + '-char name');
quotes('docs/admin-test-report.md', REPORT, '`cl_prop_name` ' + inv.nameLen + ' chars');
quotes('docs/admin-test-report.md', REPORT, '₦' + commas(inv.rent) + ' rent and ask');
quotes('docs/admin-test-report.md', REPORT, '₦' + (inv.rent / 1e6) + 'm rent and ask');
quotes('docs/admin-test-report.md', REPORT, '`cl_rent` and `cl_ask` both `' + inv.rent + '`');
quotes('docs/admin-test-report.md', REPORT, '`cl_units` `' + inv.units + '`');
quotes('docs/admin-test-report.md', REPORT, commas(inv.descLen) + '-character description');
quotes('docs/admin-test-report.md', REPORT, commas(inv.descLen) + '-char blurb');
quotes('docs/admin-test-report.md', REPORT, '`cl_desc` ' + inv.descLen);
quotes('docs/admin-test-report.md', REPORT, word(inv.amenities) + ' amenities');
quotes('docs/admin-test-report.md', REPORT, inv.longestAmenity + ' characters long');
quotes('docs/admin-test-report.md', REPORT, inv.longestAmenity + '-character label');
quotes('docs/admin-test-report.md', REPORT, inv.media + ' media items');
quotes('docs/admin-test-report.md', REPORT, 'a ' + word(inv.landmarkLines) + '-line note');
quotes('docs/admin-test-report.md', REPORT, 'a ' + word(inv.landmarkLines) + '-line landmark');
quotes('docs/admin-test-report.md', REPORT, word(inv.seeds) + ' generated seeds');

/* ---- the listing fixture: both documents ---- */
const lf = {
  cells: lPlan.cells,
  fields: lPlan.fields.length,
  cases: lPlan.cases.length,
  worstNameLen: worst.payload.prop_name.length,
  worstRent: String(worst.payload.rent),
  worstTier: String(worst.tier),
  worstAmenities: worst.payload.ut.length,
  hugeMedia: huge.payload.media.length,
  hugeFeatures: huge.payload.ut.length,
  hugeSteps: huge.payload.passage.steps.length,
  hugeRent: String(huge.payload.rent)
};

quotes('README.md', README,
  lf.cells + ' declared cells over ' + lf.fields + ' fields, ' + word(lf.cases) + ' named cases');
quotes('docs/admin-test-report.md', REPORT, lf.cells + ' cells over ' + lf.fields + ' fields');
quotes('docs/admin-test-report.md', REPORT, word(lf.cases) + ' generated cases');
quotes('docs/admin-test-report.md', REPORT, lf.worstNameLen + '-character unbroken name');
quotes('docs/admin-test-report.md', REPORT, '`' + lf.worstRent + '`');
quotes('docs/admin-test-report.md', REPORT, '`' + lf.worstTier + '`');
quotes('docs/admin-test-report.md', REPORT, word(lf.worstAmenities) + ' amenities of which');
quotes('docs/admin-test-report.md', REPORT,
  lf.hugeMedia + ' media / ' + lf.hugeFeatures + ' features / ' + lf.hugeSteps + ' steps / `' + lf.hugeRent + '`');

/* ============================================================
   4. dev/admin-mock-data.js — the dashboard's worst case
   ------------------------------------------------------------
   The third generated fixture, and the third place the prose quotes numbers
   nothing checked: the README's paragraph on the admin board (the matrix
   product, the count the board hides on status alone, the row count, and each
   payload extreme) and the fixture's own `why` tooltips, which name the same
   values from the inside. Every phrase below is derived from the rows that
   fixture builds — this comment deliberately states none of them, because a
   number written here would be the fourth copy.

   Reading it needs no DOM at all — the file assigns window.ArzuzMockData —
   which is why this lives here rather than in the Chrome suite: that one
   checks the PAGE against the fixture, this one checks the PROSE against it.
   ============================================================ */

section('4. dev/admin-mock-data.js — the dashboard worst case, as README quotes it');

const adminSandbox = {};                 /* the fixture assigns window.ArzuzMockData */
adminSandbox.window = adminSandbox;
vm.createContext(adminSandbox);
vm.runInContext(read('dev/admin-mock-data.js'), adminSandbox, { filename: 'dev/admin-mock-data.js' });
const admin = adminSandbox.window.ArzuzMockData;
const aPlan = admin.worstPlan();
const aRows = admin.worst().listings;
const stressRow = name => aRows.filter(r => r.case && r.case.stress === name)[0] || { payload: {} };
const mx = stressRow('max-ceilings').payload;
const zu = stressRow('zero-units').payload;
const rtl = stressRow('rtl-and-60-media').payload;

const adm = {
  statuses: aPlan.statuses.length,
  tiers: aPlan.tiers.length,
  envs: aPlan.envs.length,
  cells: aPlan.cells.length,
  hiddenByStatus: aPlan.cells.filter(c => c.exercise === 'hidden:status').length,
  rows: aRows.length,
  nameLen: String(mx.prop_name || '').length,
  areaLen: String(mx.ar || '').length,
  rentDigits: String(mx.rent || '').replace(/[^0-9]/g, '').length,
  units: Number(mx.units),
  amenities: (mx.ut || []).length,
  descLen: String(mx.desc || '').length,
  media: (rtl.media || []).length,
  zeroUnits: Number(zu.units || 0),      /* `units: null` on an occupied row */
  zeroRent: String(zu.rent)
};

t('the dashboard fixture is readable from Node, with no DOM (' + adm.rows + ' rows, ' +
  adm.cells + ' cells)',
  adm.rows > 0 && adm.cells === adm.statuses * adm.tiers * adm.envs,
  adm.statuses + '×' + adm.tiers + '×' + adm.envs + ' ≠ ' + adm.cells + ' cells');

quotes('README.md', README, adm.statuses + ' × ' + adm.tiers + ' × ' + adm.envs + ' = ' +
  adm.cells + ' cells, ' + adm.hiddenByStatus + ' of which the board hides on status alone');
quotes('README.md', README, adm.rows + ' rows in all');
quotes('README.md', README, 'the ' + word(adm.statuses) + ' statuses its Status filter offers');
quotes('README.md', README, 'the ' + word(adm.tiers) + ' tiers its Tier select offers');
quotes('README.md', README, 'the ' + word(adm.envs) + ' envs');
quotes('README.md', README, adm.nameLen + '-character emoji name');
quotes('README.md', README, adm.areaLen + '-character area with no spaces');
quotes('README.md', README, adm.zeroUnits + ' units');
quotes('README.md', README, '₦' + adm.zeroRent + ' rent');
quotes('README.md', README, adm.media + ' media items');
quotes('README.md', README, commas(adm.descLen) + '-character description');
quotes('README.md', README, adm.amenities + ' amenities');

/* the two claims README makes in words, each asked of the fixture first: a
   doc that says "no name at all" is only right while a row still has none */
const nameless = aRows.some(r => String((r.payload || {}).prop_name || '').trim() === '');
t('README.md\'s "a payload with no name at all" is still true of a row',
  nameless && README.indexOf('a payload with no name at all') !== -1,
  nameless ? 'README.md no longer says it' : 'no row has an empty name any more');
const rtlText = /[^\u0000-\u024F]/.test(String(rtl.prop_name || '') + String(rtl.ar || ''));
t('README.md\'s "RTL text" is still true of a row',
  rtlText && README.indexOf('RTL text') !== -1,
  rtlText ? 'README.md no longer says it' : 'no stress row carries RTL text any more');

/* the fixture's own tooltips are the same copy one level down — they described
   the max-ceilings row as 70 and 80 characters while it built 58 and 58 */
const why = {};
aPlan.stress.forEach(s => { why[s.name] = s.why; });
const mxWhy = why['max-ceilings'] || '';
quotes('dev/admin-mock-data.js (max-ceilings why)', mxWhy, adm.nameLen + '-char emoji name');
quotes('dev/admin-mock-data.js (max-ceilings why)', mxWhy, adm.areaLen + '-char unbreakable area');
quotes('dev/admin-mock-data.js (max-ceilings why)', mxWhy, adm.rentDigits + '-digit rent');
quotes('dev/admin-mock-data.js (max-ceilings why)', mxWhy, adm.units + ' units');
quotes('dev/admin-mock-data.js (max-ceilings why)', mxWhy, adm.amenities + ' amenities');
quotes('dev/admin-mock-data.js (max-ceilings why)', mxWhy, commas(adm.descLen) + '-char desc');
quotes('dev/admin-mock-data.js (rtl-and-60-media why)', why['rtl-and-60-media'] || '',
  adm.media + ' media items');

/* ---- the report's table quotes this suite's own count ----
   It has to be the LAST assertion in the file: the only place that number can
   come from is here, and `+ 1` is this check itself. If an earlier check is
   red the suite is already failing, so this cannot hide anything. */
const finalTotal = total + 1;
/* anchored to the row, so another suite that happens to count 66 cannot satisfy it */
const own = '`node scripts/test-fixture-plans.mjs` | TOTAL ' + finalTotal + ' · PASS ' + finalTotal + ' · FAIL 0';
t('dev/admin-test-report.md quotes this suite\'s own total (' + finalTotal + ')',
  REPORT.indexOf(own) !== -1,
  'the report\'s fixture-plans row says another number — it must read: ' + own);

/* ============================================================ */

console.log('\n' + '='.repeat(60));
console.log('TOTAL ' + total + ' · PASS ' + (total - failed) + ' · FAIL ' + failed);
console.log('='.repeat(60));
if (failed) process.exitCode = 1;
