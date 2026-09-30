/* ============================================================
   Arzuz — configuration
   Live Supabase connection details and notification settings.
   ============================================================ */

window.ARZUZ_CONFIG = window.ARZUZ_CONFIG || {

  // Live Supabase API connection
  SUPABASE_URL: 'https://nihdbhjecdkpvzvjifrm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5paGRiaGplY2RrcHZ6dmppZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MjExODksImV4cCI6MjEwNDk5NzE4OX0.td0jfbv02T_LMufhurMEl8Qx00UDACYIvLG7XtdXWRM',

  // Instant Notification Settings (Telegram Bot & Email)
  TELEGRAM_BOT_TOKEN: '8526070493:AAHuH9dAfy4EcyJkPuUWl2Ruy3EtWUbALVE',
  TELEGRAM_CHAT_ID: '',     // e.g. '987654321' or '@arzuzwaitlist_bot' (Auto-detected if empty when you message the bot)
  NOTIFICATION_EMAIL: 'support@arzuz.com',

  // Admin Dashboard Security Passcode (SHA-256 Hash of 'arzuz2026')
  ADMIN_PASSCODE_HASH: 'f22e934da8474776e9142c041f0daea4b43eaafb089bf41e8f2b6d86a19628f1',
  ADMIN_PASSCODE: 'arzuz2026', // Fallback for backward compatibility

  // The academic session currently collecting for
  SESSION: '2026/2027',

  // Environment mode: 'production' or 'test'
  ENV: 'production',

  // Support WhatsApp number (09024814771)
  SUPPORT_WHATSAPP: '2349024814771',

  // WhatsApp confirmations via OpenWA (true = send post-submission messages)
  WHATSAPP_CONFIRMATIONS: true
};
