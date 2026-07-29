-- Vantage — tenant_companies (HubSpot company snapshot for the tenant heat map).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql.
--
-- One row = one company from HubSpot (the BD/company universe), synced nightly
-- by the hubspot-company-sync scheduled task and geocoded once. The heat map
-- reads THIS table only — never HubSpot live (speed, rate limits, pitch-room
-- reliability). Company-centric: dot per company at its address, color =
-- type/industry, size = headcount band; pitch mode filters to a prospect's
-- peer set. HubSpot-derived + public company facts are client-safe to display
-- (no CoStar involvement in this table).

create table if not exists public.tenant_companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  hs_company_id text not null,

  name     text not null,
  domain   text,
  company_type text,          -- Andrew's classification (custom HS property when created; else industry-derived)
  industry text,              -- raw HubSpot industry
  employees integer check (employees is null or employees >= 0),
  size_band text,             -- computed at sync: '1-10','11-25','26-50','51-100','101-250','251-500','500+'

  address text, city text, state text, zip text,
  lat double precision,
  lng double precision,
  geocoded_at timestamptz,    -- null = needs geocoding (sync geocodes once, cached forever)

  building_id text,           -- verified placement (directory-walk match to the building catalog), null until verified

  hs_synced_at timestamptz not null default now(),
  raw jsonb,                  -- the HubSpot properties payload, verbatim
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, hs_company_id)
);

create index if not exists tenant_companies_org_idx  on public.tenant_companies(org_id, company_type, size_band);
create index if not exists tenant_companies_geo_idx  on public.tenant_companies(org_id) where lat is not null;

create or replace function public.stamp_tenant_company()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists tenant_companies_stamp on public.tenant_companies;
create trigger tenant_companies_stamp before insert or update on public.tenant_companies
  for each row execute function public.stamp_tenant_company();

-- RLS: org members read; writes come from the sync (management/service path).
-- Clients (org_id NULL profiles) fail closed as everywhere else; pitch-mode
-- client DISPLAY happens through broker-driven screens, not client logins.
alter table public.tenant_companies enable row level security;

drop policy if exists tenant_companies_select on public.tenant_companies;
drop policy if exists tenant_companies_write  on public.tenant_companies;

create policy tenant_companies_select on public.tenant_companies for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy tenant_companies_write on public.tenant_companies for all using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
