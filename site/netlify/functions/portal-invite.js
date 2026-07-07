// Vantage — portal-invite (Netlify Function, called by the logged-in broker).
//
// Invites a CLIENT-side user (the broker's client) to the tenant portal and grants
// them access to one client company (hs_company_id — the same spine deals/intakes
// use). Several people at one company are invited individually, each with their own
// account and their own grant row, so one person can be revoked without killing the
// company's access.
//
// Flow: broker POSTs {token, email, fullName?, hsCompanyId, clientName?}
//   1. verify the broker (Supabase token) and read their org
//   2. if the email already has a profile:
//        - broker-side role → 400 (never demote a broker to a client)
//        - client role      → just add the access grant (no second invite email)
//      otherwise: GoTrue admin invite with user_metadata {vantage_role:'client'}
//      (the handle_new_user trigger reads that and creates an org-less 'client'
//      profile — see client-portal.sql for why clients must carry NO org)
//   3. upsert the client_access grant
//
// Requires client-portal.sql to have been run; degrades with a clear error if not.

const { configured, rest, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function siteUrl(event) {
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  return host ? ("https://" + host) : (process.env.URL || "");
}

// GoTrue admin invite (service_role). Returns { user } | { exists } | { error }.
async function inviteUser(email, fullName, redirectTo) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(base + "/auth/v1/invite?redirect_to=" + encodeURIComponent(redirectTo), {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, data: { vantage_role: "client", full_name: fullName || email } })
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data && data.id) return { user: data };
  // 422 = already registered (e.g. two brokers inviting the same person concurrently)
  if (res.status === 422) return { exists: true };
  return { error: (data && (data.msg || data.message || data.error_description)) || ("Invite failed (" + res.status + ")") };
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

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Enter a valid email address." });
  const hsCompanyId = String(body.hsCompanyId || "").trim();
  if (!hsCompanyId) return json(400, { error: "This deal isn't linked to a client company yet." });
  const clientName = String(body.clientName || "").slice(0, 200) || null;
  const fullName = String(body.fullName || "").slice(0, 200) || null;

  // the inviter must be a broker-side user with an org
  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id,role&limit=1");
  const me = (prof.ok && Array.isArray(prof.data) && prof.data[0]) || null;
  if (!me || me.role === "client" || !me.org_id) return json(403, { error: "Only brokers can send portal invites." });

  // does this email already have an account?
  const existing = await rest("profiles?email=eq." + encodeURIComponent(email) + "&select=id,role&limit=1");
  let target = (existing.ok && Array.isArray(existing.data) && existing.data[0]) || null;
  if (target && target.role !== "client") {
    return json(400, { error: "That email belongs to a broker account — it can't be invited as a client." });
  }

  let invited = false;
  if (!target) {
    const inv = await inviteUser(email, fullName, siteUrl(event) + "/portal.html");
    if (inv.error) return json(502, { error: inv.error });
    if (inv.user) {
      invited = true;
      target = { id: inv.user.id, role: "client" };
      // belt & braces: the trigger should have done this, but a client profile must
      // NEVER carry an org or a broker role (org-scoped RLS would open broker data)
      await rest("profiles?id=eq." + encodeURIComponent(target.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ role: "client", org_id: null })
      });
    } else {
      // invite raced with another signup — re-read and re-check the role
      const again = await rest("profiles?email=eq." + encodeURIComponent(email) + "&select=id,role&limit=1");
      target = (again.ok && Array.isArray(again.data) && again.data[0]) || null;
      if (!target) return json(502, { error: "Could not create the client account — try again." });
      if (target.role !== "client") return json(400, { error: "That email belongs to a broker account — it can't be invited as a client." });
    }
  }

  // grant access (idempotent — re-inviting the same person is safe)
  const up = await rest("client_access?on_conflict=user_id,org_id,hs_company_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: target.id, org_id: me.org_id, hs_company_id: hsCompanyId,
      client_name: clientName, email: email, invited_by: user.id, active: true
    })
  });
  if (!up.ok) {
    const hint = /relation .*client_access/.test(up.text || "") ? " (run supabase/client-portal.sql first)" : "";
    return json(500, { error: "Could not save the access grant" + hint + ": " + (up.text || up.status) });
  }

  return json(200, { ok: true, invited: invited, email: email });
};
