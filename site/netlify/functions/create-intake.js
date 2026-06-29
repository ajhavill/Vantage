// Vantage — create-intake (Netlify Function, called by the Cockpit / logged-in broker).
//
// Creates an empty intake row owned by the signed-in broker and returns a
// shareable questionnaire link. Authorized by the broker's Supabase access token
// (validated via GoTrue); org_id is auto-stamped from the owner by a DB trigger.

const { configured, rest, userFromToken } = require("./_sb");

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
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const slug = slugGen();
  const company = String(body.company || "Client").slice(0, 160);
  const r = await rest("intakes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ slug: slug, owner_id: user.id, company_name: company, status: "sent" })
  });
  if (!r.ok) return json(500, { error: "Could not create: " + (r.text || r.status) });

  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  const url = (host ? "https://" + host : "") + "/intake.html?i=" + slug;
  return json(200, { slug: slug, url: url });
};
