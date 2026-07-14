// Vantage — market-report-extract (Netlify BACKGROUND function).
//
// Market → Reports: the broker uploads a brokerage's published quarterly
// market report PDF (CBRE "Figures", JLL "Market Dynamics", Cushman &
// Wakefield "MarketBeat", Colliers, Newmark, Savills, Lee & Associates,
// Kidder Mathews, ...) and Claude extracts the headline statistics (average
// asking rate, vacancy, net absorption, sublease space, construction), the
// submarket breakdown table, and the key takeaways as scannable bullets.
//
// BACKGROUND function (name ends "-background", pattern of
// deal-ai-extract-background): the full-report Opus read takes longer than the
// ~26s synchronous-function ceiling (the first live import 504'd), so this
// returns 202 immediately and runs with a 15-min budget. Because background
// invocations can't carry a multi-MB payload, the browser first STAGES the PDF
// in an org-scoped `market_report_extracts` job row (see market-reports.sql),
// then calls this with just {token, jobId}. This fn reads the row
// (service_role), extracts, writes status/result back (clearing the staged
// PDF), and the browser polls the row. Parse-only: the reviewed market_reports
// row is still written by the browser under RLS.
//
// SOURCING: these are the brokerages' own publicly distributed research PDFs
// (not CoStar exports), so the CoStar firewall doesn't apply — but the result
// still goes only to the logged-in broker and the org-scoped tables, never to
// vantage-data.json or client surfaces.
//
// Requires env var ANTHROPIC_API_KEY (+ SUPABASE_URL / SERVICE_ROLE via _sb).

const sb = require("./_sb");

// NO structured outputs here — this endpoint burned three production deploys
// on the schema compiler (400: >16 union params; 400: >24 optional params;
// then "Grammar compilation timed out" on a schema within both budgets).
// Plain prompted JSON instead: the shape is spelled out in the system prompt,
// the reply is parsed tolerantly below, and the browser's normalizeReport()
// coerces every field defensively anyway — it never trusted the shape.
const JSON_SHAPE =
  '{"brokerage":"CBRE","reportTitle":"Greater Los Angeles Office Figures Q2 2026","market":"Greater Los Angeles",' +
  '"productType":"office","year":2026,"quarter":2,"reportDate":"2026-07-01",' +
  '"inventorySf":215400000,"vacancyPct":24.1,"availabilityPct":27.8,"subleaseSf":7200000,' +
  '"netAbsorptionSf":-412000,"netAbsorptionYtdSf":-1080000,"leasingActivitySf":3400000,' +
  '"underConstructionSf":1100000,"deliveriesSf":0,"avgAskingRate":3.61,"ratePeriod":"mo","rateBasis":"FSG",' +
  '"classARate":3.94,"salePricePsf":null,"capRatePct":null,' +
  '"takeaways":["Asking rates held flat at $3.61 FSG despite rising vacancy"],' +
  '"submarkets":[{"name":"Santa Monica","inventorySf":8900000,"vacancyPct":21.3,"availabilityPct":24.0,' +
  '"netAbsorptionSf":45000,"subleaseSf":610000,"avgAskingRate":5.12,"classARate":null}]}';

const SYSTEM =
  "You are an expert commercial real estate research analyst at Havill & Co., a tenant-rep firm. You read a " +
  "brokerage's published quarterly market report (CBRE Figures, JLL Market Dynamics, Cushman & Wakefield MarketBeat, " +
  "Colliers, Newmark, Savills, Lee & Associates, Kidder Mathews, or similar research PDF) and extract its statistics " +
  "precisely for the broker. Rules:\n" +
  "- Extract ONLY what the document states. Never infer, estimate, or compute a value the report doesn't print; if a " +
  "field isn't stated, OMIT it from your output entirely (all statistic fields are optional).\n" +
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
  "- `submarkets`: one entry per row of the report's submarket statistics table, with each row's own figures; use " +
  "null for any value the table doesn't state for that row. Skip subtotal/total rows (the market-wide totals belong " +
  "in the headline fields).\n" +
  "- `takeaways`: 3-7 SHORT scannable bullets, each one specific fact or trend the report highlights (rate direction, " +
  "notable move-ins/move-outs, big leases signed, construction pipeline, concessions, forecast). Each bullet is a " +
  "single crisp sentence fragment — never a paragraph.\n" +
  "- Dates as 'YYYY-MM-DD'.\n" +
  "OUTPUT FORMAT: respond with ONLY one JSON object — no markdown fences, no commentary before or after. Use exactly " +
  "the key names and value types of this example (the numbers here are illustrative, never copy them): " + JSON_SHAPE + " " +
  "`productType` is one of office|industrial|retail|flex|lab|medical|mixed; `ratePeriod` is mo|yr; `rateBasis` is " +
  "FSG|NNN|MG. OMIT any headline-statistic key the report doesn't state (or set it null); in `submarkets` rows use " +
  "null for unstated cells. `brokerage`, `market`, `year`, `quarter`, `takeaways` and `submarkets` must always be present " +
  "(`submarkets` may be an empty array).";

// ~30MB of base64 ≈ 22MB PDF — past Anthropic's request ceiling once wrapped in JSON.
const MAX_B64 = 30 * 1024 * 1024;

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
// markdown fences, a sentence before/after the object. normalizeReport() in
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
// staged PDF so multi-MB blobs don't linger. The browser polls this row.
async function finishJob(jobId, patch) {
  await sb.rest("market_report_extracts?id=eq." + encodeURIComponent(jobId), {
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

  const user = await sb.userFromToken(body.token);   // broker must be signed in — internal research library
  if (!user) { console.log("market-report-extract: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }

  const jobId = String(body.jobId || "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) { console.log("market-report-extract: bad jobId"); return { statusCode: 400, body: "bad jobId" }; }

  // Load the staged job row (service_role bypasses RLS, so verify ownership:
  // the row's org must be the caller's org — same defense-in-depth as deal fns).
  let job = null, profile = null;
  try {
    const r = await sb.rest("market_report_extracts?id=eq." + encodeURIComponent(jobId) + "&select=id,org_id,filename,pdf_b64,src_text,status&limit=1");
    job = r.data && r.data[0];
    const p = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
    profile = p.data && p.data[0];
  } catch (e) { /* handled below */ }
  if (!job) { console.log("market-report-extract: job not found", jobId); return { statusCode: 404, body: "no job" }; }
  if (!profile || !profile.org_id || profile.org_id !== job.org_id) {
    console.log("market-report-extract: job/org mismatch");
    return { statusCode: 403, body: "forbidden" };
  }
  if (job.status !== "queued") { console.log("market-report-extract: job already", job.status); return { statusCode: 200, body: "done" }; }

  if (!process.env.ANTHROPIC_API_KEY) { await finishJob(jobId, { status: "error", error: "AI isn't configured yet (missing API key)." }); return { statusCode: 200, body: "no key" }; }

  const pdfB64 = typeof job.pdf_b64 === "string" ? job.pdf_b64.replace(/^data:[^,]*,/, "") : "";
  const text = (job.src_text || "").toString().trim();
  if (!pdfB64 && !text) { await finishJob(jobId, { status: "error", error: "Attach the market report PDF (or paste its text) first." }); return { statusCode: 200, body: "empty" }; }
  if (pdfB64 && pdfB64.length > MAX_B64) { await finishJob(jobId, { status: "error", error: friendlyAnthropicError("request too large", 413) }); return { statusCode: 200, body: "too big" }; }

  let result;
  try {
    result = await extractWithClaude({ pdfB64: pdfB64 || null, text: text || null, filename: job.filename });
  } catch (e) {
    console.log("market-report-extract: extraction failed:", e.message);
    await finishJob(jobId, { status: "error", error: friendlyAnthropicError(e.message, e.status) });
    return { statusCode: 200, body: "extract failed" };
  }

  if (!result || (!result.brokerage && !result.market && result.avgAskingRate == null && result.vacancyPct == null)) {
    await finishJob(jobId, { status: "error", error: "No market statistics found in that document — is it a brokerage quarterly market report?" });
    return { statusCode: 200, body: "no stats" };
  }

  console.log("market-report-extract: parsed", result.brokerage || "?", result.market || "?",
    "Q" + (result.quarter || "?"), result.year || "?", "from", job.filename || "(pasted text)");
  await finishJob(jobId, { status: "done", result: result });
  return { statusCode: 200, body: "ok" };
};
