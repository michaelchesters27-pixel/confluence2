const state = {
  data: null,
  adminPassword: sessionStorage.getItem('eve_admin_password_session') || '',
  adminUnlocked: false,
  loading: false,
  soundEnabled: localStorage.getItem('eve_confluence_sound_enabled') === 'true',
  lastAlertKey: localStorage.getItem('eve_confluence_last_alert_key') || ''
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

function fmtDateTime(iso) {
  if (!iso) return 'waiting';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'waiting';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

function formatPrice(value, symbol = '') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  let decimals = 5;
  if (symbol.includes('JPY')) decimals = 3;
  if (symbol === 'XAU/USD') decimals = 2;
  if (symbol === 'BTC/USD') decimals = 0;
  return n.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function setClock() { $('ukClock').textContent = fmtTime(new Date().toISOString()); }

function fmtWindow(start, end) {
  return `${fmtTime(start)} to ${fmtTime(end)}`;
}

function soundLabel() {
  return state.soundEnabled ? 'Sound Alerts: On' : 'Sound Alerts: Off';
}

function updateSoundButton() {
  const btn = $('soundBtn');
  if (!btn) return;
  btn.textContent = soundLabel();
  btn.classList.toggle('sound-on', state.soundEnabled);
}

function playTone(kind = 'forming') {
  if (!state.soundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = playTone._ctx || new AudioContext();
    playTone._ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const pattern = kind === 'active' ? [880, 1040, 880] : kind === 'armed' ? [740, 880] : [620];
    pattern.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.10, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      osc.start(start);
      osc.stop(start + 0.15);
    });
  } catch (_) {}
}

function maybeSoundAlert(focus, idea) {
  const status = idea?.status || focus?.status;
  const symbol = idea?.symbol || focus?.symbol;
  if (!symbol || !['forming', 'armed', 'active'].includes(status)) return;
  const key = `${idea?.id || symbol}:${status}`;
  if (!state.lastAlertKey) {
    state.lastAlertKey = key;
    localStorage.setItem('eve_confluence_last_alert_key', key);
    return;
  }
  if (state.lastAlertKey === key) return;
  state.lastAlertKey = key;
  localStorage.setItem('eve_confluence_last_alert_key', key);
  playTone(status);
  showToast(`${symbol} ${String(status).toUpperCase()} alert`);
}

function renderFreshness(freshness) {
  const sources = freshness?.sources || {};
  const ids = { bias: 'freshBias', structure: 'freshStructure', zones: 'freshZones', liquidity: 'freshLiquidity' };
  const labels = { bias: 'Bias', structure: 'Structure', zones: 'Zones', liquidity: 'Liquidity' };
  for (const key of Object.keys(ids)) {
    const el = $(ids[key]);
    if (!el) continue;
    const src = sources[key] || {};
    const fresh = Boolean(src.fresh);
    el.className = `fresh-card ${fresh ? 'fresh' : 'waiting'}`;
    el.innerHTML = `<span>${labels[key]}</span><strong>${fresh ? '✓ Fresh' : 'Waiting'}</strong><small>${fresh ? fmtTime(src.completed_at || src.started_at) : 'No fresh scan yet'}</small>`;
  }
  $('freshSummary').textContent = freshness?.allFresh ? 'All four fresh — Confluence decision allowed' : `Waiting: ${(freshness?.waiting || ['source scanners']).join(', ')}`;
  $('freshCycle').textContent = freshness?.cycle_start ? `Freshness window ${fmtWindow(freshness.cycle_start, freshness.cycle_end)}` : 'Freshness window waiting';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.adminPassword ? { 'x-eve-admin-password': state.adminPassword } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed ${res.status}`);
  return data;
}

async function loadLatest() {
  if (state.loading) return;
  state.loading = true;
  try {
    const data = await api('/.netlify/functions/latest-results');
    state.data = data;
    render(data);
  } catch (err) {
    showToast(err.message || 'Could not load EVE Confluence');
  } finally {
    state.loading = false;
  }
}

function statusLabel(status) {
  return String(status || 'waiting').replaceAll('_', ' ').toUpperCase();
}

function statusClass(status, direction) {
  const s = String(status || '');
  if (s === 'active' || s === 'won') return 'bias-bullish';
  if (s === 'lost' || s.includes('invalid')) return 'bias-bearish';
  if (direction === 'buy') return 'bias-bullish';
  if (direction === 'sell') return 'bias-bearish';
  return 'bias-mixed';
}

function isFreshLiveForFocus(focus, live) {
  if (!focus?.symbol || !live?.symbol || live.symbol !== focus.symbol || !live.received_at) return false;
  const liveAt = new Date(live.received_at).getTime();
  const lockAt = focus.locked_at ? new Date(focus.locked_at).getTime() : 0;
  return Number.isFinite(liveAt) && liveAt >= (lockAt - 30_000);
}

function render(data) {
  const run = data.latest_run;
  const settings = data.settings || {};
  const enabled = settings.scanner_enabled !== false;
  const focus = data.focus;
  const idea = data.current_idea;
  const live = focus?.symbol ? data.live_prices?.[focus.symbol] : null;

  $('scannerState').textContent = enabled ? 'ON' : 'OFF';
  $('railwayState').textContent = focus?.railway_status ? statusLabel(focus.railway_status) : 'WAITING';
  $('nextScan').textContent = fmtTime(data.next_scan_at);
  $('lastScan').textContent = `Last scan: ${fmtDateTime(run?.completed_at || run?.started_at)}`;
  $('coreStatus').textContent = focus?.symbol ? 'LOCKED' : 'WAITING';
  $('toggleBtn').textContent = enabled ? 'Turn Confluence Off' : 'Turn Confluence On';
  updateSoundButton();
  renderFreshness(data.source_freshness);

  renderFocus(focus, idea, live);
  renderPlan(focus, idea);
  renderIdea(focus, idea);
  renderGrid(data.assets || []);
  maybeSoundAlert(focus, idea);
}

function renderFocus(focus, idea, live) {
  const hasFocus = focus && focus.symbol;
  $('focusEmpty').classList.toggle('hidden', hasFocus);
  $('focusContent').classList.toggle('hidden', !hasFocus);
  if (!hasFocus) {
    $('lockInfo').textContent = `Focus lock: ${focus?.reason || 'No current focus'}`;
    return;
  }
  $('focusSymbol').textContent = focus.symbol;
  $('focusScore').textContent = Math.round(Number(focus.confluence_score || 0));
  $('focusReason').textContent = focus.reason || '--';
  const dir = $('focusDirection');
  dir.textContent = `${String(focus.direction || '').toUpperCase()} • ${statusLabel(focus.status)}`;
  dir.className = `bias-pill ${statusClass(focus.status, focus.direction)}`;
  const lockText = idea?.status === 'armed' || focus.status === 'armed' ? 'armed confirmation window' : (idea?.status === 'active' || focus.status === 'active' ? 'active until TP or SL' : 'forming touch window');
  $('lockInfo').textContent = `Focus lock until: ${fmtTime(focus.lock_until)} • ${lockText}`;
  const freshLive = isFreshLiveForFocus(focus, live);
  $('livePrice').textContent = freshLive ? formatPrice(live.price, focus.symbol) : '--';
  const src = live?.source === 'railway_twelvedata_rest_fallback' ? 'REST fallback' : 'Railway WS';
  $('livePriceAt').textContent = freshLive ? `Updated ${fmtTime(live.received_at)} • ${src}` : 'Waiting for Railway live price';
}

function renderPlan(focus, idea) {
  const raw = focus?.raw || {};
  const symbol = focus?.symbol || idea?.symbol || raw.symbol || '';
  const sl = idea?.stop_loss ?? raw.stop_loss;
  const tp = idea?.take_profit ?? raw.target_price;
  const rr = idea?.rr ?? raw.rr;
  const entry = idea?.entry_price || (idea?.status === 'active' ? idea.entry_price : null);

  $('planSL').textContent = formatPrice(sl, symbol);
  $('planSLReason').textContent = idea?.sl_reason || raw.sl_reason || 'SL calculated before any trade idea.';
  $('planEntry').textContent = entry ? formatPrice(entry, symbol) : 'Waiting confirmation';
  $('planEntryReason').textContent = entry ? 'Market execution idea active' : 'No entry until confirmation';
  $('planTP').textContent = formatPrice(tp, symbol);
  $('planTargetSource').textContent = idea?.target_source || raw.target_source || 'Meaningful liquidity target';
  $('planRR').textContent = Number(rr) ? `1:${Number(rr).toFixed(2)}` : '--';
}

function renderIdea(focus, idea) {
  const chip = $('ideaStatus');
  const body = $('ideaBody');
  const currentStatus = idea?.status || focus?.status || 'waiting';
  chip.textContent = statusLabel(currentStatus);
  chip.className = `status-chip ${statusClass(currentStatus, idea?.direction || focus?.direction)}`;

  if (!focus?.symbol) {
    if (focus?.status === 'waiting_fresh_sources') {
      body.innerHTML = `<strong>Waiting for fresh backbone scans.</strong><br />${escapeHtml(focus.reason || 'Bias, Structure, Zones and Liquidity must all be fresh before Confluence can judge a trade.')}`;
    } else if (focus?.status === 'candidate_waiting') {
      body.innerHTML = `<strong>Candidate setup mapped.</strong><br />${escapeHtml(focus.reason || 'Price is not close enough to the correct zone yet.')}`;
    } else {
      body.innerHTML = `No trade. EVE has not found an asset with clean confluence, a clean SL, a meaningful target and minimum 1:2 R:R.`;
    }
    return;
  }

  if (!idea && focus.status === 'watch_only') {
    body.innerHTML = `<strong>${escapeHtml(focus.symbol)} watch only.</strong><br />EVE has mapped direction, SL and target, but price is not in the trade area yet. No trade idea active.`;
    return;
  }

  if (!idea) {
    body.innerHTML = `<strong>${escapeHtml(focus.symbol)}</strong><br />${escapeHtml(focus.reason || 'Waiting for clean setup.')}`;
    return;
  }

  if (idea.status === 'forming') {
    body.innerHTML = `
      <strong>${escapeHtml(idea.symbol)} ${idea.direction.toUpperCase()} idea forming.</strong><br />
      SL first: <b>${formatPrice(idea.stop_loss, idea.symbol)}</b>. TP: <b>${formatPrice(idea.take_profit, idea.symbol)}</b>. R:R: <b>1:${Number(idea.rr || 0).toFixed(2)}</b>.<br />
      Waiting for price to touch the correct zone. No market entry yet.
    `;
  } else if (idea.status === 'armed') {
    body.innerHTML = `
      <strong>${escapeHtml(idea.symbol)} ${idea.direction.toUpperCase()} idea armed.</strong><br />
      Zone has been touched. SL: <b>${formatPrice(idea.stop_loss, idea.symbol)}</b>. TP: <b>${formatPrice(idea.take_profit, idea.symbol)}</b>. Planned R:R: <b>1:${Number(idea.rr || 0).toFixed(2)}</b>.<br />
      Waiting for live confirmation/reclaim. No market entry yet.
    `;
  } else if (idea.status === 'active') {
    body.innerHTML = `
      <strong>${escapeHtml(idea.symbol)} ${idea.direction.toUpperCase()} idea active.</strong><br />
      Entry: <b>${formatPrice(idea.entry_price, idea.symbol)}</b>. SL: <b>${formatPrice(idea.stop_loss, idea.symbol)}</b>. TP: <b>${formatPrice(idea.take_profit, idea.symbol)}</b>. R:R: <b>1:${Number(idea.rr || 0).toFixed(2)}</b>.<br />
      Market execution idea is active after confirmation.
    `;
  } else {
    body.innerHTML = `
      <strong>${escapeHtml(idea.symbol)} ${statusLabel(idea.status)}.</strong><br />
      ${escapeHtml(idea.latest_note || idea.reason || 'Idea closed.')}
    `;
  }
}

function renderGrid(assets) {
  const grid = $('marketGrid');
  if (!assets.length) {
    grid.innerHTML = `<div class="empty-state">No confluence scan results yet.</div>`;
    return;
  }
  grid.innerHTML = assets.map((m) => {
    const score = Math.round(Number(m.confluence_score || 0));
    const cls = ['market-card'];
    if (m.status === 'forming' || m.status === 'armed') cls.push('hot');
    if (m.status === 'candidate') cls.push('candidate');
    if (m.status === 'no_trade') cls.push('choppy');
    return `
      <article class="${cls.join(' ')}">
        <div class="market-meta"><span>${escapeHtml(m.asset_class || '')}</span><span>${escapeHtml(statusLabel(m.status))}</span></div>
        <div class="market-symbol">${escapeHtml(m.symbol)}</div>
        <div class="bias-pill ${statusClass(m.status, m.direction)}">${escapeHtml(String(m.direction || 'none').toUpperCase())}</div>
        <div class="price-row">Latest: <strong>${formatPrice(m.latest_price, m.symbol)}</strong></div>
        <div class="mini-plan">
          <div><span>SL first</span><strong>${formatPrice(m.stop_loss, m.symbol)}</strong></div>
          <div><span>TP</span><strong>${formatPrice(m.target_price, m.symbol)}</strong></div>
          <div><span>R:R</span><strong>${Number(m.rr) ? `1:${Number(m.rr).toFixed(2)}` : '--'}</strong></div>
        </div>
        <div class="market-line"><div class="pulse-meter"><div style="width:${score}%"></div></div><div class="score-mini">${score}%</div></div>
        <p class="card-reason">${escapeHtml(m.reason || 'No reason saved.')}</p>
      </article>`;
  }).join('');
}

async function verifyAdminPassword(password) {
  const res = await fetch('/.netlify/functions/admin-check', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-eve-admin-password': password
    },
    body: '{}'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'Wrong admin password');
  return true;
}

async function openAdmin() {
  const value = prompt('Enter EVE admin password:');
  if (value === null) return;
  const password = value.trim();
  if (!password) {
    showToast('Admin password required.');
    return;
  }
  try {
    await verifyAdminPassword(password);
    state.adminPassword = password;
    state.adminUnlocked = true;
    sessionStorage.setItem('eve_admin_password_session', password);
    $('adminModal').classList.remove('hidden');
    $('adminFab').setAttribute('aria-expanded', 'true');
  } catch (err) {
    state.adminPassword = '';
    state.adminUnlocked = false;
    sessionStorage.removeItem('eve_admin_password_session');
    $('adminModal').classList.add('hidden');
    $('adminFab').setAttribute('aria-expanded', 'false');
    showToast(err.message || 'Wrong admin password.');
  }
}

function closeAdmin() {
  $('adminModal').classList.add('hidden');
  $('adminFab').setAttribute('aria-expanded', 'false');
}

async function openStats() {
  try {
    const data = await api('/.netlify/functions/performance?limit=250');
    renderStats(data.performance || {}, data.ideas || []);
    $('statsModal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || 'Could not load stats');
  }
}

function renderStats(perf, ideas) {
  const grid = $('statsGrid');
  const cards = [
    ['Active win rate', `${Number(perf.winRate || 0).toFixed(1)}%`],
    ['Ideas formed', perf.totalIdeas || 0],
    ['Armed ideas', perf.armedIdeas || 0],
    ['Triggered ideas', perf.triggeredIdeas || 0],
    ['Wins', perf.wins || 0],
    ['Losses', perf.losses || 0],
    ['Expired before touch', perf.expiredBeforeTouch || 0],
    ['Expired after touch', perf.expiredAfterTouch || 0],
    ['Invalid before entry', perf.invalidatedBeforeEntry || 0],
    ['R:R failed trigger', perf.rrFailed || 0],
    ['Trigger rate', `${Number(perf.triggerRate || 0).toFixed(1)}%`],
    ['Average R', Number(perf.avgR || 0).toFixed(2)]
  ];
  grid.innerHTML = cards.map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join('');

  const body = $('ideaHistoryBody');
  if (!ideas.length) {
    body.innerHTML = `<tr><td colspan="8">No trade ideas recorded yet.</td></tr>`;
    return;
  }
  body.innerHTML = ideas.slice(0, 80).map((i) => `
    <tr>
      <td>${fmtDateTime(i.created_at)}</td>
      <td>${escapeHtml(i.symbol)}</td>
      <td>${escapeHtml(String(i.direction || '').toUpperCase())}</td>
      <td>${escapeHtml(statusLabel(i.status))}</td>
      <td>${Number(i.entry_price) ? formatPrice(i.entry_price, i.symbol) : 'No entry'}</td>
      <td>${formatPrice(i.stop_loss, i.symbol)}</td>
      <td>${formatPrice(i.take_profit, i.symbol)}</td>
      <td>${Number.isFinite(Number(i.result_r)) ? Number(i.result_r).toFixed(2) : (Number(i.rr) ? `1:${Number(i.rr).toFixed(2)}` : '--')}</td>
    </tr>`).join('');
}

async function manualScan() {
  try {
    showToast('Running confluence scan...');
    await api('/.netlify/functions/manual-scan', { method: 'POST', body: '{}' });
    await loadLatest();
  } catch (err) { showToast(err.message); }
}

async function toggleScanner() {
  try {
    const enabled = !(state.data?.settings?.scanner_enabled !== false);
    await api('/.netlify/functions/toggle-scanner', { method: 'POST', body: JSON.stringify({ enabled }) });
    await loadLatest();
  } catch (err) { showToast(err.message); }
}

async function unlockFocus() {
  try {
    await api('/.netlify/functions/unlock-focus', { method: 'POST', body: '{}' });
    await loadLatest();
    showToast('Focus unlocked. Press Scan Now to pick again.');
  } catch (err) { showToast(err.message); }
}

async function setPassword() {
  const value = prompt('Re-enter EVE admin password:');
  if (value === null) return;
  const password = value.trim();
  if (!password) {
    showToast('Admin password required.');
    return;
  }
  try {
    await verifyAdminPassword(password);
    state.adminPassword = password;
    state.adminUnlocked = true;
    sessionStorage.setItem('eve_admin_password_session', password);
    showToast('Admin unlocked for this browser tab.');
  } catch (err) {
    showToast(err.message || 'Wrong admin password.');
  }
}

function init() {
  $('refreshBtn').addEventListener('click', loadLatest);
  $('soundBtn').addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('eve_confluence_sound_enabled', state.soundEnabled ? 'true' : 'false');
    if (state.data) {
      const focus = state.data.focus;
      const idea = state.data.current_idea;
      const status = idea?.status || focus?.status;
      const symbol = idea?.symbol || focus?.symbol;
      if (symbol && ['forming', 'armed', 'active'].includes(status)) {
        state.lastAlertKey = `${idea?.id || symbol}:${status}`;
        localStorage.setItem('eve_confluence_last_alert_key', state.lastAlertKey);
      }
    }
    updateSoundButton();
    showToast(state.soundEnabled ? 'Sound alerts enabled.' : 'Sound alerts disabled.');
  });
  $('adminFab').addEventListener('click', openAdmin);
  $('closeAdminBtn').addEventListener('click', closeAdmin);
  $('adminModal').addEventListener('click', (event) => { if (event.target === $('adminModal')) closeAdmin(); });
  $('manualScanBtn').addEventListener('click', manualScan);
  $('toggleBtn').addEventListener('click', toggleScanner);
  $('unlockBtn').addEventListener('click', unlockFocus);
  $('passwordBtn').addEventListener('click', setPassword);
  $('statsBtn').addEventListener('click', openStats);
  $('closeStatsBtn').addEventListener('click', () => $('statsModal').classList.add('hidden'));
  setClock();
  updateSoundButton();
  setInterval(setClock, 1000);
  loadLatest();
  setInterval(loadLatest, 2500);
}

init();
