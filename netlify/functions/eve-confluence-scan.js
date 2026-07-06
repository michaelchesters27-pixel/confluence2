const { getSupabase } = require('./lib/supabase');
const { ok, bad } = require('./lib/http');
const { runConfluenceScan } = require('./lib/confluence-core');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  try {
    const supabase = getSupabase();
    const source = event.httpMethod === 'POST' ? 'manual' : 'scheduled';
    const result = await runConfluenceScan(supabase, source);
    return ok({
      latest_run: result.run,
      selected: result.selected,
      idea: result.idea,
      assets_checked: result.assets?.length || 0
    });
  } catch (err) {
    console.error(err);
    return bad(err.statusCode || 500, err.message || 'Confluence scan failed');
  }
};
