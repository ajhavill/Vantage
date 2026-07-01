// Shared HubSpot CRM v3 helper for Vantage functions.
//
// Same spirit as _sb.js: plain fetch, no SDK, secret held ONLY in a server-side
// Netlify env var (HUBSPOT_PRIVATE_APP_TOKEN — a HubSpot private-app token). The
// token never touches the browser; all HubSpot calls run inside these functions.
//
// Required private-app scopes:
//   crm.objects.companies.read, crm.objects.companies.write,
//   crm.schemas.companies.read, crm.schemas.companies.write
//
// Files prefixed with "_" are NOT deployed as their own functions by Netlify;
// this is bundled into each function that requires it.

const BASE = "https://api.hubapi.com";

function token() { return process.env.HUBSPOT_PRIVATE_APP_TOKEN; }
function configured() { return !!token(); }

// Call the HubSpot API. Returns { status, ok, data, text }.
async function hs(path, opts) {
  opts = opts || {};
  const headers = Object.assign(
    { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    opts.headers || {}
  );
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers: headers,
    body: opts.body
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }
  return { status: res.status, ok: res.ok, data: data, text: text };
}

module.exports = { configured: configured, hs: hs, BASE: BASE };
