const MIN_SCORE_FOR_FOCUS = 50;
const MIN_BIAS_QUALITY_FOR_TRADE = 70;
const SOURCE_FRESHNESS_LAG_MINUTES = 4;
const SOURCE_FRESHNESS_LOOKBACK_MINUTES = 7;

const SOURCE_SCANNERS = [
  { key: 'bias', label: 'Bias', runTable: 'eve_scan_runs', rowTable: 'eve_market_scores' },
  { key: 'structure', label: 'Structure', runTable: 'eve_structure_scan_runs', rowTable: 'eve_structure_market_results' },
  { key: 'zones', label: 'Zones', runTable: 'eve_zones_scan_runs', rowTable: 'eve_zones_market_zones' },
  { key: 'liquidity', label: 'Liquidity', runTable: 'eve_liquidity_scan_runs', rowTable: 'eve_liquidity_market_results' }
];

const MARKETS = [
  { symbol: 'XAU/USD', display_name: 'Gold', asset_class: 'metal' },
  { symbol: 'EUR/USD', display_name: 'Euro / Dollar', asset_class: 'forex' },
  { symbol: 'GBP/USD', display_name: 'Pound / Dollar', asset_class: 'forex' },
  { symbol: 'USD/JPY', display_name: 'Dollar / Yen', asset_class: 'forex' },
  { symbol: 'AUD/USD', display_name: 'Aussie / Dollar', asset_class: 'forex' },
  { symbol: 'USD/CAD', display_name: 'Dollar / Cad', asset_class: 'forex' },
  { symbol: 'EUR/JPY', display_name: 'Euro / Yen', asset_class: 'forex' },
  { symbol: 'GBP/JPY', display_name: 'Pound / Yen', asset_class: 'forex' },
  { symbol: 'BTC/USD', display_name: 'Bitcoin', asset_class: 'crypto' }
];

function nowIso() { return new Date().toISOString(); }
function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60_000).toISOString(); }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function lower(value) { return String(value || '').toLowerCase(); }
function displayedPercent(value) { return Math.round(clamp(Number(value) || 0, 0, 100)); }
function withProgress(obj, progress) { return { ...obj, confluence_score: Math.max(Number(obj.confluence_score || 0), progress) }; }
function isBullish(value) { const v = lower(value); return v.includes('bull') || v === 'buy'; }
function isBearish(value) { const v = lower(value); return v.includes('bear') || v === 'sell'; }
function isClosedStatus(status) { return ['won', 'lost', 'no_trigger', 'invalidated_before_entry', 'expired', 'cancelled'].includes(status); }
function isOpenIdeaStatus(status) { return ['watch_only', 'forming', 'armed', 'active'].includes(status); }

function marketClosed(symbol, assetClass) {
  if (assetClass === 'crypto') return false;
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return true;
  if (day === 0 && hour < 21) return true;
  if (day === 5 && hour >= 22) return true;
  return false;
}

function priceDecimals(symbol) {
  if (symbol.includes('JPY')) return 3;
  if (symbol === 'XAU/USD') return 2;
  if (symbol === 'BTC/USD') return 0;
  return 5;
}

function priceBuffer(symbol, price) {
  const p = Math.abs(Number(price) || 1);
  if (symbol === 'XAU/USD') return 1.25;
  if (symbol.includes('JPY')) return 0.035;
  if (symbol === 'BTC/USD') return Math.max(25, p * 0.00055);
  return 0.00035;
}

function zoneDistanceAllowance(symbol, price, zoneLow, zoneHigh) {
  const h = Math.abs(Number(zoneHigh) - Number(zoneLow));
  const p = Math.abs(Number(price) || 1);
  const pct = symbol === 'BTC/USD' ? p * 0.002 : p * 0.0008;
  return Math.max(h * 1.5, pct, priceBuffer(symbol, p) * 2);
}

function classifyBuyZone(price, low, high, symbol) {
  if (!price || !low || !high) return 'no_zone';
  const allowance = zoneDistanceAllowance(symbol, price, low, high);
  if (price < low) return 'below_demand_invalid';
  if (price >= low && price <= high) return 'inside_demand';
  if (price > high && price <= high + allowance) return 'near_demand';
  return 'waiting_for_demand';
}

function classifySellZone(price, low, high, symbol) {
  if (!price || !low || !high) return 'no_zone';
  const allowance = zoneDistanceAllowance(symbol, price, low, high);
  if (price > high) return 'above_supply_invalid';
  if (price >= low && price <= high) return 'inside_supply';
  if (price < low && price >= low - allowance) return 'near_supply';
  return 'waiting_for_supply';
}

function computeBuyStop(symbol, price, demandLow, protectedLevel) {
  if (!price || !demandLow) return null;
  const buffer = priceBuffer(symbol, price);
  const protectedLow = protectedLevel && Number(protectedLevel) < Number(price) ? Number(protectedLevel) : null;
  const base = protectedLow ? Math.min(Number(demandLow), protectedLow) : Number(demandLow);
  return base - buffer;
}

function computeSellStop(symbol, price, supplyHigh, protectedLevel) {
  if (!price || !supplyHigh) return null;
  const buffer = priceBuffer(symbol, price);
  const protectedHigh = protectedLevel && Number(protectedLevel) > Number(price) ? Number(protectedLevel) : null;
  const base = protectedHigh ? Math.max(Number(supplyHigh), protectedHigh) : Number(supplyHigh);
  return base + buffer;
}

function rrFor(direction, entry, stop, target) {
  const e = Number(entry), s = Number(stop), t = Number(target);
  if (![e, s, t].every(Number.isFinite)) return { risk: null, reward: null, rr: 0 };
  let risk, reward;
  if (direction === 'buy') {
    risk = e - s;
    reward = t - e;
  } else {
    risk = s - e;
    reward = e - t;
  }
  if (risk <= 0 || reward <= 0) return { risk, reward, rr: 0 };
  return { risk, reward, rr: reward / risk };
}

async function getSetting(supabase, key, fallback) {
  const { data, error } = await supabase.from('eve_confluence_settings').select('value').eq('key', key).maybeSingle();
  if (error || !data) return fallback;
  const v = data.value;
  if (typeof fallback === 'number') return Number(v) || fallback;
  if (typeof fallback === 'boolean') return Boolean(v);
  return v ?? fallback;
}

async function latestRun(supabase, table) {
  const { data, error } = await supabase.from(table).select('*').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return null;
  return data || null;
}

async function rowsForScan(supabase, table, scanId) {
  if (!scanId) return [];
  const { data, error } = await supabase.from(table).select('*').eq('scan_id', scanId).order('rank', { ascending: true, nullsFirst: false });
  if (error) return [];
  return data || [];
}

async function latestLivePrices(supabase) {
  const { data } = await supabase.from('eve_confluence_live_prices').select('*');
  return Object.fromEntries((data || []).map((r) => [r.symbol, r]));
}

function mapBySymbol(rows) { return Object.fromEntries((rows || []).map((r) => [r.symbol, r])); }

function floorToFiveMinutes(date) {
  const d = new Date(date.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5);
  return d;
}

function sourceDecisionCycle(now = new Date()) {
  // Reviewed v10 rule: use the latest real completed scanner run inside a
  // rolling freshness window. This is deliberately more stable than forcing
  // every source scanner to land inside the exact same 5-minute bucket,
  // because Netlify scheduled functions drift by seconds/minutes.
  const end = new Date(now.getTime() + 60_000);
  const start = new Date(now.getTime() - SOURCE_FRESHNESS_LOOKBACK_MINUTES * 60_000);
  return { start, end };
}

function isRealSourceRun(run) {
  if (!run || !run.completed_at) return false;
  const mode = lower(run.mode);
  if (!mode) return true;
  if (mode.includes('skipped')) return false;
  if (mode === 'starting' || mode === 'scanning') return false;
  if (mode.includes('failed') || mode.includes('error')) return false;
  return true;
}

async function latestRealRunForCycle(supabase, table, cycle) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .gte('started_at', cycle.start.toISOString())
    .lt('started_at', cycle.end.toISOString())
    .order('started_at', { ascending: false })
    .limit(12);
  if (error) return null;
  return (data || []).find(isRealSourceRun) || null;
}

async function getSourceFreshness(supabase, now = new Date()) {
  const cycle = sourceDecisionCycle(now);
  const pairs = await Promise.all(SOURCE_SCANNERS.map(async (scanner) => {
    const run = await latestRealRunForCycle(supabase, scanner.runTable, cycle);
    const fresh = Boolean(run);
    return [scanner.key, {
      key: scanner.key,
      label: scanner.label,
      fresh,
      status: fresh ? 'fresh' : 'waiting',
      run_id: run?.id || null,
      started_at: run?.started_at || null,
      completed_at: run?.completed_at || null,
      mode: run?.mode || null,
      run
    }];
  }));
  const sources = Object.fromEntries(pairs);
  const allFresh = SOURCE_SCANNERS.every((s) => sources[s.key]?.fresh);
  const waiting = SOURCE_SCANNERS.filter((s) => !sources[s.key]?.fresh).map((s) => s.label);
  return {
    allFresh,
    waiting,
    cycle_start: cycle.start.toISOString(),
    cycle_end: cycle.end.toISOString(),
    sources
  };
}

function sourceFreshnessReason(freshness) {
  if (freshness?.allFresh) return 'All four backbone scanners are fresh. Confluence decision allowed.';
  const waiting = freshness?.waiting?.length ? freshness.waiting.join(', ') : 'source scanners';
  return `Waiting for fresh ${waiting} scan${freshness?.waiting?.length === 1 ? '' : 's'}. No new trade decision yet.`;
}

function pickPrice(symbol, live, bias, zones, structure, liquidity) {
  const prices = [live?.price, liquidity?.latest_price, zones?.latest_price, structure?.latest_price, bias?.latest_price].map(num).filter((v) => v && v > 0);
  return prices[0] || null;
}

function buildCandidate(market, data, minRr) {
  const { bias, zones, structure, liquidity, live } = data;
  const symbol = market.symbol;
  const price = pickPrice(symbol, live, bias, zones, structure, liquidity);
  const isOpen = !(marketClosed(symbol, market.asset_class)) && (bias?.is_open !== false) && (zones?.is_open !== false) && (structure?.is_open !== false) && (liquidity?.is_open !== false);

  const base = {
    symbol,
    display_name: market.display_name,
    asset_class: market.asset_class,
    is_open: isOpen,
    latest_price: price,
    bias: bias?.bias || null,
    bias_score: num(bias?.score ?? bias?.bias_score) || 0,
    structure_bias: structure?.structure_bias || null,
    structure_score: num(structure?.score) || 0,
    demand_low: num(zones?.demand_low ?? liquidity?.demand_low),
    demand_high: num(zones?.demand_high ?? liquidity?.demand_high),
    supply_low: num(zones?.supply_low ?? liquidity?.supply_low),
    supply_high: num(zones?.supply_high ?? liquidity?.supply_high),
    direction: 'none',
    status: 'no_trade',
    confluence_score: 0,
    reason: 'Waiting for scanner data.',
    raw: { bias, zones, structure, liquidity, live }
  };

  if (!isOpen) return { ...base, reason: 'Market closed or stale. No trade.' };
  if (!price) return { ...base, reason: 'No live/latest price. No trade.' };
  if (!bias || !structure || !zones || !liquidity) return { ...base, reason: 'Waiting for Bias, Structure, Zones and Liquidity to all report.' };

  const biasScore = num(bias?.score ?? bias?.bias_score) || 0;
  const shownBiasScore = displayedPercent(biasScore);
  if (shownBiasScore < MIN_BIAS_QUALITY_FOR_TRADE || lower(bias.bias).includes('watch')) {
    return { ...base, reason: `No trade — bias is only ${shownBiasScore}%${lower(bias.bias).includes('watch') ? ' / Watch Only' : ''}. Minimum clean bias is ${MIN_BIAS_QUALITY_FOR_TRADE}%. Bias is the gatekeeper.` };
  }

  const biasPassed = withProgress(base, 25);
  const bullAligned = isBullish(bias.bias) && isBullish(structure.structure_bias);
  const bearAligned = isBearish(bias.bias) && isBearish(structure.structure_bias);
  if (!bullAligned && !bearAligned) {
    return { ...biasPassed, reason: `Bias passed at ${shownBiasScore}%, but structure is not cleanly aligned. Bias: ${bias.bias || 'n/a'}, Structure: ${structure.structure_bias || 'n/a'}.` };
  }
  const alignedBase = withProgress(base, 45);

  const options = [];
  if (bullAligned) {
    const plannedEntry = num(base.demand_high);
    const stop = computeBuyStop(symbol, plannedEntry || price, base.demand_low, num(structure.protected_level));
    const target = num(liquidity.demand_target_price);
    const quality = num(zones.demand_quality) || 0;
    const liqQuality = num(liquidity.demand_target_quality) || 0;
    const zoneState = classifyBuyZone(price, base.demand_low, base.demand_high, symbol);
    const rr = rrFor('buy', plannedEntry || price, stop, target);
    options.push(makeScoredOption({ base: alignedBase, direction: 'buy', zoneState, plannedEntry, stop, target, zoneQuality: quality, liquidityQuality: liqQuality, rr, targetSource: liquidity.demand_target_type || 'demand_target_liquidity', minRr }));
  }
  if (bearAligned) {
    const plannedEntry = num(base.supply_low);
    const stop = computeSellStop(symbol, plannedEntry || price, base.supply_high, num(structure.protected_level));
    const target = num(liquidity.supply_target_price);
    const quality = num(zones.supply_quality) || 0;
    const liqQuality = num(liquidity.supply_target_quality) || 0;
    const zoneState = classifySellZone(price, base.supply_low, base.supply_high, symbol);
    const rr = rrFor('sell', plannedEntry || price, stop, target);
    options.push(makeScoredOption({ base: alignedBase, direction: 'sell', zoneState, plannedEntry, stop, target, zoneQuality: quality, liquidityQuality: liqQuality, rr, targetSource: liquidity.supply_target_type || 'supply_target_liquidity', minRr }));
  }

  return options.sort((a, b) => b.confluence_score - a.confluence_score)[0] || base;
}

function makeScoredOption({ base, direction, zoneState, plannedEntry, stop, target, zoneQuality, liquidityQuality, rr, targetSource, minRr }) {
  const badZone = zoneState.includes('invalid') || zoneState === 'no_zone';
  const hasCleanStop = stop && Number.isFinite(Number(stop));
  const hasTarget = target && Number.isFinite(Number(target));
  const slReason = direction === 'buy' ? 'Below demand / protected low. SL calculated before idea.' : 'Above supply / protected high. SL calculated before idea.';

  if (!hasCleanStop) {
    return withProgress({ ...base, direction, zone_state: zoneState, stop_loss: null, target_price: target, zone_quality: zoneQuality, liquidity_quality: liquidityQuality, reason: 'No trade — stop loss is not clean. No SL = no trade idea.' }, 45);
  }
  if (!hasTarget) {
    return withProgress({ ...base, direction, zone_state: zoneState, stop_loss: stop, target_price: null, zone_quality: zoneQuality, liquidity_quality: liquidityQuality, sl_reason: slReason, reason: 'No trade — no meaningful liquidity target.' }, 55);
  }
  if (badZone) {
    return withProgress({ ...base, direction, zone_state: zoneState, stop_loss: stop, target_price: target, zone_quality: zoneQuality, liquidity_quality: liquidityQuality, rr: rr.rr, risk_amount: rr.risk, reward_amount: rr.reward, sl_reason: slReason, reason: `No trade — price has invalidated the ${direction === 'buy' ? 'demand' : 'supply'} area.` }, 50);
  }
  if (!rr.rr || rr.rr < minRr) {
    return withProgress({ ...base, direction, zone_state: zoneState, stop_loss: stop, target_price: target, zone_quality: zoneQuality, liquidity_quality: liquidityQuality, rr: rr.rr || 0, risk_amount: rr.risk, reward_amount: rr.reward, sl_reason: slReason, target_source: targetSource, reason: `No trade — SL exists, but R:R is only ${Number(rr.rr || 0).toFixed(2)}. Minimum is 1:${minRr}.` }, 70);
  }

  const zoneScore = zoneState.includes('inside') ? 100 : zoneState.includes('near') ? 82 : 52;
  const biasScore = clamp(Number(base.bias_score || 0), 0, 100);
  const structScore = clamp(Number(base.structure_score || 0), 0, 100);
  const rrScore = clamp((rr.rr / 4) * 100, 50, 100);
  let score = (biasScore * 0.26) + (structScore * 0.26) + (zoneQuality * 0.16) + (liquidityQuality * 0.16) + (zoneScore * 0.10) + (rrScore * 0.06);
  score = clamp(score, 0, 100);

  const status = zoneState.includes('inside') || zoneState.includes('near') ? 'forming' : 'candidate';
  const area = direction === 'buy' ? 'demand' : 'supply';
  const reason = status === 'forming'
    ? `${direction.toUpperCase()} idea forming — SL is clean first, projected R:R from the ${area} confirmation area is ${rr.rr.toFixed(2)}, price is ${zoneState.replaceAll('_', ' ')}. Waiting for live confirmation.`
    : `${direction.toUpperCase()} candidate — bias and structure agree, ${area} zone and liquidity target are mapped, projected R:R from the ${area} confirmation area is ${rr.rr.toFixed(2)}. Waiting for price to approach the zone.`;

  return {
    ...base,
    direction,
    status,
    confluence_score: score,
    reason,
    zone_state: zoneState,
    zone_quality: zoneQuality,
    liquidity_quality: liquidityQuality,
    target_price: target,
    stop_loss: stop,
    risk_amount: rr.risk,
    reward_amount: rr.reward,
    rr: rr.rr,
    planned_entry: plannedEntry,
    target_source: targetSource,
    sl_reason: slReason
  };
}

async function fetchInputs(supabase, now = new Date()) {
  const [freshness, livePrices] = await Promise.all([
    getSourceFreshness(supabase, now),
    latestLivePrices(supabase)
  ]);
  const biasRun = freshness.sources.bias?.run || null;
  const structureRun = freshness.sources.structure?.run || null;
  const zonesRun = freshness.sources.zones?.run || null;
  const liquidityRun = freshness.sources.liquidity?.run || null;
  const [biasRows, zonesRows, structureRows, liquidityRows] = await Promise.all([
    rowsForScan(supabase, 'eve_market_scores', biasRun?.id),
    rowsForScan(supabase, 'eve_zones_market_zones', zonesRun?.id),
    rowsForScan(supabase, 'eve_structure_market_results', structureRun?.id),
    rowsForScan(supabase, 'eve_liquidity_market_results', liquidityRun?.id)
  ]);
  return {
    source_freshness: freshness,
    runs: { biasRun, zonesRun, structureRun, liquidityRun },
    maps: {
      bias: mapBySymbol(biasRows),
      zones: mapBySymbol(zonesRows),
      structure: mapBySymbol(structureRows),
      liquidity: mapBySymbol(liquidityRows),
      live: livePrices
    }
  };
}

async function getCurrentFocus(supabase) {
  const { data } = await supabase.from('eve_confluence_current_focus').select('*').eq('id', 'current').maybeSingle();
  return data || null;
}

async function getIdea(supabase, ideaId) {
  if (!ideaId) return null;
  const { data } = await supabase.from('eve_confluence_trade_ideas').select('*').eq('id', ideaId).maybeSingle();
  return data || null;
}

function shouldKeepCurrentFocus(current, currentIdea, candidateMap, bestCandidate, now) {
  if (!current || !current.symbol) return false;

  // Active/armed/forming ideas are managed as a state machine.
  // A scan must not jump to another asset while an open idea is waiting
  // for touch, confirmation, TP, or SL.
  if (currentIdea && currentIdea.status === 'active') return true;
  if (currentIdea && ['forming', 'armed'].includes(currentIdea.status)) {
    const expiry = currentIdea.expires_at ? new Date(currentIdea.expires_at).getTime() : 0;
    return !expiry || expiry > now.getTime();
  }
  if (currentIdea && isClosedStatus(currentIdea.status)) return false;

  const currentCandidate = candidateMap[current.symbol];
  if (!currentCandidate || currentCandidate.status === 'no_trade') return false;
  const lockUntil = current.lock_until ? new Date(current.lock_until).getTime() : 0;
  const locked = lockUntil > now.getTime();

  // No early override. If focus is locked, it stays locked until the
  // timer expires, the idea invalidates/expires, or the user unlocks it.
  return locked;
}

async function createOrUpdateIdea(supabase, selected, currentFocus, currentIdea, now, formingTouchMinutes, armedConfirmationMinutes) {
  if (!selected || !['forming'].includes(selected.status)) return null;

  const alreadyInsideZone = String(selected.zone_state || '').includes('inside');
  const status = alreadyInsideZone ? 'armed' : 'forming';
  const expiryMinutes = alreadyInsideZone ? armedConfirmationMinutes : formingTouchMinutes;
  const expiresAt = addMinutes(now, expiryMinutes);

  const payload = {
    symbol: selected.symbol,
    direction: selected.direction,
    status,
    execution_type: 'market_after_confirmation',
    lock_until: expiresAt,
    formed_at: currentIdea?.formed_at || now.toISOString(),
    expires_at: expiresAt,
    forming_price: selected.latest_price,
    stop_loss: selected.stop_loss,
    take_profit: selected.target_price,
    risk_amount: selected.risk_amount,
    reward_amount: selected.reward_amount,
    rr: selected.rr,
    demand_low: selected.demand_low,
    demand_high: selected.demand_high,
    supply_low: selected.supply_low,
    supply_high: selected.supply_high,
    target_source: selected.target_source,
    sl_reason: selected.sl_reason,
    touched_zone: alreadyInsideZone,
    touched_zone_at: alreadyInsideZone ? now.toISOString() : null,
    armed_at: alreadyInsideZone ? now.toISOString() : null,
    confirm_started_at: null,
    reason: status === 'armed'
      ? `${selected.direction.toUpperCase()} idea armed — price is already inside the correct zone. Waiting for live confirmation.`
      : selected.reason,
    latest_note: status === 'armed'
      ? 'Zone already touched at formation. Waiting for live reclaim/rejection confirmation. No entry yet.'
      : 'SL was calculated before this trade idea was allowed. Waiting for price to touch the correct zone.',
    raw: selected.raw || {},
    updated_at: now.toISOString()
  };

  const canReuse = currentIdea && !isClosedStatus(currentIdea.status) && currentIdea.symbol === selected.symbol && currentIdea.direction === selected.direction;
  if (canReuse) {
    const { data, error } = await supabase.from('eve_confluence_trade_ideas').update(payload).eq('id', currentIdea.id).select('*').single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase.from('eve_confluence_trade_ideas').insert({ ...payload, focus_started_at: now.toISOString() }).select('*').single();
  if (error) throw error;
  await supabase.from('eve_confluence_events').insert({
    event_type: status === 'armed' ? 'idea_armed' : 'idea_formed',
    symbol: selected.symbol,
    idea_id: data.id,
    message: status === 'armed'
      ? `${selected.direction.toUpperCase()} idea armed immediately. Zone touched. Waiting confirmation. SL: ${selected.stop_loss}. TP: ${selected.target_price}. RR: ${selected.rr.toFixed(2)}.`
      : `${selected.direction.toUpperCase()} idea formed. SL first: ${selected.stop_loss}. TP: ${selected.target_price}. RR: ${selected.rr.toFixed(2)}.`
  });
  return data;
}

async function expireOldIdeas(supabase, now) {
  const { data: ideas } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('*')
    .in('status', ['forming', 'armed', 'watch_only'])
    .lt('expires_at', now.toISOString());
  for (const idea of ideas || []) {
    const expiredBeforeTouch = idea.status === 'forming' && !idea.touched_zone;
    const note = expiredBeforeTouch
      ? 'Idea expired before price touched the correct zone.'
      : 'Idea expired after zone touch but before live confirmation.';
    await supabase.from('eve_confluence_trade_ideas').update({
      status: 'expired', outcome: 'expired', completed_at: now.toISOString(), updated_at: now.toISOString(), latest_note: note
    }).eq('id', idea.id);
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: null,
      direction: null,
      status: 'no_trade',
      idea_id: null,
      reason: note,
      railway_symbol: null,
      railway_status: 'no_focus',
      last_live_price: null,
      last_live_at: null,
      updated_at: now.toISOString()
    });
    await supabase.from('eve_confluence_events').insert({ event_type: 'idea_expired', symbol: idea.symbol, idea_id: idea.id, message: note });
  }
}

async function scoreActiveIdeas(supabase, now) {
  const { data: ideas } = await supabase.from('eve_confluence_trade_ideas').select('*').eq('status', 'active').limit(25);
  for (const idea of ideas || []) {
    const { data: live } = await supabase.from('eve_confluence_live_prices').select('*').eq('symbol', idea.symbol).maybeSingle();
    const price = num(live?.price || idea.last_live_price);
    if (!price) continue;
    const won = idea.direction === 'buy' ? price >= Number(idea.take_profit) : price <= Number(idea.take_profit);
    const lost = idea.direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);
    if (!won && !lost) continue;
    const status = won ? 'won' : 'lost';
    const resultR = won ? Number(idea.rr || 0) : -1;
    await supabase.from('eve_confluence_trade_ideas').update({
      status,
      outcome: won ? 'win' : 'loss',
      result_r: resultR,
      completed_at: now.toISOString(),
      last_live_price: price,
      last_live_at: live?.received_at || now.toISOString(),
      latest_note: won ? 'Target liquidity reached before SL.' : 'Stop loss reached before target.',
      updated_at: now.toISOString()
    }).eq('id', idea.id);
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: null,
      direction: null,
      status,
      idea_id: null,
      reason: won ? 'Trade idea won. TP reached first.' : 'Trade idea lost. SL reached first.',
      railway_symbol: null,
      railway_status: 'no_focus',
      last_live_price: null,
      last_live_at: null,
      updated_at: now.toISOString()
    });
    await supabase.from('eve_confluence_events').insert({ event_type: won ? 'idea_won' : 'idea_lost', symbol: idea.symbol, idea_id: idea.id, message: won ? 'Trade idea won. TP reached first.' : 'Trade idea lost. SL reached first.', raw: { price } });
  }
}


async function recentCooldownBlocks(supabase, now, cooldownMinutes) {
  if (!cooldownMinutes || cooldownMinutes <= 0) return new Set();
  const since = addMinutes(now, -cooldownMinutes);
  const { data } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('symbol,direction,status,completed_at,updated_at')
    .in('status', ['expired', 'no_trigger', 'invalidated_before_entry'])
    .gte('completed_at', since);
  return new Set((data || []).map((i) => `${i.symbol}|${i.direction}`));
}

async function runConfluenceScan(supabase, source = 'scheduled') {
  const now = new Date();
  const scannerEnabled = await getSetting(supabase, 'scanner_enabled', true);
  const minRr = await getSetting(supabase, 'minimum_rr', 2);
  const focusLockMinutes = await getSetting(supabase, 'focus_lock_minutes', 15);
  const formingTouchMinutes = await getSetting(supabase, 'forming_touch_minutes', 15);
  const armedConfirmationMinutes = await getSetting(supabase, 'armed_confirmation_minutes', 30);
  const cooldownMinutes = await getSetting(supabase, 'same_symbol_direction_cooldown_minutes', 10);

  const { data: run, error: runError } = await supabase.from('eve_confluence_scan_runs').insert({
    started_at: now.toISOString(),
    mode: scannerEnabled ? 'scanning' : 'confluence_off',
    scanner_enabled: scannerEnabled,
    source,
    assets_checked: 0,
    assets_scored: 0
  }).select('*').single();
  if (runError) throw runError;

  if (!scannerEnabled) {
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: null,
      direction: null,
      status: 'confluence_off',
      idea_id: null,
      confluence_score: 0,
      reason: 'Confluence scanner is turned off.',
      locked_at: null,
      lock_until: null,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: null,
      railway_status: 'no_focus',
      last_live_price: null,
      last_live_at: null,
      raw: {},
      updated_at: now.toISOString()
    });
    await supabase.from('eve_confluence_scan_runs').update({ completed_at: nowIso(), mode: 'confluence_off', notes: 'Scanner off.' }).eq('id', run.id);
    return { run: { ...run, completed_at: nowIso(), mode: 'confluence_off' }, selected: null, assets: [] };
  }

  await Promise.all([expireOldIdeas(supabase, now), scoreActiveIdeas(supabase, now)]);

  const inputs = await fetchInputs(supabase, now);
  const current = await getCurrentFocus(supabase);
  const currentIdea = await getIdea(supabase, current?.idea_id);

  const hasOpenIdea = currentIdea && ['forming', 'armed', 'active'].includes(currentIdea.status) && !isClosedStatus(currentIdea.status);
  if (!inputs.source_freshness.allFresh && !hasOpenIdea) {
    const reason = sourceFreshnessReason(inputs.source_freshness);
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: null,
      direction: null,
      status: 'waiting_fresh_sources',
      idea_id: null,
      confluence_score: 0,
      reason,
      locked_at: null,
      lock_until: null,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: null,
      railway_status: 'no_focus',
      last_live_price: null,
      last_live_at: null,
      raw: { source_freshness: inputs.source_freshness },
      updated_at: now.toISOString()
    });
    const completedAt = nowIso();
    await supabase.from('eve_confluence_scan_runs').update({
      completed_at: completedAt,
      mode: 'waiting_fresh_sources',
      assets_checked: 0,
      assets_scored: 0,
      selected_status: 'waiting_fresh_sources',
      notes: reason
    }).eq('id', run.id);
    return { run: { ...run, completed_at: completedAt, mode: 'waiting_fresh_sources' }, selected: null, idea: null, assets: [], inputs };
  }

  const assets = MARKETS.map((market) => buildCandidate(market, {
    bias: inputs.maps.bias[market.symbol],
    zones: inputs.maps.zones[market.symbol],
    structure: inputs.maps.structure[market.symbol],
    liquidity: inputs.maps.liquidity[market.symbol],
    live: inputs.maps.live[market.symbol]
  }, minRr));

  const scoreRows = assets.map((a, index) => ({
    scan_id: run.id,
    rank: index + 1,
    symbol: a.symbol,
    display_name: a.display_name,
    asset_class: a.asset_class,
    is_open: a.is_open,
    direction: a.direction,
    status: a.status,
    confluence_score: a.confluence_score || 0,
    reason: a.reason,
    bias: a.bias,
    bias_score: a.bias_score,
    structure_bias: a.structure_bias,
    structure_score: a.structure_score,
    zone_quality: a.zone_quality,
    liquidity_quality: a.liquidity_quality,
    latest_price: a.latest_price,
    demand_low: a.demand_low,
    demand_high: a.demand_high,
    supply_low: a.supply_low,
    supply_high: a.supply_high,
    target_price: a.target_price,
    stop_loss: a.stop_loss,
    risk_amount: a.risk_amount,
    reward_amount: a.reward_amount,
    rr: a.rr,
    zone_state: a.zone_state,
    target_source: a.target_source,
    sl_reason: a.sl_reason,
    raw: { ...(a.raw || {}), confluence: { planned_entry: a.planned_entry || null, source_freshness: inputs.source_freshness || null } }
  }));
  if (scoreRows.length) await supabase.from('eve_confluence_asset_scores').insert(scoreRows);

  const candidateMap = Object.fromEntries(assets.map((a) => [a.symbol, a]));
  const cooldownBlocks = await recentCooldownBlocks(supabase, now, cooldownMinutes);
  const ranked = assets
    .filter((a) => !cooldownBlocks.has(`${a.symbol}|${a.direction}`))
    .filter((a) => a.status === 'forming' && Number(a.confluence_score) >= MIN_SCORE_FOR_FOCUS)
    .sort((a, b) => Number(b.confluence_score || 0) - Number(a.confluence_score || 0));
  const mappedCandidates = assets
    .filter((a) => !cooldownBlocks.has(`${a.symbol}|${a.direction}`))
    .filter((a) => a.status === 'candidate' && Number(a.confluence_score) >= MIN_SCORE_FOR_FOCUS)
    .sort((a, b) => Number(b.confluence_score || 0) - Number(a.confluence_score || 0));
  let selected = ranked[0] || null;

  // A confirmed/active trade idea must be followed until TP, SL, manual cancel,
  // or explicit completion. New scans must not clear or replace an active trade.
  if (currentIdea && currentIdea.status === 'active') {
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: currentIdea.symbol,
      direction: currentIdea.direction,
      status: 'active',
      idea_id: currentIdea.id,
      confluence_score: current?.confluence_score || 0,
      reason: 'Active confirmed trade idea — following until TP or SL.',
      locked_at: current?.locked_at || currentIdea.activated_at || now.toISOString(),
      lock_until: current?.lock_until || addMinutes(now, focusLockMinutes),
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: currentIdea.symbol,
      railway_status: 'idea_active',
      last_live_price: currentIdea.last_live_price || current?.last_live_price || null,
      last_live_at: currentIdea.last_live_at || current?.last_live_at || null,
      raw: current?.raw || {},
      updated_at: now.toISOString()
    });
    const completedAt = nowIso();
    await supabase.from('eve_confluence_scan_runs').update({
      completed_at: completedAt,
      mode: 'active_trade_locked',
      assets_checked: assets.length,
      assets_scored: ranked.length + mappedCandidates.length,
      selected_symbol: currentIdea.symbol,
      selected_direction: currentIdea.direction,
      selected_status: 'active',
      notes: 'Existing active trade remains locked until TP or SL.'
    }).eq('id', run.id);
    return { run: { ...run, completed_at: completedAt }, selected: candidateMap[currentIdea.symbol] || null, idea: currentIdea, assets, inputs };
  }

  if (currentIdea && ['forming', 'armed'].includes(currentIdea.status) && !isClosedStatus(currentIdea.status)) {
    const selectedStatus = currentIdea.status;
    const note = selectedStatus === 'armed'
      ? 'Armed idea remains locked. Zone has touched; waiting for live confirmation.'
      : 'Forming idea remains locked. Waiting for price to touch the correct zone.';
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: currentIdea.symbol,
      direction: currentIdea.direction,
      status: selectedStatus,
      idea_id: currentIdea.id,
      confluence_score: current?.confluence_score || 0,
      reason: currentIdea.latest_note || currentIdea.reason || note,
      locked_at: current?.locked_at || currentIdea.focus_started_at || currentIdea.formed_at || now.toISOString(),
      lock_until: currentIdea.expires_at || currentIdea.lock_until || current?.lock_until,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: currentIdea.symbol,
      railway_status: selectedStatus === 'armed' ? 'idea_armed' : 'focus_selected',
      last_live_price: currentIdea.last_live_price || current?.last_live_price || null,
      last_live_at: currentIdea.last_live_at || current?.last_live_at || null,
      raw: current?.raw || candidateMap[currentIdea.symbol] || {},
      updated_at: now.toISOString()
    });
    const completedAt = nowIso();
    await supabase.from('eve_confluence_scan_runs').update({
      completed_at: completedAt,
      mode: selectedStatus === 'armed' ? 'armed_idea_locked' : 'forming_idea_locked',
      assets_checked: assets.length,
      assets_scored: ranked.length + mappedCandidates.length,
      selected_symbol: currentIdea.symbol,
      selected_direction: currentIdea.direction,
      selected_status: selectedStatus,
      notes: note
    }).eq('id', run.id);
    return { run: { ...run, completed_at: completedAt }, selected: candidateMap[currentIdea.symbol] || null, idea: currentIdea, assets, inputs };
  }

  if (shouldKeepCurrentFocus(current, currentIdea, candidateMap, selected, now)) {
    selected = candidateMap[current.symbol] || selected;
  }

  let idea = null;
  const newFocus = !current || !selected || current.symbol !== selected.symbol || current.direction !== selected.direction || !current.lock_until || new Date(current.lock_until).getTime() <= now.getTime();
  const lockUntil = selected ? (newFocus ? addMinutes(now, focusLockMinutes) : current.lock_until) : null;

  const noFocusReason = mappedCandidates.length
    ? `${mappedCandidates.length} candidate setup${mappedCandidates.length === 1 ? '' : 's'} mapped, but price is not close enough to the correct zone yet. No WebSocket focus until FORMING.`
    : 'No asset currently has clean enough confluence, SL, target and R:R.';

  if (selected) {
    idea = await createOrUpdateIdea(supabase, selected, current, currentIdea, now, formingTouchMinutes, armedConfirmationMinutes);
    const focusStatus = idea?.status || selected.status;
    const focusLockUntil = idea?.expires_at || idea?.lock_until || lockUntil;
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: selected.symbol,
      direction: selected.direction,
      status: focusStatus,
      idea_id: idea?.id || null,
      confluence_score: selected.confluence_score,
      reason: idea?.latest_note || idea?.reason || selected.reason,
      locked_at: newFocus ? now.toISOString() : (current?.locked_at || now.toISOString()),
      lock_until: focusLockUntil,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: selected.symbol,
      railway_status: focusStatus === 'armed' ? 'idea_armed' : 'focus_selected',
      last_live_price: newFocus ? null : current?.last_live_price,
      last_live_at: newFocus ? null : current?.last_live_at,
      raw: selected,
      updated_at: now.toISOString()
    });
  } else {
    await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: null,
      direction: null,
      status: mappedCandidates.length ? 'candidate_waiting' : 'no_trade',
      idea_id: null,
      confluence_score: mappedCandidates[0]?.confluence_score || 0,
      reason: noFocusReason,
      locked_at: null,
      lock_until: null,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: null,
      railway_status: 'no_focus',
      last_live_price: null,
      last_live_at: null,
      raw: {},
      updated_at: now.toISOString()
    });
  }

  const completedAt = nowIso();
  await supabase.from('eve_confluence_scan_runs').update({
    completed_at: completedAt,
    mode: selected ? 'focus_selected' : 'no_trade',
    assets_checked: assets.length,
    assets_scored: ranked.length + mappedCandidates.length,
    selected_symbol: selected?.symbol || null,
    selected_direction: selected?.direction || null,
    selected_status: selected?.status || (mappedCandidates.length ? 'candidate_waiting' : 'no_trade'),
    notes: selected ? selected.reason : (mappedCandidates.length ? noFocusReason : 'No qualifying focus.')
  }).eq('id', run.id);

  return { run: { ...run, completed_at: completedAt }, selected, idea, assets, inputs };
}

async function latestScoredConfluenceRun(supabase) {
  const { data, error } = await supabase
    .from('eve_confluence_scan_runs')
    .select('*')
    .gt('assets_checked', 0)
    .not('completed_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function getLatestState(supabase) {
  const [latestRunRow, latestScoredRunRow, focus, liveRows, recentScores, recentIdeas, settings, sourceFreshness] = await Promise.all([
    latestRun(supabase, 'eve_confluence_scan_runs'),
    latestScoredConfluenceRun(supabase),
    getCurrentFocus(supabase),
    supabase.from('eve_confluence_live_prices').select('*'),
    supabase.from('eve_confluence_asset_scores').select('*').order('created_at', { ascending: false }).limit(60),
    supabase.from('eve_confluence_trade_ideas').select('*').order('created_at', { ascending: false }).limit(80),
    supabase.from('eve_confluence_settings').select('*'),
    getSourceFreshness(supabase, new Date())
  ]);
  const scanId = latestRunRow?.assets_checked > 0 ? latestRunRow.id : latestScoredRunRow?.id;
  const assets = scanId ? await rowsForScan(supabase, 'eve_confluence_asset_scores', scanId) : [];
  const liveMap = Object.fromEntries((liveRows.data || []).map((r) => [r.symbol, r]));
  const currentIdea = await getIdea(supabase, focus?.idea_id);
  return {
    latest_run: latestRunRow,
    latest_decision_run: latestScoredRunRow,
    focus,
    current_idea: currentIdea,
    assets,
    live_prices: liveMap,
    recent_scores: recentScores.data || [],
    recent_ideas: recentIdeas.data || [],
    source_freshness: sourceFreshness,
    settings: Object.fromEntries((settings.data || []).map((s) => [s.key, s.value])),
    next_scan_at: nextMinuteSlot()
  };
}

function nextMinuteSlot() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  return d.toISOString();
}

function performanceStats(ideas) {
  const all = ideas || [];
  const formed = all.filter((i) => i.status !== 'watch_only');
  const armed = all.filter((i) => ['armed', 'active', 'won', 'lost'].includes(i.status) || i.touched_zone);
  const triggered = all.filter((i) => ['active', 'won', 'lost'].includes(i.status));
  const wins = all.filter((i) => i.status === 'won').length;
  const losses = all.filter((i) => i.status === 'lost').length;
  const expiredBeforeTouch = all.filter((i) => i.status === 'expired' && !i.touched_zone).length;
  const expiredAfterTouch = all.filter((i) => i.status === 'expired' && i.touched_zone).length;
  const invalidatedBeforeEntry = all.filter((i) => i.status === 'invalidated_before_entry').length;
  const rrFailed = all.filter((i) => i.status === 'no_trigger').length;
  const noTrigger = expiredBeforeTouch + expiredAfterTouch + invalidatedBeforeEntry + rrFailed;
  const closedCount = wins + losses;
  const winRate = closedCount ? (wins / closedCount) * 100 : 0;
  const triggerRate = formed.length ? (triggered.length / formed.length) * 100 : 0;
  const resultRs = all.map((i) => Number(i.result_r)).filter(Number.isFinite);
  const avgR = resultRs.length ? resultRs.reduce((a, b) => a + b, 0) / resultRs.length : 0;

  const byAsset = {};
  for (const i of all) {
    byAsset[i.symbol] ||= { symbol: i.symbol, total: 0, wins: 0, losses: 0, winRate: 0, avgR: 0, r: [] };
    byAsset[i.symbol].total++;
    if (i.status === 'won') byAsset[i.symbol].wins++;
    if (i.status === 'lost') byAsset[i.symbol].losses++;
    if (Number.isFinite(Number(i.result_r))) byAsset[i.symbol].r.push(Number(i.result_r));
  }
  for (const row of Object.values(byAsset)) {
    const denom = row.wins + row.losses;
    row.winRate = denom ? (row.wins / denom) * 100 : 0;
    row.avgR = row.r.length ? row.r.reduce((a, b) => a + b, 0) / row.r.length : 0;
    delete row.r;
  }
  const assetRows = Object.values(byAsset).sort((a, b) => b.winRate - a.winRate || b.total - a.total);

  return { totalIdeas: formed.length, armedIdeas: armed.length, triggeredIdeas: triggered.length, wins, losses, noTrigger, expiredBeforeTouch, expiredAfterTouch, invalidatedBeforeEntry, rrFailed, active: all.filter((i) => i.status === 'active').length, winRate, triggerRate, avgR, byAsset: assetRows };
}

module.exports = {
  MARKETS,
  runConfluenceScan,
  getLatestState,
  performanceStats,
  isOpenIdeaStatus,
  isClosedStatus,
  rrFor,
  priceDecimals
};
