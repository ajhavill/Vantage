-- Vantage — deal_report_imports (staged jobs for the CoStar report import).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql.
--
-- The synchronous deal-report-import function 504'd on real CoStar surveys:
-- Netlify sync functions cap at ~26s and Opus takes longer than that reading
-- a multi-building PDF. Exact pattern of market_report_extracts and
-- deal_brochure_extracts: the browser stages the upload here, kicks a
-- BACKGROUND function, and polls this row.
--   1. the browser stages the PDF (or pasted text) here (RLS insert),
--   2. invokes deal-report-import-background with just {token, jobId},
--   3. the fn (service_role) reads the row, extracts with Claude, writes
--      status/result back and CLEARS pdf_b64/src_text,
--   4. the browser polls this row (RLS select) and deletes it after reading.
-- Rows are transient; the browser deletes on consume.
--
-- COMPLIANCE (see supabase/market-spaces.sql): CoStar report contents are
-- broker-internal. Rows are org-scoped; client profiles (org_id NULL) fail
-- closed; nothing here reaches client/portal surfaces.

create table if not exists public.deal_report_imports (
  id uuid primary key,                       -- client-generated job id
  org_id uuid not null references public.orgs(id) on delete cascade,
  deal_id uuid,                              -- originating deal (context only; not enforced)
  filename text,
  pdf_b64  text,                             -- staged upload; cleared by the fn after reading
  src_text text,                             -- pasted-text fallback; cleared likewise
  status text not null default 'queued' check (status in ('queued','done','error')),
  result jsonb,                              -- the extraction, verbatim, when status='done'
  error  text,                               -- friendly message when status='error'
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists deal_report_imports_org_idx
  on public.deal_report_imports(org_id, created_at desc);

create or replace function public.stamp_deal_report_import()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end; $$;
drop trigger if exists deal_report_imports_stamp on public.deal_report_imports;
create trigger deal_report_imports_stamp before insert on public.deal_report_imports
  for each row execute function public.stamp_deal_report_import();

alter table public.deal_report_imports enable row level security;

drop policy if exists deal_report_imports_select on public.deal_report_imports;
drop policy if exists deal_report_imports_insert on public.deal_report_imports;
drop policy if exists deal_report_imports_delete on public.deal_report_imports;

-- No UPDATE policy on purpose: only the background fn (service_role) writes results.
create policy deal_report_imports_select on public.deal_report_imports for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy deal_report_imports_insert on public.deal_report_imports for insert with check (
  org_id = public.current_org()
);
create policy deal_report_imports_delete on public.deal_report_imports for delete using (
  org_id = public.current_org()
);
