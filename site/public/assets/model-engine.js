// Vantage — Occupancy Modeling Engine (VModel).
// Pure, dependency-free financial core for comparing occupancy options side by side.
// Runs in the browser (window.VModel) and in Node (module.exports) so it can be unit-tested.
//
// CONVENTIONS (documented so a hand calc reconciles exactly):
//   • Annual periods, t = 1..N (lease years).
//   • Rent is paid in advance, so each lease YEAR's recurring cost is discounted at the
//     START of that year: discount factor df(t) = (1+r)^-(t-1)  → year 1 is undiscounted.
//   • One-time costs (moving, cabling, FF&E, make-good) and the TI credit land at t=0 (df=1).
//   • Base rent escalates annually. Opex:
//       - FSG (base-year stop): year 1 is the base year; tenant pays only the INCREASE in
//         opex over the base year in later years.
//       - NNN (pass-through): tenant pays the FULL opex each year, escalating.
//   • Free rent abates BASE rent only (opex + parking still paid), applied to the first months.
//   • TI is a landlord credit (reduces effective rent and all-in cost).
//   • Parking is its OWN line: spaces = ratio/1000 × RSF; cost = spaces × monthlyRate × 12,
//     escalating annually. Never buried in rent.
//
// METRICS (per option):
//   • netEffectivePSF — net effective GROSS rent, $/RSF/yr:
//         (Σ tenant-paid rent [base after free + opex tenant pays] − TI) / RSF / N
//     (excludes parking + one-time; the apples-to-apples FSG-vs-NNN rent comparable)
//   • allIn — total nominal dollars over term: Σ(rent + parking) + one-time + make-good − TI
//   • npv — allIn discounted to present at the deal discount rate
//
// GROWTH / UNCERTAINTY:
//   headcount grows on a curve → usable SF (headcount × density) → rentable SF (× load factor).
//   Modeled under low / base / high growth. For a fixed-size option (e.g. renew in place) the
//   size is held and any band that outgrows it is flagged as a shortfall; for a sized-to-need
//   option each band produces its own RSF (and therefore its own cost), surfacing the spread.
(function () {
  "use strict";

  function n(v) { if (v == null || v === "") return 0; var x = Number(v); return isFinite(x) ? x : 0; }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  // Per-year cash flow + metrics for ONE option at a SPECIFIC rentable SF.
  function computeOption(o, rsf) {
    rsf = n(rsf);
    var N = Math.max(0, Math.round(n(o.termYears)));
    var r = n(o.discountRatePct) / 100;
    var esc = n(o.rentEscalationPct) / 100;
    var og = n(o.opexGrowthPct) / 100;
    var freeYears = n(o.freeRentMonths) / 12;
    var structure = (o.structure === "NNN") ? "NNN" : "FSG";
    var pk = o.parking || {};
    var spaces = (n(pk.ratioPer1000) * rsf) / 1000;

    var years = [], sumTenantPays = 0, sumParking = 0, sumRecurring = 0, npvRecurring = 0, sumRentAbated = 0;
    for (var t = 1; t <= N; t++) {
      var baseGrossPSF = n(o.baseRentPSF) * Math.pow(1 + esc, t - 1);
      // fraction of THIS lease year abated by free rent (free rent sits at the front of the term)
      var freeFrac = 0, yearStart = t - 1;
      if (freeYears > yearStart) freeFrac = Math.min(1, freeYears - yearStart);
      var baseAfterFreePSF = baseGrossPSF * (1 - freeFrac);
      sumRentAbated += baseGrossPSF * freeFrac * rsf;

      var opexTenantPSF;
      var opexT = n(o.opexBasePSF) * Math.pow(1 + og, t - 1);
      if (structure === "NNN") opexTenantPSF = opexT;                    // full pass-through
      else opexTenantPSF = Math.max(0, opexT - n(o.opexBasePSF));        // FSG base-year stop: increases only

      var tenantPaysPSF = baseAfterFreePSF + opexTenantPSF;
      var tenantPays = tenantPaysPSF * rsf;
      var parking = spaces * n(pk.monthlyRate) * 12 * Math.pow(1 + n(pk.escalationPct) / 100, t - 1);
      var recurring = tenantPays + parking;
      var df = Math.pow(1 + r, -(t - 1));

      years.push({
        t: t, basePSF: baseGrossPSF, baseAfterFreePSF: baseAfterFreePSF, opexTenantPSF: opexTenantPSF,
        tenantPaysPSF: tenantPaysPSF, tenantPays: tenantPays, parking: parking, recurring: recurring, df: df
      });
      sumTenantPays += tenantPays; sumParking += parking; sumRecurring += recurring; npvRecurring += recurring * df;
    }

    var ti = n(o.tiPSF) * rsf;
    var ot = o.oneTime || {};
    var oneTime = (n(ot.movingPSF) + n(ot.cablingPSF) + n(ot.ffnePSF)) * rsf;
    var makeGood = (o.makeGood && o.makeGood.on) ? n(o.makeGood.psf) * rsf : 0;
    var upfront = oneTime + makeGood - ti;                 // net upfront outflow at t=0
    var allIn = sumRecurring + upfront;
    var npv = npvRecurring + upfront;                      // upfront at t=0 → df = 1
    var netEffectivePSF = N > 0 && rsf > 0 ? (sumTenantPays - ti) / rsf / N : 0;

    return {
      rsf: rsf, termYears: N, structure: structure, years: years,
      ti: ti, oneTime: oneTime, makeGood: makeGood, upfront: upfront,
      sumTenantPays: sumTenantPays, sumParking: sumParking, sumRecurring: sumRecurring, freeRentAbated: sumRentAbated,
      allIn: allIn, npv: npv, netEffectivePSF: netEffectivePSF,
      allInPSFYr: N > 0 && rsf > 0 ? allIn / rsf / N : 0
    };
  }

  // Peak rentable SF the headcount curve demands over the term, for a given growth rate.
  function requiredRSF(o, growthPct) {
    var N = Math.max(1, Math.round(n(o.termYears)));
    var g = n(growthPct) / 100;
    var dens = n(o.densityUsfPerEmp) || 200, load = n(o.loadFactor) || 1.15, hc0 = n(o.headcountStart);
    var peak = 0, peakYear = 1, peakHC = hc0;
    for (var t = 1; t <= N; t++) {
      var hc = hc0 * Math.pow(1 + g, t - 1);
      var need = hc * dens * load;
      if (need > peak) { peak = need; peakYear = t; peakHC = hc; }
    }
    return { rsf: Math.ceil(peak), peakYear: peakYear, peakHeadcount: Math.round(peakHC) };
  }

  // Run one option across low / base / high growth bands.
  function runOption(o) {
    var g = o.growth || {}, bands = {};
    var order = ["low", "base", "high"];
    order.forEach(function (b) {
      var need = null, rsf;
      var hasGrowth = n(o.headcountStart) > 0 && g[b] != null;
      if (o.sizeMode === "byHeadcount") {
        need = requiredRSF(o, g[b]);
        rsf = n(o.rsfOverride) || need.rsf;
      } else {
        rsf = n(o.rsf);
        if (hasGrowth) need = requiredRSF(o, g[b]);
      }
      var res = computeOption(o, rsf);
      res.requiredRSF = need ? need.rsf : null;
      res.peakHeadcount = need ? need.peakHeadcount : null;
      res.shortfallSF = (o.sizeMode !== "byHeadcount" && need) ? Math.max(0, need.rsf - rsf) : 0;
      bands[b] = res;
    });
    return {
      name: o.name || "Option", side: o.side || null, structure: bands.base.structure, termYears: bands.base.termYears,
      input: o, bands: bands, base: bands.base,
      spread: { allIn: bands.high.allIn - bands.low.allIn, npv: bands.high.npv - bands.low.npv, netEff: bands.high.netEffectivePSF - bands.low.netEffectivePSF }
    };
  }

  // Compare N options side by side (generic — the primitive under every scenario).
  function compareOptions(options) {
    var runs = (options || []).map(runOption);
    var best = null;
    runs.forEach(function (r) { if (best == null || r.base.npv < runs[best].base.npv) best = runs.indexOf(r); });
    return { options: runs, bestByNpvIndex: best };
  }

  // Scenario #1 — Stay-vs-Go. Convenience wrapper that also returns the delta (go − stay).
  function stayVsGo(stayOpt, goOpt) {
    var stay = runOption(Object.assign({ side: "stay" }, stayOpt));
    var go = runOption(Object.assign({ side: "go" }, goOpt));
    return {
      stay: stay, go: go,
      delta: {
        allIn: go.base.allIn - stay.base.allIn,
        npv: go.base.npv - stay.base.npv,
        netEff: go.base.netEffectivePSF - stay.base.netEffectivePSF
      },
      recommend: (go.base.npv < stay.base.npv) ? "go" : "stay"
    };
  }

  var VModel = {
    computeOption: computeOption,
    requiredRSF: requiredRSF,
    runOption: runOption,
    compareOptions: compareOptions,
    stayVsGo: stayVsGo,
    round2: round2,
    version: "1.0.0"
  };

  if (typeof module !== "undefined" && module.exports) module.exports = VModel;
  if (typeof window !== "undefined") window.VModel = VModel;
})();
