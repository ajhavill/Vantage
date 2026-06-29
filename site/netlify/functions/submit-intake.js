// Vantage — submit-intake (Netlify Function, called by the public questionnaire page).
//
// Saves a prospect's questionnaire answers (and an optional roster spreadsheet,
// stored as base64) onto the broker-created intake row, marking it completed.
// Service role + the unguessable slug; no login required for the prospect.

const { createClient } = require("@supabase/supabase-js");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const slug = String(body.slug || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "This questionnaire link is not valid." });
  if (!body.responses || typeof body.responses !== "object") return json(400, { error: "No answers were submitted." });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Server is missing Supabase config." });
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // the broker must have created this intake first
  const { data: existing, error: findErr } = await sb.from("intakes").select("id").eq("slug", slug).maybeSingle();
  if (findErr) return json(500, { error: findErr.message });
  if (!existing) return json(404, { error: "This questionnaire link is not valid." });

  const update = { responses: body.responses, status: "completed", completed_at: new Date().toISOString() };
  if (body.rosterFileName) update.roster_filename = String(body.rosterFileName).slice(0, 200);
  if (body.rosterData) update.roster_data = String(body.rosterData).slice(0, 8 * 1024 * 1024); // ~8MB base64 cap

  const { error } = await sb.from("intakes").update(update).eq("slug", slug);
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true });
};
