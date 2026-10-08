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

   Run:  node dev/upload-mock-server.mjs [port]     (default 8799)
   Then: http://localhost:8799/dev/video-test.html
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
});
