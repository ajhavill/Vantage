// Vantage commute API (Netlify Function).
//
// Holds the Google API key SERVER-SIDE only, read from the GOOGLE_ROUTES_KEY
// environment variable. The key is never sent to the browser and never stored
// in source. The browser calls /.netlify/functions/commute with one of:
//
//   { action: "geocode", items: ["90401", "123 Main St, Santa Monica", ...] }
//     -> { points: [{ ok, lat, lng, formatted } | { ok:false, reason }] }   (index-aligned)
//
//   { action: "matrix", origins:[{lat,lng}], destinations:[{lat,lng}], departureTime:"<RFC3339>" }
//     -> { durations:[[seconds|null,...]], distances:[[meters|null,...]] }   (origins x destinations)
//
// Geocoding uses the Google Geocoding API; the drive-time matrix uses the
// Routes API computeRouteMatrix with DRIVE + TRAFFIC_AWARE_OPTIMAL, which caps
// at 100 elements (origins x destinations) per request — so origins are batched.
// Addresses are used transiently for geocoding and are never logged or stored.

const { getStore, connectLambda } = require("@netlify/blobs");
const { userFromToken } = require("./_sb");
const crypto = require("crypto");

const KEY = process.env.GOOGLE_ROUTES_KEY;

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj)
});

// Guard the (paid) endpoint: only the Cockpit (broker secret) or a verified
// Client Viewer (valid package slug + passcode) may call it — never anonymous.
function hashPass(passcode, salt) { return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, "sha256").toString("hex"); }
function safeEq(a, b) { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); if (ab.length !== bb.length) return false; return crypto.timingSafeEqual(ab, bb); }
async function authorize(body) {
  if (body.brokerSecret && process.env.BROKER_SECRET && safeEq(body.brokerSecret, process.env.BROKER_SECRET)) return true;
  // a signed-in broker (Supabase session token) is authorized — same gate as the rest of the Cockpit
  if (body.token) { try { const u = await userFromToken(body.token); if (u) return true; } catch (e) { /* fall through */ } }
  if (body.slug && body.passcode && /^[A-Za-z0-9]{6,40}$/.test(String(body.slug))) {
    try {
      const store = getStore("client-packages");
      const pkg = await store.get(String(body.slug), { type: "json" });
      if (pkg && safeEq(hashPass(body.passcode, pkg.salt), pkg.passcodeHash)) return true;
    } catch (e) { /* fall through to deny */ }
  }
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!KEY) return json(500, { error: "Server is missing GOOGLE_ROUTES_KEY. Set it in Netlify → Site settings → Environment variables." });
  connectLambda(event); // wire up Netlify Blobs context for the slug+passcode auth path



  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Malformed request body." }); }

  if (!(await authorize(body))) return json(401, { error: "Not authorized." });

  try {
    if (body.action === "geocode") return await handleGeocode(body);
    if (body.action === "matrix")  return await handleMatrix(body);
    return json(400, { error: "Unknown action. Use 'geocode' or 'matrix'." });
  } catch (e) {
    return json(502, { error: (e && e.message) ? e.message : "Upstream request failed." });
  }
};

// ---- geocoding ------------------------------------------------------------
async function handleGeocode(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json(400, { error: "No addresses to geocode." });
  if (items.length > 250) return json(400, { error: "Too many addresses in one request (max 250)." });

  const points = [];
  for (const raw of items) points.push(await geocodeOne(String(raw == null ? "" : raw).trim()));
  return json(200, { points });
}

async function geocodeOne(raw) {
  if (!raw) return { ok: false, reason: "empty" };
  const isZip = /^\d{5}(-\d{4})?$/.test(raw);
  const params = new URLSearchParams({ key: KEY });
  if (isZip) params.set("components", "country:US|postal_code:" + raw.slice(0, 5)); // ZIP centroid
  else params.set("address", raw);

  const r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?" + params.toString());
  const data = await r.json();

  if (data.status === "OK" && data.results && data.results[0]) {
    const loc = data.results[0].geometry.location;
    return { ok: true, lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
  }
  if (data.status === "ZERO_RESULTS") return { ok: false, reason: "not found" };
  if (data.status === "OVER_QUERY_LIMIT" || data.status === "OVER_DAILY_LIMIT") {
    throw new Error("Google geocoding quota exceeded — try again shortly or raise your quota.");
  }
  if (data.status === "REQUEST_DENIED") {
    throw new Error("Geocoding request denied — check the API key and that the Geocoding API is enabled.");
  }
  return { ok: false, reason: data.status || "failed" };
}

// ---- drive-time matrix ----------------------------------------------------
async function handleMatrix(body) {
  const origins = Array.isArray(body.origins) ? body.origins : [];
  const destinations = Array.isArray(body.destinations) ? body.destinations : [];
  const departureTime = body.departureTime;
  if (!origins.length || !destinations.length) return json(400, { error: "Need both origins and destinations." });

  const D = destinations.length;
  const maxOriginsPerReq = Math.max(1, Math.floor(100 / D)); // 100-element cap for TRAFFIC_AWARE_OPTIMAL

  const durations = origins.map(() => new Array(D).fill(null));
  const distances = origins.map(() => new Array(D).fill(null));

  for (let start = 0; start < origins.length; start += maxOriginsPerReq) {
    const batch = origins.slice(start, start + maxOriginsPerReq);
    const elements = await routeMatrix(batch, destinations, departureTime);
    for (const el of elements) {
      const gi = start + (el.originIndex || 0);
      const j = el.destinationIndex || 0;
      if (gi >= origins.length || j >= D) continue;
      const ok = el.duration != null && (!el.status || el.status.code == null);
      if (ok) {
        durations[gi][j] = parseInt(String(el.duration).replace("s", ""), 10);
        distances[gi][j] = (el.distanceMeters != null) ? el.distanceMeters : null;
      }
    }
  }
  return json(200, { durations, distances });
}

async function routeMatrix(origins, destinations, departureTime) {
  const toWp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const reqBody = {
    origins: origins.map(toWp),
    destinations: destinations.map(toWp),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE_OPTIMAL"
  };
  if (departureTime) reqBody.departureTime = departureTime;

  const r = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,status"
    },
    body: JSON.stringify(reqBody)
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (r.status === 403) throw new Error("Routes API denied — enable the Routes API and check the key's API restrictions.");
    if (r.status === 429) throw new Error("Routes API quota exceeded — try again shortly or raise your quota.");
    throw new Error("Routes API error " + r.status + (text ? (": " + text.slice(0, 180)) : ""));
  }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}
