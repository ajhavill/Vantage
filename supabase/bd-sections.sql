-- Vantage — BD sections (newsletter clip bucket + browser-write plumbing).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER bd-center.sql + bd-alert-feeds.sql.
--
-- bd_clips: the Newsletter section's clip bucket. All month Andrew (or Van, or
-- the signal watcher) drops articles/notes/files here; the first-week-of-month
-- newsletter draft (Phase 3) assembles from whatever is kept. status flow:
-- 'new' -> 'kept' (in the next issue) / 'killed' (hidden) / 'used' (shipped in
-- a past issue, stamped with month_used).

create table if not exists public.bd_clips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  url text,                          -- article link (null for pure notes/files)
  title text,                        -- headline / display name
  note text,                         -- Andrew's take — becomes the newsletter blurb seed
  summary text,                      -- extracted/AI summary of the linked piece
  source text not null default 'manual' check (source in ('manual','van','signal','upload')),
  file_path text,                    -- storage path in the bd-clips bucket (uploads)

  status text not null default 'new' check (status in ('new','kept','killed','used')),
  month_used text,                   -- 'YYYY-MM' once shipped in an issue

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bd_clips_org_idx on public.bd_clips(org_id, status, created_at desc);

create or replace function public.stamp_bd_clip()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists bd_clips_stamp on public.bd_clips;
create trigger bd_clips_stamp before insert or update on public.bd_clips
  for each row execute function public.stamp_bd_clip();

alter table public.bd_clips enable row level security;
drop policy if exists bd_clips_select on public.bd_clips;
drop policy if exists bd_clips_insert on public.bd_clips;
drop policy if exists bd_clips_update on public.bd_clips;
drop policy if exists bd_clips_delete on public.bd_clips;
create policy bd_clips_select on public.bd_clips for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_clips_insert on public.bd_clips for insert with check (
  org_id = public.current_org()
);
create policy bd_clips_update on public.bd_clips for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy bd_clips_delete on public.bd_clips for delete using (
  org_id = public.current_org()
);

-- bd_alert_feeds gets the same stamp trigger so the Signals desk can insert
-- feeds from the browser without knowing the org id (bd-alert-feeds.sql shipped
-- without one — feeds were originally registered via chat only).
create or replace function public.stamp_bd_alert_feed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  return new;
end; $$;
drop trigger if exists bd_alert_feeds_stamp on public.bd_alert_feeds;
create trigger bd_alert_feeds_stamp before insert on public.bd_alert_feeds
  for each row execute function public.stamp_bd_alert_feed();

-- Storage bucket for uploaded clips (PDFs, screenshots). Path convention:
-- bd-clips/<org_id>/<filename> — brokers r/w their own org's folder only.
insert into storage.buckets (id, name, public)
values ('bd-clips', 'bd-clips', false)
on conflict (id) do nothing;

drop policy if exists bd_clips_files_rw on storage.objects;
create policy bd_clips_files_rw on storage.objects
  for all to authenticated
  using (
    bucket_id = 'bd-clips'
    and ((storage.foldername(name))[1])::uuid = public.current_org()
  )
  with check (
    bucket_id = 'bd-clips'
    and ((storage.foldername(name))[1])::uuid = public.current_org()
  );
