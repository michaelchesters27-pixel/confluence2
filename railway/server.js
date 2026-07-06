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
  lastPrice: null,
  lastPriceAt: null,
  lastMessage: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  focusTimer: null,
  reconnects: 0,
  lastFocusRow: null,
  lastDesiredSymbol: null
};

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function nowIso() { return new Date().toISOString(); }
function tdUrl() { return `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normaliseSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function symbolsMatch(a, b) { return normaliseSymbol(a) === normaliseSymbol(b); }

async function logEvent(event_type, symbol, idea_id, message, raw = {}) {
  try {
    await supabase.from('eve_confluence_events').insert({ event_type, symbol, idea_id, message, raw });
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

function closeSocket(reason = 'switching') {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  if (state.ws) {
    try { state.ws.close(1000, reason); } catch (_) {}
  }
  state.ws = null;
}

function connectSymbol(symbol) {
  closeSocket('new focus');
  if (!symbol) {
    state.wsStatus = 'no_focus';
    state.lastPrice = null;
    state.lastPriceAt = null;
    updateFocusRailway('no_focus');
    return;
  }

  state.wsStatus = 'connecting';
  state.lastPrice = null;
  state.lastPriceAt = null;
  state.reconnects += 1;
  const ws = new WebSocket(tdUrl());
  state.ws = ws;

  ws.on('open', async () => {
    state.wsStatus = 'connected';
    const msg = { action: 'subscribe', params: { symbols: symbol } };
    ws.send(JSON.stringify(msg));
    state.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'heartbeat' }));
    }, 10_000);
    await updateFocusRailway('connected', { railway_symbol: symbol, last_live_price: null, last_live_at: null });
    await logEvent('railway_ws_connected', symbol, null, `Railway WebSocket connected to selected focus ${symbol}.`);
  });

  ws.on('message', async (raw) => {
    const text = raw.toString();
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    state.lastMessage = msg;
    if (msg.event === 'price' || msg.type === 'price' || (msg.symbol && msg.price)) {
      const price = num(msg.price);
      const eventSymbol = msg.symbol || msg.instrument || msg.instrument_name || null;

      // Critical guard: never attach a live price to the focus unless the
      // WebSocket message explicitly says it is the same symbol. This prevents
      // stale/cross-symbol prices such as EUR/USD being displayed as AUD/USD.
      if (!price || !eventSymbol || !symbolsMatch(eventSymbol, state.focusSymbol)) {
        console.warn('Ignoring mismatched/no-symbol WS price message', { focus: state.focusSymbol, eventSymbol, price });
        return;
      }

      await handlePrice(state.focusSymbol, price, msg);
    } else if (msg.event === 'subscribe-status' || msg.status) {
      state.wsStatus = 'subscribed';
      await updateFocusRailway('subscribed', { railway_symbol: symbol });
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
    state.wsStatus = state.focusSymbol === symbol ? 'closed' : state.wsStatus;
    if (state.focusSymbol === symbol) {
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

async function handlePrice(symbol, price, raw) {
  const now = nowIso();
  state.lastPrice = price;
  state.lastPriceAt = now;

  await supabase.from('eve_confluence_live_prices').upsert({
    symbol,
    price,
    event_time: raw.timestamp ? new Date(Number(raw.timestamp) * 1000).toISOString() : now,
    received_at: now,
    source: 'railway_twelvedata_ws',
    raw
  });

  await supabase.from('eve_confluence_current_focus').upsert({
    id: 'current',
    last_live_price: price,
    last_live_at: now,
    railway_status: 'live_price',
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
    status,
    last_live_price: price,
    last_live_at: now,
    railway_status: won ? 'idea_won' : 'idea_lost',
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
    lastPrice: state.lastPrice,
    lastPriceAt: state.lastPriceAt,
    reconnects: state.reconnects,
    dbFocusSymbol: state.lastFocusRow?.symbol || null,
    dbFocusStatus: state.lastFocusRow?.status || null,
    dbRailwaySymbol: state.lastFocusRow?.railway_symbol || null,
    dbUpdatedAt: state.lastFocusRow?.updated_at || null
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
