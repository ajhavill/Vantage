// Vantage — saved-tour serialization + map helpers (pure, no DOM, no network).
//
// ONE source of truth for turning the tour-route optimizer's in-page plan into
// the public.deal_tours row shape (and back into a render model), used by:
//   • the browser (deals.html) via <script src> — save on optimize, load on open,
//   • the Node unit test (tools/tour-save-test.js) via require().
// UMD guard at the bottom: exports for Node, attaches window.TourPlan in the browser.
//
// deal_tours contract (supabase/deal-tours.sql):
//   stops jsonb — ordered [{buildingId?, name, address, lat, lng, arrive, depart,
//                           suite?, listingBroker?, listingEmail?, notes?}]
//   legs  jsonb — [{fromIdx, toIdx, driveMin}] between consecutive stops
//   meta  jsonb — {totalDriveMin, optimizedAt, dwellMin, bufferMin, startAddr,
//                  leaveBy, firstDriveMin, nogeo}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TourPlan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function toDate(v) {
    if (v == null) return null;
    var d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function toIso(v) { var d = toDate(v); return d ? d.toISOString() : null; }
  // local wall-clock pieces (the tour happens in the broker's timezone)
  function localDateStr(v) {
    var d = toDate(v); if (!d) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function localTimeStr(v) {
    var d = toDate(v); if (!d) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---- optimizer plan -> deal_tours row ------------------------------------
  // plan: [{stop:{buildingId?, name, addr?, lat, lng, contact?:{name,email}},
  //         arrive:Date|ISO, depart:Date|ISO, driveNextMin?, bufferMin?}]
  // opts: {dwell?, buffer?, startAddr?, leaveBy?:Date|ISO, firstDriveMin?,
  //        nogeo?:[names], optimizedAt?:ISO}
  function rowFromPlan(dealId, plan, opts) {
    opts = opts || {};
    plan = plan || [];
    var stops = plan.map(function (p) {
      var s = p.stop || {};
      var c = s.contact || {};
      var out = {
        buildingId: s.buildingId || null,
        name: s.name || 'Tour stop',
        address: s.addr || s.address || null,
        lat: isNum(s.lat) ? s.lat : null,
        lng: isNum(s.lng) ? s.lng : null,
        arrive: toIso(p.arrive),
        depart: toIso(p.depart)
      };
      if (c.name) out.listingBroker = c.name;
      if (c.email) out.listingEmail = c.email;
      return out;
    });
    var legs = legsFromPlan(plan);
    var total = 0;
    legs.forEach(function (l) { if (isNum(l.driveMin)) total += l.driveMin; });
    var first = plan[0] || {};
    var leaveByIso = toIso(opts.leaveBy);
    var meta = {
      totalDriveMin: total,
      optimizedAt: opts.optimizedAt || new Date().toISOString(),
      dwellMin: isNum(opts.dwell) ? opts.dwell : null,
      bufferMin: isNum(opts.buffer) ? opts.buffer : null,
      startAddr: opts.startAddr || null,
      leaveBy: leaveByIso,
      firstDriveMin: isNum(opts.firstDriveMin) ? opts.firstDriveMin : null,
      nogeo: (opts.nogeo || []).slice()
    };
    return {
      deal_id: dealId,
      tour_date: localDateStr(first.arrive),
      departure: leaveByIso ? localTimeStr(leaveByIso) : localTimeStr(first.arrive),
      stops: stops,
      legs: legs,
      meta: meta
    };
  }

  function legsFromPlan(plan) {
    var legs = [];
    (plan || []).forEach(function (p, i) {
      if (i < plan.length - 1 && p.driveNextMin != null && isFinite(p.driveNextMin)) {
        legs.push({ fromIdx: i, toIdx: i + 1, driveMin: Math.round(p.driveNextMin) });
      }
    });
    return legs;
  }

  // ---- deal_tours row -> render model --------------------------------------
  // Splits stops into mappable (finite lat/lng) vs missing, and keeps only the
  // legs whose BOTH endpoints are mappable (so a coord-less stop never crashes
  // the map — it's just listed under it). legByFrom indexes leg minutes by the
  // ORIGINAL stop index for the itinerary list.
  function renderModel(row) {
    row = row || {};
    var stops = Array.isArray(row.stops) ? row.stops : [];
    var legs = Array.isArray(row.legs) ? row.legs : [];
    var meta = row.meta || {};
    var mapStops = [], missing = [];
    stops.forEach(function (s, i) {
      if (s && isNum(s.lat) && isNum(s.lng)) mapStops.push({ idx: i, stop: s });
      else missing.push((s && s.name) || ('Stop ' + (i + 1)));
    });
    var mappable = {};
    mapStops.forEach(function (m) { mappable[m.idx] = true; });
    var mapLegs = legs.filter(function (l) {
      return l && mappable[l.fromIdx] && mappable[l.toIdx];
    });
    var legByFrom = {};
    legs.forEach(function (l) { if (l) legByFrom[l.fromIdx] = l; });
    var total = isNum(meta.totalDriveMin) ? meta.totalDriveMin
      : legs.reduce(function (a, l) { return a + ((l && isNum(l.driveMin)) ? l.driveMin : 0); }, 0);
    return {
      stops: stops,
      legs: legs,
      legByFrom: legByFrom,
      mapStops: mapStops,
      mapLegs: mapLegs,
      missing: missing,
      totalDriveMin: total,
      optimizedAt: meta.optimizedAt || null,
      meta: meta
    };
  }

  // ---- map bits -------------------------------------------------------------
  function legLabel(driveMin) {
    if (driveMin == null || !isFinite(driveMin)) return '';
    var m = Math.round(driveMin);
    return (m < 1) ? '<1 min' : (m + ' min');
  }
  // midpoint of a leg for the drive-time label. Simple average is plenty at
  // city scale (stops are a few km apart — great-circle error is negligible).
  function legMidpoint(a, b) {
    if (!a || !b || !isNum(a.lat) || !isNum(a.lng) || !isNum(b.lat) || !isNum(b.lng)) return null;
    return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  }

  return {
    rowFromPlan: rowFromPlan,
    legsFromPlan: legsFromPlan,
    renderModel: renderModel,
    legLabel: legLabel,
    legMidpoint: legMidpoint,
    _localDateStr: localDateStr,
    _localTimeStr: localTimeStr
  };
}));
