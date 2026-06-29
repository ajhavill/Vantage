// Vantage — submit-intake (Netlify Function, called by the public questionnaire page).
//
// Saves a prospect's answers (and an optional roster spreadsheet as base64) onto
// the broker-created intake row, marking it completed. Supabase REST + service
// role; the unguessable slug is the prospect's access. No login required.

const { configured, rest } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const slug = String(body.slug || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "This questionnaire link is not valid." });
  if (!body.responses || typeof body.responses !== "object") return json(400, { error: "No answers were submitted." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  const update = { responses: body.responses, status: "completed", completed_at: new Date().toISOString() };
  if (body.rosterFileName) update.roster_filename = String(body.rosterFileName).slice(0, 200);
  if (body.rosterData) update.roster_data = String(body.rosterData).slice(0, 8 * 1024 * 1024);

  const r = await rest("intakes?slug=eq." + encodeURIComponent(slug), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(update)
  });
  if (!r.ok) return json(500, { error: "Could not save: " + (r.text || r.status) });
  if (!Array.isArray(r.data) || !r.data.length) return json(404, { error: "This questionnaire link is not valid." });
  return json(200, { ok: true });
};
