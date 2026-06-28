#!/usr/bin/env node
/*
  Vantage — access drive-time puller (one-time data enrichment, run locally).

  Computes REAL traffic-aware driving times from each building to a few key
  destinations at three times of day (AM rush / Midday / PM rush) via the Google
  Routes API, and writes them into each building as:
      building.drive = { dests: [ { label, min: { am, mid, pm } }, ... ] }
  It also drops the old static "Freeways"/"Airports" access lines (superseded),
  keeping the static walk-to-transit line.

  Result is stored in vantage-data.json — the app makes no live calls, so there
  is no ongoing cost. You only pay for this one run (~$0.40).

  Key from GOOGLE_ROUTES_KEY (or GOOGLE_PLACES_KEY). Needs the Routes API enabled.
  USAGE:  node tools/pull-access.js --selftest     (no key/network, proves logic)
          GOOGLE_ROUTES_KEY=xxxx node tools/pull-access.js
*/
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "site", "public", "vantage-data.json");
const KEY = process.env.GOOGLE_ROUTES_KEY || process.env.GOOGLE_PLACES_KEY;

// destinations (representative coordinates)
const DESTS = [
  { label: "LAX",            lat: 33.9416,  lng: -118.4085 },
  { label: "I-10 on-ramp",   lat: 34.0265,  lng: -118.4503 }, // Cloverfield/I-10, Santa Monica
  { label: "I-405 on-ramp",  lat: 34.0330,  lng: -118.4655 }  // 405 near Olympic
];
// time-of-day buckets -> local departure clock times
const BUCKETS = [
  { key: "am",  hour: 8,  minute: 0 },
  { key: "mid", hour: 12, minute: 30 },
  { key: "pm",  hour: 17, minute: 30 }
];
// old static access lines that the computed drive times replace
const SUPERSEDED = ["Freeways", "Airports"];

function nextWeekdayISO(hour, minute) {
  const d = new Date(); d.setHours(hour, minute, 0, 0);
  if (d.getTime() < Date.now() + 120000) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

async function routeMatrix(origins, dests, departureTime) {
  const toWp = p => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const r = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,status"
    },
    body: JSON.stringify({
      origins: origins.map(toWp), destinations: dests.map(toWp),
      travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE_OPTIMAL", departureTime
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Routes API " + r.status + (t ? ": " + t.slice(0, 200) : "")); }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// pure: build building.id -> {dests:[{label,min:{bucket:minutes}}]} from per-bucket matrix elements
function assemble(buildings, dests, byBucket) {
  const out = {};
  buildings.forEach(b => { out[b.id] = { dests: dests.map(d => ({ label: d.label, min: {} })) }; });
  Object.keys(byBucket).forEach(bk => {
    byBucket[bk].forEach(el => {
      if (el.duration == null || (el.status && el.status.code != null)) return;
      const sec = parseInt(String(el.duration).replace("s", ""), 10);
      const b = buildings[el.originIndex]; if (!b) return;
      const rec = out[b.id].dests[el.destinationIndex]; if (!rec) return;
      rec.min[bk] = Math.round(sec / 60);
    });
  });
  return out;
}

function selftest() {
  const buildings = [{ id: "b1" }, { id: "b2" }];
  const dests = [{ label: "LAX" }];
  const byBucket = {
    am:  [{ originIndex: 0, destinationIndex: 0, duration: "2280s" }, { originIndex: 1, destinationIndex: 0, duration: "3000s" }],
    mid: [{ originIndex: 0, destinationIndex: 0, duration: "1800s" }, { originIndex: 1, destinationIndex: 0, duration: "2100s" }],
    pm:  [{ originIndex: 0, destinationIndex: 0, duration: "3300s" }, { originIndex: 1, destinationIndex: 0, duration: "3600s", status: {} }]
  };
  const drive = assemble(buildings, dests, byBucket);
  const checks = [
    ["am minutes (2280s -> 38)", drive.b1.dests[0].min.am === 38],
    ["pm minutes (3300s -> 55)", drive.b1.dests[0].min.pm === 55],
    ["b2 midday (2100s -> 35)", drive.b2.dests[0].min.mid === 35],
    ["empty status {} still parsed", drive.b2.dests[0].min.pm === 60]
  ];
  let ok = true;
  checks.forEach(c => { if (!c[1]) ok = false; console.log((c[1] ? "  PASS  " : "  FAIL  ") + c[0]); });
  console.log(ok ? "\nself-test PASSED" : "\nself-test FAILED");
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  if (!KEY) { console.error("No API key. Set GOOGLE_ROUTES_KEY (or GOOGLE_PLACES_KEY) and enable the Routes API."); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const buildings = data.buildings;
  console.log("Destinations: " + DESTS.map(d => d.label).join(", ") + " · buckets: " + BUCKETS.map(b => b.key).join("/"));

  const byBucket = {};
  for (const bk of BUCKETS) {
    const iso = nextWeekdayISO(bk.hour, bk.minute);
    byBucket[bk.key] = await routeMatrix(buildings, DESTS, iso);
    console.log("  " + bk.key + " (" + iso + "): " + byBucket[bk.key].length + " elements");
  }

  const drive = assemble(buildings, DESTS, byBucket);
  buildings.forEach(b => {
    b.drive = drive[b.id];
    if (b.access) SUPERSEDED.forEach(k => { delete b.access[k]; });
  });

  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n", "utf8");
  const elements = buildings.length * DESTS.length * BUCKETS.length;
  console.log("\nElements: " + elements + " (~$" + (elements * 0.01).toFixed(2) + " est.)");
  buildings.forEach(b => console.log("  " + b.id + ": " + b.drive.dests.map(d => d.label + " " + JSON.stringify(d.min)).join("  ·  ")));
  console.log("Wrote " + path.relative(path.join(__dirname, ".."), DATA));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
