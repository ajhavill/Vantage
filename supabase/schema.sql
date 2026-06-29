-- Vantage portal — database schema + security.
-- Run ONCE (and safe to re-run) in Supabase → SQL Editor → New query → paste → Run.
--
-- MULTI-TENANT SHAPE, SINGLE-TENANT SCOPE.
-- The model is built as if many brokerage firms ("orgs") can exist, but for now
-- only ONE org is seeded: Havill & Co. This keeps the door open to licensing
-- Vantage to other firms later WITHOUT a painful migration, while costing almost
-- nothing today. The day a second firm logs in, no row Havill created is visible
-- to them, and nothing has to be backfilled.
--
-- Access tiers (role on the profile):
--   broker         — sees only their own rows (owner_id = auth.uid())
--   org_admin      — sees all rows in their firm (org_id = current_org())
--   platform_admin — sees everything across all firms (the licensor seat = you)
-- Row-Level Security enforces this at the database layer. Public client-viewer
-- paths (passcode-gated, no login) go through Netlify Functions using the
-- service_role key, which bypasses RLS by design.

-- Fixed id for the seed firm so triggers/backfills can reference it deterministically.
-- (Any later firms get random uuids.)

-- 0) Orgs — one row per brokerage firm. Seed: Havill & Co.
create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
insert into public.orgs (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Havill & Co.')
on conflict (id) do nothing;

-- 1) Profiles — one row per user, extends Supabase auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references public.orgs(id),
  email text,
  full_name text,
  role text not null default 'broker' check (role in ('broker','org_admin','platform_admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 1a) Migrations for an already-deployed database (idempotent; no-ops on a fresh DB):
--   - add org_id if the table predates multi-tenancy, and backfill to Havill
--   - migrate the old two-tier role check ('broker','admin') to the 3-tier set,
--     promoting any existing 'admin' to 'platform_admin' (that's you, for now)
alter table public.profiles add column if not exists org_id uuid references public.orgs(id);
update public.profiles set org_id = '00000000-0000-0000-0000-000000000001' where org_id is null;
update public.profiles set role = 'platform_admin' where role = 'admin';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('broker','org_admin','platform_admin'));
create index if not exists profiles_org_idx on public.profiles(org_id);

-- 2) Client packages — a scoped, co-branded shortlist owned by a broker
create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid references public.orgs(id),
  client_name text,
  client_logo_url text,
  passcode_hash text not null,
  salt text not null,
  preset text default 'full',
  buildings jsonb not null default '[]'::jsonb,
  categories jsonb not null default '[]'::jsonb,
  industries jsonb not null default '[]'::jsonb,
  baked_commute jsonb,
  created_at timestamptz not null default now()
);
alter table public.packages add column if not exists org_id uuid references public.orgs(id);
update public.packages p set org_id = (select org_id from public.profiles where id = p.owner_id)
  where org_id is null;
create index if not exists packages_owner_idx on public.packages(owner_id);
create index if not exists packages_org_idx   on public.packages(org_id);

-- 3) Engagement events — append-only (Postgres handles concurrent inserts; no race).
--    Org is derived through the parent package, so no org_id column needed here.
create table if not exists public.package_events (
  id bigint generated always as identity primary key,
  package_id uuid not null references public.packages(id) on delete cascade,
  type text not null check (type in ('open','view')),
  building text,
  created_at timestamptz not null default now()
);
create index if not exists events_pkg_idx on public.package_events(package_id);

-- 4) Saved reports — a stored shortlist + priorities a broker can reload
create table if not exists public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid references public.orgs(id),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.saved_reports add column if not exists org_id uuid references public.orgs(id);
update public.saved_reports r set org_id = (select org_id from public.profiles where id = r.owner_id)
  where org_id is null;
create index if not exists reports_owner_idx on public.saved_reports(owner_id);
create index if not exists reports_org_idx   on public.saved_reports(org_id);

-- 5) Auto-create a profile whenever a user signs up.
--    Org assignment: prefer an org_id passed in invite metadata (future invite flow),
--    otherwise default to Havill. So existing/no-metadata signups land in Havill today,
--    and an invite-based multi-firm flow later "just works" by setting user_metadata.org_id.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, org_id, email, full_name)
  values (
    new.id,
    coalesce((new.raw_user_meta_data->>'org_id')::uuid, '00000000-0000-0000-0000-000000000001'),
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- 5a) Stamp org_id on owned rows from the owner's profile when not supplied.
--     Lets app/function code keep inserting packages/reports WITHOUT knowing about
--     orgs yet — org_id auto-populates from whoever owns the row.
create or replace function public.stamp_org_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = new.owner_id;
  end if;
  return new;
end; $$;
drop trigger if exists packages_stamp_org on public.packages;
create trigger packages_stamp_org before insert on public.packages
  for each row execute function public.stamp_org_id();
drop trigger if exists reports_stamp_org on public.saved_reports;
create trigger reports_stamp_org before insert on public.saved_reports
  for each row execute function public.stamp_org_id();

-- 6) Role/scope helpers (security definer so policies can call them without recursion)
create or replace function public.current_org()
returns uuid language sql security definer stable set search_path = public as $$
  select org_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_platform_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'platform_admin');
$$;

create or replace function public.is_org_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'org_admin');
$$;

-- 7) Row-Level Security
alter table public.orgs            enable row level security;
alter table public.profiles        enable row level security;
alter table public.packages        enable row level security;
alter table public.package_events  enable row level security;
alter table public.saved_reports   enable row level security;

-- Orgs: members see their own firm; platform admin sees all; only platform admin
-- creates/edits firms (no firm self-signup yet — a customer-#2 concern).
drop policy if exists orgs_select        on public.orgs;
drop policy if exists orgs_write_platform on public.orgs;
create policy orgs_select         on public.orgs for select
  using (id = public.current_org() or public.is_platform_admin());
create policy orgs_write_platform on public.orgs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Profiles: see self; an org_admin sees their firm's profiles; platform admin sees all.
drop policy if exists profiles_select     on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select on public.profiles for select using (
  id = auth.uid()
  or (public.is_org_admin() and org_id = public.current_org())
  or public.is_platform_admin()
);
create policy profiles_update_own on public.profiles for update using (id = auth.uid());

-- Packages: owner sees own; org_admin sees firm's; platform admin sees all.
drop policy if exists packages_select      on public.packages;
drop policy if exists packages_insert_own  on public.packages;
drop policy if exists packages_update_own  on public.packages;
drop policy if exists packages_delete_own  on public.packages;
create policy packages_select on public.packages for select using (
  owner_id = auth.uid()
  or (public.is_org_admin() and org_id = public.current_org())
  or public.is_platform_admin()
);
create policy packages_insert_own on public.packages for insert with check (owner_id = auth.uid());
create policy packages_update_own on public.packages for update using (owner_id = auth.uid());
create policy packages_delete_own on public.packages for delete using (owner_id = auth.uid());

-- Events: visible if you can see the parent package (owner, firm org_admin, or platform).
drop policy if exists events_select on public.package_events;
create policy events_select on public.package_events for select using (
  public.is_platform_admin()
  or exists (
    select 1 from public.packages p
    where p.id = package_id
      and (p.owner_id = auth.uid() or (public.is_org_admin() and p.org_id = public.current_org()))
  )
);

-- Saved reports: a broker fully manages their own.
drop policy if exists reports_all_own on public.saved_reports;
create policy reports_all_own on public.saved_reports for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 9) Client intake questionnaires — owned by a broker, scoped to their firm.
--    Prospects fill these out with NO login; the public get-intake/submit-intake
--    functions use the service_role key (bypassing RLS) keyed by the unguessable
--    slug. The RLS below governs broker/org_admin/platform read access.
create table if not exists public.intakes (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid references public.orgs(id),
  company_name text,
  status text not null default 'sent' check (status in ('sent','completed')),
  responses jsonb,
  roster_filename text,
  roster_data text,                       -- base64 of the uploaded roster (small files)
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.intakes add column if not exists org_id uuid references public.orgs(id);
update public.intakes i set org_id = (select org_id from public.profiles where id = i.owner_id) where org_id is null;
create index if not exists intakes_owner_idx on public.intakes(owner_id);
create index if not exists intakes_org_idx   on public.intakes(org_id);

drop trigger if exists intakes_stamp_org on public.intakes;
create trigger intakes_stamp_org before insert on public.intakes
  for each row execute function public.stamp_org_id();

alter table public.intakes enable row level security;
drop policy if exists intakes_select     on public.intakes;
drop policy if exists intakes_insert_own on public.intakes;
drop policy if exists intakes_update_own on public.intakes;
drop policy if exists intakes_delete_own on public.intakes;
create policy intakes_select on public.intakes for select using (
  owner_id = auth.uid()
  or (public.is_org_admin() and org_id = public.current_org())
  or public.is_platform_admin()
);
create policy intakes_insert_own on public.intakes for insert with check (owner_id = auth.uid());
create policy intakes_update_own on public.intakes for update using (owner_id = auth.uid());
create policy intakes_delete_own on public.intakes for delete using (owner_id = auth.uid());
