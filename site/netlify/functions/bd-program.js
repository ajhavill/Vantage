// Vantage — bd-program. Read-only data for the BD "Program" board: every HubSpot
// contact carrying marketing-program state, grouped client-side by status/step.
// HubSpot stays the control panel (Andrew's call) — this function never writes;
// the UI links each card to its HubSpot record for changes.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auth) + HUBSPOT_PRIVATE_APP_TOKEN.

const sb = require("./_sb");
const hub = require("./_hubspot");

const okJSON = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

const PROPS = [
  "firstname", "lastname", "email", "jobtitle", "company",
  "marketing_program_status", "marketing_program_step", "program_started_date",
  "next_touch_date", "next_touch_type", "associatedcompanyid"
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST." };
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "bad body" }; }

  const user = await sb.userFromToken(body.token);
  if (!user) return { statusCode: 401, body: "unauthorized" };

  if (!hub.configured()) return okJSON({ connected: false, contacts: [] });

  // Everyone with a program status set (any value, including None — the UI buckets them).
  const contacts = [];
  let after = undefined;
  for (let page = 0; page < 5; page++) {
    const req = {
      filterGroups: [{ filters: [{ propertyName: "marketing_program_status", operator: "HAS_PROPERTY" }] }],
      properties: PROPS,
      limit: 100
    };
    if (after) req.after = after;
    const r = await hub.hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(req) });
    if (!r.ok) return okJSON({ connected: true, error: "HubSpot search failed (" + r.status + ")", contacts: [] });
    (r.data.results || []).forEach((c) => {
      const p = c.properties || {};
      contacts.push({
        id: c.id,
        name: ((p.firstname || "") + " " + (p.lastname || "")).trim() || p.email || ("Contact " + c.id),
        email: p.email || null,
        title: p.jobtitle || null,
        company: p.company || null,
        hs_company_id: p.associatedcompanyid || null,
        status: p.marketing_program_status || null,
        step: p.marketing_program_step != null && p.marketing_program_step !== "" ? parseInt(p.marketing_program_step, 10) : null,
        started: p.program_started_date || null,
        next_touch_date: p.next_touch_date || null,
        next_touch_type: p.next_touch_type || null
      });
    });
    after = r.data.paging && r.data.paging.next && r.data.paging.next.after;
    if (!after) break;
  }

  return okJSON({ connected: true, contacts: contacts, portalId: process.env.HUBSPOT_PORTAL_ID || "245913727" });
};
