// Unit test for the shared proposal-economics formatter (pure, no DOM/network).
//   node tools/proposal-econ.test.js
//
// This module is the single source of truth for the "high level business points"
// shown on the deal page's finalize sheet, the finalized proposal card, and the
// building dossier's Proposals section. Those are three separate HTML documents
// with no shared bundle, so a regression here shows up as the same proposal
// reading differently depending on which page you're looking at.
const mod = require("../site/public/assets/proposal-econ.js");
const P = mod.ProposalEcon || (typeof global !== "undefined" && global.ProposalEcon);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  (cond ? pass++ : fail++);
  console.log((cond ? "  PASS " : "  FAIL ") + name + (!cond && extra != null ? "  → " + extra : ""));
}
function eq(name, got, want) { ok(name + "  [" + got + "]", got === want, "wanted [" + want + "]"); }

console.log("[1] loads without a DOM");
ok("module exported", !!P);

console.log("[2] a full FSG round — the Water Garden terms actually on file");
{
  const e = { rent_basis: "FSG", base_rent_psf: 3.25, opex_psf: null, size_sf: 6000,
              term_months: 60, annual_escalation_pct: 3, free_rent_months: 3, ti_psf: 60 };
  eq("summary", P.summaryLine(e), "FSG · $3.25/SF · 6,000 SF · 5 years · 3% · 3 mo · $60.00/SF");
  ok("no redundant gross when opex is unknown", P.summaryLine(e).indexOf("$3.25") === P.summaryLine(e).lastIndexOf("$3.25"));
}

console.log("[3] NNN with an opex load gets a gross equivalent");
{
  const e = { rent_basis: "NNN", base_rent_psf: 2.9, opex_psf: 0.85, size_sf: 4200, term_months: 84 };
  eq("summary", P.summaryLine(e), "NNN · $2.90/SF · $0.85/SF · $3.75/SF · 4,200 SF · 7 years");
  eq("gross", P.grossEquiv(e), 3.75);
}

console.log("[4] unknown values are omitted, never rendered as zero or a dash");
{
  eq("empty snapshot", P.summaryLine({}), "");
  eq("partial", P.summaryLine({ size_sf: 4200, term_months: 18 }), "4,200 SF · 18 mo");
  eq("gross needs a base", P.grossEquiv({ opex_psf: 1.2 }), null);
  ok("zero is a real value, not missing", P.summaryLine({ free_rent_months: 0 }).indexOf("0 mo") >= 0);
}

console.log("[5] term reads in years only when it divides evenly");
{
  eq("60mo", P.summaryLine({ term_months: 60 }), "5 years");
  eq("12mo", P.summaryLine({ term_months: 12 }), "1 year");
  eq("18mo", P.summaryLine({ term_months: 18 }), "18 mo");
}

console.log("[6] OTHER basis uses the broker's own wording");
eq("custom label", P.basisLabel({ rent_basis: "OTHER", rent_basis_label: "Modified Gross" }), "Modified Gross");
eq("plain basis", P.basisLabel({ rent_basis: "FSG" }), "FSG");

console.log("[7] chips escape untrusted text (rent_basis_label is free-typed)");
{
  const html = P.chipsHtml({ rent_basis: "OTHER", rent_basis_label: '<img src=x onerror=alert(1)>' });
  ok("no raw tag survives", html.indexOf("<img") === -1, html);
  ok("escaped entity present", html.indexOf("&lt;img") >= 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
