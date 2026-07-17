const MIN_DIRECTIONAL_BIAS = 48;
const DEFAULT_MIN_IDEA_SCORE = 58;
const DEFAULT_SOURCE_MAX_AGE_MINUTES = 20;
const DEFAULT_IDEA_EXPIRY_MINUTES = 90;
const DEFAULT_ARMED_EXPIRY_MINUTES = 30;
const DEFAULT_ACTIVE_EXPIRY_MINUTES = 360;
const DEFAULT_COOLDOWN_MINUTES = 20;

const SOURCE_SCANNERS = [
  { key: 'bias', label: 'Bias', runTable: 'eve_scan_runs', rowTable: 'eve_market_scores' },
  { key: 'structure', label: 'Structure', runTable: 'eve_structure_scan_runs', rowTable: 'eve_structure_market_results' },
  { key: 'zones', label: 'Zones', runTable: 'eve_zones_scan_runs', rowTable: 'eve_zones_market_zones' },
  { key: 'liquidity', label: 'Liquidity', runTable: 'eve_liquidity_scan_runs', rowTable: 'eve_liquidity_market_results' }
];

const MARKETS = [
  { symbol: 'XAU/USD', display_name: 'Gold', asset_class: 'metal' },
  { symbol: 'XAG/USD', display_name: 'Silver', asset_class: 'metal' },
  { symbol: 'EUR/USD', display_name: 'Euro / Dollar', asset_class: 'forex' },
  { symbol: 'GBP/USD', display_name: 'Pound / Dollar', asset_class: 'forex' },
  { symbol: 'USD/JPY', display_name: 'Dollar / Yen', asset_class: 'forex' },
  { symbol: 'AUD/USD', display_name: 'Aussie / Dollar', asset_class: 'forex' },
  { symbol: 'USD/CAD', display_name: 'Dollar / Cad', asset_class: 'forex' },
  { symbol: 'EUR/JPY', display_name: 'Euro / Yen', asset_class: 'forex' },
  { symbol: 'GBP/JPY', display_name: 'Pound / Yen', asset_class: 'forex' },
  { symbol: 'BTC/USD', display_name: 'Bitcoin', asset_class: 'crypto' },
  { symbol: 'ETH/USD', display_name: 'Ethereum', asset_class: 'crypto' },
  { symbol: 'SOL/USD', display_name: 'Solana', asset_class: 'crypto' }
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function lower(value) { return String(value || '').toLowerCase(); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function round(value, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * p) / p;
}
function nowIso() { return new Date().toISOString(); }
function addMinutes(dateOrIso, minutes) {
  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return new Date(date.getTime() + Number(minutes) * 60_000).toISOString();
}
function minutesBetween(a, b) {
  const aa = a instanceof Date ? a : new Date(a);
  const bb = b instanceof Date ? b : new Date(b);
  return Math.abs(aa.getTime() - bb.getTime()) / 60_000;
}
function isBullish(value) {
  const v = lower(value);
  return v.includes('bull') || v === 'buy' || v === 'up';
}
function isBearish(value) {
  const v = lower(value);
  return v.includes('bear') || v === 'sell' || v === 'down';
}
function directionFromBias(value) {
  if (isBullish(value)) return 'buy';
  if (isBearish(value)) return 'sell';
  return null;
}
function isOpenIdeaStatus(status) { return ['forming', 'armed', 'active'].includes(status); }
function isClosedStatus(status) {
  return ['won', 'lost', 'closed', 'no_trigger', 'invalidated_before_entry', 'expired', 'cancelled'].includes(status);
}

function priceDecimals(symbol) {
  if (String(symbol).includes('JPY')) return 3;
  if (symbol === 'XAU/USD' || symbol === 'XAG/USD') return 2;
  if (symbol === 'BTC/USD') return 0;
  if (symbol === 'ETH/USD') return 1;
  if (symbol === 'SOL/USD') return 2;
  return 5;
}

function priceBuffer(symbol, price) {
  const p = Math.abs(Number(price) || 1);
  if (symbol === 'XAU/USD') return Math.max(0.8, p * 0.00035);
  if (symbol === 'XAG/USD') return Math.max(0.025, p * 0.0008);
  if (String(symbol).includes('JPY')) return Math.max(0.025, p * 0.00018);
  if (symbol === 'BTC/USD') return Math.max(35, p * 0.00055);
  if (symbol === 'ETH/USD') return Math.max(2.5, p * 0.0008);
  if (symbol === 'SOL/USD') return Math.max(0.15, p * 0.0012);
  return Math.max(0.00025, p * 0.00018);
}

function confirmationBuffer(symbol, price, multiplier = 0.25) {
  return priceBuffer(symbol, price) * Math.max(0.05, Number(multiplier) || 0.25);
}

function proximityAllowance(symbol, price, low, high) {
  const p = Math.abs(Number(price) || 1);
  const width = Math.abs(Number(high) - Number(low));
  const crypto = ['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(symbol);
  return Math.max(width * 1.35, priceBuffer(symbol, p) * 2.2, p * (crypto ? 0.0015 : 0.00055));
}

function rrFor(direction, entry, stop, target) {
  const e = Number(entry), s = Number(stop), t = Number(target);
  if (![e, s, t].every(Number.isFinite) || e <= 0 || s <= 0 || t <= 0) return { risk: null, reward: null, rr: 0 };
  const risk = direction === 'buy' ? e - s : s - e;
  const reward = direction === 'buy' ? t - e : e - t;
  if (risk <= 0 || reward <= 0) return { risk, reward, rr: 0 };
  return { risk, reward, rr: reward / risk };
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = part.value;
  const hour = Number(out.hour) === 24 ? 0 : Number(out.hour);
  return {
    weekday: out.weekday,
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
    minutes: hour * 60 + Number(out.minute)
  };
}
function weekdayOpen(parts) { return !['Sat', 'Sun'].includes(parts.weekday); }

function activeSessionAt(date = new Date()) {
  const london = zonedParts(date, 'Europe/London');
  const newYork = zonedParts(date, 'America/New_York');
  if (weekdayOpen(london) && london.minutes >= 8 * 60 + 15 && london.minutes <= 11 * 60) {
    return { key: 'london', name: 'London', label: 'LONDON IDEA WINDOW', time_zone: 'Europe/London', local_start: '08:15', local_finish: '11:00' };
  }
  if (weekdayOpen(newYork) && newYork.minutes >= 8 * 60 + 30 && newYork.minutes <= 11 * 60) {
    return { key: 'new_york', name: 'New York', label: 'NEW YORK IDEA WINDOW', time_zone: 'America/New_York', local_start: '08:30', local_finish: '11:00' };
  }
  return null;
}

function nextSessionStart(date = new Date()) {
  const cursor = new Date(date.getTime() + 60_000);
  cursor.setUTCSeconds(0, 0);
  let wasOpen = Boolean(activeSessionAt(date));
  for (let i = 0; i < 8 * 24 * 60; i += 1) {
    const session = activeSessionAt(cursor);
    if (session && !wasOpen) return { at: cursor.toISOString(), session };
    wasOpen = Boolean(session);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function sessionState(date = new Date()) {
  const active = activeSessionAt(date);
  return {
    is_open: Boolean(active),
    active,
    next: nextSessionStart(date),
    london_window: '08:15–11:00 Europe/London',
    new_york_window: '08:30–11:00 America/New_York'
  };
}

function nextFiveMinuteSlot(date = new Date()) {
  const d = new Date(date.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5 + 5);
  return d.toISOString();
}

async function getSetting(supabase, key, fallback) {
  const { data, error } = await supabase.from('eve_confluence_settings').select('value').eq('key', key).maybeSingle();
  if (error || !data) return fallback;
  const value = data.value;
  if (typeof fallback === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof fallback === 'boolean') return value === true || value === 'true';
  return value ?? fallback;
}

async function latestUsableRun(supabase, source, now, maxAgeMinutes) {
  const { data, error } = await supabase
    .from(source.runTable)
    .select('*')
    .not('completed_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(15);
  if (error) return { ...source, run: null, rows: [], map: {}, isFresh: false, ageMinutes: null, status: 'error', error: error.message };
  const badWords = ['starting', 'failed', 'error', 'disabled', 'skipped'];
  const run = (data || []).find((row) => !badWords.some((word) => lower(row.mode).includes(word))) || null;
  if (!run) return { ...source, run: null, rows: [], map: {}, isFresh: false, ageMinutes: null, status: 'missing' };
  const ageMinutes = minutesBetween(now, run.completed_at || run.started_at);
  const isFresh = ageMinutes <= maxAgeMinutes;
  const { data: rows, error: rowsError } = await supabase
    .from(source.rowTable)
    .select('*')
    .eq('scan_id', run.id)
    .order('rank', { ascending: true, nullsFirst: false });
  const usableRows = rowsError ? [] : (rows || []);
  return {
    ...source,
    run,
    rows: usableRows,
    map: Object.fromEntries(usableRows.map((row) => [row.symbol, row])),
    isFresh,
    ageMinutes: round(ageMinutes, 1),
    status: rowsError ? 'error' : (isFresh ? 'fresh' : 'stale'),
    error: rowsError?.message || null
  };
}

async function loadInputs(supabase, now, maxAgeMinutes) {
  const sourceRows = await Promise.all(SOURCE_SCANNERS.map((source) => latestUsableRun(supabase, source, now, maxAgeMinutes)));
  const sources = Object.fromEntries(sourceRows.map((source) => [source.key, source]));
  return {
    sources,
    allFresh: sourceRows.every((source) => source.isFresh),
    freshCount: sourceRows.filter((source) => source.isFresh).length,
    checked_at: now.toISOString(),
    max_age_minutes: maxAgeMinutes
  };
}

function marketData(inputs, symbol) {
  const bias = inputs.sources.bias?.map?.[symbol] || null;
  const zones = inputs.sources.zones?.map?.[symbol] || null;
  const structure = inputs.sources.structure?.map?.[symbol] || null;
  const liquidity = inputs.sources.liquidity?.map?.[symbol] || null;
  const candidates = [
    { row: liquidity, source: 'Liquidity' },
    { row: zones, source: 'Zones' },
    { row: structure, source: 'Structure' },
    { row: bias, source: 'Bias' }
  ].filter((item) => num(item.row?.latest_price));
  candidates.sort((a, b) => {
    const ta = new Date(a.row.latest_candle_at || a.row.created_at || 0).getTime();
    const tb = new Date(b.row.latest_candle_at || b.row.created_at || 0).getTime();
    return tb - ta;
  });
  return { bias, zones, structure, liquidity, price: num(candidates[0]?.row?.latest_price), price_source: candidates[0]?.source || null };
}

function marketIsOpen(market, data) {
  if (market.asset_class === 'crypto') return true;
  const rows = [data.bias, data.zones, data.structure, data.liquidity].filter(Boolean);
  return rows.length > 0 && rows.some((row) => row.is_open !== false);
}
function sourceRowUsable(source, row) { return Boolean(source?.isFresh && row && row.is_stale !== true); }

function structureSupport(direction, structure) {
  if (!structure) return { points: 4, label: 'Structure unavailable' };
  const values = [structure.structure_bias, structure.h1_bias, structure.m15_bias, structure.m5_bias];
  let aligned = 0;
  let opposed = 0;
  for (const value of values) {
    if ((direction === 'buy' && isBullish(value)) || (direction === 'sell' && isBearish(value))) aligned += 1;
    if ((direction === 'buy' && isBearish(value)) || (direction === 'sell' && isBullish(value))) opposed += 1;
  }
  const eventAligned = (direction === 'buy' && isBullish(structure.latest_event_direction)) || (direction === 'sell' && isBearish(structure.latest_event_direction));
  const points = clamp(3 + aligned * 2.5 - opposed * 1.5 + (eventAligned ? 2 : 0), 0, 14);
  return { points, label: `${aligned}/4 structure layers aligned${eventAligned ? ' with latest event' : ''}` };
}

function liquiditySupport(direction, liquidity) {
  if (!liquidity) return { points: 2, quality: 0, type: null, label: 'Liquidity unavailable' };
  const quality = clamp(direction === 'buy' ? liquidity.demand_sweep_quality : liquidity.supply_sweep_quality, 0, 100);
  const type = direction === 'buy' ? liquidity.demand_sweep_type : liquidity.supply_sweep_type;
  const points = type ? clamp(2 + quality * 0.08, 2, 10) : 2;
  return { points, quality, type: type || null, label: type ? `${type} ${Math.round(quality)}%` : 'No clear sweep recorded' };
}

function sessionFitPoints(session, market) {
  if (!session) return 0;
  const s = market.symbol;
  if (session.key === 'london') {
    if (['EUR/USD', 'GBP/USD', 'EUR/JPY', 'GBP/JPY', 'XAU/USD', 'XAG/USD'].includes(s)) return 5;
    return market.asset_class === 'crypto' ? 2 : 3;
  }
  if (['XAU/USD', 'XAG/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD'].includes(s)) return 5;
  return market.asset_class === 'crypto' ? 3 : 3;
}

function classifyZone(direction, symbol, price, low, high) {
  const p = num(price), l = num(low), h = num(high);
  if (![p, l, h].every(Number.isFinite) || l >= h) return { key: 'no_zone', points: 0, distance: null, allowance: null };
  const allowance = proximityAllowance(symbol, p, l, h);
  if (direction === 'buy') {
    if (p < l) return { key: 'zone_failed', points: 0, distance: l - p, allowance };
    if (p <= h) return { key: 'touching', points: 24, distance: 0, allowance };
    const distance = p - h;
    if (distance <= allowance) return { key: 'near', points: 21, distance, allowance };
    if (distance <= allowance * 3) return { key: 'approaching', points: 16, distance, allowance };
    return { key: 'waiting', points: 5, distance, allowance };
  }
  if (p > h) return { key: 'zone_failed', points: 0, distance: p - h, allowance };
  if (p >= l) return { key: 'touching', points: 24, distance: 0, allowance };
  const distance = l - p;
  if (distance <= allowance) return { key: 'near', points: 21, distance, allowance };
  if (distance <= allowance * 3) return { key: 'approaching', points: 16, distance, allowance };
  return { key: 'waiting', points: 5, distance, allowance };
}

function classifyRetest(direction, symbol, price, level) {
  const p = num(price), l = num(level);
  if (![p, l].every(Number.isFinite)) return { key: 'no_level', points: 0, distance: null, allowance: null };
  const crypto = ['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(symbol);
  const allowance = Math.max(priceBuffer(symbol, p) * 2.4, Math.abs(l) * (crypto ? 0.0014 : 0.0005));
  if (direction === 'buy') {
    if (p < l - allowance * 0.45) return { key: 'retest_failed', points: 0, distance: l - p, allowance };
    const distance = Math.abs(p - l);
    if (distance <= allowance * 0.65) return { key: 'touching', points: 24, distance, allowance };
    if (p > l && distance <= allowance * 1.5) return { key: 'near', points: 21, distance, allowance };
    if (p > l && distance <= allowance * 3.5) return { key: 'approaching', points: 16, distance, allowance };
    return { key: 'waiting', points: 5, distance, allowance };
  }
  if (p > l + allowance * 0.45) return { key: 'retest_failed', points: 0, distance: p - l, allowance };
  const distance = Math.abs(p - l);
  if (distance <= allowance * 0.65) return { key: 'touching', points: 24, distance, allowance };
  if (p < l && distance <= allowance * 1.5) return { key: 'near', points: 21, distance, allowance };
  if (p < l && distance <= allowance * 3.5) return { key: 'approaching', points: 16, distance, allowance };
  return { key: 'waiting', points: 5, distance, allowance };
}

function targetCandidates(direction, entry, data) {
  const e = Number(entry);
  const list = [];
  function add(value, source, quality = 50) {
    const price = num(value);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(e) || e <= 0) return;
    if ((direction === 'buy' && price > e) || (direction === 'sell' && price < e)) list.push({ price, source, quality: clamp(quality, 0, 100) });
  }
  if (direction === 'buy') {
    add(data.liquidity?.demand_target_price, data.liquidity?.demand_target_type || 'buy-side liquidity', data.liquidity?.demand_target_quality || 60);
    add(data.zones?.supply_low, 'nearest supply', data.zones?.supply_quality || 50);
  } else {
    add(data.liquidity?.supply_target_price, data.liquidity?.supply_target_type || 'sell-side liquidity', data.liquidity?.supply_target_quality || 60);
    add(data.zones?.demand_high, 'nearest demand', data.zones?.demand_quality || 50);
  }
  list.sort((a, b) => direction === 'buy' ? a.price - b.price : b.price - a.price);
  return list;
}

function bestTarget(direction, entry, stop, data, minPlannedRr, maxPlannedRr = 25) {
  const targets = targetCandidates(direction, entry, data);
  const minRr = Math.max(1, Number(minPlannedRr) || 2);
  const maxRr = Math.max(minRr, Number(maxPlannedRr) || 25);
  for (const target of targets) {
    const rr = rrFor(direction, entry, stop, target.price);
    if (rr.rr >= minRr && rr.rr <= maxRr) return { ...target, ...rr };
  }
  return null;
}

function biasBase(data) {
  const direction = directionFromBias(data.bias?.bias);
  // EVE Bias stores direction as a signed number: bullish is positive and bearish is negative.
  // The separate `score` column is market quality. Never clamp a bearish bias_score directly,
  // because doing so turns every bearish market into 0 and prevents SELL ideas.
  const signedStrength = num(data.bias?.bias_score);
  const strength = clamp(Number.isFinite(signedStrength) ? Math.abs(signedStrength) : data.bias?.score, 0, 100);
  const quality = clamp(data.bias?.score, 0, 100);
  const status = lower(data.bias?.status);
  const excluded = ['closed', 'stale', 'error', 'excluded', 'avoid'].some((word) => status.includes(word));
  return { direction, score: strength, quality, signedStrength, excluded };
}

function baseAsset(market, data) {
  return {
    symbol: market.symbol,
    display_name: market.display_name,
    asset_class: market.asset_class,
    is_open: marketIsOpen(market, data),
    direction: 'none',
    status: 'no_trade',
    strategy_type: null,
    session_name: null,
    confluence_score: 0,
    reason: 'No setup found.',
    trigger_needed: null,
    bias: data.bias?.bias || null,
    bias_score: Math.abs(num(data.bias?.bias_score) ?? num(data.bias?.score) ?? 0),
    structure_bias: data.structure?.structure_bias || null,
    structure_score: num(data.structure?.score) || 0,
    zone_quality: 0,
    liquidity_quality: 0,
    latest_price: data.price,
    planned_entry: null,
    demand_low: num(data.zones?.demand_low ?? data.liquidity?.demand_low),
    demand_high: num(data.zones?.demand_high ?? data.liquidity?.demand_high),
    supply_low: num(data.zones?.supply_low ?? data.liquidity?.supply_low),
    supply_high: num(data.zones?.supply_high ?? data.liquidity?.supply_high),
    target_price: null,
    stop_loss: null,
    risk_amount: null,
    reward_amount: null,
    rr: 0,
    zone_state: null,
    target_source: null,
    sl_reason: null,
    raw: { price_source: data.price_source }
  };
}

function buildPullbackOption(market, data, inputs, session, settings) {
  const base = baseAsset(market, data);
  const bias = biasBase(data);
  if (!sourceRowUsable(inputs.sources.bias, data.bias) || !sourceRowUsable(inputs.sources.zones, data.zones)) return null;
  if (!bias.direction || bias.excluded || bias.score < settings.minimumDirectionalBias) return null;
  const direction = bias.direction;
  const low = direction === 'buy' ? num(data.zones.demand_low) : num(data.zones.supply_low);
  const high = direction === 'buy' ? num(data.zones.demand_high) : num(data.zones.supply_high);
  if (![low, high, data.price].every(Number.isFinite) || low >= high) return null;

  const zoneEdge = direction === 'buy' ? high : low;
  const triggerBuffer = confirmationBuffer(market.symbol, zoneEdge, settings.triggerBufferMultiplier);
  const plannedEntry = direction === 'buy' ? zoneEdge + triggerBuffer : zoneEdge - triggerBuffer;
  const stop = direction === 'buy' ? low - priceBuffer(market.symbol, plannedEntry) : high + priceBuffer(market.symbol, plannedEntry);
  const targetData = {
    ...data,
    zones: sourceRowUsable(inputs.sources.zones, data.zones) ? data.zones : null,
    liquidity: sourceRowUsable(inputs.sources.liquidity, data.liquidity) ? data.liquidity : null
  };
  const target = bestTarget(direction, plannedEntry, stop, targetData, settings.minimumPlannedRr, settings.maximumPlannedRr);
  if (!target) return null;

  const proximity = classifyZone(direction, market.symbol, data.price, low, high);
  if (['zone_failed', 'no_zone'].includes(proximity.key)) return null;
  const structure = structureSupport(direction, sourceRowUsable(inputs.sources.structure, data.structure) ? data.structure : null);
  const liquidity = liquiditySupport(direction, sourceRowUsable(inputs.sources.liquidity, data.liquidity) ? data.liquidity : null);
  const zoneQuality = clamp(direction === 'buy' ? data.zones.demand_quality : data.zones.supply_quality, 0, 100);
  const biasPoints = clamp((bias.score * 0.65 + bias.quality * 0.35) * 0.20, 0, 20);
  const zonePoints = clamp(zoneQuality * 0.20, 0, 20);
  const proximityPoints = clamp(proximity.points / 24 * 20, 0, 20);
  const structurePoints = clamp(structure.points / 14 * 15, 0, 15);
  const liquidityPoints = clamp(liquidity.points, 0, 10);
  const targetPoints = clamp(target.quality * 0.05, 0, 5);
  const rrPoints = clamp(2.5 + (target.rr - settings.minimumPlannedRr) * 1.25, 2.5, 5);
  const score = round(clamp(biasPoints + zonePoints + proximityPoints + structurePoints + liquidityPoints + targetPoints + rrPoints + sessionFitPoints(session, market), 0, 100), 1);
  const status = proximity.key === 'touching' ? 'armed' : (['near', 'approaching'].includes(proximity.key) ? 'forming' : 'candidate');
  const area = direction === 'buy' ? 'demand' : 'supply';
  const triggerNeeded = direction === 'buy'
    ? `Touch demand, then reclaim ${round(plannedEntry, priceDecimals(market.symbol))}`
    : `Touch supply, then reject below ${round(plannedEntry, priceDecimals(market.symbol))}`;
  const action = status === 'armed'
    ? `Price is in ${area}. Railway is waiting for one live reclaim/rejection trigger.`
    : status === 'forming'
      ? `Price is approaching ${area}. The live trigger is already calculated.`
      : `The plan is good, but price is still away from ${area}.`;

  return {
    ...base,
    direction,
    status,
    strategy_type: 'zone_reaction',
    session_name: session?.name || null,
    confluence_score: score,
    reason: `${direction.toUpperCase()} zone reaction — Bias agrees, ${area} is ${Math.round(zoneQuality)}% quality, ${structure.label}, and ${target.source} provides at least 1:${round(target.rr, 2)}. ${action}`,
    trigger_needed: triggerNeeded,
    zone_quality: zoneQuality,
    liquidity_quality: Math.max(liquidity.quality, target.quality),
    planned_entry: plannedEntry,
    target_price: target.price,
    stop_loss: stop,
    risk_amount: target.risk,
    reward_amount: target.reward,
    rr: target.rr,
    zone_state: proximity.key,
    target_source: target.source,
    sl_reason: `Stop beyond ${area}.`,
    raw: {
      ...base.raw,
      trade_engine: {
        version: 14,
        strategy_type: 'zone_reaction',
        proximity,
        structure_support: structure.label,
        liquidity_support: liquidity.label,
        session: session?.key || null,
        reference_level: zoneEdge,
        trigger_buffer: triggerBuffer,
        planned_entry: plannedEntry
      }
    }
  };
}

function eventAgeMinutes(structure, now) {
  const at = structure?.latest_event_time || structure?.bos_time;
  return at ? minutesBetween(now, at) : null;
}

function breakoutLevel(direction, structure, now) {
  if (!structure) return null;
  const aligned = (value) => direction === 'buy' ? isBullish(value) : isBearish(value);
  const bosLevel = num(structure.bos_level);
  const bosAge = structure.bos_time ? minutesBetween(now, structure.bos_time) : null;
  if (Number.isFinite(bosLevel) && aligned(structure.bos_direction) && (!Number.isFinite(bosAge) || bosAge <= 180)) return bosLevel;
  const latestLevel = num(structure.latest_event_level);
  const latestAge = structure.latest_event_time ? minutesBetween(now, structure.latest_event_time) : null;
  if (lower(structure.latest_event_type) === 'bos' && Number.isFinite(latestLevel) && aligned(structure.latest_event_direction) && (!Number.isFinite(latestAge) || latestAge <= 180)) return latestLevel;
  return null;
}

function buildBreakoutOption(market, data, inputs, session, settings, now) {
  const base = baseAsset(market, data);
  const bias = biasBase(data);
  if (!sourceRowUsable(inputs.sources.bias, data.bias) || !sourceRowUsable(inputs.sources.structure, data.structure)) return null;
  if (!bias.direction || bias.excluded || bias.score < settings.minimumDirectionalBias) return null;
  const direction = bias.direction;
  const level = breakoutLevel(direction, data.structure, now);
  if (!Number.isFinite(level) || !Number.isFinite(data.price)) return null;

  const proximity = classifyRetest(direction, market.symbol, data.price, level);
  if (['retest_failed', 'no_level'].includes(proximity.key)) return null;
  const triggerBuffer = confirmationBuffer(market.symbol, level, settings.triggerBufferMultiplier);
  const plannedEntry = direction === 'buy' ? level + triggerBuffer : level - triggerBuffer;
  const stop = direction === 'buy' ? level - priceBuffer(market.symbol, level) * 1.35 : level + priceBuffer(market.symbol, level) * 1.35;
  const targetData = {
    ...data,
    zones: sourceRowUsable(inputs.sources.zones, data.zones) ? data.zones : null,
    liquidity: sourceRowUsable(inputs.sources.liquidity, data.liquidity) ? data.liquidity : null
  };
  const target = bestTarget(direction, plannedEntry, stop, targetData, settings.minimumPlannedRr, settings.maximumPlannedRr);
  if (!target) return null;

  const structureScore = clamp(data.structure.score, 0, 100);
  const liquidity = liquiditySupport(direction, sourceRowUsable(inputs.sources.liquidity, data.liquidity) ? data.liquidity : null);
  const biasPoints = clamp((bias.score * 0.65 + bias.quality * 0.35) * 0.20, 0, 20);
  const structurePoints = clamp(10 + structureScore * 0.20, 10, 30);
  const proximityPoints = clamp(proximity.points / 24 * 20, 0, 20);
  const liquidityPoints = clamp(liquidity.points, 0, 10);
  const targetPoints = clamp(target.quality * 0.05, 0, 5);
  const rrPoints = clamp(2.5 + (target.rr - settings.minimumPlannedRr) * 1.25, 2.5, 5);
  const score = round(clamp(biasPoints + structurePoints + proximityPoints + liquidityPoints + targetPoints + rrPoints + sessionFitPoints(session, market), 0, 100), 1);
  const status = proximity.key === 'touching' ? 'armed' : (['near', 'approaching'].includes(proximity.key) ? 'forming' : 'candidate');
  const retestLow = level - proximity.allowance * 0.45;
  const retestHigh = level + proximity.allowance * 0.45;
  const triggerNeeded = direction === 'buy'
    ? `Retest ${round(level, priceDecimals(market.symbol))}, then reclaim ${round(plannedEntry, priceDecimals(market.symbol))}`
    : `Retest ${round(level, priceDecimals(market.symbol))}, then reject below ${round(plannedEntry, priceDecimals(market.symbol))}`;

  return {
    ...base,
    direction,
    status,
    strategy_type: 'broken_level_retest',
    session_name: session?.name || null,
    confluence_score: score,
    reason: `${direction.toUpperCase()} broken-level retest — Bias agrees with a recent BOS. Railway will activate only after the level is retested and reclaimed/rejected live.`,
    trigger_needed: triggerNeeded,
    zone_quality: 0,
    liquidity_quality: Math.max(liquidity.quality, target.quality),
    planned_entry: plannedEntry,
    target_price: target.price,
    stop_loss: stop,
    risk_amount: target.risk,
    reward_amount: target.reward,
    rr: target.rr,
    demand_low: direction === 'buy' ? retestLow : base.demand_low,
    demand_high: direction === 'buy' ? retestHigh : base.demand_high,
    supply_low: direction === 'sell' ? retestLow : base.supply_low,
    supply_high: direction === 'sell' ? retestHigh : base.supply_high,
    zone_state: proximity.key,
    target_source: target.source,
    sl_reason: 'Stop beyond the broken structure level.',
    raw: {
      ...base.raw,
      trade_engine: {
        version: 14,
        strategy_type: 'broken_level_retest',
        proximity,
        bos_level: level,
        reference_level: level,
        trigger_buffer: triggerBuffer,
        event_age_minutes: eventAgeMinutes(data.structure, now),
        session: session?.key || null,
        planned_entry: plannedEntry,
        retest_low: retestLow,
        retest_high: retestHigh
      }
    }
  };
}

function buildMarketChoice(market, inputs, session, settings, now) {
  const data = marketData(inputs, market.symbol);
  const base = baseAsset(market, data);
  if (!marketIsOpen(market, data)) return { ...base, reason: 'Market is closed or unavailable.' };
  if (!Number.isFinite(data.price)) return { ...base, reason: 'Waiting for a current scanner price.' };
  const bias = biasBase(data);
  if (!sourceRowUsable(inputs.sources.bias, data.bias)) return { ...base, reason: 'Bias data is missing or too old.' };
  if (!bias.direction) return { ...base, reason: 'Bias has no clear BUY or SELL direction.' };
  if (bias.excluded) return { ...base, direction: bias.direction, reason: `Bias scanner currently marks this market ${data.bias?.status || 'excluded'}.` };
  if (bias.score < settings.minimumDirectionalBias) {
    return { ...base, direction: bias.direction, reason: `Bias is ${Math.round(bias.score)}%. Waiting for ${settings.minimumDirectionalBias}% or higher.` };
  }
  const options = [
    buildPullbackOption(market, data, inputs, session, settings),
    buildBreakoutOption(market, data, inputs, session, settings, now)
  ].filter(Boolean);
  if (!options.length) {
    return {
      ...base,
      direction: bias.direction,
      confluence_score: round(clamp(bias.score * 0.5, 0, 50), 1),
      reason: `${bias.direction.toUpperCase()} bias exists, but no zone/retest plan currently provides at least 1:${settings.minimumPlannedRr}.`
    };
  }
  options.sort((a, b) => Number(b.confluence_score) - Number(a.confluence_score));
  return options[0];
}

async function insertEvent(supabase, eventType, idea, message, raw = {}) {
  const { error } = await supabase.from('eve_confluence_events').insert({
    event_type: eventType,
    symbol: idea?.symbol || null,
    idea_id: idea?.id || null,
    message,
    raw
  });
  if (error) console.error('Could not write Confluence event:', error.message);
}

async function getOpenIdea(supabase) {
  const { data, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('*')
    .in('status', ['forming', 'armed', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return error ? null : (data || null);
}

async function getIdea(supabase, id) {
  if (!id) return null;
  const { data, error } = await supabase.from('eve_confluence_trade_ideas').select('*').eq('id', id).maybeSingle();
  return error ? null : (data || null);
}

async function getCurrentFocus(supabase) {
  const { data, error } = await supabase.from('eve_confluence_current_focus').select('*').eq('id', 'current').maybeSingle();
  return error ? null : (data || null);
}

async function setFocus(supabase, fields) {
  const current = await getCurrentFocus(supabase);
  const row = { ...(current || {}), id: 'current', ...fields, updated_at: nowIso() };
  for (const [key, value] of Object.entries(row)) if (value === undefined) delete row[key];
  const { error } = await supabase.from('eve_confluence_current_focus').upsert(row);
  if (error) throw error;
  return row;
}

async function recentDuplicate(supabase, option, now, cooldownMinutes) {
  const since = addMinutes(now, -cooldownMinutes);
  const { data, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('id')
    .eq('symbol', option.symbol)
    .eq('direction', option.direction)
    .eq('strategy_type', option.strategy_type)
    .gte('created_at', since)
    .limit(1);
  return !error && (data || []).length > 0;
}

async function createIdea(supabase, option, session, now, settings) {
  const armed = option.status === 'armed';
  const expiresAt = addMinutes(now, armed ? settings.armedExpiryMinutes : settings.ideaExpiryMinutes);
  const payload = {
    symbol: option.symbol,
    direction: option.direction,
    status: armed ? 'armed' : 'forming',
    strategy_type: option.strategy_type,
    session_name: session.name,
    idea_score: option.confluence_score,
    execution_type: 'railway_live_zone_reaction_v14',
    focus_started_at: now.toISOString(),
    lock_until: expiresAt,
    formed_at: now.toISOString(),
    armed_at: armed ? now.toISOString() : null,
    confirm_started_at: null,
    expires_at: expiresAt,
    active_expires_at: null,
    last_checked_at: now.toISOString(),
    planned_entry: option.planned_entry,
    forming_price: option.latest_price,
    entry_price: null,
    trigger_price: null,
    stop_loss: option.stop_loss,
    take_profit: option.target_price,
    risk_amount: option.risk_amount,
    reward_amount: option.reward_amount,
    rr: option.rr,
    demand_low: option.demand_low,
    demand_high: option.demand_high,
    supply_low: option.supply_low,
    supply_high: option.supply_high,
    target_source: option.target_source,
    sl_reason: option.sl_reason,
    touched_zone: armed,
    touched_zone_at: armed ? now.toISOString() : null,
    touch_extreme_price: armed ? option.latest_price : null,
    confirmation_tick_count: 0,
    last_live_price: option.latest_price,
    last_live_at: null,
    max_favourable_price: null,
    max_adverse_price: null,
    best_r: null,
    worst_r: null,
    reason: option.reason,
    latest_note: armed
      ? `GET READY — entry area is touched. Railway needs one live reclaim/rejection through ${round(option.planned_entry, priceDecimals(option.symbol))}.`
      : `WATCHING — waiting for price to reach the entry area. Then Railway will manage the live reaction.`,
    raw: {
      trade_engine: {
        version: 14,
        owner: 'railway_after_focus',
        trigger_needed: option.trigger_needed,
        strategy_type: option.strategy_type,
        session: session.key,
        session_name: session.name,
        idea_score: option.confluence_score,
        planned_entry: option.planned_entry,
        scanner_snapshot: option.raw
      }
    }
  };
  const { data, error } = await supabase.from('eve_confluence_trade_ideas').insert(payload).select('*').maybeSingle();
  if (error) throw error;
  await insertEvent(supabase, 'idea_created', data, `${option.symbol} ${option.direction.toUpperCase()} idea selected. Railway now owns live touch, activation and outcome.`, { score: option.confluence_score, trigger_needed: option.trigger_needed });
  return data;
}

async function latestRun(supabase, table) {
  const { data, error } = await supabase.from(table).select('*').order('started_at', { ascending: false }).limit(1).maybeSingle();
  return error ? null : (data || null);
}

async function rowsForScan(supabase, table, scanId) {
  if (!scanId) return [];
  const { data, error } = await supabase.from(table).select('*').eq('scan_id', scanId).order('rank', { ascending: true, nullsFirst: false });
  return error ? [] : (data || []);
}

async function runConfluenceScan(supabase, source = 'scheduled') {
  const now = new Date();
  const [scannerEnabled, minimumPlannedRr, maximumPlannedRr, minimumIdeaScore, sourceMaxAgeMinutes, ideaExpiryMinutes, armedExpiryMinutes, activeExpiryMinutes, cooldownMinutes, minimumDirectionalBias, triggerBufferMultiplier] = await Promise.all([
    getSetting(supabase, 'scanner_enabled', true),
    getSetting(supabase, 'minimum_rr', 2),
    getSetting(supabase, 'maximum_planned_rr', 25),
    getSetting(supabase, 'minimum_idea_score', DEFAULT_MIN_IDEA_SCORE),
    getSetting(supabase, 'source_max_age_minutes', DEFAULT_SOURCE_MAX_AGE_MINUTES),
    getSetting(supabase, 'idea_expiry_minutes', DEFAULT_IDEA_EXPIRY_MINUTES),
    getSetting(supabase, 'armed_confirmation_minutes', DEFAULT_ARMED_EXPIRY_MINUTES),
    getSetting(supabase, 'active_trade_expiry_minutes', DEFAULT_ACTIVE_EXPIRY_MINUTES),
    getSetting(supabase, 'same_symbol_direction_cooldown_minutes', DEFAULT_COOLDOWN_MINUTES),
    getSetting(supabase, 'minimum_directional_bias', MIN_DIRECTIONAL_BIAS),
    getSetting(supabase, 'trigger_buffer_multiplier', 0.25)
  ]);
  const settings = {
    minimumPlannedRr,
    maximumPlannedRr,
    minimumIdeaScore,
    sourceMaxAgeMinutes,
    ideaExpiryMinutes,
    armedExpiryMinutes,
    activeExpiryMinutes,
    cooldownMinutes,
    minimumDirectionalBias,
    triggerBufferMultiplier
  };

  const { data: run, error: runError } = await supabase.from('eve_confluence_scan_runs').insert({
    started_at: now.toISOString(), mode: 'starting', scanner_enabled: scannerEnabled, source
  }).select('*').maybeSingle();
  if (runError) throw runError;

  if (!scannerEnabled) {
    await setFocus(supabase, {
      symbol: null, direction: null, status: 'engine_off', idea_id: null, confluence_score: 0,
      reason: 'Trade Idea Engine is turned off.', locked_at: null, lock_until: null,
      railway_symbol: null, railway_status: 'engine_off', last_live_price: null, last_live_at: null,
      last_scan_id: run.id, last_scan_at: now.toISOString(), raw: {}
    });
    const completedAt = nowIso();
    await supabase.from('eve_confluence_scan_runs').update({ completed_at: completedAt, mode: 'engine_off', notes: 'Scanner disabled.' }).eq('id', run.id);
    return { run: { ...run, completed_at: completedAt, mode: 'engine_off' }, selected: null, idea: null, assets: [], inputs: null, session: sessionState(now) };
  }

  const inputs = await loadInputs(supabase, now, sourceMaxAgeMinutes);
  const currentSession = sessionState(now);
  const availableSymbols = new Set(
    Object.values(inputs.sources).flatMap((source) => (source.rows || []).map((row) => row.symbol).filter(Boolean))
  );
  const configuredMarkets = MARKETS.filter((market) => availableSymbols.has(market.symbol));
  const assets = configuredMarkets.map((market) => buildMarketChoice(market, inputs, currentSession.active, settings, now))
    .sort((a, b) => Number(b.confluence_score || 0) - Number(a.confluence_score || 0));

  const scoreRows = assets.map((asset, index) => ({
    scan_id: run.id,
    rank: index + 1,
    symbol: asset.symbol,
    display_name: asset.display_name,
    asset_class: asset.asset_class,
    is_open: asset.is_open,
    direction: asset.direction,
    status: asset.status,
    strategy_type: asset.strategy_type,
    session_name: currentSession.active?.name || null,
    confluence_score: asset.confluence_score || 0,
    reason: asset.reason,
    bias: asset.bias,
    bias_score: asset.bias_score,
    structure_bias: asset.structure_bias,
    structure_score: asset.structure_score,
    zone_quality: asset.zone_quality,
    liquidity_quality: asset.liquidity_quality,
    latest_price: asset.latest_price,
    planned_entry: asset.planned_entry,
    demand_low: asset.demand_low,
    demand_high: asset.demand_high,
    supply_low: asset.supply_low,
    supply_high: asset.supply_high,
    target_price: asset.target_price,
    stop_loss: asset.stop_loss,
    risk_amount: asset.risk_amount,
    reward_amount: asset.reward_amount,
    rr: asset.rr,
    zone_state: asset.zone_state,
    target_source: asset.target_source,
    sl_reason: asset.sl_reason,
    raw: {
      ...(asset.raw || {}),
      trigger_needed: asset.trigger_needed,
      source_freshness: Object.fromEntries(Object.entries(inputs.sources).map(([key, value]) => [key, { isFresh: value.isFresh, ageMinutes: value.ageMinutes, run_id: value.run?.id || null }]))
    }
  }));
  if (scoreRows.length) {
    const { error } = await supabase.from('eve_confluence_asset_scores').insert(scoreRows);
    if (error) throw error;
  }

  let openIdea = await getOpenIdea(supabase);
  let selected = null;
  let idea = openIdea;
  let mode = 'outside_session';
  let note = currentSession.is_open
    ? `Scanning the ${currentSession.active.name} window. No focus idea selected yet.`
    : 'Outside the London and New York idea windows. Railway continues managing any open idea.';

  if (openIdea) {
    selected = assets.find((asset) => asset.symbol === openIdea.symbol) || null;
    mode = `railway_tracking_${openIdea.status}`;
    note = openIdea.latest_note || openIdea.reason;
    await setFocus(supabase, {
      symbol: openIdea.symbol,
      direction: openIdea.direction,
      status: openIdea.status,
      idea_id: openIdea.id,
      confluence_score: openIdea.idea_score || selected?.confluence_score || 0,
      reason: note,
      locked_at: openIdea.focus_started_at,
      lock_until: openIdea.status === 'active' ? openIdea.active_expires_at : openIdea.expires_at,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      raw: { ...(await getCurrentFocus(supabase))?.raw, strategy_type: openIdea.strategy_type, session_name: openIdea.session_name, trigger_needed: openIdea.raw?.trade_engine?.trigger_needed }
    });
  } else if (currentSession.is_open) {
    const eligible = assets.filter((asset) => ['forming', 'armed'].includes(asset.status) && Number(asset.confluence_score) >= minimumIdeaScore && Number(asset.rr) >= minimumPlannedRr);
    for (const option of eligible) {
      if (await recentDuplicate(supabase, option, now, cooldownMinutes)) continue;
      selected = option;
      break;
    }
    if (selected) {
      idea = await createIdea(supabase, selected, currentSession.active, now, settings);
      mode = `railway_focus_${idea.status}`;
      note = idea.latest_note || idea.reason;
      await setFocus(supabase, {
        symbol: idea.symbol,
        direction: idea.direction,
        status: idea.status,
        idea_id: idea.id,
        confluence_score: idea.idea_score,
        reason: note,
        locked_at: idea.focus_started_at,
        lock_until: idea.expires_at,
        last_scan_id: run.id,
        last_scan_at: now.toISOString(),
        last_live_price: null,
        last_live_at: null,
        railway_symbol: null,
        railway_status: 'waiting_for_railway',
        raw: { strategy_type: idea.strategy_type, session_name: idea.session_name, trigger_needed: idea.raw?.trade_engine?.trigger_needed }
      });
    } else {
      const top = assets[0] || null;
      mode = 'session_scanning';
      note = top
        ? `BEST NOW: ${top.symbol} ${String(top.direction || '').toUpperCase()} ${String(top.strategy_type || 'setup').replaceAll('_', ' ')} — ${top.reason}`
        : 'No market data available.';
      await setFocus(supabase, {
        symbol: null,
        direction: null,
        status: 'scanning',
        idea_id: null,
        confluence_score: top?.confluence_score || 0,
        reason: note,
        locked_at: null,
        lock_until: null,
        last_scan_id: run.id,
        last_scan_at: now.toISOString(),
        railway_symbol: null,
        railway_status: 'no_focus',
        last_live_price: null,
        last_live_at: null,
        raw: { top_candidate: top, session: currentSession.active }
      });
    }
  } else {
    const top = assets[0] || null;
    await setFocus(supabase, {
      symbol: null,
      direction: null,
      status: 'outside_session',
      idea_id: null,
      confluence_score: top?.confluence_score || 0,
      reason: note,
      locked_at: null,
      lock_until: null,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      railway_symbol: null,
      railway_status: 'no_focus',
      last_live_price: null,
      last_live_at: null,
      raw: { top_candidate: top, session_state: currentSession }
    });
  }

  const completedAt = nowIso();
  await supabase.from('eve_confluence_scan_runs').update({
    completed_at: completedAt,
    mode,
    assets_checked: assets.length,
    assets_scored: assets.filter((asset) => asset.status !== 'no_trade').length,
    selected_symbol: selected?.symbol || idea?.symbol || null,
    selected_direction: selected?.direction || idea?.direction || null,
    selected_status: idea?.status || selected?.status || (currentSession.is_open ? 'scanning' : 'outside_session'),
    notes: note
  }).eq('id', run.id);

  return { run: { ...run, completed_at: completedAt, mode }, selected, idea, assets, inputs, session: currentSession };
}

async function latestScoredRun(supabase) {
  const { data, error } = await supabase
    .from('eve_confluence_scan_runs')
    .select('*')
    .gt('assets_checked', 0)
    .not('completed_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return error ? null : (data || null);
}

async function getLatestState(supabase) {
  const now = new Date();
  const maxAge = await getSetting(supabase, 'source_max_age_minutes', DEFAULT_SOURCE_MAX_AGE_MINUTES);
  const [latestRunRow, latestScoredRunRow, focus, recentIdeas, settings, inputs] = await Promise.all([
    latestRun(supabase, 'eve_confluence_scan_runs'),
    latestScoredRun(supabase),
    getCurrentFocus(supabase),
    supabase.from('eve_confluence_trade_ideas').select('*').order('created_at', { ascending: false }).limit(250),
    supabase.from('eve_confluence_settings').select('*'),
    loadInputs(supabase, now, maxAge)
  ]);
  const scanId = latestRunRow?.assets_checked > 0 ? latestRunRow.id : latestScoredRunRow?.id;
  const assets = scanId ? await rowsForScan(supabase, 'eve_confluence_asset_scores', scanId) : [];
  const currentIdea = await getIdea(supabase, focus?.idea_id);
  return {
    latest_run: latestRunRow,
    latest_decision_run: latestScoredRunRow,
    focus,
    current_idea: currentIdea,
    best_candidate: assets[0] || focus?.raw?.top_candidate || null,
    assets,
    recent_ideas: recentIdeas.data || [],
    source_freshness: {
      allFresh: inputs.allFresh,
      freshCount: inputs.freshCount,
      max_age_minutes: inputs.max_age_minutes,
      checked_at: inputs.checked_at,
      sources: Object.fromEntries(Object.entries(inputs.sources).map(([key, source]) => [key, {
        key,
        label: source.label,
        isFresh: source.isFresh,
        ageMinutes: source.ageMinutes,
        status: source.status,
        run: source.run ? { id: source.run.id, started_at: source.run.started_at, completed_at: source.run.completed_at, mode: source.run.mode } : null,
        error: source.error || null
      }]))
    },
    settings: Object.fromEntries((settings.data || []).map((row) => [row.key, row.value])),
    session: sessionState(now),
    next_scan_at: nextFiveMinuteSlot(now)
  };
}

function groupedStats(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = keyFn(row) || 'Unknown';
    groups[key] ||= { name: key, total: 0, wins: 0, losses: 0, noTrigger: 0, completed: 0, positive: 0, totalR: 0, r: [] };
    groups[key].total += 1;
    if (row.status === 'won') groups[key].wins += 1;
    if (row.status === 'lost') groups[key].losses += 1;
    if (['no_trigger', 'invalidated_before_entry', 'expired', 'cancelled'].includes(row.status)) groups[key].noTrigger += 1;
    if (row.activated_at && Number.isFinite(Number(row.result_r))) {
      const resultR = Number(row.result_r);
      groups[key].completed += 1;
      if (resultR > 0) groups[key].positive += 1;
      groups[key].r.push(resultR);
      groups[key].totalR += resultR;
    }
  }
  return Object.values(groups).map((group) => {
    group.winRate = group.completed ? group.positive / group.completed * 100 : 0;
    group.avgR = group.r.length ? group.r.reduce((sum, value) => sum + value, 0) / group.r.length : 0;
    group.totalR = round(group.totalR, 2);
    delete group.r;
    delete group.positive;
    return group;
  }).sort((a, b) => b.total - a.total);
}

function performanceStats(ideas) {
  const all = (ideas || []).filter((idea) => (idea.strategy_type || idea.raw?.trade_engine?.strategy_type) !== 'legacy');
  const wins = all.filter((idea) => idea.status === 'won').length;
  const losses = all.filter((idea) => idea.status === 'lost').length;
  const active = all.filter((idea) => idea.status === 'active').length;
  const forming = all.filter((idea) => ['forming', 'armed'].includes(idea.status)).length;
  const noTrigger = all.filter((idea) => ['no_trigger', 'invalidated_before_entry', 'expired', 'cancelled'].includes(idea.status)).length;
  const timeOrManualExits = all.filter((idea) => idea.status === 'closed').length;
  const completed = all.filter((idea) => idea.activated_at && Number.isFinite(Number(idea.result_r)));
  const completedWins = completed.filter((idea) => Number(idea.result_r) > 0).length;
  const resultRs = completed.map((idea) => Number(idea.result_r));
  return {
    totalIdeas: all.length,
    wins,
    losses,
    active,
    forming,
    noTrigger,
    timeOrManualExits,
    completedTrades: completed.length,
    winRate: completed.length ? completedWins / completed.length * 100 : 0,
    avgR: resultRs.length ? resultRs.reduce((sum, value) => sum + value, 0) / resultRs.length : 0,
    totalR: resultRs.reduce((sum, value) => sum + value, 0),
    byAsset: groupedStats(all, (idea) => idea.symbol).map((row) => ({ ...row, symbol: row.name })),
    byStrategy: groupedStats(all, (idea) => idea.strategy_type || idea.raw?.trade_engine?.strategy_type || 'Unknown'),
    bySession: groupedStats(all, (idea) => idea.session_name || 'Unknown')
  };
}

module.exports = {
  MARKETS,
  runConfluenceScan,
  getLatestState,
  performanceStats,
  isOpenIdeaStatus,
  isClosedStatus,
  rrFor,
  priceDecimals,
  priceBuffer,
  sessionState,
  activeSessionAt,
  buildMarketChoice
};
