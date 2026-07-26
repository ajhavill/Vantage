// Vantage — deal-ai-draft (Netlify BACKGROUND function).
//
// EXTRACTION, not authorship (Andrew's call 2026-07-25: "the AI must use the
// exact template — exact copy, exact formatting; the only thing it changes is
// what's highlighted"). The broker dictates deal points; Claude extracts ONLY
// the values the letterhead's {{merge tokens}} and the round's terms grid need,
// and this function saves them:
//   * proposal_rounds  — a draft round carrying the economics + a short summary
//   * proposals.details — the letterhead fields (landlord block, address parts,
//     base year, parking, commencement…), merged over what's already saved
// The document itself is NEVER generated or altered by the AI: the broker's
// .docx letterhead is filled deterministically in the browser (docxtemplater),
// so the copy and formatting are byte-identical to the template. Any value the
// broker didn't state comes back null and renders as a BLANK in the document.
//
// Background function: returns 202 immediately, runs past the 10s limit; the
// deal page re-opens itself shortly after to show the new round.
//
// Requires env var ANTHROPIC_API_KEY (+ the existing SUPABASE_URL / SERVICE_ROLE).

const sb = require("./_sb");

const RENT_BASES = ["FSG", "MG", "IG", "NNN", "NN", "N", "GROSS", "ABS", "OTHER"];
const NUMN = { anyOf: [{ type: "number" }, { type: "null" }] };
const INTN = { anyOf: [{ type: "integer" }, { type: "null" }] };
// The structured-output schema may carry at most 16 union-typed ("nullable")
// parameters — past that the API rejects the whole request with "Schemas
// contains too many parameters with union types". The 8 economics fields below
// need real nulls (a number is either known or it isn't), so the 13 letterhead
// details use a plain string with "" as the not-stated sentinel instead: 8
// unions total, comfortably under the limit. The merge step already treats ""
// as absent, so a blank still renders as a blank in the .docx.
const STR = { type: "string" };

const DETAIL_KEYS = [
  "landlord_contact_name", "landlord_company", "landlord_salutation", "landlord_legal_name",
  "tenant_legal_name", "tenant_website",
  "building_address", "suite_number", "building_city", "building_state_zip",
  "commencement_date", "base_year", "parking_spaces"
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    economics: {
      type: "object",
      additionalProperties: false,
      properties: {
        rent_basis: { anyOf: [{ type: "string", enum: RENT_BASES }, { type: "null" }] },
        base_rent_psf: NUMN, opex_psf: NUMN, size_sf: NUMN, term_months: INTN,
        annual_escalation_pct: NUMN, free_rent_months: NUMN, ti_psf: NUMN
      },
      required: ["rent_basis", "base_rent_psf", "opex_psf", "size_sf", "term_months", "annual_escalation_pct", "free_rent_months", "ti_psf"]
    },
    details: {
      type: "object",
      additionalProperties: false,
      properties: DETAIL_KEYS.reduce((o, k) => { o[k] = STR; return o; }, {}),
      required: DETAIL_KEYS
    },
    summary: { type: "string" }
  },
  required: ["economics", "details", "summary"]
};

async function extractWithClaude(system, userText) {
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
      // Same call shape as the previously-working drafter: adaptive thinking is
      // opt-in on Opus 4.8 (omitting it runs with none), and effort/format live
      // together in output_config.
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
  if (!textBlock || !textBlock.text) throw new Error("No extraction returned.");
  return JSON.parse(textBlock.text);
}

// A background function answers 202 before it does any work, so every failure
// below is invisible to the browser. Record each one: bd_job_runs for the
// operator (queryable), and — once we know which proposal it belongs to — a
// draft round whose summary carries the reason, so the broker sees it in the
// deal instead of an empty rounds table.
async function logFail(note, ctx) {
  try {
    await sb.rest("bd_job_runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ job: "deal-ai-draft", ok: false, note: String(note).slice(0, 500), counts: ctx || null })
    });
  } catch (e) { /* logging must never mask the original failure */ }
}
async function failRound(dealId, proposalId, userId, note) {
  await logFail(note, { dealId: dealId, proposalId: proposalId });
  if (!dealId || !proposalId) return;
  let nextNo = 1;
  try {
    const r = await sb.rest("proposal_rounds?proposal_id=eq." + proposalId + "&select=round_no&order=round_no.desc&limit=1");
    if (r.data && r.data[0]) nextNo = (r.data[0].round_no || 0) + 1;
  } catch (e) { /* default 1 */ }
  try {
    await sb.rest("proposal_rounds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        deal_id: dealId, proposal_id: proposalId, round_no: nextNo, from_party: "tenant",
        status: "draft", source: "ai", draft_text: null, created_by: userId,
        summary: "⚠ Couldn't read your deal points — " + String(note).slice(0, 300) + " (delete this round and try again)"
      })
    });
  } catch (e) { /* best-effort */ }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const dealId = String(body.dealId || ""), proposalId = String(body.proposalId || "");

  const user = await sb.userFromToken(body.token);   // broker must be signed in
  if (!user) { await logFail("unauthorized — broker token rejected", { dealId: dealId }); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { await failRound(dealId, proposalId, user.id, "ANTHROPIC_API_KEY is not set on the site"); return { statusCode: 500, body: "no key" }; }

  // defense in depth: service_role bypasses RLS, so verify this broker owns the deal
  let deal = null;
  try {
    const r = await sb.rest("deals?id=eq." + dealId + "&select=id,owner_id,client_name&limit=1");
    deal = r.data && r.data[0];
  } catch (e) { /* leave null */ }
  if (!deal) { await failRound(dealId, proposalId, user.id, "deal " + dealId + " not found"); return { statusCode: 403, body: "forbidden" }; }
  if (deal.owner_id !== user.id) { await failRound(dealId, proposalId, user.id, "this deal belongs to another broker"); return { statusCode: 403, body: "forbidden" }; }

  const system =
    "You are a data-extraction assistant for a commercial real estate proposal. The broker dictated deal points; your ONLY " +
    "job is to pull out the specific values below so they can be merged into a fixed letterhead template. You never write " +
    "prose and you NEVER invent, infer, or estimate a value the broker did not state — anything not explicitly given comes " +
    "back empty (null for economics numbers, an empty string \"\" for details), which renders as an intentionally blank " +
    "space in the document for the broker to complete. Rules: " +
    "term_months is the lease term in months (broker may say years — 5 years = 60). " +
    "base_rent_psf is the dollars per square foot figure exactly as stated — do NOT convert between monthly and annual. " +
    "annual_escalation_pct is the yearly increase percent as a bare number (\"3% bumps\" = 3). " +
    "rent_basis must be one of: " + RENT_BASES.join(", ") + " (FSG for full service gross) or null. " +
    "details values are strings exactly as the broker gave them, or \"\" if the broker did not state them — never guess. " +
    "commencement_date like \"October 1, 2026\" if spoken that way; " +
    "suite_number is just the number/identifier (\"300\"); building_state_zip like \"CA 90401\"; base_year like \"2027\"; " +
    "parking_spaces is the count as a string; landlord_salutation is how the letter greets them (\"Mr. Jones\") if stated. " +
    "summary is 1–2 plain sentences of the key terms for the broker's notes. Respond only with the structured result.";

  const userText =
    "CLIENT (tenant): " + (body.clientName || deal.client_name || "unknown") + "\n" +
    (body.buildingName ? "BUILDING (name): " + body.buildingName + "\n" : "") +
    (body.buildingAddress ? "BUILDING ADDRESS on file: " + body.buildingAddress + "\n" : "") +
    "\nBROKER'S DEAL POINTS (verbatim):\n" + (body.dealPoints || "(none provided)");

  let out;
  try { out = await extractWithClaude(system, userText); }
  catch (e) {
    console.log("ai-draft: extraction failed:", e.message);
    await failRound(dealId, proposalId, user.id, e.message || String(e));
    return { statusCode: 200, body: "extract failed" };
  }

  // next round number for this proposal
  let nextNo = 1;
  try {
    const r = await sb.rest("proposal_rounds?proposal_id=eq." + proposalId + "&select=round_no&order=round_no.desc&limit=1");
    if (r.data && r.data[0]) nextNo = (r.data[0].round_no || 0) + 1;
  } catch (e) { /* default 1 */ }

  const ec = out.economics || {};
  const row = {
    deal_id: dealId, proposal_id: proposalId, round_no: nextNo, from_party: "tenant",
    status: "draft", source: "ai", draft_text: null,
    summary: out.summary || null,
    rent_basis: RENT_BASES.indexOf(ec.rent_basis) >= 0 ? ec.rent_basis : null,
    base_rent_psf: ec.base_rent_psf, opex_psf: ec.opex_psf, size_sf: ec.size_sf,
    term_months: ec.term_months, annual_escalation_pct: ec.annual_escalation_pct,
    free_rent_months: ec.free_rent_months, ti_psf: ec.ti_psf, created_by: user.id
  };
  const ins = await sb.rest("proposal_rounds", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row)
  });
  if (!ins.ok) {
    console.log("ai-draft: round insert failed:", ins.text);
    await logFail("round insert rejected: " + (ins.text || ins.status), { dealId: dealId, proposalId: proposalId });
    return { statusCode: 200, body: "save failed" };
  }

  // merge the extracted letterhead fields over what the proposal already has —
  // extracted non-null values win; existing values survive when nothing new came in
  try {
    const pr = await sb.rest("proposals?id=eq." + proposalId + "&select=details&limit=1");
    const existing = (pr.data && pr.data[0] && pr.data[0].details) || {};
    const merged = Object.assign({}, existing);
    DETAIL_KEYS.forEach((k) => {
      const v = out.details && out.details[k];
      if (v != null && String(v).trim() !== "") merged[k] = String(v).trim();
    });
    await sb.rest("proposals?id=eq." + proposalId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ details: merged })
    });
  } catch (e) { console.log("ai-draft: details merge failed:", e.message); /* round still saved */ }

  console.log("ai-draft: extracted round", nextNo, "for proposal", proposalId);
  return { statusCode: 200, body: JSON.stringify({ ok: true, round_no: nextNo }) };
};

exports.SCHEMA = SCHEMA;          // for tools/ai-draft-schema.test.js
exports.DETAIL_KEYS = DETAIL_KEYS;
