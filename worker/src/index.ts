export interface Env { DB: D1Database; CORS_ORIGINS: string; }
const json = (body: unknown, status = 200, origin = 'https://dashboard.rajagohar.live') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
const hash = async (password: string, salt: string, iterations = 100000) => {
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
  const allowed = requestOrigin === 'https://dashboard.rajagohar.live' || /^https:\/\/[a-z0-9-]+\.fmo-tracking\.pages\.dev$/.test(requestOrigin);
  const origin = allowed ? requestOrigin : 'https://dashboard.rajagohar.live';
  const reply = (body: unknown, status = 200) => json(body, status, origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
  const url = new URL(request.url);
  if (url.pathname === '/health/live') return reply({ status: 'ok', service: 'fmo-worker' }, 200, origin);
  if (url.pathname === '/health/ready') { try { await env.DB.prepare('SELECT 1').first(); return reply({ status: 'ready' }); } catch { return reply({ status: 'unready' }, 503); } }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    try {
    const input = await request.json<{ employeeCode?: string; password?: string }>().catch(() => null);
    if (!input?.employeeCode || !input.password) return reply({ code: 'INVALID_CREDENTIALS', error: 'Employee ID and password are required.' }, 400);
    const user = await env.DB.prepare('SELECT * FROM users WHERE lower(employee_code)=lower(?) AND is_active=1').bind(input.employeeCode.trim()).first<{ id: string; employee_code: string; name: string; role: string; password_hash: string }>();
    if (!user) return reply({ code: 'INVALID_CREDENTIALS', error: 'Invalid credentials.' }, 401);
    const [scheme, iterationsText, salt, expected] = user.password_hash.split('$');
    const actual = scheme === 'pbkdf2' ? await hash(input.password, salt, Number(iterationsText)) : '';
    if (!expected || actual !== expected) return reply({ code: 'INVALID_CREDENTIALS', error: 'Invalid credentials.' }, 401);
    const accessToken = token();
    await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime(\'now\',\'+8 hours\'))').bind(accessToken, user.id).run();
    return reply({ accessToken, refreshToken: accessToken, expiresIn: 28800, user: { id: user.id, employeeCode: user.employee_code, name: user.name, role: user.role } });
    } catch (error) {
      return reply({ code: 'LOGIN_ERROR', error: error instanceof Error ? error.message : 'Login failed.' }, 500);
    }
  }
  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return reply({ code: 'UNAUTHORIZED', error: 'Session expired.' }, 401);
    return reply({ user: { id: user.id, employeeCode: user.employee_code, name: user.name, role: user.role } });
  }
  if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
    const input = await request.json<{ refreshToken?: string }>().catch(() => null);
    const value = input?.refreshToken;
    if (!value) return reply({ code:'LOGIN_REQUIRED', error:'Refresh token required.' }, 401);
    const user = await env.DB.prepare(`SELECT u.id,u.employee_code,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now') AND u.is_active=1`).bind(value).first<any>();
    if (!user) return reply({ code:'LOGIN_REQUIRED', error:'Session expired.' }, 401);
    const accessToken = token();
    await env.DB.prepare('UPDATE sessions SET token_hash=?,expires_at=datetime(\'now\',\'+8 hours\') WHERE token_hash=?').bind(accessToken, value).run();
    return reply({ accessToken, refreshToken: accessToken, expiresIn: 28800, user: { id:user.id, employeeCode:user.employee_code, name:user.name, role:user.role } });
  }
  if (url.pathname === '/api/duty/current' && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role !== 'FMO') return reply({ code:'UNAUTHORIZED', error:'FMO session required.' }, 401);
    const session = await env.DB.prepare(`SELECT * FROM duty_sessions WHERE fmo_id=? AND status='ACTIVE' LIMIT 1`).bind(user.id).first<any>();
    const attendance = session ? await env.DB.prepare('SELECT * FROM attendance WHERE duty_session_id=? ORDER BY check_in_time DESC LIMIT 1').bind(session.id).first<any>() : null;
    return reply({ session, attendance, lastLocation:null, settings, trackingAuthorized:!!session });
  }
  if (url.pathname === '/api/duty/start' && request.method === 'POST') {
    const user = await authUser(request, env); if (!user || user.role !== 'FMO') return reply({ code:'UNAUTHORIZED', error:'FMO session required.' }, 401);
    const body = await request.json<any>().catch(() => null); if (!body?.requestId) return reply({ code:'INVALID_REQUEST', error:'requestId is required.' }, 400);
    const active = await env.DB.prepare(`SELECT * FROM duty_sessions WHERE fmo_id=? AND status='ACTIVE' LIMIT 1`).bind(user.id).first<any>();
    if (active) return reply({ session:active, trackingAuthorized:true });
    const now = new Date(); const id = crypto.randomUUID(); const end = new Date(now.getTime() + settings.dutyDurationMinutes * 60000);
    await env.DB.prepare('INSERT INTO duty_sessions(id,fmo_id,start_time,expected_end_time,status) VALUES(?,?,?,?,?)').bind(id,user.id,now.toISOString(),end.toISOString(),'ACTIVE').run();
    const point = body.location; if (point?.clientPointId) await env.DB.prepare('INSERT OR IGNORE INTO location_logs(id,duty_session_id,fmo_id,latitude,longitude,accuracy,speed,battery_level,recorded_at,client_point_id) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,user.id,point.latitude,point.longitude,point.accuracy,point.speed ?? null,point.batteryLevel ?? null,point.recordedAt ?? now.toISOString(),point.clientPointId).run();
    return reply({ session:{ id, fmo_id:user.id, start_time:now.toISOString(), expected_end_time:end.toISOString(), status:'ACTIVE' }, trackingAuthorized:true });
  }
  if (url.pathname === '/api/duty/location' && request.method === 'POST') {
    const user = await authUser(request, env); if (!user || user.role !== 'FMO') return reply({ code:'UNAUTHORIZED', error:'FMO session required.' }, 401);
    const body = await request.json<any>().catch(() => null); const session = await env.DB.prepare(`SELECT id FROM duty_sessions WHERE id=? AND fmo_id=? AND status='ACTIVE'`).bind(body?.dutySessionId,user.id).first<any>(); if (!session) return reply({ code:'DUTY_NOT_ACTIVE', error:'Active duty session not found.' }, 409);
    const acknowledgments = []; for (const [index, point] of (body?.points ?? []).entries()) { try { await env.DB.prepare('INSERT INTO location_logs(id,duty_session_id,fmo_id,latitude,longitude,accuracy,speed,battery_level,recorded_at,client_point_id) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),session.id,user.id,point.latitude,point.longitude,point.accuracy,point.speed ?? null,point.batteryLevel ?? null,point.recordedAt ?? new Date().toISOString(),point.clientPointId).run(); acknowledgments.push({index,clientPointId:point.clientPointId,status:'accepted'}); } catch { acknowledgments.push({index,clientPointId:point.clientPointId,status:'duplicate'}); } }
    return reply({ acknowledgments, trackingIntervalSeconds:settings.trackingIntervalSeconds });
  }
  if (url.pathname === '/api/duty/end' && request.method === 'POST') {
    const user = await authUser(request, env); if (!user || user.role !== 'FMO') return reply({ code:'UNAUTHORIZED', error:'FMO session required.' }, 401);
    const body = await request.json<any>().catch(() => null); const session = await env.DB.prepare(`SELECT * FROM duty_sessions WHERE id=? AND fmo_id=? AND status='ACTIVE'`).bind(body?.dutySessionId,user.id).first<any>(); if (!session) return reply({ code:'DUTY_NOT_ACTIVE', error:'Active duty session not found.' }, 409);
    const end = new Date().toISOString(); await env.DB.prepare(`UPDATE duty_sessions SET actual_end_time=?,status='COMPLETED' WHERE id=?`).bind(end,session.id).run(); return reply({ session:{...session,actual_end_time:end,status:'COMPLETED'}, trackingAuthorized:false });
  }
  const settings = { organizationName: 'Field Monitoring Organization', timezone: 'Asia/Karachi', dutyDurationMinutes: 480, trackingIntervalSeconds: 30, staleAfterSeconds: 120, offlineAfterSeconds: 600, gpsAccuracyThresholdMeters: 100, automaticDutyEnd: true };
  const admin = await authUser(request, env);
  if ((url.pathname === '/api/tracking/snapshot' || url.pathname === '/api/dashboard/summary') && (!admin || admin.role !== 'ADMIN')) return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
  if (url.pathname === '/api/tracking/snapshot') {
    try {
    const rows = await env.DB.prepare(`SELECT u.id,u.employee_code,u.name,u.is_active,ds.id AS session_id,ds.start_time,ds.expected_end_time,ds.actual_end_time,ds.status AS session_status FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id AND ds.status='ACTIVE' WHERE u.role='FMO' AND u.is_active=1 ORDER BY u.name`).all<any>();
    const items = rows.results.map((r: any) => ({ fmo: { id:r.id, employeeCode:r.employee_code, name:r.name, isActive:!!r.is_active, isDemo:false, phone:null, email:null, createdAt:null }, session: r.session_id ? { id:r.session_id, fmoId:r.id, startTime:r.start_time, expectedEndTime:r.expected_end_time, actualEndTime:r.actual_end_time, reportedStopTime:null, status:r.session_status, serverDurationSeconds:null, reportedDurationSeconds:null, endLocationFailure:null, isDemo:false } : null, attendance:null, lastLocation:null, lastSeen:null, status:{ duty:r.session_id ? 'ON_DUTY' : 'OFF_DUTY', tracking:'OFFLINE' } }));
    return reply({ items, settings, serverTime: new Date().toISOString(), hasMore:false, nextAfterId:null });
    } catch { return reply({ items: [], settings, serverTime: new Date().toISOString(), hasMore:false, nextAfterId:null }); }
  }
  if (url.pathname === '/api/dashboard/summary') {
    try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN ds.id IS NOT NULL THEN 1 ELSE 0 END) AS onDuty FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id AND ds.status='ACTIVE' WHERE u.role='FMO' AND u.is_active=1`).first<any>();
    return reply({ totalFmos:Number(row?.total ?? 0), onDuty:Number(row?.onDuty ?? 0), checkedIn:0, currentlyTracking:0, offline:Number(row?.onDuty ?? 0), stale:0, completedDuty:0, timezone:settings.timezone, serverTime:new Date().toISOString() });
    } catch { return reply({ totalFmos:0, onDuty:0, checkedIn:0, currentlyTracking:0, offline:0, stale:0, completedDuty:0, timezone:settings.timezone, serverTime:new Date().toISOString() }); }
  }
  if (url.pathname === '/api/fmos' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT id,employee_code,name,is_active,created_at FROM users WHERE role='FMO' ORDER BY name`).all<any>();
    const items = rows.results.map((r:any) => ({ id:r.id, employeeCode:r.employee_code, name:r.name, isActive:!!r.is_active, isDemo:false, phone:null, email:null, createdAt:r.created_at }));
    return reply({ items, hasMore:false });
  }
  if (url.pathname === '/api/attendance' && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const rows = await env.DB.prepare(`SELECT a.id,a.duty_session_id,a.fmo_id,a.check_in_time,a.accuracy,a.latitude,a.longitude,u.name,u.employee_code,ds.start_time,ds.actual_end_time FROM attendance a JOIN users u ON u.id=a.fmo_id JOIN duty_sessions ds ON ds.id=a.duty_session_id ORDER BY a.check_in_time DESC LIMIT 100`).all<any>();
    return reply({ items: rows.results.map((r:any)=>({ id:r.id, dutySessionId:r.duty_session_id, fmoId:r.fmo_id, checkInTime:r.check_in_time, accuracy:r.accuracy, latitude:r.latitude, longitude:r.longitude, verificationStatus:'NOT_VERIFIED', isDemo:false, supersededAt:null, resetReason:null, name:r.name, employeeCode:r.employee_code, dutyStart:r.start_time, dutyEnd:r.actual_end_time, trackingStatus:'UNKNOWN', serverDurationSeconds:null })), hasMore:false });
  }
  if (url.pathname === '/api/reports/daily' && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const rows = await env.DB.prepare(`SELECT u.id fmo_id,u.employee_code,u.name,ds.id duty_session_id,ds.start_time,ds.actual_end_time,a.check_in_time FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id LEFT JOIN attendance a ON a.duty_session_id=ds.id WHERE u.role='FMO' AND u.is_active=1 ORDER BY u.name`).all<any>();
    return reply({ items: rows.results.map((r:any)=>({ fmoId:r.fmo_id, employeeCode:r.employee_code, name:r.name, isDemo:false, dutySessionId:r.duty_session_id, startTime:r.start_time, checkInTime:r.check_in_time, actualEndTime:r.actual_end_time, reportedStopTime:null, serverDurationSeconds:null, reportedDurationSeconds:null, lastSeen:null, accuracy:null, status:{duty:r.duty_session_id?'ON_DUTY':'NOT_STARTED',tracking:'OFFLINE'} })), hasMore:false, date:url.searchParams.get('date'), timezone:settings.timezone, serverTime:new Date().toISOString() });
  }
  if (url.pathname === '/api/settings') return reply({ settings: { organizationName: 'Field Monitoring Organization', timezone: 'Asia/Karachi', dutyDurationMinutes: 480, trackingIntervalSeconds: 30, staleAfterSeconds: 120, offlineAfterSeconds: 600, gpsAccuracyThresholdMeters: 100, automaticDutyEnd: true } });
  return reply({ code: 'NOT_IMPLEMENTED', error: 'Worker API migration is in progress.' }, 501);
} };
