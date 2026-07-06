const { getSupabase } = require('./lib/supabase');
const { ok, bad, requireAdmin } = require('./lib/http');
const { runConfluenceScan } = require('./lib/confluence-core');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  try {
    requireAdmin(event);
    const supabase = getSupabase();
    const result = await runConfluenceScan(supabase, 'manual');
    return ok({ latest_run: result.run, selected: result.selected, idea: result.idea });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Manual scan failed');
  }
};
