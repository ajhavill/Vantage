// Vantage — bd-overview. One POST = everything the BD Command Center renders:
//   * queue    — pending touches (the morning queue) + recent activity
//   * funnel   — live HubSpot contact counts per marketing_program_status option
//   * health   — last run of each automation job (bd_job_runs) + data-freshness
//                probes (market_spaces ingest, tenant_companies sync)
//   * config   — which integrations are wired (HubSpot / Resend / Anthropic),
//                so the system map can show honest green/amber/gray states
//
// Read-only aggregation; auth is a broker Supabase token (same pattern as the
// deal-* functions). HubSpot funnel counts are best-effort — if the token is
// missing or a search fails, the UI shows the section as "not connected".
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; optional HUBSPOT_PRIVATE_APP_TOKEN,
// RESEND_API_KEY, ANTHROPIC_API_KEY (reported in config flags only).

const sb = require("./_sb");
const hub = require("./_hubspot");

const okJSON = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

async function hubspotFunnel() {
  if (!hub.configured()) return { connected: false, options: [] };
  const def = await hub.hs("/crm/v3/properties/contacts/marketing_program_status");
  if (!def.ok || !def.data || !Array.isArray(def.data.options)) return { connected: true, options: [], error: "status property unreadable" };

  const options = [];
  for (const o of def.data.options) {
    const r = await hub.hs("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "marketing_program_status", operator: "EQ", value: o.value }] }], limit: 1, properties: ["email"] })
    });
    options.push({ value: o.value, label: o.label, count: (r.ok && r.data && r.data.total) || 0 });
  }
  // due now (today or overdue)
  const due = await hub.hs("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "next_touch_date", operator: "LTE", value: String(Date.now()) }] }], limit: 1, properties: ["email"] })
  });
  return { connected: true, options: options, dueNow: (due.ok && due.data && due.data.total) || 0 };
}

// Latest row per job from bd_job_runs.
async function jobHealth() {
  const r = await sb.rest("bd_job_runs?select=job,ok,note,counts,ran_at&order=ran_at.desc&limit=40");
  const latest = {};
  (r.data || []).forEach((row) => { if (!latest[row.job]) latest[row.job] = row; });
  return latest;
}

// Freshness probes on sibling systems (best-effort; tables may not exist yet).
async function probe(path, field) {
  try {
    const r = await sb.rest(path);
    const v = r.ok && r.data && r.data[0] && r.data[0][field];
    return v || null;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };
  const pr = await sb.rest("profiles?id=eq." + user.id + "&select=org_id&limit=1");
  const orgId = pr.data && pr.data[0] && pr.data[0].org_id;
  if (!orgId) return { statusCode: 403, body: "no org" };

  const [queueR, actR, runs, funnel, spacesFresh, companiesFresh] = await Promise.all([
    sb.rest("bd_queue?org_id=eq." + orgId + "&status=eq.pending&select=*&order=due_date.asc,created_at.asc&limit=100"),
    sb.rest("bd_queue?org_id=eq." + orgId + "&status=neq.pending&select=id,contact_name,company_name,touch_type,step,step_label,status,sent_at,due_date,source&order=updated_at.desc&limit=20"),
    jobHealth(),
    hubspotFunnel().catch(() => ({ connected: hub.configured(), options: [], error: "funnel failed" })),
    probe("market_spaces?select=created_at&order=created_at.desc&limit=1", "created_at"),
    probe("tenant_companies?select=updated_at&order=updated_at.desc&limit=1", "updated_at")
  ]);

  return okJSON({
    queue: queueR.data || [],
    activity: actR.data || [],
    runs: runs,
    funnel: funnel,
    freshness: { market_spaces: spacesFresh, tenant_companies: companiesFresh },
    config: {
      hubspot: hub.configured(),
      resend: !!process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM || process.env.EMAIL_FROM || null,
      anthropic: !!process.env.ANTHROPIC_API_KEY
    }
  });
};
