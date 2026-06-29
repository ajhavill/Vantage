// Vantage — track (Netlify Function, called by the Client Viewer).
//
// Records lightweight ENGAGEMENT events for a package: an "open" when the client
// unlocks it, and a "view" when they open a building dossier. Caller must prove
// they hold the package (valid slug + passcode) — same gate as get-package — so
// this can't be used to write activity into someone else's package.
//
// Stores a compact per-package aggregate in the "client-activity" blob store.
// It records WHAT was engaged with (opens, per-building view counts, timestamps),
// never who the person is — no names, no addresses, no IPs.

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function hashPass(passcode, salt) { return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, "sha256").toString("hex"); }
function safeEq(a, b) { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); if (ab.length !== bb.length) return false; return crypto.timingSafeEqual(ab, bb); }

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const slug = String(body.slug || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "Not found." });
  const type = body.event === "view" ? "view" : "open";
  const building = (typeof body.building === "string") ? body.building.slice(0, 80) : null;

  // verify the caller holds this package
  let pkg;
  try {
    const pkgs = getStore("client-packages");
    pkg = await pkgs.get(slug, { type: "json" });
  } catch (e) { pkg = null; }
  if (!pkg) return json(404, { error: "Not found." });
  if (!body.passcode || !safeEq(hashPass(body.passcode, pkg.salt), pkg.passcodeHash)) return json(401, { error: "Not authorized." });

  const now = new Date().toISOString();
  try {
    // strong consistency: each event must see the prior one, else rapid
    // read-modify-write updates overwrite each other and counts are lost.
    const store = getStore({ name: "client-activity", consistency: "strong" });
    let a = await store.get(slug, { type: "json" });
    if (!a || typeof a !== "object") a = { slug, opens: 0, views: 0, firstSeen: now, lastSeen: now, buildings: {}, log: [] };
    a.lastSeen = now;
    if (!a.firstSeen) a.firstSeen = now;
    if (type === "open") a.opens = (a.opens || 0) + 1;
    else { a.views = (a.views || 0) + 1; if (building) a.buildings[building] = (a.buildings[building] || 0) + 1; }
    a.log = (a.log || []).concat([{ ts: now, type: type, b: building || undefined }]).slice(-100); // keep last 100
    await store.setJSON(slug, a);
  } catch (e) { /* tracking is best-effort; never fail the client over it */ }

  return json(200, { ok: true });
};
