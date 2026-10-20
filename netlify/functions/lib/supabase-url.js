'use strict';

/* SUPABASE_URL is the project REST origin, not the PostgreSQL connection
   string shown beside it in the dashboard. Parsing it once and returning
   only URL.origin keeps database usernames/passwords out of fetch errors,
   function logs and Telegram alerts. */
function projectOrigin(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return '';
    }
    return url.origin;
  } catch (_) {
    return '';
  }
}

module.exports = { projectOrigin };
