#!/usr/bin/env node
/* Node tests for assets/video.js — run: node scripts/test-youtube-url.mjs
   Mirrors the style of scripts/test-listing-og.mjs (no framework). */

import ArzuzVideo from '../assets/video.js';

let failures = 0;
function check(name, ok) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) failures++;
}

console.log('parseYouTube');
check('accepts watch?v= URLs',
  ArzuzVideo.parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts extra watch params before v',
  ArzuzVideo.parseYouTube('https://www.youtube.com/watch?si=abc&v=dQw4w9WgXcQ&t=30s') === 'dQw4w9WgXcQ');
check('accepts youtu.be short links',
  ArzuzVideo.parseYouTube('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts /embed/ URLs',
  ArzuzVideo.parseYouTube('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?controls=0') === 'dQw4w9WgXcQ');
check('accepts /shorts/ URLs',
  ArzuzVideo.parseYouTube('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts a bare 11-char id',
  ArzuzVideo.parseYouTube('dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('accepts mobile m.youtube.com',
  ArzuzVideo.parseYouTube('https://m.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('rejects Cloudinary mp4 (plain video fallback)',
  ArzuzVideo.parseYouTube('https://res.cloudinary.com/demo/tour.mp4') === null);
check('rejects a youtube search URL',
  ArzuzVideo.parseYouTube('https://www.youtube.com/results?search_query=tour') === null);
check('rejects an empty string', ArzuzVideo.parseYouTube('') === null);
check('rejects null/undefined', ArzuzVideo.parseYouTube(null) === null);
check('isYouTube agrees with parseYouTube',
  ArzuzVideo.isYouTube('https://youtu.be/dQw4w9WgXcQ') === true &&
  ArzuzVideo.isYouTube('https://res.cloudinary.com/demo/tour.mp4') === false);

console.log('thumb / watchUrl');
check('thumb points at the public poster CDN',
  ArzuzVideo.thumb('https://youtu.be/dQw4w9WgXcQ') === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
check('thumb is empty for non-YouTube URLs', ArzuzVideo.thumb('https://res.cloudinary.com/demo/tour.mp4') === '');
check('watchUrl is the canonical stored form',
  ArzuzVideo.watchUrl('dQw4w9WgXcQ') === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

console.log('embedProxyUrl');
check('proxy URL keeps raw google URLs out of the page',
  ArzuzVideo.embedProxyUrl('https://youtu.be/dQw4w9WgXcQ') === '/api/video-embed/dQw4w9WgXcQ');
check('autoplay flag appends cleanly',
  ArzuzVideo.embedProxyUrl('dQw4w9WgXcQ', { autoplay: true }) === '/api/video-embed/dQw4w9WgXcQ?autoplay=1');
check('controls flag is for preview contexts',
  ArzuzVideo.embedProxyUrl('dQw4w9WgXcQ', { controls: true }) === '/api/video-embed/dQw4w9WgXcQ?controls=1');
check('non-YouTube URLs produce no proxy URL',
  ArzuzVideo.embedProxyUrl('https://res.cloudinary.com/demo/tour.mp4') === '');

console.log('progressHTML');
const ph = ArzuzVideo.progressHTML({ phase: 'uploading', percent: 34, bytesPerSec: 1024 * 1024 * 2.5 });
check('shows the percentage', ph.includes('Uploading 34%'));
check('shows a human-readable speed', ph.includes('2.5 MB/s'));
check('sets the bar width inline', ph.includes('width:34%'));

console.log('uploadVideoToYouTube');
try {
  await ArzuzVideo.uploadVideoToYouTube({ name: 'big.mp4', size: ArzuzVideo.MAX_BYTES + 1, type: 'video/mp4' });
  check('rejects files above the 200 MB cap without any network call', false);
} catch (e) {
  check('rejects files above the 200 MB cap without any network call',
    /too large/i.test(e.message) && !/fetch/i.test(e.message));
}

console.log(failures === 0 ? '\nAll video helper checks passed.' : '\n' + failures + ' check(s) FAILED');
process.exit(failures === 0 ? 0 : 1);
