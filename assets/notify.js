/* ============================================================
   Arzuz — Telegram notification client

   All this does is tell /api/notify what happened. The bot token,
   the chat id and the message formatting live in the Netlify
   Function (netlify/functions/notify.js), because a token in the
   page source is a token anyone can use.

   Failures are deliberately silent to the user: an alert that
   does not go out must never break a student's submission.
   ============================================================ */

var ArzuzNotify = (function(){

  function call(payload){
    return fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(body){
        /* The alert function's own sentence, and its CLASS — a 503 that
           means "TELEGRAM_BOT_TOKEN is missing in Netlify" is a deploy to
           finish, not a minute to wait out, and the caller decides
           whether to mention it at all based on which it is. */
        if (!r.ok) {
          if (typeof ArzuzApiErrors !== 'undefined') throw ArzuzApiErrors.failed(r, body);
          /* A log line either way, but it keeps the function's sentence
             and the status the caller would need to act on it. */
          var plain = new Error((body && body.error) || 'Arzuz could not send that alert.');
          plain.status = r.status || 0;
          throw plain;
        }
        return body;
      });
    });
  }

  /* Called by ArzuzSubmit after a row has actually been saved. */
  function dispatch(table, payload){
    return call({ action: 'send', table: table, payload: payload })
      .then(function(){
        console.log('[ArzuzNotify] alert sent for', table);
        return true;
      })
      .catch(function(err){
        console.warn('[ArzuzNotify] alert failed:', err.message);
        return false;
      });
  }

  /* Admin dashboard helpers */
  function status(){  return call({ action: 'status' }); }
  function detect(){  return call({ action: 'detect' }); }
  function test(){    return call({ action: 'test' }); }

  return {
    dispatch: dispatch,
    status:   status,
    detect:   detect,
    test:     test
  };
})();
