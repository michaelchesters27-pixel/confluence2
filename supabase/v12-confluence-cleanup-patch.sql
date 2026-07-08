-- EVE Confluence v12 cleanup patch
-- Run this in Supabase if your existing setting still shows 120 minutes.
-- It does not alter scanner/source tables.

insert into public.eve_confluence_settings (key, value, updated_at, changed_by)
values
  ('candidate_memory_minutes', '240'::jsonb, now(), 'v12_confluence_cleanup')
on conflict (key) do update
set value = excluded.value,
    updated_at = now(),
    changed_by = 'v12_confluence_cleanup';

create index if not exists eve_confluence_ideas_symbol_direction_created_idx
  on public.eve_confluence_trade_ideas(symbol, direction, created_at desc);
