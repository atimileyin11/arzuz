/* ============================================================
   Arzuz — Telegram & Email Notification Engine
   Dispatches real-time notification alerts whenever a student,
   landlord, or scout submits a form.
   ============================================================ */

var ArzuzNotify = (function(){

  function getConfig(){
    return window.ARZUZ_CONFIG || {};
  }

  function getChatId(){
    var cfg = getConfig();
    return cfg.TELEGRAM_CHAT_ID || localStorage.getItem('arzuz_tg_chat') || '';
  }

  /* Auto-detect chat_id by querying getUpdates for recent messages sent to the bot */
  function autoDetectChatId(token){
    var botToken = token || getConfig().TELEGRAM_BOT_TOKEN;
    if (!botToken) return Promise.reject(new Error("No bot token available"));

    var url = "https://api.telegram.org/bot" + botToken + "/getUpdates";
    return fetch(url)
      .then(function(res){ return res.json(); })
      .then(function(data){
        if (data.ok && data.result && data.result.length > 0) {
          // Find the last message
          for (var i = data.result.length - 1; i >= 0; i--) {
            var item = data.result[i];
            var msg = item.message || item.channel_post || item.edited_message;
            if (msg && msg.chat && msg.chat.id) {
              var foundId = String(msg.chat.id);
              localStorage.setItem('arzuz_tg_chat', foundId);
              if (window.ARZUZ_CONFIG) window.ARZUZ_CONFIG.TELEGRAM_CHAT_ID = foundId;
              return foundId;
            }
          }
        }
        return null;
      });
  }

  function formatMessage(table, payload){
    var p = payload || {};
    var title = "";
    var lines = [];

    if (table === 'demand_records') {
      title = "🚀 *New Student Housing Request*";
      lines.push("• *First Name:* " + (p.first || p.first_name || "N/A"));
      lines.push("• *Room Type:* " + (p.type || p.room_type || "N/A"));
      lines.push("• *Budget:* " + (p.budget || p.budget_band || "N/A"));
      lines.push("• *Distance:* " + (p.dist || p.distance || "N/A"));
      lines.push("• *Timing:* " + (p.when || p.timing || "N/A"));
      lines.push("• *Age Band:* " + (p.age || p.age_band || "N/A"));
      lines.push("• *WhatsApp:* " + (p.phone || "N/A"));
      if (p.g_phone) lines.push("• *Guardian Phone:* " + p.g_phone + " (" + (p.g_name || "Guardian") + ")");
      if (p.pain) lines.push("• *Current Issue:* " + p.pain);
    } 
    else if (table === 'listings') {
      title = "🏠 *New Landlord Property Listing*";
      if (p.prop_name) lines.push("• *Property Name:* " + p.prop_name);
      lines.push("• *Owner Name:* " + (p.nm || p.owner_name || "N/A"));
      lines.push("• *Property Type:* " + (p.ty || p.property_type || "N/A"));
      lines.push("• *Area/Street:* " + (p.ar || p.area || "N/A"));
      lines.push("• *Rooms Free:* " + (p.rm || p.rooms || "N/A"));
      lines.push("• *Rent per Session:* ₦" + Number(p.rent || p.listed_price_ngn || 0).toLocaleString());
      lines.push("• *Negotiable:* " + (p.neg || "N/A"));
      lines.push("• *Run By:* " + (p.who || "N/A"));
      lines.push("• *WhatsApp:* " + (p.ph || p.owner_phone || "N/A"));
      if (p.photo) lines.push("• *Photo:* [View Photo](" + p.photo + ")");
    } 
    else if (table === 'scout_submissions') {
      title = "🔍 *New Building Scout Report*";
      lines.push("• *First Name:* " + (p.first || p.first_name || "N/A"));
      lines.push("• *Area/Street:* " + (p.area || "N/A"));
      lines.push("• *Rooms in Building:* " + (p.rooms || "N/A"));
      lines.push("• *Rent Paid:* ₦" + Number(p.amt || p.rent_reported || 0).toLocaleString());
      lines.push("• *Rent Collector:* " + (p.who || "N/A"));
      lines.push("• *Vacancy Signal:* " + (p.vac || "N/A"));
      lines.push("• *WhatsApp:* " + (p.phone || "N/A"));
      if (p.photo) lines.push("• *Photo:* [View Photo](" + p.photo + ")");
    } 
    else {
      title = "📝 *New Form Submission (" + table + ")*";
      lines.push("• Payload: " + JSON.stringify(p));
    }

    lines.push("\n📅 *Session:* " + (getConfig().SESSION || '2026/2027'));
    lines.push("📍 *Environment:* " + (getConfig().ENV || 'production'));
    return title + "\n\n" + lines.join("\n");
  }

  /* Dispatches notification to Telegram Bot API */
  function sendTelegram(text, targetChatId){
    var cfg = getConfig();
    var token = cfg.TELEGRAM_BOT_TOKEN;
    var chatId = targetChatId || getChatId();

    if (!token) {
      console.log("[ArzuzNotify] Telegram Bot Token missing.");
      return Promise.resolve(false);
    }

    var doSend = function(cid){
      if (!cid) {
        console.log("[ArzuzNotify] Chat ID missing. Please talk to @arzuzwaitlist_bot on Telegram first.");
        return Promise.resolve(false);
      }
      var url = "https://api.telegram.org/bot" + token + "/sendMessage";
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cid,
          text: text,
          parse_mode: "Markdown"
        })
      }).then(function(res){
        if (!res.ok) throw new Error("Telegram HTTP " + res.status);
        console.log("[ArzuzNotify] Telegram notification sent successfully to chat_id:", cid);
        return true;
      }).catch(function(err){
        console.warn("[ArzuzNotify] Telegram notification failed:", err.message);
        return false;
      });
    };

    if (chatId) {
      return doSend(chatId);
    } else {
      // Try auto-detecting chat ID from getUpdates
      return autoDetectChatId(token).then(function(detectedId){
        return doSend(detectedId);
      });
    }
  }

  /* Public notification trigger */
  function dispatch(table, payload){
    var text = formatMessage(table, payload);
    console.log("[ArzuzNotify] Dispatching notification alert:\n", text);
    
    // Send Telegram Notification
    sendTelegram(text);
    
    return Promise.resolve(true);
  }

  return {
    dispatch: dispatch,
    sendTelegram: sendTelegram,
    autoDetectChatId: autoDetectChatId,
    formatMessage: formatMessage
  };
})();
