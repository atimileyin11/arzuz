/* ============================================================
   Arzuz — Netlify Function: Telegram alerts

   The browser posts { action, table, payload } and this function
   does the rest. It owns TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
   (Site configuration → Environment variables), which is the only
   reason the token is safe: nothing that reaches a phone can read
   it.

   Server-side functions alert through the same token by requiring
   sendAlert() from this file (roommate-match.js is the first), so
   the credential has exactly one owner instead of one per caller.

   Actions
     status → { token: bool, chatId: bool }   never the values
     detect → { chatId }                      from getUpdates, for setup
     test   → sends a fixed test message
     send   → { table, payload }              formatted here, not client-side

   The message is built here from a whitelist of tables and fields,
   so this endpoint cannot be used to push arbitrary text at your
   Telegram. Values from the form are HTML-escaped and length-capped.
   ============================================================ */

const RATE_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 30;
const recentSends = [];   // best-effort, per function instance

/* roommate_profiles is the handover table: when the matcher is down the
   roommate page posts the questionnaire through the waitlist door under
   its own name, and the team still needs the Telegram alert. Without it
   the send was refused as "Unknown table" and the answers sat in the
   database with nobody told. */
const KNOWN_TABLES = ['demand_records', 'listings', 'scout_submissions', 'booking_requests', 'support_tickets', 'draft_completed', 'roommate_profiles'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* The shared failure vocabulary — the SAME file the page loads, so the
   class in this body is the class assets/notify.js reads, not a second
   guess at the same status code. */
const ApiErrors = require('../../assets/api-errors.js');

/* The third argument is the CLASS, exactly as in every other function
   here — one shape to read, and the test that sweeps the wire can look
   for one shape. (The unused `extraHeaders` parameter it replaces was
   never passed by any caller.) */
function json(statusCode, body, kind) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(ApiErrors.wireBody(statusCode, body, kind)),
  };
}

function rateLimited() {
  const now = Date.now();
  while (recentSends.length && now - recentSends[0] > RATE_WINDOW_MS) recentSends.shift();
  if (recentSends.length >= MAX_SENDS_PER_WINDOW) return true;
  recentSends.push(now);
  return false;
}

/* Telegram messages go as HTML so student-typed text can never
   break out of the formatting. Escape everything, then truncate. */
function esc(value, max = 200) {
  if (value === null || value === undefined) return '';
  return String(value)
    .slice(0, max)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

/* Ported from the old client-side formatter — same fields, same order. */
function formatMessage(table, p) {
  const lines = [];
  let title;

  if (table === 'demand_records') {
    title = '🚀 <b>New Student Housing Request</b>';
    lines.push(`• <b>First Name:</b> ${esc(p.first || p.first_name) || 'N/A'}`);
    lines.push(`• <b>Room Type:</b> ${esc(p.type || p.room_type) || 'N/A'}`);
    lines.push(`• <b>Budget:</b> ${esc(p.budget || p.budget_band) || 'N/A'}`);
    lines.push(`• <b>Distance:</b> ${esc(p.dist || p.distance) || 'N/A'}`);
    lines.push(`• <b>Timing:</b> ${esc(p.when || p.timing) || 'N/A'}`);
    lines.push(`• <b>Age Band:</b> ${esc(p.age || p.age_band) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.phone) || 'N/A'}`);
    if (p.g_phone) lines.push(`• <b>Guardian Phone:</b> ${esc(p.g_phone)} (${esc(p.g_name || 'Guardian')})`);
    if (p.pain) lines.push(`• <b>Current Issue:</b> ${esc(p.pain)}`);
  } else if (table === 'listings') {
    title = '🏠 <b>New Landlord Property Listing</b>';
    if (p.prop_name) lines.push(`• <b>Property Name:</b> ${esc(p.prop_name)}`);
    lines.push(`• <b>Owner Name:</b> ${esc(p.nm || p.owner_name) || 'N/A'}`);
    lines.push(`• <b>Property Type:</b> ${esc(p.ty || p.property_type) || 'N/A'}`);
    lines.push(`• <b>Area/Street:</b> ${esc(p.ar || p.area) || 'N/A'}`);
    lines.push(`• <b>Availability:</b> ${esc(p.rm || p.rooms) || 'N/A'}`);
    lines.push(`• <b>Rent per Session:</b> ₦${num(p.rent || p.listed_price_ngn).toLocaleString()}`);
    if (p.ask) lines.push(`• <b>Opening Ask:</b> ₦${num(p.ask).toLocaleString()}`);
    if (p.split_ok) lines.push(`• <b>Sharing:</b> ${esc(p.split_ok)}`);
    if (p.desc) lines.push(`• <b>Description:</b> ${esc(p.desc, 300)}`);
    lines.push(`• <b>Run By:</b> ${esc(p.contact_role || p.who) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.ph || p.owner_phone) || 'N/A'}`);
    if (p.photo) lines.push(`• <b>Photo:</b> <a href="${esc(p.photo, 300)}">view</a>`);
  } else if (table === 'booking_requests') {
    title = '📅 <b>New Booking Request</b>';
    lines.push(`• <b>Student:</b> ${esc(p.name || p.student_name) || 'N/A'}`);
    lines.push(`• <b>Apartment:</b> ${esc(p.listing_name || '—')}${p.apt_ref ? ' (ref ' + esc(p.apt_ref) + ')' : ''}`);
    lines.push(`• <b>Move-in:</b> ${esc(p.when || p.move_in) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.phone) || 'N/A'}`);
    if (p.roommate === 'yes') {
      lines.push(`• <b>🤝 Roommate:</b> yes — wants to split with a compatible partner`);
      if (p.mate_gender) lines.push(`• <b>Preference:</b> ${esc(p.mate_gender)}`);
      if (p.mate_budget) lines.push(`• <b>Split:</b> ${esc(p.mate_budget)}`);
      if (p.mate_style) lines.push(`• <b>Style:</b> ${esc(p.mate_style)}`);
    }
    if (p.note) lines.push(`• <b>Note:</b> ${esc(p.note)}`);
  } else if (table === 'support_tickets') {
    title = '🎧 <b>New Support Ticket</b>';
    lines.push(`• <b>Category:</b> ${esc(p.category) || 'other'}`);
    lines.push(`• <b>Apartment:</b> ${esc(p.listing_name) || '—'}`);
    lines.push(`• <b>Contact:</b> ${esc(p.name) || '—'}${p.phone ? ' · ' + esc(p.phone) : ''}`);
    lines.push(`• <b>Report:</b> ${esc(p.message || p.note) || '—'}`);
  } else if (table === 'draft_completed') {
    title = '✅ <b>Draft Apartment Completed</b>';
    lines.push(`• <b>Property:</b> ${esc(p.prop_name) || '—'}`);
    lines.push(`• <b>Area:</b> ${esc(p.ar) || '—'}`);
    lines.push(`• <b>Type:</b> ${esc(p.ty) || '—'}`);
    lines.push(`• <b>Rent:</b> ${p.rent ? '₦' + num(p.rent).toLocaleString() : '—'}`);
    lines.push(`• <b>Availability:</b> ${esc(p.rooms || p.rm) || '—'}`);
    lines.push(`• <b>Contact:</b> ${esc(p.ph) || '—'}${p.contact_role ? ' · ' + esc(p.contact_role) : ''}`);
    lines.push('• <b>Action:</b> open the admin dashboard → Listings → approve or adjust');
  } else if (table === 'roommate_profiles') {
    title = '🤝 <b>New Roommate Questionnaire</b>';
    lines.push(`• <b>Name:</b> ${esc(p.name || p.first) || 'N/A'}`);
    lines.push(`• <b>Situation:</b> ${esc(p.situation) || 'N/A'}`);
    lines.push(`• <b>Area:</b> ${esc(p.area) || 'N/A'}`);
    lines.push(`• <b>Share:</b> ${p.budget ? '₦' + num(p.budget).toLocaleString() + ' a session' : 'N/A'}`);
    lines.push(`• <b>Split:</b> ${esc(p.split) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.phone) || 'N/A'}`);
  } else if (table === 'scout_submissions') {
    title = '🔍 <b>New Building Scout Report</b>';
    lines.push(`• <b>First Name:</b> ${esc(p.first || p.first_name) || 'N/A'}`);
    lines.push(`• <b>Area/Street:</b> ${esc(p.area) || 'N/A'}`);
    lines.push(`• <b>Rooms in Building:</b> ${esc(p.rooms) || 'N/A'}`);
    lines.push(`• <b>Rent Paid:</b> ₦${num(p.amt || p.rent_reported).toLocaleString()}`);
    lines.push(`• <b>Rent Collector:</b> ${esc(p.who) || 'N/A'}`);
    lines.push(`• <b>Vacancy Signal:</b> ${esc(p.vac) || 'N/A'}`);
    lines.push(`• <b>WhatsApp:</b> ${esc(p.phone) || 'N/A'}`);
    if (p.photo) lines.push(`• <b>Photo:</b> <a href="${esc(p.photo, 300)}">view</a>`);
  } else {
    title = `📝 <b>New Form Submission</b>`;
    lines.push(`• Table: ${esc(table, 60)}`);
  }

  lines.push('');
  lines.push(`📅 <b>Session:</b> ${esc(process.env.ARZUZ_SESSION || '2026/2027')}`);
  lines.push(`📍 <b>Environment:</b> ${esc(process.env.ARZUZ_ENV || 'production')}`);
  return `${title}\n\n${lines.join('\n')}`;
}

async function telegram(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    /* A hung Telegram must never hold a request open. This matters
       most on the server-side path: sendAlert() is awaited by the
       student's own request, so an alert that never resolves would
       leave them staring at a spinner. */
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`Telegram ${method} failed (HTTP ${res.status})`);
  }
  return body;
}

/* Server-side alerts get their own ceiling, for the same reason the HTTP
   action has one: a caller reachable from the public internet must not be
   able to flood the channel. roommate-match.js is exactly such a caller —
   a script with enough addresses can finish questionnaires in a loop, and
   without a cap every one of them would send a message.

   A tripped cap DROPS the alert, and logs it. That is the right way round:
   the database still holds the event and the dashboard still shows it, so
   the alert is the only thing lost — whereas Telegram throttling or
   blocking the bot would lose every future alert as well. */
const SERVER_ALERT_WINDOW_MS = 60_000;
const MAX_SERVER_ALERTS_PER_WINDOW = 30;
const recentServerAlerts = [];

function serverAlertLimited() {
  const now = Date.now();
  while (recentServerAlerts.length && now - recentServerAlerts[0] > SERVER_ALERT_WINDOW_MS) {
    recentServerAlerts.shift();
  }
  if (recentServerAlerts.length >= MAX_SERVER_ALERTS_PER_WINDOW) return true;
  recentServerAlerts.push(now);
  return false;
}

/* ------------------------------------------------------------
   sendAlert — the server-side door to the same bot.

   Called by other functions (roommate-match.js), never by a browser.
   Always awaited, because Netlify may freeze an instance as soon as
   the handler returns and an un-awaited fetch would simply be lost.

   It NEVER throws and never returns a rejection: by the time an alert
   is sent, the thing it describes is already committed, so a Telegram
   outage must not be reported to the student as a failed action. It
   logs instead, and answers false.
   ------------------------------------------------------------ */
async function sendAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  /* Not configured is not a failure — same as action:'status' being
     falsey. Nothing is logged, so a site without Telegram does not
     fill its function logs with errors. */
  if (!token || !chatId) return false;
  /* Checked after the token, so a site without Telegram never consumes
     the budget — only a real send counts against it. */
  if (serverAlertLimited()) {
    console.error('[notify] server alert dropped: more than ' + MAX_SERVER_ALERTS_PER_WINDOW + ' in a minute');
    return false;
  }
  try {
    await telegram(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    console.error('[notify] alert failed:', err.message);
    return false;
  }
}

/* ============================================================
   sendEmail — the other channel, for the messages Telegram and
   WhatsApp cannot carry: a decision the customer keeps.

   WHY IT LIVES HERE
     notify.js already owns "how this site reaches a person", and the
     rule that keeps these credentials safe is that each one has ONE
     owner: the Telegram token is read nowhere else, so RESEND_API_KEY
     is read nowhere else either. claims.js requires sendEmail from
     this file the same way it requires sendAlert, and a browser never
     gets an action that sends mail — there is deliberately no new
     action on the endpoint below, because an email door a page could
     knock on is a way to post arbitrary text out of your domain.

   Resend, over one HTTPS POST with a bearer key. No SDK, no build step:
     RESEND_API_KEY     the key (Netlify → Environment variables)
     ARZUZ_MAIL_FROM    optional; the verified sender. Until the domain
                        is verified in Resend, their shared sender only
                        accepts mail TO the account owner, and the
                        refusal that comes back says so — which is why
                        the provider's own sentence is passed through
                        rather than replaced by ours.

   Like sendAlert it NEVER throws and never rejects: by the time it is
   called the decision it describes is already committed, so mail that
   will not go is a fact to record, not a reason to fail the action.
   It answers { ok, reason } — a word the caller can put in the trail.
   ============================================================ */

const RESEND_URL = 'https://api.resend.com/emails';

/* Addresses this site INVENTS are not mailboxes. A Care Pass bought
   without an email gets `<phone>@receipts.arzuz.com` so Paystack has
   something to bill against (see finance.js) — sending a decision there
   would mean a bounce from a domain we do not read, and the customer
   would learn nothing. Naming the domain here is what turns that into
   a recorded reason instead of a silent black hole. */
const PLACEHOLDER_MAIL_DOMAIN = 'receipts.arzuz.com';

function emailConfig() {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.ARZUZ_MAIL_FROM || '').trim() || 'Arzuz Care <care@arzuz.com>';
  return { key: key, from: from, ready: !!key };
}

/* One shape for both checks, so a caller cannot get past one and fail
   the other: a single @, something either side of it, a dot in the
   domain, no whitespace, no header-injecting newline. */
function mailDeliverable(address) {
  const a = String(address === undefined || address === null ? '' : address).trim().toLowerCase();
  if (!a) return { ok: false, reason: 'no-address' };
  if (!/^[^\s@,;"<>]+@[^\s@,;"<>]+\.[a-z]{2,}$/.test(a)) return { ok: false, reason: 'bad-address' };
  if (a.slice(a.lastIndexOf('@') + 1) === PLACEHOLDER_MAIL_DOMAIN) {
    return { ok: false, reason: 'placeholder-address' };
  }
  return { ok: true, address: a };
}

async function sendEmail(opts) {
  const o = opts || {};
  const cfg = emailConfig();
  if (!cfg.ready) {
    /* Not configured is not a failure — the same reading as sendAlert
       with no token. Nothing is logged, so a site that has not picked a
       provider yet does not fill its logs with errors. */
    return { ok: false, reason: 'not-configured' };
  }
  const to = mailDeliverable(o.to);
  if (!to.ok) return to;
  const subject = String(o.subject || '').trim().slice(0, 180) || 'Arzuz Care';
  const text = String(o.text || '').slice(0, 4000);
  const html = o.html ? String(o.html).slice(0, 20000) : undefined;
  if (!text) return { ok: false, reason: 'empty-text' };

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: cfg.from, to: [to.address], subject: subject, text: text, html: html }),
      /* A hung provider must not hold the claim action open. Claims are
         awaited by the admin's own click. */
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = String((body && (body.message || body.error)) || '').slice(0, 160);
      console.error('[notify] email refused:', res.status, why);
      return { ok: false, reason: 'refused', detail: why, status: res.status };
    }
    return { ok: true, reason: 'sent', id: (body && body.id) || null };
  } catch (err) {
    console.error('[notify] email failed:', err && err.message);
    return { ok: false, reason: 'unreachable' };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const action = body.action || 'send';

  /* --- status: used by the admin dashboard, returns no secrets --- */
  if (action === 'status') {
    return json(200, { token: !!token, chatId: !!chatId });
  }

  if (!token) {
    /* A 503 that is a DEPLOYMENT FACT. The page must not offer to try
       again: no alert will ever go out until the token is set. */
    return json(503, {
      error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN in Netlify → Environment variables.',
    }, 'not-ready');
  }

  /* --- detect: find the chat id of whoever last talked to the bot --- */
  if (action === 'detect') {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
      const data = await res.json().catch(() => ({}));
      let found = null;
      const results = (data && data.result) || [];
      for (let i = results.length - 1; i >= 0 && !found; i--) {
        const item = results[i];
        const msg = item.message || item.channel_post || item.edited_message;
        if (msg && msg.chat && msg.chat.id) found = String(msg.chat.id);
      }
      return json(200, { chatId: found });
    } catch (err) {
      return json(502, { error: 'Could not reach Telegram: ' + err.message });
    }
  }

  if (!chatId) {
    return json(503, {
      error: 'No TELEGRAM_CHAT_ID set in Netlify → Environment variables.',
    }, 'not-ready');
  }

  if (rateLimited()) {
    return json(429, { error: 'Too many alerts in the last minute — try again shortly.' });
  }

  /* --- test: one fixed message, no client text --- */
  if (action === 'test') {
    const text =
      '🔔 <b>Test alert from Arzuz Admin</b>\n\nYour Telegram notifications are wired up correctly.';
    try {
      await telegram(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
      return json(200, { ok: true });
    } catch (err) {
      return json(502, { error: err.message });
    }
  }

  /* --- send: a real submission --- */
  const table = body.table;
  if (!KNOWN_TABLES.includes(table)) {
    return json(400, { error: 'Unknown table.' });
  }
  const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

  try {
    await telegram(token, 'sendMessage', {
      chat_id: chatId,
      text: formatMessage(table, payload),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error('[notify]', err.message);
    return json(502, { error: 'Could not send the Telegram alert.' });
  }
};

/* Shared with other functions so the token, the escaping and the HTML
   parsing mode all live in one file. esc() goes with it: a caller that
   builds its own message must escape student-typed text the same way,
   or a name can break out of the message's formatting. */
exports.sendAlert = sendAlert;
exports.esc = esc;
exports.MAX_SERVER_ALERTS_PER_WINDOW = MAX_SERVER_ALERTS_PER_WINDOW;
/* The window is per function instance and per minute. A suite files thirty
   claims in one second, which spends the budget honestly — and then a test
   about the FIRST alert a job sends would be measuring the ceiling instead
   of the message. Clearing it lets that test start from a quiet minute. */
exports.resetServerAlertBudget = function () { recentServerAlerts.length = 0; };
exports.sendEmail = sendEmail;
exports.emailConfig = emailConfig;
exports.mailDeliverable = mailDeliverable;
