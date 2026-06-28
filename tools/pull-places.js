#!/usr/bin/env node
/*
  Vantage — places puller (one-time data enrichment, run locally).

  Fetches lots more real amenities near each building from the Google Places API
  (Nearby Search, new v1) and MERGES them into site/public/vantage-data.json.
  The result is still a static file — the app makes zero live API calls, so there
  is no ongoing cost. You only pay for this one run.

  The key is read from an environment variable and never written anywhere:
      GOOGLE_PLACES_KEY   (preferred)   — or it falls back to GOOGLE_ROUTES_KEY
  Enable the "Places API (New)" on that key in Google Cloud first.

  USAGE (from the project root):
      # prove the merge logic with no network / no key / no cost:
      node tools/pull-places.js --selftest

      # see what it WOULD add, without calling Google or writing:
      GOOGLE_PLACES_KEY=xxxx node tools/pull-places.js --dry

      # do it for real (writes the JSON):
      GOOGLE_PLACES_KEY=xxxx node tools/pull-places.js

  OPTIONS:
      --per N            max new places per category per building (default 10)
      --radius M         search radius in meters (default 1200, matches the app)
      --only a,b,c       only these category keys (default: all in the data)
      --building id      only this building id
      --dry              fetch but don't write the file
      --selftest         run the pure merge/parse logic on fixtures; no network
*/

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "site", "public", "vantage-data.json");

// category key -> Google Places (New) includedTypes
const TYPES = {
  coffee:  ["coffee_shop", "cafe"],
  dining:  ["restaurant"],
  fitness: ["gym", "fitness_center"],
  grocery: ["supermarket", "grocery_store"],
  transit: ["subway_station", "light_rail_station", "train_station", "bus_station"],
  errands: ["pharmacy", "drugstore"],
  bars:    ["bar", "pub", "night_club"],
  hotels:  ["hotel", "lodging"],
  parks:   ["park"],
  parking: ["parking"]
};

const COST_PER_REQ = 0.032; // ~ Nearby Search (Pro) $32 / 1000, for the estimate

// ---- args ----
function parseArgs(argv) {
  const a = { per: 10, radius: 1200, only: null, building: null, dry: false, selftest: false, newonly: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--newonly") a.newonly = true;   // only buildings whose amen[] is empty
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--dry") a.dry = true;
    else if (t === "--per") a.per = parseInt(argv[++i], 10) || a.per;
    else if (t === "--radius") a.radius = parseInt(argv[++i], 10) || a.radius;
    else if (t === "--only") a.only = String(argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
    else if (t === "--building") a.building = argv[++i];
  }
  return a;
}

// ---- pure helpers (unit-tested in --selftest) ----
function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function placeToRow(place, categoryKey, fallbackLabel) {
  const name = place.displayName && place.displayName.text;
  const loc = place.location;
  if (!name || !loc) return null;
  let blurb = (place.editorialSummary && place.editorialSummary.text) ||
              (place.primaryTypeDisplayName && place.primaryTypeDisplayName.text) ||
              fallbackLabel || "";
  blurb = String(blurb).replace(/\s+/g, " ").trim().slice(0, 48);
  const rating = (typeof place.rating === "number") ? place.rating : null;
  return {
    row: [name, categoryKey, +loc.latitude.toFixed(6), +loc.longitude.toFixed(6), rating == null ? 0 : rating, blurb],
    rating: rating,
    reviews: place.userRatingCount || 0
  };
}

// Given a building's existing amen rows + a list of candidate {row,rating,reviews},
// return the new rows to add (deduped by name, min reviews, sorted by rating, capped).
function pickNew(existingAmen, candidates, perCap, minReviews) {
  const seen = {};
  (existingAmen || []).forEach(a => { seen[normName(a[0])] = true; });
  const fresh = [];
  candidates
    .filter(c => c && c.rating != null && c.reviews >= minReviews)
    .sort((x, y) => (y.rating - x.rating) || (y.reviews - x.reviews))
    .forEach(c => {
      const k = normName(c.row[0]);
      if (seen[k]) return;
      seen[k] = true;
      fresh.push(c.row);
    });
  return fresh.slice(0, perCap);
}

// ---- network ----
async function nearby(key, includedTypes, center, radius) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.location,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.editorialSummary"
    },
    body: JSON.stringify({
      includedTypes,
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } }
    })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error("Places API " + r.status + (txt ? ": " + txt.slice(0, 200) : ""));
  }
  const data = await r.json();
  return Array.isArray(data.places) ? data.places : [];
}

// ---- self test (no network) ----
function selftest() {
  const fakePlaces = [
    { displayName: { text: "Blue Bottle Coffee" }, location: { latitude: 34.0169, longitude: -118.4949 }, rating: 4.2, userRatingCount: 800, primaryTypeDisplayName: { text: "Coffee shop" } },
    { displayName: { text: "Tiny Pop-up" }, location: { latitude: 34.0170, longitude: -118.4950 }, rating: 4.9, userRatingCount: 2, primaryTypeDisplayName: { text: "Coffee shop" } }, // too few reviews
    { displayName: { text: "Maru Coffee" }, location: { latitude: 34.0175, longitude: -118.4960 }, rating: 4.7, userRatingCount: 350, editorialSummary: { text: "Minimalist specialty espresso bar with pour-overs and pastries that is quite popular" } },
    { location: { latitude: 34.0, longitude: -118.0 } } // malformed (no name) -> dropped
  ];
  const candidates = fakePlaces.map(p => placeToRow(p, "coffee", "Coffee"));
  const existing = [["Blue Bottle Coffee", "coffee", 34.0168, -118.4948, 4.2, "Espresso"]]; // already present -> must dedupe
  const fresh = pickNew(existing, candidates, 10, 5);

  const names = fresh.map(r => r[0]);
  const checks = [];
  checks.push(["drops malformed + low-review + dedupes existing", names.length === 1, names]);
  checks.push(["keeps Maru (highest valid rating, fresh)", names[0] === "Maru Coffee", names[0]]);
  checks.push(["blurb truncated to <=48 chars", fresh[0][5].length <= 48, fresh[0][5]]);
  checks.push(["category key stored", fresh[0][1] === "coffee", fresh[0][1]]);
  checks.push(["coords are numbers", typeof fresh[0][2] === "number" && typeof fresh[0][3] === "number", fresh[0].slice(2, 4)]);

  let ok = true;
  checks.forEach(c => { if (!c[1]) ok = false; console.log((c[1] ? "  PASS  " : "  FAIL  ") + c[0] + (c[1] ? "" : "  -> " + JSON.stringify(c[2]))); });
  console.log(ok ? "\nself-test PASSED" : "\nself-test FAILED");
  process.exit(ok ? 0 : 1);
}

// ---- main ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();

  const key = process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_ROUTES_KEY;
  if (!key) {
    console.error("No API key. Set GOOGLE_PLACES_KEY (or GOOGLE_ROUTES_KEY) and enable the Places API (New).");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const catKeys = (data.categories || []).map(c => c.key).filter(k => TYPES[k]);
  const catLabel = {}; (data.categories || []).forEach(c => { catLabel[c.key] = c.label; });
  let cats = args.only ? catKeys.filter(k => args.only.indexOf(k) >= 0) : catKeys;
  let buildings = args.building ? data.buildings.filter(b => b.id === args.building) : data.buildings;
  if (args.newonly) buildings = buildings.filter(b => !(b.amen && b.amen.length));

  const reqTotal = buildings.length * cats.length;
  console.log("Buildings: " + buildings.length + " · categories: " + cats.join(", "));
  console.log("Planned requests: " + reqTotal + "  (~$" + (reqTotal * COST_PER_REQ).toFixed(2) + " est.)" + (args.dry ? "   [DRY RUN]" : ""));

  let added = 0;
  for (const b of buildings) {
    b.amen = b.amen || [];
    for (const cat of cats) {
      let places;
      try { places = await nearby(key, TYPES[cat], { lat: b.lat, lng: b.lng }, args.radius); }
      catch (e) { console.error("  ! " + b.id + "/" + cat + ": " + e.message); continue; }
      const candidates = places.map(p => placeToRow(p, cat, catLabel[cat]));
      const fresh = pickNew(b.amen, candidates, args.per, 5);
      b.amen.push.apply(b.amen, fresh);
      added += fresh.length;
      console.log("  " + b.id + " · " + cat + ": +" + fresh.length);
    }
  }

  console.log("\nNew amenities added: " + added);
  if (args.dry) { console.log("Dry run — nothing written."); return; }
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("Wrote " + path.relative(path.join(__dirname, ".."), DATA));
}

main().catch(e => { console.error(e); process.exit(1); });
