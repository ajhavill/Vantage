-- Vantage — link deals to a client (HubSpot company id).
-- Run ONCE (safe to re-run) in Supabase → SQL Editor. Depends on dealflow.sql (deals).
--
-- Lets a deal reference the client's HubSpot company id — the same bridge key the
-- Clients hub, tenant-intel, and comps use. The Clients hub's deal-client-list
-- endpoint reads deals by this column so a client's proposals & leases show up on
-- their hub page. Deals without it simply don't appear there (fine).

alter table public.deals add column if not exists hs_company_id text;
create index if not exists deals_org_hs_company_idx on public.deals(org_id, hs_company_id);
