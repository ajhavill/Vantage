// Vantage — tenant-snapshot (Netlify Function, called by the logged-in broker).
//
// Records ONE headcount reading for a tenant into the Supabase timeseries. This is
// the manual-entry path (source:'manual'); an enrichment integration would write
// here too with source:'enrichment'. The tenant record itself stays in HubSpot —
// this table only stores the (company id, date, headcount) history HubSpot can't.
//
// Org scope is enforced in code from the broker's profile (service_role bypasses RLS).

const { configured, rest, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const ALLOWED_SOURCES = ["manual", "enrichment", "sync"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const companyId = String(body.companyId || "");
  if (!/^\d{1,20}$/.test(companyId)) return json(400, { error: "Bad company id." });

  const headcount = Number(body.headcount);
  if (!Number.isInteger(headcount) || headcount < 0 || headcount > 10000000) {
    return json(400, { error: "Headcount must be a whole number of people." });
  }

  const source = ALLOWED_SOURCES.includes(body.source) ? body.source : "manual";
  const note = body.note ? String(body.note).slice(0, 500) : null;
  let capturedAt = new Date().toISOString();
  if (body.capturedAt) {
    const d = new Date(body.capturedAt);
    if (isNaN(d.getTime())) return json(400, { error: "Bad capture date." });
    capturedAt = d.toISOString();
  }

  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id&limit=1");
  const orgId = prof.ok && Array.isArray(prof.data) && prof.data[0] && prof.data[0].org_id;
  if (!orgId) return json(403, { error: "No firm is associated with your account." });

  const insert = await rest("tenant_intel_snapshots", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: orgId,
      hs_company_id: companyId,
      headcount: headcount,
      captured_at: capturedAt,
      source: source,
      note: note,
      created_by: user.id
    })
  });
  if (!insert.ok) return json(500, { error: "Save failed: " + (insert.text || insert.status) });

  const row = Array.isArray(insert.data) ? insert.data[0] : insert.data;
  return json(200, { ok: true, snapshot: row });
};
