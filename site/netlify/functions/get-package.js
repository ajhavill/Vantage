// Vantage — get-package (Netlify Function, called by the Client Viewer).
//
// Looks up ONE scoped package by slug and returns it only if the passcode is
// correct. There is intentionally NO way to list packages or buildings. The
// passcode hash + salt are stripped before returning.

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function hashPass(passcode, salt) {
  return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, "sha256").toString("hex");
}
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  connectLambda(event); // wire up Netlify Blobs context for this Lambda-style function

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const slug = String(body.slug || "");
  if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "Link not found." });

  let pkg;
  try {
    const store = getStore("client-packages");
    pkg = await store.get(slug, { type: "json" });
  } catch (e) { pkg = null; }

  if (!pkg) return json(404, { error: "Link not found." });

  if (!body.passcode || !safeEq(hashPass(body.passcode, pkg.salt), pkg.passcodeHash)) {
    return json(401, { error: "Incorrect passcode." });
  }

  // strip secrets before returning
  const pub = Object.assign({}, pkg);
  delete pub.passcodeHash;
  delete pub.salt;
  return json(200, pub);
};
