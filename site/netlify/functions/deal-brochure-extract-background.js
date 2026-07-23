// Vantage — deal-brochure-extract (Netlify BACKGROUND function).
//
// Phase 2 of the requirement→deliverable flow (brochure auto-filing): the
// broker drops a batch of listing-broker marketing PDFs (building brochures,
// availability flyers, floor-plan packages) on the deal page. For EACH file,
// this function has Claude answer: which building is this about, what
// available spaces does it advertise, which pages are floor plans, and what
// should the filed document be labeled? The deal page then matches the
// building to the catalog, and on the broker's confirm files the PDF under
// the building (building_media), uploads rendered floor-plan pages, and
// refreshes the availability tracker (market_spaces, source 'flyer').
//
// BACKGROUND function (pattern of market-report-extract-background): brochures
// are usually small, but photo-heavy flyers can outrun the ~26s synchronous
// ceiling, and a BATCH of files wants parallel jobs anyway. The browser stages
// each PDF in a deal_brochure_extracts job row (supabase/brochure-filing.sql),
// invokes this with just {token, jobId}, and polls the row. This fn reads the
// row (service_role), extracts, writes status/result back (clearing the staged
// PDF). Parse-only: building_media / market_spaces writes happen in the
// browser under RLS after the broker reviews.
//
// SOURCING: listing brokers' own marketing materials — not CoStar exports, so
// the CoStar firewall doesn't apply. Still parsed only for the signed-in
// broker (JWT required).
//
// Structured outputs: mirrors deal-report-import.js (proven in production);
// the schema here is smaller than that one, safely inside both compiler
// budgets that burned market-report-extract.
//
// Requires env var ANTHROPIC_API_KEY (+ SUPABASE_URL / SERVICE_ROLE via _sb).

const sb = require("./_sb");

const NUMN = { anyOf: [{ type: "number" }, { type: "null" }] };
const INTN = { anyOf: [{ type: "integer" }, { type: "null" }] };
const STRN = { anyOf: [{ type: "string" }, { type: "null" }] };
function ENUMN(vals) { return { anyOf: [{ type: "string", enum: vals }, { type: "null" }] }; }

const SPACE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suite: STRN, floor: STRN,
    sf: INTN,
    rate: NUMN,
    ratePeriod: ENUMN(["mo", "yr"]),
    rateBasis: ENUMN(["FSG", "NNN", "MG"]),
    spaceType: ENUMN(["direct", "sublease"]),
    availableDate: STRN
  },
  required: ["suite", "floor", "sf", "rate", "ratePeriod", "rateBasis", "spaceType", "availableDate"]
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    docType: { type: "string", enum: ["brochure", "flyer", "floorplan", "other"] },
    buildingName: STRN,
    address: STRN,
    city: STRN,
    label: { type: "string" },
    spaces: { type: "array", items: SPACE_SCHEMA },
    floorPlanPages: { type: "array", items: { type: "integer" } },
    highlights: { type: "array", items: { type: "string" } }
  },
  required: ["docType", "buildingName", "address", "city", "label", "spaces", "floorPlanPages", "highlights"]
};

const SYSTEM =
  "You are an expert commercial real estate tenant-rep analyst at Havill & Co. You read ONE listing-broker marketing " +
  "PDF — a building brochure, an availability flyer, or a floor-plan package — and identify which building it is " +
  "about and what it advertises, precisely, so the broker can file it. Rules:\n" +
  "- Extract ONLY what the document states. Never infer, estimate, or invent a value; unstated field = null.\n" +
  "- `docType`: 'brochure' (multi-page building marketing piece), 'flyer' (1-2 page availability sheet), 'floorplan' " +
  "(the document is primarily floor plans), or 'other' (not building marketing at all).\n" +
  "- `buildingName` / `address` / `city`: the building the document markets. `address` is street number + street only; " +
  "city goes in `city`. A document covering several unrelated buildings: use the primary/cover building.\n" +
  "- `label`: a short filing label for this document, e.g. 'Marketing brochure — The Water Garden' or " +
  "'Availability flyer — Suite 210 (Q3 2026)'. Include a date/quarter only when the document states one.\n" +
  "- `spaces`: one entry per advertised available space (suite/floor cards, availability tables, stacking plans). " +
  "Rates: `rate` is the $/SF NUMBER; `ratePeriod` 'mo' ($/SF/MO, common in Los Angeles) or 'yr'; read the printed " +
  "units, never convert. `rateBasis` FSG/NNN/MG when stated. 'Negotiable'/withheld = null rate. `availableDate` as " +
  "'YYYY-MM-DD'; 'Now'/'Immediate' = null. A brochure that advertises no specific suites = empty array.\n" +
  "- `floorPlanPages`: 1-based page numbers of pages whose PRIMARY content is a floor plan / test fit / stacking " +
  "plan drawing. A page that merely includes a thumbnail plan among photos does not count.\n" +
  "- `highlights`: 2-5 SHORT scannable bullets of the building's selling points as marketed (amenities, renovations, " +
  "signage, parking, views). Each bullet is a crisp fragment — never a paragraph. Empty array if none stated.\n" +
  "Respond only with the structured result.";

// ~30MB of base64 ≈ 22MB PDF — past Anthropic's request ceiling once wrapped in JSON.
const MAX_B64 = 30 * 1024 * 1024;

function friendlyAnthropicError(msg, status) {
  const m = String(msg || "");
  if (/page.?limit|too many pages|maximum.*pages|exceeds.*pages/i.test(m))
    return "This PDF is longer than Claude can read in one pass (~100 pages). Split it and file the parts separately.";
  if (status === 413 || /request.*too large|exceeds.*size|too_large/i.test(m))
    return "This PDF is too large to send for reading (~20MB max). Try a lighter export of the brochure.";
  if (/could not process|invalid.*pdf|corrupt/i.test(m))
    return "That file couldn't be read as a PDF. Re-download the brochure and try again.";
  return "Claude couldn't read this file: " + m;
}

async function extractWithClaude(pdfB64, filename) {
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
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 }, title: filename || "brochure.pdf" },
          { type: "text", text: "Identify this marketing document's building, advertised spaces, floor-plan pages, and filing label per your instructions." }
        ]
      }]
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || ("Anthropic HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  if (data.stop_reason === "refusal") throw new Error("The model's safety system declined this request.");
  const textBlock = (data.content || []).filter((b) => b.type === "text")[0];
  if (!textBlock || !textBlock.text) throw new Error("No extraction returned.");
  return JSON.parse(textBlock.text);
}

// Write the job's outcome back to the row (service_role). Always clears the
// staged PDF so multi-MB blobs don't linger. The browser polls this row.
async function finishJob(jobId, patch) {
  await sb.rest("deal_brochure_extracts?id=eq." + encodeURIComponent(jobId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(Object.assign({ pdf_b64: null }, patch))
  });
}

// Background function: Netlify replies 202 to the caller before this runs, so
// return values never reach the browser — every outcome (including auth-ish
// failures after the row exists) must land on the job row instead.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);   // broker must be signed in
  if (!user) { console.log("brochure-extract: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }

  const jobId = String(body.jobId || "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) { console.log("brochure-extract: bad jobId"); return { statusCode: 400, body: "bad jobId" }; }

  // Load the staged job row (service_role bypasses RLS, so verify ownership:
  // the row's org must be the caller's org — same defense-in-depth as deal fns).
  let job = null, profile = null;
  try {
    const r = await sb.rest("deal_brochure_extracts?id=eq." + encodeURIComponent(jobId) + "&select=id,org_id,filename,pdf_b64,status&limit=1");
    job = r.data && r.data[0];
    const p = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
    profile = p.data && p.data[0];
  } catch (e) { /* handled below */ }
  if (!job) { console.log("brochure-extract: job not found", jobId); return { statusCode: 404, body: "no job" }; }
  if (!profile || !profile.org_id || profile.org_id !== job.org_id) {
    console.log("brochure-extract: job/org mismatch");
    return { statusCode: 403, body: "forbidden" };
  }
  if (job.status !== "queued") { console.log("brochure-extract: job already", job.status); return { statusCode: 200, body: "done" }; }

  if (!process.env.ANTHROPIC_API_KEY) { await finishJob(jobId, { status: "error", error: "AI isn't configured yet (missing API key)." }); return { statusCode: 200, body: "no key" }; }

  const pdfB64 = typeof job.pdf_b64 === "string" ? job.pdf_b64.replace(/^data:[^,]*,/, "") : "";
  if (!pdfB64) { await finishJob(jobId, { status: "error", error: "No PDF was staged for this file — try the upload again." }); return { statusCode: 200, body: "empty" }; }
  if (pdfB64.length > MAX_B64) { await finishJob(jobId, { status: "error", error: friendlyAnthropicError("request too large", 413) }); return { statusCode: 200, body: "too big" }; }

  let result;
  try {
    result = await extractWithClaude(pdfB64, job.filename);
  } catch (e) {
    console.log("brochure-extract: extraction failed:", e.message);
    await finishJob(jobId, { status: "error", error: friendlyAnthropicError(e.message, e.status) });
    return { statusCode: 200, body: "extract failed" };
  }

  if (!result || result.docType === "other" || (!result.buildingName && !result.address)) {
    await finishJob(jobId, {
      status: "error",
      error: "That file doesn't look like building marketing (brochure / flyer / floor plans) — nothing to file."
    });
    return { statusCode: 200, body: "not marketing" };
  }

  console.log("brochure-extract: parsed", result.docType, "for", result.buildingName || result.address || "?",
    "—", (result.spaces || []).length, "spaces,", (result.floorPlanPages || []).length, "plan pages, from", job.filename || "?");
  await finishJob(jobId, { status: "done", result: result });
  return { statusCode: 200, body: "ok" };
};
