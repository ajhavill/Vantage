// Vantage — bd-queue-act. Executes ONE action on a BD queue row for an
// authenticated broker, then advances the contact's marketing-program state in
// HubSpot (step + next_touch_date + next_touch_type; company mirror best-effort).
//
// Actions:
//   save — update an email draft's subject/body (no state change)
//   send — email rows: send via Resend from RESEND_FROM/EMAIL_FROM, mark sent, advance
//   done — call/mail rows: mark completed (call made / piece printed+mailed), advance
//   skip — mark skipped WITHOUT advancing (the touch stays owed; engine re-drafts
//          it tomorrow unless the broker changes the contact in HubSpot)
//
// Program-status writes to HubSpot are deliberately conservative: we only PATCH
// step/date/type (known-safe values). Status transitions (Responded/Never
// responded/...) stay human calls in HubSpot — pausing already works because the
// engine skips paused statuses.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; RESEND_API_KEY + RESEND_FROM or
// EMAIL_FROM to actually send; HUBSPOT_PRIVATE_APP_TOKEN to advance the program.

const sb = require("./_sb");
const hub = require("./_hubspot");
const bd = require("./_bd");

const okJSON = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

async function patchQueue(id, patch) {
  return sb.rest("bd_queue?id=eq." + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
}

// Advance the HubSpot contact after a cadence touch completes. Best-effort: a
// 4xx (e.g. unknown option value on next_touch_type) retries without that field
// so the date/step always land.
async function advanceHubSpot(row) {
  if (!hub.configured() || !row.step || row.source !== "cadence") return { advanced: false, why: "not a cadence touch or HubSpot off" };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const adv = bd.advance(row.step, today);
  const props = { marketing_program_step: String(adv.step) };
  if (adv.next_touch_date) props.next_touch_date = adv.next_touch_date;
  if (adv.next_touch_type) props.next_touch_type = adv.next_touch_type;

  let r = await hub.hs("/crm/v3/objects/contacts/" + row.hs_contact_id, { method: "PATCH", body: JSON.stringify({ properties: props }) });
  if (!r.ok && props.next_touch_type) {
    delete props.next_touch_type;
    r = await hub.hs("/crm/v3/objects/contacts/" + row.hs_contact_id, { method: "PATCH", body: JSON.stringify({ properties: props }) });
  }
  // mirror the rollup to the company (same field names) — best-effort
  if (r.ok && row.hs_company_id) {
    try { await hub.hs("/crm/v3/objects/companies/" + row.hs_company_id, { method: "PATCH", body: JSON.stringify({ properties: props }) }); } catch (e) {}
  }
  return { advanced: r.ok, done: adv.done, why: r.ok ? null : "HubSpot PATCH " + r.status };
}

async function sendEmail(row) {
  if (!process.env.RESEND_API_KEY) return { sent: false, error: "Sending isn't configured (RESEND_API_KEY)." };
  const FROM = process.env.RESEND_FROM || process.env.EMAIL_FROM;
  if (!FROM) return { sent: false, error: "No from-address configured (RESEND_FROM / EMAIL_FROM)." };
  if (!row.email) return { sent: false, error: "Contact has no email address." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [row.email], subject: row.subject || "(no subject)", text: row.body || "" })
    });
    if (!res.ok) return { sent: false, error: "Resend " + res.status + ": " + (await res.text()).slice(0, 200) };
    return { sent: true };
  } catch (e) { return { sent: false, error: String(e.message || e) }; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };

  // broker's org must own the row (service key bypasses RLS, so check explicitly)
  const pr = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
  const orgId = pr.data && pr.data[0] && pr.data[0].org_id;
  if (!orgId) return { statusCode: 403, body: "no org" };

  const action = String(body.action || "");

  // Approve-all: send every pending EMAIL in the org's queue (calls and mail
  // stay individual — they're physical actions). Batches of 15 per invocation
  // to stay inside the function time budget; the UI re-calls while remaining>0.
  if (action === "send_all") {
    const allR = await sb.rest("bd_queue?org_id=eq." + orgId + "&status=eq.pending&touch_type=eq.email&select=*&order=due_date.asc&limit=100");
    const all = allR.data || [];
    const batch = all.slice(0, 15);
    let sent = 0; const failed = [];
    for (const r of batch) {
      const s = await sendEmail(r);
      if (!s.sent) { await patchQueue(r.id, { status: "failed", error: s.error }); failed.push({ id: r.id, contact: r.contact_name, error: s.error }); continue; }
      const adv = await advanceHubSpot(r);
      await patchQueue(r.id, { status: "sent", sent_at: new Date().toISOString(), error: adv.advanced ? null : (adv.why || null) });
      sent++;
    }
    return okJSON({ ok: true, sent: sent, failed: failed, remaining: Math.max(0, all.length - batch.length) });
  }

  const qr = await sb.rest("bd_queue?id=eq." + encodeURIComponent(body.id || "") + "&select=*&limit=1");
  const row = qr.data && qr.data[0];
  if (!row || row.org_id !== orgId) return okJSON({ error: "Queue item not found." });

  if (action === "save") {
    const r = await patchQueue(row.id, { subject: body.subject != null ? String(body.subject) : row.subject, body: body.body != null ? String(body.body) : row.body });
    return okJSON({ ok: r.ok, row: r.data && r.data[0] });
  }

  if (action === "skip") {
    const r = await patchQueue(row.id, { status: "skipped" });
    return okJSON({ ok: r.ok, row: r.data && r.data[0] });
  }

  if (action === "send") {
    if (row.touch_type !== "email") return okJSON({ error: "Only email touches can be sent — use 'done' for calls and mail." });
    if (row.status === "sent") return okJSON({ error: "Already sent." });
    const s = await sendEmail(row);
    if (!s.sent) {
      await patchQueue(row.id, { status: "failed", error: s.error });
      return okJSON({ error: s.error });
    }
    const adv = await advanceHubSpot(row);
    const r = await patchQueue(row.id, { status: "sent", sent_at: new Date().toISOString(), error: adv.advanced ? null : (adv.why || null) });
    return okJSON({ ok: true, row: r.data && r.data[0], advanced: adv.advanced, programDone: !!adv.done });
  }

  if (action === "done") {
    if (row.touch_type === "email") return okJSON({ error: "Email touches are completed with 'send'." });
    if (row.status === "done") return okJSON({ error: "Already done." });
    const adv = await advanceHubSpot(row);
    const r = await patchQueue(row.id, { status: "done", sent_at: new Date().toISOString(), error: adv.advanced ? null : (adv.why || null) });
    return okJSON({ ok: true, row: r.data && r.data[0], advanced: adv.advanced, programDone: !!adv.done });
  }

  return okJSON({ error: "Unknown action." });
};
