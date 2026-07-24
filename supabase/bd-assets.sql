-- Vantage — bd_assets (the template/collateral library behind BD → Templates).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER bd-builder.sql.
--
-- Templates split into kinds (Andrew's ask): cadence programs are step
-- sequences (bd_templates rows); everything else is a reusable ASSET:
--   * COLLATERAL — the physical/visual pieces we actually send: brochure,
--     unique-value letter, personal note card, case study, survey cover,
--     newsletter blocks. These carry a file (PDF/PNG) you can preview.
--   * EMAIL — reusable one-off copy that isn't part of a cadence: deal emails
--     (tour follow-up, RFP cover, proposal delivery) and relationship touches
--     (congrats, renewal opener, referral thank-you, holiday note).
-- Cadence steps attach an asset (bd_templates.asset_id) — e.g. step 1 mails
-- the brochure, and the morning queue links its digital version.

create table if not exists public.bd_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  name text not null,
  kind text not null default 'collateral' check (kind in ('collateral','email')),
  category text,                     -- brochure | letter | note-card | case-study | one-pager |
                                     -- newsletter-block | deal-email | relationship-email | other
  description text,
  subject text,                      -- email assets: subject line
  body text,                         -- email assets: copy (merge fields OK)
  file_path text,                    -- collateral assets: path in the bd-assets bucket

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bd_assets_org_idx on public.bd_assets(org_id, kind, category);

create or replace function public.stamp_bd_asset()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from public.profiles where id = auth.uid();
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists bd_assets_stamp on public.bd_assets;
create trigger bd_assets_stamp before insert or update on public.bd_assets
  for each row execute function public.stamp_bd_asset();

alter table public.bd_assets enable row level security;
drop policy if exists bd_assets_select on public.bd_assets;
drop policy if exists bd_assets_insert on public.bd_assets;
drop policy if exists bd_assets_update on public.bd_assets;
drop policy if exists bd_assets_delete on public.bd_assets;
create policy bd_assets_select on public.bd_assets for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_assets_insert on public.bd_assets for insert with check (
  org_id = public.current_org()
);
create policy bd_assets_update on public.bd_assets for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy bd_assets_delete on public.bd_assets for delete using (
  org_id = public.current_org()
);

-- cadence steps point at a collateral piece (step 1 mails the brochure, etc.)
alter table public.bd_templates add column if not exists asset_id uuid references public.bd_assets(id) on delete set null;

-- Private bucket for collateral files. Path: bd-assets/<org_id>/<filename>
insert into storage.buckets (id, name, public)
values ('bd-assets', 'bd-assets', false)
on conflict (id) do nothing;

drop policy if exists bd_assets_files_rw on storage.objects;
create policy bd_assets_files_rw on storage.objects
  for all to authenticated
  using (
    bucket_id = 'bd-assets'
    and ((storage.foldername(name))[1])::uuid = public.current_org()
  )
  with check (
    bucket_id = 'bd-assets'
    and ((storage.foldername(name))[1])::uuid = public.current_org()
  );

-- Seed the library Andrew's program already implies (idempotent by name+org).
insert into public.bd_assets (org_id, name, kind, category, description)
select o.id, v.name, 'collateral', v.cat, v.descr
from public.orgs o
cross join (values
  ('Havill & Co. brochure', 'brochure', '8–10 page brochure mailed at step 1 — upload the print-ready PDF and the digital version to link in emails.'),
  ('Unique-value letter', 'letter', 'Hand-signed letter mailed at step 6 (Havill & Co. copy, DRE #02039670).'),
  ('Personal note card', 'note-card', 'The hand-written note that rides along with the step-1 brochure.'),
  ('Case study / win story', 'case-study', 'One-pager proving the result — swap per prospect type.'),
  ('Client survey cover', 'one-pager', 'Cover page for the co-branded space survey sent to clients.')
) as v(name, cat, descr)
where not exists (
  select 1 from public.bd_assets a where a.org_id = o.id and a.name = v.name
);

insert into public.bd_assets (org_id, name, kind, category, description, subject, body)
select o.id, v.name, 'email', v.cat, v.descr, v.subj, v.body
from public.orgs o
cross join (values
  ('Post-tour follow-up', 'deal-email', 'Same-day recap after touring space with a client.',
   'Today''s tour — quick recap', 'Hi {{first_name}},'||chr(10)||chr(10)||'Good tour today. Quick recap of what we saw and where each one nets out:'||chr(10)||chr(10)||'[space 1 — impression, economics, watch-outs]'||chr(10)||'[space 2 — …]'||chr(10)||chr(10)||'My read: [recommendation]. Next step is [action] — want me to start there?'||chr(10)||chr(10)||'Andrew'),
  ('Listing broker inquiry', 'deal-email', 'First outreach to a listing broker on a space.',
   'Availability at {{building}}', 'Hi {{first_name}},'||chr(10)||chr(10)||'Representing a tenant looking at {{submarket}} — is {{suite}} at {{building}} still available? Rate, term, TI and delivery timing would help me evaluate.'||chr(10)||chr(10)||'Thanks,'||chr(10)||'Andrew Havill'||chr(10)||'Havill & Co.'),
  ('Renewal conversation opener', 'relationship-email', 'Fires ~9–12 months before a client''s lease expiration.',
   'Your lease is closer than it feels', 'Hi {{first_name}},'||chr(10)||chr(10)||'Your lease at {{building}} comes up {{lease_expiration}}. The leverage window opens well before that — landlords price renewals very differently when they know a tenant has options.'||chr(10)||chr(10)||'Worth 20 minutes to map the timeline?'||chr(10)||chr(10)||'Andrew'),
  ('Referral thank-you', 'relationship-email', 'Immediately after someone sends a referral.',
   'Thank you', 'Hi {{first_name}},'||chr(10)||chr(10)||'Thank you for the introduction to {{company}} — that means a lot, and I''ll take care of them.'||chr(10)||chr(10)||'Andrew'),
  ('Year-end note', 'relationship-email', 'December touch to the whole warm list.',
   'Thank you for a good year', 'Hi {{first_name}},'||chr(10)||chr(10)||'Closing out the year — thank you for the trust, the introductions, and the conversations.'||chr(10)||chr(10)||'Here''s to a strong {{next_year}}.'||chr(10)||chr(10)||'Andrew')
) as v(name, cat, descr, subj, body)
where not exists (
  select 1 from public.bd_assets a where a.org_id = o.id and a.name = v.name
);
