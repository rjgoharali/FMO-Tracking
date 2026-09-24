export interface Env { DB: D1Database; CORS_ORIGINS: string; }
const json = (body: unknown, status = 200, origin = 'https://dashboard.rajagohar.live') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
const hash = async (password: string, salt: string, iterations = 120000) => {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' }, material, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
};
const token = () => crypto.randomUUID() + crypto.randomUUID().replaceAll('-', '');
const authUser = async (request: Request, env: Env) => {
  const value = request.headers.get('authorization') ?? '';
  if (!value.startsWith('Bearer ')) return null;
  return env.DB.prepare(`SELECT u.id,u.employee_code,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now') AND u.is_active=1`).bind(value.slice(7)).first<{ id:string; employee_code:string; name:string; role:string }>();
};
export default { async fetch(request: Request, env: Env): Promise<Response> {
  const requestOrigin = request.headers.get('origin') ?? '';
  const origin = ['https://dashboard.rajagohar.live', 'https://fmo-tracking.pages.dev'].includes(requestOrigin) ? requestOrigin : 'https://dashboard.rajagohar.live';
  if (request.method === 'OPTIONS') return json({}, 204, origin);
  const url = new URL(request.url);
  if (url.pathname === '/health/live') return json({ status: 'ok', service: 'fmo-worker' }, 200, origin);
  if (url.pathname === '/health/ready') { try { await env.DB.prepare('SELECT 1').first(); return json({ status: 'ready' }); } catch { return json({ status: 'unready' }, 503); } }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const input = await request.json<{ employeeCode?: string; password?: string }>().catch(() => null);
    if (!input?.employeeCode || !input.password) return json({ code: 'INVALID_CREDENTIALS', error: 'Employee ID and password are required.' }, 400);
    const user = await env.DB.prepare('SELECT * FROM users WHERE lower(employee_code)=lower(?) AND is_active=1').bind(input.employeeCode.trim()).first<{ id: string; employee_code: string; name: string; role: string; password_hash: string }>();
    if (!user) return json({ code: 'INVALID_CREDENTIALS', error: 'Invalid credentials.' }, 401);
    const [scheme, iterationsText, salt, expected] = user.password_hash.split('$');
    const actual = scheme === 'pbkdf2' ? await hash(input.password, salt, Number(iterationsText)) : '';
    if (!expected || actual !== expected) return json({ code: 'INVALID_CREDENTIALS', error: 'Invalid credentials.' }, 401);
    const accessToken = token();
    await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime(\'now\',\'+8 hours\'))').bind(accessToken, user.id).run();
    return json({ accessToken, expiresIn: 28800, user: { id: user.id, employeeCode: user.employee_code, name: user.name, role: user.role } });
  }
  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return json({ code: 'UNAUTHORIZED', error: 'Session expired.' }, 401);
    return json({ user: { id: user.id, employeeCode: user.employee_code, name: user.name, role: user.role } });
  }
  return json({ code: 'NOT_IMPLEMENTED', error: 'Worker API migration is in progress.' }, 501);
} };
