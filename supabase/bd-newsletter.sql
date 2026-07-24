-- Vantage — newsletter issues (the Newsletter section becomes an issue portal).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER bd-sections.sql.
--
-- One bd_newsletters row = one monthly issue ('2026-08'), carrying its own
-- draft (subject + body) and lifecycle: planning -> draft -> sent. Clips are
-- assigned to an issue via bd_clips.issue_month; a NULL issue_month means
-- "next upcoming issue" (the watcher and Van don't need to know the calendar).
-- Past issues stay forever — the section doubles as the sent archive.

alter table public.bd_clips add column if not exists issue_month text; -- 'YYYY-MM'

create table if not exists public.bd_newsletters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  issue_month text not null,          -- 'YYYY-MM'
  status text not null default 'planning' check (status in ('planning','draft','sent')),
  subject text,
  body text,                          -- the working draft (plain/HTML); Phase 3 assembly writes here too
  notes text,
  sent_at timestamptz,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, issue_month)
);

create index if not exists bd_newsletters_org_idx on public.bd_newsletters(org_id, issue_month desc);

create or replace function public.stamp_bd_newsletter()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists bd_newsletters_stamp on public.bd_newsletters;
create trigger bd_newsletters_stamp before insert or update on public.bd_newsletters
  for each row execute function public.stamp_bd_newsletter();

alter table public.bd_newsletters enable row level security;
drop policy if exists bd_newsletters_select on public.bd_newsletters;
drop policy if exists bd_newsletters_insert on public.bd_newsletters;
drop policy if exists bd_newsletters_update on public.bd_newsletters;
drop policy if exists bd_newsletters_delete on public.bd_newsletters;
create policy bd_newsletters_select on public.bd_newsletters for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_newsletters_insert on public.bd_newsletters for insert with check (
  org_id = public.current_org()
);
create policy bd_newsletters_update on public.bd_newsletters for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy bd_newsletters_delete on public.bd_newsletters for delete using (
  org_id = public.current_org()
);
