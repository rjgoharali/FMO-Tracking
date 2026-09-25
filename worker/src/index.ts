export interface Env { DB: D1Database; CORS_ORIGINS: string; }
const json = (body: unknown, status = 200, origin = 'https://dashboard.rajagohar.live') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' } });
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
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' } });
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
  if (url.pathname === '/api/duty/check-in/challenge' && request.method === 'POST') {
    const user = await authUser(request, env); if (!user || user.role !== 'FMO') return reply({ code:'UNAUTHORIZED', error:'FMO session required.' }, 401);
    const body = await request.json<any>().catch(() => null); const session = await env.DB.prepare(`SELECT id FROM duty_sessions WHERE id=? AND fmo_id=? AND status='ACTIVE'`).bind(body?.dutySessionId,user.id).first<any>();
    if (!session) return reply({ code:'DUTY_NOT_ACTIVE', error:'Active duty session not found.' }, 409);
    return reply({ challengeToken: token(), expiresAt: new Date(Date.now()+5*60*1000).toISOString() });
  }
  if (url.pathname === '/api/duty/check-in' && request.method === 'POST') {
    const user = await authUser(request, env); if (!user || user.role !== 'FMO') return reply({ code:'UNAUTHORIZED', error:'FMO session required.' }, 401);
    const contentType = request.headers.get('content-type') ?? ''; let metadata:any = null;
    if (contentType.includes('application/json')) metadata = await request.json<any>().catch(() => null);
    else { const form = await request.formData().catch(() => null); try { metadata = JSON.parse(String(form?.get('metadata') ?? '')); } catch { return reply({ code:'INVALID_REQUEST', error:'Check-in metadata is required.' }, 400); } }
    const session = await env.DB.prepare(`SELECT id FROM duty_sessions WHERE id=? AND fmo_id=? AND status='ACTIVE'`).bind(metadata?.dutySessionId,user.id).first<any>();
    if (!session || !metadata?.challengeToken || !metadata?.location) return reply({ code:'CHECK_IN_NOT_ALLOWED', error:'Valid active duty and live challenge are required.' }, 409);
    const existing = await env.DB.prepare('SELECT * FROM attendance WHERE duty_session_id=?').bind(session.id).first<any>(); if (existing && !existing.superseded_at) return reply({ attendance:{ id:existing.id, dutySessionId:existing.duty_session_id, fmoId:existing.fmo_id, checkInTime:existing.check_in_time, latitude:existing.latitude, longitude:existing.longitude, accuracy:existing.accuracy } });
    const point = metadata.location; const id = existing?.id ?? crypto.randomUUID(); const checkInTime = new Date().toISOString();
    if (existing) await env.DB.prepare('UPDATE attendance SET check_in_time=?,selfie_path=NULL,latitude=?,longitude=?,accuracy=?,superseded_at=NULL WHERE id=?').bind(checkInTime,point.latitude,point.longitude,point.accuracy,id).run();
    else await env.DB.prepare('INSERT INTO attendance(id,duty_session_id,fmo_id,check_in_time,selfie_path,latitude,longitude,accuracy) VALUES(?,?,?,?,?,?,?,?)').bind(id,session.id,user.id,checkInTime,null,point.latitude,point.longitude,point.accuracy).run();
    return reply({ attendance:{ id, dutySessionId:session.id, fmoId:user.id, checkInTime, latitude:point.latitude, longitude:point.longitude, accuracy:point.accuracy } });
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
    const rows = await env.DB.prepare(`SELECT u.id,u.employee_code,u.name,u.is_active,u.phone,u.email,u.created_at,ds.id AS session_id,ds.start_time,ds.expected_end_time,ds.actual_end_time,ds.status AS session_status,ll.latitude,ll.longitude,ll.accuracy,ll.speed,ll.recorded_at FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id AND ds.status='ACTIVE' LEFT JOIN location_logs ll ON ll.id=(SELECT id FROM location_logs WHERE fmo_id=u.id ORDER BY recorded_at DESC LIMIT 1) WHERE u.role='FMO' AND u.is_active=1 ORDER BY u.name`).all<any>();
    const items = rows.results.map((r: any) => ({ fmo: { id:r.id, employeeCode:r.employee_code, name:r.name, isActive:!!r.is_active, isDemo:false, phone:r.phone ?? null, email:r.email ?? null, createdAt:r.created_at }, session: r.session_id ? { id:r.session_id, fmoId:r.id, startTime:r.start_time, expectedEndTime:r.expected_end_time, actualEndTime:r.actual_end_time, reportedStopTime:null, status:r.session_status, serverDurationSeconds:null, reportedDurationSeconds:null, endLocationFailure:null, isDemo:false } : null, attendance:null, lastLocation:r.recorded_at ? { latitude:r.latitude, longitude:r.longitude, accuracy:r.accuracy, speed:r.speed, recordedAt:r.recorded_at, quality:r.accuracy <= 100 ? 'GOOD' : 'LOW' } : null, lastSeen:r.recorded_at ?? null, status:{ duty:r.session_id ? 'ON_DUTY' : 'OFF_DUTY', tracking:r.recorded_at && (Date.now()-Date.parse(r.recorded_at))/1000 <= settings.staleAfterSeconds ? 'LIVE' : 'OFFLINE' } }));
    return reply({ items, settings, serverTime: new Date().toISOString(), hasMore:false, nextAfterId:null });
    } catch { return reply({ items: [], settings, serverTime: new Date().toISOString(), hasMore:false, nextAfterId:null }); }
  }
  if (url.pathname === '/api/dashboard/summary') {
    try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN ds.id IS NOT NULL THEN 1 ELSE 0 END) AS onDuty, SUM(CASE WHEN a.id IS NOT NULL AND a.superseded_at IS NULL THEN 1 ELSE 0 END) AS checkedIn, SUM(CASE WHEN ds.id IS NOT NULL AND ll.recorded_at IS NOT NULL AND (julianday('now')-julianday(ll.recorded_at))*86400 <= 120 THEN 1 ELSE 0 END) AS tracking, SUM(CASE WHEN ds.id IS NULL OR ll.recorded_at IS NULL OR (julianday('now')-julianday(ll.recorded_at))*86400 > 120 THEN 1 ELSE 0 END) AS offline FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id AND ds.status='ACTIVE' LEFT JOIN attendance a ON a.duty_session_id=ds.id LEFT JOIN location_logs ll ON ll.id=(SELECT id FROM location_logs WHERE fmo_id=u.id ORDER BY recorded_at DESC LIMIT 1) WHERE u.role='FMO' AND u.is_active=1`).first<any>();
    const completed = await env.DB.prepare(`SELECT COUNT(*) AS count FROM duty_sessions WHERE status='COMPLETED' AND date(actual_end_time)=date('now')`).first<any>();
    return reply({ totalFmos:Number(row?.total ?? 0), onDuty:Number(row?.onDuty ?? 0), checkedIn:Number(row?.checkedIn ?? 0), currentlyTracking:Number(row?.tracking ?? 0), offline:Number(row?.offline ?? 0), stale:0, completedDuty:Number(completed?.count ?? 0), timezone:settings.timezone, serverTime:new Date().toISOString() });
    } catch { return reply({ totalFmos:0, onDuty:0, checkedIn:0, currentlyTracking:0, offline:0, stale:0, completedDuty:0, timezone:settings.timezone, serverTime:new Date().toISOString() }); }
  }
  if (url.pathname === '/api/fmos' && request.method === 'POST') {
    const admin = await authUser(request, env); if (!admin || admin.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const body = await request.json<any>().catch(() => null); if (!body?.employeeCode || !body?.name || !body?.password) return reply({ code:'INVALID_REQUEST', error:'Employee ID, name and password are required.' }, 400);
    const exists = await env.DB.prepare('SELECT id FROM users WHERE lower(employee_code)=lower(?)').bind(body.employeeCode.trim()).first(); if (exists) return reply({ code:'DUPLICATE_EMPLOYEE_CODE', error:'Employee / FMO ID already exists.' }, 409);
    const salt = crypto.randomUUID().replaceAll('-',''); const passwordHash = `pbkdf2$100000$${salt}$${await hash(body.password, salt, 100000)}`; const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users(id,employee_code,name,role,password_hash,is_active,phone,email,created_at) VALUES(?,?,?,?,?,?,?,?,datetime(\'now\'))').bind(id,body.employeeCode.trim().toUpperCase(),body.name.trim(),'FMO',passwordHash,1,body.phone ?? null,body.email ?? null).run();
    return reply({ id, employeeCode:body.employeeCode.trim().toUpperCase(), name:body.name.trim(), isActive:true, isDemo:false, phone:body.phone ?? null, email:body.email ?? null });
  }
  const fmoMatch = url.pathname.match(/^\/api\/fmos\/([^/]+)$/);
  const sessionsMatch = url.pathname.match(/^\/api\/fmos\/([^/]+)\/sessions$/);
  if (sessionsMatch && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const rows = await env.DB.prepare(`SELECT id,fmo_id,start_time,expected_end_time,actual_end_time,status FROM duty_sessions WHERE fmo_id=? ORDER BY start_time DESC LIMIT 100`).bind(sessionsMatch[1]).all<any>();
    return reply({ items:rows.results.map((r:any)=>({ id:r.id,fmoId:r.fmo_id,startTime:r.start_time,expectedEndTime:r.expected_end_time,actualEndTime:r.actual_end_time,reportedStopTime:null,status:r.status,serverDurationSeconds:null,reportedDurationSeconds:null,endLocationFailure:null,isDemo:false })), hasMore:false });
  }
  const routeMatch = url.pathname.match(/^\/api\/fmos\/([^/]+)\/route$/);
  if (routeMatch && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const sessionId = url.searchParams.get('dutySessionId'); if (!sessionId) return reply({ code:'INVALID_REQUEST', error:'dutySessionId is required.' }, 400);
    const rows = await env.DB.prepare(`SELECT id,latitude,longitude,accuracy,speed,battery_level,recorded_at FROM location_logs WHERE fmo_id=? AND duty_session_id=? ORDER BY recorded_at ASC LIMIT 5000`).bind(routeMatch[1],sessionId).all<any>();
    return reply({ points:rows.results.map((r:any)=>({ id:r.id,latitude:r.latitude,longitude:r.longitude,accuracy:r.accuracy,speed:r.speed,batteryLevel:r.battery_level,recordedAt:r.recorded_at,quality:r.accuracy <= 100 ? 'GOOD' : 'POOR',mocked:false })), hasMore:false, nextAfterId:'0' });
  }
  if (fmoMatch && request.method === 'PATCH') {
    const admin = await authUser(request, env); if (!admin || admin.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const body = await request.json<any>().catch(() => null); const current = await env.DB.prepare('SELECT id FROM users WHERE id=? AND role=\'FMO\'').bind(fmoMatch[1]).first(); if (!current) return reply({ code:'NOT_FOUND', error:'FMO not found.' }, 404);
    if (body?.employeeCode) { const duplicate = await env.DB.prepare('SELECT id FROM users WHERE lower(employee_code)=lower(?) AND id<>?').bind(body.employeeCode.trim(), fmoMatch[1]).first(); if (duplicate) return reply({ code:'DUPLICATE_EMPLOYEE_CODE', error:'Employee / FMO ID already exists.' }, 409); }
    if (body?.password) { const salt=crypto.randomUUID().replaceAll('-',''); await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(`pbkdf2$100000$${salt}$${await hash(body.password,salt,100000)}`,fmoMatch[1]).run(); }
    await env.DB.prepare('UPDATE users SET employee_code=COALESCE(?,employee_code),name=COALESCE(?,name),is_active=COALESCE(?,is_active),phone=COALESCE(?,phone),email=COALESCE(?,email) WHERE id=?').bind(body?.employeeCode ? body.employeeCode.trim().toUpperCase() : null, body?.name ?? null, body?.isActive === undefined ? null : (body.isActive ? 1 : 0), body?.phone ?? null, body?.email ?? null, fmoMatch[1]).run();
    return reply({ ok:true });
  }
  if (fmoMatch && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const row = await env.DB.prepare(`SELECT u.id,u.employee_code,u.name,u.is_active,u.phone,u.email,u.created_at,ds.id session_id,ds.start_time,ds.expected_end_time,ds.actual_end_time,ds.status session_status FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id AND ds.status='ACTIVE' WHERE u.id=? AND u.role='FMO'`).bind(fmoMatch[1]).first<any>();
    if (!row) return reply({ code:'NOT_FOUND', error:'FMO not found.' }, 404);
    const location = row.session_id ? await env.DB.prepare('SELECT latitude,longitude,accuracy,speed,recorded_at FROM location_logs WHERE fmo_id=? ORDER BY recorded_at DESC LIMIT 1').bind(row.id).first<any>() : null;
    return reply({ fmo:{ id:row.id, employeeCode:row.employee_code, name:row.name, isActive:!!row.is_active, isDemo:false, phone:row.phone ?? null, email:row.email ?? null, createdAt:row.created_at }, session:row.session_id ? { id:row.session_id, fmoId:row.id, startTime:row.start_time, expectedEndTime:row.expected_end_time, actualEndTime:row.actual_end_time, status:row.session_status, isDemo:false } : null, attendance:null, lastLocation:location ? { latitude:location.latitude, longitude:location.longitude, accuracy:location.accuracy, speed:location.speed, recordedAt:location.recorded_at, quality:location.accuracy <= 100 ? 'GOOD' : 'LOW' } : null, lastSeen:location?.recorded_at ?? null, status:{ duty:row.session_id ? 'ON_DUTY' : 'OFF_DUTY', tracking:location && (Date.now()-Date.parse(location.recorded_at))/1000 <= settings.staleAfterSeconds ? 'LIVE' : 'OFFLINE' } });
  }
  if (url.pathname === '/api/fmos' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT id,employee_code,name,is_active,phone,email,created_at FROM users WHERE role='FMO' ORDER BY name`).all<any>();
    const items = rows.results.map((r:any) => ({ id:r.id, employeeCode:r.employee_code, name:r.name, isActive:!!r.is_active, isDemo:false, phone:r.phone ?? null, email:r.email ?? null, createdAt:r.created_at }));
    return reply({ items, hasMore:false });
  }
  if (url.pathname === '/api/attendance' && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const date = url.searchParams.get('date'); const fmoId = url.searchParams.get('fmoId');
    const rows = await env.DB.prepare(`SELECT a.id,a.duty_session_id,a.fmo_id,a.check_in_time,a.accuracy,a.latitude,a.longitude,a.superseded_at,a.reset_reason,u.name,u.employee_code,ds.start_time,ds.actual_end_time FROM attendance a JOIN users u ON u.id=a.fmo_id JOIN duty_sessions ds ON ds.id=a.duty_session_id WHERE (? IS NULL OR date(a.check_in_time)=?) AND (? IS NULL OR a.fmo_id=?) ORDER BY a.check_in_time DESC LIMIT 100`).bind(date,date,fmoId,fmoId).all<any>();
    return reply({ items: rows.results.map((r:any)=>({ id:r.id, dutySessionId:r.duty_session_id, fmoId:r.fmo_id, checkInTime:r.check_in_time, accuracy:r.accuracy, latitude:r.latitude, longitude:r.longitude, verificationStatus:'NOT_VERIFIED', isDemo:false, supersededAt:r.superseded_at ?? null, resetReason:r.reset_reason ?? null, name:r.name, employeeCode:r.employee_code, dutyStart:r.start_time, dutyEnd:r.actual_end_time, trackingStatus:'UNKNOWN', serverDurationSeconds:null })), hasMore:false });
  }
  const attendanceMatch = url.pathname.match(/^\/api\/attendance\/([^/]+)$/);
  const selfieMatch = url.pathname.match(/^\/api\/attendance\/([^/]+)\/selfie$/);
  if (selfieMatch && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    return reply({ code:'NOT_FOUND', error:'Selfie evidence has been disabled.' }, 404);
  }
  if (attendanceMatch && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const row = await env.DB.prepare(`SELECT a.*,u.name,u.employee_code,ds.start_time,ds.expected_end_time,ds.actual_end_time,ds.status FROM attendance a JOIN users u ON u.id=a.fmo_id JOIN duty_sessions ds ON ds.id=a.duty_session_id WHERE a.id=?`).bind(attendanceMatch[1]).first<any>();
    if (!row) return reply({ code:'NOT_FOUND', error:'Attendance record not found.' }, 404);
    return reply({ attendance:{ id:row.id,dutySessionId:row.duty_session_id,fmoId:row.fmo_id,checkInTime:row.check_in_time,latitude:row.latitude,longitude:row.longitude,accuracy:row.accuracy,supersededAt:row.superseded_at ?? null,resetReason:row.reset_reason ?? null,name:row.name,employeeCode:row.employee_code,isDemo:false,verificationStatus:'NOT_VERIFIED' }, session:{ id:row.duty_session_id,startTime:row.start_time,expectedEndTime:row.expected_end_time,actualEndTime:row.actual_end_time,status:row.status,reportedStopTime:null,serverDurationSeconds:null,reportedDurationSeconds:null,endLocationFailure:null } });
  }
  const resetMatch = url.pathname.match(/^\/api\/attendance\/([^/]+)\/reset$/);
  if (resetMatch && request.method === 'POST') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const body = await request.json<any>().catch(() => null); if (!body?.reason || String(body.reason).trim().length < 5) return reply({ code:'INVALID_REQUEST', error:'A reset reason is required.' }, 400);
    const row = await env.DB.prepare('SELECT id FROM attendance WHERE id=? AND superseded_at IS NULL').bind(resetMatch[1]).first(); if (!row) return reply({ code:'NOT_FOUND', error:'Active attendance record not found.' }, 404);
    await env.DB.prepare("UPDATE attendance SET superseded_at=datetime('now'),reset_reason=? WHERE id=?").bind(String(body.reason).trim(),resetMatch[1]).run();
    return reply({ ok:true });
  }
  if (url.pathname === '/api/reports/daily' && request.method === 'GET') {
    const user = await authUser(request, env); if (!user || user.role === 'FMO') return reply({ code:'UNAUTHORIZED', error:'Admin session required.' }, 401);
    const date = url.searchParams.get('date');
    const rows = await env.DB.prepare(`SELECT u.id fmo_id,u.employee_code,u.name,ds.id duty_session_id,ds.start_time,ds.actual_end_time,a.check_in_time FROM users u LEFT JOIN duty_sessions ds ON ds.fmo_id=u.id AND (? IS NULL OR date(ds.start_time)=?) LEFT JOIN attendance a ON a.duty_session_id=ds.id AND a.superseded_at IS NULL WHERE u.role='FMO' AND u.is_active=1 ORDER BY u.name`).bind(date,date).all<any>();
    return reply({ items: rows.results.map((r:any)=>({ fmoId:r.fmo_id, employeeCode:r.employee_code, name:r.name, isDemo:false, dutySessionId:r.duty_session_id, startTime:r.start_time, checkInTime:r.check_in_time, actualEndTime:r.actual_end_time, reportedStopTime:null, serverDurationSeconds:null, reportedDurationSeconds:null, lastSeen:null, accuracy:null, status:{duty:r.duty_session_id?'ON_DUTY':'NOT_STARTED',tracking:'OFFLINE'} })), hasMore:false, date:url.searchParams.get('date'), timezone:settings.timezone, serverTime:new Date().toISOString() });
  }
  if (url.pathname === '/api/settings') return reply({ settings: { organizationName: 'Field Monitoring Organization', timezone: 'Asia/Karachi', dutyDurationMinutes: 480, trackingIntervalSeconds: 30, staleAfterSeconds: 120, offlineAfterSeconds: 600, gpsAccuracyThresholdMeters: 100, automaticDutyEnd: true } });
  return reply({ code: 'NOT_IMPLEMENTED', error: 'Worker API migration is in progress.' }, 501);
} };
