-- Vantage portal — DEAL-FLOW add-ons: choosable rent structure + AI proposal drafting.
-- Run in Supabase → SQL Editor AFTER dealflow.sql. Safe to re-run.

-- A) RENT STRUCTURE — make rent_basis a CHOSEN type (the dropdown) instead of free text,
--    with an OTHER escape + a custom label. The side-by-side compare normalizes every
--    structure to a gross-equivalent effective rent (FSG = base; NNN = base + opex_psf;
--    MG = base + tenant opex share), then nets out free rent + amortized TI over the term.
--    Codes: FSG Full Service Gross | MG Modified Gross | IG Industrial Gross
--           NNN Triple Net | NN Double Net | N Single Net | GROSS Flat Gross
--           ABS Absolute Net | OTHER (use rent_basis_label)
alter table public.proposal_rounds add column if not exists rent_basis_label text;
do $$ begin
  alter table public.proposal_rounds add constraint rounds_rent_basis_check
    check (rent_basis is null or rent_basis in
      ('FSG','MG','IG','NNN','NN','N','GROSS','ABS','OTHER'));
exception when duplicate_object then null; end $$;

-- B) PROPOSAL TEMPLATES — brokers upload their reusable proposal templates; the AI fills them.
create table if not exists public.proposal_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  description text,
  body text,                                  -- template text w/ placeholders the AI fills
  fields jsonb not null default '[]'::jsonb,   -- declared variables, e.g. ["tenant_name","base_rent_psf"]
  storage_path text,                           -- optional original file (Word/PDF) in Storage
  is_shared boolean not null default true,     -- usable firm-wide vs. personal to the owner
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists templates_org_idx on public.proposal_templates(org_id);
drop trigger if exists templates_stamp_org on public.proposal_templates;
create trigger templates_stamp_org before insert on public.proposal_templates
  for each row execute function public.stamp_org_id();

-- C) DEAL NOTES — the typed OR dictated deal points that feed the AI drafter
create table if not exists public.deal_notes (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  proposal_id uuid references public.proposals(id) on delete set null,
  author_id uuid references public.profiles(id),
  source text not null default 'text' check (source in ('text','voice')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists deal_notes_deal_idx on public.deal_notes(deal_id);

-- D) ROUNDS get a draft/review lifecycle so AI output is reviewed before the client sees it.
--    status: 'draft' (unreviewed — never shown to client) → 'final' (broker approved).
--    source: 'manual' vs 'ai'. draft_text holds the AI/broker proposal prose; template_id
--    records which template produced it. (Client viewer must require status='final' AND
--    client_visible=true.)
alter table public.proposal_rounds add column if not exists status text not null default 'draft';
do $$ begin
  alter table public.proposal_rounds add constraint rounds_status_check
    check (status in ('draft','final'));
exception when duplicate_object then null; end $$;
alter table public.proposal_rounds add column if not exists source text not null default 'manual';
do $$ begin
  alter table public.proposal_rounds add constraint rounds_source_check
    check (source in ('manual','ai'));
exception when duplicate_object then null; end $$;
alter table public.proposal_rounds add column if not exists draft_text text;
alter table public.proposal_rounds add column if not exists template_id uuid;
do $$ begin
  alter table public.proposal_rounds add constraint rounds_template_fk
    foreign key (template_id) references public.proposal_templates(id) on delete set null;
exception when duplicate_object then null; end $$;

-- E) Row-Level Security for the two new tables
alter table public.proposal_templates enable row level security;
alter table public.deal_notes         enable row level security;

-- Templates: a broker sees their own + the firm's shared ones; org_admin/platform see the firm/all.
--            Only the owner (or org_admin/platform) can edit/delete.
drop policy if exists templates_select on public.proposal_templates;
drop policy if exists templates_write  on public.proposal_templates;
create policy templates_select on public.proposal_templates for select using (
  owner_id = auth.uid()
  or (is_shared and org_id = public.current_org())
  or (public.is_org_admin() and org_id = public.current_org())
  or public.is_platform_admin()
);
create policy templates_write on public.proposal_templates for all using (
  owner_id = auth.uid() or (public.is_org_admin() and org_id = public.current_org()) or public.is_platform_admin()
) with check (
  owner_id = auth.uid() or (public.is_org_admin() and org_id = public.current_org()) or public.is_platform_admin()
);

-- Deal notes: full access iff you can access the parent deal.
drop policy if exists deal_notes_all on public.deal_notes;
create policy deal_notes_all on public.deal_notes for all
  using (public.can_access_deal(deal_id)) with check (public.can_access_deal(deal_id));
