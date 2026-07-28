-- Vantage — bd_directory_scans (BD → Directory Scan).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql + bd-center.sql.
--
-- Andrew walks a building, photographs the lobby directory, and drops the photo
-- here. Claude reads every tenant name + suite off the board, researches each
-- company on the open web (industry, website/domain, HQ, LA-metro headcount,
-- where the decision-makers sit), and returns a reviewed table that exports as
-- a HubSpot-ready company import CSV — the front door to the Tenant Rep BD
-- pipeline, replacing the manual LinkedIn-and-spreadsheet loop.
--
-- ONE row = one scanned directory (usually one building). The row is BOTH the
-- job (staged photos + status, polled by the browser) and the saved result, so
-- a scan you ran last month is still here with its edits. Same background-job
-- shape as market_report_extracts / deal_report_imports:
--   1. the browser stages the photos here (RLS insert, status='queued'),
--   2. it invokes bd-directory-scan-background with just {token, jobId},
--   3. the fn (service_role) reads the row, runs Claude + web search, writes
--      status/companies back and CLEARS the staged photos,
--   4. the browser polls the row, then edits `companies` in place and exports.
--
-- SOURCING: lobby directories are posted publicly in the building, and the
-- research is open-web (company sites, news, press). No CoStar content lands
-- here — see supabase/market-spaces.sql for that firewall. Rows are org-scoped
-- and client-portal profiles (org_id NULL) fail closed; nothing here reaches
-- vantage-data.json or any client surface.

create table if not exists public.bd_directory_scans (
  id uuid primary key,                       -- client-generated job id
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- what was photographed
  building_name text,
  address       text,
  submarket     text,
  note          text,                        -- anything the photo can't say ("2nd floor board only")

  -- staged upload — CLEARED by the function once it has read them
  photos jsonb,                              -- [{media_type, data}] base64, max 4

  -- job state
  status text not null default 'queued' check (status in ('queued','running','done','error')),
  error  text,
  raw    jsonb,                              -- the model's reply, verbatim, for audit

  -- the reviewed table (what the CSV exports). Array of:
  --   {company, suite, domain, website, industry, description, hq_city, hq_state,
  --    hq_country, la_employees, employees_total, dm_titles, dm_location, flag,
  --    confidence, notes, sources:[url], include:bool}
  -- The browser edits these in place; `include` drives what lands in the export.
  companies jsonb not null default '[]'::jsonb,

  -- lines the model could see but not read with confidence ("Suite 310 — name
  -- blurred"). Surfaced so a bad photo is visible as a gap, never guessed at.
  unreadable jsonb not null default '[]'::jsonb,

  -- the rent math, so a re-opened scan reproduces the same numbers
  -- {sqft_low, sqft_high, psf_low, psf_high} — defaults are Andrew's standard
  assumptions jsonb not null default
    '{"sqft_low":200,"sqft_high":250,"psf_low":100,"psf_high":125}'::jsonb,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bd_directory_scans_org_idx
  on public.bd_directory_scans(org_id, created_at desc);

create or replace function public.stamp_bd_directory_scan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists bd_directory_scans_stamp on public.bd_directory_scans;
create trigger bd_directory_scans_stamp before insert or update on public.bd_directory_scans
  for each row execute function public.stamp_bd_directory_scan();

alter table public.bd_directory_scans enable row level security;

drop policy if exists bd_directory_scans_select on public.bd_directory_scans;
drop policy if exists bd_directory_scans_insert on public.bd_directory_scans;
drop policy if exists bd_directory_scans_update on public.bd_directory_scans;
drop policy if exists bd_directory_scans_delete on public.bd_directory_scans;

create policy bd_directory_scans_select on public.bd_directory_scans for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_directory_scans_insert on public.bd_directory_scans for insert with check (
  org_id = public.current_org()
);
-- The broker edits the reviewed table + assumptions under RLS; the background
-- function writes status/companies/raw with service_role (bypasses this).
create policy bd_directory_scans_update on public.bd_directory_scans for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy bd_directory_scans_delete on public.bd_directory_scans for delete using (
  org_id = public.current_org()
);
