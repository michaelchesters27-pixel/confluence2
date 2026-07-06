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
    const { error } = await supabase.from('eve_confluence_settings').upsert({
      key: 'scanner_enabled',
      value: enabled,
      updated_at: new Date().toISOString(),
      changed_by: 'admin'
    });
    if (error) throw error;
    return ok({ scanner_enabled: enabled });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Could not toggle scanner');
  }
};
