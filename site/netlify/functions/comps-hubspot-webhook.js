// Vantage — comps-hubspot-webhook (Netlify Function).
//
// HubSpot calls this the moment a deal changes. When a deal is Closed Won AND has
// an associated invoice, we read its Vantage-comp properties, map it to a comp,
// normalize it (same comps-math engine as everywhere else), and UPSERT it into the
// comps table for the firm — deduped on the HubSpot deal id, so re-fires update in
// place. Deals missing lease economics still land as a DRAFT comp to be finished.
//
// Security: the X-HubSpot-Signature-v3 header is verified against the app's client
// secret (HUBSPOT_APP_CLIENT_SECRET). Without that secret set, requests are
// processed but flagged insecure in the response/logs so you can lock it down.
//
// Env: HUBSPOT_PRIVATE_APP_TOKEN (deal+company+invoice read), HUBSPOT_APP_CLIENT_SECRET
//      (webhook signature), VANTAGE_HUBSPOT_ORG_ID (which firm; optional if only one
//      org exists), HUBSPOT_REQUIRE_INVOICE ('false' to comp on close alone).

const { configured, rest } = require("./_sb");
const { hs, configured: hsConfigured } = require("./_hubspot");
const { DEAL_READ_PROPS, dealToComp, isCompComplete, verifyHubSpotV3 } = require("./_comps-hubspot");
const CompsMath = require("../../public/assets/comps-math.js");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || "";
}

// Which firm do CRM-synced comps belong to? Explicit env var wins; otherwise, if the
// instance has exactly one org (Havill-only today), use it.
async function targetOrg() {
  if (process.env.VANTAGE_HUBSPOT_ORG_ID) return process.env.VANTAGE_HUBSPOT_ORG_ID;
  const r = await rest("orgs?select=id&limit=2");
  if (r.ok && Array.isArray(r.data) && r.data.length === 1) return r.data[0].id;
  return null;
}

// Deal ids referenced by this webhook batch (HubSpot posts an array of events).
function dealIdsFromBody(parsed) {
  const events = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const ids = new Set();
  for (const e of events) {
    const st = String(e.subscriptionType || "");
    if (st.indexOf("deal") === 0 && e.objectId != null) ids.add(String(e.objectId));
  }
  return Array.from(ids);
}

async function fetchDeal(id) {
  const qs = "?properties=" + encodeURIComponent(DEAL_READ_PROPS.join(",")) + "&associations=companies,invoices";
  const r = await hs("/crm/v3/objects/deals/" + encodeURIComponent(id) + qs);
  return r.ok ? r.data : null;
}

async function companyName(deal) {
  const assoc = deal.associations && deal.associations.companies && deal.associations.companies.results;
  const cid = assoc && assoc[0] && assoc[0].id;
  if (!cid) return null;
  const r = await hs("/crm/v3/objects/companies/" + encodeURIComponent(cid) + "?properties=name");
  return (r.ok && r.data && r.data.properties && r.data.properties.name) || null;
}

function hasInvoice(deal) {
  const inv = deal.associations && deal.associations.invoices && deal.associations.invoices.results;
  return !!(inv && inv.length);
}

async function upsertComp(orgId, comp) {
  const sel = "comps?org_id=eq." + encodeURIComponent(orgId) +
    "&external_source=eq.hubspot&external_id=eq." + encodeURIComponent(comp.external_id) + "&select=id&limit=1";
  const found = await rest(sel);
  const existing = found.ok && Array.isArray(found.data) && found.data[0];
  if (existing) {
    const up = await rest("comps?id=eq." + encodeURIComponent(existing.id) + "&org_id=eq." + encodeURIComponent(orgId), {
      method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(comp)
    });
    return { ok: up.ok, action: "updated", error: up.ok ? null : (up.text || up.status) };
  }
  const ins = await rest("comps", {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(Object.assign({ org_id: orgId }, comp))
  });
  return { ok: ins.ok, action: "created", error: ins.ok ? null : (ins.text || ins.status) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });
  if (!hsConfigured()) return json(500, { error: "HUBSPOT_PRIVATE_APP_TOKEN is not set." });

  const raw = event.body || "";

  // --- signature ---
  const secret = process.env.HUBSPOT_APP_CLIENT_SECRET;
  let secure = false;
  if (secret) {
    const sig = header(event, "X-HubSpot-Signature-v3");
    const ts = header(event, "X-HubSpot-Request-Timestamp");
    const uri = event.rawUrl || ("https://" + header(event, "host") + (event.path || "/.netlify/functions/comps-hubspot-webhook"));
    if (!verifyHubSpotV3(secret, event.httpMethod, uri, raw, sig, ts)) {
      return json(401, { error: "Bad HubSpot signature." });
    }
    secure = true;
  }

  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch (e) { return json(400, { error: "Malformed body." }); }

  const orgId = await targetOrg();
  if (!orgId) return json(500, { error: "Set VANTAGE_HUBSPOT_ORG_ID — could not resolve which firm these comps belong to." });

  const requireInvoice = process.env.HUBSPOT_REQUIRE_INVOICE !== "false";
  const dealIds = dealIdsFromBody(parsed);
  const results = [];

  for (const id of dealIds) {
    try {
      const deal = await fetchDeal(id);
      if (!deal) { results.push({ id, skipped: "deal not found" }); continue; }
      const props = deal.properties || {};
      if (String(props.hs_is_closed_won) !== "true") { results.push({ id, skipped: "not closed won" }); continue; }
      const invoiced = hasInvoice(deal);
      if (requireInvoice && !invoiced) { results.push({ id, skipped: "closed but not invoiced yet" }); continue; }

      const tenantName = await companyName(deal);
      const comp = dealToComp(deal, { tenantName: tenantName });
      const m = CompsMath.computeMetrics({
        rsf: comp.rsf, term_months: comp.term_months, face_rate: comp.face_rate, escalation: comp.escalation,
        free_rent_months: comp.free_rent_months, ti_allowance_psf: comp.ti_allowance_psf, opex_psf: comp.opex_psf,
        parking_ratio: null, parking_rate: null, discount_rate: comp.discount_rate
      });
      comp.net_effective_rent_psf = m.net_effective_rent_psf;
      comp.face_rate_psf = m.face_rate_psf;
      comp.total_occupancy_cost_psf = m.total_occupancy_cost_psf;
      const draft = !isCompComplete(comp);
      if (draft) comp.notes = "[DRAFT — complete economics] " + comp.notes;

      const r = await upsertComp(orgId, comp);
      results.push({ id, action: r.action, draft: draft, invoiced: invoiced, ok: r.ok, error: r.error });
    } catch (e) {
      results.push({ id, error: (e && e.message) || "failed" });
    }
  }

  // Always 200 so HubSpot doesn't retry-storm on a single bad deal; details in body/logs.
  return json(200, { ok: true, secure: secure, processed: results.length, results: results });
};
