// Vantage — market-report-extract (synchronous Netlify function).
//
// Market → Reports: the broker uploads a brokerage's published quarterly
// market report PDF (CBRE "Figures", JLL "Market Dynamics", Cushman &
// Wakefield "MarketBeat", Colliers, Newmark, Savills, Lee & Associates,
// Kidder Mathews, ...) and Claude extracts the headline statistics (average
// asking rate, vacancy, net absorption, sublease space, construction), the
// submarket breakdown table, and the key takeaways as scannable bullets.
//
// Mirrors deal-report-import.js exactly (auth via sb.userFromToken, direct
// fetch to the Anthropic Messages API — no SDK, claude-opus-4-8 with adaptive
// thinking + json_schema structured output, base64 document block, PDF inline
// as base64, synchronous response, handled failures return 200 + {error}).
// This function only parses — the browser reviews the result and writes the
// market_reports row itself (RLS-scoped).
//
// SOURCING: these are the brokerages' own publicly distributed research PDFs
// (not CoStar exports), so the CoStar firewall doesn't apply — but the result
// still goes only to the logged-in broker and the org-scoped market_reports
// table, never to vantage-data.json or client surfaces.
//
// Requires env var ANTHROPIC_API_KEY (+ SUPABASE_URL / SERVICE_ROLE via _sb).

const sb = require("./_sb");

const NUMN = { anyOf: [{ type: "number" }, { type: "null" }] };
const INTN = { anyOf: [{ type: "integer" }, { type: "null" }] };
const STRN = { anyOf: [{ type: "string" }, { type: "null" }] };
function ENUMN(vals) { return { anyOf: [{ type: "string", enum: vals }, { type: "null" }] }; }

const SUBMARKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    inventorySf: INTN,
    vacancyPct: NUMN,
    availabilityPct: NUMN,
    netAbsorptionSf: INTN,
    subleaseSf: INTN,
    avgAskingRate: NUMN,
    classARate: NUMN
  },
  required: ["name", "inventorySf", "vacancyPct", "availabilityPct",
    "netAbsorptionSf", "subleaseSf", "avgAskingRate", "classARate"]
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    brokerage: STRN,                       // 'CBRE', 'JLL', 'Cushman & Wakefield', ...
    reportTitle: STRN,                     // as printed on the cover
    market: STRN,                          // geography covered, e.g. 'Greater Los Angeles'
    productType: ENUMN(["office", "industrial", "retail", "flex", "lab", "medical", "mixed"]),
    year: INTN,
    quarter: INTN,                         // 1-4
    reportDate: STRN,                      // 'YYYY-MM-DD' when stated
    inventorySf: INTN,
    vacancyPct: NUMN,
    availabilityPct: NUMN,
    subleaseSf: INTN,
    netAbsorptionSf: INTN,                 // the quarter's; negative = occupancy loss
    netAbsorptionYtdSf: INTN,
    leasingActivitySf: INTN,
    underConstructionSf: INTN,
    deliveriesSf: INTN,
    avgAskingRate: NUMN,                   // $/SF number only
    ratePeriod: ENUMN(["mo", "yr"]),
    rateBasis: ENUMN(["FSG", "NNN", "MG"]),
    classARate: NUMN,
    salePricePsf: NUMN,
    capRatePct: NUMN,
    takeaways: { type: "array", items: { type: "string" } },
    submarkets: { type: "array", items: SUBMARKET_SCHEMA }
  },
  required: ["brokerage", "reportTitle", "market", "productType", "year", "quarter", "reportDate",
    "inventorySf", "vacancyPct", "availabilityPct", "subleaseSf", "netAbsorptionSf",
    "netAbsorptionYtdSf", "leasingActivitySf", "underConstructionSf", "deliveriesSf",
    "avgAskingRate", "ratePeriod", "rateBasis", "classARate", "salePricePsf", "capRatePct",
    "takeaways", "submarkets"]
};

const SYSTEM =
  "You are an expert commercial real estate research analyst at Havill & Co., a tenant-rep firm. You read a " +
  "brokerage's published quarterly market report (CBRE Figures, JLL Market Dynamics, Cushman & Wakefield MarketBeat, " +
  "Colliers, Newmark, Savills, Lee & Associates, Kidder Mathews, or similar research PDF) and extract its statistics " +
  "precisely for the broker. Rules:\n" +
  "- Extract ONLY what the document states. Never infer, estimate, or compute a value the report doesn't print; if a " +
  "field isn't stated, return null for it.\n" +
  "- `brokerage` is the publishing firm ('CBRE', 'JLL', 'Cushman & Wakefield', 'Colliers', 'Newmark', 'Savills', " +
  "'Lee & Associates', 'Kidder Mathews', ...). `market` is the geography the report covers as titled (e.g. 'Greater " +
  "Los Angeles', 'West Los Angeles'). `productType` is the property sector the report covers; a report spanning " +
  "several sectors = 'mixed'.\n" +
  "- `year` + `quarter` come from the report's own period label (e.g. 'Q2 2026' → year 2026, quarter 2).\n" +
  "- The headline (market-wide) statistics come from the report's summary/overview stat block. SF figures are whole " +
  "square feet — expand printed units ('1.2M SF' → 1200000, '450K' → 450000). Percentages are plain numbers " +
  "(15.3% → 15.3). Negative net absorption stays negative.\n" +
  "- Rates: `avgAskingRate` (and `classARate`) is the $/SF NUMBER as printed; `ratePeriod` is 'mo' for $/SF/month " +
  "(common in Los Angeles) or 'yr' for $/SF/year. `rateBasis` is FSG (full service/gross), NNN, or MG when the report " +
  "states the service type; otherwise null. Read the units printed — never convert between monthly and annual.\n" +
  "- `submarkets`: one entry per row of the report's submarket statistics table, with each row's own figures. Skip " +
  "subtotal/total rows (the market-wide totals belong in the headline fields).\n" +
  "- `takeaways`: 3-7 SHORT scannable bullets, each one specific fact or trend the report highlights (rate direction, " +
  "notable move-ins/move-outs, big leases signed, construction pipeline, concessions, forecast). Each bullet is a " +
  "single crisp sentence fragment — never a paragraph.\n" +
  "- Dates as 'YYYY-MM-DD'.\n" +
  "Respond only with the structured result.";

// ~30MB of base64 ≈ 22MB PDF — past Anthropic's request ceiling once wrapped in JSON.
const MAX_B64 = 30 * 1024 * 1024;

function okJSON(obj) { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }

function friendlyAnthropicError(msg, status) {
  const m = String(msg || "");
  if (/page.?limit|too many pages|maximum.*pages|exceeds.*pages/i.test(m))
    return "This PDF is longer than Claude can read in one pass (~100 pages). Split it and import the statistics pages.";
  if (status === 413 || /request.*too large|exceeds.*size|too_large/i.test(m))
    return "This PDF is too large to send for reading (~20MB max). Try a lighter version of the report.";
  if (/could not process|invalid.*pdf|corrupt/i.test(m))
    return "That file couldn't be read as a PDF. Re-download the report and try again.";
  return "Claude couldn't read this report: " + m;
}

async function extractWithClaude(input) {
  const content = [];
  if (input.pdfB64) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfB64 }, title: input.filename || "report.pdf" });
    content.push({ type: "text", text: "Extract this quarterly market report's statistics, submarket table, and key takeaways per your instructions." });
  } else {
    content.push({ type: "text", text: "Extract this pasted quarterly market report's statistics, submarket table, and key takeaways per your instructions:\n\n" + input.text });
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
      max_tokens: 12000,
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

  const user = await sb.userFromToken(body.token);   // broker must be signed in — internal research library
  if (!user) { console.log("market-report-extract: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("market-report-extract: ANTHROPIC_API_KEY not set"); return okJSON({ error: "AI isn't configured yet (missing API key)." }); }

  const pdfB64 = typeof body.base64pdf === "string" ? body.base64pdf.replace(/^data:[^,]*,/, "") : "";
  const text = (body.text || "").toString().trim();
  if (!pdfB64 && !text) return okJSON({ error: "Attach the market report PDF (or paste its text) first." });
  if (pdfB64 && pdfB64.length > MAX_B64) return okJSON({ error: friendlyAnthropicError("request too large", 413) });

  let result;
  try {
    result = await extractWithClaude({ pdfB64: pdfB64 || null, text: text || null, filename: body.filename });
  } catch (e) {
    console.log("market-report-extract: extraction failed:", e.message);
    return okJSON({ error: friendlyAnthropicError(e.message, e.status) });
  }

  if (!result || (!result.brokerage && !result.market && result.avgAskingRate == null && result.vacancyPct == null))
    return okJSON({ error: "No market statistics found in that document — is it a brokerage quarterly market report?" });

  console.log("market-report-extract: parsed", result.brokerage || "?", result.market || "?",
    "Q" + (result.quarter || "?"), result.year || "?", "from", body.filename || "(pasted text)");
  return okJSON({ ok: true, report: result });
};
