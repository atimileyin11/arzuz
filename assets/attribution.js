/* ============================================================
   Arzuz — channel attribution (?ref=)

   Marketing spend is only measurable if every link Arzuz hands out
   carries a tag. A visitor arrives on ?ref=whatsapp-status, we
   remember the tag for the rest of that session (and for a return
   visit inside the TTL), and submit.js copies it into the row's
   payload as `ref`. Nothing else reads it: the admin Growth view
   counts payload.ref per channel, so doc 06 stops being a plan and
   starts being a measurement.

   Last touch wins — the most recent tag a visitor actually clicked
   is the channel that gets the credit, and a tag in the current URL
   always beats a stored one.

   The collision this file defends against: /complete-listing.html
   already uses the SAME `ref` parameter for a landlord's secret
   draft token (see supabase-drafts-support.sql). A token must never
   be filed as a channel, so attribution is switched off on that page
   entirely and sanitize() rejects token-shaped values everywhere.

   Plain ES5, no dependencies. Loading the script IS the integration:
   the IIFE captures the tag on load. Only public values are stored —
   the tag a marketer typed into a link, never a token or an id.

   Usage:
     ArzuzRef.tag()                       current channel, '' if none
     ArzuzRef.link(url, 'flyer-q1')       url with ?ref=flyer-q1 set
     ArzuzRef.share('student-share')      a tag to stamp on a share link
   ============================================================ */

var ArzuzRef = (function () {

  var PARAM    = 'ref';
  var TTL_DAYS = 30;
  var SS_KEY   = 'arzuz_ref_v1';   // this browsing session
  var LS_KEY   = 'arzuz_ref_v1';   // this browser, for TTL_DAYS

  /* The draft-invite page keeps its secret token in `ref`, so nothing
     arriving there is attribution. Anchored regex: only that page. */
  var DRAFT_PAGE = /\/complete-listing(\.html)?$/i;

  function isDraftPage() {
    try { return DRAFT_PAGE.test(window.location.pathname); }
    catch (e) { return false; }
  }

  /* A channel tag is something a human typed into a link: short,
     lowercase, words joined with . _ or -. Everything else is a
     mistake or a secret, and is dropped rather than stored. */
  function sanitize(raw) {
    if (typeof raw !== 'string') return '';
    var tag = raw.trim().toLowerCase()
      .replace(/^[\s._-]+/, '')
      .replace(/[\s._-]+$/, '');
    if (!tag || tag.length > 40) return '';
    if (!/^[a-z0-9._-]+$/.test(tag)) return '';
    /* Token-shaped: a uuid with its dashes stripped, a long hex
       string, or anything base64-ish. No real channel looks like
       that, and a draft token that does must never be counted. */
    /* Token-shaped, not channel-shaped. The rules are deliberately exact
       (a 32/40/64-char digest, a canonical UUID, anything with base64
       punctuation) rather than "any long hex string": a blanket length
       rule threw away legitimate tags like a 40-character campaign name
       that happens to use only a-f, and this file's job is to keep tags,
       not reject them. */
    if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tag)) return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tag)) return '';
    if (/[+\/=]/.test(tag)) return '';
    return tag;
  }

  /* The tag in the URL the visitor is on right now. */
  function read() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return sanitize(params.get(PARAM) || '');
    } catch (e) { return ''; }
  }

  function readSession() {
    try { return sanitize(sessionStorage.getItem(SS_KEY) || ''); }
    catch (e) { return ''; }
  }

  function writeSession(tag) {
    try { if (tag) sessionStorage.setItem(SS_KEY, tag); } catch (e) {}
  }

  /* The stored tag only counts while it is young enough to still be
     the reason this person is back. Older than TTL_DAYS and the
     visit is organic. */
  function readStored() {
    try {
      var v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (!v || typeof v !== 'object') return '';
      var age = Date.now() - Number(v.at || 0);
      if (!(age >= 0) || age > TTL_DAYS * 86400000) return '';
      return sanitize(String(v.tag || ''));
    } catch (e) { return ''; }
  }

  function writeStored(tag) {
    try {
      if (tag) localStorage.setItem(LS_KEY, JSON.stringify({ tag: tag, at: Date.now() }));
    } catch (e) {}
  }

  /* Capture the tag this page carries and carry it forward. Safe to
     call as often as you like; it only ever reads and writes stores
     that already exist. */
  function remember() {
    if (isDraftPage()) return '';            // `ref` is a draft token here
    var fromUrl = read();
    if (fromUrl) { writeSession(fromUrl); writeStored(fromUrl); return fromUrl; }
    var session = readSession();
    if (session) { writeStored(session); return session; }
    var stored = readStored();
    if (stored) { writeSession(stored); return stored; }
    return '';
  }

  /* The effective tag. Reads the URL first so it is correct even if
     this module is loaded after a form has already initialised. */
  function tag() {
    if (isDraftPage()) return '';
    return read() || readSession() || readStored();
  }

  /* Append (or replace) the tag on a link. Relative links stay
     relative — the site's own links never suddenly become absolute
     because they were tagged. */
  function link(url, t) {
    var href = String(url == null ? '' : url);
    if (!href) return href;
    var clean = sanitize(t);
    try {
      var abs = new URL(href, window.location.href);
      if (clean) abs.searchParams.set(PARAM, clean);
      else abs.searchParams.delete(PARAM);
      var out = abs.toString();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(href) && abs.origin === window.location.origin) {
        return out.replace(abs.origin, '');
      }
      return out;
    } catch (e) {
      return href;   // never hand a caller a broken link
    }
  }

  /* A tag for an outbound share link: pass the channel being created
     ('student-share', 'ambassador-ayo'). An invalid value yields '',
     so the caller can still share — just without a tag. */
  function share(t) { return sanitize(t); }

  var api = {
    PARAM:    PARAM,
    TTL_DAYS: TTL_DAYS,
    sanitize: sanitize,
    read:     read,
    tag:      tag,
    remember: remember,
    link:     link,
    share:    share
  };

  /* Capture on load — a plain <script> tag is the whole setup. */
  if (typeof window !== 'undefined' && window.location) {
    try { remember(); } catch (e) {}
  }

  return api;
})();

if (typeof window !== 'undefined') window.ArzuzRef = ArzuzRef;
