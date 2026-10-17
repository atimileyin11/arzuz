/* ============================================================
   Arzuz — how a listing is addressed, and how far it is from campus

   THREE places have to agree about a listing's URL, or the site
   contradicts itself and a search engine is handed two addresses
   for one room:

     * netlify/functions/rooms.js — serves /rooms/<slug>. It builds
       the URL, and it decides whether the URL that arrived is the
       canonical one. A renamed property must MOVE its address, not
       fork into a second one.
     * netlify/functions/listings-sitemap.js — lists every listing
       URL. A sitemap that disagrees with the page's own canonical
       is worse than no sitemap.
     * browse.html — links each card. These are the links a crawler
       follows to discover a listing in the first place.

   It also owns the walking time, for the same reason: the number is
   shown to a visitor, bookmarked, shared, and shown to a crawler that
   ran no script. Two implementations of it would eventually print two
   different numbers for the same room.

   Loads as window.ArzuzListing in a browser and via require() in
   Node (same wrapper as assets/roommate-score.js).

   WHY THE URL CARRIES THE ID
   The readable part is the property name and the area, and an owner
   can edit either at any time. The id never changes, so it is the
   part the page resolves by — and a URL whose readable part no
   longer matches is 301'd to the current one rather than serving the
   same room twice. That is also why the id goes LAST: everything
   before it is decoration a human reads, and nothing before it is
   load-bearing.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArzuzListing = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  var VERSION = '1.0.0';

  /* KWASU main gate. assets/arzuz-map.js carries its own copy for the
     map's origin marker — scripts/test-rooms.mjs fails if the two ever
     disagree, because the map and the listing page would then be
     measuring from two different places. */
  var CAMPUS = { lat: 8.721, lng: 4.484 };

  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  /* Long enough to read, short enough to keep the URL usable. A name
     truncated mid-word is ugly, so the slices land on a dash where one
     is close by. */
  function cut(s, max) {
    if (s.length <= max) return s;
    var head = s.slice(0, max);
    var dash = head.lastIndexOf('-');
    if (dash > max - 12) head = head.slice(0, dash);
    return head.replace(/-+$/, '');
  }

  function slugPart(s) {
    var str = String(s === null || s === undefined ? '' : s);
    /* NFKD splits an accented letter into the letter plus a combining mark,
       and the line below drops the mark — so "Àjà" becomes "aja" instead of
       being deleted outright by the [^a-z0-9] rule that follows it. */
    if (typeof str.normalize === 'function') str = str.normalize('NFKD');
    return str
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['\u2019]/g, '')          /* Blessing's → blessings */
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* The property name, preferring the payload the owner filled in. */
  function nameOf(row) {
    var p = (row && row.payload) || {};
    return String(p.prop_name || (row && row.property_name) || '').trim();
  }

  function areaOf(row) {
    var p = (row && row.payload) || {};
    return String(p.ar || (row && row.area) || '').trim();
  }

  function idOf(row) {
    return String((row && row.id) || '').trim().toLowerCase();
  }

  /* 'sunrise-lodge-malete' — the human part. Empty fields fall back to
     something a person can still read, never to an empty string: a URL
     with a leading dash looks broken, and '-a1b2…' would be a URL that
     differs from a sibling only in the part nobody can read. */
  function readable(row) {
    var name = cut(slugPart(nameOf(row)) || 'room', 48);
    var area = cut(slugPart(areaOf(row)) || 'malete', 24);
    return name ? name + '-' + area : area;
  }

  function slug(row) {
    var id = idOf(row);
    if (!id) return '';
    return readable(row) + '-' + id;
  }

  function path(row) {
    var s = slug(row);
    return s ? '/rooms/' + s : '';
  }

  /* The id is the last thing in the last path segment. Anything that
     does not end in a uuid is not one of these URLs — /rooms/ itself,
     or a hand-typed path — and returns '' rather than guessing. */
  function idFromPath(pathname) {
    var p = decodeURI(String(pathname || '')).split('?')[0].replace(/\/+$/, '');
    var m = UUID.exec(p);
    if (!m) return '';
    var tail = m[0];
    if (p.slice(-tail.length).toLowerCase() !== tail.toLowerCase()) return '';
    return tail.toLowerCase();
  }

  /* Is this the address the listing publishes today? A path whose
     readable part has drifted (the owner renamed the property) is
     still resolvable — the id is there — but it is not canonical. */
  function isCanonical(pathname, row) {
    var p = decodeURI(String(pathname || '')).split('?')[0].replace(/\/+$/, '');
    return p === path(row);
  }

  /* ---------- how far it is ---------- */

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /* Straight-line distance with a 1.25 detour factor and a 4.5 km/h
     walking pace — the same numbers listing.html has always used, so
     the page does not change what it says about a room.
     Returns '' rather than a wrong number: no pin, or a walk longer
     than 90 minutes, means this formula has nothing useful to say. */
  function walkText(lat, lng) {
    if (!lat || !lng) return '';
    var km = haversineKm(parseFloat(lat), parseFloat(lng), CAMPUS.lat, CAMPUS.lng) * 1.25;
    var min = Math.round(km / 4.5 * 60);
    if (min < 1) return 'On campus street';
    if (min > 90) return '';
    return '\uD83D\uDEB6 \u2248 ' + min + ' min walk to KWASU';
  }

  /* Total km along a stored route [[lat,lng],…] — the same summation
     assets/arzuz-map.js does (geo.polylineKm), because the two have to
     agree to the metre: this one is what the SERVER prints on a card and
     that one is what the browser printed before the card moved server-side.
     scripts/test-rooms.mjs feeds both the same route and fails if their
     sentences come out different. */
  function polylineKm(pts) {
    var total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    return total;
  }

  /* The walk for a whole row, preferring a MEASURED route over the
     straight-line estimate. The route is captured with the pin tool
     (payload.passage.route, an array of [lat,lng]) and is what makes the
     number a measurement rather than a guess — which is this site's whole
     claim about walking time, so the server has to be able to say it too.

     Same precedence and same sentence as ArzuzMap.passage.walkChip in a
     browser; pinned against it by the test, so the two cannot drift.
     Falls back to walkText() when there is no route, including when there
     is no pin at all. */
  function walkOf(row) {
    var p = (row && row.payload) || {};
    var raw = p.passage && p.passage.route;
    var pts = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var la = Number(raw[i] && raw[i][0]);
        var ln = Number(raw[i] && raw[i][1]);
        if (isFinite(la) && isFinite(ln)) pts.push([la, ln]);
      }
    }
    if (pts.length > 1) {
      var km = polylineKm(pts);
      var min = Math.round(km / 4.5 * 60);
      if (min >= 1 && min <= 90) {
        return '\uD83D\uDEB6 ' + (km >= 0.1 ? km.toFixed(1) + ' km' : Math.round(km * 1000) + ' m') +
          ' \u00B7 ' + min + ' min walk to KWASU';
      }
    }
    return walkText(row && row.latitude, row && row.longitude);
  }

  /* Which check a listing carries. A label, not markup: the listing page
     wants a badge, the server-rendered block wants a chip, and both must
     say the same words. */
  function tierLabel(tier) {
    if (Number(tier) >= 2) return 'Inspected';
    if (Number(tier) === 1) return 'Community verified';
    return 'Unverified';
  }

  /* ---------- what the listing IS, for a machine ----------

     One builder, used by the function that serves /rooms/<slug> and by
     listing.html once it has painted the page. Before this, the page's own
     version carried a name, an area and a photo — no price, which is the
     one field a listing result actually needs and the difference between a
     rich result and a blue link.

     numberOfRooms is deliberately absent: rm is how many rooms are VACANT
     today, and marking a full compound as "numberOfRooms: 0" says something
     else entirely. Vacancy is expressed through availability instead. */
  function schema(row, url) {
    var p = (row && row.payload) || {};
    var name = nameOf(row) || 'Verified room';
    var area = areaOf(row) || 'Malete';
    var rent = Number(row && row.listed_price_ngn) || 0;
    var rooms = String((p.rm !== undefined && p.rm !== '' ? p.rm : (row && row.rooms)) || '');
    var walk = walkText(row && row.latitude, row && row.longitude);

    var images = [];
    if (Array.isArray(p.media)) {
      for (var i = 0; i < p.media.length; i++) {
        var m = p.media[i];
        if (m && m.type !== 'video' && m.url) images.push(String(m.url));
      }
    }
    if (!images.length && (p.photo || (row && row.photo_url))) images.push(String(p.photo || row.photo_url));

    var place = {
      '@type': 'Apartment',
      '@id': url + '#place',
      name: name,
      url: url,
      address: {
        '@type': 'PostalAddress',
        addressLocality: area,
        addressRegion: 'Kwara State',
        addressCountry: 'NG'
      }
    };

    if (images.length) place.image = images;
    var desc = String(p.desc || p.description || '').trim();
    if (desc) place.description = desc.length > 300 ? desc.slice(0, 297) + '...' : desc;
    if (walk) {
      place.additionalProperty = [{
        '@type': 'PropertyValue',
        name: 'Walking distance to KWASU',
        value: walk.replace(/^\uD83D\uDEB6\s*/, '')
      }];
    }
    if (rent) {
      place.offers = {
        '@type': 'Offer',
        price: rent,
        priceCurrency: 'NGN',
        url: url,
        availability: rooms === '0' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock'
      };
    }

    /* The trail matches the page: it is reached from the verified listing
       index, which the back link at the top of the page says out loud. */
    var crumbs = {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Arzuz', item: 'https://arzuz.com/' },
        { '@type': 'ListItem', position: 2, name: 'Verified rooms', item: 'https://arzuz.com/browse' },
        { '@type': 'ListItem', position: 3, name: name, item: url }
      ]
    };

    return { '@context': 'https://schema.org', '@graph': [place, crumbs] };
  }

  return {
    VERSION: VERSION,
    CAMPUS: CAMPUS,
    schema: schema,
    slugPart: slugPart,
    readable: readable,
    slug: slug,
    path: path,
    nameOf: nameOf,
    areaOf: areaOf,
    idOf: idOf,
    idFromPath: idFromPath,
    isCanonical: isCanonical,
    haversineKm: haversineKm,
    polylineKm: polylineKm,
    walkText: walkText,
    walkOf: walkOf,
    tierLabel: tierLabel
  };
});
