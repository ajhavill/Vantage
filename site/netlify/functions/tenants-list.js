// Vantage — tenants-list (Netlify Function, called by the logged-in broker).
//
// The tenant-intelligence feed. Reads Companies live from HubSpot (only those with
// a building_id — i.e. tenants mapped to a Vantage building), pulls their headcount
// snapshot history from Supabase, computes months-to-expiration + the renewal flag +
// the propensity-to-move score with reason chips, and returns the whole grid.
//
// Two side-optimizations:
//   • Short-TTL cache in Netlify Blobs so a page refresh doesn't re-hit HubSpot.
//     Pass { fresh:true } to bypass.
//   • Writes the freshly computed score back to HubSpot's propensity_to_move_score
//     (only for companies whose stored value changed) so HubSpot workflows see it.
//     Best-effort: a write-back failure never fails the read.

const { configured, rest, userFromToken } = require("./_sb");
const { configured: hsConfigured, hs } = require("./_hubspot");
const { score } = require("./_propensity");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const CACHE_TTL_MS = 300 * 1000;
const HS_PROPS = [
  "name", "industry", "building_id", "lease_expiration_date", "lease_commencement_date",
  "estimated_rsf", "headcount", "sublease_flag", "funding_last_round",
  "funding_last_date", "propensity_to_move_score"
];

const num = (v) => { const n = Number(v); return (v === null || v === undefined || v === "" || isNaN(n)) ? null : n; };
const date = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
const bool = (v) => v === true || v === "true";

// ---- Netlify Blobs cache (optional; degrades gracefully if unavailable) ----
async function cacheGet(key) {
  try {
    const { getStore } = require("@netlify/blobs");
    const store = getStore("tenant-intel-cache");
    const hit = await store.get(key, { type: "json" });
    if (hit && hit.ts && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.payload;
  } catch (e) { /* no blobs in this context — skip cache */ }
  return null;
}
async function cacheSet(key, payload) {
  try {
    const { getStore } = require("@netlify/blobs");
    const store = getStore("tenant-intel-cache");
    await store.setJSON(key, { ts: Date.now(), payload: payload });
  } catch (e) { /* best effort */ }
}

// Pull every HubSpot company that has a building_id set, paging through search.
async function fetchTenants() {
  const out = [];
  let after = undefined;
  for (let page = 0; page < 20; page++) { // hard cap: 20 * 100 = 2000 tenants
    const body = {
      filterGroups: [{ filters: [{ propertyName: "building_id", operator: "HAS_PROPERTY" }] }],
      properties: HS_PROPS,
      limit: 100
    };
    if (after) body.after = after;
    const r = await hs("/crm/v3/objects/companies/search", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) return { error: r.text || String(r.status) };
    const results = (r.data && r.data.results) || [];
    for (const c of results) out.push(c);
    after = r.data && r.data.paging && r.data.paging.next && r.data.paging.next.after;
    if (!after) break;
  }
  return { tenants: out };
}

// Snapshot history for a set of company ids, grouped by id (ascending by time).
async function fetchSnapshots(orgId, ids) {
  const byId = {};
  ids.forEach(id => { byId[id] = []; });
  for (let i = 0; i < ids.length; i += 200) { // chunk to keep the URL sane
    const chunk = ids.slice(i, i + 200);
    const inList = "(" + chunk.map(encodeURIComponent).join(",") + ")";
    const r = await rest("tenant_intel_snapshots?org_id=eq." + encodeURIComponent(orgId) +
      "&hs_company_id=in." + inList +
      "&select=hs_company_id,captured_at,headcount&order=captured_at.asc");
    if (r.ok && Array.isArray(r.data)) {
      for (const row of r.data) (byId[row.hs_company_id] = byId[row.hs_company_id] || []).push(row);
    }
  }
  return byId;
}

// Push changed scores back to HubSpot (best-effort, chunked, never throws).
async function writeBackScores(updates) {
  try {
    for (let i = 0; i < updates.length; i += 100) {
      const inputs = updates.slice(i, i + 100).map(u => ({
        id: u.id, properties: { propensity_to_move_score: String(u.score) }
      }));
      await hs("/crm/v3/objects/companies/batch/update", { method: "POST", body: JSON.stringify({ inputs }) });
    }
  } catch (e) { /* swallow — read must succeed regardless */ }
}

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

  // Org scope from the broker's profile (drives cache key + snapshot visibility).
  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id&limit=1");
  const orgId = prof.ok && Array.isArray(prof.data) && prof.data[0] && prof.data[0].org_id;
  if (!orgId) return json(403, { error: "No firm is associated with your account." });

  const cacheKey = "list:" + orgId;
  if (!body.fresh) {
    const cached = await cacheGet(cacheKey);
    if (cached) return json(200, Object.assign({ cached: true }, cached));
  }

  const fetched = await fetchTenants();
  if (fetched.error) return json(502, { error: "HubSpot read failed: " + fetched.error });
  const raw = fetched.tenants;

  const ids = raw.map(c => c.id);
  const snapsById = await fetchSnapshots(orgId, ids);

  const now = new Date();
  const writeBacks = [];
  const tenants = raw.map(c => {
    const p = c.properties || {};
    const snaps = snapsById[c.id] || [];
    const tenant = {
      id: c.id,
      name: p.name || "(unnamed company)",
      industry: p.industry || null,
      buildingId: p.building_id || null,
      rsf: num(p.estimated_rsf),
      headcount: num(p.headcount),                 // HubSpot's current value
      leaseExpiration: date(p.lease_expiration_date),
      leaseCommencement: date(p.lease_commencement_date),
      subleaseFlag: bool(p.sublease_flag),
      fundingRound: p.funding_last_round || null,
      fundingDate: date(p.funding_last_date)
    };
    const s = score(tenant, snaps, now);

    // Queue a write-back only when the rounded score actually changed.
    const stored = num(p.propensity_to_move_score);
    if (stored === null || Math.round(stored) !== s.score) writeBacks.push({ id: c.id, score: s.score });

    return {
      id: tenant.id,
      name: tenant.name,
      industry: tenant.industry,
      buildingId: tenant.buildingId,
      rsf: tenant.rsf,
      headcount: tenant.headcount,
      leaseExpiration: p.lease_expiration_date || null,
      leaseCommencement: p.lease_commencement_date || null,
      subleaseFlag: tenant.subleaseFlag,
      fundingRound: tenant.fundingRound,
      fundingDate: p.funding_last_date || null,
      monthsToExpiration: s.monthsToExpiration,
      renewalFlag: s.renewalFlag,
      headcountDeltaPct: s.headcountDeltaPct,
      headcountSeries: snaps.map(x => [x.captured_at, x.headcount]),
      propensity: { score: s.score, chips: s.chips, components: s.components }
    };
  });

  if (writeBacks.length) await writeBackScores(writeBacks); // best-effort

  const payload = {
    tenants: tenants,
    count: tenants.length,
    scoredAt: now.toISOString(),
    renewalWindow: require("./_propensity-config").renewalWindow
  };
  await cacheSet(cacheKey, payload);
  return json(200, Object.assign({ cached: false }, payload));
};
