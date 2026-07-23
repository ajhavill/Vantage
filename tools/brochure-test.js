// No-network acceptance test for the pure mapping in assets/brochure-file.js
// (per-file brochure extractions -> review plan, building_media payloads,
// market_spaces 'flyer' payloads, dedup_key parity with the CoStar report
// import, defer-to-confirmed patch rules, summary math). Mirrors
// tools/report-import-test.js: `node tools/brochure-test.js` — exits 1 on any failure.
const RI = require("../site/public/assets/report-import.js");
const BF = require("../site/public/assets/brochure-file.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra != null ? "  -> " + JSON.stringify(extra) : "")); }
}

const CATALOG = [
  { id: "watergarden", name: "The Water Garden", addr: "1620 26th St, Santa Monica", lat: 34.03, lng: -118.47 },
  { id: "clocktower", name: "Clock Tower Building", addr: "225 Santa Monica Blvd, Santa Monica", lat: 34.01, lng: -118.49 }
];

/* ---------------- buildPlan (the review model) ---------------- */
console.log("\n== buildPlan ==");
const FILES = [
  { filename: "WaterGarden_Brochure.pdf", result: {
      docType: "brochure", buildingName: "The Water Garden", address: "1620 26th Street", city: "Santa Monica",
      label: "Marketing brochure — The Water Garden",
      spaces: [
        { suite: "Suite 210", floor: "2", sf: 4500, rate: 4.75, ratePeriod: "mo", rateBasis: "FSG", spaceType: "direct", availableDate: "2026-09-01" },
        { suite: "300", floor: "3", sf: "12,000", rate: null, ratePeriod: null, rateBasis: null, spaceType: "sublease", availableDate: null }
      ],
      floorPlanPages: [5, 4, 4, 0, -2, "6", null],
      highlights: ["On-site fitness center", "4/1,000 parking", null, "", "Ocean views", "New lobby (2024)", "EV charging", "Too many"]
    } },
  { filename: "MysteryFlyer.pdf", result: {
      docType: "flyer", buildingName: "Arizona Court", address: "731 Arizona Ave", city: "Santa Monica",
      label: null, spaces: [], floorPlanPages: [], highlights: []
    } },
  { filename: "failed.pdf", result: null }   // errored job — dropped from the plan
];
const plan = BF.buildPlan(FILES, CATALOG, { today: "2026-07-23" });
ok("errored file dropped from plan", plan.entries.length === 2, plan.entries.length);
const e0 = plan.entries[0], e1 = plan.entries[1];
ok("catalog match by address variant", e0.buildingId === "watergarden" && e0.catalogName === "The Water Garden", e0.buildingId);
ok("unknown building -> null buildingId (broker picks in review)", e1.buildingId === null);
ok("missing label falls back to docType + name", e1.label === "Flyer — Arizona Court", e1.label);
ok("spaces normalized via ReportImport (sf string -> int)", e0.spaces[1].sf === 12000, e0.spaces[1].sf);
ok("floor-plan pages deduped, sorted, ints >= 1 only", JSON.stringify(e0.floorPlanPages) === "[4,5,6]", e0.floorPlanPages);
ok("highlights drop blanks and cap at 5", e0.highlights.length === 5 && e0.highlights[0] === "On-site fitness center", e0.highlights);
ok("entries default to include", e0.include === true && e1.include === true);
ok("plan.asOf honors ctx.today", plan.asOf === "2026-07-23", plan.asOf);

/* ---------------- assignBuilding (review-sheet correction) ---------------- */
console.log("\n== assignBuilding ==");
BF.assignBuilding(e1, CATALOG[1]);
ok("broker pick sets buildingId + catalogName", e1.buildingId === "clocktower" && e1.catalogName === "Clock Tower Building");
BF.assignBuilding(e1, null);
ok("clearing the pick nulls both", e1.buildingId === null && e1.catalogName === null);
BF.assignBuilding(e1, CATALOG[1]);   // leave assigned for the payload tests

/* ---------------- storage + building_media payloads ---------------- */
console.log("\n== building_media payloads ==");
const path0 = BF.storagePath(e0, "brochure", "123-1");
ok("brochure path is <buildingId>/brochure/<uniq>_<safe filename>", path0 === "watergarden/brochure/123-1_WaterGarden_Brochure.pdf", path0);
const pathWeird = BF.storagePath({ buildingId: "b1", filename: "Q3 flyer (final) v2.pdf" }, "brochure", "9-2");
ok("filenames are sanitized for storage", pathWeird === "b1/brochure/9-2_Q3_flyer__final__v2.pdf", pathWeird);
const mr = BF.brochureMediaRow(e0, path0, "https://x/" + path0);
ok("brochure media row: kind + title from label",
  mr.building_id === "watergarden" && mr.kind === "brochure" && mr.title === "Marketing brochure — The Water Garden" && mr.storage_path === path0, mr);
const fpPath = BF.storagePath(e0, "floorplan", "123-2", "WaterGarden_Brochure_p4.png");
const fr = BF.floorplanMediaRow(e0, 4, fpPath, "https://x/" + fpPath);
ok("floorplan media row labels the page + source file",
  fr.kind === "floorplan" && fr.title === "Floor plan — The Water Garden (p.4, WaterGarden_Brochure.pdf)", fr.title);

/* ---------------- market_spaces payloads (source 'flyer') ---------------- */
console.log("\n== market_spaces payloads ==");
const rows = BF.spacePayloads(plan);
ok("only building-assigned included entries produce space rows", rows.length === 2, rows.length);
const r0 = rows[0];
ok("source is 'flyer' with brochure provenance",
  r0.source === "flyer" && r0.source_detail === "brochure: WaterGarden_Brochure.pdf (2026-07-23)" && r0.as_of === "2026-07-23", r0.source_detail);
ok("dedup_key matches the CoStar report import for the same suite",
  r0.dedup_key === RI.dedupKey("1620 26th Street", "Suite 210"), r0.dedup_key);
ok("dedup_key collapses suite label variants",
  r0.dedup_key === RI.dedupKey("1620 26th St", "210"), r0.dedup_key);
ok("org + building carried onto the row", r0.org_id === RI.ORG_ID && r0.building_id === "watergarden" && r0.building_name === "The Water Garden");
ok("rate fields normalized", r0.asking_rate === 4.75 && r0.rate_period === "mo" && r0.rate_basis === "FSG" && r0.space_type === "direct");
e0.include = false;
ok("unchecking an entry removes its rows", BF.spacePayloads(plan).length === 0, BF.spacePayloads(plan).length);
e0.include = true;

/* ---------------- spacePatch (refresh rules) ---------------- */
console.log("\n== spacePatch ==");
const p1 = BF.spacePatch(r0, { source: "costar-report", listing_broker: "Jane Doe" });
ok("flyer refresh overrides costar-report source", p1.source === "flyer");
ok("existing listing contact is never blanked by a contact-less flyer", !("listing_broker" in p1), Object.keys(p1));
const p2 = BF.spacePatch(r0, { source: "listing-broker" });
ok("listing-broker (confirmed) provenance is preserved", p2.source === "listing-broker");
const rWithContact = Object.assign({}, r0, { listing_broker: "New Broker" });
const p3 = BF.spacePatch(rWithContact, { source: "manual", listing_broker: "Old" });
ok("a flyer that DOES state a contact updates it", p3.listing_broker === "New Broker");
ok("patch refreshes freshness + facts", p1.as_of === "2026-07-23" && p1.sf === 4500 && p1.status === "active");

/* ---------------- summary ---------------- */
console.log("\n== summarize ==");
BF.assignBuilding(e1, null);          // e1 back to unmatched
let sum = BF.summarize(plan);
ok("summary counts filed/unmatched/spaces/pages", sum.filed === 1 && sum.unmatched === 1 && sum.spaces === 2 && sum.planPages === 3, sum);
ok("summary line reads right",
  sum.line === "Filing 1 document · 3 floor-plan pages · 2 spaces → tracker · 1 need a building picked (skipped)", sum.line);
BF.assignBuilding(e1, CATALOG[1]);
sum = BF.summarize(plan);
ok("assigning the miss moves it into filed", sum.filed === 2 && sum.unmatched === 0, sum);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
