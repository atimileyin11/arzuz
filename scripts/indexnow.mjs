/* IndexNow — tell the other search engines a URL changed, today.

   Google finds a new site on its own schedule, and on a site with no
   backlinks and no history that schedule is "eventually". Bing, Yandex,
   Seznam and Naver all accept a push instead: one POST naming the URLs,
   authenticated by a key file that has to be sitting on the site itself.
   Arzuz's key is the <key>.txt in this directory — the file name IS the
   key, which is why it is not called indexnow.txt.

   THIS IS THE MANUAL, WHOLE-SITEMAP PUSH. The automatic one — a single
   listing, the moment it goes live — is
   netlify/functions/listing-live.js, driven by a database webhook. Both
   use assets/indexnow.js, so the endpoint, the body and the "what counts
   as accepted" rule exist once.

   Run it after a deploy, not before: it asks the engines to fetch URLs
   that only exist once Netlify has shipped them.

     node scripts/indexnow.mjs                 # every URL in sitemap.xml
     node scripts/indexnow.mjs /browse /care   # just those (paths or full URLs)
     INDEXNOW_DRY=1 node scripts/indexnow.mjs  # print the request, send nothing

   A 200 or 202 means the URLs were accepted for crawling, which is not the
   same thing as "indexed" — it means they go to the front of the queue.
   403 usually means the key file is not reachable at the URL this script
   prints; open it in a browser before blaming the key. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ArzuzIndexNow = require('../assets/indexnow.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ORIGIN, ENDPOINT } = ArzuzIndexNow;

/* ---------------------------------------------------------------
   the key: the file whose name is its own contents
   --------------------------------------------------------------- */
const keyFile = readdirSync(ROOT)
  .filter((f) => ArzuzIndexNow.isKeyFileName(f))
  .find((f) => ArzuzIndexNow.keyIn(f, readFileSync(join(ROOT, f), 'utf8')));

if (!keyFile) {
  console.error('No IndexNow key file found.');
  console.error('The key file lives in the site root, is named <key>.txt, and contains that same key.');
  console.error('Create one with:  node -e "const c=require(\'crypto\');const k=c.randomBytes(16).toString(\'hex\');require(\'fs\').writeFileSync(k+\'.txt\',k+\'\\n\');console.log(k)"');
  process.exit(1);
}
const KEY = ArzuzIndexNow.keyIn(keyFile, readFileSync(join(ROOT, keyFile), 'utf8'));

/* ---------------------------------------------------------------
   the URLs: the arguments, or everything in sitemap.xml
   --------------------------------------------------------------- */
function sitemapUrls() {
  const xml = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

const args = process.argv.slice(2).filter((a) => a && !a.startsWith('-'));
const urlList = (args.length ? args : sitemapUrls()).map(ArzuzIndexNow.absolute);

const offHost = ArzuzIndexNow.offHost(urlList);
if (offHost.length) {
  console.error('These are not on ' + ArzuzIndexNow.HOST + ' and IndexNow would reject the whole batch:');
  for (const u of offHost) console.error('  ' + u);
  process.exit(1);
}

const body = ArzuzIndexNow.payload(KEY, keyFile, urlList);

console.log('key file   ' + keyFile);
console.log('key is at  ' + body.keyLocation);
console.log('urls       ' + urlList.length);

if (process.env.INDEXNOW_DRY) {
  console.log('\nINDEXNOW_DRY — nothing sent. Body was:\n' + JSON.stringify(body, null, 2));
  process.exit(0);
}

let result;
try {
  result = await ArzuzIndexNow.submit(urlList, { key: KEY, keyFile });
} catch (e) {
  console.error('\nThe request never reached ' + ENDPOINT + ' — ' + (e && e.message));
  process.exit(1);
}

/* 200 = accepted, 202 = accepted and the key is being validated. Every other
   code is a real refusal and deserves the engine's own words rather than a
   summary of them. */
if (result.ok) {
  console.log('\nHTTP ' + result.status + ' — ' + urlList.length + ' URL(s) submitted.');
  process.exit(0);
}

console.error('\nHTTP ' + result.status + (result.text ? ' — ' + result.text : ''));
console.error('Nothing was submitted. The URLs were not rejected by their content: IndexNow reads the key file');
console.error('at ' + ORIGIN + '/' + keyFile + ' first, so check that this URL loads in a browser.');
process.exit(1);
