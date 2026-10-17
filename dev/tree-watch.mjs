/* ============================================================
   Arzuz — did the tree move while a suite was reading it?

   A test suite reports on the files as they were during its run. When
   another editor saves a file in that window, the verdict belongs to a
   revision nobody can look at any more: six failures in the admin
   suite here were somebody's half-written mock, not a regression, and
   the run said nothing. The reverse also happens — a suite can PASS
   against a file that changed under it, which is quieter and worse.

   So the runner brackets each suite with a content hash of the tree
   and names whatever moved. Two properties matter, and they pull in
   opposite directions:

     · IT MUST FIRE. A detector that never reports anything looks
       exactly like a tree nobody touched. dev/tree-watch-test.mjs
       moves files in a temp root and asserts the exact set comes back.

     · IT MUST NOT CRY WOLF. mtime is not content: a checkout, a
       `touch`, or an editor saving identical bytes changes the
       mtime and nothing else. Hashing contents means a no-op save
       reports nothing, and a real save that lands in the same
       millisecond as the previous one still reports.

   The runner does not change its exit status when something moved. A
   concurrent edit EXPLAINS a failure; it does not excuse one, and a
   green suite that raced is not made red by it — it is made doubtful.
   ============================================================ */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const DEFAULT_WATCHED = /\.(js|mjs|cjs|html|css|sql|toml|json)$/;
const DEFAULT_SKIP_DIRS = ['node_modules', '.git', '.netlify', 'dist', 'screenshots', 'hero-baselines',
  /* Built by scripts/test-rooms.mjs for its own import path and removed
     again. Watching it reports another suite working as if source had
     changed — the first run of this watcher named it, which is how it
     ended up here: build output belongs in the skip list. */
  '__rooms_sandbox'];
/* The CI gate rewrites this one as it goes; watching it would report a
   change on every suite and teach everyone to ignore the warning. */
const DEFAULT_SKIP_FILES = ['.test-timings.json'];

function walk(dir, out, watched, skipDirs, skipFiles) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(join(dir, entry.name), out, watched, skipDirs, skipFiles);
    } else if (entry.isFile()) {
      if (!watched.test(entry.name) || skipFiles.has(entry.name)) continue;
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * Hash every watched file under `root`.
 * @returns {Map<string, string>} repo-relative path (always '/') → sha256 hex
 */
export function snapshotTree(root, opts = {}) {
  const watched = opts.watched || DEFAULT_WATCHED;
  const skipDirs = new Set(opts.skipDirs || DEFAULT_SKIP_DIRS);
  const skipFiles = new Set(opts.skipFiles || DEFAULT_SKIP_FILES);
  const files = [];
  walk(root, files, watched, skipDirs, skipFiles);
  const out = new Map();
  for (const file of files) {
    try {
      out.set(relative(root, file).split(sep).join('/'),
        createHash('sha256').update(readFileSync(file)).digest('hex'));
    } catch (_) {
      /* Deleted between the listing and the read. It is genuinely
         gone, but attributing it to this window would be a guess, and
         movedDuring() reports a vanished file from the before-map
         anyway when the next snapshot is taken. */
    }
  }
  return out;
}

/**
 * What changed between two snapshots.
 * @returns {Array<{file: string, kind: 'changed'|'appeared'|'vanished'}>} sorted by path
 */
export function movedDuring(before, after) {
  const moved = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) moved.push({ file, kind: 'appeared' });
    else if (before.get(file) !== hash) moved.push({ file, kind: 'changed' });
  }
  for (const file of before.keys()) if (!after.has(file)) moved.push({ file, kind: 'vanished' });
  return moved.sort((a, b) => a.file.localeCompare(b.file));
}
