-- Vantage — market_reports (quarterly brokerage research, digested).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql.
--
-- One row = one imported quarterly market report from a large brokerage
-- (CBRE "Figures", JLL "Market Dynamics", Cushman & Wakefield "MarketBeat",
-- Colliers, Newmark, Savills, Lee & Associates, Kidder Mathews, ...).
-- The broker uploads the published PDF on the Market → Reports sub-view;
-- market-report-extract (Netlify fn) pulls the headline statistics, the
-- submarket breakdown table and the key takeaways; the browser writes the
-- reviewed row here (RLS-scoped, same trust model as market_spaces).
--
-- SOURCING: these are the brokerages' OWN published research pieces —
-- publicly distributed marketing/research PDFs, not CoStar exports — so the
-- CoStar firewall does not apply. Still broker-internal by default: RLS is
-- org-scoped and client-portal profiles (org_id NULL) fail closed.

create table if not exists public.market_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- which report
  brokerage    text not null,                -- 'CBRE', 'JLL', 'Cushman & Wakefield', ...
  report_title text,                         -- as printed, e.g. 'Los Angeles Office Figures Q2 2026'
  market       text not null,                -- geography covered, e.g. 'Greater Los Angeles'
  product_type text check (product_type is null or product_type in
                 ('office','industrial','retail','flex','lab','medical','mixed')),
  year         integer not null check (year between 2000 and 2100),
  quarter      integer not null check (quarter between 1 and 4),
  report_date  date,                         -- publication/as-of date when stated

  -- headline statistics, exactly as published (null = the report didn't state it)
  inventory_sf          bigint,
  vacancy_pct           numeric,             -- 15.3 means 15.3%
  availability_pct      numeric,
  sublease_sf           bigint,
  net_absorption_sf     bigint,              -- the quarter's net absorption (negative = give-back)
  net_absorption_ytd_sf bigint,
  leasing_activity_sf   bigint,
  under_construction_sf bigint,
  deliveries_sf         bigint,
  avg_asking_rate       numeric,             -- $/SF
  rate_period text check (rate_period is null or rate_period in ('mo','yr')),
  rate_basis  text check (rate_basis  is null or rate_basis  in ('FSG','NNN','MG')),
  class_a_rate   numeric,                    -- Class A average asking, same period/basis
  sale_price_psf numeric,                    -- when the report covers investment sales
  cap_rate_pct   numeric,

  -- narrative + breakdown
  takeaways  jsonb not null default '[]'::jsonb,  -- array of short bullet strings (never a paragraph)
  submarkets jsonb not null default '[]'::jsonb,  -- array of {name, inventory_sf, vacancy_pct,
                                                  --  availability_pct, net_absorption_sf,
                                                  --  sublease_sf, avg_asking_rate, class_a_rate}

  -- provenance
  filename   text,                           -- uploaded PDF name
  source_url text,
  raw        jsonb,                          -- the extraction result, verbatim, for audit

  -- re-importing the same brokerage/market/product/quarter updates the row
  dedup_key text,                            -- brokerage|market|product|year|quarter (normalized by the importer)

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists market_reports_org_idx
  on public.market_reports(org_id, year desc, quarter desc);
create unique index if not exists market_reports_org_dedup_uidx
  on public.market_reports(org_id, dedup_key)
  where dedup_key is not null;

-- Stamp org_id / created_by from the writer's profile when a direct authenticated
-- browser write omits them. Same pattern as market_spaces / comps.
create or replace function public.stamp_market_report_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists market_reports_stamp on public.market_reports;
create trigger market_reports_stamp before insert or update on public.market_reports
  for each row execute function public.stamp_market_report_org();

-- RLS: firm-internal. Clients (org_id NULL) fail every predicate — by design.
alter table public.market_reports enable row level security;

drop policy if exists market_reports_select on public.market_reports;
drop policy if exists market_reports_insert on public.market_reports;
drop policy if exists market_reports_update on public.market_reports;
drop policy if exists market_reports_delete on public.market_reports;

create policy market_reports_select on public.market_reports for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy market_reports_insert on public.market_reports for insert with check (
  org_id = public.current_org()
);
create policy market_reports_update on public.market_reports for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy market_reports_delete on public.market_reports for delete using (
  org_id = public.current_org()
);

-- ============================================================================
-- market_report_extracts — job rows for the ASYNC extraction pipeline.
--
-- Netlify's synchronous functions cap at ~26s and a full quarterly-report read
-- takes longer (the first live import 504'd), so extraction runs in a
-- BACKGROUND function (market-report-extract-background, 202-immediately /
-- 15-min budget). Background invocations can't carry a multi-MB payload, so:
--   1. the browser stages the PDF here (RLS insert, pdf_b64/src_text),
--   2. invokes the background fn with just {token, jobId},
--   3. the fn (service_role) reads the row, extracts with Claude, writes
--      status/result back and CLEARS pdf_b64,
--   4. the browser polls this row (RLS select) and deletes it after reading.
-- Rows are transient; the browser deletes on consume.
-- ============================================================================

create table if not exists public.market_report_extracts (
  id uuid primary key,                       -- client-generated job id
  org_id uuid not null references public.orgs(id) on delete cascade,
  filename text,
  pdf_b64  text,                             -- staged upload; cleared by the fn after reading
  src_text text,                             -- pasted-text fallback
  status text not null default 'queued' check (status in ('queued','done','error')),
  result jsonb,                              -- the extraction, verbatim, when status='done'
  error  text,                               -- friendly message when status='error'
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.stamp_market_report_extract()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end; $$;
drop trigger if exists market_report_extracts_stamp on public.market_report_extracts;
create trigger market_report_extracts_stamp before insert on public.market_report_extracts
  for each row execute function public.stamp_market_report_extract();

alter table public.market_report_extracts enable row level security;

drop policy if exists market_report_extracts_select on public.market_report_extracts;
drop policy if exists market_report_extracts_insert on public.market_report_extracts;
drop policy if exists market_report_extracts_delete on public.market_report_extracts;

-- No UPDATE policy on purpose: only the background fn (service_role) writes results.
create policy market_report_extracts_select on public.market_report_extracts for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy market_report_extracts_insert on public.market_report_extracts for insert with check (
  org_id = public.current_org()
);
create policy market_report_extracts_delete on public.market_report_extracts for delete using (
  org_id = public.current_org()
);
