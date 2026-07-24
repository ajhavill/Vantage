// No-network acceptance test for the pure mapping/redaction in
// site/netlify/functions/_survey-pack.js (deal market-report buildings ->
// client survey package buildings). The redaction assertions are the ones
// that matter: listing/landlord contacts must never survive, and
// CoStar-sourced tracker rows must never pass — no matter what a caller
// hands in. Mirrors tools/brochure-test.js: `node tools/survey-test.js` —
// exits 1 on any failure.
const SP = require("../site/netlify/functions/_survey-pack.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra != null ? "  -> " + JSON.stringify(extra) : "")); }
}

const CTX = { today: "2026-07-23" };

const CATALOG = [
  {
    id: "watergarden", name: "The Water Garden", addr: "1620 26th St, Santa Monica", submarket: "Water Garden",
    lat: 34.03, lng: -118.47, class: "A", parking: "3.5/1,000", size: "1,270,000 SF", avail: "18,170", rent: "$5.25–5.50/SF FS",
    suites: [["Suite 500", "11,450 SF", "Floor 5", "$5.50/SF FS"]],
    availabilities: [
      { suite: "500", sf: 11450, floor: 5, rent: "$5.50/SF FS", status: "available" },
      { suite: "310", sf: 6720, floor: 3, rent: "$5.25/SF FS", status: "available" }
    ],
    photos: [{ url: "https://x/p1.jpg", caption: "Lobby" }],
    floorplans: [{ label: "Suite 500 — full floor", url: "https://x/fp500.pdf" }],
    read: "Campus-style project anchoring the Water Garden.",
    amen: [["Blue Bottle", "coffee", 34.03, -118.47, 4.5, "26th St"]],
    features: ["On-site security"],
    owner: "JP Morgan AM", propertyManager: "Hines",
    leasingContact: { name: "Dana Reyes", company: "BigCo", phone: "(310) 555-0142", email: "dana@bigco.com" },
    tenants: [["Acme Corp", "tech"]], cscore: { coffee: 9.1 }, places: [{ big: "blob" }], byInd: {}, total: 12
  },
  { id: "clocktower", name: "Clock Tower Building", addr: "225 Santa Monica Blvd", availabilities: [], photos: [], floorplans: [] }
];

/* ---------------- stripBuilding (contact redaction) ---------------- */
console.log("\n== stripBuilding ==");
const stripped = SP.stripBuilding(CATALOG[0]);
ok("leasingContact removed", !("leasingContact" in stripped));
ok("owner removed", !("owner" in stripped));
ok("propertyManager removed", !("propertyManager" in stripped));
ok("cockpit-computed fields removed", !("places" in stripped) && !("cscore" in stripped) && !("byInd" in stripped) && !("total" in stripped) && !("tenants" in stripped));
ok("dossier content kept", stripped.read === CATALOG[0].read && stripped.amen.length === 1 && stripped.features.length === 1);
ok("identity + specs kept", stripped.id === "watergarden" && stripped.class === "A" && stripped.parking === "3.5/1,000");
ok("original untouched", CATALOG[0].leasingContact.name === "Dana Reyes");

/* ---------------- space -> availability mapping ---------------- */
console.log("\n== spaceToAvail ==");
const a1 = SP.spaceToAvail({ suite: "210", floor: "2", sf: 4500, asking_rate: 4.5, rate_period: "mo", rate_basis: "FSG", available_date: null, space_type: "direct", source: "flyer" }, CTX);
ok("rent formats $/SF/MO + basis", a1.rent === "$4.50/SF/MO FSG", a1.rent);
ok("no date -> available", a1.status === "available", a1.status);
ok("numeric floor parsed", a1.floor === 2, a1.floor);
const a2 = SP.spaceToAvail({ suite: "PH", floor: "PH", sf: 8000, asking_rate: 66, rate_period: "yr", rate_basis: null, available_date: "2026-11-15", space_type: "sublease", source: "manual" }, CTX);
ok("yearly rate, no basis", a2.rent === "$66.00/SF/YR", a2.rent);
ok("future date -> avail Mon YYYY", a2.status === "avail Nov 2026 · sublease", a2.status);
ok("non-numeric floor kept as-is", a2.floor === "PH", a2.floor);
const a3 = SP.spaceToAvail({ suite: "100", sf: 2000, asking_rate: null, available_date: "2026-01-01", source: "flyer" }, CTX);
ok("withheld rate -> empty string", a3.rent === "", a3.rent);
ok("past date -> available", a3.status === "available", a3.status);

/* ---------------- publishableSpaces (the CoStar firewall) ---------------- */
console.log("\n== publishableSpaces ==");
const MIXED = [
  { building_id: "watergarden", suite: "500", sf: 11450, source: "flyer", listing_broker: "Jane Doe", listing_email: "jane@x.com", listing_phone: "555", listing_company: "CBRE" },
  { building_id: "watergarden", suite: "600", sf: 9000, source: "costar-report" },
  { building_id: "watergarden", suite: "700", sf: 5000, source: "costar-alert" },
  { building_id: "watergarden", suite: "800", sf: 3000, source: "listing-broker" },
  { building_id: "watergarden", suite: "900", sf: 2500, source: "manual" },
  { building_id: "watergarden", suite: "950", sf: 1000, source: "somewhere-new" },
  null
];
const pub = SP.publishableSpaces(MIXED);
ok("costar-report dropped", !pub.some(function (r) { return r.suite === "600"; }));
ok("costar-alert dropped", !pub.some(function (r) { return r.suite === "700"; }));
ok("unknown source dropped (fail closed)", !pub.some(function (r) { return r.suite === "950"; }));
ok("flyer / listing-broker / manual pass", pub.length === 3, pub.length);
ok("listing_* scrubbed even when present", pub.every(function (r) { return Object.keys(r).every(function (k) { return k.indexOf("listing_") !== 0; }); }));

/* ---------------- mergeAvailabilities ---------------- */
console.log("\n== mergeAvailabilities ==");
const merged = SP.mergeAvailabilities(CATALOG[0].availabilities, [
  { suite: "Suite 310", floor: "3", sf: 6800, asking_rate: 5.35, rate_period: "mo", rate_basis: "FSG", available_date: null, source: "flyer" },
  { suite: "1200", floor: "12", sf: 22000, asking_rate: null, available_date: "2027-01-01", source: "flyer" },
  { suite: "120", floor: "1", sf: 1400, asking_rate: 4.95, rate_period: "mo", available_date: null, source: "flyer" }
].map(function (r) { return r; }), CTX);
ok("tracker row replaces same suite ('Suite 310' == '310')", merged[1].sf === 6800 && merged[1].rent === "$5.35/SF/MO FSG", merged[1]);
ok("static row without conflict kept", merged[0].suite === "500" && merged[0].sf === 11450);
ok("new suites appended largest first", merged[2].suite === "1200" && merged[3].suite === "120", merged.map(function (a) { return a.suite; }));
ok("count = 2 static + 2 new", merged.length === 4, merged.length);

/* ---------------- availsToSuites (dossier tuples) ---------------- */
console.log("\n== availsToSuites ==");
const tuples = SP.availsToSuites(merged);
ok("tuple shape [label, rsf, meta, rent]", tuples[0][0] === "Suite 500" && tuples[0][1] === "11,450 SF" && tuples[0][3] === "$5.50/SF FS", tuples[0]);
ok("future avail lands in meta", /avail Jan 2027/.test(tuples[2][2]), tuples[2][2]);
ok("floor lands in meta", /Floor 12/.test(tuples[2][2]), tuples[2][2]);

/* ---------------- mergeMedia ---------------- */
console.log("\n== mergeMedia ==");
const mb = SP.mergeMedia(SP.stripBuilding(CATALOG[0]), [
  { building_id: "watergarden", kind: "photo", url: "https://x/p2.jpg", title: "New lobby" },
  { building_id: "watergarden", kind: "photo", url: "https://x/p1.jpg", title: "dup of static" },
  { building_id: "watergarden", kind: "floorplan", url: "https://x/fp500_p5.png", title: "Floor plan — p.5" },
  { building_id: "watergarden", kind: "brochure", url: "https://x/brochure.pdf", title: "Marketing brochure" },
  { building_id: "watergarden", kind: "photo", url: null, title: "broken" }
]);
ok("uploaded photo appended", mb.photos.length === 2 && mb.photos[1].caption === "New lobby", mb.photos);
ok("duplicate url skipped", !mb.photos.some(function (p, i) { return mb.photos.findIndex(function (q) { return q.url === p.url; }) !== i; }));
ok("floorplan appended", mb.floorplans.length === 2 && mb.floorplans[1].url === "https://x/fp500_p5.png");
ok("brochure PDFs stay out", mb.photos.concat(mb.floorplans).every(function (m) { return m.url !== "https://x/brochure.pdf"; }));

/* ---------------- buildSurveyBuildings (the whole assembly) ---------------- */
console.log("\n== buildSurveyBuildings ==");
const PROPS = [
  { building_id: "clocktower", name: "Clock Tower", sort_order: 1 },
  { building_id: "watergarden", name: "The Water Garden", sort_order: 2 },
  { building_id: null, name: "Manual add w/o catalog link", sort_order: 3 },
  { building_id: "ghost", name: "Deleted from catalog", sort_order: 4 }
];
const out = SP.buildSurveyBuildings(CATALOG, PROPS, [
  { building_id: "watergarden", kind: "floorplan", url: "https://x/fp.png", title: "Suite 500 plan" }
], MIXED, CTX);
ok("keeps market-report order", out.buildings[0].id === "clocktower" && out.buildings[1].id === "watergarden");
ok("unlinked + missing buildings skipped, by name", out.skipped.length === 2 && out.skipped[0] === "Manual add w/o catalog link", out.skipped);
const wg = out.buildings[1];
ok("no contact fields anywhere", out.buildings.every(function (b) { return !b.leasingContact && !b.owner && !b.propertyManager; }));
ok("no costar rows anywhere", JSON.stringify(out).indexOf("costar") === -1);
ok("no listing_* anywhere in the package", !/"listing_/.test(JSON.stringify(out)));
// statics 500+310, flyer 500 replaces the static, 800+900 append -> 4 rows
ok("tracker suites merged in (500 replaced by flyer row)", wg.availabilities.some(function (a) { return a.suite === "800"; }) && wg.availabilities.length === 4, wg.availabilities.length);
ok("suites tuples rebuilt to match availabilities", wg.suites.length === wg.availabilities.length);
ok("avail summary recomputed", typeof wg.avail === "string" && wg.avail.indexOf(",") > 0, wg.avail);
ok("media merged", wg.floorplans.some(function (f) { return f.url === "https://x/fp.png"; }));
ok("empty-catalog building still packages", out.buildings[0].availabilities.length === 0 && out.buildings[0].suites.length === 0);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
