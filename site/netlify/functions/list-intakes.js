// Vantage — list-intakes (Netlify Function, called by the Cockpit / logged-in broker).
//
// Returns the signed-in broker's own intakes (sent + completed, with responses).
// Authorized by the broker's Supabase access token; scoped to their user id.

const { configured, rest, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const r = await rest("intakes?owner_id=eq." + encodeURIComponent(user.id) +
    "&select=slug,company_name,status,responses,roster_filename,created_at,completed_at&order=created_at.desc&limit=300");
  if (!r.ok) return json(500, { error: "Lookup failed: " + (r.text || r.status) });
  return json(200, { intakes: Array.isArray(r.data) ? r.data : [] });
};
