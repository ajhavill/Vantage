// Vantage — Comparable Transactions normalization engine.
//
// ONE source of truth for the comp math, used in three places:
//   • the browser (Cockpit) loads it via <script src> for live form preview + sorting,
//   • the Netlify function (comps.js) require()s it to store authoritative metrics,
//   • the Node unit test (tools/comps-math.test.js) require()s it to verify the math.
// The UMD guard at the bottom exports for Node while attaching to window in the browser.
//
// -------------------------------------------------------------------------
// THE THREE METRICS
// -------------------------------------------------------------------------
// A signed lease can be summarized three ways; this module computes all three
// so the comps view can toggle which one is shown and sorted on:
//
//   1. FACE RATE ($/RSF/yr)          — the starting contractual base rent. What
//                                       the lease is "quoted" at. Ignores concessions.
//
//   2. TOTAL OCCUPANCY COST ($/RSF/yr, avg over term) — the all-in gross annual
//                                       cost the tenant actually pays out: average
//                                       base rent (with escalations) + operating
//                                       expenses (for NNN/MG) + parking. Ignores
//                                       concessions (they're a landlord give-back,
//                                       not a tenant outlay).
//
//   3. NET EFFECTIVE RENT ($/RSF/yr)  — THE normalized, apples-to-apples number.
//                                       Base rent LESS concessions (free rent + TI),
//                                       amortized over the full term and DISCOUNTED
//                                       to present value, then re-levelized into a
//                                       constant annual rate. This is what makes two
//                                       deals with different free-rent/TI packages
//                                       comparable.
//
// -------------------------------------------------------------------------
// NET EFFECTIVE RENT — exact method (monthly cash flows, discounted)
// -------------------------------------------------------------------------
//   • Build the month-by-month base-rent stream for the whole premises, applying
//     annual escalations. Free-rent months are $0 (abated; assumed at the front).
//   • The TI allowance (ti_allowance_psf × rsf) is a landlord cost paid at month 0.
//   • PV(net to landlord) = Σ month_rent / (1+r)^m   −   TI      (r = monthly discount)
//   • Re-levelize: find the constant monthly payment A whose PV over the same term
//     equals PV(net):   A = PV(net) / annuityFactor,   annuityFactor = Σ 1/(1+r)^m.
//   • NER $/RSF/yr = A × 12 / rsf.
//
// Worked example you can check by hand (discount 0%):
//   10,000 RSF · 60-month term · $36.00 face · 5 months free · $50/RSF TI · FSG
//   Gross over term:            $36 × 5 yr           = $180.00 /SF
//   Less free rent (5 months):  −(5/12 × $36)        = −$15.00 /SF
//   Less TI:                    −$50                 = −$50.00 /SF
//   Net over term:                                   = $115.00 /SF
//   ÷ 5 years:                                       =  $23.00 /SF/yr  ← NER
// (With an 8% discount rate the same deal nets ≈ $20.26/SF — the paying months are
//  pushed to the back of the term, so they're worth less against the upfront TI.)

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node (function + test)
  if (root) root.CompsMath = api;                                             // browser (window.CompsMath)
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var DEFAULT_DISCOUNT = 8; // annual %, industry-standard for NER; overridable per comp

  function num(v, dflt) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  // Annual base rate ($/RSF/yr) in effect during lease-year y (1-based), per the
  // escalation structure. Lease years are 12-month blocks from commencement.
  function annualRateForYear(comp, y) {
    var face = num(comp.face_rate, 0);
    var esc = comp.escalation || {};
    var type = esc.type || "none";
    if (y < 1) y = 1;
    if (type === "percent") {
      return face * Math.pow(1 + num(esc.value, 0) / 100, y - 1);
    }
    if (type === "fixed") { // fixed $/RSF annual step
      return face + num(esc.value, 0) * (y - 1);
    }
    if (type === "schedule" && Array.isArray(esc.schedule) && esc.schedule.length) {
      var i = Math.min(y - 1, esc.schedule.length - 1); // last value carries forward
      return num(esc.schedule[i], face);
    }
    return face; // 'none'
  }

  function leaseYearOfMonth(m) { return Math.floor((m - 1) / 12) + 1; } // m 1-based

  // Whole-premises base rent for month m (1-based), $0 during the front-loaded
  // free-rent window. Escalations step at each 12-month lease-year boundary.
  function monthlyBaseRent(comp, m) {
    var free = Math.max(0, Math.round(num(comp.free_rent_months, 0)));
    if (m <= free) return 0;
    var rsf = num(comp.rsf, 0);
    return annualRateForYear(comp, leaseYearOfMonth(m)) * rsf / 12;
  }

  // Average annual base rent per RSF over the term (escalations weighted by months;
  // free rent NOT netted — this is a gross measure).
  function avgAnnualBasePSF(comp) {
    var term = Math.max(1, Math.round(num(comp.term_months, 0)));
    var rsf = num(comp.rsf, 0);
    if (rsf <= 0) return 0;
    var sum = 0;
    for (var m = 1; m <= term; m++) sum += annualRateForYear(comp, leaseYearOfMonth(m)) * rsf / 12;
    return (sum / rsf) * (12 / term); // annualized $/RSF/yr
  }

  // Parking cost expressed as $/RSF/yr. spaces = ratio per 1,000 RSF (or explicit
  // parking_spaces); rate = $/space/month. Returns 0 when parking is free/unpriced.
  function parkingPSFYear(comp) {
    var rsf = num(comp.rsf, 0);
    if (rsf <= 0) return 0;
    var rate = num(comp.parking_rate, 0); // $/space/month
    if (rate <= 0) return 0;
    var spaces = num(comp.parking_spaces, 0);
    if (spaces <= 0) {
      var ratio = num(comp.parking_ratio, 0); // spaces per 1,000 RSF
      spaces = ratio * rsf / 1000;
    }
    if (spaces <= 0) return 0;
    return rate * spaces * 12 / rsf;
  }

  function faceRatePSF(comp) { return num(comp.face_rate, 0); }

  // All-in average annual cost the tenant pays out, per RSF. For NNN/MG the
  // net face is grossed up by operating expenses (opex_psf); FSG face already
  // includes services so opex_psf is typically 0. Parking added on top.
  function totalOccupancyCostPSF(comp) {
    return avgAnnualBasePSF(comp) + num(comp.opex_psf, 0) + parkingPSFYear(comp);
  }

  // Present value of $1 paid at the end of each month for n months, discounted at
  // monthly rate r. Closed form; falls back to n when r == 0.
  function annuityFactor(n, r) {
    if (r === 0) return n;
    return (1 - Math.pow(1 + r, -n)) / r;
  }

  // NET EFFECTIVE RENT ($/RSF/yr), discounted. See header for the method.
  function netEffectiveRentPSF(comp, discountAnnualPct) {
    var rsf = num(comp.rsf, 0);
    var term = Math.max(1, Math.round(num(comp.term_months, 0)));
    if (rsf <= 0) return 0;
    var d = (discountAnnualPct == null)
      ? (comp.discount_rate != null ? num(comp.discount_rate, DEFAULT_DISCOUNT) : DEFAULT_DISCOUNT)
      : num(discountAnnualPct, DEFAULT_DISCOUNT);
    var r = d / 100 / 12; // monthly discount rate

    var pv = 0;
    for (var m = 1; m <= term; m++) pv += monthlyBaseRent(comp, m) / Math.pow(1 + r, m);
    pv -= num(comp.ti_allowance_psf, 0) * rsf; // TI disbursed at month 0

    var af = annuityFactor(term, r);
    var levelMonthly = pv / af;               // constant monthly payment, same PV
    return levelMonthly * 12 / rsf;           // annualized $/RSF/yr
  }

  // Compute all three metrics at once. Returns numbers rounded to cents.
  function computeMetrics(comp, discountAnnualPct) {
    var round2 = function (x) { return Math.round(x * 100) / 100; };
    return {
      face_rate_psf: round2(faceRatePSF(comp)),
      total_occupancy_cost_psf: round2(totalOccupancyCostPSF(comp)),
      net_effective_rent_psf: round2(netEffectiveRentPSF(comp, discountAnnualPct))
    };
  }

  return {
    DEFAULT_DISCOUNT: DEFAULT_DISCOUNT,
    annualRateForYear: annualRateForYear,
    monthlyBaseRent: monthlyBaseRent,
    avgAnnualBasePSF: avgAnnualBasePSF,
    parkingPSFYear: parkingPSFYear,
    faceRatePSF: faceRatePSF,
    totalOccupancyCostPSF: totalOccupancyCostPSF,
    annuityFactor: annuityFactor,
    netEffectiveRentPSF: netEffectiveRentPSF,
    computeMetrics: computeMetrics
  };
});
