// Vantage — run-sql: execute a SQL file (or inline query) against the Supabase
// project via the Management API, so migrations don't require the dashboard.
//
//   node tools/run-sql.js supabase/schema.sql
//   node tools/run-sql.js --query "select count(*) from public.deals"
//   node tools/run-sql.js --selftest        (no network/token needed)
//
// Auth: set SUPABASE_ACCESS_TOKEN (a personal access token from
// https://supabase.com/dashboard/account/tokens — starts with "sbp_").
// Store it as a Windows user env var, NEVER in this repo (the repo is public):
//   [Environment]::SetEnvironmentVariable("SUPABASE_ACCESS_TOKEN","sbp_...","User")
// Optional: SUPABASE_PROJECT_REF overrides the default project.

const fs = require("fs");
const path = require("path");

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "siaoqjvvxuckyxpxftwt"; // Havill & Co. Vantage project
const API = "https://api.supabase.com/v1/projects/" + PROJECT_REF + "/database/query";

function fail(msg) { console.error("ERROR: " + msg); process.exit(1); }

function readTarget(argv) {
  const qi = argv.indexOf("--query");
  if (qi >= 0) {
    const q = argv[qi + 1];
    if (!q || !q.trim()) fail('--query needs a SQL string, e.g. --query "select 1"');
    return { label: "(inline query)", sql: q };
  }
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) fail("Usage: node tools/run-sql.js <file.sql>  |  --query \"...\"  |  --selftest");
  const p = path.resolve(file);
  if (!fs.existsSync(p)) fail("No such file: " + p);
  const sql = fs.readFileSync(p, "utf8");
  if (!sql.trim()) fail("That SQL file is empty: " + p);
  return { label: path.basename(p), sql };
}

async function run() {
  const argv = process.argv.slice(2);

  if (argv.includes("--selftest")) {
    // prove arg parsing + payload shape with no token or network
    const t = readTarget(["--query", "select 1"]);
    if (t.sql !== "select 1") fail("selftest: query parse broke");
    const body = JSON.stringify({ query: t.sql });
    if (JSON.parse(body).query !== "select 1") fail("selftest: payload shape broke");
    console.log("selftest OK — payload + parsing behave. Set SUPABASE_ACCESS_TOKEN to run for real.");
    return;
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN || "";
  if (!token) fail(
    "SUPABASE_ACCESS_TOKEN is not set.\n" +
    "  1) Create a token at https://supabase.com/dashboard/account/tokens\n" +
    "  2) In PowerShell: [Environment]::SetEnvironmentVariable(\"SUPABASE_ACCESS_TOKEN\",\"sbp_...\",\"User\")\n" +
    "  3) Open a fresh terminal and re-run."
  );
  if (!/^sbp_/.test(token)) console.warn("warning: token doesn't start with sbp_ — is this a Management API personal access token?");

  const { label, sql } = readTarget(argv);
  console.log("Running " + label + " against project " + PROJECT_REF + " …");

  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}

  if (!res.ok) {
    fail("Supabase returned " + res.status + ": " + (data && (data.message || data.error) ? (data.message || data.error) : text.slice(0, 500)));
  }
  // DDL returns []; SELECTs return rows
  if (Array.isArray(data) && data.length) {
    console.log(JSON.stringify(data.slice(0, 50), null, 2));
    if (data.length > 50) console.log("… " + (data.length - 50) + " more rows");
  }
  console.log("OK — " + label + " executed" + (Array.isArray(data) ? " (" + data.length + " row" + (data.length === 1 ? "" : "s") + " returned)" : "") + ".");
}

run().catch((e) => fail(e.message || String(e)));
