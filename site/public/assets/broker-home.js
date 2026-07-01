// Broker Home — turns the Vantage Home tab into the broker's command-center dashboard:
// commission (YTD + pipeline), deals in the pipeline, open tasks, a "What's due" feed
// (tasks + checklist steps + lease critical dates) and smart next-step recommendations.
// Self-contained (like van.js): finds the page's Supabase session, injects its own CSS,
// and renders into #homeView. It wraps window.showModule so 'home' shows this dashboard.
// Everything links to deals.html?deal=<id>. Owned by the deal-flow session.
(function () {
  "use strict";
  var SUPA_URL = "https://siaoqjvvxuckyxpxftwt.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpYW9xanZ2eHVja3l4cHhmdHd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2OTU5MTMsImV4cCI6MjA5ODI3MTkxM30.HgWjVlB9e0rYgX-MCTee16UV5tZ6m-pCXXjwY1cu3b0";

  var STAGES = [["needs", "Needs & Research"], ["touring", "Touring"], ["evaluating", "Evaluating Options"], ["proposals", "Proposals"], ["negotiation", "Negotiation"], ["executed", "Executed"]];

  function getSB() { if (window.vantageSB) return window.vantageSB; if (window.supabase) { window.vantageSB = window.supabase.createClient(SUPA_URL, ANON); return window.vantageSB; } return null; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
  function money(v) { if (v == null) return "$0"; return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
  function fmtDate(d) { if (!d) return ""; var dt = new Date(d + "T00:00:00"); return isNaN(dt) ? esc(d) : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  function daysUntil(ds) { if (!ds) return null; var t = new Date(ds + "T00:00:00"), now = new Date(); now.setHours(0, 0, 0, 0); return Math.round((t - now) / 86400000); }
  function go(id) { return "location.href='deals.html?deal=" + id + "'"; }

  var cssDone = false;
  function injectCSS() {
    if (cssDone) return; cssDone = true;
    var css =
      ".bh-wrap{max-width:1120px;margin:0 auto;padding:26px 26px 60px}" +
      ".bh-h{font:800 26px 'Bricolage Grotesque',Inter,system-ui,sans-serif;color:var(--ink,#1a2230)}" +
      ".bh-sub{font:500 13px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);margin:3px 0 16px}" +
      ".bh-qa{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}" +
      ".bh-qa button{font:600 12.5px Inter,system-ui,sans-serif;border-radius:9px;padding:9px 15px;cursor:pointer;border:1px solid var(--line-2,#d8d3c7);background:var(--paper,#f3efe6);color:var(--ink-soft,#55606f)}" +
      ".bh-qa button.pri{background:var(--building,#1b2a4a);color:#fff;border-color:var(--building,#1b2a4a)}" +
      ".bh-qa button:hover{filter:brightness(1.05)}" +
      ".bh-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}" +
      ".bh-stat{background:var(--paper-2,#fff);border:1px solid var(--line,#e7e3d9);border-radius:13px;padding:14px 16px}" +
      ".bh-stat .k{font:600 10px Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint,#8a92a0)}" +
      ".bh-stat .v{font:800 26px 'Bricolage Grotesque',Inter,sans-serif;color:var(--ink,#1a2230);margin-top:4px;line-height:1}" +
      ".bh-stat .s{font:500 11px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".bh-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}" +
      ".bh-panel{background:var(--paper-2,#fff);border:1px solid var(--line,#e7e3d9);border-radius:14px;padding:8px 6px 10px}" +
      ".bh-panel-h{font:700 13px 'Bricolage Grotesque',Inter,sans-serif;color:var(--ink,#1a2230);padding:9px 12px 10px;border-bottom:1px solid var(--line,#e7e3d9);display:flex;justify-content:space-between;align-items:center}" +
      ".bh-empty{font:400 12px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);padding:16px 12px}" +
      ".bh-due{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line,#e7e3d9);cursor:pointer}" +
      ".bh-due:last-child{border-bottom:0}.bh-due:hover{background:var(--paper,#f3efe6)}" +
      ".bh-when{font:700 11px 'JetBrains Mono',monospace;color:var(--ink-faint,#8a92a0);width:56px;flex:none}" +
      ".bh-due.over .bh-when{color:var(--dining,#c9543f)}" +
      ".bh-l{flex:1;font:500 12.5px Inter,system-ui,sans-serif;color:var(--ink,#1a2230);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".bh-l em{color:var(--ink-faint,#8a92a0);font-style:normal}" +
      ".bh-kind{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:7px;vertical-align:1px;background:var(--ink-faint,#8a92a0)}" +
      ".bh-kind.task{background:var(--accent,#2d6e7e)}.bh-kind.step{background:#b5651d}.bh-kind.critical{background:var(--dining,#c9543f)}" +
      ".bh-date{font:500 11px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);flex:none}" +
      ".bh-rec{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line,#e7e3d9);cursor:pointer}" +
      ".bh-rec:last-child{border-bottom:0}.bh-rec:hover{background:var(--paper,#f3efe6)}" +
      ".bh-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--ink-faint,#8a92a0)}" +
      ".bh-rec.s2 .bh-dot{background:var(--dining,#c9543f)}.bh-rec.s1 .bh-dot{background:#b5651d}.bh-rec.s0 .bh-dot{background:var(--accent,#2d6e7e)}" +
      ".bh-rt{flex:1;font:500 12.5px Inter,system-ui,sans-serif;color:var(--ink,#1a2230)}" +
      ".bh-go{color:var(--ink-faint,#8a92a0);font-weight:700;flex:none}.bh-rec:hover .bh-go{color:var(--accent,#2d6e7e)}" +
      "@media(max-width:760px){.bh-stats{grid-template-columns:repeat(2,1fr)}.bh-grid{grid-template-columns:1fr}}";
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  function statCard(k, v, sub) { return '<div class="bh-stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>'; }
  function byStageMini(active) { var c = {}; active.forEach(function (d) { c[d.stage] = (c[d.stage] || 0) + 1; }); return STAGES.filter(function (s) { return c[s[0]]; }).map(function (s) { return c[s[0]] + " " + s[1].toLowerCase(); }).join(" · "); }
  function feedRow(f, byId) {
    var d = byId[f.dealId], client = d ? (d.client_name || "Deal") : "", du = daysUntil(f.date), over = du < 0;
    var when = over ? (Math.abs(du) + "d late") : (du === 0 ? "today" : (du + "d"));
    return '<div class="bh-due' + (over ? " over" : "") + '"' + (f.dealId ? ' onclick="' + go(f.dealId) + '"' : "") + ">" +
      '<span class="bh-when">' + esc(when) + "</span>" +
      '<span class="bh-l"><span class="bh-kind ' + f.kind + '"></span>' + esc(f.label) + (client ? ' <em>· ' + esc(client) + "</em>" : "") + "</span>" +
      '<span class="bh-date">' + fmtDate(f.date) + "</span></div>";
  }
  function recRow(r) { return '<div class="bh-rec s' + r.sev + '"' + (r.dealId ? ' onclick="' + go(r.dealId) + '"' : "") + '><span class="bh-dot"></span><span class="bh-rt">' + esc(r.text) + '</span><span class="bh-go">→</span></div>'; }
  function buildRecs(active, steps, tasks, absts, byId) {
    var recs = [];
    steps.forEach(function (s) { var du = daysUntil(s.due_date); if (du != null && du < 0) { var d = byId[s.deal_id]; recs.push({ sev: 2, dealId: s.deal_id, text: "You're behind on “" + s.label + "”" + (d ? " for " + (d.client_name || "a client") : "") }); } });
    tasks.forEach(function (t) { if (!t.done && t.due_date) { var du = daysUntil(t.due_date); if (du != null && du < 0) { var d = byId[t.deal_id]; recs.push({ sev: 2, dealId: t.deal_id, text: "Overdue task: " + t.title + (d && d.client_name ? " — " + d.client_name : "") }); } } });
    absts.forEach(function (a) { if (a.expiration_date) { var du = daysUntil(a.expiration_date); if (du != null && du >= 0 && du <= 120) { var d = byId[a.deal_id]; recs.push({ sev: 1, dealId: a.deal_id, text: (d && d.client_name ? d.client_name : "A client") + "’s lease expires in " + du + " days — start the renewal conversation" }); } } });
    var td = {}; tasks.forEach(function (t) { if (!t.done && t.deal_id) td[t.deal_id] = true; });
    active.forEach(function (d) { if (!td[d.id]) recs.push({ sev: 0, dealId: d.id, text: "No next action set for " + (d.client_name || "a deal") + " — add a task" }); });
    active.forEach(function (d) { if (d.commission_amount == null && d.commission_pct == null) recs.push({ sev: 0, dealId: d.id, text: "Add commission terms for " + (d.client_name || "a deal") }); });
    recs.sort(function (a, b) { return b.sev - a.sev; });
    return recs.slice(0, 8);
  }

  async function renderBrokerHome(el) {
    injectCSS();
    var email = (document.getElementById("userEmail") || {}).textContent || "";
    var name = email ? email.split("@")[0] : "";
    el.innerHTML = '<div class="bh-wrap"><div class="bh-h">Welcome back' + (name ? ", " + esc(name) : "") + '</div><div class="bh-sub">Loading your book of business…</div></div>';

    var client = getSB();
    if (!client) { el.innerHTML = '<div class="bh-wrap"><div class="bh-h">Welcome back</div><div class="bh-sub">Sign in to see your dashboard.</div></div>'; return; }

    var deals = [], tasks = [], steps = [], absts = [];
    try { deals = (await client.from("deals").select("*").order("created_at", { ascending: false })).data || []; } catch (e) {}
    try { tasks = (await client.from("deal_tasks").select("*").order("due_date", { ascending: true, nullsFirst: false })).data || []; } catch (e) {}
    try { steps = (await client.from("deal_steps").select("deal_id,label,due_date,status").not("due_date", "is", null).in("status", ["pending", "active"])).data || []; } catch (e) {}
    try { absts = (await client.from("lease_abstracts").select("deal_id,key_dates,expiration_date")).data || []; } catch (e) {}

    var year = new Date().getFullYear();
    var byId = {}; deals.forEach(function (d) { byId[d.id] = d; });
    var active = deals.filter(function (d) { return d.stage !== "dead" && d.stage !== "executed"; });
    var pipeComm = active.reduce(function (s, d) { return s + (num(d.commission_amount) || 0); }, 0);
    var collectedYTD = deals.filter(function (d) { return d.commission_status === "paid" && d.commission_paid_on && (new Date(d.commission_paid_on)).getFullYear() === year; }).reduce(function (s, d) { return s + (num(d.commission_amount) || 0); }, 0);
    var collectedAll = deals.filter(function (d) { return d.commission_status === "paid"; }).reduce(function (s, d) { return s + (num(d.commission_amount) || 0); }, 0);
    var openTasks = tasks.filter(function (t) { return !t.done; });
    var overdue = 0;
    openTasks.forEach(function (t) { if (t.due_date && daysUntil(t.due_date) < 0) overdue++; });
    steps.forEach(function (s) { if (daysUntil(s.due_date) < 0) overdue++; });

    var feed = [];
    openTasks.forEach(function (t) { if (t.due_date) feed.push({ date: t.due_date, kind: "task", label: t.title, dealId: t.deal_id }); });
    steps.forEach(function (s) { feed.push({ date: s.due_date, kind: "step", label: s.label, dealId: s.deal_id }); });
    absts.forEach(function (a) { (a.key_dates || []).forEach(function (k) { if (k && k.date) feed.push({ date: k.date, kind: "critical", label: (k.label || "Critical date"), dealId: a.deal_id }); }); if (a.expiration_date) feed.push({ date: a.expiration_date, kind: "critical", label: "Lease expiration", dealId: a.deal_id }); });
    feed.sort(function (x, y) { return x.date < y.date ? -1 : (x.date > y.date ? 1 : 0); });
    var feedItems = feed.filter(function (f) { var du = daysUntil(f.date); return du != null && du <= 60; }).slice(0, 14);

    var recs = buildRecs(active, steps, tasks, absts, byId);

    el.innerHTML =
      '<div class="bh-wrap">' +
      '<div class="bh-h">Welcome back' + (name ? ", " + esc(name) : "") + '</div>' +
      '<div class="bh-sub">Here\'s your book of business — and what needs your attention today.</div>' +
      '<div class="bh-qa">' +
        '<button class="pri" onclick="location.href=\'deals.html\'">Open deal pipeline →</button>' +
        (window.Van ? '<button onclick="Van.open()">✨ Ask Van</button>' : '') +
        (window.openQuestionnaire ? '<button onclick="openQuestionnaire()">+ New questionnaire</button>' : '') +
      '</div>' +
      '<div class="bh-stats">' +
        statCard("Commission collected (YTD)", money(collectedYTD), collectedAll > collectedYTD ? ("All-time " + money(collectedAll)) : "") +
        statCard("Pipeline commission", money(pipeComm), active.length + " active deal" + (active.length === 1 ? "" : "s")) +
        statCard("Deals in pipeline", String(active.length), byStageMini(active)) +
        statCard("Open tasks", String(openTasks.length), overdue ? (overdue + " overdue") : "on track") +
      '</div>' +
      (deals.length ?
        '<div class="bh-grid">' +
          '<div class="bh-panel"><div class="bh-panel-h">What\'s due</div>' +
            (feedItems.length ? feedItems.map(function (f) { return feedRow(f, byId); }).join("") : '<div class="bh-empty">Nothing due in the next 60 days.</div>') +
          '</div>' +
          '<div class="bh-panel"><div class="bh-panel-h">Recommended next steps</div>' +
            (recs.length ? recs.map(recRow).join("") : '<div class="bh-empty">You\'re all caught up. Nice work 🎉</div>') +
          '</div>' +
        '</div>'
        : '<div class="bh-panel"><div class="bh-empty">No deals yet. <a href="deals.html">Open the pipeline</a> to start tracking a client.</div></div>') +
      '</div>';
  }

  window.renderBrokerHome = renderBrokerHome;

  // Take over the Home tab: after the app switches to 'home', render the dashboard into #homeView.
  var _orig = window.showModule;
  if (typeof _orig === "function") {
    window.showModule = function (m) {
      _orig(m);
      if (m === "home") { var el = document.getElementById("homeView"); if (el) renderBrokerHome(el); }
    };
  }
})();
