// Vantage — comps-hubspot-bootstrap (Netlify Function).
//
// Idempotently ensures the HubSpot Deal object has every custom property the
// comps sync needs, grouped under "vantage_comp". Safe to run repeatedly: it
// creates only what's missing and never edits existing props. Same shape as
// hubspot-bootstrap.js (which does the Company side for tenant intel).
//
// Auth: signed-in platform_admin (you). Run once after adding deal read/write +
// schema scopes to the HubSpot private app and setting HUBSPOT_PRIVATE_APP_TOKEN.

const { configured, rest, userFromToken } = require("./_sb");
const { configured: hsConfigured, hs } = require("./_hubspot");
const { DEAL_GROUP, DEAL_PROPS } = require("./_comps-hubspot");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

async function isPlatformAdmin(userId) {
  const r = await rest("profiles?id=eq." + encodeURIComponent(userId) + "&select=role&limit=1");
  const row = r.ok && Array.isArray(r.data) && r.data[0];
  return !!(row && row.role === "platform_admin");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });
  if (!hsConfigured()) return json(500, { error: "HUBSPOT_PRIVATE_APP_TOKEN is not set on the server." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });
  if (!(await isPlatformAdmin(user.id))) return json(403, { error: "Only a platform admin can run the HubSpot setup." });

  // 1) Ensure the deal property group exists (409 = already there, which is fine).
  const grp = await hs("/crm/v3/properties/deals/groups", { method: "POST", body: JSON.stringify(DEAL_GROUP) });
  if (!grp.ok && grp.status !== 409) {
    return json(502, { error: "Could not create deal property group: " + (grp.text || grp.status) });
  }

  // 2) List existing deal properties so we only create what's missing.
  const existing = await hs("/crm/v3/properties/deals?archived=false");
  if (!existing.ok) return json(502, { error: "Could not read deal properties: " + (existing.text || existing.status) });
  const have = new Set((existing.data && existing.data.results || []).map(p => p.name));

  const created = [], skipped = [], failed = [];
  for (const p of DEAL_PROPS) {
    if (have.has(p.name)) { skipped.push(p.name); continue; }
    const payload = Object.assign({ groupName: DEAL_GROUP.name }, p);
    const r = await hs("/crm/v3/properties/deals", { method: "POST", body: JSON.stringify(payload) });
    if (r.ok) created.push(p.name);
    else if (r.status === 409) skipped.push(p.name);
    else failed.push({ name: p.name, error: r.text || String(r.status) });
  }

  return json(failed.length ? 207 : 200, { ok: failed.length === 0, group: DEAL_GROUP.name, created, skipped, failed });
};
