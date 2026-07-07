// Vantage — deal-track (Netlify Function). Records a client engagement event on the
// passcode-gated deal portal. Called fire-and-forget from deal-client.html. Verifies
// the passcode (same scheme as deal-client-get), then inserts an append-only
// deal_events row via the service_role key. Returns 200 regardless (don't leak info)
// and degrades silently if the deal_events table doesn't exist yet.

const sb = require("./_sb");
const crypto = require("crypto");

const json = (s, o) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const TYPES = ["open", "view", "download"];

function hashPass(p, saltHex) {
  return crypto.pbkdf2Sync(String(p), Buffer.from(String(saltHex), "hex"), 100000, 32, "sha256").toString("hex");
}
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!sb.configured()) return json(200, { ok: false });

  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(200, { ok: false }); }
  const type = String(body.type || "");
  if (TYPES.indexOf(type) < 0) return json(200, { ok: false });

  let dealId = null, who = null;
  if (body.token && body.dealId) {
    // portal path: a logged-in client — the event records WHO engaged, not just that
    // someone with the link did. Broker previews are not recorded.
    if (!/^[0-9a-f-]{36}$/i.test(String(body.dealId))) return json(200, { ok: false });
    const user = await sb.userFromToken(String(body.token));
    if (!user) return json(200, { ok: false });
    const pr = await sb.rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=role&limit=1");
    const me = (pr.ok && Array.isArray(pr.data) && pr.data[0]) || null;
    if (!me || me.role !== "client") return json(200, { ok: true });   // preview: no-op
    const dr = await sb.rest("deals?id=eq." + encodeURIComponent(body.dealId) + "&select=id,org_id,hs_company_id&limit=1");
    const deal = (dr.ok && Array.isArray(dr.data) && dr.data[0]) || null;
    if (!deal || !deal.org_id || !deal.hs_company_id) return json(200, { ok: false });
    const g = await sb.rest("client_access?user_id=eq." + encodeURIComponent(user.id) +
      "&org_id=eq." + encodeURIComponent(deal.org_id) +
      "&hs_company_id=eq." + encodeURIComponent(deal.hs_company_id) + "&active=eq.true&select=id&limit=1");
    if (!(g.ok && Array.isArray(g.data) && g.data[0])) return json(200, { ok: false });
    dealId = deal.id; who = user.email || null;
  } else {
    // original passcode path
    const slug = String(body.slug || "");
    if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(200, { ok: false });

    let deal = null;
    try {
      const r = await sb.rest("deals?slug=eq." + encodeURIComponent(slug) + "&select=id,passcode_hash,salt&limit=1");
      if (r.ok && r.data && r.data[0]) deal = r.data[0];
    } catch (e) { /* leave null */ }
    if (!deal || !deal.passcode_hash || !deal.salt) return json(200, { ok: false });
    if (!body.passcode || !safeEq(hashPass(body.passcode, deal.salt), deal.passcode_hash)) return json(200, { ok: false });
    dealId = deal.id;
  }

  try {
    const extra = body.detail ? String(body.detail).slice(0, 160) : null;
    const detail = who ? (extra ? who + " · " + extra : who) : extra;
    await sb.rest("deal_events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ deal_id: dealId, type: type, detail: detail })
    });
  } catch (e) { /* deal_events table may not exist yet — ignore */ }

  return json(200, { ok: true });
};
