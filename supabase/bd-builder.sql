-- Vantage — program BUILDER (bd_templates becomes the editable program definition).
-- Run ONCE (safe to re-run) with tools/run-sql.js, AFTER bd-newsletter.sql.
--
-- Until now the 10-step cadence (types, day offsets, labels) was hardcoded in
-- functions/_bd.js and bd_templates only held the copy. Andrew wants a full
-- builder: retitle steps, change days, add/remove steps, attach assets (e.g.
-- the digital brochure). So bd_templates rows become the program itself:
--   * label       — the step title shown everywhere
--   * day_offset  — which day of the program the touch fires (ordering truth)
--   * program     — which program the step belongs to ('10-step' for now)
--   * attachment_path — optional asset in the bd-clips bucket (print file /
--                   reference; cold emails still send clean for deliverability)
-- The engine (bd-cadence/bd-queue-act) now reads steps from this table, sorted
-- by day_offset; `step` is just the display position, renumbered by the UI.

alter table public.bd_templates add column if not exists label text;
alter table public.bd_templates add column if not exists day_offset integer;
alter table public.bd_templates add column if not exists program text not null default '10-step';
alter table public.bd_templates add column if not exists attachment_path text;

-- steps are now insertable/removable/reorderable — the fixed (org_id, step)
-- uniqueness gets in the way of renumbering
alter table public.bd_templates drop constraint if exists bd_templates_org_id_step_key;

-- the builder deletes steps from the browser; policy was missing
drop policy if exists bd_templates_delete on public.bd_templates;
create policy bd_templates_delete on public.bd_templates for delete using (
  org_id = public.current_org()
);

-- backfill the seeded 10-step rows with the v2 program's labels + day offsets
update public.bd_templates set day_offset = v.d, label = coalesce(label, v.l)
from (values
  (1, 1,  'Brochure + hand-written note'),
  (2, 9,  'Call #1 — reference the brochure (VM ok, bridge email after)'),
  (3, 15, 'Email #1 — submarket snapshot'),
  (4, 22, 'Call #2 — no voicemail'),
  (5, 28, 'Email #2 — building-specific hook'),
  (6, 35, 'Unique-value letter, hand-signed'),
  (7, 41, 'Call #3 — VM referencing the letter'),
  (8, 48, 'Email #3 — direct meeting ask'),
  (9, 54, 'Call #4 — no voicemail'),
  (10, 61, 'Email #4 — professional breakup')
) as v(s, d, l)
where bd_templates.step = v.s and bd_templates.day_offset is null;

-- queue rows carry the step's attachment so the morning queue can link it
alter table public.bd_queue add column if not exists attachment_path text;
