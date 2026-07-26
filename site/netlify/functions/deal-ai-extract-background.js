// Vantage — deal-ai-extract (Netlify BACKGROUND function).
//
// Reads a landlord's proposal / LOI / counter and extracts the deal economics,
// writing them into the deal as a DRAFT round the broker verifies against the
// source before making it a real round. The reverse of deal-ai-draft-background:
// their document in → structured terms out.
//
// TWO INPUT SHAPES (landlord responses don't always arrive as a PDF):
//   * storagePath — a PDF already uploaded to deal-files; fetched server-side
//     with the service_role key and handed to Claude as a native document block.
//   * text        — plain text: a pasted email body, or a .docx the browser
//     already flattened (Word can't be sent as a document block, and converting
//     it in the browser avoids a server-side dependency).
// Exactly one is required; PDF wins if both arrive, since the real document
// carries layout that flattened text loses.
//
// Background function (name ends "-background"): returns 202 immediately and
// runs up to 15 min, so the ~20-40s Opus read never hits the ~10s sync timeout.
// That also means the browser NEVER sees a failure here — so every failure path
// below is recorded twice: bd_job_runs for the operator, and a draft round whose
// summary carries the reason, so the broker sees it in the deal instead of
// waiting on a round that is never coming.
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

async function extractWithClaude(src, filename) {
  const system =
    "You are an expert commercial real estate tenant-rep analyst at Havill & Co. You read a landlord's lease " +
    "PROPOSAL, Letter of Intent (LOI), or counter-offer and extract its economic terms precisely for the broker. " +
    "The material may be a PDF, or plain text pasted from an email or converted from a Word document — in the text " +
    "case, layout and tables are flattened, so read carefully and do not mistake a stray number for a term. " +
    "Extract ONLY figures " +
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
        content: (src.pdfB64
          ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: src.pdfB64 }, title: filename || "proposal.pdf" }]
          : [{ type: "text", text: "LANDLORD RESPONSE" + (filename ? " (" + filename + ")" : "") + ":\n\n" + src.text }]
        ).concat([{ type: "text", text: "Extract the economic terms from this proposal per your instructions." }])
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

// A background function answers 202 before doing any work, so nothing below is
// visible to the browser. Record every failure: bd_job_runs for the operator
// (queryable), and — once the proposal is known — a draft round whose summary
// carries the reason. Mirrors deal-ai-draft-background; before this, a failed
// read left the broker watching for a round that would never arrive.
async function logFail(note, ctx) {
  try {
    await sb.rest("bd_job_runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ job: "deal-ai-extract", ok: false, note: String(note).slice(0, 500), counts: ctx || null })
    });
  } catch (e) { /* logging must never mask the original failure */ }
}
async function nextRoundNo(proposalId) {
  try {
    const r = await sb.rest("proposal_rounds?proposal_id=eq." + proposalId + "&select=round_no&order=round_no.desc&limit=1");
    if (r.data && r.data[0]) return (r.data[0].round_no || 0) + 1;
  } catch (e) { /* fall through */ }
  return 1;
}
async function failRound(dealId, proposalId, userId, note) {
  await logFail(note, { dealId: dealId, proposalId: proposalId });
  if (!dealId || !proposalId) return;
  try {
    await sb.rest("proposal_rounds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        deal_id: dealId, proposal_id: proposalId, round_no: await nextRoundNo(proposalId),
        from_party: "landlord", status: "draft", source: "ai", created_by: userId,
        summary: "⚠ Couldn't read the landlord's response — " + String(note).slice(0, 300) + " (delete this round and try again)"
      })
    });
  } catch (e) { /* best-effort */ }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const dealId = String(body.dealId || ""), proposalId = String(body.proposalId || "");
  const storagePath = String(body.storagePath || ""), pastedText = String(body.text || "").trim();

  const user = await sb.userFromToken(body.token);   // broker must be signed in
  if (!user) { await logFail("unauthorized — broker token rejected", { dealId: dealId }); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { await failRound(dealId, proposalId, user.id, "ANTHROPIC_API_KEY is not set on the site"); return { statusCode: 500, body: "no key" }; }

  if (!dealId || !proposalId) return { statusCode: 400, body: "missing fields" };
  if (!storagePath && !pastedText) { await failRound(dealId, proposalId, user.id, "nothing to read — no file and no text"); return { statusCode: 400, body: "missing source" }; }
  // Guard against a near-empty paste burning an Opus call on nothing.
  if (!storagePath && pastedText.length < 40) { await failRound(dealId, proposalId, user.id, "the pasted text was too short to read"); return { statusCode: 400, body: "text too short" }; }
  // storage RLS scopes deal-files by first path folder = deal_id; enforce it here too
  if (storagePath && storagePath.split("/")[0] !== dealId) { await failRound(dealId, proposalId, user.id, "upload path did not match this deal"); return { statusCode: 400, body: "bad path" }; }

  // defense in depth: service_role bypasses RLS, so verify this broker owns the deal
  let deal = null;
  try {
    const r = await sb.rest("deals?id=eq." + dealId + "&select=id,owner_id&limit=1");
    deal = r.data && r.data[0];
  } catch (e) { /* leave null */ }
  if (!deal) { await failRound(dealId, proposalId, user.id, "deal " + dealId + " not found"); return { statusCode: 403, body: "forbidden" }; }
  if (deal.owner_id !== user.id) { await failRound(dealId, proposalId, user.id, "this deal belongs to another broker"); return { statusCode: 403, body: "forbidden" }; }

  // PDF wins when both are present — the real document keeps layout that a
  // browser-flattened .docx loses.
  let src;
  if (storagePath) {
    try { src = { pdfB64: await fetchPdfBase64(storagePath) }; }
    catch (e) {
      console.log("ai-extract: pdf fetch failed:", e.message);
      await failRound(dealId, proposalId, user.id, "couldn't read the uploaded file back from storage (" + e.message + ")");
      return { statusCode: 200, body: "pdf fetch failed" };
    }
  } else {
    src = { text: pastedText };
  }

  let ex;
  try { ex = await extractWithClaude(src, body.filename); }
  catch (e) {
    console.log("ai-extract: extraction failed:", e.message);
    await failRound(dealId, proposalId, user.id, e.message || String(e));
    return { statusCode: 200, body: "extract failed" };
  }

  const nextNo = await nextRoundNo(proposalId);
  const ec = ex.economics || {};
  const conf = ex.confidence || "low";
  // The extraction summary + caveats live in the round's Notes as BULLETS, one per
  // line (Andrew's call: scannable, not a wall of text). Each notable term gets its
  // own bullet. The broker checks the pre-filled round against the attached PDF.
  const srcLabel = body.filename || (src.text ? "pasted text" : "PDF");
  const noteBits = [];
  noteBits.push("• AI-read from " + srcLabel + " (" + conf + " confidence)" + (ex.is_proposal === false ? " — may not be a proposal" : ""));
  if (ex.summary) noteBits.push("• " + ex.summary);
  (ex.notable || []).forEach((n) => { if (n) noteBits.push("• " + String(n)); });
  noteBits.push("• Verify against the " + (src.text ? "original message" : "source PDF") + " before marking final.");

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
    summary: noteBits.join("\n"), created_by: user.id
  };
  // sb.rest RESOLVES on a non-2xx PostgREST reply — it never throws — so a
  // try/catch here would silently swallow a rejected insert. Check ins.ok.
  const ins = await sb.rest("proposal_rounds", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row)
  });
  if (!ins.ok) {
    console.log("ai-extract: round insert failed:", ins.text);
    await logFail("round insert rejected: " + (ins.text || ins.status), { dealId: dealId, proposalId: proposalId });
    return { statusCode: 200, body: "save failed" };
  }

  console.log("ai-extract: wrote draft round", nextNo, "for proposal", proposalId, "conf", conf);
  return { statusCode: 200, body: JSON.stringify({ ok: true, round_no: nextNo }) };
};
