// Vantage — deal-report-import (synchronous Netlify function).
//
// The front door of the requirement→deliverable workflow: the broker uploads
// the CoStar market survey / availability report PDF they pulled for a client
// requirement, and Claude extracts EVERY building + available space into
// structured JSON. The deal page renders that as a review table; on confirm the
// browser writes deal_properties candidates + market_spaces rows itself (RLS-
// scoped) — this function only parses, it never writes.
//
// Auth via sb.userFromToken, direct fetch to the Anthropic Messages API — no
// SDK, claude-opus-4-8 with adaptive thinking, base64 document block. The PDF
// arrives inline as base64 (it isn't a deal document worth storing), and the
// response is synchronous JSON because the broker reviews it immediately.
// Handled failures return 200 + {error} (deal-ai-assist pattern) so the UI can
// show a clear message.
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
    }]
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
  "OUTPUT FORMAT: respond with ONLY one JSON object — no markdown fences, no commentary before or after. Use exactly " +
  "the key names and value types of this example (the values here are illustrative, never copy them): " + JSON_SHAPE + " " +
  "`ratePeriod` is mo|yr, `rateBasis` is FSG|NNN|MG, `spaceType` is direct|sublease. Every key must be present on " +
  "every building and every space — use null for anything the report doesn't state. `spaces` may be an empty array.";

// ~30MB of base64 ≈ 22MB PDF — past Anthropic's request ceiling once wrapped in JSON.
const MAX_B64 = 30 * 1024 * 1024;

function okJSON(obj) { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);   // broker must be signed in — CoStar data is internal-only
  if (!user) { console.log("report-import: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("report-import: ANTHROPIC_API_KEY not set"); return okJSON({ error: "AI isn't configured yet (missing API key)." }); }

  const pdfB64 = typeof body.base64pdf === "string" ? body.base64pdf.replace(/^data:[^,]*,/, "") : "";
  const text = (body.text || "").toString().trim();
  if (!pdfB64 && !text) return okJSON({ error: "Attach the CoStar report PDF (or paste its text) first." });
  if (pdfB64 && pdfB64.length > MAX_B64) return okJSON({ error: friendlyAnthropicError("request too large", 413) });

  let result;
  try {
    result = await extractWithClaude({ pdfB64: pdfB64 || null, text: text || null, filename: body.filename });
  } catch (e) {
    console.log("report-import: extraction failed:", e.message);
    return okJSON({ error: friendlyAnthropicError(e.message, e.status) });
  }

  const buildings = Array.isArray(result.buildings) ? result.buildings : [];
  if (!buildings.length) return okJSON({ error: "No buildings found in that document — is it a CoStar availability report / survey export?" });

  const spaces = buildings.reduce((n, b) => n + ((b.spaces && b.spaces.length) || 0), 0);
  console.log("report-import: parsed", buildings.length, "buildings /", spaces, "spaces from", body.filename || "(pasted text)");
  return okJSON({ ok: true, reportDate: result.reportDate || null, buildings: buildings });
};
