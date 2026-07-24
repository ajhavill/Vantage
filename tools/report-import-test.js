// No-network acceptance test for the pure mapping in assets/report-import.js
// (parsed CoStar-report JSON -> deal_properties / market_spaces payloads,
// dedup_key vs the market-spaces.js normalizer, catalog match + on-deal
// dedupe, summary math). Mirrors tools/spaces-test.js:
// `node tools/report-import-test.js` — exits 1 on any failure.
const MS = require("../site/public/assets/market-spaces.js");
const RI = require("../site/public/assets/report-import.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra != null ? "  -> " + JSON.stringify(extra) : "")); }
}

/* ---------------- dedup_key ↔ MarketSpaces normalizer (shared examples) ---------------- */
console.log("\n== dedup_key uses the market-spaces normalizer ==");
const k1 = RI.dedupKey("1620 26th Street, Santa Monica, CA 90404", "210");
ok("address half IS normalizeAddress().key", k1 === MS.normalizeAddress("1620 26th Street, Santa Monica, CA 90404").key + "|210", k1);
ok("street/st variants collapse to one key", RI.dedupKey("1620 26th St", "210") === k1, RI.dedupKey("1620 26th St", "210"));
ok("'Suite 210' == 'STE-210' == '210' in the suite half",
  RI.dedupKey("100 Wilshire Blvd", "Suite 210") === RI.dedupKey("100 Wilshire Boulevard", "STE-210") &&
  RI.dedupKey("100 Wilshire Blvd", "Suite 210") === RI.dedupKey("100 Wilshire Blvd", "210"),
  [RI.dedupKey("100 Wilshire Blvd", "Suite 210"), RI.dedupKey("100 Wilshire Boulevard", "STE-210")]);
ok("different suites = different keys", RI.dedupKey("1620 26th St", "210") !== RI.dedupKey("1620 26th St", "300"));
ok("no suite -> empty suite half", RI.dedupKey("1620 26th St", null) === MS.normalizeAddress("1620 26th St").key + "|");
ok("keys are lowercase", RI.dedupKey("1620 26TH ST", "A-210") === RI.dedupKey("1620 26th st", "a210"));

/* ---------------- catalog matching + on-deal dedupe ---------------- */
const CATALOG = [
  { id: "watergarden", name: "The Water Garden", addr: "1620 26th St, Santa Monica", lat: 34.03, lng: -118.47 },
  { id: "clocktower", name: "Clock Tower Building", addr: "225 Santa Monica Blvd, Santa Monica", lat: 34.01, lng: -118.49 }
];
console.log("\n== catalog matching ==");
const m1 = RI.matchCatalog("1620 26th Street, Suite 210", null, CATALOG);
ok("address variant matches catalog building", m1 && m1.id === "watergarden", m1 && m1.id);
const m2 = RI.matchCatalog(null, "clock tower building", CATALOG);
ok("exact name (case-insensitive) fallback matches", m2 && m2.id === "clocktower", m2 && m2.id);
ok("unknown address+name -> null", RI.matchCatalog("731 Arizona Ave", "Arizona Court", CATALOG) === null);

console.log("\n== already-on-deal dedupe ==");
const EXISTING = [
  { id: "p1", building_id: "clocktower", address: "225 Santa Monica Blvd", name: "Clock Tower Building" },
  { id: "p2", building_id: null, address: "500 Broadway, Santa Monica", name: "500 Broadway" }   // manual, address-only
];
ok("matched building already on deal (by building_id)", RI.isOnDeal({ buildingId: "clocktower", address: "225 Santa Monica Boulevard" }, EXISTING));
ok("address-only candidate dedupes by address", RI.isOnDeal({ buildingId: null, address: "500 Broadway Ave, Santa Monica" }, EXISTING));
ok("new building is not on deal", !RI.isOnDeal({ buildingId: "watergarden", address: "1620 26th St" }, EXISTING));

/* ---------------- plan building (the review model) ---------------- */
console.log("\n== buildPlan ==");
const PARSED = {
  reportDate: "2026-07-01",
  buildings: [
    { name: "The Water Garden", address: "1620 26th Street", city: "Santa Monica", class: "A", rba: 1200000, yearBuilt: 1991,
      spaces: [
        { suite: "210", floor: "2", sf: 4500, contiguousSf: 9000, rate: 4.75, ratePeriod: "mo", rateBasis: "FSG", spaceType: "direct",
          availableDate: "2026-09-01", listingBroker: "Jane Doe", listingCompany: "CBRE", listingEmail: "jane@cbre.com", listingPhone: "310-555-1212" },
        { suite: "300", floor: "3", sf: "12,000", contiguousSf: null, rate: 57, ratePeriod: "yr", rateBasis: null, spaceType: "sublease",
          availableDate: null, listingBroker: null, listingCompany: null, listingEmail: null, listingPhone: null }
      ] },
    { name: "Arizona Court", address: "731 Arizona Ave", city: "Santa Monica", class: null, rba: null, yearBuilt: null,
      spaces: [{ suite: null, floor: null, sf: null, contiguousSf: null, rate: "withheld", ratePeriod: null, rateBasis: null, spaceType: null,
        availableDate: "vacant", listingBroker: null, listingCompany: null, listingEmail: null, listingPhone: null }] },
    { name: "Clock Tower Building", address: "225 Santa Monica Blvd", city: "Santa Monica", class: "B+", rba: 55000, yearBuilt: 1929, spaces: [] }
  ]
};
const plan = RI.buildPlan(PARSED, CATALOG, EXISTING, { filename: "SM-survey.pdf", today: "2026-07-09" });
ok("three buildings in the plan", plan.buildings.length === 3);
ok("all checked by default", plan.buildings.every(b => b.include === true));
ok("Water Garden matched to catalog", plan.buildings[0].buildingId === "watergarden" && plan.buildings[0].catalogName === "The Water Garden");
ok("Arizona Court is new (no match)", plan.buildings[1].buildingId === null);
ok("Clock Tower flagged already-on-deal", plan.buildings[2].alreadyOnDeal === true);
ok("Water Garden NOT flagged on-deal", plan.buildings[0].alreadyOnDeal === false);
ok("as_of = report date when stated", plan.asOf === "2026-07-01");
ok("sf string '12,000' coerced to 12000", plan.buildings[0].spaces[1].sf === 12000);
ok("rate 'withheld' -> null (never invented)", plan.buildings[1].spaces[0].rate === null);
ok("'vacant' availableDate -> null", plan.buildings[1].spaces[0].availableDate === null);

const planNoDate = RI.buildPlan({ buildings: PARSED.buildings }, CATALOG, [], { filename: "x.pdf", today: "2026-07-09" });
ok("as_of falls back to today when no report date", planNoDate.asOf === "2026-07-09");

/* ---------------- deal_properties payload ---------------- */
console.log("\n== deal_properties insert shape ==");
const dp1 = RI.dealPropertyRow(plan.buildings[0], "deal-1");
ok("matched: carries building_id + catalog name, lands in the market report",
  dp1.deal_id === "deal-1" && dp1.building_id === "watergarden" && dp1.name === "The Water Garden" && dp1.status === "shortlisted", dp1);
const dp2 = RI.dealPropertyRow(plan.buildings[1], "deal-1");
ok("new: address-only candidate (building_id null)", dp2.building_id === null && dp2.address === "731 Arizona Ave" && dp2.name === "Arizona Court", dp2);

/* ---------------- market_spaces payloads ---------------- */
console.log("\n== market_spaces upsert rows ==");
const rows = RI.spacePayloads(plan);
ok("one row per space of every checked building (2+1+0)", rows.length === 3, rows.length);
const r0 = rows[0];
ok("org_id is the Havill org constant", r0.org_id === "00000000-0000-0000-0000-000000000001");
ok("source = costar-report", rows.every(r => r.source === "costar-report"));
ok("source_detail names the report + date", r0.source_detail === "report: SM-survey.pdf (2026-07-01)", r0.source_detail);
ok("as_of stamped from the plan", rows.every(r => r.as_of === "2026-07-01"));
ok("status active", rows.every(r => r.status === "active"));
ok("dedup_key = normalizer key | suite", r0.dedup_key === MS.normalizeAddress("1620 26th Street").key + "|210", r0.dedup_key);
ok("monthly rate passes through unconverted", r0.asking_rate === 4.75 && r0.rate_period === "mo");
ok("annual rate passes through unconverted", rows[1].asking_rate === 57 && rows[1].rate_period === "yr");
ok("matched building carries building_id", r0.building_id === "watergarden");
ok("new building has building_id null", rows[2].building_id === null);
ok("available_date carried / nulled", r0.available_date === "2026-09-01" && rows[2].available_date === null);
ok("listing contact carried", r0.listing_broker === "Jane Doe" && r0.listing_company === "CBRE" && r0.listing_email === "jane@cbre.com");
ok("nulls stay null (no invention)", rows[2].sf === null && rows[2].asking_rate === null && rows[2].rate_basis === null && rows[2].space_type === null);
ok("raw = the verbatim parsed space", r0.raw && r0.raw.suite === "210" && r0.raw.rate === 4.75);

console.log("\n== unchecked buildings are excluded ==");
plan.buildings[0].include = false;
ok("unchecking drops that building's spaces", RI.spacePayloads(plan).length === 1);
plan.buildings[0].include = true;

console.log("\n== spacePatch (refresh on dedup hit) ==");
const patch = RI.spacePatch(r0);
ok("patch refreshes economics + freshness", patch.sf === 4500 && patch.asking_rate === 4.75 && patch.as_of === "2026-07-01" && patch.status === "active" && patch.source === "costar-report");
ok("patch never carries org_id/dedup_key/address", !("org_id" in patch) && !("dedup_key" in patch) && !("address" in patch));

/* ---------------- summary math ---------------- */
console.log("\n== summary ==");
const sum = RI.summarize(plan);
ok("added counts exclude already-on-deal", sum.added === 2, sum);
ok("spaces count = all checked buildings' spaces", sum.spaces === 3, sum);
ok("matched counts catalog hits (WG + Clock Tower)", sum.matched === 2, sum);
ok("skipped = already-on-deal", sum.skipped === 1, sum);
ok("summary line reads right",
  sum.line === "Imported 2 buildings · 3 spaces · 2 matched to your map · 1 already on this deal (skipped)", sum.line);

plan.buildings[1].include = false; plan.buildings[2].include = false;
const sum1 = RI.summarize(plan);
ok("singular forms", /Imported 1 building · 2 spaces/.test(sum1.line), sum1.line);
plan.buildings[1].include = true; plan.buildings[2].include = true;

/* ---------------- done ---------------- */
console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
