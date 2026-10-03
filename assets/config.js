/* ============================================================
   Arzuz — configuration

   Only public values live here. The anon key and the WhatsApp
   support number are meant to be in the page source; everything
   that can be abused — the Telegram bot token, the Cloudinary
   secret, the admin login — lives on the server or in Supabase
   Auth, never in this file.
   ============================================================ */

window.ARZUZ_CONFIG = window.ARZUZ_CONFIG || {

  // Live Supabase API connection (anon key is public by design —
  // row-level security in supabase-schema.sql decides what it may do)
  SUPABASE_URL: 'https://nihdbhjecdkpvzvjifrm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM',

  // The academic session currently collecting for
  SESSION: '2026/2027',

  // Environment mode: 'production' or 'test'
  ENV: 'production',

  // Support WhatsApp number (09024814771)
  SUPPORT_WHATSAPP: '2349024814771',

  // WhatsApp confirmations via OpenWA (true = send post-submission messages)
  WHATSAPP_CONFIRMATIONS: true
};
