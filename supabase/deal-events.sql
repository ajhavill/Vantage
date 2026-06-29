-- Vantage deal-flow — client engagement events for the deal viewer.
-- Run in Supabase → SQL Editor AFTER dealflow.sql. Safe to re-run.
--
-- Append-only: each action a client takes on the passcode-gated deal portal
-- (open, view, download) is one immutable row, written by the deal-track Netlify
-- Function using the service_role key (which bypasses RLS). Brokers read only
-- their own deals' events via RLS (can_access_deal). There is no anon/auth insert
-- path — the function is the only writer.

create table if not exists public.deal_events (
  id bigint generated always as identity primary key,
  deal_id uuid not null references public.deals(id) on delete cascade,
  type text not null check (type in ('open','view','download')),
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists deal_events_deal_idx on public.deal_events(deal_id);

alter table public.deal_events enable row level security;
drop policy if exists deal_events_select on public.deal_events;
create policy deal_events_select on public.deal_events for select using (public.can_access_deal(deal_id));
