// Guards EVERY structured-output schema we send to the Anthropic API against the
// limit that silently broke "Draft with AI" (2026-07-26): a json_schema whose
// parameters include MORE THAN 16 union types (anyOf / type arrays) is rejected
// outright — "This causes exponential compilation cost." The request 400s before
// the model runs, so the broker just sees a failed round.
//
// Adding one nullable field is all it takes, and these are background functions
// whose failures are invisible in the browser, so this scans every function
// generically rather than only the one that broke.
//   node tools/ai-schemas.test.js
const fs = require("fs");
const path = require("path");

const LIMIT = 16;
const DIR = path.join(__dirname, "..", "site", "netlify", "functions");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  (cond ? pass++ : fail++);
  console.log((cond ? "  PASS " : "  FAIL ") + name + (!cond && extra != null ? "  → " + extra : ""));
}

// Count union-typed parameters the way the API does: an anyOf/oneOf branch list,
// or a `type` given as an array (["string","null"]). Constants like NUMN reused
// across many properties expand here — counting source occurrences of "anyOf"
// would have missed the original bug entirely.
function countUnions(node) {
  if (!node || typeof node !== "object") return 0;
  let n = 0;
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.type)) n++;
  const props = node.properties || {};
  for (const k of Object.keys(props)) n += countUnions(props[k]);
  if (node.items) n += countUnions(node.items);
  return n;
}

// Load a function module in a sandbox and pull out its top-level SCHEMA const,
// so a function doesn't have to export it just to be covered here.
function schemaOf(file) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8");
  if (src.indexOf("json_schema") < 0) return undefined;
  const M = { exports: {} };
  const fn = new Function("module", "exports", "require", "process", "fetch", "Buffer",
    src + "\n;module.exports.__schema = (typeof SCHEMA !== 'undefined') ? SCHEMA : undefined;");
  fn(M, M.exports, () => ({}), { env: {} }, () => {}, { from: () => ({ toString: () => "" }) });
  return M.exports.__schema;
}

console.log("[1] every structured-output schema stays under the API's union limit");
{
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".js"));
  let checked = 0;
  for (const f of files) {
    let s;
    try { s = schemaOf(f); } catch (e) { ok(f + " — could not evaluate", false, e.message.slice(0, 60)); continue; }
    if (!s) continue;
    checked++;
    const n = countUnions(s);
    ok(f + " — " + n + " unions <= " + LIMIT, n <= LIMIT,
       "the API will 400 the whole request; make new optional fields plain strings with \"\" as the not-stated sentinel");
  }
  ok("found schemas to check (" + checked + ")", checked >= 3, "the sandbox loader probably stopped working");
}

console.log("[2] the drafter's letterhead details carry no unions (they use \"\" for not-stated)");
{
  const { SCHEMA, DETAIL_KEYS } = require("../site/netlify/functions/deal-ai-draft-background.js");
  const details = SCHEMA.properties.details;
  const offenders = DETAIL_KEYS.filter((k) => {
    const p = details.properties[k];
    return !p || Array.isArray(p.anyOf) || Array.isArray(p.type);
  });
  ok("all " + DETAIL_KEYS.length + " detail keys are plain strings", offenders.length === 0, offenders.join(", "));
  ok("every detail key is required (strict mode)", DETAIL_KEYS.every((k) => details.required.indexOf(k) >= 0));
  ok("base_rent_psf still accepts null", JSON.stringify(SCHEMA.properties.economics.properties.base_rent_psf).indexOf("null") >= 0);
}

console.log("[3] the landlord-response extractor takes both input shapes and reports failure");
{
  const src = fs.readFileSync(path.join(DIR, "deal-ai-extract-background.js"), "utf8");
  ok("accepts a pasted / Word-converted text body", /body\.text/.test(src));
  ok("still accepts an uploaded PDF path", /body\.storagePath/.test(src));
  // The bug this function shipped with: sb.rest RESOLVES on a non-2xx PostgREST
  // reply, so a try/catch around the insert swallows a rejected write entirely.
  ok("checks the insert result rather than try/catch", /if \(!ins\.ok\)/.test(src));
  ok("records failures where they can be seen", /bd_job_runs/.test(src) && /failRound/.test(src));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
