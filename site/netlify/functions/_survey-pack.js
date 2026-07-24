// Survey Pack — pure mapping/redaction layer for the client survey generator.
//
// Phase 3 of the requirement→deliverable flow: the deal's Market-report
// buildings become a co-branded client package (preset "survey") that
// client.html renders. This module turns catalog buildings + broker media +
// tracker spaces into the exact building objects stored in the package blob.
//
// REDACTION IS THE POINT OF THIS FILE. A client survey routes everything
// through the tenant-rep broker, so:
//   * listing/landlord contact info is STRIPPED from every building
//     (leasingContact, owner, propertyManager) — standard tenant-rep practice;
//   * only PUBLISHABLE market_spaces sources pass (listing-broker, flyer,
//     manual). CoStar-sourced rows (costar-alert / costar-report) are dropped
//     even if a caller hands them in — the CoStar firewall (market-spaces.sql)
//     keeps that data behind the broker login;
//   * any listing_* field that rides in on a space row is discarded.
// The Netlify function calls this server-side, so redacted data never reaches
// the client's browser at all.
//
// Files prefixed with "_" are not deployed as their own functions; this is
// bundled into deal-survey-create and required directly by tools/survey-test.js.
"use strict";

// Contact/ops fields a client deliverable must never carry, plus the
// Cockpit-computed fields client packages already exclude (shStripped).
var STRIP_FIELDS = ["leasingContact", "owner", "propertyManager", "places", "cscore", "byInd", "total", "tenants"];

var PUBLISHABLE_SOURCES = { "listing-broker": 1, "flyer": 1, "manual": 1 };

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stripBuilding(b) {
  var out = {};
  Object.keys(b || {}).forEach(function (k) {
    if (STRIP_FIELDS.indexOf(k) === -1) out[k] = b[k];
  });
  return out;
}

// '$4.50/SF/MO FSG' from a market_spaces row; '' when the rate is withheld.
function fmtSpaceRent(row) {
  if (row.asking_rate == null) return "";
  var s = "$" + Number(row.asking_rate).toFixed(2) + "/SF";
  if (row.rate_period === "mo") s += "/MO";
  else if (row.rate_period === "yr") s += "/YR";
  if (row.rate_basis) s += " " + row.rate_basis;
  return s;
}

// 'available' now, or 'avail Sep 2026' for a stated future date.
// ctx.today ('YYYY-MM-DD') is injectable so tests are deterministic.
function fmtAvailStatus(row, ctx) {
  var d = row.available_date ? String(row.available_date).slice(0, 10) : null;
  var today = (ctx && ctx.today) || null;
  if (!d || (today && d <= today)) return "available";
  var m = d.match(/^(\d{4})-(\d{2})/);
  if (!m) return "available";
  return "avail " + MONTHS[Math.max(0, Math.min(11, parseInt(m[2], 10) - 1))] + " " + m[1];
}

// One publishable market_spaces row -> the availabilities shape client.html
// already renders ({suite, sf, floor, rent, status}). No listing_* survives.
function spaceToAvail(row, ctx) {
  return {
    suite: row.suite != null ? String(row.suite) : "—",
    sf: row.sf != null ? Number(row.sf) : null,
    floor: row.floor != null && String(row.floor).match(/^\d+$/) ? parseInt(row.floor, 10) : (row.floor || null),
    rent: fmtSpaceRent(row),
    status: fmtAvailStatus(row, ctx) + (row.space_type === "sublease" ? " · sublease" : "")
  };
}

function normSuite(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/^suite\s+/, "").replace(/^#/, ""); }

// Static catalog availabilities + tracker rows for one building. A tracker row
// (fresher: flyer/broker-confirmed) REPLACES the static row for the same suite;
// new suites append, largest first.
function mergeAvailabilities(staticAvails, spaceRows, ctx) {
  var out = (staticAvails || []).map(function (a) { return Object.assign({}, a); });
  var bySuite = {};
  out.forEach(function (a, i) { var k = normSuite(a.suite); if (k) bySuite[k] = i; });
  var fresh = [];
  (spaceRows || []).forEach(function (r) {
    var av = spaceToAvail(r, ctx);
    var k = normSuite(av.suite);
    if (k && bySuite[k] != null) out[bySuite[k]] = av;
    else fresh.push(av);
  });
  fresh.sort(function (a, b) { return (b.sf || 0) - (a.sf || 0); });
  return out.concat(fresh);
}

// Rebuild the dossier's Suites tuples ([label, rsf, meta, rent]) from the
// merged availabilities so the client sees the freshest rows, not the baked ones.
function availsToSuites(avails) {
  return (avails || []).map(function (a) {
    var meta = [];
    if (a.floor != null && a.floor !== "") meta.push("Floor " + a.floor);
    if (a.status && a.status !== "available") meta.push(a.status);
    return [
      a.suite && a.suite !== "—" ? "Suite " + a.suite : "Suite TBD",
      a.sf != null ? Number(a.sf).toLocaleString("en-US") + " SF" : "",
      meta.join(" · "),
      a.rent || ""
    ];
  });
}

// Fold broker-uploaded building_media rows into the building's photos /
// floorplans arrays (deduped by url). Brochure PDFs intentionally stay out —
// the survey REBUILDS content into our own pages rather than redistributing
// third-party marketing wholesale.
function mergeMedia(b, mediaRows) {
  var photos = (b.photos || []).slice(), plans = (b.floorplans || []).slice();
  var seen = {};
  photos.concat(plans).forEach(function (m) { if (m && m.url) seen[m.url] = 1; });
  (mediaRows || []).forEach(function (m) {
    if (!m || !m.url || seen[m.url]) return;
    if (m.kind === "photo") { photos.push({ url: m.url, caption: m.title || null }); seen[m.url] = 1; }
    else if (m.kind === "floorplan") { plans.push({ label: m.title || "Floor plan", url: m.url }); seen[m.url] = 1; }
  });
  b.photos = photos; b.floorplans = plans;
  return b;
}

// Drop non-publishable rows and scrub listing_* keys off the survivors.
function publishableSpaces(spaceRows) {
  return (spaceRows || []).filter(function (r) {
    return r && PUBLISHABLE_SOURCES[r.source] === 1;
  }).map(function (r) {
    var out = {};
    Object.keys(r).forEach(function (k) { if (k.indexOf("listing_") !== 0) out[k] = r[k]; });
    return out;
  });
}

// The whole assembly: shortlisted deal_properties -> survey building objects.
//   catalogBuildings : vantage-data.json buildings
//   props            : deal_properties rows (status 'shortlisted'), in order
//   mediaRows        : building_media rows for these buildings
//   spaceRows        : market_spaces rows for these buildings (any source — filtered here)
// Returns { buildings, skipped } — skipped = shortlisted names with no catalog match.
function buildSurveyBuildings(catalogBuildings, props, mediaRows, spaceRows, ctx) {
  ctx = ctx || {};
  var byId = {};
  (catalogBuildings || []).forEach(function (b) { if (b && b.id) byId[b.id] = b; });
  var mediaByBld = {}, spacesByBld = {};
  (mediaRows || []).forEach(function (m) { (mediaByBld[m.building_id] = mediaByBld[m.building_id] || []).push(m); });
  publishableSpaces(spaceRows).forEach(function (r) { (spacesByBld[r.building_id] = spacesByBld[r.building_id] || []).push(r); });

  var buildings = [], skipped = [];
  (props || []).forEach(function (p) {
    var src = p && p.building_id ? byId[p.building_id] : null;
    if (!src) { skipped.push((p && (p.name || p.address)) || "unknown building"); return; }
    var b = stripBuilding(src);
    mergeMedia(b, mediaByBld[src.id]);
    b.availabilities = mergeAvailabilities(src.availabilities, spacesByBld[src.id], ctx);
    b.suites = availsToSuites(b.availabilities);
    var totalSf = b.availabilities.reduce(function (t, a) { return t + (a.sf || 0); }, 0);
    if (totalSf) b.avail = totalSf.toLocaleString("en-US");
    buildings.push(b);
  });
  return { buildings: buildings, skipped: skipped };
}

module.exports = {
  STRIP_FIELDS: STRIP_FIELDS,
  stripBuilding: stripBuilding,
  fmtSpaceRent: fmtSpaceRent,
  fmtAvailStatus: fmtAvailStatus,
  spaceToAvail: spaceToAvail,
  mergeAvailabilities: mergeAvailabilities,
  availsToSuites: availsToSuites,
  mergeMedia: mergeMedia,
  publishableSpaces: publishableSpaces,
  buildSurveyBuildings: buildSurveyBuildings
};
