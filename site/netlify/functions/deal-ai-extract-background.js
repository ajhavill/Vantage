// Vantage — deal-ai-extract (Netlify BACKGROUND function).
//
// Reads an uploaded landlord proposal / LOI (PDF) with Claude and extracts the
// deal economics, writing them into the deal as a DRAFT round the broker verifies
// against the source before making it a real round. This is the reverse of
// deal-ai-draft-background: PDF in → structured terms out. Background function
// (name ends "-background"): returns 202 immediately, runs up to 15 min, so the
// ~20-40s Opus read never hits the ~10s sync-function timeout. The broker's page
// polls the deal for the new draft round.
//
// Requires env var ANTHROPIC_API_KEY (+ the existing SUPABASE_URL / SERVICE_ROLE).

const sb = require("./_sb");

const RENT_BASES = ["FSG", "MG", "IG", "NNN", "NN", "N", "GROSS", "ABS", "OTHER"];
const NUMN = { anyOf: [{ type: "number" }, { type: "null" }] };
const INTN = { anyOf: [{ type: "integer" }, { type: "null" }] };
const STRN = { anyOf: [{ type: "string" }, { type: "null" }] };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_proposal: { type: "boolean" },                 // false if the doc isn't a lease proposal/LOI
    from_party: { anyOf: [{ type: "string", enum: ["landlord", "tenant"] }, { type: "null" }] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string" },                      // 1-2 sentences, plain English
    notable: { type: "array", items: { type: "string" } }, // options, renewal, parking, exclusions, etc.
    economics: {
      type: "object",
      additionalProperties: false,
      properties: {
        rent_basis: { anyOf: [{ type: "string", enum: RENT_BASES }, { type: "null" }] },
        rent_basis_label: STRN,
        base_rent_psf: NUMN, opex_psf: NUMN, size_sf: NUMN, term_months: INTN,
        annual_escalation_pct: NUMN, free_rent_months: NUMN, ti_psf: NUMN
      },
      required: ["rent_basis", "rent_basis_label", "base_rent_psf", "opex_psf", "size_sf", "term_months", "annual_escalation_pct", "free_rent_months", "ti_psf"]
    }
  },
  required: ["is_proposal", "from_party", "confidence", "summary", "notable", "economics"]
};

// Pull the file out of Supabase Storage server-side (service_role) → base64.
async function fetchPdfBase64(storagePath) {
  const url = process.env.SUPABASE_URL + "/storage/v1/object/deal-files/" + storagePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!res.ok) throw new Error("storage fetch " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

async function extractWithClaude(pdfB64, filename) {
  const system =
    "You are an expert commercial real estate tenant-rep analyst at Havill & Co. You read a landlord's lease " +
    "PROPOSAL or Letter of Intent (LOI) and extract its economic terms precisely for the broker. Extract ONLY figures " +
    "actually stated in the document — never infer or invent a number; if a term isn't stated, return null for it. " +
    "Normalize the rent structure to one of: " + RENT_BASES.join(", ") + " (FSG = full-service gross / base-year stop; " +
    "MG = modified gross; NNN = triple net; use OTHER + rent_basis_label only if none fit). base_rent_psf and opex_psf " +
    "are annual $/SF. term_months in months. free_rent_months in months. ti_psf is the tenant-improvement allowance in " +
    "$/SF. Set from_party to 'landlord' for a landlord/listing-side proposal (the usual case) or 'tenant' if it is the " +
    "tenant's own offer. Put anything economically important that doesn't fit the structured fields — renewal/expansion " +
    "options, parking, opex exclusions, holdover, contingencies — into `notable` as short phrases. `summary` is 1-2 " +
    "plain-English sentences. If the document is not actually a lease proposal/LOI, set is_proposal=false and confidence " +
    "'low'. Respond only with the structured result.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: system,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 }, title: filename || "proposal.pdf" },
          { type: "text", text: "Extract the economic terms from this proposal per your instructions." }
        ]
      }]
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ("Anthropic HTTP " + res.status));
  if (data.stop_reason === "refusal") throw new Error("The model's safety system declined this request.");
  const textBlock = (data.content || []).filter((b) => b.type === "text")[0];
  if (!textBlock || !textBlock.text) throw new Error("No extraction returned.");
  return JSON.parse(textBlock.text);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);   // broker must be signed in
  if (!user) { console.log("ai-extract: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("ai-extract: ANTHROPIC_API_KEY not set"); return { statusCode: 500, body: "no key" }; }

  const dealId = String(body.dealId || ""), proposalId = String(body.proposalId || ""), storagePath = String(body.storagePath || "");
  if (!dealId || !proposalId || !storagePath) return { statusCode: 400, body: "missing fields" };
  // storage RLS scopes deal-files by first path folder = deal_id; enforce it here too
  if (storagePath.split("/")[0] !== dealId) { console.log("ai-extract: path/deal mismatch"); return { statusCode: 400, body: "bad path" }; }

  // defense in depth: service_role bypasses RLS, so verify this broker owns the deal
  let deal = null;
  try {
    const r = await sb.rest("deals?id=eq." + dealId + "&select=id,owner_id&limit=1");
    deal = r.data && r.data[0];
  } catch (e) { /* leave null */ }
  if (!deal || deal.owner_id !== user.id) { console.log("ai-extract: deal not owned by user"); return { statusCode: 403, body: "forbidden" }; }

  let pdfB64;
  try { pdfB64 = await fetchPdfBase64(storagePath); }
  catch (e) { console.log("ai-extract: pdf fetch failed:", e.message); return { statusCode: 200, body: "pdf fetch failed" }; }

  let ex;
  try { ex = await extractWithClaude(pdfB64, body.filename); }
  catch (e) { console.log("ai-extract: extraction failed:", e.message); return { statusCode: 200, body: "extract failed" }; }

  // next round number for this proposal
  let nextNo = 1;
  try {
    const r = await sb.rest("proposal_rounds?proposal_id=eq." + proposalId + "&select=round_no&order=round_no.desc&limit=1");
    if (r.data && r.data[0]) nextNo = (r.data[0].round_no || 0) + 1;
  } catch (e) { /* default 1 */ }

  const ec = ex.economics || {};
  const conf = ex.confidence || "low";
  // The extraction summary + caveats live in the round's Notes, so the review sheet
  // shows a normal (pre-filled) round — the broker checks it against the attached PDF.
  const noteBits = [];
  noteBits.push("AI-read from " + (body.filename || "PDF") + " (" + conf + " confidence)" + (ex.is_proposal === false ? " — may not be a proposal" : "") + ".");
  if (ex.summary) noteBits.push(ex.summary);
  if (ex.notable && ex.notable.length) noteBits.push("Notable: " + ex.notable.join("; ") + ".");
  noteBits.push("Verify against the source PDF before marking final.");

  const basis = RENT_BASES.indexOf(ec.rent_basis) >= 0 ? ec.rent_basis : null;
  const row = {
    deal_id: dealId, proposal_id: proposalId, round_no: nextNo,
    from_party: ex.from_party === "tenant" ? "tenant" : "landlord",
    status: "draft", source: "ai",
    rent_basis: basis,
    rent_basis_label: basis === "OTHER" ? (ec.rent_basis_label || null) : null,
    base_rent_psf: ec.base_rent_psf, opex_psf: ec.opex_psf, size_sf: ec.size_sf,
    term_months: ec.term_months, annual_escalation_pct: ec.annual_escalation_pct,
    free_rent_months: ec.free_rent_months, ti_psf: ec.ti_psf,
    summary: noteBits.join(" "), created_by: user.id
  };
  try {
    await sb.rest("proposal_rounds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(row)
    });
  } catch (e) { console.log("ai-extract: insert failed:", e.message); return { statusCode: 200, body: "save failed" }; }

  console.log("ai-extract: wrote draft round", nextNo, "for proposal", proposalId, "conf", conf);
  return { statusCode: 200, body: JSON.stringify({ ok: true, round_no: nextNo }) };
};
