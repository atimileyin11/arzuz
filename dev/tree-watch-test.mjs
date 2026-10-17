#!/usr/bin/env node
/* ============================================================
   Arzuz — does the concurrent-edit watcher actually see anything?

   dev/tree-watch.mjs brackets every suite in `npm test` with a hash
   of the tree, so a file that somebody else saves mid-run is named
   instead of quietly deciding the verdict. Its two failure modes are
   opposite and both silent:

     · never fires   → identical to "nobody touched anything". A
                       detector that cannot fire would let the original
                       incident through while looking exactly like the
                       fix.
     · always fires  → a warning on every suite, which everyone learns
                       to ignore. mtime-based watching does this: an
                       editor saving identical bytes, or a checkout,
                       would trip it.

   So this file moves real files in a temp root and asserts the exact
   set comes back, and asserts that nothing comes back when nothing
   changed.

   Run:  node dev/tree-watch-test.mjs
   ============================================================ */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotTree, movedDuring } from './tree-watch.mjs';

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const out = fn();
    if (out === true || out === undefined) { pass++; return; }
    failures.push(name + '\n      → ' + out);
  } catch (err) {
    failures.push(name + '\n      → threw: ' + (err && err.message));
  }
}

const root = mkdtempSync(join(tmpdir(), 'arzuz-watch-'));
mkdirSync(join(root, 'node_modules'), { recursive: true });

/* Two watched files, one that must be ignored by extension, one by
   directory, and the CI gate's own timing file. */
writeFileSync(join(root, 'a.js'), 'var a = 1;\n');
writeFileSync(join(root, 'style.css'), 'body{}\n');
writeFileSync(join(root, 'note.png'), 'not text\n');
writeFileSync(join(root, 'node_modules', 'dep.js'), 'module.exports = 1;\n');
writeFileSync(join(root, '.test-timings.json'), '{}\n');

try {
  const first = snapshotTree(root);

  check('watches source, styles and markup — not assets or the timing file', () => {
    const names = [...first.keys()].sort();
    return (names.length === 2 && names[0] === 'a.js' && names[1] === 'style.css')
      ? true : 'snapshot has ' + names.join(', ');
  });

  check('an untouched tree reports nothing', () => {
    const moved = movedDuring(first, snapshotTree(root));
    return moved.length === 0 || 'reported ' + moved.map((m) => m.file + ' ' + m.kind).join(', ');
  });

  check('a save with identical bytes is not a change (content, not mtime)', () => {
    /* Rewrite the same bytes and shove the mtime a day forward — this is
       what a checkout or an editor's no-op save looks like. */
    writeFileSync(join(root, 'a.js'), 'var a = 1;\n');
    const day = new Date(Date.now() + 86400_000);
    utimesSync(join(root, 'a.js'), day, day);
    const moved = movedDuring(first, snapshotTree(root));
    return moved.length === 0 || 'mtime alone was reported as ' + moved[0].kind;
  });

  check('a real edit is reported as changed, by path', () => {
    writeFileSync(join(root, 'style.css'), 'body{color:red}\n');
    const moved = movedDuring(first, snapshotTree(root));
    return (moved.length === 1 && moved[0].file === 'style.css' && moved[0].kind === 'changed')
      ? true : 'got ' + JSON.stringify(moved);
  });

  check('a new file is reported as appeared', () => {
    writeFileSync(join(root, 'new.html'), '<p>\n');
    const moved = movedDuring(first, snapshotTree(root));
    const hit = moved.filter((m) => m.file === 'new.html');
    return (hit.length === 1 && hit[0].kind === 'appeared') ? true : 'got ' + JSON.stringify(moved);
  });

  check('a deleted file is reported as vanished', () => {
    rmSync(join(root, 'a.js'));
    const moved = movedDuring(first, snapshotTree(root));
    const hit = moved.filter((m) => m.file === 'a.js');
    return (hit.length === 1 && hit[0].kind === 'vanished') ? true : 'got ' + JSON.stringify(moved);
  });

  check('changes are returned in a stable order, so the summary does not shuffle', () => {
    writeFileSync(join(root, 'z.js'), '1;\n');
    writeFileSync(join(root, 'm.js'), '2;\n');
    const moved = movedDuring(first, snapshotTree(root)).map((m) => m.file);
    const sorted = [...moved].sort();
    return JSON.stringify(moved) === JSON.stringify(sorted) ? true : moved.join(' , ');
  });

  check('an unwatched extension is invisible even when it changes', () => {
    writeFileSync(join(root, 'note.png'), 'different binary\n');
    const moved = movedDuring(first, snapshotTree(root));
    return moved.every((m) => m.file !== 'note.png') ? true : 'note.png was reported';
  });
} finally {
  rmSync(root, { recursive: true, force: true });
  /* and the temp root's removal must not leave the module confused */
}

check('a missing root is empty, not a crash', () => {
  const ghost = snapshotTree(join(tmpdir(), 'arzuz-watch-does-not-exist-' + Date.now()));
  return ghost.size === 0 ? true : 'found ' + ghost.size;
});

console.log('');
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('\n' + pass + ' passed, ' + failures.length + ' failed.');
  console.log('  The runner\'s concurrent-edit warning is not trustworthy until this passes.\n');
  process.exit(1);
}
console.log('  ✓ ' + pass + ' checks passed — the watcher fires on real edits and stays quiet otherwise.');
console.log('');
