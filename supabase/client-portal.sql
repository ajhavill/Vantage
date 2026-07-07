-- Vantage — client portal (tenant-side logins).
-- Run ONCE (safe to re-run) in Supabase → SQL Editor, AFTER schema.sql, dealflow.sql
-- and deal-client-link.sql.
--
-- Adds a fourth access tier: 'client' — a tenant-side user (the broker's client)
-- who signs in with email+password and sees ONLY what brokers have marked
-- client_visible, always through service_role Netlify functions (portal-get).
--
-- SECURITY MODEL — why client profiles carry org_id = NULL:
-- several tables grant read access to "any member of the firm"
-- (comps, tenant_intel_snapshots: org_id = current_org()). A client must never
-- satisfy those predicates, so a client profile has NO org. current_org() then
-- returns NULL and every org-scoped policy fails closed. Clients own no rows, so
-- owner-scoped policies fail too. Their portal data comes exclusively from
-- functions using the service_role key with explicit client_visible filtering —
-- the same pattern as the passcode viewers (deal-client-get / get-package).

-- 1) Allow the 'client' role on profiles.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('broker','org_admin','platform_admin','client'));

-- 2) Signup trigger: invited clients become role='client' with NO org.
--    portal-invite sets user_metadata { vantage_role: 'client' } on the invite;
--    everyone else keeps the existing broker-signup behavior.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.raw_user_meta_data->>'vantage_role') = 'client' then
    insert into public.profiles (id, org_id, email, full_name, role)
    values (
      new.id,
      null,  -- deliberately org-less; see security model above
      new.email,
      coalesce(new.raw_user_meta_data->>'full_name', new.email),
      'client'
    )
    on conflict (id) do nothing;
  else
    insert into public.profiles (id, org_id, email, full_name)
    values (
      new.id,
      coalesce((new.raw_user_meta_data->>'org_id')::uuid, '00000000-0000-0000-0000-000000000001'),
      new.email,
      coalesce(new.raw_user_meta_data->>'full_name', new.email)
    )
    on conflict (id) do nothing;
  end if;
  return new;
end; $$;
-- (the on_auth_user_created trigger from schema.sql already points at this function)

-- Safety net: strip org from any client profile created before this ran.
update public.profiles set org_id = null where role = 'client' and org_id is not null;

-- 3) client_access — which portal users may see which client company's items.
--    The client company is keyed by HubSpot company id (hs_company_id) — the same
--    spine deals / intakes / tenant-intel already use. Several people at one
--    company each get their own row (invited individually, revoked individually).
create table if not exists public.client_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid not null references public.orgs(id),
  hs_company_id text not null,
  client_name text,
  email text,          -- denormalized: brokers can't read client profiles via RLS
  invited_by uuid references public.profiles(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, org_id, hs_company_id)
);
alter table public.client_access add column if not exists email text;
create index if not exists client_access_user_idx    on public.client_access(user_id);
create index if not exists client_access_company_idx on public.client_access(org_id, hs_company_id);

alter table public.client_access enable row level security;
drop policy if exists client_access_own on public.client_access;
drop policy if exists client_access_org on public.client_access;
-- a client may see (only) their own grants — used by the portal to show what they have
create policy client_access_own on public.client_access for select
  using (user_id = auth.uid());
-- brokers manage grants for their firm; platform admin everywhere
create policy client_access_org on public.client_access for all
  using (org_id = public.current_org() or public.is_platform_admin())
  with check (org_id = public.current_org() or public.is_platform_admin());

-- 4) Role helper (for any future policy that needs it).
create or replace function public.is_client()
returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'client');
$$;

-- 4a) SECURITY-CRITICAL — freeze role/org_id against self-escalation.
--   schema.sql's `profiles_update_own` policy has USING (id = auth.uid()) with NO
--   WITH CHECK, so Postgres defaults WITH CHECK to the USING expr — which a user's
--   own row always satisfies. That let ANY logged-in user PATCH their own row's
--   `role`/`org_id` via PostgREST (the anon key is public), e.g. a client setting
--   role='org_admin', org_id=<Havill> — instantly unlocking every org-scoped table
--   (comps, tenant_intel, deals, profiles). This trigger closes that hole
--   independently of the policy (and survives a re-run of schema.sql, which would
--   otherwise restore the unsafe policy). SECURITY INVOKER (the default) so
--   current_role reflects the CALLER: PostgREST SET ROLEs to 'authenticated'/'anon'
--   for end users, 'service_role' for our server functions, and the migration runs
--   as the table owner — so only end-user calls are frozen. Our portal-invite
--   function legitimately sets role/org_id, and it uses the service_role key.
create or replace function public.freeze_profile_privileges()
returns trigger language plpgsql as $$
begin
  if current_role in ('authenticated', 'anon') then
    if new.role is distinct from old.role then
      raise exception 'role cannot be changed by this user';
    end if;
    if new.org_id is distinct from old.org_id then
      raise exception 'org_id cannot be changed by this user';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists profiles_freeze_privileges on public.profiles;
create trigger profiles_freeze_privileges before update on public.profiles
  for each row execute function public.freeze_profile_privileges();

-- Belt-and-braces: also give the policy an explicit WITH CHECK pinning the two
-- sensitive columns to their current values. (If schema.sql is later re-run it
-- reverts to the unsafe form — the trigger above is the durable guarantee.)
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role   = (select p.role   from public.profiles p where p.id = auth.uid())
    and org_id is not distinct from (select p.org_id from public.profiles p where p.id = auth.uid())
  );

-- 5) Packages join the client spine (deals + intakes already have hs_company_id):
--    lets the portal home list a client's option packages ("brochure" phase).
alter table public.packages add column if not exists hs_company_id text;
create index if not exists packages_hs_company_idx on public.packages(org_id, hs_company_id);

-- 6) portal_package_links — attach an existing client package (they live in Netlify
--    Blobs, keyed by slug) to a client company so it shows on their portal home.
--    The broker attaches/detaches from the deal's Portal sheet; the portal opens the
--    package via get-package's token path (no passcode needed for logged-in clients).
create table if not exists public.portal_package_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  hs_company_id text not null,
  slug text not null,
  label text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (org_id, hs_company_id, slug)
);
create index if not exists portal_pkg_links_company_idx on public.portal_package_links(org_id, hs_company_id);

alter table public.portal_package_links enable row level security;
drop policy if exists portal_pkg_links_org on public.portal_package_links;
-- brokers manage their firm's links; clients read nothing directly (service_role serves them)
create policy portal_pkg_links_org on public.portal_package_links for all
  using (org_id = public.current_org() or public.is_platform_admin())
  with check (org_id = public.current_org() or public.is_platform_admin());
