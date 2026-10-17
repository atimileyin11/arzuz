# SEO — what was wrong, what changed, what only you can do

This is the runbook for the one problem the other docs do not cover: the
site was live, fast and correct, and search engines had nothing to put in
the index.

It is written to be read once, in order, and then used as a checklist.

---

## 1. The diagnosis, with the numbers

Measured against the live site on 12 October 2026, with the HTML exactly as
Netlify serves it and **no JavaScript run** — which is what a crawler gets on
its first, cheapest fetch:

| URL | text in the served HTML | `<h1>` |
|---|---|---|
| `/` | 3,429 chars | yes |
| `/safety` | 1,335 chars | yes |
| `/care` | 1,956 chars | yes |
| `/privacy` | 8,203 chars | yes |
| `/terms` | 9,097 chars | yes |
| `/browse` | 583 chars | yes |
| `/register` | **0 chars** | **none** |
| `/list` | **0 chars** | **none** |
| `/my-building` | **0 chars** | **none** |
| `/listing` | 301 chars | **none in the HTML** |

Three pages that exist to be found — the two forms and the building page —
arrived as a single empty `<div>`. Every word on them was drawn by
`assets/app.js` after load. A page with no heading and no words is not a
thin page to a crawler; it is an empty one, and empty pages are not indexed
however good they look in a browser.

A second, quieter problem sat next to it: **each page answered on three
addresses**. `/list` and `/owner-list` and `/owner-list.html` all returned
HTTP 200 with the same document, and every internal link on the site pointed
at the `.html` one while the canonical tag and `sitemap.xml` pointed at the
clean one. Google picks a canonical, but three live copies of every page
split the same signals three ways and spend crawl budget — and on a site with
no index history, crawl budget is the whole game.

Neither problem was a missing meta tag, and neither would have been fixed by
one.

---

## 2. What changed in the repo

**Crawler-visible content.** `register.html`, `owner-list.html` and
`scout.html` now ship a real `<h1>` and a few hundred words of real copy
inside `#form`. `Arzuz.form()` overwrites `#form` on its first draw: on
`/register` that draw is synchronous, so nobody with JavaScript ever sees the
intro; on `/list` and `/my-building` the draw waits for the Supabase fetch, so
the intro is also what fills the page while it loads — better than the empty
document that used to sit there. A crawler with no script sees a complete page
in every case.

The `<h1>` on those three pages sits **outside** `#form`, and that is not a
style choice. A step question is an `<h2 class="qh">`, so an `<h1>` inside the
intro was real in the file and gone from the DOM the moment the form drew —
leaving the rendered page with no heading at all, which is the document a
search engine indexes when it runs JavaScript. The guard fails the build if
the heading ever moves back inside `#form`. `browse.html` gained a "what the badges mean / how to read a listing /
where we are live" section below the listings — visible to everyone, and the
part of that page that does not depend on a Supabase fetch.

**One address per page.** Every internal link now uses the canonical,
extension-less URL, and `netlify.toml` answers a **301** for every `.html`
duplicate plus the two legacy paths (`/owner-list`, `/scout`).
`/listing.html` had its own copy of the 200 rewrite to the Open Graph
function; that is gone, because two live addresses per listing is the same
bug.

**The footer is now the internal link hub.** It was four legal links. It now
links every page that needs to be found — browse, find-a-room, list-a-property,
my-building, roommates, care, safety, privacy, terms — with the labels grouped.
A crawler reaches a page by following a link to it; a sitemap only confirms
what it already found.

**Structured data.** The homepage `WebSite` node promised a `SearchAction`
pointing at `/register` with a `search_term_string` input. There is no site
search on Arzuz, so the markup described a feature that does not exist — the
kind of thing that shows up as an error the first time Search Console looks
at a new property. It is gone, replaced by an `Organization` node with the
logo, the support address and the published WhatsApp number, and a
`LocalBusiness` with the locality it serves.

**`sitemap.xml`** now lists only canonical URLs, each with an accurate
`lastmod`. `robots.txt` no longer
discredits itself with a comment about `/owner-list.html`; the private pages
are excluded with an `X-Robots-Tag` header rather than a `Disallow`, because a
disallowed URL is never crawled and so a `noindex` on it is never read.

**The three pages written for the queries.** `/rent-in-malete`,
`/hostels-near-kwasu` and `/safety` are real content pages — the first two are
new, the third was a 339-word note that is now a 1,200-word answer — and every
one of them is linked from the footer hub of every page. They answer "how much
is rent in Malete", "what does near campus actually mean" and "how do I not get
scammed renting here" in the words a student would use, because those are the
queries with volume and the old site had no page for any of them.

**The board links them.** `/browse` drew its cards from Supabase after load,
so the `<a href="/rooms/…">` a crawler follows to reach a room existed only in
JavaScript: the listings were reachable by sitemap and by nothing else. A
sitemap tells an engine a URL exists; a link is how it decides the page is
part of the site. `netlify/functions/browse.js` now renders the whole board —
every card, its link and its price — into the served HTML, and the page fetches
nothing at all. That leaves one renderer of a room (`assets/browse-card.js`,
which the function requires and the CLI checks use too) instead of a server copy
for crawlers and a browser copy for people that could each be wrong about a
room. When the database cannot be reached the board line says so and offers the
way to register, because the one page whose job is to be reachable must not go
down with Supabase.

**Every listing has its own address.** `/rooms/<slug>` is served by
`netlify/functions/rooms.js`, which writes the room into the HTML — heading,
price, description, utilities, the measured walk, structured data — so the page
is complete with JavaScript switched off. The slug ends in the listing's uuid,
so renaming a property moves its address with a 301 rather than forking into a
second page, and an id that resolves to nothing is a real 404 instead of a 200
with "not live" written in it. `/listing?id=<uuid>` still answers (links are out
in the world) but now declares `/rooms/<slug>` as its canonical, so the two
addresses cannot compete.

**`sitemap-listings.xml`** is the half of the sitemap the database writes, from
the same view the site reads. It is deliberately separate from `sitemap.xml`:
if Supabase is unreachable it answers 503, and the static pages are unaffected.
An **503 is returned rather than an empty urlset** on purpose — an empty sitemap
is read as "these pages are gone", and a search engine will believe it. Each
room's `lastmod` is the day it was last **edited** (`listings.updated_at`, kept
by a trigger so a hand edit in the table editor counts too) rather than the day
it was registered: a room whose rent just moved is exactly the page that wants
re-crawling, and an untrustworthy `lastmod` is ignored for the whole site. Until
`supabase-listings-updated-at.sql` has been run the sitemap falls back to
`created_at` and says so in the function log.

`changefreq` and `priority` are **per room** as well, instead of the same two
constants on every URL. Both come off one score per room: how recently it
changed, and how much of its page there is — a rent, a photo, a pin, what the
place is, how much of it there is, and a description. A complete room edited
this week is `daily`/0.9; a sparse page nobody has touched is `yearly`/0.3.
`changefreq` is a hint Google overrides with what it actually sees, so the aim
is not to game it but to stop lying with it. The bands and both hints are
pinned by `node scripts/test-rooms.mjs` with an explicit clock, so they do not
drift.

The description is the one signal the sitemap cannot read off the row without
shipping a paragraph per room, so `public_listings` answers the question
instead: `has_description` is a boolean on the view, recomputed from the same
`desc`/`description` keys the room page reads. **Re-run
`supabase-public-view.sql` to get it** — until then the sitemap drops that one
signal (and says so in its log) rather than failing.

**The guard:** `npm run test:seo` (and it runs inside `npm test`). It reads the
files on disk and fails the build if any public page loses its `<h1>`, drops
below 600 characters of script-free text, moves its heading inside the
container the form engine overwrites, loses its canonical, links a `.html`
duplicate, disagrees with `sitemap.xml`, loses its forced 301, stops parsing
its structured data, leaves the IndexNow key file unreachable, or drops a page
from the footer hub. Every rule in it is one of the two bugs above coming back.

---

## 3. Deploy first, then do all of this

IndexNow and Search Console both fetch URLs from the live site. Nothing below
does anything useful until the new build is deployed.

```bash
git add -A && git commit -m "SEO: crawlable content, canonical URLs, link hub, IndexNow"
git push          # Netlify deploys from main
```

Then confirm the redirects actually fire (they are `force = true`, so they
should beat the real files):

```bash
for u in index.html register.html browse.html owner-list.html scout.html \
         roommates.html safety.html care.html privacy.html terms.html \
         rent-in-malete.html hostels-near-kwasu.html \
         listing.html owner-list scout; do
  curl -sI "https://arzuz.com/$u" | head -1
done
# every one of these must print 301
```

Then confirm the two things that only exist once deployed — the generated
sitemap and a real listing page:

```bash
curl -s  https://arzuz.com/sitemap-listings.xml | head -5   # <urlset>, 200
curl -sI https://arzuz.com/sitemap-listings.xml  | head -1  # 200, never 404
curl -sI "https://arzuz.com/rooms/anything-not-a-uuid"      # 301 → /browse
```

For the last one, open a real room from `/browse` and check three things in the
served HTML (`view-source:`, or `curl`): the room's name and rent are in the
markup with JavaScript off, there is exactly one `<h1>`, and
`<link rel="canonical">` is the `/rooms/<slug>` URL rather than `/listing?id=`.
That is the whole point of the page, and it is the one check a browser will not
give you, because the browser renders it either way.

The board is the same kind of check, and now the same command:

```bash
curl -s https://arzuz.com/browse | grep -c 'class="card"'      # one per live room
curl -s https://arzuz.com/browse | grep -o 'href="/rooms/[^"]*"'  # a link per room
```

Both must be non-zero in the raw response — those links are what pull a room
into the index, and they used to be written by the browser only.

And that the pages now have something on them:

```bash
curl -s https://arzuz.com/register | sed -e 's/<[^>]*>/ /g' | tr -s ' \n' ' ' | wc -c
# was 0, should be several thousand
```

---

## 4. Google Search Console

1. <https://search.google.com/search-console> → **Add property**.
   Choose **Domain** if you can add a TXT record to arzuz.com's DNS — it
   covers `https://`, `http://`, the apex and every subdomain in one go and
   needs no code change. If you would rather not touch DNS, choose **URL
   prefix** with `https://arzuz.com/` and use the **HTML tag** method: paste
   the `<meta name="google-site-verification" ...>` tag into the `<head>` of
   `index.html` (next to the other meta tags, above the JSON-LD), commit and
   deploy, then press Verify.
2. **Sitemaps** → submit both. `sitemap.xml` first (the twelve pages), then
   `sitemap-listings.xml` (the rooms). Both should read "Success" within a
   day. Submitting the second one while it is empty is harmless and means you
   do not have to remember it when the first rooms go live.
3. **URL Inspection** → paste each of the twelve canonical URLs → **Request
   indexing**. Do them one at a time; the button is rationed and it is the
   only way to jump the queue on a domain Google has never seen. Do **not**
   paste a `/rooms/<slug>` URL here until there is real inventory — there is
   nothing to index until a verified room exists, and the sitemap will hand
   them over when it does.
4. Come back in three days and read **Pages**. For a new site the honest
   expected answer for most of them is *"Crawled – currently not
   indexed"*. That is not a technical fault and nothing in this repo fixes
   it: it means Google looked, understood the page, and decided it does not
   yet deserve a slot. It resolves with links from other sites — see §6.

## 5. Bing, Yandex, and the other engines

- **Bing Webmaster Tools**: <https://www.bing.com/webmasters> → *Import from
  Google Search Console*. One click, and it inherits the verification.
- **IndexNow** then does the pushing for Bing, Yandex, Seznam and Naver:

  ```bash
  npm run seo:indexnow                    # every URL in sitemap.xml
  npm run seo:indexnow /browse /register  # just those
  INDEXNOW_DRY=1 npm run seo:indexnow     # print the request, send nothing
  ```

  The key is the `<key>.txt` file in the site root — the file **name** is the
  key, and `scripts/indexnow.mjs` finds it by looking for the file whose name
  equals its own contents. Check the URL it prints opens in a browser before
  blaming the key: a 403 from IndexNow almost always means that file is not
  reachable, not that the key is wrong.

  Run it after every deploy that changes a page. There is no cron and no
  build hook for it on purpose — a submission on every commit is noise, and
  the engines treat noise as spam.

- **A new listing pushes itself.** The command above submits the pages in
  `sitemap.xml`, which is the right list after a deploy and the wrong list for
  inventory: rooms appear at random, and nobody is going to remember to run a
  command when one does. So the database tells the engines instead:

  ```
  listings INSERT/UPDATE
    → Supabase database webhook  →  POST /api/listing-live
      → the function re-reads the row from public_listings
        → POST to IndexNow with that room's /rooms/<slug>
  ```

  The one-time setup, because the webhook lives in a dashboard and not in a
  file:

  1. Netlify → **Site configuration → Environment variables** → add
     `INDEXNOW_HOOK_SECRET`, a long random value. Nothing else uses it. The
     function refuses every request without it, and `/api/listing-live` is a
     public URL.
  2. Supabase → **Database → Webhooks → Create a new hook**: table
     `listings`, events **Insert** and **Update**, type **HTTP Request**,
     method `POST`, URL `https://arzuz.com/api/listing-live`, and one HTTP
     header `x-arzuz-hook` set to the same secret.
  3. Deploy, then publish one test listing from `/admin` and read the hook's
     own log. A `200` with `"submitted"` is the whole feature working; a
     `503` naming `INDEXNOW_HOOK_SECRET` means step 1 did not reach the
     deploy.

  It submits an address **once**. A save that changes nothing a visitor can
  read is ignored — IndexNow asks for that explicitly, and a host that pings
  on every edit is a host it throttles — a renamed property is submitted at
  its new address, and a room taken off the board is submitted again, which
  is how the engines come back, see the 404 and drop it instead of leaving a
  gone room in the results for weeks.

  "Changes nothing a visitor can read" is judged on the six facts the page
  prints: the rent, the cover photo, the vacancy, the property type, the pin,
  the tier badge — and the **description**. The description is the odd one
  out, because it is the only fact with no generated column: it lives in the
  payload, so the row is re-read from `public_listings` **with** its payload
  and the two keys the page reads (`desc`, then `description`) are compared
  as text. An owner who rewrites the paragraph therefore gets a crawl; an
  owner whose landlord changed phone number does not, because `public_listings`
  scrubs `nm`, `last`, `ph`, `who` and `email` before the function can read
  them, and the comparison reads the description out of the payload by key
  rather than comparing payloads. Both halves — including that none of those
  five scrubbed keys can trigger a submission — are in
  `node scripts/test-indexnow.mjs`.

## 6. The part that is not code

Ten indexable pages and a working sitemap get a site *considered*. Nothing
here gets it *ranked*, and no amount of markup substitutes for the thing
Google is actually measuring: other sites linking to arzuz.com.

In rough order of return for this site:

1. **KWASU-facing places.** Student Facebook and WhatsApp groups, the
   departmental notice boards, the hostel notice at the main gate, the
   KWASU student union pages. One link from a page that is itself indexed
   is worth more than anything in §2.
2. **A Business Profile** at <https://business.google.com> for the Malete
   address, if there is a real one. It is what makes "student hostel near
   KWASU" surface a map result, and it is the one local signal this site
   cannot fake with markup.
3. **Landlord phone numbers.** Every landlord who lists is a person with a
   website or a WhatsApp status; ask them to link `/list` once.
4. **Answer the next questions.** The three pages in §2 now cover rent in
   Malete, what "near campus" means and how to rent without being scammed.
   The query set does not stop there — "hostel with water in Malete", "how
   much is a room around KWASU per session", "cheap hostel near KWASU gate",
   "KWASU hostel with a private bathroom" — and each one wants its own page,
   because a page that answers one question ranks for one question. Link the
   new pages from the KWASU-facing places in item 1 as well as from the
   footer; a content page nobody links to is a page nobody finds.

---

## 7. Known gaps, so they are not mistaken for done

- **The listings sitemap is only as good as the database.** `sitemap-listings.xml`
  asks `public_listings` for what is live right now, so a room that is not
  active, not verified or not production is absent — correct, but it also means
  the file is empty until real verified inventory exists, and an empty
  `<urlset>` is a valid sitemap that lists nothing. It also cannot be
  exercised on localhost: the function, the route and the 503 path are covered
  by `node scripts/test-rooms.mjs` against a mocked database, and the deploy
  check in §3 is what confirms it on the live site.
- **The push depends on a hook that only a dashboard can create.**
  `netlify/functions/listing-live.js` covers every way a listing can go live —
  the admin dashboard's publish action and a hand edit in the table editor are
  both writes to the same table — but only once the one-time hook in §5 has
  been created in the Supabase dashboard, and only with
  `INDEXNOW_HOOK_SECRET` set. Until then a new room is still found the old
  way: a crawler reading `sitemap-listings.xml`. Nothing fails loudly when the
  hook is missing — the sitemap eventually does the job — which is exactly why
  it is easy to forget. The function's own decisions are covered by
  `node scripts/test-indexnow.mjs` against a mocked database; the hook itself
  is not, because nothing in this repo can create one.
- **A listing's `lastmod` is only as good as the trigger behind it.**
  `sitemap-listings.xml` reports `listings.updated_at`, stamped by
  `supabase-listings-updated-at.sql`. Until that file has been run — and
  `supabase-public-view.sql` re-run after it, which is what exposes the column —
  the sitemap reports `created_at` instead, so a room whose rent moved still
  looks unchanged. It degrades quietly on purpose (a 503 there would tell the
  engines every room is gone) and logs one line when it does. The column, the
  backfill, the trigger and the fallback are proved by `npm run sql:proof` and
  `node scripts/test-rooms.mjs`; that the SQL has been run on the live database
  is not something this repo can see.
- **The per-room hints are only as good as the columns the view exposes.**
  `changefreq` and `priority` are sized from the generated columns
  `public_listings` carries (photo, pin, price, type, rooms) plus the
  `has_description` flag. Each of those is optional, and the sitemap drops
  them one at a time as a database refuses them — newest first — logging a
  line each time and never answering 503 for a missing column. A database
  older still than that drops to a SELECT that can only build the slug and
  sizes every room the same.
  What completeness still cannot see is inside the payload: amenities and
  extra media are not counted, because shipping a thousand payloads to weight
  a hint field is not worth the response size. A room with a rent, a photo, a
  pin and a description but no listed amenities is still scored complete.
- **`/listing` has no `<h1>` in its served HTML.** The heading is built by
  JavaScript. Googlebot renders JS and sees it; a crawler that does not, does
  not. It is deliberately excluded from the guard table because it is not a
  URL with a fixed canonical.
- **`lastmod` in `sitemap.xml` is hand-maintained.** It is accurate today. It
  stops being trustworthy the moment someone edits a page and does not touch
  it, and an untrustworthy `lastmod` is worse than none — Google ignores the
  field for the whole site, not just that URL. Change it when a page's own
  content changes, not on every deploy.
