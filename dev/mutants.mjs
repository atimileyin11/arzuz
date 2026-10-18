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
    id: 'cleanliness-does-not-count',
    file: 'assets/roommate-score.js',
    suite: 'test:roommate',
    find: "{ key: 'cleanliness', weight: 3, fields: ['clean'],         want: 'want_clean',  phrase: 'cleaning habits' },",
    replace: "{ key: 'cleanliness', weight: 0, fields: ['clean'],         want: 'want_clean',  phrase: 'cleaning habits' },",
    why: 'Cleaning habits are one of the two heaviest categories. At weight 0 two '
      + 'students who disagree about it match exactly as well as two who agree.',
  },
  {
    id: 'reclaim-never-happens',
    file: 'assets/verification-queue.js',
    suite: 'test:verify-queue',
    find: 'reclaim_after_hours: 24',
    replace: 'reclaim_after_hours: 2400',
    why: 'A job an officer took and then went silent on returns to the queue after a '
      + 'day. Longer than any shift means it never comes back and nobody is told.',
  },
  {
    id: 'deploy-gate-always-passes',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: 'exit: (require_ && blocking.length) ? 1 : 0,',
    replace: 'exit: 0,',
    why: 'The build must fail when a required key is missing; a gate that always '
      + 'exits 0 deploys a site whose door answers 503 to every submission.',
  },
  {
    id: 'indexnow-sends-nothing',
    file: 'assets/indexnow.js',
    suite: 'test:indexnow',
    find: 'urlList: urls.slice()',
    replace: 'urlList: []',
    why: 'The batch must carry the URLs that changed. An empty urlList is accepted '
      + 'by IndexNow and indexes nothing, which looks exactly like success.',
  },
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

  /* ------------------------------------------------------------
     The second wave: one mutant for every suite that had none.

     Chosen the same way — the line the suite's own failure message
     talks about — and the sixteen below are the suites whose claims
     nobody had tried to break. `npm run mutate -- --coverage` is what
     says the job is done, and the gate now refuses a suite with no
     mutant at all.
     ------------------------------------------------------------ */
  {
    id: 'fixtures-refuse-a-good-number',
    file: 'netlify/functions/status.js',
    suite: 'test:fixtures',
    find: '  return d.length >= 10 && d.length <= 15;',
    replace: '  return d.length >= 14 && d.length <= 15;',
    why: 'The fixtures suite judges every number a fixture uses by the product\'s own '
      + 'rule. A rule that refuses a ten-digit Nigerian number reports a working '
      + 'fixture as broken, and the suite is the thing that has to say so.',
  },
  {
    id: 'mock-accepts-an-impossible-outcome',
    file: 'scripts/test-status.mjs',
    suite: 'test:schema',
    find: "const TRAIL_OUTCOMES = ['sent', 'refused', 'unreachable'];",
    replace: "const TRAIL_OUTCOMES = ['sent', 'refused', 'unreachable-later'];",
    why: 'Every copy of a vocabulary has to match the CHECK that owns it, and this '
      + 'suite exists to compare them. A copy that accepts a word Postgres '
      + 'refuses lets a stand-in assert on a row the column cannot hold.',
  },
  {
    id: 'not-ready-reads-as-an-outage',
    file: 'assets/roommate.js',
    suite: 'test:roommate-page',
    find: "    if (kind ? kind === 'not-ready' : status === 503) {",
    replace: '    if (false) {',
    why: 'A 503 — or a 404 — that carries not-ready is the deployment, not a bad '
      + 'minute: read as an outage the page offers a retry that cannot work.',
  },
  {
    id: 'refunded-plan-can-still-spend',
    file: 'netlify/functions/care-credit.js',
    suite: 'test:care',
    find: "  if (plan.status === 'refunded') {\n    return { status: 409, body: { error: 'That session was refunded",
    replace: "  if (false) {\n    return { status: 409, body: { error: 'That session was refunded",
    why: 'A refunded session has no credit to send a worker on. Without this the '
      + 'money goes back and the call-out is spent anyway.',
  },
  {
    id: 'unreadable-evidence-is-no-evidence',
    file: 'assets/verification-badge.js',
    suite: 'test:verify-badge',
    find: '    if (rows === null || rows === undefined) {',
    replace: '    if (rows === undefined) {',
    why: 'An evidence read that FAILED must not be reported as there being no '
      + 'record. Falling through makes the badge say the visit predates the log, '
      + 'which is a different fact about the room.',
  },
  {
    id: 'page-names-the-price-it-was-shown',
    file: 'assets/care-pass.js',
    suite: 'test:care-pass',
    find: '      referral_code: f.referral_code\n    }).then(function (res) {',
    replace: '      referral_code: f.referral_code,\n      amount: 2000000\n    }).then(function (res) {',
    why: 'The page sends the customer and the idempotency key, and never an amount: '
      + 'the server holds the price, and a page that names one is a page that can '
      + 'be told to name another.',
  },
  {
    id: 'http-photo-becomes-a-link',
    file: 'assets/my-care.js',
    suite: 'test:my-care',
    find: '    var shots = (row.photos || []).filter(function (u) { return /^https:',
    replace: '    var shots = (row.photos || []).filter(function (u) { return /^https?:',
    why: 'A repair photo is a link a student clicks from a page served over https. '
      + 'An http:// one is mixed content, and the page must not turn it into a link.',
  },
  {
    id: 'support-may-reach-the-scout-reports',
    file: 'assets/admin.js',
    suite: 'test:admin',
    find: "    support: ['scout_submissions', 'roommate', 'growth', 'strategy', 'settings', 'finance'],",
    replace: "    support: ['roommate', 'growth', 'strategy', 'settings', 'finance'],",
    why: 'A support login may not reach the scout reports. The router is the gate '
      + 'that decides, and this hands it the section anyway.',
  },
  {
    id: 'missing-table-is-a-bad-minute',
    file: 'netlify/functions/care-credit.js',
    suite: 'test:postgrest',
    find: '  return err && err.status === 404 && /schema cache|does not exist/i.test(m);',
    replace: '  return false;',
    why: 'A relation this deployment does not have must read as not-ready rather '
      + 'than as a bad minute: the repair is a migration, not a retry.',
  },
  {
    id: 'every-relation-looks-denied',
    file: 'dev/care-live-check.mjs',
    suite: 'test:care-live',
    find: "  if (status === 404 && code === 'PGRST205') return 'missing';\n  if ((status === 401 || status === 403)) return 'exists-denied';",
    replace: "  if (status === 404 && code === 'PGRST205') return 'missing';\n  if (true) return 'exists-denied';",
    why: 'The verdict IS the product of this check: a reader that answers '
      + 'exists-denied to everything calls a publicly readable database a pass.',
  },
  {
    id: 'canonical-drops-its-slash',
    file: 'index.html',
    suite: 'test:seo',
    find: '  <link rel="canonical" href="https://arzuz.com/">',
    replace: '  <link rel="canonical" href="https://arzuz.com">',
    why: 'A canonical without its trailing slash is a different URL to a crawler, '
      + 'and the homepage is the one page whose canonical is the origin itself.',
  },
  {
    id: 'not-found-answers-200',
    file: 'netlify/functions/rooms.js',
    suite: 'test:rooms',
    find: 'function notFound(page) {\n  return {\n    statusCode: 404,',
    replace: 'function notFound(page) {\n  return {\n    statusCode: 200,',
    why: 'A room that is not in the view, and a database that cannot be read, '
      + 'both answer 404 with the real 404 page. A 200 is a soft 404: the page '
      + 'says "not found" and tells every crawler the room exists.',
  },
  {
    id: 'og-image-is-the-old-cover',
    file: 'netlify/functions/listing-og.js',
    suite: 'test:listing-og',
    find: '  const img = absoluteUrl(firstPhotoUrl(p) || row.photo_url) || GENERIC_IMAGE;',
    replace: '  const img = absoluteUrl(row.photo_url) || GENERIC_IMAGE;',
    why: 'og:image is the listing\'s own first photo, read from the payload the '
      + 'owner edited, not the cover the row was created with. A card showing '
      + 'the old photograph is how a preview lies about the room.',
  },
  {
    id: 'cards-link-by-query-string',
    file: 'assets/listing-url.js',
    suite: 'test:browse',
    find: "    return s ? '/rooms/' + s : '';",
    replace: "    return s ? '/listing?id=' + idOf(row) : '';",
    why: 'Every card links the one address for a room. A query-string link is the '
      + 'shape that gives the same room two URLs, and the board is what a crawl '
      + 'copies them from.',
  },
  {
    id: 'rls-off-on-the-care-tables',
    file: 'supabase-care.sql',
    suite: 'sql:proof',
    find: 'alter table care_plans         enable row level security;',
    replace: 'alter table care_plans         disable row level security;',
    why: 'A care plan carries a student\'s name, phone and home address. RLS is the '
      + 'line that keeps the public key out of it, and this is the file that sets it.',
  },
  {
    id: 'invented-address-is-deliverable',
    file: 'netlify/functions/notify.js',
    suite: 'test:waitlist',
    find: "  if (a.slice(a.lastIndexOf('@') + 1) === PLACEHOLDER_MAIL_DOMAIN) {",
    replace: '  if (false) {',
    why: 'This site INVENTS addresses at its own domain to identify a phone, and '
      + 'nothing is ever delivered there. A form that accepts one stores a record '
      + 'the second channel can never open.',
  },
  {
    id: 'refused-credential-is-just-an-error',
    file: 'netlify/functions/roommate-match.js',
    suite: 'test:finance',
    find: 'err.credentialRefused = res.status === 401 || res.status === 403;',
    replace: 'err.credentialRefused = false;',
    why: 'Every call through sb() carries the service key, so a 401 or 403 is the '
      + 'deploy\u2019s own credential being refused \u2014 a deployment fact. Without the '
      + 'flag the doors answer "try again in a moment", which is a retry nobody can '
      + 'ever make work.',
  },
  {
    id: 'care-door-blames-the-student',
    file: 'netlify/functions/care-credit.js',
    suite: 'test:care',
    find: 'if (err && err.credentialRefused) {',
    replace: 'if (false) {',
    why: 'The key is in the slot and Supabase refuses it: the student holding the '
      + 'link did nothing wrong and cannot retry their way out. This branch is what '
      + 'tells them the site is not switched on instead of "try again".',
  },
  {
    id: 'credential-alert-per-visitor',
    file: 'netlify/functions/finance.js',
    suite: 'test:finance',
    find: "if (!limited('finance-credential-refused', 1)) {",
    replace: 'if (true) {',
    why: 'The alert is the only half of a refused credential a student cannot do. '
      + 'Unmetered, every visitor who retries the checkout sends another message and '
      + 'the one that matters is lost in the flood.',
  },
  {
    id: 'refused-value-reads-as-accepted',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: "if (status === 401 || status === 403) return 'refused';",
    replace: 'if (false) return \'refused\';',
    why: 'A 401 from the project is the whole point of the live gate: the value is set and '
      + 'unusable. Read as "accepted", a build ships a site whose every door answers '
      + '"not switched on yet" — the exact afternoon the check was written for.',
  },
  {
    id: 'tampered-key-need-not-be-refused',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: "if (bad.state === 'accepted') {",
    replace: 'if (false) {',
    why: 'The tampered copy is what proves the probe can see a refusal. Without it a project '
      + 'that accepts anything — a relation readable without a credential — reports the same '
      + 'green as a working key.',
  },
  {
    id: 'refused-sender-key-reads-as-fine',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: "const senderRefused = !!(liveSender && liveSender.state === 'refused') && !senderExcused;",
    replace: 'const senderRefused = false;',
    why: 'A sender that refuses the key is the second half of the same outage: the build '
      + 'passed on the NAME, the deploy shipped a key OpenWA does not know, and every code '
      + 'was issued and never delivered while the site looked healthy.',
  },
  {
    id: 'refused-email-key-reads-as-fine',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: "const emailRefused = !!(liveEmail && liveEmail.state === 'refused') && emailSet && !emailExcused;",
    replace: 'const emailRefused = false;',
    why: 'The email key is only ADVISED when it is absent, which is why a REFUSED one is easy '
      + 'to wave through: the status page keeps offering the second channel and the mail '
      + 'keeps not arriving.',
  },
  {
    id: 'refused-paystack-key-reads-as-fine',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: "const paystackRefused = !!(livePaystack && livePaystack.state === 'refused') && paystackSet && !paystackExcused;",
    replace: 'const paystackRefused = false;',
    why: 'A refused money key is the quietest outage on the site: the Care Pass page still renders, the ' 
      + 'button still works, and the checkout answers not-ready. The deploy must not publish with it.',
  },
  {
    id: 'refused-telegram-token-reads-as-fine',
    file: 'scripts/require-service-key.mjs',
    suite: 'test:deploy-key',
    find: "const telegramRefused = !!(liveTelegram && liveTelegram.state === 'refused') && telegramSet && !telegramExcused;",
    replace: 'const telegramRefused = false;',
    why: 'A revoked bot token means every alert — including the alert about the outage — is dropped. ' 
      + 'Waved through, the pager is silent and the site looks healthy.',
  },
  {
    id: 'the-shortest-outage-ends-in-silence',
    file: 'netlify/functions/lib/health-state.js',
    suite: 'test:db-health',
    find: 'const GRACE_MS = 90 * 60 * 1000;',
    replace: 'const GRACE_MS = 2 * 60 * 60 * 1000;',
    why: 'The shortest real outage is one missed run: healthy 10:00, refused 11:00, '
      + 'fixed, green 12:00. At two hours that gap is not greater than the threshold, '
      + 'so the alert is the last thing the team hears — the exact silence the notice exists to end.',
  },
  {
    id: 'no-all-clear-after-a-gap',
    file: 'netlify/functions/lib/health-state.js',
    suite: 'test:db-health',
    find: 'return { send: gapMs > GRACE_MS, gapMs: gapMs, lastOkAt: previous.lastOkAt };',
    replace: 'return { send: false, gapMs: gapMs, lastOkAt: previous.lastOkAt };',
    why: 'The all-clear is the only thing that tells the team an outage ended. Without it the last ' 
      + 'message they received is "the site cannot reach its database", indefinitely.',
  },
  {
    id: 'all-clear-on-every-healthy-hour',
    file: 'netlify/functions/lib/health-state.js',
    suite: 'test:db-health',
    find: 'return { send: gapMs > GRACE_MS, gapMs: gapMs, lastOkAt: previous.lastOkAt };',
    replace: 'return { send: true, gapMs: gapMs, lastOkAt: previous.lastOkAt };',
    why: 'A notice every healthy hour is the daily "all good" this project refuses: after a week ' 
      + 'nobody reads the channel, and the outage that matters arrives unread.',
  },
  {
    id: 'a-refused-key-is-a-good-key',
    file: 'netlify/functions/lib/database-probe.js',
    suite: 'test:db-health',
    find: 'if (read.status === 401 || read.status === 403) {',
    replace: 'if (false) {',
    why: 'The refusal IS the finding. Fallen through, the probe goes on to report a healthy '
      + 'hour on a deploy where every form, the Care panel and the checkout are down.',
  },
  {
    id: 'the-alert-does-not-say-what-to-fix',
    file: 'netlify/functions/database-health.js',
    suite: 'test:db-health',
    find: 'HELP[probe.stage]',
    replace: "''",
    why: 'The stage alone does not tell anybody what to do at 11pm. The repair sentence is '
      + 'the half of the alert that ends the outage.',
  },
  {
    id: 'a-recovered-credential-is-never-announced',
    file: 'netlify/functions/database-health.js',
    suite: 'test:db-health',
    find: '    const rec = recoveryForState(previous, c.name, now);',
    replace: "    const rec = c.name === 'database' ? recoveryForState(previous, c.name, now) : { send: false };",
    why: 'A Paystack key that was refused and then replaced is exactly the outage whose END the team '
      + 'cannot see: the build passes, the checkout works, and the last message they received still '
      + 'says it does not.',
  },
  {
    id: 'an-outage-that-started-before-the-probe-never-ends',
    file: 'netlify/functions/lib/health-state.js',
    suite: 'test:db-health',
    find: 'if (CHECKS.indexOf(name) !== -1 && !failing[name]) failing[name] = at.toISOString();',
    replace: 'if (false) failing[name] = at.toISOString();',
    why: 'A credential that is already broken on the first deploy has never passed, so without '
      + 'the first-refusal record its recovery has no gap to measure — the team is paged every '
      + 'hour and then hears nothing when it is finally fixed.',
  },
  {
    id: 'a-stale-hour-reads-as-this-hour',
    file: 'netlify/functions/lib/health-summary.js',
    suite: 'test:health-summary',
    find: 'const stale = !!at && gapMs > GRACE_MS;',
    replace: 'const stale = false;',
    why: 'The line is the only place a person sees the state without being paged. A mark from '
      + 'three hours ago printed without the staleness fact reads as "fine" at six in the evening, '
      + 'which is the false confidence the whole hourly probe exists to end.',
  },
  {
    id: 'a-refusal-hidden-by-the-grace',
    file: 'netlify/functions/lib/health-summary.js',
    suite: 'test:health-summary',
    find: 'const refusing = !!(since && (!at || since.getTime() > at.getTime()));',
    replace: 'const refusing = false;',
    why: 'A check refused at 14:10 after passing at 13:50 is inside the ninety-minute grace, so its '
      + 'last accepted hour still looks fresh. Without the refusal comparison the dashboard prints '
      + 'green through a live outage — the one hour the alert may already have been missed.',
  },
  {
    id: 'a-dead-pager-pages-nobody',
    file: 'netlify/functions/database-health.js',
    suite: 'test:db-health',
    find: 'if (!sent && telegramDead) {',
    replace: 'if (!sent && false) {',
    why: 'When the bot token is the broken credential, sendAlert is the dead channel. Without the '
      + 'fallback, that one outage is reported only to a log nobody opens — which is the silent '
      + 'pager this probe exists to end.',
  },
  {
    id: 'a-long-outage-of-one-check-erases-another',
    file: 'netlify/functions/database-health.js',
    suite: 'test:db-health',
    find: 'const healthy = checks.filter((c) => c.probe.ok === true && !c.probe.skipped).map((c) => c.name);',
    replace: 'const healthy = failing.length ? [] : checks.filter((c) => c.probe.ok === true && !c.probe.skipped).map((c) => c.name);',
    why: 'Writing markers only on fully green hours leaves the database and pager timestamps stale '
      + 'through a long Paystack outage, so the hour Paystack returns they are announced as '
      + 'RECOVERED too — two all-clears for an outage that never touched them.',
  },
  {
    id: 'a-revoked-code-never-switches-off',
    file: 'netlify/functions/finance.js',
    suite: 'test:referrals',
    find: 'body: JSON.stringify({ active: active }),',
    replace: 'body: JSON.stringify({ active: true }),',
    why: 'Revocation is the only brake on an abused code. Pinned on, a switched-off '
      + 'code keeps qualifying buyers and counting visits, and the dashboard keeps '
      + 'calling it live.',
  },
  {
    id: 'the-claims-guard-never-fires',
    file: 'supabase-claims.sql',
    suite: 'sql:guards',
    find: "  if to_regclass('public.ledger_entries') is null then",
    replace: '  if false then',
    why: 'The guard is what stops this file running against a database with no '
      + 'books: without it a claim is filed where the cost of the repair has '
      + 'nowhere to post.',
  },
  {
    id: 'a-dead-letter-never-rests',
    file: 'netlify/functions/alert-drain.js',
    suite: 'test:alert-outbox',
    find: '  const rested = attempts >= MAX_ATTEMPTS;',
    replace: '  const rested = false;',
    why: 'Eight failed attempts is the drain admitting Telegram will not answer '
      + 'and leaving the row as a readable failure. Never resting retries a dead '
      + 'announcement for ever, and every tick spends the shared ceiling on rows '
      + 'that cannot send instead of the ones that can.',
  },
];
