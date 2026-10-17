/* ============================================================
   Arzuz — submission & database integration layer

   Built resiliently for 3G/unstable network connections: if the
   network fails, submissions are queued locally and automatically
   flushed when online.

   ONE DOOR

     /api/waitlist — netlify/functions/waitlist.js. Validates the
     answers on the server, throttles by address, refuses a filled
     honeypot, deduplicates, mints the reference and inserts with the
     service role. It is what spec §2 asks for, and it is now the ONLY
     way a public form reaches the database.

   THERE USED TO BE A SECOND ONE, AND IT IS GONE ON PURPOSE

     Until the launch migration landed, this file carried a fallback:
     if the door answered 'not-ready' (a deploy with no service key,
     or one that predates the function) it posted straight to
     PostgREST with the anon key from assets/config.js. The reasoning
     was sound — a submission must never be lost to a deploy order —
     and it stopped being sound the moment the door took over the
     write:

       · A row written through the direct path carries no
         `consent_text`, because the sentence is the FUNCTION's. The
         team cannot then say what that person agreed to.
       · It carries no `ref`, so the student has no handle to quote.
       · It is invisible to the throttle and to the audit trail.
       · And nothing tested it. It was reached only by a broken
         deploy, so it was never rehearsed — the reason it was kept
         was that it existed.

     supabase-close-public-inserts.sql revokes anon's INSERT on all
     five public tables, so the fallback would now fail anyway. It is
     removed rather than left in place because a path that can only
     return a missing-grant error is not a fallback: it is a mistake
     waiting for the next reader to trust it. THE DATABASE AND THIS
     FILE WERE CHANGED TOGETHER — restoring one without the other
     gives you either an open API or a page that writes into a 403.

   WHAT HAPPENS WHEN THE DOOR IS 'NOT-READY' INSTEAD

     The submission is not lost and it is not written anywhere else.
     'not-ready' is a deployment fact — the function is not in this
     deploy, or SUPABASE_SERVICE_ROLE_KEY is not set — so the failure
     is classified as one, is QUEUED, and the person is told the
     truth: we have kept what you wrote and will send it when the
     deploy catches up. The queue already retries through this same
     door (flush() below), so the moment the key is set, the rows go
     in through the validation rather than around it.
   ============================================================ */

var ArzuzSubmit = (function(){

  var QUEUE_KEY = 'arzuz_queue_v1';
  var QUEUE_MAX = 200;   // how many submissions localStorage will hold

  /* The site-wide failure vocabulary (assets/api-errors.js). Looked up
     at call time rather than captured, so a page that loads the module
     late still gets it — and so a page that never loads it still cannot
     reach a bare status code through this file.

     Why it is here at all: a submission that the database REFUSES is
     not a connection problem, and until this existed the two were
     reported as the same sentence. */
  function errors(){
    return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null;
  }

  /* What a failed save means, as a class and as words. Never "HTTP 500". */
  function describe(err){
    var E = errors();
    if (E) return E.classify(err);
    return { kind: 'error', reason: 'no-classifier',
      inline: 'Arzuz could not save that just now — that is our side, not yours. ' +
        'Message us on WhatsApp and we will sort it out.' };
  }

  /* What a person is told when the server says the row is already there.
     The reference IS the answer to "am I on the list?", so it is the
     sentence when it came back \u2014 and when it did not, the page says
     that instead of pointing at a reference that is not on the screen. */
  function alreadyOnTheList(ref){
    return ref
      ? 'You are already on the list \u2014 ' + ref + ' is your reference.'
      : 'You are already on the list \u2014 message us on WhatsApp and we will find your place.';
  }

  /* The platform's own answer, kept whole. A PostgREST failure arrives
     as {code, message, details, hint}: the code is the contract, and
     "HTTP 404 — {json}" threw all of it away — which is how a table
     that was never created became indistinguishable from a dropped
     connection, and why a doomed insert sat in the retry queue looking
     like it would work soon. */
  function failFrom(res, body){
    var parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch(e){ parsed = null; }
    var err = new Error((parsed && parsed.message) || ('Arzuz answered ' + res.status));
    err.status = res.status;
    if (parsed && parsed.code) err.code = parsed.code;
    if (parsed && parsed.details) err.details = parsed.details;
    return err;
  }

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

  /* ------------------------------------------------------------
     THE DOOR — netlify/functions/waitlist.js

     A success answers { ok, ref, follow_up_status, duplicate }. A
     duplicate is a SUCCESS with an explanation: the person is already
     on the list and the reference they were given is the answer, not
     an error. A failure is read back through the site's classifier,
     so the class this page branches on is the class the server named.
     ------------------------------------------------------------ */
  function door(table, row){
    if (!configured()) return Promise.reject(new Error('Supabase configuration missing'));

    var body = {
      form: table,
      answers: row.payload,
      client_ref: row.client_ref,
      env: row.env,
      source: row.source,
      referrer: row.referrer,
      user_agent: row.user_agent
    };

    return fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){
      return r.text().then(function(raw){
        if (r.ok) {
          var parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch(e){ parsed = null; }
          /* A 200 THIS PAGE CANNOT READ IS A SAVED ROW, AND IT IS NOT
             EVIDENCE OF A NEW ONE.

             `parsed || { ok: true }` answered an unreadable body with a
             success that carried no `duplicate`, and every caller reads a
             missing `duplicate` as "the server has just written this
             row" \u2014 so it sends the confirmation. That makes the one
             shape this page genuinely cannot interpret the shape that
             ASSUMES the row is new, which is the assumption that messages
             somebody twice for one registration. It cannot tell, so it
             takes the side that cannot double-message: saved, and not
             delivered again. What is actually lost is the reference, and
             the sentence says so rather than pointing at one that is not
             on the screen. */
          if (!parsed) {
            console.warn('[ArzuzSubmit] The door answered 200 with a body this page could not ' +
              'read \u2014 treated as already saved, so no second confirmation goes out.');
            return { ok: true, duplicate: true, ref: '', follow_up_status: 'new',
              note: 'Your answers are saved. We could not read your reference back just now ' +
                '\u2014 message us on WhatsApp and we will look it up for you.' };
          }
          return parsed;
        }
        /* A 409 here is the retry-safety path SUCCEEDING, not a failure:
           client_ref is unique, so the row this submission describes is
           already written and two attempts simply raced. It is answered
           as a saved row that says it is a duplicate, so the page sends
           no second confirmation to somebody who registered once. Left
           to the classifier it would be read as `rejected`, which tells
           a person their submission was refused when in fact it was
           saved. */
        if (r.status === 409) {
          var dup = null;
          try { dup = raw ? JSON.parse(raw) : null; } catch(e){ dup = null; }
          var dref = (dup && dup.ref) || '';
          console.log('[ArzuzSubmit] Already saved (client_ref duplicate) — treated as success' +
            (dref ? ', as ' + dref : ', but the reference did not come back'));
          return { ok: true, duplicate: true, ref: dref,
            follow_up_status: (dup && dup.follow_up_status) || 'new',
            note: dref ? '' : alreadyOnTheList('') };
        }
        var E = errors();
        if (E) throw E.failed(r, raw);
        throw failFrom(r, raw);
      });
    });
  }

  /* THE INVARIANT THIS HAS TO KEEP, in one place.

     A row is saved once and a person is told once, and those are two
     facts. This runs for a row the server said it had just WRITTEN, and
     for nothing else: a duplicate is a row that already existed, so
     delivering it messages somebody who registered once. Every caller
     branches on `duplicate` for that reason, and `door()` never reports
     an answer it could not read as a new row \u2014 if it did, the
     DEFAULT for an unreadable answer would be the second message.

     And telling someone they are "on the list" before the insert has
     succeeded is a promise the database never agreed to, which is why
     this is called after the save and never before it. */
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

    /* The honeypot travels with every submission so that the DATABASE
       can refuse a filled one (the anon insert policies in
       supabase-team-roles.sql). The form engine injects the hidden
       field; this line is what makes it exist even on a page whose
       form predates the field, where an absent key and an empty one
       have to mean the same thing. */
    if (payload.hp === undefined) payload.hp = '';

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
      return Promise.resolve({ok:false, queued:true, kind:'not-ready', reason:'not-configured',
        note:'This deployment has no database attached, so nothing was sent. Your answers are kept on this device — finish the setup and they will sync.'});
    }

    return door(table, row)
      .then(function(res){
        /* A duplicate is not a new row, so it gets no second WhatsApp
           confirmation: the person who already registered would be
           messaged twice for one decision. */
        if (res && res.duplicate) {
          showToast(res.note || alreadyOnTheList(res.ref), 'info');
          flush();
          return {ok:true, queued:false, duplicate:true,
            ref: res.ref || '', follow_up_status: res.follow_up_status || 'new',
            note: res.note || ''};
        }
        deliver(table, row);           // saved first, told second
        flush();
        showToast('Successfully saved to database!', 'success');
        return {ok:true, queued:false, duplicate:false,
          ref: (res && res.ref) || '', follow_up_status: (res && res.follow_up_status) || 'new',
          note: (res && res.note) || ''};
      })
      .catch(function(err){
        var d = describe(err);
        var E = errors();
        console.warn('[ArzuzSubmit] Submission not saved — ' + d.kind + ': ' +
          (E ? E.detail(err) : (err && err.message)));

        /* A REFUSED request is not queued. It will be refused
           identically forever, and a queue that holds it lets this
           page tell someone "we will send it automatically" about
           something that can never succeed — the same silently wrong
           answer the invite page used to give a landlord whose link
           was fine. It is reported, and their answers stay in the
           form. */
        if (E && !E.queueable(err)) {
          showToast(d.inline, 'error');
          return {ok:false, queued:false, kind:d.kind, note:d.inline, reason:d.reason};
        }

        enqueue({table:table, row:row, at:Date.now()});
        var note = E ? E.queueSentence(err) : d.inline;
        showToast(note, 'queued');
        return {ok:false, queued:true, kind:d.kind, note:note, reason:d.reason};
      });
  }

  /* Flush queued items when back online — notifications fire only for
     the rows that actually made it into the database.

     A DUPLICATE IS DROPPED, NOT DELIVERED. The queue's job is to get
     the row saved; a row the server says it already has is saved, and
     delivering it would send a second confirmation to someone who
     registered once. That is exactly the mistake the reference makes
     visible at last. */
  function flush(){
    if(!configured()) return;
    var q = readQueue();
    if(!q.length) return;
    writeQueue([]);
    q.forEach(function(item){
      door(item.table, item.row)
        .then(function(res){
          if (res && res.duplicate) {
            console.log('[ArzuzSubmit] Queued item was already saved as ' + res.ref);
            return;
          }
          deliver(item.table, item.row);
        })
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
