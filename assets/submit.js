/* ============================================================
   Arzuz — submission & database integration layer

   Sends form answers directly to Supabase REST API endpoints.
   Built resiliently for 3G/unstable network connections:
   if network fails, submissions are queued locally and automatically
   flushed when online.
   ============================================================ */

var ArzuzSubmit = (function(){

  var QUEUE_KEY = 'arzuz_queue_v1';

  /* Always read live from window.ARZUZ_CONFIG */
  function cfg(){ return window.ARZUZ_CONFIG || {}; }

  function configured(){
    var c = cfg();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
  }

  function showToast(message, type){
    if (typeof document === 'undefined') return;
    var container = document.querySelector('.arzuz-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'arzuz-toast-container';
      document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    toast.className = 'arzuz-toast ' + (type || 'info');
    toast.innerHTML = '<span>' + message + '</span>';
    container.appendChild(toast);

    setTimeout(function(){
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(function(){ toast.remove(); }, 300);
    }, 4000);
  }

  function readQueue(){
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch(e){ return []; }
  }

  function writeQueue(q){
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-60))); }
    catch(e){ /* storage limit */ }
  }

  function enqueue(item){
    var q = readQueue(); 
    q.push(item); 
    writeQueue(q);
  }

  /* POST request to Supabase REST API */
  function post(table, row){
    if (!configured()) return Promise.reject(new Error('Supabase configuration missing'));
    var c = cfg();
    var url = c.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + table;
    var key = c.SUPABASE_ANON_KEY;

    // Build headers — support both classic JWT anon keys (eyJ…)
    // and the newer sb_publishable_… key format.
    var headers = {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };
    if (key && key.indexOf('sb_publishable') === 0) {
      headers['sb-anon-key'] = key;
    }

    console.log('[ArzuzSubmit] POSTing to:', url, '\nPayload:', JSON.stringify(row, null, 2));
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(row) })
      .then(function(r){
        if (!r.ok) {
          return r.text().then(function(body){
            console.error('[ArzuzSubmit] ❌ Supabase error', r.status, body);
            throw new Error('HTTP ' + r.status + ' — ' + body);
          });
        }
        console.log('[ArzuzSubmit] ✅ Row saved to', table);
        return true;
      });
  }

  function decorate(answers){
    var c = cfg();
    return {
      payload: answers,
      session: c.SESSION || '2026/2027',
      env: c.ENV || 'production',
      source: window.location.pathname.replace(/^\//,'') || 'index.html',
      referrer: document.referrer ? document.referrer.slice(0,300) : null,
      user_agent: navigator.userAgent.slice(0,300)
    };
  }

  /* Public submission handler */
  function send(table, answers){
    var row = decorate(answers);

    console.log('[ArzuzSubmit] Submitting to table:', table, '\nAnswers:', answers);

    // Trigger instant Telegram/Email notification dispatch
    if (typeof ArzuzNotify !== 'undefined') {
      ArzuzNotify.dispatch(table, answers);
    }

    // Send WhatsApp confirmation to the submitter
    if (typeof ArzuzWhatsApp !== 'undefined') {
      ArzuzWhatsApp.sendConfirmation(table, answers);
    }

    if(!configured()){
      console.warn('[ArzuzSubmit] Supabase not configured — stored locally for preview.', table, row);
      enqueue({table:table, row:row, at:Date.now()});
      showToast('Saved locally in preview mode.', 'queued');
      return Promise.resolve({ok:false, queued:true, reason:'not-configured'});
    }

    return post(table, row)
      .then(function(){ 
        flush(); 
        showToast('Successfully saved to database!', 'success');
        return {ok:true, queued:false}; 
      })
      .catch(function(err){
        console.warn('[ArzuzSubmit] Submission queued for retry:', err.message);
        enqueue({table:table, row:row, at:Date.now()});
        showToast('Connection issue — queued for auto-retry when online.', 'queued');
        return {ok:false, queued:true, reason:err.message};
      });
  }

  /* Flush queued items when back online */
  function flush(){
    if(!configured()) return;
    var q = readQueue();
    if(!q.length) return;
    writeQueue([]);                       
    q.forEach(function(item){
      post(item.table, item.row).catch(function(){ enqueue(item); });
    });
  }

  function pending(){ return readQueue().length; }

  if(typeof window !== 'undefined'){
    window.addEventListener('online', function(){
      flush();
      showToast('Back online — flushing pending submissions...', 'info');
    });
    setTimeout(flush, 1500);
  }

  return { 
    send: send, 
    flush: flush, 
    pending: pending, 
    configured: configured,
    showToast: showToast 
  };
})();
