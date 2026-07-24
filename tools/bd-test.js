// Tests for the BD cadence engine's pure logic (_bd.js). Run: node tools/bd-test.js
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

/* ---------- PLAN integrity ---------- */
ok(bd.LAST_STEP === 10, "program has 10 steps");
let dayOffsets = [1];
for (let s = 1; s < 10; s++) dayOffsets.push(dayOffsets[s - 1] + bd.PLAN[s].gap);
eq(dayOffsets, [1, 9, 15, 22, 28, 35, 41, 48, 54, 61], "gaps reproduce the D1..D61 schedule");
ok(["mail", "call", "email"].every((t) => Object.values(bd.PLAN).some((p) => p.type === t)), "all three touch types present");
eq(Object.values(bd.PLAN).map((p) => p.type),
   ["mail", "call", "email", "call", "email", "mail", "call", "email", "call", "email"],
   "touch type sequence matches the v2 program");

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
const templates = {
  3: { subject: "Snapshot for {{company}}", body: "Hi {{first_name}} — numbers attached." }
};

// due contact, 2 steps done -> step 3 email drafted from template
let r = bd.planTouches([contact("101", {
  firstname: "Dana", lastname: "Lee", email: "dana@acme.com", company: "Acme",
  marketing_program_status: "Active in program", marketing_program_step: "2", next_touch_date: "2026-07-24"
})], templates, TODAY);
ok(r.rows.length === 1, "due contact drafts one touch");
eq(r.rows[0].step, 3, "step advances to the next undone step");
eq(r.rows[0].touch_type, "email", "step 3 is an email");
eq(r.rows[0].subject, "Snapshot for Acme", "template subject merged");
ok(r.rows[0].body.indexOf("Hi Dana") === 0, "template body merged");
eq(r.rows[0].dedup_key, "101|3|2026-07-24", "dedup key = contact|step|due");
eq(r.rows[0].contact_name, "Dana Lee", "contact name assembled");

// overdue counts as due; future does not
r = bd.planTouches([
  contact("1", { email: "a@x.com", next_touch_date: "2026-07-01", marketing_program_step: "0" }),
  contact("2", { email: "b@x.com", next_touch_date: "2026-07-25", marketing_program_step: "0" })
], {}, TODAY);
ok(r.rows.length === 1 && r.rows[0].hs_contact_id === "1", "overdue drafts, future waits");
ok(r.skipped.some((s) => s.id === "2" && s.why === "not due"), "future contact reported as not due");

// no next_touch_date -> skipped
r = bd.planTouches([contact("3", { email: "c@x.com", marketing_program_step: "1" })], {}, TODAY);
ok(r.rows.length === 0, "no date, no touch");

// paused states skipped
r = bd.planTouches([contact("4", { email: "d@x.com", next_touch_date: "2026-07-24", marketing_program_status: "Meeting set" })], {}, TODAY);
ok(r.rows.length === 0 && /paused/.test(r.skipped[0].why), "paused contact skipped");

// finished program skipped
r = bd.planTouches([contact("5", { email: "e@x.com", next_touch_date: "2026-07-24", marketing_program_step: "10" })], {}, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "program complete", "step 10 done = complete");

// do-not flags
r = bd.planTouches([contact("6", { email: "f@x.com", next_touch_date: "2026-07-24", marketing_program_step: "0", do_not_mail: "true" })], {}, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "do_not_mail", "do_not_mail blocks the brochure step");
r = bd.planTouches([contact("7", { email: "g@x.com", next_touch_date: "2026-07-24", marketing_program_step: "1", do_not_call_vantage: "true" })], {}, TODAY);
ok(r.rows.length === 0 && r.skipped[0].why === "do_not_call", "do_not_call blocks a call step");

// step 1 default (blank step) is the brochure mailing with a body even without templates
r = bd.planTouches([contact("8", { firstname: "Sam", email: "h@x.com", next_touch_date: "2026-07-20" })], {}, TODAY);
ok(r.rows.length === 1 && r.rows[0].step === 1 && r.rows[0].touch_type === "mail" && r.rows[0].body.length > 0,
   "blank step starts at step 1 (mail) with fallback body");
ok(r.rows[0].subject === null, "non-email touches carry no subject");

/* ---------- advance ---------- */
let a = bd.advance(1, TODAY);
eq(a.next_touch_date, "2026-08-01", "after step 1 (D1), next touch in 8 days (D9)");
eq(a.next_touch_type, "Call", "step 2 is a Call");
ok(!a.done, "not done after step 1");
a = bd.advance(9, TODAY);
eq(a.next_touch_type, "Email", "step 10 is an Email");
eq(a.next_touch_date, "2026-07-31", "after step 9, breakup email in 7 days");
a = bd.advance(10, TODAY);
ok(a.done && a.next_touch_date === null, "step 10 finishes the program");
a = bd.advance("junk", TODAY);
ok(!a.done && a.step === 1, "garbage step treated as step 1, engine keeps moving");

console.log(failed ? "\n" + failed + "/" + n + " FAILED" : "\nAll " + n + " assertions passed.");
process.exit(failed ? 1 : 0);
