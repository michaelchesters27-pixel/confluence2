const { getSupabase } = require('./lib/supabase');
const { ok, bad } = require('./lib/http');
const { getLatestState, performanceStats } = require('./lib/confluence-core');

async function railwayHealth() {
  const base = String(process.env.RAILWAY_PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) return { configured: false, ok: false, status: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    return { configured: true, ok: response.ok && data.ok !== false, status: response.ok ? 'online' : 'error', ...data };
  } catch (error) {
    return { configured: true, ok: false, status: error.name === 'AbortError' ? 'timeout' : 'offline', error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  try {
    const supabase = getSupabase();
    const [state, directRailway] = await Promise.all([getLatestState(supabase), railwayHealth()]);
    const focus = state.focus || {};
    const focusStatus = String(focus.railway_status || '').toLowerCase();
    const liveAt = focus.last_live_at || focus.updated_at || null;
    const liveAgeMs = liveAt ? Date.now() - new Date(liveAt).getTime() : Number.POSITIVE_INFINITY;
    const dbShowsRailwayAlive = liveAgeMs <= 180_000 && [
      'connecting', 'connected', 'subscribed', 'live_price', 'rest_fallback_price',
      'idea_armed', 'idea_active'
    ].includes(focusStatus);
    const railway = (!directRailway.ok && dbShowsRailwayAlive)
      ? {
          ...directRailway,
          ok: true,
          inferred: true,
          degraded: focusStatus !== 'live_price',
          status: 'online_via_supabase',
          wsStatus: focusStatus,
          focusSymbol: focus.railway_symbol || focus.symbol || null,
          lastPrice: focus.last_live_price ?? null,
          lastPriceAt: focus.last_live_at || null
        }
      : {
          ...directRailway,
          degraded: directRailway.degraded || ['rest_fallback_price', 'subscribe_failed', 'error', 'closed'].includes(String(directRailway.wsStatus || '').toLowerCase())
        };
    const stats = performanceStats(state.recent_ideas || []);
    return ok({ ...state, performance: stats, railway_health: railway });
  } catch (err) {
    console.error(err);
    return bad(500, err.message || 'Could not load EVE Confluence results');
  }
};
