/* Vantage — BD Command Center (self-contained module, market-spaces.js pattern).
 *
 * Adds a "BD" item to the sidebar and renders the business-development cockpit:
 * a live SYSTEM MAP (what feeds what, what ran, what's wired vs. pending), the
 * morning touch QUEUE (approve / edit / skip — the whole BD day in one screen),
 * the program FUNNEL from HubSpot, job HEALTH, and an activity feed.
 *
 * Self-contained: injects its own .bdc- CSS (brand vars w/ fallbacks), its own
 * nav item + <section>, and wraps window.showModule. index.html diff = one
 * <script> tag. Data comes from bd-overview / bd-queue-act / bd-cadence fns.
 */
(function () {
  "use strict";
  if (window.__bdCenterLoaded) return; window.__bdCenterLoaded = true;

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function getSB() { return window.vantageSB || null; }
  function token(cb) {
    var sb = getSB();
    if (!sb || !sb.auth) return cb(null);
    sb.auth.getSession().then(function (r) {
      cb(r && r.data && r.data.session ? r.data.session.access_token : null);
    }).catch(function () { cb(null); });
  }
  function ago(iso) {
    if (!iso) return "never";
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "never";
    var m = Math.round(ms / 60000);
    if (m < 2) return "just now";
    if (m < 90) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 36) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  function fmtDate(d) {
    if (!d) return "—";
    var dt = new Date(String(d).slice(0, 10) + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function overdue(d) {
    if (!d) return false;
    var t = new Date(); t.setHours(0, 0, 0, 0);
    return new Date(String(d).slice(0, 10) + "T00:00:00").getTime() < t.getTime();
  }

  var S = { data: null, loading: false, err: null, editing: null, open: {} };

  /* ---------------- CSS ---------------- */
  var css = "" +
    "#bdView{padding:26px 30px 60px;max-width:1180px;margin:0 auto}" +
    ".bdc-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px}" +
    ".bdc-head h1{font-size:26px;margin:0;color:var(--ink,#1A2230)}" +
    ".bdc-head .sub{color:var(--ink-soft,#55606F);font-size:13.5px;margin-top:4px}" +
    ".bdc-actions{display:flex;gap:8px}" +
    ".bdc-btn{border:1px solid var(--line-2,#D2CCBF);background:var(--paper-2,#FCFBF8);color:var(--ink,#1A2230);border-radius:8px;padding:7px 13px;font-size:13px;cursor:pointer}" +
    ".bdc-btn:hover{border-color:var(--accent,#2D6E7E)}" +
    ".bdc-btn.pri{background:var(--accent,#2D6E7E);border-color:var(--accent,#2D6E7E);color:#fff}" +
    ".bdc-btn[disabled]{opacity:.5;cursor:default}" +
    ".bdc-card{background:var(--paper-2,#FCFBF8);border:1px solid var(--line,#E2DDD2);border-radius:12px;box-shadow:var(--shadow,none);padding:16px 18px;margin-bottom:16px}" +
    ".bdc-card h3{margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint,#8A93A0)}" +
    /* system map */
    ".bdc-map{display:flex;gap:0;align-items:stretch;overflow-x:auto}" +
    ".bdc-stage{flex:1 1 0;min-width:170px;display:flex;flex-direction:column;gap:8px}" +
    ".bdc-stage-t{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);margin-bottom:2px}" +
    ".bdc-arrow{align-self:center;padding:0 10px;color:var(--line-2,#D2CCBF);font-size:22px;flex:0 0 auto}" +
    ".bdc-node{border:1px solid var(--line,#E2DDD2);border-radius:10px;padding:9px 11px;background:var(--paper,#F7F5F0)}" +
    ".bdc-node .n{font-weight:600;font-size:13px;color:var(--ink,#1A2230);display:flex;align-items:center;gap:7px}" +
    ".bdc-node .m{font-size:11.5px;color:var(--ink-soft,#55606F);margin-top:3px;line-height:1.35}" +
    ".bdc-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}" +
    ".bdc-dot.ok{background:#3F8F6B}.bdc-dot.warn{background:#C9913F}.bdc-dot.off{background:#B8B2A6}.bdc-dot.err{background:var(--dining,#C9543F)}" +
    ".bdc-node.pend{opacity:.62;border-style:dashed}" +
    /* funnel */
    ".bdc-funnel{display:flex;gap:8px;flex-wrap:wrap}" +
    ".bdc-fchip{border:1px solid var(--line,#E2DDD2);border-radius:9px;padding:8px 12px;background:var(--paper,#F7F5F0);min-width:90px}" +
    ".bdc-fchip .c{font-size:20px;font-weight:700;color:var(--ink,#1A2230)}" +
    ".bdc-fchip .l{font-size:11px;color:var(--ink-soft,#55606F);margin-top:2px}" +
    /* queue */
    ".bdc-q{display:flex;flex-direction:column;gap:10px}" +
    ".bdc-item{border:1px solid var(--line,#E2DDD2);border-left-width:4px;border-radius:10px;padding:11px 14px;background:var(--paper,#F7F5F0)}" +
    ".bdc-item.email{border-left-color:var(--accent,#2D6E7E)}.bdc-item.call{border-left-color:var(--fitness,#3F8F6B)}.bdc-item.mail{border-left-color:var(--coffee,#A56B3D)}" +
    ".bdc-item-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
    ".bdc-tt{font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:2px 8px;border-radius:20px;background:var(--paper-2,#FCFBF8);border:1px solid var(--line,#E2DDD2);color:var(--ink-soft,#55606F)}" +
    ".bdc-who{font-weight:600;font-size:14px;color:var(--ink,#1A2230)}" +
    ".bdc-co{color:var(--ink-soft,#55606F);font-size:13px}" +
    ".bdc-due{margin-left:auto;font-size:12px;color:var(--ink-soft,#55606F)}" +
    ".bdc-due.late{color:var(--dining,#C9543F);font-weight:600}" +
    ".bdc-step{font-size:12px;color:var(--ink-faint,#8A93A0);margin-top:4px}" +
    ".bdc-prev{margin-top:8px;font-size:13px;color:var(--ink,#1A2230);white-space:pre-wrap;background:var(--paper-2,#FCFBF8);border:1px solid var(--line,#E2DDD2);border-radius:8px;padding:9px 11px;max-height:150px;overflow:auto}" +
    ".bdc-prev .sj{font-weight:600;display:block;margin-bottom:5px}" +
    ".bdc-item-act{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}" +
    ".bdc-item-act .bdc-btn{padding:5px 11px;font-size:12.5px}" +
    ".bdc-edit input,.bdc-edit textarea{width:100%;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;background:#fff;color:var(--ink,#1A2230);margin-top:8px}" +
    ".bdc-edit textarea{min-height:130px;resize:vertical}" +
    /* two-col */
    ".bdc-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}" +
    "@media(max-width:900px){.bdc-cols{grid-template-columns:1fr}.bdc-map{flex-direction:column}.bdc-arrow{transform:rotate(90deg);padding:4px 0}}" +
    ".bdc-tbl{width:100%;border-collapse:collapse;font-size:12.5px}" +
    ".bdc-tbl td{padding:6px 8px;border-top:1px solid var(--line,#E2DDD2);color:var(--ink,#1A2230);vertical-align:top}" +
    ".bdc-tbl td.mut{color:var(--ink-soft,#55606F)}" +
    ".bdc-empty{color:var(--ink-faint,#8A93A0);font-size:13px;padding:8px 2px}" +
    ".bdc-note{font-size:12px;color:var(--ink-faint,#8A93A0);margin-top:10px;line-height:1.5}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  /* ---------------- nav + section injection ---------------- */
  function inject() {
    var nav = $("vnav");
    var main = document.querySelector(".app-main");
    if (!nav || !main || $("bdView")) return false;

    var sec = document.createElement("section");
    sec.id = "bdView"; sec.style.display = "none";
    main.appendChild(sec);

    var btn = document.createElement("button");
    btn.className = "vnav-item"; btn.setAttribute("data-m", "bd"); btn.title = "BD Command Center";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.6"/></svg><span>BD</span>';
    btn.onclick = function () { window.showModule("bd"); };
    var settings = nav.querySelector('.vnav-item[data-m="settings"]');
    if (settings) nav.insertBefore(btn, settings); else nav.appendChild(btn);
    return true;
  }

  function wrapShowModule() {
    if (!window.showModule || window.showModule.__bdWrapped) return !!window.showModule;
    var orig = window.showModule;
    var wrapped = function (m) {
      var bd = $("bdView");
      if (m === "bd") {
        ["homeView", "marketModule", "clientsView", "settingsView"].forEach(function (id) { var el = $(id); if (el) el.style.display = "none"; });
        var dv = $("detailView"); if (dv) dv.classList.remove("show");
        if (bd) bd.style.display = "";
        document.querySelectorAll("#vnav .vnav-item").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-m") === "bd"); });
        render(); load();
        return;
      }
      if (bd) bd.style.display = "none";
      return orig(m);
    };
    wrapped.__bdWrapped = true;
    window.showModule = wrapped;
    return true;
  }

  /* ---------------- data ---------------- */
  function load() {
    if (S.loading) return;
    S.loading = true; S.err = null; render();
    token(function (t) {
      if (!t) { S.loading = false; S.err = "signin"; render(); return; }
      fetch("/.netlify/functions/bd-overview", { method: "POST", body: JSON.stringify({ token: t }) })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) { S.data = d; S.loading = false; render(); })
        .catch(function (e) { S.loading = false; S.err = String(e.message || e); render(); });
    });
  }

  function act(id, action, extra, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "…"; }
    token(function (t) {
      if (!t) return;
      fetch("/.netlify/functions/bd-queue-act", { method: "POST", body: JSON.stringify(Object.assign({ token: t, id: id, action: action }, extra || {})) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.error) { alert(d.error); load(); return; }
          S.editing = null; load();
        })
        .catch(function () { load(); });
    });
  }

  function runNow(btnEl) {
    btnEl.disabled = true; btnEl.textContent = "Running…";
    token(function (t) {
      if (!t) { btnEl.disabled = false; btnEl.textContent = "▶ Run engine now"; return; }
      fetch("/.netlify/functions/bd-cadence", { method: "POST", body: JSON.stringify({ token: t, run: "now" }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.error) alert(d.error);
          load();
        })
        .catch(function () { load(); })
        .finally(function () { btnEl.disabled = false; btnEl.textContent = "▶ Run engine now"; });
    });
  }
  // Approve-all: one click sends every drafted email (batches of 15 server-side;
  // keep calling while the server reports more remaining). Calls/mail stay manual.
  function sendAll(btnEl) {
    if (!confirm("Send every drafted email in the queue now?")) return;
    btnEl.disabled = true; btnEl.textContent = "Sending…";
    var failures = 0;
    function pass() {
      token(function (t) {
        if (!t) { load(); return; }
        fetch("/.netlify/functions/bd-queue-act", { method: "POST", body: JSON.stringify({ token: t, action: "send_all" }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.error) { alert(d.error); load(); return; }
            failures += (d && d.failed && d.failed.length) || 0;
            if (d && d.remaining > 0) { pass(); return; }
            if (failures) alert(failures + " email" + (failures === 1 ? "" : "s") + " failed to send — they're marked in the queue with the reason.");
            load();
          })
          .catch(function () { load(); });
      });
    }
    pass();
  }

  window.__bdAct = act; window.__bdRun = runNow; window.__bdLoad = load; window.__bdSendAll = sendAll;
  window.__bdEdit = function (id) { S.editing = id; render(); };
  window.__bdCancel = function () { S.editing = null; render(); };
  window.__bdSave = function (id, btn) {
    var sj = $("bdcSj-" + id), bo = $("bdcBo-" + id);
    act(id, "save", { subject: sj ? sj.value : null, body: bo ? bo.value : null }, btn);
  };

  /* ---------------- render ---------------- */
  function dot(state) { return '<span class="bdc-dot ' + state + '"></span>'; }

  function nodeHtml(name, state, meta, pending) {
    return '<div class="bdc-node' + (pending ? " pend" : "") + '"><div class="n">' + dot(state) + esc(name) + '</div><div class="m">' + meta + "</div></div>";
  }

  function mapHtml(d) {
    var cfg = (d && d.config) || {};
    var runs = (d && d.runs) || {};
    var cad = runs["bd-cadence"];
    var funnel = (d && d.funnel) || {};
    var total = (funnel.options || []).reduce(function (a, o) { return a + (o.count || 0); }, 0);
    var pending = ((d && d.queue) || []).length;
    var late = ((d && d.queue) || []).filter(function (q) { return overdue(q.due_date); }).length;
    var fresh = (d && d.freshness) || {};

    var srcs =
      nodeHtml("HubSpot roster", cfg.hubspot ? "ok" : "err",
        cfg.hubspot ? (funnel.connected ? total + " contacts tracked · " + (funnel.dueNow || 0) + " due a touch" : "connected") : "not connected — set HUBSPOT_PRIVATE_APP_TOKEN") +
      nodeHtml("Market data", fresh.market_spaces ? "ok" : "warn",
        fresh.market_spaces ? "spaces updated " + ago(fresh.market_spaces) : "no tracked spaces yet") +
      nodeHtml("Signal watcher", "off", "company news → congrats drafts · Phase 2", true);

    var eng =
      nodeHtml("Cadence engine", cad ? (cad.ok ? "ok" : "err") : "warn",
        cad ? ("ran " + ago(cad.ran_at) + (cad.counts ? " · drafted " + (cad.counts.drafted || 0) + ", skipped " + (cad.counts.skipped || 0) : "") + (cad.ok ? "" : " · " + esc(cad.note || "failed"))) : "hasn't run yet — press ▶ Run engine now") +
      nodeHtml("Report broadcasts", "off", "monthly market digest + building updates · Phase 3", true);

    var appr = nodeHtml("Morning queue", pending ? "warn" : "ok",
      pending ? pending + " waiting for you" + (late ? " · " + late + " overdue" : "") : "clear — nothing needs you");

    var out =
      nodeHtml("Email (1:1)", cfg.resend ? "ok" : "err",
        cfg.resend ? "sends as " + esc(cfg.from || "?") : "Resend not configured") +
      nodeHtml("Mail", "ok", "you print + hand-sign") +
      nodeHtml("Calls", "ok", "you dial from the queue");

    return '<div class="bdc-card"><h3>System map — how it all connects</h3><div class="bdc-map">' +
      '<div class="bdc-stage"><div class="bdc-stage-t">Sources</div>' + srcs + "</div>" +
      '<div class="bdc-arrow">→</div>' +
      '<div class="bdc-stage"><div class="bdc-stage-t">Engine · daily</div>' + eng + "</div>" +
      '<div class="bdc-arrow">→</div>' +
      '<div class="bdc-stage"><div class="bdc-stage-t">Your approval</div>' + appr + "</div>" +
      '<div class="bdc-arrow">→</div>' +
      '<div class="bdc-stage"><div class="bdc-stage-t">Out the door</div>' + out + "</div>" +
      "</div></div>";
  }

  function funnelHtml(d) {
    var f = (d && d.funnel) || {};
    if (!f.connected) return "";
    var chips = (f.options || []).map(function (o) {
      return '<div class="bdc-fchip"><div class="c">' + (o.count || 0) + '</div><div class="l">' + esc(o.label || o.value) + "</div></div>";
    }).join("");
    return '<div class="bdc-card"><h3>Program funnel (live from HubSpot)</h3><div class="bdc-funnel">' + (chips || '<div class="bdc-empty">No program statuses found.</div>') + "</div></div>";
  }

  function queueItemHtml(q) {
    var lateCls = overdue(q.due_date) ? " late" : "";
    var editing = S.editing === q.id;
    var prev;
    if (editing) {
      prev = '<div class="bdc-edit">' +
        (q.touch_type === "email" ? '<input id="bdcSj-' + q.id + '" value="' + esc(q.subject || "") + '" placeholder="Subject" />' : "") +
        '<textarea id="bdcBo-' + q.id + '">' + esc(q.body || "") + "</textarea>" +
        '<div class="bdc-item-act">' +
        '<button class="bdc-btn pri" onclick="__bdSave(\'' + q.id + "',this)\">Save</button>" +
        '<button class="bdc-btn" onclick="__bdCancel()">Cancel</button></div></div>';
    } else {
      prev = '<div class="bdc-prev">' +
        (q.subject ? '<span class="sj">' + esc(q.subject) + "</span>" : "") +
        esc(q.body || "") + "</div>" +
        '<div class="bdc-item-act">' +
        (q.touch_type === "email"
          ? '<button class="bdc-btn pri" onclick="__bdAct(\'' + q.id + "','send',null,this)\">Send now</button>" +
            '<button class="bdc-btn" onclick="__bdEdit(\'' + q.id + "')\">Edit</button>"
          : '<button class="bdc-btn pri" onclick="__bdAct(\'' + q.id + "','done',null,this)\">" + (q.touch_type === "call" ? "Call made" : "Printed & mailed") + "</button>") +
        '<button class="bdc-btn" onclick="__bdAct(\'' + q.id + "','skip',null,this)\">Skip</button>" +
        "</div>";
    }
    return '<div class="bdc-item ' + esc(q.touch_type) + '">' +
      '<div class="bdc-item-top"><span class="bdc-tt">' + esc(q.touch_type) + "</span>" +
      '<span class="bdc-who">' + esc(q.contact_name || "?") + "</span>" +
      '<span class="bdc-co">' + esc(q.company_name || "") + "</span>" +
      '<span class="bdc-due' + lateCls + '">due ' + fmtDate(q.due_date) + "</span></div>" +
      '<div class="bdc-step">' + esc(q.step_label || (q.source === "signal" ? "Signal: " + (q.signal_note || "") : "Manual touch")) + (q.email && q.touch_type === "email" ? " · to " + esc(q.email) : "") + (q.phone && q.touch_type === "call" ? " · " + esc(q.phone) : "") + "</div>" +
      prev + "</div>";
  }

  function healthHtml(d) {
    var runs = (d && d.runs) || {};
    var jobs = Object.keys(runs);
    var rows = jobs.map(function (j) {
      var r = runs[j];
      return "<tr><td>" + esc(j) + "</td><td>" + dot(r.ok ? "ok" : "err") + " " + ago(r.ran_at) + '</td><td class="mut">' + esc(r.note || "") + (r.counts ? " " + esc(JSON.stringify(r.counts)) : "") + "</td></tr>";
    }).join("");
    return '<div class="bdc-card"><h3>Automation health</h3>' +
      (rows ? '<table class="bdc-tbl">' + rows + "</table>" : '<div class="bdc-empty">No jobs have run yet. The cadence engine runs daily, or press ▶ Run engine now.</div>') +
      "</div>";
  }

  function activityHtml(d) {
    var a = (d && d.activity) || [];
    var rows = a.map(function (r) {
      var verb = { sent: "Sent", done: "Done", skipped: "Skipped", failed: "FAILED" }[r.status] || r.status;
      return "<tr><td>" + dot(r.status === "failed" ? "err" : "ok") + " " + esc(verb) + "</td><td>" + esc(r.touch_type) + " · " + esc(r.contact_name || "") + '</td><td class="mut">' + ago(r.sent_at) + "</td></tr>";
    }).join("");
    return '<div class="bdc-card"><h3>Recent activity</h3>' +
      (rows ? '<table class="bdc-tbl">' + rows + "</table>" : '<div class="bdc-empty">Nothing sent yet.</div>') +
      "</div>";
  }

  function render() {
    var el = $("bdView"); if (!el) return;
    if (S.err === "signin") { el.innerHTML = '<div class="bdc-card">Sign in to see the BD Command Center.</div>'; return; }

    var d = S.data;
    var head = '<div class="bdc-head"><div><h1>BD Command Center</h1><div class="sub">The machine does business development. You approve it over coffee.</div></div>' +
      '<div class="bdc-actions">' +
      '<button class="bdc-btn" onclick="__bdLoad()">' + (S.loading ? "Loading…" : "⟳ Refresh") + "</button>" +
      '<button class="bdc-btn pri" onclick="__bdRun(this)">▶ Run engine now</button>' +
      "</div></div>";

    if (!d) { el.innerHTML = head + '<div class="bdc-card"><div class="bdc-empty">' + (S.loading ? "Loading the system…" : (S.err ? "Couldn't load: " + esc(S.err) : "")) + "</div></div>"; return; }

    var q = d.queue || [];
    var pendEmails = q.filter(function (x) { return x.touch_type === "email"; }).length;
    var approveAll = pendEmails >= 2
      ? '<button class="bdc-btn pri" style="margin-left:auto" onclick="__bdSendAll(this)">✓ Approve &amp; send all emails (' + pendEmails + ")</button>"
      : "";
    var queueCard = '<div class="bdc-card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><h3 style="margin:0">Today’s queue — ' + q.length + " touch" + (q.length === 1 ? "" : "es") + " waiting</h3>" + approveAll + "</div>" +
      (q.length ? '<div class="bdc-q">' + q.map(queueItemHtml).join("") + "</div>"
        : '<div class="bdc-empty">Queue is clear. The engine drafts due touches every morning — to start someone, set their Marketing Program Status to active with a Next Touch Date in HubSpot, then ▶ Run engine now.</div>') +
      "</div>";

    el.innerHTML = head + mapHtml(d) + queueCard + funnelHtml(d) +
      '<div class="bdc-cols">' + healthHtml(d) + activityHtml(d) + "</div>" +
      '<div class="bdc-note">Emails send 1:1 through Resend as real personal mail (no blast headers). Replies pause a contact automatically the moment you mark their status Responded in HubSpot — the engine never touches paused, met, converted, or do-not-contact records. Signal watcher (CEO congrats from company news) and monthly report broadcasts light up as Phases 2–3.</div>';
  }

  /* ---------------- boot ---------------- */
  function boot() {
    if (!inject()) return false;
    wrapShowModule();
    var m = new URLSearchParams(location.search).get("m");
    if (m === "bd") setTimeout(function () { try { window.showModule("bd"); } catch (e) {} }, 400);
    return true;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else if (!boot()) {
    var tries = 0;
    var iv = setInterval(function () { if (boot() || ++tries > 20) clearInterval(iv); }, 250);
  }
})();
