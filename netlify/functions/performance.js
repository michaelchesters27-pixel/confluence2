const { getSupabase } = require('./lib/supabase');
const { ok, bad, requireAdmin } = require('./lib/http');
const { performanceStats } = require('./lib/confluence-core');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  try {
    requireAdmin(event);
    const supabase = getSupabase();
    const limit = Math.min(Number(event.queryStringParameters?.limit || 250), 500);
    const { data, error } = await supabase
      .from('eve_confluence_trade_ideas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ok({ ideas: data || [], performance: performanceStats(data || []) });
  } catch (err) {
    console.error(err);
    return bad(500, err.message || 'Could not load performance');
  }
};
