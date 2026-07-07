// Vantage — deal-client-get (Netlify Function, called by the client Deal Viewer).
//
// Looks up ONE deal by slug and returns it only if the passcode is correct, scoped
// to what the broker chose to share: only client_visible buildings + proposals, and
// only FINAL rounds (drafts never leave the broker side). Uses the Supabase
// service_role key (server-only) to bypass RLS after the passcode check. There is no
// way to list deals — the unguessable slug + passcode is the only entry point.

const sb = require("./_sb");
const crypto = require("crypto");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

// Match the broker page's Web-Crypto PBKDF2: passcode + raw salt bytes (stored hex),
// 100k iterations, SHA-256, 32-byte output, hex.
function hashPass(passcode, saltHex) {
  return crypto.pbkdf2Sync(String(passcode), Buffer.from(String(saltHex), "hex"), 100000, 32, "sha256").toString("hex");
}
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Mint a short-lived signed download URL for a private deal-files object (service_role).
async function signUrl(storagePath, expiresIn) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const encoded = String(storagePath).split("/").map(encodeURIComponent).join("/");
  try {
    const res = await fetch(base + "/storage/v1/object/sign/deal-files/" + encoded, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: expiresIn || 600 })
    });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    return (d && d.signedURL) ? base + "/storage/v1" + d.signedURL : null;
  } catch (e) { return null; }
}

const ROUND_COLS = "id,proposal_id,round_no,from_party,rent_basis,rent_basis_label," +
  "base_rent_psf,opex_psf,size_sf,term_months,annual_escalation_pct,free_rent_months,ti_psf,summary";

// Portal path: a logged-in client (or a broker previewing) opens a deal by id with
// their Supabase token instead of a passcode. Clients must hold an active
// client_access grant matching the deal's org + company; brokers must own the deal
// or be in its org. Returns the deal row on success, null on any failure.
async function dealFromToken(dealId, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(dealId))) return null;
  const user = await sb.userFromToken(token);
  if (!user) return null;
  const pr = await sb.rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id,role&limit=1");
  const me = (pr.ok && Array.isArray(pr.data) && pr.data[0]) || null;
  if (!me) return null;
  const dr = await sb.rest("deals?id=eq." + encodeURIComponent(dealId) + "&select=*&limit=1");
  const deal = (dr.ok && Array.isArray(dr.data) && dr.data[0]) || null;
  if (!deal) return null;
  if (me.role === "client") {
    if (!deal.hs_company_id || !deal.org_id) return null;
    const g = await sb.rest("client_access?user_id=eq." + encodeURIComponent(user.id) +
      "&org_id=eq." + encodeURIComponent(deal.org_id) +
      "&hs_company_id=eq." + encodeURIComponent(deal.hs_company_id) + "&active=eq.true&select=id&limit=1");
    return (g.ok && Array.isArray(g.data) && g.data[0]) ? deal : null;
  }
  // broker preview — own deal or same firm
  if (deal.owner_id === user.id || (me.org_id && deal.org_id === me.org_id)) return deal;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!sb.configured()) return json(500, { error: "Server not configured." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  let deal = null;
  if (body.token && body.dealId) {
    // logged-in portal path (client grant or broker preview)
    deal = await dealFromToken(body.dealId, String(body.token));
    if (!deal) return json(401, { error: "You don't have access to this deal — please sign in to the portal again." });
  } else {
    // original passcode path (no login)
    const slug = String(body.slug || "");
    if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return json(404, { error: "Link not found." });

    try {
      const r = await sb.rest("deals?slug=eq." + encodeURIComponent(slug) + "&select=*&limit=1");
      if (r.ok && r.data && r.data[0]) deal = r.data[0];
    } catch (e) { deal = null; }

    if (!deal || !deal.passcode_hash || !deal.salt) return json(404, { error: "Link not found." });

    if (!body.passcode || !safeEq(hashPass(body.passcode, deal.salt), deal.passcode_hash)) {
      return json(401, { error: "Incorrect passcode." });
    }
  }

  const id = deal.id;
  // visible buildings + visible proposals
  const props = (await sb.rest("deal_properties?deal_id=eq." + id + "&client_visible=eq.true" +
    "&select=id,name,address,status,sort_order&order=sort_order")).data || [];
  const proposals = (await sb.rest("proposals?deal_id=eq." + id + "&client_visible=eq.true" +
    "&select=id,title,property_id,status&order=created_at")).data || [];
  const tours = (await sb.rest("tour_stops?deal_id=eq." + id + "&client_visible=eq.true" +
    "&select=id,property_id,label,scheduled_at,status,notes&order=scheduled_at.asc.nullslast")).data || [];

  const abstractRows = (await sb.rest("lease_abstracts?deal_id=eq." + id + "&client_visible=eq.true" +
    "&select=tenant_name,landlord_name,premises,size_sf,commencement_date,expiration_date,base_rent_psf,escalations,options,security_deposit,key_dates&order=created_at&limit=1")).data || [];
  const lease_abstract = abstractRows[0] || null;

  // final rounds + client-visible documents for those visible proposals only
  let rounds = [], documents = [];
  const ids = proposals.map((p) => p.id);
  if (ids.length) {
    const r = await sb.rest("proposal_rounds?proposal_id=in.(" + ids.join(",") + ")&status=eq.final" +
      "&select=" + ROUND_COLS + "&order=round_no");
    rounds = r.data || [];

    const dr = await sb.rest("documents?proposal_id=in.(" + ids.join(",") + ")&client_visible=eq.true" +
      "&select=id,proposal_id,filename,storage_path&order=created_at");
    const docRows = dr.data || [];
    for (const doc of docRows) {
      const url = await signUrl(doc.storage_path, 600);   // 10-minute link
      if (url) documents.push({ id: doc.id, proposal_id: doc.proposal_id, filename: doc.filename, url: url });
    }
  }

  // client-visible deal-level / lease documents (not tied to a proposal — e.g. the signed lease)
  const ldr = await sb.rest("documents?deal_id=eq." + id + "&proposal_id=is.null&client_visible=eq.true" +
    "&select=id,proposal_id,filename,storage_path&order=created_at");
  for (const doc of (ldr.data || [])) {
    const url = await signUrl(doc.storage_path, 600);
    if (url) documents.push({ id: doc.id, proposal_id: null, filename: doc.filename, url: url });
  }

  return json(200, {
    client_name: deal.client_name || null,
    client_logo_url: deal.client_logo_url || null,
    stage: deal.stage,
    properties: props,
    proposals: proposals,
    rounds: rounds,
    documents: documents,
    tours: tours,
    lease_abstract: lease_abstract
  });
};
