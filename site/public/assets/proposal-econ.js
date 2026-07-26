/* Vantage — proposal economics, formatted once.
 *
 * The "high level business points" of a proposal are shown in three places now:
 * the finalize sheet on the deal page, the building dossier's Proposals section,
 * and (as a one-liner) anywhere a proposal is listed. Those pages are separate
 * documents with no shared bundle, so without this the formatting would be
 * copy-pasted three times and drift — one page would round escalation, another
 * would print "60mo" where the third printed "5 years".
 *
 * Input is the FROZEN snapshot stored in proposals.final_econ (see
 * supabase/proposal-finalize.sql), which mirrors the proposal_rounds columns:
 *   round_no, from_party, rent_basis, rent_basis_label, base_rent_psf,
 *   opex_psf, size_sf, term_months, annual_escalation_pct, free_rent_months,
 *   ti_psf, summary
 * Every field is optional — a proposal can be finalized with partial terms, and
 * a missing value is simply omitted rather than rendered as "$0.00" or "—".
 */
(function (global) {
  "use strict";

  function num(v) { return v == null || v === "" || isNaN(Number(v)) ? null : Number(v); }
  function money(v) { var n = num(v); return n == null ? null : "$" + n.toFixed(2); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // "FSG", or the broker's custom wording when the basis is OTHER.
  function basisLabel(e) {
    if (!e) return null;
    if (e.rent_basis === "OTHER" && e.rent_basis_label) return e.rent_basis_label;
    return e.rent_basis || null;
  }

  // base + opex. Null unless base is known — opex alone is not a gross rent.
  function grossEquiv(e) {
    var b = num(e && e.base_rent_psf);
    if (b == null) return null;
    return b + (num(e && e.opex_psf) || 0);
  }

  function term(e) {
    var m = num(e && e.term_months);
    if (m == null) return null;
    if (m % 12 === 0) return (m / 12) + (m === 12 ? " year" : " years");
    return m + " mo";
  }

  // The ordered business points. Each entry is {k, v}; callers decide the markup.
  function points(e) {
    e = e || {};
    var out = [];
    function add(k, v) { if (v != null && v !== "") out.push({ k: k, v: String(v) }); }
    add("Structure", basisLabel(e));
    add("Base", money(e.base_rent_psf) ? money(e.base_rent_psf) + "/SF" : null);
    add("Opex", money(e.opex_psf) ? money(e.opex_psf) + "/SF" : null);
    // Only worth a chip when there is an opex load to add — with no opex the
    // gross equivalent is just the base rent again, and two identical dollar
    // figures side by side reads like a bug.
    if (num(e.opex_psf)) add("≈ Gross", money(grossEquiv(e)) + "/SF");
    add("Size", num(e.size_sf) == null ? null : Number(e.size_sf).toLocaleString() + " SF");
    add("Term", term(e));
    add("Escalation", num(e.annual_escalation_pct) == null ? null : num(e.annual_escalation_pct) + "%");
    add("Free rent", num(e.free_rent_months) == null ? null : num(e.free_rent_months) + " mo");
    add("TI", money(e.ti_psf) ? money(e.ti_psf) + "/SF" : null);
    return out;
  }

  // Chip row for a card. Returns "" when nothing is known, so the caller can
  // decide whether to render an empty state.
  function chipsHtml(e) {
    return points(e).map(function (p) {
      return '<span class="pe-chip"><i>' + esc(p.k) + "</i>" + esc(p.v) + "</span>";
    }).join("");
  }

  // Single-line fallback: "FSG · $3.25/SF · 6,000 SF · 5 years"
  function summaryLine(e) {
    return points(e).map(function (p) { return p.v; }).join(" · ");
  }

  // The module carries its own styling. deals.html keeps its CSS inline and
  // building.html uses vantage.css, so a shared class would have to be added to
  // both (and vantage.css is edited by other sessions). Injecting once here
  // means the chips look identical on every page that loads this file, with no
  // stylesheet coordination. Uses the vantage.css custom properties where they
  // exist and falls back to literals on any page that doesn't define them.
  var STYLE_ID = "pe-style";
  function injectStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      ".pe-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}" +
      ".pe-chip{font:500 11.5px Inter,system-ui,sans-serif;color:var(--ink,#1A2230);" +
      "background:var(--paper,#fff);border:1px solid var(--line,#e5e2db);" +
      "border-radius:7px;padding:3px 8px;white-space:nowrap}" +
      ".pe-chip i{font-style:normal;font-weight:600;font-size:9.5px;text-transform:uppercase;" +
      "letter-spacing:.06em;color:var(--ink-faint,#8a8578);margin-right:5px}";
    (document.head || document.documentElement).appendChild(s);
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectStyle);
    else injectStyle();
  }

  global.ProposalEcon = {
    points: points,
    chipsHtml: chipsHtml,
    summaryLine: summaryLine,
    basisLabel: basisLabel,
    grossEquiv: grossEquiv
  };
})(typeof window !== "undefined" ? window : this);
