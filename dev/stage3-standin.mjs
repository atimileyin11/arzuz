#!/usr/bin/env node
/* ============================================================
   Arzuz — the stage-3 journey, on a local stand-in (DEV ONLY)

   WHAT THIS IS

     A browser-sized stand-in for the two things a page cannot do
     locally: answer for the database, and run the Netlify functions.

       · The DATABASE is PGlite — real PostgreSQL, the same engine
         dev/sql-proof.mjs uses — with every supabase-*.sql file
         applied in the order the runbook documents. So
         public.listing_attest() is the real function, its 180-day
         expiry is the real interval, and public.public_listing_checks
         is the real view. Nothing about the evidence layer is
         re-implemented here.

       · The FUNCTIONS are the real ones. /browse and /rooms/<slug>
         are handled by netlify/functions/browse.js and rooms.js,
         imported with SUPABASE_URL pointed at this server, so the
         markup a browser gets is the markup Netlify would send.

       · The DASHBOARD is the repository's own mock (?mock=1), which
         is where the officer's clicks go. Its listing ids match the
         seeded row below, so the room the officer visits and the
         room the public page draws are the same room.

   THE ONE SEAM, STATED

     The dashboard's network is mocked in the page (dev/admin-mock.js),
     and this server cannot see its fetch. So the journey's ONE handoff
     is explicit: the driver reads the exact p_checks payload the real
     admin.js sent (from the mock's own record) and POSTs it to
     /__dev/attest, which calls the real listing_attest() in PGlite.
     Everything after that point — the decision, the evidence rows, the
     expiry, the public view, both rendered pages — is real SQL and
     real function output. It is not a fixture written to match.

   ROUTES

     GET  /                       the site
     GET  /admin.html?mock=1      the dashboard, on its mock
     GET  /browse                 browse.js, over PGlite
     GET  /rooms/<slug>           rooms.js, over PGlite
     GET  /rest/v1/public_listings
     GET  /rest/v1/public_listing_checks
     POST /rest/v1/rpc/listing_attest   PostgREST's shape, the real function,
                                        the caller decided by the token
     POST /__dev/attest           { id, checks } → real listing_attest()
     POST /__dev/expire           { visit_id } → age that visit past six months
     GET  /__dev/state            the rows, for the driver to assert on

   Run it:  node dev/stage3-standin.mjs [port]
   ============================================================ */

import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8899);
const BASE = 'http://127.0.0.1:' + PORT;

/* The same listing the dashboard's demo seed carries (Sabo Flats, APT-005):
   a live tier-0 room nobody has visited yet. Its id is the agreement
   between the two halves of the journey — the officer's queue and the
   public board must be talking about the same row. */
const LISTING_ID = 'e2b3d4e5-0005-4b2b-8e02-555555555555';
const LISTING_PAYLOAD = {
  apt_id: 'APT-005', custom_id: 'APT-005', prop_name: 'Sabo Flats',
  ty: 'Hostel', ar: 'Sabo Junction', rent: '145000', rm: '2 rooms vacant',
  nm: 'Sabo Caretaker', ph: '08030000055', neg: 'Yes', who: 'A caretaker',
  desc: 'Two rooms off Sabo Junction, a short walk from the campus gate.',
  photo: '', video: '', video_url: '', media: [], split_ok: false,
  ut: ['Borehole water', 'Prepaid meter', 'Gated compound'],
  utilities: ['Borehole water', 'Prepaid meter', 'Gated compound'],
  lat: '9.1911', lng: '4.6652', pin: '9.191100,4.665200'
};

/* The files, in the order LAUNCH-RUNBOOK.md hands them over. Kept in
   step with dev/sql-proof.mjs's FILES by dev/sql-proof.mjs's own run:
   if that suite passes, this order is one Postgres has accepted. */
const FILES = [
  'supabase-schema.sql',
  'supabase-hardening.sql',
  'supabase-listings-updated-at.sql',
  'supabase-location.sql',
  'supabase-public-view.sql',
  'supabase-media-booking.sql',
  'supabase-drafts-support.sql',
  'supabase-draft-sharing.sql',
  'supabase-team-roles.sql',
  'supabase-roommate.sql',
  'supabase-care.sql',
  'supabase-finance.sql',
  'supabase-claims.sql',
  'supabase-waitlist-launch.sql',
  'supabase-verification-rpc.sql',
  'supabase-verification-queue.sql',
  'supabase-verification-evidence.sql',
  'supabase-status-codes.sql',
  'supabase-status-history.sql',
  'supabase-close-public-inserts.sql'
];

/* ------------------------------------------------------------
   the database
   ------------------------------------------------------------ */

const db = await PGlite.create();

console.log('  · booting the Supabase stand-in (roles, auth, defaults)');
await db.exec(`
  create role anon noinherit nologin;
  create role authenticated noinherit nologin;
  create role service_role noinherit nologin bypassrls;

  create schema if not exists auth;

  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create or replace function auth.jwt()
  returns jsonb language sql stable as $fn$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
  $fn$;

  create or replace function auth.role()
  returns text language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.role', true), '')
  $fn$;

  create or replace function auth.uid()
  returns uuid language sql stable as $fn$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $fn$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.jwt(), auth.role(), auth.uid() to anon, authenticated, service_role;
`);

for (const file of FILES) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  process.stdout.write('  · ' + file.padEnd(38));
  await db.transaction((tx) => tx.exec(text));
  console.log('applied');
}

await db.query(
  `insert into public.listings (id, payload, status, tier, env, session, source, opening_ask_ngn)
   values ($1::uuid, $2::jsonb, 'active', 0, 'production', '2026/2027', 'stage3-standin', 150000)
   on conflict (id) do nothing`,
  [LISTING_ID, JSON.stringify(LISTING_PAYLOAD)]
);
console.log('\n  ready — Sabo Flats is live at tier 0, owed a visit\n');

/* ------------------------------------------------------------
   the functions, pointed at this server
   ------------------------------------------------------------ */

process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'stand-in-anon-key';

const browse = await import('../netlify/functions/browse.js');

/* rooms.js reads listing.html from ITS OWN directory — on Netlify that is
   the function bundle, where netlify.toml's included_files has put the page
   and the two shared modules beside it. Nothing local has that layout, so
   build it in a temp directory and evaluate the real source with __dirname
   pointed at it: exactly what scripts/test-rooms.mjs does, and for the same
   reason. Without this the handler 302s to /listing, which is correct for a
   broken deploy and useless for proving the server-rendered page. */
const rooms = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arzuz-stage3-rooms-'));
  for (const f of ['listing.html', '404.html']) {
    await copyFile(join(ROOT, f), join(dir, f));
  }
  for (const f of ['listing-url.js', 'verification-badge.js']) {
    await copyFile(join(ROOT, 'assets', f), join(dir, f));
  }
  const src = readFileSync(join(ROOT, 'netlify', 'functions', 'rooms.js'), 'utf8');
  const shim = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', 'process', 'fetch', src);
  fn(shim, shim.exports, require, dir, process, global.fetch);
  console.log('  · rooms.js loaded from a bundle at ' + dir);
  return shim.exports;
})();

/* ------------------------------------------------------------
   helpers
   ------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4'
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function eq(url, name) {
  const v = url.searchParams.get(name);
  if (!v || !v.startsWith('eq.')) return null;
  return v.slice(3);
}

function limitOf(url, fallback) {
  const n = Number(url.searchParams.get('limit'));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : fallback;
}

/* The stand-in's whole PostgREST surface: the two public reads. Anything
   else answers 404 loudly, so a page that starts asking for a third
   relation fails here instead of silently getting an empty array. */
async function rest(url, res) {
  const table = url.pathname.replace('/rest/v1/', '');

  if (table === 'public_listings') {
    const { rows } = await db.query('select * from public.public_listings order by created_at desc');
    const id = eq(url, 'id');
    const selected = id ? rows.filter((r) => r.id === id) : rows;
    return json(res, 200, selected.slice(0, limitOf(url, 500)));
  }

  if (table === 'public_listing_checks') {
    const { rows } = await db.query('select * from public.public_listing_checks order by checked_at desc');
    const id = eq(url, 'listing_id');
    const selected = id ? rows.filter((r) => r.listing_id === id) : rows;
    return json(res, 200, selected.slice(0, limitOf(url, 4000)));
  }

  return json(res, 404, { message: 'the stand-in answers only the two public reads, not ' + table });
}

/* The real listing_attest(), as one set of claims. SECURITY DEFINER
   means the insert runs as the owner, exactly as it does on Supabase;
   the claims are what decide WHICH role the call is allowed as. */
async function callAttest(id, checks, claims) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(
      `select set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.role', 'authenticated', true)`,
      [JSON.stringify(claims)]
    );
    const { rows } = await tx.query(
      'select public.listing_attest($1::uuid, $2::jsonb) as result',
      [id, JSON.stringify(checks)]
    );
    return rows[0].result;
  });
}

function attest(body) {
  return callAttest(body.id, body.checks, {
    sub: 'aaaaaaaa-0000-4000-8000-000000000001',
    email: 'officer@arzuz.test',
    role: 'authenticated',
    app_metadata: { role: 'admin' }
  });
}

/* ------------------------------------------------------------
   the RPC, as PostgREST would serve it

   WHY THIS EXISTS. The dashboard's visit form is the only caller of
   listing_attest(), and it posts to /rest/v1/rpc/listing_attest. A
   browser refusal is only worth the words it shows, so the page has
   to be answered by the real function — not by dev/admin-mock.js's
   copy of its sentences. This route takes the page's own token, reads
   app_metadata.role out of it (which is what arzuz_role() reads), and
   calls the function as `authenticated`.

   The signature is NOT checked: this is a loopback-only dev server
   that never handles a real session, and its job is the database's
   answer, not Supabase Auth's. The sub is normalised to a UUID only
   because the mock token's is the string "mock-user" and auth.uid()
   casts. Everything that decides the answer — the role, the email, the
   payload — is the page's own.

   The failure shape is PostgREST's: { code, message, details, hint },
   with SQLSTATE mapped to the status the dashboard branches on
   (42501 → 403, 22023 → 400, P0002 → 404). That mapping is the same
   one dev/admin-mock.js documents, and the sentence in `message` is
   the function's, unprefixed and unedited. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEV_SUB = 'aaaaaaaa-0000-4000-8000-000000000002';

function claimsOf(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let payload = {};
  try {
    payload = JSON.parse(Buffer.from(String(bearer).split('.')[1] || '', 'base64url').toString('utf8'));
  } catch (e) { payload = {}; }
  const role = (payload.app_metadata && payload.app_metadata.role) || 'anon';
  return {
    sub: UUID_RE.test(String(payload.sub || '')) ? payload.sub : DEV_SUB,
    email: payload.email || null,
    role: 'authenticated',
    app_metadata: { role }
  };
}

function rpcStatus(code) {
  if (code === '42501') return 403;
  if (code === 'P0002') return 404;
  return 400;
}

async function rpcAttest(req, res) {
  const body = await readBody(req);
  try {
    return json(res, 200, await callAttest(body.p_id, body.p_checks, claimsOf(req)));
  } catch (err) {
    return json(res, rpcStatus(err.code), {
      code: err.code || 'P0001',
      message: err.message,
      details: null,
      hint: null
    });
  }
}

async function sendFunction(res, result) {
  const headers = Object.assign({}, result.headers || {});
  /* The functions send a minute of public caching — right on Netlify,
     wrong here: the whole point is to see the board change after the
     visit without waiting out a cache. */
  headers['Cache-Control'] = 'no-store';
  res.writeHead(result.statusCode || 200, headers);
  res.end(result.body || '');
}

/* ------------------------------------------------------------
   static files (config.js is the one rewrite: the room page's own
   repaint must ask THIS server, not the production project)
   ------------------------------------------------------------ */

async function serveStatic(pathname, res) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403); return res.end();
  }
  let body;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    body = await readFile(file);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found: ' + p);
  }

  if (p === '/assets/config.js') {
    body = Buffer.from(String(body).replace(
      /SUPABASE_URL:\s*'[^']*'/,
      "SUPABASE_URL: '" + BASE + "'"
    ), 'utf8');
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ------------------------------------------------------------
   the server
   ------------------------------------------------------------ */

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const path = url.pathname;
  try {
    /* The one POST PostgREST-shaped route, before the read-only branch. */
    if (path === '/rest/v1/rpc/listing_attest' && req.method === 'POST') {
      return await rpcAttest(req, res);
    }
    if (path.startsWith('/rest/v1/')) return await rest(url, res);

    if (path === '/__dev/state' && req.method === 'GET') {
      const listing = (await db.query('select id, status, tier, verified_at, verified_by, assigned_to from public.listings where id = $1', [LISTING_ID])).rows[0];
      const evidence = (await db.query('select listing_id, visit_id, kind, detail, checked_at, expires_at, officer from public.listing_evidence order by checked_at desc')).rows;
      const publicRows = (await db.query('select listing_id, visit_id, kind, detail, checked_at, expires_at from public.public_listing_checks')).rows;
      /* The shift trail too, so a refusal can be shown to have written
         NOTHING — listing_evidence and verification_events are separate
         tables, and "nothing was written" is a claim about both. (The
         decision itself has no trail table: listing_verify() moves the
         listing row, which is the `listing` above.) */
      const events = (await db.query('select id, listing_id, at, event, actor, actor_role from public.verification_events order by at desc')).rows;
      return json(res, 200, { listing, evidence, publicRows, events });
    }

    if (path === '/__dev/attest' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, await attest(body));
      } catch (err) {
        return json(res, 400, { error: err.message, code: err.code });
      }
    }

    if (path === '/__dev/expire' && req.method === 'POST') {
      const body = await readBody(req);
      const { rows } = await db.query(
        `update public.listing_evidence
            set checked_at = checked_at - interval '181 days',
                expires_at = expires_at - interval '181 days'
          where visit_id = $1::uuid
          returning kind, checked_at, expires_at`,
        [body.visit_id]
      );
      return json(res, 200, { aged: rows.length, rows });
    }

    if (path === '/browse') {
      return await sendFunction(res, await browse.handler({ path, rawUrl: BASE + req.url }));
    }

    if (/^\/rooms\/.+/.test(path)) {
      return await sendFunction(res, await rooms.handler({ path, rawUrl: BASE + req.url }));
    }

    return await serveStatic(path, res);
  } catch (err) {
    console.error('[standin]', err && err.stack || err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('stand-in error: ' + (err && err.message));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('  → ' + BASE + '/admin.html?mock=1');
  console.log('  → ' + BASE + '/browse\n');
});
