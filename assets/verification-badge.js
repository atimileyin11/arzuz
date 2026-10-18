/* ============================================================
   Arzuz — the public badge, and the words behind it

   Stage 3 of the verification layer says a listing has EVIDENCE from
   the visit, and that the badge names exactly what was checked. This
   module is the one place that turns (tier, evidence rows, now) into
   the sentence a student reads. The browse card, the server-rendered
   room page and listing.html's own repaint all call it, so a card and
   the room it opens cannot disagree about what was checked.

   WHAT IT DOES NOT DO

     · It does not decide whether a visit was GOOD — that is the
       officer's judgement, recorded as the check itself. This module
       only reports what was recorded.
     · It does not render markup. The three surfaces have different
       DOM, different CSS and different escaping needs; they share the
       FACTS and the WORDS, not the tags.
     · It does not own the vocabulary's storage. The kinds are a CHECK
       constraint in supabase-verification-evidence.sql; the labels
       below are the only copy of the human wording. The two lists
       cannot drift apart silently: scripts/test-verification-badge.mjs
       reads the SQL file and fails when a kind exists in one and not
       the other.

   THE HONESTY RULES, which are the reason this is a module and not a
   label on a row:

     1. "Inspected" is only printed when there is evidence and none of
        it has expired. Fresh evidence is what the word means.
     2. Evidence expires (180 days, written by the database). The
        moment it does, the badge says "Re-check due" and the date of
        the last visit — it does not quietly keep the old word.
     3. A tier-2 listing from before this layer has no evidence rows.
        The badge says so out loud, rather than inventing checks or
        pretending the visit never happened.
     4. A visit is ONE group of checks (visit_id). A re-visit adds a
        new group; the badge reads the newest, never a mixture of two
        visits that would make one perfect inspection out of two
        partial ones.
     5. Evidence dated in the future is not evidence yet. A row more
        than a day ahead (clock skew, a bad import) is ignored rather
        than counted as fresh.

   Loads as window.ArzuzBadge in a browser and via require() in Node —
   the same UMD shape as listing-url.js.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ArzuzBadge = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* 180 days. The database writes expires_at; this number is here for
     the tests and for any surface that wants to explain the rule in
     words ("we go back every six months"). It is NOT used to compute
     a badge: the stored expiry is the authority, so a policy change
     is one migration rather than a client release. */
  var EVIDENCE_DAYS = 180;

  /* The vocabulary, in the order a badge reads. `kind` must match the
     CHECK constraint in supabase-verification-evidence.sql exactly. */
  var KINDS = [
    { kind: 'water',    label: 'Water pressure at the tap',   short: 'Water' },
    { kind: 'power',    label: 'Power supply and meter',      short: 'Power' },
    { kind: 'photos',   label: 'Photos match the room',       short: 'Photos' },
    { kind: 'price',    label: 'Owner confirmed the price',   short: 'Price' },
    { kind: 'access',   label: 'The way in, and flooding',    short: 'Access' },
    { kind: 'security', label: 'Gate and security',           short: 'Security' }
  ];

  var SHORT = {};
  for (var s = 0; s < KINDS.length; s++) SHORT[KINDS[s].kind] = KINDS[s].short;

  var LABEL = {};
  for (var i = 0; i < KINDS.length; i++) LABEL[KINDS[i].kind] = KINDS[i].label;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* UTC on purpose: the same ISO string must print the same day in a
     test, in Lagos and in a browser in London. A badge that moves a
     day across time zones is a badge two people can quote differently. */
  function day(value) {
    if (!value) return '';
    var d = value instanceof Date ? value : new Date(String(value));
    var ms = d.getTime();
    if (!isFinite(ms)) return '';
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function ms(value) {
    var t = value instanceof Date ? value.getTime() : new Date(String(value || '')).getTime();
    return isFinite(t) ? t : null;
  }

  function listWords(items) {
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /* The newest visit whose rows are usable, as one group. Rows without
     a visit_id are grouped by the instant they claim — an older export
     shape should still read as one visit rather than as eight. */
  function newestVisit(rows, nowMs) {
    var usable = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r || !LABEL[r.kind]) continue;
      var checked = ms(r.checked_at);
      if (checked === null || checked > nowMs + 24 * 3600 * 1000) continue;
      var expires = ms(r.expires_at);
      if (expires === null || expires <= checked) continue;
      usable.push(r);
    }
    if (!usable.length) return null;

    var groups = {};
    var order = [];
    for (var j = 0; j < usable.length; j++) {
      var row = usable[j];
      var key = row.visit_id ? String(row.visit_id) : 'at:' + String(row.checked_at);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(row);
    }

    var best = null;
    for (var k = 0; k < order.length; k++) {
      var group = groups[order[k]];
      var checkedAt = 0;
      for (var g = 0; g < group.length; g++) checkedAt = Math.max(checkedAt, ms(group[g].checked_at));
      if (!best || checkedAt > best.checkedAt) {
        best = { rows: group, checkedAt: checkedAt };
      }
    }
    if (!best) return null;

    /* The visit is current only while EVERY check in it is current, so
       the group expires at its earliest expiry — not the latest. */
    var expiresAt = Infinity;
    var parts = [];
    var seen = {};
    for (var c = 0; c < KINDS.length; c++) {
      var kind = KINDS[c].kind;
      var found = null;
      for (var m = 0; m < best.rows.length; m++) {
        if (best.rows[m].kind === kind) { found = best.rows[m]; break; }
      }
      if (!found) continue;
      var exp = ms(found.expires_at);
      if (exp < expiresAt) expiresAt = exp;
      if (seen[kind]) continue;
      seen[kind] = true;
      parts.push({
        kind: kind,
        label: LABEL[kind],
        short: SHORT[kind],
        detail: found.detail ? String(found.detail) : ''
      });
    }

    return {
      parts: parts,
      checkedAt: best.checkedAt,
      expiresAt: expiresAt,
      checked_at: new Date(best.checkedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString()
    };
  }

  /* tier + rows + now → everything a surface needs to print the truth.
     `rows` may be null, meaning "the evidence was not read" (a surface
     whose second query failed) — that is deliberately different from
     [] ("read, and there is none"), because only the second may claim
     that no record exists. */
  function summarise(tier, rows, now) {
    var t = Number(tier);
    if (!isFinite(t)) t = 0;
    var nowMs = (now instanceof Date ? now.getTime() : (now === undefined || now === null ? Date.now() : Number(now)));
    if (!isFinite(nowMs)) nowMs = Date.now();

    var cls = 'b0';
    var label = 'Unverified';
    var note = 'The owner listed it. We have not been to the room.';

    if (t >= 1) {
      cls = 'b1';
      label = 'Community verified';
      note = 'A tenant in the building confirmed the price. That is not a visit.';
    }

    var out = {
      VERSION: VERSION,
      tier: t,
      cls: cls,
      label: label,
      note: note,
      hasEvidence: false,
      expired: false,
      checked_at: null,
      expires_at: null,
      parts: [],
      sentence: note,
      headline: ''
    };

    if (t < 2) return out;

    /* A tier-2 listing: "Inspected" is a claim that needs parts. */
    out.cls = 'b2';
    out.label = 'Inspected';

    if (rows === null || rows === undefined) {
      out.note = 'Inspected. We could not read the record of what was checked just now.';
      out.sentence = out.note;
      return out;
    }

    /* No usable visit at all. Two ways to get here and the badge says
       the same true thing about both: the listing was tier 2 before
       this layer existed (no rows), or every row was unusable (a
       future-dated or malformed import). Neither is a visit that has
       EXPIRED — an expired visit is a visit, and it is read above,
       with its parts and its date — so this is not the place for
       "Re-check due". */
    var visit = newestVisit(rows, nowMs);
    if (!visit) {
      out.note = 'Inspected, but no record of what was checked is on file — this visit predates our evidence log.';
      out.sentence = out.note;
      return out;
    }

    out.hasEvidence = true;
    out.checked_at = visit.checked_at;
    out.expires_at = visit.expires_at;
    out.parts = visit.parts;
    out.expired = visit.expiresAt <= nowMs;
    out.label = out.expired ? 'Re-check due' : 'Inspected';

    var names = visit.parts.map(function (p) { return p.label; });
    if (out.expired) {
      out.note = 'Last recorded visit: ' + names.length + (names.length === 1 ? ' check' : ' checks') +
        ' on ' + day(visit.checked_at) + '. The six-month record has run out.';
      out.sentence = 'Last inspected ' + day(visit.checked_at) +
        ' (' + listWords(names) + ') — the record has expired, so a re-check is due.';
    } else {
      out.note = 'Checked on the visit of ' + day(visit.checked_at) +
        ', current until ' + day(visit.expires_at) + '.';
      out.sentence = listWords(names) + ' — checked ' + day(visit.checked_at) +
        ', current until ' + day(visit.expires_at) + '.';
    }
    return out;
  }

  /* The full line under a badge, for a page that has room for it. */
  function detailLines(info) {
    if (!info) return [];
    if (info.hasEvidence) {
      var out = info.parts.map(function (p) {
        return { label: p.label, detail: p.detail, checked_at: info.checked_at, expires_at: info.expires_at };
      });
      return out;
    }
    return [];
  }

  return {
    VERSION: VERSION,
    EVIDENCE_DAYS: EVIDENCE_DAYS,
    KINDS: KINDS,
    LABEL: LABEL,
    SHORT: SHORT,
    day: day,
    newestVisit: newestVisit,
    summarise: summarise,
    detailLines: detailLines
  };
});
