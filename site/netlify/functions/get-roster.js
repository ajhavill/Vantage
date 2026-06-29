// Vantage — get-roster (Netlify Function, called by the Cockpit / logged-in broker).
//
// Returns the raw uploaded roster spreadsheet (base64) for ONE of the broker's
// own intakes, looked up by slug. Kept out of list-intakes so that endpoint
// stays light — roster files can be megabytes. Scoped to the broker's user id,
// so a broker can only pull rosters from prospects they own.

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

  const slug = String(body.slug || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(400, { error: "Bad slug." });

  const r = await rest("intakes?owner_id=eq." + encodeURIComponent(user.id) +
    "&slug=eq." + encodeURIComponent(slug) +
    "&select=roster_filename,roster_data&limit=1");
  if (!r.ok) return json(500, { error: "Lookup failed: " + (r.text || r.status) });

  const row = Array.isArray(r.data) && r.data[0];
  if (!row) return json(404, { error: "No such questionnaire." });
  if (!row.roster_data) return json(404, { error: "No roster was uploaded for this prospect." });

  return json(200, { filename: row.roster_filename || "roster", data: row.roster_data });
};
