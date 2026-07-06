// Vantage — clients (Netlify Function, called by the logged-in broker).
//
// The Clients hub treats HubSpot COMPANIES as the single source of truth for the
// client roster. This function lists them (for the searchable roster) and creates
// them (so "Add client" writes straight to HubSpot — you never get a Vantage-only
// client HubSpot doesn't know about). Everything Vantage makes for a client is
// keyed to the HubSpot company id elsewhere; this endpoint just owns the roster.
//
// Degrades gracefully: if HubSpot isn't connected yet, list returns
// {configured:false, companies:[]} so the UI can still show clients inferred from
// existing questionnaires / packages / comps.

const { configured, rest, userFromToken } = require("./_sb");
const { configured: hsConfigured, hs } = require("./_hubspot");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const HS_PROPS = ["name", "industry", "domain", "city", "state", "numberofemployees"];

function shape(c) {
  const p = (c && c.properties) || {};
  return {
    id: c.id,
    name: p.name || "(unnamed company)",
    industry: p.industry || null,
    domain: p.domain || null,
    city: p.city || null,
    state: p.state || null,
    employees: p.numberofemployees ? Number(p.numberofemployees) : null
  };
}

// Page through every company (hard cap 2,000) so the roster is complete.
async function listCompanies() {
  const out = [];
  let after = undefined;
  const props = HS_PROPS.map(encodeURIComponent).join(",");
  for (let page = 0; page < 20; page++) {
    const qs = "?limit=100&archived=false&properties=" + props + (after ? "&after=" + encodeURIComponent(after) : "");
    const r = await hs("/crm/v3/objects/companies" + qs);
    if (!r.ok) return { error: r.text || String(r.status) };
    const results = (r.data && r.data.results) || [];
    for (const c of results) out.push(shape(c));
    after = r.data && r.data.paging && r.data.paging.next && r.data.paging.next.after;
    if (!after) break;
  }
  return { companies: out };
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

  try {
    if (body.action === "list") {
      if (!hsConfigured()) return json(200, { configured: false, companies: [] });
      const r = await listCompanies();
      if (r.error) return json(502, { error: "HubSpot read failed: " + r.error });
      return json(200, { configured: true, companies: r.companies });
    }

    if (body.action === "create") {
      const name = String((body.client && body.client.name) || "").trim();
      if (!name) return json(400, { error: "A client name is required." });
      if (!hsConfigured()) return json(200, { configured: false }); // UI keeps a local draft instead
      const props = { name: name.slice(0, 200) };
      if (body.client.industry) props.industry = String(body.client.industry).slice(0, 100);
      if (body.client.domain) props.domain = String(body.client.domain).slice(0, 200);
      const r = await hs("/crm/v3/objects/companies", { method: "POST", body: JSON.stringify({ properties: props }) });
      if (!r.ok) return json(502, { error: "Could not create the company in HubSpot: " + (r.text || r.status) });
      return json(200, { configured: true, company: shape(r.data) });
    }

    return json(400, { error: "Unknown action. Use 'list' or 'create'." });
  } catch (e) {
    return json(502, { error: (e && e.message) ? e.message : "Request failed." });
  }
};
