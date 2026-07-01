// Vantage — comps (Netlify Function, called by the logged-in broker).
//
// CRUD + CSV import for Comparable Transactions. Two things are enforced here,
// server-side, and are NOT left to the browser:
//
//   1. NORMALIZATION. The three comparable metrics (net effective / face / total
//      occupancy cost) are recomputed from the lease terms via the shared engine
//      (assets/comps-math.js) on every write, so what's stored can never drift
//      from the terms — even if a client posted stale/edited metric values.
//
//   2. REDACTION. In client mode (mode:'client') the per-comp redaction flags are
//      applied HERE: excluded comps are dropped and withheld fields (tenant, suite,
//      exact economics) are stripped before the row ever leaves the server. Pitch
//      mode and exports call this path, so hidden data never reaches the browser.
//
// Org scope is enforced in code from the broker's profile (service_role bypasses RLS).

const { configured, rest, userFromToken } = require("./_sb");
const CompsMath = require("../../public/assets/comps-math.js");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const STRUCTURES = ["FSG", "NNN", "MG"];
const ESC_TYPES = ["none", "percent", "fixed", "schedule"];
const PRODUCT_TYPES = ["retail", "office", "industrial", "flex", "lab"];

function n(v) { const x = typeof v === "number" ? v : parseFloat(v); return isFinite(x) ? x : null; }
function nn(v) { const x = n(v); return x == null ? null : x; } // numeric-or-null
function s(v, max) { return v == null ? null : String(v).slice(0, max || 200); }
function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }

// Coerce a raw client/CSV object into a clean comp record + its computed metrics.
function normalizeComp(raw) {
  raw = raw || {};

  const esc = raw.escalation || {};
  let escType = ESC_TYPES.includes(esc.type) ? esc.type : "none";
  const escalation = { type: escType };
  if (escType === "percent" || escType === "fixed") escalation.value = n(esc.value) || 0;
  if (escType === "schedule") escalation.schedule = Array.isArray(esc.schedule) ? esc.schedule.map(n).filter(x => x != null).slice(0, 40) : [];

  const p = raw.parking || {};
  const parking = {
    ratio: nn(p.ratio), rate: nn(p.rate), spaces: nn(p.spaces),
    notes: s(p.notes, 200)
  };

  const o = raw.options || {};
  const options = { expansion: s(o.expansion, 400), renewal: s(o.renewal, 400) };

  const rd = raw.redaction || {};
  const redaction = { exclude: bool(rd.exclude), tenant: bool(rd.tenant), suite: bool(rd.suite), economics: bool(rd.economics) };

  const rec = {
    building_id: s(raw.building_id, 80),
    building_name: s(raw.building_name, 200),
    address: s(raw.address, 300),
    product_type: PRODUCT_TYPES.includes(String(raw.product_type || "").toLowerCase()) ? String(raw.product_type).toLowerCase() : null,
    tenant: s(raw.tenant, 200),
    suite: s(raw.suite, 80),
    rsf: nn(raw.rsf),
    execution_date: parseDate(raw.execution_date),
    term_months: raw.term_months == null ? null : Math.round(n(raw.term_months) || 0),
    face_rate: nn(raw.face_rate),
    escalation: escalation,
    free_rent_months: nn(raw.free_rent_months),
    ti_allowance_psf: nn(raw.ti_allowance_psf),
    expense_structure: STRUCTURES.includes(raw.expense_structure) ? raw.expense_structure : null,
    base_year: raw.base_year == null || raw.base_year === "" ? null : Math.round(n(raw.base_year) || 0),
    opex_psf: nn(raw.opex_psf),
    parking: parking,
    options: options,
    discount_rate: nn(raw.discount_rate),
    redaction: redaction,
    notes: s(raw.notes, 1000)
  };

  // Recompute the three metrics from the terms (authoritative).
  const forMath = {
    rsf: rec.rsf, term_months: rec.term_months, face_rate: rec.face_rate,
    escalation: rec.escalation, free_rent_months: rec.free_rent_months,
    ti_allowance_psf: rec.ti_allowance_psf, opex_psf: rec.opex_psf,
    parking_ratio: parking.ratio, parking_rate: parking.rate, parking_spaces: parking.spaces,
    discount_rate: rec.discount_rate
  };
  const m = CompsMath.computeMetrics(forMath);
  rec.net_effective_rent_psf = m.net_effective_rent_psf;
  rec.face_rate_psf = m.face_rate_psf;
  rec.total_occupancy_cost_psf = m.total_occupancy_cost_psf;
  return rec;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Strip a stored row down to what a client may see, per its redaction flags.
// Returns null when the comp is excluded from client view entirely.
function redactForClient(row) {
  const rd = row.redaction || {};
  if (rd.exclude) return null;
  const out = {
    id: row.id,
    building_id: row.building_id,
    building_name: row.building_name,
    address: row.address,
    product_type: row.product_type,
    rsf: row.rsf,
    execution_date: row.execution_date,
    term_months: row.term_months,
    expense_structure: row.expense_structure,
    tenant: rd.tenant ? null : row.tenant,
    suite: rd.suite ? null : row.suite,
    redacted: { tenant: !!rd.tenant, suite: !!rd.suite, economics: !!rd.economics }
  };
  if (!rd.economics) {
    out.face_rate = row.face_rate;
    out.face_rate_psf = row.face_rate_psf;
    out.net_effective_rent_psf = row.net_effective_rent_psf;
    out.total_occupancy_cost_psf = row.total_occupancy_cost_psf;
    out.free_rent_months = row.free_rent_months;
    out.ti_allowance_psf = row.ti_allowance_psf;
    out.escalation = row.escalation;
    out.base_year = row.base_year;
    out.opex_psf = row.opex_psf;
    out.parking = row.parking;
    out.options = row.options;
    out.discount_rate = row.discount_rate;
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!configured()) return json(500, { error: "Server is missing Supabase config." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Malformed request body." }); }

  const token = String(body.token || "");
  if (!token) return json(401, { error: "Not signed in." });
  const user = await userFromToken(token);
  if (!user) return json(401, { error: "Your session has expired — please sign in again." });

  const prof = await rest("profiles?id=eq." + encodeURIComponent(user.id) + "&select=org_id&limit=1");
  const orgId = prof.ok && Array.isArray(prof.data) && prof.data[0] && prof.data[0].org_id;
  if (!orgId) return json(403, { error: "No firm is associated with your account." });

  try {
    if (body.action === "list") return await handleList(body, orgId);
    if (body.action === "save") return await handleSave(body, orgId, user);
    if (body.action === "delete") return await handleDelete(body, orgId);
    if (body.action === "import") return await handleImport(body, orgId, user);
    return json(400, { error: "Unknown action. Use 'list', 'save', 'delete', or 'import'." });
  } catch (e) {
    return json(502, { error: (e && e.message) ? e.message : "Request failed." });
  }
};

async function handleList(body, orgId) {
  const sel = "comps?org_id=eq." + encodeURIComponent(orgId) + "&select=*&order=execution_date.desc.nullslast&limit=2000";
  const r = await rest(sel);
  if (!r.ok) return json(500, { error: "Lookup failed: " + (r.text || r.status) });
  const rows = Array.isArray(r.data) ? r.data : [];
  if (body.mode === "client") {
    const safe = rows.map(redactForClient).filter(Boolean);
    return json(200, { comps: safe, mode: "client" });
  }
  return json(200, { comps: rows, mode: "broker" });
}

async function handleSave(body, orgId, user) {
  const rec = normalizeComp(body.comp || {});
  const id = body.comp && body.comp.id;

  if (id) {
    if (!/^[0-9a-fA-F-]{10,40}$/.test(String(id))) return json(400, { error: "Bad comp id." });
    const sel = "comps?id=eq." + encodeURIComponent(id) + "&org_id=eq." + encodeURIComponent(orgId);
    const up = await rest(sel, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(rec)
    });
    if (!up.ok) return json(500, { error: "Save failed: " + (up.text || up.status) });
    const row = Array.isArray(up.data) ? up.data[0] : up.data;
    if (!row) return json(404, { error: "No such comp." });
    return json(200, { ok: true, comp: row });
  }

  rec.org_id = orgId;
  rec.created_by = user.id;
  const ins = await rest("comps", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(rec)
  });
  if (!ins.ok) return json(500, { error: "Save failed: " + (ins.text || ins.status) });
  const row = Array.isArray(ins.data) ? ins.data[0] : ins.data;
  return json(200, { ok: true, comp: row });
}

async function handleDelete(body, orgId) {
  const id = body.id;
  if (!/^[0-9a-fA-F-]{10,40}$/.test(String(id || ""))) return json(400, { error: "Bad comp id." });
  const sel = "comps?id=eq." + encodeURIComponent(id) + "&org_id=eq." + encodeURIComponent(orgId);
  const del = await rest(sel, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!del.ok) return json(500, { error: "Delete failed: " + (del.text || del.status) });
  return json(200, { ok: true });
}

async function handleImport(body, orgId, user) {
  const rows = Array.isArray(body.comps) ? body.comps : [];
  if (!rows.length) return json(400, { error: "No rows to import." });
  if (rows.length > 1000) return json(400, { error: "Too many rows in one import (max 1000)." });

  const recs = rows.map(function (raw) {
    const rec = normalizeComp(raw);
    rec.org_id = orgId;
    rec.created_by = user.id;
    return rec;
  });
  const ins = await rest("comps", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(recs)
  });
  if (!ins.ok) return json(500, { error: "Import failed: " + (ins.text || ins.status) });
  const saved = Array.isArray(ins.data) ? ins.data : [];
  return json(200, { ok: true, imported: saved.length, comps: saved });
}
