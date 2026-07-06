function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-eve-admin-password',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function ok(body) { return json(200, { ok: true, ...body }); }
function bad(statusCode, message, extra = {}) { return json(statusCode, { ok: false, error: message, ...extra }); }

function requireAdmin(event) {
  const expected = process.env.EVE_ADMIN_PASSWORD || '';
  if (!expected) return true;
  const given = event.headers['x-eve-admin-password'] || event.headers['X-Eve-Admin-Password'];
  if (given !== expected) {
    const err = new Error('Admin password required');
    err.statusCode = 401;
    throw err;
  }
  return true;
}

module.exports = { json, ok, bad, requireAdmin };
