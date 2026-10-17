/* ============================================================
   Arzuz — telling the search engines a URL exists, today

   Google finds a new site on its own schedule, and on a site with
   no backlinks and no history that schedule is "eventually". Bing,
   Yandex, Seznam and Naver all accept a push instead: one POST
   naming the URLs, authenticated by a key file sitting on the site
   itself.

   THREE places submit, and they must agree:

     * scripts/indexnow.mjs          — the manual, whole-sitemap push
                                       after a deploy
     * netlify/functions/listing-live.js — the automatic push when a
                                       listing goes live (see that
                                       file: the database webhook)
     * both of them read this file

   A second copy of the endpoint, the body shape or the "what counts
   as accepted" rule would drift, and the failure would be silent:
   a malformed body is answered 400 and nothing is submitted, which
   looks exactly like a submission that worked until you check the
   index.

   WHAT IS DELIBERATELY NOT HERE
     No filesystem and no network at import time. The CLI reads the
     key file and the sitemap; the function reads the key out of its
     own bundle and calls Supabase. Both pass what they found in, so
     this module stays pure and testable.

   Loads as window.ArzuzIndexNow in a browser and via require() in
   Node (the same UMD wrapper as assets/listing-url.js).
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzIndexNow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  var ORIGIN = 'https://arzuz.com';
  var HOST = 'arzuz.com';

  /* The one endpoint every participating engine shares. */
  var ENDPOINT = 'https://api.indexnow.org/indexnow';

  /* The key file's NAME is the key. Nothing else is trusted: a file
     called indexnow.txt would authenticate nothing, which is why
     scripts/test-seo.mjs checks the name and the contents both. */
  var KEY_FILE = /^[a-f0-9]{8,128}\.txt$/i;

  /* ---------- the key ---------- */

  function isKeyFileName(name) {
    return KEY_FILE.test(String(name || ''));
  }

  /* The file's own name, when the file's contents are that name. An
     empty string means "this file is not an IndexNow key", which is
     the answer for every other .txt in the site root — robots.txt
     included. */
  function keyIn(fileName, contents) {
    var name = String(fileName || '');
    if (!isKeyFileName(name)) return '';
    var key = name.replace(/\.txt$/i, '');
    return String(contents === null || contents === undefined ? '' : contents).trim() === key
      ? key
      : '';
  }

  /* ---------- the URLs ---------- */

  /* The engines only accept URLs on the host in the body, and one
     off-host URL makes them refuse the WHOLE batch. Returning the
     offenders lets the caller say so instead of shipping a request
     that is read as spam. */
  function absolute(url) {
    var u = String(url || '');
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return ORIGIN + (u.charAt(0) === '/' ? u : '/' + u);
  }

  function offHost(urls) {
    var bad = [];
    for (var i = 0; i < urls.length; i++) {
      var host = '';
      try { host = new URL(urls[i]).host; } catch (e) { host = ''; }
      if (host !== HOST) bad.push(urls[i]);
    }
    return bad;
  }

  /* ---------- the request ---------- */

  function payload(key, keyFile, urls) {
    if (!key) throw new Error('ArzuzIndexNow: no key — a submission without one authenticates nothing');
    if (!keyFile) throw new Error('ArzuzIndexNow: no key file name — the engines fetch it before they trust the body');
    return {
      host: HOST,
      key: String(key),
      keyLocation: ORIGIN + '/' + keyFile,
      urlList: urls.slice()
    };
  }

  /* 200 accepted · 202 accepted, key still being validated. Every
     other code is a refusal, and the engine's own words are worth
     more than a summary of them — so they come back on `text`. */
  function accepted(status) {
    return status === 200 || status === 202;
  }

  /* One POST. `opts.fetch` is injected so a test can answer without a
     network; in a deployed function the global fetch is used. */
  async function submit(urls, opts) {
    opts = opts || {};
    var list = (urls || []).map(absolute).filter(Boolean);
    if (!list.length) return { ok: false, status: 0, text: '', empty: true, body: null };

    var bad = offHost(list);
    if (bad.length) {
      return { ok: false, status: 0, text: '', offHost: bad, body: null };
    }

    var body = payload(opts.key, opts.keyFile, list);
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { ok: false, status: 0, text: '', noFetch: true, body: body };

    var res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });

    var text = '';
    try {
      text = String((await res.text()) || '').trim();
    } catch (e) { /* a refusal with no body is still a refusal */ }

    return { ok: accepted(res.status), status: res.status, text: text, body: body, urls: list };
  }

  /* ---------- which rows are inventory the engines may be told about

     The same three conditions public_listings filters on
     (supabase-public-view.sql): active AND verified AND production.
     A row that fails any of them is not a page a visitor can open, so
     submitting its URL would be advertising a 404.

     `env` is read as production when it is absent: the column has
     `default 'production'`, and a webhook's old_record is not
     guaranteed to carry it. The view is still the authority — the
     function re-reads it — and this is the fallback for deciding
     whether a row that has just LEFT the board should be re-crawled
     so the engines see the 404. */
  function isLive(row) {
    if (!row) return false;
    if (String(row.status || '') !== 'active') return false;
    if (!(Number(row.tier || 0) >= 1)) return false;
    var env = row.env;
    return env === undefined || env === null || String(env) === 'production';
  }

  return {
    VERSION: VERSION,
    ORIGIN: ORIGIN,
    HOST: HOST,
    ENDPOINT: ENDPOINT,
    isKeyFileName: isKeyFileName,
    keyIn: keyIn,
    absolute: absolute,
    offHost: offHost,
    payload: payload,
    accepted: accepted,
    submit: submit,
    isLive: isLive
  };
});
