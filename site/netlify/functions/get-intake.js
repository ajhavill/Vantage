// Vantage — get-intake (Netlify Function, called by the public questionnaire page).
//
// Given a questionnaire slug, returns just enough to render the form (the
// company name it was prepared for, and whether it's already been completed).
// Uses the Supabase service role (server-only) so the prospect needs no login;
// the unguessable slug in their link is the access token.

const { createClient } = require("@supabase/supabase-js");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const slug = String((event.queryStringParameters && event.queryStringParameters.i) ||
    (() => { try { return JSON.parse(event.body || "{}").slug; } catch (e) { return ""; } })() || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "This questionnaire link is not valid." });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Server is missing Supabase config (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data, error } = await sb.from("intakes").select("company_name,status").eq("slug", slug).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!data) return json(404, { error: "This questionnaire link is not valid." });
  return json(200, { company: data.company_name || "", status: data.status });
};
