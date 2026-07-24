// Vantage — bd-cadence (Netlify SCHEDULED function, runs daily; also callable
// from the BD Command Center's "Run engine now" button with a broker token).
//
// The marketing-program engine. Each run it:
//   1. Pulls every HubSpot contact whose next_touch_date is due (and whose
//      program isn't paused by a reply/meeting/conversion — see _bd.isPaused).
//   2. Drafts the due touch from bd_templates (+merge fields) into bd_queue —
//      emails arrive pre-written, calls arrive with talking points, mail items
//      arrive as print instructions.
//   3. Logs a heartbeat to bd_job_runs so the Command Center can show it working.
//
// It NEVER sends anything. Sending/completing happens in bd-queue-act when
// Andrew approves a row (which is also what advances the HubSpot state machine).
// Re-runs are idempotent: bd_queue upserts on (org_id, dedup_key) and never
// overwrites a draft that's already there (Andrew may have edited it).
//
// Scheduled via netlify.toml ([functions."bd-cadence"] schedule="@daily").
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / HUBSPOT_PRIVATE_APP_TOKEN;
// optional BD_ORG_ID (defaults to the first org — Havill-only for now).

const sb = require("./_sb");
const hub = require("./_hubspot");
const bd = require("./_bd");

const okJSON = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

const CONTACT_PROPS = [
  "firstname", "lastname", "email", "phone", "mobilephone", "company", "jobtitle",
  "marketing_program_status", "marketing_program_step", "next_touch_date", "next_touch_type",
  "do_not_mail", "do_not_call_vantage", "associatedcompanyid"
];

async function orgId() {
  if (process.env.BD_ORG_ID) return process.env.BD_ORG_ID;
  const r = await sb.rest("orgs?select=id&order=created_at.asc&limit=1");
  return (r.data && r.data[0] && r.data[0].id) || null;
}

async function logRun(org, ok, note, counts) {
  try {
    await sb.rest("bd_job_runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ org_id: org, job: "bd-cadence", ok: ok, note: note || null, counts: counts || null })
    });
  } catch (e) { /* heartbeat is best-effort */ }
}

async function dueContacts() {
  // Date props are midnight-UTC millis in HubSpot search; LTE "now" = due today or overdue.
  const body = {
    filterGroups: [{ filters: [{ propertyName: "next_touch_date", operator: "LTE", value: String(Date.now()) }] }],
    properties: CONTACT_PROPS,
    limit: 100
  };
  const r = await hub.hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error("HubSpot search failed (" + r.status + "): " + (r.text || "").slice(0, 200));
  return (r.data && r.data.results) || [];
}

exports.handler = async (event) => {
  // Two legitimate callers only: Netlify's scheduler (its invocation body always
  // carries next_run) and a signed-in broker pressing "Run engine now". Anyone
  // else hitting the public function URL gets a 401 and no engine run.
  let body = {};
  if (event && event.body) { try { body = JSON.parse(event.body); } catch (e) { body = {}; } }
  let manual = false;
  if (body.run === "now") {
    const user = await sb.userFromToken(body.token);
    if (!user) return { statusCode: 401, body: "unauthorized" };
    manual = true;
  } else if (!body.next_run) {
    return { statusCode: 401, body: "unauthorized" };
  }

  const org = await orgId();
  if (!org) return okJSON({ ok: false, error: "No org found." });

  if (!hub.configured()) {
    await logRun(org, false, "HUBSPOT_PRIVATE_APP_TOKEN not set — engine idle", null);
    return okJSON({ ok: false, error: "HubSpot is not connected (HUBSPOT_PRIVATE_APP_TOKEN)." });
  }

  let contacts;
  try { contacts = await dueContacts(); }
  catch (e) {
    await logRun(org, false, String(e.message || e), null);
    return okJSON({ ok: false, error: String(e.message || e) });
  }

  // templates by step
  const tr = await sb.rest("bd_templates?org_id=eq." + org + "&select=step,touch_type,subject,body");
  const byStep = {}; (tr.data || []).forEach((t) => { byStep[t.step] = t; });

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const plan = bd.planTouches(contacts, byStep, today);

  let inserted = 0;
  if (plan.rows.length) {
    const rows = plan.rows.map((r) => Object.assign({ org_id: org }, r));
    const ins = await sb.rest("bd_queue?on_conflict=org_id,dedup_key", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(rows)
    });
    if (!ins.ok) {
      await logRun(org, false, "queue insert failed: " + (ins.text || "").slice(0, 200), { due: plan.rows.length });
      return okJSON({ ok: false, error: "Queue insert failed.", detail: (ins.text || "").slice(0, 200) });
    }
    inserted = Array.isArray(ins.data) ? ins.data.length : 0;
  }

  const counts = { contacts_due: contacts.length, drafted: plan.rows.length, new_in_queue: inserted, skipped: plan.skipped.length };
  await logRun(org, true, manual ? "manual run" : "scheduled run", counts);
  return okJSON({ ok: true, counts: counts, skipped: plan.skipped });
};
