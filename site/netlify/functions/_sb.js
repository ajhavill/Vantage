// Shared Supabase REST helper for Vantage functions.
//
// We talk to Supabase over its REST API (PostgREST + GoTrue) with plain fetch
// instead of @supabase/supabase-js. The SDK tries to spin up a realtime
// WebSocket at init, which throws on Netlify's Node runtime ("no native
// WebSocket support"). We don't use realtime, so direct REST is simpler and
// has no Node-version or bundling pitfalls. The service_role key is server-only
// (Netlify env var) and bypasses Row-Level Security by design.
//
// Files prefixed with "_" are NOT deployed as their own functions by Netlify;
// this is bundled into each function that requires it.

function base() { return process.env.SUPABASE_URL; }
function key() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }
function configured() { return !!(base() && key()); }

// PostgREST call against /rest/v1/<path>. Returns { status, ok, data, text }.
async function rest(path, opts) {
  opts = opts || {};
  const headers = Object.assign(
    { apikey: key(), Authorization: "Bearer " + key() },
    opts.headers || {}
  );
  const res = await fetch(base() + "/rest/v1/" + path, { method: opts.method || "GET", headers: headers, body: opts.body });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }
  return { status: res.status, ok: res.ok, data: data, text: text };
}

// Validate a broker's Supabase access token; returns the user object (with .id) or null.
async function userFromToken(token) {
  if (!token) return null;
  const res = await fetch(base() + "/auth/v1/user", { headers: { apikey: key(), Authorization: "Bearer " + token } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return (u && u.id) ? u : null;
}

module.exports = { configured: configured, rest: rest, userFromToken: userFromToken };
