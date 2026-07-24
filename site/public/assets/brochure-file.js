// Brochure Filer — pure mapping layer for the brochure auto-filing flow (broker-only).
//
// Phase 2 of the requirement→deliverable flow. The broker batch-drops
// listing-broker marketing PDFs on the deal page; deal-brochure-extract
// (background Netlify fn) reads each one with Claude. This module turns those
// per-file extractions into:
//   * a review PLAN the deal page renders (per file: catalog match, editable
//     label, spaces, floor-plan pages),
//   * exact `building_media` insert payloads (the filed brochure + rendered
//     floor-plan page images),
//   * exact `market_spaces` upsert payloads (source 'flyer' — the internal
//     availability tracker),
//   * the filing summary line.
//
// SOURCING: these are listing brokers' own marketing materials — the CoStar
// firewall doesn't apply, and the building-media bucket is public by design
// (marketing meant to be shown to clients).
//
// Pure + UMD like assets/report-import.js: no DOM, no network. The browser
// page and tools/brochure-test.js share these functions. Catalog matching and
// space normalization are delegated to ReportImport so a brochure row and a
// CoStar-report row for the same suite collapse onto the same dedup_key.
(function () {
  "use strict";

  var RI = (typeof module !== "undefined" && module.exports)
    ? require("./report-import.js")
    : (typeof window !== "undefined" ? window.ReportImport : null);

  /* ---------------- tolerant coercers ---------------- */
  function toStr(v) {
    if (v == null) return null;
    var s = String(v).trim();
    return s ? s : null;
  }
  function toInt(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? Math.round(n) : null;
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function safeName(n) { return String(n || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80); }

  var DOC_TYPES = ["brochure", "flyer", "floorplan", "other"];
  var DOC_LABEL = { brochure: "Brochure", flyer: "Flyer", floorplan: "Floor plans", other: "Other" };

  /* ---------------- plan: per-file extractions -> reviewable model ---------------- */

  // Clamp a normalized (0-1, top-left origin) contact box; null when
  // malformed or degenerate — a bad box means "don't mask", never a crash.
  function normBox(b) {
    if (!b || typeof b !== "object") return null;
    var x0 = Number(b.x0), y0 = Number(b.y0), x1 = Number(b.x1), y1 = Number(b.y1);
    if (![x0, y0, x1, y1].every(isFinite)) return null;
    x0 = Math.min(Math.max(x0, 0), 1); y0 = Math.min(Math.max(y0, 0), 1);
    x1 = Math.min(Math.max(x1, 0), 1); y1 = Math.min(Math.max(y1, 0), 1);
    if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  // Floor-plan page list -> [{page, contactBox}], deduped, sorted (pages ≥ 1).
  // `contactBox` marks the listing-broker contact block the renderer MASKS
  // before the image reaches any client surface. Accepts bare ints (legacy
  // extractions) or {page, contactBox} objects; a duplicate page keeps its box
  // if ANY duplicate carried one — masking errs toward scrubbing.
  function normalizePages(pages) {
    var byPage = {}, seen = [];
    (Array.isArray(pages) ? pages : []).forEach(function (p) {
      var n = toInt(p && typeof p === "object" ? p.page : p);
      if (n == null || n < 1) return;
      var box = (p && typeof p === "object") ? normBox(p.contactBox) : null;
      if (!byPage[n]) { byPage[n] = { page: n, contactBox: box }; seen.push(n); }
      else if (!byPage[n].contactBox && box) byPage[n].contactBox = box;
    });
    return seen.sort(function (a, b) { return a - b; }).map(function (n) { return byPage[n]; });
  }

  function normalizeHighlights(hs) {
    return (Array.isArray(hs) ? hs : []).map(toStr).filter(Boolean).slice(0, 5);
  }

  // files = [{filename, result}] where result is the fn's extraction
  // catalog = vantage-data.json buildings ({id,name,addr,...})
  function buildPlan(files, catalog, ctx) {
    ctx = ctx || {};
    var entries = (Array.isArray(files) ? files : [])
      .filter(function (f) { return f && f.result; })
      .map(function (f) {
        var r = f.result || {};
        var address = toStr(r.address);
        var name = toStr(r.buildingName);
        var docType = DOC_TYPES.indexOf(r.docType) >= 0 ? r.docType : "brochure";
        var cat = RI ? RI.matchCatalog(address, name, catalog) : null;
        return {
          filename: toStr(f.filename) || "file.pdf",
          docType: docType,
          docTypeLabel: DOC_LABEL[docType],
          label: toStr(r.label) || (DOC_LABEL[docType] + (name ? " — " + name : "")),
          name: name,
          address: address,
          city: toStr(r.city),
          buildingId: cat ? cat.id : null,      // review UI lets the broker fix a miss
          catalogName: cat ? (cat.name || null) : null,
          include: true,
          spaces: (Array.isArray(r.spaces) ? r.spaces : []).map(RI ? RI.normalizeSpace : function (s) { return s; }),
          floorPlanPages: normalizePages(r.floorPlanPages),
          highlights: normalizeHighlights(r.highlights),
          raw: r                                 // verbatim extraction, kept for market_spaces.raw provenance
        };
      });
    return {
      asOf: toStr(ctx.today) || todayISO(),
      entries: entries
    };
  }

  // The broker picked (or corrected) a catalog building for this file.
  function assignBuilding(entry, catalogBuilding) {
    entry.buildingId = catalogBuilding ? (catalogBuilding.id || null) : null;
    entry.catalogName = catalogBuilding ? (catalogBuilding.name || null) : null;
    return entry;
  }

  /* ---------------- write payloads ---------------- */

  // Storage object path inside the building-media bucket. `uniq` is the page's
  // uniqueness token (building.html pattern) so re-filing never collides.
  function storagePath(entry, kind, uniq, filename) {
    return entry.buildingId + "/" + kind + "/" + uniq + "_" + safeName(filename || entry.filename);
  }

  // building_media insert for the filed PDF itself (kind 'brochure').
  function brochureMediaRow(entry, path, url) {
    return {
      building_id: entry.buildingId,
      kind: "brochure",
      storage_path: path,
      url: url,
      title: entry.label || entry.filename
    };
  }

  // building_media insert for one rendered floor-plan page image.
  function floorplanMediaRow(entry, page, path, url) {
    var base = entry.catalogName || entry.name || "";
    return {
      building_id: entry.buildingId,
      kind: "floorplan",
      storage_path: path,
      url: url,
      title: "Floor plan" + (base ? " — " + base : "") + " (p." + page + ", " + entry.filename + ")"
    };
  }

  // market_spaces upsert payload for one advertised space (source 'flyer').
  // Same dedup_key construction as the CoStar report import, so a flyer and a
  // report describing the same suite refresh ONE tracker row.
  function spaceRow(entry, space, plan) {
    return {
      org_id: RI ? RI.ORG_ID : null,
      building_id: entry.buildingId || null,
      building_name: entry.catalogName || entry.name || null,
      address: entry.address || entry.name || "",
      suite: space.suite,
      floor: space.floor,
      sf: space.sf,
      contiguous_sf: space.contiguousSf != null ? space.contiguousSf : null,
      space_type: space.spaceType,
      asking_rate: space.rate,
      rate_period: space.ratePeriod,
      rate_basis: space.rateBasis,
      listing_broker: space.listingBroker || null,
      listing_company: space.listingCompany || null,
      listing_email: space.listingEmail || null,
      listing_phone: space.listingPhone || null,
      available_date: space.availableDate,
      source: "flyer",
      source_detail: "brochure: " + entry.filename + " (" + plan.asOf + ")",
      as_of: plan.asOf,
      status: "active",
      dedup_key: RI ? RI.dedupKey(entry.address || entry.name || "", space.suite) : null,
      raw: space.raw || null
    };
  }

  // every market_spaces payload for the checked, building-assigned entries
  function spacePayloads(plan) {
    var out = [];
    (plan.entries || []).forEach(function (entry) {
      if (!entry.include || !entry.buildingId) return;
      (entry.spaces || []).forEach(function (s) { out.push(spaceRow(entry, s, plan)); });
    });
    return out;
  }

  // fields refreshed when a dedup_key already exists (re-file = update).
  // NOTE: a flyer never OVERWRITES a listing-broker-confirmed source, and it
  // must not null out listing-contact fields a richer source already has —
  // the caller passes the existing row so this patch can defer.
  function spacePatch(row, existing) {
    var ex = existing || {};
    var keepSource = ex.source === "listing-broker";   // broker-confirmed provenance outranks a flyer
    var patch = {
      building_id: row.building_id,
      building_name: row.building_name,
      suite: row.suite,
      floor: row.floor,
      sf: row.sf,
      space_type: row.space_type,
      asking_rate: row.asking_rate,
      rate_period: row.rate_period,
      rate_basis: row.rate_basis,
      available_date: row.available_date,
      source: keepSource ? ex.source : "flyer",
      source_detail: row.source_detail,
      as_of: row.as_of,
      status: "active",
      raw: row.raw
    };
    ["listing_broker", "listing_company", "listing_email", "listing_phone"].forEach(function (k) {
      if (row[k] != null) patch[k] = row[k];           // only fill, never blank an existing contact
    });
    return patch;
  }

  /* ---------------- summary ---------------- */

  function summarize(plan) {
    var included = (plan.entries || []).filter(function (e) { return e.include; });
    var filed = included.filter(function (e) { return e.buildingId; });
    var unmatched = included.length - filed.length;
    var spaces = 0, planPages = 0;
    filed.forEach(function (e) {
      spaces += (e.spaces || []).length;
      planPages += (e.floorPlanPages || []).length;
    });
    var bits = ["Filing " + filed.length + " document" + (filed.length === 1 ? "" : "s")];
    if (planPages) bits.push(planPages + " floor-plan page" + (planPages === 1 ? "" : "s"));
    if (spaces) bits.push(spaces + " space" + (spaces === 1 ? "" : "s") + " → tracker");
    if (unmatched) bits.push(unmatched + " need a building picked (skipped)");
    return { filed: filed.length, spaces: spaces, planPages: planPages, unmatched: unmatched, line: bits.join(" · ") };
  }

  var API = {
    buildPlan: buildPlan,
    assignBuilding: assignBuilding,
    storagePath: storagePath,
    brochureMediaRow: brochureMediaRow,
    floorplanMediaRow: floorplanMediaRow,
    spaceRow: spaceRow,
    spacePayloads: spacePayloads,
    spacePatch: spacePatch,
    summarize: summarize,
    _normalizePages: normalizePages,
    _normBox: normBox,
    _safeName: safeName
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.BrochureFile = API;
})();
