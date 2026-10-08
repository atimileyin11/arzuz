/* ============================================================
   Arzuz — submission & database integration layer

   Sends form answers directly to Supabase REST API endpoints.
   Built resiliently for 3G/unstable network connections:
   if network fails, submissions are queued locally and automatically
   flushed when online.
   ============================================================ */

var ArzuzSubmit = (function(){

  var QUEUE_KEY = 'arzuz_queue_v1';
  var QUEUE_MAX = 200;   // how many submissions localStorage will hold

  /* One id per submission. Supabase stores it in client_ref (unique),
     so a retry after a dropped connection is ignored instead of
     written twice — see supabase-hardening.sql. */
  function uuid(){
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch(e){}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random() * 16 | 0;
      var v = (c === 'x') ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

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
    var capped = q.slice(-QUEUE_MAX);
    var dropped = q.length - capped.length;
    if (dropped > 0) {
      // Never lose a submission quietly — the person filling the form
      // is the only one who can re-enter it.
      console.error('[ArzuzSubmit] Offline queue is full — ' + dropped + ' submission(s) dropped:',
        q.slice(0, dropped).map(function(i){ return i.table; }));
      showToast('Offline queue is full — ' + dropped + ' submission(s) were lost. Please submit again.', 'queued');
    }
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(capped)); }
    catch(e){ showToast('This device cannot store more submissions offline.', 'queued'); }
  }

  function enqueue(item){
    var q = readQueue(); 
    q.push(item); 
    writeQueue(q);
  }

  /* POST request to Supabase REST API, keyed on client_ref so a retry
     can never duplicate a row. */
  function post(table, row){
    if (!configured()) return Promise.reject(new Error('Supabase configuration missing'));
    var c = cfg();
    var base = c.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + table;
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

    var url = base;

    console.log('[ArzuzSubmit] POSTing to:', url, '\nPayload:', JSON.stringify(row, null, 2));

    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(row) })
      .then(function(r){
        if (r.ok) {
          console.log('[ArzuzSubmit] ✅ Row saved to', table);
          return true;
        }
        return r.text().then(function(body){
          if (r.status === 409) {
            console.log('[ArzuzSubmit] Already saved (client_ref duplicate) — treated as success');
            return true;
          }
          // client_ref is missing: the hardening SQL has not been run yet.
          // Losing retry safety beats losing the submission entirely.
          if (row.client_ref && /client_ref/.test(body)) {
            console.warn('[ArzuzSubmit] client_ref column missing — run supabase-hardening.sql. Retrying without it.');
            var plain = {};
            Object.keys(row).forEach(function(k){ if (k !== 'client_ref') plain[k] = row[k]; });
            var retryHeaders = {};
            Object.keys(headers).forEach(function(k){ if (k !== 'Prefer') retryHeaders[k] = headers[k]; });
            return fetch(base, { method: 'POST', headers: retryHeaders, body: JSON.stringify(plain) })
              .then(function(r2){
                if (!r2.ok) return r2.text().then(function(t2){ throw new Error('HTTP ' + r2.status + ' — ' + t2); });
                console.log('[ArzuzSubmit] ✅ Row saved to', table, '(without client_ref)');
                return true;
              });
          }
          console.error('[ArzuzSubmit] ❌ Supabase error', r.status, body);
          throw new Error('HTTP ' + r.status + ' — ' + body);
        });
      });
  }

  /* Called only once a row is confirmed saved. Telling someone they are
     "on the list" before the insert has succeeded is a promise the
     database never agreed to. */
  function deliver(table, row){
    try {
      if (typeof ArzuzNotify !== 'undefined') ArzuzNotify.dispatch(table, row.payload);
    } catch(e){ console.warn('[ArzuzSubmit] notify failed:', e.message); }
    try {
      if (typeof ArzuzWhatsApp !== 'undefined') ArzuzWhatsApp.sendConfirmation(table, row.payload);
    } catch(e){ console.warn('[ArzuzSubmit] WhatsApp confirmation failed:', e.message); }
  }

  /* The row that reaches Supabase: a shallow COPY of the form answers
     plus the request context. payload.ref is the marketing channel tag
     captured by assets/attribution.js — the Growth view counts it per
     channel, which is what makes ?ref= links measurable at all.

     Why a copy instead of handing `answers` straight through:
     listing.html stamps listing_id / roommate / apt_ref onto the very
     object it passes us, and the attribution key must not ride back
     into the page's own state. */
  function decorate(answers){
    var c = cfg();
    var payload = {};
    Object.keys(answers || {}).forEach(function(k){ payload[k] = answers[k]; });

    /* Attribution is best-effort. A missing, blocked or broken module
       must never stop a student's submission from going through. */
    try {
      var tag = (typeof ArzuzRef !== 'undefined' && ArzuzRef.tag) ? ArzuzRef.tag() : '';
      if (tag) payload.ref = tag;
    } catch(e){}

    return {
      payload: payload,
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
    row.client_ref = uuid();

    console.log('[ArzuzSubmit] Submitting to table:', table, '\nAnswers:', answers);

    if(!configured()){
      console.warn('[ArzuzSubmit] Supabase not configured — stored locally for preview.', table, row);
      enqueue({table:table, row:row, at:Date.now()});
      showToast('Saved locally in preview mode.', 'queued');
      return Promise.resolve({ok:false, queued:true, reason:'not-configured'});
    }

    return post(table, row)
      .then(function(){
        deliver(table, row);           // saved first, told second
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

  /* Flush queued items when back online — notifications fire only for
     the rows that actually made it into the database. */
  function flush(){
    if(!configured()) return;
    var q = readQueue();
    if(!q.length) return;
    writeQueue([]);
    q.forEach(function(item){
      post(item.table, item.row)
        .then(function(){ deliver(item.table, item.row); })
        .catch(function(){ enqueue(item); });
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
