const assert = require('node:assert/strict');
const {
  activeSessionAt,
  rrFor,
  buildMarketChoice,
  performanceStats,
  priceBuffer
} = require('../netlify/functions/lib/confluence-core');

const london = activeSessionAt(new Date('2026-07-16T07:15:00Z'));
assert.equal(london?.key, 'london');

const newYork = activeSessionAt(new Date('2026-07-16T12:30:00Z'));
assert.equal(newYork?.key, 'new_york');

assert.equal(activeSessionAt(new Date('2026-07-16T11:30:00Z')), null);
assert.equal(rrFor('buy', 100, 99, 102).rr, 2);
assert.equal(rrFor('sell', 100, 101, 98).rr, 2);
assert.ok(priceBuffer('XAU/USD', 2350) > 0);

const market = { symbol: 'XAU/USD', display_name: 'Gold', asset_class: 'metal' };
const scanId = 'test';
const inputs = {
  sources: {
    bias: {
      isFresh: true,
      map: {
        'XAU/USD': {
          scan_id: scanId,
          bias: 'Bullish',
          bias_score: 58,
          latest_price: 2352,
          is_open: true,
          is_stale: false
        }
      }
    },
    zones: {
      isFresh: true,
      map: {
        'XAU/USD': {
          scan_id: scanId,
          demand_low: 2348,
          demand_high: 2350,
          demand_quality: 82,
          supply_low: 2364,
          supply_high: 2367,
          supply_quality: 68,
          latest_price: 2352,
          is_open: true,
          is_stale: false
        }
      }
    },
    structure: {
      isFresh: true,
      map: {
        'XAU/USD': {
          scan_id: scanId,
          structure_bias: 'bullish',
          h1_bias: 'bullish',
          m15_bias: 'bullish',
          m5_bias: 'mixed',
          score: 68,
          latest_price: 2352,
          is_open: true,
          is_stale: false
        }
      }
    },
    liquidity: {
      isFresh: true,
      map: {
        'XAU/USD': {
          scan_id: scanId,
          demand_sweep_type: 'sell-side sweep',
          demand_sweep_quality: 80,
          demand_target_price: 2364,
          demand_target_quality: 75,
          demand_target_type: 'buy-side liquidity',
          latest_price: 2352,
          is_open: true,
          is_stale: false
        }
      }
    }
  }
};

const settings = {
  minimumDirectionalBias: 48,
  minimumPlannedRr: 2,
  maximumPlannedRr: 25,
  triggerBufferMultiplier: 0.25
};

const choice = buildMarketChoice(market, inputs, london, settings, new Date('2026-07-16T07:20:00Z'));
assert.equal(choice.direction, 'buy');
assert.equal(choice.strategy_type, 'zone_reaction');
assert.ok(['forming', 'armed'].includes(choice.status));
assert.ok(choice.rr >= 2);
assert.ok(choice.planned_entry > 2350);
assert.match(choice.trigger_needed, /reclaim/i);

const bearishInputs = JSON.parse(JSON.stringify(inputs));
bearishInputs.sources.bias.map['XAU/USD'].bias = 'Bearish';
bearishInputs.sources.bias.map['XAU/USD'].bias_score = -73.55;
bearishInputs.sources.bias.map['XAU/USD'].score = 67.94;
bearishInputs.sources.bias.map['XAU/USD'].status = 'Good watch';
bearishInputs.sources.bias.map['XAU/USD'].latest_price = 2362;
bearishInputs.sources.zones.map['XAU/USD'].latest_price = 2362;
bearishInputs.sources.structure.map['XAU/USD'].structure_bias = 'bearish';
bearishInputs.sources.structure.map['XAU/USD'].h1_bias = 'bearish';
bearishInputs.sources.structure.map['XAU/USD'].m15_bias = 'bearish';
bearishInputs.sources.liquidity.map['XAU/USD'] = {
  ...bearishInputs.sources.liquidity.map['XAU/USD'],
  latest_price: 2362,
  supply_sweep_type: 'buy-side sweep',
  supply_sweep_quality: 78,
  supply_target_price: 2349,
  supply_target_quality: 76,
  supply_target_type: 'sell-side liquidity'
};
const sellChoice = buildMarketChoice(market, bearishInputs, london, settings, new Date('2026-07-16T07:20:00Z'));
assert.equal(sellChoice.direction, 'sell');
assert.equal(sellChoice.strategy_type, 'zone_reaction');
assert.ok(sellChoice.planned_entry < 2364);
assert.ok(sellChoice.rr >= 2);



const malformedTargetInputs = JSON.parse(JSON.stringify(bearishInputs));
malformedTargetInputs.sources.liquidity.map['XAU/USD'].supply_target_price = 0;
malformedTargetInputs.sources.zones.map['XAU/USD'].demand_high = null;
malformedTargetInputs.sources.zones.map['XAU/USD'].demand_low = null;
const malformedTargetChoice = buildMarketChoice(market, malformedTargetInputs, london, settings, new Date('2026-07-16T07:20:00Z'));
assert.equal(malformedTargetChoice.target_price, null);
assert.equal(malformedTargetChoice.rr, 0);
assert.equal(malformedTargetChoice.status, 'no_trade');

// Regression: bearish EVE bias scores are signed. A negative bias_score must not be clamped to zero,
// and statuses such as "Good watch" must remain eligible for Confluence.
assert.ok(sellChoice.confluence_score >= 58);

const performance = performanceStats([
  { strategy_type: 'zone_reaction', symbol: 'XAU/USD', session_name: 'London', status: 'won', activated_at: '2026-07-16T08:00:00Z', result_r: 2 },
  { strategy_type: 'zone_reaction', symbol: 'XAU/USD', session_name: 'London', status: 'closed', outcome: 'time_exit', activated_at: '2026-07-16T09:00:00Z', result_r: 0.4 },
  { strategy_type: 'zone_reaction', symbol: 'EUR/USD', session_name: 'London', status: 'no_trigger', result_r: null }
]);
assert.equal(performance.completedTrades, 2);
assert.equal(performance.totalR, 2.4);
assert.equal(performance.noTrigger, 1);

console.log('EVE Confluence v14.3 smoke tests passed.');
