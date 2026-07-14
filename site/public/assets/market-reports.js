// Market → Reports — quarterly brokerage research library (broker-only).
//
// The broker uploads the big brokerages' published quarterly market reports
// (CBRE Figures, JLL Market Dynamics, Cushman & Wakefield MarketBeat,
// Colliers, Newmark, Savills, Lee & Associates, Kidder Mathews, ...);
// market-report-extract (Netlify fn) reads the PDF with Claude and returns the
// headline statistics + submarket table + key takeaways; the broker reviews
// and edits everything here; save writes ONE org-scoped market_reports row
// through window.vantageSB (RLS) — re-importing the same brokerage/market/
// product/quarter updates the existing row (dedup_key).
//
// Self-contained like assets/van.js: owns the #reportsView sub-view, injects
// its own .mr- CSS (brand tokens with fallbacks), and wraps the sibling
// show* functions so entering any other Market sub-view hides this one.
// index.html only carries the nav button, the empty <section>, the marketSub
// dispatch line, and this script tag.
//
// SOURCING: these are the brokerages' own published research PDFs — public
// research, not CoStar exports — kept behind the broker login all the same.
(function () {
  "use strict";

  var ORG_ID = "00000000-0000-0000-0000-000000000001";   // Havill & Co. (same constant as report-import.js)
  var FN = "/.netlify/functions/market-report-extract-background";
  var PRODUCTS = [["office", "Office"], ["industrial", "Industrial"], ["retail", "Retail"],
                  ["flex", "Flex"], ["lab", "Lab"], ["medical", "Medical"], ["mixed", "Mixed"]];

  /* ================= CSS (injected; .mr- prefixed, brand vars w/ fallbacks) ================= */
  var CSS =
    ".mrep-v{display:none}.mrep-v.show{display:block;padding:22px 26px 40px;max-width:1120px}" +
    ".mr-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px}" +
    ".mr-h1{font:700 21px/1.2 'Fraunces',Georgia,serif;color:var(--ink,#1A2230)}" +
    ".mr-sub{font:13px Inter;color:var(--ink-soft,#55606F);margin-top:4px;max-width:640px}" +
    ".mr-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 16px}" +
    ".mr-sel{font:600 12.5px Inter;color:var(--ink,#1A2230);background:var(--paper-2,#FCFBF8);border:1px solid var(--line-2,#D2CCBF);border-radius:9px;padding:7px 10px}" +
    ".mr-qh{font:700 13px Inter;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);margin:22px 0 10px;display:flex;align-items:center;gap:10px}" +
    ".mr-qh:first-of-type{margin-top:6px}" +
    ".mr-qh::after{content:'';flex:1;height:1px;background:var(--line,#E2DDD2)}" +
    ".mr-card{background:var(--paper-2,#FCFBF8);border:1px solid var(--line,#E2DDD2);border-radius:14px;box-shadow:var(--shadow,0 1px 2px rgba(26,34,48,.06));padding:16px 18px;margin-bottom:14px}" +
    ".mr-top{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}" +
    ".mr-brok{font:700 13px Inter;color:#fff;background:var(--building,#1B2A4A);border-radius:7px;padding:5px 10px;white-space:nowrap}" +
    ".mr-title{flex:1;min-width:220px}" +
    ".mr-title b{font:600 14.5px Inter;color:var(--ink,#1A2230)}" +
    ".mr-meta{font:12px Inter;color:var(--ink-faint,#8A93A0);margin-top:2px}" +
    ".mr-chip{font:600 11px Inter;color:var(--accent,#2D6E7E);background:rgba(45,110,126,.08);border:1px solid rgba(45,110,126,.25);border-radius:999px;padding:3px 9px;text-transform:capitalize}" +
    ".mr-del{font:600 11.5px Inter;color:var(--ink-faint,#8A93A0);background:none;border:1px solid var(--line-2,#D2CCBF);border-radius:8px;padding:4px 9px;cursor:pointer}" +
    ".mr-del:hover{color:var(--dining,#C9543F);border-color:var(--dining,#C9543F)}" +
    ".mr-del.arm{color:#fff;background:var(--dining,#C9543F);border-color:var(--dining,#C9543F)}" +
    ".mr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin:14px 0 4px}" +
    ".mr-stat{background:var(--paper,#F7F5F0);border:1px solid var(--line,#E2DDD2);border-radius:10px;padding:10px 12px}" +
    ".mr-stat .k{font:600 10.5px Inter;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-faint,#8A93A0)}" +
    ".mr-stat .v{font:700 17px Inter;color:var(--ink,#1A2230);margin-top:3px}" +
    ".mr-stat .v small{font:600 11px Inter;color:var(--ink-faint,#8A93A0)}" +
    ".mr-stat .d{font:600 11px Inter;margin-top:2px;color:var(--ink-faint,#8A93A0)}" +
    ".mr-stat .d.up{color:var(--fitness,#3F8F6B)}.mr-stat .d.dn{color:var(--dining,#C9543F)}" +
    ".mr-neg{color:var(--dining,#C9543F)!important}.mr-pos{color:var(--fitness,#3F8F6B)!important}" +
    ".mr-takes{margin:12px 0 2px;padding:0 0 0 2px}" +
    ".mr-takes li{font:13px/1.55 Inter;color:var(--ink-soft,#55606F);margin:0 0 4px 16px}" +
    ".mr-smbtn{font:600 12px Inter;color:var(--accent,#2D6E7E);background:none;border:none;padding:6px 0 0;cursor:pointer}" +
    ".mr-smwrap{overflow-x:auto;margin-top:8px}" +
    ".mr-smtable{border-collapse:collapse;width:100%;font:12.5px Inter;color:var(--ink,#1A2230)}" +
    ".mr-smtable th{font:600 11px Inter;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);text-align:right;padding:6px 10px;border-bottom:1px solid var(--line-2,#D2CCBF)}" +
    ".mr-smtable th:first-child,.mr-smtable td:first-child{text-align:left}" +
    ".mr-smtable td{text-align:right;padding:6px 10px;border-bottom:1px solid var(--line,#E2DDD2);white-space:nowrap}" +
    ".mr-empty{padding:44px 24px;text-align:center;color:var(--ink-soft,#55606F);font:14px Inter;background:var(--paper-2,#FCFBF8);border:1px dashed var(--line-2,#D2CCBF);border-radius:14px}" +
    ".mr-empty b{color:var(--ink,#1A2230);font-size:15px;display:block;margin-bottom:6px}" +
    /* modal */
    ".mr-ovl{position:fixed;inset:0;background:rgba(26,34,48,.45);z-index:1200;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto}" +
    ".mr-sheet{background:var(--paper-2,#FCFBF8);border-radius:16px;box-shadow:0 24px 64px rgba(26,34,48,.35);width:100%;max-width:760px;padding:22px 24px;margin:auto 0}" +
    ".mr-sheet h3{font:700 18px 'Fraunces',Georgia,serif;color:var(--ink,#1A2230);margin:0 0 4px}" +
    ".mr-ssub{font:12.5px/1.5 Inter;color:var(--ink-soft,#55606F);margin-bottom:14px}" +
    ".mr-fld{margin-bottom:10px}" +
    ".mr-fld label{display:block;font:600 11px Inter;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);margin-bottom:4px}" +
    ".mr-fld input,.mr-fld select,.mr-fld textarea{width:100%;box-sizing:border-box;font:13px Inter;color:var(--ink,#1A2230);background:#fff;border:1px solid var(--line-2,#D2CCBF);border-radius:9px;padding:8px 10px}" +
    ".mr-fld textarea{min-height:96px;resize:vertical;line-height:1.5}" +
    ".mr-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}" +
    ".mr-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 12px}" +
    ".mr-err{font:600 12.5px Inter;color:var(--dining,#C9543F);margin:6px 0}" +
    ".mr-row{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}" +
    /* background-import banners */
    ".mr-job{display:flex;gap:12px;align-items:center;background:var(--paper-2,#FCFBF8);border:1px solid var(--line-2,#D2CCBF);border-left:3px solid var(--accent,#2D6E7E);border-radius:12px;padding:12px 14px;margin:0 0 12px}" +
    ".mr-job.done{border-left-color:var(--fitness,#3F8F6B)}" +
    ".mr-job.err{border-left-color:var(--dining,#C9543F)}" +
    ".mr-jt{flex:1;min-width:0}" +
    ".mr-jt b{display:block;font:600 13.5px Inter;color:var(--ink,#1A2230)}" +
    ".mr-jt span{font:12px Inter;color:var(--ink-soft,#55606F)}" +
    ".mr-prog{display:flex;gap:14px;align-items:center;padding:18px 4px}" +
    ".mr-spin{width:26px;height:26px;border:3px solid var(--line-2,#D2CCBF);border-top-color:var(--accent,#2D6E7E);border-radius:50%;animation:mrspin .8s linear infinite;flex:none}" +
    ".mr-spin.sm{width:18px;height:18px;border-width:2.5px}" +
    "@keyframes mrspin{to{transform:rotate(360deg)}}" +
    ".mr-pt{font:600 13.5px Inter;color:var(--ink,#1A2230)}" +
    ".mr-ps{font:12px Inter;color:var(--ink-soft,#55606F);margin-top:3px}" +
    ".mr-smx{font:700 12px Inter;color:var(--ink-faint,#8A93A0);background:none;border:none;cursor:pointer;padding:2px 6px}" +
    ".mr-smx:hover{color:var(--dining,#C9543F)}" +
    ".mr-secl{font:700 12px Inter;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);margin:16px 0 8px;border-top:1px solid var(--line,#E2DDD2);padding-top:12px}";

  (function injectCSS() {
    var s = document.createElement("style");
    s.id = "mrCSS";
    s.textContent = CSS;
    document.head.appendChild(s);
  })();

  /* ================= state + helpers ================= */
  var st = { loaded: false, loading: false, err: "", rows: [], jobs: [], prod: "all", brok: "all" };
  var _imp = null;      // import the SHEET is showing {jobId, stage, report, filename, timer}
  var _jobsIv = null;   // page-level job poller — keeps running after the sheet is closed

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toNum(v) { if (v == null || v === "") return null; var n = Number(String(v).replace(/[$,%\s,]/g, "")); return isFinite(n) ? n : null; }
  function toInt(v) { var n = toNum(v); return n == null ? null : Math.round(n); }
  function toStr(v) { if (v == null) return null; var s = String(v).trim(); return s || null; }
  function oneOf(v, allowed) {
    var s = toStr(v); if (!s) return null;
    for (var i = 0; i < allowed.length; i++) if (allowed[i].toLowerCase() === s.toLowerCase()) return allowed[i];
    return null;
  }
  function toDate(v) { var s = toStr(v); if (!s) return null; var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? m[1] + "-" + m[2] + "-" + m[3] : null; }

  function fmtSF(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M SF";
    if (a >= 1e3) return s + Math.round(a / 1e3) + "K SF";
    return s + a + " SF";
  }
  function fmtPct(v) { return (v == null || isNaN(v)) ? "—" : Number(v).toFixed(1) + "%"; }
  function fmtRate(v, period, basis) {
    if (v == null || isNaN(v)) return "—";
    var s = "$" + Number(v).toFixed(2);
    if (period) s += "/SF/" + (period === "mo" ? "MO" : "YR");
    if (basis) s += " " + basis;
    return s;
  }
  function normKey(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function dedupKey(r) { return normKey(r.brokerage) + "|" + normKey(r.market) + "|" + (r.product_type || "") + "|" + r.year + "|q" + r.quarter; }
  function qLabel(y, q) { return "Q" + q + " " + y; }
  function qSort(r) { return (r.year || 0) * 10 + (r.quarter || 0); }

  function sbc() { return window.vantageSB || null; }
  function q(p) { return Promise.resolve(p).then(function (r) { if (r && r.error) throw new Error(r.error.message || String(r.error)); return r && r.data; }); }
  function getToken() {
    var sb = sbc(); if (!sb) return Promise.resolve(null);
    return sb.auth.getSession().then(function (s) { return (s && s.data && s.data.session) ? s.data.session.access_token : null; }).catch(function () { return null; });
  }

  /* ================= sub-view wiring ================= */
  function hideReports() { var v = document.getElementById("reportsView"); if (v) v.classList.remove("show"); }
  // entering any sibling Market sub-view hides this one (they don't know about us)
  ["showPortfolio", "showCompetition", "showCommute", "showComps"].forEach(function (name) {
    var orig = window[name];
    if (typeof orig === "function") window[name] = function () { hideReports(); return orig.apply(this, arguments); };
  });

  window.showMarketReports = function () {
    ["portfolioView"].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = "none"; });
    ["detailView", "competitionView", "commuteView", "compsView"].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.classList.remove("show");
    });
    var v = document.getElementById("reportsView"); if (v) v.classList.add("show");
    document.querySelectorAll("#marketSub .vnav-subitem").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-sv") === "reports"); });
    var p = document.getElementById("priobar"); if (p) p.style.display = "none";
    var c = document.getElementById("crumb"); if (c) c.innerHTML = "Market · <b>Quarterly Reports</b>";
    render();
    if (!st.loaded && !st.loading) load();
    loadJobs();                    // pick up imports still running from earlier visits
  };

  /* ================= data ================= */
  function load() {
    var sb = sbc();
    if (!sb) { st.err = "Sign-in isn't ready yet — reload the page."; st.loaded = true; render(); return; }
    st.loading = true; st.err = "";
    q(sb.from("market_reports").select("*").order("year", { ascending: false }).order("quarter", { ascending: false }).order("brokerage"))
      .then(function (rows) { st.rows = rows || []; st.loaded = true; st.loading = false; render(); })
      .catch(function (e) {
        st.err = /does not exist|relation|schema cache/i.test(e.message || "")
          ? "The reports table isn't set up yet — run supabase/market-reports.sql once and reload."
          : (e.message || "Could not load reports.");
        st.loaded = true; st.loading = false; render();
      });
  }

  /* ---- background import jobs (market_report_extracts rows) ----
   * The extraction runs server-side against a job row, so it survives closing
   * the sheet, leaving the page, even closing the browser. This poller owns
   * job state page-wide: banners above the library show running/ready/failed
   * imports, and if the "Reading…" sheet is open for a job it drives that too.
   * NOTE: never select pdf_b64 here — that's the staged multi-MB upload. */
  var JOB_COLS = "id,filename,status,error,result,created_at";
  var POLL_MS = 3000;

  function loadJobs() {
    var sb = sbc(); if (!sb) return;
    q(sb.from("market_report_extracts").select(JOB_COLS).order("created_at", { ascending: false }))
      .then(function (rows) { st.jobs = rows || []; render(); ensurePoller(); })
      .catch(function () { /* table missing → the import flow surfaces it */ });
  }

  function ensurePoller() {
    var pending = st.jobs.some(function (j) { return j.status === "queued"; });
    if (!pending) { if (_jobsIv) { clearInterval(_jobsIv); _jobsIv = null; } return; }
    if (_jobsIv) return;
    _jobsIv = setInterval(function () {
      var sb = sbc(); if (!sb) return;
      q(sb.from("market_report_extracts").select(JOB_COLS).order("created_at", { ascending: false }))
        .then(function (rows) {
          var prev = {}; st.jobs.forEach(function (j) { prev[j.id] = j.status; });
          st.jobs = rows || [];
          // a job the open sheet is watching just settled → drive the sheet
          st.jobs.forEach(function (j) {
            if (prev[j.id] === "queued" && j.status !== "queued" &&
                _imp && _imp.jobId === j.id && _imp.stage === "reading" && document.getElementById("mrOvl")) {
              if (j.status === "done") reviewJob(j.id);
              else failSheet(j.error || "The reader hit an error. Try again.");
            }
          });
          render(); ensurePoller();
        })
        .catch(function () { /* transient — keep polling */ });
    }, POLL_MS);
  }

  function findJob(id) { for (var i = 0; i < st.jobs.length; i++) if (st.jobs[i].id === id) return st.jobs[i]; return null; }

  // open the review sheet for a finished job (from the sheet flow or a banner)
  function reviewJob(id) {
    var j = findJob(id); if (!j || j.status !== "done") return;
    if (_imp && _imp.timer) { clearInterval(_imp.timer); _imp.timer = null; }
    _imp = { jobId: id, stage: "review", filename: j.filename || "report", timer: null, report: normalizeReport(j.result) };
    review();
  }

  function dismissJob(id) {
    st.jobs = st.jobs.filter(function (j) { return j.id !== id; });
    render(); ensurePoller();
    cleanupJob(id);
  }

  function jobAge(j) {
    var ms = Date.now() - new Date(j.created_at).getTime();
    if (!isFinite(ms) || ms < 0) return "";
    var m = Math.floor(ms / 60000);
    return m < 1 ? "under a minute" : (m + " min");
  }

  function renderJobs() {
    if (!st.jobs.length) return "";
    return st.jobs.map(function (j) {
      if (j.status === "queued") {
        var long = (Date.now() - new Date(j.created_at).getTime()) > 10 * 60 * 1000;
        return '<div class="mr-job"><div class="mr-spin sm"></div><div class="mr-jt"><b>Reading ' + esc(j.filename || "report") + "…</b>" +
          "<span>" + (long ? "Taking unusually long — you can dismiss this and try a lighter PDF." : "Running for " + jobAge(j) + " — you can leave this page; it finishes on its own.") + "</span></div>" +
          '<button class="mr-del" data-mr-dismiss="' + esc(j.id) + '">Dismiss</button></div>';
      }
      if (j.status === "error") {
        return '<div class="mr-job err"><div class="mr-jt"><b>' + esc(j.filename || "Report") + " couldn’t be read</b><span>" + esc(j.error || "Unknown error") + "</span></div>" +
          '<button class="mr-del" data-mr-dismiss="' + esc(j.id) + '">Dismiss</button></div>';
      }
      return '<div class="mr-job done"><div class="mr-jt"><b>' + esc(j.filename || "Report") + " is ready</b><span>Review the extracted stats, then save it to the library.</span></div>" +
        '<button class="cmp-btn primary" data-mr-review="' + esc(j.id) + '">Review &amp; save</button>' +
        '<button class="mr-del" data-mr-dismiss="' + esc(j.id) + '">Dismiss</button></div>';
    }).join("");
  }

  // previous quarter's row from the same brokerage/market/product, for QoQ deltas
  function prevRow(r) {
    var py = r.quarter === 1 ? r.year - 1 : r.year, pq = r.quarter === 1 ? 4 : r.quarter - 1;
    for (var i = 0; i < st.rows.length; i++) {
      var o = st.rows[i];
      if (o.year === py && o.quarter === pq && normKey(o.brokerage) === normKey(r.brokerage) &&
          normKey(o.market) === normKey(r.market) && (o.product_type || "") === (r.product_type || "")) return o;
    }
    return null;
  }

  /* ================= render: the library ================= */
  function delta(cur, prev, fmt, invert) {
    if (cur == null || prev == null || isNaN(cur) || isNaN(prev)) return "";
    var d = cur - prev;
    if (Math.abs(d) < 1e-9) return '<div class="d">— flat QoQ</div>';
    var up = d > 0, good = invert ? !up : up;
    return '<div class="d ' + (good ? "up" : "dn") + '">' + (up ? "▲" : "▼") + " " + fmt(Math.abs(d)) + " QoQ</div>";
  }

  function statTile(k, vHtml, dHtml) {
    return '<div class="mr-stat"><div class="k">' + k + '</div><div class="v">' + vHtml + "</div>" + (dHtml || "") + "</div>";
  }

  function card(r) {
    var p = prevRow(r);
    var takes = Array.isArray(r.takeaways) ? r.takeaways : [];
    var subs = Array.isArray(r.submarkets) ? r.submarkets : [];
    var tiles = "";
    if (r.avg_asking_rate != null) tiles += statTile("Avg asking rate",
      "$" + Number(r.avg_asking_rate).toFixed(2) + " <small>/SF/" + (r.rate_period === "yr" ? "YR" : "MO") + (r.rate_basis ? " " + r.rate_basis : "") + "</small>",
      p ? delta(r.avg_asking_rate, p.avg_asking_rate, function (d) { return "$" + d.toFixed(2); }, true) : "");
    if (r.class_a_rate != null) tiles += statTile("Class A rate",
      "$" + Number(r.class_a_rate).toFixed(2) + " <small>/SF/" + (r.rate_period === "yr" ? "YR" : "MO") + "</small>",
      p ? delta(r.class_a_rate, p.class_a_rate, function (d) { return "$" + d.toFixed(2); }, true) : "");
    if (r.vacancy_pct != null) tiles += statTile("Vacancy", fmtPct(r.vacancy_pct),
      p ? delta(r.vacancy_pct, p.vacancy_pct, function (d) { return d.toFixed(1) + " pts"; }, false) : "");
    if (r.availability_pct != null) tiles += statTile("Availability", fmtPct(r.availability_pct),
      p ? delta(r.availability_pct, p.availability_pct, function (d) { return d.toFixed(1) + " pts"; }, false) : "");
    if (r.net_absorption_sf != null) tiles += statTile("Net absorption",
      '<span class="' + (r.net_absorption_sf < 0 ? "mr-neg" : "mr-pos") + '">' + fmtSF(r.net_absorption_sf) + "</span>");
    if (r.sublease_sf != null) tiles += statTile("Sublease space", fmtSF(r.sublease_sf),
      p ? delta(r.sublease_sf, p.sublease_sf, fmtSF, false) : "");
    if (r.leasing_activity_sf != null) tiles += statTile("Leasing activity", fmtSF(r.leasing_activity_sf));
    if (r.under_construction_sf != null) tiles += statTile("Under construction", fmtSF(r.under_construction_sf));
    if (r.deliveries_sf != null) tiles += statTile("Deliveries", fmtSF(r.deliveries_sf));
    if (r.inventory_sf != null) tiles += statTile("Inventory", fmtSF(r.inventory_sf));
    if (r.sale_price_psf != null) tiles += statTile("Avg sale price", "$" + Number(r.sale_price_psf).toFixed(0) + " <small>/SF</small>");
    if (r.cap_rate_pct != null) tiles += statTile("Cap rate", fmtPct(r.cap_rate_pct));

    var smHtml = "";
    if (subs.length) {
      var rows = subs.map(function (s) {
        return "<tr><td>" + esc(s.name) + "</td>" +
          "<td>" + (s.avg_asking_rate != null ? "$" + Number(s.avg_asking_rate).toFixed(2) : "—") + "</td>" +
          "<td>" + (s.class_a_rate != null ? "$" + Number(s.class_a_rate).toFixed(2) : "—") + "</td>" +
          "<td>" + fmtPct(s.vacancy_pct) + "</td>" +
          "<td>" + fmtPct(s.availability_pct) + "</td>" +
          '<td class="' + (s.net_absorption_sf < 0 ? "mr-neg" : "") + '">' + fmtSF(s.net_absorption_sf) + "</td>" +
          "<td>" + fmtSF(s.sublease_sf) + "</td></tr>";
      }).join("");
      smHtml = '<button class="mr-smbtn" data-mr-sm="' + esc(r.id) + '">▸ Submarket breakdown (' + subs.length + ")</button>" +
        '<div class="mr-smwrap" id="mrsm_' + esc(r.id) + '" style="display:none"><table class="mr-smtable">' +
        "<thead><tr><th>Submarket</th><th>Avg rate</th><th>Class A</th><th>Vacancy</th><th>Avail.</th><th>Net absorp.</th><th>Sublease</th></tr></thead>" +
        "<tbody>" + rows + "</tbody></table></div>";
    }

    return '<div class="mr-card" data-mr-id="' + esc(r.id) + '">' +
      '<div class="mr-top">' +
        '<span class="mr-brok">' + esc(r.brokerage) + "</span>" +
        '<div class="mr-title"><b>' + esc(r.report_title || (r.market + " " + qLabel(r.year, r.quarter))) + "</b>" +
          '<div class="mr-meta">' + esc(r.market) + " · " + qLabel(r.year, r.quarter) +
          (r.report_date ? " · " + esc(r.report_date) : "") + (r.filename ? " · " + esc(r.filename) : "") + "</div></div>" +
        (r.product_type ? '<span class="mr-chip">' + esc(r.product_type) + "</span>" : "") +
        '<button class="mr-del" data-mr-del="' + esc(r.id) + '">Delete</button>' +
      "</div>" +
      (tiles ? '<div class="mr-stats">' + tiles + "</div>" : "") +
      (takes.length ? '<ul class="mr-takes">' + takes.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" : "") +
      smHtml +
      "</div>";
  }

  function filtered() {
    return st.rows.filter(function (r) {
      if (st.prod !== "all" && (r.product_type || "") !== st.prod) return false;
      if (st.brok !== "all" && normKey(r.brokerage) !== st.brok) return false;
      return true;
    });
  }

  function render() {
    var el = document.getElementById("reportsBody"); if (!el) return;
    var broks = {};
    st.rows.forEach(function (r) { if (r.brokerage) broks[normKey(r.brokerage)] = r.brokerage; });
    var brokOpts = Object.keys(broks).sort().map(function (k) {
      return '<option value="' + k + '"' + (st.brok === k ? " selected" : "") + ">" + esc(broks[k]) + "</option>";
    }).join("");
    var prodOpts = PRODUCTS.map(function (p) {
      return '<option value="' + p[0] + '"' + (st.prod === p[0] ? " selected" : "") + ">" + p[1] + "</option>";
    }).join("");

    var head =
      '<div class="mr-head"><div><div class="mr-h1">Quarterly Market Reports</div>' +
      '<div class="mr-sub">The big brokerages’ published quarterly research, digested: average asking rates, vacancy, absorption and takeaways — comparable quarter over quarter.</div></div>' +
      '<button class="cmp-btn primary" id="mrImportBtn">⬆ Import report</button></div>' +
      '<div class="mr-filters">' +
      '<select class="mr-sel" id="mrProd"><option value="all">All product types</option>' + prodOpts + "</select>" +
      '<select class="mr-sel" id="mrBrok"><option value="all">All brokerages</option>' + brokOpts + "</select>" +
      "</div>";

    var body;
    if (st.err) body = '<div class="mr-empty"><b>Couldn’t load reports.</b>' + esc(st.err) + "</div>";
    else if (!st.loaded) body = '<div class="mr-empty">Loading your reports…</div>';
    else {
      var list = filtered();
      if (!st.rows.length) body =
        '<div class="mr-empty"><b>No reports yet.</b>Import your first quarterly market report — CBRE, JLL, Cushman &amp; Wakefield, Colliers, Newmark and the rest all publish them free every quarter. Claude pulls the stats; you get the trendline.</div>';
      else if (!list.length) body = '<div class="mr-empty"><b>Nothing matches those filters.</b>Clear the product type or brokerage filter above.</div>';
      else {
        // group by quarter, newest first
        var groups = {};
        list.forEach(function (r) { var k = qSort(r); (groups[k] = groups[k] || []).push(r); });
        body = Object.keys(groups).sort(function (a, b) { return b - a; }).map(function (k) {
          var rs = groups[k];
          return '<div class="mr-qh">' + qLabel(rs[0].year, rs[0].quarter) + "</div>" + rs.map(card).join("");
        }).join("");
      }
    }
    el.innerHTML = head + renderJobs() + body;

    var ib = document.getElementById("mrImportBtn"); if (ib) ib.addEventListener("click", openImport);
    el.querySelectorAll("[data-mr-review]").forEach(function (b) {
      b.addEventListener("click", function () { reviewJob(this.getAttribute("data-mr-review")); });
    });
    el.querySelectorAll("[data-mr-dismiss]").forEach(function (b) {
      b.addEventListener("click", function () { dismissJob(this.getAttribute("data-mr-dismiss")); });
    });
    var ps = document.getElementById("mrProd"); if (ps) ps.addEventListener("change", function () { st.prod = this.value; render(); });
    var bs = document.getElementById("mrBrok"); if (bs) bs.addEventListener("change", function () { st.brok = this.value; render(); });
    el.querySelectorAll("[data-mr-sm]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = document.getElementById("mrsm_" + this.getAttribute("data-mr-sm")); if (!t) return;
        var open = t.style.display !== "none";
        t.style.display = open ? "none" : "";
        this.textContent = (open ? "▸" : "▾") + this.textContent.slice(1);
      });
    });
    el.querySelectorAll("[data-mr-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-mr-del"), btn = this;
        if (!btn.classList.contains("arm")) {         // two-click delete
          btn.classList.add("arm"); btn.textContent = "Really delete?";
          setTimeout(function () { btn.classList.remove("arm"); btn.textContent = "Delete"; }, 3500);
          return;
        }
        var sb = sbc(); if (!sb) return;
        q(sb.from("market_reports").delete().eq("id", id))
          .then(function () { st.rows = st.rows.filter(function (r) { return r.id !== id; }); render(); })
          .catch(function (e) { alert("Delete failed: " + (e.message || e)); });
      });
    });
  }

  /* ================= import flow ================= */
  function sheet(html) {
    closeSheet();
    var ovl = document.createElement("div");
    ovl.className = "mr-ovl"; ovl.id = "mrOvl";
    ovl.innerHTML = '<div class="mr-sheet">' + html + "</div>";
    ovl.addEventListener("mousedown", function (e) { if (e.target === ovl) closeSheet(); });
    document.body.appendChild(ovl);
  }
  function closeSheet() {
    if (_imp && _imp.timer) { clearInterval(_imp.timer); _imp.timer = null; }
    var o = document.getElementById("mrOvl"); if (o) o.remove();
  }
  window.mrCloseSheet = closeSheet;   // used by inline onclick in the sheets

  function openImport() {
    _imp = { report: null, filename: null, timer: null };
    sheet("<h3>Import quarterly market report</h3>" +
      '<div class="mr-ssub">Upload a brokerage’s published quarterly report (CBRE Figures, JLL, Cushman &amp; Wakefield MarketBeat, Colliers, Newmark…). Claude reads the headline stats, submarket table and takeaways — you review and edit everything before it’s saved.</div>' +
      '<div class="mr-fld"><label>Report PDF</label><input id="mr_file" type="file" accept=".pdf,application/pdf"></div>' +
      '<div class="mr-ssub" style="margin:2px 0 8px">…or paste the report text instead:</div>' +
      '<div class="mr-fld"><textarea id="mr_text" placeholder="Optional fallback — paste the report’s stats pages here if you don’t have the PDF"></textarea></div>' +
      '<div class="mr-err" id="mr_err"></div>' +
      '<div class="mr-row"><button class="cmp-btn" onclick="mrCloseSheet()">Cancel</button><button class="cmp-btn primary" id="mr_go">⬆ Read report</button></div>');
    document.getElementById("mr_go").addEventListener("click", startExtract);
  }

  function fileB64(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { rej(new Error("Could not read that file.")); };
      r.readAsDataURL(f);
    });
  }

  function startExtract() {
    var f = document.getElementById("mr_file").files && document.getElementById("mr_file").files[0];
    var pasted = (document.getElementById("mr_text").value || "").trim();
    var err = document.getElementById("mr_err");
    if (!f && !pasted) { err.textContent = "Pick the report PDF (or paste its text)."; return; }
    if (f && !/pdf$/i.test(f.name) && f.type !== "application/pdf") { err.textContent = "That file isn’t a PDF — download the report as PDF, or paste its text below."; return; }
    if (f && f.size > 20 * 1024 * 1024) { err.textContent = "File too large — 20MB max."; return; }
    _imp.filename = f ? f.name : "pasted report text";
    document.getElementById("mr_go").disabled = true;
    (f ? fileB64(f) : Promise.resolve(null))
      .then(function (b64) { return callExtract(b64, pasted, f ? f.name : null); })
      .catch(function (e) { failSheet(e.message || String(e)); });
  }

  // Async pipeline (the synchronous call 504'd — Netlify caps sync functions
  // at ~26s and a full-report Opus read runs longer):
  //   1. stage the PDF/text in an org-scoped market_report_extracts job row,
  //   2. kick the background fn with just {token, jobId} (202-immediately),
  //   3. poll the job row until it flips to done/error.
  function newJobId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });
  }

  function callExtract(b64, pasted, filename) {
    var jobId = newJobId();
    _imp.jobId = jobId; _imp.stage = "reading";
    readingSheet(jobId, Date.now());

    var supa = sbc();
    if (!supa) { failSheet("Sign-in isn't ready — reload the page."); return; }
    return q(supa.from("market_report_extracts").insert({
      id: jobId, org_id: ORG_ID, filename: filename || _imp.filename || null,
      pdf_b64: b64 || null, src_text: (!b64 && pasted) ? pasted : null
    })).then(function () {
      return getToken();
    }).then(function (token) {
      if (!token) throw new Error("Your session expired — please sign in again.");
      return fetch(FN, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, jobId: jobId })
      });
    }).then(function (res) {
      if (res.status === 401) throw new Error("Your session expired — please sign in again.");
      // background fns reply 202 before running; anything else <500 is still "accepted"
      if (res.status >= 500) throw new Error("The reader couldn't start (HTTP " + res.status + "). Try again.");
      // job is live: show it as a banner too, and let the page-level poller own it
      st.jobs.unshift({ id: jobId, filename: filename || _imp.filename || null, status: "queued", error: null, result: null, created_at: new Date().toISOString() });
      render(); ensurePoller();
    }).catch(function (e) {
      var m = e.message || String(e);
      if (/does not exist|relation|schema cache/i.test(m)) m = "The reports tables need an update — run supabase/market-reports.sql once and reload.";
      cleanupJob(jobId);
      failSheet(m);
    });
  }

  // The "Reading…" sheet is OPTIONAL now — the extraction belongs to the job
  // row, not the sheet. "Run in background" just closes it; the banner (and
  // the page-level poller) carry on, and "Review & save" appears when done.
  function readingSheet(jobId, started) {
    sheet("<h3>Reading report…</h3><div class=\"mr-ssub\">" + esc(_imp.filename) + "</div>" +
      '<div class="mr-prog"><div class="mr-spin"></div><div><div class="mr-pt">Claude is reading the stats, submarkets &amp; takeaways…</div>' +
      '<div class="mr-ps">A full report takes ~1–3 minutes. <span id="mr_elapsed">0s</span> elapsed.</div></div></div>' +
      '<div class="mr-ssub">You don’t need to wait here — run it in the background and a <b>Review &amp; save</b> button appears on the Reports page when it’s done.</div>' +
      '<div class="mr-row"><button class="cmp-btn" id="mr_cancel">Cancel import</button><button class="cmp-btn primary" id="mr_bg">Run in background</button></div>');
    _imp.timer = setInterval(function () { var el = document.getElementById("mr_elapsed"); if (el) el.textContent = Math.round((Date.now() - started) / 1000) + "s"; }, 1000);
    document.getElementById("mr_bg").addEventListener("click", function () { closeSheet(); _imp = null; });
    document.getElementById("mr_cancel").addEventListener("click", function () {
      var id = _imp && _imp.jobId;
      closeSheet(); _imp = null;
      if (id) dismissJob(id);
    });
  }

  function cleanupJob(jobId) {
    var supa = sbc(); if (!supa) return;
    q(supa.from("market_report_extracts").delete().eq("id", jobId)).catch(function () { /* best effort */ });
  }

  function failSheet(msg) {
    if (_imp && _imp.timer) { clearInterval(_imp.timer); _imp.timer = null; }
    sheet("<h3>Import quarterly market report</h3><div class=\"mr-ssub\">" + esc((_imp && _imp.filename) || "") + "</div>" +
      '<div class="mr-err">' + esc(msg) + "</div>" +
      '<div class="mr-row"><button class="cmp-btn" onclick="mrCloseSheet()">Close</button><button class="cmp-btn primary" id="mr_retry">Try again</button></div>');
    document.getElementById("mr_retry").addEventListener("click", openImport);
  }

  // tolerant coercion of the extraction (never trusted) into a review model
  function normalizeReport(r) {
    r = r || {};
    var now = new Date();
    return {
      brokerage: toStr(r.brokerage) || "",
      report_title: toStr(r.reportTitle),
      market: toStr(r.market) || "",
      product_type: oneOf(r.productType, PRODUCTS.map(function (p) { return p[0]; })),
      year: toInt(r.year) || now.getFullYear(),
      quarter: Math.min(4, Math.max(1, toInt(r.quarter) || (Math.floor(now.getMonth() / 3) + 1))),
      report_date: toDate(r.reportDate),
      inventory_sf: toInt(r.inventorySf),
      vacancy_pct: toNum(r.vacancyPct),
      availability_pct: toNum(r.availabilityPct),
      sublease_sf: toInt(r.subleaseSf),
      net_absorption_sf: toInt(r.netAbsorptionSf),
      net_absorption_ytd_sf: toInt(r.netAbsorptionYtdSf),
      leasing_activity_sf: toInt(r.leasingActivitySf),
      under_construction_sf: toInt(r.underConstructionSf),
      deliveries_sf: toInt(r.deliveriesSf),
      avg_asking_rate: toNum(r.avgAskingRate),
      rate_period: oneOf(r.ratePeriod, ["mo", "yr"]),
      rate_basis: oneOf(r.rateBasis, ["FSG", "NNN", "MG"]),
      class_a_rate: toNum(r.classARate),
      sale_price_psf: toNum(r.salePricePsf),
      cap_rate_pct: toNum(r.capRatePct),
      takeaways: (Array.isArray(r.takeaways) ? r.takeaways : []).map(toStr).filter(Boolean),
      submarkets: (Array.isArray(r.submarkets) ? r.submarkets : []).map(function (s) {
        s = s || {};
        return {
          name: toStr(s.name) || "—",
          inventory_sf: toInt(s.inventorySf),
          vacancy_pct: toNum(s.vacancyPct),
          availability_pct: toNum(s.availabilityPct),
          net_absorption_sf: toInt(s.netAbsorptionSf),
          sublease_sf: toInt(s.subleaseSf),
          avg_asking_rate: toNum(s.avgAskingRate),
          class_a_rate: toNum(s.classARate)
        };
      }),
      raw: r
    };
  }

  function fldIn(label, id, val, ph) {
    return '<div class="mr-fld"><label>' + label + '</label><input id="' + id + '" value="' + esc(val == null ? "" : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") + "></div>";
  }

  function review() {
    var r = _imp.report;
    var prodSel = '<div class="mr-fld"><label>Product type</label><select id="mrr_prod"><option value="">—</option>' +
      PRODUCTS.map(function (p) { return '<option value="' + p[0] + '"' + (r.product_type === p[0] ? " selected" : "") + ">" + p[1] + "</option>"; }).join("") + "</select></div>";
    var perSel = '<div class="mr-fld"><label>Rate period</label><select id="mrr_per"><option value="">—</option>' +
      [["mo", "$/SF/month"], ["yr", "$/SF/year"]].map(function (p) { return '<option value="' + p[0] + '"' + (r.rate_period === p[0] ? " selected" : "") + ">" + p[1] + "</option>"; }).join("") + "</select></div>";
    var basSel = '<div class="mr-fld"><label>Rate basis</label><select id="mrr_bas"><option value="">—</option>' +
      ["FSG", "NNN", "MG"].map(function (b) { return '<option value="' + b + '"' + (r.rate_basis === b ? " selected" : "") + ">" + b + "</option>"; }).join("") + "</select></div>";
    var smRows = r.submarkets.map(function (s, i) {
      return "<tr><td>" + esc(s.name) + "</td>" +
        "<td>" + (s.avg_asking_rate != null ? "$" + s.avg_asking_rate.toFixed(2) : "—") + "</td>" +
        "<td>" + fmtPct(s.vacancy_pct) + "</td>" +
        "<td>" + fmtSF(s.net_absorption_sf) + "</td>" +
        '<td><button class="mr-smx" data-mr-rmsm="' + i + '" title="Remove row">✕</button></td></tr>';
    }).join("");

    sheet("<h3>Review before saving</h3>" +
      '<div class="mr-ssub">Everything below came out of <b>' + esc(_imp.filename) + "</b>. Fix anything Claude misread — nothing is saved until you confirm.</div>" +
      '<div class="mr-grid2">' + fldIn("Brokerage", "mrr_brok", r.brokerage, "CBRE") + fldIn("Market", "mrr_mkt", r.market, "Greater Los Angeles") + "</div>" +
      fldIn("Report title", "mrr_title", r.report_title) +
      '<div class="mr-grid3">' + prodSel + fldIn("Year", "mrr_year", r.year) + fldIn("Quarter (1-4)", "mrr_q", r.quarter) + "</div>" +
      '<div class="mr-secl">Headline statistics</div>' +
      '<div class="mr-grid3">' + fldIn("Avg asking rate ($/SF)", "mrr_rate", r.avg_asking_rate) + perSel + basSel + "</div>" +
      '<div class="mr-grid3">' + fldIn("Class A rate ($/SF)", "mrr_cla", r.class_a_rate) + fldIn("Vacancy %", "mrr_vac", r.vacancy_pct) + fldIn("Availability %", "mrr_avail", r.availability_pct) + "</div>" +
      '<div class="mr-grid3">' + fldIn("Net absorption (SF)", "mrr_abs", r.net_absorption_sf) + fldIn("YTD absorption (SF)", "mrr_absytd", r.net_absorption_ytd_sf) + fldIn("Sublease space (SF)", "mrr_sub", r.sublease_sf) + "</div>" +
      '<div class="mr-grid3">' + fldIn("Leasing activity (SF)", "mrr_leas", r.leasing_activity_sf) + fldIn("Under construction (SF)", "mrr_uc", r.under_construction_sf) + fldIn("Inventory (SF)", "mrr_inv", r.inventory_sf) + "</div>" +
      '<div class="mr-secl">Key takeaways <span style="text-transform:none;letter-spacing:0">(one bullet per line)</span></div>' +
      '<div class="mr-fld"><textarea id="mrr_takes">' + esc(r.takeaways.join("\n")) + "</textarea></div>" +
      (r.submarkets.length ?
        '<div class="mr-secl">Submarkets (' + r.submarkets.length + ")</div>" +
        '<div class="mr-smwrap"><table class="mr-smtable"><thead><tr><th>Submarket</th><th>Avg rate</th><th>Vacancy</th><th>Net absorp.</th><th></th></tr></thead><tbody>' + smRows + "</tbody></table></div>"
        : "") +
      '<div class="mr-err" id="mrr_err"></div>' +
      '<div class="mr-row"><button class="cmp-btn" onclick="mrCloseSheet()">Cancel</button><button class="cmp-btn primary" id="mrr_save">Save report</button></div>');

    document.querySelectorAll("[data-mr-rmsm]").forEach(function (b) {
      b.addEventListener("click", function () { _imp.report.submarkets.splice(Number(this.getAttribute("data-mr-rmsm")), 1); review(); });
    });
    document.getElementById("mrr_save").addEventListener("click", save);
  }

  function save() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
    var err = document.getElementById("mrr_err");
    var r = _imp.report;
    var row = {
      org_id: ORG_ID,
      brokerage: toStr(g("mrr_brok")),
      report_title: toStr(g("mrr_title")),
      market: toStr(g("mrr_mkt")),
      product_type: toStr(g("mrr_prod")),
      year: toInt(g("mrr_year")),
      quarter: toInt(g("mrr_q")),
      report_date: r.report_date,
      inventory_sf: toInt(g("mrr_inv")),
      vacancy_pct: toNum(g("mrr_vac")),
      availability_pct: toNum(g("mrr_avail")),
      sublease_sf: toInt(g("mrr_sub")),
      net_absorption_sf: toInt(g("mrr_abs")),
      net_absorption_ytd_sf: toInt(g("mrr_absytd")),
      leasing_activity_sf: toInt(g("mrr_leas")),
      under_construction_sf: toInt(g("mrr_uc")),
      deliveries_sf: r.deliveries_sf,
      avg_asking_rate: toNum(g("mrr_rate")),
      rate_period: toStr(g("mrr_per")),
      rate_basis: toStr(g("mrr_bas")),
      class_a_rate: toNum(g("mrr_cla")),
      sale_price_psf: r.sale_price_psf,
      cap_rate_pct: r.cap_rate_pct,
      takeaways: String(g("mrr_takes") || "").split("\n").map(function (s) { return s.replace(/^[-•\s]+/, "").trim(); }).filter(Boolean),
      submarkets: r.submarkets,
      filename: _imp.filename,
      raw: r.raw
    };
    if (!row.brokerage) { err.textContent = "Which brokerage published this? (e.g. CBRE)"; return; }
    if (!row.market) { err.textContent = "Which market does it cover? (e.g. Greater Los Angeles)"; return; }
    if (!row.year || !row.quarter || row.quarter < 1 || row.quarter > 4) { err.textContent = "Set the report's year and quarter (1-4)."; return; }
    row.dedup_key = dedupKey(row);

    var sb = sbc();
    if (!sb) { err.textContent = "Sign-in isn't ready — reload the page."; return; }
    document.getElementById("mrr_save").disabled = true;
    // upsert on (org_id, dedup_key): re-importing the same quarter updates the row
    q(sb.from("market_reports").select("id").eq("org_id", ORG_ID).eq("dedup_key", row.dedup_key))
      .then(function (hits) {
        if (hits && hits.length) return q(sb.from("market_reports").update(row).eq("id", hits[0].id));
        return q(sb.from("market_reports").insert(row));
      })
      .then(function () {
        var jobId = _imp && _imp.jobId;
        closeSheet(); _imp = null;
        if (jobId) { st.jobs = st.jobs.filter(function (j) { return j.id !== jobId; }); cleanupJob(jobId); }
        st.loaded = false; load(); ensurePoller();
      })
      .catch(function (e) {
        document.getElementById("mrr_save").disabled = false;
        err.textContent = "Save failed: " + (e.message || e) +
          (/does not exist|relation|schema cache/i.test(e.message || "") ? " — run supabase/market-reports.sql first." : "");
      });
  }
})();
