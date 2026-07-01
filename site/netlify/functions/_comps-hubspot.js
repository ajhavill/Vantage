// Vantage — shared HubSpot ↔ Comps glue (bundled into the bootstrap + webhook fns).
//
// Holds three things so the two comps-HubSpot functions stay thin:
//   1. DEAL_GROUP / DEAL_PROPS — the custom deal properties that capture the lease
//      economics a comp needs (created idempotently by comps-hubspot-bootstrap.js).
//   2. dealToComp() — a PURE mapper from a HubSpot deal record to a Vantage comp
//      object (the shape comps-math / the comps table expect). Unit-tested.
//   3. verifyHubSpotV3() — validates the X-HubSpot-Signature-v3 header so only
//      genuine HubSpot webhooks are processed.
//
// Files prefixed with "_" are NOT deployed as their own functions by Netlify.

const crypto = require("crypto");

// Property group + fields to guarantee on the Deal object. The broker fills these
// on the deal at close; the webhook reads them into a comp. Named vantage_* so they
// never collide with native or other-app deal properties.
const DEAL_GROUP = { name: "vantage_comp", label: "Vantage Comp", displayOrder: -1 };

const DEAL_PROPS = [
  { name: "vantage_building_address", label: "Building Address (comp)", type: "string", fieldType: "text" },
  { name: "vantage_suite",            label: "Suite (comp)",            type: "string", fieldType: "text" },
  { name: "vantage_rsf",              label: "RSF (comp)",              type: "number", fieldType: "number" },
  { name: "vantage_execution_date",   label: "Execution Date (comp)",   type: "date",   fieldType: "date" },
  { name: "vantage_term_months",      label: "Term Months (comp)",      type: "number", fieldType: "number" },
  { name: "vantage_face_rate",        label: "Face Rate $/SF/yr (comp)", type: "number", fieldType: "number" },
  { name: "vantage_escalation_pct",   label: "Escalation %/yr (comp)",  type: "number", fieldType: "number" },
  { name: "vantage_free_rent_months", label: "Free Rent Months (comp)", type: "number", fieldType: "number" },
  { name: "vantage_ti_psf",           label: "TI Allowance $/SF (comp)", type: "number", fieldType: "number" },
  { name: "vantage_opex_psf",         label: "Operating Exp $/SF (comp)", type: "number", fieldType: "number" },
  { name: "vantage_discount_rate",    label: "NER Discount % (comp)",   type: "number", fieldType: "number" },
  { name: "vantage_expense_structure", label: "Expense Structure (comp)", type: "enumeration", fieldType: "select",
    options: [ { label: "FSG", value: "FSG", displayOrder: 0 }, { label: "NNN", value: "NNN", displayOrder: 1 }, { label: "MG", value: "MG", displayOrder: 2 } ] },
  { name: "vantage_product_type",     label: "Product Type (comp)",     type: "enumeration", fieldType: "select",
    options: ["retail", "office", "industrial", "flex", "lab"].map((v, i) => ({ label: v.charAt(0).toUpperCase() + v.slice(1), value: v, displayOrder: i })) }
];

// All property names we ask HubSpot to return when we fetch a deal for a comp.
const DEAL_READ_PROPS = DEAL_PROPS.map(p => p.name).concat([
  "dealname", "closedate", "dealstage", "hs_is_closed_won", "deal_currency_code", "amount"
]);

function num(v) { const x = typeof v === "number" ? v : parseFloat(v); return isFinite(x) ? x : null; }

// HubSpot dates arrive as either epoch-ms strings (datetime props like closedate)
// or ISO 'YYYY-MM-DD' (date props). Normalize to 'YYYY-MM-DD' or null.
function parseHsDate(v) {
  if (v == null || v === "") return null;
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString().slice(0, 10); // epoch ms
  if (/^\d{10}$/.test(String(v))) return new Date(Number(v) * 1000).toISOString().slice(0, 10); // epoch s
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// PURE: HubSpot deal record → Vantage comp object (pre-metrics; the caller runs
// it through comps-math). `extra.tenantName` is the associated company name.
function dealToComp(deal, extra) {
  deal = deal || {};
  const p = deal.properties || {};
  extra = extra || {};
  const esc = num(p.vantage_escalation_pct);
  const structure = ["FSG", "NNN", "MG"].includes(p.vantage_expense_structure) ? p.vantage_expense_structure : null;
  const product = ["retail", "office", "industrial", "flex", "lab"].includes(String(p.vantage_product_type || "").toLowerCase())
    ? String(p.vantage_product_type).toLowerCase() : null;

  return {
    source: "hubspot",
    external_source: "hubspot",
    external_id: deal.id != null ? String(deal.id) : null,
    building_id: extra.buildingId || null,
    building_name: extra.buildingName || null,
    address: p.vantage_building_address || null,
    product_type: product,
    tenant: extra.tenantName || p.dealname || null,
    suite: p.vantage_suite || null,
    rsf: num(p.vantage_rsf),
    execution_date: parseHsDate(p.vantage_execution_date) || parseHsDate(p.closedate),
    term_months: num(p.vantage_term_months),
    face_rate: num(p.vantage_face_rate),
    escalation: esc != null ? { type: "percent", value: esc } : { type: "none" },
    free_rent_months: num(p.vantage_free_rent_months),
    ti_allowance_psf: num(p.vantage_ti_psf),
    expense_structure: structure,
    opex_psf: num(p.vantage_opex_psf),
    discount_rate: num(p.vantage_discount_rate),
    parking: {},
    options: {},
    redaction: {},
    notes: "Auto-synced from HubSpot deal " + (deal.id || "") + (p.dealname ? (" — " + p.dealname) : "")
  };
}

// True when a deal carries enough to compute a real net-effective comp. When
// false the webhook still creates a DRAFT comp (whatever's present) to be finished.
function isCompComplete(comp) {
  return !!(comp && num(comp.rsf) && num(comp.term_months) && comp.face_rate != null);
}

// Validate HubSpot's v3 request signature. sig = base64( HMAC-SHA256( secret,
// method + fullUri + rawBody + timestamp ) ). Rejects stale (>5 min) requests.
function verifyHubSpotV3(secret, method, fullUri, rawBody, signature, timestamp) {
  if (!secret || !signature || !timestamp) return false;
  const skewMs = Math.abs(Date.now() - Number(timestamp));
  if (!isFinite(skewMs) || skewMs > 5 * 60 * 1000) return false;
  const base = String(method).toUpperCase() + fullUri + (rawBody || "") + String(timestamp);
  const digest = crypto.createHmac("sha256", secret).update(base, "utf8").digest("base64");
  const a = Buffer.from(digest), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  DEAL_GROUP, DEAL_PROPS, DEAL_READ_PROPS,
  dealToComp, isCompComplete, parseHsDate, verifyHubSpotV3
};
