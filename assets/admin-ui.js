/* ============================================================
   Arzuz Admin — UI primitives (design-system layer)
   Plain ES5, no dependencies. Loaded by admin.html before
   admin.js. Fourth small module of the dashboard, alongside
   ArzuzAuth / ArzuzData / ArzuzStrategy.

   Motion contract (tokens in arzuz.css / admin.css):
     durations  --dur-1..--dur-4 (120/200/320/560 ms)
     easings    --ease-spring, --ease-snappy
     The ONE rule: animate only transform / opacity / filter.

   Exports (window.ArzuzUI):
     icon(name, size)              inline SVG string
     toast(msg, type)              dark-glass toast
     tick(el, to, suffix)          WAAPI-assisted count-up
     staggerIn(root)               fade+rise on [data-motion]
     popIn(el)                     modal entrance
     closeModal(overlay)           animated modal close
     motionOK()                    false under reduced motion
     trapFocus(overlay)            focus trap + restore
     setBusy(btn, on, label)       button busy state
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     1. Icons — 24x24 stroke icons, currentColor, 1.75px.
     ============================================================ */

  var SPRITE = {
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    shield: '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="m9 11 2 2 4-4"/>',
    grid: '<path d="M3 3h8v8H3z"/><path d="M13 3h8v8h-8z"/><path d="M3 13h8v8H3z"/><path d="M13 13h8v8h-8z"/>',
    cap: '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V15c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/>',
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
    clipboard: '<path d="M9 4h6v3H9z"/><path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><path d="m9 12 2 2 4-4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    headset: '<path d="M4 13a8 8 0 0 1 16 0"/><rect x="2" y="13" width="4" height="7" rx="2"/><rect x="18" y="13" width="4" height="7" rx="2"/><path d="M20 17a4 4 0 0 1-4 4h-3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.3c2.1.7 3.5 2.4 3.5 5.7"/>',
    trending: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M4.9 4.9l2.1 2.1"/><path d="M17 17l2.1 2.1"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M4.9 19.1 7 17"/><path d="M17 7l2.1-2.1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
    whatsapp: '<path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 0 0 12 22a10 10 0 0 0 0-20z"/><path d="M8.5 9.5c.5 3 3 5.5 6 6l1.5-1.5 2 1c-.5 1.5-1.5 2-3 1.5-4-1-7-4-8-8-.5-1.5 0-2.5 1.5-3l1 2z"/>',
    telegram: '<path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.4 2.1L8 10c1.4 2.8 3.6 5 6.4 6.4l1.3-1.4a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 2z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    video: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'
  };

  function icon(name, size) {
    var body = SPRITE[name] || SPRITE.grid;
    var s = size || 18;
    return '<svg class="ico" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none"' +
      ' stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body + '</svg>';
  }

  /* Student-facing copy keeps the emoji voice (canned replies,
     intros). UI chrome uses SVG only. */
  function emoji(name) {
    return ({ canned: '📋', intro: '🤝', wa: '💬', link: '🔗', draft: '📝', done: '✅' })[name] || '';
  }

  /* ============================================================
     2. Motion + toast
     ============================================================ */

  var SPRING = 'cubic-bezier(0.16, 1, 0.3, 1)';

  function motionOK() {
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function toast(message, type) {
    var container = document.querySelector('.arzuz-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'arzuz-toast-container';
      document.body.appendChild(container);
    }
    var el = document.createElement('div');
    el.className = 'arzuz-toast ' + (type || 'info');
    el.innerHTML = '<span>' + message + '</span>';
    container.appendChild(el);

    if (motionOK() && el.animate) {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(8px) scale(.97)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' }
        ],
        { duration: 320, easing: SPRING }
      );
    }
    setTimeout(function () {
      if (motionOK() && el.animate) {
        var anim = el.animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }],
          { duration: 200, easing: 'ease-out' }
        );
        anim.onfinish = function () { el.remove(); };
      } else {
        el.remove();
      }
    }, 4000);
  }

  function tick(el, to, suffix) {
    if (!el) return;
    var from = parseInt(String(el.textContent).replace(/[^0-9-]/g, ''), 10);
    if (isNaN(from)) from = 0;
    var end = String(to) + (suffix || '');
    if (!motionOK() || from === to) { el.textContent = end; return; }
    var dur = 600;
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + (to - from) * eased) + (suffix || '');
      if (t < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  function staggerIn(root) {
    if (!motionOK()) return;
    var items = (root || document).querySelectorAll('[data-motion]');
    var cap = Math.min(items.length, 14);
    for (var i = 0; i < cap; i++) {
      items[i].animate(
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ],
        { duration: 320, delay: Math.min(i * 30, 420), easing: SPRING, fill: 'backwards' }
      );
    }
  }

  function popIn(el) {
    if (!el || !motionOK() || !el.animate) return;
    el.animate(
      [
        { opacity: 0, transform: 'scale(.96) translateY(8px)' },
        { opacity: 1, transform: 'scale(1) translateY(0)' }
      ],
      { duration: 320, easing: SPRING }
    );
  }

  function closeModal(overlay) {
    if (!overlay) return;
    var finish = function () { overlay.classList.remove('open'); };
    if (!motionOK() || !overlay.animate) { finish(); return; }
    var anim = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
    anim.onfinish = finish;
    anim.oncancel = finish;
  }

  /* ============================================================
     3. Focus trap + restore
     ============================================================ */

  var lastFocus = null;
  var trapHandler = null;
  var FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function trapFocus(overlay) {
    if (!overlay) return;
    lastFocus = document.activeElement;

    trapHandler = function (e) {
      if (e.key !== 'Tab' || !overlay.classList.contains('open')) return;
      var items = overlay.querySelectorAll(FOCUSABLE);
      var visible = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].offsetParent !== null) visible.push(items[i]);
      }
      if (!visible.length) return;
      var first = visible[0];
      var last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapHandler, true);

    var first = overlay.querySelector(FOCUSABLE);
    if (first) {
      try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
    }
  }

  function releaseFocus() {
    if (trapHandler) { document.removeEventListener('keydown', trapHandler, true); trapHandler = null; }
    if (lastFocus && lastFocus.isConnected) {
      try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
  }

  /* ============================================================
     4. Button busy state
     ============================================================ */

  function setBusy(btn, on, label) {
    if (!btn) return;
    if (on) {
      if (!btn.dataset.restLabel) btn.dataset.restLabel = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.textContent = label || 'Working…';
    } else {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (btn.dataset.restLabel) btn.innerHTML = btn.dataset.restLabel;
    }
  }

  /* ============================================================
     4b. Hydrate [data-icon] placeholders (static HTML chrome)
     ============================================================ */

  function hydrateIcons() {
    var holders = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < holders.length; i++) {
      holders[i].innerHTML = icon(holders[i].getAttribute('data-icon'), 18);
      holders[i].removeAttribute('data-icon');
    }
  }

  /* ============================================================
     4b. deEmoji — presentation-layer de-slop for markup generated
     by strategy.js (kept byte-identical by design): swaps the emoji
     glyphs it emits for the same SVG set, right in the rendered DOM.
     String-level so it also works inside the boot-test DOM shim.
     ============================================================ */

  var EMOJI_MAP = {
    '🗂': 'book', '📚': 'book',
    '🎯': 'pin', '💰': 'tag', '🏷': 'tag',
    '📣': 'external', '📈': 'trending',
    '🌍': 'search', '🧭': 'users', '🤝': 'users',
    '⚔': 'shield', '🌦': 'alert', '🫙': 'alert',
    '🔒': 'lock', '📅': 'calendar', '🏚': 'home',
    '✅': 'check', '📋': 'clipboard', '🌱': 'zap', '⚡': 'zap'
  };
  var EMOJI_RE = /(🗂|📚|🎯|💰|🏷|📣|📈|🌍|🧭|🤝|⚔|🌦|🫙|🔒|📅|🏚|✅|📋|🌱|⚡)\uFE0F?/g;

  /* In-place: split one text node around its emoji and swap each glyph
     for an icon span. Never touches element identity — async code that
     holds node references (strategy.js's doc painter) stays valid. */
  function swapTextNode(node) {
    var text = node.nodeValue || '';
    EMOJI_RE.lastIndex = 0;
    if (!EMOJI_RE.test(text)) return 0;
    EMOJI_RE.lastIndex = 0;
    var frag = document.createDocumentFragment();
    var last = 0, m, n = 0;
    while ((m = EMOJI_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var name = EMOJI_MAP[m[0].replace('\uFE0F', '')];
      var span = document.createElement('span');
      span.className = 'ico';
      span.innerHTML = icon(name || 'grid', 16);
      frag.appendChild(span);
      last = m.index + m[0].length;
      n++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (n && node.parentNode) node.parentNode.replaceChild(frag, node);
    return n;
  }

  function walkDeEmoji(el, count) {
    var kids = el.childNodes;
    for (var i = kids.length - 1; i >= 0; i--) {
      var c = kids[i];
      if (c.nodeType === 3) count += swapTextNode(c);
      else if (c.nodeType === 1) count = walkDeEmoji(c, count);
    }
    return count;
  }

  function deEmoji(root) {
    if (!root) return root;
    if (document.createTextNode && document.createDocumentFragment && typeof Node !== 'undefined' && root.childNodes) {
      walkDeEmoji(root, 0);
      return root;
    }
    /* boot-test shim: no node surgery available — string-level swap */
    var html = root.innerHTML || '';
    EMOJI_RE.lastIndex = 0;
    if (!EMOJI_RE.test(html)) return root;
    EMOJI_RE.lastIndex = 0;
    root.innerHTML = html.replace(EMOJI_RE, function (m) {
      var name = EMOJI_MAP[m.replace('\uFE0F', '')];
      return name ? '<span class="ico">' + icon(name, 16) + '</span>' : m;
    });
    return root;
  }

  /* strategy.js paints fetched docs (with their emoji metadata) into
     the reader AFTER the initial render — keep watching the subtree
     and re-swapping. Debounced; settles once no emoji remain. */
  function armDeEmoji(root) {
    if (!root || typeof MutationObserver === 'undefined') return root;
    var pending = false;
    var obs = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        walkDeEmoji(root, 0);
      }, 40);
    });
    obs.observe(root, { childList: true, subtree: true });
    return root;
  }

  /* ============================================================
     5. Export + ArzuzSubmit.toast takeover
     ============================================================ */

  window.ArzuzUI = {
    icon: icon,
    emoji: emoji,
    motionOK: motionOK,
    toast: toast,
    tick: tick,
    staggerIn: staggerIn,
    popIn: popIn,
    closeModal: closeModal,
    trapFocus: trapFocus,
    releaseFocus: releaseFocus,
    setBusy: setBusy,
    deEmoji: deEmoji,
    armDeEmoji: armDeEmoji
  };

  hydrateIcons();

  /* ArzuzUI loads before submit.js, so patch after both exist. */
  function patchSubmitToasts() {
    if (window.ArzuzSubmit) window.ArzuzSubmit.showToast = toast;
    else setTimeout(patchSubmitToasts, 50);
  }
  patchSubmitToasts();
})();
