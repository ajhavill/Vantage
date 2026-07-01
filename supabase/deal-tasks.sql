-- Vantage deal-flow — ad-hoc tasks + commission-paid date (for YTD dashboard).
-- Run in Supabase → SQL Editor AFTER deal-detail.sql. Safe to re-run.

-- When the fee was actually collected — powers "commission collected YTD".
alter table public.deals add column if not exists commission_paid_on date;

-- Tasks / next-actions — can be linked to a deal or stand alone (owner's personal to-do).
create table if not exists public.deal_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  deal_id uuid references public.deals(id) on delete cascade,
  title text not null,
  due_date date,
  priority text check (priority in ('low','normal','high')) default 'normal',
  done boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists deal_tasks_owner_idx on public.deal_tasks(owner_id);
create index if not exists deal_tasks_deal_idx  on public.deal_tasks(deal_id);

alter table public.deal_tasks enable row level security;
drop policy if exists deal_tasks_rw on public.deal_tasks;
create policy deal_tasks_rw on public.deal_tasks for all
  using      (owner_id = auth.uid() or (deal_id is not null and public.can_access_deal(deal_id)))
  with check (owner_id = auth.uid() or (deal_id is not null and public.can_access_deal(deal_id)));
