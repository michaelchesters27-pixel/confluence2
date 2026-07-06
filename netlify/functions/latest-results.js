const { getSupabase } = require('./lib/supabase');
const { ok, bad } = require('./lib/http');
const { getLatestState, performanceStats } = require('./lib/confluence-core');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  try {
    const supabase = getSupabase();
    const state = await getLatestState(supabase);
    const stats = performanceStats(state.recent_ideas || []);
    return ok({ ...state, performance: stats, railway_public_url: process.env.RAILWAY_PUBLIC_URL || null });
  } catch (err) {
    console.error(err);
    return bad(500, err.message || 'Could not load latest confluence results');
  }
};
