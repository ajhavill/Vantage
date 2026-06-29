-- Vantage portal — DEAL-FLOW module (tours → proposals → negotiation → executed → lease abstract).
-- Run in Supabase → SQL Editor AFTER schema.sql (it relies on orgs, profiles, packages,
-- and the helpers current_org() / is_org_admin() / is_platform_admin()). Safe to re-run.
--
-- MENTAL MODEL (how Andrew described it):
--   * A won client becomes a DEAL. A deal moves through stages.
--   * You upload a proposal you made → it goes in the portal → the people you choose can see it.
--   * You throw in the next ROUND (your offer or the landlord's response) and it updates —
--     every round is kept, so the side-by-side compare always reflects the latest while
--     preserving the full history.
--
-- TENANCY: deals carry org_id (auto-stamped from the broker who owns them). Every child
-- row (properties, proposals, rounds, documents, abstracts, tours) carries deal_id and is
-- access-scoped THROUGH its deal via can_access_deal() — one source of truth, can't drift.
--
-- CLIENT SHARING: identical pattern to packages. The client opens a passcode-gated link
-- (no login) served by a Netlify Function using the service_role key (bypasses RLS), which
-- returns ONLY rows flagged client_visible = true. So the broker controls exactly what the
-- client sees; nothing is "hidden UI", it's data scoping.

-- 1) Deals — one per client engagement (optionally born from a won package)
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  package_id uuid references public.packages(id) on delete set null,  -- the won package, if any
  client_name text,
  client_logo_url text,
  stage text not null default 'touring'
    check (stage in ('touring','proposals','negotiation','executed','dead')),
  -- client-viewer access (set when you share; null until then)
  slug text unique,
  passcode_hash text,
  salt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deals_owner_idx on public.deals(owner_id);
create index if not exists deals_org_idx   on public.deals(org_id);

-- 2) Deal properties — the buildings in play for this deal (the tour list + proposal anchors).
--    Self-contained: keeps name/address denormalized so it survives catalog changes, and
--    references the vantage-data building only by id (string) — no hard dependency.
create table if not exists public.deal_properties (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  building_id text,                 -- optional ref into vantage-data.json buildings
  name text,
  address text,
  status text not null default 'considering'
    check (status in ('considering','touring','shortlisted','proposing','passed')),
  client_visible boolean not null default true,
  sort_order int not null default 0,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists deal_properties_deal_idx on public.deal_properties(deal_id);

-- 3) Tour stops — scheduled visits (the "tour schedule / what we're seeing" piece)
create table if not exists public.tour_stops (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  property_id uuid references public.deal_properties(id) on delete set null,
  building_id text,
  label text,                       -- e.g. building name if no property row yet
  scheduled_at timestamptz,
  status text not null default 'proposed'
    check (status in ('proposed','confirmed','toured','cancelled')),
  client_visible boolean not null default true,
  sort_order int not null default 0,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists tour_stops_deal_idx on public.tour_stops(deal_id);

-- 4) Proposals — one negotiation thread, usually tied to a property.
--    "Upload a proposal" creates/extends one of these; the rounds hold the actual offers.
create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  property_id uuid references public.deal_properties(id) on delete set null,
  title text,                       -- e.g. "Water Garden — Suite 300"
  status text not null default 'active'
    check (status in ('active','accepted','declined','withdrawn')),
  client_visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposals_deal_idx on public.proposals(deal_id);

-- 5) Proposal rounds — the versioned back-and-forth. "Next round" = insert a new row.
--    from_party = who issued THIS round: 'tenant' (our/our client's offer) or 'landlord' (their response).
--    Key economics are first-class columns so the side-by-side compare + effective-rent math
--    is reliable; anything unusual goes in economics (jsonb).
create table if not exists public.proposal_rounds (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,       -- denormalized for RLS
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  round_no int not null default 1,
  from_party text not null default 'tenant' check (from_party in ('tenant','landlord')),
  summary text,                     -- human note ("LL countered, held on TI")
  -- economics
  size_sf numeric,
  term_months int,
  rent_basis text,                  -- 'FSG' | 'NNN' | 'MG' | etc. (free text, lease structure)
  base_rent_psf numeric,            -- starting rate
  annual_escalation_pct numeric,    -- yearly bump %
  free_rent_months numeric,
  ti_psf numeric,                   -- tenant improvement allowance $/sf
  opex_psf numeric,                 -- operating expenses / NNN load $/sf (if applicable)
  economics jsonb not null default '{}'::jsonb,  -- parking, options, anything else structured
  client_visible boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists rounds_proposal_idx on public.proposal_rounds(proposal_id);
create index if not exists rounds_deal_idx     on public.proposal_rounds(deal_id);

-- 6) Documents — uploaded files (the actual proposal PDFs, responses, redlines, signed lease).
--    Stored in Supabase Storage; this table holds metadata + the storage path. Nullable links
--    let a file attach to a round, a proposal, a property, an abstract, or just the deal.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  proposal_id uuid references public.proposals(id) on delete cascade,
  round_id uuid references public.proposal_rounds(id) on delete cascade,
  property_id uuid references public.deal_properties(id) on delete set null,
  abstract_id uuid,                 -- set in §7 below (FK added after lease_abstracts exists)
  kind text not null default 'other'
    check (kind in ('proposal','response','redline','lease','exhibit','other')),
  filename text not null,
  storage_path text not null,       -- path within the Storage bucket
  mime text,
  size_bytes bigint,
  client_visible boolean not null default false,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists documents_deal_idx  on public.documents(deal_id);
create index if not exists documents_round_idx on public.documents(round_id);

-- 7) Lease abstracts — the permanent critical-info record the client always has post-signing.
create table if not exists public.lease_abstracts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  property_id uuid references public.deal_properties(id) on delete set null,
  tenant_name text,
  landlord_name text,
  premises text,
  size_sf numeric,
  commencement_date date,
  expiration_date date,
  base_rent_psf numeric,
  escalations text,
  options text,                     -- renewal / expansion / termination options
  security_deposit numeric,
  key_dates jsonb not null default '[]'::jsonb,  -- [{label, date}] critical-date reminders
  data jsonb not null default '{}'::jsonb,       -- everything else
  client_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists abstracts_deal_idx on public.lease_abstracts(deal_id);

-- wire documents.abstract_id now that the table exists (idempotent)
do $$ begin
  alter table public.documents
    add constraint documents_abstract_fk
    foreign key (abstract_id) references public.lease_abstracts(id) on delete set null;
exception when duplicate_object then null; end $$;

-- 8) Stamp org_id on a new deal from its owner (reuses the same trigger fn as packages/reports)
drop trigger if exists deals_stamp_org on public.deals;
create trigger deals_stamp_org before insert on public.deals
  for each row execute function public.stamp_org_id();

-- 9) Access helper — can the current user touch this deal? (owner, that firm's org_admin, or platform)
create or replace function public.can_access_deal(p_deal uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.deals d
    where d.id = p_deal
      and ( d.owner_id = auth.uid()
         or (public.is_org_admin() and d.org_id = public.current_org())
         or public.is_platform_admin() )
  );
$$;

-- 10) Row-Level Security
alter table public.deals           enable row level security;
alter table public.deal_properties enable row level security;
alter table public.tour_stops      enable row level security;
alter table public.proposals       enable row level security;
alter table public.proposal_rounds enable row level security;
alter table public.documents       enable row level security;
alter table public.lease_abstracts enable row level security;

-- Deals: owner/org_admin/platform can read; owner writes (parallels packages).
drop policy if exists deals_select     on public.deals;
drop policy if exists deals_insert_own on public.deals;
drop policy if exists deals_update_own on public.deals;
drop policy if exists deals_delete_own on public.deals;
create policy deals_select on public.deals for select using (
  owner_id = auth.uid()
  or (public.is_org_admin() and org_id = public.current_org())
  or public.is_platform_admin()
);
create policy deals_insert_own on public.deals for insert with check (owner_id = auth.uid());
create policy deals_update_own on public.deals for update using (
  owner_id = auth.uid() or (public.is_org_admin() and org_id = public.current_org()) or public.is_platform_admin()
);
create policy deals_delete_own on public.deals for delete using (
  owner_id = auth.uid() or public.is_platform_admin()
);

-- Child tables: full access iff you can access the parent deal. One policy each, all uniform.
drop policy if exists deal_properties_all on public.deal_properties;
create policy deal_properties_all on public.deal_properties for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));

drop policy if exists tour_stops_all on public.tour_stops;
create policy tour_stops_all on public.tour_stops for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));

drop policy if exists proposals_all on public.proposals;
create policy proposals_all on public.proposals for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));

drop policy if exists rounds_all on public.proposal_rounds;
create policy rounds_all on public.proposal_rounds for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));

drop policy if exists documents_all on public.documents;
create policy documents_all on public.documents for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));

drop policy if exists abstracts_all on public.lease_abstracts;
create policy abstracts_all on public.lease_abstracts for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));
