/* Vantage — BD module (self-contained, market-spaces.js pattern).
 *
 * BD is now a full module with a Market-style sub-menu:
 *   Command Center — the landing summary (system map, morning queue, funnel, health)
 *   Newsletter    — the clip bucket: articles/notes/files collected all month;
 *                   the first-week-of-month draft (Phase 3) assembles from it
 *   Program       — read-only board of everyone in the 10-step program (HubSpot
 *                   stays the control panel; cards link to their HubSpot records)
 *   Signals       — manage Google-Alert RSS feeds + review signal history
 *   Templates     — redline the 10-step copy; the cadence engine sends it verbatim
 *
 * Self-contained: injects its own .bdc- CSS, nav item + sub-menu + <section>,
 * and wraps window.showModule. index.html diff = one <script> tag.
 * Data: bd-overview / bd-queue-act / bd-cadence / bd-program functions, plus
 * direct Supabase reads/writes (RLS + stamp triggers) for clips/feeds/templates.
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
  function nextIssueLabel() {
    var d = new Date(); d.setMonth(d.getMonth() + (d.getDate() <= 7 ? 0 : 1), 1);
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  var VIEWS = { overview: "Command Center", newsletter: "Newsletter", program: "Program", signals: "Signals", templates: "Templates" };
  var S = {
    view: "overview",
    data: null, loading: false, err: null, editing: null,
    clips: null, clipsErr: null,
    feeds: null, sigHist: null, sigErr: null,
    program: null, programErr: null,
    templates: null, tplErr: null, tplEditing: null
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
    /* clips */
    ".bdc-clip{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line,#E2DDD2);border-radius:10px;padding:10px 13px;background:var(--paper,#F7F5F0);margin-bottom:8px}" +
    ".bdc-clip.killed{opacity:.5}" +
    ".bdc-clip .bdy{flex:1 1 auto;min-width:0}" +
    ".bdc-clip .t{font-weight:600;font-size:13.5px;color:var(--ink,#1A2230)}" +
    ".bdc-clip .t a{color:var(--accent,#2D6E7E);text-decoration:none}" +
    ".bdc-clip .nt{font-size:12.5px;color:var(--ink-soft,#55606F);margin-top:3px;white-space:pre-wrap}" +
    ".bdc-clip .mt{font-size:11px;color:var(--ink-faint,#8A93A0);margin-top:4px}" +
    ".bdc-clip .acts{display:flex;gap:6px;flex:0 0 auto}" +
    ".bdc-clip .acts .bdc-btn{padding:4px 9px;font-size:12px}" +
    ".bdc-src{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:1px 7px;border-radius:20px;border:1px solid var(--line,#E2DDD2);color:var(--ink-soft,#55606F);background:var(--paper-2,#FCFBF8)}" +
    /* program board */
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

  /* ---------------- data: clips / feeds / templates / program ---------------- */
  function sbErr(e) { return (e && (e.message || e.error_description || e.hint)) || "database error"; }

  function loadClips(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.clipsErr = "signin"; render(); return; }
    if (S.clips && !force) { render(); return; }
    sb.from("bd_clips").select("*").order("created_at", { ascending: false }).limit(200)
      .then(function (r) {
        if (r.error) { S.clipsErr = sbErr(r.error); } else { S.clips = r.data || []; S.clipsErr = null; }
        render();
      });
  }
  function addClip(btn) {
    var url = ($("bdcClipUrl") || {}).value || "", note = ($("bdcClipNote") || {}).value || "";
    url = url.trim(); note = note.trim();
    if (!url && !note) { alert("Paste a link or write a note first."); return; }
    var sb = getSB(); if (!sb) return;
    btn.disabled = true;
    var title = null;
    try { if (url) title = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { if (url) { note = (note ? note + "\n" : "") + url; url = null; } }
    sb.from("bd_clips").insert({ url: url || null, title: title, note: note || null, source: "manual" })
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
          sb.from("bd_clips").insert({ title: f.name, source: "upload", file_path: path }).then(function () { loadClips(true); });
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
    else if (S.view === "program") loadProgram();
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
  window.__bdAddClip = addClip; window.__bdClipStatus = clipStatus; window.__bdUploadClip = uploadClip; window.__bdOpenClipFile = openClipFile;
  window.__bdAddFeed = addFeed; window.__bdFeedActive = feedActive; window.__bdFeedDelete = feedDelete;
  window.__bdTplEdit = function (id) { S.tplEditing = id; render(); };
  window.__bdTplCancel = function () { S.tplEditing = null; render(); };
  window.__bdTplSave = tplSave;
  window.__bdReload = function () { loadView(); };
  window.__bdReloadForce = function () {
    if (S.view === "newsletter") loadClips(true);
    else if (S.view === "signals") loadSignals(true);
    else if (S.view === "program") loadProgram(true);
    else if (S.view === "templates") loadTemplates(true);
    else load();
  };

  /* ---------------- render: shared ---------------- */
  function dot(state) { return '<span class="bdc-dot ' + state + '"></span>'; }
  function nodeHtml(name, state, meta, pending) {
    return '<div class="bdc-node' + (pending ? " pend" : "") + '"><div class="n">' + dot(state) + esc(name) + '</div><div class="m">' + meta + "</div></div>";
  }
  function signinCard() { return '<div class="bdc-card">Sign in to use the BD module.</div>'; }

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

  /* ---------------- render: newsletter ---------------- */
  function clipHtml(c) {
    var srcLabel = { manual: "you", van: "Van", signal: "watcher", upload: "file" }[c.source] || c.source;
    var title = c.title || (c.url ? c.url : "Note");
    var t = c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(title) + "</a>" : esc(title);
    var acts = "";
    if (c.status === "killed") {
      acts = '<button class="bdc-btn" onclick="__bdClipStatus(\'' + c.id + "','new')\">Restore</button>";
    } else if (c.status === "used") {
      acts = '<span class="bdc-src">used ' + esc(c.month_used || "") + "</span>";
    } else {
      acts = (c.status === "kept" ? '<span class="bdc-src" style="border-color:var(--fitness,#3F8F6B);color:var(--fitness,#3F8F6B)">in next issue</span>'
              : '<button class="bdc-btn pri" onclick="__bdClipStatus(\'' + c.id + "','kept')\">Keep</button>") +
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

  function renderNewsletter(el) {
    var head = viewHead("Newsletter", "Clip articles, notes, and files all month — the " + nextIssueLabel() + " issue assembles itself from what you keep.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.clipsErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var addCard = '<div class="bdc-card"><h3>Add a clip</h3><div class="bdc-form">' +
      '<input id="bdcClipUrl" placeholder="Paste an article link (optional)" />' +
      '<textarea id="bdcClipNote" rows="2" placeholder="Your take — why this belongs in the newsletter (becomes the blurb seed)"></textarea>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="bdc-btn pri" onclick="__bdAddClip(this)">+ Add clip</button>' +
      '<label class="bdc-btn" style="display:inline-block">Upload file<input type="file" style="display:none" accept=".pdf,.png,.jpg,.jpeg,.webp" onchange="__bdUploadClip(this)" /></label>' +
      '<span class="bdc-note" style="margin:0">You can also tell Van “add this to the newsletter,” and the signal watcher drops in suggestions it finds.</span>' +
      "</div></div></div>";

    var clips = S.clips || [];
    var live = clips.filter(function (c) { return c.status === "new" || c.status === "kept"; });
    var killed = clips.filter(function (c) { return c.status === "killed"; });
    var used = clips.filter(function (c) { return c.status === "used"; });

    var bucket = '<div class="bdc-card"><h3>Clip bucket — ' + live.length + " for the next issue</h3>" +
      (live.length ? live.map(clipHtml).join("") : (S.clips === null ? '<div class="bdc-empty">Loading…</div>' : '<div class="bdc-empty">Empty bucket. Paste the first article or note above — future-you writes the newsletter in one click because present-you clipped things.</div>')) +
      "</div>";

    var restCards = "";
    if (killed.length) restCards += '<div class="bdc-card"><h3>Killed</h3>' + killed.map(clipHtml).join("") + "</div>";
    if (used.length) restCards += '<div class="bdc-card"><h3>Shipped in past issues</h3>' + used.map(clipHtml).join("") + "</div>";

    el.innerHTML = head + addCard + bucket + restCards +
      '<div class="bdc-note">Assembly (Phase 3): first week of each month a full branded-HTML draft is built from kept clips + submarket stats + notable comps + hand-picked space finds + your POV, and lands here for approval before it goes to the warm list (anyone mid-cadence is excluded automatically).</div>';
  }

  /* ---------------- render: program ---------------- */
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

  function renderProgram(el) {
    var head = viewHead("Program", "Everyone in the 10-step program. HubSpot is the control panel — click a name to change their status there.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.programErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var d = S.program;
    if (!d) { el.innerHTML = head + '<div class="bdc-card"><div class="bdc-empty">' + (S.programErr ? esc(S.programErr) : "Loading from HubSpot…") + "</div></div>"; return; }
    if (!d.connected) { el.innerHTML = head + '<div class="bdc-card"><div class="bdc-empty">HubSpot isn’t connected (HUBSPOT_PRIVATE_APP_TOKEN).</div></div>'; return; }

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

    el.innerHTML = head + '<div class="bdc-card"><h3>' + (d.contacts || []).length + " contact" + ((d.contacts || []).length === 1 ? "" : "s") + " in the program</h3>" + board + "</div>" +
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
    var head = viewHead("Templates", "The 10-step program copy. What you save here is exactly what the engine sends — merge fields fill per contact.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.tplErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var tpls = S.templates;
    if (tpls === null) { el.innerHTML = head + '<div class="bdc-card"><div class="bdc-empty">' + (S.tplErr ? esc(S.tplErr) : "Loading…") + "</div></div>"; return; }

    var cards = (tpls || []).map(function (t) {
      var editing = S.tplEditing === t.id;
      var body;
      if (editing) {
        body = '<div class="bdc-edit">' +
          (t.touch_type === "email" ? '<input id="bdcTplSj-' + t.id + '" value="' + esc(t.subject || "") + '" placeholder="Subject" />' : "") +
          '<textarea id="bdcTplBo-' + t.id + '">' + esc(t.body || "") + "</textarea>" +
          '<div class="bdc-item-act">' +
          '<button class="bdc-btn pri" onclick="__bdTplSave(\'' + t.id + "',this)\">Save</button>" +
          '<button class="bdc-btn" onclick="__bdTplCancel()">Cancel</button></div></div>';
      } else {
        body = '<div class="bdc-prev">' + (t.subject ? '<span class="sj">' + esc(t.subject) + "</span>" : "") + esc(t.body || "") + "</div>" +
          '<div class="bdc-item-act"><button class="bdc-btn" onclick="__bdTplEdit(\'' + t.id + "')\">Edit</button></div>";
      }
      return '<div class="bdc-item ' + esc(t.touch_type) + '">' +
        '<div class="bdc-item-top"><span class="bdc-tt">' + esc(t.touch_type) + '</span><span class="bdc-who">Step ' + t.step + "</span></div>" + body + "</div>";
    }).join("");

    el.innerHTML = head +
      '<div class="bdc-card"><h3>Program copy — steps 1–10</h3>' +
      (cards ? '<div class="bdc-q">' + cards + "</div>" : '<div class="bdc-empty">No templates found — run supabase/bd-center.sql to seed them.</div>') +
      "</div>" +
      '<div class="bdc-note">Merge fields: {{first_name}} {{last_name}} {{company}} {{submarket}} {{title}} — unknown fields render blank, never as braces. Mail steps hold print instructions; call steps hold your talking points. Edits apply from the next engine run (verbatim + merge — your call, no AI rewriting).</div>';
  }

  /* ---------------- render: dispatch ---------------- */
  function viewHead(title, sub, actions) {
    return '<div class="bdc-head"><div><h1>' + esc(title) + '</h1><div class="sub">' + esc(sub) + "</div></div>" +
      '<div class="bdc-actions">' + (actions || "") + "</div></div>";
  }

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
