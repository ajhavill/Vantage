// Tests for the BD cadence engine's pure logic (_bd.js). Run: node tools/bd-test.js
//
// Since the program builder, the cadence is DATA (bd_templates rows -> stepsFrom)
// rather than a hardcoded plan, so these cover both the default program and
// arbitrary builder-authored programs (added/removed/reordered/retitled steps).
"use strict";
const bd = require("../site/netlify/functions/_bd.js");

let n = 0, failed = 0;
function ok(cond, name) {
  n++;
  if (cond) { console.log("  ok " + n + " — " + name); }
  else { failed++; console.error("FAIL " + n + " — " + name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + " (got " + JSON.stringify(a) + ")"); }

const TODAY = new Date("2026-07-24T00:00:00Z");
const DEF = bd.DEFAULT_STEPS;

/* ---------- default program integrity ---------- */
ok(DEF.length === 10, "default program has 10 steps");
eq(DEF.map((s) => s.day_offset), [1, 9, 15, 22, 28, 35, 41, 48, 54, 61], "default day offsets are the D1..D61 schedule");
eq(DEF.map((s) => s.type),
   ["mail", "call", "email", "call", "email", "mail", "call", "email", "call", "email"],
   "default touch sequence matches the v2 program");
eq(DEF.map((s) => s.pos), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "default steps are positioned 1..10");

/* ---------- stepsFrom (builder rows -> engine steps) ---------- */
let steps = bd.stepsFrom([
  { step: 2, day_offset: 10, touch_type: "call", label: "Ring them", body: "call script" },
  { step: 1, day_offset: 1, touch_type: "mail", label: "Brochure", body: "mail it" },
  { step: 3, day_offset: 30, touch_type: "email", label: "Ask", subject: "Coffee?", body: "hi" }
]);
eq(steps.map((s) => s.label), ["Brochure", "Ring them", "Ask"], "rows sort by day_offset, not row order");
eq(steps.map((s) => s.pos), [1, 2, 3], "positions renumber after sorting");
eq(steps[2].subject, "Coffee?", "subject carried through");
eq(bd.stepsFrom([]).length, 10, "no rows falls back to the default program");
eq(bd.stepsFrom(null).length, 10, "null rows falls back to the default program");

// rows missing day_offset (legacy) sort after dated rows, by step
steps = bd.stepsFrom([
  { step: 9, touch_type: "email", label: "Legacy late", body: "x" },
  { step: 1, day_offset: 5, touch_type: "mail", label: "Dated", body: "y" }
]);
eq(steps.map((s) => s.label), ["Dated", "Legacy late"], "undated legacy rows sort last");
ok(steps[1].day_offset > steps[0].day_offset, "undated row gets a synthesized later day");

// unknown touch type falls back to email rather than breaking the engine
steps = bd.stepsFrom([{ step: 1, day_offset: 1, touch_type: "carrier-pigeon", label: "?", body: "b" }]);
eq(steps[0].type, "email", "unknown touch type degrades to email");

/* ---------- isPaused ---------- */
ok(!bd.isPaused(""), "empty status runs");
ok(!bd.isPaused("Not started"), "'Not started' runs");
ok(!bd.isPaused("Active in program"), "'Active in program' runs");
ok(bd.isPaused("None"), "'None' (not marketed) is excluded");
ok(bd.isPaused("Contact responded - Positive"), "responded+ pauses");
ok(bd.isPaused("Contact responded - Negative"), "responded- pauses");
ok(bd.isPaused("Meeting set"), "meeting set pauses");
ok(bd.isPaused("Meeting held"), "meeting held pauses");
ok(bd.isPaused("Converted to client"), "converted pauses");
ok(bd.isPaused("Contact never responded"), "never-responded (finished) pauses");
ok(bd.isPaused("contact_responded_positive"), "internal snake_case values pause too");

/* ---------- mergeTemplate ---------- */
eq(bd.mergeTemplate("Hi {{first_name}}, re {{company}}.", { first_name: "Dana", company: "Acme" }),
   "Hi Dana, re Acme.", "merge fills fields");
eq(bd.mergeTemplate("Hi {{ first_name }}!", { first_name: "Dana" }), "Hi Dana!", "merge tolerates spaces");
eq(bd.mergeTemplate("{{unknown_field}}ok", {}), "ok", "unknown fields render empty, never literal braces");

/* ---------- planTouches ---------- */
function contact(id, props) { return { id: id, properties: props }; }

// due contact, 2 steps done -> position 3 drafted from the program
let r = bd.planTouches([contact("101", {
  firstname: "Dana", lastname: "Lee", email: "dana@acme.com", company: "Acme",
  marketing_program_status: "Active in program", marketing_program_step: "2", next_touch_date: "2026-07-24"
})], bd.stepsFrom([
  { step: 1, day_offset: 1, touch_type: "mail", label: "Brochure", body: "mail" },
  { step: 2, day_offset: 9, touch_type: "call", label: "Call", body: "ring" },
  { step: 3, day_offset: 15, touch_type: "email", label: "Snapshot", subject: "Snapshot for {{company}}", body: "Hi {{first_name}} — numbers attached.", attachment_path: "org/brochure.pdf" }
]), TODAY);
ok(r.rows.length === 1, "due contact drafts one touch");
eq(r.rows[0].step, 3, "drafts the next undone position");
eq(r.rows[0].touch_type, "email", "uses that step's touch type");
eq(r.rows[0].subject, "Snapshot for Acme", "template subject merged");
ok(r.rows[0].body.indexOf("Hi Dana") === 0, "template body merged");
eq(r.rows[0].step_label, "Step 3/3 — Snapshot", "label shows position/total + the builder title");
eq(r.rows[0].attachment_path, "org/brochure.pdf", "step attachment rides onto the queue row");
eq(r.rows[0].dedup_key, "101|3|2026-07-24", "dedup key = contact|position|due");
eq(r.rows[0].contact_name, "Dana Lee", "contact name assembled");

// overdue counts as due; future does not
r = bd.planTouches([
  contact("1", { email: "a@x.com", next_touch_date: "2026-07-01", marketing_program_step: "0" }),
  contact("2", { email: "b@x.com", next_touch_date: "2026-07-25", marketing_program_step: "0" })
], DEF, TODAY);
ok(r.rows.length === 1 && r.rows[0].hs_contact_id === "1", "overdue drafts, future waits");
ok(r.skipped.some((s) => s.id === "2" && s.why === "not due"), "future contact reported as not due");

// no next_touch_date -> skipped
r = bd.planTouches([contact("3", { email: "c@x.com", marketing_program_step: "1" })], DEF, TODAY);
ok(r.rows.length === 0, "no date, no touch");

// paused states skipped
r = bd.planTouches([contact("4", { email: "d@x.com", next_touch_date: "2026-07-24", marketing_program_status: "Meeting set" })], DEF, TODAY);
ok(r.rows.length === 0 && /paused/.test(r.skipped[0].why), "paused contact skipped");

// finished program skipped — and honors a SHORTER builder program
r = bd.planTouches([contact("5", { email: "e@x.com", next_touch_date: "2026-07-24", marketing_program_step: "10" })], DEF, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "program complete", "step 10 of 10 = complete");
let three = bd.stepsFrom([
  { step: 1, day_offset: 1, touch_type: "mail", label: "A", body: "a" },
  { step: 2, day_offset: 8, touch_type: "call", label: "B", body: "b" },
  { step: 3, day_offset: 15, touch_type: "email", label: "C", body: "c" }
]);
r = bd.planTouches([contact("5b", { email: "e@x.com", next_touch_date: "2026-07-24", marketing_program_step: "3" })], three, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "program complete", "shortened program completes at its own last step");

// do-not flags follow the step's type wherever it now sits
r = bd.planTouches([contact("6", { email: "f@x.com", next_touch_date: "2026-07-24", marketing_program_step: "0", do_not_mail: "true" })], DEF, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "do_not_mail", "do_not_mail blocks a mail step");
r = bd.planTouches([contact("7", { email: "g@x.com", next_touch_date: "2026-07-24", marketing_program_step: "1", do_not_call_vantage: "true" })], DEF, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "do_not_call", "do_not_call blocks a call step");

// blank step starts at position 1
r = bd.planTouches([contact("8", { firstname: "Sam", email: "h@x.com", next_touch_date: "2026-07-20" })], DEF, TODAY);
ok(r.rows.length === 1 && r.rows[0].step === 1 && r.rows[0].touch_type === "mail" && r.rows[0].body.length > 0,
   "blank step starts at position 1 (mail) with a body");
ok(r.rows[0].subject === null, "non-email touches carry no subject");

// a builder program whose FIRST step is an email drafts an email first
let emailFirst = bd.stepsFrom([{ step: 1, day_offset: 1, touch_type: "email", label: "Opener", subject: "Hi", body: "hello" }]);
r = bd.planTouches([contact("9", { email: "i@x.com", next_touch_date: "2026-07-24" })], emailFirst, TODAY);
eq(r.rows[0].touch_type, "email", "reordered program drafts the new first step's type");
eq(r.rows[0].step_label, "Step 1/1 — Opener", "single-step program labels 1/1");

/* ---------- advance ---------- */
let a = bd.advance(1, DEF, TODAY);
eq(a.next_touch_date, "2026-08-01", "default: after step 1 (D1), next touch in 8 days (D9)");
eq(a.next_touch_type, "Call", "default step 2 is a Call");
ok(!a.done, "not done after step 1");
a = bd.advance(9, DEF, TODAY);
eq(a.next_touch_type, "Email", "default step 10 is an Email");
eq(a.next_touch_date, "2026-07-31", "after step 9, breakup email in 7 days");
a = bd.advance(10, DEF, TODAY);
ok(a.done && a.next_touch_date === null, "default step 10 finishes the program");
a = bd.advance("junk", DEF, TODAY);
ok(!a.done && a.step === 1, "garbage position treated as 1, engine keeps moving");

// builder-authored gaps drive the schedule
let custom = bd.stepsFrom([
  { step: 1, day_offset: 1, touch_type: "mail", label: "A", body: "a" },
  { step: 2, day_offset: 4, touch_type: "email", label: "B", body: "b" },
  { step: 3, day_offset: 34, touch_type: "call", label: "C", body: "c" }
]);
a = bd.advance(1, custom, TODAY);
eq(a.next_touch_date, "2026-07-27", "custom 3-day gap respected");
eq(a.next_touch_type, "Email", "custom next type respected");
a = bd.advance(2, custom, TODAY);
eq(a.next_touch_date, "2026-08-23", "custom 30-day gap respected");
a = bd.advance(3, custom, TODAY);
ok(a.done, "custom program finishes at its own last step");

// same-day steps can't produce a zero/negative gap (would re-draft forever)
let sameDay = bd.stepsFrom([
  { step: 1, day_offset: 5, touch_type: "email", label: "A", body: "a" },
  { step: 2, day_offset: 5, touch_type: "call", label: "B", body: "b" }
]);
a = bd.advance(1, sameDay, TODAY);
eq(a.next_touch_date, "2026-07-25", "same-day steps still advance at least one day");

// steps arg omitted entirely -> default program (back-compat safety)
a = bd.advance(1, null, TODAY);
eq(a.next_touch_date, "2026-08-01", "null steps falls back to the default program");

console.log(failed ? "\n" + failed + "/" + n + " FAILED" : "\nAll " + n + " assertions passed.");
process.exit(failed ? 1 : 0);
