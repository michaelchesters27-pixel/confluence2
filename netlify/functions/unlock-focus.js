const { getSupabase } = require('./lib/supabase');
const { ok, bad, requireAdmin } = require('./lib/http');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  try {
    requireAdmin(event);
    const supabase = getSupabase();
    const now = new Date().toISOString();
    const { error } = await supabase.from('eve_confluence_current_focus').upsert({
      id: 'current',
      status: 'unlocked',
      lock_until: null,
      locked_at: null,
      reason: 'Focus manually unlocked. Run Scan Now to pick again.',
      updated_at: now
    });
    if (error) throw error;
    await supabase.from('eve_confluence_events').insert({ event_type: 'focus_unlocked', message: 'Admin manually unlocked focus.' });
    return ok({ unlocked: true });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Could not unlock focus');
  }
};
