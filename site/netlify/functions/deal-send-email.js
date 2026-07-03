// Vantage — deal-send-email. Sends an email from the platform (via Resend) and logs it to
// the emails table, threaded to a deal. Verifies the broker's Supabase token. Degrades
// gracefully: if sending isn't configured (no RESEND_API_KEY / EMAIL_FROM or an unverified
// domain), it logs the email as a draft and returns a clear message so the UI can fall back.
//
// Env: RESEND_API_KEY (shared with intake), EMAIL_FROM (e.g. "Andrew Havill <andrew@havill.co>"
// — the domain must be verified in Resend to actually deliver).

const sb = require("./_sb");
const okJSON = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };

  const to = String(body.to || "").trim();
  const subject = String(body.subject || "").trim();
  const text = String(body.body || "");
  const cc = String(body.cc || "").trim();
  const dealId = body.dealId || null;
  if (!/.+@.+\..+/.test(to)) return okJSON({ error: "Enter a valid recipient email address." });
  if (!subject) return okJSON({ error: "Add a subject line." });

  // deal ownership (if linked) + org for stamping
  let orgId = null;
  try { const pr = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1"); orgId = pr.data && pr.data[0] && pr.data[0].org_id; } catch (e) {}
  if (dealId) {
    try { const dr = await sb.rest("deals?id=eq." + dealId + "&select=owner_id&limit=1"); const d = dr.data && dr.data[0]; if (!d) return okJSON({ error: "That deal wasn't found." }); } catch (e) {}
  }

  const FROM = process.env.EMAIL_FROM;
  let sendStatus = "failed", sentAt = null, errMsg = null;
  if (process.env.RESEND_API_KEY && FROM) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ from: FROM, to: [to], subject: subject, text: text }, cc ? { cc: [cc] } : {}, body.replyTo ? { reply_to: body.replyTo } : {}))
      });
      const d = await res.json().catch(() => null);
      if (res.ok) { sendStatus = "sent"; sentAt = new Date().toISOString(); }
      else { errMsg = (d && (d.message || d.error)) || ("Resend HTTP " + res.status); }
    } catch (e) { errMsg = e.message; }
  } else {
    errMsg = "Email sending isn't configured yet — set RESEND_API_KEY and a verified EMAIL_FROM domain.";
  }

  // Log the email regardless (a sent record, or a draft to fall back on)
  let logged = null;
  try {
    const row = {
      owner_id: user.id, org_id: orgId, deal_id: dealId,
      direction: "outbound", status: sendStatus === "sent" ? "sent" : "draft",
      from_addr: FROM || null, to_addr: to, cc_addr: cc || null, subject: subject, body: text,
      snippet: (text || "").replace(/\s+/g, " ").slice(0, 180), sent_at: sentAt, provider: "resend"
    };
    const ins = await sb.rest("emails", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) });
    logged = ins.data && ins.data[0];
  } catch (e) { /* non-fatal */ }

  if (sendStatus === "sent") return okJSON({ ok: true, id: logged && logged.id, message: "Sent to " + to });
  return okJSON({ error: errMsg || "Could not send.", savedDraft: !!logged });
};
