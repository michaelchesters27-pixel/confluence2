-- ============================================================
-- EVE CONFLUENCE v14 - COMPLETE SUPABASE SETUP
-- ============================================================
-- Run this ONE file in the same Supabase project used by:
--   eve_market_scores
--   eve_zones_market_zones
--   eve_structure_market_results
--   eve_liquidity_market_results
--
-- Safe for an existing EVE Confluence installation.
-- Historical rows are preserved. Any unfinished old idea is cancelled
-- so v14 starts with one clean focus lifecycle.
-- ============================================================

begin;

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
  selected_direction text,
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
  asset_class text,
  is_open boolean not null default false,
  direction text,
  status text not null default 'no_trade',
  strategy_type text,
  session_name text,
  confluence_score numeric not null default 0,
  reason text,
  bias text,
  bias_score numeric,
  structure_bias text,
  structure_score numeric,
  zone_quality numeric,
  liquidity_quality numeric,
  latest_price numeric,
  planned_entry numeric,
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
  direction text not null,
  status text not null,
  strategy_type text not null default 'legacy',
  session_name text,
  idea_score numeric,
  execution_type text not null default 'railway_live_zone_reaction_v14',

  focus_started_at timestamptz not null default now(),
  lock_until timestamptz,
  formed_at timestamptz,
  activated_at timestamptz,
  armed_at timestamptz,
  confirm_started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  active_expires_at timestamptz,
  last_checked_at timestamptz,

  planned_entry numeric,
  forming_price numeric,
  entry_price numeric,
  trigger_price numeric,
  confirmation_price numeric,
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
  touch_extreme_price numeric,
  confirmation_tick_count int not null default 0,
  last_live_price numeric,
  last_live_at timestamptz,

  max_favourable_price numeric,
  max_adverse_price numeric,
  best_r numeric,
  worst_r numeric,

  outcome text,
  result_r numeric,
  reason text,
  latest_note text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eve_confluence_current_focus (
  id text primary key default 'current',
  symbol text,
  direction text,
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

-- ------------------------------------------------------------
-- Safe upgrades for existing tables
-- ------------------------------------------------------------

alter table public.eve_confluence_scan_runs
  add column if not exists completed_at timestamptz,
  add column if not exists mode text not null default 'starting',
  add column if not exists scanner_enabled boolean not null default true,
  add column if not exists source text not null default 'scheduled',
  add column if not exists assets_checked int not null default 0,
  add column if not exists assets_scored int not null default 0,
  add column if not exists selected_symbol text,
  add column if not exists selected_direction text,
  add column if not exists selected_status text,
  add column if not exists notes text,
  add column if not exists errors jsonb not null default '[]'::jsonb;

alter table public.eve_confluence_asset_scores
  add column if not exists rank int,
  add column if not exists display_name text,
  add column if not exists asset_class text,
  add column if not exists is_open boolean not null default false,
  add column if not exists direction text,
  add column if not exists status text not null default 'no_trade',
  add column if not exists strategy_type text,
  add column if not exists session_name text,
  add column if not exists confluence_score numeric not null default 0,
  add column if not exists reason text,
  add column if not exists bias text,
  add column if not exists bias_score numeric,
  add column if not exists structure_bias text,
  add column if not exists structure_score numeric,
  add column if not exists zone_quality numeric,
  add column if not exists liquidity_quality numeric,
  add column if not exists latest_price numeric,
  add column if not exists planned_entry numeric,
  add column if not exists demand_low numeric,
  add column if not exists demand_high numeric,
  add column if not exists supply_low numeric,
  add column if not exists supply_high numeric,
  add column if not exists target_price numeric,
  add column if not exists stop_loss numeric,
  add column if not exists risk_amount numeric,
  add column if not exists reward_amount numeric,
  add column if not exists rr numeric,
  add column if not exists zone_state text,
  add column if not exists target_source text,
  add column if not exists sl_reason text,
  add column if not exists raw jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

alter table public.eve_confluence_trade_ideas
  add column if not exists strategy_type text,
  add column if not exists session_name text,
  add column if not exists idea_score numeric,
  add column if not exists execution_type text not null default 'railway_live_zone_reaction_v14',
  add column if not exists focus_started_at timestamptz not null default now(),
  add column if not exists lock_until timestamptz,
  add column if not exists formed_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists armed_at timestamptz,
  add column if not exists confirm_started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists active_expires_at timestamptz,
  add column if not exists last_checked_at timestamptz,
  add column if not exists planned_entry numeric,
  add column if not exists forming_price numeric,
  add column if not exists entry_price numeric,
  add column if not exists trigger_price numeric,
  add column if not exists confirmation_price numeric,
  add column if not exists risk_amount numeric,
  add column if not exists reward_amount numeric,
  add column if not exists demand_low numeric,
  add column if not exists demand_high numeric,
  add column if not exists supply_low numeric,
  add column if not exists supply_high numeric,
  add column if not exists target_source text,
  add column if not exists sl_reason text,
  add column if not exists touched_zone boolean not null default false,
  add column if not exists touched_zone_at timestamptz,
  add column if not exists touch_extreme_price numeric,
  add column if not exists confirmation_tick_count int not null default 0,
  add column if not exists last_live_price numeric,
  add column if not exists last_live_at timestamptz,
  add column if not exists max_favourable_price numeric,
  add column if not exists max_adverse_price numeric,
  add column if not exists best_r numeric,
  add column if not exists worst_r numeric,
  add column if not exists outcome text,
  add column if not exists result_r numeric,
  add column if not exists reason text,
  add column if not exists latest_note text,
  add column if not exists raw jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.eve_confluence_current_focus
  add column if not exists symbol text,
  add column if not exists direction text,
  add column if not exists status text,
  add column if not exists idea_id uuid references public.eve_confluence_trade_ideas(id) on delete set null,
  add column if not exists confluence_score numeric,
  add column if not exists reason text,
  add column if not exists locked_at timestamptz,
  add column if not exists lock_until timestamptz,
  add column if not exists last_scan_id uuid references public.eve_confluence_scan_runs(id) on delete set null,
  add column if not exists last_scan_at timestamptz,
  add column if not exists last_live_price numeric,
  add column if not exists last_live_at timestamptz,
  add column if not exists railway_symbol text,
  add column if not exists railway_status text,
  add column if not exists raw jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

-- Normalise old rows before recreating constraints.
update public.eve_confluence_trade_ideas
set strategy_type = coalesce(nullif(strategy_type, ''), raw->'trade_engine'->>'strategy_type', 'legacy')
where strategy_type is null or strategy_type = '';

update public.eve_confluence_trade_ideas
set status = 'cancelled',
    outcome = 'cancelled',
    completed_at = coalesce(completed_at, now()),
    latest_note = 'Closed automatically when EVE Confluence v14 was installed.',
    updated_at = now()
where status in ('watch_only', 'forming', 'armed', 'active');

alter table public.eve_confluence_trade_ideas
  alter column strategy_type set default 'legacy',
  alter column strategy_type set not null;

alter table public.eve_confluence_scan_runs
  drop constraint if exists eve_confluence_scan_runs_selected_direction_check;

alter table public.eve_confluence_asset_scores
  drop constraint if exists eve_confluence_asset_scores_asset_class_check,
  drop constraint if exists eve_confluence_asset_scores_direction_check;

alter table public.eve_confluence_trade_ideas
  drop constraint if exists eve_confluence_trade_ideas_direction_check,
  drop constraint if exists eve_confluence_trade_ideas_status_check,
  drop constraint if exists eve_confluence_trade_ideas_outcome_check;

alter table public.eve_confluence_current_focus
  drop constraint if exists eve_confluence_current_focus_id_check,
  drop constraint if exists eve_confluence_current_focus_direction_check;

alter table public.eve_confluence_scan_runs
  add constraint eve_confluence_scan_runs_selected_direction_check
  check (selected_direction in ('buy','sell') or selected_direction is null);

alter table public.eve_confluence_asset_scores
  add constraint eve_confluence_asset_scores_asset_class_check
  check (asset_class in ('forex','metal','crypto') or asset_class is null),
  add constraint eve_confluence_asset_scores_direction_check
  check (direction in ('buy','sell','none') or direction is null);

alter table public.eve_confluence_trade_ideas
  add constraint eve_confluence_trade_ideas_direction_check
  check (direction in ('buy','sell')),
  add constraint eve_confluence_trade_ideas_status_check
  check (status in (
    'forming','armed','active','won','lost','closed','no_trigger',
    'invalidated_before_entry','expired','cancelled'
  )),
  add constraint eve_confluence_trade_ideas_outcome_check
  check (outcome in (
    'win','loss','manual_close','time_exit','break_even','no_trigger','invalidated_before_entry','expired','cancelled'
  ) or outcome is null);

alter table public.eve_confluence_current_focus
  add constraint eve_confluence_current_focus_id_check check (id = 'current'),
  add constraint eve_confluence_current_focus_direction_check
  check (direction in ('buy','sell') or direction is null);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- v14 operating settings
-- ------------------------------------------------------------

insert into public.eve_confluence_settings (key, value, updated_at, changed_by)
values
  ('scanner_enabled', 'true'::jsonb, now(), 'v14_3_full_setup'),
  ('minimum_rr', '2'::jsonb, now(), 'v14_3_full_setup'),
  ('maximum_planned_rr', '25'::jsonb, now(), 'v14_3_full_setup'),
  ('minimum_idea_score', '58'::jsonb, now(), 'v14_3_full_setup'),
  ('minimum_directional_bias', '48'::jsonb, now(), 'v14_3_full_setup'),
  ('source_max_age_minutes', '20'::jsonb, now(), 'v14_3_full_setup'),
  ('idea_expiry_minutes', '90'::jsonb, now(), 'v14_3_full_setup'),
  ('armed_confirmation_minutes', '30'::jsonb, now(), 'v14_3_full_setup'),
  ('active_trade_expiry_minutes', '360'::jsonb, now(), 'v14_3_full_setup'),
  ('same_symbol_direction_cooldown_minutes', '20'::jsonb, now(), 'v14_3_full_setup'),
  ('trigger_buffer_multiplier', '0.25'::jsonb, now(), 'v14_3_full_setup'),
  ('confirmation_ticks', '2'::jsonb, now(), 'v14_3_full_setup'),
  ('confirmation_min_seconds', '2'::jsonb, now(), 'v14_3_full_setup'),
  ('max_entry_slippage_risk_fraction', '0.15'::jsonb, now(), 'v14_3_full_setup')
on conflict (key) do update
set value = excluded.value,
    updated_at = now(),
    changed_by = 'v14_3_full_setup';

delete from public.eve_confluence_settings
where key in (
  'minimum_confirmed_rr',
  'focus_lock_minutes',
  'candidate_memory_minutes',
  'forming_touch_minutes',
  'confirmation_hold_seconds'
);

insert into public.eve_confluence_current_focus (
  id, symbol, direction, status, idea_id, confluence_score, reason,
  locked_at, lock_until, last_scan_id, last_scan_at,
  last_live_price, last_live_at, railway_symbol, railway_status, raw, updated_at
)
values (
  'current', null, null, 'waiting', null, 0,
  'EVE Confluence v14 installed. Waiting for the next five-minute scan.',
  null, null, null, null, null, null, null, 'no_focus', '{}'::jsonb, now()
)
on conflict (id) do update
set symbol = null,
    direction = null,
    status = 'waiting',
    idea_id = null,
    confluence_score = 0,
    reason = 'EVE Confluence v14 installed. Waiting for the next five-minute scan.',
    locked_at = null,
    lock_until = null,
    last_scan_id = null,
    last_scan_at = null,
    last_live_price = null,
    last_live_at = null,
    railway_symbol = null,
    railway_status = 'no_focus',
    raw = '{}'::jsonb,
    updated_at = now();

-- ------------------------------------------------------------
-- Security
-- ------------------------------------------------------------

alter table public.eve_confluence_settings enable row level security;
alter table public.eve_confluence_scan_runs enable row level security;
alter table public.eve_confluence_asset_scores enable row level security;
alter table public.eve_confluence_trade_ideas enable row level security;
alter table public.eve_confluence_current_focus enable row level security;
alter table public.eve_confluence_live_prices enable row level security;
alter table public.eve_confluence_events enable row level security;

commit;

-- Netlify and Railway use SUPABASE_SERVICE_ROLE_KEY and bypass RLS.
-- Never expose the service role key in browser code or commit it to GitHub.
