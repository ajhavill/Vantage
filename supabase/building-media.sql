-- Vantage — Building media (broker-uploaded photos, floor plans, brochures).
-- Run in Supabase → SQL Editor. Depends on schema.sql (orgs, profiles,
-- current_org(), is_platform_admin()). Safe to re-run.
--
-- vantage-data.json is a static file the app can't write to, so uploaded media
-- lives here (metadata) + Storage (the files) and the building dossier
-- (building.html) MERGES these on top of the JSON's built-in photos/floorplans.
-- One row = one uploaded asset for one building (by vantage-data.json building id).

create table if not exists public.building_media (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  building_id  text not null,                    -- vantage-data.json building id
  kind         text not null check (kind in ('photo','floorplan','brochure')),
  storage_path text not null,                    -- object path in the building-media bucket
  url          text not null,                    -- public URL (bucket is public)
  title        text,                             -- caption (photo) / label (floorplan/brochure)
  sort_order   integer not null default 0,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists building_media_org_bldg_idx
  on public.building_media(org_id, building_id, kind, sort_order);

-- Stamp org_id / created_by from the writer's profile if a browser write omits them.
create or replace function public.stamp_building_media()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end; $$;
drop trigger if exists building_media_stamp on public.building_media;
create trigger building_media_stamp before insert on public.building_media
  for each row execute function public.stamp_building_media();

-- RLS: a firm sees and edits only its own building media; platform admin sees all.
alter table public.building_media enable row level security;

drop policy if exists building_media_select on public.building_media;
drop policy if exists building_media_insert on public.building_media;
drop policy if exists building_media_delete on public.building_media;

create policy building_media_select on public.building_media for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy building_media_insert on public.building_media for insert with check (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy building_media_delete on public.building_media for delete using (
  org_id = public.current_org() or public.is_platform_admin()
);

-- Storage: PUBLIC bucket (these are marketing materials meant to be shown to
-- clients). Path convention: building-media/<building_id>/<kind>/<file>.
-- Public read (via the object's public URL, no auth); authenticated write/delete.
insert into storage.buckets (id, name, public)
values ('building-media', 'building-media', true)
on conflict (id) do nothing;

drop policy if exists building_media_objects_rw on storage.objects;
create policy building_media_objects_rw on storage.objects
  for all to authenticated
  using (bucket_id = 'building-media')
  with check (bucket_id = 'building-media');
