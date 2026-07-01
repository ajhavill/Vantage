-- Vantage deal-flow — commission fields + per-deal transaction checklist.
-- Run in Supabase → SQL Editor AFTER dealflow.sql. Safe to re-run.

-- 1) Commission (+ deal value) on the deal
alter table public.deals add column if not exists deal_value numeric;          -- total lease consideration, optional
alter table public.deals add column if not exists commission_pct numeric;      -- e.g. 4 (%)
alter table public.deals add column if not exists commission_amount numeric;    -- $ amount
alter table public.deals add column if not exists commission_status text;       -- pending | invoiced | paid
alter table public.deals add column if not exists commission_notes text;
do $$ begin
  alter table public.deals add constraint deals_commission_status_check
    check (commission_status is null or commission_status in ('pending','invoiced','paid'));
exception when duplicate_object then null; end $$;

-- 2) Transaction checklist — one row per step per deal (the full lease-deal lifecycle)
create table if not exists public.deal_steps (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  phase text,
  label text not null,
  sort_order int not null default 0,
  status text not null default 'pending' check (status in ('pending','active','done','na')),
  due_date date,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists deal_steps_deal_idx on public.deal_steps(deal_id);

alter table public.deal_steps enable row level security;
drop policy if exists deal_steps_all on public.deal_steps;
create policy deal_steps_all on public.deal_steps for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));
