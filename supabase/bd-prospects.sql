-- Vantage — Directory Scan → building link (BD Prospects + the Tenants map).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER bd-directory.sql.
--
-- A scan already knows WHO is in a building. This ties it to WHICH building in
-- the Vantage catalog, which is what lets two things happen:
--   1. BD → Prospects lists every scanned company across every building.
--   2. Market → Tenants shows the REAL roster for a building you've walked,
--      replacing the sample roster that ships with the demo data.
--
-- building_id is the catalog id from vantage-data.json ('watergarden',
-- 'b-2425-olympic-blvd', ...), chosen by the broker on the scan form — matched
-- explicitly rather than guessed from the address, because putting the wrong
-- tenants in a building is worse than leaving it unlinked. It is also the same
-- id the HubSpot export writes to the Vantage Building ID company property, so
-- a scanned tenant lands in the tenant-intelligence grid once imported.

alter table public.bd_directory_scans
  add column if not exists building_id text;

-- "Which buildings have I walked?" — the lookup behind both new views.
create index if not exists bd_directory_scans_building_idx
  on public.bd_directory_scans(org_id, building_id)
  where building_id is not null;
