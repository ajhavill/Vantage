// Vantage — deal-report-import (Netlify BACKGROUND function).
//
// The front door of the requirement→deliverable workflow: the broker uploads
// the CoStar market survey / availability report PDF they pulled for a client
// requirement, and Claude extracts EVERY building + available space into
// structured JSON. The deal page renders that as a review table; on confirm the
// browser writes deal_properties candidates + market_spaces rows itself (RLS-
// scoped) — this function only parses, it never writes.
//
// BACKGROUND function (pattern of market-report-extract-background and
// deal-brochure-extract-background): the synchronous version 504'd on real
// CoStar surveys — Opus takes longer than Netlify's ~26s sync ceiling to read
// a multi-building PDF. Background invocations can't carry a multi-MB payload,
// so the browser stages the PDF (or pasted text) in a deal_report_imports job
// row (supabase/report-import-jobs.sql), invokes this with just {token, jobId},
// and polls the row. This fn reads the row (service_role), extracts, writes
// status/result back (clearing the staged upload).
//
// PROMPTED JSON, not structured outputs: this extraction needs 19 nullable
// fields, and the structured-outputs compiler rejects schemas with more than
// 16 union-typed parameters (the same limit that burned market-report-extract
// — see PR #44, whose prompt-and-parse pattern this mirrors). normalizeSpace()
// in assets/report-import.js already coerces every field browser-side, so the
// server only has to find and parse the object.
//
// COMPLIANCE (see supabase/market-spaces.sql header): CoStar-sourced data is
// broker-internal. JWT required — unauthenticated calls are rejected — and the
// result goes only to the logged-in deal page; nothing touches vantage-data.json
// or client/portal surfaces.
//
// Requires env var ANTHROPIC_API_KEY (+ SUPABASE_URL / SERVICE_ROLE via _sb).

const sb = require("./_sb");

// Example object for the prompt (values illustrative). Every field of the old
// json_schema appears here so the shape stays identical for the browser.
const JSON_SHAPE = JSON.stringify({
  reportDate: "2026-07-22",
  buildings: [{
    name: "The Water Garden",
    address: "1620 26th St",
    city: "Santa Monica",
    class: "A",
    rba: 1270000,
    yearBuilt: 1992,
    spaces: [{
      suite: "500", floor: "5", sf: 11450, contiguousSf: 23000,
      rate: 5.5, ratePeriod: "mo", rateBasis: "FSG", spaceType: "direct",
      availableDate: "2026-09-01",
      listingBroker: "Jane Doe", listingCompany: "CBRE",
      listingEmail: "jane.doe@cbre.com", listingPhone: "(310) 555-0100"
    }],
    floorPlanPages: [{ page: 12, contactBox: { x0: 0, y0: 0.9, x1: 1, y1: 1 } }]
  }]
});

const SYSTEM =
  "You are an expert commercial real estate tenant-rep analyst at Havill & Co. You read a CoStar market report " +
  "(an Availability Report, Survey, or similar multi-building export) and extract every building and every available " +
  "space it lists, precisely, for the broker. Rules:\n" +
  "- Extract ONLY what the document states. Never infer, estimate, or invent a value; if a field isn't stated for a " +
  "building or space, return null for it.\n" +
  "- One entry per AVAILABLE SPACE. A building with three listed suites gets three entries in its `spaces` array. A " +
  "building shown with no individual spaces still appears with an empty `spaces` array.\n" +
  "- `address` is the street address exactly as printed (street number + street). Put the city in `city`, not in `address`.\n" +
  "- Rates: normalize to a NUMBER plus a period. `rate` is $/SF; `ratePeriod` is 'mo' for monthly ($/SF/MO, common in " +
  "Los Angeles) or 'yr' for annual ($/SF/YR, the CoStar default). Read the units printed in the report — do not convert " +
  "between monthly and annual yourself. 'Withheld', 'Negotiable' or a missing rate = null rate and null ratePeriod.\n" +
  "- `rateBasis` is the service type: FSG (full service/gross), NNN (triple net), or MG (modified gross); anything " +
  "else or unstated = null.\n" +
  "- `spaceType`: 'direct' or 'sublease' as labeled; unstated = null.\n" +
  "- `sf` is the space's available SF; `contiguousSf` only when a larger contiguous block is stated.\n" +
  "- Dates (`reportDate`, `availableDate`) as 'YYYY-MM-DD'; 'Vacant'/'Now'/'Immediate' availability = null availableDate.\n" +
  "- `rba` is the building's rentable building area in SF; `class` like 'A'/'B'/'C' as printed.\n" +
  "- Listing contact fields come from the report's broker/agent columns when present.\n" +
  "- Handle multi-building layouts: page-per-building profiles, table rows, and summary grids all count.\n" +
  "- `floorPlanPages`: CoStar reports often embed floor plans / site plans in each building's profile. One entry per " +
  "page whose PRIMARY content is a floor plan / test fit / stacking plan for THIS building (`page` is the 1-based " +
  "page number in the whole document). A thumbnail plan among photos doesn't count. These page images get shown to " +
  "the TENANT CLIENT, so for each also return `contactBox`: the bounding region of any listing-broker contact block " +
  "on the page (names, phones, emails, brokerage branding — usually a header/footer strip). Coordinates are " +
  "FRACTIONS of the page (0-1), x rightward, y downward, top-left origin. Be GENEROUS — cover the whole strip edge " +
  "to edge; over-masking beats leaking a phone number. Null only when the page truly has no broker contact info. " +
  "Never box the plan drawing itself. No floor plans = empty array.\n" +
  "OUTPUT FORMAT: respond with ONLY one JSON object — no markdown fences, no commentary before or after. Use exactly " +
  "the key names and value types of this example (the values here are illustrative, never copy them): " + JSON_SHAPE + " " +
  "`ratePeriod` is mo|yr, `rateBasis` is FSG|NNN|MG, `spaceType` is direct|sublease. Every key must be present on " +
  "every building and every space — use null for anything the report doesn't state. `spaces` and `floorPlanPages` " +
  "may be empty arrays.";

// ~30MB of base64 ≈ 22MB PDF — past Anthropic's request ceiling once wrapped in JSON.
const MAX_B64 = 30 * 1024 * 1024;

function friendlyAnthropicError(msg, status) {
  const m = String(msg || "");
  if (/page.?limit|too many pages|maximum.*pages|exceeds.*pages/i.test(m))
    return "This PDF is longer than Claude can read in one pass (~100 pages). Split the report in CoStar and import it in parts.";
  if (status === 413 || /request.*too large|exceeds.*size|too_large/i.test(m))
    return "This PDF is too large to send for reading (~20MB max). Export a lighter version from CoStar (fewer photos) and try again.";
  if (/could not process|invalid.*pdf|corrupt/i.test(m))
    return "That file couldn't be read as a PDF. Re-export the report from CoStar and try again.";
  return "Claude couldn't read this report: " + m;
}

async function extractWithClaude(input) {
  const content = [];
  if (input.pdfB64) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfB64 }, title: input.filename || "report.pdf" });
    content.push({ type: "text", text: "Extract every building and available space from this CoStar report per your instructions." });
  } else {
    content.push({ type: "text", text: "Extract every building and available space from this pasted CoStar report content per your instructions:\n\n" + input.text });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 16000,                                    // multi-building reports produce a lot of rows
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM,
      messages: [{ role: "user", content: content }]
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
  return parseJSONLoose(textBlock.text);
}

// Prompted JSON instead of structured outputs — tolerate the usual wrappers:
// markdown fences, a sentence before/after the object. normalizeSpace() in
// the browser does the per-field coercion; this only has to find the object.
function parseJSONLoose(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("No JSON object in the reply.");
  return JSON.parse(t.slice(a, b + 1));
}

// Write the job's outcome back to the row (service_role). Always clears the
// staged upload so multi-MB blobs don't linger. The browser polls this row.
async function finishJob(jobId, patch) {
  await sb.rest("deal_report_imports?id=eq." + encodeURIComponent(jobId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(Object.assign({ pdf_b64: null, src_text: null }, patch))
  });
}

// Background function: Netlify replies 202 to the caller before this runs, so
// return values never reach the browser — every outcome (including auth-ish
// failures after the row exists) must land on the job row instead.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);   // broker must be signed in — CoStar data is internal-only
  if (!user) { console.log("report-import: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }

  const jobId = String(body.jobId || "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) { console.log("report-import: bad jobId"); return { statusCode: 400, body: "bad jobId" }; }

  // Load the staged job row (service_role bypasses RLS, so verify ownership:
  // the row's org must be the caller's org — same defense-in-depth as deal fns).
  let job = null, profile = null;
  try {
    const r = await sb.rest("deal_report_imports?id=eq." + encodeURIComponent(jobId) + "&select=id,org_id,filename,pdf_b64,src_text,status&limit=1");
    job = r.data && r.data[0];
    const p = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
    profile = p.data && p.data[0];
  } catch (e) { /* handled below */ }
  if (!job) { console.log("report-import: job not found", jobId); return { statusCode: 404, body: "no job" }; }
  if (!profile || !profile.org_id || profile.org_id !== job.org_id) {
    console.log("report-import: job/org mismatch");
    return { statusCode: 403, body: "forbidden" };
  }
  if (job.status !== "queued") { console.log("report-import: job already", job.status); return { statusCode: 200, body: "done" }; }

  if (!process.env.ANTHROPIC_API_KEY) { await finishJob(jobId, { status: "error", error: "AI isn't configured yet (missing API key)." }); return { statusCode: 200, body: "no key" }; }

  const pdfB64 = typeof job.pdf_b64 === "string" ? job.pdf_b64.replace(/^data:[^,]*,/, "") : "";
  const text = (job.src_text || "").toString().trim();
  if (!pdfB64 && !text) { await finishJob(jobId, { status: "error", error: "No report was staged for this job — try the upload again." }); return { statusCode: 200, body: "empty" }; }
  if (pdfB64 && pdfB64.length > MAX_B64) { await finishJob(jobId, { status: "error", error: friendlyAnthropicError("request too large", 413) }); return { statusCode: 200, body: "too big" }; }

  let result;
  try {
    result = await extractWithClaude({ pdfB64: pdfB64 || null, text: text || null, filename: job.filename });
  } catch (e) {
    console.log("report-import: extraction failed:", e.message);
    await finishJob(jobId, { status: "error", error: friendlyAnthropicError(e.message, e.status) });
    return { statusCode: 200, body: "extract failed" };
  }

  const buildings = Array.isArray(result && result.buildings) ? result.buildings : [];
  if (!buildings.length) {
    await finishJob(jobId, { status: "error", error: "No buildings found in that document — is it a CoStar availability report / survey export?" });
    return { statusCode: 200, body: "no buildings" };
  }

  const spaces = buildings.reduce((n, b) => n + ((b.spaces && b.spaces.length) || 0), 0);
  console.log("report-import: parsed", buildings.length, "buildings /", spaces, "spaces from", job.filename || "(pasted text)");
  await finishJob(jobId, { status: "done", result: { reportDate: result.reportDate || null, buildings: buildings } });
  return { statusCode: 200, body: "ok" };
};
