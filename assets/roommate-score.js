/* ============================================================
   Arzuz — roommate compatibility engine

   ONE source of truth for the roommate vocabulary and the match
   score. Three places depend on it agreeing with itself:

     * netlify/functions/roommate-match.js — computes the score
       server-side, because a candidate's answers must never be
       sent to another student's browser.
     * roommates.html — reads QUESTIONS/WANTS to build the
       two-sided questionnaire, so the form can never offer an
       answer the scorer does not understand.
     * scripts/test-roommate-score.mjs — the unit tests.

   Loads as window.ArzuzMatch in a browser and via require() in Node.

   THE MODEL — why it is shaped this way

   Every option list below is ORDERED where the order carries
   meaning. The scorer reads the POSITION of an answer, never the
   label, so "Before 10pm → After midnight" is a distance of 2, not
   a string comparison. That is what lets two night owls score 100%
   while two students at opposite ends score 0%.

   * Deal-breakers are absolute. A student who ticks "Smoking"
     is never shown a smoker, at any percentage.
   * Soft preferences raise a category's WEIGHT rather than
     faking a hard filter — "similar to mine" on sleep makes sleep
     count for more, it does not make a mismatch impossible.
   * Both sides are scored. A pair scores on how well they suit
     each other, not on how well one of them suits the other, so
     a one-sided preference cannot inflate a pair.
   * Missing answers are EXCLUDED, never zeroed. An incomplete
     profile is not a bad match; it is an unknown one, and it is
     only shown when enough of the picture is actually known
     (MIN_COVERAGE).
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------
     PART A — my profile. Ordered answer lists only.
     ------------------------------------------------------------ */
  var PROFILE = {
    gender: { label: 'You are', options: ['Female', 'Male'], short: 'Gender' },

    sleep:  { label: 'When do you usually go to bed?',
              options: ['Before 10pm', '10pm \u2013 12am', 'After midnight'], short: 'Sleep', cat: 'schedule' },
    wake:   { label: 'When do you usually wake up?',
              options: ['Before 6am', '6 \u2013 8am', 'After 9am'], short: 'Wake', cat: 'schedule' },

    clean:  { label: 'How often do you clean your space?',
              options: ['As needed', 'Weekly', 'Daily'], short: 'Cleaning', cat: 'cleanliness' },

    guests: { label: 'How often do you bring guests over?',
              options: ['Rarely', 'Some weekends', 'Most days'], short: 'Guests', cat: 'guests' },

    smoke:  { label: 'Do you smoke?',
              options: ['Non-smoker', 'Smoker (outside only)', 'Smoker'], short: 'Smoking', cat: 'smoking' },

    noise:  { label: 'Your usual noise level',
              options: ['Quiet', 'Balanced', 'Lively'], short: 'Noise', cat: 'noise' },

    /* numeric, handled outside the distance model */
    budget: { label: 'Your share of the rent, per session (\u20A6)', kind: 'number', short: 'Budget', cat: 'budget' },

    /* not orderable: two people who both need covering is a
       genuine conflict, one needing it is a real but survivable gap */
    split:  { label: 'How should the split work?',
              options: ['I can pay my half', 'I need help covering my half'], short: 'Split', cat: 'budget' }
  };

  /* ------------------------------------------------------------
     PART B — ideal roommate and deal-breakers.
     ------------------------------------------------------------ */
  var WANTS = {
    want_sleep:  { label: 'Sleep schedule', options: ['Similar to mine', 'Any'], short: 'Sleep' },
    want_clean:  { label: 'Cleanliness',    options: ['Similar to mine', 'Any'], short: 'Cleaning' },
    want_guests: { label: 'Guest habits',   options: ['Similar to mine', 'Any'], short: 'Guests' },
    want_noise:  { label: 'Noise level',    options: ['Similar to mine', 'Any'], short: 'Noise' },
    want_budget: { label: 'Budget',         options: ['Similar to mine', 'Any'], short: 'Budget' },
    want_split:  { label: 'Rent split',     options: ['Equal split only', 'Flexible'], short: 'Split' },
    want_gender: { label: 'Who should we show you?',
                   options: ['Same gender as me', 'Any gender'], short: 'Gender' },

    dealbreakers: {
      label: 'Never show me someone who \u2026',
      kind: 'multi',
      options: ['Smoking', 'Frequent guests', 'Low cleanliness', 'Very different sleep', 'Loud noise'],
      short: 'Deal-breakers'
    }
  };

  /* ------------------------------------------------------------
     CATEGORIES — the weighted model.

     weight is the category's pull on the percentage. A student
     answering "similar to mine" on that category's preference adds
     WANT_BOOST on top, so what they said they care about counts
     for more than what they did not mention.
     ------------------------------------------------------------ */
  var WANT_BOOST = 2;

  var CATEGORIES = [
    { key: 'schedule',    weight: 3, fields: ['sleep', 'wake'], want: 'want_sleep',  phrase: 'sleep schedule' },
    { key: 'cleanliness', weight: 3, fields: ['clean'],         want: 'want_clean',  phrase: 'cleaning habits' },
    { key: 'guests',      weight: 2, fields: ['guests'],        want: 'want_guests', phrase: 'guest habits' },
    { key: 'smoking',     weight: 2, fields: ['smoke'],         want: null,          phrase: 'smoking' },
    { key: 'noise',       weight: 2, fields: ['noise'],         want: 'want_noise',  phrase: 'noise level' },
    { key: 'budget',      weight: 2, fields: ['budget', 'split'], want: 'want_budget', phrase: 'budget' }
  ];

  /* Below this share of the possible weight, a pair has too many
     blanks to call a match. 0.5 = at least half the picture known. */
  var MIN_COVERAGE = 0.5;

  /* ------------------------------------------------------------
     DEAL-BREAKERS — absolute. A tie on one of these is not a low
     score, it is no match, and the pair is never shown.

     pair: true means the rule needs both answers (a distance),
     so it cannot be tested against the candidate alone.
     ------------------------------------------------------------ */
  var DEALBREAKERS = {
    'Smoking': {
      field: 'smoke', label: 'Smoking',
      test: function (v) { return v !== 'Non-smoker'; },
      why: 'they smoke'
    },
    'Frequent guests': {
      field: 'guests', label: 'Frequent guests',
      test: function (v) { return v === 'Most days'; },
      why: 'they have guests over most days'
    },
    'Low cleanliness': {
      field: 'clean', label: 'Low cleanliness',
      test: function (v) { return v === 'As needed'; },
      why: 'they clean only as needed'
    },
    'Loud noise': {
      field: 'noise', label: 'Loud noise',
      test: function (v) { return v === 'Lively'; },
      why: 'they are loud at home'
    },
    'Very different sleep': {
      pair: true, label: 'Very different sleep',
      test: function (mine, theirs) {
        /* distance 1 IS the opposite ends of the scale — the whole
           point of the ordered options. A pair rule reads the answer
           off each profile; the single-answer rules get the value
           handed to them by breached() instead. */
        var d = distance('sleep', (mine || {}).sleep, (theirs || {}).sleep);
        return d !== null && d >= 0.999;
      },
      why: 'your sleep schedules are at opposite ends'
    }
  };

  /* ------------------------------------------------------------
     helpers
     ------------------------------------------------------------ */

  function isSet(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* Deal-breakers arrive from a checkbox group, so they can be an
     array, a single string, or (from an older row) a comma list.
     All three must be understood. */
  function list(v) {
    if (!isSet(v)) return [];
    if (Array.isArray(v)) return v.filter(isSet).map(function (x) { return String(x).trim(); });
    return String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function optionsFor(key) {
    var def = PROFILE[key] || WANTS[key];
    return def && def.options ? def.options : null;
  }

  /* Positional distance, 0 (identical) → 1 (opposite ends).
     null when either side is missing or the answer is not on the
     list — unknown, which is not the same as zero. */
  function distance(key, mine, theirs) {
    if (!isSet(mine) || !isSet(theirs)) return null;
    var opts = optionsFor(key);
    if (!opts) return null;
    var i = opts.indexOf(String(mine));
    var j = opts.indexOf(String(theirs));
    if (i < 0 || j < 0) return null;
    var span = opts.length - 1;
    if (span <= 0) return i === j ? 0 : 1;
    return Math.abs(i - j) / span;
  }

  /* 1 = same answer, 0 = opposite ends. */
  function fieldScore(key, mine, theirs) {
    var d = distance(key, mine, theirs);
    return d === null ? null : 1 - d;
  }

  /* Two people who both need their half covered cannot split a room;
     one of them needing it means the other carries more. */
  function splitScore(me, them) {
    me = me || {}; them = them || {};
    if (!isSet(me.split) || !isSet(them.split)) return null;
    var meHelp = me.split === 'I need help covering my half';
    var themHelp = them.split === 'I need help covering my half';
    if (meHelp && themHelp) return 0;
    if (meHelp !== themHelp) return 0.5;
    return 1;
  }

  function budgetScore(me, them) {
    me = me || {}; them = them || {};
    var a = num(me.budget), b = num(them.budget);
    var parts = [];
    if (a !== null && b !== null && a > 0 && b > 0) {
      parts.push({ w: 2, s: 1 - Math.min(1, Math.abs(a - b) / Math.max(a, b)) });
    }
    var sp = splitScore(me, them);
    if (sp !== null) parts.push({ w: 1, s: sp });
    if (!parts.length) return null;
    var total = 0, weight = 0;
    parts.forEach(function (p) { total += p.w * p.s; weight += p.w; });
    return total / weight;
  }

  /* One side's view of the other: what this person's own answers
     say about living with that person. */
  function directional(me, them) {
    var total = 0, got = 0, possible = 0, cats = [], unknown = [];

    CATEGORIES.forEach(function (c) {
      var s;
      if (c.key === 'budget') {
        s = budgetScore(me, them);
      } else {
        var vals = c.fields.map(function (f) { return fieldScore(f, me[f], them[f]); })
                           .filter(function (x) { return x !== null; });
        s = vals.length ? vals.reduce(function (x, y) { return x + y; }, 0) / vals.length : null;
      }

      var weight = c.weight + ((c.want && me[c.want] === 'Similar to mine') ? WANT_BOOST : 0);
      possible += weight;
      cats.push({ key: c.key, phrase: c.phrase, weight: weight, score: s });

      if (s === null) { unknown.push(c.phrase); return; }
      total += weight * s;
      got += weight;
    });

    /* A stated "equal split only" is a real requirement, so it is a
       penalty rather than a silent pass. */
    if (me.want_split === 'Equal split only') {
      var penalty = 0;
      if (!isSet(them.split)) penalty = 0.5;
      else if (them.split === 'I need help covering my half') penalty = 1;
      if (penalty) {
        total = total * (1 - penalty * 0.5);
        cats.push({ key: 'split_penalty', phrase: 'rent split', weight: 0, score: 1 - penalty });
      }
    }

    return { pct: got > 0 ? total / got : 0, coverage: possible > 0 ? got / possible : 0, cats: cats, unknown: unknown };
  }

  /* Which deal-breaker, if any, this person's list trips on that
     person. Returns the rule hit, or null. */
  function breached(me, them) {
    var wanted = list(me && me.dealbreakers);
    for (var i = 0; i < wanted.length; i++) {
      var rule = DEALBREAKERS[wanted[i]];
      if (!rule) continue;
      if (rule.pair) {
        if (rule.test(me, them)) return rule;
      } else if (isSet(them && them[rule.field]) && rule.test(them[rule.field])) {
        return rule;
      }
    }
    return null;
  }

  /* Same-gender by default: a missing preference is treated as
     same-gender, and unknown gender never filters (a blank field
     must not silently hide the whole pool). */
  function genderOk(me, them) {
    if (me && me.want_gender === 'Any gender') return true;
    if (!isSet(me && me.gender) || !isSet(them && them.gender)) return true;
    return me.gender === them.gender;
  }

  function verdictFor(pct) {
    if (pct >= 85) return 'Excellent match';
    if (pct >= 70) return 'Good match';
    if (pct >= 55) return 'Workable match';
    return 'Low match';
  }

  /* Readable reasons, best news first. Capped so a card stays a card. */
  function reasonsFor(a, b) {
    var merged = {}, order = [];
    [a, b].forEach(function (dir) {
      (dir.cats || []).forEach(function (c) {
        if (c.score === null || c.weight === 0) return;
        if (!(c.key in merged)) { merged[c.key] = { phrase: c.phrase, score: c.score }; order.push(c.key); }
        else merged[c.key].score = (merged[c.key].score + c.score) / 2;
      });
    });

    var good = [], bad = [];
    order.forEach(function (k) {
      var m = merged[k];
      var text;
      if (m.score >= 0.995) text = 'Same ' + m.phrase;
      else if (m.score >= 0.7) text = 'Similar ' + m.phrase;
      else if (m.score < 0.35) text = 'Different ' + m.phrase;
      else return;
      (m.score < 0.35 ? bad : good).push({ ok: m.score >= 0.35, text: text });
    });

    return good.concat(bad).slice(0, 4);
  }

  /* ------------------------------------------------------------
     score(me, them) → the whole judgement for one pair.

     { pct, pass, verdict, dealbreaker, coverage, reasons, categories }
     ------------------------------------------------------------ */
  function score(me, them) {
    me = me || {}; them = them || {};

    if (!genderOk(me, them)) {
      return {
        pct: 0, pass: false, verdict: 'Filtered out', dealbreaker: null,
        coverage: 1, reason: 'Not the gender you asked to be shown', reasons: [], categories: []
      };
    }

    /* Either side's list can veto the pair. */
    var mine = breached(me, them);
    var yours = breached(them, me);
    var hit = mine || yours;
    if (hit) {
      return {
        pct: 0, pass: false, verdict: 'Deal-breaker', dealbreaker: hit.label,
        coverage: 1,
        reason: (mine ? 'Your deal-breaker: ' : 'Their deal-breaker: ') + hit.why,
        reasons: [{ ok: false, text: 'Deal-breaker: ' + hit.label.toLowerCase() }],
        categories: []
      };
    }

    var a = directional(me, them);
    var b = directional(them, me);
    var coverage = (a.coverage + b.coverage) / 2;
    var pct = Math.round(50 * (a.pct + b.pct));

    return {
      pct: pct,
      pass: coverage >= MIN_COVERAGE,
      verdict: verdictFor(pct),
      dealbreaker: null,
      coverage: Math.round(coverage * 100) / 100,
      reason: coverage >= MIN_COVERAGE ? '' : 'Not enough answers shared yet',
      reasons: reasonsFor(a, b),
      categories: a.cats.concat(b.cats)
    };
  }

  /* Convenience for callers that only need "may I show this pair?" */
  function eligible(me, them) {
    var r = score(me, them);
    return r.pass && r.dealbreaker === null;
  }

  return {
    VERSION: VERSION,
    PROFILE: PROFILE,
    WANTS: WANTS,
    CATEGORIES: CATEGORIES,
    DEALBREAKERS: DEALBREAKERS,
    WANT_BOOST: WANT_BOOST,
    MIN_COVERAGE: MIN_COVERAGE,
    score: score,
    eligible: eligible,
    distance: distance,
    fieldScore: fieldScore,
    splitScore: splitScore,
    list: list,
    optionsFor: optionsFor,
    verdictFor: verdictFor
  };
});
