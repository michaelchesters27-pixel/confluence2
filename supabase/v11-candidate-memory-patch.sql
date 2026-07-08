-- EVE Confluence v11 candidate-memory patch
-- Safe to run on an existing v10 install.
-- It does not delete data and does not touch Bias, Structure, Zones or Liquidity tables.

alter table public.eve_confluence_trade_ideas
  drop constraint if exists eve_confluence_trade_ideas_status_check;

alter table public.eve_confluence_trade_ideas
  add constraint eve_confluence_trade_ideas_status_check check (status in (
    'watch_only',
    'forming',
    'armed',
    'active',
    'won',
    'lost',
    'no_trigger',
    'invalidated_before_entry',
    'expired',
    'cancelled'
  ));

insert into public.eve_confluence_settings (key, value, updated_at, changed_by)
values
  ('candidate_memory_minutes', '240'::jsonb, now(), 'v11_candidate_memory'),
  ('minimum_rr', '2'::jsonb, now(), 'v11_candidate_memory')
on conflict (key) do nothing;

create index if not exists eve_confluence_ideas_open_memory_idx
  on public.eve_confluence_trade_ideas(status, symbol, direction, expires_at desc)
  where status in ('watch_only', 'forming', 'armed', 'active');
