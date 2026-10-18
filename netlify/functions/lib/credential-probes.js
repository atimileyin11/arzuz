/* ============================================================
   Arzuz — the two credentials the hourly probe did not watch

   THE GAP THIS CLOSES

     The build gate refuses a Paystack key or a Telegram token it
     cannot prove, but a build gate only speaks at BUILD time. A key
     rotated at 2am keeps serving the deploy that was built with it,
     right up until the provider stops accepting it. Then the Care Pass
     checkout answers 502 to every buyer — or every alert this site
     sends is dropped, including the one about the outage — and the
     only alarm that could have said so is the alarm that is dead.

     So the hourly probe asks the other two providers the question the
     build gate asks: is the value this deploy holds one you accept?

   THE SAME TWO RULES AS THE GATE

     1. A 2xx is not proof on its own. The same request is repeated
        with one byte of the credential changed and MUST be refused,
        or the route is not checking credentials and its green would
        prove nothing. Same trick as the database probe's tampered key
        and the upload probe's flipped signature.
     2. Messages are built from the STATUS alone. Neither provider's
        body is quoted: a Paystack error can echo the key back, and a
        Telegram body sits behind a URL that contains the token.

   WHAT EACH ONE ASKS

     Paystack  GET /balance with the secret key. Your own balance:
        no customer record is read, nothing is created, and it is the
        one endpoint every secret key may call.
     Telegram  getMe, which proves the token without messaging
        anybody, then getChat, which proves the DESTINATION. A good
        token pointed at a chat the bot cannot see is the quietest
        failure on the site: sendAlert answers false and the student
        is never told. Nothing is sent and nothing is written.

   Used by netlify/functions/database-health.js, hourly. The build gate
   (scripts/require-service-key.mjs) carries the same rules for deploy
   time; the two are separate because one must run inside a Netlify
   function and the other must exit a shell with a status.
   ============================================================ */

const PAYSTACK_URL = 'https://api.paystack.co/balance';
const TELEGRAM_ORIGIN = 'https://api.telegram.org';
const TIMEOUT_MS = 8000;

/* ONE byte, so the tampered request is the same shape as the real one
   rather than an empty header some proxy would refuse before any
   credential is examined. */
function tamper(value) {
  const s = String(value || '');
  if (!s) return 'x';
  return (s.slice(0, 1) === 'a' ? 'b' : 'a') + s.slice(1);
}

async function ask(url, init) {
  try {
    const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS) }, init));
    /* Read as text: a body is never parsed and never quoted, so nothing
       a provider echoes can end up in an alert or a log line. */
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text };
  } catch (err) {
    return { status: 0, text: '', failed: (err && err.message) || 'no answer' };
  }
}

/**
 * Is this Paystack key one the account accepts?
 *
 * @param {object} opts
 * @param {string} [opts.key] the SK from the deploy — never returned, never logged
 * @returns {Promise<{ok: boolean, stage: string, status?: number, message: string, skipped?: string}>}
 *          stage: accepts | paystack-refused | paystack-account |
 *                 paystack-probe | paystack-api | paystack-unreachable
 */
async function probePaystack(opts) {
  const o = opts || {};
  const key = String(o.key || '').trim();
  if (!key) return { ok: true, stage: 'accepts', skipped: 'PAYSTACK_SECRET_KEY is not set on this deploy' };

  const read = await ask(PAYSTACK_URL, { method: 'GET', headers: { Authorization: 'Bearer ' + key } });
  if (!read.status) {
    return {
      ok: false,
      stage: 'paystack-unreachable',
      message: 'Paystack did not answer: ' + read.failed + '. This is not a verdict about the key — the checkout may ' +
        'still be working, so check status.paystack.com before touching anything.',
    };
  }
  if (read.status === 401) {
    return {
      ok: false,
      stage: 'paystack-refused',
      status: 401,
      message: 'api.paystack.co REFUSED the secret key this deploy holds (HTTP 401). The Care Pass checkout answers 502 ' +
        'to every buyer and nothing else on the site shows it.',
    };
  }
  if (read.status === 403) {
    return {
      ok: false,
      stage: 'paystack-account',
      status: 403,
      message: 'api.paystack.co answered 403 — the key was read far enough to identify the ACCOUNT, and the account is ' +
        'not allowed to do this. This is a dashboard problem, not a paste error.',
    };
  }
  if (read.status < 200 || read.status >= 300) {
    return {
      ok: false,
      stage: 'paystack-api',
      status: read.status,
      message: 'api.paystack.co answered ' + read.status + ' to a balance read — neither an acceptance nor a refusal, ' +
        'so the key is UNPROVED. Usually a provider incident or a rate limit.',
    };
  }

  /* The response is only worth something if the route can tell this key
     from a wrong one. */
  const bad = await ask(PAYSTACK_URL, { method: 'GET', headers: { Authorization: 'Bearer ' + tamper(key) } });
  if (bad.status >= 200 && bad.status < 300) {
    return {
      ok: false,
      stage: 'paystack-probe',
      status: bad.status,
      message: 'api.paystack.co answered a TAMPERED key with ' + bad.status + ' as well, so this route is not checking ' +
        'the credential and its green would have proved nothing.',
    };
  }

  return { ok: true, stage: 'accepts', message: 'Paystack accepted the key and refused a tampered copy' };
}

/**
 * Is this bot token one Telegram accepts, and can the bot see the chat
 * every alert is posted to?
 *
 * @param {object} opts
 * @param {string} [opts.token]   the bot token from the deploy
 * @param {string} [opts.chatId]  the destination
 * @returns {Promise<{ok: boolean, stage: string, status?: number, message: string, skipped?: string}>}
 *          stage: accepts | telegram-token | telegram-chat |
 *                 telegram-probe | telegram-unreachable
 */
async function probeTelegram(opts) {
  const o = opts || {};
  const token = String(o.token || '').trim();
  const chatId = String(o.chatId || '').trim();
  if (!token) return { ok: true, stage: 'accepts', skipped: 'TELEGRAM_BOT_TOKEN is not set on this deploy' };

  /* The token lives in the URL — the one reason nothing here prints a
     request line, and the reason neither answer is quoted. */
  const me = await ask(TELEGRAM_ORIGIN + '/bot' + token + '/getMe', { method: 'GET' });
  if (!me.status) {
    return {
      ok: false,
      stage: 'telegram-unreachable',
      message: 'Telegram did not answer: ' + me.failed + '. Every alert is queued and dropped while this lasts. ' +
        'Check status.telegram.org.',
    };
  }
  if (me.status === 401) {
    return {
      ok: false,
      stage: 'telegram-token',
      status: 401,
      message: 'api.telegram.org REFUSED this bot token (HTTP 401). Every alert this site sends is dropped, ' +
        'including this one — which is why it is being delivered another way.',
    };
  }
  if (me.status < 200 || me.status >= 300) {
    return {
      ok: false,
      stage: 'telegram-token',
      status: me.status,
      message: 'api.telegram.org answered ' + me.status + ' to getMe, which is not a bot that exists — a token of the ' +
        'wrong SHAPE (no bot id, a missing colon) looks exactly like this.',
    };
  }

  const bad = await ask(TELEGRAM_ORIGIN + '/bot' + tamper(token) + '/getMe', { method: 'GET' });
  if (bad.status >= 200 && bad.status < 300) {
    return {
      ok: false,
      stage: 'telegram-probe',
      status: bad.status,
      message: 'api.telegram.org answered a TAMPERED token with ' + bad.status + ' too, so a green here would have ' +
        'proved nothing.',
    };
  }

  if (!chatId) {
    return {
      ok: false,
      stage: 'telegram-chat',
      message: 'TELEGRAM_BOT_TOKEN works, but TELEGRAM_CHAT_ID is not set, so sendAlert answers false without even ' +
        'trying. The pager is silent for every alert on this site.',
    };
  }

  const chat = await ask(TELEGRAM_ORIGIN + '/bot' + token + '/getChat?chat_id=' + encodeURIComponent(chatId), { method: 'GET' });
  if (!chat.status) {
    return { ok: false, stage: 'telegram-unreachable', message: 'Telegram did not answer the chat lookup: ' + chat.failed };
  }
  if (chat.status >= 200 && chat.status < 300) {
    return { ok: true, stage: 'accepts', message: 'the bot answered getMe and can see the alert chat' };
  }
  if (chat.status === 400 || chat.status === 403 || chat.status === 404) {
    return {
      ok: false,
      stage: 'telegram-chat',
      status: chat.status,
      message: 'Telegram does not know that chat (HTTP ' + chat.status + ') — a bot can only see a chat it has been ' +
        'added to, or that has messaged it. The token is fine; the destination is not.',
    };
  }
  return {
    ok: false,
    stage: 'telegram-unreachable',
    status: chat.status,
    message: 'Telegram answered the chat lookup HTTP ' + chat.status + ', which is neither a delivery nor a refusal.',
  };
}

module.exports = {
  probePaystack,
  probeTelegram,
  PAYSTACK_URL,
  TELEGRAM_ORIGIN,
  TIMEOUT_MS,
};
