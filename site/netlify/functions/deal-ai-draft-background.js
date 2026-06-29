// Vantage — deal-ai-draft (Netlify BACKGROUND function).
//
// Drafts a tenant-side lease proposal with Claude from the broker's template +
// dictated/typed deal points, then writes it into the deal as a DRAFT round for
// the broker to review. Background function (name ends in "-background"): returns
// 202 immediately and runs up to 15 min, so the ~20-40s Opus draft never hits the
// normal 10s function timeout. The broker's page polls the deal for the new draft.
//
// Requires env var ANTHROPIC_API_KEY (+ the existing SUPABASE_URL / SERVICE_ROLE).

const sb = require("./_sb");

const RENT_BASES = ["FSG", "MG", "IG", "NNN", "NN", "N", "GROSS", "ABS", "OTHER"];
const NUMN = { anyOf: [{ type: "number" }, { type: "null" }] };
const INTN = { anyOf: [{ type: "integer" }, { type: "null" }] };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposal_markdown: { type: "string" },
    economics: {
      type: "object",
      additionalProperties: false,
      properties: {
        rent_basis: { anyOf: [{ type: "string", enum: RENT_BASES }, { type: "null" }] },
        base_rent_psf: NUMN, opex_psf: NUMN, size_sf: NUMN, term_months: INTN,
        annual_escalation_pct: NUMN, free_rent_months: NUMN, ti_psf: NUMN
      },
      required: ["rent_basis", "base_rent_psf", "opex_psf", "size_sf", "term_months", "annual_escalation_pct", "free_rent_months", "ti_psf"]
    }
  },
  required: ["proposal_markdown", "economics"]
};

async function draftWithClaude(system, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: system,
      messages: [{ role: "user", content: userText }]
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ("Anthropic HTTP " + res.status));
  if (data.stop_reason === "refusal") throw new Error("The model's safety system declined this request.");
  const textBlock = (data.content || []).filter((b) => b.type === "text")[0];
  if (!textBlock || !textBlock.text) throw new Error("No draft text returned.");
  return JSON.parse(textBlock.text);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);   // broker must be signed in
  if (!user) { console.log("ai-draft: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("ai-draft: ANTHROPIC_API_KEY not set"); return { statusCode: 500, body: "no key" }; }

  const dealId = String(body.dealId || ""), proposalId = String(body.proposalId || "");

  // defense in depth: service_role bypasses RLS, so verify this broker owns the deal
  let deal = null;
  try {
    const r = await sb.rest("deals?id=eq." + dealId + "&select=id,owner_id,client_name&limit=1");
    deal = r.data && r.data[0];
  } catch (e) { /* leave null */ }
  if (!deal || deal.owner_id !== user.id) { console.log("ai-draft: deal not owned by user"); return { statusCode: 403, body: "forbidden" }; }

  const system =
    "You are an expert commercial real estate broker at Havill & Co. drafting a TENANT-SIDE lease proposal for the " +
    "broker to review before it is sent to their client. Write in a professional, confident, client-ready tone. Use the " +
    "broker's template as the structure and style guide and fill it with the specific deal points provided. Reflect the " +
    "economic terms the broker gives accurately. Do NOT invent hard numbers that were not provided — where a needed figure " +
    "is unknown, write a clearly marked [TBD]. Return the proposal body as clean markdown, plus a structured summary of the " +
    "key economics. rent_basis must be one of: " + RENT_BASES.join(", ") + " (or null if unclear). Respond only with the " +
    "structured result — no preamble.";
  const userText =
    "CLIENT: " + (body.clientName || deal.client_name || "the client") + "\n" +
    (body.buildingName ? "BUILDING: " + body.buildingName + "\n" : "") +
    "\nBROKER'S TEMPLATE:\n" + (body.templateBody || "(no template provided — use a standard, professional lease-proposal structure)") +
    "\n\nDEAL POINTS (what the broker said about this deal):\n" + (body.dealPoints || "(none provided)");

  let draft;
  try { draft = await draftWithClaude(system, userText); }
  catch (e) { console.log("ai-draft: generation failed:", e.message); return { statusCode: 200, body: "draft failed" }; }

  // next round number for this proposal
  let nextNo = 1;
  try {
    const r = await sb.rest("proposal_rounds?proposal_id=eq." + proposalId + "&select=round_no&order=round_no.desc&limit=1");
    if (r.data && r.data[0]) nextNo = (r.data[0].round_no || 0) + 1;
  } catch (e) { /* default 1 */ }

  const ec = draft.economics || {};
  const row = {
    deal_id: dealId, proposal_id: proposalId, round_no: nextNo, from_party: "tenant",
    status: "draft", source: "ai", draft_text: draft.proposal_markdown || null,
    rent_basis: RENT_BASES.indexOf(ec.rent_basis) >= 0 ? ec.rent_basis : null,
    base_rent_psf: ec.base_rent_psf, opex_psf: ec.opex_psf, size_sf: ec.size_sf,
    term_months: ec.term_months, annual_escalation_pct: ec.annual_escalation_pct,
    free_rent_months: ec.free_rent_months, ti_psf: ec.ti_psf, created_by: user.id
  };
  try {
    await sb.rest("proposal_rounds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(row)
    });
  } catch (e) { console.log("ai-draft: insert failed:", e.message); return { statusCode: 200, body: "save failed" }; }

  console.log("ai-draft: wrote draft round", nextNo, "for proposal", proposalId);
  return { statusCode: 200, body: JSON.stringify({ ok: true, round_no: nextNo }) };
};
