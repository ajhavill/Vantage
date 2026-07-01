// Vantage — unit test for the HubSpot → comp mapping + webhook signature logic.
// Run:  node tools/comps-hubspot.test.js
//
// The webhook itself needs a live HubSpot to test end-to-end, but the PURE parts
// (deal→comp mapping, date parsing, completeness, signature verification) are
// tested here so the risky logic is proven before it ships.

var crypto = require("crypto");
var H = require("../site/netlify/functions/_comps-hubspot.js");
var M = require("../site/public/assets/comps-math.js");

var passed = 0, failed = 0;
function ok(name, cond) { (cond ? passed++ : failed++); console.log("  " + (cond ? "PASS " : "FAIL ") + name); }
function eq(name, got, want) { ok(name + "  (got " + JSON.stringify(got) + ")", got === want); }

// --- 1. dealToComp maps a closed deal, and the metrics match the hand example ---
console.log("\n[1] dealToComp → comp → metrics");
var deal = {
  id: "12345",
  properties: {
    vantage_rsf: "10000", vantage_term_months: "60", vantage_face_rate: "36",
    vantage_free_rent_months: "5", vantage_ti_psf: "50", vantage_expense_structure: "FSG",
    vantage_product_type: "office", vantage_discount_rate: "0",
    vantage_execution_date: "2025-11-01", vantage_building_address: "2425 Olympic Blvd", vantage_suite: "Ste 300",
    dealname: "Brightwork HQ lease", closedate: "1762000000000", hs_is_closed_won: "true"
  }
};
var comp = H.dealToComp(deal, { tenantName: "Brightwork Software" });
eq("external_id from deal id", comp.external_id, "12345");
eq("source tagged hubspot", comp.source, "hubspot");
eq("tenant from associated company", comp.tenant, "Brightwork Software");
eq("product_type mapped", comp.product_type, "office");
eq("suite mapped", comp.suite, "Ste 300");
eq("rsf numeric", comp.rsf, 10000);
eq("escalation none when blank", comp.escalation.type, "none");
var metrics = M.computeMetrics({
  rsf: comp.rsf, term_months: comp.term_months, face_rate: comp.face_rate, escalation: comp.escalation,
  free_rent_months: comp.free_rent_months, ti_allowance_psf: comp.ti_allowance_psf, opex_psf: comp.opex_psf,
  discount_rate: comp.discount_rate
});
eq("net effective @0% = $23.00 (same engine)", metrics.net_effective_rent_psf, 23);
eq("face rate = $36", metrics.face_rate_psf, 36);

// --- 2. escalation + draft detection ---
console.log("\n[2] escalation passthrough + completeness");
var deal2 = { id: "9", properties: { vantage_rsf: "5000", vantage_term_months: "84", vantage_face_rate: "48", vantage_escalation_pct: "3", hs_is_closed_won: "true" } };
var comp2 = H.dealToComp(deal2, {});
ok("escalation percent captured", comp2.escalation.type === "percent" && comp2.escalation.value === 3);
ok("complete comp is not a draft", H.isCompComplete(comp2) === true);
var stub = H.dealToComp({ id: "10", properties: { dealname: "No terms yet" } }, {});
ok("comp missing economics is a draft", H.isCompComplete(stub) === false);

// --- 3. HubSpot date parsing ---
console.log("\n[3] parseHsDate");
eq("epoch ms → ISO date", H.parseHsDate("1762000000000"), new Date(1762000000000).toISOString().slice(0, 10));
eq("ISO passes through", H.parseHsDate("2026-02-15"), "2026-02-15");
eq("empty → null", H.parseHsDate(""), null);

// --- 4. webhook signature (v3) ---
console.log("\n[4] verifyHubSpotV3");
(function () {
  var secret = "shh", method = "POST", uri = "https://vantage.app/.netlify/functions/comps-hubspot-webhook", body = "[{\"objectId\":1}]";
  var ts = String(Date.now());
  var base = method + uri + body + ts;
  var good = crypto.createHmac("sha256", secret).update(base, "utf8").digest("base64");
  ok("valid signature accepted", H.verifyHubSpotV3(secret, method, uri, body, good, ts) === true);
  ok("tampered signature rejected", H.verifyHubSpotV3(secret, method, uri, body, "AAAA", ts) === false);
  ok("tampered body rejected", H.verifyHubSpotV3(secret, method, uri, body + "x", good, ts) === false);
  var staleTs = String(Date.now() - 10 * 60 * 1000);
  var staleSig = crypto.createHmac("sha256", secret).update(method + uri + body + staleTs, "utf8").digest("base64");
  ok("stale timestamp (>5min) rejected", H.verifyHubSpotV3(secret, method, uri, body, staleSig, staleTs) === false);
  ok("missing secret rejected", H.verifyHubSpotV3("", method, uri, body, good, ts) === false);
})();

console.log("\n" + (failed ? "✗ " : "✓ ") + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
