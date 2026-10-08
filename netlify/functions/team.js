/* ============================================================
   Arzuz — Netlify Function: team & role administration

   The ONLY place the Supabase service-role key is ever used.
   It lives in Netlify as SUPABASE_SERVICE_ROLE_KEY and never
   reaches a browser — the dashboard calls this endpoint with
   the signed-in admin's own JWT, which is verified against
   Supabase GoTrue before any admin operation runs.

   Actions (POST /api/team, JSON):
     list            → teammates: id, email, role, last sign-in
     create          → { email, password, role }  creates the user
     set_role        → { id, role }               'admin' clears it
     reset_password  → { id, password }           new temp password
     delete          → { id }                     removes the user

   Authorization model:
     * the caller must present a valid Supabase access token
     * that token's app_metadata.role must be unset or 'admin'
     * marketing and support logins get 403 — only the main
       admin manages the team.

   GoTrue admin API reference (Supabase):
     GET    /auth/v1/user                (caller token → who is this)
     GET    /auth/v1/admin/users
     POST   /auth/v1/admin/users
     PUT    /auth/v1/admin/users/{id}
     DELETE /auth/v1/admin/users/{id}
   ============================================================ */

const ROLES = ['marketing', 'support'];   // 'admin' = unset role

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/* SUPABASE_URL is public (it ships in config.js and the other
   functions) so it falls back to the known value; the service-role
   key is a secret and must come from the environment. `ready` is
   therefore really "the secret is present". */
const SUPABASE_URL_FALLBACK = 'https://nihdbhjecdkpvzvjifrm.supabase.co';

function cfg() {
  const url = (process.env.SUPABASE_URL || process.env.SUPABASE_URL_KEY || SUPABASE_URL_FALLBACK).replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, serviceKey, ready: !!serviceKey };
}

function adminHeaders() {
  const { serviceKey } = cfg();
  return { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
}

/* Who is calling? GoTrue answers with the user object when the
   bearer token is live, 401 when it is not. */
async function verifyCaller(callerToken) {
  const { url, serviceKey } = cfg();
  const res = await fetch(url + '/auth/v1/user', {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + callerToken },
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  if (!user || !user.id) return null;
  const role = user.app_metadata && user.app_metadata.role;
  if (role && role !== 'admin') return null;   // only the main admin
  return user;
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email || '',
    role: (u.app_metadata && u.app_metadata.role) || 'admin',
    created_at: u.created_at || null,
    last_sign_in_at: u.last_sign_in_at || null,
    confirmed: !!u.email_confirmed_at || !!u.confirmed_at,
  };
}

async function goTrue(method, path, body) {
  const { url } = cfg();
  const res = await fetch(url + path, {
    method,
    headers: adminHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.msg || data.error_description || data.message || ('GoTrue HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const { ready } = cfg();
  if (!ready) {
    return json(503, {
      error: 'Team management is not configured: SUPABASE_SERVICE_ROLE_KEY is missing in Netlify. Add it under Site settings → Environment variables (Supabase → Project Settings → API → service_role key), then redeploy.',
    });
  }

  const callerToken = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!callerToken) return json(401, { error: 'Sign in to the dashboard first.' });

  let caller;
  try {
    caller = await verifyCaller(callerToken);
  } catch (err) {
    return json(502, { error: 'Could not verify your session: ' + err.message });
  }
  if (!caller) return json(403, { error: 'Only the main admin can manage the team.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }
  const action = body.action || 'list';
  const role = body.role;

  try {
    /* --- list --- */
    if (action === 'list') {
      const data = await goTrue('GET', '/auth/v1/admin/users?per_page=200');
      const users = (data.users || []).map(publicUser);
      users.sort((a, b) => String(a.email).localeCompare(String(b.email)));
      return json(200, { users });
    }

    /* --- create --- */
    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });
      if (password.length < 10) return json(400, { error: 'Temporary password must be at least 10 characters.' });
      if (role && !ROLES.includes(role)) return json(400, { error: 'Unknown role: ' + role });
      const app_metadata = role ? { role } : {};
      const user = await goTrue('POST', '/auth/v1/admin/users', {
        email, password, email_confirm: true, app_metadata,
      });
      return json(200, { user: publicUser(user) });
    }

    /* --- set_role / reset_password / delete need a user id --- */
    const id = String(body.id || '');
    if (!id) return json(400, { error: 'Missing user id.' });

    if (action === 'set_role') {
      if (role && !ROLES.includes(role)) return json(400, { error: 'Unknown role: ' + role });
      if (id === caller.id) return json(400, { error: 'You cannot change your own role — ask another main admin.' });
      /* preserve any other app_metadata keys; 'admin' is represented
         by REMOVING the role key, exactly like the manual flow */
      const existing = await goTrue('GET', '/auth/v1/admin/users?id=' + encodeURIComponent(id));
      const found = (existing.users && existing.users[0]) || null;
      if (!found) return json(404, { error: 'User not found.' });
      const app_metadata = Object.assign({}, found.app_metadata || {});
      if (role) app_metadata.role = role;
      else delete app_metadata.role;
      const user = await goTrue('PUT', '/auth/v1/admin/users/' + encodeURIComponent(id), { app_metadata });
      return json(200, { user: publicUser(user) });
    }

    if (action === 'reset_password') {
      const password = String(body.password || '');
      if (password.length < 10) return json(400, { error: 'Temporary password must be at least 10 characters.' });
      await goTrue('PUT', '/auth/v1/admin/users/' + encodeURIComponent(id), { password });
      return json(200, { ok: true });
    }

    if (action === 'delete') {
      if (id === caller.id) return json(400, { error: 'You cannot remove your own account.' });
      await goTrue('DELETE', '/auth/v1/admin/users/' + encodeURIComponent(id));
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('[team]', action, err.message);
    return json(502, { error: err.message });
  }
};
