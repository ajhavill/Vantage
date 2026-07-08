// Market Spaces — live "available spaces" layer for the Market MAP view (broker-only).
//
// Reads/writes the Supabase table `public.market_spaces` with the page's authed
// supabase-js client (RLS scopes everything to the broker's org). Self-contained like
// van.js: injects its own CSS (`msp-` prefixed), owns its own DOM, and integrates by
// wrapping existing globals (window.showModule / window.showPortfolio) plus a Leaflet
// init hook to capture the Market overview map — index.html only carries the script tag.
//
// What it adds:
//   • count chips on buildings that have >=1 active tracked space (own layer; never
//     touches the app's markers or cluster group)
//   • a collapsible "Spaces (N)" drawer on the map with filters + freshness/source badges
//   • a "Tracked spaces" block on the building dossier with Verify / Confirmed / status
//
// COMPLIANCE: market_spaces data lives ONLY here + Supabase. It is never written into
// vantage-data.json, embedded page data, or anything a client/portal user can see.
//
// The pure helpers (address normalizer/matcher, freshness buckets, rate normalization)
// are exported for Node so tools/spaces-test.js can exercise them without a browser
// (same UMD-ish guard as assets/model-engine.js).
(function () {
  "use strict";

  /* ================================================================
   *  PURE LOGIC (Node-testable, no DOM / no network)
   * ================================================================ */

  // canonical short forms for common street-suffix + directional words
  var ABBR = {
    boulevard: "blvd", blvd: "blvd",
    street: "st", st: "st",
    avenue: "ave", ave: "ave", av: "ave",
    drive: "dr", dr: "dr",
    road: "rd", rd: "rd",
    place: "pl", pl: "pl",
    lane: "ln", ln: "ln",
    court: "ct", ct: "ct",
    circle: "cir", cir: "cir",
    terrace: "ter", ter: "ter",
    highway: "hwy", hwy: "hwy",
    parkway: "pkwy", pkwy: "pkwy",
    freeway: "fwy", fwy: "fwy",
    way: "way",
    north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w",
    northeast: "ne", ne: "ne", northwest: "nw", nw: "nw",
    southeast: "se", se: "se", southwest: "sw", sw: "sw"
  };
  var TYPES = { blvd: 1, st: 1, ave: 1, dr: 1, rd: 1, pl: 1, ln: 1, ct: 1, cir: 1, ter: 1, hwy: 1, pkwy: 1, fwy: 1, way: 1 };
  var DIRS = { n: 1, s: 1, e: 1, w: 1, ne: 1, nw: 1, se: 1, sw: 1 };
  // tokens that start a unit designator — the token AND its value are dropped
  var UNIT = { suite: 1, ste: 1, unit: 1, apt: 1, fl: 1, floor: 1, no: 1, rm: 1, room: 1 };

  // "1620 26th Street, Suite 210, Santa Monica CA" ->
  //   { num:"1620", core:"26th", type:"st", dir:null, key:"1620|26th|st|" }
  function normalizeAddress(addr) {
    var s = String(addr == null ? "" : addr).toLowerCase();
    // prefer the street segment (before the first comma) when it looks like one
    var seg = s.split(",")[0];
    if (/\d/.test(seg)) s = seg;
    s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    var raw = s.length ? s.split(" ") : [];
    var num = null, toks = [], i, t;
    if (raw.length && /^\d+[a-z]?$/.test(raw[0])) { num = raw[0]; raw = raw.slice(1); }
    for (i = 0; i < raw.length; i++) {
      t = raw[i];
      if (UNIT[t]) { i++; continue; }          // "suite 210" -> drop both
      if (/^\d+$/.test(t) && toks.length) continue; // stray unit/zip numbers
      toks.push(ABBR[t] || t);
    }
    var type = null, dir = null, core = [];
    for (i = 0; i < toks.length; i++) {
      t = toks[i];
      if (!type && TYPES[t] && i > 0) { type = t; toks = toks.slice(0, i); break; } // cut at suffix: city/state follow
    }
    for (i = 0; i < toks.length; i++) {
      t = toks[i];
      if (DIRS[t]) { if (!dir) dir = t; continue; }
      core.push(t);
    }
    var coreStr = core.join(" ");
    return { num: num, core: coreStr, type: type, dir: dir, key: (num || "") + "|" + coreStr + "|" + (type || "") + "|" + (dir || "") };
  }

  // same street number + fuzzy street-name match (suffix/directional conflicts reject)
  function addressesMatch(a, b) {
    var A = typeof a === "string" ? normalizeAddress(a) : a;
    var B = typeof b === "string" ? normalizeAddress(b) : b;
    if (!A || !B || !A.num || !B.num || A.num !== B.num) return false;
    if (!A.core || !B.core) return false;
    if (A.type && B.type && A.type !== B.type) return false;
    if (A.dir && B.dir && A.dir !== B.dir) return false;
    if (A.core === B.core) return true;
    var x = A.core + " ", y = B.core + " ";
    return x.indexOf(y) === 0 || y.indexOf(x) === 0; // token-prefix containment ("broadway" ~ "broadway santa monica")
  }

  // pick the portfolio building a market_spaces row belongs to (or null)
  function matchBuilding(row, buildings) {
    if (!row || !buildings || !buildings.length) return null;
    var norm = normalizeAddress(row.address || "");
    if (!norm.num) return null;
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      if (b && b.addr && addressesMatch(norm, normalizeAddress(b.addr))) return b;
    }
    return null;
  }

  // as_of -> 'fresh' (<=30d) | 'aging' (31-90d) | 'stale' (>90d) | 'unknown'
  function freshnessBucket(asOf, today) {
    if (!asOf) return "unknown";
    var a = new Date(String(asOf).slice(0, 10) + "T00:00:00");
    if (isNaN(a)) return "unknown";
    var t = today ? new Date(String(today).slice(0, 10) + "T00:00:00") : new Date();
    t.setHours(0, 0, 0, 0);
    var days = Math.round((t - a) / 86400000);
    if (days <= 30) return "fresh";
    if (days <= 90) return "aging";
    return "stale";
  }

  // normalize an asking rate to $/SF/yr for display (monthly x 12)
  function annualRate(rate, period) {
    if (rate == null || rate === "" || !isFinite(Number(rate))) return null;
    var n = Number(rate);
    return period === "mo" ? Math.round(n * 12 * 100) / 100 : n;
  }

  var API = {
    normalizeAddress: normalizeAddress,
    addressesMatch: addressesMatch,
    matchBuilding: matchBuilding,
    freshnessBucket: freshnessBucket,
    annualRate: annualRate
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window === "undefined" || !window.document) return; // Node: pure logic only
  window.MarketSpaces = API;

  /* ================================================================
   *  BROWSER WIDGET (broker UI only — behind the login gate)
   * ================================================================ */

  var SUPA_URL = "https://siaoqjvvxuckyxpxftwt.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpYW9xanZ2eHVja3l4cHhmdHd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2OTU5MTMsImV4cCI6MjA5ODI3MTkxM30.HgWjVlB9e0rYgX-MCTee16UV5tZ6m-pCXXjwY1cu3b0";
  var SB = null;
  function getSB() {
    if (window.vantageSB) return window.vantageSB;
    if (!SB && window.supabase) { SB = window.supabase.createClient(SUPA_URL, ANON); window.vantageSB = SB; }
    return SB;
  }

  var S = {
    rows: [],            // market_spaces rows (all statuses; filtered at render time)
    loaded: false, loading: false, loadErr: null,
    buildings: [],       // [{id,name,addr,lat,lng}] from vantage-data.json
    bById: {},
    map: null,           // captured Leaflet overview map
    chipLayer: null, chipOn: false,
    open: false,
    f: { minSF: "", maxSF: "", maxRate: "", type: "all", fresh: "all", source: "all", q: "", closed: false }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function todayISO() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fmtSF(n) { return (n == null || !isFinite(Number(n))) ? "—" : Number(n).toLocaleString() + " SF"; }
  function fmtRate(r) {
    var yr = annualRate(r.asking_rate, r.rate_period);
    if (yr == null) return "rate on request";
    return "$" + yr.toFixed(2) + "/SF/yr" + (r.rate_basis ? " " + esc(r.rate_basis) : "");
  }
  function rateTitle(r) {
    if (r.rate_period === "mo" && r.asking_rate != null) return "asking $" + Number(r.asking_rate).toFixed(2) + "/SF/mo (shown annualized)";
    return "";
  }
  function srcBadge(r) {
    if (r.source === "listing-broker" && r.broker_verified) return ["bk", "Broker ✓"];
    switch (r.source) {
      case "costar-alert": return ["cs", "CoStar alert"];
      case "costar-report": return ["cs", "CoStar report"];
      case "flyer": return ["fl", "Flyer"];
      case "listing-broker": return ["bk", "Broker"];
      default: return ["mn", "Manual"];
    }
  }
  function freshBadge(r) {
    var b = freshnessBucket(r.as_of);
    return { fresh: ["f", "Fresh"], aging: ["a", "Aging"], stale: ["s", "Stale"], unknown: ["u", "No date"] }[b];
  }
  function typeLabel(r) { return r.space_type === "sublease" ? "Sublease" : "Direct"; }
  function rowBid(r) { return r._bid || null; }
  function openRows() { return S.rows.filter(function (r) { return r.status === "active" || r.status === "in-lease"; }); }
  function activeRows() { return S.rows.filter(function (r) { return r.status === "active"; }); }

  /* ---------------- CSS ---------------- */
  var cssDone = false;
  function injectCSS() {
    if (cssDone) return; cssDone = true;
    var css =
      ".msp-fab{position:absolute;left:10px;bottom:44px;z-index:610;display:inline-flex;align-items:center;gap:6px;font:600 12px Inter,system-ui,sans-serif;color:#fff;background:var(--building,#1b2a4a);border:0;border-radius:8px;padding:7px 11px;cursor:pointer;box-shadow:0 2px 8px rgba(20,26,38,.25)}" +
      ".msp-fab:hover{filter:brightness(1.12)}" +
      ".msp-panel{position:absolute;left:10px;top:10px;bottom:76px;width:min(350px,calc(100% - 20px));z-index:620;display:none;flex-direction:column;background:var(--paper-2,#fbf9f4);border:1px solid var(--line-2,#d8d3c7);border-radius:12px;box-shadow:0 10px 30px rgba(20,26,38,.22);overflow:hidden}" +
      ".msp-panel.open{display:flex}" +
      ".msp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#e7e3d9);flex:none}" +
      ".msp-title{font:700 13.5px 'Bricolage Grotesque',Inter,sans-serif;color:var(--ink,#1a2230);flex:1}" +
      ".msp-ib{font-size:13px;background:none;border:0;color:var(--ink-faint,#8a92a0);cursor:pointer;line-height:1;padding:3px}" +
      ".msp-ib:hover{color:var(--ink,#1a2230)}" +
      ".msp-filters{padding:9px 12px;border-bottom:1px solid var(--line,#e7e3d9);display:flex;flex-wrap:wrap;gap:6px;flex:none}" +
      ".msp-filters input,.msp-filters select{font:500 11.5px Inter,system-ui,sans-serif;color:var(--ink,#1a2230);background:var(--paper,#fff);border:1px solid var(--line-2,#d8d3c7);border-radius:7px;padding:5px 7px}" +
      ".msp-filters input:focus,.msp-filters select:focus{outline:none;border-color:var(--accent,#2d6e7e)}" +
      ".msp-num{width:64px}" +
      ".msp-q{flex:1;min-width:120px}" +
      ".msp-closed{display:inline-flex;align-items:center;gap:5px;font:500 11px Inter,system-ui,sans-serif;color:var(--ink-soft,#55606f);cursor:pointer}" +
      ".msp-list{flex:1;overflow-y:auto;padding:6px 8px 10px}" +
      ".msp-row{border:1px solid var(--line,#e7e3d9);background:var(--paper,#fff);border-radius:10px;padding:8px 10px;margin-bottom:7px;cursor:pointer}" +
      ".msp-row:hover{border-color:var(--accent,#2d6e7e)}" +
      ".msp-row.closed{opacity:.55}" +
      ".msp-r1{display:flex;justify-content:space-between;gap:8px;align-items:baseline}" +
      ".msp-bn{font:600 12.5px Inter,system-ui,sans-serif;color:var(--ink,#1a2230);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".msp-sf{font:700 11.5px 'JetBrains Mono',monospace;color:var(--ink,#1a2230);flex:none}" +
      ".msp-r2{font:500 11.5px Inter,system-ui,sans-serif;color:var(--ink-soft,#55606f);margin-top:2px}" +
      ".msp-r3{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;align-items:center}" +
      ".msp-badge{font:600 9.5px Inter,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;border-radius:6px;padding:2px 6px;border:1px solid transparent}" +
      ".msp-badge.src-cs{color:#7a5a15;background:#faf0d8;border-color:#ecd9a8}" +
      ".msp-badge.src-bk{color:#1d6e46;background:#e2f3e9;border-color:#bfe3cd}" +
      ".msp-badge.src-fl{color:#6b4f9e;background:#efeaf9;border-color:#d9cdf0}" +
      ".msp-badge.src-mn{color:var(--ink-soft,#55606f);background:var(--paper,#f3efe6);border-color:var(--line-2,#d8d3c7)}" +
      ".msp-badge.fr-f{color:#12694c;background:#dff2ea;border-color:#b5e0cd}" +
      ".msp-badge.fr-a{color:#8a5a12;background:#fbeed6;border-color:#eed6a6}" +
      ".msp-badge.fr-s{color:#93361f;background:#f9e4de;border-color:#eec4b9}" +
      ".msp-badge.fr-u{color:var(--ink-faint,#8a92a0);background:var(--paper,#f3efe6);border-color:var(--line-2,#d8d3c7)}" +
      ".msp-badge.nomatch{color:var(--ink-faint,#8a92a0);background:transparent;border-style:dashed;border-color:var(--line-2,#d8d3c7);text-transform:none;letter-spacing:0}" +
      ".msp-empty{font:400 12px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);padding:18px 10px;line-height:1.5;text-align:center}" +
      ".msp-count{font:600 10.5px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);padding:0 12px 7px}" +
      ".msp-chip{min-width:18px;height:18px;border-radius:999px;background:var(--accent,#2d6e7e);color:#fff;font:700 10.5px Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:0 4px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer}" +
      ".msp-chip:hover{filter:brightness(1.15)}" +
      // dossier block
      ".msp-live-tag{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:#1d6e46;background:#e2f3e9;border:1px solid #bfe3cd;border-radius:6px;padding:3px 7px;font-weight:600}" +
      ".msp-drow{border:1px solid var(--line,#e7e3d9);border-radius:11px;padding:10px 13px;margin-bottom:9px;background:var(--paper,#f3efe6)}" +
      ".msp-drow.closed{opacity:.55}" +
      ".msp-dr1{display:flex;justify-content:space-between;gap:10px;align-items:baseline}" +
      ".msp-ste{font:600 13px Inter,system-ui,sans-serif;color:var(--ink,#1a2230)}" +
      ".msp-dsf{font:700 12px 'JetBrains Mono',monospace;color:var(--ink,#1a2230)}" +
      ".msp-dr2{font:500 12px Inter,system-ui,sans-serif;color:var(--ink-soft,#55606f);margin-top:3px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}" +
      ".msp-acts{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px;align-items:center}" +
      ".msp-acts button{font:600 11px Inter,system-ui,sans-serif;border-radius:7px;padding:5px 10px;cursor:pointer;border:1px solid var(--line-2,#d8d3c7);background:var(--paper-2,#fbf9f4);color:var(--ink-soft,#55606f)}" +
      ".msp-acts button:hover{border-color:var(--accent,#2d6e7e);color:var(--accent,#2d6e7e)}" +
      ".msp-acts select{font:600 11px Inter,system-ui,sans-serif;border-radius:7px;padding:4px 6px;border:1px solid var(--line-2,#d8d3c7);background:var(--paper-2,#fbf9f4);color:var(--ink-soft,#55606f)}" +
      ".msp-note{font:500 10.5px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0)}";
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  /* ---------------- data ---------------- */
  function loadBuildings() {
    if (S.buildings.length) return Promise.resolve();
    return fetch("vantage-data.json").then(function (r) { if (!r.ok) throw new Error("no data file"); return r.json(); })
      .then(function (d) {
        S.buildings = ((d && d.buildings) || []).map(function (b) { return { id: b.id, name: b.name, addr: b.addr, lat: b.lat, lng: b.lng }; })
          .filter(function (b) { return b.id && b.lat != null && b.lng != null; });
        S.bById = {}; S.buildings.forEach(function (b) { S.bById[b.id] = b; });
      })
      .catch(function () { S.buildings = []; S.bById = {}; });
  }

  function matchAll() {
    var sb = getSB();
    S.rows.forEach(function (r) {
      if (r.building_id && S.bById[r.building_id]) { r._bid = r.building_id; return; }
      var b = matchBuilding(r, S.buildings);
      r._bid = b ? b.id : null;
      // prewire future loads: persist the match (fire-and-forget; RLS scopes to our org)
      if (b && !r.building_id && sb && !r._persisted) {
        r._persisted = true;
        try { sb.from("market_spaces").update({ building_id: b.id }).eq("id", r.id).then(function () {}, function () {}); } catch (e) {}
      }
    });
  }

  function ensureData(force) {
    if (S.loading || (S.loaded && !force)) return Promise.resolve();
    var sb = getSB();
    if (!sb) return Promise.resolve();
    S.loading = true; S.loadErr = null; renderDrawer();
    return Promise.all([
      sb.from("market_spaces").select("*").order("as_of", { ascending: false }),
      loadBuildings()
    ]).then(function (out) {
      var res = out[0];
      if (res.error) { S.loadErr = res.error.message || "load failed"; S.rows = []; }
      else S.rows = res.data || [];
      matchAll();
    }).catch(function (e) {
      S.loadErr = (e && e.message) || "load failed"; S.rows = [];
    }).then(function () {
      S.loading = false; S.loaded = true;
      renderAll();
    });
  }

  function updateRow(id, patch) {
    var sb = getSB();
    if (!sb) return Promise.reject(new Error("not signed in"));
    return sb.from("market_spaces").update(patch).eq("id", id).then(function (res) {
      if (res.error) throw res.error;
      S.rows.forEach(function (r) { if (r.id === id) Object.keys(patch).forEach(function (k) { r[k] = patch[k]; }); });
      matchAll(); renderAll();
    });
  }

  /* ---------------- map chips ---------------- */
  if (window.L && window.L.Map && window.L.Map.addInitHook) {
    window.L.Map.addInitHook(function () {
      try {
        if (this._container && this._container.id === "overviewMap") {
          S.map = this;
          this.on("zoomend", syncChipVisibility);
          renderChips();
        }
      } catch (e) {}
    });
  }

  var CHIP_MIN_ZOOM = 14; // below this the app's cluster bubbles own the map — chips would collide
  function syncChipVisibility() {
    if (!S.map || !S.chipLayer) return;
    var want = S.map.getZoom() >= CHIP_MIN_ZOOM;
    var has = S.map.hasLayer(S.chipLayer);
    if (want && !has) S.chipLayer.addTo(S.map);
    else if (!want && has) S.map.removeLayer(S.chipLayer);
  }

  function renderChips() {
    if (!S.map || !window.L) return;
    if (!S.chipLayer) S.chipLayer = window.L.layerGroup();
    S.chipLayer.clearLayers();
    var counts = {};
    activeRows().forEach(function (r) { if (r._bid) counts[r._bid] = (counts[r._bid] || 0) + 1; });
    Object.keys(counts).forEach(function (bid) {
      var b = S.bById[bid]; if (!b) return;
      var n = counts[bid];
      var icon = window.L.divIcon({
        className: "",
        html: '<div class="msp-chip" title="' + n + " tracked space" + (n === 1 ? "" : "s") + ' — click to open">' + n + "</div>",
        iconSize: [20, 20],
        iconAnchor: [-5, 24] // floats just above-right of the app's 18px marker; never covers it
      });
      var m = window.L.marker([b.lat, b.lng], { icon: icon, zIndexOffset: 1500, keyboard: false });
      m.on("click", function () { openBuilding(bid); });
      S.chipLayer.addLayer(m);
    });
    syncChipVisibility();
  }

  // open the building dossier without owning openDetail(): click the market table's own row
  function openBuilding(bid) {
    var tr = document.querySelector('#mktTable tr[data-b="' + String(bid).replace(/"/g, '\\"') + '"]');
    if (tr) { tr.click(); return true; }
    var b = S.bById[bid];
    if (b && S.map) S.map.setView([b.lat, b.lng], 16); // row filtered out — at least go there
    return false;
  }

  function flyToRow(r) {
    var b = r._bid ? S.bById[r._bid] : null;
    if (!b || !S.map || !window.L) return;
    S.map.setView([b.lat, b.lng], Math.max(S.map.getZoom(), 16));
    var n = activeRows().filter(function (x) { return x._bid === b.id; }).length;
    var html = '<div class="pop-nm">' + esc(b.name) + '</div><div class="pop-sub">' + esc(b.addr || "") + " · " + n + " tracked space" + (n === 1 ? "" : "s") + "</div>" +
      '<button id="mspPopOpen" style="margin-top:7px;font:600 12px Inter;color:#2D6E7E;background:none;border:0;cursor:pointer;padding:0">Open building →</button>';
    var pop = window.L.popup({ offset: [0, -10] }).setLatLng([b.lat, b.lng]).setContent(html).openOn(S.map);
    setTimeout(function () { var btn = $("mspPopOpen"); if (btn) btn.onclick = function () { S.map.closePopup(pop); openBuilding(b.id); }; }, 0);
  }

  /* ---------------- drawer ---------------- */
  function mountLauncher() {
    var wrap = $("mktMapWrap");
    if (!wrap || $("mspFab")) return;
    var fab = document.createElement("button");
    fab.id = "mspFab"; fab.className = "msp-fab"; fab.type = "button";
    fab.innerHTML = "▤ Spaces";
    fab.onclick = function () { S.open = !S.open; var p = $("mspPanel"); if (p) p.classList.toggle("open", S.open); if (S.open) ensureData(); };
    wrap.appendChild(fab);

    var panel = document.createElement("div");
    panel.id = "mspPanel"; panel.className = "msp-panel";
    panel.innerHTML =
      '<div class="msp-head"><span class="msp-title">Tracked spaces</span>' +
      '<button class="msp-ib" id="mspRefresh" title="Refresh from Supabase" type="button">⟳</button>' +
      '<button class="msp-ib" id="mspClose" title="Close" type="button">✕</button></div>' +
      '<div class="msp-filters">' +
      '<input class="msp-num" id="mspMinSF" type="number" placeholder="min SF" inputmode="numeric">' +
      '<input class="msp-num" id="mspMaxSF" type="number" placeholder="max SF" inputmode="numeric">' +
      '<input class="msp-num" id="mspMaxRate" type="number" step="0.25" placeholder="max $/yr" title="Max asking rate, $/SF/yr">' +
      '<select id="mspType"><option value="all">Direct + sublease</option><option value="direct">Direct</option><option value="sublease">Sublease</option></select>' +
      '<select id="mspFresh"><option value="all">Any freshness</option><option value="fresh">Fresh (≤30d)</option><option value="aging">Aging (31–90d)</option><option value="stale">Stale (>90d)</option></select>' +
      '<select id="mspSource"><option value="all">Any source</option><option value="costar-alert">CoStar alert</option><option value="costar-report">CoStar report</option><option value="listing-broker">Listing broker</option><option value="flyer">Flyer</option><option value="manual">Manual</option></select>' +
      '<input class="msp-q" id="mspQ" type="search" placeholder="Search building / address…">' +
      '<label class="msp-closed"><input type="checkbox" id="mspClosed"> show closed (leased / withdrawn)</label>' +
      "</div>" +
      '<div class="msp-count" id="mspCount"></div>' +
      '<div class="msp-list" id="mspList"></div>';
    wrap.appendChild(panel);

    $("mspClose").onclick = function () { S.open = false; panel.classList.remove("open"); };
    $("mspRefresh").onclick = function () { ensureData(true); };
    [["mspMinSF", "minSF"], ["mspMaxSF", "maxSF"], ["mspMaxRate", "maxRate"], ["mspQ", "q"]].forEach(function (p) {
      $(p[0]).addEventListener("input", function () { S.f[p[1]] = this.value; renderDrawer(); });
    });
    [["mspType", "type"], ["mspFresh", "fresh"], ["mspSource", "source"]].forEach(function (p) {
      $(p[0]).addEventListener("change", function () { S.f[p[1]] = this.value; renderDrawer(); });
    });
    $("mspClosed").addEventListener("change", function () { S.f.closed = this.checked; renderDrawer(); });
    $("mspList").addEventListener("click", function (e) {
      var row = e.target.closest(".msp-row"); if (!row) return;
      var r = S.rows.filter(function (x) { return x.id === row.getAttribute("data-id"); })[0];
      if (r && r._bid) flyToRow(r); // unmatched rows don't move the map
    });
    renderDrawer();
  }

  function drawerRows() {
    var f = S.f, num = function (v) { var n = Number(v); return v !== "" && isFinite(n) ? n : null; };
    var minSF = num(f.minSF), maxSF = num(f.maxSF), maxRate = num(f.maxRate);
    var base = f.closed ? S.rows : openRows();
    return base.filter(function (r) {
      if (minSF != null && !(Number(r.sf) >= minSF)) return false;
      if (maxSF != null && !(Number(r.sf) <= maxSF)) return false;
      if (maxRate != null) { var yr = annualRate(r.asking_rate, r.rate_period); if (yr == null || yr > maxRate) return false; }
      if (f.type !== "all" && r.space_type !== f.type) return false;
      if (f.fresh !== "all" && freshnessBucket(r.as_of) !== f.fresh) return false;
      if (f.source !== "all" && r.source !== f.source) return false;
      if (f.q) {
        var q = f.q.toLowerCase();
        var hay = ((r.building_name || "") + " " + (r.address || "") + " " + (r.suite || "")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function renderDrawer() {
    var list = $("mspList"), fab = $("mspFab");
    if (fab) fab.innerHTML = "▤ Spaces (" + activeRows().length + ")";
    if (!list) return;
    if (S.loading) { list.innerHTML = '<div class="msp-empty">Loading tracked spaces…</div>'; return; }
    if (S.loadErr) { list.innerHTML = '<div class="msp-empty">Couldn’t load spaces: ' + esc(S.loadErr) + "</div>"; return; }
    if (S.loaded && !S.rows.length) {
      list.innerHTML = '<div class="msp-empty">No tracked spaces yet — CoStar alert emails land here every morning once alerts are set up.</div>';
      var c0 = $("mspCount"); if (c0) c0.textContent = "";
      return;
    }
    var rows = drawerRows();
    var cnt = $("mspCount"); if (cnt) cnt.textContent = rows.length + " space" + (rows.length === 1 ? "" : "s") + (S.f.closed ? " (incl. closed)" : "");
    list.innerHTML = rows.length ? rows.map(function (r) {
      var sb2 = srcBadge(r), fb = freshBadge(r);
      var closed = !(r.status === "active" || r.status === "in-lease");
      var label = r.building_name || r.address || "Unknown building";
      return '<div class="msp-row' + (closed ? " closed" : "") + '" data-id="' + esc(r.id) + '">' +
        '<div class="msp-r1"><span class="msp-bn" title="' + esc(r.address || "") + '">' + esc(label) + '</span><span class="msp-sf">' + fmtSF(r.sf) + "</span></div>" +
        '<div class="msp-r2">' + (r.suite ? "Suite " + esc(r.suite) + " · " : "") + '<span title="' + esc(rateTitle(r)) + '">' + fmtRate(r) + "</span> · " + typeLabel(r) +
          (r.status === "in-lease" ? " · in lease" : (closed ? " · " + esc(r.status) : "")) + "</div>" +
        '<div class="msp-r3"><span class="msp-badge src-' + sb2[0] + '">' + sb2[1] + '</span><span class="msp-badge fr-' + fb[0] + '">' + fb[1] + "</span>" +
        (r._bid ? "" : '<span class="msp-badge nomatch">not in portfolio</span>') + "</div></div>";
    }).join("") : '<div class="msp-empty">No spaces match these filters.</div>';
  }

  /* ---------------- dossier block ---------------- */
  function currentDossierBuilding() {
    var dv = $("detailView");
    if (!dv || !dv.classList.contains("show")) return null;
    var name = ($("dsrName") || {}).textContent || "";
    if (!name) return null;
    for (var i = 0; i < S.buildings.length; i++) if (S.buildings[i].name === name) return S.buildings[i];
    return null;
  }

  function verifyMail(r) {
    var addr = r.address || r.building_name || "";
    var subject = "Availability check — " + addr + (r.suite ? " Suite " + r.suite : "");
    var body = "Hi" + (r.listing_broker ? " " + r.listing_broker.split(" ")[0] : "") + ",\n\n" +
      "Could you confirm whether " + addr + (r.suite ? ", Suite " + r.suite : "") + " is still available, and the current asking rate" + (r.sf ? " for the ~" + Number(r.sf).toLocaleString() + " SF" : "") + "?\n\n" +
      "I'm tracking it for a tenant requirement and want to make sure my information is current.\n\n" +
      "Thank you,\nAndrew Havill\nHavill & Co.";
    if (r.listing_email) {
      location.href = "mailto:" + encodeURIComponent(r.listing_email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      return Promise.resolve("mailed");
    }
    var draft = "To: (no listing email on file)\nSubject: " + subject + "\n\n" + body;
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(draft).then(function () { return "copied"; });
    try {
      var ta = document.createElement("textarea"); ta.value = draft; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      return Promise.resolve("copied");
    } catch (e) { return Promise.reject(e); }
  }

  function renderDossier() {
    var body = document.querySelector("#detailView .dsr-body");
    if (!body) return;
    var sec = $("mspDsec");
    var b = currentDossierBuilding();
    var rows = b ? S.rows.filter(function (r) { return r._bid === b.id; }) : [];
    if (!rows.length) { if (sec) sec.style.display = "none"; return; }
    if (!sec) {
      sec = document.createElement("section");
      sec.className = "dsr-sec"; sec.id = "mspDsec";
      var first = body.querySelector(".dsr-sec"); // the existing "Available spaces" section
      if (first && first.nextSibling) body.insertBefore(sec, first.nextSibling);
      else body.appendChild(sec);
      sec.addEventListener("click", onDossierClick);
      sec.addEventListener("change", onDossierChange);
    }
    sec.style.display = "";
    sec.innerHTML =
      '<div class="dsr-h"><h3 class="display">Tracked spaces</h3><span class="msp-live-tag">Live</span></div>' +
      rows.map(function (r) {
        var sb2 = srcBadge(r), fb = freshBadge(r);
        var closed = !(r.status === "active" || r.status === "in-lease");
        return '<div class="msp-drow' + (closed ? " closed" : "") + '" data-id="' + esc(r.id) + '">' +
          '<div class="msp-dr1"><span class="msp-ste">' + (r.suite ? "Suite " + esc(r.suite) : (r.floor ? "Floor " + esc(r.floor) : "Space")) +
            (r.suite && r.floor ? ' <span class="msp-note">· Floor ' + esc(r.floor) + "</span>" : "") + '</span><span class="msp-dsf">' + fmtSF(r.sf) + "</span></div>" +
          '<div class="msp-dr2"><span title="' + esc(rateTitle(r)) + '">' + fmtRate(r) + "</span><span>· " + typeLabel(r) + "</span>" +
            '<span class="msp-badge src-' + sb2[0] + '">' + sb2[1] + '</span><span class="msp-badge fr-' + fb[0] + '">' + fb[1] + "</span>" +
            (r.listing_broker || r.listing_company ? '<span class="msp-note">' + esc([r.listing_broker, r.listing_company].filter(Boolean).join(", ")) + "</span>" : "") + "</div>" +
          '<div class="msp-acts">' +
            '<button type="button" data-act="verify" title="' + (r.listing_email ? "Email " + esc(r.listing_email) : "No listing email — copies a draft") + '">✉ Verify</button>' +
            '<button type="button" data-act="confirm" title="Mark availability + rate confirmed with the listing broker today">✓ Confirmed</button>' +
            '<select data-act="status" title="Status">' +
              ["active", "in-lease", "leased", "withdrawn"].map(function (st) { return '<option value="' + st + '"' + (r.status === st ? " selected" : "") + ">" + st + "</option>"; }).join("") +
            "</select>" +
            (r.as_of ? '<span class="msp-note">as of ' + esc(r.as_of) + "</span>" : "") +
          "</div></div>";
      }).join("");
  }

  function dossierRow(el) {
    var d = el.closest(".msp-drow"); if (!d) return null;
    var id = d.getAttribute("data-id");
    return S.rows.filter(function (x) { return x.id === id; })[0] || null;
  }
  function onDossierClick(e) {
    var btn = e.target.closest("button[data-act]"); if (!btn) return;
    var r = dossierRow(btn); if (!r) return;
    if (btn.getAttribute("data-act") === "verify") {
      verifyMail(r).then(function (how) {
        if (how === "copied") { var t = btn.textContent; btn.textContent = "✓ Draft copied"; setTimeout(function () { btn.textContent = t; }, 1800); }
      }).catch(function () { alert("Couldn't open a draft — no listing email on file and clipboard is unavailable."); });
      return;
    }
    if (btn.getAttribute("data-act") === "confirm") {
      btn.disabled = true; btn.textContent = "Saving…";
      updateRow(r.id, { broker_verified: true, verified_at: new Date().toISOString(), source: "listing-broker", as_of: todayISO(), status: "active" })
        .catch(function (err) { alert("Couldn't save: " + ((err && err.message) || err)); renderDossier(); });
    }
  }
  function onDossierChange(e) {
    var sel = e.target.closest('select[data-act="status"]'); if (!sel) return;
    var r = dossierRow(sel); if (!r) return;
    var prev = r.status;
    updateRow(r.id, { status: sel.value }).catch(function (err) {
      alert("Couldn't update status: " + ((err && err.message) || err));
      r.status = prev; renderDossier();
    });
  }

  var dossierTimer = null;
  function scheduleDossier() {
    clearTimeout(dossierTimer);
    dossierTimer = setTimeout(function () {
      var dv = $("detailView");
      if (!dv || !dv.classList.contains("show")) return;
      if (!S.loaded && !S.loading) { ensureData(); return; } // renderAll() will draw it once loaded
      renderDossier();
    }, 80);
  }
  function watchDossier() {
    var dv = $("detailView"); if (!dv || dv._mspWatched) return; dv._mspWatched = true;
    new MutationObserver(scheduleDossier).observe(dv, { attributes: true, attributeFilter: ["class"] });
    var nm = $("dsrName");
    if (nm) new MutationObserver(scheduleDossier).observe(nm, { childList: true, characterData: true, subtree: true });
  }

  /* ---------------- glue ---------------- */
  function renderAll() { renderDrawer(); renderChips(); renderDossier(); }

  function onMarketShown() {
    injectCSS();
    mountLauncher();
    ensureData();
  }

  // zero-touch integration: ride the app's own view-switch globals (van.js pattern)
  var _showModule = window.showModule;
  if (typeof _showModule === "function") {
    window.showModule = function (m) {
      var out = _showModule.apply(this, arguments);
      try { if (m === "market") onMarketShown(); } catch (e) {}
      return out;
    };
  }
  var _showPortfolio = window.showPortfolio;
  if (typeof _showPortfolio === "function") {
    window.showPortfolio = function () {
      var out = _showPortfolio.apply(this, arguments);
      try { onMarketShown(); } catch (e) {}
      return out;
    };
  }

  function init() { injectCSS(); watchDossier(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
