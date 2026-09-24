export interface Env { DB: D1Database; CORS_ORIGINS: string; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
export default { async fetch(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return json({}, 204);
  const url = new URL(request.url);
  if (url.pathname === '/health/live') return json({ status: 'ok', service: 'fmo-worker' });
  if (url.pathname === '/health/ready') { try { await env.DB.prepare('SELECT 1').first(); return json({ status: 'ready' }); } catch { return json({ status: 'unready' }, 503); } }
  return json({ code: 'NOT_IMPLEMENTED', error: 'Worker API migration is in progress.' }, 501);
} };
