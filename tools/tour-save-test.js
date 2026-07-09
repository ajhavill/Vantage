// Vantage — unit test for the saved-tour serialization (assets/tour-plan.js).
// Run:  node tools/tour-save-test.js     (no network, no DOM)
//
// Covers: optimizer plan -> deal_tours row shape -> (JSON round trip, like a
// Supabase write/read) -> render model; leg label formatting; leg-midpoint
// math; missing-lat/lng handling.

var TP = require("../site/public/assets/tour-plan.js");

var passed = 0, failed = 0;
function ok(name, cond) { (cond ? passed++ : failed++); console.log("  " + (cond ? "PASS " : "FAIL ") + name); }
function eq(name, got, want) { ok(name + "  (got " + JSON.stringify(got) + ")", JSON.stringify(got) === JSON.stringify(want)); }
function near(name, got, want, tol) { ok(name + "  (got " + got + ")", Math.abs(got - want) <= (tol || 1e-9)); }

// ---- a fake optimizer result, shaped exactly like runOptimize()'s plan ----
var T0 = new Date("2026-07-14T09:00:00");   // local wall clock
function mins(n) { return new Date(T0.getTime() + n * 60000); }
var plan = [
  { stop: { stopId: "s1", buildingId: "watergarden", name: "The Water Garden", addr: "1620 26th St, Santa Monica", lat: 34.0289807, lng: -118.4709904, contact: { name: "Dana Reyes", email: "dana@havill.co" } },
    arrive: mins(0), depart: mins(20), driveNextMin: 12, bufferMin: 10 },
  { stop: { stopId: "s2", buildingId: "smbp", name: "Santa Monica Business Park", addr: "2850 Ocean Park Blvd, Santa Monica", lat: 34.0198197, lng: -118.4517586, contact: null },
    arrive: mins(42), depart: mins(62), driveNextMin: 7, bufferMin: 10 },
  { stop: { stopId: "s3", buildingId: "clocktower", name: "Clock Tower Building", addr: "225 Santa Monica Blvd, Santa Monica", lat: 34.0154455, lng: -118.4966597, contact: { name: "Sam Ortiz", email: "sam@example.com" } },
    arrive: mins(79), depart: mins(99), driveNextMin: null, bufferMin: 10 }
];
var OPT_AT = "2026-07-09T18:30:00.000Z";
var row = TP.rowFromPlan("deal-1", plan, {
  dwell: 20, buffer: 10, startAddr: "100 Wilshire Blvd", leaveBy: mins(-15),
  firstDriveMin: 15, nogeo: ["Mystery Loft"], optimizedAt: OPT_AT
});

console.log("\n[1] plan -> row shape (the deal_tours contract)");
eq("deal_id", row.deal_id, "deal-1");
eq("tour_date (local)", row.tour_date, "2026-07-14");
eq("departure = leaveBy local HH:MM", row.departure, "08:45");
eq("3 stops, in tour order", row.stops.map(function (s) { return s.buildingId; }), ["watergarden", "smbp", "clocktower"]);
eq("stop arrive is ISO", row.stops[0].arrive, mins(0).toISOString());
eq("stop depart is ISO", row.stops[0].depart, mins(20).toISOString());
eq("listing broker carried", row.stops[0].listingBroker, "Dana Reyes");
eq("listing email carried", row.stops[0].listingEmail, "dana@havill.co");
ok("no contact -> no listing keys", !("listingBroker" in row.stops[1]) && !("listingEmail" in row.stops[1]));
eq("address carried", row.stops[2].address, "225 Santa Monica Blvd, Santa Monica");
eq("legs from optimizer driveNextMin (no extra Google calls)", row.legs, [{ fromIdx: 0, toIdx: 1, driveMin: 12 }, { fromIdx: 1, toIdx: 2, driveMin: 7 }]);
eq("meta.totalDriveMin", row.meta.totalDriveMin, 19);
eq("meta.optimizedAt", row.meta.optimizedAt, OPT_AT);
eq("meta.dwellMin", row.meta.dwellMin, 20);
eq("meta.bufferMin", row.meta.bufferMin, 10);
eq("meta.startAddr", row.meta.startAddr, "100 Wilshire Blvd");
eq("meta.firstDriveMin", row.meta.firstDriveMin, 15);
eq("meta.nogeo", row.meta.nogeo, ["Mystery Loft"]);
eq("meta.leaveBy is ISO", row.meta.leaveBy, mins(-15).toISOString());

console.log("\n[2] no start point -> departure falls back to first arrival");
var row2 = TP.rowFromPlan("deal-1", plan, { dwell: 20, buffer: 10, optimizedAt: OPT_AT });
eq("departure = first arrive local HH:MM", row2.departure, "09:00");
eq("meta.leaveBy null", row2.meta.leaveBy, null);
eq("meta.startAddr null", row2.meta.startAddr, null);

console.log("\n[3] serialization round trip (JSON, like Supabase jsonb) -> render model");
var stored = JSON.parse(JSON.stringify(row));
var m = TP.renderModel(stored);
eq("stops back in order", m.stops.map(function (s) { return s.name; }), ["The Water Garden", "Santa Monica Business Park", "Clock Tower Building"]);
eq("all 3 mappable", m.mapStops.length, 3);
eq("no missing", m.missing, []);
eq("map legs preserved", m.mapLegs.length, 2);
eq("legByFrom[0].driveMin", m.legByFrom[0].driveMin, 12);
ok("legByFrom has no leg after the last stop", m.legByFrom[2] === undefined);
eq("totalDriveMin from meta", m.totalDriveMin, 19);
eq("optimizedAt survives", m.optimizedAt, OPT_AT);

console.log("\n[4] missing-lat/lng handling (never crash, never geocode)");
var degraded = JSON.parse(JSON.stringify(stored));
degraded.stops[1].lat = null; degraded.stops[1].lng = null;
var md = TP.renderModel(degraded);
eq("2 mappable", md.mapStops.map(function (x) { return x.idx; }), [0, 2]);
eq("missing lists the coord-less stop", md.missing, ["Santa Monica Business Park"]);
eq("legs touching it dropped from the map", md.mapLegs, []);
eq("itinerary legs still intact", md.legs.length, 2);
var unnamed = TP.renderModel({ stops: [{ lat: null, lng: null }], legs: [], meta: {} });
eq("nameless coord-less stop gets a fallback label", unnamed.missing, ["Stop 1"]);
var empty = TP.renderModel(null);
eq("null row -> empty model, no crash", empty.stops, []);
eq("null row -> totalDriveMin 0", empty.totalDriveMin, 0);
var noMeta = TP.renderModel({ stops: stored.stops, legs: stored.legs });
eq("no meta -> total recomputed from legs", noMeta.totalDriveMin, 19);

console.log("\n[5] leg label formatting");
eq("12 -> '12 min'", TP.legLabel(12), "12 min");
eq("11.6 rounds", TP.legLabel(11.6), "12 min");
eq("0.4 -> '<1 min'", TP.legLabel(0.4), "<1 min");
eq("0 -> '<1 min'", TP.legLabel(0), "<1 min");
eq("null -> ''", TP.legLabel(null), "");
eq("NaN -> ''", TP.legLabel(NaN), "");

console.log("\n[6] leg midpoint math");
var mid = TP.legMidpoint({ lat: 34.02, lng: -118.48 }, { lat: 34.04, lng: -118.44 });
near("mid lat", mid.lat, 34.03, 1e-9);
near("mid lng", mid.lng, -118.46, 1e-9);
eq("missing coords -> null (no label, no crash)", TP.legMidpoint({ lat: 34, lng: null }, { lat: 34.1, lng: -118.4 }), null);
eq("null stop -> null", TP.legMidpoint(null, { lat: 34, lng: -118 }), null);

console.log("\n" + (failed ? "✗ " : "✓ ") + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
