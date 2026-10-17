/* ============================================================
   Arzuz Admin — strategy pack + growth (marketing) view
   Plain ES5, no dependencies. Loaded by admin.html before
   admin.js; the hash router calls into it for the `growth`
   and `strategy` sections.

   Two pieces:

   1. GROWTH — the traction dashboard the marketing role lands
      on. Every number is computed from rows the dashboard
      already fetched (demand_records, listings, scout
      submissions, booking_requests, roommate_match_summary).
      Nothing decorative: the "what to do next" list is driven
      by real gaps in the data, per strategy doc 07.

   2. STRATEGY — an in-dashboard reader for the strategy pack
      (strategy/*.md). The markdown is NOT public: it is served
      by the /strategy-docs Netlify function only to a valid
      Supabase Auth session, so this fetches with the signed-in
      token. Marketing accounts see the marketing docs first;
      admins see the index first. /strategy/* on the public
      site 404s (netlify.toml).
   ============================================================ */

(function () {
  'use strict';

  /* ================= helpers ================= */

  /* The site-wide failure vocabulary (assets/api-errors.js), if this
     page loaded it. */
  function E(){ return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }

  /* A failed request, carrying its CLASS — read from the function's own
     answer, never re-derived from the number — so the pane can tell a
     deploy that has not shipped the document from a session to renew.
     `said` is the words for a person when this call has better ones than
     the class does; the server's sentence is used when it does not. */
  function fail(res, body, said){
    var W = E();
    if (W){
      var err = W.failed(res, body, { audience: 'operator' });
      if (said) err.message = said;
      return err;
    }
    /* No classifier: the function's own sentence is still read out of
       its body, and `said` still wins when this pane has better words. */
    var own = '';
    if (body !== undefined && body !== null) {
      try { own = (typeof body === 'string' ? JSON.parse(body) : body).error || ''; } catch (e) { own = ''; }
    }
    var err2 = new Error(said || own || 'Arzuz could not load that just now — that is our side, not yours. ' +
      'Try again in a minute.');
    err2.status = (res && res.status) || 0;
    return err2;
  }

  /* The words for something that is not an HTTP answer at all — a fetch
     that rejected, a response with no status. */
  function word(err){
    var W = E();
    return W ? W.sentence(err, { audience: 'operator' })
      : 'We could not reach Arzuz — check your connection and try again.';
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }

  function payloadOf(row) { return (row && row.payload) || {}; }

  function currentRole() {
    return (window.ArzuzAuth && ArzuzAuth.role) ? ArzuzAuth.role() : 'admin';
  }

  /* ================= the pack ================= */
  /* group 'first' = marketing priority (docs 05/06/07 + index),
     'more' = the rest of the pack. Marketing accounts get both
     groups — prioritised, not hidden. */

  var DOCS = [
    { name: 'README.md',                               icon: '🗂', title: 'Strategy index',    group: 'first', blurb: 'All seven frameworks and the order to run them in.' },
    { name: '05-positioning-stp.md',                   icon: '🎯', title: 'Positioning — STP', group: 'first', blurb: 'Which segment first, and the sentence that wins it.' },
    { name: '06-channels-bullseye.md',                 icon: '📣', title: 'Channels — Bullseye', group: 'first', blurb: 'Where the next 100 students and 10 buildings come from.' },
    { name: '07-unit-economics-ltv-cac.md',            icon: '📈', title: 'Growth model — funnel, LTV:CAC, churn', group: 'first', blurb: 'Does it survive scale; where users fall out.' },
    { name: '01-market-sizing-tam-sam-som.md',         icon: '🌍', title: 'Market sizing — TAM/SAM/SOM', group: 'more', blurb: 'Is the market big enough — and is our slice winnable?' },
    { name: '02-customer-icp-jtbd-journey.md',         icon: '🧭', title: 'Customer — ICP, JTBD, journey', group: 'more', blurb: 'Who we build for and which touchpoint is broken.' },
    { name: '03-competition-porters-five-forces.md',   icon: '⚔️', title: 'Competition — Five Forces', group: 'more', blurb: 'Where the power sits and which rival actually matters.' },
    { name: '04-pesteL.md',                            icon: '🌦', title: 'PESTEL',            group: 'more', blurb: 'Inflation, NDPA, 3G reality — and the mitigation for each.' }
  ];

  var DEFAULT_DOC = { admin: 'README.md', marketing: '05-positioning-stp.md' };
  var docCache = {};   // name → markdown (session-scoped, docs are no-store on the wire)

  function docByName(name) {
    for (var i = 0; i < DOCS.length; i++) if (DOCS[i].name === name) return DOCS[i];
    return null;
  }

  /* ================= markdown renderer ================= */
  /* Small, deliberately limited: headings, paragraphs, bold, inline
     code, fenced code, blockquotes, lists, pipe tables, hr, links.
     Everything is HTML-escaped FIRST, then the few allowed tags are
     built — no raw HTML in a doc can reach the DOM. [ESTIMATE]
     placeholders are highlighted so an unverified number is visible
     as such (the strategy README's "no number without a record" rule). */

  function inline(s) {
    return s
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
        u = u.replace(/&amp;/g, '&');
        /* cross-document links open in the in-dashboard reader */
        if (/\.md$/i.test(u) && !/^https?:/i.test(u) && docByName(u)) {
          return '<a href="#/strategy/' + u + '" data-doc="' + esc(u) + '">' + t + '</a>';
        }
        if (/^\.\.\//.test(u)) u = '/' + u.slice(3);
        if (/^https?:\/\//i.test(u) || /^\//.test(u)) {
          return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>';
        }
        return t;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[ESTIMATE\]/g, '<span class="md-estimate">[ESTIMATE]</span>');
  }

  function splitRow(l) {
    return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
  }

  function isTableSep(l) {
    return l.indexOf('|') !== -1 && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  }

  function mdToHtml(src) {
    var lines = String(src).replace(/\r\n/g, '\n').split('\n');
    var html = [], i = 0;

    while (i < lines.length) {
      var l = lines[i];

      if (/^\s*```/.test(l)) {
        i++;
        var buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html.push('<pre class="md-code"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (!l.trim()) { i++; continue; }

      var h = /^(#{1,4})\s+(.*)$/.exec(l);
      if (h) {
        var n = Math.min(h[1].length + 1, 5);
        html.push('<h' + n + ' class="md-h">' + inline(esc(h[2])) + '</h' + n + '>');
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { html.push('<hr class="md-hr">'); i++; continue; }

      if (/^\s*>\s?/.test(l)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html.push('<blockquote class="md-quote">' + inline(esc(q.join(' '))) + '</blockquote>');
        continue;
      }

      if (l.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = splitRow(l), rows = [];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        var t = '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
          head.map(function (c) { return '<th>' + inline(esc(c)) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) {
          t += '<tr>' + head.map(function (_, ci) { return '<td>' + inline(esc(r[ci] || '')) + '</td>'; }).join('') + '</tr>';
        });
        t += '</tbody></table></div>';
        html.push(t);
        continue;
      }

      var ordered = /^\s*\d+\.\s+/.test(l);
      if (ordered || /^\s*[-*]\s+/.test(l)) {
        var items = [], re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
        while (i < lines.length && re.test(lines[i])) {
          var item = lines[i].replace(re, '');
          i++;
          /* A wrapped list item is still ONE item. Without this, the second
             line of every bullet that ran past 80 columns fell out of the
             list and became a stray paragraph — and the docs are written in
             wrapped prose, so that was most of them. A blank line continues
             the item only when the next line is indented (CommonMark's rule);
             a new bullet, heading, quote, table or fence ends it. */
          while (i < lines.length) {
            var cont = lines[i];
            if (!cont.trim()) {
              if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) { i++; continue; }
              break;
            }
            if (/^\s{2,}\S/.test(cont) && !/^\s*```/.test(cont) &&
                !/^\s*\d+\.\s+/.test(cont) && !/^\s*[-*]\s+/.test(cont) &&
                !/^#{1,4}\s/.test(cont) && !/^\s*>\s?/.test(cont) &&
                cont.indexOf('|') === -1) {
              item += ' ' + cont.trim();
              i++;
              continue;
            }
            break;
          }
          items.push(item);
        }
        var tag = ordered ? 'ol' : 'ul';
        html.push('<' + tag + ' class="md-list">' + items.map(function (it) { return '<li>' + inline(esc(it)) + '</li>'; }).join('') + '</' + tag + '>');
        continue;
      }

      var para = [l];
      i++;
      while (i < lines.length && lines[i].trim() &&
             !/^#{1,4}\s/.test(lines[i]) && !/^\s*```/.test(lines[i]) &&
             !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
             !/^\s*>\s?/.test(lines[i]) && lines[i].indexOf('|') === -1) {
        para.push(lines[i]); i++;
      }
      html.push('<p class="md-p">' + inline(esc(para.join(' '))) + '</p>');
    }
    return html.join('\n');
  }

  /* ================= strategy section ================= */

  function renderStrategy(root, docName) {
    if (!root) return;
    var role = currentRole();
    var listHtml = '';
    ['first', 'more'].forEach(function (g) {
      var docs = DOCS.filter(function (d) { return d.group === g; });
      if (!docs.length) return;
      listHtml += '<div class="strategy-group">' +
        '<h4>' + (g === 'first' ? 'Marketing priority' : 'More strategy') + '</h4>' +
        docs.map(function (d) {
          return '<button type="button" class="strategy-doc-btn" data-open="' + esc(d.name) + '">' +
            '<span class="sd-ico">' + d.icon + '</span>' +
            '<span class="sd-tx"><b>' + esc(d.title) + '</b><span>' + esc(d.blurb) + '</span></span>' +
            '</button>';
        }).join('') + '</div>';
    });

    /* resume mode: no explicit doc in the route and a doc already open →
       the re-render came from a data refresh (fetchData() → renderRoute()),
       not navigation — leave the reader exactly where the user was. */
    if (!docName && root.dataset.doc && docByName(root.dataset.doc)) return;

    var start = docName;
    if (!(start && docByName(start))) start = root.dataset.doc;
    if (!(start && docByName(start))) start = DEFAULT_DOC[role] || 'README.md';

    root.innerHTML =
      '<div class="strategy-wrap">' +
        '<aside class="strategy-side">' + listHtml +
          '<p class="strategy-privacy">🔒 These documents are private — served only to signed-in team members. arzuz.com/strategy itself returns 404.</p>' +
        '</aside>' +
        '<article class="strategy-doc" id="strategyDocPane"><div class="strategy-loading">Loading…</div></article>' +
      '</div>';

    loadDoc(root, start);
  }

  function loadDoc(root, name) {
    var pane = root.querySelector('#strategyDocPane');
    if (!pane) return;
    root.dataset.doc = name;

    var meta = docByName(name);
    root.querySelectorAll('.strategy-doc-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-open') === name);
    });
    if (!meta) {
      pane.innerHTML = '<div class="strategy-err">Unknown document.</div>';
      return;
    }

    pane.innerHTML = '<div class="strategy-loading">Loading ' + esc(meta.title) + ' …</div>';

    var paint = function (md) {
      docCache[name] = md;
      pane.innerHTML =
        '<div class="strategy-doc-head"><span class="sd-ico">' + meta.icon + '</span>' +
        '<div><h2>' + esc(meta.title) + '</h2><span class="strategy-file">strategy/' + esc(name) + '</span></div></div>' +
        '<div class="md-body">' + mdToHtml(md) + '</div>';
      pane.scrollTop = 0;
    };

    if (docCache[name]) { paint(docCache[name]); return; }

    ArzuzAuth.headers().then(function (h) {
      return fetch('/strategy-docs?name=' + encodeURIComponent(name), { headers: h });
    }).then(function (r) {
      return r.text().then(function (text) {
        if (r.ok) return text;
        /* The reader's own advice is better than the class's for these
           two, and it is passed IN; the class itself still comes from
           the answer, which is what keeps this pane and the function
           saying the same thing. */
        if (r.status === 401 || r.status === 403) {
          throw fail(r, text, 'Your session has expired — sign in again to read the strategy pack.');
        }
        if (r.status === 404) {
          throw fail(r, text, 'This document is not in the deployment. Run the latest supabase/netlify deploy.');
        }
        throw fail(r, text);
      });
    }).then(paint).catch(function (err) {
      /* A rejected fetch has no status and no sentence of ours — the
         pane printed the browser's own "Failed to fetch" for that. */
      var said = (err && err.status) ? err.message : word(err);
      pane.innerHTML = '<div class="strategy-err"><b>Could not open ' + esc(meta.title) + '.</b><span>' + esc(said) + '</span>' +
        '<span style="margin-top:8px">If you are testing locally, run <code>netlify dev</code> — the docs come from a Netlify function.</span></div>';
    });
  }

  /* a[data-doc] anywhere in the dashboard (cross-links in rendered
     markdown, quick links on the Growth view) deep-links into the
     reader via the hash router; .strategy-doc-btn[data-open] renders
     the doc in place without changing the route. */
  document.addEventListener('click', function (e) {
    var open = e.target.closest ? e.target.closest('.strategy-doc-btn[data-open]') : null;
    if (open) {
      var rootEl = open.closest('[data-section="strategy"]');
      if (rootEl) { loadDoc(rootEl, open.getAttribute('data-open')); return; }
    }
    var a = e.target.closest ? e.target.closest('a[data-doc]') : null;
    if (!a) return;
    e.preventDefault();
    var name = a.getAttribute('data-doc');
    if (docByName(name)) location.hash = '#/strategy/' + name;
  });

  /* ================= growth section ================= */

  function live(rows) {
    return (rows || []).filter(function (r) { return str(r.env) !== 'test'; });
  }

  function metricCard(lbl, num, sub, attention) {
    return '<div class="metric-card' + (attention ? ' attention' : '') + '">' +
      '<div class="metric-lbl">' + esc(lbl) + '</div>' +
      '<div class="metric-num">' + num + '</div>' +
      '<div class="metric-sub">' + sub + '</div></div>';
  }

  function funnelRow(label, n, prev, max) {
    var w = max > 0 ? Math.max(4, Math.round(n / max * 100)) : 0;

    /* A percentage only means something while the step is a subset of the
       one above it. Booking requests are NOT a subset of matches — plenty
       of students book straight from a listing page — and "133% of step
       above" reads like a bug. Above 100%, report the raw difference
       instead, which is both true and useful. */
    var rel = '';
    if (prev !== null && prev > 0) {
      rel = (n <= prev)
        ? ' <i>(' + Math.round(n / prev * 100) + '% of step above)</i>'
        : ' <i>(+' + (n - prev) + ' vs the step above \u2014 a parallel path, not a drop-off)</i>';
    }
    return '<div class="funnel-row"><span class="funnel-lbl">' + esc(label) + '</span>' +
      '<div class="funnel-bar"><div class="funnel-fill" style="width:' + w + '%"></div></div>' +
      '<span class="funnel-num">' + n.toLocaleString('en-NG') + rel + '</span></div>';
  }

  /* ---- the funnel, in ONE place ----
     The Growth page and the Overview funnel card both call these, so a
     change to a step can never make the two disagree — doc 07 asks for
     exactly one funnel. Step 1 is honesty, not data: nothing records an
     impression yet, so it is drawn as a ghost bar rather than a number
     nobody can trace to a record. */

  function funnelModel(ctx) {
    var demands = live(ctx && ctx.demands);
    var bookings = live(ctx && ctx.bookings);
    var won = demands.filter(function (r) {
      var st = str(r.status).toLowerCase();
      return st === 'matched' || st === 'fulfilled';
    });
    var bkDone = bookings.filter(function (r) {
      var st = str(r.status).toLowerCase();
      return st === 'confirmed' || st === 'viewed' || st === 'completed';
    });

    var steps = [
      { label: '1 · See (preview card / flyer / link)', n: 0, prev: null, ghost: true },
      { label: '2 · Register a demand', n: demands.length, prev: null },
      { label: '3 · Matched to a room', n: won.length, prev: demands.length },
      { label: '4 · Booking request', n: bookings.length, prev: won.length },
      { label: '5 · Booked (confirmed+)', n: bkDone.length, prev: bookings.length }
    ];

    /* The bottleneck is the widest percentage fall between two MEASURED
       steps — the one place where fixing something actually moves the
       numbers. A step sitting under an empty one is skipped, never
       reported as a 0% drop. */
    var worst = null;
    steps.forEach(function (s, i) {
      if (s.ghost || i === 0) return;
      var above = steps[i - 1];
      if (!above || above.ghost || above.n <= 0) return;
      var lost = above.n - s.n;
      if (lost <= 0) return;
      var pct = Math.round(lost / above.n * 100);
      if (!worst || pct > worst.pct) worst = { pct: pct, lost: lost, from: shortStep(above.label), to: shortStep(s.label) };
    });

    return {
      steps: steps,
      max: Math.max(demands.length, bookings.length, 1),
      worst: worst
    };
  }

  /* '3 · Matched to a room' reads better as 'Matched to a room' in a
     sentence than in a bar chart. */
  function shortStep(label) { return String(label).replace(/^\d+ · /, ''); }

  function funnelRowsHtml(model) {
    return model.steps.map(function (s) {
      if (s.ghost) {
        return funnelRow(s.label, 0, null, model.max)
          .replace('<div class="funnel-fill" style="width:0%"></div>',
                   '<div class="funnel-fill ghost" style="width:4%"></div>');
      }
      return funnelRow(s.label, s.n, s.prev, model.max);
    }).join('');
  }

  /* The standalone version, used by the Overview card in admin.js. */
  function funnelCard(ctx) {
    var m = funnelModel(ctx);
    return funnelRowsHtml(m) +
      '<p class="sub" style="margin-top:10px">' +
      (m.worst
        ? 'Biggest drop-off: <b>' + m.worst.pct + '% lost</b> between ' + esc(m.worst.from) +
          ' and ' + esc(m.worst.to) + ' (' + m.worst.lost + '). Fix that step before buying reach.'
        : 'No drop-off to report until registrations, matches and bookings have been recorded — zeros here would be a guess dressed as a number.') +
      '</p>';
  }

  function renderGrowth(root, ctx) {
    if (!root) return;
    var demands = live(ctx && ctx.demands);
    var listings = live(ctx && ctx.listings);
    var scouts = live(ctx && ctx.scouts);
    var bookings = live(ctx && ctx.bookings);
    var rs = (ctx && ctx.roommateSummary) || null;

    var open = demands.filter(function (r) { return str(r.status).toLowerCase() === 'open'; });
    var won = demands.filter(function (r) { var st = str(r.status).toLowerCase(); return st === 'matched' || st === 'fulfilled'; });
    var active = listings.filter(function (r) { return str(r.status).toLowerCase() === 'active'; });
    var pendingL = listings.filter(function (r) { return str(r.status).toLowerCase() === 'pending'; });
    var t2 = active.filter(function (r) { return Number(r.tier) === 2; });
    var bkPending = bookings.filter(function (r) { return str(r.status).toLowerCase() === 'pending'; });
    var bkDone = bookings.filter(function (r) { var st = str(r.status).toLowerCase(); return st === 'confirmed' || st === 'viewed' || st === 'completed'; });
    var noAsk = active.filter(function (r) { return r.opening_ask_ngn == null; });
    var mates = demands.filter(function (r) { var p = payloadOf(r); return p.roommate === 'yes' && str(r.status).toLowerCase() === 'open'; });

    /* channel attribution — only a real ?ref= tag counts. The source
       column is the form of origin ('register' etc.), not a marketing
       channel, so it must not make attribution look measured. */
    var refCount = {}, tagged = 0;
    demands.forEach(function (r) {
      var p = payloadOf(r);
      var ref = p.ref || p.source_ref || '';
      if (ref) { ref = String(ref); refCount[ref] = (refCount[ref] || 0) + 1; tagged++; }
    });
    var topRefs = Object.keys(refCount).sort(function (a, c) { return refCount[c] - refCount[a]; }).slice(0, 5);

    /* --- traction cards --- */
    var matchPct = rs ? (rs.pct_matched_within_14d + '%') : '—';
    var cards =
      metricCard('Registered demands', demands.length.toLocaleString('en-NG'), open.length + ' still open', false) +
      metricCard('Active verified listings', active.length.toLocaleString('en-NG'), t2.length + ' inspected at Tier 2', active.length === 0) +
      metricCard('Booking requests', bookings.length.toLocaleString('en-NG'), bkDone.length + ' progressed · ' + bkPending.length + ' awaiting reply', bkPending.length > 0) +
      metricCard('Roommate 14-day match', matchPct, rs ? rs.matched_within_14d + ' of ' + rs.roommate_demands_total + ' roommate requests' : 'Metric view not set up yet', false) +
      metricCard('Demands matched', won.length.toLocaleString('en-NG'), demands.length ? Math.round(won.length / demands.length * 100) + '% of registered demand' : 'No demands yet', false) +
      metricCard('Rent evidence (scouts)', scouts.length.toLocaleString('en-NG'), 'Real building reports', false);

    /* --- what to do next: computed from real gaps (doc 07) ---
       Actions that open a dashboard section only appear if this role
       can see that section (marketing cannot open the data tables). */
    var role = currentRole();
    function secVisible(k) {
      return !(role === 'marketing' && ['demand_records', 'listings', 'scout_submissions', 'bookings', 'roommate', 'settings'].indexOf(k) !== -1);
    }
    var actions = [];
    if (bkPending.length) {
      actions.push({ ic: '📅', t: 'Reply to ' + bkPending.length + ' booking request' + (bkPending.length === 1 ? '' : 's') + ' on WhatsApp today',
        w: 'Response time is funnel step 4 (doc 07) — the drop-off point that decides whether a booking becomes a move-in.', goto: 'bookings' });
    }
    if (open.length && !active.length) {
      actions.push({ ic: '🏚', t: 'Supply gap: ' + open.length + ' students waiting, 0 active listings',
        w: 'Marketing cannot fix an empty shelf. Verify one pending listing or walk one compound today (doc 03: supply beats spend).', goto: 'listings' });
    }
    if (pendingL.length) {
      actions.push({ ic: '✅', t: 'Verify ' + pendingL.length + ' pending listing' + (pendingL.length === 1 ? '' : 's'),
        w: 'Every verified room is inventory the funnel can actually convert.', goto: 'listings' });
    }
    if (noAsk.length) {
      actions.push({ ic: '🏷', t: 'Fill in ' + noAsk.length + ' missing opening ask' + (noAsk.length === 1 ? '' : 's'),
        w: 'Without the opening ask there is no measurement of whether Arzuz moves prices — the listing stops being evidence.', goto: 'listings' });
    }
    if (mates.length) {
      actions.push({ ic: '🤝', t: 'Pair ' + mates.length + ' open roommate request' + (mates.length === 1 ? '' : 's'),
        w: 'The 14-day match rate is the one true in-session retention signal — it only moves when you pair people.', goto: 'roommate' });
    }
    if (demands.length && !tagged) {
      actions.push({ ic: '🏷️', t: 'Tag every channel you already use',
        w: 'No demand carries a channel tag yet. Share links like arzuz.com/register?ref=whatsapp-status / flyer-qr / ambassador-name — the counts appear on this page automatically (doc 06).', doc: '06-channels-bullseye.md' });
    }
    if (!scouts.length) {
      actions.push({ ic: '📋', t: 'Run one building-scout walk this week',
        w: 'Scout reports are the rent evidence behind every price you quote a landlord.', goto: 'scout_submissions' });
    }
    actions = actions.filter(function (a) { return !a.goto || secVisible(a.goto); });
    if (!actions.length) {
      actions.push({ ic: '🌱', t: 'All clear — keep the weekly loop',
        w: 'Reply to bookings same-day, add one verified listing a week, and watch the funnel below for the first bottleneck.', doc: '07-unit-economics-ltv-cac.md' });
    }
    var actionsHtml = actions.map(function (a) {
      return '<div class="ops-row"><span class="ic">' + a.ic + '</span>' +
        '<span class="tx"><b>' + esc(a.t) + '</b><span>' + esc(a.w) + '</span></span>' +
        '<span class="ops-cta">' +
        (a.goto ? '<button type="button" class="btn-inline green" data-goto="' + a.goto + '">Open</button>' : '') +
        (a.doc ? '<a class="btn-inline" href="#/strategy/' + esc(a.doc) + '" data-doc="' + esc(a.doc) + '">Read the doc</a>' : '') +
        '</span></div>';
    }).join('');

    /* --- what's working --- */
    var goods = [];
    if (active.length) goods.push({ t: active.length + ' active listing' + (active.length === 1 ? '' : 's') + ' live on the browse page', s: t2.length + ' inspected at Tier 2 — the quality bar' });
    if (won.length) goods.push({ t: won.length + ' demand' + (won.length === 1 ? '' : 's') + ' matched or fulfilled', s: 'The platform is doing its one job' });
    if (bkDone.length) goods.push({ t: bkDone.length + ' booking' + (bkDone.length === 1 ? '' : 's') + ' past "pending"', s: 'Students are acting on listings' });
    if (rs && rs.matched_total) goods.push({ t: rs.pct_matched_within_14d + '% roommate match in 14 days', s: rs.matched_within_14d + ' of ' + rs.roommate_demands_total + ' requests' });
    if (scouts.length) goods.push({ t: scouts.length + ' building scout report' + (scouts.length === 1 ? '' : 's'), s: 'Real rent evidence you can quote to landlords' });
    if (tagged) goods.push({ t: tagged + ' channel-tagged registration' + (tagged === 1 ? '' : 's') + ' (?ref=)', s: 'Attribution is running — CAC per channel is becoming computable' });
    var goodsHtml = goods.length
      ? goods.map(function (g) { return '<div class="ops-row good"><span class="ic">✅</span><span class="tx"><b>' + esc(g.t) + '</b><span>' + esc(g.s) + '</span></span></div>'; }).join('')
      : '<div class="ops-row"><span class="ic">🌱</span><span class="tx"><b>No traction signals yet</b><span>The first active listing, first booking and first match will appear here.</span></span></div>';

    /* --- funnel (doc 07) — one definition, shared with the Overview card --- */
    var funnelHtml =
      funnelRowsHtml(funnelModel(ctx)) +
      '<p class="sub" style="margin-top:10px">Step 1 is the one unmeasurable step: nothing records an impression yet, so the <code>?ref=</code> tags (doc 06) count the clicks that follow a link, not the views of it. Step 6, move-in, happens offline on WhatsApp.</p>';

    /* --- channels --- */
    var channelsHtml;
    if (tagged) {
      var maxRef = refCount[topRefs[0]] || 1;
      channelsHtml = topRefs.map(function (k) {
        var w = Math.max(6, Math.round(refCount[k] / maxRef * 100));
        return '<div class="funnel-row"><span class="funnel-lbl">' + esc(k) + '</span>' +
          '<div class="funnel-bar"><div class="funnel-fill" style="width:' + w + '%"></div></div>' +
          '<span class="funnel-num">' + refCount[k] + '</span></div>';
      }).join('') +
      (tagged < demands.length ? '<p class="sub" style="margin-top:10px">' + (demands.length - tagged) + ' registration' + ((demands.length - tagged) === 1 ? '' : 's') + ' carry no tag — keep the ?ref= habit so the picture stays complete.</p>' : '');
    } else {
      channelsHtml =
        '<p class="sub">Nothing measured yet. Pick the three tests from doc 06 — WhatsApp share loops, one ambassador, one flyer QR — and give each its own tag:</p>' +
        '<pre class="md-code"><code>arzuz.com/register?ref=whatsapp-status\narzuz.com/register?ref=ambassador-ayosha\narzuz.com/register?ref=flyer-q1</code></pre>' +
        '<p class="sub" style="margin-top:10px">The counts land on this page the moment the first tagged registration arrives.</p>';
    }

    /* --- demand distribution (assets/data.js — the same numbers as the homepage curve) --- */
    var bandsHtml = '';
    if (typeof BANDS !== 'undefined') {
      var maxBand = Math.max.apply(null, BANDS.map(function (b) { return b[2]; })) || 1;
      bandsHtml = BANDS.map(function (b) {
        var lbl = b[0] === 0 ? 'Under ₦' + (b[1] / 1000) + 'k' : (b[1] === 0 ? 'Above ₦' + (b[0] / 1000) + 'k' : '₦' + (b[0] / 1000) + 'k–' + (b[1] / 1000) + 'k');
        var w = Math.max(4, Math.round(b[2] / maxBand * 100));
        return '<div class="funnel-row"><span class="funnel-lbl">' + esc(lbl) + '</span>' +
          '<div class="funnel-bar"><div class="funnel-fill band" style="width:' + w + '%"></div></div>' +
          '<span class="funnel-num">' + b[2] + '</span></div>';
      }).join('');
      bandsHtml += '<p class="sub" style="margin-top:10px">' +
        (typeof DEMAND_IS_REAL !== 'undefined' && DEMAND_IS_REAL
          ? 'Live counts from your demand records (assets/data.js).'
          : 'Reference distribution — marked [ESTIMATE] until BANDS is replaced with live demand_summary counts (assets/data.js).') + '</p>';
    }

    root.innerHTML =
      '<div class="ops-panel"><h3>📈 Traction right now</h3>' +
        '<p class="sub">Live counts from the database — never from memory. The 14-day roommate-match metric is the retention number; everything else feeds the funnel in doc 07.</p>' +
        '<div class="metrics-grid">' + cards + '</div></div>' +
      '<div class="ops-two-col">' +
        '<div class="ops-panel"><h3>✅ What&#39;s working</h3><p class="sub">Signals that the model is doing its job. Empty state is honest: nothing claimed until it exists.</p><div class="ops-list">' + goodsHtml + '</div></div>' +
        '<div class="ops-panel"><h3>⚡ What to do next</h3><p class="sub">Generated from the real gaps in today&#39;s data — the strategy pack&#39;s next-actions, made functional.</p><div class="ops-list">' + actionsHtml + '</div></div>' +
      '</div>' +
      '<div class="ops-two-col">' +
        '<div class="ops-panel"><h3>🫙 The funnel</h3><p class="sub">Where users fall out (doc 07). Fix the widest gap before spending a naira on reach.</p>' + funnelHtml + '</div>' +
        '<div class="ops-panel"><h3>📣 Channels</h3><p class="sub">Registrations per channel tag — CAC per channel becomes computable once spend exists.</p>' + channelsHtml + '</div>' +
      '</div>' +
      '<div class="ops-panel"><h3>💰 What students can pay</h3><p class="sub">Budget bands behind the homepage demand curve — pricing and inventory decisions hang off this shape (doc 01).</p>' + bandsHtml + '</div>' +
      '<div class="ops-panel"><h3>📚 The marketing playbook</h3><p class="sub">The three documents this page is built from:</p>' +
        '<div style="display:flex; gap:10px; flex-wrap:wrap;">' +
          '<a class="btn-inline" href="#/strategy/05-positioning-stp.md" data-doc="05-positioning-stp.md">🎯 Positioning — STP</a>' +
          '<a class="btn-inline" href="#/strategy/06-channels-bullseye.md" data-doc="06-channels-bullseye.md">📣 Channels — Bullseye</a>' +
          '<a class="btn-inline" href="#/strategy/07-unit-economics-ltv-cac.md" data-doc="07-unit-economics-ltv-cac.md">📈 Growth model — funnel &amp; LTV:CAC</a>' +
        '</div></div>';
  }

  /* ================= exports ================= */

  window.ArzuzStrategy = {
    renderGrowth: renderGrowth,
    renderStrategy: renderStrategy,
    funnelCard: funnelCard,
    /* The markdown renderer itself, exported so the docs can be tested
       without a browser or a Netlify function (scripts/test-strategy-render.mjs).
       It is deliberately not used by anything else in the dashboard. */
    mdToHtml: mdToHtml
  };
})();
