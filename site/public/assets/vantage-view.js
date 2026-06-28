/* ============================================================================
   Vantage — shared view engine (VV)
   ----------------------------------------------------------------------------
   The single source of truth for rendering a building DOSSIER (hero, specs,
   spaces, tenants, neighborhood + amenity map, leasing, media) plus the
   amenity-map clustering, scoring, Street View, and the team-COMMUTE client.

   It is deliberately DATA-AGNOSTIC and DOM-ID-driven: call VV.setData(...) with
   {buildings, categories, industries}, then VV.openDossier(id) to paint the
   dossier into the standard element IDs (dHero, dSpecs, dSuites, detailMap, …).

   The Client Viewer (client.html) uses this directly. The Cockpit (index.html)
   can converge onto it too, since these are exactly its dossier functions
   lifted out and namespaced. Nothing here is internal-only — it renders the
   client-facing dossier and never the competition lens or pipeline notes.

   Commute calls go through VV.callCommute, which injects an auth blob
   (VV.setCommuteAuth) so the guarded backend accepts them.
   ========================================================================== */
window.VV = (function () {
  "use strict";

  // ---- state ----------------------------------------------------------------
  var BUILDINGS = [], CATEGORIES = [], COLOR = { building: "#1B2A4A" }, weights = {};
  var IND = {}, IORDER = [];
  var RADIUS = 1200;                       // meters considered "walkable"
  var DEFAULT_WEIGHT = 3;
  var TILE = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  var ATTR = "&copy; OpenStreetMap &copy; CARTO";

  var detailMap, detailLayer, baseLight, baseSat, amenCluster;
  var curB = null, active = {}, selected = null, amenMarkers = {};
  var commuteAuth = null;                  // {slug,passcode} or {brokerSecret}
  var GOOGLE_EMBED_KEY = "";               // optional inline Street View key

  var DEFAULT_CATEGORIES = [
    { key: "coffee", label: "Coffee", color: "#A6764B", weighted: true },
    { key: "dining", label: "Dining", color: "#C25E5E", weighted: true },
    { key: "fitness", label: "Fitness", color: "#5E8C6A", weighted: true },
    { key: "grocery", label: "Grocery", color: "#6E84B8", weighted: true },
    { key: "transit", label: "Transit", color: "#7D6FB0", weighted: true }
  ];

  // ---- helpers --------------------------------------------------------------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function initials(s) { return String(s || "").split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return (w[0] || "").toUpperCase(); }).join(""); }
  function gmapsPlace(name, lat, lng) { return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent((name || "") + " " + lat + "," + lng); }
  function gmapsPano(lat, lng) { return "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + lat + "," + lng; }
  function dist(aLat, aLng, bLat, bLng) {
    var cos = Math.cos(aLat * Math.PI / 180);
    var dy = (bLat - aLat) * 110574, dx = (bLng - aLng) * 111320 * cos;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function byId(id) { return document.getElementById(id); }
  function weightedCats() { return CATEGORIES.filter(function (c) { return c.weighted; }); }

  var PHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  var MAIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var FILE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

  // ---- data + scoring -------------------------------------------------------
  function buildCategories(list) {
    CATEGORIES = ((list && list.length) ? list : DEFAULT_CATEGORIES).map(function (c) {
      return { key: c.key, label: c.label || c.key, color: c.color || "#8A93A0", weighted: !!c.weighted };
    });
    COLOR = { building: "#1B2A4A" };
    CATEGORIES.forEach(function (c) { COLOR[c.key] = c.color; });
    weights = {};
    CATEGORIES.forEach(function (c) { if (c.weighted) weights[c.key] = DEFAULT_WEIGHT; });
  }
  function indColor(i, n) { return "hsl(" + Math.round((i * 360 / n + 8) % 360) + ",52%,46%)"; }
  function buildIndustries(list) {
    IORDER = (list && list.length ? list : []).slice();
    IND = {}; var n = IORDER.length || 1;
    IORDER.forEach(function (name, i) { IND[name] = { label: name, color: indColor(i, n) }; });
  }
  function indOf(k) { return IND[k] || { label: k, color: "#8A93A0" }; }

  function computeAmenities() {
    BUILDINGS.forEach(function (b) {
      b.places = (b.amen || []).map(function (a) {
        var d = dist(b.lat, b.lng, a[2], a[3]);
        return { n: a[0], cat: a[1], lat: a[2], lng: a[3], r: a[4], sub: a[5], dist: d, walk: Math.max(1, Math.round(d / 80)) };
      }).filter(function (p) { return p.dist <= RADIUS; }).sort(function (x, y) { return x.dist - y.dist; });
      b.cscore = {};
      weightedCats().forEach(function (c) {
        var cat = c.key, raw = 0;
        b.places.forEach(function (p) { if (p.cat === cat) { var pf = Math.min(1, Math.max(0.15, 1 - p.dist / RADIUS)); raw += (p.r / 5) * pf; } });
        b.cscore[cat] = 10 * (1 - Math.exp(-raw / 4));
      });
    });
  }
  function computeTenants() {
    BUILDINGS.forEach(function (b) {
      b.tenants = b.tenants || [];
      b.total = b.tenants.length; b.byInd = {};
      IORDER.forEach(function (k) { b.byInd[k] = 0; });
      b.tenants.forEach(function (t) { b.byInd[t[1]] = (b.byInd[t[1]] || 0) + 1; });
    });
  }
  function matchScore(b) {
    var sum = 0, acc = 0;
    weightedCats().forEach(function (c) { var w = weights[c.key] || 0; sum += w; acc += (b.cscore[c.key] || 0) * w; });
    if (sum === 0) return 0;
    return Math.round((acc / sum) * 10);
  }

  // ---- map icons ------------------------------------------------------------
  function amenDot(color) { return L.divIcon({ className: "", iconSize: [14, 14], iconAnchor: [7, 7], html: '<div style="width:14px;height:14px;border-radius:50%;background:' + color + ';border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35)"></div>' }); }
  function clusterIcon(cluster) {
    var n = cluster.getChildCount(), size = n < 10 ? 34 : n < 40 ? 40 : 46;
    return L.divIcon({ html: '<div class="cmcluster" style="width:' + size + 'px;height:' + size + 'px">' + n + "</div>", className: "", iconSize: [size, size] });
  }
  function buildingIcon(rank) {
    return L.divIcon({ className: "", html: '<div style="width:30px;height:30px;border-radius:50%;background:' + COLOR.building + ';color:#fff;display:flex;align-items:center;justify-content:center;font:700 14px Bricolage Grotesque,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3);border:2px solid #fff">' + (rank || "") + "</div>", iconSize: [30, 30], iconAnchor: [15, 15] });
  }

  // ---- detail map -----------------------------------------------------------
  function initDetailMap() {
    detailMap = L.map("detailMap", { zoomControl: true, scrollWheelZoom: true }).setView([34.029, -118.471], 15);
    baseLight = L.tileLayer(TILE, { attribution: ATTR, subdomains: "abcd", maxZoom: 20 });
    baseSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics", maxZoom: 20 });
    baseLight.addTo(detailMap);
    detailLayer = L.layerGroup().addTo(detailMap);
    amenCluster = L.markerClusterGroup({ iconCreateFunction: clusterIcon, maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true, chunkedLoading: true });
    detailMap.addLayer(amenCluster);
  }
  function setBase(which) {
    if (!detailMap) return;
    if (which === "sat") { detailMap.removeLayer(baseLight); baseSat.addTo(detailMap); }
    else { detailMap.removeLayer(baseSat); baseLight.addTo(detailMap); }
    detailLayer.bringToFront && detailLayer.bringToFront();
    var tog = byId("layertog"); if (tog) tog.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.layer === which); });
  }
  function svButton(el, lat, lng, label) {
    var b = document.createElement("button");
    b.className = "pop-sv"; b.textContent = "👁 Look around here";
    b.onclick = function () { openSV(lat, lng, label); };
    el.appendChild(b);
  }
  function renderDetailMap() {
    detailLayer.clearLayers(); amenCluster.clearLayers(); amenMarkers = {};
    var bIcon = L.divIcon({ className: "", html: '<div style="width:26px;height:26px;border-radius:50%;background:' + COLOR.building + ';border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)"></div>', iconSize: [26, 26], iconAnchor: [13, 13] });
    var bm = L.marker([curB.lat, curB.lng], { icon: bIcon, zIndexOffset: 1000 }).addTo(detailLayer)
      .bindPopup('<div class="pop-nm">' + esc(curB.name) + '</div><div class="pop-sub">' + esc(curB.addr) + "</div>" +
        '<a class="pop-map" href="' + gmapsPlace(curB.name, curB.lat, curB.lng) + '" target="_blank" rel="noopener">Open in Google Maps ↗</a>');
    bm.on("popupopen", function (e) { svButton(e.popup.getElement().querySelector(".leaflet-popup-content"), curB.lat, curB.lng, curB.name); });
    var add = [];
    curB.places.forEach(function (p) {
      var m = L.marker([p.lat, p.lng], { icon: amenDot(COLOR[p.cat]) });
      m._cat = p.cat;
      m.bindPopup('<div class="pop-nm">' + esc(p.n) + '</div><div class="pop-sub">' + esc(p.sub) + " · " + p.walk + " min walk · ★" + p.r.toFixed(1) + "</div>" +
        '<a class="pop-map" href="' + gmapsPlace(p.n, p.lat, p.lng) + '" target="_blank" rel="noopener">Open in Google Maps ↗</a>');
      m.on("popupopen", function (e) { svButton(e.popup.getElement().querySelector(".leaflet-popup-content"), p.lat, p.lng, p.n); });
      m.on("click", function () { selectPlace(p.n); });
      amenMarkers[p.n] = m;
      if (active[p.cat]) add.push(m);
    });
    amenCluster.addLayers(add);
  }
  function fitDetail() {
    var pts = [[curB.lat, curB.lng]];
    curB.places.forEach(function (p) { if (active[p.cat]) pts.push([p.lat, p.lng]); });
    if (pts.length > 1) detailMap.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
    else detailMap.setView([curB.lat, curB.lng], 15);
  }
  function renderList() {
    var list = byId("dList"); list.innerHTML = ""; var n = 0;
    curB.places.forEach(function (p) {
      if (!active[p.cat]) return; n++;
      var row = document.createElement("div");
      row.className = "place"; row.tabIndex = 0;
      row.innerHTML = '<span class="cat" style="background:' + COLOR[p.cat] + '"></span>' +
        '<div class="info"><div class="nm">' + esc(p.n) + '</div><div class="sub">' + esc(p.sub) + "</div>" +
        '<a class="amap" href="' + gmapsPlace(p.n, p.lat, p.lng) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">View on Google Maps ↗</a></div>' +
        '<div class="right"><div class="walk">' + p.walk + ' min</div><div class="rt"><span class="star">★</span>' + p.r.toFixed(1) + "</div></div>";
      row.onclick = function () { selectPlace(p.n); };
      row.onkeydown = function (e) { if (e.key === "Enter") selectPlace(p.n); };
      if (selected === p.n) row.classList.add("sel");
      row.dataset.nm = p.n;
      list.appendChild(row);
    });
    var c = byId("dCount"); if (c) c.textContent = n + (n === 1 ? " place" : " places");
  }
  function selectPlace(nm) {
    selected = (selected === nm ? null : nm);
    document.querySelectorAll("#dList .place").forEach(function (r) { r.classList.toggle("sel", r.dataset.nm === selected); });
    if (selected && amenMarkers[selected]) {
      var m = amenMarkers[selected];
      if (amenCluster.hasLayer(m)) amenCluster.zoomToShowLayer(m, function () { m.openPopup(); });
      else { detailMap.setView(m.getLatLng(), 16, { animate: true }); m.openPopup(); }
      var r = document.querySelector('#dList .place[data-nm="' + (window.CSS && CSS.escape ? CSS.escape(selected) : selected) + '"]');
      if (r) r.scrollIntoView({ block: "nearest" });
    }
  }

  // ---- amenity category filter (dropdown) -----------------------------------
  function allCatsActive() { var o = {}; CATEGORIES.forEach(function (c) { o[c.key] = true; }); return o; }
  function presentCats() { var s = {}; ((curB && curB.places) || []).forEach(function (p) { s[p.cat] = true; }); return s; }
  function presentCatList() {
    var counts = {}; ((curB && curB.places) || []).forEach(function (p) { counts[p.cat] = (counts[p.cat] || 0) + 1; });
    return CATEGORIES.filter(function (c) { return counts[c.key]; }).map(function (c) { return { key: c.key, label: c.label, color: c.color, count: counts[c.key] }; });
  }
  function applyAmenFilter() {
    var addList = [], rmList = [];
    Object.keys(amenMarkers).forEach(function (nm) {
      var m = amenMarkers[nm], on = active[m._cat], has = amenCluster.hasLayer(m);
      if (on && !has) addList.push(m); else if (!on && has) rmList.push(m);
    });
    rmList.forEach(function (m) { amenCluster.removeLayer(m); });
    if (addList.length) amenCluster.addLayers(addList);
    renderList(); fitDetail();
  }
  function syncCatAll(list) {
    list = list || presentCatList();
    var on = list.filter(function (c) { return active[c.key]; }).length;
    var all = byId("catDdAll"); if (!all) return;
    all.checked = (list.length > 0 && on === list.length);
    all.indeterminate = (on > 0 && on < list.length);
  }
  function updateCatLabel(list) {
    list = list || presentCatList();
    var sel = list.filter(function (c) { return active[c.key]; }), el = byId("catDdLabel"); if (!el) return;
    if (!list.length) el.textContent = "No amenities";
    else if (sel.length === list.length) el.textContent = "All categories";
    else if (sel.length === 0) el.textContent = "None shown";
    else if (sel.length <= 2) el.textContent = sel.map(function (c) { return c.label; }).join(", ");
    else el.textContent = sel.length + " of " + list.length + " categories";
  }
  function renderFilters() {
    var list = presentCatList(), el = byId("catDdList"); if (!el) return;
    el.innerHTML = list.map(function (c) {
      return '<label class="catdd-row"><input type="checkbox" data-cat="' + c.key + '"' + (active[c.key] ? " checked" : "") + ">" +
        '<span class="sw" style="background:' + c.color + '"></span><span class="catdd-name">' + esc(c.label) + '</span><span class="catdd-ct">' + c.count + "</span></label>";
    }).join("");
    syncCatAll(list); updateCatLabel(list);
  }
  function wireCatDd() {
    var dd = byId("catDd"), btn = byId("catDdBtn"); if (!dd || !btn || btn._wired) return; btn._wired = true;
    btn.addEventListener("click", function (e) { e.stopPropagation(); var open = dd.classList.toggle("open"); btn.setAttribute("aria-expanded", open); });
    byId("catDdAll").addEventListener("change", function () { var on = this.checked; presentCatList().forEach(function (c) { active[c.key] = on; }); renderFilters(); applyAmenFilter(); });
    byId("catDdList").addEventListener("change", function (e) {
      var inp = e.target.closest("input[type=checkbox]"); if (!inp) return;
      active[inp.getAttribute("data-cat")] = inp.checked; syncCatAll(); updateCatLabel(); applyAmenFilter();
    });
    document.addEventListener("click", function (e) { if (!e.target.closest("#catDd")) dd.classList.remove("open"); });
  }
  function renderLegend() {
    var pr = presentCats(), el = byId("detailLegend"); if (!el) return;
    var html = '<span><i style="background:' + COLOR.building + '"></i>Building</span>';
    CATEGORIES.forEach(function (c) { if (pr[c.key]) html += '<span><i style="background:' + c.color + '"></i>' + esc(c.label) + "</span>"; });
    el.innerHTML = html;
  }

  // ---- access block ---------------------------------------------------------
  var ACCESS_LABELS = { freeway: "Freeways", airport: "Airports", transit: "Transit", rail: "Rail", bike: "Bike", walk: "Walk Score", rideshare: "Rideshare" };
  var ACCESS_BUCKETS = [{ key: "am", label: "AM" }, { key: "mid", label: "Midday" }, { key: "pm", label: "PM" }];
  var accessBucket = "am";
  function renderAccess() {
    var el = byId("dAccess"); if (!el) return;
    var a = (curB && curB.access) || null, drive = (curB && curB.drive) || null;
    var hasA = a && Object.keys(a).length, hasD = drive && drive.dests && drive.dests.length;
    if (!hasA && !hasD) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "block";
    var html = '<div class="acc-head"><h4>Access &amp; connectivity</h4>';
    if (hasD) html += '<div class="acc-toggle">' + ACCESS_BUCKETS.map(function (b) { return '<button type="button" data-bk="' + b.key + '"' + (b.key === accessBucket ? ' class="on"' : "") + ">" + b.label + "</button>"; }).join("") + "</div>";
    html += "</div>";
    if (hasD) html += drive.dests.map(function (d) { var m = d.min && d.min[accessBucket]; return '<div class="arow"><span class="ak">' + esc(d.label) + '</span><span class="av">' + (m != null ? Math.round(m) + " min" : "—") + "</span></div>"; }).join("");
    if (hasA) html += Object.keys(a).map(function (k) { var lab = ACCESS_LABELS[k] || k; return '<div class="arow"><span class="ak">' + esc(lab) + '</span><span class="av">' + esc(a[k]) + "</span></div>"; }).join("");
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll(".acc-toggle button"), function (btn) { btn.onclick = function () { accessBucket = btn.getAttribute("data-bk"); renderAccess(); }; });
  }

  // ---- dossier sections -----------------------------------------------------
  function renderHero() {
    var b = curB, hero = byId("dHero"); if (!hero) return;
    var ph = (b.photos || []).filter(function (p) { return p && p.url; });
    var eyebrow = [(b["class"] ? "Class " + b["class"] : ""), b.submarket].filter(Boolean).join(" · ");
    var chips = "";
    if (b.avail) chips += '<span class="hchip">' + esc(b.avail) + " SF available</span>";
    if (b.rent) chips += '<span class="hchip">' + esc(b.rent) + "</span>";
    chips += '<span class="hchip"><b>' + matchScore(b) + "</b>match</span>";
    hero.innerHTML =
      '<div class="hero-ph"><span class="hero-mono">' + esc(initials(b.name)) + "</span></div>" +
      (ph.length ? '<img class="hero-img" src="' + esc(ph[0].url) + '" alt="' + esc(b.name) + '" onerror="this.remove()">' : "") +
      '<div class="hero-grad"></div>' +
      '<div class="hero-overlay"><div>' +
      (eyebrow ? '<div class="hero-eyebrow">' + esc(eyebrow) + "</div>" : "") +
      '<div class="hero-name">' + esc(b.name) + "</div>" +
      '<div class="hero-addr">' + esc(b.addr) + "</div>" +
      '<div class="hero-chips">' + chips + "</div>" +
      "</div></div>";
  }
  function renderSpecs() {
    var b = curB, cells = [];
    function add(l, v) { if (v !== undefined && v !== null && v !== "") cells.push('<div class="dsr-spec"><div class="l">' + l + '</div><div class="v">' + esc(v) + "</div></div>"); }
    add("Class", b["class"]); add("RBA", b.size); add("Built", b.yearBuilt); add("Renovated", b.renovated);
    add("Floors", b.floors); add("Floor plate", b.floorPlate); add("Parking", b.parking);
    var el = byId("dSpecs"); if (el) el.innerHTML = cells.join("");
  }
  function renderLeaseBand() {
    var b = curB, wrap = byId("dLeaseWrap"), sec = byId("dLeaseSec"), blocks = []; if (!wrap || !sec) return;
    var lc = b.leasingContact;
    if (b.owner || b.propertyManager || (lc && (lc.name || lc.company || lc.phone || lc.email))) {
      var rows = "";
      if (b.owner) rows += '<div class="lz-row"><span class="k">Owner</span><span class="v">' + esc(b.owner) + "</span></div>";
      if (b.propertyManager) rows += '<div class="lz-row"><span class="k">Property manager</span><span class="v">' + esc(b.propertyManager) + "</span></div>";
      var contact = "";
      if (lc && (lc.name || lc.company || lc.phone || lc.email)) {
        contact = '<div class="lz-contact">' +
          (lc.name ? '<div class="nm">' + esc(lc.name) + "</div>" : "") +
          (lc.company ? '<div class="co">' + esc(lc.company) + "</div>" : "") +
          (lc.phone ? '<a href="tel:' + esc(String(lc.phone).replace(/[^0-9+]/g, "")) + '">' + PHONE_SVG + esc(lc.phone) + "</a>" : "") +
          (lc.email ? '<a href="mailto:' + esc(lc.email) + '">' + MAIL_SVG + esc(lc.email) + "</a>" : "") +
          "</div>";
      }
      blocks.push('<div class="dcard"><h4>Landlord &amp; leasing</h4>' + rows + contact + "</div>");
    }
    if (b.features && b.features.length) blocks.push('<div class="dcard"><h4>Building features</h4><div class="feat">' + b.features.map(function (f) { return "<span>" + CHECK_SVG + esc(f) + "</span>"; }).join("") + "</div></div>");
    if (!blocks.length) { sec.style.display = "none"; return; }
    sec.style.display = "";
    wrap.classList.toggle("single", blocks.length <= 1);
    wrap.innerHTML = blocks.join("");
  }
  var lbPhotos = [], lbIndex = 0;
  function renderMediaBand() {
    var b = curB, sec = byId("dMediaSec"); if (!sec) return;
    var photos = (b.photos || []).filter(function (p) { return p && p.url; });
    var plans = (b.floorplans || []).filter(function (p) { return p && p.url; });
    lbPhotos = photos;
    var html = "";
    if (photos.length) html += '<div class="dsr-h"><h3 class="display">Photos</h3></div><div class="gal">' + photos.map(function (p, i) { return '<div class="thumb" data-i="' + i + '"><img src="' + esc(p.url) + '" alt="' + esc(p.caption || b.name) + '" onerror="this.closest(\'.thumb\').style.display=\'none\'">' + (p.caption ? '<div class="cap">' + esc(p.caption) + "</div>" : "") + "</div>"; }).join("") + "</div>";
    if (plans.length) html += '<div class="dsr-h" style="margin-top:24px"><h3 class="display">Floor plans</h3></div><div class="plans">' + plans.map(function (p) { return '<a class="plan" href="' + esc(p.url) + '" target="_blank" rel="noopener"><span class="ic">' + FILE_SVG + '</span><span class="pl">' + esc(p.label || "Floor plan") + '</span><span class="go">Open ↗</span></a>'; }).join("") + "</div>";
    if (!html) { sec.style.display = "none"; return; }
    sec.style.display = ""; sec.innerHTML = html;
    Array.prototype.forEach.call(sec.querySelectorAll(".gal .thumb"), function (t) { t.onclick = function () { openLightbox(+t.getAttribute("data-i")); }; });
  }
  function openLightbox(i) { if (!lbPhotos.length) return; lbIndex = i; lbShow(); byId("lightbox").classList.add("open"); }
  function lbShow() { var p = lbPhotos[lbIndex]; if (!p) return; byId("lbImg").src = p.url; byId("lbCap").textContent = p.caption || ""; }
  function lbClose() { byId("lightbox").classList.remove("open"); byId("lbImg").src = ""; }
  function lbStep(d) { if (!lbPhotos.length) return; lbIndex = (lbIndex + d + lbPhotos.length) % lbPhotos.length; lbShow(); }
  function wireLightbox() {
    if (!byId("lightbox") || byId("lightbox")._wired) return; byId("lightbox")._wired = true;
    byId("lbX").addEventListener("click", lbClose);
    byId("lbPrev").addEventListener("click", function (e) { e.stopPropagation(); lbStep(-1); });
    byId("lbNext").addEventListener("click", function (e) { e.stopPropagation(); lbStep(1); });
    byId("lightbox").addEventListener("click", function (e) { if (e.target.id === "lightbox") lbClose(); });
    document.addEventListener("keydown", function (e) { if (!byId("lightbox").classList.contains("open")) return; if (e.key === "Escape") lbClose(); else if (e.key === "ArrowLeft") lbStep(-1); else if (e.key === "ArrowRight") lbStep(1); });
  }

  // ---- Street View ----------------------------------------------------------
  var svState = null;
  function openSV(lat, lng, label) {
    svState = { lat: lat, lng: lng, label: label };
    if (byId("svTitle")) byId("svTitle").textContent = label || "Street View";
    if (byId("svLoc")) byId("svLoc").textContent = lat.toFixed(5) + ", " + lng.toFixed(5);
    var body = byId("svBody"); if (!body) return;
    if (GOOGLE_EMBED_KEY) {
      body.innerHTML = '<iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen src="https://www.google.com/maps/embed/v1/streetview?key=' + encodeURIComponent(GOOGLE_EMBED_KEY) + "&location=" + lat + "," + lng + '&heading=210&pitch=10&fov=90"></iframe>';
    } else {
      body.innerHTML = '<div class="svempty"><h4>Look around ' + (label ? '"' + esc(label) + '"' : "this spot") + "</h4>" +
        "<p>Street View opens in Google Maps in a new tab — fully interactive, no setup needed.</p>" +
        '<button class="open-g" id="svGo"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path></svg>Open Street View in Google Maps</button></div>';
      byId("svGo").onclick = function () { window.open(gmapsPano(lat, lng), "_blank", "noopener"); };
    }
    byId("svPanel").classList.add("open");
  }
  function closeSV() { if (byId("svPanel")) byId("svPanel").classList.remove("open"); if (byId("svBody")) byId("svBody").innerHTML = ""; }
  function wireSV() {
    if (byId("layertog") && !byId("layertog")._wired) { byId("layertog")._wired = true; byId("layertog").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setBase(b.dataset.layer); }); }
    if (byId("svOpenBtn") && !byId("svOpenBtn")._wired) { byId("svOpenBtn")._wired = true; byId("svOpenBtn").addEventListener("click", function () { if (curB) openSV(curB.lat, curB.lng, curB.name); }); }
    if (byId("svClose") && !byId("svClose")._wired) { byId("svClose")._wired = true; byId("svClose").addEventListener("click", closeSV); }
    if (byId("svPop") && !byId("svPop")._wired) { byId("svPop")._wired = true; byId("svPop").addEventListener("click", function () { if (svState) window.open(gmapsPano(svState.lat, svState.lng), "_blank", "noopener"); }); }
  }

  // ---- public: open a dossier ----------------------------------------------
  function openDossier(id) {
    curB = BUILDINGS.filter(function (b) { return b.id === id; })[0];
    if (!curB) return null;
    if (byId("dsrName")) byId("dsrName").textContent = curB.name;
    renderHero(); renderSpecs();
    if (byId("dSuites")) byId("dSuites").innerHTML = (curB.suites || []).map(function (s) {
      return '<div class="suite"><div class="r1"><span class="ste">' + esc(s[0]) + '</span><span class="sf">' + esc(s[1]) + '</span></div><div class="r2"><span class="meta">' + esc(s[2]) + '</span><span class="rent">' + esc(s[3]) + "</span></div></div>";
    }).join("");
    if (byId("dScores")) byId("dScores").innerHTML = weightedCats().map(function (c) {
      return '<div class="scorechip"><div class="n" style="color:' + c.color + '">' + (curB.cscore[c.key] || 0).toFixed(1) + '</div><div class="l">' + esc(c.label) + "</div></div>";
    }).join("");
    renderAccess();
    if (byId("dRead")) byId("dRead").textContent = curB.read || "";
    if (byId("dTenants")) byId("dTenants").innerHTML = (curB.tenants && curB.tenants.length) ? curB.tenants.map(function (t) {
      var ind = indOf(t[1]);
      return '<div class="tn"><span class="tn-dot" style="background:' + ind.color + '"></span><span class="tn-nm">' + esc(t[0]) + '</span><span class="tn-ind">' + esc(ind.label) + "</span></div>";
    }).join("") : '<div class="tn-empty">No tenant roster on file yet.</div>';

    active = allCatsActive(); selected = null;
    if (!detailMap) initDetailMap();
    wireCatDd(); wireSV(); wireLightbox();
    closeSV(); setBase("map");
    renderFilters(); renderDetailMap(); renderLegend(); renderList();
    renderLeaseBand(); renderMediaBand();
    setTimeout(function () { if (detailMap) { detailMap.invalidateSize(); fitDetail(); } }, 80);
    return curB;
  }

  // ---- commute client (auth-injected) --------------------------------------
  function callCommute(payload) {
    if (commuteAuth) { for (var k in commuteAuth) if (commuteAuth.hasOwnProperty(k)) payload[k] = commuteAuth[k]; }
    return fetch("/.netlify/functions/commute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (res) { return res.text().then(function (txt) { var data = null; try { data = JSON.parse(txt); } catch (e) {} if (!res.ok) throw new Error((data && data.error) || ("Server error " + res.status)); return data; }); });
  }
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); var n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  function cmColor(min) { if (min == null || isNaN(min)) return "#B8BEC8"; var t = Math.max(0, Math.min(1, (min - 10) / 35)); return "hsl(" + Math.round(140 * (1 - t)) + ",58%,45%)"; }

  // ---- public API -----------------------------------------------------------
  function setData(data) {
    data = data || {};
    BUILDINGS = (data.buildings || []).slice();
    buildCategories(data.categories);
    buildIndustries(data.industries);
    computeAmenities();
    computeTenants();
    return BUILDINGS;
  }

  return {
    setData: setData,
    openDossier: openDossier,
    get buildings() { return BUILDINGS; },
    get categories() { return CATEGORIES; },
    matchScore: matchScore,
    weightedCats: weightedCats,
    COLOR: function () { return COLOR; },
    indOf: indOf,
    TILE: TILE, ATTR: ATTR,
    buildingIcon: buildingIcon,
    invalidateMap: function () { if (detailMap) detailMap.invalidateSize(); },
    setCommuteAuth: function (a) { commuteAuth = a; },
    callCommute: callCommute,
    median: median, cmColor: cmColor, esc: esc, gmapsPlace: gmapsPlace,
    dests: function () { return BUILDINGS.map(function (b) { return { id: b.id, name: b.name, submarket: b.submarket, lat: b.lat, lng: b.lng }; }); }
  };
})();
