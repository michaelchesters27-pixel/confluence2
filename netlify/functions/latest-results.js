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
    const [state, railway] = await Promise.all([getLatestState(supabase), railwayHealth()]);
    const stats = performanceStats(state.recent_ideas || []);
    return ok({ ...state, performance: stats, railway_health: railway });
  } catch (err) {
    console.error(err);
    return bad(500, err.message || 'Could not load EVE Confluence results');
  }
};
