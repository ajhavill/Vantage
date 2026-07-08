// No-network acceptance test for the pure logic in assets/market-spaces.js
// (address normalization/matching, freshness bucketing, rate normalization).
// Mirrors tools/model-test.js: `node tools/spaces-test.js` — exits 1 on any failure.
const MS = require("../site/public/assets/market-spaces.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra != null ? "  -> " + extra : "")); }
}

console.log("\n== address normalization ==");
const n1 = MS.normalizeAddress("1620 26th Street, Santa Monica, CA 90404");
ok("street number extracted", n1.num === "1620", JSON.stringify(n1));
ok("suffix canonicalized (street->st)", n1.type === "st", JSON.stringify(n1));
ok("core is the street name", n1.core === "26th", JSON.stringify(n1));

const n2 = MS.normalizeAddress("429 Santa Monica Blvd Suite 210");
ok("suite + unit number dropped", n2.core === "santa monica" && n2.num === "429", JSON.stringify(n2));

const n3 = MS.normalizeAddress("1315 West Olympic Boulevard");
ok("directional canonicalized (west->w)", n3.dir === "w" && n3.type === "blvd", JSON.stringify(n3));

console.log("\n== address matching equivalences ==");
ok("blvd == boulevard", MS.addressesMatch("2730 Wilshire Boulevard, Santa Monica", "2730 Wilshire Blvd"));
ok("case + punctuation ignored", MS.addressesMatch("100 WILSHIRE BLVD.", "100 wilshire boulevard, Santa Monica, CA"));
ok("street == st", MS.addressesMatch("1620 26th Street", "1620 26th St, Santa Monica"));
ok("avenue == ave", MS.addressesMatch("520 Broadway Avenue", "520 Broadway Ave"));
ok("drive == dr", MS.addressesMatch("3130 Airport Drive", "3130 Airport Dr"));
ok("suite dropped for matching", MS.addressesMatch("429 Santa Monica Blvd Suite 210", "429 Santa Monica Boulevard"));
ok("directional w == west", MS.addressesMatch("1315 W Olympic Blvd", "1315 West Olympic Boulevard"));
ok("no-comma city tail tolerated", MS.addressesMatch("500 Broadway Santa Monica CA 90401", "500 Broadway, Santa Monica"));

console.log("\n== address matching rejections ==");
ok("number mismatch = no match", !MS.addressesMatch("1620 26th St", "1626 26th St"));
ok("different street = no match", !MS.addressesMatch("1620 26th St", "1620 Ocean Ave"));
ok("suffix conflict (st vs ave) = no match", !MS.addressesMatch("1620 26th St", "1620 26th Ave"));
ok("directional conflict (w vs e) = no match", !MS.addressesMatch("1315 W Olympic Blvd", "1315 East Olympic Blvd"));
ok("missing number = no match", !MS.addressesMatch("Wilshire Blvd", "100 Wilshire Blvd"));

console.log("\n== building matcher ==");
const BUILDINGS = [
  { id: "watergarden", name: "The Water Garden", addr: "1620 26th St, Santa Monica", lat: 34.03, lng: -118.47 },
  { id: "clocktower", name: "Clock Tower", addr: "225 Santa Monica Blvd, Santa Monica", lat: 34.01, lng: -118.49 }
];
const m1 = MS.matchBuilding({ address: "1620 26th Street, Santa Monica, CA 90404" }, BUILDINGS);
ok("row matches the right building", m1 && m1.id === "watergarden", m1 && m1.id);
const m2 = MS.matchBuilding({ address: "225 Santa Monica Boulevard, Suite 300" }, BUILDINGS);
ok("suite + boulevard variant matches", m2 && m2.id === "clocktower", m2 && m2.id);
const m3 = MS.matchBuilding({ address: "9876 Nowhere Ln" }, BUILDINGS);
ok("unmatched address returns null", m3 === null);

console.log("\n== freshness bucketing (from as_of) ==");
function daysAgo(n) {
  const d = new Date("2026-07-08T00:00:00");
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const TODAY = "2026-07-08";
ok("0 days -> fresh", MS.freshnessBucket(daysAgo(0), TODAY) === "fresh");
ok("30 days -> fresh (boundary)", MS.freshnessBucket(daysAgo(30), TODAY) === "fresh");
ok("31 days -> aging (boundary)", MS.freshnessBucket(daysAgo(31), TODAY) === "aging");
ok("90 days -> aging (boundary)", MS.freshnessBucket(daysAgo(90), TODAY) === "aging");
ok("91 days -> stale (boundary)", MS.freshnessBucket(daysAgo(91), TODAY) === "stale");
ok("null as_of -> unknown", MS.freshnessBucket(null, TODAY) === "unknown");

console.log("\n== rate normalization ($/mo -> $/yr display) ==");
ok("$5.50/mo -> $66.00/yr", MS.annualRate(5.5, "mo") === 66, MS.annualRate(5.5, "mo"));
ok("$4.25/mo -> $51.00/yr", MS.annualRate(4.25, "mo") === 51, MS.annualRate(4.25, "mo"));
ok("$66/yr stays $66", MS.annualRate(66, "yr") === 66);
ok("no period treated as annual", MS.annualRate(48, null) === 48);
ok("null rate -> null", MS.annualRate(null, "mo") === null);
ok("non-numeric rate -> null", MS.annualRate("call", "mo") === null);

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
