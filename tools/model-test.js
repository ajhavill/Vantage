// Acceptance test for the occupancy modeling engine.
// Reconciles VModel against an INDEPENDENT from-scratch hand calc + explicit spot values.
const V = require("../site/public/assets/model-engine.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); } }
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.01 : tol); }
const usd = (v) => "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

// ---- worked example ----
const STAY = {
  name: "Renew in place", rsf: 10000, termYears: 5, discountRatePct: 8,
  baseRentPSF: 42, rentEscalationPct: 3, structure: "FSG", opexBasePSF: 14, opexGrowthPct: 3,
  freeRentMonths: 3, tiPSF: 15,
  parking: { ratioPer1000: 2.5, monthlyRate: 150, escalationPct: 3 }
};
const GO = {
  name: "Relocate — Water Garden", rsf: 10000, termYears: 5, discountRatePct: 8,
  baseRentPSF: 38, rentEscalationPct: 3, structure: "NNN", opexBasePSF: 16, opexGrowthPct: 3,
  freeRentMonths: 6, tiPSF: 60,
  parking: { ratioPer1000: 2.5, monthlyRate: 175, escalationPct: 3 },
  oneTime: { movingPSF: 8, cablingPSF: 6, ffnePSF: 20 },
  makeGood: { on: false, psf: 12 }
};

// ---- independent re-implementation (no shared code with the engine) ----
function hand(o, rsf) {
  const N = o.termYears, r = o.discountRatePct / 100, esc = o.rentEscalationPct / 100, og = o.opexGrowthPct / 100;
  const freeY = (o.freeRentMonths || 0) / 12, spaces = o.parking.ratioPer1000 * rsf / 1000;
  let sumTenant = 0, sumRec = 0, npvRec = 0;
  for (let t = 1; t <= N; t++) {
    const base = o.baseRentPSF * Math.pow(1 + esc, t - 1);
    let ff = 0; if (freeY > t - 1) ff = Math.min(1, freeY - (t - 1));
    const baseAF = base * (1 - ff);
    const opexFull = o.opexBasePSF * Math.pow(1 + og, t - 1);
    const opexTen = o.structure === "NNN" ? opexFull : Math.max(0, opexFull - o.opexBasePSF);
    const tenant = (baseAF + opexTen) * rsf;
    const park = spaces * o.parking.monthlyRate * 12 * Math.pow(1 + o.parking.escalationPct / 100, t - 1);
    sumTenant += tenant; sumRec += tenant + park; npvRec += (tenant + park) * Math.pow(1 + r, -(t - 1));
  }
  const ti = (o.tiPSF || 0) * rsf;
  const one = ((o.oneTime ? (o.oneTime.movingPSF || 0) + (o.oneTime.cablingPSF || 0) + (o.oneTime.ffnePSF || 0) : 0)) * rsf;
  const mg = (o.makeGood && o.makeGood.on) ? o.makeGood.psf * rsf : 0;
  const up = one + mg - ti;
  return { netEff: (sumTenant - ti) / rsf / N, allIn: sumRec + up, npv: npvRec + up, sumRec, up };
}

console.log("\n=== ENGINE vs INDEPENDENT HAND CALC ===");
[["STAY", STAY], ["GO", GO]].forEach(([label, o]) => {
  const e = V.computeOption(o, o.rsf), h = hand(o, o.rsf);
  console.log("\n" + label + " (" + o.structure + ", " + o.rsf.toLocaleString() + " RSF, " + o.termYears + "yr):");
  console.log("   net effective:  engine " + e.netEffectivePSF.toFixed(4) + "/RSF   hand " + h.netEff.toFixed(4));
  console.log("   all-in:         engine " + usd(e.allIn) + "   hand " + usd(h.allIn));
  console.log("   NPV:            engine " + usd(e.npv) + "   hand " + usd(h.npv));
  ok(label + " net effective reconciles", near(e.netEffectivePSF, h.netEff, 1e-9));
  ok(label + " all-in reconciles", near(e.allIn, h.allIn, 0.01));
  ok(label + " NPV reconciles", near(e.npv, h.npv, 0.01));
  // internal reconciliation
  ok(label + " all-in == Σrecurring + upfront", near(e.allIn, e.sumRecurring + e.upfront, 0.01));
  let npvManual = e.upfront; e.years.forEach(y => npvManual += y.recurring * y.df);
  ok(label + " NPV == upfront + Σ(recurring·df)", near(e.npv, npvManual, 0.01));
});

console.log("\n=== EXPLICIT HAND SPOT-CHECKS (STAY) ===");
const es = V.computeOption(STAY, STAY.rsf);
ok("Yr1 base after 3mo free = 42 × 0.75 = 31.50", near(es.years[0].baseAfterFreePSF, 31.5, 1e-9), es.years[0].baseAfterFreePSF);
ok("Yr3 FSG opex increment = 14×1.03² − 14 = 0.8526", near(es.years[2].opexTenantPSF, 0.8526, 1e-9), es.years[2].opexTenantPSF);
ok("Yr1 parking = 25 spaces × $150 × 12 = $45,000", near(es.years[0].parking, 45000, 1e-6), es.years[0].parking);
ok("GO Yr1 NNN opex = full $16.00 (no base-year stop)", near(V.computeOption(GO, GO.rsf).years[0].opexTenantPSF, 16, 1e-9));
ok("GO upfront one-time = ($8+$6+$20)×10,000 = $340,000", near(V.computeOption(GO, GO.rsf).oneTime, 340000, 1e-6));

console.log("\n=== WORKED STAY-vs-GO (base band) ===");
const svg = V.stayVsGo(STAY, GO);
[["STAY", svg.stay.base], ["GO  ", svg.go.base]].forEach(([l, b]) => {
  console.log(l + " | net eff " + b.netEffectivePSF.toFixed(2) + "/RSF | all-in " + usd(b.allIn) + " | NPV " + usd(b.npv));
});
console.log("Δ (go − stay): all-in " + usd(svg.delta.allIn) + " | NPV " + usd(svg.delta.npv) + "  → recommend: " + svg.recommend.toUpperCase());

console.log("\n=== STAY per-year schedule ===");
console.log("  yr |  base/RSF | opex/RSF | tenant$   | parking$ | df");
es.years.forEach(y => console.log("  " + String(y.t).padStart(2) + " | " + y.baseAfterFreePSF.toFixed(2).padStart(8) + " | " + y.opexTenantPSF.toFixed(2).padStart(7) + " | " + usd(y.tenantPays).padStart(9) + " | " + usd(y.parking).padStart(7) + " | " + y.df.toFixed(4)));

console.log("\n=== GROWTH BANDS (GO, sized to headcount: 40 emps, 8%/12%/18%, 200 usf, 1.15 load) ===");
const GOgrow = Object.assign({}, GO, { sizeMode: "byHeadcount", headcountStart: 40, densityUsfPerEmp: 200, loadFactor: 1.15, growth: { low: 8, base: 12, high: 18 } });
const rg = V.runOption(GOgrow);
["low", "base", "high"].forEach(b => console.log("  " + b.padEnd(4) + " | peak HC " + String(rg.bands[b].peakHeadcount).padStart(3) + " | RSF " + rg.bands[b].rsf.toLocaleString().padStart(7) + " | all-in " + usd(rg.bands[b].allIn) + " | NPV " + usd(rg.bands[b].npv)));
console.log("  band spread (high − low): all-in " + usd(rg.spread.allIn) + " | NPV " + usd(rg.spread.npv));
ok("Bands ordered: low ≤ base ≤ high all-in", rg.bands.low.allIn <= rg.bands.base.allIn && rg.bands.base.allIn <= rg.bands.high.allIn);

console.log("\n" + (fail === 0 ? "✅ ALL " + pass + " CHECKS PASS" : "❌ " + fail + " FAILED (" + pass + " passed)"));
process.exit(fail === 0 ? 0 : 1);
