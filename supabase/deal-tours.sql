-- Vantage — saved tour itineraries (persist the tour-route optimizer result).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql + dealflow.sql.
--
-- Why: the tour optimizer bills Google (Routes API) on every run, and until now
-- its result lived only in page state — closing the panel lost the tour and
-- forced a re-run (re-billing). One row = the current saved tour for a deal
-- (unique on deal_id; re-optimizing overwrites). The optimizer writes here on
-- success; the deal page renders from here with NO Google call.

create table if not exists public.deal_tours (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  tour_date date,
  departure text,                        -- e.g. '09:00'
  stops jsonb not null default '[]'::jsonb,
  -- ordered stops: [{buildingId?, name, address, lat, lng, arrive, depart,
  --                  suite?, listingBroker?, listingEmail?, notes?}]
  legs jsonb not null default '[]'::jsonb,
  -- drive legs between consecutive stops: [{fromIdx, toIdx, driveMin}]
  meta jsonb not null default '{}'::jsonb,  -- {totalDriveMin, optimizedAt, options…}
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deal_id)
);

create index if not exists deal_tours_deal_idx on public.deal_tours(deal_id);

create or replace function public.stamp_deal_tour()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists deal_tours_stamp on public.deal_tours;
create trigger deal_tours_stamp before insert or update on public.deal_tours
  for each row execute function public.stamp_deal_tour();

-- RLS: same access rule as the rest of the deal-flow tables.
alter table public.deal_tours enable row level security;
drop policy if exists deal_tours_rw on public.deal_tours;
create policy deal_tours_rw on public.deal_tours for all
  using      (public.can_access_deal(deal_id))
  with check (public.can_access_deal(deal_id));
