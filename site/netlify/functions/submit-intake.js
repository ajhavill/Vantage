// Vantage — submit-intake (Netlify Function, called by the public questionnaire page).
//
// Saves a prospect's answers (and an optional roster spreadsheet as base64) onto
// the broker-created intake row, marking it completed — then emails the broker a
// notification with a deep link to the results (best-effort; never blocks the save).
// Supabase REST + service role; the unguessable slug is the prospect's access.

const { configured, rest } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

// Email the owning broker (best-effort). No-op until RESEND_API_KEY is set.
async function notifyBroker(intakeRow, host) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !intakeRow || !intakeRow.owner_id) return;

  let to = null;
  try {
    const p = await rest("profiles?id=eq." + encodeURIComponent(intakeRow.owner_id) + "&select=email");
    if (p.ok && Array.isArray(p.data) && p.data[0]) to = p.data[0].email;
  } catch (e) { /* ignore */ }
  if (!to) return;

  const r = intakeRow.responses || {};
  const company = intakeRow.company_name || r.company || "A prospect";
  const link = (host ? "https://" + host : "") + "/?intake=" + intakeRow.slug;
  const bits = [];
  if (r.contactName || r.contactEmail) bits.push("Contact: " + [r.contactName, r.contactEmail].filter(Boolean).join(" · "));
  if (r.headcount) bits.push("Team: " + r.headcount + (r.headcountFuture ? " → " + r.headcountFuture : "") + " people");
  if (r.sf) bits.push("Square footage: " + r.sf);
  if (r.budget) bits.push("Budget: " + r.budget);
  if (r.timeline) bits.push("Move-in: " + r.timeline);
  if (Array.isArray(r.areas) && r.areas.length) bits.push("Submarkets: " + r.areas.join(", "));

  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;color:#1A2230">' +
    '<div style="font-weight:800;font-size:20px">Vantage<span style="color:#2D6E7E">.</span></div>' +
    '<h2 style="margin:18px 0 4px;font-size:18px">New questionnaire response</h2>' +
    '<p style="color:#55606F;margin:0 0 16px"><b>' + esc(company) + '</b> just completed their Vantage questionnaire.</p>' +
    (bits.length ? '<ul style="color:#333;line-height:1.7;padding-left:18px;margin:0 0 18px">' + bits.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("") + "</ul>" : "") +
    '<p style="margin:0 0 22px"><a href="' + esc(link) + '" style="background:#1B2A4A;color:#fff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">View results &amp; matched buildings &rarr;</a></p>' +
    '<p style="color:#8A93A0;font-size:12px;margin:0">You\'re receiving this because a client you sent a questionnaire to responded. — Vantage, Havill &amp; Co.</p></div>';

  const from = process.env.RESEND_FROM || "Vantage <onboarding@resend.dev>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: [to], subject: "New questionnaire response — " + company, html: html })
    });
  } catch (e) { /* best-effort; the save already succeeded */ }
}

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

  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  try { await notifyBroker(r.data[0], host); } catch (e) { /* never fail the prospect over a notification */ }

  return json(200, { ok: true });
};
