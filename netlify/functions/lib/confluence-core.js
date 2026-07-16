const MIN_DIRECTIONAL_BIAS = 48;
const DEFAULT_MIN_IDEA_SCORE = 60;
const DEFAULT_SOURCE_MAX_AGE_MINUTES = 20;
const DEFAULT_IDEA_EXPIRY_MINUTES = 120;
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
function addMinutes(date, minutes) { return new Date(date.getTime() + Number(minutes) * 60_000).toISOString(); }
function minutesBetween(a, b) { return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60_000; }
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
function isClosedStatus(status) {
  return ['won', 'lost', 'no_trigger', 'invalidated_before_entry', 'expired', 'cancelled'].includes(status);
}
function isOpenIdeaStatus(status) { return ['forming', 'armed', 'active'].includes(status); }

function priceDecimals(symbol) {
  if (symbol.includes('JPY')) return 3;
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
  if (symbol.includes('JPY')) return Math.max(0.025, p * 0.00018);
  if (symbol === 'BTC/USD') return Math.max(35, p * 0.00055);
  if (symbol === 'ETH/USD') return Math.max(2.5, p * 0.0008);
  if (symbol === 'SOL/USD') return Math.max(0.15, p * 0.0012);
  return Math.max(0.00025, p * 0.00018);
}

function proximityAllowance(symbol, price, low, high) {
  const p = Math.abs(Number(price) || 1);
  const width = Math.abs(Number(high) - Number(low));
  return Math.max(width * 1.35, priceBuffer(symbol, p) * 2.2, p * (symbol.includes('/USD') && ['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(symbol) ? 0.0015 : 0.00055));
}

function rrFor(direction, entry, stop, target) {
  const e = Number(entry), s = Number(stop), t = Number(target);
  if (![e, s, t].every(Number.isFinite)) return { risk: null, reward: null, rr: 0 };
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
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
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
    return {
      key: 'london',
      name: 'London',
      label: 'LONDON IDEA WINDOW',
      time_zone: 'Europe/London',
      local_start: '08:15',
      local_finish: '11:00'
    };
  }
  if (weekdayOpen(newYork) && newYork.minutes >= 8 * 60 + 30 && newYork.minutes <= 11 * 60) {
    return {
      key: 'new_york',
      name: 'New York',
      label: 'NEW YORK IDEA WINDOW',
      time_zone: 'America/New_York',
      local_start: '08:30',
      local_finish: '11:00'
    };
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
  if (typeof fallback === 'boolean') return Boolean(value);
  return value ?? fallback;
}

async function latestUsableRun(supabase, source, now, maxAgeMinutes) {
  const { data, error } = await supabase
    .from(source.runTable)
    .select('*')
    .not('completed_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(15);
  if (error) {
    return { ...source, run: null, rows: [], map: {}, isFresh: false, ageMinutes: null, status: 'error', error: error.message };
  }
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
  return {
    bias,
    zones,
    structure,
    liquidity,
    price: num(candidates[0]?.row?.latest_price),
    price_source: candidates[0]?.source || null
  };
}

function marketIsOpen(market, data) {
  if (market.asset_class === 'crypto') return true;
  const rows = [data.bias, data.zones, data.structure, data.liquidity].filter(Boolean);
  if (!rows.length) return false;
  return rows.some((row) => row.is_open !== false);
}

function sourceRowUsable(source, row) {
  return Boolean(source?.isFresh && row && row.is_stale !== true);
}

function structureSupport(direction, structure) {
  if (!structure) return { points: 5, label: 'Structure unavailable' };
  const bias = structure.structure_bias;
  if ((direction === 'buy' && isBullish(bias)) || (direction === 'sell' && isBearish(bias))) {
    return { points: 15, label: 'Structure agrees' };
  }
  if ((direction === 'buy' && isBearish(bias)) || (direction === 'sell' && isBullish(bias))) {
    return { points: 0, label: 'Structure disagrees' };
  }
  return { points: 7, label: 'Structure is mixed' };
}

function sessionFitPoints(session, market) {
  if (!session) return 0;
  const s = market.symbol;
  if (session.key === 'london') {
    if (['EUR/USD', 'GBP/USD', 'EUR/JPY', 'GBP/JPY', 'XAU/USD', 'XAG/USD'].includes(s)) return 5;
    if (market.asset_class === 'crypto') return 2;
    return 3;
  }
  if (['XAU/USD', 'XAG/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD'].includes(s)) return 5;
  if (market.asset_class === 'crypto') return 3;
  return 3;
}

function classifyZone(direction, symbol, price, low, high) {
  const p = num(price), l = num(low), h = num(high);
  if (![p, l, h].every(Number.isFinite) || l >= h) return { key: 'no_zone', points: 0, distance: null, allowance: null };
  const allowance = proximityAllowance(symbol, p, l, h);
  if (direction === 'buy') {
    if (p < l) return { key: 'zone_failed', points: 0, distance: l - p, allowance };
    if (p <= h) return { key: 'touching', points: 23, distance: 0, allowance };
    const distance = p - h;
    if (distance <= allowance) return { key: 'near', points: 20, distance, allowance };
    if (distance <= allowance * 3) return { key: 'approaching', points: 16, distance, allowance };
    return { key: 'waiting', points: 5, distance, allowance };
  }
  if (p > h) return { key: 'zone_failed', points: 0, distance: p - h, allowance };
  if (p >= l) return { key: 'touching', points: 23, distance: 0, allowance };
  const distance = l - p;
  if (distance <= allowance) return { key: 'near', points: 20, distance, allowance };
  if (distance <= allowance * 3) return { key: 'approaching', points: 16, distance, allowance };
  return { key: 'waiting', points: 5, distance, allowance };
}

function classifyRetest(direction, symbol, price, level) {
  const p = num(price), l = num(level);
  if (![p, l].every(Number.isFinite)) return { key: 'no_level', points: 0, distance: null, allowance: null };
  const allowance = Math.max(priceBuffer(symbol, p) * 2.4, Math.abs(l) * (['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(symbol) ? 0.0014 : 0.0005));
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
    if (!Number.isFinite(price)) return;
    if ((direction === 'buy' && price > e) || (direction === 'sell' && price < e)) {
      list.push({ price, source, quality: clamp(quality, 0, 100) });
    }
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

function bestTarget(direction, entry, stop, data, minPlannedRr) {
  const targets = targetCandidates(direction, entry, data);
  const target = targets[0];
  if (!target) return null;
  const rr = rrFor(direction, entry, stop, target.price);
  if (rr.rr < minPlannedRr) return null;
  return { ...target, ...rr };
}

function biasBase(data) {
  const direction = directionFromBias(data.bias?.bias);
  const score = clamp(data.bias?.bias_score ?? data.bias?.score, 0, 100);
  const watchOnly = lower(data.bias?.bias).includes('watch') || lower(data.bias?.status).includes('watch');
  return { direction, score, watchOnly };
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
    bias: data.bias?.bias || null,
    bias_score: num(data.bias?.bias_score ?? data.bias?.score) || 0,
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
  if (!bias.direction || bias.watchOnly || bias.score < settings.minimumDirectionalBias) return null;
  const direction = bias.direction;
  const low = direction === 'buy' ? num(data.zones.demand_low) : num(data.zones.supply_low);
  const high = direction === 'buy' ? num(data.zones.demand_high) : num(data.zones.supply_high);
  if (![low, high, data.price].every(Number.isFinite) || low >= high) return null;

  const entry = direction === 'buy' ? high : low;
  const stop = direction === 'buy'
    ? low - priceBuffer(market.symbol, entry)
    : high + priceBuffer(market.symbol, entry);
  const targetData = {
    ...data,
    zones: sourceRowUsable(inputs.sources.zones, data.zones) ? data.zones : null,
    liquidity: sourceRowUsable(inputs.sources.liquidity, data.liquidity) ? data.liquidity : null
  };
  const target = bestTarget(direction, entry, stop, targetData, settings.minimumPlannedRr);
  if (!target) return null;

  const proximity = classifyZone(direction, market.symbol, data.price, low, high);
  if (['zone_failed', 'no_zone'].includes(proximity.key)) return null;
  const structure = structureSupport(direction, sourceRowUsable(inputs.sources.structure, data.structure) ? data.structure : null);
  const zoneQuality = clamp(direction === 'buy' ? data.zones.demand_quality : data.zones.supply_quality, 0, 100);
  const biasPoints = clamp(bias.score * 0.45, 0, 30);
  const zonePoints = clamp(zoneQuality * 0.25, 0, 25);
  const targetPoints = clamp(target.quality * 0.08 + 2, 0, 10);
  const rrPoints = clamp(4 + (target.rr - settings.minimumPlannedRr) * 3, 4, 8);
  const score = round(clamp(biasPoints + zonePoints + proximity.points + structure.points + targetPoints + rrPoints + sessionFitPoints(session, market), 0, 100), 1);
  const status = proximity.key === 'touching' ? 'armed' : (['near', 'approaching'].includes(proximity.key) ? 'forming' : 'candidate');
  const area = direction === 'buy' ? 'demand' : 'supply';
  const action = status === 'armed'
    ? `Price is in ${area}. Waiting for the next completed M5 candle to reject the zone.`
    : status === 'forming'
      ? `Price is approaching ${area}. Entry plan is ready.`
      : `Good pullback plan, but price is still away from ${area}.`;

  return {
    ...base,
    direction,
    status,
    strategy_type: 'pullback',
    session_name: session?.name || null,
    confluence_score: score,
    reason: `${direction.toUpperCase()} pullback — Bias points ${direction}, ${area} provides the entry, and ${target.source} provides the target. ${action}`,
    zone_quality: zoneQuality,
    liquidity_quality: target.quality,
    planned_entry: entry,
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
        strategy_type: 'pullback',
        proximity,
        structure_support: structure.label,
        session: session?.key || null,
        planned_entry: entry
      }
    }
  };
}

function eventAgeMinutes(structure, now) {
  const at = structure?.latest_event_time || structure?.bos_time;
  if (!at) return null;
  return minutesBetween(now, at);
}

function breakoutLevel(direction, structure, now) {
  if (!structure) return null;
  const aligned = (value) => direction === 'buy' ? isBullish(value) : isBearish(value);

  const bosLevel = num(structure.bos_level);
  const bosAge = structure.bos_time ? minutesBetween(now, structure.bos_time) : null;
  if (Number.isFinite(bosLevel) && aligned(structure.bos_direction) && (!Number.isFinite(bosAge) || bosAge <= 180)) {
    return bosLevel;
  }

  const latestLevel = num(structure.latest_event_level);
  const latestAge = structure.latest_event_time ? minutesBetween(now, structure.latest_event_time) : null;
  if (lower(structure.latest_event_type) === 'bos' && Number.isFinite(latestLevel) && aligned(structure.latest_event_direction) && (!Number.isFinite(latestAge) || latestAge <= 180)) {
    return latestLevel;
  }
  return null;
}

function buildBreakoutOption(market, data, inputs, session, settings, now) {
  const base = baseAsset(market, data);
  const bias = biasBase(data);
  if (!sourceRowUsable(inputs.sources.bias, data.bias) || !sourceRowUsable(inputs.sources.structure, data.structure)) return null;
  if (!bias.direction || bias.watchOnly || bias.score < settings.minimumDirectionalBias) return null;
  const direction = bias.direction;
  const level = breakoutLevel(direction, data.structure, now);
  if (!Number.isFinite(level) || !Number.isFinite(data.price)) return null;

  const stop = direction === 'buy'
    ? level - priceBuffer(market.symbol, level) * 1.35
    : level + priceBuffer(market.symbol, level) * 1.35;
  const targetData = {
    ...data,
    zones: sourceRowUsable(inputs.sources.zones, data.zones) ? data.zones : null,
    liquidity: sourceRowUsable(inputs.sources.liquidity, data.liquidity) ? data.liquidity : null
  };
  const target = bestTarget(direction, level, stop, targetData, settings.minimumPlannedRr);
  if (!target) return null;
  const proximity = classifyRetest(direction, market.symbol, data.price, level);
  if (['retest_failed', 'no_level'].includes(proximity.key)) return null;

  const structureScore = clamp(data.structure.score, 0, 100);
  const biasPoints = clamp(bias.score * 0.43, 0, 28);
  const structurePoints = clamp(10 + structureScore * 0.16, 10, 25);
  const targetPoints = clamp(target.quality * 0.08 + 2, 0, 10);
  const rrPoints = clamp(4 + (target.rr - settings.minimumPlannedRr) * 3, 4, 8);
  const zoneConfluence = (() => {
    if (!sourceRowUsable(inputs.sources.zones, data.zones)) return 2;
    if (direction === 'buy' && num(data.zones.demand_high) && level >= Number(data.zones.demand_high)) return 5;
    if (direction === 'sell' && num(data.zones.supply_low) && level <= Number(data.zones.supply_low)) return 5;
    return 3;
  })();
  const score = round(clamp(biasPoints + structurePoints + proximity.points + targetPoints + rrPoints + zoneConfluence + sessionFitPoints(session, market), 0, 100), 1);
  const status = proximity.key === 'touching' ? 'armed' : (['near', 'approaching'].includes(proximity.key) ? 'forming' : 'candidate');
  const action = status === 'armed'
    ? 'Price is retesting the broken level. Waiting for the next completed M5 candle to hold.'
    : status === 'forming'
      ? 'Price is coming back toward the broken level. The retest plan is ready.'
      : 'The break is valid, but price has not returned to the level yet.';

  return {
    ...base,
    direction,
    status,
    strategy_type: 'breakout_retest',
    session_name: session?.name || null,
    confluence_score: score,
    reason: `${direction.toUpperCase()} breakout and retest — Bias agrees with a recent BOS. ${action}`,
    zone_quality: 0,
    liquidity_quality: target.quality,
    planned_entry: level,
    target_price: target.price,
    stop_loss: stop,
    risk_amount: target.risk,
    reward_amount: target.reward,
    rr: target.rr,
    zone_state: proximity.key,
    target_source: target.source,
    sl_reason: 'Stop beyond the broken structure level.',
    raw: {
      ...base.raw,
      trade_engine: {
        strategy_type: 'breakout_retest',
        proximity,
        bos_level: level,
        event_age_minutes: eventAgeMinutes(data.structure, now),
        session: session?.key || null,
        planned_entry: level
      }
    }
  };
}

function buildMarketChoice(market, inputs, session, settings, now) {
  const data = marketData(inputs, market.symbol);
  const base = baseAsset(market, data);
  if (!marketIsOpen(market, data)) return { ...base, reason: 'Market is closed or the scanners report it unavailable.' };
  if (!Number.isFinite(data.price)) return { ...base, reason: 'Waiting for a current M5 price from the scanners.' };

  const bias = biasBase(data);
  if (!sourceRowUsable(inputs.sources.bias, data.bias)) return { ...base, reason: 'Bias data is missing or too old.' };
  if (!bias.direction || bias.watchOnly) return { ...base, reason: 'Bias has no clear buy or sell direction yet.' };
  if (bias.score < settings.minimumDirectionalBias) {
    return { ...base, direction: bias.direction, reason: `Bias direction exists, but strength is ${Math.round(bias.score)}%. Waiting for at least ${settings.minimumDirectionalBias}%.` };
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
      reason: `${bias.direction.toUpperCase()} bias is present, but no clean 1:${settings.minimumPlannedRr} pullback or breakout-retest plan is available.`
    };
  }
  options.sort((a, b) => Number(b.confluence_score) - Number(a.confluence_score));
  return options[0];
}

async function insertEvent(supabase, eventType, idea, message, raw = {}) {
  await supabase.from('eve_confluence_events').insert({
    event_type: eventType,
    symbol: idea?.symbol || null,
    idea_id: idea?.id || null,
    message,
    raw
  });
}

async function getOpenIdea(supabase) {
  const { data, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('*')
    .in('status', ['forming', 'armed', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function getIdea(supabase, id) {
  if (!id) return null;
  const { data, error } = await supabase.from('eve_confluence_trade_ideas').select('*').eq('id', id).maybeSingle();
  if (error) return null;
  return data || null;
}

async function getCurrentFocus(supabase) {
  const { data, error } = await supabase.from('eve_confluence_current_focus').select('*').eq('id', 'current').maybeSingle();
  if (error) return null;
  return data || null;
}

async function setFocus(supabase, fields) {
  const row = {
    id: 'current',
    symbol: fields.symbol ?? null,
    direction: fields.direction ?? null,
    status: fields.status || 'waiting',
    idea_id: fields.idea_id ?? null,
    confluence_score: fields.confluence_score || 0,
    reason: fields.reason || null,
    locked_at: fields.locked_at ?? null,
    lock_until: fields.lock_until ?? null,
    last_scan_id: fields.last_scan_id ?? null,
    last_scan_at: fields.last_scan_at || nowIso(),
    last_live_price: fields.last_live_price ?? null,
    last_live_at: fields.last_live_at ?? null,
    raw: fields.raw || {},
    updated_at: nowIso()
  };
  const { error } = await supabase.from('eve_confluence_current_focus').upsert(row);
  if (error) throw error;
}

async function updateIdea(supabase, id, patch) {
  const { data, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function closeIdea(supabase, idea, status, outcome, note, resultR = null) {
  const closed = await updateIdea(supabase, idea.id, {
    status,
    outcome,
    completed_at: nowIso(),
    result_r: Number.isFinite(Number(resultR)) ? Number(resultR) : null,
    latest_note: note,
    reason: note,
    last_checked_at: nowIso()
  });
  await insertEvent(supabase, `idea_${status}`, closed || idea, note, { result_r: resultR });
  return closed || { ...idea, status, outcome, latest_note: note };
}

function ideaStrategy(idea) {
  return idea.strategy_type || idea.raw?.trade_engine?.strategy_type || 'pullback';
}

function ideaTouchState(idea, price) {
  const strategy = ideaStrategy(idea);
  if (strategy === 'breakout_retest') {
    const level = num(idea.planned_entry ?? idea.forming_price);
    if (!Number.isFinite(level)) return false;
    const p = Number(price);
    const allowance = Math.max(priceBuffer(idea.symbol, p) * 1.6, Math.abs(level) * (['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(idea.symbol) ? 0.001 : 0.00035));
    return Math.abs(p - level) <= allowance;
  }
  if (idea.direction === 'buy') return Number(price) >= Number(idea.demand_low) && Number(price) <= Number(idea.demand_high);
  return Number(price) >= Number(idea.supply_low) && Number(price) <= Number(idea.supply_high);
}

function ideaConfirmed(idea, price) {
  const p = Number(price);
  const strategy = ideaStrategy(idea);
  if (strategy === 'breakout_retest') {
    const level = Number(idea.planned_entry ?? idea.forming_price);
    const confirmation = priceBuffer(idea.symbol, p) * 0.2;
    return idea.direction === 'buy' ? p > level + confirmation : p < level - confirmation;
  }
  return idea.direction === 'buy' ? p > Number(idea.demand_high) : p < Number(idea.supply_low);
}

async function manageOpenIdea(supabase, idea, inputs, now, settings) {
  if (!idea || !isOpenIdeaStatus(idea.status)) return { idea: null, closed: false };
  const data = marketData(inputs, idea.symbol);
  const price = num(data.price);
  if (!Number.isFinite(price)) {
    const updated = await updateIdea(supabase, idea.id, {
      latest_note: 'Waiting for the next completed M5 price from the scanners.',
      last_checked_at: now.toISOString()
    });
    return { idea: updated || idea, closed: false };
  }

  if (idea.status === 'active') {
    const won = idea.direction === 'buy' ? price >= Number(idea.take_profit) : price <= Number(idea.take_profit);
    const lost = idea.direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);
    if (won) {
      const closed = await closeIdea(supabase, idea, 'won', 'win', `TP HIT on completed M5 data at ${price}.`, Number(idea.rr || 0));
      return { idea: closed, closed: true };
    }
    if (lost) {
      const closed = await closeIdea(supabase, idea, 'lost', 'loss', `SL HIT on completed M5 data at ${price}.`, -1);
      return { idea: closed, closed: true };
    }
    const activeExpiry = idea.active_expires_at || addMinutes(new Date(idea.activated_at || idea.created_at), settings.activeExpiryMinutes);
    if (new Date(activeExpiry).getTime() <= now.getTime()) {
      const entry = Number(idea.entry_price);
      const risk = Number(idea.risk_amount || (idea.direction === 'buy' ? entry - Number(idea.stop_loss) : Number(idea.stop_loss) - entry));
      const move = idea.direction === 'buy' ? price - entry : entry - price;
      const resultR = risk > 0 ? move / risk : null;
      const closed = await closeIdea(supabase, idea, 'expired', 'expired', `Active trade expired at ${round(resultR || 0, 2)}R using the latest M5 close.`, resultR);
      return { idea: closed, closed: true };
    }
    const updated = await updateIdea(supabase, idea.id, {
      last_live_price: price,
      last_live_at: now.toISOString(),
      last_checked_at: now.toISOString(),
      active_expires_at: activeExpiry,
      latest_note: `ACTIVE — latest completed M5 price ${price}. Following until TP, SL or expiry.`
    });
    return { idea: updated || idea, closed: false };
  }

  const stopFailed = idea.direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);
  if (stopFailed) {
    const closed = await closeIdea(supabase, idea, 'invalidated_before_entry', 'invalidated_before_entry', `Setup invalidated before entry at ${price}.`, null);
    return { idea: closed, closed: true };
  }
  const targetTaken = idea.direction === 'buy' ? price >= Number(idea.take_profit) : price <= Number(idea.take_profit);
  if (targetTaken) {
    const closed = await closeIdea(supabase, idea, 'no_trigger', 'no_trigger', 'Target liquidity was taken before a confirmed entry. Do not chase.', null);
    return { idea: closed, closed: true };
  }
  if (idea.expires_at && new Date(idea.expires_at).getTime() <= now.getTime()) {
    const closed = await closeIdea(supabase, idea, 'expired', 'expired', 'Setup expired before a confirmed M5 entry.', null);
    return { idea: closed, closed: true };
  }

  const currentBias = directionFromBias(data.bias?.bias);
  const currentBiasScore = clamp(data.bias?.bias_score ?? data.bias?.score, 0, 100);
  if (sourceRowUsable(inputs.sources.bias, data.bias) && currentBias && currentBias !== idea.direction && currentBiasScore >= settings.minimumDirectionalBias) {
    const closed = await closeIdea(supabase, idea, 'invalidated_before_entry', 'invalidated_before_entry', `Bias flipped to ${currentBias.toUpperCase()} before entry.`, null);
    return { idea: closed, closed: true };
  }

  const touching = ideaTouchState(idea, price);
  if (touching && !idea.touched_zone) {
    const updated = await updateIdea(supabase, idea.id, {
      status: 'armed',
      armed_at: now.toISOString(),
      touched_zone: true,
      touched_zone_at: now.toISOString(),
      last_live_price: price,
      last_live_at: now.toISOString(),
      last_checked_at: now.toISOString(),
      latest_note: ideaStrategy(idea) === 'pullback'
        ? 'IN ZONE — waiting for the next completed M5 candle to reject it.'
        : 'RETEST TOUCHED — waiting for the next completed M5 candle to hold the broken level.'
    });
    await insertEvent(supabase, 'idea_armed', updated || idea, updated?.latest_note || 'Idea armed.');
    return { idea: updated || idea, closed: false };
  }

  const touchedLongEnough = idea.touched_zone && idea.touched_zone_at && minutesBetween(now, idea.touched_zone_at) >= 4;
  if (touchedLongEnough && ideaConfirmed(idea, price)) {
    const rr = rrFor(idea.direction, price, idea.stop_loss, idea.take_profit);
    if (rr.rr < settings.minimumConfirmedRr) {
      const closed = await closeIdea(supabase, idea, 'no_trigger', 'no_trigger', `Confirmation arrived too late. Live M5 entry R:R fell to 1:${round(rr.rr, 2)}. Do not chase.`, null);
      return { idea: closed, closed: true };
    }
    const updated = await updateIdea(supabase, idea.id, {
      status: 'active',
      activated_at: now.toISOString(),
      entry_price: price,
      risk_amount: rr.risk,
      reward_amount: rr.reward,
      rr: rr.rr,
      last_live_price: price,
      last_live_at: now.toISOString(),
      last_checked_at: now.toISOString(),
      active_expires_at: addMinutes(now, settings.activeExpiryMinutes),
      latest_note: `${idea.direction.toUpperCase()} NOW — completed M5 confirmation at ${price}. SL ${idea.stop_loss}. TP ${idea.take_profit}. R:R 1:${round(rr.rr, 2)}.`
    });
    await insertEvent(supabase, 'idea_active', updated || idea, updated?.latest_note || 'Idea active.');
    return { idea: updated || idea, closed: false };
  }

  const updated = await updateIdea(supabase, idea.id, {
    status: idea.touched_zone ? 'armed' : 'forming',
    last_live_price: price,
    last_live_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    latest_note: idea.touched_zone
      ? 'Touched entry area. Waiting for a completed M5 candle to move away in the trade direction.'
      : 'SETUP FORMING — waiting for price to reach the planned entry area.'
  });
  return { idea: updated || idea, closed: false };
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
  const payload = {
    symbol: option.symbol,
    direction: option.direction,
    status: armed ? 'armed' : 'forming',
    strategy_type: option.strategy_type,
    session_name: session.name,
    idea_score: option.confluence_score,
    execution_type: 'completed_m5_confirmation',
    focus_started_at: now.toISOString(),
    lock_until: addMinutes(now, settings.ideaExpiryMinutes),
    formed_at: now.toISOString(),
    armed_at: armed ? now.toISOString() : null,
    expires_at: addMinutes(now, settings.ideaExpiryMinutes),
    planned_entry: option.planned_entry,
    forming_price: option.latest_price,
    entry_price: null,
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
    last_live_price: option.latest_price,
    last_live_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    reason: option.reason,
    latest_note: armed
      ? 'Entry area reached. Waiting for the next completed M5 confirmation.'
      : 'Trade idea created. Waiting for price to reach the planned entry area.',
    raw: {
      trade_engine: {
        version: 13,
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
  await insertEvent(supabase, 'idea_created', data, `${option.symbol} ${option.direction.toUpperCase()} ${option.strategy_type.replaceAll('_', ' ')} idea created in the ${session.name} window.`, { score: option.confluence_score });
  return data;
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

async function runConfluenceScan(supabase, source = 'scheduled') {
  const now = new Date();
  const [scannerEnabled, minimumPlannedRr, minimumConfirmedRr, minimumIdeaScore, sourceMaxAgeMinutes, ideaExpiryMinutes, activeExpiryMinutes, cooldownMinutes, minimumDirectionalBias] = await Promise.all([
    getSetting(supabase, 'scanner_enabled', true),
    getSetting(supabase, 'minimum_rr', 2),
    getSetting(supabase, 'minimum_confirmed_rr', 1.5),
    getSetting(supabase, 'minimum_idea_score', DEFAULT_MIN_IDEA_SCORE),
    getSetting(supabase, 'source_max_age_minutes', DEFAULT_SOURCE_MAX_AGE_MINUTES),
    getSetting(supabase, 'idea_expiry_minutes', DEFAULT_IDEA_EXPIRY_MINUTES),
    getSetting(supabase, 'active_trade_expiry_minutes', DEFAULT_ACTIVE_EXPIRY_MINUTES),
    getSetting(supabase, 'same_symbol_direction_cooldown_minutes', DEFAULT_COOLDOWN_MINUTES),
    getSetting(supabase, 'minimum_directional_bias', MIN_DIRECTIONAL_BIAS)
  ]);
  const settings = {
    minimumPlannedRr,
    minimumConfirmedRr,
    minimumIdeaScore,
    sourceMaxAgeMinutes,
    ideaExpiryMinutes,
    activeExpiryMinutes,
    cooldownMinutes,
    minimumDirectionalBias
  };

  const { data: run, error: runError } = await supabase.from('eve_confluence_scan_runs').insert({
    started_at: now.toISOString(),
    mode: 'starting',
    scanner_enabled: scannerEnabled,
    source
  }).select('*').maybeSingle();
  if (runError) throw runError;

  if (!scannerEnabled) {
    await setFocus(supabase, {
      status: 'engine_off',
      reason: 'Trade Idea Engine is turned off.',
      last_scan_id: run.id,
      last_scan_at: now.toISOString()
    });
    const completedAt = nowIso();
    await supabase.from('eve_confluence_scan_runs').update({ completed_at: completedAt, mode: 'engine_off', notes: 'Scanner disabled.' }).eq('id', run.id);
    return { run: { ...run, completed_at: completedAt, mode: 'engine_off' }, selected: null, idea: null, assets: [], inputs: null, session: sessionState(now) };
  }

  const inputs = await loadInputs(supabase, now, sourceMaxAgeMinutes);
  let openIdea = await getOpenIdea(supabase);
  if (openIdea) {
    const managed = await manageOpenIdea(supabase, openIdea, inputs, now, settings);
    openIdea = managed.closed ? null : managed.idea;
  }

  const currentSession = sessionState(now);
  const assets = MARKETS.map((market) => buildMarketChoice(market, inputs, currentSession.active, settings, now))
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
      source_freshness: Object.fromEntries(Object.entries(inputs.sources).map(([key, value]) => [key, { isFresh: value.isFresh, ageMinutes: value.ageMinutes, run_id: value.run?.id || null }]))
    }
  }));
  if (scoreRows.length) {
    const { error } = await supabase.from('eve_confluence_asset_scores').insert(scoreRows);
    if (error) throw error;
  }

  let selected = null;
  let idea = openIdea;
  let mode = 'outside_session';
  let note = currentSession.is_open
    ? `No idea yet in the ${currentSession.active.name} window.`
    : 'Outside the London and New York idea windows. Existing ideas are still monitored.';

  if (openIdea) {
    selected = assets.find((asset) => asset.symbol === openIdea.symbol) || null;
    mode = `tracking_${openIdea.status}`;
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
      last_live_price: openIdea.last_live_price,
      last_live_at: openIdea.last_live_at,
      raw: { strategy_type: ideaStrategy(openIdea), session_name: openIdea.session_name }
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
      mode = `idea_${idea.status}`;
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
        last_live_price: idea.last_live_price,
        last_live_at: idea.last_live_at,
        raw: { strategy_type: idea.strategy_type, session_name: idea.session_name }
      });
    } else {
      const top = assets[0];
      mode = 'session_scanning';
      note = top?.status === 'candidate'
        ? `Best plan is ${top.symbol} ${top.direction.toUpperCase()} ${String(top.strategy_type || '').replaceAll('_', ' ')}, but price has not approached entry yet.`
        : 'No qualifying pullback or breakout-retest idea on this completed M5 scan.';
      await setFocus(supabase, {
        status: 'scanning',
        confluence_score: top?.confluence_score || 0,
        reason: note,
        last_scan_id: run.id,
        last_scan_at: now.toISOString(),
        raw: { top_candidate: top || null, session: currentSession.active }
      });
    }
  } else {
    await setFocus(supabase, {
      status: 'outside_session',
      reason: note,
      last_scan_id: run.id,
      last_scan_at: now.toISOString(),
      raw: { session_state: currentSession }
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

  return {
    run: { ...run, completed_at: completedAt, mode },
    selected,
    idea,
    assets,
    inputs,
    session: currentSession
  };
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
  if (error) return null;
  return data || null;
}

async function getLatestState(supabase) {
  const now = new Date();
  const maxAge = await getSetting(supabase, 'source_max_age_minutes', DEFAULT_SOURCE_MAX_AGE_MINUTES);
  const [latestRunRow, latestScoredRunRow, focus, recentIdeas, settings, inputs] = await Promise.all([
    latestRun(supabase, 'eve_confluence_scan_runs'),
    latestScoredRun(supabase),
    getCurrentFocus(supabase),
    supabase.from('eve_confluence_trade_ideas').select('*').order('created_at', { ascending: false }).limit(150),
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
    groups[key] ||= { name: key, total: 0, wins: 0, losses: 0, avgR: 0, r: [] };
    groups[key].total += 1;
    if (row.status === 'won') groups[key].wins += 1;
    if (row.status === 'lost') groups[key].losses += 1;
    if (Number.isFinite(Number(row.result_r))) groups[key].r.push(Number(row.result_r));
  }
  return Object.values(groups).map((group) => {
    const closed = group.wins + group.losses;
    group.winRate = closed ? group.wins / closed * 100 : 0;
    group.avgR = group.r.length ? group.r.reduce((sum, value) => sum + value, 0) / group.r.length : 0;
    delete group.r;
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
  const closed = wins + losses;
  const resultRs = all.map((idea) => Number(idea.result_r)).filter(Number.isFinite);
  return {
    totalIdeas: all.length,
    wins,
    losses,
    active,
    forming,
    noTrigger,
    winRate: closed ? wins / closed * 100 : 0,
    avgR: resultRs.length ? resultRs.reduce((sum, value) => sum + value, 0) / resultRs.length : 0,
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
  sessionState,
  activeSessionAt,
  buildMarketChoice
};
