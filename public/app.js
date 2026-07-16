const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  adminPassword: sessionStorage.getItem('eve_admin_password_session') || '',
  loading: false
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatPrice(value, symbol) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  if (String(symbol).includes('JPY')) return number.toFixed(3);
  if (symbol === 'XAU/USD' || symbol === 'XAG/USD') return number.toFixed(2);
  if (symbol === 'BTC/USD') return number.toFixed(0);
  if (symbol === 'ETH/USD') return number.toFixed(1);
  if (symbol === 'SOL/USD') return number.toFixed(2);
  return number.toFixed(5);
}

function formatTime(value, options = {}) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: options.timeZone || 'Europe/London',
    weekday: options.weekday ? 'short' : undefined,
    day: options.day ? '2-digit' : undefined,
    month: options.day ? 'short' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function statusLabel(status) {
  const labels = {
    no_trade: 'NO SETUP',
    candidate: 'WATCHING',
    forming: 'SETUP FORMING',
    armed: 'ENTRY AREA TOUCHED',
    active: 'ACTIVE',
    won: 'TP HIT',
    lost: 'SL HIT',
    no_trigger: 'NO TRIGGER',
    invalidated_before_entry: 'INVALIDATED',
    expired: 'EXPIRED',
    cancelled: 'CANCELLED',
    outside_session: 'OUTSIDE SESSION',
    scanning: 'SCANNING',
    engine_off: 'OFF'
  };
  return labels[status] || String(status || 'WAITING').replaceAll('_', ' ').toUpperCase();
}

function strategyLabel(value) {
  if (value === 'pullback') return 'Pullback into Zone';
  if (value === 'breakout_retest') return 'Breakout & Retest';
  return value ? String(value).replaceAll('_', ' ') : '--';
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function updateClock() {
  $('ukClock').textContent = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

function renderSession(data) {
  const session = data.session || {};
  const strip = $('sessionStrip');
  if (session.is_open && session.active) {
    strip.classList.add('open');
    $('sessionState').textContent = session.active.name.toUpperCase();
    $('sessionHeadline').textContent = `${session.active.name} window is open`;
    $('sessionNote').textContent = `New trade ideas are allowed now. Existing ideas will continue after ${session.active.local_finish}.`;
  } else {
    strip.classList.remove('open');
    $('sessionState').textContent = 'CLOSED';
    $('sessionHeadline').textContent = 'No new ideas outside the high-volume windows';
    $('sessionNote').textContent = 'London: 08:15–11:00 Europe/London. New York: 08:30–11:00 America/New_York. Open ideas remain monitored.';
  }
  const next = session.next;
  $('nextWindow').textContent = next?.at
    ? `${next.session.name} · ${formatTime(next.at, { weekday: true, day: true })}`
    : '--';
  $('nextScan').textContent = formatTime(data.next_scan_at);
}

function renderSourceCard(id, source, purpose) {
  const card = $(id);
  card.className = `source-card ${source?.status || 'waiting'}`;
  const strong = card.querySelector('strong');
  const small = card.querySelector('small');
  if (!source?.run) {
    strong.textContent = 'Missing';
    small.textContent = purpose;
    return;
  }
  strong.textContent = source.isFresh ? `Fresh · ${source.ageMinutes ?? 0}m` : `Stale · ${source.ageMinutes ?? '?'}m`;
  small.textContent = `${purpose} · ${source.run.mode || 'completed'}`;
}

function renderSources(data) {
  const fresh = data.source_freshness || {};
  const sources = fresh.sources || {};
  renderSourceCard('sourceBias', sources.bias, 'Direction');
  renderSourceCard('sourceZones', sources.zones, 'Pullback entry');
  renderSourceCard('sourceStructure', sources.structure, 'Breakout / retest');
  renderSourceCard('sourceLiquidity', sources.liquidity, 'Take-profit target');
  $('freshSummary').textContent = `${fresh.freshCount || 0}/4 inputs fresh within ${fresh.max_age_minutes || 20} minutes`;
}

function tradeCommand(idea, focus) {
  const status = idea?.status || focus?.status;
  const direction = idea?.direction || focus?.direction;
  if (status === 'active') return `${direction === 'buy' ? 'BUY' : 'SELL'} NOW`;
  if (status === 'armed') return 'WAIT FOR M5';
  if (status === 'forming') return 'GET READY';
  if (status === 'won') return 'TP HIT';
  if (status === 'lost') return 'SL HIT';
  return 'WAIT';
}

function renderIdea(data) {
  const idea = data.current_idea;
  const focus = data.focus || {};
  const command = tradeCommand(idea, focus);
  const direction = idea?.direction || focus.direction;
  const status = idea?.status || focus.status || 'waiting';
  const strategy = idea?.strategy_type || focus.raw?.strategy_type;
  const symbol = idea?.symbol || focus.symbol;

  $('ideaTitle').textContent = symbol ? `${symbol} ${String(direction || '').toUpperCase()}` : 'No live trade idea';
  $('ideaStatus').textContent = statusLabel(status);
  $('ideaStrategy').textContent = strategyLabel(strategy);
  $('tradeCommand').textContent = command;
  $('tradeCommand').className = `trade-command ${status === 'active' ? direction : ''}`;
  $('ideaReason').textContent = idea?.latest_note || idea?.reason || focus.reason || 'Waiting for the next completed M5 scan.';

  $('plannedEntry').textContent = formatPrice(idea?.planned_entry, symbol);
  $('currentEntry').textContent = formatPrice(idea?.entry_price ?? idea?.last_live_price ?? focus.last_live_price, symbol);
  $('stopLoss').textContent = formatPrice(idea?.stop_loss, symbol);
  $('takeProfit').textContent = formatPrice(idea?.take_profit, symbol);
  $('ideaRr').textContent = Number(idea?.rr) ? `1:${Number(idea.rr).toFixed(2)}` : '--';
  $('ideaScore').textContent = Number(idea?.idea_score) ? `${Math.round(Number(idea.idea_score))}%` : (Number(focus.confluence_score) ? `${Math.round(Number(focus.confluence_score))}%` : '--');
  $('ideaSession').textContent = idea?.session_name || '--';
  $('ideaStrategyText').textContent = strategyLabel(strategy);
}

function renderMarkets(data) {
  const assets = data.assets || [];
  const grid = $('marketGrid');
  if (!assets.length) {
    grid.innerHTML = '<div class="empty-state">No scored scan is available yet.</div>';
    return;
  }
  grid.innerHTML = assets.map((asset) => {
    const direction = asset.direction || 'none';
    const score = Math.round(Number(asset.confluence_score || 0));
    return `
      <article class="market-card ${escapeHtml(asset.status || '')}">
        <div class="market-top">
          <div>
            <div class="market-symbol">${escapeHtml(asset.symbol)}</div>
            <span class="market-direction ${escapeHtml(direction)}">${escapeHtml(String(direction).toUpperCase())}</span>
          </div>
          <div>
            <div class="market-status">${escapeHtml(statusLabel(asset.status))}</div>
            <div class="market-score">${score}%</div>
          </div>
        </div>
        <div class="market-strategy">${escapeHtml(strategyLabel(asset.strategy_type))}</div>
        <div class="market-plan">
          <div><span>Entry</span><strong>${formatPrice(asset.planned_entry, asset.symbol)}</strong></div>
          <div><span>Price</span><strong>${formatPrice(asset.latest_price, asset.symbol)}</strong></div>
          <div><span>SL</span><strong>${formatPrice(asset.stop_loss, asset.symbol)}</strong></div>
          <div><span>TP / R:R</span><strong>${formatPrice(asset.target_price, asset.symbol)} · ${Number(asset.rr) ? `1:${Number(asset.rr).toFixed(2)}` : '--'}</strong></div>
        </div>
        <p class="market-reason">${escapeHtml(asset.reason || 'No setup reason saved.')}</p>
      </article>`;
  }).join('');
}

function renderPerformance(data) {
  const stats = data.performance || {};
  $('statIdeas').textContent = stats.totalIdeas || 0;
  $('statWins').textContent = stats.wins || 0;
  $('statLosses').textContent = stats.losses || 0;
  $('statWinRate').textContent = `${Number(stats.winRate || 0).toFixed(1)}%`;
  $('statAvgR').textContent = `${Number(stats.avgR || 0).toFixed(2)}R`;
}

function render(data) {
  state.data = data;
  const enabled = data.settings?.scanner_enabled !== false;
  $('engineState').textContent = enabled ? 'ON' : 'OFF';
  $('toggleEngineBtn').textContent = enabled ? 'Turn Engine Off' : 'Turn Engine On';
  renderSession(data);
  renderSources(data);
  renderIdea(data);
  renderMarkets(data);
  renderPerformance(data);
}

async function loadLatest() {
  if (state.loading) return;
  state.loading = true;
  try {
    const response = await fetch('/.netlify/functions/latest-results', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not load EVE');
    render(data);
  } catch (error) {
    $('engineState').textContent = 'ERROR';
    showToast(error.message || 'Could not load EVE');
  } finally {
    state.loading = false;
  }
}

async function verifyAdmin(password) {
  const response = await fetch('/.netlify/functions/admin-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-eve-admin-password': password },
    body: '{}'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Wrong admin password');
}

async function ensureAdmin() {
  if (state.adminPassword) {
    try {
      await verifyAdmin(state.adminPassword);
      return true;
    } catch (_) {
      state.adminPassword = '';
      sessionStorage.removeItem('eve_admin_password_session');
    }
  }
  const password = prompt('Enter EVE admin password:');
  if (!password) return false;
  await verifyAdmin(password.trim());
  state.adminPassword = password.trim();
  sessionStorage.setItem('eve_admin_password_session', state.adminPassword);
  return true;
}

async function adminPost(path, body = {}) {
  const okay = await ensureAdmin();
  if (!okay) return null;
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-eve-admin-password': state.adminPassword },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Admin action failed');
  return data;
}

async function withButton(button, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try { await task(); }
  catch (error) { showToast(error.message || 'Action failed'); }
  finally {
    button.disabled = false;
    if (button.id === 'toggleEngineBtn' && state.data) render(state.data);
    else button.textContent = original;
  }
}

async function openAdmin() {
  try {
    if (!await ensureAdmin()) return;
    $('adminModal').classList.remove('hidden');
    $('adminFab').setAttribute('aria-expanded', 'true');
  } catch (error) {
    showToast(error.message || 'Wrong admin password');
  }
}

function closeAdmin() {
  $('adminModal').classList.add('hidden');
  $('adminFab').setAttribute('aria-expanded', 'false');
}

function performanceTableRows(rows, nameKey) {
  return (rows || []).map((row) => `
    <tr>
      <td>${escapeHtml(row[nameKey] || row.name || '--')}</td>
      <td>${row.total || 0}</td>
      <td>${row.wins || 0}</td>
      <td>${row.losses || 0}</td>
      <td>${Number(row.winRate || 0).toFixed(1)}%</td>
      <td>${Number(row.avgR || 0).toFixed(2)}R</td>
    </tr>`).join('');
}

async function openPerformance() {
  try {
    const okay = await ensureAdmin();
    if (!okay) return;
    const response = await fetch('/.netlify/functions/performance?limit=500', {
      headers: { 'x-eve-admin-password': state.adminPassword },
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not load performance');
    const stats = data.performance || {};
    $('performanceBody').innerHTML = `
      <div class="performance-summary">
        <div><span>Ideas</span><strong>${stats.totalIdeas || 0}</strong></div>
        <div><span>Wins</span><strong>${stats.wins || 0}</strong></div>
        <div><span>Losses</span><strong>${stats.losses || 0}</strong></div>
        <div><span>Win Rate</span><strong>${Number(stats.winRate || 0).toFixed(1)}%</strong></div>
        <div><span>Average R</span><strong>${Number(stats.avgR || 0).toFixed(2)}R</strong></div>
      </div>
      <div class="performance-table-wrap">
        <table>
          <thead><tr><th>Market</th><th>Ideas</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>Average R</th></tr></thead>
          <tbody>${performanceTableRows(stats.byAsset, 'symbol') || '<tr><td colspan="6">No results yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="performance-table-wrap">
        <table>
          <thead><tr><th>Strategy</th><th>Ideas</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>Average R</th></tr></thead>
          <tbody>${performanceTableRows(stats.byStrategy, 'name') || '<tr><td colspan="6">No results yet.</td></tr>'}</tbody>
        </table>
      </div>`;
    $('performanceModal').classList.remove('hidden');
  } catch (error) {
    showToast(error.message || 'Could not load performance');
  }
}

$('adminFab').addEventListener('click', openAdmin);
$('closeAdmin').addEventListener('click', closeAdmin);
$('adminModal').addEventListener('click', (event) => { if (event.target === $('adminModal')) closeAdmin(); });
$('closePerformance').addEventListener('click', () => $('performanceModal').classList.add('hidden'));
$('performanceModal').addEventListener('click', (event) => { if (event.target === $('performanceModal')) $('performanceModal').classList.add('hidden'); });
$('performanceBtn').addEventListener('click', openPerformance);

$('scanNowBtn').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
  await adminPost('/.netlify/functions/manual-scan');
  showToast('Scan completed.');
  await loadLatest();
}));

$('toggleEngineBtn').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
  const currentlyEnabled = state.data?.settings?.scanner_enabled !== false;
  await adminPost('/.netlify/functions/toggle-scanner', { enabled: !currentlyEnabled });
  showToast(!currentlyEnabled ? 'Trade Idea Engine turned on.' : 'Trade Idea Engine turned off.');
  await loadLatest();
}));

$('clearIdeaBtn').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
  await adminPost('/.netlify/functions/unlock-focus');
  showToast('Current idea cancelled.');
  await loadLatest();
}));

updateClock();
setInterval(updateClock, 1000);
loadLatest();
setInterval(loadLatest, 60000);
