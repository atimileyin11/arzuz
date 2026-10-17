/* ============================================================
   Arzuz — roommate matching page logic

   Drives roommates.html. Three states, one container each:

     no token  → the two-sided questionnaire (Arzuz.form)
     token     → "welcome back": the private link, and the matches
     deciding  → accept / pass, and the double opt-in that follows

   THE SECURITY SHAPE OF THIS PAGE

   A student's answers must never reach another student's browser,
   so nothing here computes a percentage. The page POSTs the profile
   to /api/roommate-match; the function reads the pool with the
   service-role key, scores each pair server-side, and returns only
   what a stranger is allowed to see: a first name, an area, a
   percentage and its reasons. A phone number appears in this DOM
   in exactly one case — the server said the match is mutual.

   The token is the whole credential: there is no password, because
   there is no account. It lives in localStorage and travels in the
   URL, so the link is the key to the profile. That is why the page
   tells the student plainly not to post it anywhere.
   ============================================================ */

var ArzuzRoommate = (function () {

  var API = '/api/roommate-match';

  /* The site-wide failure vocabulary (assets/api-errors.js), if this page
     loaded it. Every failure on this page carries its status, so the
     class is read from the error rather than guessed from a sentence. */
  function E(){ return (typeof ArzuzApiErrors !== 'undefined') ? ArzuzApiErrors : null; }
  var TABLE = 'roommate_profiles';
  var TOKEN_KEY = 'arzuz_roommate_token_v1';

  function cfg() { return window.ARZUZ_CONFIG || {}; }
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, type) {
    if (typeof ArzuzSubmit !== 'undefined' && ArzuzSubmit.showToast) ArzuzSubmit.showToast(msg, type);
  }

  /* ------------------------------------------------------------
     the token
     ------------------------------------------------------------ */

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  }

  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  /* The link is how a student returns from another device. A ?t=
     in the URL wins over whatever this browser remembers, and is
     persisted so the page keeps working as they navigate. */
  function tokenFromUrl() {
    var m = /[?&]t=([^&#]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* Prefer the canonical /roommates path, but stay on roommates.html
     when the page is being served straight off the filesystem (the
     dev server has no redirect rules). */
  function linkFor(token) {
    var path = window.location.pathname.replace(/index\.html$/, '');
    if (!/roommates(\.html)?$/.test(path)) path = '/roommates';
    return window.location.origin + path + '?t=' + encodeURIComponent(token);
  }

  /* ------------------------------------------------------------
     the API
     ------------------------------------------------------------ */

  function api(action, body) {
    var payload = { action: action };
    Object.keys(body || {}).forEach(function (k) { payload[k] = body[k]; });

    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
        if (!r.ok) {
          /* The function's own sentence is preferred — it is the answer
             to what was sent — and so is the CLASS it put on the wire:
             the matching function distinguishes a 503 that means "not
             configured" from one that means "too many just now", and
             only the server can. Reading it back is what keeps this
             page and the function agreeing on the class, not just on
             the wording. */
          var W = E();
          /* The function's sentence is what was asked for; the class is
             what the caller branches on. Losing either one because the
             other's module is missing would be the wrong way round, so
             the fallback carries the status and the sentence too. */
          if (!W){
            var plain = new Error(data.error || 'Arzuz could not do that just now — that is our side, not yours. ' +
              'Try again in a minute.');
            plain.status = r.status || 0;
            throw plain;
          }
          throw W.failed(r, data);
        }
        return data;
      });
    });
  }

  /* Nigerian numbers arrive as 0803… or 234803…; wa.me needs the
     international form with no plus and no leading zero. */
  function waLink(phone, text) {
    var digits = String(phone || '').replace(/[^\d]/g, '');
    if (digits.charAt(0) === '0') digits = '234' + digits.slice(1);
    if (!digits) return '';
    return 'https://wa.me/' + digits + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  /* ------------------------------------------------------------
     the questionnaire

     Labels and options come from ArzuzMatch so the form can never
     offer an answer the scorer does not understand. The
     deal-breakers step is opt:true on purpose — the form engine
     treats a checkbox step as needing at least one tick, and a
     student is allowed to have no deal-breakers at all.
     ------------------------------------------------------------ */

  function mountQuestionnaire() {
    if (typeof Arzuz === 'undefined' || typeof ArzuzMatch === 'undefined') return;
    var A = ArzuzMatch.PROFILE, B = ArzuzMatch.WANTS;

    var steps = [
      /* ---- part one: my profile ---- */
      { k: 'gender', h: A.gender.label,
        hint: 'Part one of two: who you are. Nobody sees these answers \u2014 another student is shown a percentage, never your profile.',
        o: A.gender.options },
      { k: 'sleep',  h: A.sleep.label,  o: A.sleep.options },
      { k: 'wake',   h: A.wake.label,   o: A.wake.options },
      { k: 'clean',  h: A.clean.label,  o: A.clean.options },
      { k: 'guests', h: A.guests.label, o: A.guests.options },
      { k: 'smoke',  h: A.smoke.label,
        hint: 'If a student has told us smoking is a deal-breaker, a smoker is simply never shown to them \u2014 so there is nothing to gain by answering this the way you think we want.',
        o: A.smoke.options },
      { k: 'noise',  h: A.noise.label,  o: A.noise.options },
      { k: 'budget', h: 'What is your share of the rent?',
        hint: 'Your half, for the session, in naira. We pair you with students in a similar range instead of matching a \u20A660,000 half with a \u20A6200,000 one.',
        f: [['budget', 'Your share (\u20A6)', 'number']] },
      { k: 'split',  h: A.split.label,
        hint: 'Be honest here \u2014 it is the one thing a roommate cannot fix later.',
        o: A.split.options },
      { k: 'area',   h: 'Which area are you looking in?',
        hint: 'Malete, Oke-Odo, Yikpata \u2014 anywhere near the campus gate.',
        f: [['area', 'Area or hostel name', 'text']] },
      { k: 'ct',     h: 'Where should we message you?',
        hint: 'Your matches and your introductions come on WhatsApp. Your number is never shown publicly, and it is only passed on when you both accept. An email is optional \u2014 if you give us one it is the second way we reach you, and it is how you can open your status page if you ever change your number.',
        /* `{opt:true}` is what makes the email optional — the form engine
           treats a field with no fourth element as required. */
        f: [['name', 'Your first name', 'text'], ['phone', 'WhatsApp number', 'tel'],
          ['email', 'Email', 'email', { opt: true }]] },

      /* ---- part two: my ideal roommate ---- */
      { k: 'want_gender', h: B.want_gender.label,
        hint: 'Part two of two: your ideal roommate. These answers decide who we show you, and how heavily each difference counts against a pair.',
        o: B.want_gender.options },
      { k: 'want_sleep',  h: 'Sleep schedule \u2014 how much does it matter?', o: B.want_sleep.options },
      { k: 'want_clean',  h: 'Cleanliness \u2014 how much does it matter?',    o: B.want_clean.options },
      { k: 'want_guests', h: 'Guest habits \u2014 how much do they matter?',   o: B.want_guests.options },
      { k: 'want_noise',  h: 'Noise level \u2014 how much does it matter?',    o: B.want_noise.options },
      { k: 'want_budget', h: 'Budget \u2014 how much does it matter?',         o: B.want_budget.options },
      { k: 'want_split',  h: B.want_split.label,
        hint: 'Choose \u201cEqual split only\u201d if you cannot carry a bigger share than your half.',
        o: B.want_split.options },
      { k: 'dealbreakers', h: B.dealbreakers.label,
        hint: 'Tick every one that is a hard no. Tick none if none are \u2014 either answer is fine, and we will never show you someone who breaks one you ticked.',
        c: B.dealbreakers.options, opt: true },
      { k: 'note', h: 'Anything else a roommate should know?', opt: true,
        ta: 'e.g. I keep a study desk and I am up early for lectures. I would rather live with someone who studies at home.' }
    ];

    var done =
      '<div class="done" style="padding-bottom:0"><div class="m"><span>az</span></div>' +
      '<h3>Your profile is in.</h3>' +
      '<p>We are matching you against every student who has answered the same questions. Each ' +
      'compatibility percentage below is computed from both profiles, not just one.</p>' +
      '<p class="sm">Roommate matching is free \u2014 no payment for it, and none from your rent or ' +
      'deposit. Contact details move only after you both accept.</p></div>' +
      (typeof ArzuzShare !== 'undefined' ? ArzuzShare.card({
        url: 'https://arzuz.com/roommates',
        tag: 'roommate-share',
        heading: 'Know someone hunting for a roommate?',
        body: 'Send them the questionnaire \u2014 it takes two minutes and the deal-breakers are respected.',
        text: 'Arzuz matches students near KWASU with roommates who actually fit \u2014 and only shares contact when you both say yes:'
      }) : '');

    wireSubmit();

    Arzuz.form({
      table: TABLE,
      backHref: '/', backLabel: '\u2190 Back to home',
      steps: steps,
      done: done
    });

    /* The share card arrives inside the done screen the engine swaps
       into #form, so the listener sits on #form itself. */
    if (typeof ArzuzShare !== 'undefined') ArzuzShare.wire($('form'));
  }

  /* The form engine hands its answers to ArzuzSubmit. This page needs a
     TOKEN back rather than a row — the token is the only key to the
     profile — so the roommate table is intercepted and sent to the
     matcher instead.

     THERE IS NO SECOND PLACE TO PUT IT, AND THAT IS A CHANGE.

     Until the direct path was closed this fell back to demand_records
     when the matcher was unavailable, on the reasoning that a profile we
     cannot match is still a student the team can place by hand. Three
     things were wrong with it, and the first is the one that settles it:

       · It could not work. demand_records is served by the validated
         door now, and the door's student form requires a first name and
         an age band. This questionnaire collects `name`, and has no age
         question at all — so the fallback posted a row the door refuses,
         and the door would have said so.
       · An age band is not a formatting detail. It is what sets
         is_minor, so inventing one to get the row in would file a
         student under the wrong rules.
       · With anon's INSERT revoked
         (supabase-close-public-inserts.sql) it fails on the grant before
         a validator ever sees it — a fallback that can only return a
         permission error is not a fallback.

     So the honest failure is the one the rest of the site already uses:
     say it in words the student can act on, keep nothing, and do not put
     a half-profile in a table the team would act on. It RESOLVES rather
     than rejects, because the form engine reads the result and a
     rejection there leaves the button saying "Saving…" with no sentence
     under it. */
  function wireSubmit() {
    if (typeof ArzuzSubmit === 'undefined') return;
    var orig = ArzuzSubmit.send.bind(ArzuzSubmit);

    ArzuzSubmit.send = function (table, answers) {
      if (table !== TABLE) return orig(table, answers);

      var c = cfg();
      return api('create', {
        payload: answers,
        session: c.SESSION || '2026/2027',
        env: c.ENV || 'production',
        source: 'roommates.html'
      }).then(function (res) {
        setToken(res.token);
        paintLink(res.token);
        return loadAndPaint(res.token);
      }).then(function () {
        return { ok: true, queued: false };
      }).catch(function (err) {
        return handOver(orig, answers, err);
      });
    };
  }

  /* ------------------------------------------------------------
     THE HANDOVER — what happens when the matcher cannot take it

     An outage of the matcher used to cost the MATCHING and the profile
     both. The profile now goes to the waitlist DOOR instead: form
     'roommate_profiles', which is this questionnaire's own name and its
     own question list — a name and a phone, and no age band, because it
     never asked for one. That last part is the whole reason the old side
     door could not work: it posted this questionnaire as a student
     registration, whose age band is what sets is_minor, so the row it
     tried to write was refused by the door and would have filed a student
     under the wrong rules if it had not been.

     What the door gives back is what the other five public forms get:
     validation, the throttle, the honeypot, a consent record, the audit
     trail, and a REFERENCE the student can read out. What it costs is what
     it always cost: their answers are in the pool the team reads by hand.

     Three outcomes, each reported as itself, and none of them a second
     write by this page:

       taken     the profile is with the team, with a reference
       refused   nothing was stored, and the door's own sentence says why
       not-ready nothing was stored either, and the class is one the submit
                 layer HOLDS — so `orig` queues the answers and retries them
                 through the same door once the deploy catches up

     One sentence is built here in the 'taken' case because the door's own
     note is about a waitlist place and this student asked for a roommate;
     every other path reuses the door's words rather than paraphrasing
     them. */
  function handOver(orig, answers, matcherErr) {
    var W = E();
    console.warn('[ArzuzRoommate] the matcher is unavailable: ' +
      (W ? W.detail(matcherErr) : (matcherErr && matcherErr.message)) +
      ' \u2014 handing the questionnaire to the waitlist door');

    /* `orig` is the submit layer's own send, un-overridden — passing it in
       rather than reaching for ArzuzSubmit keeps this function from
       re-entering the override that called it. */
    if (typeof orig !== 'function') return Promise.resolve(refused(matcherErr));

    return orig(TABLE, answers).then(function (res) {
      if (res && res.ok) {
        var ref = res.ref || '';
        paintHandover(ref);
        return { ok: true, queued: false, ref: ref, duplicate: !!res.duplicate,
          note: 'Roommate matching is busy just now, so we have taken your answers and the ' +
            'team will match you by hand' + (ref ? ' \u2014 your reference is ' + ref +
            '. Keep it; read it to us on WhatsApp and we can find your place straight away.' : '.') };
      }
      /* The door's own class and sentence, not a second reading of the
         number — the class is what tells held-but-not-sent from refused. */
      return { ok: false, queued: !!(res && res.queued),
        kind: (res && res.kind) || 'error',
        note: (res && res.note) || paintError(matcherErr, { saved: false }) };
    }).catch(function (doorErr) {
      W = E();
      console.warn('[ArzuzRoommate] the waitlist door could not take it either: ' +
        (W ? W.detail(doorErr) : (doorErr && doorErr.message)));
      return refused(doorErr);
    });
  }

  /* The last resort: nothing was stored anywhere, and the copy says so. */
  function refused(err) {
    var W = E();
    return { ok: false, queued: false,
      kind: W ? W.classify(err).kind : 'error',
      note: paintError(err, { saved: false }) };
  }

  /* ------------------------------------------------------------
     the private link
     ------------------------------------------------------------ */

  function paintLink(token) {
    var el = $('rmLink');
    if (!el) return;
    el.style.display = '';
    el.innerHTML =
      '<b>Keep this link private</b>' +
      '<p>It is the only key to your matches \u2014 there is no password to fall back on. Save it, and ' +
      'open it on any device to carry on where you left off. Anyone who has the link can see your ' +
      'matches, so do not post it or forward it on.</p>' +
      '<input type="text" readonly id="rmLinkInput" aria-label="Your private roommate link" value="' +
        esc(linkFor(token)) + '">' +
      '<div class="row"><button type="button" class="rm-btn" id="rmCopy">Copy link</button></div>';

    var btn = $('rmCopy');
    if (btn) {
      btn.addEventListener('click', function () {
        var input = $('rmLinkInput');
        function ok() { btn.textContent = 'Copied \u2713'; setTimeout(function () { btn.textContent = 'Copy link'; }, 2200); }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(input.value).then(ok).catch(function () { input.select(); document.execCommand('copy'); ok(); });
        } else {
          input.select();
          try { document.execCommand('copy'); ok(); } catch (e) {
            toast('Copy the link from the box above.', 'info');
          }
        }
      });
    }
  }

  /* ------------------------------------------------------------
     the matches
     ------------------------------------------------------------ */

  function loadAndPaint(token) {
    var panel = $('rmPanel');
    if (panel && !panel.innerHTML) panel.innerHTML = '<div class="rm-empty">Loading your matches\u2026</div>';

    return api('matches', { token: token }).then(function (data) {
      paintMatches(data);
      return data;
    }).catch(function (err) {
      paintError(err);
      return null;
    });
  }

  function paintMatches(data) {
    var panel = $('rmPanel');
    if (!panel) return;
    var list = (data && data.matches) || [];

    var html = '<div class="rm-panelhead" data-rise><h2>Your matches</h2>' +
      (list.length
        ? '<p>Accept the ones you would actually live with. Nothing is shared until they accept you too.</p>'
        : '') + '</div>';

    if (!list.length) {
      html += '<div class="rm-empty" data-rise><b>Nobody compatible yet \u2014 but you are in the pool.</b><br>' +
        'The moment a student answers these same questions with a profile that fits yours, they appear here ' +
        'with their percentage. If they accept you too, you both get each other\u2019s WhatsApp on this page ' +
        'and a message from the Arzuz team.</div>';
    } else {
      html += list.map(cardHtml).join('');
    }

    panel.innerHTML = html;
    wireCards();
    if (window.ArzuzMotion && ArzuzMotion.scan) ArzuzMotion.scan();
  }

  function cardHtml(m) {
    var pct = Number(m.pct) || 0;
    var unlocked = !!m.unlocked && !!m.contact;
    var mine = m.my_decision, theirs = m.their_decision;

    var actions = '';
    if (unlocked) {
      var wa = waLink(m.contact.phone, introText(m));
      /* An unlocked match is a done deal. "Hide" is local only: sending
         a pass here would flip one half of a mutual pair back to
         rejected and take the contact away from both students. */
      actions = '<div class="rm-actions">' +
        (wa ? '<a class="rm-btn wa" href="' + wa + '" target="_blank" rel="noopener">Message on WhatsApp</a>' : '') +
        '<button type="button" class="rm-btn quiet" data-dismiss="1">Hide this card</button>' +
        '</div>';
    } else {
      actions = '<div class="rm-actions">' +
        '<button type="button" class="rm-btn" data-decide="accept" data-id="' + esc(m.id) + '"' +
          (mine === 'accept' ? ' disabled' : '') + '>' +
          (mine === 'accept' ? 'Accepted \u2713' : 'Accept') + '</button>' +
        '<button type="button" class="rm-btn quiet" data-decide="pass" data-id="' + esc(m.id) + '"' +
          (mine === 'pass' ? ' disabled' : '') + '>' +
          (mine === 'pass' ? 'Passed' : 'Pass') + '</button>' +
        '</div>';
    }

    var state = '';
    if (!unlocked) {
      if (theirs === 'accept' && mine !== 'accept') {
        state = '<div class="rm-state they">They have already accepted you. Accept to unlock contact details.</div>';
      } else if (mine === 'accept') {
        state = '<div class="rm-state">Accepted. We will unlock contact the moment they accept too \u2014 you will see it here.</div>';
      } else if (mine === 'pass') {
        state = '<div class="rm-state">You passed on this one. They are not told.</div>';
      }
    }

    return '<div class="rm-card' + (unlocked ? ' unlocked' : '') + '" data-rise>' +
      '<div class="rm-top">' +
        '<span class="rm-score">' + pct + '%</span>' +
        '<span class="rm-with">match with ' + esc(m.name || 'a student') + '</span>' +
        (m.verdict ? '<span class="rm-verdict">' + esc(m.verdict) + '</span>' : '') +
      '</div>' +
      '<div class="rm-bar"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>' +
      chips(m.reasons) +
      metaLine(m) +
      actions + state +
      (unlocked ? contactHtml(m) : '') +
      '</div>';
  }

  function chips(reasons) {
    if (!reasons || !reasons.length) return '';
    return '<div class="rm-chips">' + reasons.map(function (r) {
      return '<span class="rm-chip ' + (r.ok ? 'ok' : 'no') + '">' +
        (r.ok ? '\u2713' : '!') + ' ' + esc(r.text) + '</span>';
    }).join('') + '</div>';
  }

  function metaLine(m) {
    var bits = [];
    if (m.area) bits.push(esc(m.area));
    var b = Number(m.budget);
    if (isFinite(b) && b > 0) bits.push('\u20A6' + b.toLocaleString() + ' a session');
    return bits.length ? '<div class="rm-meta">' + bits.join(' \u00B7 ') + '</div>' : '';
  }

  function contactHtml(m) {
    var c = m.contact || {};
    return '<div class="rm-contact">' +
      '<b>You both said yes \u2014 here is ' + esc(c.name || m.name || 'your match') + '.</b>' +
      '<p>' + esc(c.phone || '') + ' \u2014 agree the split between you on WhatsApp, and tell the landlord ' +
      'you are taking the room together. Arzuz never collects rent, holds a deposit or takes payment ' +
      'from tenants.</p>' +
      '</div>';
  }

  function introText(m) {
    return 'Hi ' + (m.name || 'there') + '! Arzuz here \u2014 we matched you as roommates (' + m.pct +
      '% compatible). Shall we agree on the split?';
  }

  /* One delegated listener on the panel, so re-rendering the list can
     never leave a stale button wired to a removed node. */
  function wireCards() {
    var panel = $('rmPanel');
    if (!panel || panel.getAttribute('data-wired')) return;
    panel.setAttribute('data-wired', '1');

    panel.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;

      /* local dismiss — never a decision, never a request */
      var hide = e.target.closest('[data-dismiss]');
      if (hide) {
        var card = hide.closest ? hide.closest('.rm-card') : null;
        if (card) card.remove();
        return;
      }

      var btn = e.target.closest('[data-decide]');
      if (!btn || btn.disabled) return;
      var decision = btn.getAttribute('data-decide');
      var id = btn.getAttribute('data-id');
      if (!id) return;

      /* Passing throws a person away for good, so it takes two taps. */
      if (decision === 'pass' && btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.textContent = 'Tap again to pass';
        setTimeout(function () {
          if (btn.getAttribute('data-armed') === '1') {
            btn.setAttribute('data-armed', '0');
            btn.textContent = 'Pass';
          }
        }, 4000);
        return;
      }

      decide(readToken(), id, decision, btn);
    });
  }

  function decide(token, target, decision, btn) {
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving\u2026';

    api('decide', { token: token, target: target, decision: decision })
      .then(function (res) {
        if (res && res.unlocked) toast('It is mutual \u2014 contact details unlocked.', 'success');
        else if (decision === 'accept') toast('Accepted. We will unlock contact when they accept too.', 'success');
        return loadAndPaint(token);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = label;
        paintError(err);
      });
  }

  /* ------------------------------------------------------------
     the handover note

     The mirror of paintError for the one success that is not a match:
     the questionnaire reached the team through the waitlist door. It says
     three things and nothing more — what happened, that there is no
     private link because there is no profile in the pool, and the
     reference, which is the handle they can quote.

     It is painted in #rmPanel, which is a SIBLING of #form: the form
     engine replaces #form with its "your profile is in" screen, so a note
     painted inside it would be erased by the very success it describes.
     Found by reading the DOM rather than by trusting the order. */
  function paintHandover(ref) {
    var panel = $('rmPanel');
    if (!panel) return;

    var pending = panel.querySelector ? panel.querySelector('.rm-empty') : null;
    if (pending && /Loading your matches/.test(pending.textContent || '')) panel.removeChild(pending);

    var div = document.createElement('div');
    div.className = 'rm-note';
    div.innerHTML = '<b>Your answers are with the team.</b> ' +
      'Our matching service could not score you just now, so instead of losing your answers we sent ' +
      'them to the team \u2014 they will match you by hand and message you on WhatsApp. There is no ' +
      'private link for this one, because your profile is not in the pool that page reads.' +
      (ref ? '<div style="margin-top:10px"><b>Your reference: <code>' + esc(ref) + '</code></b><br>' +
        'Keep it \u2014 read it to us on WhatsApp and we can find your place straight away.</div>' : '');
    panel.insertBefore(div, panel.firstChild);
  }

  /* ------------------------------------------------------------
     errors — in plain language, never a status code on screen
     ------------------------------------------------------------ */

  /* `opts.saved === false` says the profile this error is about never
     reached the server. Two of the three callers — loadAndPaint() and
     decide() — can only run on a profile that already exists, so their
     failures are about MATCHING and default to the true reading. The
     questionnaire's submit is the one place where a failure means
     nothing was stored, and the two sentences below that assumed
     otherwise were telling a student "your profile is saved on the
     server" at the exact moment it was not. It RETURNS the sentence it
     painted, so the caller can put the same words where the student is
     looking rather than writing a second version of them. */
  function paintError(err, opts) {
    var panel = $('rmPanel');
    if (!panel) return undefined;
    var saved = !opts || opts.saved !== false;

    var status = err && err.status;
    /* The class the FUNCTION named, when this page has the vocabulary
       loaded. The number alone cannot separate two facts that share
       it: a 503 that means "this deployment has no matching service"
       and a 503 that means "briefly unwell", or our own 404 ("no
       profile is linked to this private link" — `rejected`, the
       student asks for a new link) and a 404 from a route that was
       never deployed (`not-ready` — the deploy has not finished).
       Where the class is absent the old reading of the number stands,
       so an older deploy behaves exactly as it did. */
    var kind = err && err.kind;
    var msg, again = false;

    if (kind ? kind === 'not-ready' : status === 503) {
      msg = saved
        ? 'Roommate matching is not switched on yet on this deployment. Your answers are safe \u2014 ' +
          'your profile is stored on the server, so nothing you have done here is lost. Message us on ' +
          'WhatsApp and we will match you by hand in the meantime.'
        : 'Roommate matching is not switched on yet on this deployment. Nothing you typed has been sent ' +
          'anywhere \u2014 that is our side, not yours. Message us on WhatsApp and we will take your ' +
          'answers down by hand.';
    } else if (kind === 'rejected' || (kind ? false : status === 404)) {
      msg = 'We could not find that profile. The private link may be mistyped, or the profile was withdrawn. ' +
        'You can start a fresh one.';
      again = true;
    } else if (kind ? kind === 'busy' : status === 429) {
      msg = 'That was a lot of requests at once. Give it a moment and try again.';
    } else if (status >= 400 && status < 500) {
      /* A refusal is about what was sent, and only the server knows which
         part — so its own sentence is used when it has one. This case
         used to fall into the branch below, which told the student the
         service was unreachable at the moment it had just answered. */
      msg = (err && err.message) ||
        'That was refused — that is our side, not yours. Nothing you typed has been lost; message us on WhatsApp and we will sort it out.';
    } else {
      msg = saved
        ? 'We could not reach the matching service just now. Your profile is saved on the server \u2014 ' +
          'reopen this page when you have a signal and your matches will be waiting.'
        : 'We could not reach the matching service just now, so nothing has been saved. That is our ' +
          'side, not yours \u2014 message us on WhatsApp and we will take your answers down by hand, or ' +
          'come back and try again in a minute.';
    }

    /* The "Loading your matches…" placeholder loadAndPaint put there
       before the call is not a state this page is in any more — leaving
       it under the error told the student we were still working on
       something we had already given up on. Found by loading the page
       against a deploy with no matching service, which is exactly the
       failure this branch exists for. */
    var pending = panel.querySelector ? panel.querySelector('.rm-empty') : null;
    if (pending && /Loading your matches/.test(pending.textContent || '')) panel.removeChild(pending);

    var div = document.createElement('div');
    div.className = 'rm-err';
    div.innerHTML = '<b>Heads up.</b> ' + esc(msg) +
      (again ? ' <button type="button" class="rm-btn quiet" id="rmAgain" style="margin-top:10px">Start a new profile</button>' : '');
    panel.insertBefore(div, panel.firstChild);

    var againBtn = $('rmAgain');
    if (againBtn) againBtn.addEventListener('click', function () { startOver(true); });
    return msg;
  }

  function startOver(force) {
    var token = readToken();
    if (!force && !window.confirm('Start over? Your current roommate profile and its matches will be withdrawn.')) return;
    function reset() { clearToken(); window.location.href = linkFor('').split('?')[0]; }
    if (!token) return reset();
    api('withdraw', { token: token }).then(reset, reset);
  }

  /* ------------------------------------------------------------
     the returning visitor
     ------------------------------------------------------------ */

  function showReturning(token) {
    var formEl = $('form');
    if (formEl) formEl.style.display = 'none';
    var ret = $('rmReturn');
    if (ret) ret.style.display = '';

    paintLink(token);

    var see = $('rmSeeMatches');
    if (see) see.addEventListener('click', function () { loadAndPaint(token); });

    var over = $('rmStartOver');
    if (over) over.addEventListener('click', function () { startOver(false); });

    /* Fill the panel straight away — a "welcome back" that needs one
       more tap before it says anything is a worse page. */
    loadAndPaint(token);
  }

  function boot() {
    if (typeof Arzuz === 'undefined') return;
    Arzuz.chrome('student');
    Arzuz.footer();

    var fromUrl = tokenFromUrl();
    if (fromUrl) setToken(fromUrl);          /* the link wins, and is remembered */

    /* A private link must never reach a search index. The canonical
       URL is /roommates with no token; anything carrying ?t= is one
       student's key, so while it is in the address bar the page is
       marked noindex. Share it with a friend, not with a crawler. */
    if (fromUrl && !document.querySelector('meta[name="robots"]')) {
      var meta = document.createElement('meta');
      meta.name = 'robots';
      meta.content = 'noindex, nofollow';
      document.head.appendChild(meta);
    }

    var token = readToken();
    if (token) showReturning(token);
    else mountQuestionnaire();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* paintError is returned for the same reason my-care.js returns its
     renderers: what this page says when a call fails is a decision
     worth asserting through the page rather than by reading it.

     handOver is returned for the same reason and one more: it is the only
     path on this page that hands a student's answers to the other
     function, so what it sends and what it does with the answer are
     exactly the two things worth asserting against the real code rather
     than by reading the override that calls it. */
  return { api: api, boot: boot, linkFor: linkFor, waLink: waLink,
    paintError: paintError, paintHandover: paintHandover, handOver: handOver };
})();
