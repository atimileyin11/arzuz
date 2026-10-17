/* ============================================================
   Arzuz — the mutants

   Each entry breaks ONE fact and names the suite whose job it is to
   notice. The find string must occur exactly once in the file; the
   harness refuses to run otherwise, so "caught" always means a real
   mutation was applied.

   HOW A MUTANT IS CHOSEN

     Not "some line" — the line the suite's failure message talks
     about. A mutant that changes formatting, a comment, or a value
     no check mentions produces a green run that says nothing. The
     `why` field is the claim being tested: if the suite stays green
     with this line broken, the claim was never checkable.

   ADDING ONE

     Find the sentence in the suite's own output that names the rule
     ("a flick wins outright", "not-ready is not retryable"), then
     break the code that sentence describes. If the suite survives,
     that is the finding — the harness exit code is 1 for a reason.
   ============================================================ */

export const MUTANTS = [
  {
    id: 'signature-includes-max-file-size',
    file: 'netlify/functions/cloudinary-sign.js',
    suite: 'test:upload-sign',
    find: 'folder=${folder}&timestamp=${timestamp}${API_SECRET}',
    replace: 'folder=${folder}&max_file_size=${maxFileSize}&timestamp=${timestamp}${API_SECRET}',
    why: 'The signature must cover exactly the parameters Cloudinary verifies. '
      + '(This is the production bug: the extra parameter 401s every upload.)',
  },
  {
    id: 'probe-cannot-be-blind-checked',
    file: 'netlify/functions/lib/upload-probe.js',
    suite: 'test:upload-probe',
    find: '  if (sanity) {',
    replace: '  if (false) {',
    why: 'The probe tampers with its own signature and requires a 401. Without that, '
      + 'an endpoint that accepts anything reports a green — the exact blindness the '
      + 'smoke test exists to avoid.',
  },
  {
    id: 'watcher-blind-to-edits',
    file: 'dev/tree-watch.mjs',
    suite: 'test:tree-watch',
    find: '    else if (before.get(file) !== hash) moved.push({ file, kind: \'changed\' });',
    replace: '    else if (false) moved.push({ file, kind: \'changed\' });',
    why: 'A watcher that never reports a changed file looks exactly like a quiet tree. '
      + 'That is the whole reason its own suite exists.',
  },
  {
    id: 'drawer-flick-sign',
    file: 'assets/release-policy.js',
    suite: 'test:policy',
    find: 'if (Math.abs(v) > DRAWER.FLICK) return v > 0;',
    replace: 'if (Math.abs(v) > DRAWER.FLICK) return v < 0;',
    why: 'A flick wins by its SIGN: rightward opens, leftward closes. Flipping it '
      + 'means a throw in either direction does the opposite of what a finger meant.',
  },
  {
    id: 'projection-decay',
    file: 'assets/swipe-gesture.js',
    suite: 'test:gesture',
    find: 'var DECAY = 0.998;',
    replace: 'var DECAY = 0.9;',
    why: 'The projection is Apple\'s decay curve (0.998). At 0.9 a 3,000px/s throw '
      + 'projects 300px instead of 1,500px — every coast lands short.',
  },
  {
    id: 'busy-is-error',
    file: 'assets/api-errors.js',
    suite: 'test:api-errors',
    find: "if (err.status === 429) return 'busy';",
    replace: "if (err.status === 429) return 'error';",
    why: '429 is its own class, so the person is told to wait rather than that our '
      + 'side broke. Both are retryable, so only the sentences and the kind differ.',
  },
  {
    id: 'not-ready-is-retryable',
    file: 'assets/api-errors.js',
    suite: 'test:api-errors',
    find: "return kind === 'offline' || kind === 'busy' || kind === 'error';",
    replace: "return kind === 'offline' || kind === 'busy' || kind === 'error' || kind === 'not-ready';",
    why: 'A missing function/table is not worth retrying: the deploy may land, but the '
      + 'button will be refused identically until it does. Retrying it is a lie.',
  },
  {
    id: 'payment-amount-ignored',
    file: 'netlify/functions/finance.js',
    suite: 'test:finance',
    find: 'return paid !== null && Number(paid) === Number(payment.amount_kobo);',
    replace: 'return paid !== null;',
    why: 'A Care Pass opens only when the provider took EXACTLY the order amount. '
      + 'Ignoring the figure opens a pass on a one-naira payment.',
  },
  {
    id: 'support-may-decide-coverage',
    file: 'netlify/functions/claims.js',
    suite: 'test:claims',
    find: "if (ADMIN_ONLY.indexOf(action) !== -1 && role !== 'admin') {",
    replace: "if (ADMIN_ONLY.indexOf(action) !== -1 && role === 'admin') {",
    why: 'Deciding coverage, recording a cost and closing a claim are the admin login\'s '
      + 'alone; support answers students and landlords. This inverts the check.',
  },
  {
    id: 'status-may-be-cached',
    file: 'netlify/functions/status.js',
    suite: 'test:status',
    find: "      'Cache-Control': 'no-store',\n      'X-Robots-Tag': 'noindex, nofollow',",
    replace: "      'Cache-Control': 'public, max-age=3600',\n      'X-Robots-Tag': 'noindex, nofollow',",
    why: 'A status answer is a moment, not a fact: a cached copy tells the next visitor '
      + 'their reference is unknown when it is merely not this deployment\'s.',
  },
  {
    id: 'dead-link-is-retryable',
    file: 'assets/draft-errors.js',
    suite: 'test:draft-errors',
    find: "      outcome: 'dead',\n      title: 'This page needs an invite link',",
    replace: "      outcome: 'retry',\n      title: 'This page needs an invite link',",
    why: 'No link at all is terminal — a retry cannot invent a token. Sending the '
      + 'landlord back to press Save again wastes the one attempt they make.',
  },
];
