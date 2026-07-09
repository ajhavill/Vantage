-- Vantage — deal requirements (saved map filter sets) + market_spaces.available_date.
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql, dealflow.sql,
-- and market-spaces.sql.
--
-- A "requirement" is a saved set of map filters, usually tied to a deal/client
-- (deal_id nullable so plain named presets also work). The map's Filters panel
-- saves/loads these; the morning costar-alert-ingest task compares newly
-- ingested market_spaces rows against active requirements and flags matches in
-- its summary. Broker-internal, org-scoped — same visibility rules as
-- market_spaces (clients fail closed via org_id NULL profiles).

-- Move-in timing for the space filters ("available by <date>"): alert emails
-- sometimes carry an availability date. NULL = assume available now.
alter table public.market_spaces add column if not exists available_date date;

create table if not exists public.deal_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  deal_id uuid references public.deals(id) on delete cascade,   -- null = unattached preset
  name text not null,                                           -- e.g. 'Acme Co — 5k SF Class A'
  filters jsonb not null default '{}'::jsonb,
  -- filter jsonb keys (all optional): sfMin, sfMax, rateMin, rateMax (annual $/SF),
  -- spaceType ('direct'|'sublease'), availableBy (date), classes[], parkingMin,
  -- builtAfter, renoAfter, plateMin, plateMax, rbaMin, rbaMax, industries[],
  -- owners[], submarkets[]
  active boolean not null default true,                         -- inactive = ignored by the morning matcher
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deal_requirements_org_idx  on public.deal_requirements(org_id, active);
create index if not exists deal_requirements_deal_idx on public.deal_requirements(deal_id);

create or replace function public.stamp_deal_requirement_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists deal_requirements_stamp on public.deal_requirements;
create trigger deal_requirements_stamp before insert or update on public.deal_requirements
  for each row execute function public.stamp_deal_requirement_org();

alter table public.deal_requirements enable row level security;

drop policy if exists deal_requirements_select on public.deal_requirements;
drop policy if exists deal_requirements_insert on public.deal_requirements;
drop policy if exists deal_requirements_update on public.deal_requirements;
drop policy if exists deal_requirements_delete on public.deal_requirements;

create policy deal_requirements_select on public.deal_requirements for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy deal_requirements_insert on public.deal_requirements for insert with check (
  org_id = public.current_org()
);
create policy deal_requirements_update on public.deal_requirements for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy deal_requirements_delete on public.deal_requirements for delete using (
  org_id = public.current_org()
);
