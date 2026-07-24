// Shared BD cadence logic for Vantage functions (bd-cadence, bd-queue-act,
// bd-overview) and for tools/bd-test.js. Pure — no I/O, no env vars.
//
// The 10-step Havill & Co. marketing program (v2, brochure-led, ~61 days).
// HubSpot contacts carry the state machine: marketing_program_step is the LAST
// COMPLETED step (empty/0 = not started), next_touch_date is when the NEXT touch
// is due. The engine drafts the due touch into bd_queue; completing the queue row
// advances the contact (step -> step+1, next_touch_date -> today + gap).
//
// Files prefixed with "_" are NOT deployed as their own functions by Netlify.

// step -> what the touch is + days until the FOLLOWING touch. Day offsets:
// D1, D9, D15, D22, D28, D35, D41, D48, D54, D61 (per the 2026-07-06 program).
var PLAN = {
  1:  { type: "mail",  gap: 8, label: "Brochure + hand-written note" },
  2:  { type: "call",  gap: 6, label: "Call #1 — reference the brochure (VM ok, bridge email after)" },
  3:  { type: "email", gap: 7, label: "Email #1 — submarket snapshot" },
  4:  { type: "call",  gap: 6, label: "Call #2 — no voicemail" },
  5:  { type: "email", gap: 7, label: "Email #2 — building-specific hook" },
  6:  { type: "mail",  gap: 6, label: "Unique-value letter, hand-signed" },
  7:  { type: "call",  gap: 7, label: "Call #3 — VM referencing the letter" },
  8:  { type: "email", gap: 6, label: "Email #3 — direct meeting ask" },
  9:  { type: "call",  gap: 7, label: "Call #4 — no voicemail" },
  10: { type: "email", gap: 0, label: "Email #4 — professional breakup" }
};
var LAST_STEP = 10;

// Program states that PAUSE the cadence. Matched loosely against the HubSpot
// option value/label so we never depend on internal option names: any reply,
// meeting, conversion, or a finished program stops the machine. "None" means
// "not being marketed" — skip. Empty / "Not started" / "Active" all run.
function isPaused(status) {
  var s = String(status || "").toLowerCase();
  if (!s) return false;
  if (/^none$/.test(s.trim())) return true;
  return /respond|meeting|convert|never/.test(s);
}

// {{merge}} fields. Unknown fields render as "" so a template never ships
// literal braces to a prospect.
function mergeTemplate(str, ctx) {
  return String(str || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, function (m, k) {
    var v = ctx && ctx[k.toLowerCase()];
    return v == null ? "" : String(v);
  });
}

function toDate(s) {
  if (!s) return null;
  var d = new Date(String(s).slice(0, 10) + "T00:00:00Z");
  return isNaN(d) ? null : d;
}
function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

// Decide which queue rows to draft today. contacts = HubSpot contact objects
// ({id, properties:{...}}), templatesByStep = {step: {subject, body, touch_type}},
// today = Date at UTC midnight. Returns { rows: [...], skipped: [{id, why}] }.
function planTouches(contacts, templatesByStep, today) {
  var rows = [], skipped = [];
  (contacts || []).forEach(function (c) {
    var p = (c && c.properties) || {};
    var id = c && c.id;
    if (!id) return;
    if (isPaused(p.marketing_program_status)) { skipped.push({ id: id, why: "paused: " + p.marketing_program_status }); return; }

    var due = toDate(p.next_touch_date);
    if (!due || due.getTime() > today.getTime()) { skipped.push({ id: id, why: "not due" }); return; }

    var done = parseInt(p.marketing_program_step, 10);
    if (!isFinite(done) || done < 0) done = 0;
    if (done >= LAST_STEP) { skipped.push({ id: id, why: "program complete" }); return; }

    var step = done + 1;
    var plan = PLAN[step];
    if (plan.type === "mail" && String(p.do_not_mail).toLowerCase() === "true") { skipped.push({ id: id, why: "do_not_mail" }); return; }
    if (plan.type === "call" && String(p.do_not_call_vantage).toLowerCase() === "true") { skipped.push({ id: id, why: "do_not_call" }); return; }

    var first = p.firstname || (p.email ? p.email.split("@")[0] : "");
    var ctx = {
      first_name: first,
      last_name: p.lastname || "",
      company: p.company || p.company_name || "",
      submarket: p.submarket || "Santa Monica",
      title: p.jobtitle || ""
    };
    var tpl = (templatesByStep && templatesByStep[step]) || {};
    var subject = plan.type === "email" ? mergeTemplate(tpl.subject || plan.label, ctx) : null;
    var body = mergeTemplate(tpl.body || plan.label, ctx);

    rows.push({
      hs_contact_id: String(id),
      hs_company_id: p.associatedcompanyid ? String(p.associatedcompanyid) : null,
      contact_name: ((p.firstname || "") + " " + (p.lastname || "")).trim() || p.email || ("Contact " + id),
      company_name: ctx.company || null,
      email: p.email || null,
      phone: p.phone || p.mobilephone || null,
      touch_type: plan.type,
      source: "cadence",
      step: step,
      step_label: "Step " + step + "/" + LAST_STEP + " — " + plan.label,
      due_date: iso(due),
      subject: subject,
      body: body,
      status: "pending",
      dedup_key: id + "|" + step + "|" + iso(due)
    });
  });
  return { rows: rows, skipped: skipped };
}

// After completing queue row `step` on `today`: what to write back to HubSpot.
// done=true means the program just finished (breakup sent) — no further touches.
function advance(step, today) {
  var s = parseInt(step, 10);
  if (!isFinite(s) || s < 1) s = 1;
  if (s >= LAST_STEP) return { step: LAST_STEP, done: true, next_touch_date: null, next_touch_type: null };
  var next = PLAN[s + 1];
  return {
    step: s,
    done: false,
    next_touch_date: iso(addDays(today, PLAN[s].gap)),
    next_touch_type: next.type.charAt(0).toUpperCase() + next.type.slice(1) // Call / Email / Mail
  };
}

module.exports = { PLAN: PLAN, LAST_STEP: LAST_STEP, isPaused: isPaused, mergeTemplate: mergeTemplate, planTouches: planTouches, advance: advance, toDate: toDate, iso: iso, addDays: addDays };
