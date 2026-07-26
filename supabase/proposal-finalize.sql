-- Vantage — finalizing a proposal (and filing it under its building).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER dealflow.sql +
-- dealflow-ai.sql + proposal-details.sql.
--
-- WHY: until now a finalized proposal left no trace. The letterhead .docx was
-- merged in the browser and handed straight to the Downloads folder — never
-- uploaded, never recorded — so there was no server-side copy of anything a
-- landlord was ever sent, and no way to ask "what have we proposed at this
-- building?". Rounds already carry status draft|final, but that is a per-round
-- flag; it says nothing about the proposal being DONE and filed.
--
-- Finalizing a proposal now: freezes the terms, archives the actual document,
-- and makes it visible on that building's dossier page (building.html).
--
--   finalized_at / finalized_by  — when, and by whom (null = not finalized)
--   final_round_id               — the round whose terms were sent
--   final_doc_id                 — the archived .docx/.pdf in `documents`
--   final_econ                   — FROZEN copy of the economics
--
-- final_econ is a snapshot on purpose. Reading the live round instead would
-- mean editing a round months later silently rewrites what we "proposed" —
-- the building page would show terms that were never sent. The snapshot is
-- what went out; the round stays editable for ongoing negotiation.
--
-- final_doc_id points at a `documents` row rather than a storage path so the
-- existing delete/visibility/cleanup machinery keeps working unchanged. Old
-- versions are NOT deleted when the broker uploads an edited document — the
-- pointer moves and the prior rows remain as history.
--
-- RLS: proposals/documents already inherit deal access via can_access_deal(),
-- so an unauthenticated visitor to the public building.html page reads back
-- exactly zero rows. Confidentiality is enforced here, not in page JS.

alter table public.proposals
  add column if not exists finalized_at   timestamptz,
  add column if not exists finalized_by   uuid references public.profiles(id),
  add column if not exists final_round_id uuid references public.proposal_rounds(id) on delete set null,
  add column if not exists final_doc_id   uuid references public.documents(id) on delete set null,
  add column if not exists final_econ     jsonb not null default '{}'::jsonb;

-- The building page asks "finalized proposals for this building" — a small,
-- highly selective slice, so a partial index keeps it off a seq scan.
create index if not exists proposals_finalized_idx
  on public.proposals(finalized_at desc) where finalized_at is not null;

-- deal_properties.building_id is the hop from a proposal to a catalog building
-- (proposals.property_id -> deal_properties.building_id -> vantage-data.json).
-- The building page filters on it, so it needs its own index.
create index if not exists deal_properties_building_idx
  on public.deal_properties(building_id) where building_id is not null;
