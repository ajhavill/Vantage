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
  const slug = String(body.slug || ""), type = String(body.type || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug) || TYPES.indexOf(type) < 0) return json(200, { ok: false });

  let deal = null;
  try {
    const r = await sb.rest("deals?slug=eq." + encodeURIComponent(slug) + "&select=id,passcode_hash,salt&limit=1");
    if (r.ok && r.data && r.data[0]) deal = r.data[0];
  } catch (e) { /* leave null */ }
  if (!deal || !deal.passcode_hash || !deal.salt) return json(200, { ok: false });
  if (!body.passcode || !safeEq(hashPass(body.passcode, deal.salt), deal.passcode_hash)) return json(200, { ok: false });

  try {
    await sb.rest("deal_events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ deal_id: deal.id, type: type, detail: body.detail ? String(body.detail).slice(0, 200) : null })
    });
  } catch (e) { /* deal_events table may not exist yet — ignore */ }

  return json(200, { ok: true });
};
