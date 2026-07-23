-- Vantage — deal_brochure_extracts (staged jobs for the brochure auto-filer).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql.
--
-- Phase 2 of the requirement→deliverable flow: the broker drops a BATCH of
-- listing-broker marketing PDFs (brochures, flyers, floor-plan packages) on
-- the deal page, Claude reads each one, identifies WHICH building it belongs
-- to, extracts its available spaces + floor-plan pages, and the broker reviews
-- before anything is filed under the building (building_media + market_spaces).
--
-- One row = one staged PDF awaiting/holding its extraction. Exact pattern of
-- market_report_extracts (see market-reports.sql): Netlify sync functions cap
-- at ~26s and photo-heavy brochures can outrun that, so extraction runs in a
-- BACKGROUND function (deal-brochure-extract-background). Background
-- invocations can't carry a multi-MB payload, so:
--   1. the browser stages the PDF here (RLS insert, pdf_b64),
--   2. invokes the background fn with just {token, jobId},
--   3. the fn (service_role) reads the row, extracts with Claude, writes
--      status/result back and CLEARS pdf_b64,
--   4. the browser polls this row (RLS select) and deletes it after reading.
-- Rows are transient; the browser deletes on consume.
--
-- SOURCING: these are listing brokers' own marketing materials (not CoStar
-- exports) — the CoStar firewall does not apply. Extracted spaces land in
-- market_spaces with source 'flyer'; the PDFs themselves are filed in the
-- public building-media bucket (they are marketing meant to be shown).

create table if not exists public.deal_brochure_extracts (
  id uuid primary key,                       -- client-generated job id
  org_id uuid not null references public.orgs(id) on delete cascade,
  deal_id uuid,                              -- originating deal (context only; not enforced)
  filename text,
  pdf_b64  text,                             -- staged upload; cleared by the fn after reading
  status text not null default 'queued' check (status in ('queued','done','error')),
  result jsonb,                              -- the extraction, verbatim, when status='done'
  error  text,                               -- friendly message when status='error'
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists deal_brochure_extracts_org_idx
  on public.deal_brochure_extracts(org_id, created_at desc);

create or replace function public.stamp_deal_brochure_extract()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end; $$;
drop trigger if exists deal_brochure_extracts_stamp on public.deal_brochure_extracts;
create trigger deal_brochure_extracts_stamp before insert on public.deal_brochure_extracts
  for each row execute function public.stamp_deal_brochure_extract();

alter table public.deal_brochure_extracts enable row level security;

drop policy if exists deal_brochure_extracts_select on public.deal_brochure_extracts;
drop policy if exists deal_brochure_extracts_insert on public.deal_brochure_extracts;
drop policy if exists deal_brochure_extracts_delete on public.deal_brochure_extracts;

-- No UPDATE policy on purpose: only the background fn (service_role) writes results.
create policy deal_brochure_extracts_select on public.deal_brochure_extracts for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy deal_brochure_extracts_insert on public.deal_brochure_extracts for insert with check (
  org_id = public.current_org()
);
create policy deal_brochure_extracts_delete on public.deal_brochure_extracts for delete using (
  org_id = public.current_org()
);
