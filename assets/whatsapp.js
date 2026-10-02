/* ============================================================
   Arzuz — WhatsApp confirmation messages

   Sends a personalised WhatsApp confirmation to the user who
   just submitted a form (student, landlord, or scout).

   Calls /api/whatsapp-send (a Netlify Function that proxies to
   OpenWA) so the API key never touches the browser.
   ============================================================ */

var ArzuzWhatsApp = (function(){

  function cfg(){ return window.ARZUZ_CONFIG || {}; }

  function enabled(){
    var c = cfg();
    return c.WHATSAPP_CONFIRMATIONS !== false; // on by default
  }

  /**
   * Normalise a Nigerian phone input to WhatsApp JID.
   *   "08012345678"   → "2348012345678@s.whatsapp.net"
   *   "2348012345678"  → "2348012345678@s.whatsapp.net"
   *   "+2348012345678" → "2348012345678@s.whatsapp.net"
   * Returns null if the number doesn't look valid.
   */
  function toJid(raw){
    if (!raw) return null;
    var digits = String(raw).replace(/[\s\-\+\(\)]/g, '');
    // Strip leading 0 → prefix with 234
    if (digits.charAt(0) === '0') digits = '234' + digits.slice(1);
    // Already has country code
    if (!/^234\d{10}$/.test(digits)) return null;
    return digits + '@s.whatsapp.net';
  }

  /* ---------- message templates ---------- */

  function studentMessage(a){
    var first = a.first || a.first_name || 'there';
    var last = a.last || a.last_name || '';
    var name = last ? (first + ' ' + last) : first;
    var room = a.type || a.room_type || 'your preferred room';
    var budget = a.budget || a.budget_band || '';
    return (
      '\u2705 *You\u2019re on the Arzuz list, ' + name + '!*\n\n' +
      'We\u2019ll message you here as soon as a room matches what you asked for' +
      (room !== 'your preferred room' ? ' \u2014 ' + room : '') +
      (budget ? ', ' + budget : '') + '.\n\n' +
      'No app to install, no notifications to turn on.\n' +
      '\u2014 Arzuz, Malete'
    );
  }

  function landlordMessage(a){
    var first = a.nm || a.owner_name || 'there';
    var last = a.last || a.last_name || '';
    var name = last ? (first + ' ' + last) : first;
    var prop = a.prop_name ? ('"' + a.prop_name + '" \u2014 ') : '';
    var type = a.ty || a.property_type || 'Property';
    var area = a.ar || a.area || '';
    var rent = Number(a.rent || a.listed_price_ngn || 0).toLocaleString();
    return (
      '\u2705 *Your listing is live, ' + name + '!*\n\n' +
      prop + type + (area ? ' at ' + area : '') +
      (rent !== '0' ? ' \u2022 \u20A6' + rent + '/session' : '') + '\n\n' +
      'We\u2019re matching you with students now. Expect messages here when interested students come through.\n' +
      '\u2014 Arzuz'
    );
  }

  function scoutMessage(a){
    var first = a.first || a.first_name || 'there';
    var last = a.last || a.last_name || '';
    var name = last ? (first + ' ' + last) : first;
    var area = a.area || 'your building';
    return (
      '\u2705 *Report received, ' + name + '!*\n\n' +
      'Thanks for scouting ' + area + '. Your intel helps other students avoid bad deals.\n' +
      '\u2014 Arzuz'
    );
  }

  /* ---------- send logic ---------- */

  function sendConfirmation(table, answers){
    if (!enabled()) return;

    var text, phone;

    if (table === 'demand_records') {
      text  = studentMessage(answers);
      phone = answers.phone;
    } else if (table === 'listings') {
      text  = landlordMessage(answers);
      phone = answers.ph || answers.owner_phone;
    } else if (table === 'scout_submissions') {
      text  = scoutMessage(answers);
      phone = answers.phone;
    } else {
      return; // unknown table — skip
    }

    var jid = toJid(phone);
    if (!jid) {
      console.log('[ArzuzWhatsApp] Skipped — invalid phone:', phone);
      return;
    }

    console.log('[ArzuzWhatsApp] Sending confirmation to', jid);

    fetch('/api/whatsapp-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: jid, text: text })
    })
    .then(function(res){
      if (!res.ok) throw new Error('HTTP ' + res.status);
      console.log('[ArzuzWhatsApp] \u2705 Confirmation sent');
    })
    .catch(function(err){
      // Never let a failed WhatsApp message break the submission
      console.warn('[ArzuzWhatsApp] Confirmation failed (non-blocking):', err.message);
    });
  }

  return {
    sendConfirmation: sendConfirmation,
    toJid: toJid,
    enabled: enabled
  };
})();
