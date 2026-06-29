// Vantage — list-intakes (Netlify Function, called by the Cockpit / logged-in broker).
//
// Returns the signed-in broker's own intakes (sent + completed, with responses).
// Authorized by the broker's Supabase session token; scoped to their user id.
// There is no way to list another broker's intakes.

const { createClient } = require("@supabase/supabase-js");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: ures, error: uerr } = await sb.auth.getUser(token);
  if (uerr || !ures || !ures.user) return json(401, { error: "Your session has expired — please sign in again." });

  const { data, error } = await sb.from("intakes")
    .select("slug,company_name,status,responses,roster_filename,created_at,completed_at")
    .eq("owner_id", ures.user.id)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) return json(500, { error: error.message });
  return json(200, { intakes: data || [] });
};
