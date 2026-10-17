/* ============================================================
   Arzuz — the browse board's markup, in one place

   The board used to be drawn in the browser: browse.html fetched
   public_listings itself and built every card in an inline script. The
   page therefore had TWO renderers of the same thing — the server's, for
   a crawler or a slow connection, and this one — and only one of them
   could ever be right about a room.

   netlify/functions/browse.js now renders the whole board and the page
   fetches nothing. This module is that renderer, and it is the ONLY
   place the shape of a card is written down: the CSS it is styled by
   still lives in browse.html, next to the page that serves it.

   WHAT IT OWNS ABOUT THE PAGE
   browse.html keeps a holder where the board goes — one line, marked
   <!--board-->, carrying the honest state a page with no server behind
   it should show (this is what `node scripts/dev-server.mjs` serves).
   `fill()` swaps that whole line for the rendered board, so the page's
   own fallback copy can be rewritten without touching this file, and the
   function never has to match a long string it does not own.

   EVERYTHING IS ESCAPED. A property name is `A & B <Lodge>` often enough,
   and this markup is written by a server into a page, so esc() is applied
   to every value, including the ones that go into an href.

   Loads as window.ArzuzBrowseCard in a browser and via require() in
   Node — the same UMD shape as assets/listing-url.js, whose address and
   walk rules it uses rather than restating them.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./listing-url.js'), require('./api-errors.js'));
  } else {
    root.ArzuzBrowseCard = factory(root.ArzuzListing, root.ArzuzApiErrors);
  }
})(typeof self !== 'undefined' ? self : this, function (ArzuzListing, ArzuzApiErrors) {
  'use strict';

  var VERSION = '1.0.0';

  /* The marker browse.html keeps on the board's line. One line only: the
     function swaps the entire line, and that is why the copy in it can
     change freely (see the header). */
  var MARKER = '<!--board-->';

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function ngn(n) {
    try {
      return '\u20A6' + Number(n).toLocaleString('en-NG');
    } catch (e) {
      return '\u20A6' + n;
    }
  }

  function tierClass(tier) {
    return Number(tier) >= 2 ? 'b2' : (Number(tier) === 1 ? 'b1' : 'b0');
  }

  /* The badge, not the word: the same three labels the room page prints,
     from the same module. */
  function badge(tier) {
    return '<span class="h-badge ' + tierClass(tier) + '" style="margin:0">' +
      esc(ArzuzListing.tierLabel(tier)) + '</span>';
  }

  function utilities(p) {
    var ut = p.ut !== undefined && p.ut !== null && p.ut !== '' ? p.ut : p.utilities;
    if (ut === undefined || ut === null || ut === '') return [];
    if (typeof ut === 'string') {
      return ut.split(',').map(function (s) { return String(s).trim(); }).filter(Boolean);
    }
    return Array.isArray(ut) ? ut.filter(Boolean).map(String) : [];
  }

  /* How much media is behind the card, for the two chips on the photo. */
  function mediaCounts(p, cover) {
    var nImg = 0, nVid = 0;
    if (Array.isArray(p.media) && p.media.length) {
      p.media.forEach(function (m) {
        if (!m || !m.url) return;
        if (m.type === 'video') nVid++; else nImg++;
      });
    } else {
      if (cover) nImg = 1;
      if (p.video || p.video_url) nVid = 1;
    }
    return { nImg: nImg, nVid: nVid };
  }

  /* One room, as a card. The fields are the ones a student chooses with:
     what it is called, where it is, what it costs, how far it is, and how
     far the check went. */
  function card(row) {
    if (!row) return '';
    var p = row.payload || {};
    var href = ArzuzListing.path(row);
    if (!href) return '';                       /* no id, so no address to link */

    var name = ArzuzListing.nameOf(row) || 'Unnamed property';
    var area = ArzuzListing.areaOf(row) || 'Malete';
    var rent = Number(row.listed_price_ngn) || 0;
    var type = String(p.ty || row.property_type || '').trim();
    var rooms = String((p.rm !== undefined && p.rm !== '' ? p.rm : row.rooms) || '').trim();
    var cover = p.photo || row.photo_url || '';
    var ut = utilities(p);
    var walk = ArzuzListing.walkOf(row);
    var counts = mediaCounts(p, cover);
    var ref = String(row.id || '').substring(0, 8);

    var chips =
      (counts.nImg > 1 ? '<span class="media-chip">\uD83D\uDCF7 ' + counts.nImg + ' photos</span>' : '') +
      (counts.nVid ? '<span class="media-chip">\u25B6 Tour</span>' : '');

    /* The Ask link opens the support chat with the room already named, so
       the team does not have to ask which listing it is. The number and
       the encoding come from the one module that owns the number. */
    var ask = ArzuzApiErrors && ArzuzApiErrors.waLink
      ? ArzuzApiErrors.waLink('Hi Arzuz! I saw "' + name + '" (' + area + ', \u20A6' +
          rent.toLocaleString() + ' per session, ref ' + ref +
          ') on the browse page. Is it still available?')
      : '';

    return '<div class="card" data-tilt data-rise>' +
      '<div class="ph">' +
        (cover
          ? '<img src="' + esc(cover) + '" alt="' + esc(name + ' in ' + area + ', near KWASU') + '" loading="lazy">'
          : '\uD83D\uDCF7 Photo coming soon') +
        (chips ? '<span class="media-chips">' + chips + '</span>' : '') +
        '<span class="ph-cr">\u00A9 Arzuz</span>' +
        '<span class="badge">' + badge(row.tier) + '</span>' +
      '</div>' +
      '<div class="body">' +
        '<h3>' + esc(name) + '</h3>' +
        '<div class="area">' +
          '<span>\uD83D\uDCCD ' + esc(area) + '</span>' +
          (type ? '<span>' + esc(type) + '</span>' : '') +
          (rooms ? '<span>' + esc(rooms) + '</span>' : '') +
        '</div>' +
        (rent
          ? '<div class="price">' + esc(ngn(rent)) + '</div><div class="per">per session</div>'
          : '') +
        (walk ? '<div class="walk">' + esc(walk) + '</div>' : '') +
        (ut.length
          ? '<div class="amen">' + ut.slice(0, 4).map(function (u) {
              return '<span>' + esc(u) + '</span>';
            }).join('') + (ut.length > 4 ? '<span>+' + (ut.length - 4) + '</span>' : '') + '</div>'
          : '') +
        '<div class="cta">' +
          '<a class="primary" href="' + esc(href) + '">View details</a>' +
          (ask ? '<a class="ghost" href="' + esc(ask) + '" target="_blank" rel="noopener noreferrer">Ask</a>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function board(rows) {
    var cards = (rows || []).map(card).filter(Boolean);
    if (!cards.length) return '';
    return '<div class="grid">' + cards.join('') + '</div>';
  }

  /* The board could not be read. Said in the first person, because "no
     verified listings yet" would be a claim about the inventory and this
     is a claim about us — and the door to register is the useful thing to
     leave in front of a student either way. */
  function unavailable() {
    return '<div class="empty" data-rise>' +
      '<div class="m"><span>az</span></div>' +
      '<h2>Listings are warming up.</h2>' +
      '<p>We could not load the listing board just now \u2014 that is our side, not yours. ' +
      'Register your need and we will match you directly on WhatsApp meanwhile.</p>' +
      '<div class="h-doors"><a class="h-btn h-p" href="/register">Register your need</a></div>' +
      '</div>';
  }

  /* Swap the whole holder line for the rendered board. The line is found
     by its marker, so the page's own fallback copy can be rewritten
     without this function learning about it — and a page that has lost
     the marker is returned untouched rather than half-rewritten. */
  function fill(html, inner) {
    var re = new RegExp('^.*' + MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\r?$', 'm');
    if (!re.test(html)) return '';
    return html.replace(re, '<div id="listings">' + inner + '</div>');
  }

  return {
    VERSION: VERSION,
    MARKER: MARKER,
    esc: esc,
    ngn: ngn,
    badge: badge,
    utilities: utilities,
    card: card,
    board: board,
    unavailable: unavailable,
    fill: fill
  };
});
