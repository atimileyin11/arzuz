#!/usr/bin/env node
/* ============================================================
   Arzuz — dev server with mocked video endpoints

   Serves the site statically and fakes the two video functions
   so the full upload → masked-player flow can be exercised in a
   browser without Google credentials or a Netlify deploy:

     POST /api/youtube-upload-start   → { uploadUrl: '/api/fake-upload' }
     PUT  /api/fake-upload            → { id: '<demo video id>' }
     GET  /api/video-embed/<id>       → 302 to the nocookie embed
     POST /api/cloudinary-sign        → 503 (fallback is exercised)
     POST /api/notify                 → 200 (Telegram alert swallowed)

   It also stands in for Supabase so the landlord invite form
   (complete-listing.html) can be walked end to end without a token
   or a live database — see dev/complete-listing-harness.html:

     POST /mock/sb/seed                     → set the draft row the page will read,
                                              and any scripted failure (seed.fail) so
                                              the page's failure copy can be walked:
                                              { status, code, message } or { drop: true }
     POST /mock/sb/rest/v1/rpc/listing_draft_get    → that row (null when revoked)
     POST /mock/sb/rest/v1/rpc/listing_draft_update → merge the patch, echo the id
     GET  /mock/sb/last-patch               → { patch, writes } for assertions
     POST /mock/cloudinary/<kind>/upload    → { secure_url } (harness rewrites to it)

   Run:  node dev/upload-mock-server.mjs [port]     (default 8799)
   Then: http://localhost:8799/dev/video-test.html
         http://localhost:8799/dev/complete-listing-harness.html?ref=<uuid>
   ============================================================ */

import http from 'http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8799);
const DEMO_ID = 'aqz-KE-bpKQ';   // public demo video so playback really plays

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => resolve(size));
  });
}

function readText(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/* ---- mock Supabase for the landlord invite form ---- */
const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const MOCK_SB = {
  row: null,          // seeded draft row (null = revoked / unknown token)
  patch: null,        // last patch the page sent
  writes: [],         // every patch, in order
  completedAt: null,
  /* A scripted failure per route, so the page's own words for each
     class can be exercised in a browser. `drop` is the network
     going away instead of answering. */
  fail: { get: null, update: null },
};

/* The recorded shapes (dev/admin-test-report.md §20): a relation the
   schema cache does not have, a grant this page does not hold, a token
   that is not a uuid, and a connection that never arrives. */
function failWith(res, which) {
  const f = MOCK_SB.fail[which];
  if (!f) return false;
  if (f.drop) {
    console.log('[mock] ' + which + ': dropping the connection (the offline class)');
    res.destroy();
    return true;
  }
  console.log('[mock] ' + which + ': HTTP ' + f.status + ' ' + (f.code || ''));
  json(res, f.status, { code: f.code || null, details: null, hint: null, message: f.message || '' });
  return true;
}

function defaultRow() {
  return {
    id: DRAFT_ID,
    status: 'draft',
    draft_permission: 'edit',
    draft_expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    draft_completed_at: null,
    draft_last_saved_at: null,
    opening_ask_ngn: null,
    payload: {
      prop_name: '', ty: 'Self-contain', ar: '', rent: '', rm: 'Units available',
      avail: 'vacant', units: null, nm: '', ph: '', contact_role: '', who: '',
      desc: '', ut: [], utilities: [], media: [], photo: '', video: '', video_url: '',
      split_ok: false, pin_meta: null, passage: null,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  /* ---- mocked functions ---- */
  if (url.pathname === '/api/youtube-upload-start' && req.method === 'POST') {
    const raw = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const meta = JSON.parse(raw || '{}');
    console.log('[mock] start session:', meta.filename, meta.size, 'bytes');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ uploadUrl: '/api/fake-upload?session=demo', maxBytes: 200 * 1024 * 1024 }));
    return;
  }
  if (url.pathname === '/api/fake-upload' && req.method === 'PUT') {
    const bytes = await readBody(req);
    console.log('[mock] received', bytes, 'bytes → video id', DEMO_ID);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: DEMO_ID }));
    return;
  }
  if (url.pathname.startsWith('/api/video-embed/')) {
    const id = url.pathname.split('/').pop();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) { res.writeHead(404); res.end('bad id'); return; }
    const params = new URLSearchParams({
      controls: url.searchParams.get('controls') === '1' ? '1' : '0',
      rel: '0', modestbranding: '1', iv_load_policy: '3', fs: '0', disablekb: '1',
      playsinline: '1', enablejsapi: '1',
    });
    if (url.searchParams.get('autoplay') === '1') params.set('autoplay', '1');
    res.writeHead(302, { Location: 'https://www.youtube-nocookie.com/embed/' + id + '?' + params });
    res.end();
    return;
  }
  if (url.pathname === '/api/cloudinary-sign') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Cloudinary not mocked here (video fallback exercised)' }));
    return;
  }
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    const raw = await readText(req);
    console.log('[mock] notify:', raw.slice(0, 200));
    json(res, 200, { ok: true });
    return;
  }

  /* ---- mock Supabase (landlord invite form) ---- */
  if (url.pathname === '/mock/sb/seed' && req.method === 'POST') {
    const seed = JSON.parse((await readText(req)) || '{}');
    MOCK_SB.row = Object.assign(defaultRow(), seed.row || {});
    if (seed.row && seed.row.payload) {
      MOCK_SB.row.payload = Object.assign(defaultRow().payload, seed.row.payload);
    }
    /* `revoked` is the one way to reach the mock's own null row — the
       token that matches nothing, which is the only failure that
       really is about the link. */
    if (seed.revoked) MOCK_SB.row = null;
    MOCK_SB.fail = Object.assign({ get: null, update: null }, seed.fail || {});
    MOCK_SB.patch = null;
    MOCK_SB.writes = [];
    MOCK_SB.completedAt = MOCK_SB.row ? (MOCK_SB.row.draft_completed_at || null) : null;
    json(res, 200, { ok: true, row: MOCK_SB.row });
    return;
  }
  if (url.pathname === '/mock/sb/rest/v1/rpc/listing_draft_get' && req.method === 'POST') {
    const body = JSON.parse((await readText(req)) || '{}');
    console.log('[mock] draft_get token:', body.p_token);
    if (failWith(res, 'get')) return;
    json(res, 200, MOCK_SB.row || null);
    return;
  }
  if (url.pathname === '/mock/sb/rest/v1/rpc/listing_draft_update' && req.method === 'POST') {
    const body = JSON.parse((await readText(req)) || '{}');
    if (failWith(res, 'update')) return;
    const patch = body.p_patch || {};
    MOCK_SB.patch = patch;
    MOCK_SB.writes.push(patch);
    if (!MOCK_SB.row) { console.log('[mock] draft_update refused (no seeded row)'); json(res, 200, null); return; }
    if (patch.save_mode !== 'progress') MOCK_SB.completedAt = MOCK_SB.completedAt || new Date().toISOString();
    MOCK_SB.row.payload = Object.assign({}, MOCK_SB.row.payload, patch);
    if (MOCK_SB.row.opening_ask_ngn == null && /^[0-9]{1,9}$/.test(String(patch.ask || ''))) {
      MOCK_SB.row.opening_ask_ngn = Number(patch.ask);
    }
    MOCK_SB.row.draft_completed_at = MOCK_SB.completedAt;
    MOCK_SB.row.draft_last_saved_at = new Date().toISOString();
    console.log('[mock] draft_update:', Object.keys(patch).join(','), '| save_mode=' + patch.save_mode);
    json(res, 200, { id: MOCK_SB.row.id, draft_completed_at: MOCK_SB.row.draft_completed_at });
    return;
  }
  /* `fail` is read back with the row: it is the answer the page's own
     fetch got, so a suite asserting on the sentence for a scripted
     failure reads the body off the mock instead of restating it. */
  if (url.pathname === '/mock/sb/last-patch') {
    json(res, 200, { patch: MOCK_SB.patch, writes: MOCK_SB.writes, row: MOCK_SB.row, fail: MOCK_SB.fail });
    return;
  }
  if (url.pathname.startsWith('/mock/cloudinary/') && req.method === 'POST') {
    const kind = url.pathname.indexOf('/video/') !== -1 ? 'video' : 'image';
    const bytes = await readBody(req);
    console.log('[mock] cloudinary ' + kind + ' upload:', bytes, 'bytes');
    json(res, 200, {
      secure_url: 'http://localhost:' + PORT + '/assets/social/og-image.png?mock-' + kind + '-' + Date.now(),
      public_id: 'mock/' + kind + '/' + Date.now(),
    });
    return;
  }

  /* ---- static files ---- */
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + path);
  }
});

server.listen(PORT, () => {
  console.log('Arzuz dev server → http://localhost:' + PORT + '/dev/video-test.html');
  console.log('Landlord invite harness → http://localhost:' + PORT + '/dev/complete-listing-harness.html?ref=' + DRAFT_ID);
});
