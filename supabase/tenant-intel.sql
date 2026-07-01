-- Vantage — Tenant intelligence: headcount snapshot timeseries.
-- Run ONCE (and safe to re-run) in Supabase → SQL Editor → New query → paste → Run.
-- Depends on schema.sql (orgs, profiles, current_org(), is_org_admin(), is_platform_admin()).
--
-- IMPORTANT — this is NOT a tenant store.
-- Tenants live in HubSpot (Companies) and stay there. HubSpot Company properties
-- only hold a CURRENT value, so they can't chart a trend. This table is the ONE
-- thing HubSpot can't give us: a time-series of headcount readings, keyed by the
-- HubSpot company id (hs_company_id). No names, addresses, or lease terms are
-- copied here — just (company id, date, headcount, where it came from).
--
-- Org-scoped like everything else. The Netlify Functions talk to this over the
-- service_role REST path (bypassing RLS) and enforce the org scope in code from
-- the signed-in broker's profile — same pattern as intakes/packages. The RLS
-- policies below are the backstop for any future direct-from-browser access.

create table if not exists public.tenant_intel_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  hs_company_id text not null,                 -- HubSpot Company object id (the bridge)
  captured_at timestamptz not null default now(),
  headcount integer not null check (headcount >= 0),
  source text not null default 'manual'
    check (source in ('manual','enrichment','sync')),
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Fast trend lookups: all readings for a company in a firm, in time order.
create index if not exists tenant_snap_lookup_idx
  on public.tenant_intel_snapshots(org_id, hs_company_id, captured_at);

-- Stamp org_id from the inserting user's profile when a browser insert omits it.
-- (Functions set it explicitly; this covers any direct authenticated client write.)
create or replace function public.stamp_tenant_snap_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end; $$;
drop trigger if exists tenant_snap_stamp_org on public.tenant_intel_snapshots;
create trigger tenant_snap_stamp_org before insert on public.tenant_intel_snapshots
  for each row execute function public.stamp_tenant_snap_org();

-- Row-Level Security: a firm sees only its own snapshots; platform admin sees all.
alter table public.tenant_intel_snapshots enable row level security;

drop policy if exists tenant_snap_select on public.tenant_intel_snapshots;
drop policy if exists tenant_snap_insert on public.tenant_intel_snapshots;
create policy tenant_snap_select on public.tenant_intel_snapshots for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
-- Any authenticated member of the firm may record a reading for their firm.
create policy tenant_snap_insert on public.tenant_intel_snapshots for insert with check (
  org_id = public.current_org()
);
