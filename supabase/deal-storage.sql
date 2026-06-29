-- Vantage deal-flow — Storage bucket + policies for proposal documents.
-- Run in Supabase → SQL Editor AFTER dealflow.sql. Safe to re-run.
--
-- Private bucket "deal-files". Path convention: deal-files/<deal_id>/<filename>
-- so the FIRST folder segment is the deal id. Brokers can read/write a file only
-- if they can access that deal (reuses public.can_access_deal). The client viewer
-- never touches Storage directly — the deal-client-get function (service_role)
-- mints short-lived signed URLs for client-visible files.

-- 1) Private bucket
insert into storage.buckets (id, name, public)
values ('deal-files', 'deal-files', false)
on conflict (id) do nothing;

-- 2) Broker access: full r/w on objects whose first path folder is a deal they can access.
drop policy if exists deal_files_rw on storage.objects;
create policy deal_files_rw on storage.objects
  for all to authenticated
  using (
    bucket_id = 'deal-files'
    and public.can_access_deal( ((storage.foldername(name))[1])::uuid )
  )
  with check (
    bucket_id = 'deal-files'
    and public.can_access_deal( ((storage.foldername(name))[1])::uuid )
  );
