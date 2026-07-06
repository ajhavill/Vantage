// Vantage — deal-critical-dates (Netlify SCHEDULED function, runs daily).
//
// The compounding asset for a tenant rep: never miss a date, and turn every
// executed lease into future pipeline. Each day it scans lease abstracts and
// deals and, idempotently:
//   1. Creates a task for each lease critical date (option deadlines, renewal
//      notice, expiration) coming up inside the lead window.
//   2. Creates a "start the renewal conversation" task ahead of each executed
//      lease's expiration — automatic re-engagement ~9 months out.
//   3. Emails each broker a short briefing of what's due in the next 7 days.
//
// Scheduled via netlify.toml ([functions."deal-critical-dates"] schedule="@daily").
// Runs with the service_role key (no user present); writes are org-safe because
// every task is stamped with the deal's real owner_id.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (existing); RESEND_API_KEY +
// RESEND_FROM/EMAIL_FROM for the briefing email (best-effort — skipped if unset).

const sb = require("./_sb");

const DAY = 86400000;
const KEYDATE_LEAD_DAYS = 90;    // surface a lease critical date this far ahead
const RENEWAL_MONTHS = 9;        // start the renewal conversation this long before expiry
const RENEWAL_WINDOW_DAYS = 45;  // create the renewal task within this window of the ideal start
const BRIEF_DAYS = 7;            // email items due within this many days

function today0() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }
function iso(d) { return d.toISOString().slice(0, 10); }
function parseDate(s) { if (!s) return null; const d = new Date(String(s).slice(0, 10) + "T00:00:00Z"); return isNaN(d) ? null : d; }
function daysUntil(d, base) { return Math.round((d.getTime() - base.getTime()) / DAY); }
function fmt(d) { return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }); }

async function sendBrief(fromAddr, toAddr, clientName, items) {
  if (!process.env.RESEND_API_KEY) return;
  const lines = items.map((i) => "• " + fmt(i.date) + " — " + i.title + (i.client ? " (" + i.client + ")" : "")).join("\n");
  const text =
    "Your Vantage briefing — " + items.length + " item" + (items.length === 1 ? "" : "s") + " due in the next " + BRIEF_DAYS + " days:\n\n" +
    lines + "\n\nOpen your dashboard to act on these: https://havill-vantage.netlify.app/deals\n\n— Vantage";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddr, to: [toAddr], subject: "Vantage briefing — " + items.length + " coming due", text: text })
    });
  } catch (e) { /* best-effort */ }
}

// Pure core (no I/O) — decides which tasks to create. Exported for tests.
// Returns [{deal_id, owner_id, title, due_date, priority}].
function computeTasks(deals, absts, tasks, base) {
  const dealById = {}; (deals || []).forEach((d) => { dealById[d.id] = d; });
  // idempotency: a task is "already there" if same deal + same title exists (done or not)
  const seen = new Set(); (tasks || []).forEach((t) => seen.add((t.deal_id || "") + "|" + (t.title || "")));

  const toCreate = [];
  function plan(deal, title, dueDate, priority) {
    if (!deal || !deal.owner_id) return;
    const key = deal.id + "|" + title;
    if (seen.has(key)) return;
    seen.add(key);
    toCreate.push({ deal_id: deal.id, owner_id: deal.owner_id, title: title, due_date: iso(dueDate), priority: priority });
  }

  (absts || []).forEach((a) => {
    const deal = dealById[a.deal_id]; if (!deal) return;
    // 1) lease critical dates within the lead window
    (a.key_dates || []).forEach((k) => {
      const d = parseDate(k && k.date); if (!d) return;
      const du = daysUntil(d, base);
      if (du >= 0 && du <= KEYDATE_LEAD_DAYS) plan(deal, "⏰ " + (k.label || "Lease critical date"), d, du <= 30 ? "high" : "normal");
    });
    // expiration as its own reminder
    const exp = parseDate(a.expiration_date);
    if (exp) {
      const du = daysUntil(exp, base);
      if (du >= 0 && du <= KEYDATE_LEAD_DAYS) plan(deal, "⏰ Lease expiration approaching", exp, du <= 60 ? "high" : "normal");
      // 2) renewal outreach — for executed deals, ~9 months before expiry
      if (deal.stage === "executed") {
        const start = new Date(exp.getTime() - RENEWAL_MONTHS * 30 * DAY);
        const dStart = daysUntil(start, base);
        if (dStart <= RENEWAL_WINDOW_DAYS && daysUntil(exp, base) > 60) {
          const due = dStart < 0 ? base : start;   // if we're already past the ideal start, make it due now
          plan(deal, "🔄 Start renewal conversation (lease expires " + fmt(exp) + ")", due, "high");
        }
      }
    }
  });
  return toCreate;
}

exports.handler = async () => {
  if (!sb.configured()) { console.log("critical-dates: Supabase not configured"); return { statusCode: 200, body: "not configured" }; }
  const base = today0();

  // Pull the data (service_role bypasses RLS; we stamp owner_id from the deal).
  let deals = [], absts = [], tasks = [], profiles = [];
  try { deals = (await sb.rest("deals?select=id,owner_id,client_name,stage")).data || []; } catch (e) {}
  try { absts = (await sb.rest("lease_abstracts?select=deal_id,key_dates,expiration_date")).data || []; } catch (e) {}
  try { tasks = (await sb.rest("deal_tasks?select=deal_id,title,due_date,done,owner_id")).data || []; } catch (e) {}
  try { profiles = (await sb.rest("profiles?select=id,email")).data || []; } catch (e) {}

  const dealById = {}; deals.forEach((d) => { dealById[d.id] = d; });
  const emailById = {}; profiles.forEach((p) => { if (p.email) emailById[p.id] = p.email; });

  const toCreate = computeTasks(deals, absts, tasks, base);

  // Write the new tasks
  let created = 0;
  for (const row of toCreate) {
    try {
      const r = await sb.rest("deal_tasks", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(row) });
      if (r.ok) created++;
    } catch (e) { /* skip one, keep going */ }
  }

  // 3) per-broker briefing of everything due within BRIEF_DAYS (existing + new, not done)
  const FROM = process.env.RESEND_FROM || process.env.EMAIL_FROM || "Vantage <onboarding@resend.dev>";
  const briefByOwner = {};
  function addBrief(owner, date, title, client) {
    const du = daysUntil(date, base);
    if (du < 0 || du > BRIEF_DAYS) return;
    (briefByOwner[owner] = briefByOwner[owner] || []).push({ date: date, title: title, client: client });
  }
  tasks.forEach((t) => { if (t.done || !t.due_date || !t.owner_id) return; const d = parseDate(t.due_date); if (d) addBrief(t.owner_id, d, t.title, dealById[t.deal_id] && dealById[t.deal_id].client_name); });
  toCreate.forEach((t) => { const d = parseDate(t.due_date); if (d) addBrief(t.owner_id, d, t.title, dealById[t.deal_id] && dealById[t.deal_id].client_name); });

  let emailed = 0;
  for (const owner of Object.keys(briefByOwner)) {
    const to = emailById[owner]; if (!to) continue;
    const items = briefByOwner[owner].sort((a, b) => a.date - b.date);
    await sendBrief(FROM, to, null, items);
    emailed++;
  }

  console.log("critical-dates: created", created, "tasks, emailed", emailed, "brokers");
  return { statusCode: 200, body: JSON.stringify({ created: created, emailed: emailed }) };
};

// exported for the unit test (tools/deal-critical-dates.test.js)
exports.computeTasks = computeTasks;
exports._helpers = { parseDate: parseDate, daysUntil: daysUntil, iso: iso, today0: today0 };
