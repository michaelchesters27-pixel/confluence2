const { getSupabase } = require('./lib/supabase');
const { ok, bad, requireAdmin } = require('./lib/http');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  try {
    requireAdmin(event);
    const body = JSON.parse(event.body || '{}');
    const enabled = Boolean(body.enabled);
    const supabase = getSupabase();
    const now = new Date().toISOString();
    const { error } = await supabase.from('eve_confluence_settings').upsert({
      key: 'scanner_enabled',
      value: enabled,
      updated_at: now,
      changed_by: 'admin'
    });
    if (error) throw error;

    if (!enabled) {
      await supabase
        .from('eve_confluence_trade_ideas')
        .update({
          status: 'cancelled',
          outcome: 'cancelled',
          completed_at: now,
          latest_note: 'Cancelled because the Trade Idea Engine was turned off.',
          updated_at: now
        })
        .in('status', ['forming', 'armed', 'active']);

      await supabase.from('eve_confluence_current_focus').upsert({
        id: 'current',
        symbol: null,
        direction: null,
        status: 'engine_off',
        idea_id: null,
        confluence_score: 0,
        reason: 'Trade Idea Engine is turned off.',
        locked_at: null,
        lock_until: null,
        last_live_price: null,
        last_live_at: null,
        raw: {},
        updated_at: now
      });
    }
    return ok({ scanner_enabled: enabled });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Could not toggle Trade Idea Engine');
  }
};
