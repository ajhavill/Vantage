// Unit test for the critical-dates planner (pure logic, no network).
//   node tools/deal-critical-dates.test.js
const fn = require("../site/netlify/functions/deal-critical-dates.js");
const { computeTasks } = fn;

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log((cond ? "  PASS " : "  FAIL ") + name); }

// fixed "today" so the test is deterministic
const base = new Date("2026-07-06T00:00:00Z");
function plus(days) { return new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10); }

const deals = [
  { id: "d1", owner_id: "o1", client_name: "Brightwork", stage: "executed" },
  { id: "d2", owner_id: "o2", client_name: "Pico Partners", stage: "negotiation" }
];

console.log("[1] key date inside the 90-day window → task; far-off date → none");
{
  const absts = [{ deal_id: "d1", key_dates: [{ label: "Renewal notice", date: plus(20) }, { label: "Far off", date: plus(200) }], expiration_date: null }];
  const out = computeTasks(deals, absts, [], base);
  ok("one task created", out.length === 1);
  ok("titled from label", out[0] && out[0].title === "⏰ Renewal notice");
  ok("high priority inside 30d", out[0] && out[0].priority === "high");
  ok("due date carried", out[0] && out[0].due_date === plus(20));
  ok("owner stamped from deal", out[0] && out[0].owner_id === "o1");
}

console.log("[2] idempotency — existing same-title task suppresses a duplicate");
{
  const absts = [{ deal_id: "d1", key_dates: [{ label: "Renewal notice", date: plus(20) }], expiration_date: null }];
  const existing = [{ deal_id: "d1", title: "⏰ Renewal notice", due_date: plus(20), done: false }];
  const out = computeTasks(deals, absts, existing, base);
  ok("no duplicate created", out.length === 0);
}

console.log("[3] a done task still suppresses re-creation (no nagging)");
{
  const absts = [{ deal_id: "d1", key_dates: [{ label: "Renewal notice", date: plus(20) }], expiration_date: null }];
  const existing = [{ deal_id: "d1", title: "⏰ Renewal notice", due_date: plus(20), done: true }];
  const out = computeTasks(deals, absts, existing, base);
  ok("done task blocks re-create", out.length === 0);
}

console.log("[4] executed lease ~9mo from expiry → renewal-outreach task");
{
  const absts = [{ deal_id: "d1", key_dates: [], expiration_date: plus(9 * 30) }]; // ~start now
  const out = computeTasks(deals, absts, [], base);
  const renew = out.filter((t) => t.title.indexOf("Start renewal conversation") >= 0);
  ok("renewal task created", renew.length === 1);
  ok("renewal is high priority", renew[0] && renew[0].priority === "high");
}

console.log("[5] non-executed deal gets NO renewal task");
{
  const absts = [{ deal_id: "d2", key_dates: [], expiration_date: plus(9 * 30) }];
  const out = computeTasks(deals, absts, [], base);
  ok("no renewal for non-executed", out.filter((t) => t.title.indexOf("renewal") >= 0).length === 0);
}

console.log("[6] expiration inside window → its own reminder");
{
  const absts = [{ deal_id: "d2", key_dates: [], expiration_date: plus(45) }];
  const out = computeTasks(deals, absts, [], base);
  ok("expiration reminder created", out.some((t) => t.title === "⏰ Lease expiration approaching"));
}

console.log("[7] abstract with no matching deal is skipped safely");
{
  const absts = [{ deal_id: "ghost", key_dates: [{ label: "x", date: plus(10) }], expiration_date: null }];
  const out = computeTasks(deals, absts, [], base);
  ok("orphan abstract ignored", out.length === 0);
}

console.log("\n" + (fail ? "✗ " + fail + " failed, " : "✓ ") + pass + " passed");
process.exit(fail ? 1 : 0);
