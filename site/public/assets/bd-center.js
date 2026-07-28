/* Vantage — BD module (self-contained, market-spaces.js pattern).
 *
 * BD is a full module with a Market-style sub-menu:
 *   Command Center      — landing summary (system map, morning queue, funnel, health)
 *   Newsletter          — ISSUE PORTAL: clips + a working draft per monthly issue
 *                         (planning next month, months ahead queued, sent archive)
 *   Marketing Programs  — the programs we run (10-step cold outreach first; more
 *                         later) + a read-only board of everyone in them; click a
 *                         program to open the BUILDER — retitle steps, move them
 *                         to different days, change type, attach collateral,
 *                         add/remove steps (the program is bd_templates rows,
 *                         and the engine reads the same rows)
 *   Signals             — manage Google-Alert RSS feeds + review signal history
 *   Templates           — the asset library: COLLATERAL (brochure, letter, note
 *                         card — files you upload and attach to a cadence step)
 *                         and EMAILS (reusable one-off copy outside any cadence)
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

  /* ---- the cadence program, read from bd_templates ---- */
  // The program is DATA, not code: bd_templates rows carry label + day_offset +
  // touch type + copy + attached asset (supabase/bd-builder.sql). This mirrors
  // stepsFrom() in functions/_bd.js — the engine and this builder must agree on
  // ordering, or the cadence you see isn't the cadence that sends.
  // DEFAULT_PLAN is only the shape shown before rows load / if none exist.
  var DEFAULT_PLAN = [
    { day_offset: 1, touch_type: "mail", label: "Brochure + hand-written note" },
    { day_offset: 9, touch_type: "call", label: "Call #1 — reference the brochure (VM ok, bridge email after)" },
    { day_offset: 15, touch_type: "email", label: "Email #1 — submarket snapshot" },
    { day_offset: 22, touch_type: "call", label: "Call #2 — no voicemail" },
    { day_offset: 28, touch_type: "email", label: "Email #2 — building-specific hook" },
    { day_offset: 35, touch_type: "mail", label: "Unique-value letter, hand-signed" },
    { day_offset: 41, touch_type: "call", label: "Call #3 — VM referencing the letter" },
    { day_offset: 48, touch_type: "email", label: "Email #3 — direct meeting ask" },
    { day_offset: 54, touch_type: "call", label: "Call #4 — no voicemail" },
    { day_offset: 61, touch_type: "email", label: "Email #4 — professional breakup" }
  ];

  // Ordered steps for display. day_offset is the ordering truth (the stored
  // `step` number lags after edits); `pos` is the position the engine reports.
  function planSteps() {
    var rows = (S.templates && S.templates.length) ? S.templates : null;
    var list = (rows || DEFAULT_PLAN).slice();
    list.sort(function (a, b) {
      var da = a.day_offset != null ? a.day_offset : 1000 + (a.step || 0);
      var db = b.day_offset != null ? b.day_offset : 1000 + (b.step || 0);
      return da !== db ? da - db : (a.step || 0) - (b.step || 0);
    });
    return list.map(function (r, i) {
      return {
        pos: i + 1,
        day: r.day_offset != null ? r.day_offset : (i ? list[i - 1].day_offset + 7 : 1),
        type: ["email", "call", "mail"].indexOf(r.touch_type) >= 0 ? r.touch_type : "email",
        label: r.label || ("Step " + (i + 1)),
        row: rows ? r : null   // null = placeholder default, nothing to edit yet
      };
    });
  }
  function planDays() { var s = planSteps(); return s.length ? s[s.length - 1].day : 0; }

  var ASSET_CATS = {
    collateral: [
      ["brochure", "Brochure"], ["letter", "Letter"], ["note-card", "Note card"],
      ["case-study", "Case study"], ["one-pager", "One-pager"],
      ["newsletter-block", "Newsletter block"], ["other", "Other"]
    ],
    email: [["deal-email", "Deal email"], ["relationship-email", "Relationship email"], ["other", "Other"]]
  };
  function catLabel(kind, c) {
    var found = (ASSET_CATS[kind] || []).filter(function (p) { return p[0] === c; })[0];
    return found ? found[1] : (c || "—");
  }

  var VIEWS = { overview: "Command Center", directory: "Directory Scan", newsletter: "Newsletter", program: "Marketing Programs", proposals: "Proposals", signals: "Signals", templates: "Templates" };
  var S = {
    view: "overview",
    data: null, loading: false, err: null, editing: null,
    clips: null, clipsErr: null, issues: null, issue: null,
    feeds: null, sigHist: null, sigErr: null,
    program: null, programErr: null, progDetail: false,
    templates: null, tplErr: null, tplEditing: null,
    assets: null, assetErr: null, assetEditing: null, assetKind: "collateral",
    props: null, propErr: null, propEditing: null,
    scans: null, scanErr: null, scanId: null, scanBusy: false, scanOpenRow: null, scanPoll: null
  };

  /* ---- directory scan: the rent math (Andrew's standard, editable per scan) ---- */
  var DEF_ASSUMPTIONS = { sqft_low: 200, sqft_high: 250, psf_low: 100, psf_high: 125 };
  function assumptionsOf(scan) {
    var a = (scan && scan.assumptions) || {};
    return {
      sqft_low: Number(a.sqft_low) > 0 ? Number(a.sqft_low) : DEF_ASSUMPTIONS.sqft_low,
      sqft_high: Number(a.sqft_high) > 0 ? Number(a.sqft_high) : DEF_ASSUMPTIONS.sqft_high,
      psf_low: Number(a.psf_low) > 0 ? Number(a.psf_low) : DEF_ASSUMPTIONS.psf_low,
      psf_high: Number(a.psf_high) > 0 ? Number(a.psf_high) : DEF_ASSUMPTIONS.psf_high
    };
  }
  function money(n) {
    if (!isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  function intFmt(n) { return isFinite(n) && n != null ? Number(n).toLocaleString("en-US") : "—"; }

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
    ".bdc-edit input,.bdc-edit textarea,.bdc-edit select,.bdc-form input,.bdc-form textarea,.bdc-form select{width:100%;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;background:#fff;color:var(--ink,#1A2230)}" +
    ".bdc-edit input,.bdc-edit textarea,.bdc-edit select{margin-top:8px}" +
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
    ".bdc-tlstep.dragging{opacity:.45}" +
    /* program builder */
    ".bdc-daybox{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-faint,#8A93A0)}" +
    ".bdc-daybox input{width:56px;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;background:#fff;color:var(--ink,#1A2230)}" +
    ".bdc-bgrid{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}" +
    ".bdc-bgrid select{width:auto;min-width:120px;margin-top:0;padding:7px 9px}" +
    ".bdc-attach{font-size:11.5px;color:var(--ink-soft,#55606F);margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}" +
    ".bdc-attach a{color:var(--accent,#2D6E7E);text-decoration:none;cursor:pointer}" +
    ".bdc-clip-tag{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:1px 7px;border-radius:20px;border:1px solid var(--coffee,#A56B3D);color:var(--coffee,#A56B3D)}" +
    ".bdc-addstep{margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
    /* asset library */
    ".bdc-kinds{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}" +
    ".bdc-agrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-items:start}" +
    ".bdc-asset{border:1px solid var(--line,#E2DDD2);border-radius:11px;padding:12px 14px;background:var(--paper,#F7F5F0)}" +
    ".bdc-asset .an{font-weight:700;font-size:14px;color:var(--ink,#1A2230)}" +
    ".bdc-asset .ac{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);margin-top:2px}" +
    ".bdc-asset .ad{font-size:12.5px;color:var(--ink-soft,#55606F);margin-top:6px;line-height:1.45}" +
    ".bdc-asset .af{font-size:12px;margin-top:8px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}" +
    ".bdc-asset .af a{color:var(--accent,#2D6E7E);text-decoration:none;cursor:pointer}" +
    ".bdc-asset .af .none{color:var(--ink-faint,#8A93A0)}" +
    ".bdc-file-in{font-size:11.5px;max-width:190px}" +
    /* two-col + tables */
    ".bdc-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}" +
    "@media(max-width:900px){.bdc-cols{grid-template-columns:1fr}.bdc-map{flex-direction:column}.bdc-arrow{transform:rotate(90deg);padding:4px 0}}" +
    ".bdc-tbl{width:100%;border-collapse:collapse;font-size:12.5px}" +
    ".bdc-tbl td{padding:6px 8px;border-top:1px solid var(--line,#E2DDD2);color:var(--ink,#1A2230);vertical-align:top}" +
    ".bdc-tbl td.mut{color:var(--ink-soft,#55606F)}" +
    ".bdc-empty{color:var(--ink-faint,#8A93A0);font-size:13px;padding:8px 2px}" +
    /* directory scan */
    ".bdc-scanform{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
    "@media(max-width:800px){.bdc-scanform{grid-template-columns:1fr}}" +
    ".bdc-scanform .wide{grid-column:1/-1}" +
    ".bdc-drop{grid-column:1/-1;border:1.5px dashed var(--line-2,#D2CCBF);border-radius:10px;padding:16px;text-align:center;background:var(--paper,#F7F5F0)}" +
    ".bdc-drop.on{border-color:var(--accent,#2D6E7E);background:var(--paper-2,#FCFBF8)}" +
    ".bdc-drop .hint{font-size:12.5px;color:var(--ink-soft,#55606F);margin-top:6px}" +
    ".bdc-thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;justify-content:center}" +
    ".bdc-thumb{position:relative;width:78px;height:78px;border-radius:8px;overflow:hidden;border:1px solid var(--line,#E2DDD2)}" +
    ".bdc-thumb img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".bdc-thumb button{position:absolute;top:2px;right:2px;border:none;border-radius:50%;width:18px;height:18px;line-height:16px;padding:0;cursor:pointer;background:rgba(0,0,0,.6);color:#fff;font-size:12px}" +
    ".bdc-scanlist{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}" +
    ".bdc-dtbl{width:100%;border-collapse:collapse;font-size:12.5px}" +
    ".bdc-dtbl th{text-align:left;font:600 10.5px Inter,inherit;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint,#8A93A0);border-bottom:1px solid var(--line,#E2DDD2);padding:6px 7px;white-space:nowrap}" +
    ".bdc-dtbl td{padding:7px;border-bottom:1px solid var(--line,#E2DDD2);color:var(--ink,#1A2230);vertical-align:top}" +
    ".bdc-dtbl td.num{text-align:right;white-space:nowrap}" +
    ".bdc-dtbl tr.off{opacity:.4}" +
    ".bdc-dtbl .co{font-weight:600}" +
    ".bdc-dtbl .sub{font-size:11.5px;color:var(--ink-soft,#55606F);margin-top:2px}" +
    ".bdc-dtbl .rowbtn{border:none;background:none;color:var(--accent,#2D6E7E);cursor:pointer;font:inherit;font-size:11.5px;padding:0;margin-top:4px}" +
    ".bdc-wrap{overflow-x:auto}" +
    ".bdc-flag{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:20px;border:1px solid var(--line,#E2DDD2);color:var(--ink-soft,#55606F);white-space:nowrap;display:inline-block}" +
    ".bdc-flag.ok{border-color:var(--fitness,#3F8F6B);color:var(--fitness,#3F8F6B)}" +
    ".bdc-flag.out{border-color:var(--coffee,#A56B3D);color:var(--coffee,#A56B3D)}" +
    ".bdc-flag.intl{border-color:var(--dining,#C9543F);color:var(--dining,#C9543F)}" +
    ".bdc-conf{font-size:10.5px;color:var(--ink-faint,#8A93A0)}" +
    ".bdc-conf.low{color:var(--dining,#C9543F)}" +
    ".bdc-rowedit{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px;padding:4px 0 2px}" +
    ".bdc-rowedit input,.bdc-rowedit select,.bdc-rowedit textarea{width:100%;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:7px;padding:6px 8px;font:inherit;font-size:12.5px;background:#fff;color:var(--ink,#1A2230)}" +
    ".bdc-rowedit textarea{grid-column:1/-1;min-height:52px;resize:vertical}" +
    ".bdc-rowedit label{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);display:block;margin-bottom:3px}" +
    ".bdc-assume{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}" +
    ".bdc-assume label{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-faint,#8A93A0);display:block;margin-bottom:3px}" +
    ".bdc-assume input{width:90px;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:7px;padding:6px 8px;font:inherit;font-size:12.5px;background:#fff}" +
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
      S.progDetail = false; S.tplEditing = null; S.assetEditing = null;
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
    sb.from("bd_templates").select("*").order("day_offset", { nullsFirst: false }).order("step").then(function (r) {
      if (r.error) { S.tplErr = sbErr(r.error); } else { S.templates = r.data || []; S.tplErr = null; }
      render();
    });
  }

  /* ---- program builder: a step is a bd_templates row ---- */
  function stepSave(id, btn) {
    var day = $("bdcTplDay-" + id), lb = $("bdcTplLb-" + id), tt = $("bdcTplTt-" + id);
    var sj = $("bdcTplSj-" + id), bo = $("bdcTplBo-" + id), as = $("bdcTplAs-" + id);
    var sb = getSB(); if (!sb) return;
    var d = parseInt(day && day.value, 10);
    if (!isFinite(d) || d < 1) { alert("Day must be 1 or greater — it's how far into the program the touch fires."); return; }
    var type = tt ? tt.value : "email";
    btn.disabled = true;
    sb.from("bd_templates").update({
      day_offset: d,
      label: (lb && lb.value.trim()) || "Untitled step",
      touch_type: type,
      subject: (type === "email" && sj) ? (sj.value || null) : null,
      body: bo ? bo.value : "",
      asset_id: (as && as.value) || null
    }).eq("id", id).then(function (r) {
      btn.disabled = false;
      if (r.error) { alert("Couldn't save: " + sbErr(r.error)); return; }
      S.tplEditing = null; loadTemplates(true);
    });
  }
  function stepAdd(btn) {
    var sb = getSB(); if (!sb) return;
    var steps = planSteps();
    var last = steps.length ? steps[steps.length - 1] : null;
    btn.disabled = true; btn.textContent = "Adding…";
    sb.from("bd_templates").insert({
      step: steps.length + 1,
      day_offset: last ? last.day + 7 : 1,
      touch_type: "email",
      label: "New step",
      body: "",
      program: "10-step"
    }).select().then(function (r) {
      btn.disabled = false; btn.textContent = "+ Add step";
      if (r.error) { alert("Couldn't add the step: " + sbErr(r.error)); return; }
      var row = r.data && r.data[0];
      S.tplEditing = row ? row.id : null;   // drop straight into editing it
      loadTemplates(true);
    });
  }
  function stepDelete(id) {
    var steps = planSteps();
    if (steps.length <= 1) { alert("A program needs at least one step."); return; }
    var s = steps.filter(function (x) { return x.row && x.row.id === id; })[0];
    if (!confirm("Remove " + (s ? "“" + s.label + "”" : "this step") + " from the program?\n\nContacts mid-program keep their position number, so the touch they get next may shift.")) return;
    var sb = getSB(); if (!sb) return;
    sb.from("bd_templates").delete().eq("id", id).then(function (r) {
      if (r.error) { alert("Couldn't remove it: " + sbErr(r.error)); return; }
      S.tplEditing = null; loadTemplates(true);
    });
  }

  /* ---- asset library (bd_assets + the bd-assets bucket) ---- */
  function loadAssets(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.assetErr = "signin"; render(); return; }
    if (S.assets && !force) { render(); return; }
    sb.from("bd_assets").select("*").order("kind").order("category").order("name").then(function (r) {
      if (r.error) { S.assetErr = sbErr(r.error); } else { S.assets = r.data || []; S.assetErr = null; }
      render();
    });
  }
  function assetSave(id, btn) {
    var nm = $("bdcAsNm-" + id), ct = $("bdcAsCt-" + id), de = $("bdcAsDe-" + id);
    var sj = $("bdcAsSj-" + id), bo = $("bdcAsBo-" + id);
    var sb = getSB(); if (!sb) return;
    var name = nm ? nm.value.trim() : "";
    if (!name) { alert("Give the asset a name."); return; }
    var patch = { name: name, category: ct ? ct.value : null, description: de ? (de.value || null) : null };
    if (sj) patch.subject = sj.value || null;
    if (bo) patch.body = bo.value || null;
    btn.disabled = true;
    sb.from("bd_assets").update(patch).eq("id", id).then(function (r) {
      btn.disabled = false;
      if (r.error) { alert("Couldn't save: " + sbErr(r.error)); return; }
      S.assetEditing = null; loadAssets(true);
    });
  }
  function assetAdd(btn) {
    var kind = S.assetKind;
    var sb = getSB(); if (!sb) return;
    btn.disabled = true; btn.textContent = "Adding…";
    sb.from("bd_assets").insert({
      name: kind === "email" ? "New email template" : "New collateral piece",
      kind: kind,
      category: kind === "email" ? "deal-email" : "other"
    }).select().then(function (r) {
      btn.disabled = false; btn.textContent = kind === "email" ? "+ New email template" : "+ New collateral piece";
      if (r.error) { alert("Couldn't add it: " + sbErr(r.error)); return; }
      var row = r.data && r.data[0];
      S.assetEditing = row ? row.id : null;
      loadAssets(true);
    });
  }
  function assetDelete(id) {
    var a = (S.assets || []).filter(function (x) { return x.id === id; })[0];
    if (!confirm("Delete “" + (a ? a.name : "this asset") + "”? Any cadence step pointing at it loses the attachment.")) return;
    var sb = getSB(); if (!sb) return;
    sb.from("bd_assets").delete().eq("id", id).then(function (r) {
      if (r.error) { alert("Couldn't delete it: " + sbErr(r.error)); return; }
      S.assetEditing = null; loadAssets(true);
    });
  }
  function assetUpload(input, id) {
    var f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { alert("Keep collateral under 25 MB."); return; }
    var sb = getSB(); if (!sb || !sb.storage) return;
    token(function (t, user) {
      if (!user) return;
      sb.from("profiles").select("org_id").eq("id", user.id).single().then(function (pr) {
        var org = pr && pr.data && pr.data.org_id;
        if (!org) { alert("No org on your profile."); return; }
        var path = org + "/" + Date.now() + "-" + f.name.replace(/[^A-Za-z0-9._-]/g, "_");
        sb.storage.from("bd-assets").upload(path, f).then(function (ur) {
          if (ur.error) { alert("Upload failed: " + sbErr(ur.error)); return; }
          sb.from("bd_assets").update({ file_path: path }).eq("id", id).then(function () { loadAssets(true); });
        });
      });
    });
  }
  function assetOpen(path) {
    var sb = getSB(); if (!sb || !sb.storage) return;
    sb.storage.from("bd-assets").createSignedUrl(path, 3600).then(function (r) {
      var u = r && r.data && (r.data.signedUrl || r.data.signedURL);
      if (u) window.open(u, "_blank"); else alert("Couldn't open the file.");
    });
  }

  // Proposals: the store for TEMPLATED proposals — the reusable documents we
  // send, nothing else (Andrew's call). Live deal proposals stay on their deal
  // page. Rows are proposal_templates, which already carries its own RLS
  // (your own + firm-shared) and feeds the AI drafter on the deal page.
  function loadProposals(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.propErr = "signin"; render(); return; }
    if (S.props && !force) { render(); return; }
    sb.from("proposal_templates").select("*").order("updated_at", { ascending: false })
      .then(function (r) {
        if (r.error) { S.propErr = sbErr(r.error); } else { S.props = r.data || []; S.propErr = null; }
        render();
      });
  }

  function propSave(id, btn) {
    var nm = $("bdcPropNm-" + id), ds = $("bdcPropDs-" + id), bo = $("bdcPropBo-" + id);
    var name = nm ? nm.value.trim() : "";
    if (!name) { alert("Give the template a name."); return; }
    var sb = getSB(); if (!sb) return;
    btn.disabled = true;
    sb.from("proposal_templates").update({ name: name, description: ds ? (ds.value || null) : null, body: bo ? bo.value : null, updated_at: new Date().toISOString() }).eq("id", id)
      .then(function (r) {
        btn.disabled = false;
        if (r.error) { alert("Couldn't save: " + sbErr(r.error)); return; }
        S.propEditing = null; loadProposals(true);
      });
  }
  function propAdd(btn) {
    var name = ($("bdcPropNewNm") || {}).value || "", ds = ($("bdcPropNewDs") || {}).value || "", bo = ($("bdcPropNewBo") || {}).value || "";
    name = name.trim();
    if (!name) { alert("Give the template a name."); return; }
    var sb = getSB(); if (!sb) return;
    btn.disabled = true;
    token(function (t, user) {
      if (!user) { btn.disabled = false; return; }
      sb.from("proposal_templates").insert({ owner_id: user.id, name: name, description: ds.trim() || null, body: bo || null, is_shared: true })
        .then(function (r) {
          btn.disabled = false;
          if (r.error) { alert("Couldn't add the template: " + sbErr(r.error)); return; }
          ["bdcPropNewNm", "bdcPropNewDs", "bdcPropNewBo"].forEach(function (i) { if ($(i)) $(i).value = ""; });
          loadProposals(true);
        });
    });
  }
  function propDelete(id) {
    if (!confirm("Delete this proposal template? Deals already drafted from it are unaffected.")) return;
    var sb = getSB(); if (!sb) return;
    sb.from("proposal_templates").delete().eq("id", id).then(function (r) {
      if (r.error) { alert("Couldn't delete: " + sbErr(r.error)); return; }
      loadProposals(true);
    });
  }
  // The template document itself (Word/PDF) lives in the private bd-assets
  // bucket under the org's folder; storage_path points at it.
  function propUpload(input, id) {
    var f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { alert("Keep template files under 25 MB."); return; }
    var sb = getSB(); if (!sb || !sb.storage) return;
    token(function (t, user) {
      if (!user) return;
      sb.from("profiles").select("org_id").eq("id", user.id).single().then(function (pr) {
        var org = pr && pr.data && pr.data.org_id;
        if (!org) { alert("No org on your profile."); return; }
        var path = org + "/proposals/" + Date.now() + "-" + f.name.replace(/[^A-Za-z0-9._-]/g, "_");
        sb.storage.from("bd-assets").upload(path, f).then(function (ur) {
          if (ur.error) { alert("Upload failed: " + sbErr(ur.error)); return; }
          if (id) {
            sb.from("proposal_templates").update({ storage_path: path, updated_at: new Date().toISOString() }).eq("id", id).then(function () { loadProposals(true); });
          } else {
            token(function (t2, u2) {
              sb.from("proposal_templates").insert({ owner_id: u2.id, name: f.name.replace(/\.[^.]+$/, ""), storage_path: path, is_shared: true })
                .then(function () { loadProposals(true); });
            });
          }
        });
      });
    });
  }
  function propOpenFile(path) {
    var sb = getSB(); if (!sb || !sb.storage) return;
    sb.storage.from("bd-assets").createSignedUrl(path, 3600).then(function (r) {
      var u = r && r.data && (r.data.signedUrl || r.data.signedURL);
      if (u) window.open(u, "_blank"); else alert("Couldn't open that file.");
    });
  }

  /* ---------------- data: directory scan ---------------- */
  // The photo → prospect-list pipeline. The row in bd_directory_scans is both
  // the job (staged photos + status, polled here) and the saved result, so a
  // scan from last month reopens with your edits intact. The heavy columns
  // (photos, raw) are never selected into the browser.
  var SCAN_COLS = "id,building_name,address,submarket,note,status,error,companies,unreadable,assumptions,created_at,updated_at";
  var dirPhotos = [];   // staged in memory until the scan starts

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function loadScans(force) {
    var sb = getSB(); if (!sb || !sb.from) { S.scanErr = "signin"; render(); return; }
    if (S.scans && !force) { render(); return; }
    sb.from("bd_directory_scans").select(SCAN_COLS).order("created_at", { ascending: false }).limit(100)
      .then(function (r) {
        if (r.error) { S.scanErr = sbErr(r.error); } else { S.scans = r.data || []; S.scanErr = null; }
        if (S.scans && S.scans.length && !scanById(S.scanId)) S.scanId = S.scans[0].id;
        // A scan left mid-flight (tab closed during the research pass) picks
        // its polling back up the moment you return to the view.
        if (S.scans && S.scans.some(function (s) { return s.status === "queued" || s.status === "running"; })) startPoll();
        render();
      });
  }
  function scanById(id) {
    return (S.scans || []).filter(function (s) { return s.id === id; })[0] || null;
  }
  function selScan(id) { S.scanId = id; S.scanOpenRow = null; render(); }

  function addPhotos(input) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = "";
    if (!files.length) return;
    if (dirPhotos.length + files.length > 4) { alert("Four photos per scan — that's plenty for one board. Run a second scan for the rest."); return; }
    files.forEach(function (f) {
      if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type)) { alert(f.name + " isn't a photo. Use a JPEG, PNG, or WebP."); return; }
      if (f.size > 8 * 1024 * 1024) { alert(f.name + " is over 8 MB — retake it at a lower resolution."); return; }
      var rd = new FileReader();
      rd.onload = function () {
        var s = String(rd.result || "");
        var comma = s.indexOf(",");
        dirPhotos.push({
          name: f.name,
          media_type: /^image\/(jpeg|png|webp)$/i.test(f.type) ? f.type.toLowerCase() : "image/jpeg",
          data: comma >= 0 ? s.slice(comma + 1) : s,
          url: s
        });
        render();
      };
      rd.readAsDataURL(f);
    });
  }
  function removePhoto(i) { dirPhotos.splice(i, 1); render(); }

  function startScan(btn) {
    if (!dirPhotos.length) { alert("Add a photo of the directory board first."); return; }
    var sb = getSB(); if (!sb) return;
    var id = uuid();
    var row = {
      id: id,
      building_name: (($("bdcScanName") || {}).value || "").trim() || null,
      address: (($("bdcScanAddr") || {}).value || "").trim() || null,
      submarket: (($("bdcScanSub") || {}).value || "").trim() || null,
      note: (($("bdcScanNote") || {}).value || "").trim() || null,
      photos: dirPhotos.map(function (p) { return { media_type: p.media_type, data: p.data }; }),
      status: "queued"
    };
    S.scanBusy = true; render();
    sb.from("bd_directory_scans").insert(row).then(function (r) {
      if (r.error) { S.scanBusy = false; alert("Couldn't stage the scan: " + sbErr(r.error)); render(); return; }
      token(function (t) {
        if (!t) { S.scanBusy = false; render(); return; }
        // Background function: this 202s immediately and the row carries the outcome.
        fetch("/.netlify/functions/bd-directory-scan-background", {
          method: "POST", body: JSON.stringify({ token: t, jobId: id })
        }).catch(function () { /* the row's status is the source of truth */ });
        dirPhotos = [];
        ["bdcScanName", "bdcScanAddr", "bdcScanSub", "bdcScanNote"].forEach(function (i) { if ($(i)) $(i).value = ""; });
        S.scanBusy = false; S.scanId = id;
        loadScans(true);
        startPoll();
      });
    });
  }

  function startPoll() {
    if (S.scanPoll) return;
    S.scanPoll = setInterval(function () {
      var sb = getSB(); if (!sb || !sb.from) return;
      sb.from("bd_directory_scans").select(SCAN_COLS).in("status", ["queued", "running"])
        .then(function (r) {
          if (r.error) return;
          var live = r.data || [];
          if (!live.length) { stopPoll(); loadScans(true); return; }
          // Keep the chips' status labels fresh while we wait.
          var changed = false;
          live.forEach(function (row) {
            var cur = scanById(row.id);
            if (cur && cur.status !== row.status) { cur.status = row.status; changed = true; }
          });
          if (changed) render();
        });
    }, 4000);
  }
  function stopPoll() { if (S.scanPoll) { clearInterval(S.scanPoll); S.scanPoll = null; } }

  function saveScan(btn) {
    var scan = scanById(S.scanId); if (!scan) return;
    var sb = getSB(); if (!sb) return;
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    sb.from("bd_directory_scans").update({
      companies: scan.companies || [],
      assumptions: assumptionsOf(scan),
      building_name: scan.building_name || null,
      address: scan.address || null,
      submarket: scan.submarket || null
    }).eq("id", scan.id).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = "Save changes"; }
      if (r.error) { alert("Couldn't save: " + sbErr(r.error)); return; }
      S.scanOpenRow = null; render();
    });
  }
  function deleteScan(id) {
    var scan = scanById(id); if (!scan) return;
    if (!confirm("Delete the scan of " + (scan.building_name || scan.address || "this building") + "? The tenant list and your edits go with it.")) return;
    var sb = getSB(); if (!sb) return;
    sb.from("bd_directory_scans").delete().eq("id", id).then(function (r) {
      if (r.error) { alert("Couldn't delete: " + sbErr(r.error)); return; }
      S.scanId = null; loadScans(true);
    });
  }

  function scanRows(scan) { return Array.isArray(scan && scan.companies) ? scan.companies : []; }
  function toggleRow(i) {
    var scan = scanById(S.scanId); if (!scan) return;
    var rows = scanRows(scan);
    if (rows[i]) { rows[i].include = !rows[i].include; render(); }
  }
  function rowSave(i, btn) {
    var scan = scanById(S.scanId); if (!scan) return;
    var row = scanRows(scan)[i]; if (!row) return;
    function val(id) { var el = $(id + "-" + i); return el ? el.value.trim() : ""; }
    row.company = val("bdcDCo") || row.company;
    row.suite = val("bdcDSuite");
    row.domain = val("bdcDDom").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    row.industry = val("bdcDInd");
    row.dm_location = val("bdcDDml");
    var emp = val("bdcDEmp");
    row.la_employees = emp === "" ? null : Math.max(0, Math.round(Number(emp) || 0));
    row.flag = val("bdcDFlag") || row.flag;
    row.notes = val("bdcDNotes");
    S.scanOpenRow = null;
    saveScan(btn);
  }
  function rowDrop(i) {
    var scan = scanById(S.scanId); if (!scan) return;
    var rows = scanRows(scan);
    if (!rows[i]) return;
    if (!confirm("Remove " + rows[i].company + " from this scan? (To keep it but leave it out of the export, just untick it.)")) return;
    rows.splice(i, 1);
    S.scanOpenRow = null;
    saveScan(null);
  }
  function assumeSave(btn) {
    var scan = scanById(S.scanId); if (!scan) return;
    function n(id, fb) { var el = $(id); var v = el ? Number(el.value) : NaN; return isFinite(v) && v > 0 ? v : fb; }
    var d = assumptionsOf(scan);
    scan.assumptions = {
      sqft_low: n("bdcAsSqL", d.sqft_low), sqft_high: n("bdcAsSqH", d.sqft_high),
      psf_low: n("bdcAsPsL", d.psf_low), psf_high: n("bdcAsPsH", d.psf_high)
    };
    saveScan(btn);
  }

  /* ---- export: the whole point — a file that imports straight into HubSpot ---- */
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvFile(headers, rows) {
    // The BOM is what makes Excel open a UTF-8 CSV without mangling accents.
    return "﻿" + [headers].concat(rows).map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
  }
  function download(name, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function slug(s) { return String(s || "building").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "building"; }
  // Every tenant shares the building's address, so one parse serves the file.
  function splitAddress(addr) {
    var parts = String(addr || "").split(",").map(function (p) { return p.trim(); }).filter(Boolean);
    var out = { street: parts[0] || "", city: "", state: "", zip: "" };
    if (parts.length >= 2) out.city = parts[1];
    var tail = parts.length >= 3 ? parts[2] : "";
    var m = tail.match(/([A-Za-z]{2})\b/);
    if (m) out.state = m[1].toUpperCase();
    var z = tail.match(/\b(\d{5}(?:-\d{4})?)\b/);
    if (z) out.zip = z[1];
    return out;
  }
  function exportRows(scan) {
    return scanRows(scan).filter(function (r) { return r.include !== false; });
  }
  function exportHubSpot() {
    var scan = scanById(S.scanId); if (!scan) return;
    var rows = exportRows(scan);
    if (!rows.length) { alert("Nothing ticked to export."); return; }
    var a = assumptionsOf(scan), ad = splitAddress(scan.address);
    // Header labels are HubSpot's own company-property names, so the importer
    // auto-maps every column. Headcount / Estimated RSF / Vantage Building ID
    // are the custom properties hubspot-bootstrap creates.
    var headers = ["Name", "Company Domain Name", "Website URL", "Industry", "Description",
      "Street Address", "City", "State/Region", "Postal Code",
      "Number of Employees", "Headcount", "Estimated RSF", "Vantage Building ID"];
    var buildingId = scan.building_name || scan.address || "";
    var out = rows.map(function (r) {
      return [
        r.company, r.domain, r.website, r.industry,
        [r.description, r.suite ? "Suite " + r.suite + " at " + (scan.building_name || scan.address || "the building") : "",
          r.dm_location ? "Decision-makers: " + (r.dm_titles ? r.dm_titles + " — " : "") + r.dm_location : "",
          r.notes].filter(Boolean).join(" · "),
        ad.street, ad.city, ad.state, ad.zip,
        r.employees_total == null ? "" : r.employees_total,
        r.la_employees == null ? "" : r.la_employees,
        r.la_employees == null ? "" : Math.round(r.la_employees * a.sqft_low),
        buildingId
      ];
    });
    download("hubspot-companies-" + slug(scan.building_name || scan.address) + ".csv", csvFile(headers, out));
  }
  function exportFull() {
    var scan = scanById(S.scanId); if (!scan) return;
    var rows = exportRows(scan);
    if (!rows.length) { alert("Nothing ticked to export."); return; }
    var a = assumptionsOf(scan);
    var headers = ["#", "Company", "Suite", "Domain", "Website", "Industry", "Description",
      "HQ City", "HQ State", "HQ Country", "LA Employees", "Total Employees",
      "Decision-Maker Titles", "Decision-Maker Location", "Flag", "Confidence",
      "Est. Sqft (Low)", "Est. Annual Rent (Low)", "Est. Sqft (High)", "Est. Annual Rent (High)",
      "Notes", "Sources"];
    var out = rows.map(function (r, i) {
      var e = r.la_employees;
      return [i + 1, r.company, r.suite, r.domain, r.website, r.industry, r.description,
        r.hq_city, r.hq_state, r.hq_country,
        e == null ? "" : e, r.employees_total == null ? "" : r.employees_total,
        r.dm_titles, r.dm_location, r.flag, r.confidence,
        e == null ? "" : Math.round(e * a.sqft_low),
        e == null ? "" : Math.round(e * a.sqft_low * a.psf_low),
        e == null ? "" : Math.round(e * a.sqft_high),
        e == null ? "" : Math.round(e * a.sqft_high * a.psf_high),
        r.notes, (r.sources || []).join(" | ")];
    });
    download("directory-analysis-" + slug(scan.building_name || scan.address) + ".csv", csvFile(headers, out));
  }

  function loadView() {
    if (S.view === "overview") load();
    else if (S.view === "directory") loadScans();
    else if (S.view === "newsletter") loadClips();
    else if (S.view === "signals") loadSignals();
    else if (S.view === "proposals") loadProposals();
    else if (S.view === "program") { loadProgram(); loadTemplates(); loadAssets(); }
    // Templates shows a summary card for each program, so it needs the steps too.
    else if (S.view === "templates") { loadAssets(); loadTemplates(); }
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
  window.__bdTplSave = stepSave;
  window.__bdStepAdd = stepAdd; window.__bdStepDelete = stepDelete;
  window.__bdProgOpen = function () { S.progDetail = true; loadTemplates(); loadAssets(); render(); };
  window.__bdProgBack = function () { S.progDetail = false; render(); };
  // Templates → a program card jumps into the builder, which lives under Marketing Programs.
  window.__bdProgJump = function () { S.view = "program"; S.progDetail = true; setSubState(true); loadProgram(); loadTemplates(); loadAssets(); render(); };
  window.__bdAssetKind = function (k) { S.assetKind = k; S.assetEditing = null; render(); };
  window.__bdAssetEdit = function (id) { S.assetEditing = id; render(); };
  window.__bdAssetCancel = function () { S.assetEditing = null; render(); };
  window.__bdAssetSave = assetSave; window.__bdAssetAdd = assetAdd;
  window.__bdAssetDelete = assetDelete; window.__bdAssetUpload = assetUpload; window.__bdAssetOpen = assetOpen;
  window.__bdAddPhotos = addPhotos; window.__bdRemovePhoto = removePhoto;
  window.__bdStartScan = startScan; window.__bdSelScan = selScan;
  window.__bdSaveScan = saveScan; window.__bdDeleteScan = deleteScan;
  window.__bdToggleRow = toggleRow;
  window.__bdRowEdit = function (i) { S.scanOpenRow = S.scanOpenRow === i ? null : i; render(); };
  window.__bdRowSave = rowSave; window.__bdRowDrop = rowDrop;
  window.__bdAssumeSave = assumeSave;
  window.__bdExportHS = exportHubSpot; window.__bdExportFull = exportFull;
  window.__bdScanAll = function (on) {
    var scan = scanById(S.scanId); if (!scan) return;
    scanRows(scan).forEach(function (r) { r.include = !!on; });
    render();
  };

  window.__bdReloadForce = function () {
    if (S.view === "directory") loadScans(true);
    else if (S.view === "newsletter") loadClips(true);
    else if (S.view === "signals") loadSignals(true);
    else if (S.view === "proposals") loadProposals(true);
    else if (S.view === "program") { loadProgram(true); loadTemplates(true); loadAssets(true); }
    else if (S.view === "templates") { loadAssets(true); loadTemplates(true); }
    else load();
  };

  window.__bdPropEdit = function (id) { S.propEditing = id; render(); };
  window.__bdPropCancel = function () { S.propEditing = null; render(); };
  window.__bdPropSave = propSave; window.__bdPropAdd = propAdd; window.__bdPropDelete = propDelete;
  window.__bdPropUpload = propUpload; window.__bdPropOpenFile = propOpenFile;

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

  function assetById(id) {
    if (!id) return null;
    return (S.assets || []).filter(function (a) { return a.id === id; })[0] || null;
  }

  // One cadence step, in read or edit mode. `editable` false = the read-only
  // cadence (nothing here writes); true = the full builder.
  function stepHtml(p, editable) {
    var t = p.row;
    var body;
    if (!t) {
      body = '<div class="bdc-empty">Loading the saved program…</div>';
    } else if (editable && S.tplEditing === t.id) {
      var isEmail = p.type === "email";
      var opts = (S.assets || []).filter(function (a) { return a.kind === "collateral"; })
        .map(function (a) { return '<option value="' + a.id + '"' + (t.asset_id === a.id ? " selected" : "") + ">" + esc(a.name) + "</option>"; }).join("");
      body = '<div class="bdc-edit">' +
        '<div class="bdc-bgrid">' +
        '<label class="bdc-daybox">Fires on day <input id="bdcTplDay-' + t.id + '" type="number" min="1" value="' + (p.day) + '" /></label>' +
        '<select id="bdcTplTt-' + t.id + '" onchange="var r=document.getElementById(\'bdcTplSjRow-' + t.id + '\');if(r)r.style.display=this.value===\'email\'?\'\':\'none\'">' +
        ["email", "call", "mail"].map(function (k) { return '<option value="' + k + '"' + (p.type === k ? " selected" : "") + ">" + k + "</option>"; }).join("") +
        "</select></div>" +
        '<input id="bdcTplLb-' + t.id + '" value="' + esc(t.label || p.label) + '" placeholder="Step title — what this touch is" />' +
        '<div id="bdcTplSjRow-' + t.id + '"' + (isEmail ? "" : ' style="display:none"') + '><input id="bdcTplSj-' + t.id + '" value="' + esc(t.subject || "") + '" placeholder="Subject line" /></div>' +
        '<textarea id="bdcTplBo-' + t.id + '" placeholder="' + (p.type === "call" ? "Talking points for the call" : p.type === "mail" ? "What gets printed and mailed" : "Email copy") + '">' + esc(t.body || "") + "</textarea>" +
        '<select id="bdcTplAs-' + t.id + '"><option value="">No attached piece</option>' + opts + "</select>" +
        '<div class="bdc-item-act">' +
        '<button class="bdc-btn pri" onclick="__bdTplSave(\'' + t.id + "',this)\">Save step</button>" +
        '<button class="bdc-btn" onclick="__bdTplCancel()">Cancel</button>' +
        '<button class="bdc-btn dngr" style="margin-left:auto" onclick="__bdStepDelete(\'' + t.id + "')\">Remove step</button>" +
        "</div></div>";
    } else {
      var a = assetById(t.asset_id);
      body = '<div class="bdc-prev">' + (t.subject ? '<span class="sj">' + esc(t.subject) + "</span>" : "") + esc(t.body || "") + "</div>" +
        (a ? '<div class="bdc-attach"><span class="bdc-clip-tag">attached</span>' + esc(a.name) +
          (a.file_path ? ' · <a onclick="__bdAssetOpen(\'' + esc(a.file_path) + "')\">open</a>" : ' · <span style="color:var(--ink-faint,#8A93A0)">no file uploaded yet</span>') + "</div>" : "") +
        (editable ? '<div class="bdc-item-act"><button class="bdc-btn" onclick="__bdTplEdit(\'' + t.id + "')\">Edit</button></div>" : "");
    }
    return '<div class="bdc-tlstep ' + p.type + '">' +
      '<div class="bdc-tlhead"><span class="bdc-tlday">Day ' + p.day + '</span><span class="bdc-tt ' + p.type + '">' + p.type + '</span><span class="bdc-tllabel">Step ' + p.pos + " — " + esc(p.label) + "</span></div>" +
      '<div class="bdc-tlbody">' + body + "</div></div>";
  }

  function cadenceHtml(editable) {
    // No saved rows at all: the timeline would be ten uneditable placeholders,
    // so offer the one thing that helps instead.
    if (editable && S.templates && !S.templates.length) {
      return '<div class="bdc-empty">This program has no steps yet.</div>' +
        '<div class="bdc-addstep"><button class="bdc-btn pri" onclick="__bdStepAdd(this)">+ Add the first step</button></div>';
    }
    var steps = planSteps();
    var out = '<div class="bdc-tl">';
    steps.forEach(function (p, i) {
      out += stepHtml(p, editable);
      if (i < steps.length - 1) {
        var gap = steps[i + 1].day - p.day;
        out += '<div class="bdc-tlgap">' + (gap > 0 ? "wait " + gap + " day" + (gap === 1 ? "" : "s") : "same day") + "</div>";
      }
    });
    out += "</div>";
    if (editable) {
      out += '<div class="bdc-addstep"><button class="bdc-btn" onclick="__bdStepAdd(this)">+ Add step</button>' +
        '<span class="bdc-empty" style="padding:0">New steps land a week after the last one — change the day to move a step anywhere in the sequence.</span></div>';
    }
    return out;
  }

  function tenStepCardHtml(open) {
    var steps = planSteps();
    var counts = { email: 0, call: 0, mail: 0 };
    steps.forEach(function (p) { counts[p.type]++; });
    var d = S.program;
    var active = 0, total = 0;
    if (d && d.contacts) {
      total = d.contacts.length;
      active = d.contacts.filter(function (c) { return /active/i.test(String(c.status || "")); }).length;
    }
    function n(c, one, many) { return c ? c + " " + (c === 1 ? one : many) : null; }
    var parts = [planDays() + " days", n(counts.email, "email", "emails"), n(counts.call, "call", "calls"), n(counts.mail, "mail piece", "mail pieces")]
      .filter(Boolean).join(" · ");
    return '<div class="bdc-progcard" onclick="' + open + '">' +
      '<div class="pn">10-Step Cold Outreach</div>' +
      '<div class="pm">' + parts + " · brochure-led, one ask: a 15–20 min intro meeting" +
      (total ? "<br>" + active + " active · " + total + " total in program" : "") + "</div>" +
      '<div class="pv">Open the builder →</div></div>';
  }

  function renderProgram(el) {
    if (S.progDetail) {
      var headD = viewHead("10-Step Cold Outreach", "The program itself — retitle a touch, move it to a different day, swap its type, attach a piece, add or remove steps.",
        '<button class="bdc-btn" onclick="__bdProgBack()">← All programs</button>' +
        '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
      if (S.tplErr === "signin") { el.innerHTML = headD + signinCard(); return; }
      if (S.templates === null) { el.innerHTML = headD + '<div class="bdc-card"><div class="bdc-empty">' + (S.tplErr ? esc(S.tplErr) : "Loading the program…") + "</div></div>"; return; }
      var st = planSteps();
      el.innerHTML = headD + '<div class="bdc-card"><h3>Cadence — ' + planDays() + " days, " + st.length + " touch" + (st.length === 1 ? "" : "es") + "</h3>" + cadenceHtml(true) + "</div>" +
        '<div class="bdc-note">Day numbers are the ordering truth — the engine sorts by them and renumbers the steps, so moving a touch to day 3 makes it step 2. Contacts already mid-program hold their POSITION, so reordering shifts what they get next. Rules still wired into the engine: any reply pauses the program · silence past the last step → Never responded → the nurture pool resurfaces them ~9 months before lease expiration.</div>';
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
                  '<div class="st">' + (c.step ? '<span class="bdc-stepchip">step ' + c.step + "/" + planSteps().length + "</span>" : "") +
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

  /* ---------------- render: templates (the asset library) ---------------- */
  function assetCardHtml(a) {
    var isEmail = a.kind === "email";
    if (S.assetEditing === a.id) {
      var cats = (ASSET_CATS[a.kind] || []).map(function (p) {
        return '<option value="' + p[0] + '"' + (a.category === p[0] ? " selected" : "") + ">" + esc(p[1]) + "</option>";
      }).join("");
      return '<div class="bdc-asset"><div class="bdc-edit" style="margin-top:0">' +
        '<input id="bdcAsNm-' + a.id + '" value="' + esc(a.name) + '" placeholder="Name" style="margin-top:0" />' +
        '<select id="bdcAsCt-' + a.id + '" style="width:100%;box-sizing:border-box;border:1px solid var(--line-2,#D2CCBF);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;background:#fff;margin-top:8px">' + cats + "</select>" +
        '<input id="bdcAsDe-' + a.id + '" value="' + esc(a.description || "") + '" placeholder="What it is / when you send it" />' +
        (isEmail ? '<input id="bdcAsSj-' + a.id + '" value="' + esc(a.subject || "") + '" placeholder="Subject line" />' +
          '<textarea id="bdcAsBo-' + a.id + '" placeholder="Copy — merge fields welcome">' + esc(a.body || "") + "</textarea>" : "") +
        '<div class="bdc-item-act">' +
        '<button class="bdc-btn pri" onclick="__bdAssetSave(\'' + a.id + "',this)\">Save</button>" +
        '<button class="bdc-btn" onclick="__bdAssetCancel()">Cancel</button>' +
        '<button class="bdc-btn dngr" style="margin-left:auto" onclick="__bdAssetDelete(\'' + a.id + "')\">Delete</button>" +
        "</div></div></div>";
    }
    var fileLine = isEmail
      ? (a.subject ? '<div class="af"><span class="sj" style="font-weight:600">' + esc(a.subject) + "</span></div>" : "")
      : '<div class="af">' + (a.file_path
        ? '📄 <a onclick="__bdAssetOpen(\'' + esc(a.file_path) + "')\">Open file</a>"
        : '<span class="none">No file yet</span>') +
        '<label class="bdc-btn" style="padding:4px 9px;font-size:12px">' + (a.file_path ? "Replace" : "Upload") +
        '<input type="file" class="bdc-file-in" style="display:none" onchange="__bdAssetUpload(this,\'' + a.id + '\')" /></label></div>';
    return '<div class="bdc-asset">' +
      '<div class="an">' + esc(a.name) + "</div>" +
      '<div class="ac">' + esc(catLabel(a.kind, a.category)) + "</div>" +
      (a.description ? '<div class="ad">' + esc(a.description) + "</div>" : "") +
      (isEmail && a.body ? '<div class="bdc-prev" style="max-height:110px">' + esc(a.body) + "</div>" : "") +
      fileLine +
      '<div class="bdc-item-act"><button class="bdc-btn" onclick="__bdAssetEdit(\'' + a.id + "')\">Edit</button></div></div>";
  }

  function renderTemplates(el) {
    var head = viewHead("Templates", "Two kinds: the cadence PROGRAMS (step sequences the engine runs) and the ASSET library — the collateral you mail and the reusable emails you send by hand.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.assetErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var progCard = '<div class="bdc-card"><h3>Cadence programs</h3><div class="bdc-proggrid">' +
      tenStepCardHtml("__bdProgJump()") +
      '<div class="bdc-progcard" style="opacity:.6;border-style:dashed;cursor:default">' +
      '<div class="pn">Re-engagement (coming)</div>' +
      '<div class="pm">For everyone who finishes the 10-step without a meeting — a slower drumbeat. Designed when the first cohort finishes.</div></div>' +
      "</div></div>";

    var kind = S.assetKind;
    var kindTabs = '<div class="bdc-kinds">' +
      [["collateral", "Collateral"], ["email", "Emails"]].map(function (p) {
        return '<button class="bdc-ichip' + (kind === p[0] ? " on" : "") + '" onclick="__bdAssetKind(\'' + p[0] + "')\">" + p[1] + "</button>";
      }).join("") + "</div>";

    var libBody;
    if (S.assets === null) {
      libBody = '<div class="bdc-empty">' + (S.assetErr ? esc(S.assetErr) : "Loading the library…") + "</div>";
    } else {
      var mine = S.assets.filter(function (a) { return a.kind === kind; });
      libBody = kindTabs + (mine.length
        ? '<div class="bdc-agrid">' + mine.map(assetCardHtml).join("") + "</div>"
        : '<div class="bdc-empty">Nothing here yet.</div>') +
        '<div class="bdc-addstep"><button class="bdc-btn" onclick="__bdAssetAdd(this)">+ ' +
        (kind === "email" ? "New email template" : "New collateral piece") + "</button></div>";
    }
    var libCard = '<div class="bdc-card"><h3>Asset library</h3>' + libBody + "</div>";

    el.innerHTML = head + progCard + libCard +
      '<div class="bdc-note">Collateral is what physically goes out — upload the print-ready file and attach it to the cadence step that mails it. Emails here are the one-off copy you reach for by hand (tour follow-ups, renewal openers); the cadence steps keep their own copy inside the program. Merge fields: {{first_name}} {{last_name}} {{company}} {{submarket}} {{title}} — unknown fields render blank, never as braces.</div>';
  }

  /* ---------------- render: proposals (templated proposals only) ---------------- */
  function propCardHtml(t) {
    var editing = S.propEditing === t.id;
    if (editing) {
      return '<div class="bdc-item email"><div class="bdc-edit">' +
        '<input id="bdcPropNm-' + t.id + '" value="' + esc(t.name || "") + '" placeholder="Template name" />' +
        '<input id="bdcPropDs-' + t.id + '" value="' + esc(t.description || "") + '" placeholder="When to use it" />' +
        '<textarea id="bdcPropBo-' + t.id + '" placeholder="The proposal text. Placeholders like {{tenant_name}} get filled per deal.">' + esc(t.body || "") + "</textarea>" +
        '<div class="bdc-item-act">' +
        '<button class="bdc-btn pri" onclick="__bdPropSave(\'' + t.id + "',this)\">Save</button>" +
        '<button class="bdc-btn" onclick="__bdPropCancel()">Cancel</button>' +
        '<label class="bdc-btn" style="display:inline-block">' + (t.storage_path ? "Replace file" : "Attach file") +
        '<input type="file" style="display:none" accept=".docx,.doc,.pdf,.rtf,.txt" onchange="__bdPropUpload(this,\'' + t.id + '\')" /></label>' +
        '<button class="bdc-btn dngr" onclick="__bdPropDelete(\'' + t.id + "')\">Delete</button>" +
        "</div></div></div>";
    }
    var fields = Array.isArray(t.fields) ? t.fields : [];
    return '<div class="bdc-item email">' +
      '<div class="bdc-item-top"><span class="bdc-who">' + esc(t.name || "Untitled template") + "</span>" +
      (t.storage_path ? '<span class="bdc-src">file</span>' : "") +
      '<span class="bdc-due">updated ' + ago(t.updated_at) + "</span></div>" +
      (t.description ? '<div class="bdc-step">' + esc(t.description) + "</div>" : "") +
      (t.body ? '<div class="bdc-prev">' + esc(t.body) + "</div>" : "") +
      '<div class="bdc-item-act">' +
      '<button class="bdc-btn" onclick="__bdPropEdit(\'' + t.id + "')\">Edit</button>" +
      (t.storage_path ? '<button class="bdc-btn" onclick="__bdPropOpenFile(\'' + esc(t.storage_path) + "')\">Open file</button>" : "") +
      (fields.length ? '<span class="bdc-note" style="margin:0;align-self:center">' + fields.length + " merge field" + (fields.length === 1 ? "" : "s") + "</span>" : "") +
      "</div></div>";
  }

  function renderProposals(el) {
    var head = viewHead("Proposals", "Your templated proposals — the reusable documents you send. Live deal proposals stay on their deal.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.propErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var list = S.props;
    if (list === null) { el.innerHTML = head + '<div class="bdc-card"><div class="bdc-empty">' + (S.propErr ? "Couldn't load: " + esc(S.propErr) : "Loading templates…") + "</div></div>"; return; }

    var addCard = '<div class="bdc-card"><h3>Add a proposal template</h3><div class="bdc-form">' +
      '<input id="bdcPropNewNm" placeholder="Template name — e.g. “Havill &amp; Co. standard proposal”" />' +
      '<input id="bdcPropNewDs" placeholder="When to use it (optional)" />' +
      '<textarea id="bdcPropNewBo" rows="4" placeholder="The proposal text (optional). Placeholders like {{tenant_name}} or {{base_rent_psf}} get filled per deal."></textarea>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="bdc-btn pri" onclick="__bdPropAdd(this)">+ Add template</button>' +
      '<label class="bdc-btn" style="display:inline-block">Upload a document<input type="file" style="display:none" accept=".docx,.doc,.pdf,.rtf,.txt" onchange="__bdPropUpload(this,null)" /></label>' +
      '<span class="bdc-note" style="margin:0">Word or PDF is fine — uploading one on its own creates a template named after the file.</span>' +
      "</div></div></div>";

    var listCard = '<div class="bdc-card"><h3>Proposal templates — ' + list.length + "</h3>" +
      (list.length ? '<div class="bdc-q">' + list.map(propCardHtml).join("") + "</div>"
        : '<div class="bdc-empty">No proposal templates yet. Add your standard proposal above — you have <em>Havill-Co-Proposal-Template.docx</em> sitting in the repo folder ready to upload.</div>') +
      "</div>";

    el.innerHTML = head + addCard + listCard +
      '<div class="bdc-note">These are the same templates the AI drafter uses on a deal page: it fills the placeholders from that deal\'s notes and proposal rounds. Templates are firm-wide by default; files live in private storage and open through a signed link.</div>';
  }

  /* ---------------- render: directory scan ---------------- */
  function flagClass(f) {
    if (f === "OK") return "ok";
    if (f === "DM Outside LA") return "out";
    if (f === "DM International") return "intl";
    return "";
  }

  function scanRowHtml(r, i, a) {
    var e = r.la_employees;
    var editing = S.scanOpenRow === i;
    var main = "<tr class=\"" + (r.include === false ? "off" : "") + "\">" +
      '<td><input type="checkbox" ' + (r.include === false ? "" : "checked") + ' onchange="__bdToggleRow(' + i + ')" /></td>' +
      '<td><div class="co">' + esc(r.company) + (r.suite ? ' <span class="bdc-conf">· Ste ' + esc(r.suite) + "</span>" : "") + "</div>" +
      '<div class="sub">' + (r.domain ? esc(r.domain) : '<span style="color:var(--dining,#C9543F)">no domain found</span>') +
      (r.industry ? " · " + esc(r.industry) : "") + "</div>" +
      '<button class="rowbtn" onclick="__bdRowEdit(' + i + ')">' + (editing ? "Close" : "Edit") + "</button></td>" +
      '<td class="num">' + intFmt(e) + "</td>" +
      '<td class="num">' + (e == null ? "—" : intFmt(Math.round(e * a.sqft_low))) + "</td>" +
      '<td class="num">' + (e == null ? "—" : money(e * a.sqft_low * a.psf_low) + " – " + money(e * a.sqft_high * a.psf_high)) + "</td>" +
      "<td><span class=\"bdc-flag " + flagClass(r.flag) + '">' + esc(r.flag || "Unclear") + "</span>" +
      (r.dm_location ? '<div class="sub">' + esc(r.dm_location) + "</div>" : "") + "</td>" +
      '<td><span class="bdc-conf ' + (r.confidence === "low" ? "low" : "") + '">' + esc(r.confidence || "low") + "</span></td></tr>";

    if (!editing) return main;

    var flags = ["OK", "DM Outside LA", "DM International", "Unclear"];
    return main + '<tr><td colspan="7" style="background:var(--paper,#F7F5F0)"><div class="bdc-rowedit">' +
      '<div><label>Company</label><input id="bdcDCo-' + i + '" value="' + esc(r.company) + '" /></div>' +
      '<div><label>Suite</label><input id="bdcDSuite-' + i + '" value="' + esc(r.suite || "") + '" /></div>' +
      '<div><label>Domain</label><input id="bdcDDom-' + i + '" value="' + esc(r.domain || "") + '" placeholder="acme.com" /></div>' +
      '<div><label>Industry</label><input id="bdcDInd-' + i + '" value="' + esc(r.industry || "") + '" /></div>' +
      '<div><label>LA employees</label><input id="bdcDEmp-' + i + '" type="number" min="0" value="' + (r.la_employees == null ? "" : r.la_employees) + '" /></div>' +
      '<div><label>Decision-makers</label><input id="bdcDDml-' + i + '" value="' + esc(r.dm_location || "") + '" placeholder="City where they sit" /></div>' +
      '<div><label>Flag</label><select id="bdcDFlag-' + i + '">' +
      flags.map(function (f) { return '<option value="' + f + '"' + (r.flag === f ? " selected" : "") + ">" + f + "</option>"; }).join("") +
      "</select></div>" +
      '<textarea id="bdcDNotes-' + i + '" placeholder="Notes">' + esc(r.notes || "") + "</textarea>" +
      "</div>" +
      (r.sources && r.sources.length
        ? '<div class="bdc-note" style="margin:6px 0 0">Sources: ' + r.sources.map(function (u) {
            return '<a href="' + esc(u) + '" target="_blank" rel="noopener" style="color:var(--accent,#2D6E7E)">' + esc(u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)) + "</a>";
          }).join(" · ") + "</div>"
        : "") +
      '<div class="bdc-item-act"><button class="bdc-btn pri" onclick="__bdRowSave(' + i + ',this)">Save row</button>' +
      '<button class="bdc-btn" onclick="__bdRowEdit(' + i + ')">Cancel</button>' +
      '<button class="bdc-btn dngr" style="margin-left:auto" onclick="__bdRowDrop(' + i + ')">Remove</button></div>' +
      "</td></tr>";
  }

  function scanPanelHtml(scan) {
    if (scan.status === "queued" || scan.status === "running") {
      return '<div class="bdc-card"><h3>Reading the board</h3><div class="bdc-empty">' +
        (scan.status === "queued" ? "Queued — the scan starts in a moment." : "Claude is reading the names and researching each company on the web. A full board takes a few minutes; you can leave this page and come back.") +
        "</div></div>";
    }
    if (scan.status === "error") {
      return '<div class="bdc-card"><h3>That scan didn\'t work</h3><div class="bdc-empty">' + esc(scan.error || "Unknown error") + "</div>" +
        '<div class="bdc-item-act"><button class="bdc-btn dngr" onclick="__bdDeleteScan(\'' + scan.id + "')\">Delete scan</button></div></div>";
    }

    var rows = scanRows(scan), a = assumptionsOf(scan);
    var kept = rows.filter(function (r) { return r.include !== false; });
    var emp = kept.reduce(function (n, r) { return n + (r.la_employees || 0); }, 0);
    var low = kept.reduce(function (n, r) { return n + (r.la_employees || 0) * a.sqft_low * a.psf_low; }, 0);
    var high = kept.reduce(function (n, r) { return n + (r.la_employees || 0) * a.sqft_high * a.psf_high; }, 0);
    var outLA = kept.filter(function (r) { return r.flag === "DM Outside LA"; }).length;
    var intl = kept.filter(function (r) { return r.flag === "DM International"; }).length;
    var noDomain = kept.filter(function (r) { return !r.domain; }).length;

    var chips = [
      ["" + kept.length, "tenants selected"],
      [intFmt(emp), "LA employees"],
      [money(low), "annual rent (low)"],
      [money(high), "annual rent (high)"],
      ["" + outLA, "DM outside LA"],
      ["" + intl, "DM international"]
    ].map(function (p) {
      return '<div class="bdc-fchip"><div class="c">' + esc(p[0]) + '</div><div class="l">' + esc(p[1]) + "</div></div>";
    }).join("");

    var summary = '<div class="bdc-card"><h3>' + esc(scan.building_name || scan.address || "Scanned directory") +
      (scan.address && scan.building_name ? ' <span style="text-transform:none;letter-spacing:0;font-weight:400">— ' + esc(scan.address) + "</span>" : "") +
      "</h3><div class=\"bdc-funnel\">" + chips + "</div>" +
      '<div class="bdc-assume" style="margin-top:14px">' +
      '<div><label>SF / employee (low)</label><input id="bdcAsSqL" type="number" min="1" value="' + a.sqft_low + '" /></div>' +
      '<div><label>SF / employee (high)</label><input id="bdcAsSqH" type="number" min="1" value="' + a.sqft_high + '" /></div>' +
      '<div><label>$ / SF / yr (low)</label><input id="bdcAsPsL" type="number" min="1" value="' + a.psf_low + '" /></div>' +
      '<div><label>$ / SF / yr (high)</label><input id="bdcAsPsH" type="number" min="1" value="' + a.psf_high + '" /></div>' +
      '<button class="bdc-btn" onclick="__bdAssumeSave(this)">Apply</button>' +
      "</div></div>";

    var tbl = '<div class="bdc-card">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
      '<h3 style="margin:0">Tenants — ' + rows.length + "</h3>" +
      '<button class="bdc-btn" style="padding:4px 10px;font-size:12px" onclick="__bdScanAll(true)">Tick all</button>' +
      '<button class="bdc-btn" style="padding:4px 10px;font-size:12px" onclick="__bdScanAll(false)">Untick all</button>' +
      '<button class="bdc-btn pri" style="margin-left:auto" onclick="__bdSaveScan(this)">Save changes</button>' +
      "</div>" +
      '<div class="bdc-wrap"><table class="bdc-dtbl"><thead><tr>' +
      "<th></th><th>Company</th><th style=\"text-align:right\">LA staff</th><th style=\"text-align:right\">Est. RSF</th>" +
      "<th style=\"text-align:right\">Est. annual rent</th><th>Decision-makers</th><th>Conf.</th>" +
      "</tr></thead><tbody>" +
      rows.map(function (r, i) { return scanRowHtml(r, i, a); }).join("") +
      "</tbody></table></div>" +
      (noDomain ? '<div class="bdc-note">' + noDomain + " selected " + (noDomain === 1 ? "company has" : "companies have") +
        " no domain. HubSpot dedupes companies on domain — fill those in before importing, or they'll come in as fresh records every time." : "") +
      "</div>";

    var exportCard = '<div class="bdc-card"><h3>Export</h3>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="bdc-btn pri" onclick="__bdExportHS()">⬇ HubSpot companies CSV</button>' +
      '<button class="bdc-btn" onclick="__bdExportFull()">⬇ Full analysis CSV</button>' +
      '<button class="bdc-btn dngr" style="margin-left:auto" onclick="__bdDeleteScan(\'' + scan.id + "')\">Delete scan</button>" +
      "</div>" +
      '<div class="bdc-note">The HubSpot file uses HubSpot\'s own column names, so the importer maps every field on its own — in HubSpot go <em>Data Management → Import → Start an import → Companies</em>, and dedupe on <em>Company Domain Name</em>. Industry is a HubSpot dropdown, so values it doesn\'t recognize get skipped (the text is repeated in the description either way). The full analysis file is the working spreadsheet: rent math, flags, sources, and the notes behind each call.</div>' +
      "</div>";

    var unread = Array.isArray(scan.unreadable) ? scan.unreadable : [];
    var unreadCard = unread.length
      ? '<div class="bdc-card"><h3>Couldn\'t read these</h3><div class="bdc-empty">' +
        unread.map(esc).join("<br>") + "</div>" +
        '<div class="bdc-note">Rather than guess at a blurred name, the scan sets it aside. Re-shoot those lines and run a second scan, or add them by hand in HubSpot.</div></div>'
      : "";

    return summary + tbl + exportCard + unreadCard;
  }

  function renderDirectory(el) {
    var head = viewHead("Directory Scan", "Photograph a lobby tenant board. Claude reads every name, researches the companies, and hands back a list that imports straight into HubSpot.",
      '<button class="bdc-btn" onclick="__bdReloadForce()">⟳ Refresh</button>');
    if (S.scanErr === "signin") { el.innerHTML = head + signinCard(); return; }

    var thumbs = dirPhotos.length
      ? '<div class="bdc-thumbs">' + dirPhotos.map(function (p, i) {
          return '<div class="bdc-thumb"><img src="' + esc(p.url) + '" alt="" /><button onclick="__bdRemovePhoto(' + i + ')" title="Remove">×</button></div>';
        }).join("") + "</div>"
      : "";

    var newCard = '<div class="bdc-card"><h3>New scan</h3><div class="bdc-scanform">' +
      '<input id="bdcScanName" placeholder="Building name — e.g. Water Garden" />' +
      '<input id="bdcScanSub" placeholder="Submarket — e.g. Santa Monica" />' +
      '<input id="bdcScanAddr" class="wide" placeholder="Street address — e.g. 2425 Olympic Blvd, Santa Monica, CA 90404" />' +
      '<input id="bdcScanNote" class="wide" placeholder="Anything the photo can\'t say (optional) — e.g. “lobby board only, floors 2–4 have their own”" />' +
      '<div class="bdc-drop">' +
      '<label class="bdc-btn pri" style="display:inline-block">📷 Add directory photo' +
      '<input type="file" accept="image/*" multiple style="display:none" onchange="__bdAddPhotos(this)" /></label>' +
      '<div class="hint">Up to four photos, 8 MB each. Shoot the board straight-on and close enough to read the smallest suite number — that\'s the whole game.</div>' +
      thumbs + "</div>" +
      '<div class="wide" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="bdc-btn pri" onclick="__bdStartScan(this)"' + (S.scanBusy || !dirPhotos.length ? " disabled" : "") + ">" +
      (S.scanBusy ? "Starting…" : "Scan directory") + "</button>" +
      '<span class="bdc-note" style="margin:0">The research pass takes a few minutes and keeps running if you close the tab.</span>' +
      "</div></div></div>";

    var scans = S.scans;
    if (scans === null) { el.innerHTML = head + newCard + '<div class="bdc-card"><div class="bdc-empty">' + (S.scanErr ? esc(S.scanErr) : "Loading past scans…") + "</div></div>"; return; }

    var chips = scans.length
      ? '<div class="bdc-scanlist">' + scans.map(function (s) {
          var tag = s.status === "done" ? (Array.isArray(s.companies) ? s.companies.length + " tenants" : "done")
            : s.status === "error" ? "failed" : s.status;
          return '<button class="bdc-ichip' + (S.scanId === s.id ? " on" : "") + '" onclick="__bdSelScan(\'' + s.id + "')\">" +
            esc(s.building_name || s.address || "Untitled scan") + '<span class="tag">' + esc(tag) + "</span></button>";
        }).join("") + "</div>"
      : "";

    var scan = scanById(S.scanId);
    var body = scan ? scanPanelHtml(scan)
      : '<div class="bdc-card"><div class="bdc-empty">No scans yet. Photograph a lobby board and run the first one — every tenant it finds is a prospect for the 10-step program.</div></div>';

    el.innerHTML = head + newCard + chips + body +
      '<div class="bdc-note">What the research can and can\'t do: names and suites come straight off the photo, so those are solid. Everything else — headcount, HQ, who signs the lease — is assembled from the open web, because LinkedIn blocks automated access. Treat LA headcount as an estimate and the rent figures as the arithmetic that follows from it; the confidence column tells you where to double-check before you spend a stamp. Nothing is written to HubSpot from here — you review the list, export it, and import it yourself.</div>';
  }

  function render() {
    var el = $("bdView"); if (!el) return;
    if (S.err === "signin" && S.view === "overview") { el.innerHTML = signinCard(); return; }
    if (S.view === "directory") return renderDirectory(el);
    if (S.view === "proposals") return renderProposals(el);
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
