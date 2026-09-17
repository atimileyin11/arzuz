/* ============================================================
   Arzuz — shared application logic
   Page chrome, formatting helpers, and the multi-step form engine.
   ============================================================ */

var Arzuz = (function(){

  /* ---------- formatting helpers ---------- */
  function ng(n){ return "\u20A6" + Number(n).toLocaleString(); }

  function pad(n){ return String(n).padStart(2,'0'); }
  var D = new Date();
  var STAMP_DATE = pad(D.getDate())+'\u00B7'+pad(D.getMonth()+1)+'\u00B7'+String(D.getFullYear()).slice(2);

  function isReal(){
    return typeof DEMAND_IS_REAL !== 'undefined' && DEMAND_IS_REAL;
  }

  /* how many registered students can afford a given price */
  function reach(price){
    if (typeof CEILINGS === 'undefined') return 0;
    return CEILINGS.filter(function(c){ return c >= price; }).length;
  }

  /* ---------- page chrome ---------- */
  function chrome(role){
    if (document.querySelector('header')) return;
    var tag = role === 'owner' ? 'Landlord Portal' : (role === 'student' ? 'Student Portal' : 'Know before you pay.');
    document.body.insertAdjacentHTML('afterbegin',
      '<header><div class="hrow"><a href="index.html" aria-label="Arzuz Home">'+
      '<span class="m"><span>az</span></span>'+
      '<span class="hw">ar<i>z</i>u<i>z</i></span></a>'+
      '<span class="htag">' + tag + '</span></div></header>');
  }

  function footer(){
    if (document.querySelector('.sitefoot')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="wrap"><div class="sitefoot">'+
      '<div class="flinks">'+
      '<a href="safety.html">Your safety</a>'+
      '<a href="privacy.html">Privacy</a>'+
      '<a href="terms.html">Terms</a>'+
      '<a href="mailto:support@arzuz.com">support@arzuz.com</a></div>'+
      'Arzuz does not collect rent, hold deposits, or take payment from tenants. '+
      'Your phone number is used to verify your account and send you matches. '+
      'It is never shown publicly.<br><br>'+
      'Arzuz \u2014 Malete, Kwara State. Pronounced AR-zuz.'+
      '</div></div>');
  }

  /* ---------- multi-step form engine ---------- */
  var F = {steps:[], step:0, answers:{}, done:'', backHref:'', backLabel:'', table:null};

  function form(opts){
    F.steps = opts.steps; F.step = 0; F.answers = {};
    F.done = opts.done; F.backHref = opts.backHref || 'index.html';
    F.backLabel = opts.backLabel || '\u2190 Back';
    F.table = opts.table || null;
    draw();
  }

  function shown(i){
    var st = F.steps[i];
    return !st || !st.onlyIf || st.onlyIf(F.answers);
  }

  function isLast(){
    for(var i = F.step + 1; i < F.steps.length; i++) if(shown(i)) return false;
    return true;
  }

  function draw(){
    var el = document.getElementById('form');
    if (!el) return;
    var s = F.steps[F.step];
    if (!s) return;

    var progressPct = Math.round(((F.step + 1) / F.steps.length) * 100);
    var h = '<div class="step-anim">';
    h += '<a class="back" href="'+F.backHref+'">'+F.backLabel+'</a>';
    h += '<div class="prog"><i style="width:'+progressPct+'%"></i></div>';
    h += '<h2 class="qh">'+s.h+'</h2>';
    if(s.hint) h += '<div class="qhint">'+s.hint+'</div>';

    if(s.ctx) h += '<div class="ctxbox">'+ (isReal()
      ? '<b>'+(typeof DEMAND_TOTAL !== 'undefined' ? DEMAND_TOTAL : '61')+' students</b> are looking in Malete this session. '+
        'Most can pay between \u20A6100,000 and \u20A6200,000.'
      : 'We will show you exactly how many students are looking in your area, and what '+
        'they can pay, as soon as your listing is in.') +'</div>';

    if(s.o) h += '<div class="opts">'+ s.o.map(function(o){
      var isSel = F.answers[s.k] === o;
      return '<button type="button" class="opt'+(isSel?' sel':'')+'" data-v="'+o+'">'+o+'</button>';
    }).join('') +'</div>';

    if(s.c) {
      var currentChecks = F.answers[s.k] || [];
      h += '<div class="checks">'+ s.c.map(function(o){
        var isChecked = Array.isArray(currentChecks) && currentChecks.indexOf(o) !== -1;
        return '<span class="chk'+(isChecked?' sel':'')+'" data-v="'+o+'">'+o+'</span>';
      }).join('') +'</div>';
    }

    if(s.f) h += s.f.map(function(f){
      var x = '<div class="fld"><label for="'+f[0]+'">'+f[1]+'</label>';
      var val = F.answers[f[0]] || '';
      if(f[2]==='sel'){
        x += '<select id="'+f[0]+'"><option value="">Choose one</option>'+
             f[3].map(function(o){
               return '<option'+(val===o?' selected':'')+'>'+o+'</option>';
             }).join('')+'</select>';
      } else if(f[2]==='pin'){
        x += '<div class="pinbox"><b></b><i></i></div>'+
             '<div class="live">Location captured, accurate to about 12 metres. '+
             'Drag the pin if it sits in the wrong compound.</div>';
      } else if(f[2]==='rent-live'){
        x += '<input type="number" id="'+f[0]+'" placeholder="220000" value="'+val+'">'+
             '<div class="live" id="rentOut">Type a price and we will show how many students can reach you.</div>';
      } else {
        x += '<input type="'+f[2]+'" id="'+f[0]+'" value="'+val+'" placeholder="'+f[1]+'">';
      }
      return x + '</div>';
    }).join('');

    if(s.ta) h += '<textarea id="'+s.k+'" placeholder="'+s.ta+'">'+(F.answers[s.k]||'')+'</textarea>';

    h += '<div class="nav">';
    if(F.step > 0) h += '<button type="button" class="bk" id="fBack">Back</button>';
    h += '<button type="button" class="next" id="fNext">'+
         (isLast() ? 'Finish' : (s.opt ? 'Skip' : 'Continue'))+'</button></div>';
    h += '</div>';

    el.innerHTML = h;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Option buttons event listener
    el.querySelectorAll('.opt').forEach(function(b){
      b.addEventListener('click', function(){
        F.answers[s.k] = b.dataset.v;
        el.querySelectorAll('.opt').forEach(function(o){o.classList.remove('sel')});
        b.classList.add('sel');
        setTimeout(next, 160);
      });
    });

    // Checkboxes event listener
    el.querySelectorAll('.chk').forEach(function(c){
      c.addEventListener('click', function(){ 
        c.classList.toggle('sel'); 
        var selectedChecks = [];
        el.querySelectorAll('.chk.sel').forEach(function(sc){
          selectedChecks.push(sc.dataset.v);
        });
        F.answers[s.k] = selectedChecks;
      });
    });

    // Rent live listener
    var rl = el.querySelector('#'+(s.f && s.f[0] && s.f[0][2]==='rent-live' ? s.f[0][0] : '__none'));
    if(rl) {
      var updateRentDisplay = function(){
        var v = Number(rl.value), out = document.getElementById('rentOut');
        if (!out) return;
        if(!v){ out.innerHTML = 'Type a price and we will show how many students can reach you.'; return; }
        var r = reach(v);
        var totalDemand = typeof DEMAND_TOTAL !== 'undefined' ? DEMAND_TOTAL : 61;
        out.innerHTML = isReal()
          ? '<b>'+r+'</b> of the '+totalDemand+' students looking in Malete can afford this.'+
            (v > 200000 ? ' Drop to \u20A6200,000 and '+(reach(200000)-r)+' more can see you.' : '')
          : 'Noted. We will tell you how many students this reaches once your listing is live.';
      };
      rl.addEventListener('input', updateRentDisplay);
      if(rl.value) updateRentDisplay();
    }

    var bk = document.getElementById('fBack');
    if(bk) bk.addEventListener('click', prev);
    document.getElementById('fNext').addEventListener('click', next);
  }

  function collect(){
    var s = F.steps[F.step];
    if (!s) return;
    if(s.f) s.f.forEach(function(f){
      var e = document.getElementById(f[0]); 
      if(e) F.answers[f[0]] = e.value;
    });
    if(s.ta){ 
      var t = document.getElementById(s.k); 
      if(t) F.answers[s.k] = t.value; 
    }
  }

  function next(){
    collect();
    var i = F.step + 1;
    while(i < F.steps.length && !shown(i)) i++;
    if(i < F.steps.length){ F.step = i; draw(); }
    else finish();
  }

  function prev(){
    collect();
    var i = F.step - 1;
    while(i >= 0 && !shown(i)) i--;
    if (i >= 0) { F.step = i; draw(); }
  }

  function finish(){
    var el = document.getElementById('form');

    if(!F.table || typeof ArzuzSubmit === 'undefined'){
      el.innerHTML = F.done; window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }

    var btn = document.getElementById('fNext');
    if(btn){ btn.textContent = 'Saving to database\u2026'; btn.disabled = true; }

    ArzuzSubmit.send(F.table, F.answers).then(function(res){
      el.innerHTML = F.done;
      if(res.queued){
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #F59E0B;">'+
          'Your connection dropped or database is in local preview mode. Submission is '+
          'saved on your device and will sync automatically once online.</div>');
      } else if(res.ok) {
        el.insertAdjacentHTML('beforeend',
          '<div class="live" style="margin-top:16px; border-left: 3.5px solid #10B981;">'+
          '<b>Submission saved!</b> Your information was securely sent to the database.</div>');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  return { 
    ng: ng, 
    STAMP_DATE: STAMP_DATE, 
    reach: reach, 
    isReal: isReal,
    chrome: chrome, 
    footer: footer, 
    form: form,
    answers: function(){ return F.answers; }
  };
})();
