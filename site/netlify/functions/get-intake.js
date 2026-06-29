// Vantage — get-intake (Netlify Function, called by the public questionnaire page).
//
// Given a questionnaire slug, returns just enough to render the form (the company
// name it was prepared for, and whether it's already completed). Talks to Supabase
// over REST with the service role; the unguessable slug is the prospect's access.

const { configured, rest } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const slug = String((event.queryStringParameters && event.queryStringParameters.i) ||
    (() => { try { return JSON.parse(event.body || "{}").slug; } catch (e) { return ""; } })() || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "This questionnaire link is not valid." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });

  const r = await rest("intakes?slug=eq." + encodeURIComponent(slug) + "&select=company_name,status");
  if (!r.ok) return json(500, { error: "Lookup failed: " + (r.text || r.status) });
  if (!Array.isArray(r.data) || !r.data.length) return json(404, { error: "This questionnaire link is not valid." });
  return json(200, { company: r.data[0].company_name || "", status: r.data[0].status });
};
