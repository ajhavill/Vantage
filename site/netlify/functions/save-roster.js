// Vantage — save-roster (Netlify Function, called by the Cockpit / logged-in broker).
//
// Persists the AI-extracted team roster onto the intake so it's read by Claude
// only ONCE. We stash it under responses.__rosterAI (the responses column is
// already jsonb) to avoid a schema migration. Scoped to the broker's user id.

const { configured, rest, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function clean(people) {
  if (!Array.isArray(people)) return [];
  return people.slice(0, 200).map(function (p) {
    p = p || {};
    return {
      name: String(p.name || "").slice(0, 120),
      title: String(p.title || "").slice(0, 120),
      home: String(p.home || "").slice(0, 200),
      critical: !!p.critical
    };
  });
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

  const slug = String(body.slug || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(400, { error: "Bad slug." });

  const sel = "intakes?owner_id=eq." + encodeURIComponent(user.id) + "&slug=eq." + encodeURIComponent(slug);
  const r = await rest(sel + "&select=responses&limit=1");
  if (!r.ok) return json(500, { error: "Lookup failed: " + (r.text || r.status) });
  const row = Array.isArray(r.data) && r.data[0];
  if (!row) return json(404, { error: "No such questionnaire." });

  const responses = (row.responses && typeof row.responses === "object") ? row.responses : {};
  responses.__rosterAI = { people: clean(body.people), note: String(body.note || "").slice(0, 500), at: new Date().toISOString() };

  const up = await rest(sel, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ responses: responses })
  });
  if (!up.ok) return json(500, { error: "Save failed: " + (up.text || up.status) });
  return json(200, { ok: true });
};
