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

/* [lower bound, upper bound, number of students] */
var BANDS = [
 [60000,  100000, 38],
 [100000, 150000, 44],
 [150000, 200000, 37],
 [200000, 250000, 17],
 [250000, 320000, 7]
];

var DEMAND_IS_REAL = false;   // set true once BANDS holds your own data

/* individual price ceilings, spread deterministically inside each
   band so the slider moves smoothly */
var CEILINGS = (function(){
  var out = [], seed = 7;
  function rnd(){ seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; }
  BANDS.forEach(function(b){
    for(var i=0; i<b[2]; i++) out.push(Math.round((b[0] + rnd()*(b[1]-b[0]))/1000)*1000);
  });
  return out;
})();

var DEMAND_TOTAL = CEILINGS.length;

/* option lists used by the forms */
var ROOM_TYPES = ["Self-contain","Shared room","Face-me-I-face-you","Hostel bunk"];

/* Default amenities — admin can extend this list via the dashboard.
   Custom additions are stored in localStorage key 'arzuz_utilities'
   and merged here so all forms stay in sync automatically.          */
var _DEFAULT_UTILITIES = [
 "Borehole water","Pipe-borne water","NEPA connection","Generator backup",
 "Private bathroom","Flush toilet","Security gate","Perimeter fence","Kitchen access"
];

(function(){
  try {
    var stored = JSON.parse(localStorage.getItem('arzuz_utilities') || 'null');
    if (Array.isArray(stored) && stored.length) {
      // Merge: keep defaults order, append any custom ones not already present
      var merged = _DEFAULT_UTILITIES.slice();
      stored.forEach(function(item){
        if (merged.indexOf(item) === -1) merged.push(item);
      });
      window.UTILITIES = merged;
    } else {
      window.UTILITIES = _DEFAULT_UTILITIES.slice();
    }
  } catch(e) {
    window.UTILITIES = _DEFAULT_UTILITIES.slice();
  }
})();
