// Vantage — hubspot-bootstrap (Netlify Function).
//
// Idempotently ensures the HubSpot Company object has every custom property the
// tenant-intelligence layer needs, grouped under "vantage_tenant_intel". Safe to
// run repeatedly: it creates only what's missing and never edits existing props.
//
// We deliberately DO NOT create an "industry" property — HubSpot ships a native
// `industry` Company property and we reuse it (broker's decision).
//
// Auth: requires a signed-in platform_admin (you). Run it once after setting the
// HUBSPOT_PRIVATE_APP_TOKEN env var, or hit it again any time to re-verify.

const { configured, rest, userFromToken } = require("./_sb");
const { configured: hsConfigured, hs } = require("./_hubspot");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const GROUP = { name: "vantage_tenant_intel", label: "Vantage Tenant Intel", displayOrder: -1 };

// The custom properties to guarantee. `industry` is intentionally absent (native reuse).
const PROPS = [
  { name: "lease_expiration_date",   label: "Lease Expiration Date",   type: "date",   fieldType: "date" },
  { name: "lease_commencement_date", label: "Lease Commencement Date", type: "date",   fieldType: "date" },
  { name: "estimated_rsf",           label: "Estimated RSF",           type: "number", fieldType: "number" },
  { name: "headcount",               label: "Headcount",               type: "number", fieldType: "number" },
  { name: "building_id",             label: "Vantage Building ID",     type: "string", fieldType: "text" },
  { name: "sublease_flag",           label: "Sublease Listed",         type: "enumeration", fieldType: "booleancheckbox",
    options: [ { label: "Yes", value: "true", displayOrder: 0 }, { label: "No", value: "false", displayOrder: 1 } ] },
  { name: "funding_last_round",      label: "Last Funding Round",      type: "string", fieldType: "text" },
  { name: "funding_last_date",       label: "Last Funding Date",       type: "date",   fieldType: "date" },
  { name: "propensity_to_move_score",label: "Propensity to Move (Vantage)", type: "number", fieldType: "number" }
];

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

  // 1) Ensure the property group exists (409 = already there, which is fine).
  const grp = await hs("/crm/v3/properties/companies/groups", { method: "POST", body: JSON.stringify(GROUP) });
  if (!grp.ok && grp.status !== 409) {
    return json(502, { error: "Could not create property group: " + (grp.text || grp.status) });
  }

  // 2) List existing company properties so we only create what's missing.
  const existing = await hs("/crm/v3/properties/companies?archived=false");
  if (!existing.ok) return json(502, { error: "Could not read company properties: " + (existing.text || existing.status) });
  const have = new Set((existing.data && existing.data.results || []).map(p => p.name));

  const created = [];
  const skipped = [];
  const failed = [];

  for (const p of PROPS) {
    if (have.has(p.name)) { skipped.push(p.name); continue; }
    const payload = Object.assign({ groupName: GROUP.name }, p);
    const r = await hs("/crm/v3/properties/companies", { method: "POST", body: JSON.stringify(payload) });
    if (r.ok) created.push(p.name);
    else if (r.status === 409) skipped.push(p.name);         // race / already exists
    else failed.push({ name: p.name, error: r.text || String(r.status) });
  }

  // Confirm the native industry property is present (informational, never created).
  const industryNative = have.has("industry");

  return json(failed.length ? 207 : 200, {
    ok: failed.length === 0,
    group: GROUP.name,
    created: created,
    skipped: skipped,
    failed: failed,
    industryNativeReused: industryNative
  });
};
