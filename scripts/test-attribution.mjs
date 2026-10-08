/* Regression harness for assets/attribution.js and assets/share.js.
   Run from arzuz-site/:  node scripts/test-attribution.mjs

   Both files are browser modules, so this builds a tiny fake window per
   scenario — location, localStorage, sessionStorage, navigator — and
   evaluates the real source in it. Nothing is stubbed inside the modules
   themselves: the code under test is the code that ships.

   The behaviour worth protecting:
     1. a channel tag is cleaned, never invented;
     2. a secret draft token in ?ref= on /complete-listing is NOT a channel;
     3. last touch wins, and a stored tag only counts inside its 30-day TTL;
     4. a share link always carries a valid tag, and an invalid one is
        dropped rather than stamped onto the URL. */

import { readFile } from 'node:fs/promises';

const PASS = [];
const FAIL = [];

function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name + (cond ? '' : '  ::  ' + (detail || '')));
}

const REF_SRC = await readFile('assets/attribution.js', 'utf8');
const SHARE_SRC = await readFile('assets/share.js', 'utf8');

/* ---------- a fake browser ---------- */

function makeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function makeWindow({ search = '', pathname = '/register.html', host = 'https://arzuz.com', ls, ss, share = true }) {
  const win = {
    location: {
      href: host + pathname + search,
      search,
      pathname,
      origin: host,
    },
    _share: share,
  };
  const document = {
    createElement: () => ({ style: {}, setAttribute() {}, value: '' }),
    body: { appendChild() {}, removeChild() {} },
  };
  const navigator = {};
  if (share) navigator.share = () => Promise.resolve();
  return { win, document, navigator, localStorage: ls || makeStore(), sessionStorage: ss || makeStore() };
}

/* Evaluate a script the way a <script> tag would: top-level `var` becomes
   a property of the fake window because the module assigns it there. */
function load(env, src) {
  const { win, document, navigator, localStorage, sessionStorage } = env;
  const fn = new Function(
    'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
    'URLSearchParams', 'URL', 'setTimeout', 'clearTimeout', 'console',
    src + '\n//# sourceURL=' + (src === REF_SRC ? 'attribution.js' : 'share.js'),
  );
  fn(win, document, navigator, localStorage, sessionStorage,
     URLSearchParams, URL, setTimeout, clearTimeout, console);
  return win;
}

/* Loads attribution first, then share on top of the same window — the
   order the pages actually use. */
function boot(opts) {
  const env = makeWindow(opts || {});
  load(env, REF_SRC);
  const ref = env.win.ArzuzRef;
  const share = load(env, SHARE_SRC).ArzuzShare;
  return { ...env, ref, share };
}

/* ---------- 1. sanitize ---------- */

{
  const { ref, sessionStorage } = boot({ search: '' });
  check('sanitize: lowercases', ref.sanitize('Flyer-Q1') === 'flyer-q1', ref.sanitize('Flyer-Q1'));
  check('sanitize: keeps a hyphenated channel', ref.sanitize('flyer-q1') === 'flyer-q1');
  check('sanitize: keeps a dotted channel', ref.sanitize('whatsapp.status') === 'whatsapp.status');
  check('sanitize: strips wrapping separators', ref.sanitize('  --whatsapp--  ') === 'whatsapp', ref.sanitize('  --whatsapp--  '));
  check('sanitize: rejects empty', ref.sanitize('') === '');
  check('sanitize: rejects a 41-char tag', ref.sanitize('a'.repeat(41)) === '');
  /* The length cap must not swallow ordinary long channel names — this is
     the case a blanket "any long hex string is a token" rule got wrong. */
  const longName = 'campaign-' + 'a'.repeat(31);   // exactly 40 chars
  check('sanitize: accepts a 40-char campaign name', ref.sanitize(longName) === longName, ref.sanitize(longName));
  check('sanitize: rejects a 40-char hex digest (sha1-shaped)', ref.sanitize('a'.repeat(40)) === '');
  check('sanitize: rejects a path', ref.sanitize('ambassador/ayo') === '', ref.sanitize('ambassador/ayo'));
  check('sanitize: rejects a spaced phrase', ref.sanitize('flyer q1') === '');
  check('sanitize: rejects a dashless uuid (draft-token shaped)', ref.sanitize('a1b2c3d4e5f60718293a4b5c6d7e8f90') === '');
  check('sanitize: rejects a dashed uuid', ref.sanitize('a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90') === '');
  check('sanitize: rejects base64 padding', ref.sanitize('tag=') === '');
  check('sanitize: rejects a non-string', ref.sanitize(42) === '');
  check('no tag on a plain visit', ref.tag() === '', ref.tag());
  check('nothing was stored on a plain visit', sessionStorage.getItem('arzuz_ref_v1') === null);
}

/* ---------- 2. capture, last touch, session carry-over ---------- */

{
  const { ref, localStorage, sessionStorage } = boot({ search: '?ref=whatsapp-status' });
  check('captures a tag on load', ref.tag() === 'whatsapp-status', ref.tag());
  check('stores it for the session', sessionStorage.getItem('arzuz_ref_v1') === 'whatsapp-status');
  check('stores it for the browser with a timestamp',
    !!JSON.parse(localStorage.getItem('arzuz_ref_v1') || '{}').at);

  // a second page in the same session, no query string of its own
  const same = makeWindow({ search: '', pathname: '/listing.html', ls: localStorage, ss: sessionStorage });
  load(same, REF_SRC);
  check('carries the tag to the next page', same.win.ArzuzRef.tag() === 'whatsapp-status', same.win.ArzuzRef.tag());

  // a NEWER tag wins (last touch)
  const newer = makeWindow({ search: '?ref=flyer-q1', ls: localStorage, ss: sessionStorage });
  load(newer, REF_SRC);
  check('a newer tag wins (last touch)', newer.win.ArzuzRef.tag() === 'flyer-q1', newer.win.ArzuzRef.tag());
  check('and overwrites the stored one', JSON.parse(localStorage.getItem('arzuz_ref_v1')).tag === 'flyer-q1');

  // an invalid tag must not erase a valid one
  const junk = makeWindow({ search: '?ref=@@bad@@', ls: localStorage, ss: sessionStorage });
  load(junk, REF_SRC);
  check('a junk tag is ignored, the real one survives', junk.win.ArzuzRef.tag() === 'flyer-q1', junk.win.ArzuzRef.tag());

  // not-a-tag query params are ignored entirely
  const other = makeWindow({ search: '?id=abc&utm_source=x', ls: localStorage, ss: sessionStorage });
  load(other, REF_SRC);
  check('an unrelated query string falls through to the stored tag', other.win.ArzuzRef.tag() === 'flyer-q1');
}

/* ---------- 3. the draft-token collision ---------- */

{
  const token = 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90';
  const { ref, sessionStorage, localStorage } = boot({ pathname: '/complete-listing', search: '?ref=' + token });
  check('on /complete-listing a ref token is not a channel', ref.tag() === '', ref.tag());
  check('and is not stored', sessionStorage.getItem('arzuz_ref_v1') === null);
  check('and not written to the browser store', localStorage.getItem('arzuz_ref_v1') === null);

  const dotHtml = boot({ pathname: '/complete-listing.html', search: '?ref=' + token });
  check('same for /complete-listing.html', dotHtml.ref.tag() === '');
}

/* ---------- 4. TTL ---------- */

{
  const ls = makeStore();
  ls.setItem('arzuz_ref_v1', JSON.stringify({ tag: 'old-campaign', at: Date.now() - 29 * 86400000 }));
  const fresh = boot({ search: '', ls });
  check('a 29-day-old tag still counts', fresh.ref.tag() === 'old-campaign', fresh.ref.tag());

  const stale = makeStore();
  stale.setItem('arzuz_ref_v1', JSON.stringify({ tag: 'old-campaign', at: Date.now() - 31 * 86400000 }));
  const expired = boot({ search: '', ls: stale });
  check('a 31-day-old tag has expired', expired.ref.tag() === '', expired.ref.tag());

  const broken = makeStore();
  broken.setItem('arzuz_ref_v1', 'not json');
  const bad = boot({ search: '', ls: broken });
  check('a corrupt store does not throw', bad.ref.tag() === '');
}

/* ---------- 5. link() ---------- */

{
  const { ref } = boot({ search: '' });
  check('link: adds the tag', ref.link('/register', 'flyer-q1') === '/register?ref=flyer-q1', ref.link('/register', 'flyer-q1'));
  check('link: replaces an existing tag',
    ref.link('/register?ref=old', 'new-tag') === '/register?ref=new-tag', ref.link('/register?ref=old', 'new-tag'));
  check('link: preserves other params',
    ref.link('/register?utm_source=x&ref=old', 'new-tag') === '/register?utm_source=x&ref=new-tag',
    ref.link('/register?utm_source=x&ref=old', 'new-tag'));
  check('link: preserves the hash', /#form$/.test(ref.link('/register#form', 'flyer-q1')));
  check('link: keeps a same-origin link relative', ref.link('/register', 'flyer-q1').indexOf('https://') === -1);
  check('link: keeps an absolute external link absolute',
    ref.link('https://wa.me/234', 'flyer-q1') === 'https://wa.me/234?ref=flyer-q1', ref.link('https://wa.me/234', 'flyer-q1'));
  check('link: an invalid tag drops the param instead of writing junk',
    ref.link('/register', '@@bad@@') === '/register', ref.link('/register', '@@bad@@'));
  check('link: never throws on empty input', ref.link('', 'flyer-q1') === '');
  check('share(): validates like sanitize', ref.share('@@bad@@') === '' && ref.share('Ambassador-Ayo') === 'ambassador-ayo');
}

/* ---------- 6. the share card ---------- */

{
  const { share, ref } = boot({ search: '?ref=listing-share' });
  check('card() exports the API the pages call', typeof share.card === 'function' && typeof share.wire === 'function');

  const html = share.card({ url: '/register', tag: 'student-share', heading: 'Know someone?', body: 'Send it on.' });
  check('card: has the share root', html.indexOf('data-share-card') !== -1);
  check('card: has all three actions',
    html.indexOf('data-share="wa"') !== -1 && html.indexOf('data-share="copy"') !== -1 && html.indexOf('data-share="native"') !== -1);
  check('card: keeps the tag it was given', html.indexOf('data-share-tag="student-share"') !== -1);
  check('card: absolutises the share url', /data-share-url="https:\/\/arzuz\.com\/register"/.test(html), html.slice(0, 200));
  check('card: the WhatsApp link is a wa.me picker with the tag',
    /href="https:\/\/wa\.me\/\?text=[^"]*student-share/.test(html) || html.indexOf('https://wa.me/?text=') !== -1);
  check('card: no inline handlers', html.indexOf('onclick=') === -1);
  check('card: no inline styles', html.indexOf('style="') === -1);

  const hostile = share.card({ url: '/register', tag: 'evil', heading: '<img src=x onerror=alert(1)>', body: '"quoted"' });
  check('card: escapes a hostile heading', hostile.indexOf('<img') === -1 && hostile.indexOf('&lt;img') !== -1);
  check('card: escapes quotes in the body', hostile.indexOf('&quot;quoted&quot;') !== -1);

  const noTag = share.card({ url: '/register', tag: '@@bad@@' });
  check('card: an invalid tag is dropped, not written', noTag.indexOf('data-share-tag=""') !== -1, noTag.match(/data-share-tag="[^"]*"/));
  check('card: still shares when the tag is unusable', /href="https:\/\/wa\.me\/\?text=/.test(noTag));

  check('card: renders nothing without a url', share.card({}) === '');
  check('taggedUrl(): falls back to the default tag',
    share.taggedUrl('/register').indexOf('ref=' + share.DEFAULT_TAG) !== -1);
  check('DEFAULT_TAG is a valid channel tag', share.DEFAULT_TAG === 'student-share');
  check('taggedUrl(): an unshareable url yields no link', share.taggedUrl('') === '');

  // the native button must not be revealed in a browser without navigator.share
  const noNative = boot({ search: '', share: false });
  const desktop = noNative.share.card({ url: '/register' });
  check('card: native button is hidden without navigator.share',
    /data-share="native"[^>]*hidden/.test(desktop) || /class="share-btn ghost hidden"/.test(desktop));
}

/* ---------- report ---------- */

console.log('\nPASS: ' + PASS.length);
PASS.forEach((p) => console.log('  \u2713 ' + p));
if (FAIL.length) {
  console.log('FAIL: ' + FAIL.length);
  FAIL.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('\nALL ATTRIBUTION / SHARE CHECKS PASSED');
