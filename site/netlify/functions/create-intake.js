// Vantage — create-intake (Netlify Function, called by the Cockpit / logged-in broker).
//
// Creates an empty intake row owned by the signed-in broker and returns a
// shareable questionnaire link. Authorized by the broker's Supabase session
// token (verified server-side); the row is scoped to that broker's user id.

const { createClient } = require("@supabase/supabase-js");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function slugGen() {
  const crypto = require("crypto");
  const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const b = crypto.randomBytes(14);
  let s = ""; for (let i = 0; i < 14; i++) s += a[b[i] % a.length];
  return s;
}

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

  const slug = slugGen();
  const company = String(body.company || "Client").slice(0, 160);
  const { error } = await sb.from("intakes").insert({ slug: slug, owner_id: ures.user.id, company_name: company, status: "sent" });
  if (error) return json(500, { error: error.message });

  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  const url = (host ? "https://" + host : "") + "/intake.html?i=" + slug;
  return json(200, { slug: slug, url: url });
};
