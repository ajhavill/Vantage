// Vantage — deal-client-list (Netlify Function).
//
// The Deals-side half of the Clients hub's "Proposals & leases" section. Given a
// HubSpot company id, returns that client's deals (in this org) mapped to the row
// shape the Clients hub renders. Read-only; broker-authed; org-scoped.
//
// Contract (matches HANDOFF-deals-to-clients.md and what the hub already calls):
//   POST { token, hsCompanyId } -> { deals: [{id,name,kind,stage,building,url}] }

const { configured, rest, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const STAGE_LABEL = {
  needs: "Needs", touring: "Touring", evaluating: "Evaluating",
  proposals: "Proposals out", negotiation: "In negotiation", executed: "Executed", dead: "Dead"
};

// A deal's stage decides how it reads in the client hub.
function stageKind(stage) {
  if (stage === "executed") return "lease";
  if (stage === "proposals" || stage === "negotiation") return "proposal";
  return "deal";
}

// PURE: deal row (+ optional building name) -> Clients-hub row. Unit-tested.
function dealToRow(deal, building) {
  const kind = stageKind(deal.stage);
  const fallbackName = kind === "lease" ? "Executed lease" : (kind === "proposal" ? "Proposal" : "Deal");
  return {
    id: deal.id,
    name: building || fallbackName,
    kind: kind,
    stage: STAGE_LABEL[deal.stage] || deal.stage || null,
    building: building || null,
    url: "deals.html?d=" + deal.id
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const hsId = String(body.hsCompanyId || "").trim();
  if (!hsId) return json(400, { error: "hsCompanyId is required." });

  // Org scope from the broker's profile; also match owner_id so deals created
  // before org stamping still resolve. (service_role bypasses RLS.)
  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id&limit=1");
  const orgId = prof.ok && Array.isArray(prof.data) && prof.data[0] && prof.data[0].org_id;

  const scope = orgId
    ? "&or=(org_id.eq." + encodeURIComponent(orgId) + ",owner_id.eq." + encodeURIComponent(user.id) + ")"
    : "&owner_id=eq." + encodeURIComponent(user.id);
  const sel = "deals?hs_company_id=eq." + encodeURIComponent(hsId) + scope +
    "&select=id,client_name,stage,updated_at&order=updated_at.desc&limit=200";
  const r = await rest(sel);
  if (!r.ok) return json(500, { error: "Lookup failed: " + (r.text || r.status) });
  const deals = Array.isArray(r.data) ? r.data : [];
  if (!deals.length) return json(200, { deals: [] });

  // Enrich with the first building on each deal (best-effort).
  const buildingByDeal = {};
  try {
    const ids = deals.map(d => d.id).join(",");
    const pr = await rest("deal_properties?deal_id=in.(" + ids + ")&select=deal_id,name,address");
    if (pr.ok && Array.isArray(pr.data)) {
      for (const p of pr.data) {
        if (!buildingByDeal[p.deal_id]) buildingByDeal[p.deal_id] = p.name || p.address || null;
      }
    }
  } catch (e) { /* buildings are optional */ }

  const rows = deals.map(d => dealToRow(d, buildingByDeal[d.id]));
  return json(200, { deals: rows });
};

module.exports._dealToRow = dealToRow;
module.exports._stageKind = stageKind;
