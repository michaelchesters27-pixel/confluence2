const { getSupabase } = require('./lib/supabase');
const { ok, bad, requireAdmin } = require('./lib/http');

function closePayload(idea, now, reason) {
  if (idea.status !== 'active') {
    return {
      status: 'cancelled',
      outcome: 'cancelled',
      result_r: null,
      completed_at: now,
      latest_note: reason,
      updated_at: now
    };
  }
  const entry = Number(idea.entry_price);
  const risk = Number(idea.risk_amount);
  const live = Number(idea.last_live_price);
  const resultR = Number.isFinite(entry) && Number.isFinite(risk) && risk > 0 && Number.isFinite(live)
    ? (idea.direction === 'buy' ? live - entry : entry - live) / risk
    : 0;
  return {
    status: 'closed',
    outcome: Math.abs(resultR) <= 0.05 ? 'break_even' : 'manual_close',
    result_r: resultR,
    completed_at: now,
    latest_note: `${reason} Active trade recorded at ${resultR.toFixed(2)}R.`,
    updated_at: now
  };
}

async function closeOpenIdeas(supabase, now, reason) {
  const { data: ideas, error } = await supabase
    .from('eve_confluence_trade_ideas')
    .select('*')
    .in('status', ['forming', 'armed', 'active']);
  if (error) throw error;
  for (const idea of ideas || []) {
    const { error: updateError } = await supabase
      .from('eve_confluence_trade_ideas')
      .update(closePayload(idea, now, reason))
      .eq('id', idea.id);
    if (updateError) throw updateError;
  }
  return ideas || [];
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  try {
    requireAdmin(event);
    const supabase = getSupabase();
    const now = new Date().toISOString();
    const openIdeas = await closeOpenIdeas(supabase, now, 'Current idea manually closed by admin.');

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
      railway_symbol: null,
      railway_status: 'no_focus',
      reason: 'Current idea closed. The next in-session scan can choose a new one.',
      raw: {},
      updated_at: now
    });
    if (error) throw error;

    const first = openIdeas[0] || null;
    await supabase.from('eve_confluence_events').insert({
      event_type: first?.status === 'active' ? 'idea_manually_closed' : 'idea_manually_cancelled',
      symbol: first?.symbol || null,
      idea_id: first?.id || null,
      message: first?.status === 'active'
        ? 'Admin manually closed the active trade and its live R result was recorded.'
        : 'Admin manually cancelled the current pre-entry idea.'
    });
    return ok({ cleared: true });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Could not clear current idea');
  }
};
