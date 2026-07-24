-- Vantage — deal_surveys (client market-survey links generated from a deal).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER dealflow.sql.
--
-- Phase 3 of the requirement→deliverable flow: one click on the deal's Market
-- report section builds a co-branded client survey package (Netlify Blobs,
-- same store client.html reads) and returns a share link. This table is the
-- broker-side ledger of those links so they stay re-findable from the deal
-- page — the blob store itself deliberately has no list endpoint.
--
-- The ONLY writer is the deal-survey-create Netlify function (service_role).
-- Brokers read/delete their own deals' rows via can_access_deal. Passcodes are
-- never stored here (hashed inside the package blob, like every client package).

create table if not exists public.deal_surveys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  slug text not null,
  url text not null,
  client_name text,
  building_count int,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists deal_surveys_deal_idx on public.deal_surveys(deal_id, created_at desc);

alter table public.deal_surveys enable row level security;

drop policy if exists deal_surveys_select on public.deal_surveys;
drop policy if exists deal_surveys_delete on public.deal_surveys;

-- No insert/update policies on purpose: the function (service_role) is the only writer.
create policy deal_surveys_select on public.deal_surveys for select using (public.can_access_deal(deal_id));
create policy deal_surveys_delete on public.deal_surveys for delete using (public.can_access_deal(deal_id));
