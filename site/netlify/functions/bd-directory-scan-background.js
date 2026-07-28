// Vantage — bd-directory-scan (Netlify BACKGROUND function).
//
// BD → Directory Scan: the broker photographs a lobby tenant board and Claude
// (a) reads every company name + suite off it, and (b) RESEARCHES each company
// on the open web — website/domain, industry, HQ, size, and where the people
// who sign leases actually sit. The result is a reviewed table that exports as
// a HubSpot company-import CSV, which is the front door to the Tenant Rep BD
// pipeline (bd_templates cadence → bd_queue).
//
// BACKGROUND function (pattern of market-report-extract-background): reading a
// photo is fast, but the research pass makes dozens of web searches and blows
// straight past the ~26s synchronous ceiling. So this returns 202 immediately
// and runs with a 15-min budget. Background invocations can't carry multi-MB
// payloads, so the browser first STAGES the photos in an org-scoped
// bd_directory_scans row (supabase/bd-directory.sql), then calls this with just
// {token, jobId}. This fn reads the row (service_role), works, writes the
// result back (clearing the staged photos), and the browser polls the row.
//
// SOURCING: lobby directories are posted publicly inside the building, and the
// research runs against the open web via Anthropic's server-side web_search
// tool. No CoStar content is read or written here.
//
// Requires env var ANTHROPIC_API_KEY (+ SUPABASE_URL / SERVICE_ROLE via _sb).

const sb = require("./_sb");

// The model researches with the server-side web_search tool, so it runs an
// agentic loop on Anthropic's side. Each turn is capped at 10 tool iterations
// and comes back with stop_reason "pause_turn"; we re-send to continue.
const MODEL = "claude-opus-5";
const MAX_ROUNDS = 14;          // pause_turn resumes before we give up
const MAX_SEARCHES = 60;        // ~2 searches per tenant on a full board
const MAX_B64 = 20 * 1024 * 1024;  // total staged base64 across all photos

// NO structured outputs: the reply carries web-search citations, and
// output_config.format is rejected alongside citations. Plain prompted JSON
// instead — the shape is spelled out below, the reply is parsed tolerantly,
// and the browser coerces every field defensively anyway.
const JSON_SHAPE =
  '{"building":{"name":"Water Garden","address":"2425 Olympic Blvd, Santa Monica, CA 90404","floors_seen":"lobby board"},' +
  '"companies":[{"company":"Acme Studios","suite":"550","domain":"acmestudios.com",' +
  '"website":"https://www.acmestudios.com","industry":"Media & Entertainment",' +
  '"description":"Independent film and television production company.",' +
  '"hq_city":"Santa Monica","hq_state":"CA","hq_country":"United States",' +
  '"la_employees":45,"employees_total":60,"dm_titles":"Managing Partner, CFO",' +
  '"dm_location":"Santa Monica, CA","flag":"OK","confidence":"high",' +
  '"notes":"Two LinkedIn entities share this name — matched on the Santa Monica address.",' +
  '"sources":["https://www.acmestudios.com/about"]}],' +
  '"unreadable":["Suite 310 — name blurred, starts with \\"Vell\\""]}';

const SYSTEM =
  "You are a tenant-rep research analyst at Havill & Co., a Los Angeles tenant-representation brokerage. " +
  "The broker photographs a building's lobby directory; you turn it into a qualified prospect list.\n\n" +
  "STEP 1 — READ THE BOARD. Transcribe every tenant listed in the image(s): company name exactly as posted, " +
  "plus the suite/floor when shown. Include every distinct tenant, including ones that look small or " +
  "residential. Do NOT include building operations entries (property management/leasing office, security, " +
  "conference center, parking, cafe/retail concessions, restrooms, elevators) — those are not prospects. If " +
  "the same company appears on several lines with different suites, return ONE entry and list the suites " +
  "together (e.g. \"310, 315\"). Never invent a tenant, and never guess at a name you cannot read: put anything " +
  "blurred, cropped, or ambiguous into `unreadable` (with the suite and whatever letters are legible) instead " +
  "of into `companies`.\n\n" +
  "STEP 2 — RESEARCH EACH TENANT with the web_search tool. Search the open web for each company, using the " +
  "building's city as a disambiguator (many company names are generic — 'Elite', 'Summit', 'Apex' — and you must " +
  "match the entity actually at THIS address, not a same-named company elsewhere). For each one establish:\n" +
  "- `domain`: the bare registered domain, lowercase, no scheme and no 'www.' (e.g. 'acmestudios.com'). This is " +
  "the CRM's dedupe key, so it must be the company's real primary domain — omit it entirely rather than guess.\n" +
  "- `website`: the full https:// URL of the company site.\n" +
  "- `industry`: a short plain-English sector ('Law Firm', 'Media & Entertainment', 'Software', 'Investment " +
  "Management', 'Healthcare', 'Architecture & Design', 'Nonprofit', ...).\n" +
  "- `description`: ONE sentence on what the company does.\n" +
  "- `hq_city` / `hq_state` / `hq_country`: where the company is headquartered (which is often NOT this building).\n" +
  "- `la_employees`: your best estimate of headcount in the Greater Los Angeles metro — the number that drives " +
  "how much space they occupy. LinkedIn blocks automated access, so this is an ESTIMATE from public sources " +
  "(company site team/leadership pages, news coverage, funding announcements, job postings, association " +
  "listings). Reason it out: a firm headquartered here has most of its people here; a satellite office of a " +
  "national company usually has a fraction. Round to a sensible figure. Use null if you genuinely cannot " +
  "support a number — never pad the list with invented headcounts.\n" +
  "- `employees_total`: company-wide headcount when public; null otherwise.\n" +
  "- `dm_titles` / `dm_location`: the decision-makers (managing partner, managing shareholder, founder, CEO, " +
  "COO, CFO — whoever signs a lease) and the city/country they are based in.\n" +
  "- `flag`: 'OK' when the decision-makers are in the LA metro; 'DM Outside LA' when they are elsewhere in the " +
  "US; 'DM International' when they are outside the United States; 'Unclear' when you could not determine it. " +
  "This is a prospecting signal, never a disqualification — an LA satellite whose leadership sits in New York " +
  "still gets returned, just flagged.\n" +
  "- `confidence`: 'high' when you found the company and corroborated it against this building or city; " +
  "'medium' when the identification is probable; 'low' when you are unsure you found the right entity.\n" +
  "- `notes`: anything the broker should know before calling — several entities share the name, the company " +
  "appears to have moved or been acquired, it is a fund vehicle rather than an operating company, the office " +
  "looks like a satellite, recent funding or layoffs, a name that reads like a school or nonprofit but isn't.\n" +
  "- `sources`: 1-3 URLs you actually relied on.\n\n" +
  "RULES:\n" +
  "- Every tenant you transcribe gets an entry, even when research turns up little: fill what you found and " +
  "leave the rest null with a note. A thin entry is useful; a fabricated one is worse than nothing.\n" +
  "- Only assert what the sources support. Do not infer a domain from the company name, do not state an HQ you " +
  "did not read somewhere, and mark anything shaky as low confidence.\n" +
  "- Omit any field you have no value for (or set it null). `company` is the only field that must always be present.\n" +
  "- Work through the whole board. Do not stop early or summarize — a partial list silently costs the broker " +
  "prospects.\n\n" +
  "OUTPUT FORMAT: when the research is finished, respond with ONLY one JSON object — no markdown fences, no " +
  "commentary before or after it. Use exactly the key names and value types of this example (its values are " +
  "illustrative, never copy them): " + JSON_SHAPE + " " +
  "`flag` is one of OK|DM Outside LA|DM International|Unclear; `confidence` is one of high|medium|low; " +
  "`la_employees` and `employees_total` are plain numbers or null. `companies` and `unreadable` must always be " +
  "present (`unreadable` may be an empty array).";

function friendlyAnthropicError(msg, status) {
  const m = String(msg || "");
  if (status === 413 || /request.*too large|exceeds.*size|too_large/i.test(m))
    return "Those photos are too large to send for reading (~20MB total). Retake them at a lower resolution, or upload fewer at once.";
  if (/image|media_type|could not process|invalid.*base64/i.test(m))
    return "That file couldn't be read as an image. Use a JPEG, PNG, or WebP photo of the directory.";
  if (status === 429 || /rate.?limit/i.test(m))
    return "Claude is rate-limited right now. Wait a minute and run the scan again.";
  return "Claude couldn't read this directory: " + m;
}

// One turn of the research loop. Server tools run on Anthropic's side, so a
// long research pass comes back as stop_reason "pause_turn" — the caller
// re-sends to resume.
async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
      messages: messages
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || ("Anthropic HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

async function scanWithClaude(job) {
  const photos = Array.isArray(job.photos) ? job.photos : [];
  const content = photos.map(function (p) {
    return { type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } };
  });

  var where = [];
  if (job.building_name) where.push(job.building_name);
  if (job.address) where.push(job.address);
  if (job.submarket) where.push("in the " + job.submarket + " submarket");

  content.push({
    type: "text",
    text: "This is the tenant directory for " +
      (where.length ? where.join(", ") : "an office building in the Greater Los Angeles area") + ".\n" +
      (job.note ? "Broker's note: " + job.note + "\n" : "") +
      "Read every tenant off the board, research each company per your instructions, and return the JSON object."
  });

  var messages = [{ role: "user", content: content }];

  for (var round = 0; round < MAX_ROUNDS; round++) {
    const data = await callClaude(messages);

    if (data.stop_reason === "refusal") throw new Error("The model's safety system declined this request.");
    if (data.stop_reason === "max_tokens") {
      throw new Error("The reply was cut off before the list finished — this board has more tenants than one pass can cover. Photograph it in two halves and scan them separately.");
    }
    // Server-tool iteration cap: re-send with the paused turn appended to resume.
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }

    const textBlock = (data.content || []).filter(function (b) { return b.type === "text"; }).pop();
    if (!textBlock || !textBlock.text) throw new Error("No result returned.");
    return parseJSONLoose(textBlock.text);
  }
  throw new Error("The research pass didn't finish in time. Try a smaller board, or split the photo.");
}

// Prompted JSON instead of structured outputs — tolerate the usual wrappers
// (markdown fences, a sentence before/after). The browser coerces each field.
function parseJSONLoose(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("No JSON object in the reply.");
  return JSON.parse(t.slice(a, b + 1));
}

// Coerce the model's array into the row shape the browser edits. Defensive on
// purpose: a missing or oddly-typed field must never break the review table.
function normalizeCompanies(list) {
  const FLAGS = ["OK", "DM Outside LA", "DM International", "Unclear"];
  const CONF = ["high", "medium", "low"];
  function str(v) { return v == null ? "" : String(v).trim(); }
  function num(v) {
    const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[, ]/g, ""));
    return isFinite(n) && n >= 0 ? Math.round(n) : null;
  }
  return (Array.isArray(list) ? list : [])
    .map(function (c) {
      c = c && typeof c === "object" ? c : {};
      const name = str(c.company || c.name);
      if (!name) return null;
      const flag = FLAGS.indexOf(str(c.flag)) >= 0 ? str(c.flag) : "Unclear";
      const conf = CONF.indexOf(str(c.confidence).toLowerCase()) >= 0 ? str(c.confidence).toLowerCase() : "low";
      return {
        company: name,
        suite: str(c.suite),
        // Domains are HubSpot's company dedupe key — normalize hard.
        domain: str(c.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
        website: str(c.website),
        industry: str(c.industry),
        description: str(c.description),
        hq_city: str(c.hq_city),
        hq_state: str(c.hq_state),
        hq_country: str(c.hq_country),
        la_employees: num(c.la_employees),
        employees_total: num(c.employees_total),
        dm_titles: str(c.dm_titles),
        dm_location: str(c.dm_location),
        flag: flag,
        confidence: conf,
        notes: str(c.notes),
        sources: (Array.isArray(c.sources) ? c.sources : []).map(str).filter(Boolean).slice(0, 3),
        include: true
      };
    })
    .filter(Boolean);
}

// Write the job's outcome back to the row (service_role). Always clears the
// staged photos so multi-MB blobs don't linger. The browser polls this row.
async function finishJob(jobId, patch) {
  await sb.rest("bd_directory_scans?id=eq." + encodeURIComponent(jobId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(Object.assign({ photos: null }, patch))
  });
}

// Background function: Netlify replies 202 before this runs, so return values
// never reach the browser — every outcome must land on the job row instead.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);   // broker must be signed in
  if (!user) { console.log("bd-directory-scan: unauthorized"); return { statusCode: 401, body: "unauthorized" }; }

  const jobId = String(body.jobId || "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) { console.log("bd-directory-scan: bad jobId"); return { statusCode: 400, body: "bad jobId" }; }

  // Load the staged row. service_role bypasses RLS, so verify ownership: the
  // row's org must be the caller's org (same defense-in-depth as the deal fns).
  let job = null, profile = null;
  try {
    const r = await sb.rest("bd_directory_scans?id=eq." + encodeURIComponent(jobId) +
      "&select=id,org_id,building_name,address,submarket,note,photos,status&limit=1");
    job = r.data && r.data[0];
    const p = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
    profile = p.data && p.data[0];
  } catch (e) { /* handled below */ }
  if (!job) { console.log("bd-directory-scan: job not found", jobId); return { statusCode: 404, body: "no job" }; }
  if (!profile || !profile.org_id || profile.org_id !== job.org_id) {
    console.log("bd-directory-scan: job/org mismatch");
    return { statusCode: 403, body: "forbidden" };
  }
  if (job.status !== "queued") { console.log("bd-directory-scan: job already", job.status); return { statusCode: 200, body: "done" }; }

  if (!process.env.ANTHROPIC_API_KEY) {
    await finishJob(jobId, { status: "error", error: "AI isn't configured yet (missing API key)." });
    return { statusCode: 200, body: "no key" };
  }

  const photos = Array.isArray(job.photos) ? job.photos.filter(function (p) { return p && p.data && p.media_type; }) : [];
  if (!photos.length) {
    await finishJob(jobId, { status: "error", error: "Attach a photo of the directory first." });
    return { statusCode: 200, body: "empty" };
  }
  const totalB64 = photos.reduce(function (n, p) { return n + String(p.data).length; }, 0);
  if (totalB64 > MAX_B64) {
    await finishJob(jobId, { status: "error", error: friendlyAnthropicError("request too large", 413) });
    return { statusCode: 200, body: "too big" };
  }
  job.photos = photos;

  // Claim the job before the long pass so a duplicate invoke bails at the
  // status check above rather than running the research (and the bill) twice.
  await sb.rest("bd_directory_scans?id=eq." + encodeURIComponent(jobId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ status: "running" })
  });

  let result;
  try {
    result = await scanWithClaude(job);
  } catch (e) {
    console.log("bd-directory-scan: failed:", e.message);
    await finishJob(jobId, { status: "error", error: friendlyAnthropicError(e.message, e.status) });
    return { statusCode: 200, body: "scan failed" };
  }

  const companies = normalizeCompanies(result && result.companies);
  if (!companies.length) {
    await finishJob(jobId, {
      status: "error",
      error: "No tenant names could be read off that photo — is the directory board in frame and in focus?",
      raw: result || null
    });
    return { statusCode: 200, body: "no tenants" };
  }

  const unreadable = (Array.isArray(result && result.unreadable) ? result.unreadable : [])
    .map(function (u) { return String(u == null ? "" : u).trim(); }).filter(Boolean).slice(0, 40);

  // The building block is advisory: only fill in what the broker left blank.
  const patch = { status: "done", error: null, companies: companies, unreadable: unreadable, raw: result };
  const b = (result && result.building) || {};
  if (!job.building_name && b.name) patch.building_name = String(b.name);
  if (!job.address && b.address) patch.address = String(b.address);

  console.log("bd-directory-scan: read", companies.length, "tenants at", job.building_name || job.address || "(unnamed building)");
  await finishJob(jobId, patch);
  return { statusCode: 200, body: "ok" };
};
