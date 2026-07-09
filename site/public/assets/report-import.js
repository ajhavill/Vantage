// Report Import — pure mapping layer for the CoStar market-report import (broker-only).
//
// Turns the JSON that deal-report-import (Netlify function) extracts from an
// uploaded CoStar availability report / survey PDF into:
//   * a review PLAN the deal page renders (per-building: catalog match,
//     already-on-this-deal flag, editable spaces),
//   * exact `deal_properties` insert payloads (candidate buildings on the deal),
//   * exact `market_spaces` upsert payloads (the internal availability tracker),
//   * the import summary line.
//
// COMPLIANCE: everything here feeds broker-internal surfaces only (deals.html
// behind the login + the org-scoped market_spaces table). Nothing is ever
// written to vantage-data.json, client.html, or portal surfaces — see the
// header of supabase/market-spaces.sql (CoStar sourcing rule).
//
// Pure + UMD like assets/market-spaces.js: no DOM, no network. The browser page
// and tools/report-import-test.js share these functions, so the dedup_key the
// UI writes is BY CONSTRUCTION the one the tests pin down. Address
// normalization is delegated to MarketSpaces.normalizeAddress so ingested
// alert rows and report rows collapse onto the same key.
(function () {
  "use strict";

  var MS = (typeof module !== "undefined" && module.exports)
    ? require("./market-spaces.js")
    : (typeof window !== "undefined" ? window.MarketSpaces : null);

  // Havill & Co. org (same constant the costar-alert ingest writes with).
  var ORG_ID = "00000000-0000-0000-0000-000000000001";

  /* ---------------- tolerant coercers (extraction output is never trusted) ---------------- */
  function toNum(v) {
    if (v == null || v === "") return null;
    var n = Number(String(v).replace(/[$,\s]/g, ""));
    return isFinite(n) ? n : null;
  }
  function toInt(v) { var n = toNum(v); return n == null ? null : Math.round(n); }
  function toStr(v) {
    if (v == null) return null;
    var s = String(v).trim();
    return s ? s : null;
  }
  function toDate(v) {  // 'YYYY-MM-DD' or null — anything else is dropped
    var s = toStr(v);
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? (m[1] + "-" + m[2] + "-" + m[3]) : null;
  }
  function oneOf(v, allowed) {
    var s = toStr(v);
    if (!s) return null;
    for (var i = 0; i < allowed.length; i++) if (allowed[i].toLowerCase() === s.toLowerCase()) return allowed[i];
    return null;
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* ---------------- dedup key ----------------
   * Same shape the market_spaces ingester uses: normalized address | suite,
   * all lowercase. The address half is MarketSpaces.normalizeAddress().key
   * ("num|core|type|dir"), so "1620 26th Street, Suite 210" and
   * "1620 26th St" + suite "210" collapse onto one row. The suite half strips
   * everything but [a-z0-9] ("Suite 210" == "STE-210" == "210"). */
  function suiteKey(suite) {
    var s = String(suite == null ? "" : suite).toLowerCase();
    s = s.replace(/\b(suite|ste|unit|apt|fl|floor|no|rm|room)\b/g, " ");
    return s.replace(/[^a-z0-9]/g, "");
  }
  function dedupKey(address, suite) {
    var addrKey = MS ? MS.normalizeAddress(address || "").key : String(address || "").toLowerCase();
    return addrKey + "|" + suiteKey(suite);
  }

  /* ---------------- catalog match + on-deal dedupe ---------------- */

  // catalog = vantage-data.json buildings ({id,name,addr,...}). Address match
  // first (MarketSpaces matcher); exact name match as a fallback for CoStar
  // rows that lead with the building name.
  function matchCatalog(address, name, catalog) {
    if (!catalog || !catalog.length || !MS) return null;
    if (address) {
      var hit = MS.matchBuilding({ address: address }, catalog);
      if (hit) return hit;
    }
    var nm = toStr(name);
    if (nm) {
      nm = nm.toLowerCase();
      for (var i = 0; i < catalog.length; i++) {
        var b = catalog[i];
        if (b && b.name && String(b.name).toLowerCase() === nm) return b;
      }
    }
    return null;
  }

  // Is this extracted building already a candidate on the deal?
  // By catalog id when both sides have one, else by address (handles the
  // address-only manual adds deal_properties supports).
  function isOnDeal(entry, existingProps) {
    var props = existingProps || [];
    for (var i = 0; i < props.length; i++) {
      var p = props[i]; if (!p) continue;
      if (entry.buildingId && p.building_id && p.building_id === entry.buildingId) return true;
      if (MS && entry.address && p.address && MS.addressesMatch(entry.address, p.address)) return true;
    }
    return false;
  }

  /* ---------------- plan: parsed JSON -> reviewable model ---------------- */

  function normalizeSpace(raw) {
    raw = raw || {};
    return {
      suite: toStr(raw.suite),
      floor: toStr(raw.floor),
      sf: toInt(raw.sf),
      contiguousSf: toInt(raw.contiguousSf),
      rate: toNum(raw.rate),
      ratePeriod: oneOf(raw.ratePeriod, ["mo", "yr"]),
      rateBasis: oneOf(raw.rateBasis, ["FSG", "NNN", "MG"]),
      spaceType: oneOf(raw.spaceType, ["direct", "sublease"]),
      availableDate: toDate(raw.availableDate),
      listingBroker: toStr(raw.listingBroker),
      listingCompany: toStr(raw.listingCompany),
      listingEmail: toStr(raw.listingEmail),
      listingPhone: toStr(raw.listingPhone),
      raw: raw                              // verbatim parsed row, kept for market_spaces.raw
    };
  }

  // parsed = the function's result ({reportDate?, buildings:[...]})
  // catalog = vantage-data.json buildings; existingProps = deal_properties rows
  // ({building_id,address,name}) already on the deal.
  function buildPlan(parsed, catalog, existingProps, ctx) {
    parsed = parsed || {}; ctx = ctx || {};
    var reportDate = toDate(parsed.reportDate);
    var buildings = (Array.isArray(parsed.buildings) ? parsed.buildings : [])
      .filter(function (b) { return b && (toStr(b.address) || toStr(b.name)); })
      .map(function (b) {
        var address = toStr(b.address);
        var cat = matchCatalog(address, b.name, catalog);
        var entry = {
          name: toStr(b.name),
          address: address,
          city: toStr(b.city),
          "class": toStr(b["class"]),
          rba: toInt(b.rba),
          yearBuilt: toInt(b.yearBuilt),
          buildingId: cat ? cat.id : null,
          catalogName: cat ? (cat.name || null) : null,
          alreadyOnDeal: false,
          include: true,                     // review checkbox — all checked by default
          spaces: (Array.isArray(b.spaces) ? b.spaces : []).map(normalizeSpace)
        };
        entry.alreadyOnDeal = isOnDeal(entry, existingProps);
        return entry;
      });
    return {
      reportDate: reportDate,
      asOf: reportDate || toDate(ctx.today) || todayISO(),  // report date wins; today is the fallback
      filename: toStr(ctx.filename) || "report.pdf",
      buildings: buildings
    };
  }

  /* ---------------- write payloads ---------------- */

  // deal_properties insert (same shape as the page's manual "+ Add building")
  function dealPropertyRow(entry, dealId) {
    return {
      deal_id: dealId,
      building_id: entry.buildingId || null,
      name: entry.catalogName || entry.name || entry.address || "Untitled building",
      address: entry.address || null,
      status: "considering"
    };
  }

  // market_spaces upsert payload for one space of one plan building
  function spaceRow(entry, space, plan) {
    return {
      org_id: ORG_ID,
      building_id: entry.buildingId || null,
      building_name: entry.catalogName || entry.name || null,
      address: entry.address || entry.name || "",   // NOT NULL column; name-led rows fall back to the name
      suite: space.suite,
      floor: space.floor,
      sf: space.sf,
      contiguous_sf: space.contiguousSf,
      space_type: space.spaceType,
      asking_rate: space.rate,
      rate_period: space.ratePeriod,
      rate_basis: space.rateBasis,
      listing_broker: space.listingBroker,
      listing_company: space.listingCompany,
      listing_email: space.listingEmail,
      listing_phone: space.listingPhone,
      available_date: space.availableDate,
      source: "costar-report",
      source_detail: "report: " + plan.filename + " (" + plan.asOf + ")",
      as_of: plan.asOf,
      status: "active",
      dedup_key: dedupKey(entry.address || entry.name || "", space.suite),
      raw: space.raw || null
    };
  }

  // every market_spaces payload for the checked buildings, in plan order
  function spacePayloads(plan) {
    var out = [];
    (plan.buildings || []).forEach(function (entry) {
      if (!entry.include) return;
      (entry.spaces || []).forEach(function (s) { out.push(spaceRow(entry, s, plan)); });
    });
    return out;
  }

  // the fields refreshed when a dedup_key already exists (re-import = update,
  // never duplicate; provenance + freshness move forward with the new report)
  function spacePatch(row) {
    return {
      building_id: row.building_id,
      building_name: row.building_name,
      suite: row.suite,
      floor: row.floor,
      sf: row.sf,
      contiguous_sf: row.contiguous_sf,
      space_type: row.space_type,
      asking_rate: row.asking_rate,
      rate_period: row.rate_period,
      rate_basis: row.rate_basis,
      listing_broker: row.listing_broker,
      listing_company: row.listing_company,
      listing_email: row.listing_email,
      listing_phone: row.listing_phone,
      available_date: row.available_date,
      source: "costar-report",
      source_detail: row.source_detail,
      as_of: row.as_of,
      status: "active",
      raw: row.raw
    };
  }

  /* ---------------- summary ---------------- */

  // counts for the checked buildings: what lands on the deal, what refreshes
  // the tracker, what was skipped because it's already a candidate
  function summarize(plan) {
    var included = (plan.buildings || []).filter(function (b) { return b.include; });
    var added = included.filter(function (b) { return !b.alreadyOnDeal; });
    var skipped = included.length - added.length;
    var spaces = 0, matched = 0;
    included.forEach(function (b) {
      spaces += (b.spaces || []).length;
      if (b.buildingId) matched++;
    });
    var bits = [
      "Imported " + added.length + " building" + (added.length === 1 ? "" : "s"),
      spaces + " space" + (spaces === 1 ? "" : "s")
    ];
    if (matched) bits.push(matched + " matched to your map");
    if (skipped) bits.push(skipped + " already on this deal (skipped)");
    return { added: added.length, spaces: spaces, matched: matched, skipped: skipped, line: bits.join(" · ") };
  }

  var API = {
    ORG_ID: ORG_ID,
    dedupKey: dedupKey,
    suiteKey: suiteKey,
    matchCatalog: matchCatalog,
    isOnDeal: isOnDeal,
    normalizeSpace: normalizeSpace,
    buildPlan: buildPlan,
    dealPropertyRow: dealPropertyRow,
    spaceRow: spaceRow,
    spacePayloads: spacePayloads,
    spacePatch: spacePatch,
    summarize: summarize,
    _toNum: toNum, _toInt: toInt, _toStr: toStr, _toDate: toDate
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.ReportImport = API;
})();
