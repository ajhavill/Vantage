// Shared BD cadence logic for Vantage functions (bd-cadence, bd-queue-act,
// bd-overview) and for tools/bd-test.js. Pure — no I/O, no env vars.
//
// Since the program BUILDER (bd-builder.sql), the program definition lives in
// bd_templates rows: label, day_offset (ordering truth), touch_type, copy, and
// an optional attachment. The engine works off a STEPS array built by
// stepsFrom(rows); DEFAULT_STEPS (the original v2 10-step program) is the
// fallback when an org has no rows.
//
// State contract (unchanged): HubSpot marketing_program_step = the POSITION of
// the last COMPLETED step (1-based, empty/0 = not started); next_touch_date is
// when the next touch is due. Completing queue position P sets step=P and
// next_touch_date = today + (steps[P].day_offset - steps[P-1].day_offset).
//
// Files prefixed with "_" are NOT deployed as their own functions by Netlify.

var DEFAULT_STEPS = [
  { day_offset: 1,  type: "mail",  label: "Brochure + hand-written note" },
  { day_offset: 9,  type: "call",  label: "Call #1 — reference the brochure (VM ok, bridge email after)" },
  { day_offset: 15, type: "email", label: "Email #1 — submarket snapshot" },
  { day_offset: 22, type: "call",  label: "Call #2 — no voicemail" },
  { day_offset: 28, type: "email", label: "Email #2 — building-specific hook" },
  { day_offset: 35, type: "mail",  label: "Unique-value letter, hand-signed" },
  { day_offset: 41, type: "call",  label: "Call #3 — VM referencing the letter" },
  { day_offset: 48, type: "email", label: "Email #3 — direct meeting ask" },
  { day_offset: 54, type: "call",  label: "Call #4 — no voicemail" },
  { day_offset: 61, type: "email", label: "Email #4 — professional breakup" }
].map(function (s, i) { return { pos: i + 1, day_offset: s.day_offset, type: s.type, label: s.label, subject: null, body: s.label, attachment_path: null }; });

// Build the ordered steps array from bd_templates rows. day_offset is the
// ordering truth (display `step` may lag after builder edits); rows without a
// day_offset sort by their legacy step number after all dated rows.
function stepsFrom(rows) {
  var list = (rows || []).slice().filter(function (r) { return r && (r.body != null || r.label); });
  if (!list.length) return DEFAULT_STEPS;
  list.sort(function (a, b) {
    var da = a.day_offset != null ? a.day_offset : 1000 + (a.step || 0);
    var db = b.day_offset != null ? b.day_offset : 1000 + (b.step || 0);
    if (da !== db) return da - db;
    return (a.step || 0) - (b.step || 0);
  });
  return list.map(function (r, i) {
    return {
      pos: i + 1,
      day_offset: r.day_offset != null ? r.day_offset : (i ? list[i - 1].day_offset + 7 : 1),
      type: ["email", "call", "mail"].indexOf(r.touch_type) >= 0 ? r.touch_type : "email",
      label: r.label || ("Step " + (i + 1)),
      subject: r.subject || null,
      body: r.body || r.label || "",
      attachment_path: r.attachment_path || null
    };
  });
}

// Program states that PAUSE the cadence (matched loosely so we never depend on
// HubSpot internal option names). "None" = not being marketed — skip.
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
// ({id, properties:{...}}), steps = stepsFrom(bd_templates rows), today = Date
// at UTC midnight. Returns { rows: [...], skipped: [{id, why}] }.
function planTouches(contacts, steps, today) {
  steps = steps && steps.length ? steps : DEFAULT_STEPS;
  var last = steps.length;
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
    if (done >= last) { skipped.push({ id: id, why: "program complete" }); return; }

    var step = steps[done]; // next undone step (0-indexed array, 1-based pos)
    if (step.type === "mail" && String(p.do_not_mail).toLowerCase() === "true") { skipped.push({ id: id, why: "do_not_mail" }); return; }
    if (step.type === "call" && String(p.do_not_call_vantage).toLowerCase() === "true") { skipped.push({ id: id, why: "do_not_call" }); return; }

    var first = p.firstname || (p.email ? p.email.split("@")[0] : "");
    var ctx = {
      first_name: first,
      last_name: p.lastname || "",
      company: p.company || p.company_name || "",
      submarket: p.submarket || "Santa Monica",
      title: p.jobtitle || ""
    };
    var subject = step.type === "email" ? mergeTemplate(step.subject || step.label, ctx) : null;
    var body = mergeTemplate(step.body || step.label, ctx);

    rows.push({
      hs_contact_id: String(id),
      hs_company_id: p.associatedcompanyid ? String(p.associatedcompanyid) : null,
      contact_name: ((p.firstname || "") + " " + (p.lastname || "")).trim() || p.email || ("Contact " + id),
      company_name: ctx.company || null,
      email: p.email || null,
      phone: p.phone || p.mobilephone || null,
      touch_type: step.type,
      source: "cadence",
      step: step.pos,
      step_label: "Step " + step.pos + "/" + last + " — " + step.label,
      due_date: iso(due),
      subject: subject,
      body: body,
      attachment_path: step.attachment_path || null,
      status: "pending",
      dedup_key: id + "|" + step.pos + "|" + iso(due)
    });
  });
  return { rows: rows, skipped: skipped };
}

// After completing queue position `pos` on `today`: what to write back to
// HubSpot. done=true means the program just finished — no further touches.
function advance(pos, steps, today) {
  steps = steps && steps.length ? steps : DEFAULT_STEPS;
  var last = steps.length;
  var s = parseInt(pos, 10);
  if (!isFinite(s) || s < 1) s = 1;
  if (s >= last) return { step: last, done: true, next_touch_date: null, next_touch_type: null };
  var gap = Math.max(1, steps[s].day_offset - steps[s - 1].day_offset);
  var next = steps[s];
  return {
    step: s,
    done: false,
    next_touch_date: iso(addDays(today, gap)),
    next_touch_type: next.type.charAt(0).toUpperCase() + next.type.slice(1) // Call / Email / Mail
  };
}

module.exports = { DEFAULT_STEPS: DEFAULT_STEPS, stepsFrom: stepsFrom, isPaused: isPaused, mergeTemplate: mergeTemplate, planTouches: planTouches, advance: advance, toDate: toDate, iso: iso, addDays: addDays };
