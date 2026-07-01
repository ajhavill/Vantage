-- Vantage — email log + connected-mailbox state (provider-agnostic).
-- Run in Supabase → SQL Editor. Safe to re-run. Phase 1 = send-from-platform + log;
-- Phase 2 (inbox sync) reuses these tables once a mailbox is connected via OAuth.

-- Connected mailbox per broker. OAuth tokens are NOT kept here (added server-side, in a
-- secure store, when a provider is wired) — this just tracks which mailbox is connected.
create table if not exists public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid references public.orgs(id),
  provider text check (provider in ('google','microsoft','other')),
  address text,
  status text not null default 'pending' check (status in ('pending','connected','error','disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_accounts_owner_idx on public.email_accounts(owner_id);
alter table public.email_accounts enable row level security;
drop policy if exists email_accounts_rw on public.email_accounts;
create policy email_accounts_rw on public.email_accounts for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Every email logged in the platform (sent from Vantage now; synced inbound later).
create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid references public.orgs(id),
  deal_id uuid references public.deals(id) on delete set null,
  direction text not null default 'outbound' check (direction in ('outbound','inbound')),
  status text not null default 'draft' check (status in ('draft','sent','received','failed')),
  from_addr text,
  to_addr text,
  cc_addr text,
  subject text,
  body text,
  snippet text,
  thread_id text,
  external_id text,
  provider text,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists emails_owner_idx on public.emails(owner_id);
create index if not exists emails_deal_idx  on public.emails(deal_id);
create index if not exists emails_created_idx on public.emails(created_at desc);
alter table public.emails enable row level security;
drop policy if exists emails_rw on public.emails;
create policy emails_rw on public.emails for all
  using      (owner_id = auth.uid() or (deal_id is not null and public.can_access_deal(deal_id)))
  with check (owner_id = auth.uid() or (deal_id is not null and public.can_access_deal(deal_id)));
