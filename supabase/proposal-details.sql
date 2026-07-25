-- Vantage — proposals.details (letterhead merge details).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER dealflow.sql.
--
-- Andrew's real proposal letterhead (Proposal - Full Service (Office).docx)
-- needs fields the deal tables never carried: the landlord contact block,
-- legal entity names, tenant website, split building address, base year,
-- parking count, commencement date. One jsonb bag on the PROPOSAL (not the
-- round — a landlord contact doesn't change between counters) holds them:
--   { landlord_contact_name, landlord_company, landlord_salutation,
--     landlord_legal_name, tenant_legal_name, tenant_website,
--     building_address, suite_number, building_city, building_state_zip,
--     base_year, parking_spaces, commencement_date, broker_license }
-- Edited in the "Letterhead details" panel on a proposal round; merged by
-- buildMergeData() in deals.html. RLS: proposals already inherits deal access.

alter table public.proposals add column if not exists details jsonb not null default '{}'::jsonb;
