-- EVE Confluence - One-Asset Trade Focus Engine
-- Run this in the SAME Supabase project as EVE Bias, Zones, Structure and Liquidity.
-- This creates separate Confluence tables. It reads the other scanners but does not change them.

create extension if not exists pgcrypto;

create table if not exists public.eve_confluence_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  changed_by text
);

create table if not exists public.eve_confluence_scan_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  mode text not null default 'starting',
  scanner_enabled boolean not null default true,
  source text not null default 'scheduled',
  assets_checked int not null default 0,
  assets_scored int not null default 0,
  selected_symbol text,
  selected_direction text check (selected_direction in ('buy','sell') or selected_direction is null),
  selected_status text,
  notes text,
  errors jsonb not null default '[]'::jsonb
);

create table if not exists public.eve_confluence_asset_scores (
  id bigserial primary key,
  scan_id uuid not null references public.eve_confluence_scan_runs(id) on delete cascade,
  rank int,
  symbol text not null,
  display_name text,
  asset_class text check (asset_class in ('forex','metal','crypto') or asset_class is null),
  is_open boolean not null default false,
  direction text check (direction in ('buy','sell','none')),
  status text not null default 'no_trade',
  confluence_score numeric not null default 0,
  reason text,

  bias text,
  bias_score numeric,
  structure_bias text,
  structure_score numeric,
  zone_quality numeric,
  liquidity_quality numeric,
  latest_price numeric,

  demand_low numeric,
  demand_high numeric,
  supply_low numeric,
  supply_high numeric,
  target_price numeric,
  stop_loss numeric,
  risk_amount numeric,
  reward_amount numeric,
  rr numeric,
  zone_state text,
  target_source text,
  sl_reason text,

  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.eve_confluence_trade_ideas (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  direction text not null check (direction in ('buy','sell')),
  status text not null check (status in (
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
  )),
  execution_type text not null default 'market_after_confirmation',

  focus_started_at timestamptz not null default now(),
  lock_until timestamptz,
  formed_at timestamptz,
  activated_at timestamptz,
  armed_at timestamptz,
  confirm_started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,

  forming_price numeric,
  entry_price numeric,
  stop_loss numeric not null,
  take_profit numeric not null,
  risk_amount numeric,
  reward_amount numeric,
  rr numeric not null default 0,

  demand_low numeric,
  demand_high numeric,
  supply_low numeric,
  supply_high numeric,
  target_source text,
  sl_reason text,

  touched_zone boolean not null default false,
  touched_zone_at timestamptz,
  last_live_price numeric,
  last_live_at timestamptz,

  outcome text check (outcome in ('win','loss','no_trigger','invalidated_before_entry','expired','cancelled') or outcome is null),
  result_r numeric,
  reason text,
  latest_note text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eve_confluence_current_focus (
  id text primary key default 'current' check (id = 'current'),
  symbol text,
  direction text check (direction in ('buy','sell') or direction is null),
  status text,
  idea_id uuid references public.eve_confluence_trade_ideas(id) on delete set null,
  confluence_score numeric,
  reason text,
  locked_at timestamptz,
  lock_until timestamptz,
  last_scan_id uuid references public.eve_confluence_scan_runs(id) on delete set null,
  last_scan_at timestamptz,
  last_live_price numeric,
  last_live_at timestamptz,
  railway_symbol text,
  railway_status text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.eve_confluence_live_prices (
  symbol text primary key,
  price numeric not null,
  event_time timestamptz,
  received_at timestamptz not null default now(),
  source text not null default 'railway_twelvedata_ws',
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.eve_confluence_events (
  id bigserial primary key,
  event_type text not null,
  symbol text,
  idea_id uuid references public.eve_confluence_trade_ideas(id) on delete set null,
  message text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);


-- Safe patch for existing installs.
alter table public.eve_confluence_asset_scores
  add column if not exists rank int;


-- v5 state-machine safe patches for existing installs.
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

create index if not exists eve_confluence_runs_started_idx
  on public.eve_confluence_scan_runs(started_at desc);

create index if not exists eve_confluence_scores_scan_idx
  on public.eve_confluence_asset_scores(scan_id);

create index if not exists eve_confluence_scores_symbol_created_idx
  on public.eve_confluence_asset_scores(symbol, created_at desc);

create index if not exists eve_confluence_ideas_symbol_status_idx
  on public.eve_confluence_trade_ideas(symbol, status, created_at desc);

create index if not exists eve_confluence_ideas_created_idx
  on public.eve_confluence_trade_ideas(created_at desc);

create index if not exists eve_confluence_events_created_idx
  on public.eve_confluence_events(created_at desc);

insert into public.eve_confluence_settings (key, value, updated_at, changed_by)
values
  ('scanner_enabled', 'true'::jsonb, now(), 'setup'),
  ('minimum_rr', '2'::jsonb, now(), 'setup'),
  ('focus_lock_minutes', '15'::jsonb, now(), 'setup'),
  ('idea_expiry_minutes', '45'::jsonb, now(), 'setup'),
  ('forming_touch_minutes', '15'::jsonb, now(), 'setup'),
  ('armed_confirmation_minutes', '30'::jsonb, now(), 'setup'),
  ('confirmation_hold_seconds', '30'::jsonb, now(), 'setup'),
  ('same_symbol_direction_cooldown_minutes', '10'::jsonb, now(), 'setup')
on conflict (key) do update set value = excluded.value, updated_at = now(), changed_by = 'setup';

insert into public.eve_confluence_current_focus (id, status, reason, updated_at)
values ('current', 'waiting', 'Waiting for first confluence scan', now())
on conflict (id) do nothing;

alter table public.eve_confluence_settings enable row level security;
alter table public.eve_confluence_scan_runs enable row level security;
alter table public.eve_confluence_asset_scores enable row level security;
alter table public.eve_confluence_trade_ideas enable row level security;
alter table public.eve_confluence_current_focus enable row level security;
alter table public.eve_confluence_live_prices enable row level security;
alter table public.eve_confluence_events enable row level security;

-- Netlify and Railway use the Supabase service role key, which bypasses RLS.
-- Do not expose the service role key in the browser.
