-- ============================================================================
-- Vantage — run this ONCE in Supabase → SQL Editor to enable the deal
-- dashboard, transaction checklist, commission tracking, and tasks.
-- Combines deal-detail.sql + deal-tasks.sql. Safe to re-run.
-- (Requires dealflow.sql to have been run already — it has.)
-- ============================================================================

-- 1) Commission (+ deal value + paid date) on the deal
alter table public.deals add column if not exists deal_value numeric;
alter table public.deals add column if not exists commission_pct numeric;
alter table public.deals add column if not exists commission_amount numeric;
alter table public.deals add column if not exists commission_status text;
alter table public.deals add column if not exists commission_notes text;
alter table public.deals add column if not exists commission_paid_on date;
do $$ begin
  alter table public.deals add constraint deals_commission_status_check
    check (commission_status is null or commission_status in ('pending','invoiced','paid'));
exception when duplicate_object then null; end $$;

-- 2) Transaction checklist — one row per step per deal
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

-- 3) Tasks / next-actions (deal-linked or standalone)
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

-- 4) Verify — every value below should read TRUE
select
  to_regclass('public.deal_steps') is not null as deal_steps_table,
  to_regclass('public.deal_tasks') is not null as deal_tasks_table,
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='deals' and column_name='commission_amount') as commission_columns,
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='deals' and column_name='commission_paid_on') as commission_paid_on;
