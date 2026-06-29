// TEMPORARY diagnostic — gated by BROKER_SECRET. Reports whether the email + DB
// env vars are visible to functions, and (optionally) attempts a real Resend send
// so we can see the exact Resend response. Delete after debugging.

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad body" }); }
  if (!process.env.BROKER_SECRET || body.brokerSecret !== process.env.BROKER_SECRET) return json(401, { error: "Not authorized." });

  const from = process.env.RESEND_FROM || "Vantage <onboarding@resend.dev>";
  const out = {
    hasResendKey: !!process.env.RESEND_API_KEY,
    resendKeyPrefix: process.env.RESEND_API_KEY ? String(process.env.RESEND_API_KEY).slice(0, 5) : null,
    from: from,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasSupabaseServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY
  };

  // dump profiles (id/email/role) so we can see if broker emails are populated
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const pr = await fetch(process.env.SUPABASE_URL + "/rest/v1/profiles?select=id,email,role,full_name", { headers: { apikey: k, Authorization: "Bearer " + k } });
      out.profiles = JSON.parse((await pr.text()) || "null");
    } catch (e) { out.profilesError = String(e && e.message ? e.message : e); }
  }

  if (process.env.RESEND_API_KEY && body.to) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: from, to: [String(body.to)], subject: "Vantage test email", html: "<p>This is a Vantage diagnostic test email. If you got this, Resend is wired up correctly.</p>" })
      });
      out.resendStatus = r.status;
      out.resendBody = (await r.text()).slice(0, 600);
    } catch (e) { out.resendError = String(e && e.message ? e.message : e); }
  }
  return json(200, out);
};
