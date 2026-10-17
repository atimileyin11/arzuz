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

  /* The site-wide failure vocabulary (assets/api-errors.js), if this
     page loaded it. */
  function E(){ return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }

  /* GoTrue returns errors as {error, error_description} or {msg}. Its
     own sentence is kept when it has one — "Invalid login credentials"
     IS the answer to what the person just did — and a bare status is
     never shown: a 500 on the way to the sign-in endpoint is our side
     of the wire, not a wrong password. */
  function toError(res, body){
    var msg = (body && (body.error_description || body.msg || body.message)) || '';
    if (!msg && (res.status === 400 || res.status === 401)) msg = 'Wrong email or password.';
    var W = E();
    var err = new Error(msg || (W ? W.sentence({ status: res.status })
      : 'Arzuz could not sign you in just now — that is our side, not yours. Try again in a minute.'));
    err.status = res.status;
    if (body && body.error_code) err.code = body.error_code;
    return err;
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
    }).catch(function(err){
      /* fetch() rejects with a TypeError and no status at all when the
         request never left the browser; the sign-in box showed the
         browser's own words for that ("Failed to fetch"). The class has
         a better sentence, and the status the classifier needs. */
      if (err && typeof err.status === 'number') throw err;
      var W = E();
      var wrapped = new Error(W ? W.sentence(err)
        : 'We could not reach Arzuz — check your connection and try again.');
      wrapped.status = (err && err.status) || 0;
      throw wrapped;
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

  /* Role claim from the signed JWT's app_metadata. Managed from the
     dashboard's Settings → Team panel (netlify/functions/team.js)
     or by hand in Supabase → Authentication → Users.

     THE MAPPING IS THE DATABASE'S, DELIBERATELY. public.arzuz_role()
     normalizes operations→support and super_admin→admin, and this
     function decodes the same claim to the same five names, so the
     nav the browser hides and the rows Postgres returns cannot
     disagree. This is the WEAKER of the two gates by design — hiding
     a nav item is a courtesy, the policies are the enforcement (see
     the header of supabase-team-roles.sql).

     Unset (or anything unrecognised) = 'admin'. That is the safe
     default for the main admin's own token and it is why a typo in
     app_metadata can never mint a lesser role by accident: the only
     way to get a restricted login is a role this file knows, written
     by a function that validates it against a closed list. */
  function role(){
    var s = read();
    var tok = s && s.access_token;
    if (!tok) return 'admin';
    try {
      var b64 = String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(escape(atob(b64)));
      var payload = JSON.parse(json);
      var r = payload && payload.app_metadata && payload.app_metadata.role;
      if (r === 'marketing') return 'marketing';
      if (r === 'support' || r === 'operations') return 'support';
      if (r === 'verification') return 'verification';
      if (r === 'finance') return 'finance';
      return 'admin';
    } catch (e) {
      return 'admin';
    }
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
    role:       role,
    signedIn:   signedIn
  };
})();
