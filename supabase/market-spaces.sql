-- Vantage — market_spaces (internal availability tracker).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql + client-portal.sql.
--
-- One row = one available space in the market, held INTERNALLY for broker use.
--
-- SOURCING / FIREWALL (see costar-sourcing-rule memory, updated 2026-07-08):
-- rows may originate from CoStar availability reports and alert emails, which
-- Andrew has authorized for INTERNAL use only. Therefore this table must NEVER
-- feed the public market layer (vantage-data.json), client packages, or the
-- client portal. Enforcement:
--   * RLS below is org-scoped (org_id = current_org()); client-portal profiles
--     carry org_id = NULL so every policy fails closed for clients.
--   * There is deliberately NO client_visible column — nothing here is
--     client-facing, and no service_role function may expose it to portal or
--     package viewers.
--   * A row "graduates" out of the firewall only when a listing broker
--     independently confirms it: the ingester/UI re-sources it
--     (source = 'listing-broker', broker_verified = true), at which point the
--     record is Andrew's own work product and MAY be published.
--
-- source values:
--   'costar-alert'   — parsed from a CoStar saved-search alert email (internal only)
--   'costar-report'  — imported from a CoStar report pulled for a client requirement (internal only)
--   'listing-broker' — confirmed/quoted directly by the listing broker (publishable)
--   'flyer'          — availability flyer / email blast sent to Andrew (publishable)
--   'manual'         — entered by hand (publishable)

create table if not exists public.market_spaces (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- what & where
  building_id   text,                        -- vantage-data.json building id when matched
  building_name text,
  address       text not null,
  suite         text,
  floor         text,
  sf            integer check (sf is null or sf >= 0),
  contiguous_sf integer check (contiguous_sf is null or contiguous_sf >= 0),
  space_type    text check (space_type is null or space_type in ('direct','sublease')),
  product_type  text check (product_type is null or product_type in ('retail','office','industrial','flex','lab')),

  -- economics (as marketed)
  asking_rate  numeric,                      -- $/RSF
  rate_period  text check (rate_period is null or rate_period in ('mo','yr')),
  rate_basis   text check (rate_basis is null or rate_basis in ('FSG','NNN','MG')),

  -- listing side
  listing_broker  text,
  listing_company text,
  listing_email   text,
  listing_phone   text,

  -- provenance + freshness (the whole point of this table)
  source        text not null default 'manual'
    check (source in ('costar-alert','costar-report','listing-broker','flyer','manual')),
  source_detail text,                        -- e.g. alert email subject + date, deal id for a report import
  as_of         date not null,               -- when this info was last known true
  broker_verified boolean not null default false,
  verified_at   timestamptz,

  -- lifecycle
  status text not null default 'active'
    check (status in ('active','in-lease','leased','withdrawn','stale')),

  -- ingest plumbing
  dedup_key text,                            -- normalized address|suite, set by the ingester so re-fired alerts upsert
  raw jsonb,                                 -- the parsed alert/report row, verbatim, for audit

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists market_spaces_org_idx      on public.market_spaces(org_id, status, as_of desc);
create index if not exists market_spaces_org_bldg_idx on public.market_spaces(org_id, building_id);
-- re-fired alerts for the same space update the existing row instead of duplicating
create unique index if not exists market_spaces_org_dedup_uidx
  on public.market_spaces(org_id, dedup_key)
  where dedup_key is not null;

-- Stamp org_id / created_by from the writer's profile when a direct authenticated
-- browser write omits them (functions set org_id explicitly). Same pattern as comps.
create or replace function public.stamp_market_space_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists market_spaces_stamp on public.market_spaces;
create trigger market_spaces_stamp before insert or update on public.market_spaces
  for each row execute function public.stamp_market_space_org();

-- RLS: firm-internal only. Clients (org_id NULL) fail every predicate — by design.
alter table public.market_spaces enable row level security;

drop policy if exists market_spaces_select on public.market_spaces;
drop policy if exists market_spaces_insert on public.market_spaces;
drop policy if exists market_spaces_update on public.market_spaces;
drop policy if exists market_spaces_delete on public.market_spaces;

create policy market_spaces_select on public.market_spaces for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy market_spaces_insert on public.market_spaces for insert with check (
  org_id = public.current_org()
);
create policy market_spaces_update on public.market_spaces for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy market_spaces_delete on public.market_spaces for delete using (
  org_id = public.current_org()
);
