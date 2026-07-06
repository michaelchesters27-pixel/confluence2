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
      await supabase.from('eve_confluence_current_focus').upsert({
        id: 'current',
        symbol: null,
        direction: null,
        status: 'confluence_off',
        idea_id: null,
        confluence_score: 0,
        reason: 'Confluence scanner is turned off.',
        locked_at: null,
        lock_until: null,
        last_live_price: null,
        last_live_at: null,
        railway_symbol: null,
        railway_status: 'no_focus',
        raw: {},
        updated_at: now
      });
    }
    return ok({ scanner_enabled: enabled });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Could not toggle scanner');
  }
};
