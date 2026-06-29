-- Vantage portal — database schema + security.
-- Run ONCE in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run (uses "if exists/not exists" guards).
--
-- Model: each broker owns their own packages / events / saved reports; an admin
-- (Andrew) can see everything. Row-Level Security enforces this at the database
-- layer, so a broker can never read another broker's data — even by accident.
-- Public client-viewer paths (passcode-gated, no login) go through Netlify
-- Functions using the service_role key, which bypasses RLS by design.

-- 1) Profiles — one row per user, extends Supabase auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'broker' check (role in ('broker','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2) Client packages — a scoped, co-branded shortlist owned by a broker
create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
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
create index if not exists packages_owner_idx on public.packages(owner_id);

-- 3) Engagement events — append-only (Postgres handles concurrent inserts; no race)
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
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reports_owner_idx on public.saved_reports(owner_id);

-- 5) Auto-create a profile whenever a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- 6) Admin helper
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 7) Row-Level Security
alter table public.profiles        enable row level security;
alter table public.packages        enable row level security;
alter table public.package_events  enable row level security;
alter table public.saved_reports   enable row level security;

drop policy if exists profiles_select     on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select     on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update using (id = auth.uid());

drop policy if exists packages_select      on public.packages;
drop policy if exists packages_insert_own  on public.packages;
drop policy if exists packages_update_own  on public.packages;
drop policy if exists packages_delete_own  on public.packages;
create policy packages_select     on public.packages for select using (owner_id = auth.uid() or public.is_admin());
create policy packages_insert_own on public.packages for insert with check (owner_id = auth.uid());
create policy packages_update_own on public.packages for update using (owner_id = auth.uid());
create policy packages_delete_own on public.packages for delete using (owner_id = auth.uid());

drop policy if exists events_select on public.package_events;
create policy events_select on public.package_events for select using (
  public.is_admin() or exists (select 1 from public.packages p where p.id = package_id and p.owner_id = auth.uid())
);

drop policy if exists reports_all_own on public.saved_reports;
create policy reports_all_own on public.saved_reports for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
