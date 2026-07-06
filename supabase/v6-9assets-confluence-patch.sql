-- EVE Confluence v6 asset reduction patch
-- Keeps: EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/CAD, EUR/JPY, GBP/JPY, XAU/USD, BTC/USD
-- Removes from new confluence scoring: XAG/USD, ETH/USD, SOL/USD

-- Clean old live prices for removed assets so the dashboard cannot reuse stale prices.
delete from public.eve_confluence_live_prices
where symbol in ('XAG/USD', 'ETH/USD', 'SOL/USD');

-- Clear current focus if it is currently on a removed asset.
update public.eve_confluence_current_focus
set
  symbol = null,
  direction = null,
  status = 'no_trade',
  idea_id = null,
  confluence_score = 0,
  reason = 'Asset removed from EVE Confluence 9-asset list. Waiting for next valid setup.',
  railway_symbol = null,
  railway_status = 'no_focus',
  last_live_price = null,
  last_live_at = null,
  updated_at = now()
where id = 'current'
  and symbol in ('XAG/USD', 'ETH/USD', 'SOL/USD');

-- Optional clean-up: remove old score rows for removed assets.
-- This does not delete historical trade ideas/stats.
delete from public.eve_confluence_asset_scores
where symbol in ('XAG/USD', 'ETH/USD', 'SOL/USD');
