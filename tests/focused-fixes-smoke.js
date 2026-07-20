const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lockedDisplayAsset, isOpenIdeaStatus } = require('../netlify/functions/lib/confluence-core');

const rescanned = {
  symbol: 'GBP/JPY',
  direction: 'buy',
  status: 'forming',
  strategy_type: 'zone_reaction',
  confluence_score: 82,
  planned_entry: 218.627,
  stop_loss: 218.545,
  target_price: 218.795,
  rr: 2.05,
  latest_price: 218.701,
  raw: { trigger_needed: 'new conflicting trigger' }
};
const lockedIdea = {
  id: 'idea-locked',
  symbol: 'GBP/JPY',
  direction: 'buy',
  status: 'armed',
  strategy_type: 'broken_level_retest',
  idea_score: 85,
  planned_entry: 218.663,
  stop_loss: 218.600,
  take_profit: 218.830,
  rr: 2.65,
  last_live_price: 218.708,
  latest_note: 'Locked focus remains unchanged.',
  raw: { trade_engine: { trigger_needed: 'Retest 218.654 then reclaim 218.663' } }
};

const display = lockedDisplayAsset(lockedIdea, rescanned);
assert.equal(display.is_locked_focus, true);
assert.equal(display.strategy_type, 'broken_level_retest');
assert.equal(display.planned_entry, 218.663);
assert.equal(display.stop_loss, 218.600);
assert.equal(display.target_price, 218.830);
assert.equal(display.confluence_score, 85);
assert.equal(display.raw.trigger_needed, 'Retest 218.654 then reclaim 218.663');
assert.equal(isOpenIdeaStatus('active'), true);
assert.equal(isOpenIdeaStatus('lost'), false);

const railwaySource = fs.readFileSync(path.join(__dirname, '..', 'railway', 'server.js'), 'utf8');
assert.match(railwaySource, /status: 'cleared'/);
assert.match(railwaySource, /connectSymbol\(null\)/);
assert.match(railwaySource, /Could not record completed trade/);
assert.match(railwaySource, /Could not clear completed focus/);

console.log('Focused lifecycle and locked-number smoke tests passed.');
