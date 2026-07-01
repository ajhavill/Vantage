// Vantage — tenant-get (Netlify Function, called by the logged-in broker).
//
// One tenant, deep: the HubSpot Company + its full headcount snapshot history +
// the computed months-to-expiration, renewal flag, and propensity score/chips.
// Used by the tenant detail drawer and the headcount trend chart.

const { configured, rest, userFromToken } = require("./_sb");
const { configured: hsConfigured, hs } = require("./_hubspot");
const { score } = require("./_propensity");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const HS_PROPS = [
  "name", "industry", "building_id", "lease_expiration_date", "lease_commencement_date",
  "estimated_rsf", "headcount", "sublease_flag", "funding_last_round",
  "funding_last_date", "propensity_to_move_score"
].join(",");

const num = (v) => { const n = Number(v); return (v === null || v === undefined || v === "" || isNaN(n)) ? null : n; };
const date = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
const bool = (v) => v === true || v === "true";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });
  if (!hsConfigured()) return json(500, { error: "HubSpot is not connected (HUBSPOT_PRIVATE_APP_TOKEN not set)." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const companyId = String(body.companyId || "");
  if (!/^\d{1,20}$/.test(companyId)) return json(400, { error: "Bad company id." });

  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id&limit=1");
  const orgId = prof.ok && Array.isArray(prof.data) && prof.data[0] && prof.data[0].org_id;
  if (!orgId) return json(403, { error: "No firm is associated with your account." });

  const c = await hs("/crm/v3/objects/companies/" + companyId + "?properties=" + encodeURIComponent(HS_PROPS));
  if (c.status === 404) return json(404, { error: "That company was not found in HubSpot." });
  if (!c.ok) return json(502, { error: "HubSpot read failed: " + (c.text || c.status) });

  const snap = await rest("tenant_intel_snapshots?org_id=eq." + encodeURIComponent(orgId) +
    "&hs_company_id=eq." + encodeURIComponent(companyId) +
    "&select=id,captured_at,headcount,source,note&order=captured_at.asc");
  const snaps = (snap.ok && Array.isArray(snap.data)) ? snap.data : [];

  const p = (c.data && c.data.properties) || {};
  const tenant = {
    id: companyId,
    name: p.name || "(unnamed company)",
    industry: p.industry || null,
    buildingId: p.building_id || null,
    rsf: num(p.estimated_rsf),
    headcount: num(p.headcount),
    leaseExpiration: date(p.lease_expiration_date),
    leaseCommencement: date(p.lease_commencement_date),
    subleaseFlag: bool(p.sublease_flag),
    fundingRound: p.funding_last_round || null,
    fundingDate: date(p.funding_last_date)
  };
  const s = score(tenant, snaps, new Date());

  return json(200, {
    tenant: {
      id: tenant.id, name: tenant.name, industry: tenant.industry, buildingId: tenant.buildingId,
      rsf: tenant.rsf, headcount: tenant.headcount,
      leaseExpiration: p.lease_expiration_date || null,
      leaseCommencement: p.lease_commencement_date || null,
      subleaseFlag: tenant.subleaseFlag,
      fundingRound: tenant.fundingRound, fundingDate: p.funding_last_date || null,
      monthsToExpiration: s.monthsToExpiration, renewalFlag: s.renewalFlag,
      headcountDeltaPct: s.headcountDeltaPct,
      propensity: { score: s.score, chips: s.chips, components: s.components }
    },
    snapshots: snaps
  });
};
