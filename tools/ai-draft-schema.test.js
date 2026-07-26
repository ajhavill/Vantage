// Guards the "Draft with AI" structured-output schema against the limit that
// silently broke it once already (2026-07-26): the Anthropic API rejects any
// json_schema whose parameters include MORE THAN 16 union types (anyOf / type
// arrays) — "This causes exponential compilation cost." The whole request 400s
// before the model runs, so the broker just sees a failed round.
//
// Adding a nullable field to economics or details is exactly how you'd blow
// past it again. Details are plain strings ("" = not stated) for that reason.
//   node tools/ai-draft-schema.test.js
const { SCHEMA, DETAIL_KEYS } = require("../site/netlify/functions/deal-ai-draft-background.js");

const LIMIT = 16;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  (cond ? pass++ : fail++);
  console.log((cond ? "  PASS " : "  FAIL ") + name + (!cond && extra != null ? "  → " + extra : ""));
}

// Count every parameter that is union-typed, the way the API does: an `anyOf`
// branch list, or a `type` given as an array (["string","null"]).
function countUnions(node) {
  if (!node || typeof node !== "object") return 0;
  let n = 0;
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.type)) n++;
  const props = node.properties || {};
  for (const k of Object.keys(props)) n += countUnions(props[k]);
  if (node.items) n += countUnions(node.items);
  return n;
}

console.log("[1] the schema stays under the API's union-type limit");
{
  const n = countUnions(SCHEMA);
  ok("union-typed parameters (" + n + ") <= " + LIMIT, n <= LIMIT,
     "the API will 400 the whole draft request; make new optional fields plain strings with \"\" as the not-stated sentinel");
}

console.log("[2] letterhead details carry no unions (they use \"\" for not-stated)");
{
  const details = SCHEMA.properties.details;
  const offenders = DETAIL_KEYS.filter((k) => {
    const p = details.properties[k];
    return !p || Array.isArray(p.anyOf) || Array.isArray(p.type);
  });
  ok("all " + DETAIL_KEYS.length + " detail keys are plain strings", offenders.length === 0, offenders.join(", "));
  ok("every detail key is required (strict mode)",
     DETAIL_KEYS.every((k) => details.required.indexOf(k) >= 0));
}

console.log("[3] economics still round-trips real nulls for unknown numbers");
{
  const ec = SCHEMA.properties.economics;
  ok("base_rent_psf accepts null", JSON.stringify(ec.properties.base_rent_psf).indexOf("null") >= 0);
  ok("term_months accepts null", JSON.stringify(ec.properties.term_months).indexOf("null") >= 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
