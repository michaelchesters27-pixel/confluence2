const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TWELVEDATA_API_KEY) throw new Error('Missing TWELVEDATA_API_KEY');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase variables');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
app.use(cors());
app.use(express.json());

const state = {
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
  lastDesiredSymbol: null
};

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function nowIso() { return new Date().toISOString(); }
function tdUrl() { return `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`; }
function restPriceUrl(symbol) { return `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normaliseSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function symbolsMatch(a, b) { return normaliseSymbol(a) === normaliseSymbol(b); }
function redact(obj) {
  try {
    const copy = JSON.parse(JSON.stringify(obj || {}));
    if (copy.apikey) copy.apikey = 'redacted';
    return copy;
  } catch (_) { return {}; }
}

async function logEvent(event_type, symbol, idea_id, message, raw = {}) {
  try {
    await supabase.from('eve_confluence_events').insert({ event_type, symbol, idea_id, message, raw: redact(raw) });
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
    await supabase.from('eve_confluence_current_focus').upsert(payload);
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
  if (msg.price !== undefined || msg.rate !== undefined || msg.value !== undefined) return [msg];
  return [];
}

function extractPrice(payload) {
  const price = num(payload.price ?? payload.rate ?? payload.value ?? payload.close ?? payload.last);
  const symbol = payload.symbol || payload.instrument || payload.instrument_name || payload.pair || payload.s || null;
  const timestamp = payload.timestamp || payload.datetime || payload.time || null;
  return { price, symbol, timestamp };
}

function eventTimeFromPayload(payload, fallbackNow) {
  const ts = payload.timestamp || payload.datetime || payload.time;
  if (!ts) return fallbackNow;
  if (typeof ts === 'number' || /^\d+$/.test(String(ts))) {
    const n = Number(ts);
    // Twelve Data normally sends seconds. If a provider sends ms, handle that too.
    return new Date(n > 10_000_000_000 ? n : n * 1000).toISOString();
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallbackNow : d.toISOString();
}

async function startRestFallback(symbol) {
  if (state.fallbackTimer) clearInterval(state.fallbackTimer);

  // One REST fallback shortly after subscribing fixes forex pairs that do not
  // send an immediate WebSocket tick. Then retry gently every 60s while focused.
  setTimeout(() => maybeFetchRestPrice(symbol, 'initial_fallback').catch((e) => console.error('initial fallback failed', e.message)), 8000);
  state.fallbackTimer = setInterval(() => {
    maybeFetchRestPrice(symbol, 'stale_or_missing_ws').catch((e) => console.error('rest fallback failed', e.message));
  }, 60_000);
}

async function maybeFetchRestPrice(symbol, reason) {
  if (!state.focusSymbol || !symbolsMatch(symbol, state.focusSymbol)) return;
  const nowMs = Date.now();
  const lastMs = state.lastPriceAt ? new Date(state.lastPriceAt).getTime() : 0;
  // If WebSocket or REST has updated within the last 50s, do not spend an API call.
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
  await handlePrice(symbol, price, { ...data, symbol, fallback_reason: reason }, 'railway_twelvedata_rest_fallback');
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
    const msg = { action: 'subscribe', params: { symbols: symbol } };
    ws.send(JSON.stringify(msg));
    state.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'heartbeat' }));
    }, 10_000);
    await updateFocusRailway('connected', { railway_symbol: symbol, last_live_price: null, last_live_at: null });
    await logEvent('railway_ws_connected', symbol, null, `Railway WebSocket connected to selected focus ${symbol}.`, { subscribe: msg });
    await startRestFallback(symbol);
  });

  ws.on('message', async (raw) => {
    const text = raw.toString();
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    state.lastMessage = redact(msg);

    if (msg.event === 'subscribe-status' || msg.status || msg.success || msg.fails) {
      state.lastSubscribeMessage = redact(msg);
      const hasFail = Boolean(msg.fails && (Array.isArray(msg.fails) ? msg.fails.length : Object.keys(msg.fails || {}).length));
      state.wsStatus = hasFail ? 'subscribe_failed' : 'subscribed';
      await updateFocusRailway(state.wsStatus, { railway_symbol: symbol });
      await logEvent(hasFail ? 'railway_ws_subscribe_failed' : 'railway_ws_subscribed', symbol, null, hasFail ? 'Twelve Data subscription returned a failure.' : `Subscribed to ${symbol}.`, msg);
      return;
    }

    const priceMessages = extractPriceMessages(msg);
    if (!priceMessages.length) return;

    for (const payload of priceMessages) {
      const { price, symbol: eventSymbol } = extractPrice(payload);
      if (!price || !eventSymbol || !symbolsMatch(eventSymbol, state.focusSymbol)) {
        state.lastRejectedMessage = { focus: state.focusSymbol, eventSymbol, price, payload: redact(payload) };
        console.warn('Ignoring mismatched/no-symbol WS price message', state.lastRejectedMessage);
        continue;
      }
      await handlePrice(state.focusSymbol, price, payload, 'railway_twelvedata_ws');
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

async function handlePrice(symbol, price, raw, source = 'railway_twelvedata_ws') {
  if (!state.focusSymbol || !symbolsMatch(symbol, state.focusSymbol)) return;
  const now = nowIso();
  state.lastPrice = price;
  state.lastPriceAt = now;
  state.lastPriceSource = source;
  if (source === 'railway_twelvedata_ws') state.lastWsPriceAt = now;

  await supabase.from('eve_confluence_live_prices').upsert({
    symbol,
    price,
    event_time: eventTimeFromPayload(raw, now),
    received_at: now,
    source,
    raw: redact(raw)
  });

  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    last_live_price: price,
    last_live_at: now,
    railway_status: source === 'railway_twelvedata_ws' ? 'live_price' : 'rest_fallback_price',
    railway_symbol: symbol,
    updated_at: now
  });

  await processTradeIdea(symbol, price, now);
}

async function processTradeIdea(symbol, price, now) {
  const { data: idea, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('*')
    .eq('symbol', symbol)
    .in('status', ['forming', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !idea) return;

  if (idea.status === 'forming') {
    await processFormingIdea(idea, price, now);
  } else if (idea.status === 'active') {
    await processActiveIdea(idea, price, now);
  }
}

async function processFormingIdea(idea, price, now) {
  const updates = { last_live_price: price, last_live_at: now, updated_at: now };
  const direction = idea.direction;

  const invalidated = direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);
  if (invalidated) {
    await supabase.from('eve_confluence_trade_ideas').update({
      ...updates,
      status: 'invalidated_before_entry',
      outcome: 'invalidated_before_entry',
      completed_at: now,
      result_r: 0,
      latest_note: 'Invalidation hit before confirmation. Not counted as an active trade loss.'
    }).eq('id', idea.id);
    await supabase.from('eve_confluence_current_focus').upsert({ id: 'current', status: 'no_trade', symbol: null, direction: null, idea_id: null, railway_symbol: null, railway_status: 'no_focus', reason: 'Idea invalidated before entry confirmation.', last_live_price: null, last_live_at: null, updated_at: now });
    await logEvent('idea_invalidated_before_entry', idea.symbol, idea.id, 'SL/invalidation was reached before entry confirmation.', { price });
    return;
  }

  let touched = Boolean(idea.touched_zone);
  if (direction === 'buy') {
    const demandHigh = Number(idea.demand_high);
    if (!touched && price <= demandHigh) touched = true;
    if (touched && price > demandHigh) {
      await activateIdea(idea, price, now, 'Market buy idea active after live reclaim from demand.');
      return;
    }
  } else {
    const supplyLow = Number(idea.supply_low);
    if (!touched && price >= supplyLow) touched = true;
    if (touched && price < supplyLow) {
      await activateIdea(idea, price, now, 'Market sell idea active after live rejection from supply.');
      return;
    }
  }

  if (touched !== idea.touched_zone) {
    updates.touched_zone = true;
    updates.touched_zone_at = now;
    updates.latest_note = 'Zone touched. Waiting for live confirmation/reclaim.';
  }
  await supabase.from('eve_confluence_trade_ideas').update(updates).eq('id', idea.id);
}

async function activateIdea(idea, entryPrice, now, note) {
  const risk = idea.direction === 'buy' ? entryPrice - Number(idea.stop_loss) : Number(idea.stop_loss) - entryPrice;
  const reward = idea.direction === 'buy' ? Number(idea.take_profit) - entryPrice : entryPrice - Number(idea.take_profit);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < 2) {
    await supabase.from('eve_confluence_trade_ideas').update({
      status: 'no_trigger',
      outcome: 'no_trigger',
      completed_at: now,
      result_r: 0,
      last_live_price: entryPrice,
      last_live_at: now,
      latest_note: `Confirmation appeared, but live R:R dropped to ${rr.toFixed(2)}. Minimum is 1:2. No trade.`,
      updated_at: now
    }).eq('id', idea.id);
    await supabase.from('eve_confluence_current_focus').upsert({ id: 'current', status: 'no_trade', symbol: null, direction: null, idea_id: null, railway_symbol: null, railway_status: 'no_focus', reason: 'Confirmation appeared but live R:R failed. No trade.', last_live_price: null, last_live_at: null, updated_at: now });
    await logEvent('idea_no_trigger_rr_failed', idea.symbol, idea.id, 'Confirmation appeared but live R:R failed.', { entryPrice, rr });
    return;
  }

  await supabase.from('eve_confluence_trade_ideas').update({
    status: 'active',
    activated_at: now,
    entry_price: entryPrice,
    risk_amount: risk,
    reward_amount: reward,
    rr,
    last_live_price: entryPrice,
    last_live_at: now,
    latest_note: note,
    updated_at: now
  }).eq('id', idea.id);

  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    symbol: idea.symbol,
    direction: idea.direction,
    status: 'active',
    idea_id: idea.id,
    last_live_price: entryPrice,
    last_live_at: now,
    railway_status: 'idea_active',
    railway_symbol: idea.symbol,
    reason: 'Confirmed active trade idea. Following until TP or SL.',
    updated_at: now
  });
  await logEvent('idea_active', idea.symbol, idea.id, note, { entryPrice, rr });
}

async function processActiveIdea(idea, price, now) {
  const won = idea.direction === 'buy' ? price >= Number(idea.take_profit) : price <= Number(idea.take_profit);
  const lost = idea.direction === 'buy' ? price <= Number(idea.stop_loss) : price >= Number(idea.stop_loss);
  if (!won && !lost) {
    await supabase.from('eve_confluence_trade_ideas').update({ last_live_price: price, last_live_at: now, updated_at: now }).eq('id', idea.id);
    return;
  }
  const status = won ? 'won' : 'lost';
  const resultR = won ? Number(idea.rr || 0) : -1;
  await supabase.from('eve_confluence_trade_ideas').update({
    status,
    outcome: won ? 'win' : 'loss',
    result_r: resultR,
    completed_at: now,
    last_live_price: price,
    last_live_at: now,
    latest_note: won ? 'TP reached before SL.' : 'SL reached before TP.',
    updated_at: now
  }).eq('id', idea.id);
  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    symbol: null,
    direction: null,
    status: status,
    idea_id: null,
    reason: won ? 'Trade idea won. TP reached first.' : 'Trade idea lost. SL reached first.',
    last_live_price: null,
    last_live_at: null,
    railway_status: 'no_focus',
    railway_symbol: null,
    updated_at: now
  });
  await logEvent(won ? 'idea_won' : 'idea_lost', idea.symbol, idea.id, won ? 'TP reached first.' : 'SL reached first.', { price });
}

function desiredSymbolFromFocus(focus) {
  if (!focus || !focus.symbol) return null;
  const status = String(focus.status || '').toLowerCase();
  // Only stream a real focus idea. Closed/no-trade focus must disconnect.
  if (!['forming', 'active'].includes(status)) return null;
  return focus.symbol;
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
  res.json({ ok: true, name: 'EVE Confluence Railway WebSocket Hub', focusSymbol: state.focusSymbol, wsStatus: state.wsStatus });
});

app.listen(PORT, async () => {
  console.log(`EVE Confluence Railway hub listening on ${PORT}`);
  await sleep(1500);
  await pollFocusLoop();
  state.focusTimer = setInterval(pollFocusLoop, 3_000);
});

process.on('SIGTERM', () => {
  closeSocket('shutdown');
  process.exit(0);
});
