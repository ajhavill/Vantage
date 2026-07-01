// Acceptance test for the MONTHLY occupancy modeling engine.
// Reconciles VModel against an INDEPENDENT from-scratch monthly hand calc + explicit spot values.
const V = require("../site/public/assets/model-engine.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + (extra != null ? "  → " + extra : "")); } }
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.01 : tol); }
const usd = (v) => "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

const STAY = {
  name: "Renew in place", rsf: 10000, termMonths: 60, discountRatePct: 8,
  baseRentPSFmo: 3.50, rentEscalationPct: 3, structure: "FSG", opexBasePSFmo: 1.20, opexGrowthPct: 3,
  freeRentMonths: 3, tiPSF: 15, parking: { ratioPer1000: 2.5, monthlyRate: 150, escalationPct: 3 }
};
const GO = {
  name: "Relocate — Water Garden", rsf: 10000, termMonths: 60, discountRatePct: 8,
  baseRentPSFmo: 3.20, rentEscalationPct: 3, structure: "NNN", opexBasePSFmo: 1.35, opexGrowthPct: 3,
  freeRentMonths: 6, tiPSF: 60, parking: { ratioPer1000: 2.5, monthlyRate: 175, escalationPct: 3 },
  oneTime: { movingPSF: 8, cablingPSF: 6, ffnePSF: 20 }, makeGood: { on: false, psf: 12 }
};

function hand(o, rsf) {
  const M = o.termMonths, r = o.discountRatePct / 100, esc = o.rentEscalationPct / 100, og = o.opexGrowthPct / 100;
  const freeM = o.freeRentMonths || 0, spaces = o.parking.ratioPer1000 * rsf / 1000, pkE = o.parking.escalationPct / 100;
  let sumTenant = 0, sumRec = 0, npvRec = 0;
  for (let m = 1; m <= M; m++) {
    const ly = Math.floor((m - 1) / 12);
    const base = o.baseRentPSFmo * Math.pow(1 + esc, ly);
    const baseAF = (m <= freeM) ? 0 : base;
    const opexFull = o.opexBasePSFmo * Math.pow(1 + og, ly);
    const opexTen = o.structure === "NNN" ? opexFull : Math.max(0, opexFull - o.opexBasePSFmo);
    const tenant = (baseAF + opexTen) * rsf;
    const park = spaces * o.parking.monthlyRate * Math.pow(1 + pkE, ly);
    sumTenant += tenant; sumRec += tenant + park; npvRec += (tenant + park) * Math.pow(1 + r, -(m - 1) / 12);
  }
  const ti = (o.tiPSF || 0) * rsf;
  const one = ((o.oneTime ? (o.oneTime.movingPSF || 0) + (o.oneTime.cablingPSF || 0) + (o.oneTime.ffnePSF || 0) : 0)) * rsf;
  const mg = (o.makeGood && o.makeGood.on) ? o.makeGood.psf * rsf : 0;
  const up = one + mg - ti;
  return { netEffMo: (sumTenant - ti) / rsf / M, allIn: sumRec + up, npv: npvRec + up };
}

console.log("\n=== ENGINE vs INDEPENDENT MONTHLY HAND CALC ===");
[["STAY", STAY], ["GO", GO]].forEach(([label, o]) => {
  const e = V.computeOption(o, o.rsf), h = hand(o, o.rsf);
  console.log("\n" + label + " (" + o.structure + ", " + o.rsf.toLocaleString() + " RSF, " + o.termMonths + " mo):");
  console.log("   net effective:  engine $" + e.netEffectivePSFmo.toFixed(4) + "/SF/mo   hand $" + h.netEffMo.toFixed(4));
  console.log("   all-in:         engine " + usd(e.allIn) + "   hand " + usd(h.allIn));
  console.log("   NPV:            engine " + usd(e.npv) + "   hand " + usd(h.npv));
  ok(label + " net effective ($/SF/mo) reconciles", near(e.netEffectivePSFmo, h.netEffMo, 1e-9));
  ok(label + " all-in reconciles", near(e.allIn, h.allIn, 0.01));
  ok(label + " NPV reconciles", near(e.npv, h.npv, 0.01));
  ok(label + " all-in == Σrecurring + upfront", near(e.allIn, e.sumRecurring + e.upfront, 0.01));
  let npvManual = e.upfront; e.months.forEach(mm => npvManual += mm.recurring * mm.df);
  ok(label + " NPV == upfront + Σ(recurring·df)", near(e.npv, npvManual, 0.01));
  ok(label + " byYear recurring sums to total", near(e.byYear.reduce((s, y) => s + y.recurring, 0), e.sumRecurring, 0.01));
});

console.log("\n=== EXPLICIT MONTHLY HAND SPOT-CHECKS (STAY) ===");
const es = V.computeOption(STAY, STAY.rsf);
ok("Months 1–3 base = $0 (3 months free)", es.months[0].baseAfterFreePSFmo === 0 && es.months[2].baseAfterFreePSFmo === 0);
ok("Month 4 base = $3.50/SF/mo (free over)", near(es.months[3].baseAfterFreePSFmo, 3.50, 1e-9), es.months[3].baseAfterFreePSFmo);
ok("Month 13 base = 3.50×1.03 = $3.605 (annual step)", near(es.months[12].basePSFmo, 3.605, 1e-9), es.months[12].basePSFmo);
ok("Month 1 FSG opex increment = $0 (base year)", near(es.months[0].opexTenantPSFmo, 0, 1e-9));
ok("Month 13 FSG opex increment = 1.20×1.03 − 1.20 = $0.036", near(es.months[12].opexTenantPSFmo, 0.036, 1e-9), es.months[12].opexTenantPSFmo);
ok("Month 1 parking = 25 × $150 = $3,750/mo", near(es.months[0].parking, 3750, 1e-6), es.months[0].parking);
ok("60-month term → 5 lease-year rows", es.byYear.length === 5, es.byYear.length);
const eg = V.computeOption(GO, GO.rsf);
ok("GO month 1 NNN opex = full $1.35 (no stop)", near(eg.months[0].opexTenantPSFmo, 1.35, 1e-9));
ok("GO one-time = ($8+$6+$20)×10,000 = $340,000", near(eg.oneTime, 340000, 1e-6));

console.log("\n=== WORKED STAY-vs-GO (base band, monthly) ===");
const svg = V.stayVsGo(STAY, GO);
[["STAY", svg.stay.base], ["GO  ", svg.go.base]].forEach(([l, b]) =>
  console.log(l + " | net eff $" + b.netEffectivePSFmo.toFixed(2) + "/SF/mo (= $" + b.netEffectivePSFyr.toFixed(2) + "/yr) | all-in " + usd(b.allIn) + " | NPV " + usd(b.npv)));
console.log("Δ (go − stay): all-in " + usd(svg.delta.allIn) + " | NPV " + usd(svg.delta.npv) + "  → recommend: " + svg.recommend.toUpperCase());

console.log("\n=== GROWTH BANDS (GO, sized to team: 40 emps, 8/12/18%, 200 usf, 1.15 load) ===");
const GOg = Object.assign({}, GO, { sizeMode: "byHeadcount", headcountStart: 40, densityUsfPerEmp: 200, loadFactor: 1.15, growth: { low: 8, base: 12, high: 18 } });
const rg = V.runOption(GOg);
["low", "base", "high"].forEach(b => console.log("  " + b.padEnd(4) + " | peak HC " + String(rg.bands[b].peakHeadcount).padStart(3) + " | RSF " + rg.bands[b].rsf.toLocaleString().padStart(7) + " | NPV " + usd(rg.bands[b].npv)));
ok("Bands ordered low ≤ base ≤ high", rg.bands.low.npv <= rg.bands.base.npv && rg.bands.base.npv <= rg.bands.high.npv);

console.log("\n" + (fail === 0 ? "✅ ALL " + pass + " CHECKS PASS" : "❌ " + fail + " FAILED (" + pass + " passed)"));
process.exit(fail === 0 ? 0 : 1);
