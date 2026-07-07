// Vantage — portal-get (Netlify Function, called by the tenant portal home).
//
// Returns everything a logged-in CLIENT may see, across every company they've been
// granted (usually one): their deals (summary + what's shared), attached option
// packages, questionnaires, and a documents library — always filtered to what the
// broker marked client_visible (final rounds only), the same rules as the passcode
// viewers. Uses the service_role key; the client's own DB access is deliberately nil.
//
// Broker preview: a broker-side user may pass previewCompanyId to see a company's
// portal exactly as the client would ("view as client") — scoped to their own org.

const sb = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

async function signUrl(storagePath, expiresIn) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const encoded = String(storagePath).split("/").map(encodeURIComponent).join("/");
  try {
    const res = await fetch(base + "/storage/v1/object/sign/deal-files/" + encoded, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: expiresIn || 1800 })
    });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    return (d && d.signedURL) ? base + "/storage/v1" + d.signedURL : null;
  } catch (e) { return null; }
}

const csv = (arr) => arr.map((x) => String(x)).join(",");

// Everything the portal home shows for ONE company grant.
async function companyPayload(orgId, hsCompanyId, clientName) {
  const out = { hs_company_id: hsCompanyId, client_name: clientName, advisor: null, deals: [], packages: [], intakes: [], documents: [] };

  // deals (dead ones stay broker-side)
  const dr = await sb.rest("deals?org_id=eq." + encodeURIComponent(orgId) +
    "&hs_company_id=eq." + encodeURIComponent(hsCompanyId) +
    "&stage=neq.dead&select=id,client_name,client_logo_url,stage,owner_id,created_at,updated_at&order=updated_at.desc");
  const deals = Array.isArray(dr.data) ? dr.data : [];
  if (!out.client_name && deals[0]) out.client_name = deals[0].client_name || null;

  // "Your advisor" — the broker on the client's most recent active deal, so the
  // portal always shows who represents them and how to reach out. Name + email only.
  const ownerId = deals.find((d) => d.owner_id) && deals.find((d) => d.owner_id).owner_id;
  if (ownerId) {
    const ap = await sb.rest("profiles?id=eq." + encodeURIComponent(ownerId) + "&select=full_name,email&limit=1");
    const a = (ap.ok && Array.isArray(ap.data) && ap.data[0]) || null;
    if (a && (a.full_name || a.email)) out.advisor = { name: a.full_name || null, email: a.email || null };
  }

  if (deals.length) {
    const ids = csv(deals.map((d) => d.id));
    const [props, tours, proposals, abstracts] = await Promise.all([
      sb.rest("deal_properties?deal_id=in.(" + ids + ")&client_visible=eq.true&select=deal_id,name"),
      sb.rest("tour_stops?deal_id=in.(" + ids + ")&client_visible=eq.true&status=neq.cancelled" +
        "&select=deal_id,property_id,label,scheduled_at,status&order=scheduled_at.asc.nullslast"),
      sb.rest("proposals?deal_id=in.(" + ids + ")&client_visible=eq.true&select=id,deal_id,title,property_id"),
      sb.rest("lease_abstracts?deal_id=in.(" + ids + ")&client_visible=eq.true&select=deal_id,expiration_date,key_dates")
    ]);
    const byDeal = (rows) => {
      const m = {};
      (Array.isArray(rows.data) ? rows.data : []).forEach((r) => { (m[r.deal_id] = m[r.deal_id] || []).push(r); });
      return m;
    };
    const propsBy = byDeal(props), toursBy = byDeal(tours), proposalsBy = byDeal(proposals), absBy = byDeal(abstracts);

    // final-round count per visible proposal (drafts never counted)
    const visProposals = Array.isArray(proposals.data) ? proposals.data : [];
    let finalByProposal = {};
    if (visProposals.length) {
      const rr = await sb.rest("proposal_rounds?proposal_id=in.(" + csv(visProposals.map((p) => p.id)) + ")" +
        "&status=eq.final&select=proposal_id");
      (Array.isArray(rr.data) ? rr.data : []).forEach((r) => { finalByProposal[r.proposal_id] = true; });
    }

    const now = Date.now();
    out.deals = deals.map((d) => {
      const dTours = toursBy[d.id] || [];
      const upcoming = dTours.filter((t) => t.scheduled_at && new Date(t.scheduled_at).getTime() >= now);
      const dProps = propsBy[d.id] || [];
      const sharedProposals = (proposalsBy[d.id] || []).filter((p) => finalByProposal[p.id]).length;
      const la = (absBy[d.id] || [])[0] || null;
      return {
        id: d.id, stage: d.stage, updated_at: d.updated_at,
        client_logo_url: d.client_logo_url || null,
        buildings: dProps.map((p) => p.name).filter(Boolean).slice(0, 6),
        upcoming_tours: upcoming.slice(0, 3),
        shared_proposals: sharedProposals,
        has_abstract: !!la,
        lease_expiration: la ? la.expiration_date : null
      };
    });

    // documents library: deal-level docs, plus docs on visible proposals — all client_visible
    const visPropIds = visProposals.map((p) => p.id);
    const [dealDocs, propDocs] = await Promise.all([
      sb.rest("documents?deal_id=in.(" + ids + ")&proposal_id=is.null&client_visible=eq.true" +
        "&select=id,deal_id,proposal_id,filename,storage_path,created_at&order=created_at.desc&limit=40"),
      visPropIds.length
        ? sb.rest("documents?proposal_id=in.(" + csv(visPropIds) + ")&client_visible=eq.true" +
            "&select=id,deal_id,proposal_id,filename,storage_path,created_at&order=created_at.desc&limit=40")
        : Promise.resolve({ data: [] })
    ]);
    const propTitle = {}; visProposals.forEach((p) => { propTitle[p.id] = p.title || null; });
    const docRows = [].concat(Array.isArray(dealDocs.data) ? dealDocs.data : [], Array.isArray(propDocs.data) ? propDocs.data : [])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 50);
    // Sign in PARALLEL — serial signing of up to 50 docs × up to 5 companies could
    // blow Netlify's 10s function limit precisely for the most active clients.
    const signed = await Promise.all(docRows.map((doc) => signUrl(doc.storage_path, 1800)));  // 30-min links; refresh for new
    docRows.forEach((doc, i) => {
      if (signed[i]) out.documents.push({
        id: doc.id, deal_id: doc.deal_id, filename: doc.filename, created_at: doc.created_at,
        label: doc.proposal_id ? (propTitle[doc.proposal_id] || "Proposal") : "Deal document", url: signed[i]
      });
    });
  }

  // attached option packages (the "brochure" phase — packages themselves live in Blobs)
  const pk = await sb.rest("portal_package_links?org_id=eq." + encodeURIComponent(orgId) +
    "&hs_company_id=eq." + encodeURIComponent(hsCompanyId) + "&select=slug,label,created_at&order=created_at.desc");
  out.packages = Array.isArray(pk.data) ? pk.data : [];

  // questionnaires
  const iq = await sb.rest("intakes?org_id=eq." + encodeURIComponent(orgId) +
    "&hs_company_id=eq." + encodeURIComponent(hsCompanyId) +
    "&select=slug,status,company_name,created_at,completed_at&order=created_at.desc");
  out.intakes = Array.isArray(iq.data) ? iq.data : [];

  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!sb.configured()) return json(500, { error: "Server not configured." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const user = await sb.userFromToken(String(body.token || ""));
  if (!user) return json(401, { error: "Please sign in again." });

  const prof = await sb.rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id,role,full_name&limit=1");
  const me = (prof.ok && Array.isArray(prof.data) && prof.data[0]) || null;
  if (!me) return json(403, { error: "No profile found for this account." });

  let grants = [], preview = false;
  if (me.role === "client") {
    const g = await sb.rest("client_access?user_id=eq." + encodeURIComponent(user.id) +
      "&active=eq.true&select=org_id,hs_company_id,client_name&order=created_at.asc");
    grants = Array.isArray(g.data) ? g.data : [];
    if (!grants.length) return json(200, { companies: [], user: { email: user.email, name: me.full_name || null } });
  } else {
    // broker "view as client" preview — must name a company, stays inside their org
    const pc = String(body.previewCompanyId || "").trim();
    if (!pc) return json(403, { error: "This is the client portal. Brokers: open it via a deal's Portal sheet to preview." });
    if (!me.org_id) return json(403, { error: "Your profile has no firm." });
    grants = [{ org_id: me.org_id, hs_company_id: pc, client_name: null }];
    preview = true;
  }

  // Most clients have ONE grant; build the (usually 1, max 5) in parallel so a
  // multi-company client doesn't pay the round-trips serially.
  const companies = await Promise.all(
    grants.slice(0, 5).map((g) => companyPayload(g.org_id, g.hs_company_id, g.client_name || null))
  );

  return json(200, {
    preview: preview,
    user: { email: user.email, name: me.full_name || null },
    companies: companies
  });
};
