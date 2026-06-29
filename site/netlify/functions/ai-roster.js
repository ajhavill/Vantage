// Vantage — ai-roster (Netlify Function, called by the Cockpit / logged-in broker).
//
// Reads a prospect's uploaded team roster (already extracted to plain text rows
// by SheetJS in the browser) and uses Claude to pull out each team member's
// name, title, home location, and whether they're a critical/key employee.
// The structured result drives the commute analysis (home addresses) and lets
// the broker see who matters at a glance.
//
// We call the Anthropic Messages API directly with fetch — same rationale as
// _sb.js (no SDK in the Netlify Node runtime; avoids bundling/WebSocket pitfalls).
// Gated by the broker's Supabase token. No-op (configured:false) until the
// shared ANTHROPIC_API_KEY env var is set in Netlify.

const { configured, userFromToken } = require("./_sb");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const MODEL = "claude-opus-4-8";

// What we ask Claude to return — a clean, parseable shape for the UI + commute.
const SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person's full name, or best available label." },
          title: { type: "string", description: "Job title / role if present, else empty string." },
          home: { type: "string", description: "Home location for commute analysis — full address, city, or ZIP if present, else empty string." },
          critical: { type: "boolean", description: "True if this person is flagged as key/critical/executive/leadership (a column saying so, or a senior title like CEO/CFO/Founder/Partner/Principal/VP/Head)." }
        },
        required: ["name", "title", "home", "critical"],
        additionalProperties: false
      }
    },
    note: { type: "string", description: "One short sentence on what was found or any ambiguity (e.g. missing home addresses)." }
  },
  required: ["people", "note"],
  additionalProperties: false
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(200, { configured: false });

  let rows = String(body.rows || "").trim();
  if (!rows) return json(400, { error: "No roster text to read." });
  if (rows.length > 60000) rows = rows.slice(0, 60000); // keep the request bounded

  const prompt =
    "You are parsing a commercial real estate prospect's team roster, exported from a spreadsheet to the plain text below. " +
    "Columns may be in any order, unlabeled, or messy. Extract one entry per team member.\n\n" +
    "For each person:\n" +
    "- name: their full name (or the best label available for the row).\n" +
    "- title: their job title or role if present, otherwise an empty string.\n" +
    "- home: the location to use for a commute analysis — a full home address, city, or ZIP if the row has one; otherwise an empty string. Do NOT invent a location.\n" +
    "- critical: true only if the row marks them as a key/critical/VIP/executive/leadership employee (an explicit column saying so, or a clearly senior title such as CEO, CFO, COO, Founder, Owner, Partner, Principal, President, VP, or Head of …).\n\n" +
    "Ignore header rows, blank rows, and totals. If a cell is empty, leave the corresponding field as an empty string (or false for critical).\n\n" +
    "Roster text:\n----\n" + rows + "\n----";

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (e) {
    return json(502, { error: "Could not reach the AI service. Please try again." });
  }

  const text = await resp.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }
  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : ("AI service error (" + resp.status + ").");
    return json(502, { error: msg });
  }

  // A safety refusal returns 200 with stop_reason "refusal" and (usually) empty content.
  if (data && data.stop_reason === "refusal") {
    return json(200, { configured: true, people: [], note: "The roster could not be read automatically." });
  }

  // With output_config.format, the first text block is valid JSON matching SCHEMA.
  const block = data && Array.isArray(data.content) && data.content.find(function (b) { return b.type === "text"; });
  let parsed = null;
  try { parsed = block && block.text ? JSON.parse(block.text) : null; } catch (e) { /* leave null */ }
  if (!parsed || !Array.isArray(parsed.people)) {
    return json(502, { error: "The AI response could not be read. Please try again." });
  }

  return json(200, { configured: true, model: MODEL, people: parsed.people, note: parsed.note || "" });
};
