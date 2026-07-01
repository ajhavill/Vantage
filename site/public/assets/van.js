// Van — Havill & Co.'s AI tenant-rep specialist, as a self-contained, site-wide widget.
//
// Drop `<script src="assets/van.js"></script>` on any authenticated Vantage page and
// Van appears as a floating launcher + slide-out panel. It finds the page's Supabase
// session (window.vantageSB, or its own client), and talks to the deal-ai-assist
// Netlify function. Pages can make Van deal-aware by calling:
//     Van.setContext({ dealId: '<uuid>', label: 'Acme Corp' });
// With no context it advises across the broker's pipeline. Owns its own DOM + CSS
// (prefixed `van-`), so it never collides with the host page. Session B owns this file.
(function () {
  "use strict";
  var URL = "https://siaoqjvvxuckyxpxftwt.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpYW9xanZ2eHVja3l4cHhmdHd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2OTU5MTMsImV4cCI6MjA5ODI3MTkxM30.HgWjVlB9e0rYgX-MCTee16UV5tZ6m-pCXXjwY1cu3b0";
  var ENDPOINT = "/.netlify/functions/deal-ai-assist";

  var SB = null, history = [], busy = false, chips = [], ctx = { dealId: null, label: "your pipeline" }, started = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // tiny markdown -> html (used if the page didn't load marked)
  function mdMini(src) {
    var lines = String(src).split(/\r?\n/), html = "", list = null;
    function inl(s) {
      s = esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    }
    function closeL() { if (list) { html += "</" + list + ">"; list = null; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], h = ln.match(/^(#{1,3})\s+(.*)$/), ul = ln.match(/^\s*[-*]\s+(.*)$/), ol = ln.match(/^\s*\d+\.\s+(.*)$/);
      if (h) { closeL(); html += "<h3>" + inl(h[2]) + "</h3>"; }
      else if (ul) { if (list !== "ul") { closeL(); list = "ul"; html += "<ul>"; } html += "<li>" + inl(ul[1]) + "</li>"; }
      else if (ol) { if (list !== "ol") { closeL(); list = "ol"; html += "<ol>"; } html += "<li>" + inl(ol[1]) + "</li>"; }
      else if (ln.trim() === "") { closeL(); }
      else { closeL(); html += "<p>" + inl(ln) + "</p>"; }
    }
    closeL(); return html;
  }
  function render(t) { return (window.marked && window.marked.parse) ? window.marked.parse(t) : mdMini(t); }

  function getSB() {
    if (window.vantageSB) return window.vantageSB;
    if (!SB && window.supabase) { SB = window.supabase.createClient(URL, ANON); window.vantageSB = SB; }
    return SB;
  }

  function injectCSS() {
    var css =
      ".van-fab{position:fixed;right:22px;bottom:22px;z-index:2300;font:700 13px Inter,system-ui,sans-serif;color:#fff;background:var(--building,#1b2a4a);border:0;border-radius:999px;padding:12px 18px;cursor:pointer;box-shadow:0 10px 30px rgba(20,26,38,.22);display:none;align-items:center;gap:7px}" +
      ".van-fab:hover{filter:brightness(1.1)}" +
      ".van-panel{position:fixed;top:0;right:0;height:100vh;width:min(420px,100%);background:var(--paper-2,#fbf9f4);border-left:1px solid var(--line,#e7e3d9);box-shadow:-8px 0 30px rgba(20,26,38,.16);z-index:2400;display:flex;flex-direction:column;transform:translateX(102%);transition:transform .22s ease}" +
      ".van-panel.open{transform:translateX(0)}" +
      ".van-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 18px;border-bottom:1px solid var(--line,#e7e3d9)}" +
      ".van-title{font:800 17px 'Bricolage Grotesque',Inter,system-ui,sans-serif;color:var(--ink,#1a2230);line-height:1.1}" +
      ".van-tag{font:500 10.5px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);margin-top:1px}" +
      ".van-ctx{font:600 11px Inter,system-ui,sans-serif;color:var(--accent,#2d6e7e);margin-top:3px}" +
      ".van-hb{display:flex;gap:12px;align-items:center}" +
      ".van-clear{font:600 11px Inter,system-ui,sans-serif;color:var(--ink-faint,#8a92a0);background:none;border:0;cursor:pointer}" +
      ".van-clear:hover{color:var(--ink-soft,#55606f)}" +
      ".van-x{font-size:15px;background:none;border:0;color:var(--ink-faint,#8a92a0);cursor:pointer;line-height:1}" +
      ".van-x:hover{color:var(--ink,#1a2230)}" +
      ".van-quick{display:flex;flex-wrap:wrap;gap:7px;padding:12px 16px;border-bottom:1px solid var(--line,#e7e3d9)}" +
      ".van-chip{font:600 11.5px Inter,system-ui,sans-serif;color:var(--ink-soft,#55606f);background:var(--paper,#f3efe6);border:1px solid var(--line-2,#d8d3c7);border-radius:999px;padding:6px 11px;cursor:pointer;text-align:left}" +
      ".van-chip:hover{border-color:var(--accent,#2d6e7e);color:var(--accent,#2d6e7e)}" +
      ".van-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px}" +
      ".van-msg{font:400 13.5px Inter,system-ui,sans-serif;line-height:1.5;border-radius:13px;padding:10px 13px;max-width:90%;word-wrap:break-word}" +
      ".van-msg.user{align-self:flex-end;background:var(--building,#1b2a4a);color:#fff;border-bottom-right-radius:4px}" +
      ".van-msg.assistant{align-self:flex-start;background:var(--paper,#f3efe6);border:1px solid var(--line,#e7e3d9);color:var(--ink,#1a2230);border-bottom-left-radius:4px}" +
      ".van-msg.assistant p{margin:0 0 8px}.van-msg.assistant p:last-child{margin:0}" +
      ".van-msg.assistant ul,.van-msg.assistant ol{margin:6px 0;padding-left:18px}.van-msg.assistant li{margin:3px 0}" +
      ".van-msg.assistant h3{font-family:'Bricolage Grotesque',Inter,sans-serif;font-size:14px;margin:8px 0 4px}" +
      ".van-msg.assistant code{font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--paper-2,#fbf9f4);padding:1px 4px;border-radius:4px}" +
      ".van-input{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--line,#e7e3d9);align-items:flex-end}" +
      ".van-input textarea{flex:1;resize:none;font:400 13.5px Inter,system-ui,sans-serif;padding:10px 12px;border:1px solid var(--line-2,#d8d3c7);border-radius:10px;background:var(--paper,#fff);color:var(--ink,#1a2230);max-height:120px;overflow-y:auto}" +
      ".van-input textarea:focus{outline:none;border-color:var(--accent,#2d6e7e)}" +
      ".van-input button{font-size:15px;color:#fff;background:var(--building,#1b2a4a);border:0;border-radius:10px;padding:0 15px;height:40px;cursor:pointer;flex:none}" +
      ".van-input button:disabled{opacity:.5;cursor:default}" +
      ".van-dots i{display:inline-block;width:6px;height:6px;margin-right:3px;border-radius:999px;background:var(--ink-faint,#8a92a0);animation:vanblink 1s infinite}" +
      ".van-dots i:nth-child(2){animation-delay:.2s}.van-dots i:nth-child(3){animation-delay:.4s}" +
      "@keyframes vanblink{0%,60%,100%{opacity:.25}30%{opacity:1}}" +
      ".van-acts{display:flex;flex-direction:column;gap:8px;align-self:flex-start;max-width:90%}" +
      ".van-act{border:1px solid var(--line-2,#d8d3c7);background:var(--paper,#f3efe6);border-radius:11px;padding:10px 12px}" +
      ".van-act-l{font:600 12.5px Inter,system-ui,sans-serif;color:var(--ink,#1a2230);line-height:1.4}" +
      ".van-act-b{display:flex;gap:8px;justify-content:flex-end;margin-top:9px}" +
      ".van-act-b button{font:600 11.5px Inter,system-ui,sans-serif;border-radius:7px;padding:6px 13px;cursor:pointer;border:1px solid var(--line-2,#d8d3c7)}" +
      ".van-act-no{background:none;color:var(--ink-faint,#8a92a0)}" +
      ".van-act-no:hover{color:var(--ink-soft,#55606f)}" +
      ".van-act-yes{background:var(--building,#1b2a4a);color:#fff;border-color:var(--building,#1b2a4a)}" +
      ".van-act-yes:hover{filter:brightness(1.1)}" +
      ".van-act.done{border-color:#bfe3cd;background:rgba(46,140,90,.09)}.van-act.done .van-act-l{color:#2e7d4f}" +
      ".van-act.err{border-color:#e6c3bd;background:rgba(201,84,63,.08)}" +
      ".van-act.dismissed{opacity:.55}" +
      "@media(max-width:520px){.van-panel{width:100%}.van-fab{right:16px;bottom:16px}}";
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  function injectDOM() {
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<button class="van-fab" id="vanFab" title="Van — your AI tenant-rep specialist">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9L12 2z"/></svg> Ask Van</button>' +
      '<div class="van-panel" id="vanPanel">' +
      '<div class="van-head"><div><div class="van-title">Van</div><div class="van-tag">Your AI tenant-rep specialist</div><div class="van-ctx" id="vanCtx">Your pipeline</div></div>' +
      '<div class="van-hb"><button class="van-clear" id="vanClear">Clear</button><button class="van-x" id="vanXbtn" aria-label="Close">✕</button></div></div>' +
      '<div class="van-quick" id="vanQuick"></div>' +
      '<div class="van-msgs" id="vanMsgs"></div>' +
      '<div class="van-input"><textarea id="vanText" rows="1" placeholder="Ask Van…"></textarea><button id="vanSend" title="Send">➤</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    $("vanFab").addEventListener("click", toggle);
    $("vanXbtn").addEventListener("click", close);
    $("vanClear").addEventListener("click", clearChat);
    $("vanSend").addEventListener("click", function () { send(); });
    var ta = $("vanText");
    ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    ta.addEventListener("input", function () { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 120) + "px"; });
  }

  function updateHeader() {
    var c = $("vanCtx"); if (c) c.textContent = ctx.dealId ? ("Deal · " + ctx.label) : (ctx.label || "Your pipeline");
    var ta = $("vanText"); if (ta) ta.placeholder = ctx.dealId ? ("Ask Van about " + ctx.label + "…") : "Ask Van about your pipeline…";
    chips = ctx.dealId
      ? [["Summarize this deal", "Give me a 3-sentence summary of where this deal stands and what matters most right now."],
         ["Next step & risks", "What are my top 3 next steps on this deal, and what risks should I be watching? Be specific."],
         ["Email client an update", "Draft a short, friendly status-update email to my client on this deal."],
         ["Reply to the landlord", "Draft a professional email to the landlord or listing broker that advances the current negotiation."],
         ["Compare the proposals", "Compare the options/proposals on this deal in plain English and tell me which is the stronger economic deal and why."]]
      : [["Focus for today", "Look across my pipeline and tell me the 3 most important things to focus on today, and why."],
         ["Which deals are at risk?", "Which of my deals look stalled or at risk, and what should I do about each?"],
         ["Plan my day", "Draft a short, prioritized to-do list for my day based on my pipeline and open tasks."]];
    var q = $("vanQuick"); if (q) q.innerHTML = chips.map(function (c, i) { return '<button class="van-chip" data-i="' + i + '">' + esc(c[0]) + "</button>"; }).join("");
    if (q) [].forEach.call(q.children, function (b) { b.addEventListener("click", function () { var c = chips[+b.getAttribute("data-i")]; if (c) send(c[1]); }); });
  }

  function push(role, html, isRaw) {
    var m = $("vanMsgs"); if (!m) return null;
    var div = document.createElement("div"); div.className = "van-msg " + role;
    div.innerHTML = (role === "assistant" && !isRaw) ? render(html) : (role === "user" ? esc(html) : html);
    m.appendChild(div); m.scrollTop = m.scrollHeight; return div;
  }
  function greet() { push("assistant", "Hi, I'm **Van** — your tenant-rep specialist. Ask me anything about " + (ctx.dealId ? ("**" + ctx.label + "**") : "your pipeline") + ", or tap a suggestion. I can summarize, draft emails, compare proposals, flag what needs attention" + (ctx.dealId ? ", and take actions (add tasks, check off steps, log rounds — you confirm each one)" : "") + "."); }

  function renderActions(actions) {
    var m = $("vanMsgs"); if (!m) return;
    var wrap = document.createElement("div"); wrap.className = "van-acts";
    actions.forEach(function (a) {
      var card = document.createElement("div"); card.className = "van-act";
      card.innerHTML = '<div class="van-act-l">' + esc(a.label || a.type) + '</div>' +
        '<div class="van-act-b"><button class="van-act-no">Dismiss</button><button class="van-act-yes">Confirm</button></div>';
      card.querySelector(".van-act-no").addEventListener("click", function () { card.className = "van-act dismissed"; card.innerHTML = '<div class="van-act-l">Dismissed</div>'; });
      card.querySelector(".van-act-yes").addEventListener("click", function () { doAction(a, card); });
      wrap.appendChild(card);
    });
    m.appendChild(wrap); m.scrollTop = m.scrollHeight;
  }
  async function doAction(a, card) {
    card.innerHTML = '<div class="van-act-l">Working…</div>';
    try {
      var client = getSB(); var s = client ? await client.auth.getSession() : null;
      var token = s && s.data && s.data.session ? s.data.session.access_token : null;
      var res = await fetch("/.netlify/functions/deal-ai-act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, dealId: ctx.dealId || null, action: a }) });
      var data = await res.json().catch(function () { return null; });
      if (!data || data.error) { card.className = "van-act err"; card.innerHTML = '<div class="van-act-l">⚠️ ' + esc((data && data.error) || "Couldn't do that.") + '</div>'; }
      else { card.className = "van-act done"; card.innerHTML = '<div class="van-act-l">✓ ' + esc(data.message || "Done.") + '</div>'; try { window.dispatchEvent(new CustomEvent("van:acted", { detail: { dealId: ctx.dealId } })); } catch (e) {} }
    } catch (e) { card.className = "van-act err"; card.innerHTML = '<div class="van-act-l">⚠️ ' + esc((e && e.message) || "Failed.") + '</div>'; }
    var mm = $("vanMsgs"); if (mm) mm.scrollTop = mm.scrollHeight;
  }
  function clearChat() { history = []; var m = $("vanMsgs"); if (m) m.innerHTML = ""; greet(); }

  async function send(preset) {
    if (busy) return;
    var ta = $("vanText"), text = (preset != null ? preset : (ta ? ta.value : "")).trim();
    if (!text) return;
    if (ta && preset == null) { ta.value = ""; ta.style.height = "auto"; }
    push("user", text); history.push({ role: "user", content: text });
    busy = true; var sb = $("vanSend"); if (sb) sb.disabled = true;
    var thinking = push("assistant", '<span class="van-dots"><i></i><i></i><i></i></span>', true);
    try {
      var client = getSB(); var s = client ? await client.auth.getSession() : null;
      var token = s && s.data && s.data.session ? s.data.session.access_token : null;
      var ctrl = new AbortController(); var to = setTimeout(function () { ctrl.abort(); }, 45000);
      var res = await fetch(ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, dealId: ctx.dealId || null, question: text, history: history.slice(0, -1).slice(-6) }),
        signal: ctrl.signal
      });
      clearTimeout(to);
      var data = await res.json().catch(function () { return null; });
      if (thinking) thinking.remove();
      if (!data || data.error) { push("assistant", "⚠️ " + esc((data && data.error) || "Something went wrong. Please try again."), true); }
      else { push("assistant", data.text || "(no response)"); history.push({ role: "assistant", content: data.text || "" }); if (Array.isArray(data.actions) && data.actions.length) renderActions(data.actions); }
    } catch (e) {
      if (thinking) thinking.remove();
      push("assistant", (e && e.name === "AbortError") ? "⚠️ That took too long — try a shorter question." : "⚠️ " + esc((e && e.message) || "Network error."), true);
    }
    busy = false; if (sb) sb.disabled = false;
    var mm = $("vanMsgs"); if (mm) mm.scrollTop = mm.scrollHeight;
  }

  function open() { var p = $("vanPanel"); if (!p) return; p.classList.add("open"); var f = $("vanFab"); if (f) f.style.display = "none"; updateHeader(); if (!$("vanMsgs").children.length) greet(); setTimeout(function () { var t = $("vanText"); if (t) t.focus(); }, 60); }
  function close() { var p = $("vanPanel"); if (p) p.classList.remove("open"); var f = $("vanFab"); if (f && loggedIn) f.style.display = ""; }
  function toggle() { var p = $("vanPanel"); if (!p) return; p.classList.contains("open") ? close() : open(); }
  function setContext(c) { ctx = { dealId: (c && c.dealId) || null, label: (c && c.label) || "your pipeline" }; if ($("vanPanel") && $("vanPanel").classList.contains("open")) updateHeader(); }

  var loggedIn = false;
  function showFab(v) { loggedIn = v; var f = $("vanFab"); if (f && !$("vanPanel").classList.contains("open")) f.style.display = v ? "" : "none"; if (!v) close(); }
  function watchAuth() {
    var client = getSB(); if (!client) return;
    client.auth.getSession().then(function (r) { showFab(!!(r && r.data && r.data.session)); }).catch(function () {});
    try { client.auth.onAuthStateChange(function (_e, session) { showFab(!!session); }); } catch (e) {}
  }

  function init() { if (started) return; started = true; injectCSS(); injectDOM(); watchAuth(); }
  window.Van = { init: init, toggle: toggle, open: open, close: close, setContext: setContext, clear: clearChat };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
