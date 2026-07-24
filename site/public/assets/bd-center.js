/* Vantage — BD module (self-contained, market-spaces.js pattern).
 *
 * BD is a full module with a Market-style sub-menu:
 *   Command Center      — landing summary (system map, morning queue, funnel, health)
 *   Newsletter          — ISSUE PORTAL: clips + a working draft per monthly issue
 *                         (planning next month, months ahead queued, sent archive)
 *   Marketing Programs  — the programs we run (10-step cold outreach first; more
 *                         later) + a read-only board of everyone in them; click a
 *                         program to see its full cadence with day gaps
 *   Signals             — manage Google-Alert RSS feeds + review signal history
 *   Templates           — template sets, high-level; click into a program to
 *                         redline each step's copy (engine sends it verbatim)
 *
 * Self-contained: injects its own .bdc- CSS, nav item + sub-menu + <section>,
 * and wraps window.showModule. index.html diff = one <script> tag.
 * Data: bd-overview / bd-queue-act / bd-cadence / bd-program functions, plus
 * direct Supabase reads/writes (RLS + stamp triggers) for clips/feeds/templates/issues.
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
      var s = r && r.data && r.data.session;
      cb(s ? s.access_token : null, s ? s.user : null);
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

  /* ---- issue-month helpers ('YYYY-MM') ---- */
  function ymKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function nextIssueKey() {
    var d = new Date();
    if (d.getDate() > 7) d.setMonth(d.getMonth() + 1);
    d.setDate(1);
    return ymKey(d);
  }
  function ymAdd(ym, n) {
    var p = String(ym).split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1 + n, 1);
    return ymKey(d);
  }
  function ymLabel(ym) {
    var p = String(ym || "").split("-");
    if (p.length < 2) return String(ym || "");
    return new Date(Number(p[0]), Number(p[1]) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  /* ---- the 10-step program, client copy (mirrors functions/_bd.js PLAN) ---- */
  var PLAN = [
    { step: 1, day: 1, type: "mail", label: "Brochure + hand-written note" },
    { step: 2, day: 9, type: "call", label: "Call #1 — reference the brochure (VM ok, bridge email after)" },
    { step: 3, day: 15, type: "email", label: "Email #1 — submarket snapshot" },
    { step: 4, day: 22, type: "call", label: "Call #2 — no voicemail" },
    { step: 5, day: 28, type: "email", label: "Email #2 — building-specific hook" },
    { step: 6, day: 35, type: "mail", label: "Unique-value letter, hand-signed" },
    { step: 7, day: 41, type: "call", label: "Call #3 — VM referencing the letter" },
    { step: 8, day: 48, type: "email", label: "Email #3 — direct meeting ask" },
    { step: 9, day: 54, type: "call", label: "Call #4 — no voicemail" },
    { step: 10, day: 61, type: "email", label: "Email #4 — professional breakup" }
  ];

  var VIEWS = { overview: "Command Center", newsletter: "Newsletter", program: "Marketing Programs", signals: "Signals", templates: "Templates" };
  var S = {
    view: "overview",
    data: null, loading: false, err: null, editing: null,
    clips: null, clipsErr: null, issues: null, issue: null,
    feeds: null, sigHist: null, sigErr: null,
    program: null, programErr: null, progDetail: false,
    templates: null, tplErr: null, tplEditing: null, tplDetail: false
  };

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
    ".bdc-btn.dngr:hover{border-color:var(--dining,#C9543F);color:var(--dining,#C9543F)}" +
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
    ".bdc-tt.email{border-color:var(--accent,#2D6E7E);color:var(--accent,#2D6E7E)}" +
    ".bdc-tt.call{border-color:var(--fitness,#3F8F6B);color:var(--fitness,#3F8F6B)}" +
    ".bdc-tt.mail{border-color:var(--coffee,#A56B3D);color:var(--coffee,#A56B3D)}" +
    ".bdc-who{font-weight:600;font-size:14px;color:var(--ink,#1A2230)}" +
    ".bdc-co{color:var(--ink-soft,#55606F);font-size:13px}" +
    ".bdc-due{margin-left:auto;font-size:12px;color:var(--ink-soft,#55606F)}" +
    ".bdc-due.late{color:var(--dining,#C9543F);font-weight:600}" +
    ".bdc-step{font-size:12px;color:var(--ink-faint,#8A93A0);margin-top:4px}" +
    ".bdc-prev{margin-top:8px;font-size:13px;color:var(--ink,#1A2230);white-space:pre-wrap;background:var(--paper-2,#FCFBF8);border:1px solid var(--line,#E2DDD2);border-radius:8px;padding:9px 11px;max-height:150px;overflow:auto}" +
    ".bdc-prev .sj{font-weight:600;display:block;margin-bottom:5px}" +
    ".bdc-item-act{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}" +
    ".bdc-item-act .bdc-btn{padding:5px 11px;font-size:12.5px}" +
    ".bdc-edit input,.bdc-edit textarea,.bdc-form input,.bdc-form textarea,.bdc-form select{width:100%;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;background:#fff;color:var(--ink,#1A2230)}" +
    ".bdc-edit input,.bdc-edit textarea{margin-top:8px}" +
    ".bdc-edit textarea{min-height:130px;resize:vertical}" +
    ".bdc-form{display:grid;gap:8px}" +
    ".bdc-form-row{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:start}" +
    "@media(max-width:800px){.bdc-form-row{grid-template-columns:1fr}}" +
    /* issue chips */
    ".bdc-issues{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}" +
    ".bdc-ichip{border:1px solid var(--line,#E2DDD2);border-radius:20px;padding:6px 14px;background:var(--paper-2,#FCFBF8);cursor:pointer;font-size:13px;color:var(--ink,#1A2230)}" +
    ".bdc-ichip:hover{border-color:var(--accent,#2D6E7E)}" +
    ".bdc-ichip.on{background:var(--accent,#2D6E7E);border-color:var(--accent,#2D6E7E);color:#fff}" +
    ".bdc-ichip .tag{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;opacity:.75;margin-left:6px}" +
    ".bdc-idiv{color:var(--ink-faint,#8A93A0);font-size:11px;letter-spacing:.08em;text-transform:uppercase;margin:0 4px}" +
    /* clips */
    ".bdc-clip{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line,#E2DDD2);border-radius:10px;padding:10px 13px;background:var(--paper,#F7F5F0);margin-bottom:8px}" +
    ".bdc-clip.killed{opacity:.5}" +
    ".bdc-clip .bdy{flex:1 1 auto;min-width:0}" +
    ".bdc-clip .t{font-weight:600;font-size:13.5px;color:var(--ink,#1A2230)}" +
    ".bdc-clip .t a{color:var(--accent,#2D6E7E);text-decoration:none}" +
    ".bdc-clip .nt{font-size:12.5px;color:var(--ink-soft,#55606F);margin-top:3px;white-space:pre-wrap}" +
    ".bdc-clip .mt{font-size:11px;color:var(--ink-faint,#8A93A0);margin-top:4px}" +
    ".bdc-clip .acts{display:flex;gap:6px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}" +
    ".bdc-clip .acts .bdc-btn{padding:4px 9px;font-size:12px}" +
    ".bdc-src{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:1px 7px;border-radius:20px;border:1px solid var(--line,#E2DDD2);color:var(--ink-soft,#55606F);background:var(--paper-2,#FCFBF8)}" +
    /* program cards + board */
    ".bdc-progcard{border:1px solid var(--line,#E2DDD2);border-radius:12px;padding:14px 16px;background:var(--paper,#F7F5F0);cursor:pointer;transition:border-color .12s}" +
    ".bdc-progcard:hover{border-color:var(--accent,#2D6E7E)}" +
    ".bdc-progcard .pn{font-weight:700;font-size:15px;color:var(--ink,#1A2230)}" +
    ".bdc-progcard .pm{font-size:12.5px;color:var(--ink-soft,#55606F);margin-top:4px;line-height:1.4}" +
    ".bdc-progcard .pv{font-size:12.5px;color:var(--accent,#2D6E7E);margin-top:8px;font-weight:600}" +
    ".bdc-proggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}" +
    ".bdc-board{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px;align-items:start}" +
    ".bdc-col{background:var(--paper,#F7F5F0);border:1px solid var(--line,#E2DDD2);border-radius:10px;padding:10px}" +
    ".bdc-col h4{margin:0 0 8px;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-soft,#55606F);display:flex;justify-content:space-between}" +
    ".bdc-pcard{background:var(--paper-2,#FCFBF8);border:1px solid var(--line,#E2DDD2);border-radius:8px;padding:8px 10px;margin-bottom:7px}" +
    ".bdc-pcard .nm{font-weight:600;font-size:13px;color:var(--ink,#1A2230)}" +
    ".bdc-pcard .nm a{color:inherit;text-decoration:none}" +
    ".bdc-pcard .nm a:hover{color:var(--accent,#2D6E7E)}" +
    ".bdc-pcard .co{font-size:12px;color:var(--ink-soft,#55606F)}" +
    ".bdc-pcard .st{font-size:11px;color:var(--ink-faint,#8A93A0);margin-top:3px}" +
    ".bdc-stepchip{display:inline-block;font-size:10.5px;font-weight:700;border-radius:20px;padding:1px 7px;background:var(--accent,#2D6E7E);color:#fff;margin-right:5px}" +
    /* cadence timeline */
    ".bdc-tl{position:relative;margin:6px 0 0 10px;padding-left:26px;border-left:2px solid var(--line-2,#D2CCBF)}" +
    ".bdc-tlstep{position:relative;padding:0 0 6px}" +
    ".bdc-tlstep::before{content:\"\";position:absolute;left:-33px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--paper-2,#FCFBF8);border:3px solid var(--accent,#2D6E7E)}" +
    ".bdc-tlstep.mail::before{border-color:var(--coffee,#A56B3D)}" +
    ".bdc-tlstep.call::before{border-color:var(--fitness,#3F8F6B)}" +
    ".bdc-tlhead{display:flex;align-items:center;gap:9px;flex-wrap:wrap}" +
    ".bdc-tlday{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-faint,#8A93A0);min-width:52px}" +
    ".bdc-tllabel{font-weight:600;font-size:13.5px;color:var(--ink,#1A2230)}" +
    ".bdc-tlgap{display:flex;align-items:center;gap:8px;color:var(--ink-faint,#8A93A0);font-size:11.5px;padding:8px 0 8px 2px;font-style:italic}" +
    ".bdc-tlgap::before{content:\"↓\";font-style:normal;color:var(--line-2,#D2CCBF);font-size:15px}" +
    ".bdc-tlbody{margin-top:7px}" +
    /* two-col + tables */
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
    btn.className = "vnav-item has-sub"; btn.id = "bdNavBtn"; btn.setAttribute("data-m", "bd"); btn.title = "BD";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.6"/></svg><span>BD</span>' +
      '<svg class="vnav-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    btn.onclick = function () { S.view = "overview"; window.showModule("bd"); };

    var sub = document.createElement("div");
    sub.className = "vnav-sub"; sub.id = "bdSub";
    sub.innerHTML = Object.keys(VIEWS).map(function (v) {
      return '<button class="vnav-subitem' + (v === "overview" ? " on" : "") + '" data-bsv="' + v + '">' + esc(VIEWS[v]) + "</button>";
    }).join("");
    sub.addEventListener("click", function (e) {
      var b = e.target.closest("[data-bsv]");
      if (!b) return;
      S.view = b.getAttribute("data-bsv");
      S.progDetail = false; S.tplDetail = false;
      window.showModule("bd");
    });

    var settings = nav.querySelector('.vnav-item[data-m="settings"]');
    if (settings) { nav.insertBefore(btn, settings); nav.insertBefore(sub, settings); }
    else { nav.appendChild(btn); nav.appendChild(sub); }
    return true;
  }

  function setSubState(onBd) {
    var btn = $("bdNavBtn"), sub = $("bdSub");
    if (btn) btn.classList.toggle("sub-open", !!onBd);
    if (sub) {
      sub.classList.toggle("open", !!onBd);
      sub.querySelectorAll(".vnav-subitem").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-bsv") === S.view); });
    }
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
        setSubState(true);
        render(); loadView();
        return;
      }
      if (bd) bd.style.display = "none";
      setSubState(false);
      return orig(m);
    };
    wrapped.__bdWrapped = true;
    window.showModule = wrapped;
    return true;
  }

  /* ---------------- data: overview ---------------- */
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
        .then(function (d) { if (d && d.error) alert(d.error); load(); })
        .catch(function () { load(); })
        .finally(function () { btnEl.disabled = false; btnEl.textContent = "▶ Run engine now"; });
    });
  }

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

  /* ---------------- data: newsletter (clips + issues) ---------------- */
  function sbErr(e) { return (e && (e.message || e.error_description || e.hint)) || "database error"; }

  function loadClips(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.clipsErr = "signin"; render(); return; }
    if (S.clips && !force) { render(); return; }
    if (!S.issue) S.issue = nextIssueKey();
    sb.from("bd_clips").select("*").order("created_at", { ascending: false }).limit(300)
      .then(function (r) {
        if (r.error) { S.clipsErr = sbErr(r.error); render(); return; }
        S.clips = r.data || []; S.clipsErr = null;
        sb.from("bd_newsletters").select("*").order("issue_month", { ascending: false })
          .then(function (n) { S.issues = (n && n.data) || []; render(); });
      });
  }
  function issueRow(ym) {
    return (S.issues || []).find(function (i) { return i.issue_month === ym; }) || null;
  }
  function selIssue(ym) { S.issue = ym; render(); }
  function addClip(btn) {
    var url = ($("bdcClipUrl") || {}).value || "", note = ($("bdcClipNote") || {}).value || "";
    url = url.trim(); note = note.trim();
    if (!url && !note) { alert("Paste a link or write a note first."); return; }
    var sb = getSB(); if (!sb) return;
    btn.disabled = true;
    var title = null;
    try { if (url) title = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { if (url) { note = (note ? note + "\n" : "") + url; url = null; } }
    sb.from("bd_clips").insert({ url: url || null, title: title, note: note || null, source: "manual", issue_month: S.issue })
      .then(function (r) {
        btn.disabled = false;
        if (r.error) { alert("Couldn't save the clip: " + sbErr(r.error)); return; }
        if ($("bdcClipUrl")) $("bdcClipUrl").value = "";
        if ($("bdcClipNote")) $("bdcClipNote").value = "";
        loadClips(true);
      });
  }
  function clipStatus(id, status) {
    var sb = getSB(); if (!sb) return;
    sb.from("bd_clips").update({ status: status }).eq("id", id).then(function (r) {
      if (r.error) alert(sbErr(r.error));
      loadClips(true);
    });
  }
  function clipPush(id) {
    var sb = getSB(); if (!sb) return;
    var target = ymAdd(S.issue || nextIssueKey(), 1);
    sb.from("bd_clips").update({ issue_month: target }).eq("id", id).then(function () { loadClips(true); });
  }
  function uploadClip(input) {
    var f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { alert("Keep uploads under 15 MB."); return; }
    var sb = getSB(); if (!sb || !sb.storage) return;
    token(function (t, user) {
      if (!user) return;
      sb.from("profiles").select("org_id").eq("id", user.id).single().then(function (pr) {
        var org = pr && pr.data && pr.data.org_id;
        if (!org) { alert("No org on your profile."); return; }
        var path = org + "/" + Date.now() + "-" + f.name.replace(/[^A-Za-z0-9._-]/g, "_");
        sb.storage.from("bd-clips").upload(path, f).then(function (ur) {
          if (ur.error) { alert("Upload failed: " + sbErr(ur.error)); return; }
          sb.from("bd_clips").insert({ title: f.name, source: "upload", file_path: path, issue_month: S.issue }).then(function () { loadClips(true); });
        });
      });
    });
  }
  function openClipFile(path) {
    var sb = getSB(); if (!sb || !sb.storage) return;
    sb.storage.from("bd-clips").createSignedUrl(path, 3600).then(function (r) {
      var u = r && r.data && (r.data.signedUrl || r.data.signedURL);
      if (u) window.open(u, "_blank"); else alert("Couldn't open the file.");
    });
  }
  function issueSave(btn, markSent) {
    var sb = getSB(); if (!sb) return;
    var ym = S.issue;
    var subject = ($("bdcIssSj") || {}).value || "";
    var body = ($("bdcIssBo") || {}).value || "";
    if (markSent && !confirm("Mark the " + ymLabel(ym) + " issue as SENT? It moves to the archive, and its kept clips get stamped as used.")) return;
    btn.disabled = true;
    var row = issueRow(ym);
    var patch = { subject: subject || null, body: body || null };
    if (markSent) { patch.status = "sent"; patch.sent_at = new Date().toISOString(); }
    else if (!row || row.status !== "sent") { patch.status = (subject || body) ? "draft" : "planning"; }
    var op = row
      ? sb.from("bd_newsletters").update(patch).eq("id", row.id)
      : sb.from("bd_newsletters").insert(Object.assign({ issue_month: ym }, patch));
    op.then(function (r) {
      btn.disabled = false;
      if (r.error) { alert("Couldn't save the issue: " + sbErr(r.error)); return; }
      if (markSent) {
        // stamp this issue's kept clips as shipped
        sb.from("bd_clips").update({ status: "used", month_used: ym }).eq("issue_month", ym).eq("status", "kept")
          .then(function () { loadClips(true); });
      } else loadClips(true);
    });
  }

  /* ---------------- data: signals / program / templates ---------------- */
  function loadSignals(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.sigErr = "signin"; render(); return; }
    if (S.feeds && !force) { render(); return; }
    sb.from("bd_alert_feeds").select("*").order("created_at", { ascending: false }).then(function (r) {
      if (r.error) { S.sigErr = sbErr(r.error); render(); return; }
      S.feeds = r.data || []; S.sigErr = null;
      sb.from("bd_queue").select("id,contact_name,company_name,subject,signal_note,status,created_at").eq("source", "signal").order("created_at", { ascending: false }).limit(30)
        .then(function (h) { S.sigHist = (h && h.data) || []; render(); });
    });
  }
  function addFeed(btn) {
    var url = ($("bdcFeedUrl") || {}).value || "", label = ($("bdcFeedLabel") || {}).value || "", kind = ($("bdcFeedKind") || {}).value || "company", co = ($("bdcFeedCo") || {}).value || "";
    url = url.trim(); label = label.trim(); co = co.trim();
    if (!/^https?:\/\/.+google\.com\/alerts\/feeds\//.test(url)) { alert("That doesn't look like a Google Alerts feed URL (google.com/alerts/feeds/…). In the alert's settings pick 'Deliver to: RSS feed', then copy the RSS link."); return; }
    if (!label) { alert("Give the feed a label — usually the alert query, e.g. \"Acme Studios\"."); return; }
    var sb = getSB(); if (!sb) return;
    btn.disabled = true;
    sb.from("bd_alert_feeds").insert({ feed_url: url, label: label, kind: kind, company_name: co || (kind === "company" ? label : null) })
      .then(function (r) {
        btn.disabled = false;
        if (r.error) { alert("Couldn't add the feed: " + sbErr(r.error)); return; }
        ["bdcFeedUrl", "bdcFeedLabel", "bdcFeedCo"].forEach(function (i) { if ($(i)) $(i).value = ""; });
        loadSignals(true);
      });
  }
  function feedActive(id, active) {
    var sb = getSB(); if (!sb) return;
    sb.from("bd_alert_feeds").update({ active: active }).eq("id", id).then(function () { loadSignals(true); });
  }
  function feedDelete(id) {
    if (!confirm("Remove this feed from the watcher? (The alert itself still exists in Google — delete it there too if you're done with it.)")) return;
    var sb = getSB(); if (!sb) return;
    sb.from("bd_alert_feeds").delete().eq("id", id).then(function () { loadSignals(true); });
  }

  function loadProgram(force) {
    if (S.program && !force) { render(); return; }
    token(function (t) {
      if (!t) { S.programErr = "signin"; render(); return; }
      fetch("/.netlify/functions/bd-program", { method: "POST", body: JSON.stringify({ token: t }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { S.program = d; S.programErr = d && d.error ? d.error : null; render(); })
        .catch(function (e) { S.programErr = String(e.message || e); render(); });
    });
  }

  function loadTemplates(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.tplErr = "signin"; render(); return; }
    if (S.templates && !force) { render(); return; }
    sb.from("bd_templates").select("*").order("step").then(function (r) {
      if (r.error) { S.tplErr = sbErr(r.error); } else { S.templates = r.data || []; S.tplErr = null; }
      render();
    });
  }
  function tplSave(id, btn) {
    var sj = $("bdcTplSj-" + id), bo = $("bdcTplBo-" + id);
    var sb = getSB(); if (!sb) return;
    btn.disabled = true;
    sb.from("bd_templates").update({ subject: sj ? (sj.value || null) : null, body: bo ? bo.value : "" }).eq("id", id)
      .then(function (r) {
        btn.disabled = false;
        if (r.error) { alert("Couldn't save: " + sbErr(r.error)); return; }
        S.tplEditing = null; loadTemplates(true);
      });
  }

  function loadView() {
    if (S.view === "overview") load();
    else if (S.view === "newsletter") loadClips();
    else if (S.view === "signals") loadSignals();
    else if (S.view === "program") { loadProgram(); loadTemplates(); }
    else if (S.view === "templates") loadTemplates();
  }

  /* ---------------- globals for onclick ---------------- */
  window.__bdAct = act; window.__bdRun = runNow; window.__bdLoad = load; window.__bdSendAll = sendAll;
  window.__bdEdit = function (id) { S.editing = id; render(); };
  window.__bdCancel = function () { S.editing = null; render(); };
  window.__bdSave = function (id, btn) {
    var sj = $("bdcSj-" + id), bo = $("bdcBo-" + id);
    act(id, "save", { subject: sj ? sj.value : null, body: bo ? bo.value : null }, btn);
  };
  window.__bdAddClip = addClip; window.__bdClipStatus = clipStatus; window.__bdClipPush = clipPush;
  window.__bdUploadClip = uploadClip; window.__bdOpenClipFile = openClipFile;
  window.__bdIssueSel = selIssue;
  window.__bdIssueSave = function (btn) { issueSave(btn, false); };
  window.__bdIssueSent = function (btn) { issueSave(btn, true); };
  window.__bdAddFeed = addFeed; window.__bdFeedActive = feedActive; window.__bdFeedDelete = feedDelete;
  window.__bdTplEdit = function (id) { S.tplEditing = id; render(); };
  window.__bdTplCancel = function () { S.tplEditing = null; render(); };
  window.__bdTplSave = tplSave;
  window.__bdProgOpen = function () { S.progDetail = true; loadTemplates(); render(); };
  window.__bdProgBack = function () { S.progDetail = false; render(); };
  window.__bdTplOpen = function () { S.tplDetail = true; render(); };
  window.__bdTplBack = function () { S.tplDetail = false; render(); };
  window.__bdReloadForce = function () {
    if (S.view === "newsletter") loadClips(true);
    else if (S.view === "signals") loadSignals(true);
    else if (S.view === "program") { loadProgram(true); loadTemplates(true); }
    else if (S.view === "templates") loadTemplates(true);
    else load();
  };

  /* ---------------- render: shared ---------------- */
  function dot(state) { return '<span class="bdc-dot ' + state + '"></span>'; }
  function nodeHtml(name, state, meta, pending) {
    return '<div class="bdc-node' + (pending ? " pend" : "") + '"><div class="n">' + dot(state) + esc(name) + '</div><div class="m">' + meta + "</div></div>";
  }
  function signinCard() { return '<div class="bdc-card">Sign in to use the BD module.</div>'; }
  function viewHead(title, sub, actions) {
    return '<div class="bdc-head"><div><h1>' + esc(title) + '</h1><div class="sub">' + esc(sub) + "</div></div>" +
      '<div class="bdc-actions">' + (actions || "") + "</div></div>";
  }

  /* ---------------- render: overview ---------------- */
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
      (function () {
        var sig = runs["bd-signal-watch"];
        if (!sig) return nodeHtml("Signal watcher", "off", "daily 7:13 AM — alert feeds + dates + lists → congrats drafts (first run pending)", true);
        var c = sig.counts || {};
        return nodeHtml("Signal watcher", sig.ok ? "ok" : "err",
          "ran " + ago(sig.ran_at) +
          (sig.ok ? " · " + (c.drafted || 0) + " drafted, " + (c.negative_flagged || 0) + " flagged" : " · " + esc(sig.note || "failed")));
      })();

    var eng =
      nodeHtml("Cadence engine", cad ? (cad.ok ? "ok" : "err") : "warn",
        cad ? ("ran " + ago(cad.ran_at) + (cad.counts ? " · drafted " + (cad.counts.drafted || 0) + ", skipped " + (cad.counts.skipped || 0) : "") + (cad.ok ? "" : " · " + esc(cad.note || "failed"))) : "hasn't run yet — press ▶ Run engine now") +
      nodeHtml("Newsletter builder", "off", "assembles first week of each month from your clips · Phase 3", true);

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
    var rows = Object.keys(runs).map(function (j) {
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

  function renderOverview(el) {
    var d = S.data;
    var head = viewHead("BD Command Center", "The machine does business development. You approve it over coffee.",
      '<button class="bdc-btn" onclick="__bdLoad()">' + (S.loading ? "Loading…" : "⟳ Refresh") + "</button>" +
      '<button class="bdc-btn pri" onclick="__bdRun(this)">▶ Run engine now</button>');
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
      '<div class="bdc-note">Emails send 1:1 through Resend as real personal mail (no blast headers). Replies pause a contact the moment you mark their status Responded in HubSpot — the engine never touches paused, met, converted, or do-not-contact records. The signal watcher runs daily at 7:13 AM (alert feeds + birthdays + award lists → congrats drafts, capped at one per company per two weeks; negative news is flagged, never drafted). The newsletter assembles from your clips the first week of each month (Phase 3).</div>';
  }

  /* ---------------- render: newsletter (issue portal) ---------------- */
  function clipHtml(c) {
    var srcLabel = { manual: "you", van: "Van", signal: "watcher", upload: "file" }[c.source] || c.source;
    var title = c.title || (c.url ? c.url : "Note");
    var t = c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(title) + "</a>" : esc(title);
    var acts = "";
    if (c.status === "killed") {
      acts = '<button class="bdc-btn" onclick="__bdClipStatus(\'' + c.id + "','new')\">Restore</button>";
    } else if (c.status === "used") {
      acts = '<span class="bdc-src">shipped ' + esc(ymLabel(c.month_used || "")) + "</span>";
    } else {
      acts = (c.status === "kept" ? '<span class="bdc-src" style="border-color:var(--fitness,#3F8F6B);color:var(--fitness,#3F8F6B)">in this issue</span>'
              : '<button class="bdc-btn pri" onclick="__bdClipStatus(\'' + c.id + "','kept')\">Keep</button>") +
        '<button class="bdc-btn" onclick="__bdClipPush(\'' + c.id + "')\" title=\"Move to the following issue\">→ Next issue</button>" +
        '<button class="bdc-btn dngr" onclick="__bdClipStatus(\'' + c.id + "','killed')\">Kill</button>";
    }
    return '<div class="bdc-clip' + (c.status === "killed" ? " killed" : "") + '">' +
      '<div class="bdy"><div class="t">' + t + "</div>" +
      (c.note ? '<div class="nt">' + esc(c.note) + "</div>" : "") +
      (c.summary ? '<div class="nt">' + esc(c.summary) + "</div>" : "") +
      '<div class="mt"><span class="bdc-src">' + esc(srcLabel) + "</span> · " + ago(c.created_at) +
      (c.file_path ? ' · <a href="#" onclick="__bdOpenClipFile(\'' + esc(c.file_path) + "');return false\">open file</a>" : "") +
      "</div></div>" +
      '<div class="acts">' + acts + "</div></div>";
  }

  function issueChips() {
    var next = nextIssueKey();
    var upcoming = [next, ymAdd(next, 1), ymAdd(next, 2)];
    (S.issues || []).forEach(function (i) {
      if (i.status !== "sent" && upcoming.indexOf(i.issue_month) < 0 && i.issue_month >= next) upcoming.push(i.issue_month);
    });
    (S.clips || []).forEach(function (c) {
      if (c.issue_month && upcoming.indexOf(c.issue_month) < 0 && c.issue_month >= next) upcoming.push(c.issue_month);
    });
    upcoming.sort();
    var sent = (S.issues || []).filter(function (i) { return i.status === "sent"; }).map(function (i) { return i.issue_month; }).sort().reverse();

    function chip(ym, tag) {
      var row = issueRow(ym);
      var t = tag || (row ? row.status : (ym === next ? "planning" : ""));
      return '<button class="bdc-ichip' + (S.issue === ym ? " on" : "") + '" onclick="__bdIssueSel(\'' + ym + "')\">" + esc(ymLabel(ym)) +
        (t ? '<span class="tag">' + esc(t === "planning" && ym === next ? "next issue" : t) + "</span>" : "") + "</button>";
    }
    return '<div class="bdc-issues">' + upcoming.map(function (y) { return chip(y); }).join("") +
      (sent.length ? '<span class="bdc-idiv">archive</span>' + sent.map(function (y) { return chip(y, "sent"); }).join("") : "") +
      "</div>";
  }

  function renderNewsletter(el) {
    var head = viewHead("Newsletter", "The whole publication lives here — plan issues ahead, build the current one, and keep the archive.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.clipsErr === "signin") { el.innerHTML = head + signinCard(); return; }
    if (!S.issue) S.issue = nextIssueKey();

    var next = nextIssueKey();
    var sel = S.issue;
    var row = issueRow(sel);
    var isSent = row && row.status === "sent";

    var clips = (S.clips || []).filter(function (c) {
      return c.issue_month === sel || (!c.issue_month && sel === next);
    });
    var live = clips.filter(function (c) { return c.status === "new" || c.status === "kept"; });
    var killed = clips.filter(function (c) { return c.status === "killed"; });
    var used = clips.filter(function (c) { return c.status === "used"; });

    var draftCard = '<div class="bdc-card"><h3>' + esc(ymLabel(sel)) + " issue — " + esc(isSent ? "sent " + (row.sent_at ? fmtDate(row.sent_at) : "") : (row ? row.status : "planning")) + "</h3>" +
      '<div class="bdc-form">' +
      '<input id="bdcIssSj" placeholder="Subject line" value="' + esc((row && row.subject) || "") + '"' + (isSent ? " disabled" : "") + " />" +
      '<textarea id="bdcIssBo" rows="10" placeholder="The working draft. Write it here, or wait for Phase 3 — the first week of the month it assembles itself from the kept clips below + market stats + space finds, ready for your edit."' + (isSent ? " disabled" : "") + ">" + esc((row && row.body) || "") + "</textarea>" +
      (isSent ? '<div class="bdc-note" style="margin:0">This issue shipped — it lives here as the archive copy.</div>'
        : '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="bdc-btn pri" onclick="__bdIssueSave(this)">Save draft</button>' +
          '<button class="bdc-btn" onclick="__bdIssueSent(this)">Mark as sent</button>' +
          '<span class="bdc-note" style="margin:0">Sending itself (branded HTML via Resend to the warm list) wires up in Phase 3 — until then you send it from your mailbox and mark it here.</span>' +
          "</div>") +
      "</div></div>";

    var addCard = isSent ? "" : '<div class="bdc-card"><h3>Add a clip to ' + esc(ymLabel(sel)) + '</h3><div class="bdc-form">' +
      '<input id="bdcClipUrl" placeholder="Paste an article link (optional)" />' +
      '<textarea id="bdcClipNote" rows="2" placeholder="Your take — why this belongs in the issue (becomes the blurb seed)"></textarea>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="bdc-btn pri" onclick="__bdAddClip(this)">+ Add clip</button>' +
      '<label class="bdc-btn" style="display:inline-block">Upload file<input type="file" style="display:none" accept=".pdf,.png,.jpg,.jpeg,.webp" onchange="__bdUploadClip(this)" /></label>' +
      '<span class="bdc-note" style="margin:0">Van files clips too (“add this to the newsletter”), and the signal watcher drops in suggestions — both land on the next issue.</span>' +
      "</div></div></div>";

    var bucket = '<div class="bdc-card"><h3>Clips for this issue — ' + live.length + "</h3>" +
      (live.length ? live.map(clipHtml).join("")
        : (S.clips === null ? '<div class="bdc-empty">Loading…</div>' : '<div class="bdc-empty">Nothing clipped for ' + esc(ymLabel(sel)) + ' yet.</div>')) +
      "</div>";

    var restCards = "";
    if (used.length) restCards += '<div class="bdc-card"><h3>Shipped in this issue</h3>' + used.map(clipHtml).join("") + "</div>";
    if (killed.length) restCards += '<div class="bdc-card"><h3>Killed</h3>' + killed.map(clipHtml).join("") + "</div>";

    el.innerHTML = head + issueChips() + draftCard + addCard + bucket + restCards +
      '<div class="bdc-note">Clips without an issue land on the next issue automatically. “→ Next issue” pushes a clip one month out. Marking an issue sent stamps its kept clips as shipped and moves the issue to the archive — the history of everything you\'ve published stays right here.</div>';
  }

  /* ---------------- render: marketing programs ---------------- */
  function programBuckets(contacts) {
    function bucket(c) {
      var s = String(c.status || "").toLowerCase();
      if (/active/.test(s)) return "Active in program";
      if (/not started/.test(s)) return "Not started";
      if (/respond/.test(s) && !/never/.test(s)) return "Responded";
      if (/meeting/.test(s)) return "Meeting";
      if (/convert/.test(s)) return "Converted";
      if (/never/.test(s)) return "Never responded";
      if (/^none$/.test(s.trim())) return "None";
      return "Other";
    }
    var order = ["Active in program", "Not started", "Responded", "Meeting", "Converted", "Never responded", "None", "Other"];
    var by = {};
    (contacts || []).forEach(function (c) { var b = bucket(c); (by[b] = by[b] || []).push(c); });
    return order.filter(function (b) { return by[b] && by[b].length; }).map(function (b) { return { name: b, items: by[b] }; });
  }

  function tplByStep() {
    var by = {};
    (S.templates || []).forEach(function (t) { by[t.step] = t; });
    return by;
  }

  function cadenceHtml(editable) {
    var by = tplByStep();
    var out = '<div class="bdc-tl">';
    PLAN.forEach(function (p, i) {
      var t = by[p.step];
      var body = "";
      if (t) {
        if (editable && S.tplEditing === t.id) {
          body = '<div class="bdc-edit">' +
            (t.touch_type === "email" ? '<input id="bdcTplSj-' + t.id + '" value="' + esc(t.subject || "") + '" placeholder="Subject" />' : "") +
            '<textarea id="bdcTplBo-' + t.id + '">' + esc(t.body || "") + "</textarea>" +
            '<div class="bdc-item-act">' +
            '<button class="bdc-btn pri" onclick="__bdTplSave(\'' + t.id + "',this)\">Save</button>" +
            '<button class="bdc-btn" onclick="__bdTplCancel()">Cancel</button></div></div>';
        } else {
          body = '<div class="bdc-prev">' + (t.subject ? '<span class="sj">' + esc(t.subject) + "</span>" : "") + esc(t.body || "") + "</div>" +
            (editable ? '<div class="bdc-item-act"><button class="bdc-btn" onclick="__bdTplEdit(\'' + t.id + "')\">Edit</button></div>" : "");
        }
      } else {
        body = '<div class="bdc-empty">No template saved for this step yet.</div>';
      }
      out += '<div class="bdc-tlstep ' + p.type + '">' +
        '<div class="bdc-tlhead"><span class="bdc-tlday">Day ' + p.day + '</span><span class="bdc-tt ' + p.type + '">' + p.type + '</span><span class="bdc-tllabel">Step ' + p.step + " — " + esc(p.label) + "</span></div>" +
        '<div class="bdc-tlbody">' + body + "</div></div>";
      if (i < PLAN.length - 1) {
        var gap = PLAN[i + 1].day - p.day;
        out += '<div class="bdc-tlgap">wait ' + gap + " day" + (gap === 1 ? "" : "s") + "</div>";
      }
    });
    out += "</div>";
    return out;
  }

  function tenStepCardHtml(open) {
    var counts = { email: 0, call: 0, mail: 0 };
    PLAN.forEach(function (p) { counts[p.type]++; });
    var d = S.program;
    var active = 0, total = 0;
    if (d && d.contacts) {
      total = d.contacts.length;
      active = d.contacts.filter(function (c) { return /active/i.test(String(c.status || "")); }).length;
    }
    return '<div class="bdc-progcard" onclick="' + open + '">' +
      '<div class="pn">10-Step Cold Outreach</div>' +
      '<div class="pm">61 days · ' + counts.email + " emails · " + counts.call + " calls · " + counts.mail + " mail pieces · brochure-led, one ask: a 15–20 min intro meeting" +
      (total ? "<br>" + active + " active · " + total + " total in program" : "") + "</div>" +
      '<div class="pv">View cadence →</div></div>';
  }

  function renderProgram(el) {
    if (S.progDetail) {
      var headD = viewHead("10-Step Cold Outreach", "The full cadence — every touch, the wait between them, and the exact copy that goes out.",
        '<button class="bdc-btn" onclick="__bdProgBack()">← All programs</button>');
      el.innerHTML = headD + '<div class="bdc-card"><h3>Cadence — 61 days, 10 touches</h3>' + cadenceHtml(true) + "</div>" +
        '<div class="bdc-note">Rules wired into the engine: VM only on steps 2 and 7 (they reference a physical piece) · any reply pauses the program · silence after step 10 → Never responded → nurture pool resurfaces ~9 months before lease expiration. Edits here are the live copy — the engine sends it verbatim on the next run.</div>';
      return;
    }

    var head = viewHead("Marketing Programs", "The programs we run people through. HubSpot is the control panel — click a name to change their status there.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.programErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var progCard = '<div class="bdc-card"><h3>Programs</h3><div class="bdc-proggrid">' +
      tenStepCardHtml("__bdProgOpen()") +
      '<div class="bdc-progcard" style="opacity:.6;border-style:dashed;cursor:default">' +
      '<div class="pn">Re-engagement (coming)</div>' +
      '<div class="pm">For everyone who finished the 10-step without a meeting — a slower drumbeat that keeps pounding until they take one. Designed when the first cohort finishes.</div></div>' +
      "</div></div>";

    var d = S.program;
    var boardCard;
    if (!d) {
      boardCard = '<div class="bdc-card"><div class="bdc-empty">' + (S.programErr ? esc(S.programErr) : "Loading from HubSpot…") + "</div></div>";
    } else if (!d.connected) {
      boardCard = '<div class="bdc-card"><div class="bdc-empty">HubSpot isn’t connected (HUBSPOT_PRIVATE_APP_TOKEN).</div></div>';
    } else {
      var portal = d.portalId || "245913727";
      var cols = programBuckets(d.contacts);
      var board = cols.length
        ? '<div class="bdc-board">' + cols.map(function (col) {
            return '<div class="bdc-col"><h4>' + esc(col.name) + "<span>" + col.items.length + "</span></h4>" +
              col.items.map(function (c) {
                var hsUrl = "https://app-na2.hubspot.com/contacts/" + portal + "/record/0-1/" + encodeURIComponent(c.id);
                return '<div class="bdc-pcard">' +
                  '<div class="nm"><a href="' + hsUrl + '" target="_blank" rel="noopener" title="Open in HubSpot">' + esc(c.name) + "</a></div>" +
                  (c.company ? '<div class="co">' + esc(c.company) + (c.title ? " · " + esc(c.title) : "") + "</div>" : "") +
                  '<div class="st">' + (c.step ? '<span class="bdc-stepchip">step ' + c.step + "/10</span>" : "") +
                  (c.next_touch_date ? "next touch " + fmtDate(c.next_touch_date) + (c.next_touch_type ? " (" + esc(c.next_touch_type) + ")" : "") : "no touch scheduled") +
                  "</div></div>";
              }).join("") + "</div>";
          }).join("") + "</div>"
        : '<div class="bdc-empty">Nobody carries a program status yet. Import your companies + contacts into HubSpot, set Marketing Program Status on the person you\'re pursuing, and they appear here.</div>';
      boardCard = '<div class="bdc-card"><h3>' + (d.contacts || []).length + " contact" + ((d.contacts || []).length === 1 ? "" : "s") + " across all programs</h3>" + board + "</div>";
    }

    el.innerHTML = head + progCard + boardCard +
      '<div class="bdc-note">Read-only by design (your call): starting, pausing, and status changes happen in HubSpot; the cadence engine reads the state every morning and drafts whatever is due.</div>';
  }

  /* ---------------- render: signals ---------------- */
  function renderSignals(el) {
    var head = viewHead("Signals", "The alert feeds the 7:13 AM watcher reads, and everything it has caught.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.sigErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var addCard = '<div class="bdc-card"><h3>Register a Google Alert feed</h3>' +
      '<div class="bdc-form"><div class="bdc-form-row">' +
      '<input id="bdcFeedUrl" placeholder="https://www.google.com/alerts/feeds/…  (create the alert with Deliver to: RSS feed)" />' +
      '<input id="bdcFeedLabel" placeholder="Label — the alert query" />' +
      '<select id="bdcFeedKind"><option value="company">Company</option><option value="exec">Exec name</option><option value="topic">Topic</option></select>' +
      '<button class="bdc-btn pri" onclick="__bdAddFeed(this)">+ Add feed</button>' +
      "</div>" +
      '<input id="bdcFeedCo" placeholder="HubSpot company this watches (optional — defaults to the label for company feeds)" />' +
      "</div></div>";

    var feeds = S.feeds || [];
    var feedRows = feeds.map(function (f) {
      return "<tr><td>" + (f.active ? dot("ok") : dot("off")) + " " + esc(f.label) + '</td><td class="mut">' + esc(f.kind) + (f.company_name ? " · " + esc(f.company_name) : "") + '</td><td class="mut">' +
        (f.last_fetched_at ? "checked " + ago(f.last_fetched_at) : "never checked") + "</td><td>" +
        '<button class="bdc-btn" onclick="__bdFeedActive(\'' + f.id + "'," + (f.active ? "false" : "true") + ')">' + (f.active ? "Pause" : "Resume") + "</button> " +
        '<button class="bdc-btn dngr" onclick="__bdFeedDelete(\'' + f.id + "')\">Remove</button>" +
        "</td></tr>";
    }).join("");
    var feedCard = '<div class="bdc-card"><h3>Feeds — ' + feeds.length + " registered</h3>" +
      (feeds.length ? '<table class="bdc-tbl">' + feedRows + "</table>"
        : (S.feeds === null ? '<div class="bdc-empty">Loading…</div>'
          : '<div class="bdc-empty">No feeds yet. In havillalerts@gmail.com, create an alert at google.com/alerts with “Deliver to: RSS feed,” copy the RSS link, and paste it above.</div>')) +
      "</div>";

    var hist = S.sigHist || [];
    var histRows = hist.map(function (h) {
      var verb = { pending: "drafted (waiting)", sent: "sent", skipped: "you skipped", failed: "failed", done: "done" }[h.status] || h.status;
      return "<tr><td>" + esc(h.company_name || h.contact_name || "?") + '</td><td class="mut">' + esc(h.signal_note || h.subject || "") + '</td><td class="mut">' + esc(verb) + " · " + ago(h.created_at) + "</td></tr>";
    }).join("");
    var histCard = '<div class="bdc-card"><h3>Signal history</h3>' +
      (hist.length ? '<table class="bdc-tbl">' + histRows + "</table>" : '<div class="bdc-empty">Nothing caught yet — history fills in as the watcher runs.</div>') +
      "</div>";

    el.innerHTML = head + addCard + feedCard + histCard +
      '<div class="bdc-note">Rules the watcher lives by: existing HubSpot companies only · max one signal email per company per two weeks · negative news is flagged in the morning summary but never drafted · it loosens or tightens its “interesting” bar based on which drafts you skip.</div>';
  }

  /* ---------------- render: templates ---------------- */
  function renderTemplates(el) {
    if (S.tplDetail) {
      var headD = viewHead("10-Step Cold Outreach — templates", "The live copy, laid out on the cadence. What you save is exactly what sends.",
        '<button class="bdc-btn" onclick="__bdTplBack()">← All template sets</button>' +
        '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
      if (S.tplErr === "signin") { el.innerHTML = headD + signinCard(); return; }
      if (S.templates === null) { el.innerHTML = headD + '<div class="bdc-card"><div class="bdc-empty">' + (S.tplErr ? esc(S.tplErr) : "Loading…") + "</div></div>"; return; }
      el.innerHTML = headD + '<div class="bdc-card"><h3>Cadence + copy</h3>' + cadenceHtml(true) + "</div>" +
        '<div class="bdc-note">Merge fields: {{first_name}} {{last_name}} {{company}} {{submarket}} {{title}} — unknown fields render blank, never as braces. Mail steps hold print instructions; call steps hold your talking points. Edits apply from the next engine run (verbatim + merge — your call, no AI rewriting).</div>';
      return;
    }

    var head = viewHead("Templates", "Template sets, one per program. Click into a set to see the cadence and edit the copy.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.tplErr === "signin") { el.innerHTML = head + signinCard(); return; }

    el.innerHTML = head + '<div class="bdc-card"><h3>Template sets</h3><div class="bdc-proggrid">' +
      tenStepCardHtml("__bdTplOpen()") +
      '<div class="bdc-progcard" style="opacity:.6;border-style:dashed;cursor:default">' +
      '<div class="pn">Newsletter blocks (coming)</div>' +
      '<div class="pm">Reusable sections for the monthly issue — intro, stats block, space-finds block, sign-off — once Phase 3 assembly lands.</div></div>' +
      "</div></div>" +
      '<div class="bdc-note">More sets appear here as we add programs (re-engagement, client touches). Each set is the single source of truth its engine sends from.</div>';
  }

  /* ---------------- render: dispatch ---------------- */
  function render() {
    var el = $("bdView"); if (!el) return;
    if (S.err === "signin" && S.view === "overview") { el.innerHTML = signinCard(); return; }
    if (S.view === "newsletter") return renderNewsletter(el);
    if (S.view === "program") return renderProgram(el);
    if (S.view === "signals") return renderSignals(el);
    if (S.view === "templates") return renderTemplates(el);
    return renderOverview(el);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    if (!inject()) return false;
    wrapShowModule();
    var p = new URLSearchParams(location.search);
    if (p.get("m") === "bd") {
      var sv = p.get("sv");
      if (sv && VIEWS[sv]) S.view = sv;
      setTimeout(function () { try { window.showModule("bd"); } catch (e) {} }, 400);
    }
    return true;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else if (!boot()) {
    var tries = 0;
    var iv = setInterval(function () { if (boot() || ++tries > 20) clearInterval(iv); }, 250);
  }
})();
