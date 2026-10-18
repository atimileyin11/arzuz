/* ============================================================
   Arzuz — your referral code, minted and shared

   The entrance to the paid-referral loop that used to need the admin
   hand-typing a code in Supabase: after a verified outcome (a Care Pass
   purchase, a registration) the happiest moment is also the emptiest —
   and that is where a personal code belongs.

   mount(el, opts) with { phone, name } mints (or re-issues — minting is
   idempotent, one code per phone) through /api/finance referral_mint,
   then renders the code plus a share card whose ?ref= tag IS the code,
   so every friend who registers through it is already attributed when
   they buy. No login, no dashboard: the code + phone pair is the only
   credential, the same pattern as the status page.

   Plain ES5. ArzuzShare does the sharing; ArzuzRef lowercases the tag
   into channel shape. A mint that fails leaves an honest line, never a
   broken card.

   Usage:
     ArzuzReferralCard.mount(document.getElementById('refCard'),
       { phone: state.orderPhone, name: state.orderName });
   ============================================================ */

var ArzuzReferralCard = (function () {

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function api() {
    return '/api/finance';
  }

  function personalLink(code) {
    var base = 'https://arzuz.com/register';
    try {
      if (window.ArzuzRef && ArzuzRef.link) return ArzuzRef.link(base, String(code || '').toLowerCase());
    } catch (e) { /* fall through to the manual tag */ }
    return base + '?ref=' + encodeURIComponent(String(code || '').toLowerCase());
  }

  function cardHtml(code) {
    var tag = String(code || '').toLowerCase();
    var share = '';
    try {
      if (window.ArzuzShare && ArzuzShare.card) {
        share = ArzuzShare.card({
          url: 'https://arzuz.com/register',
          tag: tag,
          heading: 'Friends earn you ₦2,000',
          body: 'Send your link — when a friend buys their first Care Pass, you get paid. Your code is on the link automatically.',
          text: 'I use Arzuz for verified student housing near KWASU — zero agent fees. Register here:',
          note: 'One code per person, yours for good. Earnings show on the referrals page.'
        });
      }
    } catch (e) { share = ''; }
    return '<div class="ref-card" data-ref-card>' +
      '<div class="ref-code-row"><span class="ref-lbl">Your referral code</span>' +
      '<b class="ref-code" data-ref-code>' + esc(code) + '</b></div>' +
      '<p class="ref-link" data-ref-link>Your link: <span>' + esc(personalLink(code)) + '</span></p>' +
      share +
      '<p class="ref-dash">Track clicks and earnings: <a href="/referrals">your referrals page</a>.</p>' +
    '</div>';
  }

  function wireShare(root) {
    try {
      if (window.ArzuzShare && ArzuzShare.wire) ArzuzShare.wire(root);
    } catch (e) { /* sharing degrades to the copied link above */ }
  }

  function mount(el, opts) {
    if (!el) return;
    var o = opts || {};
    var phone = String(o.phone || '').trim();
    if (!phone) {
      el.innerHTML = '<p class="note">Add your phone number at checkout and your referral code appears here.</p>';
      return;
    }
    el.innerHTML = '<p class="note" data-ref-status>Getting your referral code…</p>';
    fetch(api(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'referral_mint',
        phone: phone,
        name: String(o.name || '').slice(0, 80),
        env: (window.ARZUZ_CONFIG && window.ARZUZ_CONFIG.ENV) || 'production'
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      /* Netlify answers the wire body flat (assets/api-errors.js) —
         { ok, code }, never nested under data. */
      var body = data || {};
      if (body && body.code) {
        el.innerHTML = cardHtml(body.code);
        wireShare(el);
      } else {
        el.innerHTML = '<p class="note">We could not get your referral code just now — ' +
          esc((body && body.error) || 'try again in a moment.') + '</p>';
      }
    }).catch(function () {
      el.innerHTML = '<p class="note">We could not reach Arzuz just now — your code will be here when you are back online.</p>';
    });
  }

  /* Render a code already in hand (e.g. just minted by the page) — the
     same card mount() draws, without a second mint round-trip. */
  function show(el, code) {
    if (!el) return;
    el.innerHTML = cardHtml(code);
    wireShare(el);
  }

  return { mount: mount, show: show, personalLink: personalLink };
})();

if (typeof window !== 'undefined') window.ArzuzReferralCard = ArzuzReferralCard;
