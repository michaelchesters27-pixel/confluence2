-- EVE Confluence v5 state-machine patch
-- Safe to run on an existing v4 install.
-- This does not delete data and does not touch the other EVE scanners.

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

alter table public.eve_confluence_trade_ideas
  add column if not exists armed_at timestamptz,
  add column if not exists confirm_started_at timestamptz;

alter table public.eve_confluence_asset_scores
  add column if not exists rank int;

insert into public.eve_confluence_settings (key, value, updated_at, changed_by)
values
  ('forming_touch_minutes', '15'::jsonb, now(), 'v5_patch'),
  ('armed_confirmation_minutes', '30'::jsonb, now(), 'v5_patch'),
  ('confirmation_hold_seconds', '30'::jsonb, now(), 'v5_patch'),
  ('same_symbol_direction_cooldown_minutes', '10'::jsonb, now(), 'v5_patch')
on conflict (key) do nothing;
