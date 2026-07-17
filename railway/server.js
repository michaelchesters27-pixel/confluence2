const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TWELVEDATA_API_KEY) throw new Error('Missing TWELVEDATA_API_KEY');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
app.use(cors());
app.use(express.json());

const state = {
  version: '14.3',
  focusSymbol: null,
  focusDirection: null,
  ws: null,
  wsStatus: 'starting',
  subscribedSymbol: null,
  lastPrice: null,
  lastPriceAt: null,
  lastPriceSource: null,
  lastWsPriceAt: null,
  lastMessage: null,
  lastSubscribeMessage: null,
  lastRejectedMessage: null,
  lastRestFallbackAt: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  focusTimer: null,
  fallbackTimer: null,
  reconnects: 0,
  lastFocusRow: null,
  lastDesiredSymbol: null,
  priceQueue: Promise.resolve()
};

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function nowIso() { return new Date().toISOString(); }
function addMinutesIso(isoOrDate, minutes) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return new Date(d.getTime() + Number(minutes) * 60_000).toISOString();
}
function elapsedSeconds(a, b) { return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 1000); }
function normaliseSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function symbolsMatch(a, b) { return Boolean(a && b && normaliseSymbol(a) === normaliseSymbol(b)); }
function tdUrl() { return `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`; }
function restPriceUrl(symbol) { return `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function round(value, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * p) / p;
}

function storedPlanMetrics(idea) {
  const entry = Number(idea?.planned_entry ?? idea?.entry_price);
  const stop = Number(idea?.stop_loss);
  const target = Number(idea?.take_profit);
  if (![entry, stop, target].every(Number.isFinite) || entry <= 0 || stop <= 0 || target <= 0) {
    return { valid: false, reason: 'Entry, stop and target must all be positive prices.', entry, stop, target, risk: 0, reward: 0, rr: 0 };
  }
  const risk = idea.direction === 'buy' ? entry - stop : stop - entry;
  const reward = idea.direction === 'buy' ? target - entry : entry - target;
  const rr = risk > 0 ? reward / risk : 0;
  const valid = risk > 0 && reward > 0 && rr > 0 && rr <= 25;
  return { valid, reason: valid ? null : 'Stored entry, stop or target is on the wrong side or produces an unrealistic R:R.', entry, stop, target, risk, reward, rr };
}
function redact(obj) {
  try {
    const copy = JSON.parse(JSON.stringify(obj || {}));
    if (copy.apikey) copy.apikey = 'redacted';
    return copy;
  } catch (_) { return {}; }
}

async function getSetting(key, fallback) {
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

async function logEvent(eventType, symbol, ideaId, message, raw = {}) {
  try {
    const { error } = await supabase.from('eve_confluence_events').insert({
      event_type: eventType,
      symbol: symbol || null,
      idea_id: ideaId || null,
      message,
      raw: redact(raw)
    });
    if (error) console.error('event log failed', error.message);
  } catch (err) {
    console.error('event log failed', err.message);
  }
}

async function updateFocusRailway(status, extra = {}) {
  try {
    const payload = {
      id: 'current',
      railway_status: status,
      railway_symbol: state.focusSymbol || null,
      updated_at: nowIso(),
      ...extra
    };
    if (!state.focusSymbol) {
      payload.railway_symbol = null;
      payload.last_live_price = null;
      payload.last_live_at = null;
    }
    const { error } = await supabase.from('eve_confluence_current_focus').upsert(payload);
    if (error) console.error('focus railway update failed', error.message);
  } catch (err) {
    console.error('focus railway update failed', err.message);
  }
}

async function readFocus() {
  const { data, error } = await supabase.from('eve_confluence_current_focus').select('*').eq('id', 'current').maybeSingle();
  if (error) throw error;
  return data || null;
}

function clearTimers() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.fallbackTimer) clearInterval(state.fallbackTimer);
  state.reconnectTimer = null;
  state.heartbeatTimer = null;
  state.fallbackTimer = null;
}

function closeSocket(reason = 'switching') {
  clearTimers();
  if (state.ws) {
    try { state.ws.close(1000, reason); } catch (_) {}
  }
  state.ws = null;
  state.subscribedSymbol = null;
}

function resetLiveState() {
  state.lastPrice = null;
  state.lastPriceAt = null;
  state.lastPriceSource = null;
  state.lastWsPriceAt = null;
  state.lastMessage = null;
  state.lastSubscribeMessage = null;
  state.lastRejectedMessage = null;
  state.lastRestFallbackAt = null;
}

function extractPriceMessages(msg) {
  if (!msg) return [];
  if (Array.isArray(msg)) return msg.flatMap(extractPriceMessages);
  if (Array.isArray(msg.data)) return msg.data.flatMap(extractPriceMessages);
  if (msg.data && typeof msg.data === 'object') return extractPriceMessages(msg.data);
  if (msg.price !== undefined || msg.rate !== undefined || msg.value !== undefined || msg.close !== undefined || msg.last !== undefined) return [msg];
  return [];
}

function extractPrice(payload) {
  const price = num(payload.price ?? payload.rate ?? payload.value ?? payload.close ?? payload.last);
  const symbol = payload.symbol || payload.instrument || payload.instrument_name || payload.pair || payload.s || null;
  return { price, symbol };
}

function eventTimeFromPayload(payload, fallbackNow) {
  const ts = payload.timestamp || payload.datetime || payload.time;
  if (!ts) return fallbackNow;
  if (typeof ts === 'number' || /^\d+$/.test(String(ts))) {
    const n = Number(ts);
    return new Date(n > 10_000_000_000 ? n : n * 1000).toISOString();
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallbackNow : d.toISOString();
}

async function startRestFallback(symbol) {
  if (state.fallbackTimer) clearInterval(state.fallbackTimer);
  setTimeout(() => maybeFetchRestPrice(symbol, 'initial_fallback').catch((e) => console.error('initial fallback failed', e.message)), 8000);
  state.fallbackTimer = setInterval(() => {
    maybeFetchRestPrice(symbol, 'stale_or_missing_ws').catch((e) => console.error('rest fallback failed', e.message));
  }, 60_000);
}

async function maybeFetchRestPrice(symbol, reason) {
  if (!state.focusSymbol || !symbolsMatch(symbol, state.focusSymbol)) return;
  const nowMs = Date.now();
  const lastMs = state.lastPriceAt ? new Date(state.lastPriceAt).getTime() : 0;
  if (lastMs && nowMs - lastMs < 50_000) return;

  const res = await fetch(restPriceUrl(symbol));
  const data = await res.json().catch(() => ({}));
  state.lastRestFallbackAt = nowIso();
  if (!res.ok || data.status === 'error' || data.code || data.message) {
    state.lastRejectedMessage = { source: 'rest_fallback', status: res.status, data };
    await logEvent('railway_rest_price_error', symbol, null, data.message || `REST price failed ${res.status}`, { reason, data });
    return;
  }
  const price = num(data.price);
  if (!price) {
    state.lastRejectedMessage = { source: 'rest_fallback', data };
    await logEvent('railway_rest_price_empty', symbol, null, 'REST fallback returned no usable price.', { reason, data });
    return;
  }
  enqueuePrice(symbol, price, { ...data, symbol, fallback_reason: reason }, 'railway_twelvedata_rest_fallback');
}

function connectSymbol(symbol) {
  closeSocket('new focus');
  resetLiveState();

  if (!symbol) {
    state.focusSymbol = null;
    state.focusDirection = null;
    state.wsStatus = 'no_focus';
    updateFocusRailway('no_focus');
    return;
  }

  state.wsStatus = 'connecting';
  state.subscribedSymbol = symbol;
  state.reconnects += 1;
  const ws = new WebSocket(tdUrl());
  state.ws = ws;

  ws.on('open', async () => {
    if (!symbolsMatch(symbol, state.focusSymbol)) return;
    state.wsStatus = 'connected';
    const message = { action: 'subscribe', params: { symbols: symbol } };
    ws.send(JSON.stringify(message));
    state.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'heartbeat' }));
    }, 10_000);
    await updateFocusRailway('connected', { railway_symbol: symbol });
    await logEvent('railway_ws_connected', symbol, null, `Railway connected to the selected focus ${symbol}.`, { subscribe: message });
    await startRestFallback(symbol);
  });

  ws.on('message', (raw) => {
    const text = raw.toString();
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }
    state.lastMessage = redact(message);

    if (message.event === 'subscribe-status' || message.status || message.success || message.fails) {
      state.lastSubscribeMessage = redact(message);
      const hasFail = Boolean(message.fails && (Array.isArray(message.fails) ? message.fails.length : Object.keys(message.fails || {}).length));
      state.wsStatus = hasFail ? 'subscribe_failed' : 'subscribed';
      updateFocusRailway(state.wsStatus, { railway_symbol: symbol });
      logEvent(hasFail ? 'railway_ws_subscribe_failed' : 'railway_ws_subscribed', symbol, null, hasFail ? 'Twelve Data subscription returned a failure.' : `Subscribed to ${symbol}.`, message);
      return;
    }

    const messages = extractPriceMessages(message);
    for (const payload of messages) {
      const { price, symbol: eventSymbol } = extractPrice(payload);
      if (!price || !eventSymbol || !symbolsMatch(eventSymbol, state.focusSymbol)) {
        state.lastRejectedMessage = { focus: state.focusSymbol, eventSymbol, price, payload: redact(payload) };
        continue;
      }
      enqueuePrice(state.focusSymbol, price, payload, 'railway_twelvedata_ws');
    }
  });

  ws.on('error', async (err) => {
    console.error('Twelve Data WS error', err.message);
    state.wsStatus = 'error';
    await updateFocusRailway('error');
    await logEvent('railway_ws_error', symbol, null, err.message);
  });

  ws.on('close', async () => {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    if (state.focusSymbol && symbolsMatch(state.focusSymbol, symbol)) {
      state.wsStatus = 'closed';
      await updateFocusRailway('closed');
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(async () => {
        const focus = await readFocus().catch(() => null);
        const desired = desiredSymbolFromFocus(focus);
        if (desired && symbolsMatch(desired, symbol)) connectSymbol(symbol);
      }, 4000);
    }
  });
}

function enqueuePrice(symbol, price, raw, source) {
  state.priceQueue = state.priceQueue
    .then(() => handlePrice(symbol, price, raw, source))
    .catch((err) => console.error('price processing failed', err.message));
}

async function handlePrice(symbol, price, raw, source = 'railway_twelvedata_ws') {
  if (!state.focusSymbol || !symbolsMatch(symbol, state.focusSymbol)) return;
  const now = nowIso();
  state.lastPrice = price;
  state.lastPriceAt = now;
  state.lastPriceSource = source;
  if (source === 'railway_twelvedata_ws') state.lastWsPriceAt = now;

  const { error: liveError } = await supabase.from('eve_confluence_live_prices').upsert({
    symbol,
    price,
    event_time: eventTimeFromPayload(raw, now),
    received_at: now,
    source,
    raw: redact(raw)
  });
  if (liveError) console.error('live price write failed', liveError.message);

  await updateFocusRailway(source === 'railway_twelvedata_ws' ? 'live_price' : 'rest_fallback_price', {
    railway_symbol: symbol,
    last_live_price: price,
    last_live_at: now
  });

  await processTradeIdea(symbol, price, now);
}

async function processTradeIdea(symbol, price, now) {
  const { data: idea, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('*')
    .eq('symbol', symbol)
    .in('status', ['forming', 'armed', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !idea) return;

  if (idea.status === 'forming') await processFormingIdea(idea, price, now);
  else if (idea.status === 'armed') await processArmedIdea(idea, price, now);
  else if (idea.status === 'active') await processActiveIdea(idea, price, now);
}

function beforeEntryTerminal(idea, price, now) {
  const plan = storedPlanMetrics(idea);
  if (!plan.valid) {
    return { status: 'no_trigger', note: `Malformed trade plan rejected: ${plan.reason}` };
  }
  if (idea.expires_at && new Date(idea.expires_at).getTime() <= new Date(now).getTime()) {
    return { status: 'expired', note: 'Setup expired before live activation.' };
  }
  const invalidated = idea.direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);
  if (invalidated) return { status: 'invalidated_before_entry', note: 'SL/invalidation was reached before activation.' };
  const targetTaken = idea.direction === 'buy' ? price >= Number(idea.take_profit) : price <= Number(idea.take_profit);
  if (targetTaken) return { status: 'no_trigger', note: 'Target was reached before activation. DO NOT CHASE.' };
  return null;
}

function ideaTouched(idea, price) {
  if (idea.direction === 'buy') {
    const high = num(idea.demand_high);
    return Number.isFinite(high) && price <= high;
  }
  const low = num(idea.supply_low);
  return Number.isFinite(low) && price >= low;
}

function nextExtreme(direction, currentExtreme, price) {
  const existing = num(currentExtreme);
  if (!Number.isFinite(existing)) return price;
  return direction === 'buy' ? Math.min(existing, price) : Math.max(existing, price);
}

async function processFormingIdea(idea, price, now) {
  const terminal = beforeEntryTerminal(idea, price, now);
  if (terminal) {
    await closeBeforeEntry(idea, price, now, terminal.status, terminal.note);
    return;
  }

  if (!ideaTouched(idea, price)) {
    await supabase.from('eve_confluence_trade_ideas').update({
      last_live_price: price,
      last_live_at: now,
      last_checked_at: now,
      latest_note: `WATCHING — live price ${price}. Waiting for the entry area.`,
      updated_at: now
    }).eq('id', idea.id);
    return;
  }

  const armedMinutes = await getSetting('armed_confirmation_minutes', 30);
  const expiry = addMinutesIso(now, armedMinutes);
  const extreme = nextExtreme(idea.direction, idea.touch_extreme_price, price);
  await supabase.from('eve_confluence_trade_ideas').update({
    status: 'armed',
    touched_zone: true,
    touched_zone_at: idea.touched_zone_at || now,
    touch_extreme_price: extreme,
    armed_at: idea.armed_at || now,
    confirm_started_at: null,
    confirmation_tick_count: 0,
    expires_at: expiry,
    lock_until: expiry,
    last_live_price: price,
    last_live_at: now,
    last_checked_at: now,
    latest_note: `GET READY — entry area touched. Waiting for one live reclaim/rejection through ${idea.planned_entry}.`,
    updated_at: now
  }).eq('id', idea.id);

  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    symbol: idea.symbol,
    direction: idea.direction,
    status: 'armed',
    idea_id: idea.id,
    reason: `Entry area touched. Live trigger is ${idea.planned_entry}.`,
    lock_until: expiry,
    last_live_price: price,
    last_live_at: now,
    railway_status: 'idea_armed',
    railway_symbol: idea.symbol,
    updated_at: now
  });
  await logEvent('idea_armed', idea.symbol, idea.id, 'Entry area touched. Railway is waiting for one live reclaim/rejection trigger.', { price, planned_entry: idea.planned_entry, extreme });
}

async function processArmedIdea(idea, price, now) {
  const terminal = beforeEntryTerminal(idea, price, now);
  if (terminal) {
    await closeBeforeEntry(idea, price, now, terminal.status, terminal.note);
    return;
  }

  const extreme = nextExtreme(idea.direction, idea.touch_extreme_price, price);
  const triggered = idea.direction === 'buy' ? price >= Number(idea.planned_entry) : price <= Number(idea.planned_entry);
  if (!triggered) {
    await supabase.from('eve_confluence_trade_ideas').update({
      touch_extreme_price: extreme,
      confirmation_tick_count: 0,
      confirm_started_at: null,
      last_live_price: price,
      last_live_at: now,
      last_checked_at: now,
      latest_note: `GET READY — zone/retest touched. Waiting for live ${idea.direction === 'buy' ? 'reclaim above' : 'rejection below'} ${idea.planned_entry}.`,
      updated_at: now
    }).eq('id', idea.id);
    return;
  }

  const requiredTicks = Math.max(1, Math.round(await getSetting('confirmation_ticks', 2)));
  const minimumSeconds = Math.max(0, await getSetting('confirmation_min_seconds', 2));
  const count = Number(idea.confirmation_tick_count || 0) + 1;
  const startedAt = idea.confirm_started_at || now;
  const seconds = elapsedSeconds(startedAt, now);

  if (count < requiredTicks || seconds < minimumSeconds) {
    await supabase.from('eve_confluence_trade_ideas').update({
      touch_extreme_price: extreme,
      confirmation_tick_count: count,
      confirm_started_at: startedAt,
      last_live_price: price,
      last_live_at: now,
      last_checked_at: now,
      latest_note: `LIVE TRIGGER SEEN — confirming ${count}/${requiredTicks} ticks (${round(seconds, 1)}s/${minimumSeconds}s).`,
      updated_at: now
    }).eq('id', idea.id);
    return;
  }

  await activateIdea(idea, price, now, extreme);
}

async function activateIdea(idea, triggerPrice, now, extreme) {
  const plan = storedPlanMetrics(idea);
  const plannedEntry = plan.entry;
  const stop = plan.stop;
  const target = plan.target;
  const risk = plan.risk;
  const reward = plan.reward;
  const rr = plan.rr;
  const slippage = idea.direction === 'buy' ? Math.max(0, triggerPrice - plannedEntry) : Math.max(0, plannedEntry - triggerPrice);
  const maxSlippageFraction = Math.max(0, await getSetting('max_entry_slippage_risk_fraction', 0.15));
  const minimumRr = Math.max(1, await getSetting('minimum_rr', 2));
  const maximumRr = Math.max(minimumRr, await getSetting('maximum_planned_rr', 25));

  if (!plan.valid || risk <= 0 || reward <= 0 || rr < minimumRr || rr > maximumRr) {
    await closeBeforeEntry(idea, triggerPrice, now, 'no_trigger', `Stored trade plan must be between 1:${minimumRr} and 1:${maximumRr}. No trade.`);
    return;
  }
  if (slippage > risk * maxSlippageFraction) {
    await closeBeforeEntry(idea, triggerPrice, now, 'no_trigger', `Live price jumped too far through the trigger (${round(slippage / risk, 2)}R slippage). DO NOT CHASE.`);
    return;
  }

  const activeMinutes = await getSetting('active_trade_expiry_minutes', 360);
  const activeExpiry = addMinutesIso(now, activeMinutes);
  const note = `${idea.direction === 'buy' ? 'BUY NOW' : 'SELL NOW'} — live zone reaction confirmed. Entry ${plannedEntry}, SL ${stop}, TP ${target}, R:R 1:${round(rr, 2)}.`;

  await supabase.from('eve_confluence_trade_ideas').update({
    status: 'active',
    activated_at: now,
    entry_price: plannedEntry,
    trigger_price: triggerPrice,
    confirmation_price: triggerPrice,
    confirmation_tick_count: Number(idea.confirmation_tick_count || 0) + 1,
    touch_extreme_price: extreme,
    risk_amount: risk,
    reward_amount: reward,
    rr,
    active_expires_at: activeExpiry,
    lock_until: activeExpiry,
    max_favourable_price: plannedEntry,
    max_adverse_price: plannedEntry,
    best_r: 0,
    worst_r: 0,
    last_live_price: triggerPrice,
    last_live_at: now,
    last_checked_at: now,
    latest_note: note,
    updated_at: now
  }).eq('id', idea.id);

  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    symbol: idea.symbol,
    direction: idea.direction,
    status: 'active',
    idea_id: idea.id,
    lock_until: activeExpiry,
    last_live_price: triggerPrice,
    last_live_at: now,
    railway_status: 'idea_active',
    railway_symbol: idea.symbol,
    reason: note,
    updated_at: now
  });
  await logEvent('idea_active', idea.symbol, idea.id, note, { plannedEntry, triggerPrice, slippage, rr, extreme });
}

function excursionMetrics(idea, price) {
  const entry = Number(idea.entry_price);
  const risk = Number(idea.risk_amount);
  if (!Number.isFinite(entry) || !Number.isFinite(risk) || risk <= 0) return {};
  const oldFav = num(idea.max_favourable_price) ?? entry;
  const oldAdv = num(idea.max_adverse_price) ?? entry;
  const maxFavourablePrice = idea.direction === 'buy' ? Math.max(oldFav, price) : Math.min(oldFav, price);
  const maxAdversePrice = idea.direction === 'buy' ? Math.min(oldAdv, price) : Math.max(oldAdv, price);
  const favourableMove = idea.direction === 'buy' ? maxFavourablePrice - entry : entry - maxFavourablePrice;
  const adverseMove = idea.direction === 'buy' ? maxAdversePrice - entry : entry - maxAdversePrice;
  return {
    max_favourable_price: maxFavourablePrice,
    max_adverse_price: maxAdversePrice,
    best_r: favourableMove / risk,
    worst_r: adverseMove / risk
  };
}

async function processActiveIdea(idea, price, now) {
  const metrics = excursionMetrics(idea, price);
  const won = idea.direction === 'buy' ? price >= Number(idea.take_profit) : price <= Number(idea.take_profit);
  const lost = idea.direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);

  if (won || lost) {
    const status = won ? 'won' : 'lost';
    const resultR = won ? Number(idea.rr || 0) : -1;
    const note = won ? `TP HIT at ${price}. Trade completed +${round(resultR, 2)}R.` : `SL HIT at ${price}. Trade completed -1R.`;
    await supabase.from('eve_confluence_trade_ideas').update({
      status,
      outcome: won ? 'win' : 'loss',
      result_r: resultR,
      completed_at: now,
      last_live_price: price,
      last_live_at: now,
      last_checked_at: now,
      latest_note: note,
      ...metrics,
      updated_at: now
    }).eq('id', idea.id);
    await clearFocusAfterClose(idea, status, note, now);
    await logEvent(won ? 'idea_won' : 'idea_lost', idea.symbol, idea.id, note, { price, resultR, ...metrics });
    return;
  }

  const expiry = idea.active_expires_at;
  if (expiry && new Date(expiry).getTime() <= new Date(now).getTime()) {
    const entry = Number(idea.entry_price);
    const risk = Number(idea.risk_amount);
    const move = idea.direction === 'buy' ? price - entry : entry - price;
    const resultR = risk > 0 ? move / risk : null;
    const outcome = Math.abs(Number(resultR || 0)) <= 0.05 ? 'break_even' : 'time_exit';
    const note = `Active trade time-exit at ${round(resultR || 0, 2)}R using live price ${price}.`;
    await supabase.from('eve_confluence_trade_ideas').update({
      status: 'closed',
      outcome,
      result_r: resultR,
      completed_at: now,
      last_live_price: price,
      last_live_at: now,
      last_checked_at: now,
      latest_note: note,
      ...metrics,
      updated_at: now
    }).eq('id', idea.id);
    await clearFocusAfterClose(idea, 'closed', note, now);
    await logEvent('idea_time_exit', idea.symbol, idea.id, note, { price, resultR, ...metrics });
    return;
  }

  const entry = Number(idea.entry_price);
  const risk = Number(idea.risk_amount);
  const currentR = risk > 0 ? (idea.direction === 'buy' ? price - entry : entry - price) / risk : 0;
  await supabase.from('eve_confluence_trade_ideas').update({
    last_live_price: price,
    last_live_at: now,
    last_checked_at: now,
    latest_note: `ACTIVE — live ${round(currentR, 2)}R. Following until TP, SL or expiry.`,
    ...metrics,
    updated_at: now
  }).eq('id', idea.id);
}

async function closeBeforeEntry(idea, price, now, status, note) {
  await supabase.from('eve_confluence_trade_ideas').update({
    status,
    outcome: status,
    completed_at: now,
    result_r: null,
    last_live_price: price,
    last_live_at: now,
    last_checked_at: now,
    latest_note: note,
    updated_at: now
  }).eq('id', idea.id);
  await clearFocusAfterClose(idea, status, note, now);
  await logEvent(`idea_${status}`, idea.symbol, idea.id, note, { price });
}

async function clearFocusAfterClose(idea, status, note, now) {
  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    status,
    symbol: null,
    direction: null,
    idea_id: null,
    confluence_score: 0,
    railway_symbol: null,
    railway_status: 'no_focus',
    reason: note,
    locked_at: null,
    lock_until: null,
    last_live_price: null,
    last_live_at: null,
    raw: { completed_idea_id: idea.id, completed_symbol: idea.symbol, completed_status: status },
    updated_at: now
  });
}

function desiredSymbolFromFocus(focus) {
  if (!focus || !focus.symbol) return null;
  const status = String(focus.status || '').toLowerCase();
  return ['forming', 'armed', 'active'].includes(status) ? focus.symbol : null;
}

async function pollFocusLoop() {
  try {
    const focus = await readFocus();
    state.lastFocusRow = focus;
    const symbol = desiredSymbolFromFocus(focus);
    const direction = symbol ? (focus?.direction || null) : null;
    if (!symbolsMatch(symbol, state.focusSymbol)) {
      console.log('Focus sync', { previous: state.focusSymbol, next: symbol, dbSymbol: focus?.symbol, dbStatus: focus?.status });
      state.focusSymbol = symbol;
      state.focusDirection = direction;
      state.lastDesiredSymbol = symbol;
      connectSymbol(symbol);
    } else if (!symbol && state.wsStatus !== 'no_focus') {
      state.focusSymbol = null;
      state.focusDirection = null;
      connectSymbol(null);
    }
  } catch (err) {
    console.error('focus poll failed', err.message);
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: state.version,
    role: 'single-focus-live-manager',
    focusSymbol: state.focusSymbol,
    focusDirection: state.focusDirection,
    wsStatus: state.wsStatus,
    subscribedSymbol: state.subscribedSymbol,
    lastPrice: state.lastPrice,
    lastPriceAt: state.lastPriceAt,
    lastPriceSource: state.lastPriceSource,
    lastWsPriceAt: state.lastWsPriceAt,
    lastRestFallbackAt: state.lastRestFallbackAt,
    reconnects: state.reconnects,
    dbFocusSymbol: state.lastFocusRow?.symbol || null,
    dbFocusStatus: state.lastFocusRow?.status || null,
    dbRailwaySymbol: state.lastFocusRow?.railway_symbol || null,
    dbUpdatedAt: state.lastFocusRow?.updated_at || null,
    lastSubscribeMessage: state.lastSubscribeMessage,
    lastRejectedMessage: state.lastRejectedMessage
  });
});

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'EVE Confluence Railway Live Manager', version: state.version, focusSymbol: state.focusSymbol, wsStatus: state.wsStatus });
});

app.listen(PORT, async () => {
  console.log(`EVE Confluence Railway v14.3 listening on ${PORT}`);
  await sleep(1500);
  await pollFocusLoop();
  state.focusTimer = setInterval(pollFocusLoop, 3_000);
});

process.on('SIGTERM', () => {
  closeSocket('shutdown');
  process.exit(0);
});
