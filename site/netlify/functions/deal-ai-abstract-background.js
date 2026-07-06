// Vantage — deal-ai-abstract (Netlify BACKGROUND function).
//
// Reads an executed lease (PDF) with Claude and produces (a) the lease-abstract
// key terms + critical dates and (b) a TENANT-SIDE risk review flagging clauses
// worth a second look (relocation, opex exclusions, restoration/make-good, missing
// renewal language, personal guaranty, holdover, etc.). Background function (name
// ends "-background"): 202 immediately, up to 15 min.
//
// SAFETY: never clobbers a broker's manually-entered abstract. If an abstract row
// already exists for the deal, only its `data.__ai` is updated (the review +
// suggestions); the broker's top-level fields are untouched. If none exists, a new
// abstract is created pre-filled from the extraction for the broker to verify.
//
// Requires env var ANTHROPIC_API_KEY (+ the existing SUPABASE_URL / SERVICE_ROLE).

const sb = require("./_sb");

const NUMN = { anyOf: [{ type: "number" }, { type: "null" }] };
const STRN = { anyOf: [{ type: "string" }, { type: "null" }] };
const DATEN = { anyOf: [{ type: "string" }, { type: "null" }] };  // ISO yyyy-mm-dd or null
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_lease: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    abstract: {
      type: "object",
      additionalProperties: false,
      properties: {
        tenant_name: STRN, landlord_name: STRN, premises: STRN, size_sf: NUMN,
        commencement_date: DATEN, expiration_date: DATEN, base_rent_psf: NUMN,
        security_deposit: NUMN, escalations: STRN, options: STRN
      },
      required: ["tenant_name", "landlord_name", "premises", "size_sf", "commencement_date", "expiration_date", "base_rent_psf", "security_deposit", "escalations", "options"]
    },
    key_dates: {
      type: "array",
      items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, date: DATEN }, required: ["label", "date"] }
    },
    risk_review: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { severity: { type: "string", enum: ["high", "medium", "low"] }, issue: { type: "string" } },
        required: ["severity", "issue"]
      }
    }
  },
  required: ["is_lease", "confidence", "abstract", "key_dates", "risk_review"]
};

async function fetchPdfBase64(storagePath) {
  const url = process.env.SUPABASE_URL + "/storage/v1/object/deal-files/" + storagePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY } });
  if (!res.ok) throw new Error("storage fetch " + res.status);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

async function abstractWithClaude(pdfB64, filename) {
  const system =
    "You are an expert commercial real estate tenant-rep attorney's analyst at Havill & Co. reviewing an EXECUTED " +
    "office lease on behalf of the TENANT. Do two things. (1) Abstract the key business terms exactly as written — never " +
    "infer a figure that isn't stated; use null for anything not found. Dates as ISO yyyy-mm-dd. size_sf and base_rent_psf " +
    "numeric ($/SF/yr). Put renewal/expansion/termination options and ROFO/ROFR into `options` as concise text. Pull every " +
    "date-driven obligation (renewal-notice deadline, option-exercise windows, expiration, early-termination notice, etc.) " +
    "into `key_dates` with a clear label. (2) Produce a TENANT-SIDE `risk_review`: flag clauses a tenant's broker should " +
    "double-check — landlord relocation rights, broad operating-expense pass-throughs or missing exclusions/caps, " +
    "restoration/make-good obligations, personal guaranty, harsh holdover premium, missing or weak renewal language, " +
    "co-tenancy, assignment/sublease restrictions, demolition/recapture. Each item: severity high|medium|low and a one-line " +
    "plain-English `issue` citing the concern. Be specific and practical; omit boilerplate that is standard and benign. If " +
    "the document is not actually a lease, set is_lease=false. Respond only with the structured result.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: system,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 }, title: filename || "lease.pdf" },
          { type: "text", text: "Abstract this executed lease and give me the tenant-side risk review per your instructions." }
        ]
      }]
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ("Anthropic HTTP " + res.status));
  if (data.stop_reason === "refusal") throw new Error("The model's safety system declined this request.");
  const textBlock = (data.content || []).filter((b) => b.type === "text")[0];
  if (!textBlock || !textBlock.text) throw new Error("No abstraction returned.");
  return JSON.parse(textBlock.text);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) { console.log("ai-abstract: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("ai-abstract: ANTHROPIC_API_KEY not set"); return { statusCode: 500, body: "no key" }; }

  const dealId = String(body.dealId || ""), storagePath = String(body.storagePath || "");
  if (!dealId || !storagePath) return { statusCode: 400, body: "missing fields" };
  if (storagePath.split("/")[0] !== dealId) { console.log("ai-abstract: path/deal mismatch"); return { statusCode: 400, body: "bad path" }; }

  let deal = null;
  try { const r = await sb.rest("deals?id=eq." + dealId + "&select=id,owner_id&limit=1"); deal = r.data && r.data[0]; } catch (e) {}
  if (!deal || deal.owner_id !== user.id) { console.log("ai-abstract: deal not owned by user"); return { statusCode: 403, body: "forbidden" }; }

  let pdfB64;
  try { pdfB64 = await fetchPdfBase64(storagePath); }
  catch (e) { console.log("ai-abstract: pdf fetch failed:", e.message); return { statusCode: 200, body: "pdf fetch failed" }; }

  let ex;
  try { ex = await abstractWithClaude(pdfB64, body.filename); }
  catch (e) { console.log("ai-abstract: abstraction failed:", e.message); return { statusCode: 200, body: "abstract failed" }; }

  const ab = ex.abstract || {};
  const aiMeta = {
    review: Array.isArray(ex.risk_review) ? ex.risk_review : [],
    confidence: ex.confidence || "low",
    is_lease: ex.is_lease !== false,
    filename: body.filename || null,
    source_path: storagePath,
    at: new Date().toISOString()
  };

  // does an abstract already exist for this deal?
  let existing = null;
  try { const r = await sb.rest("lease_abstracts?deal_id=eq." + dealId + "&select=id,data&order=created_at&limit=1"); existing = r.data && r.data[0]; } catch (e) {}

  try {
    if (existing) {
      // SAFE: never touch the broker's typed fields — only merge the AI review into data
      const mergedData = Object.assign({}, existing.data || {}, { __ai: aiMeta });
      await sb.rest("lease_abstracts?id=eq." + existing.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ data: mergedData, updated_at: new Date().toISOString() })
      });
      console.log("ai-abstract: merged review into existing abstract", existing.id);
    } else {
      // create a pre-filled abstract for the broker to verify; keep it hidden from the client
      const row = {
        deal_id: dealId,
        tenant_name: ab.tenant_name, landlord_name: ab.landlord_name, premises: ab.premises,
        size_sf: ab.size_sf, commencement_date: ab.commencement_date, expiration_date: ab.expiration_date,
        base_rent_psf: ab.base_rent_psf, security_deposit: ab.security_deposit,
        escalations: ab.escalations, options: ab.options,
        key_dates: Array.isArray(ex.key_dates) ? ex.key_dates.filter((k) => k && (k.label || k.date)) : [],
        data: { __ai: aiMeta }, client_visible: false
      };
      await sb.rest("lease_abstracts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(row)
      });
      console.log("ai-abstract: created pre-filled abstract for deal", dealId);
    }
  } catch (e) { console.log("ai-abstract: write failed:", e.message); return { statusCode: 200, body: "save failed" }; }

  return { statusCode: 200, body: JSON.stringify({ ok: true, risks: aiMeta.review.length }) };
};
