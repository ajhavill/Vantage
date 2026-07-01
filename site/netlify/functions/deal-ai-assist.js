// Vantage — deal-ai-assist (synchronous Netlify function).
//
// The broker's in-app AI assistant. Given the broker's question and (optionally)
// the deal they're looking at, it loads that deal's live data server-side
// (buildings, proposals/rounds, checklist, tasks, lease abstract) — or a pipeline
// overview when no deal is in focus — and asks Claude to advise the BROKER.
//
// Fast model (Sonnet) + bounded tokens so it returns within the sync timeout;
// the heavyweight proposal drafting stays on Opus in deal-ai-draft-background.
// Requires env var ANTHROPIC_API_KEY (+ SUPABASE_URL / SERVICE_ROLE via _sb).

const sb = require("./_sb");

function arr(r) { return (r && Array.isArray(r.data)) ? r.data : []; }
function money(v) { return v == null ? "n/a" : "$" + Number(v).toLocaleString(); }
function psf(v) { return v == null ? "n/a" : "$" + Number(v).toFixed(2); }

async function callClaude(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1800, system: system, messages: messages })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ("Anthropic HTTP " + res.status));
  if (data && data.stop_reason === "refusal") throw new Error("The model declined this request.");
  const t = (data.content || []).filter((b) => b.type === "text")[0];
  return (t && t.text) ? t.text : "(no response)";
}

function fmtRound(r) {
  return "  - Round " + r.round_no + " (" + (r.from_party === "landlord" ? "Landlord" : "Tenant") + ", " + (r.status || "") + "): " +
    "basis " + (r.rent_basis || "?") + ", base " + psf(r.base_rent_psf) + "/SF, opex " + psf(r.opex_psf) +
    ", size " + (r.size_sf != null ? r.size_sf + " SF" : "n/a") + ", term " + (r.term_months != null ? r.term_months + "mo" : "n/a") +
    ", esc " + (r.annual_escalation_pct != null ? r.annual_escalation_pct + "%" : "n/a") +
    ", free " + (r.free_rent_months != null ? r.free_rent_months + "mo" : "n/a") + ", TI " + (r.ti_psf != null ? psf(r.ti_psf) : "n/a") +
    (r.summary ? (" — " + r.summary) : "");
}

async function dealContext(dealId, userId) {
  const dr = await sb.rest("deals?id=eq." + encodeURIComponent(dealId) + "&select=*&limit=1");
  const deal = arr(dr)[0];
  if (!deal) return { error: "notfound" };
  if (deal.owner_id !== userId) {
    const pr = await sb.rest("profiles?id=eq." + userId + "&select=role,org_id&limit=1");
    const prof = arr(pr)[0];
    const admin = prof && (prof.role === "platform_admin" || (prof.role === "org_admin" && prof.org_id === deal.org_id));
    if (!admin) return { error: "forbidden" };
  }
  const rr = await Promise.all([
    sb.rest("deal_properties?deal_id=eq." + dealId + "&select=name,address,status&order=sort_order.asc"),
    sb.rest("proposals?deal_id=eq." + dealId + "&select=id,title,status&order=created_at.asc"),
    sb.rest("proposal_rounds?deal_id=eq." + dealId + "&select=proposal_id,round_no,from_party,status,rent_basis,base_rent_psf,opex_psf,size_sf,term_months,annual_escalation_pct,free_rent_months,ti_psf,summary&order=round_no.asc"),
    sb.rest("deal_steps?deal_id=eq." + dealId + "&select=phase,label,status,due_date&order=sort_order.asc"),
    sb.rest("deal_tasks?deal_id=eq." + dealId + "&select=title,due_date,done,priority&order=due_date.asc"),
    sb.rest("lease_abstracts?deal_id=eq." + dealId + "&select=premises,size_sf,commencement_date,expiration_date,base_rent_psf,escalations,options&limit=1")
  ]);
  const props = arr(rr[0]), proposals = arr(rr[1]), rounds = arr(rr[2]), steps = arr(rr[3]), tasks = arr(rr[4]), abst = arr(rr[5])[0];

  let t = "DEAL: " + (deal.client_name || "(unnamed client)") + "\n";
  t += "Stage: " + (deal.stage || "?") + "\n";
  t += "Commission: " + (deal.commission_amount != null ? money(deal.commission_amount) : (deal.commission_pct != null ? deal.commission_pct + "%" : "not set")) +
    (deal.commission_status ? (" (" + deal.commission_status + ")") : "") + (deal.deal_value != null ? ("; deal value " + money(deal.deal_value)) : "") + "\n";

  if (props.length) t += "\nBUILDINGS:\n" + props.map((p) => "  - " + p.name + (p.address ? (" (" + p.address + ")") : "") + (p.status ? (" [" + p.status + "]") : "")).join("\n") + "\n";

  if (proposals.length) {
    t += "\nPROPOSALS & ROUNDS:\n";
    proposals.forEach((pr) => {
      t += " " + (pr.title || "Proposal") + " [" + (pr.status || "") + "]\n";
      const rs = rounds.filter((r) => r.proposal_id === pr.id);
      t += rs.length ? (rs.map(fmtRound).join("\n") + "\n") : "  (no rounds logged)\n";
    });
  }

  if (steps.length) {
    const done = steps.filter((s) => s.status === "done").length;
    const open = steps.filter((s) => s.status !== "done" && s.status !== "na");
    t += "\nCHECKLIST: " + done + "/" + steps.length + " done. Not yet done: " +
      (open.length ? open.slice(0, 12).map((s) => s.label + (s.due_date ? (" (due " + s.due_date + ")") : "")).join("; ") : "none") + "\n";
  }
  const openTasks = tasks.filter((x) => !x.done);
  if (openTasks.length) t += "\nOPEN TASKS: " + openTasks.map((x) => x.title + (x.due_date ? (" (due " + x.due_date + ")") : "")).join("; ") + "\n";

  if (abst) t += "\nLEASE ABSTRACT: premises " + (abst.premises || "n/a") + ", size " + (abst.size_sf != null ? abst.size_sf + " SF" : "n/a") +
    ", term " + (abst.commencement_date || "?") + " to " + (abst.expiration_date || "?") + ", base " + psf(abst.base_rent_psf) +
    ", escalations " + (abst.escalations || "n/a") + (abst.options ? ("; options: " + abst.options) : "") + "\n";

  return { label: deal.client_name || "this deal", text: t };
}

async function pipelineContext(userId) {
  const dr = await sb.rest("deals?owner_id=eq." + userId + "&select=client_name,stage,commission_amount,commission_pct,commission_status&order=created_at.desc");
  const deals = arr(dr);
  const tr = await sb.rest("deal_tasks?owner_id=eq." + userId + "&done=is.false&select=title,due_date");
  const tasks = arr(tr);
  const active = deals.filter((d) => d.stage !== "dead" && d.stage !== "executed");
  let t = "BROKER PIPELINE OVERVIEW\n";
  t += "Active deals: " + active.length + " (of " + deals.length + " total)\n";
  if (deals.length) t += "\nDEALS:\n" + deals.map((d) => "  - " + (d.client_name || "(unnamed)") + " — stage " + d.stage +
    (d.commission_amount != null ? (", commission " + money(d.commission_amount)) : "") + (d.commission_status ? (" [" + d.commission_status + "]") : "")).join("\n") + "\n";
  if (tasks.length) t += "\nOPEN TASKS: " + tasks.map((x) => x.title + (x.due_date ? (" (due " + x.due_date + ")") : "")).join("; ") + "\n";
  return { label: "your pipeline", text: t };
}

const SYSTEM =
  "You are Vantage AI, an expert commercial real estate tenant-representation advisor embedded in Havill & Co.'s deal platform. " +
  "You advise the BROKER (not the client) on how to move deals forward. Be concise, practical, and specific — a busy broker is reading. " +
  "When asked to draft an email or message, output ready-to-send text with a subject line where appropriate. When asked for next steps or " +
  "risks, give a short prioritized list. Use ONLY the facts in the provided context; never invent specific figures that aren't given — if a " +
  "number is unknown, say so or mark [TBD]. Prefer clean markdown (short paragraphs, bold labels, tight bullets). If the context is thin, say what you'd need.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };
  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 200, body: JSON.stringify({ error: "AI isn't configured yet (missing API key)." }) };

  const question = (body.question || "").toString().trim();
  if (!question) return { statusCode: 200, body: JSON.stringify({ error: "Ask a question." }) };

  let ctx;
  try {
    if (body.dealId) {
      ctx = await dealContext(String(body.dealId), user.id);
      if (ctx && ctx.error === "forbidden") return { statusCode: 200, body: JSON.stringify({ error: "You don't have access to that deal." }) };
      if (!ctx || ctx.error) ctx = await pipelineContext(user.id);
    } else {
      ctx = await pipelineContext(user.id);
    }
  } catch (e) { ctx = { label: "your work", text: "(context unavailable)" }; }

  const history = Array.isArray(body.history)
    ? body.history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-6)
    : [];
  const messages = history.concat([{ role: "user", content: question }]);
  const system = SYSTEM + "\n\nCURRENT CONTEXT (" + (ctx.label || "") + "):\n" + (ctx.text || "(none)");

  try {
    const text = await callClaude(system, messages);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, context: ctx.label }) };
  } catch (e) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: e.message || "The assistant hit an error. Try again." }) };
  }
};
