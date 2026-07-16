const { getSupabase } = require('./lib/supabase');
const { ok, bad, requireAdmin } = require('./lib/http');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  try {
    requireAdmin(event);
    const supabase = getSupabase();
    const now = new Date().toISOString();

    const { data: openIdeas } = await supabase
      .from('eve_confluence_trade_ideas')
      .select('id,symbol')
      .in('status', ['forming', 'armed', 'active']);

    await supabase
      .from('eve_confluence_trade_ideas')
      .update({
        status: 'cancelled',
        outcome: 'cancelled',
        completed_at: now,
        latest_note: 'Current idea manually cancelled by admin.',
        updated_at: now
      })
      .in('status', ['forming', 'armed', 'active']);

    const { error } = await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      symbol: null,
      direction: null,
      status: 'cleared',
      idea_id: null,
      confluence_score: 0,
      lock_until: null,
      locked_at: null,
      last_live_price: null,
      last_live_at: null,
      reason: 'Current idea cleared. The next in-session scan can choose a new one.',
      raw: {},
      updated_at: now
    });
    if (error) throw error;

    await supabase.from('eve_confluence_events').insert({
      event_type: 'idea_manually_cancelled',
      symbol: openIdeas?.[0]?.symbol || null,
      idea_id: openIdeas?.[0]?.id || null,
      message: 'Admin manually cancelled the current Trade Idea Engine idea.'
    });
    return ok({ cleared: true });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Could not clear current idea');
  }
};
