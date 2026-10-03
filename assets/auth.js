/* ============================================================
   Arzuz — Supabase Auth session for the admin dashboard

   The public site only ever inserts rows, so it never signs in.
   admin.html does: this module exchanges an email + password for
   a Supabase JWT and hands every dashboard query that token
   instead of the anon key.

   No SDK and no build step — plain fetch against the GoTrue REST
   endpoints, same style as the rest of the site. The session
   lives in sessionStorage so closing the tab signs you out.

   This is what the RLS policies in supabase-schema.sql are keyed
   on: reads, updates and deletes are granted `to authenticated`
   and to nobody else.
   ============================================================ */

var ArzuzAuth = (function(){

  var KEY = 'arzuz_session_v1';

  function cfg(){ return window.ARZUZ_CONFIG || {}; }
  function anonKey(){ return cfg().SUPABASE_ANON_KEY || ''; }
  function root(){
    var u = cfg().SUPABASE_URL || '';
    return u.replace(/\/+$/, '');
  }

  function configured(){
    return !!(cfg().SUPABASE_URL && cfg().SUPABASE_ANON_KEY);
  }

  function read(){
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); }
    catch(e){ return null; }
  }

  function save(s){
    try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch(e){}
    return s;
  }

  function clear(){
    try { sessionStorage.removeItem(KEY); } catch(e){}
  }

  function expired(s){
    if (!s || !s.access_token) return true;
    if (!s.expires_at) return false;
    // 30s of headroom so a token does not die mid-request
    return Date.now() > (s.expires_at - 30000);
  }

  /* GoTrue returns errors as {error, error_description} or {msg}. */
  function toError(res, body){
    var msg = (body && (body.error_description || body.msg || body.message)) || '';
    if (!msg && res.status === 400) msg = 'Wrong email or password.';
    if (!msg) msg = 'Sign-in failed (HTTP ' + res.status + ').';
    return new Error(msg);
  }

  function goTrue(path, payload){
    if (!configured()) return Promise.reject(new Error('Supabase is not configured in assets/config.js.'));
    return fetch(root() + '/auth/v1/' + path, {
      method: 'POST',
      headers: {
        'apikey': anonKey(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(body){
        if (!res.ok) throw toError(res, body);
        return {
          access_token:  body.access_token,
          refresh_token: body.refresh_token,
          expires_at:    Date.now() + ((body.expires_in || 3600) * 1000),
          email:         (body.user && body.user.email) || payload.email || ''
        };
      });
    });
  }

  function signIn(email, password){
    return goTrue('token?grant_type=password', { email: email, password: password }).then(save);
  }

  function refresh(s){
    if (!s || !s.refresh_token) { clear(); return Promise.resolve(null); }
    return goTrue('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(save)
      .catch(function(){ clear(); return null; });
  }

  /* Resolves to a usable session, refreshing it if needed, or null. */
  function restore(){
    if (!configured()) return Promise.resolve(null);
    var s = read();
    if (!s) return Promise.resolve(null);
    if (!expired(s)) return Promise.resolve(s);
    return refresh(s);
  }

  function signOut(){
    var s = read();
    clear();
    if (!s || !s.access_token) return Promise.resolve();
    return fetch(root() + '/auth/v1/logout', {
      method: 'POST',
      headers: { 'apikey': anonKey(), 'Authorization': 'Bearer ' + s.access_token }
    }).catch(function(){ /* the local session is already gone */ });
  }

  /* Headers for a Supabase REST call: anon key as apikey (always
     public by design) and the signed-in JWT as the bearer token. */
  function headers(){
    return restore().then(function(s){
      if (!s) throw new Error('Your admin session has expired. Please sign in again.');
      return {
        'apikey': anonKey(),
        'Authorization': 'Bearer ' + s.access_token,
        'Content-Type': 'application/json'
      };
    });
  }

  function email(){
    var s = read();
    return (s && s.email) || '';
  }

  function signedIn(){
    return !!read();
  }

  return {
    configured: configured,
    signIn:     signIn,
    restore:    restore,
    signOut:    signOut,
    headers:    headers,
    clear:      clear,
    email:      email,
    signedIn:   signedIn
  };
})();
