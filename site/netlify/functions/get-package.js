// Vantage — get-package (Netlify Function, called by the Client Viewer).
//
// Looks up ONE scoped package by slug and returns it only if the caller proves
// access: either the passcode (original no-login share) or a logged-in portal
// session whose company the package is attached to. There is intentionally NO way
// to list packages or buildings. The passcode hash + salt are stripped before
// returning.

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");
const sb = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function hashPass(passcode, salt) {
  return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, "sha256").toString("hex");
}
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Portal path: a logged-in client may open a package WITHOUT the passcode if their
// broker attached it to their company (portal_package_links) and they hold an
// active grant for that company. Broker-side users may open any package attached
// within their org (that's the "view as client" preview). True only when proven.
async function tokenMayOpen(slug, token) {
  if (!sb.configured()) return false;
  const user = await sb.userFromToken(token);
  if (!user) return false;
  const pr = await sb.rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id,role&limit=1");
  const me = (pr.ok && Array.isArray(pr.data) && pr.data[0]) || null;
  if (!me) return false;
  if (me.role === "client") {
    const g = await sb.rest("client_access?user_id=eq." + encodeURIComponent(user.id) +
      "&active=eq.true&select=org_id,hs_company_id");
    const grants = (g.ok && Array.isArray(g.data)) ? g.data : [];
    for (const gr of grants) {
      const l = await sb.rest("portal_package_links?org_id=eq." + encodeURIComponent(gr.org_id) +
        "&hs_company_id=eq." + encodeURIComponent(gr.hs_company_id) +
        "&slug=eq." + encodeURIComponent(slug) + "&select=id&limit=1");
      if (l.ok && Array.isArray(l.data) && l.data[0]) return true;
    }
    return false;
  }
  if (!me.org_id) return false;
  const l = await sb.rest("portal_package_links?org_id=eq." + encodeURIComponent(me.org_id) +
    "&slug=eq." + encodeURIComponent(slug) + "&select=id&limit=1");
  return !!(l.ok && Array.isArray(l.data) && l.data[0]);
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

  if (body.token && !body.passcode) {
    // logged-in portal path
    const ok = await tokenMayOpen(slug, String(body.token));
    if (!ok) return json(401, { error: "You don't have access to this package — please sign in to the portal again." });
  } else if (!body.passcode || !safeEq(hashPass(body.passcode, pkg.salt), pkg.passcodeHash)) {
    return json(401, { error: "Incorrect passcode." });
  }

  // strip secrets before returning
  const pub = Object.assign({}, pkg);
  delete pub.passcodeHash;
  delete pub.salt;
  return json(200, pub);
};
