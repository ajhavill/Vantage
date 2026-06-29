// Vantage — create-package (Netlify Function, called by the Cockpit only).
//
// Stores a SCOPED client package in Netlify Blobs and returns a shareable link.
// The Cockpit sends the full data objects for ONLY the chosen buildings — never
// the whole market. Gated by BROKER_SECRET so randoms can't create packages.
// The passcode is stored HASHED (PBKDF2 + per-package salt), never in plaintext.

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function slugGen() {
  const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const b = crypto.randomBytes(14);
  let s = ""; for (let i = 0; i < 14; i++) s += a[b[i] % a.length];
  return s;
}
function hashPass(passcode, salt) {
  return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, "sha256").toString("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!process.env.BROKER_SECRET) return json(500, { error: "Server is missing BROKER_SECRET (set it in Netlify env vars)." });
  connectLambda(event); // wire up Netlify Blobs context for this Lambda-style function

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  if (!body.brokerSecret || body.brokerSecret !== process.env.BROKER_SECRET) return json(401, { error: "Not authorized." });
  if (!Array.isArray(body.buildings) || !body.buildings.length) return json(400, { error: "No buildings selected." });
  if (body.buildings.length > 20) return json(400, { error: "Too many buildings (max 20 per package)." });
  if (!body.passcode || String(body.passcode).length < 3) return json(400, { error: "A passcode of at least 3 characters is required." });

  const salt = crypto.randomBytes(16).toString("hex");
  const slug = slugGen();
  const pkg = {
    v: 1,
    preset: "full", // only "full" implemented; field reserved for leaner presets later
    slug,
    createdAt: new Date().toISOString(),
    client: { name: String(body.clientName || "Client").slice(0, 120), logoUrl: String(body.clientLogoUrl || "").slice(0, 600) },
    broker: { name: "Havill & Co." },
    passcodeHash: hashPass(body.passcode, salt),
    salt,
    buildings: body.buildings,
    categories: Array.isArray(body.categories) ? body.categories : [],
    industries: Array.isArray(body.industries) ? body.industries : [],
    bakedCommute: (body.bakedCommute && typeof body.bakedCommute === "object") ? body.bakedCommute : null
  };

  try {
    const store = getStore("client-packages");
    await store.setJSON(slug, pkg);
  } catch (e) {
    return json(500, { error: "Could not save the package: " + (e && e.message ? e.message : "blob store error") });
  }

  // Build the link from the domain the broker is actually on (survives site
  // renames and custom domains without needing a redeploy); fall back to env.
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  const site = host ? ("https://" + host) : (process.env.URL || "");
  return json(200, { slug, url: site + "/client.html?c=" + slug });
};
