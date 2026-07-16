const assert = require('node:assert/strict');
const { activeSessionAt, rrFor, buildMarketChoice } = require('../netlify/functions/lib/confluence-core');

const london = activeSessionAt(new Date('2026-07-16T07:15:00Z'));
assert.equal(london?.key, 'london');

const newYork = activeSessionAt(new Date('2026-07-16T12:30:00Z'));
assert.equal(newYork?.key, 'new_york');

assert.equal(activeSessionAt(new Date('2026-07-16T11:30:00Z')), null);
assert.equal(rrFor('buy', 100, 99, 102).rr, 2);
assert.equal(rrFor('sell', 100, 101, 98).rr, 2);

const market = { symbol: 'XAU/USD', display_name: 'Gold', asset_class: 'metal' };
const scanId = 'test';
const inputs = {
  sources: {
    bias: { isFresh: true, map: { 'XAU/USD': { scan_id: scanId, bias: 'Bullish', bias_score: 58, latest_price: 2352, is_open: true, is_stale: false } } },
    zones: { isFresh: true, map: { 'XAU/USD': { scan_id: scanId, demand_low: 2348, demand_high: 2350, demand_quality: 72, supply_low: 2364, supply_high: 2367, supply_quality: 68, latest_price: 2352, is_open: true, is_stale: false } } },
    structure: { isFresh: true, map: { 'XAU/USD': { scan_id: scanId, structure_bias: 'mixed', score: 55, latest_price: 2352, is_open: true, is_stale: false } } },
    liquidity: { isFresh: true, map: { 'XAU/USD': { scan_id: scanId, demand_target_price: 2364, demand_target_quality: 75, demand_target_type: 'buy-side liquidity', latest_price: 2352, is_open: true, is_stale: false } } }
  }
};
const settings = {
  minimumDirectionalBias: 48,
  minimumPlannedRr: 2
};
const choice = buildMarketChoice(market, inputs, london, settings, new Date('2026-07-16T07:20:00Z'));
assert.equal(choice.direction, 'buy');
assert.equal(choice.strategy_type, 'pullback');
assert.ok(['forming', 'armed'].includes(choice.status));
assert.ok(choice.rr >= 2);

console.log('EVE v13 smoke tests passed.');
