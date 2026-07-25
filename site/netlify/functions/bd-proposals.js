// Vantage — bd-proposals. Read-only aggregation for BD → Proposals: every
// proposal across every deal in the broker's org, with its negotiation rounds
// and economics, plus the reusable proposal templates.
//
// Andrew's ask: "we need to have all of our proposals in there." Proposals are
// authored per-deal in the Deals module (proposals / proposal_rounds); this
// function is the firm-wide LIBRARY view — search what you've negotiated, pull
// up the terms you won at a building, and reuse the templates that produced them.
// Nothing here writes: editing a proposal still happens on its deal page.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

const sb = require("./_sb");

const okJSON = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const IN = (ids) => "(" + ids.map((i) => '"' + i + '"').join(",") + ")";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };

  const pr = await sb.rest("profiles?id=eq." + user.id + "&select=org_id,role&limit=1");
  const me = (pr.data && pr.data[0]) || {};
  const orgId = me.org_id;
  if (!orgId) return { statusCode: 403, body: "no org" };

  // The org's deals (service role bypasses RLS, so scope explicitly).
  const dr = await sb.rest("deals?org_id=eq." + orgId + "&select=id,client_name,stage,created_at&order=created_at.desc&limit=500");
  const deals = dr.data || [];
  if (!deals.length) return okJSON({ proposals: [], templates: [], deals: 0 });

  const dealById = {}; deals.forEach((d) => { dealById[d.id] = d; });
  const dealIds = deals.map((d) => d.id);

  const [prop, rounds, docs, tpl] = await Promise.all([
    sb.rest("proposals?deal_id=in." + IN(dealIds) + "&select=id,deal_id,title,status,created_at,updated_at&order=updated_at.desc&limit=500"),
    sb.rest("proposal_rounds?deal_id=in." + IN(dealIds) + "&select=id,proposal_id,deal_id,round_no,from_party,summary,size_sf,term_months,rent_basis,base_rent_psf,annual_escalation_pct,free_rent_months,ti_psf,opex_psf,created_at&order=round_no.asc&limit=2000"),
    sb.rest("documents?deal_id=in." + IN(dealIds) + "&select=id,proposal_id,round_id,filename,storage_path,created_at&limit=1000").catch(() => ({ data: [] })),
    sb.rest("proposal_templates?select=id,name,description,body,fields,storage_path,is_shared,updated_at&order=updated_at.desc&limit=100")
  ]);

  const roundsByProposal = {};
  (rounds.data || []).forEach((r) => { (roundsByProposal[r.proposal_id] = roundsByProposal[r.proposal_id] || []).push(r); });
  const docsByProposal = {};
  (docs.data || []).forEach((d) => { if (d.proposal_id) (docsByProposal[d.proposal_id] = docsByProposal[d.proposal_id] || []).push(d); });

  const proposals = (prop.data || []).map((p) => {
    const rs = (roundsByProposal[p.id] || []).slice().sort((a, b) => (a.round_no || 0) - (b.round_no || 0));
    const latest = rs.length ? rs[rs.length - 1] : null;
    const d = dealById[p.deal_id] || {};
    return {
      id: p.id,
      deal_id: p.deal_id,
      client_name: d.client_name || null,
      deal_stage: d.stage || null,
      title: p.title || "Untitled proposal",
      status: p.status,
      created_at: p.created_at,
      updated_at: p.updated_at,
      round_count: rs.length,
      doc_count: (docsByProposal[p.id] || []).length,
      latest: latest ? {
        round_no: latest.round_no, from_party: latest.from_party, summary: latest.summary,
        size_sf: latest.size_sf, term_months: latest.term_months, rent_basis: latest.rent_basis,
        base_rent_psf: latest.base_rent_psf, annual_escalation_pct: latest.annual_escalation_pct,
        free_rent_months: latest.free_rent_months, ti_psf: latest.ti_psf, opex_psf: latest.opex_psf,
        created_at: latest.created_at
      } : null,
      rounds: rs
    };
  });

  return okJSON({
    proposals: proposals,
    templates: (tpl.data || []),
    deals: deals.length
  });
};
