/* ============================================================
   Arzuz — how much of a listing's page there is, and how recently it moved

   TWO places size a room with these numbers, and they must agree:

     * netlify/functions/listings-sitemap.js — the <changefreq> and
       <priority> the listings sitemap publishes for a room.
     * assets/admin.js — the dashboard's Crawl column and the breakdown
       in a listing's details, which exist to answer the owner's
       question: why is my room being checked rarely, and what is
       missing from it?

   If the dashboard did its own arithmetic the owner would be shown one
   number while the crawler acted on another, and the difference would
   be invisible on both sides. So the score lives here, once.

   WHAT THE SCORE IS

     completeness — of the six things a student decides with: a rent, a
       photo, a map pin, what the property is, how much of it there is,
       and a description. Each is optional in the payload, which is what
       makes them a measure of completeness rather than a restatement of
       every row. property_name and area are deliberately NOT counted:
       every listing has them, so they would raise the floor without
       separating any two rooms.

     freshness — 1 for a room edited today, falling to 0 a year on,
       judged on the edit stamp the sitemap reports as lastmod.

       Completeness is 0.6 of the score and freshness 0.4. One score,
       two hints taken off it, so the two can never drift apart. The
       bands are the four changefreq values the protocol allows, and
       priority keeps the 0.3–0.9 range sitemaps actually use instead of
       the 0.0–1.0 book range, in one decimal place.

   A HINT IS NOT A PROMISE. changefreq is read as "how often is this
   likely to change" and Google overrides it with what it actually sees,
   so the aim is not to game it but to stop lying with it: a sparse page
   nobody has touched is not weekly, and a complete page edited this
   week is not yearly.

   Loads as window.ArzuzListingScore in a browser and via require() in
   Node (the same UMD wrapper as assets/indexnow.js).
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzListingScore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  var DAY_MS = 86400000;
  var FRESHNESS_WINDOW_DAYS = 365;   // nothing older than a year counts as fresh
  var WEIGHT_COMPLETENESS = 0.6;
  var WEIGHT_FRESHNESS = 0.4;

  function nonEmpty(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
  }

  /* A pin needs both halves and both numbers: a latitude with no
     longitude is not a place, and a coordinate that will not parse is
     not a pin. */
  function hasPin(row) {
    return nonEmpty(row.latitude) && nonEmpty(row.longitude) &&
      isFinite(Number(row.latitude)) && isFinite(Number(row.longitude));
  }

  function payloadOf(row) {
    var p = row && row.payload;
    if (p && typeof p === 'object') return p;
    if (typeof p === 'string' && p.trim()) {
      try {
        var parsed = JSON.parse(p);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) { return {}; }
    }
    return {};
  }

  /* ONE fact, THREE shapes.

     A listing is stored once and read in three places, and they do not
     carry the same columns:

       · the base `listings` table — the dashboard reads this
       · the `public_listings` view — the sitemap and the room page read this
       · a DRAFT, or the form a landlord is still typing into — nothing but
         the payload and a couple of stamps (supabase-drafts-support.sql's
         listing_draft_get returns exactly id, status, the dates and the
         payload)

     Two of those have the generated columns, which hardening.sql derives
     FROM the payload — so they always agree with it. The third has only the
     payload, which is why every signal below reads its column first and
     falls back to the same key the landlord form writes. The keys are not
     invented here: they are the ones the form in assets/complete-listing.js
     already stores and the room page already reads.

     This is what lets a room's score be shown BEFORE it is live — the
     invite-link page — without a second implementation of the six facts. */
  function fact(row, column, keys) {
    if (nonEmpty(row && row[column])) return row[column];
    var p = payloadOf(row);
    for (var i = 0; i < keys.length; i++) {
      if (nonEmpty(p[keys[i]])) return p[keys[i]];
    }
    return '';
  }

  /* The pin is the one fact stored in two different shapes: the columns are
     numbers, and the form writes `lat`/`lng` as strings (with `pin` as the
     display copy, "lat,lng"). Both are read the same way here. */
  function pinFrom(row) {
    if (hasPin(row)) return true;
    var p = payloadOf(row);
    return hasPin({ latitude: p.lat, longitude: p.lng });
  }

  /* Whether the room has a description.

     The view answers this itself — has_description, one boolean rather
     than a paragraph per row (supabase-public-view.sql) — and that
     answer wins when it is there, because it is computed from the same
     payload. The DASHBOARD reads the base listings table, which has no
     such column, so for those rows the payload is read directly: the
     same two keys in the same order the page and the view use
     (desc, then description). */
  function hasDescription(row) {
    if (row && typeof row.has_description === 'boolean') return row.has_description;
    var p = payloadOf(row);
    return nonEmpty(p.desc) || nonEmpty(p.description);
  }

  /* The edit stamp, or the creation date where there is no edit stamp.
     One place, so the freshness band and the date the sitemap prints as
     lastmod can never disagree about which day they are judging. */
  function stampOf(row) {
    return (row && (row.updated_at || row.created_at)) || '';
  }

  /* The six signals, each carrying the sentence the dashboard shows
     when it is missing — "what to fill in" is a list of those labels. */
  var SIGNALS = [
    { field: 'listed_price_ngn', label: 'the rent',
      has: function (row) { return Number(fact(row, 'listed_price_ngn', ['rent'])) > 0; } },
    { field: 'photo_url', label: 'a photo',
      has: function (row) { return nonEmpty(fact(row, 'photo_url', ['photo'])); } },
    { field: 'pin', label: 'a map pin',
      has: pinFrom },
    { field: 'property_type', label: 'what the property is',
      has: function (row) { return nonEmpty(fact(row, 'property_type', ['ty'])); } },
    { field: 'rooms', label: 'how much of it there is',
      has: function (row) { return nonEmpty(fact(row, 'rooms', ['rm', 'units'])); } },
    { field: 'has_description', label: 'a description',
      has: hasDescription }
  ];

  function completeness(row) {
    var found = 0;
    for (var i = 0; i < SIGNALS.length; i++) if (SIGNALS[i].has(row)) found++;
    return found / SIGNALS.length;
  }

  /* 1 for a room edited today, falling to 0 a year on. A row with an
     unparseable date is not fresh — there is nothing honest to claim. */
  function freshness(row, now) {
    var d = new Date(stampOf(row));
    if (isNaN(d.getTime())) return 0;
    var days = Math.max(0, ((now || Date.now()) - d.getTime()) / DAY_MS);
    return Math.max(0, Math.min(1, 1 - days / FRESHNESS_WINDOW_DAYS));
  }

  /* What this room is missing, as the sentences the dashboard prints.
     Empty means there is nothing left to fill in. */
  function missing(row) {
    var out = [];
    for (var i = 0; i < SIGNALS.length; i++) {
      if (!SIGNALS[i].has(row)) out.push(SIGNALS[i].label);
    }
    return out;
  }

  /* The bands a room's usefulness tends to move through: a complete page
     edited this week is worth re-checking often; a sparse page nobody
     has touched is worth re-checking rarely. */
  function signals(row, now) {
    var score = WEIGHT_COMPLETENESS * completeness(row) +
                WEIGHT_FRESHNESS * freshness(row, now);
    var changefreq =
      score >= 0.80 ? 'daily' :
      score >= 0.55 ? 'weekly' :
      score >= 0.35 ? 'monthly' : 'yearly';
    var priority = Math.min(0.9, Math.max(0.3, 0.3 + 0.6 * score));
    return { score: score, changefreq: changefreq, priority: priority.toFixed(1) };
  }

  return {
    VERSION: VERSION,
    DAY_MS: DAY_MS,
    FRESHNESS_WINDOW_DAYS: FRESHNESS_WINDOW_DAYS,
    WEIGHT_COMPLETENESS: WEIGHT_COMPLETENESS,
    WEIGHT_FRESHNESS: WEIGHT_FRESHNESS,
    SIGNALS: SIGNALS,
    nonEmpty: nonEmpty,
    fact: fact,
    hasPin: hasPin,
    pinFrom: pinFrom,
    hasDescription: hasDescription,
    stampOf: stampOf,
    completeness: completeness,
    freshness: freshness,
    missing: missing,
    signals: signals
  };
});
