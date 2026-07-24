-- Vantage — BD Command Center (bd_queue + bd_templates + bd_job_runs).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql.
--
-- The BD system of record stays in HubSpot (contacts carry the marketing-program
-- state machine: marketing_program_status / _step / next_touch_date / _type).
-- These tables are Vantage's EXECUTION layer on top of it:
--   * bd_queue     — the morning touch queue. One row = one drafted touch (email/
--                    call/mail) for one contact, produced by the bd-cadence engine
--                    (or a signal watcher / manual add). Approving a row sends or
--                    completes it and advances the contact's program state in HubSpot.
--   * bd_templates — the program's email/call/mail copy with {{merge}} fields,
--                    per step. HubSpot Free caps templates at 3; ours live here.
--   * bd_job_runs  — heartbeat log for the automation jobs, so the Command Center
--                    can show "how it's all syncing" honestly (last run, result).
--
-- RLS: org-scoped like market_spaces. Client-portal profiles carry org_id = NULL,
-- so every policy fails closed for clients — this is broker-internal only.

-- ============================== bd_queue ==============================
create table if not exists public.bd_queue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- who this touch is for (HubSpot is the roster; we denormalize for display)
  hs_contact_id text not null,
  hs_company_id text,
  contact_name  text,
  company_name  text,
  email         text,
  phone         text,

  -- the touch itself
  touch_type text not null check (touch_type in ('email','call','mail')),
  source     text not null default 'cadence' check (source in ('cadence','signal','manual')),
  step       integer,                -- 1..10 program step this touch completes (null for signal/manual)
  step_label text,                   -- e.g. "Email #1 — submarket snapshot"
  due_date   date not null,
  subject    text,                   -- emails: subject line
  body       text,                   -- emails: full draft; calls: talking points; mail: what to print
  signal_note text,                  -- signal-sourced touches: the triggering news, verbatim

  -- lifecycle
  status  text not null default 'pending'
    check (status in ('pending','sent','done','skipped','failed')),
  error   text,
  sent_at timestamptz,

  -- idempotent daily runs: re-running the engine upserts instead of duplicating
  dedup_key text not null,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bd_queue_org_status_idx on public.bd_queue(org_id, status, due_date);
create unique index if not exists bd_queue_org_dedup_uidx on public.bd_queue(org_id, dedup_key);

create or replace function public.stamp_bd_queue()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists bd_queue_stamp on public.bd_queue;
create trigger bd_queue_stamp before insert or update on public.bd_queue
  for each row execute function public.stamp_bd_queue();

alter table public.bd_queue enable row level security;
drop policy if exists bd_queue_select on public.bd_queue;
drop policy if exists bd_queue_insert on public.bd_queue;
drop policy if exists bd_queue_update on public.bd_queue;
drop policy if exists bd_queue_delete on public.bd_queue;
create policy bd_queue_select on public.bd_queue for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_queue_insert on public.bd_queue for insert with check (
  org_id = public.current_org()
);
create policy bd_queue_update on public.bd_queue for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy bd_queue_delete on public.bd_queue for delete using (
  org_id = public.current_org()
);

-- ============================ bd_templates ============================
create table if not exists public.bd_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  step integer not null,
  touch_type text not null check (touch_type in ('email','call','mail')),
  subject text,
  body text not null,
  updated_at timestamptz not null default now(),
  unique (org_id, step)
);

alter table public.bd_templates enable row level security;
drop policy if exists bd_templates_select on public.bd_templates;
drop policy if exists bd_templates_upsert on public.bd_templates;
drop policy if exists bd_templates_update on public.bd_templates;
create policy bd_templates_select on public.bd_templates for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_templates_upsert on public.bd_templates for insert with check (
  org_id = public.current_org()
);
create policy bd_templates_update on public.bd_templates for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);

-- Starter copy for every org that doesn't have it yet (Andrew redlines in place;
-- {{first_name}} {{company}} {{submarket}} are merge fields filled by the engine).
insert into public.bd_templates (org_id, step, touch_type, subject, body)
select o.id, t.step, t.touch_type, t.subject, t.body
from public.orgs o
cross join (values
  (1,'mail', null::text,
   'PRINT + MAIL: 8–10 page Havill & Co. brochure with a hand-written personal note to {{first_name}}. Reference something specific about {{company}} in the note.'),
  (2,'call', null,
   'CALL #1 — reference the brochure. VM is OK on this one. Opener: "I mailed you a piece last week on what {{submarket}} tenants are paying — wanted to put a voice to it." If VM: send the same-day bridge email from the queue.'),
  (3,'email','What {{submarket}} landlords are asking right now',
   'Hi {{first_name}},'||chr(10)||chr(10)||'Quick snapshot from the ground in {{submarket}}: asking rates, concessions, and where the leverage actually is for tenants right now. Happy to send the one-pager.'||chr(10)||chr(10)||'Worth 15 minutes to see what this means for {{company}}''s lease?'||chr(10)||chr(10)||'Andrew Havill'||chr(10)||'Havill & Co.'),
  (4,'call', null,
   'CALL #2 — NO voicemail. If no answer, hang up; the engine advances automatically.'),
  (5,'email','{{company}} — one thing worth knowing about your building',
   'Hi {{first_name}},'||chr(10)||chr(10)||'One building-specific note I thought you should have — recent activity near your space changes the math on a renewal.'||chr(10)||chr(10)||'15 minutes and I''ll show you exactly what I mean.'||chr(10)||chr(10)||'Andrew Havill'||chr(10)||'Havill & Co.'),
  (6,'mail', null,
   'PRINT + MAIL: Havill & Co. unique-value letter (single signer: Andrew Havill, DRE #02039670), hand-signed. Fresh Havill & Co. copy only — never the old HM letter.'),
  (7,'call', null,
   'CALL #3 — VM referencing the letter: "The letter I sent lays out the two ways tenants leave money on the table in {{submarket}} — the second one is the expensive one."'),
  (8,'email','15 minutes next week?',
   'Hi {{first_name}},'||chr(10)||chr(10)||'Direct ask: 15–20 minutes to walk through what {{company}}''s options look like before your lease decision window narrows.'||chr(10)||chr(10)||'Would Tuesday 10am or Thursday 2pm work?'||chr(10)||chr(10)||'Andrew Havill'||chr(10)||'Havill & Co.'),
  (9,'call', null,
   'CALL #4 — NO voicemail. Last live-touch attempt before the breakup email.'),
  (10,'email','Closing the loop',
   'Hi {{first_name}},'||chr(10)||chr(10)||'I''ll stop reaching out — clearly the timing isn''t right, and I respect your inbox.'||chr(10)||chr(10)||'When {{company}}''s lease does come up, the market data is yours for the asking. No pitch, just the numbers.'||chr(10)||chr(10)||'Andrew Havill'||chr(10)||'Havill & Co.')
) as t(step, touch_type, subject, body)
on conflict (org_id, step) do nothing;

-- ============================ bd_job_runs =============================
create table if not exists public.bd_job_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,   -- null = platform-wide job
  job text not null,                 -- 'bd-cadence', 'bd-signals', ...
  ok boolean not null default true,
  note text,
  counts jsonb,
  ran_at timestamptz not null default now()
);
create index if not exists bd_job_runs_job_idx on public.bd_job_runs(job, ran_at desc);

-- Read-only for brokers (any org member; job rows may be platform-wide). Writes
-- happen only through service-role functions — no insert/update policies.
alter table public.bd_job_runs enable row level security;
drop policy if exists bd_job_runs_select on public.bd_job_runs;
create policy bd_job_runs_select on public.bd_job_runs for select using (
  public.current_org() is not null
);
