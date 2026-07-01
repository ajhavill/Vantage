// Vantage — unit test for the Comparable Transactions normalization engine.
// Run:  node tools/comps-math.test.js
//
// No test framework (the project has no build step). Plain asserts + a readable
// worked-example dump so the core NER number can be checked by hand.

var M = require("../site/public/assets/comps-math.js");

var passed = 0, failed = 0;
function approx(name, got, want, tol) {
  tol = tol == null ? 0.01 : tol;
  var ok = Math.abs(got - want) <= tol;
  (ok ? passed++ : failed++);
  console.log((ok ? "  PASS " : "  FAIL ") + name +
    "  got " + round(got) + "  want " + round(want) + (ok ? "" : "  (tol " + tol + ")"));
}
function round(x) { return Math.round(x * 1e6) / 1e6; }

// -------------------------------------------------------------------------
// 1. THE HAND-VERIFIABLE WORKED EXAMPLE (discount 0% isolates the amortization)
// -------------------------------------------------------------------------
// 10,000 RSF · 60-month term · $36 face · 5 months free · $50/RSF TI · no escalation
//   Gross:        $36 × 5yr            = $180.00 /SF
//   Free rent:    −(5/12 × $36)        = −$15.00 /SF
//   TI:           −$50                 = −$50.00 /SF
//   Net / 5 yr:   $115.00 / 5          =  $23.00 /SF/yr
console.log("\n[1] Worked example, 0% discount  (hand check → $23.00/SF/yr)");
var comp1 = {
  rsf: 10000, term_months: 60, face_rate: 36,
  escalation: { type: "none" }, free_rent_months: 5, ti_allowance_psf: 50,
  expense_structure: "FSG"
};
approx("net effective rent @0%", M.netEffectiveRentPSF(comp1, 0), 23.00, 0.0001);
approx("face rate", M.faceRatePSF(comp1), 36.00, 0.0001);
approx("total occupancy (FSG, no parking/opex)", M.totalOccupancyCostPSF(comp1), 36.00, 0.0001);

// -------------------------------------------------------------------------
// 2. SAME DEAL, 8% DISCOUNT — cross-checked with an INDEPENDENT closed-form calc
// -------------------------------------------------------------------------
// The module sums month-by-month; here we recompute via the ordinary-annuity
// closed form (a genuinely different method) and require they agree.
console.log("\n[2] Worked example, 8% discount  (independent closed-form cross-check)");
(function () {
  var rsf = 10000, term = 60, monthlyRent = 36 * rsf / 12, free = 5, ti = 50 * rsf;
  var r = 0.08 / 12;
  var AF = function (n) { return (1 - Math.pow(1 + r, -n)) / r; };
  // PV of paying months 6..60 = 30000 × (AF(60) − AF(5)); TI at month 0
  var pv = monthlyRent * (AF(term) - AF(free)) - ti;
  var levelMonthly = pv / AF(term);
  var expected = levelMonthly * 12 / rsf;
  approx("net effective rent @8% vs closed form", M.netEffectiveRentPSF(comp1, 8), expected, 1e-9);
  console.log("       (both methods → " + round(expected) + " /SF/yr)");
  // sanity: discounting lowers NER relative to the 0% case
  var ok = M.netEffectiveRentPSF(comp1, 8) < M.netEffectiveRentPSF(comp1, 0);
  (ok ? passed++ : failed++);
  console.log("  " + (ok ? "PASS " : "FAIL ") + "discounted NER < undiscounted NER");
})();

// -------------------------------------------------------------------------
// 3. ESCALATION, 0% discount — average of the annual steps is hand-checkable
// -------------------------------------------------------------------------
// 10,000 RSF · 24-month term · $40 face · 3%/yr · no free/TI · FSG
//   Yr1 $40.00, Yr2 $41.20  →  avg (40+41.20)/2 = $40.60/SF  → NER @0% = $40.60
console.log("\n[3] 3% annual escalation, 0% discount  (hand check → $40.60/SF/yr)");
var comp3 = {
  rsf: 10000, term_months: 24, face_rate: 40,
  escalation: { type: "percent", value: 3 }, free_rent_months: 0, ti_allowance_psf: 0,
  expense_structure: "FSG"
};
approx("year-2 rate escalated 3%", M.annualRateForYear(comp3, 2), 41.20, 0.0001);
approx("net effective rent @0%", M.netEffectiveRentPSF(comp3, 0), 40.60, 0.0001);
approx("total occupancy = avg base", M.totalOccupancyCostPSF(comp3), 40.60, 0.0001);

// -------------------------------------------------------------------------
// 4. NNN gross-up + parking flow into total occupancy cost
// -------------------------------------------------------------------------
// $30 NNN face + $14 opex + parking: 3.0 spaces/1,000 SF @ $125/space/mo
//   parking $/SF/yr = 125 × (3.0 × 10000/1000) × 12 / 10000 = 125 × 30 × 12 / 10000 = $4.50
//   total occupancy = 30 + 14 + 4.50 = $48.50/SF/yr
console.log("\n[4] NNN gross-up + parking  (hand check → $48.50/SF/yr total occupancy)");
var comp4 = {
  rsf: 10000, term_months: 60, face_rate: 30, escalation: { type: "none" },
  free_rent_months: 0, ti_allowance_psf: 0, expense_structure: "NNN",
  opex_psf: 14, parking_ratio: 3.0, parking_rate: 125
};
approx("parking $/SF/yr", M.parkingPSFYear(comp4), 4.50, 0.0001);
approx("total occupancy cost", M.totalOccupancyCostPSF(comp4), 48.50, 0.0001);
approx("face rate (unchanged)", M.faceRatePSF(comp4), 30.00, 0.0001);

// -------------------------------------------------------------------------
// 5. computeMetrics returns all three, rounded to cents
// -------------------------------------------------------------------------
console.log("\n[5] computeMetrics()");
var mtr = M.computeMetrics(comp1, 8);
approx("metrics.face_rate_psf", mtr.face_rate_psf, 36.00, 0.0001);
approx("metrics.total_occupancy_cost_psf", mtr.total_occupancy_cost_psf, 36.00, 0.0001);
(function () {
  var ok = mtr.net_effective_rent_psf > 20 && mtr.net_effective_rent_psf < 21;
  (ok ? passed++ : failed++);
  console.log("  " + (ok ? "PASS " : "FAIL ") + "metrics.net_effective_rent_psf ≈ 20.26  (got " + mtr.net_effective_rent_psf + ")");
})();

console.log("\n" + (failed ? "✗ " : "✓ ") + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
