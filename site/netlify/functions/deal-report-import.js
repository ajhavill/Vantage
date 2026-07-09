// Vantage — deal-report-import (synchronous Netlify function).
//
// The front door of the requirement→deliverable workflow: the broker uploads
// the CoStar market survey / availability report PDF they pulled for a client
// requirement, and Claude extracts EVERY building + available space into
// structured JSON. The deal page renders that as a review table; on confirm the
// browser writes deal_properties candidates + market_spaces rows itself (RLS-
// scoped) — this function only parses, it never writes.
//
// Mirrors deal-ai-extract-background.js exactly (auth via sb.userFromToken,
// direct fetch to the Anthropic Messages API — no SDK, claude-opus-4-8 with
// adaptive thinking + json_schema structured output, base64 document block).
// Differences: the PDF arrives inline as base64 (it isn't a deal document worth
// storing), and the response is synchronous JSON because the broker reviews it
// immediately. Handled failures return 200 + {error} (deal-ai-assist pattern)
// so the UI can show a clear message.
//
// COMPLIANCE (see supabase/market-spaces.sql header): CoStar-sourced data is
// broker-internal. JWT required — unauthenticated calls are rejected — and the
// result goes only to the logged-in deal page; nothing touches vantage-data.json
// or client/portal surfaces.
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
    sf: INTN, contiguousSf: INTN,
    rate: NUMN,
    ratePeriod: ENUMN(["mo", "yr"]),
    rateBasis: ENUMN(["FSG", "NNN", "MG"]),
    spaceType: ENUMN(["direct", "sublease"]),
    availableDate: STRN,
    listingBroker: STRN, listingCompany: STRN, listingEmail: STRN, listingPhone: STRN
  },
  required: ["suite", "floor", "sf", "contiguousSf", "rate", "ratePeriod", "rateBasis", "spaceType",
    "availableDate", "listingBroker", "listingCompany", "listingEmail", "listingPhone"]
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reportDate: STRN,                      // 'YYYY-MM-DD' when the report states one
    buildings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: STRN,
          address: { type: "string" },
          city: STRN,
          class: STRN,
          rba: INTN,
          yearBuilt: INTN,
          spaces: { type: "array", items: SPACE_SCHEMA }
        },
        required: ["name", "address", "city", "class", "rba", "yearBuilt", "spaces"]
      }
    }
  },
  required: ["reportDate", "buildings"]
};

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
  "Respond only with the structured result.";

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
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
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
  return JSON.parse(textBlock.text);
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
