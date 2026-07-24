-- Vantage — bd_alert_feeds (Google Alerts RSS registry for the BD signal watcher).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER schema.sql + bd-center.sql.
--
-- Andrew keeps businesses separated: alert mail must NOT flow into the connected
-- quorwellness Gmail, and Claude's Gmail connector only holds one account. So the
-- signal lane uses Google Alerts' RSS delivery instead of email: each alert
-- (created in the dedicated havillalerts@gmail.com account with "Deliver to:
-- RSS feed") has a public-but-unguessable feed URL. This table is the registry;
-- the daily bd-signal-watch scheduled task fetches every active feed — no inbox,
-- no forwarding, no credentials.
--
-- One row = one alert feed, usually tied to a HubSpot company (or an exec name
-- for top targets — company fields then point at their company).

create table if not exists public.bd_alert_feeds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  feed_url text not null,            -- https://www.google.com/alerts/feeds/...
  label text not null,               -- the alert query, e.g. "Acme Studios" or "Jane Doe CEO"
  kind text not null default 'company' check (kind in ('company','exec','topic')),
  hs_company_id text,                -- HubSpot company this watches (null for topic feeds)
  company_name text,

  active boolean not null default true,
  last_fetched_at timestamptz,
  last_item_at timestamptz,          -- newest entry seen, for freshness display

  created_at timestamptz not null default now(),
  unique (org_id, feed_url)
);

create index if not exists bd_alert_feeds_org_idx on public.bd_alert_feeds(org_id, active);

-- RLS: broker-internal, org-scoped; client-portal profiles (org_id NULL) fail closed.
alter table public.bd_alert_feeds enable row level security;
drop policy if exists bd_alert_feeds_select on public.bd_alert_feeds;
drop policy if exists bd_alert_feeds_insert on public.bd_alert_feeds;
drop policy if exists bd_alert_feeds_update on public.bd_alert_feeds;
drop policy if exists bd_alert_feeds_delete on public.bd_alert_feeds;
create policy bd_alert_feeds_select on public.bd_alert_feeds for select using (
  org_id = public.current_org() or public.is_platform_admin()
);
create policy bd_alert_feeds_insert on public.bd_alert_feeds for insert with check (
  org_id = public.current_org()
);
create policy bd_alert_feeds_update on public.bd_alert_feeds for update using (
  org_id = public.current_org()
) with check (
  org_id = public.current_org()
);
create policy bd_alert_feeds_delete on public.bd_alert_feeds for delete using (
  org_id = public.current_org()
);
