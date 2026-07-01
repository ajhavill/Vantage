// Vantage — Occupancy Modeling Engine (VModel). MONTHLY model (LA convention).
// Pure, dependency-free. Runs in the browser (window.VModel) and in Node (module.exports).
//
// UNITS (LA office standard):
//   • Term is in MONTHS.
//   • Base rent and opex are $/SF/MONTH.
//   • Escalation is ANNUAL (% per year) — rent steps up every 12 months.
//   • Free rent is in whole MONTHS. TI, moving, cabling, FF&E, make-good are $/SF (one-time).
//   • Parking rate is $/space/MONTH, escalating annually.
//   • Discount rate is ANNUAL; cash is discounted monthly: df(m) = (1+r)^-((m-1)/12),
//     so month 1 is undiscounted (rent paid in advance). One-time costs + TI land at t=0.
//
// METRICS per option:
//   • netEffectivePSFmo — net effective rent, $/SF/MONTH: (Σ tenant-paid rent − TI) / RSF / months
//     (gross-equivalent; excludes parking + one-time). netEffectivePSFyr = ×12.
//   • allIn — total nominal $ over the term: Σ(rent + parking) + one-time + make-good − TI
//   • npv — allIn discounted to present at the annual rate (monthly)
//
// OPEX: FSG (base-year stop) → tenant pays only the increase over the base year; NNN → full pass-through.
// GROWTH: headcount grows annually → usable SF (× density) → rentable SF (× load factor), under
//   low/base/high bands; a fixed-size option flags any shortfall, a sized-to-team option produces its own RSF.
(function () {
  "use strict";
  function n(v) { if (v == null || v === "") return 0; var x = Number(v); return isFinite(x) ? x : 0; }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  function computeOption(o, rsf) {
    rsf = n(rsf);
    var M = Math.max(0, Math.round(n(o.termMonths)));
    var r = n(o.discountRatePct) / 100;
    var esc = n(o.rentEscalationPct) / 100;
    var og = n(o.opexGrowthPct) / 100;
    var freeM = Math.max(0, Math.round(n(o.freeRentMonths)));
    var structure = (o.structure === "NNN") ? "NNN" : "FSG";
    var pk = o.parking || {};
    var spaces = (n(pk.ratioPer1000) * rsf) / 1000;
    var baseMo = n(o.baseRentPSFmo), opexMo = n(o.opexBasePSFmo), pkEsc = n(pk.escalationPct) / 100;

    var months = [], byYear = [], sumTenant = 0, sumParking = 0, sumRecurring = 0, npvRecurring = 0, freeAbated = 0;
    for (var m = 1; m <= M; m++) {
      var ly = Math.floor((m - 1) / 12);                       // 0-based lease year → annual escalation step
      var basePSF = baseMo * Math.pow(1 + esc, ly);
      var free = (m <= freeM);
      var baseAfterFree = free ? 0 : basePSF;
      if (free) freeAbated += basePSF * rsf;
      var opexFull = opexMo * Math.pow(1 + og, ly);
      var opexTenant = structure === "NNN" ? opexFull : Math.max(0, opexFull - opexMo);
      var tenantPays = (baseAfterFree + opexTenant) * rsf;
      var parking = spaces * n(pk.monthlyRate) * Math.pow(1 + pkEsc, ly);
      var recurring = tenantPays + parking;
      var df = Math.pow(1 + r, -(m - 1) / 12);
      months.push({ m: m, ly: ly, basePSFmo: basePSF, baseAfterFreePSFmo: baseAfterFree, opexTenantPSFmo: opexTenant, tenantPays: tenantPays, parking: parking, recurring: recurring, df: df });
      sumTenant += tenantPays; sumParking += parking; sumRecurring += recurring; npvRecurring += recurring * df;
      var y = byYear[ly] || (byYear[ly] = { year: ly + 1, months: 0, baseStartPSFmo: basePSF, tenantPays: 0, parking: 0, recurring: 0, pv: 0 });
      y.months++; y.tenantPays += tenantPays; y.parking += parking; y.recurring += recurring; y.pv += recurring * df;
    }
    byYear = byYear.filter(Boolean);

    var ti = n(o.tiPSF) * rsf;
    var ot = o.oneTime || {};
    var oneTime = (n(ot.movingPSF) + n(ot.cablingPSF) + n(ot.ffnePSF)) * rsf;
    var makeGood = (o.makeGood && o.makeGood.on) ? n(o.makeGood.psf) * rsf : 0;
    var upfront = oneTime + makeGood - ti;
    var allIn = sumRecurring + upfront;
    var npv = npvRecurring + upfront;
    var netEffMo = (M > 0 && rsf > 0) ? (sumTenant - ti) / rsf / M : 0;

    return {
      rsf: rsf, termMonths: M, structure: structure, months: months, byYear: byYear,
      ti: ti, oneTime: oneTime, makeGood: makeGood, upfront: upfront,
      sumTenantPays: sumTenant, sumParking: sumParking, sumRecurring: sumRecurring, freeRentAbated: freeAbated,
      allIn: allIn, npv: npv, netEffectivePSFmo: netEffMo, netEffectivePSFyr: netEffMo * 12,
      allInPSFmo: (M > 0 && rsf > 0) ? allIn / rsf / M : 0
    };
  }

  function requiredRSF(o, growthPct) {
    var M = Math.max(1, Math.round(n(o.termMonths))), yrs = Math.ceil(M / 12);
    var g = n(growthPct) / 100, dens = n(o.densityUsfPerEmp) || 200, load = n(o.loadFactor) || 1.15, hc0 = n(o.headcountStart);
    var peak = 0, peakYear = 1, peakHC = hc0;
    for (var y = 0; y < yrs; y++) { var hc = hc0 * Math.pow(1 + g, y); var need = hc * dens * load; if (need > peak) { peak = need; peakYear = y + 1; peakHC = hc; } }
    return { rsf: Math.ceil(peak), peakYear: peakYear, peakHeadcount: Math.round(peakHC) };
  }

  function runOption(o) {
    var g = o.growth || {}, bands = {};
    ["low", "base", "high"].forEach(function (b) {
      var need = null, rsf, hasGrowth = n(o.headcountStart) > 0 && g[b] != null;
      if (o.sizeMode === "byHeadcount") { need = requiredRSF(o, g[b]); rsf = n(o.rsfOverride) || need.rsf; }
      else { rsf = n(o.rsf); if (hasGrowth) need = requiredRSF(o, g[b]); }
      var res = computeOption(o, rsf);
      res.requiredRSF = need ? need.rsf : null;
      res.peakHeadcount = need ? need.peakHeadcount : null;
      res.shortfallSF = (o.sizeMode !== "byHeadcount" && need) ? Math.max(0, need.rsf - rsf) : 0;
      bands[b] = res;
    });
    return {
      name: o.name || "Option", side: o.side || null, structure: bands.base.structure, termMonths: bands.base.termMonths, input: o, bands: bands, base: bands.base,
      spread: { allIn: bands.high.allIn - bands.low.allIn, npv: bands.high.npv - bands.low.npv, netEff: bands.high.netEffectivePSFmo - bands.low.netEffectivePSFmo }
    };
  }

  function compareOptions(options) {
    var runs = (options || []).map(runOption), best = null;
    runs.forEach(function (r, i) { if (best == null || r.base.npv < runs[best].base.npv) best = i; });
    return { options: runs, bestByNpvIndex: best };
  }

  function stayVsGo(stayOpt, goOpt) {
    var stay = runOption(Object.assign({ side: "stay" }, stayOpt));
    var go = runOption(Object.assign({ side: "go" }, goOpt));
    return {
      stay: stay, go: go,
      delta: { allIn: go.base.allIn - stay.base.allIn, npv: go.base.npv - stay.base.npv, netEff: go.base.netEffectivePSFmo - stay.base.netEffectivePSFmo },
      recommend: (go.base.npv < stay.base.npv) ? "go" : "stay"
    };
  }

  var VModel = { computeOption: computeOption, requiredRSF: requiredRSF, runOption: runOption, compareOptions: compareOptions, stayVsGo: stayVsGo, round2: round2, version: "2.0.0-monthly" };
  if (typeof module !== "undefined" && module.exports) module.exports = VModel;
  if (typeof window !== "undefined") window.VModel = VModel;
})();
