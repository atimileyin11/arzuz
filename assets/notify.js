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
        if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
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
