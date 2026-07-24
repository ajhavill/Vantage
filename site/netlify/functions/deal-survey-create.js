// Vantage — deal-survey-create (Netlify Function, called from the deal page).
//
// Phase 3 of the requirement→deliverable flow: one click on the deal's Market
// report section → a co-branded CLIENT MARKET SURVEY. This function assembles
// the package fully server-side and stores it in the same Netlify Blobs store
// the Cockpit's client packages use ("client-packages"), so the existing
// get-package function and client.html viewer serve it unchanged
// (preset "survey"). Returns the share link; the passcode is stored HASHED.
//
// Server-side by design — redaction happens HERE, before anything reaches a
// browser (pattern of comps.js redactForClient):
//   * listing/landlord contacts stripped from every building (client routes
//     through the broker — standard tenant-rep practice);
//   * market_spaces queried WITHOUT listing_* columns and only for
//     publishable sources (listing-broker / flyer / manual). CoStar-sourced
//     rows never leave the broker login (CoStar firewall, market-spaces.sql);
//   * catalog data comes from the site's own vantage-data.json (public), so
//     nothing CoStar-proprietary is in scope at all.
//
// Auth: broker JWT (same as every deal-* function) + deal org ownership.
// Also appends a row to deal_surveys (supabase/deal-surveys.sql) so the link
// stays re-findable from the deal page.

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");
const sb = require("./_sb");
const pack = require("./_survey-pack");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const MAX_BUILDINGS = 20; // same ceiling as create-package

function slugGen() {
  const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const b = crypto.randomBytes(14);
  let s = ""; for (let i = 0; i < 14; i++) s += a[b[i] % a.length];
  return s;
}
function hashPass(passcode, salt) {
  return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, "sha256").toString("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!sb.configured()) return json(500, { error: "Server is missing Supabase configuration." });
  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const user = await sb.userFromToken(body.token);
  if (!user) return json(401, { error: "Your session expired — please sign in again." });

  const dealId = String(body.dealId || "");
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return json(400, { error: "Bad deal id." });
  if (!body.passcode || String(body.passcode).length < 3) return json(400, { error: "A passcode of at least 3 characters is required." });

  // Deal + org ownership (service_role bypasses RLS, so verify explicitly).
  const pr = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
  const profile = pr.data && pr.data[0];
  if (!profile || !profile.org_id) return json(403, { error: "Your profile has no organization." });
  const dr = await sb.rest("deals?id=eq." + encodeURIComponent(dealId) + "&select=id,org_id,client_name&limit=1");
  const deal = dr.data && dr.data[0];
  if (!deal) return json(404, { error: "Deal not found." });
  if (deal.org_id !== profile.org_id) return json(403, { error: "Not your deal." });

  // The survey set = the deal's Market report (status 'shortlisted'), in order.
  const pp = await sb.rest("deal_properties?deal_id=eq." + encodeURIComponent(dealId)
    + "&status=eq.shortlisted&select=building_id,name,address,sort_order&order=sort_order");
  const props = (pp.data || []).filter((p) => p);
  if (!props.length) return json(400, { error: "No buildings in the market report yet — add candidates to the market report first." });
  if (props.length > MAX_BUILDINGS) return json(400, { error: "Too many buildings (max " + MAX_BUILDINGS + " per survey) — trim the market report." });

  // Building catalog from this site's own public data file.
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  const site = host ? ("https://" + host) : (process.env.URL || "");
  let catalog;
  try {
    const cr = await fetch(site + "/vantage-data.json");
    if (!cr.ok) throw new Error("HTTP " + cr.status);
    catalog = await cr.json();
  } catch (e) {
    return json(500, { error: "Could not load the building catalog: " + (e.message || e) });
  }

  // Broker-uploaded media + publishable tracker rows for these buildings.
  // NOTE: listing_* columns are deliberately not selected, and only
  // publishable sources pass the filter — the CoStar firewall stays intact.
  const ids = props.map((p) => p.building_id).filter(Boolean);
  let mediaRows = [], spaceRows = [];
  if (ids.length) {
    const inList = "(" + ids.map((id) => '"' + String(id).replace(/"/g, "") + '"').join(",") + ")";
    try {
      const mr = await sb.rest("building_media?org_id=eq." + profile.org_id
        + "&building_id=in." + encodeURIComponent(inList)
        + "&select=building_id,kind,url,title,sort_order&order=sort_order");
      mediaRows = mr.data || [];
    } catch (e) { /* media is enrichment — never sink the survey */ }
    try {
      const xr = await sb.rest("market_spaces?org_id=eq." + profile.org_id
        + "&building_id=in." + encodeURIComponent(inList)
        + "&status=eq.active&source=in.(listing-broker,flyer,manual)"
        + "&select=building_id,suite,floor,sf,asking_rate,rate_period,rate_basis,available_date,space_type,source");
      spaceRows = xr.data || [];
    } catch (e) { /* tracker is enrichment too */ }
  }

  const today = new Date().toISOString().slice(0, 10);
  const built = pack.buildSurveyBuildings((catalog && catalog.buildings) || [], props, mediaRows, spaceRows, { today: today });
  if (!built.buildings.length) {
    return json(400, { error: "None of the market-report buildings are linked to the building catalog — open each one and pick its catalog match." });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const slug = slugGen();
  const clientName = String(body.clientName || deal.client_name || "Client").slice(0, 120);
  const pkg = {
    v: 1,
    preset: "survey",
    slug,
    createdAt: new Date().toISOString(),
    client: { name: clientName, logoUrl: String(body.clientLogoUrl || "").slice(0, 600) },
    broker: { name: "Havill & Co." },
    dealId: dealId,
    passcodeHash: hashPass(body.passcode, salt),
    salt,
    buildings: built.buildings,
    // Empty like the Cockpit's packages: buildings carry no cscore, so the
    // viewer's score chips / weighted compare rows simply don't render.
    categories: [],
    industries: [],
    bakedCommute: null
  };

  try {
    const store = getStore("client-packages");
    await store.setJSON(slug, pkg);
  } catch (e) {
    return json(500, { error: "Could not save the survey: " + (e && e.message ? e.message : "blob store error") });
  }

  const url = site + "/client.html?c=" + slug;

  // Ledger row so the link is re-findable from the deal page (best-effort —
  // the survey already exists even if this insert fails, e.g. missing table).
  try {
    await sb.rest("deal_surveys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        org_id: profile.org_id, deal_id: dealId, slug: slug, url: url,
        client_name: clientName, building_count: built.buildings.length, created_by: user.id
      })
    });
  } catch (e) { /* non-fatal */ }

  return json(200, { slug, url, buildingCount: built.buildings.length, skipped: built.skipped });
};
