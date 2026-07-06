-- Vantage — cron run tracker. Run ONCE (safe to re-run) in Supabase → SQL Editor.
--
-- Scheduled Netlify functions are publicly invokable (Netlify doesn't sign the
-- scheduled trigger), so side-effecting crons throttle themselves against this
-- table: deal-critical-dates only sends briefing emails if the last send was
-- >20h ago, no matter who (or what) invokes it. Task creation stays idempotent
-- separately, so manual test invocations remain harmless.
--
-- RLS is enabled with NO policies on purpose: only the service_role key (used
-- by the functions) can read or write it. Brokers never see this table.

create table if not exists public.cron_runs (
  name     text primary key,
  last_run timestamptz not null default now()
);

alter table public.cron_runs enable row level security;
