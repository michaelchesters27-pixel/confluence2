const { ok, bad, requireAdmin } = require('./lib/http');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({});
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  try {
    requireAdmin(event);
    return ok({ admin: true });
  } catch (err) {
    return bad(err.statusCode || 500, err.message || 'Admin check failed');
  }
};
