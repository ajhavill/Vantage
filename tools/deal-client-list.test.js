// Vantage — unit test for the deal -> Clients-hub row mapping.
// Run:  node tools/deal-client-list.test.js
// (The endpoint needs live Supabase to run end-to-end; the pure mapping is tested here.)

var M = require("../site/netlify/functions/deal-client-list.js");

var passed = 0, failed = 0;
function ok(name, cond) { (cond ? passed++ : failed++); console.log("  " + (cond ? "PASS " : "FAIL ") + name); }
function eq(name, got, want) { ok(name + "  (got " + JSON.stringify(got) + ")", got === want); }

console.log("\n[1] stage -> kind");
eq("executed -> lease", M._stageKind("executed"), "lease");
eq("proposals -> proposal", M._stageKind("proposals"), "proposal");
eq("negotiation -> proposal", M._stageKind("negotiation"), "proposal");
eq("touring -> deal", M._stageKind("touring"), "deal");
eq("needs -> deal", M._stageKind("needs"), "deal");

console.log("\n[2] dealToRow with a building");
var r1 = M._dealToRow({ id: "d1", client_name: "Brightwork Software", stage: "executed" }, "The Water Garden");
eq("id", r1.id, "d1");
eq("kind lease", r1.kind, "lease");
eq("name = building", r1.name, "The Water Garden");
eq("stage label", r1.stage, "Executed");
eq("building", r1.building, "The Water Garden");
eq("deep link", r1.url, "deals.html?d=d1");

console.log("\n[3] dealToRow without a building falls back to a kind label");
var r2 = M._dealToRow({ id: "d2", client_name: "Acme", stage: "negotiation" }, null);
eq("kind proposal", r2.kind, "proposal");
eq("name fallback", r2.name, "Proposal");
eq("stage label", r2.stage, "In negotiation");
eq("building null", r2.building, null);

var r3 = M._dealToRow({ id: "d3", stage: "touring" }, null);
eq("deal fallback name", r3.name, "Deal");
eq("deal kind", r3.kind, "deal");

console.log("\n" + (failed ? "✗ " : "✓ ") + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
