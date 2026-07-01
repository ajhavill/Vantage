-- Vantage — Comparable Transactions (signed lease comps, seeded from closed deals).
-- Run ONCE (and safe to re-run) in Supabase → SQL Editor → New query → paste → Run.
-- Depends on schema.sql (orgs, profiles, current_org(), is_platform_admin()).
--
-- One row = one signed lease the broker is using as a comparable. The value of
-- this table is NORMALIZATION, not coverage: alongside the raw lease terms we
-- store three computed, comparable metrics (net effective / face / total
-- occupancy cost) so unlike deals can be sorted head-to-head. The metrics are
-- computed server-side by the comps.js function from assets/comps-math.js on
-- every write, so they never drift from the terms.
--
-- Org-scoped like everything else. The Netlify Functions talk to this over the
-- service_role REST path (bypassing RLS) and enforce org scope in code from the
-- signed-in broker's profile. The RLS policies below are the backstop.

create table if not exists public.comps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- what & where
  building_id  text,                          -- vantage-data.json building id when matched
  building_name text,
  address      text,
  tenant       text,
  suite        text,
  rsf          numeric check (rsf is null or rsf >= 0),

  -- lease economics
  execution_date   date,
  term_months      integer check (term_months is null or term_months >= 0),
  face_rate        numeric,                    -- starting base rent, $/RSF/yr
  escalation       jsonb   not null default '{"type":"none"}'::jsonb,  -- {type,value,schedule[]}
  free_rent_months numeric check (free_rent_months is null or free_rent_months >= 0),
  ti_allowance_psf numeric,                    -- landlord TI, $/RSF
  expense_structure text check (expense_structure in ('FSG','NNN','MG')),
  base_year        integer,
  opex_psf         numeric,                    -- operating expenses $/RSF (NNN/MG gross-up)
  parking          jsonb   not null default '{}'::jsonb,   -- {ratio,rate,spaces,notes}
  options          jsonb   not null default '{}'::jsonb,   -- {expansion,renewal} rights (text)
  discount_rate    numeric,                    -- per-comp NER discount %, null = engine default (8%)

  -- computed, comparable metrics (written by comps.js on every save)
  net_effective_rent_psf   numeric,
  face_rate_psf            numeric,
  total_occupancy_cost_psf numeric,

  -- client mode: which fields are withheld in pitch mode / exports.
  -- {exclude:bool, tenant:bool, suite:bool, economics:bool}
  redaction jsonb not null default '{}'::jsonb,

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Product type (retail / office / industrial / flex / lab) so comps can be pulled
-- per asset class. Added via ALTER so re-running this file on an existing table
-- applies it (create table if not exists won't add a column to an existing table).
alter table public.comps add column if not exists product_type text
  check (product_type is null or product_type in ('retail','office','industrial','flex','lab'));

create index if not exists comps_org_idx        on public.comps(org_id, execution_date desc);
create index if not exists comps_org_bldg_idx    on public.comps(org_id, building_id);
create index if not exists comps_org_ptype_idx   on public.comps(org_id, product_type);

-- Stamp org_id / created_by from the writer's profile if a direct client write omits
-- them (the functions set org_id explicitly; this covers any authenticated browser write).
create or replace function public.stamp_comp_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists comps_stamp on public.comps;
create trigger comps_stamp before insert or update on public.comps
  for each row execute function public.stamp_comp_org();

-- Row-Level Security: a firm sees and edits only its own comps; platform admin sees all.
alter table public.comps enable row level security;

drop policy if exists comps_select on public.comps;
drop policy if exists comps_insert on public.comps;
drop policy if exists comps_update on public.comps;
drop policy if exists comps_delete on public.comps;

create policy comps_select on public.comps for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy comps_insert on public.comps for insert with check (
  org_id = public.current_org()
);
create policy comps_update on public.comps for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy comps_delete on public.comps for delete using (
  org_id = public.current_org()
);
