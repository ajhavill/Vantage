// Vantage — portal-notify (Netlify Function, called by the logged-in broker).
//
// The broker-triggered "Notify client" email: after sharing something new (a
// proposal marked visible, a document, a tour), the broker clicks Notify and every
// active portal user at that client company gets a branded "your portal has an
// update" email pointing at portal.html. Nothing is ever sent automatically —
// the broker controls timing. Uses Resend (same setup as submit-intake's broker
// notification); no-ops with a clear error if RESEND_API_KEY isn't set.

const { configured, rest, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

function siteUrl(event) {
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  return host ? ("https://" + host) : (process.env.URL || "");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });
  if (!process.env.RESEND_API_KEY) return json(500, { error: "Email isn't configured (RESEND_API_KEY)." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const hsCompanyId = String(body.hsCompanyId || "").trim();
  if (!hsCompanyId) return json(400, { error: "hsCompanyId is required." });
  const note = String(body.note || "").slice(0, 500);

  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id,role,full_name,email&limit=1");
  const me = (prof.ok && Array.isArray(prof.data) && prof.data[0]) || null;
  if (!me || me.role === "client" || !me.org_id) return json(403, { error: "Only brokers can notify clients." });

  // every active portal user at this company (in the broker's org)
  const g = await rest("client_access?org_id=eq." + encodeURIComponent(me.org_id) +
    "&hs_company_id=eq." + encodeURIComponent(hsCompanyId) + "&active=eq.true&select=user_id,client_name");
  const grants = (g.ok && Array.isArray(g.data)) ? g.data : [];
  if (!grants.length) return json(400, { error: "No portal users at this client yet — invite someone first." });

  const pr = await rest("profiles?id=in.(" + grants.map((r) => r.user_id).join(",") + ")&select=email");
  const emails = ((pr.ok && Array.isArray(pr.data)) ? pr.data : []).map((p) => p.email).filter(Boolean);
  if (!emails.length) return json(400, { error: "No email addresses found for this client's portal users." });

  const link = siteUrl(event) + "/portal.html";
  const brokerName = me.full_name || "Your broker";
  const html = '<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:8px 4px">' +
    '<div style="font-size:22px;font-weight:800;color:#1B2A4A">Vantage<span style="color:#2D6E7E">.</span> <span style="font-size:11px;font-weight:500;color:#8A93A0;letter-spacing:.04em;text-transform:uppercase">by Havill &amp; Co.</span></div>' +
    '<h2 style="margin:18px 0 4px;font-size:18px;color:#1B2A4A">There\'s something new in your portal</h2>' +
    '<p style="color:#55606F;margin:0 0 14px">' + esc(brokerName) + " shared an update with you." + '</p>' +
    (note ? '<p style="color:#333;background:#F6F7F9;border-radius:9px;padding:12px 14px;margin:0 0 18px;line-height:1.6">' + esc(note) + '</p>' : "") +
    '<p style="margin:0 0 22px"><a href="' + esc(link) + '" style="background:#1B2A4A;color:#fff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">Open your portal &rarr;</a></p>' +
    '<p style="color:#8A93A0;font-size:12px;margin:0">You\'re receiving this because Havill &amp; Co. shares your leasing updates through the Vantage portal.</p></div>';

  const from = process.env.RESEND_FROM || "Vantage <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: emails, subject: "New update in your Vantage portal", html: html })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return json(502, { error: "Email send failed: " + (t || res.status) });
    }
  } catch (e) {
    return json(502, { error: "Email send failed: " + (e && e.message ? e.message : "network error") });
  }

  return json(200, { ok: true, sent: emails.length });
};
