/* ============================================================
   Arzuz — reference data

   Only the demand distribution remains. It drives the illustrative
   price curve on the homepage.

   >>> REPLACE THIS THE MOMENT YOU HAVE REAL RECORDS. <<<
   Run  select * from demand_summary;  in Supabase, and put your
   real counts in BANDS below. The homepage label switches from
   "illustrative" to "live" automatically when DEMAND_IS_REAL
   is set to true.
   ============================================================ */

/* [lower bound, upper bound, number of students]
   The floor is honest about Malete: rooms at ₦80,000–₦100,000 a session
   barely exist near KWASU, so a band that starts there promises matches
   we cannot send. The bands below are what students actually pay — a
   total per session, rent plus the extra charges — from hostel beds to
   self-contains. */
var BANDS = [
 [0,       150000, 34],
 [150000,  200000, 44],
 [200000,  300000, 37],
 [300000,  500000, 21],
 [500000,  800000, 5],
 [800000,  1200000, 1],
 [1200000, 0, 1]
];

var DEMAND_IS_REAL = false;   // set true once BANDS holds your own data

/* individual price ceilings, spread deterministically inside each
   band so the slider moves smoothly. Open-ended bands (0 sentinel,
   mirroring the form's "Under" / "Above" options) sample a sensible
   sub-range instead of crossing the sentinel. */
var CEILINGS = (function(){
  var out = [], seed = 7;
  function rnd(){ seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; }
  BANDS.forEach(function(b){
    var lo = b[0] || Math.round(b[1] * 0.4);
    var hi = b[1] || Math.round(b[0] * 1.5);
    for(var i=0; i<b[2]; i++) out.push(Math.round((lo + rnd()*(hi-lo))/1000)*1000);
  });
  return out;
})();

var DEMAND_TOTAL = CEILINGS.length;

/* option lists used by the forms.
   PROPERTY_TYPES is the ONE list for property/room types. The public
   landlord form (owner-list.html) and the admin dashboard (Add + Edit
   apartment) both read from here, so an admin-created listing always
   matches the vocabulary of the site. Add a new type once, here. */
var ROOM_TYPES = ["Self-contain","Shared room","Face-me-I-face-you","Hostel bunk"];

var PROPERTY_TYPES = [
  "Self-contain",
  "Shared room",
  "Single Room",
  "Face-me-I-face-you",
  "Two Bedroom",
  "Hostel",
  "Boys quarters"
];

/* Default amenities. The admin dashboard can add more, and those live
   in the `amenities` table in Supabase so every browser sees them —
   not just the browser that added them. localStorage is only the
   offline fallback.                                                   */
var _DEFAULT_UTILITIES = [
 "Borehole water","Pipe-borne water","NEPA connection","Generator backup",
 "Private bathroom","Flush toilet","Security gate","Perimeter fence","Kitchen access"
];

var ArzuzData = (function(){

  var STORE_KEY = 'arzuz_utilities';
  var customs = null;   // null = not loaded yet / unavailable

  function cfg(){ return window.ARZUZ_CONFIG || {}; }

  function readStored(){
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return Array.isArray(v) ? v : [];
    } catch(e){ return []; }
  }

  function writeStored(list){
    try {
      if (list && list.length) localStorage.setItem(STORE_KEY, JSON.stringify(list));
      else localStorage.removeItem(STORE_KEY);
    } catch(e){}
  }

  /* defaults first, then whatever custom labels are available */
  function merge(){
    var out = _DEFAULT_UTILITIES.slice();
    var extra = customs || readStored();
    extra.forEach(function(item){
      if (item && out.indexOf(item) === -1) out.push(item);
    });
    window.UTILITIES = out;
    return out;
  }

  function fetchCustoms(){
    var c = cfg();
    if (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY) return Promise.resolve(undefined);
    var url = c.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/amenities?select=name&order=name';
    return fetch(url, {
      headers: {
        'apikey': c.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + c.SUPABASE_ANON_KEY
      }
    }).then(function(r){
      /* Nothing here reaches a person — reload() falls back to the stored
         amenity list — but the status still must not be composed into a
         message, so that one rule can be checked across the whole site. */
      if (!r.ok) throw new Error(typeof ArzuzApiErrors !== 'undefined'
        ? ArzuzApiErrors.sentence({ status: r.status })
        : 'Arzuz could not read the amenity list.');
      return r.json();
    }).then(function(rows){
      return (rows || []).map(function(x){ return x.name; }).filter(Boolean);
    });
  }

  function reload(){
    return fetchCustoms().then(function(names){
      if (names === undefined) return merge();   // not configured
      customs = names;
      writeStored(names);
      return merge();
    }).catch(function(){
      // offline or table missing: keep the stored copy so forms still work
      return merge();
    });
  }

  /* Never let a slow connection hold the form hostage: if the amenity
     table has not answered within 4 seconds, open the form with what
     we have and refresh when the answer lands. */
  function withTimeout(promise, ms){
    return new Promise(function(resolve){
      var settled = false;
      var timer = setTimeout(function(){
        if (!settled){ settled = true; resolve(merge()); }
      }, ms);
      promise.then(function(v){
        if (!settled){ settled = true; clearTimeout(timer); resolve(v); }
      }, function(){
        if (!settled){ settled = true; clearTimeout(timer); resolve(merge()); }
      });
    });
  }

  /* Set UTILITIES synchronously so forms built immediately still have
     options, then refresh from the database in the background. */
  merge();

  var ready = withTimeout(reload(), 4000);

  return {
    ready:   ready,          // promise: resolves once the first load is done
    reload:  reload,         // promise: re-reads the amenity table
    merge:   merge,
    customs: function(){ return customs || []; }
  };
})();
