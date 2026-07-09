// No-network acceptance test for the Market map Filters predicate in
// assets/market-spaces.js (buildingPassesFilters + parsers). Mirrors
// tools/spaces-test.js: `node tools/filters-test.js` — exits 1 on any failure.
const MS = require("../site/public/assets/market-spaces.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra != null ? "  -> " + extra : "")); }
}

// a fully-attributed building (Water Garden-shaped) + its tracked spaces
const B = {
  id: "watergarden", name: "The Water Garden", submarket: "26th Street corridor",
  class: "A", parking: "3.0 / 1,000", size: "~320,000", floorPlate: "~64,000 SF",
  yearBuilt: 1989, renovated: 2016, owner: "Harborview Office Partners, LLC",
  byInd: { "Technology/software": 3, Finance: 2, Healthcare: 1 }
};
const SPACES = [
  { sf: 6500, asking_rate: 5.25, rate_period: "yr", space_type: "direct", available_date: null },
  { sf: 12000, asking_rate: 0.5, rate_period: "mo", space_type: "sublease", available_date: "2026-10-01" }
];
function res(b, spaces, f) { return MS.buildingPassesFilters(b, spaces, f); }

console.log("\n== space SF range ==");
ok("in range passes", res(B, SPACES, { sfMin: 5000, sfMax: 8000 }).pass);
ok("out of range hides", !res(B, SPACES, { sfMin: 20000 }).pass);
ok("max-only in range passes", res(B, SPACES, { sfMax: 7000 }).pass);
ok("max-only below all spaces hides", !res(B, SPACES, { sfMax: 5000 }).pass);
ok("SF-range miss is not 'lacked data'", res(B, SPACES, { sfMin: 20000 }).lacked === false);

console.log("\n== rate annualization inside the predicate ==");
// space #2 asks $0.50/SF/mo = $6.00/SF/yr; space #1 asks $5.25/SF/yr
ok("monthly space annualized: $6/yr cap keeps the $0.50/mo space", res(B, [SPACES[1]], { rateMax: 6 }).pass);
ok("monthly space annualized: $5.99/yr cap hides it", !res(B, [SPACES[1]], { rateMax: 5.99 }).pass);
ok("annual space compared directly ($5.25 <= $5.50)", res(B, [SPACES[0]], { rateMax: 5.5 }).pass);
ok("rate min respected ($5.25 < $6 min hides)", !res(B, [SPACES[0]], { rateMin: 6 }).pass);
ok("rate-on-request space fails a rate filter", !res(B, [{ sf: 5000, asking_rate: null, space_type: "direct" }], { rateMax: 10 }).pass);

console.log("\n== direct vs sublease ==");
ok("direct filter matches direct space", res(B, SPACES, { spaceType: "direct" }).pass);
ok("sublease filter matches sublease space", res(B, SPACES, { spaceType: "sublease" }).pass);
ok("sublease-only + direct-only inventory hides", !res(B, [SPACES[0]], { spaceType: "sublease" }).pass);

console.log("\n== move-in timing (availableBy vs available_date) ==");
ok("null available_date = available now -> passes any availableBy", res(B, [SPACES[0]], { availableBy: "2026-08-01" }).pass);
ok("available_date after the deadline hides", !res(B, [SPACES[1]], { availableBy: "2026-08-01" }).pass);
ok("available_date on/before the deadline passes", res(B, [SPACES[1]], { availableBy: "2026-10-01" }).pass);

console.log("\n== ALL space filters must match the SAME space ==");
// space #1 is 6,500 SF direct; space #2 is 12,000 SF sublease — no single space is both big AND direct
ok("filters can't mix-and-match across spaces", !res(B, SPACES, { sfMin: 10000, spaceType: "direct" }).pass);
ok("both constraints on one space passes", res(B, SPACES, { sfMin: 10000, spaceType: "sublease" }).pass);

console.log("\n== no-space-filters-active: untracked buildings STAY visible ==");
ok("no filters at all -> visible", res(B, [], {}).pass);
ok("building-only filters + zero tracked spaces -> still visible", res({ class: "A" }, [], { classes: ["A"] }).pass);
ok("any space filter + zero tracked spaces -> hidden", !res(B, [], { sfMin: 1000 }).pass);
ok("spaceFiltersActive false for empty filters", !MS.spaceFiltersActive({}));
ok("spaceFiltersActive true for availableBy", MS.spaceFiltersActive({ availableBy: "2026-08-01" }));

console.log("\n== class chips ==");
ok("class A passes A-filter", res(B, [], { classes: ["A"] }).pass);
ok("class A hidden by B/C filter", !res(B, [], { classes: ["B", "C"] }).pass);
ok("lowercase 'a' in data still matches", res({ class: "a" }, [], { classes: ["A"] }).pass);
const noClass = res({ name: "x" }, [], { classes: ["A"] });
ok("missing class -> hidden + lacked", !noClass.pass && noClass.lacked);

console.log("\n== parking parser ==");
ok('"3/1,000" -> 3', MS.parseParkingRatio("3/1,000") === 3);
ok('"2.5 : 1000" -> 2.5', MS.parseParkingRatio("2.5 : 1000") === 2.5);
ok('"3.0 / 1,000" -> 3', MS.parseParkingRatio("3.0 / 1,000") === 3);
ok('"1.5 / 1,000 (structure)" -> 1.5', MS.parseParkingRatio("1.5 / 1,000 (structure)") === 1.5);
ok('"3 per 1,000 SF" -> 3', MS.parseParkingRatio("3 per 1,000 SF") === 3);
ok('bare "2.8" -> 2.8', MS.parseParkingRatio("2.8") === 2.8);
ok("garbage -> null", MS.parseParkingRatio("valet only") === null);
ok("empty -> null", MS.parseParkingRatio("") === null && MS.parseParkingRatio(null) === null);

console.log("\n== min parking ratio filter ==");
ok("3.0/1,000 passes min 3", res(B, [], { parkingMin: 3 }).pass);
ok("3.0/1,000 hidden by min 3.5", !res(B, [], { parkingMin: 3.5 }).pass);
const noPark = res({ class: "A" }, [], { parkingMin: 2 });
ok("unparseable/missing parking -> hidden + lacked", !noPark.pass && noPark.lacked);
const badPark = res({ parking: "ask broker" }, [], { parkingMin: 2 });
ok("garbage parking text counts as lacked", !badPark.pass && badPark.lacked);

console.log("\n== built OR renovated after ==");
ok("built 1989, reno 2016 passes 'after 2010' via renovation", res(B, [], { builtAfter: 2010 }).pass);
ok("built 1989, reno 2016 hidden by 'after 2020'", !res(B, [], { builtAfter: 2020 }).pass);
ok("yearBuilt alone can satisfy it", res({ yearBuilt: 2021 }, [], { builtAfter: 2020 }).pass);
ok("renovated alone can satisfy it", res({ renovated: 2022 }, [], { builtAfter: 2020 }).pass);
const noYear = res({ name: "x" }, [], { builtAfter: 2000 });
ok("neither year known -> hidden + lacked", !noYear.pass && noYear.lacked);

console.log("\n== floor plate + RBA ranges (text parsing) ==");
ok('parseSFText "~64,000 SF" -> 64000', MS.parseSFText("~64,000 SF") === 64000);
ok('parseSFText "320,000" -> 320000', MS.parseSFText("320,000") === 320000);
ok("parseSFText junk -> null", MS.parseSFText("call for details") === null);
ok("plate 64k passes 50k-80k", res(B, [], { plateMin: 50000, plateMax: 80000 }).pass);
ok("plate 64k hidden by max 60k", !res(B, [], { plateMax: 60000 }).pass);
const noPlate = res({ class: "A" }, [], { plateMin: 10000 });
ok("missing floorPlate -> hidden + lacked", !noPlate.pass && noPlate.lacked);
ok("RBA 320k (from size text) passes min 300k", res(B, [], { rbaMin: 300000 }).pass);
ok("RBA 320k hidden by max 100k", !res(B, [], { rbaMax: 100000 }).pass);

console.log("\n== industry any-match ==");
ok("one selected industry present passes", res(B, [], { industries: ["Finance"] }).pass);
ok("ANY-of semantics: [Legal, Finance] passes on Finance alone", res(B, [], { industries: ["Legal", "Finance"] }).pass);
ok("no tenant in any selected industry hides", !res(B, [], { industries: ["Legal", "Media"] }).pass);
ok("tenants array works when byInd absent", res({ tenants: [["Acme", "Legal"]] }, [], { industries: ["Legal"] }).pass);
const noRoster = res({ class: "A" }, [], { industries: ["Legal"] });
ok("no roster data -> hidden + lacked", !noRoster.pass && noRoster.lacked);

console.log("\n== owner match ==");
ok("owner in selection passes", res(B, [], { owners: ["Harborview Office Partners, LLC"] }).pass);
ok("owner not in selection hides", !res(B, [], { owners: ["Someone Else LP"] }).pass);
const noOwner = res({ class: "A" }, [], { owners: ["Harborview Office Partners, LLC"] });
ok("blank owner -> hidden + lacked", !noOwner.pass && noOwner.lacked);

console.log("\n== submarket match ==");
ok("submarket in selection passes", res(B, [], { submarkets: ["26th Street corridor"] }).pass);
ok("submarket not in selection hides", !res(B, [], { submarkets: ["Downtown"] }).pass);

console.log("\n== combined: space + building + intel together ==");
const all = { sfMin: 5000, sfMax: 8000, rateMax: 5.5, spaceType: "direct", classes: ["A"], parkingMin: 3, builtAfter: 2010, industries: ["Finance"], owners: ["Harborview Office Partners, LLC"], submarkets: ["26th Street corridor"] };
ok("everything matching passes", res(B, SPACES, all).pass);
ok("one failing dimension hides (class B)", !res(B, SPACES, Object.assign({}, all, { classes: ["B"] })).pass);
ok("passing building never reports lacked", res(B, SPACES, all).lacked === false);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
