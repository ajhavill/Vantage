// Vantage — deal-ai-act. Executes a SINGLE action Van proposed, after the broker
// confirmed it in the UI. Validates the broker owns the deal and that any
// referenced id (task/step/proposal) belongs to that deal, then performs it with
// the service role. Additive / reversible operations only.

const sb = require("./_sb");

const STAGES = ["needs", "touring", "evaluating", "proposals", "negotiation", "executed", "dead"];
const STEP_ST = ["done", "active", "pending", "na"];
const COMM_ST = ["pending", "invoiced", "paid"];
const PARTY = ["tenant", "landlord"];
const BASES = ["FSG", "MG", "IG", "NNN", "NN", "N", "GROSS", "ABS", "OTHER"];
const PRIS = ["low", "normal", "high"];

function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
function intn(v) { var n = num(v); return n == null ? null : Math.round(n); }
function today() { return new Date().toISOString().slice(0, 10); }
function okJSON(o) { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) }; }
const WHDR = { "Content-Type": "application/json", Prefer: "return=minimal" };

async function ownsDeal(dealId, user) {
  const r = await sb.rest("deals?id=eq." + encodeURIComponent(dealId) + "&select=id,owner_id,org_id&limit=1");
  const d = r.data && r.data[0];
  if (!d) return null;
  if (d.owner_id === user.id) return d;
  const pr = await sb.rest("profiles?id=eq." + user.id + "&select=role,org_id&limit=1");
  const p = pr.data && pr.data[0];
  if (p && (p.role === "platform_admin" || (p.role === "org_admin" && p.org_id === d.org_id))) return d;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };

  const dealId = String(body.dealId || "");
  const action = body.action || {};
  const type = action.type;
  const p = action.params || {};

  // Resolve the deal this action targets: the open deal, or (for add_task) a deal linked via params.
  const targetDeal = dealId || String((p && p.deal_id) || "");
  if (type !== "add_task" && !targetDeal) return okJSON({ error: "Open a deal first — that action needs a specific deal." });

  let deal = null;
  if (targetDeal) {
    deal = await ownsDeal(targetDeal, user);
    if (!deal) return okJSON({ error: "You don't have access to that deal." });
  }

  try {
    if (type === "add_task") {
      if (!p.title) return okJSON({ error: "The task needs a title." });
      const row = { owner_id: user.id, deal_id: deal ? deal.id : null, title: String(p.title).slice(0, 300), due_date: p.due_date || null, priority: PRIS.indexOf(p.priority) >= 0 ? p.priority : "normal" };
      await sb.rest("deal_tasks", { method: "POST", headers: WHDR, body: JSON.stringify(row) });
      return okJSON({ message: "Added task: " + row.title + (row.due_date ? (" (due " + row.due_date + ")") : "") });
    }

    if (type === "complete_task") {
      const id = String(p.task_id || "");
      const chk = await sb.rest("deal_tasks?id=eq." + encodeURIComponent(id) + "&deal_id=eq." + deal.id + "&select=id,title&limit=1");
      const row = chk.data && chk.data[0];
      if (!row) return okJSON({ error: "Couldn't find that task on this deal." });
      await sb.rest("deal_tasks?id=eq." + encodeURIComponent(id), { method: "PATCH", headers: WHDR, body: JSON.stringify({ done: true, completed_at: new Date().toISOString() }) });
      return okJSON({ message: "Completed task: " + row.title });
    }

    if (type === "set_step_status") {
      const id = String(p.step_id || "");
      const st = STEP_ST.indexOf(p.status) >= 0 ? p.status : "done";
      const chk = await sb.rest("deal_steps?id=eq." + encodeURIComponent(id) + "&deal_id=eq." + deal.id + "&select=id,label&limit=1");
      const row = chk.data && chk.data[0];
      if (!row) return okJSON({ error: "Couldn't find that checklist step on this deal." });
      await sb.rest("deal_steps?id=eq." + encodeURIComponent(id), { method: "PATCH", headers: WHDR, body: JSON.stringify({ status: st, completed_at: st === "done" ? new Date().toISOString() : null }) });
      return okJSON({ message: (st === "done" ? "Checked off: " : ("Marked " + st + ": ")) + row.label });
    }

    if (type === "set_stage") {
      if (STAGES.indexOf(p.stage) < 0) return okJSON({ error: "Unknown stage." });
      await sb.rest("deals?id=eq." + deal.id, { method: "PATCH", headers: WHDR, body: JSON.stringify({ stage: p.stage, updated_at: new Date().toISOString() }) });
      return okJSON({ message: "Moved the deal to “" + p.stage + "”." });
    }

    if (type === "update_commission") {
      const patch = {};
      if (p.commission_amount != null) patch.commission_amount = num(p.commission_amount);
      if (p.commission_pct != null) patch.commission_pct = num(p.commission_pct);
      if (p.deal_value != null) patch.deal_value = num(p.deal_value);
      if (p.commission_status && COMM_ST.indexOf(p.commission_status) >= 0) {
        patch.commission_status = p.commission_status;
        if (p.commission_status === "paid") patch.commission_paid_on = today();
      }
      if (!Object.keys(patch).length) return okJSON({ error: "Nothing to update on the commission." });
      await sb.rest("deals?id=eq." + deal.id, { method: "PATCH", headers: WHDR, body: JSON.stringify(patch) });
      return okJSON({ message: "Updated the commission." });
    }

    if (type === "add_round") {
      const pid = String(p.proposal_id || "");
      const chk = await sb.rest("proposals?id=eq." + encodeURIComponent(pid) + "&deal_id=eq." + deal.id + "&select=id,title&limit=1");
      const pr = chk.data && chk.data[0];
      if (!pr) return okJSON({ error: "Couldn't find that proposal on this deal." });
      let nextNo = 1;
      const rr = await sb.rest("proposal_rounds?proposal_id=eq." + encodeURIComponent(pid) + "&select=round_no&order=round_no.desc&limit=1");
      if (rr.data && rr.data[0]) nextNo = (rr.data[0].round_no || 0) + 1;
      const row = {
        deal_id: deal.id, proposal_id: pid, round_no: nextNo,
        from_party: PARTY.indexOf(p.from_party) >= 0 ? p.from_party : "landlord",
        status: "final", source: "manual",
        rent_basis: BASES.indexOf(p.rent_basis) >= 0 ? p.rent_basis : null,
        base_rent_psf: num(p.base_rent_psf), opex_psf: num(p.opex_psf), size_sf: num(p.size_sf),
        term_months: intn(p.term_months), annual_escalation_pct: num(p.annual_escalation_pct),
        free_rent_months: num(p.free_rent_months), ti_psf: num(p.ti_psf),
        summary: p.summary ? String(p.summary).slice(0, 500) : null, created_by: user.id
      };
      await sb.rest("proposal_rounds", { method: "POST", headers: WHDR, body: JSON.stringify(row) });
      return okJSON({ message: "Logged round " + nextNo + " on " + (pr.title || "the proposal") + "." });
    }

    return okJSON({ error: "That action isn't supported yet." });
  } catch (e) {
    return okJSON({ error: e.message || "The action failed. Try again." });
  }
};
