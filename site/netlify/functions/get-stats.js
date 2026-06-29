// Vantage — get-stats (Netlify Function, called by the Cockpit only).
//
// Returns ENGAGEMENT stats for a set of packages the broker created. The Cockpit
// remembers its own package slugs (in the broker's browser) and asks for stats on
// exactly those — there is intentionally NO "list all packages" capability here.
// Gated by BROKER_SECRET so only the broker can read activity.

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
function safeEq(a, b) { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); if (ab.length !== bb.length) return false; return crypto.timingSafeEqual(ab, bb); }

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!process.env.BROKER_SECRET) return json(500, { error: "Server is missing BROKER_SECRET (set it in Netlify env vars)." });
  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  if (!body.brokerSecret || !safeEq(body.brokerSecret, process.env.BROKER_SECRET)) return json(401, { error: "Not authorized." });

  let slugs = Array.isArray(body.slugs) ? body.slugs : [];
  slugs = slugs.filter(function (s) { return /^[A-Za-z0-9]{6,40}$/.test(String(s)); }).slice(0, 300);

  const stats = {};
  try {
    const store = getStore("client-activity");
    for (const slug of slugs) {
      try { stats[slug] = await store.get(slug, { type: "json", consistency: "strong" }); }
      catch (e) { stats[slug] = null; }
    }
  } catch (e) {
    return json(500, { error: "Could not read activity: " + (e && e.message ? e.message : "blob store error") });
  }

  return json(200, { stats });
};
